"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { GroupRuntimeHost } = require("../app/group-runtime-host");
const { GroupRuntimeRouter } = require("../app/group-runtime-router");
const { requestGroupHost } = require("../app/group-runtime-host-client");
const { runtimeRequest, createGroupRuntimeMcpHandler } = require("../app/group-runtime-mcp-helper");
const { GroupExternalArtifacts } = require("../app/agent-service/group-external-artifacts");
const { GroupAdapterChannel } = require("../app/agent-service/group-adapter-channel");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupChatService } = require("../app/agent-service/group-chat-service");
const { GroupChatDriver } = require("../app/agent-service/group-chat-driver");
const { GroupExternalExecutor } = require("../app/agent-service/group-external-executor");
const { ExternalInspirationRunner } = require("../app/external-inspiration-runner");
const { validateParams, validateResult } = require("../app/agent-service/group-chat-protocol");
const p = require("../app/group-runtime-host-protocol");
const { resultPage } = require("../app/group-result-content");

const token = () => crypto.randomBytes(32).toString("base64url");
const groupToken = kind => `gt1.${kind}.${crypto.randomUUID()}.${token()}`;
async function fixture(t, { git = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-host-"))); fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace); const runs = new Map(), starts = [], cleanups = [];
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: workspace }); fs.writeFileSync(path.join(workspace, "base.txt"), "base");
    execFileSync("git", ["add", "base.txt"], { cwd: workspace });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base"], { cwd: workspace });
  }
  let clock = 10_000;
  const agent = { backendId: "hermes", agentId: "hermes-default" }, ownerToken = token(), runtimeToken = token();
  const authority = { groupId: crypto.randomUUID(), ownerId: crypto.randomUUID(), epoch: 1 };
  const registry = { getBackend: () => ({ getAgent: async () => ({ id: agent.agentId, name: "Remote helper", model: "fixture" }),
    getGroupMemberModels: async () => ({ models: [{ id: "chosen", name: "Chosen", provider: "custom" }], defaultModel: "fixture" }),
    getAgentFile: async () => ({ content: "远端角色原文🙂\n".repeat(3000), missing: false }) }) };
  const preparations = [];
  const driver = {
    async prepare(input) { preparations.push(input);
      if (input.modelSelection?.model === "gone") throw Object.assign(Error("raw details must stay private"), { code: "GROUP_CHAT_MODEL_UNAVAILABLE" });
      return { sessionKey: input.sessionKey ?? `agent:hermes-default:${input.sessionId}`, workspace: input.workspace ?? workspace, mode: "gateway" }; },
    async start(input, onUpdate) { starts.push(input); runs.set(input.runId, { input, onUpdate, status: "running", text: "" }); return { status: "running" }; },
    async inspect(input) { const run = runs.get(input.runId); return run ? { status: run.status, resultSummary: run.status === "completed" ? "摘要" : null } : { status: "unknown" }; },
    async fullResult(input) { return runs.get(input.runId)?.text || null; },
    async publicProgress(input) { return runs.get(input.runId)?.progress ?? null; },
    async cancel(input) { const run = runs.get(input.runId); if (run) run.status = "canceled"; return { status: "canceled" }; },
    async respond(input) { const run = runs.get(input.runId); if (run) run.status = "running"; return { status: "running" }; },
    reset() {},
  };
  let host;
  const open = () => {
    const value = new GroupRuntimeHost({ paths: { stateDir: path.join(root, "state"), trustedRoot: root }, registry,
      agent, ownerToken, runtimeToken, localWorkspace: git ? workspace : null, now: () => clock }).open();
    value.runner.adapters.hermes = driver; // Keep the production onSnapshot -> durable Host path.
    return value;
  };
  host = open(); const address = await host.listen();
  let peer = { id: "remote-fixture", ...agent, baseUrl: `http://127.0.0.1:${address.port}/`, token: ownerToken, hostId: host.hostId };
  const request = (method, params, owner = authority) => requestGroupHost(peer, method, params, method === "host.capabilities" ? null : owner);
  const connection = () => ({ version: 1, ...agent, baseUrl: peer.baseUrl, hostId: peer.hostId, runtimeToken });
  const prepare = async ({ kind = "turn", taskId = null, owner = authority, grant = groupToken(kind === "turn" ? "t" : "k") } = {}) => {
    const identity = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), ...agent };
    const params = { ...identity, sessionKey: null, workspace: null, operationId: `prepare-${identity.executionId}` };
    const prepared = await request("host.prepare", { execution: params, kind, taskId }, owner);
    const execution = { ...identity, ...prepared.binding, hostId: prepared.hostId };
    const started = await request("group.external.start", { ...execution, prompt: `执行。groupToken="${grant}"`, operationId: `start-${identity.executionId}` }, owner);
    return { execution, prepared, started, grant, params };
  };
  t.after(async () => { await host.close(); for (const cleanup of cleanups) cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, runs, starts, preparations, agent, authority, runtimeToken, request, prepare, connection, cleanups,
    get host() { return host; }, get peer() { return peer; }, advance(ms) { clock += ms; },
    async restart() {
      await host.close(); host = open(); const address = await host.listen(); peer = { ...peer, baseUrl: `http://127.0.0.1:${address.port}/` };
      return host;
    },
  };
}

