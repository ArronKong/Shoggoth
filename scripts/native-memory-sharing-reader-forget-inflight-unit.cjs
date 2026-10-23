"use strict";
// Real Product Service/MCP/Coordinator with a controlled native Runtime.
// A reader-side forget commits only body-free suppression and fences the
// current borrowed turn, including output arriving before interrupt returns.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
const FACT = "The telescope reader-forget fact is aquamarine calibration READER_FORGET_BODY_614823.";
const LATE = "READER_FORGET_LATE_BODY_493821";

async function fixture() {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true, memorySharingFeatureReady: true,
    memoryCoreConfig: { memory: { search: { provider: "none", rememberAcrossConversations: false } },
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
      plugins: { entries: { "active-memory": { config: { enabled: false } } } } } } });
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: false } });
  const B = "reader-forget-source-b", source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
  Object.assign(source, { id: B, agentId: B, runtimeProfileId: B, name: B, isDefault: false });
  f.service.productStore.putAgentProfile(source); f.service.agentDefinitionStore.ensureProfile({ profileId: B });
  const owner = f.service.memoryEngine;
  owner.store.ensureProfile(B); owner.recallPolicy.assertReady(B);
  f.service.nativeMemorySharingConfig.apply({ revision: 0, config: { enabled: true, excludedProfiles: [] } });
  const item = await owner.propose({ profileId: B, content: FACT, scope: "agent", classification: "explicit",
    sourceRefs: ["user-edit:reader-forget-source"] });
  return { ...f, B, item, owner };
}

function emitLate(host, run) {
  const common = { known: true, threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId };
  host.emit({ ...common, type: "text_delta", method: "item/agentMessage/delta", itemId: "reader-forget-late-text", delta: LATE });
  host.emit({ ...common, type: "text", method: "item/completed", itemId: "reader-forget-late-final", text: `${FACT} ${LATE}`, phase: "final_answer" });
  host.emit({ ...common, type: "tool_result", method: "item/completed", itemId: "reader-forget-late-tool", toolCallId: "reader-forget-late-tool",
    tool: { kind: "function", name: "memory_search", status: "completed", output: LATE } });
  const thread = host.threads.find(value => value.id === run.runtimeSessionRef.sessionId);
  const turn = thread.turns.find(value => value.id === run.runtimeTurnRef.turnId);
  turn.status = "completed"; turn.items.push({ type: "agentMessage", id: "reader-forget-late-final", text: `${FACT} ${LATE}`, phase: "final_answer" });
  host.emit({ ...common, type: "complete", method: "turn/completed", status: "completed" });
}

function suppressionRows(f) {
  return {
    source: f.owner.database.db.prepare("SELECT * FROM memory_borrowed_suppressions WHERE profile_id=?").all(f.profile.id),
    content: f.owner.database.db.prepare("SELECT * FROM memory_borrowed_content_suppressions WHERE profile_id=?").all(f.profile.id),
  };
}

