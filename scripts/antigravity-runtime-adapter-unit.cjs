#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const { AntigravityRuntimeAdapter } = require(path.join(
  ROOT, "app", "agent-service", "antigravity-runtime-adapter.js",
));
const { AntigravityRuntimePool } = require(path.join(
  ROOT, "app", "agent-service", "antigravity-runtime-pool.js",
));
const {
  AntigravityStreamJsonDecoder,
  encodeAntigravityUserMessage,
} = require(path.join(ROOT, "app", "agent-service", "antigravity-stream-json.js"));
const { writeAntigravityManagedConfig } = require(path.join(
  ROOT, "app", "agent-service", "antigravity-runtime-config.js",
));
const {
  AntigravityRuntimeLedger,
  SCHEMA_VERSION: ANTIGRAVITY_LEDGER_SCHEMA_VERSION,
  emptyAntigravityUsage,
} = require(path.join(ROOT, "app", "agent-service", "antigravity-runtime-ledger.js"));
const {
  DEFAULT_ANTIGRAVITY_PERMISSION_POLICY,
  buildAntigravityTurnArgs,
  parseAntigravityVersion,
  prepareAntigravityHome,
  prepareAntigravityKeychainContext,
  supportsAntigravityVersion,
} = require(path.join(ROOT, "app", "agent-service", "antigravity-runtime-paths.js"));
const {
  NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));

let nextPid = 61_000;

function streamResult(conversationId, response = "完成") {
  return {
    event: "result",
    result: {
      conversation_id: conversationId,
      status: "SUCCESS",
      response,
      num_turns: 1,
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        thinking_tokens: 2,
        cache_read_tokens: 10,
        total_tokens: 105,
      },
    },
  };
}

class FakeChild extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pid = nextPid += 1;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.closed = false;
    this.input = "";
    this.barrier = "";
    this.stdin = options.ignoreInput ? null : new Writable({
      write: (chunk, _encoding, callback) => {
        if (options.stdinError) {
          callback(options.stdinError);
          return;
        }
        this.input += chunk.toString("utf8");
        callback();
      },
      final: (callback) => {
        callback();
        options.onInput?.(this);
      },
    });
    this.stdio = options.turn ? [
      this.stdin,
      this.stdout,
      this.stderr,
      new Writable({
        write: (chunk, _encoding, callback) => {
          if (options.barrierError) {
            callback(options.barrierError);
            return;
          }
          this.barrier += chunk.toString("utf8");
          callback();
        },
      }),
    ] : [this.stdin, this.stdout, this.stderr];
  }

  send(message) {
    if (!this.closed) this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  finish(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, signal));
  }

  kill(signal = "SIGTERM") {
    this.finish(signal === "SIGKILL" ? null : 0, signal);
    return true;
  }
}

