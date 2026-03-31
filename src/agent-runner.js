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

async function collectExit(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
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
    args.push('resume', sessionId, prompt);
  } else {
    args.push(prompt);
  }
  return args;
}

async function runCodexTurn({ sessionId, prompt, config, workspace }) {
  const child = spawn(config.codexBin, buildCodexArgs(config, sessionId, prompt, workspace), {
    cwd: workspace,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

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
    if (event.type === 'thread.started' && event.thread_id) {
      threadId = event.thread_id;
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      lastAgentMessage = event.item.text;
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const exitCode = await collectExit(child);
  stdoutRl.close();

  if (exitCode !== 0) {
    const error = new Error(`Codex exited with code ${exitCode}`);
    error.exitCode = exitCode;
    error.stderr = stderr;
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

async function runPrintAgent({ provider, bin, args, workspace, sessionId }) {
  const child = spawn(bin, args, {
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
    const error = new Error(`${provider} exited with code ${exitCode}`);
    error.exitCode = exitCode;
    error.stderr = stderr || stdout;
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

async function runClaudeTurn({ sessionId, prompt, config, workspace }) {
  const args = ['-p', '--output-format', 'json'];
  if (config.claudePermissionMode) {
    args.push('--permission-mode', config.claudePermissionMode);
  }
  if (config.claudeModel) {
    args.push('--model', config.claudeModel);
  }
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  args.push(prompt);
  return runPrintAgent({ provider: 'claude', bin: config.claudeBin, args, workspace, sessionId });
}

async function runCursorTurn({ sessionId, prompt, config, workspace }) {
  const args = ['-p', '--output-format', 'json'];
  if (config.cursorModel) {
    args.push('--model', config.cursorModel);
  }
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  args.push(prompt);
  return runPrintAgent({ provider: 'cursor', bin: config.cursorAgentBin, args, workspace, sessionId });
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
