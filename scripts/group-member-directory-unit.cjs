"use strict";
// 群成员目录单元（里程碑②，D4 范围）：真实 GroupChatStore + 可控 Definition/Product 源。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupMemberDirectory, exportRoleDocuments, extractCard } = require("../app/agent-service/group-member-directory");
const { createDefaultDocuments } = require("../app/agent-service/agent-definition-defaults");

const RESEARCH_IDENTITY = [
  "# IDENTITY.md", "", "- Name: 研究员", "- 角色：负责源码阅读与方案对比的研究员", "- 默认定位：先查证再下结论", "",
  "## 专长", "", "- 源码阅读", "- 方案对比", "- 发现约束", "",
  "<!-- 私密备注：只给自己看 -->",
  "api_key = sk-live-abcdefghijklmnopqrstuvwx1234567890", "", // gitleaks:allow -- Synthetic test-only marker
].join("\n");

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gmd-")));
  fs.chmodSync(root, 0o700);
  const store = new GroupChatStore({ paths: { stateDir: path.join(root, "state"), trustedRoot: root } }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const defaults = createDefaultDocuments("x");
  const profiles = new Map([
    ["p-r", { id: "p-r", name: "研究员", enabled: true, runtime: "codex", defaultModel: "m1" }],
    ["p-b", { id: "p-b", name: "Builder", enabled: true, runtime: "codex", defaultModel: null }],
    ["p-c", { id: "p-c", name: "Checker", enabled: false, runtime: "codex", defaultModel: null }],
  ]);
  const definitions = new Map([
    ["p-r", { revision: 3, IDENTITY: RESEARCH_IDENTITY, SOUL: "# SOUL.md\n\n## 风格\n\n说话简洁，结论先行。\n" }],
    ["p-b", { revision: 1, IDENTITY: defaults.IDENTITY, SOUL: defaults.SOUL }],
  ]);
  const directory = new GroupMemberDirectory({
    store,
    productStore: { getAgentProfile: (id) => profiles.get(id) ?? null },
    definitionStore: { get: (id) => {
      const value = definitions.get(id);
      return value ? { manifest: { revision: value.revision }, documents: { IDENTITY: value.IDENTITY, SOUL: value.SOUL,
        USER: "用户的私人偏好：喜欢猫", AGENTS: "# AGENTS.md" } } : null;
    } },
    isRuntimeAvailable: () => true, ...options,
  });
  const { groupId } = store.createGroup({ operationId: "g", name: "协作群", purpose: "", members: [
    { backendId: "shoggoth", agentId: "r", profileId: "p-r", displayName: "研究员" },
    { backendId: "shoggoth", agentId: "b", profileId: "p-b", displayName: "Builder" },
    { backendId: "shoggoth", agentId: "c", profileId: "p-c", displayName: "Checker" },
  ] });
  const ids = Object.fromEntries(store.getGroup(groupId).members.map((member) => [member.agentId, member.id]));
  return { store, directory, groupId, ids, profiles, definitions };
}

test("extraction reads only grounded fields; defaults and missing settings are stated, not guessed", () => {
  const defaults = createDefaultDocuments("Codex");
  const defaultCard = extractCard(exportRoleDocuments({ identity: defaults.IDENTITY, soul: defaults.SOUL }));
  assert.equal(defaultCard.role, null);
  assert.equal(defaultCard.usesDefaultRole, true);
  assert.equal(defaultCard.usesDefaultStyle, true);
  const custom = extractCard(exportRoleDocuments({ identity: RESEARCH_IDENTITY, soul: "## 风格\n\n说话简洁，\n结论先行。" }));
  assert.equal(custom.role, "负责源码阅读与方案对比的研究员");
  assert.equal(custom.position, "先查证再下结论");
  assert.deepEqual(custom.specialties, ["源码阅读", "方案对比", "发现约束"]);
  assert.equal(custom.workingStyle, "说话简洁，结论先行。");
  assert.equal(extractCard(exportRoleDocuments({ identity: null, soul: null })).missing, true);
  const noRoleLine = extractCard(exportRoleDocuments({ identity: "# IDENTITY.md\n\n我是负责评审的成员。其余略。", soul: null }));
  assert.equal(noRoleLine.role, "我是负责评审的成员。", "falls back to the first sentence of the first paragraph");
});

test("sharing filter removes private comments and credential lines and marks the export redacted (M24)", () => {
  const exported = exportRoleDocuments({ identity: RESEARCH_IDENTITY, soul: "风格正常" });
  assert.equal(exported.disclosure, "redacted");
  assert.doesNotMatch(exported.text, /私密备注|sk-live/u);
  assert.match(exported.text, /\[已隐去\]/u);
  assert.notEqual(exported.sourceDigest, exported.exportDigest, "source and export digests are kept apart");
  assert.equal(exportRoleDocuments({ identity: "- 角色：评审", soul: null }).disclosure, "verbatim");
});

