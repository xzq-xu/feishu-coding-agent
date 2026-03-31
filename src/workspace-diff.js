import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function trimOutput(text, max = 8000) {
  if (!text) {
    return '';
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 * 8 });
  return stdout;
}

async function runGitSafe(args, cwd) {
  try {
    return (await runGit(args, cwd)).trim();
  } catch {
    return '';
  }
}

async function computeFileHash(filePath) {
  const data = await fs.readFile(filePath);
  return createHash('sha1').update(data).digest('hex');
}

function parsePorcelainLine(line) {
  if (!line.trim()) {
    return null;
  }

  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const pathText = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) : rawPath;
  return {
    status,
    path: pathText
  };
}

export async function captureWorkspaceSnapshot(workspace) {
  const topLevel = await runGitSafe(['rev-parse', '--show-toplevel'], workspace);
  if (!topLevel) {
    return {
      supported: false,
      workspace,
      topLevel: '',
      branch: '',
      head: '',
      changed: {}
    };
  }

  const statusOutput = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], workspace);
  const branch = await runGitSafe(['branch', '--show-current'], workspace);
  const head = await runGitSafe(['rev-parse', 'HEAD'], workspace);
  const entries = statusOutput
    .split('\n')
    .map(parsePorcelainLine)
    .filter(Boolean);

  const changed = {};
  for (const entry of entries) {
    const absolutePath = path.join(workspace, entry.path);
    const exists = await fs.stat(absolutePath).then(() => true).catch(() => false);
    changed[entry.path] = {
      status: entry.status,
      exists,
      hash: exists ? await computeFileHash(absolutePath) : null
    };
  }

  return {
    supported: true,
    workspace,
    topLevel,
    branch,
    head,
    changed
  };
}

function diffWorkingTree(before, after) {
  const allPaths = new Set([
    ...Object.keys(before.changed || {}),
    ...Object.keys(after.changed || {})
  ]);

  const changedFiles = [];
  for (const filePath of allPaths) {
    const prev = before.changed[filePath] || null;
    const next = after.changed[filePath] || null;
    if (!prev && next) {
      changedFiles.push(filePath);
      continue;
    }
    if (prev && !next) {
      changedFiles.push(filePath);
      continue;
    }
    if (!prev || !next) {
      continue;
    }
    if (prev.status !== next.status || prev.hash !== next.hash || prev.exists !== next.exists) {
      changedFiles.push(filePath);
    }
  }

  return changedFiles;
}

async function summarizeCommittedChanges(before, after) {
  if (!before.head || !after.head || before.head === after.head) {
    return null;
  }

  const changedFilesOutput = await runGitSafe(['diff', '--name-only', before.head, after.head], after.workspace);
  const changedFiles = changedFilesOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const statOutput = await runGitSafe(['diff', '--stat', before.head, after.head], after.workspace);
  const patchOutput = await runGitSafe(['diff', before.head, after.head], after.workspace);

  const summaryLines = ['本轮代码改动:'];
  if (before.branch !== after.branch) {
    summaryLines.push(`- 分支: ${before.branch || '(detached)'} -> ${after.branch || '(detached)'}`);
  }
  summaryLines.push(`- 提交: ${before.head.slice(0, 7)} -> ${after.head.slice(0, 7)}`);

  const fileLines = changedFiles.slice(0, 8).map((filePath) => `- ${filePath}`);
  const extraCount = changedFiles.length - fileLines.length;
  if (changedFiles.length) {
    summaryLines.push(...fileLines);
    if (extraCount > 0) {
      summaryLines.push(`- 另有 ${extraCount} 个文件`);
    }
  } else {
    summaryLines.push('- 提交点发生了变化，但净代码差异为空。');
  }

  if (statOutput) {
    summaryLines.push('');
    summaryLines.push(trimOutput(statOutput, 1200));
  }

  return {
    supported: true,
    changedFiles,
    summary: summaryLines.join('\n'),
    patch: trimOutput(patchOutput, 12000),
    branchChange: before.branch !== after.branch
      ? {
          before: before.branch || '(detached)',
          after: after.branch || '(detached)'
        }
      : null,
    commitChange: {
      before: before.head,
      after: after.head
    }
  };
}

export async function summarizeWorkspaceChanges(before, after) {
  if (!before?.supported || !after?.supported) {
    return {
      supported: false,
      changedFiles: [],
      summary: '当前工作目录不是 git 仓库，无法生成代码改动摘要。',
      patch: ''
    };
  }

  const committed = await summarizeCommittedChanges(before, after);
  if (committed) {
    return committed;
  }

  const changedFiles = diffWorkingTree(before, after);
  if (!changedFiles.length) {
    return {
      supported: true,
      changedFiles: [],
      summary: '本轮没有检测到新的提交差异或新的工作区改动。',
      patch: ''
    };
  }

  let statOutput = '';
  let patchOutput = '';
  try {
    statOutput = await runGit(['diff', '--stat', '--', ...changedFiles], after.workspace);
  } catch {
    statOutput = '';
  }

  try {
    patchOutput = await runGit(['diff', '--', ...changedFiles], after.workspace);
  } catch {
    patchOutput = '';
  }

  const fileLines = changedFiles.slice(0, 8).map((filePath) => `- ${filePath}`);
  const extraCount = changedFiles.length - fileLines.length;
  if (extraCount > 0) {
    fileLines.push(`- 另有 ${extraCount} 个文件`);
  }

  const summaryLines = ['本轮代码改动:'];
  summaryLines.push(...fileLines);
  if (statOutput.trim()) {
    summaryLines.push('');
    summaryLines.push(trimOutput(statOutput.trim(), 1200));
  }

  return {
    supported: true,
    changedFiles,
    summary: summaryLines.join('\n'),
    patch: trimOutput(patchOutput.trim(), 12000),
    branchChange: null,
    commitChange: {
      before: before.head,
      after: after.head
    }
  };
}
