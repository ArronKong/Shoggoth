#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const { GrokBuildAcpJsonlClient } = require(path.join(
  ROOT, "app", "agent-service", "grok-build-acp-jsonl.js",
));
const { GrokBuildRuntimeAdapter } = require(path.join(
  ROOT, "app", "agent-service", "grok-build-runtime-adapter.js",
));
const { GrokBuildRuntimePool } = require(path.join(
  ROOT, "app", "agent-service", "grok-build-runtime-pool.js",
));
const { GROK_COMPAT_DISABLE_ENV, validateMcpServer } = require(path.join(
  ROOT, "app", "agent-service", "grok-build-runtime-host.js",
));
const {
  DEFAULT_GROK_BUILD_PERMISSION_POLICY,
  buildGrokBuildArgs,
  grokBuildWorkspaceShardId,
  resolveGrokBuildBinary,
} = require(path.join(ROOT, "app", "agent-service", "grok-build-runtime-paths.js"));
const {
  NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));

const NO_RESPONSE = Symbol("NO_RESPONSE");
let nextPid = 42_000;

function rpcResult(result) {
  return { type: "result", result };
}

function rpcError(code, message) {
  return { type: "error", error: { code, message } };
}

function initializeResult(options = {}) {
  const authMethodId = options.authMethodId ?? "cached_token";
  const authMethods = options.authMethods
    ?? [{ id: authMethodId, name: "Grok authentication" }];
  return {
    protocolVersion: 1,
    authMethods,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {}, close: {} },
    },
    _meta: {
      defaultAuthMethodId: options.defaultAuthMethodId === undefined
        ? authMethodId : options.defaultAuthMethodId,
      modelState: {
        currentModelId: "grok-4.6",
        availableModels: [
          { modelId: "grok-4.6", name: "Grok 4.6", description: "default" },
          { modelId: "grok-4.5", name: "Grok 4.5" },
        ],
      },
    },
  };
}

