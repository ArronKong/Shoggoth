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
  claudeQuotaSnapshot,
  questionSchema,
  usageFromResult,
} = require("../app/agent-service/claude-code-runtime-host");
const { validateRuntimeEvent } = require("../app/agent-service/runtime-handle-v1");
const { validQuotaSnapshot } = require("../app/core/oauth-account-quota");
const { normalizeInteractiveRequestV1, parseMcpToolPermission } = require("../app/core/shoggoth-interaction-contract");

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

// Models one resident Claude Code process: a single query keeps reading user
// messages from its prompt stream and answers each with its own result.
class FakeQuery {
  constructor(sdk, child, control) {
    this.sdk = sdk;
    this.child = child;
    this.control = control;
    this.values = [];
    this.waiters = [];
    this.closed = false;
    this.ended = false;
    this.userMessage = null;
    this.activeTurn = null;
    this.initSent = false;
    this.steers = [];
    child?.once("exit", () => this.end());
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

  initializationResult() {
    return Promise.resolve({ commands: [], models: [], account: { email: "dev@example.test", subscriptionType: "max" } });
  }

  supportedModels() {
    return Promise.resolve(this.sdk.behavior.models ?? [
      { value: "default", resolvedModel: "claude-opus-fixture", displayName: "Default (recommended)" },
      { value: "sonnet", resolvedModel: "claude-sonnet-fixture", displayName: "Claude Sonnet", description: "Balanced", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
      { value: "opus", resolvedModel: "claude-opus-fixture", displayName: "Claude Opus", description: "Deep reasoning" },
    ]);
  }

  getSettings() {
    return Promise.resolve({ model: "sonnet", applied: { model: this.sdk.behavior.appliedModel ?? "claude-fixture-actual" } });
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

  accountInfo() {
    return Promise.resolve({ email: "dev@example.test", subscriptionType: "max", apiProvider: "firstParty" });
  }

  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options) {
    this.sdk.usageCalls.push(options);
    if (this.sdk.behavior.noPlanUsage) {
      return Promise.resolve({ session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null });
    }
    return Promise.resolve({
      session: {},
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2026-11-23T10:00:00.000Z" },
        seven_day: { utilization: 7.5, resets_at: "2026-11-27T00:00:00.000Z" },
        seven_day_opus: null,
      },
    });
  }

  setMcpServers(servers) {
    this.sdk.mcpCalls.push({ child: this.child, servers });
    return Promise.resolve({
      added: Object.keys(servers),
      removed: [],
      errors: this.sdk.behavior.mcpError ? { shoggoth: "connection failed" } : {},
    });
  }

  async interrupt() {
    const turn = this.activeTurn;
    if (!turn || this.ended) return;
    this.activeTurn = null;
    this.push({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 1,
      errors: ["Interrupted"],
      modelUsage: {},
      uuid: crypto.randomUUID(),
      session_id: turn.session_id,
      user_message_uuid: turn.uuid,
      terminal_reason: "aborted_streaming",
    });
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
    this.turnQueries = [];
    this.priorProcessesExited = [];
    this.mcpCalls = [];
    this.usageCalls = [];
    this.prompts = [];
    this.userMessages = [];
    this.renames = [];
    this.deletes = [];
  }

  query(params) {
    this.queryCalls.push(params);
    const child = params.options.spawnClaudeCodeProcess({
      command: params.options.pathToClaudeCodeExecutable,
      args: ["--sdk-fake"],
      cwd: params.options.cwd,
      env: { ...params.options.env, ...this.behavior.sdkEnv },
      signal: new AbortController().signal,
    });
    const control = Array.isArray(params.options.tools) && params.options.tools.length === 0;
    const query = new FakeQuery(this, child, control);
    if (!control) {
      this.priorProcessesExited.push(this.turnQueries.every((prior) => prior.child.closed));
      this.turnQueries.push(query);
      void this.#serve(query, params);
    }
    return query;
  }

  async #serve(query, params) {
    for (;;) {
      const next = await params.prompt.next();
      if (next.done || query.ended) return;
      // While a held turn runs, further messages are steers into that turn.
      if (query.activeTurn) {
        query.steers.push(next.value);
        continue;
      }
      await this.#runTurn(query, params, next.value);
    }
  }

