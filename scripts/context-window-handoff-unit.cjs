"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { SUMMARY_FIELDS } = require("../app/agent-service/conversation-checkpoint-store");
const { estimateContextTokens } = require("../app/agent-service/conversation-context-budget");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");

function enable(f, enabled = true) {
  // The pre-compaction memory flush runs an isolated Codex generation the
  // fixture transport cannot provide; it is unrelated to the compaction route.
  f.service.workRunCoordinator.beforeMemoryCompaction = null;
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: enabled } });
}
// Product tool schemas and rules alone are ~38K estimated tokens, so a "small"
// destination must still hold them: 96K fits that fixed request but not six
// ~12.7K-token history entries on top of it.
const SMALL_WINDOW = 96_000;
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

test("default summaries never select an unchosen Pi binding and Codex native compact remains available", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const coordinator = f.service.workRunCoordinator;
    const calls = modelOnly(f);
    coordinator.runtimeManager.canGenerateModelOnly = runtime => runtime === "pi";
    const session = f.createSession();
    assert.equal(coordinator.runtimeSelectionPolicyStore.get(f.profile.id).compactionBindingId, null);
    const state = coordinator.getRuntimeContext(session);
    assert.equal(state.productContext.automatic, "unavailable", "discovering Pi does not authorize a summary route");
    assert.equal(state.productContext.summaryBindingId, null);
    assert.equal(state.productContext.summaryRuntime, null);
    assert.equal(state.contextCapabilities["context.compact.native"], true);
    await assert.rejects(coordinator.compactConversation({ sessionKey: session.sessionKey,
      operationId: "unchosen-pi-summary" }), error => error.code === "PRODUCT_CONTEXT_UNAVAILABLE");
    await f.complete(await f.send(session.sessionKey, "codex-with-unchosen-pi"));
    const host = f.transport.hosts.get("codex");
    let nativeCalls = 0;
    host.threadCompactStart = async ({ threadId }) => {
      nativeCalls++;
      host.emit({ known: true, type: "context_compacted", threadId });
      return {};
    };
    const compact = await f.send(session.sessionKey, "codex-native-no-pi", "/compact");
    assert.equal(compact.status, "completed", compact.errorCode);
    assert.equal(compact.runtimeSessionRef.runtime, "codex");
    assert.equal(nativeCalls, 1);
    assert.equal(calls(), 0);
    assert.equal(coordinator.dispatcher.listRuns({ source: "compaction" }).length, 0);
    assert.equal(f.transport.acquisitions.some(entry => entry.binding.runtime === "pi"), false);
  } finally { await f.close(); }
});

test("an existing Codex conversation compacts natively at the admission threshold before sending once", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const coordinator = f.service.workRunCoordinator;
    const session = f.createSession();
    const first = await f.send(session.sessionKey, "native-pressure-first");
    const current = f.service.chatSessionStore.getSession(session.sessionKey);
    const host = [...f.transport.handles.values()].find(handle =>
      handle.runtimeProfileId === first.runtimeSessionRef.runtimeProfileId
      && handle.runtimeAccountId === first.runtimeSessionRef.runtimeAccountId).host;
    let compactCalls = 0;
    host.threadCompactStart = async ({ threadId }) => {
      compactCalls++;
      assert.equal(threadId, current.runtimeSessionId);
      host.emit({ known: true, type: "context_compacted", threadId });
      return {};
    };
    host.emit({ known: true, type: "usage", threadId: current.runtimeSessionId,
      turnId: first.runtimeTurnRef.turnId,
      contextUsedTokens: 211386, modelContextWindow: 258400 });
    await waitUntil(() => coordinator.getRuntimeContext(current)?.contextUsage?.usedTokens === 211386,
      1000, "native context observation");
    await f.complete(first);
    const ack = await coordinator.send({ sessionKey: session.sessionKey,
      operationId: "native-pressure-next", prompt: "Delegate the next task" });
    await waitUntil(() => ["running", "failed"].includes(coordinator.getRun(ack.run.id).status),
      5000, "next turn admission");
    const run = coordinator.getRun(ack.run.id);
    assert.equal(run.status, "running", run.errorCode);
    assert.equal(compactCalls, 1);
    assert.equal(host.turnStartCalls, 2, "the waiting input is sent once after compaction");
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId, current.runtimeSessionId);
    assert.equal(f.transport.acquisitions.every(entry => entry.binding.runtime === "codex"), true);
    await f.complete(run);
  } finally { await f.close(); }
});

async function nativePressure(f, prefix, completeFirst = true, { used = 211386, window = 258400 } = {}) {
  enable(f);
  const coordinator = f.service.workRunCoordinator;
  const session = f.createSession();
  const first = await f.send(session.sessionKey, `${prefix}-first`);
  const current = f.service.chatSessionStore.getSession(session.sessionKey);
  const host = [...f.transport.handles.values()].find(handle =>
    handle.runtimeProfileId === first.runtimeSessionRef.runtimeProfileId
    && handle.runtimeAccountId === first.runtimeSessionRef.runtimeAccountId).host;
  host.emit({ known: true, type: "usage", threadId: current.runtimeSessionId,
    turnId: first.runtimeTurnRef.turnId, contextUsedTokens: used, modelContextWindow: window });
  await waitUntil(() => coordinator.getRuntimeContext(current)?.contextUsage?.usedTokens === used,
    1000, "native context observation");
  if (completeFirst) await f.complete(first);
  return { coordinator, current, host, session, first };
}

