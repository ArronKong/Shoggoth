#!/usr/bin/env node
"use strict";
// Actual Service, Backend, Gateway and immutable plugin authority; only native
// model transport is controlled. This suite does not claim native GUI input.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { once } = require("node:events");
const { WebSocket } = require("ws");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { declaration } = require("./native-chat-ui-service-unit.cjs");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { createDesktopChatUiAuthority } = require("../app/desktop-chat-ui-authority");
const { createFederationHostServer } = require("../app/federation-host-server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startProxyGateway } = require("../app/core/proxy-gateway");
async function waitFor(check, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(label);
}
async function connect(url) {
  const socket = new WebSocket(url), pending = new Map();
  socket.on("message", data => { const frame = JSON.parse(data.toString()); pending.get(frame.id)?.(frame); });
  await once(socket, "open");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 5000);
    pending.set(id, frame => { clearTimeout(timer); pending.delete(id); resolve(frame); });
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  });
  assert.equal((await request("connect", {})).ok, true);
  return { request, async close() { if (socket.readyState === WebSocket.CLOSED) return; const closed = once(socket, "close"); socket.close(); await closed; } };
}
test("Gateway cancels precisely the UI queued Run while its card producer continues", { timeout: 20000 }, async () => {
  const f = await openHandoffFixture(), registry = new BackendRegistry(), authority = createDesktopChatUiAuthority();
  let host, proxy, client;
  try {
    f.service.chatUiConfig.apply({ revision: 1, config: { nativeChatUiV1: true } });
    const session = f.createSession(), owner = { profileId: f.profile.id, sessionKey: session.sessionKey };
    const producer = await f.send(session.sessionKey, crypto.randomUUID(), "比较方案");
    const lease = f.service.workRunCoordinator.runCapabilityLeases.get(producer.id);
    const scope = { runId: producer.id, assertCurrent: () => f.service.workRunCoordinator.hostCapabilityIssuer.assert(lease, { kind: "mcp", identity: { runId: producer.id } }) };
    fs.writeFileSync(path.join(f.workspace, "card.html"), "<!doctype html><h1>取消回归卡片</h1>");
    const { part } = await f.service.mcpProductToolController.handle("render_ui", declaration(), { profileId: owner.profileId, callId: crypto.randomUUID() }, scope);
    host = createFederationHostServer({ paths: f.paths, registry: { getStatus: async () => [], getBackend: () => null }, verifyChatUiClick: params => authority.consume(params) });
    await host.start();
    const rpc = (method, params) => requestService(f.paths, { id: crypto.randomUUID(), token: readClientToken(f.paths), version: SERVICE_PROTOCOL_VERSION, method, params });
    const opened = await rpc("chat.ui.open", { ...owner, artifactId: part.artifactId, revision: 1, sourceEventId: part.sourceEventId, mountId: "cancel-regression" });
    const action = { ...owner, leaseId: opened.leaseId, actionRequestId: crypto.randomUUID(), actionId: "continue", stateRevision: 0, snapshot: { selected: "B" } };
    const receipt = await rpc("chat.ui.action", { ...action, hostProof: authority.issue(action, () => true) });
    assert.equal(receipt.status, "queued");
    const backend = new ShoggothBackend({ paths: f.paths, serviceEventPollMs: 30 }); registry.register(backend);
    assert.equal((await registry.start()).get("shoggoth"), true);
    proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => "", registry }); client = await connect(proxy.url);
    const key = `agent:${f.profile.agentId}:${session.sessionKey}`;
    const canceled = await client.request("chat.abort", { sessionKey: key, runId: receipt.runId });
    assert.equal(canceled.ok, true, JSON.stringify(canceled));
    assert.equal(f.service.workRunCoordinator.getRun(receipt.runId).status, "canceled");
    assert.equal(f.service.workRunCoordinator.getRun(producer.id).status, "running");
    scope.assertCurrent();
    const operation = await rpc("chat.ui.operation.get", { ...owner, actionRequestId: action.actionRequestId });
    assert.equal(operation.runId, receipt.runId); assert.equal(operation.status, "cancelled");
    const user = f.service.transcriptStore.listEvents(owner.profileId, session.id).find(event => event.runId === receipt.runId && event.kind === "user");
    assert.equal(user.content.uiAction.userSelection.values.selected, "B");
    assert.equal(f.transport.hosts.get("codex").turnStartCalls, 1);
    assert.equal(f.service.productStore.listWorkRuns().length, 2);
    await f.complete(producer);
  } finally { await client?.close(); await proxy?.close(); await registry.stop(); authority.close(); await host?.stop(); await f.close(); }
});

