#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { MCP_STDIO_PROTOCOL_VERSION } = require("../app/shoggoth-mcp-helper");
const { FakeHost } = require("./shoggoth-work-run-coordinator-unit.cjs");

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
      next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise((yes, no) => {
        const timer = setTimeout(() => { waiter = null; no(new Error("bridge response timed out")); }, 2000);
        waiter = { resolve: value => { clearTimeout(timer); yes(value); },
          reject: error => { clearTimeout(timer); no(error); } };
      }),
      close: () => socket.destroy(),
    }));
  });
}

test("parallel bridges retain independent tokens and terminal authority never revives for another run", async () => {
  const root = fs.mkdtempSync("/tmp/sgmbi-");
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  let calls = 0;
  let bridgeRunId = null;
  const host = new FakeHost([]);
  const service = createAgentService({ paths, version: "bridge-isolation-fixture",
    runtimePool: { async get() { return host; }, async stop() {}, async stopAll() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => value.toString() },
    runtimeMcpGateIssuer: { open() { return this; }, close() {},
      createMcpServer() { throw new Error("fixture does not launch real runtimes"); },
      consume() { return { consumed: true, executionRunId: bridgeRunId }; } },
    mcpProductToolController: { async handle(name) {
      assert.equal(name, "app_status"); calls += 1; return { fixture: true };
    } },
  });
  let bridge;
  let secondBridge;
  try {
    await service.start();
    const profile = service.productStore.listAgentProfiles()[0];
    const session = service.chatSessionStore.createSession({ operationId: "bridge-fixture-session",
      profileId: profile.id, workspace: root, createdAt: Date.now() });
    const secondWorkspace = path.join(root, "second-workspace");
    fs.mkdirSync(secondWorkspace);
    const secondSession = service.chatSessionStore.createSession({ operationId: "bridge-second-session",
      profileId: profile.id, workspace: secondWorkspace, createdAt: Date.now() });
    const start = async (operationId, selectedSession = session) => {
      const ack = await service.workRunCoordinator.send({ operationId,
        sessionKey: selectedSession.sessionKey, prompt: "local fixture only" });
      await service.workRunCoordinator.waitForIdle(ack.run.id);
      assert.equal(service.workRunCoordinator.getRun(ack.run.id).status, "running");
      return ack.run.id;
    };
    const openBridge = async runId => {
      bridgeRunId = runId;
      const connection = await conversation(paths.socketPath);
      connection.send({ version: PROTOCOL_VERSION, method: "mcp.runtime.bridge.open", params: {
        runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
        gatePath: path.join(paths.runtimeDir, "fixture.gate"), nonce: "a".repeat(64), parentPid: process.pid,
      } });
      assert.deepEqual(await connection.next(), { ok: true, result: { bridged: true } });
      connection.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: "isolation-fixture", version: "1" },
      } });
      assert.equal((await connection.next()).result.protocolVersion, MCP_STDIO_PROTOCOL_VERSION);
      return connection;
    };
    const firstRunId = await start("bridge-run-one");
    bridge = await openBridge(firstRunId);
    const call = async (id, connection = bridge) => {
      connection.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "app_status", arguments: {} } });
      return connection.next();
    };
    assert.equal((await call(2)).result.isError, false);
    assert.equal(calls, 1);
    const secondRunId = await start("bridge-run-two", secondSession);
    secondBridge = await openBridge(secondRunId);
    assert.equal((await call(3)).result.isError, false, "opening another bridge must not revoke the first token");
    assert.equal((await call(2, secondBridge)).result.isError, false);
    assert.equal(calls, 3);
    await service.workRunCoordinator.abort({ operationId: "cancel-first", sessionKey: session.sessionKey,
      runId: firstRunId });
    const afterTerminal = await call(4);
    assert.equal(afterTerminal.result?.isError === true || Boolean(afterTerminal.error), true,
      "a terminal run's established bridge must not reach the product controller");
    assert.equal(calls, 3);
    assert.equal((await call(3, secondBridge)).result.isError, false, "canceling run one must preserve run two's bridge");
    const thirdRunId = await start("bridge-run-three");
    const duringNextRun = await call(5);
    assert.equal(duringNextRun.result?.isError === true || Boolean(duringNextRun.error), true,
      "starting another run must not reactivate the completed run's bridge");
    assert.equal(calls, 4);
    await service.workRunCoordinator.abort({ operationId: "cancel-second", sessionKey: secondSession.sessionKey,
      runId: secondRunId });
    await service.workRunCoordinator.abort({ operationId: "cancel-third", sessionKey: session.sessionKey,
      runId: thirdRunId });
  } finally {
    bridge?.close();
    secondBridge?.close();
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