function fixture(behavior = {}) {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-antigravity-"));
  fs.chmodSync(trustedRoot, 0o700);
  const binDir = path.join(trustedRoot, "bin");
  const workspace = path.join(trustedRoot, "workspace");
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  const binaryCandidate = path.join(binDir, "agy");
  fs.writeFileSync(binaryCandidate, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const binaryPath = fs.realpathSync(binaryCandidate);
  const spawns = [];
  const bindings = [];
  const revocations = [];
  let reservationSequence = 0;
  const mcpGateIssuer = {
    reserveMcpServer(input) {
      behavior.onMcpReserve?.(input);
      reservationSequence += 1;
      const reservationId = reservationSequence.toString(16).padStart(64, "0");
      return {
        reservationId,
        name: "shoggoth",
        command: binaryPath,
        args: ["bootstrap", "--shoggoth-internal-role=mcp",
          `--shoggoth-runtime-profile=${input.runtimeProfileId}`,
          `--shoggoth-runtime-account=${input.runtimeAccountId}`],
        env: [
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
          { name: "SHOGGOTH_RUNTIME_MCP_GATE_NONCE", value: reservationId },
        ],
      };
    },
    bindMcpServer(input) { bindings.push(input); return { bound: true }; },
    revokeMcpServer(input) { revocations.push(input); return { revoked: true }; },
  };
  const children = [];
  const spawnProcess = (command, args, options) => {
    let child;
    if (command === binaryPath) {
      child = new FakeChild({ ignoreInput: true });
      queueMicrotask(() => {
        if (behavior.onControl?.(child, args, options) === true) return;
        if (args[0] === "--version" && behavior.holdVersion) return;
        if (args[0] === "--version") child.stdout.write(`${behavior.version || "1.1.23"}\n`);
        else if (args[0] === "models") {
          child.stdout.write([
            "Fetching available models...",
            "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
            "gemini-3.7-pro-high\tGemini 3.7 Pro (High)",
            "",
          ].join("\n"));
        } else if (args[0] === "--print") {
          if (args[1] === "/help") child.stdout.write("help\tList commands\nusage (quota)\tShow usage\nmodel\tChoose model\n");
          else if (args[1] === "/skills") child.stdout.write("project-check\tCheck this project\n");
          else if (args[1] === "/usage") child.stdout.write("Fixture usage: 10 credits\n");
        }
        child.finish(0);
      });
    } else {
      child = new FakeChild({
        turn: true,
        stdinError: behavior.stdinError,
        barrierError: behavior.barrierError,
        onInput(current) {
          queueMicrotask(() => {
            if (behavior.onTurnInput) {
              behavior.onTurnInput(current, options);
              return;
            }
            const conversationId = "conversation-one";
            current.send({
              event: "init",
              conversation_id: conversationId,
              init: { cwd: options.cwd, tools: ["shoggoth"], permission_mode: "request-review" },
            });
            current.send({
              event: "step_update",
              step_update: {
                conversation_id: conversationId,
                step_index: 0,
                state: "DONE",
                step_type: "user_input",
              },
            });
            current.send({
              event: "step_update",
              step_update: {
                conversation_id: conversationId,
                step_index: 1,
                state: "ACTIVE",
                step_type: "agent_response",
                text_delta: "完",
              },
            });
            current.send({
              event: "step_update",
              step_update: {
                conversation_id: conversationId,
                step_index: 1,
                state: "DONE",
                step_type: "agent_response",
                text_delta: "成",
              },
            });
            current.send(streamResult(conversationId));
            current.finish(0);
          });
        },
      });
    }
    children.push(child);
    spawns.push({ command, args, options, child });
    return child;
  };
  const pool = new AntigravityRuntimePool({
    paths: { stateDir: path.join(trustedRoot, "state"), trustedRoot },
    binaryPath,
    homedir: trustedRoot,
    platform: behavior.platform || "linux",
    securityExecFileSync: behavior.securityExecFileSync,
    parentEnv: {
      PATH: binDir, LANG: "C.UTF-8", SECRET_TOKEN: "must-not-leak",
      ELECTRON_RUN_AS_NODE: "0",
      SHOGGOTH_RUNTIME_MCP_GATE_FILE: "/private/stale.gate",
      SHOGGOTH_RUNTIME_MCP_GATE_NONCE: "must-not-leak",
    },
    spawnProcess,
    mcpGateIssuer,
    acceptanceTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    now: behavior.now,
    promptTimeoutMs: 1_000,
    shutdownGraceMs: 100,
    killGraceMs: 100,
    killProcessGroup(pid, signal) {
      children.find((child) => child.pid === pid)?.finish(0, signal);
    },
  });
  return {
    adapter: new AntigravityRuntimeAdapter({ runtimePool: pool }),
    binaryPath,
    bindings,
    children,
    pool,
    revocations,
    spawns,
    trustedRoot,
    workspace,
    cleanup() {
      for (const child of children) child.finish();
      fs.rmSync(trustedRoot, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate, label, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("stream parser validates known frames, preserves unknown frames and bounds input", () => {
  const decoder = new AntigravityStreamJsonDecoder({ maxFrameBytes: 1024, maxStreamBytes: 4096 });
  const values = decoder.push([
    JSON.stringify({ event: "future_event", payload: { safe: true } }),
    JSON.stringify({
      event: "init",
      conversation_id: "conversation-one",
      init: { cwd: "/tmp", tools: [], permission_mode: "request-review" },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-one",
        step_index: 1,
        state: "ERROR",
        step_type: "tool",
        tool_name: "list_dir",
        tool_info: { error: "Permission denied" },
      },
    }),
    "",
  ].join("\n"));
  assert.equal(values[0].known, false);
  assert.equal(values[1].known, true);
  assert.equal(values[2].value.step_update.state, "ERROR");
  assert.deepEqual(decoder.finish(), []);
  assert.equal(encodeAntigravityUserMessage("hello"),
    '{"event":"user","message":{"content":"hello"}}\n');
  assert.throws(() => new AntigravityStreamJsonDecoder({
    maxFrameBytes: 1024,
    maxStreamBytes: 1024,
  }).push("x".repeat(1025)), { code: "ANTIGRAVITY_STREAM_TOO_LARGE" });
});

test("version, arguments and managed config use safe Antigravity defaults", () => {
  assert.deepEqual(parseAntigravityVersion("1.1.23\n"), [1, 1, 23]);
  assert.equal(supportsAntigravityVersion("1.1.15"), false);
  assert.equal(supportsAntigravityVersion("1.1.16"), true);
  assert.deepEqual(DEFAULT_ANTIGRAVITY_PERMISSION_POLICY, {
    approvalPolicy: "on-request",
    sandbox: "danger-full-access",
  });
  assert.deepEqual(buildAntigravityTurnArgs(), [
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--disable-slash-commands", "--print-timeout", "5m", "--mode", "accept-edits",
    "--sandbox", "--new-project",
  ]);
  const acceptEditsArgs = buildAntigravityTurnArgs({
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "danger-full-access" },
    permissionMode: "accept-edits",
  });
  assert.equal(acceptEditsArgs.includes("--sandbox"), true);
  assert.equal(acceptEditsArgs.includes("--dangerously-skip-permissions"), false);
  const args = buildAntigravityTurnArgs({
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    model: "gemini-3.7-pro-high",
    conversationId: "conversation-one",
  });
  assert.deepEqual(args, [
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--disable-slash-commands", "--print-timeout", "5m", "--mode", "accept-edits",
    "--sandbox", "--model", "gemini-3.7-pro-high", "--conversation", "conversation-one",
  ]);
  const fullArgs = buildAntigravityTurnArgs({
    permissionPolicy: { approvalPolicy: "never", sandbox: "danger-full-access" },
    permissionMode: "full",
  });
  assert.equal(fullArgs.includes("--dangerously-skip-permissions"), true);
  assert.equal(fullArgs.includes("--sandbox"), false);
  assert.deepEqual(buildAntigravityTurnArgs({
    permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" },
    permissionMode: "plan",
  }).slice(-4), ["--mode", "plan", "--sandbox", "--new-project"]);

  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-antigravity-config-"));
  fs.chmodSync(trustedRoot, 0o700);
  const paths = { stateDir: path.join(trustedRoot, "state"), trustedRoot };
  const home = prepareAntigravityHome(paths, "antigravity-main");
  const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    theme: "dark",
    toolPermission: "request-review",
    permissions: { allow: ["ShellTool(git status)"], deny: ["ShellTool(rm *)"] },
  }), { mode: 0o644 });
  const mcpPath = path.join(home, ".gemini", "config", "mcp_config.json");
  fs.writeFileSync(mcpPath, "", { mode: 0o600 });
  writeAntigravityManagedConfig({
    home,
    trustedRoot,
    mcpServer: {
      command: "/tmp/shoggoth-helper", args: ["bootstrap"],
      env: [{ name: "SHOGGOTH_RUNTIME_MCP_GATE_NONCE", value: "must-not-persist" }],
    },
  });
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(fs.statSync(settingsPath).mode & 0o077, 0);
  assert.equal(settings.theme, "dark");
  assert.equal(settings.toolPermission, "proceed-in-sandbox");
  assert.deepEqual(settings.permissions.deny, ["ShellTool(rm *)"]);
  assert.ok(settings.permissions.allow.includes("mcp(shoggoth/*)"));
  const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  assert.deepEqual(mcp.mcpServers.shoggoth, {
    command: "/tmp/shoggoth-helper",
    args: ["bootstrap"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    disabled: false,
  });
  const beforeSettings = fs.statSync(settingsPath);
  writeAntigravityManagedConfig({ home, trustedRoot,
    mcpServer: { command: "/tmp/shoggoth-helper", args: ["bootstrap"], env: [] } });
  const afterSettings = fs.statSync(settingsPath);
  assert.equal(afterSettings.ino, beforeSettings.ino, "unchanged settings retain catalog identity across turns");
  assert.equal(afterSettings.mtimeMs, beforeSettings.mtimeMs);
  fs.rmSync(trustedRoot, { recursive: true, force: true });
});

test("macOS managed HOME mirrors only the user default keychain and stays idempotent", () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-antigravity-keychain-"));
  fs.chmodSync(trustedRoot, 0o700);
  const userHome = path.join(trustedRoot, "user");
  const keychainDir = path.join(userHome, "Library", "Keychains");
  fs.mkdirSync(keychainDir, { recursive: true, mode: 0o700 });
  const defaultKeychain = path.join(keychainDir, "login.keychain-db");
  fs.writeFileSync(defaultKeychain, "fixture", { mode: 0o600 });
  const canonicalDefaultKeychain = fs.realpathSync(defaultKeychain);
  const paths = { stateDir: path.join(trustedRoot, "state"), trustedRoot };
  const home = prepareAntigravityHome(paths, "antigravity-main");
  const calls = [];
  let managedDefault = null;
  let managedSearchList = [];
  const securityExecFileSync = (command, args, options) => {
    calls.push({ command, args: [...args], home: options.env.HOME });
    assert.equal(command, "/usr/bin/security");
    if (args[0] === "default-keychain" && !args.includes("-s")) {
      if (options.env.HOME === userHome) return `    "${defaultKeychain}"\n`;
      if (managedDefault === null) throw new Error("A default keychain could not be found");
      return `    "${managedDefault}"\n`;
    }
    if (args[0] === "list-keychains" && !args.includes("-s")) {
      return managedSearchList.map((entry) => `    "${entry}"`).join("\n");
    }
    if (args[0] === "list-keychains" && args.includes("-s")) {
      managedSearchList = args.slice(args.indexOf("-s") + 1);
      const preferencesDir = path.join(home, "Library", "Preferences");
      fs.mkdirSync(preferencesDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(preferencesDir, "com.apple.security.plist"), "fixture", {
        mode: 0o644,
      });
      return "";
    }
    if (args[0] === "default-keychain" && args.includes("-s")) {
      managedDefault = args[args.indexOf("-s") + 1];
      return "";
    }
    assert.fail(`unexpected security invocation: ${args.join(" ")}`);
  };
  try {
    prepareAntigravityKeychainContext({
      home,
      userHome,
      trustedRoot,
      platform: "darwin",
      execFileSync: securityExecFileSync,
    });
    assert.equal(managedDefault, canonicalDefaultKeychain);
    assert.deepEqual(managedSearchList, [canonicalDefaultKeychain]);
    assert.equal(fs.statSync(path.join(
      home,
      "Library",
      "Preferences",
      "com.apple.security.plist",
    )).mode & 0o077, 0);
    const writes = calls.filter((call) => call.args.includes("-s")).length;
    prepareAntigravityKeychainContext({
      home,
      userHome,
      trustedRoot,
      platform: "darwin",
      execFileSync: securityExecFileSync,
    });
    assert.equal(calls.filter((call) => call.args.includes("-s")).length, writes);
    assert.equal(calls.some((call) => call.home === home), true);
    assert.equal(calls.every((call) => call.home === home || call.home === userHome), true);
  } finally {
    fs.rmSync(trustedRoot, { recursive: true, force: true });
  }
});

