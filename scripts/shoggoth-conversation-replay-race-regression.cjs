"use strict";

const assert = require("node:assert/strict");
const { McpProductToolController } = require("../app/agent-service/mcp-product-tool-controller");

const noop = () => null;
const profileId = "profile-1";
const run = { id: "run-1", profileId, source: "chat", sourceId: "current-session",
  workspace: "/tmp", status: "running" };
const source = { source: "chat", sourceId: run.sourceId };
const error = (code) => Object.assign(new Error(code), { code });

async function check(name, details, revokedLabel) {
  const args = { ...source, ...details };
  const authority = { profileId, callId: name === "conversation_search"
    ? "33333333-3333-4333-8333-333333333333"
    : "44444444-4444-4444-8444-444444444444" };
  let visible = true;
  let reads = 0;
  let resolveReplay;
  const replay = new Promise((resolve) => { resolveReplay = resolve; });
  let controller;
  const read = () => {
    reads += 1;
    if (!visible) throw error("CONVERSATION_EVENT_NOT_FOUND");
    queueMicrotask(() => {
      // Session deletion or transcript context exclusion occurs after the
      // service made a visible result, before the controller returns it.
      visible = false;
      resolveReplay(controller.handle(name, args, authority));
    });
    return name === "conversation_search"
      ? { results: [{ sessionId: "past-session", eventId: "event-1",
        snippet: "revoked-transcript-marker" }], count: 1, query: args.query,
        status: "ready", indexRevision: 0 }
      : { sessionId: "past-session", eventId: "event-1", events: [
        { eventId: "event-1", text: "revoked-transcript-marker" }] };
  };
  const productStore = {
    getAgentProfile: () => ({ id: profileId, enabled: true }),
    addRunNote: noop, lookupMcpToolCall: noop,
    beginMcpToolCall: noop, completeMcpToolCall: noop,
  };
  const kanbanStore = Object.fromEntries([
    "getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId",
    "addComment", "addArtifact", "listArtifacts",
  ].map((method) => [method, noop]));
  controller = new McpProductToolController({
    productStore, domainController: { handle: noop }, kanbanStore,
    kanbanRunService: { requestCompletionFromAgent: noop }, cronStore: { getJob: noop },
    workDispatcher: { getRun: (id) => id === run.id ? run : null },
    getRuntimeContext: () => ({ profileId, ...source, runId: run.id }),
    conversationRecallService: { policy: { getRevision: () => 0 },
      assertCaller: noop, search: read, get: read },
    permissionEngine: { authorize: noop }, notificationSender: noop,
    isSensitiveValue: () => false, artifactRoot: "/tmp",
  });
  const first = controller.handle(name, args, authority);
  const [original, repeated] = await Promise.allSettled([first, replay]);
  return { revokedLabel, original, repeated, reads };
}

(async () => {
  const outcomes = [
    await check("conversation_search", { query: "marker" }, "Session 删除"),
    await check("conversation_get", { sessionId: "past-session", eventId: "event-1" },
      "事件 contextExcluded"),
  ];
  assert.deepEqual(outcomes.map(({ revokedLabel, original, repeated, reads }) => ({
    revokedLabel, original: original.status, repeated: repeated.status, reads,
  })), [
    { revokedLabel: "Session 删除", original: "rejected", repeated: "rejected", reads: 2 },
    { revokedLabel: "事件 contextExcluded", original: "rejected", repeated: "rejected", reads: 2 },
  ]);
  console.log("PASS in-flight conversation replays honor session and event revocation");
})().catch((cause) => { console.error(cause); process.exitCode = 1; });
