#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");

const ROOT = path.resolve(__dirname, "..");
const {
  WorkRunCoordinator,
} = require(path.join(ROOT, "app", "agent-service", "work-run-coordinator.js"));
const {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_SEC,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
} = require(path.join(ROOT, "app", "agent-service", "interactive-timeouts.js"));
const {
  LEGAL_TRANSITIONS: INBOX_LEGAL_TRANSITIONS,
} = require(path.join(ROOT, "app", "agent-service", "pending-command-inbox.js"));
const {
  createMcpStdioHandler,
  runMcpStdioSession,
} = require(path.join(ROOT, "app", "shoggoth-mcp-helper.js"));
const {
  CodexRuntimeHost,
} = require(path.join(ROOT, "app", "agent-service", "codex-runtime-host.js"));
const {
  resolveServicePaths,
} = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const {
  shoggothProductDeveloperInstructions,
} = require(path.join(ROOT, "app", "agent-service", "product-capability-manifest.js"));
const {
  RuntimeAccountAdmission,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account-admission.js"));
const {
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  DEFAULT_RUNTIME_ACCOUNTS,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const {
  runtimeAccountBackoffError,
} = require(path.join(ROOT, "app", "agent-service", "runtime-stage-error.js"));
const {
  canonicalFederationResultToolName,
  federationTaskResultFromOutput,
  serializeFederationTaskResult,
} = require(path.join(ROOT, "app", "agent-service", "federation-tool-identity.js"));

const SESSION_KEY = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "profile-shoggoth";
const RUNTIME_ACCOUNT_ID = "runtime-account-default";
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function codexRuntimeEnvironment() {
  const home = path.join(os.tmpdir(), "shoggoth-work-run-coordinator-codex-home");
  return Object.freeze({
    runtime: "codex",
    runtimeAccountId: RUNTIME_ACCOUNT_ID,
    home,
    binaryPath: process.execPath,
    launchArgs: Object.freeze(["app-server"]),
    spawnEnv: Object.freeze({ HOME: home, CODEX_HOME: home }),
    configurationMode: "overlay",
  });
}

test("通用 MCP 包装器只规范化明确指向 Shoggoth 的联邦结果工具", () => {
  assert.equal(canonicalFederationResultToolName({
    name: "call_mcp_tool",
    input: { server_name: "shoggoth", tool_name: "federation_task_get" },
  }), "federation_task_get");
  assert.equal(canonicalFederationResultToolName({
    name: "CallMcpTool",
    input: { server: "shoggoth", toolName: "federation_agent_message" },
  }), "federation_agent_message");
  assert.equal(canonicalFederationResultToolName({
    name: "use_tool",
    input: { toolName: "shoggoth__federation_agent_run" },
  }), "federation_agent_run");
  assert.equal(canonicalFederationResultToolName({
    name: "use_tool",
    input: { server: "untrusted", toolName: "federation_task_get" },
  }), null);
  assert.equal(canonicalFederationResultToolName({
    name: "untrusted_wrapper",
    input: { server: "shoggoth", toolName: "federation_task_get" },
  }), null);

  const raw = {
    agent: { backendId: "grok-build", agentId: "shoggoth-grok", name: "Grok" },
    task: {
      taskId: "task-one", sessionKey: "private-session", status: "completed", turn: 1,
      waitingFor: null, result: "hello", errorCode: null,
    },
    handle: "private-handle",
  };
  const projected = federationTaskResultFromOutput(
    "federation_task_get",
    `human content\n${JSON.stringify(raw)}${JSON.stringify(raw)}`,
  );
  assert.deepEqual(projected, {
    agent: { backendId: "grok-build", agentId: "shoggoth-grok", name: "Grok" },
    task: {
      taskId: "task-one", status: "completed", turn: 1, waitingFor: null,
      result: "hello", errorCode: null,
    },
  });
  assert.equal(JSON.stringify(projected).includes("private-"), false);

  const escaped = structuredClone(projected);
  escaped.task.result = "\n".repeat(32 * 1024);
  const serialized = serializeFederationTaskResult(escaped, 44 * 1024);
  assert.ok(serialized);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 44 * 1024);
  const encoded = JSON.parse(serialized).task;
  assert.equal(encoded.resultEncoding, "base64-utf8");
  assert.equal(Buffer.from(encoded.resultBase64, "base64").toString("utf8"), escaped.task.result);
});

test("审批默认持续等待，普通输入等待 5 分钟且 transport 留有终态收敛余量", () => {
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, null);
  assert.equal(DEFAULT_PROMPT_TIMEOUT_MS, 5 * 60 * 1_000);
  assert.equal(DEFAULT_SERVER_REQUEST_TIMEOUT_MS, DEFAULT_PROMPT_TIMEOUT_MS + 30_000);
  assert.equal(DEFAULT_MCP_TOOL_TIMEOUT_MS, 2_147_000_000);
  assert.equal(DEFAULT_MCP_TOOL_TIMEOUT_SEC, DEFAULT_MCP_TOOL_TIMEOUT_MS / 1_000);
  const host = new CodexRuntimeHost({
    runtimeProfileId: "runtime-timeout-defaults",
    runtimeAccountId: RUNTIME_ACCOUNT_ID,
    runtimeEnvironment: codexRuntimeEnvironment(),
    paths: resolveServicePaths({
      trustedRoot: os.tmpdir(),
      stateRoot: path.join(os.tmpdir(), "shoggoth-timeout-default-state"),
      profileRoot: path.join(os.tmpdir(), "shoggoth-timeout-default-profile"),
      cacheRoot: path.join(os.tmpdir(), "shoggoth-timeout-default-cache"),
    }),
    repoRoot: ROOT,
  });
  assert.equal(host.serverRequestTimeoutMs, DEFAULT_SERVER_REQUEST_TIMEOUT_MS);
});

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createRuntimeAccountAdmission(log, options = {}) {
  let generation = options.generation ?? 1;
  const active = new Set();
  return {
    active,
    admit(input) {
      log.push(["account.admit", clone(input)]);
      if (options.rejected) return { disposition: "rejected", reason: options.rejected, generation, retryAt: null };
      if (options.queued === true) {
        return {
          disposition: "queued",
          reason: "RUNTIME_ACCOUNT_ACTIVE_LIMIT",
          generation,
          retryAt: null,
        };
      }
      active.add(input.runId);
      return { disposition: "started", reason: null, generation, retryAt: null };
    },
    release(input) {
      log.push(["account.release", clone(input)]);
      return active.delete(input.runId);
    },
    assertGeneration(input) {
      log.push(["account.assertGeneration", clone(input)]);
      if (input.generation !== generation) throw codedError("RUNTIME_ACCOUNT_GENERATION_STALE");
      return true;
    },
    noteBackoff(input) {
      log.push(["account.noteBackoff", clone(input)]);
      return input.retryAt;
    },
    noteRateLimitBackoff(input) {
      this.assertGeneration(input);
      log.push(["account.noteRateLimitBackoff", clone(input)]);
      return input.retryAt;
    },
    bumpGeneration() { generation += 1; },
  };
}

function createRuntimeSessionOwnership(log, options = {}) {
  const records = new Map();
  const key = (runtimeAccountId, sessionId) => JSON.stringify([runtimeAccountId, sessionId]);
  return {
    records,
    claim(input) {
      log.push(["ownership.claim", clone(input)]);
      if (options.claimError) throw codedError(options.claimError);
      const record = { ...clone(input), status: "active" };
      records.set(key(record.runtimeAccountId, record.sessionId), record);
      return clone(record);
    },
    assertOwned(input) {
      log.push(["ownership.assertOwned", clone(input)]);
      const record = records.get(key(input.binding.runtimeAccountId, input.sessionId));
      if (!record
        || record.runtime !== input.binding.runtime
        || record.runtimeProfileId !== input.binding.runtimeProfileId
        || record.profileId !== input.profileId
        || record.workspace !== input.workspace) {
        throw codedError("RUNTIME_SESSION_NOT_OWNED");
      }
      return clone(record);
    },
  };
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`${label} timed out`);
}

async function readJsonLineFileEventually(filePath, timeoutMs, label) {
  let parsed = null;
  await waitUntil(() => {
    try {
      const serialized = fs.readFileSync(filePath, "utf8");
      if (!serialized.endsWith("\n")) return false;
      parsed = JSON.parse(serialized);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  }, timeoutMs, label);
  return parsed;
}

function createRealTransportHost(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-host-transport-"));
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const responsePath = path.join(root, "elicitation-response.json");
  const host = new CodexRuntimeHost({
    runtimeProfileId: options.runtimeProfileId || "runtime-default",
    runtimeAccountId: RUNTIME_ACCOUNT_ID,
    runtimeEnvironment: codexRuntimeEnvironment(),
    paths,
    repoRoot: ROOT,
    packageVersion: "0.8.41",
    probeBinary: async () => {},
    spawnEnv: {
      CODEX_FAKE_BEHAVIOR: options.behavior || "mcp-elicitation",
      CODEX_FAKE_PROFILE: options.runtimeProfileId || "runtime-default",
      CODEX_FAKE_ELICITATION_MODE: options.mode || "valid",
      CODEX_FAKE_ELICITATION_RESPONSE_PATH: responsePath,
      ...(options.spawnEnv || {}),
    },
    spawnProcess(_command, _args, spawnOptions) {
      return spawn(process.execPath, [options.fixturePath
        || path.join(ROOT, "scripts", "fixtures", "codex-app-server-fake.cjs")], spawnOptions);
    },
    requestTimeoutMs: options.requestTimeoutMs || 500,
    initializeTimeoutMs: 500,
    serverRequestTimeoutMs: options.serverRequestTimeoutMs || 500,
    shutdownGraceMs: 100,
    killGraceMs: 100,
  });
  return {
    host,
    responsePath,
    async close() {
      await host.stop().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function commandFingerprint(input) {
  return crypto.createHash("sha256").update(JSON.stringify([
    input.operationId,
    input.runId,
    input.sessionKey,
    input.prompt,
    input.createdAt,
  ])).digest("hex");
}

class FakeDispatcher {
  constructor(log, options = {}) {
    this.log = log;
    this.runs = new Map();
    this.busy = options.busy === true;
    this.enqueueFailures = options.enqueueFailures || 0;
    this.canonicalWorkspace = options.canonicalWorkspace || null;
    this.forbiddenPromptSeen = false;
    this.transitionFailures = new Map(Object.entries(options.transitionFailures || {}));
    this.getRunCalls = 0;
  }

  enqueue(input) {
    this.log.push("dispatcher.enqueue");
    if (Object.prototype.hasOwnProperty.call(input, "prompt")) this.forbiddenPromptSeen = true;
    if (this.enqueueFailures > 0) {
      this.enqueueFailures -= 1;
      throw codedError("INJECTED_ENQUEUE_FAILURE");
    }
    const existing = [...this.runs.values()]
      .find((run) => run.idempotencyKey === input.idempotencyKey);
    if (existing) return clone(existing);
    const run = {
      ...clone(input),
      workspace: input.workspace === null ? null : (this.canonicalWorkspace || input.workspace),
      status: "queued",
      runtimeSessionRef: null,
      runtimeTurnRef: null,
      resultSummary: null,
      errorCode: null,
    };
    this.runs.set(run.id, run);
    return clone(run);
  }

  admit(id, options) {
    this.log.push("dispatcher.admit");
    this.lastAdmission = clone(options);
    const run = this.runs.get(id);
    if (!run) throw codedError("WORK_RUN_NOT_FOUND");
    if (this.busy) return { disposition: "queued", reason: "PROFILE_ACTIVE_LIMIT", run: clone(run) };
    run.status = "starting";
    if (options && Object.prototype.hasOwnProperty.call(options, "contextSnapshotId")) {
      run.contextSnapshotId = options.contextSnapshotId;
    }
    return { disposition: "started", reason: null, run: clone(run) };
  }

  transition(id, status, patch = {}) {
    this.log.push(`dispatcher.transition:${status}`);
    const failure = this.transitionFailures.get(status);
    if (failure) {
      this.transitionFailures.delete(status);
      throw codedError(failure);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "prompt")) this.forbiddenPromptSeen = true;
    const run = this.runs.get(id);
    if (!run) throw codedError("WORK_RUN_NOT_FOUND");
    run.status = status;
    Object.assign(run, clone(patch));
    if (status !== "waiting_approval" && status !== "waiting_input") run.waitingRequestId = null;
    return clone(run);
  }

  getRun(id) {
    this.getRunCalls += 1;
    return clone(this.runs.get(id) || null);
  }
  listRuns(query = {}) {
    return [...this.runs.values()]
      .filter((run) => !query.source || run.source === query.source)
      .filter((run) => !query.sourceId || run.sourceId === query.sourceId)
      .map(clone);
  }

  recoverActiveRunAfterServiceRestart(id) {
    this.log.push("dispatcher.recover");
    const run = this.runs.get(id);
    if (!run) throw codedError("WORK_RUN_NOT_FOUND");
    return clone(run);
  }
}

class FakeInbox {
  constructor(log, options = {}) {
    this.log = log;
    this.commands = new Map();
    this.transitionFailures = new Map(Object.entries(options.inboxTransitionFailures || {}));
  }

  enqueue(input) {
    this.log.push("inbox.enqueue");
    const existing = this.commands.get(input.operationId);
    if (existing) {
      if (existing.state === "completed" || existing.state === "canceled") {
        if (existing.fingerprint !== commandFingerprint(input)) {
          throw codedError("PENDING_COMMAND_IDEMPOTENCY_CONFLICT");
        }
        return clone(existing);
      }
      const comparable = ["operationId", "runId", "sessionKey", "prompt", "createdAt"];
      if (comparable.some((field) => existing[field] !== input[field])) {
        throw codedError("PENDING_COMMAND_IDEMPOTENCY_CONFLICT");
      }
      return clone(existing);
    }
    const command = { ...clone(input), state: "pending" };
    this.commands.set(command.operationId, command);
    return clone(command);
  }

  get(operationId) { return clone(this.commands.get(operationId) || null); }
  list(query = {}) {
    return [...this.commands.values()]
      .filter((command) => query.state === undefined || command.state === query.state)
      .map(clone);
  }

  transition(operationId, state) {
    this.log.push(`inbox.transition:${state}`);
    const command = this.commands.get(operationId);
    if (!command) throw codedError("PENDING_COMMAND_NOT_FOUND");
    if (command.state === state) return clone(command);
    if (!INBOX_LEGAL_TRANSITIONS[command.state]?.has(state)) {
      throw codedError("PENDING_COMMAND_TRANSITION_INVALID");
    }
    const failure = this.transitionFailures.get(state);
    if (failure) {
      this.transitionFailures.delete(state);
      throw codedError(failure);
    }
    if (state === "completed" || state === "canceled") {
      const tombstone = {
        operationId,
        fingerprint: commandFingerprint(command),
        state,
        createdAt: command.createdAt,
        finishedAt: 1_000,
      };
      this.commands.set(operationId, tombstone);
      return clone(tombstone);
    }
    command.state = state;
    return clone(command);
  }
}

class FakeChatSessionStore {
  constructor(log, status = "draft", threadId = null, workspace = "/tmp/shoggoth-workspace") {
    this.log = log;
    this.session = {
      id: "33333333-3333-4333-8333-333333333333",
      sessionKey: SESSION_KEY,
      profileId: PROFILE_ID,
      workspace,
      modelOverride: null,
      status,
      runtimeSessionId: threadId,
    };
    this.binding = null;
    if (status === "ready" && threadId) {
      this.binding = {
        operationId: "bind-existing",
        sessionKey: SESSION_KEY,
        threadSource: `shoggoth:${SESSION_KEY}:bind-existing`,
        state: "bound",
        runtimeSessionId: threadId,
        createdAt: 1,
      };
    }
  }

  getSession(sessionKey) {
    return sessionKey === this.session.sessionKey ? clone(this.session) : null;
  }

  requestBinding(sessionKey, operationId, createdAt) {
    this.log.push("sessions.requestBinding");
    if (this.binding) return clone(this.binding);
    this.session.status = "binding";
    this.binding = {
      operationId,
      sessionKey,
      threadSource: `shoggoth:${sessionKey}:${operationId}`,
      state: "pending",
      runtimeSessionId: null,
      createdAt,
    };
    return clone(this.binding);
  }

  completeBinding(sessionKey, operationId, threadId) {
    this.log.push("sessions.completeBinding");
    assert.equal(sessionKey, this.session.sessionKey);
    assert.equal(operationId, this.binding.operationId);
    this.binding.state = "bound";
    this.binding.runtimeSessionId = threadId;
    this.session.status = "ready";
    this.session.runtimeSessionId = threadId;
    return clone(this.session);
  }

  recoverBinding(input) {
    this.log.push("sessions.recoverBinding");
    assert.equal(input.threadSource, this.binding.threadSource);
    return this.completeBinding(this.binding.sessionKey, this.binding.operationId, input.runtimeSessionId);
  }

  getBinding(sessionKey) {
    return sessionKey === this.session.sessionKey ? clone(this.binding) : null;
  }

  replaceBoundRuntimeSession(input) {
    this.log.push("sessions.replaceBoundRuntimeSession");
    assert.equal(input.sessionKey, this.session.sessionKey);
    assert.equal(input.operationId, this.binding.operationId);
    assert.equal(input.expectedRuntimeSessionId, this.session.runtimeSessionId);
    this.session.runtimeSessionId = input.runtimeSessionId;
    this.binding.runtimeSessionId = input.runtimeSessionId;
    return clone(this.session);
  }

  listPendingBindings() {
    return this.binding?.state === "pending" ? [clone(this.binding)] : [];
  }
}

class FakeHost {
  constructor(log, options = {}) {
    this.log = log;
    this.threads = clone(options.threads || []);
    this.pageSize = options.pageSize || 100;
    this.threadStartCalls = 0;
    this.turnStartCalls = 0;
    this.resumeCalls = 0;
    this.lastTurnStartParams = null;
    this.lastThreadStartParams = null;
    this.lastResumeParams = null;
    this.loseThreadStartResponse = options.loseThreadStartResponse === true;
    this.threadStartError = options.threadStartError || null;
    this.turnStartError = options.turnStartError || null;
    this.loseTurnStartResponse = options.loseTurnStartResponse === true;
    this.partialHistory = options.partialHistory === true;
    this.omitThreadSourceInStartResponse = options.omitThreadSourceInStartResponse === true;
    this.unreadableFreshThreadUntilTurnStart = options.unreadableFreshThreadUntilTurnStart === true;
    this.freshUnreadableThreadIds = new Set();
    this.requireLoaded = options.requireLoaded === true;
    this.loadedThreads = new Set(options.loadedThreadIds
      || (this.requireLoaded ? [] : this.threads.map((thread) => thread.id)));
    this.subscribers = new Set();
    this.serverRequestHandlers = new Map();
    this.turnSteerCalls = 0;
    this.turnInterruptCalls = 0;
    this.accountReadCalls = 0;
    this.authenticationStateCalls = 0;
    this.lastTurnSteerParams = null;
    this.lastTurnInterruptParams = null;
    this.steerGate = options.steerGate || null;
    this.interruptGate = options.interruptGate || null;
    this.termination = deferred();
    this.terminated = this.termination.promise;
    this.terminated.catch(() => {});
    if (options.accountReadSupported !== false) {
      const accountReadResult = Object.prototype.hasOwnProperty.call(options, "accountReadResult")
        ? options.accountReadResult
        : { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
      this.accountRead = async () => {
        this.log.push("host.accountRead");
        this.accountReadCalls += 1;
        return clone(accountReadResult);
      };
    }
    if (Object.prototype.hasOwnProperty.call(options, "authenticationStateResult")) {
      this.authenticationState = () => {
        this.log.push("host.authenticationState");
        this.authenticationStateCalls += 1;
        return clone(options.authenticationStateResult);
      };
    }
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  registerServerRequestHandler(method, handler) {
    this.log.push(`host.registerServerRequestHandler:${method}`);
    this.serverRequestHandlers.set(method, handler);
    return () => {
      this.log.push(`host.unregisterServerRequestHandler:${method}`);
      if (this.serverRequestHandlers.get(method) === handler) {
        this.serverRequestHandlers.delete(method);
      }
    };
  }

  request(method, params, id = 1) {
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) return Promise.reject(codedError("CODEX_SERVER_HANDLER_NOT_FOUND"));
    return handler(clone(params), { id, method });
  }

  emit(event) {
    for (const listener of [...this.subscribers]) listener(clone(event));
  }

  terminate(error = codedError("HOST_TERMINATED")) {
    this.termination.reject(error);
  }

  async threadList(params) {
    this.log.push("host.threadList");
    const offset = params.cursor ? Number(params.cursor) : 0;
    const partition = this.threads.filter((thread) => (thread.archived === true) === params.archived);
    const data = partition.slice(offset, offset + this.pageSize).map(clone);
    const next = offset + this.pageSize;
    return { data, nextCursor: next < partition.length ? String(next) : null };
  }

  async threadStart(params) {
    this.log.push("host.threadStart");
    this.threadStartCalls += 1;
    this.lastThreadStartParams = clone(params);
    if (this.threadStartError) throw this.threadStartError;
    const thread = {
      id: `thread-created-${this.threadStartCalls}`,
      threadSource: params.threadSource,
      turns: [],
      archived: false,
    };
    this.threads.push(thread);
    this.loadedThreads.add(thread.id);
    if (this.unreadableFreshThreadUntilTurnStart) {
      this.freshUnreadableThreadIds.add(thread.id);
    }
    if (this.loseThreadStartResponse) {
      this.loseThreadStartResponse = false;
      throw codedError("RPC_RESPONSE_LOST");
    }
    const returned = clone(thread);
    if (this.omitThreadSourceInStartResponse) delete returned.threadSource;
    return { thread: returned };
  }

  async threadResume(params) {
    this.log.push("host.threadResume");
    this.resumeCalls += 1;
    this.lastResumeParams = clone(params);
    const thread = this.threads.find((candidate) => candidate.id === params.threadId)
      || { id: params.threadId, threadSource: null, turns: [] };
    if (thread.archived === true) throw codedError("THREAD_ARCHIVED");
    if (!this.threads.some((candidate) => candidate.id === params.threadId)) this.threads.push(thread);
    this.loadedThreads.add(params.threadId);
    return { thread: clone(thread) };
  }

  async threadInjectItems(params) {
    this.log.push("host.threadInjectItems");
    assert.ok(this.loadedThreads.has(params.threadId));
    this.lastInjectedItems = clone(params);
    return {};
  }

  async threadRead(params) {
    this.log.push("host.threadRead");
    if (this.freshUnreadableThreadIds.has(params.threadId)) {
      throw codedError("RPC_REMOTE_ERROR");
    }
    if (this.requireLoaded && !this.loadedThreads.has(params.threadId)) {
      throw codedError("THREAD_NOT_LOADED");
    }
    const thread = this.threads.find((candidate) => candidate.id === params.threadId);
    if (!thread) throw codedError("THREAD_NOT_FOUND");
    const result = clone(thread);
    if (this.partialHistory && result.turns[0]) result.turns[0].itemsView = "summary";
    return { thread: result };
  }

  async turnStart(params) {
    this.log.push("host.turnStart");
    if (this.requireLoaded && !this.loadedThreads.has(params.threadId)) {
      throw codedError("THREAD_NOT_LOADED");
    }
    this.turnStartCalls += 1;
    this.lastTurnStartParams = clone(params);
    if (this.turnStartError) throw this.turnStartError;
    const thread = this.threads.find((candidate) => candidate.id === params.threadId);
    if (!thread) throw codedError("THREAD_NOT_FOUND");
    this.freshUnreadableThreadIds.delete(params.threadId);
    const turn = {
      id: `turn-${this.turnStartCalls}`,
      status: "inProgress",
      itemsView: "full",
      items: [{ type: "userMessage", id: `message-${this.turnStartCalls}`, clientId: params.clientUserMessageId }],
    };
    thread.turns.push(turn);
    if (this.loseTurnStartResponse) {
      this.loseTurnStartResponse = false;
      throw codedError("RPC_RESPONSE_LOST");
    }
    return { turn: clone(turn) };
  }

  async turnSteer(params) {
    this.log.push("host.turnSteer");
    this.turnSteerCalls += 1;
    this.lastTurnSteerParams = clone(params);
    if (this.steerGate) await this.steerGate.promise;
    return { turnId: params.expectedTurnId };
  }

  async turnInterrupt(params) {
    this.log.push("host.turnInterrupt");
    this.turnInterruptCalls += 1;
    this.lastTurnInterruptParams = clone(params);
    if (this.interruptGate) await this.interruptGate.promise;
    return {};
  }
}

function fixture(options = {}) {
  const log = [];
  const dispatcher = options.dispatcher || new FakeDispatcher(log, options);
  const inbox = options.inbox || new FakeInbox(log, options);
  const sessions = options.sessions
    || new FakeChatSessionStore(
      log,
      options.sessionStatus,
      options.threadId,
      options.sessionWorkspace === undefined ? "/tmp/shoggoth-workspace" : options.sessionWorkspace,
    );
  if (!options.sessions) sessions.session.modelOverride = options.modelOverride ?? null;
  if (!options.sessions) sessions.session.permissionMode = options.permissionMode ?? null;
  const host = options.host || new FakeHost(log, options);
  const runtimeGate = options.runtimeGate || null;
  const runtimeProfileId = options.runtimeProfileId || "runtime-default";
  let runtimeAcquireCalls = 0;
  const runtimePool = {
    async get(binding) {
      log.push("runtimePool.get");
      runtimeAcquireCalls += 1;
      assert.deepEqual(binding, {
        runtime: options.runtime || "codex",
        runtimeProfileId,
        runtimeAccountId: RUNTIME_ACCOUNT_ID,
      });
      if (runtimeGate) await runtimeGate.promise;
      if (runtimeAcquireCalls <= (options.runtimeAcquireFailures || 0)) {
        throw codedError("RPC_PROCESS_EXITED");
      }
      return host;
    },
  };
  const productStore = options.productStore || {
    defaultCwd: options.defaultCwd === undefined ? "/tmp/default-cwd" : options.defaultCwd,
    getAgentProfile(profileId) {
      assert.equal(profileId, PROFILE_ID);
      return {
        id: PROFILE_ID,
        agentId: "shoggoth-agent",
        name: options.profileName || "Shoggoth",
        ...(options.backendId === undefined ? {} : { backendId: options.backendId }),
        enabled: true,
        runtime: options.runtime || "codex",
        runtimeProfileId,
        runtimeAccountId: RUNTIME_ACCOUNT_ID,
        defaultModel: "gpt-test",
        providerRef: "chatgpt",
        defaultCwd: this.defaultCwd,
        concurrency: { maxActive: options.maxActive || 1, maxWorkspaceWrites: 1 },
        permissionPolicy: {
          approvalPolicy: "on-failure",
          sandbox: options.sandbox || "workspace-write",
        },
      };
    },
  };
  const usageRecords = [];
  const usageStore = options.usageStore || {
    record(input) {
      usageRecords.push(clone(input));
      return clone(input);
    },
  };
  let nextId = 0;
  const coordinator = new WorkRunCoordinator({
    dispatcher,
    productStore,
    usageStore,
    getNativeRuntimeConfig: options.getNativeRuntimeConfig,
    captureExecutionProviderRoute: options.captureExecutionProviderRoute,
    assertExecutionProviderRouteCurrent: options.assertExecutionProviderRouteCurrent,
    onRuntimeContextChanged: options.onRuntimeContextChanged,
    onRuntimeMcpRequest: options.onRuntimeMcpRequest,
    pluginRuntimeToolService: options.pluginRuntimeToolService,
    getCapabilityPolicyRevision: options.getCapabilityPolicyRevision,
    ...(options.runExecutionStore ? { runExecutionStore: options.runExecutionStore } : {}),
    ...(options.transcriptStore ? { transcriptStore: options.transcriptStore } : {}),
    chatSessionStore: sessions,
    inbox,
    ...(options.runtimeManager ? { runtimeManager: options.runtimeManager } : { runtimePool }),
    ...(options.runtimeAccountAdmission
      ? { runtimeAccountAdmission: options.runtimeAccountAdmission } : {}),
    ...(options.runtimeSessionOwnershipStore
      ? { runtimeSessionOwnershipStore: options.runtimeSessionOwnershipStore } : {}),
    now: options.now || (() => 1_000),
    randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    assertSecretSafe: options.assertSecretSafe || (() => true),
    sanitizeSummary: options.sanitizeSummary || ((value) => value),
    maxResultSummaryBytes: options.maxResultSummaryBytes,
    terminalRetryDelaysMs: options.terminalRetryDelaysMs,
    terminalRetryScheduler: options.terminalRetryScheduler,
    maxTerminalStreams: options.maxTerminalStreams,
    terminalStreamTtlMs: options.terminalStreamTtlMs,
    promptTimeoutMs: options.promptTimeoutMs,
    approvalTimeoutMs: options.approvalTimeoutMs,
    manualCompactionTimeoutMs: options.manualCompactionTimeoutMs,
    promptScheduler: options.promptScheduler,
    recoverOrphanedDomainRuns: options.recoverOrphanedDomainRuns,
    ...(options.productMcpApprovalPolicy
      ? { productMcpApprovalPolicy: options.productMcpApprovalPolicy } : {}),
    ...(options.contextCompiler ? { contextCompiler: options.contextCompiler } : {}),
    ...(options.conversationCheckpointStore ? { conversationCheckpointStore: options.conversationCheckpointStore } : {}),
    ...(options.onRunInteraction ? { onRunInteraction: options.onRunInteraction } : {}),
  });
  return {
    coordinator,
    dispatcher,
    inbox,
    sessions,
    host,
    log,
    productStore,
    usageRecords,
    runtimeAccountAdmission: options.runtimeAccountAdmission || null,
    runtimeSessionOwnershipStore: options.runtimeSessionOwnershipStore || null,
  };
}

function directRuntimeManager(host, runtime) {
  const mapSession = (thread) => {
    const { threadSource, ...rest } = thread;
    return { ...rest, source: threadSource };
  };
  const handle = {
    runtime,
    runtimeProfileId: "runtime-default",
    runtimeAccountId: RUNTIME_ACCOUNT_ID,
    terminated: host.terminated,
    registeredSecrets: [],
    subscribe: (listener) => host.subscribe(listener),
    registerServerRequestHandler: (method, handler) => (
      host.registerServerRequestHandler(method, handler)
    ),
    async sessionList(input) {
      const result = await host.threadList(input);
      return { ...result, data: result.data.map(mapSession) };
    },
    async sessionStart(input) {
      const result = await host.threadStart({ ...input, threadSource: input.source });
      return { session: mapSession(result.thread) };
    },
    async sessionResume(input) {
      const result = await host.threadResume({ ...input, threadId: input.sessionId });
      return { session: mapSession(result.thread) };
    },
    async sessionRead(input) {
      const result = await host.threadRead({ ...input, threadId: input.sessionId });
      return { session: mapSession(result.thread) };
    },
    turnStart(input) {
      return host.turnStart({
        ...input,
        threadId: input.sessionId,
        clientUserMessageId: input.operationId,
      });
    },
  };
  if (typeof host.authenticationState === "function") {
    handle.authenticationState = (options) => host.authenticationState(options);
  }
  return {
    async acquire(binding) {
      assert.equal(binding.runtime, runtime);
      return handle;
    },
    stop() {},
    stopAll() {},
  };
}

async function openFixture(options = {}) {
  const value = fixture(options);
  await value.coordinator.open();
  return value;
}

function recoveryStore() {
  const records = new Map();
  return { records,
    async put(run, contract, command, fence) {
      fence();
      records.set(run.id, clone({ contract, command }));
    },
    async get(run) { return clone(records.get(run.id) || null); },
    remove(run) { records.delete(run.id); },
  };
}

test("加密恢复描述写入失败时不创建原生会话或发送任务", async () => {
  const store = recoveryStore();
  store.put = async () => { throw new Error("private crypto failure"); };
  const value = await openFixture({ runExecutionStore: store });
  const { ack } = await sendAndDrain(value);
  assert.equal(value.dispatcher.getRun(ack.run.id).errorCode, "EXECUTION_BINDING_UNAVAILABLE");
  assert.equal(value.host.threadStartCalls, 0);
  assert.equal(value.host.turnStartCalls, 0);
  await value.coordinator.close();
});

test("Service重启核验原生已完成turn并恢复终态，不重新发送，清理执行描述", async () => {
  const store = recoveryStore();
  const first = await openFixture({ runExecutionStore: store });
  const { ack } = await sendAndDrain(first, { operationId: "recovery-completed" });
  assert.ok(store.records.has(ack.run.id));
  await first.coordinator.close();
  const threads = clone(first.host.threads);
  threads[0].turns[0].status = "completed";
  const second = await openFixture({ runExecutionStore: store, dispatcher: first.dispatcher,
    inbox: first.inbox, sessions: first.sessions, threads });
  assert.equal(second.dispatcher.getRun(ack.run.id).status, "completed");
  assert.equal(second.host.turnStartCalls, 0);
  assert.equal(second.host.threadStartCalls, 0);
  assert.equal(second.host.resumeCalls, 1);
  assert.equal(store.records.has(ack.run.id), false);
  assert.equal(second.inbox.get("recovery-completed").state, "completed");
  await second.coordinator.close();
});

test("Service重启仍在执行或历史不完整的旧turn不猜成功也不重发", async () => {
  for (const partialHistory of [false, true]) {
    const store = recoveryStore();
    const first = await openFixture({ runExecutionStore: store });
    const { ack } = await sendAndDrain(first, { operationId: `recovery-unknown-${partialHistory}` });
    await first.coordinator.close();
    const second = await openFixture({ runExecutionStore: store, dispatcher: first.dispatcher,
      inbox: first.inbox, sessions: first.sessions, threads: first.host.threads, partialHistory });
    const run = second.dispatcher.getRun(ack.run.id);
    assert.equal(run.status, "interrupted");
    assert.equal(run.errorCode, "RUNTIME_RECOVERY_UNAVAILABLE");
    assert.equal(second.host.turnStartCalls, 0);
    assert.equal(second.host.threadStartCalls, 0);
    await second.coordinator.close();
  }
});

test("starting crash-cut 已有原生operation时按持久冻结参数恢复且不重发", async () => {
  const store = recoveryStore();
  const first = await openFixture({ runExecutionStore: store });
  const { ack } = await sendAndDrain(first, { operationId: "recovery-starting" });
  await first.coordinator.close();
  first.dispatcher.runs.get(ack.run.id).status = "starting";
  const threads = clone(first.host.threads);
  threads[0].turns[0].status = "completed";
  const second = await openFixture({ runExecutionStore: store, dispatcher: first.dispatcher,
    inbox: first.inbox, sessions: first.sessions, threads });
  assert.equal(second.dispatcher.getRun(ack.run.id).status, "completed");
  assert.equal(second.host.turnStartCalls, 0);
  assert.equal(second.host.threadStartCalls, 0);
  await second.coordinator.close();
});

test("恢复时权限或命令binding变化即停止，不读取新CLI执行", async () => {
  for (const change of ["permission", "command"]) {
    const store = recoveryStore();
    const first = await openFixture({ runExecutionStore: store });
    const { ack } = await sendAndDrain(first, { operationId: `recovery-changed-${change}` });
    await first.coordinator.close();
    if (change === "command") store.records.get(ack.run.id).command.prompt = "changed";
    const second = await openFixture({ runExecutionStore: store, dispatcher: first.dispatcher,
      inbox: first.inbox, sessions: first.sessions, threads: first.host.threads,
      ...(change === "permission" ? { sandbox: "danger-full-access" } : {}) });
    assert.equal(second.dispatcher.getRun(ack.run.id).errorCode, "RUNTIME_RECOVERY_UNAVAILABLE");
    assert.equal(second.host.resumeCalls, 0);
    assert.equal(second.host.turnStartCalls, 0);
    await second.coordinator.close();
  }
});

test("interrupted 保留安全具体原因且任意CLI文本不会成为公共错误", async () => {
  for (const [code, expected] of [["ANTIGRAVITY_APPROVAL_FORMAT_UNSUPPORTED", "ANTIGRAVITY_APPROVAL_FORMAT_UNSUPPORTED"],
    ["DEEPSEEK_HARNESS_FRAME_INVALID", "RUNTIME_PROTOCOL_ERROR"],
    ["DEEPSEEK_HARNESS_WRITE_FAILED", "RUNTIME_CONNECTION_LOST"],
    ["PI_PROCESS_FAILED", "RUNTIME_CONNECTION_LOST"],
    ["GROK_ACP_OUTBOUND_FRAME_TOO_LARGE", "GROK_ACP_OUTBOUND_FRAME_TOO_LARGE"],
    ["AUTH_REQUIRED", "RUNTIME_AUTH_REQUIRED"], ["PRIVATE_UNTRUSTED_CODE", "RUNTIME_TURN_INTERRUPTED"]]) {
    const value = await openFixture();
    const { ack } = await sendAndDrain(value, { operationId: `cause-${code}` });
    const run = value.dispatcher.getRun(ack.run.id);
    const turn = value.host.threads[0].turns[0];
    Object.assign(turn, { status: "interrupted", errorCode: code, error: { message: "secret diagnostic" } });
    value.host.emit({ known: true, type: "complete", method: "turn/completed", threadId: run.runtimeSessionRef?.sessionId,
      turnId: run.runtimeTurnRef?.turnId, status: "interrupted" });
    await value.coordinator.waitForIdle(run.id);
    const terminal = value.dispatcher.getRun(run.id);
    assert.equal(terminal.errorCode, expected);
    assert.equal(JSON.stringify(terminal).includes("secret diagnostic"), false);
    await value.coordinator.close();
  }
});

test("native审批AbortSignal立即撤销卡片与旧答复权限并释放等待状态", async () => {
  const value = await openFixture();
  const { ack } = await sendAndDrain(value);
  const run = value.dispatcher.getRun(ack.run.id);
  const abort = new AbortController();
  const handler = value.host.serverRequestHandlers.get("item/commandExecution/requestApproval");
  const response = handler({ threadId: run.runtimeSessionRef?.sessionId, turnId: run.runtimeTurnRef?.turnId, itemId: "approval-item",
    command: "echo test", cwd: run.workspace }, { signal: abort.signal });
  assert.equal(value.dispatcher.getRun(run.id).status, "waiting_approval");
  abort.abort();
  assert.deepEqual(await response, { decision: "cancel" });
  await value.coordinator.waitForIdle(run.id);
  assert.equal(value.dispatcher.getRun(run.id).status, "running");
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 0);
  await value.coordinator.close();
});

test("native审批替换同步释放waiting，旧答复不可再授权", async () => {
  const value = await openFixture();
  const { ack } = await sendAndDrain(value);
  const run = value.dispatcher.getRun(ack.run.id);
  const handler = value.host.serverRequestHandlers.get("item/commandExecution/requestApproval");
  const params = { threadId: run.runtimeSessionRef?.sessionId, turnId: run.runtimeTurnRef?.turnId, itemId: "replace-item", command: "echo test" };
  const abort = new AbortController();
  const first = handler(params, { signal: abort.signal });
  const oldRequestId = value.dispatcher.getRun(run.id).waitingRequestId;
  abort.abort();
  const nextAbort = new AbortController();
  const second = handler(params, { signal: nextAbort.signal });
  assert.notEqual(value.dispatcher.getRun(run.id).waitingRequestId, oldRequestId);
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 1);
  assert.deepEqual(await first, { decision: "cancel" });
  nextAbort.abort();
  assert.deepEqual(await second, { decision: "cancel" });
  await value.coordinator.close();
});

test("native审批撤销的持久写失败使coordinator失败保护，不留下可用的无卡waiting", async () => {
  const value = await openFixture();
  const { ack } = await sendAndDrain(value);
  const run = value.dispatcher.getRun(ack.run.id);
  const abort = new AbortController();
  const handler = value.host.serverRequestHandlers.get("item/commandExecution/requestApproval");
  const response = handler({ threadId: run.runtimeSessionRef?.sessionId, turnId: run.runtimeTurnRef?.turnId,
    itemId: "failed-abort-item", command: "echo test" }, { signal: abort.signal });
  value.dispatcher.transitionFailures.set("running", "INJECTED_STORAGE_FAILURE");
  abort.abort();
  assert.deepEqual(await response, { decision: "cancel" });
  await assert.rejects(value.coordinator.recover(), { code: "INJECTED_STORAGE_FAILURE" });
  await value.coordinator.close();
});

test("Host崩溃保留协议错误分类而不泄露底层异常文本", async () => {
  const value = await openFixture();
  const { ack } = await sendAndDrain(value);
  value.host.terminate(Object.assign(new Error("private diagnostic"), { code: "DEEPSEEK_HARNESS_FRAME_INVALID" }));
  await new Promise((resolve) => setImmediate(resolve));
  await value.coordinator.waitForIdle(ack.run.id);
  const terminal = value.dispatcher.getRun(ack.run.id);
  assert.equal(terminal.errorCode, "RUNTIME_PROTOCOL_ERROR");
  assert.equal(JSON.stringify(terminal).includes("private diagnostic"), false);
  await value.coordinator.close();
});

test("同lifecycle重复recover不会resume或中断正常活跃任务", async () => {
  const store = recoveryStore();
  const value = await openFixture({ runExecutionStore: store });
  const { ack } = await sendAndDrain(value);
  await value.coordinator.recover();
  await value.coordinator.recover();
  assert.equal(value.dispatcher.getRun(ack.run.id).status, "running");
  assert.equal(value.host.resumeCalls, 0);
  assert.equal(value.host.turnStartCalls, 1);
  await value.coordinator.close();
});

test("恢复记录读取期间已取消的任务不会重新占有或resume", async () => {
  const store = recoveryStore();
  const first = await openFixture({ runExecutionStore: store });
  const { ack } = await sendAndDrain(first);
  await first.coordinator.close();
  const originalGet = store.get;
  store.get = async (run) => {
    const stored = await originalGet(run);
    first.dispatcher.transition(run.id, "canceled");
    return stored;
  };
  const second = await openFixture({ runExecutionStore: store, dispatcher: first.dispatcher,
    inbox: first.inbox, sessions: first.sessions, threads: first.host.threads });
  assert.equal(second.dispatcher.getRun(ack.run.id).status, "canceled");
  assert.equal(second.host.resumeCalls, 0);
  assert.equal(second.host.turnStartCalls, 0);
  assert.equal(second.coordinator.getMemoryStats().runExecutionContracts, 0);
  await second.coordinator.close();
});

async function sendAndDrain(value, input = {}) {
  const operationId = input.operationId || "send-one";
  const ack = await value.coordinator.send({
    operationId,
    sessionKey: SESSION_KEY,
    prompt: input.prompt || "hello from inbox only",
  });
  await value.coordinator.waitForIdle(ack.run.id);
  return { ack, operationId };
}

async function assertTerminalRecoverReentrancy(mode) {
  const operationId = `terminal-recover-${mode}`;
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: `thread-terminal-recover-${mode}`,
    threads: [{ id: `thread-terminal-recover-${mode}`, threadSource: null, turns: [] }],
    terminalRetryDelaysMs: mode === "retry-exhausted" ? [] : undefined,
  });
  try {
    const { ack } = await sendAndDrain(value, { operationId });
    const running = value.dispatcher.getRun(ack.run.id);
    let realtimeTerminals = 0;
    let recoverInvoked = false;
    let recoverResult = null;
    const subscription = value.coordinator.subscribeRun(
      running.id,
      { streamId: null, afterSeq: 0 },
      (event) => {
        if (event.type !== "terminal") return;
        realtimeTerminals += 1;
        if (recoverInvoked) return;
        recoverInvoked = true;
        recoverResult = value.coordinator.recover();
      },
    );
    if (mode === "host") {
      value.host.terminate(codedError("APP_SERVER_EXITED"));
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      if (mode === "normal") {
        const turn = value.host.threads[0].turns.find(
          (candidate) => candidate.id === running.runtimeTurnRef?.turnId,
        );
        turn.status = "completed";
        turn.items.push({ type: "agentMessage", text: "exactly once", phase: "final_answer" });
      } else {
        value.host.threadRead = async () => {
          value.log.push("host.threadRead:failed");
          throw codedError("TRANSIENT_READ_FAILURE");
        };
      }
      value.host.emit({
        known: true,
        type: "complete",
        method: "turn/completed",
        threadId: running.runtimeSessionRef?.sessionId,
        turnId: running.runtimeTurnRef?.turnId,
        status: "completed",
      });
    }
    const terminal = await value.coordinator.waitForIdle(running.id);
    assert.equal(terminal.status, mode === "normal" ? "completed" : "interrupted");
    assert.ok(recoverResult && typeof recoverResult.then === "function");
    assert.deepEqual(await recoverResult, []);
    assert.equal(realtimeTerminals, 1);
    assert.equal(value.inbox.get(operationId).state, "completed");
    const replay = value.coordinator.subscribeRun(
      running.id,
      { streamId: subscription.streamId, afterSeq: 0 },
      () => {},
    );
    assert.equal(replay.events.filter((event) => event.type === "terminal").length, 1);
    replay.unsubscribe();
    subscription.unsubscribe();
  } finally {
    await value.coordinator.close();
  }
}

