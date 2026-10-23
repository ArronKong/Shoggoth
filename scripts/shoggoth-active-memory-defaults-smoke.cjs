"use strict";

// Actual Product Service + authenticated config IPC. All files, Profiles,
// transcripts and model replies are owned synthetic temporary fixtures.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID: alpha, AGENT_PROFILE_FIELDS } = require("../app/agent-service/product-store");
const { createConfigStore, projectNativeMemoryConfig } = require("../app/core/config-store");
const { ConversationMemoryService } = require("../app/agent-service/conversation-memory-service");
const { McpProductToolController } = require("../app/agent-service/mcp-product-tool-controller");
const { installLiteralMemoryModelControl } = require("./fixtures/literal-memory-model-control.cjs");

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fileQuery = "writing commit descriptions";
const fileFact = "Use concise commit descriptions for the amber telescope.";
const active = config => config.plugins?.entries?.["active-memory"];
const lexicalPolicy = config => ({ ...config, memory: { ...config.memory, search: {
  ...config.memory?.search, provider: "none", rememberAcrossConversations: false } } });
const emptyCounts = () => ({ model: 0, search: [], get: 0, indexedMemory: 0, candidates: 0 });

async function fixture(t, offlineConfig = lexicalPolicy({})) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-active-defaults-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, homeDir: root, userDataRoot: root,
    stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
  const store = createConfigStore(path.join(root, "config.json"));
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString("utf8") };
  let service, sequence = 0;
  const f = { root, paths, store, counts: emptyCounts(), acquisitions: 0,
    model: async () => assert.fail("this eligibility path must not call a model"),
    get service() { return service; }, get owner() { return service.memoryEngine; },
    resetCounts() { this.counts = emptyCounts(); },
    async open() {
      service = createAgentService({ paths, safeStorage, memoryCore: true, memoryCoreConfig: offlineConfig,
        prewarmMcpAuth: false, version: "active-memory-defaults-fixture",
        runtimeManager: { async acquire() { f.acquisitions++; assert.fail("literal memory fixture must not acquire a real Runtime"); },
          async stop() {}, async stopAll() {} } });
      await service.start(); installLiteralMemoryModelControl(service.memoryEngine);
      const owner = service.memoryEngine, search = owner.searchMemory.bind(owner), get = owner.getFile.bind(owner);
      owner.searchMemory = async input => { f.counts.search.push({ profileId: input.profileId, sources: input.sources }); return search(input); };
      owner.getFile = input => { f.counts.get++; return get(input); };
      owner.complete = async input => { f.counts.model++; return f.model(input); };
      return service;
    },
    async close() { if (service) { const current = service; await current.stop({ notify: false }); service = null; } },
    ipc(method, params) { return requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths),
      version: PROTOCOL_VERSION, method, params }, { timeoutMs: 30000 }); },
    async configure(config) {
      const current = store.read().nativeMemory;
      const next = projectNativeMemoryConfig(store.writeNativeMemoryConfig({ expectedRevision: current.revision, config }));
      assert.deepEqual(await this.ipc("memory.config.apply", next), next); return next;
    },
    async publishFreshDefault() { return this.configure(lexicalPolicy(store.read().nativeMemory.config)); },
    addProfile() {
      const original = service.productStore.getAgentProfile(alpha);
      const profile = Object.fromEntries(AGENT_PROFILE_FIELDS.map(key => [key, original[key]]));
      const id = crypto.randomUUID(), suffix = ++sequence;
      Object.assign(profile, { id, agentId: `default-peer-${suffix}`, name: `Synthetic peer ${suffix}`,
        runtimeProfileId: `default-peer-runtime-${suffix}`, isDefault: false });
      return service.productStore.putAgentProfile(profile);
    },
    session(profileId = alpha, workspace = null) {
      return service.chatSessionStore.createSession({ profileId, workspace,
        operationId: `default-parent-${crypto.randomUUID()}`, createdAt: Date.now() });
    },
    input(profileId = alpha, query = fileQuery, session = this.session(profileId)) {
      return { profile: service.productStore.getAgentProfile(profileId), query,
        run: { id: crypto.randomUUID(), profileId, source: "chat", sourceId: session.sessionKey, workspace: session.workspace } };
    },
    async recall(input) {
      await this.owner.prepareActiveMemory(input); const result = this.owner.takeActiveMemory(input);
      await this.owner.finishActiveMemoryRun(input.run); this.assertClean(input.run.profileId); return result;
    },
    seedFile(profileId = alpha, trigger = true) {
      this.owner.store.ensureProfile(profileId);
      const host = this.owner.host(profileId), file = path.join(host.workspaceDir, "MEMORY.md");
      fs.appendFileSync(file, `\n- ${fileFact}${trigger ? " <!-- trigger:writing commit; commit descriptions -->" : ""}\n`);
      if (!host.__defaultFixtureInstrumented) {
        const read = host.searchIndex.readIndexedSource.bind(host.searchIndex), candidates = host.searchIndex.listTriggerCandidates.bind(host.searchIndex);
        host.searchIndex.readIndexedSource = (relative, source) => { if (source === "memory") f.counts.indexedMemory++; return read(relative, source); };
        host.searchIndex.listTriggerCandidates = async options => { f.counts.candidates++; return candidates(options); };
        host.__defaultFixtureInstrumented = true;
      }
      return file;
    },
    seedHistory(profileId = alpha) {
      const session = this.session(profileId), binding = `binding-${crypto.randomUUID()}`;
      service.chatSessionStore.requestBinding(session.sessionKey, binding, Date.now());
      service.chatSessionStore.completeBinding(session.sessionKey, binding, `literal-session-${crypto.randomUUID()}`);
      const run = service.workDispatcher.enqueue({ id: crypto.randomUUID(), profileId, source: "chat", sourceId: session.sessionKey,
        workspace: null, idempotencyKey: `default-history-${crypto.randomUUID()}` });
      service.workDispatcher.admit(run.id); service.workDispatcher.transition(run.id, "running");
      service.transcriptStore.appendEvent({ profileId, sessionId: session.id, id: crypto.randomUUID(), runId: run.id,
        kind: "user", content: { text: "The session-only sapphire telescope calibration occurs each morning." } });
      service.workDispatcher.transition(run.id, "completed"); return session;
    },
    assertClean(profileId = alpha) {
      assert.equal(this.owner.activeMemory.pending.size, 0); assert.equal(this.owner.activeMemory.runtimes.size, 0);
      assert.equal(this.owner.activeMemory.runs.size, 0);
      const db = this.owner.host(profileId).database.db;
      assert.equal(db.prepare("SELECT count(*) AS n FROM memory_state WHERE namespace='active-memory-runtime' AND value IS NOT NULL").get().n, 0);
      assert.equal(this.acquisitions, 0);
    },
  };
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await f.open(); return f;
}
const noRecall = async (f, profileId = alpha) => {
  f.resetCounts(); const result = await f.recall(f.input(profileId));
  assert.equal(result?.content || "", "");
  assert.deepEqual(f.counts, emptyCounts(), "ineligible file recall must not search/get files or call a model");
};
const ordinarySearch = async (f, profileId) => {
  const session = f.session(profileId), service = f.service;
  const run = service.workDispatcher.enqueue({ id: crypto.randomUUID(), profileId, source: "chat", sourceId: session.sessionKey,
    workspace: null, idempotencyKey: `ordinary-search-${crypto.randomUUID()}` });
  service.workDispatcher.admit(run.id); service.workDispatcher.transition(run.id, "running");
  service.transcriptStore.appendEvent({ profileId, sessionId: session.id, id: crypto.randomUUID(), runId: run.id,
    kind: "user", content: { text: "Find the amber telescope memory." } });
  const memory = new ConversationMemoryService({ memoryEngine: service.memoryEngine, memoryStore: service.memoryStore,
    transcriptStore: service.transcriptStore, chatSessionStore: service.chatSessionStore, getRunSessionKey: () => session.sessionKey,
    memoryProvenanceService: service.memoryProvenanceService });
  const noop = () => null;
  const controller = new McpProductToolController({ productStore: service.productStore, conversationMemoryService: memory,
    conversationRecallService: service.conversationRecallService, permissionEngine: service.permissionEngine,
    domainController: { handle: noop }, kanbanStore: Object.fromEntries(["getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId", "addComment", "addArtifact", "listArtifacts"].map(key => [key, noop])),
    kanbanRunService: { requestCompletionFromAgent: noop }, cronStore: { getJob: noop }, workDispatcher: service.workDispatcher,
    getRuntimeContext: () => ({ source: run.source, sourceId: run.sourceId, profileId, runId: run.id }),
    notificationSender: noop, isSensitiveValue: () => false, artifactRoot: f.root });
  try { return await controller.handle("memory_search", { source: "chat", sourceId: session.sessionKey,
    query: "amber telescope", minScore: 0 }, { profileId, callId: crypto.randomUUID() }); }
  finally { service.workDispatcher.transition(run.id, "completed"); }
};

