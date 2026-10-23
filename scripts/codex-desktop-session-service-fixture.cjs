"use strict";
// Real SQLite + production private Service, Backend and Coordinator. The native
// model host is simulated; the fixture never accesses user histories or auth.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { OWNER, ACCOUNT_ID } = require("../app/agent-service/codex-automation-store");
const { CodexDesktopSessionStore, desktopSessionKey, isDesktopBinding } = require("../app/agent-service/codex-desktop-session-store");
const { AutomationHost, mockHome, waitUntil } = require("./helpers/codex-automation-harness.cjs");

function turn(text, answer, status = "completed") {
  return { id: crypto.randomUUID(), itemsView: "full", status, error: null, startedAt: 100,
    completedAt: status === "completed" ? 101 : null, durationMs: status === "completed" ? 1000 : null,
    items: [{ type: "userMessage", id: crypto.randomUUID(), content: [{ type: "text", text }] },
      { type: "agentMessage", id: crypto.randomUUID(), phase: "final_answer", text: answer }] };
}
class DesktopHost extends AutomationHost {
  constructor() { super(); this.threadStarts = 0; this.resumes = []; this.rejectResume = false; }
  async threadStart(params) { this.threadStarts++; return super.threadStart(params); }
  async threadResume(params) {
    this.resumes.push(structuredClone(params));
    if (this.rejectResume) throw new Error("fixture resume failed");
    assert.equal(params.excludeTurns, true, "resume must not hydrate full desktop history");
    const response = await AutomationHost.prototype.threadRead.call(this, params);
    return { ...response, thread: { ...response.thread, turns: [] } };
  }
  async threadRead(params) {
    const response = await super.threadRead(params);
    const metadata = { ...response, thread: { ...response.thread, historyMode: "paginated", turns: [] } };
    return params.includeTurns === true
      ? require("../app/agent-service/codex-thread-history-reader").readCodexPaginatedThread(this, metadata) : metadata;
  }
  async threadTurnsList(params) {
    const turns = this.threads.find(t => t.id === params.threadId).turns;
    const start = Number(params.cursor || 0), end = Math.min(start + params.limit, turns.length);
    return { data: turns.slice(start, end).map(t => ({ ...t, items: [], itemsView: "notLoaded" })),
      nextCursor: end < turns.length ? String(end) : null, backwardsCursor: null };
  }
  async threadItemsList(params) {
    const items = this.threads.find(t => t.id === params.threadId).turns.flatMap(t => t.items.map(item => ({ turnId: t.id, item })));
    if (params.sortDirection === "desc") items.reverse();
    const start = Number(params.cursor || 0), end = Math.min(start + params.limit, items.length);
    const page = { data: items.slice(start, end), nextCursor: end < items.length ? String(end) : null, backwardsCursor: null };
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 8 * 1024 * 1024, "native page must fit the RPC frame");
    return page;
  }
  async turnStart(params) {
    const result = await super.turnStart(params);
    const active = this.threads.find(t => t.id === params.threadId).turns.at(-1);
    Object.assign(active, { error: null, startedAt: 102, completedAt: null, durationMs: null });
    active.items[0].content = params.input.filter(i => i.type === "text").map(i => ({ type: "text", text: i.text }));
    return result;
  }
  finish(id, text, status = "completed") {
    const thread = this.threads.find(t => t.turns.some(turn => turn.id === id));
    const current = thread.turns.find(t => t.id === id);
    Object.assign(current, { status, completedAt: 103, durationMs: 1000 });
    if (text) current.items.push({ type: "agentMessage", id: crypto.randomUUID(), phase: "final_answer", text });
    for (const listener of this.subscribers) listener({ known: true, type: "complete", method: "turn/completed", threadId: thread.id, turnId: id, status });
  }
}
async function fixture({ enabledSkill = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-desktop-")));
  const home = mockHome(root), host = new DesktopHost();
  const workspace = path.join(root, "desktop-project"); fs.mkdirSync(workspace);
  const dbFile = path.join(home, "state_5.sqlite");
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,created_at INTEGER,updated_at INTEGER,
    source TEXT,originator TEXT,thread_source TEXT,archived INTEGER,title TEXT,cwd TEXT,model TEXT,reasoning_effort TEXT,name TEXT);`);
  function add({ originator = "Codex Desktop", source = "vscode", threadSource = "user", archived = 0, title = "桌面对话：保留原上下文", large = false } = {}) {
    const id = crypto.randomUUID(), file = path.join(home, "sessions", `rollout-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id, originator, source, thread_source: threadSource } }) + "\n");
    db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, file, 100, 200, source, originator, threadSource,
      archived, title, workspace, "fixture-model", "high", null);
    const native = { id, cliVersion: "0.159.2", cwd: workspace, ephemeral: false, modelProvider: "openai", preview: "fixture",
      projectId: null, sessionId: crypto.randomUUID(), source: "appServer", threadSource, status: { type: "idle" },
      createdAt: 100, updatedAt: 200, turns: [turn("记住原上下文", large ? "长历史".repeat(18000) : "已记住桌面对话的上下文")] };
    host.threads.push(native); return native;
  }
  const native = add(), second = add({ originator: "codex_work_desktop", title: "另一条桌面对话", large: true });
  add({ originator: "shoggoth", threadSource: "shoggoth:fixture" });
  add({ originator: "codex-tui", source: "cli" });
  add({ archived: 1 });
  const paths = resolveServicePaths({ trustedRoot: root, userDataRoot: root, cacheRoot: path.join(root, "cache") });
  const key = crypto.randomBytes(32);
  const cryptoBroker = { async open() {}, async close() {}, async encrypt(input) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, cipher.update(input), cipher.final(), cipher.getAuthTag()]);
  }, async decrypt(input) {
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, input.subarray(0, 12));
    cipher.setAuthTag(input.subarray(-16)); return Buffer.concat([cipher.update(input.subarray(12, -16)), cipher.final()]);
  } };
  const pool = { runtimeAccountResolver: { resolve: () => ({ home, nativeHome: home }) }, get: async () => host, stopAll: async () => {} };
  const service = createAgentService({ paths, cryptoBroker, runtimePool: pool, builtinCliProfiles: true,
    builtinCliInstalledAccountIds: [ACCOUNT_ID], autoSparkNotes: false,
    parentEnv: { HOME: root, CODEX_HOME: home, PATH: "/usr/bin:/bin" }, runtimeStorageHomedir: root, version: "desktop-session-fixture" });
  await service.start();
  if (enabledSkill) {
    const skill = path.join(root, "context-fixture-skill"); fs.mkdirSync(skill, { mode: 0o700 });
    fs.writeFileSync(path.join(skill, "skill.json"), JSON.stringify({ schemaVersion: 1,
      id: "context-fixture", name: "context-fixture", version: "1.0.0", description: "Inspect a local folder.",
      entry: "SKILL.md", requiredTools: [], requiredRuntimeCapabilities: [], sourceCompatibility: ["shoggoth", "codex"] }));
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: context-fixture\ndescription: Inspect a local folder.\n---\n\nInspect the requested local folder.\n");
    service.nativeSkillStore.installFromDirectory({ sourcePath: skill,
      expectedRevision: service.nativeSkillStore.revision, operationId: "fixture-skill-install" });
    service.nativeSkillStore.setProfileSkill({ profileId: OWNER.id, skillId: "context-fixture", source: "user", version: "1.0.0",
      enabled: true, expectedRevision: service.nativeSkillStore.list(OWNER.id).profileRevision });
  }
  const ipc = (method, params) => requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params });
  service.productStore.putAgentProfile({ ...service.productStore.getAgentProfile(OWNER.id), name: "改名后的第一个 Codex",
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" } });
  await ipc("agent.create", { operationId: "desktop-clone", backendId: "shoggoth", name: "其他 Codex Agent", defaultCwd: null, createdAt: Date.now() });
  const backend = new ShoggothBackend({ paths, pollIntervalMs: 20, readinessIntervalMs: 10, readinessTimeoutMs: 5000,
    runtimeCliAuth: [{ runtime: "codex", name: "Fixture Codex", runtimeAccountId: ACCOUNT_ID, binaryPath: process.execPath,
      accountHome: home, processHome: root, homeEnv: "CODEX_HOME", accountKind: "native-user", credentialProbe: "runtime",
      credentialFile: null, loginArgs: [], logoutArgs: [], docsUrl: "https://developers.openai.com/codex/" }] });
  if (!await backend.start()) { await backend.stop(); await service.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); throw Error("fixture backend failed to start"); }
  return { root, home, workspace, db, dbFile, host, native, second, add, paths, service, ipc, backend,
    async close() { await backend.stop(); await service.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
async function run() {
  const f = await fixture();
  try {
    const { backend, service, host, native, workspace, ipc, db } = f;
    const desktops = backend.getSessionRows().filter(r => r.source === "codex-desktop");
    assert.equal(desktops.length, 2, JSON.stringify(backend.getSessionRows()));
    assert.ok(desktops.every(r => r.agentId === OWNER.agentId));
    assert.ok(desktops.every(r => r.agentName === "改名后的第一个 Codex"));
    const row = desktops.find(r => r.label === "桌面对话：保留原上下文");
    assert.equal(service.chatSessionStore.getSession(row.sessionId), null, "listing is a projection, not bulk import");
    const entry = backend._codexDesktopEntries.get(row.sessionId), params = { profileId: OWNER.id, threadId: native.id, homeIdentity: entry.homeIdentity };
    const first = await ipc("codex.desktop.sessions.list", { backendId: "shoggoth", cursor: null, limit: 1 });
    assert.equal(first.sessions.length, 1); assert.equal(first.hasMore, true);
    const next = await ipc("codex.desktop.sessions.list", { backendId: "shoggoth", cursor: first.nextCursor, limit: 1 });
    assert.equal(next.sessions.length, 1); assert.notEqual(first.sessions[0].threadId, next.sessions[0].threadId);
    await assert.rejects(ipc("codex.desktop.sessions.list", { backendId: "shoggoth", cursor: first.nextCursor + "x", limit: 1 }));
    await assert.rejects(ipc("codex.desktop.session.attach", { ...params, threadId: [native.id] }), e => e.code === "CODEX_DESKTOP_PARAMS_INVALID");
    await assert.rejects(ipc("codex.desktop.session.attach", { ...params, homeIdentity: [entry.homeIdentity] }), e => e.code === "CODEX_DESKTOP_PARAMS_INVALID");
    await assert.rejects(ipc("codex.desktop.history", { ...params, homeIdentity: "a".repeat(24), cursor: null, limit: 10 }));
    const clone = (await backend.listAgents()).find(a => a.name === "其他 Codex Agent");
    const cloneProfile = backend._profilesByAgent.get(clone.id);
    await assert.rejects(ipc("codex.desktop.session.attach", { ...params, profileId: cloneProfile.id }));
    const history = await backend.getHistory(row.key);
    assert.equal(history.messages.length, 2); assert.equal(history.messages[1].content[0].text, "已记住桌面对话的上下文");
    assert.equal(service.chatSessionStore.getSession(row.sessionId), null);
    const long = await backend.getHistory(desktops.find(r => r.sessionId !== row.sessionId).key);
    assert.equal(long.messages.at(-1).content[0].text, "长历史".repeat(18000), "fragments reassemble completely");
    if (long.hasMore) {
      const earlier = await backend.getHistory(desktops.find(r => r.sessionId !== row.sessionId).key, { cursor: long.nextCursor });
      assert.equal(earlier.messages[0].content[0].text, "记住原上下文", "the bounded window retains older user messages");
    }
    const huge = f.add({ title: "超过整段 RPC 上限的桌面历史" });
    huge.turns = Array.from({ length: 40 }, (_, i) => turn(`问题 ${i}`, `${i}:` + "多字节历史".repeat(14000)));
    assert.ok(Buffer.byteLength(JSON.stringify(huge)) > 8 * 1024 * 1024);
    await backend._refreshCodexDesktopSessions();
    const hugeRow = backend.getSessionRows().find(r => r.label === "超过整段 RPC 上限的桌面历史");
    const hugeHistory = await backend.getHistory(hugeRow.key);
    assert.equal(hugeHistory.hasMore, true, "large UI history is paginated within the existing response budget");
    assert.equal(hugeHistory.messages.at(-1).content[0].text, huge.turns.at(-1).items[1].text);
    const hugeEntry = backend._codexDesktopEntries.get(hugeRow.sessionId);
    const hugeParams = { profileId: OWNER.id, threadId: huge.id, homeIdentity: hugeEntry.homeIdentity, limit: 1 };
    const pageOne = await ipc("codex.desktop.history", { ...hugeParams, cursor: null });
    const duplicatePages = await Promise.all([1, 2].map(() => ipc("codex.desktop.history", { ...hugeParams, cursor: pageOne.nextCursor })));
    assert.deepEqual(duplicatePages[0], duplicatePages[1], "replayed/concurrent native history cursors are idempotent");
    await assert.rejects(ipc("codex.desktop.history", { ...hugeParams, threadId: native.id, cursor: pageOne.nextCursor }),
      e => e.code === "CODEX_DESKTOP_PARAMS_INVALID", "history cursor is bound to the exact original thread");
    const hugeMessages = [...hugeHistory.messages]; let cursor = hugeHistory.nextCursor;
    while (cursor) {
      const page = await backend.getHistory(hugeRow.key, { cursor });
      hugeMessages.unshift(...page.messages); cursor = page.nextCursor;
    }
    assert.equal(hugeMessages.length, 80, "all older messages remain available without truncation");
    assert.equal(hugeMessages[0].content[0].text, "问题 0");
    assert.equal((await backend.getHistory(row.key)).messages.length, 2, "large history must not poison the shared host");
    db.prepare("UPDATE threads SET archived=1 WHERE id=?").run(huge.id);
    await backend._refreshCodexDesktopSessions();
    const emptyFailed = f.add({ title: "没有 item 的失败回合" });
    emptyFailed.turns = [{ ...turn("", "", "failed"), items: [] }];
    await backend._refreshCodexDesktopSessions();
    const failedHistory = await backend.getHistory(backend.getSessionRows().find(r => r.label === "没有 item 的失败回合").key);
    assert.equal(failedHistory.messages.length, 1, "an empty failed turn displays its failure rather than a blank history");
    db.prepare("UPDATE threads SET archived=1 WHERE id=?").run(emptyFailed.id);
    await backend._refreshCodexDesktopSessions();
    native.turns.push(turn("桌面新增消息", "客户端更新后的回答"));
    assert.equal((await backend.getHistory(row.key)).messages.length, 4, "always read current native history");
    const starts = host.threadStarts;
    const attached = await Promise.all([ipc("codex.desktop.session.attach", params), ipc("codex.desktop.session.attach", params)]);
    assert.equal(attached[0].session.sessionKey, row.sessionId); assert.equal(attached[1].session.sessionKey, row.sessionId);
    assert.equal(host.threadStarts, starts); assert.equal(host.turnStarts, 0);
    const session = service.chatSessionStore.getSession(row.sessionId);
    assert.equal(session.runtimeSessionId, native.id); assert.equal(session.workspace, workspace);
    assert.equal(isDesktopBinding(service.chatSessionStore.getBinding(row.sessionId)), true);
    assert.equal(service.chatSessionStore.listPendingBindings().length, 0);
    const runtimeState = await ipc("chat.session.runtime.state", { profileId: OWNER.id, sessionKey: row.sessionId });
    assert.equal(runtimeState.canSwitch, false);
    const pinned = require("../app/agent-service/session-runtime-controller").createSessionRuntimeController({
      chatSessionStore: service.chatSessionStore, policyStore: { get() { throw Error("automatic policy must not select a desktop thread"); } },
    });
    await pinned.selectForSend({ sessionKey: row.sessionId });
    assert.equal((await pinned.followDefault(row.sessionId)).runtimeSessionId, native.id);
    assert.equal(service.transcriptStore.listEvents(OWNER.id, session.id).filter(e => ["user", "assistant"].includes(e.kind)).length, 4);
    const bindingId = session.runtimeBindingId;
    service.chatSessionStore.switchRuntime(row.sessionId, { bindingId, revision: session.revision, clearModelOverride: false,
      model: "fixture-model", renewSession: false });
    assert.equal(service.chatSessionStore.getSession(row.sessionId).runtimeSessionId, native.id);
    assert.throws(() => service.chatSessionStore.switchRuntime(row.sessionId, { bindingId, revision: session.revision, clearModelOverride: false }), e => e.code === "CODEX_DESKTOP_RUNTIME_PINNED");
    let failure = null;
    const sending = backend.sendMessage(row.key, "在 Shoggoth 继续原对话", "desktop-continue", { error: e => { failure = e; } }).catch(e => { failure = e; });
    await waitUntil(() => host.turnStarts === 1 || failure, "resume original thread", 10000);
    assert.equal(failure, null); assert.equal(host.threadStarts, starts);
    assert.equal(host.turnParams.threadId, native.id); assert.equal(host.resumes.at(-1).cwd, workspace);
    const run = service.productStore.listWorkRuns({ source: "chat", sourceId: row.sessionId }).at(-1);
    host.finish(run.runtimeTurnRef.turnId, "在原线程完成 Shoggoth 回复"); await sending;
    assert.equal(service.workDispatcher.getRun(run.id).status, "completed");
    assert.equal((await backend.getHistory(row.key)).messages.at(-1).content[0].text, "在原线程完成 Shoggoth 回复");
    await backend.stop(); await service.stop(); await service.start(); assert.equal(await backend.start(), true);
    assert.equal(service.chatSessionStore.getSession(row.sessionId).runtimeSessionId, native.id);
    assert.equal(isDesktopBinding(service.chatSessionStore.getBinding(row.sessionId)), true);
    assert.equal(backend.getSessionRows().filter(r => r.source === "codex-desktop").length, 2);
    const busy = turn("正在桌面运行", "", "inProgress"); native.turns.push(busy);
    failure = null; await backend.sendMessage(row.key, "不能并发发送", "desktop-busy", { error: e => { failure = e; } });
    assert.equal(host.turnStarts, 1); assert.equal(host.threadStarts, starts);
    assert.match(failure, /Codex 客户端运行/u);
    native.turns.pop(); host.rejectResume = true;
    await backend.sendMessage(row.key, "恢复失败不新建", "desktop-failed", { error: () => {} });
    assert.equal(host.turnStarts, 1); assert.equal(host.threadStarts, starts);
    assert.equal(service.chatSessionStore.getSession(row.sessionId).runtimeSessionId, native.id);
    host.rejectResume = false;
    const nativeSessionStale = service.conversationCheckpointStore.nativeSessionStale;
    service.conversationCheckpointStore.nativeSessionStale = () => true;
    try {
      failure = null;
      await backend.sendMessage(row.key, "上下文变化时保持原线程", "desktop-context-changed", { error: e => { failure = e; } });
      assert.match(failure, /记忆或撤回状态已变化/u);
      assert.equal(host.turnStarts, 1); assert.equal(host.threadStarts, starts);
      assert.equal(service.chatSessionStore.getSession(row.sessionId).runtimeSessionId, native.id);
    } finally { service.conversationCheckpointStore.nativeSessionStale = nativeSessionStale; }
    db.prepare("UPDATE threads SET archived=1 WHERE id=?").run(native.id);
    await assert.rejects(backend.sendMessage(row.key, "已归档", "desktop-archived"), e => e.code === "CODEX_DESKTOP_NOT_FOUND");
    await backend._refreshCodexDesktopSessions();
    assert.equal(backend.getSessionRows().filter(r => r.source === "codex-desktop").length, 1);
    const store = new CodexDesktopSessionStore({ home: f.home });
    const key1 = desktopSessionKey(store.homeIdentity, OWNER.id, f.second.id);
    assert.equal(key1, backend.getSessionRows().find(r => r.source === "codex-desktop").sessionId);
    const originalPath = store.get(f.second.id).rollout_path;
    db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(path.join(f.root, "foreign.jsonl"), f.second.id);
    assert.throws(() => store.get(f.second.id), e => e.code === "CODEX_DESKTOP_NOT_FOUND");
    db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(originalPath, f.second.id);
    const alreadyKnown = f.add({ title: "原会话已登记到 Shoggoth" });
    const knownSession = service.chatSessionStore.createSession({ operationId: "desktop-known-session", profileId: OWNER.id,
      workspace, defaultBindingId: bindingId, createdAt: Date.now() });
    service.chatSessionStore.requestBinding(knownSession.sessionKey, "bind-desktop-known", Date.now());
    service.chatSessionStore.completeBinding(knownSession.sessionKey, "bind-desktop-known", alreadyKnown.id);
    const deduplicated = await ipc("codex.desktop.sessions.list", { backendId: "shoggoth", cursor: null, limit: 100 });
    assert.ok(!deduplicated.sessions.some(item => item.threadId === alreadyKnown.id), "a native thread already registered in Shoggoth is not projected twice");
    db.exec("ALTER TABLE threads RENAME COLUMN originator TO unknown_originator");
    await backend._refreshCodexDesktopSessions();
    assert.equal(backend._complete, true, "native source failure does not break product sessions");
    assert.equal(backend._codexDesktopSourceError, "CODEX_DESKTOP_FORMAT_UNSUPPORTED");
    assert.ok(backend.getSessionRows().some(r => r.codexDesktopSourceError));
    console.log("PASS Codex Desktop: sole renamed owner, clone exclusion, native filtering and deduplication, stable paging, bounded full live history, atomic/idempotent attach, original thread/cwd continuation and restart, busy and context guards, no resume fallback, archive and source failure");
  } finally { await f.close(); }
}
module.exports = { fixture, DesktopHost, turn };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
