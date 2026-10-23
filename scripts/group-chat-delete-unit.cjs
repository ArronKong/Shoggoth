"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupChatService } = require("../app/agent-service/group-chat-service");
const { GroupChatDriver } = require("../app/agent-service/group-chat-driver");
const { validateParams } = require("../app/agent-service/group-chat-protocol");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-delete-")));
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  const open = () => new GroupChatStore({ paths }).open();
  let store = open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const create = (name, members = [
    { backendId: "shoggoth", agentId: "alpha", profileId: "p-alpha", displayName: "Alpha" },
    { backendId: "shoggoth", agentId: "beta", profileId: "p-beta", displayName: "Beta" },
  ]) => store.createGroup({ operationId: name, name, purpose: "", members }).groupId;
  const send = (groupId, key) => store.appendUserMessage({ groupId, clientMessageId: key, body: key, mentionMemberIds: [] });
  return { get store() { return store; }, create, send,
    reopen() { store.close(); store = open(); return store; } };
}

test("delete seals only its group and atomically cancels queued and running turns", t => {
  const f = fixture(t), deleted = f.create("deleted"), other = f.create("other");
  f.send(deleted, "delete request"); f.send(other, "keep request");
  const fence = f.store.advanceDriverFence();
  const turn = f.store.claimNext(deleted, fence).opportunity;
  f.store.recordRun({ opportunityId: turn.id, runId: "original-run", sessionKey: "original-session", fence });
  const before = JSON.stringify(f.store.getGroup(other));
  const result = f.store.deleteGroup({ groupId: deleted, expectedMetadataRevision: 1 });
  assert.equal(result.status, "deleting");
  assert.equal(f.store.getGroup(deleted).group.status, "deleting");
  assert.equal(f.store.getOpportunity(turn.id).abortReason, "GROUP_DELETED");
  assert.equal(f.store.getGroup(deleted).queuedMemberIds.length, 0);
  assert.equal(JSON.stringify(f.store.getGroup(other)), before, "another group's state is unchanged");
  assert.throws(() => f.send(deleted, "late input"), e => e.code === "GROUP_CHAT_DELETED");
  assert.equal(f.store.claimNext(deleted, fence), null);
  assert.equal(f.store.deleteGroup({ groupId: deleted, expectedMetadataRevision: 1 }).status, "deleting", "retry is idempotent");
  assert.equal(f.store.finishGroupDeletion(deleted).status, "deleting", "unknown execution holds deletion open");
  f.store.completeTurn({ opportunityId: turn.id, fence, status: "completed", text: "late result must not publish" });
  assert.equal(f.store.getOpportunity(turn.id).state, "cancelled");
  assert.equal(f.store.listMessages({ groupId: deleted }).messages.some(m => m.body.includes("late result")), false);
  assert.equal(f.store.finishGroupDeletion(deleted).status, "deleted");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id=?").get(deleted).n, 0, "conversation content is deleted after stopping");
  assert.equal(f.store.listGroups({ includeArchived: true }).some(g => g.group.id === deleted), false);
  assert.equal(f.store.queryAgentGroups({ includeArchived: true }).groups.some(g => g.group.id === deleted), false);
  assert.throws(() => f.store.updateGroup({ groupId: deleted, expectedMetadataRevision: 2, patch: { status: "active" } }),
    e => e.code === "GROUP_CHAT_DELETED");
});

test("deletion with no active execution completes and survives restart without reviving queues", t => {
  const f = fixture(t), id = f.create("empty"); f.send(id, "queued only");
  assert.throws(() => f.store.deleteGroup({ groupId: id, expectedMetadataRevision: 99 }), e => e.code === "GROUP_CHAT_REVISION_CONFLICT");
  assert.equal(f.store.groupLifecycle(id), "active");
  assert.equal(f.store.deleteGroup({ groupId: id, expectedMetadataRevision: 1 }).status, "deleting");
  assert.equal(f.store.finishGroupDeletion(id).status, "deleted");
  f.reopen();
  assert.equal(f.store.groupLifecycle(id), "deleted");
  assert.deepEqual(f.store.groupsWithQueuedTurns(), []);
  assert.equal(f.store.deleteGroup({ groupId: id, expectedMetadataRevision: 1 }).status, "deleted");
});

