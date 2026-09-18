"use strict";

const assert = require("node:assert/strict");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const PROFILE_ID = "profile-default";
const AGENT_ID = "shoggoth-agent-default";
const STREAM_ID = "11111111-1111-4111-8111-111111111111";

function profile(overrides = {}) {
  return {
    id: PROFILE_ID,
    backendId: "shoggoth",
    agentId: AGENT_ID,
    name: "Shoggoth",
    runtime: "codex",
    runtimeProfileId: AGENT_ID,
    runtimeAccountId: "fixture-runtime-account",
    providerRef: null,
    defaultModel: null,
    defaultCwd: null,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: true,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function run(id, status, overrides = {}) {
  const waiting = status === "waiting_approval" || status === "waiting_input";
  const terminal = ["completed", "failed", "canceled", "interrupted", "skipped"].includes(status);
  return {
    id,
    source: "chat",
    sourceId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: `send-${id}`,
    profileId: PROFILE_ID,
    workspace: null,
    status,
    codexThreadId: "thread-safe",
    codexTurnId: status === "queued" ? null : "turn-safe",
    eventSeq: 1,
    waitingRequestId: waiting ? `request-${id}` : null,
    startedAt: status === "queued" ? null : 100,
    finishedAt: terminal ? 200 : null,
    resultSummary: terminal ? "safe summary" : null,
    errorCode: ["failed", "interrupted"].includes(status) ? "SAFE_FAILURE" : null,
    retryOf: null,
    ...overrides,
  };
}

function page(items) {
  return { runs: items, nextCursor: null, hasMore: false };
}

function event(runId, seq, type, payload) {
  return { runId, streamId: STREAM_ID, seq, type, payload };
}

function eventsPage(runId, events, overrides = {}) {
  return {
    runId,
    streamId: STREAM_ID,
    events,
    cursor: overrides.cursor ?? 0,
    nextCursor: overrides.nextCursor ?? (events.at(-1)?.seq || 0),
    hasMore: overrides.hasMore ?? false,
    baseSeq: overrides.baseSeq ?? 0,
    latestSeq: overrides.latestSeq ?? (events.at(-1)?.seq || 0),
    gap: overrides.gap ?? null,
    snapshot: overrides.snapshot ?? null,
  };
}

function backendWith(handler, now = () => 500) {
  const backend = new ShoggothBackend({
    requestService: async () => { throw new Error("transport must be stubbed"); },
    readToken: () => "token",
    randomUUID: () => "33333333-3333-4333-8333-333333333333",
    now,
  });
  const p = profile();
  backend._state = "started";
  backend._profilesByAgent = new Map([[p.agentId, p]]);
  backend._profilesById = new Map([[p.id, p]]);
  backend._call = handler;
  return backend;
}

async function testRunningWorkUsesAuthoritativeRunsAndProfileBinding() {
  const calls = [];
  const backend = backendWith(async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, "run.list");
    return page([
      run("run-running", "running", { source: "kanban", sourceId: "card-safe" }),
      run("run-waiting", "waiting_input"),
      run("run-queued", "queued"),
      run("run-done", "completed"),
    ]);
  });
  const result = await backend.getRunningWork();
  assert.equal(result.supported, true);
  assert.deepEqual(result.items.map((item) => item.runId), ["run-running"]);
  assert.ok(result.items.every((item) => item.backendId === "shoggoth"));
  assert.ok(result.items.every((item) => item.agentId === AGENT_ID));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, {
    profileId: PROFILE_ID, sessionKey: null, status: null, cursor: null, limit: 100,
  });

  backend._call = async () => page([run("run-foreign", "running", { profileId: "foreign" })]);
  await assert.rejects(() => backend.getRunningWork(), (error) => error.code === "PROFILE_NOT_FOUND");
}

