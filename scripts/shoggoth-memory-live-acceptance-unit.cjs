"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { execute } = require("./shoggoth-memory-live-acceptance.cjs");
const { assertInspirationChatOrigin, requiredTool } = require("./shoggoth-memory-live-worker.cjs");
const { hasColorAnswer, terminalFailureDetail, recallResponseShape, createRuntimeProgress, observeOpenCodeHost, observeModelGateway } = require("./shoggoth-memory-repair-live-worker.cjs");

test("OpenCode live stop observations preserve native results and omit all arbitrary content", async () => {
  const secret = "private-fixture-value", observations = [], calls = [];
  const response = { data: [{ info: { id: secret, sessionID: secret, role: "assistant",
    error: { name: "MessageAbortedError", data: { message: `aborted ${secret}`, authorization: secret } } },
    parts: [{ id: secret, type: "tool", tool: "glob", state: { status: "error", input: secret,
      error: `permission denied ${secret}`, output: secret } }] }] };
  const failure = Object.assign(new Error(secret), { code: "RUNTIME_CONNECTION_LOST" });
  let listener, clock = 100;
  const client = { async request(...args) {
    calls.push(args);
    if (args[1] === "/session/status") throw failure;
    if (args[1] === "/permission") return { data: [{ id: secret, sessionID: secret, permission: secret, patterns: [secret] }] };
    return response;
  } };
  observeOpenCodeHost({ runtime: "opencode", host: { client }, subscribe(value) { listener = value; } }, observations, () => clock++);
  const body = { reply: "reject", private: secret }, options = { signal: new AbortController().signal };
  assert.equal(await client.request("POST", `/permission/${secret}/reply`, body, options), response);
  assert.equal(calls[0][2], body); assert.equal(calls[0][3], options);
  assert.equal(await client.request("GET", `/session/${secret}/message?limit=100`), response);
  await client.request("GET", `/session/${secret}/message?limit=100`);
  await client.request("GET", "/permission");
  await client.request("POST", `/session/${secret}/abort`, { private: secret });
  await assert.rejects(client.request("GET", "/session/status"), error => error === failure);
  listener({ known: true, type: "complete", sessionId: secret, turnId: secret,
    method: "opencode/session.message", status: "interrupted", failure: { message: secret } });
  assert.equal(calls.length, 6);
  assert.equal(observations.find(row => row.stage === "permission-reply").decision, "reject");
  assert.equal(observations.find(row => row.stage === "native-error").name, "MessageAbortedError");
  assert.equal(observations.find(row => row.stage === "native-tool-error").errorClass, "permission");
  assert.equal(observations.find(row => row.stage === "native-error").count, 2);
  assert.equal(observations.find(row => row.stage === "request-error").code, "RUNTIME_CONNECTION_LOST");
  assert.equal(observations.find(row => row.stage === "host-complete").method, "opencode/session.message");
  assert.doesNotMatch(JSON.stringify(observations), /private-fixture-value|authorization|"input"|"output"|"patterns"|"message":/u);
  for (let i = 0; i < 500; i++) listener({ known: true, type: "complete", sessionId: `${secret}-${i}`, method: secret, status: secret });
  assert.equal(observations.length, 256);
});

test("live model gateway observations retain stages without request, response or error contents", async () => {
  const { EventEmitter } = require("node:events"), secret = "private-fixture-value", observations = [];
  const body = new EventEmitter(), res = new EventEmitter(); res.statusCode = 200; res.headersSent = true;
  const error = Object.assign(new Error(secret), { code: "UND_ERR_SOCKET", cause: { code: secret } });
  const gateway = { async dispatch() { return { body, statusCode: 200, headers: { authorization: secret } }; },
    async handle(req) { await this.dispatch(req.url, req.headers, req.body); body.emit("error", error); throw error; } };
  observeModelGateway(gateway, observations);
  await assert.rejects(gateway.handle({ url: secret, headers: { authorization: secret }, body: secret }, res), error);
  assert.deepEqual(observations.map(row => row.stage), ["local-request", "upstream-request", "upstream-headers", "upstream-error", "local-error"]);
  assert.deepEqual(observations.at(-1).codes, ["UND_ERR_SOCKET", "other"]);
  assert.doesNotMatch(JSON.stringify(observations), /private-fixture-value|authorization|"headers":|"body":/u);
});