test("公开 Run 查询/订阅并只路由当前 generation 与 thread/turn 的安全事件", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-events",
    threads: [{ id: "thread-events", threadSource: null, turns: [] }],
  });
  const { ack } = await sendAndDrain(value, { operationId: "event-route" });
  const running = value.coordinator.getRun(ack.run.id);
  assert.equal(running.status, "running");
  assert.equal(value.coordinator.listRuns({ source: "chat" }).length, 1);
  const received = [];
  const subscription = value.coordinator.subscribeRun(
    ack.run.id,
    { streamId: null, afterSeq: 0 },
    (event) => received.push(event),
  );
  value.host.emit({
    known: true,
    type: "text_delta",
    method: "item/agentMessage/delta",
    threadId: "wrong-thread",
    turnId: running.runtimeTurnRef?.turnId,
    itemId: "item-wrong",
    delta: "ignored",
  });
  value.host.emit({
    known: true,
    type: "text_delta",
    method: "item/agentMessage/delta",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: "wrong-turn",
    itemId: "item-wrong",
    delta: "ignored",
  });
  value.host.emit({
    known: true,
    type: "text_delta",
    method: "item/agentMessage/delta",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    itemId: "item-live",
    delta: "hello",
  });
  const routed = received.filter((event) => event.type !== "performance.stage");
  assert.equal(routed.length, 1);
  assert.equal(routed[0].type, "text.delta");
  assert.deepEqual(routed[0].payload, {
    method: "item/agentMessage/delta",
    itemId: "item-live",
    delta: "hello",
  });
  assert.equal(subscription.unsubscribe(), true);
  value.host.emit({
    known: true,
    type: "status",
    method: "turn/started",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    status: "inProgress",
  });
  assert.equal(received.length, 2);
  const replay = value.coordinator.subscribeRun(
    ack.run.id,
    { streamId: subscription.streamId, afterSeq: routed[0].seq },
    () => {},
  );
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].type, "status");
  replay.unsubscribe();
  const turn = value.host.threads[0].turns.find((candidate) => candidate.id === running.runtimeTurnRef?.turnId);
  turn.status = "completed";
  turn.items.push({ type: "agentMessage", text: "finished without UI", phase: "final_answer" });
  value.host.emit({
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    status: "completed",
  });
  assert.equal((await value.coordinator.waitForIdle(ack.run.id)).status, "completed");
  await value.coordinator.close();
});

test("Runtime retry status reaches the run stream without private provider text", async () => {
  const value = await openFixture({
    sessionStatus: "ready", threadId: "thread-retry-status",
    threads: [{ id: "thread-retry-status", threadSource: null, turns: [] }],
  });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "retry-status" });
    const run = value.coordinator.getRun(ack.run.id);
    const observed = [];
    const subscription = value.coordinator.subscribeRun(run.id,
      { streamId: null, afterSeq: 0 }, event => observed.push(event));
    value.host.emit({ known: true, type: "status", method: "opencode/session.status",
      threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
      status: "retrying", reason: "RUNTIME_RATE_LIMITED", message: "private provider trace" });
    assert.deepEqual(observed.at(-1).payload, {
      method: "opencode/session.status", status: "retrying", reason: "RUNTIME_RATE_LIMITED",
    });
    assert.equal(JSON.stringify(observed).includes("private provider trace"), false);
    value.host.emit({ known: true, type: "status", method: "opencode/session.status",
      threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
      status: "running" });
    assert.equal(observed.at(-1).payload.status, "running");
    subscription.unsubscribe();
    const turn = value.host.threads[0].turns.find(item => item.id === run.runtimeTurnRef.turnId);
    turn.status = "failed";
    turn.errorCode = "RUNTIME_RATE_LIMITED";
    value.host.emit({ known: true, type: "complete", method: "opencode/session.message",
      threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId, status: "failed" });
    const terminal = await value.coordinator.waitForIdle(run.id);
    assert.equal(terminal.errorCode, "RUNTIME_RATE_LIMITED");
  } finally {
    await value.coordinator.close();
  }
});

test("text/reasoning/plan/tool/status 事件按白名单快照追加，工具只公开安全展示摘要", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-event-types",
    threads: [{ id: "thread-event-types", threadSource: null, turns: [] }],
  });
  const { ack } = await sendAndDrain(value, { operationId: "event-types" });
  const run = value.coordinator.getRun(ack.run.id);
  const received = [];
  const subscription = value.coordinator.subscribeRun(
    run.id,
    { streamId: null, afterSeq: 0 },
    (event) => received.push(event),
  );
  const common = {
    known: true,
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    opaque: "must-not-pass",
  };
  for (const event of [
    { ...common, type: "text", method: "item/completed", itemId: "text-1", text: "answer", phase: "final_answer" },
    { ...common, type: "reasoning_delta", method: "item/reasoning/summaryTextDelta", itemId: "reason-1", delta: "why" },
    { ...common, type: "reasoning", method: "item/completed", itemId: "reason-1", reasoning: ["summary"] },
    { ...common, type: "plan", method: "turn/plan/updated", plan: [{ step: "one", status: "in_progress" }] },
    { ...common, type: "tool_start", method: "item/started", itemId: "tool-1", toolCallId: "tool-1", tool: { kind: "commandExecution", status: "inProgress", input: "printf safe" } },
    { ...common, type: "tool_update", method: "item/commandExecution/outputDelta", itemId: "tool-1", delta: "chunk" },
    { ...common, type: "tool_result", method: "item/completed", itemId: "tool-1", toolCallId: "tool-1", tool: { kind: "commandExecution", status: "completed", exitCode: 0, output: [{ type: "content", content: { type: "text", text: "build ok" } }] } },
    { ...common, type: "tool_start", method: "deepseek-harness/tool_call", itemId: "tool-2", toolCallId: "tool-2", tool: { kind: "function", name: "web_search", status: "in_progress", input: '{"queries":["native agent trajectory"]}' } },
    { ...common, type: "tool_result", method: "session/update", itemId: "tool-2", toolCallId: "tool-2", tool: { kind: "search", name: "Web search:", status: "completed", success: true, input: { query: "native agent trajectory" }, output: { action: { type: "search", query: "native agent trajectory", sources: [{ url: "https://example.com" }] }, status: "completed" } } },
    { ...common, type: "tool_start", method: "antigravity/step_update", itemId: "tool-3", toolCallId: "tool-3", tool: { kind: "other", name: "write_to_file", status: "in_progress", input: { TargetFile: "/tmp/report.html", CodeContent: "private file contents" } } },
  ]) value.host.emit(event);
  const routed = received.filter((event) => event.type !== "performance.stage");
  assert.deepEqual(routed.map((event) => event.type), [
    "text", "reasoning.delta", "reasoning", "plan", "tool.start", "tool.update", "tool.result",
    "tool.start", "tool.result", "tool.start",
  ]);
  assert.equal(received.some((event) => Object.prototype.hasOwnProperty.call(event.payload, "opaque")), false);
  assert.deepEqual(routed[0].payload, {
    method: "item/completed", itemId: "text-1", text: "answer", phase: "final_answer",
  });
  assert.deepEqual(routed[5].payload, {
    method: "item/commandExecution/outputDelta", itemId: "tool-1", delta: "chunk",
  });
  assert.deepEqual(routed[4].payload.tool, {
    kind: "commandExecution", status: "inProgress", displayArgs: { command: "printf safe" },
  });
  assert.deepEqual(routed[6].payload.tool, {
    kind: "commandExecution", status: "completed", exitCode: 0, resultSummary: "build ok",
  });
  assert.deepEqual(routed[7].payload.tool, {
    kind: "function", name: "web_search", status: "in_progress",
    displayArgs: { query: "native agent trajectory" },
  });
  assert.deepEqual(routed[8].payload.tool, {
    kind: "search", name: "Web search:", status: "completed", success: true,
    displayArgs: { query: "native agent trajectory" },
  });
  assert.deepEqual(routed[9].payload.tool, {
    kind: "other", name: "write_to_file", status: "in_progress",
    displayArgs: { TargetFile: "/tmp/report.html" },
  });
  assert.equal(Object.hasOwn(routed[4].payload.tool, "input"), false);
  assert.equal(Object.hasOwn(routed[6].payload.tool, "output"), false);
  subscription.unsubscribe();
  await value.coordinator.close();
});

test("通用 MCP 包装调用按 toolCallId 关联为去密的联邦结果", async () => {
  const peerMessage = "Grok 发来的消息".repeat(1_000);
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-federation-wrapper",
    threads: [{ id: "thread-federation-wrapper", threadSource: null, turns: [] }],
    sanitizeSummary: (summary) => (
      Buffer.byteLength(summary, "utf8") > 16 * 1024 ? null : summary
    ),
    assertSecretSafe: (payload) => {
      if (JSON.stringify(payload).includes("registered-secret")) throw new Error("secret");
      return true;
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "federation-wrapper" });
  const run = value.coordinator.getRun(ack.run.id);
  const received = [];
  const subscription = value.coordinator.subscribeRun(
    run.id,
    { streamId: null, afterSeq: 0 },
    (event) => received.push(event),
  );
  const common = {
    known: true,
    method: "antigravity/step_update",
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    itemId: "wrapped-federation-tool",
    toolCallId: "wrapped-federation-tool",
  };
  value.host.emit({
    ...common,
    type: "tool_start",
    tool: {
      kind: "other",
      name: "call_mcp_tool",
      status: "in_progress",
      input: {
        server_name: "shoggoth",
        tool_name: "federation_task_get",
        arguments: { taskId: "task-one" },
      },
    },
  });
  value.host.emit({
    ...common,
    type: "tool_result",
    tool: {
      kind: "other",
      name: "call_mcp_tool",
      status: "completed",
      success: true,
      output: {
        type: "MCP",
        server_name: "shoggoth",
        tool_name: "federation_task_get",
        output: {
          OkayOutput: JSON.stringify({
            agent: {
              backendId: "grok-build", agentId: "shoggoth-grok", name: "Grok",
              kind: "native", connected: true, model: null, provider: null,
            },
            task: {
              taskId: "task-one", sessionKey: "private-session", status: "completed", turn: 1,
              waitingFor: null, result: peerMessage, errorCode: null,
            },
            handle: "private-handle",
          }),
        },
      },
    },
  });
  const tools = received.filter((event) => (
    event.type === "tool.start" || event.type === "tool.result"
  ));
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0].payload.tool, {
    kind: "other", name: "federation_task_get", status: "in_progress",
  });
  assert.equal(tools[1].payload.tool.name, "federation_task_get");
  assert.equal(tools[1].payload.tool.status, "completed");
  assert.equal(tools[1].payload.tool.success, true);
  assert.ok(Buffer.byteLength(tools[1].payload.tool.resultSummary, "utf8") > 2 * 1024);
  const result = JSON.parse(tools[1].payload.tool.resultSummary);
  assert.deepEqual(result.agent, {
    backendId: "grok-build", agentId: "shoggoth-grok", name: "Grok",
  });
  const displayedResult = result.task.resultEncoding === "base64-utf8"
    ? Buffer.from(result.task.resultBase64, "base64").toString("utf8") : result.task.result;
  assert.equal(displayedResult, peerMessage);
  assert.equal(tools[1].payload.tool.resultSummary.includes("private-"), false);

  value.host.emit({
    ...common,
    type: "tool_start",
    itemId: "wrapped-secret-tool",
    toolCallId: "wrapped-secret-tool",
    tool: {
      kind: "other", name: "use_tool", status: "in_progress",
      input: { server: "shoggoth", toolName: "federation_task_get" },
    },
  });
  value.host.emit({
    ...common,
    type: "tool_result",
    itemId: "wrapped-secret-tool",
    toolCallId: "wrapped-secret-tool",
    tool: {
      kind: "other", name: "use_tool", status: "completed", success: true,
      output: JSON.stringify({
        agent: { backendId: "grok-build", agentId: "shoggoth-grok", name: "Grok" },
        task: {
          taskId: "task-secret", sessionKey: "private-session", status: "completed", turn: 1,
          waitingFor: null,
          result: `${"safe-prefix".repeat(2_000)}registered-secret`,
          errorCode: null,
        },
      }),
    },
  });
  const secretResult = received.filter((event) => event.type === "tool.result").at(-1);
  assert.deepEqual(secretResult.payload.tool, {
    kind: "other", name: "federation_task_get", status: "completed", success: true,
  });
  subscription.unsubscribe();
  await value.coordinator.close();
});

test("工具展示摘要命中敏感信息时省略，名称与终态仍可观察", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-tool-summary-secret",
    threads: [{ id: "thread-tool-summary-secret", threadSource: null, turns: [] }],
    sanitizeSummary: (summary) => summary.includes("registered-secret") ? null : summary,
  });
  const { ack } = await sendAndDrain(value, { operationId: "tool-summary-secret" });
  const run = value.coordinator.getRun(ack.run.id);
  const received = [];
  const subscription = value.coordinator.subscribeRun(
    run.id,
    { streamId: null, afterSeq: 0 },
    (event) => received.push(event),
  );
  const common = {
    known: true,
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    itemId: "tool-secret",
    toolCallId: "tool-secret",
  };
  value.host.emit({
    ...common,
    type: "tool_start",
    method: "item/started",
    tool: { kind: "commandExecution", name: "command", status: "inProgress", input: "echo registered-secret" },
  });
  value.host.emit({
    ...common,
    type: "tool_result",
    method: "item/completed",
    tool: { kind: "commandExecution", name: "command", status: "completed", output: "registered-secret" },
  });
  const tools = received.filter((event) => event.type === "tool.start" || event.type === "tool.result");
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0].payload.tool, {
    kind: "commandExecution", name: "command", status: "inProgress",
  });
  assert.deepEqual(tools[1].payload.tool, {
    kind: "commandExecution", name: "command", status: "completed",
  });
  subscription.unsubscribe();
  await value.coordinator.close();
});

test("运行阶段耗时以安全 performance.stage 事件公开", async () => {
  let now = 1_000;
  const value = await openFixture({
    now: () => now,
    sessionStatus: "ready",
    threadId: "thread-performance",
    threads: [{ id: "thread-performance", threadSource: null, turns: [] }],
  });
  const { ack } = await sendAndDrain(value, { operationId: "performance-stage" });
  const running = value.coordinator.getRun(ack.run.id);
  const received = [];
  const subscription = value.coordinator.subscribeRun(
    running.id,
    { streamId: null, afterSeq: 0 },
    (event) => received.push(event),
  );
  const replayedStages = subscription.events
    .filter((event) => event.type === "performance.stage")
    .map((event) => event.payload.stage);
  for (const stage of [
    "runtime_acquire", "runtime_authentication", "session_resume", "session_read", "turn_start",
  ]) assert.ok(replayedStages.includes(stage), `缺少 ${stage} 耗时事件`);

  now = 1_200;
  value.host.emit({
    known: true,
    type: "reasoning",
    method: "item/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    itemId: "reason-performance",
    reasoning: ["started"],
  });
  now = 1_250;
  value.host.emit({
    known: true,
    type: "tool_start",
    method: "item/started",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    itemId: "tool-performance",
    toolCallId: "tool-performance",
    tool: { kind: "commandExecution", name: "command", status: "inProgress", input: "npm test" },
  });
  now = 1_400;
  value.host.emit({
    known: true,
    type: "tool_result",
    method: "item/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    itemId: "tool-performance",
    toolCallId: "tool-performance",
    tool: { kind: "commandExecution", name: "command", status: "completed", exitCode: 0, output: "all tests passed" },
  });
  const liveTimings = received.filter((event) => event.type === "performance.stage");
  assert.deepEqual(
    liveTimings.find((event) => event.payload.stage === "first_runtime_event")?.payload,
    { stage: "first_runtime_event", durationMs: 200, outcome: "success" },
  );
  assert.deepEqual(
    liveTimings.find((event) => event.payload.stage === "tool_execution")?.payload,
    { stage: "tool_execution", durationMs: 150, outcome: "success", toolKind: "commandExecution" },
  );
  assert.deepEqual(
    received.find((event) => event.type === "tool.result")?.payload.tool,
    {
      kind: "commandExecution", name: "command", status: "completed", exitCode: 0,
      resultSummary: "all tests passed", durationMs: 150,
    },
  );
  subscription.unsubscribe();
  await value.coordinator.close();
});

test("turn/start RPC 返回前到达的精确 turn 事件在 binding 建立后安全回放", async () => {
  const value = fixture({
    sessionStatus: "ready",
    threadId: "thread-early-event",
    threads: [{ id: "thread-early-event", threadSource: null, turns: [] }],
  });
  const originalTurnStart = value.host.turnStart.bind(value.host);
  value.host.turnStart = async (params) => {
    const response = await originalTurnStart(params);
    value.host.emit({
      known: true,
      type: "text_delta",
      method: "item/agentMessage/delta",
      threadId: params.threadId,
      turnId: response.turn.id,
      itemId: "early-text",
      delta: "arrived-before-response",
    });
    return response;
  };
  await value.coordinator.open();
  const { ack } = await sendAndDrain(value, { operationId: "early-event" });
  const replay = value.coordinator.subscribeRun(
    ack.run.id,
    { streamId: null, afterSeq: 0 },
    () => {},
  );
  assert.equal(replay.events.filter((event) => event.type === "text.delta").length, 1);
  assert.equal(
    replay.events.find((event) => event.type === "text.delta").payload.delta,
    "arrived-before-response",
  );
  replay.unsubscribe();
  await value.coordinator.close();
});

