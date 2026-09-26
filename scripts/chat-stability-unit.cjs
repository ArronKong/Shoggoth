#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const SESSION_KEY = "11111111-1111-4111-8111-111111111111";
const STREAM_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "shoggoth-stability";
const KEY = `agent:${AGENT_ID}:${SESSION_KEY}`;
const NONCE_A = "a".repeat(48);
const NONCE_B = "b".repeat(48);

function workRun(status = "running", overrides = {}) {
  return {
    id: "run-stability", source: "chat", sourceId: SESSION_KEY,
    idempotencyKey: "shoggoth:chat-send:placeholder", profileId: "profile-stability",
    workspace: null, status, contextSnapshotId: null, runtimeSessionRef: null,
    runtimeTurnRef: null, eventSeq: 1, waitingRequestId: null, startedAt: 1,
    finishedAt: status === "completed" ? 2 : null,
    resultSummary: status === "completed" ? "done" : null,
    errorCode: null, retryOf: null, ...overrides,
  };
}

function subscription(events) {
  return {
    runId: "run-stability", streamId: STREAM_ID, events,
    cursor: 0, nextCursor: events.at(-1)?.seq || 0,
    hasMore: false, baseSeq: events.length ? 1 : 0,
    latestSeq: events.at(-1)?.seq || 0, gap: null, snapshot: null,
  };
}

function terminalEvent() {
  return { runId: "run-stability", streamId: STREAM_ID, seq: 1, type: "terminal",
    payload: { status: "completed", resultSummary: "done", errorCode: null } };
}

function backendWith(handler) {
  const calls = [];
  const backend = new ShoggothBackend({
    randomUUID: () => "33333333-3333-4333-8333-333333333333",
    now: () => 10,
    delay: () => Promise.resolve(),
    maxPollErrors: 1,
    pollIntervalMs: 0,
  });
  backend._state = "started";
  backend._complete = true;
  backend._generation = 1;
  backend._serviceInstanceNonce = NONCE_A;
  const profile = { id: "profile-stability", agentId: AGENT_ID };
  backend._profilesByAgent.set(AGENT_ID, profile);
  backend._profilesById.set(profile.id, profile);
  backend._sessionsByKey.set(SESSION_KEY, { id: "session-stability", sessionKey: SESSION_KEY,
    profileId: profile.id, workspace: null, derivedTitle: "existing", status: "ready" });
  backend._agents = [{ id: AGENT_ID }];
  backend._rows = [{ key: KEY }];
  backend._call = async (method, params) => {
    calls.push({ method, params });
    return handler(method, params, calls);
  };
  return { backend, calls };
}

test("status timeout preserves the cached roster and observer until identity changes", async () => {
  let status = "timeout";
  const { backend } = backendWith((method) => {
    assert.equal(method, "service.status");
    if (status === "timeout") throw Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" });
    return { healthy: true, pendingCommandsLocked: false,
      mcpCredentialsLocked: false, instanceNonce: status };
  });
  const observer = { cancelled: false };
  backend._polls.add(observer);
  const stale = await backend.getStatus();
  assert.equal(stale.connected, false);
  assert.equal(stale.info.cacheStale, true);
  assert.deepEqual(stale.info.readyAgentIds, []);
  assert.equal(backend.getAgents().length, 1);
  assert.equal(backend._sessionsByKey.size, 1);
  assert.equal(observer.cancelled, false);
  const repeated = await backend.getStatus();
  assert.equal(repeated.connected, false);
  assert.equal(backend._sessionsByKey.size, 1);
  assert.equal(observer.cancelled, false);
  status = NONCE_A;
  assert.equal((await backend.getStatus()).connected, true);
  status = NONCE_B;
  backend.start = async () => false;
  assert.equal((await backend.getStatus()).connected, false);
  assert.equal(backend._state, "recovering");
  assert.equal(backend.getAgents().length, 0);
  assert.equal(observer.cancelled, true);
});

test("lost chat.send receipt queries the same operation and observes one terminal", async () => {
  let acceptedOperation = null;
  const { backend, calls } = backendWith((method, params) => {
    if (method === "chat.send") {
      acceptedOperation = params.operationId;
      throw Object.assign(new Error("lost response"), { code: "REQUEST_TIMEOUT" });
    }
    if (method === "chat.operation.get") {
      assert.equal(params.operationId, acceptedOperation);
      return { status: "found", run: workRun("running", {
        idempotencyKey: `shoggoth:chat-send:${acceptedOperation}`,
      }) };
    }
    if (method === "run.subscribe") return subscription([terminalEvent()]);
    if (method === "chat.history") return { items: [], nextCursor: null, hasMore: false };
    throw new Error(`unexpected ${method}`);
  });
  const finals = [];
  const errors = [];
  await backend.sendMessage(KEY, "hello", "client-one", {
    final: (...args) => finals.push(args), error: (message) => errors.push(message),
  });
  assert.equal(calls.filter((call) => call.method === "chat.send").length, 1);
  assert.equal(calls.filter((call) => call.method === "chat.operation.get").length, 1);
  assert.equal(finals.length, 1);
  assert.deepEqual(errors, []);
});

