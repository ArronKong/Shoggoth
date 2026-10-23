"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
// Optional package gate loads the shipped ASAR with its own Electron/SQLite.
// Runtime transport remains simulated; this never uses a provider account.
const packagedApp = process.env.SHOGGOTH_PROACTIVE_APP_PATH;
if (packagedApp !== undefined) {
  assert.ok(path.isAbsolute(packagedApp) && packagedApp.endsWith(".app") && packagedApp.isWellFormed());
  assert.ok(process.versions.electron, "The package gate must use packaged Electron");
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(packagedApp, "Contents/MacOS/Shoggoth")));
}
const productRoot = packagedApp === undefined ? path.resolve(__dirname, "../app")
  : path.join(packagedApp, "Contents/Resources/app.asar/app");
const { createAgentService, PROTOCOL_VERSION } = require(path.join(productRoot, "agent-service/server.js"));
const { resolveServicePaths } = require(path.join(productRoot, "agent-service/paths.js"));
const { readClientToken, requestService } = require(path.join(productRoot, "agent-service/client.js"));
const { DEFAULT_AGENT_PROFILE_ID } = require(path.join(productRoot, "agent-service/product-store.js"));
const { ShoggothBackend } = require(path.join(productRoot, "core/shoggoth-backend.js"));
const { InspirationRuntime } = require("./fixtures/inspiration-runtime.cjs");
const { DAY_MS } = require(path.join(productRoot, "agent-service/proactive-service-protocol.js"));
const { createMcpStdioHandler, authenticateMcpSession, MCP_STDIO_PROTOCOL_VERSION } = require(path.join(productRoot, "shoggoth-mcp-helper.js"));
const { normalizeCodexEvent } = require(path.join(productRoot, "agent-service/codex-event-normalizer.js"));
const id = () => crypto.randomUUID();
async function until(predicate) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("Proactive Service condition timed out");
}
class ReviewRuntime extends InspirationRuntime {
  ephemeralThreads = new Set();
  ephemeralHistoryReads = 0;
  async configRead() { return { config: { mcp_servers: { shoggoth: { command: "fixture" } } }, origins: {} }; }
  async experimentalFeatureList() { return { data: [{ name: "shell_tool", enabled: false }, { name: "unified_exec", enabled: false }], nextCursor: null }; }
  async mcpServerStatusList(params) { return { data: [{ name: "shoggoth", tools: [] },
    ...(params.threadId ? [] : [{ name: "codex_apps", tools: [] }])].map(server => server.name === "shoggoth"
      ? { ...server, tools: { proactive_respond: { name: "proactive_respond" } } } : server), nextCursor: null }; }
  async threadStart(params) {
    if (params.config?.web_search === "disabled") {
      assert.equal(params.config["features.apps"], false);
      assert.equal(Object.hasOwn(params.config, "mcp_servers.codex_apps.enabled"), false);
    }
    this.lastStart = params; const value = await super.threadStart(params);
    if (params.ephemeral) this.ephemeralThreads.add(value.thread.id);
    return { ...value, sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: params.approvalPolicy };
  }
  async threadRead(params) {
    if (this.ephemeralThreads.has(params.threadId)) {
      this.ephemeralHistoryReads++;
      throw Object.assign(new Error("Ephemeral review has no native history"), { code: "EPHEMERAL_HISTORY_DISABLED" });
    }
    return super.threadRead(params);
  }
  complete(run, text) {
    super.complete(run, text);
    if (run.source === "proactive") this.emit(normalizeCodexEvent({ method: "turn/completed", params: {
      threadId: run.runtimeSessionRef.sessionId, turn: { id: run.runtimeTurnRef.turnId, status: "completed" },
    } }));
  }
}
async function fixture(t, { autoSparkNotes = false, webService } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-proactive-ipc-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const clock = { value: Date.UTC(2026, 8, 29, 10) }, host = new ReviewRuntime(), sent = [];
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const service = createAgentService({ paths, now: () => clock.value, autoSparkNotes, webService,
    ...(packagedApp === undefined ? {} : { packaged: true, resourcesPath: path.join(packagedApp, "Contents/Resources") }),
    safeStorage,
    runtimePool: { async get() { return host; }, async stopAll() {} },
    setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {},
    proactiveProfileAvailable: () => true, proactiveRuntimeCapability: () => ({ semanticVerified: true, reason: null }),
    notificationSender: async input => { sent.push(input); return { state: "submitted" }; },
  });
  const backend = new ShoggothBackend({ paths, now: () => clock.value, readinessTimeoutMs: 2000, serviceEventPollMs: 25,
    async requestService(...args) { const result = await requestService(...args); return args[1].method === "service.status" ? { ...result, mcpCredentialsLocked: false } : result; } });
  t.after(async () => { await backend.stop(); await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); });
  await service.start(); await backend.start({ onSessionActivity() {} });
  const ipc = (method, params) => requestService(paths, { id: id(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params });
  const monitor = async (kind = "heartbeat") => (await ipc("proactive.monitor.get", { kind, profileId: DEFAULT_AGENT_PROFILE_ID }));
  const save = async (config, expectedRevision = service.proactiveStore.getMonitor(config.id)?.revision ?? 0) =>
    (await ipc("proactive.monitor.set", { operationId: id(), expectedRevision, config })).monitor;
  const sessions = async () => (await ipc("chat.session.list", { profileId: DEFAULT_AGENT_PROFILE_ID, includeArchived: false, cursor: null, limit: 100 })).sessions;
  return { root, paths, safeStorage, service, backend, host, clock, sent, ipc, monitor, save, sessions, baselineSessions: (await sessions()).length };
}
test("native Service IPC initializes current schema, exposes capabilities and restarts without visible empty ticks", async t => {
  const f = await fixture(t);
  const agents = await f.ipc("proactive.agents.list", { cursor: null, limit: 50 }); assert.ok(agents.agents.some(agent => agent.id === DEFAULT_AGENT_PROFILE_ID));
  const targets = await f.ipc("proactive.targets.list", { profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 50 });
  assert.equal(targets.targets.length, f.baselineSessions);
  assert.deepEqual(await f.ipc("proactive.runs.list", { profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 50 }), { runs: [], nextCursor: null });
  const { monitor } = await f.backend.proactiveCall("proactive.monitor.get", { kind: "heartbeat", profileId: DEFAULT_AGENT_PROFILE_ID });
  const config = { ...monitor.config, enabled: true, activeHours: null };
  await f.save(config); f.clock.value += 30 * 60000; await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.host.turnStarts, 0); assert.equal((await f.sessions()).length, f.baselineSessions);
  assert.equal((await f.ipc("proactive.monitor.history", { id: config.id, cursor: null, limit: 20 })).checks[0].reason, "empty_checklist");
  await f.service.stop({ notify: false }); await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.host.turnStarts, 0); assert.equal((await f.sessions()).length, f.baselineSessions);
  assert.equal((await f.monitor()).monitor.revision, 2);
});
test("Service schedules defaults for every existing and newly created native Agent without opening settings", async t => {
  const f = await fixture(t);
  const assertMonitor = profileId => {
    const monitor = f.service.proactiveStore.monitors(profileId).find(value => value.config.kind === "heartbeat");
    assert.ok(monitor);
    assert.equal(monitor.revision, 1);
    assert.equal(monitor.config.enabled, true);
    assert.equal(monitor.config.schedule.everyMs, 30 * 60_000);
    assert.equal(monitor.config.timezone, "system");
    assert.deepEqual(monitor.config.activeHours, { start: "08:00", end: "22:00" });
    assert.deepEqual(monitor.config.budget, { maxRunsPerDay: 24, maxTokensPerDay: 10_000_000 });
    assert.equal(monitor.nextRunAt, f.clock.value + 30 * 60_000);
    return monitor;
  };
  for (const profile of f.service.productStore.listAgentProfiles()) assertMonitor(profile.id);
  const { profile } = await f.ipc("agent.create", { operationId: id(), backendId: "shoggoth", name: "Heartbeat defaults",
    defaultCwd: null, createdAt: f.clock.value });
  const created = assertMonitor(profile.id);
  f.clock.value += 30 * 60_000;
  await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.service.proactiveStore.history(created.config.id).length, 1);
  assert.equal(f.host.turnStarts, 0);
  await f.service.stop({ notify: false }); await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.service.proactiveStore.getMonitor(created.config.id).revision, 1);
  assert.equal(f.host.turnStarts, 0);
});
test("a scoped real WorkRun uses admission, read-only contract and structured MCP response; no ordinary chat is created", async t => {
  const f = await fixture(t), { monitor } = await f.monitor();
  const config = { ...monitor.config, enabled: true, activeHours: null,
    checklist: [{ id: "review-state", instruction: "Review only the supplied local state", enabled: true, mode: "review" }] };
  await f.save(config); f.clock.value += 30 * 60000; await f.service.proactiveScheduler.tick();
  await until(() => f.service.workDispatcher.listRuns({ source: "proactive" }).some(run => ["running", "failed", "interrupted"].includes(run.status)));
  const run = f.service.workDispatcher.listRuns({ source: "proactive" })[0]; assert.equal(run.status, "running", JSON.stringify(run));
  assert.equal(run.sourceId, config.id); assert.equal((await f.sessions()).length, f.baselineSessions);
  assert.equal(f.host.lastStart.sandbox, "read-only"); assert.equal(f.host.lastStart.approvalPolicy, "on-request"); assert.equal(f.host.lastStart.ephemeral, true);
  assert.deepEqual(f.host.lastStart.config["mcp_servers.shoggoth.enabled_tools"], ["proactive_respond"]);
  await assert.rejects(async () => f.host.approve(run), { code: "PROACTIVE_SCOPE_INVALID" });
  await assert.rejects(async () => f.host.ask(run), { code: "PROACTIVE_SCOPE_INVALID" });
  for (const method of ["item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
    await assert.rejects(async () => f.host.request(method, { threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId }), { code: "PROACTIVE_SCOPE_INVALID" });
  }
  const occurrence = f.service.proactiveStore.occurrenceForRun(run.id), candidate = occurrence.candidates[0];
  const response = { runId: run.id, outcome: "notice", candidates: [{ id: candidate.id, evidenceVersion: candidate.evidenceVersion }], reason: "An authorized item needs review", body: "Review the authorized checklist" };
  const authority = { profileId: run.profileId, callId: id() };
  const scope = { runId: run.id, assertCurrent: () => f.service.proactiveService.assertRunCurrent(f.service.workDispatcher.getRun(run.id)) };
  await assert.rejects(() => f.service.mcpProductToolController.handle("proactive_respond", response, authority), { code: "MCP_TOOL_FORBIDDEN" });
  await assert.rejects(() => f.service.mcpProductToolController.handle("notification_send", { runId: run.id, title: "Bypass", body: "No" }, authority, scope), { code: "MCP_TOOL_FORBIDDEN" });
  const profile = f.service.productStore.getAgentProfile(run.profileId);
  const session = await authenticateMcpSession({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId, safeStorage: f.safeStorage, requestService });
  const helper = createMcpStdioHandler({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId, sessionToken: session.token, bindRuntimeCalls: true,
    now: () => f.clock.value, requestService });
  t.after(() => helper.close());
  await helper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
    capabilities: { elicitation: {} }, clientInfo: { name: "proactive-binding-fixture", version: "1" } } });
  for (const method of ["resources/list", "resources/templates/list", "resources/read"]) {
    const result = await helper({ jsonrpc: "2.0", id: 10, method, params: method === "resources/read" ? { uri: "file:///private-data" } : {} });
    assert.equal(result.error.code, -32601, "The response-only helper must expose no MCP resources");
  }
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "proactive_respond", arguments: response } };
  const rejected = await helper(call, { requestClient: async () => ({ action: "cancel" }) });
  assert.equal(rejected.result.isError, true); assert.equal(f.service.proactiveStore.occurrenceForRun(run.id).response, null);
  const result = await helper({ ...call, id: 3 }, { requestClient: async (method, proof) => {
    assert.equal(method, "elicitation/create");
    return f.host.request("mcpServer/elicitation/request", { ...proof, serverName: "shoggoth",
      threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId });
  } });
  assert.equal(result.result.isError, false, JSON.stringify(result));
  assert.equal(result.result.structuredContent.accepted, true);
  f.host.complete(run, "Plain text is not a separate notification"); await f.service.proactiveScheduler.waitForIdle();
  const rows = (await f.sessions()).filter(row => row.proactiveTarget); assert.equal(rows.length, 1);
  const history = await f.ipc("chat.history", { sessionKey: rows[0].sessionKey, cursor: null, limit: 100 });
  assert.equal(history.messages.filter(row => row.payload.message.shoggoth?.proactiveNotice).length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.host.ephemeralHistoryReads, 0);
  await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle(); assert.equal(f.host.turnStarts, 1);
});
test("SparkNotes model reviews a pending approval in a separate session without answering it", async t => {
  const f = await fixture(t);
  const { idea } = await f.ipc("inspiration.create", { operationId: id(), body: "灵感种子" });
  const profile = f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const started = (await f.ipc("inspiration.start", { operationId: id(), id: idea.id, expectedRevision: idea.revision, agentId: profile.agentId, backendId: profile.backendId, instruction: "", workspace: null })).idea;
  const runId = started.latestExecution.runId;
  const listed = await f.backend.proactiveCall("proactive.runs.list", { profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 50 });
  assert.equal(listed.runs.length, 1);
  assert.equal(listed.runs[0].id, runId);
  assert.deepEqual(listed.runs[0], { id: runId, source: "inspiration", sourceId: idea.id,
    status: f.service.workDispatcher.getRun(runId).status });
  await until(() => f.service.workDispatcher.getRun(runId).status === "running");
  const pendingApproval = f.host.approve(f.service.workDispatcher.getRun(runId)); void pendingApproval.catch(() => {});
  await until(() => f.service.workDispatcher.getRun(runId).status === "waiting_approval");
  const heartbeat = { ...(await f.monitor()).monitor.config, enabled: true, activeHours: null,
    checklist: [{ id: "scoped-idea", instruction: "Review the selected task", enabled: true, mode: "attention" }],
    scopes: { inspiration: false, runIds: [runId] } };
  const scoped = await f.ipc("proactive.preview", { config: heartbeat });
  assert.equal(scoped.candidates.length, 1); assert.equal(scoped.candidates[0].ideaId, idea.id);
  assert.equal((await f.ipc("proactive.preview", { config: { ...heartbeat, scopes: { ...heartbeat.scopes, inspiration: true } } })).candidates.length, 1);
  const { monitor } = await f.monitor("inspiration"); const config = { ...monitor.config, enabled: true,
    schedule: { kind: "cron", expr: "1 10 * * *", tz: "UTC" }, timezone: "UTC",
    review: { ...monitor.config.review, groups: ["attention", "sprouted"] } };
  await f.save(config); f.clock.value += 60000; await f.service.proactiveScheduler.tick();
  await until(() => f.service.workDispatcher.listRuns({ source: "proactive" })[0]?.status === "running");
  const reviewRun = f.service.workDispatcher.listRuns({ source: "proactive" })[0];
  assert.equal(f.service.workDispatcher.getRun(runId).status, "waiting_approval");
  assert.notEqual(reviewRun.runtimeSessionRef.sessionId, f.service.workDispatcher.getRun(runId).runtimeSessionRef.sessionId);
  const review = f.service.proactiveStore.occurrenceForRun(reviewRun.id);
  assert.deepEqual(review.candidates.map(item => item.group), ["attention"]);
  f.service.proactiveService.respond(reviewRun, { runId: reviewRun.id, outcome: "notice",
    candidates: review.candidates.map(({ id, evidenceVersion }) => ({ id, evidenceVersion })), reason: "An active approval merits a reminder", body: "这个待审批请求需要你查看。" });
  f.host.complete(reviewRun, "Review complete"); await f.service.proactiveScheduler.waitForIdle();
  const checks = f.service.proactiveStore.history(config.id); assert.equal(checks[0].state, "published", JSON.stringify(checks[0]));
  assert.equal(f.host.turnStarts, 2); assert.equal(f.service.workDispatcher.listRuns({ source: "proactive" }).length, 1);
  assert.equal(f.service.workDispatcher.getRun(runId).status, "waiting_approval");
  const notice = f.service.proactiveStore.noticeForOccurrence(checks[0].id), live = await f.ipc("proactive.notice.get", { id: notice.id });
  assert.equal(live.items[0].reason, "waiting_approval"); assert.equal(live.items[0].actionable, true);
  assert.match(live.items[0].href, /^\/inspirations\?/u);
  assert.equal((await f.ipc("proactive.preview", { config: heartbeat })).candidates.length, 0,
    "Selecting the same Inspiration Run must not bypass the note's seven-day cooldown");
  const requestId = f.service.workDispatcher.getRun(runId).waitingRequestId;
  await f.ipc("inspiration.respond", { operationId: id(), id: idea.id, runId, requestId, response: { choice: "once" } });
  assert.deepEqual(await pendingApproval, { decision: "accept" });
  assert.equal((await f.ipc("proactive.notice.get", { id: notice.id })).items[0].actionable, false);
  assert.equal((await f.ipc("proactive.preview", { config })).candidates.filter(item => item.group === "attention").length, 0);
  assert.equal(f.host.turnStarts, 2);
});
test("scoped Chat reminders and saved legacy notices open the authoritative composite session key", async t => {
  const f = await fixture(t), profile = f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const gatewayKey = await f.backend.createSession(profile.agentId), sessionKey = gatewayKey.slice(`agent:${profile.agentId}:`.length);
  const accepted = await f.ipc("chat.send", { operationId: id(), sessionKey, prompt: "Original authorized task", createdAt: f.clock.value });
  const runId = accepted.run.id; await until(() => f.service.workDispatcher.getRun(runId).status === "running");
  const pending = f.host.approve(f.service.workDispatcher.getRun(runId)); void pending.catch(() => {});
  await until(() => f.service.workDispatcher.getRun(runId).status === "waiting_approval");
  const config = { ...(await f.monitor()).monitor.config, enabled: true, activeHours: null,
    checklist: [{ id: "selected-task", instruction: "Review the selected task", enabled: true, mode: "attention" }],
    scopes: { inspiration: false, runIds: [runId] } };
  await f.save(config); f.clock.value += 30 * 60000;
  await f.service.proactiveScheduler.tick();
  await until(() => f.service.workDispatcher.listRuns({ source: "proactive" })[0]?.status === "running");
  const reviewRun = f.service.workDispatcher.listRuns({ source: "proactive" })[0];
  const occurrence = f.service.proactiveStore.occurrenceForRun(reviewRun.id);
  f.service.proactiveService.respond(reviewRun, { runId: reviewRun.id, outcome: "notice", reason: "Worth reviewing", body: "查看原任务中的有效请求。",
    candidates: occurrence.candidates.map(({ id, evidenceVersion }) => ({ id, evidenceVersion })) });
  f.host.complete(reviewRun, "Review complete"); await f.service.proactiveScheduler.waitForIdle();
  const check = f.service.proactiveStore.history(config.id)[0], notice = f.service.proactiveStore.noticeForOccurrence(check.id);
  assert.equal(check.state, "published");
  const href = new URL(notice.items[0].href, "http://fixture.local");
  assert.equal(href.searchParams.get("backend"), profile.backendId);
  assert.equal(href.searchParams.get("session"), gatewayKey);
  assert.ok((await f.backend.getHistory(href.searchParams.get("session"))).messages.length > 0);
  const legacy = { ...notice.items[0], href: `/chat?backend=shoggoth&session=${sessionKey}` };
  f.service.proactiveStore.updateNotice(notice.id, { items: [legacy] });
  const current = await f.backend.proactiveCall("proactive.notice.get", { id: notice.id });
  assert.equal(new URL(current.items[0].href, "http://fixture.local").searchParams.get("session"), gatewayKey);
  assert.equal(f.sent.length, 1); assert.equal(f.host.turnStarts, 2);
});
test("unstructured ack stays silent and disabling an active check rejects its later tool response", async t => {
  const f = await fixture(t), { monitor } = await f.monitor();
  const config = { ...monitor.config, enabled: true, activeHours: null,
    checklist: [{ id: "review-state", instruction: "Review supplied state", enabled: true, mode: "review" }] };
  await f.save(config); f.clock.value += 30 * 60000; await f.service.proactiveScheduler.tick();
  await until(() => f.service.workDispatcher.listRuns({ source: "proactive" })[0]?.status === "running");
  const first = f.service.workDispatcher.listRuns({ source: "proactive" })[0];
  f.host.emit(normalizeCodexEvent({ method: "turn/completed", params: {
    threadId: first.runtimeSessionRef.sessionId, turn: { id: first.runtimeTurnRef.turnId },
  } }));
  f.host.emit(normalizeCodexEvent({ method: "turn/completed", params: {
    threadId: first.runtimeSessionRef.sessionId, turn: { id: "unrelated-turn", status: "completed" },
  } }));
  await f.service.workRunCoordinator.waitForIdle(first.id);
  assert.equal(f.service.workDispatcher.getRun(first.id).status, "running");
  f.host.complete(first, "HEARTBEAT_OK"); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.service.proactiveStore.occurrenceForRun(first.id).reason, "no_structured_response");
  assert.equal(f.sent.length, 0); assert.equal((await f.sessions()).length, f.baselineSessions);
  const updated = { ...config, checklist: [{ ...config.checklist[0], instruction: "Review changed state" }] };
  await f.save(updated, 2); f.clock.value += 30 * 60000; await f.service.proactiveScheduler.tick();
  await until(() => f.service.workDispatcher.listRuns({ source: "proactive" }).some(run => run.id !== first.id && run.status === "running"));
  const second = f.service.workDispatcher.listRuns({ source: "proactive" }).find(run => run.id !== first.id);
  const occurrence = f.service.proactiveStore.occurrenceForRun(second.id), candidate = occurrence.candidates[0];
  await f.save({ ...updated, enabled: false }, 3);
  assert.throws(() => f.service.proactiveService.respond(second, { runId: second.id, outcome: "notice", candidates: [{ id: candidate.id, evidenceVersion: candidate.evidenceVersion }], reason: "Changed state", body: "Should be suppressed" }), { code: "PROACTIVE_SCOPE_INVALID" });
  await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.sent.length, 0); assert.equal((await f.sessions()).length, f.baselineSessions);
});
test("expired reply authority is excluded from reminders without answering or cancelling the original request", async t => {
  const f = await fixture(t), { idea } = await f.ipc("inspiration.create", { operationId: id(), body: "等待审批的灵感" });
  const profile = f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const started = (await f.ipc("inspiration.start", { operationId: id(), id: idea.id, expectedRevision: idea.revision, agentId: profile.agentId, backendId: profile.backendId, instruction: "", workspace: null })).idea;
  const runId = started.latestExecution.runId; await until(() => f.service.workDispatcher.getRun(runId).status === "running");
  let answered = false; const pending = f.host.approve(f.service.workDispatcher.getRun(runId));
  void pending.then(() => { answered = true; }, () => {});
  await until(() => f.service.workDispatcher.getRun(runId).status === "waiting_approval");
  const { monitor } = await f.monitor("inspiration"), config = { ...monitor.config, enabled: true, review: { ...monitor.config.review, groups: ["attention"] } };
  assert.equal((await f.ipc("proactive.preview", { config })).candidates.length, 1);
  f.clock.value += DAY_MS;
  assert.equal((await f.ipc("proactive.preview", { config })).candidates.length, 0);
  assert.equal(answered, false); assert.equal(f.host.interrupts, 0); assert.equal(f.service.workDispatcher.getRun(runId).status, "waiting_approval");
});
test("slow capability metadata verification completes through direct IPC and the UI backend", async t => {
  const f = await fixture(t);
  let checks = 0;
  f.service.proactiveService.verifyCapability = async () => {
    checks += 1;
    await new Promise(resolve => setTimeout(resolve, 5200));
  };
  const params = { profileId: DEFAULT_AGENT_PROFILE_ID };
  const responses = await Promise.all([
    f.ipc("proactive.runtime.verify", params),
    f.backend.proactiveCall("proactive.runtime.verify", params),
  ]);
  assert.equal(checks, 2);
  for (const result of responses) assert.equal(result.capabilities.semanticVerified, true);
  assert.equal(f.host.turnStarts, 0);
  assert.equal((await f.ipc("service.status", {})).healthy, true);
});
test("an Apps server remaining in the thread inventory rejects review before a model turn", async t => {
  const f = await fixture(t);
  f.host.mcpServerStatusList = async () => ({ data: [{ name: "shoggoth", tools: [] }, { name: "codex_apps", tools: [] }], nextCursor: null });
  const { monitor } = await f.monitor();
  await f.save({ ...monitor.config, enabled: true, activeHours: null,
    checklist: [{ id: "scoped-review", instruction: "Review the supplied state", enabled: true, mode: "review" }] });
  f.clock.value += 30 * 60000;
  await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle();
  const run = f.service.workDispatcher.listRuns({ source: "proactive" })[0];
  assert.equal(run.status, "failed"); assert.equal(f.host.turnStarts, 0); assert.equal(f.sent.length, 0);
});
test("missing or extra response tools fail closed before a review model turn", async t => {
  for (const tools of [[], {}, { other: { name: "notification_send" } },
    { proactive_respond: { name: "proactive_respond" }, other: { name: "notification_send" } }]) {
    const f = await fixture(t);
    f.host.mcpServerStatusList = async () => ({ data: [{ name: "shoggoth", tools }], nextCursor: null });
    const { monitor } = await f.monitor();
    await f.save({ ...monitor.config, enabled: true, activeHours: null,
      checklist: [{ id: "response-required", instruction: "Review the supplied checklist", enabled: true, mode: "review" }] });
    f.clock.value += 30 * 60000;
    await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle();
    assert.equal(f.service.workDispatcher.listRuns({ source: "proactive" })[0].status, "failed");
    assert.equal(f.host.turnStarts, 0); assert.equal(f.sent.length, 0);
  }
});

