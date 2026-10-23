"use strict";
// Real Service/Coordinator/store lifecycle with a controlled native transport.
// This proves local interruption/publication/session renewal, not a live provider.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
const FACT = "The telescope borrowed in-flight fact is aquamarine calibration.";
const LATE = "REVOKED_LATE_BODY_791549";

async function fixture(activeMemory = false) {
  const memoryCoreConfig = { memory: { search: { provider: "none", rememberAcrossConversations: false } },
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
    plugins: { entries: { "active-memory": { enabled: activeMemory, config: { enabled: activeMemory, mode: "escalate", model: "literal" } } } } };
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true, memorySharingFeatureReady: true, memoryCoreConfig } });
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: false } });
  const B = "source-b", source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
  Object.assign(source, { id: B, agentId: B, runtimeProfileId: B, name: B, isDefault: false });
  f.service.productStore.putAgentProfile(source); f.service.agentDefinitionStore.ensureProfile({ profileId: B });
  const owner = f.service.memoryEngine;
  owner.store.ensureProfile(B); owner.recallPolicy.assertReady(B);
  f.service.nativeMemorySharingConfig.apply({ revision: 0, config: { enabled: true, excludedProfiles: [] } });
  const item = await owner.propose({ profileId: B, content: FACT, scope: "agent", classification: "explicit", sourceRefs: ["user-edit:inflight-source"] });
  return { ...f, B, item, owner, memoryCoreConfig };
}
function emitLate(host, run) {
  const common = { known: true, threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId };
  host.emit({ ...common, type: "text_delta", method: "item/agentMessage/delta", itemId: "late-text", delta: LATE });
  host.emit({ ...common, type: "text", method: "item/completed", itemId: "late-final", text: LATE, phase: "final_answer" });
  host.emit({ ...common, type: "tool_result", method: "item/completed", itemId: "late-tool", toolCallId: "late-tool",
    tool: { kind: "function", name: "memory_search", status: "completed", output: LATE } });
  const thread = host.threads.find(value => value.id === run.runtimeSessionRef.sessionId);
  const turn = thread.turns.find(value => value.id === run.runtimeTurnRef.turnId);
  turn.status = "completed"; turn.items.push({ type: "agentMessage", id: "late-final", text: LATE, phase: "final_answer" });
  host.emit({ ...common, type: "complete", method: "turn/completed", status: "completed" });
}

