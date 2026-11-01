"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { UNKNOWN_WINDOW_BUDGET } = require("../app/agent-service/conversation-context-budget");

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