test("unresolved send receipt is exposed for verification and never resent", async () => {
  const { backend, calls } = backendWith((method) => {
    if (method === "chat.send") throw Object.assign(new Error("lost response"), { code: "REQUEST_TIMEOUT" });
    if (method === "chat.operation.get") return { status: "unresolved", run: null };
    throw new Error(`unexpected ${method}`);
  });
  const statuses = [];
  const errors = [];
  await backend.sendMessage(KEY, "hello", "client-two", {
    status: (value) => statuses.push(value.kind), error: (message) => errors.push(message),
  });
  assert.equal(calls.filter((call) => call.method === "chat.send").length, 1);
  assert.deepEqual(statuses, ["needs_verification"]);
  assert.deepEqual(errors, []);
});

test("a mismatched operation lookup cannot turn an uncertain send into a retryable failure", async () => {
  const { backend, calls } = backendWith((method) => {
    if (method === "chat.send") throw Object.assign(new Error("lost response"), { code: "REQUEST_TIMEOUT" });
    if (method === "chat.operation.get") return { status: "found", run: workRun("running", {
      sourceId: "44444444-4444-4444-8444-444444444444",
    }) };
    throw new Error(`unexpected ${method}`);
  });
  const statuses = [];
  const errors = [];
  await backend.sendMessage(KEY, "hello", "client-three", {
    status: (value) => statuses.push(value.kind), error: (message) => errors.push(message),
  });
  assert.equal(calls.filter((call) => call.method === "chat.send").length, 1);
  assert.deepEqual(errors, []);
  assert.equal(statuses.at(-1), "needs_verification");
});

test("history watcher recovers a transient stream failure using run.get, with no send", async () => {
  let subscriptions = 0;
  const { backend, calls } = backendWith((method) => {
    if (method === "run.subscribe") {
      subscriptions += 1;
      if (subscriptions <= 5) throw Object.assign(new Error("disconnected"), { code: "SERVICE_DISCONNECTED" });
      return subscription([terminalEvent()]);
    }
    if (method === "run.get") return { run: workRun() };
    if (method === "chat.history") return { items: [], nextCursor: null, hasMore: false };
    throw new Error(`unexpected ${method}`);
  });
  backend.maxPollErrors = 5;
  backend._findActiveRun = async () => workRun();
  const statuses = [];
  const finals = [];
  await backend.watchSession(KEY, {
    status: (value) => statuses.push(value.kind), final: (text) => finals.push(text),
  });
  assert.equal(subscriptions, 6);
  assert.equal(calls.filter((call) => call.method === "run.get").length, 1);
  assert.equal(calls.filter((call) => call.method === "chat.send").length, 0);
  assert.equal(finals.length, 1);
  assert.ok(statuses.includes("reconnecting"));
});

test("watcher has a finite recovery budget and leaves the original run unsettled", async () => {
  const { backend, calls } = backendWith((method) => {
    if (method === "run.subscribe") throw Object.assign(new Error("disconnected"), { code: "SERVICE_DISCONNECTED" });
    if (method === "run.get") return { run: workRun() };
    throw new Error(`unexpected ${method}`);
  });
  backend._findActiveRun = async () => workRun();
  const statuses = [];
  const errors = [];
  await backend.watchSession(KEY, {
    status: (value) => statuses.push(value.kind), error: (message) => errors.push(message),
  });
  assert.equal(calls.filter((call) => call.method === "run.subscribe").length, 9);
  assert.equal(calls.filter((call) => call.method === "chat.send").length, 0);
  assert.deepEqual(errors, []);
  assert.equal(statuses.at(-1), "needs_verification");
});

test("approval snapshot restores its prompt after a history watcher reconnects", async () => {
  const waiting = workRun("waiting_approval", { waitingRequestId: "approval-one" });
  let subscriptions = 0;
  const { backend, calls } = backendWith((method) => {
    if (method === "run.subscribe") {
      subscriptions += 1;
      if (subscriptions === 1) return {
        ...subscription([]), gap: { code: "STREAM_RESET" }, snapshot: { run: waiting },
      };
      return subscription([terminalEvent()]);
    }
    if (method === "chat.history") return { items: [], nextCursor: null, hasMore: false };
    throw new Error(`unexpected ${method}`);
  });
  backend._findActiveRun = async () => waiting;
  backend._promptByRequest.set("approval-one", {
    sessionKey: SESSION_KEY, runId: waiting.id, requestId: "approval-one",
    kind: "approval", request: { kind: "product_confirmation", requestId: "approval-one" },
  });
  const prompts = [];
  const finals = [];
  await backend.watchSession(KEY, {
    prompt: (value) => prompts.push(value), final: (text) => finals.push(text),
  });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].requestId, "approval-one");
  assert.equal(finals.length, 1);
  assert.equal(calls.filter((call) => call.method === "run.approval.respond").length, 0);
});

test("invalid interaction data does not falsely report task failure or auto-cancel", async () => {
  const { backend, calls } = backendWith((method) => {
    if (method === "run.subscribe") return subscription([{
      runId: "run-stability", streamId: STREAM_ID, seq: 1,
      type: "approval", payload: { invalid: true },
    }]);
    throw new Error(`unexpected ${method}`);
  });
  backend._findActiveRun = async () => workRun();
  const statuses = [];
  const errors = [];
  await backend.watchSession(KEY, {
    status: (value) => statuses.push(value.kind), error: (message) => errors.push(message),
  });
  assert.equal(statuses.at(-1), "needs_verification");
  assert.deepEqual(errors, []);
  assert.equal(calls.filter((call) => call.method === "run.approval.respond").length, 0);
});
