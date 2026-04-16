import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { config } from './config.js';
import { runAgentTurn } from './agent-runner.js';
import { captureWorkspaceSnapshot, summarizeWorkspaceChanges } from './workspace-diff.js';

const TASKS_FILE = path.resolve(config.dataDir, 'scheduled-tasks.json');
const LOG_FILE = path.resolve(config.dataDir, 'scheduler.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { taskIds: [], all: false, dryRun: false, list: false };

  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--task':
        if (args[i + 1]) {
          result.taskIds.push(args[i + 1]);
          i += 1;
        }
        break;
      case '--all':
        result.all = true;
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--list':
        result.list = true;
        break;
    }
  }
  return result;
}

export async function loadTasks() {
  const raw = await fs.readFile(TASKS_FILE, 'utf8');
  const data = JSON.parse(raw);
  return Array.isArray(data.tasks) ? data.tasks : [];
}

export async function saveTasks(tasks) {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(TASKS_FILE, JSON.stringify({ tasks }, null, 2) + '\n', 'utf8');
}

async function appendLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    const stat = await fs.stat(LOG_FILE).catch(() => null);
    if (stat && stat.size > MAX_LOG_BYTES) {
      const content = await fs.readFile(LOG_FILE, 'utf8');
      await fs.writeFile(LOG_FILE, content.slice(-MAX_LOG_BYTES / 2), 'utf8');
    }
    await fs.appendFile(LOG_FILE, line, 'utf8');
  } catch {
    process.stderr.write(line);
  }
}

async function acquireFeishuToken() {
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      app_id: config.feishuAppId,
      app_secret: config.feishuAppSecret
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.code !== 0 || !payload?.tenant_access_token) {
    throw new Error(`飞书 token 获取失败: ${payload?.msg || response.status}`);
  }
  return payload.tenant_access_token;
}

async function sendFeishuMessage(token, chatId, card) {
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.code !== 0) {
    throw new Error(`飞书消息发送失败: ${payload?.msg || response.status}`);
  }
  return payload;
}

async function sendFeishuText(token, chatId, text) {
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text })
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.code !== 0) {
    throw new Error(`飞书消息发送失败: ${payload?.msg || response.status}`);
  }
  return payload;
}

function matchCronField(field, value) {
  for (const segment of field.split(',')) {
    const stepMatch = segment.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10);
      if (stepMatch[1] === '*') {
        if (value % step === 0) return true;
      } else {
        const base = parseInt(stepMatch[1], 10);
        if (value >= base && (value - base) % step === 0) return true;
      }
      continue;
    }
    if (segment === '*') return true;
    const rangeMatch = segment.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1], 10);
      const to = parseInt(rangeMatch[2], 10);
      if (value >= from && value <= to) return true;
      continue;
    }
    if (parseInt(segment, 10) === value) return true;
  }
  return false;
}

export function cronMatchesNow(cronExpr, now = new Date()) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const minute = now.getMinutes();
  const hour = now.getHours();
  const dayOfMonth = now.getDate();
  const month = now.getMonth() + 1;
  const dayOfWeek = now.getDay();

  const dowMatch = matchCronField(parts[4], dayOfWeek)
    || (dayOfWeek === 0 && matchCronField(parts[4], 7));

  return (
    matchCronField(parts[0], minute) &&
    matchCronField(parts[1], hour) &&
    matchCronField(parts[2], dayOfMonth) &&
    matchCronField(parts[3], month) &&
    dowMatch
  );
}

const runningTasks = new Set();

export function startHeartbeat({ onTaskResult, intervalMs = 60_000 } = {}) {
  let lastCheckMinute = -1;

  const timer = setInterval(async () => {
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    if (currentMinute === lastCheckMinute) return;
    lastCheckMinute = currentMinute;

    let tasks;
    try {
      tasks = await loadTasks();
    } catch {
      return;
    }

    for (const task of tasks) {
      if (!task.enabled || !task.schedule) continue;
      if (runningTasks.has(task.id)) continue;
      if (!cronMatchesNow(task.schedule, now)) continue;

      runningTasks.add(task.id);
      await appendLog(`[heartbeat] 触发任务 [${task.id}]`);

      (async () => {
        const startMs = Date.now();
        let result;
        try {
          result = await runTask(task);
        } catch (error) {
          result = { success: false, error, elapsed: formatElapsed(startMs), output: null, diff: null };
        }

        try {
          await reportToFeishu(task, result);
        } catch (error) {
          await appendLog(`[heartbeat] 任务 [${task.id}] 飞书推送失败: ${error.message}`);
        }

        if (onTaskResult) {
          try { onTaskResult(task, result); } catch { /* ignore */ }
        }

        await appendLog(`[heartbeat] 任务 [${task.id}] 完成 elapsed=${result.elapsed}`);
      })().catch((error) => {
        appendLog(`[heartbeat] 任务 [${task.id}] 异常: ${error.message}`).catch(() => {});
      }).finally(() => {
        runningTasks.delete(task.id);
      });
    }
  }, intervalMs);

  timer.unref?.();
  appendLog('[heartbeat] 调度引擎已启动').catch(() => {});
  return timer;
}

