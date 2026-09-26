"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { InspirationStore, INSPIRATION_STORE_VERSION } = require("../app/agent-service/inspiration-store");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");

const id = () => crypto.randomUUID();
const NOW = 2000000000000;
const SESSION = `agent:main:dashboard:inspiration-${"b".repeat(64)}`;

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-external-inspiration-store-")));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  const store = new InspirationStore({ paths, now: () => NOW, ...options }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const create = (body = "A durable inspiration") => store.create({ operationId: id(), body });
  const input = (idea, overrides = {}) => ({ operationId: id(), id: idea.id, expectedRevision: idea.revision,
    instruction: "First draft", agentId: "main", backendId: "openclaw", workspace: null, ...overrides });
  const prepare = (idea = create(), overrides = {}) => store.prepareExternalExecution(input(idea, overrides), () => true);
  const bind = (execution, overrides = {}) => store.bindExternalSession(execution.id, { hostId: id(),
    binding: { sessionKey: SESSION, workspace: "/remote/agent", mode: "openclaw", ...overrides } });
  const restart = () => { store.close(); store.open(); };
  return { root, paths, store, create, input, prepare, bind, restart };
}

function snapshot(execution, overrides = {}) {
  const status = overrides.status || "running";
  return { executionId: execution.id, runId: execution.runId, backendId: execution.backendId,
    agentId: execution.agentId, sessionKey: execution.sessionKey, workspace: execution.workspace,
    mode: execution.external.mode, status, sequence: execution.external.sequence + 1,
    resultSummary: null, errorCode: null,
    finishedAt: ["completed", "failed", "canceled", "interrupted"].includes(status) ? NOW + 10 : null,
    attention: null, ...overrides };
}

function update(store, execution, overrides = {}, hostId = execution.external.hostId) {
  return store.updateExternalSnapshot(execution.id, { hostId, snapshot: snapshot(execution, overrides) });
}

function attention(runId, overrides = {}) {
  const request = normalizeInteractiveRequestV1({ runId, eventType: "prompt", expiresAt: NOW + 60000,
    payload: { requestId: "question-1", requestedSchema: { type: "object", properties: {
      credential: { type: "string", title: "Credential", writeOnly: true },
    }, required: ["credential"] } } });
  return { request, active: true, occurredAt: NOW, command: null, cwd: null, details: null, ...overrides };
}

test("agent notes match full participation before pagination and isolate backend identities", (t) => {
  const f = fixture(t);
  const scope = { backendId: "openclaw", agentId: "main" };
  const finish = (idea, target = scope) => {
    const execution = f.prepare(f.store.get(idea.id), target);
    f.store.failPreparation(execution.id, "EXTERNAL_PREPARE_FAILED");
  };
  const shared = f.create("共同参与的灵感");
  finish(shared);
  finish(shared);
  finish(shared, { backendId: "hermes", agentId: "main" });
  const own = [f.create("独立便签一"), f.create("独立便签二")];
  own.forEach(idea => finish(idea));
  finish(f.create("同后端的其他助理"), { ...scope, agentId: "another" });
  finish(f.create("另一后端的同名助理"), { ...scope, backendId: "hermes" });
  f.create("尚未分配的便签");
  const archived = f.create("已归档的灵感");
  let execution = f.bind(f.prepare(archived));
  update(f.store, execution, { status: "completed" });
  f.store.update({ id: archived.id, operationId: id(), expectedRevision: f.store.get(archived.id).revision,
    patch: { archived: true } });
  const deleted = f.create("已删除的灵感");
  finish(deleted);
  f.store.delete({ id: deleted.id, operationId: id(), expectedRevision: f.store.get(deleted.id).revision }, () => true);
  f.restart();
  const input = { filter: "all", query: "", cursor: null, limit: 2, ...scope };
  const first = f.store.listPage(input);
  assert.equal(first.total, 3);
  assert.equal(first.rows.length, 2);
  assert.equal(first.hasMore, true);
  const last = first.rows.at(-1);
  const second = f.store.listPage({ ...input, cursor: `${last.updatedAt}:${last.id}` });
  assert.equal(second.total, 3);
  assert.equal(second.hasMore, false);
  assert.deepEqual(new Set([...first.rows, ...second.rows].map(idea => idea.id)), new Set([shared.id, ...own.map(idea => idea.id)]));
  assert.equal(f.store.listPage({ ...input, backendId: "hermes" }).total, 2);
  assert.equal(f.store.listPage({ ...input, agentId: "another" }).total, 1);
  assert.equal(f.store.listPage({ ...input, agentId: "unused" }).total, 0);
  assert.deepEqual(f.store.listPage({ ...input, query: "共同参与" }).rows.map(idea => idea.id), [shared.id]);
  assert.deepEqual(f.store.listPage({ ...input, filter: "archived" }).rows.map(idea => idea.id), [archived.id]);
  const { validateInspirationServiceParams: validate } = require("../app/agent-service/inspiration-service-protocol");
  const legacy = { filter: "all", query: "", cursor: null, limit: 20 };
  assert.deepEqual(validate("inspiration.list", legacy), legacy);
  assert.deepEqual(validate("inspiration.list", input), input);
  for (const invalid of [{ ...legacy, backendId: scope.backendId }, { ...legacy, agentId: scope.agentId },
    { ...input, agentId: "" }, { ...input, backendId: null }, { ...input, agentId: "main' OR 1=1" }]) {
    assert.throws(() => validate("inspiration.list", invalid), { code: "INSPIRATION_INVALID" });
  }
});