test("Core fresh defaults become active only after authenticated publication and include later real Profiles", { timeout: 30000 }, async t => {
  const f = await fixture(t); f.seedFile();
  await noRecall(f); assert.equal(f.service.nativeMemoryConfig.initialized, false);
  const seed = f.store.read().nativeMemory;
  assert.equal(active(seed.config).enabled, true); assert.equal(active(seed.config).config.mode, "escalate");
  assert.equal(Object.hasOwn(active(seed.config).config, "agents"), false);
  const applied = await f.publishFreshDefault();
  assert.match((await f.recall(f.input())).content, /concise commit descriptions/u);
  const peer = f.addProfile(); f.seedFile(peer.id);
  assert.match((await f.recall(f.input(peer.id))).content, /concise commit descriptions/u);
  assert.equal(f.counts.model, 0); assert.equal(f.acquisitions, 0);
  assert.deepEqual(await f.ipc("memory.config.read", {}), applied, "dynamic roster must not persist a current-Profile allowlist snapshot");
  assert.equal(Object.hasOwn(active(JSON.parse(fs.readFileSync(path.join(f.paths.stateDir, "native-memory-config.json"), "utf8")).config).config, "agents"), false);
});

test("authenticated omitted entry defaults on and omitted roster stays dynamic across a later Profile", { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.configure(lexicalPolicy({})); f.seedFile();
  assert.equal(f.owner.activeMemory.configuration(alpha).mode, "escalate");
  assert.match((await f.recall(f.input())).content, /concise commit descriptions/u);
  const peer = f.addProfile(); f.seedFile(peer.id);
  assert.match((await f.recall(f.input(peer.id))).content, /concise commit descriptions/u);
  assert.equal(active(f.store.read().nativeMemory.config), undefined, "runtime default projection does not rewrite the persisted config");
});

