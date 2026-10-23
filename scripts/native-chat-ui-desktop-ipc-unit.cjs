#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { fixture, declaration } = require("./native-chat-ui-service-unit.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { registerDesktopChatUiIpc } = require("../app/desktop-chat-ui-ipc");
const { createFederationHostServer } = require("../app/federation-host-server");
async function desktopFixture() {
  const f = await fixture(), registry = new BackendRegistry(), notifications = [], handlers = new Map();
  const backend = new ShoggothBackend({ paths: f.paths, serviceEventPollMs: 20, getNativeChatUiConfig: () => f.service.chatUiConfig.read() });
  registry.register(backend); const started = await registry.start(); assert.equal(started.get("shoggoth"), true);
  const profile = f.service.productStore.getAgentProfile(f.owner.profileId), key = `agent:${profile.agentId}:${f.owner.sessionKey}`;
  const frame = { url: "http://127.0.0.1:32111/chat" }, contents = { mainFrame: frame, send: (channel, payload) => notifications.push(payload) };
  const window = { webContents: contents, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame };
  const host = { entries: new Map(), updates: [], async mount(opts) { this.entries.set(opts.mountId, { ...opts, visible: true }); },
    layout(id, layout) { this.entries.get(id).visible = !layout.occluded; return true; }, update(id, value) { this.updates.push({ id, value }); },
    async close(id) { const entry = this.entries.get(id); this.entries.delete(id); await entry?.onClose(); },
    async closeAll() { for (const id of [...this.entries.keys()]) await this.close(id); } };
  const main = registerDesktopChatUiIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    getMainWindow: () => window, getUiOrigin: () => "http://127.0.0.1:32111", getRegistry: () => registry, host });
  const federation = createFederationHostServer({ paths: f.paths, registry, verifyChatUiClick: value => main.verifyClick(value) }); await federation.start();
  const part = (await f.call("render_ui", declaration())).part, mountId = "desktop-main";
  const invoke = (method, value, sender = event) => handlers.get(`shoggoth:chat-ui:${method}`)(sender, value);
  const mounted = await invoke("mount", { backend: "shoggoth", agentId: profile.agentId, sessionKey: key, part, mountId, theme: "light", locale: "zh-CN" });
  assert.equal(mounted.ok, true, JSON.stringify(mounted));
  const bridge = value => host.entries.get(mountId).onMessage(value);
  const action = (extra = {}) => ({ mountId, actionId: "continue", actionRequestId: crypto.randomUUID(),
    draftId: main.entries.get(mountId).draftId, pluginSelection: [], ...extra });
  return { f, registry, backend, main, host, notifications, invoke, bridge, action, part, mountId, profile, key,
    async remove() { await main.close(); await federation.stop(); await registry.stop(); await f.remove(); } };
}
if (require.main === module) {
test("actual main IPC, Registry, native Backend and Service freeze B while a later change confirms C", async () => {
  const d = await desktopFixture(); try {
    await d.bridge({ type: "ready" }); await d.bridge({ type: "state.local", baseStateRevision: 0, patch: { selected: "B" } });
    let release, entered; const enteredGate = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const send = d.registry.submitChatUiAction.bind(d.registry);
    d.registry.submitChatUiAction = async (...args) => { entered(); await gate; return send(...args); };
    const params = d.action(), posting = d.invoke("action", params); await enteredGate;
    await d.bridge({ type: "state.local", baseStateRevision: 0, patch: { selected: "C" } });
    const later = d.bridge({ type: "state.patch", baseStateRevision: 0, patch: { selected: "C" } }); release();
    const receipt = await posting; assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.equal(receipt.result.status, "queued");
    const confirmed = await later; assert.equal(confirmed.state.selected, "C"); assert.equal(confirmed.stateRevision, 2);
    const session = d.f.service.chatSessionStore.getSession(d.f.owner.sessionKey), owner = { ...d.f.owner, transcriptSessionId: session.id };
    const operation = d.f.service.chatUiStore.getOperation(owner, { actionRequestId: params.actionRequestId });
    assert.equal(operation.snapshot.selected, "B"); assert.equal(operation.stateRevision, 1);
    assert.equal(d.f.service.chatUiStore.revision(owner, d.part.artifactId, 1).state.selected, "C");
    assert.deepEqual(await d.invoke("action", params), receipt); assert.equal(d.f.service.chatUiStore.operationsForRecovery().length, 1);
    assert.equal((await d.invoke("action", { ...params, draftId: d.main.entries.get(d.mountId).draftId })).error.code, "UI_OPERATION_CONFLICT");
    assert.equal(d.host.updates.some(row => row.value.type === "commit"), true);
  } finally { await d.remove(); }
});
test("main IPC refuses generated frames, foreign windows, hidden cards and undeclared actions", async () => {
  const d = await desktopFixture(); try {
    for (const sender of [{ sender: {}, senderFrame: {} }, { sender: d.main.entries.get(d.mountId).window.webContents,
      senderFrame: { url: "about:srcdoc" } }]) assert.equal((await d.invoke("action", d.action(), sender)).error.code, "UI_HOST_REQUIRED");
    d.host.entries.get(d.mountId).visible = false;
    assert.equal((await d.invoke("action", d.action())).error.code, "UI_HOST_REQUIRED"); d.host.entries.get(d.mountId).visible = true;
    assert.equal((await d.invoke("action", d.action({ actionId: "unknown" }))).error.code, "UI_STATE_CONFLICT");
    assert.equal(d.f.service.chatUiStore.operationsForRecovery().length, 0);
    await assert.rejects(d.bridge({ type: "historyPrompt", text: "自动发送不能发生" }), { code: "UI_ACTION_INVALID" });
  } finally { await d.remove(); }
});
test("a lost main receipt is unlocked only by an owner-bound query of the original operation", async () => {
  const d = await desktopFixture(); try {
    const send = d.registry.submitChatUiAction.bind(d.registry); d.registry.submitChatUiAction = async (...args) => {
      const receipt = await send(...args); return { ...receipt, status: "unknown" }; };
    const params = d.action(), received = await d.invoke("action", params); assert.equal(received.ok, true);
    assert.equal(d.main.entries.get(d.mountId).activeAction, params.actionRequestId);
    assert.equal((await d.invoke("operation", { mountId: d.mountId, actionRequestId: "foreign-request" })).error.code, "UI_SCOPE_MISMATCH");
    const query = await d.invoke("operation", { mountId: d.mountId, actionRequestId: params.actionRequestId });
    assert.equal(query.result.status, "queued"); assert.equal(query.result.runId, received.result.runId);
    assert.equal(d.main.entries.get(d.mountId).activeAction, null); assert.equal(d.f.service.chatUiStore.operationsForRecovery().length, 1);
  } finally { await d.remove(); }
});
test("main source revocation closes the matching host and releases its lease through actual Backend activity", async () => {
  const d = await desktopFixture(); try {
    const session = d.f.service.chatSessionStore.getSession(d.f.owner.sessionKey);
    d.f.service.transcriptStore.setContextExcluded({ profileId: d.f.owner.profileId, sessionId: session.id, eventId: d.part.sourceEventId, contextExcluded: true });
    const end = Date.now() + 3000;
    while (d.main.entries.has(d.mountId) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(d.main.entries.has(d.mountId), false); assert.equal(d.host.entries.size, 0);
    assert.ok(d.notifications.some(row => row.type === "revoked" && row.code === "UI_SOURCE_EXPIRED"));
  } finally { await d.remove(); }
});
}
module.exports = { desktopFixture };
