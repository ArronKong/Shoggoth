#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fixture, declaration } = require("./native-chat-ui-service-unit.cjs");
const { actionFixture } = require("./native-chat-ui-action-unit.cjs");
const { fixture: desktopFixture, turn } = require("./codex-desktop-session-service-fixture.cjs");
const { createFederationHostServer } = require("../app/federation-host-server");
const { createDesktopChatUiAuthority } = require("../app/desktop-chat-ui-authority");
const { OWNER } = require("../app/agent-service/codex-automation-store");

function fixedPublisher(f, session, overrides = {}) {
  const profile = f.service.productStore.getAgentProfile(session.profileId);
  const binding = f.service.productStore.getAgentRuntimeBinding(profile.id, session.runtimeBindingId);
  const runId = crypto.randomUUID(), producer = { id: runId, source: "chat", sourceId: session.sessionKey,
    profileId: profile.id, workspace: session.workspace, idempotencyKey: `shoggoth:chat-send:${runId}`, status: "running",
    contextSnapshotId: null, runtimeSessionRef: null, runtimeTurnRef: null, eventSeq: 1, waitingRequestId: null,
    startedAt: Date.now(), finishedAt: null, resultSummary: null, errorCode: null, retryOf: null, ...overrides };
  f.service.productStore.putWorkRun(producer); f.service.hookService.freezeRun(producer, profile);
  const lease = f.service.workRunCoordinator.hostCapabilityIssuer.issue({ identity: { runId, profileId: profile.id,
    bindingId: binding.id, runtime: binding.runtime, runtimeAccountId: binding.runtimeAccountId,
    attemptId: "ui-eligibility-fixed-runtime", workspace: session.workspace }, validate: () => f.service.productStore.getWorkRun(runId)?.status === "running" });
  f.service.workRunCoordinator.runCapabilityLeases.set(runId, lease);
  f.service.workRunCoordinator.runExecutionContracts.set(runId, { borrowedMemoryRefs: [] });
  const scope = { runId, assertCurrent: () => f.service.workRunCoordinator.hostCapabilityIssuer.assert(lease, { kind: "mcp", identity: { runId } }) };
  f.service.transcriptStore.appendEvent({ profileId: profile.id, sessionId: session.id, id: crypto.randomUUID(), runId,
    kind: "user", content: { text: "来源资格验证" }, runtimeRef: null, contextExcluded: false, occurredAt: Date.now() });
  return { runId, lease, publish: () => f.service.mcpProductToolController.handle("render_ui", declaration(), { profileId: profile.id, callId: crypto.randomUUID() }, scope) };
}

for (const kind of ["inspiration", "proactive"]) test(`persisted ${kind} origin prevents publishing and makes an existing ordinary card read only`, async () => {
  const f = await actionFixture();
  try {
    const profile = f.service.productStore.getAgentProfile(f.owner.profileId);
    if (kind === "proactive") {
      f.service.proactiveStore.setTarget(profile.id, { operationId: crypto.randomUUID(), profileId: profile.id,
        sessionKey: f.owner.sessionKey, createdAt: Date.now(), deleted: false });
      assert(f.service.proactiveStore.sessionOrigin(f.owner.sessionKey));
    } else {
      const idea = f.service.inspirationStore.create({ operationId: crypto.randomUUID(), body: "隔离测试灵感" });
      f.service.inspirationStore.prepareExecution({ operationId: crypto.randomUUID(), id: idea.id, expectedRevision: idea.revision,
        instruction: "资格验证", agentId: profile.agentId, backendId: "shoggoth", profileId: profile.id, workspace: f.workspace }, () => true, f.owner.sessionKey);
      assert(f.service.inspirationStore.executionForSession(f.owner.sessionKey));
    }
    await assert.rejects(f.call("render_ui", declaration()), { code: "UI_DIRECT_CHAT_REQUIRED" });
    const desc = await f.ipc("chat.ui.describe", f.reference(f.part));
    assert.equal(desc.readOnly, true); assert.equal(desc.readOnlyReason, "UI_SOURCE_EXPIRED");
    await assert.rejects(f.send(f.spec()), { code: "UI_SOURCE_EXPIRED" });
    assert.equal(f.service.chatUiStore.operationsForRecovery().length, 0);
    assert.equal(f.service.productStore.listWorkRuns().length, 1);
  } finally { await f.remove(); }
});

