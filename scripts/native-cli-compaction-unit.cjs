"use strict";
// Shoggoth asks OpenCode / Grok Build to run their own compaction at the
// effective admission budget; Antigravity renews only after
// a complete checkpoint and bounded tail are prepared.
// Real Product/Chat/Transcript stores and Coordinator; only the CLI is a fixture.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { normalizeCodexEvent } = require("../app/agent-service/codex-event-normalizer");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { nativeCompaction, selfManagedCompaction, runtimeContextCapabilities,
  unknownRuntimeContextUsage } = require("../app/agent-service/runtime-context-usage");

const WINDOW = 100_000;

async function openRuntime(runtime, decorate = () => {}) {
  const f = await openHandoffFixture(runtime === "codex" ? { catalogs: { codex: ["fixture-model"] } } : {});
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
  const decorated = new WeakSet();
  manager.acquire = async (binding, options) => {
    const handle = await acquire(binding, options);
    if (binding.runtime === runtime && !decorated.has(handle)) { decorated.add(handle); decorate(handle); }
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
// A failed summary or native compaction serves a waiting input; that input owns
// the visible outcome. Its own terminal stays in the journal, out of the chat.
function assertMaintenanceFailuresHidden(f, session) {
  const { transcriptHistoryItem } = require("../app/agent-service/chat-service-controller");
  const failures = f.service.transcriptStore.listEvents(session.profileId, session.id)
    .filter(event => event.kind === "error" && event.content?.transcriptType === "terminal"
      && /^(?:native-compaction-|compaction-)/u.test(event.runId || ""));
  for (const event of failures) {
    assert.equal(event.contextExcluded, true, `${event.runId} ${event.content.errorCode} stays out of the conversation`);
    assert.equal(transcriptHistoryItem(event, "compaction"), null, `${event.content.errorCode} is not rendered`);
  }
  return failures.length;
}

test("compaction modes: OpenCode and Codex by command, Grok Build, Claude Code, Pi and DeepSeek by turn, Antigravity self-managed", () => {
  assert.deepEqual(nativeCompaction("opencode"), { mode: "command", automatic: true });
  assert.deepEqual(nativeCompaction("codex"), { mode: "command", automatic: true });
  assert.deepEqual(nativeCompaction("grok-build"), { mode: "turn", automatic: true });
  assert.deepEqual(nativeCompaction("claude-code"), { mode: "turn", automatic: true });
  assert.deepEqual(nativeCompaction("pi"), { mode: "turn", automatic: false });
  assert.deepEqual(nativeCompaction("deepseek-harness"), { mode: "turn", automatic: false });
  for (const runtime of ["antigravity", "constructor", "__proto__"]) {
    assert.equal(nativeCompaction(runtime), null, runtime);
  }
  assert.equal(selfManagedCompaction("antigravity"), true);
  assert.equal(selfManagedCompaction("opencode"), false);
  for (const runtime of ["opencode", "grok-build", "claude-code"]) {
    assert.equal(runtimeContextCapabilities(runtime)["context.compact.native"], true, runtime);
    assert.equal(runtimeContextCapabilities(runtime)["context.compact.auto"], true, runtime);
  }
  assert.equal(runtimeContextCapabilities("antigravity")["context.compact.native"], false);
  assert.equal(runtimeContextCapabilities("antigravity")["context.compact.auto"], true);
});

for (const terminal of ["completed", "failed"]) {
  test(`Codex: the 380000-token budget waits for its own compaction turn to be ${terminal}`, async () => {
    let commands = 0;
    const { f, coordinator, session } = await openRuntime("codex", handle => {
      handle.host.threadCompactStart = async () => { commands++; return {}; };
    });
    try {
      coordinator.getRuntimeModelContextWindow = () => 475000;
      coordinator.getRuntimeModelContextLimits = () => ({ inputTokens: 380000 });
      const first = await f.send(session.sessionKey, `budget-${terminal}-first`);
      assert.equal(first.status, "running", first.errorCode);
      const native = first.runtimeSessionRef.sessionId;
      const host = f.transport.hosts.get("codex");
      const usage = usedTokens => host.emit({ known: true, type: "context_usage", threadId: native,
        contextUsage: { runtimeSessionId: native, usedTokens, contextWindow: 475000,
          quality: "exact", source: "runtime_event", observedAt: Date.now() } });
      usage(380000);
      await f.complete(first);
      const ack = await coordinator.send({ sessionKey: session.sessionKey,
        operationId: `budget-${terminal}-next`, prompt: "Continue the work" });
      await waitUntil(() => commands === 1, 5000, "required native compaction");
      assert.equal(coordinator.getRuntimeContext(f.service.chatSessionStore.getSession(session.sessionKey))
        .productContext.budget.triggerTokens, 380000);
      const compact = compactionRuns(coordinator)[0];
      assert.equal(coordinator.getRun(ack.run.id).status, "queued");
      assert.equal(coordinator.runQueueStates.get(ack.run.id)?.reason, "CONTEXT_COMPACTING",
        "native maintenance explains the wait instead of claiming another chat is queued");
      usage(50000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(coordinator.getRun(compact.id).status, "running", "a new meter cannot finish required compaction");
      assert.equal(host.turnStartCalls, 1, "the queued input has not reached the CLI");
      const turnId = `compact-budget-${terminal}`;
      host.emit(normalizeCodexEvent({ method: "item/completed", params: { threadId: native, turnId,
        item: { id: "budget-compact-item", type: "contextCompaction" } } }));
      host.emit(normalizeCodexEvent({ method: "turn/completed", params: { threadId: native,
        turn: { id: "other-budget-turn", status: "completed" } } }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(coordinator.getRun(ack.run.id).status, "queued", "a compact item or unrelated turn cannot release input");
      host.emit(normalizeCodexEvent({ method: "turn/completed", params: { threadId: native,
        turn: { id: turnId, status: terminal } } }));
      await waitUntil(() => ["running", "failed"].includes(coordinator.getRun(ack.run.id).status), 5000, "post-compaction admission");
      const run = coordinator.getRun(ack.run.id);
      // A failed compact renews the thread instead of refusing the input.
      assert.equal(run.status, "running", run.errorCode);
      assert.equal(commands, 1);
      // After a failed compact the host is stopped; the renewed thread may start on a new one.
      assert.equal(host.turnStartCalls, terminal === "completed" ? 2 : 1, "the full thread never receives the input");
      if (terminal === "completed") {
        assert.equal(compactedMarkers(f, session).length, 1, "native event and command completion share one boundary");
        host.emit(normalizeCodexEvent({ method: "thread/compacted", params: { threadId: native, turnId } }));
        assert.equal(compactedMarkers(f, session).length, 1, "a repeated native cycle cannot add another notice");
        await f.complete(run);
      }
      else {
        assert.match(compactionRuns(coordinator)[0].errorCode, /^RUNTIME_COMPACTION_/u);
        assert.equal(compactedMarkers(f, session).length, 0, "an item receipt without a successful terminal cannot claim completion");
        assert.notEqual(run.runtimeSessionRef.sessionId, native, "the input ran on a renewed thread");
        await f.complete(run);
      }
    } finally { await f.close(); }
  });
}

async function recoveringCodexCompaction() {
  const state = { armed: false, failures: 0, attempts: 0, commands: 0, error: null };
  const decorate = handle => {
    const compactHandle = Object.create(handle);
    compactHandle.accountRead = async input => {
      if (state.armed) {
        state.attempts++;
        // Codex reports a genuine sign-out as a successful account/read result.
        if (state.error?.code === "RUNTIME_AUTH_REQUIRED") return { account: null, requiresOpenaiAuth: true };
        if (state.failures-- > 0) throw state.error;
      }
      return handle.accountRead(input);
    };
    handle.host.threadCompactStart = async ({ threadId }) => {
      state.commands++;
      state.armed = false;
      const turnId = `auth-recovery-compact-${state.commands}`;
      setImmediate(() => {
        handle.host.emit(normalizeCodexEvent({ method: "item/completed", params: { threadId, turnId,
          item: { id: `item-${turnId}`, type: "contextCompaction" } } }));
        handle.host.emit(normalizeCodexEvent({ method: "turn/completed", params: { threadId,
          turn: { id: turnId, status: "completed" } } }));
      });
      return {};
    };
    return compactHandle;
  };
  const install = coordinator => {
    const manager = coordinator.runtimeManager, acquire = manager.acquire.bind(manager), wrapped = new WeakMap();
    manager.acquire = async (binding, options) => {
      const handle = await acquire(binding, options);
      // Readiness and memory tasks share the Codex host. Fail only the
      // compaction authentication call, leaving those independent probes real.
      if (options?.executionContract?.source !== "compaction") return handle;
      if (!wrapped.has(handle)) wrapped.set(handle, decorate(handle));
      return wrapped.get(handle);
    };
  };
  const fixture = await openRuntime("codex");
  const { f, session } = fixture;
  install(fixture.coordinator);
  const first = await f.send(session.sessionKey, "auth-recovery-first");
  assert.equal(first.status, "running", first.errorCode);
  const host = [...f.transport.handles.values()].find(handle => handle.host.threads
    .some(thread => thread.id === first.runtimeSessionRef.sessionId)).host;
  host.emit({ known: true, type: "context_usage", threadId: first.runtimeSessionRef.sessionId,
    contextUsage: { runtimeSessionId: first.runtimeSessionRef.sessionId, usedTokens: WINDOW,
      contextWindow: WINDOW, quality: "exact", source: "runtime_event", observedAt: Date.now() } });
  await f.complete(first);
  return { ...fixture, host, state, install,
    arm(failures, code = "RPC_REMOTE_ERROR") {
      Object.assign(state, { armed: true, failures, attempts: 0,
        error: Object.assign(new Error("private-auth-recovery-diagnostic"), { code }) });
    },
  };
}

test("Codex: a Binding whose CLI cannot isolate a summary goes straight to native compaction", async () => {
  const fixture = await openRuntime("codex");
  const { f, coordinator, session } = fixture;
  const seen = [];
  // Type level Codex summarizes; this Binding's observed CLI (0.159.2) cannot.
  coordinator.runtimeManager.canGenerateModelOnly = (runtime, { binding = null } = {}) => {
    if (runtime === "codex") seen.push(binding);
    return runtime === "codex" && !binding;
  };
  try {
    await underPressure(fixture, "codex-unisolated");
    const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "codex-unisolated-next", prompt: "Continue the work" });
    await waitUntil(() => compactionRuns(coordinator).length > 0, 15000, "a maintenance run");
    const runs = compactionRuns(coordinator);
    assert.equal(runs.some(run => run.id.startsWith("compaction-")), false, "no product summary task is created");
    assert.equal(runs.some(run => run.id.startsWith("native-compaction-")), true, "native compaction takes over directly");
    const current = f.service.chatSessionStore.getSession(session.sessionKey);
    const binding = seen.find(Boolean);
    assert.equal(binding?.runtime, "codex", "the summary route asks with the Binding it would use");
    assert.ok(binding.runtimeProfileId && binding.runtimeAccountId);
    assert.equal(coordinator.getRun(ack.run.id).status, "queued", "the input waits for the native compaction");
    assert.equal(current.runtimeBindingId, f.binding("codex").id);
  } finally { await f.close(); }
});

test("Codex auth recovery keeps the same input queued, reports live/snapshot progress and sends it once", async () => {
  const fixture = await recoveringCodexCompaction();
  const { f, coordinator, session, state } = fixture;
  try {
    fixture.arm(2);
    const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "auth-recovery-input", prompt: "Continue" });
    await waitUntil(() => coordinator.runQueueStates.get(ack.run.id)?.stage === "reconnecting", 5000, "visible auth recovery");
    assert.equal(coordinator.getRun(ack.run.id).status, "queued");
    assert.equal(coordinator.getRunSnapshot(ack.run.id).queue?.stage, "reconnecting");
    assert.equal(state.commands, 0);
    assert.equal(fixture.host.turnStartCalls, 1);
    await waitUntil(() => coordinator.getRun(ack.run.id).status === "running", 10000, "automatic recovery and dispatch");
    assert.equal(state.attempts, 3);
    assert.equal(state.commands, 1);
    assert.equal(compactionRuns(coordinator).length, 1, "recovery retains the original compaction run");
    assert.equal(compactionRuns(coordinator)[0].status, "completed");
    assert.equal(fixture.host.turnStartCalls, 2);
    const replay = coordinator.subscribeRun(ack.run.id, { streamId: null, afterSeq: 0 }, () => {});
    replay.unsubscribe();
    const statuses = replay.events.filter(event => event.type === "status").map(event => event.payload);
    assert.ok(statuses.some(status => status.stage === "reconnecting"));
    assert.ok(statuses.some(status => status.reason === "CONTEXT_COMPACTING" && !status.stage));
    assert.ok(!replay.events.some(event => event.type === "terminal"), "transient errors never finish the input");
    assert.ok(!JSON.stringify(replay).includes("private-auth-recovery-diagnostic"));
    assert.ok(!f.service.transcriptStore.listEvents(session.profileId, session.id).some(event => event.kind === "error"));
    await f.complete(coordinator.getRun(ack.run.id));
  } finally { await f.close(); }
});

test("Codex auth recovery is bounded; the input then continues once on a renewed thread across restart", async () => {
  const fixture = await recoveringCodexCompaction();
  let { f, coordinator } = fixture;
  const { session, state } = fixture;
  try {
    fixture.arm(Infinity);
    const renewed = await sendNext(coordinator, session.sessionKey, "auth-exhausted-input");
    assert.equal(renewed.status, "running", "an undispatched compact that cannot recover renews the thread");
    assert.equal(state.attempts, 4, "three delayed retries exhaust the recovery window");
    assert.equal(state.commands, 0);
    const [compact] = compactionRuns(coordinator);
    assert.equal(compact.errorCode, "RUNTIME_START_RUNTIME_AUTHENTICATION_FAILED");
    for (const field of ["runtimeSessionRef", "runtimeTurnRef", "runtimeAttemptRef"]) assert.equal(compact[field], null);
    await f.complete(renewed);
    const root = f.root, transport = f.transport;
    await f.close({ remove: false });
    fixture.arm(0);
    f = await openHandoffFixture({ root, transport, catalogs: { codex: ["fixture-model"] } });
    coordinator = f.service.workRunCoordinator;
    coordinator.beforeMemoryCompaction = null;
    coordinator.getRuntimeModelContextWindow = () => WINDOW;
    fixture.install(coordinator);
    const recovered = await sendNext(coordinator, session.sessionKey, "auth-new-input-after-restart");
    assert.equal(recovered.status, "running", recovered.errorCode);
    assert.equal(state.commands, 0, "the renewed thread needs no compaction");
    assert.equal(compactionRuns(coordinator).length, 1, "restart never replays the failed compact");
    assert.equal(f.transport.hosts.get("codex").turnStartCalls, 3, "each input was sent exactly once");
    await f.complete(recovered);
  } finally { await f.close(); }
});

for (const code of ["RUNTIME_AUTH_REQUIRED", "CODEX_ACCOUNT_PROTOCOL_INVALID", "RUNTIME_TURN_ACCEPTANCE_UNKNOWN"]) {
  test(`Codex auth recovery does not retry ${code}`, async () => {
    const fixture = await recoveringCodexCompaction();
    const { f, coordinator, session, state } = fixture;
    try {
      fixture.arm(Infinity, code);
      const result = await sendNext(coordinator, session.sessionKey, `auth-blocked-${code}`);
      if (code === "RUNTIME_TURN_ACCEPTANCE_UNKNOWN") {
        // A compaction failure, not an account one: the thread is renewed.
        assert.equal(result.status, "running", result.errorCode);
        assert.equal(fixture.host.turnStartCalls, 2);
        await f.complete(result);
      } else {
        assert.equal(result.status, "failed");
        assert.equal(result.errorCode, code === "RUNTIME_AUTH_REQUIRED" ? "RUNTIME_AUTH_REQUIRED" : "RUNTIME_INCOMPATIBLE",
          "the waiting message preserves login/protocol remedies instead of renewing or recommending /compact");
        assert.equal(fixture.host.turnStartCalls, 1);
      }
      assert.equal(state.attempts, 1);
      assert.equal(state.commands, 0);
      assert.equal(coordinator.nativeCompactionAuthRecoveries.size, 0);
    } finally { await f.close(); }
  });
}

test("Codex cancel during auth recovery never sends the canceled input", async () => {
  const fixture = await recoveringCodexCompaction();
  const { f, coordinator, session, state } = fixture;
  try {
    fixture.arm(1);
    const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "auth-cancel-input", prompt: "Continue" });
    await waitUntil(() => coordinator.runQueueStates.get(ack.run.id)?.stage === "reconnecting", 5000, "recovery before cancel");
    await coordinator.abort({ operationId: "auth-cancel", sessionKey: session.sessionKey, runId: ack.run.id });
    await waitUntil(() => compactionRuns(coordinator)[0]?.status === "completed", 5000, "maintenance after input cancel");
    assert.equal(coordinator.getRun(ack.run.id).status, "canceled");
    assert.equal(state.commands, 1);
    assert.equal(fixture.host.turnStartCalls, 1);
    assert.equal(coordinator.nativeCompactionAuthRecoveries.size, 0);
  } finally { await f.close(); }
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
    assert.equal(compactedMarkers(f, current).length, 1, "the command records one compaction boundary");
    await f.complete(run);
    // The boundary keeps later estimates low: no second compaction.
    const later = await sendNext(coordinator, session.sessionKey, "opencode-later");
    assert.equal(later.status, "running", later.errorCode);
    assert.equal(commands, 1);
    await f.complete(later);
  } finally { await f.close(); }
});

