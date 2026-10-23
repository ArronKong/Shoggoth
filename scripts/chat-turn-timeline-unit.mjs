#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const ts = require("typescript");
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../app/manage-ui/src/lib/turnTimeline.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const preambles = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../app/manage-ui/src/lib/openclawPreambles.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: preambles });
const source = fs.readFileSync(new URL("../app/manage-ui/src/pages/ChatPage.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("ChatPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Set(["absorbTurnTimelines", "normalize", "contentToText", "isToolResultBlock",
  "toolResultBlockText", "toolResultBlockDuration", "toolResultBlockArgs", "planEntriesFromBlock"]);
const constants = new Set(["TURN_GAP_MS", "STREAM_ERROR_FALLBACK_TEXT"]);
const helpers = ast.statements.filter(node => (ts.isFunctionDeclaration(node) && functions.has(node.name?.text))
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => constants.has(d.name.getText(ast)))));
assert.equal(helpers.length, functions.size + constants.size);
// Media, cards and approval payloads are absent from these transcript fixtures.
// Exercise the actual history normalizer and folding code, including run identity.
const context = { ...preambles, stepsFromParts: exports.stepsFromParts, withoutPlanSteps: steps => steps.filter(s => s.kind !== "plan"),
  normalizeOpenClawMediaFacts: () => [], nativeChatMedia: () => ({ attachments: [], images: [], files: [] }),
  normalizeNativeUiPart: () => null, interruptedApprovalEntry: () => null, validPluginAppCallId: exports.validPluginAppCallId };
