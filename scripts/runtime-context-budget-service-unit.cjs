"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { UNKNOWN_WINDOW_BUDGET } = require("../app/agent-service/conversation-context-budget");

test("reopening a Grok chat recovers its scoped native statistics through chat.session.list", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sh-grok-context-"));
  const home = path.join(root, ".grok");
  fs.mkdirSync(home, { mode: 0o700 });
  const options = { root, serviceOptions: { grokBuildBinaryPath: process.execPath,
    parentEnv: { GROK_HOME: home, CODEX_HOME: path.join(root, ".codex"), PATH: process.env.PATH } } };
  let f = await openHandoffFixture(options);
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeContextLifecycleV1: true } });
    const { NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
    f.service.productStore.addAgentRuntimeBinding(f.profile.id, { runtime: "grok-build",
      runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID }, { operationId: "add-grok-context" });
    const { sessionKey } = f.createSession(), sessionId = randomUUID();
    await f.switch(sessionKey, "grok-build");
    f.collideNextSessionId("grok-build", sessionId);
    const run = await f.send(sessionKey, "grok-context-legacy-turn");
    assert.equal(run.runtimeSessionRef?.sessionId, sessionId, run.errorCode);
    const observation = Date.now();
    f.service.workRunCoordinator.invalidateRuntimeContext(sessionKey);
    await f.complete(run);
    const session = f.service.chatSessionStore.getSession(sessionKey);
    const dir = path.join(home, "sessions", encodeURIComponent(session.workspace), sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ info: { id: sessionId, cwd: session.workspace },
      current_model_id: "fixture-model" }));
    const file = path.join(dir, "signals.json");
    fs.writeFileSync(file, JSON.stringify({ contextTokensUsed: 19252, contextWindowTokens: 256000 }));
    fs.utimesSync(file, observation / 1000, observation / 1000);
    await f.close({ remove: false });
    f = await openHandoffFixture(options);
    const listUsage = async () => {
      const { sessions } = await f.service.chatServiceController.handle("chat.session.list", {
        profileId: f.profile.id, includeArchived: false, cursor: null, limit: 10 });
      return sessions.find(s => s.sessionKey === sessionKey).contextUsage;
    };
    const usage = await listUsage();
    assert.deepEqual([usage.usedTokens, usage.contextWindow, usage.quality], [19252, 256000, "estimated"]);
    assert.equal(f.transport.acquisitions.length, 0, "listing the restored chat never starts a runtime");
    f.service.workRunCoordinator.invalidateRuntimeContext(sessionKey);
    assert.equal((await listUsage()).quality, "unknown", "a newer invalidation wins over the old file");
  } finally { await f.close(); }
});

test("idle time does not discard a matching native meter and recount retired sessions", async () => {
  const f = await openHandoffFixture();
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeContextLifecycleV1: true } });
    const session = f.createSession(), coordinator = f.service.workRunCoordinator;
    coordinator.beforeMemoryCompaction = null;
    coordinator.getRuntimeModelContextWindow = () => 475000;
    coordinator.getRuntimeModelContextLimits = () => ({ inputTokens: 380000 });
    const first = await f.send(session.sessionKey, "idle-first");
    for (let n = 0; n < 40; n++) f.service.transcriptStore.appendEvent({
      profileId: session.profileId, sessionId: session.id, id: `retired-${n}`, kind: "assistant",
      runtimeRef: { ...first.runtimeTurnRef, sessionId: "retired-native" },
      content: { text: "old history ".repeat(4000) }, occurredAt: Date.now() - 95 * 60_000 });
    const host = f.transport.hosts.get("codex"), native = first.runtimeSessionRef.sessionId;
    host.emit({ known: true, type: "context_usage", threadId: native,
      contextUsage: { runtimeSessionId: native, usedTokens: 213357, contextWindow: 475000,
        quality: "exact", source: "runtime_event", observedAt: Date.now() - 94 * 60_000 } });
    await f.complete(first);
    const compile = coordinator.contextCompiler.compile.bind(coordinator.contextCompiler);
    let admissionUsage;
    coordinator.contextCompiler.compile = input => { admissionUsage = input.nativeUsage; return compile(input); };
    let compactions = 0;
    host.threadCompactStart = async () => { compactions++; throw new Error("unnecessary compaction"); };
    const second = await f.send(session.sessionKey, "idle-next");
    assert.equal(second.status, "running", second.errorCode);
    assert.equal(admissionUsage?.usedTokens, 213357, "the matching observation remains the admission baseline");
    assert.equal(compactions, 0, "idle time alone cannot increase native occupancy");
    await f.complete(second);
  } finally { await f.close(); }
});