test("prepared model policy is recovered from the host journal before dispatch", async t => {
  const f = await fixture(t);
  const modelSelection = { model: "chosen", provider: "custom" };
  const execution = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), ...f.agent,
    sessionKey: null, workspace: null, operationId: "prepare-model", modelSelection };
  await f.request("host.prepare", { execution, kind: "turn", taskId: null });
  assert.deepEqual(f.preparations[0].modelSelection, modelSelection);
  await f.restart();
  const restored = await f.request("host.prepare", { execution, kind: "turn", taskId: null });
  const { modelSelection: _model, ...identity } = execution;
  await f.request("group.external.start", { ...identity, ...restored.binding, hostId: restored.hostId,
    prompt: "reply", operationId: "start-model" });
  assert.deepEqual(f.preparations.at(-1).modelSelection, modelSelection);
  assert.equal(f.starts.length, 1);
});

test("terminal response facts survive Host restart and retain group authority and execution binding", async t => {
  const f = await fixture(t), { execution } = await f.prepare();
  const metadata = { models: ["actual"], modelSource: "reported", usage: { inputTokens: 800, outputTokens: 24 } };
  f.host.runner.adapters.hermes.responseMetadata = () => structuredClone(metadata);
  const run = f.runs.get(execution.runId); run.status = "completed"; run.text = "complete answer";
  run.onUpdate({ status: "completed", resultSummary: run.text });
  assert.deepEqual((await f.request("group.external.metadata", execution)).responseMetadata, metadata);
  await f.restart();
  assert.deepEqual((await f.request("group.external.metadata", execution)).responseMetadata, metadata);
  await assert.rejects(f.request("group.external.metadata", { ...execution, runId: crypto.randomUUID() }));
  await assert.rejects(f.request("group.external.metadata", execution, { ...f.authority, ownerId: crypto.randomUUID() }));
  assert.equal(f.starts.length, 1, "metadata never resubmits the prompt");
});

test("stopping one group fences its whole queue across restart and releases only confirmed execution occupancy", async t => {
  const f = await fixture(t), active = await f.prepare(), queued = await f.prepare();
  const adapter = f.host.runner.adapters.hermes;
  const cancel = adapter.cancel;
  adapter.cancel = async () => ({ status: "unknown" });
  const other = { ...f.authority, groupId: crypto.randomUUID() };
  const unrelated = await f.prepare({ owner: other });
  assert.equal(f.starts.length, 1);
  await f.request("host.group.stop", {});
  assert.equal((await f.request("host.execution", queued.execution)).snapshot.status, "canceled");
  assert.equal(f.starts.length, 1, "an unconfirmed running execution still holds the workspace");
  await assert.rejects(f.request("group.external.start", { ...queued.execution, prompt: `执行。groupToken="${queued.grant}"`,
    operationId: `start-${queued.execution.executionId}` }), e => e.code === "GROUP_HOST_GROUP_STOPPED");
  adapter.cancel = cancel;
  await f.request("group.external.cancel", { ...active.execution, operationId: "delete-owned" });
  for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); await f.request("host.execution", unrelated.execution, other); }
  assert.deepEqual(f.starts.map(run => run.runId), [active.execution.runId, unrelated.execution.runId]);
  assert.equal(f.runs.get(unrelated.execution.runId).status, "running", "another group's run is not cancelled");
  await f.restart();
  await assert.rejects(f.prepare({ owner: { ...f.authority, epoch: 2 } }), e => e.code === "GROUP_HOST_GROUP_STOPPED");
  assert.equal((await f.request("host.execution", unrelated.execution, other)).snapshot.status, "running");
});

