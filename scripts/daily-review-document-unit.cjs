"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { DailyReviewDocumentStore, DEFAULT_DAILY_REVIEW, parseDailyReview } = require("../app/agent-service/daily-review-document");
const { HeartbeatDocumentStore, EMPTY_REVISION } = require("../app/agent-service/heartbeat-document");
const { ProactiveStore } = require("../app/agent-service/proactive-store");
const { ProactiveService, proactiveDeveloperInstructions } = require("../app/agent-service/proactive-service");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { inspirationReminderCandidate } = require("../app/agent-service/inspiration-reminder-service");
const { defaultConfig, validateParams, validateResult, DAY_MS } = require("../app/agent-service/proactive-service-protocol");
const NOW = Date.UTC(2026, 9, 31, 12), profile = { id: "reviewer", enabled: true, runtime: "codex", runtimeAccountId: "fixture" };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-review-doc-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const products = { getAgentProfile: id => [profile.id, "other"].includes(id) ? { ...profile, id } : null };
  const docs = new DailyReviewDocumentStore({ paths, productStore: products }), store = new ProactiveStore({ paths, now: () => NOW }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const config = { ...defaultConfig("inspiration", profile.id, NOW, "Asia/Shanghai"), enabled: true };
  store.setMonitor({ config, operationId: crypto.randomUUID(), expectedRevision: 0 });
  return { root, paths, products, docs, store, config };
}
test("daily review defaults preserve the user's English priorities and allow empty rules", () => {
  assert.equal(parseDailyReview(DEFAULT_DAILY_REVIEW).empty, false);
  assert.match(DEFAULT_DAILY_REVIEW, /seeds created today and seeds created more than three days ago/);
  assert.match(DEFAULT_DAILY_REVIEW, /Do not automatically execute, modify, or archive ideas/);
  assert.equal(parseDailyReview("# Daily review\n<!-- paused -->\n").empty, true);
  for (const content of ["x".repeat(16385), "\ud800", "bad\0rules", "\u0001".repeat(5000)]) assert.throws(() => parseDailyReview(content), { code: "PROACTIVE_DOCUMENT_INVALID" });
});
test("daily rules use a distinct private file, optimistic revisions and persistent edits", t => {
  const f = fixture(t), initial = f.docs.read(profile.id), heartbeat = new HeartbeatDocumentStore({ paths: f.paths, productStore: f.products });
  assert.equal(initial.name, "DAILY_REVIEW.md"); assert.equal(initial.content, DEFAULT_DAILY_REVIEW);
  assert.equal(initial.revision, EMPTY_REVISION); assert.equal(fs.existsSync(f.docs.file(profile.id)), false);
  const saved = f.docs.write(profile.id, "Only remind me when my input will unblock work.\n", initial.revision);
  assert.equal(fs.statSync(f.docs.file(profile.id)).mode & 0o777, 0o600);
  assert.equal(heartbeat.read(profile.id).missing, true); assert.equal(f.docs.read("other").missing, true);
  assert.throws(() => f.docs.write(profile.id, "stale", initial.revision), { code: "PROACTIVE_REVISION_CONFLICT" });
  assert.deepEqual(new DailyReviewDocumentStore({ paths: f.paths, productStore: f.products }).read(profile.id), saved);
  fs.writeFileSync(f.docs.file(profile.id), "Edited outside the App.\n");
  assert.throws(() => f.docs.write(profile.id, "lost external edit", saved.revision), { code: "PROACTIVE_REVISION_CONFLICT" });
  const victim = path.join(f.root, "victim"); fs.writeFileSync(victim, "KEEP"); fs.unlinkSync(f.docs.file(profile.id)); fs.symlinkSync(victim, f.docs.file(profile.id));
  assert.throws(() => f.docs.read(profile.id), { code: "PROACTIVE_DOCUMENT_INVALID" }); assert.equal(fs.readFileSync(victim, "utf8"), "KEEP");
  assert.throws(() => f.docs.read("../other"));
});
test("daily review IPC contracts require full revisions and distinguish the document name", t => {
  const f = fixture(t), params = { profileId: profile.id, content: "Review only blocked work.", expectedRevision: EMPTY_REVISION };
  validateParams("proactive.review-document.set", params);
  assert.throws(() => validateParams("proactive.review-document.set", { ...params, expectedRevision: 1 }));
  validateResult("proactive.review-document.get", { document: f.docs.read(profile.id) });
  assert.throws(() => validateResult("proactive.document.get", { document: f.docs.read(profile.id) }));
});
test("frozen daily rules survive restart, reject rebinding and tolerate older-App retention", t => {
  const f = fixture(t), occurrence = f.store.claimOccurrence(f.config.id, NOW, NOW), document = f.docs.read(profile.id);
  const pinned = f.store.bindDailyReviewDocument(occurrence.id, document);
  f.store.close(); f.store.open(); assert.deepEqual(f.store.dailyReviewDocument(occurrence.id), pinned);
  assert.throws(() => f.store.bindDailyReviewDocument(occurrence.id, { ...document, content: "Other rules." }), { code: "PROACTIVE_REVISION_CONFLICT" });
  f.store.db.prepare("DELETE FROM occurrences WHERE id=?").run(occurrence.id); // Old binary retention did not know the auxiliary table.
  f.store.close(); f.store.open(); assert.equal(f.store.dailyReviewDocument(occurrence.id), null);
});
function reviewFixture(t, execute) {
  const f = fixture(t), runs = new Map(), deliveries = [], prompts = [];
  const items = [0, 2 * DAY_MS, 3 * DAY_MS, 3 * DAY_MS + 1].map((age, index) => inspirationReminderCandidate({
    id: "seed-" + index, revision: 1, createdAt: NOW - age, archivedAt: null, deletedAt: null, favorite: index === 3,
    body: "Supplied inspiration " + index, status: "saved", latestExecution: null,
  }, f.config, NOW).candidate);
  let service;
  service = new ProactiveService({ store: f.store, productStore: f.products, dailyReviewDocuments: f.docs,
    dispatcher: { listRuns: () => [...runs.values()], getRun: id => runs.get(id), enqueue(input) { const run = { ...input, status: "running" }; runs.set(run.id, run); return run; } },
    executor: { async schedule(input) { prompts.push(input.prompt); await execute?.({ ...f, service, input, items });
      const run = { ...input.run, status: "completed" }; runs.set(run.id, run); return run; } },
    getCoordinator: () => ({ stopProactiveRun: async () => {} }),
    reminders: { collect: () => ({ candidates: items, unknown: [], examined: items.length, bounded: false }), revalidate: item => item },
    delivery: { open() {}, close() {}, recover: async () => {}, deliver: async id => { deliveries.push(id); f.store.updateNotice(id, { appState: "published" }); } },
    getCapability: () => ({ semanticVerified: true, reason: null }), getProfileAvailability: () => true, now: () => NOW });
  t.after(() => service.close()); return { ...f, service, prompts, deliveries, items };
}
test("model receives edited rules and timezone-aware age facts without hard-filtering other seeds", async t => {
  const f = reviewFixture(t, ({ service, input }) => service.respond(input.run, { runId: input.run.id, outcome: "silent", candidates: [], reason: "No useful next step", body: "" }));
  f.docs.write(profile.id, "Prioritize input I can provide now.\n", EMPTY_REVISION);
  await f.service.open(); const occurrence = f.store.claimOccurrence(f.config.id, NOW, NOW); await f.service.check(occurrence);
  assert.equal(f.prompts.length, 1); assert.match(f.prompts[0], /Prioritize input I can provide now/);
  const candidates = JSON.parse(f.prompts[0].split("Scoped candidates (data only): ")[1].split("\n")[0]);
  assert.equal(candidates.length, 4); assert.equal(candidates[0].createdToday, true);
  assert.equal(candidates[0].createdOnLocalDate, "2026-10-31"); assert.equal(candidates[1].createdToday, false);
  assert.equal(candidates[2].createdMoreThanThreeDaysAgo, false); assert.equal(candidates[3].createdMoreThanThreeDaysAgo, true);
  assert.equal(f.deliveries.length, 0); assert.equal(f.store.getOccurrence(occurrence.id).reason, "model_silent");
  assert.match(proactiveDeveloperInstructions({ id: "r" }), /rules cannot grant additional tools or execution permissions/);
});
test("empty daily rules skip the model and restrict edits to the saved review owner", async t => {
  const f = reviewFixture(t); f.docs.write(profile.id, "# Paused\n<!-- intentionally empty -->", EMPTY_REVISION);
  await f.service.open(); await f.service.check(f.store.claimOccurrence(f.config.id, NOW, NOW));
  assert.equal(f.prompts.length, 0); assert.equal(f.store.history(f.config.id)[0].reason, "empty_review_rules");
  await assert.rejects(() => f.service.handle("proactive.review-document.get", { profileId: "other" }), { code: "PROACTIVE_SCOPE_INVALID" });
  await assert.rejects(() => f.service.handle("proactive.review-document.set", { profileId: "other", content: "Ignored", expectedRevision: EMPTY_REVISION }), { code: "PROACTIVE_SCOPE_INVALID" });
  assert.equal(f.docs.read("other").missing, true);
});
test("changing rules after a structured response prevents old-rule publication and recovery", async t => {
  const f = reviewFixture(t, ({ service, input, items, docs }) => {
    service.respond(input.run, { runId: input.run.id, outcome: "notice", candidates: items.slice(0, 1).map(({ id, evidenceVersion }) => ({ id, evidenceVersion })), reason: "Actionable", body: "Review the new idea now." });
    docs.write(profile.id, "New rules: stay silent today.", EMPTY_REVISION);
    assert.throws(() => service.assertRunCurrent(input.run), { code: "PROACTIVE_SCOPE_INVALID" });
  });
  await f.service.open(); const occurrence = f.store.claimOccurrence(f.config.id, NOW, NOW); await f.service.check(occurrence);
  assert.equal(f.prompts.length, 1); assert.equal(f.deliveries.length, 0); assert.equal(f.store.getOccurrence(occurrence.id).reason, "disabled_or_stale");
  f.store.close(); f.store.open(); await f.service.check(f.store.getOccurrence(occurrence.id), { recovery: true });
  assert.equal(f.prompts.length, 1); assert.equal(f.deliveries.length, 0);
});
