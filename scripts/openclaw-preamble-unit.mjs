#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const ts = createRequire(new URL("../app/manage-ui/package.json", import.meta.url))("typescript");
const load = name => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(`../app/manage-ui/src/lib/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports });
  return exports;
};
const { createOpenClawPreambles, openClawPreambleIds, openClawPreambleKey } = load("openclawPreambles");
const { keyedChatMessages, keyedChatChildren, keyedChatGroups } = load("chatRuntime");
const project = p => ({ role: "assistant", ts: p.ts, activityRunId: p.runId,
  openclawPreambleKey: p.key, openclawLivePreamble: true, parts: [{ type: "text", text: p.text }] });
const store = createOpenClawPreambles(project);
const frame = (itemId, text, seq, phase = "update", sessionKey = "main", runId = "r1") => ({
  sessionKey, runId, seq, ts: seq * 1000, stream: "item", data: { kind: "preamble", itemId, phase, progressText: text },
});
const textOf = messages => messages.map(m => m.parts[0]?.text).join("|");
const user = { role: "user", ts: 0, parts: [{ type: "text", text: "user" }] };
const pending = { role: "assistant", pending: true, parts: [{ type: "text", text: "answer" }] };
assert(store.ingest(frame("one", "part", 1)));
const partial = store.merge("main", [user, pending]);
assert.equal(textOf(partial), "user|part|answer");
assert(store.ingest(frame("one", "full", 2, "end")));
const complete = store.merge("main", partial);
assert.equal(textOf(complete), "user|full|answer");
assert.equal(keyedChatMessages(partial)[1].key, keyedChatMessages(complete)[1].key);
assert.equal(keyedChatChildren(partial[1], "part", partial[1].parts)[0].key,
  keyedChatChildren(complete[1], "part", complete[1].parts)[0].key, "growing snapshot keeps its text subtree");
assert(!store.ingest(frame("one", "stale", 1)));
assert(!store.ingest(frame("one", "late update after end", 3)));
assert(store.ingest(frame("two", "full", 4, "end")));
assert.equal(textOf(store.merge("main", [user])), "user|full|full", "equal text with different identities is retained");
assert(store.ingest(frame("two", "other session", 4, "end", "other")));
assert.equal(textOf(store.merge("other", [])), "other session");
assert(store.ingest(frame("one", "other run", 5, "end", "main", "r2")));
assert.equal(textOf(store.merge("main", [user])), "user|full|full|other run");
const raw = { role: "assistant", __openclaw: { id: "same-message-id", runId: "r1" }, content: [
  { type: "text", text: "canonical whitespace\nfull", textSignature: JSON.stringify({ v: 1, id: "one", phase: "commentary" }) },
  { type: "thinking", textSignature: JSON.stringify({ v: 1, id: "private", phase: "commentary" }) },
] };
assert.equal(JSON.stringify(openClawPreambleIds(raw)), '["one"]');
for (const invalid of [null, {}, { ...raw, role: "user" }, { ...raw, __openclaw: {} },
  { ...raw, content: [{ type: "text", textSignature: "invalid" }] },
  { ...raw, content: [{ type: "text", textSignature: JSON.stringify({ v: 1, id: "one", phase: "final" }) }] }]) {
  assert.equal(openClawPreambleIds(invalid).length, 0);
}
// chat.history projects commentary into unsigned text blocks. Its exact item
// identity lives on openclawStreamFallback, while tool siblings share the record id.
const segment = (itemId, text, runId = "r1") => ({
  role: "assistant", timestamp: 1100, __openclaw: { id: "shared-transcript-id", runId },
  content: [{ type: "text", text }],
  openclawStreamFallback: { source: "segment", itemId, replacementText: text },
});
const projected = segment("one", "first paragraph\n\nsecond paragraph");
assert.equal(JSON.stringify(openClawPreambleIds(projected)), '["one"]', "projected commentary retains its item identity");
assert.equal(JSON.stringify(openClawPreambleIds({ ...projected, content: raw.content })), '["one"]', "two representations of the same identity are acknowledged once");
for (const invalid of [
  { ...projected, role: "user" }, { ...projected, role: "toolResult" },
  { ...projected, __openclaw: { id: "shared-transcript-id" } },
  { ...projected, __openclaw: { runId: " " } },
  ...[undefined, null, [], {}, { source: "turn", itemId: "one" }, { itemId: "one" },
    { source: "segment", itemId: "" }, { source: "segment", itemId: " " },
    { source: "segment", itemId: 1 }].map(openclawStreamFallback => ({ ...projected, openclawStreamFallback })),
]) assert.equal(openClawPreambleIds(invalid).length, 0, "unsigned text or a transcript id alone cannot acknowledge a live item");

const projectedStore = createOpenClawPreambles(project);
const normalizeProjected = message => {
  const ids = openClawPreambleIds(message);
  return { role: message.role, ts: message.timestamp, id: message.__openclaw.id,
    activityRunId: message.__openclaw.runId, openclawPreambleIds: ids,
    openclawPreambleKey: ids.length === 1 ? openClawPreambleKey(message.__openclaw.runId, ids[0]) : undefined,
    parts: message.content };
};
const repeatedText = "first paragraph\n\nsecond paragraph";
for (const itemId of ["one", "two"]) assert(projectedStore.ingest(frame(itemId, repeatedText.replace(/\s+/g, " "), 1, "end")));
const final = { role: "assistant", activityRunId: "r1", ts: 3000, parts: [{ type: "text", text: "final answer" }] };
const toolSibling = normalizeProjected({ ...projected, openclawStreamFallback: undefined,
  content: [{ type: "toolCall", id: "tool-one", name: "read" }] });
const firstSegment = normalizeProjected(projected);
const staged = projectedStore.merge("main", [firstSegment, toolSibling, final]);
assert.equal(staged.length, 4, "history replaces its exact item and retains the other equal-text item during history lag");
assert.equal(staged.filter(m => m.openclawLivePreamble).length, 1);
assert(staged.includes(toolSibling), "the tool sibling remains intact");
assert(!projectedStore.ingest(frame("one", "late replay after acknowledgement", 10, "end")));
projectedStore.finish("main", "r1");
const projectedHistory = [firstSegment, normalizeProjected(segment("two", repeatedText)), final];
const projectedBefore = JSON.stringify(projectedHistory);
const reconciled = projectedStore.merge("main", projectedHistory);
assert.equal(reconciled.length, 3, "two projected progress records plus the final answer produce exactly three bubbles");
assert.equal(reconciled.filter(m => m.openclawLivePreamble).length, 0);
assert.equal(JSON.stringify(projectedHistory), projectedBefore, "projection acknowledgement does not mutate canonical history");
const crossRun = createOpenClawPreambles(project);
assert(crossRun.ingest(frame("one", repeatedText, 1, "end")));
assert.equal(crossRun.merge("main", [normalizeProjected(segment("one", repeatedText, "different-run"))]).length, 2,
  "a matching item id from another run cannot consume this run's progress");
const canonical = { role: "assistant", ts: 1100, id: "same-message-id", activityRunId: "r1",
  openclawPreambleIds: ["one"], openclawPreambleKey: openClawPreambleKey("r1", "one"), parts: [{ type: "text", text: "canonical" }] };
const before = JSON.stringify([user, canonical]);
const merged = store.merge("main", [user, canonical]);
assert.equal(textOf(merged), "user|canonical|full|other run", "exact run/item acknowledgement replaces only its projection");
assert.equal(JSON.stringify([user, canonical]), before, "canonical history is never mutated");
assert.equal(keyedChatMessages([canonical])[0].key, keyedChatMessages([complete[1]])[0].key);
assert.equal(keyedChatGroups([{ msgs: [canonical] }])[0].key, keyedChatGroups([{ msgs: [complete[1]] }])[0].key);
assert(!store.ingest(frame("one", "acknowledged replay", 100, "end")));
store.finish("main", "r1");
assert(!store.ingest(frame("new", "late after final", 101)));
assert.equal(textOf(store.merge("main", [user, canonical])), "user|canonical|full|other run", "terminal event does not discard unacknowledged items");
assert(store.ingest(frame("next", "next run still live", 102, "end", "main", "r2")));
for (const invalid of [{}, { ...frame("x", "bad", 1), stream: "assistant" },
  { ...frame("x", "bad", 1), sessionKey: "" }, { ...frame("x", "bad", 1), runId: "" },
  frame("", "bad", 1), frame("x", "", 1), frame("x", "bad", 1, "thinking"),
  { ...frame("x", "bad", 1), data: { kind: "tool", itemId: "x", phase: "end", progressText: "bad" } }]) {
  assert(!store.ingest(invalid));
}
const ordered = createOpenClawPreambles(project);
assert(ordered.ingest(frame("ordered", "latest", 10)));
assert(!ordered.ingest(frame("ordered", "older snapshot", 9)));
assert(!ordered.ingest(frame("ordered", "older end", 8, "end")));
assert(ordered.ingest(frame("ordered", "sealed", 11, "end")));
assert.equal(textOf(ordered.merge("main", [])), "sealed");
store.forget("main");
assert.equal(store.merge("main", []).length, 0);
assert(!store.ingest(frame("resurrected", "late reset event", 200)));
assert.equal(textOf(store.merge("other", [])), "other session", "reset is session scoped");
console.log("OpenClaw preambles: snapshots, exact identity, history lag, replay, terminal, isolation and stable render keys passed");
