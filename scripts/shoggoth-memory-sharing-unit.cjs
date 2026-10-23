"use strict";

// Cross-Agent shared memory: user/project/workspace facts are read by every
// Agent of the owner, agent-scope facts stay private, and each Agent's own
// forget/revocation still applies to copies held by other Agents.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { AgentDefinitionStore } = require("../app/agent-service/agent-definition-store");
const { MemoryStore } = require("../app/agent-service/memory-store");
const { MemoryEngine, workspaceMemoryRef } = require("../app/agent-service/memory-engine");

const PROFILES = ["agent-a", "agent-b", "agent-c"];
function setup({ shared = true, extraPeers = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-sharing-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  let clock = 1_000, id = 0;
  const now = () => clock++;
  const randomUUID = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const definitions = new AgentDefinitionStore({ paths, now, randomUUID }); definitions.open();
  for (const profileId of PROFILES) definitions.ensureProfile({ profileId });
  const store = new MemoryStore({ paths }); store.open();
  const engine = new MemoryEngine({ store, definitionStore: definitions, now, randomUUID,
    ...(shared ? { sharedProfiles: () => [...PROFILES, ...extraPeers] } : {}) });
  engine.open(PROFILES);
  const save = (profileId, content, scope = "user", extra = {}) => engine.propose({ profileId, content, scope, type: "semantic",
    classification: "explicit", sourceRefs: [`user-edit:${randomUUID()}`], ...extra });
  const search = (profileId, query = "", workspace) => engine.search({ profileId, query, maxSensitivity: "private",
    ...(workspace === undefined ? {} : { workspace }) }).items;
  const userView = (profileId) => definitions.get(profileId).documents.USER;
  const memoryView = (profileId) => definitions.readGeneratedView(profileId, "MEMORY").content;
  return { root, engine, store, definitions, save, search, userView, memoryView, advance(ms) { clock += ms; },
    cleanup() { engine.close(); store.close(); definitions.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const contents = (items) => items.map((item) => item.content);

function sharedFactsReachOtherAgentsAndViews() {
  const f = setup();
  try {
    const fact = f.save("agent-a", "用户偏好简短的中文回答");
    const found = f.search("agent-b", "中文回答");
    assert.deepEqual(contents(found), ["用户偏好简短的中文回答"]);
    assert.equal(found[0].profileId, "agent-a");
    assert(contents(f.search("agent-c")).includes("用户偏好简短的中文回答"), "empty-query hot search includes peers");
    assert(f.userView("agent-b").includes("用户偏好简短的中文回答"), "B's generated USER view includes A's user fact");
    assert(f.memoryView("agent-c").includes("用户偏好简短的中文回答"));
    assert.deepEqual(f.engine.findSharedItem("agent-b", fact.id).home, "agent-a");
    const listed = f.engine.listShared("agent-b");
    assert.deepEqual(listed.items.map((row) => [row.item.id, row.homeProfileId, row.homeRevision]),
      [[fact.id, "agent-a", f.store.getRevision("agent-a")]]);
    assert.equal(listed.truncated, false);
  } finally { f.cleanup(); }
}

function agentScopeStaysPrivate() {
  const f = setup();
  try {
    const own = f.save("agent-a", "A 自己的工作笔记：先跑 lint", "agent");
    assert.deepEqual(contents(f.search("agent-a", "lint")), ["A 自己的工作笔记：先跑 lint"]);
    assert.deepEqual(f.search("agent-b", "lint"), []);
    assert.equal(f.engine.findSharedItem("agent-b", own.id), null);
    assert(!f.memoryView("agent-b").includes("先跑 lint"));
  } finally { f.cleanup(); }
}

function duplicatesCollapseAndOwnCopyWins() {
  const f = setup();
  try {
    f.save("agent-a", "用户住在上海");
    const own = f.save("agent-b", "用户住在上海");
    const found = f.search("agent-b", "上海");
    assert.equal(found.length, 1); assert.equal(found[0].id, own.id); assert.equal(found[0].profileId, "agent-b");
    assert.equal(f.search("agent-c", "上海").length, 1, "two peers holding the same fact show once");
    assert.equal(f.engine.listShared("agent-b").items.length, 0, "a peer copy of an own fact is not listed again");
  } finally { f.cleanup(); }
}

function forgetAtHomeHidesEverywhereAndRefreshesViews() {
  const f = setup();
  try {
    const fact = f.save("agent-a", "用户的生日是三月");
    assert(f.userView("agent-b").includes("用户的生日是三月"));
    f.engine.delete({ profileId: "agent-a", id: fact.id, reason: "forgotten" });
    assert.deepEqual(f.search("agent-b", "生日"), []);
    assert(!f.userView("agent-b").includes("用户的生日是三月"), "peer views are rebuilt after the home commit");
    assert.equal(f.engine.findSharedItem("agent-b", fact.id), null);
  } finally { f.cleanup(); }
}

function viewerForgetAppliesToOlderPeerCopies() {
  const f = setup();
  try {
    f.save("agent-a", "用户喜欢猫");
    const mine = f.save("agent-b", "用户喜欢猫");
    f.engine.delete({ profileId: "agent-b", id: mine.id, reason: "forgotten" });
    assert.deepEqual(f.search("agent-b", "喜欢猫"), [], "A's older copy does not resurrect B's forgotten fact");
    assert(!f.userView("agent-b").includes("用户喜欢猫"));
    assert.equal(f.search("agent-c", "喜欢猫").length, 1, "Agents that never forgot it still read A's copy");
    f.advance(10);
    f.save("agent-c", "用户喜欢猫");
    assert.deepEqual(contents(f.search("agent-b", "喜欢猫")), ["用户喜欢猫"], "a later restatement to another Agent is visible again");
  } finally { f.cleanup(); }
}

function projectFactsStayInTheirWorkspace() {
  const f = setup();
  try {
    f.save("agent-a", "这个仓库用 pnpm 安装依赖", "project", { sourceRefs: [`user-edit:p1`, workspaceMemoryRef("/work/one")] });
    assert.deepEqual(contents(f.search("agent-b", "pnpm", "/work/one")), ["这个仓库用 pnpm 安装依赖"]);
    assert.deepEqual(f.search("agent-b", "pnpm", "/work/two"), []);
  } finally { f.cleanup(); }
}

function sharingOffKeepsAgentsSeparate() {
  const f = setup({ shared: false });
  try {
    f.save("agent-a", "用户偏好深色主题");
    assert.deepEqual(f.search("agent-b", "深色主题"), []);
    assert(!f.userView("agent-b").includes("深色主题"));
    assert.deepEqual(f.engine.listShared("agent-b").items, []);
  } finally { f.cleanup(); }
}

function unknownPeerIsSkipped() {
  const f = setup({ extraPeers: ["not-opened-peer", 42, null] });
  try {
    f.save("agent-a", "用户使用 macOS");
    assert.deepEqual(contents(f.search("agent-b", "macOS")), ["用户使用 macOS"]);
  } finally { f.cleanup(); }
}

function recallRecheckFollowsHomeAgent() {
  const f = setup();
  try {
    const fact = f.save("agent-a", "用户习惯早上开会");
    const note = f.save("agent-a", "A 的私有排查记录", "agent");
    const shown = f.search("agent-b", "早上开会")[0];
    assert.equal(f.engine.isRecallCommitted("agent-a", fact), true, "own items use the own receipt");
    assert.equal(f.engine.isRecallCommitted("agent-b", shown), true, "shared items are rechecked at home");
    assert.equal(f.engine.isRecallCommitted("agent-b", note), false, "agent scope is never shared");
    assert.equal(f.engine.isRecallCommitted("agent-b", { ...shown, content: "篡改后的内容" }), false);
    f.engine.delete({ profileId: "agent-a", id: fact.id, reason: "forgotten" });
    assert.equal(f.engine.isRecallCommitted("agent-b", shown), false, "a forget at home fails the recheck");
  } finally { f.cleanup(); }
}

function forgetEverywhereRemovesEveryCopy() {
  const f = setup();
  try {
    const fact = f.save("agent-a", "用户的生日是三月");
    const copy = f.save("agent-b", "用户的生日是三月");
    const project = f.save("agent-c", "用户的生日是三月", "project", { sourceRefs: ["user-edit:p", workspaceMemoryRef("/w")] });
    f.engine.forgetEverywhere({ profileId: "agent-a", id: fact.id });
    assert.equal(f.store.get("agent-b", copy.id).status, "deleted", "another Agent's copy is forgotten too");
    assert.equal(f.store.get("agent-c", project.id).status, "active", "a different scope is a different fact");
    for (const profileId of PROFILES) {
      assert.deepEqual(f.search(profileId, "生日").filter((item) => item.scope === "user"), []);
    }
    assert.equal(f.engine.hasRevokedContentAnywhere("agent-c", "用户的生日是三月"), true);
  } finally { f.cleanup(); }
}

function undoConsolidationRestoresReplacedFact() {
  const f = setup();
  try {
    const old = f.save("agent-a", "用户希望被称呼为阿棠");
    const plain = f.save("agent-a", "用户喜欢猫");
    assert.throws(() => f.engine.undoConsolidation({ profileId: "agent-a", id: plain.id, operationId: "undo-plain" }),
      (error) => error.code === "MEMORY_NOT_FOUND", "only a consolidated fact can be undone");
    const consolidated = f.store.upsertMany([{ ...old, id: "consolidated-1", content: "用户希望被称呼为小唐",
      sourceRefs: ["event-1", "run-1", "consolidated:auto"], supersedes: old.id },
    { ...old, status: "superseded" }])[0];
    f.engine.rebuildViews("agent-a");
    const undone = f.engine.undoConsolidation({ profileId: "agent-a", id: consolidated.id, operationId: "undo-1" });
    assert.equal(undone.item.status, "deleted");
    assert.equal(undone.restored.id, old.id);
    assert.deepEqual(contents(f.search("agent-b", "称呼")), ["用户希望被称呼为阿棠"], "the restored fact is shared again");
  } finally { f.cleanup(); }
}

function forgetSourcesRemovesFactsOfThoseEvents() {
  const f = setup();
  try {
    f.save("agent-a", "用户住在杭州", "user", { sourceRefs: ["event-s1", "run-s1"] });
    f.save("agent-a", "用户喜欢喝茶", "user", { sourceRefs: ["event-s2", "run-s2"] });
    const kept = f.save("agent-a", "用户养了一只狗", "user", { sourceRefs: ["event-other", "run-other"] });
    assert.equal(f.engine.forgetSources({ profileId: "agent-a", sourceRefs: new Set(["event-s1", "run-s2"]),
      operationId: "forget-session-1" }), 2);
    assert.deepEqual(f.store.list("agent-a", { status: "active" }).map((item) => item.id), [kept.id]);
  } finally { f.cleanup(); }
}

for (const check of [forgetEverywhereRemovesEveryCopy, undoConsolidationRestoresReplacedFact,
  forgetSourcesRemovesFactsOfThoseEvents, recallRecheckFollowsHomeAgent, sharedFactsReachOtherAgentsAndViews, agentScopeStaysPrivate, duplicatesCollapseAndOwnCopyWins,
  forgetAtHomeHidesEverywhereAndRefreshesViews, viewerForgetAppliesToOlderPeerCopies, projectFactsStayInTheirWorkspace,
  sharingOffKeepsAgentsSeparate, unknownPeerIsSkipped]) {
  check(); console.log(`ok - ${check.name}`);
}
console.log("memory sharing unit suite passed");
