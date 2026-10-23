"use strict";
// Shoggoth asks OpenCode / Grok Build to run their own compaction at the
// admission budget or advisory working target; Antigravity renews only after
// a complete checkpoint and bounded tail are prepared.
// Real Product/Chat/Transcript stores and Coordinator; only the CLI is a fixture.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { nativeCompaction, selfManagedCompaction, runtimeContextCapabilities,
  unknownRuntimeContextUsage } = require("../app/agent-service/runtime-context-usage");

const WINDOW = 100_000;

async function openRuntime(runtime, decorate = () => {}) {
  const f = await openHandoffFixture();
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: true } });
  if (!f.binding(runtime)) {
    f.service.productStore.addAgentRuntimeBinding(f.profile.id, { runtime,
      runtimeAccountId: DEFAULT_RUNTIME_ACCOUNTS.find(account => account.runtime === runtime).id },
    { operationId: `fixture-add-${runtime}` });
  }
  const coordinator = f.service.workRunCoordinator;
  coordinator.getRuntimeModelContextWindow = () => WINDOW;
  // The pre-compaction memory flush runs an isolated Codex generation the
  // fixture transport cannot provide; it is unrelated to the compaction route.
  coordinator.beforeMemoryCompaction = null;
  const manager = coordinator.runtimeManager, acquire = manager.acquire.bind(manager);
  manager.acquire = async (binding, options) => {
    const handle = await acquire(binding, options);
    if (binding.runtime === runtime && !handle.decorated) { handle.decorated = true; decorate(handle); }
    return handle;
  };
  const session = f.service.chatSessionStore.createSession({ operationId: `create-${crypto.randomUUID()}`,
    profileId: f.profile.id, workspace: f.workspace, createdAt: Date.now(), defaultBindingId: f.binding(runtime).id });
  return { f, coordinator, session };
}

// One completed turn binds the CLI session; then enough history to pass 80%.
async function underPressure({ f, session }, prefix) {
  const first = await f.send(session.sessionKey, `${prefix}-first`);
  assert.equal(first.status, "running", first.errorCode);
  await f.complete(first);
  const current = f.service.chatSessionStore.getSession(session.sessionKey);
  for (let n = 0; n < 8; n++) f.service.transcriptStore.appendEvent({ profileId: current.profileId, sessionId: current.id,
    id: `${prefix}-history-${n}`, kind: n % 2 ? "assistant" : "user", content: { text: `${"ordinary words ".repeat(3400)}` } });
  return current;
}

async function sendNext(coordinator, sessionKey, operationId) {
  const ack = await coordinator.send({ sessionKey, operationId, prompt: "Continue the work" });
  await waitUntil(() => ["running", "failed"].includes(coordinator.getRun(ack.run.id).status), 15000, `${operationId} admission`);
  return coordinator.getRun(ack.run.id);
}

const compactionRuns = coordinator => coordinator.dispatcher.listRuns({ source: "compaction" });
const compactedMarkers = (f, session) => f.service.transcriptStore.listEvents(session.profileId, session.id)
  .filter(event => event.content?.transcriptType === "context.native.compacted");

test("compaction modes: OpenCode and Codex by command, Grok Build and Pi by turn, Antigravity self-managed", () => {
  assert.deepEqual(nativeCompaction("opencode"), { mode: "command", automatic: true });
  assert.deepEqual(nativeCompaction("codex"), { mode: "command", automatic: true });
  assert.deepEqual(nativeCompaction("grok-build"), { mode: "turn", automatic: true });
  assert.deepEqual(nativeCompaction("pi"), { mode: "turn", automatic: false });
  for (const runtime of ["antigravity", "claude-code", "deepseek-harness", "constructor", "__proto__"]) {
    assert.equal(nativeCompaction(runtime), null, runtime);
  }
  assert.equal(selfManagedCompaction("antigravity"), true);
  assert.equal(selfManagedCompaction("opencode"), false);
  for (const runtime of ["opencode", "grok-build"]) {
    assert.equal(runtimeContextCapabilities(runtime)["context.compact.native"], true, runtime);
    assert.equal(runtimeContextCapabilities(runtime)["context.compact.auto"], true, runtime);
  }
  assert.equal(runtimeContextCapabilities("antigravity")["context.compact.native"], false);
  assert.equal(runtimeContextCapabilities("antigravity")["context.compact.auto"], true);
});

