import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

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
    id: session?.id || randomUUID(),
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
      chatName: '',
      chatType: null,
      activeAlias: null,
      nextSessionNumber: 1,
      processedMessageIds: [],
      sessions: {}
    };
  }

  if (record.sessionId || record.updatedAt) {
    return {
      chatKey,
      chatName: '',
      chatType: null,
      activeAlias: 'S1',
      nextSessionNumber: 2,
      processedMessageIds: [],
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
    chatName: typeof record.chatName === 'string' ? record.chatName : '',
    chatType: typeof record.chatType === 'string' ? record.chatType : null,
    activeAlias: record.activeAlias && sessions[record.activeAlias] ? record.activeAlias : null,
    nextSessionNumber,
    processedMessageIds: Array.isArray(record.processedMessageIds)
      ? record.processedMessageIds.filter((id) => typeof id === 'string' && id).slice(-200)
      : [],
    sessions
  };
}

export class SessionStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'sessions.json');
    this.lockPath = path.join(dataDir, 'sessions.lock');
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

  listChatKeys() {
    this.ensureReady();
    return Array.from(this.sessions.keys());
  }

  listAllChats() {
    this.ensureReady();
    return Array.from(this.sessions.entries()).map(([chatKey, record]) => ({
      chatKey,
      chatName: record.chatName || '',
      chatType: record.chatType || null,
      activeAlias: record.activeAlias,
      sessions: this.listSessions(chatKey)
    }));
  }

  getChatMeta(chatKey) {
    const record = this.get(chatKey);
    return {
      chatKey,
      chatName: record.chatName || '',
      chatType: record.chatType || null
    };
  }

  async setChatMeta(chatKey, updates = {}) {
    const record = this.get(chatKey);
    if (typeof updates.chatName === 'string') {
      record.chatName = updates.chatName;
    }
    if (typeof updates.chatType === 'string') {
      record.chatType = updates.chatType;
    }
    await this.flush();
    return record;
  }

  getSession(chatKey, alias) {
    const record = this.get(chatKey);
    return record.sessions[alias] || null;
  }

  getSessionById(chatKey, id) {
    if (!id) {
      return null;
    }
    const record = this.get(chatKey);
    return Object.values(record.sessions).find((session) => session.id === id) || null;
  }

  findSessionRefById(id) {
    if (!id) {
      return null;
    }
    for (const [chatKey, record] of this.sessions.entries()) {
      for (const session of Object.values(record.sessions)) {
        if (session.id === id) {
          return {
            chatKey,
            activeAlias: record.activeAlias,
            session
          };
        }
      }
    }
    return null;
  }

  async claimProcessedMessage(chatKey, messageId) {
    if (!messageId) {
      return true;
    }

    return this.withFileLock(async () => {
      await this.reloadFromDisk();
      const record = this.get(chatKey);
      if (record.processedMessageIds.includes(messageId)) {
        return false;
      }
      record.processedMessageIds.push(messageId);
      if (record.processedMessageIds.length > 200) {
        record.processedMessageIds = record.processedMessageIds.slice(-200);
      }
      await this.flush();
      return true;
    });
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

  findAliasBySessionId(chatKey, id) {
    return this.getSessionById(chatKey, id)?.alias || null;
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

  async registerMessageIdById(chatKey, id, messageId) {
    const alias = this.findAliasBySessionId(chatKey, id);
    if (!alias) {
      return null;
    }
    return this.registerMessageId(chatKey, alias, messageId);
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

  async registerThreadIdById(chatKey, id, threadId) {
    const alias = this.findAliasBySessionId(chatKey, id);
    if (!alias) {
      return null;
    }
    return this.registerThreadId(chatKey, alias, threadId);
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

  async attachSession(chatKey, sourceSessionId) {
    const sourceRef = this.findSessionRefById(sourceSessionId);
    if (!sourceRef) {
      return null;
    }

    const existing = this.getSessionById(chatKey, sourceSessionId);
    if (existing) {
      await this.setActiveSession(chatKey, existing.alias);
      return {
        attached: existing,
        sourceRef,
        alreadyAttached: true
      };
    }

    const attached = await this.createSession(chatKey);
    await this.updateSession(chatKey, attached.alias, {
      id: sourceRef.session.id,
      sessionId: sourceRef.session.sessionId,
      provider: sourceRef.session.provider,
      workspace: sourceRef.session.workspace,
      status: sourceRef.session.status === 'running' ? 'idle' : sourceRef.session.status,
      currentTaskPreview: '',
      lastResultPreview: sourceRef.session.lastResultPreview,
      lastStartedAt: sourceRef.session.lastStartedAt,
      lastFinishedAt: sourceRef.session.lastFinishedAt,
      lastDiffSummary: sourceRef.session.lastDiffSummary,
      lastDiffPatch: sourceRef.session.lastDiffPatch,
      lastChangedFiles: sourceRef.session.lastChangedFiles,
      lastBranchChange: sourceRef.session.lastBranchChange,
      lastCommitChange: sourceRef.session.lastCommitChange,
      lastUserMessage: sourceRef.session.lastUserMessage,
      lastAssistantMessage: sourceRef.session.lastAssistantMessage,
      turns: sourceRef.session.turns.slice(-20),
      rootMessageId: null,
      messageIds: [],
      threadIds: []
    });

    return {
      attached: this.getSession(chatKey, attached.alias),
      sourceRef,
      alreadyAttached: false
    };
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

  async touchSessionById(chatKey, id) {
    const alias = this.findAliasBySessionId(chatKey, id);
    if (!alias) {
      return null;
    }
    return this.touchSession(chatKey, alias);
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

  async appendTurnById(chatKey, id, turn) {
    const alias = this.findAliasBySessionId(chatKey, id);
    if (!alias) {
      return null;
    }
    return this.appendTurn(chatKey, alias, turn);
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

  async updateSessionById(chatKey, id, updates) {
    const alias = this.findAliasBySessionId(chatKey, id);
    if (!alias) {
      return null;
    }
    return this.updateSession(chatKey, alias, updates);
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

  async resetAllChats() {
    this.ensureReady();
    this.sessions = new Map();
    await this.flush();
  }

  async reloadFromDisk() {
    this.ensureReady();
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
      this.sessions = new Map();
    }
  }

  async withFileLock(action, options = {}) {
    this.ensureReady();
    const retryDelayMs = options.retryDelayMs ?? 25;
    const maxAttempts = options.maxAttempts ?? 200;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let handle = null;
      try {
        handle = await fs.open(this.lockPath, 'wx');
        const result = await action();
        await handle.close();
        await fs.unlink(this.lockPath).catch(() => {});
        return result;
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => {});
          await fs.unlink(this.lockPath).catch(() => {});
        }
        if (error?.code !== 'EEXIST') {
          throw error;
        }
        await sleep(retryDelayMs);
      }
    }

    throw new Error(`Failed to acquire session store lock: ${this.lockPath}`);
  }

  async flush() {
    const payload = JSON.stringify(Object.fromEntries(this.sessions), null, 2);
    await fs.writeFile(this.filePath, payload, 'utf8');
  }
}
