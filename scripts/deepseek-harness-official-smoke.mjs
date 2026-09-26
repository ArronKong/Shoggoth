#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const require = createRequire(import.meta.url);
const {
  DEFAULT_DEEPSEEK_HARNESS_PERMISSION_POLICY,
  prepareDeepSeekHarnessHome,
  resolveDeepSeekHarnessBinary,
  resolveDeepSeekHarnessLaunch,
} = require(path.join(ROOT, "app", "agent-service", "deepseek-harness-runtime-paths.js"));

function runFakeMcp() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "shoggoth-official-dsh-smoke", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = { tools: [] };
    } else if (message.method === "ping") {
      result = {};
    } else {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        error: { code: -32601, message: "Method not found" },
      })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  });
}

if (process.argv[2] === "--fake-mcp") {
  runFakeMcp();
} else if (process.argv[2] === "--fail-mcp") {
  fs.writeFileSync(process.argv[3], "started\n", { mode: 0o600 });
  process.stderr.write("fixture MCP credentials unavailable\n");
  process.exitCode = 1;
} else {
  if (process.argv[2] !== "--control-only") await runSmoke();
  await runSmoke({ controlOnly: true });
  await runSmoke({ executionMcpUnavailable: true });
}

async function runSmoke({ controlOnly = false, executionMcpUnavailable = false } = {}) {
  let binaryPath;
  try {
    binaryPath = resolveDeepSeekHarnessBinary({ parentEnv: process.env });
  } catch (error) {
    if (process.env.REQUIRE_DSH === "1") throw error;
    console.log("SKIP DeepSeek official smoke: official dsh is not installed");
    return;
  }
  const launch = resolveDeepSeekHarnessLaunch(binaryPath, { parentEnv: process.env });
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-dsh-official-"));
  fs.chmodSync(trustedRoot, 0o700);
  const stateDir = path.join(trustedRoot, "state");
  const workspace = path.join(trustedRoot, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const home = prepareDeepSeekHarnessHome({ trustedRoot, stateDir }, "official-smoke", {
    bridgePath: path.join(ROOT, "resources", "deepseek-harness", "shoggoth-dsh-bridge.mjs"),
  });
  fs.writeFileSync(path.join(home, ".credentials.yaml"),
    "version: 1\nrefs:\n  DEEPSEEK_API_KEY: smoke-only\n", { mode: 0o600 });
  const mcpStartedPath = path.join(trustedRoot, "failed-mcp-started");
  const mcpConfig = {
    transport: "stdio",
    serverName: "shoggoth",
    command: process.execPath,
    args: controlOnly || executionMcpUnavailable
      ? [SCRIPT_PATH, "--fail-mcp", mcpStartedPath]
      : [SCRIPT_PATH, "--fake-mcp"],
    env: {},
    cwd: workspace,
    toolCallTimeoutMs: 5_000,
    failOnStartupError: true,
  };
  const child = spawn(launch.command, [
    ...launch.argsPrefix, "--profile", "shoggoth",
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: DEFAULT_DEEPSEEK_HARNESS_PERMISSION_POLICY.sandbox,
      SHOGGOTH_DSH_APPROVAL_POLICY:
        DEFAULT_DEEPSEEK_HARNESS_PERMISSION_POLICY.approvalPolicy === "never" ? "never" : "ask",
      SHOGGOTH_DSH_CONTROL_INSTANCE: controlOnly ? "1" : "0",
      SHOGGOTH_DSH_ENTRYPOINT: launch.argsPrefix[0] || "",
      SHOGGOTH_DSH_MCP_CONFIG: JSON.stringify(mcpConfig),
      DSH_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let sequence = 0;
  const events = [];
  const pending = new Map();
  let readyResolve;
  let readyReject;
  let readySettled = false;
  let closeFailure = null;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const failPending = (error) => {
    closeFailure ||= error;
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch {
      failPending(new Error("official dsh emitted malformed Bridge output"));
      child.kill("SIGKILL");
      return;
    }
    if (message.type === "ready") {
      readySettled = true;
      readyResolve();
      return;
    }
    if (message.type === "event") { events.push(message.event); return; }
    if (message.type !== "response") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.success) request.resolve(message.data);
    else request.reject(new Error(`${message.error?.code || "DSH_ERROR"}: ${message.error?.message || "request failed"}`));
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => {
    failPending(new Error(`official dsh closed early (${code ?? signal ?? "unknown"})`));
    resolve({ code, signal });
  }));
  const request = (command, params = {}) => new Promise((resolve, reject) => {
    if (closeFailure) {
      reject(closeFailure);
      return;
    }
    const id = `smoke-${++sequence}`;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ type: "request", id, command, params })}\n`);
  });
  const timeout = setTimeout(() => {
    failPending(new Error("official dsh smoke timed out"));
    child.kill("SIGKILL");
  }, 30_000);
  try {
    if (executionMcpUnavailable) {
      await ready.catch(() => {});
      const result = await closed;
      assert.equal(fs.existsSync(mcpStartedPath), true, "execution must start its MCP helper");
      assert.equal(result.signal, null, "execution must fail naturally without timeout or a kill signal");
      assert.equal(Number.isInteger(result.code) && result.code > 0, true,
        "execution must fail when its required MCP helper exits");
      assert.match(stderr, /fixture MCP credentials unavailable/u);
      console.log("PASS official dsh execution: unavailable required MCP still fails startup");
      return;
    }
    await ready;
    const catalog = await request("models/list");
    assert.equal(catalog.models.some((model) => (
      model.model === "deepseek-official/deepseek-v4-flash"
    )), true);
    const auth = await request("auth/read");
    assert.deepEqual(auth, { authenticated: true, credentialPresent: true });
    const commands = await request("commands/list");
    assert.equal(commands.scoped, false);
    assert.equal(commands.commands.some((command) => command.name === "goal"), true);
    assert.equal(commands.commands.some((command) => command.name === "compact"), true);
    assert.equal(events.length, 0, "draft command discovery cannot start a turn");
    if (controlOnly) {
      await request("shutdown");
      child.stdin.end();
      const result = await closed;
      assert.equal(result.code, 0, stderr);
      assert.equal(fs.existsSync(mcpStartedPath), false, "control must not start its MCP helper");
      console.log("PASS official dsh control discovery: models/auth/commands survive unavailable MCP without starting a session");
      return;
    }
    const remoteSessionId = crypto.randomUUID();
    await request("session/start", {
      remoteSessionId,
      cwd: workspace,
      developerInstructions: "Official DSH smoke session.",
      model: catalog.models.find((model) => model.isDefault)?.model || catalog.models[0].model,
    });
    const inspection = await request("session/read", { remoteSessionId });
    assert.equal(inspection.remoteSessionId, remoteSessionId);
    assert.equal((await request("commands/list", { remoteSessionId })).scoped, true);
    for (const [index, prompt] of ["/goal", "/goal pause"].entries()) {
      const turnId = `smoke-command-${index}`;
      await request("turn/start", {
        remoteSessionId, sessionId: "smoke-session", turnId,
        operationId: crypto.randomUUID(), prompt, context: "",
      });
      const deadline = Date.now() + 5_000;
      while (!events.some((event) => event.type === "complete" && event.turnId === turnId) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(events.find((event) => event.type === "complete" && event.turnId === turnId)?.status,
        index === 0 ? "completed" : "failed", JSON.stringify(events));
      assert.match(events.find((event) => event.type === "text" && event.turnId === turnId)?.text || "", /No goal is currently set/u);
    }
    await assert.rejects(request("turn/start", {
      remoteSessionId, sessionId: "smoke-session", turnId: "smoke-unknown",
      operationId: crypto.randomUUID(), prompt: "/not-a-command", context: "",
    }), /RUNTIME_COMMAND_NOT_FOUND/);
    await request("session/delete", { remoteSessionId });
    await request("shutdown");
    child.stdin.end();
    const result = await closed;
    assert.equal(result.code, 0, stderr);
    console.log(`PASS official dsh ${await versionOf(launch)}: external profile/Bridge/models/session/MCP/native commands`);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    fs.rmSync(trustedRoot, { recursive: true, force: true });
  }
}

function versionOf(launch) {
  return new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.argsPrefix, "--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("close", () => resolve(output.trim() || "unknown"));
  });
}
