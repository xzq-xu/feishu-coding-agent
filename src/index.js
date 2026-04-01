import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { config } from './config.js';
import { runAgentTurn } from './agent-runner.js';
import { acquireSingleInstanceLock } from './process-lock.js';
import { SessionStore } from './session-store.js';
import { captureWorkspaceSnapshot, summarizeWorkspaceChanges } from './workspace-diff.js';

const store = new SessionStore(config.dataDir);
const activeJobs = new Map();
const activeProcesses = new Map();
const stopRequests = new Set();
const runtimeLogPath = path.join(config.dataDir, 'runtime.log');
const RECENT_SESSION_LIMIT = 5;
const REFERENCED_MESSAGE_KEYS = ['quote_message_id', 'upper_message_id', 'reply_message_id', 'source_message_id'];
const MESSAGE_BATCH_WINDOW_MS = 1500;
const botIdentity = {
  names: new Set(),
  openIds: new Set()
};
let cleanupPromise = Promise.resolve();
let processLockHandle = null;
let shutdownStarted = false;
const pendingMessageBatches = new Map();

function getJobKey(chatKey, sessionKey) {
  return `${chatKey}::${sessionKey}`;
}

async function logRuntime(message, details = null) {
  const line = [
    `[${new Date().toISOString()}] ${message}`,
    details ? JSON.stringify(details, null, 2) : ''
  ].filter(Boolean).join('\n');
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.appendFile(runtimeLogPath, `${line}\n\n`, 'utf8');
  } catch (error) {
    console.error('[runtime-log-failed]', error);
  }
}

function getStatusLabel(status) {
  switch (status) {
    case 'running':
      return '运行中';
    case 'success':
      return '已完成';
    case 'error':
      return '失败';
    case 'idle':
    default:
      return '空闲';
  }
}

function getStatusBadge(status) {
  switch (status) {
    case 'running':
      return '[运行中]';
    case 'success':
      return '[已完成]';
    case 'error':
      return '[失败]';
    case 'idle':
    default:
      return '[空闲]';
  }
}

function getStageLabel(stage) {
  switch (stage) {
    case 'preparing':
      return '准备启动';
    case 'agent_running':
      return 'Agent 执行中';
    case 'analyzing_changes':
      return '分析改动';
    case 'sending_result':
      return '整理结果';
    default:
      return '';
  }
}

function getProviderLabel(provider) {
  switch ((provider || '').toLowerCase()) {
    case 'claude':
      return 'Claude Code';
    case 'cursor':
      return 'Cursor Agent';
    case 'opencode':
      return 'OpenCode';
    case 'codex':
    default:
      return 'Codex';
  }
}

function hasRunningJob(chatKey) {
  const prefix = `${chatKey}::`;
  return Array.from(activeJobs.keys()).some((key) => key.startsWith(prefix));
}

function isSessionActivelyRunning(chatKey, alias) {
  const session = store.getSession(chatKey, alias);
  const sessionKey = session?.id || alias;
  const jobKey = getJobKey(chatKey, sessionKey);
  return activeJobs.has(jobKey) || activeProcesses.has(jobKey);
}

function getEffectiveSessionStatus(chatKey, session) {
  if (!session) {
    return 'idle';
  }
  if (session.status === 'running' && !isSessionActivelyRunning(chatKey, session.alias)) {
    return 'idle';
  }
  return session.status || 'idle';
}

function trimPreview(text, max = 80) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '暂无摘要';
  }
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function formatRunningStatus(session) {
  const stage = getStageLabel(session?.currentStage);
  return stage ? `运行中·${stage}` : '运行中';
}

function formatElapsedDuration(startedAt) {
  if (!startedAt) {
    return '';
  }
  const diffMs = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const totalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds} 秒`;
  }
  return `${minutes} 分 ${seconds} 秒`;
}

function sanitizeFilename(name) {
  return (name || 'attachment').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'attachment';
}

function parseSessionAlias(text) {
  const match = text.trim().match(/^S(\d+)$/i);
  return match ? `S${match[1]}` : null;
}

function parseSessionPrefixedPrompt(text) {
  const match = text.trim().match(/^(S\d+)\s*[:：]\s*([\s\S]+)$/i);
  if (!match) {
    return null;
  }

  return {
    alias: match[1].toUpperCase(),
    prompt: match[2].trim()
  };
}

function isAgentProviderToken(token) {
  return ['codex', 'claude', 'cursor', 'opencode'].includes((token || '').toLowerCase());
}

function tokenizeCommandArgs(input) {
  const matches = input.match(/"([^"]+)"|'([^']+)'|[^\s]+/g) || [];
  return matches.map((token) => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function formatRecentSessions(chatKey) {
  const record = store.get(chatKey);
  const sessions = store.listSessions(chatKey).slice(0, RECENT_SESSION_LIMIT);
  if (!sessions.length) {
    return '最近会话: 暂无';
  }

  const lines = ['最近会话:'];
  for (const session of sessions) {
    const effectiveStatus = getEffectiveSessionStatus(chatKey, session);
    const activeMark = record.activeAlias === session.alias ? ' *' : '';
    const preview = trimPreview(
      effectiveStatus === 'running'
        ? session.currentActivityPreview || session.currentTaskPreview || session.lastUserMessage || session.title
        : session.lastResultPreview || session.lastAssistantMessage || session.lastUserMessage || session.title,
      60
    );
    const statusText = effectiveStatus === 'running'
      ? `[${formatRunningStatus(session)}]`
      : getStatusBadge(effectiveStatus);
    lines.push(`${session.alias}${activeMark} ${statusText} [${getProviderLabel(session.provider)}] ${preview}`);
    lines.push(`工作目录: ${session.workspace || config.defaultWorkspace}`);
  }
  return lines.join('\n');
}

function getChatTypeLabel(chatKey) {
  return chatKey.startsWith('oc_') ? '群聊' : '私聊';
}

function getChatDisplayName(chatKey) {
  const meta = store.getChatMeta(chatKey);
  if (meta.chatName) {
    return meta.chatName;
  }
  return `${getChatTypeLabel(chatKey)} ${chatKey.slice(-6)}`;
}

function formatGlobalRecentSessions() {
  const chats = store.listAllChats().filter((chat) => chat.sessions.length > 0);
  const allSessions = chats
    .flatMap(({ chatKey, activeAlias, sessions }) => sessions.map((session) => ({
      chatKey,
      activeAlias,
      session
    })))
    .sort((a, b) => new Date(b.session.updatedAt) - new Date(a.session.updatedAt));

  const seen = new Set();
  const uniqueSessions = allSessions.filter(({ session }) => {
    if (seen.has(session.id)) {
      return false;
    }
    seen.add(session.id);
    return true;
  }).slice(0, RECENT_SESSION_LIMIT * 3);

  if (!uniqueSessions.length) {
    return '最近会话: 暂无';
  }

  const lines = ['最近会话:'];
  for (const { chatKey, activeAlias, session } of uniqueSessions) {
    const effectiveStatus = getEffectiveSessionStatus(chatKey, session);
    const activeMark = activeAlias === session.alias ? ' *' : '';
    const preview = trimPreview(
      effectiveStatus === 'running'
        ? session.currentActivityPreview || session.currentTaskPreview || session.lastUserMessage || session.title
        : session.lastResultPreview || session.lastAssistantMessage || session.lastUserMessage || session.title,
      54
    );
    const statusText = effectiveStatus === 'running'
      ? `[${formatRunningStatus(session)}]`
      : getStatusBadge(effectiveStatus);
    lines.push(`${session.alias}${activeMark} ${statusText} [${getProviderLabel(session.provider)}] [${getChatDisplayName(chatKey)}] ${preview}`);
    lines.push(`工作目录: ${session.workspace || config.defaultWorkspace}`);
    lines.push(`转移 ID: ${session.id}`);
  }

  return lines.join('\n');
}

function getChatSourceLabel(event) {
  return isGroupChat(event) ? '群聊' : '私聊';
}

function buildResultCard({ chatKey, alias, output, sessionId, workspace, status = 'idle', provider = 'codex', branchChange = null, commitChange = null, title = 'Agent 结果', sourceLabel = '' }) {
  const record = store.get(chatKey);
  const currentSession = store.getSession(chatKey, alias);
  const sessionCount = store.listSessions(chatKey).length;
  const elements = [
    {
      tag: 'markdown',
      content: output || 'Codex 没有返回正文。'
    },
    {
      tag: 'hr'
    },
    {
      tag: 'markdown',
      content: [
        `**会话**: ${alias}`,
        `**Agent**: ${getProviderLabel(provider)}`,
        sourceLabel ? `**来源**: ${sourceLabel}` : null,
        `**状态**: ${getStatusLabel(status)}`,
        currentSession?.id ? `**转移 ID**: \`${currentSession.id}\`` : null,
        branchChange ? `**分支变化**: ${branchChange.before} -> ${branchChange.after}` : null,
        commitChange ? `**提交变化**: ${commitChange.before.slice(0, 7)} -> ${commitChange.after.slice(0, 7)}` : null,
        `**会话 ID**: ${sessionId || '未知'}`,
        `**工作目录**: \`${workspace || config.defaultWorkspace}\``
      ].filter(Boolean).join('\n')
    }
  ];

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `**会话总览**\n当前聊天共有 **${sessionCount}** 个会话。\n发送 \`/sessions\` 查看完整列表。`
  });

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: [
      '**快捷命令**',
      '直接回复这条消息或这条线程里的任意消息，也会继续当前会话',
      `继续这个会话: \`${alias}: 你的新指令\``,
      `查看最近消息: \`/show ${alias}\``,
      `修改工作目录: \`/cwd ${alias} /path/to/project\``,
      `删除会话: \`/delete ${alias}\``
    ].join('\n')
  });

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: sourceLabel ? `${title} · ${sourceLabel}` : title
      }
    },
    elements
  };
}