test("Service deletion waits for the scoped Router and Host proof while another group's queued run proceeds once", async t => {
  const f = await fixture(t);
  const store = new GroupChatStore({ paths: { stateDir: path.join(f.root, "deletion-service"), trustedRoot: f.root } }).open();
  const router = new GroupRuntimeRouter({ allowRemote: true, localRunner: {}, getPeers: () => [f.peer] });
  const client = { request: (method, params) => router[method.split('.').at(-1)](params) };
  let driver;
  const external = new GroupExternalExecutor({ store, getClient: () => client, pollMs: 10,
    onTerminal: (id, result) => driver.onExternalTerminal(id, result) });
  driver = new GroupChatDriver({ store, executor: { findRun() { return null; }, getRun() { return null; } },
    externalExecutor: external, reconcileMs: 20 });
  f.cleanups.push(() => { driver.stop(); store.close(); });
  const create = name => {
    const { groupId } = store.createGroup({ operationId: name, name, purpose: "", members: [
      { ...f.agent, peerId: f.peer.id, profileId: null, displayName: "Helper" },
      { backendId: "shoggoth", agentId: "native", profileId: "native", displayName: "Native" },
    ] });
    return { groupId, member: store.getGroup(groupId).members[0] };
  };
  const a = create("delete"), b = create("keep");
  const wait = async check => { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error("deletion fixture timeout"); };
  await driver.start();
  const send = group => { store.appendUserMessage({ groupId: group.groupId, clientMessageId: group.groupId,
    body: "reply", mentionMemberIds: [group.member.id] }); driver.wake(group.groupId); };
  send(a); await wait(() => f.starts.length === 1);
  send(b); await wait(() => store.getGroup(b.groupId).activeTurns[0]?.dispatchState === "queued");
  f.runs.get(f.starts[0].runId).status = "unknown";
  await wait(() => store.getGroup(b.groupId).activeTurns[0]?.queueReason === "execution_unconfirmed");
  const service = new GroupChatService({ store, driver });
  const result = await service.handle("group.delete", { groupId: a.groupId, expectedMetadataRevision: 1 });
  assert.equal(result.status, "deleting");
  await wait(() => store.groupLifecycle(a.groupId) === "deleted" && f.starts.length === 2);
  assert.equal(f.runs.get(f.starts[0].runId).status, "canceled");
  assert.equal(f.runs.get(f.starts[1].runId).status, "running");
  assert.equal(store.groupLifecycle(b.groupId), "active");
  assert.equal(store.getGroup(b.groupId).activeTurns[0].stopping, false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id=?").get(a.groupId).n, 0);
});

test("legacy deletion rechecks only the original dedicated session under the current App generation without starting a turn", async () => {
  const seen = [];
  const runner = new ExternalInspirationRunner({ registry: { getBackend: () => ({}) }, adapterOptions: { sessionPurpose: "group" },
    adapters: { hermes: { cancel(input, options) { seen.push({ input, options }); return { status: "canceled" }; } } } });
  const router = new GroupRuntimeRouter({ localRunner: runner });
  const input = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), backendId: "hermes", agentId: "helper",
    sessionKey: "agent:helper:legacy-group", workspace: "/fixture", mode: "gateway", hostId: crypto.randomUUID(),
    operationId: "delete-legacy", stopGroup: true };
  const result = await router.cancel(input);
  assert.equal(result.groupStopped, true);
  assert.equal(result.snapshot.status, "canceled");
  assert.equal(require("../app/federation-host-protocol").validateFederationResult("group.external.cancel", result, input), true);
  assert.equal(seen.length, 1); assert.equal(seen[0].input.sessionKey, input.sessionKey);
  assert.equal(seen[0].input.runId, input.runId); assert.equal(seen[0].options.groupDeleted, true);
});

test("paired host model catalog checks Agent identity and model errors cross HTTP without raw details", async t => {
  const f = await fixture(t);
  const router = new GroupRuntimeRouter({ allowRemote: true, localRunner: {}, getPeers: () => [f.peer] });
  assert.equal((await router.models({ ...f.agent, peerId: f.peer.id })).models[0].id, "chosen");
  await assert.rejects(f.request("host.models", { ...f.agent, agentId: "other" }), error => error.code === "GROUP_HOST_AGENT_INVALID");
  const execution = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), ...f.agent,
    sessionKey: null, workspace: null, operationId: "gone", modelSelection: { model: "gone", provider: "custom" } };
  await assert.rejects(f.request("host.prepare", { execution, kind: "turn", taskId: null }),
    error => error.code === "GROUP_CHAT_MODEL_UNAVAILABLE" && !error.message.includes("raw details"));
  assert.equal(f.starts.length, 0);
});

function receipts(t, f) {
  const store = new GroupChatStore({ paths: { stateDir: path.join(f.root, "service"), trustedRoot: f.root } }).open();
  f.cleanups.push(() => store.close());
  const { groupId } = store.createGroup({ operationId: "receipts", name: "old group", purpose: "", members: [
    { ...f.agent, profileId: null, displayName: "Helper" },
    { backendId: "openclaw", agentId: "main", profileId: null, displayName: "Main" },
  ] });
  const authority = { groupId, ownerId: store.getRemoteOwnerId(), epoch: store.advanceDriverFence() };
  const service = new GroupChatService({ store, driver: {} });
  const read = async query => {
    const params = validateParams("group.execution.receipt", query);
    const result = await service.handle("group.execution.receipt", params);
    validateResult("group.execution.receipt", result, params); return result;
  };
  const record = run => {
    const member = store.getGroup(groupId).members[0];
    store.appendUserMessage({ groupId, clientMessageId: crypto.randomUUID(), body: "test", mentionMemberIds: [member.id] });
    const claim = store.claimNext(groupId, authority.epoch);
    const external = { ...run.execution, remote: { peerId: "local-fixture", hostId: f.host.hostId, ...authority } };
    store.bindSession({ groupId, memberId: member.id, sessionKey: external.sessionKey });
    store.recordRun({ opportunityId: claim.opportunity.id, runId: external.runId, sessionKey: external.sessionKey,
      runKind: "external", external, fence: authority.epoch });
    return claim.opportunity.id;
  };
  const finish = (id, status) => {
    const turn = store.getOpportunity(id);
    store.recordExecutionObservation({ kind: "turn", id, runId: turn.runId, hostId: turn.external.hostId,
      status, sequence: 5, fence: authority.epoch });
    store.completeTurn({ opportunityId: id, fence: authority.epoch, status, text: "original answer" });
  };
  return { store, authority, read, record, finish };
}