async function testPendingPromptProjectionIsSafeAndPersistent() {
  const approval = run("run-approval", "waiting_approval");
  const input = run("run-input", "waiting_input");
  const backend = backendWith(async (method, params) => {
    if (method === "run.list") return page([approval, input]);
    if (method === "run.subscribe" && params.runId === approval.id) {
      return eventsPage(approval.id, [event(approval.id, 1, "approval", {
        requestId: approval.waitingRequestId,
        kind: "command",
        command: "npm test",
        reason: "Run tests",
        sessionApprovalAvailable: true,
        accessToken: "must-never-leak",
      })]);
    }
    if (method === "run.subscribe" && params.runId === input.id) {
      return eventsPage(input.id, [event(input.id, 1, "prompt", {
        requestId: input.waitingRequestId,
        kind: "mcp_elicitation",
        message: "Choose target",
        requestedSchema: {
          type: "object",
          required: ["target"],
          properties: { target: { type: "string", title: "Target" } },
        },
        secret: "must-never-leak",
      })]);
    }
    throw new Error(`unexpected ${method}`);
  });

  const result = await backend.getPendingApprovals();
  assert.equal(result.supported, true);
  assert.equal(result.items.length, 2);
  const projectedApproval = result.items.find((item) => item.kind === "approval");
  const projectedInput = result.items.find((item) => item.kind === "input");
  assert.equal(projectedApproval.commandText, "npm test");
  assert.equal(projectedApproval.message, "Run tests");
  assert.deepEqual(projectedApproval.allowedDecisions, ["once", "session", "deny", "cancel"]);
  assert.equal(projectedInput.message, "Choose target");
  assert.deepEqual(projectedInput.questions, [{
    id: "target",
    label: "Target",
    description: "",
    type: "text",
    required: true,
    secret: false,
    options: [],
  }]);
  assert.deepEqual(projectedInput.allowedDecisions, ["submit", "cancel"]);
  assert.ok(!JSON.stringify(result).includes("must-never-leak"));
}

async function testPendingPromptGapFallsBackWithoutInventingDetails() {
  const waiting = run("run-gap", "waiting_approval");
  const backend = backendWith(async (method) => {
    if (method === "run.list") return page([waiting]);
    return eventsPage(waiting.id, [], {
      cursor: 9,
      nextCursor: 9,
      baseSeq: 4,
      latestSeq: 9,
      gap: {
        code: "CURSOR_GAP",
        requestedAfterSeq: 0,
        baseSeq: 4,
      },
      snapshot: { run: waiting },
    });
  });
  const result = await backend.getPendingApprovals();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].requestId, waiting.waitingRequestId);
  assert.equal(result.items[0].commandText, undefined);
  assert.equal(result.items[0].message, undefined);
}

async function testRespondPendingPromptBindsRequestAndSamplesNowOnce() {
  const waiting = run("run-response", "waiting_approval");
  const approvalEvents = () => eventsPage(waiting.id, [event(waiting.id, 1, "approval", {
    requestId: waiting.waitingRequestId, kind: "command", command: "npm test", reason: "Run tests",
  })]);
  let nowCalls = 0;
  const calls = [];
  const backend = backendWith(async (method, params) => {
    calls.push({ method, params });
    if (method === "run.get") return { run: waiting };
    if (method === "run.subscribe") return approvalEvents();
    if (method === "run.approval.respond") {
      return {
        requestId: params.requestId,
        state: "responded",
        run: { ...waiting, status: "running", waitingRequestId: null },
      };
    }
    throw new Error(`unexpected ${method}`);
  }, () => {
    nowCalls += 1;
    return 500;
  });
  const result = await backend.respondDashboardPrompt({
    runId: waiting.id,
    requestId: waiting.waitingRequestId,
    kind: "approval",
    choice: "once",
  });
  assert.equal(result.run.id, waiting.id);
  assert.equal(result.run.status, "running");
  assert.equal(nowCalls, 1);
  assert.deepEqual(calls.map(call => call.method), ["run.get", "run.subscribe", "run.approval.respond"]);
  assert.equal(calls[2].params.createdAt, 500);

  backend._call = async (method) => method === "run.get" ? { run: waiting }
    : method === "run.subscribe" ? approvalEvents() : ({
    requestId: "wrong-request",
    state: "responded",
    run: { ...waiting, status: "running", waitingRequestId: null },
  });
  await assert.rejects(
    () => backend.respondDashboardPrompt({
      runId: waiting.id,
      requestId: waiting.waitingRequestId,
      kind: "approval",
      choice: "once",
    }),
    (error) => error.code === "WORK_RUN_CONTROL_MISMATCH",
  );
}