test("turn/completed 以 full thread/read 对账并按 durable 顺序 exactly-once 完成", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-terminal",
    threads: [{ id: "thread-terminal", threadSource: null, turns: [] }],
    sanitizeSummary: (summary) => summary.replace("secret", "[redacted]"),
    maxResultSummaryBytes: 64,
  });
  const { ack, operationId } = await sendAndDrain(value, { operationId: "terminal-complete" });
  const running = value.coordinator.getRun(ack.run.id);
  assert.equal(running.status, "running");
  assert.equal(value.inbox.get(operationId).state, "dispatching");
  const turn = value.host.threads[0].turns.find((candidate) => candidate.id === running.runtimeTurnRef?.turnId);
  turn.status = "completed";
  turn.itemsView = "full";
  turn.items.push(
    { type: "agentMessage", text: "progress only", phase: "commentary" },
    { type: "agentMessage", text: "final secret ✅", phase: "final_answer" },
    { type: "agentMessage", text: "async ignored", phase: "final_answer", delivery: "async" },
  );
  const subscription = value.coordinator.subscribeRun(
    running.id,
    { streamId: null, afterSeq: 0 },
    (event) => {
      if (event.type === "terminal") value.log.push("stream.terminal");
    },
  );
  value.log.length = 0;
  const completedEvent = {
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    status: "failed",
  };
  value.host.emit(completedEvent);
  value.host.emit(completedEvent);
  await value.coordinator.waitForIdle(running.id);
  const completed = value.coordinator.getRun(running.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.resultSummary, "final [redacted] ✅");
  assert.equal(value.inbox.get(operationId).state, "completed");
  assert.deepEqual(value.log.filter((entry) => [
    "host.threadRead",
    "dispatcher.transition:completed",
    "stream.terminal",
    "inbox.transition:completed",
  ].includes(entry)), [
    "host.threadRead",
    "dispatcher.transition:completed",
    "stream.terminal",
    "inbox.transition:completed",
  ]);
  const replay = value.coordinator.subscribeRun(
    running.id,
    { streamId: subscription.streamId, afterSeq: 0 },
    () => {},
  );
  assert.equal(replay.events.filter((event) => event.type === "terminal").length, 1);
  replay.unsubscribe();
  subscription.unsubscribe();
  await value.coordinator.close();
});

test("normal terminal listener 异步 recover 不重放 terminal 或使外层 STALE_RUN", async () => {
  await assertTerminalRecoverReentrancy("normal");
});

test("Host terminated listener 异步 recover 不重放 terminal 或使外层 STALE_RUN", async () => {
  await assertTerminalRecoverReentrancy("host");
});

test("retry exhausted listener 异步 recover 不重放 terminal 或使外层 STALE_RUN", async () => {
  await assertTerminalRecoverReentrancy("retry-exhausted");
});

test("terminal canonical read 必须证明 operationId 与目标 turn 的 userMessage 全局唯一绑定", async () => {
  for (const items of [
    [{ type: "userMessage", clientId: "another-operation" }],
    [
      { type: "userMessage", clientId: "terminal-correlation" },
      { type: "userMessage", clientId: "terminal-correlation" },
    ],
  ]) {
    const value = await openFixture({
      sessionStatus: "ready",
      threadId: "thread-terminal-correlation",
      threads: [{ id: "thread-terminal-correlation", threadSource: null, turns: [] }],
    });
    const { ack } = await sendAndDrain(value, { operationId: "terminal-correlation" });
    const running = value.coordinator.getRun(ack.run.id);
    const turn = value.host.threads[0].turns.find((candidate) => candidate.id === running.runtimeTurnRef?.turnId);
    turn.status = "completed";
    turn.items = [
      ...clone(items),
      { type: "agentMessage", text: "must not be accepted", phase: "final_answer" },
    ];
    value.host.emit({
      known: true,
      type: "complete",
      method: "turn/completed",
      threadId: running.runtimeSessionRef?.sessionId,
      turnId: running.runtimeTurnRef?.turnId,
      status: "completed",
    });
    await assert.rejects(
      () => value.coordinator.waitForIdle(running.id),
      (error) => error.code === "CODEX_TERMINAL_OPERATION_MISMATCH",
    );
    assert.equal(value.dispatcher.getRun(running.id).status, "running");
    assert.equal(value.inbox.get("terminal-correlation").state, "dispatching");
    await value.coordinator.close();
  }
});

test("terminal 单次通知遇到 thread/read 瞬时失败时有界自动重试成功", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-terminal-retry",
    threads: [{ id: "thread-terminal-retry", threadSource: null, turns: [] }],
    terminalRetryDelaysMs: [0],
  });
  const { ack } = await sendAndDrain(value, { operationId: "terminal-retry" });
  const running = value.coordinator.getRun(ack.run.id);
  const turn = value.host.threads[0].turns.find((candidate) => candidate.id === running.runtimeTurnRef?.turnId);
  turn.status = "completed";
  turn.items.push({ type: "agentMessage", text: "eventually done", phase: "final_answer" });
  const originalRead = value.host.threadRead.bind(value.host);
  let failNext = true;
  value.host.threadRead = async (params) => {
    if (failNext) {
      failNext = false;
      value.log.push("host.threadRead");
      throw codedError("TRANSIENT_READ_FAILURE");
    }
    return originalRead(params);
  };
  const event = {
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    status: "completed",
  };
  value.log.length = 0;
  value.host.emit(event);
  assert.equal((await value.coordinator.waitForIdle(running.id)).status, "completed");
  assert.equal(value.inbox.get("terminal-retry").state, "completed");
  assert.equal(value.log.filter((entry) => entry === "host.threadRead").length, 2);
  await value.coordinator.close();
});

test("terminal 单次通知读到暂时 inProgress 时自动重读 canonical terminal", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-terminal-stale",
    threads: [{ id: "thread-terminal-stale", threadSource: null, turns: [] }],
    terminalRetryDelaysMs: [0],
  });
  const { ack } = await sendAndDrain(value, { operationId: "terminal-stale" });
  const running = value.coordinator.getRun(ack.run.id);
  const turn = value.host.threads[0].turns.find((candidate) => candidate.id === running.runtimeTurnRef?.turnId);
  turn.items.push({ type: "agentMessage", text: "eventually canonical", phase: "final_answer" });
  const originalRead = value.host.threadRead.bind(value.host);
  let terminalReads = 0;
  value.host.threadRead = async (params) => {
    terminalReads += 1;
    if (terminalReads === 2) turn.status = "completed";
    return originalRead(params);
  };
  value.host.emit({
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    status: "completed",
  });
  assert.equal((await value.coordinator.waitForIdle(running.id)).status, "completed");
  assert.equal(value.inbox.get("terminal-stale").state, "completed");
  assert.equal(terminalReads, 2);
  await value.coordinator.close();
});

test("terminal canonical 对账重试耗尽后按 durable 顺序收敛 interrupted", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-terminal-exhausted",
    threads: [{ id: "thread-terminal-exhausted", threadSource: null, turns: [] }],
    terminalRetryDelaysMs: [0, 0],
  });
  const { ack } = await sendAndDrain(value, { operationId: "terminal-exhausted" });
  const running = value.coordinator.getRun(ack.run.id);
  let reads = 0;
  value.host.threadRead = async () => {
    value.log.push("host.threadRead:failed");
    reads += 1;
    throw codedError("TRANSIENT_READ_FAILURE");
  };
  const subscription = value.coordinator.subscribeRun(
    running.id,
    { streamId: null, afterSeq: 0 },
    (event) => {
    if (event.type === "terminal") value.log.push("stream.terminal");
    },
  );
  value.log.length = 0;
  value.host.emit({
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    status: "completed",
  });
  const terminal = await value.coordinator.waitForIdle(running.id);
  assert.equal(terminal.status, "interrupted");
  assert.equal(terminal.errorCode, "CODEX_TERMINAL_RECONCILIATION_FAILED");
  assert.equal(value.inbox.get("terminal-exhausted").state, "completed");
  assert.equal(reads, 3);
  assert.deepEqual(value.log.filter((entry) => [
    "dispatcher.transition:interrupted",
    "stream.terminal",
    "inbox.transition:completed",
  ].includes(entry)), [
    "dispatcher.transition:interrupted",
    "stream.terminal",
    "inbox.transition:completed",
  ]);
  subscription.unsubscribe();
  await value.coordinator.close();
});

test("terminal retry exhausted 的 subscriber 同步 close 后不 tombstone 或 drain queued", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-retry-close-fence",
    threads: [{ id: "thread-retry-close-fence", threadSource: null, turns: [] }],
    terminalRetryDelaysMs: [],
  });
  const first = await sendAndDrain(value, { operationId: "retry-close-first" });
  const firstRun = value.dispatcher.getRun(first.ack.run.id);
  const second = await value.coordinator.send({
    operationId: "retry-close-second",
    sessionKey: SESSION_KEY,
    prompt: "must remain queued while closing",
  });
  value.host.threadRead = async () => {
    value.log.push("host.threadRead:failed");
    throw codedError("TRANSIENT_READ_FAILURE");
  };
  let closing = null;
  value.coordinator.subscribeRun(firstRun.id, { streamId: null, afterSeq: 0 }, (event) => {
    if (event.type === "terminal" && closing === null) closing = value.coordinator.close();
  });
  value.host.emit({
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: firstRun.runtimeSessionRef?.sessionId,
    turnId: firstRun.runtimeTurnRef?.turnId,
    status: "completed",
  });
  while (closing === null) await new Promise((resolve) => setImmediate(resolve));
  await closing;
  assert.equal(value.dispatcher.getRun(firstRun.id).status, "interrupted");
  assert.equal(value.inbox.get("retry-close-first").state, "dispatching");
  assert.equal(value.dispatcher.getRun(second.run.id).status, "queued");
  assert.equal(value.inbox.get("retry-close-second").state, "pending");
});

test("terminal Inbox tombstone 持久化后才 drain 同 Session queued run", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-drain",
    threads: [{ id: "thread-drain", threadSource: null, turns: [] }],
  });
  const first = await sendAndDrain(value, { operationId: "drain-first" });
  const firstRun = value.coordinator.getRun(first.ack.run.id);
  const secondAck = await value.coordinator.send({
    operationId: "drain-second",
    sessionKey: SESSION_KEY,
    prompt: "queued behind first",
  });
  assert.equal(secondAck.disposition, "queued");
  const firstTurn = value.host.threads[0].turns.find((turn) => turn.id === firstRun.runtimeTurnRef?.turnId);
  firstTurn.status = "completed";
  firstTurn.items.push({ type: "agentMessage", text: "first done", phase: "final_answer" });
  value.log.length = 0;
  value.host.emit({
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: firstRun.runtimeSessionRef?.sessionId,
    turnId: firstRun.runtimeTurnRef?.turnId,
    status: "completed",
  });
  await value.coordinator.waitForIdle(firstRun.id);
  await value.coordinator.waitForIdle(secondAck.run.id);
  assert.equal(value.coordinator.getRun(firstRun.id).status, "completed");
  assert.equal(value.coordinator.getRun(secondAck.run.id).status, "running");
  assert.equal(value.inbox.get("drain-first").state, "completed");
  assert.equal(value.inbox.get("drain-second").state, "dispatching");
  assert.ok(value.log.indexOf("inbox.transition:completed") < value.log.lastIndexOf("dispatcher.admit"));
  assert.equal(value.host.turnStartCalls, 2);
  await value.coordinator.close();
});

test("terminal subscriber 同步 close 后 lifecycle fence 阻止 Inbox tombstone 与 queued drain", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-terminal-close-fence",
    threads: [{ id: "thread-terminal-close-fence", threadSource: null, turns: [] }],
  });
  const first = await sendAndDrain(value, { operationId: "terminal-close-first" });
  const firstRun = value.dispatcher.getRun(first.ack.run.id);
  const second = await value.coordinator.send({
    operationId: "terminal-close-second",
    sessionKey: SESSION_KEY,
    prompt: "must remain queued while closing",
  });
  const turn = value.host.threads[0].turns.find((candidate) => candidate.id === firstRun.runtimeTurnRef?.turnId);
  turn.status = "completed";
  turn.items.push({ type: "agentMessage", text: "durable before close", phase: "final_answer" });
  let closing = null;
  value.coordinator.subscribeRun(firstRun.id, { streamId: null, afterSeq: 0 }, (event) => {
    if (event.type === "terminal" && closing === null) closing = value.coordinator.close();
  });
  value.host.emit({
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: firstRun.runtimeSessionRef?.sessionId,
    turnId: firstRun.runtimeTurnRef?.turnId,
    status: "completed",
  });
  while (closing === null) await new Promise((resolve) => setImmediate(resolve));
  await closing;
  assert.equal(value.dispatcher.getRun(firstRun.id).status, "completed");
  assert.equal(value.inbox.get("terminal-close-first").state, "dispatching");
  assert.equal(value.dispatcher.getRun(second.run.id).status, "queued");
  assert.equal(value.inbox.get("terminal-close-second").state, "pending");
});

test("terminal stream LRU 有界保留，淘汰后以 authoritative STREAM_RESET 收敛且 active stream 不变", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-terminal-lru",
    threads: [{ id: "thread-terminal-lru", threadSource: null, turns: [] }],
    maxTerminalStreams: 2,
  });
  const completed = [];
  for (let index = 1; index <= 3; index += 1) {
    const operationId = `terminal-lru-${index}`;
    const { ack } = await sendAndDrain(value, { operationId });
    const running = value.dispatcher.getRun(ack.run.id);
    const cursor = value.coordinator.subscribeRun(
      running.id,
      { streamId: null, afterSeq: 0 },
      () => {},
    );
    const turn = value.host.threads[0].turns.find(
      (candidate) => candidate.id === running.runtimeTurnRef?.turnId,
    );
    turn.status = "completed";
    turn.items.push({ type: "agentMessage", text: `done ${index}`, phase: "final_answer" });
    value.host.emit({
      known: true,
      type: "complete",
      method: "turn/completed",
      threadId: running.runtimeSessionRef?.sessionId,
      turnId: running.runtimeTurnRef?.turnId,
      status: "completed",
    });
    await value.coordinator.waitForIdle(running.id);
    cursor.unsubscribe();
    completed.push({ runId: running.id, streamId: cursor.streamId });
  }

  assert.deepEqual(value.coordinator.getMemoryStats(), {
    runStreams: 2,
    terminalStreams: 2,
    rehydratedTerminalStreams: 0,
    runGenerations: 0,
    runContexts: 0,
    runExecutionContracts: 0,
    runHostAssignments: 0,
    controlOperations: 0,
    pendingRequests: 0,
    domainCommands: 0,
    terminalWaiters: 0,
  });
  const latest = value.coordinator.subscribeRun(
    completed[2].runId,
    { streamId: completed[2].streamId, afterSeq: 0 },
    () => {},
  );
  assert.equal(latest.gap, null);
  assert.equal(latest.events.filter((event) => event.type === "terminal").length, 1);
  latest.unsubscribe();

  const evictedNullCursor = value.coordinator.subscribeRun(
    completed[0].runId,
    { streamId: null, afterSeq: 0 },
    () => {},
  );
  assert.equal(evictedNullCursor.gap.code, "STREAM_RESET");
  assert.equal(evictedNullCursor.gap.requestedStreamId, null);
  assert.equal(evictedNullCursor.snapshot.run.status, "completed");
  evictedNullCursor.unsubscribe();
  const secondNullCursor = value.coordinator.subscribeRun(
    completed[0].runId,
    { streamId: null, afterSeq: 0 },
    () => {},
  );
  assert.equal(secondNullCursor.gap.code, "STREAM_RESET");
  assert.equal(secondNullCursor.gap.requestedStreamId, null);
  assert.equal(secondNullCursor.snapshot.run.status, "completed");
  secondNullCursor.unsubscribe();
  const currentGenerationCursor = value.coordinator.subscribeRun(
    completed[0].runId,
    { streamId: evictedNullCursor.streamId, afterSeq: 0 },
    () => {},
  );
  assert.equal(currentGenerationCursor.gap, null);
  assert.equal(currentGenerationCursor.streamId, evictedNullCursor.streamId);
  currentGenerationCursor.unsubscribe();
  const evicted = value.coordinator.subscribeRun(
    completed[0].runId,
    { streamId: completed[0].streamId, afterSeq: 0 },
    () => {},
  );
  assert.equal(evicted.gap.code, "STREAM_RESET");
  assert.equal(evicted.snapshot.run.status, "completed");
  evicted.unsubscribe();

  const active = await sendAndDrain(value, { operationId: "terminal-lru-active" });
  const activeCursor = value.coordinator.subscribeRun(
    active.ack.run.id,
    { streamId: null, afterSeq: 0 },
    () => {},
  );
  const anotherEvicted = value.coordinator.subscribeRun(
    completed[1].runId,
    { streamId: completed[1].streamId, afterSeq: 0 },
    () => {},
  );
  assert.equal(anotherEvicted.gap.code, "STREAM_RESET");
  anotherEvicted.unsubscribe();
  const activeReplay = value.coordinator.subscribeRun(
    active.ack.run.id,
    { streamId: activeCursor.streamId, afterSeq: 0 },
    () => {},
  );
  assert.equal(activeReplay.gap, null);
  assert.equal(activeReplay.streamId, activeCursor.streamId);
  assert.deepEqual(value.coordinator.getMemoryStats(), {
    runStreams: 3,
    terminalStreams: 2,
    rehydratedTerminalStreams: 2,
    runGenerations: 1,
    runContexts: 1,
    runExecutionContracts: 1,
    runHostAssignments: 1,
    controlOperations: 0,
    pendingRequests: 0,
    domainCommands: 0,
    terminalWaiters: 0,
  });
  activeReplay.unsubscribe();
  activeCursor.unsubscribe();
  await value.coordinator.close();
});

test("terminal stream TTL 到期后释放内存并在重订阅时返回 authoritative STREAM_RESET", async () => {
  let now = 1_000;
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-terminal-ttl",
    threads: [{ id: "thread-terminal-ttl", threadSource: null, turns: [] }],
    maxTerminalStreams: 4,
    terminalStreamTtlMs: 50,
    now: () => now,
  });
  const { ack } = await sendAndDrain(value, { operationId: "terminal-ttl" });
  const running = value.dispatcher.getRun(ack.run.id);
  const cursor = value.coordinator.subscribeRun(
    running.id,
    { streamId: null, afterSeq: 0 },
    () => {},
  );
  const turn = value.host.threads[0].turns.find((candidate) => candidate.id === running.runtimeTurnRef?.turnId);
  turn.status = "completed";
  value.host.emit({
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    status: "completed",
  });
  await value.coordinator.waitForIdle(running.id);
  cursor.unsubscribe();
  assert.equal(value.coordinator.getMemoryStats().terminalStreams, 1);

  now += 51;
  assert.deepEqual(value.coordinator.getMemoryStats(), {
    runStreams: 0,
    terminalStreams: 0,
    rehydratedTerminalStreams: 0,
    runGenerations: 0,
    runContexts: 0,
    runExecutionContracts: 0,
    runHostAssignments: 0,
    controlOperations: 0,
    pendingRequests: 0,
    domainCommands: 0,
    terminalWaiters: 0,
  });
  const resetFromNullCursor = value.coordinator.subscribeRun(
    running.id,
    { streamId: null, afterSeq: 0 },
    () => {},
  );
  assert.equal(resetFromNullCursor.gap.code, "STREAM_RESET");
  assert.equal(resetFromNullCursor.gap.requestedStreamId, null);
  assert.equal(resetFromNullCursor.snapshot.run.status, "completed");
  resetFromNullCursor.unsubscribe();
  const reset = value.coordinator.subscribeRun(
    running.id,
    { streamId: cursor.streamId, afterSeq: 0 },
    () => {},
  );
  assert.equal(reset.gap.code, "STREAM_RESET");
  assert.equal(reset.snapshot.run.status, "completed");
  reset.unsubscribe();
  await value.coordinator.close();
});

test("Host terminated 将该 runtime profile 的 active run exactly-once 收敛为 interrupted", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-host-dead",
    threads: [{ id: "thread-host-dead", threadSource: null, turns: [] }],
  });
  const { ack, operationId } = await sendAndDrain(value, { operationId: "host-dead" });
  const running = value.coordinator.getRun(ack.run.id);
  const terminalEvents = [];
  const subscription = value.coordinator.subscribeRun(
    running.id,
    { streamId: null, afterSeq: 0 },
    (event) => {
      if (event.type === "terminal") terminalEvents.push(event);
    },
  );
  value.log.length = 0;
  value.host.terminate(codedError("APP_SERVER_EXITED"));
  await new Promise((resolve) => setImmediate(resolve));
  await value.coordinator.waitForIdle(running.id);
  const interrupted = value.coordinator.getRun(running.id);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.errorCode, "CODEX_HOST_TERMINATED");
  assert.equal(value.inbox.get(operationId).state, "completed");
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].payload.status, "interrupted");
  assert.equal(value.log.includes("host.threadRead"), false);
  assert.deepEqual(value.log.filter((entry) => [
    "dispatcher.transition:interrupted", "inbox.transition:completed",
  ].includes(entry)), ["dispatcher.transition:interrupted", "inbox.transition:completed"]);
  subscription.unsubscribe();
  await value.coordinator.close();
});

test("Host terminated 的 terminal subscriber 同步 close 后不 tombstone 或 drain queued", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-host-close-fence",
    threads: [{ id: "thread-host-close-fence", threadSource: null, turns: [] }],
  });
  const first = await sendAndDrain(value, { operationId: "host-close-first" });
  const second = await value.coordinator.send({
    operationId: "host-close-second",
    sessionKey: SESSION_KEY,
    prompt: "must remain queued while closing",
  });
  let closing = null;
  value.coordinator.subscribeRun(first.ack.run.id, { streamId: null, afterSeq: 0 }, (event) => {
    if (event.type === "terminal" && closing === null) closing = value.coordinator.close();
  });
  value.host.terminate(codedError("APP_SERVER_EXITED"));
  while (closing === null) await new Promise((resolve) => setImmediate(resolve));
  await closing;
  assert.equal(value.dispatcher.getRun(first.ack.run.id).status, "interrupted");
  assert.equal(value.inbox.get("host-close-first").state, "dispatching");
  assert.equal(value.dispatcher.getRun(second.run.id).status, "queued");
  assert.equal(value.inbox.get("host-close-second").state, "pending");
});

test("Host terminated 按 Run 实际 assigned Host 收敛且立即释放 observer", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-assigned-host",
    threads: [{ id: "thread-assigned-host", threadSource: null, turns: [] }],
  });
  const { ack } = await sendAndDrain(value, { operationId: "assigned-host" });
  const originalProfile = value.productStore.getAgentProfile.bind(value.productStore);
  value.productStore.getAgentProfile = (profileId) => ({
    ...originalProfile(profileId),
    runtimeProfileId: "runtime-profile-after-admission",
  });
  value.host.terminate(codedError("APP_SERVER_EXITED"));
  await new Promise((resolve) => setImmediate(resolve));
  await value.coordinator.waitForIdle(ack.run.id);
  assert.equal(value.coordinator.getRun(ack.run.id).status, "interrupted");
  assert.equal(value.inbox.get("assigned-host").state, "completed");
  assert.equal(value.host.subscribers.size, 0);
  await value.coordinator.close();
});

test("starting Run 绑定 assigned Host，RPC 终止错误不能覆盖 durable interrupted", async () => {
  const value = fixture({
    sessionStatus: "ready",
    threadId: "thread-starting-host",
    threads: [{ id: "thread-starting-host", threadSource: null, turns: [] }],
  });
  const readGate = deferred();
  value.host.threadRead = async () => {
    value.log.push("host.threadRead:gated-host-exit");
    await readGate.promise;
    throw codedError("CODEX_RPC_TERMINATED");
  };
  await value.coordinator.open();
  const ack = await value.coordinator.send({
    operationId: "starting-assigned-host",
    sessionKey: SESSION_KEY,
    prompt: "host exits before turn binding",
  });
  while (!value.log.includes("host.threadRead:gated-host-exit")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const originalProfile = value.productStore.getAgentProfile.bind(value.productStore);
  value.productStore.getAgentProfile = (profileId) => ({
    ...originalProfile(profileId),
    runtimeProfileId: "runtime-profile-after-start",
  });
  value.host.terminate(codedError("APP_SERVER_EXITED"));
  readGate.resolve();
  const terminal = await value.coordinator.waitForIdle(ack.run.id);
  assert.equal(terminal.status, "interrupted");
  assert.equal(terminal.errorCode, "CODEX_HOST_TERMINATED");
  assert.equal(value.inbox.get("starting-assigned-host").state, "completed");
  await value.coordinator.close();
});

test("close fence 阻止已排队但尚未执行的 Host-terminated 收敛继续写 ProductStore", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-close-host",
    threads: [{ id: "thread-close-host", threadSource: null, turns: [] }],
  });
  const { ack } = await sendAndDrain(value, { operationId: "close-host" });
  const running = value.dispatcher.getRun(ack.run.id);
  const readGate = deferred();
  const originalRead = value.host.threadRead.bind(value.host);
  value.host.threadRead = async (params) => {
    value.log.push("host.threadRead:gated");
    await readGate.promise;
    return originalRead(params);
  };
  value.host.emit({
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    status: "completed",
  });
  while (!value.log.includes("host.threadRead:gated")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  value.host.terminate(codedError("APP_SERVER_EXITED"));
  await new Promise((resolve) => setImmediate(resolve));
  const closing = value.coordinator.close();
  readGate.resolve();
  await closing;
  assert.equal(value.dispatcher.getRun(running.id).status, "running");
  assert.equal(value.inbox.get("close-host").state, "dispatching");
  assert.equal(value.log.includes("dispatcher.transition:interrupted"), false);
});

test("重启 crash cut：WorkRun 已 terminal 但 Inbox 仍 active 时先补 terminal event/tombstone 再 drain", async () => {
  const value = fixture({
    sessionStatus: "ready",
    threadId: "thread-terminal-recovery",
    threads: [{ id: "thread-terminal-recovery", threadSource: null, turns: [] }],
  });
  const terminalRunId = "00000000-0000-4000-8000-000000000201";
  value.inbox.enqueue({
    operationId: "terminal-cut",
    runId: terminalRunId,
    sessionKey: SESSION_KEY,
    prompt: "already finished",
    createdAt: 1_000,
  });
  value.dispatcher.enqueue({
    id: terminalRunId,
    source: "chat",
    sourceId: SESSION_KEY,
    idempotencyKey: "shoggoth:chat-send:terminal-cut",
    profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-workspace",
    retryOf: null,
  });
  value.dispatcher.admit(terminalRunId);
  value.dispatcher.transition(terminalRunId, "running", {
    runtimeSessionRef: { runtime: "codex", runtimeProfileId: "runtime-default", runtimeAccountId: RUNTIME_ACCOUNT_ID, sessionId: "thread-terminal-recovery" },
    runtimeTurnRef: { runtime: "codex", runtimeProfileId: "runtime-default", runtimeAccountId: RUNTIME_ACCOUNT_ID, sessionId: "thread-terminal-recovery", turnId: "turn-terminal-recovery" },
  });
  value.dispatcher.transition(terminalRunId, "completed", { resultSummary: "persisted result" });
  value.inbox.transition("terminal-cut", "dispatching");

  const queuedRunId = "00000000-0000-4000-8000-000000000202";
  value.inbox.enqueue({
    operationId: "after-terminal-cut",
    runId: queuedRunId,
    sessionKey: SESSION_KEY,
    prompt: "must drain later",
    createdAt: 1_000,
  });
  value.dispatcher.enqueue({
    id: queuedRunId,
    source: "chat",
    sourceId: SESSION_KEY,
    idempotencyKey: "shoggoth:chat-send:after-terminal-cut",
    profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-workspace",
    retryOf: null,
  });
  value.inbox.commands = new Map([...value.inbox.commands].reverse());
  value.log.length = 0;
  await value.coordinator.open();
  await value.coordinator.waitForIdle(queuedRunId);
  assert.equal(value.inbox.get("terminal-cut").state, "completed");
  assert.equal(value.coordinator.getRun(queuedRunId).status, "running");
  assert.ok(value.log.indexOf("inbox.transition:completed") < value.log.indexOf("dispatcher.admit"));
  const recovered = value.coordinator.subscribeRun(
    terminalRunId,
    { streamId: null, afterSeq: 0 },
    () => {},
  );
  assert.deepEqual(recovered.events.map((event) => event.type), ["terminal"]);
  assert.equal(recovered.events[0].payload.recovered, true);
  recovered.unsubscribe();
  await value.coordinator.close();
});

test("terminal commit uncertain 会 poison Coordinator 且绝不删除 active Inbox", async () => {
  for (const cut of ["product", "inbox"]) {
    const value = await openFixture({
      sessionStatus: "ready",
      threadId: `thread-uncertain-${cut}`,
      threads: [{ id: `thread-uncertain-${cut}`, threadSource: null, turns: [] }],
      transitionFailures: cut === "product" ? { completed: "STORE_COMMIT_UNCERTAIN" } : {},
      inboxTransitionFailures: cut === "inbox" ? { completed: "PENDING_COMMAND_COMMIT_UNCERTAIN" } : {},
    });
    const operationId = `uncertain-${cut}`;
    const { ack } = await sendAndDrain(value, { operationId });
    const run = value.dispatcher.getRun(ack.run.id);
    const turn = value.host.threads[0].turns.find((candidate) => candidate.id === run.runtimeTurnRef?.turnId);
    turn.status = "completed";
    turn.items.push({ type: "agentMessage", text: "done", phase: "final_answer" });
    const terminalEvents = [];
    const subscription = value.coordinator.subscribeRun(
      run.id,
      { streamId: null, afterSeq: 0 },
      (event) => {
        if (event.type === "terminal") terminalEvents.push(event);
      },
    );
    value.host.emit({
      known: true,
      type: "complete",
      method: "turn/completed",
      threadId: run.runtimeSessionRef?.sessionId,
      turnId: run.runtimeTurnRef?.turnId,
      status: "completed",
    });
    if (cut === "product") {
      value.host.emit({
        known: true,
        type: "complete",
        method: "turn/completed",
        threadId: run.runtimeSessionRef?.sessionId,
        turnId: run.runtimeTurnRef?.turnId,
        status: "completed",
      });
    }
    await assert.rejects(
      () => value.coordinator.waitForIdle(run.id),
      (error) => error.code === (cut === "product"
        ? "STORE_COMMIT_UNCERTAIN"
        : "PENDING_COMMAND_COMMIT_UNCERTAIN"),
    );
    assert.equal(value.inbox.get(operationId).state, "dispatching");
    assert.equal(value.dispatcher.getRun(run.id).status, cut === "product" ? "running" : "completed");
    assert.equal(terminalEvents.length, cut === "product" ? 0 : 1);
    await assert.rejects(() => value.coordinator.send({
      operationId: `after-poison-${cut}`,
      sessionKey: SESSION_KEY,
      prompt: "must stay poisoned",
    }), (error) => error.code === (cut === "product"
      ? "STORE_COMMIT_UNCERTAIN"
      : "PENDING_COMMAND_COMMIT_UNCERTAIN"));
    subscription.unsubscribe();
    await value.coordinator.close();
  }
});