function formatSessionTranscript(chatKey, session, limit = 10) {
  const recentTurns = session.turns.slice(-limit);
  if (!recentTurns.length) {
    return `${session.alias} 暂无消息记录。`;
  }

  const lines = [
    `${session.alias} 最近 ${recentTurns.length} 条消息:`,
    `Agent: ${getProviderLabel(session.provider)}`,
    `转移 ID: ${session.id}`,
    `状态: ${getStatusLabel(getEffectiveSessionStatus(chatKey, session))}`,
    `工作目录: ${session.workspace || config.defaultWorkspace}`
  ];

  for (const turn of recentTurns) {
    const label = turn.role === 'assistant' ? getProviderLabel(session.provider) : '你';
    lines.push('');
    lines.push(`${label}: ${turn.text}`);
  }

  return lines.join('\n');
}

function formatWorkspaceStatus(chatKey, session) {
  return [
    `会话: ${session.alias}`,
    `Agent: ${getProviderLabel(session.provider)}`,
    `转移 ID: ${session.id}`,
    `状态: ${getStatusLabel(getEffectiveSessionStatus(chatKey, session))}`,
    `工作目录: ${session.workspace || config.defaultWorkspace}`,
    session.lastChangedFiles?.length ? `最近改动文件数: ${session.lastChangedFiles.length}` : null
  ].join('\n');
}

function formatDiffDetails(chatKey, session) {
  if (!session) {
    return '没有找到对应会话。';
  }

  const lines = [
    `会话: ${session.alias}`,
    `Agent: ${getProviderLabel(session.provider)}`,
    `转移 ID: ${session.id}`,
    `状态: ${getStatusLabel(getEffectiveSessionStatus(chatKey, session))}`,
    `工作目录: ${session.workspace || config.defaultWorkspace}`
  ];

  if (session.lastDiffSummary) {
    lines.push('');
    lines.push(session.lastDiffSummary);
  } else {
    lines.push('');
    lines.push('还没有可用的代码改动摘要。');
  }

  if (session.lastDiffPatch) {
    lines.push('');
    lines.push('最近 patch 摘要:');
    lines.push(session.lastDiffPatch.slice(0, 6000));
  }

  if (session.lastBranchChange) {
    lines.push('');
    lines.push(`最近分支变化: ${session.lastBranchChange.before} -> ${session.lastBranchChange.after}`);
  }

  if (session.lastCommitChange?.before && session.lastCommitChange?.after) {
    lines.push(`最近提交变化: ${session.lastCommitChange.before.slice(0, 7)} -> ${session.lastCommitChange.after.slice(0, 7)}`);
  }

  return lines.filter(Boolean).join('\n');
}

async function resolveWorkspaceInput(input) {
  const raw = input.trim();
  if (!raw) {
    throw new Error('请提供目录路径。');
  }

  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  const resolved = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(config.defaultWorkspace, expanded);

  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`目录不存在或不可用: ${resolved}`);
  }

  return resolved;
}

async function parseNewCommand(command) {
  const rest = command.replace(/^\/new\b/i, '').trim();
  if (!rest) {
    return { provider: null, workspace: null, prompt: '' };
  }

  const tokens = tokenizeCommandArgs(rest);
  if (!tokens.length) {
    return { provider: null, workspace: null, prompt: '' };
  }

  let provider = null;
  let startIndex = 0;
  if (isAgentProviderToken(tokens[0])) {
    provider = tokens[0].toLowerCase();
    startIndex = 1;
  }

  const remainingTokens = tokens.slice(startIndex);
  if (!remainingTokens.length) {
    return { provider, workspace: null, prompt: '' };
  }

  for (let count = remainingTokens.length; count >= 1; count -= 1) {
    const candidate = remainingTokens.slice(0, count).join(' ');
    try {
      const workspace = await resolveWorkspaceInput(candidate);
      const prompt = remainingTokens.slice(count).join(' ').trim();
      return { provider, workspace, prompt };
    } catch {
      // Keep trying shorter prefixes until one resolves to a real directory.
    }
  }

  return { provider, workspace: null, prompt: remainingTokens.join(' ').trim() };
}

function getTextContent(content) {
  try {
    const parsed = JSON.parse(content || '{}');
    if (typeof parsed.text === 'string') {
      return parsed.text.trim();
    }

    const localeBlock = parsed.zh_cn || parsed.en_us || parsed;
    const lines = Array.isArray(localeBlock?.content) ? localeBlock.content : [];
    const text = lines
      .flat()
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }
        if (typeof item.text === 'string') {
          return item.text;
        }
        if (typeof item.href === 'string') {
          return item.href;
        }
        if (typeof item.un_escape === 'string') {
          return item.un_escape;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();

    return text;
  } catch {
    return '';
  }
}

function parseMessageContent(content) {
  try {
    return JSON.parse(content || '{}');
  } catch {
    return {};
  }
}

function getChatKey(event) {
  return event.message.chat_id;
}

function isGroupChat(event) {
  return event?.message?.chat_type === 'group';
}

function getSenderOpenId(event) {
  return event.sender?.sender_id?.open_id || '';
}

function getMessageBatchThreadKey(event) {
  const message = event?.message;
  return message?.thread_id || message?.root_id || message?.parent_id || 'main';
}

function getMessageBatchKey(event) {
  return [
    getChatKey(event),
    getSenderOpenId(event) || 'unknown',
    getMessageBatchThreadKey(event)
  ].join('::');
}

function getMentions(event) {
  return Array.isArray(event?.message?.mentions) ? event.message.mentions : [];
}

function normalizeMentionName(value) {
  return (value || '').trim().replace(/^@+/, '').toLowerCase();
}

function getMentionCandidates(mention) {
  return [
    mention?.name,
    mention?.key,
    mention?.text,
    mention?.id?.open_id,
    mention?.id?.user_id,
    mention?.id?.union_id,
    mention?.open_id,
    mention?.user_id,
    mention?.union_id
  ].map(normalizeMentionName).filter(Boolean);
}

function getMentionSummaries(event) {
  return getMentions(event).map((mention) => ({
    name: mention?.name || null,
    key: mention?.key || null,
    text: mention?.text || null,
    openId: mention?.id?.open_id || mention?.open_id || null,
    userId: mention?.id?.user_id || mention?.user_id || null,
    unionId: mention?.id?.union_id || mention?.union_id || null
  }));
}

function isBotMentioned(event) {
  const mentions = getMentions(event);
  if (!mentions.length) {
    return false;
  }

  if (botIdentity.openIds.size > 0) {
    return mentions.some((mention) => {
      const openId = normalizeMentionName(
        mention?.id?.open_id || mention?.open_id || ''
      );
      return openId && botIdentity.openIds.has(openId);
    });
  }

  return mentions.some((mention) => getMentionCandidates(mention).some((candidate) => botIdentity.names.has(candidate)));
}