test("Antigravity keychain preparation fails closed and is a non-macOS no-op", () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-antigravity-keychain-fail-"));
  fs.chmodSync(trustedRoot, 0o700);
  const userHome = path.join(trustedRoot, "user");
  fs.mkdirSync(userHome, { mode: 0o700 });
  const paths = { stateDir: path.join(trustedRoot, "state"), trustedRoot };
  const home = prepareAntigravityHome(paths, "antigravity-main");
  let calls = 0;
  try {
    assert.throws(() => prepareAntigravityKeychainContext({
      home,
      userHome,
      trustedRoot,
      platform: "darwin",
      execFileSync() {
        calls += 1;
        throw new Error("missing default keychain");
      },
    }), { code: "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE" });
    assert.equal(calls, 1);
    prepareAntigravityKeychainContext({
      home,
      userHome,
      trustedRoot,
      platform: "linux",
      execFileSync() {
        calls += 1;
        throw new Error("must not run");
      },
    });
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(trustedRoot, { recursive: true, force: true });
  }
});

test("runtime fails before spawning agy when the macOS keychain context is unavailable", async () => {
  const value = fixture({
    platform: "darwin",
    securityExecFileSync() {
      throw new Error("missing default keychain");
    },
  });
  try {
    await assert.rejects(value.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, {
      workspace: value.workspace,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    }), { code: "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE" });
    assert.equal(value.spawns.length, 0);
  } finally {
    await value.pool.stopAll().catch(() => {});
    value.cleanup();
  }
});

test("Antigravity discovers native aliases and enables slash expansion only for validated skills", async () => {
  const value = fixture();
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire({
      runtime: "antigravity", runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, { workspace: value.workspace, permissionPolicy });
    const catalog = await runtime.commandsList({ cwd: value.workspace });
    assert.equal(catalog.reason, null);
    assert.deepEqual(catalog.commands.find((entry) => entry.name === "usage").aliases, ["quota"]);
    assert.equal(catalog.commands.find((entry) => entry.name === "project-check").execution, "runtime");
    assert.equal(value.spawns.find((entry) => entry.args[1] === "/help").options.cwd, value.workspace);
    assert.deepEqual(await runtime.commandExecute({ text: "/quota", cwd: value.workspace }), {
      kind: "output", text: "Fixture usage: 10 credits", warning: null,
    });
    await assert.rejects(runtime.commandExecute({ text: "/quota extra", cwd: value.workspace }),
      { code: "RUNTIME_COMMAND_PARAMS_INVALID" });
    const started = await runtime.sessionStart({ source: "chat:skill", persistent: true,
      developerInstructions: "Keep scope.", model: "gemini-3.7-pro-high", cwd: value.workspace, permissionPolicy });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    const receipt = await runtime.turnStart({ sessionId: started.session.id, operationId: "skill-one",
      prompt: "/project-check src", context: "Bound context.", model: "gemini-3.7-pro-high", cwd: value.workspace, permissionPolicy });
    await waitFor(() => events.some((event) => event.type === "complete" && event.turnId === receipt.turn.id), "skill completion");
    const turn = value.spawns.find((entry) => entry.command === "/bin/sh");
    assert.equal(turn.args.includes("--disable-slash-commands"), false);
    assert.match(turn.child.input, /\/project-check src/u);
    assert.match(turn.child.input, /Keep scope/u);
    assert.match(turn.child.input, /Bound context/u);
  } finally {
    await value.adapter.stopAll();
    value.cleanup();
  }
});