test("a queued send survives a pre-compaction refusal and resumes once after Service restart", async () => {
  let f = await openHandoffFixture();
  try {
    const flush = f.service.workRunCoordinator.beforeMemoryCompaction;
    const { coordinator, current, host, session } = await nativePressure(f, "native-flush-recovery");
    const isolationError = () => Object.assign(new Error("Unverified fixture inventory"), { code: "RUNTIME_ISOLATION_UNVERIFIED" });
    f.service.memoryEngine.complete = async () => { throw isolationError(); };
    coordinator.beforeMemoryCompaction = async input => {
      const receipt = await flush(input);
      assert.equal(receipt.error, "RUNTIME_ISOLATION_UNVERIFIED");
      throw isolationError(); // Old Service returned a send error after recording the failed flush.
    };
    const operationId = "native-flush-recovery-next";
    const params = { sessionKey: session.sessionKey, operationId, prompt: "Continue this conversation" };
    await assert.rejects(coordinator.send(params), { code: "RUNTIME_ISOLATION_UNVERIFIED", receiptUncertain: true });
    const queued = coordinator.getChatRunByOperation(operationId, session.sessionKey);
    assert.equal(queued.status, "queued");
    assert.equal(queued.runtimeTurnRef, null);
    assert.equal(host.turnStartCalls, 1);
    assert.equal(coordinator.dispatcher.listRuns({ source: "compaction" }).length, 0);

    const { root, transport } = f;
    let compactions = 0;
    const stubCompact = raw => {
      raw.threadCompactStart = async ({ threadId }) => {
        assert.equal(threadId, current.runtimeSessionId);
        compactions++;
        raw.emit({ known: true, type: "context_compacted", threadId });
        return {};
      };
    };
    await f.close({ remove: false });
    stubCompact(host);
    const setHandle = transport.handles.set.bind(transport.handles);
    transport.handles.set = (key, handle) => { stubCompact(handle.host); return setHandle(key, handle); };
    f = await openHandoffFixture({ root, transport });
    const after = f.service.workRunCoordinator;
    await waitUntil(() => ["running", "failed"].includes(after.getRun(queued.id).status), 5000, "restored input admission");
    const resumed = after.getChatRunByOperation(operationId, session.sessionKey);
    assert.equal(resumed.id, queued.id);
    assert.equal(resumed.status, "running", resumed.errorCode);
    assert.equal(compactions, 1);
    assert.equal(transport.hosts.get("codex").turnStartCalls, 2);
    assert.equal(f.service.transcriptStore.listEvents(session.profileId, session.id)
      .filter(event => event.kind === "user" && event.runId === queued.id).length, 1);
    await f.complete(resumed);
  } finally { await f.close(); }
});

test("a native compact that leaves pressure above budget stops after one attempt", async () => {
  const f = await openHandoffFixture();
  try {
    const { coordinator, current, host, session } = await nativePressure(f, "native-still-full");
    let calls = 0;
    host.threadCompactStart = async ({ threadId }) => {
      calls++;
      host.emit({ known: true, type: "usage", threadId,
        contextUsedTokens: 211386, modelContextWindow: 258400 });
      return {};
    };
    const ack = await coordinator.send({ sessionKey: session.sessionKey,
      operationId: "native-still-full-next", prompt: "Do not send while full" });
    await waitUntil(() => coordinator.getRun(ack.run.id).status === "failed", 5000, "bounded native compact");
    assert.equal(coordinator.getRun(ack.run.id).errorCode, "CONTEXT_COMPACTION_REQUIRED");
    assert.equal(calls, 1);
    assert.equal(host.turnStartCalls, 1);
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId, current.runtimeSessionId);
  } finally { await f.close(); }
});

test("automatic native compaction never sends a literal prompt when the runtime capability is unavailable", async () => {
  const f = await openHandoffFixture();
  try {
    const { coordinator, host, session } = await nativePressure(f, "native-unsupported");
    const acquire = coordinator.runtimeManager.acquire.bind(coordinator.runtimeManager);
    coordinator.runtimeManager.acquire = async (...args) => {
      const handle = await acquire(...args), facade = Object.create(handle);
      Object.defineProperty(facade, "capabilities", { value: { ...handle.capabilities, "context.compact.native": false } });
      return facade;
    };
    const ack = await coordinator.send({ sessionKey: session.sessionKey,
      operationId: "native-unsupported-next", prompt: "Do not send a compact prompt" });
    await waitUntil(() => coordinator.getRun(ack.run.id).status === "failed", 5000, "unsupported native compact");
    assert.equal(coordinator.getRun(ack.run.id).errorCode, "RUNTIME_COMPACTION_UNSUPPORTED");
    assert.equal(host.turnStartCalls, 1);
  } finally { await f.close(); }
});

