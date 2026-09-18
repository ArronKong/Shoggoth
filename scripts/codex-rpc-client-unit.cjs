#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { CodexJsonlRpcClient } = require("../app/agent-service/codex-jsonl-rpc");
const {
  DEFAULT_MAX_REGISTERED_SECRETS,
  DEFAULT_MAX_REGISTERED_SECRET_BYTES,
} = require("../app/agent-service/codex-rpc-safety");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeChild extends EventEmitter {
  constructor(stdin = new PassThrough()) {
    super();
    this.stdin = stdin;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = 4242;
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  close(code = 0, signal = null) {
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

class ControlledStdin extends EventEmitter {
  constructor({ backpressure = false } = {}) {
    super();
    this.writable = true;
    this.backpressure = backpressure;
    this.calls = [];
  }

  write(frame, _encoding, callback) {
    this.calls.push({ frame, callback });
    return !this.backpressure;
  }

  finish(index = 0, error = null) {
    this.calls[index].callback(error);
  }

  end() { this.writable = false; }
}

function readLines(stream) {
  const lines = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      lines.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  return lines;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code, `expected ${code}`);
}

async function testOutOfOrderNotificationAndServerRequest() {
  const child = new FakeChild();
  const writes = readLines(child.stdin);
  const diagnostics = [];
  const rpc = new CodexJsonlRpcClient(child, {
    requestTimeoutMs: 100,
    serverRequestTimeoutMs: 100,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  rpc.registerServerRequestHandler("approval/ask", async (params, context) => ({
    decision: params.kind,
    requestId: context.id,
  }));
  const seen = [];
  const unsubscribe = rpc.subscribe((message) => seen.push(message.method));
  const first = rpc.request("first", { order: 1 });
  const second = rpc.request("second", { order: 2 });
  await delay(0);
  assert.deepEqual(writes.slice(0, 2).map((message) => message.id), [1, 2]);
  child.send({ id: 2, result: "two" });
  child.send({ method: "turn/started", params: { threadId: "t", turn: { id: "u" } } });
  child.send({ id: "server-1", method: "approval/ask", params: { kind: "allow" } });
  child.send({ id: 1, result: "one" });
  assert.equal(await second, "two");
  assert.equal(await first, "one");
  await delay(0);
  assert.deepEqual(seen, ["turn/started"]);
  assert.deepEqual(writes[2], { id: "server-1", result: { decision: "allow", requestId: "server-1" } });
  assert.deepEqual(diagnostics, []);
  unsubscribe();
  await rpc.terminate("test complete");
}

async function testUnknownAndDuplicateResponseIdsFailClosed() {
  {
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, { requestTimeoutMs: 100 });
    const pending = rpc.request("pending", {});
    child.send({ id: 999, result: {} });
    await rejectsCode(pending, "RPC_UNKNOWN_RESPONSE_ID");
    await rejectsCode(rpc.terminated, "RPC_UNKNOWN_RESPONSE_ID");
  }
  {
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, { requestTimeoutMs: 100 });
    const request = rpc.request("once", {});
    child.send({ id: 1, result: "ok" });
    assert.equal(await request, "ok");
    child.send({ id: 1, result: "again" });
    await rejectsCode(rpc.terminated, "RPC_DUPLICATE_RESPONSE");
  }
}

async function testServerRequestFallbackAndSanitizedFailures() {
  const child = new FakeChild();
  const writes = readLines(child.stdin);
  const rpc = new CodexJsonlRpcClient(child, {
    requestTimeoutMs: 100,
    serverRequestTimeoutMs: 15,
  });
  rpc.registerServerRequestHandler("throws", async () => {
    throw new Error("secret-handler-error sk-proj-should-not-leak");
  });
  rpc.registerServerRequestHandler("hangs", async () => new Promise(() => {}));
  child.send({ id: 7, method: "missing", params: { secret: "do-not-leak" } });
  child.send({ id: 8, method: "throws", params: { secret: "do-not-leak" } });
  child.send({ id: 9, method: "hangs", params: { secret: "do-not-leak" } });
  await delay(30);
  assert.deepEqual(writes, [
    { id: 7, error: { code: -32601, message: "Method not found" } },
    { id: 8, error: { code: -32603, message: "Server request handler failed" } },
    { id: 9, error: { code: -32603, message: "Server request handler timed out" } },
  ]);
  assert.equal(JSON.stringify(writes).includes("do-not-leak"), false);
  assert.equal(JSON.stringify(writes).includes("should-not-leak"), false);
  await rpc.terminate("test complete");
}

async function testServerRequestHandlerCanWaitWithoutDeadline() {
  const child = new FakeChild();
  const writes = readLines(child.stdin);
  const rpc = new CodexJsonlRpcClient(child, {
    requestTimeoutMs: 100,
    serverRequestTimeoutMs: 15,
  });
  let resolveApproval;
  const approval = new Promise((resolve) => { resolveApproval = resolve; });
  rpc.registerServerRequestHandler("approval/wait", async () => approval, { timeoutMs: null });
  child.send({ id: "approval-1", method: "approval/wait", params: {} });
  await delay(30);
  assert.deepEqual(writes, [], "unbounded approval must not emit a timeout response");
  resolveApproval({ decision: "accept" });
  await delay(0);
  assert.deepEqual(writes, [{ id: "approval-1", result: { decision: "accept" } }]);
  await rpc.terminate("test complete");
}

async function testAbortTimeoutAndWaiters() {
  const child = new FakeChild();
  const rpc = new CodexJsonlRpcClient(child, { requestTimeoutMs: 15 });
  const controller = new AbortController();
  const canceled = rpc.request("cancel-me", {}, { signal: controller.signal, timeoutMs: 100 });
  controller.abort();
  await rejectsCode(canceled, "RPC_REQUEST_ABORTED");
  child.send({ id: 1, result: "late canceled response" });
  const timedOut = rpc.request("timeout", {});
  await rejectsCode(timedOut, "RPC_REQUEST_TIMEOUT");
  child.send({ id: 2, result: "late timeout response" });
  const immediate = rpc.waitFor("ready", { timeoutMs: 100 });
  child.send({ method: "ready", params: { value: true } });
  assert.equal((await immediate).params.value, true);
  await rejectsCode(rpc.waitFor("never", { timeoutMs: 10 }), "RPC_NOTIFICATION_TIMEOUT");
  assert.equal(rpc.fatalError, null, "late canceled/timed-out responses are consumed once");
  await rpc.terminate("test complete");
}

async function testMalformedTailOversizeAndStreamTermination() {
  const cases = [
    ["malformed", (child) => child.stdout.write("{bad}\n"), "RPC_MALFORMED_JSONL"],
    ["multiline", (child) => child.stdout.write('{"id":1,\n"result":{}}\n'), "RPC_MALFORMED_JSONL"],
    ["oversize", (child) => child.stdout.write("x".repeat(65) + "\n"), "RPC_FRAME_TOO_LARGE"],
    ["tail", (child) => { child.stdout.write('{"id":1'); child.close(); }, "RPC_MALFORMED_TAIL"],
    ["stdout error", (child) => child.stdout.destroy(Object.assign(new Error("raw stdout"), { code: "EIO" })), "RPC_STDOUT_ERROR"],
    ["stderr error", (child) => child.stderr.destroy(Object.assign(new Error("raw stderr"), { code: "EIO" })), "RPC_STDERR_ERROR"],
    ["stdout ended", (child) => child.stdout.end(), "RPC_STDOUT_ENDED"],
    ["exit", (child) => child.close(17), "RPC_PROCESS_EXITED"],
  ];
  for (const [name, trigger, code] of cases) {
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, { maxFrameBytes: 64, requestTimeoutMs: 100 });
    const pending = rpc.request(name, {});
    trigger(child);
    await rejectsCode(pending, code);
    await rejectsCode(rpc.terminated, code);
  }
}

async function testStdoutUsesFatalUtf8DecodingAcrossChunks() {
  {
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, { requestTimeoutMs: 100 });
    const pending = rpc.request("invalid-utf8", {});
    child.stdout.write(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]));
    await rejectsCode(pending, "RPC_MALFORMED_UTF8");
    await rejectsCode(rpc.terminated, "RPC_MALFORMED_UTF8");
  }
  {
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, { requestTimeoutMs: 100 });
    const pending = rpc.request("split-utf8", {});
    const frame = Buffer.from(`${JSON.stringify({ id: 1, result: "€" })}\n`);
    const splitAt = frame.indexOf(Buffer.from("€")) + 1;
    child.stdout.write(frame.subarray(0, splitAt));
    child.stdout.write(frame.subarray(splitAt));
    assert.equal(await pending, "€");
    await rpc.terminate();
  }
}