test("SparkNotes initializes and wakes itself without a renderer or monitor configuration call", async t => {
  const f = await fixture(t, { autoSparkNotes: true });
  const initial = (await f.monitor("inspiration")).monitor;
  assert.equal(initial.revision, 1); assert.equal(initial.config.enabled, true);
  assert.equal(initial.config.profileId, DEFAULT_AGENT_PROFILE_ID);
  assert.deepEqual(initial.config.review.groups, ["seed", "attention", "sprouted"]);
  f.clock.value = initial.nextRunAt; await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.host.turnStarts, 0); assert.equal(f.sent.length, 0);
  await f.ipc("inspiration.create", { operationId: id(), body: "一个值得模型决定是否回顾的灵感" });
  f.clock.value += 2 * DAY_MS; await f.service.proactiveScheduler.tick();
  await until(() => f.service.workDispatcher.listRuns({ source: "proactive" })[0]?.status === "running");
  const run = f.service.workDispatcher.listRuns({ source: "proactive" })[0];
  f.service.proactiveService.respond(run, { runId: run.id, outcome: "silent", candidates: [], reason: "Not worth interrupting now", body: "" });
  f.host.complete(run, "Silent"); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.service.proactiveStore.occurrenceForRun(run.id).reason, "model_silent");
  assert.equal(f.sent.length, 0); assert.equal((await f.sessions()).length, f.baselineSessions);
  await f.service.stop({ notify: false }); await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal((await f.monitor("inspiration")).monitor.revision, 1); assert.equal(f.host.turnStarts, 1);
});

