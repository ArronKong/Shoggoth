#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const { DeepSeekHarnessJsonlDecoder } = require(path.join(
  ROOT, "app", "agent-service", "deepseek-harness-jsonl.js",
));
const { DeepSeekHarnessProcess } = require(path.join(
  ROOT, "app", "agent-service", "deepseek-harness-process.js",
));
const { DeepSeekHarnessRuntimeAdapter } = require(path.join(
  ROOT, "app", "agent-service", "deepseek-harness-runtime-adapter.js",
));
const { DeepSeekHarnessRuntimePool } = require(path.join(
  ROOT, "app", "agent-service", "deepseek-harness-runtime-pool.js",
));
const {
  DEFAULT_DEEPSEEK_HARNESS_PERMISSION_POLICY,
  parseDeepSeekHarnessVersion,
  prepareDeepSeekHarnessHome,
  supportsDeepSeekHarnessVersion,
} = require(path.join(ROOT, "app", "agent-service", "deepseek-harness-runtime-paths.js"));
const {
  NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));

const MODEL = "deepseek-official/deepseek-v4-flash";
const POLICY = Object.freeze({ approvalPolicy: "on-request", sandbox: "workspace-write" });
let nextPid = 84_000;

class FakeChild extends EventEmitter {
  constructor({ bridge = false, onMessage = null } = {}) {
    super();
    this.pid = ++nextPid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.closed = false;
    this.input = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.input += chunk.toString("utf8");
        let newline;
        while ((newline = this.input.indexOf("\n")) >= 0) {
          const line = this.input.slice(0, newline);
          this.input = this.input.slice(newline + 1);
          if (line) onMessage?.(this, JSON.parse(line));
        }
        callback();
      },
    });
    const barrier = new Writable({
      write: (_chunk, _encoding, callback) => callback(),
      final: (callback) => {
        callback();
        if (bridge) queueMicrotask(() => this.send({
          type: "ready", protocol: "shoggoth-dsh-runtime", protocolVersion: 1,
        }));
      },
    });
    this.stdio = bridge
      ? [this.stdin, this.stdout, this.stderr, barrier]
      : [this.stdin, this.stdout, this.stderr];
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

function success(child, request, data = {}) {
  child.send({
    type: "response",
    id: request.id,
    command: request.command,
    success: true,
    data,
  });
}