test("Antigravity control queries stay headless, coalesce in flight and retain no MCP gate", async () => {
  let failUsage = true;
  const value = fixture({
    onControl(child, args) {
      if (args[1] !== "/usage" || !failUsage) return false;
      child.finish(1);
      return true;
    },
  });
  try {
    const runtime = await value.adapter.acquire({
      runtime: "antigravity", runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, { workspace: value.workspace });
    const catalogs = await Promise.all(Array.from({ length: 3 }, () => runtime.commandsList()));
    assert.ok(catalogs.every((catalog) => catalog.reason === null));
    for (const name of ["/help", "/skills"]) {
      assert.equal(value.spawns.filter(({ args }) => args[1] === name).length, 1);
    }
    const models = await Promise.all(Array.from({ length: 3 }, () => runtime.modelsList()));
    assert.ok(models.every((catalog) => catalog.data.length === 2));
    assert.equal(value.spawns.filter(({ args }) => args[0] === "models").length, 1);
    const failed = await Promise.allSettled(Array.from({ length: 3 }, () => runtime.commandExecute({ text: "/usage" })));
    assert.ok(failed.every((result) => result.status === "rejected" && result.reason.code === "RUNTIME_COMMAND_FAILED"));
    assert.equal(value.spawns.filter(({ args }) => args[1] === "/usage").length, 1);
    failUsage = false;
    assert.equal((await runtime.commandExecute({ text: "/usage" })).text, "Fixture usage: 10 credits");
    assert.equal(value.spawns.filter(({ args }) => args[1] === "/usage").length, 2, "failed queries must be retryable");
    for (const { options } of value.spawns) {
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
      assert.equal(options.env.SHOGGOTH_RUNTIME_MCP_GATE_FILE, undefined);
      assert.equal(options.env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE, undefined);
      assert.equal(options.env.SECRET_TOKEN, undefined);
    }
    assert.equal(value.bindings.length, 0);
  } finally {
    await value.adapter.stopAll();
    value.cleanup();
  }
});

test("parallel per-run Antigravity hosts share a ledger but retain independent MCP gate environments", async () => {
  const reservations = [];
  const value = fixture({ onMcpReserve: input => reservations.push(input), onTurnInput(child, options) {
    const conversationId = `conversation-${child.pid}`;
    child.send({ event: "init", conversation_id: conversationId,
      init: { cwd: options.cwd, tools: ["shoggoth"], permission_mode: "request-review" } });
    child.send({ event: "step_update", step_update: { conversation_id: conversationId,
      step_index: 0, state: "DONE", step_type: "user_input" } });
  } });
  const binding = { runtime: "antigravity", runtimeProfileId: "parallel-profile",
    runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID };
  const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
  try {
    const hosts = await Promise.all(["run-one", "run-two"].map(runId => value.pool.get(binding,
      { workspace: value.workspace, permissionPolicy, executionContract: { runId } })));
    assert.notEqual(hosts[0], hosts[1]);
    assert.equal(hosts[0].ledger, hosts[1].ledger);
    const sessions = await Promise.all(hosts.map((host, index) => host.sessionStart({
      source: `parallel-session-${index}`, cwd: value.workspace, permissionPolicy,
    })));
    await Promise.all(hosts.map((host, index) => host.turnStart({
      sessionId: sessions[index].session.id, operationId: `parallel-turn-${index}`,
      prompt: "hold", cwd: value.workspace, permissionPolicy,
    })));
    const processes = value.spawns.filter(entry => entry.command === "/bin/sh");
    assert.equal(processes.length, 2);
    const nonces = processes.map(entry => entry.options.env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE);
    assert.notEqual(nonces[0], nonces[1]);
    assert.deepEqual(reservations.map(entry => entry.executionRunId), ["run-one", "run-two"]);
    const config = fs.readFileSync(path.join(hosts[0].home, ".gemini", "config", "mcp_config.json"), "utf8");
    for (const nonce of nonces) assert.equal(config.includes(nonce), false);
    assert.deepEqual(JSON.parse(config).mcpServers.shoggoth.env, { ELECTRON_RUN_AS_NODE: "1" });
    assert.equal(hosts[0].ledger.snapshot().sessions.length, 2);
    assert.equal(hosts[0].ledger.snapshot().sessions.every(session => session.turns[0].status === "inProgress"), true);
  } finally { await value.pool.stopAll(); value.cleanup(); }
});

test("adapter executes a turn with account-shared integration HOME, MCP bind barrier and local durable session", async () => {
  const value = fixture();
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, { workspace: value.workspace, permissionPolicy });
    assert.equal(runtime.capabilities.serverRequests, false);
    assert.equal(runtime.capabilities["turn.steer"], false);
    assert.deepEqual(await runtime.authenticationState(), {
      authenticated: true,
      credentialPresent: true,
    });
    const models = await runtime.modelsList();
    assert.deepEqual(models.data[0], {
      model: "gemini-3.7-flash-high",
      displayName: "Gemini 3.7 Flash (High)",
      description: "",
      isDefault: true,
      hidden: false,
      capabilities: { thinkingOptions: ["low", "medium", "high"], thinkingDefault: null, fastTier: null },
    });
    const started = await runtime.sessionStart({
      source: "chat:one",
      persistent: true,
      developerInstructions: "Keep changes scoped.",
      model: "gemini-3.7-pro-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    const events = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    const receipt = await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-one",
      prompt: "修复问题",
      attachmentDirectory: path.join(value.trustedRoot, "chat-attachments", started.session.id),
      thinkingLevel: "high",
      context: "只修改相关文件。",
      model: "gemini-3.7-pro-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    assert.match(receipt.turn.id, /^antigravity-turn-/u);
    await waitFor(() => events.some((event) => event.type === "complete"), "turn completion");
    const turnSpawn = value.spawns.find((entry) => entry.command === "/bin/sh");
    assert.ok(turnSpawn);
    assert.equal(turnSpawn.args.includes("--new-project"), true);
    assert.equal(turnSpawn.args.includes("--conversation"), false);
    assert.equal(turnSpawn.args[turnSpawn.args.indexOf("--effort") + 1], "high");
    assert.equal(turnSpawn.args[turnSpawn.args.indexOf("--add-dir") + 1], path.join(value.trustedRoot, "chat-attachments", started.session.id));
    assert.equal(turnSpawn.args.includes("--sandbox"), true);
    assert.equal(turnSpawn.args.includes("--dangerously-skip-permissions"), false);
    assert.equal(turnSpawn.options.env.HOME,
      path.join(
        value.trustedRoot,
        "state",
        "runtime-integration",
        "antigravity",
        NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
        "home",
      ));
    assert.equal(turnSpawn.options.env.SECRET_TOKEN, undefined);
    assert.equal(turnSpawn.options.env.ELECTRON_RUN_AS_NODE, "1");
    assert.match(turnSpawn.options.env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE, /^[a-f0-9]{64}$/u);
    assert.equal(turnSpawn.child.barrier, "go\n");
    const input = JSON.parse(turnSpawn.child.input.trim());
    assert.equal(input.event, "user");
    assert.match(input.message.content, /CURRENT USER REQUEST\n修复问题/u);
    assert.equal(value.bindings[0].parentPid, turnSpawn.child.pid);
    assert.ok(value.revocations.length >= 1);
    assert.equal(events.filter((event) => event.type === "text_delta").length, 2);
    assert.equal(events.find((event) => event.type === "usage").usage.totalTokens, 105);
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-two",
      prompt: "继续验证",
      model: "gemini-3.7-pro-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    await waitFor(
      () => events.filter((event) => event.type === "complete").length === 2,
      "resumed turn completion",
    );
    unsubscribe();
    const turnSpawns = value.spawns.filter((entry) => entry.command === "/bin/sh");
    assert.equal(turnSpawns.length, 2);
    assert.equal(turnSpawns[1].args.includes("--new-project"), false);
    const conversationIndex = turnSpawns[1].args.indexOf("--conversation");
    assert.notEqual(conversationIndex, -1);
    assert.equal(turnSpawns[1].args[conversationIndex + 1], "conversation-one");
    const read = await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    assert.equal(read.session.turns[0].status, "completed");
    assert.equal(read.session.turns[0].items[1].text, "完成");
    assert.equal(read.session.turns[1].status, "completed");
    const ledgerPath = path.join(
      value.trustedRoot,
      "state",
      "runtime-ledgers",
      "antigravity",
      "antigravity-main",
      runtime.host.ledger.workspaceShardId,
      "runtime-ledger.json",
    );
    assert.equal(fs.statSync(ledgerPath).mode & 0o077, 0);
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("SUCCESS 无最终回答时失败，已有流式回答时用流式内容完成", async () => {
  const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
  const empty = fixture({
    onTurnInput(child, options) {
      const conversationId = "conversation-empty-success";
      child.send({
        event: "init",
        conversation_id: conversationId,
        init: { cwd: options.cwd, tools: ["shoggoth"], permission_mode: "request-review" },
      });
      child.send({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      });
      child.send(streamResult(conversationId, ""));
      child.finish(0);
    },
  });
  try {
    const runtime = await empty.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, { workspace: empty.workspace, permissionPolicy });
    const started = await runtime.sessionStart({
      source: "chat:empty-success",
      persistent: true,
      developerInstructions: "",
      model: "gemini-3.7-flash-high",
      cwd: empty.workspace,
      permissionPolicy,
    });
    const events = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-empty-success",
      prompt: "browse",
      model: "gemini-3.7-flash-high",
      cwd: empty.workspace,
      permissionPolicy,
    });
    await waitFor(() => events.some((event) => event.type === "complete"), "empty completion");
    unsubscribe();
    const turn = runtime.host.ledger.snapshot().sessions[0].turns[0];
    assert.equal(turn.status, "failed");
    assert.equal(turn.errorCode, "ANTIGRAVITY_EMPTY_RESPONSE");
    assert.deepEqual(turn.assistantMessages, []);
  } finally {
    await empty.adapter.stopAll().catch(() => {});
    empty.cleanup();
  }

  const streamed = fixture({
    onTurnInput(child, options) {
      const conversationId = "conversation-streamed-success";
      child.send({
        event: "init",
        conversation_id: conversationId,
        init: { cwd: options.cwd, tools: ["shoggoth"], permission_mode: "request-review" },
      });
      child.send({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      });
      child.send({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "流式完成",
        },
      });
      child.send(streamResult(conversationId, ""));
      child.finish(0);
    },
  });
  try {
    const runtime = await streamed.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, { workspace: streamed.workspace, permissionPolicy });
    const started = await runtime.sessionStart({
      source: "chat:streamed-success",
      persistent: true,
      developerInstructions: "",
      model: "gemini-3.7-flash-high",
      cwd: streamed.workspace,
      permissionPolicy,
    });
    const events = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-streamed-success",
      prompt: "browse",
      model: "gemini-3.7-flash-high",
      cwd: streamed.workspace,
      permissionPolicy,
    });
    await waitFor(() => events.some((event) => event.type === "complete"), "streamed completion");
    unsubscribe();
    const read = await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    assert.equal(read.session.turns[0].status, "completed");
    assert.equal(read.session.turns[0].items[1].text, "流式完成");
  } finally {
    await streamed.adapter.stopAll().catch(() => {});
    streamed.cleanup();
  }
});