test("restart converts legacy archives to deletion before it can dispatch their queued turns", async t => {
  const f = fixture(t), id = f.create("legacy"), other = f.create("keep");
  f.send(id, "archived queue");
  f.store.updateGroup({ groupId: id, expectedMetadataRevision: 1, patch: { status: "archived" } });
  f.send(other, "other queue");
  const started = [], driver = new GroupChatDriver({ store: f.store, executor: {
    async ensureSession(binding) { return `session-${binding.memberId}`; },
    async start(input) { started.push(input); return { id: `run-${started.length}`, source: "chat", sourceId: input.sessionKey, status: "running" }; },
    findRun() { return null; }, getRun() { return null; },
  } });
  await driver.start(); t.after(() => driver.stop());
  for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.groupLifecycle(id), "deleted");
  assert.equal(started.length, 1, "only the other group's owner starts");
  assert(started.every(run => f.store.getGroup(other).members.some(member => run.sessionKey.endsWith(member.id))));
});

test("delete RPC checks the exact group revision and retains a pending receipt until stop confirmation", async t => {
  const f = fixture(t), id = f.create("rpc"), aborted = [];
  f.send(id, "running"); const fence = f.store.advanceDriverFence(); const turn = f.store.claimNext(id, fence).opportunity;
  f.store.recordRun({ opportunityId: turn.id, runId: "owned-run", sessionKey: "owned-session", fence });
  const service = new GroupChatService({ store: f.store, driver: {
    async deleteGroup(groupId) { aborted.push(...f.store.runningOpportunities().filter(o => o.groupId === groupId).map(o => o.runId)); },
  } });
  const params = validateParams("group.delete", { groupId: id, expectedMetadataRevision: 1 });
  const result = await service.handle("group.delete", params);
  assert.equal(result.status, "deleting"); assert.deepEqual(aborted, ["owned-run"]);
  assert.equal((await service.handle("group.get", { groupId: id })).group.status, "deleting");
});

test("ended business records still require the complete group's durable Host stop receipt", t => {
  const f = fixture(t), id = f.create("external", [
    { backendId: "hermes", agentId: "helper", profileId: null, displayName: "Helper" },
    { backendId: "shoggoth", agentId: "beta", profileId: "p-beta", displayName: "Beta" },
  ]);
  f.send(id, "old request"); const fence = f.store.advanceDriverFence(), turn = f.store.claimNext(id, fence).opportunity;
  const external = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), backendId: "hermes", agentId: "helper",
    sessionKey: "agent:helper:group-original", workspace: "/fixture", mode: "gateway", hostId: crypto.randomUUID(),
    remote: { peerId: "original-peer", hostId: crypto.randomUUID(), groupId: id, ownerId: f.store.getRemoteOwnerId(), epoch: fence } };
  f.store.recordRun({ opportunityId: turn.id, runId: external.runId, sessionKey: external.sessionKey, runKind: "external", external, fence });
  f.store.completeTurn({ opportunityId: turn.id, fence, status: "failed", errorCode: "OLD_TRANSPORT_FAILURE" });
  f.store.deleteGroup({ groupId: id, expectedMetadataRevision: 1 });
  assert.equal(f.store.finishGroupDeletion(id).status, "deleting");
  assert.equal(f.store.confirmGroupDeletionHosts(id, "wrong-host-set"), false);
  const targets = f.store.groupDeletionTargets(id);
  assert.equal(targets.targets.length, 1);
  assert.equal(targets.targets[0].executionId, external.executionId);
  assert.equal(f.store.confirmGroupDeletionHosts(id, targets.digest), true);
  assert.equal(f.store.finishGroupDeletion(id).status, "deleted");
});

test("deletion during session preparation never starts a late model turn or leaves an empty run occupied", async t => {
  const f = fixture(t), id = f.create("prepare"); let release, starts = 0;
  const member = f.store.getGroup(id).members[0];
  const driver = new GroupChatDriver({ store: f.store, executor: {
    ensureSession() { return new Promise(resolve => { release = resolve; }); },
    async start() { starts++; throw Error("late model turn"); },
    findRun() { return null; }, getRun() { return null; },
  } });
  await driver.start(); t.after(() => driver.stop());
  f.store.appendUserMessage({ groupId: id, clientMessageId: "prepare", body: "answer", mentionMemberIds: [member.id] });
  driver.wake(id);
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert(release); f.store.deleteGroup({ groupId: id, expectedMetadataRevision: 1 }); await driver.deleteGroup(id);
  release("late-session");
  for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 0); assert.equal(f.store.groupLifecycle(id), "deleted");
});
