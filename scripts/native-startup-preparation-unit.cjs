"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs"), path = require("node:path");
const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const { runtimeCapabilities } = require("../app/agent-service/runtime-adapter");
const { PiRuntimeHost } = require("../app/agent-service/pi-runtime-host");
const { AntigravityAcpRuntimeHost } = require("../app/agent-service/antigravity-acp-runtime-host");
const { OpenCodeRuntimeHost, nativePermissionRules } = require("../app/agent-service/opencode-runtime-host");
const RUNTIMES = ["codex", "pi", "deepseek-harness", "opencode", "grok-build", "antigravity", "claude-code"];
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));

function facadeFixture(runtime = "codex") {
  const binding = { runtime, runtimeProfileId: "fixture-profile", runtimeAccountId: "fixture-account" };
  const terminated = deferred(), calls = [], gates = new Map();
  let identityCurrent = true;
  const read = async (method, input) => {
    calls.push([method, input]);
    const gate = gates.get(method);
    if (gate) await gate.promise;
    return method === "modelsList" ? { data: [{ model: input?.cursor || "fixture" }], nextCursor: null }
      : method === "accountRead" ? { account: { type: "fixture" }, requiresOpenaiAuth: true }
        : { authenticated: true, credentialPresent: true };
  };
  const raw = { ...binding, terminated: terminated.promise, subscribe: () => () => {},
    host: { assertRuntimeIdentityCurrent() {
      if (!identityCurrent) throw Object.assign(new Error("identity changed"), { code: "RUNTIME_EXECUTABLE_CHANGED" });
    } },
    capabilities: runtimeCapabilities({ "models.list": true, "account.read": true,
      "account.login": true, "account.logout": true, "turn.start": true }),
    modelsList: input => read("modelsList", input), accountRead: input => read("accountRead", input),
    authenticationState: input => read("authenticationState", input),
    accountLoginStart: async () => ({}), accountLogout: async () => ({}),
    providerLoginApiKey: async () => true,
    turnStart: async input => { calls.push(["turnStart", input]); return { turn: { id: "turn-1" } }; },
  };
  return { handle: runtimeHandleV1(raw, binding), raw, binding, calls, terminated,
    block(method) { const gate = deferred(); gates.set(method, gate); return gate; },
    changeIdentity() { identityCurrent = false; } };
}

for (const runtime of RUNTIMES) {
  test(`${runtime}: concurrent catalog reads share one native query, with independent results and no settled cache`, async () => {
    const f = facadeFixture(runtime), gate = f.block("modelsList");
    const reads = Array.from({ length: 4 }, (_, index) => f.handle.modelsList(index % 2
      ? { cursor: null, limit: 20 } : { limit: 20, cursor: null }));
    await tick();
    assert.equal(f.calls.length, 1, "one native startup/catalog probe for identical in-flight reads");
    gate.resolve();
    const results = await Promise.all(reads);
    results[0].data[0].model = "consumer edit";
    assert.equal(results[1].data[0].model, "fixture");
    await f.handle.modelsList({ cursor: null, limit: 20 });
    assert.equal(f.calls.length, 2, "completed results grant no later read a cached authority");
  });

  test(`${runtime}: concurrent auth probes share only their exact method and parameters`, async () => {
    const f = facadeFixture(runtime), gate = f.block("authenticationState"), accountGate = f.block("accountRead");
    const reads = [f.handle.authenticationState({ allowDeferred: true }), f.handle.authenticationState({ allowDeferred: true }),
      f.handle.authenticationState({ allowDeferred: false }), f.handle.accountRead({ refreshToken: false }),
      f.handle.accountRead({ refreshToken: false })];
    await tick();
    assert.deepEqual(f.calls.map(([method]) => method), ["authenticationState", "authenticationState", "accountRead"]);
    gate.resolve(); accountGate.resolve();
    await Promise.all(reads);
  });
}