  async #runTurn(query, params, user) {
    const text = user.message.content[0].text;
    this.prompts.push(text);
    this.userMessages.push(user.message);
    query.userMessage = user;
    const sessionId = user.session_id;
    if (!query.initSent || this.behavior.initPerTurn) {
      query.initSent = true;
      query.push({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: params.options.cwd,
        model: params.options.model || "sonnet",
      });
    }
    if (text === "/compact") {
      // Claude Code 2.1.329 order: compacting status, cleared status, a fresh
      // init for the compacted session, the boundary, the summary and the
      // command's stdout as user messages, then a zero-turn result.
      query.push({ type: "system", subtype: "status", status: "compacting", session_id: sessionId });
      query.push({ type: "system", subtype: "status", status: null, session_id: sessionId });
      query.push({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: params.options.cwd,
        model: params.options.model || "sonnet",
      });
      query.push({
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-boundary-one",
        session_id: sessionId,
        compact_metadata: { trigger: "manual", pre_tokens: 1000 },
      });
      query.push({ type: "user", session_id: sessionId, isSynthetic: true,
        message: { role: "user", content: "This session is being continued from a previous conversation." } });
      query.push({ type: "user", session_id: sessionId,
        message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } });
      query.push({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 0,
        result: "",
        modelUsage: {},
        uuid: crypto.randomUUID(),
        session_id: sessionId,
        user_message_uuid: user.uuid,
        terminal_reason: "completed",
      });
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
    if (this.behavior.hold) {
      query.activeTurn = user;
      return;
    }
    if (this.behavior.permission !== false) {
      const decision = await params.options.canUseTool(this.behavior.permissionTool ?? "Bash", { command: "pwd" }, {
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
      user_message_uuid: user.uuid,
      terminal_reason: "completed",
    });
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
  const reservations = [];
  const revocations = [];
  let reservation = 0;
  const mcpGateIssuer = {
    reserveMcpServer(input) {
      assert.equal(input.parentLauncherExecutable, undefined,
        "a resident Claude Code process is already its own executable when a turn binds MCP");
      assert.equal(input.parentExecutable, binaryPath);
      reservation += 1;
      const reservationId = reservation.toString(16).padStart(64, "0");
      reservations.push({ ...input, reservationId });
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
    parentEnv: { PATH: binDir, USER: "fixture-user", ANTHROPIC_API_KEY: "must-not-leak", ...behavior.parentEnv },
    homedir: trustedRoot,
    spawnProcess,
    killProcessGroup(pid, signal) {
      children.find((child) => child.pid === pid)?.kill(signal);
    },
    mcpGateIssuer,
    sdk,
    ...(behavior.liveIdleMs === undefined ? {} : { liveIdleMs: behavior.liveIdleMs }),
    ...(behavior.serverRequestTimeoutMs === undefined
      ? {} : { serverRequestTimeoutMs: behavior.serverRequestTimeoutMs }),
  });
  const adapter = new ClaudeCodeRuntimeAdapter({ runtimePool: pool });
  return {
    adapter,
    binaryPath,
    bindings,
    children,
    pool,
    reservations,
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
    assert.equal(runtime.capabilities["model.resolve.toolFree"], true);
    assert.equal(runtime.capabilities.serverRequests, true);
    assert.deepEqual(await runtime.authenticationState(), {
      authenticated: true,
      credentialPresent: true,
    });
    assert.deepEqual(await runtime.resolveModelOnly({ operationId: "claude-control-model" }), {
      model: "claude-fixture-actual", provider: "claude-code",
    });
    const catalog = await runtime.modelsList({ limit: 100 });
    assert.deepEqual(catalog.data.map((model) => model.model), ["sonnet", "opus"]);
    assert.deepEqual(catalog.data.filter(model => model.isDefault).map(model => model.model), ["opus"]);
    const firstPage = await runtime.modelsList({ limit: 1 });
    assert.equal(firstPage.data[0].isDefault, false);
    assert.equal((await runtime.modelsList({ cursor: firstPage.nextCursor, limit: 1 })).data[0].isDefault, true);
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
    const agentWorkspace = fs.mkdtempSync(path.join(ctx.trustedRoot, "agent-home-"));
    const turn = await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-one",
      prompt: "运行 pwd",
      agentWorkspace,
      turnDeveloperInstructions: "CURRENT_RUN_ONLY",
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
      turnDeveloperInstructions: "CURRENT_RUN_ONLY",
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
      agentWorkspace,
      turnDeveloperInstructions: "CURRENT_RUN_ONLY",
      thinkingLevel: "high",
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
    const commandRecord = commandHistory.session.turns.at(-1);
    assert.equal(commandRecord.id, commandTurn.turn.id);
    assert.equal(commandRecord.status, "completed", "the compact command finishes with its zero-turn result");
    const compacted = events.find((event) => event.type === "context_compacted");
    assert.equal(compacted.turnId, commandTurn.turn.id);
    assert.equal(compacted.compactionId, "compact-boundary-one");
    assert.deepEqual(compacted.compaction, { id: "compact-boundary-one", status: "completed" });
    assert.equal(compacted.contextUsage.runtimeSessionId, started.session.id);
    // The Service wraps this Host in RuntimeHandleV1, which retires a Host whose
    // event fails validation. The boundary must pass it unchanged.
    assert.doesNotThrow(() => validateRuntimeEvent(compacted));
    assert.equal(ctx.sdk.turnQueries.length, 1, "both turns share the session's resident process");
    const resident = ctx.sdk.turnQueries[0].child;
    assert.equal(resident.killed, false, "a finished turn hands the process back instead of closing it");
    await runtime.sessionRename({ sessionId: started.session.id, name: "Claude 测试会话" });
    assert.equal(ctx.sdk.renames.length, 1);
    assert.match(ctx.sdk.renames[0].configDir, /claude-code/u);
    await runtime.sessionArchive({ sessionId: started.session.id });
    assert.equal((await runtime.sessionList({ archived: true })).data.length, 1);
    await runtime.sessionUnarchive({ sessionId: started.session.id });
    await runtime.sessionDelete({ sessionId: started.session.id });
    assert.equal(ctx.sdk.deletes.length, 1);
    assert.equal(resident.killed, true, "deleting a session releases its resident process first");
    assert.equal((await runtime.sessionList({ archived: false })).data.length, 0);
    assert.equal(ctx.bindings.length, 2);
    assert.deepEqual(ctx.bindings.map((binding) => binding.parentPid), [resident.pid, resident.pid]);
    assert.deepEqual(ctx.revocations.map((entry) => entry.reservationId),
      ctx.reservations.map((entry) => entry.reservationId));
    const turnQuery = ctx.sdk.queryCalls.find((call) => !Array.isArray(call.options.tools));
    assert.deepEqual(turnQuery.options.additionalDirectories, [agentWorkspace]);
    assert.deepEqual(turnQuery.options.sandbox.filesystem.allowWrite, [ctx.workspace, agentWorkspace]);
    assert.deepEqual(turnQuery.options.systemPrompt, {
      type: "preset",
      preset: "claude_code",
      append: "只修改当前工作区\n\nCURRENT_RUN_ONLY",
    });
    assert.equal(turnQuery.options.strictMcpConfig, true);
    assert.deepEqual(turnQuery.options.settingSources, []);
    assert.equal(turnQuery.options.skills, undefined, "CLI skill discovery must not be disabled for execution");
    assert.deepEqual(turnQuery.options.mcpServers, {}, "the Shoggoth server is set per turn, not at process start");
    assert.equal(ctx.sdk.mcpCalls.length, 2);
    assert.equal(ctx.sdk.mcpCalls.every((call) => call.child === resident), true);
    assert.equal(ctx.sdk.mcpCalls[0].servers.shoggoth.timeout, 2_147_000_000);
    assert.deepEqual(ctx.sdk.mcpCalls[0].servers.shoggoth.env, {
      SHOGGOTH_RUNTIME_MCP_GATE_NONCE: ctx.reservations[0].reservationId,
    });
    const turnSpawn = ctx.spawns.find((entry) => entry.child === resident);
    assert.equal(turnSpawn.command, ctx.binaryPath);
    assert.equal(turnSpawn.options.stdio.length, 3);
    assert.equal(turnSpawn.options.env.ANTHROPIC_API_KEY, undefined);
    // Real CLI 2.1.329: without USER, or with CLAUDE_CONFIG_DIR set even to
    // ~/.claude, a signed-in `claude auth status` reports loggedIn false.
    assert.equal(turnSpawn.options.env.USER, "fixture-user", "the CLI's Keychain lookup needs USER");
    assert.equal(turnSpawn.options.env.CLAUDE_CONFIG_DIR, undefined,
      "an unconfigured config directory is left to the CLI, as in the user's terminal");
    const authSpawn = ctx.spawns.find((entry) => entry.args[0] === "auth");
    assert.equal(authSpawn.options.env.USER, "fixture-user");
    assert.equal(authSpawn.options.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(turnSpawn.options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", "Claude Code auto memory stays off");
  } finally {
    await ctx.close();
  }
});

test("Claude Code projects an applied default outside its named model rows and accepts the saved alias", async () => {
  const ctx = fixture({ models: [
    { value: "default", displayName: "Default (recommended)" },
    { value: "sonnet", resolvedModel: "claude-sonnet-fixture", displayName: "Claude Sonnet" },
  ], appliedModel: "claude-configured-fixture" });
  try {
    const runtime = await ctx.adapter.acquire({
      runtime: "claude-code",
      runtimeProfileId: "shoggoth-claude-code-cli-v1",
      runtimeAccountId: NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
    }, { workspace: ctx.workspace });
    const { data } = await runtime.modelsList();
    assert.deepEqual(data.map(({ model, displayName, isDefault }) => [model, displayName, isDefault]), [
      ["claude-configured-fixture", "claude-configured-fixture", true],
      ["sonnet", "Claude Sonnet", false],
    ]);
    const { session } = await runtime.sessionStart({ source: "chat:saved-default", cwd: ctx.workspace, model: "default" });
    assert.ok(session.id);
  } finally { await ctx.close(); }
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
    const resident = ctx.sdk.turnQueries[0];
    assert.equal(resident.steers.length, 1, "the steer reached the running turn through the shared queue");
    assert.equal(resident.child.killed, false, "interrupting a turn keeps the session process");
    ctx.sdk.behavior.hold = false;
    await runTurn(runtime, ctx.workspace, started.session.id, "operation-after-interrupt", "继续");
    assert.equal(ctx.sdk.turnQueries.length, 1, "the next turn reuses the interrupted turn's process");
  } finally {
    await ctx.close();
  }
});

const PERMISSION = Object.freeze({ approvalPolicy: "on-request", sandbox: "workspace-write" });
const bindingFor = (runtimeProfileId) => ({
  runtime: "claude-code", runtimeProfileId, runtimeAccountId: NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
});

async function runTurn(runtime, workspace, sessionId, operationId, prompt, extra = {}) {
  const completions = [];
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type === "complete") completions.push(event);
  });
  runtime.registerServerRequestHandler("item/commandExecution/requestApproval", async () => ({ decision: "accept" }));
  try {
    const turn = await runtime.turnStart({
      sessionId, operationId, prompt, cwd: workspace, model: "sonnet", permissionPolicy: PERMISSION, ...extra,
    });
    await waitUntil(() => completions.some((event) => event.turnId === turn.turn.id), `${operationId} terminal`);
    return { turn, status: completions.find((event) => event.turnId === turn.turn.id).status };
  } finally {
    unsubscribe();
  }
}

