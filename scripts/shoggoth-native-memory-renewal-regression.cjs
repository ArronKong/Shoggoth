"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");

function disableProductCompaction(f) {
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: false } });
  assert.equal(f.service.nativeRuntimeConfig.read().flags.runtimeContextLifecycleV1, false);
}

test("chat forget renews a checkpoint-free native thread once with compaction disabled", async () => {
  const f = await openHandoffFixture();
  try {
    disableProductCompaction(f);
    const session = f.createSession();
    const first = await f.send(session.sessionKey, "native-forget-first", "请记住蓝鲸代号");
    assert.equal(first.status, "running", first.errorCode);
    await f.complete(first);
    assert.equal(f.service.conversationCheckpointStore.get(session.profileId, session.id), null);
    const source = f.service.transcriptStore.listEvents(session.profileId, session.id)
      .find(event => event.kind === "user" && event.runId === first.id);
    const item = f.service.memoryEngine.propose({ profileId: session.profileId, scope: "user",
      type: "semantic", content: "我的代号是蓝鲸", sourceRefs: [source.id, first.id],
      classification: "explicit" });
    f.service.memoryEngine.delete({ profileId: session.profileId, id: item.id,
      reason: "forgotten", operationId: "native-forget-action" });
    const second = await f.send(session.sessionKey, "native-forget-second", "继续处理当前任务");
    assert.equal(second.status, "running", second.errorCode);
    assert.notEqual(second.runtimeSessionRef.sessionId, first.runtimeSessionRef.sessionId);
    const contract = f.transport.acquisitions.at(-1).options.executionContract;
    assert.equal(contract.contextFresh, true);
    assert.doesNotMatch(contract.dynamicContext, /蓝鲸/u);
    await f.complete(second);
    const third = await f.send(session.sessionKey, "native-forget-third", "再继续");
    assert.equal(third.status, "running", third.errorCode);
    assert.equal(third.runtimeSessionRef.sessionId, second.runtimeSessionRef.sessionId,
      "a current version anchor must not rotate the native thread every turn");
    await f.complete(third);
  } finally { await f.close(); }
});

test("Inspiration Run also renews its checkpoint-free native thread after a Profile forget", async () => {
  const f = await openHandoffFixture();
  try {
    disableProductCompaction(f);
    const ipc = (method, params) => requestService(f.paths, { id: crypto.randomUUID(),
      token: readClientToken(f.paths), version: PROTOCOL_VERSION, method, params }, { timeoutMs: 10_000 });
    const { idea } = await ipc("inspiration.create", { operationId: crypto.randomUUID(),
      body: "研究蓝鲸代号的产品想法" });
    const start = async () => {
      const current = f.service.inspirationStore.get(idea.id);
      const { idea: updated } = await ipc("inspiration.start", { id: current.id,
        expectedRevision: current.revision, operationId: crypto.randomUUID(),
        instruction: "继续分析这个想法", agentId: f.profile.agentId,
        backendId: f.profile.backendId, workspace: f.workspace });
      const runId = updated.latestExecution.runId;
      await waitUntil(() => {
        const run = f.service.workRunCoordinator.getRun(runId);
        return run?.status === "running" || ["failed", "canceled", "interrupted"].includes(run?.status);
      }, 5000, "Inspiration native memory admission");
      await f.service.workRunCoordinator.waitForIdle(runId);
      return { run: f.service.workRunCoordinator.getRun(runId), sessionKey: updated.latestExecution.sessionKey };
    };
    const first = await start();
    assert.equal(first.run.status, "running", first.run.errorCode);
    await f.complete(first.run);
    const session = f.service.chatSessionStore.getSession(first.sessionKey);
    assert.equal(f.service.conversationCheckpointStore.get(session.profileId, session.id), null);
    const item = f.service.memoryEngine.propose({ profileId: session.profileId, scope: "user",
      type: "semantic", content: "蓝鲸是我的项目代号", sourceRefs: ["user-edit:manual"],
      classification: "explicit" });
    f.service.memoryEngine.delete({ profileId: session.profileId, id: item.id,
      reason: "user_deleted", operationId: "native-inspiration-forget" });
    const second = await start();
    assert.equal(second.run.status, "running", second.run.errorCode);
    assert.equal(second.sessionKey, first.sessionKey);
    assert.notEqual(second.run.runtimeSessionRef.sessionId, first.run.runtimeSessionRef.sessionId);
    await f.complete(second.run);
  } finally { await f.close(); }
});

