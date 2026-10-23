#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { bindingId } = require("../app/agent-service/agent-runtime-binding");

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

// Sending first checks that the session's runtime binding is enabled.
function runtimeGate(method, params) {
  const id = bindingId(params.profileId, "runtime-stability");
  if (method === "agent.binding.list") {
    return { bindings: [{ id, profileId: params.profileId, runtime: "codex", runtimeProfileId: "runtime-stability",
      runtimeAccountId: "account-stability", label: null, enabled: true, revision: 1, createdAt: 1, updatedAt: 1 }],
    defaultBindingId: id, revision: 1, canAdd: false };
  }
  return { sessionKey: params.sessionKey, revision: 1, bindingId: id, runtime: "codex", model: null,
    contextUsage: null, canSwitch: false, candidates: [{ bindingId: id, support: { supported: true },
      adjustments: { clearModelOverride: false, permissionMode: null } }] };
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
    if (["chat.session.runtime.get", "chat.session.runtime.state", "agent.binding.list", "agent.binding.sync"].includes(method)) return runtimeGate(method, params);
    calls.push({ method, params });
    return handler(method, params, calls);
  };
  return { backend, calls };
}

test("a missing current session binding blocks a send before receipt recovery", async () => {
  const { backend, calls } = backendWith(() => { throw new Error("no send expected"); });
  const request = backend._call;
  backend._call = (method, params) => ["chat.session.runtime.get", "chat.session.runtime.state"].includes(method)
    ? Promise.resolve({ bindingId: "missing-binding" }) : request(method, params);
  await assert.rejects(backend.sendMessage(KEY, "hello", "blocked-client"), { code: "AGENT_BINDING_NOT_FOUND" });
  assert.equal(calls.filter(call => call.method === "chat.send").length, 0);
  assert.equal(calls.filter(call => call.method === "chat.operation.get").length, 0);
});

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

test("history watcher confirms idle while background compaction is active", async () => {
  const { backend, calls } = backendWith((method) => {
    assert.equal(method, "run.list");
    return { runs: [workRun("completed"), workRun("running", {
      id: "compaction-stability", source: "compaction",
    })], hasMore: false, nextCursor: null };
  });
  const statuses = [];
  await backend.watchSession(KEY, { status: value => statuses.push(value.kind) });
  assert.deepEqual(statuses, ["idle"]);
  assert.equal(backend._activeBySession.has(SESSION_KEY), false);
  assert.equal(calls.filter(call => call.method === "chat.send").length, 0);
});

test("history watcher observes the chat when compaction shares its session", async () => {
  const { backend, calls } = backendWith((method) => {
    if (method === "run.list") return { runs: [workRun(), workRun("running", {
      id: "compaction-stability", source: "compaction",
    })], hasMore: false, nextCursor: null };
    if (method === "run.subscribe") return subscription([terminalEvent()]);
    if (method === "chat.history") return { items: [], nextCursor: null, hasMore: false };
    throw new Error(`unexpected ${method}`);
  });
  const statuses = [], finals = [];
  await backend.watchSession(KEY, { status: value => statuses.push(value.kind), final: text => finals.push(text) });
  assert.deepEqual(statuses, ["running"]);
  assert.deepEqual(finals, ["done"]);
  assert.equal(calls.filter(call => call.method === "chat.send").length, 0);
});

test("idle observation stays fenced by cancellation and backend generation", async () => {
  for (const invalidate of ["abort", "generation"]) {
    const { backend } = backendWith((method) => {
      assert.equal(method, "run.list");
      if (invalidate === "abort") controller.abort();
      else backend._generation += 1;
      return { runs: [], hasMore: false, nextCursor: null };
    });
    const controller = new AbortController(), statuses = [];
    await backend.watchSession(KEY, { status: value => statuses.push(value.kind) }, { signal: controller.signal });
    assert.deepEqual(statuses, []);
  }
});