test("manual recovery queued before the automatic attempt still releases later input", async () => {
  const f = await openHandoffFixture();
  try {
    const { coordinator, host, session, first } = await nativePressure(f, "native-queued-repair", false);
    const acquire = coordinator.runtimeManager.acquire.bind(coordinator.runtimeManager);
    coordinator.runtimeManager.acquire = async (...args) => {
      const handle = await acquire(...args);
      if (args[1]?.executionContract?.source !== "compaction") return handle;
      const facade = Object.create(handle);
      Object.defineProperty(facade, "capabilities", { value: { ...handle.capabilities, "context.compact.native": false } });
      return facade;
    };
    host.threadCompactStart = async ({ threadId }) => {
      host.emit({ known: true, type: "context_compacted", threadId });
      return {};
    };
    const blocked = await coordinator.send({ sessionKey: session.sessionKey,
      operationId: "native-queued-blocked", prompt: "next" });
    const repair = await coordinator.send({ sessionKey: session.sessionKey,
      operationId: "native-queued-repair", prompt: "/compact" });
    await f.complete(first);
    await waitUntil(() => coordinator.getRun(repair.run.id).status === "completed", 5000, "queued explicit repair");
    assert.equal(coordinator.getRun(blocked.run.id).status, "failed");
    const next = await f.send(session.sessionKey, "native-queued-after-repair");
    assert.equal(next.status, "running", next.errorCode);
    assert.equal(host.turnStartCalls, 2, "only the newly authorized input is sent");
    await f.complete(next);
  } finally { await f.close(); }
});

test("failed native compaction blocks its input across restart and permits an explicit compact recovery", async () => {
  let f = await openHandoffFixture();
  try {
    const { coordinator, current, host, session } = await nativePressure(f, "native-failure");
    let calls = 0;
    host.threadCompactStart = async () => { calls++; throw new Error("private compact failure"); };
    const ack = await coordinator.send({ sessionKey: session.sessionKey,
      operationId: "native-failure-next", prompt: "Do not replay this input" });
    await waitUntil(() => coordinator.getRun(ack.run.id).status === "failed", 5000, "failed native compact");
    assert.equal(coordinator.getRun(ack.run.id).errorCode, "RUNTIME_COMPACTION_ACCEPTANCE_UNKNOWN");
    assert.equal(calls, 1);
    assert.equal(host.turnStartCalls, 1);
    const root = f.root, threads = structuredClone(host.threads);
    await f.close({ remove: false });
    f = await openHandoffFixture({ root });
    const after = f.service.workRunCoordinator;
    const blocked = await f.send(session.sessionKey, "native-failure-after-restart");
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.errorCode, "RUNTIME_COMPACTION_ACCEPTANCE_UNKNOWN");
    assert.equal(after.dispatcher.listRuns({ source: "compaction" }).length, 1, "restart does not replay compact");
    const acquire = after.runtimeManager.acquire.bind(after.runtimeManager);
    after.runtimeManager.acquire = async (...args) => {
      const handle = await acquire(...args);
      if (!handle.host.nativeRecoveryFixtureInitialized) {
        handle.host.threads = structuredClone(threads);
        handle.host.turnStartCalls = 1; // Native turn IDs do not reset on resume.
        handle.host.nativeRecoveryFixtureInitialized = true;
      }
      handle.host.threadCompactStart = async ({ threadId }) => {
        assert.equal(threadId, current.runtimeSessionId);
        handle.host.emit({ known: true, type: "context_compacted", threadId });
        return {};
      };
      return handle;
    };
    const repair = await f.send(session.sessionKey, "native-failure-explicit-repair", "/compact");
    assert.equal(repair.status, "completed", repair.errorCode);
    const next = await f.send(session.sessionKey, "native-failure-repaired-next");
    assert.equal(next.status, "running", next.errorCode);
    assert.equal(after.getRun(ack.run.id).status, "failed", "recovery never replays the failed input");
    await f.complete(next);
  } finally { await f.close(); }
});

test("a smaller Codex model cannot implicitly use Pi and preserves its source session and history", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const coordinator = f.service.workRunCoordinator;
    const calls = modelOnly(f);
    coordinator.runtimeManager.canGenerateModelOnly = runtime => runtime === "pi";
    coordinator.getRuntimeModelContextWindow = session => session.modelOverride === "small-model" ? SMALL_WINDOW : 1_000_000;
    f.facts.read = async () => ({ installed: true, releaseEnabled: true, authenticated: true,
      models: ["fixture-model", "small-model"], attachmentKinds: [], permissionEnforcementProven: true });
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, "before-no-pi-handoff"));
    appendHistory(f, session, 6);
    const before = f.service.chatSessionStore.getSession(session.sessionKey);
    await assert.rejects(f.controller.handle("chat.session.runtime.model.set", {
      profileId: session.profileId, sessionKey: session.sessionKey, bindingId: before.runtimeBindingId,
      revision: before.revision, model: "small-model", acceptAdjustments: true,
    }), error => error.code === "CONTEXT_COMPACTION_REQUIRED");
    assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), before);
    assert.equal(coordinator.getRuntimeContext(before).productContext.transfer.errorCode, "CONTEXT_COMPACTION_REQUIRED");
    assert.equal(f.service.transcriptStore.listEvents(session.profileId, session.id)
      .filter(event => event.id.startsWith("large-")).length, 6);
    assert.equal(calls(), 0);
    assert.equal(coordinator.dispatcher.listRuns({ source: "compaction" }).length, 0);
    assert.equal(f.transport.acquisitions.some(entry => entry.binding.runtime === "pi"), false);
  } finally { await f.close(); }
});