test("preparation reads never merge different hosts, parameters, refresh requests or independently canceled callers", async () => {
  const first = facadeFixture(), second = facadeFixture();
  const a = first.block("modelsList"), b = second.block("modelsList");
  const controller = new AbortController();
  const reads = [first.handle.modelsList({ cursor: "one" }), first.handle.modelsList({ cursor: "two" }),
    second.handle.modelsList({ cursor: "one" }), first.handle.modelsList({ cursor: "one", signal: controller.signal }),
    first.handle.modelsList({ cursor: "one", signal: new AbortController().signal }),
    first.handle.accountRead({ refreshToken: true }), first.handle.accountRead({ refreshToken: true })];
  await tick();
  assert.equal(first.calls.filter(([method]) => method === "modelsList").length, 4);
  assert.equal(second.calls.length, 1);
  assert.equal(first.calls.filter(([method]) => method === "accountRead").length, 2);
  a.resolve(); b.resolve(); await Promise.all(reads);
});

test("failed probes release their in-flight entry and a replacement read really probes again", async () => {
  const f = facadeFixture(), gate = f.block("modelsList");
  const reads = [outcome(f.handle.modelsList({})), outcome(f.handle.modelsList({}))];
  await tick();
  gate.reject(Object.assign(new Error("fixture unavailable"), { code: "FIXTURE_UNAVAILABLE" }));
  assert.ok((await Promise.all(reads)).every(result => result.error?.code === "FIXTURE_UNAVAILABLE"));
  const next = f.block("modelsList"), reading = f.handle.modelsList({});
  await tick(); assert.equal(f.calls.length, 2);
  next.resolve(); await reading;
});

test("account changes invalidate in-flight preparation without letting its cleanup evict a new read", async () => {
  const f = facadeFixture(), old = f.block("modelsList");
  const previous = outcome(f.handle.modelsList({}));
  await tick(); await f.handle.accountLogout({});
  const current = f.block("modelsList"), next = f.handle.modelsList({});
  await tick();
  old.resolve(); assert.equal((await previous).error?.code, "RUNTIME_MODEL_CATALOG_CHANGED");
  const joined = f.handle.modelsList({});
  await tick(); assert.equal(f.calls.length, 2);
  current.resolve(); await Promise.all([next, joined]);
});

test("an identity change or terminated Host rejects a shared result; writes always execute separately", async () => {
  const changed = facadeFixture(), gate = changed.block("modelsList");
  const reads = [outcome(changed.handle.modelsList({})), outcome(changed.handle.modelsList({}))];
  await tick(); changed.changeIdentity(); gate.resolve();
  assert.ok((await Promise.all(reads)).every(result => result.error?.code === "RUNTIME_EXECUTABLE_CHANGED"));
  const stopped = facadeFixture(), stopGate = stopped.block("authenticationState");
  const pending = outcome(stopped.handle.authenticationState({}));
  await tick(); stopped.terminated.resolve(); await tick(); stopGate.resolve();
  assert.equal((await pending).error?.code, "RUNTIME_HANDLE_TERMINATED");
  const writing = facadeFixture();
  await Promise.all([writing.handle.turnStart({ sessionId: "s", operationId: "same" }),
    writing.handle.turnStart({ sessionId: "s", operationId: "same" })]);
  assert.equal(writing.calls.length, 2, "execution idempotency remains owned by the Runtime and Coordinator");
});

test("the in-flight key bound keeps existing reads joinable and independent overflow reads fenced", async () => {
  const f = facadeFixture(), gate = f.block("modelsList");
  const reads = Array.from({ length: 32 }, (_, index) => outcome(f.handle.modelsList({ cursor: String(index) })));
  await tick();
  reads.push(outcome(f.handle.modelsList({ cursor: "overflow" })), outcome(f.handle.modelsList({ cursor: "overflow" })),
    outcome(f.handle.modelsList({ cursor: "0" })));
  await tick(); assert.equal(f.calls.length, 34);
  f.changeIdentity(); gate.resolve();
  assert.ok((await Promise.all(reads)).every(result => result.error?.code === "RUNTIME_EXECUTABLE_CHANGED"));
});

