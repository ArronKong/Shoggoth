"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { bindingId } = require("../app/agent-service/agent-runtime-binding");
const { validateAgentBindingParams: params, validateAgentBindingResult: result } = require("../app/agent-service/agent-runtime-binding-protocol");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
function binding(runtime = "codex") {
  const runtimeProfileId = `runtime-${runtime}`;
  return { id: bindingId("profile-one", runtimeProfileId), profileId: "profile-one", runtime, runtimeProfileId,
    runtimeAccountId: `account-${runtime}`, label: null, enabled: true, revision: 1, createdAt: 1, updatedAt: 1 };
}
function snapshot(bindings = [binding()]) { return { bindings, defaultBindingId: bindings[0].id, revision: 1, canAdd: false }; }
test("strict binding requests reject missing CAS, extra authority, accessors and empty patches", () => {
  const input = { profileId: "profile-one", spec: { runtime: "pi", runtimeAccountId: "account-pi" }, operationId: "op-1", revision: 1 };
  assert.deepEqual(params("agent.binding.add", input), input);
  for (const bad of [{ ...input, revision: undefined }, { ...input, backendId: "pi" }, { ...input, spec: { ...input.spec, runtimeProfileId: "injected" } }]) {
    assert.throws(() => params("agent.binding.add", bad), { code: "AGENT_BINDING_INVALID" });
  }
  let getters = 0;
  assert.throws(() => params("agent.binding.list", { get profileId() { getters++; return "profile-one"; } }));
  assert.equal(getters, 0);
  assert.throws(() => params("agent.binding.update", { profileId: "profile-one", bindingId: binding().id, revision: 1, patch: {} }));
});
test("strict binding snapshots reject cross-Agent/default/mutation mismatch and getters", () => {
  const input = { profileId: "profile-one" };
  assert.deepEqual(result("agent.binding.list", snapshot(), input), snapshot());
  assert.throws(() => result("agent.binding.list", snapshot(), { profileId: "another-agent" }));
  assert.throws(() => result("agent.binding.list", { ...snapshot(), defaultBindingId: binding("pi").id }, input));
  assert.throws(() => result("agent.binding.list", snapshot([{ ...binding(), enabled: false }]), input));
  assert.throws(() => result("agent.binding.list", snapshot([binding(), binding()]), input));
  let getters = 0;
  assert.throws(() => result("agent.binding.list", snapshot([{ ...binding(), get label() { getters++; return "secret"; } }]), input));
  assert.equal(getters, 0);
  assert.throws(() => result("agent.binding.update", { ...snapshot(), binding: binding("pi") }, { ...input, bindingId: binding().id }));
  assert.throws(() => result("agent.binding.remove", { ...snapshot(), binding: null }, { ...input, bindingId: binding().id }));
  const parsed = result("agent.binding.list", snapshot(), input);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.bindings) && Object.isFrozen(parsed.bindings[0]));
});
test("Backend resolves Agent authority, validates before IPC and isolates unsafe service errors", async () => {
  const calls = [];
  const backend = new ShoggothBackend({ paths: {}, readToken: () => "fixture-only-token", requestService: async (_paths, request) => {
    calls.push(request); return snapshot();
  } });
  backend._assertDomainReady = () => {};
  backend._profilesByAgent.set("agent-one", { id: "profile-one" });
  assert.deepEqual(await backend.getAgentRuntimeBindings("agent-one"), { ...snapshot(), availability: [{ bindingId: binding().id, available: true, reason: null }] });
  assert.equal(calls[0].params.profileId, "profile-one");
  await assert.rejects(() => backend.addAgentRuntimeBinding("agent-one", { runtime: "pi", runtimeAccountId: "account-pi" }, { operationId: "op" }), { code: "AGENT_BINDING_INVALID" });
  assert.equal(calls.length, 1);
  await assert.rejects(() => backend.getAgentRuntimeBindings("other"), { code: "AGENT_NOT_FOUND" });
  backend.requestService = async () => { throw Object.assign(Error("secret filesystem path"), { code: "AGENT_BINDING_REVISION_CONFLICT" }); };
  await assert.rejects(() => backend.getAgentRuntimeBindings("agent-one"), (error) => error.code === "AGENT_BINDING_REVISION_CONFLICT" && !error.message.includes("secret"));
});

test("automatic CLI sync accepts only bounded, unique data arrays without evaluating accessors", () => {
  const request = { profileId: "profile-one", runtimeAccountIds: ["native-pi-default-v1"] };
  assert.deepEqual(params("agent.binding.sync", request), request);
  for (const runtimeAccountIds of [["duplicate", "duplicate"], Array(1), Array(7).fill("x"), Object.assign(["valid"], { extra: 1 })]) {
    assert.throws(() => params("agent.binding.sync", { ...request, runtimeAccountIds }), { code: "AGENT_BINDING_INVALID" });
  }
  let evaluated = 0;
  const accessors = [];
  Object.defineProperty(accessors, "0", { get() { evaluated++; return "secret"; }, enumerable: true });
  assert.throws(() => params("agent.binding.sync", { ...request, runtimeAccountIds: accessors }));
  assert.equal(evaluated, 0);
  assert.deepEqual(result("agent.binding.sync", snapshot(), { profileId: "profile-one" }), snapshot());
});