for (const action of ["exclude source", "delete source memory"]) {
  test(`in-flight borrowed source withdrawal interrupts real Coordinator and renews native session: ${action}`, { timeout: 30000 }, async () => {
    const f = await fixture(); let subscription;
    try {
      const session = f.createSession();
      const run = await f.send(session.sessionKey, "borrowed-inflight-first", "Find telescope memory");
      assert.equal(run.status, "running", run.errorCode);
      const coordinator = f.service.workRunCoordinator, events = [];
      subscription = coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
      const call = (name, args) => f.service.mcpProductToolController.handle(name,
        { source: "chat", sourceId: run.sourceId, ...args }, { profileId: f.profile.id, callId: crypto.randomUUID() });
      const found = await call("memory_search", { query: "telescope", minScore: 0, maxResults: 20, ownerProfileId: f.B });
      const borrowed = found.results.find(value => value.ownerProfileId === f.B);
      assert.ok(borrowed, "actual running chat must borrow through the real MCP controller");
      const read = await call("memory_get", { id: borrowed.sourceRef }); assert.match(read.text, /aquamarine/u);
      const host = f.transport.hosts.get("codex");
      host.emit({ known: true, type: "tool_result", method: "item/completed", threadId: run.runtimeSessionRef.sessionId,
        turnId: run.runtimeTurnRef.turnId, itemId: "borrowed-tool", toolCallId: "borrowed-tool",
        tool: { kind: "function", name: "memory_get", status: "completed", output: read } });
      host.emit({ known: true, type: "text", threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
        itemId: "before-withdrawal", text: "Historical answer before source withdrawal", phase: "final_answer" });
      await coordinator.waitForIdle(run.id);
      assert.ok(f.service.transcriptStore.listEvents(f.profile.id, session.id).some(event => event.content?.borrowedMemoryRefs?.length),
        "actual Coordinator records body-free dependencies before source withdrawal");
      const interruptsBefore = host.turnInterruptCalls;
      if (action === "exclude source") {
        f.service.nativeMemorySharingConfig.apply({ revision: 1, config: { enabled: true, excludedProfiles: [f.B] } });
        await f.owner.sharing.reconcileConfig();
      } else await f.owner.delete({ profileId: f.B, id: f.item.id, reason: "forgotten", operationId: "source-delete-inflight" });
      await waitUntil(() => coordinator.getRun(run.id).status === "interrupted", 5000, "borrowed source interruption");
      await coordinator.waitForIdle(run.id);
      assert.equal(host.turnInterruptCalls, interruptsBefore + 1, "the assigned actual Runtime handle receives turnInterrupt");
      assert.equal(host.lastTurnInterruptParams.threadId, run.runtimeSessionRef.sessionId);
      assert.equal(host.lastTurnInterruptParams.turnId, run.runtimeTurnRef.turnId);
      const terminal = coordinator.getRun(run.id);
      assert.equal(terminal.errorCode, "CONTEXT_SOURCE_STALE"); assert.equal(terminal.resultSummary, null);
      emitLate(host, run); await coordinator.waitForIdle(run.id);
      assert.doesNotMatch(JSON.stringify(events), new RegExp(LATE), "late text/tools are never published to subscribers");
      assert.equal(events.filter(event => event.type === "terminal").length, 1, "late complete cannot republish completion");
      assert.doesNotMatch(JSON.stringify(f.service.transcriptStore.listEvents(f.profile.id, session.id)), new RegExp(LATE),
        "late source-dependent output never enters replayable Product history");
      assert.doesNotMatch(JSON.stringify([...coordinator.lastErrors.values()].map(error => ({ code: error.code, message: error.message }))), /SERVICE_RECOVERY_REQUIRED|STORE_COMMIT_UNCERTAIN/u);
      const recoveryFile = path.join(f.paths.runtimeDir, "service-recovery.json");
      if (fs.existsSync(recoveryFile)) assert.doesNotMatch(fs.readFileSync(recoveryFile, "utf8"), /SERVICE_RECOVERY_REQUIRED|STORE_COMMIT_UNCERTAIN/u);
      const next = await f.send(session.sessionKey, "borrowed-inflight-next", "Continue with independent facts");
      assert.equal(next.status, "running", next.errorCode);
      assert.notEqual(next.runtimeSessionRef.sessionId, run.runtimeSessionRef.sessionId, "withdrawn dependency retires the old native session before the next turn");
      const contract = f.transport.acquisitions.at(-1).options.executionContract;
      assert.equal(contract.contextFresh, true); assert.doesNotMatch(contract.dynamicContext, /aquamarine|REVOKED_LATE_BODY/u);
      await f.complete(next, "Independent continuation after source withdrawal");
      const stable = await f.send(session.sessionKey, "borrowed-inflight-stable", "Continue again");
      assert.equal(stable.status, "running", stable.errorCode);
      assert.equal(stable.runtimeSessionRef.sessionId, next.runtimeSessionRef.sessionId, "fresh native session remains reusable");
      await f.complete(stable);
    } finally { subscription?.unsubscribe(); await f.close(); }
  });
}

test("a pending source-withdrawal interrupt filters late events and joins one native interruption", { timeout: 30000 }, async () => {
  const f = await fixture(); let release, withdrawing, subscription;
  try {
    const session = f.createSession(), coordinator = f.service.workRunCoordinator;
    const run = await f.send(session.sessionKey, "borrowed-pending-interrupt", "Find telescope memory");
    assert.equal(run.status, "running", run.errorCode);
    const found = await f.service.mcpProductToolController.handle("memory_search",
      { source: "chat", sourceId: run.sourceId, query: "telescope", minScore: 0 },
      { profileId: f.profile.id, callId: crypto.randomUUID() });
    assert.ok(found.results.some(value => value.ownerProfileId === f.B && value.borrowed));
    const host = f.transport.hosts.get("codex"), events = [], before = host.turnInterruptCalls;
    subscription = coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
    host.interruptGate = { promise: new Promise(resolve => { release = resolve; }) };
    f.service.nativeMemorySharingConfig.apply({ revision: 1, config: { enabled: true, excludedProfiles: [f.B] } });
    withdrawing = f.owner.sharing.reconcileConfig();
    await waitUntil(() => host.turnInterruptCalls > before, 5000, "assigned native interrupt begins");
    assert.equal(coordinator.getRun(run.id).status, "running", "the physical interruption remains pending in the fixture");
    emitLate(host, run);
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(LATE), "revoked output is filtered even before interruption returns");
    assert.doesNotMatch(JSON.stringify(f.service.transcriptStore.listEvents(f.profile.id, session.id)), new RegExp(LATE));
    assert.equal(host.turnInterruptCalls, before + 1, "concurrent late text/tool/complete events join the already pending native interruption");
    release(); await withdrawing;
    await waitUntil(() => coordinator.getRun(run.id).status === "interrupted", 5000, "source withdrawal finishes");
    await coordinator.waitForIdle(run.id);
    assert.equal(events.filter(event => event.type === "terminal").length, 1);
    assert.equal(coordinator.getRun(run.id).errorCode, "CONTEXT_SOURCE_STALE");
    assert.equal(coordinator.lastErrors.size, 0);
  } finally {
    release?.(); await withdrawing?.catch(() => {});
    subscription?.unsubscribe(); await f.close();
  }
});