test("external reserve is durable, freezes the idea, and replays with a changed derived session selection", (t) => {
  const f = fixture(t);
  const idea = f.create();
  const input = f.input(idea);
  const execution = f.store.prepareExternalExecution(input, () => true);
  assert.equal(execution.profileId, null);
  assert.equal(execution.workspace, null);
  assert.equal(execution.sessionKey, null);
  assert.equal(execution.external.phase, "preparing");
  assert.equal(execution.external.status, "queued");
  assert.equal(execution.external.reconcileFingerprint, null);
  f.store.update({ id: idea.id, operationId: id(), expectedRevision: 2, patch: { body: "Later edit" } });
  f.restart();
  const replay = f.store.prepareExternalExecution(input, () => { assert.fail("replay cannot repeat admission"); }, SESSION);
  assert.equal(replay.id, execution.id);
  assert.equal(replay.body, idea.body);
  assert.equal(replay.ideaRevision, idea.revision);
  assert.equal(f.store.executions().length, 1);
  assert.throws(() => f.store.prepareExternalExecution({ ...input, instruction: "Changed input" }, () => true), { code: "INSPIRATION_OPERATION_CONFLICT" });
});

test("unknown remains active even when the caller callback permits another run", (t) => {
  const f = fixture(t);
  const first = f.prepare();
  f.store.markExternalUnknown(first.id, "EXTERNAL_EXECUTION_UNCONFIRMED");
  const current = f.store.get(first.ideaId);
  assert.throws(() => f.store.prepareExternalExecution(f.input(current), () => true), { code: "INSPIRATION_BUSY" });
  assert.throws(() => f.store.prepareExecution({ ...f.input(current), profileId: "profile-1", backendId: "shoggoth", workspace: f.root }, () => true), { code: "INSPIRATION_BUSY" });
  f.store.finishExternalBeforeStart(first.id, { status: "canceled" });
  const next = f.store.prepareExternalExecution(f.input(current), () => true);
  assert.equal(next.retryOf, first.runId);
});

test("external admission rejects bad backends, workspace overrides, stale revisions, and native Profiles", (t) => {
  const f = fixture(t);
  const idea = f.create();
  for (const patch of [{ backendId: "shoggoth" }, { profileId: "native-profile" }, { workspace: "relative" }, { agentId: "bad agent" }]) {
    assert.throws(() => f.store.prepareExternalExecution(f.input(idea, patch), () => true), { code: "INSPIRATION_INVALID" });
  }
  assert.throws(() => f.store.prepareExternalExecution(f.input(idea, { expectedRevision: 2 }), () => true), { code: "INSPIRATION_REVISION_CONFLICT" });
  assert.equal(f.store.executions().length, 0);
});

test("binding freezes session, workspace, Agent mode, and host before dispatch", (t) => {
  const f = fixture(t);
  const execution = f.prepare(f.create(), { workspace: "/frozen/agent" });
  assert.throws(() => f.bind(execution), { code: "INSPIRATION_BINDING_INVALID" });
  const bound = f.bind(execution, { workspace: "/frozen/agent" });
  const result = { hostId: bound.external.hostId, binding: { sessionKey: bound.sessionKey, workspace: bound.workspace, mode: bound.external.mode } };
  assert.deepEqual(f.store.bindExternalSession(bound.id, result), bound);
  for (const patch of [{ sessionKey: "another-session" }, { workspace: "/changed" }, { mode: "acp" }]) {
    assert.throws(() => f.store.bindExternalSession(bound.id, { ...result, binding: { ...result.binding, ...patch } }), { code: "INSPIRATION_BINDING_INVALID" });
  }
  assert.throws(() => f.store.bindExternalSession(bound.id, { ...result, hostId: id() }), { code: "INSPIRATION_BINDING_INVALID" });
  const dispatched = f.store.markExternalDispatched(bound.id);
  assert.equal(dispatched.external.phase, "dispatched");
  assert.equal(dispatched.external.status, "starting");
  f.restart();
  assert.equal(f.store.executionForRun(bound.runId).external.phase, "dispatched");
  assert.deepEqual(f.store.markExternalDispatched(bound.id), dispatched);
});