test("open recovery 收敛丢失 execution contract 时遇到 STORE_COMMIT_UNCERTAIN 会拒绝 open", async () => {
  const runId = "00000000-0000-4000-8000-000000000203";
  const value = fixture({
    sessionStatus: "ready",
    threadId: "thread-open-poison",
    threads: [{
      id: "thread-open-poison",
      threadSource: null,
      turns: [{
        id: "turn-open-poison",
        status: "completed",
        itemsView: "full",
        items: [
          { type: "userMessage", clientId: "open-poison" },
          { type: "agentMessage", text: "persist me", phase: "final_answer" },
        ],
      }],
    }],
    transitionFailures: { interrupted: "STORE_COMMIT_UNCERTAIN" },
  });
  value.inbox.enqueue({
    operationId: "open-poison",
    runId,
    sessionKey: SESSION_KEY,
    prompt: "reconcile during open",
    createdAt: 1_000,
  });
  value.dispatcher.enqueue({
    id: runId,
    source: "chat",
    sourceId: SESSION_KEY,
    idempotencyKey: "shoggoth:chat-send:open-poison",
    profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-workspace",
    retryOf: null,
  });
  value.dispatcher.admit(runId);
  value.inbox.transition("open-poison", "dispatching");
  await assert.rejects(
    () => value.coordinator.open(),
    (error) => error.code === "STORE_COMMIT_UNCERTAIN",
  );
  assert.equal(value.dispatcher.getRun(runId).status, "starting");
  assert.equal(value.inbox.get("open-poison").state, "dispatching");
  await value.coordinator.close();
});

test("canonical turn status 映射 failed/interrupted/canceled 并各自只发一次 terminal", async () => {
  for (const [remoteStatus, expectedErrorCode] of [
    ["failed", "RUNTIME_TURN_FAILED"],
    ["interrupted", "RUNTIME_TURN_INTERRUPTED"],
    ["canceled", null],
  ]) {
    const value = await openFixture({
      sessionStatus: "ready",
      threadId: `thread-${remoteStatus}`,
      threads: [{ id: `thread-${remoteStatus}`, threadSource: null, turns: [] }],
    });
    const { ack } = await sendAndDrain(value, { operationId: `terminal-${remoteStatus}` });
    const running = value.coordinator.getRun(ack.run.id);
    const turn = value.host.threads[0].turns.find((candidate) => candidate.id === running.runtimeTurnRef?.turnId);
    turn.status = remoteStatus;
    const terminalEvents = [];
    const subscription = value.coordinator.subscribeRun(
      running.id,
      { streamId: null, afterSeq: 0 },
      (event) => {
        if (event.type === "terminal") terminalEvents.push(event);
      },
    );
    const event = {
      known: true,
      type: "complete",
      method: "turn/completed",
      threadId: running.runtimeSessionRef?.sessionId,
      turnId: running.runtimeTurnRef?.turnId,
      status: "completed",
    };
    value.host.emit(event);
    value.host.emit(event);
    await value.coordinator.waitForIdle(running.id);
    const terminal = value.coordinator.getRun(running.id);
    assert.equal(terminal.status, remoteStatus);
    assert.equal(terminal.errorCode, expectedErrorCode);
    assert.equal(terminalEvents.length, 1);
    subscription.unsubscribe();
    await value.coordinator.close();
  }
});

test("terminal failed turn 只从结构化错误映射认证和额度状态，不泄露 Runtime message", async () => {
  for (const [name, failure, expectedCode = "RUNTIME_AUTH_REQUIRED"] of [
    ["codex", {
      error: {
        message: "401 includes private upstream details",
        codexErrorInfo: "unauthorized",
        additionalDetails: "authorization header details",
      },
    }],
    ["grok", { errorCode: "AUTH_REQUIRED" }],
    ["codex-quota", { error: { codexErrorInfo: "usageLimitExceeded",
      message: "private upstream details" } }, "RUNTIME_QUOTA_EXHAUSTED"],
  ]) {
    const value = await openFixture({
      sessionStatus: "ready",
      threadId: `thread-terminal-auth-${name}`,
      threads: [{ id: `thread-terminal-auth-${name}`, threadSource: null, turns: [] }],
    });
    try {
      const { ack } = await sendAndDrain(value, { operationId: `terminal-auth-${name}` });
      const running = value.coordinator.getRun(ack.run.id);
      const turn = value.host.threads[0].turns.find(
        (candidate) => candidate.id === running.runtimeTurnRef?.turnId,
      );
      turn.status = "failed";
      Object.assign(turn, clone(failure));
      value.host.emit({
        known: true,
        type: "complete",
        method: "turn/completed",
        threadId: running.runtimeSessionRef?.sessionId,
        turnId: running.runtimeTurnRef?.turnId,
        status: "failed",
      });
      const terminal = await value.coordinator.waitForIdle(running.id);
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.errorCode, expectedCode);
      assert.equal(JSON.stringify(terminal).includes("private upstream details"), false);
      assert.equal(JSON.stringify(terminal).includes("authorization header details"), false);
    } finally {
      await value.coordinator.close();
    }
  }
});

test("terminal failed turn 保留权限与上游不可用公共错误码", async () => {
  for (const errorCode of ["RUNTIME_PERMISSION_REQUIRED", "RUNTIME_UPSTREAM_UNAVAILABLE",
    "RUNTIME_APPROVAL_UNAVAILABLE", "RUNTIME_QUOTA_EXHAUSTED", "RUNTIME_RATE_LIMITED", "RUNTIME_ACCOUNT_BLOCKED",
    "RUNTIME_SPENDING_LIMIT_REACHED", "ANTIGRAVITY_NETWORK_UNAVAILABLE",
    "ANTIGRAVITY_REGION_UNSUPPORTED", "ANTIGRAVITY_ELIGIBILITY_FAILED", "ANTIGRAVITY_STARTUP_TIMEOUT"]) {
    const value = await openFixture({
      sessionStatus: "ready",
      threadId: `thread-terminal-${errorCode}`,
      threads: [{ id: `thread-terminal-${errorCode}`, threadSource: null, turns: [] }],
    });
    try {
      const { ack } = await sendAndDrain(value, { operationId: `terminal-${errorCode}` });
      const running = value.coordinator.getRun(ack.run.id);
      const turn = value.host.threads[0].turns.find(
        (candidate) => candidate.id === running.runtimeTurnRef?.turnId,
      );
      turn.status = "failed";
      turn.errorCode = errorCode;
      value.host.emit({
        known: true,
        type: "complete",
        method: "turn/completed",
        threadId: running.runtimeSessionRef?.sessionId,
        turnId: running.runtimeTurnRef?.turnId,
        status: "failed",
      });
      const terminal = await value.coordinator.waitForIdle(running.id);
      assert.equal(terminal.errorCode, errorCode);
    } finally {
      await value.coordinator.close();
    }
  }
});

test("resultSummary 只取目标 turn 的 canonical final_answer 并按 UTF-8 边界脱敏检查", async () => {
  const checked = [];
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-summary-bound",
    threads: [{ id: "thread-summary-bound", threadSource: null, turns: [] }],
    maxResultSummaryBytes: 5,
    sanitizeSummary: (summary) => summary.replace("secret", "你"),
    assertSecretSafe: (payload, context) => {
      if (context.kind === "resultSummary") checked.push(clone(payload));
      return true;
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "summary-bound" });
  const running = value.coordinator.getRun(ack.run.id);
  const target = value.host.threads[0].turns.find((turn) => turn.id === running.runtimeTurnRef?.turnId);
  target.status = "completed";
  target.items.push({ type: "agentMessage", text: "secretab好", phase: "final_answer" });
  value.host.threads[0].turns.push({
    id: "later-unrelated-turn",
    status: "completed",
    itemsView: "full",
    items: [{ type: "agentMessage", text: "wrong turn", phase: "final_answer" }],
  });
  value.host.emit({
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    status: "completed",
  });
  await value.coordinator.waitForIdle(running.id);
  assert.equal(value.coordinator.getRun(running.id).resultSummary, "你ab");
  assert.deepEqual(checked, [{ resultSummary: "你ab" }]);
  await value.coordinator.close();
});

test("构造/open/close 有明确生命周期，close 后拒绝新发送", async () => {
  assert.throws(() => new WorkRunCoordinator({}), (error) => error.code === "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED");
  const value = fixture();
  await assert.rejects(() => value.coordinator.send({
    operationId: "before-open", sessionKey: SESSION_KEY, prompt: "x",
  }), (error) => error.code === "WORK_RUN_COORDINATOR_CLOSED");
  assert.equal(await value.coordinator.open(), value.coordinator);
  await value.coordinator.close();
  await assert.rejects(() => value.coordinator.send({
    operationId: "after-close", sessionKey: SESSION_KEY, prompt: "x",
  }), (error) => error.code === "WORK_RUN_COORDINATOR_CLOSED");
});

test("并发 open 共享同一恢复过程，恢复 settle 前 send 固定拒绝 OPENING", async () => {
  const log = [];
  const inbox = new FakeInbox(log);
  inbox.enqueue({
    operationId: "opening-recovery",
    runId: "00000000-0000-4000-8000-000000000055",
    sessionKey: SESSION_KEY,
    prompt: "recover before ready",
    createdAt: 1_000,
  });
  const gate = deferred();
  const value = fixture({ inbox, runtimeGate: gate });
  value.inbox.log = value.log;
  const firstOpen = value.coordinator.open();
  while (!value.log.includes("runtimePool.get")) await new Promise((resolve) => setImmediate(resolve));
  let secondSettled = false;
  const secondOpen = value.coordinator.open().then((result) => {
    secondSettled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  await assert.rejects(() => value.coordinator.send({
    operationId: "during-opening", sessionKey: SESSION_KEY, prompt: "must wait",
  }), (error) => error.code === "WORK_RUN_COORDINATOR_OPENING");
  gate.resolve();
  assert.equal(await firstOpen, value.coordinator);
  assert.equal(await secondOpen, value.coordinator);
  assert.equal(value.host.threadStartCalls, 1);
  assert.equal(value.host.turnStartCalls, 1);
  assert.equal(value.host.lastThreadStartParams.developerInstructions,
    shoggothProductDeveloperInstructions({
      source: "chat", sourceId: SESSION_KEY, profileName: "Shoggoth", runtime: "codex",
    }));
  assert.match(value.host.lastThreadStartParams.developerInstructions,
    /\{"name":"Shoggoth","runtime":"codex"\}/u);
  await value.coordinator.close();
});

test("without ContextCompiler, shared Codex runtime still receives the exact backend and custom Agent name", async () => {
  for (const [backendId, profileName] of [["shoggoth", "Shoggoth"], ["codex", "Codex"], ["codex", "小码"]]) {
    const value = await openFixture({ backendId, profileName });
    try {
      await sendAndDrain(value);
      const instructions = value.host.lastThreadStartParams.developerInstructions;
      const identity = JSON.parse(instructions.match(/^Active Agent Profile identity .*?: (.+)$/mu)[1]);
      assert.deepEqual(identity, { name: profileName, backendId, runtime: "codex" });
    } finally { await value.coordinator.close(); }
  }
});

test("send 严格 Inbox→queued→admit 后后台执行，prompt 永不进入 ProductStore", async () => {
  const value = await openFixture();
  const { ack, operationId } = await sendAndDrain(value);
  assert.deepEqual(value.log.slice(0, 3), ["inbox.enqueue", "dispatcher.enqueue", "dispatcher.admit"]);
  assert.equal(ack.disposition, "started");
  assert.deepEqual(value.dispatcher.lastAdmission, { onBusy: "queue", writable: true });
  assert.equal(value.dispatcher.getRun(ack.run.id).status, "running");
  assert.equal(value.inbox.get(operationId).state, "dispatching");
  assert.equal(value.dispatcher.forbiddenPromptSeen, false);
  assert.equal(value.host.threadStartCalls, 1);
  assert.equal(value.host.turnStartCalls, 1);
  const turnCallIndex = value.log.indexOf("host.turnStart");
  assert.ok(turnCallIndex > value.log.indexOf("host.threadStart"));
  assert.equal(value.host.lastTurnStartParams.approvalPolicy, "on-request");
  assert.equal(Object.prototype.hasOwnProperty.call(value.host.lastTurnStartParams, "sandbox"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(value.host.lastTurnStartParams, "sandboxPolicy"), false);
  await value.coordinator.close();
});

test("额度拒绝保持 terminal 持久化顺序，提交不确定时停止且不调用 Runtime", async () => {
  for (const cut of ["product", "inbox"]) {
    const events = [];
    const runtimeAccountAdmission = createRuntimeAccountAdmission(events, { rejected: "RUNTIME_QUOTA_EXHAUSTED" });
    const value = await openFixture({ runtimeAccountAdmission,
      transitionFailures: cut === "product" ? { failed: "STORE_COMMIT_UNCERTAIN" } : {},
      inboxTransitionFailures: cut === "inbox" ? { completed: "PENDING_COMMAND_COMMIT_UNCERTAIN" } : {},
    });
    const expected = cut === "product" ? "STORE_COMMIT_UNCERTAIN" : "PENDING_COMMAND_COMMIT_UNCERTAIN";
    try {
      await assert.rejects(value.coordinator.send({ operationId: `quota-cut-${cut}`,
        sessionKey: SESSION_KEY, prompt: "quota" }), { code: expected });
      assert.notEqual(value.inbox.get(`quota-cut-${cut}`).state, "completed");
      assert.equal(events.some(([name]) => name === "account.release"), false);
      assert.equal(value.log.includes("host.turnStart"), false);
      await assert.rejects(value.coordinator.send({ operationId: `after-quota-cut-${cut}`,
        sessionKey: SESSION_KEY, prompt: "quota" }), { code: expected });
    } finally {
      await value.coordinator.close();
    }
  }
});

test("RuntimeAccount busy 在 WorkDispatcher 前保持 queued，未取得账号槽时不 release", async () => {
  const accountEvents = [];
  const runtimeAccountAdmission = createRuntimeAccountAdmission(accountEvents, { queued: true });
  const value = await openFixture({ runtimeAccountAdmission });
  try {
    const ack = await value.coordinator.send({
      operationId: "account-busy-before-dispatcher",
      sessionKey: SESSION_KEY,
      prompt: "stay queued",
    });
    assert.equal(ack.disposition, "queued");
    assert.equal(ack.reason, "RUNTIME_ACCOUNT_ACTIVE_LIMIT");
    assert.equal(value.dispatcher.getRun(ack.run.id).status, "queued");
    assert.equal(value.log.includes("dispatcher.admit"), false);
    assert.equal(value.log.includes("runtimePool.get"), false);
    assert.deepEqual(accountEvents.map(([name]) => name), ["account.admit"]);
    assert.equal(runtimeAccountAdmission.active.size, 0);
  } finally {
    await value.coordinator.close();
  }
  assert.deepEqual(accountEvents.map(([name]) => name), ["account.admit"]);
});

test("结构化 Retry-After 写入账号级 backoff：同账号 Agent 排队，其他账号继续运行", async () => {
  const log = [];
  const accountA = NATIVE_CODEX_RUNTIME_ACCOUNT_ID;
  const accountB = SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID;
  const retryAt = 5_000;
  const accounts = new Map(DEFAULT_RUNTIME_ACCOUNTS.map((account) => [account.id, account]));
  const runtimeAccountAdmission = new RuntimeAccountAdmission({
    runtimeAccountLookup: (id) => accounts.get(id) || null,
    now: () => 1_000,
  });
  const profileIds = ["profile-rate-source", "profile-rate-peer", "profile-other-account"];
  const sessionKeys = [
    "81111111-1111-4111-8111-111111111111",
    "82222222-2222-4222-8222-222222222222",
    "83333333-3333-4333-8333-333333333333",
  ];
  const profileAccounts = new Map([
    [profileIds[0], accountA],
    [profileIds[1], accountA],
    [profileIds[2], accountB],
  ]);
  const productStore = {
    defaultCwd: "/tmp/default-cwd",
    getAgentProfile(profileId) {
      const runtimeAccountId = profileAccounts.get(profileId);
      if (!runtimeAccountId) return null;
      return {
        id: profileId,
        agentId: `agent-${profileId}`,
        name: profileId,
        enabled: true,
        runtime: "codex",
        runtimeProfileId: `runtime-${profileId}`,
        runtimeAccountId,
        defaultModel: "gpt-test",
        providerRef: "chatgpt",
        defaultCwd: this.defaultCwd,
        concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
        permissionPolicy: { approvalPolicy: "on-failure", sandbox: "workspace-write" },
      };
    },
  };
  const sessionStores = new Map(sessionKeys.map((sessionKey, index) => {
    const store = new FakeChatSessionStore(log);
    store.session = {
      ...store.session,
      id: `93333333-3333-4333-8333-33333333333${index}`,
      sessionKey,
      profileId: profileIds[index],
    };
    return [sessionKey, store];
  }));
  const storeFor = (sessionKey) => sessionStores.get(sessionKey) || null;
  const sessions = {
    getSession: (sessionKey) => storeFor(sessionKey)?.getSession(sessionKey) || null,
    requestBinding: (sessionKey, ...args) => storeFor(sessionKey).requestBinding(sessionKey, ...args),
    completeBinding: (sessionKey, ...args) => storeFor(sessionKey).completeBinding(sessionKey, ...args),
    getBinding: (sessionKey) => storeFor(sessionKey)?.getBinding(sessionKey) || null,
    replaceBoundRuntimeSession: (input) => storeFor(input.sessionKey).replaceBoundRuntimeSession(input),
    listPendingBindings: () => [...sessionStores.values()].flatMap((store) => store.listPendingBindings()),
    recoverBinding(input) {
      const store = [...sessionStores.values()].find(
        (candidate) => candidate.binding?.threadSource === input.threadSource,
      );
      return store.recoverBinding(input);
    },
  };
  const healthyHost = new FakeHost(log);
  const healthyRuntime = directRuntimeManager(healthyHost, "codex");
  const acquireAccounts = [];
  const rateLimit = runtimeAccountBackoffError(codedError("RPC_REMOTE_ERROR"), retryAt);
  const runtimeManager = {
    async acquire(binding) {
      acquireAccounts.push(binding.runtimeAccountId);
      if (binding.runtimeAccountId === accountA) throw rateLimit;
      return healthyRuntime.acquire(binding);
    },
    stop() {},
    stopAll() {},
  };
  const value = await openFixture({
    productStore,
    sessions,
    runtimeManager,
    runtimeAccountAdmission,
  });
  try {
    const limited = await value.coordinator.send({
      operationId: "rate-limit-source-agent",
      sessionKey: sessionKeys[0],
      prompt: "trigger normalized retry metadata",
    });
    const failed = await value.coordinator.waitForIdle(limited.run.id);
    assert.equal(failed.status, "failed");
    assert.equal(runtimeAccountAdmission.read(accountA).backoffUntil, retryAt);
    assert.deepEqual(acquireAccounts, [accountA], "Retry-After 不得触发立即重试");

    const sameAccount = await value.coordinator.send({
      operationId: "rate-limit-peer-agent",
      sessionKey: sessionKeys[1],
      prompt: "must stay queued",
    });
    assert.equal(sameAccount.disposition, "queued");
    assert.equal(sameAccount.reason, "RUNTIME_ACCOUNT_BACKOFF");
    assert.equal(runtimeAccountAdmission.read(accountA).backoffUntil, retryAt);
    assert.deepEqual(acquireAccounts, [accountA]);

    const otherAccount = await value.coordinator.send({
      operationId: "rate-limit-other-account-agent",
      sessionKey: sessionKeys[2],
      prompt: "must continue",
    });
    await value.coordinator.waitForIdle(otherAccount.run.id);
    assert.equal(value.coordinator.getRun(otherAccount.run.id).status, "running");
    assert.deepEqual(acquireAccounts, [accountA, accountB]);
    assert.equal(runtimeAccountAdmission.read(accountA).active, 0);
    assert.equal(runtimeAccountAdmission.read(accountB).active, 1);
  } finally {
    await value.coordinator.close();
  }
  assert.equal(runtimeAccountAdmission.read(accountB).active, 0);
});

test("Codex 账号级限流通知只影响当前 generation 的 active RuntimeAccount", async () => {
  const accountEvents = [];
  const runtimeAccountAdmission = createRuntimeAccountAdmission(accountEvents);
  const value = await openFixture({ runtimeAccountAdmission, now: () => 1_000 });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "account-rate-limit-event" });
    assert.equal(value.coordinator.getRun(ack.run.id).status, "running");
    value.host.emit({
      known: true,
      type: "account_backoff",
      method: "account/rateLimits/updated",
      retryAt: 5_000,
    });
    assert.deepEqual(accountEvents.filter(([name]) => name === "account.noteRateLimitBackoff"), [[
      "account.noteRateLimitBackoff",
      { runtimeAccountId: RUNTIME_ACCOUNT_ID, generation: 1, retryAt: 5_000 },
    ]]);

    for (const retryAt of [1_000, "6000", 1_000 + 367 * 24 * 60 * 60 * 1_000]) {
      value.host.emit({
        known: true,
        type: "account_backoff",
        method: "account/rateLimits/updated",
        retryAt,
      });
    }
    assert.equal(accountEvents.filter(([name]) => name === "account.noteRateLimitBackoff").length, 1);

    runtimeAccountAdmission.bumpGeneration();
    value.host.emit({
      known: true,
      type: "account_backoff",
      method: "account/rateLimits/updated",
      retryAt: 6_000,
    });
    assert.equal(accountEvents.filter(([name]) => name === "account.noteRateLimitBackoff").length, 1);
    value.host.emit({ known: true, type: "account_available", method: "account/rateLimits/updated" });
    assert.equal(accountEvents.filter(([name]) => name === "account.noteRateLimitBackoff").length, 1,
      "stale host recovery cannot clear a newer account generation");
  } finally {
    await value.coordinator.close();
  }
});

test("RuntimeAccount 已获准时先于 WorkDispatcher，dispatcher queued/throw 均立即 release", async () => {
  {
    const events = [];
    const dispatcher = new FakeDispatcher(events, { busy: true });
    const runtimeAccountAdmission = createRuntimeAccountAdmission(events);
    const value = await openFixture({ dispatcher, runtimeAccountAdmission });
    try {
      const ack = await value.coordinator.send({
        operationId: "dispatcher-busy-after-account",
        sessionKey: SESSION_KEY,
        prompt: "dispatcher busy",
      });
      assert.equal(ack.disposition, "queued");
      assert.deepEqual(events.map((entry) => Array.isArray(entry) ? entry[0] : entry), [
        "dispatcher.enqueue",
        "account.admit",
        "dispatcher.admit",
        "account.release",
      ]);
      assert.equal(runtimeAccountAdmission.active.size, 0);
    } finally {
      await value.coordinator.close();
    }
  }

  {
    const events = [];
    const dispatcher = new FakeDispatcher(events);
    dispatcher.admit = () => {
      events.push("dispatcher.admit");
      throw codedError("INJECTED_DISPATCHER_ADMIT_FAILURE");
    };
    const runtimeAccountAdmission = createRuntimeAccountAdmission(events);
    const value = await openFixture({ dispatcher, runtimeAccountAdmission });
    try {
      await assert.rejects(
        () => value.coordinator.send({
          operationId: "dispatcher-throw-after-account",
          sessionKey: SESSION_KEY,
          prompt: "dispatcher throws",
        }),
        (error) => error.code === "INJECTED_DISPATCHER_ADMIT_FAILURE",
      );
      assert.deepEqual(events.map((entry) => Array.isArray(entry) ? entry[0] : entry), [
        "dispatcher.enqueue",
        "account.admit",
        "dispatcher.admit",
        "account.release",
      ]);
      assert.equal(runtimeAccountAdmission.active.size, 0);
    } finally {
      await value.coordinator.close();
    }
  }
});

test("RuntimeAccount admission 在 terminal、close 与 open 失败边界 exactly-once release", async () => {
  {
    const accountEvents = [];
    const runtimeAccountAdmission = createRuntimeAccountAdmission(accountEvents);
    const value = await openFixture({ runtimeAccountAdmission });
    const { ack } = await sendAndDrain(value, { operationId: "account-terminal-release" });
    const running = value.coordinator.getRun(ack.run.id);
    assert.equal(runtimeAccountAdmission.active.has(running.id), true);
    const thread = value.host.threads.find((candidate) => candidate.id === running.runtimeSessionRef?.sessionId);
    const turn = thread.turns.find((candidate) => candidate.id === running.runtimeTurnRef?.turnId);
    turn.status = "completed";
    turn.items.push({ type: "agentMessage", phase: "final_answer", text: "done" });
    value.host.emit({
      known: true,
      type: "complete",
      method: "turn/completed",
      threadId: running.runtimeSessionRef?.sessionId,
      turnId: running.runtimeTurnRef?.turnId,
      status: "completed",
    });
    await value.coordinator.waitForIdle(running.id);
    assert.equal(runtimeAccountAdmission.active.size, 0);
    assert.equal(accountEvents.filter(([name]) => name === "account.release").length, 1);
    await value.coordinator.close();
    assert.equal(accountEvents.filter(([name]) => name === "account.release").length, 1);
  }

  {
    const accountEvents = [];
    const runtimeAccountAdmission = createRuntimeAccountAdmission(accountEvents);
    const value = await openFixture({ runtimeAccountAdmission });
    const { ack } = await sendAndDrain(value, { operationId: "account-close-release" });
    assert.equal(runtimeAccountAdmission.active.has(ack.run.id), true);
    await value.coordinator.close();
    assert.equal(runtimeAccountAdmission.active.size, 0);
    assert.equal(accountEvents.filter(([name]) => name === "account.release").length, 1);
  }

  {
    const events = [];
    const runtimeAccountAdmission = createRuntimeAccountAdmission(events);
    const dispatcher = new FakeDispatcher(events);
    const originalAdmit = dispatcher.admit.bind(dispatcher);
    let admitCalls = 0;
    dispatcher.admit = (...args) => {
      admitCalls += 1;
      if (admitCalls === 2) {
        events.push("dispatcher.admit");
        throw codedError("INJECTED_OPEN_ADMIT_FAILURE");
      }
      return originalAdmit(...args);
    };
    const inbox = new FakeInbox(events);
    const sessions = new FakeChatSessionStore(events);
    const secondSessionKey = "22222222-2222-4222-8222-222222222222";
    const originalGetSession = sessions.getSession.bind(sessions);
    sessions.getSession = (sessionKey) => sessionKey === secondSessionKey
      ? { ...clone(sessions.session), id: "44444444-4444-4444-8444-444444444444", sessionKey }
      : originalGetSession(sessionKey);
    for (const [index, sessionKey] of [SESSION_KEY, secondSessionKey].entries()) {
      const operationId = `open-account-release-${index}`;
      const runId = `00000000-0000-4000-8000-${String(index + 701).padStart(12, "0")}`;
      inbox.enqueue({ operationId, runId, sessionKey, prompt: "recover", createdAt: 1_000 });
      dispatcher.enqueue({
        id: runId,
        source: "chat",
        sourceId: sessionKey,
        idempotencyKey: `shoggoth:chat-send:${operationId}`,
        profileId: PROFILE_ID,
        workspace: "/tmp/shoggoth-workspace",
        retryOf: null,
      });
    }
    const value = fixture({ dispatcher, inbox, sessions, runtimeAccountAdmission });
    await assert.rejects(
      () => value.coordinator.open(),
      (error) => error.code === "INJECTED_OPEN_ADMIT_FAILURE",
    );
    assert.equal(runtimeAccountAdmission.active.size, 0);
    assert.equal(events.filter((entry) => Array.isArray(entry)
      && entry[0] === "account.release").length, 2);
  }
});

test("RuntimeAccount generation 在 acquire 与后续 pre-turn await 两侧 fail closed", async () => {
  {
    const accountEvents = [];
    const runtimeAccountAdmission = createRuntimeAccountAdmission(accountEvents);
    const host = new FakeHost([]);
    const runtimeManager = directRuntimeManager(host, "codex");
    const originalAcquire = runtimeManager.acquire.bind(runtimeManager);
    runtimeManager.acquire = async (...args) => {
      const handle = await originalAcquire(...args);
      runtimeAccountAdmission.bumpGeneration();
      return handle;
    };
    const value = await openFixture({ host, runtimeManager, runtimeAccountAdmission });
    const ack = await value.coordinator.send({
      operationId: "stale-during-acquire",
      sessionKey: SESSION_KEY,
      prompt: "must not reach session",
    });
    await assert.rejects(
      () => value.coordinator.waitForIdle(ack.run.id),
      (error) => error.code === "RUNTIME_ACCOUNT_GENERATION_STALE",
    );
    assert.equal(host.threadStartCalls, 0);
    await value.coordinator.close();
    assert.equal(runtimeAccountAdmission.active.size, 0);
  }

  {
    const accountEvents = [];
    const runtimeAccountAdmission = createRuntimeAccountAdmission(accountEvents);
    const host = new FakeHost([]);
    const originalThreadList = host.threadList.bind(host);
    host.threadList = async (params) => {
      const response = await originalThreadList(params);
      runtimeAccountAdmission.bumpGeneration();
      return response;
    };
    const value = await openFixture({ host, runtimeAccountAdmission });
    const ack = await value.coordinator.send({
      operationId: "stale-during-session-list",
      sessionKey: SESSION_KEY,
      prompt: "must not create session",
    });
    await assert.rejects(
      () => value.coordinator.waitForIdle(ack.run.id),
      (error) => error.code === "RUNTIME_ACCOUNT_GENERATION_STALE",
    );
    assert.equal(host.threadStartCalls, 0);
    assert.equal(host.resumeCalls, 0);
    await value.coordinator.close();
    assert.equal(runtimeAccountAdmission.active.size, 0);
  }

  {
    const accountEvents = [];
    const runtimeAccountAdmission = createRuntimeAccountAdmission(accountEvents);
    const rateLimit = runtimeAccountBackoffError(codedError("RPC_REMOTE_ERROR"), 5_000);
    const runtimeManager = {
      async acquire() {
        runtimeAccountAdmission.bumpGeneration();
        throw rateLimit;
      },
      stop() {},
      stopAll() {},
    };
    const value = await openFixture({ runtimeManager, runtimeAccountAdmission });
    const ack = await value.coordinator.send({
      operationId: "stale-rate-limit-metadata",
      sessionKey: SESSION_KEY,
      prompt: "stale generation must not poison account backoff",
    });
    await assert.rejects(
      () => value.coordinator.waitForIdle(ack.run.id),
      (error) => error.code === "RUNTIME_ACCOUNT_GENERATION_STALE",
    );
    assert.equal(accountEvents.some(([name]) => name === "account.noteBackoff"), false);
    await value.coordinator.close();
    assert.equal(runtimeAccountAdmission.active.size, 0);
  }
});