class FakeChild extends EventEmitter {
  constructor(server = () => NO_RESPONSE) {
    super();
    this.pid = nextPid += 1;
    this.server = server;
    this.messages = [];
    this.closed = false;
    this.buffer = "";
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.buffer += chunk.toString("utf8");
        for (;;) {
          const newline = this.buffer.indexOf("\n");
          if (newline < 0) break;
          const frame = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(frame); } catch (error) {
            callback(error);
            return;
          }
          this.messages.push(message);
          this.#dispatch(message);
        }
        callback();
      },
    });
  }

  #dispatch(message) {
    let action;
    try { action = this.server(message, this); } catch (error) {
      action = Promise.reject(error);
    }
    Promise.resolve(action).then((resolved) => {
      if (resolved === NO_RESPONSE || resolved === undefined || !Object.hasOwn(message, "id")
        || typeof message.method !== "string") return;
      if (resolved?.type === "error") this.sendError(message.id, resolved.error);
      else this.sendResult(message.id, resolved?.type === "result" ? resolved.result : resolved);
    }, (error) => {
      if (Object.hasOwn(message, "id") && typeof message.method === "string") {
        this.sendError(message.id, { code: -32603, message: error?.message || "fake failure" });
      }
    });
  }

  send(message) {
    if (!this.closed) this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendResult(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  sendError(id, error) {
    this.send({ jsonrpc: "2.0", id, error });
  }

  sendNotification(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  closeProcess() {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.stdin.destroy();
    queueMicrotask(() => {
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    });
  }
}

function fixtureOptions(server, overrides = {}) {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-grok-build-"));
  fs.chmodSync(trustedRoot, 0o700);
  const binDir = path.join(trustedRoot, "bin");
  fs.mkdirSync(binDir, { mode: 0o700 });
  const binaryPath = path.join(binDir, "grok");
  fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const requestedUserHome = overrides.homedir || path.join(trustedRoot, "user-home");
  if (!fs.existsSync(requestedUserHome)) {
    fs.mkdirSync(requestedUserHome, { recursive: true, mode: 0o700 });
  }
  const userHome = fs.realpathSync(requestedUserHome);
  const nativeHome = path.join(userHome, ".grok");
  fs.mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
  const children = [];
  const spawns = [];
  const spawnProcess = (command, args, options) => {
    const child = new FakeChild(server);
    children.push(child);
    spawns.push({ command, args, options, child });
    return child;
  };
  const paths = {
    stateDir: path.join(trustedRoot, "state"),
    trustedRoot,
  };
  const pool = new GrokBuildRuntimePool({
    paths,
    binaryPath,
    spawnProcess,
    parentEnv: {
      HOME: userHome, PATH: binDir, LANG: "C.UTF-8", SECRET_TOKEN: "must-not-leak",
    },
    homedir: userHome,
    acceptanceTimeoutMs: 100,
    requestTimeoutMs: 1_000,
    promptTimeoutMs: 1_000,
    shutdownGraceMs: 20,
    killGraceMs: 20,
    killProcessGroup(pid) {
      children.find((child) => child.pid === pid)?.closeProcess();
    },
    processGroupExists: () => false,
    ...overrides,
  });
  const adapter = new GrokBuildRuntimeAdapter({ runtimePool: pool });
  return {
    adapter,
    binaryPath,
    children,
    paths,
    pool,
    spawns,
    userHome,
    nativeHome,
    cleanup() {
      for (const child of children) child.closeProcess();
      fs.rmSync(trustedRoot, { recursive: true, force: true });
    },
  };
}

function standardServer(extra) {
  let sessionSequence = 0;
  return (message, child) => {
    if (message.method === "initialize") {
      return rpcResult(initializeResult({ authMethods: [], defaultAuthMethodId: null }));
    }
    if (message.method === "authenticate") return rpcResult({});
    if (message.method === "session/new") {
      sessionSequence += 1;
      return rpcResult({ sessionId: `session-${sessionSequence}` });
    }
    if (["session/resume", "session/load", "session/set_model", "session/set_mode", "session/close", "session/delete"]
      .includes(message.method)) return rpcResult({});
    return extra?.(message, child) ?? NO_RESPONSE;
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

async function acquire(fixture, options = {}) {
  const workspaceOptions = options.control === true
    ? {}
    : { workspace: options.workspace === undefined ? "/tmp/workspace" : options.workspace };
  return fixture.adapter.acquire({
    runtime: "grok-build",
    runtimeProfileId: options.runtimeProfileId || "grok-main",
    runtimeAccountId: options.runtimeAccountId || NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  }, {
    permissionPolicy: options.permissionPolicy || {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    },
    ...workspaceOptions,
    ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
    ...(options.mcpServersFactory === undefined ? {} : {
      mcpServersFactory: options.mcpServersFactory,
    }),
    ...(options.createMcpServer === undefined ? {} : {
      createMcpServer: options.createMcpServer,
    }),
  });
}

function binding(runtimeProfileId = "grok-main") {
  return {
    runtime: "grok-build",
    runtimeProfileId,
    runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  };
}

async function startSession(runtime, source = "chat:one") {
  return runtime.sessionStart({
    source,
    persistent: true,
    developerInstructions: "Keep changes scoped.",
    model: "grok-4.6",
    cwd: "/tmp/workspace",
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  });
}

test("happy stream uses native account GROK_HOME, models, controlled MCP and local lifecycle", async () => {
  const promptIds = [];
  const server = standardServer((message, child) => {
    if (message.method === "session/prompt") {
      promptIds.push(message.id);
      setImmediate(() => {
        child.sendNotification("session/update", {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "web-search-1",
            title: "Web search:",
            kind: "search",
            status: "in_progress",
            rawInput: { variant: "WebSearch", backend: true },
          },
        });
        child.sendNotification("session/update", {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "web-search-1",
            title: "Web search:",
            kind: "search",
            status: "completed",
            rawOutput: {
              action: {
                type: "search",
                query: "native agent trajectory",
                sources: [{ type: "url", url: "https://example.com/result" }],
              },
              status: "completed",
            },
          },
        });
        child.sendNotification("session/update", {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "terminal-1",
            title: "Terminal command",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "pwd" },
          },
        });
        child.sendNotification("session/update", {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "terminal-1",
            status: "completed",
            rawOutput: { status: "completed", output: "/tmp/workspace" },
          },
        });
        child.sendNotification("session/update", {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "message-1",
            content: { type: "text", text: "done" },
          },
        });
        child.sendResult(message.id, { stopReason: "end_turn" });
      });
      return NO_RESPONSE;
    }
    return undefined;
  });
  const fixture = fixtureOptions(server);
  const helper = path.join(fixture.paths.trustedRoot, "mcp-helper");
  fs.writeFileSync(helper, "#!/bin/sh\n", { mode: 0o700 });
  const gateNonce = "a".repeat(64);
  try {
    const mcpContexts = [];
    const descriptors = [];
    const runtime = await acquire(fixture, {
      createMcpServer(context) {
        mcpContexts.push(context);
        const descriptor = {
          name: "shoggoth-controlled",
          command: helper,
          args: ["--runtime", "grok-build", `--gate-${mcpContexts.length}`],
          env: [
            { name: "SAFE_MODE", value: "1" },
            { name: "SHOGGOTH_RUNTIME_MCP_GATE_NONCE", value: gateNonce },
          ],
        };
        descriptors.push(descriptor);
        return descriptor;
      },
    });
    assert.equal(runtime.runtime, "grok-build");
    assert.equal(runtime.capabilities["account.login"], false);
    assert.equal(runtime.capabilities["session.delete"], false);
    assert.equal(runtime.capabilities["turn.steer"], false);
    assert.deepEqual(runtime.registeredSecrets, []);
    assert.equal(fixture.spawns.length, 1);
    const launched = fixture.spawns[0];
    assert.equal(launched.command, fs.realpathSync(fixture.binaryPath));
    assert.deepEqual(launched.args, ["--sandbox", "workspace", "agent", "--no-leader", "stdio"]);
    assert.equal(launched.options.shell, false);
    assert.deepEqual(launched.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(launched.options.cwd, "/tmp/workspace");
    assert.equal(launched.options.env.HOME, fixture.userHome);
    assert.equal(launched.options.env.GROK_HOME, fixture.nativeHome);
    assert.equal(runtime.workspace, "/tmp/workspace");
    assert.equal(runtime.controlInstance, false);
    assert.equal(GROK_COMPAT_DISABLE_ENV.every(
      (key) => launched.options.env[key] === "false",
    ), true);
    assert.equal(launched.options.env.SECRET_TOKEN, undefined);
    assert.equal(runtime.runtimeAccountId, NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID);
    const workspaceShardId = grokBuildWorkspaceShardId({ workspace: "/tmp/workspace" });
    assert.equal(runtime.host.ledger.ledgerPath, path.join(
      fixture.paths.stateDir,
      "runtime-ledgers",
      "grok-build",
      "grok-main",
      workspaceShardId,
      "runtime-ledger.json",
    ));
    assert.equal(
      path.relative(launched.options.env.GROK_HOME, runtime.host.ledger.ledgerPath)
        .startsWith(`..${path.sep}`),
      true,
    );

    const models = await runtime.modelsList({ limit: 100 });
    assert.deepEqual(models, {
      data: [
        { model: "grok-4.6", displayName: "Grok 4.6", description: "default", isDefault: true, hidden: false },
        { model: "grok-4.5", displayName: "Grok 4.5", description: "", isDefault: false, hidden: false },
      ],
      nextCursor: null,
    });
    const started = await startSession(runtime);
    assert.equal(started.session.id, "session-1");
    assert.equal(mcpContexts[0].operation, "session.start");
    assert.equal(mcpContexts[0].runtime, "grok-build");
    assert.equal(mcpContexts[0].runtimeProfileId, "grok-main");
    assert.equal(mcpContexts[0].parentPid, launched.child.pid);
    assert.equal(mcpContexts[0].parentExecutable, fs.realpathSync(fixture.binaryPath));
    const newRequest = fixture.children[0].messages.find((item) => item.method === "session/new");
    assert.deepEqual(newRequest.params.mcpServers, [{
      ...descriptors[0], command: fs.realpathSync(descriptors[0].command),
    }]);
    assert.deepEqual(runtime.registeredSecrets, [gateNonce]);
    assert.deepEqual(newRequest.params._meta, { modelId: "grok-4.6" });

    const events = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    const image = require("./fixtures/native-chat-image.cjs")(fixture.paths.trustedRoot);
    const turn = await runtime.turnStart({
      sessionId: "session-1",
      operationId: "operation-1",
      prompt: "Please work",
      attachments: [image],
      context: "Earlier context",
      model: "grok-4.6",
      cwd: "/tmp/workspace",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.match(turn.turn.id, /^grok-turn-/u);
    await waitFor(
      () => events.find((event) => event.type === "complete"),
      "normalized completion",
    );
    assert.equal(events.every((event) => event.known === true), true);
    assert.deepEqual(fixture.children[0].messages.find(item => item.method === "session/prompt").params.prompt[1],
      { type: "image", mimeType: image.mimeType, data: image.data });
    assert.equal(events.find((event) => event.type === "text_delta")?.delta, "done");
    assert.deepEqual(events.find((event) => event.type === "tool_start")?.tool, {
      kind: "search",
      name: "Web search:",
      status: "in_progress",
      input: { variant: "WebSearch", backend: true },
    });
    assert.deepEqual(events.find((event) => event.type === "tool_result")?.tool, {
      kind: "search",
      name: "Web search:",
      status: "completed",
      success: true,
      input: { query: "native agent trajectory" },
      output: {
        action: {
          type: "search",
          query: "native agent trajectory",
          sources: [{ type: "url", url: "https://example.com/result" }],
        },
        status: "completed",
      },
    });
    assert.deepEqual(events.find((event) => event.toolCallId === "terminal-1"
      && event.type === "tool_result")?.tool, {
      status: "completed",
      success: true,
      output: { status: "completed", output: "/tmp/workspace" },
    });
    const prompt = fixture.children[0].messages.find((item) => item.method === "session/prompt");
    assert.match(prompt.params.prompt[0].text, /SHOGGOTH DEVELOPER INSTRUCTIONS/u);
    assert.match(prompt.params.prompt[0].text, /CURRENT USER REQUEST\nPlease work/u);
    const read = await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
    assert.deepEqual(read.session.turns[0].items.map((item) => item.type), [
      "userMessage", "agentMessage",
    ]);
    assert.equal(read.session.turns[0].items[0].clientId, "operation-1");
    assert.equal(read.session.turns[0].items[1].text, "done");
    assert.equal(read.session.turns[0].status, "completed");
    assert.equal(promptIds.length, 1);

    await runtime.sessionRename({ sessionId: "session-1", name: "Renamed" });
    await runtime.sessionArchive({ sessionId: "session-1" });
    assert.equal((await runtime.sessionList({ archived: true })).data[0].name, "Renamed");
    await runtime.sessionUnarchive({ sessionId: "session-1" });
    await runtime.sessionResume({
      sessionId: "session-1",
      developerInstructions: "Continue safely.",
      model: "grok-4.5",
      cwd: "/tmp/workspace",
    });
    assert.equal(fixture.children[0].messages.some((item) => item.method === "session/resume"), true);
    assert.equal(mcpContexts.length, 2);
    assert.equal(mcpContexts[1].operation, "session.resume");
    const resumeRequest = fixture.children[0].messages.find((item) => item.method === "session/resume");
    assert.deepEqual(resumeRequest.params.mcpServers, [{
      ...descriptors[1], command: fs.realpathSync(descriptors[1].command),
    }]);
    assert.notDeepEqual(descriptors[0], descriptors[1]);
    await assert.rejects(
      runtime.sessionDelete({ sessionId: "session-1" }),
      (error) => error.code === "RUNTIME_CAPABILITY_UNSUPPORTED",
    );
    assert.equal((await runtime.sessionList()).data.length, 1);
    unsubscribe();
    await fixture.adapter.stopAll();
    assert.equal(fixture.children[0].closed, true);
  } finally {
    fixture.cleanup();
  }
});

test("ACP command catalog is session-scoped and recognized commands bypass prompt wrapping", async () => {
  const prompts = [];
  const server = standardServer((message, child) => {
    if (message.method !== "session/prompt") return undefined;
    prompts.push(message.params.prompt[0].text);
    setImmediate(() => {
      child.sendNotification("session/update", {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "command-output",
          content: { type: "text", text: "done" },
        },
      });
      child.sendResult(message.id, { stopReason: "end_turn" });
    });
    return NO_RESPONSE;
  });
  const fixture = fixtureOptions(server);
  try {
    const runtime = await acquire(fixture);
    assert.equal(runtime.capabilities["commands.list"], true);
    assert.equal(runtime.capabilities["commands.execute"], true);
    const bootstrapCommands = await runtime.commandsList();
    assert.equal(bootstrapCommands.reason, null);
    assert.deepEqual(bootstrapCommands.commands.filter((command) => command.execution === "runtime")
      .map((command) => command.name), [
      "compact", "context", "review", "skills",
    ]);
    assert.equal(bootstrapCommands.commands.find((command) => command.name === "theme").execution, "cli");
    await assert.rejects(runtime.commandExecute({ sessionId: null, text: "/theme" }),
      { code: "RUNTIME_COMMAND_CLI_ONLY" });
    const started = await startSession(runtime, "chat:commands");
    fixture.children[0].sendNotification("session/update", {
      sessionId: started.session.id,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{
          name: "memory", description: "Manage project memory", input: { hint: "[action]" },
        }],
      },
    });
    await waitFor(async () => (
      (await runtime.commandsList({ sessionId: started.session.id })).commands[0]?.name === "memory"
    ), "ACP command catalog");
    assert.deepEqual(await runtime.commandExecute({
      sessionId: started.session.id, text: "/memory list",
    }), { kind: "send", text: "/memory list", warning: null });
    assert.equal((await runtime.commandsList()).commands.some((command) => command.name === "memory" && command.execution === "runtime"), false,
      "an ACP session update must not become another draft session's catalog");
    await assert.rejects(runtime.commandExecute({
      sessionId: started.session.id, text: "/not-real",
    }), (error) => error.code === "RUNTIME_COMMAND_NOT_FOUND");
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "operation-command",
      prompt: "/memory list",
      context: "must not wrap native command",
      model: "grok-4.6",
      cwd: "/tmp/workspace",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    await waitFor(() => prompts.length === 1, "native command prompt");
    assert.deepEqual(prompts, ["/memory list"]);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("spawn PATH includes the real user's local bin while retaining native HOME", async () => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-path-home-"));
  const fixture = fixtureOptions(standardServer(), {
    homedir: realHome,
    parentEnv: { HOME: realHome, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  try {
    const runtime = await acquire(fixture);
    const env = fixture.spawns[0].options.env;
    assert.equal(env.HOME, fixture.userHome);
    assert.equal(env.GROK_HOME, fixture.nativeHome);
    assert.equal(env.PATH.split(path.delimiter).includes(
      path.join(realHome, ".local", "bin"),
    ), true);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
    fs.rmSync(realHome, { recursive: true, force: true });
  }
});

test("system proxy resolver selects the first safe candidate without inheriting parent proxy state", async () => {
  const resolvedUrls = [];
  const fixture = fixtureOptions(standardServer(), {
    parentEnv: {
      HOME: os.homedir(),
      PATH: "/usr/bin:/bin",
      HTTP_PROXY: "http://parent-proxy.invalid:8080",
      HTTPS_PROXY: "http://parent-proxy.invalid:8080",
      ALL_PROXY: "socks5://parent-proxy.invalid:1080",
      NO_PROXY: "parent-only.invalid",
      SECRET_TOKEN: "must-not-leak",
    },
    async resolveProxy(url) {
      resolvedUrls.push(url);
      return "PROXY user:secret@unsafe.invalid:8080; SOCKS5 [::1]:7897; DIRECT";
    },
  });
  try {
    await acquire(fixture);
    assert.deepEqual(resolvedUrls, ["https://cli-chat-proxy.grok.com/v1/responses"]);
    const env = fixture.spawns[0].options.env;
    assert.equal(env.ALL_PROXY, "socks5://[::1]:7897");
    assert.equal(env.all_proxy, "socks5://[::1]:7897");
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1,.local");
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1,.local");
    assert.equal(env.SECRET_TOKEN, undefined);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("DIRECT proxy resolution never falls back to parent proxy variables", async () => {
  const fixture = fixtureOptions(standardServer(), {
    parentEnv: {
      HOME: os.homedir(),
      PATH: "/usr/bin:/bin",
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      ALL_PROXY: "socks5://127.0.0.1:7897",
      NO_PROXY: "parent-only.invalid",
    },
    resolveProxy: async () => "DIRECT; PROXY 127.0.0.1:7897",
  });
  try {
    await acquire(fixture);
    const env = fixture.spawns[0].options.env;
    for (const name of [
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
    ]) assert.equal(env[name], undefined);
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1,.local");
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1,.local");
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("resolver failure falls back only to validated proxy variables", async () => {
  const fixture = fixtureOptions(standardServer(), {
    parentEnv: {
      HOME: os.homedir(),
      PATH: "/usr/bin:/bin",
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://user:password@unsafe.invalid:8443",
      ALL_PROXY: "socks5h://127.0.0.1:7897",
      NO_PROXY: "example.test, .internal.test",
      http_proxy: "http://127.0.0.1:7898",
      https_proxy: "https://127.0.0.1:7899",
      all_proxy: "socks4://127.0.0.1:1080",
      no_proxy: "localhost,127.0.0.1",
      SECRET_TOKEN: "must-not-leak",
      OTHER_ENV: "must-not-leak-either",
    },
    resolveProxy: async () => { throw new Error("proxy resolver unavailable"); },
  });
  try {
    await acquire(fixture);
    const env = fixture.spawns[0].options.env;
    assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7897");
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.ALL_PROXY, "socks5h://127.0.0.1:7897");
    assert.equal(env.http_proxy, "http://127.0.0.1:7898");
    assert.equal(env.https_proxy, "https://127.0.0.1:7899");
    assert.equal(env.all_proxy, "socks4://127.0.0.1:1080");
    assert.equal(
      env.NO_PROXY,
      "localhost,127.0.0.1,::1,.local,example.test,.internal.test",
    );
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1,.local");
    assert.equal(env.SECRET_TOKEN, undefined);
    assert.equal(env.OTHER_ENV, undefined);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("a stalled proxy resolver times out into the validated parent fallback", async () => {
  const fixture = fixtureOptions(standardServer(), {
    initializeTimeoutMs: 10,
    parentEnv: {
      HOME: os.homedir(), PATH: "/usr/bin:/bin", HTTPS_PROXY: "http://127.0.0.1:7897",
    },
    resolveProxy: () => new Promise(() => {}),
  });
  try {
    await acquire(fixture);
    assert.equal(fixture.spawns[0].options.env.HTTPS_PROXY, "http://127.0.0.1:7897");
    assert.equal(fixture.spawns[0].options.env.NO_PROXY, "localhost,127.0.0.1,::1,.local");
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("stop and stopAll fence a pending proxy resolver before process spawn", async () => {
  for (const mode of ["stop", "stopAll"]) {
    let releaseProxy;
    let resolverStarted = false;
    const fixture = fixtureOptions(standardServer(), {
      resolveProxy() {
        resolverStarted = true;
        return new Promise((resolve) => { releaseProxy = resolve; });
      },
    });
    try {
      const acquiring = acquire(fixture);
      acquiring.catch(() => {});
      await waitFor(() => resolverStarted, `${mode} pending proxy resolver`);
      const stopping = mode === "stopAll"
        ? fixture.adapter.stopAll()
        : fixture.adapter.stop(binding());
      assert.equal(fixture.spawns.length, 0);
      assert.equal(fixture.children.length, 0);
      releaseProxy("DIRECT");
      await stopping;
      await assert.rejects(
        acquiring,
        (error) => error.code === "RUNTIME_HOST_TERMINATED",
      );
      assert.equal(fixture.spawns.length, 0);
      assert.equal(fixture.children.length, 0);
      assert.equal(fixture.pool.entries.size, 0);
    } finally {
      fixture.cleanup();
    }
  }
});

test("parent proxy fallback rejects zero or invalid ports, CRLF, credentials, and oversized URLs", async () => {
  const fixture = fixtureOptions(standardServer(), {
    parentEnv: {
      HOME: os.homedir(),
      PATH: "/usr/bin:/bin",
      HTTP_PROXY: "http://127.0.0.1:0",
      HTTPS_PROXY: "http://127.0.0.1:65536",
      ALL_PROXY: `socks5://${"a".repeat(4096)}:1080`,
      http_proxy: "http://127.0.0.1:7897\r\nX-Injected: yes",
      https_proxy: "https://[::1]:0",
      all_proxy: "socks5://user:password@127.0.0.1:1080",
    },
    resolveProxy: async () => { throw new Error("proxy resolver unavailable"); },
  });
  try {
    await acquire(fixture);
    const env = fixture.spawns[0].options.env;
    for (const name of [
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
    ]) assert.equal(env[name], undefined);
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1,.local");
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1,.local");
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("Electron proxy families map to bounded credential-free process environment", async () => {
  const cases = [
    {
      resolution: "PROXY unsafe.invalid:0; PROXY 127.0.0.1:7897",
      names: ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"],
      value: "http://127.0.0.1:7897",
    },
    {
      resolution: "HTTPS unsafe.invalid:65536; HTTPS proxy.example.test:8443",
      names: ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"],
      value: "https://proxy.example.test:8443",
    },
    {
      resolution: "SOCKS bad_host:1080; SOCKS proxy.example.test:1080",
      names: ["ALL_PROXY", "all_proxy"],
      value: "socks5://proxy.example.test:1080",
    },
    {
      resolution: "SOCKS4 proxy.example.test:1081",
      names: ["ALL_PROXY", "all_proxy"],
      value: "socks4://proxy.example.test:1081",
    },
  ];
  for (const current of cases) {
    const fixture = fixtureOptions(standardServer(), {
      resolveProxy: async () => current.resolution,
    });
    try {
      await acquire(fixture);
      const env = fixture.spawns[0].options.env;
      for (const name of current.names) assert.equal(env[name], current.value);
      assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1,.local");
      assert.equal(env.no_proxy, "localhost,127.0.0.1,::1,.local");
      await fixture.adapter.stopAll();
    } finally {
      fixture.cleanup();
    }
  }
});

test("unsafe or oversized resolved proxies fail closed without environment injection", async () => {
  const unsafeResolutions = [
    "PROXY user:password@unsafe.invalid:8080",
    "PROXY bad_host:8080",
    "PROXY 127.0.0.1:0",
    "PROXY 127.0.0.1:65536",
    "PROXY 127.0.0.1:7897\r\nDIRECT",
    "PROXY 127.0.0.1:7897\0DIRECT",
    `PROXY ${"a".repeat(17 * 1024)}:8080`,
  ];
  for (const resolution of unsafeResolutions) {
    const fixture = fixtureOptions(standardServer(), {
      parentEnv: {
        HOME: os.homedir(), PATH: "/usr/bin:/bin", SECRET_TOKEN: "must-not-leak",
      },
      resolveProxy: async () => resolution,
    });
    try {
      await acquire(fixture);
      const env = fixture.spawns[0].options.env;
      for (const name of [
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
      ]) assert.equal(env[name], undefined);
      assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1,.local");
      assert.equal(env.no_proxy, "localhost,127.0.0.1,::1,.local");
      assert.equal(env.SECRET_TOKEN, undefined);
      await fixture.adapter.stopAll();
    } finally {
      fixture.cleanup();
    }
  }
});

test("repeated MCP descriptors replace one-shot secrets without exhausting the host budget", async () => {
  const fixture = fixtureOptions(standardServer(), {
    spawnEnv: { SERVICE_TOKEN: "persistent-service-secret" },
  });
  const helper = path.join(fixture.paths.trustedRoot, "mcp-helper-rotation");
  fs.writeFileSync(helper, "#!/bin/sh\n", { mode: 0o700 });
  let descriptorSequence = 0;
  try {
    const runtime = await acquire(fixture, {
      createMcpServer() {
        descriptorSequence += 1;
        return {
          name: "shoggoth-controlled",
          command: helper,
          args: [],
          env: [{
            name: "SHOGGOTH_RUNTIME_MCP_GATE_NONCE",
            value: `gate-nonce-${String(descriptorSequence).padStart(4, "0")}`,
          }],
        };
      },
    });
    const started = await startSession(runtime, "chat:secret-rotation");
    const firstNonce = "gate-nonce-0001";
    for (let index = 0; index < 300; index += 1) {
      await runtime.sessionResume({
        sessionId: started.session.id,
        developerInstructions: "Continue safely.",
        model: null,
        cwd: "/tmp/workspace",
      });
    }
    assert.equal(descriptorSequence, 301);
    assert.deepEqual(runtime.registeredSecrets, [
      "persistent-service-secret",
      "gate-nonce-0301",
    ]);
    assert.equal(runtime.registeredSecrets.includes(firstNonce), false);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("ACP permission options retain distinct scopes and return the exact selected optionId", async () => {
  const reverseResponses = [];
  const prompts = [];
  const server = standardServer((message, child) => {
    if (message.method === "session/prompt") {
      prompts.push(message);
      const index = prompts.length;
      setImmediate(() => child.send({
        jsonrpc: "2.0",
        id: `permission-${index}`,
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: {
            toolCallId: `tool-${index}`,
            kind: index === 1 ? "execute" : "edit",
            title: index === 1 ? "Run tests" : "Edit file",
            rawInput: { command: "npm test" },
          },
          options: [
            { optionId: `once-${index}`, name: "Once", kind: "allow_once" },
            { optionId: "allow_always_mcp_tool", name: "Always allow this tool", kind: "allow_always" },
            { optionId: "allow_always_mcp_server", name: "Always allow this server", kind: "allow_always" },
            { optionId: `reject-${index}`, name: "Reject", kind: "reject_once" },
          ],
        },
      }));
      return NO_RESPONSE;
    }
    if (typeof message.id === "string" && message.id.startsWith("permission-")) {
      reverseResponses.push(message);
      const prompt = prompts[Number(message.id.split("-")[1]) - 1];
      child.sendResult(prompt.id, { stopReason: "end_turn" });
      return NO_RESPONSE;
    }
    return undefined;
  });
  const fixture = fixtureOptions(server);
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const approvals = [];
    runtime.registerServerRequestHandler("item/commandExecution/requestApproval", async (params) => {
      approvals.push(["command", params]);
      return { decision: "accept", approvalChoice: "runtime:2" };
    });
    runtime.registerServerRequestHandler("item/fileChange/requestApproval", async (params) => {
      approvals.push(["file", params]);
      return { decision: "decline" };
    });
    const first = await runtime.turnStart({
      sessionId: "session-1", operationId: "permission-op-1", prompt: "one",
    });
    await waitFor(() => reverseResponses.length === 1, "allow permission response");
    const second = await runtime.turnStart({
      sessionId: "session-1", operationId: "permission-op-2", prompt: "two",
    });
    await waitFor(() => reverseResponses.length === 2, "deny permission response");
    assert.notEqual(first.turn.id, second.turn.id);
    assert.deepEqual(reverseResponses.map((message) => message.result), [
      { outcome: { outcome: "selected", optionId: "allow_always_mcp_server" } },
      { outcome: { outcome: "selected", optionId: "reject-2" } },
    ]);
    assert.deepEqual(approvals.map(([kind]) => kind), ["command", "file"]);
    assert.equal(approvals[0][1].turnId, first.turn.id);
    assert.equal(approvals[0][1].sessionApprovalAvailable, false);
    assert.deepEqual(approvals[0][1].approvalOptions, [
      { choice: "once", label: "Once", kind: "allow_once" },
      { choice: "runtime:1", label: "Always allow this tool", kind: "allow_always", scope: "tool" },
      { choice: "runtime:2", label: "Always allow this server", kind: "allow_always", scope: "server" },
      { choice: "deny", label: "Reject", kind: "reject_once" },
    ]);
    assert.deepEqual(approvals[0][1].toolInput, { command: "npm test" });
    assert.equal(approvals[1][1].sessionApprovalAvailable, false);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("ACP permission responses reject ambiguous, unoffered, or mismatched choices", async () => {
  const responses = [];
  const prompts = [];
  const cases = [
    { decision: "acceptForSession" },
    { decision: "accept", approvalChoice: "runtime:31" },
    { decision: "decline", approvalChoice: "runtime:1" },
    { decision: "accept", approvalChoice: "runtime:1" },
  ];
  const server = standardServer((message, child) => {
    if (message.method === "session/prompt") {
      prompts.push(message);
      setImmediate(() => child.send({ jsonrpc: "2.0", id: `scope-${prompts.length}`,
        method: "session/request_permission", params: {
          sessionId: message.params.sessionId,
          toolCall: { toolCallId: `scope-tool-${prompts.length}`, kind: "execute", title: "Run tests" },
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow_always_mcp_tool", name: "Always allow this tool", kind: "allow_always" },
            { optionId: "__proto__", name: "Custom remembered scope", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      }));
      return NO_RESPONSE;
    }
    if (typeof message.id === "string" && message.id.startsWith("scope-") && !message.method) {
      responses.push(message.result);
      child.sendResult(prompts[responses.length - 1].id, { stopReason: "end_turn" });
      return NO_RESPONSE;
    }
    return undefined;
  });
  const fixture = fixtureOptions(server);
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    let decisionIndex = 0;
    runtime.registerServerRequestHandler("item/commandExecution/requestApproval", async (params) => {
      assert.deepEqual(params.approvalOptions[2], {
        choice: "runtime:2", label: "Custom remembered scope", kind: "allow_always",
      }, "unknown option ids must not inherit an invented scope");
      return cases[decisionIndex++];
    });
    for (let index = 0; index < cases.length; index++) {
      await runtime.turnStart({ sessionId: "session-1", operationId: `scope-op-${index}`, prompt: "test scope" });
      await waitFor(() => responses.length === index + 1, "permission scope result");
    }
    assert.deepEqual(responses, [
      ...Array.from({ length: 3 }, () => ({ outcome: { outcome: "cancelled" } })),
      { outcome: { outcome: "selected", optionId: "allow_always_mcp_tool" } },
    ]);
    await fixture.adapter.stopAll();
  } finally { fixture.cleanup(); }
});

test("ACP permission wait pauses both reverse-request and active prompt deadlines", async () => {
  let prompt;
  let resolveDecision;
  let approvalCalls = 0;
  const reverseResponses = [];
  const server = standardServer((message, child) => {
    if (message.method === "session/prompt") {
      prompt = message;
      setImmediate(() => child.send({
        jsonrpc: "2.0",
        id: "permission-unbounded",
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: {
            toolCallId: "tool-unbounded",
            kind: "execute",
            title: "Run a long-approved command",
            rawInput: { command: "npm test" },
          },
          options: [
            { optionId: "once", name: "Once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      }));
      return NO_RESPONSE;
    }
    if (message.id === "permission-unbounded" && !message.method) {
      reverseResponses.push(message);
      child.sendResult(prompt.id, { stopReason: "end_turn" });
      return NO_RESPONSE;
    }
    return undefined;
  });
  const fixture = fixtureOptions(server, { promptTimeoutMs: 100, serverRequestTimeoutMs: 100 });
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const completions = [];
    runtime.subscribe((event) => {
      if (event.type === "complete") completions.push(event);
    });
    runtime.registerServerRequestHandler("item/commandExecution/requestApproval", async () => {
      approvalCalls += 1;
      return new Promise((resolve) => { resolveDecision = resolve; });
    });
    await runtime.turnStart({
      sessionId: "session-1", operationId: "permission-unbounded-op", prompt: "wait for approval",
    });
    await waitFor(() => approvalCalls === 1, "unbounded permission handler");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(reverseResponses.length, 0);
    assert.equal(completions.length, 0);
    resolveDecision({ decision: "accept" });
    await waitFor(() => reverseResponses.length === 1, "permission response after long wait");
    await waitFor(() => completions.length === 1, "prompt completion after approval");
    assert.deepEqual(reverseResponses[0].result, {
      outcome: { outcome: "selected", optionId: "once" },
    });
    assert.equal(completions[0].status, "completed");
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("turn interrupt sends ACP cancel and reconciles a canceled local turn", async () => {
  let prompt;
  let releaseCancel;
  let cancelSeenResolve;
  const cancelSeen = new Promise((resolve) => { cancelSeenResolve = resolve; });
  const server = standardServer((message, child) => {
    if (message.method === "session/prompt") {
      prompt = message;
      setImmediate(() => child.sendNotification("session/update", {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      }));
      return NO_RESPONSE;
    }
    if (message.method === "session/cancel" && prompt) {
      cancelSeenResolve();
      releaseCancel = () => child.sendResult(prompt.id, { stopReason: "cancelled" });
    }
    return undefined;
  });
  const fixture = fixtureOptions(server);
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const completion = [];
    runtime.subscribe((event) => {
      if (event.type === "complete") completion.push(event);
    });
    const started = await runtime.turnStart({
      sessionId: "session-1", operationId: "cancel-op", prompt: "long task",
    });
    let interruptSettled = false;
    const interrupt = runtime.turnInterrupt({ sessionId: "session-1", turnId: started.turn.id });
    void interrupt.then(
      () => { interruptSettled = true; },
      () => { interruptSettled = true; },
    );
    await cancelSeen;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(interruptSettled, false);
    releaseCancel();
    await interrupt;
    await waitFor(() => completion.length === 1, "canceled completion");
    assert.equal(completion[0].status, "canceled");
    const read = await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
    assert.equal(read.session.turns[0].status, "canceled");
    assert.equal(fixture.children[0].messages.some((item) => item.method === "session/cancel"), true);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("turn interrupt does not acknowledge a normal end_turn as cancellation", async () => {
  let prompt;
  const server = standardServer((message, child) => {
    if (message.method === "session/prompt") {
      prompt = message;
      setImmediate(() => child.sendNotification("session/update", {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "finishing" },
        },
      }));
      return NO_RESPONSE;
    }
    if (message.method === "session/cancel" && prompt) {
      child.sendResult(prompt.id, { stopReason: "end_turn" });
    }
    return undefined;
  });
  const fixture = fixtureOptions(server);
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const started = await runtime.turnStart({
      sessionId: "session-1", operationId: "end-before-cancel", prompt: "finish",
    });
    await assert.rejects(
      runtime.turnInterrupt({ sessionId: "session-1", turnId: started.turn.id }),
      (error) => error.code === "RUNTIME_TURN_CANCEL_NOT_CONFIRMED",
    );
    const read = await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
    assert.equal(read.session.turns[0].status, "completed");
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("turn interrupt does not acknowledge transport loss as cancellation", async () => {
  const server = standardServer((message, child) => {
    if (message.method === "session/prompt") {
      setImmediate(() => child.sendNotification("session/update", {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "accepted" },
        },
      }));
      return NO_RESPONSE;
    }
    if (message.method === "session/cancel") child.closeProcess();
    return undefined;
  });
  const fixture = fixtureOptions(server);
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const started = await runtime.turnStart({
      sessionId: "session-1", operationId: "transport-loss-cancel", prompt: "stop",
    });
    await assert.rejects(
      runtime.turnInterrupt({ sessionId: "session-1", turnId: started.turn.id }),
      (error) => typeof error.code === "string" && error.code !== "RUNTIME_TURN_CANCEL_NOT_CONFIRMED",
    );
    await assert.rejects(runtime.terminated);
    const receipt = runtime.host.ledger.snapshot().sessions[0].turns[0];
    assert.notEqual(receipt.status, "canceled");
  } finally {
    fixture.cleanup();
  }
});

test("operationId is durable idempotency: duplicates never replay and conflicts fail", async () => {
  let promptCount = 0;
  const server = standardServer((message, child) => {
    if (message.method === "session/prompt") {
      promptCount += 1;
      setImmediate(() => {
        child.sendNotification("session/update", {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ok" },
          },
        });
        child.sendResult(message.id, { stopReason: "end_turn" });
      });
      return NO_RESPONSE;
    }
    return undefined;
  });
  const fixture = fixtureOptions(server);
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const input = {
      sessionId: "session-1", operationId: "same-operation", prompt: "same prompt",
    };
    const first = await runtime.turnStart(input);
    await waitFor(async () => {
      const read = await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
      return read.session.turns[0].status === "completed";
    }, "completed receipt");
    const duplicate = await runtime.turnStart(input);
    assert.equal(duplicate.turn.id, first.turn.id);
    assert.equal(promptCount, 1);
    await assert.rejects(
      runtime.turnStart({ ...input, prompt: "different prompt" }),
      (error) => error.code === "RUNTIME_OPERATION_CONFLICT",
    );
    assert.equal(promptCount, 1);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

for (const queued of [true, false]) {
  test(`native ${queued ? "queued" : "running"} receipt accepts a quiet prompt before model output`, async () => {
    let prompt;
    const fixture = fixtureOptions(standardServer((message, child) => {
      if (message.method !== "session/prompt") return undefined;
      prompt = message;
      const text = message.params.prompt[0].text;
      child.sendNotification("_x.ai/queue/changed", {
        sessionId: message.params.sessionId,
        entries: queued ? [{ id: "native-prompt-1", version: 0, kind: "prompt", text, position: 0 }] : [],
        ...(queued ? {} : { runningPromptId: "native-prompt-1", runningText: text, runningKind: "prompt" }),
      });
      return NO_RESPONSE;
    }), { acceptanceTimeoutMs: 20 });
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      const runtime = await acquire(fixture);
      await startSession(runtime);
      const input = { sessionId: "session-1", operationId: "quiet-operation", prompt: "think first" };
      const turn = await runtime.turnStart(input);
      await new Promise((resolve) => setTimeout(resolve, 45));
      const read = await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
      assert.equal(read.session.turns[0].status, "inProgress");
      assert.equal(fixture.children[0].messages.some((item) => item.method === "session/cancel"), false);
      assert.equal((await runtime.turnStart(input)).turn.id, turn.turn.id);
      assert.equal(fixture.children[0].messages.filter((item) => item.method === "session/prompt").length, 1);
      fixture.children[0].sendResult(prompt.id, { stopReason: "end_turn" });
      await waitFor(() => runtime.host.activeTurns.size === 0, "quiet prompt completion");
      await fixture.adapter.stopAll();
    } finally {
      clearTimeout(keepAlive);
      fixture.cleanup();
    }
  });
}

test("native failure categories require the exact prompt receipt and survive session reads", async () => {
  const cases = [
    ["native-current", "API error (status 402 Payment Required): Grok Build usage balance exhausted", "RUNTIME_QUOTA_EXHAUSTED"],
    ["native-stale", "API error (status 402 Payment Required): Grok Build usage balance exhausted", "GROK_BUILD_TURN_FAILED"],
    ["native-current", "User account is blocked", "RUNTIME_ACCOUNT_BLOCKED"],
    ["native-current", "API error (status 429 Too Many Requests): rate limit exceeded", "RUNTIME_RATE_LIMITED"],
    ["native-current", "Unexpected upstream error", "GROK_BUILD_TURN_FAILED"],
  ];
  for (const [promptId, diagnostic, expectedCode] of cases) {
    const fixture = fixtureOptions(standardServer((message, child) => {
      if (message.method !== "session/prompt") return undefined;
      child.sendNotification("_x.ai/queue/changed", { sessionId: message.params.sessionId,
        entries: [{ id: "native-current", kind: "prompt", text: message.params.prompt[0].text }] });
      child.sendNotification("_x.ai/session/update", { sessionId: message.params.sessionId,
        update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "error", agent_result: diagnostic } });
      return { stopReason: "refusal" };
    }));
    try {
      const runtime = await acquire(fixture);
      await startSession(runtime);
      await runtime.turnStart({ sessionId: "session-1", operationId: "failure-check", prompt: "check" });
      await waitFor(() => runtime.host.activeTurns.size === 0, "failure completion");
      const { session } = await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
      assert.equal(session.turns[0].status, "failed");
      assert.equal(session.turns[0].errorCode, expectedCode);
      assert.equal(JSON.stringify(session).includes(diagnostic), false);
      await fixture.adapter.stopAll();
    } finally { fixture.cleanup(); }
  }
});

test("native queue receipts must match the active session and exact prompt unambiguously", async () => {
  const fixture = fixtureOptions(standardServer((message, child) => {
    if (message.method !== "session/prompt") return undefined;
    const sessionId = message.params.sessionId;
    const text = message.params.prompt[0].text;
    const entry = { id: "native-current", kind: "prompt", text, version: 0, position: 0 };
    for (const params of [
      null,
      { sessionId, entries: "invalid" },
      { sessionId: "another-session", entries: [entry] },
      { sessionId, entries: [{ ...entry, text: "different prompt" }] },
      { sessionId, entries: [{ ...entry, kind: "task" }] },
      { sessionId, entries: [{ ...entry, id: "" }] },
      { sessionId, entries: [entry, { ...entry, id: "ambiguous" }] },
      { sessionId, entries: [], runningPromptId: "native-current", runningKind: "task", runningText: text },
    ]) child.sendNotification("_x.ai/queue/changed", params);
    return NO_RESPONSE;
  }), { acceptanceTimeoutMs: 20 });
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    await assert.rejects(runtime.turnStart({
      sessionId: "session-1", operationId: "unmatched-queue", prompt: "current prompt",
    }), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    assert.equal(runtime.host.state, "ready");
    await fixture.adapter.stopAll();
  } finally {
    clearTimeout(keepAlive);
    fixture.cleanup();
  }
});

test("a stale native prompt id cannot accept a later identical prompt", async () => {
  let promptCount = 0;
  let secondPrompt;
  const fixture = fixtureOptions(standardServer((message, child) => {
    if (message.method !== "session/prompt") return undefined;
    promptCount += 1;
    const params = {
      sessionId: message.params.sessionId, entries: [], runningPromptId: "old-native-prompt",
      runningKind: "prompt", runningText: message.params.prompt[0].text,
    };
    child.sendNotification("_x.ai/queue/changed", params);
    if (promptCount === 1) return rpcResult({ stopReason: "end_turn" });
    secondPrompt = message;
    return NO_RESPONSE;
  }), { acceptanceTimeoutMs: 100 });
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const input = { sessionId: "session-1", operationId: "first", prompt: "same words" };
    await runtime.turnStart(input);
    await waitFor(() => runtime.host.activeTurns.size === 0, "first prompt completion");
    let accepted = false;
    const second = runtime.turnStart({ ...input, operationId: "second" }).then((result) => {
      accepted = true;
      return result;
    });
    await waitFor(() => secondPrompt, "second prompt submission");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(accepted, false);
    fixture.children[0].sendNotification("_x.ai/queue/changed", {
      sessionId: "session-1", entries: [], runningPromptId: "new-native-prompt",
      runningKind: "prompt", runningText: secondPrompt.params.prompt[0].text,
    });
    await second;
    fixture.children[0].sendResult(secondPrompt.id, { stopReason: "end_turn" });
    await waitFor(() => runtime.host.activeTurns.size === 0, "second prompt completion");
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("unproven prompt acceptance ignores auxiliary updates, remains unknown, and never replays", async () => {
  let promptCount = 0;
  const fixture = fixtureOptions(standardServer((message, child) => {
    if (message.method === "session/prompt") {
      promptCount += 1;
      setImmediate(() => child.sendNotification("session/update", {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: "usage_update", used: 1, size: 100 },
      }));
      return NO_RESPONSE;
    }
    return undefined;
  }), { acceptanceTimeoutMs: 20 });
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const input = {
      sessionId: "session-1", operationId: "unknown-operation", prompt: "maybe accepted",
    };
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      await assert.rejects(
        runtime.turnStart(input),
        (error) => error.code === "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
      );
    } finally {
      clearTimeout(keepAlive);
    }
    await assert.rejects(
      runtime.turnStart(input),
      (error) => error.code === "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
    );
    await assert.rejects(
      runtime.sessionRead({ sessionId: "session-1", includeTurns: true }),
      (error) => error.code === "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
    );
    assert.equal(promptCount, 1);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

for (const [stopReason, status] of [["cancelled", "canceled"], ["end_turn", "completed"]]) {
  test(`late ${stopReason} receipt releases a timed-out session without replay`, async () => {
    let firstPrompt;
    let promptCount = 0;
    const fixture = fixtureOptions(standardServer((message) => {
      if (message.method !== "session/prompt") return undefined;
      promptCount += 1;
      if (promptCount === 1) {
        firstPrompt = message;
        return NO_RESPONSE;
      }
      return rpcResult({ stopReason: "end_turn" });
    }), { acceptanceTimeoutMs: 20 });
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      const runtime = await acquire(fixture);
      await startSession(runtime);
      const input = {
        sessionId: "session-1", operationId: "slow-operation", prompt: "slow response",
      };
      const events = [];
      runtime.subscribe((event) => events.push(event));
      await assert.rejects(runtime.turnStart(input), {
        code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
      });
      await assert.rejects(runtime.turnStart({ ...input, operationId: "too-early" }), {
        code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
      });
      fixture.children[0].sendResult(firstPrompt.id, { stopReason });
      await waitFor(() => runtime.host.activeTurns.size === 0, "late terminal receipt");
      const read = await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
      assert.equal(read.session.turns[0].status, status);
      assert.equal(runtime.host.ledger.snapshot().sessions[0].turns[0].acceptance, "accepted");
      assert.equal(events.some((event) => event.type === "complete"), false,
        "the failed caller must not receive a second terminal event");
      const duplicate = await runtime.turnStart(input);
      assert.equal(duplicate.turn.status, status);
      assert.equal(promptCount, 1, "the timed-out operation must not replay");
      await runtime.sessionResume({ sessionId: "session-1", cwd: "/tmp/workspace" });
      await runtime.turnStart({ ...input, operationId: "next-operation" });
      await waitFor(() => runtime.host.activeTurns.size === 0, "next turn completion");
      assert.equal(promptCount, 2);
      await fixture.adapter.stop("grok-main");
      const restarted = await acquire(fixture);
      const restored = await restarted.sessionRead({ sessionId: "session-1", includeTurns: true });
      assert.equal(restored.session.turns[0].status, status);
      await restarted.turnStart(input);
      assert.equal(promptCount, 2, "the reconciled receipt must survive restart");
      await fixture.adapter.stopAll();
    } finally {
      clearTimeout(keepAlive);
      fixture.cleanup();
    }
  });
}

test("late explicit prompt rejection releases a timed-out session without replay", async () => {
  let firstPrompt;
  let promptCount = 0;
  const fixture = fixtureOptions(standardServer((message) => {
    if (message.method !== "session/prompt") return undefined;
    promptCount += 1;
    if (promptCount === 1) {
      firstPrompt = message;
      return NO_RESPONSE;
    }
    return rpcResult({ stopReason: "end_turn" });
  }), { acceptanceTimeoutMs: 20 });
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const input = {
      sessionId: "session-1", operationId: "rejected-operation", prompt: "rejected later",
    };
    await assert.rejects(runtime.turnStart(input), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    fixture.children[0].sendError(firstPrompt.id, { code: -32603, message: "request rejected" });
    await waitFor(() => runtime.host.activeTurns.size === 0, "late rejection receipt");
    const read = await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
    assert.equal(read.session.turns[0].status, "failed");
    await assert.rejects(runtime.turnStart(input), { code: "GROK_ACP_REMOTE_ERROR" });
    assert.equal(promptCount, 1);
    await runtime.turnStart({ ...input, operationId: "next-operation" });
    assert.equal(promptCount, 2);
    await fixture.adapter.stopAll();
  } finally {
    clearTimeout(keepAlive);
    fixture.cleanup();
  }
});

test("restart isolates unknown session acceptance without blocking confirmed sessions", async () => {
  let sessionNewCount = 0;
  const server = (message) => {
    if (message.method === "initialize") {
      return rpcResult(initializeResult({ authMethods: [], defaultAuthMethodId: null }));
    }
    if (message.method === "session/new") {
      sessionNewCount += 1;
      if (sessionNewCount === 2) return NO_RESPONSE;
      return rpcResult({ sessionId: sessionNewCount === 1 ? "session-confirmed" : "session-fresh" });
    }
    return NO_RESPONSE;
  };
  const fixture = fixtureOptions(server, { requestTimeoutMs: 25 });
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime, "chat:confirmed");
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      await assert.rejects(
        startSession(runtime, "chat:unknown"),
        (error) => error.code === "GROK_ACP_REQUEST_TIMEOUT",
      );
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(runtime.host.ledger.snapshot().pendingSessions.length, 1);

    await fixture.adapter.stop(binding());
    const restarted = await acquire(fixture);
    const afterRestart = await restarted.sessionList({ limit: 100 });
    assert.deepEqual(afterRestart.data.map((session) => session.source), ["chat:confirmed"]);
    await assert.rejects(
      startSession(restarted, "chat:unknown"),
      (error) => error.code === "RUNTIME_SESSION_ACCEPTANCE_UNKNOWN",
    );
    assert.equal(sessionNewCount, 2, "unknown source must not replay session/new");

    await startSession(restarted, "chat:fresh");
    const finalList = await restarted.sessionList({ limit: 100 });
    assert.deepEqual(
      finalList.data.map((session) => session.source),
      ["chat:confirmed", "chat:fresh"],
    );
    assert.equal(
      finalList.data.some((session) => session.source === "chat:unknown"),
      false,
      "unconfirmed remote session must never be projected as accepted",
    );
    assert.equal(sessionNewCount, 3);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("native auth state does not fake account DTOs and sessions fail with generic AUTH_REQUIRED", async () => {
  const server = (message) => {
    if (message.method === "initialize") {
      return rpcResult(initializeResult({ authMethodId: "grok.com" }));
    }
    return NO_RESPONSE;
  };
  const fixture = fixtureOptions(server);
  try {
    const runtime = await acquire(fixture);
    assert.deepEqual(runtime.authenticationState(), {
      authenticated: false,
      credentialPresent: false,
      methodId: "grok.com",
      methods: [{ id: "grok.com", name: "Grok authentication", type: "agent" }],
    });
    assert.equal(runtime.capabilities["account.read"], false);
    assert.equal(runtime.capabilities["account.login"], false);
    assert.equal(runtime.capabilities["account.logout"], false);
    assert.equal(typeof runtime.accountLoginStart, "undefined");
    await assert.rejects(
      startSession(runtime),
      (error) => error.code === "AUTH_REQUIRED",
    );
    assert.equal(fixture.children[0].messages.some((item) => item.method === "authenticate"), false);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("cached grok.com OAuth skips authenticate and account proof survives profile host restart", async () => {
  const authenticate = [];
  const server = (message) => {
    if (message.method === "initialize") {
      return rpcResult(initializeResult({
        authMethods: [
          { id: "device-code", name: "Device code", type: "terminal" },
          { id: "grok.com", name: "Grok" },
        ],
        defaultAuthMethodId: null,
      }));
    }
    if (message.method === "authenticate") {
      authenticate.push(message.params);
      return NO_RESPONSE;
    }
    if (message.method === "session/new") return rpcResult({ sessionId: "session-1" });
    if (message.method === "session/resume") return rpcResult({});
    return NO_RESPONSE;
  };
  const fixture = fixtureOptions(server, { initializeTimeoutMs: 25 });
  try {
    const runtimeHome = fixture.nativeHome;
    fs.writeFileSync(path.join(runtimeHome, "auth.json"), "cached", { mode: 0o600 });
    const runtime = await acquire(fixture);
    assert.deepEqual(authenticate, []);
    assert.deepEqual(runtime.authenticationState(), {
      authenticated: false,
      credentialPresent: true,
      methodId: null,
      methods: [
        { id: "device-code", name: "Device code", type: "terminal" },
        { id: "grok.com", name: "Grok", type: "agent" },
      ],
    });
    const started = await startSession(runtime);
    assert.equal(runtime.authenticationState().authenticated, true);
    assert.equal(runtime.authenticationState().credentialPresent, true);
    assert.deepEqual(authenticate, []);

    await fixture.adapter.stop(binding());
    const resumedRuntime = await acquire(fixture);
    assert.equal(resumedRuntime.authenticationState().authenticated, true);
    assert.equal(resumedRuntime.authenticationState().credentialPresent, true);
    await resumedRuntime.sessionResume({
      sessionId: started.session.id,
      cwd: "/tmp/workspace",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.equal(resumedRuntime.authenticationState().authenticated, true);
    assert.deepEqual(authenticate, []);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("AUTH_REQUIRED is scoped to one acquire and the next acquire rechecks the same host", async () => {
  let authenticateCount = 0;
  let sessionNewCount = 0;
  const server = (message) => {
    if (message.method === "initialize") {
      return rpcResult(initializeResult({
        authMethods: [{ id: "grok.com", name: "Grok" }],
        defaultAuthMethodId: null,
      }));
    }
    if (message.method === "authenticate") {
      authenticateCount += 1;
      return NO_RESPONSE;
    }
    if (message.method === "session/new") {
      sessionNewCount += 1;
      return sessionNewCount === 1
        ? rpcError(-32000, "login required")
        : rpcResult({ sessionId: `session-${sessionNewCount}` });
    }
    return NO_RESPONSE;
  };
  const fixture = fixtureOptions(server, { initializeTimeoutMs: 25 });
  try {
    const runtimeHome = fixture.nativeHome;
    fs.writeFileSync(path.join(runtimeHome, "auth.json"), "stale", { mode: 0o600 });
    const runtime = await acquire(fixture);
    assert.equal(authenticateCount, 0);
    assert.equal(runtime.authenticationState().authenticated, false);
    await assert.rejects(
      startSession(runtime),
      (error) => error.code === "AUTH_REQUIRED",
    );
    assert.equal(sessionNewCount, 1);
    assert.equal(runtime.authenticationState().authenticated, false);
    await assert.rejects(
      startSession(runtime),
      (error) => error.code === "AUTH_REQUIRED",
    );
    assert.equal(sessionNewCount, 1);
    const reacquired = await acquire(fixture);
    assert.equal(reacquired, runtime);
    const started = await startSession(reacquired);
    assert.equal(started.session.id, "session-2");
    assert.equal(sessionNewCount, 2);
    assert.equal(runtime.authenticationState().authenticated, true);
    assert.equal(fixture.spawns.length, 1);
    assert.equal(runtime.host.ledger.snapshot().pendingSessions.length, 0);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("a terminal login refreshes authentication on the next acquire without recycling the host", async () => {
  let authenticateCount = 0;
  const server = (message) => {
    if (message.method === "initialize") {
      return rpcResult(initializeResult({
        authMethods: [{ id: "grok.com", name: "Grok" }],
        defaultAuthMethodId: null,
      }));
    }
    if (message.method === "authenticate") {
      authenticateCount += 1;
      return NO_RESPONSE;
    }
    if (message.method === "session/new") return rpcResult({ sessionId: "session-1" });
    return NO_RESPONSE;
  };
  const fixture = fixtureOptions(server, { initializeTimeoutMs: 25 });
  try {
    const runtime = await acquire(fixture);
    await assert.rejects(
      startSession(runtime),
      (error) => error.code === "AUTH_REQUIRED",
    );
    assert.equal(authenticateCount, 0);
    const runtimeHome = fixture.nativeHome;
    fs.writeFileSync(path.join(runtimeHome, "auth.json"), "logged-in", { mode: 0o600 });
    const refreshedRuntime = await acquire(fixture);
    assert.equal(refreshedRuntime, runtime);
    assert.equal(fixture.children[0].closed, false);
    const started = await startSession(refreshedRuntime);
    assert.equal(started.session.id, "session-1");
    assert.equal(authenticateCount, 0);
    assert.equal(refreshedRuntime.authenticationState().authenticated, true);
    assert.equal(fixture.spawns.length, 1);
    assert.equal((await acquire(fixture)), refreshedRuntime);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("credential rotation never recycles an acquired host without a runtime lease", async () => {
  let finishPrompt;
  const fixture = fixtureOptions(standardServer((message, child) => {
    if (message.method === "session/prompt") {
      setImmediate(() => child.sendNotification("session/update", {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "working" },
        },
      }));
      finishPrompt = () => child.sendResult(message.id, { stopReason: "end_turn" });
      return NO_RESPONSE;
    }
    return undefined;
  }));
  try {
    const runtimeHome = fixture.nativeHome;
    const authPath = path.join(runtimeHome, "auth.json");
    fs.writeFileSync(authPath, "credential-before", { mode: 0o600 });
    const runtime = await acquire(fixture);
    const started = await startSession(runtime, "chat:credential-rotation-active");
    await runtime.turnStart({
      sessionId: started.session.id,
      operationId: "credential-rotation-active",
      prompt: "keep working",
      cwd: "/tmp/workspace",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.equal(runtime.host.activeTurns.size, 1);

    fs.writeFileSync(authPath, "credential-after-is-longer", { mode: 0o600 });
    assert.equal(await acquire(fixture), runtime);
    assert.equal(fixture.children[0].closed, false);
    assert.equal(fixture.spawns.length, 1);

    finishPrompt();
    await waitFor(() => runtime.host.activeTurns.size === 0, "active turn completion");
    const refreshedRuntime = await acquire(fixture);
    assert.equal(refreshedRuntime, runtime);
    assert.equal(fixture.children[0].closed, false);
    assert.equal(fixture.spawns.length, 1);
    const afterRotation = await startSession(runtime, "chat:credential-after-active");
    assert.equal(afterRotation.session.id, "session-2");
    assert.equal(runtime.authenticationState().authenticated, true);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("credential rotation preserves all acquired workspace hosts without a runtime lease", async () => {
  const fixture = fixtureOptions(standardServer());
  const workspaces = ["generation-a", "generation-b"].map((name) => {
    const workspace = path.join(fixture.paths.trustedRoot, name);
    fs.mkdirSync(workspace, { mode: 0o700 });
    return workspace;
  });
  try {
    const runtimeHome = fixture.nativeHome;
    const authPath = path.join(runtimeHome, "auth.json");
    fs.writeFileSync(authPath, "credential-one", { mode: 0o600 });
    const first = await acquire(fixture, { workspace: workspaces[0] });
    const second = await acquire(fixture, { workspace: workspaces[1] });
    assert.equal(fixture.pool.entries.size, 2);

    fs.writeFileSync(authPath, "credential-two-is-longer", { mode: 0o600 });
    assert.equal(await acquire(fixture, { workspace: workspaces[0] }), first);
    assert.equal(await acquire(fixture, { workspace: workspaces[1] }), second);
    assert.equal(fixture.children[0].closed, false);
    assert.equal(fixture.children[1].closed, false);
    assert.equal(fixture.spawns.length, 2);
    assert.equal(fixture.pool.entries.size, 2);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("execution auth proof is shared with control host and invalidated by fingerprint or AUTH_REQUIRED", async () => {
  let rejectSession = false;
  let sessionSequence = 0;
  let authenticateCount = 0;
  const server = (message) => {
    if (message.method === "initialize") {
      return rpcResult(initializeResult({
        authMethods: [{ id: "grok.com", name: "Grok" }],
        defaultAuthMethodId: null,
      }));
    }
    if (message.method === "authenticate") {
      authenticateCount += 1;
      return NO_RESPONSE;
    }
    if (message.method === "session/new") {
      if (rejectSession) return rpcError(-32000, "login required");
      sessionSequence += 1;
      return rpcResult({ sessionId: `session-${sessionSequence}` });
    }
    return NO_RESPONSE;
  };
  const fixture = fixtureOptions(server, { initializeTimeoutMs: 25 });
  try {
    const runtimeHome = fixture.nativeHome;
    const authPath = path.join(runtimeHome, "auth.json");
    fs.writeFileSync(authPath, "credential-one", { mode: 0o600 });
    const control = await acquire(fixture, { control: true });
    const execution = await acquire(fixture);
    assert.deepEqual(control.authenticationState(), {
      authenticated: false,
      credentialPresent: true,
      methodId: null,
      methods: [{ id: "grok.com", name: "Grok", type: "agent" }],
    });
    await startSession(execution, "chat:proof-one");
    assert.equal(control.authenticationState().authenticated, true);
    assert.equal(control.authenticationState().credentialPresent, true);

    fs.writeFileSync(authPath, "credential-two-changed", { mode: 0o600 });
    assert.equal(control.authenticationState().authenticated, false);
    assert.equal(control.authenticationState().credentialPresent, true);
    await startSession(execution, "chat:proof-two");
    assert.equal(control.authenticationState().authenticated, true);

    rejectSession = true;
    await assert.rejects(
      startSession(execution, "chat:proof-rejected"),
      (error) => error.code === "AUTH_REQUIRED",
    );
    assert.equal(control.authenticationState().authenticated, false);
    assert.equal(control.authenticationState().credentialPresent, true);
    assert.equal(authenticateCount, 0);

    fs.unlinkSync(authPath);
    assert.equal(control.authenticationState().authenticated, false);
    assert.equal(control.authenticationState().credentialPresent, false);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("late AUTH_REQUIRED for credential X cannot revoke credential Y verified by another host", async () => {
  let resolveCredentialX;
  let sessionSequence = 0;
  const server = (message) => {
    if (message.method === "initialize") {
      return rpcResult(initializeResult({
        authMethods: [{ id: "grok.com", name: "Grok" }],
        defaultAuthMethodId: null,
      }));
    }
    if (message.method === "session/new") {
      if (message.params.cwd === "/tmp/credential-race-x") {
        return new Promise((resolve) => { resolveCredentialX = resolve; });
      }
      sessionSequence += 1;
      return rpcResult({ sessionId: `session-y-${sessionSequence}` });
    }
    return NO_RESPONSE;
  };
  const fixture = fixtureOptions(server);
  try {
    const runtimeHome = fixture.nativeHome;
    const authPath = path.join(runtimeHome, "auth.json");
    fs.writeFileSync(authPath, "credential-x", { mode: 0o600 });
    const control = await acquire(fixture, { control: true });
    const runtimeX = await acquire(fixture, { workspace: "/tmp/credential-race-x" });
    const runtimeY = await acquire(fixture, { workspace: "/tmp/credential-race-y" });
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const pendingX = runtimeX.sessionStart({
      source: "chat:credential-x",
      persistent: true,
      cwd: "/tmp/credential-race-x",
      permissionPolicy,
    });
    await waitFor(() => resolveCredentialX, "credential X session request");

    fs.writeFileSync(authPath, "credential-y-is-longer", { mode: 0o600 });
    await runtimeY.sessionStart({
      source: "chat:credential-y",
      persistent: true,
      cwd: "/tmp/credential-race-y",
      permissionPolicy,
    });
    assert.equal(control.authenticationState().authenticated, true);

    resolveCredentialX(rpcError(-32000, "login required"));
    await assert.rejects(pendingX, (error) => error.code === "AUTH_REQUIRED");
    assert.equal(control.authenticationState().authenticated, true);
    assert.equal(control.authenticationState().credentialPresent, true);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("late prompt success for credential X cannot establish proof for rotated credential Y", async () => {
  let resolveCredentialXPrompt;
  const server = (message) => {
    if (message.method === "initialize") {
      return rpcResult(initializeResult({
        authMethods: [{ id: "grok.com", name: "Grok" }],
        defaultAuthMethodId: null,
      }));
    }
    if (message.method === "session/new") return rpcResult({ sessionId: "session-prompt-x" });
    if (message.method === "session/prompt") {
      return new Promise((resolve) => { resolveCredentialXPrompt = resolve; });
    }
    return NO_RESPONSE;
  };
  const fixture = fixtureOptions(server, { acceptanceTimeoutMs: 1_000 });
  try {
    const runtimeHome = fixture.nativeHome;
    const authPath = path.join(runtimeHome, "auth.json");
    fs.writeFileSync(authPath, "credential-x", { mode: 0o600 });
    const control = await acquire(fixture, { control: true });
    const runtime = await acquire(fixture);
    const started = await startSession(runtime, "chat:prompt-race");
    assert.equal(control.authenticationState().authenticated, true);
    const pendingTurn = runtime.turnStart({
      sessionId: started.session.id,
      operationId: "op-prompt-credential-x",
      prompt: "wait while credentials rotate",
      cwd: "/tmp/workspace",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    await waitFor(() => resolveCredentialXPrompt, "credential X prompt request");

    fs.writeFileSync(authPath, "credential-y-is-longer", { mode: 0o600 });
    assert.equal(control.authenticationState().authenticated, false);
    resolveCredentialXPrompt(rpcResult({ stopReason: "end_turn" }));
    await pendingTurn;
    assert.equal(control.authenticationState().authenticated, false);
    assert.equal(control.authenticationState().credentialPresent, true);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("permission policy controls sandbox args and conflicts require stop before rebuild", async () => {
  assert.deepEqual(DEFAULT_GROK_BUILD_PERMISSION_POLICY, {
    approvalPolicy: "on-request",
    sandbox: "danger-full-access",
  });
  assert.deepEqual(buildGrokBuildArgs(), [
    "--sandbox", "off", "agent", "--no-leader", "stdio",
  ]);
  const fixture = fixtureOptions(standardServer());
  try {
    await acquire(fixture, {
      permissionPolicy: { approvalPolicy: "never", sandbox: "workspace-write" },
    });
    assert.deepEqual(fixture.spawns[0].args, ["--sandbox", "workspace", "agent", "--no-leader", "stdio"]);
    assert.equal(fixture.spawns[0].args.includes("--yolo"), false);
    await assert.rejects(
      acquire(fixture, {
        permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" },
      }),
      (error) => error.code === "RUNTIME_PERMISSION_POLICY_CONFLICT",
    );
    assert.equal(fixture.spawns.length, 1);
    await fixture.adapter.stop(binding());
    await acquire(fixture, {
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" },
    });
    assert.deepEqual(fixture.spawns[1].args, [
      "--sandbox", "read-only", "agent", "--no-leader", "stdio",
    ]);
    await fixture.adapter.stopAll();
    assert.equal(fixture.children.every((child) => child.closed), true);
  } finally {
    fixture.cleanup();
  }
});

test("workspace routes are singleflight, ledger-isolated, policy-preserving, and stop by profile", async () => {
  const fixture = fixtureOptions(standardServer(), { maxHosts: 4 });
  const workspaceA = path.join(fixture.paths.trustedRoot, "workspace-a");
  const workspaceB = path.join(fixture.paths.trustedRoot, "workspace-b");
  fs.mkdirSync(workspaceA, { mode: 0o700 });
  fs.mkdirSync(workspaceB, { mode: 0o700 });
  const policyA = { approvalPolicy: "on-request", sandbox: "workspace-write" };
  const policyB = { approvalPolicy: "never", sandbox: "read-only" };
  try {
    const [runtimeA, duplicateA] = await Promise.all([
      acquire(fixture, { workspace: workspaceA, permissionPolicy: policyA }),
      acquire(fixture, { workspace: workspaceA, permissionPolicy: policyA }),
    ]);
    assert.equal(runtimeA, duplicateA);
    assert.equal(fixture.spawns.length, 1);

    const runtimeB = await acquire(fixture, { workspace: workspaceB, permissionPolicy: policyB });
    assert.notEqual(runtimeA, runtimeB);
    assert.equal(fixture.spawns.length, 2);
    assert.equal(fixture.spawns[0].options.cwd, workspaceA);
    assert.equal(fixture.spawns[1].options.cwd, workspaceB);
    assert.deepEqual(fixture.spawns[0].args, [
      "--sandbox", "workspace", "agent", "--no-leader", "stdio",
    ]);
    assert.deepEqual(fixture.spawns[1].args, [
      "--sandbox", "read-only", "agent", "--no-leader", "stdio",
    ]);

    const startedA = await runtimeA.sessionStart({
      source: "chat:shared-source", cwd: workspaceA, permissionPolicy: policyA,
    });
    const startedB = await runtimeB.sessionStart({
      source: "chat:shared-source", cwd: workspaceB, permissionPolicy: policyB,
    });
    assert.equal((await runtimeA.sessionList()).data.length, 1);
    assert.equal((await runtimeB.sessionList()).data.length, 1);
    await assert.rejects(
      runtimeA.sessionRead({ sessionId: startedB.session.id }),
      (error) => error.code === "RUNTIME_SESSION_NOT_FOUND",
    );
    await assert.rejects(
      runtimeB.sessionRead({ sessionId: startedA.session.id }),
      (error) => error.code === "RUNTIME_SESSION_NOT_FOUND",
    );
    assert.notEqual(runtimeA.host.ledger.ledgerPath, runtimeB.host.ledger.ledgerPath);
    assert.equal(runtimeA.host.ledger.workspaceShardId, grokBuildWorkspaceShardId({
      workspace: workspaceA,
    }));
    assert.equal(runtimeB.host.ledger.workspaceShardId, grokBuildWorkspaceShardId({
      workspace: workspaceB,
    }));

    await fixture.adapter.stop(binding());
    assert.equal(fixture.pool.entries.size, 0);
    assert.equal(fixture.adapter.handles.size, 0);
    assert.equal(fixture.children.every((child) => child.closed), true);

    const restartedA = await acquire(fixture, { workspace: workspaceA, permissionPolicy: policyA });
    assert.notEqual(restartedA, runtimeA);
    assert.equal(fixture.spawns.length, 3);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("control instances use the shared native account home for models and reject session execution", async () => {
  const fixture = fixtureOptions(standardServer());
  try {
    const runtime = await acquire(fixture, { control: true });
    const runtimeHome = fixture.nativeHome;
    assert.equal(runtime.controlInstance, true);
    assert.equal(runtime.workspace, null);
    assert.equal(fixture.spawns[0].options.cwd, fixture.userHome);
    assert.equal(fixture.spawns[0].options.env.HOME, fixture.userHome);
    assert.equal(fixture.spawns[0].options.env.GROK_HOME, runtimeHome);
    assert.equal((await runtime.modelsList()).data.length, 2);
    await assert.rejects(
      startSession(runtime),
      (error) => error.code === "RUNTIME_CAPABILITY_UNSUPPORTED",
    );
    assert.equal(
      fixture.children[0].messages.some((message) => message.method === "session/new"),
      false,
    );
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("writable execution requires its fixed workspace and rejects session cwd expansion", async () => {
  const fixture = fixtureOptions(standardServer());
  const workspace = path.join(fixture.paths.trustedRoot, "fixed-workspace");
  const otherWorkspace = path.join(fixture.paths.trustedRoot, "other-workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(otherWorkspace, { mode: 0o700 });
  const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
  try {
    await assert.rejects(
      acquire(fixture, { workspace: null, permissionPolicy }),
      (error) => error.code === "WORKSPACE_REQUIRED_FOR_WRITABLE_RUN",
    );
    assert.equal(fixture.spawns.length, 0);
    const runtime = await acquire(fixture, { workspace, permissionPolicy });
    await assert.rejects(
      runtime.sessionStart({
        source: "chat:wrong-workspace", cwd: otherWorkspace, permissionPolicy,
      }),
      (error) => error.code === "RUNTIME_WORKSPACE_MISMATCH",
    );
    assert.equal(
      fixture.children[0].messages.some((message) => message.method === "session/new"),
      false,
    );
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("workspace host limit fails closed without stopping an acquired handle", async () => {
  const fixture = fixtureOptions(standardServer(), { maxHosts: 1 });
  const workspaces = ["existing", "new"].map((name) => {
    const workspace = path.join(fixture.paths.trustedRoot, `workspace-${name}`);
    fs.mkdirSync(workspace, { mode: 0o700 });
    return workspace;
  });
  try {
    const runtimeA = await acquire(fixture, { workspace: workspaces[0] });
    const [existingResult, newResult] = await Promise.allSettled([
      acquire(fixture, { workspace: workspaces[0] }),
      acquire(fixture, { workspace: workspaces[1] }),
    ]);
    assert.equal(existingResult.status, "fulfilled");
    assert.equal(existingResult.value, runtimeA);
    assert.equal(newResult.status, "rejected");
    assert.equal(newResult.reason.code, "RUNTIME_HOST_CAPACITY");
    const started = await runtimeA.sessionStart({
      source: "chat:still-live",
      cwd: workspaces[0],
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.equal(started.session.id, "session-1");
    assert.equal(fixture.spawns.length, 1);
    assert.equal(fixture.pool.entries.size, 1);
    assert.equal(fixture.children[0].closed, false);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("accepted prompt timeout publishes an interrupted terminal event", async () => {
  const fixture = fixtureOptions(standardServer((message, child) => {
    if (message.method === "session/prompt") {
      setImmediate(() => child.sendNotification("session/update", {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "accepted" },
        },
      }));
      return NO_RESPONSE;
    }
    return undefined;
  }), { promptTimeoutMs: 25 });
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const completions = [];
    runtime.subscribe((event) => {
      if (event.type === "complete") completions.push(event);
    });
    const started = await runtime.turnStart({
      sessionId: "session-1", operationId: "accepted-timeout", prompt: "wait",
    });
    await waitFor(() => completions.length === 1, "accepted prompt timeout completion");
    assert.equal(completions[0].turnId, started.turn.id);
    assert.equal(completions[0].status, "interrupted");
    const read = await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
    assert.equal(read.session.turns[0].status, "interrupted");
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("archive and delete reject while a session turn is active", async () => {
  const fixture = fixtureOptions(standardServer((message, child) => {
    if (message.method === "session/prompt") {
      setImmediate(() => child.sendNotification("session/update", {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "working" },
        },
      }));
      return NO_RESPONSE;
    }
    return undefined;
  }));
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    await runtime.turnStart({
      sessionId: "session-1", operationId: "active-mutation", prompt: "keep working",
    });
    await assert.rejects(
      runtime.sessionArchive({ sessionId: "session-1" }),
      (error) => error.code === "RUNTIME_SESSION_BUSY",
    );
    await assert.rejects(
      runtime.sessionDelete({ sessionId: "session-1" }),
      (error) => error.code === "RUNTIME_SESSION_BUSY",
    );
    assert.equal((await runtime.sessionList()).data.length, 1);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("stop kills an orphaned process group after the Grok leader exits", async () => {
  const signals = [];
  let orphanExists = true;
  let fixture;
  fixture = fixtureOptions(standardServer(), {
    shutdownGraceMs: 5,
    killGraceMs: 5,
    killProcessGroup(pid, signal) {
      signals.push(signal);
      if (signal === "SIGTERM") {
        fixture.children.find((child) => child.pid === pid)?.closeProcess();
      } else if (signal === "SIGKILL") {
        orphanExists = false;
      }
    },
    processGroupExists: () => orphanExists,
  });
  try {
    await acquire(fixture);
    await fixture.adapter.stopAll();
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(fixture.children[0].closed, true);
  } finally {
    fixture.cleanup();
  }
});

test("read-only sessions use the native runtime account home when cwd is absent", async () => {
  const fixture = fixtureOptions(standardServer());
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "read-only" };
    const runtime = await acquire(fixture, { permissionPolicy, workspace: null });
    const started = await runtime.sessionStart({
      source: "cron:no-workspace",
      persistent: true,
      model: "grok-4.6",
      cwd: null,
      permissionPolicy,
    });
    const runtimeHome = fixture.spawns[0].options.env.GROK_HOME;
    assert.equal(started.session.cwd, runtimeHome);
    const sessionNew = fixture.children[0].messages.find((item) => item.method === "session/new");
    assert.equal(sessionNew.params.cwd, runtimeHome);
    await runtime.sessionResume({ sessionId: started.session.id, cwd: null, permissionPolicy });
    const resume = fixture.children[0].messages.find((item) => item.method === "session/resume");
    assert.equal(resume.params.cwd, runtimeHome);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("product permission modes map to Grok ACP session metadata and mode ids", async () => {
  const fixture = fixtureOptions(standardServer());
  try {
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const runtime = await acquire(fixture, { permissionPolicy });
    const started = await runtime.sessionStart({
      source: "chat:permission-mode",
      persistent: true,
      model: "grok-4.6",
      cwd: "/tmp/workspace",
      permissionPolicy,
      permissionMode: "auto",
    });
    const sessionNew = fixture.children[0].messages.find((item) => item.method === "session/new");
    assert.deepEqual(sessionNew.params._meta, {
      modelId: "grok-4.6",
      yoloMode: false,
      autoMode: true,
    });
    await runtime.sessionResume({
      sessionId: started.session.id,
      model: "grok-4.6",
      cwd: "/tmp/workspace",
      permissionPolicy: { approvalPolicy: "never", sandbox: "danger-full-access" },
      permissionMode: "always-approve",
    });
    const setMode = fixture.children[0].messages.find((item) => item.method === "session/set_mode");
    assert.deepEqual(setMode.params, {
      sessionId: started.session.id,
      modeId: "bypassPermissions",
    });
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("never approval policy rejects ACP permission without invoking UI handlers", async () => {
  let prompt;
  const reverseResponses = [];
  const server = standardServer((message, child) => {
    if (message.method === "session/prompt") {
      prompt = message;
      setImmediate(() => child.send({
        jsonrpc: "2.0",
        id: "never-permission",
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: { toolCallId: "dangerous", kind: "execute", title: "Run command" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
            { optionId: "reject-always", name: "Reject always", kind: "reject_always" },
          ],
        },
      }));
      return NO_RESPONSE;
    }
    if (message.id === "never-permission" && !message.method) {
      reverseResponses.push(message);
      child.sendResult(prompt.id, { stopReason: "end_turn" });
      return NO_RESPONSE;
    }
    return undefined;
  });
  const fixture = fixtureOptions(server);
  try {
    const permissionPolicy = { approvalPolicy: "never", sandbox: "workspace-write" };
    const runtime = await acquire(fixture, { permissionPolicy });
    await runtime.sessionStart({
      source: "chat:never", cwd: "/tmp/workspace", permissionPolicy,
    });
    let handlerCalls = 0;
    runtime.registerServerRequestHandler("item/commandExecution/requestApproval", async () => {
      handlerCalls += 1;
      return { decision: "accept" };
    });
    await runtime.turnStart({
      sessionId: "session-1", operationId: "never-op", prompt: "unsafe",
      permissionPolicy,
    });
    await waitFor(() => reverseResponses.length === 1, "automatic never-policy denial");
    assert.deepEqual(reverseResponses[0].result, {
      outcome: { outcome: "selected", optionId: "reject-always" },
    });
    assert.equal(handlerCalls, 0);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("aggregate streamed output is bounded and fails the host closed", async () => {
  const chunk = "x".repeat(700 * 1024);
  const fixture = fixtureOptions(standardServer((message, child) => {
    if (message.method === "session/prompt") {
      setImmediate(() => {
        for (let index = 0; index < 13; index += 1) {
          child.sendNotification("session/update", {
            sessionId: message.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: `message-${index}`,
              content: { type: "text", text: chunk },
            },
          });
        }
      });
      return NO_RESPONSE;
    }
    return undefined;
  }));
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const completions = [];
    runtime.subscribe((event) => {
      if (event.type === "complete") completions.push(event);
    });
    await runtime.turnStart({
      sessionId: "session-1", operationId: "large-output", prompt: "stream",
    });
    await assert.rejects(
      runtime.terminated,
      (error) => error.code === "GROK_ACP_TURN_OUTPUT_TOO_LARGE",
    );
    assert.equal(completions.at(-1)?.status, "interrupted");
    assert.equal(fixture.children[0].closed, true);
  } finally {
    fixture.cleanup();
  }
});

test("malformed session updates cannot prove turn acceptance", async () => {
  const fixture = fixtureOptions(standardServer((message, child) => {
    if (message.method === "session/prompt") {
      setImmediate(() => child.sendNotification("session/update", {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: "tool_call", title: "missing toolCallId" },
      }));
      return NO_RESPONSE;
    }
    return undefined;
  }));
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    await assert.rejects(
      runtime.turnStart({
        sessionId: "session-1", operationId: "malformed-update", prompt: "work",
      }),
      (error) => error.code === "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
    );
    await assert.rejects(
      runtime.terminated,
      (error) => error.code === "GROK_ACP_NOTIFICATION_INVALID",
    );
    assert.equal(
      fixture.children[0].messages.filter((item) => item.method === "session/prompt").length,
      1,
    );
  } finally {
    fixture.cleanup();
  }
});

test("MCP descriptors require executable commands and safe env/header names", async () => {
  const fixture = fixtureOptions(standardServer());
  try {
    assert.throws(
      () => validateMcpServer({
        name: "missing", command: path.join(fixture.paths.trustedRoot, "missing"), args: [], env: [],
      }),
      (error) => error.code === "GROK_BUILD_MCP_INVALID",
    );
    assert.throws(
      () => validateMcpServer({
        name: "bad-env", command: fixture.binaryPath, args: [],
        env: [{ name: "BAD-NAME", value: "secret" }],
      }),
      (error) => error.code === "GROK_BUILD_MCP_INVALID",
    );
    assert.throws(
      () => validateMcpServer({
        type: "http", name: "bad-header", url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "safe\r\ninjected: yes" }],
      }),
      (error) => error.code === "GROK_BUILD_MCP_INVALID",
    );
    const runtime = await acquire(fixture, {
      mcpServers: [
        { name: "duplicate", command: fixture.binaryPath, args: [], env: [] },
        { name: "duplicate", command: fixture.binaryPath, args: [], env: [] },
      ],
    });
    await assert.rejects(
      startSession(runtime),
      (error) => error.code === "GROK_BUILD_MCP_INVALID",
    );
    assert.equal(
      fixture.children[0].messages.some((item) => item.method === "session/new"),
      false,
    );
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("reserved native HOME/GROK_HOME and compatibility switches cannot be overridden", async () => {
  for (const name of [
    "HOME", "GROK_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", ...GROK_COMPAT_DISABLE_ENV,
  ]) {
    const fixture = fixtureOptions(standardServer(), { spawnEnv: { [name]: "/tmp/unsafe" } });
    try {
      await assert.rejects(
        acquire(fixture),
        (error) => error.code === "GROK_BUILD_SPAWN_ENV_INVALID",
      );
      assert.equal(fixture.spawns.length, 0);
    } finally {
      fixture.cleanup();
    }
  }
  const fixture = fixtureOptions(standardServer(), { parentEnv: {} });
  try {
    await acquire(fixture);
    const runtimeHome = fixture.nativeHome;
    assert.equal(fixture.spawns[0].options.env.HOME, fixture.userHome);
    assert.equal(fixture.spawns[0].options.env.GROK_HOME, runtimeHome);
    assert.equal(GROK_COMPAT_DISABLE_ENV.every(
      (key) => fixture.spawns[0].options.env[key] === "false",
    ), true);
    await fixture.adapter.stopAll();
  } finally {
    fixture.cleanup();
  }
});

test("binary resolver accepts only executable absolute regular files", () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-grok-binary-"));
  try {
    const executable = path.join(trustedRoot, "grok");
    const other = path.join(trustedRoot, "other");
    fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
    fs.writeFileSync(other, "not executable", { mode: 0o600 });
    assert.equal(resolveGrokBuildBinary({ binaryPath: executable }), fs.realpathSync(executable));
    assert.throws(
      () => resolveGrokBuildBinary({ binaryPath: "grok" }),
      (error) => error.code === "GROK_BUILD_BINARY_INVALID",
    );
    assert.throws(
      () => resolveGrokBuildBinary({ binaryPath: other }),
      (error) => error.code === "GROK_BUILD_BINARY_INVALID",
    );
    assert.equal(resolveGrokBuildBinary({
      parentEnv: { PATH: trustedRoot }, homedir: path.join(trustedRoot, "missing"),
    }), fs.realpathSync(executable));
  } finally {
    fs.rmSync(trustedRoot, { recursive: true, force: true });
  }
});

async function transportFailure(frame, expectedCode, options = {}) {
  const child = new FakeChild();
  const rpc = new GrokBuildAcpJsonlClient(child, {
    requestTimeoutMs: 1_000,
    maxFrameBytes: options.maxFrameBytes || 1024,
  });
  const pending = rpc.request("initialize", {});
  if (frame === null) child.stdout.end();
  else child.stdout.write(frame);
  await assert.rejects(rpc.terminated, (error) => error.code === expectedCode);
  await assert.rejects(pending, (error) => error.code === expectedCode);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  child.closeProcess();
}

test("strict JSONL rejects malformed, oversized, and EOF frames with complete listener cleanup", async () => {
  await transportFailure("{bad json}\n", "GROK_ACP_MALFORMED_JSONL");
  await transportFailure(Buffer.alloc(1025, 0x61), "GROK_ACP_FRAME_TOO_LARGE");
  await transportFailure(null, "GROK_ACP_STDOUT_ENDED");
});

test("stderr auth hints apply only to concurrent session requests and never poison later errors", async () => {
  let phase = "auth-failure";
  const child = new FakeChild((message, currentChild) => {
    if (message.method === "session/new" && phase === "auth-failure") {
      currentChild.stderr.write("login required\n");
      return rpcError(-32000, "request failed");
    }
    if (message.method === "session/new" && phase === "authenticated") {
      return rpcResult({ sessionId: "session-after-login" });
    }
    if (message.method === "session/set_model") {
      return rpcError(-32000, "model unavailable");
    }
    return NO_RESPONSE;
  });
  const rpc = new GrokBuildAcpJsonlClient(child, { requestTimeoutMs: 1_000 });
  try {
    await assert.rejects(
      rpc.request("session/new", { cwd: "/tmp/workspace", mcpServers: [] }),
      (error) => error.code === "AUTH_REQUIRED",
    );
    phase = "authenticated";
    assert.deepEqual(
      await rpc.request("session/new", { cwd: "/tmp/workspace", mcpServers: [] }),
      { sessionId: "session-after-login" },
    );
    await assert.rejects(
      rpc.request("session/set_model", { sessionId: "session-after-login", modelId: "missing" }),
      (error) => error.code === "GROK_ACP_REMOTE_ERROR",
    );
  } finally {
    await rpc.terminate();
    child.closeProcess();
  }
});

test("unknown client fs/terminal reverse requests are denied by default", async () => {
  const child = new FakeChild();
  const rpc = new GrokBuildAcpJsonlClient(child, { requestTimeoutMs: 1_000 });
  try {
    child.send({
      jsonrpc: "2.0", id: "unsafe-fs", method: "fs/read_text_file", params: { path: "/etc/passwd" },
    });
    child.send({
      jsonrpc: "2.0", id: "unsafe-terminal", method: "terminal/create", params: { command: "id" },
    });
    await waitFor(
      () => child.messages.filter((message) => message.error?.code === -32601).length === 2,
      "reverse-request denials",
    );
    assert.deepEqual(
      child.messages.filter((message) => message.error?.code === -32601).map((message) => message.id),
      ["unsafe-fs", "unsafe-terminal"],
    );
  } finally {
    await rpc.terminate();
    child.closeProcess();
  }
});


test("completed Grok prompts publish authoritative consumed tokens and reported USD before completion", async () => {
  const calls = [];
  const fixture = fixtureOptions(standardServer(message => message.method === "session/prompt" ? rpcResult({ stopReason: "end_turn" }) : undefined), { hostOptions: { readUsage: async input => {
    calls.push(input);
    return [{ responseId: "grok-reported-turn", createdAt: input.untilMs, model: "grok-4.6-build", provider: "xai", costUsd: 0.125,
      usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20, cachedInputTokens: 30, cacheWriteInputTokens: 0, reasoningOutputTokens: 5 } }];
  } } });
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const events = [];
    runtime.host.subscribe(event => events.push(event));
    await runtime.turnStart({ sessionId: "session-1", operationId: "metered-prompt", prompt: "Meter me" });
    await waitFor(() => events.some(event => event.type === "complete"), "metered completion");
    const usage = events.find(event => event.type === "usage");
    assert.equal(usage.usage.totalTokens, 100);
    assert.equal(usage.costUsd, 0.125);
    assert.equal(usage.sessionId, "session-1");
    assert.ok(events.indexOf(usage) < events.findIndex(event => event.type === "complete"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].env.SECRET_TOKEN, undefined);
    await fixture.adapter.stopAll();
  } finally { fixture.cleanup(); }
});

test("complete JSONL preflight counts the actual id and newline without terminating a healthy client", async () => {
  const child = new FakeChild(() => rpcResult({ ok: true }));
  const rpc = new GrokBuildAcpJsonlClient(child, { maxFrameBytes: 1024 });
  try {
    rpc.nextId = Number.MAX_SAFE_INTEGER;
    const overhead = Buffer.byteLength(`${JSON.stringify({
      jsonrpc: "2.0", id: rpc.nextId, method: "session/prompt", params: { text: "" },
    })}\n`);
    const exact = { text: "x".repeat(1024 - overhead) };
    const tooLarge = { text: `${exact.text}x` };
    assert.deepEqual(rpc.preflightRequest("session/prompt", exact), {
      frameBytes: 1024, maxFrameBytes: 1024,
    });
    await assert.rejects(rpc.request("session/prompt", tooLarge), {
      code: "GROK_ACP_OUTBOUND_FRAME_TOO_LARGE", dispatchState: "not_sent",
      frameBytes: 1025, maxFrameBytes: 1024,
    });
    const cyclic = {}; cyclic.cyclic = cyclic;
    await assert.rejects(rpc.request("session/prompt", cyclic), {
      code: "GROK_ACP_SERIALIZE_FAILED", dispatchState: "not_sent",
    });
    assert.equal(child.messages.length, 0);
    assert.equal(rpc.pending.size, 0);
    assert.equal(rpc.ended, false);
    assert.deepEqual(await rpc.request("session/prompt", exact), { ok: true });
    assert.equal(child.messages.length, 1);
  } finally {
    await rpc.terminate(); child.closeProcess();
  }
});

test("connection failure classifies each request at its own stdin.write boundary", async () => {
  const child = new FakeChild();
  let finishWrite;
  const frames = [];
  child.stdin.write = (frame, callback) => {
    frames.push(JSON.parse(frame)); finishWrite = callback; return true;
  };
  const rpc = new GrokBuildAcpJsonlClient(child);
  try {
    const attempted = rpc.request("session/prompt", { text: "first" });
    const queued = rpc.request("session/prompt", { text: "second" });
    const outcomes = Promise.allSettled([attempted, queued]);
    await waitFor(() => finishWrite, "first write attempt");
    child.emit("error", new Error("synthetic process loss"));
    const result = await outcomes;
    assert.equal(result[0].reason.code, "GROK_ACP_PROCESS_ERROR");
    assert.equal(result[0].reason.dispatchState, "write_attempted");
    assert.equal(result[1].reason.code, "GROK_ACP_PROCESS_ERROR");
    assert.equal(result[1].reason.dispatchState, "not_sent");
    finishWrite();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(frames.length, 1, "terminated queued request must never reach stdin");
  } finally {
    await rpc.terminate(); child.closeProcess();
  }
});

test("a queued request timeout cancels its future write while preserving the earlier request", async () => {
  const child = new FakeChild();
  let finishWrite;
  const frames = [];
  child.stdin.write = (frame, callback) => {
    frames.push(JSON.parse(frame)); finishWrite = callback; return true;
  };
  const rpc = new GrokBuildAcpJsonlClient(child);
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const first = rpc.request("session/prompt", { text: "first" });
    const queued = rpc.request("session/prompt", { text: "second" }, { timeoutMs: 20 });
    await assert.rejects(queued, { code: "GROK_ACP_REQUEST_TIMEOUT", dispatchState: "not_sent" });
    finishWrite();
    child.sendResult(frames[0].id, { done: true });
    assert.deepEqual(await first, { done: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(frames.length, 1);
    assert.equal(rpc.ended, false);
  } finally {
    clearTimeout(keepAlive); await rpc.terminate(); child.closeProcess();
  }
});

for (const failure of ["throw", "callback"]) {
  test(`stdin ${failure} failure is conservatively write_attempted`, async () => {
    const child = new FakeChild();
    child.stdin.write = (_frame, callback) => {
      if (failure === "throw") throw new Error("synthetic write failure");
      callback(new Error("synthetic write failure"));
      return false;
    };
    const rpc = new GrokBuildAcpJsonlClient(child);
    try {
      await assert.rejects(rpc.request("session/prompt", {}), {
        code: "GROK_ACP_WRITE_FAILED", dispatchState: "write_attempted",
      });
      assert.equal(rpc.ended, true);
    } finally {
      await rpc.terminate(); child.closeProcess();
    }
  });
}

test("failed durable write observer prevents stdin writes and leaves the transport usable", async () => {
  const child = new FakeChild(() => rpcResult({ ok: true }));
  const rpc = new GrokBuildAcpJsonlClient(child);
  try {
    await assert.rejects(rpc.request("session/prompt", {}, {
      onWriteAttempt() { throw Object.assign(new Error("synthetic ledger failure"), { code: "TEST_LEDGER_FAILED" }); },
    }), { code: "TEST_LEDGER_FAILED", dispatchState: "not_sent" });
    assert.equal(child.messages.length, 0);
    assert.equal(rpc.ended, false);
    await rpc.request("session/prompt", {});
    assert.equal(child.messages.length, 1);
  } finally {
    await rpc.terminate(); child.closeProcess();
  }
});

test("a failed write fences the connection before the next queued writer can send", async () => {
  const child = new FakeChild();
  let writes = 0;
  child.stdin.write = (_frame, callback) => {
    writes += 1;
    callback(new Error("synthetic partial write"));
    return true;
  };
  const rpc = new GrokBuildAcpJsonlClient(child);
  try {
    const result = await Promise.allSettled([
      rpc.request("session/prompt", { text: "first" }),
      rpc.request("session/prompt", { text: "second" }),
    ]);
    assert.equal(result[0].reason.dispatchState, "write_attempted");
    assert.equal(result[1].reason.dispatchState, "not_sent");
    assert.equal(writes, 1);
  } finally { await rpc.terminate(); child.closeProcess(); }
});

test("oversized images and combined prompt frames fail before creating a turn and the session remains usable", async () => {
  const fixture = fixtureOptions(standardServer(message => message.method === "session/prompt"
    ? rpcResult({ stopReason: "end_turn" }) : undefined), { maxFrameBytes: 1024 * 1024 });
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const largeImage = path.join(fixture.paths.trustedRoot, "large.png");
    const mediumImage = path.join(fixture.paths.trustedRoot, "medium.png");
    fs.writeFileSync(largeImage, Buffer.alloc(2_432_807), { mode: 0o600 });
    fs.writeFileSync(mediumImage, Buffer.alloc(450_000), { mode: 0o600 });
    const input = { sessionId: "session-1", operationId: "oversized", prompt: "inspect" };
    for (const extra of [
      { attachments: [{ path: largeImage, mimeType: "image/png" }] },
      { attachments: Array.from({ length: 2 }, () => ({ path: mediumImage, mimeType: "image/png" })) },
      { prompt: "x".repeat(1024 * 1024) },
      { context: "x".repeat(1024 * 1024) },
    ]) {
      await assert.rejects(runtime.turnStart({ ...input, ...extra }), error => {
        assert.equal(error.code, "GROK_ACP_OUTBOUND_FRAME_TOO_LARGE");
        assert.equal(error.dispatchState, "not_sent");
        assert.ok(error.frameBytes > error.maxFrameBytes);
        assert.equal(error.maxFrameBytes, 1024 * 1024);
        return true;
      });
      assert.equal(runtime.host.ledger.snapshot().sessions[0].turns.length, 0);
      assert.equal(runtime.host.activeTurns.size, 0);
    }
    await assert.rejects(runtime.turnStart({ ...input,
      attachments: [{ path: path.join(fixture.paths.trustedRoot, "missing.png"), mimeType: "image/png" }],
    }));
    assert.equal(runtime.host.ledger.snapshot().sessions[0].turns.length, 0);
    assert.equal(fixture.children[0].messages.filter(message => message.method === "session/prompt").length, 0);
    await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
    await runtime.turnStart({ ...input, operationId: "small-explicit-retry" });
    await waitFor(() => runtime.host.activeTurns.size === 0, "small prompt completion");
    assert.equal(fixture.children[0].messages.filter(message => message.method === "session/prompt").length, 1);
    assert.equal(runtime.host.ledger.snapshot().sessions[0].turns[0].dispatchState, "write_attempted");
    await fixture.adapter.stopAll();
  } finally { fixture.cleanup(); }
});

test("session/new preflight rejects a large MCP frame without leaving a pending-session fence", async () => {
  let large = true;
  const fixture = fixtureOptions(standardServer(), { maxFrameBytes: 1024,
    mcpServersFactory: () => large ? [{ type: "http", name: "test", url: "https://example.com/mcp",
      headers: [{ name: "X-Fixture", value: "x".repeat(1500) }] }] : [],
  });
  try {
    const runtime = await acquire(fixture);
    await assert.rejects(startSession(runtime), {
      code: "GROK_ACP_OUTBOUND_FRAME_TOO_LARGE", dispatchState: "not_sent",
    });
    assert.equal(runtime.host.ledger.snapshot().pendingSessions.length, 0);
    assert.equal(fixture.children[0].messages.filter(message => message.method === "session/new").length, 0);
    large = false;
    await startSession(runtime);
    assert.equal(runtime.host.ledger.snapshot().sessions.length, 1);
    await fixture.adapter.stopAll();
  } finally { fixture.cleanup(); }
});

test("concurrent session creation after asynchronous MCP setup cannot submit the same source twice", async () => {
  let releaseMcp;
  const barrier = new Promise(resolve => { releaseMcp = resolve; });
  let calls = 0;
  const fixture = fixtureOptions(standardServer(), {
    mcpServersFactory: async () => { calls += 1; await barrier; return []; },
  });
  try {
    const runtime = await acquire(fixture);
    const outcomes = Promise.allSettled([startSession(runtime), startSession(runtime)]);
    await waitFor(() => calls === 2, "overlapping MCP factories");
    releaseMcp();
    const results = await outcomes;
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    assert.ok(["RUNTIME_SESSION_ACCEPTANCE_UNKNOWN", "RUNTIME_SESSION_CONFLICT"]
      .includes(results.find(item => item.status === "rejected").reason.code));
    assert.equal(fixture.children[0].messages.filter(message => message.method === "session/new").length, 1);
    assert.equal(runtime.host.ledger.snapshot().pendingSessions.length, 0);
    await fixture.adapter.stopAll();
  } finally { releaseMcp(); fixture.cleanup(); }
});

test("an attempted prompt write failure retains the unknown fence and the underlying cause across restart", async () => {
  const fixture = fixtureOptions(standardServer(message => message.method === "session/prompt"
    ? rpcResult({ stopReason: "end_turn" }) : undefined));
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    let attempts = 0;
    fixture.children[0].stdin.write = () => { attempts += 1; throw new Error("synthetic partial write"); };
    const input = { sessionId: "session-1", operationId: "attempted", prompt: "work" };
    await assert.rejects(runtime.turnStart(input), error => {
      assert.equal(error.code, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
      assert.equal(error.dispatchState, "write_attempted");
      assert.equal(error.cause.code, "GROK_ACP_WRITE_FAILED");
      return true;
    });
    await assert.rejects(runtime.terminated, { code: "GROK_ACP_WRITE_FAILED" });
    const turn = runtime.host.ledger.snapshot().sessions[0].turns[0];
    assert.equal(turn.acceptance, "unknown");
    assert.equal(turn.dispatchState, "write_attempted");
    assert.equal(turn.errorCode, "GROK_ACP_WRITE_FAILED");
    const restarted = await acquire(fixture);
    await assert.rejects(restarted.turnStart(input), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    assert.equal(fixture.children[1].messages.some(message => message.method === "session/prompt"), false);
    // The process that received the attempted write is gone, so a different
    // operation may continue the session; the unknown one is never replayed.
    await restarted.turnStart({ ...input, operationId: "other", prompt: "next" });
    await waitFor(() => restarted.host.activeTurns.size === 0, "other operation completion");
    assert.equal(attempts, 1);
    assert.equal(fixture.children[1].messages.filter(message => message.method === "session/prompt").length, 1);
    await fixture.adapter.stopAll();
  } finally { fixture.cleanup(); }
});

test("an unknown receipt fences other operations only while its receiving process lives", async () => {
  let promptCount = 0;
  const fixture = fixtureOptions(standardServer((message) => {
    if (message.method !== "session/prompt") return undefined;
    promptCount += 1;
    return promptCount === 1 ? NO_RESPONSE : rpcResult({ stopReason: "end_turn" });
  }), { acceptanceTimeoutMs: 20 });
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const input = { sessionId: "session-1", operationId: "unknown-receipt", prompt: "maybe accepted" };
    await assert.rejects(runtime.turnStart(input), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    await assert.rejects(runtime.turnStart({ ...input, operationId: "other" }), {
      code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
    });
    await fixture.adapter.stop("grok-main");
    const restarted = await acquire(fixture);
    const read = await restarted.sessionRead({ sessionId: "session-1", includeTurns: true });
    assert.equal(read.session.turns[0].errorCode, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
    await assert.rejects(restarted.turnStart(input), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    await restarted.turnStart({ ...input, operationId: "other" });
    await waitFor(() => restarted.host.activeTurns.size === 0, "other operation completion");
    assert.equal(promptCount, 2, "the unknown operation itself is never replayed");
    await fixture.adapter.stopAll();
  } finally {
    clearTimeout(keepAlive);
    fixture.cleanup();
  }
});

test("an accepted prompt abandoned by the Host is cancelled natively", async () => {
  let promptCount = 0;
  const cancels = [];
  const fixture = fixtureOptions(standardServer((message, child) => {
    if (message.method === "session/cancel") { cancels.push(message.params.sessionId); return undefined; }
    if (message.method !== "session/prompt") return undefined;
    promptCount += 1;
    setImmediate(() => child.sendNotification("session/update", { sessionId: message.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } } }));
    return promptCount === 1 ? NO_RESPONSE : undefined;
  }), { promptTimeoutMs: 100 });
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const events = [];
    runtime.subscribe((event) => events.push(event));
    await runtime.turnStart({ sessionId: "session-1", operationId: "slow", prompt: "long work" });
    await waitFor(() => events.some((event) => event.type === "complete"), "abandoned prompt terminal");
    assert.equal(events.find((event) => event.type === "complete").status, "interrupted");
    await waitFor(() => cancels.length === 1, "native cancellation");
    assert.deepEqual(cancels, ["session-1"]);
    await fixture.adapter.stopAll();
  } finally {
    clearTimeout(keepAlive);
    fixture.cleanup();
  }
});

test("queued prompt and session/new timeouts are definite local rejections, not unknown acceptance", async () => {
  const fixture = fixtureOptions(standardServer(message => message.method === "session/prompt"
    ? rpcResult({ stopReason: "end_turn" }) : undefined));
  const keepAlive = setTimeout(() => {}, 5_000);
  let releaseQueue;
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    runtime.host.promptTimeoutMs = 500;
    runtime.host.requestTimeoutMs = 500;
    runtime.host.rpc.writeTail = new Promise(resolve => { releaseQueue = resolve; });
    const input = { sessionId: "session-1", operationId: "queued", prompt: "do not send late" };
    const prompt = runtime.turnStart(input);
    const session = startSession(runtime, "chat:queued");
    // Observe both promises immediately, even when other parallel suites make
    // the event loop miss the short test deadline before waitFor can inspect it.
    const outcomes = Promise.allSettled([prompt, session]);
    await waitFor(() => runtime.host.activeTurns.size === 1, "queued active turn");
    fixture.children[0].sendNotification("session/update", { sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale" } },
    });
    const results = await outcomes;
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.code, "GROK_ACP_REQUEST_TIMEOUT");
      assert.equal(result.reason.dispatchState, "not_sent");
    }
    const ledger = runtime.host.ledger.snapshot();
    assert.equal(ledger.pendingSessions.length, 0);
    assert.equal(ledger.sessions[0].turns[0].acceptance, "failed");
    assert.equal(ledger.sessions[0].turns[0].dispatchState, "not_sent");
    await runtime.sessionRead({ sessionId: "session-1", includeTurns: true });
    await assert.rejects(runtime.turnStart(input), { code: "GROK_ACP_REQUEST_TIMEOUT" });
    releaseQueue();
    await new Promise(resolve => setImmediate(resolve));
    runtime.host.promptTimeoutMs = 1_000;
    runtime.host.requestTimeoutMs = 1_000;
    assert.equal(fixture.children[0].messages.filter(message => message.method === "session/prompt").length, 0);
    await runtime.turnStart({ ...input, operationId: "explicit-next" });
    await waitFor(() => runtime.host.activeTurns.size === 0, "explicit retry completion");
    await startSession(runtime, "chat:queued");
    assert.equal(fixture.children[0].messages.filter(message => message.method === "session/new").length, 2);
    await fixture.adapter.stopAll();
  } finally { releaseQueue?.(); clearTimeout(keepAlive); fixture.cleanup(); }
});

test("restart releases only durable not_sent records and requires an explicit new turn operation", async () => {
  let promptCount = 0;
  const fixture = fixtureOptions(standardServer(message => {
    if (message.method !== "session/prompt") return undefined;
    promptCount += 1;
    return rpcResult({ stopReason: "end_turn" });
  }));
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const input = { sessionId: "session-1", operationId: "prepared", prompt: "work" };
    await runtime.turnStart(input);
    await waitFor(() => runtime.host.activeTurns.size === 0, "seed completion");
    const ledgerPath = runtime.host.ledger.ledgerPath;
    await fixture.adapter.stop(binding());
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    Object.assign(ledger.sessions[0].turns[0], {
      acceptance: "unknown", status: "inProgress", dispatchState: "not_sent", errorCode: null,
    });
    ledger.pendingSessions.push(
      { source: "chat:prepared", cwd: "/tmp/workspace", createdAt: 0, dispatchState: "not_sent" },
      { source: "chat:attempted", cwd: "/tmp/workspace", createdAt: 0, dispatchState: "write_attempted" },
    );
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    const restarted = await acquire(fixture);
    const restored = restarted.host.ledger.snapshot();
    assert.equal(restored.sessions[0].turns[0].acceptance, "failed");
    assert.equal(restored.sessions[0].turns[0].errorCode, "RUNTIME_REQUEST_NOT_SENT");
    assert.deepEqual(restored.pendingSessions.map(item => item.source), ["chat:attempted"]);
    await restarted.sessionRead({ sessionId: "session-1", includeTurns: true });
    await assert.rejects(restarted.turnStart(input), { code: "RUNTIME_REQUEST_NOT_SENT" });
    await assert.rejects(startSession(restarted, "chat:attempted"), { code: "RUNTIME_SESSION_ACCEPTANCE_UNKNOWN" });
    assert.equal(promptCount, 1, "opening the ledger must never replay a prompt");
    await restarted.turnStart({ ...input, operationId: "explicit-retry" });
    await waitFor(() => restarted.host.activeTurns.size === 0, "retry completion");
    assert.equal(promptCount, 2);
    await startSession(restarted, "chat:prepared");
    await fixture.adapter.stopAll();
  } finally { fixture.cleanup(); }
});

test("version 2 turn fingerprints bind ordered complete attachment descriptors and the exact image bytes", async () => {
  let promptCount = 0;
  const fixture = fixtureOptions(standardServer(message => {
    if (message.method !== "session/prompt") return undefined;
    promptCount += 1;
    return rpcResult({ stopReason: "end_turn" });
  }));
  try {
    const runtime = await acquire(fixture);
    await startSession(runtime);
    const firstImage = require("./fixtures/native-chat-image.cjs")(fixture.paths.trustedRoot);
    const secondPath = path.join(fixture.paths.trustedRoot, "second.png");
    fs.copyFileSync(firstImage.path, secondPath);
    const attachments = [
      { ...firstImage, name: "first.png", ref: { id: "first", metadata: { alpha: 1, beta: 2 } } },
      { ...firstImage, path: secondPath, name: "second.png", ref: { id: "second" } },
    ];
    const input = { sessionId: "session-1", operationId: "image-operation", prompt: "inspect", attachments };
    const first = await runtime.turnStart(input);
    await waitFor(() => runtime.host.activeTurns.size === 0, "image prompt completion");
    const receipt = runtime.host.ledger.snapshot().sessions[0].turns[0];
    assert.equal(receipt.fingerprintVersion, 2);
    assert.equal(receipt.fingerprint.length, 64);
    assert.equal(JSON.stringify(receipt).includes(firstImage.data), false, "ledger stores no raw image data");
    const reorderedKeys = [
      { ref: { metadata: { beta: 2, alpha: 1 }, id: "first" }, name: "first.png",
        data: firstImage.data, mimeType: firstImage.mimeType, path: firstImage.path },
      { ref: { id: "second" }, name: "second.png", path: secondPath,
        mimeType: firstImage.mimeType, data: firstImage.data },
    ];
    assert.equal((await runtime.turnStart({ ...input, attachments: reorderedKeys })).turn.id, first.turn.id);
    const changes = [
      [{ ...attachments[0], mimeType: "image/jpeg" }, attachments[1]],
      [{ ...attachments[0], data: "changed-inline-data" }, attachments[1]],
      [{ ...attachments[0], ref: { id: "changed" } }, attachments[1]],
      [{ ...attachments[0], path: secondPath }, attachments[1]],
      [{ ...attachments[0], name: "changed.png" }, attachments[1]],
      [attachments[1], attachments[0]],
      [attachments[0]],
      [...attachments, attachments[0]],
    ];
    for (const changed of changes) {
      await assert.rejects(runtime.turnStart({ ...input, attachments: changed }), {
        code: "RUNTIME_OPERATION_CONFLICT",
      });
    }
    const originalBytes = fs.readFileSync(firstImage.path);
    fs.writeFileSync(firstImage.path, Buffer.concat([originalBytes, Buffer.from("different bytes")]), { mode: 0o600 });
    await assert.rejects(runtime.turnStart(input), { code: "RUNTIME_OPERATION_CONFLICT" });
    fs.writeFileSync(firstImage.path, originalBytes, { mode: 0o600 });
    assert.equal(promptCount, 1);
    await fixture.adapter.stop(binding());
    const restarted = await acquire(fixture);
    assert.equal((await restarted.turnStart(input)).turn.id, first.turn.id);
    assert.equal(restarted.host.ledger.snapshot().sessions[0].turns[0].fingerprintVersion, 2);
    await assert.rejects(restarted.turnStart({ ...input, attachments: changes[1] }), {
      code: "RUNTIME_OPERATION_CONFLICT",
    });
    assert.equal(promptCount, 1, "same operation must never be submitted again");
    await fixture.adapter.stopAll();
  } finally { fixture.cleanup(); }
});

for (const version of [2, 3]) test(`ledger schema ${version} is refused without rewriting or dispatching`, async () => {
  const fixture = fixtureOptions(standardServer(message => message.method === "session/prompt" ? rpcResult({ stopReason: "end_turn" }) : undefined));
  try {
    const runtime = await acquire(fixture); await startSession(runtime);
    const ledgerPath = runtime.host.ledger.ledgerPath;
    await fixture.adapter.stop(binding());
    const ledger = JSON.parse(fs.readFileSync(ledgerPath)); ledger.schemaVersion = version;
    const bytes = Buffer.from(JSON.stringify(ledger)); fs.writeFileSync(ledgerPath, bytes);
    await assert.rejects(acquire(fixture), { code: "GROK_BUILD_LEDGER_INVALID" });
    assert.deepEqual(fs.readFileSync(ledgerPath), bytes);
  } finally { await fixture.adapter.stopAll(); fixture.cleanup(); }
});
