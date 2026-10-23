"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");

async function settle(f, id) {
  const until = Date.now() + 3000;
  for (;;) {
    await f.service.workRunCoordinator.waitForIdle(id);
    const run = f.service.workRunCoordinator.getRun(id);
    if (!["queued", "starting"].includes(run.status)) return run;
    assert.ok(Date.now() < until, `instruction renewal did not settle: ${run.status} ${run.errorCode}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const incomplete of [false, true]) test(`immutable native policy renews only a complete original context (${incomplete ? "partial refusal" : "complete"})`, async () => {
  const f = await openHandoffFixture();
  try {
    const cfg = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...cfg, revision: cfg.revision + 1,
      flags: { ...cfg.flags, runtimeContextLifecycleV1: true } });
    const session = f.createSession();
    const first = await f.send(session.sessionKey, "policy-first", "Retain the exact long-tail constraint ORIGINAL_XYZ.");
    await f.complete(first, "The first result is preserved as ORIGINAL_RESULT.");
    const oldNative = first.runtimeSessionRef.sessionId;
    const raw = f.transport.hosts.get("codex");
    const originalResume = raw.threadResume.bind(raw);
    raw.threadResume = async input => {
      if (input.threadId === oldNative) throw Object.assign(new Error("immutable native rules changed"), {
        code: "RUNTIME_SESSION_INSTRUCTIONS_CHANGED", acceptance: "not_sent", sessionId: oldNative });
      return originalResume(input);
    };
    if (incomplete) {
      const compiler = f.service.workRunCoordinator.contextCompiler;
      const compile = compiler.compile.bind(compiler);
      compiler.compile = input => {
        const snapshot = compile(input);
        if (input.preview === true) snapshot.report.request.completeness = "partial";
        return snapshot;
      };
    }
    const ack = await f.service.workRunCoordinator.send({ sessionKey: session.sessionKey,
      operationId: "policy-next", prompt: "Continue with NEW_REQUEST_ONLY_ONCE." });
    const next = await settle(f, ack.run.id);
    const current = f.service.chatSessionStore.getSession(session.sessionKey);
    const old = raw.threads.find(thread => thread.id === oldNative);
    assert.equal(old.turns.length, 1, "the original native operation is never replayed");
    assert.equal(old.turns[0].status, "completed");
    if (incomplete) {
      assert.equal(next.status, "failed");
      assert.equal(next.errorCode, "CONTEXT_COMPACTION_REQUIRED");
      assert.equal(current.runtimeSessionId, oldNative);
      assert.equal(raw.threads.length, 1);
    } else {
      assert.equal(next.status, "running", next.errorCode);
      assert.notEqual(next.runtimeSessionRef.sessionId, oldNative);
      assert.equal(current.sessionKey, session.sessionKey);
      const original = raw.lastInjectedItems.items[0].content[0].text;
      assert.match(original, /ORIGINAL_XYZ/u);
      assert.match(original, /ORIGINAL_RESULT/u);
      assert.doesNotMatch(original, /NEW_REQUEST_ONLY_ONCE/u);
      assert.equal(raw.lastTurnStartParams.input[0].text, "Continue with NEW_REQUEST_ONLY_ONCE.");
      await f.complete(next);
    }
  } finally { await f.close(); }
});
