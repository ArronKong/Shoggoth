"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OpenClawInspirationAdapter } = require("../app/core/openclaw-inspiration-adapter");
const { validInspirationAttention } = require("../app/agent-service/inspiration-service-protocol");

const NOW = 2000000000000;
const SESSION = `agent:main:dashboard:inspiration-${"a".repeat(64)}`;
const TARGET = { agentId: "main", sessionKey: SESSION, runId: "inspiration-run-1" };

function fixture() {
  const state = {
    workspace: "/srv/openclaw/agent", tasks: [], questions: [], approvals: [], active: false,
    methods: null, scopes: null, overrides: {}, calls: [], now: NOW, finalObserver: null,
  };
  const backend = {
    _connect: async () => {},
    hasGatewayMethod: (method) => state.methods === null || state.methods.includes(method),
    _hasGatewayScope: (scope) => state.scopes === null || state.scopes.includes(scope),
    requestWithFinalObservation(method, params, observer) {
      state.finalObserver = observer;
      observer.signal.addEventListener("abort", () => observer.onClose(), { once: true });
      return this.request(method, params);
    },
    async request(method, params) {
      state.calls.push({ method, params });
      if (state.overrides[method]) return state.overrides[method](params);
      switch (method) {
        case "agents.list": return { agents: [{ id: "main", workspace: state.workspace }] };
        case "sessions.create": return { ok: true, key: params.key, runStarted: false };
        case "sessions.list": return { sessions: [{ key: SESSION, hasActiveRun: state.active }] };
        case "agent": return { runId: params.idempotencyKey, sessionKey: params.sessionKey, agentId: params.agentId, status: "accepted" };
        case "tasks.list": return { tasks: state.tasks };
        case "tasks.get": return { task: state.tasks.find((task) => (task.taskId || task.id) === params.taskId) };
        case "question.list": return { questions: state.questions };
        case "exec.approval.list": return state.approvals;
        case "exec.approval.get": {
          const row = state.approvals.find((approval) => approval.id === params.id);
          return { id: row.id, agentId: row.request.agentId,
            commandText: row.request.command, allowedDecisions: row.request.allowedDecisions };
        }
        case "question.resolve":
          state.questions = state.questions.filter((question) => question.id !== params.id);
          return { status: params.cancel ? "cancelled" : "answered", answers: params.answers };
        case "exec.approval.resolve":
          state.approvals = state.approvals.filter((approval) => approval.id !== params.id);
          return { ok: true };
        case "chat.abort": return { ok: true, aborted: false, runIds: [] };
        case "tasks.cancel": return { found: true, cancelled: false };
        default: throw new Error(`Unexpected fake method ${method}`);
      }
    },
  };
  return { state, backend, adapter: new OpenClawInspirationAdapter({ backend, now: () => state.now }) };
}

async function observeResult(adapter, state, text) {
  await adapter.start({ ...TARGET, prompt: "Do the work", workspace: state.workspace });
  state.finalObserver.onFinal({ ok: true, payload: { runId: TARGET.runId, status: "ok",
    summary: "completed", result: { payloads: [{ text }] } } });
}

function task(overrides = {}) {
  return { id: "task-1", taskId: "task-1", ...TARGET, status: "running", ...overrides };
}

function question(overrides = {}) {
  return { id: "question-1", ...TARGET, createdAtMs: NOW - 100, expiresAtMs: NOW + 60000,
    status: "pending", questions: [{ questionId: "destination", header: "Destination",
      question: "Choose destination", options: [{ label: "A", description: "First" }, { label: "B" }] }], ...overrides };
}

function approval(overrides = {}) {
  return { id: "approval-1", createdAtMs: NOW - 100, expiresAtMs: NOW + 60000,
    request: { ...TARGET, command: "pwd", cwd: "/srv/openclaw/agent",
      allowedDecisions: ["allow-once", "allow-always", "deny"] }, ...overrides };
}