test("a detached direct chat without a summary runtime resumes once with recent original messages", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const { workRunCoordinator: coordinator, chatSessionStore, transcriptStore } = f.service;
    coordinator.getRuntimeModelContextWindow = () => SMALL_WINDOW;
    const session = f.createSession();
    const first = await f.send(session.sessionKey, "recent-history-first");
    await f.complete(first);
    const before = chatSessionStore.getSession(session.sessionKey);
    const olderUser = transcriptStore.listEvents(session.profileId, session.id)
      .find(event => event.kind === "user" && event.runId === first.id);
    appendHistory(f, session, 8);
    const append = (id, kind, text, contextExcluded = false) => transcriptStore.appendEvent({
      profileId: session.profileId, sessionId: session.id, id, kind, contextExcluded, content: { text },
    });
    append("recent-request", "user", "Please inspect the invoice before sending anything.");
    append("excluded-history", "assistant", "EXCLUDED_HISTORY_BODY", true);
    append("old-tool-output", "tool_result", "DO_NOT_REPLAY_TOOL_PAYLOAD");
    append("recent-result", "assistant", "The invoice is ready to inspect. No payment has been made.");
    chatSessionStore.switchRuntime(session.sessionKey, { bindingId: before.runtimeBindingId,
      revision: before.revision, clearModelOverride: false });

    const operationId = "recent-history-continue";
    const run = await f.send(session.sessionKey, operationId, "Continue from there.");
    assert.equal(run.status, "running", run.errorCode);
    const contract = f.transport.acquisitions.at(-1).options.executionContract;
    assert.equal(contract.contextRequest.recentHistoryOnly, true);
    assert.equal(contract.contextRequest.historyTruncated, true);
    assert.equal(contract.contextRequest.completeness, "partial");
    assert.match(contract.dynamicContext, /Partial history from conversation/u);
    assert.match(contract.dynamicContext, /\[eventId=recent-request\] USER: Please inspect the invoice/u);
    assert.match(contract.dynamicContext, /\[eventId=recent-result\] ASSISTANT: The invoice is ready/u);
    assert.match(contract.turnDeveloperInstructions, /conversation_search.*conversation_get/u);
    assert.doesNotMatch(contract.dynamicContext, /SOURCE_0|EXCLUDED_HISTORY_BODY|DO_NOT_REPLAY_TOOL_PAYLOAD|Continue from there/u);
    assert.equal(coordinator.dispatcher.listRuns({ source: "compaction" }).length, 0);
    assert.ok(f.transport.acquisitions.every(entry => entry.binding.runtime === "codex"));
    const after = chatSessionStore.getSession(session.sessionKey);
    assert.equal(after.id, before.id);
    assert.equal(after.runtimeBindingId, before.runtimeBindingId);
    assert.notEqual(after.runtimeSessionId, before.runtimeSessionId);
    const replay = await f.send(session.sessionKey, operationId, "Continue from there.");
    assert.equal(replay.id, run.id);
    const host = f.transport.hosts.get("codex");
    assert.equal(host.turnStartCalls, 2);
    const events = transcriptStore.listEvents(session.profileId, session.id);
    assert.equal(events.filter(event => event.kind === "user" && event.content.operationId === operationId).length, 1);
    assert.equal(events.filter(event => event.content?.transcriptType === "context.native.seeded").length, 1);
    assert.equal(coordinator.getRuntimeContext(after).productContext.transfer.mode, "partial");
    assert.equal(coordinator.getRuntimeContext(after).productContext.transfer.state, "accepted");
    const recovered = await f.callTool(run, "conversation_get", { sessionId: session.id, eventId: olderUser.id });
    assert.ok(recovered.events.some(event => event.eventId === olderUser.id && event.text === olderUser.content.text));
    await f.complete(run);

    const ready = chatSessionStore.getSession(session.sessionKey);
    chatSessionStore.switchRuntime(session.sessionKey, { bindingId: ready.runtimeBindingId,
      revision: ready.revision, clearModelOverride: false });
    coordinator.validateUiAction = () => ({ origin: "ui_action_submission" });
    const card = await f.send(session.sessionKey, "ui-operation-fixture", "Submit the current card.");
    assert.equal(card.status, "failed");
    assert.equal(card.errorCode, "CONTEXT_COMPACTION_REQUIRED");
    assert.equal(host.turnStartCalls, 2);
  } finally { await f.close(); }
});

test("recent history is rechecked after a detached chat has been admitted", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const { workRunCoordinator: coordinator, chatSessionStore, transcriptStore } = f.service;
    coordinator.getRuntimeModelContextWindow = () => SMALL_WINDOW;
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, "recent-history-before-exclusion"));
    const before = chatSessionStore.getSession(session.sessionKey);
    appendHistory(f, session, 8);
    transcriptStore.appendEvent({ profileId: session.profileId, sessionId: session.id,
      id: "recent-excluded-after-admission", kind: "user", content: { text: "This source will be excluded." } });
    chatSessionStore.switchRuntime(session.sessionKey, { bindingId: before.runtimeBindingId,
      revision: before.revision, clearModelOverride: false });
    const acquire = coordinator.runtimeManager.acquire.bind(coordinator.runtimeManager);
    let exclusionApplied = false;
    coordinator.runtimeManager.acquire = async (binding, options) => {
      if (options.executionContract.contextRequest?.recentHistoryOnly && !exclusionApplied) {
        exclusionApplied = true;
        transcriptStore.setContextExcluded({ profileId: session.profileId, sessionId: session.id,
          eventId: "recent-excluded-after-admission", contextExcluded: true });
      }
      return acquire(binding, options);
    };
    const run = await f.send(session.sessionKey, "recent-history-race");
    assert.equal(exclusionApplied, true);
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "CONTEXT_SOURCE_STALE");
    assert.equal(run.runtimeTurnRef, null);
    assert.equal(f.transport.hosts.get("codex").turnStartCalls, 1);
  } finally { await f.close(); }
});

