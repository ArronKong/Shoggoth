"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { DAY_MS } = require("../app/agent-service/proactive-service-protocol");
const RUNTIMES = ["grok-build", "pi", "opencode", "deepseek-harness", "antigravity"];
const id = () => crypto.randomUUID();

async function fixture(t, runtime) {
  const root = fs.mkdtempSync("/private/tmp/sg-heartbeat-runtime-");
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const clock = { value: Date.UTC(2026, 9, 30, 10) }, calls = [], sent = [];
  let service, generate;
  const manager = {
    canGenerateModelOnly: (name, options) => {
      assert.equal(options?.purpose, "proactive");
      return RUNTIMES.includes(name);
    },
    runtimeIdentityKey: binding => `fixture:${binding.runtime}:1`,
    async acquire(binding, options) {
      return { ...binding, capabilities: { "model.generate.toolFree": true },
        authenticationState: async () => ({ authenticated: true, credentialPresent: true }),
        async generateModelOnly(input) {
          assert.equal(options.modelOnly, true);
          assert.deepEqual(options.permissionPolicy, { approvalPolicy: "never", sandbox: "read-only" });
          assert.equal(options.workspace, null);
          calls.push({ binding, options, input });
          return generate(input);
        } };
    }, async stopAll() {}, async stop() {},
  };
  service = createAgentService({ paths, runtimeManager: manager, now: () => clock.value, autoSparkNotes: false, proactiveReviewTimeoutMs: 3000,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {},
    proactiveProfileAvailable: () => true, notificationSender: async input => { sent.push(input); return { state: "submitted" }; } });
  t.after(async () => { await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const products = service.productStore, profileId = DEFAULT_AGENT_PROFILE_ID;
  function select(name, model = `${name}-chosen-model`) {
    let state = products.getAgentRuntimeBindings(profileId);
    let binding = state.bindings.find(b => b.runtime === name);
    if (!binding) {
      products.addAgentRuntimeBinding(profileId, { runtime: name,
        runtimeAccountId: DEFAULT_RUNTIME_ACCOUNTS.find(a => a.runtime === name).id }, { operationId: id() });
      state = products.getAgentRuntimeBindings(profileId); binding = state.bindings.find(b => b.runtime === name);
    }
    products.setAgentDefaultBinding(profileId, binding.id, { revision: state.revision });
    products.putAgentProfile({ ...products.getAgentProfile(profileId), defaultModel: model });
  }
  select(runtime);
  const call = (method, params) => service.proactiveService.handle(method, params);
  const get = async (kind = "heartbeat") => (await call("proactive.monitor.get", { kind, profileId })).monitor;
  const save = async config => call("proactive.monitor.set", { operationId: id(),
    expectedRevision: service.proactiveStore.getMonitor(config.id)?.revision ?? 0, config });
  const rules = "# HEARTBEAT\n\nCheck the supplied state. Notify only on a meaningful change; retain short working notes.\n";
  const document = (await call("proactive.document.get", { profileId })).document;
  await call("proactive.document.set", { profileId, content: rules, expectedRevision: document.revision });
  await save({ ...(await get()).config, enabled: true, activeHours: null });
  const tick = async (ms = 30 * 60_000) => {
    clock.value += ms; await service.proactiveScheduler.tick();
    await service.proactiveScheduler.waitForIdle();
    return service.proactiveStore.history((await get()).config.id)[0];
  };
  const reply = (input, outcome = "notice") => {
    const runId = /Run ID: ([a-f0-9-]{36})/u.exec(input.prompt)?.[1];
    const occurrence = service.proactiveStore.occurrenceForRun(runId);
    assert.ok(occurrence, "the durable run must precede generation");
    const candidate = occurrence.candidates[0];
    return { text: JSON.stringify({ runId, outcome, candidates: outcome === "silent" ? [] : [
      { id: candidate.id, evidenceVersion: candidate.evidenceVersion }], reason: "需要关注的变化", body: outcome === "silent" ? "" : "请检查本次结果。",
      ...(occurrence.heartbeat ? { scratch: "已检查：状态 A" } : {}) }), model: input.model,
      usage: { totalTokens: 20, inputTokens: 12, outputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 } };
  };
  generate = input => reply(input);
  return { service, clock, calls, sent, select, call, get, save, tick, reply, rules, profileId,
    setGenerate(fn) { generate = fn; } };
}

for (const runtime of RUNTIMES) test(`${runtime}: nonempty HEARTBEAT, notes, notice, default model, dedup and daily inspiration`, async t => {
  const f = await fixture(t, runtime);
  const check = await f.tick();
  assert.equal(check.state, "published", JSON.stringify({ reason: check.reason, calls: f.calls.length,
    runs: f.service.workDispatcher.listRuns({ source: "proactive" }),
    errors: [...f.service.workRunCoordinator.lastErrors.values()].map(e => ({ code: e.code, message: e.message, stack: e.stack })) }));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].binding.runtime, runtime);
  assert.equal(f.calls[0].input.model, `${runtime}-chosen-model`);
  assert.deepEqual(f.calls[0].input.modelSecretScope, { profileId: f.profileId, sessionId: check.monitorId });
  assert.equal(f.service.proactiveStore.heartbeatScratch(f.profileId).content, "已检查：状态 A");
  assert.equal((await f.call("proactive.document.get", { profileId: f.profileId })).document.content, f.rules);
  assert.equal(f.sent.length, 1);
  assert.equal(f.service.tokenUsageStore.list({ profileId: f.profileId }).filter(x => x.source === "proactive")[0].runtime, runtime);
  await f.service.proactiveScheduler.tick(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  f.select(runtime, `${runtime}-changed-model`);
  f.setGenerate(input => { assert.match(input.prompt, /已检查：状态 A/u); return f.reply(input, "silent"); });
  assert.equal((await f.tick()).state, "silent");
  assert.equal(f.calls[1].input.model, `${runtime}-changed-model`);
  assert.equal(f.sent.length, 1);
  f.clock.value -= 2 * DAY_MS;
  await f.service.inspirationService.handle("inspiration.create", { operationId: id(), body: "值得回顾的灵感" });
  f.clock.value += 2 * DAY_MS;
  const daily = await f.get("inspiration");
  await f.save({ ...daily.config, enabled: true, timezone: "UTC", schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" } });
  f.setGenerate(input => f.reply(input));
  await f.tick(60 * 60_000);
  const review = f.service.proactiveStore.history(daily.config.id)[0];
  assert.equal(review.state, "published", review.reason); assert.equal(f.sent.length, 2);
  assert.equal(f.service.proactiveService.status(f.service.proactiveStore.getMonitor(daily.config.id)).totalTokens, 20,
    "daily review has its own budget even after same-day HEARTBEAT runs");
  assert.equal(f.service.proactiveStore.history(check.monitorId)[0].reason, "duplicate_notice");
  await f.service.stop({ notify: false }); await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
  assert.equal(f.sent.length, 2); assert.equal(f.calls.length, 4);
  assert.equal(f.service.proactiveStore.heartbeatScratch(f.profileId).content, "已检查：状态 A");
});

test("empty rules remain silent on every default Runtime without verification or inference", async t => {
  for (const runtime of RUNTIMES) await t.test(runtime, async t => {
    const f = await fixture(t, runtime);
    const document = (await f.call("proactive.document.get", { profileId: f.profileId })).document;
    await f.call("proactive.document.set", { profileId: f.profileId, content: "# HEARTBEAT\n\n<!-- no active rules -->\n", expectedRevision: document.revision });
    const check = await f.tick(); assert.equal(check.state, "silent"); assert.equal(check.reason, "empty_checklist");
    assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
    assert.equal(f.service.proactiveStore.getCursor(`capability:${f.profileId}`), null);
  });
});

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("dispatch did not start");
    await new Promise(resolve => setTimeout(resolve, 10)); }
}

for (const runtime of RUNTIMES) {
  test(`${runtime}: restart never replays a dispatched sessionless review`, async t => {
    const f = await fixture(t, runtime);
    f.setGenerate(input => new Promise((_, reject) => input.signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("fixture process stopped"), { code: "MODEL_ONLY_CANCELED" })), { once: true })));
    const pending = f.tick(); pending.catch(() => {}); await until(() => f.calls.length);
    const run = f.service.workDispatcher.listRuns({ source: "proactive" })[0];
    assert.equal(run.status, "running"); assert.equal(run.runtimeSessionRef, null);
    await f.service.stop({ notify: false }); await pending.catch(() => {});
    f.setGenerate(() => { throw new Error("Recovery must not send another model request"); });
    await f.service.start(); await f.service.proactiveScheduler.waitForIdle();
    const recovered = f.service.workDispatcher.getRun(run.id);
    assert.equal(recovered.status, "interrupted"); assert.equal(recovered.errorCode, "SERVICE_RESTARTED");
    assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
    assert.equal(f.service.proactiveStore.heartbeatScratch(f.profileId).revision, 0);
  });
  test(`${runtime}: disabled review aborts, waits for cleanup and discards late notes/notice`, async t => {
    const f = await fixture(t, runtime); let cleaned = false;
    f.setGenerate(input => new Promise(resolve => input.signal.addEventListener("abort", () => {
      setTimeout(() => { cleaned = true; resolve(f.reply(input)); }, 30);
    }, { once: true })));
    const pending = f.tick(); await until(() => f.calls.length);
    await f.save({ ...(await f.get()).config, enabled: false });
    const check = await pending;
    assert.equal(cleaned, true); assert.notEqual(check.state, "published");
    assert.equal(f.sent.length, 0); assert.equal(f.service.proactiveStore.heartbeatScratch(f.profileId).revision, 0);
    assert.equal(f.service.workDispatcher.getRun(check.runId).status, "interrupted");
    assert.equal(f.service.workDispatcher.getRun(check.runId).errorCode, "PROACTIVE_REVIEW_STOPPED");
    assert.equal(f.service.workRunCoordinator.lastErrors.size, 0);
  });
  test(`${runtime}: defaults changed in flight invalidate the result; next check selects the new Runtime`, async t => {
    const f = await fixture(t, runtime); let finish;
    f.setGenerate(input => new Promise(resolve => { finish = () => resolve(f.reply(input)); }));
    const pending = f.tick(); await until(() => f.calls.length);
    const next = RUNTIMES[(RUNTIMES.indexOf(runtime) + 1) % RUNTIMES.length]; f.select(next);
    finish(); const check = await pending;
    assert.equal(check.reason, "PROACTIVE_SCOPE_INVALID"); assert.equal(f.sent.length, 0);
    assert.equal(f.service.proactiveStore.heartbeatScratch(f.profileId).revision, 0);
    f.setGenerate(input => f.reply(input)); assert.equal((await f.tick()).state, "published");
    assert.equal(f.calls[1].binding.runtime, next); assert.equal(f.calls[1].input.model, `${next}-chosen-model`);
  });
}