async function fetchBotInfo() {
  const tokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      app_id: config.feishuAppId,
      app_secret: config.feishuAppSecret
    })
  });

  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || tokenPayload?.code !== 0 || !tokenPayload?.tenant_access_token) {
    throw new Error(`tenant_access_token 获取失败: ${tokenPayload?.msg || tokenResponse.status}`);
  }

  const botResponse = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tokenPayload.tenant_access_token}`
    }
  });

  const botPayload = await botResponse.json().catch(() => ({}));
  if (!botResponse.ok || botPayload?.code !== 0 || !botPayload?.bot) {
    throw new Error(`bot info 获取失败: ${botPayload?.msg || botResponse.status}`);
  }

  return botPayload.bot;
}

function getThreadMarkers(event) {
  const message = event?.message;
  return [
    message?.root_id || null,
    message?.parent_id || null,
    message?.thread_id || null
  ].filter(Boolean);
}

function getMessageId(event) {
  return event?.message?.message_id || null;
}

function collectReferencedMessageIds(value, results = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferencedMessageIds(item, results));
    return results;
  }

  if (!value || typeof value !== 'object') {
    return results;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (REFERENCED_MESSAGE_KEYS.includes(key) && typeof nestedValue === 'string' && nestedValue.trim()) {
      results.add(nestedValue.trim());
    }
    collectReferencedMessageIds(nestedValue, results);
  }

  return results;
}

function getQuotedMessageId(event) {
  const message = event?.message;
  const excluded = new Set([message?.message_id].filter(Boolean));

  const directCandidates = [
    message?.upper_message_id,
    message?.quote_message_id,
    event?.upper_message_id,
    event?.quote_message_id
  ].filter(Boolean);

  for (const candidate of directCandidates) {
    if (!excluded.has(candidate)) {
      return candidate;
    }
  }

  const parsed = parseMessageContent(message?.content || '{}');
  const nestedCandidates = Array.from(collectReferencedMessageIds(parsed));
  return nestedCandidates.find((candidate) => !excluded.has(candidate)) || null;
}

function getDirectReplyMessageId(event) {
  const message = event?.message;
  if (!message || message.thread_id) {
    return null;
  }

  const currentMessageId = message.message_id || null;
  const candidates = [
    message.parent_id,
    message.root_id
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && candidate !== currentMessageId) {
      return candidate;
    }
  }

  return null;
}

function getReferencedMessageId(event) {
  return getQuotedMessageId(event) || getDirectReplyMessageId(event);
}

function cleanPromptText(text, event) {
  let cleaned = (text || '').trim();
  for (const mention of getMentions(event)) {
    for (const token of [mention?.name, mention?.key, mention?.text].filter(Boolean)) {
      const rawToken = String(token);
      const withAt = rawToken.startsWith('@') ? rawToken : `@${rawToken}`;
      cleaned = cleaned.replaceAll(withAt, '').trim();
    }
  }
  return cleaned;
}

function extractMessageBodyText(item) {
  if (!item) {
    return '';
  }
  const raw = item.body?.content || item.content || item.message?.content || '';
  return getTextContent(raw);
}

async function fetchReferencedMessage(client, event) {
  const referencedMessageId = getReferencedMessageId(event);
  if (!referencedMessageId) {
    return null;
  }

  try {
    const response = await client.im.v1.message.get({
      path: {
        message_id: referencedMessageId
      }
    });
    const item = response?.data?.items?.[0] || null;
    if (!item) {
      return null;
    }

    const text = extractMessageBodyText(item);
    const attachments = await downloadAttachmentsForMessage(client, item);
    if (!text) {
      return {
        messageId: referencedMessageId,
        text: '',
        attachments,
        msgType: item.msg_type || null,
        senderType: item.sender?.sender_type || null
      };
    }

    return {
      messageId: referencedMessageId,
      text,
      attachments,
      msgType: item.msg_type || null,
      senderType: item.sender?.sender_type || null
    };
  } catch (error) {
    await logRuntime('referenced-message-fetch-failed', {
      chatId: event?.message?.chat_id || '',
      messageId: getMessageId(event) || '',
      referencedMessageId,
      error: error?.message || '未知错误'
    });
    return null;
  }
}

function buildReferencedMessagePrompt(referencedMessage, text = '') {
  if (!referencedMessage?.text && !referencedMessage?.attachments?.length) {
    return text;
  }

  const cleanedText = (text || '').trim();
  const lines = [
    '以下是用户在本轮消息里显式引用的原消息，请把它当作这次任务的重要上下文：',
    ''
  ];

  if (referencedMessage.text) {
    lines.push(`被引用消息: ${referencedMessage.text}`);
  }

  if (referencedMessage.attachments?.length) {
    lines.push(
      '被引用消息附件已下载到本地，请直接使用这些绝对路径：',
      ...referencedMessage.attachments.map((item) => `- [${item.type}] ${item.path}`)
    );
  }

  if (cleanedText) {
    lines.push('', `当前用户指令: ${cleanedText}`);
  }

  return lines.join('\n');
}

function getAttachmentPayload(message) {
  return parseMessageContent(message?.content || '{}');
}

function normalizeMessageForDownload(message) {
  if (!message) {
    return null;
  }

  return {
    message_id: message.message_id || null,
    chat_id: message.chat_id || 'chat',
    message_type: message.message_type || message.msg_type || null,
    content: message.content || message.body?.content || '{}'
  };
}

function extractPostAttachments(message) {
  const payload = getAttachmentPayload(message);
  const localeBlock = payload.zh_cn || payload.en_us || payload;
  const lines = Array.isArray(localeBlock?.content)
    ? localeBlock.content
    : Array.isArray(payload?.content)
      ? payload.content
      : [];
  const attachments = [];

  for (const line of lines) {
    for (const item of Array.isArray(line) ? line : []) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      if (item.tag === 'img' && item.image_key) {
        attachments.push({
          type: 'image',
          fileKey: item.image_key,
          name: item.image_name || `image-${Date.now()}.png`
        });
      }
      if (item.tag === 'file' && item.file_key) {
        attachments.push({
          type: 'file',
          fileKey: item.file_key,
          name: item.file_name || `file-${Date.now()}`
        });
      }
    }
  }

  return attachments;
}

function guessAttachmentFilename(message) {
  const payload = getAttachmentPayload(message);
  if (typeof payload.file_name === 'string' && payload.file_name.trim()) {
    return sanitizeFilename(payload.file_name.trim());
  }
  if (typeof payload.image_name === 'string' && payload.image_name.trim()) {
    return sanitizeFilename(payload.image_name.trim());
  }
  if (message?.message_type === 'image') {
    return `image-${Date.now()}.png`;
  }
  if (message?.message_type === 'file') {
    return `file-${Date.now()}`;
  }
  return `attachment-${Date.now()}`;
}

async function listDownloadedFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listDownloadedFiles(fullPath));
      continue;
    }
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    files.push({
      path: fullPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  }
  return files;
}

async function cleanupDownloads() {
  const now = Date.now();
  const ttlMs = config.downloadsTtlHours * 60 * 60 * 1000;
  const files = await listDownloadedFiles(config.downloadsDir);
  let remaining = [];

  for (const file of files) {
    if (ttlMs > 0 && now - file.mtimeMs > ttlMs) {
      await fs.unlink(file.path).catch(() => {});
    } else {
      remaining.push(file);
    }
  }

  remaining = remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = remaining.reduce((sum, file) => sum + file.size, 0);
  for (const file of remaining) {
    if (totalBytes <= config.downloadsMaxBytes) {
      break;
    }
    await fs.unlink(file.path).catch(() => {});
    totalBytes -= file.size;
  }
}

function scheduleDownloadCleanup() {
  cleanupPromise = cleanupPromise
    .catch(() => {})
    .then(() => cleanupDownloads())
    .catch((error) => logRuntime('downloads-cleanup-failed', {
      error: error?.message || '未知错误'
    }));
  return cleanupPromise;
}

async function downloadAttachmentsForMessage(client, rawMessage) {
  const message = normalizeMessageForDownload(rawMessage);
  if (!message?.message_id) {
    return [];
  }

  await fs.mkdir(config.downloadsDir, { recursive: true });
  await scheduleDownloadCleanup();

  const chatDir = path.join(config.downloadsDir, sanitizeFilename(message.chat_id || 'chat'));
  await fs.mkdir(chatDir, { recursive: true });
  const payload = getAttachmentPayload(message);
  const directFileKey = payload.file_key || payload.image_key || null;
  const directItems = directFileKey ? [{
    type: message.message_type,
    fileKey: directFileKey,
    name: guessAttachmentFilename(message)
  }] : [];
  const items = message.message_type === 'post' ? extractPostAttachments(message) : directItems;
  const downloads = [];

  for (const item of items) {
    const filePath = path.join(chatDir, `${Date.now()}-${sanitizeFilename(item.name)}`);
    try {
      const resource = await client.im.v1.messageResource.get({
        path: {
          message_id: message.message_id,
          file_key: item.fileKey
        },
        params: {
          type: item.type
        }
      });
      await resource.writeFile(filePath);
      downloads.push({
        type: item.type,
        path: filePath
      });
    } catch (error) {
      await logRuntime('attachment-download-failed', {
        messageId: message.message_id,
        messageType: message.message_type,
        itemType: item.type,
        fileKey: item.fileKey,
        request: {
          type: item.type
        },
        error: error?.message || '未知错误',
        response: error?.response?.data || null,
        status: error?.response?.status || null
      });
      throw error;
    }
  }

  await scheduleDownloadCleanup();
  return downloads;
}

async function downloadMessageAttachment(client, event) {
  return downloadAttachmentsForMessage(client, event?.message);
}

function buildAttachmentPrompt(attachments, text = '') {
  const lines = attachments.map((item) => `- [${item.type}] ${item.path}`);
  return [
    text.trim() || '用户发来了一些附件，请优先查看这些本地文件。',
    '',
    '附件已下载到本地，请直接使用这些绝对路径：',
    ...lines
  ].join('\n');
}

function selectPrimaryEvent(events) {
  const reversed = [...events].reverse();
  return reversed.find((event) => {
    const rawText = getTextContent(event?.message?.content);
    const normalizedText = cleanPromptText(rawText, event) || rawText;
    return Boolean(normalizedText.trim());
  }) || events[events.length - 1];
}

function aggregateBatchText(events, primaryEvent) {
  const primaryRawText = getTextContent(primaryEvent?.message?.content);
  const primaryText = (cleanPromptText(primaryRawText, primaryEvent) || primaryRawText || '').trim();
  if (!primaryText) {
    return '';
  }
  if (primaryText.startsWith('/')) {
    return primaryText;
  }

  const allTexts = events
    .map((event) => {
      const rawText = getTextContent(event?.message?.content);
      return (cleanPromptText(rawText, event) || rawText || '').trim();
    })
    .filter(Boolean);

  return allTexts.join('\n').trim();
}

async function collectBatchAttachments(client, events) {
  const attachments = [];
  for (const event of events) {
    const messageType = event?.message?.message_type;
    if (!['image', 'file', 'post'].includes(messageType)) {
      continue;
    }
    const downloaded = await downloadMessageAttachment(client, event);
    attachments.push(...downloaded);
  }
  return attachments;
}

function getMessageThreadMarkers(item) {
  return [
    item?.root_id || item?.message?.root_id || null,
    item?.parent_id || item?.message?.parent_id || null,
    item?.thread_id || item?.message?.thread_id || null,
    item?.message_id || item?.message?.message_id || null
  ].filter(Boolean);
}

function buildGroupContextPrompt(messages, currentText) {
  if (!messages.length) {
    return currentText;
  }

  const lines = messages
    .map((item, index) => {
      const text = extractMessageBodyText(item);
      if (!text) {
        return null;
      }
      const senderType = item?.sender?.sender_type || item?.sender_type || 'user';
      const label = senderType === 'app' ? '机器人' : `群消息${index + 1}`;
      return `${label}: ${text}`;
    })
    .filter(Boolean);

  if (!lines.length) {
    return currentText;
  }

  return [
    '以下是这条群聊任务最近的上下文消息，请把它们当作任务背景，只处理最后这条用户指令。',
    '',
    lines.join('\n'),
    '',
    `当前用户指令: ${currentText}`
  ].join('\n');
}

function formatGroupNewCommandHint() {
  return [
    '群聊里顶层消息请用 `@机器人 + 指令` 的格式。',
    '',
    '可用指令：',
    '`@机器人 /new codex /Users/xzq/project-a 帮我排查这个报错`',
    '`@机器人 /new cursor /Users/xzq/project-b 帮我检查这个仓库的 TODO`',
    '`@机器人 /sessions`',
    '`@机器人 /status`',
    '',
    '其中只有 `/new` 必须指定工作目录。创建成功后，后续都只在这个话题里继续，不需要再 @。'
  ].join('\n');
}

function formatMainPanelHint(chatKey, isGroup) {
  const commands = isGroup
    ? [
        '`@机器人 /new codex /Users/xzq/project-a 帮我排查这个报错`',
        '`@机器人 /sessions`',
        '`@机器人 /status`',
        '`@机器人 S1: 帮我继续这个会话`'
      ]
    : [
        '`/new codex /Users/xzq/project-a 帮我排查这个报错`',
        '`/sessions`',
        '`/status`',
        '`S1: 帮我继续这个会话`'
      ];

  const header = isGroup
    ? '群聊主面板只接受 `@机器人 + 命令` 或 `@机器人 S1: ...`，不直接承接任务正文。'
    : '私聊主面板只接受命令，不直接承接任务正文。';

  return [
    header,
    '',
    '你可以用：',
    ...commands,
    '',
    '当前状态：',
    formatStatus(chatKey, { global: !isGroup }),
    '',
    '最近会话：',
    (isGroup ? formatRecentSessions(chatKey) : formatGlobalRecentSessions()).replace(/^最近会话:\s*/, ''),
    '',
    isGroup
      ? '真正的任务内容，请去对应 session 的话题里继续回复；如果你还在群聊主面板，请使用 `@机器人 S1:` 这种显式路由。'
      : '真正的任务内容，请去对应 session 的话题里继续回复；如果你就在主面板，也可以用 `S1:` 这种显式路由继续。'
  ].join('\n');
}

async function fetchRecentGroupContext(client, event, limit = 12) {
  const message = event?.message;
  if (!message?.chat_id) {
    return [];
  }

  try {
    const response = await client.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: message.chat_id,
        sort_type: 'ByCreateTimeDesc',
        page_size: limit
      }
    });

    let items = response?.data?.items || [];
    const markers = new Set(getThreadMarkers(event));
    if (markers.size) {
      const threaded = items.filter((item) => getMessageThreadMarkers(item).some((marker) => markers.has(marker)));
      if (threaded.length) {
        items = threaded;
      }
    }

    return items.reverse();
  } catch (error) {
    await logRuntime('group-context-fetch-failed', {
      chatId: message.chat_id,
      messageId: message.message_id || '',
      error: error?.message || '未知错误'
    });
    return [];
  }
}

async function ensureChatMeta(client, chatKey, chatTypeHint = null) {
  const current = store.getChatMeta(chatKey);
  if (current.chatName && current.chatType) {
    return current;
  }

  let chatName = current.chatName || '';
  let chatType = current.chatType || chatTypeHint || null;

  try {
    const response = await client.im.v1.chat.get({
      path: {
        chat_id: chatKey
      }
    });
    const data = response?.data || {};
    chatName = data.name || data.chat?.name || chatName;
    chatType = data.chat_mode || data.chat_type || data.chat?.chat_type || chatType;
  } catch {
    // Ignore fetch failures and keep local fallback labels.
  }

  await store.setChatMeta(chatKey, {
    chatName,
    chatType
  });

  return store.getChatMeta(chatKey);
}

async function ensureAllChatMeta(client) {
  const chats = store.listAllChats();
  for (const chat of chats) {
    await ensureChatMeta(client, chat.chatKey, chat.chatType || null);
  }
}

function formatHelp() {
  return [
    'Codex 飞书机器人已就绪。',
    '',
    '私聊里可直接发送 `S1:` 把消息显式发给指定会话',
    '群聊主面板里请使用 `@机器人 S1:`；进入机器人自己的线程后可直接继续回复',
    '/agent：查看当前活跃会话使用的 Agent',
    '/new：创建一个新的会话，并设为当前活跃',
    '/new cursor：创建一个使用 Cursor Agent 的新会话',
    '/new cursor /path/to/project：创建新会话并同时指定 Agent 和目录',
    '/new cursor /path/to/project 你的第一条指令：创建新会话并立即开始',
    '/cwd：查看当前活跃会话的工作目录',
    '/cwd /path/to/project：修改当前活跃会话的工作目录',
    '/cwd S1 /path/to/project：修改指定会话的工作目录',
    '/stop：停止当前正在运行的会话',
    '/stop S1：停止指定会话',
    '/delete：删除当前活跃会话',
    '/delete S1：删除指定会话，并自动整理编号',
    '/show：在线程里查看当前会话最近 10 条消息',
    '/show S1：查看某个会话最近 10 条消息',
    '/diff S1：查看某个会话最近一轮代码改动摘要',
    '/sessions：查看最近会话（私聊主面板里会显示全局）',
    '/status：查看当前状态（私聊主面板里会显示全局）',
    '/attach <转移ID>：把另一个聊天里的 session 挂接到当前聊天继续',
    '/clean：清空会话。私聊里清空全部，群聊里清空当前群聊',
    '/help：显示帮助'
  ].join('\n');
}

function formatUnknownCommand(command) {
  return [
    `未识别命令: ${command}`,
    '',
    '这条消息以 `/` 开头，所以我没有把它发送给 Codex。',
    '如果这是手误，请直接重新输入正确命令，或发送普通文本。',
    '',
    '可用命令:',
    '/new',
    '/cwd',
    '/stop',
    '/delete',
    '/show S1',
    '/diff S1',
    '/sessions',
    '/status',
    '/attach <转移ID>',
    '/clean',
    '/help'
  ].join('\n');
}

function formatStatus(chatKey, options = {}) {
  if (options.global) {
    const chats = store.listAllChats().filter((chat) => chat.sessions.length > 0);
    const allSessions = chats.flatMap(({ chatKey: key, sessions }) => sessions.map((session) => ({ chatKey: key, session })))
      .sort((a, b) => new Date(b.session.updatedAt) - new Date(a.session.updatedAt));
    const seen = new Set();
    const uniqueSessions = allSessions.filter(({ session }) => {
      if (seen.has(session.id)) {
        return false;
      }
      seen.add(session.id);
      return true;
    });
    const running = uniqueSessions.filter(({ chatKey: key, session }) => getEffectiveSessionStatus(key, session) === 'running');
    const idle = uniqueSessions.filter(({ chatKey: key, session }) => getEffectiveSessionStatus(key, session) === 'idle');
    const lines = [
      '视图: 全局',
      `聊天数量: ${chats.length}`,
      `会话数量: ${uniqueSessions.length}`,
      `运行中会话: ${running.length ? running.map(({ session }) => `${session.alias}(${getStageLabel(session.currentStage) || '处理中'})`).join(', ') : '无'}`,
      `空闲会话: ${idle.length ? idle.map(({ session }) => session.alias).join(', ') : '无'}`,
      '跨聊天续接请使用 `/attach <转移ID>`',
      formatGlobalRecentSessions()
    ];
    return lines.join('\n');
  }

  const record = store.get(chatKey);
  const running = hasRunningJob(chatKey);
  const idleSessions = store.listSessions(chatKey).filter((session) => session.status === 'idle');
  return [
    `聊天: ${chatKey}`,
    `当前会话: ${record.activeAlias || '无'}`,
    `状态: ${running ? '处理中' : '空闲'}`,
    `会话数量: ${store.listSessions(chatKey).length}`,
    record.activeAlias && store.getSession(chatKey, record.activeAlias)
      ? `当前 Agent: ${getProviderLabel(store.getSession(chatKey, record.activeAlias).provider)}`
      : `默认 Agent: ${getProviderLabel(config.defaultAgentProvider)}`,
    idleSessions.length ? `空闲会话: ${idleSessions.map((session) => session.alias).join(', ')}` : '空闲会话: 无',
    record.activeAlias && store.getSession(chatKey, record.activeAlias)
      ? `当前目录: ${store.getSession(chatKey, record.activeAlias).workspace || config.defaultWorkspace}`
      : `默认目录: ${config.defaultWorkspace}`,
    record.activeAlias && store.getSession(chatKey, record.activeAlias)?.status === 'running'
      ? `当前阶段: ${getStageLabel(store.getSession(chatKey, record.activeAlias)?.currentStage) || '处理中'}`
      : null,
    record.activeAlias && store.getSession(chatKey, record.activeAlias)?.status === 'running' && store.getSession(chatKey, record.activeAlias)?.currentActivityPreview
      ? `最近进展: ${store.getSession(chatKey, record.activeAlias)?.currentActivityPreview}`
      : null,
    formatRecentSessions(chatKey)
  ].filter(Boolean).join('\n');
}

async function sendTextMessage(client, chatId, text, replyToMessageId = null) {
  const safeText = text.slice(0, 30000) || 'Codex 已完成，但没有返回正文。';
  console.log('[send]', { chatId, preview: safeText.slice(0, 120) });
  if (replyToMessageId) {
    const response = await client.im.v1.message.reply({
      path: {
        message_id: replyToMessageId
      },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: safeText }),
        reply_in_thread: true
      }
    });
    return response?.data || null;
  }
  const response = await client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id'
    },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: safeText })
    }
  });
  return response?.data || null;
}

async function sendResultCard(client, chatId, payload, replyToMessageId = null) {
  const card = buildResultCard(payload);
  console.log('[send-card]', { chatId, alias: payload.alias, preview: trimPreview(payload.output, 120) });
  if (replyToMessageId) {
    const response = await client.im.v1.message.reply({
      path: {
        message_id: replyToMessageId
      },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
        reply_in_thread: true
      }
    });
    return response?.data || null;
  }
  const response = await client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id'
    },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    }
  });
  return response?.data || null;
}

async function registerOutboundMessage(chatKey, alias, responseData) {
  const messageId = responseData?.message_id;
  const threadId = responseData?.thread_id;
  if (!messageId && !threadId) {
    return;
  }
  if (messageId) {
    await store.registerMessageId(chatKey, alias, messageId).catch(() => {});
  }
  if (threadId) {
    await store.registerThreadId(chatKey, alias, threadId).catch(() => {});
  }
}

async function registerOutboundMessageBySessionId(chatKey, sessionInternalId, responseData) {
  const messageId = responseData?.message_id;
  const threadId = responseData?.thread_id;
  if (!messageId && !threadId) {
    return;
  }
  if (messageId) {
    await store.registerMessageIdById(chatKey, sessionInternalId, messageId).catch(() => {});
  }
  if (threadId) {
    await store.registerThreadIdById(chatKey, sessionInternalId, threadId).catch(() => {});
  }
}

function getThreadReplyTarget(chatKey, event) {
  const threadSession = resolveSessionFromThread(chatKey, event);
  if (!threadSession) {
    return null;
  }
  return getMessageId(event) || threadSession.rootMessageId || null;
}

async function sendCommandReply(client, event, text) {
  const chatKey = getChatKey(event);
  const replyTarget = getThreadReplyTarget(chatKey, event);
  return sendTextMessage(client, event.message.chat_id, text, replyTarget);
}

async function sendStageUpdate(client, event, chatKey, sessionInternalId, stage, provider, replyTargetOverride = null) {
  const session = store.getSessionById(chatKey, sessionInternalId);
  if (!session) {
    return;
  }

  const replyTarget = replyTargetOverride || getMessageId(event) || session.rootMessageId || null;
  if (!replyTarget) {
    return;
  }

  const text = `${session.alias}（${getProviderLabel(provider)}）当前阶段：${getStageLabel(stage) || '处理中'}。`;
  const response = await sendTextMessage(client, event.message.chat_id, text, replyTarget);
  await registerOutboundMessageBySessionId(chatKey, sessionInternalId, response);
}

async function sendProgressUpdate(client, event, chatKey, sessionInternalId, provider, text, replyTargetOverride = null) {
  const session = store.getSessionById(chatKey, sessionInternalId);
  if (!session) {
    return;
  }

  const replyTarget = replyTargetOverride || getMessageId(event) || session.rootMessageId || null;
  if (!replyTarget) {
    return;
  }

  const message = `${session.alias}（${getProviderLabel(provider)}）${text}`;
  const response = await sendTextMessage(client, event.message.chat_id, message, replyTarget);
  await registerOutboundMessageBySessionId(chatKey, sessionInternalId, response);
}

async function resetSession(client, event) {
  const chatKey = getChatKey(event);
  await store.resetChat(chatKey);
  await sendCommandReply(client, event, '已清空当前聊天的所有会话。下一条消息会新开 S1。');
}

async function cleanSessions(client, event) {
  const isGroup = isGroupChat(event);
  if (isGroup) {
    const chatKey = getChatKey(event);
    await store.resetChat(chatKey);
    await sendCommandReply(client, event, '已清空当前群聊下的所有会话。下一条消息会新开 S1。');
    return;
  }

  await store.resetAllChats();
  await sendCommandReply(client, event, '已清空全部聊天下的所有会话。下一条消息会重新开始。');
}

async function attachSession(client, event, transferId) {
  const chatKey = getChatKey(event);
  const sourceRef = store.findSessionRefById(transferId);
  if (!sourceRef) {
    await sendCommandReply(client, event, `没有找到转移 ID 为 \`${transferId}\` 的会话。`);
    return true;
  }

  const effectiveStatus = getEffectiveSessionStatus(sourceRef.chatKey, sourceRef.session);
  if (effectiveStatus === 'running') {
    await sendCommandReply(
      client,
      event,
      [
        `转移 ID \`${transferId}\` 当前仍在运行中。`,
        `来源会话: ${sourceRef.session.alias} @ ${sourceRef.chatKey}`,
        '请等它空闲后再 attach，避免两个聊天同时续接同一个底层会话。'
      ].join('\n')
    );
    return true;
  }

  const attachedResult = await store.attachSession(chatKey, transferId);
  if (!attachedResult) {
    await sendCommandReply(client, event, `没有找到转移 ID 为 \`${transferId}\` 的会话。`);
    return true;
  }

  const { attached, alreadyAttached } = attachedResult;
  await sendCommandReply(
    client,
    event,
    [
      alreadyAttached ? `转移 ID \`${transferId}\` 已经在当前聊天里挂接为 ${attached.alias}。` : `已把转移 ID \`${transferId}\` 挂接到当前聊天，新的会话编号是 ${attached.alias}。`,
      `Agent: ${getProviderLabel(attached.provider)}`,
      `工作目录: ${attached.workspace || config.defaultWorkspace}`,
      `当前状态: ${getStatusLabel(getEffectiveSessionStatus(chatKey, attached))}`,
      `之后你可以直接发送 \`${attached.alias}: 你的新指令\` 继续。`
    ].join('\n')
  );
  return true;
}

