"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { openFixture, FakeChatSessionStore, SESSION_KEY, PROFILE_ID } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { PiRuntimePool } = require("../app/agent-service/pi-runtime-pool");
const { resolveRuntimePermissionMode } = require("../app/agent-service/runtime-permission-modes");
const { runtimeStageError } = require("../app/agent-service/runtime-stage-error");
const { mapChatServiceError } = require("../app/agent-service/chat-service-protocol");
const failure = code => Object.assign(new Error(code), { code });
function enableAdmission(f) {
  const config = f.service.nativeRuntimeConfig.read();
  if (!config.flags.runtimeAdmissionV1) f.service.nativeRuntimeConfig.apply({ ...config,
    revision: config.revision + 1, flags: { ...config.flags, runtimeAdmissionV1: true } });
}

// Real Service wiring and Pi pool routing; every process and provider is fake.
test("Pi Hook preflight uses the control host when the chat command host has a different session policy", async () => {
  const f = await openHandoffFixture();
  let pool;
  try {
    enableAdmission(f);
    f.profile = f.service.productStore.putAgentProfile({ ...f.service.productStore.getAgentProfile(f.profile.id),
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "danger-full-access" } });
    const session = f.createSession();
    await f.switch(session.sessionKey, "pi");
    f.service.chatSessionStore.setPermissionMode(session.sessionKey, "request-approval");
    const profile = f.service.productStore.resolveAgentRuntimeProfile(f.profile.id, f.binding("pi").id);
    const binding = { runtime: "pi", runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId };
    const hostOptions = [];
    pool = new PiRuntimePool({
      runtimeAccountLookup: () => ({}),
      runtimeAccountResolver: { resolve: () => Object.freeze({
        runtime: "pi", runtimeAccountId: binding.runtimeAccountId, home: f.root,
        binaryPath: process.execPath, launchArgs: Object.freeze([]),
        spawnEnv: Object.freeze({ HOME: f.root, PI_CODING_AGENT_DIR: f.root }), configurationMode: "native",
      }) },
      hostFactory(options) {
        hostOptions.push(options);
        return { initialize: async () => {}, beginAcquire() {}, stop: async () => {},
          nativeHookCapabilities: () => ({}), terminated: new Promise(() => {}) };
      },
    });
    // The actual command-list path and model-list control path have already
    // acquired their hosts before this request changes its effective policy.
    await pool.get(binding, { workspace: f.workspace, permissionPolicy: profile.permissionPolicy });
    await pool.get(binding, { permissionPolicy: profile.permissionPolicy });
    const acquire = f.service.runtimeManager.acquire.bind(f.service.runtimeManager);
    f.service.runtimeManager.acquire = (value, options = {}) => value.runtime === "pi" && !options.executionContract
      ? pool.get(value, options) : acquire(value, options);
    const run = await f.send(session.sessionKey, "pi-after-command-list");
    assert.equal(run.status, "running");
    assert.equal(hostOptions.length, 2, "preflight reuses the existing control host");
    const execution = f.transport.acquisitions.find(entry => entry.options.executionContract?.runId === run.id);
    assert.deepEqual(execution.options.permissionPolicy,
      resolveRuntimePermissionMode("pi", "request-approval", profile.permissionPolicy).permissionPolicy,
      "the real run keeps the session policy; preflight must not broaden it");
    assert.notDeepEqual(execution.options.permissionPolicy, profile.permissionPolicy);
    await f.complete(run);
  } finally { await f.close(); await pool?.stopAll(); }
});

async function queuedFixture(options = {}) {
  const first = new FakeChatSessionStore([]), second = new FakeChatSessionStore([]);
  second.session = { ...second.session, id: "44444444-4444-4444-8444-444444444444",
    sessionKey: "22222222-2222-4222-8222-222222222222", profileId: "neighbor-agent" };
  const stores = new Map([[first.session.sessionKey, first], [second.session.sessionKey, second]]);
  const sessions = { listPendingBindings: () => [...stores.values()].flatMap(store => store.listPendingBindings()),
    recoverBinding: input => stores.get(input.sessionKey).recoverBinding(input) };
  for (const name of ["getSession", "requestBinding", "completeBinding", "getBinding"]) {
    sessions[name] = (key, ...args) => stores.get(key)?.[name](key, ...args) ?? null;
  }
  const f = await openFixture({ ...options, sessions, busy: true,
    getNativeRuntimeConfig: () => ({ maxActive: 32, startupConcurrency: 8,
      flags: { runtimeAdmissionV1: options.admission !== false } }) });
  const getProfile = f.productStore.getAgentProfile.bind(f.productStore);
  f.productStore.getAgentProfile = id => ({ ...getProfile(PROFILE_ID), id });
  let fault = null;
  f.coordinator.hookService = {
    async prepareRun(run, profile) { if (profile.id === PROFILE_ID && fault) throw fault; return null; },
    observeRun() {}, observeSession() {}, releaseRun() {}, runner: { cancelRun: async () => {} },
  };
  f.inputs = [
    { operationId: "failed-preparation", sessionKey: SESSION_KEY, prompt: "first agent" },
    { operationId: "unrelated-agent", sessionKey: second.session.sessionKey, prompt: "second agent" },
  ];
  f.queued = [];
  for (const input of f.inputs) f.queued.push((await f.coordinator.send(input)).run);
  assert.ok(f.queued.every(run => run.status === "queued"));
  f.inject = error => { fault = error; f.dispatcher.busy = false; };
  return f;
}

