#!/usr/bin/env node
"use strict";
// Real static REST -> Backend -> authenticated local socket -> Product15/Chat8.
// Only runtime transports and encryption are fakes; no external backend starts.
const assert = require("node:assert/strict");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");

async function run() {
  const f = await openHandoffFixture();
  let server;
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({
      ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeMultiBinding: true },
    });
    const backend = new ShoggothBackend({ paths: f.paths });
    backend._state = "started";
    await backend._refreshManagedProfiles();
    const registry = new BackendRegistry();
    registry.register(backend);
    server = await startStaticServer(0, {
      registry, homeDir: f.root, userDataRoot: path.join(f.root, "ui"),
    });
    const base = `/__api/agents/${encodeURIComponent(f.profile.agentId)}`;
    const request = async (method, route, body) => {
      const response = await fetch(`${server.url}${base}${route}`, {
        method, headers: { "Content-Type": "application/json", Origin: server.url },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };

    const route = "/runtime-bindings?backend=shoggoth";
    let current = (await request("GET", route)).body;
    assert.equal(current.canAdd, true);
    const initialDefault = current.defaultBindingId;
    const added = await request("POST", route, {
      operationId: "crud-add", revision: current.revision,
      spec: { runtime: "grok-build", runtimeAccountId: "native-grok-build-default-v1", label: "CRUD" },
    });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    current = added.body;
    const id = current.binding.id;
    const item = (suffix) => `/runtime-bindings/${id}${suffix}?backend=shoggoth`;
    const stale = await request("PATCH", item(""), {
      patch: { label: "stale" }, revision: current.revision - 1,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "AGENT_BINDING_REVISION_CONFLICT");
    current = (await request("PATCH", item(""), {
      patch: { label: "Renamed", enabled: false }, revision: current.revision,
    })).body;
    assert.equal(current.binding.label, "Renamed");
    assert.equal(current.binding.enabled, false);
    current = (await request("PATCH", item(""), {
      patch: { enabled: true }, revision: current.revision,
    })).body;
    current = (await request("POST", item("/default"), { revision: current.revision })).body;
    assert.equal(current.defaultBindingId, id);
    assert.equal(f.service.productStore.getAgentProfile(f.profile.id).runtime, "grok-build");
    assert.equal(f.service.productStore.getAgentProfile(f.profile.id).agentId, f.profile.agentId);
    current = (await request("POST", `/runtime-bindings/${initialDefault}/default?backend=shoggoth`, {
      revision: current.revision,
    })).body;
    current = (await request("DELETE", item(""), { revision: current.revision })).body;
    assert.equal(current.binding, null);
    assert.equal(current.bindings.some((binding) => binding.id === id), false);

    const session = f.createSession();
    await backend._refreshManagedProfiles();
    const publicSessionKey = `agent:${f.profile.agentId}:${session.sessionKey}`;
    const sessionRoute = `/session-runtime?backend=shoggoth&sessionKey=${encodeURIComponent(publicSessionKey)}`;
    const state = await request("GET", sessionRoute);
    assert.equal(state.status, 200, JSON.stringify(state.body));
    const switched = await request("PUT", sessionRoute, {
      bindingId: f.binding("pi").id, revision: session.revision, acceptAdjustments: true,
    });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeBindingId, f.binding("pi").id);
    assert.equal(f.transport.acquisitions.length, 0, "CRUD handoff must not dispatch runtime");
    assert.equal(f.service.chatSessionStore.listPendingRuntimeSwitches().length, 0,
      "audit outbox completes through controller");
    console.log("PASS isolated native CRUD: production REST/Backend/socket/Product15/Chat8; bindings create/read/update/default/delete/CAS; session runtime read/switch/audit; no CLI or provider.");
  } finally {
    if (server) await server.close();
    await f.close();
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