test("OpenCode: the waiting input runs once after one native compaction command", async () => {
  let commands = 0;
  const fixture = await openRuntime("opencode", handle => {
    handle.capabilities = { "context.compact.native": true };
    handle.commandExecute = async ({ text, sessionId }) => {
      commands++;
      assert.equal(text, "/compact");
      handle.host.emit({ known: true, type: "context_compacted", threadId: sessionId,
        contextUsage: unknownRuntimeContextUsage(sessionId) });
      return { kind: "output", text: "OpenCode conversation compacted.", warning: null };
    };
  });
  const { f, coordinator, session } = fixture;
  try {
    const current = await underPressure(fixture, "opencode");
    const run = await sendNext(coordinator, session.sessionKey, "opencode-next");
    assert.equal(run.status, "running", run.errorCode);
    assert.equal(commands, 1);
    const [compact] = compactionRuns(coordinator);
    assert.equal(compact.status, "completed");
    assert.equal(compact.resultSummary, "Conversation context compacted.");
    assert.ok(compactedMarkers(f, current).length >= 1, "the command records its compaction boundary");
    await f.complete(run);
    // The boundary keeps later estimates low: no second compaction.
    const later = await sendNext(coordinator, session.sessionKey, "opencode-later");
    assert.equal(later.status, "running", later.errorCode);
    assert.equal(commands, 1);
    await f.complete(later);
  } finally { await f.close(); }
});

test("OpenCode: a failed compaction rejects waiting input until an explicit /compact succeeds", async () => {
  let fail = true, opened = null;
  const fixture = await openRuntime("opencode", handle => {
    opened = handle;
    handle.capabilities = { "context.compact.native": true };
    handle.commandExecute = async ({ sessionId }) => {
      if (fail) throw Object.assign(new Error("fixture summarize failed"), { code: "RUNTIME_PROTOCOL_INVALID" });
      handle.host.emit({ known: true, type: "context_compacted", threadId: sessionId,
        contextUsage: unknownRuntimeContextUsage(sessionId) });
      return { kind: "output", text: "OpenCode conversation compacted.", warning: null };
    };
  });
  const { f, coordinator, session } = fixture;
  try {
    await underPressure(fixture, "opencode-fail");
    const rejected = await sendNext(coordinator, session.sessionKey, "opencode-fail-next");
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.errorCode, "RUNTIME_COMPACTION_ACCEPTANCE_UNKNOWN");
    assert.equal(rejected.runtimeTurnRef, null, "the input never reached the CLI");
    const blocked = await sendNext(coordinator, session.sessionKey, "opencode-fail-blocked");
    assert.equal(blocked.errorCode, "RUNTIME_COMPACTION_ACCEPTANCE_UNKNOWN");
    fail = false;
    // An unconfirmed compaction stops its host; the next acquire is a restarted
    // host that still owns the persisted CLI session.
    opened.terminated = new Promise(() => {});
    const manual = await f.send(session.sessionKey, "opencode-manual-compact", "/compact");
    assert.equal(manual.status, "completed", manual.errorCode);
    const released = await sendNext(coordinator, session.sessionKey, "opencode-after-manual");
    assert.equal(released.status, "running", released.errorCode);
    await f.complete(released);
  } finally { await f.close(); }
});