test("OpenCode: a failed compaction renews the thread; an explicit /compact still works afterwards", async () => {
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
    const old = await underPressure(fixture, "opencode-fail");
    // An unconfirmed compaction stops its host; the next acquire is a restarted
    // host that still owns the persisted CLI session.
    opened.terminated = new Promise(() => {});
    const renewed = await sendNext(coordinator, session.sessionKey, "opencode-fail-next");
    assert.equal(renewed.status, "running", "an unconfirmed compact renews the thread instead of refusing");
    assert.equal(compactionRuns(coordinator)[0].status === "completed", false);
    assert.notEqual(renewed.runtimeSessionRef.sessionId, old.runtimeSessionId, "the input never reached the old thread");
    const boundary = f.service.transcriptStore.listEvents(old.profileId, old.id)
      .filter(event => event.content?.transcriptType === "context.renewed");
    assert.deepEqual(boundary.map(event => event.content.reason), ["required"]);
    assert.equal(boundary[0].content.runtimeSessionId, old.runtimeSessionId);
    await f.complete(renewed);
    fail = false;
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

test("Grok Build: the automatic native compaction resumes the chat thread with the rules that thread holds", async () => {
  const receipts = new Map(), resumed = [];
  const fixture = await openRuntime("grok-build", handle => {
    handle.capabilities = { "context.compact.native": true };
    handle.commandExecute = async ({ text }) => ({ kind: "send", text, warning: null });
    // Like Grok's native system-rule receipt: a thread keeps the rules it was
    // created with, and a resume with other rules is refused before sending.
    const start = handle.sessionStart, resume = handle.sessionResume;
    handle.sessionStart = async input => {
      const started = await start(input);
      receipts.set(started.session.id, input.developerInstructions ?? "");
      return started;
    };
    handle.sessionResume = async input => {
      resumed.push(input.developerInstructions ?? "");
      if (receipts.has(input.sessionId) && receipts.get(input.sessionId) !== (input.developerInstructions ?? "")) {
        throw Object.assign(new Error("Native system rules require a fresh session"),
          { code: "RUNTIME_SESSION_INSTRUCTIONS_CHANGED", acceptance: "not_sent", sessionId: input.sessionId });
      }
      return resume(input);
    };
  });
  const { f, coordinator, session } = fixture;
  try {
    const current = await underPressure(fixture, "grok-rules");
    assert.ok(receipts.get(current.runtimeSessionId)?.length > 0, "the chat thread recorded its rules");
    const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "grok-rules-next", prompt: "Continue the work" });
    await waitUntil(() => compactionRuns(coordinator).some(run => run.status === "running" && run.runtimeTurnRef),
      5000, "compaction turn on the chat thread");
    const [compact] = compactionRuns(coordinator);
    assert.equal(compact.runtimeSessionRef.sessionId, current.runtimeSessionId, "compacts the chat's own thread");
    assert.equal(f.service.transcriptStore.listEvents(current.profileId, current.id)
      .some(event => event.content?.transcriptType === "context.instructions.renewal"), false, "no rules renewal");
    f.transport.hosts.get("grok-build").emit({ known: true, type: "context_compacted", threadId: current.runtimeSessionId,
      turnId: compact.runtimeTurnRef.turnId, contextUsage: unknownRuntimeContextUsage(current.runtimeSessionId) });
    await f.complete(compact, "Conversation compacted.");
    await waitUntil(() => coordinator.getRun(ack.run.id).status === "running", 5000, "released input");
    const run = coordinator.getRun(ack.run.id);
    assert.equal(run.runtimeSessionRef.sessionId, current.runtimeSessionId, "the input continues on the compacted thread");
    assert.ok(resumed.length > 0 && resumed.every(rules => rules === receipts.get(current.runtimeSessionId)));
    await f.complete(run);
  } finally { await f.close(); }
});

