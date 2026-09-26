"use strict";
const assert = require("node:assert/strict");
const { randomUUID: id } = require("node:crypto");
const { test } = require("node:test");
const { fixture } = require("./fixtures/inspiration-coordinator-fixture.cjs");
const { createChatServiceController } = require("../app/agent-service/chat-service-controller");
const { modelCapabilities } = require("../app/agent-service/chat-model-settings");
const { validateProfileServiceResult } = require("../app/agent-service/profile-service-protocol");
const { validateChatServiceParams } = require("../app/agent-service/chat-service-protocol");
const { PendingCommandInbox } = require("../app/agent-service/pending-command-inbox");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { computeCatalogRevision } = require("../app/core/model-catalog-revision");
const { normalizeSession, CHAT_SESSION_STORE_VERSION } = require("../app/agent-service/chat-session-store");
const model = { id: "catalog-model", displayName: "Catalog model", description: "", isDefault: true,
  capabilities: { thinkingOptions: ["low", "medium", "high", "ultra"], thinkingDefault: "medium", fastTier: "fast" } };
const page = { models: [model], nextCursor: null, hasMore: false };
const makeSession = (f, profileId = f.profile.id) => f.sessions.createSession({
  operationId: id(), profileId, workspace: f.root, createdAt: Date.now(),
});
async function controllerFor(t, f, extra = {}) {
  const controller = createChatServiceController({ paths: f.paths, productStore: f.productStore,
    chatSessionStore: f.sessions, coordinator: f.coordinator, transcriptStore: f.transcript,
    cursorSecret: Buffer.alloc(32, 7), listProfileModels: async () => page, ...extra });
  await controller.open(); t.after(() => controller.close()); return controller;
}

test("model catalog retains only runtime-advertised effort and speed capabilities", () => {
  const caps = modelCapabilities({ supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "ultra" }],
    defaultReasoningEffort: "medium", serviceTiers: [{ id: "priority" }] });
  assert.deepEqual(caps, { thinkingOptions: ["medium", "ultra"], thinkingDefault: "medium", fastTier: "priority" });
  assert.deepEqual(modelCapabilities({ model: "gpt-fast-reasoning" }), { thinkingOptions: [], thinkingDefault: null, fastTier: null });
  assert.deepEqual(validateProfileServiceResult("profile.models.list", page), page);
  const revision = options => computeCatalogRevision({ runtime: [{ id: "same-model", ...options }] });
  assert.notEqual(revision({ fast: false }), revision({ fast: true }));
  assert.notEqual(revision({ thinkingOptions: ["high"] }), revision({ thinkingOptions: ["high", "ultra"] }));
  assert.notEqual(revision({ thinkingDefault: "high" }), revision({ thinkingDefault: "medium" }));
  assert.throws(() => validateChatServiceParams("chat.session.settings.set", { sessionKey: id(), patch: { fastMode: "yes" } }), { code: "INVALID_PARAMS" });
});

test("session settings validate the profile catalog, persist across reopen, and reset on model change", async t => {
  const f = await fixture(t), session = makeSession(f), controller = await controllerFor(t, f);
  const set = patch => controller.handle("chat.session.settings.set", { sessionKey: session.sessionKey, patch });
  assert.equal(Object.hasOwn(session, "modelSettings"), false, "legacy session shape remains unchanged");
  const { codexThreadId, ...legacy } = session;
  legacy.runtimeSessionId = codexThreadId; legacy.permissionMode = "default";
  assert.equal(CHAT_SESSION_STORE_VERSION, 5);
  assert.equal(normalizeSession(legacy, false, 4).permissionMode, "default", "version 4 permission choices survive migration");
  assert.throws(() => normalizeSession({ ...legacy, modelSettings: { thinkingLevel: "high", serviceTier: null } }, false, 4),
    { code: "CHAT_SESSION_INVALID" }, "new fields cannot masquerade as a legacy schema");
  await assert.rejects(set({ thinkingLevel: "xhigh" }), { code: "CHAT_SESSION_MODEL_SETTINGS_INVALID" });
  await set({ thinkingLevel: "high" }); await set({ fastMode: true });
  f.sessions.close(); f.sessions.open();
  assert.deepEqual(f.sessions.getSession(session.sessionKey).modelSettings, { thinkingLevel: "high", serviceTier: "fast" });
  await set({ thinkingLevel: null });
  assert.equal(f.sessions.getSession(session.sessionKey).modelSettings.serviceTier, "fast");
  await set({ fastMode: false });
  assert.equal(f.sessions.getSession(session.sessionKey).modelSettings.serviceTier, null);
  f.sessions.setModelOverride(session.sessionKey, "other-model");
  assert.deepEqual(f.sessions.getSession(session.sessionKey).modelSettings, { thinkingLevel: null, serviceTier: null });
  await assert.rejects(set({ thinkingLevel: "high" }), { code: "CHAT_SESSION_MODEL_NOT_AVAILABLE" });
});

