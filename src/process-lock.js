import fs from 'node:fs/promises';
import path from 'node:path';

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLockFile(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function acquireSingleInstanceLock(dataDir, name = 'feishu-coding-agent') {
  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, `${name}.lock`);
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString()
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(payload, 'utf8');
      await handle.close();

      let released = false;
      return {
        lockPath,
        async release() {
          if (released) {
            return;
          }
          released = true;
          await fs.unlink(lockPath).catch(() => {});
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const current = await readLockFile(lockPath);
      if (current?.pid && isProcessAlive(current.pid) && current.pid !== process.pid) {
        throw new Error(`Another feishu-coding-agent instance is already running (pid=${current.pid})`);
      }

      await fs.unlink(lockPath).catch(() => {});
    }
  }

  throw new Error('Failed to acquire single instance lock');
}
