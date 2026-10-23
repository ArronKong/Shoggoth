#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");
const test = require("node:test");
const {
  createMcpStdioHandler,
  MCP_STDIO_PROTOCOL_VERSION,
  runMcpStdioSession,
} = require("../app/shoggoth-mcp-helper");

const line = (message) => `${JSON.stringify(message)}\n`;
const request = (id) => ({ jsonrpc: "2.0", id, method: "fixture" });
const reply = ({ id }) => ({ jsonrpc: "2.0", id, result: "transport-canary" });
async function within(promise, ms = 1_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("transport did not settle")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test("a wrapped write(true) retains its frame until the actual write callback", async () => {
  const input = new PassThrough();
  let retained;
  let received;
  let finishedWrite;
  const written = new Promise(resolve => { finishedWrite = resolve; });
  const output = new Writable({
    write(frame, _encoding, callback) {
      retained = frame;
      setTimeout(() => { received = Buffer.from(frame); callback(); finishedWrite(); }, 30);
    },
  });
  const write = output.write;
  // Function arity says nothing about whether a stream implements callbacks.
  output.write = function (chunk) { return write.apply(this, arguments); };
  const running = runMcpStdioSession({ input, output, handler: reply });
  try {
    input.end(line(request(1)));
    await within(running);
    await within(written);
    assert.deepEqual(JSON.parse(received.toString()), reply(request(1)));
    assert.ok(retained.every(byte => byte === 0));
  } finally { input.destroy(); output.destroy(); await running.catch(() => {}); }
});

test("timeout closes an open input, drops queued output and waits for buffer ownership before wiping", async () => {
  const input = new PassThrough();
  const frames = [];
  let completeWrite;
  let completeDestroy;
  const output = new Writable({
    write(frame, _encoding, callback) { frames.push(frame); completeWrite = callback; },
    // Model an asynchronous transport teardown that still owns its pending buffer.
    destroy(_error, callback) { completeDestroy = callback; },
  });
  let finishTool;
  let calls = 0;
  let closed = false;
  const handler = async (message) => {
    calls++;
    if (message.id === 3) await new Promise(resolve => { finishTool = resolve; });
    return reply(message);
  };
  handler.close = () => { closed = true; };
  const running = runMcpStdioSession({ input, output, handler, outputTimeoutMs: 20 });
  const result = running.then(() => null, error => error);
  try {
    input.write([1, 2, 3].map(id => line(request(id))).join(""));
    const error = await within(result);
    assert.equal(error?.code, "MCP_HELPER_OUTPUT_TIMEOUT");
    assert.equal(error?.message, "mcp_helper_output_timeout");
    assert.equal(input.destroyed, true);
    assert.equal(output.destroyed, true);
    assert.equal(closed, true);
    assert.equal(calls, 3);
    assert.equal(frames.length, 1);
    assert.deepEqual(JSON.parse(frames[0].toString()), reply(request(1)));
    completeWrite(new Error("late-private-transport-error"));
    completeWrite = null;
    completeDestroy();
    completeDestroy = null;
    finishTool();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(frames[0].every(byte => byte === 0));
    assert.equal(frames.length, 1);
  } finally {
    finishTool?.();
    completeWrite?.();
    completeDestroy?.();
    input.destroy(); output.destroy();
    await result;
  }
});

test("output failure aborts a pending elicitation without waiting for the client deadline", async () => {
  const input = new PassThrough();
  const output = new Writable({
    write(_frame, _encoding, callback) { setImmediate(() => callback(new Error("private-epipe"))); },
  });
  let clientError;
  const handler = async (_message, { requestClient }) => {
    try { await requestClient("elicitation/create", { message: "fixture" }); }
    catch (error) { clientError = error; }
    return reply(request(1));
  };
  const result = runMcpStdioSession({ input, output, handler, clientRequestTimeoutMs: 60_000 })
    .then(() => null, error => error);
  try {
    input.write(line(request(1)));
    assert.equal((await within(result))?.code, "MCP_HELPER_OUTPUT_FAILED");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clientError?.code, "MCP_HELPER_CLIENT_REQUEST_FAILED");
    assert.equal(input.destroyed, true);
  } finally { input.destroy(); output.destroy(); await result; }
});

async function slowSocketSession({ pauseMs, outputTimeoutMs }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wire-"));
  const socketPath = path.join(root, "mcp.sock");
  const chunks = [];
  let socket;
  let session;
  let resumeTimer;
  const server = net.createServer((connected) => {
    socket = connected;
    const handler = createMcpStdioHandler({
      runtimeProfileId: "wire-fixture", runtimeAccountId: "wire-fixture-account",
      sessionToken: Buffer.alloc(32, 1).toString("base64url"),
      requestService: async () => assert.fail("catalog must not call Service"),
    });
    session = runMcpStdioSession({ input: socket, output: socket, handler, outputTimeoutMs })
      .then(() => null, error => error).finally(() => { handler.close(); socket.end(); });
  });
  const client = new net.Socket();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const received = new Promise((resolve, reject) => {
      client.on("data", chunk => {
        chunks.push(Buffer.from(chunk));
        if (chunk.includes(0)) reject(new Error("NUL bytes in MCP response"));
      });
      client.on("error", reject);
      client.on("close", resolve);
    });
    client.connect(socketPath, () => {
      client.pause();
      const messages = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "slow-reader", version: "1" },
      } }];
      for (let id = 2; id <= 9; id++) messages.push({ jsonrpc: "2.0", id, method: "tools/list" });
      // Keep input open until we receive all replies, just like an MCP client.
      client.write(messages.map(line).join(""));
      resumeTimer = setTimeout(() => client.resume(), pauseMs);
    });
    let newlines = 0;
    client.on("data", chunk => {
      for (const byte of chunk) if (byte === 10) newlines++;
      if (newlines === 9) client.end();
    });
    await within(received, 6_000);
    return { wire: Buffer.concat(chunks), error: await within(session) };
  } finally {
    clearTimeout(resumeTimer);
    client.destroy(); socket?.destroy();
    await session;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("slow socket reader receives initialize and the complete catalog without NUL bytes", async () => {
  // ACP startup can pause reading beyond the old two-second output deadline.
  const { wire, error } = await slowSocketSession({ pauseMs: 2_200 });
  assert.equal(error, null);
  assert.equal(wire.includes(0), false);
  const frames = wire.toString().trim().split("\n").map(JSON.parse);
  assert.equal(frames.length, 9);
  assert.equal(frames[0].result.protocolVersion, MCP_STDIO_PROTOCOL_VERSION);
  for (let i = 1; i < frames.length; i++) {
    assert.equal(frames[i].id, i + 1);
    assert.ok(frames[i].result.tools.length > 0);
    assert.equal(frames[i].result.nextCursor, undefined);
  }
});

test("socket output timeout terminates the session instead of transmitting a wiped frame", async () => {
  const { wire, error } = await slowSocketSession({ pauseMs: 150, outputTimeoutMs: 20 });
  assert.equal(error?.code, "MCP_HELPER_OUTPUT_TIMEOUT");
  assert.equal(wire.includes(0), false);
  const lines = wire.toString().split("\n");
  // A failed transport may end mid-frame; every completed frame must remain valid.
  for (const value of lines.slice(0, -1)) assert.doesNotThrow(() => JSON.parse(value));
});