test("headless 对象错误与 denied_actions 分别返回可操作权限错误", async () => {
  const failures = [
    {
      error: {
        type: "TOOL_ERROR",
        message: 'permission check failed for command "pwd": user denied permission to run command:\npwd',
      },
      deniedActions: undefined,
    },
    {
      error: { type: "TOOL_ERROR", message: "command execution was blocked" },
      deniedActions: [{ action: "command", display_name: "RunCommand" }],
    },
  ];
  let failureIndex = 0;
  const value = fixture({
    onTurnInput(child, options) {
      const conversationId = "conversation-permission-required";
      const failure = failures[failureIndex];
      failureIndex += 1;
      child.send({
        event: "init",
        conversation_id: conversationId,
        init: { cwd: options.cwd, tools: ["ViewFile"], permission_mode: "request-review" },
      });
      child.send({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      });
      child.send({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "ERROR",
          step_type: "tool",
          tool_name: "RunCommand",
          tool_info: { error: failure.error },
        },
      });
      const result = streamResult(conversationId, "");
      if (failure.deniedActions) result.result.denied_actions = failure.deniedActions;
      child.send(result);
      child.finish(0);
    },
  });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, { workspace: value.workspace, permissionPolicy });
    const started = await runtime.sessionStart({
      source: "chat:permission-required",
      developerInstructions: "",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    const events = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-permission-required",
      prompt: "读取工作区外文件",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    await waitFor(() => events.some((event) => event.type === "complete"), "permission completion");
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-denied-actions",
      prompt: "执行需要授权的命令",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    await waitFor(
      () => events.filter((event) => event.type === "complete").length === 2,
      "denied action completion",
    );
    unsubscribe();
    const turns = runtime.host.ledger.snapshot().sessions[0].turns;
    assert.deepEqual(turns.map((turn) => [turn.status, turn.errorCode]), [
      ["failed", "RUNTIME_APPROVAL_UNAVAILABLE"],
      ["failed", "RUNTIME_APPROVAL_UNAVAILABLE"],
    ]);
    assert.deepEqual(
      events.find((event) => event.type === "tool_result")?.tool.output,
      failures[0].error,
    );
    const read = await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    assert.equal(read.session.turns[0].errorCode, "RUNTIME_APPROVAL_UNAVAILABLE");
    assert.equal(read.session.turns[1].errorCode, "RUNTIME_APPROVAL_UNAVAILABLE");
  } finally {
    await value.adapter.stopAll().catch(() => {});
    value.cleanup();
  }
});

test("Google 上游 503 保留为暂时不可用且不自动重放", async () => {
  const value = fixture({
    onTurnInput(child) {
      child.stderr.write("You are not logged into Antigravity. Trying silent auth.\n");
      child.stderr.write("Print mode: silent auth succeeded\n");
      child.stderr.write('Request failed: UNAVAILABLE (code 503), status "UNAVAILABLE"\n');
      child.send({ event: "result", result: { status: "ERROR" } });
      child.finish(1);
    },
  });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, { workspace: value.workspace, permissionPolicy });
    const started = await runtime.sessionStart({
      source: "chat:upstream-503",
      developerInstructions: "",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    await assert.rejects(runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-upstream-503",
      prompt: "检查项目",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    }), { code: "RUNTIME_UPSTREAM_UNAVAILABLE" });
    const turn = runtime.host.ledger.snapshot().sessions[0].turns[0];
    assert.equal(turn.acceptance, "unknown");
    assert.equal(turn.errorCode, "RUNTIME_UPSTREAM_UNAVAILABLE");
  } finally {
    await value.adapter.stopAll().catch(() => {});
    value.cleanup();
  }
});

for (const [label, stderr, expectedCode] of [
  ["rate limit", 'Request failed: RESOURCE_EXHAUSTED (code 429), status "RESOURCE_EXHAUSTED"\n', "RUNTIME_RATE_LIMITED"],
  ["quota", 'Request failed: RESOURCE_EXHAUSTED (code 429): Quota exceeded for quota metric\n', "RUNTIME_QUOTA_EXHAUSTED"],
]) {
  test(`Google 429 ${label} is reported with a public reason and never replayed`, async () => {
    let inputs = 0;
    const value = fixture({
      onTurnInput(child) {
        inputs += 1;
        child.stderr.write(stderr);
        child.send({ event: "result", result: { status: "ERROR" } });
        child.finish(1);
      },
    });
    try {
      const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
      const runtime = await value.adapter.acquire({
        runtime: "antigravity",
        runtimeProfileId: "antigravity-main",
        runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
      }, { workspace: value.workspace, permissionPolicy });
      const started = await runtime.sessionStart({
        source: `chat:limit-${label.replace(/\s/gu, "-")}`,
        developerInstructions: "",
        model: "gemini-3.7-flash-high",
        cwd: value.workspace,
        permissionPolicy,
      });
      await assert.rejects(runtime.turnStart({
        sessionId: started.session.id,
        operationId: "operation-limit",
        prompt: "检查项目",
        model: "gemini-3.7-flash-high",
        cwd: value.workspace,
        permissionPolicy,
      }), { code: expectedCode });
      assert.equal(runtime.host.ledger.snapshot().sessions[0].turns[0].errorCode, expectedCode);
      assert.equal(inputs, 1);
    } finally {
      await value.adapter.stopAll().catch(() => {});
      value.cleanup();
    }
  });
}