test("Grok Build: /compact runs as one native command turn and its compacted notice releases the input", async () => {
  let commands = 0;
  const fixture = await openRuntime("grok-build", handle => {
    handle.capabilities = { "context.compact.native": true };
    handle.commandExecute = async ({ text }) => { commands++; return { kind: "send", text, warning: null }; };
  });
  const { f, coordinator, session } = fixture;
  try {
    const current = await underPressure(fixture, "grok");
    const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "grok-next", prompt: "Continue the work" });
    await waitUntil(() => compactionRuns(coordinator).some(run => run.status === "running" && run.runtimeTurnRef),
      5000, "compaction turn");
    const [compact] = compactionRuns(coordinator);
    const host = f.transport.hosts.get("grok-build");
    const thread = host.threads.find(item => item.id === compact.runtimeSessionRef.sessionId);
    assert.equal(host.lastTurnStartParams.prompt, "/compact", "the CLI receives the bare built-in command");
    host.emit({ known: true, type: "context_compacted", threadId: thread.id, turnId: compact.runtimeTurnRef.turnId,
      contextUsage: unknownRuntimeContextUsage(thread.id) });
    await f.complete(compact, "Conversation compacted.");
    await waitUntil(() => coordinator.getRun(ack.run.id).status === "running", 5000, "released input");
    assert.equal(commands, 1);
    assert.equal(compactedMarkers(f, current).length, 1);
    await f.complete(coordinator.getRun(ack.run.id));
  } finally { await f.close(); }
});

test("Antigravity: the planning budget does not refuse input; the CLI compacts internally", async () => {
  const fixture = await openRuntime("antigravity");
  const { f, coordinator, session } = fixture;
  try {
    await underPressure(fixture, "antigravity");
    const run = await sendNext(coordinator, session.sessionKey, "antigravity-next");
    assert.equal(run.status, "running", run.errorCode);
    assert.equal(compactionRuns(coordinator).length, 0);
    await f.complete(run);
  } finally { await f.close(); }
});

async function workingHistory(f, coordinator, session, prefix) {
  coordinator.getRuntimeModelContextWindow = () => 1000000;
  await f.complete(await f.send(session.sessionKey, `${prefix}-first`));
  for (let n = 0; n < 14; n++) f.service.transcriptStore.appendEvent({ profileId: session.profileId, sessionId: session.id,
    id: `${prefix}-old-${n}`, kind: n % 2 ? "assistant" : "user", content: { text: `SOURCE_${n} ${"ordinary words ".repeat(3400)}` } });
  return f.service.chatSessionStore.getSession(session.sessionKey);
}

function authorizedSummary(f, coordinator, failAt = Infinity) {
  const { SUMMARY_FIELDS } = require("../app/agent-service/conversation-checkpoint-store");
  const policy = coordinator.runtimeSelectionPolicyStore.get(f.profile.id);
  coordinator.runtimeSelectionPolicyStore.set(f.profile.id, { ...policy, compactionBindingId: f.binding("pi").id });
  const manager = coordinator.runtimeManager, acquire = manager.acquire.bind(manager);
  manager.canGenerateModelOnly = runtime => runtime === "pi";
  let calls = 0;
  manager.acquire = async (...args) => {
    const handle = await acquire(...args);
    if (args[0].runtime === "pi") {
      handle.capabilities = { ...handle.capabilities, "model.generate.toolFree": true };
      handle.generateModelOnly = async input => {
        calls++;
        if (calls >= failAt) throw Object.assign(new Error("summary failure"), { code: "MODEL_ONLY_OUTPUT_INVALID" });
        const summary = Object.fromEntries(SUMMARY_FIELDS.map(field => [field, []]));
        summary.constraints = ["SOURCE_0 must remain available; current task only"];
        return { text: JSON.stringify(summary), model: input.model || "fixture-model" };
      };
    }
    return handle;
  };
  return () => calls;
}

