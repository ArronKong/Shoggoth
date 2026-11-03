"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OpenClawInspirationAdapter } = require("../app/core/openclaw-inspiration-adapter");
const { ExternalInspirationRunner } = require("../app/external-inspiration-runner");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { GroupRuntimeHost } = require("../app/group-runtime-host");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupChatDriver } = require("../app/agent-service/group-chat-driver");
const { GroupExternalExecutor } = require("../app/agent-service/group-external-executor");

const SESSION = `agent:main:dashboard:group-${"b".repeat(64)}`;
const TARGET = { agentId: "main", sessionKey: SESSION, runId: "2e4899ea-324f-48d4-a022-56eda0e95a09" };

function fixture({ kind = "archived", abort = { ok: true, aborted: false, runIds: [] } } = {}) {
  const calls = [];
  const backend = {
    hasGatewayMethod: method => !method.startsWith("tasks."),
    _hasGatewayScope: () => true,
    async request(method, params) {
      calls.push({ method, params });
      if (method === "agent.wait") return { runId: params.runId, status: "timeout" };
      if (method === "chat.abort") return abort;
      if (method === "sessions.list") {
        if (kind === "unavailable") throw Object.assign(Error("offline"), { code: "OFFLINE" });
        if (kind === "legacy" && params.archived) throw Object.assign(Error("unsupported filter"), { code: "INVALID_REQUEST" });
        const row = { key: SESSION, agentId: "main", archived: true, hasActiveRun: false };
        if (kind === "active") row.hasActiveRun = true;
        if (kind === "unproven") delete row.hasActiveRun;
        if (kind === "foreign") row.agentId = "other";
        if (kind === "other-session") row.key += "-other";
        if (kind === "unarchived" || kind === "legacy") row.archived = false;
        if (kind === "invalid-archive") row.archived = "true";
        return { sessions: !params.archived && row.archived === true || kind === "absent" ? []
          : kind === "duplicate" ? [row, row] : [row],
        ...(kind === "truncated" ? { truncated: true } : kind === "hasMore" ? { hasMore: true }
          : kind === "nextCursor" ? { nextCursor: "next" } : {}) };
      }
      if (method === "question.list") return { questions: [] };
      if (method === "exec.approval.list") return [];
      throw Error(`Unexpected method: ${method}`);
    },
  };
  const adapter = new OpenClawInspirationAdapter({ backend, sessionPurpose: "group" });
  return { calls, backend, adapter };
}

test("an expired run in an archived inactive group session can finish the original stop after restart", async () => {
  const { adapter, calls } = fixture();
  assert.equal((await adapter.inspect(TARGET)).status, "unknown", "a hidden archived session is not evidence of a running turn");
  const stopped = await adapter.cancel(TARGET);
  assert.equal(stopped.status, "canceled");
  assert.equal(stopped.errorCode, null);
  assert(calls.filter(call => call.method === "sessions.list").every(call => call.params.archived === "all"));
  assert.deepEqual(calls.filter(call => call.method === "chat.abort").map(call => call.params),
    [{ sessionKey: SESSION, runId: TARGET.runId }]);
  assert.equal(calls.some(call => ["agent", "sessions.create", "sessions.patch", "sessions.reset", "sessions.restore"].includes(call.method)), false);
});

test("ordinary group stops retain occupancy without a complete exact inactive archived session", async t => {
  for (const kind of ["active", "unproven", "foreign", "other-session", "unarchived", "invalid-archive",
    "absent", "duplicate", "truncated", "hasMore", "nextCursor", "unavailable", "legacy"]) {
    await t.test(kind, async () => {
      const { adapter, calls } = fixture({ kind });
      assert.notEqual((await adapter.cancel(TARGET)).status, "canceled");
      assert(calls.filter(call => call.method === "chat.abort").every(call => call.params.runId === TARGET.runId
        && call.params.sessionKey === SESSION));
    });
  }
});

test("archived inactivity alone cannot confirm a stop after an uncertain or foreign abort", async t => {
  for (const abort of [{ ok: true }, { ok: false, aborted: false, runIds: [] }, { aborted: false, runIds: [] },
    { ok: true, aborted: false, runIds: ["other-run"] }, { ok: true, aborted: true, runIds: ["other-run"] }]) {
    await t.test(JSON.stringify(abort), async () => {
      const { adapter } = fixture({ abort });
      assert.notEqual((await adapter.cancel(TARGET)).status, "canceled");
    });
  }
});

test("a recovered external runner publishes and retains the archived-session stop without replaying work", async () => {
  const { adapter, backend, calls } = fixture();
  const snapshots = [];
  const runner = new ExternalInspirationRunner({ registry: { getBackend: () => backend },
    adapters: { openclaw: adapter }, adapterOptions: { sessionPurpose: "group" },
    onSnapshot: (_identity, snapshot) => snapshots.push(snapshot) });
  const execution = { executionId: "a1778ee9-c358-49e7-8b28-943e30e2fd4d", runId: TARGET.runId,
    backendId: "openclaw", agentId: "main", sessionKey: SESSION, workspace: "/srv/openclaw/agent", mode: "openclaw",
    hostId: "57bd4b38-c010-4fd4-bc7a-5e95c2784a52" };
  const recovered = await runner.get(execution);
  assert.equal(recovered.snapshot.status, "unknown");
  const input = { ...execution, hostId: recovered.hostId, operationId: "cancel-original-turn" };
  assert.equal((await runner.cancel(input)).snapshot.status, "canceled");
  const count = calls.length;
  assert.equal((await runner.get({ ...execution, hostId: recovered.hostId })).snapshot.status, "canceled");
  assert.equal((await runner.cancel(input)).snapshot.status, "canceled");
  assert.equal(calls.length, count, "terminal reads and repeated cancellation never contact or restart the backend");
  assert.equal(snapshots.at(-1).status, "canceled");
  assert.equal(calls.some(call => call.method === "agent"), false);
});