test("automatic recall anchors a resumed native session before acceptance and survives restart before withdrawal", { timeout: 60000 }, async () => {
  let f = await fixture(true);
  try {
    require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(f.owner);
    let calls = 0;
    f.owner.complete = async ({ prompt }) => {
      calls++; assert.match(prompt, /aquamarine/u);
      return { text: JSON.stringify({ summary: FACT }) };
    };
    const session = f.createSession(), store = f.service.conversationCheckpointStore;
    const seed = await f.send(session.sessionKey, "auto-anchor-seed", "Hello");
    assert.equal(seed.status, "running", seed.errorCode); await f.complete(seed, "Hello");
    assert.equal(calls, 0);
    const nativeId = seed.runtimeSessionRef.sessionId, bindingId = f.binding("codex").id;
    assert.deepEqual(store.nativeSessionBorrowedMemoryRefs(f.profile.id, session.id, nativeId, bindingId), []);
    const host = f.transport.hosts.get("codex"), beforeAcceptance = [];
    const turnStart = host.turnStart.bind(host);
    host.turnStart = async params => {
      beforeAcceptance.push(store.nativeSessionBorrowedMemoryRefs(f.profile.id, session.id, params.threadId, bindingId));
      return turnStart(params);
    };
    const recalled = await f.send(session.sessionKey, "auto-anchor-recall", "Do you remember telescope calibration?");
    assert.equal(recalled.status, "running", recalled.errorCode);
    assert.equal(recalled.runtimeSessionRef.sessionId, nativeId, "first borrow should reuse the still-valid seed session");
    assert.ok(calls > 0, "the real pre-admission Active Memory path ran");
    assert.ok(beforeAcceptance.at(-1).some(ref => ref.ownerProfileId === f.B), "automatic borrow must be durable before turnStart");
    await f.complete(recalled, FACT);
    const compiler = f.service.contextCompiler, compile = compiler.compile.bind(compiler);
    compiler.compile = input => ({ ...compile(input), nativeBorrowedMemoryRefs: [] });
    const independent = await f.send(session.sessionKey, "auto-anchor-followup", "Hello again");
    compiler.compile = compile;
    assert.equal(independent.runtimeSessionRef.sessionId, nativeId);
    assert.ok(beforeAcceptance.at(-1).some(ref => ref.ownerProfileId === f.B));
    assert.ok(f.owner.sharing.borrowedRefsForRun(independent.id).some(ref => ref.ownerProfileId === f.B),
      "old native dependencies remain registered for in-flight withdrawal even with a shorter new snapshot");
    await f.complete(independent, "Hello again");
    host.turnStart = turnStart;
    const { root, transport, B, item, memoryCoreConfig } = f;
    await f.close({ remove: false });
    f = await openHandoffFixture({ root, transport, serviceOptions: { memoryCore: true,
      memorySharingFeatureReady: true, memoryCoreConfig } });
    const owner = f.service.memoryEngine, reopened = f.service.conversationCheckpointStore;
    assert.ok(reopened.nativeSessionBorrowedMemoryRefs(f.profile.id, session.id, nativeId, bindingId).some(ref => ref.ownerProfileId === B));
    await owner.delete({ profileId: B, id: item.id, reason: "forgotten", operationId: "auto-anchor-withdraw" });
    assert.equal(reopened.nativeSessionStale(f.profile.id, session.id, nativeId, bindingId), true);
    const renewed = await f.send(session.sessionKey, "auto-anchor-renewed", "Hello after restart");
    assert.equal(renewed.status, "running", renewed.errorCode);
    assert.notEqual(renewed.runtimeSessionRef.sessionId, nativeId);
    const contract = f.transport.acquisitions.at(-1).options.executionContract;
    assert.equal(contract.contextFresh, true); assert.doesNotMatch(contract.dynamicContext, /aquamarine/u);
    await f.complete(renewed, "Independent answer");
  } finally { await f.close(); }
});


