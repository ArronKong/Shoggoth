"use strict";

// Isolated Service replies and loopback WebSockets only. No runtime, account,
// transcript, model, or installed backend is read or started by this fixture.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { once, EventEmitter } = require("node:events");
const { WebSocket, WebSocketServer } = require("ws");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { InspirationService } = require("../app/agent-service/inspiration-service");
const { AgentBackend } = require("../app/core/agent-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { validateInspirationServiceParams, validateInspirationServiceResult } =
  require("../app/agent-service/inspiration-service-protocol");

function sessionStore(methods) {
  return Object.assign(new EventEmitter(), {
    growthSettings: () => ({ enabled: false, executors: [], revision: 1 }),
    growthJobs: () => [],
  }, methods);
}

function fixture(backendId = "openclaw") {
  const target = { backendId, agentId: backendId === "hermes" ? "hermes-fixture" : "main",
    sessionKey: `agent:${backendId === "hermes" ? "hermes-fixture" : "main"}:inspiration-fixture`,
    inspirationId: randomUUID() };
  const execution = { id: randomUUID(), ideaId: target.inspirationId, runId: randomUUID(),
    profileId: null, agentId: target.agentId, backendId, workspace: "/tmp/inspiration-fixture",
    sessionKey: target.sessionKey, ideaRevision: 1, createdAt: 1, retryOf: null,
    status: "running", resultSummary: null, errorCode: null, finishedAt: null, attention: null };
  const view = (changes = {}) => { const latestExecution = { ...execution, ...changes }; return {
    id: target.inspirationId, title: "Fixture", body: "Fixture idea", revision: 1,
    favorite: false, archivedAt: null, acceptedAt: null, createdAt: 1, updatedAt: 1,
    status: latestExecution.status, latestExecution,
  }; };
  const owner = Object.create(ShoggothBackend.prototype);
  Object.assign(owner, { _state: "started", _generation: 1, randomUUID, pollIntervalMs: 0, maxPages: 10,
    maxPollErrors: 1, delay: () => Promise.resolve(), _readyNotifier: () => {} });
  owner._sessionTarget = () => assert.fail("External Session must never become a native Profile Session");
  return { target, execution, view, owner };
}

test("Typed external Session methods enforce exact identity and result shapes", () => {
  const { target, view } = fixture();
  const { inspirationId, ...input } = target;
  assert.deepEqual(validateInspirationServiceParams("inspiration.session.get", input), input);
  assert.deepEqual(validateInspirationServiceResult("inspiration.session.get", {
    origin: { inspirationId, inspirationTitle: "Fixture" },
  }).origin.inspirationId, inspirationId);
  assert.deepEqual(validateInspirationServiceResult("inspiration.session.get", { origin: null }), { origin: null });
  const send = { ...input, operationId: "send-fixture", prompt: "Continue" };
  assert.deepEqual(validateInspirationServiceParams("inspiration.session.send", send), send);
  assert.equal(validateInspirationServiceResult("inspiration.session.send", { idea: view() }).idea.id, inspirationId);
  for (const params of [{ ...input, backendId: "shoggoth" }, { ...input, sessionKey: "" }, { ...input, extra: true }]) {
    assert.throws(() => validateInspirationServiceParams("inspiration.session.get", params), { code: "INSPIRATION_INVALID" });
  }
  assert.throws(() => validateInspirationServiceParams("inspiration.session.send", { ...send, prompt: " " }),
    { code: "INSPIRATION_INVALID" });
  assert.throws(() => validateInspirationServiceResult("inspiration.session.get", {
    origin: { inspirationId, inspirationTitle: "Fixture", profileId: "fabricated" },
  }), { code: "INSPIRATION_RESPONSE_INVALID" });
});

for (const backendId of ["openclaw", "hermes"]) test(`${backendId}: Service owns send, snapshots, prompts and terminal`, async () => {
  const { target, execution, view, owner } = fixture(backendId);
  const request = { version: 1, requestId: "request-fixture", runId: execution.runId,
    kind: "runtime_approval", title: "Approve", message: "Run fixture command", fields: [],
    approvalChoices: ["once", "deny", "cancel"], expiresAt: null };
  const snapshots = [view({ status: "waiting_approval", attention: {
    request, active: true, occurredAt: 1, command: "fixture-command", cwd: execution.workspace, details: null,
  } }), view({ status: "completed", resultSummary: "Fixture finished", finishedAt: 2 })];
  const calls = [], events = [];
  let current = view();
  owner._call = async (method, params) => {
    validateInspirationServiceParams(method, params);
    calls.push({ method, params });
    if (method === "inspiration.get") current = snapshots.shift();
    // The real Service omits attention from get/start/send projections; only
    // inspiration.executions includes its canonical interaction payload.
    const result = method === "inspiration.session.get"
      ? { origin: { inspirationId: target.inspirationId, inspirationTitle: "Fixture" } }
      : method === "inspiration.executions" ? { executions: [current.latestExecution], total: 1, hasMore: false, nextCursor: null }
        : { idea: { ...current, latestExecution: { ...current.latestExecution, attention: null } } };
    return validateInspirationServiceResult(method, result);
  };
  const { inspirationId, ...input } = target;
  const route = await owner.getExternalInspirationSessionRoute(input);
  let accepted = 0;
  const hooks = Object.fromEntries(["status", "delta", "prompt", "promptExpire", "final", "error"]
    .map(name => [name, (...args) => events.push([name, ...args])]));
  await route.sendMessage(target.sessionKey, "Continue", "client-fixture", hooks, { onAccepted: () => accepted++ });
  assert.equal(accepted, 1);
  assert.equal(calls.filter(call => call.method === "inspiration.session.send").length, 1);
  assert.equal(calls[1].params.sessionKey, target.sessionKey);
  assert.equal(calls[1].params.prompt, "Continue");
  assert.match(calls[1].params.operationId, /^send-/);
  const prompts = events.filter(event => event[0] === "prompt").map(event => event[1]);
  assert.equal(prompts.length, 1);
  assert.deepEqual({ ...prompts[0], message: request.message }, request);
  assert.match(prompts[0].message, /命令：\nfixture-command/);
  assert.match(prompts[0].message, /工作目录：\n\/tmp\/inspiration-fixture/);
  assert.equal(calls.filter(call => call.method === "inspiration.executions").length, 1);
  assert.deepEqual(events.filter(event => event[0] === "promptExpire").map(event => event[1]), [{ requestId: request.requestId }]);
  assert.deepEqual(events.at(-1), ["final", "Fixture finished", false,
    { runId: execution.runId, notificationCategory: "inspiration" }]);
  const count = calls.length;
  await assert.rejects(route.sendMessage(target.sessionKey, "Attachment", "client-other", {}, { attachments: [{}] }), /附件/);
  assert.equal(calls.length, count);
});

test("Bound replies and cancellation revalidate exact execution and canonical choices", async () => {
  const { target, execution, view, owner } = fixture();
  const request = { version: 1, requestId: "request-fixture", runId: execution.runId,
    kind: "runtime_approval", title: "Approve", message: "Fixture", fields: [],
    approvalChoices: ["once", "deny", "cancel"], expiresAt: null };
  const idea = view({ status: "waiting_approval", attention: {
    request, active: true, occurredAt: 1, command: "fixture", cwd: execution.workspace, details: null,
  } });
  const calls = [];
  owner._call = async (method, params) => {
    calls.push({ method, params });
    return method === "inspiration.executions"
      ? { executions: [structuredClone(idea.latestExecution)], total: 1, hasMore: false, nextCursor: null }
      : { idea: { ...structuredClone(idea), latestExecution: { ...structuredClone(idea.latestExecution), attention: null } } };
  };
  await assert.rejects(owner._controlExternalInspirationSession(target, target.sessionKey,
    { requestId: "stale", choice: "once" }), { code: "INSPIRATION_REQUEST_EXPIRED" });
  await assert.rejects(owner._controlExternalInspirationSession(target, target.sessionKey,
    { requestId: request.requestId, choice: "session" }), { code: "INSPIRATION_INVALID" });
  assert.equal(calls.some(call => call.method === "inspiration.respond"), false);
  await owner._controlExternalInspirationSession(target, target.sessionKey, { requestId: request.requestId, choice: "once" });
  assert.deepEqual(calls.at(-1).params.response, { choice: "once" });
  assert.equal(calls.at(-1).params.runId, execution.runId);
  await owner._controlExternalInspirationSession(target, target.sessionKey, null);
  assert.equal(calls.at(-1).method, "inspiration.cancel");
  assert.equal(calls.at(-1).params.runId, execution.runId);
  idea.latestExecution.sessionKey = "agent:main:another";
  await assert.rejects(owner._controlExternalInspirationSession(target, target.sessionKey, null),
    { code: "INSPIRATION_BINDING_INVALID" });
});

test("Production Service get omits attention while execution detail restores the exact prompt", async () => {
  const { target, execution, view, owner } = fixture();
  const request = { version: 1, requestId: "request-fixture", runId: execution.runId,
    kind: "runtime_approval", title: "Approve", message: "Fixture", fields: [],
    approvalChoices: ["once", "deny", "cancel"], expiresAt: null };
  const { status, latestExecution, ...idea } = view();
  const storedExecution = { ...execution, preparationFailure: null, external: {
    status: "waiting_approval", resultSummary: null, errorCode: null, finishedAt: null,
    attention: { request, active: true, occurredAt: 1, command: "fixture", cwd: execution.workspace, details: null },
  } };
  const service = new InspirationService({ store: sessionStore({
    get: id => id === idea.id ? { ...idea, deletedAt: null } : null,
    executions: () => [storedExecution],
    latestExecution: () => storedExecution,
    pendingExecutions: () => [], projectNativeStatuses() {},
    executionsPage: () => ({ rows: [storedExecution], total: 1, hasMore: false }),
  }), now: () => 10 });
  service.open();
  owner._call = (method, params) => service.handle(method, params);
  try {
    assert.equal((await service.handle("inspiration.get", { id: idea.id })).idea.latestExecution.attention, null);
    const observed = await owner._loadExternalInspirationExecution(target, execution.runId);
    assert.deepEqual(observed.attention.request, request);
    assert.equal(observed.attention.active, true);
  } finally { service.close(); }
});

test("Observer abort never cancels external execution or reads another Session", async () => {
  const { target, view, owner } = fixture();
  const controller = new AbortController(), calls = [], events = [];
  owner.delay = async () => controller.abort();
  owner._call = async (method) => { calls.push(method); return { idea: view() }; };
  await owner.sendExternalInspirationMessage(target, "Continue", "client-fixture", {
    final: () => events.push("final"), error: () => events.push("error"),
  }, { signal: controller.signal });
  assert.deepEqual(calls, ["inspiration.session.send"]);
  assert.deepEqual(events, []);
  owner.delay = () => Promise.resolve();
  owner._call = async (method) => ({ idea: view(method === "inspiration.get" ? { runId: randomUUID() } : {}) });
  await assert.rejects(owner.sendExternalInspirationMessage(target, "Continue", "client-next"),
    { code: "INSPIRATION_BINDING_INVALID" });
});

test("Read-only Session watch observes a card-started request and never dispatches", async () => {
  const { target, execution, view, owner } = fixture();
  const controller = new AbortController(), calls = [], prompts = [];
  const request = { version: 1, requestId: "card-request", runId: execution.runId,
    kind: "user_input", title: "Question", message: "Choose the next step", fields: [{
      id: "answer", type: "text", label: "Answer", description: "", required: true, secret: false, options: [],
    }], approvalChoices: [], expiresAt: null };
  const waiting = view({ status: "waiting_input", attention: {
    request, active: true, occurredAt: 1, command: null, cwd: execution.workspace, details: null,
  } });
  owner._call = async (method, params) => {
    calls.push(method);
    assert.equal(params.id, target.inspirationId);
    if (method === "inspiration.get") return { idea: { ...waiting,
      latestExecution: { ...waiting.latestExecution, attention: null } } };
    if (method === "inspiration.executions") return { executions: [waiting.latestExecution] };
    assert.fail(`Watch must not dispatch ${method}`);
  };
  owner.delay = async () => controller.abort();
  await owner.watchExternalInspirationSession(target, { prompt: value => prompts.push(value) }, { signal: controller.signal });
  assert.deepEqual(calls, ["inspiration.get", "inspiration.executions"]);
  assert.deepEqual(prompts, [request]);
  waiting.status = waiting.latestExecution.status = "completed";
  const after = [];
  await owner.watchExternalInspirationSession(target, { final: () => after.push("final"), prompt: () => after.push("prompt") });
  assert.deepEqual(after, []);
});

test("Session approval shows complete command details or retains only allowed rejection choices", () => {
  const { execution, owner } = fixture();
  const request = { version: 1, requestId: "card-request", runId: execution.runId,
    kind: "runtime_approval", title: "Approve", message: "Run proposed operation", fields: [],
    approvalChoices: ["once", "deny", "cancel"], expiresAt: null };
  const attention = { request, active: true, occurredAt: 1, command: "node fixture-script.cjs",
    cwd: "/tmp/fixture", details: '{"permissions":{"network":true}}' };
  const shown = owner._externalInspirationPrompt(attention);
  assert.match(shown.message, /node fixture-script\.cjs/);
  assert.match(shown.message, /\/tmp\/fixture/);
  assert.match(shown.message, /"network":true/);
  assert.deepEqual(shown.approvalChoices, request.approvalChoices);
  const oversized = owner._externalInspirationPrompt({ ...attention, details: "完整详情".repeat(8000) });
  assert.deepEqual(oversized.approvalChoices, ["deny", "cancel"]);
  assert.match(oversized.message, /返回灵感卡片/);
  assert.equal(oversized.requestId, request.requestId);
  assert.equal(oversized.runId, request.runId);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.message)) <= 16 * 1024);
  assert.deepEqual(request.approvalChoices, ["once", "deny", "cancel"]);
  assert.equal(request.message, "Run proposed operation");
});

