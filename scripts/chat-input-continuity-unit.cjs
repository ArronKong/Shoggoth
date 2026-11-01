"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { transcriptHistoryItem } = require("../app/agent-service/chat-service-controller");
const { transcriptEventId } = require("../app/agent-service/transcript-store");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = createRequire(path.resolve(__dirname, "../app/manage-ui/package.json"))("typescript");
const helper = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../app/manage-ui/src/lib/chatPromptHistory.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: helper, exports: helper.exports });
const { applyPromptHistory, promptHistoryAnchor } = helper.exports;

function fixture({ historyFailure = false, denied = false, secret = false } = {}) {
  const backend = new ShoggothBackend({}), calls = [];
  const payload = { requestId: "request-fixture", message: "确认商品规格", requestedSchema: {
    type: "object", properties: { answer: { type: "string", ...(secret ? { format: "password" } : {}) } }, required: ["answer"],
  } };
  const request = normalizeInteractiveRequestV1({ runId: "run-fixture", eventType: "prompt", payload, expiresAt: null });
  const record = { request, requestId: request.requestId, runId: request.runId, sessionKey: "session-fixture", kind: "input" };
  const question = { id: transcriptEventId("chat-request", request.requestId), seq: 2, runId: request.runId,
    kind: "input", occurredAt: 100, content: { transcriptType: "prompt", ...payload } };
  const answer = { id: transcriptEventId("interactive-response", request.requestId), seq: 3, runId: request.runId,
    kind: "user", occurredAt: 110, content: { transcriptType: "interaction.response", requestId: request.requestId,
      text: `补充：answer: ${secret ? "[隐藏]" : "确认"}` } };
  const items = [question, answer].map(event => transcriptHistoryItem(event));
  backend._sessionTarget = () => ({ sessionKey: record.sessionKey });
  backend._assertRunBinding = () => {};
  backend._promptByRequest.set(record.requestId, record);
  backend._call = async (method, params) => {
    calls.push({ method, params });
    if (method === "run.input.respond") {
      if (denied) throw Error("response rejected");
      return { requestId: record.requestId, state: "responded", run: { id: record.runId, status: "running" } };
    }
    assert.equal(method, "chat.history");
    if (historyFailure) throw Error("temporary history failure");
    return { messages: items, hasMore: false, nextCursor: null };
  };
  return { backend, request, items, calls };
}

test("accepted input returns the exact canonical question/answer before the turn ends", async () => {
  const f = fixture();
  const result = await f.backend.respondChatPrompt("key", { requestId: f.request.requestId, action: "submit", answers: { answer: "确认" } });
  assert.deepEqual(result.messages, f.items.map(item => item.payload.message));
  assert.equal(f.calls[0].method, "run.input.respond", "the write is acknowledged before reading its display receipt");
});
test("input echo uses persisted secret-safe text, never raw submitted answers", async () => {
  const f = fixture({ secret: true });
  const result = await f.backend.respondChatPrompt("key", { requestId: f.request.requestId, action: "submit", answers: { answer: "private-answer-fixture" } });
  assert.equal(result.messages[1].content[0].text, "补充：answer: [隐藏]");
  assert.equal(JSON.stringify(result).includes("private-answer-fixture"), false);
});
test("a history read failure cannot make an accepted response look rejected or retry the write", async () => {
  const f = fixture({ historyFailure: true });
  const result = await f.backend.respondChatPrompt("key", { requestId: f.request.requestId, action: "submit", answers: { answer: "确认" } });
  assert.equal(result.state, "responded");
  assert.equal(f.calls.filter(call => call.method === "run.input.respond").length, 1);
});
test("a rejected input has no conversation receipt and stays answerable", async () => {
  const f = fixture({ denied: true });
  await assert.rejects(f.backend.respondChatPrompt("key", { requestId: f.request.requestId, action: "submit", answers: { answer: "确认" } }), /response rejected/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.backend._promptByRequest.has(f.request.requestId), true);
});

test("a question and answer split across history pages retain their canonical order", async () => {
  const f = fixture(), call = f.backend._call;
  f.backend._call = async (method, params) => method !== "chat.history" ? call(method, params)
    : params.cursor === null ? { messages: [f.items[1]], hasMore: true, nextCursor: "older" }
      : { messages: [f.items[0]], hasMore: false, nextCursor: null };
  const result = await f.backend.respondChatPrompt("key", { requestId: f.request.requestId, action: "submit", answers: { answer: "确认" } });
  assert.deepEqual(result.messages, f.items.map(item => item.payload.message));
});

test("an early resumed bubble remains after the accepted input even if the prompt already expired", () => {
  const before = { id: "progress", role: "assistant", parts: [{ type: "text", segmentId: "progress" }] };
  const prompt = { role: "assistant", pending: true, parts: [{ type: "prompt", promptEntry: { requestId: "input" } }] };
  const after = { id: "resumed", role: "assistant", parts: [{ type: "text", segmentId: "resumed" }] };
  const receipt = [{ id: "question", role: "assistant", parts: [{ type: "text" }] }, { id: "answer", role: "user", parts: [{ type: "text" }] }];
  const anchors = promptHistoryAnchor([before, prompt], "input");
  const previous = [before, after];
  const result = applyPromptHistory(previous, "input", receipt, anchors);
  assert.deepEqual(Array.from(result, item => item.id), ["progress", "question", "answer", "resumed"]);
  assert.equal(applyPromptHistory(result, "input", receipt, anchors), result, "a repeated receipt does not duplicate messages");
  const cleared = [];
  assert.equal(applyPromptHistory(cleared, "input", receipt, anchors), cleared, "a stale receipt cannot restore a cleared conversation");
  const unrelated = [{ ...before, id: "other-run" }];
  assert.equal(applyPromptHistory(unrelated, "input", receipt, anchors), unrelated, "a stale receipt cannot enter a replacement run");
});