test("Runtime session 新建后先 claim；恢复时只 claim source 命中的会话并在 resume/read 前 assert", async () => {
  {
    const events = [];
    const dispatcher = new FakeDispatcher(events);
    const inbox = new FakeInbox(events);
    const sessions = new FakeChatSessionStore(events);
    const host = new FakeHost(events);
    const runtimeAccountAdmission = createRuntimeAccountAdmission(events);
    const runtimeSessionOwnershipStore = createRuntimeSessionOwnership(events);
    const value = await openFixture({
      dispatcher,
      inbox,
      sessions,
      host,
      runtimeAccountAdmission,
      runtimeSessionOwnershipStore,
    });
    const { ack } = await sendAndDrain(value, { operationId: "fresh-owned-session" });
    const run = value.coordinator.getRun(ack.run.id);
    const names = events.map((entry) => Array.isArray(entry) ? entry[0] : entry);
    assert.ok(names.indexOf("host.threadStart") < names.indexOf("ownership.claim"));
    assert.ok(names.indexOf("ownership.claim") < names.indexOf("host.turnStart"));
    assert.equal(run.runtimeSessionRef.runtimeAccountId, RUNTIME_ACCOUNT_ID);
    assert.equal(run.runtimeTurnRef.runtimeAccountId, RUNTIME_ACCOUNT_ID);
    const claim = events.find((entry) => Array.isArray(entry) && entry[0] === "ownership.claim")[1];
    assert.deepEqual(claim, {
      runtime: "codex",
      runtimeProfileId: "runtime-default",
      runtimeAccountId: RUNTIME_ACCOUNT_ID,
      sessionId: "thread-created-1",
      profileId: PROFILE_ID,
      workspace: "/tmp/shoggoth-workspace",
    });
    await value.coordinator.close();
  }

  {
    const events = [];
    const operationId = "recover-only-owned-source";
    const bindingId = `bind-${crypto.createHash("sha256").update(operationId).digest("hex").slice(0, 48)}`;
    const matchingSource = `shoggoth:${SESSION_KEY}:${bindingId}`;
    const host = new FakeHost(events, { threads: [
      { id: "native-cli-unowned", threadSource: null, turns: [], archived: false },
      { id: "shoggoth-recovered", threadSource: matchingSource, turns: [], archived: false },
    ] });
    const dispatcher = new FakeDispatcher(events);
    const inbox = new FakeInbox(events);
    const sessions = new FakeChatSessionStore(events);
    const runtimeAccountAdmission = createRuntimeAccountAdmission(events);
    const runtimeSessionOwnershipStore = createRuntimeSessionOwnership(events);
    const value = await openFixture({
      dispatcher,
      inbox,
      sessions,
      host,
      runtimeAccountAdmission,
      runtimeSessionOwnershipStore,
    });
    await sendAndDrain(value, { operationId });
    const claims = events.filter((entry) => Array.isArray(entry) && entry[0] === "ownership.claim");
    assert.equal(claims.length, 1);
    assert.equal(claims[0][1].sessionId, "shoggoth-recovered");
    assert.equal(JSON.stringify(claims).includes("native-cli-unowned"), false);
    const names = events.map((entry) => Array.isArray(entry) ? entry[0] : entry);
    assert.ok(names.indexOf("ownership.claim") < names.indexOf("ownership.assertOwned"));
    assert.ok(names.indexOf("ownership.assertOwned") < names.indexOf("host.threadResume"));
    const readIndex = names.indexOf("host.threadRead");
    assert.ok(readIndex > 0);
    assert.equal(names[readIndex - 1], "account.assertGeneration");
    assert.ok(names.slice(0, readIndex).lastIndexOf("ownership.assertOwned") >= 0);
    await value.coordinator.close();
  }
});

test("ownership 冲突在任何 resume/read 前拒绝本机预存会话", async () => {
  const ownershipEvents = [];
  const runtimeAccountAdmission = createRuntimeAccountAdmission(ownershipEvents);
  const runtimeSessionOwnershipStore = createRuntimeSessionOwnership(ownershipEvents, {
    claimError: "RUNTIME_SESSION_OWNERSHIP_CONFLICT",
  });
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "native-preexisting-thread",
    threads: [{ id: "native-preexisting-thread", threadSource: null, turns: [] }],
    runtimeAccountAdmission,
    runtimeSessionOwnershipStore,
  });
  const ack = await value.coordinator.send({
    operationId: "reject-unowned-native-thread",
    sessionKey: SESSION_KEY,
    prompt: "must not inspect native history",
  });
  await assert.rejects(
    () => value.coordinator.waitForIdle(ack.run.id),
    (error) => error.code === "RUNTIME_SESSION_OWNERSHIP_CONFLICT",
  );
  assert.equal(value.host.resumeCalls, 0);
  assert.equal(value.log.includes("host.threadRead"), false);
  await value.coordinator.close();
  assert.equal(runtimeAccountAdmission.active.size, 0);
});

test("准入冻结 ContextSnapshot，WorkRun 持久绑定且 Codex 分离 developer 与不可信动态上下文", async () => {
  const compiled = {
    id: "ctx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    developerInstructions: "trusted frozen identity",
    dynamicContext: "BEGIN UNTRUSTED MEMORY DATA\nremembered preference\nEND UNTRUSTED MEMORY DATA",
  };
  let compileCalls = 0;
  const value = await openFixture({
    contextCompiler: {
      compile(input) {
        compileCalls += 1;
        assert.equal(input.query, "freeze this request");
        return clone(compiled);
      },
    },
  });
  const { ack } = await sendAndDrain(value, {
    operationId: "frozen-context",
    prompt: "freeze this request",
  });
  assert.equal(compileCalls, 1);
  assert.equal(value.dispatcher.lastAdmission.contextSnapshotId, compiled.id);
  assert.equal(value.dispatcher.getRun(ack.run.id).contextSnapshotId, compiled.id);
  assert.equal(value.host.lastThreadStartParams.developerInstructions, compiled.developerInstructions);
  assert.equal(value.host.lastTurnStartParams.input[0].text, [
    compiled.dynamicContext,
    "",
    "CURRENT USER REQUEST",
    "freeze this request",
  ].join("\n"));
  assert.equal(value.host.lastThreadStartParams.developerInstructions.includes("remembered preference"), false);
  await value.coordinator.close();
});

test("迁移后 detached ChatSession 无 Transcript 证明时 fail closed 且不创建远端会话", async () => {
  const value = await openFixture({ sessionStatus: "ready", threadId: null });
  try {
    const ack = await value.coordinator.send({
      operationId: "detached-without-transcript",
      sessionKey: SESSION_KEY,
      prompt: "must not lose prior semantics",
    });
    const settled = await value.coordinator.waitForIdle(ack.run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, "RUNTIME_SESSION_RECOVERY_HISTORY_REQUIRED");
    assert.equal(value.sessions.session.status, "ready");
    assert.equal(value.sessions.session.runtimeSessionId, null);
    assert.equal(value.host.threadStartCalls, 0);
    assert.equal(value.host.turnStartCalls, 0);
  } finally {
    await value.coordinator.close();
  }
});

test("迁移后 detached ChatSession 以 ChatSession.id 编译旧 Transcript 并注入新首轮 context", async () => {
  const transcriptEvents = [{
    id: "legacy-assistant-event",
    runId: "legacy-run",
    kind: "assistant",
    content: { text: "LEGACY TRANSCRIPT SEMANTICS" },
  }];
  const transcriptStore = {
    appendEvent(input) {
      transcriptEvents.push(clone(input));
      return clone(input);
    },
    listEvents(profileId, sessionId) {
      assert.equal(profileId, PROFILE_ID);
      assert.equal(sessionId, "33333333-3333-4333-8333-333333333333");
      return clone(transcriptEvents);
    },
  };
  const host = new FakeHost([]);
  const runtimeManager = directRuntimeManager(host, "codex");
  const acquire = runtimeManager.acquire.bind(runtimeManager);
  let turnStartInput = null;
  runtimeManager.acquire = async (...args) => {
    const handle = await acquire(...args);
    return {
      ...handle,
      turnStart(input) {
        turnStartInput = clone(input);
        return handle.turnStart(input);
      },
    };
  };
  const value = await openFixture({
    host,
    runtimeManager,
    sessionStatus: "ready",
    threadId: null,
    transcriptStore,
    contextCompiler: {
      compile(input) {
        assert.equal(input.run.sourceId, SESSION_KEY);
        assert.equal(input.transcriptSessionId, value.sessions.session.id);
        return {
          id: `ctx-${"c".repeat(64)}`,
          developerInstructions: "trusted migrated session",
          dynamicContext: "LEGACY TRANSCRIPT SEMANTICS",
        };
      },
    },
  });
  try {
    const { ack } = await sendAndDrain(value, {
      operationId: "detached-semantic-rebind",
      prompt: "continue after migration",
    });
    assert.equal(value.coordinator.getRun(ack.run.id).status, "running");
    assert.equal(host.threadStartCalls, 1);
    assert.equal(host.turnStartCalls, 1);
    assert.equal(turnStartInput.context, "LEGACY TRANSCRIPT SEMANTICS");
    assert.equal(value.sessions.session.status, "ready");
    assert.equal(value.sessions.session.runtimeSessionId, "thread-created-1");
  } finally {
    await value.coordinator.close();
  }
});

test("Codex 新线程在首个 turn 前不可 thread/read 时仍直接启动首轮消息", async () => {
  const value = await openFixture({ unreadableFreshThreadUntilTurnStart: true });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "fresh-thread-first-turn" });
    const run = value.coordinator.getRun(ack.run.id);
    assert.equal(run.status, "running");
    assert.equal(value.host.threadStartCalls, 1);
    assert.equal(value.host.turnStartCalls, 1);
    assert.ok(value.log.indexOf("host.threadStart") < value.log.indexOf("host.turnStart"));
    assert.equal(
      value.log.slice(value.log.indexOf("host.threadStart"), value.log.indexOf("host.turnStart"))
        .includes("host.threadRead"),
      false,
    );
  } finally {
    await value.coordinator.close();
  }
});

test("Codex managed home 未登录时在 session/turn 前 durable 收敛认证错误", async () => {
  const value = await openFixture({
    accountReadResult: { account: null, requiresOpenaiAuth: true },
  });
  try {
    const ack = await value.coordinator.send({
      operationId: "codex-auth-required",
      sessionKey: SESSION_KEY,
      prompt: "must not reach runtime session",
    });
    const settled = await value.coordinator.waitForIdle(ack.run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, "RUNTIME_AUTH_REQUIRED");
    assert.equal(value.host.accountReadCalls, 1);
    assert.equal(value.host.threadStartCalls, 0);
    assert.equal(value.host.turnStartCalls, 0);
    assert.equal(value.inbox.get("codex-auth-required").state, "completed");
  } finally {
    await value.coordinator.close();
  }
});

test("认证状态瞬时不可用时只重试一次，恢复后只启动一个 turn", async () => {
  const value = await openFixture();
  const accountRead = value.host.accountRead.bind(value.host);
  let authAttempts = 0;
  value.host.accountRead = async (...args) => {
    authAttempts += 1;
    if (authAttempts === 1) {
      value.log.push("host.accountRead");
      value.host.accountReadCalls += 1;
      throw codedError("RPC_REMOTE_ERROR", "transient auth probe failure");
    }
    return accountRead(...args);
  };
  try {
    const { ack } = await sendAndDrain(value, { operationId: "auth-status-retry" });
    assert.equal(value.coordinator.getRun(ack.run.id).status, "running");
    assert.equal(authAttempts, 2);
    assert.equal(value.host.accountReadCalls, 2);
    assert.equal(value.host.threadStartCalls, 1);
    assert.equal(value.host.turnStartCalls, 1);
  } finally {
    await value.coordinator.close();
  }
});

test("Grok 缺少凭据时被中央门禁拦截，有凭据但未验证时允许真实 session 验证", async () => {
  const missingHost = new FakeHost([], {
    accountReadSupported: false,
    authenticationStateResult: { authenticated: false, credentialPresent: false },
  });
  const missing = await openFixture({
    runtime: "grok-build",
    host: missingHost,
    runtimeManager: directRuntimeManager(missingHost, "grok-build"),
  });
  try {
    const ack = await missing.coordinator.send({
      operationId: "grok-auth-required",
      sessionKey: SESSION_KEY,
      prompt: "must not reach grok session",
    });
    const settled = await missing.coordinator.waitForIdle(ack.run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, "RUNTIME_AUTH_REQUIRED");
    assert.equal(missing.host.authenticationStateCalls, 1);
    assert.equal(missing.host.threadStartCalls, 0);
    assert.equal(missing.host.turnStartCalls, 0);
  } finally {
    await missing.coordinator.close();
  }

  const unverifiedHost = new FakeHost([], {
    accountReadSupported: false,
    authenticationStateResult: { authenticated: false, credentialPresent: true },
  });
  const unverified = await openFixture({
    runtime: "grok-build",
    host: unverifiedHost,
    runtimeManager: directRuntimeManager(unverifiedHost, "grok-build"),
  });
  try {
    const { ack } = await sendAndDrain(unverified, { operationId: "grok-auth-unverified" });
    assert.equal(unverified.coordinator.getRun(ack.run.id).status, "running");
    assert.equal(unverified.host.authenticationStateCalls, 1);
    assert.equal(unverified.host.threadStartCalls, 1);
    assert.equal(unverified.host.turnStartCalls, 1);
  } finally {
    await unverified.coordinator.close();
  }
});

test("Antigravity execution can defer auth to the CLI without claiming verified login", async () => {
  const host = new FakeHost([], { accountReadSupported: false });
  host.authenticationState = (options) => {
    assert.deepEqual(options, { allowDeferred: true });
    return { verificationDeferred: true };
  };
  const value = await openFixture({ runtime: "antigravity", host,
    runtimeManager: directRuntimeManager(host, "antigravity") });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "antigravity-deferred-auth" });
    assert.equal(value.coordinator.getRun(ack.run.id).status, "running");
    assert.equal(host.turnStartCalls, 1);
  } finally { await value.coordinator.close(); }
});

test("Runtime session 阶段迟到 AUTH_REQUIRED 保留认证错误且不做无意义重试", async () => {
  const host = new FakeHost([], {
    accountReadSupported: false,
    threadStartError: codedError("AUTH_REQUIRED", "secret upstream auth diagnostic"),
  });
  const value = await openFixture({
    runtime: "grok-build",
    host,
    runtimeManager: directRuntimeManager(host, "grok-build"),
  });
  try {
    const ack = await value.coordinator.send({
      operationId: "late-runtime-auth-required",
      sessionKey: SESSION_KEY,
      prompt: "must fail once",
    });
    const settled = await value.coordinator.waitForIdle(ack.run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, "RUNTIME_AUTH_REQUIRED");
    assert.equal(value.host.threadStartCalls, 1);
    assert.equal(value.host.turnStartCalls, 0);
    assert.equal(JSON.stringify(settled).includes("secret upstream auth diagnostic"), false);
  } finally {
    await value.coordinator.close();
  }
});

test("chat 远端启动失败会 durable 收敛 failed，而不是永久停在 starting/思考中", async () => {
  const value = await openFixture({
    threadStartError: codedError("RPC_REMOTE_ERROR"),
  });
  try {
    const ack = await value.coordinator.send({
      operationId: "chat-start-failure",
      sessionKey: SESSION_KEY,
      prompt: "must settle",
    });
    const settled = await value.coordinator.waitForIdle(ack.run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, "RUNTIME_START_SESSION_START_OR_RESUME_FAILED");
    assert.equal(value.inbox.get("chat-start-failure").state, "completed");
    assert.equal(value.host.threadStartCalls, 2, "已证明无远端 thread 后只重试一次");
    assert.equal(value.host.turnStartCalls, 0);
    const replay = value.coordinator.subscribeRun(
      ack.run.id,
      { streamId: null, afterSeq: 0 },
      () => {},
    );
    assert.equal(replay.events.at(-1)?.type, "terminal");
    assert.deepEqual(replay.events.at(-1)?.payload, {
      status: "failed",
      resultSummary: null,
      errorCode: "RUNTIME_START_SESSION_START_OR_RESUME_FAILED",
    });
    replay.unsubscribe();
  } finally {
    await value.coordinator.close();
  }
});

test("Runtime acquire 在 turn 前只重试一次且成功后不重复发送 turn", async () => {
  const value = await openFixture({ runtimeAcquireFailures: 1 });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "runtime-acquire-retry" });
    assert.equal(value.coordinator.getRun(ack.run.id).status, "running");
    assert.equal(value.log.filter((entry) => entry === "runtimePool.get").length, 2);
    assert.equal(value.host.turnStartCalls, 1);
  } finally {
    await value.coordinator.close();
  }
});

test("turn_start 失败保留唯一阶段码且绝不自动重放", async () => {
  const value = await openFixture({
    turnStartError: codedError("RPC_REMOTE_ERROR"),
    unreadableFreshThreadUntilTurnStart: true,
  });
  try {
    const ack = await value.coordinator.send({
      operationId: "turn-start-no-replay",
      sessionKey: SESSION_KEY,
      prompt: "must not replay",
    });
    const settled = await value.coordinator.waitForIdle(ack.run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, "RUNTIME_START_TURN_START_FAILED");
    assert.equal(value.host.turnStartCalls, 1);
  } finally {
    await value.coordinator.close();
  }
});

test("Codex 安装与协议错误穿透启动包装且不重复启动或泄漏诊断", async () => {
  for (const errorCode of [
    "CODEX_SYSTEM_BINARY_NOT_FOUND", "CODEX_RUNTIME_VERSION_MISMATCH",
    "CODEX_RUNTIME_VERSION_PROBE_FAILED", "CODEX_SCHEMA_ERROR",
  ]) {
    let attempts = 0;
    const value = await openFixture({
      runtimeManager: {
        async acquire() {
          attempts += 1;
          throw codedError(errorCode, "private CLI diagnostic must not escape");
        },
        stop() {},
        stopAll() {},
      },
    });
    try {
      const { ack } = await sendAndDrain(value, { operationId: `setup-${errorCode}` });
      const settled = value.coordinator.getRun(ack.run.id);
      assert.equal(settled.status, "failed");
      assert.equal(settled.errorCode, errorCode);
      assert.equal(attempts, 1);
      assert.equal(value.host.turnStartCalls, 0);
      assert.equal(JSON.stringify(settled).includes("private CLI diagnostic"), false);
    } finally {
      await value.coordinator.close();
    }
  }
});

test("turn_start 的上游暂时不可用错误穿透阶段包装且不自动重放", async () => {
  const value = await openFixture({
    turnStartError: codedError("RUNTIME_UPSTREAM_UNAVAILABLE"),
    unreadableFreshThreadUntilTurnStart: true,
  });
  try {
    const ack = await value.coordinator.send({
      operationId: "turn-start-upstream-unavailable",
      sessionKey: SESSION_KEY,
      prompt: "must not replay",
    });
    const settled = await value.coordinator.waitForIdle(ack.run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, "RUNTIME_UPSTREAM_UNAVAILABLE");
    assert.equal(value.host.turnStartCalls, 1);
  } finally {
    await value.coordinator.close();
  }
});

test("Host cwd 使用 WorkRun 准入时 canonical workspace，不重新读取可变 Session 路径", async () => {
  const value = await openFixture({ canonicalWorkspace: "/canonical/workspace" });
  await sendAndDrain(value, { operationId: "canonical-workspace" });
  assert.equal(value.host.lastThreadStartParams.cwd, "/canonical/workspace");
  assert.equal(value.host.lastTurnStartParams.cwd, "/canonical/workspace");
  await value.coordinator.close();
});

test("Session workspace=null 时先把 profile defaultCwd canonicalize 到 WorkRun 并据此加锁执行", async () => {
  const value = await openFixture({
    sessionWorkspace: null,
    defaultCwd: "/symlink/default-workspace",
    canonicalWorkspace: "/canonical/default-workspace",
  });
  const { ack } = await sendAndDrain(value, { operationId: "canonical-default-cwd" });
  assert.equal(value.dispatcher.getRun(ack.run.id).workspace, "/canonical/default-workspace");
  assert.equal(value.host.lastThreadStartParams.cwd, "/canonical/default-workspace");
  assert.equal(value.host.lastTurnStartParams.cwd, "/canonical/default-workspace");
  await value.coordinator.close();
});

test("准入冻结 sandbox 与 approval，Profile 迟到更新不能扩大当前 Run 权限", async () => {
  const value = fixture({
    sessionStatus: "ready",
    threadId: "thread-admission-contract",
    threads: [{ id: "thread-admission-contract", threadSource: null, turns: [] }],
    sandbox: "read-only",
    maxActive: 2,
  });
  let sandbox = "read-only";
  let approvalPolicy = "on-failure";
  const originalProfile = value.productStore.getAgentProfile.bind(value.productStore);
  value.productStore.getAgentProfile = (profileId) => {
    const profile = originalProfile(profileId);
    return {
      ...profile,
      permissionPolicy: { sandbox, approvalPolicy },
    };
  };
  const originalAdmit = value.dispatcher.admit.bind(value.dispatcher);
  value.dispatcher.admit = (...args) => {
    const admitted = originalAdmit(...args);
    sandbox = "workspace-write";
    approvalPolicy = "never";
    return admitted;
  };
  await value.coordinator.open();
  await sendAndDrain(value, { operationId: "admission-contract" });
  assert.equal(value.host.lastResumeParams.sandbox, "read-only");
  assert.equal(value.host.lastResumeParams.approvalPolicy, "on-request");
  assert.equal(value.host.lastTurnStartParams.approvalPolicy, "on-request");
  await value.coordinator.close();
});

test("ChatSession 权限模式覆盖 Profile 基线并冻结到下一轮 Runtime 调用", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-session-permission",
    threads: [{ id: "thread-session-permission", threadSource: null, turns: [] }],
    sandbox: "read-only",
    permissionMode: "workspace-auto",
  });
  await sendAndDrain(value, { operationId: "session-permission" });
  assert.equal(value.host.lastResumeParams.sandbox, "workspace-write");
  assert.equal(value.host.lastResumeParams.approvalPolicy, "never");
  assert.equal(value.host.lastTurnStartParams.approvalPolicy, "never");
  await value.coordinator.close();
});

test("writable Run 缺少显式 execution cwd 时在 Inbox 落盘前 fail closed", async () => {
  const value = fixture({ sessionWorkspace: null, defaultCwd: null });
  await value.coordinator.open();
  await assert.rejects(() => value.coordinator.send({
    operationId: "missing-execution-cwd",
    sessionKey: SESSION_KEY,
    prompt: "must not use an unlocked implicit cwd",
  }), (error) => error.code === "WORKSPACE_REQUIRED_FOR_WRITABLE_RUN");
  assert.equal(value.inbox.get("missing-execution-cwd"), null);
  assert.equal(value.dispatcher.listRuns().length, 0);
  assert.equal(value.log.includes("runtimePool.get"), false);
  await value.coordinator.close();
});

test("恢复旧 starting writable Run 时先按丢失 execution contract fail closed，不尝试推断 cwd", async () => {
  const value = fixture({
    sessionStatus: "ready",
    threadId: "thread-legacy-null-workspace",
    threads: [{ id: "thread-legacy-null-workspace", threadSource: null, turns: [] }],
    sessionWorkspace: null,
    defaultCwd: null,
  });
  const runId = "00000000-0000-4000-8000-000000000301";
  value.inbox.enqueue({
    operationId: "legacy-null-workspace",
    runId,
    sessionKey: SESSION_KEY,
    prompt: "must not inherit process cwd",
    createdAt: 1_000,
  });
  value.dispatcher.enqueue({
    id: runId,
    source: "chat",
    sourceId: SESSION_KEY,
    idempotencyKey: "shoggoth:chat-send:legacy-null-workspace",
    profileId: PROFILE_ID,
    workspace: null,
    retryOf: null,
  });
  value.dispatcher.admit(runId, { writable: true });
  value.log.length = 0;
  await value.coordinator.open();
  await value.coordinator.waitForIdle(runId);
  assert.equal(value.log.includes("runtimePool.get"), false);
  assert.equal(value.dispatcher.getRun(runId).status, "interrupted");
  assert.equal(value.dispatcher.getRun(runId).errorCode, "EXECUTION_CONTRACT_LOST");
  assert.equal(value.inbox.get("legacy-null-workspace").state, "completed");
  assert.deepEqual(value.log.filter((entry) => entry.startsWith("dispatcher.transition:")
    || entry.startsWith("inbox.transition:")), [
    "dispatcher.transition:interrupted",
    "inbox.transition:dispatching",
    "inbox.transition:completed",
  ]);
  await value.coordinator.close();
});

test("starting+pending crash-cut 的两步 Inbox 收敛任一步 commit uncertain 都 poison open", async () => {
  for (const failedState of ["dispatching", "completed"]) {
    const runId = failedState === "dispatching"
      ? "00000000-0000-4000-8000-000000000311"
      : "00000000-0000-4000-8000-000000000312";
    const operationId = `pending-terminal-${failedState}`;
    const value = fixture({
      sessionStatus: "ready",
      threadId: `thread-pending-terminal-${failedState}`,
      threads: [{ id: `thread-pending-terminal-${failedState}`, threadSource: null, turns: [] }],
      inboxTransitionFailures: { [failedState]: "PENDING_COMMAND_COMMIT_UNCERTAIN" },
    });
    value.inbox.enqueue({
      operationId,
      runId,
      sessionKey: SESSION_KEY,
      prompt: "must converge through the legal inbox path",
      createdAt: 1_000,
    });
    value.dispatcher.enqueue({
      id: runId,
      source: "chat",
      sourceId: SESSION_KEY,
      idempotencyKey: `shoggoth:chat-send:${operationId}`,
      profileId: PROFILE_ID,
      workspace: "/tmp/shoggoth-workspace",
      retryOf: null,
    });
    value.dispatcher.admit(runId, { writable: true });
    await assert.rejects(
      () => value.coordinator.open(),
      (error) => error.code === "PENDING_COMMAND_COMMIT_UNCERTAIN",
    );
    assert.equal(value.dispatcher.getRun(runId).status, "interrupted");
    assert.equal(
      value.inbox.get(operationId).state,
      failedState === "dispatching" ? "pending" : "dispatching",
    );
    await value.coordinator.close();
  }
});

test("binding 并发收敛到 ready 的 resume 分支仍使用冻结 WorkRun workspace", async () => {
  const setupLog = [];
  const sessions = new FakeChatSessionStore(setupLog, "binding", null, "/mutable/symlink");
  let reads = 0;
  sessions.getSession = (sessionKey) => {
    if (sessionKey !== SESSION_KEY) return null;
    reads += 1;
    if (reads < 3) return clone(sessions.session);
    sessions.binding = {
      operationId: "bind-race-ready",
      sessionKey: SESSION_KEY,
      threadSource: `shoggoth:${SESSION_KEY}:bind-race-ready`,
      state: "bound",
      runtimeSessionId: "thread-race-ready",
      createdAt: 1,
    };
    return clone({ ...sessions.session, status: "ready", runtimeSessionId: "thread-race-ready" });
  };
  sessions.listPendingBindings = () => [];
  const value = await openFixture({
    sessions,
    canonicalWorkspace: "/canonical/race-workspace",
    threads: [{ id: "thread-race-ready", threadSource: null, turns: [] }],
  });
  await sendAndDrain(value, { operationId: "binding-ready-race" });
  assert.equal(value.host.resumeCalls, 1);
  assert.equal(value.host.lastResumeParams.cwd, "/canonical/race-workspace");
  assert.equal(value.host.lastTurnStartParams.cwd, "/canonical/race-workspace");
  await value.coordinator.close();
});

test("同 operationId 同输入幂等，不同 prompt 冲突，远端 start 最多一次", async () => {
  const value = await openFixture();
  const first = await sendAndDrain(value, { operationId: "stable-operation" });
  const second = await value.coordinator.send({
    operationId: "stable-operation", sessionKey: SESSION_KEY, prompt: "hello from inbox only",
  });
  await value.coordinator.waitForIdle(second.run.id);
  assert.equal(second.run.id, first.ack.run.id);
  assert.equal(second.disposition, "started");
  assert.equal(value.inbox.get("stable-operation").state, "dispatching");
  assert.equal(value.host.threadStartCalls, 1);
  assert.equal(value.host.turnStartCalls, 1);
  await assert.rejects(() => value.coordinator.send({
    operationId: "stable-operation", sessionKey: SESSION_KEY, prompt: "different",
  }), (error) => error.code === "PENDING_COMMAND_IDEMPOTENCY_CONFLICT");
  await value.coordinator.close();
});

test("WorkRun 尚存但 Inbox 幂等记录已过窗时拒绝复活旧 operation", async () => {
  const value = fixture();
  value.dispatcher.enqueue({
    id: "00000000-0000-4000-8000-000000000066",
    source: "chat",
    sourceId: SESSION_KEY,
    idempotencyKey: "shoggoth:chat-send:expired-operation",
    profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-workspace",
    retryOf: null,
  });
  await value.coordinator.open();
  await assert.rejects(() => value.coordinator.send({
    operationId: "expired-operation", sessionKey: SESSION_KEY, prompt: "must not revive",
  }), (error) => error.code === "WORK_RUN_IDEMPOTENCY_RECORD_MISSING");
  assert.equal(value.log.includes("dispatcher.admit"), false);
  assert.equal(value.log.includes("runtimePool.get"), false);
  await value.coordinator.close();
});

test("重启发现 starting Chat WorkRun 缺少 Inbox 命令时释放执行槽并收敛 interrupted", async () => {
  const value = fixture();
  const runId = "00000000-0000-4000-8000-000000000067";
  value.dispatcher.enqueue({
    id: runId,
    source: "chat",
    sourceId: SESSION_KEY,
    idempotencyKey: "shoggoth:chat-send:orphan-starting",
    profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-workspace",
    retryOf: null,
  });
  value.dispatcher.admit(runId, { writable: true });
  await value.coordinator.open();
  try {
    const recovered = value.dispatcher.getRun(runId);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.errorCode, "EXECUTION_CONTRACT_LOST");
    assert.equal(value.log.includes("runtimePool.get"), false);
  } finally {
    await value.coordinator.close();
  }
});

test("默认 domain owner 重启发现 starting Cron 缺少 execution contract 时安全收敛", async () => {
  const value = fixture({ recoverOrphanedDomainRuns: true });
  const runId = "00000000-0000-4000-8000-000000000068";
  value.dispatcher.enqueue({
    id: runId,
    source: "cron",
    sourceId: "00000000-0000-4000-8000-000000000168",
    idempotencyKey: "shoggoth:cron:orphan-starting",
    profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-workspace",
    retryOf: null,
  });
  value.dispatcher.admit(runId, { writable: true });
  await value.coordinator.open();
  try {
    const recovered = value.dispatcher.getRun(runId);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.errorCode, "EXECUTION_CONTRACT_LOST");
    assert.equal(value.log.includes("runtimePool.get"), false);
  } finally {
    await value.coordinator.close();
  }
});

test("busy 保持 queued/pending 且不触碰 Runtime", async () => {
  const value = await openFixture({ busy: true });
  const ack = await value.coordinator.send({
    operationId: "busy-operation", sessionKey: SESSION_KEY, prompt: "queued",
  });
  await value.coordinator.waitForIdle(ack.run.id);
  assert.equal(ack.disposition, "queued");
  assert.equal(value.dispatcher.getRun(ack.run.id).status, "queued");
  assert.equal(value.inbox.get("busy-operation").state, "pending");
  assert.equal(value.log.includes("runtimePool.get"), false);
  await value.coordinator.close();
});

