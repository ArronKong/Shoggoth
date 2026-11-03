"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { resolveRuntimePermissionMode, adapterPermissionMode } = require("../app/agent-service/runtime-permission-modes");

test("group sessions persist Full access for every installed native Runtime while private chats retain their defaults", async t => {
  const f = await openHandoffFixture({ builtinCliProfiles: true });
  f.service.groupChatDriver.stop();
  t.after(() => f.close());
  const executor = f.service.groupChatDriver.executor;
  const sessions = f.service.chatSessionStore;
  const profilesBefore = f.service.productStore.listAgentProfiles();
  const privateChat = (await f.service.chatServiceController.handle("chat.session.create", {
    profileId: f.profile.id, operationId: "private-default", workspace: f.workspace, createdAt: Date.now(),
  })).session;
  assert.equal(privateChat.permissionMode, "auto-review");
  for (const runtime of ["codex", "grok-build", "antigravity", "pi", "opencode", "deepseek-harness"]) {
    const profile = profilesBefore.find(p => p.runtime === runtime);
    assert.ok(profile, runtime);
    const binding = { groupId: crypto.randomUUID(), memberId: crypto.randomUUID(), threadId: crypto.randomUUID(),
      purpose: "group_discussion", profileId: profile.id, workspace: f.workspace };
    const sessionKey = await executor.ensureSession(binding);
    assert.equal(sessions.getSession(sessionKey).permissionMode, "full-access", runtime);
    const revision = sessions.getSession(sessionKey).revision;
    assert.equal(await executor.ensureSession({ ...binding, sessionKey }), sessionKey);
    assert.equal(sessions.getSession(sessionKey).revision, revision, "already-full sessions avoid a redundant write");
    // Existing group sessions may have a legacy null or a prior explicit mode.
    for (const previous of [null, "auto-review", "request-approval"]) {
      if (previous === null) {
        const legacy = sessions.createSession({ operationId: `legacy-${runtime}`, profileId: profile.id,
          workspace: f.workspace, createdAt: Date.now() });
        const result = await executor.ensureSession({ ...binding, sessionKey: legacy.sessionKey });
        assert.equal(sessions.getSession(result).permissionMode, "full-access");
        continue;
      }
      sessions.setPermissionMode(sessionKey, previous);
      const run = await executor.start({ sessionKey, operationId: `permission-${runtime}-${previous}`, prompt: "Synthetic permission check" });
      await f.service.workRunCoordinator.waitForIdle(run.id);
      const contract = f.service.workRunCoordinator.runExecutionContracts.get(run.id);
      const expected = resolveRuntimePermissionMode(runtime, "full-access", profile.permissionPolicy);
      assert.equal(contract.permissionMode, "full-access", runtime);
      assert.deepEqual(contract.permissionPolicy, expected.permissionPolicy, runtime);
      assert.equal(contract.permissionPolicy.sandbox, "danger-full-access");
      const host = f.transport.hosts.get(runtime);
      assert.equal(host.lastTurnStartParams.permissionMode, runtime === "codex" ? undefined : adapterPermissionMode(runtime, "full-access"));
      // Saving another next-turn preference cannot change this running contract.
      sessions.setPermissionMode(sessionKey, "request-approval");
      assert.equal(contract.permissionMode, "full-access");
      await f.complete(f.service.workRunCoordinator.getRun(run.id));
    }
  }
  assert.equal(sessions.getSession(privateChat.sessionKey).permissionMode, "auto-review");
  assert.deepEqual(f.service.productStore.listAgentProfiles(), profilesBefore, "group defaults never rewrite Agent policy");
});