test("live receipt observation preserves stream bytes and opaque proof recording", async () => {
  const { ModelSecretGateway } = require("../app/agent-service/model-secret-gateway");
  const { Readable } = require("node:stream"), { pipeline } = require("node:stream/promises");
  const observations = [], recorded = [];
  const gateway = new ModelSecretGateway({ projection: {}, provenance: { record(_scope, value) { recorded.push(value); } } });
  observeModelGateway(gateway, observations);
  const text = 'data: {"item":{"encrypted_content":"synthetic-opaque-private"}}\n\n';
  let received = "";
  await pipeline(Readable.from([text.slice(0, 9), text.slice(9)]), gateway.receiptStream({}, true),
    async source => { for await (const chunk of source) received += chunk; });
  assert.equal(received, text); assert.deepEqual(recorded, [{ encrypted_content: "synthetic-opaque-private" }]);
  assert.doesNotMatch(JSON.stringify(observations), /synthetic-opaque-private|encrypted_content/u);
  assert.equal(observations[0].format, "sse");
});

test("live timeout evidence distinguishes native receipt, model activity and pending commands without retaining bodies", () => {
  const secret = "private-fixture-value";
  let listener, clock = 100;
  const host = { process: { pending: new Map([[1, { command: "model/generate", params: secret }], [2, { command: secret }]]) },
    activeTurns: new Map([[1, { sessionId: secret, turnId: secret, accepted: true, settled: false, prompt: secret }]]) };
  const handle = { runtime: "deepseek-harness", host, subscribe(value) { assert.equal(listener, undefined); listener = value; } };
  const progress = createRuntimeProgress(() => clock++);
  progress.observe(handle); progress.observe(handle);
  for (let i = 0; i < 1000; i++) listener({ known: true, type: "reasoning_delta", sessionId: secret, turnId: secret, delta: secret });
  listener({ known: true, type: "tool_start", sessionId: secret, turnId: secret, tool: { input: secret } });
  listener({ known: true, type: secret, status: secret });
  const [value] = progress.snapshot();
  assert.deepEqual(value.pendingCommands, ["model/generate", "other"]);
  assert.equal(value.activeTurns[0].accepted, true); assert.equal(value.activeTurns[0].settled, false);
  assert.equal(value.events.length, 2); assert.equal(value.events[0].count, 1000);
  assert.ok(value.events[0].lastAt > value.events[0].firstAt);
  assert.doesNotMatch(JSON.stringify(value), /private-fixture-value|"delta"|"input"|"prompt"|"params"/u);
  listener({ known: true, type: "reasoning_delta", sessionId: secret, turnId: secret, delta: secret });
  assert.equal(value.events[0].count, 1000);
  assert.equal(progress.snapshot()[0].events[0].count, 1001);
  host.process.closed = true; host.processFailure = new Error(secret); host.activeTurns.clear();
  assert.equal(progress.snapshot()[0].processClosed, true); assert.equal(progress.snapshot()[0].processFailed, true);
});

test("live recall shape evidence cannot retain arbitrary model text or keys", () => {
  const privateText = "fixture-private-response";
  const response = { summary: privateText, [privateText]: privateText, tool: privateText,
    arguments: { path: privateText, query: privateText, sourceId: privateText, [privateText]: privateText } };
  const shape = recallResponseShape({ text: JSON.stringify(response) });
  assert.equal(shape.validJson, true); assert.equal(shape.unknownKeyCount, 1); assert.equal(shape.tool, "other");
  assert.doesNotMatch(JSON.stringify(shape), /fixture-private-response/u);
  assert.deepEqual(shape.argumentFields, ["query", "path", "sourceId"]);
  assert.equal(shape.unknownArgumentCount, 1); assert.equal(shape.queryString, true); assert.equal(shape.queryWithinLimit, true);
  assert.equal(recallResponseShape({ text: '{"arguments":[]}' }).argumentsObject, false);
  assert.equal(recallResponseShape({ text: '{"arguments":{"query":5}}' }).queryString, false);
  assert.equal(recallResponseShape({ text: JSON.stringify({ arguments: { query: "x".repeat(4097) } }) }).queryWithinLimit, false);
  assert.equal(recallResponseShape({ text: '{"summary":"NONE"}' }).summaryNone, true);
  assert.equal(recallResponseShape({ text: ' NONE\n' }).bareNone, true);
  assert.equal(recallResponseShape({ text: 'NONE\n{}' }).bareNone, false);
  assert.equal(recallResponseShape({ text: "```json\n{}\n```" }).codeFenced, true);
  assert.equal(recallResponseShape({ text: privateText }).validJson, false);
  assert.equal(recallResponseShape({ text: "x".repeat(65537) }).overBudget, true);
  assert.equal(recallResponseShape({}).textPresent, false);
});