test("read-only/maxActive>1 语义下同一 ChatSession 第二条 operation 仍保持 queued", async () => {
  const gate = deferred();
  const value = await openFixture({ runtimeGate: gate, sandbox: "read-only", maxActive: 2 });
  const first = await value.coordinator.send({
    operationId: "session-first", sessionKey: SESSION_KEY, prompt: "first",
  });
  while (!value.log.includes("runtimePool.get")) await new Promise((resolve) => setImmediate(resolve));
  try {
    const second = await value.coordinator.send({
      operationId: "session-second", sessionKey: SESSION_KEY, prompt: "second",
    });
    assert.equal(second.disposition, "queued");
    assert.equal(second.reason, "CHAT_SESSION_BUSY");
    assert.equal(value.dispatcher.getRun(second.run.id).status, "queued");
    assert.equal(value.inbox.get("session-second").state, "pending");
    assert.deepEqual(value.dispatcher.lastAdmission, { onBusy: "queue", writable: false });
  } finally {
    gate.resolve();
    await value.coordinator.waitForIdle(first.run.id).catch(() => {});
    await value.coordinator.close();
  }
});

test("archived/delete_pending session 在首次 durable write 前拒绝 send", async () => {
  for (const status of ["archived", "delete_pending"]) {
    const value = await openFixture({ sessionStatus: status, threadId: `thread-${status}` });
    await assert.rejects(() => value.coordinator.send({
      operationId: `blocked-${status}`,
      sessionKey: SESSION_KEY,
      prompt: "must not dispatch",
    }), (error) => error.code === "CHAT_SESSION_NOT_READY");
    assert.equal(value.log.includes("inbox.enqueue"), false);
    assert.equal(value.log.includes("dispatcher.enqueue"), false);
    assert.equal(value.log.includes("runtimePool.get"), false);
    await value.coordinator.close();
  }
});

test("draft 先分页 thread/list 对账，找到唯一 threadSource 后等 turn 落地再完成 binding", async () => {
  const fillers = Array.from({ length: 3 }, (_, index) => ({
    id: `unrelated-${index}`, threadSource: `other-${index}`, turns: [],
  }));
  const host = new FakeHost([], { pageSize: 2, threads: fillers });
  const value = fixture({ host });
  host.log = value.log;
  await value.coordinator.open();
  const bindingId = `bind-${crypto.createHash("sha256").update("paged").digest("hex").slice(0, 48)}`;
  host.threads.push({
    id: "thread-recovered", threadSource: `shoggoth:${SESSION_KEY}:${bindingId}`, turns: [],
  });
  await sendAndDrain(value, { operationId: "paged" });
  assert.ok(value.log.filter((entry) => entry === "host.threadList").length >= 2);
  assert.equal(host.threadStartCalls, 0);
  assert.equal(value.sessions.session.runtimeSessionId, "thread-recovered");
  assert.ok(value.log.includes("sessions.completeBinding"));
  assert.ok(value.log.indexOf("host.turnStart") < value.log.indexOf("sessions.completeBinding"));
  await value.coordinator.close();
});

test("新 Host 的 thread/list 对账命中后先 resume 加载线程，再 read/turn", async () => {
  const value = fixture({ requireLoaded: true });
  await value.coordinator.open();
  const bindingId = `bind-${crypto.createHash("sha256").update("restart-load").digest("hex").slice(0, 48)}`;
  value.host.threads.push({
    id: "thread-listed-unloaded",
    threadSource: `shoggoth:${SESSION_KEY}:${bindingId}`,
    turns: [],
  });
  await sendAndDrain(value, { operationId: "restart-load" });
  assert.equal(value.host.threadStartCalls, 0);
  assert.equal(value.host.resumeCalls, 1);
  assert.equal(value.host.lastResumeParams.developerInstructions,
    shoggothProductDeveloperInstructions({
      source: "chat", sourceId: SESSION_KEY, profileName: "Shoggoth", runtime: "codex",
    }));
  assert.match(value.host.lastResumeParams.developerInstructions,
    /\{"name":"Shoggoth","runtime":"codex"\}/u);
  assert.ok(value.log.indexOf("host.threadResume") < value.log.indexOf("host.threadRead"));
  assert.equal(value.host.turnStartCalls, 1);
  await value.coordinator.close();
});

test("threadSource 恢复先验证 resume 的 id/source 再持久化 binding", async () => {
  const value = fixture({ sessionStatus: "draft" });
  value.host.threadList = async (params) => {
    value.log.push("host.threadList");
    if (params.archived || !value.sessions.binding) return { data: [], nextCursor: null };
    if (!value.host.threads.some((thread) => thread.id === "thread-source-mismatch")) {
      value.host.threads.push({
        id: "thread-source-mismatch",
        threadSource: "different-source",
        turns: [],
        archived: false,
      });
    }
    return {
      data: [{
        id: "thread-source-mismatch",
        threadSource: value.sessions.binding.threadSource,
      }],
      nextCursor: null,
    };
  };
  value.host.threadResume = async (params) => {
    value.log.push("host.threadResume");
    value.host.loadedThreads.add(params.threadId);
    return {
      thread: { id: params.threadId, threadSource: "different-source", turns: [] },
    };
  };
  await value.coordinator.open();
  const ack = await value.coordinator.send({
    operationId: "binding-source-mismatch",
    sessionKey: SESSION_KEY,
    prompt: "must not bind the wrong source",
  });
  await assert.rejects(
    () => value.coordinator.waitForIdle(ack.run.id),
    (error) => error.code === "CODEX_THREAD_RESUME_SOURCE_MISMATCH",
  );
  assert.equal(value.sessions.getSession(SESSION_KEY).status, "binding");
  assert.equal(value.sessions.getSession(SESSION_KEY).runtimeSessionId, null);
  assert.equal(value.inbox.get("binding-source-mismatch").state, "dispatching");
  await value.coordinator.close();
});

test("threadSource 扫到 archived orphan 时不绑定、不 resume、不二次 start", async () => {
  const value = fixture({ requireLoaded: true });
  await value.coordinator.open();
  const bindingId = `bind-${crypto.createHash("sha256").update("archived-orphan").digest("hex").slice(0, 48)}`;
  value.host.threads.push({
    id: "thread-archived-orphan",
    threadSource: `shoggoth:${SESSION_KEY}:${bindingId}`,
    turns: [],
    archived: true,
  });
  const ack = await value.coordinator.send({
    operationId: "archived-orphan",
    sessionKey: SESSION_KEY,
    prompt: "archived correlation evidence",
  });
  await assert.rejects(
    () => value.coordinator.waitForIdle(ack.run.id),
    (error) => error.code === "CODEX_THREAD_ARCHIVED",
  );
  assert.equal(value.host.threadStartCalls, 0);
  assert.equal(value.host.resumeCalls, 0);
  assert.equal(value.sessions.session.status, "binding");
  assert.equal(value.sessions.session.runtimeSessionId, null);
  assert.equal(value.host.turnStartCalls, 0);
  await value.coordinator.close();
});

test("threadSource 同一 thread id 同时出现在 active/archived 分区时 fail closed", async () => {
  const value = fixture({ sessionStatus: "draft" });
  value.host.threadList = async (params) => {
    value.log.push("host.threadList");
    if (!value.sessions.binding) return { data: [], nextCursor: null };
    return {
      data: [{
        id: "thread-partition-conflict",
        threadSource: value.sessions.binding.threadSource,
      }],
      nextCursor: null,
    };
  };
  value.host.threadResume = async (params) => ({
    thread: {
      id: params.threadId,
      threadSource: value.sessions.binding.threadSource,
      turns: [],
    },
  });
  await value.coordinator.open();
  const ack = await value.coordinator.send({
    operationId: "thread-partition-conflict",
    sessionKey: SESSION_KEY,
    prompt: "must not trust contradictory partitions",
  });
  await assert.rejects(
    () => value.coordinator.waitForIdle(ack.run.id),
    (error) => error.code === "CODEX_THREAD_STATE_CONFLICT",
  );
  assert.equal(value.sessions.getSession(SESSION_KEY).status, "binding");
  assert.equal(value.host.turnStartCalls, 0);
  await value.coordinator.close();
});

test("thread/start 响应丢失后按 threadSource 对账，不重复创建", async () => {
  const value = await openFixture({ loseThreadStartResponse: true });
  await sendAndDrain(value, { operationId: "lost-thread-response" });
  assert.equal(value.host.threadStartCalls, 1);
  assert.equal(value.sessions.session.runtimeSessionId, "thread-created-1");
  assert.equal(value.host.turnStartCalls, 1);
  await value.coordinator.close();
});

test("thread/start 未回显 threadSource 时不信任响应，重试按 list 对账且不二次 start", async () => {
  const value = await openFixture({ omitThreadSourceInStartResponse: true });
  const first = await value.coordinator.send({
    operationId: "missing-thread-source",
    sessionKey: SESSION_KEY,
    prompt: "correlate strictly",
  });
  await assert.rejects(
    () => value.coordinator.waitForIdle(first.run.id),
    (error) => error.code === "CODEX_THREAD_START_INVALID_RESPONSE",
  );
  assert.equal(value.sessions.session.status, "binding");
  assert.equal(value.host.threadStartCalls, 1);
  assert.equal(value.host.turnStartCalls, 0);
  const retried = await value.coordinator.send({
    operationId: "missing-thread-source",
    sessionKey: SESSION_KEY,
    prompt: "correlate strictly",
  });
  await value.coordinator.waitForIdle(retried.run.id);
  assert.equal(value.host.threadStartCalls, 1);
  assert.equal(value.host.turnStartCalls, 1);
  await value.coordinator.close();
});

test("ready session 先 resume，再读 full history，并携 clientUserMessageId 发 turn/start", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-existing",
    modelOverride: "gpt-5.6-terra",
    threads: [{ id: "thread-existing", threadSource: null, turns: [] }],
  });
  await sendAndDrain(value, { operationId: "resume-operation" });
  assert.equal(value.host.resumeCalls, 1);
  assert.ok(value.log.indexOf("host.threadResume") < value.log.indexOf("host.threadRead"));
  assert.equal(value.host.lastResumeParams.model, "gpt-5.6-terra");
  assert.equal(value.host.lastTurnStartParams.model, "gpt-5.6-terra");
  const run = value.coordinator.listRuns({ source: "chat", sourceId: SESSION_KEY })[0];
  assert.deepEqual(value.coordinator.getRuntimeContextForSource(PROFILE_ID, "chat", SESSION_KEY), {
    runId: run.id,
    profileId: PROFILE_ID,
    source: "chat",
    sourceId: SESSION_KEY,
    profileDefaultModel: "gpt-test",
    sessionModelOverride: "gpt-5.6-terra",
    effectiveModel: "gpt-5.6-terra",
  });
  assert.equal(value.host.lastResumeParams.developerInstructions,
    shoggothProductDeveloperInstructions({
      source: "chat",
      sourceId: SESSION_KEY,
      profileName: "Shoggoth",
      runtime: "codex",
    }));
  assert.match(
    value.host.lastResumeParams.developerInstructions,
    /at most two research heredocs/u,
  );
  assert.match(value.host.lastResumeParams.developerInstructions,
    /Never close and recreate the Task Space between searches/u);
  assert.match(value.host.lastResumeParams.developerInstructions,
    /Never put completeTaskSpace in a heredoc with research/u);
  assert.match(value.host.lastResumeParams.developerInstructions,
    /call completeTaskSpace exactly once from a final dedicated cleanup heredoc/u);
  value.sessions.session.modelOverride = "gpt-5.6-luna";
  assert.equal(value.coordinator
    .getRuntimeContextForSource(PROFILE_ID, "chat", SESSION_KEY).effectiveModel, "gpt-5.6-terra",
    "当前 Run 必须继续报告准入时冻结的模型");
  assert.equal(value.coordinator.getRuntimeContextForSource(PROFILE_ID, "chat", "stale-session"), null);
  const turn = value.host.threads[0].turns[0];
  assert.equal(turn.items[0].clientId, "resume-operation");
  await value.coordinator.close();
});

test("ready session 指向未持久化 thread 时按稳定 threadSource 重建，turn 落地后才原子换绑", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-ephemeral",
    threads: [],
    transcriptStore: {
      appendEvent: (input) => clone(input),
      listEvents: () => [{ runId: "prior-run", kind: "user" }],
    },
  });
  value.host.threadResume = async (params) => {
    value.log.push("host.threadResume");
    value.host.resumeCalls += 1;
    const thread = value.host.threads.find((candidate) => candidate.id === params.threadId);
    if (!thread) throw codedError("THREAD_NOT_FOUND");
    return { thread: clone(thread) };
  };

  await sendAndDrain(value, { operationId: "repair-ephemeral-thread" });
  assert.equal(value.host.threadStartCalls, 1);
  assert.equal(value.host.turnStartCalls, 1);
  assert.equal(value.sessions.session.runtimeSessionId, "thread-created-1");
  assert.ok(value.log.indexOf("host.turnStart") < value.log.indexOf("sessions.replaceBoundRuntimeSession"));
  await value.coordinator.close();
});

test("thread/read 省略 schema 默认 itemsView 时按 full 对账", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-default-view",
    threads: [{
      id: "thread-default-view",
      threadSource: null,
      turns: [{ id: "older-turn", status: "completed", items: [] }],
    }],
  });
  await sendAndDrain(value, { operationId: "default-items-view" });
  assert.equal(value.host.turnStartCalls, 1);
  await value.coordinator.close();
});

test("turn/start 响应丢失后从 full history 找 clientId，禁止重发", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-lost-turn",
    threads: [{ id: "thread-lost-turn", threadSource: null, turns: [] }],
    loseTurnStartResponse: true,
  });
  await sendAndDrain(value, { operationId: "lost-turn-response" });
  assert.equal(value.host.turnStartCalls, 1);
  assert.equal(value.dispatcher.listRuns()[0].runtimeTurnRef?.turnId, "turn-1");
  assert.equal(value.inbox.get("lost-turn-response").state, "dispatching");
  await value.coordinator.close();
});

test("非 full history 无法证明缺少 clientId 时 fail closed，不发送 turn", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-partial",
    threads: [{
      id: "thread-partial",
      threadSource: null,
      turns: [{ id: "old-turn", itemsView: "full", items: [] }],
    }],
    partialHistory: true,
  });
  const ack = await value.coordinator.send({
    operationId: "partial-history", sessionKey: SESSION_KEY, prompt: "must not duplicate",
  });
  await assert.rejects(
    () => value.coordinator.waitForIdle(ack.run.id),
    (error) => error.code === "CODEX_THREAD_HISTORY_INCOMPLETE",
  );
  assert.equal(value.host.turnStartCalls, 0);
  assert.equal(value.dispatcher.getRun(ack.run.id).status, "starting");
  assert.equal(value.inbox.get("partial-history").state, "dispatching");
  await value.coordinator.close();
});

test("重启恢复 pending command 缺失 run 的 crash cut，重建并且只执行一次", async () => {
  const log = [];
  const inbox = new FakeInbox(log);
  inbox.enqueue({
    operationId: "crash-after-inbox",
    runId: "00000000-0000-4000-8000-000000000099",
    sessionKey: SESSION_KEY,
    prompt: "survives restart",
    createdAt: 1_000,
  });
  const value = fixture({ inbox });
  value.inbox.log = value.log;
  const runId = inbox.get("crash-after-inbox").runId;
  await value.coordinator.open();
  assert.equal(value.dispatcher.getRun(runId).status, "running");
  await value.coordinator.waitForIdle(runId);
  assert.equal(value.dispatcher.getRun(runId).status, "running");
  assert.equal(inbox.get("crash-after-inbox").state, "dispatching");
  assert.equal(value.host.threadStartCalls, 1);
  assert.equal(value.host.turnStartCalls, 1);
  await value.coordinator.close();
});

test("open recovery 期间的精确 Host 事件不会因 lifecycle=opening 丢失", async () => {
  const value = fixture({
    sessionStatus: "ready",
    threadId: "thread-opening-events",
    threads: [{ id: "thread-opening-events", threadSource: null, turns: [] }],
  });
  const runId = "00000000-0000-4000-8000-000000000209";
  value.inbox.enqueue({
    operationId: "opening-event",
    runId,
    sessionKey: SESSION_KEY,
    prompt: "recover with live event",
    createdAt: 1_000,
  });
  const originalTurnStart = value.host.turnStart.bind(value.host);
  value.host.turnStart = async (params) => {
    const response = await originalTurnStart(params);
    value.host.emit({
      known: true,
      type: "text_delta",
      method: "item/agentMessage/delta",
      threadId: params.threadId,
      turnId: response.turn.id,
      itemId: "opening-live",
      delta: "survived-opening",
    });
    return response;
  };
  await value.coordinator.open();
  await value.coordinator.waitForIdle(runId);
  const replay = value.coordinator.subscribeRun(runId, { streamId: null, afterSeq: 0 }, () => {});
  assert.equal(replay.events.filter((event) => event.type === "text.delta").length, 1);
  replay.unsubscribe();
  await value.coordinator.close();
});

test("公开 thread usage 在 turn context 发布前缓冲并按 Run/Profile 精确落盘", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-usage",
    threads: [{ id: "thread-usage", threadSource: null, turns: [] }],
    now: () => 12_345,
  });
  const originalTurnStart = value.host.turnStart.bind(value.host);
  value.host.turnStart = async (params) => {
    const response = await originalTurnStart(params);
    value.host.emit({
      known: true,
      type: "usage",
      method: "thread/tokenUsage/updated",
      threadId: params.threadId,
      turnId: response.turn.id,
      responseId: `thread-usage-${"a".repeat(64)}`,
      model: "gpt-runtime-actual",
      provider: "pi-provider",
      usage: {
        totalTokens: 90,
        inputTokens: 60,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 30,
        reasoningOutputTokens: 10,
      },
    });
    return response;
  };
  await sendAndDrain(value, { operationId: "usage-buffered" });
  assert.deepEqual(value.usageRecords, [{
    profileId: PROFILE_ID,
    runId: value.coordinator.listRuns()[0].id,
    runtime: "codex",
    runtimeAccountId: RUNTIME_ACCOUNT_ID,
    agentId: "shoggoth-agent",
    agentName: "Shoggoth",
    source: "chat",
    sourceId: SESSION_KEY,
    threadId: "thread-usage",
    turnId: "turn-1",
    responseId: `thread-usage-${"a".repeat(64)}`,
    model: "gpt-runtime-actual",
    provider: "pi-provider",
    usage: {
      totalTokens: 90,
      inputTokens: 60,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
      reasoningOutputTokens: 10,
    },
    createdAt: 12_345,
  }]);
  await value.coordinator.close();

  const failedUsageStore = { record() { throw codedError("TOKEN_USAGE_WRITE_FAILED"); } };
  const degraded = await openFixture({
    usageStore: failedUsageStore,
    sessionStatus: "ready",
    threadId: "thread-usage-failure",
    threads: [{ id: "thread-usage-failure", threadSource: null, turns: [] }],
  });
  const { ack } = await sendAndDrain(degraded, { operationId: "usage-failure-is-observational" });
  const running = degraded.coordinator.getRun(ack.run.id);
  assert.doesNotThrow(() => degraded.host.emit({
    known: true,
    type: "usage",
    method: "thread/tokenUsage/updated",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    responseId: `thread-usage-${"b".repeat(64)}`,
    usage: {
      totalTokens: 1,
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  }));
  assert.equal(degraded.coordinator.getRun(ack.run.id).status, "running");
  await degraded.coordinator.close();
});

test("重启恢复 dispatching/starting 缺少 execution contract 时不读取远端历史", async () => {
  const value = fixture({
    sessionStatus: "ready",
    threadId: "thread-restart",
    threads: [{
      id: "thread-restart",
      threadSource: null,
      turns: [{
        id: "turn-before-crash",
        status: "inProgress",
        itemsView: "full",
        items: [{ type: "userMessage", clientId: "restart-operation" }],
      }],
    }],
  });
  value.inbox.enqueue({
    operationId: "restart-operation",
    runId: "00000000-0000-4000-8000-000000000088",
    sessionKey: SESSION_KEY,
    prompt: "persisted only in inbox",
    createdAt: 1_000,
  });
  value.dispatcher.enqueue({
    id: "00000000-0000-4000-8000-000000000088",
    source: "chat",
    sourceId: SESSION_KEY,
    idempotencyKey: "shoggoth:chat-send:restart-operation",
    profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-workspace",
    retryOf: null,
  });
  value.dispatcher.admit("00000000-0000-4000-8000-000000000088");
  value.inbox.transition("restart-operation", "dispatching");
  value.log.length = 0;
  await value.coordinator.open();
  await value.coordinator.waitForIdle("00000000-0000-4000-8000-000000000088");
  assert.equal(value.log.includes("host.threadRead"), false);
  assert.equal(value.host.turnStartCalls, 0);
  assert.equal(value.dispatcher.getRun("00000000-0000-4000-8000-000000000088").status, "interrupted");
  assert.equal(
    value.dispatcher.getRun("00000000-0000-4000-8000-000000000088").errorCode,
    "EXECUTION_CONTRACT_LOST",
  );
  assert.equal(value.inbox.get("restart-operation").state, "completed");
  await value.coordinator.close();
});

test("重启恢复缺少 execution contract 的旧 starting Run 时 fail closed，绝不读取新 Profile 或 Host", async () => {
  const runId = "00000000-0000-4000-8000-000000000310";
  const value = fixture({
    sessionStatus: "ready",
    threadId: "thread-lost-execution-contract",
    threads: [{ id: "thread-lost-execution-contract", threadSource: null, turns: [] }],
    sandbox: "read-only",
  });
  value.inbox.enqueue({
    operationId: "lost-execution-contract",
    runId,
    sessionKey: SESSION_KEY,
    prompt: "must keep the original read-only contract",
    createdAt: 1_000,
  });
  value.dispatcher.enqueue({
    id: runId,
    source: "chat",
    sourceId: SESSION_KEY,
    idempotencyKey: "shoggoth:chat-send:lost-execution-contract",
    profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-workspace",
    retryOf: null,
  });
  value.dispatcher.admit(runId, { writable: false });
  value.inbox.transition("lost-execution-contract", "dispatching");
  let profileReads = 0;
  value.productStore.getAgentProfile = () => {
    profileReads += 1;
    return {
      id: PROFILE_ID,
      runtimeProfileId: "runtime-profile-updated",
      defaultCwd: "/tmp/shoggoth-workspace",
      permissionPolicy: { sandbox: "danger-full-access", approvalPolicy: "never" },
    };
  };
  value.log.length = 0;

  await value.coordinator.open();

  const run = value.dispatcher.getRun(runId);
  assert.equal(run.status, "interrupted");
  assert.equal(run.errorCode, "EXECUTION_CONTRACT_LOST");
  assert.equal(value.inbox.get("lost-execution-contract").state, "completed");
  assert.equal(profileReads, 0);
  assert.equal(value.log.includes("runtimePool.get"), false);
  assert.equal(value.host.resumeCalls, 0);
  assert.equal(value.host.threadStartCalls, 0);
  assert.equal(value.host.turnStartCalls, 0);
  await value.coordinator.close();
});

test("重启时 running 不由 Coordinator 猜测成功，保留给 Service 标记 interrupted", async () => {
  const value = fixture({
    sessionStatus: "ready",
    threadId: "thread-running-cut",
    threads: [{ id: "thread-running-cut", threadSource: null, turns: [] }],
  });
  value.inbox.enqueue({
    operationId: "running-cut",
    runId: "00000000-0000-4000-8000-000000000077",
    sessionKey: SESSION_KEY,
    prompt: "do not infer terminal success",
    createdAt: 1_000,
  });
  value.dispatcher.enqueue({
    id: "00000000-0000-4000-8000-000000000077",
    source: "chat",
    sourceId: SESSION_KEY,
    idempotencyKey: "shoggoth:chat-send:running-cut",
    profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-workspace",
    retryOf: null,
  });
  value.dispatcher.admit("00000000-0000-4000-8000-000000000077");
  value.dispatcher.transition("00000000-0000-4000-8000-000000000077", "running", {
    runtimeSessionRef: { runtime: "codex", runtimeProfileId: "runtime-default", runtimeAccountId: RUNTIME_ACCOUNT_ID, sessionId: "thread-running-cut" },
    runtimeTurnRef: { runtime: "codex", runtimeProfileId: "runtime-default", runtimeAccountId: RUNTIME_ACCOUNT_ID, sessionId: "thread-running-cut", turnId: "turn-running-cut" },
  });
  value.inbox.transition("running-cut", "dispatching");
  value.log.length = 0;
  await value.coordinator.open();
  assert.equal(value.dispatcher.getRun("00000000-0000-4000-8000-000000000077").status, "running");
  assert.equal(value.inbox.get("running-cut").state, "dispatching");
  assert.equal(value.log.includes("runtimePool.get"), false);
  await value.coordinator.close();
});

test("每 run 串行，重复 kick 与同 operation send 不会并发执行远端调用", async () => {
  const value = await openFixture();
  const first = await value.coordinator.send({
    operationId: "serial-operation", sessionKey: SESSION_KEY, prompt: "serial",
  });
  const second = await value.coordinator.send({
    operationId: "serial-operation", sessionKey: SESSION_KEY, prompt: "serial",
  });
  await Promise.all([
    value.coordinator.waitForIdle(first.run.id),
    value.coordinator.waitForIdle(second.run.id),
  ]);
  assert.equal(value.host.threadStartCalls, 1);
  assert.equal(value.host.turnStartCalls, 1);
  await value.coordinator.close();
});

test("steer 只命中当前 assigned turn，并以 operationId 做同参并发幂等与冲突拒绝", async () => {
  const steerGate = deferred();
  const transcriptEvents = [];
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-steer",
    threads: [{ id: "thread-steer", threadSource: null, turns: [] }],
    steerGate,
    transcriptStore: {
      appendEvent(input) {
        transcriptEvents.push(clone(input));
        return clone(input);
      },
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "steer-source" });
  const running = value.coordinator.getRun(ack.run.id);
  const input = {
    operationId: "steer-operation",
    sessionKey: SESSION_KEY,
    runId: running.id,
    message: "more context",
  };
  const first = value.coordinator.steer(input);
  const duplicate = value.coordinator.steer(clone(input));
  while (value.host.turnSteerCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.host.turnSteerCalls, 1);
  assert.deepEqual(value.host.lastTurnSteerParams, {
    threadId: running.runtimeSessionRef?.sessionId,
    expectedTurnId: running.runtimeTurnRef?.turnId,
    clientUserMessageId: input.operationId,
    input: [{ type: "text", text: input.message, text_elements: [] }],
  });
  assert.throws(
    () => value.coordinator.steer({ ...input, message: "conflicting context" }),
    (error) => error.code === "WORK_RUN_OPERATION_CONFLICT",
  );
  steerGate.resolve();
  assert.deepEqual(await first, {
    accepted: true,
    runId: running.id,
    turnId: running.runtimeTurnRef?.turnId,
  });
  assert.deepEqual(await duplicate, await first);
  assert.equal(value.host.turnSteerCalls, 1);
  const steeringMessages = transcriptEvents.filter((event) => event.content?.transcriptType === "steer");
  assert.equal(steeringMessages.length, 1, "幂等 steer 只能持久化一条用户消息");
  assert.equal(steeringMessages[0].runId, running.id);
  assert.equal(steeringMessages[0].kind, "user");
  assert.equal(steeringMessages[0].content.text, input.message);
  assert.equal(steeringMessages[0].runtimeRef.turnId, running.runtimeTurnRef?.turnId);
  await assert.rejects(
    () => value.coordinator.steer({
      ...input,
      operationId: "steer-wrong-session",
      sessionKey: "22222222-2222-4222-8222-222222222222",
    }),
    (error) => error.code === "CHAT_SESSION_NOT_FOUND",
  );
  await value.coordinator.close();
});

test("steer RPC 在 Host terminate 后即使迟到成功也被 assignment fence 拒绝", async () => {
  const steerGate = deferred();
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-steer-host-dead",
    threads: [{ id: "thread-steer-host-dead", threadSource: null, turns: [] }],
    steerGate,
  });
  const { ack } = await sendAndDrain(value, { operationId: "steer-host-dead-source" });
  const running = value.coordinator.getRun(ack.run.id);
  const steering = value.coordinator.steer({
    operationId: "steer-host-dead-control",
    sessionKey: SESSION_KEY,
    runId: running.id,
    message: "late",
  });
  steering.catch(() => {});
  while (value.host.turnSteerCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  value.host.terminate(codedError("APP_SERVER_EXITED"));
  await new Promise((resolve) => setImmediate(resolve));
  steerGate.resolve();
  await assert.rejects(
    () => steering,
    (error) => error.code === "WORK_RUN_CONTROL_STALE",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await value.coordinator.waitForIdle(running.id)).status, "interrupted");
  await value.coordinator.close();
});

test("abort 精确 interrupt assigned turn，再以 durable canceled→terminal→Inbox tombstone 顺序收敛", async () => {
  const interruptGate = deferred();
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-abort",
    threads: [{ id: "thread-abort", threadSource: null, turns: [] }],
    interruptGate,
  });
  const { ack, operationId } = await sendAndDrain(value, { operationId: "abort-source" });
  const running = value.coordinator.getRun(ack.run.id);
  const terminalEvents = [];
  value.coordinator.subscribeRun(
    running.id,
    { streamId: null, afterSeq: 0 },
    (event) => {
      if (event.type === "terminal") {
        value.log.push("stream.terminal");
        terminalEvents.push(event);
      }
    },
  );
  value.log.length = 0;
  const input = {
    operationId: "abort-operation",
    sessionKey: SESSION_KEY,
    runId: running.id,
  };
  const first = value.coordinator.abort(input);
  const duplicate = value.coordinator.abort(clone(input));
  while (value.host.turnInterruptCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.host.turnInterruptCalls, 1);
  assert.deepEqual(value.host.lastTurnInterruptParams, {
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
  });
  assert.equal(value.dispatcher.getRun(running.id).status, "running");
  interruptGate.resolve();
  const result = await first;
  assert.deepEqual(await duplicate, result);
  assert.equal(result.status, "canceled");
  assert.equal(value.inbox.get(operationId).state, "canceled");
  assert.equal(terminalEvents.length, 1);
  assert.deepEqual(value.log.filter((entry) => [
    "host.turnInterrupt",
    "dispatcher.transition:canceled",
    "stream.terminal",
    "inbox.transition:canceled",
  ].includes(entry)), [
    "host.turnInterrupt",
    "dispatcher.transition:canceled",
    "stream.terminal",
    "inbox.transition:canceled",
  ]);
  assert.throws(
    () => value.coordinator.abort({ ...input, runId: null }),
    (error) => error.code === "WORK_RUN_OPERATION_CONFLICT",
  );
  await assert.rejects(
    () => value.coordinator.abort({
      operationId: "abort-terminal",
      sessionKey: SESSION_KEY,
      runId: running.id,
    }),
    (error) => error.code === "WORK_RUN_NOT_CONTROLLABLE",
  );
  await value.coordinator.close();
});

