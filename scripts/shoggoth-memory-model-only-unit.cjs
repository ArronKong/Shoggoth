"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { openFixture, PROFILE_ID, SESSION_KEY } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");

function input(session, operationId = "memory-extraction-test-1") {
  return { profileId: PROFILE_ID, sessionId: session.id, sessionKey: SESSION_KEY,
    workspace: session.workspace, operationId, prompt: "Extract only review candidates from the user text.",
    events: [{ eventId: "event-1", text: "我每周五做复盘。" }], toolFree: true,
    maxOutputBytes: 16 * 1024, timeoutMs: 1_000,
    extractorVersion: "native-memory-candidates-v1" };
}

function selectExtractionBinding(value, bindingId) {
  const original = value.coordinator.productStore.getAgentProfile.bind(value.coordinator.productStore);
  value.coordinator.productStore.getAgentProfile = (profileId) => ({
    ...original(profileId), selectedBindingId: bindingId,
  });
  value.coordinator.runtimeManager.canGenerateModelOnly = () => true;
}

test("memory extraction on the current binding uses the explicitly selected session model", async () => {
  const value = await openFixture({ sessionStatus: "ready", modelOverride: "selected-model" });
  try {
    value.sessions.session.runtimeBindingId = "binding-current";
    selectExtractionBinding(value, "binding-current");
    const routes = [];
    value.coordinator.captureExecutionProviderRoute = (_profile, model) => { routes.push(model); return null; };
    let request;
    value.coordinator.runtimeManager.acquire = async () => ({
      capabilities: { "model.generate.toolFree": true },
      generateModelOnly: async (args) => { request = args; return { text: '{"candidates":[]}' }; },
    });
    const result = await value.coordinator.extractMemoryCandidatesModelOnly(input(value.sessions.session));
    assert.equal(request.model, "selected-model");
    assert.deepEqual(routes, ["selected-model"]);
    assert.equal(result.model, "selected-model");
  } finally { await value.coordinator.close(); }
});

test("memory extraction on a fallback binding keeps that binding's model", async () => {
  const value = await openFixture({ sessionStatus: "ready", modelOverride: "selected-model" });
  try {
    value.sessions.session.runtimeBindingId = "binding-current";
    selectExtractionBinding(value, "binding-fallback");
    let request;
    value.coordinator.runtimeManager.acquire = async () => ({
      capabilities: { "model.generate.toolFree": true },
      generateModelOnly: async (args) => { request = args; return { text: '{"candidates":[]}' }; },
    });
    await value.coordinator.extractMemoryCandidatesModelOnly(input(value.sessions.session));
    assert.equal(request.model, "gpt-test");
  } finally { await value.coordinator.close(); }
});

test("a session model change during acquisition stops extraction before the provider call", async () => {
  const value = await openFixture({ sessionStatus: "ready", modelOverride: "selected-model" });
  try {
    value.sessions.session.runtimeBindingId = "binding-current";
    selectExtractionBinding(value, "binding-current");
    let modelCalls = 0;
    value.coordinator.runtimeManager.acquire = async () => {
      value.sessions.session.modelOverride = "new-model";
      return { capabilities: { "model.generate.toolFree": true },
        generateModelOnly: async () => { modelCalls++; return { text: '{"candidates":[]}' }; } };
    };
    await assert.rejects(value.coordinator.extractMemoryCandidatesModelOnly(input(value.sessions.session)),
      error => error.code === "MEMORY_EXTRACTION_BINDING_STALE");
    assert.equal(modelCalls, 0);
  } finally { await value.coordinator.close(); }
});

test("memory extraction uses a verified tool-free host without persistent WorkRun or checkpoint", async () => {
  const value = await openFixture({ sessionStatus: "ready" });
  try {
    const calls = [];
    value.coordinator.runtimeManager.canGenerateModelOnly = () => true;
    value.coordinator.runtimeManager.acquire = async (binding, options) => {
      calls.push({ binding, options });
      return { capabilities: { "model.generate.toolFree": true },
        generateModelOnly: async (request) => {
          calls.push(request);
          return { text: '{"candidates":[]}', model: "test-model", provider: null,
            usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5,
              cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 } };
        } };
    };
    const result = await value.coordinator.extractMemoryCandidatesModelOnly(input(value.sessions.session));
    assert.equal(result.text, '{"candidates":[]}');
    assert.equal(result.usage.totalTokens, 15);
    assert.equal(result.runtime, "codex");
    assert.deepEqual(calls[0].options.permissionPolicy,
      { approvalPolicy: "never", sandbox: "read-only" });
    assert.equal(calls[0].options.executionContract.runId, "memory-extraction-test-1",
      "read-only extraction must have its own pool identity instead of colliding with a warm chat host");
    assert.equal(calls[1].operationId, "memory-extraction-test-1");
    assert.equal(value.dispatcher.listRuns().length, 0);
    assert.equal(value.usageRecords.length, 0);
  } finally { await value.coordinator.close(); }
});