test("single-Profile exclusion survives real IPC persistence and Service restart without disabling ordinary memory_search", { timeout: 30000 }, async t => {
  const f = await fixture(t), peer = f.addProfile(); f.seedFile(); f.seedFile(peer.id);
  const config = lexicalPolicy({ plugins: { entries: { "active-memory": { config: { excludedAgents: [alpha] } } } } });
  await f.configure(config); await noRecall(f);
  assert.match((await f.recall(f.input(peer.id))).content, /concise commit descriptions/u);
  const found = await ordinarySearch(f, alpha);
  assert.ok(found.results.some(row => row.source === "memory" && row.snippet.includes("amber telescope")));
  const before = fs.readFileSync(path.join(f.paths.stateDir, "native-memory-config.json"));
  await f.close(); await f.open(); f.seedFile(); f.resetCounts();
  assert.deepEqual(fs.readFileSync(path.join(f.paths.stateDir, "native-memory-config.json")), before);
  await noRecall(f); const later = f.addProfile(); f.seedFile(later.id);
  assert.match((await f.recall(f.input(later.id))).content, /concise commit descriptions/u);
  const restored = structuredClone(config); delete active(restored).config.excludedAgents;
  await f.configure(restored); assert.match((await f.recall(f.input())).content, /concise commit descriptions/u);
  assert.equal(Object.hasOwn(active(f.store.read().nativeMemory.config).config, "agents"), false);
});

test("explicit legacy empty and partial lists keep their meanings and exclusions subtract from the original list", { timeout: 30000 }, async t => {
  const f = await fixture(t), peer = f.addProfile(); f.seedFile(); f.seedFile(peer.id);
  for (const agents of [[], [alpha]]) {
    await f.configure(lexicalPolicy({ plugins: { entries: { "active-memory": { config: { agents } } } } }));
    if (agents.length) assert.match((await f.recall(f.input())).content, /concise commit descriptions/u);
    else await noRecall(f);
    await noRecall(f, peer.id);
    assert.deepEqual(active(f.store.read().nativeMemory.config).config.agents, agents);
  }
  await f.configure(lexicalPolicy({ plugins: { entries: { "active-memory": { config: { agents: [alpha], excludedAgents: [alpha] } } } } }));
  await noRecall(f); await noRecall(f, peer.id);
  assert.deepEqual(active((await f.ipc("memory.config.read", {})).config).config, { agents: [alpha], excludedAgents: [alpha] });
});