test("prepare freezes the remote Agent workspace and deterministic session identity without executing", async () => {
  const { state, adapter } = fixture();
  const first = await adapter.prepare({ agentId: "main", sessionId: "execution-session-1" });
  const second = await adapter.prepare({ agentId: "main", sessionId: "execution-session-1", workspace: "/srv/openclaw/agent/" });
  assert.deepEqual(first, second);
  assert.equal(first.mode, "openclaw");
  assert.equal(first.workspace, state.workspace);
  assert.match(first.sessionKey, /^agent:main:dashboard:inspiration-[a-f0-9]{64}$/u);
  assert.deepEqual(state.calls.filter((call) => call.method === "sessions.create").map((call) => call.params.key), [first.sessionKey, first.sessionKey]);
  assert.equal(state.calls.find((call) => call.method === "sessions.create").params.idempotencyKey, "inspiration-session:execution-session-1");
  assert.equal(state.calls.some((call) => call.method === "agent"), false);
});

test("existing inspiration session is bound without creating or resetting it", async () => {
  const { state, adapter } = fixture();
  const result = await adapter.prepare({ agentId: "main", sessionKey: SESSION, workspace: state.workspace });
  assert.equal(result.sessionKey, SESSION);
  assert.equal(state.calls.some((call) => call.method === "sessions.create"), false);
  await assert.rejects(adapter.prepare({ agentId: "main", sessionKey: "agent:other:main" }), { code: "OPENCLAW_EXECUTION_IDENTITY_INVALID" });
});

test("unsupported methods, scopes, workspace overrides, and creation identity changes fail before start", async () => {
  for (const [mutate, code] of [
    [(s) => { s.methods = ["agents.list"]; }, "OPENCLAW_INSPIRATION_UNSUPPORTED"],
    [(s) => { s.scopes = ["operator.read"]; }, "OPENCLAW_INSPIRATION_SCOPE_REQUIRED"],
    [(s) => { s.workspace = "relative/workspace"; }, "OPENCLAW_WORKSPACE_UNAVAILABLE"],
    [(s) => { s.overrides["sessions.create"] = () => ({ ok: true, key: "another-session" }); }, "OPENCLAW_SESSION_IDENTITY_MISMATCH"],
  ]) {
    const { state, adapter } = fixture();
    mutate(state);
    await assert.rejects(adapter.prepare({ agentId: "main", sessionId: "session-1" }), { code });
    assert.equal(state.calls.some((call) => call.method === "agent"), false);
  }
  const { adapter } = fixture();
  await assert.rejects(adapter.prepare({ agentId: "main", sessionId: "session-1", workspace: "/override" }), { code: "OPENCLAW_WORKSPACE_MISMATCH" });
});

test("start rechecks frozen workspace and uses the persisted run ID exactly once", async () => {
  const { state, adapter } = fixture();
  assert.equal((await adapter.start({ ...TARGET, prompt: "Do the work", workspace: state.workspace })).status, "starting");
  assert.deepEqual(state.calls.find((call) => call.method === "agent").params, {
    agentId: TARGET.agentId, sessionKey: SESSION, message: "Do the work", idempotencyKey: TARGET.runId, deliver: false,
  });
  state.workspace = "/changed";
  await assert.rejects(adapter.start({ ...TARGET, prompt: "Do more work", workspace: "/srv/openclaw/agent" }), { code: "OPENCLAW_WORKSPACE_MISMATCH" });
  assert.equal(state.calls.filter((call) => call.method === "agent").length, 1);
});

test("uncertain or misbound acceptance is never retried or reported completed", async () => {
  for (const override of [() => { throw new Error("timeout after acceptance"); }, () => ({ runId: "another-run", sessionKey: SESSION, status: "accepted" })]) {
    const { state, adapter } = fixture();
    state.overrides.agent = override;
    const result = await adapter.start({ ...TARGET, prompt: "Do the work", workspace: state.workspace });
    assert.equal(result.status, "unknown");
    assert.equal(state.calls.filter((call) => call.method === "agent").length, 1);
  }
});

