import { spawn } from 'node:child_process';
import readline from 'node:readline';

function safeTrim(text) {
  return typeof text === 'string' ? text.trim() : '';
}

function parseJsonLine(line, fallbackEvents) {
  try {
    return JSON.parse(line);
  } catch {
    fallbackEvents.push({ type: 'non_json_stdout', line });
    return null;
  }
}

function parseJsonOutput(stdout) {
  const trimmed = safeTrim(stdout);
  if (!trimmed) {
    return { output: '', sessionId: null, raw: '' };
  }
  try {
    const parsed = JSON.parse(trimmed);
    return {
      output: safeTrim(parsed.result || parsed.output || parsed.response || parsed.text || ''),
      sessionId: parsed.session_id || parsed.sessionId || parsed.conversation_id || parsed.thread_id || null,
      raw: trimmed
    };
  } catch {
    return {
      output: trimmed,
      sessionId: null,
      raw: trimmed
    };
  }
}

function summarizeActivity(text) {
  const normalized = safeTrim(text).replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }
  return normalized.length > 140 ? `${normalized.slice(0, 139)}…` : normalized;
}

function emitActivity(config, text) {
  const summary = summarizeActivity(text);
  if (!summary) {
    return;
  }
  config.onActivity?.(summary);
}

function summarizeCodexEvent(event) {
  if (!event || typeof event !== 'object') {
    return '';
  }
  if (typeof event.message === 'string' && event.message.trim()) {
    return event.message;
  }
  if (event.type === 'thread.started' && event.thread_id) {
    return `已连接会话 ${event.thread_id}`;
  }
  if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
    return event.item.text;
  }
  if (event.item?.type && typeof event.item.type === 'string') {
    return `正在处理 ${event.item.type}`;
  }
  if (typeof event.type === 'string' && event.type) {
    return `事件: ${event.type}`;
  }
  return '';
}

async function collectExit(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
}

function extractProcessErrorDetail(provider, stdout, stderr) {
  const combined = `${safeTrim(stderr)}\n${safeTrim(stdout)}`.trim();
  if (provider === 'cursor' && /press any key to sign in/i.test(combined)) {
    return 'Cursor Agent 未登录，请先在本机运行 `cursor-agent` 完成登录。';
  }
  const stdoutParsed = parseJsonOutput(stdout);
  if (stdoutParsed.output) {
    return stdoutParsed.output;
  }
  const stderrParsed = parseJsonOutput(stderr);
  if (stderrParsed.output) {
    return stderrParsed.output;
  }
  return safeTrim(stderr) || safeTrim(stdout) || '未知错误';
}

function extractCodexErrorDetail(stderr, events) {
  const stderrText = safeTrim(stderr);
  if (stderrText) {
    return stderrText;
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const candidates = [
      event?.message,
      event?.error?.message,
      event?.item?.error?.message,
      event?.item?.text
    ].filter((value) => typeof value === 'string' && value.trim());
    if (candidates.length) {
      return safeTrim(candidates[0]);
    }
  }

  return 'Codex 执行失败，但没有返回可读错误信息。';
}

function buildCodexArgs(config, sessionId, prompt, workspace) {
  const args = ['exec', '--json', '-C', workspace];
  if (config.codexSkipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }
  if (config.codexAutoApproval) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (config.codexSandbox) {
    args.push('--sandbox', config.codexSandbox);
  }
  if (config.codexModel) {
    args.push('--model', config.codexModel);
  }
  if (sessionId) {
    args.push('resume', sessionId, '--', prompt);
  } else {
    args.push('--', prompt);
  }
  return args;
}

