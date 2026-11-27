"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { CodexSchemaContract } = require("../app/agent-service/codex-schema-contract");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

async function fixture({ transports = { shoggoth: { command: "fixture" }, configured: { url: "https://fixture.invalid" } },
  inventory = ["shoggoth", "configured", "code-review", "codex_app", "cua_repl", "codex_apps"],
  configResponse, configError, threadInventory = [], extraThreadFeatures = [], runtimeVersion } = {}) {
  const starts = [], unloaded = [], reads = [];
  const host = {
    runtimeVersion,
    async configRead(params) {
      reads.push(params); if (configError) throw configError;
      return configResponse ?? { config: { mcp_servers: transports }, origins: {} };
    },
    async experimentalFeatureList({ threadId }) {
      const data = ["shell_tool", "unified_exec", "plugins", "apps"].map(name => ({ name, enabled: !threadId }));
      if (threadId) data.push(...extraThreadFeatures);
      return { data, nextCursor: null };
    },
    async mcpServerStatusList({ threadId }) {
      return { data: (threadId ? threadInventory : inventory).map(name => ({ name,
        runtimeStatus: threadId ? "ready" : "disabled", tools: threadId ? { unexpected: { name: "unexpected" } } : {} })), nextCursor: null };
    },
    async threadStart(params) {
      starts.push(params);
      return { thread: { id: "isolated-thread" }, model: "fixture-model", modelProvider: "fixture",
        sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: "never" };
    },
    async threadUnsubscribe({ threadId }) { unloaded.push(threadId); return { status: "unsubscribed" }; },
    async turnStart() { assert.fail("model discovery must not dispatch a model turn"); },
  };
  const handle = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host } })
    .acquire({ runtime: "codex", runtimeProfileId: "fixture", runtimeAccountId: "fixture" });
  return { handle, host, starts, unloaded, reads };
}

test("pinned config/read schema accepts MCP configuration and rejects malformed control responses", () => {
  const schema = new CodexSchemaContract();
  assert.equal(schema.operations.configRead.method, "config/read");
  schema.validateParams("configRead", { includeLayers: false });
  schema.validateResponse("configRead", { config: { mcp_servers: { configured: { command: "fixture" } } }, origins: {} });
  assert.throws(() => schema.validateParams("configRead", { includeLayers: "false" }), { code: "CODEX_SCHEMA_ERROR" });
  assert.throws(() => schema.validateResponse("configRead", { config: null, origins: {} }), { code: "CODEX_SCHEMA_ERROR" });
});

test("native model discovery disables configured transports without inventing plugin or synthesized tables", async () => {
  const f = await fixture();
  assert.deepEqual(await f.handle.resolveModelOnly({ operationId: "discover" }), { model: "fixture-model", provider: "fixture" });
  assert.deepEqual(f.reads, [{ includeLayers: false }]);
  const config = f.starts[0].config;
  assert.equal(config["mcp_servers.configured.enabled"], false);
  assert.equal(config["mcp_servers.shoggoth.enabled"], false);
  assert.equal(config["features.plugins"], false);
  assert.equal(config["features.apps"], false);
  for (const name of ["code-review", "codex_app", "cua_repl", "codex_apps"]) assert.equal(Object.hasOwn(config, `mcp_servers.${name}.enabled`), false);
  assert.deepEqual(f.unloaded, ["isolated-thread"]);
});

test("configured servers absent from inventory are disabled and a real code-review transport is treated as configuration", async () => {
  const f = await fixture({ transports: { shoggoth: { command: "fixture" }, "code-review": { command: "user-fixture" }, omitted: { command: "fixture" } }, inventory: ["codex_app"] });
  await f.handle.resolveModelOnly({ operationId: "discover" });
  assert.equal(f.starts[0].config["mcp_servers.code-review.enabled"], false);
  assert.equal(f.starts[0].config["mcp_servers.omitted.enabled"], false);
});

test("a synthesized server remaining callable prevents model discovery and the ephemeral thread is unloaded", async () => {
  const f = await fixture({ threadInventory: ["code-review"] });
  await assert.rejects(f.handle.resolveModelOnly({ operationId: "discover" }), { code: "RUNTIME_ISOLATION_UNVERIFIED" });
  assert.deepEqual(f.unloaded, ["isolated-thread"]);
});

test("missing, malformed or unreadable transport metadata prevents any thread start", async () => {
  for (const configResponse of [{}, { config: { mcp_servers: [] } }, { config: { mcp_servers: "invalid" } }, { config: { mcp_servers: { "invalid/name": {} } } }]) {
    const f = await fixture({ configResponse });
    await assert.rejects(f.handle.resolveModelOnly({ operationId: "discover" }), { code: "RUNTIME_ISOLATION_UNVERIFIED" });
    assert.equal(f.starts.length, 0);
  }
  const unavailable = await fixture({ configError: Object.assign(new Error("unavailable"), { code: "RPC_REMOTE_ERROR" }) });
  await assert.rejects(unavailable.handle.resolveModelOnly({ operationId: "discover" }), { code: "RPC_REMOTE_ERROR" });
  assert.equal(unavailable.starts.length, 0);
  delete unavailable.host.configRead;
  await assert.rejects(unavailable.handle.resolveModelOnly({ operationId: "discover" }), { code: "RUNTIME_ISOLATION_UNVERIFIED" });
  assert.equal(unavailable.starts.length, 0);
});

