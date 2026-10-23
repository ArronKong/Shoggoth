"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ProactiveStore } = require("../app/agent-service/proactive-store");
const { ProactiveService } = require("../app/agent-service/proactive-service");
const { ProactiveScheduler, latestOccurrence } = require("../app/agent-service/proactive-scheduler");
const { NoticeDeliveryController } = require("../app/agent-service/notice-delivery-controller");
const { inspirationReminderCandidate, InspirationReminderService } = require("../app/agent-service/inspiration-reminder-service");
const { defaultConfig, DAY_MS, digest, validateResult, validateConfig } = require("../app/agent-service/proactive-service-protocol");
const { notificationPolicy } = require("../app/agent-service/notification-policy");
const { createNativeNotificationSender } = require("../app/agent-service/native-notification-sender");
const { createAuthorityBackup, restoreAuthorityBackup } = require("../app/agent-service/authority-backup");
const uuid = () => crypto.randomUUID();
const NOW = Date.UTC(2026, 8, 29, 10);
const profile = { id: "profile-review", backendId: "shoggoth", agentId: "review", name: "Review", enabled: true, runtime: "codex", runtimeAccountId: "account-review" };
function idea(status = "completed", patch = {}) {
  return { id: uuid(), revision: 1, createdAt: NOW - 10 * DAY_MS, updatedAt: NOW, archivedAt: null,
    deletedAt: null, favorite: false, body: "一个可以回顾的想法", title: "", status,
    latestExecution: status === "saved" ? null : { id: uuid(), runId: uuid(), status,
      backendId: "shoggoth", agentId: "review", finishedAt: NOW - 3 * DAY_MS, errorCode: null, resultSummary: "" }, ...patch };
}
function reviewConfig() { return { ...defaultConfig("inspiration", profile.id, NOW, "UTC"), enabled: true }; }
function candidate(value, config = reviewConfig(), now = NOW) { return inspirationReminderCandidate(value, config, now).candidate; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-proactive-"));
  const clock = { value: NOW };
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const store = new ProactiveStore({ paths, now: () => clock.value }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const save = config => store.setMonitor({ operationId: uuid(), expectedRevision: store.getMonitor(config.id)?.revision ?? 0, config });
  const claim = config => { save(config); return store.claimOccurrence(config.id, clock.value, clock.value); };
  return { root, paths, store, clock, save, claim };
}
test("sprouted uses the product result state and a full three-day stage, regardless of summary or artifacts", () => {
  const note = idea();
  assert.equal(candidate(note).group, "sprouted");
  assert.equal(candidate({ ...note, acceptedAt: NOW }).group, "sprouted");
  assert.equal(candidate(note, reviewConfig(), NOW - 1), null);
  assert.equal(candidate({ ...note, archivedAt: NOW }), null);
  assert.equal(candidate({ ...note, deletedAt: NOW }), null);
  assert.equal(candidate({ ...note, updatedAt: NOW + DAY_MS }).enteredAt, note.latestExecution.finishedAt);
  assert.equal(candidate({ ...note, restoredAt: NOW }), null);
  assert.equal(candidate({ ...note, restoredAt: NOW }, reviewConfig(), NOW + 3 * DAY_MS).enteredAt, NOW);
  assert.equal(candidate({ ...note, latestExecution: { ...note.latestExecution, status: "running" } }), null);
  assert.equal(candidate({ ...note, latestExecution: { ...note.latestExecution, finishedAt: NOW } }), null);
  assert.equal(inspirationReminderCandidate({ ...note, latestExecution: { ...note.latestExecution, finishedAt: null } }, reviewConfig(), NOW).unknown.reason, "stage_time_unknown");
});
test("only live matching approval/input requests and definite failure become attention", () => {
  for (const status of ["waiting_approval", "waiting_input"]) {
    const note = idea(status);
    const request = { requestId: uuid(), runId: note.latestExecution.runId, kind: status === "waiting_input" ? "user_input" : "approval", expiresAt: NOW + 1, title: "确认继续" };
    note.latestExecution.attention = { active: true, request, occurredAt: NOW - DAY_MS };
    assert.equal(candidate(note).reason, status);
    assert.equal(candidate(note, reviewConfig(), NOW + 1), null);
    assert.equal(candidate({ ...note, latestExecution: { ...note.latestExecution, attention: { ...note.latestExecution.attention, active: false } } }), null);
    assert.equal(candidate({ ...note, latestExecution: { ...note.latestExecution, attention: { ...note.latestExecution.attention, request: { ...request, runId: uuid() } } } }), null);
  }
  assert.equal(candidate(idea("failed")).reason, "execution_failed");
  assert.equal(candidate(idea("canceled")), null);
  const unknown = idea("failed"); unknown.latestExecution.errorCode = "RUNTIME_ACCEPTANCE_UNCERTAIN";
  assert.equal(inspirationReminderCandidate(unknown, reviewConfig(), NOW).unknown.reason, "execution_needs_verification");
  assert.equal(candidate(idea("saved")).group, "seed");
  assert.equal(candidate(idea("saved", { createdAt: NOW - DAY_MS + 1 })), null);
});
test("exact seven-day cooldown survives reboot, changes of Agent/category/timezone and note controls", t => {
  const ctx = fixture(t), config = reviewConfig(), note = idea(), item = candidate(note);
  const occurrence = ctx.claim(config);
  const notice = ctx.store.reserveNotice(occurrence, { title: "回顾", body: "已有产出", items: [item], now: NOW, timezone: "UTC", dayKey: "2026-09-29" }, () => true);
  assert.equal(ctx.store.getNote(note.id).noticeId, notice.id);
  assert.equal(ctx.store.ideaEligible(note.id, NOW + 6 * DAY_MS), false);
  assert.equal(ctx.store.ideaEligible(note.id, NOW + 7 * DAY_MS - 1), false);
  assert.equal(ctx.store.ideaEligible(note.id, NOW + 7 * DAY_MS), true);
  assert.equal(ctx.store.ideaEligible(note.id, NOW - DAY_MS), false);
  ctx.store.close(); ctx.store.open();
  assert.equal(ctx.store.ideaEligible(note.id, NOW + 6 * DAY_MS), false);
  const prior = ctx.store.getNote(note.id);
  ctx.store.setNote({ operationId: uuid(), id: note.id, expectedRevision: prior.revision, patch: { snoozedUntil: NOW + 14 * DAY_MS } });
  assert.equal(ctx.store.ideaEligible(note.id, NOW + 7 * DAY_MS), false);
  assert.equal(ctx.store.ideaEligible(note.id, NOW + 14 * DAY_MS), true);
  const operation = { operationId: uuid(), id: note.id, expectedRevision: ctx.store.getNote(note.id).revision, patch: { disabled: true } };
  assert.deepEqual(ctx.store.setNote(operation), ctx.store.setNote(operation));
  assert.throws(() => ctx.store.setNote({ ...operation, patch: { disabled: false } }), { code: "PROACTIVE_OPERATION_CONFLICT" });
  assert.equal(ctx.store.ideaEligible(note.id, NOW + 30 * DAY_MS), false);
  ctx.store.purgeProfile(profile.id);
  assert.equal(ctx.store.getNote(note.id).lastRemindedAt, NOW);
});
test("one daily digest and one occurrence reservation, even when concurrent checks change profile", async t => {
  const ctx = fixture(t), config = reviewConfig();
  const first = ctx.claim(config), items = [candidate(idea())];
  const reserve = occurrence => ctx.store.reserveNotice(occurrence, { title: "回顾", body: "回顾便签", items, now: ctx.clock.value, timezone: "UTC", dayKey: "2026-09-29" }, () => true);
  const [a, b] = await Promise.all([Promise.resolve().then(() => reserve(first)), Promise.resolve().then(() => reserve(first))]);
  assert.equal(a.id, b.id);
  ctx.clock.value++;
  const second = ctx.claim({ ...config, profileId: "other-profile", timezone: "Asia/Shanghai", schedule: { kind: "cron", expr: "0 10 * * *", tz: "Asia/Shanghai" } });
  assert.equal(reserve(second), null);
});
function deliveryFixture(ctx, send = async () => ({ state: "submitted" })) {
  const sessions = new Map(), events = [], calls = [];
  let valid = true;
  const sessionStore = { getSession: key => sessions.get(key), getCreateOperation: () => null,
    createSession(input) { const value = { ...input, id: uuid(), sessionKey: uuid(), status: "draft" }; sessions.set(value.sessionKey, value); return value; },
    touchSession() {} };
  const delivery = new NoticeDeliveryController({ store: ctx.store, productStore: { getAgentProfile: () => profile }, chatSessionStore: sessionStore,
    transcriptStore: { ensureSession() {}, listEvents: () => events, appendEvent: event => events.push(event) },
    readConfig: () => ({ notifications: { proactive: true } }), validateNotice: () => valid,
    sendSystemNotice: async input => { calls.push(input); return send(input); }, now: () => ctx.clock.value });
  const config = reviewConfig(), occurrence = ctx.claim(config);
  const notice = ctx.store.reserveNotice(occurrence, { title: "回顾", body: "回顾便签", items: [candidate(idea())], now: NOW, timezone: "UTC" }, () => true);
  return { delivery, notice, sessions, events, calls, setValid(value) { valid = value; } };
}
test("notice outbox recovers exactly one app event and never retries uncertain native submission", async t => {
  const ctx = fixture(t), f = deliveryFixture(ctx, async () => undefined);
  await f.delivery.deliver(f.notice.id); await f.delivery.recover();
  assert.equal(f.events.length, 1); assert.equal(f.calls.length, 1);
  assert.equal(ctx.store.getNotice(f.notice.id).systemState, "needs_verification");
  ctx.store.updateNotice(f.notice.id, { appState: "publishing", systemState: "submitting" });
  await f.delivery.recover();
  assert.equal(f.events.length, 1); assert.equal(f.calls.length, 1);
  f.delivery.close(); f.delivery.open(); await f.delivery.recover();
  assert.equal(f.events.length, 1);
});
test("deleted dedicated target remains a tombstone; invalid sources create no chat", async t => {
  const ctx = fixture(t), f = deliveryFixture(ctx);
  f.setValid(false); await f.delivery.deliver(f.notice.id); assert.equal(f.sessions.size, 0);
  f.setValid(true); ctx.store.updateNotice(f.notice.id, { appState: "pending", systemState: "pending" });
  await f.delivery.deliver(f.notice.id); assert.equal(f.sessions.size, 1);
  f.sessions.clear(); ctx.store.updateNotice(f.notice.id, { appState: "publishing" });
  await f.delivery.deliver(f.notice.id); assert.equal(f.sessions.size, 0);
  assert.equal(ctx.store.getTarget(profile.id).deleted, true);
  ctx.store.close(); ctx.store.open(); assert.equal(ctx.store.getTarget(profile.id).deleted, true);
});
test("all SparkNotes groups require model judgment; silent and unverified reviews publish nothing", async t => {
  const ctx = fixture(t), config = { ...reviewConfig(), budget: { maxRunsPerDay: 4, maxTokensPerDay: 20000 } };
  const items = [candidate(idea("failed")), candidate(idea("saved")), candidate(idea())];
  const original = { id: "pending-task", profileId: profile.id, status: "waiting_approval" };
  const runs = new Map([[original.id, original]]), deliveries = []; let modelTurns = 0, verified = false, outcome = "silent", stale = false;
  let service;
  service = new ProactiveService({ store: ctx.store, productStore: { getAgentProfile: () => profile },
    dispatcher: { listRuns: () => [...runs.values()], getRun: id => runs.get(id), enqueue(input) { const run = { ...input, status: "running" }; runs.set(run.id, run); return run; } },
    executor: { async schedule(input) {
      modelTurns++; assert.ok(input.prompt.includes('"group":"attention"') && input.prompt.includes('"group":"sprouted"') && input.prompt.includes('"group":"seed"'));
      service.respond(input.run, { runId: input.run.id, outcome,
        candidates: outcome === "silent" ? [] : items.slice(1).map(({ id, evidenceVersion }) => ({ id, evidenceVersion })), reason: "Model judgment", body: outcome === "silent" ? "" : "Only the selected two notes merit a reminder" });
      const completed = { ...input.run, status: "completed" }; runs.set(completed.id, completed); return completed;
    } }, getCoordinator: () => ({ stopProactiveRun: async () => assert.fail("Do not stop the original task") }),
    reminders: { collect: () => ({ candidates: items, unknown: [], examined: 3, bounded: false }), revalidate: item => stale ? null : item },
    delivery: { open() {}, close() {}, recover: async () => {}, deliver: async id => { deliveries.push(id); ctx.store.updateNotice(id, { appState: "published" }); } },
    getCapability: () => ({ semanticVerified: verified, reason: null }), getProfileAvailability: () => true, now: () => ctx.clock.value });
  await service.open(); let occurrence = ctx.claim(config); await service.check(occurrence);
  assert.equal(modelTurns, 0); assert.equal(deliveries.length, 0); assert.equal(ctx.store.getOccurrence(occurrence.id).reason, "runtime_unverified");
  verified = true; ctx.clock.value++; occurrence = ctx.claim(config); await service.check(occurrence);
  assert.equal(modelTurns, 1); assert.equal(deliveries.length, 0); assert.equal(ctx.store.getOccurrence(occurrence.id).reason, "model_silent");
  outcome = "notice"; ctx.clock.value++; occurrence = ctx.claim(config); await service.check(occurrence);
  assert.equal(modelTurns, 2); assert.equal(deliveries.length, 1);
  assert.deepEqual(ctx.store.getNotice(deliveries[0]).items.map(item => item.group), ["seed", "sprouted"]);
  assert.equal(ctx.store.getNotice(deliveries[0]).title, "SparkNotes");
  stale = true; ctx.clock.value += DAY_MS; occurrence = ctx.claim(config); await service.check(occurrence);
  assert.equal(ctx.store.getOccurrence(occurrence.id).reason, "source_changed"); assert.equal(deliveries.length, 1);
  assert.equal(original.status, "waiting_approval"); await service.close();
});
test("maximum checklist and scoped state fit IPC, persist once, and publish a maximum model body only once", async t => {
  const ctx = fixture(t), runs = new Map(); let turns = 0, prompt = "";
  for (let index = 0; index < 32; index++) {
    const id = `run-${index}-${"x".repeat(116)}`;
    runs.set(id, { id, profileId: profile.id, source: "chat", status: "completed", eventSeq: index,
      resultSummary: "已有输出🌱".repeat(200) });
  }
  const config = validateConfig({ ...defaultConfig("heartbeat", profile.id, NOW, "UTC"), enabled: true, activeHours: null,
    scopes: { inspiration: false, runIds: [...runs.keys()] }, checklist: Array.from({ length: 24 }, (_, index) => ({
      id: `review-${index}`, instruction: `Review item ${index}: ` + "检查已有状态".repeat(18), enabled: true, mode: "review" })) });
  const body = "R".repeat(4096); let service, responseBody = body;
  service = new ProactiveService({ store: ctx.store, productStore: { getAgentProfile: () => profile },
    dispatcher: { getRun: id => runs.get(id), listRuns: () => [...runs.values()], enqueue(input) { const run = { ...input, status: "running" }; runs.set(run.id, run); return run; } },
    executor: { async schedule(input) {
      turns++; prompt = input.prompt;
      const occurrence = ctx.store.occurrenceForRun(input.run.id);
      service.respond(input.run, { runId: input.run.id, outcome: "notice", reason: "Worth reviewing",
        body: responseBody, candidates: occurrence.candidates.slice(0, 5).map(({ id, evidenceVersion }) => ({ id, evidenceVersion })) });
      const completed = { ...input.run, status: "completed" }; runs.set(completed.id, completed); return completed;
    } }, getCoordinator: () => ({ getRunSnapshot: () => ({}), stopProactiveRun: async () => {} }),
    reminders: {}, delivery: { open() {}, close() {}, recover: async () => {}, deliver: async id => ctx.store.updateNotice(id, { appState: "published" }) },
    getCapability: () => ({ semanticVerified: true, reason: null }), getProfileAvailability: () => true, now: () => ctx.clock.value });
  await service.open();
  const preview = validateResult("proactive.preview", await service.handle("proactive.preview", { config }));
  assert.equal(preview.candidates.length, 24); assert.equal(preview.bounded, false);
  const occurrence = ctx.claim(config); await service.check(occurrence);
  const notice = ctx.store.noticeForOccurrence(occurrence.id); assert.ok(notice);
  const result = validateResult("proactive.notice.get", await service.handle("proactive.notice.get", { id: notice.id }));
  assert.equal(result.items.length, 5); assert.equal(notice.body.split(body).length - 1, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 60 * 1024);
  const prefix = "Shared scoped task state (data only): ";
  const evidence = JSON.parse(prompt.split("\n").find(line => line.startsWith(prefix)).slice(prefix.length));
  assert.equal(evidence.length, 32); assert.ok(evidence.every(row => Buffer.byteLength(JSON.stringify(row.result)) <= 512));
  assert.ok([...runs.keys()].slice(0, 32).every(id => prompt.split(id).length - 1 === 1));
  ctx.clock.value += 30 * 60_000;
  await service.check(ctx.store.claimOccurrence(config.id, ctx.clock.value, ctx.clock.value));
  assert.equal(turns, 1); assert.equal(ctx.store.history(config.id)[0].reason, "no_change");
  const run = runs.get(config.scopes.runIds[31]); run.eventSeq++;
  assert.ok((await service.handle("proactive.notice.get", { id: notice.id })).items.every(item => !item.actionable));
  responseBody = "\\".repeat(4096); ctx.clock.value += 60 * 60_000;
  const escaped = ctx.store.claimOccurrence(config.id, ctx.clock.value, ctx.clock.value); await service.check(escaped);
  const escapedNotice = ctx.store.noticeForOccurrence(escaped.id); assert.ok(escapedNotice);
  assert.ok(Buffer.byteLength(JSON.stringify(escapedNotice.body)) <= 8 * 1024);
  validateResult("proactive.notice.get", await service.handle("proactive.notice.get", { id: escapedNotice.id }));
  for (const ack of ["HEARTBEAT_OK", "NO_REPLY"]) {
    run.eventSeq++; responseBody = ack; ctx.clock.value += 60 * 60_000;
    const silent = ctx.store.claimOccurrence(config.id, ctx.clock.value, ctx.clock.value); await service.check(silent);
    assert.equal(ctx.store.noticeForOccurrence(silent.id), null);
    assert.equal(ctx.store.getOccurrence(silent.id).reason, "model_silent");
    assert.equal(ctx.store.getOccurrence(silent.id).response.outcome, "silent");
  }
  await service.close();
});
test("model-selected heartbeat reminders reach every authorized failed run before repeating older reminders", async t => {
  const ctx = fixture(t), runs = new Map(Array.from({ length: 32 }, () => {
    const id = uuid(); return [id, { id, profileId: profile.id, source: "chat", status: "failed", eventSeq: 1, finishedAt: NOW - DAY_MS }];
  }));
  const config = { ...defaultConfig("heartbeat", profile.id, NOW, "UTC"), enabled: true, activeHours: null,
    scopes: { inspiration: false, runIds: [...runs.keys()] }, checklist: [{ id: "attention", instruction: "Remind me about pending tasks", mode: "attention", enabled: true }] };
  const uncertain = [...runs.values()].at(-1); uncertain.errorCode = "RUNTIME_ACCEPTANCE_UNCERTAIN";
  const seen = new Set();
  let service;
  service = new ProactiveService({ store: ctx.store, productStore: { getAgentProfile: () => profile },
    dispatcher: { getRun: id => runs.get(id), listRuns: () => [...runs.values()], enqueue(input) { const run = { ...input, status: "running" }; runs.set(run.id, run); return run; } },
    executor: { async schedule({ run }) {
      const occurrence = ctx.store.occurrenceForRun(run.id);
      service.respond(run, { runId: run.id, outcome: "notice", candidates: occurrence.candidates.slice(0, 5).map(({ id, evidenceVersion }) => ({ id, evidenceVersion })), reason: "Selected tasks need attention", body: "Review these selected tasks" });
      const completed = { ...run, status: "completed" }; runs.set(completed.id, completed); return completed;
    } },
    getCoordinator: () => ({ getRunSnapshot: () => ({}), getRunSessionKey: () => null }), reminders: {},
    delivery: { open() {}, close() {}, recover: async () => {}, deliver: async id => {
      const notice = ctx.store.getNotice(id); notice.items.forEach(item => seen.add(item.runId)); ctx.store.updateNotice(id, { appState: "published" });
    } }, getCapability: () => ({ semanticVerified: true, reason: null }), getProfileAvailability: () => true, now: () => ctx.clock.value });
  await service.open(); ctx.save(config);
  for (let tick = 0; tick < 7; tick++) {
    await service.check(ctx.store.claimOccurrence(config.id, ctx.clock.value, ctx.clock.value));
    ctx.clock.value += 30 * 60_000;
  }
  assert.equal(seen.size, 31); assert.equal(seen.has(uncertain.id), false);
  uncertain.errorCode = null; uncertain.eventSeq++;
  await service.check(ctx.store.claimOccurrence(config.id, ctx.clock.value, ctx.clock.value));
  assert.equal(seen.size, 32); await service.close();
});
test("sleep coalesces missed ticks, clock rollback and duplicate ticks do not replay an occurrence", async t => {
  const ctx = fixture(t); const config = { ...defaultConfig("heartbeat", profile.id, NOW, "UTC"), enabled: true, activeHours: null };
  ctx.save(config); const checks = [];
  const scheduler = new ProactiveScheduler({ store: ctx.store, now: () => ctx.clock.value,
    setTimer: () => 1, clearTimer() {}, service: { delivery: { recover: async () => {} }, async check(value) {
      checks.push(value); ctx.store.updateOccurrence(value.id, { state: "silent", reason: "empty_checklist", finishedAt: ctx.clock.value });
    } } });
  await scheduler.open(); ctx.clock.value += 10 * DAY_MS;
  await scheduler.tick(); await scheduler.waitForIdle(); await scheduler.tick(); await scheduler.waitForIdle();
  assert.equal(checks.length, 1); assert.equal(checks[0].scheduledAt, ctx.clock.value);
  ctx.clock.value -= DAY_MS; await scheduler.tick(); await scheduler.waitForIdle(); assert.equal(checks.length, 1);
  await scheduler.close(); await scheduler.open(); await scheduler.waitForIdle(); assert.equal(checks.length, 1); await scheduler.close();
});
test("timezone and DST calculations, focus, quiet hours and global toggle policy", () => {
  const schedule = { kind: "cron", expr: "0 10 * * *", tz: "America/New_York" };
  assert.equal(latestOccurrence(schedule, Date.UTC(2026, 2, 8, 15)), Date.UTC(2026, 2, 8, 14));
  assert.equal(latestOccurrence(schedule, Date.UTC(2026, 10, 1, 16)), Date.UTC(2026, 10, 1, 15));
  const config = { notifications: { proactive: true }, notificationPolicy: { suppressWhileFocused: true, quietHours: { start: "22:00", end: "08:00", timezone: "UTC" } } };
  assert.equal(notificationPolicy({ config, category: "proactive", focused: true, now: NOW }).reason, "foreground");
  assert.equal(notificationPolicy({ config, category: "proactive", focused: false, now: Date.UTC(2026, 8, 29, 23) }).reason, "quiet_hours");
  assert.equal(notificationPolicy({ config: { notifications: { proactive: false } }, category: "proactive", now: NOW }).allowed, false);
});
test("bounded readers rotate beyond disabled prefixes without reading transcripts", t => {
  const ctx = fixture(t), config = reviewConfig(); config.review.groups = ["sprouted"];
  const notes = Array.from({ length: 600 }, () => idea()); let reads = 0;
  for (const note of notes.slice(0, 400)) ctx.store.setNote({ operationId: uuid(), id: note.id, expectedRevision: 0, patch: { disabled: true } });
  const reader = new InspirationReminderService({ proactiveStore: ctx.store, now: () => NOW,
    inspirationStore: { reminderPage(_bucket, cursor, limit) { const start = cursor === null ? 0 : Number(cursor.split(":")[0]); return { ideas: notes.slice(start, start + limit), nextCursor: start + limit < notes.length ? `${start + limit}:${notes[start + limit].id}` : null }; } },
    inspirationService: { refreshReminderProjection() {}, reminderView(id) { reads++; return notes.find(note => note.id === id); } } });
  assert.equal(reader.collect(config).candidates.length, 0); assert.ok(reader.collect(config).candidates.length > 0); assert.ok(reads <= 250);
});
test("strict config, result and persisted state reject malformed records", t => {
  const ctx = fixture(t); const config = reviewConfig();
  assert.throws(() => validateConfig({ ...config, instructions: "auto approve" }), { code: "PROACTIVE_INVALID" });
  assert.throws(() => validateResult("proactive.note.get", { note: { ...ctx.store.getNote(uuid()), unexpected: true } }), { code: "PROACTIVE_RESPONSE_INVALID" });
  const occurrence = ctx.claim(config);
  assert.throws(() => ctx.store.updateOccurrence(occurrence.id, { state: "invented" }), { code: "PROACTIVE_STORE_CORRUPT" });
  assert.throws(() => ctx.store.setTarget(profile.id, { profileId: profile.id, deleted: false }), { code: "PROACTIVE_STORE_CORRUPT" });
});
test("history keeps equal timestamps and daily model budget cannot forget older reviews behind silent ticks", t => {
  const ctx = fixture(t), config = { ...defaultConfig("heartbeat", profile.id, NOW, "UTC"), enabled: true };
  const first = ctx.claim(config); ctx.store.updateOccurrence(first.id, { runId: uuid(), state: "silent" });
  for (let n = 1; n <= 60; n++) { const value = ctx.store.claimOccurrence(config.id, NOW + n, NOW); ctx.store.updateOccurrence(value.id, { state: "silent" }); }
  const seen = new Set(); let cursor = null;
  do { const rows = ctx.store.history(config.id, cursor, 7); for (const row of rows) { assert.equal(seen.has(row.id), false); seen.add(row.id); } cursor = rows.length === 7 ? `${rows.at(-1).createdAt}:${rows.at(-1).id}` : null; } while (cursor);
  assert.equal(seen.size, 61); assert.equal(ctx.store.countReviewAttempts(profile.id, NOW, "UTC"), 1);
  ctx.store.close(); ctx.store.open(); assert.equal(ctx.store.countReviewAttempts(profile.id, NOW, "UTC"), 1);
});
test("OS submission quotas persist through restart and defer only the system channel", t => {
  const ctx = fixture(t), config = { ...defaultConfig("heartbeat", profile.id, NOW, "UTC"), enabled: true };
  const notices = [];
  for (let n = 0; n < 5; n++) {
    const occurrence = n === 0 ? ctx.claim(config) : ctx.store.claimOccurrence(config.id, NOW + n, NOW);
    const notice = ctx.store.reserveNotice(occurrence, { title: "Check", body: "Review output", items: [candidate(idea())], now: NOW, timezone: "UTC" }, () => true);
    ctx.store.updateNotice(notice.id, { appState: "published" }); notices.push(notice);
  }
  for (const notice of notices.slice(0, 4)) assert.equal(ctx.store.beginSystemSubmission(notice.id, NOW).systemState, "submitting");
  assert.equal(ctx.store.beginSystemSubmission(notices[4].id, NOW), null);
  assert.equal(ctx.store.getNotice(notices[4].id).appState, "published");
  assert.equal(ctx.store.getNotice(notices[4].id).systemReason, "frequency_limit");
  ctx.store.close(); ctx.store.open();
  assert.equal(ctx.store.beginSystemSubmission(notices[4].id, NOW + 3_600_000 - 1), null);
  assert.equal(ctx.store.beginSystemSubmission(notices[4].id, NOW + 3_600_000).systemState, "submitting");
});
test("closing during pending outbox observation prevents late publication or native submission", async t => {
  const ctx = fixture(t), f = deliveryFixture(ctx);
  let release; f.delivery.isFocused = () => new Promise(resolve => { release = resolve; });
  const task = f.delivery.deliver(f.notice.id); await new Promise(resolve => setImmediate(resolve));
  f.delivery.close(); release(false); await task;
  assert.equal(f.calls.length, 0); assert.equal(ctx.store.getNotice(f.notice.id).systemState, "pending");
  f.delivery.isFocused = async () => false; f.delivery.open(); await f.delivery.recover();
  assert.equal(f.events.length, 1); assert.equal(f.calls.length, 1);
});
test("native notification factory respects focus/categories, deduplicates the Notice and preserves click target", async () => {
  const emitted = [], opened = []; let focused = true;
  class FakeNotification { static isSupported() { return true; } constructor(value) { this.value = value; this.handlers = {}; } on(event, handler) { this.handlers[event] = handler; } show() { emitted.push(this); } }
  const config = { notifications: { proactive: true } };
  const send = createNativeNotificationSender({ Notification: FakeNotification, readConfig: () => config, isFocused: async () => focused, now: () => NOW, openTarget: async input => { opened.push(input); } });
  const input = { noticeId: "notice-fixture", category: "proactive", title: "回顾", body: "已有产出", target: { kind: "chat", sessionKey: "fixture" } };
  assert.deepEqual(await send(input), { state: "suppressed", reason: "foreground" }); assert.equal(emitted.length, 0);
  focused = false; assert.deepEqual(await send(input), { state: "submitted" }); await send(input); assert.equal(emitted.length, 1);
  emitted[0].handlers.click(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(opened, [input]);
  config.notifications.proactive = false; assert.equal((await send({ ...input, noticeId: "other" })).state, "suppressed"); assert.equal(emitted.length, 1);
});
test("startup rejects indexed state tampering even if persisted JSON is otherwise valid", t => {
  const ctx = fixture(t), config = reviewConfig(); ctx.claim(config);
  ctx.store.db.prepare("UPDATE monitors SET enabled=0 WHERE id=?").run(config.id);
  ctx.store.close(); assert.throws(() => ctx.store.open(), { code: "PROACTIVE_STORE_CORRUPT" });
});
test("authority backup restores the seven-day cooldown, monitor and deleted target", t => {
  const ctx = fixture(t), f = deliveryFixture(ctx);
  ctx.store.setTarget(profile.id, { operationId: "deleted-reminder", profileId: profile.id, sessionKey: "deleted-session", createdAt: NOW, deleted: true });
  const { HeartbeatDocumentStore } = require("../app/agent-service/heartbeat-document");
  const documents = new HeartbeatDocumentStore({ paths: ctx.paths, productStore: { getAgentProfile: () => profile } });
  const saved = documents.write(profile.id, "Review releases and alert on changes.", documents.read(profile.id).revision);
  ctx.store.setHeartbeatScratch(profile.id, "Last seen release 3.", 0);
  const ideaId = f.notice.items[0].ideaId; ctx.store.close();
  const backupId = "proactive-reminders-fixture"; createAuthorityBackup({ paths: ctx.paths, backupId, now: () => NOW });
  const stateRoot = path.join(ctx.root, "restored-state"); restoreAuthorityBackup({ paths: ctx.paths, backupId, destinationStateDir: stateRoot });
  const paths = resolveServicePaths({ trustedRoot: ctx.root, stateRoot, profileRoot: ctx.paths.profileDir, cacheRoot: ctx.paths.cacheDir });
  const restored = new ProactiveStore({ paths, now: () => NOW }).open();
  try {
    assert.equal(restored.getMonitor(reviewConfig().id).config.enabled, true);
    assert.equal(restored.ideaEligible(ideaId, NOW + 7 * DAY_MS - 1), false);
    assert.equal(restored.ideaEligible(ideaId, NOW + 7 * DAY_MS), true);
    assert.equal(restored.getTarget(profile.id).deleted, true);
    assert.equal(restored.heartbeatScratch(profile.id).content, "Last seen release 3.");
    const restoredDocuments = new HeartbeatDocumentStore({ paths, productStore: { getAgentProfile: () => profile } });
    assert.equal(restoredDocuments.read(profile.id).revision, saved.revision);
  } finally { restored.close(); }
});