async function testStderrRingAndWriteFailuresAreBounded() {
  {
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, {
      requestTimeoutMs: 100,
      maxStderrBytes: 128,
      registeredSecrets: ["registered-secret-value", "abcd"],
    });
    child.stderr.write("prefix abcd registered-secret-value Bearer abcdefghijklmnopqrstuvwxyz suffix");
    await delay(0);
    const diagnostic = rpc.stderrDiagnostic();
    assert.ok(Buffer.byteLength(diagnostic) <= 128);
    assert.equal(diagnostic.includes("abcd"), false);
    assert.equal(diagnostic.includes("registered-secret-value"), false);
    assert.equal(diagnostic.includes("abcdefghijklmnopqrstuvwxyz"), false);
    await rpc.terminate("test complete");
  }
  {
    assert.throws(
      () => new CodexJsonlRpcClient(new FakeChild(), { registeredSecrets: ["abc"] }),
      (error) => error?.code === "RPC_REGISTERED_SECRET_INVALID",
    );
    const secrets = ["REDACTED", "FILTERED", "abcd"];
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, { registeredSecrets: secrets, maxStderrBytes: 256 });
    child.stderr.write("[REDACTED]-[FILTERED]-abcd");
    await delay(0);
    for (const secret of secrets) assert.equal(rpc.stderrDiagnostic().includes(secret), false);
    await rpc.terminate();
  }
  {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("secret stream error"), { code: "EPIPE" }));
      },
    });
    const child = new FakeChild(stdin);
    const rpc = new CodexJsonlRpcClient(child, { requestTimeoutMs: 100, writeTimeoutMs: 15 });
    await rejectsCode(rpc.request("write-error", {}), "RPC_STDIN_ERROR");
  }
  {
    const stdin = new Writable({ write() {} });
    const child = new FakeChild(stdin);
    const rpc = new CodexJsonlRpcClient(child, { requestTimeoutMs: 100, writeTimeoutMs: 10 });
    await rejectsCode(rpc.request("backpressure-timeout", {}), "RPC_WRITE_TIMEOUT");
  }
}

