#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const TOML = require("smol-toml");
const { DatabaseSync } = require("node:sqlite");
const { CodexAutomationController } = require("../app/agent-service/codex-automation-controller");
const { CodexAutomationStore, OWNER, ACCOUNT_ID, number, resolveCodexAutomationOwner } = require("../app/agent-service/codex-automation-store");
const { CodexAutomationBackend, isCodexAutomationOwner } = require("../app/core/codex-automation-backend");
const protocol = require("../app/agent-service/codex-automation-protocol");
const { validateSchedule, recurrence } = require("../app/agent-service/codex-automation-schedule");
const roots = [], tests = [];
const test = (name, fn) => tests.push({ name, fn });
const clock = { value: Date.parse("2026-09-30T01:00:00Z") };
const spec = { name: "fixture", prompt: "Return fixture output only.", rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0", enabled: false,
  kind: "cron", model: "fixture-model", reasoningEffort: "high", cwd: "/private/tmp", executionEnvironment: "local" };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-automation-unit-")); roots.push(root);
  const home = path.join(root, "home"); fs.mkdirSync(path.join(home, "sqlite"), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(home, "sqlite", "codex-dev.db"));
  db.exec(`CREATE TABLE automations(id TEXT PRIMARY KEY, status TEXT, account_id TEXT,user_id TEXT,installation_id TEXT,last_run_at INTEGER,next_run_at INTEGER,updated_at INTEGER);
    CREATE TABLE automation_runs(thread_id TEXT PRIMARY KEY, automation_id TEXT,status TEXT,thread_title TEXT,source_cwd TEXT,inbox_title TEXT,inbox_summary TEXT,created_at INTEGER,updated_at INTEGER,archived_assistant_message TEXT,archived_reason TEXT);`);
  const profile = { ...OWNER, enabled: true, runtimeAccountId: ACCOUNT_ID, name: "Renamed Codex" };
  const runs = new Map(), calls = [];
  const dispatcher = { listRuns: query => [...runs.values()].filter(value => (!query?.source || value.source === query.source) && (!query?.sourceId || value.sourceId === query.sourceId)),
    getRun: id => runs.get(id) || null, enqueue: input => {
      const run = { ...input, contextSnapshotId: null, runtimeSessionRef: null, runtimeTurnRef: null, eventSeq: 1, waitingRequestId: null,
        startedAt: null, finishedAt: null, resultSummary: null, errorCode: null, retryOf: null, status: "queued" }; runs.set(run.id, run); return run;
    } };
  const handle = { modelsList: async () => ({ data: [{ id: "catalog-id", model: "fixture-model", displayName: "Fixture model", isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low" }], nextCursor: null }),
    sessionRead: async () => ({ session: { turns: [{ id: "native-turn", status: "completed", items: [{ type: "agentMessage", text: "FIRST RESULT" }] },
      { id: "later-chat", status: "completed", items: [{ type: "agentMessage", text: "LATER CHAT" }] }] } }) };
  const coordinator = { executeDomainRun: async input => {
    calls.push(input); const run = runs.get(input.runId); run.status = "running"; run.startedAt = clock.value;
    run.runtimeSessionRef = { runtime: "codex", runtimeProfileId: OWNER.runtimeProfileId, runtimeAccountId: ACCOUNT_ID, sessionId: "native-thread" };
    run.runtimeTurnRef = { ...run.runtimeSessionRef, turnId: "native-turn" };
  }, getRunSnapshot: id => ({ run: runs.get(id) }), cancelQueuedDomainRun: id => { runs.get(id).status = "failed"; },
    stopAutomationRun: async id => { runs.get(id).status = "interrupted"; }, respondApproval: async () => ({}), respondInput: async () => ({}) };
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") }; fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  const productStore = { getAgentProfile: id => id === OWNER.id ? profile : null, getRuntimeAccount: id => id === ACCOUNT_ID ? { kind: "native-user" } : null };
  const controller = new CodexAutomationController({ home, paths, now: () => clock.value, productStore, adapter: { acquire: async () => handle }, dispatcher, coordinator });
  const call = (name, params) => {
    const method = `codex.automation.${name}`;
    return Promise.resolve(controller.handle(method, protocol.validateParams(method, params))).then(result => protocol.validateResult(method, result));
  };
  const create = (extra = {}, operationId = `create-${Math.random().toString(36).slice(2)}`) => call("create", { profileId: OWNER.id, operationId, spec: { ...spec, ...extra } });
  return { root, home, db, profile, productStore, controller, runs, calls, handle, call, create, dispatcher, coordinator };
}

test("fixed owner survives rename and excludes clones/Harness", async () => {
  const f = fixture(), { job } = await f.create();
  assert.equal(job.agentId, OWNER.agentId); assert.equal(isCodexAutomationOwner(f.profile), true);
  assert.equal(isCodexAutomationOwner({ ...f.profile, id: "clone" }), false);
  await assert.rejects(f.call("list", { profileId: "clone", offset: 0, limit: 20 }), { code: "CODEX_AUTOMATION_OWNER_UNAVAILABLE" });
  f.profile.name = "Another name"; assert.equal(f.controller.owner().profile.id, OWNER.id);
  f.profile.runtimeAccountId = "shoggoth-internal-codex-default-v1";
  assert.equal(f.controller.source("shoggoth").available, false); f.db.close();
});
test("create is idempotent and does not run or duplicate scheduling", async () => {
  const f = fixture(), first = await f.create({}, "same-create"), second = await f.create({}, "same-create");
  assert.equal(first.job.id, second.job.id); assert.equal(f.runs.size, 0); assert.equal(first.job.enabled, false);
  assert.equal(f.controller.owner().store.list().records.length, 1);
  await assert.rejects(f.create({ name: "changed" }, "same-create"), { code: "CODEX_AUTOMATION_OPERATION_CONFLICT" }); f.db.close();
});
test("TOML edit preserves unknown integers/floats/dates, multiline text and file mode", async () => {
  const f = fixture(), { job } = await f.create(); const store = f.controller.owner().store, id = store.localId(job.id), file = store.read(id).file;
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("[target]", 'unknown_int = 9223372036854775807\nunknown_float = 1.0\nunknown_date = 2026-09-30\n[extra]\nname = "not task name"\n[target]')); fs.chmodSync(file, 0o664);
  const before = store.read(id), text = 'line 1\nname = "inside prompt"\nupdated_at = 100\n';
  const saved = await f.call("update", { profileId: OWNER.id, id: job.id, revision: before.revision, patch: { name: "renamed", prompt: text } });
  const d = store.read(id).definition;
  assert.equal(d.unknown_int, 9223372036854775807n); assert.equal(d.unknown_float, 1); assert.equal(typeof d.unknown_float, "number");
  assert.equal(d.extra.name, "not task name"); assert.equal(d.prompt, text); assert.equal(fs.statSync(file).mode & 0o777, 0o664);
  assert.equal(d.created_at, before.definition.created_at); assert.equal(saved.job.enabled, false);
  assert.equal(saved.job.model, spec.model); assert.equal(d.rrule, spec.rrule); f.db.close();
});
test("stale revisions, symlinks and mismatched content IDs fail closed", async () => {
  const f = fixture(), { job } = await f.create(), store = f.controller.owner().store, id = store.localId(job.id);
  await f.call("update", { profileId: OWNER.id, id: job.id, revision: job.revision, patch: { name: "new" } });
  await assert.rejects(f.call("update", { profileId: OWNER.id, id: job.id, revision: job.revision, patch: { name: "stale" } }), { code: "CODEX_AUTOMATION_CONFLICT" });
  const file = store.read(id).file; fs.unlinkSync(file); fs.symlinkSync(path.join(f.root, "outside.toml"), file);
  assert.throws(() => store.read(id)); assert.throws(() => store.localId("codex-automation:../outside")); f.db.close();
});
test("pause/activate change one definition; unrelated unsupported rules remain intact", async () => {
  const f = fixture(), { job } = await f.create();
  const enabled = await f.call("setStatus", { profileId: OWNER.id, id: job.id, revision: job.revision, enabled: true });
  assert.equal(enabled.job.state, "ACTIVE");
  const paused = await f.call("setStatus", { profileId: OWNER.id, id: job.id, revision: enabled.job.revision, enabled: false });
  assert.equal(paused.job.nextRunAt, null); assert.equal(f.controller.owner().store.list().records.length, 1);
  const store = f.controller.owner().store, id = store.localId(job.id), d = store.read(id);
  fs.writeFileSync(d.file, fs.readFileSync(d.file, "utf8").replace(spec.rrule, "RRULE:FREQ=MONTHLY;BYMONTHDAY=2"));
  const before = store.read(id);
  await f.call("update", { profileId: OWNER.id, id: job.id, revision: before.revision, patch: { name: "keep advanced", rrule: before.definition.rrule } });
  assert.equal(store.read(id).definition.rrule, before.definition.rrule); f.db.close();
});
test("model catalog is native and effort validation rejects unavailable choices", async () => {
  const f = fixture(); const catalog = await f.call("models.list", { profileId: OWNER.id });
  assert.deepEqual(catalog.models[0].thinkingOptions, ["low", "high"]);
  await assert.rejects(f.create({ reasoningEffort: "ultra" }), { code: "CODEX_AUTOMATION_MODEL_UNAVAILABLE" });
  await assert.rejects(f.create({ model: "absent" }), { code: "CODEX_AUTOMATION_MODEL_UNAVAILABLE" }); f.db.close();
});
test("migrated/deleted/cache-unknown writes cannot revive client tasks", async () => {
  const f = fixture(), { job } = await f.create(), store = f.controller.owner().store;
  const id = store.localId(job.id); f.db.prepare("INSERT INTO automations(id,status,account_id) VALUES(?,?,?)").run(id, "ACTIVE", "cloud-account");
  await assert.rejects(f.call("setStatus", { profileId: OWNER.id, id: job.id, revision: job.revision, enabled: true }), { code: "CODEX_AUTOMATION_MIGRATED" });
  f.db.prepare("UPDATE automations SET account_id=NULL,status='DELETED' WHERE id=?").run(id);
  await assert.rejects(f.call("setStatus", { profileId: OWNER.id, id: job.id, revision: job.revision, enabled: true }), { code: "CODEX_AUTOMATION_DELETED" });
  f.db.close(); fs.unlinkSync(path.join(f.home, "sqlite", "codex-dev.db"));
  await assert.rejects(f.create(), { code: "CODEX_AUTOMATION_STORAGE_UNKNOWN" });
});
test("manual run freezes model/effort/workspace and request deduplication", async () => {
  const f = fixture(), { job } = await f.create();
  const input = { profileId: OWNER.id, id: job.id, revision: job.revision, operationId: "manual-one" };
  const first = await f.call("run", input), second = await f.call("run", input);
  assert.equal(first.runId, second.runId); assert.equal(f.calls.length, 1); assert.equal(f.runs.size, 1);
  assert.equal(f.calls[0].automationConfig.model, "fixture-model"); assert.equal(f.calls[0].automationConfig.reasoningEffort, "high");
  assert.equal(f.runs.get(first.runId).workspace, fs.realpathSync("/private/tmp"));
  assert.equal(f.runs.get(first.runId).source, "automation");
  await assert.rejects(f.call("run", { ...input, operationId: "manual-two" }), { code: "CODEX_AUTOMATION_RUN_BUSY" });
  const result = await f.call("runs.result", { profileId: OWNER.id, id: job.id, runId: first.runId });
  const content = await f.call("content.read", { profileId: OWNER.id, id: job.id, field: "result", runId: first.runId, revision: result.contentRevision, offset: 0, limit: 6000 });
  assert.equal(content.content, "FIRST RESULT", "later chat must not replace the task's original turn");
  assert.equal(result.model, "fixture-model"); f.db.close();
});
test("native review states are separate from execution status and missing sources", async () => {
  const f = fixture(), { job } = await f.create(), id = f.controller.owner().store.localId(job.id);
  f.db.prepare("INSERT INTO automation_runs(thread_id,automation_id,status,created_at,inbox_summary) VALUES(?,?,?,?,?)").run("native-task-thread", id, "PENDING_REVIEW", clock.value, "preview");
  const page = await f.call("runs.list", { profileId: OWNER.id, id: job.id, offset: 0, limit: 20 });
  assert.equal(page.runs[0].completionStatus, "unknown"); assert.equal(page.runs[0].reviewStatus, "PENDING_REVIEW");
  const result = await f.call("runs.result", { profileId: OWNER.id, id: job.id, runId: page.runs[0].runId });
  assert.equal(result.completionStatus, "succeeded");
  const output = await f.call("content.read", { profileId: OWNER.id, id: job.id, field: "result", runId: page.runs[0].runId, revision: result.contentRevision, offset: 0, limit: 6000 });
  assert.equal(output.content, "FIRST RESULT");
  f.db.close(); fs.unlinkSync(path.join(f.home, "sqlite", "codex-dev.db"));
  const missing = await f.call("runs.list", { profileId: OWNER.id, id: job.id, offset: 0, limit: 20 });
  assert.equal(missing.sourceError, "CODEX_AUTOMATION_STORAGE_UNKNOWN");
});
test("heartbeat preserves its original chat and does not create a fake continuation", async () => {
  const f = fixture(), { job } = await f.create({ kind: "heartbeat", rrule: "RRULE:FREQ=MINUTELY;INTERVAL=30", targetThreadId: "original-thread", model: null, reasoningEffort: null });
  assert.equal(job.codex.targetThreadId, "original-thread"); assert.equal(job.actions.run, false);
  await assert.rejects(f.call("run", { profileId: OWNER.id, id: job.id, revision: job.revision, operationId: "heartbeat-run" }), { code: "CODEX_AUTOMATION_RUN_UNSUPPORTED" }); assert.equal(f.runs.size, 0); f.db.close();
});
test("RRULE wall clock follows its timezone and handles DST", () => {
  validateSchedule(spec.rrule);
  assert.throws(() => validateSchedule("RRULE:FREQ=WEEKLY;BYHOUR=99"));
  const rule = recurrence(spec.rrule, Date.parse("2026-09-29T00:00:00Z"), "Asia/Shanghai");
  assert.equal(rule.after(new Date("2026-09-30T00:01:00Z")).toISOString(), "2026-10-01T00:00:00.000Z");
  const dst = recurrence("RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", Date.parse("2026-10-20T00:00:00Z"), "America/New_York");
  assert.equal(dst.after(new Date("2026-11-01T00:00:00Z")).toISOString(), "2026-11-02T14:00:00.000Z");
});
test("backend routes only foreign IDs and reads long content in chunks", async () => {
  const f = fixture(), { job } = await f.create({ prompt: "a".repeat(18000) });
  const facade = { id: "shoggoth", _profilesById: new Map([[OWNER.id, f.profile]]), _call: (method, params) => f.call(method.slice("codex.automation.".length), params) };
  const backend = new CodexAutomationBackend(facade); const detail = await backend.get(job.id, true);
  assert.equal(detail.prompt.length, 18000); assert.equal((await backend.list()).length, 1);
  assert.throws(() => protocol.validateParams("codex.automation.run", { profileId: OWNER.id, id: job.id, revision: job.revision, operationId: "run", extra: true })); f.db.close();
});
test("concurrent create and run preserve both durable idempotency intents", async () => {
  const f = fixture(), { job } = await f.create();
  const input = { profileId: OWNER.id, id: job.id, revision: job.revision, operationId: "parallel-run" };
  const [created, receipt] = await Promise.all([f.create({ name: "parallel creation" }, "parallel-create"), f.call("run", input)]);
  const registry = f.controller.registry(f.controller.owner().store);
  assert.equal(registry.creations["parallel-create"].id, created.job.externalTaskId);
  assert.equal(registry.operations["parallel-run"].runId, receipt.runId);
  assert.equal((await f.call("run", input)).runId, receipt.runId); assert.equal(f.calls.length, 1); f.db.close();
});
test("worktree execution uses a detached checkout and preserves the source working tree", async () => {
  const { execFileSync } = require("node:child_process");
  const f = fixture(), repo = path.join(f.root, "repo"); fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); fs.writeFileSync(path.join(repo, "tracked.txt"), "committed"); git("add", "tracked.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "uncommitted");
  const branch = git("symbolic-ref", "--short", "HEAD"), head = git("rev-parse", "HEAD"), status = git("status", "--porcelain");
  const { job } = await f.create({ cwd: repo, executionEnvironment: "worktree" });
  const receipt = await f.call("run", { profileId: OWNER.id, id: job.id, revision: job.revision, operationId: "worktree-run" });
  const workspace = f.runs.get(receipt.runId).workspace;
  assert.notEqual(workspace, repo); assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "committed");
  assert.equal(execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
  assert.equal(git("symbolic-ref", "--short", "HEAD"), branch); assert.equal(git("status", "--porcelain"), status);
  assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "uncommitted"); f.db.close();
});
test("API rejects foreign owners, unknown response fields and invalid pages", async () => {
  const f = fixture(), { job } = await f.create();
  // A task must belong to the owner named in the request.
  for (const changed of [{ ...job, ownerProfileId: "clone" }, { ...job, id: "native-cron-id" }, { ...job, enabled: "true" }, { ...job, token: "unexpected" }]) {
    assert.throws(() => protocol.validateResult("codex.automation.get", { job: changed }, { profileId: OWNER.id, id: job.id }), { code: "CODEX_AUTOMATION_RESPONSE_INVALID" });
  }
  assert.throws(() => protocol.validateResult("codex.automation.list", { jobs: [job], nextOffset: -1 }), { code: "CODEX_AUTOMATION_RESPONSE_INVALID" });
  assert.throws(() => protocol.validateResult("codex.automation.source", { origin: "codex-desktop" }), { code: "CODEX_AUTOMATION_RESPONSE_INVALID" });
  for (const rule of ["FREQ=HOURLY", "RRULE:FREQ=HOURLY=DAILY", "RRULE:FREQ=WEEKLY;BYDAY=", "RRULE:FREQ=HOURLY;INTERVAL=0"]) {
    assert.throws(() => validateSchedule(rule), { code: "CODEX_AUTOMATION_SCHEDULE_UNSUPPORTED" });
  }
  f.db.close();
});
test("merged history reaches native rows beyond the first thousand", async () => {
  const f = fixture(), { job } = await f.create(), local = f.controller.owner().store.localId(job.id);
  const native = [];
  f.db.exec("BEGIN");
  const insert = f.db.prepare("INSERT INTO automation_runs(thread_id,automation_id,status,created_at,inbox_summary) VALUES(?,?,?,?,?)");
  for (let index = 0; index < 1505; index++) {
    const thread = `native-${String(index).padStart(4, "0")}`, startedAt = clock.value - index * 2000;
    insert.run(thread, local, "PENDING_REVIEW", startedAt, "preview"); native.push({ runId: `codex:${thread}`, startedAt });
  }
  f.db.exec("COMMIT");
  const store = f.controller.owner().store, registry = f.controller.registry(store), manual = [];
  for (const [index, delta] of [0, 1200, 2900000, 3100000].entries()) {
    const runId = `automation-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, createdAt = clock.value - delta - 1;
    registry.operations[`manual-${index}`] = { runId, taskId: job.id, revision: job.revision, name: job.name, model: spec.model,
      reasoningEffort: spec.reasoningEffort, workspace: "/private/tmp", createdAt, state: "needs_verification" };
    manual.push({ runId, startedAt: createdAt });
  }
  f.controller.saveRegistry(store, registry);
  const expected = [...native, ...manual].sort((a, b) => b.startedAt - a.startedAt || b.runId.localeCompare(a.runId));
  for (const offset of [0, 20, 1000, 1440, 1500, 1509]) {
    const page = await f.call("runs.list", { profileId: OWNER.id, id: job.id, offset, limit: 20 });
    assert.deepEqual(page.runs.map(run => run.runId), expected.slice(offset, offset + 20).map(run => run.runId));
    assert.equal(page.nextOffset, expected.length > offset + 20 ? offset + 20 : null);
  }
  f.db.close();
});
test("ownership moves only when its Agent stops qualifying, then sticks", () => {
  const codexView = (id, createdAt, extra = {}) => ({ id, agentId: `agent-${id}`, backendId: "shoggoth", runtime: "codex",
    runtimeAccountId: ACCOUNT_ID, enabled: true, createdAt, ...extra });
  const profiles = new Map([[OWNER.id, codexView(OWNER.id, 1)], ["late", codexView("late", 5)], ["early", codexView("early", 3)],
    ["harness", codexView("harness", 2, { runtimeAccountId: "shoggoth-internal-codex-default-v1" })]]);
  // Like the Product Store, a deleted Agent cannot resolve its runtime.
  const bindingError = code => Object.assign(new Error(code), { code: `AGENT_BINDING_${code}` });
  const productStore = { getAgentProfile: id => profiles.get(id) || null, listAgentProfiles: () => [...profiles.values()],
    resolveAgentRuntimeProfile: (id) => {
      const profile = profiles.get(id);
      if (!profile) throw bindingError("NOT_FOUND");
      if (!profile.enabled) throw bindingError("DISABLED");
      return profile;
    } };
  let recorded = null;
  const state = { codexAutomationOwner: () => recorded, setCodexAutomationOwner: id => { recorded = id; } };
  assert.equal(resolveCodexAutomationOwner(productStore, state).id, OWNER.id, "the first-generated Codex Agent starts as owner");
  profiles.set(OWNER.id, { ...profiles.get(OWNER.id), enabled: false });
  assert.equal(resolveCodexAutomationOwner(productStore, state).id, "early", "earliest qualifying Agent takes over; Harness never qualifies");
  assert.equal(recorded, "early");
  profiles.set("newest", codexView("newest", 0));
  assert.equal(resolveCodexAutomationOwner(productStore, state).id, "early", "an existing owner is not replaced by another Codex Agent");
  for (const id of ["early", "late", "newest"]) profiles.set(id, { ...profiles.get(id), runtime: "grok-build" });
  assert.equal(resolveCodexAutomationOwner(productStore, state), null);
  assert.equal(recorded, null);
  profiles.set("late", { ...profiles.get("late"), runtime: "codex" });
  assert.equal(resolveCodexAutomationOwner(productStore, state).id, "late", "the first Agent that runs on the Codex CLI again takes over");
  const closed = { ...productStore, resolveAgentRuntimeProfile: () => { throw Object.assign(new Error("closed"), { code: "STORE_CLOSED" }); } };
  assert.throws(() => resolveCodexAutomationOwner(closed, state), error => error.code === "STORE_CLOSED");
  assert.equal(recorded, "late", "a store failure never clears the owner");
  assert.equal(isCodexAutomationOwner(profiles.get("late"), "late"), true);
  assert.equal(isCodexAutomationOwner(profiles.get("late"), null), false);
});
// Calendar reads must tolerate Desktop scheduler jitter and catch-up runs.
function calendarFixture(timeZone = "Asia/Shanghai") {
  const f = fixture(), pages = [];
  const backend = new CodexAutomationBackend({ id: "shoggoth", _profilesById: new Map([[OWNER.id, f.profile]]),
    _call: async (method, params) => {
      if (method.endsWith("runs.list")) pages.push(params.offset);
      const value = await f.call(method.slice("codex.automation.".length), params);
      if (method.endsWith(".get")) value.job.schedule.tz = timeZone;
      return value;
    } });
  const add = (job, thread, date, summary = "preview") => f.db.prepare(
    "INSERT INTO automation_runs(thread_id,automation_id,status,created_at,inbox_summary) VALUES(?,?,?,?,?)"
  ).run(thread, job.externalTaskId, "PENDING_REVIEW", Date.parse(date), summary);
  return { ...f, backend, pages, add };
}
test("calendar finds early and delayed Codex runs on the requested day", async () => {
  const f = calendarFixture(), { job } = await f.create();
  try {
    f.add(job, "early", "2026-10-08T08:57:19+08:00");
    f.add(job, "delayed", "2026-10-06T15:00:11+08:00");
    for (const [date, thread] of [["2026-10-08", "early"], ["2026-10-06", "delayed"]]) {
      const result = await f.backend.latest(job.id, Date.parse(`${date}T09:00:00+08:00`));
      assert.equal(result.runId, `codex:${thread}`);
      assert.equal(result.fullText, "FIRST RESULT");
      assert.equal(result.source, "transcript");
      assert.equal(result.outputComplete, true);
    }
    assert.equal((await f.backend.latest(job.id)).runId, "codex:early", "latest result without an occurrence stays supported");
  } finally { f.db.close(); }
});
test("calendar pages older history and selects the closest same-day run", async () => {
  const f = calendarFixture(), { job } = await f.create();
  try {
    const at = Date.parse("2026-10-06T09:00:00+08:00");
    for (let i = 1; i <= 45; i++) f.add(job, `newer-${i}`, new Date(at + i * 86400000).toISOString());
    f.add(job, "old-early", "2026-10-06T08:14:00+08:00");
    f.add(job, "old-scheduled", "2026-10-06T09:00:59+08:00");
    f.add(job, "old-late", "2026-10-06T15:00:00+08:00");
    f.add(job, "previous-day", "2026-10-05T09:00:00+08:00");
    const result = await f.backend.latest(job.id, at);
    assert.equal(result.runId, "codex:old-scheduled");
    assert.deepEqual(f.pages, [0, 20, 40]);
  } finally { f.db.close(); }
});
test("calendar uses the schedule timezone and never borrows another day's report", async () => {
  const f = calendarFixture("Pacific/Honolulu"), { job } = await f.create();
  try {
    f.add(job, "local-day", "2026-10-08T23:57:19-10:00");
    f.add(job, "next-day", "2026-10-09T00:00:01-10:00");
    const result = await f.backend.latest(job.id, Date.parse("2026-10-08T23:59:00-10:00"));
    assert.equal(result.runId, "codex:local-day", "the closer UTC-day match belongs to the next local day");
    const empty = await f.backend.latest(job.id, Date.parse("2026-10-07T23:59:00-10:00"));
    assert.equal(empty.hasRun, false); assert.equal(empty.source, "none");
    assert.equal(empty.fullText, null);
  } finally { f.db.close(); }
});
test("calendar labels summary fallback and reports unreadable history instead of empty output", async () => {
  const f = calendarFixture(), { job } = await f.create();
  try {
    f.add(job, "unavailable-thread", "2026-10-08T08:57:19+08:00", "Saved summary");
    f.handle.sessionRead = async () => { throw new Error("session unavailable"); };
    const result = await f.backend.latest(job.id, Date.parse("2026-10-08T09:00:00+08:00"));
    assert.equal(result.summary, "Saved summary"); assert.equal(result.source, "summary");
    assert.equal(result.fullText, null); assert.equal(result.outputComplete, false);
    f.db.exec("DROP TABLE automation_runs");
    await assert.rejects(f.backend.latest(job.id), { code: "CODEX_AUTOMATION_STORAGE_UNKNOWN" });
    await assert.rejects(f.backend.latest(job.id, Date.parse("2026-10-08T09:00:00+08:00")), { code: "CODEX_AUTOMATION_STORAGE_UNKNOWN" });
  } finally { f.db.close(); }
});
test("calendar rejects stalled or exhausted history pagination", async () => {
  const f = calendarFixture(), { job } = await f.create();
  try {
    const at = Date.parse("2026-10-08T09:00:00+08:00");
    f.backend.runs = async () => ({ runs: [{ startedAt: at + 86400000 }], nextOffset: 0, sourceError: null });
    await assert.rejects(f.backend.latest(job.id, at), { code: "CODEX_AUTOMATION_RESPONSE_INVALID" });
    f.backend.runs = async (id, { offset }) => ({ runs: [{ startedAt: at + 86400000 }], nextOffset: offset + 20, sourceError: null });
    await assert.rejects(f.backend.latest(job.id, at), { code: "CODEX_AUTOMATION_CAPACITY" });
  } finally { f.db.close(); }
});
(async () => {
  let failures = 0;
  for (const { name, fn } of tests) try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  if (failures) process.exitCode = 1; else console.log(`${tests.length} Codex automation tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
