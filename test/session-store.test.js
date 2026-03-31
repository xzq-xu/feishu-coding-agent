import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionStore } from '../src/session-store.js';

async function createTempStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playground-session-store-'));
  const store = new SessionStore(dataDir);
  await store.init();
  return { dataDir, store };
}

test('claimProcessedMessage only accepts the first claim', async () => {
  const { dataDir, store } = await createTempStore();
  try {
    assert.equal(await store.claimProcessedMessage('chat-1', 'msg-1'), true);
    assert.equal(await store.claimProcessedMessage('chat-1', 'msg-1'), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('claimProcessedMessage is atomic across two store instances', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playground-session-store-'));
  const storeA = new SessionStore(dataDir);
  const storeB = new SessionStore(dataDir);
  await storeA.init();
  await storeB.init();

  try {
    const [resultA, resultB] = await Promise.all([
      storeA.claimProcessedMessage('chat-2', 'msg-2'),
      storeB.claimProcessedMessage('chat-2', 'msg-2')
    ]);

    assert.equal([resultA, resultB].filter(Boolean).length, 1);
    assert.equal([resultA, resultB].filter((item) => item === false).length, 1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