async function testDynamicSecretRegistrationRedactsExistingAndFutureDiagnostics() {
  const child = new FakeChild();
  const rpc = new CodexJsonlRpcClient(child, { maxStderrBytes: 512 });
  const secret = "runtime-api-key-canary-00000001";
  child.stderr.write(`before ${secret}`);
  await delay(0);
  assert.equal(rpc.stderrDiagnostic().includes(secret), true);
  rpc.registerSecret(secret);
  assert.equal(rpc.stderrDiagnostic().includes(secret), false);
  child.stderr.write(` after ${secret}`);
  await delay(0);
  assert.equal(rpc.stderrDiagnostic().includes(secret), false);
  assert.throws(
    () => rpc.registerSecret("abc"),
    (error) => error.code === "RPC_REGISTERED_SECRET_INVALID",
  );
  await rpc.terminate("test complete");
}

async function testRegisteredSecretCountAndUtf8BytesHaveHardLimitsBeforeAnyWrite() {
  const child = new FakeChild();
  const writes = readLines(child.stdin);
  const initial = Array.from(
    { length: DEFAULT_MAX_REGISTERED_SECRETS },
    (_, index) => `bounded-secret-${String(index).padStart(4, "0")}`,
  );
  const rpc = new CodexJsonlRpcClient(child, { registeredSecrets: initial });
  const overflow = "registered-secret-overflow-canary-000001";
  assert.throws(
    () => rpc.registerSecret(overflow),
    (error) => error.code === "RPC_REGISTERED_SECRET_LIMIT"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(overflow),
  );
  assert.equal(rpc.registeredSecrets.length, DEFAULT_MAX_REGISTERED_SECRETS);
  assert.equal(rpc.registeredSecrets.includes(overflow), false);
  assert.deepEqual(writes, []);
  await rpc.terminate();

  const multibyteOverflow = "界".repeat(Math.floor(DEFAULT_MAX_REGISTERED_SECRET_BYTES / 3) + 1);
  assert.throws(
    () => new CodexJsonlRpcClient(new FakeChild(), { registeredSecrets: [multibyteOverflow] }),
    (error) => error.code === "RPC_REGISTERED_SECRET_LIMIT"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(multibyteOverflow.slice(0, 16)),
  );
}