async function heartbeatFile(f, content) {
  const profile = f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const before = await f.backend.getAgentFile(profile.agentId, "HEARTBEAT.md");
  await f.backend.setAgentFile(profile.agentId, "HEARTBEAT.md", content, { expectedRevision: before.revision });
  return f.backend.getAgentFile(profile.agentId, "HEARTBEAT.md");
}
async function startHeartbeat(f) {
  f.clock.value += 30 * 60000; await f.service.proactiveScheduler.tick();
  await until(() => f.service.workDispatcher.listRuns({ source: "proactive" }).some(run => run.status === "running"));
  return f.service.workDispatcher.listRuns({ source: "proactive" }).find(run => run.status === "running");
}
test("HEARTBEAT file facade, bounded web evidence and structured scratch survive restart without changing user rules", async t => {
  const calls = [], f = await fixture(t, { webService: { async call(name, args, options) {
    calls.push({ name, args }); assert.ok(options.signal); assert.equal(options.profileId, DEFAULT_AGENT_PROFILE_ID);
    if (name === "web_search") throw Object.assign(new Error("provider detail must stay private"), { code: "WEB_RATE_LIMITED" });
    return { text: "Release 3 is available.", title: "Release 3", finalUrl: args.url, retrievedAt: new Date(0).toISOString(), untrusted: true, truncated: false };
  } } });
  const content = "---\nweb:\n  - kind: fetch\n    url: https://example.com/status\n  - kind: search\n    query: project releases\n---\nOnly notify me about a new release. Record the last release in working notes.";
  const document = await heartbeatFile(f, content), config = { ...(await f.monitor()).monitor.config, enabled: true, activeHours: null };
  assert.equal(document.content, content);
  await assert.rejects(() => f.ipc("proactive.document.set", { profileId: DEFAULT_AGENT_PROFILE_ID, content: "stale", expectedRevision: "0".repeat(64) }), { code: "PROACTIVE_REVISION_CONFLICT" });
  await f.save(config); const run = await startHeartbeat(f);
  const occurrence = f.service.proactiveStore.occurrenceForRun(run.id);
  assert.deepEqual(calls.map(c => c.name), ["web_fetch", "web_search"]);
  assert.equal(occurrence.heartbeat.web[0].result.text, "Release 3 is available.");
  assert.equal(occurrence.heartbeat.web[0].result.title, "Release 3");
  assert.deepEqual(occurrence.heartbeat.web[1].result, { errorCode: "WEB_RATE_LIMITED" });
  assert.equal(occurrence.heartbeat.scratch.revision, 0);
  assert.deepEqual(f.host.lastStart.config["mcp_servers.shoggoth.enabled_tools"], ["proactive_respond"]);
  const response = { runId: run.id, outcome: "notice", candidates: occurrence.candidates.map(({ id, evidenceVersion }) => ({ id, evidenceVersion })),
    reason: "New release", body: "Release 3 is available. The search source was rate limited.", scratch: "Last seen: release 3." };
  const scope = { runId: run.id, assertCurrent: () => f.service.proactiveService.assertRunCurrent(f.service.workDispatcher.getRun(run.id)) };
  const authority = { profileId: run.profileId, callId: id() };
  await assert.rejects(() => f.service.mcpProductToolController.handle("web_fetch", { url: "https://example.com" }, authority, scope), { code: "MCP_TOOL_FORBIDDEN" });
  assert.equal((await f.service.mcpProductToolController.handle("proactive_respond", response, authority, scope)).accepted, true);
  assert.equal((await f.ipc("proactive.scratch.get", { profileId: run.profileId })).scratch.content, "");
  f.host.complete(run, "done"); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.service.proactiveStore.history(config.id)[0].state, "published");
  assert.equal((await f.ipc("proactive.scratch.get", { profileId: run.profileId })).scratch.content, "Last seen: release 3.");
  await f.service.stop({ notify: false }); await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal((await f.ipc("proactive.scratch.get", { profileId: run.profileId })).scratch.content, "Last seen: release 3.");
  assert.equal((await f.ipc("proactive.document.get", { profileId: run.profileId })).document.content, content);
  assert.equal(f.sent.length, 1); assert.equal(calls.length, 2);
});
test("cleared scratch wins over an in-flight model proposal; failed runs never save scratch", async t => {
  const f = await fixture(t); await heartbeatFile(f, "Review the supplied state. Stay silent unless it changed.");
  await f.ipc("proactive.scratch.set", { profileId: DEFAULT_AGENT_PROFILE_ID, content: "Old note", expectedRevision: 0 });
  await f.save({ ...(await f.monitor()).monitor.config, enabled: true, activeHours: null });
  const run = await startHeartbeat(f);
  await f.ipc("proactive.scratch.set", { profileId: run.profileId, content: "", expectedRevision: 1 });
  f.service.proactiveService.respond(run, { runId: run.id, outcome: "silent", candidates: [], reason: "No change", body: "", scratch: "Stale proposal" });
  f.host.complete(run, "done"); await f.service.proactiveScheduler.waitForIdle();
  assert.equal((await f.ipc("proactive.scratch.get", { profileId: run.profileId })).scratch.content, "");
  const next = await startHeartbeat(f);
  f.service.proactiveService.respond(next, { runId: next.id, outcome: "silent", candidates: [], reason: "No change", body: "", scratch: "Uncommitted proposal" });
  await f.service.workRunCoordinator.stopProactiveRun(next.id); await f.service.proactiveScheduler.waitForIdle();
  assert.equal((await f.ipc("proactive.scratch.get", { profileId: run.profileId })).scratch.content, "");
  assert.equal(f.sent.length, 0);
});
test("editing HEARTBEAT during collection cancels network evidence and starts no model turn", async t => {
  let started = false, canceled = false;
  const f = await fixture(t, { webService: { async call(_name, _args, { signal }) {
    started = true;
    await new Promise(resolve => signal.addEventListener("abort", () => { canceled = true; resolve(); }, { once: true }));
    throw Object.assign(new Error("canceled"), { code: "WEB_CANCELED" });
  } } });
  await heartbeatFile(f, "---\nweb:\n  - kind: fetch\n    url: https://example.com\n---\nCheck releases.");
  const config = { ...(await f.monitor()).monitor.config, enabled: true, activeHours: null }; await f.save(config);
  f.clock.value += 30 * 60000; await f.service.proactiveScheduler.tick(); await until(() => started);
  await heartbeatFile(f, "# Heartbeat\n<!-- paused -->"); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(canceled, true); assert.equal(f.host.turnStarts, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.service.proactiveStore.history(config.id)[0].reason, "disabled_or_stale");
  f.clock.value += 30 * 60000; await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.service.proactiveStore.history(config.id)[0].reason, "empty_checklist");
});
test("external rule edits invalidate a completed response before notice or scratch publication", async t => {
  const f = await fixture(t); await heartbeatFile(f, "Review project status.");
  const config = { ...(await f.monitor()).monitor.config, enabled: true, activeHours: null }; await f.save(config);
  const run = await startHeartbeat(f), occurrence = f.service.proactiveStore.occurrenceForRun(run.id);
  f.service.proactiveService.respond(run, { runId: run.id, outcome: "notice",
    candidates: occurrence.candidates.map(({ id, evidenceVersion }) => ({ id, evidenceVersion })),
    reason: "A change", body: "Old rules would notify.", scratch: "Old decision" });
  fs.writeFileSync(path.join(f.paths.agentsDir, run.profileId, "HEARTBEAT.md"), "New rules: only notify on a failure.");
  f.host.complete(run, "done"); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.ipc("proactive.scratch.get", { profileId: run.profileId })).scratch.content, "");
  assert.equal(f.service.proactiveStore.history(config.id)[0].reason, "disabled_or_stale");
});
test("empty files and daily budgets avoid network and model calls", async t => {
  let calls = 0; const f = await fixture(t, { webService: { async call() { calls++; return { text: "unchanged", retrievedAt: new Date(0).toISOString() }; } } });
  const base = (await f.monitor()).monitor.config, config = { ...base, enabled: true, activeHours: null, budget: { ...base.budget, maxRunsPerDay: 1 } };
  await f.save(config); f.clock.value += 30 * 60000; await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(calls, 0); assert.equal(f.host.turnStarts, 0);
  await heartbeatFile(f, "---\nweb:\n  - kind: fetch\n    url: https://example.com\n---\nReview only changes.");
  const run = await startHeartbeat(f);
  f.service.proactiveService.respond(run, { runId: run.id, outcome: "silent", candidates: [], reason: "Unchanged", body: "", scratch: "unchanged" });
  f.host.complete(run, "done"); await f.service.proactiveScheduler.waitForIdle();
  f.clock.value += 30 * 60000; await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(calls, 1); assert.equal(f.host.turnStarts, 1);
  assert.equal(f.service.proactiveStore.history(config.id)[0].reason, "budget_exhausted");
});

