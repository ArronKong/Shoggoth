#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "../app/manage-ui/node_modules/typescript/lib/typescript.js";

const require = createRequire(import.meta.url);
const { cliReferenceCommands, mergeNativeCommands, requireRuntimeCommand } = require("../app/agent-service/native-cli-commands.js");
const { normalizeRuntimeCommands } = require("../app/agent-service/runtime-commands.js");
const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const compile = (text) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function load(file) {
  const module = { exports: {} };
  vm.runInNewContext(compile(source(file)), { module, exports: module.exports, AbortSignal, Error });
  return module.exports;
}
const { SlashCatalogStore, mapServerSlashCommand } = load("../app/manage-ui/src/lib/slashCatalog.ts");
const policy = load("../app/manage-ui/src/lib/slashCommands.ts");
const memoryCommand = mapServerSlashCommand({ name: "active-memory", description: "Memory", execution: "runtime", allowWhileRunning: true });
assert.equal(policy.canRunServerSlashDuringTurn(memoryCommand), true);
assert.equal(policy.canRunServerSlashDuringTurn({ ...memoryCommand, allowWhileRunning: undefined }), false);
assert.equal(policy.canRunServerSlashDuringTurn({ ...memoryCommand, execution: "cli" }), false);
assert.equal(policy.canRunServerSlashDuringTurn({ ...memoryCommand, execution: "client" }), false);
assert.equal(policy.canRunServerSlashDuringTurn(mapServerSlashCommand({ ...memoryCommand, allowWhileRunning: "true" })), false);
const chatRuntime = load("../app/manage-ui/src/lib/chatRuntime.ts");
for (const input of ["/Users/example/Downloads/微信图片.png", "/Users/example/My Files/report.pdf", "/report.pdf", '"/Users/example/picture.png"', "~/Downloads/image.png"]) {
  assert.equal(policy.isSlashCommandInput(input), false, input);
  assert.equal(policy.parseSlashInput(input), null, input);
}
assert.equal(policy.parseSlashInput("/new /Users/example/My Files").command.name, "new");
assert.equal(policy.parseSlashInput("/review.code src", [{ name: "review.code" }]).command.name, "review.code");
assert.equal(policy.slashQuery("/review.co"), "review.co");
assert.equal(policy.slashQuery("/Users/example/image.png"), null);
const mediaRefs = [
  { id: "11111111-1111-4111-8111-111111111111", name: "图片.png", mimeType: "image/png", size: 1024 },
  { id: "22222222-2222-4222-8222-222222222222", name: "报告.pdf", mimeType: "application/pdf", size: 2048 },
];
const nativeMedia = chatRuntime.nativeChatMedia(mediaRefs);
assert.equal(nativeMedia.images.length, 1);
assert.equal(nativeMedia.files[0].name, "报告.pdf");
assert.deepEqual(JSON.parse(JSON.stringify(nativeMedia.attachments.map(chatRuntime.buildOpenClawAttachment))), mediaRefs.map(nativeRef => ({ nativeRef })));
assert.equal(chatRuntime.nativeChatMedia([{ ...mediaRefs[0], id: "../../private" }]).attachments.length, 0);
const plain = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const command = (name, patch = {}) => ({ name, description: name, aliases: [], ...patch });

