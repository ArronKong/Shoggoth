"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { execute } = require("./shoggoth-memory-live-acceptance.cjs");
const { assertInspirationChatOrigin, requiredTool } = require("./shoggoth-memory-live-worker.cjs");

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