test("memory extraction never sends a frozen source revoked during Runtime acquisition", async () => {
  let sourceCurrent = true;
  const value = await openFixture({ sessionStatus: "ready",
    verifyMemoryExtractionSource: () => sourceCurrent });
  try {
    let acquired;
    const enteredAcquire = new Promise((resolve) => { acquired = resolve; });
    let release;
    const acquisitionGate = new Promise((resolve) => { release = resolve; });
    let modelCalls = 0;
    value.coordinator.runtimeManager.canGenerateModelOnly = () => true;
    value.coordinator.runtimeManager.acquire = async () => {
      acquired();
      await acquisitionGate;
      return { capabilities: { "model.generate.toolFree": true },
        generateModelOnly: async () => { modelCalls++; return { text: '{"candidates":[]}' }; } };
    };
    const call = value.coordinator.extractMemoryCandidatesModelOnly(input(value.sessions.session,
      "memory-extraction-revoked-before-send"));
    await enteredAcquire;
    sourceCurrent = false;
    release();
    await assert.rejects(call, (error) => error.code === "MEMORY_EXTRACTION_SOURCE_UNAVAILABLE");
    assert.equal(modelCalls, 0);
    assert.equal(value.dispatcher.listRuns().length, 0);
  } finally { await value.coordinator.close(); }
});

test("service rejects a corrected or expired source before sending a queued extraction prompt", async (t) => {
  for (const state of ["superseded", "expired"]) {
    await t.test(state, async () => {
      const f = await openHandoffFixture();
      let releaseAcquire;
      try {
        // Keep the completed chat Run as genuine transcript evidence while
        // preventing the unrelated automatic candidate wake from using this host.
        f.service.memoryCandidateService.processSession = async () => ({ created: 0, modelCalls: 0 });
        const session = f.service.chatSessionStore.createSession({
          profileId: f.profile.id, workspace: fs.realpathSync(f.workspace),
          operationId: `extraction-create-${state}`, createdAt: Date.now(),
        });
        const run = await f.send(session.sessionKey, `extraction-source-${state}`,
          "我的项目代号是蓝鸟。");
        assert.equal(run.status, "running", run.errorCode);
        await f.complete(run);
        const source = f.service.transcriptStore.listEvents(session.profileId, session.id)
          .find((event) => event.kind === "user" && event.runId === run.id);
        assert.ok(source);
        const visibleBefore = f.service.conversationRecallService.scanEligibleSession({
          profileId: session.profileId, sessionId: session.id,
          afterSeq: source.seq - 1, limit: 1, completedOnly: true });
        assert.equal(visibleBefore.events[0]?.eventId, source.id,
          "completed direct user source must be eligible before Runtime acquisition");
        const old = f.service.memoryEngine.propose({ profileId: session.profileId,
          scope: "project", type: "semantic", content: "用户的项目代号是蓝鸟",
          sourceRefs: [source.id, run.id], classification: "explicit" });
        const manager = f.service.workRunCoordinator.runtimeManager;
        manager.canGenerateModelOnly = () => true;
        let enteredAcquire;
        const acquired = new Promise((resolve) => { enteredAcquire = resolve; });
        const gate = new Promise((resolve) => { releaseAcquire = resolve; });
        let modelCalls = 0;
        manager.acquire = async () => {
          enteredAcquire();
          await gate;
          return { capabilities: { "model.generate.toolFree": true },
            generateModelOnly: async () => { modelCalls++; return { text: '{"candidates":[]}' }; } };
        };
        const call = f.service.workRunCoordinator.extractMemoryCandidatesModelOnly({
          profileId: session.profileId, sessionId: session.id, sessionKey: session.sessionKey,
          workspace: session.workspace, operationId: `extraction-outdated-${state}`,
          prompt: `Extract the original user message: ${source.content.text}`,
          events: [{ eventId: source.id, text: source.content.text }],
          toolFree: true, maxOutputBytes: 16 * 1024, timeoutMs: 10_000,
          extractorVersion: "native-memory-candidates-v1",
        });
        await acquired;
        if (state === "superseded") {
          f.service.memoryEngine.propose({ profileId: session.profileId,
            scope: "project", type: "semantic", content: "用户的项目代号是绿洲",
            sourceRefs: ["user-edit:manual"], classification: "explicit", supersedes: old.id });
        } else {
          f.service.memoryEngine.update({ profileId: session.profileId,
            id: old.id, validUntil: Date.now() - 1 });
        }
        releaseAcquire();
        releaseAcquire = null;
        await assert.rejects(call,
          (error) => error.code === "MEMORY_EXTRACTION_SOURCE_UNAVAILABLE");
        assert.equal(modelCalls, 0, "outdated prompt must never reach generateModelOnly");
      } finally {
        releaseAcquire?.();
        await f.close();
      }
    });
  }
});