function forgetHostTerminal(f, run) {
  const record = JSON.parse(f.host.db.prepare("SELECT data FROM executions WHERE id=?").get(run.execution.executionId).data);
  record.snapshot = { ...record.identity, ...record.binding, status: "unknown", sequence: 1,
    errorCode: "EXTERNAL_EXECUTION_UNCONFIRMED", resultSummary: null, attention: null, finishedAt: null };
  f.host.db.prepare("UPDATE executions SET data=? WHERE id=?").run(JSON.stringify(record), run.execution.executionId);
}

for (const status of ["completed", "canceled"]) {
  test(`a persisted Service ${status} receipt repairs old Host corruption and wakes another group's original queue once`, async t => {
    const f = await fixture(t), service = receipts(t, f), old = await f.prepare({ owner: service.authority });
    const id = service.record(old); service.finish(id, status);
    forgetHostTerminal(f, old); await f.restart(); f.runs.clear();
    const waiting = await f.prepare();
    assert.equal(waiting.started.snapshot.dispatchState, "queued");
    assert.equal(f.starts.length, 1);
    f.host.readTerminalReceipt = service.read;
    for (let i = 0; i < 3; i++) await f.request("host.execution", waiting.execution);
    assert.equal((await f.request("host.execution", old.execution, service.authority)).snapshot.status, status);
    assert.equal((await f.request("host.execution", waiting.execution)).snapshot.status, "running");
    assert.deepEqual(f.starts.map(run => run.runId), [old.execution.runId, waiting.execution.runId]);
    await f.restart(); f.host.readTerminalReceipt = async () => { throw new Error("Service unavailable"); };
    assert.equal((await f.request("host.execution", old.execution, service.authority)).snapshot.status, status);
    assert.equal(f.starts.length, 2);
  });
}

test("Service terminal receipts reject unfinished runs, cancel intent and every foreign binding", async t => {
  const f = await fixture(t), service = receipts(t, f), run = await f.prepare({ owner: service.authority });
  const id = service.record(run), query = { groupId: service.authority.groupId, ownerId: service.authority.ownerId,
    hostId: f.host.hostId, execution: run.execution };
  assert.equal((await service.read(query)).receipt, null);
  service.store.markReconciliation({ kind: "turn", id, runId: run.execution.runId,
    reason: "GROUP_DISCUSSION_STOPPED", cancelRequested: true, fence: service.authority.epoch });
  assert.equal((await service.read(query)).receipt, null);
  service.finish(id, "canceled");
  assert.equal((await service.read(query)).receipt.snapshot.status, "canceled");
  for (const field of ["groupId", "ownerId", "hostId"]) {
    assert.equal((await service.read({ ...query, [field]: crypto.randomUUID() })).receipt, null, field);
  }
  for (const [field, value] of Object.entries({ executionId: crypto.randomUUID(), runId: crypto.randomUUID(),
    agentId: "other", sessionKey: "another-session", workspace: "/another-workspace", mode: "acp" })) {
    assert.equal((await service.read({ ...query, execution: { ...query.execution, [field]: value } })).receipt, null, field);
  }
  assert.equal((await service.read({ ...query, execution: { ...query.execution, backendId: "openclaw", mode: "openclaw" } })).receipt, null);
  assert.ok((await service.read({ ...query, execution: { ...query.execution, hostId: crypto.randomUUID() } })).receipt,
    "the transient Runner generation can change");
  const proof = await service.read(query);
  assert.throws(() => validateResult("group.execution.receipt", { receipt: { ...proof.receipt,
    snapshot: { ...proof.receipt.snapshot, sessionKey: "wrong" } } }, query), { code: "GROUP_CHAT_UNAVAILABLE" });
});

test("missing, foreign or late Service proof keeps an uncertain workspace occupied", async t => {
  const f = await fixture(t), service = receipts(t, f), old = await f.prepare({ owner: service.authority });
  service.finish(service.record(old), "completed");
  forgetHostTerminal(f, old); await f.restart(); f.runs.clear();
  const next = await f.prepare();
  for (const read of [async () => ({ receipt: null }), () => { throw new Error("offline"); }, async query => {
    const result = await service.read(query); result.receipt.snapshot.workspace = "/foreign"; return result;
  }]) {
    f.host.readTerminalReceipt = read; f.advance(10_001);
    await f.request("host.execution", next.execution);
    assert.equal(f.starts.length, 1);
  }
  let release;
  f.host.readTerminalReceipt = async query => { const result = await service.read(query);
    await new Promise(resolve => { release = resolve; }); return result; };
  f.advance(10_001);
  const pending = f.request("host.execution", next.execution);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const changed = { ownerId: crypto.randomUUID(), epoch: service.authority.epoch + 1 };
  await f.request("host.authority.transfer", changed, service.authority);
  release(); await pending;
  assert.equal(f.starts.length, 1, "a receipt cannot cross an ownership transfer");
  assert.equal(JSON.parse(f.host.db.prepare("SELECT data FROM executions WHERE id=?").get(old.execution.executionId).data).snapshot.status, "unknown");
});