test("a forget after admission but before turnStart rejects the frozen memory context", async () => {
  const f = await openHandoffFixture();
  try {
    disableProductCompaction(f);
    const session = f.createSession();
    const item = f.service.memoryEngine.propose({ profileId: session.profileId, scope: "user",
      type: "semantic", content: "用户的代号是蓝鲸", sourceRefs: ["user-edit:manual"],
      classification: "explicit" });
    const manager = f.service.workRunCoordinator.runtimeManager;
    const acquire = manager.acquire.bind(manager);
    let withdrawn = false;
    manager.acquire = async (...args) => {
      const handle = await acquire(...args);
      if (!withdrawn) {
        withdrawn = true;
        f.service.memoryEngine.delete({ profileId: session.profileId, id: item.id,
          reason: "user_deleted", operationId: "native-before-send-forget" });
      }
      return handle;
    };
    const run = await f.send(session.sessionKey, "native-before-send", "继续");
    assert.equal(withdrawn, true);
    assert.notEqual(run.status, "running");
    assert.equal(f.transport.hosts.get("codex")?.turnStartCalls ?? 0, 0,
      "the frozen context must not reach a model turn after withdrawal");
  } finally { await f.close(); }
});

test("an unwritable native version anchor fails before remote acceptance", async () => {
  const f = await openHandoffFixture();
  try {
    disableProductCompaction(f);
    const session = f.createSession();
    f.service.conversationCheckpointStore.recordNativeSession = () => {
      throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
    };
    const first = await f.send(session.sessionKey, "native-anchor-full-1", "第一轮");
    assert.notEqual(first.status, "running");
    const second = await f.send(session.sessionKey, "native-anchor-full-2", "第二轮");
    assert.notEqual(second.status, "running");
    assert.equal(f.transport.hosts.get("codex")?.turnStartCalls ?? 0, 0);
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).retiredRuntimeSessions.length, 0,
      "a persistently failed anchor must not keep retiring accepted native sessions");
  } finally { await f.close(); }
});

test("a queued compaction never sends a prompt after its source was withdrawn", async () => {
  const f = await openHandoffFixture();
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeContextLifecycleV1: true } });
    const session = f.createSession();
    const first = await f.send(session.sessionKey, "compaction-before-forget", "请记住蓝鲸代号");
    assert.equal(first.status, "running", first.errorCode);
    await f.complete(first);
    const source = f.service.transcriptStore.listEvents(session.profileId, session.id)
      .find(event => event.kind === "user" && event.runId === first.id);
    const item = f.service.memoryEngine.propose({ profileId: session.profileId, scope: "user",
      type: "semantic", content: "我的代号是蓝鲸", sourceRefs: [source.id, first.id],
      classification: "explicit" });
    const manager = f.service.workRunCoordinator.runtimeManager;
    manager.canGenerateModelOnly = () => true;
    const acquire = manager.acquire.bind(manager);
    let modelCalls = 0;
    manager.acquire = async (binding, options) => {
      const handle = await acquire(binding, options);
      if (options.executionContract?.source !== "compaction") return handle;
      f.service.memoryEngine.delete({ profileId: session.profileId, id: item.id,
        reason: "forgotten", operationId: "compaction-inflight-forget" });
      const facade = Object.create(handle);
      Object.defineProperties(facade, {
        capabilities: { value: { ...handle.capabilities, "model.generate.toolFree": true } },
        generateModelOnly: { value: async () => { modelCalls++; throw new Error("stale prompt reached model"); } },
      });
      return facade;
    };
    const response = await f.service.workRunCoordinator.compactConversation({
      sessionKey: session.sessionKey, operationId: "compaction-race-request" });
    assert.ok(response.runId, "fixture needs a real compaction Run");
    await f.service.workRunCoordinator.waitForIdle(response.runId);
    const run = f.service.workRunCoordinator.getRun(response.runId);
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "CHECKPOINT_STALE");
    assert.equal(modelCalls, 0);
  } finally { await f.close(); }
});
