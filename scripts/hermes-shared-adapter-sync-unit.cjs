#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { HERMES_SHARED_PLUGIN, syncHermesSharedAdapter } = require("../app/core/hermes-shared-adapter-sync");
const { MCP_PRODUCT_TOOL_DEFINITIONS } = require("../app/agent-service/mcp-product-tool-controller");
const { HermesBackend } = require("../app/core/hermes-backend");

const expectedTools = ["group_member_role_read", "group_messages_read", "group_task", "group_collaborate",
  "shoggoth_capability_search", "shoggoth_skill_read", "shoggoth_skill_file_read",
  ...MCP_PRODUCT_TOOL_DEFINITIONS.filter(tool => tool.name.startsWith("mcp_server_")).map(tool => tool.name)];
const oldTools = [...expectedTools.filter(name => !name.startsWith("mcp_server_")),
  "connector_list", "connector_tools", "connector_call", "connector_connect", "connector_disconnect"];
const tests = [];
const test = (name, run) => tests.push({ name, run });

function fixture(options = {}) {
  const f = { calls: [], tools: [...(options.tools || oldTools)], sessions: [], current: true,
    enabled: true, home: "/fixture/.hermes/profiles/coder", ...options };
  f.input = {
    home: f.home, expectedTools, isCurrent: () => f.current,
    rpc: async (method, params) => {
      f.calls.push([method, params]);
      if (f.rpcOverride) return f.rpcOverride(method, params);
      if (method === "tools.list") return { toolsets: [{ name: HERMES_SHARED_PLUGIN,
        enabled: f.enabled, tools: [...f.tools], tool_count: f.tools.length }] };
      if (method === "session.active_list") return { sessions: structuredClone(f.sessions) };
      throw new Error(`Unexpected RPC ${method}`);
    },
    activate: async params => {
      f.calls.push(["activate", params]);
      if (f.activateOverride) return f.activateOverride(params);
      f.tools = [...expectedTools];
      return { ok: true, activation: { name: HERMES_SHARED_PLUGIN, key: HERMES_SHARED_PLUGIN,
        activated_now: { hooks: ["agent_loop_stopped"] }, deferred: { tools: [...expectedTools] },
        live_now: { mcp_servers: [], skills: [] } } };
    },
  };
  return f;
}

test("old 12-tool registry refreshes to the current 17-tool contract without replaying a turn", async () => {
  assert.equal(oldTools.length, 12);
  assert.equal(expectedTools.length, 17);
  assert(expectedTools.includes("mcp_server_add"));
  assert(expectedTools.includes("mcp_server_import"));
  const f = fixture();
  const got = await syncHermesSharedAdapter(f.input);
  assert.deepEqual(got, { state: "ready", ready: true, reason: null, updated: true, requiresNewSession: false });
  assert.deepEqual(f.calls.map(([method]) => method), ["tools.list", "session.active_list", "activate", "tools.list"]);
  assert.deepEqual(f.calls[2][1], { name: HERMES_SHARED_PLUGIN, home: f.home });
  assert.ok(Object.isFrozen(f.calls[2][1]));
});

test("current registry avoids a reload even when a conversation is active", async () => {
  const f = fixture({ tools: expectedTools, sessions: [{ id: "running", status: "working" }] });
  const got = await syncHermesSharedAdapter(f.input);
  assert.equal(got.ready, true);
  assert.equal(got.updated, false);
  assert.equal(got.requiresNewSession, false);
  assert.deepEqual(f.calls.map(([method]) => method), ["tools.list"]);
});

for (const status of ["working", "waiting", "starting"]) test(`${status} session defers activation`, async () => {
  const f = fixture({ sessions: [{ id: "one", status }] });
  const got = await syncHermesSharedAdapter(f.input);
  assert.equal(got.state, "deferred");
  assert.equal(got.ready, false);
  assert.equal(got.reason, "HERMES_ADAPTER_HOST_BUSY");
  assert.equal(f.calls.some(([method]) => method === "activate"), false);
});

test("idle existing sessions permit registry refresh but require a new Python tool snapshot", async () => {
  const f = fixture({ sessions: [{ id: "old-chat", status: "idle" }] });
  const got = await syncHermesSharedAdapter(f.input);
  assert.equal(got.ready, true);
  assert.equal(got.requiresNewSession, true);
  assert.equal(f.calls.some(([method]) => method === "reload.mcp"), false);
});

for (const sessions of [[{ id: "one", status: "unknown" }], [{ id: "one" }],
  [{ id: "one", status: "idle" }, { id: "one", status: "idle" }], null]) {
  test(`invalid session observation is not an idle host: ${JSON.stringify(sessions)}`, async () => {
    const f = fixture();
    f.rpcOverride = method => method === "session.active_list" ? { sessions }
      : { toolsets: [{ name: HERMES_SHARED_PLUGIN, enabled: true, tools: oldTools, tool_count: 12 }] };
    const got = await syncHermesSharedAdapter(f.input);
    assert.equal(got.reason, "HERMES_ADAPTER_SESSIONS_INVALID");
    assert.equal(f.calls.some(([method]) => method === "activate"), false);
  });
}