vm.runInNewContext(ts.transpileModule(helpers.map(node => node.getText(ast)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const { absorbTurnTimelines, normalize } = context;
const timelines = messages => absorbTurnTimelines(messages).flatMap(m => m.parts).filter(p => p.type === "timeline");
const turn = (run, start = 1000, delay = 180000, id = "call") => [
  { role: "assistant", nativeRunId: run, ts: start, parts: [{ type: "toolCall", toolCallId: id, toolName: "run_command", toolArgs: { command: "python3 report.py" } }] },
  { role: "toolResult", nativeRunId: run, ts: start + delay, parts: [{ type: "toolResult", toolCallId: id, toolName: "run_command", text: "failed", isError: true, durationS: delay / 1000 }] },
  { role: "assistant", nativeRunId: run, ts: start + delay + 1000, parts: [{ type: "text", text: "Final reply" }] },
];
const sample = turn("run-1");
const before = JSON.stringify(sample);
let folded = timelines(sample);
assert.equal(folded.length, 1, "a long tool and its result in one Run share one timeline");
assert.equal(folded[0].steps.length, 1, "a long tool result is not a second tool");
assert.equal(folded[0].steps[0].status, "error");
assert.equal(folded[0].steps[0].durationS, 180);
assert.equal(folded[0].steps[0].toolCallId, "call");
assert.equal(JSON.stringify(sample), before, "history is only projected, never rewritten");
const final = absorbTurnTimelines(sample).at(-1);
assert.equal(final.parts.at(-1).text, "Final reply", "final text survives folding");
assert.equal(timelines([...sample, ...turn("run-1", 600000, 120000, "later")]).length, 1, "long silence inside an identified Run is not a new turn");
assert.equal(timelines([...sample, ...turn("run-2", 183000, 1000, "other")]).length, 2, "different Runs separate even less than 90 seconds apart");
assert.equal(timelines(turn(undefined)).length, 1, "exact tool call ownership survives a long wait without a Run ID");
assert.equal(timelines([...turn(undefined, 1000, 1000), ...turn(undefined, 200000, 1000, "old-next")]).length, 2);
for (const boundary of [{ role: "user" }, { role: "assistant", divider: true }, { role: "assistant", notice: "runInterrupted" },
  { role: "assistant", local: true }, { role: "assistant", pending: true }]) {
  assert.equal(timelines([...sample, { ...boundary, parts: [] }, ...turn("run-1", 183000, 1000, "after")]).length, 2,
    `explicit boundary is stronger than Run identity: ${JSON.stringify(boundary)}`);
}
// OpenClaw sends the authoritative run in __openclaw, including tool results and
// custom nested-tool receipts. Two waits longer than 90 seconds are still one run.
const metadata = (id, runId = "gateway-run") => ({ id, runId });
const gatewayHistory = [
  { role: "user", content: "Check the configuration.", timestamp: 1000 },
  { role: "assistant", __openclaw: metadata("intro"), content: "Checking now.", timestamp: 2000 },
  { role: "assistant", __openclaw: metadata("call-a"), timestamp: 3000,
    content: [{ type: "toolCall", id: "slow-a", name: "openclaw", arguments: { description: "Inspect configuration" } }] },
  { role: "toolResult", __openclaw: metadata("result-a"), timestamp: 332000,
    toolCallId: "slow-a", toolName: "openclaw", content: "configuration", isError: false },
  { role: "assistant", __openclaw: metadata("call-b"), timestamp: 333000,
    content: [{ type: "toolCall", id: "slow-b", name: "wait", arguments: { description: "Wait for verification" } }] },
  { role: "toolResult", __openclaw: metadata("result-b"), timestamp: 607000,
    toolCallId: "slow-b", toolName: "wait", content: "verification failed", isError: true },
  { role: "custom", __openclaw: metadata("nested"), timestamp: 608000,
    content: [{ type: "toolCall", id: "nested-call", name: "exec", arguments: { command: "echo fixture" } },
      { type: "toolResult", toolCallId: "nested-call", name: "exec", content: "fixture", is_error: false }] },
  { role: "assistant", __openclaw: metadata("final"), timestamp: 609000, content: "Verification complete." },
];
const originalGatewayHistory = JSON.stringify(gatewayHistory);
const normalizedGatewayHistory = gatewayHistory.map(normalize);
folded = timelines(normalizedGatewayHistory);
assert.equal(folded.length, 1, "OpenClaw canonical run metadata keeps both long waits in one activity");
assert.deepEqual(Array.from(folded[0].steps, step => step.toolCallId), ["slow-a", "slow-b", "nested-call"],
  "results pair with their calls instead of appearing as duplicate tools");
assert.deepEqual(Array.from(folded[0].steps, step => step.status), ["ok", "error", "ok"]);
assert.equal(folded[0].steps[0].durationS, 329);
assert.equal(folded[0].steps[1].durationS, 274);
assert.equal(normalizedGatewayHistory[2].nativeRunId, undefined, "external run identity does not become a native display identity");
assert.equal(absorbTurnTimelines(normalizedGatewayHistory).at(-1).parts.at(-1).text, "Verification complete.");
assert.equal(JSON.stringify(gatewayHistory), originalGatewayHistory, "canonical source records remain unchanged");
const nextGatewayTurn = gatewayHistory.slice(2).map((message, index) => normalize({ ...message,
  timestamp: 610000 + index * 1000, __openclaw: metadata(`next-${index}`, "other-gateway-run") }));
assert.equal(timelines([...normalizedGatewayHistory, ...nextGatewayTurn]).length, 2, "different external runs stay separate without a time gap");
for (const boundary of [{ role: "user" }, { role: "assistant", divider: true }, { role: "assistant", notice: "runInterrupted" },
  { role: "assistant", local: true }, { role: "assistant", pending: true }]) {
  assert.equal(timelines([...normalizedGatewayHistory, { ...boundary, parts: [] }, ...normalizedGatewayHistory.slice(1)]).length, 2,
    `explicit boundary remains stronger than external run identity: ${JSON.stringify(boundary)}`);
}
for (const runId of [undefined, null, "", 123, {}]) {
  const legacy = gatewayHistory.map(message => normalize({ ...message, toolCallId: undefined,
    content: Array.isArray(message.content) ? message.content.map(part => ({ ...part, id: undefined, toolCallId: undefined })) : message.content,
    __openclaw: { ...message.__openclaw, runId } }));
  assert.equal(timelines(legacy).length, 3, "without Run or call ownership, legacy gap boundaries remain");
}

const hermes = turn(undefined).map(message => ({ ...message, historySource: "hermes" }));
assert.equal(timelines(hermes).length, 1, "Hermes tool latency does not split a stored turn");
assert.equal(timelines([...hermes, { role: "user", automation: "cron", parts: [] }, ...hermes]).length, 2,
  "hidden scheduled inputs must still separate independent Hermes runs");

console.log("chat-turn-timeline-unit: PASS (native, OpenClaw and Hermes long runs, exact pairing, errors, independent runs, explicit boundaries, immutable history)");

// A precise toolCallId remains an ownership link in older records with no Run ID.
const linkedLegacy = [
  { id: "legacy-call", role: "assistant", timestamp: 1000,
    content: [{ type: "toolCall", id: "legacy-search", name: "web_search", arguments: { query: "fixture" } }] },
  { id: "legacy-result", role: "toolResult", timestamp: 151000, toolCallId: "legacy-search", toolName: "web_search", content: "legacy fixture result" },
  { id: "legacy-answer", role: "assistant", timestamp: 152000, content: "legacy answer" },
].map(raw => { const m = normalize(raw); return { ...m, actionId: m.id }; });
const detachedProjection = absorbTurnTimelines(linkedLegacy.map((m, index) => index === 2 ? { ...m, ts: 310000 } : m));
assert.equal(detachedProjection.filter(m => m.role === "toolResult").length, 0,
  "the exact tool result stays in its process even when the later answer is delayed too");
const linkedProjection = absorbTurnTimelines(linkedLegacy);
assert.equal(linkedProjection.filter(m => m.role === "toolResult").length, 0,
  "a delayed result with an exact call owner must not escape the process card");
assert.equal(timelines(linkedLegacy).length, 1);
const linkedStep = timelines(linkedLegacy)[0].steps[0];
assert.equal(linkedStep.toolCallId, "legacy-search");
assert.equal(linkedStep.output, "legacy fixture result", "folding retains the actual result, not just its call");
assert.equal(linkedStep.durationS, 150);

assert.equal(linkedProjection.find(m => m.id === "legacy-answer").turnStartId, "legacy-call",
  "unread body locates the process of the same turn");
assert.equal(linkedProjection.at(-1).parts.at(-1).text, "legacy answer");
assert.equal(timelines([...linkedLegacy, { role: "user", parts: [] }, ...linkedLegacy]).length, 2,
  "a user boundary is stronger than a reused tool call id");
const unmatched = absorbTurnTimelines([{ ...linkedLegacy[1], parts: [{ ...linkedLegacy[1].parts[0], toolCallId: "no-owner" }] }]);
assert.equal(unmatched[0].role, "toolResult", "an unknown owner must stay inspectable rather than be attached to another turn");
console.log("PASS linked legacy tool results and process ownership for unread navigation");