test("Claude Code 常驻进程：同一会话跨 WorkRun 复用一个进程，每回合换上本 Run 的 MCP 门票", async () => {
  const ctx = fixture();
  try {
    const first = await ctx.adapter.acquire(bindingFor("resident-profile"), {
      workspace: ctx.workspace, permissionPolicy: PERMISSION, executionContract: { runId: "run-one" },
    });
    const second = await ctx.adapter.acquire(bindingFor("resident-profile"), {
      workspace: ctx.workspace, permissionPolicy: PERMISSION, executionContract: { runId: "run-two" },
    });
    assert.notEqual(first.host, second.host, "execution Hosts stay isolated per WorkRun");
    const started = await first.sessionStart({
      source: "chat:resident", cwd: ctx.workspace, model: "sonnet", permissionPolicy: PERMISSION,
    });
    assert.equal((await runTurn(first, ctx.workspace, started.session.id, "resident-one", "第一轮")).status, "completed");
    await second.sessionResume({
      sessionId: started.session.id, cwd: ctx.workspace, model: "sonnet", permissionPolicy: PERMISSION,
    });
    assert.equal((await runTurn(second, ctx.workspace, started.session.id, "resident-two", "第二轮")).status, "completed");
    assert.equal(ctx.sdk.turnQueries.length, 1, "one Claude Code process serves both turns");
    const resident = ctx.sdk.turnQueries[0].child;
    assert.equal(resident.killed, false);
    assert.deepEqual(ctx.sdk.prompts.map((prompt) => prompt.split("\n").at(-1)), ["第一轮", "第二轮"]);
    assert.deepEqual(ctx.reservations.map((entry) => entry.executionRunId), ["run-one", "run-two"]);
    assert.deepEqual(ctx.bindings.map((entry) => entry.parentPid), [resident.pid, resident.pid]);
    assert.deepEqual(ctx.revocations.map((entry) => entry.reservationId),
      ctx.reservations.map((entry) => entry.reservationId), "each turn's ticket is revoked when the turn ends");
    assert.deepEqual(ctx.sdk.mcpCalls.map((call) => call.servers.shoggoth.env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE),
      ctx.reservations.map((entry) => entry.reservationId), "each turn replaces the server with its own ticket");
    await ctx.adapter.stop(bindingFor("resident-profile"));
    assert.equal(resident.killed, true, "stopping the profile releases its resident process");
  } finally {
    await ctx.close();
  }
});