test("incomplete active-session response is never treated as idle", async () => {
  const f = fixture();
  f.rpcOverride = method => method === "session.active_list" ? { sessions: [], complete: false }
    : { toolsets: [{ name: HERMES_SHARED_PLUGIN, enabled: true, tools: oldTools, tool_count: 12 }] };
  assert.equal((await syncHermesSharedAdapter(f.input)).ready, false);
  assert.equal(f.calls.some(([method]) => method === "activate"), false);
});

test("an explicitly disabled toolset is respected", async () => {
  const f = fixture({ enabled: false });
  const got = await syncHermesSharedAdapter(f.input);
  assert.equal(got.reason, "HERMES_ADAPTER_TOOLSET_DISABLED");
  assert.deepEqual(f.calls.map(([method]) => method), ["tools.list"]);
});

for (const activation of [null, { name: "other", key: "other", deferred: { tools: expectedTools } },
  { name: HERMES_SHARED_PLUGIN, key: HERMES_SHARED_PLUGIN, deferred: { tools: oldTools } },
  { name: HERMES_SHARED_PLUGIN, key: "other", deferred: { tools: expectedTools } },
  { name: HERMES_SHARED_PLUGIN, key: HERMES_SHARED_PLUGIN, deferred: { tools: [...expectedTools, expectedTools[0]] } }]) {
  test(`invalid activation is never success: ${activation?.key || "null"}/${activation?.deferred?.tools?.length || 0}`, async () => {
    const f = fixture({ activateOverride: () => ({ ok: true, activation }) });
    const got = await syncHermesSharedAdapter(f.input);
    assert.equal(got.reason, "HERMES_ADAPTER_ACTIVATION_INVALID");
    assert.equal(got.ready, false);
    assert.equal(f.calls.filter(([method]) => method === "tools.list").length, 1);
  });
}

test("an activation promise does not substitute for the live tools.list receipt", async () => {
  const f = fixture({ activateOverride: () => ({ ok: true, activation: {
    name: HERMES_SHARED_PLUGIN, key: HERMES_SHARED_PLUGIN, deferred: { tools: expectedTools } } }) });
  assert.equal((await syncHermesSharedAdapter(f.input)).reason, "HERMES_ADAPTER_VERIFICATION_FAILED");
});

test("extra stale connector tools do not match the current family", async () => {
  const f = fixture({ tools: [...expectedTools, "connector_call"] });
  assert.equal((await syncHermesSharedAdapter(f.input)).updated, true);
});

test("adapter generation changes can force a refresh even with identical tool names", async () => {
  const f = fixture({ tools: expectedTools });
  assert.equal((await syncHermesSharedAdapter({ ...f.input, forceRefresh: true })).updated, true);
});

test("forced refresh still respects a busy host", async () => {
  const f = fixture({ tools: expectedTools, sessions: [{ id: "run", status: "working" }] });
  assert.equal((await syncHermesSharedAdapter({ ...f.input, forceRefresh: true })).state, "deferred");
  assert.equal(f.calls.some(([method]) => method === "activate"), false);
});

test("known Shoggoth work defers before probing a host for activation", async () => {
  const f = fixture();
  const got = await syncHermesSharedAdapter({ ...f.input, isBusy: () => true });
  assert.equal(got.state, "deferred");
  assert.deepEqual(f.calls.map(([method]) => method), ["tools.list"]);
});

test("Shoggoth work starting during the active-session probe prevents activation", async () => {
  const f = fixture();
  let busy = false;
  const rpc = f.input.rpc;
  f.input.rpc = async (...args) => {
    const value = await rpc(...args);
    if (args[0] === "session.active_list") busy = true;
    return value;
  };
  const got = await syncHermesSharedAdapter({ ...f.input, isBusy: () => busy });
  assert.equal(got.state, "deferred");
  assert.equal(f.calls.some(([method]) => method === "activate"), false);
});

test("an unknown Shoggoth activity observation does not permit activation", async () => {
  const f = fixture();
  const got = await syncHermesSharedAdapter({ ...f.input, isBusy: () => undefined });
  assert.equal(got.state, "unavailable");
  assert.equal(f.calls.some(([method]) => method === "activate"), false);
});