test("effective windows track model changes and survive native renewal without reusing old occupancy", async () => {
  const f = await openHandoffFixture({ catalogs: { codex: ["fixture-model", "large-model"] } });
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeContextLifecycleV1: true } });
    f.facts.read = async () => ({ installed: true, releaseEnabled: true, authenticated: true,
      models: ["fixture-model", "large-model"], attachmentKinds: [], permissionEnforcementProven: true });
    const session = f.createSession();
    const current = () => f.service.chatSessionStore.getSession(session.sessionKey);
    const read = () => f.service.workRunCoordinator.getRuntimeContext(current());
    const emit = (run, window) => f.transport.hosts.get("codex").emit({ known: true, type: "context_usage",
      threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
      contextUsage: { runtimeSessionId: run.runtimeSessionRef.sessionId, usedTokens: 64000,
        contextWindow: window, quality: "exact", source: "runtime_event", observedAt: Date.now() } });
    assert.equal(read().productContext.budget.tokens, UNKNOWN_WINDOW_BUDGET);
    assert.equal(read().productContext.budget.source, "fallback");
    const first = await f.send(session.sessionKey, "small-window");
    assert.equal(first.status, "running", first.errorCode);
    emit(first, 128000);
    assert.equal(read().productContext.budget.tokens, 128000);
    assert.equal(read().contextUsage.usedTokens, 64000);
    f.service.workRunCoordinator.getRuntimeModelContextWindow = () => 64000;
    assert.equal(read().productContext.budget.tokens, 64000, "a smaller applicable catalog cap is not hidden by a newer report");
    assert.equal(read().productContext.budget.source, "catalog");
    f.service.workRunCoordinator.getRuntimeModelContextWindow = () => null;
    await f.complete(first);
    await f.controller.handle("chat.session.runtime.model.set", { profileId: f.profile.id,
      sessionKey: session.sessionKey, bindingId: f.binding("codex").id,
      revision: current().revision, acceptAdjustments: true, model: "large-model" });
    // Within ChatGPT the native session is kept across the model change; the
    // old model's occupancy and window are still never reused.
    assert.equal(read().contextUsage?.usedTokens ?? null, null, "a model change never reuses the old model's occupancy");
    assert.equal(read().contextUsage?.contextWindow ?? null, null);
    assert.equal(read().productContext.budget.tokens, UNKNOWN_WINDOW_BUDGET, "never inherit the old model's smaller window");
    const second = await f.send(session.sessionKey, "large-window");
    assert.equal(second.status, "running", second.errorCode);
    emit(second, 1_048_576);
    assert.equal(read().productContext.budget.triggerTokens, 838860);
    assert.equal(read().productContext.budget.retainedTokens, 24000, "the recent original tail is capped");
    await f.complete(second);
    f.service.chatSessionStore.switchRuntime(session.sessionKey, { bindingId: f.binding("codex").id,
      revision: current().revision, clearModelOverride: false, permissionMode: current().permissionMode ?? null });
    assert.equal(read().contextUsage, null);
    assert.equal(read().productContext.budget.tokens, 1_048_576);
    assert.equal(read().productContext.budget.source, "last_observed");
    f.service.workRunCoordinator.captureExecutionProviderRoute = () => ({ providerId: "different-route" });
    assert.equal(read().productContext.budget.tokens, UNKNOWN_WINDOW_BUDGET, "a different provider route cannot reuse the prior route's window");
    assert.equal(read().productContext.budget.source, "fallback");
  } finally { await f.close(); }
});

test("native compaction after a turn persists a boundary for unknown occupancy", async () => {
  const f = await openHandoffFixture();
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeContextLifecycleV1: true } });
    const session = f.createSession();
    const run = await f.send(session.sessionKey, "before-native-compaction");
    const host = f.transport.hosts.get("codex"), native = run.runtimeSessionRef.sessionId;
    host.emit({ known: true, type: "context_usage", threadId: native, turnId: run.runtimeTurnRef.turnId,
      contextUsage: { runtimeSessionId: native, usedTokens: 50000, contextWindow: 64000,
        quality: "exact", source: "runtime_event", observedAt: Date.now() } });
    await f.complete(run);
    host.emit({ known: true, type: "context_compacted", threadId: native, turnId: null,
      contextUsage: { runtimeSessionId: native, usedTokens: null, contextWindow: null,
        quality: "unknown", source: "runtime_event", observedAt: Date.now() } });
    const events = f.service.transcriptStore.listEvents(session.profileId, session.id);
    const boundary = events.find(e => e.content?.transcriptType === "context.native.compacted");
    assert.equal(boundary?.content.runtimeSessionId, native);
    assert.equal(boundary.contextExcluded, true);
  } finally { await f.close(); }
});

