#!/usr/bin/env node
"use strict";
// Real local Grok ACP, isolated Home and fake key. No session/prompt or model call.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-grok-rules-"));
const home = path.join(scratch, "home"), workspace = path.join(scratch, "workspace");
fs.mkdirSync(home); fs.mkdirSync(workspace);
const rules = "SHOGGOTH_RULES_FIXTURE_V1: retain every native tool and skill.";
let child, serial = 0, version, passed = false;
async function start() {
  const pending = new Map();
  child = spawn(process.env.SHOGGOTH_GROK_FIXTURE_BINARY || "grok", ["agent", "--no-leader",
    "--xai-api-base-url", "http://127.0.0.1:9/v1", "--cli-chat-proxy-base-url", "http://127.0.0.1:9", "stdio"], {
    cwd: workspace, env: { HOME: home, GROK_HOME: path.join(home, ".grok"), PATH: process.env.PATH,
      TMPDIR: scratch, XAI_API_KEY: "local-fixture-no-provider-key", NO_PROXY: "127.0.0.1,localhost" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "", diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let response; try { response = JSON.parse(line); } catch { continue; }
      const call = pending.get(response.id); if (!call) continue;
      pending.delete(response.id); clearTimeout(call.timer);
      response.error ? call.reject(new Error(JSON.stringify(response.error))) : call.resolve(response.result);
    }
  });
  const failed = error => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); };
  child.once("error", failed);
  child.once("exit", code => failed(new Error(`Grok exited ${code}: ${diagnostics}`)));
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${diagnostics}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const initialized = await request("initialize", { protocolVersion: 1, clientInfo: { name: "shoggoth-isolated-rules-fixture", version: "1" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  version = initialized._meta?.agentVersion;
  return request;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}
function systemPrompt(sessionId) {
  const files = fs.readdirSync(path.join(home, ".grok"), { recursive: true });
  const file = files.find(item => item.includes(sessionId) && item.endsWith("system_prompt.txt"));
  assert.ok(file, "native system prompt must be persisted in the isolated Home");
  return fs.readFileSync(path.join(home, ".grok", file), "utf8");
}
(async () => {
  let request = await start();
  const baseline = await request("session/new", { cwd: workspace, mcpServers: [] });
  const original = systemPrompt(baseline.sessionId);
  const created = await request("session/new", { cwd: workspace, mcpServers: [], _meta: { rules } });
  const first = systemPrompt(created.sessionId);
  assert.equal(first.split(rules).length - 1, 1);
  assert.ok(first.includes(original.slice(0, 400)), "native system instructions are retained");
  await request("session/load", { sessionId: created.sessionId, cwd: workspace, mcpServers: [], _meta: { rules: "SHOGGOTH_RULES_FIXTURE_V2" } });
  assert.equal(systemPrompt(created.sessionId), first, "load must not be mistaken for a system-rule update");
  await stop();
  request = await start();
  await request("session/load", { sessionId: created.sessionId, cwd: workspace, mcpServers: [] });
  assert.equal(systemPrompt(created.sessionId), first, "system rules survive a native process restart");
  console.log(JSON.stringify({ result: "pass", nativeVersion: version, appendedRulesCopies: 1,
    defaultSystemPreserved: true, loadDoesNotUpdateRules: true, coldResumePreserved: true, modelCalls: 0 }));
  passed = true;
})().catch(error => { console.error(error); console.error(`Isolated evidence: ${scratch}`); process.exitCode = 1; })
  .finally(async () => { await stop(); if (passed) fs.rmSync(scratch, { recursive: true, force: true }); });