test("ordinary DREAMS.md updates retain the native thread, while corrections and forgetting renew it", async () => {
  const f = await openHandoffFixture({ serviceOptions: { memoryCoreConfig: { memory: { search: { provider: "none" } } } } });
  try {
    enable(f);
    const { memoryEngine: owner, memoryStore, conversationCheckpointStore } = f.service;
    const profileId = f.profile.id;
    const file = path.join(memoryStore.workspace(profileId), "DREAMS.md");
    const previousEntry = "\n---\n\n*November 13, 2026 at 3:00 AM GMT+8*\n\nReviewed the previous day's notes.\n\n";
    const newEntry = "\n---\n\n*November 14, 2026 at 3:00 AM GMT+8*\n\nReviewed new notes from today.\n\n";
    const diary = body => `# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n${body}<!-- openclaw:dreaming:diary:end -->\n`;
    const deep = body => `## Deep Sleep\n<!-- openclaw:dreaming:deep:start -->\n${body}\n<!-- openclaw:dreaming:deep:end -->\n`;
    const initialStatus = deep("- Repaired recall artifacts: removed stale promotion lock.\n- Ranked 0 candidate(s) for durable promotion.\n- Promoted 0 candidate(s) into MEMORY.md.");
    const updatedStatus = deep("- Ranked 2 candidate(s) for durable promotion.\n- Promoted 1 candidate(s) into MEMORY.md.\n- Not promoted: 1 candidate(s) (source rehydration: 1).");
    fs.writeFileSync(file, diary(previousEntry) + "\n" + initialStatus, { mode: 0o600 });
    const fact = await owner.propose({ profileId, scope: "user", classification: "explicit",
      content: "The observatory report uses the amber reference.", sourceRefs: ["user-edit:observatory-reference"] });
    const session = f.createSession();
    const send = async id => {
      const run = await f.send(session.sessionKey, id);
      assert.equal(run.status, "running", run.errorCode);
      await f.complete(run);
      return run.runtimeSessionRef.sessionId;
    };
    const first = await send("before-diary-update");
    const versionBefore = conversationCheckpointStore.nativeMemoryVersion(profileId);

    // Upgrade an existing database row before the first scheduled rewrite.
    const database = owner.database.db;
    const readFiles = () => JSON.parse(database.prepare("SELECT files FROM memory_file_invalidation WHERE profile_id=?").get(profileId).files);
    database.prepare("UPDATE memory_file_invalidation SET files=? WHERE profile_id=?").run(JSON.stringify(readFiles().map(entry => {
      const { dreams, ...legacy } = entry;
      return legacy;
    })), profileId);
    assert.deepEqual(conversationCheckpointStore.nativeMemoryVersion(profileId), versionBefore);
    assert.ok(readFiles().find(entry => entry.path === "DREAMS.md").dreams.statusFree);

    fs.writeFileSync(file, diary(previousEntry + newEntry) + "\n" + updatedStatus);
    const afterDreaming = conversationCheckpointStore.nativeMemoryVersion(profileId);
    assert.ok(afterDreaming.memoryRevision > versionBefore.memoryRevision);
    assert.equal(afterDreaming.memoryInvalidationRevision, versionBefore.memoryInvalidationRevision);
    assert.equal(await send("after-diary-update"), first);

    fs.writeFileSync(file, diary(previousEntry.replace("previous day's notes", "calibration record") + newEntry) + "\n" + updatedStatus);
    const afterDiaryCorrection = await send("after-diary-correction");
    assert.notEqual(afterDiaryCorrection, first, "editing an existing diary entry still invalidates old context");

    const corrected = await owner.propose({ profileId, scope: "user", classification: "explicit", supersedes: fact.id,
      content: "The observatory report uses the violet reference.", sourceRefs: ["user-edit:observatory-correction"] });
    const afterCorrection = await send("after-memory-correction");
    assert.notEqual(afterCorrection, afterDiaryCorrection);
    await owner.delete({ profileId, id: corrected.id, reason: "forgotten", operationId: "forget-observatory-reference" });
    assert.ok(conversationCheckpointStore.nativeMemoryVersion(profileId).policyRevision > afterDreaming.policyRevision);
    assert.notEqual(await send("after-memory-forget"), afterCorrection);
    const final = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(final.id, session.id);
    assert.equal(final.runtimeBindingId, session.runtimeBindingId);
  } finally { await f.close(); }
});

