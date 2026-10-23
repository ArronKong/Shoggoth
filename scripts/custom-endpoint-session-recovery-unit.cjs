"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { CustomEndpointService } = require("../app/agent-service/custom-endpoint-service");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");

const CUSTOM_MODEL = "anthropic/fixture-custom-model";
const GPT_MODEL = "gpt-fixture";
async function request(f, method, params) {
  return requestService(f.paths, { version: SERVICE_PROTOCOL_VERSION, token: readClientToken(f.paths),
    method, params }, { timeoutMs: 20_000 });
}
async function select(f, sessionKey, model) {
  const session = f.service.chatSessionStore.getSession(sessionKey);
  return request(f, "chat.session.runtime.model.set", { profileId: f.profile.id, sessionKey,
    bindingId: f.binding("codex").id, revision: session.revision, model, acceptAdjustments: true });
}
async function openEndpointFixture({ legacy = false, unreadable = false } = {}) {
  const f = await openHandoffFixture({ catalogs: { codex: ["fixture-model", GPT_MODEL] } });
  try {
    f.service.providerService.protocolValidator = async () => ({ parsedBy: "fixture" });
    f.endpoints = new CustomEndpointService({ productStore: f.service.productStore,
      secretStore: f.service.secretStore, providerService: f.service.providerService,
      profileServiceController: f.service.profileServiceController });
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, "original-history", "PRESERVE ORIGINAL HISTORY"));
    const raw = f.transport.hosts.get("codex");
    raw.modelList = async () => ({ data: ["fixture-model", GPT_MODEL].map((model, index) => ({
      model, displayName: model, description: "", isDefault: index === 0, hidden: false,
      defaultReasoningEffort: "medium" })), nextCursor: null });
    await select(f, session.sessionKey, GPT_MODEL);
    await f.endpoints.save(f.profile.id, { id: "fixture-endpoint", name: "fixture endpoint",
      baseUrl: "https://endpoint.example.invalid/v1", api: "openai-responses",
      models: [CUSTOM_MODEL], apiKey: "fixture-endpoint-secret" });
    await select(f, session.sessionKey, CUSTOM_MODEL);
    if (unreadable) raw.unreadableFreshThreadUntilTurnStart = true;
    const completeBinding = f.service.chatSessionStore.completeBinding;
    if (legacy) {
      // Persist the state written by older builds: session created, binding only
      // completed after turn/start. The local catalog error leaves it pending.
      f.service.chatSessionStore.completeBinding = () => f.service.chatSessionStore.getSession(session.sessionKey);
    }
    let failed;
    try { failed = await f.send(session.sessionKey, "failed-custom-model"); }
    finally { f.service.chatSessionStore.completeBinding = completeBinding; }
    assert.equal(failed.status, "failed", failed.errorCode);
    assert.equal(failed.errorCode, "RUNTIME_MODEL_CATALOG_INVALID");
    assert.equal(raw.turnStartCalls, 1, "custom preflight failed before any new native turn");
    await f.endpoints.remove(f.profile.id, "fixture-endpoint");
    assert.equal(f.service.productStore.getAgentProfile(f.profile.id).providerRef, null);
    assert.equal(f.service.productStore.getAgentProfile(f.profile.id).defaultModel, null);
    assert.deepEqual(f.service.productStore.listModelProviders(), []);
    return { f, session, raw, failed };
  } catch (error) { await f.close(); throw error; }
}

