"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { DEFAULT_RUNTIME_FRAMEWORK_FLAGS } = require("../app/agent-service/runtime-framework-flags");
const { createAgentRuntimeBindingController } = require("../app/agent-service/agent-runtime-binding-controller");
const { createAuthorityBackup, verifyAuthorityBackup, restoreAuthorityBackup } = require("../app/agent-service/authority-backup");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { JsonlProductStore } = require("../app/agent-service/product-store");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { TranscriptStore } = require("../app/agent-service/transcript-store");

test("all flags can be disabled after handoff without downgrading schemas, moving sessions or losing history", async () => {
  const f = await openHandoffFixture();
  try {
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, "rollback-before"), "Original conversation");
    await f.switch(session.sessionKey, "pi");
    await f.complete(await f.send(session.sessionKey, "rollback-pi"), "Continued conversation");
    const before = f.service.chatSessionStore.getSession(session.sessionKey);
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...DEFAULT_RUNTIME_FRAMEWORK_FLAGS } });
    const state = await f.controller.handle("chat.session.runtime.get", {
      profileId: f.profile.id, sessionKey: session.sessionKey,
    });
    assert.equal(state.canSwitch, false);
    await assert.rejects(f.switch(session.sessionKey, "codex"), { code: "SESSION_RUNTIME_DISABLED" });
    const bindings = createAgentRuntimeBindingController({ productStore: f.service.productStore,
      chatSessionStore: f.service.chatSessionStore, getNativeRuntimeConfig: () => f.service.nativeRuntimeConfig.read() });
    const listed = bindings.handle("agent.binding.list", { profileId: f.profile.id });
    assert.equal(listed.canAdd, false);
    assert.equal(listed.bindings.length, 3);
    assert.throws(() => bindings.handle("agent.binding.add", { profileId: f.profile.id,
      operationId: "disabled-binding", revision: listed.revision,
      spec: { runtime: "pi", runtimeAccountId: f.binding("pi").runtimeAccountId } }),
    { code: "AGENT_BINDING_FEATURE_DISABLED" });
    const next = await f.send(session.sessionKey, "rollback-after");
    assert.equal(next.runtimeSessionRef.runtime, "pi");
    assert.equal(next.runtimeSessionRef.sessionId, before.runtimeSessionId);
    await f.complete(next, "Flags off continuation");
    assert.equal(f.service.workRunCoordinator.getRuntimeContext(before), null);
    const after = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(after.runtimeBindingId, before.runtimeBindingId);
    assert.deepEqual(after.retiredRuntimeSessions, before.retiredRuntimeSessions);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.paths.stateDir, "chat-sessions.json"))).version, 8);
    assert.equal(f.service.productStore.getAgentRuntimeBindings(f.profile.id).bindings.length, 3);
  } finally { await f.close(); }
});

test("verified authority backup restores Product15, Chat8 and complete transcript into a new isolated directory", async () => {
  const f = await openHandoffFixture();
  let restoredProduct, restoredChat, restoredTranscript;
  try {
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, "backup-before"), "Before switching");
    await f.switch(session.sessionKey, "pi");
    await f.complete(await f.send(session.sessionKey, "backup-after"), "After switching");
    const profiles = f.service.productStore.listAgentProfiles();
    const runs = f.service.productStore.listWorkRuns();
    const sessions = f.service.chatSessionStore.listSessions();
    const events = f.service.transcriptStore.listEvents(f.profile.id, session.id);
    await f.close({ remove: false });
    const backupId = "runtime-v23-rollback-drill";
    const backup = createAuthorityBackup({ paths: f.paths, backupId });
    assert.equal(verifyAuthorityBackup({ paths: f.paths, backupId }).manifest.rootDigest, backup.manifest.rootDigest);
    const destinationStateDir = path.join(f.root, "restored-state");
    const restored = restoreAuthorityBackup({ paths: f.paths, backupId, destinationStateDir });
    assert.equal(restored.rootDigest, backup.manifest.rootDigest);
    assert.throws(() => restoreAuthorityBackup({ paths: f.paths, backupId, destinationStateDir }),
      { code: "BACKUP_RESTORE_TARGET_EXISTS" });
    const paths = resolveServicePaths({ trustedRoot: f.root, stateRoot: destinationStateDir,
      profileRoot: path.join(f.root, "restored-profile"), cacheRoot: path.join(f.root, "restored-cache") });
    restoredProduct = new JsonlProductStore({ paths }); restoredProduct.open();
    restoredChat = new ChatSessionStore({ paths, getProfileBinding: (profileId, bindingId) => {
      const profile = restoredProduct.getAgentProfile(profileId);
      return restoredProduct.getAgentRuntimeBinding(profileId, bindingId ?? profile.defaultBindingId);
    } }); restoredChat.open();
    restoredTranscript = new TranscriptStore({ paths }); restoredTranscript.open();
    assert.deepEqual(restoredProduct.listAgentProfiles(), profiles);
    assert.deepEqual(restoredProduct.listWorkRuns(), runs);
    assert.deepEqual(restoredChat.listSessions(), sessions);
    assert.deepEqual(restoredTranscript.listEvents(f.profile.id, session.id), events);
    assert.equal(JSON.parse(fs.readFileSync(path.join(destinationStateDir, "state.snapshot.json"))).schemaVersion, 15);
    assert.equal(JSON.parse(fs.readFileSync(path.join(destinationStateDir, "chat-sessions.json"))).version, 8);
  } finally {
    restoredTranscript?.close(); restoredChat?.close(); restoredProduct?.close();
    await f.close();
  }
});
