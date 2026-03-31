import fs from 'node:fs/promises';
import path from 'node:path';

function normalizeTurns(turns) {
  if (!Array.isArray(turns)) {
    return [];
  }

  return turns
    .filter((turn) => turn && typeof turn.text === 'string' && typeof turn.role === 'string')
    .map((turn) => ({
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || new Date().toISOString()
    }));
}

function normalizeSession(alias, session) {
  const updatedAt = session?.updatedAt || new Date().toISOString();
  return {
    alias,
    sessionId: session?.sessionId || null,
    rootMessageId: session?.rootMessageId || null,
    messageIds: Array.isArray(session?.messageIds) ? session.messageIds.filter((id) => typeof id === 'string' && id) : [],
    threadIds: Array.isArray(session?.threadIds) ? session.threadIds.filter((id) => typeof id === 'string' && id) : [],
    provider: session?.provider || 'codex',
    title: session?.title || alias,
    workspace: session?.workspace || null,
    status: session?.status || 'idle',
    currentTaskPreview: session?.currentTaskPreview || '',
    lastResultPreview: session?.lastResultPreview || '',
    lastStartedAt: session?.lastStartedAt || null,
    lastFinishedAt: session?.lastFinishedAt || null,
    lastDiffSummary: session?.lastDiffSummary || '',
    lastDiffPatch: session?.lastDiffPatch || '',
    lastChangedFiles: Array.isArray(session?.lastChangedFiles) ? session.lastChangedFiles : [],
    lastBranchChange: session?.lastBranchChange || null,
    lastCommitChange: session?.lastCommitChange || null,
    lastUserMessage: session?.lastUserMessage || '',
    lastAssistantMessage: session?.lastAssistantMessage || '',
    updatedAt,
    turns: normalizeTurns(session?.turns)
  };
}

function normalizeChatRecord(chatKey, record) {
  if (!record) {
    return {
      chatKey,
      activeAlias: null,
      nextSessionNumber: 1,
      sessions: {}
    };
  }

  if (record.sessionId || record.updatedAt) {
    return {
      chatKey,
      activeAlias: 'S1',
      nextSessionNumber: 2,
      sessions: {
        S1: normalizeSession('S1', {
          sessionId: record.sessionId || null,
          title: 'S1',
          updatedAt: record.updatedAt,
          lastAssistantMessage: '',
          turns: []
        })
      }
    };
  }

  const sessions = {};
  for (const [alias, session] of Object.entries(record.sessions || {})) {
    sessions[alias] = normalizeSession(alias, session);
  }

  const nextSessionNumber = Number.isInteger(record.nextSessionNumber) && record.nextSessionNumber > 0
    ? record.nextSessionNumber
    : Object.keys(sessions).length + 1;

  return {
    chatKey,
    activeAlias: record.activeAlias && sessions[record.activeAlias] ? record.activeAlias : null,
    nextSessionNumber,
    sessions
  };
}