test("failed custom-model turn retains a completed native session binding and permits GPT selection after endpoint deletion", async () => {
  const { f, session, raw, failed } = await openEndpointFixture();
  try {
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).status, "ready");
    assert.equal(f.service.chatSessionStore.getBinding(session.sessionKey).state, "bound");
    const starts = raw.threadStartCalls, turns = raw.turnStartCalls, resumes = raw.resumeCalls;
    const selected = await select(f, session.sessionKey, GPT_MODEL);
    assert.equal(selected.model, GPT_MODEL);
    const saved = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(saved.status, "draft");
    assert.equal(saved.runtimeSessionId, null);
    assert.equal(saved.id, session.id);
    assert.equal(saved.retiredRuntimeSessions.length, 2);
    assert.equal(raw.threadStartCalls, starts);
    assert.equal(raw.turnStartCalls, turns);
    assert.equal(raw.resumeCalls, resumes, "model selection must not resume or resend the failed request");
    await f.send(session.sessionKey, "failed-custom-model");
    assert.equal(raw.turnStartCalls, turns, "the failed operation stays idempotent");
    assert.equal(f.service.workRunCoordinator.getRun(failed.id).status, "failed");
    const next = await f.send(session.sessionKey, "explicit-gpt-send");
    assert.equal(next.status, "running", next.errorCode);
    assert.equal(raw.lastTurnStartParams.model, GPT_MODEL);
    assert.equal(raw.lastTurnStartParams.effort, "medium");
    await f.complete(next, "GPT ANSWER");
    const events = f.service.transcriptStore.listEvents(session.profileId, session.id);
    assert.ok(events.some(event => event.content?.text === "PRESERVE ORIGINAL HISTORY"));
    assert.ok(events.some(event => event.content?.text === "GPT ANSWER"));
  } finally { await f.close(); }
});

for (const unreadable of [false, true]) {
  test("legacy pending custom-model binding is reconciled by observation without dispatch; unreadable=" + unreadable, async () => {
    const { f, session, raw } = await openEndpointFixture({ legacy: true, unreadable });
    try {
      assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).status, "binding");
      const pending = f.service.chatSessionStore.getBinding(session.sessionKey);
      const native = raw.threads.find(thread => thread.threadSource === pending.threadSource);
      assert.ok(native);
      const counts = [raw.threadStartCalls, raw.turnStartCalls, raw.resumeCalls];
      await select(f, session.sessionKey, GPT_MODEL);
      const saved = f.service.chatSessionStore.getSession(session.sessionKey);
      assert.equal(saved.status, "draft");
      assert.equal(saved.modelOverride, GPT_MODEL);
      assert.equal(saved.retiredRuntimeSessions.at(-1).runtimeSessionId, native.id);
      assert.equal(f.service.chatSessionStore.getBinding(session.sessionKey), null);
      assert.deepEqual([raw.threadStartCalls, raw.turnStartCalls, raw.resumeCalls], counts);
      assert.ok(f.service.transcriptStore.listEvents(session.profileId, session.id)
        .some(event => event.content?.text === "PRESERVE ORIGINAL HISTORY"));
    } finally { await f.close(); }
  });
}

test("complete absence of a pending native session permits recovery without creating a session", async () => {
  const f = await openHandoffFixture({ catalogs: { codex: [GPT_MODEL] } });
  try {
    const session = f.createSession();
    f.service.chatSessionStore.requestBinding(session.sessionKey, "fixture-missing-binding", Date.now());
    await select(f, session.sessionKey, GPT_MODEL);
    const saved = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(saved.status, "draft");
    assert.equal(saved.modelOverride, GPT_MODEL);
    const raw = f.transport.hosts.get("codex");
    assert.equal(raw.threadStartCalls, 0);
    assert.equal(raw.turnStartCalls, 0);
    assert.equal(raw.resumeCalls, 0);
  } finally { await f.close(); }
});

for (const condition of ["list-failed", "partial-history", "active-native-turn", "acceptance-unknown"]) {
  test("unconfirmed pending binding remains intact with a specific public error: " + condition, async () => {
    const { f, session, raw, failed } = await openEndpointFixture({ legacy: true });
    try {
      const before = f.service.chatSessionStore.getSession(session.sessionKey);
      const binding = f.service.chatSessionStore.getBinding(session.sessionKey);
      const native = raw.threads.find(thread => thread.threadSource === binding.threadSource);
      if (condition === "list-failed") raw.threadList = async () => { throw new Error("private upstream diagnostic"); };
      if (condition === "partial-history") native.turns = [{ id: "partial", status: "completed", itemsView: "summary", items: [] }];
      if (condition === "active-native-turn") native.turns = [{ id: "active", status: "inProgress", items: [] }];
      if (condition === "acceptance-unknown") f.service.productStore.putWorkRun({ ...failed, eventSeq: failed.eventSeq + 1, errorCode: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
      await assert.rejects(select(f, session.sessionKey, GPT_MODEL), error =>
        error.code === "CHAT_RUNTIME_SWITCH_PENDING" && !error.message.includes("private upstream diagnostic"));
      assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), before);
      assert.deepEqual(f.service.chatSessionStore.getBinding(session.sessionKey), binding);
      assert.equal(raw.turnStartCalls, 1);
    } finally { await f.close(); }
  });
}