function runtimeFixture(behavior = {}) {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-dsh-runtime-"));
  fs.chmodSync(trustedRoot, 0o700);
  const stateDir = path.join(trustedRoot, "state");
  const workspace = path.join(trustedRoot, "workspace");
  const binDir = path.join(trustedRoot, "bin");
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(binDir, { mode: 0o700 });
  const binaryPath = path.join(binDir, "dsh");
  fs.writeFileSync(binaryPath, behavior.nativeBinary ? "native executable fixture\n" : "#!/usr/bin/env node\n",
    { mode: 0o700 });
  const gateCalls = [];
  const gate = {
    reserveMcpServer(input) {
      gateCalls.push(["reserve", structuredClone(input)]);
      if (behavior.mcpUnavailable) throw Object.assign(new Error("fixture MCP credentials unavailable"), { code: "credentials_locked" });
      return {
        reservationId: "a".repeat(64),
        name: "shoggoth",
        command: process.execPath,
        args: [path.join(ROOT, "app", "bootstrap.js"), "--shoggoth-internal-role=mcp"],
        env: [
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
          { name: "SHOGGOTH_RUNTIME_MCP_GATE_NONCE", value: "b".repeat(64) },
        ],
      };
    },
    bindMcpServer(input) { gateCalls.push(["bind", structuredClone(input)]); },
    revokeMcpServer(input) { gateCalls.push(["revoke", structuredClone(input)]); },
  };
  const bridgeMessages = [];
  const bridgeEnvironments = [];
  const serverResponses = [];
  let bridgeChild = null;
  const onBridgeMessage = (child, message) => {
    bridgeMessages.push(structuredClone(message));
    if (message.type === "server_response") {
      serverResponses.push(structuredClone(message));
      return;
    }
    assert.equal(message.type, "request");
    if (message.command === "models/list") {
      behavior.catalogRequests = (behavior.catalogRequests || 0) + 1;
      const reply = () => {
        if (behavior.catalogError) child.send({ type: "response", id: message.id,
          command: message.command, success: false,
          error: { code: behavior.catalogError, message: "fixture catalog failure" } });
        else success(child, message, { models: behavior.noModels ? [] : [{
          model: MODEL, displayName: "DeepSeek V4 Flash", description: "official fixture",
          input: ["text"], isDefault: true, contextWindow: 1_000_000,
        }] });
      };
      if (behavior.holdCatalog) (behavior.catalogReplies ||= []).push(reply);
      else reply();
      return;
    }
    if (message.command === "auth/read") {
      success(child, message, { authenticated: true, credentialPresent: true });
      return;
    }
    if (message.command === "commands/list") {
      success(child, message, { scoped: !!message.params.remoteSessionId, commands: [
        { name: "goal", description: "Manage goal", input: { hint: "[objective]" } },
        { name: "permission", description: "Choose permission mode" },
      ] });
      return;
    }
    if (["session/start", "session/resume", "session/delete", "turn/steer"].includes(message.command)) {
      success(child, message, message.command === "turn/steer" ? { turnId: message.params.turnId } : {});
      return;
    }
    if (message.command === "turn/start") {
      success(child, message, { turnId: message.params.turnId, replayed: false });
      if (message.params.operationId === "operation-complete") {
        setImmediate(() => {
          child.send({
            type: "server_request",
            id: "approval-1",
            method: "item/commandExecution/requestApproval",
            params: { command: "pwd" },
          });
          for (const event of [
            {
              known: true, method: "deepseek-harness/tool_call", type: "tool_start",
              sessionId: message.params.sessionId, turnId: message.params.turnId,
              itemId: "search-1", toolCallId: "search-1",
              tool: {
                kind: "function", name: "web_search", status: "in_progress",
                input: { query: "native agent trajectory" },
              },
            },
            {
              known: true, method: "deepseek-harness/tool_result", type: "tool_result",
              sessionId: message.params.sessionId, turnId: message.params.turnId,
              itemId: "search-1", toolCallId: "search-1",
              tool: {
                kind: "function", name: "web_search", status: "completed",
                success: true, output: "3 results",
              },
            },
            {
              known: true, method: "deepseek-harness/assistant_chunk", type: "text_delta",
              sessionId: message.params.sessionId, turnId: message.params.turnId,
              itemId: "message-1", delta: "done",
            },
            {
              known: true, method: "deepseek-harness/assistant_message", type: "text",
              sessionId: message.params.sessionId, turnId: message.params.turnId,
              itemId: "message-1", text: "done", phase: "final_answer", delivery: "local",
            },
            {
              known: true, method: "deepseek-harness/usage", type: "usage",
              sessionId: message.params.sessionId, turnId: message.params.turnId,
              responseId: "response-1", provider: "deepseek-official", model: "deepseek-v4-flash",
              usage: {
                inputTokens: 11, cachedInputTokens: 2, cacheWriteInputTokens: 1,
                outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 19,
              },
            },
            {
              known: true, method: "deepseek-harness/turn_end", type: "complete",
              sessionId: message.params.sessionId, turnId: message.params.turnId,
              status: "completed",
            },
          ]) child.send({ type: "event", event });
        });
      }
      return;
    }
    if (message.command === "turn/interrupt") {
      success(child, message, {});
      setImmediate(() => child.send({
        type: "event",
        event: {
          known: true, method: "deepseek-harness/turn_end", type: "complete",
          sessionId: bridgeMessages.findLast((entry) => entry.command === "turn/start").params.sessionId,
          turnId: message.params.turnId, status: "interrupted",
        },
      }));
      return;
    }
    if (message.command === "shutdown") {
      success(child, message, {});
      setImmediate(() => child.finish());
      return;
    }
    throw new Error(`unexpected bridge command: ${message.command}`);
  };
  const spawnProcess = (_command, args, options) => {
    if (args.includes("--version")) {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.write("0.1.1-rc.2\n");
        child.finish();
      });
      return child;
    }
    bridgeEnvironments.push({ ...options.env });
    bridgeChild = new FakeChild({ bridge: true, onMessage: onBridgeMessage });
    return bridgeChild;
  };
  const pool = new DeepSeekHarnessRuntimePool({
    paths: { trustedRoot, stateDir },
    binaryPath,
    bridgePath: path.join(ROOT, "resources", "deepseek-harness", "shoggoth-dsh-bridge.mjs"),
    parentEnv: { PATH: path.dirname(process.execPath), ...behavior.parentEnv },
    homedir: trustedRoot,
    mcpGateIssuer: gate,
    spawnProcess,
    killProcessGroup() {},
    requestTimeoutMs: 1_000,
    serverRequestTimeoutMs: 1_000,
    startupTimeoutMs: 1_000,
    shutdownGraceMs: 100,
    killGraceMs: 100,
    now: behavior.now,
  });
  return {
    trustedRoot, stateDir, workspace, pool, gateCalls, bridgeMessages, bridgeEnvironments, serverResponses,
    get bridgeChild() { return bridgeChild; },
    cleanup() { fs.rmSync(trustedRoot, { recursive: true, force: true }); },
  };
}

