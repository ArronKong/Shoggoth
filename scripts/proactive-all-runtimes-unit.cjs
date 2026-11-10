"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { seedProactiveAgentContext } = require("./helpers/proactive-native-closure.cjs");
const { InspirationRuntime } = require("./fixtures/inspiration-runtime.cjs");
const RUNTIMES = ["grok-build", "pi", "opencode", "deepseek-harness", "antigravity", "claude-code"];
const id = () => crypto.randomUUID();
async function until(predicate, describe = () => "") {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("Native turn did not start: " + describe());
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t, runtime) {
  const root = fs.mkdtempSync("/private/tmp/sg-heartbeat-native-");
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const clock = { value: Date.UTC(2026, 9, 30, 10) }, calls = [], sent = [], hosts = new Map();
  const mapSession = ({ threadSource, ...thread }) => ({ ...thread, source: threadSource });
  const manager = {
    runtimeIdentityKey: binding => `fixture:${binding.runtime}:1`,
    async acquire(binding, options) {
      assert.notEqual(options?.modelOnly, true, "Proactive checks must use ordinary Agent sessions");
      if (!hosts.has(binding.runtime)) {
        const host = new InspirationRuntime(); host.starts = [];
        const handle = { ...binding, capabilities: Object.fromEntries([
          "session.start", "session.resume", "session.read", "session.list", "turn.start", "turn.interrupt", "events", "serverRequests",
        ].map(name => [name, true])), terminated: host.terminated, registeredSecrets: [],
          authenticationState: async () => ({ authenticated: true, credentialPresent: true }),
          subscribe: listener => host.subscribe(listener),
          registerServerRequestHandler: (method, handler) => host.registerServerRequestHandler(method, handler),
          async sessionList(input) { const result = await host.threadList(input); return { ...result, data: result.data.map(mapSession) }; },
          async sessionStart(input) {
            host.starts.push(structuredClone(input));
            return { session: mapSession((await host.threadStart({ ...input, threadSource: input.source })).thread) };
          },
          async sessionResume(input) { return { session: mapSession((await host.threadResume({ ...input, threadId: input.sessionId })).thread) }; },
          async sessionRead(input) { return { session: mapSession((await host.threadRead({ ...input, threadId: input.sessionId })).thread) }; },
          async turnStart(input) {
            calls.push({ binding, input: { ...input } });
            return host.turnStart({ ...input, threadId: input.sessionId, clientUserMessageId: input.operationId });
          },
          turnInterrupt: input => host.turnInterrupt(input),
        };
        hosts.set(binding.runtime, { host, handle });
      }
      return hosts.get(binding.runtime).handle;
    }, async stopAll() {}, async stop() {},
  };
  const service = createAgentService({ paths, runtimeManager: manager, now: () => clock.value, autoSparkNotes: false,
    runtimePool: { get() { assert.fail("The isolated fixture must never acquire a real Codex host"); }, async stopAll() {} },
    proactiveReviewTimeoutMs: 10_000,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {},
    proactiveProfileAvailable: () => true, notificationSender: async input => { sent.push(input); return { state: "submitted" }; } });
  service.proactiveScheduler.onError = error => t.diagnostic(error.stack);
  t.after(async () => { await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const products = service.productStore, profileId = DEFAULT_AGENT_PROFILE_ID;
  function select(name) {
    let state = products.getAgentRuntimeBindings(profileId), binding = state.bindings.find(b => b.runtime === name);
    if (!binding) {
      products.addAgentRuntimeBinding(profileId, { runtime: name,
        runtimeAccountId: DEFAULT_RUNTIME_ACCOUNTS.find(a => a.runtime === name).id }, { operationId: id() });
      state = products.getAgentRuntimeBindings(profileId); binding = state.bindings.find(b => b.runtime === name);
    }
    products.setAgentDefaultModel(profileId, binding.id, { revision: state.revision, model: `${name}-default-model` });
    return binding;
  }
  const binding = select(runtime);
  const mainKey = service.proactiveStore.getTarget(profileId).sessionKey;
  const main = service.chatSessionStore.getSession(mainKey);
  service.chatSessionStore.switchRuntime(mainKey, { bindingId: binding.id, revision: main.revision, model: `${runtime}-main-model` });
  const call = (method, params) => service.proactiveService.handle(method, params);
  const get = async (kind = "heartbeat") => (await call("proactive.monitor.get", { kind, profileId })).monitor;
  const save = config => call("proactive.monitor.set", { operationId: id(),
    expectedRevision: service.proactiveStore.getMonitor(config.id)?.revision ?? 0, config });
  const document = (await call("proactive.document.get", { profileId })).document;
  await call("proactive.document.set", { profileId, content: "# HEARTBEAT\n\nCheck current state and report meaningful changes.\n", expectedRevision: document.revision });
  await save({ ...(await get()).config, enabled: true, activeHours: null });
  const tick = async (ms = 30 * 60_000) => { clock.value += ms; await service.proactiveScheduler.tick(); };
  const start = async (kind = "heartbeat", ms = 30 * 60_000) => {
    const config = (await get(kind)).config;
    await tick(ms);
    await until(() => service.workDispatcher.listRuns({ source: "proactive" }).some(run => run.sourceId === config.id && run.status === "running"),
      () => JSON.stringify({ checks: service.proactiveStore.history(config.id), runs: service.workDispatcher.listRuns({ source: "proactive" }),
        errors: [...service.workRunCoordinator.lastErrors.values()].map(error => ({ code: error.code, message: error.message })) }));
    return service.workDispatcher.listRuns({ source: "proactive" }).find(run => run.sourceId === config.id && run.status === "running");
  };
  const response = (run, body, scratch) => ({ runId: run.id, outcome: "notice", reason: "Meaningful change", body,
    candidates: service.proactiveStore.occurrenceForRun(run.id).candidates.slice(0, 5).map(({ id, evidenceVersion }) => ({ id, evidenceVersion })),
    ...(scratch === undefined ? {} : { scratch }) });
  const complete = async (run, text, usage = 20) => {
    const { host } = hosts.get(run.runtimeSessionRef.runtime);
    if (usage !== null) host.emit({ known: true, type: "usage", method: "fixture/usage", threadId: run.runtimeSessionRef.sessionId,
      turnId: run.runtimeTurnRef.turnId, responseId: `usage-${run.id}`, model: `${runtime}-main-model`,
      usage: { inputTokens: Math.max(0, usage - 8), outputTokens: Math.min(8, usage), totalTokens: usage,
        cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 } });
    host.complete(run, text); await service.proactiveScheduler.waitForIdle();
    return service.proactiveStore.occurrenceForRun(run.id);
  };
  return { service, root, clock, calls, hosts, sent, select, call, get, save, tick, start, response, complete, profileId, mainKey };
}

for (const runtime of RUNTIMES) {
  test(`${runtime}: heartbeat and daily review reuse Main, its selected model, full context and ordinary turn API`, async t => {
    const f = await fixture(t, runtime);
    const expected = await seedProactiveAgentContext(f.service, f.profileId, f.root, f.clock.value);
    const first = await f.start();
    const main = f.service.chatSessionStore.getSession(f.mainKey), host = f.hosts.get(runtime).host;
    assert.equal(f.service.workRunCoordinator.getRunSessionKey(first), f.mainKey);
    assert.equal(first.runtimeSessionRef.sessionId, main.runtimeSessionId);
    assert.equal(first.workspace, main.workspace);
    assert.equal(f.calls[0].input.model, `${runtime}-main-model`);
    assert.equal(host.starts[0].persistent, true);
    const context = host.starts[0].developerInstructions + f.calls[0].input.turnDeveloperInstructions
      + f.calls[0].input.context + f.calls[0].input.prompt;
    for (const text of Object.values(expected.definitions)) assert.ok(context.includes(text));
    for (const text of [expected.user, expected.agent, expected.daily]) assert.ok(context.includes(text));
    assert.match(context, /Frozen permission context/u);
    assert.equal(f.service.contextSnapshotStore.get(f.profileId, first.contextSnapshotId).report.inputOrigin, "system");
    f.service.proactiveService.respond(first, f.response(first, "A useful reminder.", "Reviewed state A."));
    assert.equal((await f.complete(first, "Private structured response acknowledgement")).state, "published");
    assert.equal(f.service.proactiveStore.heartbeatScratch(f.profileId).content, "Reviewed state A.");
    const second = await f.start();
    assert.equal(second.runtimeSessionRef.sessionId, first.runtimeSessionRef.sessionId);
    assert.equal((await f.complete(second, "A useful reminder.")).reason, "duplicate_notice");
    const third = await f.start();
    assert.equal((await f.complete(third, "NO_REPLY")).state, "silent");
    assert.equal(host.threads.length, 1); assert.equal(f.sent.length, 1);
    await f.save({ ...(await f.get()).config, enabled: false });
    await f.service.inspirationService.handle("inspiration.create", { operationId: id(), body: "A saved idea worth reviewing." });
    const daily = await f.get("inspiration");
    await f.save({ ...daily.config, enabled: true, timezone: "UTC", schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" } });
    const review = await f.start("inspiration", 24 * 60 * 60_000 + 30 * 60_000);
    assert.equal(review.runtimeSessionRef.sessionId, first.runtimeSessionRef.sessionId);
    assert.equal((await f.complete(review, "Please revisit the saved idea.")).state, "published");
    assert.equal(f.sent.length, 2);
    const events = f.service.transcriptStore.listEvents(f.profileId, main.id);
    assert.equal(events.filter(event => event.content.proactiveNotice).length, 2);
    assert.equal(events.filter(event => event.kind === "user").length, 0);
    assert.equal(f.service.tokenUsageStore.list({ profileId: f.profileId }).filter(row => row.source === "proactive").length, 4);
    await f.service.stop({ notify: false }); await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
    assert.equal(f.calls.length, 4); assert.equal(f.sent.length, 2);
  });
  test(`${runtime}: disabled and restarted active checks never publish or dispatch again`, async t => {
    const f = await fixture(t, runtime), run = await f.start();
    await f.save({ ...(await f.get()).config, enabled: false });
    await f.service.proactiveScheduler.waitForIdle();
    assert.equal(f.service.workDispatcher.getRun(run.id).status, "interrupted");
    assert.throws(() => f.service.proactiveService.respond(run, f.response(run, "Late reply")), { code: "PROACTIVE_SCOPE_INVALID" });
    await f.service.stop({ notify: false }); await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
    assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
  });
}
test("empty rules avoid runtime verification and model calls", async t => {
  for (const runtime of RUNTIMES) await t.test(runtime, async t => {
    const f = await fixture(t, runtime), document = (await f.call("proactive.document.get", { profileId: f.profileId })).document;
    await f.call("proactive.document.set", { profileId: f.profileId, content: "# HEARTBEAT\n", expectedRevision: document.revision });
    await f.tick(); await f.service.proactiveScheduler.waitForIdle();
    assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
    assert.equal(f.service.proactiveStore.history((await f.get()).config.id)[0].reason, "empty_checklist");
  });
});
test("normal native usage keeps durable run, token and unknown-usage budget barriers", async t => {
  for (const boundary of ["runs", "tokens", "unknown", "zero"]) await t.test(boundary, async t => {
    const f = await fixture(t, "pi");
    await f.save({ ...(await f.get()).config, budget: { maxRunsPerDay: boundary === "runs" ? 1 : 5, maxTokensPerDay: 1024 } });
    const run = await f.start();
    await f.complete(run, "A budgeted reminder.", boundary === "tokens" ? 1208 : boundary === "unknown" ? null : boundary === "zero" ? 0 : 20);
    await f.service.stop({ notify: false }); await f.service.start();
    await f.tick(); await f.service.proactiveScheduler.waitForIdle();
    assert.equal(f.service.proactiveStore.history((await f.get()).config.id)[0].reason,
      ["unknown", "zero"].includes(boundary) ? "usage_unverified" : "budget_exhausted");
    assert.equal(f.calls.length, 1);
  });
});
test("structured replies retain cross-run and candidate validation in the normal channel", async t => {
  const f = await fixture(t, "deepseek-harness"), run = await f.start();
  const response = f.response(run, "A validated reply.");
  assert.throws(() => f.service.proactiveService.respond(run, { ...response, runId: id() }), { code: "PROACTIVE_RESPONSE_INVALID" });
  assert.throws(() => f.service.proactiveService.respond(run, { ...response, candidates: [{ ...response.candidates[0], evidenceVersion: "0".repeat(64) }] }), { code: "PROACTIVE_RESPONSE_INVALID" });
  assert.equal(f.service.proactiveStore.occurrenceForRun(run.id).response, null);
  await f.complete(run, "NO_REPLY"); assert.equal(f.sent.length, 0);
});

test("the Main binding stays authoritative when the Agent default changes", async t => {
  const f = await fixture(t, "pi"), first = await f.start();
  f.select("opencode");
  assert.equal(f.service.proactiveService.capabilities(f.profileId).semanticVerified, true);
  assert.equal((await f.complete(first, "Main still uses the selected model.")).state, "published");
  const next = await f.start();
  assert.equal(next.runtimeSessionRef.runtime, "pi");
  assert.equal(next.runtimeSessionRef.sessionId, first.runtimeSessionRef.sessionId);
  assert.equal(f.calls.at(-1).input.model, "pi-main-model");
  await f.complete(next, "NO_REPLY");
});
test("a Service restart does not replay an already dispatched normal proactive turn", async t => {
  const f = await fixture(t, "pi"), run = await f.start();
  await f.service.stop({ notify: false }); await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
  assert.ok(["interrupted", "failed"].includes(f.service.workDispatcher.getRun(run.id).status));
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
});
