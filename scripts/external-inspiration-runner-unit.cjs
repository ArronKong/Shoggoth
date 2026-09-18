"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { ExternalInspirationRunner } = require("../app/external-inspiration-runner");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");
const { validExternalSnapshot } = require("../app/external-inspiration-protocol");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(backendId = "hermes") {
  let time = 1_000;
  const backend = {};
  const calls = [];
  const callbacks = [];
  const binding = { sessionKey: `agent:fixture:opaque/${backendId}`, workspace: "/fixture/actual",
    mode: backendId === "openclaw" ? "openclaw" : "gateway" };
  const driver = {
    async prepare(input) { calls.push(["prepare", input]); return { ...binding }; },
    start(input, callback) { calls.push(["start", input]); callbacks.push(callback); return { status: "starting" }; },
    async inspect(input) { calls.push(["inspect", input]); return { status: "running" }; },
    async respond(input) { calls.push(["respond", input]); return { status: "running" }; },
    async cancel(input) { calls.push(["cancel", input]); return { status: "unknown", errorCode: "STOP_UNCONFIRMED" }; },
  };
  const registry = { getBackend: id => id === backendId ? backend : null };
  const runner = new ExternalInspirationRunner({ registry, adapters: { [backendId]: driver }, now: () => time });
  const prepare = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), backendId,
    agentId: "fixture-agent", sessionKey: null, workspace: null, operationId: "prepare-op" };
  const base = { executionId: prepare.executionId, runId: prepare.runId, backendId, agentId: prepare.agentId,
    ...binding, hostId: runner.hostId };
  const start = { ...base, prompt: "Original idea", operationId: "start-op" };
  return { runner, driver, registry, calls, callbacks, prepare, base, start, binding,
    setTime: value => { time = value; }, snapshot: () => runner.records.get(prepare.executionId)?.snapshot };
}

async function running(backendId) {
  const f = fixture(backendId);
  await f.runner.prepare(f.prepare);
  await f.runner.start(f.start);
  await tick();
  return f;
}

function attention(runId, requestId = "request-1", secret = false) {
  const request = normalizeInteractiveRequestV1({ runId, eventType: "prompt", payload: {
    requestId, message: secret ? "Temporary credential needed" : "Choose the next step",
    requestedSchema: { type: "object", properties: { answer: { type: "string", writeOnly: secret } }, required: ["answer"] },
  } });
  return { status: "waiting_input", attention: { request, active: true, occurredAt: 1_000,
    command: null, cwd: "/fixture/actual", details: null } };
}

for (const backendId of ["openclaw", "hermes"]) {
  test(`${backendId}: preparation and repeated start preserve one execution`, async () => {
    const f = fixture(backendId);
    const [a, b] = await Promise.all([f.runner.prepare(f.prepare), f.runner.prepare(f.prepare)]);
    assert.deepEqual(a, b);
    await assert.rejects(f.runner.prepare({ ...f.prepare, agentId: "another" }), { code: "INSPIRATION_OPERATION_CONFLICT" });
    await Promise.all([f.runner.start(f.start), f.runner.start(f.start)]);
    await tick();
    await f.runner.start(f.start);
    await assert.rejects(f.runner.start({ ...f.start, prompt: "Changed idea" }), { code: "INSPIRATION_OPERATION_CONFLICT" });
    await assert.rejects(f.runner.start({ ...f.start, operationId: "another-op" }), { code: "EXTERNAL_EXECUTION_UNCONFIRMED" });
    assert.equal(f.calls.filter(([name]) => name === "prepare").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "start").length, 1);
    assert.equal(f.calls.find(([name]) => name === "start")[1].runId, f.prepare.runId);
  });
}

test("A mismatched preparation never gains permission to send", async () => {
  for (const change of [{ mode: "openclaw" }, { workspace: "/wrong" }, { sessionKey: "other-session" }]) {
    const f = fixture();
    f.driver.prepare = async () => ({ ...f.binding, ...change });
    const input = { ...f.prepare, sessionKey: f.binding.sessionKey, workspace: f.binding.workspace };
    await assert.rejects(f.runner.prepare(input), { code: "INSPIRATION_BINDING_INVALID" });
    await assert.rejects(f.runner.start(f.start), { code: "INSPIRATION_BINDING_INVALID" });
    assert.equal(f.calls.length, 0);
  }
});

test("Lost-host recovery only inspects the frozen binding and never replays start", async () => {
  const f = fixture();
  const oldHost = crypto.randomUUID();
  const first = await f.runner.get({ ...f.base, hostId: oldHost });
  assert.equal(first.hostId, f.runner.hostId);
  assert.equal(first.snapshot.sessionKey, f.binding.sessionKey);
  assert.equal(f.calls[0][0], "inspect");
  assert.equal(f.calls[0][1].hostChanged, true);
  await assert.rejects(f.runner.start({ ...f.start, hostId: oldHost }), { code: "APP_HOST_UNAVAILABLE" });
  await assert.rejects(f.runner.start(f.start), { code: "EXTERNAL_EXECUTION_UNCONFIRMED" });
  assert.equal(f.calls.some(([name]) => name === "start" || name === "prepare"), false);
});