test("Claude Code 常驻进程：每回合都发 init 时同样复用并只报告一次开始", async () => {
  const ctx = fixture({ initPerTurn: true });
  try {
    const runtime = await ctx.adapter.acquire(bindingFor("init-profile"), { workspace: ctx.workspace, permissionPolicy: PERMISSION });
    const started = await runtime.sessionStart({ source: "chat:init", cwd: ctx.workspace, model: "sonnet", permissionPolicy: PERMISSION });
    const statuses = [];
    runtime.subscribe((event) => { if (event.method === "claude-code/system/init") statuses.push(event.turnId); });
    const one = await runTurn(runtime, ctx.workspace, started.session.id, "init-one", "一");
    const two = await runTurn(runtime, ctx.workspace, started.session.id, "init-two", "二");
    assert.deepEqual([one.status, two.status], ["completed", "completed"]);
    assert.deepEqual(statuses, [one.turn.turn.id, two.turn.turn.id]);
    assert.equal(ctx.sdk.turnQueries.length, 1);
  } finally {
    await ctx.close();
  }
});

test("Claude Code 常驻进程：启动参数变化时先等旧进程退出，再用 resume 重开", async () => {
  const ctx = fixture();
  try {
    const runtime = await ctx.adapter.acquire(bindingFor("replace-profile"), { workspace: ctx.workspace, permissionPolicy: PERMISSION });
    const started = await runtime.sessionStart({ source: "chat:replace", cwd: ctx.workspace, model: "sonnet", permissionPolicy: PERMISSION });
    await runTurn(runtime, ctx.workspace, started.session.id, "replace-one", "一");
    await runTurn(runtime, ctx.workspace, started.session.id, "replace-two", "二", { model: "opus" });
    assert.equal(ctx.sdk.turnQueries.length, 2);
    assert.equal(ctx.sdk.turnQueries[0].child.killed, true);
    assert.deepEqual(ctx.sdk.priorProcessesExited, [true, true],
      "two processes never write one native session at the same time");
    const [opened, reopened] = ctx.sdk.queryCalls.filter((call) => !Array.isArray(call.options.tools));
    assert.equal(opened.options.sessionId, started.session.id);
    assert.equal(opened.options.resume, undefined);
    assert.equal(reopened.options.resume, started.session.id);
    assert.equal(reopened.options.sessionId, undefined);
    assert.equal(reopened.options.model, "opus");
  } finally {
    await ctx.close();
  }
});

