"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { validateChatServiceParams } = require("../app/agent-service/chat-service-protocol");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");

test("create protocol accepts a parent identity but rejects raw settings and invalid identities", () => {
  const params = { operationId: "create-child", profileId: "profile-1", workspace: null, createdAt: 100,
    parentSessionKey: "11111111-1111-4111-8111-111111111111" };
  assert.doesNotThrow(() => validateChatServiceParams("chat.session.create", params));
  for (const patch of [{ parentSessionKey: "bad" }, { parentSessionKey: null }, { model: "gpt-5.5" },
    { modelSettings: { thinkingLevel: "low", serviceTier: null } }]) {
    assert.throws(() => validateChatServiceParams("chat.session.create", { ...params, ...patch }), { code: "INVALID_PARAMS" });
  }
});

test("backend and Service inherit the authoritative selection, even with an explicit workspace", async () => {
  const f = await startInspirationFixture({ agentCount: 2 });
  try {
    const profile = f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    const parent = f.service.chatSessionStore.listSessions().find(item => item.profileId === profile.id);
    f.service.chatSessionStore.setModelOverride(parent.sessionKey, "gpt-5.5");
    f.service.chatSessionStore.setModelSettings(parent.sessionKey, { thinkingLevel: "low", serviceTier: null });
    const parentKey = `agent:${profile.agentId}:${parent.sessionKey}`;
    const childKey = await f.backend.createSession(profile.agentId, { parentSessionKey: parentKey,
      workspace: f.root, model: "ignored-stale-ui-model", modelProvider: "ignored-stale-ui-provider" });
    const child = f.service.chatSessionStore.getSession(childKey.split(":").at(-1));
    assert.equal(child.modelOverride, "gpt-5.5");
    assert.equal(child.modelSettings.thinkingLevel, "low");
    assert.equal(child.runtimeBindingId, parent.runtimeBindingId);
    assert.equal(child.runtimeSessionId, null);
    assert.equal(child.workspace, f.root);
    const other = f.service.productStore.listAgentProfiles().find(item => item.id !== profile.id);
    const count = f.service.chatSessionStore.listSessions().length;
    await assert.rejects(f.backend.createSession(other.agentId, { parentSessionKey: parentKey, workspace: f.root }),
      { code: "CHAT_SESSION_INVALID" });
    await assert.rejects(f.ipc("chat.session.create", { operationId: "foreign-child", profileId: other.id,
      parentSessionKey: parent.sessionKey, workspace: f.root, createdAt: Date.now() }), { code: "CHAT_SESSION_INVALID" });
    assert.equal(f.service.chatSessionStore.listSessions().length, count);
  } finally { await f.close(); }
});

test("a fresh session atomically inherits binding, model and effort without sharing runtime history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-inherit-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const binding = (id, profileId = "profile-1") => ({ id, profileId, enabled: true, runtime: id === "pi-binding" ? "pi" : "codex" });
  const options = { paths, now: () => 100, getProfileBinding: (profileId, id) => binding(id ?? "default-codex", profileId) };
  let store = new ChatSessionStore(options);
  try {
    store.open();
    const parent = store.createSession({ operationId: "create-parent", profileId: "profile-1", workspace: "/tmp/project",
      createdAt: 100, defaultBindingId: "pi-binding" });
    store.setModelOverride(parent.sessionKey, "xiaomi/mimo-v2.6-flash");
    assert.deepEqual(store.getSession(parent.sessionKey).modelSettings, { thinkingLevel: null, serviceTier: null },
      "selecting a model must initialize its own defaults rather than inherit CLI overrides");
    store.setModelSettings(parent.sessionKey, { thinkingLevel: "low", serviceTier: "priority" });
    const input = { operationId: "create-child", profileId: "profile-1", workspace: "/tmp/child", createdAt: 100,
      parentSessionKey: parent.sessionKey };
    const child = store.createSession(input);
    assert.equal(child.runtimeBindingId, "pi-binding");
    assert.equal(child.modelOverride, "xiaomi/mimo-v2.6-flash");
    assert.deepEqual(child.modelSettings, { thinkingLevel: "low", serviceTier: "priority" });
    assert.equal(child.runtimeSessionId, null);
    assert.equal(child.status, "draft");
    assert.deepEqual(child.retiredRuntimeSessions, []);
    assert.equal(child.permissionMode, null);
    store.setModelOverride(parent.sessionKey, "xiaomi/mimo-v2.6-pro");
    assert.deepEqual(store.createSession(input), child, "a replay must keep the initial choices");
    const count = store.listSessions().length;
    assert.throws(() => store.createSession({ ...input, operationId: "create-foreign", profileId: "profile-other" }),
      { code: "CHAT_SESSION_INVALID" });
    assert.equal(store.listSessions().length, count);
    store.close();
    store = new ChatSessionStore(options);
    store.open();
    assert.deepEqual(store.getSession(child.sessionKey), child, "choices must survive a restart");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
