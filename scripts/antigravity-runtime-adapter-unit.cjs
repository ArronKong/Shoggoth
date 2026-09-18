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
    reserveMcpServer() {
      reservationSequence += 1;
      const reservationId = reservationSequence.toString(16).padStart(64, "0");
      return {
        reservationId,
        name: "shoggoth",
        command: binaryPath,
        args: ["bootstrap", "--shoggoth-internal-role=mcp"],
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
  fs.rmSync(trustedRoot, { recursive: true, force: true });
});

test("legacy ledger drops the default-project conversation binding exactly once", () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-antigravity-ledger-"));
  fs.chmodSync(trustedRoot, 0o700);
  const stateRoot = path.join(trustedRoot, "state", "runtime-ledgers", "antigravity");
  const runtimeProfileId = "antigravity-main";
  const workspaceShardId = "a".repeat(64);
  const runtimeRoot = path.join(stateRoot, runtimeProfileId, workspaceShardId);
  const ledgerPath = path.join(runtimeRoot, "runtime-ledger.json");
  const workspace = path.join(trustedRoot, "workspace");
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    schemaVersion: 1,
    runtime: "antigravity",
    runtimeProfileId,
    workspaceShardId,
    sessions: [{
      id: "antigravity-session-legacy",
      remoteConversationId: "legacy-default-project-conversation",
      source: "chat:legacy",
      cwd: workspace,
      title: null,
      archived: false,
      lastUsage: {
        inputTokens: 100,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 3,
        totalTokens: 120,
      },
      createdAt: 1,
      updatedAt: 2,
      turns: [{
        id: "antigravity-turn-legacy",
        operationId: "operation-legacy",
        fingerprint: "b".repeat(64),
        acceptance: "accepted",
        status: "completed",
        errorCode: null,
        assistantMessages: [{ id: "message-legacy", text: "旧会话回答" }],
        responseId: null,
        createdAt: 1,
        updatedAt: 2,
      }],
    }],
  })}\n`, { mode: 0o600 });

  try {
    const migrated = new AntigravityRuntimeLedger({
      stateRoot,
      trustedRoot,
      runtimeProfileId,
      workspaceShardId,
    }).open();
    assert.equal(ANTIGRAVITY_LEDGER_SCHEMA_VERSION, 2);
    assert.equal(migrated.snapshot().schemaVersion, 2);
    assert.equal(migrated.snapshot().sessions[0].remoteConversationId, null);
    assert.deepEqual(migrated.snapshot().sessions[0].lastUsage, emptyAntigravityUsage());
    assert.equal(migrated.snapshot().sessions[0].turns[0].assistantMessages[0].text,
      "旧会话回答");
    assert.deepEqual({
      source: migrated.snapshot().sessions[0].source,
      title: migrated.snapshot().sessions[0].title,
      archived: migrated.snapshot().sessions[0].archived,
      createdAt: migrated.snapshot().sessions[0].createdAt,
      updatedAt: migrated.snapshot().sessions[0].updatedAt,
      operationId: migrated.snapshot().sessions[0].turns[0].operationId,
      fingerprint: migrated.snapshot().sessions[0].turns[0].fingerprint,
      status: migrated.snapshot().sessions[0].turns[0].status,
    }, {
      source: "chat:legacy",
      title: null,
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      operationId: "operation-legacy",
      fingerprint: "b".repeat(64),
      status: "completed",
    });
    const persistedMigration = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    assert.equal(persistedMigration.schemaVersion, 2);
    assert.equal(persistedMigration.sessions[0].remoteConversationId, null);
    assert.deepEqual(persistedMigration.sessions[0].lastUsage, emptyAntigravityUsage());
    const reboundUsage = {
      inputTokens: 50,
      outputTokens: 10,
      reasoningOutputTokens: 2,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 1,
      totalTokens: 60,
    };
    migrated.update((data) => {
      data.sessions[0].remoteConversationId = "project-aware-conversation";
      data.sessions[0].lastUsage = reboundUsage;
    });

    const reopened = new AntigravityRuntimeLedger({
      stateRoot,
      trustedRoot,
      runtimeProfileId,
      workspaceShardId,
    }).open();
    assert.equal(reopened.snapshot().sessions[0].remoteConversationId,
      "project-aware-conversation");
    assert.deepEqual(reopened.snapshot().sessions[0].lastUsage, reboundUsage);

    const invalidShardId = "c".repeat(64);
    const invalidRoot = path.join(stateRoot, runtimeProfileId, invalidShardId);
    const invalidPath = path.join(invalidRoot, "runtime-ledger.json");
    const invalidLegacy = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    invalidLegacy.schemaVersion = 1;
    invalidLegacy.workspaceShardId = invalidShardId;
    invalidLegacy.sessions[0].remoteConversationId = "invalid\0conversation";
    fs.mkdirSync(invalidRoot, { recursive: true, mode: 0o700 });
    const invalidBytes = `${JSON.stringify(invalidLegacy)}\n`;
    fs.writeFileSync(invalidPath, invalidBytes, { mode: 0o600 });
    assert.throws(() => new AntigravityRuntimeLedger({
      stateRoot,
      trustedRoot,
      runtimeProfileId,
      workspaceShardId: invalidShardId,
    }).open(), { code: "ANTIGRAVITY_LEDGER_INVALID" });
    assert.equal(fs.readFileSync(invalidPath, "utf8"), invalidBytes);
  } finally {
    fs.rmSync(trustedRoot, { recursive: true, force: true });
  }
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