test("Claude Code 常驻进程：空闲到期释放，回合间进程退出后下一回合 resume", async () => {
  const idle = fixture({ liveIdleMs: 20 });
  try {
    const runtime = await idle.adapter.acquire(bindingFor("idle-profile"), { workspace: idle.workspace, permissionPolicy: PERMISSION });
    const started = await runtime.sessionStart({ source: "chat:idle", cwd: idle.workspace, model: "sonnet", permissionPolicy: PERMISSION });
    await runTurn(runtime, idle.workspace, started.session.id, "idle-one", "一");
    await waitUntil(() => idle.sdk.turnQueries[0].child.killed, "idle release");
    assert.equal((await runTurn(runtime, idle.workspace, started.session.id, "idle-two", "二")).status, "completed");
    assert.equal(idle.sdk.turnQueries.length, 2);
    assert.equal(idle.sdk.queryCalls.filter((call) => !Array.isArray(call.options.tools))[1].options.resume, started.session.id);
  } finally {
    await idle.close();
  }
  const crash = fixture();
  try {
    const runtime = await crash.adapter.acquire(bindingFor("crash-profile"), { workspace: crash.workspace, permissionPolicy: PERMISSION });
    const started = await runtime.sessionStart({ source: "chat:crash", cwd: crash.workspace, model: "sonnet", permissionPolicy: PERMISSION });
    await runTurn(runtime, crash.workspace, started.session.id, "crash-one", "一");
    crash.sdk.turnQueries[0].child.finish(1, null);
    await waitUntil(() => crash.pool.liveSessions.entries.size === 0, "exited process removed");
    assert.equal((await runTurn(runtime, crash.workspace, started.session.id, "crash-two", "二")).status, "completed");
    assert.equal(crash.sdk.turnQueries.length, 2);
  } finally {
    await crash.close();
  }
});

