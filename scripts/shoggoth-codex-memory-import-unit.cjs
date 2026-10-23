"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readCodexMemorySource } = require("../app/agent-service/codex-memory-source");
const { CodexMemoryImportStore } = require("../app/agent-service/codex-memory-import-store");
const { CodexMemoryImportService, TASK_PROMPT, RETRY_DELAY_MS, RESULT_OK, RESULT_FAILED } = require("../app/agent-service/codex-memory-import-service");
const { NativeCronStore } = require("../app/agent-service/native-cron-store");
const { validateAgentHarnessParams, validateAgentHarnessResult } = require("../app/agent-service/agent-harness-service-protocol");
const PROFILE = "00000000-0000-4000-8000-000000000001";
const MEMORY = "# Project Atlas\n## Reusable knowledge\n- Current API uses SQLite.\n## User preferences\n- 请使用中文。\n";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-import-cron-")));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const sourceFile = path.join(root, ".codex", "memories", "MEMORY.md");
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sourceFile, MEMORY);
  let clock = Date.now(), profileReady = true, retryCalls = 0;
  const now = () => clock;
  const store = new CodexMemoryImportStore({ paths, now });
  const cronStore = new NativeCronStore({ paths, now, profileExists: (id) => id === PROFILE });
  cronStore.open();
  const runs = [];
  const createRun = (job, retryOf = null) => {
    const run = { id: crypto.randomUUID(), source: "cron", sourceId: job.id, profileId: PROFILE,
      status: "running", finishedAt: null, errorCode: null, retryOf };
    runs.push(run); return structuredClone(run);
  };
  const dispatcher = { listRuns: ({ sourceId }) => structuredClone(runs.filter((run) => run.sourceId === sourceId)) };
  const scheduler = {
    async tick() {
      for (const job of cronStore.listJobs()) if (!runs.some((run) => run.sourceId === job.id)) createRun(job);
    },
    async retryRun(input) { retryCalls++; return createRun(cronStore.getJob(input.jobId), input.retryOf); },
  };
  const make = (overrides = {}) => new CodexMemoryImportService({ store, cronStore, scheduler, dispatcher, profileId: PROFILE,
    readSource: (name) => readCodexMemorySource(name, { hostHome: root }), isProfileReady: () => profileReady, now, ...overrides });
  t.after(() => { cronStore.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, sourceFile, paths, store, cronStore, scheduler, dispatcher, runs, make,
    setReady(value) { profileReady = value; }, advance(ms) { clock += ms; },
    finish(status, errorCode = null) { Object.assign(runs.at(-1), { status, errorCode, finishedAt: clock, updatedAt: clock }); },
    get retryCalls() { return retryCalls; } };
}

test("host OS source ignores runtime HOME/CODEX_HOME and reads full primary file", (t) => {
  const f = fixture(t);
  const source = readCodexMemorySource("MEMORY.md", { hostHome: f.root,
    userHome: "/wrong/runtime", parentEnv: { HOME: "/wrong", CODEX_HOME: "/wrong" } });
  assert.equal(source.path, f.sourceFile);
  assert.equal(source.lines.join("\n") + "\n", MEMORY);
  assert.ok(source.lines.includes("- Current API uses SQLite."));
  assert.equal(source.sha256, crypto.createHash("sha256").update(MEMORY).digest("hex"));
});

