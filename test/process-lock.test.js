import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireSingleInstanceLock } from '../src/process-lock.js';

test('acquireSingleInstanceLock rejects when another live pid holds the lock', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playground-lock-'));
  const lockPath = path.join(dataDir, 'feishu-coding-agent.lock');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  });

  try {
    await fs.writeFile(lockPath, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }), 'utf8');
    await assert.rejects(
      () => acquireSingleInstanceLock(dataDir),
      /already running/
    );
  } finally {
    child.kill('SIGTERM');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('acquireSingleInstanceLock cleans stale lock file and releases successfully', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playground-lock-'));
  const lockPath = path.join(dataDir, 'feishu-coding-agent.lock');

  try {
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }), 'utf8');
    const handle = await acquireSingleInstanceLock(dataDir);
    const stored = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    assert.equal(stored.pid, process.pid);

    await handle.release();
    await assert.rejects(() => fs.access(lockPath));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