test("actual durable Cron association refuses MCP publication and canonical legacy import", async () => {
  const f = await fixture();
  try {
    const session = f.service.chatSessionStore.ensureCronSession({ runId: crypto.randomUUID(), jobId: "ui-qualification-cron",
      profileId: f.owner.profileId, workspace: f.workspace, threadSource: null, runtimeSessionId: "ui-qualification-cron-native" });
    assert(f.service.chatSessionStore.getCronSessionOrigin(session.sessionKey));
    const producer = fixedPublisher(f, session);
    await assert.rejects(producer.publish(), { code: "UI_DIRECT_CHAT_REQUIRED" });
    const sourceEventId = crypto.randomUUID();
    f.service.transcriptStore.appendEvent({ profileId: f.owner.profileId, sessionId: session.id, id: sourceEventId, runId: producer.runId,
      kind: "assistant", content: { transcriptType: "text", text: "```html\n<!doctype html><html><body><button>历史卡片</button></body></html>\n```" },
      runtimeRef: null, contextExcluded: false, occurredAt: Date.now() });
    await assert.rejects(f.ipc("chat.ui.import", { profileId: f.owner.profileId, sessionKey: session.sessionKey, sourceEventId, blockIndex: 0 }), { code: "UI_DIRECT_CHAT_REQUIRED" });
    assert.equal(f.service.chatUiStore.publicationsForRecovery().length, 0);
  } finally { await f.remove(); }
});

for (const kind of ["federation", "system"]) test(`actual ${kind} WorkRun cannot publish as direct chat`, async () => {
  const f = await fixture();
  try {
    const session = f.service.chatSessionStore.getSession(f.owner.sessionKey);
    // Compaction is the supported automatic system WorkRun source.
    const producer = fixedPublisher(f, session, kind === "federation"
      ? { idempotencyKey: `shoggoth:chat-send:federation-send-${crypto.randomUUID()}` } : { source: "compaction" });
    await assert.rejects(producer.publish(), error => ["UI_DIRECT_CHAT_REQUIRED", "UI_SCOPE_MISMATCH"].includes(error.code));
    assert.equal(f.service.chatUiStore.publicationsForRecovery().length, 0);
  } finally { await f.remove(); }
});

test("occupied real Desktop thread remains readable but refuses publish, state and action before any takeover", async () => {
  const f = await desktopFixture(); const authority = createDesktopChatUiAuthority(); let proofHost, producerLease;
  try {
    const row = f.backend.getSessionRows().find(value => value.source === "codex-desktop" && value.label === "桌面对话：保留原上下文");
    const entry = f.backend._codexDesktopEntries.get(row.sessionId);
    await f.ipc("codex.desktop.session.attach", { profileId: OWNER.id, threadId: f.native.id, homeIdentity: entry.homeIdentity });
    const session = f.service.chatSessionStore.getSession(row.sessionId), profile = f.service.productStore.getAgentProfile(OWNER.id);
    await f.ipc("chat.ui.config.apply", { revision: 1, config: { nativeChatUiV1: true } });
    fs.writeFileSync(path.join(f.workspace, "card.html"), "<!doctype html><h1>Desktop 原对话卡片</h1>");
    const producer = fixedPublisher(f, session); producerLease = producer.lease;
    const publish = producer.publish;
    const part = (await publish()).part, owner = { profileId: profile.id, sessionKey: session.sessionKey };
    const reference = { ...owner, artifactId: part.artifactId, revision: part.revision, sourceEventId: part.sourceEventId };
    const idle = await f.ipc("chat.ui.open", { ...reference, mountId: "idle-desktop" }); assert.equal(idle.readOnly, false);
    f.native.turns.push(turn("桌面正在运行", "", "inProgress"));
    const busy = await f.ipc("chat.ui.open", { ...reference, mountId: "busy-desktop" });
    assert.equal(busy.readOnly, true); assert.equal(busy.readOnlyReason, "CODEX_DESKTOP_BUSY");
    assert.equal((await f.ipc("chat.ui.describe", reference)).readOnlyReason, "CODEX_DESKTOP_BUSY");
    assert.equal((await f.ipc("chat.ui.renew", { ...owner, leaseId: idle.leaseId })).readOnly, true);
    assert((await f.ipc("chat.ui.read", { ...owner, leaseId: busy.leaseId, offset: 0 })).data);
    await assert.rejects(publish(), { code: "CODEX_DESKTOP_BUSY" });
    await assert.rejects(f.ipc("chat.ui.state.save", { ...owner, leaseId: idle.leaseId, baseStateRevision: 0, patch: { selected: "B" } }), { code: "CODEX_DESKTOP_BUSY" });
    proofHost = createFederationHostServer({ paths: f.paths, registry: { getStatus: async () => [], getBackend: () => null }, verifyChatUiClick: input => authority.consume(input) }); await proofHost.start();
    const action = { ...owner, leaseId: idle.leaseId, actionId: "continue", actionRequestId: crypto.randomUUID(), stateRevision: 0, snapshot: { selected: "B" } };
    await assert.rejects(f.ipc("chat.ui.action", { ...action, hostProof: authority.issue(action, () => true) }), { code: "CODEX_DESKTOP_BUSY" });
    assert.equal(f.host.threadStarts, 0); assert.equal(f.host.turnStarts, 0);
    assert.equal(f.service.chatUiStore.operationsForRecovery().length, 0);
    assert.equal(f.service.chatUiStore.publicationsForRecovery().length, 1);
    assert.equal(f.service.productStore.listWorkRuns().length, 1);
    f.native.turns.pop();
    assert.equal((await f.ipc("chat.ui.renew", { ...owner, leaseId: idle.leaseId })).readOnly, false);
    await f.ipc("chat.ui.state.save", { ...owner, leaseId: idle.leaseId, baseStateRevision: 0, patch: { selected: "C" } });
  } finally {
    authority.close(); await proofHost?.stop(); if (producerLease) f.service.workRunCoordinator.hostCapabilityIssuer.revoke(producerLease); await f.close();
  }
});

