"use strict";

// 2026-10-20 原生 Service 卡顿回归：Active Memory 的每次 check() 都会重读证据会话。
// 真实 ChatSessionStore / TranscriptStore / ConversationRecallService / ProductMemorySessions；
// 只有 WorkRun、召回策略与记忆条目是 fixture。规模接近现场：约 200 个会话、证据会话 60 轮。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");
const { ProductMemorySessions } = require("../app/agent-service/shoggoth-memory/session-source.cjs");

const TARGET = "agent-target";

function fixture(t, { profiles = 8, sessionsPerProfile = 25, turns = 60 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-hot-")));
  fs.chmodSync(root, 0o700);
  const closers = [];
  // Close stores before removing their directory; node:test runs after-hooks in order.
  t.after(() => { for (const close of closers.reverse()) close(); fs.rmSync(root, { recursive: true, force: true }); });
  const stateDir = path.join(root, "state"), agentsDir = path.join(stateDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  const paths = { trustedRoot: root, stateDir, agentsDir };
  // Setup only: 200 durable session writes without fsync keep the fixture fast.
  const atomicWrite = (target, value) => fs.writeFileSync(target, value, { mode: 0o600 });
  let now = Date.now(), policyRevision = 0, memoryRevision = 0;
  const sessions = new ChatSessionStore({ paths, atomicWrite, now: () => now }).open();
  closers.push(() => sessions.close());
  const transcripts = new TranscriptStore({ paths, assertSecretSafe: () => true });
  transcripts.open();
  closers.push(() => transcripts.close());
  const runs = new Map();
  const memoryItems = [];
  const created = [];
  for (let p = 0; p < profiles; p += 1) {
    const profileId = p === 0 ? TARGET : `agent-${p}`;
    for (let s = 0; s < sessionsPerProfile; s += 1) {
      const workspace = `/workspace/${profileId}/${s}`;
      const session = sessions.createSession({ operationId: `create-${p}-${s}`, profileId, workspace, createdAt: now });
      const operationId = `bind-${p}-${s}`;
      sessions.requestBinding(session.sessionKey, operationId, now);
      created.push(sessions.completeBinding(session.sessionKey, operationId, crypto.randomUUID()));
    }
  }
  const target = sessions.listSessions().find(session => session.profileId === TARGET);
  transcripts.ensureSession({ profileId: TARGET, sessionId: target.id });
  const addTurn = (index) => {
    const runId = `run-${index}`;
    runs.set(runId, { id: runId, profileId: TARGET, workspace: target.workspace, source: "chat",
      sourceId: target.sessionKey, idempotencyKey: `shoggoth:chat-send:send-${index}`, status: "completed" });
    transcripts.appendEvent({ profileId: TARGET, sessionId: target.id, runId, id: `user-${index}`, kind: "user",
      content: { text: `第 ${index} 轮：用户提到琥珀色望远镜放在天文台的第 ${index} 个柜子里。` } });
    transcripts.appendEvent({ profileId: TARGET, sessionId: target.id, runId, id: `assistant-${index}`, kind: "assistant",
      content: { text: `第 ${index} 轮回答：已经记住这个位置，后续会按需调取。` } });
  };
  for (let i = 1; i <= turns; i += 1) addTurn(i);
  const policy = {
    assertReady() {},
    getRevision: () => policyRevision,
    getHistoricalVisibilityRevision: () => policyRevision,
    getMemoryReason: () => null,
    isEventVisible: () => true,
  };
  const memoryStore = { getRevision: () => memoryRevision, list: () => structuredClone(memoryItems) };
  const recall = new ConversationRecallService({ paths, transcriptStore: transcripts, chatSessionStore: sessions,
    workDispatcher: { getRun: id => structuredClone(runs.get(id) || null) },
    getRunSessionKey: run => run.sourceId, recallPolicy: policy, memoryStore, now: () => now });
  closers.push(() => recall.close());
  const memory = new ProductMemorySessions({ sessions, transcripts, recall,
    database: { tombstones: () => [] }, assertProfile() {} });
  const counters = { listSessions: 0, pages: 0 };
  const listSessions = sessions.listSessions.bind(sessions);
  sessions.listSessions = () => { counters.listSessions += 1; return listSessions(); };
  const listEventsPage = transcripts.listEventsPage.bind(transcripts);
  transcripts.listEventsPage = (...args) => { counters.pages += 1; return listEventsPage(...args); };
  return { sessions, transcripts, recall, memory, target, counters, created, addTurn, runs,
    bumpPolicy: () => { policyRevision += 1; },
    addHistoricalMemory: (item) => { memoryItems.push(item); memoryRevision += 1; },
    now: () => now, setNow: (value) => { now = value; } };
}

test("one evidence read does not deep-clone the whole session roster per transcript event", (t) => {
  const f = fixture(t);
  const before = f.counters.listSessions;
  const value = f.memory.read(TARGET, f.target.id);
  assert.equal(value.lineMap.length, 120, "every completed user/assistant event is projected");
  assert.equal(f.counters.listSessions - before, 0,
    "session lookups must use the store index instead of cloning all sessions");
});

test("repeated evidence checks reuse an unchanged session projection", (t) => {
  const f = fixture(t);
  const first = f.memory.read(TARGET, f.target.id);
  const pages = f.counters.pages;
  const started = performance.now();
  for (let i = 0; i < 150; i += 1) {
    const again = f.memory.read(TARGET, f.target.id);
    assert.equal(again.hash, first.hash);
  }
  const elapsed = performance.now() - started;
  assert.equal(f.counters.pages, pages, "an unchanged source must not be rescanned");
  assert.ok(elapsed < 1_000, `150 unchanged evidence checks took ${Math.round(elapsed)}ms`);
});

test("cached projection is invalidated by transcript, policy, historical memory and expiry changes", (t) => {
  const f = fixture(t, { profiles: 2, sessionsPerProfile: 3, turns: 4 });
  const base = f.memory.read(TARGET, f.target.id);
  f.addTurn(5);
  const appended = f.memory.read(TARGET, f.target.id);
  assert.equal(appended.lineMap.length, base.lineMap.length + 2, "a new completed turn is visible immediately");
  assert.notEqual(appended.hash, base.hash);

  const pages = f.counters.pages;
  f.bumpPolicy();
  f.memory.read(TARGET, f.target.id);
  assert.ok(f.counters.pages > pages, "a recall policy change forces a fresh projection");

  // A saved memory superseding turn 1 hides that user event from candidate sources.
  f.addHistoricalMemory({ id: "memory-1", profileId: TARGET, status: "superseded", validUntil: null,
    sourceRefs: ["user-1", "run-1"] });
  const superseded = f.memory.read(TARGET, f.target.id);
  assert.equal(superseded.content.includes("第 1 轮：用户"), false, "superseded source is excluded at once");

  // A still-active memory with a deadline expires by time alone.
  f.addHistoricalMemory({ id: "memory-2", profileId: TARGET, status: "active", validUntil: f.now() + 100_000,
    sourceRefs: ["user-2", "run-2"] });
  assert.equal(f.memory.read(TARGET, f.target.id).content.includes("第 2 轮：用户"), true);
  f.setNow(f.now() + 100_000);
  assert.equal(f.memory.read(TARGET, f.target.id).content.includes("第 2 轮：用户"), false,
    "crossing an expiry boundary must not be hidden by the cache");
});

test("store index lookups match the full roster scan before and after writes and reopen", (t) => {
  const f = fixture(t, { profiles: 3, sessionsPerProfile: 4, turns: 1 });
  const check = () => {
    const all = f.sessions.listSessions();
    for (const session of all) assert.deepEqual(f.sessions.findSessionById(session.id), session);
    assert.equal(f.sessions.findSessionById("00000000-0000-4000-8000-000000000000"), null);
    for (const profileId of [TARGET, "agent-1", "agent-2", "missing"]) {
      const expected = all.filter(session => session.profileId === profileId);
      assert.deepEqual(f.sessions.listProfileSessions(profileId), expected);
      const legacy = crypto.createHash("sha256").update(JSON.stringify(
        expected.sort((left, right) => left.id.localeCompare(right.id)))).digest("hex");
      assert.equal(f.sessions.profileSessionsDigest(profileId), legacy);
    }
  };
  check();
  const digest = f.sessions.profileSessionsDigest(TARGET);
  const other = f.sessions.profileSessionsDigest("agent-1");
  f.sessions.setPermissionMode(f.target.sessionKey, "full");
  check();
  assert.notEqual(f.sessions.profileSessionsDigest(TARGET), digest, "own session change updates the digest");
  assert.equal(f.sessions.profileSessionsDigest("agent-1"), other, "another Agent's change does not");
  const returned = f.sessions.findSessionById(f.target.id);
  returned.workspace = "/mutated-by-caller";
  assert.notEqual(f.sessions.findSessionById(f.target.id).workspace, "/mutated-by-caller", "callers get clones");
  f.sessions.close(); f.sessions.open();
  check();
});