test("explicit global off fields prevent all recall while native mode off preserves lightweight trigger recall", { timeout: 30000 }, async t => {
  const f = await fixture(t); f.seedFile();
  for (const entry of [{ enabled: false }, { config: { enabled: false } }]) {
    const config = lexicalPolicy({ plugins: { entries: { "active-memory": entry } } });
    await f.configure(config); await noRecall(f);
    assert.deepEqual(active((await f.ipc("memory.config.read", {})).config), entry);
  }
  const off = { enabled: true, config: { mode: "off" } };
  await f.configure(lexicalPolicy({ plugins: { entries: { "active-memory": off } } })); f.resetCounts();
  assert.match((await f.recall(f.input())).content, /concise commit descriptions/u);
  assert.equal(f.counts.model, 0, "native mode off disables deep/model recall but retains lane-one triggers");
  assert.deepEqual(active((await f.ipc("memory.config.read", {})).config), off);
});

test("an excluded Profile can independently recall private sessions but the sessions-only model cannot read MEMORY.md", { timeout: 30000 }, async t => {
  const f = await fixture(t); f.seedFile(alpha, false);
  const config = { memory: { search: { provider: "none", rememberAcrossConversations: true } },
    plugins: { entries: { "active-memory": { config: { excludedAgents: [alpha], mode: "always", model: "literal-defaults-model" } } } } };
  await f.configure(config); const session = f.seedHistory();
  f.model = async ({ prompt }) => {
    if (f.counts.model % 2) return { text: '{"tool":"memory_search","arguments":{"query":"sapphire telescope calibration","minScore":0}}' };
    assert.match(prompt, /session-only sapphire telescope/u); assert.doesNotMatch(prompt, /concise commit descriptions for the amber telescope/u);
    return { text: '{"summary":"The sapphire telescope calibration occurs each morning."}' };
  };
  f.resetCounts(); const result = await f.recall(f.input(alpha, "What did we decide about telescope calibration?", session));
  assert.match(result.content, /sapphire telescope calibration/u); assert.equal(f.counts.model, 2);
  assert.ok(f.counts.search.length > 0); assert.ok(f.counts.search.every(row => JSON.stringify(row.sources) === '["sessions"]'));
  assert.equal(f.counts.get, 0); assert.equal(f.counts.indexedMemory, 0); assert.equal(f.counts.candidates, 0);
  f.model = async () => ({ text: '{"tool":"memory_get","arguments":{"path":"MEMORY.md"}}' });
  f.resetCounts(); const forbidden = await f.recall(f.input(alpha, "What did we decide about telescope calibration?", session));
  assert.equal(forbidden?.content || "", ""); assert.equal(f.counts.model, 1);
  assert.equal(f.counts.get, 0); assert.equal(f.counts.indexedMemory, 0); assert.equal(f.counts.candidates, 0);
  const off = structuredClone(config); off.memory.search.rememberAcrossConversations = false;
  await f.configure(off); await noRecall(f);
});