test("a changed HEARTBEAT document cancels in-flight notes and notice", async t => {
  const f = await fixture(t, "pi");
  f.setGenerate(input => new Promise(resolve => input.signal.addEventListener("abort", () =>
    setTimeout(() => resolve(f.reply(input)), 30), { once: true })));
  const pending = f.tick(); await until(() => f.calls.length);
  const document = (await f.call("proactive.document.get", { profileId: f.profileId })).document;
  await f.call("proactive.document.set", { profileId: f.profileId, content: "# HEARTBEAT\nNew rules\n", expectedRevision: document.revision });
  const check = await pending;
  assert.equal(check.reason, "PROACTIVE_REVIEW_STOPPED"); assert.equal(f.sent.length, 0);
  assert.equal(f.service.proactiveStore.heartbeatScratch(f.profileId).revision, 0);
});

test("daily budgets prevent extra runs, include actual tokens and survive restart with unknown usage", async t => {
  for (const boundary of ["runs", "tokens", "unknown", "zero"]) await t.test(boundary, async t => {
    const f = await fixture(t, "pi");
    const monitor = await f.get();
    await f.save({ ...monitor.config, budget: { maxRunsPerDay: boundary === "runs" ? 1 : 24, maxTokensPerDay: 1024 } });
    f.setGenerate(input => { const output = f.reply(input);
      if (boundary === "tokens") output.usage = { ...output.usage, inputTokens: 1200, totalTokens: 1208 };
      if (boundary === "unknown") output.usage = null;
      if (boundary === "zero") output.usage.totalTokens = 0; return output; });
    assert.equal((await f.tick()).state, "published");
    await f.service.stop({ notify: false }); await f.service.start();
    const second = await f.tick();
    assert.equal(second.reason, ["unknown", "zero"].includes(boundary) ? "usage_unverified" : "budget_exhausted");
    assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  });
});

test("malformed and cross-run responses never commit notes or notices", async t => {
  for (const kind of ["malformed", "wrong-run", "wrong-candidate"]) await t.test(kind, async t => {
    const f = await fixture(t, "deepseek-harness");
    f.setGenerate(input => { const output = f.reply(input), parsed = JSON.parse(output.text);
      if (kind === "wrong-run") parsed.runId = id();
      if (kind === "wrong-candidate") parsed.candidates[0].evidenceVersion = "0".repeat(64);
      output.text = kind === "malformed" ? "```json\n" + output.text + "\n```" : JSON.stringify(parsed); return output; });
    const check = await f.tick(); assert.equal(check.reason, "PROACTIVE_RESPONSE_INVALID");
    assert.equal(f.sent.length, 0); assert.equal(f.service.proactiveStore.heartbeatScratch(f.profileId).revision, 0);
  });
});
