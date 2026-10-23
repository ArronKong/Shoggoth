#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const { test } = require("node:test");
const { fixture, declaration } = require("./native-chat-ui-service-unit.cjs");
const { createFederationHostServer } = require("../app/federation-host-server");
const { createDesktopChatUiAuthority } = require("../app/desktop-chat-ui-authority");
const c = require("../app/agent-service/chat-ui-contract");
async function actionFixture(options = {}) {
  const f = await fixture(options), authority = createDesktopChatUiAuthority();
  const host = createFederationHostServer({ paths: f.paths,
    registry: { getStatus: async () => [], getBackend: () => null }, verifyChatUiClick: params => authority.consume(params) });
  await host.start();
  const published = await f.call("render_ui", declaration()), part = published.part;
  const opened = await f.ipc("chat.ui.open", { ...f.reference(part), mountId: "action-mount" });
  const spec = (extra = {}) => ({ ...f.owner, leaseId: opened.leaseId, actionRequestId: crypto.randomUUID(), actionId: "continue",
    stateRevision: 0, snapshot: { selected: "B" }, ...extra });
  const send = params => f.ipc("chat.ui.action", { ...params, hostProof: authority.issue(params, () => true) });
  return { ...f, part, opened, spec, send, authority, get service() { return f.service; },
    async remove() { authority.close(); await host.stop(); await f.remove(); } };
}
if (require.main === module) {
test("an authenticated Service token without a private desktop click cannot submit", async () => {
  const f = await actionFixture(); try {
    await assert.rejects(f.ipc("chat.ui.action", { ...f.spec(), hostProof: crypto.randomUUID() }), { code: "UI_HOST_REQUIRED" });
    assert.equal(f.service.chatUiStore.operationsForRecovery().length, 0);
  } finally { await f.remove(); }
});
test("real Service freezes state once and enters the existing busy-session Inbox", async () => {
  const f = await actionFixture(); try {
    const params = f.spec(), result = await f.send(params);
    assert.equal(result.status, "queued", JSON.stringify(result)); assert.equal(result.reason, "CHAT_SESSION_BUSY");
    const owner = { ...f.owner, transcriptSessionId: f.service.chatSessionStore.getSession(f.owner.sessionKey).id };
    const op = f.service.chatUiStore.getOperation(owner, { actionRequestId: params.actionRequestId });
    assert.equal(op.snapshot.selected, "B"); assert.equal(op.stateRevision, 1);
    const command = f.service.workRunCoordinator.inbox.get(result.operationId);
    assert.equal(command.runId, result.runId); assert.equal(command.prompt, op.sendEnvelope.prompt);
    await f.ipc("chat.ui.state.save", { ...f.owner, leaseId: f.opened.leaseId, baseStateRevision: 1, patch: { selected: "C" } });
    assert.equal(f.service.chatUiStore.getOperation(owner, { actionRequestId: params.actionRequestId }).snapshot.selected, "B");
    assert.deepEqual(await f.send(params), result);
    await assert.rejects(f.send({ ...params, snapshot: { selected: "A" } }), { code: "UI_OPERATION_CONFLICT" });
    assert.equal(f.service.productStore.listWorkRuns().filter(run => run.idempotencyKey === `shoggoth:chat-send:${result.operationId}`).length, 1);
    const user = f.service.transcriptStore.listEvents(owner.profileId, owner.transcriptSessionId).find(event => event.runId === result.runId && event.kind === "user");
    assert.equal(user.content.origin, "ui_action_submission"); assert.equal(user.content.uiAction.userSelection.values.selected, "B");
    assert.equal(user.contextExcluded, false);
  } finally { await f.remove(); }
});
test("a competing window's CAS change stops the clicked task without an operation", async () => {
  const f = await actionFixture(); try {
    const second = await f.ipc("chat.ui.open", { ...f.reference(f.part), mountId: "other-window" });
    await f.ipc("chat.ui.state.save", { ...f.owner, leaseId: second.leaseId, baseStateRevision: 0, patch: { selected: "C" } });
    await assert.rejects(f.send(f.spec()), { code: "UI_STATE_CONFLICT" });
    assert.equal(f.service.chatUiStore.operationsForRecovery().length, 0);
  } finally { await f.remove(); }
});

}
module.exports = { actionFixture };
