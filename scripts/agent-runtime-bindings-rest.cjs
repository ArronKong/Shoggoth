"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { bindingId } = require("../app/agent-service/agent-runtime-binding");
const { validateAgentBindingParams } = require("../app/agent-service/agent-runtime-binding-protocol");
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-binding-rest-"));
  let server;
  try {
    const binding = { id: bindingId("profile-one", "runtime-one"), profileId: "profile-one", runtime: "codex",
      runtimeProfileId: "runtime-one", runtimeAccountId: "account-one", label: null, enabled: true, revision: 1, createdAt: 1, updatedAt: 1 };
    let state = { bindings: [binding], defaultBindingId: binding.id, revision: 1, canAdd: true };
    const calls = [];
    const backend = new ShoggothBackend({ paths: {}, readToken: () => "fixture-token", requestService: async (_paths, request) => {
      const params = validateAgentBindingParams(request.method, request.params); calls.push(request.method);
      assert.equal(params.profileId, "profile-one");
      if (request.method === "agent.binding.list") return state;
      if (params.revision !== state.revision) throw Object.assign(Error("private service error"), { code: "AGENT_BINDING_REVISION_CONFLICT" });
      if (request.method === "agent.binding.add") {
        const added = { ...binding, ...params.spec, id: bindingId("profile-one", "runtime-added"), runtimeProfileId: "runtime-added", revision: 2, updatedAt: 2 };
        state = { ...state, bindings: [...state.bindings, added], revision: 2 }; return { ...state, binding: added };
      }
      throw Object.assign(Error("private path must not escape"), { code: "AGENT_BINDING_IN_USE" });
    } });
    backend._assertDomainReady = () => {}; backend._refreshManagedProfiles = async () => {};
    backend._profilesByAgent.set("agent-one", { id: "profile-one" });
    const registry = new BackendRegistry(); registry.register(backend);
    server = await startStaticServer(0, { registry, homeDir: temp, userDataRoot: path.join(temp, "data") });
    const request = async (method, suffix = "", body, origin = server.url) => {
      const response = await fetch(`${server.url}/__api/agents/agent-one/runtime-bindings${suffix}?backend=shoggoth`, {
        method, headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await request("GET")).body.revision, 1);
    const add = { spec: { runtime: "pi", runtimeAccountId: "account-pi" }, revision: 1, operationId: "add-one" };
    assert.equal((await request("POST", "", add, null)).status, 403);
    assert.equal((await request("POST", "", { ...add, profileId: "foreign" })).status, 400);
    assert.equal((await request("POST", "", { ...add, revision: undefined })).status, 400);
    assert.equal(calls.length, 1);
    const added = await request("POST", "", add); assert.equal(added.status, 200); assert.equal(added.body.bindings.length, 2);
    assert.equal((await request("POST", "", add)).body.code, "AGENT_BINDING_REVISION_CONFLICT");
    for (const [method, suffix, body] of [["PATCH", `/${binding.id}`, { patch: { label: "Name" }, revision: 2 }],
      ["DELETE", `/${binding.id}`, { revision: 2 }], ["POST", `/${binding.id}/default`, { revision: 2 }]]) {
      const response = await request(method, suffix, body); assert.equal(response.body.code, "AGENT_BINDING_IN_USE");
      assert.ok(!JSON.stringify(response).includes("private"));
    }
    console.log("Binding REST passed: production routes / Backend strict IPC; isolated fake Service.");
  } finally { if (server) await server.close(); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