test("Proxy intercepts exact bindings before owns without changing ordinary passthrough", async (t) => {
  const received = [], routed = [], lookups = [];
  const server = createServer(), wss = new WebSocketServer({ server });
  wss.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(data); received.push(frame);
    socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
      payload: frame.method === "connect" ? { type: "hello-ok", protocol: 1 } : { upstream: true } }));
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const registry = new BackendRegistry();
  class HermesFixture extends AgentBackend {
    get id() { return "hermes"; }
    claimsAgentId(id) { return id === "hermes-fixture"; }
    ownsAgentId(id) { return this.claimsAgentId(id); }
    getAgents() { return [{ id: "hermes-fixture", name: "Fixture" }]; }
    async sendMessage() { assert.fail("Bound Hermes send must not call raw backend"); }
  }
  registry.register(new HermesFixture());
  const keys = ["agent:main:inspiration-fixture", "agent:hermes-fixture:inspiration-fixture"];
  let lookupFails = false;
  registry.setInspirationOwner({ getExternalInspirationSessionRoute: async input => {
    lookups.push(input);
    if (lookupFails) throw Object.assign(new Error("fixture lookup unavailable"), { code: "INSPIRATION_UNAVAILABLE" });
    if (!keys.includes(input.sessionKey)) return null;
    return { sendMessage: async (key, prompt, runId, hooks, opts) => {
      routed.push({ method: "send", key, prompt, runId }); opts.onAccepted?.();
      hooks.status({ kind: "running", text: "running" }); hooks.final("Fixture finished", false, { runId: "service-fixture" });
    }, abortChat: async key => { routed.push({ method: "abort", key }); return {}; },
    respondChatPrompt: async (key, data) => { routed.push({ method: "respond", key, data }); return {}; } };
  } });
  const gate = createWorkAdmissionGate();
  const proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => `ws://127.0.0.1:${server.address().port}`,
    registry, workAdmissionGate: gate });
  const client = new WebSocket(proxy.url), frames = [], waiting = [];
  client.on("message", data => { const frame = JSON.parse(data); frames.push(frame);
    for (const waiter of [...waiting]) if (waiter.match(frame)) waiter.resolve(frame); });
  t.after(async () => { client.terminate(); await proxy.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  await once(client, "open");
  const waitFor = match => {
    const found = frames.find(match); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("fixture response timeout")), 2500);
      const waiter = { match, resolve: frame => { clearTimeout(timeout); waiting.splice(waiting.indexOf(waiter), 1); resolve(frame); } };
      waiting.push(waiter); });
  };
  const send = async (method, params) => { const id = randomUUID(); client.send(JSON.stringify({ type: "req", id, method, params }));
    return waitFor(frame => frame.type === "res" && frame.id === id); };
  const denied = await send("chat.send", { sessionKey: keys[0], message: "Unauthorized", idempotencyKey: "unauthorized" });
  assert.equal(denied.ok, false); assert.equal(routed.length, 0);
  assert.equal(lookups.length, 0);
  assert.equal(received.some(frame => frame.method === "chat.send"), false);
  assert.equal((await send("connect", {})).ok, true);
  for (const key of keys) {
    const runId = randomUUID();
    assert.equal((await send("chat.send", { sessionKey: key, message: "Continue", idempotencyKey: runId })).ok, true);
    const final = await waitFor(frame => frame.event === "chat" && frame.payload?.runId === runId && frame.payload.state === "final");
    assert.equal(final.payload.sessionKey, key);
    assert.equal((await send("chat.respond", { sessionKey: key, requestId: "request-fixture", choice: "once" })).ok, true);
    assert.equal((await send("chat.abort", { sessionKey: key })).ok, true);
  }
  assert.equal(registry.route("main"), null);
  assert.equal(routed.filter(call => call.method === "send").length, 2);
  assert.equal(received.some(frame => ["chat.send", "chat.respond", "chat.abort"].includes(frame.method)), false);
  assert.equal((await send("chat.send", { sessionKey: "agent:main:ordinary", message: "Ordinary" })).payload.upstream, true);
  assert.equal(lookups.at(-1).backendId, "openclaw");
  assert.equal((await send("chat.send", { sessionKey: keys[0], message: "Attachment", attachments: [{}] })).ok, false);
  const lease = gate.beginDrain("openclaw", "fixture");
  assert.equal((await send("chat.send", { sessionKey: keys[0], message: "Draining" })).error.code, "GATEWAY_DRAINING");
  lease.release();
  lookupFails = true;
  assert.equal((await send("chat.send", { sessionKey: keys[0], message: "Lookup failed" })).error.code, "INSPIRATION_UNAVAILABLE");
  assert.equal(received.filter(frame => frame.method === "chat.send").length, 1);
  assert.equal(gate.snapshot("openclaw").activeAdmissions, 0);
});