test("profile identity changes invalidate an otherwise current observation", async () => {
  const f = fixture({ tools: expectedTools });
  const rpc = f.input.rpc;
  f.input.rpc = async (...args) => { const value = await rpc(...args); f.current = false; return value; };
  assert.equal((await syncHermesSharedAdapter(f.input)).reason, "HERMES_ADAPTER_OBSERVATION_STALE");
  assert.equal(f.calls.some(([method]) => method === "activate"), false);
});

test("profile identity changes after idle observation prevent activation", async () => {
  const f = fixture();
  const rpc = f.input.rpc;
  f.input.rpc = async (...args) => {
    const value = await rpc(...args);
    if (args[0] === "session.active_list") f.current = false;
    return value;
  };
  assert.equal((await syncHermesSharedAdapter(f.input)).reason, "HERMES_ADAPTER_OBSERVATION_STALE");
  assert.equal(f.calls.some(([method]) => method === "activate"), false);
});

test("profile identity changes during activation cannot publish ready", async () => {
  const f = fixture();
  const activate = f.input.activate;
  f.input.activate = async params => { const value = await activate(params); f.current = false; return value; };
  assert.equal((await syncHermesSharedAdapter(f.input)).reason, "HERMES_ADAPTER_OBSERVATION_STALE");
});

for (const failingStage of ["observation", "activation", "verification"]) test(`${failingStage} failures are bounded and do not leak host errors`, async () => {
  const f = fixture();
  const rpc = f.input.rpc;
  const activate = f.input.activate;
  let activated = false;
  f.input.rpc = (...args) => {
    if (failingStage === "observation" || failingStage === "verification" && activated) throw new Error("fixture-secret");
    return rpc(...args);
  };
  f.input.activate = params => {
    activated = true;
    if (failingStage === "activation") throw new Error("fixture-secret");
    return activate(params);
  };
  const got = await syncHermesSharedAdapter(f.input);
  assert.equal(got.ready, false);
  assert.equal(JSON.stringify(got).includes("fixture-secret"), false);
});

test("invalid home and ambiguous expected contracts fail before any IO", async () => {
  const f = fixture();
  for (const changes of [{ home: "relative" }, { home: "/fixture/../other" },
    { expectedTools: [...expectedTools, expectedTools[0]] }, { expectedTools: [] }]) {
    await assert.rejects(syncHermesSharedAdapter({ ...f.input, ...changes }), TypeError);
  }
  assert.equal(f.calls.length, 0);
});

test("malformed or duplicate plugin toolsets do not trigger a blind reload", async () => {
  for (const toolsets of [null, [null], [{ name: HERMES_SHARED_PLUGIN, tools: expectedTools, enabled: true, tool_count: expectedTools.length - 1 }],
    [1, 2].map(() => ({ name: HERMES_SHARED_PLUGIN, tools: expectedTools, enabled: true, tool_count: expectedTools.length }))]) {
    const f = fixture({ rpcOverride: () => ({ toolsets }) });
    assert.equal((await syncHermesSharedAdapter(f.input)).reason, "HERMES_ADAPTER_TOOLS_INVALID");
    assert.equal(f.calls.some(([method]) => method === "activate"), false);
  }
});

async function backendFixture(run) {
  const f = { requests: [], tools: [...oldTools], sessions: [], holdSessions: null };
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const bytes of req) text += bytes;
    const body = JSON.parse(text || "{}");
    f.requests.push(["activate", body]);
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/dashboard/agent-plugins/activate");
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    if (f.holdActivation) await f.holdActivation();
    f.tools = [...expectedTools];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, activation: { name: HERMES_SHARED_PLUGIN,
      key: HERMES_SHARED_PLUGIN, deferred: { tools: [...expectedTools] } } }));
  });
  const wss = new WebSocketServer({ server, path: "/api/ws" });
  wss.on("error", () => {}); // The listen promise below reports socket policy failures.
  wss.on("connection", ws => ws.on("message", async bytes => {
    const frame = JSON.parse(bytes.toString());
    f.requests.push([frame.method, frame.params]);
    let response;
    if (frame.method === "tools.list") response = { toolsets: [{ name: HERMES_SHARED_PLUGIN,
      enabled: true, tools: [...f.tools], tool_count: f.tools.length }] };
    else if (frame.method === "session.active_list") {
      if (f.holdSessions) await f.holdSessions();
      response = { sessions: structuredClone(f.sessions) };
    } else throw new Error(`Unexpected fixture RPC ${frame.method}`);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: response }));
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  f.backend = new HermesBackend();
  f.backend._hermesHomeForProfile = () => "/fixture/.hermes/profiles/coder";
  f.backend.dashboards.set("coder", { baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: "fixture-token", spawned: false });
  f.options = { profile: "coder", expectedTools, forceRefresh: true };
  try { await run(f); }
  finally {
    await f.backend.stop();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
}

