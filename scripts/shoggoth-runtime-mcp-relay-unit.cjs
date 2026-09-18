#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Readable, Writable } = require("node:stream");
const {
  RUNTIME_MCP_BRIDGE_TIMEOUT_MS,
  openRuntimeMcpBridge,
  startRuntimeMcpRelay,
} = require("../app/runtime-mcp-relay");
const {
  SERVICE_PROTOCOL_VERSION,
} = require("../app/agent-service/service-protocol-version");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-mcp-relay-"));
let fixtureIndex = 0;

function expectedOpenFrame(context) {
  return `${JSON.stringify({
    version: SERVICE_PROTOCOL_VERSION,
    method: "mcp.runtime.bridge.open",
    params: {
      runtimeProfileId: context.runtimeProfileId,
      runtimeAccountId: context.runtimeAccountId,
      gatePath: context.gatePath,
      nonce: context.nonce,
      parentPid: context.parentPid,
    },
  })}\n`;
}

async function createBridgeFixture(ackFrame, ackDelayMs = 0) {
  fixtureIndex += 1;
  const runtimeDir = path.join(root, `run-${fixtureIndex}`);
  const socketPath = path.join(runtimeDir, "service.sock");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  const context = Object.freeze({
    gatePath: path.join(root, `mcp-${"ab".repeat(32)}.gate`),
    nonce: "cd".repeat(32),
    parentPid: 9527,
    runtimeProfileId: "runtime-grok",
    runtimeAccountId: "runtime-grok-account",
    servicePaths: Object.freeze({
      trustedRoot: root,
      stateDir: path.join(root, "state"),
      mcpAuthPath: path.join(root, "state", "mcp-auth.json"),
      runtimeDir,
      socketPath,
    }),
  });
  const sockets = new Set();
  let resolveHandshake;
  let rejectHandshake;
  const handshake = new Promise((resolve, reject) => {
    resolveHandshake = resolve;
    rejectHandshake = reject;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      socket.off("data", onData);
      try {
        assert.equal(buffered.subarray(0, newline + 1).toString("utf8"), expectedOpenFrame(context));
        assert.equal(buffered.length, newline + 1, "relay data must wait for the ACK");
        if (ackFrame !== null) {
          if (ackDelayMs > 0) {
            setTimeout(() => { if (!socket.destroyed) socket.write(ackFrame); }, ackDelayMs);
          } else {
            socket.write(ackFrame);
          }
        }
        resolveHandshake(socket);
      } catch (error) {
        rejectHandshake(error);
        socket.destroy();
      }
    };
    socket.on("data", onData);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  return {
    context,
    handshake,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

class SlowCollector extends Writable {
  constructor() {
    super({ highWaterMark: 16 });
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    setImmediate(callback);
  }

  bytes() {
    return Buffer.concat(this.chunks);
  }
}

(async () => {
  try {
    assert.equal(RUNTIME_MCP_BRIDGE_TIMEOUT_MS, 10_000);
    const success = await createBridgeFixture('{"ok":true,"result":{"bridged":true}}\n');
    try {
      const bridge = await openRuntimeMcpBridge(success.context, { timeoutMs: 500 });
      assert.equal(bridge.runtimeProfileId, success.context.runtimeProfileId);
      assert.equal(bridge.runtimeAccountId, success.context.runtimeAccountId);
      const peer = await success.handshake;
      const clientFrame = Buffer.from(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { padding: "x".repeat(128 * 1024) },
      })}\n`);
      const serverFrame = Buffer.from(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { padding: "y".repeat(128 * 1024) },
      })}\n`);
      let fromRelay = Buffer.alloc(0);
      peer.on("data", (chunk) => {
        fromRelay = Buffer.concat([fromRelay, chunk]);
        if (fromRelay.length === clientFrame.length) peer.end(serverFrame);
      });
      const input = Readable.from([
        clientFrame.subarray(0, 17),
        clientFrame.subarray(17),
      ]);
      const output = new SlowCollector();
      await startRuntimeMcpRelay({ socket: bridge.socket, input, output });
      assert.deepEqual(fromRelay, clientFrame);
      assert.deepEqual(output.bytes(), serverFrame);
    } finally {
      await success.close();
    }

    const deferredAck = await createBridgeFixture(
      '{"ok":true,"result":{"bridged":true}}\n',
      50,
    );
    try {
      let settled = false;
      const opening = openRuntimeMcpBridge(deferredAck.context).finally(() => { settled = true; });
      await deferredAck.handshake;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(settled, false, "bridge must remain pending until the complete ACK arrives");
      const bridge = await opening;
      bridge.socket.destroy();
    } finally {
      await deferredAck.close();
    }

    const failedAck = await createBridgeFixture(
      '{"id":null,"ok":false,"error":{"code":"RUNTIME_MCP_GATE_INVALID","message":"invalid"}}\n',
    );
    try {
      await assert.rejects(
        openRuntimeMcpBridge(failedAck.context, { timeoutMs: 500 }),
        { code: "MCP_RELAY_ACK_INVALID" },
      );
      await failedAck.handshake;
    } finally {
      await failedAck.close();
    }

    const reorderedAck = await createBridgeFixture(
      '{"result":{"bridged":true},"ok":true}\n',
    );
    try {
      await assert.rejects(
        openRuntimeMcpBridge(reorderedAck.context, { timeoutMs: 500 }),
        { code: "MCP_RELAY_ACK_INVALID" },
        "the success ACK must match the locked byte-level frame",
      );
      await reorderedAck.handshake;
    } finally {
      await reorderedAck.close();
    }

    const timeout = await createBridgeFixture(null);
    try {
      await assert.rejects(
        openRuntimeMcpBridge(timeout.context, { timeoutMs: 25 }),
        { code: "MCP_RELAY_BRIDGE_TIMEOUT" },
      );
      await timeout.handshake;
    } finally {
      await timeout.close();
    }

    const input = new PassThrough();
    const output = new PassThrough();
    const { runtimeAccountId: _runtimeAccountId, ...legacyContext } = success.context;
    await assert.rejects(
      openRuntimeMcpBridge(legacyContext),
      { code: "MCP_RELAY_CONTEXT_INVALID" },
      "legacy profile-only relay contexts must fail closed",
    );
    await assert.rejects(
      startRuntimeMcpRelay({ socket: { destroyed: true }, input, output }),
      { code: "MCP_RELAY_OPTIONS_INVALID" },
    );
    console.log("PASS runtime MCP bridge relay");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