test("live evidence retains only the matching Product terminal's sanitized upstream failure", () => {
  const terminal = { runId: "run-a", kind: "error", content: { transcriptType: "terminal",
    failure: { message: "Too many requests. fixture-private-credential", httpStatus: 429,
      upstreamCode: "rate_limit", headers: { authorization: "hidden-header" }, stack: "hidden-stack" } } };
  const unrelated = { ...terminal, runId: "run-b", content: { ...terminal.content, failure: { message: "other run" } } };
  const assistant = { ...terminal, kind: "assistant", content: { ...terminal.content, failure: { message: "forged assistant error" } } };
  const detail = terminalFailureDetail([terminal, unrelated, assistant], "run-a", ["fixture-private-credential"]);
  assert.equal(detail.httpStatus, 429); assert.equal(detail.upstreamCode, "rate_limit");
  assert.match(detail.message, /Too many requests/u);
  assert.doesNotMatch(JSON.stringify(detail), /fixture-private-credential|hidden-header|hidden-stack|other run|forged/u);
  assert.equal(terminalFailureDetail([unrelated, assistant], "run-a"), null);
  assert.equal(terminalFailureDetail([{ ...terminal, content: { ...terminal.content, transcriptType: "other" } }], "run-a"), null);
});

test("color-only acceptance accepts the observed equivalent short answer without matching a different answer", () => {
  for (const answer of ["蓝", "蓝。", "**蓝**", "蓝色", "蓝色。 "]) assert.equal(hasColorAnswer(answer, "蓝"), true);
  for (const answer of ["绿", "绿色", "不知道", "不是蓝", "蓝或绿", "可能是蓝"]) assert.equal(hasColorAnswer(answer, "蓝"), false);
  assert.equal(hasColorAnswer("绿", "绿"), true); assert.equal(hasColorAnswer("蓝", "绿"), false);
});

function fixture() {
  const profileId = "profile-a", workspace = "/tmp/memory-live-workspace";
  const ideaId = "idea-a", sessionKey = "session-key-a", prompt = "请保存这条偏好";
  const run = { id: "run-a", source: "inspiration", sourceId: ideaId, profileId, workspace };
  const session = { id: "session-a", sessionKey, profileId, workspace, status: "ready" };
  const execution = { runId: run.id, ideaId, profileId, workspace, sessionKey, inputSource: "chat" };
  const event = { id: "event-a", runId: run.id, kind: "user", contextExcluded: false,
    content: { text: prompt } };
  const service = {
    chatSessionStore: { getSession: () => session },
    inspirationStore: { executionForRun: () => execution },
    transcriptStore: { listEvents: () => [event] },
  };
  return { service, input: { profileId, workspace, ideaId, sessionKey, run, prompt },
    session, execution, event };
}

test("plan mode lists both real-provider chains without touching credentials", async () => {
  const result = await execute({ mode: "plan" });
  assert.equal(result.credentialFilesRead, false);
  assert.equal(result.providerCalls, 0);
  assert.ok(result.intendedSteps.includes("inspiration-chat-new-session-after-forget-search"));
});

test("Inspiration acceptance requires the product's direct chat-origin execution and user event", () => {
  const value = fixture();
  assert.equal(assertInspirationChatOrigin(value.service, value.input).userEvent.id, value.event.id);
  value.execution.inputSource = undefined;
  assert.throws(() => assertInspirationChatOrigin(value.service, value.input),
    { code: "MEMORY_LIVE_INSPIRATION_ORIGIN_INVALID" });
  value.execution.inputSource = "chat";
  value.execution.ideaId = "another-idea";
  assert.throws(() => assertInspirationChatOrigin(value.service, value.input),
    { code: "MEMORY_LIVE_INSPIRATION_ORIGIN_INVALID" });
  value.execution.ideaId = value.input.ideaId;
  value.event.content.text = "another message";
  assert.throws(() => assertInspirationChatOrigin(value.service, value.input),
    { code: "MEMORY_LIVE_INSPIRATION_USER_EVENT_MISSING" });
});

test("real-provider acceptance needs an observed matching MCP tool call", () => {
  requiredTool(["memory_save"], "memory_save");
  requiredTool(["shoggoth__conversation_search"], "conversation_search");
  requiredTool(["shoggoth/memory_forget"], "memory_forget");
  assert.throws(() => requiredTool(["memory_search"], "memory_save"),
    { code: "MEMORY_LIVE_REQUIRED_TOOL_MISSING", requiredTool: "memory_save" });
});