export class SessionStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'sessions.json');
    this.sessions = new Map();
    this.ready = false;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.sessions = new Map(
        Object.entries(parsed).map(([chatKey, record]) => [chatKey, normalizeChatRecord(chatKey, record)])
      );
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      await this.flush();
    }
    this.ready = true;
  }

  ensureReady() {
    if (!this.ready) {
      throw new Error('SessionStore.init() must be called before use');
    }
  }

  get(chatKey) {
    this.ensureReady();
    const existing = this.sessions.get(chatKey);
    if (existing) {
      return existing;
    }

    const created = normalizeChatRecord(chatKey, null);
    this.sessions.set(chatKey, created);
    return created;
  }

  listSessions(chatKey) {
    const record = this.get(chatKey);
    return Object.values(record.sessions).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  getSession(chatKey, alias) {
    const record = this.get(chatKey);
    return record.sessions[alias] || null;
  }

  findSessionByThreadMarker(chatKey, marker) {
    if (!marker) {
      return null;
    }
    const record = this.get(chatKey);
    return Object.values(record.sessions).find((session) => (
      session.rootMessageId === marker ||
      session.messageIds.includes(marker) ||
      session.threadIds.includes(marker)
    )) || null;
  }

  async registerMessageId(chatKey, alias, messageId) {
    if (!messageId) {
      return null;
    }
    const record = this.get(chatKey);
    const session = record.sessions[alias];
    if (!session) {
      throw new Error(`Unknown session alias: ${alias}`);
    }
    if (!session.messageIds.includes(messageId)) {
      session.messageIds.push(messageId);
      if (session.messageIds.length > 50) {
        session.messageIds = session.messageIds.slice(-50);
      }
      session.updatedAt = new Date().toISOString();
      await this.flush();
    }
    return session;
  }

  async registerThreadId(chatKey, alias, threadId) {
    if (!threadId) {
      return null;
    }
    const record = this.get(chatKey);
    const session = record.sessions[alias];
    if (!session) {
      throw new Error(`Unknown session alias: ${alias}`);
    }
    if (!session.threadIds.includes(threadId)) {
      session.threadIds.push(threadId);
      if (session.threadIds.length > 20) {
        session.threadIds = session.threadIds.slice(-20);
      }
      session.updatedAt = new Date().toISOString();
      await this.flush();
    }
    return session;
  }

  async createSession(chatKey) {
    const record = this.get(chatKey);
    const alias = `S${record.nextSessionNumber}`;
    const previousActive = record.activeAlias ? record.sessions[record.activeAlias] : null;
    record.nextSessionNumber += 1;
    record.activeAlias = alias;
    record.sessions[alias] = normalizeSession(alias, {
      title: alias,
      provider: previousActive?.provider || null,
      workspace: previousActive?.workspace || null,
      updatedAt: new Date().toISOString()
    });
    await this.flush();
    return record.sessions[alias];
  }

  async ensureActiveSession(chatKey) {
    const record = this.get(chatKey);
    if (record.activeAlias && record.sessions[record.activeAlias]) {
      return record.sessions[record.activeAlias];
    }
    return this.createSession(chatKey);
  }

  async touchSession(chatKey, alias) {
    const record = this.get(chatKey);
    const session = record.sessions[alias];
    if (!session) {
      return null;
    }
    session.updatedAt = new Date().toISOString();
    record.activeAlias = alias;
    await this.flush();
    return session;
  }

  async appendTurn(chatKey, alias, turn) {
    const record = this.get(chatKey);
    const session = record.sessions[alias];
    if (!session) {
      throw new Error(`Unknown session alias: ${alias}`);
    }

    session.turns.push({
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || new Date().toISOString()
    });
    if (session.turns.length > 100) {
      session.turns = session.turns.slice(-100);
    }

    if (turn.role === 'user') {
      session.lastUserMessage = turn.text;
    }
    if (turn.role === 'assistant') {
      session.lastAssistantMessage = turn.text;
    }

    session.updatedAt = turn.createdAt || new Date().toISOString();
    record.activeAlias = alias;
    await this.flush();
    return session;
  }

  async updateSession(chatKey, alias, updates) {
    const record = this.get(chatKey);
    const session = record.sessions[alias];
    if (!session) {
      throw new Error(`Unknown session alias: ${alias}`);
    }

    Object.assign(session, updates);
    session.updatedAt = updates.updatedAt || new Date().toISOString();
    record.activeAlias = alias;
    await this.flush();
    return session;
  }

  async setActiveSession(chatKey, alias) {
    const record = this.get(chatKey);
    const session = record.sessions[alias];
    if (!session) {
      return null;
    }
    record.activeAlias = alias;
    session.updatedAt = new Date().toISOString();
    await this.flush();
    return session;
  }

  async deleteSession(chatKey, alias) {
    const record = this.get(chatKey);
    if (!record.sessions[alias]) {
      return null;
    }

    const orderedEntries = Object.entries(record.sessions).sort((a, b) => {
      const aNum = Number.parseInt(a[0].slice(1), 10);
      const bNum = Number.parseInt(b[0].slice(1), 10);
      return aNum - bNum;
    });

    const remaining = orderedEntries.filter(([oldAlias]) => oldAlias !== alias);
    const aliasMap = {};
    const rebuiltSessions = {};

    for (const [index, [oldAlias, session]] of remaining.entries()) {
      const newAlias = `S${index + 1}`;
      aliasMap[oldAlias] = newAlias;
      rebuiltSessions[newAlias] = normalizeSession(newAlias, {
        ...session,
        title: newAlias
      });
    }

    let nextActiveAlias = null;
    if (record.activeAlias && aliasMap[record.activeAlias]) {
      nextActiveAlias = aliasMap[record.activeAlias];
    } else if (remaining.length > 0) {
      const fallback = remaining
        .slice()
        .sort((a, b) => new Date(b[1].updatedAt) - new Date(a[1].updatedAt))[0][0];
      nextActiveAlias = aliasMap[fallback];
    }

    record.sessions = rebuiltSessions;
    record.activeAlias = nextActiveAlias;
    record.nextSessionNumber = remaining.length + 1;
    await this.flush();

    return {
      deletedAlias: alias,
      activeAlias: nextActiveAlias,
      aliasMap
    };
  }

  async resetChat(chatKey) {
    this.ensureReady();
    this.sessions.set(chatKey, normalizeChatRecord(chatKey, null));
    await this.flush();
  }

  async flush() {
    const payload = JSON.stringify(Object.fromEntries(this.sessions), null, 2);
    await fs.writeFile(this.filePath, payload, 'utf8');
  }
}