test("inspect matches only the exact session, run, and Agent and reads the observed final result", async () => {
  const { state, adapter } = fixture();
  state.tasks = [
    task({ id: "wrong-run", taskId: "wrong-run", runId: "old-run", status: "completed" }),
    task({ id: "wrong-session", taskId: "wrong-session", sessionKey: "agent:main:main", childSessionKey: SESSION, status: "completed" }),
    task({ id: "wrong-agent", taskId: "wrong-agent", agentId: "other", status: "completed" }),
    task({ status: "completed", result: "full result", terminalSummary: "short result", progressSummary: "progress" }),
  ];
  await observeResult(adapter, state, "full result");
  assert.deepEqual(await adapter.inspect(TARGET), { status: "completed", resultSummary: "full result", errorCode: null, attention: null });
  assert.deepEqual(state.calls.filter((call) => call.method === "tasks.get").map((call) => call.params), [{ taskId: "task-1" }]);
});

test("missing, ambiguous, incomplete, and changed task identity remain unknown", async () => {
  for (const [setup, code] of [
    [() => {}, "OPENCLAW_TASK_NOT_FOUND"],
    [(s) => { s.tasks = [task(), task({ id: "task-2", taskId: "task-2" })]; }, "OPENCLAW_TASK_IDENTITY_AMBIGUOUS"],
    [(s) => { s.overrides["tasks.list"] = () => ({ tasks: [], nextCursor: "same-cursor" }); }, "OPENCLAW_TASK_SCAN_INCOMPLETE"],
    [(s) => { s.tasks = [task()]; s.overrides["tasks.get"] = () => ({ task: task({ runId: "changed-run" }) }); }, "OPENCLAW_TASK_IDENTITY_MISMATCH"],
  ]) {
    const { state, adapter } = fixture();
    setup(state);
    const result = await adapter.inspect(TARGET);
    assert.equal(result.status, "unknown");
    assert.equal(result.errorCode, code);
  }
});

test("task pagination reconciles the exact match and terminal summaries are bounded", async () => {
  const { state, adapter } = fixture();
  state.tasks = [task({ status: "completed", result: "r".repeat(5000) })];
  await observeResult(adapter, state, "r".repeat(5000));
  state.overrides["tasks.list"] = (params) => params.cursor ? { tasks: state.tasks } : { tasks: [], nextCursor: "100" };
  const result = await adapter.inspect(TARGET);
  assert.equal(result.status, "completed");
  assert.equal(result.resultSummary.length, 4000);
  assert.equal(state.calls.filter((call) => call.method === "tasks.list").length, 2);
});

test("result projection preserves Unicode and stays within the public encoded limit", async () => {
  for (const result of ["r".repeat(3999) + "😀", "\u0001".repeat(4000), "bad\0text\ud800"]) {
    const { state, adapter } = fixture();
    state.tasks = [task({ status: "completed", result })];
    await observeResult(adapter, state, result);
    const view = await adapter.inspect(TARGET);
    assert.equal(view.resultSummary.isWellFormed(), true);
    assert.equal(view.resultSummary.includes("\0"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(view.resultSummary)) <= 16 * 1024);
  }
});