// Regression: a session event used to clean up the render effect while the
// loading Set suppressed its replacement. The eventual response was discarded.
const pending = [];
let now = 10_000;
const store = new SlashCatalogStore((...scope) => {
  const task = deferred();
  pending.push({ scope, ...task });
  return task.promise;
}, () => now);
let notifications = 0;
let unsubscribe = store.subscribe(() => { notifications += 1; });
const first = store.load("agent-a", "codex", "session-a");
unsubscribe(); // effect cleanup / StrictMode / navigation
unsubscribe = store.subscribe(() => { notifications += 1; });
assert.equal(store.load("agent-a", "codex", "session-a"), first, "refresh must share the active request");
const other = store.load("agent-b", "pi", "session-b");
await Promise.resolve();
assert.equal(pending.length, 2);
assert.ok(pending.every((entry) => entry.scope[3] instanceof AbortSignal));
pending[1].resolve({ supported: true, commands: [command("thinking", { source: "Pi RPC", execution: "runtime" })] });
await other;
pending[0].resolve({ supported: true, commands: [command("goal", { source: "Codex runtime", execution: "runtime" })] });
await first;
const keyA = SlashCatalogStore.key("agent-a", "codex", "session-a");
const keyB = SlashCatalogStore.key("agent-b", "pi", "session-b");
assert.equal(store.getSnapshot()[keyA].commands[0].name, "goal");
assert.equal(store.getSnapshot()[keyB].commands[0].name, "thinking");
assert.equal(store.getSnapshot()[keyA].status, "ready");
assert.ok(notifications >= 4, "subscribers must see completions after cleanup");
await store.load("agent-a", "codex", "session-a");
assert.equal(pending.length, 2, "fresh cache should avoid redundant CLI discovery");
now += 6_000;
const failure = store.load("agent-a", "codex", "session-a");
await Promise.resolve();
pending[2].reject(new Error("offline"));
await failure;
assert.equal(store.getSnapshot()[keyA].status, "error");
assert.equal(store.getSnapshot()[keyA].message, "offline");
assert.equal(store.getSnapshot()[keyA].commands[0].name, "goal", "refresh errors retain the last scoped catalog");
const retry = store.load("agent-a", "codex", "session-a", true);
await Promise.resolve();
pending[3].resolve({ supported: false, reason: "runtime unavailable", commands: [] });
await retry;
assert.equal(store.getSnapshot()[keyA].status, "unsupported");
assert.equal(store.getSnapshot()[keyA].commands.length, 0);
assert.equal(store.getSnapshot()[keyB].status, "ready");
unsubscribe();

const runtimes = ["codex", "claude-code", "grok-build", "pi", "antigravity", "deepseek-harness"];
const nativePools = runtimes.map((runtime) => cliReferenceCommands(runtime));
assert.equal(new Set(nativePools.map((pool) => pool.map((entry) => entry.name).join(","))).size, runtimes.length,
  "native agents must not share a fallback CLI catalog");
for (const [index, catalog] of nativePools.entries()) {
  assert.ok(catalog.length > 0, runtimes[index]);
  for (const entry of catalog) {
    assert.ok(entry.source);
    assert.ok(["client", "cli"].includes(entry.execution), "reference rows cannot invent runtime execution");
    assert.throws(() => requireRuntimeCommand(`/${entry.name}`, catalog, runtimes[index]),
      { code: entry.execution === "cli" ? "RUNTIME_COMMAND_CLI_ONLY" : "RUNTIME_COMMAND_CLIENT_REQUIRED" });
  }
}
const merged = mergeNativeCommands("codex", [command("live", { aliases: ["model"], argumentHint: "<target>" })]);
assert.equal(merged.some((entry) => entry.name === "model"), false, "live aliases outrank reference names");
assert.equal(merged[0].args, "<target>");
const uiPool = policy.mergeNativeSlashCommands(merged);
assert.equal(policy.parseSlashInput("/model item", uiPool).command.name, "live");
assert.equal(policy.parseSlashInput("/shoggoth:model item", uiPool).command.source, "Shoggoth");
assert.throws(() => normalizeRuntimeCommands([command("bad", { execution: "shell" })]));
assert.throws(() => normalizeRuntimeCommands([command("bad", { source: "x".repeat(257) })]));
assert.equal(normalizeRuntimeCommands([command("__remote-workflow")])[0].name, "__remote-workflow",
  "a valid underscore-prefixed SDK command cannot poison the entire Claude catalog");