test("implicit summaries follow the current binding and its selected model", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const coordinator = f.service.workRunCoordinator;
    const calls = modelOnly(f);
    coordinator.runtimeManager.canGenerateModelOnly = runtime => ["pi", "deepseek-harness"].includes(runtime);
    f.facts.read = async () => ({ installed: true, releaseEnabled: true, authenticated: true,
      models: ["fixture-model", "current-summary-model"], attachmentKinds: [], permissionEnforcementProven: true });
    const session = f.createSession();
    await f.controller.handle("chat.session.runtime.model.set", { profileId: session.profileId,
      sessionKey: session.sessionKey, bindingId: f.binding("pi").id, revision: session.revision,
      model: "current-summary-model", acceptAdjustments: true });
    const current = f.service.chatSessionStore.getSession(session.sessionKey);
    const state = coordinator.getRuntimeContext(current).productContext;
    assert.equal(state.automatic, "enabled");
    assert.equal(state.summaryBindingId, current.runtimeBindingId);
    assert.equal(state.summaryRuntime, "pi");
    assert.equal(state.summaryModel, "current-summary-model");
    appendHistory(f, current, 2);
    const compact = await coordinator.compactConversation({ sessionKey: session.sessionKey,
      operationId: "current-pi-summary" });
    await coordinator.waitForIdle(compact.runId);
    assert.equal(coordinator.getRun(compact.runId).status, "completed");
    assert.ok(calls() > 0);
    const summary = f.transport.acquisitions.find(entry => entry.options.executionContract.source === "compaction");
    assert.equal(summary.binding.runtime, "pi");
    assert.equal(summary.options.executionContract.defaultModel, "current-summary-model");
    assert.equal(f.transport.acquisitions.some(entry => entry.binding.runtime === "deepseek-harness"), false);
  } finally { await f.close(); }
});

test("an explicitly selected summary binding remains supported without falling back when unavailable", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const coordinator = f.service.workRunCoordinator;
    const calls = modelOnly(f);
    coordinator.runtimeManager.canGenerateModelOnly = runtime => ["pi", "deepseek-harness"].includes(runtime);
    const session = f.createSession();
    const policy = coordinator.runtimeSelectionPolicyStore.get(f.profile.id);
    coordinator.runtimeSelectionPolicyStore.set(f.profile.id, { ...policy, compactionBindingId: f.binding("pi").id });
    const state = coordinator.getRuntimeContext(session).productContext;
    assert.equal(state.summaryBindingId, f.binding("pi").id);
    assert.equal(state.summaryRuntime, "pi");
    const summaryProfile = f.service.productStore.resolveAgentRuntimeProfile(f.profile.id, f.binding("pi").id);
    assert.equal(state.summaryModel, summaryProfile.defaultModel ?? null);
    appendHistory(f, session, 2);
    const compact = await coordinator.compactConversation({ sessionKey: session.sessionKey,
      operationId: "explicit-pi-summary" });
    await coordinator.waitForIdle(compact.runId);
    assert.equal(coordinator.getRun(compact.runId).status, "completed");
    assert.ok(calls() > 0);
    const summary = f.transport.acquisitions.find(entry => entry.options.executionContract.source === "compaction");
    assert.equal(summary.binding.runtime, "pi");
    assert.equal(summary.options.executionContract.defaultModel, summaryProfile.defaultModel ?? null);
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeBindingId, session.runtimeBindingId);
    const count = calls();
    coordinator.runtimeManager.canGenerateModelOnly = runtime => runtime === "deepseek-harness";
    const unavailable = coordinator.getRuntimeContext(session).productContext;
    assert.equal(unavailable.automatic, "unavailable");
    assert.equal(unavailable.summaryBindingId, null);
    await assert.rejects(coordinator.compactConversation({ sessionKey: session.sessionKey,
      operationId: "explicit-pi-unavailable" }), error => error.code === "PRODUCT_CONTEXT_UNAVAILABLE");
    assert.equal(calls(), count);
    assert.equal(f.transport.acquisitions.some(entry => entry.binding.runtime === "deepseek-harness"), false);
  } finally { await f.close(); }
});

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
    f.service.workRunCoordinator.getRuntimeModelContextWindow = (_session, profile) => profile.runtime === "codex" ? 1000000 : SMALL_WINDOW;
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, `before-${behavior}`));
    const old = f.service.chatSessionStore.getSession(session.sessionKey);
    appendHistory(f, session, 6);
    await assert.rejects(f.switch(session.sessionKey, "pi"), error => error.code === (behavior === "failed"
      ? "PRODUCT_COMPACTION_OUTPUT_INVALID" : "CONTEXT_COMPACTION_REQUIRED"));
    assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), old);
    const state = f.service.workRunCoordinator.getRuntimeContext(old).productContext.transfer;
    assert.equal(state.state, "failed");
    assert.equal(f.transport.hosts.get("pi")?.turnStartCalls ?? 0, 0);
    assert.equal(f.service.transcriptStore.listEvents(session.profileId, session.id).filter(e => e.id.startsWith("large-")).length, 6);
  } finally { await f.close(); }
});