async function waitFor(predicate, message) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

async function verifyCatalogAndFailureCases() {
  let clock = Date.now();
  const behavior = { now: () => clock, holdCatalog: true };
  const value = runtimeFixture(behavior);
  const adapter = new DeepSeekHarnessRuntimeAdapter({ runtimePool: value.pool });
  const binding = { runtime: "deepseek-harness", runtimeProfileId: "dsh-main",
    runtimeAccountId: NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID };
  try {
    const runtime = await adapter.acquire(binding, { workspace: value.workspace, permissionPolicy: POLICY });
    const first = runtime.modelsList();
    const second = runtime.modelsList();
    await waitFor(() => behavior.catalogRequests === 1, "DSH cold readers share a probe");
    behavior.catalogReplies.shift()();
    await Promise.all([first, second]);
    assert.equal(behavior.catalogRequests, 1);
    const { session } = await runtime.sessionStart({ source: "catalog-known", model: MODEL,
      cwd: value.workspace, permissionPolicy: POLICY });
    await runtime.authenticationState();
    clock += 5 * 60 * 1000;
    await runtime.sessionResume({ sessionId: session.id, model: MODEL,
      cwd: value.workspace, permissionPolicy: POLICY });
    await waitFor(() => behavior.catalogRequests === 2, "DSH starts one background refresh");
    await runtime.sessionResume({ sessionId: session.id, model: MODEL,
      cwd: value.workspace, permissionPolicy: POLICY });
    assert.equal(behavior.catalogRequests, 2);
    let settled = false;
    const changed = runtime.sessionStart({ source: "catalog-unavailable", model: "deepseek-official/missing",
      cwd: value.workspace, permissionPolicy: POLICY }).finally(() => { settled = true; });
    const rejection = assert.rejects(changed, { code: "RUNTIME_MODEL_UNAVAILABLE" });
    await Promise.resolve();
    assert.equal(settled, false);
    behavior.catalogReplies.shift()();
    await rejection;

    // Configuration changes are a different identity, even inside the fresh TTL.
    fs.mkdirSync(runtime.host.home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runtime.host.home, "settings.json"), '{"provider":"fixture"}', { mode: 0o600 });
    const configRefresh = runtime.modelsList();
    await waitFor(() => behavior.catalogRequests === 3, "DSH configuration invalidates catalog");
    behavior.catalogReplies.shift()();
    await configRefresh;
    await runtime.authenticationState();
    clock += 5 * 60 * 1000;
    behavior.catalogError = "RUNTIME_AUTH_REQUIRED";
    await runtime.sessionResume({ sessionId: session.id, model: MODEL,
      cwd: value.workspace, permissionPolicy: POLICY });
    await waitFor(() => behavior.catalogReplies?.length === 1, "DSH held auth failure");
    behavior.catalogReplies.shift()();
    await waitFor(() => runtime.host.profileState.auth === null, "DSH refresh clears authentication");
    behavior.holdCatalog = false;
    await assert.rejects(runtime.sessionResume({ sessionId: session.id, model: MODEL,
      cwd: value.workspace, permissionPolicy: POLICY }), { code: "AUTH_REQUIRED" });
    behavior.catalogError = null;

    const active = await runtime.turnStart({ sessionId: session.id, operationId: "malformed-frame",
      prompt: "fixture", model: MODEL, cwd: value.workspace, permissionPolicy: POLICY });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    value.bridgeChild.stdout.write("not-json\n");
    await waitFor(() => runtime.host.state === "failed", "DSH failed worker exits");
    assert.equal(runtime.host.activeTurns.size, 0);
    const terminal = runtime.host.ledger.snapshot().sessions[0].turns.find((turn) => turn.id === active.turn.id);
    assert.equal(terminal.acceptance, "accepted");
    assert.equal(terminal.status, "interrupted");
    assert.equal(terminal.errorCode, "DEEPSEEK_HARNESS_FRAME_INVALID");
    assert.equal(events.find((event) => event.type === "complete")?.errorCode, "DEEPSEEK_HARNESS_FRAME_INVALID");
  } finally {
    await adapter.stopAll().catch(() => {});
    value.cleanup();
  }

  for (const failure of ["stop", "ledger", "pipe"]) {
    const isolated = runtimeFixture();
    const isolatedAdapter = new DeepSeekHarnessRuntimeAdapter({ runtimePool: isolated.pool });
    try {
      const runtime = await isolatedAdapter.acquire(binding, { workspace: isolated.workspace, permissionPolicy: POLICY });
      const { session } = await runtime.sessionStart({ source: "worker-shutdown", model: MODEL,
        cwd: isolated.workspace, permissionPolicy: POLICY });
      const accepted = await runtime.turnStart({ sessionId: session.id, operationId: "worker-shutdown",
        prompt: "fixture", model: MODEL, cwd: isolated.workspace, permissionPolicy: POLICY });
      const active = runtime.host.activeTurns.get(session.id);
      if (failure === "pipe") {
        const events = [];
        runtime.subscribe(event => events.push(event));
        isolated.bridgeChild.stdin.destroy(Object.assign(new Error("private EPIPE diagnostic"), { code: "EPIPE" }));
        await waitFor(() => runtime.host.state === "failed", "broken input pipe settles the active turn");
        const turn = runtime.host.ledger.snapshot().sessions[0].turns.find(row => row.id === accepted.turn.id);
        assert.equal(turn.status, "interrupted");
        assert.equal(turn.errorCode, "DEEPSEEK_HARNESS_WRITE_FAILED");
        assert.equal(runtime.host.activeTurns.size, 0);
        assert.equal(events.filter(event => event.type === "complete").length, 1);
        assert.equal(JSON.stringify(events).includes("private EPIPE diagnostic"), false);
      } else if (failure === "ledger") {
        runtime.host.ledger.update = () => { throw Object.assign(new Error("fixture disk failure"), { code: "EIO" }); };
        isolated.bridgeChild.finish(1);
        await waitFor(() => runtime.host.state === "failed", "ledger write failure still releases dead worker");
        assert.equal(runtime.host.activeTurns.size, 0);
        await active.terminal.promise;
      } else {
        await runtime.host.stop();
        const turn = runtime.host.ledger.snapshot().sessions[0].turns.find((row) => row.id === accepted.turn.id);
        assert.equal(turn.errorCode, "RUNTIME_HOST_TERMINATED", "a confirmed exit is not a cleanup timeout");
      }
    } finally {
      await isolatedAdapter.stopAll().catch(() => {});
      isolated.cleanup();
    }
  }
  console.log("PASS DeepSeek catalog single-flight/SWR/config/auth and fatal/stop/ledger cleanup");
}