test("a failed tool step remains recoverable and does not interrupt the turn", async () => {
  const value = fixture({
    onTurnInput(child, options) {
      const conversationId = "conversation-tool-error";
      child.send({
        event: "init",
        conversation_id: conversationId,
        init: { cwd: options.cwd, tools: ["shoggoth"], permission_mode: "request-review" },
      });
      child.send({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      });
      child.send({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "kanban_board_create",
          tool_info: { name: "kanban_board_create", parameters: { slug: "default" } },
        },
      });
      child.send({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "ERROR",
          step_type: "tool",
          tool_name: "kanban_board_create",
          tool_info: { name: "kanban_board_create", error: "MCP_TOOL_STATE_CONFLICT" },
        },
      });
      child.send(streamResult(conversationId, "已改为在现有看板中创建任务"));
      child.finish(0);
    },
  });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, { workspace: value.workspace, permissionPolicy });
    const started = await runtime.sessionStart({
      source: "chat:tool-error",
      developerInstructions: "",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    const events = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-tool-error",
      prompt: "在 Default 看板创建任务",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    await waitFor(() => events.some((event) => event.type === "complete"), "turn completion");
    unsubscribe();
    assert.deepEqual(events.find((event) => event.type === "tool_result")?.tool, {
      kind: "other",
      name: "kanban_board_create",
      status: "failed",
      success: false,
      output: "MCP_TOOL_STATE_CONFLICT",
    });
    assert.deepEqual(events.find((event) => event.type === "tool_start")?.tool.input, {
      slug: "default",
    });
    assert.equal(events.find((event) => event.type === "complete")?.status, "completed");
    const read = await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    assert.equal(read.session.turns[0].status, "completed");
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("unsupported CLI versions fail before any session or turn process starts", async () => {
  const value = fixture({ version: "1.1.15" });
  try {
    await assert.rejects(value.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, {
      workspace: value.workspace,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    }), { code: "ANTIGRAVITY_VERSION_UNSUPPORTED" });
    assert.equal(value.spawns.filter((entry) => entry.command === "/bin/sh").length, 0);
  } finally {
    await value.pool.stopAll().catch(() => {});
    value.cleanup();
  }
});

test("turn pipes absorb asynchronous EPIPE without escaping the Runtime host", async () => {
  for (const pipe of ["stdin", "barrier"]) {
    const behavior = { onTurnInput() {} };
    behavior[`${pipe}Error`] = Object.assign(new Error(`${pipe} closed`), { code: "EPIPE" });
    const value = fixture(behavior);
    try {
      const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
      const runtime = await value.adapter.acquire({
        runtime: "antigravity",
        runtimeProfileId: `antigravity-${pipe}`,
        runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
      }, { workspace: value.workspace, permissionPolicy });
      const started = await runtime.sessionStart({
        source: `chat:${pipe}-epipe`,
        developerInstructions: "",
        model: "gemini-3.7-flash-high",
        cwd: value.workspace,
        permissionPolicy,
      });
      await assert.rejects(runtime.turnStart({
        sessionId: started.session.id,
        operationId: `operation-${pipe}-epipe`,
        prompt: "must fail inside the host",
        model: "gemini-3.7-flash-high",
        cwd: value.workspace,
        permissionPolicy,
      }), { code: "ANTIGRAVITY_PROCESS_FAILED" });
      const turn = runtime.host.ledger.snapshot().sessions[0].turns[0];
      assert.equal(turn.acceptance, pipe === "barrier" ? "failed" : "unknown");
      assert.equal(turn.errorCode, "ANTIGRAVITY_PROCESS_FAILED");
    } finally {
      await value.adapter.stopAll().catch(() => {});
      value.cleanup();
    }
  }
});

test("pre-init malformed auth result is AUTH_REQUIRED and does not poison the session", async () => {
  const value = fixture({
    onTurnInput(child) {
      child.stderr.write("Print mode: not logged in and no controlling terminal\n");
      child.send({ event: "result", result: { status: "ERROR", error: "not logged in" } });
      child.finish(1);
    },
  });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-auth-result",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, { workspace: value.workspace, permissionPolicy });
    const started = await runtime.sessionStart({
      source: "chat:auth-result",
      developerInstructions: "",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    await assert.rejects(runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-auth-result",
      prompt: "must not be accepted",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    }), { code: "AUTH_REQUIRED" });
    const read = await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    const turn = runtime.host.ledger.snapshot().sessions[0].turns[0];
    assert.equal(turn.acceptance, "failed");
    assert.equal(read.session.turns[0].status, "failed");
    assert.equal(turn.errorCode, "AUTH_REQUIRED");
  } finally {
    await value.adapter.stopAll().catch(() => {});
    value.cleanup();
  }
});

