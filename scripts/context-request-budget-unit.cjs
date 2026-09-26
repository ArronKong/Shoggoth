"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { conversationContextBudget } = require("../app/agent-service/conversation-context-budget");
const { requestBudget, inputTokenLimit, assertContextTransport } = require("../app/agent-service/context-request-budget");
const { ConversationCheckpointStore, SUMMARY_FIELDS, coveredTranscript } = require("../app/agent-service/conversation-checkpoint-store");
const { planConversationCompaction } = require("../app/agent-service/conversation-compaction");
const { readContextTransfer, recordContextTransfer } = require("../app/agent-service/context-transfer");

const budget = window => conversationContextBudget(window);
function compile(f, window, extra = {}) {
  return f.compiler.compile({ profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId,
    contextLifecycleV1: true, transcriptTokenBudget: budget(window).triggerTokens,
    requestBudget: budget(window), currentOperationId: "current", currentPrompt: "continue",
    freshSession: true, ...extra });
}

test("input-only and effective windows never deduct the model's maximum output a second time", () => {
  assert.equal(inputTokenLimit(budget(100000), { windowKind: "input", outputTokens: 64000 }), 80000);
  assert.equal(inputTokenLimit(budget(100000), { windowKind: "effective", outputTokens: 64000 }), 80000);
  assert.equal(inputTokenLimit(budget(100000), { windowKind: "total", outputTokens: 64000 }), 36000);
  assert.equal(inputTokenLimit(budget(100000), { inputTokens: 32000 }), 32000);
});

test("whole-request accounting includes instructions, tools, current input and image allowance", () => {
  const base = { budget: budget(64000), developerInstructions: "rules ".repeat(1000),
    context: "history ".repeat(1000), tools: [{ name: "lookup", inputSchema: { type: "object" } }] };
  const small = requestBudget({ ...base, prompt: "continue" });
  const large = requestBudget({ ...base, prompt: "x".repeat(200000),
    attachments: [{ id: "image", name: "image.png", mimeType: "image/png" }] });
  assert.equal(small.exceedsBudget, false);
  assert.equal(large.exceedsBudget, true);
  assert.equal(large.attachmentsEstimated, true);
  assert.ok(large.fixedTokens > large.limitTokens);
});

test("an already compacted native meter does not count the entire stored transcript again", () => {
  const result = requestBudget({ budget: budget(64000), developerInstructions: "a".repeat(4000),
    context: "added", prompt: "continue", nativeUsage: { usedTokens: 10000 }, fresh: false });
  assert.ok(result.estimatedTokens > 10000 && result.estimatedTokens < 10100);
});

test("more than 2 MiB of fitting original text survives compile and snapshot persistence", () => {
  const f = contextFixture({ runtime: "pi" });
  try {
    for (let n = 0; n < 60; n++) f.append({ id: `history-${n}`, kind: n % 2 ? "assistant" : "user",
      content: { text: `marker-${n} ${"plain words ".repeat(3700)}` } });
    f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
    const snapshot = compile(f, 1000000);
    assert.ok(Buffer.byteLength(snapshot.dynamicContext) > 2 * 1024 * 1024);
    assert.equal(snapshot.report.request.historyTruncated, false);
    assert.equal(snapshot.report.request.exceedsBudget, false);
    assert.match(snapshot.dynamicContext, /marker-0 /u);
    assert.deepEqual(f.snapshots.get(f.profile.id, snapshot.id), snapshot);
  } finally { f.cleanup(); }
});

test("large tool results are kept outside the display journal and verified on read", () => {
  const f = contextFixture();
  try {
    const content = { tool: { name: "read_file", output: `${"body ".repeat(30000)}LAST_DETAIL` } };
    const saved = f.append({ id: "tool", kind: "tool_result", content: { tool: { resultSummary: "short display" } }, contextContent: content });
    assert.ok(saved.content.contextRef.bytes > 64 * 1024);
    assert.equal(saved.content.tool.resultSummary, "short display");
    assert.deepEqual(f.transcripts.contextEvent(f.profile.id, f.transcriptSessionId, saved).content, content);
    f.transcripts.close(); f.transcripts.open();
    f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
    const snapshot = compile(f, 1000000);
    assert.match(snapshot.dynamicContext, /LAST_DETAIL/u);
    f.transcripts.setContextExcluded({ profileId: f.profile.id, sessionId: f.transcriptSessionId, eventId: "tool", contextExcluded: true });
    assert.doesNotMatch(compile(f, 1000000).dynamicContext, /LAST_DETAIL/u);
  } finally { f.cleanup(); }
});