test("concurrent capacity drains admit each queued Run once with real plugin authority", { timeout: 20000 }, async () => {
  const f = await openHandoffFixture();
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1, startupConcurrency: 1, flags: { ...config.flags, runtimeAdmissionV1: true } });
    assert.equal(f.service.startupGate.acquire("controlled-startup-holder"), true);
    const session = f.createSession(), first = await f.send(session.sessionKey, crypto.randomUUID()), second = await f.send(session.sessionKey, crypto.randomUUID());
    assert.equal(first.status, "queued"); assert.equal(second.status, "queued");
    assert.equal(f.service.startupGate.release("controlled-startup-holder"), true);
    await Promise.all(Array.from({ length: 3 }, () => f.service.workRunCoordinator.capacityChanged()));
    await f.service.workRunCoordinator.waitForIdle(first.id);
    const running = f.service.workRunCoordinator.getRun(first.id);
    assert.equal(running.status, "running"); assert.equal(f.service.workRunCoordinator.getRun(second.id).status, "queued");
    assert.equal(f.transport.hosts.get("codex").turnStartCalls, 1);
    const lease = f.service.workRunCoordinator.runCapabilityLeases.get(first.id);
    f.service.workRunCoordinator.hostCapabilityIssuer.assert(lease, { kind: "mcp", identity: { runId: first.id } });
    await f.complete(running);
    await waitFor(() => f.service.workRunCoordinator.getRun(second.id)?.status === "running", "second Run never drained");
    assert.equal(f.transport.hosts.get("codex").turnStartCalls, 2);
    await f.complete(f.service.workRunCoordinator.getRun(second.id));
    assert.equal(f.service.productStore.listWorkRuns().length, 2);
    assert.equal(f.service.workRunCoordinator.poisonError, null);
  } finally { await f.close(); }
});

