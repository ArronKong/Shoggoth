"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupChatService } = require("../app/agent-service/group-chat-service");
const { validateParams, validateResult } = require("../app/agent-service/group-chat-protocol");
const { BackendRegistry } = require("../app/core/backend-registry");
const { AgentBackend } = require("../app/core/agent-backend");

const method = "group.artifacts.list";
const params = { sinceMs: 1000, limit: 20, backendIds: ["shoggoth", "hermes"] };
const attachment = name => ({ id: crypto.randomUUID(), name, mimeType: "text/plain", size: 5 });

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dga-")));
  fs.chmodSync(root, 0o700);
  let time = 1000, counter = 0;
  const store = new GroupChatStore({ paths: { stateDir: path.join(root, "state"), trustedRoot: root }, now: () => time }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const makeGroup = () => store.createGroup({ operationId: `create-${++counter}`, name: `成果群 ${counter}`, purpose: "",
    members: ["shoggoth", "hermes"].map(backendId => ({ backendId, agentId: `${backendId}-writer`,
      profileId: backendId === "shoggoth" ? "profile" : null, displayName: `${backendId} Writer` })) }).groupId;
  const groupId = makeGroup(), fence = store.advanceDriverFence();
  const send = (id, attachments = [], memberId = null) => store.appendUserMessage({ groupId: id,
    clientMessageId: `send-${++counter}`, body: "请发文件", mentionMemberIds: memberId ? [memberId] : [], attachments });
  const publish = (files, { id = groupId, backendId = "shoggoth", inputs = [], late = false } = {}) => {
    time += 1;
    const memberId = store.getGroup(id).members.find(member => member.backendId === backendId).id;
    send(id, inputs, memberId);
    const claim = store.claimNext(id, fence);
    assert.equal(claim.member.id, memberId);
    const sessionKey = `session-${memberId}`;
    store.bindSession({ groupId: id, memberId, sessionKey, fence });
    store.recordRun({ opportunityId: claim.opportunity.id, runId: `run-${++counter}`, sessionKey, fence });
    if (late) store.releaseTurn({ opportunityId: claim.opportunity.id, reason: "working", fence });
    return store.completeTurn({ opportunityId: claim.opportunity.id, fence, status: "completed", text: "文件已完成", attachments: files });
  };
  return { store, groupId, makeGroup, send, publish, setTime: value => { time = value; } };
}

test("public member attachments include native/external/late replies and exclude user uploads", t => {
  const f = fixture(t), input = attachment("input.txt"), native = attachment("native.txt"), external = attachment("external.txt");
  f.publish([native], { inputs: [input] });
  f.publish([external], { backendId: "hermes", late: true });
  const result = f.store.listRecentArtifacts(params);
  assert.deepEqual(result.items.map(item => item.attachment.id), [external.id, native.id]);
  assert.deepEqual(result.items.map(item => item.backendId), ["hermes", "shoggoth"]);
  assert.ok(result.items.every(item => item.groupId === f.groupId && item.groupName && item.agentName && item.messageSeq));
  assert.equal(result.truncated, false);
});

test("filter by publication time and enabled backend before deduplication/limit; exclude inactive groups", t => {
  const f = fixture(t), first = attachment("first.txt"), second = attachment("second.txt"), old = attachment("old.txt");
  f.setTime(900); f.publish([old]); f.setTime(1000);
  f.publish([first, second]); f.publish([first]);
  f.publish([attachment("disabled.txt")], { backendId: "hermes" });
  const archived = f.makeGroup(); f.publish([attachment("archived.txt")], { id: archived });
  f.store.updateGroup({ groupId: archived, expectedMetadataRevision: 1, patch: { status: "archived" } });
  const deleting = f.makeGroup(); f.publish([attachment("deleted.txt")], { id: deleting });
  f.store.deleteGroup({ groupId: deleting, expectedMetadataRevision: 1 });
  const query = { ...params, limit: 2, backendIds: ["shoggoth"] };
  const result = f.store.listRecentArtifacts(query);
  assert.deepEqual(result.items.map(item => item.attachment.id), [first.id, second.id]);
  assert.equal(result.truncated, false);
  assert.equal(f.store.listRecentArtifacts({ ...query, limit: 1 }).truncated, true);
  assert.deepEqual(f.store.listRecentArtifacts({ ...params, backendIds: [] }).items, []);
  assert.deepEqual(f.store.listRecentArtifacts({ ...params, sinceMs: 9999 }).items, []);
});

