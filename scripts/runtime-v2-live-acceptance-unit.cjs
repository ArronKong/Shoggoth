#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { parseOptions, readCodexAuth, isolatedEnv, execute, descendantIdentities, killOwnedProcesses } = require("./runtime-v2-live-acceptance.cjs");
const { configureService } = require("./runtime-v2-live-worker.cjs");
const { runWorkflow } = require("./runtime-v2-live-workflow.cjs");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");

test("plan does not inspect auth paths or call a Provider; live inputs are explicit and bounded", async () => {
  const plan = await execute(parseOptions(["--codex-auth", "/missing/auth.json", "--pi-auth", "/missing/pi.json"]));
  assert.equal(plan.credentialFilesRead, false);
  assert.equal(plan.providerCalls, 0);
  assert.equal(plan.plannedPromptCalls, 23);
  assert.equal((await execute(parseOptions(["--phase", "handoff"]))).plannedPromptCalls, 3);
  assert.equal((await execute(parseOptions(["--phase", "mixed"]))).plannedPromptCalls, 20);
  for (const input of [["--mode", "live"], ["--phase", "21"], ["--shell", "bad"], ["--model", "$(invalid)"],
    ["--proxy", "http://outside.invalid:7897"]]) assert.throws(() => parseOptions(input));
});

test("forced cleanup waits for the exact isolated process identity to exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: {}, stdio: "ignore" });
  const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    const record = descendantIdentities(child.pid).find(record => record.pid === child.pid);
    assert.ok(record);
    assert.equal(await killOwnedProcesses([{ ...record, born: "wrong-identity" }]), 0);
    assert.equal(process.kill(child.pid, 0), true, "PID reuse cannot target a different process");
    assert.equal(await killOwnedProcesses([record]), 0);
    assert.deepEqual(await exit, { code: null, signal: "SIGKILL" });
  } finally { try { child.kill("SIGKILL"); } catch {} await exit; }
});

test("S6 MCP transport fixture exposes no tools and refuses every tool call", async () => {
  const root = fs.mkdtempSync("/tmp/sglive-mcp-unit-");
  const child = spawn(process.execPath, [path.join(__dirname, "fixtures/runtime-v2-empty-mcp.cjs"),
    "--shoggoth-internal-role=mcp"], { env: { HOME: root }, stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
  const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    child.stdin.end(["initialize", "tools/list", "tools/call"].map((method, index) =>
      JSON.stringify({ jsonrpc: "2.0", id: index + 1, method, params: { name: "profile.get" } })).join("\n") + "\n");
    assert.deepEqual(await exit, { code: 0, signal: null });
    const rows = output.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows[0].result.capabilities, { tools: {} });
    assert.deepEqual(rows[1].result.tools, []);
    assert.equal(rows[2].error.code, -32601);
  } finally { try { child.kill("SIGKILL"); } catch {} await exit; fs.rmSync(root, { recursive: true, force: true }); }
});

test("isolated environment drops inherited accounts/options and Codex auth copy is minimal", async () => {
  const root = fs.mkdtempSync("/tmp/s6auth-unit-");
  try {
    const target = path.join(root, "auth.json");
    const input = { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "fixture-id",
      access_token: "fixture-access", refresh_token: "fixture-refresh", account_id: "fixture-account",
      extra: "must-not-copy" }, last_refresh: "2026-09-23T00:00:00Z", extra: "must-not-copy" };
    const serialized = JSON.stringify(input);
    fs.writeFileSync(target, serialized, { mode: 0o600 });
    const copied = readCodexAuth(target);
    assert.equal(JSON.stringify(copied).includes("must-not-copy"), false);
    assert.equal(fs.readFileSync(target, "utf8"), serialized);
    const env = isolatedEnv(root, "http://127.0.0.1:7897");
    assert.equal(env.HOME, root);
    assert.equal(env.CODEX_HOME, path.join(root, ".codex"));
    assert.equal(env.PI_CODING_AGENT_DIR, path.join(root, ".pi", "agent"));
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7897");
    assert.equal(env.NODE_USE_ENV_PROXY, "1");
    fs.chmodSync(target, 0o644);
    assert.throws(() => readCodexAuth(target), { code: "S6_PRIVATE_CODEX_AUTH_REQUIRED" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("live workflow runs real Service socket handoff and 10+10 fixture turns with measured overlap", async () => {
  const f = await openHandoffFixture();
  const completing = new Set(), tasks = [];
  let timer;
  try {
    const profile = configureService(f.service, { model: "unused", workspaceRoot: path.join(f.root, "live-workspaces") });
    assert.equal(profile.defaultModel, null, "both CLIs use explicit native defaults; no incompatible Agent model constraint");
    const observe = async () => {
      const runs = f.service.workRunCoordinator.listRuns({ profileId: profile.id });
      for (const run of runs) {
        if (run.status !== "running" || !run.runtimeTurnRef || completing.has(run.id)) continue;
        completing.add(run.id);
        const events = f.service.transcriptStore.listEvents(profile.id,
          f.service.chatSessionStore.getSession(run.sourceId).id);
        const prompt = events.filter(event => event.kind === "user").at(-1).content.text;
        const handoff = events.find(event => event.kind === "user" && event.content.text.includes("S6_HANDOFF_"));
        const marker = prompt.match(/MIXED_OK_\d+/u)?.[0] || handoff?.content.text.match(/S6_HANDOFF_[a-f0-9]+/u)?.[0];
        assert.ok(marker);
        const task = new Promise(resolve => setTimeout(resolve, run.idempotencyKey.includes("mixed") ? 400 : 10))
          .then(() => f.complete(run, marker));
        task.catch(() => {}); tasks.push(task);
      }
    };
    timer = setInterval(() => { const task = observe(); task.catch(() => {}); tasks.push(task); }, 10);
    const result = await runWorkflow({ service: f.service, paths: f.paths, profileId: profile.id,
      workspaceRoot: path.join(f.root, "live-workspaces"), timeoutMs: 10000 });
    assert.deepEqual(result.handoff.runtimes, ["codex", "pi", "codex"]);
    assert.equal(result.handoff.freshCodexSessionOnReturn, true);
    assert.equal(result.mixed.submitted, 20);
    assert.equal(result.mixed.completed, 20);
    assert.deepEqual(result.mixed.perRuntime, { codex: 10, pi: 10 });
    assert.ok(result.mixed.peakRunning > 1 && result.mixed.peakRunning <= 20);
    assert.equal(result.mixed.simultaneous20RunningObserved, result.mixed.peakRunning === 20);
    assert.equal(f.service.workRunCoordinator.getMemoryStats().runHostAssignments, 0);
  } finally {
    clearInterval(timer); await Promise.allSettled(tasks); await f.close();
  }
});