test("a failed web source remains visible as failure even when the model returns silent", async t => {
  const f = await fixture(t, { webService: { async call() { throw Object.assign(new Error("offline"), { code: "WEB_UNAVAILABLE" }); } } });
  await heartbeatFile(f, "---\nweb:\n  - kind: fetch\n    url: https://example.com\n---\nCheck changes.");
  const config = { ...(await f.monitor()).monitor.config, enabled: true, activeHours: null }; await f.save(config);
  const run = await startHeartbeat(f);
  f.service.proactiveService.respond(run, { runId: run.id, outcome: "silent", candidates: [], reason: "No evidence", body: "" });
  f.host.complete(run, "done"); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.service.proactiveStore.history(config.id)[0].reason, "web_source_failed");
  assert.equal(f.sent.length, 0);
});

test("heartbeat preserves bounded page titles and detects title-only evidence changes", async t => {
  let title = "Release 1";
  const f = await fixture(t, { webService: { async call(_name, args) {
    return { text: "Stable page body.", title, finalUrl: args.url, retrievedAt: new Date(0).toISOString(), truncated: false };
  } } });
  await heartbeatFile(f, "---\nweb:\n  - kind: fetch\n    url: https://example.com/status\n---\nCompare the current page title to the previous title.");
  await f.save({ ...(await f.monitor()).monitor.config, enabled: true, activeHours: null });
  const versions = [];
  for (const value of ["Release 1", "Release 2", "🌱".repeat(2000)]) {
    title = value;
    const run = await startHeartbeat(f), occurrence = f.service.proactiveStore.occurrenceForRun(run.id);
    const collected = occurrence.heartbeat.web[0].result.title;
    assert.equal(collected.isWellFormed(), true);
    assert.ok(Buffer.byteLength(JSON.stringify(collected)) <= 512);
    if (value.length < 512) assert.equal(collected, value);
    versions.push(occurrence.candidates[0].evidenceVersion);
    await f.service.mcpProductToolController.handle("proactive_respond", { runId: run.id, outcome: "silent", candidates: [], reason: "Checked", body: "" },
      { profileId: run.profileId, callId: id() }, { runId: run.id, assertCurrent: () => f.service.proactiveService.assertRunCurrent(f.service.workDispatcher.getRun(run.id)) });
    f.host.complete(run, "done"); await f.service.proactiveScheduler.waitForIdle();
  }
  assert.equal(new Set(versions).size, 3);
  assert.equal(f.sent.length, 0);
});

