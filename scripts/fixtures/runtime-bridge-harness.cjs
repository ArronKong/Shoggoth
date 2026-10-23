"use strict";

// A real Agent Service, a fake Runtime host and a scripted MCP client that reaches the
// Service through the same bridge socket every non-Codex Runtime uses. The client
// declares no MCP capabilities, so nothing here depends on how a CLI forwards elicitation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { createAgentService, PROTOCOL_VERSION } = require("../../app/agent-service/server");
const { resolveServicePaths } = require("../../app/agent-service/paths");
const { MCP_STDIO_PROTOCOL_VERSION } = require("../../app/shoggoth-mcp-helper");
const { FakeHost } = require("../shoggoth-work-run-coordinator-unit.cjs");

function conversation(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const frames = [];
    let buffer = "";
    let waiter = null;
    socket.on("error", error => { reject(error); waiter?.reject(error); });
    socket.on("data", bytes => {
      buffer += bytes.toString();
      for (let end; (end = buffer.indexOf("\n")) !== -1;) {
        const value = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (waiter) { const current = waiter; waiter = null; current.resolve(value); }
        else frames.push(value);
      }
    });
    socket.once("connect", () => resolve({
      send: value => socket.write(`${JSON.stringify(value)}\n`),
      next: (timeoutMs = 5000) => frames.length ? Promise.resolve(frames.shift()) : new Promise((yes, no) => {
        const timer = setTimeout(() => { waiter = null; no(new Error("bridge response timed out")); }, timeoutMs);
        waiter = { resolve: value => { clearTimeout(timer); yes(value); },
          reject: error => { clearTimeout(timer); no(error); } };
      }),
      close: () => socket.destroy(),
    }));
  });
}

async function waitUntil(condition, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// serviceOptions may be an object or a function of the fixture root.
async function openBridgeFixture({ serviceOptions = {}, mcpProductToolController } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgbridge-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile"),
    userDataRoot: path.join(root, "data") });
  let bridgeRunId = null;
  const host = new FakeHost([]);
  const service = createAgentService({ paths, version: "runtime-bridge-fixture", parentEnv: {},
    prewarmMcpAuth: false,
    runtimePool: { async get() { return host; }, async stop() {}, async stopAll() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => value.toString() },
    runtimeMcpGateIssuer: { open() { return this; }, close() {},
      createMcpServer() { throw new Error("fixture does not launch real runtimes"); },
      consume() { return { consumed: true, executionRunId: bridgeRunId }; } },
    ...(mcpProductToolController ? { mcpProductToolController } : {}),
    ...(typeof serviceOptions === "function" ? serviceOptions(root) : serviceOptions),
  });
  await service.start();
  const profile = service.productStore.listAgentProfiles()[0];
  const session = service.chatSessionStore.createSession({ operationId: "bridge-fixture-session",
    profileId: profile.id, workspace: root, createdAt: Date.now() });
  const ack = await service.workRunCoordinator.send({ operationId: "bridge-fixture-run",
    sessionKey: session.sessionKey, prompt: "local fixture only" });
  await service.workRunCoordinator.waitForIdle(ack.run.id);
  assert.equal(service.workRunCoordinator.getRun(ack.run.id).status, "running");
  bridgeRunId = ack.run.id;
  const connection = await conversation(paths.socketPath);
  connection.send({ version: PROTOCOL_VERSION, method: "mcp.runtime.bridge.open", params: {
    runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
    gatePath: path.join(paths.runtimeDir, "fixture.gate"), nonce: "a".repeat(64), parentPid: process.pid,
  } });
  assert.deepEqual(await connection.next(), { ok: true, result: { bridged: true } });
  connection.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: {},
    clientInfo: { name: "no-elicitation-runtime", version: "1" },
  } });
  assert.equal((await connection.next()).result.protocolVersion, MCP_STDIO_PROTOCOL_VERSION);
  const run = () => service.workRunCoordinator.getRun(ack.run.id);
  const events = [];
  service.workRunCoordinator.subscribeRun(ack.run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
  let sequence = 10;
  const callTool = (name, args, timeoutMs) => {
    const id = ++sequence;
    connection.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const response = connection.next(timeoutMs);
    response.catch(() => {}); // a test may deliberately close the bridge instead of reading the reply
    return { id, response };
  };
  // Answers the pending confirmation card the way the user would.
  const answer = async (action, answers) => {
    await waitUntil(() => ["waiting_approval", "waiting_input"].includes(run().status), "the user prompt");
    const requestId = run().waitingRequestId;
    await service.workRunCoordinator.respondInput({ operationId: `answer-${++sequence}`, runId: ack.run.id,
      requestId, action, answers });
    await waitUntil(() => run().status === "running", "run to resume");
    return requestId;
  };
  const confirm = () => answer("submit", { confirm_product_action: "确认执行" });
  // The trusted work source every Computer/Browser tool must name.
  const source = { source: "chat", sourceId: session.sessionKey };
  return { service, root, paths, connection, run, events, callTool, answer, confirm, source, profile, session,
    close: async () => { connection.close(); await service.stop({ notify: false });
      fs.rmSync(root, { recursive: true, force: true }); } };
}

module.exports = { openBridgeFixture, waitUntil };