test("a larger fresh destination restores a fully fitting summarized prefix without duplicate checkpoint", () => {
  const f = contextFixture();
  const checkpoints = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts });
  checkpoints.open(); f.compiler.checkpointStore = checkpoints;
  try {
    for (let n = 0; n < 12; n++) f.append({ id: `original-${n}`, kind: n % 2 ? "assistant" : "user",
      content: { text: `original-fact-${n} ${"ordinary words ".repeat(1600)}` } });
    const events = f.transcripts.listEvents(f.profile.id, f.transcriptSessionId);
    const summary = Object.fromEntries(SUMMARY_FIELDS.map(field => [field, []]));
    summary.goal = ["summary-placeholder"];
    checkpoints.commit({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      expectedRevision: events.length, throughSeq: 8, coveredHash: coveredTranscript(events, 8).hash,
      summary, provenance: { runId: "summary", bindingId: "binding", runtime: "pi", model: "model", method: "model" } });
    f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
    const snapshot = compile(f, 1000000);
    assert.match(snapshot.dynamicContext, /original-fact-0/u);
    assert.doesNotMatch(snapshot.dynamicContext, /summary-placeholder/u);
    assert.equal(snapshot.report.request.historyTruncated, false);
  } finally { checkpoints.close(); f.cleanup(); }
});

test("transport checks use encoded bytes independently of the token estimate", () => {
  assertContextTransport({ runtime: "pi", context: "x".repeat(3 * 1024 * 1024) });
  assert.throws(() => assertContextTransport({ runtime: "pi", context: "x".repeat(4 * 1024 * 1024 + 1) }),
    { code: "CONTEXT_TRANSPORT_EXCEEDED" });
  assert.throws(() => assertContextTransport({ runtime: "codex", context: "x".repeat(1048576) }),
    { code: "CONTEXT_TRANSPORT_EXCEEDED" });
});

test("one oversized record is summarized in durable ordered fragments and never exposed as fully covered early", () => {
  const f = contextFixture();
  const checkpoints = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts });
  checkpoints.open(); f.compiler.checkpointStore = checkpoints;
  try {
    f.append({ id: "giant", kind: "tool_result", content: { tool: { output: "alpha 中文🙂\\\"\n".repeat(22000) + "FINAL_CONSTRAINT" } } });
    f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
    let joined = "", steps = 0, cursor = 0;
    while (steps < 100) {
      const plan = planConversationCompaction({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
        transcriptStore: f.transcripts, checkpointStore: checkpoints, force: true, currentOperationId: "current",
        budget: budget(64000), maxSourceBytes: 32 * 1024, maxSourceTokens: 16000 });
      if (!plan) break;
      const data = JSON.parse(plan.prompt.split("BEGIN UNTRUSTED CONVERSATION DATA\n")[1].split("\nEND UNTRUSTED")[0]);
      const fragment = data.events[0].fragment;
      assert.ok(fragment);
      assert.equal(fragment.offset, cursor);
      assert.ok(fragment.text.isWellFormed());
      cursor += fragment.text.length; joined += fragment.text;
      assert.ok(Buffer.byteLength(JSON.stringify(data.events)) < 32 * 1024);
      const summary = Object.fromEntries(SUMMARY_FIELDS.map(field => [field, []]));
      summary.state = [`Seen fragment ${++steps}`];
      const { prompt, targetThroughSeq, ...coverage } = plan;
      const saved = checkpoints.commit({ ...coverage, summary, provenance: { runId: `part-${steps}`,
        bindingId: "binding", runtime: "pi", model: "small", method: "model" } });
      checkpoints.close(); checkpoints.open();
      assert.equal(checkpoints.compatible(f.profile.id, f.transcriptSessionId).id, saved.id);
      if (saved.partial) {
        assert.equal(saved.coveredThroughSeq, 0);
        assert.equal(checkpoints.portable(f.profile.id, f.transcriptSessionId), null);
      } else break;
    }
    assert.ok(steps > 1 && steps < 100);
    const complete = checkpoints.portable(f.profile.id, f.transcriptSessionId);
    assert.equal(complete.coveredThroughSeq, 1);
    assert.match(JSON.parse(joined).content.tool.output, /FINAL_CONSTRAINT$/u);
  } finally { checkpoints.close(); f.cleanup(); }
});

