"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { SUMMARY_FIELDS } = require("../app/agent-service/conversation-checkpoint-store");
const { estimateContextTokens } = require("../app/agent-service/conversation-context-budget");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");

function enable(f, enabled = true) {
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: enabled } });
}
function appendHistory(f, session, count = 44) {
  for (let n = 0; n < count; n++) f.service.transcriptStore.appendEvent({ profileId: session.profileId, sessionId: session.id,
    id: `large-${n}`, kind: n % 2 ? "assistant" : "user", content: { text: `SOURCE_${n} ${"ordinary words ".repeat(3400)}` } });
}
function modelOnly(f, fail = false) {
  const coordinator = f.service.workRunCoordinator, manager = coordinator.runtimeManager;
  manager.canGenerateModelOnly = () => true;
  const acquire = manager.acquire.bind(manager);
  let calls = 0;
  manager.acquire = async (...args) => {
    const handle = await acquire(...args), facade = Object.create(handle);
    Object.defineProperties(facade, {
      capabilities: { value: { ...handle.capabilities, "model.generate.toolFree": true } },
      generateModelOnly: { value: async input => {
        calls++;
        assert.ok(Buffer.byteLength(input.prompt) < 128 * 1024);
        assert.ok(estimateContextTokens(input.prompt) < 217600);
        if (fail) throw Object.assign(new Error("fixture summary failed"), { code: "MODEL_ONLY_OUTPUT_INVALID" });
        const summary = Object.fromEntries(SUMMARY_FIELDS.map(field => [field, []]));
        summary.constraints = ["Preserve SOURCE_0 and the original project files"];
        return { text: JSON.stringify(summary), model: input.model || "fixture-model" };
      } },
    });
    return facade;
  };
  return () => calls;
}

test("a 1M to 272k handoff compacts 520k tokens before switching and records target acceptance", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const calls = modelOnly(f);
    f.service.workRunCoordinator.getRuntimeModelContextWindow = (selected, profile) => profile.runtime === "codex"
      || selected.modelOverride === "large-model" ? 1000000 : 272000;
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, "before-large-transfer"));
    const old = f.service.chatSessionStore.getSession(session.sessionKey);
    appendHistory(f, session);
    await f.switch(session.sessionKey, "pi");
    const switched = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.ok(calls() > 1);
    assert.equal(switched.runtimeSessionId, null);
    assert.ok(switched.retiredRuntimeSessions.some(item => item.runtimeSessionId === old.runtimeSessionId));
    const read = () => f.service.workRunCoordinator.getRuntimeContext(f.service.chatSessionStore.getSession(session.sessionKey));
    assert.equal(read().productContext.transfer.state, "ready");
    assert.equal(read().productContext.transfer.mode, "summary");
    const run = await f.send(session.sessionKey, "after-large-transfer");
    assert.equal(run.status, "running", run.errorCode);
    const contract = f.transport.acquisitions.at(-1).options.executionContract;
    assert.ok(contract.contextRequest.estimatedTokens <= contract.contextRequest.limitTokens);
    assert.equal(contract.contextRequest.historyTruncated, false);
    assert.match(contract.dynamicContext, /SOURCE_0/u);
    assert.match(contract.dynamicContext, /SOURCE_43/u);
    assert.equal(read().productContext.transfer.state, "accepted");
    await f.complete(run);
    f.facts.read = async () => ({ installed: true, releaseEnabled: true, authenticated: true,
      models: ["fixture-model", "large-model"], attachmentKinds: [], permissionEnforcementProven: true });
    const small = f.service.chatSessionStore.getSession(session.sessionKey);
    await f.controller.handle("chat.session.runtime.model.set", { profileId: session.profileId, sessionKey: session.sessionKey,
      bindingId: f.binding("pi").id, revision: small.revision, model: "large-model", acceptAdjustments: true });
    const expanded = read().productContext.transfer;
    assert.equal(expanded.mode, "original");
    const resumed = await f.send(session.sessionKey, "larger-originals");
    const restored = f.transport.acquisitions.at(-1).options.executionContract;
    assert.match(restored.dynamicContext, /SOURCE_1 /u);
    assert.doesNotMatch(restored.dynamicContext, /CONVERSATION CHECKPOINT/u);
    assert.ok(Buffer.byteLength(restored.dynamicContext) > 2 * 1024 * 1024 - 16384);
    await f.complete(resumed);
  } finally { await f.close(); }
});