async function verifyControlDiscoveryWithoutMcp() {
  const behavior = { mcpUnavailable: true };
  const value = runtimeFixture(behavior);
  const adapter = new DeepSeekHarnessRuntimeAdapter({ runtimePool: value.pool });
  const binding = { runtime: "deepseek-harness", runtimeProfileId: "dsh-discovery",
    runtimeAccountId: NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID };
  try {
    const control = await adapter.acquire(binding, { permissionPolicy: POLICY });
    assert.equal(control.controlInstance, true);
    assert.deepEqual((await control.modelsList()).data.map(model => model.model), [MODEL]);
    assert.equal((await control.authenticationState()).authenticated, true);
    assert.ok((await control.commandsList({})).commands.some(command => command.name === "goal"));
    assert.deepEqual(value.gateCalls, [], "read-only discovery never reserves execution MCP authority");
    assert.equal(value.bridgeEnvironments[0].SHOGGOTH_DSH_CONTROL_INSTANCE, "1");
    assert.equal(value.bridgeEnvironments[0].SHOGGOTH_RUNTIME_MCP_GATE_NONCE, undefined);
    const patch = fs.readFileSync(control.host.integration.patchPath, "utf8");
    for (const method of ["sessionStart", "sessionResume", "turnStart", "commandExecute"]) {
      await assert.rejects(control[method]({}), { code: "RUNTIME_CAPABILITY_UNSUPPORTED" },
        `control discovery must not authorize ${method}`);
    }

    await assert.rejects(adapter.acquire(binding, { workspace: value.workspace, permissionPolicy: POLICY }),
      { code: "credentials_locked" }, "execution still requires the MCP gate");
    assert.equal(value.gateCalls.filter(([action]) => action === "reserve").length, 1);
    assert.equal(value.bridgeEnvironments.length, 1, "execution cannot spawn when its MCP gate fails");
    assert.equal(fs.readFileSync(control.host.integration.patchPath, "utf8"), patch,
      "control and execution share one stable integration patch");
    assert.equal((await control.modelsList()).data.length, 1, "failed execution does not retire discovery");

    behavior.catalogError = "RUNTIME_MODEL_CATALOG_INVALID";
    control.host.modelCatalogCache.invalidate();
    await assert.rejects(control.modelsList(), { code: "RUNTIME_MODEL_CATALOG_INVALID" },
      "real catalog errors remain visible");
    assert.ok(value.bridgeMessages.every(message => !message.command?.startsWith("session/")
      && !message.command?.startsWith("turn/")), "discovery never starts a session or turn");
    await adapter.stopAll();
    assert.equal(value.gateCalls.some(([action]) => action === "bind" || action === "revoke"), false);
  } finally {
    await adapter.stopAll().catch(() => {});
    value.cleanup();
  }
  console.log("PASS DeepSeek control discovery: no MCP authority, execution gate preserved, catalog errors visible");
}

