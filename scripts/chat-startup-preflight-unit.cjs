"use strict";

// Real private Host IPC with fake native directories; no App, Service, account
// or model is started. Each request still verifies the current native owner.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { BackendRegistry } = require("../app/core/backend-registry");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { HermesBackend } = require("../app/core/hermes-backend");
const { createFederationHostServer } = require("../app/federation-host-server");
const { FederationHostClient } = require("../app/agent-service/federation-host-client");
const { resolveServicePaths } = require("../app/agent-service/paths");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, backendId) {
  const root = fs.mkdtempSync("/tmp/chat-preflight-");
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const registry = new BackendRegistry(), calls = [];
  let disabled = [];
  registry.setDisabledBackendsProvider(() => disabled);
  const agentId = backendId === "hermes" ? "hermes-fixture" : "alice";
  const sessionKey = `agent:${agentId}:stored-1`;
  const backend = backendId === "hermes"
    ? new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) })
    : new OpenClawBackend();
  let directoryCurrent = true;
  const entered = deferred();
  let gate = null;
  const read = async method => {
    calls.push([backendId, method]);
    entered.resolve();
    if (gate) await gate.promise;
    if (method === "agents.list") return { agents: [{ id: agentId, enabled: directoryCurrent }] };
    if (method === "sessions.list") return { sessions: [{ key: sessionKey, sessionId: "stored-1", archived: !directoryCurrent }] };
    assert.equal(method, "session.active_list");
    return { sessions: directoryCurrent ? [{ id: "runtime-1", session_key: "stored-1" }] : [] };
  };
  if (backendId === "hermes") {
    backend.agents = [{ id: agentId, enabled: true }];
    backend.profileById.set(agentId, "default");
    backend.gwRuntimeByKey.set(sessionKey, { profile: "default", runtimeId: "runtime-1", storedId: "stored-1", generation: 1 });
    backend.gwSockets.set("default", { generation: 1, request: read });
  } else {
    Object.assign(backend, { _ready: true, _ws: {}, _connect: async () => {}, request: read });
  }
  backend.getStatus = async () => { calls.push([backendId, "getStatus"]); return { id: backendId, connected: true }; };
  backend.getAgent = async () => { calls.push([backendId, "getAgent"]); return { id: agentId, name: "Fixture" }; };
  registry.register(backend);
  registry.register({ id: "unrelated", name: "Unrelated", getStatus: async () => {
    calls.push(["unrelated", "getStatus"]);
    return { id: "unrelated", connected: false };
  } });
  const host = createFederationHostServer({ paths, registry });
  t.after(async () => { gate?.resolve(); await host.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await host.start();
  const client = new FederationHostClient({ paths, timeoutMs: 2_000 });
  const request = (overrides = {}) => client.request("model.projection.owner", {
    backendId, agentId, sessionId: sessionKey, ...overrides,
  });
  return { registry, backend, calls, request, sessionKey, entered,
    disable: () => { disabled = [backendId]; },
    revoke: () => { directoryCurrent = false; },
    block: () => { gate = deferred(); return gate; } };
}

for (const backendId of ["openclaw", "hermes"]) {
  test(`${backendId}: input preparation reads only the target native owner, on every round`, { timeout: 5_000 }, async t => {
    const f = await fixture(t, backendId);
    for (let round = 0; round < 2; round++) {
      const result = await f.request();
      assert.equal(result.owner.sessionKey, f.sessionKey);
      assert.equal(result.owner.backendId, backendId);
    }
    const expected = backendId === "hermes" ? ["session.active_list"] : ["agents.list", "sessions.list"];
    assert.deepEqual(f.calls, [...expected, ...expected].map(method => [backendId, method]),
      "overview health, cron, model metadata and Agent files cannot delay a chat owner check");
    f.revoke();
    await assert.rejects(f.request(), { code: "AGENT_OPERATION_FAILED" },
      "a previous success must not cache authority for a revoked native session");
  });

  test(`${backendId}: disabled, missing and foreign owners never reach a native send`, { timeout: 5_000 }, async t => {
    const f = await fixture(t, backendId);
    await assert.rejects(f.request({ agentId: "foreign" }), { code: "AGENT_OPERATION_FAILED" });
    f.calls.length = 0;
    f.disable();
    await assert.rejects(f.request(), { code: "BACKEND_UNAVAILABLE" });
    assert.deepEqual(f.calls, [], "disabled backends must not be probed or reconnected");
  });

  for (const change of ["disable", "replace"]) test(`${backendId}: ${change} during owner lookup invalidates its result`, { timeout: 5_000 }, async t => {
    const f = await fixture(t, backendId), gate = f.block();
    const response = f.request();
    await f.entered.promise;
    if (change === "disable") f.disable();
    else f.registry.backends.set(backendId, { id: backendId });
    gate.resolve();
    await assert.rejects(response, { code: "BACKEND_UNAVAILABLE" });
  });
}
