"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { serviceError } = require("./security");
const { canonicalWorkspace } = require("./work-run");
const { CodexDesktopSessionStore, desktopSessionKey, isDesktopBinding } = require("./codex-desktop-session-store");
const { createCodexChatHistoryMapper, fragmentCodexChatHistoryMessage } = require("./codex-chat-history");
const { transcriptHistoryItem } = require("./chat-service-controller");
const { adaptCodexChatHistoryPage } = require("./chat-history-adapter");
const { validateChatServiceResult } = require("./chat-service-protocol");
const { MESSAGES } = require("./codex-desktop-session-protocol");
const { readCodexHistoryTurns, readCodexHistoryItems } = require("./codex-thread-history-reader");
const { transcriptEventId } = require("./transcript-store");
const { attachmentPrompt } = require("./chat-attachments");
const { CodexDesktopWriterObserver } = require("./codex-desktop-writer-state");

const fail = code => { throw serviceError(code, MESSAGES[code]); };
const clip = (value, limit) => {
  if (typeof value !== "string" || !value.trim()) return null;
  let result = "", bytes = 0;
  for (const char of value.replace(/\0/gu, "").toWellFormed()) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) break;
    result += char; bytes += size;
  }
  return result || null;
};
class CodexDesktopSessionController {
  constructor({ automations, productStore, sessions, transcripts, contextSnapshots, checkpoints, ownership, adapter, schemaContract, cursorSecret = crypto.randomBytes(32), databaseFactory, now = Date.now, writerObserver = new CodexDesktopWriterObserver({ now }) }) {
    Object.assign(this, { automations, productStore, sessions, transcripts, contextSnapshots, checkpoints, ownership, adapter, schemaContract, cursorSecret, databaseFactory, now });
    this.writerObserver = writerObserver;
    this.stores = new Map();
    this.historySnapshots = new Map();
  }
  owner(profileId = null, homeIdentity = null) {
    let owner;
    try { owner = this.automations.owner(profileId); } catch { fail("CODEX_DESKTOP_OWNER_UNAVAILABLE"); }
    const home = owner.store.home;
    if (!this.stores.has(home)) this.stores.set(home, new CodexDesktopSessionStore({ home, databaseFactory: this.databaseFactory }));
    const store = this.stores.get(home);
    if (homeIdentity !== null && store.homeIdentity !== homeIdentity) fail("CODEX_DESKTOP_NOT_FOUND");
    const bindingId = owner.profile.selectedBindingId || this.productStore.getAgentRuntimeBindings(owner.profile.id).defaultBindingId;
    return { ...owner, store, bindingId };
  }
  origin(sessionKey) { return isDesktopBinding(this.sessions.getBinding(sessionKey)) ? { source: "codex-desktop" } : {}; }
  project(row, owner, writer = null) {
    const sessionKey = desktopSessionKey(owner.store.homeIdentity, owner.profile.id, row.id);
    const existing = this.sessions.getSession(sessionKey);
    if (existing && (existing.profileId !== owner.profile.id || existing.runtimeSessionId !== row.id)) fail("CODEX_DESKTOP_NOT_FOUND");
    return { session: { ...(existing || {
      id: sessionKey, sessionKey, profileId: owner.profile.id, runtimeSessionId: row.id, workspace: row.cwd,
      modelOverride: clip(row.model, 512), permissionMode: null, status: "ready", runtimeBindingId: owner.bindingId,
      retiredRuntimeSessions: [], revision: 1,
      modelSettings: { thinkingLevel: clip(row.reasoning_effort, 32), serviceTier: null },
    }), title: clip(row.name || row.title, 512), derivedTitle: null,
    createdAt: row.createdAt, updatedAt: row.updatedAt, source: "codex-desktop",
    ...(writer ? { codexDesktopWriter: writer } : {}) }, threadId: row.id, homeIdentity: owner.store.homeIdentity };
  }
  cursor(owner, row) {
    const body = Buffer.from(JSON.stringify([owner.store.homeIdentity, owner.profile.id, row.updatedAt, row.id])).toString("base64url");
    return `${body}.${crypto.createHmac("sha256", this.cursorSecret).update(body).digest("base64url")}`;
  }
  after(cursor, owner) {
    if (cursor === null) return null;
    try {
      const [body, mac, extra] = cursor.split(".");
      if (extra || !mac || crypto.createHmac("sha256", this.cursorSecret).update(body).digest("base64url") !== mac) throw new Error();
      const [home, profileId, updatedAt, id] = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (home !== owner.store.homeIdentity || profileId !== owner.profile.id || !Number.isSafeInteger(updatedAt) || updatedAt < 0 || !require("./codex-desktop-session-store").UUID.test(id)) throw new Error();
      return { updatedAt, id };
    } catch { fail("CODEX_DESKTOP_PARAMS_INVALID"); }
  }
  async list(params) {
    try {
      const owner = this.owner();
      if (params.backendId !== owner.profile.backendId) return { sessions: [], available: true, reason: null, nextCursor: null, hasMore: false };
      const rows = owner.store.readRows({ after: this.after(params.cursor, owner), limit: params.limit + 1 });
      const writers = await this.writerObserver.observe(owner.store.home, rows.slice(0, params.limit).map(row => row.id));
      const known = this.sessions.listSessions().filter(session => !isDesktopBinding(this.sessions.getBinding(session.sessionKey)));
      const output = [];
      let last = null, index = 0;
      for (; index < Math.min(rows.length, params.limit); index++) {
        const row = rows[index];
        if (!known.some(session => session.runtimeSessionId === row.id)) {
          const entry = this.project(row, owner, writers.get(row.id));
          if (Buffer.byteLength(JSON.stringify([...output, entry])) > 48 * 1024) break;
          output.push(entry);
        }
        last = row;
      }
      const hasMore = index < rows.length;
      return { sessions: output, available: true, reason: null, nextCursor: hasMore && last ? this.cursor(owner, last) : null, hasMore: hasMore && !!last };
    } catch (error) {
      if (error.code === "CODEX_DESKTOP_PARAMS_INVALID") throw error;
      return { sessions: [], available: false, reason: Object.hasOwn(MESSAGES, error?.code) ? error.code : "CODEX_DESKTOP_UNAVAILABLE", nextCursor: null, hasMore: false };
    }
  }
  target(params) {
    const owner = this.owner(params.profileId, params.homeIdentity), row = owner.store.get(params.threadId);
    return { ...owner, row, sessionKey: desktopSessionKey(owner.store.homeIdentity, owner.profile.id, row.id) };
  }
  async readNative(target) {
    const handle = await this.adapter.acquire(target.binding);
    const host = handle.host || handle;
    const response = await host.threadRead({ threadId: target.row.id, includeTurns: false });
    if (response?.thread?.id !== target.row.id || response.thread.threadSource?.startsWith("shoggoth:")) fail("CODEX_DESKTOP_NOT_FOUND");
    if (typeof response.thread.cwd !== "string" || path.resolve(response.thread.cwd) !== path.resolve(target.row.cwd)) fail("CODEX_DESKTOP_UNAVAILABLE");
    const current = this.owner(target.profile.id, target.store.homeIdentity);
    if (current.bindingId !== target.bindingId) fail("CODEX_DESKTOP_OWNER_UNAVAILABLE");
    this.mapper ||= createCodexChatHistoryMapper({ schemaContract: this.schemaContract, cursorSecret: this.cursorSecret });
    return { host, response };
  }
  async snapshot(target, native) {
    const turns = await readCodexHistoryTurns(native.host, target.row.id);
    const snapshot = { id: crypto.randomUUID(), sessionKey: target.sessionKey, profileId: target.profile.id, bindingId: target.bindingId,
      native, turns, iterator: readCodexHistoryItems(native.host, target.row.id, "desc"),
      remainingTurns: [...turns.values()].reverse(), seenTurns: new Set(),
      messages: [], pages: new Map(), sequence: 0, done: false, bytes: 0, expiresAt: this.now() + 10 * 60_000 };
    for (const [id, cached] of this.historySnapshots) if (cached.expiresAt <= this.now()) this.historySnapshots.delete(id);
    // Each reader buffers at most one mapped native chunk, rather than retaining
    // a whole thread. Old messages are fetched only when the UI asks for them.
    while (this.historySnapshots.size >= 8) this.historySnapshots.delete(this.historySnapshots.keys().next().value);
    this.historySnapshots.set(snapshot.id, snapshot);
    return snapshot;
  }
  preTurnMessages(snapshot, runs) {
    const session = this.sessions?.getSession(snapshot.sessionKey);
    if (!this.transcripts || session?.profileId !== snapshot.profileId
      || session.runtimeSessionId !== snapshot.native.response.thread.id
      || session.runtimeBindingId !== snapshot.bindingId) return [];
    // A failed startup has no native turn to project. Keep its exact durable
    // user/error pair; imported history and accepted turns remain native-owned.
    const rejected = new Map(runs.filter(run => run.source === "chat"
      && run.sourceId === snapshot.sessionKey && run.profileId === snapshot.profileId
      && run.workspace === session.workspace
      && run.runtimeSessionRef === null && run.runtimeTurnRef === null
      && ["failed", "canceled", "interrupted", "skipped"].includes(run.status))
      .map(run => [run.id, run]));
    const events = this.transcripts.listEvents(snapshot.profileId, session.id);
    const users = new Set(events.filter(event => event.kind === "user"
      && rejected.get(event.runId)?.idempotencyKey === `shoggoth:chat-send:${event.content?.operationId}`)
      .map(event => event.runId));
    return events.filter(event => {
      const run = rejected.get(event.runId);
      if (!run || !users.has(run.id)) return false;
      if (event.kind === "user") return run.idempotencyKey === `shoggoth:chat-send:${event.content?.operationId}`;
      return event.kind === "error" && event.content?.transcriptType === "terminal"
        && event.content.status === run.status && event.content.errorCode === run.errorCode;
    }).map(event => {
      const item = transcriptHistoryItem(event);
      return item ? { at: event.occurredAt, seq: event.seq,
        messages: fragmentCodexChatHistoryMessage(item.payload.message) } : null;
    }).filter(Boolean).sort((left, right) => right.at - left.at || right.seq - left.seq);
  }
  async *historyGroups(snapshot, runs) {
    const local = this.preTurnMessages(snapshot, runs);
    while (true) {
      const entry = await snapshot.iterator.next();
      const groups = [];
      while (snapshot.remainingTurns.length && (entry.done || snapshot.remainingTurns[0].id !== entry.value.turnId)) {
        const skipped = snapshot.remainingTurns.shift();
        if (skipped.status === "failed" && !snapshot.seenTurns.has(skipped.id)) groups.push(skipped);
      }
      if (!entry.done) {
        const turn = snapshot.turns.get(entry.value.turnId);
        if (!turn) fail("CODEX_DESKTOP_UNAVAILABLE");
        snapshot.seenTurns.add(turn.id);
        groups.push({ ...turn, items: [entry.value.item] });
      }
      for (const turn of groups) {
        const at = (turn.completedAt ?? turn.startedAt ?? 0) * 1000;
        while (local.length && local[0].at >= at) yield local.shift().messages;
        // Validate and redact one native item at a time, retaining pagination
        // and fragment boundaries even when local startup failures interleave.
        const messages = this.mapTurn(snapshot, turn, runs);
        if (messages.length) yield messages;
      }
      if (entry.done) break;
    }
    while (local.length) yield local.shift().messages;
  }
  originalUserItem(snapshot, turn, item, runs) {
    if (item.type !== "userMessage" || !item.clientId || !this.transcripts || !this.contextSnapshots) return item;
    const textEntry = item.content.filter(entry => entry.type === "text");
    if (textEntry.length !== 1 || !textEntry[0].text.includes("\n\nCURRENT USER REQUEST\n")) return item;
    const run = runs.find(run => run.profileId === snapshot.profileId
      && run.idempotencyKey === `shoggoth:chat-send:${item.clientId}`
      && run.runtimeTurnRef?.sessionId === snapshot.native.response.thread.id
      && run.runtimeTurnRef?.turnId === turn.id && run.contextSnapshotId);
    if (!run) return item;
    const user = this.transcripts.getEvent(snapshot.profileId, snapshot.sessionKey, transcriptEventId("chat-user", item.clientId));
    if (user?.kind !== "user" || user.runId !== run.id || user.content?.operationId !== item.clientId
      || typeof user.content.text !== "string") return item;
    let context;
    try { context = this.contextSnapshots.get(snapshot.profileId, run.contextSnapshotId); }
    catch { return item; }
    if (!context || context.runId !== run.id) return item;
    const prompt = attachmentPrompt(user.content.text, user.content.attachments || []);
    if (![context.dynamicContext, context.dynamicContextWithoutTranscript].some(value =>
      typeof value === "string" && value.length > 0 && textEntry[0].text === `${value}\n\nCURRENT USER REQUEST\n${prompt}`)) return item;
    // Restore only a proven Shoggoth wrapper. Native files are never rewritten,
    // and restored input still passes schema validation, redaction and budgets.
    return { ...item, content: item.content.map(entry => entry === textEntry[0] ? { ...entry, text: prompt } : entry) };
  }
  mapTurn(snapshot, turn, runs = []) {
    let validated = this.mapper.validateCodexThreadRead({ ...snapshot.native.response,
      thread: { ...snapshot.native.response.thread, turns: [turn] } });
    const items = turn.items.map(item => this.originalUserItem(snapshot, turn, item, runs));
    if (items.some((item, index) => item !== turn.items[index])) validated = this.mapper.validateCodexThreadRead({ ...snapshot.native.response,
      thread: { ...snapshot.native.response.thread, turns: [{ ...turn, items }] } });
    const parts = []; let cursor = null;
    do {
      const page = this.mapper.createCodexChatHistoryPage(validated, { limit: 100, cursor,
        registeredSecrets: snapshot.native.host.registeredSecrets || [] });
      parts.unshift(...page.messages); cursor = page.nextCursor;
    } while (cursor !== null);
    snapshot.bytes += parts.reduce((bytes, part) => bytes + Buffer.byteLength(JSON.stringify(part)), 0);
    return parts;
  }
  historyCursor(snapshot, before) {
    const body = Buffer.from(JSON.stringify([snapshot.id, before])).toString("base64url");
    return `${body}.${crypto.createHmac("sha256", this.cursorSecret).update(body).digest("base64url")}`;
  }
  cachedHistory(target, cursor) {
    try {
      const [body, mac, extra] = cursor.split(".");
      if (extra || !mac || crypto.createHmac("sha256", this.cursorSecret).update(body).digest("base64url") !== mac) throw new Error();
      const [id, before] = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      const snapshot = this.historySnapshots.get(id);
      if (!snapshot || snapshot.sessionKey !== target.sessionKey || snapshot.bindingId !== target.bindingId
        || snapshot.expiresAt <= this.now() || !Number.isSafeInteger(before) || before < 0 || before > snapshot.sequence) throw new Error();
      return { snapshot, before };
    } catch { fail("CODEX_DESKTOP_PARAMS_INVALID"); }
  }
  async page(snapshot, params, runs = [], sequence = 0) {
    if (snapshot.pages.has(sequence)) return snapshot.pages.get(sequence);
    if (sequence !== snapshot.sequence) fail("CODEX_DESKTOP_PARAMS_INVALID");
    const loading = (async () => {
      while (!snapshot.done && snapshot.messages.length < params.limit) {
        snapshot.messageIterator ||= this.historyGroups(snapshot, runs);
        const entry = await snapshot.messageIterator.next();
        if (entry.done) { snapshot.done = true; break; }
        snapshot.messages.unshift(...entry.value);
      }
      for (let limit = params.limit; limit >= 1; limit = Math.floor(limit / 2)) {
        const start = Math.max(0, snapshot.messages.length - limit);
        const hasMore = !snapshot.done || start > 0;
        const adapted = adaptCodexChatHistoryPage({ messages: snapshot.messages.slice(start), hasMore,
          nextCursor: hasMore ? this.historyCursor(snapshot, sequence + 1) : null }, { runs });
        if (Buffer.byteLength(JSON.stringify(adapted)) >= 58 * 1024) continue;
        const result = validateChatServiceResult("chat.history", adapted);
        snapshot.messages.splice(start); snapshot.sequence++;
        snapshot.expiresAt = this.now() + 10 * 60_000;
        return result;
      }
      fail("CODEX_DESKTOP_UNAVAILABLE");
    })();
    snapshot.pages.set(sequence, loading);
    try { return await loading; }
    catch (error) { this.historySnapshots.delete(snapshot.id); throw error; }
    finally { while (snapshot.pages.size > 2) snapshot.pages.delete(snapshot.pages.keys().next().value); }
  }
  async attach(params) {
    const target = this.target(params), native = await this.readNative(target);
    // Attach only metadata/ownership. The original native thread is resumed by
    // the normal Coordinator; no thread/start or model turn is sent here.
    const workspace = canonicalWorkspace(target.row.cwd);
    if (!fs.statSync(workspace).isDirectory()) fail("CODEX_DESKTOP_UNAVAILABLE");
    this.ownership?.claim({ ...target.binding, sessionId: target.row.id, profileId: target.profile.id, workspace });
    const projected = this.project(target.row, target).session;
    if (!this.sessions.getSession(target.sessionKey) && this.checkpoints) {
      const expected = this.checkpoints.nativeMemoryVersion(target.profile.id);
      if (this.checkpoints.recordNativeSession(target.profile.id, target.sessionKey, target.row.id, target.bindingId, expected) !== true) fail("CODEX_DESKTOP_UNAVAILABLE");
    }
    const session = this.sessions.importRuntimeSession({ sessionKey: target.sessionKey, profileId: target.profile.id,
      runtimeBindingId: target.bindingId, runtimeSessionId: target.row.id, workspace,
      title: projected.title, modelOverride: projected.modelOverride, modelSettings: projected.modelSettings });
    if (this.transcripts && this.transcripts.listEvents(session.profileId, session.id).length === 0) {
      const snapshot = await this.snapshot(target, native);
      const items = []; let sequence = 0, bytes = 0;
      for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
        const page = await this.page(snapshot, { limit: bytes >= 128 * 1024 || items.length >= 100 ? 1 : 20 }, [], sequence);
        items.unshift(...page.messages);
        bytes += page.messages.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
        if (bytes > 8 * 1024 * 1024) fail("CODEX_DESKTOP_UNAVAILABLE");
        const complete = !items[0]?.fragment || items[0].fragment.index === 0;
        if (!page.hasMore || (complete && (bytes >= 128 * 1024 || items.length >= 100))) break;
        if (pageIndex === 999) fail("CODEX_DESKTOP_UNAVAILABLE");
        sequence++;
      }
      this.transcripts.importHistoryItems({ profileId: session.profileId, sessionId: session.id, items,
        runtimeRef: { ...target.binding, sessionId: target.row.id } });
    }
    return { session };
  }
  async history(params) {
    const target = this.target(params);
    const { snapshot, before } = params.cursor === null
      ? { snapshot: await this.snapshot(target, await this.readNative(target)), before: undefined }
      : this.cachedHistory(target, params.cursor);
    const runs = this.productStore.listWorkRuns?.({ source: "chat", sourceId: target.sessionKey }) || [];
    const result = await this.page(snapshot, params, runs, before);
    if (this.owner(target.profile.id, target.store.homeIdentity).bindingId !== target.bindingId) fail("CODEX_DESKTOP_OWNER_UNAVAILABLE");
    return result;
  }
  async assertSendable(sessionKey, ownedActiveTurnIds = []) {
    const session = this.sessions.getSession(sessionKey);
    if (!session || !isDesktopBinding(this.sessions.getBinding(sessionKey))) return;
    const owner = this.owner(session.profileId), target = this.target({ profileId: session.profileId,
      threadId: session.runtimeSessionId, homeIdentity: owner.store.homeIdentity });
    const native = await this.readNative(target);
    const turns = await readCodexHistoryTurns(native.host, target.row.id);
    const active = [...turns.values()].filter(turn => turn.status === "inProgress");
    const owned = new Set(ownedActiveTurnIds);
    // Ordinary send passes no exceptions. UI operations may share the current
    // admitted Shoggoth turn, whose live capability and native refs were checked
    // by the Service; an additional external Desktop turn always blocks them.
    if (active.some(turn => !owned.has(turn.id))
      || (native.response.thread.status?.type === "active" && active.length === 0)) fail("CODEX_DESKTOP_BUSY");
  }
  async handle(method, params) {
    if (method === "codex.desktop.sessions.list") return this.list(params);
    if (method === "codex.desktop.session.attach") return this.attach(params);
    return this.history(params);
  }
}
module.exports = { CodexDesktopSessionController };
