#!/usr/bin/env node
// Repeatable entry point for the development plan's real Service, renderer and
// unmodified Runtime gates. Each existing fixture owns and removes its state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
const repo = path.resolve(import.meta.dirname, ".."), options = new Set(process.argv.slice(2));
assert([...options].every(value => ["--node-only", "--read-flow"].includes(value)), "unknown native UI regression option");
assert(!(options.has("--node-only") && options.has("--read-flow")), "select one regression scope");
async function run(name, command, args, env = process.env) {
  console.log("Native UI gate: " + name);
  const child = spawn(command, args, { cwd: repo, env, stdio: "inherit" });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.code, 0, name + " failed " + JSON.stringify(result));
}
const units = ["contract", "store", "service", "action", "long-text", "legacy", "projection", "desktop-ipc", "eligibility", "provenance", "qualification", "recovery", "diagnostics", "cancel-gateway", "sdk-state"];
await run("durable Service/source/action contracts", process.execPath,
  ["--test", "--test-concurrency=3", ...units.map(name => "scripts/native-chat-ui-" + name + "-unit.cjs")]);
await run("client crash identities", process.execPath, ["scripts/native-chat-ui-client-unit.mjs"]);
await run("default current-card loading", process.execPath, ["--test", "scripts/native-chat-ui-autoload-ui-unit.mjs"]);
if (!options.has("--node-only")) {
  await run("production React build", "npm", ["run", "build:manage"]);
  await run("native and external HTML source policy", process.execPath, ["scripts/native-chat-ui-source-policy.cjs"]);
  await run("actual Electron owner document lifecycle", process.execPath, ["scripts/native-chat-ui-host-navigation-electron.cjs"]);
  if (!options.has("--read-flow")) await run("actual Electron isolation, layout and input", process.execPath, ["scripts/native-chat-ui-electron-smoke.cjs"]);
  await run(options.has("--read-flow") ? "actual React/Service read flow" : "actual trusted UI action flow", process.execPath,
    ["scripts/native-chat-ui-live-react-electron.cjs"], options.has("--read-flow") ? { ...process.env, NATIVE_CHAT_UI_READ_FLOW: "1" } : { ...process.env, NATIVE_CHAT_UI_NATIVE_INPUT: "1" });
  await run("unmodified Codex Runtime UI discovery and calls", process.execPath, ["scripts/native-chat-ui-runtime-acceptance.cjs", "--native-api"]);
}
console.log("PASS native UI selected regression scope: " + (options.has("--node-only") ? "Node Service and client identities" : options.has("--read-flow") ? "Node and Electron read flow; trusted UI action/device gate remains separate" : "Node, Electron input/action and native Runtime API"));