export function getProviderLabel(provider) {
  switch ((provider || '').toLowerCase()) {
    case 'claude': return 'Claude Code';
    case 'cursor': return 'Cursor Agent';
    case 'opencode': return 'OpenCode';
    case 'codex':
    default: return 'Codex';
  }
}

function formatElapsed(startMs) {
  const seconds = Math.floor((Date.now() - startMs) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes <= 0) return `${remainingSeconds} 秒`;
  return `${minutes} 分 ${remainingSeconds} 秒`;
}

export function buildSchedulerResultCard(task, output, elapsed, diff) {
  const elements = [
    {
      tag: 'markdown',
      content: output || 'Agent 没有返回正文。'
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: [
        `**任务 ID**: ${task.id}`,
        `**Agent**: ${getProviderLabel(task.provider)}`,
        `**工作目录**: \`${task.workspace}\``,
        `**执行耗时**: ${elapsed}`,
        `**调度规则**: \`${task.schedule}\``,
        `**指令**: ${(task.prompt || '').slice(0, 100)}${(task.prompt || '').length > 100 ? '...' : ''}`
      ].filter(Boolean).join('\n')
    }
  ];

  if (diff?.summary) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**代码变更摘要**\n${diff.summary}`
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: {
        tag: 'plain_text',
        content: `⏰ 定时任务结果 · ${task.id}`
      }
    },
    elements
  };
}

export function buildErrorCard(task, error, elapsed) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'red',
      title: {
        tag: 'plain_text',
        content: `⏰ 定时任务失败 · ${task.id}`
      }
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**错误**: ${error.message || '未知错误'}`,
          error.stderr ? `\n**stderr**:\n${String(error.stderr).slice(0, 3000)}` : null
        ].filter(Boolean).join('\n')
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: [
          `**任务 ID**: ${task.id}`,
          `**Agent**: ${getProviderLabel(task.provider)}`,
          `**工作目录**: \`${task.workspace}\``,
          `**执行耗时**: ${elapsed}`,
          `**调度规则**: \`${task.schedule}\``
        ].join('\n')
      }
    ]
  };
}

export async function runTask(task, options = {}) {
  const { dryRun = false } = options;
  const startMs = Date.now();
  const provider = task.provider || config.defaultAgentProvider;
  const workspace = task.workspace || config.defaultWorkspace;

  await appendLog(`开始执行任务 [${task.id}] provider=${provider} workspace=${workspace}`);

  if (dryRun) {
    const output = `[dry-run] 任务 ${task.id} 将使用 ${getProviderLabel(provider)} 在 ${workspace} 执行:\n${task.prompt}`;
    console.log(output);
    await appendLog(`[dry-run] 任务 [${task.id}] 模拟完成`);
    return { success: true, output, diff: null, elapsed: formatElapsed(startMs) };
  }

  const agentConfig = {
    ...config,
    workspace
  };

  const beforeSnapshot = await captureWorkspaceSnapshot(workspace);

  const result = await runAgentTurn({
    provider,
    sessionId: null,
    prompt: task.prompt,
    config: agentConfig
  });

  const afterSnapshot = await captureWorkspaceSnapshot(workspace);
  const diff = await summarizeWorkspaceChanges(beforeSnapshot, afterSnapshot);
  const elapsed = formatElapsed(startMs);

  await appendLog(`任务 [${task.id}] 完成 elapsed=${elapsed} output_length=${(result.output || '').length}`);

  return { success: true, output: result.output, diff, elapsed };
}

async function reportToFeishu(task, result) {
  const chatId = task.reportTo || config.defaultReportChatId;
  if (!chatId) {
    console.log(`任务 [${task.id}] 没有配置 reportTo 且无默认聊天 ID，跳过飞书推送。`);
    return;
  }

  const token = await acquireFeishuToken();
  if (result.success) {
    const card = buildSchedulerResultCard(task, result.output, result.elapsed, result.diff);
    await sendFeishuMessage(token, chatId, card);
  } else {
    const card = buildErrorCard(task, result.error, result.elapsed);
    await sendFeishuMessage(token, chatId, card);
  }
  await appendLog(`任务 [${task.id}] 飞书推送成功 -> ${chatId}`);
}