test("heartbeat preserves Exa textual quota failures as failed source evidence", async t => {
  const { WebService } = require(path.join(productRoot, "agent-service/web-service.js"));
  const webService = new WebService({ request: async (_url, options) => {
    const rpc = JSON.parse(options.body);
    const result = rpc.method === "initialize" ? { protocolVersion: "2025-03-26" }
      : { content: [{ type: "text", text: "You've hit Exa's free MCP rate limit. Create your own API key." }] };
    return { headers: {}, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })) };
  } });
  const f = await fixture(t, { webService });
  await heartbeatFile(f, "---\nweb:\n  - kind: search\n    query: project releases\n---\nStay silent on a source failure, and do not claim that nothing changed.");
  await f.save({ ...(await f.monitor()).monitor.config, enabled: true, activeHours: null });
  const run = await startHeartbeat(f), occurrence = f.service.proactiveStore.occurrenceForRun(run.id);
  assert.deepEqual(occurrence.heartbeat.web[0].result, { errorCode: "WEB_RATE_LIMITED" });
  f.service.proactiveService.respond(run, { runId: run.id, outcome: "silent", candidates: [], reason: "Unable to verify", body: "" });
  f.host.complete(run, "done"); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.service.proactiveStore.history(occurrence.monitorId)[0].reason, "web_source_failed");
  assert.equal(f.sent.length, 0);
});