for (const behavior of ["success", "unavailable", "failure", "later-failure"]) {
  test(`Antigravity working target: ${behavior} prepares a bounded checkpoint before retiring the source`, async () => {
    const { f, coordinator, session } = await openRuntime("antigravity");
    try {
      const old = await workingHistory(f, coordinator, session, `working-${behavior}`);
      const calls = behavior === "unavailable" ? () => 0 : authorizedSummary(f, coordinator,
        behavior === "failure" ? 1 : behavior === "later-failure" ? 2 : Infinity);
      const run = await sendNext(coordinator, session.sessionKey, `working-${behavior}-next`);
      assert.equal(run.status, "running", run.errorCode);
      const current = f.service.chatSessionStore.getSession(session.sessionKey);
      if (behavior === "success") {
        assert.notEqual(current.runtimeSessionId, old.runtimeSessionId);
        assert.equal(current.runtimeBindingId, old.runtimeBindingId);
        assert.equal(current.permissionMode, old.permissionMode);
        assert.equal(current.retiredRuntimeSessions.length, old.retiredRuntimeSessions.length + 1);
        assert.ok(calls() > 1, "multiple summary segments finished before renewal");
        const contract = f.transport.acquisitions.at(-1).options.executionContract;
        assert.equal(contract.contextRequest.historyTruncated, false);
        assert.deepEqual(contract.contextRequest.restorePolicy, { kind: "working_target", retainedTokens: 24000 });
        const snapshot = coordinator.contextCompiler.snapshotStore.get(f.profile.id, contract.contextSnapshotId);
        const history = snapshot.blocks.filter(block => block.kind === "transcript").map(block => block.content).join("\n\n");
        assert.ok(require("../app/agent-service/conversation-context-budget").estimateContextTokens(history) <= 24000);
        assert.match(contract.dynamicContext, /SOURCE_0/u);
        assert.match(contract.dynamicContext, /SOURCE_13/u);
      } else {
        assert.equal(current.runtimeSessionId, old.runtimeSessionId, "failed preparation preserves old native history");
        assert.equal(current.retiredRuntimeSessions.length, old.retiredRuntimeSessions.length);
        if (behavior === "later-failure") assert.equal(calls(), 2, "a completed first segment did not retire the source");
      }
      const attempts = calls();
      await f.complete(run);
      const next = await sendNext(coordinator, session.sessionKey, `working-${behavior}-later`);
      assert.equal(next.status, "running", next.errorCode);
      assert.equal(calls(), attempts, "no second renewal on the next input");
      assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId, current.runtimeSessionId);
      if (behavior === "success") assert.ok(f.transport.acquisitions.at(-1).options.executionContract.contextRequest.estimatedTokens < 160000,
        "native estimate counts the actual seed, not all retired original history");
      assert.equal(f.service.transcriptStore.listEvents(session.profileId, session.id).filter(e => e.id.startsWith(`working-${behavior}-old-`)).length, 14);
      await f.complete(next);
    } finally { await f.close(); }
  });
}

for (const runtime of ["opencode", "grok-build"]) {
  for (const outcome of ["success", "failure", "unknown", "timeout", "unsupported"]) {
    test(`${runtime} advisory working target: ${outcome} never replays maintenance or input`, async () => {
      let commands = 0;
      const fixture = await openRuntime(runtime, handle => {
        handle.capabilities = { "context.compact.native": outcome !== "unsupported" };
        handle.commandExecute = async ({ text, sessionId }) => {
          commands++;
          assert.equal(text, "/compact");
          if (outcome === "failure") throw Object.assign(new Error("fixture failure"), { code: "RUNTIME_COMMAND_PARAMS_INVALID" });
          if (runtime === "opencode") {
            if (outcome === "unknown") throw new Error("acceptance unknown");
            if (outcome === "success") handle.host.emit({ known: true, type: "context_compacted", threadId: sessionId });
            return { kind: "output", text: "", warning: null };
          }
          return { kind: "send", text, warning: null };
        };
        const turnStart = handle.turnStart;
        handle.turnStart = async input => {
          if (input.prompt === "/compact" && outcome === "unknown") {
            throw Object.assign(new Error("acceptance unknown"), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
          }
          return turnStart(input);
        };
      });
      const { f, coordinator, session } = fixture;
      try {
        await workingHistory(f, coordinator, session, `${runtime}-${outcome}`);
        coordinator.manualCompactionTimeoutMs = outcome === "timeout" ? 50 : 5000;
        const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: `${runtime}-${outcome}-next`, prompt: "current input" });
        if (runtime === "grok-build" && outcome === "success") {
          await waitUntil(() => compactionRuns(coordinator)[0]?.status === "running", 5000, "native turn compact");
          const compact = compactionRuns(coordinator)[0];
          f.transport.hosts.get(runtime).emit({ known: true, type: "context_compacted", threadId: compact.runtimeSessionRef.sessionId,
            turnId: compact.runtimeTurnRef.turnId });
          await f.complete(compact);
        }
        await waitUntil(() => ["running", "failed"].includes(coordinator.getRun(ack.run.id).status), 10000, "advisory input admission");
        const run = coordinator.getRun(ack.run.id);
        assert.equal(run.status, "running", run.errorCode);
        assert.equal(commands, outcome === "unsupported" ? 0 : 1);
        assert.equal(compactionRuns(coordinator).length, 1);
        const host = f.transport.hosts.get(runtime);
        assert.equal(host.threads.flatMap(thread => thread.turns).filter(turn => turn.items.some(item => item.clientId === `${runtime}-${outcome}-next`)).length, 1);
        await f.complete(run);
        const later = await sendNext(coordinator, session.sessionKey, `${runtime}-${outcome}-later`);
        assert.equal(later.status, "running", later.errorCode);
        assert.equal(commands, outcome === "unsupported" ? 0 : 1);
        await f.complete(later);
      } finally { await f.close(); }
    });
  }
}