test("handoff preserves the active card and routes its next UI input to the selected Runtime", { timeout: 20000 }, async () => {
  const f = await openHandoffFixture(), authority = createDesktopChatUiAuthority();
  let host;
  try {
    const service = f.service; service.chatUiConfig.apply({ revision: 1, config: { nativeChatUiV1: true } });
    const session = f.createSession(), producer = await f.send(session.sessionKey, crypto.randomUUID());
    const owner = { profileId: f.profile.id, sessionKey: session.sessionKey };
    const lease = service.workRunCoordinator.runCapabilityLeases.get(producer.id);
    const scope = { runId: producer.id, assertCurrent: () => service.workRunCoordinator.hostCapabilityIssuer.assert(lease, { kind: "mcp", identity: { runId: producer.id } }) };
    fs.writeFileSync(path.join(f.workspace, "card.html"), "<!doctype html><h1>Runtime handoff regression</h1>");
    const { part } = await service.mcpProductToolController.handle("render_ui", declaration(), { profileId: owner.profileId, callId: crypto.randomUUID() }, scope);
    const reference = { ...owner, artifactId: part.artifactId, revision: 1, sourceEventId: part.sourceEventId };
    host = createFederationHostServer({ paths: f.paths, registry: { getStatus: async () => [], getBackend: () => null }, verifyChatUiClick: value => authority.consume(value) }); await host.start();
    const rpc = (method, params) => requestService(f.paths, { id: crypto.randomUUID(), token: readClientToken(f.paths), version: SERVICE_PROTOCOL_VERSION, method, params });
    const opened = await rpc("chat.ui.open", { ...reference, mountId: "before-handoff" });
    await rpc("chat.ui.state.save", { ...owner, leaseId: opened.leaseId, baseStateRevision: 0, patch: { selected: "B" } });
    await f.complete(producer); await f.switch(session.sessionKey, "pi");
    const switched = service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(switched.status, "draft"); assert.equal(switched.runtimeSessionId, null);
    assert.equal((await rpc("chat.ui.describe", reference)).readOnly, false);
    const renewed = await rpc("chat.ui.renew", { ...owner, leaseId: opened.leaseId });
    assert.equal(renewed.readOnly, false); assert.equal(renewed.state.selected, "B");
    await rpc("chat.ui.state.save", { ...owner, leaseId: opened.leaseId, baseStateRevision: 1, patch: { selected: "C" } });
    const action = { ...owner, leaseId: opened.leaseId, actionRequestId: crypto.randomUUID(), actionId: "continue", stateRevision: 2, snapshot: { selected: "C" } };
    const receipt = await rpc("chat.ui.action", { ...action, hostProof: authority.issue(action, () => true) });
    await waitFor(() => service.workRunCoordinator.getRun(receipt.runId)?.status === "running", "UI handoff Run did not start");
    const current = service.workRunCoordinator.getRun(receipt.runId);
    assert.equal(current.runtimeSessionRef.runtime, "pi");
    assert.equal(current.runtimeSessionRef.runtimeAccountId, f.binding("pi").runtimeAccountId);
    assert.equal(f.transport.hosts.get("codex").turnStartCalls, 1); assert.equal(f.transport.hosts.get("pi").turnStartCalls, 1);
    const input = service.transcriptStore.listEvents(owner.profileId, session.id).find(event => event.runId === current.id && event.kind === "user");
    assert.equal(input.content.uiAction.userSelection.values.selected, "C");
    assert.equal(input.content.uiAction.sourceEventId, part.sourceEventId);
    await f.complete(current);
    service.chatSessionStore.requestArchive(session.sessionKey, crypto.randomUUID(), Date.now());
    assert.equal((await rpc("chat.ui.describe", reference)).readOnly, true);
    await assert.rejects(rpc("chat.ui.state.save", { ...owner, leaseId: opened.leaseId, baseStateRevision: 2, patch: { selected: "A" } }), { code: "UI_SOURCE_EXPIRED" });
  } finally { authority.close(); await host?.stop(); await f.close(); }
});

test("cancellation during real contract preparation never admits the canceled Run", { timeout: 20000 }, async () => {
  const f = await openHandoffFixture(); let original, drain, resume;
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1, startupConcurrency: 1, flags: { ...config.flags, runtimeAdmissionV1: true } });
    f.service.startupGate.acquire("controlled-startup-holder");
    const session = f.createSession(), queued = await f.send(session.sessionKey, crypto.randomUUID()); assert.equal(queued.status, "queued");
    const gate = new Promise(resolve => { resume = resolve; }); let entered = false;
    original = f.service.hookService.prepareRun;
    // Pause after genuine Hook preparation; retain every production guard and
    // authority. The only test control is the timing of this owned admission.
    f.service.hookService.prepareRun = async function(...args) {
      const prepared = await original.apply(this, args);
      if (args[0].id === queued.id) { entered = true; await gate; }
      return prepared;
    };
    f.service.startupGate.release("controlled-startup-holder");
    drain = f.service.workRunCoordinator.capacityChanged(); drain.catch(() => {});
    await waitFor(() => entered, "contract preparation did not reach the timing barrier");
    const canceled = await f.service.workRunCoordinator.abort({ operationId: crypto.randomUUID(), sessionKey: session.sessionKey, runId: queued.id });
    assert.equal(canceled.status, "canceled"); resume(); await drain;
    assert.equal(f.service.workRunCoordinator.getRun(queued.id).status, "canceled");
    assert.equal(f.transport.hosts.size, 0); assert.equal(f.service.workRunCoordinator.runCapabilityLeases.size, 0);
    assert.equal(f.service.productStore.listWorkRuns().length, 1); assert.equal(f.service.workRunCoordinator.poisonError, null);
  } finally { resume?.(); if (original) f.service.hookService.prepareRun = original; await drain?.catch(() => {}); await f.close(); }
});