test("restarting the Host and Service resolves the persisted group stop and preserves its history", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-archived-stop-")));
  fs.chmodSync(root, 0o700);
  const { backend, adapter, calls } = fixture();
  const registry = { getBackend: () => backend };
  const paths = { stateDir: path.join(root, "service"), trustedRoot: root };
  const hostOptions = { paths: { stateDir: path.join(root, "host"), trustedRoot: root }, registry,
    agent: { backendId: "openclaw", agentId: "main" }, ownerToken: "o".repeat(43), runtimeToken: "r".repeat(43) };
  let host, store, driver;
  t.after(async () => { driver?.stop(); await host?.close(); store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  host = new GroupRuntimeHost(hostOptions).open();
  store = new GroupChatStore({ paths }).open();
  host.runner.adapters.openclaw = {
    prepare: async () => ({ sessionKey: SESSION, workspace: root, mode: "openclaw" }),
    start: async () => ({ status: "running" }), inspect: async () => ({ status: "running" }),
  };
  const { groupId } = store.createGroup({ operationId: "create", name: "Archived stop fixture", purpose: "", members: [
    { backendId: "openclaw", agentId: "main", profileId: null, displayName: "Helper" },
    { backendId: "hermes", agentId: "other", profileId: null, displayName: "Other" },
  ] });
  const memberId = store.getGroup(groupId).members[0].id;
  const fence = store.advanceDriverFence();
  const authority = { groupId, ownerId: store.getRemoteOwnerId(), epoch: fence };
  const request = (method, params, owner = authority) => host.dispatch({ version: 2, id: crypto.randomUUID(), hostId: host.hostId,
    method, params, authority: owner });
  store.appendUserMessage({ groupId, clientMessageId: "original-message", body: "@Helper 请继续", mentionMemberIds: [memberId] });
  const claim = store.claimNext(groupId, fence);
  assert.equal(claim.member.id, memberId);
  const identity = { executionId: claim.opportunity.id, runId: crypto.randomUUID(), backendId: "openclaw", agentId: "main" };
  const prepared = await request("host.prepare", { execution: { ...identity, sessionKey: null, workspace: null,
    operationId: "prepare" }, kind: "turn", taskId: null });
  const external = { ...identity, ...prepared.binding, hostId: prepared.hostId,
    remote: { peerId: "local-openclaw-fixture", hostId: host.hostId, ...authority } };
  const { remote, ...execution } = external;
  await request("group.external.start", { ...execution, prompt: "fixture", operationId: "start" });
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request("host.execution", execution)).snapshot.status, "running");
  store.bindSession({ groupId, memberId, sessionKey: SESSION, fence });
  store.recordRun({ opportunityId: identity.executionId, runId: identity.runId, sessionKey: SESSION, runKind: "external", external, fence });
  store.stopDiscussion({ groupId });
  store.markReconciliation({ kind: "turn", id: identity.executionId, runId: identity.runId,
    reason: "GROUP_DISCUSSION_STOPPED", cancelRequested: true, fence });
  const history = store.listMessages({ groupId, limit: 100 }).messages;
  await host.close(); store.close();
  host = new GroupRuntimeHost(hostOptions).open();
  host.runner.adapters.openclaw = adapter;
  store = new GroupChatStore({ paths }).open();
  const timers = [];
  const setTimer = (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; };
  const clearTimer = timer => { timer.cleared = true; };
  const client = { request(method, params) {
    const { remote: owner, ...bound } = params;
    return request(method === "group.external.get" ? "host.execution" : method, bound,
      { groupId: owner.groupId, ownerId: owner.ownerId, epoch: owner.epoch });
  } };
  const externalExecutor = new GroupExternalExecutor({ store, getClient: () => client, setTimer, clearTimer,
    onTerminal: (id, outcome) => driver.onExternalTerminal(id, outcome) });
  driver = new GroupChatDriver({ store, executor: {}, externalExecutor, setTimer, clearTimer });
  await driver.start();
  for (let round = 0; round < 3; round++) {
    await driver.reconcile(identity.executionId);
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(store.getOpportunity(identity.executionId).state, "cancelled");
  assert.deepEqual(store.getGroup(groupId).activeTurns, []);
  assert.deepEqual(store.listMessages({ groupId, limit: 100 }).messages, history);
  assert.equal(calls.some(call => call.method === "agent"), false, "recovery never sends another model turn");
  const persisted = JSON.parse(host.db.prepare("SELECT data FROM executions WHERE id=?").get(identity.executionId).data);
  assert.equal(persisted.snapshot.status, "canceled");
});