test("a failure after input release is never replayed and does not brick later operations", async () => {
  const behavior = {
    onTurnInput(child) { child.finish(1); },
  };
  const value = fixture(behavior);
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, { workspace: value.workspace, permissionPolicy });
    const started = await runtime.sessionStart({
      source: "chat:unknown",
      developerInstructions: "",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    });
    const input = {
      sessionId: started.session.id,
      operationId: "operation-unknown",
      prompt: "may have been accepted",
      model: "gemini-3.7-flash-high",
      cwd: value.workspace,
      permissionPolicy,
    };
    await assert.rejects(runtime.turnStart(input), {
      code: "ANTIGRAVITY_STREAM_RESULT_MISSING",
    });
    await assert.rejects(runtime.turnStart(input), {
      code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
    });
    const read = await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    assert.deepEqual(read.session.turns[0], {
      id: read.session.turns[0].id,
      status: "interrupted",
      errorCode: "ANTIGRAVITY_STREAM_RESULT_MISSING",
      itemsView: "full",
      items: [],
    });
    behavior.onTurnInput = null;
    await runtime.turnStart({
      ...input,
      operationId: "operation-after-unknown",
      prompt: "continue without replaying the prior operation",
    });
    await waitFor(
      () => runtime.host.ledger.snapshot().sessions[0].turns[1]?.status === "completed",
      "operation after unknown turn completion",
    );
    assert.equal(value.spawns.filter((entry) => entry.command === "/bin/sh").length, 2);
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("stopping during version discovery fences initialization and reaps the control process", async () => {
  const value = fixture({ holdVersion: true });
  try {
    const acquiring = value.adapter.acquire({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    }, {
      workspace: value.workspace,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    await waitFor(() => value.spawns.some((entry) => entry.args[0] === "--version"),
      "version process spawn");
    await value.adapter.stop({
      runtime: "antigravity",
      runtimeProfileId: "antigravity-main",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    });
    await assert.rejects(acquiring, { code: "RUNTIME_HOST_TERMINATED" });
    assert.equal(value.children.every((child) => child.closed), true);
    assert.equal(value.pool.entries.size, 0);
  } finally {
    value.cleanup();
  }
});

test("Antigravity catalog SWR unblocks known models, coalesces refresh, and still validates unknown models", async () => {
  let now = 1_000, hold = false;
  const held = [];
  const value = fixture({ now: () => now, onControl(child, args) {
    if (args[0] === "models" && hold) { held.push(child); return true; }
    return false;
  } });
  const binding = { runtime: "antigravity", runtimeProfileId: "catalog-swr", runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID };
  try {
    const runtime = await value.adapter.acquire(binding, { workspace: value.workspace });
    await runtime.modelsList();
    now += 6 * 60_000; hold = true;
    const first = await runtime.sessionStart({ source: "known-one", cwd: value.workspace, model: "gemini-3.7-flash-high" });
    const second = await runtime.sessionStart({ source: "known-two", cwd: value.workspace, model: "gemini-3.7-pro-high" });
    assert.notEqual(first.session.id, second.session.id);
    await waitFor(() => held.length === 1, "one shared refresh");
    let unknownSettled = false;
    const unknown = runtime.sessionStart({ source: "unknown", cwd: value.workspace, model: "not-in-catalog" })
      .finally(() => { unknownSettled = true; });
    const rejection = assert.rejects(unknown, { code: "RUNTIME_MODEL_UNAVAILABLE" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unknownSettled, false, "unknown models must await real catalog validation");
    assert.equal(held.length, 1);
    held[0].stdout.write("gemini-3.7-flash-high\tFlash\ngemini-3.7-pro-high\tPro\n"); held[0].finish(0);
    await rejection;
    assert.equal(runtime.host.ledger.snapshot().sessions.length, 2);
    assert.equal(value.spawns.filter((entry) => entry.args[0] === "models").length, 2);
    assert.equal(value.bindings.length, 0, "catalog refresh never receives an MCP gate");
  } finally { await value.pool.stopAll(); value.cleanup(); }
});

test("Antigravity catalog identity changes wait for fresh data and auth failure invalidates previous models", async () => {
  let hold = false;
  const held = [];
  const value = fixture({ onControl(child, args) {
    if (args[0] === "models" && hold) { held.push(child); return true; }
    return false;
  } });
  try {
    const runtime = await value.adapter.acquire({ runtime: "antigravity", runtimeProfileId: "catalog-auth",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID }, { workspace: value.workspace });
    await runtime.modelsList();
    const authPath = path.join(runtime.host.runtimeEnvironment.nativeHome, "oauth_creds.json");
    fs.mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(authPath, '{"fixture":"new-account-generation"}', { mode: 0o600 });
    hold = true;
    let settled = false;
    const opening = runtime.sessionStart({ source: "changed-identity", cwd: value.workspace, model: "gemini-3.7-flash-high" })
      .finally(() => { settled = true; });
    const rejected = assert.rejects(opening, { code: "AUTH_REQUIRED" });
    await waitFor(() => held.length === 1, "identity refresh");
    assert.equal(settled, false, "old account catalog cannot authorize the new identity");
    held[0].stderr.write("authentication required"); held[0].finish(1);
    await rejected;
    assert.equal(runtime.host.profileState.authenticated, false);
    assert.equal(runtime.host.profileState.models, null);
    assert.equal(runtime.host.ledger.snapshot().sessions.length, 0);
    assert.equal(value.spawns.filter((entry) => entry.args[0] === "models").length, 2, "authentication failure is not retried");
  } finally { await value.pool.stopAll(); value.cleanup(); }
});

test("Antigravity catalog fences invalidated replies and retries only that read once", async () => {
  const held = [];
  const value = fixture({ onControl(child, args) {
    if (args[0] === "models") { held.push(child); return true; }
    return false;
  } });
  try {
    const runtime = await value.adapter.acquire({ runtime: "antigravity", runtimeProfileId: "catalog-generation",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID }, { workspace: value.workspace });
    const listing = runtime.modelsList();
    await waitFor(() => held.length === 1, "first catalog");
    runtime.host.modelCatalogCache.invalidate();
    held[0].stdout.write("obsolete\tObsolete\n"); held[0].finish(0);
    await waitFor(() => held.length === 2, "safe read retry");
    held[1].stdout.write("current\tCurrent\n"); held[1].finish(0);
    assert.deepEqual((await listing).data.map((model) => model.model), ["current"]);
    assert.deepEqual(runtime.host.profileState.models.map((model) => model.model), ["current"]);
    assert.equal(value.spawns.filter((entry) => entry.args[0] === "models").length, 2);
  } finally { await value.pool.stopAll(); value.cleanup(); }
});

test("native terminal approval signal crosses the production Host and Adapter and interruption clears it", async () => {
  const { AntigravityNativeTerminal } = require("../app/agent-service/antigravity-native-terminal");
  const value = fixture();
  let terminal, onExit, requestContext, requestParams;
  const writes = [];
  try {
    const runtime = await value.adapter.acquire({ runtime: "antigravity", runtimeProfileId: "native-signal",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID }, { workspace: value.workspace });
    runtime.host.nativeApprovalsAvailable = true;
    const nativeConsent = path.join(runtime.host.runtimeEnvironment.nativeHome, "antigravity-cli", "cache", "onboarding.json");
    fs.mkdirSync(path.dirname(nativeConsent), { recursive: true, mode: 0o700 });
    fs.writeFileSync(nativeConsent, '{"onboardingComplete":true}', { mode: 0o600 });
    runtime.host.nativeTerminalFactory = async (options) => {
      terminal = await AntigravityNativeTerminal.launch({ ...options,
        spawnPty: () => ({ pid: 70_777, write: (data) => writes.push(data), onData() {}, onExit(callback) { onExit = callback; } }),
        killProcessGroup: (_pid, signal) => queueMicrotask(() => onExit({ exitCode: 0, signal: signal === "SIGINT" ? 2 : 9 })),
      });
      clearInterval(terminal.timer);
      return terminal;
    };
    runtime.registerServerRequestHandler("item/commandExecution/requestApproval", (params, context) => {
      requestParams = params; requestContext = context;
      return new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ decision: "cancel" }), { once: true }));
    });
    const session = (await runtime.sessionStart({ source: "signal", cwd: value.workspace, model: "gemini-3.7-flash-high" })).session;
    const turnStarting = runtime.turnStart({ sessionId: session.id, operationId: "signal-turn", prompt: "read fixture", cwd: value.workspace });
    await waitFor(() => terminal?.ready && terminal.prompt, "bound launch barrier and input");
    terminal._state({ cwd: value.workspace, conversation_id: "conversation-signal", agent_state: "working" });
    terminal._record({ step_index: 0, type: "USER_INPUT", content: `<USER_REQUEST>\n${terminal.prompt}\n</USER_REQUEST>` });
    const turn = (await turnStarting).turn;
    terminal._state({ cwd: value.workspace, conversation_id: "conversation-signal", agent_state: "tool_use", tool_confirmation_pending: true });
    await new Promise((resolve) => terminal.terminal.write("\x1b[2J\x1b[HRead URL\r\nhttps://example.invalid/\r\n> 1. Yes, allow once\r\n  2. No, cancel\r\n↑/↓ Navigate", resolve));
    terminal._checkApproval();
    await waitFor(() => requestContext, "request through Host and Adapter");
    assert.equal(requestContext.signal, terminal.pending.controller.signal);
    assert.equal(requestContext.sourceMethod, "native/approval");
    assert.equal(requestParams.sessionId, session.id);
    assert.equal(requestParams.turnId, turn.id);
    assert.equal(runtime.host.activeTurns.get(session.id).promptTimer, null);
    await runtime.turnInterrupt({ sessionId: session.id, turnId: turn.id });
    assert.equal(requestContext.signal.aborted, true);
    assert.equal(terminal.pending, null);
    assert.equal(terminal.approvalTimer, null);
    assert.equal(runtime.host.activeTurns.size, 0);
    assert.equal(value.revocations.length, 1);
    assert.deepEqual(writes, ["go\n"], "interruption never writes a grant to the native menu");
  } finally {
    if (terminal && !terminal.closed) { terminal.closed = true; terminal.dispose(); }
    await value.pool.stopAll(); value.cleanup();
  }
});