test("settings refuse an in-flight run and a model changed during catalog lookup", async t => {
  const f = await fixture(t), session = makeSession(f);
  let busy = false, changeModel = false;
  const controller = await controllerFor(t, f, {
    coordinator: { listRuns: () => busy ? [{ source: "chat", sourceId: session.sessionKey, status: "queued" }] : [],
      getRun() {}, send() {}, subscribeRun() {} },
    listProfileModels: async () => { if (changeModel) f.sessions.setModelOverride(session.sessionKey, "new-model"); return page; },
  });
  busy = true;
  await assert.rejects(controller.handle("chat.session.settings.set", { sessionKey: session.sessionKey, patch: { fastMode: true } }), { code: "THREAD_ACTIVE_TURN_CONFLICT" });
  busy = false; changeModel = true;
  await assert.rejects(controller.handle("chat.session.settings.set", { sessionKey: session.sessionKey, patch: { thinkingLevel: "high" } }), { code: "CHAT_SESSION_NOT_READY" });
  assert.equal(f.sessions.getSession(session.sessionKey).modelSettings, undefined);
});

test("persisted effort and fast settings reach Codex turn/start and inherited effort clears the old override", async t => {
  let f, inbox;
  t.after(async () => { await f?.coordinator.close(); await inbox?.close(); });
  f = await fixture(t);
  inbox = await new PendingCommandInbox({ paths: f.paths, cryptoBroker: {
    async encrypt(bytes) { return Buffer.from(bytes); }, async decrypt(bytes) { return Buffer.from(bytes); },
  } }).open(); f.coordinator.inbox = inbox;
  const session = makeSession(f), inputs = [];
  const start = f.host.turnStart.bind(f.host);
  f.host.turnStart = input => { inputs.push(input); return start(input); };
  f.host.modelList = async () => ({ data: [{ model: "catalog-model", isDefault: true, defaultReasoningEffort: "medium" }], nextCursor: null });
  f.sessions.setModelSettings(session.sessionKey, { thinkingLevel: "high", serviceTier: "fast" });
  const first = await f.coordinator.send({ operationId: id(), sessionKey: session.sessionKey, prompt: "hello" });
  await f.coordinator.waitForIdle(first.run.id);
  assert.equal(inputs[0].effort, "high"); assert.equal(inputs[0].serviceTier, "fast");
  f.host.complete(f.dispatcher.getRun(first.run.id)); await f.coordinator.waitForIdle(first.run.id);
  f.sessions.setModelSettings(session.sessionKey, { thinkingLevel: null, serviceTier: null });
  const second = await f.coordinator.send({ operationId: id(), sessionKey: session.sessionKey, prompt: "again" });
  await f.coordinator.waitForIdle(second.run.id);
  assert.equal(inputs[1].effort, "medium"); assert.equal(inputs[1].serviceTier, null);
});

test("native search returns durable message anchors and filenames, respects profile ownership and limits", async t => {
  const f = await fixture(t), session = makeSession(f), foreign = makeSession(f, "different-profile");
  const controller = await controllerFor(t, f);
  const append = (target, kind, text, attachments) => {
    f.transcript.ensureSession({ profileId: target.profileId, sessionId: target.id });
    const messageId = id();
    f.transcript.appendEvent({ id: messageId, profileId: target.profileId, sessionId: target.id, kind,
      content: { text, ...(attachments ? { attachments } : {}) } }); return messageId;
  };
  append(foreign, "user", "不能泄露 中文需求");
  const first = append(session, "user", "🙂".repeat(45) + "中文需求 alpha");
  append(session, "assistant", "确认 ALPHA 中文需求");
  const fileId = append(session, "user", "", [{ id: id(), name: "附件说明.pdf", mimeType: "application/pdf", size: 5 }]);
  const find = (query, limit = 50) => controller.handle("chat.search", { profileId: f.profile.id, query, limit });
  const result = await find("中文需求");
  assert.equal(result.results.length, 2); assert.equal(result.truncated, false);
  assert.ok(result.results.every(item => item.sessionKey === session.sessionKey && item.snippet.isWellFormed()));
  assert.ok(result.results.some(item => item.messageId === first));
  assert.equal((await find("alpha", 1)).truncated, true);
  assert.equal((await find("附件说明")).results[0].messageId, fileId);
  assert.deepEqual((await find("cannot find")).results, []);
  assert.equal(f.host.turnStarts, 0);
});

test("backend exposes settings and native search through existing generic chat routes", async t => {
  const f = await fixture(t), session = makeSession(f), controller = await controllerFor(t, f);
  const backend = new ShoggothBackend({ paths: f.paths });
  backend._profilesByAgent.set(f.profile.agentId, f.profile);
  backend._sessionsByKey.set(session.sessionKey, session);
  backend._call = (method, params) => controller.handle(method, params);
  const key = `agent:${f.profile.agentId}:${session.sessionKey}`;
  assert.deepEqual(await backend.setSessionThinking(key, { level: "high" }), { level: "high", scope: "session" });
  assert.deepEqual(await backend.setSessionFast(key, { fast: true }), { fast: true, scope: "session" });
  assert.equal(backend._rows[0].thinkingLevel, "high"); assert.equal(backend._rows[0].fastMode, true);
  f.transcript.ensureSession({ profileId: f.profile.id, sessionId: session.id });
  f.transcript.appendEvent({ id: id(), profileId: f.profile.id, sessionId: session.id, kind: "user", content: { text: "native search" } });
  const found = await backend.searchChat(f.profile.agentId, "native", { limit: 100 });
  assert.equal(found.supported, true); assert.equal(found.results[0].key, key);
  assert.equal((await backend.searchChat("other-agent", "native")).supported, false);
});