for (const behavior of ["disabled", "unavailable", "failed"]) test(`${behavior} summary preserves the old binding and original history`, async () => {
  const f = await openHandoffFixture();
  try {
    enable(f, behavior !== "disabled");
    if (behavior === "failed") modelOnly(f, true);
    f.service.workRunCoordinator.getRuntimeModelContextWindow = (_session, profile) => profile.runtime === "codex" ? 1000000 : 32000;
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, `before-${behavior}`));
    const old = f.service.chatSessionStore.getSession(session.sessionKey);
    appendHistory(f, session, 6);
    await assert.rejects(f.switch(session.sessionKey, "pi"), error => ["CONTEXT_COMPACTION_REQUIRED", "COMPACTION_FAILED"].includes(error.code));
    assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), old);
    const state = f.service.workRunCoordinator.getRuntimeContext(old).productContext.transfer;
    assert.equal(state.state, "failed");
    assert.equal(f.transport.hosts.get("pi")?.turnStartCalls ?? 0, 0);
    assert.equal(f.service.transcriptStore.listEvents(session.profileId, session.id).filter(e => e.id.startsWith("large-")).length, 6);
  } finally { await f.close(); }
});

test("Codex input character limit requires a transport summary even when the token window fits", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const calls = modelOnly(f);
    f.service.workRunCoordinator.getRuntimeModelContextWindow = () => 1000000;
    f.facts.read = async () => ({ installed: true, releaseEnabled: true, authenticated: true,
      models: ["fixture-model", "large-model"], attachmentKinds: [], permissionEnforcementProven: true });
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, "before-character-limit"));
    appendHistory(f, session, 30);
    const current = f.service.chatSessionStore.getSession(session.sessionKey);
    await f.controller.handle("chat.session.runtime.model.set", { profileId: session.profileId, sessionKey: session.sessionKey,
      bindingId: f.binding("codex").id, revision: current.revision, model: "large-model", acceptAdjustments: true });
    const switched = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.ok(calls() > 0);
    assert.equal(f.service.workRunCoordinator.getRuntimeContext(switched).productContext.transfer.mode, "transport_summary");
    const run = await f.send(session.sessionKey, "after-character-limit");
    assert.equal(run.status, "running", run.errorCode);
    const contract = f.transport.acquisitions.at(-1).options.executionContract;
    assert.ok(contract.dynamicContext.length + "fixture prompt".length + 2048 < 1048576);
    assert.equal(contract.contextRequest.historyTruncated, false);
    assert.equal(contract.contextRequest.transportExceeded, false);
    assert.match(contract.dynamicContext, /SOURCE_29/u);
    await f.complete(run);
  } finally { await f.close(); }
});

test("known oversized current input is rejected even with automatic summaries disabled", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f, false);
    f.service.workRunCoordinator.getRuntimeModelContextWindow = () => 16000;
    const session = f.createSession();
    const run = await f.send(session.sessionKey, "too-large-current", "中文".repeat(10000));
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "CONTEXT_INPUT_TOO_LARGE");
    assert.equal(f.transport.acquisitions.length, 0);
    const user = f.service.transcriptStore.listEvents(session.profileId, session.id).find(e => e.kind === "user");
    assert.equal(f.service.transcriptStore.contextEvent(session.profileId, session.id, user).content.text.length, 20000);
  } finally { await f.close(); }
});

for (const behavior of ["once", "twice", "unknown", "side-effect"]) test(`capacity rejection recovery: ${behavior}`, async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const manager = f.service.workRunCoordinator.runtimeManager, acquire = manager.acquire.bind(manager);
    let calls = 0;
    manager.acquire = async (...args) => {
      const handle = await acquire(...args), raw = f.transport.hosts.get("codex");
      if (!raw.capacityTestPatched) {
        raw.capacityTestPatched = true;
        const turnStart = raw.turnStart.bind(raw);
        raw.turnStart = async input => {
          calls++;
          if (behavior === "once" && calls > 1) return turnStart(input);
          if (behavior === "side-effect") raw.emit({ known: true, type: "tool_start", threadId: input.threadId,
            turnId: "attempted-turn", toolCallId: "side-effect", tool: { name: "write_file", kind: "other", status: "in_progress" } });
          throw Object.assign(new Error("fixture context refusal"), { code: "CONTEXT_LENGTH_EXCEEDED", contextWindow: calls === 1 ? 272000 : 128000,
            acceptance: behavior === "unknown" ? "unknown" : "rejected", executed: false });
        };
      }
      return handle;
    };
    const session = f.createSession();
    const sent = await f.service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: `recovery-${behavior}`, prompt: "small input" });
    await waitUntil(() => ["running", "failed", "interrupted"].includes(f.service.workRunCoordinator.getRun(sent.run.id).status), 10000, "recovery outcome");
    const run = f.service.workRunCoordinator.getRun(sent.run.id);
    assert.equal(calls, ["unknown", "side-effect"].includes(behavior) ? 1 : 2);
    if (behavior === "once") {
      assert.equal(run.status, "running");
      const current = f.service.chatSessionStore.getSession(session.sessionKey);
      assert.equal(f.service.workRunCoordinator.getRuntimeContext(current).productContext.budget.tokens, 272000);
      await f.complete(run);
    } else assert.notEqual(run.status, "running");
    const markers = f.service.transcriptStore.listEvents(session.profileId, session.id)
      .filter(event => event.content?.transcriptType === "context.capacity.rejected");
    assert.equal(markers.length, ["unknown", "side-effect"].includes(behavior) ? 0 : 1);
  } finally { await f.close(); }
});
