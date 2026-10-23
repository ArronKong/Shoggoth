#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "../app/manage-ui/node_modules/typescript/lib/typescript.js";

const compile = code => ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(compile(readFileSync(new URL("../app/manage-ui/src/lib/chatSlashHistory.ts", import.meta.url), "utf8")), { exports });
const source = readFileSync(new URL("../app/manage-ui/src/pages/ChatPage.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("ChatPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "execServerSlash") handler = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handler, "exercise the production slash dispatcher");
const plain = value => JSON.parse(JSON.stringify(value));
const text = message => message.parts.map(part => part.text || "").join("");
const user = (value, ts) => ({ role: "user", parts: [{ type: "text", text: value }], ts });
const key = "agent:hermes-default:fixture";
function fixture() {
  const history = exports.createChatSlashHistory();
  const requests = [], forwarded = [], drafts = new Map();
  let messages = [], now = 1_000, id = 0, input = "";
  const environment = {
    Date: { now: () => now }, crypto: { randomUUID: () => `slash-${++id}` }, Error,
    activeKeyRef: { current: key }, messagesRef: { get current() { return messages; }, set current(value) { messages = value; } },
    localSlashHistoryRef: { current: history }, inFlightRef: { current: new Set() },
    sendController: { canSend: () => true },
    draftsRef: { current: drafts }, inputRef: { get current() { return input; }, set current(value) { input = value; } },
    agentOf: () => "hermes-default", setToast: () => {}, focusComposer: () => {},
    setInput: value => { input = value; },
    setMessages: update => { messages = typeof update === "function" ? update(messages) : update; },
    t: (name, values) => `${name}${values?.msg ? `: ${values.msg}` : ""}`,
    pushLocal: value => { messages.push({ role: "system", local: true, parts: [{ type: "text", text: value }], ts: now }); },
    sendChatMessage: async (...args) => { forwarded.push(args); },
    execSlashCommand: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  };
  vm.runInNewContext(compile(`globalThis.execute = ${handler};`), environment);
  return { environment, history, requests, forwarded, drafts,
    execute: raw => environment.execute(key, raw),
    get messages() { return messages; },
    set messages(value) { messages = value; },
    set now(value) { now = value; },
    get input() { return input; },
    set input(value) { input = value; },
  };
}

for (const outcome of ["success", "error", "uncertain"]) {
  const f = fixture();
  const task = f.execute("/compress");
  assert.deepEqual(f.messages.filter(m => m.role === "user").map(text), ["/compress"], "the command is visible before RPC completion");
  assert.equal(f.messages[0].ts, 1_000);
  f.now = 2_000;
  f.messages.push(user("你先修复Hermes的", 2_000));
  // A history refresh must retain the earlier command and pending result.
  f.messages = f.history.merge(key, [user("你先修复Hermes的", 2_000)]);
  f.now = 3_000;
  if (outcome === "error") f.requests[0].reject(new Error("permission denied"));
  else f.requests[0].resolve({ kind: "output", text: "compression result", executionUncertain: outcome === "uncertain" });
  await task;
  assert.deepEqual(plain(f.messages.filter(m => m.role === "user").map(text)), ["/compress", "你先修复Hermes的"]);
  assert.equal(f.messages[0].ts, 1_000, "completion cannot rewrite submission time");
  assert.equal(f.messages[1].local, true, "the result stays beside its command, before the later user message");
  assert.match(text(f.messages[1]), outcome === "error" ? /slashFailed/ : outcome === "uncertain" ? /slashUncertain/ : /compression result/);
  assert.equal(f.messages.filter(m => m.localSlashId).length, 2, "one echo and one updated result");
  const refreshed = f.history.merge(key, [user("你先修复Hermes的", 2_000)]);
  assert.deepEqual(plain(refreshed), plain(f.messages), "canonical reload preserves completed local output");
}