test("invalid Provider input cannot invalidate another caller's pending model read", async () => {
  const f = facadeFixture(), gate = f.block("modelsList"), reading = f.handle.modelsList({});
  await tick();
  await assert.rejects(f.handle.providerLoginApiKey({ invalid: () => {} }), { code: "RUNTIME_PROTOCOL_INVALID" });
  gate.resolve(); assert.equal((await reading).data[0].model, "fixture");
});

function piFixture() {
  const state = deferred(), levels = deferred(), defaults = deferred(), calls = [];
  const active = { remoteSessionId: "native-session", sessionId: "product-session", thinkingLevel: null,
    model: "fixture", prompt: "request", settled: false };
  active.process = { request: async (method, input) => {
    calls.push([method, input]);
    if (method === "get_state") return state.promise;
    if (method === "get_available_thinking_levels") return levels.promise;
    return {};
  } };
  const host = Object.assign(Object.create(PiRuntimeHost.prototype), { acceptanceTimeoutMs: 1000, killGraceMs: 10,
    _recordSessionFile() {}, _acceptActive() { calls.push(["accepted"]); },
    _spawnControlRpc: () => { calls.push(["default probe"]); return { request: () => defaults.promise,
      endInput() { calls.push(["default closed"]); }, closedPromise: Promise.resolve(), closed: true }; } });
  return { host, active, state, levels, defaults, calls,
    ready() { state.resolve({ sessionId: active.remoteSessionId, messageCount: 0 });
      levels.resolve({ levels: ["medium"] }); defaults.resolve({ thinkingLevel: "medium" }); } };
}

test("Pi reads session state, available effort and inherited effort concurrently before applying or sending", async () => {
  const f = piFixture(), starting = f.host._beginTurn(f.active);
  try {
    await tick();
    assert.deepEqual(f.calls.map(([method]) => method), ["get_state", "get_available_thinking_levels", "default probe"]);
    f.levels.resolve({ levels: ["medium"] }); f.defaults.resolve({ thinkingLevel: "medium" });
    await tick();
    assert.equal(f.calls.some(([method]) => ["set_thinking_level", "prompt"].includes(method)), false);
    f.state.resolve({ sessionId: f.active.remoteSessionId, messageCount: 0 }); await starting;
    assert.deepEqual(f.calls.filter(([method]) => ["set_thinking_level", "prompt", "accepted"].includes(method))
      .map(([method]) => method), ["set_thinking_level", "prompt", "accepted"]);
  } finally { f.ready(); await starting.catch(() => {}); }
});

test("Pi joins failed preparation reads before cleanup and never changes settings or dispatches", async () => {
  const f = piFixture(); let settled = false;
  const starting = outcome(f.host._beginTurn(f.active)).then(result => { settled = true; return result; });
  try {
    await tick(); f.state.reject(Object.assign(new Error("state failed"), { code: "FIXTURE_STATE_FAILED" }));
    await tick(); assert.equal(settled, false);
    f.levels.resolve({ levels: ["medium"] }); f.defaults.resolve({ thinkingLevel: "medium" });
    assert.equal((await starting).error?.code, "FIXTURE_STATE_FAILED");
    assert.equal(f.calls.some(([method]) => ["set_thinking_level", "prompt"].includes(method)), false);
    assert.ok(f.calls.some(([method]) => method === "default closed"));
  } finally { f.ready(); await starting; }
});

test("Pi cancellation while preparation reads are pending never applies settings or dispatches", async () => {
  const f = piFixture(), starting = f.host._beginTurn(f.active);
  await tick(); f.active.settled = true; f.ready(); await starting;
  assert.equal(f.calls.some(([method]) => ["set_thinking_level", "prompt", "accepted"].includes(method)), false);
  assert.ok(f.calls.some(([method]) => method === "default closed"));
});