test("an unwritable resumed native anchor stops automatic borrowing before remote acceptance", { timeout: 30000 }, async () => {
  const f = await fixture(true);
  try {
    require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(f.owner);
    f.owner.complete = async ({ prompt }) => {
      assert.match(prompt, /aquamarine/u); return { text: JSON.stringify({ summary: FACT }) };
    };
    const session = f.createSession(), seed = await f.send(session.sessionKey, "resumed-anchor-seed", "Hello");
    assert.equal(seed.status, "running", seed.errorCode); await f.complete(seed, "Hello");
    const host = f.transport.hosts.get("codex"), accepted = host.turnStartCalls;
    f.service.conversationCheckpointStore.recordNativeSession = () => {
      throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
    };
    const denied = await f.send(session.sessionKey, "resumed-anchor-full", "Do you remember telescope calibration?");
    assert.notEqual(denied.status, "running");
    assert.equal(host.turnStartCalls, accepted, "the borrowed turn never reaches native acceptance without durable dependencies");
  } finally { await f.close(); }
});


for (const question of ["Do you remember telescope calibration?",
  "Do you remember the telescope calibration previously recorded here?"]) {
  test(`fresh recall survives native renewal after source update and withdrawal: ${question}`, { timeout: 60000 }, async () => {
    const f = await fixture(true);
    try {
      require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(f.owner);
      const C = "source-c", secondary = "The telescope calibration interval is 23 days.";
      const source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
      Object.assign(source, { id: C, agentId: C, runtimeProfileId: C, name: C, isDefault: false });
      f.service.productStore.putAgentProfile(source); f.service.agentDefinitionStore.ensureProfile({ profileId: C });
      f.owner.store.ensureProfile(C); f.owner.recallPolicy.assertReady(C);
      await f.owner.propose({ profileId: C, content: secondary, scope: "agent", classification: "explicit",
        sourceRefs: ["user-edit:inflight-secondary"] });
      const updatedFact = FACT.replace("aquamarine", "jade"), session = f.createSession();
      let expected = FACT, calls = 0;
      f.owner.complete = async ({ prompt }) => {
        calls++; assert.match(prompt, /23 days/u);
        if (expected) assert.ok(prompt.includes(expected), "model must receive the current source value");
        if (expected !== FACT) assert.doesNotMatch(prompt, /aquamarine/u);
        if (!expected) assert.doesNotMatch(prompt, /jade/u);
        return { text: JSON.stringify({ summary: [expected, secondary].filter(Boolean).join(" ") }) };
      };
      const recall = async (label, owners) => {
        const before = calls, run = await f.send(session.sessionKey, `renewal-recall-${label}`, question);
        assert.equal(run.status, "running", run.errorCode);
        assert.ok(calls > before, `${label} must perform a fresh automatic recall`);
        const contract = f.transport.acquisitions.at(-1).options.executionContract;
        assert.match(contract.dynamicContext, /<active_memory_plugin>/u, `${label} must deliver fresh recall to the native turn`);
        assert.match(contract.dynamicContext, /23 days/u);
        if (expected) assert.ok(contract.dynamicContext.includes(expected));
        if (expected !== FACT) assert.doesNotMatch(contract.dynamicContext, /aquamarine/u);
        if (!expected) assert.doesNotMatch(contract.dynamicContext, /jade/u);
        const anchor = f.service.conversationCheckpointStore.nativeSessionBorrowedMemoryRefs(
          f.profile.id, session.id, run.runtimeSessionRef.sessionId, f.binding("codex").id);
        assert.deepEqual([...new Set(anchor.map(ref => ref.ownerProfileId))].sort(), owners.sort());
        await f.complete(run, [expected, secondary].filter(Boolean).join(" "));
        return run;
      };
      const initial = await recall("initial", [f.B, C]);
      expected = updatedFact;
      const item = await f.owner.update({ profileId: f.B, id: f.item.id, content: updatedFact,
        sourceRef: "user-edit:inflight-update" });
      const updated = await recall("updated", [f.B, C]);
      assert.notEqual(updated.runtimeSessionRef.sessionId, initial.runtimeSessionRef.sessionId);
      expected = null;
      await f.owner.delete({ profileId: f.B, id: item.id, reason: "forgotten", operationId: "fresh-recall-withdraw" });
      const withdrawn = await recall("withdrawn", [C]);
      assert.notEqual(withdrawn.runtimeSessionRef.sessionId, updated.runtimeSessionRef.sessionId);
      assert.ok(f.transport.acquisitions.every(row => row.binding.runtimeProfileId === f.profile.runtimeProfileId),
        "source Profiles must not start a native Runtime");
    } finally { await f.close(); }
  });
}