test("excluding a Profile during actual grounded model recall revokes new admission and waits for physical scratch cleanup", { timeout: 30000 }, async t => {
  const f = await fixture(t); f.seedFile(alpha, false);
  const config = lexicalPolicy({ plugins: { entries: { "active-memory": { config: { mode: "always", model: "literal-defaults-model" } } } } });
  await f.configure(config); const entered = deferred(), aborted = deferred(), release = deferred();
  f.model = async ({ signal }) => {
    if (f.counts.model === 1) return { text: '{"tool":"memory_get","arguments":{"path":"MEMORY.md"}}' };
    if (signal.aborted) aborted.resolve(); else signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve(); await release.promise; return { text: '{"summary":"Use concise commit descriptions for the amber telescope."}' };
  };
  const input = f.input(alpha, "What did we decide about telescope calibration?"), pending = f.owner.prepareActiveMemory(input);
  let applying;
  try {
    await Promise.race([entered.promise, pending.then(() => assert.fail("real model recall must reach the held summary"))]);
    assert.equal(f.owner.host(alpha).database.db.prepare("SELECT count(*) AS n FROM memory_state WHERE namespace='active-memory-runtime' AND value IS NOT NULL").get().n, 1);
    const excluded = structuredClone(config); active(excluded).config.excludedAgents = [alpha];
    let acknowledged = false; applying = f.configure(excluded).then(value => { acknowledged = true; return value; });
    await aborted.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal(acknowledged, false, "config IPC must not acknowledge a model/scratch resource that has not physically returned");
    const before = structuredClone(f.counts), newInput = f.input();
    await f.owner.prepareActiveMemory(newInput); assert.equal(f.owner.takeActiveMemory(newInput)?.content || "", "");
    await f.owner.finishActiveMemoryRun(newInput.run);
    assert.deepEqual(f.counts, before, "the already-persisted exclusion fences new file/model work before old cleanup finishes");
  } finally { release.resolve(); }
  await applying; await pending; assert.equal(f.owner.takeActiveMemory(input), null);
  await f.owner.finishActiveMemoryRun(input.run); f.assertClean(); await noRecall(f);
});

test("reapplying the exact authenticated config revision does not cancel an in-flight recall", { timeout: 30000 }, async t => {
  const f = await fixture(t); f.seedFile(alpha, false);
  const config = lexicalPolicy({ plugins: { entries: { "active-memory": { config: { mode: "always", model: "literal-defaults-model" } } } } });
  const projection = await f.configure(config), entered = deferred(), release = deferred(); let signal;
  f.model = async request => {
    if (f.counts.model === 1) return { text: '{"tool":"memory_get","arguments":{"path":"MEMORY.md"}}' };
    signal = request.signal; entered.resolve(); await release.promise;
    return { text: '{"summary":"Use concise commit descriptions for the amber telescope."}' };
  };
  const input = f.input(alpha, "What did we decide about telescope calibration?"), pending = f.owner.prepareActiveMemory(input);
  try {
    await Promise.race([entered.promise, pending.then(() => assert.fail("real model recall must reach the held summary"))]);
    assert.deepEqual(await f.ipc("memory.config.apply", projection), projection);
    assert.equal(signal.aborted, false, "an idempotent settings read/apply must preserve the original recall policy and model");
  } finally { release.resolve(); }
  await pending; assert.match(f.owner.takeActiveMemory(input).content, /concise commit descriptions/u);
  await f.owner.finishActiveMemoryRun(input.run); f.assertClean(); assert.equal(f.counts.model, 2);
});