test("preparation alone is not proof of an accepted Host queue", async t => {
  const f = await fixture(t), identity = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), ...f.agent };
  const prepared = await f.request("host.prepare", { kind: "turn", taskId: null,
    execution: { ...identity, sessionKey: null, workspace: null, operationId: "prepare-only" } });
  const state = await f.request("host.execution", { ...identity, ...prepared.binding, hostId: prepared.hostId });
  assert.equal(state.snapshot.status, "queued");
  assert.equal(state.snapshot.dispatchState, undefined);
  assert.equal(f.starts.length, 0);
});

test("paired HTTP host pins identity, separates runtime/control credentials and confirms the real MCP handshake", async t => {
  const f = await fixture(t);
  const before = await f.request("host.capabilities", f.agent);
  assert.equal(before.groupTools, false);
  const helper = createGroupRuntimeMcpHandler({ connection: f.connection() });
  const init = await helper.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.ok(init.result);
  assert.equal((await f.request("host.capabilities", f.agent)).groupTools, true);
  const tools = await helper.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(tools.result.tools.map(tool => tool.name), ["group_member_role_read", "group_messages_read", "group_task", "group_collaborate"]);
  await assert.rejects(requestGroupHost({ ...f.peer, token: f.runtimeToken }, "host.capabilities", f.agent), error => error.code === "GROUP_HOST_AUTH_FAILED");
  await assert.rejects(requestGroupHost({ ...f.peer, hostId: crypto.randomUUID() }, "host.capabilities", f.agent), error => error.code === "GROUP_HOST_IDENTITY_MISMATCH");
  assert.throws(() => p.normalizePeers([{ ...f.peer, baseUrl: "http://example.test/" }]), error => error.code === "GROUP_HOST_CONFIG_INVALID");
  await assert.rejects(f.host.listen({ host: "0.0.0.0" }), error => error.code === "GROUP_HOST_LISTEN_INVALID");
});

for (const status of ["completed", "canceled"]) for (const read of ["host.execution", "group.external.result"]) {
  test(`uncached progress after restart preserves ${status} through ${read} and releases another group`, async t => {
    const f = await fixture(t), run = await f.prepare();
    const runtime = f.runs.get(run.execution.runId); runtime.status = status; runtime.text = status === "completed" ? "done" : "";
    runtime.progress = null;
    const terminal = await f.request("host.execution", run.execution);
    assert.equal(terminal.snapshot.status, status);
    f.host.runner.onSnapshot(run.execution, { ...terminal.snapshot, status: "unknown", sequence: 1, finishedAt: null });
    assert.equal((await f.request("host.execution", run.execution)).snapshot.status, status, "late transport observations cannot replace durable terminal proof");
    await f.restart(); f.runs.clear();
    await f.request(read, read === "host.execution" ? run.execution : { ...run.execution, part: "progress", offset: 0, digest: null });
    assert.equal((await f.request("host.execution", run.execution)).snapshot.status, status);
    const other = { ...f.authority, groupId: crypto.randomUUID() };
    const next = await f.prepare({ owner: other });
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setImmediate(resolve));
      await f.request("group.external.get", next.execution, other);
    }
    assert.equal((await f.request("host.execution", next.execution, other)).snapshot.status, "running");
    assert.equal(f.starts.length, 2);
    assert.equal(f.starts[1].runId, next.execution.runId);
  });
}

test("dispatch intent and completed full answers survive host restart without replaying the model", async t => {
  const f = await fixture(t);
  const run = await f.prepare();
  await f.request("group.external.start", { ...run.execution, prompt: `执行。groupToken="${run.grant}"`, operationId: `start-${run.execution.executionId}` });
  assert.equal(f.starts.length, 1);
  const hostId = f.host.hostId;
  await f.restart(); assert.equal(f.host.hostId, hostId);
  const live = await f.request("group.external.get", run.execution);
  assert.equal(live.snapshot.status, "running"); assert.equal(f.starts.length, 1);
  const runtime = f.runs.get(run.execution.runId); runtime.status = "completed"; runtime.text = "完整跨设备答复🙂\n".repeat(2500) + "答案末尾";
  runtime.progress = "第一段分工\n\n第二段核实进展";
  const done = await f.request("group.external.get", run.execution);
  assert.equal(done.snapshot.status, "completed");
  await f.restart();
  let offset = 0, digest = null, text = "";
  do {
    const { page } = await f.request("group.external.result", { ...run.execution, offset, digest });
    assert.equal(page.offset, offset); digest = page.digest; offset = page.nextOffset; text += page.text;
  } while (offset !== null);
  assert.equal(text, runtime.text); assert.equal(f.starts.length, 1);
  assert.equal((await f.request("group.external.result", { ...run.execution, part: "progress", offset: 0, digest: null })).page.text, runtime.progress);
  await assert.rejects(f.request("group.external.start", { ...run.execution, prompt: "不能重跑不同要求", operationId: "new" }),
    error => error.code === "GROUP_HOST_OPERATION_CONFLICT");
});

