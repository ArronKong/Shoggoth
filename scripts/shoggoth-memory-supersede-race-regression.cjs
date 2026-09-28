"use strict";

const assert = require("node:assert/strict");
const { McpProductToolController } = require("../app/agent-service/mcp-product-tool-controller");

const profileId = "profile-1";
const args = { source: "chat", sourceId: "session-1", id: "old-memory" };
const authority = { profileId, callId: "22222222-2222-4222-8222-222222222222" };
const run = { id: "run-1", profileId, source: "chat", sourceId: "session-1",
  workspace: "/tmp", status: "running" };
const noop = () => null;
const error = (code) => Object.assign(new Error(code), { code });
let itemStatus = "active";
let memoryRevision = 1;
let getCalls = 0;
let resolveReplay;
const replay = new Promise((resolve) => { resolveReplay = resolve; });
let controller;
const memory = {
  engine: { recallPolicy: { getRevision: () => 0 } },
  store: { getRevision: () => memoryRevision },
  bind: noop, search: noop, explain: noop, write: noop,
  get() {
    getCalls += 1;
    if (itemStatus !== "active") throw error("MEMORY_NOT_FOUND");
    queueMicrotask(() => {
      itemStatus = "superseded";
      memoryRevision += 1;
      resolveReplay(controller.handle("memory_get", args, authority));
    });
    return { item: { id: args.id, status: "active", content: "outdated-memory-marker" } };
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
  getRuntimeContext: () => ({ profileId, source: "chat", sourceId: "session-1", runId: run.id }),
  conversationMemoryService: memory,
  conversationRecallService: { assertCaller: noop, search: noop, get: noop },
  permissionEngine: { authorize: noop }, notificationSender: noop,
  isSensitiveValue: () => false, artifactRoot: "/tmp",
});

(async () => {
  const first = controller.handle("memory_get", args, authority);
  const [original, repeated] = await Promise.allSettled([first, replay]);
  assert.equal(memoryRevision, 2);
  assert.equal(original.status, "rejected", "替代发生后首个读取不能返回旧内容");
  assert.equal(repeated.status, "rejected", "同 callId 重试不能复用被替代的旧内容");
  assert.equal(getCalls, 2, "替代后必须重新读取当前事实源");
  console.log("PASS in-flight same-callId replay does not return a superseded memory");
})().catch((cause) => { console.error(cause); process.exitCode = 1; });