async function main() {
  await verifyControlDiscoveryWithoutMcp();
  const native = runtimeFixture({ nativeBinary: true });
  const nativeAdapter = new DeepSeekHarnessRuntimeAdapter({ runtimePool: native.pool });
  try {
    const runtime = await nativeAdapter.acquire({ runtime: "deepseek-harness", runtimeProfileId: "dsh-native-entry",
      runtimeAccountId: NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID },
    { workspace: native.workspace, permissionPolicy: POLICY });
    assert.equal(runtime.host.launch.argsPrefix.length, 0);
    assert.equal(native.bridgeEnvironments[0].SHOGGOTH_DSH_ENTRYPOINT, undefined);
    assert.deepEqual((await runtime.modelsList()).data.map(model => model.model), [MODEL]);
  } finally {
    await nativeAdapter.stopAll().catch(() => {});
    native.cleanup();
  }
  await verifyCatalogAndFailureCases();
  const { BridgeRuntime } = await import(pathToFileURL(path.join(
    ROOT, "resources", "deepseek-harness", "shoggoth-dsh-bridge.mjs",
  )).href);
  const startup = [];
  const exits = [];
  const shutdownBridge = new BridgeRuntime({ get(name) {
    if (name === "appReady") return { onReady: callback => startup.push(callback) };
    if (name === "appExit") return code => exits.push(code);
  } });
  shutdownBridge.write = async () => {};
  await shutdownBridge.onRequest({ type: "request", id: "shutdown", command: "shutdown", params: {} });
  shutdownBridge.onInputClosed();
  assert.equal(startup.length, 1, "explicit shutdown and EOF share one exit request");
  assert.deepEqual(exits, [], "shutdown waits for native startup readiness");
  startup[0]();
  assert.deepEqual(exits, [0]);

  const startupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-dsh-startup-"));
  try {
    const bridgeUrl = pathToFileURL(path.join(ROOT, "resources", "deepseek-harness", "shoggoth-dsh-bridge.mjs")).href;
    fs.writeFileSync(path.join(startupRoot, "entry.mjs"), `
      import assert from "node:assert/strict";
      import { BridgeRuntime } from ${JSON.stringify(bridgeUrl)};
      let booted = false;
      let exits = 0;
      const bridge = new BridgeRuntime({ get(name) {
        if (name === "loader") return { await: async () => {} };
        if (name === "appExit") return code => {
          assert.equal(booted, true, "shutdown cannot interrupt CLI top-level startup");
          assert.equal(++exits, 1);
          assert.equal(code, 0);
        };
      } });
      bridge.write = async () => {};
      if (process.argv[2] !== "eof") {
        await bridge.onRequest({ type: "request", id: "shutdown", command: "shutdown", params: {} });
      }
      bridge.onInputClosed();
      await new Promise(resolve => setTimeout(resolve, 10));
      booted = true;
      process.on("exit", () => assert.equal(exits, 1));
    `, { mode: 0o600 });
    // Node resolves a symlinked CLI entry to the same cached ES module.
    const entry = path.join(startupRoot, "cli.mjs");
    fs.symlinkSync("entry.mjs", entry);
    for (const mode of ["shutdown", "eof"]) {
      const result = spawnSync(process.execPath, [entry, mode], {
        encoding: "utf8", timeout: 5_000,
        env: { ...process.env, SHOGGOTH_DSH_ENTRYPOINT: path.join(startupRoot, "entry.mjs") },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
    }
  } finally {
    fs.rmSync(startupRoot, { recursive: true, force: true });
  }
  const bridge = new BridgeRuntime({});
  const nativeAuthFailure = {
    type: "turn/end",
    data: { reason: { kind: "error", error: {
      code: "AUTH", status: 401, message: "Authentication Fails, private-credential-marker",
    } } },
  };
  const authEvent = bridge.mapEvent({ sessionId: "session-auth", turnId: "turn-auth" }, nativeAuthFailure)[0];
  assert.equal(authEvent.status, "failed");
  assert.equal(authEvent.errorCode, "RUNTIME_AUTH_REQUIRED");
  assert.equal(JSON.stringify(authEvent).includes("private-credential-marker"), false);
  for (const error of [{ code: "AUTH" }, { code: "MISSING_CREDENTIAL" }, { status: 401 }]) {
    assert.equal(bridge.mapEvent({}, { type: "turn/end", data: { reason: { kind: "error", error } } })[0]
      .errorCode, "RUNTIME_AUTH_REQUIRED");
  }
  const nonAuth = bridge.mapEvent({}, { type: "turn/end", data: { reason: {
    kind: "error", error: { code: "NETWORK", status: 503, message: "private-credential-marker" },
  } } })[0];
  assert.equal(nonAuth.status, "failed");
  assert.equal(nonAuth.errorCode, "NETWORK");
  assert.equal(JSON.stringify(nonAuth).includes("private-credential-marker"), false);
  for (const [kind, status] of [["completed", "completed"], ["max-tokens", "completed"], ["aborted", "interrupted"]]) {
    const event = bridge.mapEvent({}, { type: "turn/end", data: { reason: { kind } } })[0];
    assert.equal(event.status, status);
    assert.equal(event.errorCode, undefined);
  }
  const failedEvents = [];
  bridge.write = async (event) => { failedEvents.push(event); };
  await bridge.failTurn({ sessionId: "session-auth", turnId: "turn-auth" }, { code: "AUTH", status: 401 });
  assert.equal(failedEvents[0].event.errorCode, "RUNTIME_AUTH_REQUIRED");

  assert.deepEqual(DEFAULT_DEEPSEEK_HARNESS_PERMISSION_POLICY, {
    approvalPolicy: "on-request",
    sandbox: "danger-full-access",
  });
  assert.deepEqual(parseDeepSeekHarnessVersion("0.1.1-rc.2\n"), [0, 1, 1]);
  assert.equal(supportsDeepSeekHarnessVersion("0.1.1-rc.2"), true);
  assert.equal(supportsDeepSeekHarnessVersion("0.1.0"), false);
  assert.equal(parseDeepSeekHarnessVersion("not-a-version"), null);

  const decoder = new DeepSeekHarnessJsonlDecoder();
  assert.deepEqual(decoder.push(Buffer.from('{"type":"ready"}\n')), [{ type: "ready" }]);
  assert.throws(
    () => new DeepSeekHarnessJsonlDecoder().push(Buffer.from("not-json\n")),
    (error) => error?.code === "DEEPSEEK_HARNESS_FRAME_INVALID",
  );

  const approvalResponses = [];
  const approvalChild = new FakeChild({
    onMessage: (_child, message) => approvalResponses.push(structuredClone(message)),
  });
  let resolveApproval;
  const approvalProcess = new DeepSeekHarnessProcess({
    child: approvalChild,
    serverRequestTimeoutMs: 100,
    onServerRequest: () => new Promise((resolve) => { resolveApproval = resolve; }),
  });
  approvalChild.send({
    type: "server_request",
    id: "approval-unbounded",
    method: "item/commandExecution/requestApproval",
    params: { command: "pwd" },
  });
  await waitFor(() => typeof resolveApproval === "function", "approval handler was not called");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(approvalResponses.length, 0);
  resolveApproval({ decision: "accept" });
  await waitFor(() => approvalResponses.length === 1, "approval response was not written");
  assert.equal(approvalResponses[0].data.decision, "accept");
  approvalProcess.kill("SIGTERM");

  const confirmationResponses = [];
  const confirmationChild = new FakeChild({
    onMessage: (_child, message) => confirmationResponses.push(structuredClone(message)),
  });
  let resolveConfirmation;
  const confirmationProcess = new DeepSeekHarnessProcess({
    child: confirmationChild,
    serverRequestTimeoutMs: 100,
    onServerRequest: () => new Promise((resolve) => { resolveConfirmation = resolve; }),
  });
  confirmationChild.send({
    type: "server_request",
    id: "product-confirmation-unbounded",
    method: "mcpServer/elicitation/request",
    params: {
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
  });
  await waitFor(() => typeof resolveConfirmation === "function", "confirmation handler was not called");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(confirmationResponses.length, 0);
  resolveConfirmation({
    action: "accept", content: { confirm_product_action: "确认执行" },
  });
  await waitFor(() => confirmationResponses.length === 1, "confirmation response was not written");
  assert.equal(confirmationResponses[0].data.content.confirm_product_action, "确认执行");
  confirmationProcess.kill("SIGTERM");

  const value = runtimeFixture({ parentEnv: { SHOGGOTH_DSH_CONTROL_INSTANCE: "1" } });
  const adapter = new DeepSeekHarnessRuntimeAdapter({ runtimePool: value.pool });
  try {
    const home = prepareDeepSeekHarnessHome({
      trustedRoot: value.trustedRoot,
      stateDir: value.stateDir,
    }, "profile-check", {
      bridgePath: path.join(ROOT, "resources", "deepseek-harness", "shoggoth-dsh-bridge.mjs"),
    });
    const profileRoot = path.join(home, "profiles", "shoggoth");
    const profile = JSON.parse(fs.readFileSync(path.join(profileRoot, "package.json"), "utf8"));
    const patchText = fs.readFileSync(path.join(profileRoot, "cordis.patch.yml"), "utf8");
    assert.deepEqual(profile.dsh.profile.bundles, ["@deepseek-ai/dsh-base"]);
    assert.match(patchText, /@deepseek-ai\/dsh-mcp-client/u);
    assert.match(patchText, /shoggoth-dsh-bridge\.mjs/u);
    assert.match(patchText, /official installation/u);
    assert.match(patchText, /- id: permission/u);
    assert.match(patchText, /defaultPreset: !!js process\.env\.DSH_PERMISSION_MODE/u);
    assert.match(patchText, /approval: !!js process\.env\.SHOGGOTH_DSH_APPROVAL_POLICY/u);

    const runtime = await adapter.acquire({
      runtime: "deepseek-harness", runtimeProfileId: "dsh-main",
      runtimeAccountId: NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
    }, { workspace: value.workspace, permissionPolicy: POLICY });
    assert.equal(value.bridgeEnvironments[0].SHOGGOTH_DSH_CONTROL_INSTANCE, "0",
      "execution overrides a parent discovery-only flag");
    assert.equal(JSON.parse(value.bridgeEnvironments[0].SHOGGOTH_DSH_MCP_CONFIG).failOnStartupError, true);
    const events = [];
    runtime.subscribe((event) => events.push(structuredClone(event)));
    runtime.registerServerRequestHandler(
      "item/commandExecution/requestApproval",
      () => ({ decision: "accept" }),
    );
    assert.equal((await runtime.authenticationState()).authenticated, true);
    assert.deepEqual((await runtime.modelsList()).data.map((model) => model.model), [MODEL]);
    assert.equal((await runtime.modelsList()).data[0].contextWindow, 1_000_000);
    const commands = await runtime.commandsList({ cwd: value.workspace });
    assert.equal(commands.commands.find((command) => command.name === "goal").args, "[objective]");
    assert.equal(commands.commands.find((command) => command.name === "permission").execution, "client");
    assert.deepEqual(await runtime.commandExecute({ text: "/goal", cwd: value.workspace }),
      { kind: "send", text: "/goal", warning: null });
    await assert.rejects(runtime.commandExecute({ text: "/permission full", cwd: value.workspace }),
      { code: "RUNTIME_COMMAND_CLIENT_REQUIRED" });
    assert.equal((await runtime.sessionList({ archived: false })).data.length, 0);
    const started = await runtime.sessionStart({
      source: "unit-session", cwd: value.workspace, developerInstructions: "Use Shoggoth skills.",
      model: MODEL, permissionPolicy: POLICY,
    });
    const sessionId = started.session.id;
    const first = await runtime.turnStart({
      sessionId, operationId: "operation-complete", prompt: "finish",
      cwd: value.workspace, model: MODEL, permissionPolicy: POLICY,
    });
    await waitFor(
      () => events.some((event) => event.type === "complete" && event.turnId === first.turn.id),
      "completed turn event was not published",
    );
    await waitFor(() => value.serverResponses.length === 1, "server request was not answered");
    assert.equal(value.serverResponses[0].data.decision, "accept");
    assert.deepEqual(events.find((event) => event.type === "tool_start")?.tool.input, {
      query: "native agent trajectory",
    });
    assert.equal(events.find((event) => event.type === "tool_result")?.tool.output, "3 results");
    const read = await runtime.sessionRead({ sessionId, includeTurns: true });
    assert.equal(read.session.turns[0].status, "completed");
    assert.equal(read.session.turns[0].items.at(-1).text, "done");

    const active = await runtime.turnStart({
      sessionId, operationId: "operation-active", prompt: "wait",
      cwd: value.workspace, model: MODEL, permissionPolicy: POLICY,
    });
    assert.deepEqual(await runtime.turnSteer({
      sessionId, turnId: active.turn.id, operationId: "steer-1", message: "continue",
    }), { turnId: active.turn.id });
    await runtime.turnInterrupt({ sessionId, turnId: active.turn.id });
    const afterInterrupt = await runtime.sessionRead({ sessionId, includeTurns: true });
    assert.equal(afterInterrupt.session.turns[1].status, "interrupted");
    const failed = await runtime.turnStart({
      sessionId, operationId: "operation-auth-failure", prompt: "check authentication",
      cwd: value.workspace, model: MODEL, permissionPolicy: POLICY,
    });
    for (const event of bridge.mapEvent({ sessionId, turnId: failed.turn.id }, nativeAuthFailure)) {
      value.bridgeChild.send({ type: "event", event });
    }
    const afterFailure = await runtime.sessionRead({ sessionId, includeTurns: true });
    assert.equal(afterFailure.session.turns[2].status, "failed");
    assert.equal(afterFailure.session.turns[2].errorCode, "RUNTIME_AUTH_REQUIRED",
      "terminal reconciliation must retain the native authentication error");
    assert.equal(runtime.host.profileState.auth, null, "a native auth failure invalidates cached readiness");
    const persisted = JSON.parse(fs.readFileSync(runtime.host.ledger.ledgerPath, "utf8"));
    assert.equal(persisted.sessions[0].turns[2].errorCode, "RUNTIME_AUTH_REQUIRED");
    assert.equal(JSON.stringify(persisted).includes("private-credential-marker"), false);
    await runtime.sessionRename({ sessionId, name: "Renamed" });
    await runtime.sessionArchive({ sessionId });
    assert.equal((await runtime.sessionList({ archived: true })).data[0].name, "Renamed");
    await runtime.sessionUnarchive({ sessionId });
    await runtime.sessionResume({
      sessionId, cwd: value.workspace, developerInstructions: "Use Shoggoth skills.",
      model: MODEL, permissionPolicy: POLICY,
    });
    await runtime.sessionDelete({ sessionId });
    assert.deepEqual((await runtime.sessionList()).data, []);
    assert.equal(value.gateCalls[0][0], "reserve");
    assert.equal(value.gateCalls[1][0], "bind");
    assert.equal(value.gateCalls[1][1].parentPid, value.bridgeChild.pid);
  } finally {
    await adapter.stopAll().catch(() => {});
    value.cleanup();
  }
  console.log("PASS DeepSeek runtime: profile/jsonl/process/session/turn/models/auth/MCP");
}

module.exports = { runtimeFixture, MODEL, POLICY };

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