test("assigned Host 只注册稳定审批与 MCP elicitation，experimental tool/requestUserInput 保持 fail-closed", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-server-handlers",
    threads: [{ id: "thread-server-handlers", threadSource: null, turns: [] }],
  });
  await sendAndDrain(value, { operationId: "server-handler-source" });
  assert.deepEqual([...value.host.serverRequestHandlers.keys()].sort(), [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "mcpServer/elicitation/request",
  ]);
  await assert.rejects(
    () => value.host.request("item/tool/requestUserInput", {
      threadId: "thread-server-handlers",
      turnId: "turn-1",
      itemId: "experimental",
      isBlocking: true,
      questions: [],
    }),
    (error) => error.code === "CODEX_SERVER_HANDLER_NOT_FOUND",
  );
  await value.coordinator.close();
  assert.equal(value.host.serverRequestHandlers.size, 0);
});

test("真实 MCP helper request_user_input 经 elicitation 桥接 assigned turn，experimental API 关闭仍可恢复", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-mcp-helper-e2e",
    threads: [{ id: "thread-mcp-helper-e2e", threadSource: null, turns: [] }],
  });
  const { ack } = await sendAndDrain(value, { operationId: "mcp-helper-e2e-source" });
  const run = value.coordinator.getRun(ack.run.id);
  assert.equal(value.host.serverRequestHandlers.has("item/tool/requestUserInput"), false);

  const rogueProfileHost = new FakeHost([], {
    threads: [{ id: run.runtimeSessionRef?.sessionId, threadSource: null, turns: [] }],
  });
  await assert.rejects(
    () => rogueProfileHost.request("mcpServer/elicitation/request", {
      serverName: "shoggoth", threadId: run.runtimeSessionRef?.sessionId, turnId: run.runtimeTurnRef?.turnId,
      mode: "form", message: "cross profile", requestedSchema: { type: "object", properties: {} },
    }),
    (error) => error.code === "CODEX_SERVER_HANDLER_NOT_FOUND",
  );
  for (const wrongBinding of [
    { threadId: "thread-other", turnId: run.runtimeTurnRef?.turnId },
    { threadId: run.runtimeSessionRef?.sessionId, turnId: "turn-other" },
  ]) {
    assert.throws(
      () => value.host.request("mcpServer/elicitation/request", {
        serverName: "shoggoth", ...wrongBinding, mode: "form", message: "wrong binding",
        requestedSchema: { type: "object", properties: {} },
      }),
      (error) => error.code === "WORK_RUN_REQUEST_UNROUTABLE",
    );
  }

  const input = new PassThrough();
  const output = new PassThrough();
  let buffered = "";
  const lines = [];
  const waiters = [];
  output.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const parsed = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      if (waiters.length > 0) waiters.shift()(parsed);
      else lines.push(parsed);
    }
  });
  const nextLine = () => lines.length > 0
    ? Promise.resolve(lines.shift())
    : new Promise((resolve) => waiters.push(resolve));
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-default",
    runtimeAccountId: RUNTIME_ACCOUNT_ID,
    sessionToken: Buffer.alloc(32, 0x72).toString("base64url"),
    requestService: async () => { throw codedError("UNEXPECTED_PROFILE_REQUEST"); },
  });
  const session = runMcpStdioSession({
    input, output, handler, clientRequestTimeoutMs: 500,
  });
  input.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} },
      clientInfo: { name: "fake-codex", version: "0.149.0" },
    },
  })}\n`);
  assert.equal((await nextLine()).result.protocolVersion, "2025-06-18");
  input.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "request_user_input",
      arguments: {
        questions: [{
          header: "Choice", id: "choice", question: "Choose one",
          options: [
            { label: "Alpha", description: "First" },
            { label: "Beta", description: "Second" },
          ],
        }],
      },
    },
  })}\n`);
  const outbound = await nextLine();
  assert.equal(outbound.method, "elicitation/create");
  assert.equal(Object.prototype.hasOwnProperty.call(outbound.params, "runId"), false);
  const bridgeResponse = value.host.request("mcpServer/elicitation/request", {
    serverName: "shoggoth",
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    mode: "form",
    ...outbound.params,
  }, outbound.id);
  bridgeResponse.catch(() => {});
  while (value.coordinator.getRun(run.id).status !== "waiting_input") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const waiting = value.coordinator.getRun(run.id);
  await value.coordinator.respondInput({
    operationId: "mcp-helper-e2e-answer",
    runId: run.id,
    requestId: waiting.waitingRequestId,
    action: "submit",
    answers: { choice: "Beta" },
  });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: outbound.id, result: await bridgeResponse })}\n`);
  const toolResponse = await nextLine();
  assert.equal(toolResponse.id, 2);
  assert.equal(toolResponse.result.isError, false);
  assert.deepEqual(toolResponse.result.structuredContent, {
    answers: { choice: { answers: ["Beta"] } },
  });
  input.end();
  await session;
  handler.close();
  await value.coordinator.close();
});

test("真实 fake Codex JSONL 经 Host schema 进入 Coordinator assigned turn 并回传 helper", async () => {
  const transport = createRealTransportHost();
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  const waiters = [];
  let buffered = "";
  let value = null;
  let session = null;
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-default",
    runtimeAccountId: RUNTIME_ACCOUNT_ID,
    sessionToken: Buffer.alloc(32, 0x73).toString("base64url"),
    requestService: async () => { throw codedError("UNEXPECTED_PROFILE_REQUEST"); },
  });
  output.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      if (waiters.length > 0) waiters.shift()(message);
      else lines.push(message);
    }
  });
  const nextLine = () => lines.length > 0
    ? Promise.resolve(lines.shift())
    : new Promise((resolve) => waiters.push(resolve));
  try {
    session = runMcpStdioSession({ input, output, handler, clientRequestTimeoutMs: 1_000 });
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
        clientInfo: { name: "fake-codex-transport", version: "0.149.0" },
      },
    })}\n`);
    assert.equal((await nextLine()).result.protocolVersion, "2025-06-18");
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "request_user_input",
        arguments: {
          questions: [{
            header: "Choice", id: "choice", question: "Choose one",
            options: [
              { label: "Alpha", description: "First" },
              { label: "Beta", description: "Second" },
            ],
          }],
        },
      },
    })}\n`);
    const outbound = await nextLine();
    assert.equal(outbound.method, "elicitation/create");

    await transport.host.initialize();
    value = await openFixture({
      host: transport.host,
      sessionStatus: "ready",
      threadId: "thread-runtime-default",
    });
    const ack = await value.coordinator.send({
      operationId: "real-host-mcp-source",
      sessionKey: SESSION_KEY,
      prompt: "trigger real fake Codex transport",
    });
    await waitUntil(
      () => value.coordinator.getRun(ack.run.id).status === "waiting_input",
      1_000,
      "real fake Codex elicitation",
    );
    const waiting = value.coordinator.getRun(ack.run.id);
    const replay = value.coordinator.subscribeRun(
      ack.run.id, { streamId: null, afterSeq: 0 }, () => {},
    );
    const prompt = replay.events.find((event) => event.type === "prompt");
    replay.unsubscribe();
    assert.deepEqual(prompt.payload.requestedSchema, outbound.params.requestedSchema);
    assert.equal(prompt.payload.message, outbound.params.message);
    assert.equal(transport.host.serverRequestHandlers.has("item/tool/requestUserInput"), false);

    await value.coordinator.respondInput({
      operationId: "real-host-mcp-answer",
      runId: ack.run.id,
      requestId: waiting.waitingRequestId,
      action: "submit",
      answers: { choice: "Beta" },
    });
    const bridgeResponse = await readJsonLineFileEventually(
      transport.responsePath, 1_000, "fake Codex server response",
    );
    assert.deepEqual(bridgeResponse.result, {
      action: "accept",
      content: { choice: "Beta" },
    });
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: outbound.id, result: bridgeResponse.result,
    })}\n`);
    const toolResponse = await nextLine();
    assert.equal(toolResponse.id, 2);
    assert.equal(toolResponse.result.isError, false);
    assert.deepEqual(toolResponse.result.structuredContent, {
      answers: { choice: { answers: ["Beta"] } },
    });
  } finally {
    input.end();
    if (session) await session.catch(() => {});
    handler.close();
    if (value) await value.coordinator.close().catch(() => {});
    await transport.close();
  }
});

test("真实 fake Codex transport 拒绝 wrong thread/turn 且不改变 Run", async () => {
  for (const mode of ["wrong-thread", "wrong-turn"]) {
    const transport = createRealTransportHost({ mode });
    let value = null;
    try {
      await transport.host.initialize();
      value = await openFixture({
        host: transport.host,
        sessionStatus: "ready",
        threadId: "thread-runtime-default",
      });
      const ack = await value.coordinator.send({
        operationId: `real-host-${mode}`,
        sessionKey: SESSION_KEY,
        prompt: `trigger ${mode}`,
      });
      const response = await readJsonLineFileEventually(
        transport.responsePath, 1_000, `${mode} response`,
      );
      assert.deepEqual(response.error, {
        code: -32603,
        message: "Server request handler failed",
      });
      assert.equal(value.coordinator.getRun(ack.run.id).status, "running");
    } finally {
      if (value) await value.coordinator.close().catch(() => {});
      await transport.close();
    }
  }
});

test("两个真实 Profile Host 通过 JSONL 拒绝 cross-profile thread/turn", async () => {
  const firstTransport = createRealTransportHost();
  let first = null;
  let secondTransport = null;
  let second = null;
  try {
    await firstTransport.host.initialize();
    first = await openFixture({
      host: firstTransport.host,
      sessionStatus: "ready",
      threadId: "thread-runtime-default",
    });
    const firstAck = await first.coordinator.send({
      operationId: "real-host-cross-source",
      sessionKey: SESSION_KEY,
      prompt: "establish first profile assignment",
    });
    await waitUntil(
      () => first.coordinator.getRun(firstAck.run.id).status === "waiting_input",
      1_000,
      "first profile waiting input",
    );
    const firstRun = first.coordinator.getRun(firstAck.run.id);
    await first.coordinator.respondInput({
      operationId: "real-host-cross-cancel",
      runId: firstRun.id,
      requestId: firstRun.waitingRequestId,
      action: "cancel",
      answers: {},
    });

    secondTransport = createRealTransportHost({
      runtimeProfileId: "runtime-other",
      mode: "cross-profile",
      spawnEnv: {
        CODEX_FAKE_ELICITATION_THREAD_ID: firstRun.runtimeSessionRef?.sessionId,
        CODEX_FAKE_ELICITATION_TURN_ID: firstRun.runtimeTurnRef?.turnId,
      },
    });
    await secondTransport.host.initialize();
    second = await openFixture({
      host: secondTransport.host,
      runtimeProfileId: "runtime-other",
      sessionStatus: "ready",
      threadId: "thread-runtime-other",
    });
    const secondAck = await second.coordinator.send({
      operationId: "real-host-cross-attempt",
      sessionKey: SESSION_KEY,
      prompt: "attempt cross profile binding",
    });
    const response = await readJsonLineFileEventually(
      secondTransport.responsePath, 1_000, "cross profile response",
    );
    assert.equal(response.error.code, -32603);
    assert.equal(response.error.message, "Server request handler failed");
    assert.equal(second.coordinator.getRun(secondAck.run.id).status, "running");
  } finally {
    if (second) await second.coordinator.close().catch(() => {});
    if (secondTransport) await secondTransport.close();
    if (first) await first.coordinator.close().catch(() => {});
    await firstTransport.close();
  }
});

test("真实 fake Codex unknown response 使 Host fail-closed 并收敛 assigned Run", async () => {
  const transport = createRealTransportHost({ mode: "unknown-response" });
  let value = null;
  try {
    await transport.host.initialize();
    value = await openFixture({
      host: transport.host,
      sessionStatus: "ready",
      threadId: "thread-runtime-default",
    });
    const ack = await value.coordinator.send({
      operationId: "real-host-unknown-response",
      sessionKey: SESSION_KEY,
      prompt: "trigger unknown response",
    });
    const termination = await Promise.race([
      transport.host.terminated.then(
        () => ({ resolved: true }),
        (error) => ({ error }),
      ),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 1_000)),
    ]);
    assert.equal(termination.error?.code, "RPC_UNKNOWN_RESPONSE_ID");
    await waitUntil(
      () => value.coordinator.getRun(ack.run.id).status === "interrupted",
      1_000,
      "unknown response run convergence",
    );
  } finally {
    if (value) await value.coordinator.close().catch(() => {});
    await transport.close();
  }
});

test("真实 Host MCP transport 不抢跑，普通输入由 Coordinator 有界超时", async () => {
  const transport = createRealTransportHost({ serverRequestTimeoutMs: 30 });
  let value = null;
  try {
    await transport.host.initialize();
    value = await openFixture({
      host: transport.host,
      sessionStatus: "ready",
      threadId: "thread-runtime-default",
      promptTimeoutMs: 80,
    });
    const ack = await value.coordinator.send({
      operationId: "real-host-server-timeout",
      sessionKey: SESSION_KEY,
      prompt: "leave elicitation unanswered",
    });
    await waitUntil(
      () => value.coordinator.getRun(ack.run.id).status === "waiting_input",
      1_000,
      "coordinator timeout waiting input",
    );
    const response = await readJsonLineFileEventually(
      transport.responsePath, 1_000, "coordinator timeout response",
    );
    assert.deepEqual(response.result, { action: "cancel" });
    const terminal = await value.coordinator.waitForIdle(ack.run.id);
    assert.equal(terminal.status, "interrupted");
    assert.equal(terminal.errorCode, "CODEX_PROMPT_TIMEOUT");
    const startedAt = Date.now();
    await value.coordinator.close();
    value = null;
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(transport.host.serverRequestHandlers.size, 0);
  } finally {
    if (value) await value.coordinator.close().catch(() => {});
    await transport.close();
  }
});

test("command approval 生成独立公开 requestId，durable waiting 后 exactly-once 响应并恢复 running", async () => {
  const interactionEvents = [];
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-approval",
    threads: [{ id: "thread-approval", threadSource: null, turns: [] }],
    onRunInteraction(runSnapshot, interaction) {
      interactionEvents.push({
        runId: runSnapshot.id,
        status: runSnapshot.status,
        waitingRequestId: runSnapshot.waitingRequestId,
        interaction,
      });
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "approval-source" });
  const running = value.coordinator.getRun(ack.run.id);
  const events = [];
  value.coordinator.subscribeRun(
    running.id,
    { streamId: null, afterSeq: 0 },
    (event) => events.push(event),
  );
  const rawRpcId = "raw-rpc-id-that-must-not-be-public";
  const serverResponse = value.host.request("item/commandExecution/requestApproval", {
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    itemId: "item-approval",
    startedAtMs: 1_000,
    environmentId: null,
    command: "printf ok",
    commandActions: null,
    cwd: "/tmp/shoggoth-workspace",
    reason: "run command",
    approvalId: null,
    networkApprovalContext: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
  }, rawRpcId);
  serverResponse.catch(() => {});
  while (value.coordinator.getRun(running.id).status !== "waiting_approval") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const waiting = value.coordinator.getRun(running.id);
  assert.notEqual(waiting.waitingRequestId, rawRpcId);
  assert.equal(waiting.waitingRequestId.length > 0, true);
  const approval = events.find((event) => event.type === "approval");
  assert.equal(approval.payload.requestId, waiting.waitingRequestId);
  assert.equal(approval.payload.method, "item/commandExecution/requestApproval");
  assert.equal(approval.payload.kind, "command");
  assert.equal(approval.payload.command, "printf ok");
  assert.equal(approval.payload.sessionApprovalAvailable, false);
  assert.equal(JSON.stringify(approval).includes(rawRpcId), false);
  assert.deepEqual(interactionEvents, [{
    runId: running.id,
    status: "waiting_approval",
    waitingRequestId: waiting.waitingRequestId,
    interaction: {
      phase: "requested",
      eventType: "approval",
      requestId: waiting.waitingRequestId,
      payload: approval.payload,
    },
  }]);

  const responseInput = {
    operationId: "approval-response",
    runId: running.id,
    requestId: waiting.waitingRequestId,
    choice: "once",
  };
  const first = value.coordinator.respondApproval(responseInput);
  const duplicate = value.coordinator.respondApproval(clone(responseInput));
  assert.deepEqual(await serverResponse, { decision: "accept" });
  const response = await first;
  assert.deepEqual(await duplicate, response);
  assert.equal(response.requestId, waiting.waitingRequestId);
  assert.equal(response.state, "responded");
  assert.equal(response.run.status, "running");
  assert.equal(value.coordinator.getRun(running.id).waitingRequestId, null);
  assert.deepEqual(
    events.find((event) => event.type === "performance.stage"
      && event.payload.stage === "approval_wait")?.payload,
    { stage: "approval_wait", durationMs: 0, outcome: "accepted" },
  );
  assert.equal(events.filter((event) => event.type === "approval").length, 1);
  assert.equal(events.filter((event) => event.type === "status"
    && event.payload.status === "running"
    && event.payload.requestId === waiting.waitingRequestId).length, 1);
  assert.deepEqual(interactionEvents, [
    interactionEvents[0],
    {
      runId: running.id,
      status: "running",
      waitingRequestId: null,
      interaction: {
        phase: "resolved",
        eventType: "approval",
        requestId: waiting.waitingRequestId,
        payload: null,
      },
    },
  ]);
  assert.throws(
    () => value.coordinator.respondApproval({ ...responseInput, choice: "deny" }),
    (error) => error.code === "WORK_RUN_OPERATION_CONFLICT",
  );
  await value.coordinator.close();
});

test("显式不支持会话授权时，目录和命令规则不能恢复会话选项或接受会话响应", async () => {
  const value = await openFixture({
    sessionStatus: "ready", threadId: "thread-once-only",
    threads: [{ id: "thread-once-only", threadSource: null, turns: [] }],
  });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "once-only-source" });
    const run = value.coordinator.getRun(ack.run.id);
    const events = [];
    value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, (event) => events.push(event));
    for (const [index, method, params] of [
      [0, "item/fileChange/requestApproval", { grantRoot: "/tmp/workspace" }],
      [1, "item/commandExecution/requestApproval", {
        command: "ego-browser nodejs test.js", proposedExecpolicyAmendment: ["ego-browser", "nodejs"],
      }],
    ]) {
      const response = value.host.request(method, {
        threadId: run.runtimeSessionRef?.sessionId, turnId: run.runtimeTurnRef?.turnId, itemId: `once-${index}`,
        reason: "one-time permission", sessionApprovalAvailable: false, ...params,
        toolName: "shoggoth__kanban_card_create",
        toolInput: { boardId: "board-1", title: "New card", password: "private-not-for-display" },
      });
      response.catch(() => {});
      await waitUntil(() => value.coordinator.getRun(run.id).status === "waiting_approval", 1_000, "once-only approval");
      const requestId = value.coordinator.getRun(run.id).waitingRequestId;
      const approval = events.filter((event) => event.type === "approval").at(-1);
      assert.equal(approval.payload.sessionApprovalAvailable, false);
      assert.equal(approval.payload.toolName, "shoggoth__kanban_card_create");
      assert.deepEqual(approval.payload.toolInput, { boardId: "board-1", title: "New card" });
      await assert.rejects(value.coordinator.respondApproval({
        operationId: `unsupported-session-${index}`, runId: run.id, requestId, choice: "session",
      }), (error) => error.code === "WORK_RUN_APPROVAL_RESPONSE_INVALID");
      assert.equal(value.coordinator.getRun(run.id).waitingRequestId, requestId);
      await value.coordinator.respondApproval({
        operationId: `supported-once-${index}`, runId: run.id, requestId, choice: "once",
      });
      assert.deepEqual(await response, { decision: "accept" });
    }
  } finally { await value.coordinator.close(); }
});

test("Grok 原生授权保留各个范围并拒绝未提供的选择", async () => {
  const value = await openFixture({ sessionStatus: "ready", threadId: "thread-native-options",
    threads: [{ id: "thread-native-options", threadSource: null, turns: [] }] });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "native-options-source" });
    const run = value.coordinator.getRun(ack.run.id);
    const options = [
      { choice: "once", label: "Allow once", kind: "allow_once" },
      { choice: "runtime:1", label: "Always allow this tool", kind: "allow_always", scope: "tool" },
      { choice: "runtime:2", label: "Always allow this server", kind: "allow_always", scope: "server" },
      { choice: "deny", label: "Reject", kind: "reject_once" },
    ];
    const events = [];
    value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, (event) => events.push(event));
    const response = value.host.request("item/commandExecution/requestApproval", {
      threadId: run.runtimeSessionRef?.sessionId, turnId: run.runtimeTurnRef?.turnId, itemId: "tool-native-options",
      command: "shoggoth__kanban_card_create", sessionApprovalAvailable: false, approvalOptions: options,
    });
    response.catch(() => {});
    await waitUntil(() => value.coordinator.getRun(run.id).status === "waiting_approval", 1_000, "native approval");
    const requestId = value.coordinator.getRun(run.id).waitingRequestId;
    assert.deepEqual(events.find((event) => event.type === "approval").payload.approvalOptions, options);
    for (const choice of ["session", "runtime:31"]) {
      await assert.rejects(value.coordinator.respondApproval({ operationId: `invalid-${choice}`,
        runId: run.id, requestId, choice }), (error) => error.code === "WORK_RUN_APPROVAL_RESPONSE_INVALID");
      assert.equal(value.coordinator.getRun(run.id).waitingRequestId, requestId);
    }
    await value.coordinator.respondApproval({ operationId: "native-server-approval", runId: run.id, requestId, choice: "runtime:2" });
    assert.deepEqual(await response, { decision: "accept", approvalChoice: "runtime:2" });
  } finally { await value.coordinator.close(); }
});

test("ego-browser nodejs 的本会话授权可跨动态 heredoc 复用且不重复弹窗", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-ego-browser-approval",
    threads: [{ id: "thread-ego-browser-approval", threadSource: null, turns: [] }],
  });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "ego-browser-approval-source" });
    const running = value.coordinator.getRun(ack.run.id);
    const events = [];
    value.coordinator.subscribeRun(
      running.id,
      { streamId: null, afterSeq: 0 },
      (event) => events.push(event),
    );
    const approvalParams = (itemId, command) => ({
      threadId: running.runtimeSessionRef?.sessionId,
      turnId: running.runtimeTurnRef?.turnId,
      itemId,
      environmentId: null,
      command: `/bin/zsh -lc ${JSON.stringify(command)}`,
      commandActions: [{ command, type: "unknown" }],
      cwd: "/tmp/shoggoth-workspace",
      reason: "use ego-browser",
      approvalId: null,
      networkApprovalContext: null,
      proposedExecpolicyAmendment: ["ego-browser", "nodejs"],
      proposedNetworkPolicyAmendments: null,
      sessionApprovalAvailable: true,
    });
    const firstCommand = "export PATH=\"$HOME/.local/bin:/usr/local/bin:$PATH\"\nego-browser nodejs <<'EOF'\ncliLog('one')\nEOF";
    const firstResponse = value.host.request(
      "item/commandExecution/requestApproval",
      approvalParams("ego-browser-one", firstCommand),
      "raw-ego-browser-one",
    );
    firstResponse.catch(() => {});
    await waitUntil(
      () => value.coordinator.getRun(running.id).status === "waiting_approval",
      1_000,
      "ego-browser approval",
    );
    const requestId = value.coordinator.getRun(running.id).waitingRequestId;
    const approval = events.find((event) => event.type === "approval");
    assert.equal(approval.payload.sessionApprovalAvailable, true);
    await value.coordinator.respondApproval({
      operationId: "ego-browser-approval-session",
      runId: running.id,
      requestId,
      choice: "session",
    });
    assert.deepEqual(await firstResponse, { decision: "acceptForSession" });
    const approvalsBefore = events.filter((event) => event.type === "approval").length;
    const secondCommand = "export PATH=\"$HOME/.local/bin:$PATH\"\nego-browser nodejs <<'EOF'\ncliLog('two')\nEOF";
    assert.deepEqual(await value.host.request(
      "item/commandExecution/requestApproval",
      approvalParams("ego-browser-two", secondCommand),
      "raw-ego-browser-two",
    ), { decision: "accept" });
    assert.equal(value.coordinator.getRun(running.id).status, "running");
    assert.equal(events.filter((event) => event.type === "approval").length, approvalsBefore);
  } finally {
    await value.coordinator.close();
  }
});

test("Runtime shell 不能经批准绕过 Shoggoth System Host 产品工具", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-reserved-host-command",
    threads: [{ id: "thread-reserved-host-command", threadSource: null, turns: [] }],
  });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "reserved-host-command-source" });
    const running = value.coordinator.getRun(ack.run.id);
    const events = [];
    value.coordinator.subscribeRun(
      running.id,
      { streamId: null, afterSeq: 0 },
      (event) => events.push(event),
    );
    const commands = [
      "/bin/zsh -lc \"open -a '夸克'\"",
      "/usr/bin/open -a Quark",
      "'/Applications/Quark.app/Contents/MacOS/Quark'",
      "osascript -e 'tell application \"Quark\" to activate'",
    ];
    for (const [index, command] of commands.entries()) {
      const response = await value.host.request("item/commandExecution/requestApproval", {
        threadId: running.runtimeSessionRef?.sessionId,
        turnId: running.runtimeTurnRef?.turnId,
        itemId: `item-reserved-${index}`,
        startedAtMs: 2_000 + index,
        environmentId: null,
        command,
        commandActions: null,
        cwd: "/tmp/shoggoth-workspace",
        reason: "launch app",
        approvalId: null,
        networkApprovalContext: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      }, `raw-reserved-${index}`);
      assert.deepEqual(response, { decision: "decline" });
      assert.equal(value.coordinator.getRun(running.id).status, "running");
      assert.equal(value.coordinator.getRun(running.id).waitingRequestId, null);
    }
    assert.equal(events.some((event) => event.type === "approval"), false);

    const ordinaryResponse = value.host.request("item/commandExecution/requestApproval", {
      threadId: running.runtimeSessionRef?.sessionId,
      turnId: running.runtimeTurnRef?.turnId,
      itemId: "item-ordinary-command",
      startedAtMs: 3_000,
      environmentId: null,
      command: "printf '%s' \"open -a Quark\"",
      commandActions: null,
      cwd: "/tmp/shoggoth-workspace",
      reason: "print text",
      approvalId: null,
      networkApprovalContext: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
    }, "raw-ordinary-command");
    ordinaryResponse.catch(() => {});
    await waitUntil(
      () => value.coordinator.getRun(running.id).status === "waiting_approval",
      1_000,
      "ordinary command approval",
    );
    const requestId = value.coordinator.getRun(running.id).waitingRequestId;
    await value.coordinator.respondApproval({
      operationId: "ordinary-command-deny",
      runId: running.id,
      requestId,
      choice: "deny",
    });
    assert.deepEqual(await ordinaryResponse, { decision: "decline" });
    assert.equal(events.filter((event) => event.type === "approval").length, 1);
  } finally {
    await value.coordinator.close();
  }
});

test("command/file/permissions approval choices 严格映射，permissions 回显请求权限与 scope", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-approval-choices",
    threads: [{ id: "thread-approval-choices", threadSource: null, turns: [] }],
  });
  const { ack } = await sendAndDrain(value, { operationId: "approval-choices-source" });
  const run = value.coordinator.getRun(ack.run.id);
  let responseIndex = 0;
  async function approve(method, params, choice, expected) {
    responseIndex += 1;
    const serverResponse = value.host.request(method, {
      threadId: run.runtimeSessionRef?.sessionId,
      turnId: run.runtimeTurnRef?.turnId,
      itemId: `item-${responseIndex}`,
      startedAtMs: 1_000 + responseIndex,
      ...params,
    }, `raw-${responseIndex}`);
    serverResponse.catch(() => {});
    while (value.coordinator.getRun(run.id).status !== "waiting_approval") {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const requestId = value.coordinator.getRun(run.id).waitingRequestId;
    await value.coordinator.respondApproval({
      operationId: `respond-${responseIndex}`,
      runId: run.id,
      requestId,
      choice,
    });
    assert.deepEqual(await serverResponse, expected);
  }
  await approve("item/commandExecution/requestApproval", {
    environmentId: null, command: "echo one", commandActions: null, cwd: null,
    reason: null, approvalId: null, networkApprovalContext: null,
    proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null,
    sessionApprovalAvailable: true,
  }, "session", { decision: "acceptForSession" });
  await approve("item/fileChange/requestApproval", {
    grantRoot: null, reason: "write",
  }, "deny", { decision: "decline" });
  const requestedPermissions = {
    fileSystem: { read: ["/tmp/project"], write: ["/tmp/project"] },
    network: { enabled: true },
  };
  await approve("item/permissions/requestApproval", {
    cwd: "/tmp/project", environmentId: null, reason: "need access",
    permissions: requestedPermissions,
  }, "once", { permissions: requestedPermissions, scope: "turn" });
  await approve("item/permissions/requestApproval", {
    cwd: "/tmp/project", environmentId: null, reason: null,
    permissions: requestedPermissions,
  }, "session", { permissions: requestedPermissions, scope: "session" });
  await approve("item/permissions/requestApproval", {
    cwd: "/tmp/project", environmentId: null, reason: null,
    permissions: requestedPermissions,
  }, "deny", { permissions: {}, scope: "turn" });
  const interruptsBeforeCancel = value.host.turnInterruptCalls;
  await approve("item/commandExecution/requestApproval", {
    environmentId: null, command: "echo cancel", commandActions: null, cwd: null,
    reason: null, approvalId: null, networkApprovalContext: null,
    proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null,
  }, "cancel", { decision: "cancel" });
  assert.equal(value.host.turnInterruptCalls, interruptsBeforeCancel + 1);
  await value.coordinator.close();
});

test("approval request 必须匹配 assigned host/thread/turn，事件遇到 secret/超限时退化为有界 redacted 快照", async () => {
  const secret = "registered-provider-secret-value";
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-approval-safe",
    threads: [{ id: "thread-approval-safe", threadSource: null, turns: [] }],
    assertSecretSafe: (payload) => !JSON.stringify(payload).includes(secret),
  });
  const { ack } = await sendAndDrain(value, { operationId: "approval-safe-source" });
  const run = value.coordinator.getRun(ack.run.id);
  assert.throws(
    () => value.host.request("item/fileChange/requestApproval", {
      threadId: run.runtimeSessionRef?.sessionId,
      turnId: "wrong-turn",
      itemId: "wrong",
      startedAtMs: 1,
      grantRoot: null,
      reason: null,
    }),
    (error) => error.code === "WORK_RUN_REQUEST_UNROUTABLE",
  );
  const events = [];
  value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, (event) => events.push(event));
  const pending = value.host.request("item/commandExecution/requestApproval", {
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    itemId: "safe-item",
    startedAtMs: 1,
    environmentId: null,
    command: `${secret}${"x".repeat(60 * 1024)}`,
    commandActions: null,
    cwd: null,
    reason: secret,
    approvalId: null,
    networkApprovalContext: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
  }, 9_999_999);
  pending.catch(() => {});
  while (value.coordinator.getRun(run.id).status !== "waiting_approval") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const waiting = value.coordinator.getRun(run.id);
  const event = events.find((candidate) => candidate.type === "approval");
  assert.equal(event.payload.redacted, true);
  assert.equal(JSON.stringify(event).includes(secret), false);
  assert.equal(Buffer.byteLength(JSON.stringify(event), "utf8") < 48 * 1024, true);
  await assert.rejects(
    () => value.coordinator.respondApproval({
      operationId: "wrong-request-response",
      runId: run.id,
      requestId: "another-request",
      choice: "once",
    }),
    (error) => error.code === "WORK_RUN_REQUEST_MISMATCH",
  );
  await value.coordinator.respondApproval({
    operationId: "safe-request-response",
    runId: run.id,
    requestId: waiting.waitingRequestId,
    choice: "deny",
  });
  assert.deepEqual(await pending, { decision: "decline" });
  await value.coordinator.close();
});