async function stopSessionRun(chatKey, alias) {
  const session = store.getSession(chatKey, alias);
  const jobKey = getJobKey(chatKey, session?.id || alias);
  const child = activeProcesses.get(jobKey);
  if (!child) {
    return false;
  }

  stopRequests.add(jobKey);
  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore termination errors.
  }

  const timer = setTimeout(() => {
    const stillRunning = activeProcesses.get(jobKey);
    if (stillRunning) {
      try {
        stillRunning.kill('SIGKILL');
      } catch {
        // Ignore force-kill errors.
      }
    }
  }, 1500);
  timer.unref?.();

  await logRuntime('agent-turn-stop-requested', { chatKey, alias });
  return true;
}

async function ensureSessionRootMessage(client, event, chatKey, session, options = {}) {
  const existing = store.getSession(chatKey, session.alias);
  if (existing?.rootMessageId && !options.forceNew) {
    return existing.rootMessageId;
  }

  const lines = [
    options.forceNew ? `已为 ${session.alias} 创建新的话题入口。` : `已创建新会话 ${session.alias}。`,
    `Agent: ${getProviderLabel(session.provider || config.defaultAgentProvider)}`,
    `工作目录: ${session.workspace || config.defaultWorkspace}`,
    options.promptQueued ? '你的首条指令也已收到，后续结果会回复在这个话题下。' : '现在直接回复这条消息，默认就会进入这个会话。',
    '',
    formatRecentSessions(chatKey)
  ];
  const created = await sendTextMessage(client, event.message.chat_id, lines.join('\n'));
  const rootMessageId = created?.message_id || null;
  if (rootMessageId) {
    await store.updateSession(chatKey, session.alias, { rootMessageId });
    await store.registerMessageId(chatKey, session.alias, rootMessageId);
    if (created?.thread_id) {
      await store.registerThreadId(chatKey, session.alias, created.thread_id);
    }
    session.rootMessageId = rootMessageId;
  }
  return rootMessageId;
}