test("a remote session cannot be reassigned to another inspiration or Agent", (t) => {
  const f = fixture(t);
  const first = f.bind(f.prepare());
  f.store.finishExternalBeforeStart(first.id, { status: "canceled" });
  const second = f.prepare(f.create("Another idea"));
  assert.throws(() => f.bind(second), { code: "INSPIRATION_BINDING_INVALID" });
  const current = f.store.get(first.ideaId);
  assert.throws(() => f.store.prepareExternalExecution(f.input(current, { agentId: "other" }), () => true, SESSION), { code: "INSPIRATION_BINDING_INVALID" });
});

test("all remote snapshot identity fields are checked against the frozen execution", (t) => {
  const f = fixture(t);
  const execution = f.store.markExternalDispatched(f.bind(f.prepare()).id);
  const changes = [{ executionId: id() }, { runId: id() }, { backendId: "hermes", mode: "gateway" },
    { agentId: "other" }, { sessionKey: "other-session" }, { workspace: "/another" }];
  for (const patch of changes) {
    assert.throws(() => update(f.store, execution, patch), { code: "INSPIRATION_BINDING_INVALID" });
  }
  assert.throws(() => update(f.store, execution, { unexpected: true }), { code: "INSPIRATION_RESPONSE_INVALID" });
  assert.throws(() => update(f.store, execution, { sequence: -1 }), { code: "INSPIRATION_RESPONSE_INVALID" });
  assert.throws(() => update(f.store, execution, { errorCode: "raw error text" }), { code: "INSPIRATION_RESPONSE_INVALID" });
  assert.equal(f.store.executionForRun(execution.runId).external.sequence, 0);
});

test("same-host snapshots are monotonic, duplicates do not write, and host replacement can restart sequence", (t) => {
  const f = fixture(t);
  let execution = f.store.markExternalDispatched(f.bind(f.prepare()).id);
  execution = update(f.store, execution, { sequence: 7, resultSummary: "progress" });
  const before = fs.readFileSync(f.store.filePath, "utf8");
  assert.deepEqual(update(f.store, execution, { sequence: 6, resultSummary: "old" }), execution);
  assert.deepEqual(update(f.store, execution, { sequence: 7, resultSummary: "progress" }), execution);
  assert.equal(fs.readFileSync(f.store.filePath, "utf8"), before);
  assert.throws(() => update(f.store, execution, { sequence: 7, resultSummary: "changed" }), { code: "INSPIRATION_BINDING_INVALID" });
  const nextHost = id();
  execution = update(f.store, execution, { sequence: 1, resultSummary: "recovered" }, nextHost);
  assert.equal(execution.external.hostId, nextHost);
  assert.equal(execution.external.sequence, 1);
  f.restart();
  assert.equal(f.store.executionForRun(execution.runId).external.resultSummary, "recovered");
});

test("local unknown deactivates attention and same-sequence recovery requires the original observation fingerprint", (t) => {
  const f = fixture(t);
  let execution = f.store.markExternalDispatched(f.bind(f.prepare()).id);
  const observed = snapshot(execution, { sequence: 4, status: "waiting_input", attention: attention(execution.runId) });
  execution = f.store.updateExternalSnapshot(execution.id, { hostId: execution.external.hostId, snapshot: observed });
  execution = f.store.markExternalUnknown(execution.id, "EXTERNAL_EXECUTION_UNCONFIRMED");
  assert.equal(execution.external.status, "unknown");
  assert.equal(execution.external.attention.active, false);
  assert.match(execution.external.reconcileFingerprint, /^[a-f0-9]{64}$/u);
  f.restart();
  assert.throws(() => f.store.updateExternalSnapshot(execution.id, { hostId: execution.external.hostId,
    snapshot: { ...observed, resultSummary: "unrelated change" } }), { code: "INSPIRATION_BINDING_INVALID" });
  execution = f.store.updateExternalSnapshot(execution.id, { hostId: execution.external.hostId, snapshot: observed });
  assert.equal(execution.external.status, "waiting_input");
  assert.equal(execution.external.attention.active, true);
  assert.equal(execution.external.reconcileFingerprint, null);
  execution = update(f.store, execution, { status: "unknown", attention: null, errorCode: "EXTERNAL_INSPECT_UNAVAILABLE" });
  assert.equal(execution.external.reconcileFingerprint, null);
  assert.throws(() => update(f.store, execution, { status: "running", sequence: execution.external.sequence }), { code: "INSPIRATION_BINDING_INVALID" });
});