test("reader memory_forget fences the borrowed in-flight turn without copying or deleting the owner fact", { timeout: 30000 }, async () => {
  const f = await fixture(); let release, forgetting, subscription;
  try {
    const session = f.createSession(), coordinator = f.service.workRunCoordinator;
    const prompt = "Forget that telescope memory";
    const run = await f.send(session.sessionKey, "reader-forget-inflight", prompt);
    assert.equal(run.status, "running", run.errorCode);
    const call = (current, name, args) => f.service.mcpProductToolController.handle(name,
      { source: "chat", sourceId: current.sourceId, ...args }, { profileId: f.profile.id, callId: crypto.randomUUID() });
    const found = await call(run, "memory_search", { query: "telescope", minScore: 0, ownerProfileId: f.B, maxResults: 20 });
    const borrowed = found.results.find(value => value.ownerProfileId === f.B && value.borrowed);
    assert.ok(borrowed, "the current actual chat borrows through real MCP");
    const read = await call(run, "memory_get", { id: borrowed.sourceRef }); assert.match(read.text, /READER_FORGET_BODY_614823/u);
    const beforeSource = fs.readFileSync(path.join(f.owner.store.workspace(f.B), "MEMORY.md"), "utf8");
    const beforeRevision = f.owner.store.getRevision(f.B), beforeItem = f.owner.store.get(f.B, f.item.id);
    const host = f.transport.hosts.get("codex"), events = [], beforeInterrupts = host.turnInterruptCalls;
    subscription = coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
    host.interruptGate = { promise: new Promise(resolve => { release = resolve; }) };
    // Capture either safe receipt or safe terminal rejection without allowing an
    // unhandled rejection while the physical native interrupt is held pending.
    forgetting = call(run, "memory_forget", { id: borrowed.sourceRef,
      expectedRevision: f.owner.store.getRevision(f.profile.id), sourceQuote: prompt })
      .then(result => ({ result }), error => ({ error }));
    await waitUntil(() => suppressionRows(f).source.length > 0, 5000, "reader suppression commits");
    await new Promise(resolve => setImmediate(resolve));
    emitLate(host, run);
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(LATE), "source-dependent late text/tools/complete are withheld before interrupt returns");
    assert.doesNotMatch(JSON.stringify(f.service.transcriptStore.listEvents(f.profile.id, session.id)), new RegExp(LATE),
      "suppressed late output never becomes Product replay history");
    await waitUntil(() => host.turnInterruptCalls > beforeInterrupts, 5000, "reader forget interrupts native turn");
    assert.equal(host.turnInterruptCalls, beforeInterrupts + 1, "reader suppression joins one physical native interrupt");
    release(); const outcome = await forgetting;
    if (outcome.result) assert.equal(outcome.result.suppressed, true, "only a committed suppression receipt can succeed");
    else assert.ok(["MCP_TOOL_STATE_CONFLICT", "MEMORY_SHARED_SOURCE_REVOKED", "MCP_TOOL_NOT_FOUND"].includes(outcome.error?.code),
      `forget receipt may be safely interrupted, received ${outcome.error?.code}`);
    await waitUntil(() => coordinator.getRun(run.id).status === "interrupted", 5000, "reader forget reaches safe terminal state");
    await coordinator.waitForIdle(run.id);
    const terminal = coordinator.getRun(run.id);
    assert.equal(terminal.errorCode, "CONTEXT_SOURCE_STALE"); assert.equal(terminal.resultSummary, null);
    assert.equal(events.filter(event => event.type === "terminal").length, 1);
    assert.equal(coordinator.lastErrors.size, 0);
    const rows = suppressionRows(f);
    assert.ok(rows.source.length > 0 && rows.content.length > 0, "suppression remains committed after interruption");
    for (const row of rows.source) {
      assert.deepEqual(Object.keys(row).sort(), ["created_at", "operation_id", "profile_id", "source_hash"]);
      assert.match(row.source_hash, /^[a-f0-9]{64}$/u);
    }
    for (const row of rows.content) {
      assert.deepEqual(Object.keys(row).sort(), ["content_hash", "created_at", "operation_id", "profile_id", "text_length"]);
      assert.match(row.content_hash, /^[a-f0-9]{64}$/u); assert.ok(row.text_length > 0);
    }
    assert.doesNotMatch(JSON.stringify(rows), /READER_FORGET_BODY_614823|aquamarine|calibration/u, "reader ledger has no owner body");
    assert.equal(fs.readFileSync(path.join(f.owner.store.workspace(f.B), "MEMORY.md"), "utf8"), beforeSource);
    assert.equal(f.owner.store.getRevision(f.B), beforeRevision);
    assert.deepEqual(f.owner.store.get(f.B, f.item.id), beforeItem, "reader forget leaves source record untouched");
    const next = await f.send(session.sessionKey, "reader-forget-next", "Continue with independent telescope facts");
    assert.equal(next.status, "running", next.errorCode);
    assert.notEqual(next.runtimeSessionRef.sessionId, run.runtimeSessionRef.sessionId, "next turn retires the native context containing suppressed source text");
    const contract = f.transport.acquisitions.at(-1).options.executionContract;
    assert.equal(contract.contextFresh, true); assert.doesNotMatch(contract.dynamicContext, /READER_FORGET_BODY_614823|aquamarine|calibration/u);
    const searched = await call(next, "memory_search", { query: "telescope", minScore: 0, ownerProfileId: f.B, maxResults: 20 });
    assert.equal(searched.results.some(value => value.ownerProfileId === f.B && value.borrowed), false, "reader suppression applies to fresh source references");
    await f.complete(next, "Independent continuation after reader-side forget");
    const stable = await f.send(session.sessionKey, "reader-forget-stable", "Continue again with independent facts");
    assert.equal(stable.runtimeSessionRef.sessionId, next.runtimeSessionRef.sessionId, "fresh safe native session remains reusable");
    await f.complete(stable);
  } finally {
    release?.(); await forgetting?.catch(() => {});
    subscription?.unsubscribe(); await f.close();
  }
});