test("Card-started Sessions load authentic backend history then restore prompts on open and refresh", { timeout: 5000 }, async (t) => {
  const fixtures = [fixture("openclaw"), fixture("hermes")];
  const ideas = new Map(), executions = new Map();
  for (const f of fixtures) {
    const { status, latestExecution, ...idea } = f.view();
    ideas.set(idea.id, { ...idea, deletedAt: null });
    const request = { version: 1, requestId: `card-${f.target.backendId}`, runId: f.execution.runId,
      kind: "runtime_approval", title: "Approve card execution", message: "Fixture command", fields: [],
      approvalChoices: ["once", "deny", "cancel"], expiresAt: null };
    executions.set(idea.id, { ...f.execution, title: idea.title, body: idea.body, instruction: "本轮继续完善", preparationFailure: null,
      external: { status: "waiting_approval", resultSummary: null, errorCode: null, finishedAt: null,
        attention: { request, active: true, occurredAt: 1, command: "fixture", cwd: f.execution.workspace, details: null } } });
  }
  const service = new InspirationService({ store: sessionStore({
    get: id => ideas.get(id) || null,
    executions: id => id ? [executions.get(id)] : [...executions.values()],
    latestExecution: id => executions.get(id),
    executionForSession: (key, backendId, agentId) => [...executions.values()].find(value => value.sessionKey === key && value.backendId === backendId && value.agentId === agentId) || null,
    sessionExecutionsPage: ({ sessionKey, backendId, agentId }) => {
      const rows = [...executions.values()].filter(value => value.sessionKey === sessionKey && value.backendId === backendId && value.agentId === agentId);
      return { rows, total: rows.length, hasMore: false };
    },
    pendingExecutions: () => [], projectNativeStatuses() {},
    executionsPage: ({ id }) => ({ rows: [executions.get(id)], total: 1, hasMore: false }),
  }), now: () => 10 });
  service.open();
  const owner = fixtures[0].owner, serviceCalls = [], watchRecords = [];
  owner.delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  owner._call = (method, params) => { serviceCalls.push(method); return service.handle(method, params); };
  const watch = owner.watchExternalInspirationSession.bind(owner);
  owner.watchExternalInspirationSession = async (target, hooks, opts) => {
    const record = { key: target.sessionKey, signal: opts.signal, settled: false };
    let settled;
    record.finished = new Promise(resolve => { settled = resolve; });
    watchRecords.push(record);
    try { return await watch(target, hooks, opts); } finally { record.settled = true; settled(); }
  };
  const registry = new BackendRegistry(), historyCalls = [], forwarded = [];
  const history = backendId => ({ messages: [{ id: `user-${backendId}`, role: "user", timestamp: 1,
    content: service.buildPrompt([...executions.values()].find(value => value.backendId === backendId)) },
    { role: "user", content: "普通消息不应被改写" },
    { role: "assistant", content: [{ type: "text", text: `${backendId} actual history` }],
    timestamp: 1 }], fixtureBackend: backendId });
  class HermesHistoryFixture extends AgentBackend {
    get id() { return "hermes"; }
    ownsAgentId(id) { return id === "hermes-fixture"; }
    claimsAgentId(id) { return this.ownsAgentId(id); }
    getAgents() { return [{ id: "hermes-fixture", name: "Fixture" }]; }
    async getHistory(key) { historyCalls.push({ backendId: "hermes", key }); return history("hermes"); }
  }
  class OpenClawHistoryFixture extends AgentBackend {
    get id() { return "openclaw"; }
    ownsAgentId() { return false; }
    async request(method, params) {
      assert.equal(method, "chat.history");
      historyCalls.push({ backendId: "openclaw", params }); return history("openclaw");
    }
  }
  registry.register(new HermesHistoryFixture()); registry.register(new OpenClawHistoryFixture());
  registry.setInspirationOwner(owner);
  const server = createServer(), wss = new WebSocketServer({ server });
  wss.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(data); forwarded.push(frame);
    socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
      payload: frame.method === "connect" ? { type: "hello-ok", protocol: 1 } : { ordinaryHistory: true } }));
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const gate = createWorkAdmissionGate(), drain = gate.beginDrain("openclaw", "fixture-read-only");
  const proxy = await startProxyGateway({ port: 0, registry, workAdmissionGate: gate,
    getUpstreamUrl: () => `ws://127.0.0.1:${server.address().port}` });
  const client = new WebSocket(proxy.url), frames = [], waiters = [];
  client.on("message", data => { const frame = JSON.parse(data); frames.push(frame);
    for (const waiter of [...waiters]) if (waiter.match(frame)) waiter.resolve(frame); });
  t.after(async () => { client.terminate(); await proxy.close(); drain.release(); service.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  await once(client, "open");
  const waitFor = (match, start = 0) => {
    const found = frames.slice(start).find(match); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("history watch fixture timeout")), 3000);
      const waiter = { match, resolve: frame => { clearTimeout(timeout); waiters.splice(waiters.indexOf(waiter), 1); resolve(frame); } };
      waiters.push(waiter); });
  };
  const send = async (method, params) => { const id = randomUUID(); client.send(JSON.stringify({ type: "req", id, method, params }));
    return waitFor(frame => frame.type === "res" && frame.id === id); };
  assert.equal((await send("chat.history", { sessionKey: fixtures[0].target.sessionKey })).ok, false);
  assert.deepEqual(serviceCalls, []); assert.deepEqual(historyCalls, []);
  assert.equal((await send("connect", {})).ok, true);
  for (const f of fixtures) {
    for (let refresh = 0; refresh < 2; refresh++) {
      const start = frames.length;
      const params = { sessionKey: f.target.sessionKey, limit: 23 };
      const response = await send("chat.history", params);
      const expected = history(f.target.backendId);
      expected.messages[0].content = [{ type: "text", text: "Fixture\n\nFixture idea\n\n本轮补充：\n本轮继续完善" }];
      assert.deepEqual(response.payload, expected);
      assert.match(history(f.target.backendId).messages[0].content, /^The user has captured/);
      const prompt = await waitFor(frame => frame.event === "chat" && frame.payload?.sessionKey === f.target.sessionKey
        && frame.payload.state === "prompt", start);
      assert.equal(prompt.payload.prompt.runId, f.execution.runId);
      assert.equal(prompt.payload.prompt.requestId, `card-${f.target.backendId}`);
      assert.ok(frames.indexOf(response) < frames.indexOf(prompt));
      if (f.target.backendId === "openclaw") assert.deepEqual(historyCalls.at(-1).params, params);
    }
  }
  assert.equal(registry.route("main"), null);
  assert.equal(forwarded.some(frame => frame.method === "chat.history"), false);
  assert.equal((await send("chat.history", { sessionKey: "agent:main:ordinary" })).payload.ordinaryHistory, true);
  assert.equal(gate.snapshot("openclaw").activeAdmissions, 0);
  assert.equal(serviceCalls.some(method => ["inspiration.session.send", "inspiration.start", "inspiration.cancel"].includes(method)), false);
  client.close(); await once(client, "close");
  await proxy.close();
  await Promise.all(watchRecords.map(record => record.finished));
  assert.ok(watchRecords.length >= 2);
  assert.equal(watchRecords.every(record => record.signal.aborted && record.settled), true);
  assert.equal([...executions.values()].every(execution => execution.external.status === "waiting_approval"), true);
  assert.equal(serviceCalls.some(method => ["inspiration.session.send", "inspiration.start", "inspiration.cancel"].includes(method)), false);
});
