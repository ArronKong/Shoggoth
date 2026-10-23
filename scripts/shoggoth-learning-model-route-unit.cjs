"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { openFixture: openCoordinatorFixture, PROFILE_ID } = require("./shoggoth-work-run-coordinator-unit.cjs");
async function openFixture(options) {
  const f = await openCoordinatorFixture(options);
  f.productStore.resolveAgentRuntimeProfile = (profileId, bindingId) => {
    assert.equal(bindingId, undefined, "learning never selects a foreground session binding");
    return { ...f.productStore.getAgentProfile(profileId), selectedBindingId: "fixture-default-binding" };
  };
  return f;
}
const input = (suffix, signal) => ({ profileId: PROFILE_ID, operationId: `learning-route-${suffix}`,
  prompt: "Review supplied verified evidence only.", maxOutputBytes: 4096, timeoutMs: 10000, ...(signal ? { signal } : {}) });

for (const runtime of ["grok-build", "antigravity", "pi", "claude-code", "opencode", "deepseek-harness"]) {
  test(`${runtime}: learning follows Agent default and uses its isolated model-only contract`, async () => {
    let called = 0;
    const manager = { canGenerateModelOnly: () => true, stop() {}, stopAll() {},
      async acquire(binding, options) {
        assert.equal(binding.runtime, runtime);
        assert.equal(options.workspace, null);
        assert.equal(options.executionContract.source, "skill_learning");
        assert.deepEqual(options.permissionPolicy, { approvalPolicy: "never", sandbox: "read-only" });
        assert.match(options.executionContract.developerInstructions, /Skill|procedur/iu);
        return { capabilities: { "model.generate.toolFree": true }, async generateModelOnly(request) {
          called++; assert.equal(request.model, "gpt-test");
          assert.equal(request.tools, undefined); assert.equal(request.sessionId, undefined);
          request.assertCurrent(); return { text: '{"action":"noop","reason":"not enough evidence"}', usage: null };
        } };
      } };
    const f = await openFixture({ runtime, runtimeManager: manager, modelOverride: "foreground-only-model" });
    try {
      const context = f.coordinator.resolveLearningModelContext({ profileId: PROFILE_ID });
      assert.equal(context.model, "gpt-test"); assert.equal(context.runtime, runtime); assert.equal(context.supported, true);
      const result = await f.coordinator.generateLearningText(input(runtime));
      assert.equal(result.usage, null); assert.equal(called, 1); assert.equal(f.dispatcher.listRuns().length, 0);
      assert.throws(() => f.coordinator.generateLearningText({ ...input(runtime), sessionKey: "temporary" }), { code: "LEARNING_INVALID" });
    } finally { await f.coordinator.close(); }
  });
}
test("learning refuses an unsupported model-only Runtime before any generation", async () => {
  const manager = { canGenerateModelOnly: () => false, stop() {}, stopAll() {}, async acquire() { throw new Error("must not dispatch"); } };
  const f = await openFixture({ runtime: "pi", runtimeManager: manager });
  try { assert.equal(f.coordinator.resolveLearningModelContext({ profileId: PROFILE_ID }).supported, false); }
  finally { await f.coordinator.close(); }
});

for (const confirmed of [true, false]) test(`Codex cancellation ${confirmed ? "waits for a terminal receipt" : "retains capacity when stop is unknown"}`, async () => {
  const listeners = new Set(), abort = new AbortController(); let entered, releaseCount = 0, admissionReleases = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const host = { capabilities: {}, async sessionStart(request) {
    assert.equal(request.isolatedGeneration, true); assert.equal(request.model, "gpt-test");
    return { session: { id: "learning-ephemeral" } };
  }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async turnStart() { entered(); return { turn: { id: "learning-turn" } }; },
  async turnInterrupt() {
    if (confirmed) setTimeout(() => { for (const fn of listeners) fn({ type: "complete", sessionId: "learning-ephemeral",
      turnId: "learning-turn", status: "canceled" }); }, 15);
  }, async releaseModelOnlySession() { releaseCount++; } };
  const manager = { canGenerateModelOnly: () => true, async acquire() { return host; }, stop() {}, stopAll() {} };
  const admission = { admit: () => ({ disposition: "started", generation: 1 }), assertGeneration() {},
    noteBackoff() {}, noteRateLimitBackoff() {},
    release() { admissionReleases++; } };
  const f = await openFixture({ runtimeManager: manager, runtimeAccountAdmission: admission });
  try {
    const call = f.coordinator.generateLearningText(input(`codex-${confirmed}`, abort.signal));
    const rejected = assert.rejects(call, { code: confirmed ? "MODEL_ONLY_CANCELED" : "RUNTIME_STOP_UNCONFIRMED" });
    await started; abort.abort(); await rejected;
    assert.equal(releaseCount, 1); assert.equal(listeners.size, 0);
    assert.equal(admissionReleases, confirmed ? 1 : 0);
    assert.equal(f.coordinator.memoryExtractionTasks.size, 0);
  } finally { await f.coordinator.close(); }
});