for (const admission of [false, true]) {
  for (const code of ["RUNTIME_PERMISSION_POLICY_CONFLICT", "RUNTIME_ACCOUNT_BINDING_CONFLICT", "RUNTIME_HOOK_SCOPE_CONFLICT"]) {
    test(`preparation ${code} terminates only its own input and drains the neighbor (admission=${admission})`, async () => {
      const f = await queuedFixture({ admission });
      try {
        f.inject(failure(code));
        await Promise.all([f.coordinator.capacityChanged(), f.coordinator.capacityChanged()]);
        await f.coordinator.waitForIdle(f.queued[1].id);
        const failed = f.dispatcher.getRun(f.queued[0].id);
        assert.equal(failed.status, "failed");
        assert.equal(failed.errorCode, code);
        assert.equal(failed.runtimeTurnRef, null);
        assert.equal(f.inbox.get(f.inputs[0].operationId).state, "completed");
        assert.equal(f.dispatcher.getRun(f.queued[1].id).status, "running");
        assert.equal(f.host.turnStartCalls, 1);
        assert.equal(f.log.filter(entry => entry === "dispatcher.transition:failed").length, 1);
        assert.equal(f.coordinator.poisonError, null);
        const replay = await f.coordinator.send(f.inputs[0]);
        assert.equal(replay.disposition, "completed");
        assert.equal(replay.run.id, failed.id);
        assert.equal(replay.run.errorCode, code);
        assert.equal(f.host.turnStartCalls, 1, "re-reading the failed operation must not resend it");
      } finally { await f.coordinator.close(); }
    });
  }
}

test("a typed Runtime acquisition failure during preparation cannot strand unrelated work", async () => {
  const f = await queuedFixture();
  try {
    f.inject(runtimeStageError("runtime_acquire", failure("PI_NODE_NOT_FOUND")));
    await f.coordinator.capacityChanged();
    await f.coordinator.waitForIdle(f.queued[1].id);
    assert.equal(f.dispatcher.getRun(f.queued[0].id).errorCode, "RUNTIME_START_RUNTIME_ACQUIRE_FAILED");
    assert.equal(f.dispatcher.getRun(f.queued[1].id).status, "running");
    assert.equal(f.coordinator.poisonError, null);
  } finally { await f.coordinator.close(); }
});

test("temporary control-host capacity stays queued while another Agent can start", async () => {
  const f = await queuedFixture();
  try {
    f.inject(failure("RUNTIME_HOST_CAPACITY"));
    await f.coordinator.capacityChanged();
    await f.coordinator.waitForIdle(f.queued[1].id);
    assert.equal(f.dispatcher.getRun(f.queued[0].id).status, "queued");
    assert.equal(f.inbox.get(f.inputs[0].operationId).state, "pending");
    assert.equal(f.coordinator.runQueueStates.get(f.queued[0].id).reason, "RUNTIME_HOST_CAPACITY");
    assert.equal(f.dispatcher.getRun(f.queued[1].id).status, "running");
    assert.equal(f.coordinator.poisonError, null);
  } finally { await f.coordinator.close(); }
});

test("a failed durable terminal write retains the recovery barrier instead of draining other inputs", async () => {
  const f = await queuedFixture({ transitionFailures: { failed: "STORE_COMMIT_UNCERTAIN" } });
  try {
    f.inject(failure("RUNTIME_PERMISSION_POLICY_CONFLICT"));
    await assert.rejects(f.coordinator.capacityChanged(), { code: "STORE_COMMIT_UNCERTAIN" });
    assert.equal(f.coordinator.poisonError.code, "STORE_COMMIT_UNCERTAIN");
    assert.ok(f.dispatcher.listRuns().every(run => run.status === "queued"));
    assert.equal(f.host.turnStartCalls, 0);
    assert.equal(f.inbox.get(f.inputs[0].operationId).state, "pending");
  } finally { await f.coordinator.close(); }
});