for (const historical of [false, true]) test(`DeepSeek manual compact ${historical ? "renews a thread with historical sources instead of dispatching" : "uses one native command turn"}`, async () => {
  let commands = 0;
  const fixture = await openRuntime("deepseek-harness", handle => {
    handle.capabilities = require("../app/agent-service/deepseek-harness-runtime-adapter").DEEPSEEK_HARNESS_CAPABILITIES;
    handle.commandExecute = async ({ text }) => { commands++; return { kind: "send", text, warning: null }; };
  });
  const { f, coordinator, session } = fixture;
  try {
    const first = await f.send(session.sessionKey, `deepseek-seed-${historical}`);
    await f.complete(first);
    if (historical) coordinator.conversationCheckpointStore.hasHistoricalSource = () => true;
    const compact = await f.send(session.sessionKey, `deepseek-manual-${historical}`, "/compact");
    const host = f.transport.hosts.get("deepseek-harness");
    if (historical) {
      // The thread holds a historical memory source verbatim: /compact renews
      // it instead of summarizing it natively, and never reaches the CLI.
      assert.equal(compact.status, "completed", compact.errorCode);
      assert.equal(compact.resultSummary, "Conversation context renewed.");
      assert.equal(commands, 0, "unsafe history cannot enter the CLI command path");
      assert.equal(host.turnStartCalls, 1, "only the preceding ordinary turn was sent");
      const renewed = f.service.chatSessionStore.getSession(session.sessionKey);
      assert.equal(renewed.runtimeSessionId, null);
      assert.equal(renewed.retiredRuntimeSessions.at(-1).runtimeSessionId, first.runtimeSessionRef.sessionId);
    } else {
      assert.equal(compact.status, "running");
      assert.equal(commands, 1);
      assert.equal(host.lastTurnStartParams.prompt, "/compact");
      host.emit({ known: true, type: "context_compacted", threadId: compact.runtimeSessionRef.sessionId,
        turnId: compact.runtimeTurnRef.turnId, contextUsage: unknownRuntimeContextUsage(compact.runtimeSessionRef.sessionId) });
      await f.complete(compact, "Compacted native history.");
      const current = f.service.chatSessionStore.getSession(session.sessionKey);
      assert.equal(compactedMarkers(f, current).length, 1);
    }
  } finally { await f.close(); }
});

