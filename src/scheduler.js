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

async function loadTasks() {
  const raw = await fs.readFile(TASKS_FILE, 'utf8');
  const data = JSON.parse(raw);
  return Array.isArray(data.tasks) ? data.tasks : [];
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

function getProviderLabel(provider) {
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

function buildSchedulerResultCard(task, output, elapsed, diff) {
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
        task.mode ? `**模式**: ${task.mode}` : null,
        `**工作目录**: \`${task.workspace}\``,
        `**执行耗时**: ${elapsed}`,
        `**调度规则**: \`${task.schedule}\``,
        `**描述**: ${task.description || '无'}`
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

function buildErrorCard(task, error, elapsed) {
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

async function runTask(task, options = {}) {
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

  if (task.mode === 'plan') {
    agentConfig.cursorMode = 'plan';
  }

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
  if (!task.reportTo) {
    console.log(`任务 [${task.id}] 没有配置 reportTo，跳过飞书推送。结果已输出到 stdout。`);
    return;
  }

  const token = await acquireFeishuToken();
  if (result.success) {
    const card = buildSchedulerResultCard(task, result.output, result.elapsed, result.diff);
    await sendFeishuMessage(token, task.reportTo, card);
  } else {
    const card = buildErrorCard(task, result.error, result.elapsed);
    await sendFeishuMessage(token, task.reportTo, card);
  }
  await appendLog(`任务 [${task.id}] 飞书推送成功 -> ${task.reportTo}`);
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
      console.log(`    ${task.description || '无描述'}`);
      console.log(`    Agent: ${getProviderLabel(task.provider)}  Schedule: ${task.schedule}`);
      console.log(`    Workspace: ${task.workspace}`);
      console.log(`    Report to: ${task.reportTo || '(仅输出到 stdout)'}`);
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

main().catch((error) => {
  console.error('调度器异常退出:', error);
  process.exit(1);
});
