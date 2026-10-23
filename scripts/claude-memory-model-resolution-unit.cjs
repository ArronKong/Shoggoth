"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");

const request = { operationId: "claude-memory-model" };
const selected = { model: "claude-fixture-actual", provider: "claude-code" };

class ControlChild extends EventEmitter {
  constructor(pid, mode = "exit") {
    super();
    Object.assign(this, { pid, mode, signals: [], exited: false, scheduled: false });
    this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough();
  }
  kill(signal) {
    this.signals.push(signal);
    if (this.mode === "stuck" || this.exited || this.scheduled) return true;
    if (this.mode === "error-until-kill" && signal !== "SIGKILL") {
      this.emit("error", new Error("fixture kill failed")); return false;
    }
    this.scheduled = true;
    setTimeout(() => {
      this.exited = true;
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    }, 10);
    return true;
  }
}

function fixture({ settings = { model: "raw-alias", applied: { model: selected.model },
  env: { PRIVATE_KEY: "never expose raw settings" } }, getSettings, mode, sdkThrows, missingMethod } = {}) {
  const host = Object.create(ClaudeCodeRuntimeHost.prototype), calls = [], children = [];
  let didStart;
  const started = new Promise(resolve => { didStart = resolve; });
  Object.assign(host, {
    state: "ready", binaryPath: fs.realpathSync(process.execPath), userHome: "/private/fixture-home",
    fs, controlProcesses: new Map(), controlProcessGroups: new WeakSet(), controlQueries: new Set(),
    cleanupIncomplete: false, killGraceMs: 25, shutdownGraceMs: 25,
    activeTurns: new Map(), resolveTerminated() {},
    _spawnEnvironment: () => ({ HOME: "/private/fixture-home", CLAUDE_CONFIG_DIR: "/private/fixture-config" }),
    spawnProcess() { const child = new ControlChild(10_000 + children.length, mode); children.push(child); return child; },
    killProcessGroup(pid, signal) { children.find(child => child.pid === pid).kill(signal); },
    sdk: { query(params) {
      calls.push(params);
      const child = params.options.spawnClaudeCodeProcess({
        command: host.binaryPath, args: ["--fixture-control"], cwd: params.options.cwd, env: params.options.env,
      });
      if (sdkThrows) throw new Error("secret in SDK startup error");
      return {
        ...(!missingMethod && { async getSettings() { didStart(); return getSettings ? getSettings() : settings; } }),
        supportedModels() { assert.fail("catalog must not determine the applied default"); },
        close() { child.kill("SIGTERM"); },
      };
    } },
  });
  return { host, calls, children, started };
}

test("Claude discovers only applied model without any prompt, tools or persisted session", async () => {
  const ctx = fixture();
  assert.deepEqual(await ctx.host.resolveModelOnly(request), selected);
  assert.equal(ctx.children[0].exited, true);
  assert.equal(ctx.host.controlProcesses.size, 0);
  assert.equal(ctx.host.controlQueries.size, 0);
  const { prompt, options } = ctx.calls[0];
  assert.deepEqual(await prompt.next(), { value: undefined, done: true });
  assert.equal(options.cwd, "/private/fixture-home");
  for (const key of ["settingSources", "skills", "tools", "allowedTools"]) assert.deepEqual(options[key], []);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.permissionMode, "dontAsk");
  assert.equal(options.model, undefined);
  assert.equal((await options.canUseTool()).behavior, "deny");
  assert.equal(options.abortController.signal.aborted, true);
  assert.throws(() => options.spawnClaudeCodeProcess({}), { code: "MODEL_ONLY_CANCELED" });
  assert.equal(ctx.children.length, 1, "late SDK work cannot spawn a new worker");
});

test("Claude applied model discovery fails closed without exposing settings or SDK errors", async () => {
  for (const config of [
    { missingMethod: true }, { settings: {} }, { settings: { model: selected.model } },
    { settings: { applied: { model: "bad\nmodel" } } }, { settings: { applied: { model: "" } } },
    { getSettings: () => { throw new Error("secret in SDK request error"); } }, { sdkThrows: true },
  ]) {
    const ctx = fixture(config);
    await assert.rejects(ctx.host.resolveModelOnly(request), error => {
      assert.equal(error.code, "RUNTIME_MODEL_UNAVAILABLE");
      assert.doesNotMatch(String(error.stack), /secret|PRIVATE_KEY|raw-alias/u); return true;
    });
    assert.equal(ctx.children[0].exited, true);
    assert.equal(ctx.host.controlQueries.size, 0);
  }
});