async function main() {
  const args = parseArgs(process.argv);

  let tasks;
  try {
    tasks = await loadTasks();
  } catch (error) {
    console.error(`无法读取任务定义 ${TASKS_FILE}: ${error.message}`);
    console.error('请复制 data/scheduled-tasks.example.json 为 data/scheduled-tasks.json 并配置你的任务。');
    process.exit(1);
  }

  if (args.list) {
    console.log(`共 ${tasks.length} 个任务:\n`);
    for (const task of tasks) {
      const status = task.enabled ? '✓ 已启用' : '✗ 已禁用';
      console.log(`  [${task.id}] ${status}`);
      console.log(`    调度:     ${task.schedule}`);
      console.log(`    Agent:    ${getProviderLabel(task.provider)}`);
      console.log(`    目录:     ${task.workspace}`);
      console.log(`    指令:     ${(task.prompt || '').slice(0, 80)}${(task.prompt || '').length > 80 ? '...' : ''}`);
      console.log(`    推送到:   ${task.reportTo || '(使用 DEFAULT_REPORT_CHAT_ID 或仅 stdout)'}`);
      console.log('');
    }
    return;
  }

  let selectedTasks;
  if (args.taskIds.length > 0) {
    selectedTasks = tasks.filter((t) => args.taskIds.includes(t.id));
    const missing = args.taskIds.filter((id) => !tasks.some((t) => t.id === id));
    if (missing.length) {
      console.error(`未找到任务: ${missing.join(', ')}`);
      console.error(`可用任务: ${tasks.map((t) => t.id).join(', ')}`);
      process.exit(1);
    }
  } else if (args.all) {
    selectedTasks = tasks.filter((t) => t.enabled);
  } else {
    console.log('用法:');
    console.log('  node src/scheduler.js --task <id>      执行指定任务');
    console.log('  node src/scheduler.js --all             执行所有已启用任务');
    console.log('  node src/scheduler.js --list            列出所有任务');
    console.log('  node src/scheduler.js --dry-run --all   模拟执行（不实际调用 Agent）');
    console.log('');
    console.log('任务定义在 data/scheduled-tasks.json 中，字段说明:');
    console.log('  schedule   [必填] 执行频率（通过 /cron add 创建时自动从简写生成）');
    console.log('  workspace  [必填] Agent 执行的项目目录绝对路径');
    console.log('  prompt     [必填] 发给 Agent 的指令内容');
    console.log('  provider   [可选] Agent 类型: cursor/codex/claude/opencode（默认跟随 AGENT_PROVIDER）');
    console.log('  id         [可选] 任务唯一标识（通过 /cron add 创建时自动生成）');
    console.log('  enabled    [可选] 是否启用（默认 true）');
    console.log('  reportTo   [可选] 飞书聊天 ID，结果推送目标（留空使用 DEFAULT_REPORT_CHAT_ID）');
    return;
  }

  if (!selectedTasks.length) {
    console.log('没有匹配到要执行的任务。');
    return;
  }

  await appendLog(`调度器启动，共 ${selectedTasks.length} 个任务待执行`);

  for (const task of selectedTasks) {
    const startMs = Date.now();
    let result;

    try {
      result = await runTask(task, { dryRun: args.dryRun });
      console.log(`\n[${task.id}] ✓ 完成 (${result.elapsed})`);
      if (result.output) {
        console.log(result.output.slice(0, 2000));
      }
    } catch (error) {
      result = {
        success: false,
        error,
        elapsed: formatElapsed(startMs),
        output: null,
        diff: null
      };
      console.error(`\n[${task.id}] ✗ 失败 (${result.elapsed}): ${error.message}`);
      await appendLog(`任务 [${task.id}] 失败: ${error.message}`);
    }

    if (!args.dryRun) {
      try {
        await reportToFeishu(task, result);
      } catch (error) {
        console.error(`[${task.id}] 飞书推送失败: ${error.message}`);
        await appendLog(`任务 [${task.id}] 飞书推送失败: ${error.message}`);
      }
    }
  }

  await appendLog('调度器本轮执行完成');
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isDirectRun) {
  main().catch((error) => {
    console.error('调度器异常退出:', error);
    process.exit(1);
  });
}