async function runCodexTurn({ sessionId, prompt, config, workspace }) {
  const child = spawn(config.codexBin, buildCodexArgs(config, sessionId, prompt, workspace), {
    cwd: workspace,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  config.onSpawn?.(child);

  let threadId = sessionId || null;
  let lastAgentMessage = '';
  let stderr = '';
  const events = [];

  const stdoutRl = readline.createInterface({ input: child.stdout });
  stdoutRl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    const event = parseJsonLine(line, events);
    if (!event) {
      return;
    }
    events.push(event);
    emitActivity(config, summarizeCodexEvent(event));
    if (event.type === 'thread.started' && event.thread_id) {
      threadId = event.thread_id;
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      lastAgentMessage = event.item.text;
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    emitActivity(config, chunk.toString('utf8'));
  });

  const exitCode = await collectExit(child);
  stdoutRl.close();

  if (exitCode !== 0) {
    const detail = extractCodexErrorDetail(stderr, events);
    const error = new Error(detail);
    error.exitCode = exitCode;
    error.stderr = detail;
    error.rawStderr = stderr;
    error.events = events;
    throw error;
  }

  return {
    provider: 'codex',
    sessionId: threadId,
    output: safeTrim(lastAgentMessage),
    stderr,
    events
  };
}

async function runPrintAgent({ provider, bin, args, workspace, sessionId, config }) {
  const child = spawn(bin, args, {
    cwd: workspace,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  config.onSpawn?.(child);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    emitActivity(config, chunk.toString('utf8'));
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    emitActivity(config, chunk.toString('utf8'));
  });

  const exitCode = await collectExit(child);
  if (exitCode !== 0) {
    const detail = extractProcessErrorDetail(provider, stdout, stderr);
    const error = new Error(detail);
    error.exitCode = exitCode;
    error.stderr = detail;
    error.stdout = safeTrim(stdout);
    error.rawStderr = stderr;
    throw error;
  }

  const parsed = parseJsonOutput(stdout);
  return {
    provider,
    sessionId: parsed.sessionId || sessionId || null,
    output: parsed.output,
    stderr,
    events: parsed.raw ? [{ type: 'agent_json', raw: parsed.raw }] : []
  };
}

async function runTextAgent({ provider, bin, args, workspace, sessionId, config }) {
  const child = spawn(bin, args, {
    cwd: workspace,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  config.onSpawn?.(child);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    emitActivity(config, chunk.toString('utf8'));
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    emitActivity(config, chunk.toString('utf8'));
  });

  const exitCode = await collectExit(child);
  if (exitCode !== 0) {
    const detail = extractProcessErrorDetail(provider, stdout, stderr);
    const error = new Error(detail);
    error.exitCode = exitCode;
    error.stderr = detail;
    error.stdout = safeTrim(stdout);
    error.rawStderr = stderr;
    throw error;
  }

  return {
    provider,
    sessionId: sessionId || null,
    output: safeTrim(stdout),
    stderr,
    events: stdout ? [{ type: 'agent_text', raw: safeTrim(stdout) }] : []
  };
}

async function createCursorChat(config, workspace) {
  const child = spawn(config.cursorAgentBin, ['create-chat'], {
    cwd: workspace,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const exitCode = await collectExit(child);
  if (exitCode !== 0) {
    const detail = extractProcessErrorDetail('cursor', stdout, stderr);
    const error = new Error(detail);
    error.exitCode = exitCode;
    error.stderr = detail;
    error.stdout = safeTrim(stdout);
    error.rawStderr = stderr;
    throw error;
  }

  const chatId = safeTrim(stdout);
  if (!chatId) {
    throw new Error('Cursor Agent 没有返回 chat id。');
  }
  return chatId;
}

async function runClaudeTurn({ sessionId, prompt, config, workspace }) {
  const args = ['-p', '--output-format', 'json'];
  if (config.claudePermissionMode) {
    args.push('--permission-mode', config.claudePermissionMode);
  }
  if (config.claudeSettingSources) {
    args.push('--setting-sources', config.claudeSettingSources);
  }
  if (config.claudeModel) {
    args.push('--model', config.claudeModel);
  }
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  args.push(prompt);
  return runPrintAgent({ provider: 'claude', bin: config.claudeBin, args, workspace, sessionId, config });
}

async function runCursorTurn({ sessionId, prompt, config, workspace }) {
  const chatId = sessionId || await createCursorChat(config, workspace);
  const args = ['-p', '--output-format', 'text', '--force', '--resume', chatId];
  if (config.cursorModel) {
    args.push('--model', config.cursorModel);
  }
  args.push(prompt);
  return runTextAgent({ provider: 'cursor', bin: config.cursorAgentBin, args, workspace, sessionId: chatId, config });
}

async function runOpenCodeTurn({ sessionId, prompt, config, workspace }) {
  const args = ['run', '--format', 'json', '--dir', workspace];
  if (config.opencodeModel) {
    args.push('--model', config.opencodeModel);
  }
  if (sessionId) {
    args.push('--session', sessionId);
  }
  args.push(prompt);

  const child = spawn(config.opencodeBin, args, {
    cwd: workspace,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let nextSessionId = sessionId || null;
  let output = '';
  const events = [];

  const stdoutRl = readline.createInterface({ input: child.stdout });
  stdoutRl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    const event = parseJsonLine(line, events);
    if (!event) {
      return;
    }
    events.push(event);
    emitActivity(config, event.part?.text || line);
    if (event.sessionID) {
      nextSessionId = event.sessionID;
    }
    if (event.type === 'text' && typeof event.part?.text === 'string') {
      output += event.part.text;
    } else {
      stdout += `${line}\n`;
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    emitActivity(config, chunk.toString('utf8'));
  });

  const exitCode = await collectExit(child);
  stdoutRl.close();

  if (exitCode !== 0) {
    const error = new Error(`opencode exited with code ${exitCode}`);
    error.exitCode = exitCode;
    error.stderr = stderr || stdout;
    error.events = events;
    throw error;
  }

  return {
    provider: 'opencode',
    sessionId: nextSessionId,
    output: safeTrim(output),
    stderr,
    events
  };
}

export async function runAgentTurn({ provider, sessionId, prompt, config }) {
  const workspace = config.workspace || config.defaultWorkspace;
  switch ((provider || config.defaultAgentProvider || 'codex').toLowerCase()) {
    case 'claude':
      return runClaudeTurn({ sessionId, prompt, config, workspace });
    case 'cursor':
      return runCursorTurn({ sessionId, prompt, config, workspace });
    case 'opencode':
      return runOpenCodeTurn({ sessionId, prompt, config, workspace });
    case 'codex':
    default:
      return runCodexTurn({ sessionId, prompt, config, workspace });
  }
}