test("mandatory input is distinct from high native occupancy and an already compacted native meter controls admission", () => {
  const f = contextFixture();
  try {
    f.append({ id: "old", kind: "assistant", content: { text: "huge history ".repeat(50000) } });
    f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
    const result = compile(f, 64000, { freshSession: false, transcriptTokenBudget: undefined,
      nativeUsage: { usedTokens: 55000, observedAt: 1000 } });
    assert.ok(result.report.request.fixedTokens < 16000);
    assert.ok(result.report.request.exceedsBudget);
    const compacted = compile(f, 64000, { freshSession: false, transcriptTokenBudget: undefined,
      nativeUsage: { usedTokens: 10000, observedAt: 1000 } });
    assert.equal(compacted.report.request.exceedsBudget, false);
    assert.ok(compacted.report.request.estimatedTokens < 16000);
  } finally { f.cleanup(); }
});

test("confirmed native compaction without a meter estimates only subsequent history", () => {
  const f = contextFixture();
  try {
    f.append({ id: "old", kind: "assistant", content: { text: "old history ".repeat(50000) } });
    f.append({ id: "native-compact", kind: "status", contextExcluded: true,
      content: { transcriptType: "context.native.compacted", runtimeSessionId: "native-1" } });
    f.append({ id: "new", kind: "assistant", content: { text: "recent detail" } });
    f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
    const common = { freshSession: false, transcriptTokenBudget: undefined, nativeUsage: null };
    const compacted = compile(f, 64000, { ...common, nativeSessionId: "native-1" });
    assert.equal(compacted.report.request.exceedsBudget, false);
    assert.ok(compacted.report.request.estimatedTokens < 16000);
    assert.equal(compile(f, 64000, { ...common, nativeSessionId: "different-native" }).report.request.exceedsBudget, true);
  } finally { f.cleanup(); }
});

test("historical attachments carry usable references without claiming their contents were read", () => {
  const f = contextFixture();
  try {
    f.append({ id: "attached", kind: "user", content: { text: "use the document", attachments: [
      { id: "file-1", name: "design.pdf", mimeType: "application/pdf", size: 30 },
    ] } });
    f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
    const available = compile(f, 1000000, { resolveAttachments: items => items.map(item => ({ ...item, path: "/private/session/design.pdf" })) });
    assert.match(available.dynamicContext, /ATTACHMENT REFERENCES \(contents require reading\)/u);
    assert.match(available.dynamicContext, /\/private\/session\/design.pdf/u);
    assert.equal(available.report.request.completeness, "available");
    const missing = compile(f, 1000000, { resolveAttachments: items => items.map(item => ({ ...item, unavailable: true })) });
    assert.equal(missing.report.request.completeness, "partial");
    assert.match(missing.dynamicContext, /"unavailable":true/u);
  } finally { f.cleanup(); }
});

test("capacity recovery requires affirmative non-execution evidence", () => {
  const { rejectedContextCapacity } = require("../app/agent-service/context-request-budget");
  const error = { code: "CONTEXT_LENGTH_EXCEEDED", contextWindow: 272000 };
  assert.equal(rejectedContextCapacity(error), null);
  assert.equal(rejectedContextCapacity({ ...error, acceptance: "unknown" }), null);
  assert.equal(rejectedContextCapacity({ ...error, acceptance: "rejected", executed: true }), null);
  assert.deepEqual(rejectedContextCapacity({ cause: { ...error, acceptance: "rejected", executed: false } }), { tokens: 272000 });
});