test("status-only native completion keeps the streamed answer without a false read error", async () => {
  const answer = "original native final answer";
  const { backend, calls } = backendWith((method) => {
    if (method === "run.list") return { runs: [workRun()], hasMore: false, nextCursor: null };
    if (method === "run.subscribe") return subscription([
      { runId: "run-stability", streamId: STREAM_ID, seq: 1, type: "text",
        payload: { phase: "final_answer", text: answer } },
      { ...terminalEvent(), seq: 2, payload: { status: "completed", resultSummary: null, errorCode: null } },
    ]);
    if (method === "chat.history") return { items: [], nextCursor: null, hasMore: false };
    throw new Error(`unexpected ${method}`);
  });
  const finals = [], errors = [];
  await backend.watchSession(KEY, { final: text => finals.push(text), error: text => errors.push(text) });
  assert.deepEqual(finals, [answer]);
  assert.deepEqual(errors, []);
  assert.equal(calls.filter(call => call.method === "chat.send").length, 0);
});

test("compaction exclusion does not hide a foreign task from binding validation", async () => {
  const { backend } = backendWith(() => ({ runs: [workRun("running", {
    source: "inspiration", sourceId: "foreign-idea",
  })], hasMore: false, nextCursor: null }));
  await assert.rejects(backend.watchSession(KEY), { code: "WORK_RUN_CONTROL_MISMATCH" });
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

// 2026-10-20: one busy Service loop must not show every native Agent as reconnecting.
const busyTimeout = () => Object.assign(new Error("busy"), { code: "REQUEST_TIMEOUT",
  serviceRequestDiagnostic: { phase: "response", timeoutMs: 1000, elapsedMs: 1000, responseBytes: 0 } });
const lostTimeout = () => Object.assign(new Error("lost"), { code: "REQUEST_TIMEOUT",
  serviceRequestDiagnostic: { phase: "connect", timeoutMs: 1000, elapsedMs: 1000, responseBytes: 0 } });

test("a busy Service stays connected until it is silent past the grace window", async () => {
  let clock = 0, state = "busy";
  const { backend } = backendWith((method) => {
    assert.equal(method, "service.status");
    if (state === "busy") throw busyTimeout();
    if (state === "lost") throw lostTimeout();
    return { healthy: true, pendingCommandsLocked: false, mcpCredentialsLocked: false, instanceNonce: NONCE_A };
  });
  backend.readinessNow = () => clock;
  for (let sample = 0; sample < 3; sample += 1) {
    clock += 4_000;
    const busy = await backend.getStatus();
    assert.equal(busy.connected, true, `busy sample ${sample + 1} keeps the Agent online`);
    assert.equal(busy.info.busy, true);
    assert.equal(busy.info.cacheStale, undefined);
  }
  clock += 4_000;
  const silent = await backend.getStatus();
  assert.equal(silent.connected, false, "silent for 16s across 4 samples is a lost Service");
  assert.equal(silent.info.cacheStale, true);
  state = "ok";
  const recovered = await backend.getStatus();
  assert.equal(recovered.connected, true);
  assert.equal(recovered.info.busy, undefined);
  state = "lost";
  const lost = await backend.getStatus();
  assert.equal(lost.connected, false, "a connection that never completes is reported at once");
  assert.equal(backend.getAgents().length, 1, "the cached roster stays while identity is unknown");
});

test("a busy Service does not spend the stream's or the send receipt's retries", async () => {
  let clock = 0, subscriptions = 0, lookups = 0, acceptedOperation = null;
  const { backend, calls } = backendWith((method, params) => {
    clock += 5_000;
    if (method === "chat.send") { acceptedOperation = params.operationId; throw busyTimeout(); }
    if (method === "chat.operation.get") {
      lookups += 1;
      if (lookups <= 3) throw busyTimeout();
      return { status: "found", run: workRun("running", { idempotencyKey: `shoggoth:chat-send:${acceptedOperation}` }) };
    }
    if (method === "run.subscribe") {
      subscriptions += 1;
      if (subscriptions <= 4) throw busyTimeout();
      return subscription([terminalEvent()]);
    }
    if (method === "chat.history") return { items: [], nextCursor: null, hasMore: false };
    throw new Error(`unexpected ${method}`);
  });
  backend.readinessNow = () => clock;
  const finals = [], errors = [], statuses = [];
  await backend.sendMessage(KEY, "hello", "client-busy", {
    final: (...args) => finals.push(args), error: (message) => errors.push(message),
    status: (value) => statuses.push(value.kind),
  });
  assert.equal(calls.filter((call) => call.method === "chat.send").length, 1, "never resent");
  assert.equal(lookups, 4);
  assert.equal(subscriptions, 5);
  assert.deepEqual(errors, []);
  assert.equal(statuses.includes("needs_verification"), false);
  assert.equal(finals.length, 1);
});

// 2026-10-20: direct chats wait for Active Memory recall before admission; the
// live activity shows it as a step while chat.send is still pending.
function recallSend(phases, options = {}) {
  let statusReads = 0, release;
  const admitted = new Promise((resolve) => { release = resolve; });
  const { backend, calls } = backendWith(async (method) => {
    if (method === "memory.active.status") {
      statusReads += 1;
      if (options.statusError) throw Object.assign(new Error("busy"), { code: "REQUEST_TIMEOUT" });
      if (options.unsupported) return { supported: false };
      const phase = phases[Math.min(statusReads - 1, phases.length - 1)];
      if (statusReads >= (options.releaseAfter ?? 3)) release();
      return { supported: true, phase, outcome: null, updatedAt: null, statusLines: [], traceLines: [] };
    }
    if (method === "chat.send") {
      if (options.unsupported || options.statusError) setTimeout(release, 60);
      await admitted;
      return { run: workRun("running", { idempotencyKey: "shoggoth:chat-send:33333333-3333-4333-8333-333333333333" }) };
    }
    if (method === "run.subscribe") return subscription([terminalEvent()]);
    if (method === "chat.history") return { items: [], nextCursor: null, hasMore: false };
    throw new Error(`unexpected ${method}`);
  });
  backend.admissionRecallPollMs = 5;
  return { backend, calls, reads: () => statusReads };
}

test("a pending direct chat shows recall in live activity and completes it on admission", async () => {
  const { backend, calls } = recallSend(["preparing", "recalling", "recalling"], { releaseAfter: 4 });
  const statuses = [], finals = [];
  await backend.sendMessage(KEY, "你还记得吗", "client-recall", {
    status: (value) => statuses.push(value.kind), final: (...args) => finals.push(args) });
  assert.deepEqual(statuses.filter((kind) => ["recalling", "recalled"].includes(kind)), ["recalling", "recalled"]);
  assert.ok(statuses.indexOf("recalled") < statuses.indexOf("running"), "recall completes before the run status");
  assert.equal(calls.filter((call) => call.method === "chat.send").length, 1);
  assert.equal(finals.length, 1);
});

test("no recall step without a recall, and a failed or unsupported status read never affects the send", async () => {
  for (const [name, phases, options] of [["no-recall", ["preparing", "idle"], {}],
    ["status-error", ["idle"], { statusError: true }], ["unsupported", ["idle"], { unsupported: true }]]) {
    const { backend, reads } = recallSend(phases, options);
    const statuses = [], finals = [], errors = [];
    await backend.sendMessage(KEY, "hello", `client-${name}`, {
      status: (value) => statuses.push(value.kind), final: (...args) => finals.push(args), error: (message) => errors.push(message) });
    assert.deepEqual(statuses.filter((kind) => ["recalling", "recalled"].includes(kind)), []);
    assert.equal(finals.length, 1); assert.deepEqual(errors, []);
    if (options.unsupported) assert.equal(reads(), 1, "an unsupported status stops polling");
  }
});