test("metadata-only service read isolates unavailable media and validates the result", async t => {
  const f = fixture(t), good = attachment("saved.txt"), missing = attachment("missing.txt");
  f.publish([good, missing]);
  const reads = [];
  const service = new GroupChatService({ store: f.store, driver: {}, productStore: {}, getMediaStore: () => ({
    assertAvailable: ([item]) => { reads.push(item.id); if (item.id === missing.id) throw Error("missing"); },
    materialize: () => { throw Error("Dashboard must not materialize file bytes"); },
  }) });
  const result = validateResult(method, await service.handle(method, validateParams(method, params)), params);
  assert.deepEqual(result.items.map(item => item.attachment.id), [good.id]);
  assert.equal(result.partial, true);
  assert.equal(reads.length, 2);
  assert.throws(() => validateResult(method, { ...result, items: [{ ...result.items[0], backendId: "disabled" }] }, params));
  assert.throws(() => validateResult(method, { ...result, items: [{ ...result.items[0], createdAt: 0 }] }, params));
  for (const bad of [{ ...params, sinceMs: -1 }, { ...params, limit: 101 }, { ...params, path: "/tmp" },
    { ...params, backendIds: ["shoggoth", "shoggoth"] }]) assert.throws(() => validateParams(method, bad));
});

test("Dashboard reads the shared group owner once with the active scope; owner failure preserves other sections", async () => {
  class Backend extends AgentBackend {
    constructor(id) { super(); this.backendId = id; }
    get id() { return this.backendId; }
    async getStatus() { return { id: this.id, name: this.id, connected: true, info: {} }; }
    async getRecentArtifacts() { return { supported: true, items: [{ path: `/tmp/${this.id}.txt`, mtimeMs: 1001 }] }; }
    async getUsageSeries() { return { totals: { totalTokens: 1, totalCost: 0 }, daily: [] }; }
  }
  const registry = new BackendRegistry();
  registry.register(new Backend("shoggoth")); registry.register(new Backend("hermes"));
  registry.getDashboardActivityData = async () => ({ runs: [], entries: [], degradedSources: [] });
  let disabled = ["hermes"], calls = [];
  registry.setDisabledBackendsProvider(() => disabled);
  const owner = { getRecentGroupArtifacts: async input => {
    calls.push(input);
    return { supported: true, items: input.backendIds.map(backendId => ({ backendId, attachment: attachment(`${backendId}.txt`) })) };
  } };
  registry.setInspirationOwner(owner);
  const first = await registry.getDashboardSummary({ sinceMs: 1000, artifactsLimit: 5 });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], { sinceMs: 1000, limit: 5, backendIds: ["shoggoth"] });
  assert.deepEqual(first.groupArtifacts.items.map(item => item.backendId), ["shoggoth"]);
  disabled = ["shoggoth"];
  const second = await registry.getDashboardSummary({ sinceMs: 1000 });
  assert.deepEqual(second.groupArtifacts.items.map(item => item.backendId), ["hermes"], "group owner is independent of member backend scope");
  owner.getRecentGroupArtifacts = async () => { throw Error("fixture service unavailable"); };
  const failed = await registry.getDashboardSummary({ sinceMs: 1000 });
  assert.equal(failed.groupArtifacts.reason, "unavailable");
  assert.equal(failed.artifacts[0].items[0].path, "/tmp/hermes.txt");
  assert.equal(failed.usage[0].today.totalTokens, 1);
});
