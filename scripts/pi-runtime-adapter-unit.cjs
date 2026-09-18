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
const { PiRuntimeAdapter, PI_CAPABILITIES } = require(path.join(
  ROOT, "app", "agent-service", "pi-runtime-adapter.js",
));
const { PiRuntimePool } = require(path.join(ROOT, "app", "agent-service", "pi-runtime-pool.js"));
const { PiRuntimeLedger, emptyPiUsage } = require(path.join(
  ROOT, "app", "agent-service", "pi-runtime-ledger.js",
));
const { readRuntimeAuthenticationState } = require(path.join(
  ROOT, "app", "agent-service", "runtime-adapter.js",
));
const { PiRpcJsonlDecoder, encodePiRpcCommand } = require(path.join(
  ROOT, "app", "agent-service", "pi-rpc-jsonl.js",
));
const {
  DEFAULT_PI_PERMISSION_POLICY,
  buildPiRpcArgs,
  parsePiModelRef,
  parsePiVersion,
  preparePiHome,
  resolvePiLaunch,
  supportsPiVersion,
} = require(path.join(ROOT, "app", "agent-service", "pi-runtime-paths.js"));
const {
  NATIVE_PI_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));

const PI_BINDING = Object.freeze({
  runtime: "pi",
  runtimeProfileId: "pi-main",
  runtimeAccountId: NATIVE_PI_RUNTIME_ACCOUNT_ID,
});