test("isolated model discovery never waits on global MCP startup and still verifies its own thread", async () => {
  const f = await fixture(), original = f.host.mcpServerStatusList, checked = [];
  f.host.mcpServerStatusList = async params => {
    assert.equal(params.threadId, "isolated-thread", "unrelated global MCP startup must not be queried");
    checked.push(params.threadId); return original(params);
  };
  await f.handle.resolveModelOnly({ operationId: "discover-with-offline-global-mcp" });
  assert.deepEqual(checked, ["isolated-thread"]);
  assert.deepEqual(f.unloaded, ["isolated-thread"]);
});

test("Codex retired worktrees and realtime markers do not block isolated generation", async () => {
  for (const runtimeVersion of ["0.167.1", "0.170.0"]) {
    const f = await fixture({ runtimeVersion, extraThreadFeatures: ["worktrees", "realtime_conversation"]
      .map(name => ({ name, enabled: true, stage: "removed" })) });
    const started = await f.handle.sessionStart({ isolatedGeneration: true, persistent: false,
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
    await f.handle.releaseModelOnlySession({ sessionId: started.session.id });
    assert.deepEqual(f.unloaded, ["isolated-thread"]);
  }
});

test("an enabled active feature or an unverified removed feature still blocks generation", async () => {
  for (const [name, stage] of [["worktrees", "stable"], ["realtime_conversation", "deprecated"],
    ["unknown_tool", "removed"]]) {
    const f = await fixture({ runtimeVersion: "0.170.0", extraThreadFeatures: [{ name, stage, enabled: true }] });
    await assert.rejects(f.handle.sessionStart({ isolatedGeneration: true, persistent: false,
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } }), { code: "RUNTIME_ISOLATION_UNVERIFIED" });
    assert.deepEqual(f.unloaded, ["isolated-thread"]);
  }
});

test("a supported prior app-server can resolve the model, but cannot borrow another version's feature exception", async () => {
  const prior = await fixture({ runtimeVersion: "0.159.2" });
  assert.deepEqual(await prior.handle.resolveModelOnly({ operationId: "discover" }), { model: "fixture-model", provider: "fixture" });
  for (const runtimeVersion of ["0.159.2", "0.168.0", undefined]) {
    const f = await fixture({ runtimeVersion, extraThreadFeatures: [{ name: "worktrees", stage: "removed", enabled: true }] });
    await assert.rejects(f.handle.resolveModelOnly({ operationId: "discover" }), { code: "RUNTIME_ISOLATION_UNVERIFIED" });
    assert.deepEqual(f.unloaded, ["isolated-thread"]);
  }
});

test("Codex 0.159.2 rejects isolated generation before starting a native thread", async () => {
  const f = await fixture({ runtimeVersion: "0.159.2" });
  await assert.rejects(f.handle.sessionStart({ isolatedGeneration: true, persistent: false,
    permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } }), { code: "RUNTIME_ISOLATION_UNVERIFIED" });
  assert.equal(f.starts.length, 0);
  assert.equal(f.reads.length, 0);
  assert.equal(f.unloaded.length, 0);
  const ordinary = await f.handle.sessionStart({ persistent: true,
    permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
  assert.equal(ordinary.session.id, "isolated-thread");
  assert.equal(f.starts.length, 1);
});

test("a Binding's observed CLI version decides summary eligibility before any summary task is created", async () => {
  const binding = { runtime: "codex", runtimeProfileId: "fixture", runtimeAccountId: "fixture" };
  let version = "0.159.2";
  const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => ({ runtimeVersion: version }) } });
  assert.equal(adapter.canGenerateModelOnlyFor(binding, "conversation_compaction"), true,
    "no Host yet: the session guard still decides when the isolated thread starts");
  await adapter.acquire(binding);
  assert.equal(adapter.canGenerateModelOnlyFor(binding, "conversation_compaction"), false,
    "0.159.2 cannot isolate; native compaction takes over without a failed summary");
  assert.equal(adapter.canGenerateModelOnlyFor({ ...binding, runtimeProfileId: "other" }, "conversation_compaction"), true);
  assert.equal(adapter.canGenerateModelOnlyFor(binding, "memory_review"), false, "other purposes stay closed");
  // The registry forwards the Binding, so the coordinator's summary route sees it.
  const { RuntimeAdapterRegistry } = require("../app/agent-service/runtime-adapter-registry");
  const registry = new RuntimeAdapterRegistry({ validateHandles: false });
  registry.register("codex", adapter);
  assert.equal(registry.canGenerateModelOnly("codex", { purpose: "conversation_compaction" }), true, "without a Binding: type level only");
  assert.equal(registry.canGenerateModelOnly("codex", { purpose: "conversation_compaction", binding }), false);
  version = "0.168.0";
  await adapter.acquire(binding);
  assert.equal(adapter.canGenerateModelOnlyFor(binding, "conversation_compaction"), true, "an upgraded CLI summarizes again");
  assert.equal(registry.canGenerateModelOnly("codex", { purpose: "conversation_compaction", binding }), true);
});

