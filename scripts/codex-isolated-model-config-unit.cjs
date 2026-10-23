"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { CodexSchemaContract } = require("../app/agent-service/codex-schema-contract");

async function fixture({ transports = { shoggoth: { command: "fixture" }, configured: { url: "https://fixture.invalid" } },
  inventory = ["shoggoth", "configured", "code-review", "codex_app", "cua_repl", "codex_apps"],
  configResponse, configError, threadInventory = [] } = {}) {
  const starts = [], unloaded = [], reads = [];
  const host = {
    async configRead(params) {
      reads.push(params); if (configError) throw configError;
      return configResponse ?? { config: { mcp_servers: transports }, origins: {} };
    },
    async experimentalFeatureList({ threadId }) {
      return { data: ["shell_tool", "unified_exec", "plugins", "apps"].map(name => ({ name, enabled: !threadId })), nextCursor: null };
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

test("proactive review retains only its structured response tool in configured Shoggoth MCP", async () => {
  const f = await fixture();
  const config = await f.handle._proactiveReviewConfig();
  assert.deepEqual(config["mcp_servers.shoggoth.enabled_tools"], ["proactive_respond"]);
  assert.equal(Object.hasOwn(config, "mcp_servers.shoggoth.enabled"), false);
  assert.equal(config["mcp_servers.configured.enabled"], false);
  assert.equal(Object.hasOwn(config, "mcp_servers.code-review.enabled"), false);
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

test("isolated generation releases only its owned ephemeral thread and confirms the native acknowledgement", async () => {
  const f = await fixture();
  await assert.rejects(f.handle.sessionStart({ isolatedGeneration: true, persistent: true }), { code: "MODEL_ONLY_SESSION_INVALID" });
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
