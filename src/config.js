import path from 'node:path';
import process from 'node:process';

import dotenv from 'dotenv';

dotenv.config();

function readRequired(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export const config = {
  feishuAppId: readRequired('FEISHU_APP_ID'),
  feishuAppSecret: readRequired('FEISHU_APP_SECRET'),
  feishuBotOpenId: process.env.FEISHU_BOT_OPEN_ID || '',
  codexBin: process.env.CODEX_BIN || 'codex',
  defaultWorkspace: path.resolve(process.env.CODEX_WORKSPACE || process.cwd()),
  codexModel: process.env.CODEX_MODEL || '',
  codexSandbox: process.env.CODEX_SANDBOX || 'workspace-write',
  codexAutoApproval: readBoolean('CODEX_AUTO_APPROVAL', true),
  codexSkipGitRepoCheck: readBoolean('CODEX_SKIP_GIT_REPO_CHECK', true),
  botLocale: process.env.BOT_LOCALE || 'zh-CN',
  dataDir: path.resolve(process.cwd(), 'data')
};