test("refresh publishes cards, caches unchanged content and bumps versions on real changes (M23)", async (t) => {
  const f = fixture(t);
  let result = await f.directory.refresh(f.groupId);
  assert.equal(result.changed, true);
  assert.equal(result.directoryRevision, 1);
  assert.equal(f.directory.extractions, 3);
  let cards = f.store.getMemberCards(f.groupId);
  assert.equal(cards.get(f.ids.r).role, "负责源码阅读与方案对比的研究员");
  assert.equal(cards.get(f.ids.r).sourceRevision, 3);
  assert.equal(cards.get(f.ids.b).usesDefaultRole, true);
  assert.equal(cards.get(f.ids.c).availability, "offline", "a disabled Agent stays listed but offline");
  assert.equal(cards.get(f.ids.c).missing, true);

  result = await f.directory.refresh(f.groupId);
  assert.equal(result.changed, false, "identical settings do not change the directory");
  assert.equal(f.directory.extractions, 3, "unchanged settings are not re-extracted");

  f.definitions.get("p-b").IDENTITY = "# IDENTITY.md\n\n- Name: Builder\n- 角色：实现与调试\n";
  f.definitions.get("p-b").revision = 2;
  result = await f.directory.refresh(f.groupId);
  assert.equal(result.directoryRevision, 2);
  assert.equal(f.directory.extractions, 4, "only the changed member is extracted again");
  cards = f.store.getMemberCards(f.groupId);
  assert.equal(cards.get(f.ids.b).role, "实现与调试");
  assert.equal(cards.get(f.ids.b).cardRevision, 2);
  assert.equal(cards.get(f.ids.r).cardRevision, 1);

  f.profiles.get("p-r").name = "首席研究员";
  result = await f.directory.refresh(f.groupId);
  assert.equal(result.directoryRevision, 3, "an Agent rename refreshes the directory");
  const view = f.store.getGroup(f.groupId);
  const renamed = view.members.find((member) => member.id === f.ids.r);
  assert.equal(renamed.displayName, "首席研究员");
  assert.equal(renamed.handle, "研究员", "the @handle stays stable so earlier mentions keep their meaning");
  assert.equal(view.group.id, f.groupId);
});

