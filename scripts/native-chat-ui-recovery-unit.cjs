#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { actionFixture } = require("./native-chat-ui-action-unit.cjs");
const c = require("../app/agent-service/chat-ui-contract");
test("Service death after freezing the operation and before Coordinator creates a Run recovers only the frozen input", async () => {
  const f = await actionFixture(); try {
    const service = f.service, send = service.workRunCoordinator.send.bind(service.workRunCoordinator); let cut = true;
    service.workRunCoordinator.send = async input => { if (cut) throw Object.assign(Error("lost transport"), { code: "EIO" }); return send(input); };
    const params = f.spec(), receipt = await f.send(params); assert.equal(receipt.status, "unknown"); assert.equal(receipt.runId, null);
    const session = service.chatSessionStore.getSession(f.owner.sessionKey), owner = { ...f.owner, transcriptSessionId: session.id };
    const frozen = service.chatUiStore.getOperation(owner, { actionRequestId: params.actionRequestId });
    assert.equal(service.workRunCoordinator.inbox.get(frozen.operationId), null);
    cut = false; await f.close(); await f.open();
    const result = await f.ipc("chat.ui.operation.get", { ...f.owner, actionRequestId: params.actionRequestId });
    // Unknown before any Inbox evidence is refused on recovery: Product cannot
    // prove the external boundary was never crossed, so it never creates a Run.
    assert.equal(result.status, "unknown"); assert.equal(result.runId, null);
    assert.equal(f.service.productStore.listWorkRuns().filter(run => run.idempotencyKey === `shoggoth:chat-send:${frozen.operationId}`).length, 0);
  } finally { await f.remove(); }
});
test("a durable Inbox accepted before a missing UI receipt recovers the same Run and snapshot", async () => {
  let armed = false;
  const f = await actionFixture({ chatUiFault: (at, detail) => { if (armed && at === "beforeJournal" && detail.type === "operation.receipt") throw Object.assign(Error("ENOSPC"), { code: "ENOSPC" }); } });
  try {
    const params = f.spec(); armed = true; const receipt = await f.send(params); assert.equal(receipt.status, "queued"); assert.ok(receipt.runId);
    const session = f.service.chatSessionStore.getSession(f.owner.sessionKey), owner = { ...f.owner, transcriptSessionId: session.id };
    const stored = f.service.chatUiStore.getOperation(owner, { actionRequestId: params.actionRequestId }); assert.equal(stored.status, "prepared");
    const envelopeHash = c.hash(stored.sendEnvelope), count = f.service.productStore.listWorkRuns().length;
    armed = false; await f.close(); await f.open();
    const recovered = await f.ipc("chat.ui.operation.get", { ...f.owner, actionRequestId: params.actionRequestId });
    assert.equal(recovered.runId, receipt.runId); assert.equal(f.service.productStore.listWorkRuns().length, count);
    assert.equal(c.hash(f.service.chatUiStore.getOperation(owner, { actionRequestId: params.actionRequestId }).sendEnvelope), envelopeHash);
  } finally { await f.remove(); }
});
test("expired operation and missing Inbox evidence can be queried but never rerun with a new command", async () => {
  let now = Date.now(); const f = await actionFixture({ now: () => now }); try {
    const params = f.spec(), receipt = await f.send(params), session = f.service.chatSessionStore.getSession(f.owner.sessionKey);
    const owner = { ...f.owner, transcriptSessionId: session.id }, op = f.service.chatUiStore.getOperation(owner, { actionRequestId: params.actionRequestId });
    now += c.LIMITS.retentionMs + 1;
    assert.throws(()=>f.service.chatUiController.assertOperationCurrent(op.sendEnvelope), { code: "UI_OPERATION_EXPIRED" });
    const before = f.service.productStore.listWorkRuns().length;
    const queried = await f.ipc("chat.ui.operation.get", { ...f.owner, actionRequestId: params.actionRequestId }); assert.equal(queried.runId, receipt.runId);
    await f.service.chatUiController.deliver(owner, op); assert.equal(f.service.productStore.listWorkRuns().length, before);
    assert.equal((await f.ipc("chat.ui.operation.get", { ...f.owner, actionRequestId: params.actionRequestId })).errorCode, "UI_OPERATION_EXPIRED");
    const missing = `ui-operation-${crypto.randomUUID()}`;
    assert.throws(()=>f.service.chatUiController.assertOperationCurrent({ operationId: missing, sessionKey: owner.sessionKey, prompt: "retired retry" }), { code: "UI_OPERATION_EXPIRED" });
  } finally { await f.remove(); }
});