test("Antigravity: /compact renews the thread instead of sending the command to the model", async () => {
  const { f, session } = await openRuntime("antigravity");
  try {
    const first = await f.send(session.sessionKey, "antigravity-compact-first");
    await f.complete(first);
    const host = f.transport.hosts.get("antigravity"), starts = host.turnStartCalls;
    const compact = await f.send(session.sessionKey, "antigravity-manual-compact", "/compact");
    assert.equal(compact.status, "completed", compact.errorCode);
    assert.equal(compact.resultSummary, "Conversation context renewed.");
    assert.equal(host.turnStartCalls, starts, "the literal /compact never reaches the model");
    const renewed = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(renewed.runtimeSessionId, null);
    assert.equal(renewed.retiredRuntimeSessions.at(-1).runtimeSessionId, first.runtimeSessionRef.sessionId);
    // The switch has no output of its own: a model-excluded boundary shows it,
    // and history projects it as the renewal notice.
    const boundaries = f.service.transcriptStore.listEvents(renewed.profileId, renewed.id)
      .filter(event => event.content?.transcriptType === "context.renewed");
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].contextExcluded, true);
    assert.deepEqual(boundaries[0].content, { transcriptType: "context.renewed",
      runtimeSessionId: first.runtimeSessionRef.sessionId, reason: "manual" });
    const { transcriptHistoryItem } = require("../app/agent-service/chat-service-controller");
    assert.equal(transcriptHistoryItem(boundaries[0]).payload.message.notice, "contextRenewed");
    const next = await f.send(session.sessionKey, "antigravity-after-compact");
    assert.equal(next.status, "running", next.errorCode);
    assert.notEqual(next.runtimeSessionRef.sessionId, first.runtimeSessionRef.sessionId);
    await f.complete(next);
  } finally { await f.close(); }
});