test("handoff receipts survive restart without claiming a pre-commit or unknown request was accepted", () => {
  const f = contextFixture();
  try {
    const session = { profileId: f.profile.id, id: f.transcriptSessionId, revision: 3 };
    const receipt = { state: "preparing", targetBindingId: "target", model: "model", sourceRevision: 0,
      sourceSessionRevision: 3, snapshotId: null, mode: "original", errorCode: null, updatedAt: 1000 };
    recordContextTransfer(f.transcripts, session, receipt);
    assert.equal(readContextTransfer(f.transcripts, session, true).state, "preparing");
    f.transcripts.close(); f.transcripts.open();
    assert.equal(readContextTransfer(f.transcripts, session).errorCode, "CONTEXT_HANDOFF_INTERRUPTED");
    recordContextTransfer(f.transcripts, session, { ...receipt, state: "ready", snapshotId: "prepared" });
    assert.equal(readContextTransfer(f.transcripts, session).state, "failed");
    assert.equal(readContextTransfer(f.transcripts, { ...session, revision: 4 }).state, "ready");
    recordContextTransfer(f.transcripts, session, { ...receipt, state: "unknown", errorCode: "RUNTIME_TURN_START_UNKNOWN" });
    f.transcripts.close(); f.transcripts.open();
    assert.equal(readContextTransfer(f.transcripts, { ...session, revision: 4 }).state, "unknown");
  } finally { f.cleanup(); }
});

test("growing a window can select an earlier checkpoint without duplicate or missing coverage", () => {
  const f = contextFixture(), checkpoints = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts });
  checkpoints.open(); f.compiler.checkpointStore = checkpoints;
  try {
    for (let n = 0; n < 14; n++) f.append({ id: `fact-${n}`, kind: n % 2 ? "assistant" : "user",
      content: { text: `original-fact-${n} ${"words ".repeat(4000)}` } });
    const events = f.transcripts.listEvents(f.profile.id, f.transcriptSessionId);
    let previousId = null;
    for (const seq of [6, 10]) {
      const summary = Object.fromEntries(SUMMARY_FIELDS.map(field => [field, []]));
      summary.goal = [`summarized-through-${seq}`];
      previousId = checkpoints.commit({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
        expectedRevision: events.length, throughSeq: seq, coveredHash: coveredTranscript(events, seq).hash, previousId,
        summary, provenance: { runId: `summary-${seq}`, bindingId: "binding", runtime: "pi", model: "model", method: "model", contextWindow: 64000 } }).id;
    }
    f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
    const snapshot = compile(f, 80000);
    assert.equal(snapshot.report.request.coverage, 6);
    assert.match(snapshot.dynamicContext, /summarized-through-6/u);
    assert.match(snapshot.dynamicContext, /original-fact-6 /u);
    assert.doesNotMatch(snapshot.dynamicContext, /original-fact-5 |summarized-through-10/u);
    assert.equal(snapshot.report.request.historyTruncated, false);
  } finally { checkpoints.close(); f.cleanup(); }
});

test("native tool originals survive display truncation but secrets never enter the content object", () => {
  const { normalizeCodexEvent } = require("../app/agent-service/codex-event-normalizer");
  const output = "native full output ".repeat(12000) + "END_OF_NATIVE_TOOL";
  const event = normalizeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn",
    item: { id: "tool", type: "commandExecution", command: "cat file", aggregatedOutput: output, exitCode: 0, status: "completed" } } });
  assert.equal(event.contextTool.output, output);
  assert.ok(event.tool.output.length < output.length);
  const { contextToolContent } = require("../app/agent-service/context-tool-content");
  assert.deepEqual(contextToolContent({ output: "registered-private-value" }, ["registered-private-value"]), {});
  assert.deepEqual(contextToolContent({ output: "sk-" + "a".repeat(32) }), {});
});

test("missing and corrupted originals stop a new projection; excluded bodies are never read", () => {
  const f = contextFixture(), fs = require("node:fs"), path = require("node:path");
  try {
    const event = f.append({ id: "tool", kind: "tool_result", content: { tool: { output: "body ".repeat(20000) } } });
    const file = path.join(f.paths.agentsDir, f.profile.id, "transcripts", f.transcriptSessionId,
      "context-content", `${event.content.contextRef.hash}.json`);
    f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
    fs.writeFileSync(file, "corrupted");
    assert.throws(() => compile(f, 1000000), { code: "CONTEXT_CONTENT_CORRUPT" });
    fs.unlinkSync(file);
    assert.throws(() => compile(f, 1000000), { code: "CONTEXT_CONTENT_UNAVAILABLE" });
    f.transcripts.setContextExcluded({ profileId: f.profile.id, sessionId: f.transcriptSessionId, eventId: "tool", contextExcluded: true });
    assert.doesNotThrow(() => compile(f, 1000000));
  } finally { f.cleanup(); }
});
