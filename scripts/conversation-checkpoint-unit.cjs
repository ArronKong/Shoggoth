#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { ConversationCheckpointStore, SUMMARY_FIELDS, coveredTranscript, validateCheckpoint } = require("../app/agent-service/conversation-checkpoint-store");

function fixture() {
  const f = contextFixture({ runtime: "pi" });
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts, now: () => 500 });
  store.open(); f.compiler.checkpointStore = store;
  const summary = Object.fromEntries(SUMMARY_FIELDS.map(field => [field, []]));
  summary.goal = ["Preserve blue triangles in the museum export"];
  summary.constraints = ["Never modify original museum files"];
  f.append({ id: "early", kind: "user", content: { text: summary.goal[0] } });
  for (let i = 0; i < 50; i++) for (const kind of ["user", "assistant"]) {
    f.append({ id: `${kind}-${i}`, kind, content: { text: `Round ${i}: ` + "ordinary progress ".repeat(90) } });
  }
  f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
  const events = f.transcripts.listEvents(f.profile.id, f.transcriptSessionId);
  const throughSeq = events.at(-10).seq;
  const input = { profileId: f.profile.id, sessionId: f.transcriptSessionId,
    expectedRevision: f.transcripts.getRevision(f.profile.id, f.transcriptSessionId), throughSeq,
    coveredHash: coveredTranscript(events, throughSeq).hash, summary,
    provenance: { runId: "summary-1", bindingId: "binding-1", runtime: "pi", model: "fixture/model", method: "model" } };
  return { ...f, store, input, close() { store.close(); f.cleanup(); } };
}

test("a durable product checkpoint retains early facts across Runtime projection after the 48 KiB history limit", () => {
  const f = fixture();
  try {
    const compile = () => f.compiler.compile({ profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId,
      query: "continue", contextLifecycleV1: true, currentOperationId: "current", transcriptBudget: 48 * 1024 });
    assert.doesNotMatch(compile().dynamicContext, /Preserve blue triangles/u);
    const cp = f.store.commit(f.input);
    const result = compile();
    assert.match(result.dynamicContext, /Preserve blue triangles/u);
    assert.match(result.dynamicContext, /Round 49/u);
    assert.match(result.dynamicContext, /BEGIN UNTRUSTED CONVERSATION CHECKPOINT DATA/u);
    assert.doesNotMatch(result.developerInstructions, /Preserve blue triangles/u);
    assert.doesNotMatch(result.dynamicContextWithoutTranscript, /Preserve blue triangles/u);
    assert.equal(f.transcripts.listEvents(f.profile.id, f.transcriptSessionId).length, 102);
    f.store.close(); f.store.open();
    assert.deepEqual(f.store.compatible(f.profile.id, f.transcriptSessionId), cp);
    assert.equal(f.store.get("other-profile", f.transcriptSessionId), null);
  } finally { f.close(); }
});

test("new appends keep coverage valid; excluding covered source invalidates the summary", () => {
  const f = fixture();
  try {
    const cp = f.store.commit(f.input);
    f.append({ id: "later", kind: "assistant", content: { text: "new reply" } });
    assert.equal(f.store.compatible(f.profile.id, f.transcriptSessionId).id, cp.id);
    assert.deepEqual(f.store.commit(f.input), cp, "durable completion is idempotent after later appends");
    f.transcripts.setContextExcluded({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      eventId: "early", contextExcluded: true });
    assert.equal(f.store.compatible(f.profile.id, f.transcriptSessionId), null);
    const invalidation = f.store.invalidation(f.profile.id, f.transcriptSessionId, "old-native", "binding-1");
    f.store.close(); f.store.open();
    assert.deepEqual(f.store.invalidation(f.profile.id, f.transcriptSessionId, "renewed-native", "binding-1"), invalidation,
      "restart must not reset the newly created native session again for the same invalidation");
    assert.throws(() => f.store.commit(f.input), { code: "CHECKPOINT_STALE" });
  } finally { f.close(); }
});

test("stale generation, wrong coverage and corrupted provenance cannot commit", () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.commit({ ...f.input, coveredHash: "0".repeat(64) }), { code: "CHECKPOINT_STALE" });
    f.append({ id: "changed", kind: "assistant", content: { text: "new work" } });
    assert.throws(() => f.store.commit({ ...f.input, expectedRevision: Number.MAX_SAFE_INTEGER }), { code: "CHECKPOINT_STALE" });
    const cp = f.store.commit(f.input);
    assert.throws(() => validateCheckpoint({ ...cp, profileId: undefined }), { code: "CHECKPOINT_INVALID" });
    assert.throws(() => validateCheckpoint({ ...cp, summary: { ...cp.summary, goal: ["tampered"] } }), { code: "CHECKPOINT_INVALID" });
  } finally { f.close(); }
});
