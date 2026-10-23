"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { createSessionRuntimeController } = require("../app/agent-service/session-runtime-controller");

function fixture() {
  const profile = { id: "profile-fixture", agentId: "shoggoth-fixture", enabled: true,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" }, defaultModel: null };
  const binding = { id: "11111111-1111-4111-8111-111111111111", profileId: profile.id,
    runtime: "codex", runtimeProfileId: "runtime-fixture", runtimeAccountId: "fixture-account", enabled: true };
  const unrelated = { ...binding, id: "22222222-2222-4222-8222-222222222222", runtime: "antigravity" };
  const session = { sessionKey: "33333333-3333-4333-8333-333333333333", profileId: profile.id,
    runtimeBindingId: binding.id, revision: 1, permissionMode: null, modelOverride: null, workspace: "/fixture" };
  const bindings = { bindings: [binding, unrelated], revision: 1, defaultBindingId: binding.id };
  const calls = [], probes = [];
  const controller = createSessionRuntimeController({
    productStore: { getAgentProfile: () => profile, getAgentRuntimeBindings: () => bindings },
    chatSessionStore: { getSession: () => session, getBinding: () => null },
    coordinator: { getRuntimeContext: () => null },
    facts: { async read(candidate) {
      probes.push(candidate.runtime);
      if (candidate.runtime === "antigravity") throw Object.assign(new Error("unrelated cold probe"), { code: "REQUEST_TIMEOUT" });
      return { installed: true, authenticated: true, permissionEnforcementProven: true };
    } },
    getNativeRuntimeConfig: () => ({ flags: { runtimeConversationHandoff: false } }),
  });
  const backend = Object.assign(Object.create(ShoggothBackend.prototype), {
    _state: "started", _statusUncertain: false, _profilesByAgent: new Map([[profile.agentId, profile]]),
    _bindingsByProfile: new Map(), runtimeCliAuth: new Map(), _getDisabledBackendIds: () => [],
    async _connectedCliAccounts() { throw new Error("sending must not refresh or synchronize other CLI accounts"); },
    async _call(method, params) {
      calls.push(method);
      if (method.startsWith("chat.session.runtime.")) return controller.handle(method, params);
      if (method === "agent.binding.list") return bindings;
      throw new Error(`unexpected mutation or model call: ${method}`);
    },
  });
  return { backend, binding, bindings, calls, probes, controller, target: { profile, session, sessionKey: session.sessionKey } };
}

test("send enablement does not wait for unrelated Runtime discovery or synchronize accounts", async () => {
  const f = fixture();
  // The full picker really does reach the failing cold candidate in this fixture.
  await assert.rejects(f.controller.handle("chat.session.runtime.get", {
    profileId: f.target.profile.id, sessionKey: f.target.sessionKey,
  }), { code: "REQUEST_TIMEOUT" });
  f.probes.length = 0;
  await f.backend._assertSessionRuntimeEnabled(f.target);
  assert.deepEqual(f.probes, [], "sending only needs current binding metadata; the picker retains full preflight");
  assert.deepEqual(f.calls, ["chat.session.runtime.state", "agent.binding.list"]);
});

test("missing and disabled selected bindings still reject the send gate", async () => {
  const missing = fixture();
  const call = missing.backend._call.bind(missing.backend);
  missing.backend._call = async (method, params) => method === "agent.binding.list"
    ? { ...missing.bindings, bindings: [] } : call(method, params);
  await assert.rejects(missing.backend._assertSessionRuntimeEnabled(missing.target), { code: "AGENT_BINDING_NOT_FOUND" });
  const disabled = fixture();
  disabled.binding.enabled = false;
  await assert.rejects(disabled.backend._assertSessionRuntimeEnabled(disabled.target), { code: "NATIVE_RUNTIME_DISABLED" });
  const disconnected = fixture();
  disconnected.backend._getDisabledBackendIds = () => ["codex"];
  await assert.rejects(disconnected.backend._assertSessionRuntimeEnabled(disconnected.target), { code: "NATIVE_RUNTIME_DISABLED" });
});

test("failed current metadata reads remain closed and never start another probe or send", async () => {
  const f = fixture();
  f.backend._call = async method => {
    f.calls.push(method);
    throw Object.assign(new Error("metadata unavailable"), { code: "SERVICE_RECOVERY_REQUIRED" });
  };
  await assert.rejects(f.backend._assertSessionRuntimeEnabled(f.target), { code: "SERVICE_RECOVERY_REQUIRED" });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.probes, []);
});