function resolveSessionFromThread(chatKey, event) {
  const markers = getThreadMarkers(event);
  for (const marker of markers) {
    const session = store.findSessionByThreadMarker(chatKey, marker);
    if (session) {
      return session;
    }
  }
  return null;
}

async function handleCommand(client, event, text, options = {}) {
  const command = text.trim();
  const chatKey = getChatKey(event);

  if (command.toLowerCase() === '/help') {
    await sendCommandReply(client, event, formatHelp());
    return true;
  }

  if (command.toLowerCase() === '/reset') {
    await resetSession(client, event);
    return true;
  }

  if (command.toLowerCase() === '/clean') {
    await cleanSessions(client, event);
    return true;
  }

  const attachMatch = command.match(/^\/attach\s+([a-f0-9-]{16,})$/i);
  if (attachMatch) {
    return attachSession(client, event, attachMatch[1]);
  }

  if (command.toLowerCase() === '/agent') {
    const threadSession = resolveSessionFromThread(chatKey, event);
    const session = threadSession || await store.ensureActiveSession(chatKey);
    await sendCommandReply(
      client,
      event,
      [`会话: ${session.alias}`, `当前 Agent: ${getProviderLabel(session.provider || config.defaultAgentProvider)}`].join('\n')
    );
    return true;
  }

  const agentMatch = command.match(/^\/agent(?:\s+(S\d+))?\s+(codex|claude|cursor|opencode)$/i);
  if (agentMatch) {
    await sendCommandReply(
      client,
      event,
      [
        '已创建的会话不支持切换 Agent。',
        '这是为了避免底层会话上下文丢失或串线。',
        `请使用 \`/new ${agentMatch[2].toLowerCase()} /path/to/project 你的第一条指令\` 新建一个对应 Agent 的会话。`
      ].join('\n')
    );
    return true;
  }

  if (command.toLowerCase().startsWith('/new')) {
    const parsed = await parseNewCommand(command);
    const session = await store.createSession(chatKey);
    if (parsed.provider) {
      await store.updateSession(chatKey, session.alias, {
        provider: parsed.provider,
        sessionId: null,
        status: 'idle',
        currentTaskPreview: ''
      });
      session.provider = parsed.provider;
    }
    if (parsed.workspace) {
      await store.updateSession(chatKey, session.alias, { workspace: parsed.workspace });
      session.workspace = parsed.workspace;
    }

    const initialPrompt = buildReferencedMessagePrompt(options.referencedMessage, parsed.prompt || '');
    if (initialPrompt) {
      await ensureSessionRootMessage(client, event, chatKey, session, { promptQueued: true });
      void queueTurn(client, event, initialPrompt, session.alias);
      return true;
    }

    await ensureSessionRootMessage(client, event, chatKey, session, { promptQueued: false });
    return true;
  }

  if (command.toLowerCase() === '/cwd') {
    const threadSession = resolveSessionFromThread(chatKey, event);
    const session = threadSession || await store.ensureActiveSession(chatKey);
      await sendCommandReply(client, event, formatWorkspaceStatus(chatKey, session));
      return true;
  }

  if (command.toLowerCase() === '/stop') {
    const activeAlias = store.get(chatKey).activeAlias;
    if (!activeAlias) {
      await sendCommandReply(client, event, '当前没有可停止的会话。');
      return true;
    }
    const stopped = await stopSessionRun(chatKey, activeAlias);
    if (!stopped) {
      const activeSession = store.getSession(chatKey, activeAlias);
      if (activeSession?.status === 'running') {
        await store.updateSession(chatKey, activeAlias, {
          status: 'idle',
          currentTaskPreview: '',
          lastResultPreview: '已清理陈旧的运行中状态。',
          lastFinishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        await sendCommandReply(client, event, `${activeAlias} 没有检测到真实运行进程，已清理陈旧的运行中状态。`);
        return true;
      }
      await sendCommandReply(client, event, `${activeAlias} 当前没有运行中的任务。`);
      return true;
    }
    await sendCommandReply(client, event, `已请求停止 ${activeAlias}，稍后会释放这个会话。`);
    return true;
  }

  const stopMatch = command.match(/^\/stop\s+(S\d+)$/i);
  if (stopMatch) {
    const alias = stopMatch[1].toUpperCase();
    const session = store.getSession(chatKey, alias);
    if (!session) {
      await sendCommandReply(client, event, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
      return true;
    }
    const stopped = await stopSessionRun(chatKey, alias);
    if (!stopped) {
      if (session.status === 'running') {
        await store.updateSession(chatKey, alias, {
          status: 'idle',
          currentTaskPreview: '',
          lastResultPreview: '已清理陈旧的运行中状态。',
          lastFinishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        await sendCommandReply(client, event, `${alias} 没有检测到真实运行进程，已清理陈旧的运行中状态。`);
        return true;
      }
      await sendCommandReply(client, event, `${alias} 当前没有运行中的任务。`);
      return true;
    }
    await sendCommandReply(client, event, `已请求停止 ${alias}，稍后会释放这个会话。`);
    return true;
  }

  if (command.toLowerCase() === '/delete') {
    const active = store.get(chatKey).activeAlias;
    if (!active) {
      await sendCommandReply(client, event, '当前没有可删除的会话。');
      return true;
    }
    const deleted = await store.deleteSession(chatKey, active);
    await sendCommandReply(
      client,
      event,
      [
        `已删除 ${deleted.deletedAlias}。`,
        deleted.activeAlias ? `当前活跃会话已切换为 ${deleted.activeAlias}。` : '当前聊天已没有剩余会话。',
        '其余会话编号已自动整理。',
        '',
        formatRecentSessions(chatKey)
      ].join('\n')
    );
    return true;
  }

  const deleteMatch = command.match(/^\/delete\s+(S\d+)$/i);
  if (deleteMatch) {
    const alias = deleteMatch[1].toUpperCase();
    const deleted = await store.deleteSession(chatKey, alias);
    if (!deleted) {
      await sendCommandReply(client, event, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
      return true;
    }
    await sendCommandReply(
      client,
      event,
      [
        `已删除 ${deleted.deletedAlias}。`,
        deleted.activeAlias ? `当前活跃会话: ${deleted.activeAlias}` : '当前聊天已没有剩余会话。',
        '其余会话编号已自动整理。',
        '',
        formatRecentSessions(chatKey)
      ].join('\n')
    );
    return true;
  }

  const cwdMatch = command.match(/^\/cwd(?:\s+(S\d+))?\s+(.+)$/i);
  if (cwdMatch) {
    const alias = cwdMatch[1]?.toUpperCase() || (await store.ensureActiveSession(chatKey)).alias;
    const session = store.getSession(chatKey, alias);
    if (!session) {
      await sendCommandReply(client, event, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
      return true;
    }

    try {
      const workspace = await resolveWorkspaceInput(cwdMatch[2]);
      await store.updateSession(chatKey, alias, { workspace });
      await sendCommandReply(
        client,
        event,
        [`已更新 ${alias} 的工作目录。`, `工作目录: ${workspace}`, `之后发给 ${alias} 的消息都会在这个目录里运行。`].join('\n')
      );
    } catch (error) {
      await sendCommandReply(client, event, error.message || '工作目录设置失败。');
    }
    return true;
  }

  if (command.toLowerCase() === '/status') {
    if (!isGroupChat(event)) {
      await ensureAllChatMeta(client);
    } else {
      await ensureChatMeta(client, chatKey, event?.message?.chat_type || null);
    }
    await sendCommandReply(client, event, formatStatus(chatKey, { global: !isGroupChat(event) }));
    return true;
  }

  if (command.toLowerCase() === '/sessions') {
    if (!isGroupChat(event)) {
      await ensureAllChatMeta(client);
    } else {
      await ensureChatMeta(client, chatKey, event?.message?.chat_type || null);
    }
    await sendCommandReply(client, event, !isGroupChat(event) ? formatGlobalRecentSessions() : formatRecentSessions(chatKey));
    return true;
  }

  const showMatch = command.match(/^\/show(?:\s+(S\d+))?$/i);
  if (showMatch) {
    const alias = showMatch[1]?.toUpperCase() || resolveSessionFromThread(chatKey, event)?.alias || store.get(chatKey).activeAlias;
    if (!alias) {
      await sendCommandReply(client, event, '当前没有可查看消息记录的会话。');
      return true;
    }
    const session = store.getSession(chatKey, alias);
    if (!session) {
      await sendCommandReply(client, event, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
      return true;
    }
    await sendCommandReply(client, event, formatSessionTranscript(chatKey, session, 10));
    return true;
  }

  const diffMatch = command.match(/^\/diff(?:\s+(S\d+))?$/i);
  if (diffMatch) {
    const alias = diffMatch[1]?.toUpperCase() || resolveSessionFromThread(chatKey, event)?.alias || store.get(chatKey).activeAlias;
    if (!alias) {
      await sendCommandReply(client, event, '当前没有可查看 diff 的会话。');
      return true;
    }
    const session = store.getSession(chatKey, alias);
    if (!session) {
      await sendCommandReply(client, event, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
      return true;
    }
    await sendCommandReply(client, event, formatDiffDetails(chatKey, session));
    return true;
  }

  const aliasOnly = parseSessionAlias(command);
  if (aliasOnly) {
    const session = store.getSession(chatKey, aliasOnly);
    if (!session) {
      await sendCommandReply(client, event, `没有找到 ${aliasOnly}。发送 /sessions 看最近会话。`);
      return true;
    }
    await sendCommandReply(client, event, formatSessionTranscript(chatKey, session, 10));
    return true;
  }

  if (command.startsWith('/')) {
    await sendCommandReply(client, event, formatUnknownCommand(command));
    return true;
  }

  return false;
}

async function queueTurn(client, event, prompt, alias) {
  const chatKey = getChatKey(event);
  const initialSession = store.getSession(chatKey, alias);
  if (!initialSession) {
    await sendTextMessage(client, event.message.chat_id, `没有找到 ${alias}。发送 /sessions 看最近会话，或 /new 新建一个。`);
    return;
  }

  const sessionInternalId = initialSession.id;
  const jobKey = getJobKey(chatKey, sessionInternalId);
  const prior = activeJobs.get(jobKey) || Promise.resolve();

  const next = prior
    .catch(() => {})
    .then(async () => {
      const session = await store.touchSessionById(chatKey, sessionInternalId);
      if (!session) {
        await logRuntime('agent-turn-session-missing-before-start', {
          chatKey,
          alias,
          sessionInternalId
        });
        return;
      }
      const workspace = session?.workspace || config.defaultWorkspace;
      const provider = session?.provider || config.defaultAgentProvider;
      const rootMessageId = session?.rootMessageId || null;
      const incomingMessageId = getMessageId(event);
      const liveAlias = session.alias;
      const replyTargetMessageId = incomingMessageId || rootMessageId || null;
      let latestActivityPreview = '';
      let lastActivityAt = Date.now();
      let lastReportedActivity = '';
      let lastHeartbeatAt = 0;
      const opening = session?.sessionId
        ? `已收到，继续 ${liveAlias}（${getProviderLabel(provider)}）处理中。`
        : `已收到，正在为你启动新的会话 ${liveAlias}（${getProviderLabel(provider)}）。`;
      if (replyTargetMessageId) {
        const reply = await sendTextMessage(client, event.message.chat_id, opening, replyTargetMessageId);
        await registerOutboundMessageBySessionId(chatKey, sessionInternalId, reply);
      } else {
        const created = await sendTextMessage(client, event.message.chat_id, opening);
        if (created?.message_id) {
          await store.updateSessionById(chatKey, sessionInternalId, { rootMessageId: created.message_id });
          session.rootMessageId = created.message_id;
          await registerOutboundMessageBySessionId(chatKey, sessionInternalId, created);
        }
      }

      await store.appendTurnById(chatKey, sessionInternalId, {
        role: 'user',
        text: prompt,
        createdAt: new Date().toISOString()
      });
      await store.updateSessionById(chatKey, sessionInternalId, {
        status: 'running',
        currentTaskPreview: trimPreview(prompt, 120),
        currentStage: 'preparing',
        currentStageAt: new Date().toISOString(),
        currentActivityPreview: '',
        currentActivityAt: null,
        lastStartedAt: new Date().toISOString()
      });
      await sendStageUpdate(client, event, chatKey, sessionInternalId, 'preparing', provider, replyTargetMessageId);
      const heartbeatTimer = setInterval(() => {
        void (async () => {
          const liveSession = store.getSessionById(chatKey, sessionInternalId);
          if (!liveSession || liveSession.status !== 'running') {
            return;
          }

          const now = Date.now();
          if (now - lastHeartbeatAt < 30000) {
            return;
          }

          if (latestActivityPreview && latestActivityPreview !== lastReportedActivity) {
            lastReportedActivity = latestActivityPreview;
            lastHeartbeatAt = now;
            await sendProgressUpdate(
              client,
              event,
              chatKey,
              sessionInternalId,
              provider,
              `最近进展：${latestActivityPreview}`,
              replyTargetMessageId
            );
            return;
          }

          if (now - lastActivityAt >= 30000) {
            lastHeartbeatAt = now;
            await sendProgressUpdate(
              client,
              event,
              chatKey,
              sessionInternalId,
              provider,
              `仍在 ${getStageLabel(liveSession.currentStage) || '执行中'}，已持续 ${formatElapsedDuration(liveSession.lastStartedAt)}。`,
              replyTargetMessageId
            );
          }
        })().catch(() => {});
      }, 15000);
      heartbeatTimer.unref?.();
      const beforeSnapshot = await captureWorkspaceSnapshot(workspace);

      try {
        const result = await runAgentTurn({
          provider,
          sessionId: session?.sessionId || null,
          prompt,
          config: {
            ...config,
            workspace,
            onSpawn: (child) => {
              activeProcesses.set(jobKey, child);
              void store.updateSessionById(chatKey, sessionInternalId, {
                currentStage: 'agent_running',
                currentStageAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              }).catch(() => {});
              void sendStageUpdate(client, event, chatKey, sessionInternalId, 'agent_running', provider, replyTargetMessageId).catch(() => {});
            },
            onActivity: (snippet) => {
              latestActivityPreview = trimPreview(snippet, 120);
              lastActivityAt = Date.now();
              void store.updateSessionById(chatKey, sessionInternalId, {
                currentActivityPreview: latestActivityPreview,
                currentActivityAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              }).catch(() => {});
            }
          }
        });
        await store.updateSessionById(chatKey, sessionInternalId, {
          currentStage: 'analyzing_changes',
          currentStageAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        await sendStageUpdate(client, event, chatKey, sessionInternalId, 'analyzing_changes', provider, replyTargetMessageId);
        const afterSnapshot = await captureWorkspaceSnapshot(workspace);
        const diff = await summarizeWorkspaceChanges(beforeSnapshot, afterSnapshot);

        await store.updateSessionById(chatKey, sessionInternalId, {
          currentStage: 'sending_result',
          currentStageAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        await sendStageUpdate(client, event, chatKey, sessionInternalId, 'sending_result', provider, replyTargetMessageId);
        const updatedSession = await store.updateSessionById(chatKey, sessionInternalId, {
          sessionId: result.sessionId,
          provider,
          status: 'idle',
          currentTaskPreview: '',
          currentStage: '',
          currentStageAt: null,
          currentActivityPreview: '',
          currentActivityAt: null,
          lastResultPreview: trimPreview(result.output || 'Codex 没有返回正文。', 120),
          lastDiffSummary: diff.summary,
          lastDiffPatch: diff.patch,
          lastChangedFiles: diff.changedFiles,
          lastBranchChange: diff.branchChange,
          lastCommitChange: diff.commitChange,
          lastFinishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        if (!updatedSession) {
          await logRuntime('agent-turn-session-missing-after-run', {
            chatKey,
            alias: liveAlias,
            sessionInternalId,
            provider,
            workspace
          });
          return;
        }
        await store.appendTurnById(chatKey, sessionInternalId, {
          role: 'assistant',
          text: result.output || 'Codex 没有返回正文。',
          createdAt: new Date().toISOString()
        });

        const cardReply = await sendResultCard(client, event.message.chat_id, {
          chatKey,
          alias: updatedSession.alias,
          output: [
            `状态: ${getStatusLabel('success')}`,
            result.output || 'Codex 没有返回正文。',
            '',
            diff.summary
          ].join('\n\n'),
          sessionId: result.sessionId || '未知',
          workspace,
          status: 'success',
          provider,
          sourceLabel: getChatSourceLabel(event),
          branchChange: diff.branchChange,
          commitChange: diff.commitChange,
          title: `${getProviderLabel(provider)} 结果`
        }, replyTargetMessageId || session?.rootMessageId || null);
        await registerOutboundMessageBySessionId(chatKey, sessionInternalId, cardReply);
      } finally {
        clearInterval(heartbeatTimer);
      }
    })
    .catch(async (error) => {
      const currentSession = store.getSessionById(chatKey, sessionInternalId);
      const providerLabel = getProviderLabel(currentSession?.provider || config.defaultAgentProvider);
      if (stopRequests.has(jobKey)) {
        stopRequests.delete(jobKey);
        await store.updateSessionById(chatKey, sessionInternalId, {
          status: 'idle',
          currentTaskPreview: '',
          currentStage: '',
          currentStageAt: null,
          currentActivityPreview: '',
          currentActivityAt: null,
          lastResultPreview: '已手动停止当前任务。',
          lastFinishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }).catch(() => {});
        await store.appendTurnById(chatKey, sessionInternalId, {
          role: 'assistant',
          text: '当前任务已手动停止。',
          createdAt: new Date().toISOString()
        }).catch(() => {});
        return;
      }
      await logRuntime('agent-turn-failed', {
        chatKey,
        alias: currentSession?.alias || alias,
        sessionInternalId,
        provider: currentSession?.provider || config.defaultAgentProvider,
        workspace: currentSession?.workspace || config.defaultWorkspace,
        error: {
          message: error?.message || '未知错误',
          stderr: error?.stderr || '',
          exitCode: error?.exitCode ?? null,
          stack: error?.stack || ''
        }
      });
      await store.updateSessionById(chatKey, sessionInternalId, {
        status: 'error',
        currentTaskPreview: '',
        currentStage: '',
        currentStageAt: null,
        currentActivityPreview: '',
        currentActivityAt: null,
        lastResultPreview: trimPreview(error.stderr || error.message || '未知错误', 120),
        lastDiffSummary: '',
        lastDiffPatch: '',
        lastChangedFiles: [],
        lastBranchChange: null,
        lastCommitChange: null,
        lastFinishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }).catch(() => {});
      const detail = (error.stderr || error.message || '未知错误').trim().slice(0, 4000);
      if (currentSession) {
        const errorReply = await sendTextMessage(
          client,
          event.message.chat_id,
          [`${providerLabel} 执行失败。`, '', detail || '没有拿到更多错误信息。', '', '发送 /status 查看当前状态，或 /new 重开会话。'].join('\n'),
          getMessageId(event) || currentSession?.rootMessageId || null
        );
        await registerOutboundMessageBySessionId(chatKey, sessionInternalId, errorReply);
      }
    })
    .finally(() => {
      activeProcesses.delete(jobKey);
      stopRequests.delete(jobKey);
      if (activeJobs.get(jobKey) === next) {
        activeJobs.delete(jobKey);
      }
    });

  activeJobs.set(jobKey, next);
  await next;
}

async function processIncomingBatch(client, events) {
  const primaryEvent = selectPrimaryEvent(events);
  const message = primaryEvent?.message;
  if (!message) {
    return;
  }

  const chatKey = getChatKey(primaryEvent);
  await ensureChatMeta(client, chatKey, message.chat_type || null);
  const rawText = aggregateBatchText(events, primaryEvent);
  console.log('[message]', {
    chatId: message.chat_id,
    text: rawText,
    attachments: [],
    batchSize: events.length,
    content: rawText ? undefined : message.content
  });

  const normalizedText = cleanPromptText(rawText, primaryEvent) || rawText;
  const isGroup = isGroupChat(primaryEvent);
  const mentioned = isBotMentioned(primaryEvent);
  const threadMarkers = getThreadMarkers(primaryEvent);
  const threadSession = resolveSessionFromThread(chatKey, primaryEvent);
  const prefixed = parseSessionPrefixedPrompt(normalizedText);
  const slashCommandForBot = normalizedText.startsWith('/') && (!isGroup || Boolean(threadSession) || mentioned);
  const prefixedForBot = !isGroup || Boolean(threadSession) || mentioned;
  const addressedToBot = mentioned || (Boolean(prefixed) && prefixedForBot) || slashCommandForBot;

  if (isGroup && !threadSession && !addressedToBot) {
    return;
  }

  if (isGroup && !threadSession && message.thread_id && addressedToBot) {
      await sendTextMessage(
        client,
        message.chat_id,
        '这个话题原来对应的会话已经不存在了。请发送 `/new ...` 新建会话，或者回到主面板用 `S1:` 这样的显式路由继续。'
      );
    return;
  }

  const requiresReferencedContext = normalizedText.toLowerCase().startsWith('/new');
  if (slashCommandForBot && !requiresReferencedContext) {
    if (await handleCommand(client, primaryEvent, normalizedText)) {
      return;
    }
  }

  const referencedMessage = await fetchReferencedMessage(client, primaryEvent);
  if (referencedMessage?.text) {
    console.log('[quoted-message]', {
      chatId: message.chat_id,
      messageId: message.message_id,
      referencedMessageId: referencedMessage.messageId,
      attachments: referencedMessage.attachments?.map((item) => item.path) || [],
      preview: trimPreview(referencedMessage.text, 120)
    });
  } else if (referencedMessage?.attachments?.length) {
    console.log('[quoted-message]', {
      chatId: message.chat_id,
      messageId: message.message_id,
      referencedMessageId: referencedMessage.messageId,
      attachments: referencedMessage.attachments.map((item) => item.path),
      preview: '(附件引用，无文本正文)'
    });
  }

  const attachmentMessages = await collectBatchAttachments(client, events);
  if (!normalizedText && !attachmentMessages.length && !referencedMessage?.text && !referencedMessage?.attachments?.length) {
    await sendTextMessage(client, message.chat_id, '没有解析到可处理的文本或附件内容。');
    return;
  }
  if (attachmentMessages.length) {
    console.log('[attachments]', {
      chatId: message.chat_id,
      files: attachmentMessages.map((item) => item.path),
      batchSize: events.length
    });
  }

  if (isGroup && mentioned && normalizedText.startsWith('/')) {
    if (await handleCommand(client, primaryEvent, normalizedText, { referencedMessage })) {
      return;
    }
  }

  if (await handleCommand(client, primaryEvent, normalizedText, { referencedMessage })) {
    return;
  }

  console.log('[route]', {
    chatId: chatKey,
    isGroup,
    mentioned,
    markers: threadMarkers,
    threadSession: threadSession?.alias || null,
    activeAlias: store.get(chatKey).activeAlias || null,
    batchSize: events.length
  });
  const promptSeed = prefixed ? prefixed.prompt : normalizedText;
  const quotedText = buildReferencedMessagePrompt(referencedMessage, promptSeed);
  const cleanedText = attachmentMessages.length
    ? buildAttachmentPrompt(attachmentMessages, quotedText)
    : quotedText;
  let alias;
  let prompt;

  if (prefixed) {
    if (isGroup && !threadSession && !mentioned) {
      await sendTextMessage(client, message.chat_id, formatMainPanelHint(chatKey, true), getMessageId(primaryEvent) || null);
      return;
    }
    alias = prefixed.alias;
    prompt = cleanedText;
    const targetSession = store.getSession(chatKey, alias);
    if (!targetSession) {
      await sendTextMessage(client, message.chat_id, `没有找到 ${alias}。发送 /sessions 看最近会话，或 /new 新建一个。`);
      return;
    }
  } else if (isGroup && threadSession) {
    alias = threadSession.alias;
    prompt = cleanedText;
  } else if (isGroup && mentioned) {
    if (!cleanedText.toLowerCase().startsWith('/new')) {
      await sendTextMessage(client, message.chat_id, formatGroupNewCommandHint(), getMessageId(primaryEvent) || null);
      return;
    }

    const parsed = await parseNewCommand(cleanedText);
    if (!parsed.workspace) {
      await sendTextMessage(
        client,
        message.chat_id,
        [
          '群聊里创建任务时必须指定工作目录。',
          '',
          '示例：',
          '`@机器人 /new codex /Users/xzq/project-a 帮我排查这个报错`'
        ].join('\n'),
        getMessageId(primaryEvent) || null
      );
      return;
    }

    const session = await store.createSession(chatKey);
    alias = session.alias;
    if (parsed.provider) {
      await store.updateSession(chatKey, alias, {
        provider: parsed.provider,
        sessionId: null,
        status: 'idle',
        currentTaskPreview: ''
      });
      session.provider = parsed.provider;
    }
    await store.updateSession(chatKey, alias, { workspace: parsed.workspace });
    session.workspace = parsed.workspace;
    const incomingMessageId = getMessageId(primaryEvent);
    if (incomingMessageId) {
      await store.updateSession(chatKey, alias, { rootMessageId: incomingMessageId });
      await store.registerMessageId(chatKey, alias, incomingMessageId);
    }
    const recentMessages = await fetchRecentGroupContext(client, primaryEvent, 12);
    prompt = buildGroupContextPrompt(recentMessages, parsed.prompt || '');
  } else {
    if (!threadSession) {
      await sendTextMessage(client, message.chat_id, formatMainPanelHint(chatKey, isGroup));
      return;
    }

    alias = threadSession.alias;
    prompt = cleanedText;
  }

  if (!prompt) {
    await sendTextMessage(client, message.chat_id, '没有解析到要发送给 Codex 的文本。');
    return;
  }

  void queueTurn(client, primaryEvent, prompt, alias);
}

function enqueueIncomingEvent(client, event) {
  const batchKey = getMessageBatchKey(event);
  const existing = pendingMessageBatches.get(batchKey) || {
    events: [],
    timer: null
  };
  existing.events.push(event);
  if (existing.timer) {
    clearTimeout(existing.timer);
  }
  existing.timer = setTimeout(() => {
    pendingMessageBatches.delete(batchKey);
    void processIncomingBatch(client, existing.events).catch(async (error) => {
      const message = existing.events[existing.events.length - 1]?.message;
      await logRuntime('message-handler-failed', {
        chatId: message?.chat_id || '',
        rawContent: message?.content || '',
        error: {
          message: error?.message || '未知错误',
          stack: error?.stack || ''
        }
      });
      if (message?.chat_id) {
        await sendTextMessage(client, message.chat_id, '机器人处理这条消息时出了点问题。我已经把错误记到日志里了，你可以稍后重试一次。');
      }
    });
  }, MESSAGE_BATCH_WINDOW_MS);
  existing.timer.unref?.();
  pendingMessageBatches.set(batchKey, existing);
}

async function main() {
  processLockHandle = await acquireSingleInstanceLock(config.dataDir);
  await store.init();
  await fs.mkdir(config.downloadsDir, { recursive: true });
  await scheduleDownloadCleanup();

  const client = new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret
  });

  try {
    const appInfo = await client.application.v6.application.get({
      path: {
        app_id: config.feishuAppId
      },
      params: {
        lang: 'zh_cn'
      }
    });
    const app = appInfo?.data?.app;
    const names = [
      app?.app_name,
      ...(Array.isArray(app?.i18n) ? app.i18n.map((item) => item?.name) : [])
    ]
      .map(normalizeMentionName)
      .filter(Boolean);
    names.forEach((name) => botIdentity.names.add(name));
    console.log('[bot-identity]', {
      names
    });
  } catch (error) {
    await logRuntime('bot-identity-init-failed', {
      error: error?.message || '未知错误'
    });
  }

  try {
    const botInfo = await fetchBotInfo();
    if (botInfo?.app_name) {
      botIdentity.names.add(normalizeMentionName(botInfo.app_name));
    }
    if (botInfo?.open_id) {
      botIdentity.openIds.add(normalizeMentionName(botInfo.open_id));
    }
    console.log('[bot-info]', {
      appName: botInfo?.app_name || null,
      openId: botInfo?.open_id || null
    });
  } catch (error) {
    await logRuntime('bot-info-init-failed', {
      error: error?.message || '未知错误'
    });
  }

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': (payload) => {
      void (async () => {
        try {
        const event = payload.event ?? payload;
        const message = event?.message;
        console.log('[event]', {
          type: 'im.message.receive_v1',
          chatId: message?.chat_id,
          chatType: message?.chat_type,
          messageType: message?.message_type,
          messageId: message?.message_id,
          referencedMessageId: getReferencedMessageId(event),
          rootId: message?.root_id || null,
          parentId: message?.parent_id || null,
          threadId: message?.thread_id || null,
          mentions: getMentionSummaries(event),
          senderOpenId: getSenderOpenId(event)
        });

        if (!message) {
          return;
        }

        const senderOpenId = getSenderOpenId(event);
        if (senderOpenId && botIdentity.openIds.has(normalizeMentionName(senderOpenId))) {
          return;
        }

        if (!['text', 'post', 'image', 'file'].includes(message.message_type)) {
          const chatKey = getChatKey(event);
          const isGroup = isGroupChat(event);
          const mentioned = isBotMentioned(event);
          const threadSession = resolveSessionFromThread(chatKey, event);
          if (!isGroup || mentioned || threadSession) {
            await sendTextMessage(client, message.chat_id, '当前 MVP 目前只支持文本、富文本、图片和文件消息。');
          }
          return;
        }

        const incomingMessageId = getMessageId(event);
        const chatKey = getChatKey(event);
        const claimed = await store.claimProcessedMessage(chatKey, incomingMessageId);
        if (!claimed) {
          console.log('[dedupe-skip]', {
            chatId: message.chat_id,
            messageId: incomingMessageId
          });
          return;
        }
        enqueueIncomingEvent(client, event);
        }
        catch (error) {
          const event = payload.event ?? payload;
          const message = event?.message;
          await logRuntime('message-handler-failed', {
            chatId: message?.chat_id || '',
            rawContent: message?.content || '',
            error: {
              message: error?.message || '未知错误',
              stack: error?.stack || ''
            }
          });
          if (message?.chat_id) {
            await sendTextMessage(client, message.chat_id, '机器人处理这条消息时出了点问题。我已经把错误记到日志里了，你可以稍后重试一次。');
          }
        }
      })();
    }
  });

  const wsClient = new Lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: Lark.LoggerLevel.info
  });

  wsClient.start({
    eventDispatcher: dispatcher
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    void logRuntime('unhandled-rejection', {
      reason: reason instanceof Error
        ? { message: reason.message, stack: reason.stack || '' }
        : { value: String(reason) }
    });
  });

  process.on('uncaughtException', (error) => {
    console.error('[uncaughtException]', error);
    void logRuntime('uncaught-exception', {
      error: { message: error.message, stack: error.stack || '' }
    });
  });

  process.on('SIGINT', async () => {
    await shutdown(0);
  });

  process.on('SIGTERM', async () => {
    await shutdown(0);
  });
}

async function shutdown(code = 0) {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  if (processLockHandle) {
    await processLockHandle.release().catch(() => {});
    processLockHandle = null;
  }

  process.exit(code);
}

main().catch((error) => {
  console.error(error);
  void shutdown(1);
});