test("lease renewal fences old writers and explicit authority transfer keeps the same execution", async t => {
  const f = await fixture(t), run = await f.prepare();
  const owner2 = { ...f.authority, epoch: 2 };
  await f.request("group.external.get", run.execution, owner2);
  await assert.rejects(f.request("group.external.cancel", { ...run.execution, operationId: "old-cancel" }), error => error.code === "GROUP_HOST_OWNER_CHANGED");
  f.advance(30_001);
  await assert.rejects(f.host.runtimeCall({ agentId: f.agent.agentId, callId: "expired", name: "group_messages_read", arguments: { groupToken: run.grant } }),
    error => error.code === "GROUP_HOST_LEASE_EXPIRED");
  await f.request("group.external.get", run.execution, owner2);
  const owner3 = { ...owner2, ownerId: crypto.randomUUID(), epoch: 3 };
  await f.request("host.authority.transfer", { ownerId: owner3.ownerId, epoch: owner3.epoch }, owner2);
  await assert.rejects(f.request("group.external.get", run.execution, owner2), error => error.code === "GROUP_HOST_OWNER_CHANGED");
  assert.equal((await f.request("group.external.get", run.execution, owner3)).snapshot.runId, run.execution.runId);
  assert.equal(f.starts.length, 1);
});

test("remote MCP calls retain a durable id across partition and are refused after cancellation", async t => {
  const f = await fixture(t), run = await f.prepare();
  const args = { groupToken: run.grant, afterSeq: 0 };
  const pending = runtimeRequest(f.connection(), { agentId: f.agent.agentId, callId: "read-1", name: "group_messages_read", arguments: args });
  await new Promise(resolve => setTimeout(resolve, 30));
  const first = (await f.request("host.tools.next", {})).calls[0];
  assert.ok(first); assert.equal(first.arguments.groupToken, run.grant);
  const repeated = (await f.request("host.tools.next", {})).calls[0];
  assert.equal(repeated.callId, first.callId);
  const result = { ok: true, messages: [{ seq: 1, body: "同一群" }] };
  await f.request("host.tools.result", { callId: first.callId, fingerprint: first.fingerprint, result });
  assert.deepEqual(await pending, result);
  assert.deepEqual(await runtimeRequest(f.connection(), { agentId: f.agent.agentId, callId: "read-1", name: "group_messages_read", arguments: args }), result);
  await assert.rejects(f.request("host.tools.result", { callId: first.callId, fingerprint: first.fingerprint, result: { ok: false } }),
    error => error.code === "GROUP_HOST_OPERATION_CONFLICT");
  await f.request("group.external.cancel", { ...run.execution, operationId: "cancel" });
  await assert.rejects(runtimeRequest(f.connection(), { agentId: f.agent.agentId, callId: "new", name: "group_messages_read", arguments: args }),
    error => error.code === "GROUP_HOST_GRANT_REVOKED");
});

test("artifacts are saved by the execution host, fully hashed across pages and never replaced by changed files", async t => {
  const f = await fixture(t), run = await f.prepare({ kind: "task", taskId: crypto.randomUUID() });
  const text = "远端交付🙂\n".repeat(4000); fs.writeFileSync(path.join(f.workspace, "output.txt"), text);
  const external = { ...run.execution, remote: { peerId: f.peer.id, hostId: f.peer.hostId, ...f.authority } };
  const router = new GroupRuntimeRouter({ allowRemote: true, localRunner: {}, getPeers: () => [f.peer] });
  const store = { getRemoteOwnerId: () => f.authority.ownerId, getDriverFence: () => f.authority.epoch };
  const broker = new GroupExternalArtifacts({ store, getClient: () => ({ request: (_method, params) => router.artifact(params) }) });
  const root = { external, groupId: f.authority.groupId }, artifact = await broker.resolve(root, "output.txt");
  assert.equal(artifact.bytes, Buffer.byteLength(text));
  fs.writeFileSync(path.join(f.workspace, "output.txt"), "后来修改的版本");
  assert.deepEqual(await broker.preview(root, artifact), { text, truncated: false, changed: false });
  await f.restart();
  assert.equal((await broker.preview(root, artifact)).text, text);
  await assert.rejects(router.artifact({ execution: external, path: "../outside", digest: null, offset: 0 }), error => error.code === "GROUP_HOST_ARTIFACT_INVALID");
  await assert.rejects(router.artifact({ execution: { ...external, remote: { ...external.remote, hostId: crypto.randomUUID() } }, path: "output.txt", digest: null, offset: 0 }),
    error => error.code === "GROUP_HOST_IDENTITY_MISMATCH");
  assert.equal(await broker.resolve({ ...root, groupId: crypto.randomUUID() }, "output.txt"), null);
  const corrupted = new GroupExternalArtifacts({ store, getClient: () => ({ request: async (_method, input) => {
    const value = await router.artifact(input); value.artifact.content = Buffer.from("corrupt").toString("base64"); return value;
  } }) });
  assert.equal(await corrupted.preview(root, artifact), null);
});