test("An old inspection cannot overwrite a newer callback, including its attention", async () => {
  const f = await running();
  const inspection = deferred();
  f.driver.inspect = () => inspection.promise;
  const first = f.runner.get(f.base), second = f.runner.get(f.base);
  await tick();
  f.callbacks[0](attention(f.base.runId));
  inspection.resolve({ status: "completed", resultSummary: "old observation" });
  const results = await Promise.all([first, second]);
  assert.ok(results.every(value => value.snapshot.status === "waiting_input"));
  assert.equal(results[0].snapshot.attention.request.requestId, "request-1");
});

test("An unchanged callback still supersedes an older inspection without advancing public sequence", async () => {
  const f = await running();
  f.callbacks[0]({ status: "running" });
  const sequence = f.snapshot().sequence;
  const inspection = deferred();
  f.driver.inspect = () => inspection.promise;
  const result = f.runner.get(f.base);
  await tick();
  f.callbacks[0]({ status: "running" });
  assert.equal(f.snapshot().sequence, sequence);
  inspection.resolve({ status: "completed", resultSummary: "stale observation" });
  assert.equal((await result).snapshot.status, "running");
  assert.equal(f.snapshot().sequence, sequence);
});

test("A delayed start acknowledgement cannot replace a newer progress callback", async () => {
  const f = fixture();
  const accepted = deferred();
  f.driver.start = (input, callback) => { f.callbacks.push(callback); return accepted.promise; };
  await f.runner.prepare(f.prepare);
  const response = await f.runner.start(f.start);
  assert.equal(response.snapshot.status, "starting", "Start must return before a delayed upstream acknowledgement");
  f.callbacks[0](attention(f.base.runId));
  accepted.resolve({ status: "starting" });
  await tick();
  assert.equal(f.snapshot().status, "waiting_input");
});

test("Lost start acknowledgement stays unknown and the same operation never sends again", async () => {
  const f = fixture();
  let starts = 0;
  f.driver.start = async () => { starts++; throw new Error("private-start-error"); };
  await f.runner.prepare(f.prepare);
  await f.runner.start(f.start);
  await tick();
  assert.equal(f.snapshot().status, "unknown");
  assert.equal(f.snapshot().finishedAt, null);
  await f.runner.start(f.start);
  await assert.rejects(f.runner.start({ ...f.start, operationId: "replay-with-new-id" }),
    { code: "EXTERNAL_EXECUTION_UNCONFIRMED" });
  assert.equal(starts, 1);
});

test("Unchanged observations retain sequence, and terminal time remains stable", async () => {
  const f = await running();
  const first = await f.runner.get(f.base);
  for (let index = 0; index < 5; index++) {
    f.setTime(2_000 + index);
    assert.equal((await f.runner.get(f.base)).snapshot.sequence, first.snapshot.sequence);
  }
  f.callbacks[0]({ status: "completed", resultSummary: "Confirmed result" });
  const terminal = await f.runner.get(f.base);
  f.setTime(99_000);
  f.callbacks[0]({ status: "completed", resultSummary: "Changed late result" });
  assert.deepEqual(await f.runner.get(f.base), terminal);
});

test("Secret responses are validated, deduplicated, and retained only as a fingerprint", async () => {
  const f = await running();
  const waiting = attention(f.base.runId, "secret-request", true);
  f.callbacks[0](waiting);
  f.driver.inspect = async () => waiting;
  const secret = "fixture-secret-canary";
  let responses = 0;
  f.driver.respond = async input => {
    assert.equal(input.response.answers.answer, secret);
    responses++;
    return { status: "running" };
  };
  const input = { ...f.base, requestId: "secret-request", operationId: "respond-op",
    response: { action: "submit", answers: { answer: secret } } };
  await Promise.all([f.runner.respond(input), f.runner.respond(input)]);
  assert.equal(responses, 1);
  const record = f.runner.records.get(f.base.executionId);
  assert.equal(JSON.stringify(record, (key, value) => value instanceof Map ? [...value] : value).includes(secret), false);
  assert.match(record.operations.get("respond:respond-op").fingerprint, /^[a-f0-9]{64}$/u);
  await assert.rejects(f.runner.respond({ ...input, response: { action: "submit", answers: { answer: "changed" } } }),
    { code: "INSPIRATION_OPERATION_CONFLICT" });
  await assert.rejects(f.runner.respond({ ...input, operationId: "invalid-op", response: { action: "submit", answers: {} } }),
    { code: "INTERACTION_RESPONSE_INVALID" });
  assert.equal(responses, 1);
});