test("session runtime state reads the current meter without validating unrelated checkpoints", async () => {
  const f = await openHandoffFixture();
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeContextLifecycleV1: true } });
    const session = f.createSession();
    const run = await f.send(session.sessionKey, "runtime-state-without-checkpoint");
    const native = run.runtimeSessionRef.sessionId;
    f.transport.hosts.get("codex").emit({ known: true, type: "context_usage", threadId: native,
      turnId: run.runtimeTurnRef.turnId, contextUsage: { runtimeSessionId: native,
        usedTokens: 21337, contextWindow: 64000, quality: "exact", source: "runtime_event", observedAt: Date.now() } });
    const coordinator = f.service.workRunCoordinator;
    const store = coordinator.conversationCheckpointStore;
    const original = store.compatible;
    try {
      store.compatible = () => assert.fail("meter-only requests must not synchronously check the checkpoint");
      const state = await f.controller.handle("chat.session.runtime.state",
        { profileId: session.profileId, sessionKey: session.sessionKey });
      assert.equal(state.contextUsage.runtimeSessionId, native);
      assert.equal(state.contextUsage.usedTokens, 21337);
      const current = f.service.chatSessionStore.getSession(session.sessionKey);
      assert.equal(coordinator.getRuntimeContext(current, { measurementOnly: true }).budget.tokens, 64000);
    } finally { store.compatible = original; }
    await f.complete(run);
  } finally { await f.close(); }
});

test("session list verifies selected checkpoints inside one owner view per page", async () => {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true } });
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeContextLifecycleV1: true } });
    f.createSession(); f.createSession(); f.createSession();
    const sessions = f.service.chatSessionStore.listProfileSessions(f.profile.id)
      .filter(session => session.status !== "archived")
      .map(session => session.sessionKey).sort();
    const checkpoints = f.service.workRunCoordinator.conversationCheckpointStore;
    const compatible = checkpoints.compatible.bind(checkpoints);
    const memory = f.service.memoryEngine;
    const originalStore = memory.store.withAsyncReadView.bind(memory.store);
    const pageScope = new AsyncLocalStorage();
    const visits = [];
    let views = 0, inside = false, unavailableWorker = false;
    memory.store.withAsyncReadView = (profileId, signal, read, scanSignal) => {
      if (!pageScope.getStore()) return originalStore(profileId, signal, read, scanSignal);
      if (unavailableWorker) {
        return Promise.reject(Object.assign(new Error("fixture scanner unavailable"), { code: "MEMORY_SCAN_UNAVAILABLE" }));
      }
      return originalStore(profileId, signal, view => {
        assert.equal(profileId, f.profile.id);
        assert.ok(view, "the file-memory implementation supplies a worker-validated view");
        views++;
        inside = true;
        try { return read(view); } finally { inside = false; }
      }, scanSignal);
    };
    checkpoints.compatible = (profileId, sessionId) => {
      if (!pageScope.getStore()) return compatible(profileId, sessionId);
      assert.equal(inside, true, "the page must never synchronously open a memory snapshot per session");
      visits.push(f.service.chatSessionStore.findSessionById(sessionId).sessionKey);
      return compatible(profileId, sessionId);
    };
    try {
      const read = cursor => pageScope.run(true, () => f.service.chatServiceController.handle("chat.session.list",
        { profileId: f.profile.id, includeArchived: false, cursor, limit: 1 }));
      const first = await read(null), second = await read(first.nextCursor);
      assert.equal(first.sessions[0].sessionKey, sessions[0]);
      assert.equal(second.sessions[0].sessionKey, sessions[1]);
      assert.ok(first.sessions[0].productContext);
      assert.deepEqual(visits, sessions.slice(0, 2));
      assert.equal(views, 2);
      unavailableWorker = true;
      const unavailable = await read(null);
      assert.equal(unavailable.sessions[0].sessionKey, sessions[0]);
      assert.equal(unavailable.sessions[0].productContext.checkpointId, null);
      assert.deepEqual(visits, sessions.slice(0, 2), "unavailable workers never trigger a synchronous fallback");
    } finally {
      memory.store.withAsyncReadView = originalStore;
      checkpoints.compatible = compatible;
    }
  } finally { await f.close(); }
});
