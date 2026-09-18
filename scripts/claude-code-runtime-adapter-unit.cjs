"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  CLAUDE_CODE_CAPABILITIES,
  ClaudeCodeRuntimeAdapter,
} = require("../app/agent-service/claude-code-runtime-adapter");
const { ClaudeCodeRuntimePool } = require("../app/agent-service/claude-code-runtime-pool");
const {
  DEFAULT_CLAUDE_CODE_PERMISSION_POLICY,
  claudeCodePermissionOptions,
  parseClaudeCodeVersion,
  supportsClaudeCodeVersion,
} = require("../app/agent-service/claude-code-runtime-paths");
const {
  ClaudeCodeRuntimeLedger,
} = require("../app/agent-service/claude-code-runtime-ledger");
const {
  NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
} = require("../app/agent-service/runtime-account");
const {
  questionSchema,
  usageFromResult,
} = require("../app/agent-service/claude-code-runtime-host");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdio = [this.stdin, this.stdout, this.stderr, new PassThrough()];
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.closed = false;
  }

  finish(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => {
      this.emit("exit", code, signal);
      this.emit("close", code, signal);
    });
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    this.finish(signal === "SIGKILL" ? null : 0, signal);
    return true;
  }
}

class FakeQuery {
  constructor(child) {
    this.child = child;
    this.values = [];
    this.waiters = [];
    this.closed = false;
    this.ended = false;
    this.userMessage = null;
  }

  push(value) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  next() {
    if (this.values.length > 0) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return() {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() { return this; }

  supportedModels() {
    return Promise.resolve([
      { value: "sonnet", displayName: "Claude Sonnet", description: "Balanced", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
      { value: "opus", displayName: "Claude Opus", description: "Deep reasoning" },
    ]);
  }

  supportedCommands() {
    return Promise.resolve([
      {
        name: "compact", description: "Compact conversation history",
        argumentHint: "[instructions]", aliases: ["shrink"],
      },
      { name: "review", description: "Review code changes", aliases: [] },
    ]);
  }

  async interrupt() {
    if (this.userMessage && !this.ended) {
      this.push({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 1,
        errors: ["Interrupted"],
        modelUsage: {},
        uuid: crypto.randomUUID(),
        session_id: this.userMessage.session_id,
        user_message_uuid: this.userMessage.uuid,
        terminal_reason: "aborted_streaming",
      });
      this.end();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.end();
    this.child?.kill("SIGTERM");
  }
}

class FakeSdk {
  constructor(behavior = {}) {
    this.behavior = behavior;
    this.queryCalls = [];
    this.prompts = [];
    this.userMessages = [];
    this.renames = [];
    this.deletes = [];
  }

  query(params) {
    this.queryCalls.push(params);
    const abortController = new AbortController();
    const child = params.options.spawnClaudeCodeProcess({
      command: params.options.pathToClaudeCodeExecutable,
      args: ["--sdk-fake"],
      cwd: params.options.cwd,
      env: params.options.env,
      signal: abortController.signal,
    });
    const query = new FakeQuery(child);
    const control = Array.isArray(params.options.tools) && params.options.tools.length === 0;
    if (!control) void this.#runTurn(query, params);
    return query;
  }

  async #runTurn(query, params) {
    const first = await params.prompt.next();
    if (first.done) return;
    this.prompts.push(first.value.message.content[0].text);
    this.userMessages.push(first.value.message);
    query.userMessage = first.value;
    const sessionId = first.value.session_id;
    query.push({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: params.options.cwd,
      model: params.options.model || "sonnet",
    });
    if (first.value.message.content[0].text === "/compact") {
      query.push({
        type: "system",
        subtype: "local_command_output",
        content: "Conversation compacted",
        uuid: crypto.randomUUID(),
        session_id: sessionId,
      });
      query.push({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 0,
        result: "",
        modelUsage: {},
        uuid: crypto.randomUUID(),
        session_id: sessionId,
        user_message_uuid: first.value.uuid,
        terminal_reason: "completed",
      });
      query.end();
      return;
    }
    query.push({
      type: "assistant",
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "tool-call-one",
          name: "Bash",
          input: { command: "pwd" },
        }],
      },
    });
    if (this.behavior.hold) return;
    if (this.behavior.permission !== false) {
      const decision = await params.options.canUseTool("Bash", { command: "pwd" }, {
        signal: new AbortController().signal,
        toolUseID: "tool-call-one",
        requestId: "sdk-request-one",
        title: "Run pwd",
        suggestions: this.behavior.suggestions ?? [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "pwd" }],
          behavior: "allow",
          destination: "session",
        }],
      });
      this.lastPermissionDecision = decision;
      assert.equal(decision.behavior, "allow");
    }
    query.push({
      type: "stream_event",
      session_id: sessionId,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "完成" } },
    });
    query.push({
      type: "stream_event",
      session_id: sessionId,
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "思考过程" },
      },
    });
    query.push({
      type: "stream_event",
      session_id: sessionId,
      event: {
        type: "content_block_delta",
        delta: { type: "signature_delta", signature: "opaque-thinking-signature" },
      },
    });
    query.push({
      type: "user",
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-call-one", content: "ok" }],
      },
    });
    query.push({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: "任务完成",
      modelUsage: {
        "claude-sonnet": {
          inputTokens: 100,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 10,
          outputTokens: 30,
          thinkingTokens: 5,
        },
      },
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      user_message_uuid: first.value.uuid,
      terminal_reason: "completed",
    });
    query.end();
  }

  renameSession(sessionId, title, options) {
    this.renames.push({ sessionId, title, options, configDir: process.env.CLAUDE_CONFIG_DIR });
    return Promise.resolve();
  }

  deleteSession(sessionId, options) {
    this.deletes.push({ sessionId, options, configDir: process.env.CLAUDE_CONFIG_DIR });
    return Promise.resolve();
  }
}