for (const change of ["update", "withdraw"]) {
  test(`concurrent queue wakes wait for fresh recall after source ${change}`, { timeout: 60000 }, async () => {
    const f = await fixture(true); let release;
    try {
      require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(f.owner);
      const coordinator = f.service.workRunCoordinator;
      coordinator.onConversationRenewed = () => f.controller.auditPending();
      const config = f.service.nativeRuntimeConfig.read();
      f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
        flags: { ...config.flags, runtimeAdmissionV1: true, runtimeContextLifecycleV1: true } });
      const C = "source-c", secondary = "The telescope calibration interval is 23 days.";
      const source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
      Object.assign(source, { id: C, agentId: C, runtimeProfileId: C, name: C, isDefault: false });
      f.service.productStore.putAgentProfile(source); f.service.agentDefinitionStore.ensureProfile({ profileId: C });
      f.owner.store.ensureProfile(C); f.owner.recallPolicy.assertReady(C);
      await f.owner.propose({ profileId: C, content: secondary, scope: "agent", classification: "explicit",
        sourceRefs: ["user-edit:concurrent-secondary"] });
      const session = f.createSession(), question = "Do you remember the telescope calibration previously recorded here?";
      f.owner.complete = async () => ({ text: JSON.stringify({ summary: `${FACT} ${secondary}` }) });
      const initial = await f.send(session.sessionKey, `concurrent-${change}-initial`, question);
      assert.equal(initial.status, "running", initial.errorCode); await f.complete(initial, FACT);
      const expected = change === "update" ? FACT.replace("aquamarine", "jade") : null;
      if (expected) await f.owner.update({ profileId: f.B, id: f.item.id, content: expected,
        sourceRef: "user-edit:concurrent-update" });
      else await f.owner.delete({ profileId: f.B, id: f.item.id, reason: "forgotten", operationId: "concurrent-source-withdraw" });
      const gate = new Promise(resolve => { release = resolve; }); let entered = false;
      f.owner.complete = async ({ prompt }) => {
        assert.match(prompt, /23 days/u); assert.doesNotMatch(prompt, /aquamarine/u);
        if (expected) assert.ok(prompt.includes(expected)); else assert.doesNotMatch(prompt, /jade/u);
        entered = true; await gate;
        return { text: JSON.stringify({ summary: [expected, secondary].filter(Boolean).join(" ") }) };
      };
      const sending = f.send(session.sessionKey, `concurrent-${change}-changed`, question);
      const observedSend = sending.then(value => ({ value }), error => ({ error }));
      await waitUntil(() => entered, 5000, "fresh recall waiting for the controlled model");
      const wakes = [coordinator.capacityChanged(), coordinator.capacityChanged()];
      const observedWakes = Promise.allSettled(wakes);
      await new Promise(resolve => setImmediate(resolve));
      const queued = coordinator.listSessionRuns(session.sessionKey).at(-1);
      assert.equal(queued.status, "queued", "main turn must wait for this turn's recall");
      assert.equal(f.transport.acquisitions.filter(row => row.options.executionContract?.runId === queued.id).length, 0);
      release();
      const sent = await observedSend, wakeResults = await observedWakes;
      assert.ifError(sent.error);
      for (const result of wakeResults) if (result.status === "rejected") throw result.reason;
      const run = sent.value; assert.equal(run.status, "running", run.errorCode);
      const acquisitions = f.transport.acquisitions.filter(row => row.options.executionContract?.runId === run.id);
      assert.equal(acquisitions.length, 1, "one native main turn is accepted with the prepared recall");
      const contract = acquisitions[0].options.executionContract;
      assert.match(contract.dynamicContext, /<active_memory_plugin>/u); assert.match(contract.dynamicContext, /23 days/u);
      assert.doesNotMatch(contract.dynamicContext, /aquamarine/u);
      if (expected) assert.ok(contract.dynamicContext.includes(expected)); else assert.doesNotMatch(contract.dynamicContext, /jade/u);
      assert.notEqual(run.runtimeSessionRef.sessionId, initial.runtimeSessionRef.sessionId);
      const refs = f.service.conversationCheckpointStore.nativeSessionBorrowedMemoryRefs(
        f.profile.id, session.id, run.runtimeSessionRef.sessionId, f.binding("codex").id);
      assert.deepEqual([...new Set(refs.map(ref => ref.ownerProfileId))].sort(), (expected ? [f.B, C] : [C]).sort());
      assert.ok(f.transport.acquisitions.every(row => row.binding.runtimeProfileId === f.profile.runtimeProfileId));
      await f.complete(run, [expected, secondary].filter(Boolean).join(" "));
    } finally { release?.(); await f.close(); }
  });
}