let nextPid = 72_000;

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
        const text = chunk.toString("utf8");
        this.input += text;
        options.onInput?.(this, text);
        callback();
      },
      final: (callback) => {
        callback();
        options.onInputEnd?.(this);
      },
    });
    this.stdio = options.turn ? [
      this.stdin,
      this.stdout,
      this.stderr,
      new Writable({
        write: (chunk, _encoding, callback) => {
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

function rpcModel() {
  return {
    id: "gpt-5.6",
    name: "GPT-5.6",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    contextWindow: 128000,
    maxTokens: 32000,
  };
}

function rpcFixture(behavior = {}) {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-pi-"));
  fs.chmodSync(trustedRoot, 0o700);
  const binDir = path.join(trustedRoot, "bin");
  const workspace = path.join(trustedRoot, "workspace");
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  const nativeHome = path.join(fs.realpathSync(trustedRoot), ".pi", "agent");
  fs.mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
  const binaryCandidate = path.join(binDir, "pi");
  fs.writeFileSync(binaryCandidate, behavior.nodeShebang ? "#!/usr/bin/env node\n" : "fixture\n", {
    mode: 0o700,
  });
  const binaryPath = fs.realpathSync(binaryCandidate);
  const nodeCandidate = path.join(binDir, "node");
  if (behavior.nodeShebang) fs.writeFileSync(nodeCandidate, "fixture\n", { mode: 0o700 });
  const nodePath = behavior.nodeShebang ? fs.realpathSync(nodeCandidate) : null;
  const extensionPath = path.join(trustedRoot, "shoggoth-pi-extension.mjs");
  fs.writeFileSync(extensionPath, "export default function () {}\n", { mode: 0o600 });
  const spawns = [];
  const bindings = [];
  const reservations = [];
  const revocations = [];
  const groupKills = [];
  const children = [];
  let reservationSequence = 0;
  const mcpGateIssuer = {
    reserveMcpServer(input) {
      reservations.push(input);
      reservationSequence += 1;
      const reservationId = reservationSequence.toString(16).padStart(64, "0");
      return {
        reservationId,
        name: "shoggoth",
        command: binaryPath,
        args: ["bootstrap", "--shoggoth-internal-role=mcp"],
        env: [{ name: "SHOGGOTH_RUNTIME_MCP_GATE_NONCE", value: reservationId }],
      };
    },
    bindMcpServer(input) { bindings.push(input); return { bound: true }; },
    revokeMcpServer(input) { revocations.push(input); return { revoked: true }; },
  };

  function rpcChild(options, { turn = false, sessionId = "control", sessionDir = trustedRoot } = {}) {
    let buffered = "";
    const messages = [];
    let prompted = false;
    let confirmationSent = false;
    const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
    const child = new FakeChild({
      turn,
      onInput(current, text) {
        buffered += text;
        let newline;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          const command = JSON.parse(line);
          if (command.type === "get_state") {
            if (turn && behavior.holdState) continue;
            if (turn && behavior.closeBeforeState) {
              current.finish(1);
              continue;
            }
            current.send({
              id: command.id,
              type: "response",
              command: "get_state",
              success: true,
              data: {
                model: behavior.noModels ? null : rpcModel(),
                thinkingLevel: "medium",
                isStreaming: prompted,
                isCompacting: false,
                steeringMode: "all",
                followUpMode: "one-at-a-time",
                sessionFile,
                sessionId,
                autoCompactionEnabled: true,
                messageCount: messages.length,
                pendingMessageCount: 0,
              },
            });
          } else if (command.type === "get_available_models") {
            current.send({
              id: command.id,
              type: "response",
              command: "get_available_models",
              success: true,
              data: { models: behavior.noModels ? [] : [rpcModel()] },
            });
          } else if (["get_commands", "compact", "get_available_thinking_levels", "set_thinking_level", "get_session_stats"].includes(command.type)) {
            const data = command.type === "get_commands" ? { commands: [
              { name: "skill:project-check", description: "Check this workspace", source: "skill" },
              { name: "project-summary", description: "Summarize changes", source: "prompt" },
            ] } : command.type === "compact" ? { tokensBefore: 100 }
              : command.type === "get_available_thinking_levels" ? { levels: ["medium", "high"] }
                : command.type === "get_session_stats" ? { sessionId, messageCount: 0 } : {};
            current.send({ id: command.id, type: "response", command: command.type, success: true, data });
          } else if (command.type === "prompt") {
            prompted = true;
            messages.push({ role: "user", content: command.message, timestamp: 1 });
            if (behavior.closeAfterPrompt) {
              current.finish(1);
              continue;
            }
            if (behavior.holdPromptAck) continue;
            current.send({ id: command.id, type: "response", command: "prompt", success: true });
            queueMicrotask(() => {
              current.send({ type: "message_start", message: { role: "assistant", content: [] } });
              current.send({
                type: "message_update",
                usage: rpcModel().usage,
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "完成" },
              });
              current.send({
                type: "tool_execution_start",
                toolCallId: "tool-one",
                toolName: "web_search",
                args: { query: "native agent trajectory" },
              });
              current.send({
                type: "tool_execution_end",
                toolCallId: "tool-one",
                toolName: "web_search",
                result: { content: [{ type: "text", text: "3 results" }] },
                isError: false,
              });
              if (behavior.requestConfirmation || behavior.requestProductConfirmation) {
                confirmationSent = true;
                current.send(behavior.requestProductConfirmation ? {
                  type: "extension_ui_request",
                  id: "product-confirmation-one",
                  method: "select",
                  title: "[[shoggoth-product-confirmation]]确认修改",
                  options: ["确认执行", "取消"],
                } : {
                  type: "extension_ui_request",
                  id: "confirmation-one",
                  method: "confirm",
                  title: "Allow Pi edit?",
                  message: "edit file",
                });
                return;
              }
              settle(current);
            });
          } else if (command.type === "extension_ui_response") {
            if (confirmationSent) settle(current);
          } else if (command.type === "get_messages") {
            current.send({
              id: command.id,
              type: "response",
              command: "get_messages",
              success: true,
              data: { messages },
            });
          } else if (command.type === "steer") {
            current.send({ id: command.id, type: "response", command: "steer", success: true });
          } else if (command.type === "clear_queue") {
            current.send({
              id: command.id,
              type: "response",
              command: "clear_queue",
              success: true,
              data: { steering: [], followUp: [] },
            });
          } else if (command.type === "abort") {
            current.send({ id: command.id, type: "response", command: "abort", success: true });
            current.send({ type: "agent_settled" });
          }
        }
      },
      onInputEnd(current) {
        if (!turn || !behavior.lingerAfterSettledTurn) current.finish(0);
      },
    });
    function settle(current) {
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "完成" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6",
        responseId: "pi-response-one",
        usage: {
          input: 100,
          output: 5,
          cacheRead: 10,
          cacheWrite: 2,
          reasoning: 2,
          totalTokens: 105,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: behavior.assistantError ? "error" : "stop",
        ...(behavior.assistantError ? { errorMessage: behavior.assistantError } : {}),
        timestamp: 2,
      };
      messages.push(assistant);
      current.send({ type: "message_end", message: assistant });
      current.send({ type: "agent_settled" });
    }
    return child;
  }

  const spawnProcess = (command, args, options) => {
    let child;
    if (command === binaryPath && args[0] === "--version") {
      child = new FakeChild({ ignoreInput: true });
      queueMicrotask(() => {
        child.stdout.write(`${behavior.version || "0.84.4"}\n`);
        child.finish(0);
      });
    } else if (command === binaryPath && args[0] === "auth") {
      child = new FakeChild({ ignoreInput: true });
      queueMicrotask(() => {
        child.stdout.write('{"status":"ready","provider":"openai"}\n');
        child.finish(0);
      });
    } else if (command === binaryPath) {
      child = rpcChild(options);
    } else {
      const binaryIndex = args.indexOf(binaryPath);
      const piArgs = args.slice(binaryIndex + 1);
      const sessionId = piArgs[piArgs.indexOf("--session-id") + 1];
      const sessionDir = piArgs[piArgs.indexOf("--session-dir") + 1];
      child = rpcChild(options, { turn: true, sessionId, sessionDir });
    }
    children.push(child);
    if (behavior.ignoreKill && command === "/bin/sh") child.kill = () => false;
    spawns.push({ command, args, options, child });
    return child;
  };
  const pool = new PiRuntimePool({
    paths: { stateDir: path.join(trustedRoot, "state"), trustedRoot },
    binaryPath,
    extensionPath,
    homedir: trustedRoot,
    parentEnv: { PATH: binDir, LANG: "C.UTF-8", SECRET_TOKEN: "must-not-leak" },
    spawnProcess,
    mcpGateIssuer,
    acceptanceTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    promptTimeoutMs: behavior.promptTimeoutMs || 2_000,
    shutdownGraceMs: 100,
    killGraceMs: 100,
    killProcessGroup(pid, signal) {
      groupKills.push({ pid, signal });
      if (behavior.ignoreKill) return;
      children.find((child) => child.pid === pid)?.finish(0, signal);
    },
  });
  return {
    adapter: new PiRuntimeAdapter({ runtimePool: pool }),
    binaryPath,
    bindings,
    children,
    groupKills,
    nodePath,
    nativeHome,
    pool,
    reservations,
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

test("strict Pi JSONL and version/model helpers reject malformed input", () => {
  const decoder = new PiRpcJsonlDecoder({ maxFrameBytes: 1024, maxStreamBytes: 4096 });
  assert.deepEqual(decoder.push('{"type":"agent_settled"}\n'), [{ type: "agent_settled" }]);
  assert.deepEqual(decoder.finish(), []);
  assert.equal(encodePiRpcCommand({ type: "get_state" }), '{"type":"get_state"}\n');
  assert.throws(() => new PiRpcJsonlDecoder({
    maxFrameBytes: 1024,
    maxStreamBytes: 1024,
  }).push("x".repeat(1025)), { code: "PI_RPC_STREAM_TOO_LARGE" });
  const malformedUtf8 = Buffer.concat([
    Buffer.from('{"type":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n'),
  ]);
  assert.throws(() => new PiRpcJsonlDecoder({
    maxFrameBytes: 1024,
    maxStreamBytes: 4096,
  }).push(malformedUtf8), { code: "PI_RPC_FRAME_INVALID" });
  assert.deepEqual(parsePiVersion("0.84.4\n"), [0, 84, 4]);
  assert.equal(supportsPiVersion("0.84.3"), false);
  assert.equal(supportsPiVersion("0.84.4"), true);
  assert.equal(supportsPiVersion("0.85.0"), false);
  assert.deepEqual(parsePiModelRef("openrouter/anthropic/claude-sonnet"), {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet",
  });
});

test("Pi args retain skill/template discovery, isolate extensions and map tool permissions", () => {
  assert.deepEqual(DEFAULT_PI_PERMISSION_POLICY, {
    approvalPolicy: "on-request",
    sandbox: "danger-full-access",
  });
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-pi-paths-"));
  fs.chmodSync(trustedRoot, 0o700);
  const home = preparePiHome({ stateDir: path.join(trustedRoot, "state"), trustedRoot }, "pi-main");
  const args = buildPiRpcArgs({
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    sessionId: "11111111-1111-4111-8111-111111111111",
    sessionDir: path.join(home, "sessions"),
    extensionPath: path.join(trustedRoot, "extension.mjs"),
    model: "openai/gpt-5.6",
  });
  assert.ok(args.includes("--no-extensions"));
  assert.equal(args.includes("--no-skills"), false);
  assert.equal(args.includes("--no-prompt-templates"), false);
  assert.equal(args[args.indexOf("--exclude-tools") + 1], "bash,powershell");
  assert.equal(args[args.indexOf("--provider") + 1], "openai");
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6");
  fs.rmSync(trustedRoot, { recursive: true, force: true });
});

test("Pi discovers workspace commands and executes built-ins as RPC, skills as raw commands", async () => {
  const value = rpcFixture();
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, { workspace: value.workspace, permissionPolicy });
    assert.equal(runtime.capabilities["commands.list"], true);
    assert.equal(runtime.capabilities["commands.execute"], true);
    const catalog = await runtime.commandsList({ cwd: value.workspace });
    assert.equal(catalog.commands.find((command) => command.name === "skill:project-check").source, "Pi skill");
    assert.equal(catalog.commands.find((command) => command.name === "tree").execution, "cli");
    const discovery = value.spawns.find((entry) => entry.child.input.includes('"get_commands"'));
    assert.equal(discovery.options.cwd, value.workspace);
    assert.equal(discovery.args.includes("--no-skills"), false);
    assert.equal(discovery.args.includes("--no-extensions"), true);
    await assert.rejects(runtime.commandExecute({ text: "/tree" }), { code: "RUNTIME_COMMAND_CLI_ONLY" });
    const started = await runtime.sessionStart({
      source: "chat:commands", developerInstructions: "Keep changes scoped.",
      model: "openai/gpt-5.6", cwd: value.workspace, permissionPolicy,
    });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    for (const [index, prompt] of ["/compact preserve APIs", "/thinking high", "/session", "/skill:project-check src"].entries()) {
      assert.equal((await runtime.commandExecute({ sessionId: started.session.id, cwd: value.workspace, text: prompt })).text, prompt);
      const result = await runtime.turnStart({
        sessionId: started.session.id, operationId: `command-${index}`, prompt,
        context: "Check only this workspace.", model: "openai/gpt-5.6", cwd: value.workspace, permissionPolicy,
      });
      await waitFor(() => events.some((event) => event.type === "complete" && event.turnId === result.turn.id), "command completion");
      const turnSpawn = value.spawns.filter((entry) => entry.command === "/bin/sh").at(-1);
      const inputs = turnSpawn.child.input.trim().split("\n").map((line) => JSON.parse(line));
      if (index < 3) assert.equal(inputs.some((input) => input.type === "prompt"), false, "built-ins cannot become model prompts");
      else assert.equal(inputs.find((input) => input.type === "prompt").message, prompt, "skill invocation must stay at the start");
      if (index === 0) assert.equal(inputs.find((input) => input.type === "compact").customInstructions, "preserve APIs");
      if (index === 1) assert.equal(inputs.find((input) => input.type === "set_thinking_level").level, "high");
      const contextPath = turnSpawn.args[turnSpawn.args.indexOf("--append-system-prompt") + 1];
      assert.match(contextPath, /\.shoggoth-command-/);
      assert.equal(fs.existsSync(contextPath), false, "private command context must be cleaned after completion");
    }
    await value.adapter.stopAll();
  } finally { value.cleanup(); }
});

test("Node-script Pi turns bind and launch through the resolved Node executable", async () => {
  const value = rpcFixture({ nodeShebang: true });
  try {
    const launch = resolvePiLaunch(value.binaryPath, {
      fs,
      parentEnv: { PATH: path.dirname(value.binaryPath) },
      homedir: value.trustedRoot,
    });
    assert.deepEqual(launch, {
      command: value.nodePath,
      argsPrefix: [value.binaryPath],
    });
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy,
    });
    const started = await runtime.sessionStart({
      source: "chat:node-launch",
      developerInstructions: "",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-node-launch",
      prompt: "verify launch",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    const turnSpawn = value.spawns.find((entry) => entry.command === "/bin/sh");
    const nodeIndex = turnSpawn.args.indexOf(value.nodePath);
    assert.notEqual(nodeIndex, -1);
    assert.equal(turnSpawn.args[nodeIndex + 1], value.binaryPath);
    assert.equal(value.reservations[0].parentExecutable, value.nodePath);
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("Pi ledger repairs only unknown turns that failed before a session file existed", () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-pi-ledger-"));
  fs.chmodSync(trustedRoot, 0o700);
  const options = {
    stateRoot: path.join(trustedRoot, "state"),
    trustedRoot,
    runtimeProfileId: "pi-main",
    workspaceShardId: "a".repeat(64),
  };
  try {
    const ledger = new PiRuntimeLedger({ ...options, now: () => 10 }).open();
    const turn = (id, operationId, fingerprint) => ({
      id,
      operationId,
      fingerprint,
      acceptance: "unknown",
      status: "failed",
      errorCode: "PI_PROCESS_CLOSED",
      executionEndedAt: null,
      assistantMessages: [],
      responseId: null,
      provider: null,
      model: null,
      usage: emptyPiUsage(),
      createdAt: 1,
      updatedAt: 1,
    });
    ledger.update((data) => {
      data.sessions.push({
        id: "pi-session-before-prompt",
        remoteSessionId: "remote-before-prompt",
        sessionFile: null,
        source: "chat:before-prompt",
        cwd: trustedRoot,
        title: null,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        turns: [turn("pi-turn-before-prompt", "operation-before-prompt", "b".repeat(64))],
      }, {
        id: "pi-session-after-prompt",
        remoteSessionId: "remote-after-prompt",
        sessionFile: path.join(trustedRoot, "after-prompt.jsonl"),
        source: "chat:after-prompt",
        cwd: trustedRoot,
        title: null,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        turns: [turn("pi-turn-after-prompt", "operation-after-prompt", "c".repeat(64))],
      });
    });
    const recovered = new PiRuntimeLedger({ ...options, now: () => 20 }).open().snapshot();
    assert.equal(recovered.sessions[0].turns[0].acceptance, "failed");
    assert.equal(recovered.sessions[0].turns[0].errorCode, "PI_PROCESS_CLOSED");
    assert.equal(recovered.sessions[1].turns[0].acceptance, "unknown");
    const legacy = structuredClone(recovered);
    legacy.schemaVersion = 1;
    for (const session of legacy.sessions) {
      for (const stored of session.turns) delete stored.executionEndedAt;
    }
    fs.writeFileSync(ledger.ledgerPath, JSON.stringify(legacy));
    const migrated = new PiRuntimeLedger({ ...options, now: () => 30 }).open().snapshot();
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.sessions[1].turns[0].acceptance, "unknown");
    assert.equal(migrated.sessions[1].turns[0].executionEndedAt, null,
      "migration must not invent process exit evidence");
    assert.equal(JSON.parse(fs.readFileSync(ledger.ledgerPath)).schemaVersion, 2);
    for (const invalid of [-1, 1.5, 100, "20"]) {
      const malformed = structuredClone(migrated);
      malformed.sessions[1].turns[0].executionEndedAt = invalid;
      fs.writeFileSync(ledger.ledgerPath, JSON.stringify(malformed));
      assert.throws(() => new PiRuntimeLedger(options).open(), { code: "PI_LEDGER_INVALID" });
    }
    legacy.sessions[1].turns[0].executionEndedAt = 1;
    fs.writeFileSync(ledger.ledgerPath, JSON.stringify(legacy));
    assert.throws(() => new PiRuntimeLedger(options).open(), { code: "PI_LEDGER_INVALID" });
  } finally {
    fs.rmSync(trustedRoot, { recursive: true, force: true });
  }
});

test("adapter executes durable Pi RPC turn with models, MCP, elicitation and deletion", async () => {
  const value = rpcFixture({ requestConfirmation: true });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy,
    });
    assert.equal(PI_CAPABILITIES["turn.steer"], true);
    assert.equal(PI_CAPABILITIES["session.delete"], true);
    assert.deepEqual(await runtime.authenticationState(), {
      authenticated: true,
      credentialPresent: true,
    });
    const models = await runtime.modelsList();
    assert.equal(models.data[0].model, "openai/gpt-5.6");
    assert.equal(models.data[0].isDefault, true);
    assert.deepEqual(models.data[0].capabilities.thinkingOptions, ["off", "minimal", "low", "medium", "high"]);
    const started = await runtime.sessionStart({
      source: "chat:one",
      developerInstructions: "Keep changes scoped.",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    const requests = [];
    runtime.registerServerRequestHandler("item/fileChange/requestApproval", async (params) => {
      requests.push(params);
      return { decision: "accept" };
    });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    const receipt = await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-one",
      prompt: "修复问题",
      attachments: [require("./fixtures/native-chat-image.cjs")(value.workspace)],
      thinkingLevel: "high",
      context: "只修改相关文件。",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    assert.match(receipt.turn.id, /^pi-turn-/u);
    await waitFor(() => events.some((event) => event.type === "complete"), "Pi turn completion");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].sessionId, started.session.id);
    assert.equal(requests[0].itemId, "confirmation-one");
    assert.equal(requests[0].grantRoot, value.workspace);
    const turnSpawn = value.spawns.find((entry) => entry.command === "/bin/sh");
    assert.ok(turnSpawn);
    assert.equal(turnSpawn.options.env.PI_CODING_AGENT_DIR,
      value.nativeHome);
    assert.equal(turnSpawn.options.env.SECRET_TOKEN, undefined);
    assert.equal(turnSpawn.child.barrier, "go\n");
    const commands = turnSpawn.child.input.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(commands.find(command => command.type === "set_thinking_level").level, "high");
    assert.ok(commands.findIndex(command => command.type === "set_thinking_level") < commands.findIndex(command => command.type === "prompt"));
    const imageInput = turnSpawn.child.input.trim().split("\n").map(line => JSON.parse(line)).find(command => command.type === "prompt").images;
    assert.equal(imageInput.length, 1);
    assert.equal(imageInput[0].mimeType, "image/png");
    assert.equal(imageInput[0].type, "image");
    assert.deepEqual(Buffer.from(imageInput[0].data, "base64"), fs.readFileSync(path.join(value.workspace, "中文 图片.png")));
    assert.equal(value.bindings[0].parentPid, turnSpawn.child.pid);
    assert.ok(value.revocations.length >= 1);
    assert.equal(events.some((event) => event.type === "text_delta"), true);
    assert.deepEqual(events.find((event) => event.type === "tool_start")?.tool, {
      kind: "other",
      name: "web_search",
      status: "in_progress",
      input: { query: "native agent trajectory" },
    });
    assert.deepEqual(events.find((event) => event.type === "tool_result")?.tool, {
      kind: "other",
      name: "web_search",
      status: "completed",
      success: true,
      output: { content: [{ type: "text", text: "3 results" }] },
    });
    assert.equal(events.find((event) => event.type === "usage").usage.totalTokens, 105);
    const read = await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    assert.equal(read.session.turns[0].status, "completed");
    assert.equal(read.session.turns[0].items[1].text, "完成");
    const sessionFile = path.join(
      value.trustedRoot,
      "state",
      "runtime-ledgers",
      "pi",
      "pi-main",
      runtime.host.ledger.workspaceShardId,
      "sessions",
      `${runtime.host.ledger.snapshot().sessions[0].remoteSessionId}.jsonl`,
    );
    fs.writeFileSync(sessionFile, "{}\n", { mode: 0o600 });
    await runtime.sessionDelete({ sessionId: started.session.id });
    assert.equal(fs.existsSync(sessionFile), false);
    const outside = path.join(value.trustedRoot, "outside-sessions");
    fs.mkdirSync(outside, { mode: 0o700 });
    const victim = path.join(outside, "victim.jsonl");
    fs.writeFileSync(victim, "keep\n", { mode: 0o600 });
    const linked = path.join(runtime.host.ledger.sessionDir, "linked");
    fs.symlinkSync(outside, linked);
    assert.throws(() => runtime.host._deleteSessionFile(path.join(linked, "victim.jsonl")), {
      code: "PI_SESSION_DELETE_FAILED",
    });
    assert.equal(fs.readFileSync(victim, "utf8"), "keep\n");
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("Pi permission uses approval semantics and pauses the active turn deadline", async () => {
  const value = rpcFixture({ requestConfirmation: true, promptTimeoutMs: 100 });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy,
    });
    const started = await runtime.sessionStart({
      source: "chat:approval-wait",
      developerInstructions: "",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    let resolveApproval;
    let approvalCalls = 0;
    runtime.registerServerRequestHandler("item/fileChange/requestApproval", async () => {
      approvalCalls += 1;
      return new Promise((resolve) => { resolveApproval = resolve; });
    });
    const completions = [];
    runtime.subscribe((event) => {
      if (event.type === "complete") completions.push(event);
    });
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-approval-wait",
      prompt: "wait",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    await waitFor(() => approvalCalls === 1, "Pi approval handler");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(completions.length, 0);
    resolveApproval({ decision: "accept" });
    await waitFor(() => completions.length === 1, "Pi completion after approval");
    assert.equal(completions[0].status, "completed");
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("Pi product confirmation preserves its field identity and pauses the active turn deadline", async () => {
  const value = rpcFixture({ requestProductConfirmation: true, promptTimeoutMs: 100 });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy,
    });
    const started = await runtime.sessionStart({
      source: "chat:product-confirmation-wait",
      developerInstructions: "",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    let resolveConfirmation;
    let confirmationParams;
    runtime.registerServerRequestHandler("mcpServer/elicitation/request", async (params) => {
      confirmationParams = params;
      return new Promise((resolve) => { resolveConfirmation = resolve; });
    });
    const completions = [];
    runtime.subscribe((event) => {
      if (event.type === "complete") completions.push(event);
    });
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-product-confirmation-wait",
      prompt: "wait",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    await waitFor(() => typeof resolveConfirmation === "function", "Pi product confirmation handler");
    assert.deepEqual(confirmationParams.requestedSchema, {
      type: "object",
      properties: {
        confirm_product_action: {
          type: "string", title: "确认修改", enum: ["确认执行", "取消"],
        },
      },
      required: ["confirm_product_action"],
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(completions.length, 0);
    resolveConfirmation({
      action: "accept", content: { confirm_product_action: "确认执行" },
    });
    await waitFor(() => completions.length === 1, "Pi completion after product confirmation");
    assert.equal(completions[0].status, "completed");
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("unsupported Pi versions fail before an RPC session starts", async () => {
  const value = rpcFixture({ version: "0.85.0" });
  try {
    await assert.rejects(value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    }), { code: "PI_VERSION_UNSUPPORTED" });
    assert.equal(value.spawns.filter((entry) => entry.command === "/bin/sh").length, 0);
  } finally {
    await value.pool.stopAll().catch(() => {});
    value.cleanup();
  }
});

test("authentication state degrades to logged-out before Pi has a model catalog", async () => {
  const value = rpcFixture({ noModels: true });
  try {
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.deepEqual(await runtime.authenticationState(), {
      authenticated: false,
      credentialPresent: false,
    });
    assert.deepEqual(await readRuntimeAuthenticationState(runtime), { status: "unauthenticated" });
    assert.equal(value.spawns.some((entry) => entry.args[0] === "auth"), false);
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("empty Pi auth storage does not bypass the logged-out gate", async () => {
  const value = rpcFixture({ noModels: true });
  try {
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    fs.writeFileSync(path.join(runtime.host.home, "auth.json"), "{}\n", { mode: 0o600 });
    assert.deepEqual(await runtime.authenticationState(), {
      authenticated: false,
      credentialPresent: false,
    });
    assert.deepEqual(await readRuntimeAuthenticationState(runtime), { status: "unauthenticated" });
    fs.writeFileSync(path.join(runtime.host.home, "auth.json"), JSON.stringify({
      openai: { type: "api_key", key: "test-only" },
    }), { mode: 0o600 });
    assert.deepEqual(await runtime.authenticationState(), {
      authenticated: false,
      credentialPresent: true,
    });
    assert.deepEqual(await readRuntimeAuthenticationState(runtime), { status: "unverified" });
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("authentication rejects an unsafe native Pi credential file", async () => {
  const value = rpcFixture();
  try {
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    const credential = path.join(runtime.host.home, "auth.json");
    fs.writeFileSync(credential, '{"token":"test-only"}\n', { mode: 0o644 });
    fs.chmodSync(credential, 0o644);
    await assert.rejects(runtime.authenticationState(), { code: "PI_CREDENTIAL_UNSAFE" });
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("stopping an active Pi turn signals its detached process group", async () => {
  const value = rpcFixture({ requestConfirmation: true });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy,
    });
    const started = await runtime.sessionStart({
      source: "chat:stop",
      developerInstructions: "",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    runtime.registerServerRequestHandler("item/fileChange/requestApproval", () => new Promise(() => {}));
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-stop",
      prompt: "wait",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    await value.adapter.stopAll();
    const turnSpawn = value.spawns.find((entry) => entry.command === "/bin/sh");
    assert.deepEqual(value.groupKills[0], { pid: turnSpawn.child.pid, signal: "SIGTERM" });
  } finally {
    value.cleanup();
  }
});

test("stopping reaps a settled Pi process that ignores stdin EOF", async () => {
  const value = rpcFixture({ lingerAfterSettledTurn: true });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy,
    });
    const started = await runtime.sessionStart({
      source: "chat:lingering",
      developerInstructions: "",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-lingering",
      prompt: "finish but keep the transport open",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    await waitFor(() => events.some((event) => event.type === "complete"), "settled Pi turn");
    const turnSpawn = value.spawns.find((entry) => entry.command === "/bin/sh");
    assert.equal(turnSpawn.child.closed, false);
    assert.equal(runtime.host.activeTurns.size, 0);
    assert.equal(runtime.host.turnProcesses.size, 1);
    await value.adapter.stopAll();
    assert.equal(turnSpawn.child.closed, true);
    assert.equal(value.groupKills.some(({ pid, signal }) => (
      pid === turnSpawn.child.pid && signal === "SIGTERM"
    )), true);
  } finally {
    value.cleanup();
  }
});

test("confirmed process exit releases Pi session without replaying an ambiguous operation", async () => {
  const behavior = { closeAfterPrompt: true };
  const value = rpcFixture(behavior);
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy,
    });
    const started = await runtime.sessionStart({
      source: "chat:unknown",
      developerInstructions: "",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    const input = {
      sessionId: started.session.id,
      operationId: "operation-unknown",
      prompt: "may have been accepted",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    };
    await assert.rejects(runtime.turnStart(input), { code: "PI_PROCESS_CLOSED" });
    await waitFor(() => runtime.host.activeTurns.size === 0, "failed Pi turn");
    await assert.rejects(runtime.turnStart(input), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    await runtime.sessionRead({ sessionId: started.session.id });
    const turn = runtime.host.ledger.snapshot().sessions[0].turns[0];
    assert.equal(turn.acceptance, "unknown");
    assert(Number.isSafeInteger(turn.executionEndedAt));
    assert.equal(value.spawns.filter((entry) => entry.command === "/bin/sh").length, 1);
    await value.adapter.stop(PI_BINDING);
    const restarted = await value.adapter.acquire(PI_BINDING, { workspace: value.workspace, permissionPolicy });
    await restarted.sessionRead({ sessionId: started.session.id });
    await assert.rejects(restarted.turnStart(input), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    behavior.closeAfterPrompt = false;
    await restarted.turnStart({ ...input, operationId: "next-operation", prompt: "continue" });
    await waitFor(() => restarted.host.activeTurns.size === 0, "next Pi turn");
    assert.equal(value.spawns.filter((entry) => entry.command === "/bin/sh").length, 2);
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});

test("Pi surfaces provider authentication errors without locking the conversation", async () => {
  const behavior = {};
  const value = rpcFixture(behavior);
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, { workspace: value.workspace, permissionPolicy });
    const { session } = await runtime.sessionStart({
      source: "chat:auth-failure", cwd: value.workspace, model: "openai/gpt-5.6", permissionPolicy,
    });
    for (const [index, [message, expectedCode]] of [
      ["OAuth refresh failed for xai: xAI OAuth token refresh failed (HTTP 400): invalid_grant: User account is blocked", "RUNTIME_ACCOUNT_BLOCKED"],
      ["OAuth refresh failed: invalid_grant: token expired", "AUTH_REQUIRED"],
      ["429 rate limit exceeded", "PI_TURN_FAILED"],
      [null, undefined],
    ].entries()) {
      behavior.assistantError = message;
      await runtime.authenticationState();
      await runtime.turnStart({ sessionId: session.id, operationId: `auth-check-${index}`, prompt: "check",
        cwd: value.workspace, model: "openai/gpt-5.6", permissionPolicy });
      await waitFor(() => runtime.host.turnProcesses.size === 0, "provider failure exit");
      const read = await runtime.sessionRead({ sessionId: session.id, includeTurns: true });
      assert.equal(read.session.turns[index].errorCode, expectedCode);
      assert.equal(read.session.turns[index].status, message ? "failed" : "completed");
      if (["AUTH_REQUIRED", "RUNTIME_ACCOUNT_BLOCKED"].includes(expectedCode)) assert.equal(runtime.host.profileState.auth, null);
    }
    await value.adapter.stopAll();
  } finally { value.cleanup(); }
});

test("slow startup of an existing Pi session cannot poison it before prompt dispatch", async () => {
  const behavior = {};
  const value = rpcFixture(behavior);
  const keepAlive = setTimeout(() => {}, 3_000);
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const options = { workspace: value.workspace, permissionPolicy };
    const runtime = await value.adapter.acquire(PI_BINDING, options);
    const { session } = await runtime.sessionStart({
      source: "chat:slow-resume", cwd: value.workspace, model: "openai/gpt-5.6", permissionPolicy,
    });
    const input = {
      sessionId: session.id, operationId: "baseline", prompt: "first", cwd: value.workspace,
      model: "openai/gpt-5.6", permissionPolicy,
    };
    await runtime.turnStart(input);
    await waitFor(() => runtime.host.turnProcesses.size === 0, "baseline exit");
    assert(runtime.host.ledger.snapshot().sessions[0].sessionFile);
    behavior.holdState = true;
    behavior.ignoreKill = true;
    behavior.lingerAfterSettledTurn = true;
    runtime.host.acceptanceTimeoutMs = 100;
    await assert.rejects(runtime.turnStart({ ...input, operationId: "slow-start" }), {
      code: "PI_RPC_STARTUP_TIMEOUT",
    });
    const failed = runtime.host.ledger.snapshot().sessions[0].turns[1];
    assert.equal(failed.acceptance, "failed");
    const child = value.spawns.filter((entry) => entry.command === "/bin/sh").at(-1).child;
    assert.equal(child.closed, false);
    await assert.rejects(runtime.turnStart({ ...input, operationId: "before-startup-exit" }), {
      code: "RUNTIME_SESSION_BUSY",
    });
    const stateRequest = child.input.trim().split("\n").map(JSON.parse)
      .find((command) => command.type === "get_state");
    const stored = runtime.host.ledger.snapshot().sessions[0];
    child.send({ id: stateRequest.id, type: "response", command: "get_state", success: true,
      data: { sessionId: stored.remoteSessionId, sessionFile: stored.sessionFile, messageCount: 2 } });
    await new Promise((resolve) => setImmediate(resolve));
    assert(!child.input.includes('"type":"prompt"'), "late startup must never dispatch the failed request");
    child.finish(null, "SIGKILL");
    await waitFor(() => runtime.host.turnProcesses.size === 0, "slow startup exit");
    await value.adapter.stop(PI_BINDING);
    behavior.holdState = false;
    behavior.ignoreKill = false;
    behavior.lingerAfterSettledTurn = false;
    const restarted = await value.adapter.acquire(PI_BINDING, options);
    await restarted.sessionRead({ sessionId: session.id });
    await restarted.turnStart({ ...input, operationId: "after-slow-start" });
    await waitFor(() => restarted.host.activeTurns.size === 0, "resumed Pi turn");
    await value.adapter.stopAll();
  } finally {
    clearTimeout(keepAlive);
    value.cleanup();
  }
});

test("an ambiguous Pi turn blocks continuation until the old process actually exits", async () => {
  const behavior = { holdPromptAck: true, ignoreKill: true, lingerAfterSettledTurn: true };
  const value = rpcFixture(behavior);
  const keepAlive = setTimeout(() => {}, 3_000);
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, { workspace: value.workspace, permissionPolicy });
    const { session } = await runtime.sessionStart({
      source: "chat:slow-exit", cwd: value.workspace, model: "openai/gpt-5.6", permissionPolicy,
    });
    runtime.host.acceptanceTimeoutMs = 100;
    const input = {
      sessionId: session.id, operationId: "ambiguous", prompt: "maybe running", cwd: value.workspace,
      model: "openai/gpt-5.6", permissionPolicy,
    };
    await assert.rejects(runtime.turnStart(input), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    const child = value.spawns.find((entry) => entry.command === "/bin/sh").child;
    assert.equal(child.closed, false);
    await assert.rejects(runtime.sessionRead({ sessionId: session.id }), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    await assert.rejects(runtime.turnStart({ ...input, operationId: "too-early" }), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    child.finish(null, "SIGKILL");
    await waitFor(() => runtime.host.turnProcesses.size === 0, "confirmed process exit");
    await runtime.sessionRead({ sessionId: session.id });
    await assert.rejects(runtime.turnStart(input), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    behavior.holdPromptAck = false;
    behavior.ignoreKill = false;
    behavior.lingerAfterSettledTurn = false;
    await runtime.turnStart({ ...input, operationId: "safe-next-operation" });
    await waitFor(() => runtime.host.activeTurns.size === 0, "next operation completion");
    await value.adapter.stopAll();
  } finally {
    clearTimeout(keepAlive);
    value.cleanup();
  }
});

test("transport loss before get_state is definitely rejected instead of poisoning the session", async () => {
  const value = rpcFixture({ closeBeforeState: true });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await value.adapter.acquire(PI_BINDING, {
      workspace: value.workspace,
      permissionPolicy,
    });
    const started = await runtime.sessionStart({
      source: "chat:before-state",
      developerInstructions: "",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    });
    await assert.rejects(runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-before-state",
      prompt: "not dispatched",
      model: "openai/gpt-5.6",
      cwd: value.workspace,
      permissionPolicy,
    }), { code: "PI_PROCESS_CLOSED" });
    await waitFor(() => runtime.host.activeTurns.size === 0, "pre-prompt Pi failure");
    const snapshot = runtime.host.ledger.snapshot();
    assert.equal(snapshot.sessions[0].sessionFile, null);
    assert.equal(snapshot.sessions[0].turns[0].acceptance, "failed");
    await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    await value.adapter.stopAll();
  } finally {
    value.cleanup();
  }
});