for (const behavior of ["success", "unavailable", "seed-gap"]) {
  test(`Antigravity working target restart ${behavior}: persists seed or pause without native replay`, async () => {
    const fixture = await openRuntime("antigravity");
    let { f } = fixture;
    const { coordinator, session } = fixture;
    try {
      await workingHistory(f, coordinator, session, `restart-${behavior}`);
      if (behavior !== "unavailable") authorizedSummary(f, coordinator);
      const append = f.service.transcriptStore.appendEvent.bind(f.service.transcriptStore);
      if (behavior === "seed-gap") f.service.transcriptStore.appendEvent = event => {
        if (event.content?.transcriptType === "context.native.seeded") return event;
        return append(event);
      };
      const run = await sendNext(coordinator, session.sessionKey, `restart-${behavior}-next`);
      assert.equal(run.status, "running", run.errorCode);
      const current = f.service.chatSessionStore.getSession(session.sessionKey);
      const raw = f.transport.hosts.get("antigravity"), starts = raw.turnStartCalls;
      if (behavior === "seed-gap") {
        const turn = raw.threads.find(t => t.id === run.runtimeSessionRef.sessionId).turns.find(t => t.id === run.runtimeTurnRef.turnId);
        turn.status = "completed";
        turn.items.push({ type: "agentMessage", id: "while-offline", text: "Accepted before the crash." });
      } else await f.complete(run);
      const root = f.root, transport = f.transport;
      await f.close({ remove: false });
      f = await openHandoffFixture({ root, transport });
      const after = f.service.workRunCoordinator;
      after.beforeMemoryCompaction = null;
      after.getRuntimeModelContextWindow = () => 1000000;
      await after.waitForIdle(run.id);
      assert.equal(f.transport.hosts.get("antigravity").turnStartCalls, starts, "recovery never resends the accepted turn");
      const next = await sendNext(after, session.sessionKey, `restart-${behavior}-later`);
      assert.equal(next.status, "running", next.errorCode);
      assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId, current.runtimeSessionId);
      if (behavior !== "unavailable") {
        assert.ok(f.transport.acquisitions.at(-1).options.executionContract.contextRequest.estimatedTokens < 160000);
        assert.equal(f.service.transcriptStore.listEvents(session.profileId, session.id)
          .filter(event => event.content?.transcriptType === "context.native.seeded").length, 1);
      }
      await f.complete(next);
    } finally { await f.close(); }
  });
}