test("Claude resolves an explicit alias through the same empty SDK input stream", async () => {
  const ctx = fixture();
  assert.deepEqual(await ctx.host.resolveModelOnly({ ...request, model: "opus" }), selected);
  assert.equal(ctx.calls[0].options.model, "opus");
  assert.deepEqual(await ctx.calls[0].prompt.next(), { done: true, value: undefined });
  assert.equal(ctx.children[0].exited, true);
});

test("Claude cancellation waits for its own process and leaves unrelated control work alone", async () => {
  const ctx = fixture({ getSettings: () => new Promise(() => {}) }), controller = new AbortController();
  const other = new ControlChild(20_000); ctx.host._trackControlProcess(other);
  const pending = ctx.host.resolveModelOnly({ ...request, signal: controller.signal });
  await ctx.started;
  controller.abort();
  assert.equal(ctx.host.controlQueries.size, 1, "cleanup remains owned until exit");
  await assert.rejects(pending, { code: "MODEL_ONLY_CANCELED" });
  assert.equal(ctx.children[0].exited, true);
  assert.deepEqual(other.signals, []);
  assert.deepEqual([...ctx.host.controlProcesses.keys()], [other]);
  other.emit("exit", 0, null);
});

test("Claude host stop cancels a pending settings request and waits for cleanup", async () => {
  const ctx = fixture({ getSettings: () => new Promise(() => {}) });
  const pending = ctx.host.resolveModelOnly(request);
  const rejected = assert.rejects(pending, { code: "MODEL_ONLY_CANCELED" });
  await ctx.started;
  await ctx.host.stop(); await rejected;
  assert.equal(ctx.children[0].exited, true);
  assert.equal(ctx.host.controlProcesses.size, 0);
  assert.equal(ctx.host.controlQueries.size, 0);
});

test("Claude cleanup failure overrides cancellation and retains the live worker", async () => {
  const ctx = fixture({ mode: "stuck", getSettings: () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = ctx.host.resolveModelOnly({ ...request, signal: controller.signal });
  await ctx.started; controller.abort();
  await assert.rejects(pending, { code: "RUNTIME_STOP_UNCONFIRMED" });
  assert.equal(ctx.host.cleanupIncomplete, true);
  assert.equal(ctx.host.controlProcesses.size, 1);
  assert.ok(ctx.children[0].signals.includes("SIGKILL"));
  ctx.children[0].emit("exit", 0, null);
});

test("a spawned Claude worker error is not treated as proof of exit", async () => {
  const ctx = fixture({ mode: "error-until-kill" });
  assert.deepEqual(await ctx.host.resolveModelOnly(request), selected);
  assert.ok(ctx.children[0].signals.includes("SIGKILL"));
  assert.equal(ctx.children[0].exited, true);
  const spawnFailure = new ControlChild(undefined);
  const finished = ctx.host._trackControlProcess(spawnFailure);
  spawnFailure.emit("error", new Error("fixture spawn failure")); await finished;
  assert.equal(ctx.host.controlProcesses.size, 0);
});

test("pre-canceled and malformed discovery requests cannot start the SDK", async () => {
  const ctx = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(ctx.host.resolveModelOnly({ ...request, signal: controller.signal }), { code: "MODEL_ONLY_CANCELED" });
  await assert.rejects(ctx.host.resolveModelOnly({ ...request, prompt: "private memory" }), { code: "MODEL_RESOLUTION_INVALID" });
  assert.equal(ctx.calls.length, 0);
});

test("Claude discovery releases an actual isolated control process before resolving", async t => {
  const ctx = fixture(); let child;
  ctx.host.userHome = require("node:os").tmpdir();
  ctx.host.killGraceMs = 500;
  ctx.host._spawnEnvironment = () => ({ ELECTRON_RUN_AS_NODE: "1", HOME: ctx.host.userHome });
  ctx.host.spawnProcess = (...args) => (child = spawn(...args));
  ctx.host.killProcessGroup = (pid, signal) => process.kill(-pid, signal);
  t.after(() => {
    if (child?.exitCode === null && child?.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  });
  ctx.host.sdk.query = params => {
    child = params.options.spawnClaudeCodeProcess({
      command: ctx.host.binaryPath,
      args: ["-e", "process.stdout.write('ready\\n'); process.stdin.resume()"],
      cwd: params.options.cwd, env: params.options.env,
    });
    const ready = new Promise((resolve, reject) => {
      child.stdout.once("data", () => resolve({ applied: { model: selected.model } }));
      child.once("error", reject);
      child.once("exit", () => reject(new Error("fixture ended before control reply")));
    });
    return { getSettings: () => ready, close() { child.stdin.end(); } };
  };
  assert.deepEqual(await ctx.host.resolveModelOnly(request), selected);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(ctx.host.controlProcesses.size, 0);
  assert.equal(ctx.host.controlQueries.size, 0);
});