async function testMalformedApprovalDetailsStayDenyOnly() {
  const waiting = run("run-invalid-command", "waiting_approval");
  const backend = backendWith(async (method) => method === "run.list" ? page([waiting])
    : eventsPage(waiting.id, [event(waiting.id, 1, "approval", {
      requestId: waiting.waitingRequestId, kind: "command", command: ["npm", "test"],
      reason: "Legacy command detail", sessionApprovalAvailable: true,
    })]));
  const { items } = await backend.getPendingApprovals();
  assert.deepEqual(items[0].allowedDecisions, ["deny", "cancel"], "Incomplete canonical details must never expose an allow action");
  assert.match(items[0].message, /只能拒绝或取消/);
}

async function testRunDetailProjectsOnlySafeEventFields() {
  const completed = run("run-detail", "completed");
  const backend = backendWith(async (method, params) => {
    if (method === "run.get") return { run: completed };
    if (method === "run.subscribe") {
      return eventsPage(completed.id, [
        event(completed.id, 1, "status", { status: "running", accessToken: "hidden" }),
        event(completed.id, 2, "text", { text: "Safe output", rawSecret: "hidden" }),
        event(completed.id, 3, "tool.result", {
          method: "item/completed",
          tool: { kind: "commandExecution", name: "npm test", status: "completed", success: true },
          hidden: "hidden",
        }),
        event(completed.id, 4, "terminal", {
          status: "completed", resultSummary: "safe summary", internal: "hidden",
        }),
      ]);
    }
    throw new Error(`unexpected ${method} ${params?.runId}`);
  });
  const detail = await backend.getDashboardRunDetail(completed.id);
  assert.equal(detail.runId, completed.id);
  assert.equal(detail.agentId, AGENT_ID);
  assert.deepEqual(detail.events, [
    { seq: 1, type: "status", status: "running" },
    { seq: 2, type: "text", text: "Safe output" },
    {
      seq: 3,
      type: "tool.result",
      tool: { kind: "commandExecution", name: "npm test", status: "completed", success: true },
    },
    { seq: 4, type: "terminal", status: "completed", summary: "safe summary" },
  ]);
  assert.ok(!JSON.stringify(detail).includes("hidden"));
}

async function testRunEventPaginationMustAdvance() {
  const completed = run("run-loop", "completed");
  const backend = backendWith(async (method) => {
    if (method === "run.get") return { run: completed };
    return eventsPage(completed.id, [event(completed.id, 1, "status", { status: "running" })], {
      cursor: 0,
      nextCursor: 1,
      latestSeq: 2,
      hasMore: true,
    });
  });
  await assert.rejects(
    () => backend.getDashboardRunDetail(completed.id),
    (error) => error.code === "CURSOR_NOT_ADVANCING",
  );
}

const tests = [
  testRunningWorkUsesAuthoritativeRunsAndProfileBinding,
  testPendingPromptProjectionIsSafeAndPersistent,
  testPendingPromptGapFallsBackWithoutInventingDetails,
  testRespondPendingPromptBindsRequestAndSamplesNowOnce,
  testMalformedApprovalDetailsStayDenyOnly,
  testRunDetailProjectsOnlySafeEventFields,
  testRunEventPaginationMustAdvance,
];

(async () => {
  for (const test of tests) {
    await test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  process.stdout.write(`${tests.length}/${tests.length} Phase11 Shoggoth backend tests passed\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
