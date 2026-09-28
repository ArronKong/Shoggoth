"use strict";

const assert = require("node:assert/strict");
const { McpProductToolController } = require("../app/agent-service/mcp-product-tool-controller");

const noop = () => null;
const profileId = "profile-1";
const run = { id: "run-1", profileId, source: "chat", sourceId: "session-1",
  workspace: "/tmp", status: "running" };
const args = { source: run.source, sourceId: run.sourceId, id: "memory-1" };
const authority = { profileId, callId: "55555555-5555-4555-8555-555555555555" };
let transcriptRevision = 0;
let reads = 0;
let resolveReplay;
const replay = new Promise((resolve) => { resolveReplay = resolve; });
let controller;
const memory = {
  engine: { recallPolicy: { getRevision: () => 0 }, now: () => 100, isReviewCommitted: () => true },
  store: { getRevision: () => 1 },
  bind: noop, search: noop, get: noop, write: noop,
  explain() {
    reads += 1;
    if (reads === 1) queueMicrotask(() => {
      // The source event is excluded after explain observed its quote.
      transcriptRevision += 1;
      resolveReplay(controller.handle("memory_explain", args, authority));
    });
    return { item: { id: args.id, status: "active", content: "记忆仍可读取",
      validFrom: 0, validUntil: null }, evidence: transcriptRevision === 0
      ? { status: "verified_quote", quote: "已撤回原话" }
      : { status: "unavailable", reason: "source_unavailable" } };
  },
};
const productStore = {
  getAgentProfile: () => ({ id: profileId, enabled: true }),
  addRunNote: noop, lookupMcpToolCall: noop,
  beginMcpToolCall: noop, completeMcpToolCall: noop,
};
const kanbanStore = Object.fromEntries([
  "getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId",
  "addComment", "addArtifact", "listArtifacts",
].map((name) => [name, noop]));
controller = new McpProductToolController({
  productStore, domainController: { handle: noop }, kanbanStore,
  kanbanRunService: { requestCompletionFromAgent: noop }, cronStore: { getJob: noop },
  workDispatcher: { getRun: (id) => id === run.id ? run : null },
  getRuntimeContext: () => ({ profileId, source: run.source, sourceId: run.sourceId, runId: run.id }),
  conversationMemoryService: memory,
  conversationRecallService: { assertCaller: noop, search: noop, get: noop,
    getVisibilityRevision: () => transcriptRevision },
  permissionEngine: { authorize: noop }, notificationSender: noop,
  isSensitiveValue: () => false, artifactRoot: "/tmp",
});

(async () => {
  const first = controller.handle("memory_explain", args, authority);
  const [original, repeated] = await Promise.allSettled([first, replay]);
  assert.equal(original.status, "rejected", "源事件撤回后首个 explain 不能返回旧 quote");
  assert.equal(repeated.status, "fulfilled", "同 callId 重试应重新核对来源");
  assert.deepEqual(repeated.value.evidence, { status: "unavailable", reason: "source_unavailable" });
  assert.equal(reads, 2, "来源变化后不得复用旧 explain Promise");
  console.log("PASS memory_explain in-flight quote is revoked before output and retry");
})().catch((cause) => { console.error(cause); process.exitCode = 1; });
