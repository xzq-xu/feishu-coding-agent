import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { config } from './config.js';
import { runAgentTurn } from './agent-runner.js';
import { SessionStore } from './session-store.js';
import { captureWorkspaceSnapshot, summarizeWorkspaceChanges } from './workspace-diff.js';

const store = new SessionStore(config.dataDir);
const activeJobs = new Map();
const activeProcesses = new Map();
const stopRequests = new Set();
const runtimeLogPath = path.join(config.dataDir, 'runtime.log');
const RECENT_SESSION_LIMIT = 5;

function getJobKey(chatKey, alias) {
  return `${chatKey}::${alias}`;
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
  const jobKey = getJobKey(chatKey, alias);
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
        ? session.currentTaskPreview || session.lastUserMessage || session.title
        : session.lastResultPreview || session.lastAssistantMessage || session.lastUserMessage || session.title,
      60
    );
    const workspace = session.workspace ? ` @ ${trimPreview(session.workspace, 36)}` : '';
    lines.push(`${session.alias}${activeMark} ${getStatusBadge(effectiveStatus)} [${getProviderLabel(session.provider)}] ${preview}${workspace}`);
  }
  return lines.join('\n');
}

function buildResultCard({ chatKey, alias, output, sessionId, workspace, status = 'idle', provider = 'codex', branchChange = null, commitChange = null, title = 'Agent 结果' }) {
  const record = store.get(chatKey);
  const sessions = store.listSessions(chatKey).slice(0, RECENT_SESSION_LIMIT);
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
        `**状态**: ${getStatusLabel(status)}`,
        branchChange ? `**分支变化**: ${branchChange.before} -> ${branchChange.after}` : null,
        commitChange ? `**提交变化**: ${commitChange.before.slice(0, 7)} -> ${commitChange.after.slice(0, 7)}` : null,
        `**会话 ID**: ${sessionId || '未知'}`,
        `**工作目录**: \`${workspace || config.defaultWorkspace}\``
      ].filter(Boolean).join('\n')
    }
  ];

  if (sessions.length) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: '**最近会话**'
    });

    for (const session of sessions) {
      const effectiveStatus = getEffectiveSessionStatus(chatKey, session);
      const isActive = record.activeAlias === session.alias;
      const preview = trimPreview(
        effectiveStatus === 'running'
          ? session.currentTaskPreview || session.lastUserMessage || session.title
          : session.lastResultPreview || session.lastAssistantMessage || session.lastUserMessage || session.title,
        80
      );
      const sessionWorkspace = trimPreview(session.workspace || config.defaultWorkspace, 50);
      elements.push({
        tag: 'markdown',
        content: `**${session.alias}${isActive ? ' · 当前' : ''} · ${getStatusLabel(effectiveStatus)} · ${getProviderLabel(session.provider)}**\n${preview}\n目录: \`${sessionWorkspace}\``
      });
    }
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: [
      '**快捷命令**',
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
        content: title
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
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return '';
  }
}

function getChatKey(event) {
  return event.message.chat_id;
}

function getSenderOpenId(event) {
  return event.sender?.sender_id?.open_id || '';
}

function formatHelp() {
  return [
    'Codex 飞书机器人已就绪。',
    '',
    '直接发送文本：发给当前活跃会话',
    'S1: 继续优化这个方案：把消息发给指定会话',
    '/agent：查看当前活跃会话使用的 Agent',
    '/agent claude：把当前活跃会话切到 Claude Code',
    '/agent S1 cursor：把指定会话切到 Cursor Agent',
    '/agent S1 opencode：把指定会话切到 OpenCode',
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
    '/show S1：查看某个会话最近 10 条消息',
    '/diff S1：查看某个会话最近一轮代码改动摘要',
    '/sessions：查看最近活跃的几个会话',
    '/status：查看当前聊天状态',
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
    '/help'
  ].join('\n');
}

function formatStatus(chatKey) {
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
    formatRecentSessions(chatKey)
  ].filter(Boolean).join('\n');
}

async function sendTextMessage(client, chatId, text) {
  const safeText = text.slice(0, 30000) || 'Codex 已完成，但没有返回正文。';
  console.log('[send]', { chatId, preview: safeText.slice(0, 120) });
  await client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id'
    },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: safeText })
    }
  });
}

async function sendResultCard(client, chatId, payload) {
  const card = buildResultCard(payload);
  console.log('[send-card]', { chatId, alias: payload.alias, preview: trimPreview(payload.output, 120) });
  await client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id'
    },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    }
  });
}

