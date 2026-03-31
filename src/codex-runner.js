import { spawn } from 'node:child_process';
import readline from 'node:readline';

function buildBaseArgs(config) {
  const workspace = config.workspace || config.defaultWorkspace;
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

  return args;
}

export async function runCodexTurn({ sessionId, prompt, config }) {
  const args = buildBaseArgs(config);
  const workspace = config.workspace || config.defaultWorkspace;
  if (sessionId) {
    args.push('resume', sessionId, prompt);
  } else {
    args.push(prompt);
  }

  const child = spawn(config.codexBin, args, {
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

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      events.push({ type: 'non_json_stdout', line });
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

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  stdoutRl.close();

  if (exitCode !== 0) {
    const error = new Error(`Codex exited with code ${exitCode}`);
    error.exitCode = exitCode;
    error.stderr = stderr;
    error.events = events;
    throw error;
  }

  return {
    sessionId: threadId,
    output: (lastAgentMessage || '').trim(),
    stderr,
    events
  };
}