async function testOutboundWritesAreSerializedAndBounded() {
  {
    const stdin = new ControlledStdin({ backpressure: true });
    const rpc = new CodexJsonlRpcClient(new FakeChild(stdin), {
      maxQueuedWrites: 4,
      maxQueuedWriteBytes: 1024,
      writeTimeoutMs: 100,
    });
    const first = rpc.notify("first", { value: 1 });
    const second = rpc.notify("second", { value: 2 });
    assert.equal(stdin.calls.length, 1, "only one write may reach stdin at a time");
    stdin.finish(0);
    await delay(0);
    assert.equal(stdin.calls.length, 1, "backpressured write must also await drain");
    stdin.backpressure = false;
    stdin.emit("drain");
    await first;
    await delay(0);
    assert.equal(stdin.calls.length, 2);
    stdin.finish(1);
    await second;
    await rpc.terminate();
  }
  {
    const stdin = new ControlledStdin();
    const rpc = new CodexJsonlRpcClient(new FakeChild(stdin), {
      maxQueuedWrites: 2,
      maxQueuedWriteBytes: 1024,
      writeTimeoutMs: 100,
    });
    const first = rpc.notify("first");
    const second = rpc.notify("second");
    const overflow = rpc.notify("third");
    await rejectsCode(overflow, "RPC_WRITE_QUEUE_OVERFLOW");
    await rejectsCode(first, "RPC_WRITE_QUEUE_OVERFLOW");
    await rejectsCode(second, "RPC_WRITE_QUEUE_OVERFLOW");
    await rejectsCode(rpc.terminated, "RPC_WRITE_QUEUE_OVERFLOW");
    stdin.finish(0);
    await delay(0);
  }
  {
    const stdin = new ControlledStdin();
    const rpc = new CodexJsonlRpcClient(new FakeChild(stdin), { writeTimeoutMs: 10 });
    const first = rpc.notify("first");
    const queued = rpc.notify("queued");
    await rejectsCode(first, "RPC_WRITE_TIMEOUT");
    await rejectsCode(queued, "RPC_WRITE_TIMEOUT");
    await rejectsCode(rpc.terminated, "RPC_WRITE_TIMEOUT");
  }
  {
    const stdin = new ControlledStdin();
    const rpc = new CodexJsonlRpcClient(new FakeChild(stdin), { writeTimeoutMs: 100 });
    const first = rpc.notify("first");
    const queued = rpc.notify("queued");
    await rpc.terminate();
    await rejectsCode(first, "RPC_TERMINATED");
    await rejectsCode(queued, "RPC_TERMINATED");
    stdin.finish(0);
    await delay(0);
  }
}

