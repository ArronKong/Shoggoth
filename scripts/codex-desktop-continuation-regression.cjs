"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture, turn } = require("./codex-desktop-session-service-fixture.cjs");
const { OWNER } = require("../app/agent-service/codex-automation-store");
const { validateChatServiceResult } = require("../app/agent-service/chat-service-protocol");
const { waitUntil } = require("./helpers/codex-automation-harness.cjs");

async function rejectedReceipt() {
  const f = await fixture();
  try {
    f.service.nativeRuntimeConfig.apply({ revision: 1, maxActive: 32, startupConcurrency: 8,
      flags: { runtimeAdmissionV1: true, runtimeContextLifecycleV1: true,
        runtimeMultiBinding: true, runtimeConversationHandoff: true } });
    const row = f.backend.getSessionRows().find(r => r.source === "codex-desktop");
    await f.backend._ensureCodexDesktopSession(row.key);
    const prior = f.service.workDispatcher.enqueue({ id: "native-compaction-fixture-failed", source: "compaction",
      sourceId: row.sessionId, idempotencyKey: "failed-compact", profileId: OWNER.id, workspace: f.workspace });
    f.service.workDispatcher.transition(prior.id, "failed", { errorCode: "RUNTIME_COMPACTION_ACCEPTANCE_UNKNOWN" });
    const operationId = crypto.randomUUID();
    const receipt = await f.ipc("chat.send", { sessionKey: row.sessionId,
      operationId, prompt: "explicit new attempt", createdAt: Date.now() });
    validateChatServiceResult("chat.send", receipt);
    assert.equal(receipt.disposition, "completed");
    assert.equal(receipt.run.status, "failed");
    assert.equal(receipt.run.errorCode, "RUNTIME_COMPACTION_ACCEPTANCE_UNKNOWN");
    assert.equal(f.host.turnStarts, 0, "a failed compaction must not replay input");
    console.log("PASS durable admission failure returns a valid terminal receipt and original error");
    // A confirmed pre-dispatch failure does not lock every future user input.
    // The old operation is never replayed; this is a distinct explicit send.
    const retryRow = f.backend.getSessionRows().find(r => r.source === "codex-desktop" && r.sessionId !== row.sessionId);
    await f.backend._ensureCodexDesktopSession(retryRow.key);
    const beforeDispatch = f.service.workDispatcher.enqueue({ id: "native-compaction-fixture-preflight", source: "compaction",
      sourceId: retryRow.sessionId, idempotencyKey: "preflight-compact", profileId: OWNER.id, workspace: f.workspace });
    f.service.workDispatcher.transition(beforeDispatch.id, "failed", { errorCode: "RUNTIME_START_SESSION_START_OR_RESUME_FAILED" });
    let failure;
    const sending = f.backend.sendMessage(retryRow.key, "explicit retry after preflight repair", "new-explicit-operation", { error: e => { failure = e; } });
    await waitUntil(() => f.host.turnStarts === 1 || failure, "new explicit input after preflight failure", 10000);
    assert.equal(failure, undefined);
    const retry = f.service.productStore.listWorkRuns({ source: "chat", sourceId: retryRow.sessionId }).at(-1);
    f.host.finish(retry.runtimeTurnRef.turnId, "new explicit input completed"); await sending;
    assert.equal(f.service.workDispatcher.getRun(beforeDispatch.id).status, "failed");
    assert.equal(f.service.workDispatcher.getRun(receipt.run.id).status, "failed");
    assert.equal(f.host.turnStarts, 1, "only the new user input is sent");
    console.log("PASS confirmed pre-dispatch failure permits a new explicit send without replaying old input");
  } finally { await f.close(); }
}

async function largeContinuation() {
  const f = await fixture();
  try {
    // Isolate the transport boundary from the independent model window gate.
    f.service.workRunCoordinator.getRuntimeModelContextWindow = () => 4_000_000;
    f.native.turns = Array.from({ length: 60 }, (_, i) => turn(`old question ${i}`, "旧工具和回答".repeat(14000)));
    assert.ok(Buffer.byteLength(JSON.stringify(f.native)) > 8 * 1024 * 1024);
    const row = f.backend.getSessionRows().find(r => r.label === "桌面对话：保留原上下文");
    const first = await f.backend.getHistory(row.key);
    assert.ok(first.hasMore, "the initial screen must use a bounded window");
    const starts = f.host.threadStarts;
    let failure;
    const sending = f.backend.sendMessage(row.key, "continue original thread", "large-continue", { error: e => { failure = e; } });
    await waitUntil(() => f.host.turnStarts > 0 || failure, "large native thread continuation", 10000);
    assert.equal(failure, undefined, String(failure));
    assert.equal(f.host.threadStarts, starts, "never replace the Desktop thread");
    assert.equal(f.host.turnParams.threadId, f.native.id);
    const run = f.service.productStore.listWorkRuns({ source: "chat", sourceId: row.sessionId }).at(-1);
    f.host.finish(run.runtimeTurnRef.turnId, "bounded terminal reconciliation");
    await sending;
    assert.equal(f.service.workDispatcher.getRun(run.id).status, "completed");
    assert.equal(failure, undefined);
    // Even with unrelated history omitted, a second native user marker for
    // the same operation must prevent a new model turn.
    const duplicateOperation = crypto.randomUUID();
    f.native.turns[0].items[0].clientId = duplicateOperation;
    f.native.turns[1].items[0].clientId = duplicateOperation;
    const conflicted = await f.ipc("chat.send", { sessionKey: row.sessionId, operationId: duplicateOperation,
      prompt: "do not duplicate native operation", createdAt: Date.now() });
    await assert.rejects(f.service.workRunCoordinator.waitForIdle(conflicted.run.id),
      error => error.code === "CODEX_CLIENT_MESSAGE_ID_CONFLICT");
    assert.equal(f.host.turnStarts, 1, "complete operation scan catches duplicate markers across old turns");
    console.log("PASS >8 MiB Desktop history continues and reconciles in the same thread");
  } finally { await f.close(); }
}

(async () => { await rejectedReceipt(); await largeContinuation(); })().catch(error => {
  console.error(error); process.exitCode = 1;
});