test("Hermes tasks in the same Git project use independent host worktrees and preserve sealed output after removal", async t => {
  const f = await fixture(t, { git: true });
  const a = await f.prepare({ kind: "task", taskId: crypto.randomUUID() }), b = await f.prepare({ kind: "task", taskId: crypto.randomUUID() });
  assert.notEqual(a.execution.workspace, b.execution.workspace); assert.notEqual(a.execution.workspace, f.workspace);
  assert.equal(f.starts.length, 2);
  f.host.runner.onSnapshot(a.execution, { ...a.started.snapshot, workspace: b.execution.workspace,
    status: "completed", sequence: 10, finishedAt: 10_000 });
  assert.equal(f.host.sealing.size, 0, "a foreign binding cannot seal or remove this task's workspace");
  assert.equal((await f.request("host.execution", a.execution)).snapshot.status, "running");
  fs.writeFileSync(path.join(a.execution.workspace, "result.txt"), "A"); fs.writeFileSync(path.join(b.execution.workspace, "result.txt"), "B");
  const first = f.runs.get(a.execution.runId); first.status = "completed"; first.text = "A done";
  const done = await f.request("host.execution", a.execution);
  assert.equal(done.isolation.sealed, true); assert.equal(done.isolation.committed, true);
  assert.equal(fs.existsSync(a.execution.workspace), false);
  const file = await f.request("host.artifact", { execution: a.execution, path: "result.txt", digest: null, offset: 0 });
  assert.equal(Buffer.from(file.artifact.content, "base64").toString(), "A");
  assert.equal(fs.readFileSync(path.join(b.execution.workspace, "result.txt"), "utf8"), "B");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: f.workspace, encoding: "utf8" }).trim(), "");
});

test("managed adapter channel uses its private backend credential, exact member identity and expiring readiness", async () => {
  let clock = 1;
  const calls = [];
  const channel = new GroupAdapterChannel({ paths: {}, now: () => clock, authorize: (_paths, backend, value) => backend === "hermes" && value === "credential",
    service: { callBoundExternalTool: (...args) => { calls.push(args); return { ok: true }; } } });
  await assert.rejects(channel.handle("group.adapter.register", { backendId: "hermes", credentialToken: "wrong", agentId: "hermes-default", instanceId: "instance" }),
    error => error.code === "GROUP_HOST_AUTH_FAILED");
  await channel.handle("group.adapter.register", { backendId: "hermes", credentialToken: "credential", agentId: "hermes-default", instanceId: "instance" });
  assert.equal(channel.available({ backendId: "hermes", agentId: "hermes-default" }), true);
  assert.equal(channel.available({ backendId: "hermes", agentId: "other" }), false);
  const args = { groupToken: groupToken("t") };
  await channel.handle("group.adapter.call", { backendId: "hermes", credentialToken: "credential", agentId: "hermes-default", callId: "call", name: "group_messages_read", arguments: args });
  assert.deepEqual(calls[0].slice(2), ["call", { backendId: "hermes", agentId: "hermes-default" }]);
  clock += 150_001; assert.equal(channel.available({ backendId: "hermes", agentId: "hermes-default" }), false);
});


test("paired members with identical runtime ids remain distinct, and role pages keep a fixed digest through source changes and restart", async t => {
  const f = await fixture(t);
  const router = new GroupRuntimeRouter({ allowRemote: true, localRunner: {}, getPeers: () => [f.peer] });
  const ref = { peerId: f.peer.id, ...f.agent };
  const member = await router.member(ref);
  assert.equal(member.agent.name, "Remote helper");
  assert.deepEqual((await router.members()).members.map(value => value.peerId), [f.peer.id]);
  let text = "", offset = 0;
  do {
    const { page } = await router.role({ ...ref, offset, digest: member.document.digest });
    text += page.text; offset = page.nextOffset;
  } while (offset !== null);
  const doc = JSON.parse(text);
  assert.equal(doc.identity, null); assert.match(doc.soul, /远端角色原文/u);
  await f.restart();
  const first = await router.role({ ...ref, offset: 0, digest: member.document.digest });
  assert.equal(first.page.digest, member.document.digest);
  const wrong = { ...ref, peerId: "not-paired" };
  await assert.rejects(router.member(wrong), error => error.code === "GROUP_HOST_IDENTITY_MISMATCH");
});


