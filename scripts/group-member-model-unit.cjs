"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupChatService } = require("../app/agent-service/group-chat-service");
const { GroupNativeExecutor } = require("../app/agent-service/group-native-executor");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { validateParams } = require("../app/agent-service/group-chat-protocol");
const { validModelCatalog, validModelSelection } = require("../app/group-member-model");
const { HermesBackend } = require("../app/core/hermes-backend");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { ExternalInspirationRunner } = require("../app/external-inspiration-runner");
const { validateExternalInspirationParams } = require("../app/external-inspiration-protocol");
const selection = { model: "model-b", provider: "codex" };
const catalog = { models: [{ id: "model-b", name: "Model B", provider: "codex" }], defaultModel: "model-a" };
function pathsFor(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-model-"))); fs.chmodSync(root, 0o700);
  return { stateDir: path.join(root, "state"), trustedRoot: root };
}
function groupFixture(t) {
  const paths = pathsFor(t); let store = new GroupChatStore({ paths }).open();
  t.after(() => { store.close(); fs.rmSync(paths.trustedRoot, { recursive: true, force: true }); });
  const members = ["a", "b"].map(agentId => ({ backendId: "shoggoth", agentId, profileId: `p-${agentId}`, displayName: agentId }));
  const groups = ["one", "two"].map(name => store.createGroup({ name, purpose: "", operationId: name, members }).groupId);
  const member = store.getGroup(groups[0]).members[0];
  return { get store() { return store; }, groups, member,
    reopen() { store.close(); store = new GroupChatStore({ paths }).open(); },
    set(value, revision = store.getGroup(groups[0]).group.rosterRevision) {
      return store.setMemberModel({ groupId: groups[0], memberId: member.id, expectedRosterRevision: revision, modelSelection: value });
    } };
}
test("model policy rejects malformed/cross-provider identity and catalogs are bounded", () => {
  for (const value of [undefined, {}, { model: "m" }, { ...selection, extra: true }, { ...selection, model: "\n" }]) assert.equal(validModelSelection(value), false);
  assert(validModelSelection(null)); assert(validModelCatalog(catalog));
  assert.equal(validModelCatalog({ ...catalog, models: [catalog.models[0], catalog.models[0]] }), false);
  assert.equal(validModelCatalog({ ...catalog, models: Array.from({ length: 256 }, (_, i) => ({ id: String(i), name: "x".repeat(512), provider: "p" })) }), false, "catalog stays within the private federation frame");
  assert.throws(() => validateParams("group.members.model", { groupId: "g", memberId: "m", expectedRosterRevision: 1, modelSelection: { model: "m" } }));
});
test("member policy is scoped, CAS protected, durable, and reset preserves inheritance", t => {
  const f = groupFixture(t), first = f.store.getGroup(f.groups[0]);
  assert.equal(first.members[0].modelSelection ?? null, null);
  f.set(selection);
  assert.throws(() => f.set(null, first.group.rosterRevision), error => error.code === "GROUP_CHAT_REVISION_CONFLICT");
  assert.equal(f.store.getGroup(f.groups[0]).members[1].modelSelection ?? null, null);
  assert.equal(f.store.getGroup(f.groups[1]).members[0].modelSelection ?? null, null);
  f.reopen(); assert.deepEqual(f.store.getGroup(f.groups[0]).members[0].modelSelection, selection);
  f.set(null); f.reopen(); assert.equal(f.store.getGroup(f.groups[0]).members[0].modelSelection, null);
});
test("service validates current catalog without running a turn and permits offline reset", async t => {
  const f = groupFixture(t); let unavailable = false, reads = 0;
  const service = new GroupChatService({ store: f.store, productStore: {}, driver: {}, nativeExecutor: {
    async getModels({ member }) { reads++; assert.equal(member.id, f.member.id); if (unavailable) throw Error("offline"); return catalog; },
  } });
  const deadlines = [];
  const backend = new ShoggothBackend({ paths: {}, readToken: () => "fixture-token", requestService: async (_paths, request, options) => {
    deadlines.push({ method: request.method, selection: request.params.modelSelection, timeout: options.timeoutMs });
    return service.handle(request.method, request.params);
  } });
  const params = () => ({ groupId: f.groups[0], memberId: f.member.id, expectedRosterRevision: f.store.getGroup(f.groups[0]).group.rosterRevision });
  assert.deepEqual(await backend.getGroupChatMemberModels(f.groups[0], f.member.id), catalog);
  await assert.rejects(service.handle("group.members.model", { ...params(), modelSelection: { ...selection, provider: "other" } }), error => error.code === "GROUP_CHAT_MODEL_UNAVAILABLE");
  await backend.setGroupChatMemberModel(f.groups[0], { ...params(), modelSelection: selection });
  unavailable = true;
  await assert.rejects(service.handle("group.members.model", { ...params(), modelSelection: selection }), error => error.code === "GROUP_CHAT_MODEL_CATALOG_UNAVAILABLE");
  const before = reads;
  await backend.setGroupChatMemberModel(f.groups[0], { ...params(), modelSelection: null });
  assert.equal(reads, before); assert.equal(f.store.getGroup(f.groups[0]).members[0].modelSelection, null);
  assert.deepEqual(deadlines.map(item => item.timeout), [45_000, 45_000, 5_000], "catalog and validating saves cover cold runtime discovery; offline clear stays a control request");
});
test("native selection changes only the owned session, clears durably, and rejects late busy/binding changes", async t => {
  const paths = pathsFor(t); let store = new ChatSessionStore({ paths }).open();
  t.after(() => { store.close(); fs.rmSync(paths.trustedRoot, { recursive: true, force: true }); });
  const create = key => store.createSession({ operationId: key, profileId: "p-a", workspace: null, createdAt: Date.now() });
  const session = create("one"), other = create("two");
  const profile = { id: "p-a", runtime: "codex", selectedBindingId: "binding-a", defaultModel: "model-a" };
  let busy = false, late = () => {};
  const executor = new GroupNativeExecutor({ chatSessionStore: store, getWorkRunCoordinator: () => ({
    productStore: { resolveAgentRuntimeProfile: () => ({ ...profile }) }, isSessionBusy: () => busy,
  }), listBindingModels: async input => { assert.equal(input.bindingId, "binding-a"); late(); return { models: [{ id: "model-b", displayName: "B" }], hasMore: false }; } });
  const input = { member: { profileId: "p-a" }, sessionKey: session.sessionKey, modelSelection: selection };
  await executor.prepareModel(input);
  assert.equal(store.getSession(session.sessionKey).modelOverride, "model-b");
  assert.equal(store.getSession(other.sessionKey).modelOverride, null); assert.equal(profile.defaultModel, "model-a");
  profile.defaultModel = "model-c";
  await executor.prepareModel({ ...input, modelSelection: null });
  assert.equal(store.getSession(session.sessionKey).modelOverride, null);
  store.close(); store = new ChatSessionStore({ paths }).open(); executor.chatSessionStore = store;
  assert.equal(store.getSession(session.sessionKey).modelOverride, null);
  assert.equal((await executor.getModels({ member: input.member })).defaultModel, "model-c");
  await assert.rejects(executor.prepareModel({ ...input, member: { profileId: "p-other" } }));
  late = () => { busy = true; };
  await assert.rejects(executor.prepareModel(input)); assert.equal(store.getSession(session.sessionKey).modelOverride, null);
  busy = false; late = () => { profile.defaultModel = "changed-during-read"; };
  await assert.rejects(executor.prepareModel(input)); assert.equal(store.getSession(session.sessionKey).modelOverride, null);
});
test("Hermes reads one profile and applies custom/provider identity and fresh defaults only to that session", async () => {
  const backend = Object.create(HermesBackend.prototype), dash = {}, calls = [];
  Object.assign(backend, { profileById: new Map([["a", "profile-a"], ["b", "profile-b"]]), dashboards: new Map([["profile-a", dash]]), _lifecycleGeneration: 1 });
  let info = { model: "default-a", provider: "official" };
  backend._settingsGet = async (target, url) => { assert.equal(target, dash); calls.push(url); return url.endsWith("info") ? info : {
    providers: [{ slug: "mine", is_user_defined: true, models: ["model-b"] }, { slug: "official", models: ["model-b"] }],
  }; };
  backend._sessionTarget = key => ({ agentId: key.split(":")[1] });
  const writes = []; backend.setSessionModel = async (key, input) => { writes.push({ key, ...input }); return { scope: "session" }; };
  assert.equal((await backend.getGroupMemberModels("a")).models.length, 2);
  await assert.rejects(backend.getGroupMemberModels("b"));
  await backend.applyGroupSessionModel("a", "agent:a:group", { model: "model-b", provider: "mine" });
  assert.deepEqual(writes[0], { key: "agent:a:group", model: "model-b", provider: "mine", acpProviderRef: "custom:mine", scope: "session" });
  info = { model: "new-default", provider: "official" };
  const before = calls.length; await backend.applyGroupSessionModel("a", "agent:a:group", null);
  assert.deepEqual(calls.slice(before), ["/api/model/info"]); assert.equal(writes[1].model, "new-default");
  await assert.rejects(backend.applyGroupSessionModel("b", "agent:a:group", null));
  await assert.rejects(backend.applyGroupSessionModel("a", "agent:a:group", { model: "model-b", provider: "wrong" }));
  assert.equal(writes.length, 2);
});
test("OpenClaw catalog stays agent scoped; patch sets provider/model or clears the override", async () => {
  const backend = Object.create(OpenClawBackend.prototype), calls = [];
  backend._connectionGeneration = 1; backend._connect = async () => {}; backend.getAgent = async id => ({ id, model: "vendor/default" });
  backend.request = async (method, params) => { calls.push({ method, params }); return { models: [
    { id: "model-b", name: "B", provider: "vendor", available: true }, { id: "blocked", name: "blocked", provider: "vendor", available: false },
  ] }; };
  await backend.applyGroupSessionModel("a", "agent:a:group", { model: "model-b", provider: "vendor" });
  assert.deepEqual(calls[0], { method: "models.list", params: { agentId: "a", view: "configured" } });
  assert.deepEqual(calls[1], { method: "sessions.patch", params: { key: "agent:a:group", model: "vendor/model-b" } });
  await backend.applyGroupSessionModel("a", "agent:a:group", null);
  assert.deepEqual(calls[2], { method: "sessions.patch", params: { key: "agent:a:group", model: null } });
  await assert.rejects(backend.applyGroupSessionModel("a", "agent:b:group", null));
  await assert.rejects(backend.applyGroupSessionModel("a", "agent:a:group", { model: "blocked", provider: "vendor" }));
  assert.equal(calls.filter(call => call.method === "sessions.patch").length, 2);
});
test("external preparation carries the frozen model policy; failed preparation never starts a turn", async () => {
  const prepared = [], starts = [];
  const driver = { async prepare(input) { prepared.push(input); if (input.modelSelection?.model === "bad") throw Error("unavailable"); return { sessionKey: "agent:a:group", workspace: "/tmp", mode: "gateway" }; },
    async start(input) { starts.push(input); return { status: "running" }; } };
  const runner = new ExternalInspirationRunner({ registry: { getBackend: () => ({}) }, adapters: { hermes: driver }, adapterOptions: { sessionPurpose: "group" } });
  const input = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), backendId: "hermes", agentId: "a", sessionKey: null, workspace: null, operationId: "prepare-model", modelSelection: selection };
  assert(validateExternalInspirationParams("group.external.prepare", input));
  assert.equal(validateExternalInspirationParams("inspiration.external.prepare", input), false);
  await runner.prepare(input); assert.deepEqual(prepared[0].modelSelection, selection);
  await assert.rejects(runner.prepare({ ...input, modelSelection: null }));
  await assert.rejects(runner.prepare({ ...input, executionId: crypto.randomUUID(), runId: crypto.randomUUID(), operationId: "bad", modelSelection: { ...selection, model: "bad" } }));
  assert.equal(starts.length, 0);
});
