"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");

test("context observations do not cross runtime/account namespaces with the same native session id", async () => {
  const f = await openHandoffFixture();
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeContextLifecycleV1: true } });
    const session = f.createSession();
    const first = await f.send(session.sessionKey, "context-codex");
    const codex = f.transport.hosts.get("codex");
    const nativeId = first.runtimeSessionRef.sessionId;
    const emit = (host, usedTokens, observedAt) => host.emit({ known: true, type: "context_usage",
      threadId: nativeId, contextUsage: { runtimeSessionId: nativeId, usedTokens,
        contextWindow: 1000, quality: "exact", source: "runtime_event", observedAt } });
    const read = () => f.service.workRunCoordinator.getRuntimeContext(
      f.service.chatSessionStore.getSession(session.sessionKey)).contextUsage;
    const now = Date.now();
    emit(codex, 123, now);
    assert.equal(read().usedTokens, 123);
    await f.complete(first);
    await f.switch(session.sessionKey, "pi");
    const second = await f.send(session.sessionKey, "context-pi");
    assert.equal(second.runtimeSessionRef.sessionId, nativeId, "fixture must collide across namespaces");
    assert.equal(read().quality, "unknown");
    assert.equal(read().usedTokens, null);
    emit(f.transport.hosts.get("pi"), 456, now + 1);
    assert.equal(read().usedTokens, 456);
    await f.complete(second);
    emit(codex, 789, now + 2);
    assert.equal(read().usedTokens, 456, "late retired host observations cannot overwrite the new runtime");
  } finally { await f.close(); }
});
