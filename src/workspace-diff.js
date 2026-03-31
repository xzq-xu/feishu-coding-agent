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
  try {
    await runGit(['rev-parse', '--show-toplevel'], workspace);
  } catch {
    return {
      supported: false,
      workspace,
      changed: {}
    };
  }

  const statusOutput = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], workspace);
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
    changed
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

  if (!changedFiles.length) {
    return {
      supported: true,
      changedFiles: [],
      summary: '本轮没有检测到新的工作区改动。',
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
    patch: trimOutput(patchOutput.trim(), 12000)
  };
}
