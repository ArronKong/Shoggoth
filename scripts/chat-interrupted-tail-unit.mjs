#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const requireUi = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const ts = requireUi("typescript"), { buildSync } = requireUi("esbuild");
const load = relative => {
  const module = { exports: {} };
  vm.runInNewContext(buildSync({ entryPoints: [new URL(relative, import.meta.url).pathname], bundle: true,
    platform: "node", format: "cjs", write: false }).outputFiles[0].text, { module, exports: module.exports });
  return module.exports;
};
const { createTimeline, reduceTimeline } = load("../app/manage-ui/src/lib/turnTimeline.ts");
const { withoutPlanSteps } = load("../app/manage-ui/src/lib/chatPlan.ts");
const { classifyChatSendObservation } = load("../app/manage-ui/src/lib/chatSendRecovery.ts");
const source = fs.readFileSync(new URL("../app/manage-ui/src/pages/ChatPage.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("ChatPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = name => {
  let found;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(ast); assert(found, `Missing production callback ${name}`); return found;
};
const settle = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "settlePendingAssistant");
assert(settle);
const finalize = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "finalizeAssistant");
assert(finalize);
const verify = declaration("verifyPendingTrackedSends").initializer.arguments[0].getText(ast);
const liveSteps = declaration("liveStepsFor").initializer.getText(ast);
const plain = value => JSON.parse(JSON.stringify(value));
const key = "agent:shoggoth-fixture:session", other = "agent:shoggoth-other:session";
const user = { role: "user", id: "original-user", parts: [{ type: "text", text: "Search" }] };