async function resetSession(client, event) {
  const chatKey = getChatKey(event);
  await store.resetChat(chatKey);
  await sendTextMessage(client, event.message.chat_id, '已清空当前聊天的所有会话。下一条消息会新开 S1。');
}

async function stopSessionRun(chatKey, alias) {
  const jobKey = getJobKey(chatKey, alias);
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

async function handleCommand(client, event, text) {
  const command = text.trim();
  const chatKey = getChatKey(event);

  if (command.toLowerCase() === '/help') {
    await sendTextMessage(client, event.message.chat_id, formatHelp());
    return true;
  }

  if (command.toLowerCase() === '/reset') {
    await resetSession(client, event);
    return true;
  }

  if (command.toLowerCase() === '/agent') {
    const session = await store.ensureActiveSession(chatKey);
    await sendTextMessage(
      client,
      event.message.chat_id,
      [`会话: ${session.alias}`, `当前 Agent: ${getProviderLabel(session.provider || config.defaultAgentProvider)}`].join('\n')
    );
    return true;
  }

  const agentMatch = command.match(/^\/agent(?:\s+(S\d+))?\s+(codex|claude|cursor|opencode)$/i);
  if (agentMatch) {
    const alias = agentMatch[1]?.toUpperCase() || (await store.ensureActiveSession(chatKey)).alias;
    const provider = agentMatch[2].toLowerCase();
    const session = store.getSession(chatKey, alias);
    if (!session) {
      await sendTextMessage(client, event.message.chat_id, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
      return true;
    }
    await store.updateSession(chatKey, alias, {
      provider,
      sessionId: null,
      status: 'idle',
      currentTaskPreview: ''
    });
    await sendTextMessage(
      client,
      event.message.chat_id,
      [`已将 ${alias} 切换到 ${getProviderLabel(provider)}。`, '下一条发给这个会话的消息会使用新的 Agent。'].join('\n')
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

    if (parsed.prompt) {
      await sendTextMessage(
        client,
        event.message.chat_id,
        [
          `已创建新会话 ${session.alias}。`,
          `Agent: ${getProviderLabel(session.provider || config.defaultAgentProvider)}`,
          `工作目录: ${session.workspace || config.defaultWorkspace}`,
          '你的首条指令也已收到，马上开始执行。',
          '',
          formatRecentSessions(chatKey)
        ].join('\n')
      );
      void queueTurn(client, event, parsed.prompt, session.alias);
      return true;
    }

    await sendTextMessage(
      client,
      event.message.chat_id,
      [
        `已创建新会话 ${session.alias}。`,
        `Agent: ${getProviderLabel(session.provider || config.defaultAgentProvider)}`,
        `工作目录: ${session.workspace || config.defaultWorkspace}`,
        '现在直接发送文本，默认会进入这个新会话。',
        '',
        formatRecentSessions(chatKey)
      ].join('\n')
    );
    return true;
  }

  if (command.toLowerCase() === '/cwd') {
    const session = await store.ensureActiveSession(chatKey);
    await sendTextMessage(client, event.message.chat_id, formatWorkspaceStatus(chatKey, session));
    return true;
  }

  if (command.toLowerCase() === '/stop') {
    const activeAlias = store.get(chatKey).activeAlias;
    if (!activeAlias) {
      await sendTextMessage(client, event.message.chat_id, '当前没有可停止的会话。');
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
        await sendTextMessage(client, event.message.chat_id, `${activeAlias} 没有检测到真实运行进程，已清理陈旧的运行中状态。`);
        return true;
      }
      await sendTextMessage(client, event.message.chat_id, `${activeAlias} 当前没有运行中的任务。`);
      return true;
    }
    await sendTextMessage(client, event.message.chat_id, `已请求停止 ${activeAlias}，稍后会释放这个会话。`);
    return true;
  }

  const stopMatch = command.match(/^\/stop\s+(S\d+)$/i);
  if (stopMatch) {
    const alias = stopMatch[1].toUpperCase();
    const session = store.getSession(chatKey, alias);
    if (!session) {
      await sendTextMessage(client, event.message.chat_id, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
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
        await sendTextMessage(client, event.message.chat_id, `${alias} 没有检测到真实运行进程，已清理陈旧的运行中状态。`);
        return true;
      }
      await sendTextMessage(client, event.message.chat_id, `${alias} 当前没有运行中的任务。`);
      return true;
    }
    await sendTextMessage(client, event.message.chat_id, `已请求停止 ${alias}，稍后会释放这个会话。`);
    return true;
  }

  if (command.toLowerCase() === '/delete') {
    const active = store.get(chatKey).activeAlias;
    if (!active) {
      await sendTextMessage(client, event.message.chat_id, '当前没有可删除的会话。');
      return true;
    }
    const deleted = await store.deleteSession(chatKey, active);
    await sendTextMessage(
      client,
      event.message.chat_id,
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
      await sendTextMessage(client, event.message.chat_id, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
      return true;
    }
    await sendTextMessage(
      client,
      event.message.chat_id,
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
      await sendTextMessage(client, event.message.chat_id, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
      return true;
    }

    try {
      const workspace = await resolveWorkspaceInput(cwdMatch[2]);
      await store.updateSession(chatKey, alias, { workspace });
      await sendTextMessage(
        client,
        event.message.chat_id,
        [`已更新 ${alias} 的工作目录。`, `工作目录: ${workspace}`, `之后发给 ${alias} 的消息都会在这个目录里运行。`].join('\n')
      );
    } catch (error) {
      await sendTextMessage(client, event.message.chat_id, error.message || '工作目录设置失败。');
    }
    return true;
  }

  if (command.toLowerCase() === '/status') {
    await sendTextMessage(client, event.message.chat_id, formatStatus(chatKey));
    return true;
  }

  if (command.toLowerCase() === '/sessions') {
    await sendTextMessage(client, event.message.chat_id, formatRecentSessions(chatKey));
    return true;
  }

  const showMatch = command.match(/^\/show\s+(S\d+)$/i);
  if (showMatch) {
    const alias = showMatch[1].toUpperCase();
    const session = store.getSession(chatKey, alias);
    if (!session) {
      await sendTextMessage(client, event.message.chat_id, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
      return true;
    }
    await sendTextMessage(client, event.message.chat_id, formatSessionTranscript(chatKey, session, 10));
    return true;
  }

  const diffMatch = command.match(/^\/diff(?:\s+(S\d+))?$/i);
  if (diffMatch) {
    const alias = diffMatch[1]?.toUpperCase() || store.get(chatKey).activeAlias;
    if (!alias) {
      await sendTextMessage(client, event.message.chat_id, '当前没有可查看 diff 的会话。');
      return true;
    }
    const session = store.getSession(chatKey, alias);
    if (!session) {
      await sendTextMessage(client, event.message.chat_id, `没有找到 ${alias}。发送 /sessions 看最近会话。`);
      return true;
    }
    await sendTextMessage(client, event.message.chat_id, formatDiffDetails(chatKey, session));
    return true;
  }

  const aliasOnly = parseSessionAlias(command);
  if (aliasOnly) {
    const session = store.getSession(chatKey, aliasOnly);
    if (!session) {
      await sendTextMessage(client, event.message.chat_id, `没有找到 ${aliasOnly}。发送 /sessions 看最近会话。`);
      return true;
    }
    await sendTextMessage(client, event.message.chat_id, formatSessionTranscript(chatKey, session, 10));
    return true;
  }

  if (command.startsWith('/')) {
    await sendTextMessage(client, event.message.chat_id, formatUnknownCommand(command));
    return true;
  }

  return false;
}

async function queueTurn(client, event, prompt, alias) {
  const chatKey = getChatKey(event);
  const jobKey = getJobKey(chatKey, alias);
  const prior = activeJobs.get(jobKey) || Promise.resolve();

  const next = prior
    .catch(() => {})
    .then(async () => {
      const session = await store.touchSession(chatKey, alias);
      const workspace = session?.workspace || config.defaultWorkspace;
      const provider = session?.provider || config.defaultAgentProvider;
      const opening = session?.sessionId
        ? `已收到，继续 ${alias}（${getProviderLabel(provider)}）处理中。`
        : `已收到，正在为你启动新的会话 ${alias}（${getProviderLabel(provider)}）。`;
      await sendTextMessage(client, event.message.chat_id, opening);

      await store.appendTurn(chatKey, alias, {
        role: 'user',
        text: prompt,
        createdAt: new Date().toISOString()
      });
      await store.updateSession(chatKey, alias, {
        status: 'running',
        currentTaskPreview: trimPreview(prompt, 120),
        lastStartedAt: new Date().toISOString()
      });
      const beforeSnapshot = await captureWorkspaceSnapshot(workspace);

      const result = await runAgentTurn({
        provider,
        sessionId: session?.sessionId || null,
        prompt,
        config: {
          ...config,
          workspace,
          onSpawn: (child) => {
            activeProcesses.set(jobKey, child);
          }
        }
      });
      const afterSnapshot = await captureWorkspaceSnapshot(workspace);
      const diff = await summarizeWorkspaceChanges(beforeSnapshot, afterSnapshot);

      await store.updateSession(chatKey, alias, {
        sessionId: result.sessionId,
        provider,
        status: 'idle',
        currentTaskPreview: '',
        lastResultPreview: trimPreview(result.output || 'Codex 没有返回正文。', 120),
        lastDiffSummary: diff.summary,
        lastDiffPatch: diff.patch,
        lastChangedFiles: diff.changedFiles,
        lastBranchChange: diff.branchChange,
        lastCommitChange: diff.commitChange,
        lastFinishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await store.appendTurn(chatKey, alias, {
        role: 'assistant',
        text: result.output || 'Codex 没有返回正文。',
        createdAt: new Date().toISOString()
      });

      await sendResultCard(client, event.message.chat_id, {
        chatKey,
        alias,
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
        branchChange: diff.branchChange,
        commitChange: diff.commitChange,
        title: `${getProviderLabel(provider)} 结果`
      });
    })
    .catch(async (error) => {
      const currentSession = store.getSession(chatKey, alias);
      const providerLabel = getProviderLabel(currentSession?.provider || config.defaultAgentProvider);
      if (stopRequests.has(jobKey)) {
        stopRequests.delete(jobKey);
        await store.updateSession(chatKey, alias, {
          status: 'idle',
          currentTaskPreview: '',
          lastResultPreview: '已手动停止当前任务。',
          lastFinishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }).catch(() => {});
        await store.appendTurn(chatKey, alias, {
          role: 'assistant',
          text: '当前任务已手动停止。',
          createdAt: new Date().toISOString()
        }).catch(() => {});
        return;
      }
      await logRuntime('agent-turn-failed', {
        chatKey,
        alias,
        provider: currentSession?.provider || config.defaultAgentProvider,
        workspace: currentSession?.workspace || config.defaultWorkspace,
        error: {
          message: error?.message || '未知错误',
          stderr: error?.stderr || '',
          exitCode: error?.exitCode ?? null,
          stack: error?.stack || ''
        }
      });
      await store.updateSession(chatKey, alias, {
        status: 'error',
        currentTaskPreview: '',
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
      await sendTextMessage(
        client,
        event.message.chat_id,
        [`${providerLabel} 执行失败。`, '', detail || '没有拿到更多错误信息。', '', '发送 /status 查看当前状态，或 /new 重开会话。'].join('\n')
      );
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

async function main() {
  await store.init();

  const client = new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (payload) => {
      try {
        const event = payload.event ?? payload;
        const message = event?.message;
        console.log('[event]', {
          type: 'im.message.receive_v1',
          chatId: message?.chat_id,
          messageType: message?.message_type,
          senderOpenId: getSenderOpenId(event)
        });

        if (!message) {
          return;
        }

        if (message.message_type !== 'text') {
          await sendTextMessage(client, message.chat_id, '当前 MVP 只支持文本消息。');
          return;
        }

        const senderOpenId = getSenderOpenId(event);
        if (config.feishuBotOpenId && senderOpenId === config.feishuBotOpenId) {
          return;
        }

        const text = getTextContent(message.content);
        console.log('[message]', { chatId: message.chat_id, text });
        if (!text) {
          await sendTextMessage(client, message.chat_id, '没有解析到文本内容，请直接发送文本消息。');
          return;
        }

        if (await handleCommand(client, event, text)) {
          return;
        }

        const chatKey = getChatKey(event);
        const prefixed = parseSessionPrefixedPrompt(text);
        let alias;
        let prompt;

        if (prefixed) {
          alias = prefixed.alias;
          prompt = prefixed.prompt;
          const targetSession = store.getSession(chatKey, alias);
          if (!targetSession) {
            await sendTextMessage(client, message.chat_id, `没有找到 ${alias}。发送 /sessions 看最近会话，或 /new 新建一个。`);
            return;
          }
        } else {
          const active = await store.ensureActiveSession(chatKey);
          alias = active.alias;
          prompt = text;
        }

        if (!prompt) {
          await sendTextMessage(client, message.chat_id, '没有解析到要发送给 Codex 的文本。');
          return;
        }

        void queueTurn(client, event, prompt, alias);
      } catch (error) {
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
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
