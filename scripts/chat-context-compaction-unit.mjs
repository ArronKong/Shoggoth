#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const ts = require("typescript");
const { buildSync } = require("esbuild");
const load = relative => {
  const module = { exports: {} };
  const bundle = buildSync({ entryPoints: [new URL(relative, import.meta.url).pathname], bundle: true,
    platform: "node", format: "cjs", write: false }).outputFiles[0].text;
  vm.runInNewContext(bundle, { module, exports: module.exports });
  return module.exports;
};
const { createTimeline, reduceTimeline, stepsFromParts } = load("../app/manage-ui/src/lib/turnTimeline.ts");
const { withoutPlanSteps } = load("../app/manage-ui/src/lib/chatPlan.ts");
const source = fs.readFileSync(new URL("../app/manage-ui/src/pages/ChatPage.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("ChatPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["settlePendingAssistant", "retainLiveLayout", "absorbTurnTimelines"];
const functions = names.map(name => {
  const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `Missing ChatPage helper: ${name}`);
  return node.getText(ast);
});
const gap = ast.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "TURN_GAP_MS"));
assert.ok(gap);
const context = { withoutPlanSteps, stepsFromParts };
vm.runInNewContext(ts.transpileModule([...functions, gap.getText(ast)].join("\n"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const { settlePendingAssistant, retainLiveLayout, absorbTurnTimelines } = context;
const plain = value => JSON.parse(JSON.stringify(value));
const user = { id: "user-1", role: "user", ts: 1000, parts: [{ type: "text", text: "Continue" }] };
const emptyTail = { role: "assistant", pending: true, parts: [{ type: "text", text: "" }] };
let live = reduceTimeline(createTimeline(), { kind: "status", status: { kind: "compacting", text: "Raw compaction progress" } }, 10);
live = reduceTimeline(live, { kind: "error", message: "Compaction failed" }, 20);
const stopped = settlePendingAssistant([user, emptyTail], live.steps);
assert.equal(stopped.length, 2, "status-only terminal tail must stay visible");
assert.equal(stopped[1].pending, false);
assert.equal(stopped[1].settledPending, false, "terminal receipt cannot use a later turn's live state");
assert.equal(stopped[1].parts[0].type, "timeline");
assert.equal(stopped[1].parts[0].steps[0].status, "error");
assert.equal(stopped[1].parts[0].steps[0].text, "Raw compaction progress");
assert.equal(settlePendingAssistant([emptyTail]).length, 0, "ordinary empty stopped cursors are still removed");
const before = JSON.stringify(stopped);
const canonical = [{ ...user }];
const refreshed = retainLiveLayout(stopped, canonical);
assert.equal(refreshed.length, 2, "canonical refresh retains the current status-only receipt");
assert.equal(retainLiveLayout(refreshed, canonical).length, 2, "repeated refresh cannot duplicate the receipt");
assert.equal(JSON.stringify(stopped), before, "layout projection cannot mutate the receipt");
assert.deepEqual(plain(canonical), [user], "canonical history remains untouched");
const nextUser = { ...user, id: "user-2", ts: 2000 };
assert.equal(retainLiveLayout(stopped, [user, nextUser]).length, 2, "a new input cannot inherit the old receipt");
assert.equal(retainLiveLayout(stopped, []).length, 0, "an unproven history tail cannot retain an old receipt");
assert.equal(retainLiveLayout(stopped, [{ ...user, id: "other-user" }]).length, 1, "same text is not enough to match a different turn");

let toolLive = reduceTimeline(createTimeline(), { kind: "tool", toolCallId: "read-1", name: "read_file", phase: "start", args: { path: "/tmp/report.md" } }, 1);
toolLive = reduceTimeline(toolLive, { kind: "tool", toolCallId: "read-1", phase: "result", result: "report" }, 2);
toolLive = reduceTimeline(toolLive, { kind: "status", status: { kind: "compacting" } }, 3);
toolLive = reduceTimeline(toolLive, { kind: "aborted" }, 4);
const priorTool = { role: "assistant", ts: 1001, parts: [{ type: "toolCall", toolCallId: "read-1", toolName: "read_file" },
  { type: "toolResult", toolCallId: "read-1", text: "report" }] };
const withPriorOutput = settlePendingAssistant([user, priorTool, emptyTail], toolLive.steps);
const folded = absorbTurnTimelines(withPriorOutput);
const timelines = folded.flatMap(message => message.parts).filter(part => part.type === "timeline");
assert.equal(timelines.length, 1, "terminal snapshot and earlier tools share one process card");
assert.deepEqual(Array.from(timelines[0].steps, step => step.kind), ["tool", "status"]);
assert.equal(timelines[0].steps[1].status, "aborted");
console.log("chat-context-compaction-unit: PASS (terminal snapshots, refresh, turn ownership, immutable history, shared tool activity)");