test("HermesBackend concurrent reconciliation shares one actual Host activation", async () => {
  await backendFixture(async f => {
    const [one, two] = await Promise.all([
      f.backend.reconcileSharedCapabilityAdapter(f.options),
      f.backend.reconcileSharedCapabilityAdapter(f.options),
    ]);
    assert.equal(one.ready, true);
    assert.deepEqual(two, one);
    assert.deepEqual(f.requests.map(([method]) => method), ["tools.list", "session.active_list", "activate", "tools.list"]);
    assert.deepEqual(f.requests[2][1], { name: HERMES_SHARED_PLUGIN, home: "/fixture/.hermes/profiles/coder" });
  });
});

test("HermesBackend stop fences an in-flight idle observation before it can activate", async () => {
  await backendFixture(async f => {
    let release;
    let entered;
    const hold = new Promise(resolve => { release = resolve; });
    const observed = new Promise(resolve => { entered = resolve; });
    f.holdSessions = async () => { entered(); await hold; };
    const pending = f.backend.reconcileSharedCapabilityAdapter(f.options);
    const rejected = assert.rejects(pending, /Host changed|retired|变化/u);
    await observed;
    await f.backend.stop();
    release();
    await rejected;
    assert.equal(f.requests.some(([method]) => method === "activate"), false);
    assert.equal(f.backend._sharedAdapterPending.size, 0);
    assert.equal(f.backend._sharedAdapterRetryTimer, null);
  });
});

test("HermesBackend busy retry is pending and stop removes its retry timer", async () => {
  await backendFixture(async f => {
    f.sessions = [{ id: "actual-host-task", status: "working" }];
    assert.equal((await f.backend.reconcileSharedCapabilityAdapter(f.options)).state, "deferred");
    assert.equal(f.requests.some(([method]) => method === "activate"), false);
    assert.equal(f.backend._sharedAdapterPending.size, 1);
    assert.notEqual(f.backend._sharedAdapterRetryTimer, null);
    await f.backend.stop();
    assert.equal(f.backend._sharedAdapterPending.size, 0);
    assert.equal(f.backend._sharedAdapterRetryTimer, null);
  });
});

test("HermesBackend verifies same-name tools once per adapter revision and live dashboard", async () => {
  await backendFixture(async f => {
    f.tools = [...expectedTools];
    const options = { ...f.options, forceRefresh: false, adapterRevision: "fixture-revision-one" };
    const first = await f.backend.reconcileSharedCapabilityAdapter(options);
    assert.equal(first.ready, true);
    assert.equal(first.updated, true);
    assert.equal(f.requests.filter(([method]) => method === "activate").length, 1);
    const repeat = await f.backend.reconcileSharedCapabilityAdapter(options);
    assert.equal(repeat.ready, true);
    assert.equal(repeat.updated, false);
    assert.equal(f.requests.filter(([method]) => method === "activate").length, 1);
    const revised = await f.backend.reconcileSharedCapabilityAdapter({ ...options, adapterRevision: "fixture-revision-two" });
    assert.equal(revised.ready, true);
    assert.equal(revised.updated, true);
    assert.equal(f.requests.filter(([method]) => method === "activate").length, 2);
    const prior = f.backend.dashboards.get("coder");
    f.backend.dashboards.set("coder", { ...prior });
    assert.equal((await f.backend.reconcileSharedCapabilityAdapter({ ...options,
      adapterRevision: "fixture-revision-two" })).updated, true);
    assert.equal(f.requests.filter(([method]) => method === "activate").length, 3);
  });
});

test("HermesBackend admission waits for active refresh and queued sends defer the next refresh", async () => {
  await backendFixture(async f => {
    let entered;
    let release;
    const admitted = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    f.holdActivation = async () => { entered(); await hold; };
    const active = f.backend.reconcileSharedCapabilityAdapter(f.options);
    await admitted;
    let completed = false;
    const waiting = f.backend._waitForSharedCapabilityAdapter("coder").then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    release();
    assert.equal((await active).ready, true);
    await waiting;
    assert.equal(completed, true);
    f.holdActivation = null;
    const callsBefore = f.requests.filter(([method]) => method === "activate").length;
    f.backend.sendQueues.set("fixture-pending-send", Promise.resolve());
    const deferred = await f.backend.reconcileSharedCapabilityAdapter(f.options);
    assert.equal(deferred.state, "deferred");
    assert.equal(f.requests.filter(([method]) => method === "activate").length, callsBefore);
    assert.equal(f.backend._sharedAdapterPending.size, 1);
    f.backend.sendQueues.delete("fixture-pending-send");
    assert.equal((await f.backend.reconcileSharedCapabilityAdapter(f.options)).ready, true);
    assert.equal(f.requests.filter(([method]) => method === "activate").length, callsBefore + 1);
  });
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
  }
  console.log(`Hermes shared adapter sync: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exitCode = 1;
})();