for (const observedMode of ["target", "reset"]) test(`Antigravity uses the latest model-change receipt when mode becomes ${observedMode}`, async () => {
  const calls = [];
  const host = Object.assign(Object.create(AntigravityAcpRuntimeHost.prototype), { sessionConfigs: new Map([
    ["s", { currentModel: "old", currentMode: observedMode === "target" ? "old-mode" : "target" }]]),
    profileState: {}, rpc: { request: async (_method, input) => {
      calls.push(input.configId);
      return { configOptions: [{ id: "model", currentValue: "new" },
        { id: "mode", currentValue: input.configId === "mode" ? "target" : observedMode }] };
    } } });
  await host._applyConfig("s", { model: "new", mode: "target" });
  assert.deepEqual(calls, observedMode === "target" ? ["model"] : ["model", "mode"]);
  assert.equal(host.sessionConfigs.get("s").currentMode, "target");
});

for (const scenario of ["ready", "model-rejected", "stopped"]) test(`OpenCode parallel resume preparation: ${scenario}`, { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync("/tmp/opencode-startup-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = "native-opencode-default-v1", policy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
  const host = new OpenCodeRuntimeHost({ paths: { stateDir: path.join(root, "state"), trustedRoot: root },
    runtimeBinding: { runtime: "opencode", runtimeProfileId: "fixture", runtimeAccountId: account },
    runtimeEnvironment: Object.freeze({ runtime: "opencode", runtimeAccountId: account, home: root,
      binaryPath: "/bin/true", configurationMode: "native", configSourceHome: root,
      launchArgs: Object.freeze([]), spawnEnv: Object.freeze({ HOME: root, XDG_DATA_HOME: root }) }),
    workspace: root, permissionPolicy: policy });
  const session = { id: "ses_12345678", cwd: root, turns: [], archived: false, source: "fixture" };
  const state = { sessions: [session] }, provider = deferred(), native = deferred(), calls = [];
  host.state = "ready";
  host.ledger = { snapshot: () => structuredClone(state), update: change => change(state) };
  host.client = { request: async (method, route) => {
    calls.push([method, route]);
    if (route === "/provider") return provider.promise;
    if (route === `/session/${session.id}`) return native.promise;
    assert.fail(`Unexpected request ${method} ${route}`);
  } };
  let settled = false;
  const starting = outcome(host.sessionResume({ sessionId: session.id, cwd: root,
    permissionPolicy: policy, model: "fixture/model" })).then(result => { settled = true; return result; });
  try {
    await tick();
    assert.deepEqual(calls, [["GET", "/provider"], ["GET", `/session/${session.id}`]]);
    if (scenario === "model-rejected") {
      provider.resolve({ data: { all: [], connected: [] } }); await tick();
      assert.equal(settled, false, "a failed provider read must still join the native session read");
    }
    if (scenario === "stopped") host.state = "stopped";
    native.resolve({ data: { id: session.id, directory: root, permission: nativePermissionRules(policy) } });
    await tick(); assert.equal(host.sessionConfigs.size, 0);
    provider.resolve({ data: { all: [{ id: "fixture", models: { model: {} } }], connected: ["fixture"] } });
    const result = await starting;
    if (scenario === "ready") assert.equal(result.value.session.id, session.id);
    else assert.equal(result.error?.code, scenario === "model-rejected" ? "RUNTIME_MODEL_UNAVAILABLE" : "RUNTIME_HOST_TERMINATED");
    assert.equal(calls.length, 2, "no repeated identity request, configuration write or prompt dispatch");
  } finally {
    provider.resolve({ data: { all: [], connected: [] } }); native.resolve({ data: {} }); await starting;
  }
});
