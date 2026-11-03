"use strict";

// Isolated Product Service for the 2026-10-28 memory repair tests. Real owner
// indexes with memory sharing enabled, as in the installed App; only model
// selection and replies are controlled.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../../app/agent-service/server");
const { requestService, readClientToken } = require("../../app/agent-service/client");
const { resolveServicePaths } = require("../../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID: A, AGENT_PROFILE_FIELDS } = require("../../app/agent-service/product-store");
const { core } = require("../../app/agent-service/shoggoth-memory/host.cjs");
const { sha256 } = require("../../app/agent-service/shoggoth-memory/migration.cjs");

const DAY = 24 * 60 * 60 * 1000;
const FACT = "The amber telescope lens is calibrated every evening.";

async function fixture(t, { mode = "escalate", activeMemory = {}, runtimePool, daysAgo = 10, memorySearch = {} } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mrb-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "s"), profileRoot: path.join(root, "p"), cacheRoot: path.join(root, "c") });
  const workspace = path.join(root, "w"); fs.mkdirSync(workspace, { mode: 0o700 });
  // Stay in the past so day jumps never look like future operations.
  let clock = Date.now() - daysAgo * DAY;
  const config = { memory: { search: { provider: "none", ...memorySearch } },
    plugins: { entries: { "active-memory": { enabled: true, config: { mode, model: "literal", timeoutMs: 15000, setupGraceTimeoutMs: 10000, ...activeMemory } } } } };
  const service = createAgentService({ paths, prewarmMcpAuth: false, memoryCoreConfig: config, memorySharingFeatureReady: true, now: () => ++clock,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    ...(runtimePool ? { runtimePool } : {
      runtimeManager: { async acquire() { assert.fail("baseline cannot acquire a Runtime"); }, async stop() {}, async stopAll() {} },
    }) });
  t.after(async () => { await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const owner = service.memoryEngine, B = "repair-source-b", base = service.productStore.getAgentProfile(A);
  const profile = Object.fromEntries(AGENT_PROFILE_FIELDS.map(field => [field, base[field]]));
  Object.assign(profile, { id: B, agentId: B, name: B, runtimeProfileId: B, isDefault: false });
  service.productStore.putAgentProfile(profile); service.agentDefinitionStore.ensureProfile({ profileId: B });
  owner.store.ensureProfile(B); owner.recallPolicy.assertReady(B);
  require("./literal-memory-model-control.cjs").installLiteralMemoryModelControl(owner);
  let modelCalls = 0;
  const f = {
    root, workspace, service, owner, B,
    now: () => clock, advance(ms) { clock += ms; },
    modelCalls: () => modelCalls,
    model: async () => assert.fail("unexpected model call"),
    session() { return service.chatSessionStore.createSession({ profileId: A, workspace, operationId: crypto.randomUUID(), createdAt: clock }); },
    noise(session) {
      return service.transcriptStore.appendEvent({ profileId: A, sessionId: session.id, id: crypto.randomUUID(),
        runId: crypto.randomUUID(), kind: "user", content: { text: "unrelated chatter" }, occurredAt: clock });
    },
    turn(text, session = f.session(), { queued = false } = {}) {
      const id = crypto.randomUUID();
      service.workDispatcher.enqueue({ id, profileId: A, source: "chat", sourceId: session.sessionKey, idempotencyKey: id, workspace });
      if (!queued) { service.workDispatcher.admit(id); service.workDispatcher.transition(id, "running"); }
      const event = service.transcriptStore.appendEvent({ profileId: A, sessionId: session.id, id: `user-${id}`, runId: id,
        kind: "user", content: { text }, occurredAt: clock });
      return { profile: service.productStore.getAgentProfile(A), session, run: service.workDispatcher.getRun(id), query: text, event };
    },
    async finish(input, status = "completed") {
      const current = service.workDispatcher.getRun(input.run.id);
      if (current.status === "queued") { service.workDispatcher.admit(current.id); service.workDispatcher.transition(current.id, "running"); }
      if (["running", "waiting_input", "waiting_approval"].includes(service.workDispatcher.getRun(input.run.id).status)) {
        service.workDispatcher.transition(input.run.id, status, status === "failed" ? { errorCode: "MEMORY_REPAIR_FIXTURE_FAILED" } : undefined);
      }
      await owner.finishActiveMemoryRun(service.workDispatcher.getRun(input.run.id));
    },
    saveUser(content) {
      return owner.propose({ profileId: A, scope: "user", type: "semantic", content, classification: "explicit", sourceRefs: [`user-edit:${sha256(content)}`] });
    },
    saveForeign(content) {
      return owner.propose({ profileId: B, scope: "agent", type: "semantic", content, classification: "explicit", sourceRefs: [`user-edit:${sha256(content)}`] });
    },
    search(query, input, extra = {}) {
      return owner.searchMemory({ profileId: A, workspace, maxSensitivity: "private", query, run: input.run, ...extra });
    },
    async dailyNote(append) {
      // Only bound chat sessions are memory sources, as in seedSession().
      const session = f.session(), id = crypto.randomUUID();
      service.chatSessionStore.requestBinding(session.sessionKey, `binding-${id}`, clock);
      service.chatSessionStore.completeBinding(session.sessionKey, `binding-${id}`, `runtime-${id}`);
      service.workDispatcher.enqueue({ id, profileId: A, source: "chat", sourceId: session.sessionKey, idempotencyKey: id, workspace });
      service.workDispatcher.admit(id); service.workDispatcher.transition(id, "running");
      service.transcriptStore.appendEvent({ profileId: A, sessionId: session.id, id: `flush-src-${id}`, runId: id,
        kind: "user", content: { text: "Please keep track of the telescope routine." }, occurredAt: clock });
      service.workDispatcher.transition(id, "completed");
      const previous = f.model;
      f.model = async ({ prompt }) => { assert.match(prompt, /APPEND new content only/); return { text: JSON.stringify({ append }) }; };
      try { return await owner.flushBeforeCompaction({ profileId: A, sessionId: session.id }); } finally { f.model = previous; }
    },
    async recallEntries() {
      const host = owner.host(A);
      return host.run(() => core.readShortTermRecallEntries({ workspaceDir: owner.store.workspace(A), nowMs: clock }));
    },
    diagnostics() {
      return owner.host(A).database.db.prepare("SELECT value FROM memory_state WHERE namespace='active-memory-diagnostics' AND value IS NOT NULL")
        .all().map(row => JSON.parse(row.value));
    },
  };
  owner.complete = async request => { modelCalls++; return f.model(request); };
  f.ipc = (method, params) => requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params });
  f.sharing = enabled => f.ipc("memory.sharing.config.apply",
    { revision: service.nativeMemorySharingConfig.read().revision + 1, config: { enabled, excludedProfiles: [] } });
  await f.sharing(true);
  return f;
}

// A two-step recall model: one memory_search, then a summary built from the
// returned snippets. `during` runs while the model is producing the summary.
function recallModel(f, query, { during, steps } = {}) {
  let phase = 0;
  const plan = steps || [{ tool: "memory_search", arguments: { query, minScore: 0, maxResults: 20 } }];
  f.model = async ({ prompt }) => {
    if (phase < plan.length) return { text: JSON.stringify(plan[phase++]) };
    phase = 0;
    await during?.();
    const match = /calibrated every evening/u.test(prompt);
    return { text: JSON.stringify({ summary: match ? "The amber telescope is calibrated every evening." : "NONE" }) };
  };
}

module.exports = { A, DAY, FACT, fixture, recallModel };