test("Codex input character limit requires a transport summary even when the token window fits", async () => {
  const f = await openHandoffFixture({ catalogs: { codex: ["fixture-model", "large-model"] } });
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

test("a failed early summary never blocks a turn that still fits, and is not retried for that session", async () => {
  const f = await openHandoffFixture();
  try {
    enable(f);
    const coordinator = f.service.workRunCoordinator;
    const calls = modelOnly(f, true);
    coordinator.runtimeManager.canGenerateModelOnly = runtime => runtime === "pi";
    coordinator.getRuntimeModelContextWindow = () => 1_000_000;
    f.facts.read = async () => ({ installed: true, releaseEnabled: true, authenticated: true,
      models: ["fixture-model"], attachmentKinds: [], permissionEnforcementProven: true });
    const session = f.createSession();
    await f.controller.handle("chat.session.runtime.model.set", { profileId: session.profileId,
      sessionKey: session.sessionKey, bindingId: f.binding("pi").id, revision: session.revision,
      model: "fixture-model", acceptAdjustments: true });
    // ~254K estimated tokens: past the 160K working target, well inside the 800K trigger.
    appendHistory(f, f.service.chatSessionStore.getSession(session.sessionKey), 20);
    const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "early-summary-fails",
      prompt: "Continue with the next step" });
    await waitUntil(() => ["running", "failed"].includes(coordinator.getRun(ack.run.id).status), 10000, "turn admission");
    const run = coordinator.getRun(ack.run.id);
    assert.equal(run.status, "running", run.errorCode);
    assert.ok(calls() > 0, "an early summary was attempted");
    const attempts = calls();
    await f.complete(run);
    const next = await coordinator.send({ sessionKey: session.sessionKey, operationId: "early-summary-paused",
      prompt: "And the step after that" });
    await waitUntil(() => ["running", "failed"].includes(coordinator.getRun(next.run.id).status), 10000, "next admission");
    assert.equal(coordinator.getRun(next.run.id).status, "running");
    assert.equal(calls(), attempts, "a failed early summary is not retried on every turn");
    await f.complete(coordinator.getRun(next.run.id));
  } finally { await f.close(); }
});

for (const outcome of ["success", "failure", "timeout", "unsupported", "no-reduction"]) {
  test(`Codex working target: ${outcome} admits once and keeps required compaction independent`, async () => {
    const f = await openHandoffFixture();
    try {
      const { coordinator, host, session, current } = await nativePressure(f, `early-${outcome}`, true,
        { used: 180000, window: 1000000 });
      coordinator.getRuntimeModelContextWindow = () => 1000000;
      coordinator.manualCompactionTimeoutMs = 25;
      let calls = 0;
      const compactStart = raw => async ({ threadId }) => {
        calls++;
        if (outcome === "failure") throw new Error("fixture unknown acceptance");
        if (outcome === "timeout") return {};
        raw.emit(outcome === "no-reduction" ? { known: true, type: "usage", threadId,
          contextUsedTokens: 180000, modelContextWindow: 1000000 } : { known: true, type: "context_compacted", threadId });
        return {};
      };
      const acquire = coordinator.runtimeManager.acquire.bind(coordinator.runtimeManager);
      coordinator.runtimeManager.acquire = async (...args) => {
        const handle = await acquire(...args);
        handle.host.threadCompactStart = compactStart(handle.host);
        if (outcome === "unsupported") {
          const facade = Object.create(handle);
          Object.defineProperty(facade, "capabilities", { value: { ...handle.capabilities, "context.compact.native": false } });
          return facade;
        }
        return handle;
      };
      const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: `early-${outcome}-next`, prompt: "new input once" });
      await waitUntil(() => ["running", "failed"].includes(coordinator.getRun(ack.run.id).status), 10000, "early admission");
      const next = coordinator.getRun(ack.run.id);
      assert.equal(next.status, "running", next.errorCode);
      assert.equal(f.transport.hosts.get("codex").turnStartCalls, 2);
      assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId, current.runtimeSessionId);
      const [compact] = coordinator.dispatcher.listRuns({ source: "compaction" });
      assert.match(compact.id, /^native-compaction-advisory-/u);
      assert.equal(calls, outcome === "unsupported" ? 0 : 1);
      await f.complete(next);
      const later = await f.send(session.sessionKey, `early-${outcome}-later`);
      assert.equal(later.status, "running", later.errorCode);
      assert.equal(coordinator.dispatcher.listRuns({ source: "compaction" }).length, 1);
      await f.complete(later);
      if (["failure", "timeout", "unsupported"].includes(outcome)) {
        const contract = f.transport.acquisitions.at(-1).options.executionContract;
        assert.ok(contract.contextRequest.estimatedTokens >= 180000, "failed compact retains pre-dispatch estimate");
        coordinator.getRuntimeModelContextWindow = () => 200000;
        const required = await coordinator.send({ sessionKey: session.sessionKey, operationId: `early-${outcome}-required`, prompt: "at capacity" });
        await waitUntil(() => ["failed", "running"].includes(coordinator.getRun(required.run.id).status), 10000, "required after advisory");
        assert.equal(coordinator.getRun(required.run.id).status, "failed");
        assert.equal(coordinator.dispatcher.listRuns({ source: "compaction" }).length, 2);
        const blocked = await f.send(session.sessionKey, `early-${outcome}-blocked`);
        assert.equal(blocked.status, "failed", "required failure still blocks subsequent inputs");
      }
    } finally { await f.close(); }
  });
}

