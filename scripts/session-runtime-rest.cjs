"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { bindingId } = require("../app/agent-service/agent-runtime-binding");
const { validateSessionRuntimeParams } = require("../app/agent-service/session-runtime-protocol");
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-runtime-rest-")); let server;
  try {
    const profile = { id: "profile-one", agentId: "shoggoth-agent-one", runtime: "codex", runtimeAccountId: "account-codex" };
    const bindings = ["codex", "pi"].map((runtime) => ({ id: bindingId(profile.id, `runtime-${runtime}`), profileId: profile.id,
      runtime, runtimeProfileId: `runtime-${runtime}`, runtimeAccountId: `account-${runtime}`, label: null,
      enabled: true, revision: 1, createdAt: 1, updatedAt: 1 }));
    const sessionKey = "11111111-1111-4111-8111-111111111111";
    const gatewayKey = `agent:${profile.agentId}:${sessionKey}`;
    let state = { sessionKey, revision: 1, bindingId: bindings[0].id, runtime: "codex", model: null, contextUsage: null,
      candidates: bindings.map((entry) => ({ bindingId: entry.id, support: { supported: true }, adjustments: { clearModelOverride: false, permissionMode: null } })), canSwitch: true };
    let busy = false; const calls = []; const notifications = [];
    const backend = new ShoggothBackend({ paths: {}, readToken: () => "fake", requestService: async (_paths, request, options) => {
      calls.push(request.method);
      if (request.method === "agent.binding.list") return { bindings, defaultBindingId: bindings[0].id, revision: 1, canAdd: true };
      const params = validateSessionRuntimeParams(request.method, request.params);
      assert.equal(options.timeoutMs, 12000); assert.equal(params.profileId, profile.id); assert.equal(params.sessionKey, sessionKey);
      if (request.method.endsWith("switch")) {
        if (busy) throw Object.assign(Error("private busy detail"), { code: "SESSION_BUSY" });
        if (params.revision !== state.revision) throw Object.assign(Error("private stale detail"), { code: "CHAT_SESSION_REVISION_CONFLICT" });
        const binding = bindings.find((entry) => entry.id === params.bindingId);
        state = { ...state, bindingId: binding.id, runtime: binding.runtime, revision: state.revision + 1 };
      }
      return state;
    } });
    backend._assertDomainReady = () => {}; backend._profilesByAgent.set(profile.agentId, profile);
    backend._sessionsByKey.set(sessionKey, { profileId: profile.id }); backend._syncFederationTargetSession = async () => null;
    backend._sessionActivityNotifier = (event) => notifications.push(event);
    const registry = new BackendRegistry(); registry.register(backend);
    server = await startStaticServer(0, { registry, homeDir: root, userDataRoot: path.join(root, "data") });
    const request = async (body, { origin = server.url, id = profile.agentId, key = gatewayKey, alias = "codex" } = {}) => {
      const response = await fetch(`${server.url}/__api/agents/${id}/session-runtime?backend=${alias}&sessionKey=${encodeURIComponent(key)}`, {
        method: body ? "PUT" : "GET", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }); return { status: response.status, body: await response.json() };
    };
    assert.equal((await request()).body.runtime, "codex");
    const input = { bindingId: bindings[1].id, revision: 1, acceptAdjustments: false };
    assert.equal((await request(input, { origin: null })).status, 403);
    assert.equal((await request({ ...input, profileId: "foreign" })).status, 400);
    assert.equal((await request({ ...input, revision: undefined })).status, 400);
    assert.equal((await request(null, { key: `agent:foreign:${sessionKey}` })).status, 409);
    assert.deepEqual(calls, ["chat.session.runtime.get"]);
    busy = true; const rejected = await request(input); assert.equal(rejected.body.code, "SESSION_BUSY"); assert.ok(!JSON.stringify(rejected).includes("private"));
    busy = false; const changed = await request(input); assert.equal(changed.body.runtime, "pi"); assert.equal(changed.body.revision, 2);
    assert.equal((await request(input)).body.code, "CHAT_SESSION_REVISION_CONFLICT");
    assert.deepEqual(notifications, [{ kind: "sessions.changed", sessionKey: gatewayKey }]);
    const before = calls.length; let getters = 0;
    await assert.rejects(() => backend.switchSessionRuntime(profile.agentId, gatewayKey, { ...input, get revision() { getters++; return 2; } }));
    assert.equal(getters, 0); assert.equal(calls.length, before);
    console.log("Session Runtime REST passed: strict Backend IPC, aliases, Origin, ownership, busy/CAS failures, notification.");
  } finally { if (server) await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