test("near-limit approval reserves federation envelope headroom in authoritative snapshots", async () => {
  const interactions = [];
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-approval-envelope-headroom",
    threads: [{ id: "thread-approval-envelope-headroom", threadSource: null, turns: [] }],
    onRunInteraction(_runSnapshot, interaction) {
      interactions.push(interaction);
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "approval-envelope-headroom" });
  const run = value.coordinator.getRun(ack.run.id);
  const pending = value.host.request("item/commandExecution/requestApproval", {
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    itemId: "near-limit-item",
    startedAtMs: 1,
    environmentId: null,
    command: `printf ${"x".repeat(40 * 1024)}`,
    commandActions: null,
    cwd: null,
    reason: "near-limit command details",
    approvalId: null,
    networkApprovalContext: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
  }, 9_999_998);
  pending.catch(() => {});
  while (value.coordinator.getRun(run.id).status !== "waiting_approval") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const waiting = value.coordinator.getRun(run.id);
  const requested = interactions.find((interaction) => interaction.phase === "requested");
  assert.equal(requested.payload.redacted, true);
  const reset = value.coordinator.subscribeRun(run.id, {
    streamId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    afterSeq: 0,
  }, () => {});
  assert.equal(reset.gap.code, "STREAM_RESET");
  assert.equal(reset.snapshot.interaction.payload.redacted, true);
  assert.equal(Buffer.byteLength(JSON.stringify(reset.snapshot), "utf8") < 48 * 1024, true);
  reset.unsubscribe();
  await value.coordinator.respondApproval({
    operationId: "approval-envelope-headroom-deny",
    runId: run.id,
    requestId: waiting.waitingRequestId,
    choice: "deny",
  });
  assert.deepEqual(await pending, { decision: "decline" });
  await value.coordinator.close();
});

test("near-limit MCP input remains usable instead of being approval-redacted", async () => {
  const interactions = [];
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-input-envelope-headroom",
    threads: [{ id: "thread-input-envelope-headroom", threadSource: null, turns: [] }],
    onRunInteraction(_runSnapshot, interaction) {
      interactions.push(interaction);
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "input-envelope-headroom" });
  const run = value.coordinator.getRun(ack.run.id);
  const description = "x".repeat(36 * 1024);
  const pending = value.host.request("mcpServer/elicitation/request", {
    serverName: "shoggoth",
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    mode: "form",
    message: "Need a large but valid form",
    requestedSchema: {
      type: "object",
      properties: {
        choice: { type: "string", title: "Choice", description },
      },
      required: ["choice"],
    },
  }, "raw-input-envelope-headroom");
  pending.catch(() => {});
  while (value.coordinator.getRun(run.id).status !== "waiting_input") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const waiting = value.coordinator.getRun(run.id);
  const requested = interactions.find((interaction) => interaction.phase === "requested");
  assert.equal(requested.payload.redacted, undefined);
  assert.equal(requested.payload.requestedSchema.properties.choice.description, description);
  const reset = value.coordinator.subscribeRun(run.id, {
    streamId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    afterSeq: 0,
  }, () => {});
  assert.equal(reset.gap.code, "STREAM_RESET");
  assert.equal(reset.snapshot.interaction.payload.redacted, undefined);
  assert.equal(
    reset.snapshot.interaction.payload.requestedSchema.properties.choice.description,
    description,
  );
  assert.equal(Buffer.byteLength(JSON.stringify(reset.snapshot), "utf8") < 48 * 1024, true);
  reset.unsubscribe();
  await value.coordinator.respondInput({
    operationId: "input-envelope-headroom-cancel",
    runId: run.id,
    requestId: waiting.waitingRequestId,
    action: "cancel",
    answers: {},
  });
  assert.deepEqual(await pending, { action: "cancel" });
  await value.coordinator.close();
});

test("Shoggoth MCP 工具权限在 assigned turn 且 frozen contract 匹配时由产品策略直接处理", async () => {
  const evaluations = [];
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-product-mcp-policy",
    threads: [{ id: "thread-product-mcp-policy", threadSource: null, turns: [] }],
    productMcpApprovalPolicy: {
      evaluate(input) {
        evaluations.push(input);
        assert.equal(input.method, "mcpServer/elicitation/request");
        assert.equal(input.run.id, input.executionContract.runId);
        assert.equal(input.run.profileId, input.executionContract.profileId);
        assert.equal(input.context.threadId, input.params.threadId);
        assert.equal(input.context.turnId, input.params.turnId);
        return { action: "accept", content: {} };
      },
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "product-mcp-policy-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const response = await value.host.request("mcpServer/elicitation/request", {
    serverName: "shoggoth",
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    mode: "form",
    message: 'Allow the shoggoth MCP server to run tool "computer_type"?',
    requestedSchema: {
      type: "object", properties: {}, required: [], additionalProperties: false,
    },
  }, "raw-product-mcp-policy");
  assert.deepEqual(response, { action: "accept", content: {} });
  assert.equal(value.coordinator.getRun(run.id).status, "running");
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 0);
  assert.equal(evaluations.length, 1);
  await value.coordinator.close();
});

test("MCP elicitation 进入 waiting_input，submit/cancel 映射稳定 response 且不启用 tool input", async () => {
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-mcp-input",
    threads: [{ id: "thread-mcp-input", threadSource: null, turns: [] }],
  });
  const { ack } = await sendAndDrain(value, { operationId: "mcp-input-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const events = [];
  value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, (event) => events.push(event));

  async function elicit(index, action, answers, expected) {
    const pending = value.host.request("mcpServer/elicitation/request", {
      serverName: "shoggoth",
      threadId: run.runtimeSessionRef?.sessionId,
      turnId: run.runtimeTurnRef?.turnId,
      mode: "form",
      message: `Need input ${index}`,
      requestedSchema: {
        type: "object",
        properties: { choice: { type: "string", title: "Choice" } },
        required: ["choice"],
      },
    }, `raw-mcp-${index}`);
    pending.catch(() => {});
    while (value.coordinator.getRun(run.id).status !== "waiting_input") {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const waiting = value.coordinator.getRun(run.id);
    const result = await value.coordinator.respondInput({
      operationId: `mcp-response-${index}`,
      runId: run.id,
      requestId: waiting.waitingRequestId,
      action,
      answers,
    });
    assert.equal(result.state, "responded");
    assert.equal(result.run.status, "running");
    assert.deepEqual(await pending, expected);
  }
  await elicit(1, "submit", { choice: "yes" }, {
    action: "accept",
    content: { choice: "yes" },
  });
  await elicit(2, "cancel", {}, { action: "cancel" });
  assert.equal(events.filter((event) => event.type === "prompt").length, 2);
  assert.equal(events.find((event) => event.type === "prompt").payload.kind, "mcp_elicitation");
  assert.equal(value.host.serverRequestHandlers.has("item/tool/requestUserInput"), false);
  await value.coordinator.close();
});

test("产品确认 MCP elicitation 持续等待且仍通过 input response API 回应", async () => {
  const scheduled = new Set();
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-product-confirmation-wait",
    threads: [{ id: "thread-product-confirmation-wait", threadSource: null, turns: [] }],
    promptTimeoutMs: 10,
    promptScheduler: {
      set(callback) { const handle = { callback }; scheduled.add(handle); return handle; },
      clear(handle) { scheduled.delete(handle); },
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "product-confirmation-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const prompts = [];
  value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, (event) => {
    if (event.type === "prompt") prompts.push(event);
  });
  const pending = value.host.request("mcpServer/elicitation/request", {
    serverName: "shoggoth",
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    mode: "form",
    message: "确认修改",
    requestedSchema: {
      type: "object",
      properties: {
        confirm_product_action: {
          type: "string",
          title: "确认修改",
          enum: ["确认执行", "取消"],
        },
      },
      required: ["confirm_product_action"],
    },
  }, "raw-product-confirmation-wait");
  while (value.coordinator.getRun(run.id).status !== "waiting_input") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(scheduled.size, 0);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].payload.expiresAt ?? null, null);
  const waiting = value.coordinator.getRun(run.id);
  await value.coordinator.respondInput({
    operationId: "product-confirmation-response",
    runId: run.id,
    requestId: waiting.waitingRequestId,
    action: "submit",
    answers: { confirm_product_action: "确认执行" },
  });
  assert.deepEqual(await pending, {
    action: "accept", content: { confirm_product_action: "确认执行" },
  });
  await value.coordinator.close();
});

test("abort 在 interrupt 前先 settle 当前 pending server request，并清理 timer/deferred", async () => {
  const interruptGate = deferred();
  const scheduled = new Set();
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-abort-pending",
    threads: [{ id: "thread-abort-pending", threadSource: null, turns: [] }],
    interruptGate,
    promptScheduler: {
      set(callback) { const handle = { callback }; scheduled.add(handle); return handle; },
      clear(handle) { scheduled.delete(handle); },
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "abort-pending-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const serverResponse = value.host.request("item/fileChange/requestApproval", {
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    itemId: "abort-pending-item",
    startedAtMs: 1,
    grantRoot: null,
    reason: null,
  }, "raw-abort-pending");
  serverResponse.catch(() => {});
  while (value.coordinator.getRun(run.id).status !== "waiting_approval") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(scheduled.size, 0);
  const aborting = value.coordinator.abort({
    operationId: "abort-pending-control",
    sessionKey: SESSION_KEY,
    runId: run.id,
  });
  while (value.host.turnInterruptCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeInterruptReturns = await Promise.race([
    serverResponse.then((response) => ({ settled: true, response })),
    new Promise((resolve) => setImmediate(() => resolve({ settled: false }))),
  ]);
  assert.deepEqual(settledBeforeInterruptReturns, {
    settled: true,
    response: { decision: "cancel" },
  });
  assert.equal(scheduled.size, 0);
  interruptGate.resolve();
  assert.equal((await aborting).status, "canceled");
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 0);
  await value.coordinator.close();
});

test("approval 超过默认五分钟仍保持 pending，expiresAt 为 null 且可正常批准", async () => {
  let now = 1_000;
  let timerSets = 0;
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-approval-unbounded",
    threads: [{ id: "thread-approval-unbounded", threadSource: null, turns: [] }],
    now: () => now,
    promptScheduler: {
      set() { timerSets += 1; return {}; },
      clear() {},
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "approval-unbounded-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const events = [];
  value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, (event) => events.push(event));
  const response = value.host.request("item/commandExecution/requestApproval", {
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    itemId: "approval-unbounded-item",
    command: "echo safe",
    cwd: "/tmp/project",
    reason: "test",
  }, "raw-approval-unbounded");
  response.catch(() => {});
  while (value.coordinator.getRun(run.id).status !== "waiting_approval") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  now += 6 * 60 * 1_000;
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = value.coordinator.getRun(run.id);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(timerSets, 0);
  assert.equal(events.find((event) => event.type === "approval").payload.expiresAt ?? null, null);
  await value.coordinator.respondApproval({
    operationId: "approval-unbounded-response",
    runId: run.id,
    requestId: waiting.waitingRequestId,
    choice: "once",
  });
  assert.deepEqual(await response, { decision: "accept" });
  assert.equal(value.coordinator.getRun(run.id).status, "running");
  await value.coordinator.close();
});

test("prompt timeout 有界 settle/interrupt，并 durable 收敛 interrupted 与 Inbox tombstone", async () => {
  const scheduled = new Set();
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-prompt-timeout",
    threads: [{ id: "thread-prompt-timeout", threadSource: null, turns: [] }],
    promptTimeoutMs: 10,
    promptScheduler: {
      set(callback, delay) {
        assert.equal(delay, 10);
        const handle = { callback };
        scheduled.add(handle);
        return handle;
      },
      clear(handle) { scheduled.delete(handle); },
    },
  });
  const { ack, operationId } = await sendAndDrain(value, { operationId: "prompt-timeout-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const terminalEvents = [];
  value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, (event) => {
    if (event.type === "terminal") terminalEvents.push(event);
  });
  const serverResponse = value.host.request("mcpServer/elicitation/request", {
    serverName: "shoggoth",
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    mode: "form",
    message: "timeout me",
    requestedSchema: { type: "object", properties: {}, required: [] },
  }, "raw-timeout");
  serverResponse.catch(() => {});
  while (value.coordinator.getRun(run.id).status !== "waiting_input") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(scheduled.size, 1);
  [...scheduled][0].callback();
  assert.deepEqual(await serverResponse, { action: "cancel" });
  const terminal = await value.coordinator.waitForIdle(run.id);
  assert.equal(terminal.status, "interrupted");
  assert.equal(terminal.errorCode, "CODEX_PROMPT_TIMEOUT");
  assert.equal(value.inbox.get(operationId).state, "completed");
  assert.equal(value.host.turnInterruptCalls, 1);
  assert.equal(terminalEvents.length, 1);
  assert.equal(scheduled.size, 0);
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 0);
  await value.coordinator.close();
});

test("Host terminate 清理 pending deferred/timer/handler 并沿既有 durable interrupted 路径收敛", async () => {
  const scheduled = new Set();
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-pending-host-dead",
    threads: [{ id: "thread-pending-host-dead", threadSource: null, turns: [] }],
    promptScheduler: {
      set(callback) { const handle = { callback }; scheduled.add(handle); return handle; },
      clear(handle) { scheduled.delete(handle); },
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "pending-host-dead-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const response = value.host.request("item/permissions/requestApproval", {
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    itemId: "pending-host-dead-item",
    startedAtMs: 1,
    cwd: "/tmp/project",
    environmentId: null,
    permissions: { fileSystem: null, network: null },
    reason: null,
  }, "raw-host-dead-request");
  response.catch(() => {});
  while (value.coordinator.getRun(run.id).status !== "waiting_approval") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  value.host.terminate(codedError("APP_SERVER_EXITED"));
  assert.deepEqual(await response, { permissions: {}, scope: "turn" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await value.coordinator.waitForIdle(run.id)).status, "interrupted");
  assert.equal(scheduled.size, 0);
  assert.equal(value.host.serverRequestHandlers.size, 0);
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 0);
  await value.coordinator.close();
});

test("close 立即 settle 所有 pending server request 并清除 timer/handler，不等待 prompt timeout", async () => {
  const scheduled = new Set();
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-pending-close",
    threads: [{ id: "thread-pending-close", threadSource: null, turns: [] }],
    promptScheduler: {
      set(callback) { const handle = { callback }; scheduled.add(handle); return handle; },
      clear(handle) { scheduled.delete(handle); },
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "pending-close-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const response = value.host.request("mcpServer/elicitation/request", {
    serverName: "shoggoth",
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    mode: "form",
    message: "close",
    requestedSchema: { type: "object", properties: {}, required: [] },
  }, "raw-close-request");
  response.catch(() => {});
  while (value.coordinator.getRun(run.id).status !== "waiting_input") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await value.coordinator.close();
  assert.deepEqual(await response, { action: "cancel" });
  assert.equal(scheduled.size, 0);
  assert.equal(value.host.serverRequestHandlers.size, 0);
});

test("prompt timer 建立失败时回滚 waiting 状态并清除 pending record，绝不留下悬挂 deferred", async () => {
  const interactions = [];
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-prompt-setup-failure",
    threads: [{ id: "thread-prompt-setup-failure", threadSource: null, turns: [] }],
    approvalTimeoutMs: 10,
    promptScheduler: {
      set() { throw codedError("PROMPT_TIMER_FAILED"); },
      clear() {},
    },
    onRunInteraction(runSnapshot, interaction) {
      interactions.push({ run: runSnapshot, interaction: structuredClone(interaction) });
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "prompt-setup-failure-source" });
  const run = value.coordinator.getRun(ack.run.id);
  assert.throws(
    () => value.host.request("item/fileChange/requestApproval", {
      threadId: run.runtimeSessionRef?.sessionId,
      turnId: run.runtimeTurnRef?.turnId,
      itemId: "prompt-setup-failure-item",
      startedAtMs: 1,
      grantRoot: null,
      reason: null,
    }, "raw-setup-failure"),
    (error) => error.code === "PROMPT_TIMER_FAILED",
  );
  assert.equal(value.coordinator.getRun(run.id).status, "running");
  assert.equal(value.coordinator.getRun(run.id).waitingRequestId, null);
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 0);
  assert.deepEqual(interactions.map(({ interaction }) => interaction.phase), [
    "requested",
    "resolved",
  ]);
  assert.equal(interactions[0].interaction.requestId, interactions[1].interaction.requestId);
  await value.coordinator.close();
});

test("waiting approval unknown commit 立即 sticky poison，禁止 reread/rollback/event/timer", async () => {
  let timerSets = 0;
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-waiting-uncertain",
    threads: [{ id: "thread-waiting-uncertain", threadSource: null, turns: [] }],
    promptScheduler: {
      set() { timerSets += 1; return {}; },
      clear() {},
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "waiting-uncertain-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const events = [];
  value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, (event) => events.push(event));
  value.dispatcher.transitionFailures.set("waiting_approval", "STORE_COMMIT_UNCERTAIN");
  value.dispatcher.getRunCalls = 0;
  assert.throws(
    () => value.host.request("item/fileChange/requestApproval", {
      threadId: run.runtimeSessionRef?.sessionId,
      turnId: run.runtimeTurnRef?.turnId,
      itemId: "waiting-uncertain-item",
      startedAtMs: 1,
      grantRoot: null,
      reason: null,
    }, "raw-waiting-uncertain"),
    (error) => error.code === "STORE_COMMIT_UNCERTAIN",
  );
  assert.equal(value.dispatcher.getRunCalls, 1, "unknown commit 后禁止再次读取决定 rollback");
  assert.equal(timerSets, 0);
  assert.equal(events.some((event) => event.type === "approval"), false);
  assert.throws(
    () => value.coordinator.getRun(run.id),
    (error) => error.code === "STORE_COMMIT_UNCERTAIN",
  );
  await value.coordinator.close();
});

test("approval 恢复 running unknown commit 立即 sticky poison，不 settle response 或追加 status", async () => {
  const scheduled = new Set();
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-approval-restore-uncertain",
    threads: [{ id: "thread-approval-restore-uncertain", threadSource: null, turns: [] }],
    promptScheduler: {
      set(callback) { const handle = { callback }; scheduled.add(handle); return handle; },
      clear(handle) { scheduled.delete(handle); },
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "approval-restore-uncertain-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const events = [];
  value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, (event) => events.push(event));
  const serverResponse = value.host.request("item/fileChange/requestApproval", {
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    itemId: "approval-restore-uncertain-item",
    startedAtMs: 1,
    grantRoot: null,
    reason: null,
  }, "raw-approval-restore-uncertain");
  serverResponse.catch(() => {});
  while (value.dispatcher.getRun(run.id).status !== "waiting_approval") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const requestId = value.dispatcher.getRun(run.id).waitingRequestId;
  value.dispatcher.transitionFailures.set("running", "STORE_COMMIT_UNCERTAIN");
  await assert.rejects(
    () => value.coordinator.respondApproval({
      operationId: "approval-restore-uncertain-response",
      runId: run.id,
      requestId,
      choice: "once",
    }),
    (error) => error.code === "STORE_COMMIT_UNCERTAIN",
  );
  assert.equal(events.some((event) => event.type === "status"
    && event.payload.requestId === requestId), false);
  assert.throws(
    () => value.coordinator.getRun(run.id),
    (error) => error.code === "STORE_COMMIT_UNCERTAIN",
  );
  await value.coordinator.close();
  assert.deepEqual(await serverResponse, { decision: "cancel" });
  assert.equal(scheduled.size, 0);
});

test("MCP input 恢复 running unknown commit 立即 sticky poison，不 settle response 或追加 status", async () => {
  const scheduled = new Set();
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-input-restore-uncertain",
    threads: [{ id: "thread-input-restore-uncertain", threadSource: null, turns: [] }],
    promptScheduler: {
      set(callback) { const handle = { callback }; scheduled.add(handle); return handle; },
      clear(handle) { scheduled.delete(handle); },
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "input-restore-uncertain-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const events = [];
  value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, (event) => events.push(event));
  const serverResponse = value.host.request("mcpServer/elicitation/request", {
    serverName: "shoggoth",
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    mode: "form",
    message: "unknown commit",
    requestedSchema: { type: "object", properties: {}, required: [] },
  }, "raw-input-restore-uncertain");
  serverResponse.catch(() => {});
  while (value.dispatcher.getRun(run.id).status !== "waiting_input") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const requestId = value.dispatcher.getRun(run.id).waitingRequestId;
  value.dispatcher.transitionFailures.set("running", "STORE_COMMIT_UNCERTAIN");
  await assert.rejects(
    () => value.coordinator.respondInput({
      operationId: "input-restore-uncertain-response",
      runId: run.id,
      requestId,
      action: "submit",
      answers: { answer: "value" },
    }),
    (error) => error.code === "STORE_COMMIT_UNCERTAIN",
  );
  assert.equal(events.some((event) => event.type === "status"
    && event.payload.requestId === requestId), false);
  assert.throws(
    () => value.coordinator.getRun(run.id),
    (error) => error.code === "STORE_COMMIT_UNCERTAIN",
  );
  await value.coordinator.close();
  assert.deepEqual(await serverResponse, { action: "cancel" });
  assert.equal(scheduled.size, 0);
});

test("abort 从 waiting 恢复 running unknown commit 立即 sticky poison，禁止调用 interrupt", async () => {
  const scheduled = new Set();
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-abort-restore-uncertain",
    threads: [{ id: "thread-abort-restore-uncertain", threadSource: null, turns: [] }],
    promptScheduler: {
      set(callback) { const handle = { callback }; scheduled.add(handle); return handle; },
      clear(handle) { scheduled.delete(handle); },
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "abort-restore-uncertain-source" });
  const run = value.coordinator.getRun(ack.run.id);
  const serverResponse = value.host.request("item/fileChange/requestApproval", {
    threadId: run.runtimeSessionRef?.sessionId,
    turnId: run.runtimeTurnRef?.turnId,
    itemId: "abort-restore-uncertain-item",
    startedAtMs: 1,
    grantRoot: null,
    reason: null,
  }, "raw-abort-restore-uncertain");
  serverResponse.catch(() => {});
  while (value.dispatcher.getRun(run.id).status !== "waiting_approval") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  value.dispatcher.transitionFailures.set("running", "STORE_COMMIT_UNCERTAIN");
  await assert.rejects(
    () => value.coordinator.abort({
      operationId: "abort-restore-uncertain-control",
      sessionKey: SESSION_KEY,
      runId: run.id,
    }),
    (error) => error.code === "STORE_COMMIT_UNCERTAIN",
  );
  assert.deepEqual(await serverResponse, { decision: "cancel" });
  assert.equal(value.host.turnInterruptCalls, 0);
  assert.equal(scheduled.size, 0);
  assert.throws(
    () => value.coordinator.getRun(run.id),
    (error) => error.code === "STORE_COMMIT_UNCERTAIN",
  );
  await value.coordinator.close();
});

test("close 使每个 await 后的 generation fence 生效，并等待在途 run 收敛", async () => {
  const gate = deferred();
  const value = await openFixture({ runtimeGate: gate });
  const ack = await value.coordinator.send({
    operationId: "close-fence", sessionKey: SESSION_KEY, prompt: "close now",
  });
  while (!value.log.includes("runtimePool.get")) await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = value.coordinator.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  gate.resolve();
  await closing;
  assert.equal(value.host.threadStartCalls, 0);
  assert.equal(value.host.turnStartCalls, 0);
  await assert.rejects(
    () => value.coordinator.waitForIdle(ack.run.id),
    (error) => error.code === "WORK_RUN_COORDINATOR_CLOSED",
  );
});

test("close 取消 terminal retry timer 并阻止迟到 terminal 写入", async () => {
  const scheduled = [];
  let canceled = 0;
  const value = await openFixture({
    sessionStatus: "ready",
    threadId: "thread-close-terminal-retry",
    threads: [{ id: "thread-close-terminal-retry", threadSource: null, turns: [] }],
    terminalRetryDelaysMs: [10],
    terminalRetryScheduler: {
      set(callback, delay) {
        const handle = { callback, delay, canceled: false };
        scheduled.push(handle);
        return handle;
      },
      clear(handle) {
        handle.canceled = true;
        canceled += 1;
      },
    },
  });
  const { ack } = await sendAndDrain(value, { operationId: "close-terminal-retry" });
  const running = value.coordinator.getRun(ack.run.id);
  value.host.emit({
    known: true,
    type: "complete",
    method: "turn/completed",
    threadId: running.runtimeSessionRef?.sessionId,
    turnId: running.runtimeTurnRef?.turnId,
    status: "completed",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  await value.coordinator.close();
  assert.equal(canceled, 1);
  assert.equal(scheduled[0].canceled, true);
  assert.equal(value.dispatcher.getRun(running.id).status, "running");
  assert.equal(value.inbox.get("close-terminal-retry").state, "dispatching");
});

test("Product Core 可由只实现通用 session/turn 契约的 Future Runtime 驱动", async () => {
  const calls = [];
  const subscribers = new Set();
  const termination = deferred();
  const futureSession = { id: "future-session", source: null, turns: [] };
  const futureHandle = {
    runtime: "future",
    runtimeProfileId: "runtime-default",
    runtimeAccountId: RUNTIME_ACCOUNT_ID,
    terminated: termination.promise,
    registeredSecrets: [],
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    registerServerRequestHandler(method) {
      calls.push(["registerServerRequestHandler", method]);
      return () => {};
    },
    async sessionList() {
      calls.push(["sessionList"]);
      return { data: [], nextCursor: null };
    },
    async sessionStart(input) {
      calls.push(["sessionStart", clone(input)]);
      futureSession.source = input.source;
      return { session: clone(futureSession) };
    },
    async sessionResume(input) {
      calls.push(["sessionResume", clone(input)]);
      return { session: { id: input.sessionId, source: "shoggoth:future", turns: [] } };
    },
    async sessionRead(input) {
      calls.push(["sessionRead", clone(input)]);
      return { session: clone(futureSession) };
    },
    async turnStart(input) {
      calls.push(["turnStart", clone(input)]);
      const turn = {
        id: "future-turn",
        status: "inProgress",
        itemsView: "full",
        items: [{ type: "userMessage", id: "future-message", clientId: input.operationId }],
      };
      futureSession.turns.push(turn);
      return { turn: clone(turn) };
    },
    async turnSteer(input) { calls.push(["turnSteer", clone(input)]); return { turnId: input.turnId }; },
    async turnInterrupt(input) { calls.push(["turnInterrupt", clone(input)]); return {}; },
  };
  const runtimeManager = {
    async acquire(binding, acquireOptions) {
      calls.push(["acquire", clone(binding), clone(acquireOptions)]);
      return futureHandle;
    },
    stop() {},
    stopAll() {},
  };
  const value = await openFixture({ runtime: "future", runtimeManager });
  const { ack } = await sendAndDrain(value, { operationId: "future-runtime-send" });
  const running = value.coordinator.getRun(ack.run.id);
  assert.equal(running.status, "running");
  assert.equal(running.runtimeSessionRef?.sessionId, "future-session", "legacy disk field remains a projection during migration");
  assert.equal(running.runtimeTurnRef?.turnId, "future-turn", "legacy disk field remains a projection during migration");
  assert.deepEqual(calls.find(([name]) => name === "acquire")[1], {
    runtime: "future",
    runtimeProfileId: "runtime-default",
    runtimeAccountId: RUNTIME_ACCOUNT_ID,
  });
  const { executionContract, ...acquireOptions } = calls.find(([name]) => name === "acquire")[2];
  assert.deepEqual(acquireOptions, {
    permissionPolicy: { approvalPolicy: "on-failure", sandbox: "workspace-write" },
    workspace: "/tmp/shoggoth-workspace",
  });
  assert.equal(executionContract.runtime, "future");
  assert.equal(executionContract.runId, value.coordinator.listRuns()[0].id);
  const start = calls.find(([name]) => name === "sessionStart")[1];
  assert.equal(start.persistent, true);
  assert.equal(start.permissionPolicy.approvalPolicy, "on-failure");
  const turn = calls.find(([name]) => name === "turnStart")[1];
  assert.equal(turn.sessionId, "future-session");
  assert.equal(turn.operationId, "future-runtime-send");
  assert.equal(turn.prompt, "hello from inbox only");
  assert.equal(value.log.includes("runtimePool.get"), false);
  await value.coordinator.close();
  termination.resolve();
});

test("Chat Run 在 Runtime admission 前持久化 user Transcript，失败时保持 queued", async () => {
  const events = [];
  const transcriptStore = {
    appendEvent(input) {
      events.push(clone(input));
      return clone(input);
    },
  };
  const value = await openFixture({ transcriptStore });
  const ack = await value.coordinator.send({
    operationId: "transcript-before-runtime",
    sessionKey: SESSION_KEY,
    prompt: "durable first",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, value.sessions.session.id);
  assert.equal(events[0].runId, ack.run.id);
  assert.equal(events[0].kind, "user");
  assert.equal(events[0].content.text, "durable first");
  assert.ok(value.log.indexOf("dispatcher.admit") > value.log.indexOf("dispatcher.enqueue"));
  await value.coordinator.waitForIdle(ack.run.id);
  await value.coordinator.close();

  const failing = await openFixture({
    transcriptStore: {
      appendEvent() { throw codedError("TRANSCRIPT_WRITE_FAILED"); },
    },
  });
  await assert.rejects(failing.coordinator.send({
    operationId: "transcript-fails-closed",
    sessionKey: SESSION_KEY,
    prompt: "must not reach runtime",
  }), (error) => error.code === "TRANSCRIPT_WRITE_FAILED");
  const queued = failing.dispatcher.listRuns().find(
    (run) => run.idempotencyKey === "shoggoth:chat-send:transcript-fails-closed",
  );
  assert.equal(queued.status, "queued");
  assert.equal(failing.host.turnStartCalls, 0);
  await failing.coordinator.close();
});

module.exports = { openFixture, sendAndDrain, waitUntil, FakeChatSessionStore, FakeHost,
  createRealTransportHost, codexRuntimeEnvironment, recoveryStore, directRuntimeManager,
  SESSION_KEY, PROFILE_ID, RUNTIME_ACCOUNT_ID };

if (require.main === module) (async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      process.stdout.write(`ok - ${entry.name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`not ok - ${entry.name}\n${error.stack || error}\n`);
    }
  }
  if (failed > 0) process.exitCode = 1;
  else process.stdout.write(`${tests.length} coordinator tests passed\n`);
})();
