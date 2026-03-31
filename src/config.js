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

function readNumber(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  feishuAppId: readRequired('FEISHU_APP_ID'),
  feishuAppSecret: readRequired('FEISHU_APP_SECRET'),
  feishuBotOpenId: process.env.FEISHU_BOT_OPEN_ID || '',
  defaultAgentProvider: (process.env.AGENT_PROVIDER || 'codex').toLowerCase(),
  codexBin: process.env.CODEX_BIN || 'codex',
  defaultWorkspace: path.resolve(process.env.CODEX_WORKSPACE || process.cwd()),
  codexModel: process.env.CODEX_MODEL || '',
  codexSandbox: process.env.CODEX_SANDBOX || 'workspace-write',
  codexAutoApproval: readBoolean('CODEX_AUTO_APPROVAL', true),
  codexSkipGitRepoCheck: readBoolean('CODEX_SKIP_GIT_REPO_CHECK', true),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  claudeModel: process.env.CLAUDE_MODEL || '',
  claudePermissionMode: process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions',
  claudeSettingSources: process.env.CLAUDE_SETTING_SOURCES || '',
  cursorAgentBin: process.env.CURSOR_AGENT_BIN || 'cursor-agent',
  cursorModel: process.env.CURSOR_MODEL || '',
  opencodeBin: process.env.OPENCODE_BIN || 'opencode',
  opencodeModel: process.env.OPENCODE_MODEL || '',
  botLocale: process.env.BOT_LOCALE || 'zh-CN',
  dataDir: path.resolve(process.cwd(), 'data'),
  downloadsDir: path.resolve(process.cwd(), 'data', 'downloads'),
  downloadsTtlHours: readNumber('DOWNLOAD_TTL_HOURS', 72),
  downloadsMaxBytes: readNumber('DOWNLOAD_MAX_BYTES', 1024 * 1024 * 1024)
};