test("non-isolated executions share the actual host resource lock and start once after the first terminal receipt", async t => {
  const f = await fixture(t);
  const a = await f.prepare({ kind: "task", taskId: crypto.randomUUID() }), b = await f.prepare({ kind: "task", taskId: crypto.randomUUID() });
  assert.equal(a.prepared.resource.key, b.prepared.resource.key);
  assert.equal(a.prepared.resource.isolation, false);
  assert.equal(f.starts.length, 1); assert.equal(b.started.snapshot.status, "queued");
  const first = f.runs.get(a.execution.runId); first.status = "completed"; first.text = "first done";
  await f.request("host.execution", a.execution);
  await f.request("host.execution", b.execution);
  assert.equal(f.starts.length, 2); assert.equal(f.starts[1].executionId, b.execution.executionId);
});

test("loopback filesystem proof rejects tunnels, foreign users and unrecognized listeners", async () => {
  const { verifyLocalGroupRuntime } = require("../app/group-local-runtime-proof");
  let command = "node /opt/openclaw/dist/index.js gateway run", listing = "p101\nu501\n";
  const execute = async program => program === "lsof" ? listing : command;
  const input = { backendId: "openclaw", url: "ws://127.0.0.1:18792" };
  assert.equal(await verifyLocalGroupRuntime(input, { execute, uid: 501 }), true);
  command = "ssh -L 18792:remote:18792 host";
  assert.equal(await verifyLocalGroupRuntime(input, { execute, uid: 501 }), false);
  command = "openclaw-gateway"; listing = "p101\nu502\n";
  assert.equal(await verifyLocalGroupRuntime(input, { execute, uid: 501 }), false);
  assert.equal(await verifyLocalGroupRuntime({ ...input, url: "wss://remote.example/" }, { execute, uid: 501 }), false);
  assert.equal(await verifyLocalGroupRuntime(input, { execute: async () => { throw new Error("unavailable"); }, uid: 501 }), false);
});


test("the real Hermes backend binds a fresh group session's worktree through the scoped cwd RPC and refuses active or replaced sessions", async () => {
  const { HermesBackend } = require("../app/core/hermes-backend");
  const backend = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  const session = "agent:hermes-default:stored-group", dash = { profile: "default", baseUrl: "http://127.0.0.1:9999" }, calls = [];
  backend.profileById.set("hermes-default", "default"); backend.dashboards.set("default", dash);
  backend.gwRuntimeByKey.set(session, { runtimeId: "runtime-group", storedId: "stored-group", profile: "default" });
  backend.freshSessionKeys.add(session); backend.freshSessionTransports.set(session, "gateway");
  backend._gwSocket = () => ({ request: async (method, params) => { calls.push({ method, params }); return { cwd: params.cwd }; } });
  await backend._setPreparedGroupWorkspace(session, "/private/task-worktree");
  assert.deepEqual(calls, [{ method: "session.cwd.set", params: { session_id: "runtime-group", cwd: "/private/task-worktree" } }]);
  assert.equal(backend.sessionWorkspaceByKey.get(session), "/private/task-worktree");
  backend.gwTurns.set("runtime-group", {});
  await assert.rejects(backend._setPreparedGroupWorkspace(session, "/another-worktree"), error => error.code === "HERMES_INSPIRATION_WORKSPACE_UNCONFIRMED");
  assert.equal(calls.length, 1);
  backend.gwTurns.delete("runtime-group");
  backend.sendQueues.set(session, Promise.resolve());
  await assert.rejects(backend._setPreparedGroupWorkspace(session, "/queued-worktree"), error => error.code === "HERMES_INSPIRATION_WORKSPACE_UNCONFIRMED");
  assert.equal(calls.length, 1);
  backend.sendQueues.delete(session);
  let release;
  backend._gwSocket = () => ({ request: () => new Promise(resolve => { release = resolve; }) });
  const pending = backend._setPreparedGroupWorkspace(session, "/late-worktree");
  backend._lifecycleGeneration++; release({ cwd: "/late-worktree" });
  await assert.rejects(pending, error => error.code === "HERMES_INSPIRATION_WORKSPACE_UNCONFIRMED");
  assert.equal(backend.sessionWorkspaceByKey.get(session), "/private/task-worktree");
});


test("remote connections stay disabled by default even if a paired host is present in configuration", async () => {
  let called = 0;
  const router = new GroupRuntimeRouter({ localRunner: {}, getPeers: () => [{ id: "configured" }], request: async () => { called++; } });
  assert.deepEqual(await router.members(), { members: [] });
  await assert.rejects(router.testPeer({}), error => error.code === "GROUP_HOST_REMOTE_DISABLED");
  await assert.rejects(router.member({ backendId: "hermes", agentId: "helper", peerId: "configured" }), error => error.code === "GROUP_HOST_REMOTE_DISABLED");
  assert.equal(called, 0);
});