test("session recall receipts survive completed replies, later appends and restart while rejecting tampering and forgetting", async t => {
  const config = { memory: { search: { provider: "none", rememberAcrossConversations: true } },
    plugins: { entries: { "active-memory": { enabled: true, config: { mode: "always", model: "literal" } } } } };
  const f = await fixture(t, config), session = f.seedHistory();
  let calls = 0;
  f.model = async () => ({ text: ++calls % 2 ? '{"tool":"memory_search","arguments":{"query":"sapphire telescope","minScore":0}}'
    : '{"summary":"The session-only sapphire telescope calibration occurs each morning."}' });
  const input = f.input(alpha, "Do you remember the sapphire telescope calibration?", session);
  const result = await f.recall(input); assert.match(result.content, /sapphire telescope/u);
  const params = { profileId: alpha, sessionKey: session.sessionKey, includeTrace: true };
  const before = await f.owner.activeMemory.status.read(params);
  assert.equal(before.phase, "complete"); assert.equal(before.outcome, "ok");
  const sha256 = require("../app/agent-service/shoggoth-memory/migration.cjs").sha256;
  const key = sha256(session.sessionKey), database = () => f.owner.host(alpha).database.db;
  const readProof = () => database().prepare("SELECT value FROM memory_state WHERE namespace='active-memory-status-proof' AND key=?").get(key).value;
  const originalProof = readProof(), receipt = JSON.parse(originalProof);
  assert.ok(receipt.evidence.some(item => item.source === "sessions" && /^sqlite:[0-9]+:[a-f0-9]{64}$/u.test(item.hash) && item.throughSeq > 0));
  const run = f.service.workDispatcher.enqueue({ id: crypto.randomUUID(), profileId: alpha, source: "chat", sourceId: session.sessionKey,
    workspace: null, idempotencyKey: crypto.randomUUID() });
  f.service.workDispatcher.admit(run.id); f.service.workDispatcher.transition(run.id, "running");
  for (const [kind, text] of [["user", "Thanks; next, help with an unrelated garden."], ["assistant", "We can discuss the garden next."]]) {
    f.service.transcriptStore.appendEvent({ profileId: alpha, sessionId: session.id, id: crypto.randomUUID(), runId: run.id, kind, content: { text } });
  }
  f.service.workDispatcher.transition(run.id, "completed");
  assert.deepEqual(await f.owner.activeMemory.status.read(params), before, "completed follow-up must retain the unchanged recalled prefix");
  await f.close(); await f.open();
  f.model = async () => assert.fail("reading a receipt cannot start a model");
  assert.deepEqual(await f.owner.activeMemory.status.read(params), before, "the same source prefix is verified after restart");
  for (const mutate of [
    item => ({ ...item, hash: `sqlite:bad:${"0".repeat(64)}` }),
    item => ({ ...item, hash: `sqlite:9007199254740992:${"0".repeat(64)}` }),
    item => ({ ...item, throughSeq: item.throughSeq + 100 }),
    item => ({ ...item, throughSeq: -1 }),
    item => ({ ...item, hash: `sqlite:1:${"0".repeat(64)}` }),
    item => ({ ...item, source: "memory" }),
  ]) {
    const changed = { ...receipt, evidence: receipt.evidence.map(mutate) };
    database().prepare("UPDATE memory_state SET value=? WHERE namespace='active-memory-status-proof' AND key=?").run(JSON.stringify(changed), key);
    const stale = await f.owner.activeMemory.status.read(params); assert.equal(stale.phase, "stale"); assert.deepEqual(stale.traceLines, []);
  }
  database().prepare("UPDATE memory_state SET value=? WHERE namespace='active-memory-status-proof' AND key=?").run(originalProof, key);
  assert.deepEqual(await f.owner.activeMemory.status.read(params), before);
  const originalEvent = f.service.transcriptStore.listEvents(alpha, session.id)[0];
  f.service.transcriptStore.setContextExcluded({ profileId: alpha, sessionId: session.id, eventId: originalEvent.id, contextExcluded: true });
  const hidden = await f.owner.activeMemory.status.read(params); assert.equal(hidden.phase, "stale"); assert.deepEqual(hidden.traceLines, []);
  f.service.transcriptStore.setContextExcluded({ profileId: alpha, sessionId: session.id, eventId: originalEvent.id, contextExcluded: false });
  assert.deepEqual(await f.owner.activeMemory.status.read(params), before, "restoring the exact eligible prefix revalidates its receipt");
  await f.owner.forgetSession(alpha, session.id);
  const forgotten = await f.owner.activeMemory.status.read(params); assert.equal(forgotten.phase, "stale"); assert.deepEqual(forgotten.traceLines, []);
  await f.owner.host(alpha).searchIndex.sync();
  assert.deepEqual((await f.owner.searchMemory({ profileId: alpha, query: "sapphire telescope", sources: ["sessions"], minScore: 0 })).results, []);
});


test("default cold-start grace is bounded and does not replace explicit recall deadlines", () => {
  const { projectActiveMemoryDefaults } = require("../app/agent-service/active-memory-defaults");
  const { core } = require("../app/agent-service/shoggoth-memory/host.cjs");
  const resolve = policy => {
    const cfg = projectActiveMemoryDefaults({ plugins: { entries: { "active-memory": { enabled: true, config: policy } } } }, [alpha]);
    return core.normalizeActiveMemoryConfig(active(cfg).config, cfg, ["memory_search", "memory_get"]);
  };
  assert.equal(resolve({}).timeoutMs, 15000); assert.equal(resolve({}).setupGraceTimeoutMs, 10000);
  assert.equal(resolve({ timeoutMs: 700 }).timeoutMs, 700); assert.equal(resolve({ timeoutMs: 700 }).setupGraceTimeoutMs, 0);
  assert.equal(resolve({ setupGraceTimeoutMs: 0 }).setupGraceTimeoutMs, 0);
  assert.equal(resolve({ timeoutMs: 1200, setupGraceTimeoutMs: 300 }).setupGraceTimeoutMs, 300);
});
