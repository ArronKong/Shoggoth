#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { actionFixture } = require("./native-chat-ui-action-unit.cjs");
const { declaration } = require("./native-chat-ui-service-unit.cjs");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { createDesktopChatUiAuthority } = require("../app/desktop-chat-ui-authority");
const { createFederationHostServer } = require("../app/federation-host-server");
const { ContextCompiler } = require("../app/agent-service/context-compiler");
const OPTIONS = { memoryCore: true, memorySharingFeatureReady: true, memoryCoreConfig: {
  memory: { search: { provider: "none", rememberAcrossConversations: false } },
  agents: { defaults: { compaction: { memoryFlush: { enabled: true } } } },
  plugins: { entries: { "active-memory": { config: { enabled: false } } } } } };
test("UI submissions stay in model context but not actual recall, Product memory session or memory flush facts", async () => {
  const f = await actionFixture(OPTIONS); try {
    const receipt = await f.send(f.spec()), session = f.service.chatSessionStore.getSession(f.owner.sessionKey);
    const user = f.service.transcriptStore.listEvents(f.owner.profileId, session.id).find(event => event.runId === receipt.runId && event.kind === "user");
    const uiText = user.content.text; assert.equal(user.content.origin, "ui_action_submission"); assert.equal(user.contextExcluded, false);
    f.service.productStore.putWorkRun({ ...f.service.productStore.getWorkRun(f.runId), status: "completed", finishedAt: Date.now(), eventSeq: f.service.productStore.getWorkRun(f.runId).eventSeq + 1 });
    f.service.productStore.putWorkRun({ ...f.service.productStore.getWorkRun(receipt.runId), status: "completed", finishedAt: Date.now(), eventSeq: f.service.productStore.getWorkRun(receipt.runId).eventSeq + 1 });
    const recall = f.service.conversationRecallService;
    const page = recall.scanEligibleSession({ profileId: f.owner.profileId, sessionId: session.id, afterSeq: 0, limit: 100, completedOnly: true });
    assert.ok(page.events.some(event => event.eventId === "fixture-user-source"));
    assert.equal(page.events.some(event => event.eventId === user.id), false);
    assert.throws(()=>recall.assertCandidateSourceCurrent(f.owner.profileId, { kind: "user", eventId: user.id, runId: receipt.runId, sessionId: session.id }), { code: "MEMORY_CANDIDATE_SOURCE_OUTDATED" });
    const memory = f.service.memoryEngine, host = memory.host(f.owner.profileId), source = host.sessions.read(f.owner.profileId, session.id);
    assert.equal(source.content.includes(uiText), false); assert.equal(source.lineMap.includes(user.seq), false);
    assert.equal(source.lineProvenance.every(row => ["owner", "agent"].includes(row.originClass)), true);
    assert.throws(()=>memory.assertOwnedMemorySources({ profileId: f.owner.profileId, content: "按钮生成的默认偏好", sourceRefs: [user.id] }), { code: "MEMORY_SOURCE_REVOKED" });
    assert.throws(()=>memory.assertOwnedMemorySources({ profileId: f.owner.profileId, content: "按钮生成的默认偏好", sourceRefs: [receipt.runId] }), { code: "MEMORY_SOURCE_REVOKED" });
    let prompt = null; memory.complete = async input => { prompt = input.prompt; return { text: "NO_REPLY" }; };
    const flushed = await memory.flushBeforeCompaction({ profileId: f.owner.profileId, sessionId: session.id, contextWindowTokens: 32000 });
    assert.ok(["completed", "done"].includes(flushed.status), JSON.stringify(flushed)); assert.ok(prompt.includes("比较三个方案"));
    assert.equal(prompt.includes(uiText), false); assert.equal(prompt.includes("当前选择"), false);
    const context = f.service.transcriptStore.contextEvent(f.owner.profileId, session.id, user);
    assert.equal(context.content.text, uiText); assert.equal(context.content.uiAction.userSelection.values.selected, "B");
  } finally { await f.remove(); }
});
test("borrowed UI publication, queued input, source withdrawal and Service restart preserve the real dependency chain", { timeout: 30000 }, async () => {
  const options = { ...OPTIONS, memoryCoreConfig: { ...OPTIONS.memoryCoreConfig,
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } } };
  let f = await openHandoffFixture({ serviceOptions: options }), host, authority, releaseSourceScan;
  const FACT = "Borrowed UI telescope calibration marker is aquamarine.";
  try {
    const service = f.service, reader = f.profile.id, sourceId = "ui-borrowed-source";
    const runtimeConfig = service.nativeRuntimeConfig.read();
    service.nativeRuntimeConfig.apply({ ...runtimeConfig, revision: runtimeConfig.revision + 1,
      flags: { ...runtimeConfig.flags, runtimeContextLifecycleV1: false } });
    service.chatUiConfig.apply({ revision: 1, config: { nativeChatUiV1: true } });
    service.productStore.putAgentProfile({ ...f.profile, id: sourceId, agentId: sourceId, runtimeProfileId: sourceId, name: sourceId, isDefault: false });
    service.agentDefinitionStore.ensureProfile({ profileId: sourceId });
    service.memoryEngine.store.ensureProfile(sourceId); service.memoryEngine.recallPolicy.assertReady(sourceId);
    service.nativeMemorySharingConfig.apply({ revision: 0, config: { enabled: true, excludedProfiles: [] } });
    const item = await service.memoryEngine.propose({ profileId: sourceId, content: FACT, scope: "agent", classification: "explicit", sourceRefs: ["user-edit:ui-source"] });
    const session = f.createSession(), run = await f.send(session.sessionKey, "ui-borrowed-creator", "Find telescope calibration");
    assert.equal(run.status, "running", run.errorCode);
    const call = (name, args) => f.callTool(run, name, args);
    const found = await call("memory_search", { query: "telescope", minScore: 0, maxResults: 20, ownerProfileId: sourceId });
    assert.ok(found.results, JSON.stringify(found));
    const hit = found.results.find(value => value.ownerProfileId === sourceId); assert.ok(hit);
    const read = await call("memory_get", { id: hit.sourceRef }); assert.equal(read.text.includes("aquamarine"), true);
    fs.writeFileSync(path.join(f.workspace, "card.html"), `<html><h1>${FACT}</h1></html>`);
    const { runtimeProfileId, runtimeAccountId } = run.runtimeSessionRef;
    const first = await service.workRunCoordinator.invokeRuntimeCapability({ runId: run.id, runtimeProfileId, runtimeAccountId,
      kind: "mcp" }, scope => service.mcpProductToolController.handle("render_ui", declaration(),
      { profileId: reader, callId: crypto.randomUUID() }, scope));
    assert.ok(first.part, JSON.stringify(first));
    const owner = { profileId: reader, transcriptSessionId: session.id, sessionKey: session.sessionKey }, ref = { profileId: reader, sessionKey: session.sessionKey,
      artifactId: first.part.artifactId, revision: 1, sourceEventId: first.part.sourceEventId };
    const rev = service.chatUiStore.revision(owner, ref.artifactId, 1); assert.equal(rev.provenance.borrowedMemoryDerived, true); assert.ok(rev.provenance.borrowedMemoryRefs.length);
    const event = service.transcriptStore.getEvent(reader, session.id, first.part.sourceEventId);
    assert.deepEqual(event.content.borrowedMemoryRefs, rev.provenance.borrowedMemoryRefs);
    assert.equal(event.content.borrowedMemoryDerived, true);
    authority = createDesktopChatUiAuthority(); host = createFederationHostServer({ paths: f.paths,
      registry: { getStatus: async () => [], getBackend: () => null }, verifyChatUiClick: value => authority.consume(value) }); await host.start();
    const opened = await service.chatUiController.open({ ...ref, mountId: "borrowed-ui" });
    const params = { profileId: reader, sessionKey: session.sessionKey, leaseId: opened.leaseId, actionRequestId: "borrowed-click", actionId: "continue", stateRevision: 0, snapshot: { selected: "B" } };
    const receipt = await service.chatUiController.action({ ...params, hostProof: authority.issue(params, () => true) }); assert.equal(receipt.status, "queued");
    const input = service.transcriptStore.listEvents(reader, session.id).find(value => value.runId === receipt.runId && value.kind === "user");
    assert.deepEqual(input.content.borrowedMemoryRefs, rev.provenance.borrowedMemoryRefs); assert.equal(input.content.borrowedMemoryDerived, true);
    assert.equal(input.content.origin, "ui_action_submission");

    const ui = service.chatUiController, sharing = service.memoryEngine.sharing;
    await ui.sourceFlight;
    const readViews = sharing.withDependencyReadViews;
    const { promise: scanEntered, resolve: enterScan } = Promise.withResolvers();
    const { promise: scanHeld, resolve: releaseScan } = Promise.withResolvers();
    releaseSourceScan = releaseScan;
    let scans = 0, asyncDependencyReads = 0, synchronousScan = false;
    const dependencyChecks = ui._dependencies;
    ui._dependencies = function (owner, provenance) {
      if (provenance.borrowedMemoryRefs?.length > 0 && service.memoryEngine.memoryViewFor(sourceId)) asyncDependencyReads++;
      return dependencyChecks.call(this, owner, provenance);
    };
    const syncStoreRead = service.memoryEngine.store._snapshot;
    service.memoryEngine.store._snapshot = function (...args) {
      synchronousScan = true;
      return syncStoreRead.apply(this, args);
    };
    sharing.withDependencyReadViews = async function (profileId, owners, ...args) {
      assert.equal(profileId, reader);
      assert.deepEqual(owners, [sourceId]);
      if (++scans === 1) {
        enterScan(); await scanHeld;
        throw Object.assign(new Error("controlled worker outage"), { code: "MEMORY_SCAN_UNAVAILABLE" });
      }
      return readViews.call(this, profileId, owners, ...args);
    };
    try {
      const probing = ui.reconcileSources();
      assert.ok(probing instanceof Promise, "borrowed reconciliation waits on a worker asynchronously");
      await scanEntered;
      assert.equal(service.chatUiStore.revision(owner, ref.artifactId, 1).status, "ready");
      releaseSourceScan(); await probing;
      assert.equal(service.chatUiStore.revision(owner, ref.artifactId, 1).status, "ready", "worker outage is not a source withdrawal");
      await ui.reconcileSources();
      assert.ok(asyncDependencyReads > 0, "healthy artifact proof is checked in the owner view");
      assert.equal(synchronousScan, false, "background reconciliation did not traverse a memory tree on the Service thread");

      const prepare = () => service.chatUiStore.preparePublication({ owner, callId: crypto.randomUUID(),
        fingerprint: crypto.randomBytes(32).toString("hex"), tool: "render_ui", declaration: declaration(),
        html: `<html><h1>${FACT}</h1></html>`, creatorRunId: run.id, creatorAttemptId: rev.creatorAttemptId,
        provenance: rev.provenance });
      const interrupted = prepare();
      const { promise: recoveryEntered, resolve: enterRecovery } = Promise.withResolvers();
      const { promise: recoveryHeld, resolve: releaseRecovery } = Promise.withResolvers();
      releaseSourceScan = releaseRecovery;
      sharing.withDependencyReadViews = async function () {
        enterRecovery(); await recoveryHeld;
        throw Object.assign(new Error("controlled recovery worker outage"), { code: "MEMORY_SCAN_UNAVAILABLE" });
      };
      const recovering = ui.recover();
      await recoveryEntered;
      assert.equal(service.chatUiStore.revision(owner, interrupted.artifactId, 1).status, "preparing");
      assert.equal(service.transcriptStore.getEvent(reader, session.id, interrupted.sourceEventId), null);
      releaseRecovery(); await recovering;
      assert.equal(service.chatUiStore.revision(owner, interrupted.artifactId, 1).status, "preparing",
        "temporary worker outage preserves the durable prepare");
      const live = prepare();
      sharing.withDependencyReadViews = readViews;
      await ui.reconcileSources();
      assert.equal(service.chatUiStore.revision(owner, interrupted.artifactId, 1).status, "ready");
      assert.equal(service.transcriptStore.getEvent(reader, session.id, interrupted.sourceEventId)?.kind, "artifact");
      assert.equal(service.chatUiStore.revision(owner, live.artifactId, 1).status, "preparing",
        "a normal live prepare is not published by a source sweep");
      assert.equal(service.transcriptStore.getEvent(reader, session.id, live.sourceEventId), null);
      assert.equal(synchronousScan, false, "startup recovery does not synchronously scan borrowed memory");
      service.chatUiStore.revokeRevision(owner, live.artifactId, 1);
    } finally {
      sharing.withDependencyReadViews = readViews;
      service.memoryEngine.store._snapshot = syncStoreRead;
      ui._dependencies = dependencyChecks;
    }

    // A delayed denial from a retired Service monitor must not revoke an
    // artifact in the new monitor generation.
    const { promise: previousEntered, resolve: enterPrevious } = Promise.withResolvers();
    const { promise: previousHeld, resolve: releasePrevious } = Promise.withResolvers();
    releaseSourceScan = releasePrevious;
    let oldSignal;
    sharing.withDependencyReadViews = async function (...args) {
      if (!oldSignal) {
        oldSignal = args[2]; enterPrevious(); await previousHeld;
        throw Object.assign(new Error("retired traversal result"), { code: "MEMORY_SHARED_SOURCE_REVOKED" });
      }
      return readViews.apply(this, args);
    };
    const retired = ui.reconcileSources();
    await previousEntered;
    ui.attachLifecycle();
    assert.equal(oldSignal.aborted, true);
    await ui.reconcileSources();
    releaseSourceScan(); await retired;
    assert.equal(service.chatUiStore.revision(owner, ref.artifactId, 1).status, "ready");
    assert.ok(ui.leases.has(opened.leaseId));
    sharing.withDependencyReadViews = readViews;

    // Hold the next notification's async proof. A direct write still has to
    // reject expired authority before its state transaction can be committed.
    const { promise: staleScan, resolve: enterStaleScan } = Promise.withResolvers();
    const { promise: staleHeld, resolve: releaseStaleScan } = Promise.withResolvers();
    releaseSourceScan = releaseStaleScan;
    sharing.withDependencyReadViews = async function (...args) {
      enterStaleScan(); await staleHeld;
      return readViews.apply(this, args);
    };
    const backgroundCheck = ui.reconcileSources();
    await staleScan;
    const ownerFile = path.join(service.memoryEngine.store.workspace(sourceId), hit.canonicalRelativePath);
    const originalSource = fs.readFileSync(ownerFile, "utf8");
    fs.writeFileSync(ownerFile, originalSource.replace("aquamarine", "amber"));
    await assert.rejects(ui.handle("chat.ui.state.save", { profileId: reader, sessionKey: session.sessionKey,
      leaseId: opened.leaseId, baseStateRevision: 0, patch: { selected: "C" } }), { code: "UI_SOURCE_EXPIRED" });
    assert.notEqual(service.chatUiStore.revision(owner, ref.artifactId, 1).state.selected, "C");
    fs.writeFileSync(ownerFile, originalSource);
    releaseSourceScan(); await backgroundCheck;
    sharing.withDependencyReadViews = readViews; releaseSourceScan = null;
    await service.memoryEngine.delete({ profileId: sourceId, id: item.id, reason: "forgotten", operationId: "borrowed-ui-source-delete" });
    await waitUntil(() => service.chatUiStore.revision(owner, ref.artifactId, 1).status === "revoked", 5000, "UI dependency revoked");
    await Promise.allSettled([...service.chatUiController.pendingLifecycle]);
    await waitUntil(() => service.workRunCoordinator.getRun(receipt.runId)?.status === "canceled", 5000, "UI queued input canceled");
    assert.throws(()=>service.chatUiController.handle("chat.ui.read", { profileId: reader, sessionKey: session.sessionKey, leaseId: opened.leaseId, offset: 0 }), { code: "UI_SOURCE_EXPIRED" });
    assert.equal(fs.existsSync(path.join(f.paths.agentsDir, reader, "chat-ui", "objects", rev.htmlHash + ".html")), false);
    const uiJournal = fs.readFileSync(path.join(f.paths.agentsDir, reader, "chat-ui", session.id, "journal.jsonl"), "utf8");
    assert.equal(uiJournal.includes(FACT), false); assert.equal(service.chatUiStore.getOperation(owner, { actionRequestId: params.actionRequestId }).sendEnvelope, null);
    const totalRuns = service.productStore.listWorkRuns().length, root = f.root, transport = f.transport;
    await host.stop(); host = null; authority.close(); authority = null; await f.close({ remove: false });
    f = await openHandoffFixture({ root, transport, serviceOptions: options });
    assert.equal(f.service.chatUiStore.revision(owner, ref.artifactId, 1).status, "revoked");
    const observed = f.service.chatUiController.handle("chat.ui.operation.get", { profileId: reader, sessionKey: session.sessionKey, actionRequestId: params.actionRequestId });
    assert.equal(observed.runId, receipt.runId); assert.equal(observed.status, "cancelled"); assert.equal(f.service.productStore.listWorkRuns().length, totalRuns);
    assert.throws(()=>f.service.chatUiController.assertOperationCurrent({ operationId: receipt.operationId, sessionKey: session.sessionKey, prompt: "forged reassembly" }), { code: "UI_SOURCE_EXPIRED" });
  } finally { releaseSourceScan?.(); authority?.close(); await host?.stop(); await f.close(); }
});
