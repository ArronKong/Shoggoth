#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { fixture, declaration, safeStorage } = require("./native-chat-ui-service-unit.cjs");
const { actionFixture } = require("./native-chat-ui-action-unit.cjs");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { createDesktopChatUiAuthority } = require("../app/desktop-chat-ui-authority");
const { createFederationHostServer } = require("../app/federation-host-server");
const { createAuthorityBackup, restoreAuthorityBackup } = require("../app/agent-service/authority-backup");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ChatUiStore } = require("../app/agent-service/chat-ui-store");
const { loadChatUiResources } = require("../app/native-chat-ui-resources");
const c = require("../app/agent-service/chat-ui-contract");
test("authority backup preserves canonical UI/state/receipt and excludes disposable ports, previews and writer lease", async () => {
  const f = await actionFixture({ memoryCore: false }); let restored;
  try {
    const params = f.spec(), receipt = await f.send(params), session = f.service.chatSessionStore.getSession(f.owner.sessionKey);
    await f.ipc("chat.ui.state.save", { ...f.owner, leaseId: f.opened.leaseId, baseStateRevision: 1, patch: { selected: "C" } });
    await f.close();
    const base = path.join(f.paths.agentsDir, f.owner.profileId, "chat-ui");
    for (const dir of ["previews", "leases", "ports"]) { fs.mkdirSync(path.join(base, dir), { mode: 0o700 }); fs.writeFileSync(path.join(base, dir, "disposable"), "not authority", { mode: 0o600 }); }
    const backup = createAuthorityBackup({ paths: f.paths, backupId: "native-ui-authority" }), entries = backup.manifest.entries.map(row => row.path);
    assert(entries.some(name => name.endsWith("/journal.jsonl"))); assert(entries.some(name => name.endsWith("/" + f.opened.part.artifactId) || name.endsWith(".html")));
    assert.equal(entries.some(name => /chat-ui.writer.lock|chat-ui\/(?:previews|leases|ports)(?:\/|$)/.test(name)), false);
    const destinationStateDir = path.join(f.root, "restored-state");
    const restore = restoreAuthorityBackup({ paths: f.paths, backupId: "native-ui-authority", destinationStateDir });
    assert.deepEqual(restore.chatUiRestore, { invalidatedSessions: 1, preservedOperations: 1 });
    const paths = resolveServicePaths({ stateRoot: destinationStateDir, cacheRoot: path.join(f.root, "restore-cache"), profileRoot: path.join(f.root, "restore-profile"), trustedRoot: f.root });
    restored = createAgentService({ paths, safeStorage, memoryCore: false }); await restored.start();
    const ctrl = restored.chatUiController, reference = { ...f.reference(f.part), mountId: "restored-ui" };
    const opened = await ctrl.open(reference); assert.notEqual(opened.leaseId, f.opened.leaseId); assert.equal(opened.state.selected, "C"); assert.equal(opened.stateRevision, 2);
    assert.equal(opened.readOnly, true); assert.equal(opened.readOnlyReason, "UI_SOURCE_EXPIRED");
    await assert.rejects(ctrl.handle("chat.ui.state.save", { ...f.owner, leaseId: opened.leaseId, baseStateRevision: 2, patch: { selected: "A" } }), { code: "UI_SOURCE_EXPIRED" });
    const bytes = ctrl.handle("chat.ui.read", { ...f.owner, leaseId: opened.leaseId, offset: 0 }); assert.equal(bytes.htmlHash, backup.manifest.entries.find(row => row.path.endsWith(".html")).path.split("/").at(-1).slice(0,-5));
    const query = ctrl.handle("chat.ui.operation.get", { ...f.owner, actionRequestId: params.actionRequestId }); assert.equal(query.operationId, receipt.operationId); assert.equal(query.runId, receipt.runId); assert.equal(query.status, "cancelled"); assert.equal(query.errorCode, null);
    assert.equal(restored.productStore.listWorkRuns().length, 2); assert.equal(restored.chatUiController.leases.has(f.opened.leaseId), false);
    const source = restored.transcriptStore.getEvent(f.owner.profileId, session.id, f.part.sourceEventId); assert.equal(source.content.uiArtifact.sourceEventId, f.part.sourceEventId);
  } finally { await restored?.stop(); await f.remove(); }
});
test("restoring an older queued UI snapshot after real completion never admits its native turn again", { timeout: 30000 }, async () => {
  const options = { memoryCore: false }; let f, restored, host, authority, root;
  const waitFor = async (condition, message) => {
    const deadline = Date.now() + 6000;
    while (!condition()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    f = await openHandoffFixture({ serviceOptions: options }); root = f.root;
    const service = f.service; service.chatUiConfig.apply({ revision: 1, config: { nativeChatUiV1: true } });
    const session = f.createSession(), producer = await f.send(session.sessionKey, "restore-ui-producer");
    assert.equal(producer.status, "running");
    fs.writeFileSync(path.join(f.workspace, "card.html"), "<!doctype html><h1>Restore barrier</h1>");
    const lease = service.workRunCoordinator.runCapabilityLeases.get(producer.id), scope = { runId: producer.id,
      assertCurrent: () => service.workRunCoordinator.hostCapabilityIssuer.assert(lease, { kind: "mcp", identity: { runId: producer.id } }) };
    const published = await service.mcpProductToolController.handle("render_ui", declaration(), { profileId: f.profile.id, callId: crypto.randomUUID() }, scope);
    const owner = { profileId: f.profile.id, sessionKey: session.sessionKey }, reference = { ...owner, artifactId: published.part.artifactId,
      revision: 1, sourceEventId: published.part.sourceEventId };
    authority = createDesktopChatUiAuthority(); host = createFederationHostServer({ paths: f.paths,
      registry: { getStatus: async () => [], getBackend: () => null }, verifyChatUiClick: value => authority.consume(value) }); await host.start();
    const opened = await service.chatUiController.open({ ...reference, mountId: "before-backup" });
    const params = { ...owner, leaseId: opened.leaseId, actionRequestId: "restore-ui-click", actionId: "continue", stateRevision: 0, snapshot: { selected: "B" } };
    const receipt = await service.chatUiController.action({ ...params, hostProof: authority.issue(params, () => true) });
    assert.equal(receipt.status, "queued");
    await host.stop(); host = null; authority.close(); authority = null;
    const transport = f.transport, sourcePaths = f.paths;
    await f.close({ remove: false });
    createAuthorityBackup({ paths: sourcePaths, backupId: "before-ui-completion" });
    f = await openHandoffFixture({ root, transport, serviceOptions: options });
    await waitFor(() => f.service.workRunCoordinator.getRun(receipt.runId)?.status === "running", "original queued UI must enter the existing native Runtime");
    const admitted = f.service.workRunCoordinator.getRun(receipt.runId); assert(admitted.runtimeTurnRef);
    await f.complete(admitted, "UI task actually completed after snapshot");
    assert.equal(f.service.chatUiController.handle("chat.ui.operation.get", { ...owner, actionRequestId: params.actionRequestId }).status, "completed");
    const turnCount = [...transport.hosts.values()].reduce((sum, value) => sum + value.turnStartCalls, 0);
    assert.equal(turnCount, 2); await f.close({ remove: false });
    const restoreRoot = path.join(root, "restored-ui");
    const restore = restoreAuthorityBackup({ paths: sourcePaths, backupId: "before-ui-completion", destinationStateDir: path.join(restoreRoot, "state") });
    assert.deepEqual(restore.chatUiRestore, { invalidatedSessions: 1, preservedOperations: 1 });
    restored = await openHandoffFixture({ root: restoreRoot, transport, serviceOptions: options });
    await restored.service.workRunCoordinator.waitForIdle(receipt.runId);
    const query = restored.service.chatUiController.handle("chat.ui.operation.get", { ...owner, actionRequestId: params.actionRequestId });
    assert.equal(query.operationId, receipt.operationId); assert.equal(query.runId, receipt.runId);
    assert.equal(query.status, "cancelled"); assert.equal(query.errorCode, null);
    assert.equal(restored.service.workRunCoordinator.inbox.get(receipt.operationId).state, "canceled");
    const readOnly = await restored.service.chatUiController.open({ ...reference, mountId: "after-restore" });
    assert.equal(readOnly.readOnly, true); assert.equal(readOnly.state.selected, "B"); assert.equal(readOnly.stateRevision, 1);
    assert.equal(restored.service.productStore.listWorkRuns().length, 2);
    assert.equal([...transport.hosts.values()].reduce((sum, value) => sum + value.turnStartCalls, 0), turnCount);
  } finally {
    authority?.close(); await host?.stop(); await restored?.close({ remove: false }); await f?.close({ remove: false });
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});
test("state/read flood is rate limited before heavy reads while ordinary Service remains healthy", async () => {
  const f = await fixture(); try {
    const part = (await f.call("render_ui", declaration())).part, opened = await f.ipc("chat.ui.open", { ...f.reference(part), mountId: "flood" });
    const lease = f.service.chatUiController.leases.get(opened.leaseId); lease.rateSince = Date.now() + 5000;
    const replies = await Promise.allSettled(Array.from({ length: 50 }, () => f.ipc("chat.ui.read", { ...f.owner, leaseId: opened.leaseId, offset: 0 })));
    assert.equal(replies.filter(row => row.status === "fulfilled").length, c.LIMITS.requestsPerSecond);
    assert(replies.filter(row => row.status === "rejected").every(row => row.reason.code === "UI_RATE_LIMITED"));
    assert.equal((await f.ipc("service.status", {})).healthy, true); assert.equal(f.service.productStore.listWorkRuns().length, 1);
  } finally { await f.remove(); }
});
test("fixed offline resources verify hashes and refuse missing, altered or incompatible bundles", () => {
  const resources = loadChatUiResources(); assert.equal(resources.bundleId, "native-chat-ui-v1"); assert(resources.stylesheet.length > 0);
  const files = new Map(); const directory = "/native-ui-offline";
  files.set(path.join(directory, "manifest.json"), JSON.stringify(resources.manifest)); files.set(path.join(directory, "visualize.css"), Buffer.from(resources.stylesheet));
  const read = (name, encoding) => { const bytes = files.get(name); if (!bytes) throw Object.assign(Error("missing"), { code: "ENOENT" }); return encoding ? String(bytes) : Buffer.from(bytes); };
  assert.deepEqual(loadChatUiResources({ directory, read }).manifest, resources.manifest);
  files.set(path.join(directory, "visualize.css"), Buffer.from("altered")); assert.throws(() => loadChatUiResources({ directory, read }), { code: "UI_RESOURCE_UNAVAILABLE" });
  files.delete(path.join(directory, "visualize.css")); assert.throws(() => loadChatUiResources({ directory, read }), { code: "UI_RESOURCE_UNAVAILABLE" });
  files.set(path.join(directory, "manifest.json"), JSON.stringify({ ...resources.manifest, bridgeApiVersion: 999 })); assert.throws(() => loadChatUiResources({ directory, read }), { code: "UI_RESOURCE_UNAVAILABLE" });
});
for (const fault of ["fsync", "rename"]) test(`actual ${fault} failure gives no successful state receipt and recovers one complete journal value`, () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sguifault-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile"), trustedRoot: root });
  const owner = { profileId: "fault-profile", transcriptSessionId: "fault-transcript", sessionKey: "fault-session" }, injected = Object.create(fs), fdPaths = new Map(); let armed = false, failed = false, store;
  injected.openSync = (...args) => { const fd = fs.openSync(...args); fdPaths.set(fd, args[0]); return fd; };
  injected.closeSync = fd => { fdPaths.delete(fd); return fs.closeSync(fd); };
  injected.fsyncSync = fd => { if (armed && !failed && fault === "fsync" && String(fdPaths.get(fd)).endsWith("journal.jsonl")) { failed = true; throw Object.assign(Error("fsync failed"), { code: "EIO" }); } return fs.fsyncSync(fd); };
  injected.renameSync = (from, to) => { if (armed && !failed && fault === "rename" && to.endsWith("manifest.json")) { failed = true; throw Object.assign(Error("rename failed"), { code: "EIO" }); } return fs.renameSync(from, to); };
  try {
    store = new ChatUiStore({ paths, fs: injected }); store.open();
    const pub = store.preparePublication({ owner, callId: "fault-publish", fingerprint: c.hash("fault-publish"), tool: "render_ui", declaration: declaration(), html: "<!doctype html><p>immutable reference</p>", creatorRunId: "fault-run", creatorAttemptId: "fault-attempt", provenance: {} });
    const rev = store.markPublicationReady(owner, pub.publicationId, 1); armed = true;
    assert.throws(() => store.saveState(owner, rev.artifactId, 1, 0, { selected: "B" }), { code: "UI_COMMIT_UNCERTAIN" }); assert(failed);
    assert.throws(() => store.revision(owner, rev.artifactId, 1), { code: "UI_COMMIT_UNCERTAIN" }); store.close(); armed = false;
    store = new ChatUiStore({ paths, fs: injected }); store.open(); const restored = store.revision(owner, rev.artifactId, 1);
    assert(["A", "B"].includes(restored.state.selected)); assert.equal(restored.stateRevision, restored.state.selected === "B" ? 1 : 0);
    assert.equal(store.readObject(owner, restored).htmlHash, rev.htmlHash);
  } finally { store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