function waitUntil(predicate, label) {
  const deadline = Date.now() + 2_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) resolve();
      else if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${label}`));
      else setImmediate(poll);
    };
    poll();
  });
}

function fixture(behavior = {}) {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-claude-code-"));
  fs.chmodSync(trustedRoot, 0o700);
  const stateDir = path.join(trustedRoot, "state");
  const workspace = path.join(trustedRoot, "workspace");
  const binDir = path.join(trustedRoot, "bin");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(binDir, { mode: 0o700 });
  const binaryCandidate = path.join(binDir, "claude");
  fs.writeFileSync(binaryCandidate, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const binaryPath = fs.realpathSync(binaryCandidate);
  const sdk = new FakeSdk(behavior);
  const spawns = [];
  const children = [];
  let nextPid = 30_000;
  const spawnProcess = (command, args, options) => {
    const child = new FakeChild(nextPid += 1);
    spawns.push({ command, args: [...args], options, child });
    children.push(child);
    if (command === binaryPath && args[0] !== "--sdk-fake") {
      queueMicrotask(() => {
        if (args[0] === "--version") child.stdout.write("2.1.220 (Claude Code)\n");
        else if (args[0] === "auth") {
          child.stdout.write(`${JSON.stringify({
            loggedIn: behavior.unauthenticated !== true,
            authMethod: behavior.unauthenticated === true ? "none" : "claude.ai",
            apiProvider: "firstParty",
          })}\n`);
        }
        child.finish(args[0] === "auth" && behavior.unauthenticated ? 1 : 0);
      });
    }
    return child;
  };
  const bindings = [];
  const revocations = [];
  let reservation = 0;
  const mcpGateIssuer = {
    reserveMcpServer() {
      reservation += 1;
      const reservationId = reservation.toString(16).padStart(64, "0");
      return {
        reservationId,
        name: "shoggoth",
        command: binaryPath,
        args: ["bootstrap"],
        env: [{ name: "SHOGGOTH_RUNTIME_MCP_GATE_NONCE", value: reservationId }],
      };
    },
    bindMcpServer(input) { bindings.push(input); return { bound: true }; },
    revokeMcpServer(input) { revocations.push(input); return { revoked: true }; },
  };
  const pool = new ClaudeCodeRuntimePool({
    paths: { trustedRoot, stateDir },
    binaryPath,
    parentEnv: { PATH: binDir, ANTHROPIC_API_KEY: "must-not-leak" },
    homedir: trustedRoot,
    spawnProcess,
    killProcessGroup(pid, signal) {
      children.find((child) => child.pid === pid)?.kill(signal);
    },
    mcpGateIssuer,
    sdk,
    ...(behavior.serverRequestTimeoutMs === undefined
      ? {} : { serverRequestTimeoutMs: behavior.serverRequestTimeoutMs }),
  });
  const adapter = new ClaudeCodeRuntimeAdapter({ runtimePool: pool });
  return {
    adapter,
    binaryPath,
    bindings,
    pool,
    revocations,
    sdk,
    spawns,
    stateDir,
    trustedRoot,
    workspace,
    async close() {
      await adapter.stopAll();
      fs.rmSync(trustedRoot, { recursive: true, force: true });
    },
  };
}

test("Claude Code 路径、版本、权限与 usage 映射稳定", () => {
  assert.deepEqual(parseClaudeCodeVersion("2.1.220 (Claude Code)"), [2, 1, 220]);
  assert.equal(supportsClaudeCodeVersion("2.1.219 (Claude Code)"), false);
  assert.equal(supportsClaudeCodeVersion("2.1.220 (Claude Code)"), true);
  const workspace = "/tmp/claude-code-workspace";
  assert.deepEqual(DEFAULT_CLAUDE_CODE_PERMISSION_POLICY, {
    approvalPolicy: "on-request",
    sandbox: "danger-full-access",
  });
  assert.deepEqual(claudeCodePermissionOptions(undefined, workspace), {
    permissionMode: "default",
    allowDangerouslySkipPermissions: false,
    sandbox: undefined,
    settings: {},
  });
  const permission = claudeCodePermissionOptions({
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  }, workspace);
  assert.equal(permission.permissionMode, "default");
  assert.equal(permission.sandbox.failIfUnavailable, true);
  assert.deepEqual(permission.sandbox.filesystem.allowWrite, [workspace]);
  assert.equal(claudeCodePermissionOptions({
    approvalPolicy: "on-request", sandbox: "workspace-write",
  }, workspace, "auto").permissionMode, "auto");
  assert.equal(claudeCodePermissionOptions({
    approvalPolicy: "on-request", sandbox: "workspace-write",
  }, workspace, "acceptEdits").sandbox.autoAllowBashIfSandboxed, false);
  assert.equal(claudeCodePermissionOptions({
    approvalPolicy: "untrusted", sandbox: "workspace-write",
  }, workspace, "dontAsk").permissionMode, "dontAsk");
  assert.deepEqual(claudeCodePermissionOptions({
    approvalPolicy: "never", sandbox: "danger-full-access",
  }, workspace, "bypassPermissions"), {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    sandbox: undefined,
    settings: {},
  });
  assert.deepEqual(usageFromResult({
    modelUsage: {
      one: {
        inputTokens: 10,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 3,
        outputTokens: 7,
        thinkingTokens: 4,
      },
    },
  }), {
    inputTokens: 15,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 3,
    outputTokens: 7,
    reasoningOutputTokens: 4,
    totalTokens: 22,
  });
});

test("AskUserQuestion 可投影为 Shoggoth 交互合同", () => {
  const normalized = questionSchema({
    questions: [{
      header: "方案",
      question: "选择实现方案",
      multiSelect: false,
      options: [
        { label: "安全", description: "更严格" },
        { label: "快速", description: "更快捷" },
      ],
    }],
  });
  const request = normalizeInteractiveRequestV1({
    runId: "run-one",
    eventType: "prompt",
    payload: {
      requestId: "request-one",
      method: "mcpServer/elicitation/request",
      kind: "mcp_elicitation",
      serverName: "claude-code",
      mode: "form",
      message: "请选择",
      requestedSchema: normalized.schema,
    },
  });
  assert.equal(request.fields[0].type, "choice");
  assert.deepEqual(request.fields[0].options.map((option) => option.value), ["安全", "快速"]);
});

test("Claude Code 设置页认证读取不复用运行期缓存", async () => {
  const behavior = {};
  const ctx = fixture(behavior);
  try {
    const runtime = await ctx.adapter.acquire({
      runtime: "claude-code",
      runtimeProfileId: "auth-refresh-profile",
      runtimeAccountId: NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
    }, {
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.deepEqual(await runtime.authenticationState(), {
      authenticated: true,
      credentialPresent: true,
    });
    behavior.unauthenticated = true;
    assert.deepEqual(await runtime.authenticationState(), {
      authenticated: false,
      credentialPresent: false,
    });
  } finally {
    await ctx.close();
  }
});

test("Claude Code 只展示并应用明确的 session 授权建议", async () => {
  const persistent = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "pwd" }], behavior: "allow", destination: "userSettings" };
  const session = { ...persistent, destination: "session" };
  for (const suggestions of [[], [persistent], [persistent, session]]) {
    const ctx = fixture({ suggestions });
    try {
      const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
      const runtime = await ctx.adapter.acquire({
        runtime: "claude-code", runtimeProfileId: "shoggoth-claude-code-cli-v1",
        runtimeAccountId: NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
      }, { workspace: ctx.workspace, permissionPolicy });
      const expected = suggestions.includes(session);
      const started = await runtime.sessionStart({ cwd: ctx.workspace, source: "chat:test", permissionPolicy });
      const events = [];
      runtime.subscribe((event) => events.push(event));
      runtime.registerServerRequestHandler("item/commandExecution/requestApproval", async (params) => {
        assert.equal(params.sessionApprovalAvailable, expected);
        assert.equal(params.toolName, "Bash");
        assert.deepEqual(params.toolInput, { command: "pwd" });
        return { decision: expected ? "acceptForSession" : "accept" };
      });
      await runtime.turnStart({ sessionId: started.session.id, operationId: "scope-check", prompt: "pwd", cwd: ctx.workspace, permissionPolicy });
      await waitUntil(() => events.some((event) => event.type === "complete"), "approval scope terminal");
      assert.deepEqual(ctx.sdk.lastPermissionDecision.updatedPermissions, expected ? [session] : undefined);
    } finally { await ctx.close(); }
  }
});

test("Claude Code Adapter 覆盖会话、审批、流式、Token、模型与物理删除", async () => {
  const ctx = fixture();
  try {
    const runtime = await ctx.adapter.acquire({
      runtime: "claude-code",
      runtimeProfileId: "shoggoth-claude-code-cli-v1",
      runtimeAccountId: NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
    }, {
      workspace: ctx.workspace,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.equal(runtime.capabilities, CLAUDE_CODE_CAPABILITIES);
    assert.equal(runtime.capabilities["session.delete"], true);
    assert.equal(runtime.capabilities["turn.steer"], true);
    assert.equal(runtime.capabilities["commands.list"], true);
    assert.equal(runtime.capabilities["commands.execute"], true);
    assert.equal(runtime.capabilities.serverRequests, true);
    assert.deepEqual(await runtime.authenticationState(), {
      authenticated: true,
      credentialPresent: true,
    });
    const catalog = await runtime.modelsList({ limit: 100 });
    assert.deepEqual(catalog.data.map((model) => model.model), ["sonnet", "opus"]);
    assert.deepEqual(catalog.data[0].capabilities.thinkingOptions, ["low", "medium", "high"]);
    const commands = await runtime.commandsList();
    assert.equal(commands.reason, null);
    assert.deepEqual(commands.commands.filter((command) => command.execution === "runtime")
      .map((command) => command.name), ["compact", "review"]);
    assert.equal(commands.commands.find((command) => command.name === "clear").execution, "client");
    assert.equal(commands.commands.find((command) => command.name === "terminal-setup").execution, "cli");
    await assert.rejects(runtime.commandExecute({ text: "/terminal-setup" }),
      { code: "RUNTIME_COMMAND_CLI_ONLY" });
    assert.deepEqual(commands.commands[0].aliases, ["shrink"]);
    assert.deepEqual(await runtime.commandExecute({ text: "/shrink now" }), {
      kind: "send", text: "/shrink now", warning: null,
    });
    const started = await runtime.sessionStart({
      source: "chat:test",
      cwd: ctx.workspace,
      developerInstructions: "只修改当前工作区",
      model: "sonnet",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    const approvals = [];
    runtime.registerServerRequestHandler("item/commandExecution/requestApproval", async (params) => {
      approvals.push(params);
      return { decision: "acceptForSession" };
    });
    runtime.registerServerRequestHandler("item/fileChange/requestApproval", async () => (
      { decision: "accept" }
    ));
    runtime.registerServerRequestHandler("mcpServer/elicitation/request", async () => (
      { action: "accept", content: {} }
    ));
    const image = require("./fixtures/native-chat-image.cjs")(ctx.workspace);
    const turn = await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-one",
      prompt: "运行 pwd",
      attachments: [image],
      thinkingLevel: "high",
      context: "上下文",
      cwd: ctx.workspace,
      model: "sonnet",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.match(turn.turn.id, /^claude-code-turn-/u);
    assert.equal(ctx.sdk.queryCalls.find(call => call.options.effort)?.options.effort, "high");
    await waitUntil(() => events.some((event) => event.type === "complete"), "terminal event");
    assert.equal(approvals.length, 1);
    assert.deepEqual(ctx.sdk.userMessages[0].content[1], { type: "image", source: {
      type: "base64", media_type: image.mimeType, data: image.data,
    } });
    assert.equal(approvals[0].sessionId, started.session.id);
    assert.equal(events.some((event) => event.type === "text_delta" && event.delta === "完成"), true);
    assert.equal(events.some((event) => (
      event.type === "reasoning_delta" && event.delta === "思考过程"
    )), true);
    assert.equal(events.some((event) => JSON.stringify(event).includes("opaque-thinking-signature")), false);
    assert.deepEqual(events.find((event) => event.type === "tool_start")?.tool.input, {
      command: "pwd",
    });
    assert.equal(events.find((event) => event.type === "tool_result")?.tool.output, "ok");
    assert.deepEqual(events.find((event) => event.type === "usage").usage, {
      inputTokens: 130,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 30,
      reasoningOutputTokens: 5,
      totalTokens: 160,
    });
    assert.equal(events.at(-1).status, "completed");
    const read = await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    assert.equal(read.session.turns[0].items.at(-1).text, "任务完成");
    const replay = await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-one",
      prompt: "运行 pwd",
      thinkingLevel: "high",
      context: "上下文",
      cwd: ctx.workspace,
      model: "sonnet",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.equal(replay.turn.id, turn.turn.id);
    const commandTurn = await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-command",
      prompt: "/compact",
      context: "must not wrap native command",
      cwd: ctx.workspace,
      model: "sonnet",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    await waitUntil(() => events.filter((event) => event.type === "complete").length === 2,
      "native command terminal event");
    assert.match(commandTurn.turn.id, /^claude-code-turn-/u);
    assert.equal(ctx.sdk.prompts.at(-1), "/compact");
    const commandHistory = await runtime.sessionRead({
      sessionId: started.session.id,
      includeTurns: true,
    });
    assert.equal(commandHistory.session.turns.at(-1).items.at(-1).text, "Conversation compacted");
    await runtime.sessionRename({ sessionId: started.session.id, name: "Claude 测试会话" });
    assert.equal(ctx.sdk.renames.length, 1);
    assert.match(ctx.sdk.renames[0].configDir, /claude-code/u);
    await runtime.sessionArchive({ sessionId: started.session.id });
    assert.equal((await runtime.sessionList({ archived: true })).data.length, 1);
    await runtime.sessionUnarchive({ sessionId: started.session.id });
    await runtime.sessionDelete({ sessionId: started.session.id });
    assert.equal(ctx.sdk.deletes.length, 1);
    assert.equal((await runtime.sessionList({ archived: false })).data.length, 0);
    assert.equal(ctx.bindings.length, 2);
    assert.equal(ctx.revocations.length, 2);
    const turnQuery = ctx.sdk.queryCalls.find((call) => !Array.isArray(call.options.tools));
    assert.deepEqual(turnQuery.options.systemPrompt, {
      type: "preset",
      preset: "claude_code",
      append: "只修改当前工作区",
    });
    assert.equal(turnQuery.options.strictMcpConfig, true);
    assert.deepEqual(turnQuery.options.settingSources, []);
    assert.equal(turnQuery.options.skills, undefined, "CLI skill discovery must not be disabled for execution");
    assert.deepEqual(Object.keys(turnQuery.options.mcpServers), ["shoggoth"]);
    assert.equal(turnQuery.options.mcpServers.shoggoth.timeout, 2_147_000_000);
    const turnSpawn = ctx.spawns.find((entry) => entry.command === "/bin/sh");
    assert.ok(turnSpawn);
    assert.equal(turnSpawn.options.env.ANTHROPIC_API_KEY, undefined);
    assert.match(turnSpawn.options.env.CLAUDE_CONFIG_DIR, /claude-code/u);
  } finally {
    await ctx.close();
  }
});

test("Claude Code approval ignores the finite form-request deadline", async () => {
  const ctx = fixture({ serverRequestTimeoutMs: 100 });
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await ctx.adapter.acquire({
      runtime: "claude-code",
      runtimeProfileId: "approval-wait-profile",
      runtimeAccountId: NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
    }, { workspace: ctx.workspace, permissionPolicy });
    const started = await runtime.sessionStart({
      source: "chat:approval-wait",
      cwd: ctx.workspace,
      developerInstructions: "",
      model: "sonnet",
      permissionPolicy,
    });
    let resolveApproval;
    let approvalCalls = 0;
    runtime.registerServerRequestHandler("item/commandExecution/requestApproval", async () => {
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
      cwd: ctx.workspace,
      model: "sonnet",
      permissionPolicy,
    });
    await waitUntil(() => approvalCalls === 1, "approval request");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(completions.length, 0);
    resolveApproval({ decision: "accept" });
    await waitUntil(() => completions.length === 1, "completion after approval");
    assert.equal(completions[0].status, "completed");
  } finally {
    await ctx.close();
  }
});

test("Claude Code product confirmation ignores the finite form-request deadline", async () => {
  const ctx = fixture({ serverRequestTimeoutMs: 100 });
  try {
    const runtime = await ctx.adapter.acquire({
      runtime: "claude-code",
      runtimeProfileId: "product-confirmation-wait-profile",
      runtimeAccountId: NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
    }, {
      workspace: ctx.workspace,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    let resolveConfirmation;
    runtime.registerServerRequestHandler("mcpServer/elicitation/request", async () => (
      new Promise((resolve) => { resolveConfirmation = resolve; })
    ));
    const pending = runtime.host._requestServer(
      null,
      "mcpServer/elicitation/request",
      {
        serverName: "shoggoth",
        mode: "form",
        message: "确认修改",
        requestedSchema: {
          type: "object",
          properties: {
            confirm_product_action: {
              type: "string", title: "确认修改", enum: ["确认执行", "取消"],
            },
          },
          required: ["confirm_product_action"],
        },
      },
      null,
    );
    await waitUntil(() => typeof resolveConfirmation === "function", "product confirmation request");
    await new Promise((resolve) => setTimeout(resolve, 150));
    resolveConfirmation({
      action: "accept", content: { confirm_product_action: "确认执行" },
    });
    assert.deepEqual(await pending, {
      action: "accept", content: { confirm_product_action: "确认执行" },
    });
  } finally {
    await ctx.close();
  }
});

test("Claude Code turn steer 与 interrupt 保持同一 turn binding", async () => {
  const ctx = fixture({ hold: true });
  try {
    const runtime = await ctx.adapter.acquire({
      runtime: "claude-code",
      runtimeProfileId: "steer-profile",
      runtimeAccountId: NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
    }, {
      workspace: ctx.workspace,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    const started = await runtime.sessionStart({
      source: "chat:steer",
      cwd: ctx.workspace,
      developerInstructions: "",
      model: "sonnet",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    const turn = await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-hold",
      prompt: "等待",
      cwd: ctx.workspace,
      model: "sonnet",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.deepEqual(await runtime.turnSteer({
      sessionId: started.session.id,
      turnId: turn.turn.id,
      operationId: "steer-one",
      message: "补充信息",
    }), { turnId: turn.turn.id });
    await runtime.turnInterrupt({ sessionId: started.session.id, turnId: turn.turn.id });
    const read = await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    assert.equal(read.session.turns[0].status, "interrupted");
  } finally {
    await ctx.close();
  }
});

test("Claude Code ledger 重启将已接收的 inProgress turn 收敛为 interrupted", () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-claude-ledger-"));
  fs.chmodSync(trustedRoot, 0o700);
  const stateRoot = path.join(trustedRoot, "state");
  const workspace = path.join(trustedRoot, "workspace");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  const options = {
    stateRoot,
    trustedRoot,
    runtimeProfileId: "ledger-profile",
    workspaceShardId: "a".repeat(64),
    now: () => 20,
  };
  const sessionId = crypto.randomUUID();
  const ledger = new ClaudeCodeRuntimeLedger(options).open();
  ledger.update((data) => data.sessions.push({
    id: sessionId,
    remoteSessionId: sessionId,
    source: "chat:ledger",
    cwd: workspace,
    title: null,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    turns: [{
      id: `claude-code-turn-${crypto.randomUUID()}`,
      operationId: "ledger-operation",
      fingerprint: "b".repeat(64),
      userMessageUuid: crypto.randomUUID(),
      acceptance: "accepted",
      status: "inProgress",
      errorCode: null,
      assistantMessages: [],
      responseId: null,
      createdAt: 2,
      updatedAt: 2,
    }],
  }));
  const reopened = new ClaudeCodeRuntimeLedger(options).open().snapshot();
  assert.equal(reopened.sessions[0].turns[0].status, "interrupted");
  assert.equal(reopened.sessions[0].turns[0].errorCode, "RUNTIME_HOST_RESTARTED");
  fs.rmSync(trustedRoot, { recursive: true, force: true });
});