async function testProtocolLedgersStayBounded() {
  {
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, {
      requestTimeoutMs: 100,
      maxBufferedNotifications: 2,
      maxBufferedNotificationBytes: 128,
    });
    for (let index = 0; index < 8; index += 1) {
      child.send({ method: `event-${index}`, params: { value: "x".repeat(20) } });
    }
    await delay(0);
    assert.ok(rpc.notifications.length <= 2);
    assert.ok(rpc.bufferedNotificationBytes <= 128);
    await rpc.terminate();
  }
  {
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, { requestTimeoutMs: 100, maxRetiredIds: 2 });
    for (let index = 0; index < 2; index += 1) {
      const controller = new AbortController();
      const pending = rpc.request("cancel", {}, { signal: controller.signal });
      controller.abort();
      await rejectsCode(pending, "RPC_REQUEST_ABORTED");
    }
    const controller = new AbortController();
    const overflow = rpc.request("cancel", {}, { signal: controller.signal });
    controller.abort();
    await rejectsCode(overflow, "RPC_REQUEST_ABORTED");
    assert.equal(rpc.retired.size, 2);
    assert.equal(rpc.fatalError, null, "bounded retired history evicts oldest ids without killing a healthy host");
    await rpc.terminate();
  }
  {
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, { maxServerRequestIds: 2, writeTimeoutMs: 100 });
    child.send({ id: "a", method: "unknown", params: {} });
    await delay(0);
    child.send({ id: "b", method: "unknown", params: {} });
    await delay(0);
    child.send({ id: "c", method: "unknown", params: {} });
    await delay(0);
    assert.equal(rpc.serverRequestIds.size, 2);
    assert.equal(rpc.fatalError, null, "completed server request ids use a bounded history");
    await rpc.terminate();
  }
  {
    const child = new FakeChild();
    const rpc = new CodexJsonlRpcClient(child, { maxActiveServerRequests: 2, serverRequestTimeoutMs: 100 });
    rpc.registerServerRequestHandler("hang", async () => new Promise(() => {}));
    child.send({ id: "a", method: "hang", params: {} });
    child.send({ id: "b", method: "hang", params: {} });
    child.send({ id: "c", method: "hang", params: {} });
    await rejectsCode(rpc.terminated, "RPC_SERVER_REQUEST_CONCURRENCY");
  }
}

async function testNotificationWaitersHaveAHardGlobalLimit() {
  const child = new FakeChild();
  const rpc = new CodexJsonlRpcClient(child, { maxWaiters: 256, requestTimeoutMs: 60 * 60 * 1_000 });
  const waits = [];
  const initialTimers = [];
  try {
    for (let index = 0; index < 10_000; index += 1) {
      waits.push(rpc.waitFor(`never-${index}`, { timeoutMs: 60 * 60 * 1_000 }).catch((error) => error));
      if (index === 255) {
        initialTimers.push(...[...rpc.waiters.values()].flat().map((waiter) => waiter.timer));
      }
    }
    const waiterCount = [...rpc.waiters.values()].reduce((total, entries) => total + entries.length, 0);
    assert.ok(waiterCount <= 256, "10k long-timeout waits must not grow the waiter registry");
    await rejectsCode(rpc.terminated, "RPC_WAITER_LIMIT");
    assert.equal(rpc.waiters.size, 0);
    assert.equal(initialTimers.every((timer) => timer._destroyed === true), true, "fatal waiter cleanup must clear timers");
    const results = await Promise.all(waits);
    assert.equal(results.every((error) => error?.code === "RPC_WAITER_LIMIT"), true);
  } finally {
    await rpc.terminate();
    await Promise.all(waits);
  }
}

async function main() {
  const tests = [
    testOutOfOrderNotificationAndServerRequest,
    testUnknownAndDuplicateResponseIdsFailClosed,
    testServerRequestFallbackAndSanitizedFailures,
    testServerRequestHandlerCanWaitWithoutDeadline,
    testAbortTimeoutAndWaiters,
    testMalformedTailOversizeAndStreamTermination,
    testStdoutUsesFatalUtf8DecodingAcrossChunks,
    testStderrRingAndWriteFailuresAreBounded,
    testDynamicSecretRegistrationRedactsExistingAndFutureDiagnostics,
    testRegisteredSecretCountAndUtf8BytesHaveHardLimitsBeforeAnyWrite,
    testOutboundWritesAreSerializedAndBounded,
    testProtocolLedgersStayBounded,
    testNotificationWaitersHaveAHardGlobalLimit,
  ];
  for (const test of tests) {
    await test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  process.stdout.write(`codex rpc client unit: ${tests.length}/${tests.length}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