test("unsafe, oversized, malformed and absent primary sources never dispatch", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.sourceFile, Buffer.from([0xff]));
  assert.equal((await f.make().run()).reason, "CODEX_MEMORY_SOURCE_INVALID");
  fs.writeFileSync(f.sourceFile, "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal((await f.make().run()).reason, "CODEX_MEMORY_SOURCE_TOO_LARGE");
  fs.unlinkSync(f.sourceFile); fs.writeFileSync(path.join(f.root, "outside"), MEMORY);
  fs.symlinkSync(path.join(f.root, "outside"), f.sourceFile);
  assert.equal((await f.make().run()).reason, "CODEX_MEMORY_SOURCE_UNSAFE");
  fs.unlinkSync(f.sourceFile); fs.linkSync(path.join(f.root, "outside"), f.sourceFile);
  assert.equal((await f.make().run()).reason, "CODEX_MEMORY_SOURCE_UNSAFE");
  fs.unlinkSync(f.sourceFile);
  assert.equal((await f.make().run()).state, "no_source");
  fs.writeFileSync(f.sourceFile, "\n  \n");
  assert.equal((await f.make().run()).state, "no_source");
  assert.equal(f.cronStore.listJobs().length, 0);
  assert.equal(f.runs.length, 0);
});

test("one system at-job carries the full supplied prompt; restart/concurrent triggers reuse it", async (t) => {
  const f = fixture(t), service = f.make();
  const results = await Promise.all([service.run(), service.run()]);
  assert.deepEqual(results[0], results[1]);
  const [job] = f.cronStore.listJobs();
  assert.equal(job.profileId, PROFILE);
  assert.equal(job.schedule.kind, "at");
  assert.equal(job.threadPolicy, "continue");
  assert.ok(job.prompt.startsWith(TASK_PROMPT));
  assert.ok(job.prompt.includes(JSON.stringify(f.sourceFile)));
  assert.ok(!job.prompt.includes(MEMORY), "dispatch metadata is not a filtered extraction prompt");
  assert.ok(job.prompt.includes("Read the entire source `MEMORY.md`"));
  assert.equal(typeof service.generate, "undefined");
  assert.equal(service.isSystemJob(job.id), true);
  await f.make().run();
  assert.equal(f.cronStore.listJobs().length, 1);
  assert.equal(f.runs.length, 1);
  assert.equal(validateAgentHarnessResult("harness.memory.import.status", service.status(PROFILE)).task.attempts, 1);
});

test("profile readiness defers without consuming an execution attempt", async (t) => {
  const f = fixture(t); f.setReady(false);
  assert.equal((await f.make().run()).state, "deferred");
  assert.equal(f.runs.length, 0);
  f.setReady(true);
  assert.equal((await f.make().run()).state, "running");
  assert.equal(f.runs.length, 1);
});

for (const outcome of ["failed", "interrupted", "canceled", "skipped"]) {
  test(`${outcome}: one retry after 30 minutes, then permanently stop after second failure`, async (t) => {
    const f = fixture(t); await f.make().run();
    f.finish(outcome, "RUNTIME_FAILED");
    assert.equal((await f.make().run()).state, "deferred");
    f.advance(RETRY_DELAY_MS - 1); await f.make().run();
    assert.equal(f.retryCalls, 0);
    f.advance(1); await f.make().run();
    assert.equal(f.retryCalls, 1);
    assert.equal(f.runs[1].retryOf, f.runs[0].id);
    f.finish("failed", "RUNTIME_FAILED_AGAIN");
    assert.equal((await f.make().run()).state, "abandoned");
    f.advance(RETRY_DELAY_MS * 100); await f.make().run();
    assert.equal(f.runs.length, 2); assert.equal(f.retryCalls, 1);
  });
}

test("successful retry completes once and restart does not create another task", async (t) => {
  const f = fixture(t); await f.make().run();
  f.runs[0].id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  f.finish("failed"); f.advance(RETRY_DELAY_MS);
  await f.make().run(); f.runs[1].id = "00000000-0000-4000-8000-000000000001";
  assert.equal((await f.make().run()).state, "running", "UUID lexical order cannot supersede durable retry order");
  f.finish("completed");
  const status = await f.make().run();
  assert.equal(status.state, "completed"); assert.equal(status.task.attempts, 2);
  f.advance(RETRY_DELAY_MS); await f.make().run();
  assert.equal(f.runs.length, 2); assert.equal(f.cronStore.listJobs().length, 1);
});