test("terminal results persist and cannot regress on delayed or replaced hosts", (t) => {
  const f = fixture(t);
  let execution = f.store.markExternalDispatched(f.bind(f.prepare()).id);
  execution = update(f.store, execution, { status: "completed", resultSummary: "delivered result", sequence: 10 });
  assert.deepEqual(update(f.store, execution, { status: "running", sequence: 11 }), execution);
  assert.deepEqual(update(f.store, execution, { status: "unknown", sequence: 1 }, id()), execution);
  assert.deepEqual(f.store.markExternalUnknown(execution.id, "EXTERNAL_EXECUTION_UNCONFIRMED"), execution);
  assert.deepEqual(f.store.failPreparation(execution.id, "EXTERNAL_PREPARE_FAILED"), execution);
  f.restart();
  assert.equal(f.store.executionForRun(execution.runId).external.resultSummary, "delivered result");
});

test("cancel intent persists before side effects and blocks dispatch while preparing or prepared", (t) => {
  const f = fixture(t);
  const execution = f.bind(f.prepare());
  const operationId = id();
  const pending = f.store.setExternalCancel(execution.id, operationId);
  assert.equal(pending.external.cancelOperationId, operationId);
  f.restart();
  assert.deepEqual(f.store.setExternalCancel(execution.id, operationId), pending);
  const retryId = id();
  const retry = f.store.setExternalCancel(execution.id, retryId);
  assert.equal(retry.external.cancelOperationId, retryId);
  assert.deepEqual(f.store.setExternalCancel(execution.id, operationId), retry);
  assert.throws(() => f.store.markExternalDispatched(execution.id), { code: "INSPIRATION_BUSY" });
  const canceled = f.store.finishExternalBeforeStart(execution.id, { status: "canceled" });
  assert.equal(canceled.external.finishedAt, NOW);
  assert.equal(canceled.external.attention, null);
  assert.deepEqual(f.store.failPreparation(execution.id, "LATE_PREPARE_FAILURE"), canceled);
});

test("pre-start completion is allowed unbound, but dispatched work cannot be fabricated as preparation failure", (t) => {
  const f = fixture(t);
  const first = f.prepare();
  const failed = f.store.failPreparation(first.id, "PREPARE_UNAVAILABLE");
  assert.equal(failed.external.status, "failed");
  assert.equal(failed.external.hostId, null);
  assert.equal(failed.preparationFailure.code, "PREPARE_UNAVAILABLE");
  const second = f.prepare(f.store.get(first.ideaId));
  const canceled = f.store.finishExternalBeforeStart(second.id, { status: "canceled" });
  assert.equal(canceled.external.status, "canceled");
  assert.equal(canceled.sessionKey, null);
  const third = f.store.markExternalDispatched(f.bind(f.prepare(f.store.get(first.ideaId))).id);
  assert.throws(() => f.store.finishExternalBeforeStart(third.id, { status: "canceled" }), { code: "INSPIRATION_BINDING_INVALID" });
  assert.throws(() => f.store.failPreparation(third.id, "TOO_LATE"), { code: "INSPIRATION_BINDING_INVALID" });
});

test("remote result and attention pass the secret write gateway; responses persist only operation fingerprints", (t) => {
  const f = fixture(t, { assertSecretSafe: (value) => !JSON.stringify(value).includes("fixture-secret-value") });
  let execution = f.store.markExternalDispatched(f.bind(f.prepare()).id);
  assert.throws(() => update(f.store, execution, { resultSummary: "fixture-secret-value" }), { code: "INSPIRATION_SENSITIVE_CONTENT" });
  assert.throws(() => update(f.store, execution, { status: "waiting_input", attention: attention(execution.runId, { details: "fixture-secret-value" }) }), { code: "INSPIRATION_SENSITIVE_CONTENT" });
  execution = update(f.store, execution, { status: "waiting_input", attention: attention(execution.runId) });
  const response = { id: execution.ideaId, runId: execution.runId, operationId: id(), requestId: "question-1",
    response: { action: "submit", answers: { credential: "fixture-secret-value" } } };
  f.store.recordResponse(response);
  assert.equal(f.store.replayResponse(response), true);
  assert.equal(fs.readFileSync(f.store.filePath, "utf8").includes("fixture-secret-value"), false);
  assert.throws(() => f.store.replayResponse({ ...response, response: { action: "submit", answers: { credential: "different-secret" } } }), { code: "INSPIRATION_OPERATION_CONFLICT" });
});