test("Claude Code MCP 连接失败时回合确定未受理且退役该进程", async () => {
  const ctx = fixture({ mcpError: true });
  try {
    const runtime = await ctx.adapter.acquire(bindingFor("mcp-profile"), { workspace: ctx.workspace, permissionPolicy: PERMISSION });
    const started = await runtime.sessionStart({ source: "chat:mcp", cwd: ctx.workspace, model: "sonnet", permissionPolicy: PERMISSION });
    await assert.rejects(runtime.turnStart({
      sessionId: started.session.id, operationId: "mcp-one", prompt: "一", cwd: ctx.workspace, model: "sonnet", permissionPolicy: PERMISSION,
    }), { code: "CLAUDE_CODE_MCP_UNAVAILABLE" });
    assert.equal(ctx.sdk.prompts.length, 0, "the prompt never reaches Claude Code");
    const read = await runtime.sessionRead({ sessionId: started.session.id, includeTurns: true });
    assert.equal(read.session.turns[0].status, "failed");
    assert.equal(ctx.revocations.length, 1);
    await waitUntil(() => ctx.sdk.turnQueries[0].child.killed, "process retired");
  } finally {
    await ctx.close();
  }
});

test("Claude Code 的 Shoggoth 产品工具以规范 MCP 权限请求交给 Service 产品策略", async () => {
  const ctx = fixture({ permissionTool: "mcp__shoggoth__memory_search" });
  try {
    const runtime = await ctx.adapter.acquire(bindingFor("product-tool-profile"), { workspace: ctx.workspace, permissionPolicy: PERMISSION });
    const started = await runtime.sessionStart({ source: "chat:product-tool", cwd: ctx.workspace, model: "sonnet", permissionPolicy: PERMISSION });
    const requests = [];
    runtime.registerServerRequestHandler("mcpServer/elicitation/request", async (params) => {
      requests.push(params);
      return { action: "accept", content: {} };
    });
    const completions = [];
    runtime.subscribe((event) => { if (event.type === "complete") completions.push(event); });
    let commandApprovals = 0;
    runtime.registerServerRequestHandler("item/commandExecution/requestApproval", async () => {
      commandApprovals += 1;
      return { decision: "decline" };
    });
    await runtime.turnStart({ sessionId: started.session.id, operationId: "product-tool", prompt: "search memory",
      cwd: ctx.workspace, model: "sonnet", permissionPolicy: PERMISSION });
    await waitUntil(() => completions.length === 1, "product tool turn");
    assert.equal(commandApprovals, 0, "product tools never become command approvals");
    assert.equal(requests.length, 1);
    assert.deepEqual(parseMcpToolPermission({ ...requests[0], method: "mcpServer/elicitation/request", kind: "mcp_elicitation" }),
      { serverName: "shoggoth", toolName: "memory_search" });
    assert.equal(ctx.sdk.lastPermissionDecision.behavior, "allow");
  } finally {
    await ctx.close();
  }
});