test("isolated generation releases only its owned ephemeral thread and confirms the native acknowledgement", async () => {
  const f = await fixture();
  await assert.rejects(f.handle.sessionStart({ isolatedGeneration: true, persistent: true }), { code: "MODEL_ONLY_SESSION_INVALID" });
  await assert.rejects(f.handle.sessionResume({ isolatedGeneration: true, sessionId: "ordinary-thread" }),
    { code: "MODEL_ONLY_SESSION_INVALID" });
  await assert.rejects(f.handle.releaseModelOnlySession({ sessionId: "ordinary-thread" }), { code: "MODEL_ONLY_SESSION_UNAVAILABLE" });
  assert.equal(f.starts.length, 0); assert.equal(f.unloaded.length, 0);
  const started = await f.handle.sessionStart({ isolatedGeneration: true, persistent: false,
    permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
  const unsubscribe = f.host.threadUnsubscribe;
  f.host.threadUnsubscribe = async () => ({ status: "stillRunning" });
  await assert.rejects(f.handle.releaseModelOnlySession({ sessionId: started.session.id }), { code: "RUNTIME_STOP_UNCONFIRMED" });
  f.host.threadUnsubscribe = unsubscribe;
  assert.deepEqual(await f.handle.releaseModelOnlySession({ sessionId: started.session.id }), { sessionId: started.session.id, released: true });
  assert.deepEqual(f.unloaded, [started.session.id]);
  await assert.rejects(f.handle.releaseModelOnlySession({ sessionId: started.session.id }), { code: "MODEL_ONLY_SESSION_UNAVAILABLE" });
});

test("failed generation isolation also unloads the owned thread before returning the failure", async () => {
  const f = await fixture({ threadInventory: ["code-review"] });
  await assert.rejects(f.handle.sessionStart({ isolatedGeneration: true, persistent: false,
    permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } }), { code: "RUNTIME_ISOLATION_UNVERIFIED" });
  assert.deepEqual(f.unloaded, ["isolated-thread"]);
  await assert.rejects(f.handle.releaseModelOnlySession({ sessionId: "isolated-thread" }), { code: "MODEL_ONLY_SESSION_UNAVAILABLE" });
});

test("the user fallback is scoped to its provider on new and resumed threads", async () => {
  const profile = { runtime: "codex", runtimeProfileId: "fixture", runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID };
  const calls = [];
  const request = async params => {
    calls.push(params);
    return { thread: { id: "fixture-thread" }, approvalsReviewer: params.approvalsReviewer };
  };
  let retired = false;
  const host = { runtimeVersion: "0.167.1", runtimeEnvironment: { installationKind: "bundled" },
    providerCapabilities: { providerConfigId: "shoggoth_0123456789abcdef", structuredOutput: "unsupported", approvalReviewer: "user" },
    assertExecutionProviderCurrent() { if (retired) throw Object.assign(new Error("configuration retired"), { code: "EXECUTION_CONTRACT_STALE" }); },
    threadStart: request, threadResume: request,
    async turnStart(params) { calls.push(params); return { turn: { id: "fixture-turn" } }; },
  };
  const handle = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host } }).acquire(profile);
  const modelProvider = { kind: "custom-responses", configId: "shoggoth_0123456789abcdef" };
  const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
  const permissionMode = "auto-review";
  await handle.sessionStart({ modelProvider, permissionMode, permissionPolicy });
  await handle.sessionResume({ sessionId: "fixture-thread", modelProvider, permissionMode, permissionPolicy });
  await handle.turnStart({ sessionId: "fixture-thread", prompt: "fixture turn", permissionMode, permissionPolicy });
  assert.deepEqual(calls.map(params => params.approvalsReviewer), ["user", "user", "user"]);
  assert.ok(calls.slice(0, 2).every(params => params.sandbox === "workspace-write" && params.approvalPolicy === "on-request"));
  const other = { ...modelProvider, configId: "shoggoth_fedcba9876543210" };
  await handle.sessionStart({ modelProvider: other, permissionMode, permissionPolicy });
  assert.equal(calls.at(-1).approvalsReviewer, "auto_review");
  host.modelCatalog = { runtimeVersion: "0.167.1", digest: "fixture" };
  await assert.rejects(handle.sessionStart({ modelProvider: other, permissionMode, permissionPolicy }), { code: "EXECUTION_CONTRACT_STALE" });
  retired = true;
  await assert.rejects(handle.sessionResume({ sessionId: "fixture-thread", modelProvider, permissionMode, permissionPolicy }),
    { code: "EXECUTION_CONTRACT_STALE" });
  assert.equal(calls.length, 4);
});