test("completion waits briefly for its exact final RPC and then publishes model output", async () => {
  const { state, adapter } = fixture();
  const updates = [];
  await adapter.start({ ...TARGET, prompt: "Do the work", workspace: state.workspace }, value => updates.push(value));
  state.tasks = [task({ status: "completed", result: "completed" })];
  assert.equal((await adapter.inspect(TARGET)).status, "running");
  state.finalObserver.onFinal({ ok: true, payload: { runId: TARGET.runId, status: "ok",
    result: { payloads: [{ text: "The actual answer." }] } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.at(-1).status, "completed");
  assert.equal(updates.at(-1).resultSummary, "The actual answer.");
  assert.equal((await adapter.inspect(TARGET)).resultSummary, "The actual answer.");
  adapter.reset();
});

test("completion grace expiration, transport loss, and host recovery expose missing output honestly", async () => {
  for (const mode of ["grace", "closed", "recovered"]) {
    const { state, adapter } = fixture();
    if (mode !== "recovered") await adapter.start({ ...TARGET, prompt: "Do the work", workspace: state.workspace });
    state.tasks = [task({ status: "completed", result: "completed", terminalSummary: "completed" })];
    if (mode === "grace") {
      assert.equal((await adapter.inspect(TARGET)).status, "running");
      state.now += 5000;
    } else if (mode === "closed") state.finalObserver.onClose();
    assert.deepEqual(await adapter.inspect(TARGET), { status: "completed", resultSummary: null,
      errorCode: "OPENCLAW_RESULT_UNAVAILABLE", attention: null });
    adapter.reset();
  }
});

test("final output is restricted to bounded text payloads and omits reasoning and metadata", async () => {
  const { state, adapter } = fixture();
  await adapter.start({ ...TARGET, prompt: "Do the work", workspace: state.workspace });
  state.tasks = [task({ status: "completed" })];
  state.finalObserver.onFinal({ ok: true, payload: { runId: TARGET.runId, status: "ok", result: { payloads: [
    { text: " private reasoning ", isReasoning: true }, { text: "comment", isCommentary: true },
    { text: "tool error", isError: true }, { text: " First ", mediaUrl: "private-url" },
    { text: { unsafe: true } }, { mediaUrl: "another-private-url" }, { text: "Second" },
  ] } } });
  assert.equal((await adapter.inspect(TARGET)).resultSummary, "First\n\nSecond");
  adapter.reset();
});

test("empty or media-only final response preserves completion without inventing an answer", async () => {
  const { state, adapter } = fixture();
  await adapter.start({ ...TARGET, prompt: "Do the work", workspace: state.workspace });
  state.tasks = [task({ status: "completed", result: "completed" })];
  state.finalObserver.onFinal({ ok: true, payload: { runId: TARGET.runId, status: "ok",
    result: { payloads: [{ text: " ", mediaUrl: "private-media" }] } } });
  const view = await adapter.inspect(TARGET);
  assert.equal(view.status, "completed");
  assert.equal(view.resultSummary, null);
  assert.equal(view.errorCode, "OPENCLAW_RESULT_UNAVAILABLE");
  adapter.reset();
});

test("unrelated final response and reset callbacks cannot inject output", async () => {
  const { state, adapter } = fixture();
  const updates = [];
  await adapter.start({ ...TARGET, prompt: "Do the work", workspace: state.workspace }, value => updates.push(value));
  state.tasks = [task({ status: "completed" })];
  const observer = state.finalObserver;
  observer.onFinal({ ok: true, payload: { runId: "different-run", status: "ok",
    result: { payloads: [{ text: "wrong answer" }] } } });
  assert.equal((await adapter.inspect(TARGET)).resultSummary, null);
  adapter.reset();
  assert.equal(observer.signal.aborted, true);
  observer.onFinal({ ok: true, payload: { runId: TARGET.runId, status: "ok",
    result: { payloads: [{ text: "late answer" }] } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, 0);
  assert.equal(adapter.observations.size, 0);
});

test("cancel racing an already completed task still waits for and returns its final answer", async () => {
  const { state, adapter } = fixture();
  await adapter.start({ ...TARGET, prompt: "Do the work", workspace: state.workspace });
  state.tasks = [task({ status: "completed", result: "completed" })];
  assert.equal((await adapter.cancel(TARGET)).status, "running");
  state.finalObserver.onFinal({ ok: true, payload: { runId: TARGET.runId, status: "ok",
    result: { payloads: [{ text: "Completed before cancel." }] } } });
  const result = await adapter.cancel(TARGET);
  assert.equal(result.status, "completed");
  assert.equal(result.resultSummary, "Completed before cancel.");
  assert.equal(state.calls.some(call => ["chat.abort", "tasks.cancel"].includes(call.method)), false);
  adapter.reset();
});

test("task states map explicitly and canceled ledger rows require observed inactivity", async () => {
  for (const [upstream, expected] of [["queued", "starting"], ["running", "running"], ["completed", "completed"], ["failed", "failed"], ["timed_out", "failed"], ["cancelled", "canceled"], ["new-status", "unknown"]]) {
    const { state, adapter } = fixture();
    state.tasks = [task({ status: upstream })];
    assert.equal((await adapter.inspect(TARGET)).status, expected);
  }
  const { state, adapter } = fixture();
  state.tasks = [task({ status: "cancelled" })];
  state.active = true;
  assert.equal((await adapter.inspect(TARGET)).errorCode, "OPENCLAW_STOP_UNCONFIRMED");
});

test("pending question round trips through canonical attention and the OpenClaw answer wrapper", async () => {
  const { state, adapter } = fixture();
  state.tasks = [task()];
  state.questions = [question()];
  const view = await adapter.inspect(TARGET);
  assert.equal(view.status, "waiting_input");
  assert.equal(view.attention.request.runId, TARGET.runId);
  assert.equal(view.attention.request.fields[0].type, "choice");
  assert.equal(view.attention.active, true);
  assert.equal(validInspirationAttention(view.attention, TARGET.runId), true);
  const result = await adapter.respond({ ...TARGET, requestId: "question-1", response: { action: "submit", answers: { question_0: "A" } } });
  assert.equal(result.status, "running");
  const params = state.calls.find((call) => call.method === "question.resolve").params;
  assert.deepEqual(JSON.parse(JSON.stringify(params)), { id: "question-1", answers: { answers: { destination: ["A"] } } });
});

test("multi-select uses one answer per line, rejects illegal values, and preserves Other", async () => {
  const { state, adapter } = fixture();
  const row = question();
  row.questions[0].multiSelect = true;
  state.tasks = [task()];
  state.questions = [row];
  const view = await adapter.inspect(TARGET);
  assert.equal(view.attention.request.fields[0].type, "text");
  assert.match(view.attention.request.fields[0].description, /每行/u);
  assert.equal(validInspirationAttention(view.attention, TARGET.runId), true);
  await assert.rejects(adapter.respond({ ...TARGET, requestId: row.id, response: { action: "submit", answers: { question_0: "A\nC" } } }), { code: "INTERACTION_RESPONSE_INVALID" });
  assert.equal(state.calls.some((call) => call.method === "question.resolve"), false);
  row.questions[0].isOther = true;
  await adapter.respond({ ...TARGET, requestId: row.id, response: { action: "submit", answers: { question_0: "A\nC" } } });
  assert.deepEqual(state.calls.find((call) => call.method === "question.resolve").params.answers.answers.destination, ["A", "C"]);
});

test("multi-select matches trimmed option labels and forwards their canonical spelling", async () => {
  const { state, adapter } = fixture();
  const row = question();
  row.questions[0].multiSelect = true;
  row.questions[0].options[0].label = " A ";
  state.tasks = [task()];
  state.questions = [row];
  await adapter.respond({ ...TARGET, requestId: row.id, response: { action: "submit", answers: { question_0: "A\nB" } } });
  assert.deepEqual(state.calls.find((call) => call.method === "question.resolve").params.answers.answers.destination, [" A ", "B"]);
});

test("secret-store answers are marked secret, display storage semantics, and never returned", async () => {
  const { state, adapter } = fixture();
  const row = question();
  row.questions[0] = { questionId: "credential", header: "API key", question: "Provide the key", options: [], isSecret: true,
    secretStore: { kind: "secret", name: "SERVICE_KEY", allowedHosts: ["api.example.test"], reason: "Connect the service" },
    secretStoreExisting: { updatedAtMs: NOW - 1000 } };
  state.tasks = [task()];
  state.questions = [row];
  const view = await adapter.inspect(TARGET);
  assert.equal(view.attention.request.fields[0].secret, true);
  assert.equal(validInspirationAttention(view.attention, TARGET.runId), true);
  assert.match(view.attention.request.fields[0].description, /SERVICE_KEY/u);
  assert.match(view.attention.request.fields[0].description, /api\.example\.test/u);
  assert.match(view.attention.request.fields[0].description, /提交会更新/u);
  const result = await adapter.respond({ ...TARGET, requestId: row.id, response: { action: "submit", answers: { question_0: "fixture-secret-answer" } } });
  assert.equal(JSON.stringify(result).includes("fixture-secret-answer"), false);
});

test("expired, foreign, missing-identity, and stale requests cannot be answered", async () => {
  const { state, adapter } = fixture();
  state.tasks = [task()];
  for (const row of [question({ expiresAtMs: NOW }), question({ runId: "previous-run" }), question({ sessionKey: "agent:other:main" })]) {
    state.questions = [row];
    assert.equal((await adapter.inspect(TARGET)).status, "running");
    await assert.rejects(adapter.respond({ ...TARGET, requestId: row.id, response: { action: "submit", answers: { question_0: "A" } } }), { code: "OPENCLAW_REQUEST_STALE" });
  }
  state.questions = [question({ runId: undefined })];
  assert.equal((await adapter.inspect(TARGET)).errorCode, "OPENCLAW_INTERACTION_IDENTITY_UNAVAILABLE");
  assert.equal(state.calls.some((call) => call.method === "question.resolve"), false);
});

test("approvals expose one-time or deny choices without granting permanent authorization", async () => {
  const { state, adapter } = fixture();
  state.tasks = [task()];
  state.approvals = [approval()];
  const view = await adapter.inspect(TARGET);
  assert.equal(view.status, "waiting_approval");
  assert.deepEqual(view.attention.request.approvalChoices, ["once", "deny", "cancel"]);
  assert.equal(view.attention.command, "pwd");
  assert.equal(validInspirationAttention(view.attention, TARGET.runId), true);
  await assert.rejects(adapter.respond({ ...TARGET, requestId: "approval-1", response: { choice: "session" } }), { code: "INTERACTION_RESPONSE_INVALID" });
  assert.equal((await adapter.respond({ ...TARGET, requestId: "approval-1", response: { choice: "once" } })).status, "running");
  assert.deepEqual(state.calls.find((call) => call.method === "exec.approval.resolve").params, { id: "approval-1", decision: "allow-once" });
});

test("nullable approval Agent metadata retains the exact session and run ownership requirement", async () => {
  const { state, adapter } = fixture();
  state.tasks = [task()];
  const row = approval();
  row.request.agentId = null;
  state.approvals = [row];
  assert.equal((await adapter.inspect(TARGET)).status, "waiting_approval");
  row.request.runId = "foreign-run";
  await assert.rejects(adapter.respond({ ...TARGET, requestId: row.id, response: { choice: "once" } }), { code: "OPENCLAW_REQUEST_STALE" });
  assert.equal(state.calls.some((call) => call.method === "exec.approval.resolve"), false);
});

test("approval choice availability and details are checked before responding", async () => {
  const { state, adapter } = fixture();
  state.tasks = [task()];
  const row = approval();
  row.request.allowedDecisions = ["allow-always", "deny"];
  state.approvals = [row];
  assert.deepEqual((await adapter.inspect(TARGET)).attention.request.approvalChoices, ["deny", "cancel"]);
  await assert.rejects(adapter.respond({ ...TARGET, requestId: row.id, response: { choice: "once" } }), { code: "INTERACTION_RESPONSE_INVALID" });
  state.overrides["exec.approval.get"] = () => ({ id: row.id, agentId: "other", allowedDecisions: ["allow-once", "deny"] });
  assert.equal((await adapter.inspect(TARGET)).errorCode, "OPENCLAW_APPROVAL_IDENTITY_MISMATCH");
  assert.equal(state.calls.some((call) => call.method === "exec.approval.resolve"), false);
});

test("incomplete approval details cannot authorize an invisible command", async () => {
  const { state, adapter } = fixture();
  state.tasks = [task()];
  const row = approval();
  row.request.command = "";
  state.approvals = [row];
  const view = await adapter.inspect(TARGET);
  assert.deepEqual(view.attention.request.approvalChoices, ["deny", "cancel"]);
  assert.equal(view.attention.command, null);
  assert.equal(validInspirationAttention(view.attention, TARGET.runId), true);
});

test("successful response RPC without disappearance stays unconfirmed and transport uncertainty is not replayed", async () => {
  const { state, adapter } = fixture();
  state.tasks = [task()];
  state.questions = [question()];
  state.overrides["question.resolve"] = () => ({ status: "answered" });
  const input = { ...TARGET, requestId: "question-1", response: { action: "submit", answers: { question_0: "A" } } };
  assert.equal((await adapter.respond(input)).errorCode, "OPENCLAW_RESPONSE_UNCONFIRMED");
  state.overrides["question.resolve"] = () => { throw new Error("uncertain transport"); };
  assert.equal((await adapter.respond(input)).errorCode, "OPENCLAW_RESPONSE_UNCERTAIN");
  assert.equal(state.calls.filter((call) => call.method === "question.resolve").length, 2);
});

test("cancellation never reports a no-op as canceled and never uses session-wide abort", async () => {
  const { state, adapter } = fixture();
  state.tasks = [task()];
  const result = await adapter.cancel(TARGET);
  assert.equal(result.status, "running");
  assert.equal(result.errorCode, "OPENCLAW_STOP_UNCONFIRMED");
  assert.deepEqual(state.calls.filter((call) => call.method === "chat.abort").map((call) => call.params), [{ sessionKey: SESSION, runId: TARGET.runId }]);
});

test("cancellation requires terminal ledger plus observed inactivity and preserves completion races", async () => {
  for (const [active, terminal, expected] of [[true, "cancelled", "unknown"], [false, "cancelled", "canceled"], [false, "completed", "completed"]]) {
    const { state, adapter } = fixture();
    state.tasks = [task()];
    state.active = active;
    state.overrides["chat.abort"] = () => ({ ok: true, aborted: true, runIds: [TARGET.runId] });
    state.overrides["tasks.cancel"] = () => {
      state.tasks[0].status = terminal;
      return { found: true, cancelled: terminal === "cancelled" };
    };
    assert.equal((await adapter.cancel(TARGET)).status, expected);
  }
});

test("missing task can only be canceled by exact abort confirmation and a verified inactive session", async () => {
  for (const [runIds, active, expected] of [[[TARGET.runId], false, "canceled"], [["other-run"], false, "unknown"], [[TARGET.runId], true, "unknown"], [[], false, "unknown"]]) {
    const { state, adapter } = fixture();
    state.active = active;
    state.overrides["chat.abort"] = () => ({ ok: true, aborted: runIds.length > 0, runIds });
    assert.equal((await adapter.cancel(TARGET)).status, expected);
  }
});

test("an already completed task never triggers cancellation writes", async () => {
  const { state, adapter } = fixture();
  state.tasks = [task({ status: "completed", result: "finished" })];
  assert.equal((await adapter.cancel(TARGET)).status, "completed");
  assert.equal(state.calls.some((call) => ["chat.abort", "tasks.cancel"].includes(call.method)), false);
});