test("custom Responses inherits provider reasoning settings without looking up the custom model in the GPT catalog", async () => {
  const calls = [];
  const host = { modelProviderKind: "custom-responses",
    modelList: async () => { throw new Error("custom model is not in the GPT catalog"); },
    turnStart: async params => { calls.push(params); return { turn: { id: "fixture-turn" } }; } };
  const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => host } });
  const handle = await adapter.acquire({ runtime: "codex", runtimeProfileId: "fixture-profile", runtimeAccountId: "fixture-account" });
  for (const operationId of ["first", "second"]) await handle.turnStart({ sessionId: "fixture-session",
    model: CUSTOM_MODEL, prompt: "fixture", operationId, thinkingLevel: null, serviceTier: null });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(params => !Object.hasOwn(params, "effort")));
  assert.ok(calls.every(params => params.model === CUSTOM_MODEL));
});

test("a model change during pending binding observation invalidates selection CAS", async () => {
  const { f, session, raw } = await openEndpointFixture({ legacy: true });
  try {
    const list = raw.threadList.bind(raw);
    let changed = false;
    raw.threadList = async params => {
      if (!changed) { changed = true; f.service.chatSessionStore.setModelOverride(session.sessionKey, "concurrent-model"); }
      return list(params);
    };
    await assert.rejects(select(f, session.sessionKey, GPT_MODEL), { code: "CHAT_SESSION_REVISION_CONFLICT" });
    const current = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(current.status, "binding");
    assert.equal(current.modelOverride, "concurrent-model");
    assert.equal(f.service.chatSessionStore.getBinding(session.sessionKey).state, "pending");
    assert.equal(raw.turnStartCalls, 1);
  } finally { await f.close(); }
});

test("pending binding observation reserves the conversation against a concurrent send", async () => {
  const { f, session, raw } = await openEndpointFixture({ legacy: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let observed;
  const started = new Promise(resolve => { observed = resolve; });
  try {
    const list = raw.threadList.bind(raw);
    raw.threadList = async params => { observed(); await gate; return list(params); };
    const selecting = select(f, session.sessionKey, GPT_MODEL);
    selecting.catch(() => {});
    await started;
    await assert.rejects(f.service.workRunCoordinator.send({ operationId: "concurrent-send",
      sessionKey: session.sessionKey, prompt: "must not be sent" }), { code: "SESSION_BUSY" });
    assert.equal(f.service.pendingCommandInbox.get("concurrent-send"), null);
    release();
    await selecting;
    assert.equal(raw.turnStartCalls, 1);
    assert.equal(f.service.workRunCoordinator.isSessionBusy(session.sessionKey), false);
  } finally { release(); await f.close(); }
});

test("source account generation changes during recovery preserve the pending binding", async () => {
  const { f, session, raw } = await openEndpointFixture({ legacy: true });
  try {
    const before = f.service.chatSessionStore.getSession(session.sessionKey);
    const admission = f.service.runtimeAccountAdmission;
    const read = admission.read.bind(admission);
    let changed = false;
    admission.read = id => { const state = read(id); return changed ? { ...state, generation: state.generation + 1 } : state; };
    const list = raw.threadList.bind(raw);
    raw.threadList = async params => { const response = await list(params); changed = true; return response; };
    await assert.rejects(select(f, session.sessionKey, GPT_MODEL), { code: "ACCOUNT_AUTH_UNKNOWN" });
    assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), before);
    assert.equal(raw.turnStartCalls, 1);
  } finally { await f.close(); }
});