test("Codex advisory failure remains paused across restart without replaying either input or compact", async () => {
  let f = await openHandoffFixture();
  try {
    const { coordinator, host, session } = await nativePressure(f, "early-restart", true, { used: 180000, window: 1000000 });
    coordinator.getRuntimeModelContextWindow = () => 1000000;
    host.threadCompactStart = async () => { throw new Error("unknown"); };
    const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "early-restart-next", prompt: "once" });
    await waitUntil(() => coordinator.getRun(ack.run.id).status === "running", 10000, "advisory failure admitted");
    await f.complete(coordinator.getRun(ack.run.id));
    const liveHost = f.transport.hosts.get("codex");
    const root = f.root, threads = structuredClone(liveHost.threads), starts = liveHost.turnStartCalls;
    await f.close({ remove: false });
    f = await openHandoffFixture({ root });
    const after = f.service.workRunCoordinator;
    after.getRuntimeModelContextWindow = () => 1000000;
    const acquire = after.runtimeManager.acquire.bind(after.runtimeManager);
    after.runtimeManager.acquire = async (...args) => {
      const handle = await acquire(...args);
      if (!handle.host.initialized) {
        handle.host.initialized = true; handle.host.threads = structuredClone(threads); handle.host.turnStartCalls = starts;
      }
      handle.host.threadCompactStart = () => { throw new Error("must not replay compact"); };
      return handle;
    };
    const run = await f.send(session.sessionKey, "early-restart-later");
    assert.equal(run.status, "running", run.errorCode);
    assert.equal(after.dispatcher.listRuns({ source: "compaction" }).length, 1);
    assert.equal(f.transport.hosts.get("codex").turnStartCalls, starts + 1);
    await f.complete(run);
  } finally { await f.close(); }
});

test("native advisory preparation failure wakes queued input and pauses before enqueue", async () => {
  const f = await openHandoffFixture();
  try {
    const { coordinator, session, host } = await nativePressure(f, "prepare-failure", true, { used: 180000, window: 1000000 });
    coordinator.getRuntimeModelContextWindow = () => 1000000;
    let flushes = 0;
    coordinator.beforeMemoryCompaction = async () => { flushes++; throw new Error("memory preparation unavailable"); };
    const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "prepare-failure-next", prompt: "continue once" });
    await waitUntil(() => coordinator.getRun(ack.run.id).status === "running", 10000, "pre-enqueue failure released input");
    assert.equal(coordinator.dispatcher.listRuns({ source: "compaction" }).length, 0);
    assert.equal(host.turnStartCalls, 2);
    await f.complete(coordinator.getRun(ack.run.id));
    const next = await f.send(session.sessionKey, "prepare-failure-later");
    assert.equal(next.status, "running", next.errorCode);
    assert.equal(flushes, 1);
    await f.complete(next);
  } finally { await f.close(); }
});

test("native advisory memory preparation excludes concurrent recovery and honors user cancellation", { timeout: 30000 }, async () => {
  const f = await openHandoffFixture();
  let release;
  try {
    const { coordinator, session, host } = await nativePressure(f, "prepare-concurrent", true, { used: 180000, window: 1000000 });
    coordinator.getRuntimeModelContextWindow = () => 1000000;
    let entered = false;
    coordinator.beforeMemoryCompaction = () => new Promise(resolve => { entered = true; release = resolve; });
    const sending = coordinator.send({ sessionKey: session.sessionKey, operationId: "prepare-concurrent-next", prompt: "cancel me" });
    await waitUntil(() => entered, 5000, "memory flush entered");
    const queued = coordinator.getChatRunByOperation("prepare-concurrent-next", session.sessionKey);
    const recovering = coordinator.recover();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.getRun(queued.id).status, "queued");
    assert.equal(host.turnStartCalls, 1);
    await coordinator.abort({ operationId: "abort-preparation", sessionKey: session.sessionKey, runId: queued.id });
    release(); release = null;
    await Promise.all([sending, recovering]);
    assert.equal(coordinator.getRun(queued.id).status, "canceled");
    assert.equal(host.turnStartCalls, 1);
    assert.equal(coordinator.dispatcher.listRuns({ source: "compaction" }).length, 0);
  } finally { release?.(); await f.close(); }
});

test("native advisory below working target does not compact", async () => {
  const f = await openHandoffFixture();
  try {
    const { coordinator, session } = await nativePressure(f, "below-target", true, { used: 100000, window: 1000000 });
    coordinator.getRuntimeModelContextWindow = () => 1000000;
    const next = await f.send(session.sessionKey, "below-target-next");
    assert.equal(next.status, "running", next.errorCode);
    assert.ok(f.transport.acquisitions.at(-1).options.executionContract.contextRequest.estimatedTokens < 160000);
    assert.equal(coordinator.dispatcher.listRuns({ source: "compaction" }).length, 0);
    await f.complete(next);
  } finally { await f.close(); }
});

test("native advisory unknown stop remains fail-closed", async () => {
  const f = await openHandoffFixture();
  let host;
  try {
    const setup = await nativePressure(f, "stop-unknown", true, { used: 180000, window: 1000000 });
    host = setup.host;
    const { coordinator, session } = setup;
    coordinator.getRuntimeModelContextWindow = () => 1000000;
    host.threadCompactStart = async () => { throw new Error("unknown acceptance"); };
    host.stop = async () => { throw new Error("stop not confirmed"); };
    const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "stop-unknown-next", prompt: "must not send" });
    await waitUntil(() => coordinator.poisonError, 5000, "unconfirmed stop barrier");
    assert.equal(coordinator.poisonError.code, "RUNTIME_STOP_UNCONFIRMED");
    assert.equal(coordinator.dispatcher.getRun(ack.run.id).status, "queued");
    assert.equal(host.turnStartCalls, 1);
  } finally {
    if (host) host.stop = async () => { host.stopped = true; host.termination.resolve(); };
    await f.close();
  }
});