test("default-model sessions start, resume and send without a catalog dependency", async () => {
  const value = fixture({ onControl(_child, args) {
    assert.notEqual(args[0], "models", "the CLI resolves its own default model");
    return false;
  } });
  try {
    const runtime = await value.adapter.acquire({ runtime: "antigravity", runtimeProfileId: "default-model",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID }, { workspace: value.workspace });
    const { readRuntimeAuthenticationState } = require("../app/agent-service/runtime-adapter");
    assert.deepEqual(await readRuntimeAuthenticationState(runtime, { allowDeferred: true }), { status: "unverified" });
    const session = (await runtime.sessionStart({ source: "default-model", cwd: value.workspace })).session;
    await runtime.sessionResume({ sessionId: session.id, cwd: value.workspace });
    await runtime.turnStart({ sessionId: session.id, operationId: "default-turn", prompt: "hello", cwd: value.workspace });
    await waitFor(() => runtime.host.ledger.snapshot().sessions[0].turns[0]?.status === "completed", "default-model reply");
    assert.equal(value.spawns.filter((entry) => entry.args[0] === "models").length, 0);
  } finally { await value.pool.stopAll(); value.cleanup(); }
});

test("native eligibility rejection is durable failed, releases busy state, and is not replayed", async () => {
  const { AntigravityNativeTerminal } = require("../app/agent-service/antigravity-native-terminal");
  const value = fixture();
  let terminal, onExit;
  try {
    const runtime = await value.adapter.acquire({ runtime: "antigravity", runtimeProfileId: "native-rejection",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID }, { workspace: value.workspace });
    runtime.host.nativeApprovalsAvailable = true;
    runtime.host.acceptanceTimeoutMs = 100;
    runtime.host.nativeStartupTimeoutMs = 1_000;
    const nativeConsent = path.join(runtime.host.runtimeEnvironment.nativeHome, "antigravity-cli", "cache", "onboarding.json");
    fs.mkdirSync(path.dirname(nativeConsent), { recursive: true, mode: 0o700 });
    fs.writeFileSync(nativeConsent, '{"onboardingComplete":true}', { mode: 0o600 });
    let launches = 0;
    runtime.host.nativeTerminalFactory = async (options) => {
      launches += 1;
      terminal = await AntigravityNativeTerminal.launch({ ...options,
        spawnPty: () => ({ pid: 70_778, write() {}, onData() {}, onExit(callback) { onExit = callback; } }),
        killProcessGroup: () => queueMicrotask(() => onExit({ exitCode: 0, signal: 9 })),
      });
      clearInterval(terminal.timer); return terminal;
    };
    const session = (await runtime.sessionStart({ source: "rejection", cwd: value.workspace })).session;
    const input = { sessionId: session.id, operationId: "rejection-turn", prompt: "no tools", cwd: value.workspace };
    const starting = runtime.turnStart(input);
    const rejected = assert.rejects(starting, { code: "ANTIGRAVITY_NETWORK_UNAVAILABLE" });
    await waitFor(() => terminal?.ready && terminal.prompt, "native launch");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(runtime.host.activeTurns.size, 1, "startup does not consume the post-submit acceptance budget");
    terminal.sent = true;
    terminal.options.onInputSubmitted();
    fs.appendFileSync(terminal.logPath, "W0923 10:07:36.660092     450 conversation_manager.go:694] Not sending user message: Eligibility check failed: net/http: TLS handshake timeout\n");
    try { terminal._readInputRejection(); } catch (error) { terminal._fail(error); }
    await rejected;
    const turn = runtime.host.ledger.snapshot().sessions[0].turns[0];
    assert.equal(turn.status, "failed"); assert.equal(turn.acceptance, "failed");
    assert.equal(turn.errorCode, "ANTIGRAVITY_NETWORK_UNAVAILABLE");
    assert.equal(runtime.host.activeTurns.size, 0);
    assert.equal(value.revocations.length, 1);
    await assert.rejects(runtime.turnStart(input), { code: "ANTIGRAVITY_NETWORK_UNAVAILABLE" });
    assert.equal(launches, 1, "the failed operation is never automatically replayed");
  } finally {
    if (terminal && !terminal.closed) { terminal.closed = true; terminal.dispose(); }
    await value.pool.stopAll(); value.cleanup();
  }
});

test("native startup has its own deadline and only unsent input is definitely rejected", async () => {
  const value = fixture();
  try {
    const runtime = await value.adapter.acquire({ runtime: "antigravity", runtimeProfileId: "native-startup",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID }, { workspace: value.workspace });
    const session = (await runtime.sessionStart({ source: "startup", cwd: value.workspace })).session;
    let active;
    runtime.host._spawnTurn = async (value) => {
      active = value;
      active.nativeTerminal = true;
      active.child = { sent: false };
    };
    for (const sent of [false, true]) {
      const starting = runtime.turnStart({ sessionId: session.id, operationId: `startup-${sent}`, prompt: "hello", cwd: value.workspace });
      const code = sent ? "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" : "ANTIGRAVITY_STARTUP_TIMEOUT";
      const rejected = assert.rejects(starting, { code });
      await waitFor(() => active?.child, "turn allocation");
      active.child.sent = sent;
      runtime.host._acceptanceTimedOut(active);
      await rejected;
      const turn = runtime.host.ledger.snapshot().sessions[0].turns.at(-1);
      assert.equal(turn.acceptance, sent ? "unknown" : "failed");
      assert.equal(turn.status, sent ? "interrupted" : "failed");
      active = null;
    }
  } finally { await value.pool.stopAll(); value.cleanup(); }
});