test("Antigravity working target uses an already complete checkpoint without a summary binding", async () => {
  const { f, coordinator, session } = await openRuntime("antigravity");
  try {
    const old = await workingHistory(f, coordinator, session, "existing-checkpoint");
    const calls = authorizedSummary(f, coordinator);
    await coordinator.prepareRuntimeHandoff(old, f.binding("antigravity"), { beforeSend: true,
      restorePolicy: { kind: "working_target", retainedTokens: 24000 }, advisory: true, memoryPrepared: true });
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId, old.runtimeSessionId);
    const count = calls();
    coordinator.runtimeManager.canGenerateModelOnly = () => false;
    const run = await sendNext(coordinator, session.sessionKey, "existing-checkpoint-next");
    assert.equal(run.status, "running", run.errorCode);
    assert.notEqual(f.service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId, old.runtimeSessionId);
    assert.equal(calls(), count);
    await f.complete(run);
  } finally { await f.close(); }
});

for (const boundary of ["before-cas", "after-cas", "binding-created"]) {
  test(`Antigravity working target crash ${boundary} preserves source authority and sends input once`, async () => {
    const fixture = await openRuntime("antigravity");
    let { f } = fixture;
    const { coordinator, session } = fixture;
    try {
      const old = await workingHistory(f, coordinator, session, `crash-${boundary}`);
      authorizedSummary(f, coordinator);
      const store = f.service.chatSessionStore;
      const method = boundary === "binding-created" ? "completeBinding" : "switchRuntime";
      const original = store[method].bind(store);
      let cut = false;
      store[method] = (...args) => {
        if (cut) return original(...args);
        cut = true;
        if (boundary === "before-cas") {
          void coordinator.close().catch(() => {});
          throw Object.assign(new Error("crash before CAS"), { code: "WORK_RUN_COORDINATOR_CLOSING" });
        }
        const result = original(...args);
        void coordinator.close().catch(() => {});
        return result;
      };
      const operationId = `crash-${boundary}-next`;
      try { await coordinator.send({ sessionKey: session.sessionKey, operationId, prompt: "CURRENT INPUT ONCE" }); }
      catch (error) { assert.match(error.code, /^WORK_RUN_COORDINATOR_/u); }
      await waitUntil(() => cut, 15000, "crash boundary");
      await coordinator.close();
      const atCut = f.service.chatSessionStore.getSession(session.sessionKey);
      if (boundary === "before-cas") assert.equal(atCut.runtimeSessionId, old.runtimeSessionId);
      else assert.equal(atCut.retiredRuntimeSessions.at(-1).runtimeSessionId, old.runtimeSessionId);
      const root = f.root, transport = f.transport;
      await f.close({ remove: false });
      f = await openHandoffFixture({ root, transport });
      const after = f.service.workRunCoordinator;
      after.beforeMemoryCompaction = null;
      after.getRuntimeModelContextWindow = () => 1000000;
      const run = after.getChatRunByOperation(operationId, session.sessionKey);
      await waitUntil(() => ["running", "failed", "interrupted", "completed"].includes(after.getRun(run.id).status), 10000, "recovered input");
      const current = f.service.chatSessionStore.getSession(session.sessionKey);
      if (boundary === "before-cas") assert.equal(current.runtimeSessionId, old.runtimeSessionId);
      else assert.notEqual(current.runtimeSessionId, old.runtimeSessionId);
      const raw = f.transport.hosts.get("antigravity");
      assert.equal(raw.threads.flatMap(thread => thread.turns).filter(turn => turn.items.some(item => item.clientId === operationId)).length, 1);
      assert.equal(after.getRun(run.id).status, "running");
      await f.complete(after.getRun(run.id));
      if (boundary !== "before-cas") assert.ok(f.transport.acquisitions.at(-1).options.executionContract.contextRequest.restorePolicy);
    } finally { await f.close(); }
  });
}