test("Claude Code 显式配置的 CLAUDE_CONFIG_DIR 原样传给 CLI", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-claude-config-"));
  const ctx = fixture({ parentEnv: { CLAUDE_CONFIG_DIR: configDir } });
  try {
    const runtime = await ctx.adapter.acquire(bindingFor("config-profile"), { workspace: ctx.workspace, permissionPolicy: PERMISSION });
    const started = await runtime.sessionStart({ source: "chat:config", cwd: ctx.workspace, model: "sonnet", permissionPolicy: PERMISSION });
    await runTurn(runtime, ctx.workspace, started.session.id, "config-one", "一");
    const spawn = ctx.spawns.find((entry) => entry.child === ctx.sdk.turnQueries[0].child);
    assert.equal(spawn.options.env.CLAUDE_CONFIG_DIR, fs.realpathSync(configDir));
  } finally {
    await ctx.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("Claude Code forwards the parent's privacy preferences to auth, quota and chat processes", async () => {
  const privacy = {
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "true",
    DO_NOT_TRACK: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const desktopFlags = {
    SHOGGOTH_CLAUDE_CODE_OPT_OUTS: "DISABLE_ERROR_REPORTING,DO_NOT_TRACK,ANTHROPIC_API_KEY",
    DISABLE_ERROR_REPORTING: "0",
  };
  for (const [parentEnv, expected] of [
    [privacy, privacy],
    [desktopFlags, { DISABLE_ERROR_REPORTING: "1", DO_NOT_TRACK: "1" }],
    [{}, {}],
  ]) {
    const ctx = fixture({ parentEnv, sdkEnv: { DISABLE_TELEMETRY: "0" } });
    try {
      const runtime = await ctx.adapter.acquire(bindingFor("privacy-profile"), {
        workspace: ctx.workspace, permissionPolicy: PERMISSION,
      });
      await runtime.authenticationState();
      await runtime.accountQuotaRead();
      const started = await runtime.sessionStart({ source: "chat:privacy", cwd: ctx.workspace, model: "sonnet", permissionPolicy: PERMISSION });
      await runTurn(runtime, ctx.workspace, started.session.id, "privacy-one", "test");

      assert.ok(ctx.spawns.some(({ args }) => args[0] === "auth"));
      assert.ok(ctx.sdk.usageCalls.length > 0);
      assert.equal(ctx.sdk.turnQueries.length, 1);
      for (const { args, options } of ctx.spawns) {
        for (const name of Object.keys(privacy)) {
          assert.equal(options.env[name], expected[name], `${args[0]}: ${name}`);
        }
        assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
        assert.equal(options.env.SHOGGOTH_CLAUDE_CODE_OPT_OUTS, undefined);
      }
    } finally {
      await ctx.close();
    }
  }
});

test("Claude Code 额度读取映射 claude.ai 计划窗口，不适用的账号报告 unsupported", async () => {
  const ctx = fixture();
  try {
    const runtime = await ctx.adapter.acquire(bindingFor("quota-profile"), { permissionPolicy: PERMISSION });
    assert.equal(runtime.capabilities["account.quota.read"], true);
    const quota = await runtime.accountQuotaRead();
    assert.equal(validQuotaSnapshot(quota), true);
    assert.deepEqual(quota.windows, [
      { label: null, durationMinutes: 300, usedPercent: 42, resetsAt: Date.parse("2026-11-23T10:00:00.000Z") },
      { label: null, durationMinutes: 10_080, usedPercent: 7.5, resetsAt: Date.parse("2026-11-27T00:00:00.000Z") },
    ]);
    assert.equal(quota.accountName, "dev@example.test · Claude Max");
    assert.match(quota.quotaScope, /^[a-f0-9]{64}$/u);
    assert.deepEqual(ctx.sdk.usageCalls, [{ skipBehaviors: true }]);
    ctx.sdk.behavior.noPlanUsage = true;
    assert.deepEqual(await runtime.accountQuotaRead(), { status: "unsupported" });
  } finally {
    await ctx.close();
  }
  const opus = claudeQuotaSnapshot({
    subscription_type: "claude_max_20x_subscription",
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day_opus: { utilization: 99, resets_at: null } },
  }, null, { home: "/tmp/claude-home", checkedAt: 1 });
  assert.deepEqual(opus.windows, [{ label: "Opus", durationMinutes: 10_080, usedPercent: 99, resetsAt: null }]);
  assert.equal(opus.accountName, "Claude Max 20x");
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