test("lost create and retry responses recover original operations instead of duplicating", async (t) => {
  const f = fixture(t), create = f.cronStore.createJob.bind(f.cronStore);
  let failOnce = true;
  f.cronStore.createJob = (input) => { const result = create(input); if (failOnce) { failOnce = false; throw new Error("response lost"); } return result; };
  assert.equal((await f.make().run()).state, "failed");
  const [job] = f.cronStore.listJobs();
  assert.equal(f.make().isSystemJob(job.id), true, "durable create receipt owns the job even before ledger ack");
  await f.make().run(); assert.equal(f.cronStore.listJobs().length, 1);
  f.finish("failed"); f.advance(RETRY_DELAY_MS);
  const retry = f.scheduler.retryRun;
  f.scheduler.retryRun = async (input) => { await retry(input); throw new Error("retry response lost"); };
  await f.make().run(); await f.make().run();
  assert.equal(f.runs.length, 2); assert.equal(f.retryCalls, 1);
});

test("old completed imports and original excerpt evidence survive without rerun", async (t) => {
  const f = fixture(t);
  f.store.mutate(PROFILE, (next) => { next.state = "completed"; next.evidence.old = { excerpt: "old original" };
    next.chunks.old = { state: "done", attempts: 1, imported: 3, skipped: {}, facts: null }; return next; });
  const oldLedger = f.store.get(PROFILE); oldLedger.version = 1;
  fs.writeFileSync(f.store._path(PROFILE), JSON.stringify(oldLedger), { mode: 0o600 });
  const status = await f.make().run();
  assert.equal(status.imported, 3); assert.equal(status.task, undefined);
  assert.equal(f.store.excerpt(PROFILE, "old"), "old original");
  assert.equal(f.cronStore.listJobs().length, 0);
});

test("unfinished old extraction is retired without activation or loss of existing evidence", async (t) => {
  const f = fixture(t);
  f.store.mutate(PROFILE, (next) => { next.state = "deferred"; next.evidence.old = { excerpt: "old original" };
    next.chunks.old = { state: "proposed", attempts: 1, imported: 0, skipped: {}, facts: [{ content: "not committed" }] }; return next; });
  await f.make().run();
  assert.equal(f.store.get(PROFILE).chunks.old.state, "skipped");
  assert.equal(f.store.excerpt(PROFILE, "old"), "old original");
});

test("completion requires explicit task result; unrelated jobs have no added condition", async (t) => {
  const f = fixture(t), service = f.make(); await service.run(); const run = f.runs[0];
  assert.equal(service.completionError(run, RESULT_OK + "\nVerified fixture report"), null);
  assert.equal(service.completionError(run, RESULT_FAILED + "\nNative write channel unavailable"), "MEMORY_IMPORT_TASK_FAILED");
  assert.equal(service.completionError(run, "I have a plan."), "MEMORY_IMPORT_RESULT_MISSING");
  assert.equal(service.completionError({ ...run, sourceId: crypto.randomUUID() }, null), null);
  f.cronStore.updateJob({ operationId: crypto.randomUUID(), jobId: run.sourceId,
    patch: { prompt: "different job" }, createdAt: f.cronStore.getJob(run.sourceId).updatedAt });
  assert.equal(service.completionError(run, RESULT_OK), "MEMORY_IMPORT_JOB_CHANGED");
  assert.equal((await service.run()).state, "abandoned");
});