test("maintenance receipts cannot relabel required runs or change an attempt's native owner", () => {
  const { maintenanceRecords, workingRestorePolicy } = require("../app/agent-service/context-transfer");
  const source = { nativeSessionId: "old-native", bindingId: "binding", runtime: "antigravity",
    runtimeAccountId: "account", runtimeProfileId: "profile" };
  const record = { version: 1, id: `working-context-${"a".repeat(64)}`, action: "session_renewal", advisory: true,
    state: "ready", waitingRunId: "waiting", scope: source, sourceSessionRevision: 1,
    baseline: { usedTokens: 180000, throughSeq: 20 }, snapshotId: "prepared",
    restorePolicy: { kind: "working_target", retainedTokens: 24000 } };
  const event = value => ({ seq: 21, occurredAt: 1, kind: "status", contextExcluded: true,
    content: { transcriptType: "context.maintenance", maintenance: value } });
  const transfer = { kind: "status", contextExcluded: true, content: { transcriptType: "context.transfer",
    transfer: { state: "ready", sourceSessionRevision: 1, snapshotId: "prepared" } } };
  const store = { listEvents: () => [event(record), transfer] };
  const session = { revision: 2, runtimeSessionId: null, runtimeBindingId: "binding",
    retiredRuntimeSessions: [{ runtimeSessionId: "old-native", runtime: "antigravity", runtimeAccountId: "account" }] };
  const profile = { runtime: "antigravity", runtimeAccountId: "account", runtimeProfileId: "profile" };
  assert.deepEqual(workingRestorePolicy(store, session, profile), record.restorePolicy);
  assert.equal(workingRestorePolicy(store, session, { ...profile, runtimeAccountId: "other" }), null);
  assert.throws(() => maintenanceRecords([event({ ...record, action: "native_compaction", id: `native-compaction-${"b".repeat(64)}` })]),
    { code: "CONTEXT_MAINTENANCE_INVALID" });
  assert.throws(() => maintenanceRecords([event(record), event({ ...record, scope: { ...source, nativeSessionId: "other" } })]),
    { code: "CONTEXT_MAINTENANCE_INVALID" });
  assert.throws(() => maintenanceRecords([event({ ...record, restorePolicy: { kind: "working_target", retainedTokens: 1000000 } })]),
    { code: "CONTEXT_MAINTENANCE_INVALID" });
});

for (const complete of [true, false]) {
  test(`Antigravity working target oversized record ${complete ? "completes" : "fails partway"} before source retirement`, async () => {
    const { f, coordinator, session } = await openRuntime("antigravity");
    try {
      coordinator.getRuntimeModelContextWindow = () => 1000000;
      await f.complete(await f.send(session.sessionKey, `large-first-${complete}`));
      const old = f.service.chatSessionStore.getSession(session.sessionKey);
      const original = `SOURCE_BIG ${"ordinary words ".repeat(45000)}`;
      const event = f.service.transcriptStore.appendEvent({ profileId: session.profileId, sessionId: session.id,
        id: `large-record-${complete}`, kind: "assistant", content: { text: original } });
      // The first segment covers the small initial dialogue; the second
      // commits the beginning of the large record, and the third fails.
      const calls = authorizedSummary(f, coordinator, complete ? Infinity : 3);
      const run = await sendNext(coordinator, session.sessionKey, `large-next-${complete}`);
      assert.equal(run.status, "running", run.errorCode);
      const checkpoint = coordinator.conversationCheckpointStore.compatible(session.profileId, session.id);
      const current = f.service.chatSessionStore.getSession(session.sessionKey);
      assert.ok(calls() >= 2);
      if (complete) {
        assert.equal(checkpoint.partial, null);
        assert.ok(checkpoint.coveredThroughSeq >= event.seq);
        assert.notEqual(current.runtimeSessionId, old.runtimeSessionId);
      } else {
        assert.ok(checkpoint.partial, "only a partial checkpoint was produced");
        assert.equal(current.runtimeSessionId, old.runtimeSessionId);
      }
      const saved = f.service.transcriptStore.listEvents(session.profileId, session.id).find(row => row.id === event.id);
      assert.equal(f.service.transcriptStore.contextEvent(session.profileId, session.id, saved).content.text, original);
      await f.complete(run);
    } finally { await f.close(); }
  });
}