test("native chat MCP edits every heartbeat parameter, shares UI revisions and persists without changing rules or other Agents", async t => {
  const f = await fixture(t), sessionKey = (await f.sessions())[0].sessionKey;
  const accepted = await f.ipc("chat.send", { operationId: id(), sessionKey,
    prompt: "把你的心跳设为每15分钟、每天20次、预算500万、09:00到20:00，时区纽约，关闭系统通知。", createdAt: f.clock.value });
  await until(() => f.service.workDispatcher.getRun(accepted.run.id).status === "running");
  const run = f.service.workDispatcher.getRun(accepted.run.id), profile = f.service.productStore.getAgentProfile(run.profileId);
  assert.equal(run.source, "chat");
  const other = (await f.ipc("agent.create", { operationId: id(), backendId: "shoggoth", name: "Other heartbeat",
    defaultCwd: null, createdAt: f.clock.value })).profile;
  const otherBefore = f.service.proactiveStore.monitors(other.id);
  const initial = (await f.monitor()).monitor;
  await f.save({ ...initial.config,
    checklist: [{ id: "keep", instruction: "Keep this rule", mode: "review", enabled: false }],
    scopes: { inspiration: false, runIds: [run.id] }, target: { mode: "explicit", sessionKey } });
  const before = (await f.monitor()).monitor;
  const rules = "# User rules\nPreserve these rules across settings changes.";
  await heartbeatFile(f, rules);
  const notes = await f.ipc("proactive.scratch.set", { profileId: profile.id, content: "Keep my working notes", expectedRevision: 0 });
  const session = await authenticateMcpSession({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId, safeStorage: f.safeStorage, requestService });
  const helper = createMcpStdioHandler({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId, sessionToken: session.token, bindRuntimeCalls: true,
    now: () => f.clock.value, requestService });
  t.after(() => helper.close());
  await helper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
    capabilities: { elicitation: {} }, clientInfo: { name: "heartbeat-settings-fixture", version: "1" } } });
  let seq = 2;
  const tools = []; let cursor;
  do {
    const result = await helper({ jsonrpc: "2.0", id: seq++, method: "tools/list", params: cursor ? { cursor } : {} });
    tools.push(...result.result.tools.map(tool => tool.name)); cursor = result.result.nextCursor;
  } while (cursor);
  for (const name of ["heartbeat_settings_get", "heartbeat_settings_set"]) assert(tools.includes(name));
  const call = async (name, args, errorCode) => {
    const result = await helper({ jsonrpc: "2.0", id: seq++, method: "tools/call", params: { name, arguments: args } }, {
      requestClient: async (method, proof) => {
        assert.equal(method, "elicitation/create");
        assert.ok(proof._meta?.["shoggoth/runtime-call-binding"], "own settings need only the trusted Runtime binding");
        return f.host.request("mcpServer/elicitation/request", { ...proof, serverName: "shoggoth",
          threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId });
      },
    });
    assert.equal(result.result.isError, !!errorCode, JSON.stringify(result));
    const value = result.result.structuredContent;
    if (errorCode) assert.equal(value.error.code, errorCode);
    return value;
  };
  const read = await call("heartbeat_settings_get", {});
  assert.equal(read.revision, before.revision);
  const config = { enabled: false, intervalMinutes: 15, maxRunsPerDay: 20, maxTokensPerDay: 5_000_000,
    timezone: "America/New_York", activeHours: { start: "09:00", end: "20:00" }, push: false };
  const saved = await call("heartbeat_settings_set", { expectedRevision: read.revision, config });
  assert.deepEqual(saved.config, config); assert.equal(saved.nextRunAt, null);
  assert.equal(saved.resolvedTimezone, "America/New_York");
  const ui = (await f.backend.proactiveCall("proactive.monitor.get", { kind: "heartbeat", profileId: profile.id })).monitor;
  assert.equal(ui.revision, saved.revision); assert.equal(ui.config.schedule.everyMs, 15 * 60_000);
  for (const key of ["checklist", "scopes", "target"]) assert.deepEqual(ui.config[key], before.config[key]);
  await call("heartbeat_settings_set", { expectedRevision: read.revision, config: { maxRunsPerDay: 1 } }, "PROACTIVE_REVISION_CONFLICT");
  const enabled = await call("heartbeat_settings_set", { expectedRevision: saved.revision,
    config: { enabled: true, timezone: "system", activeHours: null, maxTokensPerDay: 10_000_000, push: true } });
  assert.equal(enabled.config.enabled, true); assert.equal(enabled.config.intervalMinutes, 15);
  assert.equal(enabled.config.maxRunsPerDay, 20); assert.equal(enabled.config.maxTokensPerDay, 10_000_000);
  assert.equal(enabled.config.timezone, "system"); assert.equal(enabled.config.activeHours, null); assert.equal(enabled.config.push, true);
  assert.equal(enabled.resolvedTimezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(enabled.nextRunAt, f.clock.value + 15 * 60_000);
  const changedInUi = (await f.monitor()).monitor;
  const uiSaved = await f.save({ ...changedInUi.config, budget: { ...changedInUi.config.budget, maxRunsPerDay: 24 } }, changedInUi.revision);
  const updated = await call("heartbeat_settings_get", {});
  assert.equal(updated.revision, uiSaved.revision); assert.equal(updated.config.maxRunsPerDay, 24);
  const final = await call("heartbeat_settings_set", { expectedRevision: updated.revision, config: { enabled: false } });
  assert.equal((await f.ipc("proactive.document.get", { profileId: profile.id })).document.content, rules);
  assert.deepEqual(await f.ipc("proactive.scratch.get", { profileId: profile.id }), notes);
  assert.deepEqual(f.service.proactiveStore.monitors(other.id), otherBefore);
  f.host.complete(run, "Heartbeat settings saved"); await until(() => f.service.workDispatcher.getRun(run.id).status === "completed");
  await f.service.stop({ notify: false }); await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
  const after = (await f.monitor()).monitor;
  assert.equal(after.revision, final.revision); assert.equal(after.config.enabled, false);
  assert.equal(after.config.schedule.everyMs, 15 * 60_000); assert.equal(after.config.budget.maxRunsPerDay, 24);
  assert.equal(after.config.budget.maxTokensPerDay, 10_000_000); assert.equal(after.config.timezone, "system");
  assert.equal(f.host.turnStarts, 1, "settings changes never create another model turn");
});

