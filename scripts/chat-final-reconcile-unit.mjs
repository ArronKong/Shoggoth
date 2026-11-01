#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const requireUi = createRequire(new URL("../app/manage-ui/package.json", import.meta.url)), ts = requireUi("typescript");
const source = fs.readFileSync(new URL("../app/manage-ui/src/pages/ChatPage.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("ChatPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "finalizeAssistant");
assert(node);
const context = { normalize: raw => ({ role: raw.role, parts: raw.content, nativeRunId: raw.shoggoth?.runId,
  model: raw.model, usage: raw.usage, responseMetadata: raw.responseMetadata }) };
vm.runInNewContext(ts.transpileModule(node.getText(ast), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, context);
const finish = (messages, raw, terminal = true) => context.finalizeAssistant(messages, raw, undefined, true, terminal);
const user = { role: "user", id: "user-1", parts: [{ type: "text", text: "查找热门帖子" }] };
const text = "结论\n\n| 排名 | 场景 |\n|---|---|\n| 1 | 设计 |";
const saved = { role: "assistant", id: "canonical-final", nativeRunId: "run-1", ts: 123,
  canonicalSourceEventId: "canonical-source", parts: [{ type: "text", text, segmentId: "final-segment", sourceEventId: "canonical-source" }] };
const raw = { role: "assistant", content: [{ type: "text", text }], shoggoth: { runId: "run-1" }, model: "fixture-model" };
const plain = value => JSON.parse(JSON.stringify(value));
const original = JSON.stringify(saved);

for (const tail of [[], [{ role: "assistant", pending: true, parts: [{ type: "text", text: "" }] }],
  [{ role: "assistant", pending: true, nativeRunId: "run-1", parts: [{ type: "toolCall", toolCallId: "browser-1" }, { type: "text", text }] }]]) {
  const previous = [user, saved, ...tail], before = JSON.stringify(previous);
  const result = finish(previous, raw);
  assert.equal(result.length, 2, "history before final keeps one conclusion even when decoration left a pending tail");
  assert.equal(result[1].id, saved.id); assert.equal(result[1].ts, saved.ts);
  assert.equal(result[1].canonicalSourceEventId, saved.canonicalSourceEventId);
  assert.equal(result[1].model, "fixture-model");
  assert.equal(result[1].parts.filter(part => part.type === "text").length, 1);
  assert.deepEqual(plain(result[1].parts.find(part => part.type === "text")), saved.parts[0]);
  assert.equal(JSON.stringify(previous), before, "reconciliation never mutates history or the old render snapshot");
}
assert.equal(JSON.stringify(saved), original);
let result = finish([user, { role: "assistant", pending: true, parts: [{ type: "text", text }] }], raw);
for (let repeat = 0; repeat < 3; repeat++) result = finish(result, raw);
assert.equal(result.length, 2, "repeated final frames for one Run do not append bubbles");

const commentary = { ...saved, id: "commentary", parts: [{ type: "text", text, activity: true, segmentId: "commentary-segment" }] };
assert.equal(finish([user, commentary], raw).length, 3, "identical commentary is a separate source and remains visible");
assert.equal(finish([user, saved], raw, false).length, 3, "an interim is not treated as a terminal replay");
assert.equal(finish([user, { ...saved, nativeRunId: "other-run" }], raw).length, 3, "wording cannot merge different Runs");
assert.equal(finish([user, saved, { ...user, id: "next-user" }], raw).length, 4, "a user boundary fences the earlier conclusion");
assert.equal(finish([user, saved], { ...raw, shoggoth: undefined }).length, 3, "missing Run identity never authorizes text deduplication");
const foreignPending = { role: "assistant", pending: true, nativeRunId: "other-run", parts: [{ type: "text", text: "另一轮仍在运行" }] };
assert.equal(finish([user, saved, foreignPending], raw).at(-1), foreignPending, "a foreign live turn is not retired");
console.log("chat-final-reconcile-unit: PASS (history-first, duplicate final, pending decoration, canonical identity, source and user boundaries, immutable snapshots)");