test("Codex offers tool-free generation only for conversation summaries", () => {
  const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
  const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => ({}) } });
  assert.equal(adapter.modelOnly, true);
  assert.deepEqual(adapter.modelOnlyPurposes, ["conversation_compaction"]);
});

test("a thread's historical scope starts after a recent-originals seed and covers the session otherwise", () => {
  const { historicalScopeStart, maintenanceScope } = require("../app/agent-service/context-transfer");
  const scope = maintenanceScope({ runtimeSessionId: "native-1", runtimeBindingId: "binding-1" },
    { runtime: "codex", runtimeProfileId: "profile-1", runtimeAccountId: "account-1" });
  const seeded = (seq, partial, throughSeq) => ({ seq, contextExcluded: true, kind: "status", content: {
    transcriptType: "context.native.seeded", scope, partial, baseline: { usedTokens: 1, throughSeq, operationId: "op" } } });
  const user = seq => ({ seq, kind: "user", content: { text: "u" } });
  assert.equal(historicalScopeStart([user(1), user(2), seeded(4, true, 2), user(3)], scope), 2,
    "the seed record lands after the new thread's first user message");
  assert.equal(historicalScopeStart([user(1), seeded(3, false, 1)], scope), 0, "a complete seed may hold every source");
  assert.equal(historicalScopeStart([user(1)], scope), 0);
  assert.equal(historicalScopeStart([seeded(3, true, 1)], { ...scope, nativeSessionId: "other" }), 0, "another thread's seed");
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

async function workingHistory(f, coordinator, session, prefix, inputTokens = 128000) {
  coordinator.getRuntimeModelContextWindow = () => 1000000;
  coordinator.getRuntimeModelContextLimits = () => ({ inputTokens });
  const first = await f.send(session.sessionKey, `${prefix}-first`);
  assert.equal(first.status, "running", first.errorCode);
  await f.complete(first);
  for (let n = 0; n < 14; n++) f.service.transcriptStore.appendEvent({ profileId: session.profileId, sessionId: session.id,
    id: `${prefix}-old-${n}`, kind: n % 2 ? "assistant" : "user", content: { text: `SOURCE_${n} ${"ordinary words ".repeat(3400)}` } });
  return f.service.chatSessionStore.getSession(session.sessionKey);
}

for (const runtime of ["codex", "opencode", "grok-build", "antigravity"]) {
  test(`${runtime}: history above 160K stays on its native session below the effective request limit`, async () => {
    const { f, coordinator, session } = await openRuntime(runtime);
    try {
      const old = await workingHistory(f, coordinator, session, `fitting-${runtime}`, 380000);
      const run = await sendNext(coordinator, session.sessionKey, `fitting-${runtime}-next`);
      assert.equal(run.status, "running", run.errorCode);
      const contract = f.transport.acquisitions.at(-1).options.executionContract;
      assert.ok(contract.contextRequest.estimatedTokens > 160000);
      assert.equal(contract.contextRequest.limitTokens, 380000);
      assert.equal(contract.contextRequest.exceedsBudget, false);
      assert.equal(compactionRuns(coordinator).length, 0);
      assert.equal(f.service.transcriptStore.listEvents(session.profileId, session.id)
        .filter(event => event.content?.transcriptType === "context.maintenance").length, 0,
      "a fitting request cannot start maintenance that then silently falls back");
      assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId, old.runtimeSessionId);
      await f.complete(run);
    } finally { await f.close(); }
  });
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
        if (behavior !== "unavailable") assert.ok(assertMaintenanceFailuresHidden(f, current) > 0, "the failed summary was journaled");
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
    test(`${runtime} effective input limit: ${outcome} never replays maintenance or input, and never refuses it`, async () => {
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
            turnId: compact.runtimeTurnRef.turnId, contextUsage: unknownRuntimeContextUsage(compact.runtimeSessionRef.sessionId) });
          await f.complete(compact);
        }
        await waitUntil(() => ["running", "failed"].includes(coordinator.getRun(ack.run.id).status), 10000, "budget-bound input admission");
        const run = coordinator.getRun(ack.run.id);
        assert.equal(run.status, "running", run.errorCode);
        if (outcome !== "success") {
          // An uncompleted required compact never releases the input onto the
          // full thread; it renews the thread on the same binding instead.
          assert.notEqual(compactionRuns(coordinator)[0].status, "completed");
          const renewed = f.service.chatSessionStore.getSession(session.sessionKey);
          assert.equal(run.runtimeSessionRef.sessionId, renewed.runtimeSessionId);
          assert.notEqual(renewed.retiredRuntimeSessions.at(-1)?.runtimeSessionId, renewed.runtimeSessionId);
          if (outcome !== "unsupported") assertMaintenanceFailuresHidden(f, renewed);
        }
        assert.equal(commands, outcome === "unsupported" ? 0 : 1);
        assert.equal(compactionRuns(coordinator).length, 1);
        const host = f.transport.hosts.get(runtime);
        assert.equal(host.threads.flatMap(thread => thread.turns).filter(turn => turn.items.some(item => item.clientId === `${runtime}-${outcome}-next`)).length, 1);
        await f.complete(run);
        const later = await sendNext(coordinator, session.sessionKey, `${runtime}-${outcome}-later`);
        assert.equal(later.status, "running", later.errorCode);
        assert.equal(commands, outcome === "unsupported" ? 0 : 1, "maintenance is never replayed");
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
      coordinator.getRuntimeModelContextLimits = () => ({ inputTokens: 128000 });
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
