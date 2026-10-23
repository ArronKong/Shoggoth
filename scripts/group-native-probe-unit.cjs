"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { GroupNativeExecutor } = require("../app/agent-service/group-native-executor");
const { resolveRuntimePermissionMode } = require("../app/agent-service/runtime-permission-modes");
const { validGroupCapabilities } = require("../app/agent-service/group-capabilities");

const hostCapabilities = { "session.start": true, "session.resume": true, "turn.start": true,
  "turn.interrupt": true, events: true };
const proof = { protocolVersion: 2, groupTools: true, collaborationActions: true, collaborationSupport: true };
function fixture(runtime = "codex", permissionPolicy = { approvalPolicy: "never", sandbox: "read-only" }) {
  const profile = { id: "p", enabled: true, runtime, runtimeProfileId: "rp", runtimeAccountId: "ra",
    defaultCwd: "/private/tmp/profile-workspace", permissionPolicy };
  const acquired = [], observed = [], resolved = [];
  const host = { capabilities: hostCapabilities };
  let session = null;
  const coordinator = {
    productStore: {
      resolveAgentRuntimeProfile(id, bindingId) { resolved.push({ id, bindingId }); return profile; },
      getAgentProfile() { throw Error("resolved Runtime binding must be used"); },
    },
    runtimeManager: { async acquire(binding, options) { acquired.push({ binding, options }); return host; } },
    runContexts: new Map(), runExecutionContracts: new Map(),
    getProductHelpContext() { return { capabilities: { "turn.start": false } }; },
  };
  const executor = new GroupNativeExecutor({ getWorkRunCoordinator: () => coordinator,
    chatSessionStore: { getSession() { return session; } },
    getGroupToolCapability(input) { observed.push(input); return proof; }, now: () => 100 });
  return { profile, acquired, observed, resolved, host, coordinator, executor,
    setSession(value) { session = value; } };
}

for (const [runtime, policy] of [
  ["codex", { approvalPolicy: "never", sandbox: "read-only" }],
  ["grok-build", { approvalPolicy: "on-request", sandbox: "read-only" }],
  ["antigravity", { approvalPolicy: "on-request", sandbox: "read-only" }],
  ["pi", { approvalPolicy: "on-request", sandbox: "read-only" }],
  ["opencode", { approvalPolicy: "on-request", sandbox: "danger-full-access" }],
  ["deepseek-harness", { approvalPolicy: "on-request", sandbox: "workspace-write" }],
]) test(`cold ${runtime} capability probe uses the profile workspace and Coordinator's separate host/turn policies`, async () => {
  const f = fixture(runtime, policy), before = structuredClone(f.profile);
  const result = await f.executor.probe({ member: { profileId: "p" } });
  assert.equal(result.availability, "available"); assert.equal(result.collaborationActions, true);
  assert.ok(validGroupCapabilities(result));
  assert.deepEqual(f.acquired, [{ binding: { runtime, runtimeProfileId: "rp", runtimeAccountId: "ra" },
    options: { workspace: before.defaultCwd, permissionPolicy: policy } }]);
  const permission = resolveRuntimePermissionMode(runtime, null, policy);
  assert.deepEqual(f.observed[0].profile.permissionPolicy, permission.permissionPolicy);
  assert.deepEqual(f.observed[0].profile.runtimeHostPermissionPolicy, policy);
  assert.equal(f.observed[0].profile.permissionMode, permission.mode);
  assert.equal(f.observed[0].profile.nativePermissionMode, permission.nativeMode);
  assert.deepEqual(f.profile, before, "capability observations never modify the selected profile");
});

test("a session's explicit workspace and selected permission mode use its exact Runtime binding", async () => {
  const f = fixture(); f.setSession({ profileId: "p", runtimeBindingId: "selected-binding", workspace: "/private/tmp/session-workspace",
    permissionMode: "workspace-auto" });
  await f.executor.probe({ member: { profileId: "other" }, binding: { sessionKey: "s", workspace: "/private/tmp/task-workspace" } });
  assert.deepEqual(f.resolved, [{ id: "p", bindingId: "selected-binding" }]);
  assert.equal(f.acquired[0].options.workspace, "/private/tmp/session-workspace");
  assert.deepEqual(f.acquired[0].options.permissionPolicy, f.profile.permissionPolicy);
  assert.deepEqual(f.observed[0].profile.permissionPolicy, { approvalPolicy: "on-request", sandbox: "workspace-write" });
  assert.equal(f.observed[0].profile.nativePermissionMode, "workspace-auto");
});

test("task workspace overrides the profile default while a session's explicit null remains authoritative", async () => {
  const f = fixture();
  await f.executor.probe({ member: { profileId: "p" }, binding: { workspace: "/private/tmp/task-workspace" } });
  assert.equal(f.acquired[0].options.workspace, "/private/tmp/task-workspace");
  f.setSession({ profileId: "p", workspace: null });
  await f.executor.probe({ member: { profileId: "p" }, binding: { sessionKey: "s" } });
  assert.equal(f.acquired[1].options.workspace, null);
});