async function fixture(status, options = {}) {
  let records = [{ key, idem: "original-operation", backendId: "shoggoth", at: 100, accepted: true }];
  let messages = [user, { role: "assistant", pending: true, parts: [
    { type: "text", text: "Already checked the first result." },
    { type: "toolCall", toolCallId: "original-tool", toolName: "browser_read" },
    { type: "prompt", promptEntry: { requestId: "old-request" } },
  ] }];
  let timeline = reduceTimeline(createTimeline(), { kind: "tool", toolCallId: "original-tool",
    name: "browser_read", phase: "start" }, 1);
  const liveTimelinesRef = { current: new Map([[key, timeline]]) };
  const liveToolsRef = { current: new Map([[key, [{ id: "original-tool" }]], [other, [{ id: "other-tool" }]]]) };
  const pendingThinkingRef = { current: new Map([[key, "original thought"], [other, "other thought"]]) };
  const pendingPlanRef = { current: new Map() }, progressCardsRef = { current: new Map() };
  const pendingPrompts = new Map([[key, [{ requestId: "old-request" }]]]);
  const inFlight = new Set([key, other]), historyLoads = [], requests = [], events = [];
  const context = {
    withoutPlanSteps, classifyChatSendObservation,
    normalize: raw => ({ role: raw.role, parts: raw.content }),
    readPendingTrackedSends: () => records, backendOfSession: () => "shoggoth", agentOf: () => "fixture",
    sendObservationEpochRef: { current: new Map() }, terminalObservedSendRef: { current: new Map() },
    pendingChatSendStore: { clearTerminalObservation: () => true }, pendingSendDraftRef: { current: new Map() },
    liveTimelinesRef, liveToolsRef, pendingThinkingRef, pendingPlanRef, progressCardsRef,
    liveTextRef: { current: new Map([[key, "partial"]]) }, steerTextBaselineRef: { current: new Map() },
    activeKeyRef: { current: options.background ? other : key }, inFlightRef: { current: inFlight },
    runStatusBySessionRef: { current: new Map() },
    acceptTrackedSend: () => true,
    forgetPendingTrackedSend: (owner, id) => { records = records.filter(row => row.key !== owner || row.idem !== id); return true; },
    hasPendingTrackedSend: owner => records.some(row => row.key === owner),
    markInFlight: (owner, on) => { if (on) inFlight.add(owner); else inFlight.delete(owner); },
    setVerificationKeys: () => {}, setSending: () => {},
    // An unavailable canonical history must not be needed to close local generation UI.
    loadHistory: async owner => { historyLoads.push(owner); },
    send: async (method, params) => {
      requests.push({ method, params });
      if (options.unresolved) return { payload: { status: "unresolved" } };
      return { payload: { status: "found", admissionAccepted: true, stateAuthority: "native-service",
        run: { id: "original-run", status } } };
    },
    timelineFeed: (owner, event) => {
      events.push(event); timeline = reduceTimeline(liveTimelinesRef.current.get(owner), event, 2);
      liveTimelinesRef.current.set(owner, timeline);
    },
    updateSessionMessages: (owner, update) => { assert.equal(owner, key); messages = update(messages); },
    replacePendingPrompts: (owner, prompts) => { pendingPrompts.set(owner, prompts); },
    progressCardPlan: () => [], clearTimeout, setTimeout,
    visibleTimelineSteps: steps => steps,
    subagentActivity: { project: (_owner, steps) => steps }, observedRunBySessionRef: { current: new Map() },
    withStartupWait: steps => steps, runWaitBySession: {},
  };
  const compiled = ts.transpileModule(`${settle.getText(ast)}\n${finalize.getText(ast)}\nglobalThis.verify = ${verify};\nglobalThis.liveSteps = ${liveSteps};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, context);
  const original = plain(messages);
  await context.verify(key);
  return { context, messages, original, records, inFlight, historyLoads, requests, events,
    pendingPrompts, liveToolsRef, pendingThinkingRef };
}

for (const status of ["interrupted", "canceled", "failed", "completed"]) {
  for (const background of [false, true]) {
    const f = await fixture(status, { background });
    assert.equal(f.messages.some(message => message.pending), false,
      `${status} durable receipt must close the old bubble even when history cannot refresh`);
    assert.equal(f.messages[1].parts.some(part => part.type === "prompt"), false);
    assert.equal(f.messages[1].parts.some(part => part.type === "text" && part.text === "Already checked the first result."), true);
    const steps = f.messages[1].parts.flatMap(part => part.type === "timeline" ? part.steps : []);
    assert.equal(steps.some(step => step.toolCallId === "original-tool"), true, "keep this run's process snapshot");
    assert.equal(steps.some(step => ["running", "pending"].includes(step.status)), false);
    assert.equal(f.liveToolsRef.current.has(key), false, "history decoration cannot recreate the retired bubble");
    assert.equal(f.pendingThinkingRef.current.has(key), false);
    assert.deepEqual(plain(f.pendingPrompts.get(key)), []);
    assert.equal(f.liveToolsRef.current.has(other), true, "another conversation's tools remain live");
    assert.equal(f.pendingThinkingRef.current.get(other), "other thought");
    assert.equal(f.inFlight.has(key), false); assert.equal(f.inFlight.has(other), true);
    assert.equal(f.records.length, 0);
    assert.equal(f.requests.some(request => request.method === "chat.send"), false, "recovery never replays the user message");
    assert.equal(f.requests.some(request => request.method === "chat.abort"), false, "display cleanup never aborts another turn");
    const frozen = JSON.stringify(f.messages[1]);
    f.context.liveTimelinesRef.current.set(key, reduceTimeline(createTimeline(), {
      kind: "tool", toolCallId: "next-tool", name: "browser_read", phase: "start",
    }, 3));
    assert.deepEqual(plain(f.context.liveSteps(f.messages[1])), [], "an old bubble cannot borrow the next run's live process");
    assert.equal(JSON.stringify(f.messages[1]), frozen);
    if (status === "completed") {
      const finalText = "Complete checked results.";
      const finished = f.context.finalizeAssistant(f.messages, { role: "assistant", content: [{ type: "text", text: finalText }] }, undefined, true);
      assert.equal(finished.length, f.messages.length, "a late final replaces its settled partial bubble");
      assert.equal(finished[1].parts.some(part => part.text === finalText), true);
      assert.equal(finished[1].parts.some(part => part.type === "timeline"), true, "a late final retains the frozen process");
    }
  }
}
for (const status of ["running", "waiting_input", "waiting_approval", "starting"]) {
  const f = await fixture(status);
  assert.deepEqual(plain(f.messages), f.original, "a live authoritative receipt must retain the current loading bubble");
  assert.equal(f.inFlight.has(key), true); assert.equal(f.records.length, 1);
  assert.equal(f.events.length, 0);
}
const unresolved = await fixture(null, { unresolved: true });
assert.deepEqual(plain(unresolved.messages), unresolved.original);
assert.equal(unresolved.records.length, 1, "uncertain operations retain the original send fence");
assert.equal(unresolved.inFlight.has(key), true);
console.log("chat-interrupted-tail-unit: PASS (missing terminal event, unavailable history, all terminal states, background ownership, no replay, active and uncertain retention)");