test("an admitted Shoggoth turn in a Desktop conversation can publish and queue UI, while an additional external turn blocks writes", async () => {
  const f = await desktopFixture(); const authority = createDesktopChatUiAuthority(); let proofHost;
  try {
    const row = f.backend.getSessionRows().find(value => value.source === "codex-desktop" && value.label === "桌面对话：保留原上下文");
    const entry = f.backend._codexDesktopEntries.get(row.sessionId);
    await f.ipc("codex.desktop.session.attach", { profileId: OWNER.id, threadId: f.native.id, homeIdentity: entry.homeIdentity });
    await f.ipc("chat.ui.config.apply", { revision: 1, config: { nativeChatUiV1: true } });
    const ack = await f.service.workRunCoordinator.send({ operationId: crypto.randomUUID(), sessionKey: row.sessionId, prompt: "生成交互卡片" });
    await f.service.workRunCoordinator.waitForIdle(ack.run.id);
    const run = f.service.productStore.getWorkRun(ack.run.id); assert.equal(run.status, "running");
    assert.equal(run.runtimeSessionRef.sessionId, f.native.id); assert.equal(f.host.threadStarts, 0); assert.equal(f.host.turnStarts, 1);
    const lease = f.service.workRunCoordinator.runCapabilityLeases.get(run.id);
    const scope = { runId: run.id, assertCurrent: () => f.service.workRunCoordinator.hostCapabilityIssuer.assert(lease, { kind: "mcp", identity: { runId: run.id } }) };
    fs.writeFileSync(path.join(f.workspace, "card.html"), "<!doctype html><h1>自有运行中的卡片</h1>");
    const part = (await f.service.mcpProductToolController.handle("render_ui", declaration(), { profileId: OWNER.id, callId: crypto.randomUUID() }, scope)).part;
    const owner = { profileId: OWNER.id, sessionKey: row.sessionId }, reference = { ...owner,
      artifactId: part.artifactId, revision: part.revision, sourceEventId: part.sourceEventId };
    const opened = await f.ipc("chat.ui.open", { ...reference, mountId: "admitted-desktop" }); assert.equal(opened.readOnly, false);
    proofHost = createFederationHostServer({ paths: f.paths, registry: { getStatus: async () => [], getBackend: () => null }, verifyChatUiClick: input => authority.consume(input) }); await proofHost.start();
    const action = { ...owner, leaseId: opened.leaseId, actionId: "continue", actionRequestId: crypto.randomUUID(), stateRevision: 0, snapshot: { selected: "B" } };
    const result = await f.ipc("chat.ui.action", { ...action, hostProof: authority.issue(action, () => true) });
    assert.equal(result.status, "queued"); assert.equal(result.reason, "CHAT_SESSION_BUSY"); assert.equal(f.host.turnStarts, 1);
    await f.service.workRunCoordinator.abort({ operationId: crypto.randomUUID(), sessionKey: row.sessionId, runId: result.runId });
    assert.equal(f.service.productStore.getWorkRun(result.runId).status, "canceled");
    f.native.turns.push(turn("外部桌面开始运行", "", "inProgress"));
    assert.equal((await f.ipc("chat.ui.renew", { ...owner, leaseId: opened.leaseId })).readOnlyReason, "CODEX_DESKTOP_BUSY");
    await assert.rejects(f.ipc("chat.ui.state.save", { ...owner, leaseId: opened.leaseId, baseStateRevision: 1, patch: { selected: "C" } }), { code: "CODEX_DESKTOP_BUSY" });
    assert.equal(f.host.threadStarts, 0); assert.equal(f.host.turnStarts, 1); assert.equal(f.service.productStore.listWorkRuns().length, 2);
    f.native.turns.pop(); f.host.finish(run.runtimeTurnRef.turnId, "原任务完成");
    await f.service.workRunCoordinator.waitForIdle(run.id);
    assert.equal((await f.ipc("chat.ui.renew", { ...owner, leaseId: opened.leaseId })).readOnly, false);
  } finally { authority.close(); await proofHost?.stop(); await f.close(); }
});