{
  const f = fixture();
  const first = f.execute("/compress"), second = f.execute("/status");
  f.messages.push(user("later in the same millisecond", 1_000));
  f.requests[1].resolve({ kind: "output", text: "second result" }); await second;
  f.requests[0].resolve({ kind: "output", text: "first result" }); await first;
  f.messages = f.history.merge(key, [user("later in the same millisecond", 1_000)]);
  assert.deepEqual(plain(f.messages.map(text)), ["/compress", "```\nfirst result\n```", "/status", "```\nsecond result\n```", "later in the same millisecond"]);
}
{
  const f = fixture();
  const task = f.execute("/compress");
  f.environment.activeKeyRef.current = "other";
  f.messages = [user("other conversation", 2_000)];
  f.requests[0].resolve({ kind: "output", text: "done in original conversation" }); await task;
  assert.deepEqual(f.messages.map(text), ["other conversation"], "late output cannot affect the selected conversation");
  const restored = f.history.merge(key, []);
  assert.match(text(restored[1]), /done in original/);
  assert.equal(f.drafts.size, 0, "executed commands are not restored as drafts for accidental replay");
}
for (const kind of ["output", "send", "prefill"]) {
  const f = fixture();
  const task = f.execute("/command");
  f.history.forget(key);
  f.messages = [];
  f.requests[0].resolve({ kind, text: "stale result" }); await task;
  assert.equal(f.messages.length, 0, "clear/reset fences late completions");
  assert.equal(f.forwarded.length, 0);
  assert.equal(f.input, "");
}
for (const kind of ["send", "prefill"]) {
  const f = fixture();
  const task = f.execute("/command");
  f.requests[0].resolve({ kind, text: "expanded command" }); await task;
  assert.equal(f.messages.length, 0, "typed dispatch hands its provisional echo over to the owning send/composer path");
  if (kind === "send") assert.deepEqual(plain(f.forwarded[0]), ["expanded command", [], true, "/command"]);
  else assert.equal(f.input, "expanded command");
}
{
  const f = fixture();
  const task = f.execute("/command");
  f.environment.activeKeyRef.current = "other";
  f.requests[0].resolve({ kind: "send", text: "expanded command" }); await task;
  assert.equal(f.forwarded.length, 0);
  assert.equal(f.drafts.get(key), "/command");
}
{
  const f = fixture();
  const older = user("already present", 1_000), later = user("later", 1_000);
  f.messages = [older];
  const task = f.execute("/compress");
  f.messages = f.history.merge(key, [older, later]);
  f.requests[0].resolve({ kind: "output", text: "done" }); await task;
  assert.deepEqual(plain(f.messages.filter(m => m.role === "user").map(text)), ["already present", "/compress", "later"],
    "the prior-message anchor breaks ties without reordering canonical messages");
  f.history.forget(key);
  assert.deepEqual(plain(f.history.merge(key, f.messages)), [older, later], "cached local projections cannot resurrect a cleared command");
}
for (const kind of ["send", "prefill"]) {
  const f = fixture();
  const task = f.execute("/command");
  f.input = "newer draft";
  f.requests[0].resolve({ kind, text: "expanded content" }); await task;
  assert.equal(f.input, "newer draft", "a late typed result cannot replace newly entered text");
  assert.equal(f.forwarded.length, 0);
  assert.match(text(f.messages[1]), /slashUnsent.*expanded content/);
}
{
  const f = fixture();
  const task = f.execute("/command");
  f.environment.inFlightRef.current.add(key);
  f.requests[0].resolve({ kind: "send", text: "expanded content" }); await task;
  assert.equal(f.forwarded.length, 0, "a late send cannot overtake the active model turn");
  assert.match(text(f.messages[1]), /slashUnsent/);
}
{
  const f = fixture();
  const task = f.execute("/compress");
  const queued = [];
  f.environment.setMessages = update => queued.push(update);
  f.requests[0].resolve({ kind: "output", text: "done" }); await task;
  f.environment.activeKeyRef.current = "other";
  f.messages = [user("other", 2_000)];
  for (const update of queued) f.messages = update(f.messages);
  assert.deepEqual(plain(f.messages.map(text)), ["other"], "a queued React update rechecks session ownership");
}
console.log("PASS server slash ordering: immediate echo, success/error/uncertain, history refresh, concurrent completion, same-time send, navigation, reset, typed dispatch");