test("A response acknowledgement cannot erase the next callback request", async () => {
  const f = await running();
  const waiting = attention(f.base.runId);
  f.callbacks[0](waiting);
  f.driver.inspect = async () => waiting;
  const sent = deferred();
  f.driver.respond = () => sent.promise;
  const result = f.runner.respond({ ...f.base, requestId: "request-1", operationId: "response",
    response: { action: "submit", answers: { answer: "Proceed" } } });
  await tick();
  f.callbacks[0](attention(f.base.runId, "request-2"));
  sent.resolve({ status: "running" });
  assert.equal((await result).snapshot.attention.request.requestId, "request-2");
});

test("Canceling queued work and canceling in the start microtask window prevent dispatch", async () => {
  for (const order of ["cancel-first", "start-first"]) {
    const f = fixture();
    await f.runner.prepare(f.prepare);
    const cancel = () => f.runner.cancel({ ...f.base, operationId: "cancel" });
    if (order === "cancel-first") { await cancel(); await f.runner.start(f.start); }
    else await Promise.all([f.runner.start(f.start), cancel()]);
    await tick();
    assert.equal(f.snapshot().status, "canceled");
    assert.equal(f.calls.some(([name]) => name === "start" || name === "cancel"), false);
  }
});

test("Cancellation waits for start acceptance and requires a confirmed stop", async () => {
  const f = fixture();
  const accepted = deferred();
  f.driver.start = () => { f.calls.push(["start"]); return accepted.promise; };
  await f.runner.prepare(f.prepare);
  await f.runner.start(f.start);
  const canceled = f.runner.cancel({ ...f.base, operationId: "cancel" });
  await tick();
  assert.equal(f.calls.some(([name]) => name === "cancel"), false);
  assert.notEqual(f.snapshot().status, "canceled");
  accepted.resolve({ status: "running" });
  assert.equal((await canceled).snapshot.status, "unknown");
  assert.equal(f.calls.filter(([name]) => name === "cancel").length, 1);
  f.driver.cancel = async () => ({ status: "canceled" });
  assert.equal((await f.runner.cancel({ ...f.base, operationId: "retry-cancel" })).snapshot.status, "canceled");
});

test("Reset prevents old queued actions, old callbacks, and old replies from owning the new host", async () => {
  const preparing = fixture();
  const preparation = preparing.runner.prepare(preparing.prepare);
  preparing.runner.reset();
  await assert.rejects(preparation, { code: "APP_HOST_UNAVAILABLE" });
  assert.equal(preparing.calls.length, 0);

  const starting = fixture();
  await starting.runner.prepare(starting.prepare);
  const dispatched = starting.runner.start(starting.start);
  starting.runner.reset();
  await assert.rejects(dispatched, { code: "APP_HOST_UNAVAILABLE" });
  await tick();
  assert.equal(starting.calls.some(([name]) => name === "start"), false);

  const f = await running();
  const inspection = deferred();
  f.driver.inspect = () => inspection.promise;
  const inspected = f.runner.get(f.base);
  await tick();
  f.runner.reset();
  f.callbacks[0]({ status: "completed", resultSummary: "stale completion" });
  inspection.resolve({ status: "running" });
  await assert.rejects(inspected, { code: "APP_HOST_UNAVAILABLE" });
  assert.equal(f.runner.records.size, 0);
  f.driver.inspect = async () => ({ status: "unknown", errorCode: "HERMES_EXECUTION_UNCONFIRMED" });
  const recovered = await f.runner.get(f.base);
  assert.notEqual(recovered.hostId, f.base.hostId);
  f.callbacks[0]({ status: "completed" });
  assert.equal(f.snapshot().status, "unknown");
});

test("Reset during a response preflight prevents submitting the old request", async () => {
  const f = await running();
  const waiting = attention(f.base.runId);
  f.callbacks[0](waiting);
  const inspection = deferred();
  f.driver.inspect = () => inspection.promise;
  const response = f.runner.respond({ ...f.base, requestId: "request-1", operationId: "respond-after-reset",
    response: { action: "submit", answers: { answer: "Do not send" } } });
  await tick();
  f.runner.reset();
  inspection.resolve(waiting);
  await assert.rejects(response, { code: "APP_HOST_UNAVAILABLE" });
  assert.equal(f.calls.some(([name]) => name === "respond"), false);
});

test("Invalid or failed transport observations remain nonterminal", async () => {
  const f = await running();
  f.callbacks[0]({ status: "completed", attention: {} });
  assert.equal(f.snapshot().status, "unknown");
  assert.equal(validExternalSnapshot(f.snapshot()), true);
  f.driver.inspect = async () => { throw new Error("private-error-canary"); };
  const result = await f.runner.get(f.base);
  assert.equal(result.snapshot.status, "unknown");
  assert.equal(result.snapshot.finishedAt, null);
  assert.equal(JSON.stringify(result).includes("private-error-canary"), false);
});