test("malformed attention, foreign request ownership, and terminal active prompts are rejected", (t) => {
  const f = fixture(t);
  const execution = f.store.markExternalDispatched(f.bind(f.prepare()).id);
  assert.throws(() => update(f.store, execution, { status: "waiting_input", attention: attention(id()) }), { code: "INSPIRATION_RESPONSE_INVALID" });
  assert.throws(() => update(f.store, execution, { status: "waiting_input", attention: { ...attention(execution.runId), answers: { value: "unexpected" } } }), { code: "INSPIRATION_RESPONSE_INVALID" });
  assert.throws(() => update(f.store, execution, { status: "completed", attention: attention(execution.runId) }), { code: "INSPIRATION_BINDING_INVALID" });
});

test("a failed durable dispatch write leaves prepared state and an uncertain write poisons further changes", (t) => {
  const f = fixture(t);
  const execution = f.bind(f.prepare());
  const write = f.store.commitTransaction;
  f.store.commitTransaction = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  assert.throws(() => f.store.markExternalDispatched(execution.id), { code: "ENOSPC" });
  assert.equal(f.store.executionForRun(execution.runId).external.phase, "prepared");
  f.store.commitTransaction = () => { throw Object.assign(new Error("uncertain"), { committedUncertain: true }); };
  assert.throws(() => f.store.markExternalDispatched(execution.id), { code: "INSPIRATION_COMMIT_UNCERTAIN" });
  assert.throws(() => f.store.setExternalCancel(execution.id, id()), { code: "INSPIRATION_COMMIT_UNCERTAIN" });
  f.store.commitTransaction = write;
});

test("v1 and v2 native executions migrate losslessly to v3 while every old unknown field remains invalid", (t) => {
  for (const version of [1, 2]) {
    const f = fixture(t);
    const idea = f.create("Legacy native inspiration");
    const execution = f.store.prepareExecution({ ...f.input(idea), backendId: "shoggoth", profileId: "profile-1", workspace: f.root }, () => true);
    const native = f.store.bindSession(execution.id, id());
    const legacy = f.store.exportSnapshot();
    legacy.version = version;
    if (version === 1) for (const value of Object.values(legacy.ideas)) delete value.deletedAt;
    for (const value of Object.values(legacy.executions)) delete value.external;
    f.store.close();
    fs.unlinkSync(f.store.filePath);
    fs.writeFileSync(f.store.legacyPath, JSON.stringify(legacy), { mode: 0o600 });
    f.store.open();
    assert.deepEqual(f.store.executionForRun(native.runId), native);
    assert.equal(f.store.get(idea.id).deletedAt, null);
    f.store.update({ id: idea.id, operationId: id(), expectedRevision: 2, patch: { favorite: true } });
    assert.equal(f.store.exportSnapshot().version, INSPIRATION_STORE_VERSION);
    f.store.close();
    fs.unlinkSync(f.store.filePath);
    fs.unlinkSync(f.store.migratedPath);
    legacy.executions[execution.id].external = null;
    fs.writeFileSync(f.store.legacyPath, JSON.stringify(legacy), { mode: 0o600 });
    assert.throws(() => f.store.open(), { code: "INSPIRATION_STORE_CORRUPT" });
  }
});

test("migration rejects forged external ownership or undeclared persisted fields", (t) => {
  for (const mutate of [
    (execution) => { execution.profileId = "native-profile"; },
    (execution) => { execution.external.extra = true; },
    (execution) => { execution.external.mode = "acp"; },
    (execution) => { execution.external.reconcileFingerprint = "invalid"; },
  ]) {
    const f = fixture(t);
    const execution = f.bind(f.prepare());
    const data = f.store.exportSnapshot();
    f.store.close();
    fs.unlinkSync(f.store.filePath);
    mutate(data.executions[execution.id]);
    fs.writeFileSync(f.store.legacyPath, JSON.stringify(data), { mode: 0o600 });
    assert.throws(() => f.store.open(), { code: "INSPIRATION_STORE_CORRUPT" });
  }
});