test("memory extraction cancel stops the model task and cannot return candidates", async () => {
  const value = await openFixture({ sessionStatus: "ready" });
  try {
    value.coordinator.runtimeManager.canGenerateModelOnly = () => true;
    let started;
    const active = new Promise((resolve) => { started = resolve; });
    value.coordinator.runtimeManager.acquire = async () => ({
      capabilities: { "model.generate.toolFree": true },
      generateModelOnly: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("canceled"),
          { code: "MODEL_ONLY_CANCELED" })), { once: true });
        started();
      }),
    });
    const operationId = "memory-extraction-cancel-1";
    const call = value.coordinator.extractMemoryCandidatesModelOnly(input(value.sessions.session, operationId));
    await active;
    assert.deepEqual(value.coordinator.cancelMemoryExtraction(operationId), { canceled: true, operationId });
    await assert.rejects(call, (error) => error.code === "MODEL_ONLY_CANCELED");
    assert.equal(value.dispatcher.listRuns().length, 0);
  } finally { await value.coordinator.close(); }
});

test("memory extraction fences account generation after the model returns", async () => {
  const value = await openFixture({ sessionStatus: "ready" });
  try {
    value.coordinator.runtimeManager.canGenerateModelOnly = () => true;
    let generation = 1;
    let releaseCount = 0;
    value.coordinator.runtimeAccountAdmission = {
      admit: () => ({ disposition: "started", generation: 1 }),
      assertGeneration: (admission) => {
        assert.equal(admission.runtimeAccountId, "runtime-account-default");
        if (admission.generation !== generation) throw Object.assign(new Error("stale"),
          { code: "RUNTIME_ACCOUNT_GENERATION_STALE" });
      },
      release: () => { releaseCount++; },
    };
    value.coordinator.runtimeManager.acquire = async () => ({
      capabilities: { "model.generate.toolFree": true },
      generateModelOnly: async () => { generation = 2; return { text: '{"candidates":[]}' }; },
    });
    await assert.rejects(value.coordinator.extractMemoryCandidatesModelOnly(input(value.sessions.session,
      "memory-extraction-fence-1")), (error) => error.code === "RUNTIME_ACCOUNT_GENERATION_STALE");
    assert.equal(releaseCount, 1);
    assert.equal(value.dispatcher.listRuns().length, 0);
  } finally {
    value.coordinator.runtimeAccountAdmission = null;
    await value.coordinator.close();
  }
});

test("memory extraction rejects output after the Provider route changes", async () => {
  const value = await openFixture({ sessionStatus: "ready" });
  try {
    value.coordinator.runtimeManager.canGenerateModelOnly = () => true;
    let routeRevision = 1;
    value.coordinator.captureExecutionProviderRoute = () => ({ routeRevision });
    value.coordinator.assertExecutionProviderRouteCurrent = (frozen) => {
      if (frozen.routeRevision !== routeRevision) throw Object.assign(new Error("stale provider"),
        { code: "EXECUTION_PROVIDER_ROUTE_STALE" });
    };
    value.coordinator.runtimeManager.acquire = async () => ({
      capabilities: { "model.generate.toolFree": true },
      generateModelOnly: async () => { routeRevision = 2; return { text: '{"candidates":[]}' }; },
    });
    await assert.rejects(value.coordinator.extractMemoryCandidatesModelOnly(input(value.sessions.session,
      "memory-extraction-provider-fence-1")), (error) => error.code === "EXECUTION_PROVIDER_ROUTE_STALE");
    assert.equal(value.dispatcher.listRuns().length, 0);
  } finally { await value.coordinator.close(); }
});