test("on-demand role read returns current shareable text only; removed members are revoked (M24)", async (t) => {
  const f = fixture(t);
  await f.directory.refresh(f.groupId);
  const read = await f.directory.readRole(f.groupId, f.ids.r);
  assert.equal(read.ok, true);
  assert.equal(read.sourceType, "peer_role_document");
  assert.equal(read.disclosure, "redacted");
  assert.equal(read.text.match(/IDENTITY\.md/gu).length, 1, "the document's own title is not repeated");
  assert.match(read.text, /^# IDENTITY\.md/mu);
  assert.match(read.text, /^# SOUL\.md/mu);
  assert.doesNotMatch(read.text, /喜欢猫|AGENTS\.md|sk-live|私密备注/u, "USER/AGENTS, credentials and private notes never leave");
  f.definitions.get("p-r").SOUL = "# SOUL.md\n\n## 风格\n\n新版：先给数据。\n";
  assert.match((await f.directory.readRole(f.groupId, f.ids.r)).text, /新版：先给数据/u, "reads the current version");
  assert.deepEqual(await f.directory.readRole(f.groupId, "nobody"), { ok: false, code: "member_not_found" });
  const group = f.store.getGroup(f.groupId).group;
  f.store.removeMember({ groupId: f.groupId, expectedRosterRevision: group.rosterRevision, memberId: f.ids.b });
  assert.deepEqual(await f.directory.readRole(f.groupId, f.ids.b), { ok: false, code: "access_revoked" });
  await f.directory.refresh(f.groupId);
  const claimRoster = f.store.getGroup(f.groupId).members.filter((member) => member.state === "active").map((member) => member.id);
  assert.ok(!claimRoster.includes(f.ids.b), "a removed member leaves the directory");
});

// 0.8.215（c2169df4）实际写出的 v9 群库；旧版本的库从它删掉后加的表 / 列得到。
function legacyStore(t, now) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gmv-")));
  fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  const db = require("../app/agent-service/inspiration-database").openDatabase(path.join(paths.stateDir, "group-chats.sqlite"));
  db.exec(fs.readFileSync(path.join(__dirname, "fixtures/group-chat-v9-schema.sql"), "utf8"));
  db.close();
  const handle = { paths, store: new GroupChatStore({ paths, ...(now ? { now } : {}) }).open() };
  t.after(() => { try { handle.store.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return handle;
}
const BACK_TO_V7 = "DROP TABLE collaboration_wakeups; DROP TABLE collaboration_actions; DROP TABLE collaboration_items;";
const BACK_TO_V6 = "DROP TABLE message_deliveries; ALTER TABLE invitations DROP COLUMN data; ALTER TABLE session_bindings DROP COLUMN delivery_scan_seq; ALTER TABLE session_bindings DROP COLUMN coverage_start_seq; ALTER TABLE session_bindings DROP COLUMN coverage_unknown_before;";

test("store migrates a v1 database to the current version in place", (t) => {
  const legacy = legacyStore(t);
  const { groupId } = legacy.store.createGroup({ operationId: "g", name: "旧群", purpose: "", members: [
    { backendId: "shoggoth", agentId: "a", profileId: "p-a", displayName: "A" },
    { backendId: "shoggoth", agentId: "b", profileId: "p-b", displayName: "B" },
  ] });
  legacy.store.db.exec(`${BACK_TO_V7} ${BACK_TO_V6}`);
  legacy.store.db.exec("DROP TABLE role_summaries; DROP TABLE role_snapshots; DROP TABLE member_cards; DROP TABLE tasks; DROP TABLE message_results; ALTER TABLE session_bindings DROP COLUMN external; PRAGMA user_version=1;");
  legacy.store.close();
  legacy.store = new GroupChatStore({ paths: legacy.paths }).open();
  const { store } = legacy;
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 10);
  assert.ok(store.db.prepare("PRAGMA table_info(session_bindings)").all().some((column) => column.name === "external"));
  assert.equal(store.getGroup(groupId).group.name, "旧群");
  assert.equal(store.getMemberCards(groupId).size, 0);
  store.appendUserMessage({ groupId, clientMessageId: "after-upgrade", body: "升级后还能聊", mentionMemberIds: [] });
  assert.equal(store.claimNext(groupId, store.advanceDriverFence()).member.agentId, "a", "the first member owns a group without Shoggoth");
});

test("reopening is idempotent; a database from a newer app version is refused without being written", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gmf-")));
  fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  let store = new GroupChatStore({ paths }).open();
  t.after(() => { try { store.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const { groupId } = store.createGroup({ operationId: "g", name: "群", purpose: "", members: [
    { backendId: "shoggoth", agentId: "a", profileId: "p-a", displayName: "A" },
    { backendId: "shoggoth", agentId: "b", profileId: "p-b", displayName: "B" },
  ] });
  store.appendUserMessage({ groupId, clientMessageId: "m1", body: "保留这条", mentionMemberIds: [] });
  const snapshot = () => JSON.stringify([store.getGroup(groupId), store.diagnostics()]);
  const first = snapshot();
  store.close();
  store = new GroupChatStore({ paths }).open();
  assert.equal(snapshot(), first, "opening an up-to-date database changes nothing");
  // 更新版本写出的库：旧程序打开即拒绝，不迁移、不改写。
  store.db.exec("CREATE TABLE future_feature(id TEXT PRIMARY KEY); PRAGMA user_version=11;");
  store.close();
  assert.throws(() => new GroupChatStore({ paths }).open(), { code: "GROUP_CHAT_STORE_CORRUPT" });
  const raw = require("../app/agent-service/inspiration-database").openDatabase(path.join(paths.stateDir, "group-chats.sqlite"));
  try {
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 11, "the newer schema version is left untouched");
    assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 1);
    assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM future_feature").get().count, 0);
  } finally { raw.close(); }
  store = { close() {} };
});

test("an unfilled OpenClaw identity template is reported as no dedicated role, never as template text", () => {
  const identity = ["# IDENTITY.md - Who Am I?", "", "_Fill this in during your first conversation. Make it yours._", "",
    "- Name: Travelplanner", "  _(pick something you like)_", "- **Creature:**", "  _(AI? robot? familiar?)_", "", "---", "",
    "This isn't just metadata. It's the start of figuring out who you are."].join("\n");
  const soulTemplate = ["# SOUL.md - Who You Are", "", "_You're not a chatbot. You're becoming someone._", "",
    "## Core Truths", "", "**Be genuinely helpful, not performatively helpful.**"].join("\n");
  const untouched = extractCard(exportRoleDocuments({ identity, soul: soulTemplate }));
  assert.equal(untouched.role, null);
  assert.equal(untouched.usesDefaultRole, true);
  assert.equal(untouched.workingStyle, null);
  assert.equal(untouched.usesDefaultStyle, true);
  // 身份模板没填，但 SOUL 写了自己的设定：角色取 SOUL 第一句。
  const custom = extractCard(exportRoleDocuments({ identity, soul: "你是旅行规划师，擅长把模糊的出行想法排成可执行的行程。\n\n说话简洁。" }));
  assert.equal(custom.role, "你是旅行规划师，擅长把模糊的出行想法排成可执行的行程。");
  assert.equal(custom.usesDefaultRole, false);
  // 填过的身份文件照常提取。
  const filled = extractCard(exportRoleDocuments({ identity: "# IDENTITY\n\n负责行程规划与预算核对的助手。", soul: soulTemplate }));
  assert.equal(filled.role, "负责行程规划与预算核对的助手。");
});


test("upgrading a v4 database retires a waiting approval and hands its run to the driver once", (t) => {
  const legacy = legacyStore(t, () => 1000);
  let { store } = legacy;
  const { groupId } = store.createGroup({ operationId: "g", name: "旧群", purpose: "", members: [
    { backendId: "shoggoth", agentId: "a", profileId: "pa", displayName: "A" },
    { backendId: "shoggoth", agentId: "b", profileId: "pb", displayName: "B" }] });
  store.appendUserMessage({ groupId, clientMessageId: "m1", body: "@a 回答", mentionMemberIds: [] });
  const fence = store.advanceDriverFence();
  const claim = store.claimNext(groupId, fence);
  store.bindSession({ groupId, memberId: claim.member.id, sessionKey: "saved-session", fence });
  store.recordRun({ opportunityId: claim.opportunity.id, runId: "saved-run", sessionKey: "saved-session", fence });
  const waiting = { ...store.getOpportunity(claim.opportunity.id), state: "waiting",
    interaction: { status: "responded", request: { requestId: "old-approval" } } };
  store.db.prepare("UPDATE opportunities SET state='waiting',data=? WHERE id=?").run(JSON.stringify(waiting), waiting.id);
  store.db.exec(`${BACK_TO_V7} ${BACK_TO_V6}`);
  store.db.exec("DROP TABLE role_summaries; DROP TABLE role_snapshots; DROP TABLE message_results; PRAGMA user_version=4;");
  store.close(); legacy.store = store = new GroupChatStore({ paths: legacy.paths, now: () => 25_000 }).open();
  const retired = store.getOpportunity(waiting.id);
  assert.equal(retired.state, "cancelled"); assert.equal(retired.errorCode, "GROUP_UPGRADE_RETIRED");
  assert.equal(retired.runId, "saved-run", "the run identity is kept for the abort");
  assert.deepEqual(store.takeLegacyRuns().map((run) => run.runId), ["saved-run"]);
  assert.deepEqual(store.takeLegacyRuns(), [], "the driver receives each retired run once");
  const first = JSON.stringify(retired);
  store.close(); legacy.store = store = new GroupChatStore({ paths: legacy.paths, now: () => 90_000 }).open();
  assert.equal(JSON.stringify(store.getOpportunity(waiting.id)), first, "opening v10 is idempotent");
});

test("completed background preparation invalidates only its own native capability cache", async t => {
  const pending = [], changed = []; let announce;
  const announced = new Promise(resolve => { announce = resolve; });
  const f = fixture(t, { onChanged: id => { changed.push(id); announce(); } });
  const { groupCapabilities } = require("../app/agent-service/group-capabilities");
  let verified = false, probes = 0;
  f.directory.probeNative = async ({ member, onCapabilitiesChanged }) => {
    probes++;
    if (member.profileId === "p-r") pending.push(onCapabilitiesChanged);
    return groupCapabilities({ protocolVersion: 2, availability: "available", source: "native-binding", checkedAt: 1,
      discussion: true, isolatedSession: true, collaborationSupport: true,
      groupTools: member.profileId !== "p-r" || verified, collaborationActions: member.profileId !== "p-r" || verified });
  };
  await f.directory.refresh(f.groupId);
  assert.equal(probes, 2);
  await f.directory.refresh(f.groupId);
  assert.equal(probes, 2);
  verified = true; pending[0]();
  await Promise.race([announced, new Promise((_, reject) => setTimeout(() => reject(Error("no automatic capability refresh")), 1000))]);
  assert.equal(probes, 3);
  assert(changed.includes(f.groupId));
  const member = f.store.getGroup(f.groupId).members.find(item => item.id === f.ids.r);
  assert.equal(member.card.capabilities.collaborationActions, true);
});
