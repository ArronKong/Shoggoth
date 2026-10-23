"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { LearningStore } = require("../app/agent-service/self-improvement/store");
const { LearningService } = require("../app/agent-service/self-improvement/service");
const { LearningSources } = require("../app/agent-service/self-improvement/sources");
const { LearnedSkillFacade } = require("../app/agent-service/self-improvement/skill-facade");
const { digest, DAY_MS, DEFAULT_CONFIG, reviewInputBudget, validateProposal, validateParams, validateResult } = require("../app/agent-service/self-improvement/protocol");
const { readLearningRestoreBarrier } = require("../app/agent-service/self-improvement/restore");

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
function fixture() {
  const root = fs.mkdtempSync("/private/tmp/shog-learn-"); fs.chmodSync(root, 0o700);
  let time = 1_800_000_000_000, revoked = false, calls = 0, mode = "create", deferred = null, usage = { inputTokens: 123, outputTokens: 80 }, contextWindow = null;
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"), agentsDir: path.join(root, "agents") };
  const store = new LearningStore({ paths, now: () => time }).open();
  const runs = [{ id: "run-one", profileId: "agent-one", source: "chat", status: "completed", workspace: "/fixture", startedAt: time, finishedAt: time }];
  const profile = { id: "agent-one", name: "Fixture", enabled: true };
  const session = { id: "session-one", profileId: profile.id, sessionKey: "session-key", workspace: "/fixture", status: "ready" };
  const events = [
    { id: "user-one", seq: 1, kind: "user", runId: "run-one", content: { text: "以后先核对构建配置，再验证产物。" } },
    { id: "tool-one", seq: 2, kind: "tool_result", runId: "run-one", content: { tool: { kind: "commandExecution", status: "completed", exitCode: 0, resultSummary: "build and artifact checks passed" } } },
    { id: "assistant-one", seq: 3, kind: "assistant", runId: "run-one", content: { text: "构建与产物核对均通过。" } },
  ];
  const listeners = new Set();
  const subscriptions = { subscribeChanges: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const products = { getAgentProfile: id => id === profile.id ? profile : null,
    listAgentProfiles: () => [profile], getWorkRun: id => runs.find(run => run.id === id),
    listWorkRuns: (query = {}) => runs.filter(run => Object.entries(query).every(([key, value]) => run[key] === value)) };
  const sessions = { ...subscriptions, getSession: key => key === session.sessionKey ? session : null };
  const transcripts = { ...subscriptions, getRevision: () => 1, listEvents: () => events, contextEvent: (_p, _s, event) => event };
  const recall = { policy: { ...subscriptions, isEventVisible: () => !revoked },
    scanEligibleSession: () => ({ events: revoked ? [] : events.filter(event => event.kind !== "tool_result")
      .map(event => ({ ...event, eventId: event.id, text: event.content.text })), throughSeq: events.at(-1).seq, hasMore: false }),
    assertCandidateSourceCurrent: () => { if (revoked) throw Object.assign(new Error("withdrawn"), { code: "MEMORY_CANDIDATE_SOURCE_OUTDATED" }); } };
  const proposal = () => ({ action: "create", reason: "verified reusable build checks", title: "检查构建配置",
    description: "排查构建产物与预期不一致时使用", body: "先检查实际配置来源。再运行构建。最后核对产物内容与时间。以产物验证结果判断成功。",
    references: [{ path: "references/checks.md", content: "保留失败与最终验证记录。" }],
    evidence: [{ runId: "run-one", eventId: "user-one" }, { runId: "run-one", eventId: "tool-one" }] });
  const coordinator = { getRunSessionKey: () => session.sessionKey,
    resolveLearningModelContext: () => ({ model: "fixture-model", runtime: "codex", supported: true, contextWindow,
      bindingId: "fixture-binding", runtimeAccountId: "fixture-account", fingerprint: "fixture", assertCurrent() {} }),
    async generateLearningText(input) {
      calls += 1;
      assert.equal(input.model, undefined, "follows Agent default without a session override");
      if (deferred) await deferred(input);
      const text = mode === "invalid" ? "invalid" : mode === "noop" ? JSON.stringify({ action: "noop", reason: "no durable method" })
        : JSON.stringify(mode === "long" ? { ...proposal(), body: "核对".repeat(1300) } : proposal());
      input.onText?.(text);
      return { text, usage };
    } };
  const sources = new LearningSources({ products, sessions, transcripts, recall, getCoordinator: () => coordinator,
    assertSessionCurrent() { if (revoked) throw Object.assign(new Error("revoked"), { code: "MEMORY_SESSION_REVOKED" }); } });
  const notices = [];
  const service = new LearningService({ store, sources, products, dispatcher: subscriptions, transcripts, sessions, recall,
    getCoordinator: () => coordinator, now: () => time, setTimer: () => 1, clearTimer() {}, hasDependencies: () => false,
    notify: notice => notices.push(notice) });
  return { root, store, service, sources, products, events, runs, profile, proposal, notices,
    advance: ms => { time += ms; }, revoke: () => { revoked = true; }, calls: () => calls,
    setMode: value => { mode = value; }, setUsage: value => { usage = value; },
    setContextWindow: value => { contextWindow = value; }, defer: fn => { deferred = fn; },
    async enable(mode = "auto") { await service.handle("learning.configure", { profileId: profile.id,
      expectedRevision: store.settings(profile.id).revision, patch: { mode }, consent: true }); },
    async review() { service.request(profile.id, "run-one"); time += 31_000; await service.tick(); await service.active?.promise;
      return store.history(profile.id).items[0]; },
    async close() { await service.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
async function withFixture(fn) { const f = fixture(); try { await fn(f); } finally { await f.close(); } }

test("fresh startup and reads never activate learning; explicit consent is required", () => withFixture(async f => {
  assert.equal(f.store.settings("agent-one").config.mode, "off");
  f.service.open(); await f.service.tick();
  assert.equal(f.service.opened, false); assert.equal(f.calls(), 0); assert.equal(f.store.queued().length, 0);
  await assert.rejects(f.service.handle("learning.configure", { profileId: "agent-one", expectedRevision: 0, patch: { mode: "auto" } }), { code: "LEARNING_PROTECTED" });
  assert.throws(() => f.service.request("agent-one", "run-one"), { code: "LEARNING_UNAVAILABLE" });
  await f.enable("review"); assert.equal(f.service.opened, true);
  await f.service.handle("learning.configure", { profileId: "agent-one", expectedRevision: 1, patch: { mode: "off" } });
  assert.equal(f.service.opened, false); assert.equal(f.calls(), 0);
}));
test("management catalog verifies provenance, retains archived entries and never records reads or leases", () => withFixture(async f => {
  await f.enable(); await f.review();
  const skill = f.store.allSkills("agent-one")[0];
  const facade = new LearnedSkillFacade({ base: {}, store: f.store, sources: f.sources });
  const first = facade.management("agent-one")[0];
  assert.equal(first.title, skill.title); assert.equal(first.enabled, true);
  assert.equal(first.usageCount, 0); assert.equal(first.learnedRevision, skill.revision);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM leases").get().n, 0);
  assert.equal(f.store.skillUsage(skill.id).reads, 0);
  f.store.change("agent-one", skill.id, skill.revision, "archive", () => {});
  assert.equal(facade.management("agent-one")[0].enabled, false);
  assert.equal(facade.management("agent-one")[0].learnedRevision, skill.revision + 1);
  assert.equal(facade.management("agent-other").length, 0);
  f.revoke();
  assert.equal(facade.management("agent-one").length, 0, "unavailable source metadata is excluded before reconciliation");
}));
test("verified completed task publishes atomically and a later Run reads its frozen version", () => withFixture(async f => {
  await f.enable(); const job = await f.review(); assert.equal(job.state, "applied"); assert.equal(f.calls(), 1);
  const skill = f.store.allSkills("agent-one")[0];
  assert.ok(f.store.readFile("agent-one", skill.id, skill.head).content.includes("核对产物"));
  assert.equal(f.store.budget("agent-one").tokens, 203);
  const base = { catalog: () => ({ items: [], ineligible: [], registryRevision: "base" }), select: () => ({ selected: [] }), read() { throw new Error("not found"); } };
  f.runs.push({ ...f.runs[0], id: "run-next", status: "running" });
  const facade = new LearnedSkillFacade({ base, store: f.store, sources: f.sources, getRun: id => f.products.getWorkRun(id) });
  const opts = { runId: "run-next" }, first = facade.catalog("agent-one", opts).items[0];
  const changed = f.store.change("agent-one", skill.id, skill.revision, "edit", () => {}, { body: "手工更新。" });
  assert.notEqual(changed.head, first.contentHash);
  assert.equal(facade.catalog("agent-one", opts).items[0].contentHash, first.contentHash);
  const read = facade.read({ ...opts, profileId: "agent-one", name: first.name, contentHash: first.contentHash, recordUsage: true });
  assert.ok(read.content.includes("核对产物")); assert.equal(f.store.skillUsage(skill.id).reads, 1);
  assert.equal(facade.catalog("agent-one", { allowPluginSkills: false }).items.length, 0);
  f.store.settleRun("run-next", "completed");
  assert.equal(f.store.skillUsage(skill.id).outcomes[0].outcome, "completed");
  assert.equal(f.service.request("agent-one", "run-one").queued, false);
}));
test("review mode requires a revisioned decision and cannot publish stale content", () => withFixture(async f => {
  await f.enable("review"); const job = await f.review(); assert.equal(job.state, "pending_review");
  assert.equal(f.store.allSkills("agent-one").length, 0);
  await assert.rejects(f.service.handle("learning.proposal.resolve", { profileId: "agent-one", jobId: job.id, expectedRevision: job.revision - 1, action: "accept" }), { code: "LEARNING_CONFLICT" });
  await f.service.handle("learning.proposal.resolve", { profileId: "agent-one", jobId: job.id, expectedRevision: job.revision, action: "accept" });
  assert.equal(f.store.job(job.id).state, "applied");
}));
test("source withdrawal delivers metadata while learning is disabled without model work", () => withFixture(async f => {
  await f.enable(); await f.review();
  const calls = f.calls(), noticesBefore = f.notices.length;
  await f.service.handle("learning.configure", { profileId: "agent-one", expectedRevision: f.store.settings("agent-one").revision, patch: { mode: "off" } });
  assert.equal(f.service.opened, false);
  f.revoke(); f.service.reconcileSources("agent-one");
  assert.ok(f.notices.slice(noticesBefore).some(notice => notice.action === "withdraw"));
  assert.equal(f.service.opened, false); assert.equal(f.calls(), calls);
  assert.equal(f.store.notices().length, 0, "delivered metadata is acknowledged");
}));
test("source withdrawal blocks reads and resurrection before deleting derived text", () => withFixture(async f => {
  await f.enable(); await f.review(); const skill = f.store.allSkills("agent-one")[0];
  f.revoke(); f.service.reconcileSources("agent-one");
  assert.equal(f.store.skill(skill.id, "agent-one").revoked, true);
  assert.throws(() => f.store.readFile("agent-one", skill.id, skill.head), { code: "LEARNING_VERSION_UNAVAILABLE" });
  assert.equal(f.store.job(skill.lastJobId).proposal, null);
  assert.equal(fs.existsSync(f.store._versionRoot("agent-one", skill.id, skill.head)), false);
}));
test("negative exit, derived reads, failed or incomplete tasks cannot justify a Skill", () => withFixture(async f => {
  f.events[1].content.tool.exitCode = 1;
  assert.throws(() => f.sources.readRun("agent-one", "run-one"), { code: "LEARNING_SOURCE_UNAVAILABLE" });
  f.events[1].content.tool.exitCode = 0; f.events[1].content.tool.name = "skill_read";
  assert.throws(() => f.sources.readRun("agent-one", "run-one"), { code: "LEARNING_SOURCE_UNAVAILABLE" });
  f.runs[0].status = "failed";
  assert.throws(() => f.sources.readRun("agent-one", "run-one"), { code: "LEARNING_SOURCE_UNAVAILABLE" });
}));
test("front task arrival cancels review; a late model completion never publishes", () => withFixture(async f => {
  let release; f.defer(() => new Promise(resolve => { release = resolve; }));
  await f.enable(); f.service.request("agent-one", "run-one"); f.advance(31_000); await f.service.tick();
  const active = f.service.active; assert.ok(active);
  f.runs.push({ ...f.runs[0], id: "run-front", status: "queued" }); await f.service.tick();
  assert.equal(active.controller.signal.aborted, true); release(); await active.promise;
  assert.equal(f.store.allSkills("agent-one").length, 0); assert.equal(f.store.history("agent-one").items[0].state, "canceled");
}));
test("format repair permits sixteen iterations and then stops", () => withFixture(async f => {
  await f.enable(); f.setMode("invalid"); const job = await f.review();
  assert.equal(job.state, "failed"); assert.equal(f.calls(), 16); assert.equal(f.store.allSkills("agent-one").length, 0);
}));
test("automatic input budget follows the model window and explicit values are not capped", () => {
  assert.equal(reviewInputBudget(DEFAULT_CONFIG, null), 120000);
  assert.equal(reviewInputBudget(DEFAULT_CONFIG, 128000), 96000);
  assert.equal(reviewInputBudget(DEFAULT_CONFIG, 1050000), 600000);
  assert.equal(reviewInputBudget({ ...DEFAULT_CONFIG, maxInputTokens: 900000 }, 128000), 900000);
  for (const maxInputTokens of [0, -1]) assert.equal(reviewInputBudget({ ...DEFAULT_CONFIG, maxInputTokens }), null);
});
test("input budget is checked between iterations and does not reject a completed valid result", () => withFixture(async f => {
  await f.enable();
  await f.service.handle("learning.configure", { profileId: "agent-one", expectedRevision: 1, patch: { maxInputTokens: 1 } });
  const job = await f.review(); assert.equal(job.state, "applied"); assert.equal(f.calls(), 1);
}));
test("recorded input prevents a further repair without consuming a daily quota", () => withFixture(async f => {
  await f.enable(); f.setMode("invalid");
  await f.service.handle("learning.configure", { profileId: "agent-one", expectedRevision: 1, patch: { maxInputTokens: 124 } });
  const job = await f.review(); assert.equal(job.reason, "LEARNING_INPUT_BUDGET"); assert.equal(f.calls(), 2);
  assert.equal(job.calls.length, 2); assert.equal(f.store.budget("agent-one").tokens, 406);
}));
test("missing usage uses the input estimate when deciding whether to start another iteration", () => withFixture(async f => {
  await f.enable(); f.setMode("invalid"); f.setUsage(null);
  await f.service.handle("learning.configure", { profileId: "agent-one", expectedRevision: 1, patch: { maxInputTokens: 1 } });
  const job = await f.review(); assert.equal(job.reason, "LEARNING_INPUT_BUDGET"); assert.equal(f.calls(), 1);
  assert.equal(f.store.budget("agent-one").unknownCalls, 1);
}));
test("unlimited input remains bounded by the sixteen-iteration review loop", () => withFixture(async f => {
  await f.enable(); f.setMode("invalid"); f.setUsage({ inputTokens: 800000, outputTokens: 10 });
  await f.service.handle("learning.configure", { profileId: "agent-one", expectedRevision: 1, patch: { maxInputTokens: 0 } });
  const job = await f.review(); assert.equal(job.state, "failed"); assert.equal(f.calls(), 16);
  assert.equal(readLearningRestoreBarrier(f.store.paths).calls.length, 16);
}));
test("automatic reviews exceed former daily caps without idle delay or cooldown", () => withFixture(async f => {
  await f.enable(); f.setMode("noop"); f.setUsage({ inputTokens: 40000, outputTokens: 20000 });
  await f.service.handle("learning.configure", { profileId: "agent-one", expectedRevision: 1, patch: { toolResultThreshold: 1 } });
  for (let index = 0; index < 12; index++) {
    if (index) {
      const runId = `run-extra-${index}`, originals = f.events.slice(0, 3);
      f.runs.push({ ...f.runs[0], id: runId });
      for (const event of originals) f.events.push({ ...event, id: `${event.id}-${index}`, runId, seq: f.events.length + 1 });
    }
    await f.service.tick(); await f.service.active?.promise;
    assert.equal(f.calls(), index + 1, "no time advancement is required between independent tasks");
  }
  assert.equal(f.store.budget("agent-one").runs, 12); assert.equal(f.store.budget("agent-one").tokens, 720000);
}));
test("review no longer has the extra 120-second total deadline or 2048-output-token cap", () => withFixture(async f => {
  await f.enable(); f.setMode("long");
  f.events[0].content.text = "核对构建步骤".repeat(2200);
  f.defer(input => { assert.equal(input.timeoutMs, 900000); f.advance(121000); });
  const job = await f.review(); assert.equal(job.state, "applied"); assert.equal(f.calls(), 1);
}));
test("v1 settings migrate atomically while retaining consent, disabled profiles, usage and terminal history", () => withFixture(async f => {
  await f.enable(); await f.review(); f.store.settings("agent-disabled"); await f.service.close();
  const before = f.store.settings("agent-one"), skill = f.store.allSkills("agent-one")[0];
  for (const profileId of ["agent-one", "agent-disabled"]) {
    const value = f.store.settings(profileId), { maxInputTokens, ...config } = value.config;
    value.config = { ...config, maxRunsPerDay: 8, maxTokensPerDay: 100000, idleSeconds: 30, cooldownMinutes: 20 };
    f.store.db.prepare("UPDATE settings SET data=? WHERE profile_id=?").run(JSON.stringify(value), profileId);
  }
  f.store.db.exec("PRAGMA user_version=1"); f.store.close(); f.store.open();
  const migrated = f.store.settings("agent-one");
  assert.equal(migrated.config.maxInputTokens, null); assert.equal(migrated.config.mode, "auto");
  assert.equal(migrated.revision, before.revision + 1); assert.deepEqual(migrated.consent, before.consent);
  assert.equal(migrated.coverageStartedAt, before.coverageStartedAt); assert.equal(f.store.settings("agent-disabled").config.mode, "off");
  assert.equal(f.store.queued().length, 0); assert.equal(f.store.budget("agent-one").tokens, 203);
  assert.equal(f.store.allSkills("agent-one")[0].head, skill.head); assert.equal(f.store.job(skill.lastJobId).state, "applied");
  assert.deepEqual(Object.keys(migrated.config).sort(), Object.keys(DEFAULT_CONFIG).sort());
  f.store.close(); f.store.open(); assert.equal(f.store.settings("agent-one").revision, migrated.revision);
}));
test("the resolved model context controls the default budget used by the review", () => withFixture(async f => {
  await f.enable(); f.setMode("invalid"); f.setContextWindow(100);
  assert.equal(f.service.status("agent-one").capability.maxInputTokens, 75);
  const job = await f.review(); assert.equal(job.reason, "LEARNING_INPUT_BUDGET"); assert.equal(f.calls(), 1);
}));
test("invalid legacy settings roll back the entire migration without silently enabling learning", () => withFixture(async f => {
  await f.enable(); await f.service.close();
  for (const profileId of ["agent-one", "agent-disabled"]) {
    const value = f.store.settings(profileId), { maxInputTokens, ...config } = value.config;
    value.config = { ...config, maxRunsPerDay: 8, maxTokensPerDay: 100000, idleSeconds: 30, cooldownMinutes: 20 };
    if (profileId === "agent-disabled") value.config.mode = "invalid";
    f.store.db.prepare("UPDATE settings SET data=? WHERE profile_id=?").run(JSON.stringify(value), profileId);
  }
  f.store.db.exec("PRAGMA user_version=1"); f.store.close();
  assert.throws(() => f.store.open(), { code: "LEARNING_STORE_CORRUPT" });
  const db = require("../app/agent-service/inspiration-database").openDatabase(f.store.filePath, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
    const value = JSON.parse(db.prepare("SELECT data FROM settings WHERE profile_id='agent-one'").get().data);
    assert.equal(value.revision, 1); assert.equal(value.config.maxRunsPerDay, 8); assert.equal(value.config.maxInputTokens, undefined);
  } finally { db.close(); }
}));
test("restart marks dispatched calls unknown and retains token reservations", () => withFixture(async f => {
  await f.enable(); f.service.request("agent-one", "run-one"); const job = f.store.queued()[0];
  f.store.beginCall(job.id, job.revision, { route: {}, estimatedInputTokens: 100, reserveTokens: 2148 });
  await f.service.close(); f.store.close(); f.store.open();
  assert.equal(f.store.job(job.id).state, "outcome_unknown"); assert.equal(f.store.queued().length, 0);
  assert.equal(f.store.budget("agent-one").tokens, 2148); assert.equal(f.store.budget("agent-one").unknownCalls, 1);
}));
test("version mutations use CAS; pin and user ownership prevent background overwrite", () => withFixture(async f => {
  await f.enable(); await f.review(); const skill = f.store.allSkills("agent-one")[0];
  const pinned = f.store.change("agent-one", skill.id, 1, "pin", () => {});
  assert.throws(() => f.store.change("agent-one", skill.id, 1, "archive", () => {}), { code: "LEARNING_CONFLICT" });
  const sourceRefs = f.sources.readRun("agent-one", "run-one").sourceRefs;
  const job = f.store.queue({ profileId: "agent-one", runIds: [], sourceRefs: [...sourceRefs].reverse(), settingsRevision: 1, sessionKey: "session-key" });
  const update = f.store.updateJob(job.id, job.revision, { state: "validating", proposal: { ...f.proposal(), action: "patch", skillId: skill.id, baseVersionHash: skill.head, body: "更新步骤" } });
  assert.throws(() => f.store.publish(update.id, update.revision, () => {}), { code: "LEARNING_PROTECTED" });
  const adopted = f.store.change("agent-one", skill.id, pinned.revision, "adopt", () => {});
  assert.equal(adopted.owner, "user"); assert.throws(() => f.store.publish(update.id, update.revision, () => {}, { accepted: true }), { code: "LEARNING_PROTECTED" });
}));
test("curation protects pinned and leased Skills and archives unused managed Skills", () => withFixture(async f => {
  await f.enable(); await f.review(); const skill = f.store.allSkills("agent-one")[0];
  f.store.captureLease("agent-one", "active-run", [skill]); f.advance(31 * DAY_MS); f.service.curate("agent-one");
  assert.equal(f.store.skill(skill.id, "agent-one").archived, false);
  f.store.settleRun("active-run", "completed"); f.advance(8 * DAY_MS); f.service.curate("agent-one");
  assert.equal(f.store.skill(skill.id, "agent-one").archived, true);
}));
test("untrusted proposals cannot escape their package or expand the RPC schema", () => withFixture(async f => {
  assert.throws(() => validateProposal({ ...f.proposal(), references: [{ path: "../AGENTS.md", content: "replace" }] }), { code: "LEARNING_OUTPUT_INVALID" });
  assert.throws(() => validateParams("learning.configure", { profileId: "agent-one", expectedRevision: 0, patch: { mode: "auto" }, account: "other" }), { code: "LEARNING_INVALID" });
}));

test("off cancels queued work and re-enabling does not replay it", () => withFixture(async f => {
  await f.enable(); f.service.request("agent-one", "run-one");
  await f.service.handle("learning.configure", { profileId: "agent-one", expectedRevision: 1, patch: { mode: "off" } });
  assert.equal(f.store.history("agent-one").items[0].state, "canceled");
  await f.enable(); f.advance(60_000); await f.service.tick();
  assert.equal(f.calls(), 0);
}));
test("restore retains later withdrawals and daily cost but resets consent and pending proposals", () => withFixture(async f => {
  await f.enable(); await f.review(); const skill = f.store.allSkills("agent-one")[0];
  await f.service.close(); f.store.close();
  const backup = path.join(f.root, "backup.sqlite"); fs.copyFileSync(f.store.filePath, backup);
  f.store.open(); f.store.revokeVersion("agent-one", skill.id, skill.head); f.store.close();
  const barrier = readLearningRestoreBarrier(f.store.paths); assert.equal(barrier.liveVersions.length, 0);
  fs.copyFileSync(backup, f.store.filePath); f.store.open();
  const result = f.store.restoreBarrier(barrier);
  assert.equal(result.withdrawnVersions, 1); assert.equal(f.store.hasEnabledConsent(), false);
  assert.equal(f.store.settings("agent-one").config.mode, "off"); assert.equal(f.store.budget("agent-one").tokens, 203);
  assert.throws(() => f.store.readFile("agent-one", skill.id, skill.head), { code: "LEARNING_VERSION_UNAVAILABLE" });
  assert.equal(f.store.job(skill.lastJobId).proposal, null);
}));
test("cleanup retries tombstoned package erasure and removes only expired unreferenced versions", () => withFixture(async f => {
  await f.enable(); await f.review(); const skill = f.store.allSkills("agent-one")[0];
  const remove = f.store._removePackage.bind(f.store); f.store._removePackage = () => { throw Error("fixture IO failure"); };
  f.store.revokeVersion("agent-one", skill.id, skill.head);
  assert.equal(f.store.meta("cleanupPending"), true);
  assert.throws(() => f.store.readFile("agent-one", skill.id, skill.head), { code: "LEARNING_VERSION_UNAVAILABLE" });
  f.store._removePackage = remove; f.store.cleanupPackages();
  assert.equal(fs.existsSync(f.store._versionRoot("agent-one", skill.id, skill.head)), false);
  const orphan = f.store._writePackage("agent-one", skill.id, f.proposal(), "unpublished");
  const root = f.store._versionRoot("agent-one", skill.id, orphan.hash);
  fs.utimesSync(root, new Date(f.store.now()), new Date(f.store.now()));
  f.store.cleanupPackages(); assert.equal(fs.existsSync(root), true);
  f.advance(8 * DAY_MS); f.store.cleanupPackages(); assert.equal(fs.existsSync(root), false);
}));
test("fourteen-day observation is separate from thirty-day archive", () => withFixture(async f => {
  await f.enable(); await f.review(); f.advance(15 * DAY_MS);
  assert.equal(f.store.skillsPage("agent-one").items[0].observation, "unused_14_days");
  f.service.curate("agent-one"); assert.equal(f.store.allSkills("agent-one")[0].archived, false);
}));
test("review-only mode suggests archive without mutating skills", () => withFixture(async f => {
  await f.enable(); await f.review();
  await f.service.handle("learning.configure", { profileId: "agent-one", expectedRevision: 1, patch: { mode: "review" } });
  f.advance(31 * DAY_MS); f.service.curate("agent-one");
  assert.equal(f.store.allSkills("agent-one")[0].archived, false);
  assert.equal(f.service.status("agent-one").curation[0].kind, "archive_suggestion");
}));
test("public DTOs reject private runtime metadata and manual requests explain insufficient evidence", () => withFixture(async f => {
  await f.enable(); f.events.splice(1, 1);
  assert.equal(f.service.request("agent-one", "run-one").state, "insufficient_evidence"); assert.equal(f.calls(), 0);
  const status = f.service.status("agent-one"); status.capability.runtimeAccountId = "private-account";
  assert.throws(() => validateResult("learning.status", status), { code: "LEARNING_OUTPUT_INVALID" });
}));
test("corrupt usage receipts fail closed", () => withFixture(async f => {
  await f.enable(); await f.review(); await f.service.close();
  f.store.db.prepare("UPDATE calls SET charge=-1").run(); f.store.close();
  assert.throws(() => f.store.open(), { code: "LEARNING_STORE_CORRUPT" }); assert.equal(f.store.db, null);
}));
test("namespaced or wrapped derived reads and truncated results are never verification", () => withFixture(async f => {
  const tool = f.events[1].content.tool;
  for (const name of ["shoggoth/skill_read", "mcp__shoggoth__memory_search", "shoggoth__conversation_search", "shoggoth/federation_task_get", "call_mcp_tool"]) {
    tool.name = name;
    assert.throws(() => f.sources.readRun("agent-one", "run-one"), { code: "LEARNING_SOURCE_UNAVAILABLE" });
  }
  tool.displayArgs = { toolName: "mcp__shoggoth__skill_read" };
  assert.throws(() => f.sources.readRun("agent-one", "run-one"), { code: "LEARNING_SOURCE_UNAVAILABLE" });
  tool.name = "command"; tool.resultTruncated = true;
  assert.throws(() => f.sources.readRun("agent-one", "run-one"), { code: "LEARNING_SOURCE_UNAVAILABLE" });
}));
test("noop completes quietly without creating a Skill", () => withFixture(async f => {
  await f.enable(); f.setMode("noop"); const job = await f.review();
  assert.equal(job.state, "noop"); assert.equal(f.calls(), 1);
  assert.equal(f.store.allSkills("agent-one").length, 0); assert.equal(f.notices.length, 0);
}));

(async () => { for (const [name, fn] of cases) { await fn(); console.log(`PASS ${name}`); }
  console.log(`${cases.length} self-improvement tests passed`); })().catch(error => { console.error(error); process.exitCode = 1; });