test("unclassified persistence errors during preparation are not converted into a routine rejected input", async () => {
  const f = await queuedFixture();
  try {
    f.inject(failure("TRANSCRIPT_WRITE_FAILED"));
    await assert.rejects(f.coordinator.capacityChanged(), { code: "TRANSCRIPT_WRITE_FAILED" });
    assert.ok(f.dispatcher.listRuns().every(run => run.status === "queued"));
    assert.equal(f.host.turnStartCalls, 0);
    assert.equal(f.inbox.get(f.inputs[0].operationId).state, "pending");
  } finally { await f.coordinator.close(); }
});

test("runtime policy conflicts keep the same explicit message through IPC and the chat backend", async () => {
  const { ShoggothBackend } = require("../app/core/shoggoth-backend");
  const backend = new ShoggothBackend({ requestService: async () => { throw Error("No live service allowed"); } });
  for (const code of ["RUNTIME_PERMISSION_POLICY_CONFLICT", "RUNTIME_ACCOUNT_BINDING_CONFLICT", "RUNTIME_HOOK_SCOPE_CONFLICT"]) {
    const mapped = mapChatServiceError(failure(code));
    assert.equal(mapped.code, code);
    let message;
    await backend._settleTerminal({ sessionKey: "fixture", run: { id: code },
      hooks: { error: value => { message = value; } } }, { settled: false },
    { id: code, status: "failed", errorCode: code });
    assert.equal(message, mapped.message);
  }
});


for (const code of ["RUNTIME_PERMISSION_POLICY_CONFLICT", "PI_NODE_NOT_FOUND", "RUNTIME_HOST_CAPACITY"]) {
  test(`real Service contains Pi preflight ${code} and keeps a different Runtime usable`, async () => {
    const f = await openHandoffFixture();
    try {
      enableAdmission(f);
      const piSession = f.createSession();
      await f.switch(piSession.sessionKey, "pi");
      const acquire = f.service.runtimeManager.acquire.bind(f.service.runtimeManager);
      f.service.runtimeManager.acquire = (binding, options = {}) => {
        if (binding.runtime === "pi" && !options.executionContract) throw failure(code);
        return acquire(binding, options);
      };
      const failed = await f.send(piSession.sessionKey, "preflight-failure");
      assert.equal(failed.status, code === "RUNTIME_HOST_CAPACITY" ? "queued" : "failed");
      if (failed.status === "failed") {
        assert.equal(failed.errorCode, code === "PI_NODE_NOT_FOUND" ? "RUNTIME_START_RUNTIME_ACQUIRE_FAILED" : code);
        assert.equal(f.service.productStore.getWorkRun(failed.id).errorCode, failed.errorCode);
      }
      assert.equal(failed.runtimeTurnRef, null);
      const other = f.createSession();
      const started = await f.send(other.sessionKey, "different-runtime");
      assert.equal(started.status, "running");
      await f.complete(started);
      assert.equal(f.service.workRunCoordinator.poisonError, null);
      if (failed.status === "failed") {
        const operation = await f.service.workRunCoordinator.send({ sessionKey: piSession.sessionKey,
          operationId: "preflight-failure", prompt: "fixture preflight-failure" });
        assert.equal(operation.disposition, "completed");
        assert.equal(operation.run.id, failed.id);
        assert.equal(operation.run.status, "failed");
      }
    } finally { await f.close(); }
  });
}


test("a durable preparation failure remains terminal across Service restart and the same operation cannot replay", async () => {
  let f = await openHandoffFixture();
  try {
    enableAdmission(f);
    const session = f.createSession();
    await f.switch(session.sessionKey, "pi");
    const acquire = f.service.runtimeManager.acquire.bind(f.service.runtimeManager);
    f.service.runtimeManager.acquire = (binding, options = {}) => {
      if (binding.runtime === "pi" && !options.executionContract) throw failure("RUNTIME_PERMISSION_POLICY_CONFLICT");
      return acquire(binding, options);
    };
    const failed = await f.send(session.sessionKey, "restart-preserves-failure");
    assert.equal(failed.status, "failed");
    const history = f.service.transcriptStore.listEvents(f.profile.id, session.id);
    const root = f.root;
    await f.close({ remove: false });
    f = await openHandoffFixture({ root });
    assert.deepEqual(f.service.workRunCoordinator.getRun(failed.id), failed);
    const observed = await f.send(session.sessionKey, "restart-preserves-failure");
    assert.deepEqual(observed, failed);
    assert.deepEqual(f.service.transcriptStore.listEvents(f.profile.id, session.id), history);
    assert.equal(f.transport.acquisitions.filter(entry => entry.options.executionContract).length, 0);
  } finally { await f.close(); }
});