test("a missing referenced session is unknown and never falls back to cold acquisition", async () => {
  const f = fixture();
  const result = await f.executor.probe({ member: { profileId: "p" }, binding: { sessionKey: "missing" } });
  assert.equal(result.availability, "unknown"); assert.equal(result.collaborationActions, false);
  assert.equal(f.acquired.length, 0); assert.equal(f.observed.length, 0);
});

function liveFixture() {
  const f = fixture();
  const contract = Object.freeze({ runId: "r", profileId: "p", runtime: "grok-build", runtimeProfileId: "frozen-rp",
    runtimeAccountId: "frozen-ra", workspace: "/private/tmp/frozen-workspace", permissionMode: "ask", nativePermissionMode: "default",
    permissionPolicy: Object.freeze({ approvalPolicy: "on-request", sandbox: "read-only" }),
    runtimeHostPermissionPolicy: Object.freeze({ approvalPolicy: "untrusted", sandbox: "read-only" }) });
  const host = { capabilities: hostCapabilities };
  const context = { profileId: "p", host, runtimeBinding: { runtime: contract.runtime,
    runtimeProfileId: contract.runtimeProfileId, runtimeAccountId: contract.runtimeAccountId } };
  f.coordinator.runExecutionContracts.set("r", contract); f.coordinator.runContexts.set("r", context);
  f.coordinator.productStore.resolveAgentRuntimeProfile = () => { throw Error("live binding must not re-read a selected profile"); };
  return { ...f, contract, context };
}

test("a live Run observes its actual held host and frozen contract despite a changed or disabled profile", async () => {
  const f = liveFixture(); f.profile.enabled = false; f.profile.runtime = "pi";
  const result = await f.executor.probe({ member: { profileId: "p" }, runId: "r" });
  assert.equal(result.availability, "available"); assert.equal(result.mode, "grok-build");
  assert.equal(result.discussion, true, "the actual context host is authoritative for capabilities");
  assert.equal(f.acquired.length, 0); assert.equal(f.observed[0].host, f.context.host);
  assert.deepEqual(f.observed[0].binding, f.context.runtimeBinding);
  assert.deepEqual(f.observed[0].profile.permissionPolicy, f.contract.permissionPolicy);
  assert.deepEqual(f.observed[0].profile.runtimeHostPermissionPolicy, f.contract.runtimeHostPermissionPolicy);
  assert.equal(f.observed[0].profile.workspace, f.contract.workspace);
});

test("missing or mismatched live execution evidence stays unknown without any replacement host", async () => {
  for (const invalidate of [
    f => f.coordinator.runContexts.delete("r"),
    f => f.coordinator.runExecutionContracts.delete("r"),
    f => { f.context.profileId = "other"; },
    f => { f.context.runtimeBinding.runtimeAccountId = "other"; },
    f => { f.coordinator.getProductHelpContext = () => null; },
  ]) {
    const f = liveFixture(); invalidate(f);
    const result = await f.executor.probe({ member: { profileId: "p" }, runId: "r" });
    assert.equal(result.availability, "unknown"); assert.equal(result.collaborationActions, false);
    assert.equal(f.acquired.length, 0); assert.equal(f.observed.length, 0);
  }
});

test("a late capability reply cannot promote proof after the held live context is replaced", async () => {
  const f = liveFixture();
  f.executor.getGroupToolCapability = async () => {
    f.coordinator.runContexts.set("r", { ...f.context, host: { capabilities: hostCapabilities } }); return proof;
  };
  const result = await f.executor.probe({ member: { profileId: "p" }, runId: "r" });
  assert.equal(result.availability, "unknown"); assert.equal(result.collaborationActions, false);
  assert.equal(f.acquired.length, 0);
});


test("a cold member without a custom workspace uses the same managed workspace resolver as chat", async () => {
  const f = fixture("grok-build", { approvalPolicy: "on-request", sandbox: "workspace-write" });
  f.profile.defaultCwd = null;
  const seen = [];
  f.executor.resolveWorkspace = profile => { seen.push(profile.id); return "/private/tmp/managed-group-workspace"; };
  f.coordinator.runtimeManager.acquire = async (binding, options) => {
    f.acquired.push({ binding, options });
    if (options.workspace === null) throw Object.assign(new Error("explicit workspace required"), { code: "WORKSPACE_REQUIRED_FOR_WRITABLE_RUN" });
    return f.host;
  };
  const result = await f.executor.probe({ member: { profileId: "p" } });
  assert.equal(result.availability, "available");
  assert.deepEqual(seen, ["p"]);
  assert.equal(f.acquired[0].options.workspace, "/private/tmp/managed-group-workspace");
  assert.equal(f.profile.defaultCwd, null);
});

test("background preparation retains the original Runtime-account mutation generation", async () => {
  const f = fixture(); let generation = 1, mutationActive = false;
  f.coordinator.runtimeAccountAdmission = { read: () => ({ generation, mutationActive }) };
  await f.executor.probe({ member: { profileId: "p" } });
  f.observed[0].assertCurrent();
  generation = 2;
  assert.throws(() => f.observed[0].assertCurrent(), /account changed/);
  generation = 1; mutationActive = true;
  assert.throws(() => f.observed[0].assertCurrent(), /account changed/);
});