// Execute the actual ChatPage closures with controlled dependencies; this catches
// wrong dispatch semantics, unlike matching a route name in the source text.
const page = source("../app/manage-ui/src/pages/ChatPage.tsx");
const ast = ts.createSourceFile("ChatPage.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function closure(name, environment) {
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) expression = node.initializer?.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(expression, name);
  return vm.runInNewContext(compile(`const result = ${expression}; result;`), environment);
}
const calls = [];
const state = { key: "session-a", messages: [] };
const environment = {
  crypto: globalThis.crypto,
  localSlashHistoryRef: { current: load("../app/manage-ui/src/lib/chatSlashHistory.ts").createChatSlashHistory() },
  messagesRef: { get current() { return state.messages; }, set current(value) { state.messages = value; } },
  activeKeyRef: { get current() { return state.key; } },
  agentOf: () => "agent-a", backendOfSession: () => "codex",
  chatBackendDescriptors: new Map([["codex", { surfaces: { agentHarness: true } }]]),
  shouldHandleSlashLocally: policy.shouldHandleSlashLocally,
  pushLocal: (text) => calls.push(["local", text]), t: (key) => key,
  send: async (method, params) => { calls.push([method, plain(params)]); return { payload: { key: "new-session" } }; },
  setMessages: (value) => { state.messages = typeof value === "function" ? value(state.messages) : value; },
  markInFlight() {}, setSending() {}, setToast() {}, setTimeout() {},
  optimisticHistoryRef: { current: { forget: key => calls.push(["forget-optimistic", key]) } },
  active: { model: "gpt-5.6", modelProvider: "codex" }, models: [], modelsBackendRef: { current: "codex" },
  inheritedModelChoice: () => undefined, ensureSessionRow() {}, openSession: (key) => calls.push(["open", key]),
};
const dispatch = closure("dispatchSlash", environment);
assert.equal(await dispatch(command("stop", { execution: "cli", source: "Codex CLI" }), "", "/stop"), true);
assert.equal(calls.some(([method]) => method === "chat.abort"), false, "Codex /stop means background terminals, not chat.abort");
assert.equal(await dispatch(command("compact", { execution: "runtime" }), "", "/compact"), false);
assert.equal(await dispatch(command("shoggoth:stop", { execution: "client", source: "Shoggoth" }), "", "/shoggoth:stop"), true);
assert.equal(calls.some(([method]) => method === "chat.abort"), true);
await dispatch(command("clear", { execution: "client", source: "Codex CLI" }), "", "/clear");
assert.equal(calls.find(([method]) => method === "sessions.create")[1].parentSessionKey, "session-a");
const created = calls.filter(([method]) => method === "sessions.create").length;
await dispatch(command("shoggoth:clear", { execution: "client", source: "Shoggoth" }), "", "/shoggoth:clear");
assert.equal(calls.filter(([method]) => method === "sessions.create").length, created);
assert.equal(state.messages[0].parts[0].text, "chat.localCleared");
assert.deepEqual(calls.filter(([method]) => method === "forget-optimistic"), [["forget-optimistic", "session-a"]]);

const result = deferred();
const drafts = new Map();
const outputs = [];
const execute = closure("execServerSlash", {
  ...environment, execSlashCommand: () => result.promise, draftsRef: { current: drafts },
  sendChatMessage: (...args) => outputs.push(args), setInput: (text) => outputs.push(text),
  inputRef: { current: "" }, focusComposer() {},
});
const execution = execute("session-a", "/compact");
state.key = "session-b";
result.resolve({ kind: "send", text: "/compact" });
await execution;
assert.equal(outputs.length, 0, "a late command result cannot run inside the newly selected agent");
assert.equal(drafts.get("session-a"), "/compact", "unsubmitted commands remain recoverable in their original session");

// Exercise the actual composer closure while a turn is still running. The
// capability must get through both admission checks and the later slash branch.
state.key = "session-a";
const submissions = [], cleared = [];
let ready = true;
const submit = closure("submit", {
  ...environment, attachments: [], input: "", slashPool: () => [memoryCommand, { ...memoryCommand, name: "compact", allowWhileRunning: false }],
  sendController: { composerButton: (_key, action) => ready ? action() : undefined, slash: (_key, action) => ready ? action() : undefined },
  supportsBackendSlash: () => true, capabilitiesForSession: () => ({ slash: true }),
  recoverySlashCommandsForBackend: policy.recoverySlashCommandsForBackend, SLASH_COMMANDS: [],
  parseSlashInput: policy.parseSlashInput, isSlashCommandInput: policy.isSlashCommandInput,
  canRunSlashDuringTurn: policy.canRunSlashDuringTurn, canRunServerSlashDuringTurn: policy.canRunServerSlashDuringTurn,
  inFlightRef: { current: new Set(["session-a"]) }, histRef: { current: new Map() }, histPosRef: { current: -1 },
  setInput: value => cleared.push(value), setSlashOpen() {}, setQuote() {}, dispatchSlash: dispatch,
  execServerSlash: async (key, text) => submissions.push([key, text]),
  sendChatMessage: async () => assert.fail("a memory command must not become model input"),
});
await submit("/compact"); assert.deepEqual(submissions, []); assert.deepEqual(cleared, []);
await submit("/active-memory off"); assert.deepEqual(submissions, [["session-a", "/active-memory off"]]); assert.deepEqual(cleared, [""]);
ready = false;
await submit("/active-memory on"); assert.equal(submissions.length, 1); assert.equal(cleared.length, 1, "unready transport must preserve the draft");
console.log("PASS native slash catalogs: six runtimes, race/retry/isolation, alias ownership and actual UI dispatch");