test("terminal reports page the original answer without splitting Unicode or mutating the ledger", async (t) => {
  const f = fixture(t);
  const report = `${RESULT_FAILED}\n## 未保存画像\n${"中文🌿abcd".repeat(2400)}\nEND_REPORT`;
  const service = f.make({ readRunReport: () => report });
  await service.run();
  assert.equal(service.report(PROFILE).runId, null, "a running commentary is not a terminal report");
  f.finish("failed", "MEMORY_IMPORT_TASK_FAILED");
  const status = await service.run();
  assert.equal(status.task.retryAt, f.runs[0].finishedAt + RETRY_DELAY_MS);
  assert.equal(status.task.reportRunId, f.runs[0].id);
  const revision = f.store.get(PROFILE).revision;
  let content = "", cursor = 0, runId = null, expectedHash = null;
  do {
    const params = { profileId: PROFILE, cursor, limit: 2999, runId, expectedHash };
    validateAgentHarnessParams("harness.memory.import.report", params);
    const page = service.report(PROFILE, params);
    validateAgentHarnessResult("harness.memory.import.report", page, params);
    assert.equal(page.text.isWellFormed(), true);
    assert.equal(page.attempt, 1);
    assert.equal(page.reportedOutcome, "failed");
    content += page.text; cursor = page.nextCursor; runId = page.runId; expectedHash = page.reportHash;
  } while (cursor !== null);
  assert.equal(content, report);
  assert.equal(f.store.get(PROFILE).revision, revision);
  assert.equal(fs.readFileSync(f.sourceFile, "utf8"), MEMORY);
  assert.equal(f.runs.length, 1);
  assert.equal(f.retryCalls, 0);
});

test("report pagination rejects changed content, unrelated runs and unbound continuation requests", async (t) => {
  const f = fixture(t);
  let text = `${RESULT_FAILED}\noriginal report`;
  const service = f.make({ readRunReport: () => text });
  await service.run(); f.finish("failed");
  const first = service.report(PROFILE, { limit: 20 });
  text += " changed";
  assert.throws(() => service.report(PROFILE, { runId: first.runId, cursor: first.nextCursor,
    expectedHash: first.reportHash }), (error) => error.code === "MEMORY_IMPORT_REPORT_CHANGED");
  assert.throws(() => service.report(PROFILE, { runId: crypto.randomUUID() }), (error) => error.code === "MEMORY_IMPORT_REPORT_NOT_FOUND");
  assert.deepEqual(service.report("another-profile"), { applicable: false });
  assert.throws(() => validateAgentHarnessParams("harness.memory.import.report", {
    profileId: PROFILE, cursor: 1, limit: 8000, runId: null, expectedHash: null,
  }), (error) => error.code === "INVALID_PARAMS");
  for (const limit of [1, 8001, NaN]) assert.throws(() => service.report(PROFILE, { limit }),
    (error) => error.code === "INVALID_PARAMS");
  f.runs[0].profileId = "other-profile";
  assert.throws(() => service.report(PROFILE, { runId: first.runId }), (error) => error.code === "MEMORY_IMPORT_REPORT_NOT_FOUND");
  assert.throws(() => validateAgentHarnessResult("harness.memory.import.report", { ...first, runId: null }),
    (error) => error.code === "HARNESS_RESPONSE_INVALID");
});

test("a retry without an answer keeps the previous analysis readable across service recreation", async (t) => {
  const f = fixture(t), reports = new Map();
  const make = () => f.make({ readRunReport: (run) => reports.get(run.id) || null });
  await make().run(); reports.set(f.runs[0].id, `${RESULT_FAILED}\nFirst unsaved analysis`);
  f.finish("failed"); await make().run(); f.advance(RETRY_DELAY_MS); await make().run();
  assert.equal(make().report(PROFILE).runId, f.runs[0].id, "retry in progress keeps first analysis visible");
  f.finish("failed", "RUNTIME_FAILED");
  assert.equal((await make().run()).state, "abandoned");
  const result = make().report(PROFILE);
  assert.equal(result.text, reports.get(f.runs[0].id)); assert.equal(result.attempt, 1);
  assert.equal(make().status(PROFILE).task.retryAt, null);
  reports.set(f.runs[1].id, `${RESULT_FAILED}\nSecond unsaved analysis`);
  assert.equal(make().report(PROFILE).attempt, 2);
  assert.equal(make().report(PROFILE, { runId: f.runs[0].id }).attempt, 1);
  assert.equal(f.retryCalls, 1); assert.equal(f.runs.length, 2);
});