test("Runtime V1 transports scoped model-session release and rejects invalid or unconfirmed receipts", async () => {
  const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
  const binding = { runtime: "codex", runtimeProfileId: "learning", runtimeAccountId: "learning" };
  let calls = 0, receipt = { sessionId: "owned-ephemeral", released: true };
  const raw = { ...binding, capabilities: { "model.session.release": true }, terminated: new Promise(() => {}),
    subscribe: () => () => {}, async releaseModelOnlySession(input) { calls++; assert.deepEqual(input, { sessionId: "owned-ephemeral" }); return receipt; } };
  const handle = runtimeHandleV1(raw, binding);
  assert.equal(handle.capabilities["model.session.release"], true);
  assert.deepEqual(await handle.releaseModelOnlySession({ sessionId: "owned-ephemeral" }), receipt);
  for (const request of [{}, { sessionId: "" }, { sessionId: "owned-ephemeral", force: true }]) {
    await assert.rejects(handle.releaseModelOnlySession(request), { code: "RUNTIME_PROTOCOL_INVALID" });
  }
  assert.equal(calls, 1);
  for (const invalid of [null, {}, { sessionId: "foreign", released: true }, { sessionId: "owned-ephemeral", released: false }]) {
    receipt = invalid;
    await assert.rejects(handle.releaseModelOnlySession({ sessionId: "owned-ephemeral" }), { code: "RUNTIME_STOP_UNCONFIRMED" });
  }
  assert.equal(typeof runtimeHandleV1({ ...raw, capabilities: {} }, binding).releaseModelOnlySession, "undefined");
});

test("Codex learning inherits the native default and reports the model resolved at session start through Runtime V1", async () => {
  const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
  const listeners = new Set(); let released = 0;
  const manager = { stop() {}, stopAll() {}, async acquire(binding) {
    const raw = { ...binding, terminated: new Promise(() => {}), capabilities: {
      "session.start": true, "turn.start": true, "turn.interrupt": true, "model.session.release": true, "account.read": true },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async accountRead() { return { account: null, requiresOpenaiAuth: false }; },
      async sessionStart(request) { assert.equal(request.model, undefined); assert.equal(request.persistent, false);
        return { session: { id: "learning-default-session" }, model: "runtime-default-model" }; },
      async turnStart(request) { assert.equal(request.model, undefined);
        setImmediate(() => { for (const fn of listeners) {
          fn({ known: true, type: "text", sessionId: "learning-default-session", turnId: "default-turn", itemId: "answer",
            text: '{"action":"noop","reason":"No additional method"}', phase: "final_answer" });
          fn({ known: true, type: "complete", sessionId: "learning-default-session", turnId: "default-turn", status: "completed" });
        } }); return { turn: { id: "default-turn" } }; },
      async turnInterrupt() {}, async releaseModelOnlySession({ sessionId }) { released++; return { sessionId, released: true }; },
    };
    return runtimeHandleV1(raw, binding);
  } };
  const f = await openFixture({ runtimeManager: manager });
  try {
    const getAgentProfile = f.productStore.getAgentProfile.bind(f.productStore);
    f.productStore.getAgentProfile = (id) => ({ ...getAgentProfile(id), defaultModel: null });
    assert.equal(f.coordinator.resolveLearningModelContext({ profileId: PROFILE_ID }).model, null);
    const output = await f.coordinator.generateLearningText(input("native-default"));
    assert.equal(output.model, "runtime-default-model"); assert.equal(released, 1); assert.equal(listeners.size, 0);
  } finally { await f.coordinator.close(); }
});

test("learning obtains context size from the selected Agent binding and exact model", async () => {
  const f = await openFixture({ runtime: "pi" });
  try {
    f.coordinator.getRuntimeModelContextWindow = (session, profile) => {
      assert.equal(session.profileId, PROFILE_ID); assert.equal(session.runtimeBindingId, "fixture-default-binding");
      assert.equal(session.modelOverride, "gpt-test"); assert.equal(profile.runtime, "pi"); return 128000;
    };
    assert.equal(f.coordinator.resolveLearningModelContext({ profileId: PROFILE_ID }).contextWindow, 128000);
    f.coordinator.getRuntimeModelContextWindow = () => null;
    assert.equal(f.coordinator.resolveLearningModelContext({ profileId: PROFILE_ID }).contextWindow, null);
  } finally { await f.coordinator.close(); }
});