test("heartbeat settings remain editable before Runtime verification while actual review stays gated", async t => {
  const f = await fixture(t), service = f.service.proactiveService;
  service.getCapability = () => ({ semanticVerified: false, reason: "PROACTIVE_RUNTIME_UNVERIFIED" });
  service.verifyCapability = async () => { throw Object.assign(new Error("Unsupported review Runtime"), { code: "PROACTIVE_RUNTIME_UNVERIFIED" }); };
  const monitor = (await f.monitor()).monitor;
  const saved = await f.save({ ...monitor.config, activeHours: null,
    budget: { maxRunsPerDay: 24, maxTokensPerDay: 10_000_000 } }, monitor.revision);
  assert.equal(saved.config.enabled, true);
  await heartbeatFile(f, "Review this rule only after Runtime verification.");
  f.clock.value += 30 * 60_000; await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.host.turnStarts, 0);
  assert.equal(f.service.proactiveStore.history(saved.config.id)[0].reason, "runtime_unverified");
});

test("authenticated native MCP persists own/shared web choices and actual chat/HEARTBEAT routing uses them", async t => {
  const f = await fixture(t), key = "fixture-shared-native-web-key", requests = [];
  const profile = f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const web = f.service.mcpProductToolController.webService;
  web.lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  web.request = async (url, options) => {
    const host = new URL(url).hostname; requests.push({ host, options });
    if (host === "api.search.brave.com") return { body: Buffer.from(JSON.stringify({ web: { results: [{ url: "https://example.com/release", title: "Release", description: "Release 4" }] } })) };
    assert.equal(host, "api.fetch.tinyfish.ai");
    return { body: Buffer.from(JSON.stringify({ results: [{ url: "https://example.com/status", text: "Release 4 is available" }] })) };
  };
  for (const provider of ["brave", "tinyfish"]) await f.ipc("web.credentials.set", { provider, expectedRevision: null, apiKey: key });
  const { idea } = await f.ipc("inspiration.create", { operationId: id(), body: "Select my web providers" });
  const started = await f.ipc("inspiration.start", { operationId: id(), id: idea.id, expectedRevision: idea.revision,
    agentId: profile.agentId, backendId: profile.backendId, instruction: "Choose web services", workspace: null });
  const runId = started.idea.latestExecution.runId; await until(() => f.service.workDispatcher.getRun(runId).status === "running");
  const run = f.service.workDispatcher.getRun(runId);
  const session = await authenticateMcpSession({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId, safeStorage: f.safeStorage, requestService });
  const helper = createMcpStdioHandler({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId, sessionToken: session.token, bindRuntimeCalls: true,
    now: () => f.clock.value, requestService });
  t.after(() => helper.close());
  await helper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
    capabilities: { elicitation: {} }, clientInfo: { name: "web-preference-fixture", version: "1" } } });
  let seq = 2, confirmations = 0;
  const call = async (name, args, { errorCode, accept = true } = {}) => {
    const result = await helper({ jsonrpc: "2.0", id: seq++, method: "tools/call", params: { name, arguments: args } }, {
      requestClient: async (method, proof) => {
        assert.equal(method, "elicitation/create");
        if (proof._meta?.["shoggoth/runtime-call-binding"]) return f.host.request("mcpServer/elicitation/request", { ...proof, serverName: "shoggoth",
          threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId });
        confirmations++; assert.match(proof.message, /统一联网默认设置/u);
        return accept ? { action: "accept", content: { confirm_product_action: "确认执行" } } : { action: "cancel" };
      },
    });
    assert.equal(result.result.isError, !!errorCode, JSON.stringify(result));
    const content = result.result.structuredContent;
    if (errorCode) assert.equal(content.error.code, errorCode);
    assert(!JSON.stringify(content).includes(key)); assert(!JSON.stringify(content).includes("credentialRef"));
    return content;
  };
  const tools = []; let cursor;
  do {
    const result = await helper({ jsonrpc: "2.0", id: seq++, method: "tools/list", params: cursor ? { cursor } : {} });
    tools.push(...result.result.tools.map(tool => tool.name)); cursor = result.result.nextCursor;
  } while (cursor);
  for (const name of ["web_settings_get", "web_settings_set", "web_defaults_set"]) assert(tools.includes(name));
  const initial = await call("web_settings_get", {}); assert.equal(initial.agent.revision, 0);
  const own = await call("web_settings_set", { expectedRevision: 0, config: { searchProvider: "brave" } });
  assert.equal(own.effective.searchProvider, "brave"); assert.equal(confirmations, 0);
  const args = { expectedRevision: 0, config: { fetchProvider: "tinyfish" } };
  assert.deepEqual(await call("web_defaults_set", args, { accept: false }), { canceled: true });
  assert.equal((await f.ipc("web.settings.get", {})).revision, 0);
  const changed = await call("web_defaults_set", args); assert.equal(changed.effective.fetchProvider, "tinyfish");
  assert.equal(changed.effective.searchProvider, "brave"); assert.equal(confirmations, 2);
  assert.equal((await call("web_search", { query: "release" })).provider, "brave");
  assert.equal((await call("web_fetch", { url: "https://example.com/status" })).provider, "tinyfish");
  assert.equal(requests[0].options.headers["X-Subscription-Token"], key);
  assert.equal(requests[1].options.headers["X-API-Key"], key);
  assert.equal((await f.ipc("web.settings.get", {})).config.searchProvider, "exa", "own selection never changes global default");
  await call("web_settings_set", { expectedRevision: 0, config: { searchProvider: "tavily" } }, { errorCode: "WEB_SETTINGS_CONFLICT" });
  await call("web_settings_set", { expectedRevision: 1, config: { searchProvider: "tavily" } });
  await call("web_search", { query: "missing key" }, { errorCode: "WEB_API_KEY_REQUIRED" }); assert.equal(requests.length, 2);
  const restored = await call("web_settings_set", { expectedRevision: 2, config: { searchProvider: "brave", fetchProvider: null } });
  assert.equal(restored.source.fetchProvider, "global");
  f.host.complete(run, "Saved choices"); await until(() => f.service.workDispatcher.getRun(runId).status === "completed");
  // The same Service-owned WebService instance collects HEARTBEAT evidence.
  await heartbeatFile(f, "---\nweb:\n  - kind: fetch\n    url: https://example.com/status\n  - kind: search\n    query: releases\n---\nNotify on a new release.");
  await f.save({ ...(await f.monitor()).monitor.config, enabled: true, activeHours: null });
  const heartbeatRun = await startHeartbeat(f);
  assert.deepEqual(requests.map(row => row.host), ["api.search.brave.com", "api.fetch.tinyfish.ai", "api.fetch.tinyfish.ai", "api.search.brave.com"]);
  const occurrence = f.service.proactiveStore.occurrenceForRun(heartbeatRun.id);
  f.service.proactiveService.respond(heartbeatRun, { runId: heartbeatRun.id, outcome: "silent", candidates: [], reason: "No new release", body: "" });
  f.host.complete(heartbeatRun, "done"); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(occurrence.heartbeat.web[0].result.text, "Release 4 is available");
  await f.service.stop({ notify: false }); await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
  const after = f.service.mcpProductToolController.webSettings.agentSnapshot(profile.id);
  assert.equal(after.agent.revision, 3); assert.deepEqual(after.effective, { searchProvider: "brave", fetchProvider: "tinyfish" });
  assert.equal(after.credentials.brave.configured, true);
});
