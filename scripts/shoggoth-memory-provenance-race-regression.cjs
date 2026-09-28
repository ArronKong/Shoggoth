"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { McpProductToolController } = require("../app/agent-service/mcp-product-tool-controller");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { bindConversationSource } = require("../app/agent-service/conversation-source");
const { MemoryProvenanceStore } = require("../app/agent-service/memory-provenance-store");
const { MemoryProvenanceService } = require("../app/agent-service/memory-provenance-service");

const noop = () => null;
const profileId = "profile-1";
const run = { id: "run-1", profileId, source: "chat", sourceId: "session-1",
  workspace: "/tmp", status: "running" };
const args = { source: run.source, sourceId: run.sourceId, id: "memory-1" };
let evidenceRevision = "verified";
let unrelatedWrites = 0;
let reads = 0;
let phase = "revocation";
let resolveReplay;
const replay = new Promise((resolve) => { resolveReplay = resolve; });
let controller;
const memory = {
  engine: { recallPolicy: { getRevision: () => 0 }, now: () => 100 },
  store: { getRevision: () => 1 },
  provenance: { getEvidenceRevision: () => evidenceRevision },
  bind: noop, search: noop, get: noop, write: noop,
  explain() {
    reads += 1;
    if (phase === "revocation" && reads === 1) queueMicrotask(() => {
      // The provenance journal disappears after a quote was read, before the
      // first result leaves the tool controller. A concurrent same-call replay
      // must not join the stale in-flight Promise.
      evidenceRevision = "unavailable";
      resolveReplay(controller.handle("memory_explain", args,
        { profileId, callId: "55555555-5555-4555-8555-555555555555" }));
    });
    if (phase === "unrelated") queueMicrotask(() => { unrelatedWrites += 1; });
    return { item: { id: args.id, status: "active", content: "记忆仍可读取",
      validFrom: 0, validUntil: null }, evidence: evidenceRevision === "verified"
      ? { status: "verified_quote", quote: "已核实原话" }
      : { status: "unavailable", reason: "provenance_store_unavailable" } };
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
    getVisibilityRevision: () => 0 },
  permissionEngine: { authorize: noop }, notificationSender: noop,
  isSensitiveValue: () => false, artifactRoot: "/tmp",
});

(async () => {
  const first = controller.handle("memory_explain", args,
    { profileId, callId: "55555555-5555-4555-8555-555555555555" });
  const [original, repeated] = await Promise.allSettled([first, replay]);
  assert.equal(original.status, "rejected", "旁表变化后首个 explain 不能返回旧引文");
  assert.equal(repeated.status, "fulfilled", "同 callId 重试应重新核对来源");
  assert.deepEqual(repeated.value.evidence,
    { status: "unavailable", reason: "provenance_store_unavailable" });
  assert.equal(reads, 2, "来源变化后不得复用旧 explain Promise");

  phase = "unrelated";
  evidenceRevision = "verified";
  const valid = await controller.handle("memory_explain", args,
    { profileId, callId: "66666666-6666-4666-8666-666666666666" });
  assert.equal(valid.evidence.status, "verified_quote",
    "其他记忆的来源写入不应拒绝当前有效引文");
  assert.equal(unrelatedWrites, 1);

  // Exercise the same callId boundary with a real TranscriptStore cache and
  // provenance sidecar. The journal disappears just after the first quote is
  // read, so both the first response and a concurrent replay must revalidate.
  const f = contextFixture();
  const realStore = new MemoryProvenanceStore({ paths: f.paths });
  realStore.open();
  try {
    const realRun = { ...f.run, status: "running" };
    const session = { id: f.transcriptSessionId, sessionKey: realRun.sourceId,
      profileId, workspace: realRun.workspace, status: "ready" };
    const sessions = { listSessions: () => [session], getSession: () => session,
      getCronSessionOrigin: () => null };
    f.append({ id: "real-source", kind: "user", content: { text: "请记住我喜欢蓝色。" } });
    const binding = bindConversationSource({ args: { sourceQuote: "喜欢蓝色" }, run: realRun,
      transcriptStore: f.transcripts, chatSessionStore: sessions,
      getRunSessionKey: () => realRun.sourceId, requireQuote: true });
    const item = f.memoryEngine.propose({ profileId, id: "real-memory", scope: "user",
      type: "semantic", classification: "explicit", content: "用户喜欢蓝色",
      sourceRefs: binding.sourceRefs });
    const realProvenance = new MemoryProvenanceService({ store: realStore,
      memoryStore: f.memoryStore, transcriptStore: f.transcripts,
      chatSessionStore: sessions, recallPolicy: f.memoryEngine.recallPolicy,
      getRun: () => realRun, getRunSessionKey: () => realRun.sourceId });
    realProvenance.recordConversationSave({ profileId, item, operationId: "real-save",
      source: binding.source });
    const log = path.join(f.transcripts._sessionDir(profileId, f.transcriptSessionId), "events.jsonl");
    let realReads = 0;
    let resolveRealReplay;
    const realReplay = new Promise((resolve) => { resolveRealReplay = resolve; });
    let realController;
    const realMemory = {
      engine: f.memoryEngine, store: f.memoryStore, provenance: realProvenance,
      bind: noop, search: noop, get: noop, write: noop,
      explain(_profileId, id) {
        realReads += 1;
        const value = realProvenance.explain({ profileId, id, viewer: "agent",
          workspace: realRun.workspace });
        if (realReads === 1) queueMicrotask(() => {
          fs.unlinkSync(log);
          resolveRealReplay(realController.handle("memory_explain", {
            source: realRun.source, sourceId: realRun.sourceId, id: item.id,
          }, { profileId, callId: "77777777-7777-4777-8777-777777777777" }));
        });
        return { item: value.item, evidence: value.evidence };
      },
    };
    realController = new McpProductToolController({
      productStore, domainController: { handle: noop }, kanbanStore,
      kanbanRunService: { requestCompletionFromAgent: noop }, cronStore: { getJob: noop },
      workDispatcher: { getRun: (id) => id === realRun.id ? realRun : null },
      getRuntimeContext: () => ({ profileId, source: realRun.source,
        sourceId: realRun.sourceId, runId: realRun.id }),
      conversationMemoryService: realMemory,
      conversationRecallService: { assertCaller: noop, search: noop, get: noop,
        getVisibilityRevision: () => 0 },
      permissionEngine: { authorize: noop }, notificationSender: noop,
      isSensitiveValue: () => false, artifactRoot: "/tmp",
    });
    const realArgs = { source: realRun.source, sourceId: realRun.sourceId, id: item.id };
    const firstReal = realController.handle("memory_explain", realArgs,
      { profileId, callId: "77777777-7777-4777-8777-777777777777" });
    const [firstResult, replayResult] = await Promise.allSettled([firstReal, realReplay]);
    assert.equal(firstResult.status, "rejected", "journal 丢失后首个已核引文不能返回");
    assert.equal(replayResult.status, "fulfilled", "同 callId 复读应重新核对原始 journal");
    assert.deepEqual(replayResult.value.evidence,
      { status: "unavailable", reason: "source_read_failed", origin: "conversation",
        memoryRevision: f.memoryStore.getContentRevision(profileId, item.id) });
    assert.equal(realReads, 2);
  } finally { realStore.close(); f.cleanup(); }
  console.log("PASS memory_explain provenance race and unrelated append");
})().catch((cause) => { console.error(cause); process.exitCode = 1; });
