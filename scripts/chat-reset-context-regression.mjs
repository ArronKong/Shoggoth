#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "../app/manage-ui/node_modules/typescript/lib/typescript.js";

const source = readFileSync(new URL("../app/manage-ui/src/pages/ChatPage.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("ChatPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ["dispatchSlash", "ctxLimit", "ctxPct"].includes(node.name.getText(ast))) {
    declarations.set(node.name.getText(ast), node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.size, 3, "exercise the production dispatcher and meter");
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const dispatcher = compile(`globalThis.dispatch = ${declarations.get("dispatchSlash")};`);
const meter = compile(`const ctxLimit = ${declarations.get("ctxLimit")}; globalThis.pct = ${declarations.get("ctxPct")};`);
const key = "agent:main:dashboard:reset-regression";
function fixture({ deny = false, switchDuringRequest = false, native = false, hermes = false } = {}) {
  const calls = [], toasts = [], archive = { key, msgs: ["old archive"] };
  const context = {
    activeKeyRef: { current: key },
    chatBackendDescriptors: new Map([["fixture", { surfaces: { agentHarness: native } }]]),
    backendOfSession: () => "fixture",
    agentOf: () => hermes ? "hermes-default" : "main",
    shouldHandleSlashLocally: () => !native && !hermes,
    reloadOnFinalRef: { current: new Set() },
    inFlightRef: { current: new Set([key]) },
    recentSendRef: { current: new Map([[key, "prior send"]]) },
    liveToolsRef: { current: new Map([[key, ["tool"]]]) },
    pendingThinkingRef: { current: new Map([[key, "thinking"]]) },
    pendingPlanRef: { current: new Map([[key, ["plan"]]]) },
    archivePrefixRef: { current: archive },
    historyControllerRef: { current: { markNeedsRevalidate: k => calls.push(["revalidate", k]) } },
    send: async (method, params) => {
      calls.push([method, JSON.parse(JSON.stringify(params))]);
      if (switchDuringRequest) context.activeKeyRef.current = "agent:main:other";
      if (deny) throw Error("missing scope: operator.admin");
      return { payload: { ok: true, key } };
    },
    sendChatMessage: async (...args) => calls.push(["chat.send", ...args]),
    replacePendingPrompts: k => calls.push(["prompts", k]),
    setRunningKeys: () => {},
    setSending: value => calls.push(["sending", value]),
    setArchive: value => calls.push(["archive", value.key]),
    loadHistory: async k => calls.push(["history", k]),
    refreshSessions: async () => calls.push(["sessions.list"]),
    markInFlight: () => { throw Error("must not flush queued prompts on reset"); },
    setToast: value => toasts.push(typeof value === "function" ? value(toasts.at(-1)) : value),
    t: (name, values) => values?.msg ? `${name}: ${values.msg}` : name,
    setTimeout: () => {},
  };
  vm.runInNewContext(dispatcher, context);
  return { context, calls, toasts, archive };
}
{
  const f = fixture();
  assert.equal(await f.context.dispatch({ name: "reset" }, "", "/reset"), true);
  assert.deepEqual(f.calls[0], ["sessions.reset", { key, reason: "reset" }]);
  assert.ok(f.calls.some(([op, k]) => op === "history" && k === key));
  assert.ok(f.calls.some(([op]) => op === "sessions.list"));
  assert.equal(f.calls.some(([op]) => op === "chat.send"), false, "bare desktop reset is not a channel message");
  assert.equal(f.context.liveToolsRef.current.has(key), false);
  assert.equal(f.toasts.at(-1).text, "chat.sessionReset");
}
{
  const f = fixture({ deny: true });
  await f.context.dispatch({ name: "reset" }, "", "/reset");
  assert.equal(f.calls.length, 1, "denial must not clear or reload the transcript");
  assert.equal(f.context.archivePrefixRef.current, f.archive);
  assert.equal(f.context.inFlightRef.current.has(key), true);
  assert.match(f.toasts.at(-1).text, /operator.admin/);
}
{
  const f = fixture({ switchDuringRequest: true });
  await f.context.dispatch({ name: "reset" }, "", "/reset");
  assert.equal(f.context.archivePrefixRef.current, f.archive, "late reset must not clear the newly selected session");
  assert.equal(f.calls.some(([op]) => ["history", "sending", "archive"].includes(op)), false);
  assert.equal(f.toasts.at(-1), null, "a late reset must not put success feedback on another conversation");
}
{
  const f = fixture();
  await f.context.dispatch({ name: "reset" }, "soft keep context", "/reset soft keep context");
  assert.equal(f.calls[0][0], "chat.send", "runtime keeps soft reset and follow-up semantics");
  assert.equal(f.calls.some(([op]) => op === "sessions.reset"), false);
}
for (const backend of ["native", "hermes"]) {
  const f = fixture({ [backend]: true });
  assert.equal(await f.context.dispatch({ name: "reset" }, "", "/reset"), false);
  assert.equal(f.calls.length, 0, `${backend} reset stays with its runtime`);
}
for (const [active, expected] of [
  [{ totalTokens: 293851, model: "grok-4.6", modelProvider: "xai" }, null],
  [{ totalTokens: 293851, contextTokens: 500000 }, 59],
  [{ totalTokens: 293851, contextTokens: 1000000 }, 29],
  [{ totalTokens: 293851, contextTokens: 200000 }, 100],
  [{ totalTokens: 293851, contextTokens: 500000, totalTokensFresh: false }, null],
]) {
  const context = { active, defaultCtxTokens: 200000 };
  vm.runInNewContext(meter, context);
  assert.equal(context.pct, expected, "only the selected session can establish its window");
}
assert.doesNotMatch(source, /defaultCtxTokens|defaultContextTokens/, "usage, status and immersive views must not reintroduce a generic window");
console.log("chat reset/context regression: PASS (reset, rejection, session switch, runtime args, backend isolation, unknown and known windows)");
