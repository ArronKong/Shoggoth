"use strict";

const assert = require("node:assert/strict");
const { McpProductToolController } = require("../app/agent-service/mcp-product-tool-controller");

const profileId = "profile-1";
const args = { source: "chat", sourceId: "session-1", id: "memory-1" };
const authority = { profileId, callId: "11111111-1111-4111-8111-111111111111" };
const run = { id: "run-1", profileId, source: "chat", sourceId: "session-1",
  workspace: "/tmp", status: "running" };
const noop = () => null;
const error = (code) => Object.assign(new Error(code), { code });
let policyRevision = 0;
let getCalls = 0;
let resolveReplay;
const replay = new Promise((resolve) => { resolveReplay = resolve; });
let controller;
const memory = {
  engine: { recallPolicy: { getRevision: () => policyRevision } },
  store: { getRevision: () => 0 },
  bind: noop, search: noop, explain: noop, write: noop,
  get() {
    getCalls += 1;
    if (policyRevision !== 0) throw error("MEMORY_NOT_FOUND");
    // Revocation lands after the first read produced its result, before the
    // controller's in-flight callId Promise has settled.
    queueMicrotask(() => {
      policyRevision = 1;
      resolveReplay(controller.handle("memory_get", args, authority));
    });
    return { item: { id: "memory-1", status: "active", content: "revoked-memory-marker" } };
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
  assert.equal(policyRevision, 1);
  assert.equal(original.status, "rejected", "撤回期间的原读取不能返回旧内容");
  assert.equal(repeated.status, "rejected", "同 callId 的撤回后重试不能复用旧内容");
  assert.ok(["MCP_TOOL_NOT_FOUND", "MCP_TOOL_STATE_CONFLICT"].includes(repeated.reason.code));
  assert.equal(getCalls, 2, "撤回后同 callId 必须重新读取当前事实源");
  console.log("PASS in-flight same-callId replay does not return a revoked memory");
})().catch((cause) => { console.error(cause); process.exitCode = 1; });
