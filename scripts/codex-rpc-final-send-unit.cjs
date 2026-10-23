#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { CodexJsonlRpcClient } = require("../app/agent-service/codex-jsonl-rpc");
const { isCodexRpcSendRejection } = require("../app/agent-service/codex-rpc-write-queue");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class ControlledStdin extends EventEmitter {
  constructor() { super(); this.writable = true; this.calls = []; this.backpressure = true; }
  write(frame, encoding, callback) {
    assert.equal(encoding, "utf8");
    this.calls.push({ frame, callback });
    return !this.backpressure;
  }
  finish(index = 0, error = null) { this.calls[index].callback(error); }
  release(index = 0) { this.finish(index); this.backpressure = false; this.emit("drain"); }
}
class Child extends EventEmitter {
  constructor() { super(); this.stdin = new ControlledStdin(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); }
  send(message) { this.stdout.write(JSON.stringify(message) + "\n"); }
}
const caught = promise => promise.then(value => ({ value }), error => ({ error }));
async function expectCode(outcome, code, unsent = false) {
  const value = await outcome;
  assert.equal(value.error?.code, code);
  if (unsent) assert.equal(isCodexRpcSendRejection(value.error), true);
  return value.error;
}
function client() {
  const child = new Child();
  return { child, rpc: new CodexJsonlRpcClient(child, { requestTimeoutMs: 1000, writeTimeoutMs: 1000 }) };
}
async function testRevokedQueuedCallDoesNotSendOrRetireOtherRequests() {
  const { child, rpc } = client();
  let allowed = true, checks = 0;
  try {
    const hold = rpc.notify("hold");
    const revoked = caught(rpc.request("mcpServer/tool/call", { arguments: { message: "fixture-only" } }, {
      beforeSend: () => { checks++; if (!allowed) throw Object.assign(new Error("private diagnostic"), { code: "GRANT_REVOKED" }); },
    }));
    const survivor = rpc.request("healthy", { value: 1 });
    assert.equal(checks, 0);
    assert.equal(child.stdin.calls.length, 1);
    allowed = false;
    child.stdin.release();
    await hold;
    const error = await expectCode(revoked, "GRANT_REVOKED", true);
    assert.equal(error.message.includes("private diagnostic"), false);
    assert.equal(checks, 1);
    assert.deepEqual(child.stdin.calls.map(call => JSON.parse(call.frame).method), ["hold", "healthy"]);
    assert.equal(rpc.fatalError, null);
    child.stdin.finish(1);
    child.send({ id: 2, result: "healthy" });
    assert.equal(await survivor, "healthy");
    assert.equal(rpc.pending.size, 0);
    return { queuedRevocationChecks: checks, rejectedFrames: 0, healthyFrames: 1, hostFatal: false };
  } finally { await rpc.terminate(); }
}
async function testQueuedAbortAndDeadlineExpireBeforeAdmission() {
  const { child, rpc } = client();
  let checks = 0;
  try {
    const hold = rpc.notify("hold");
    const controller = new AbortController();
    const aborted = caught(rpc.request("never-aborted", {}, { signal: controller.signal, beforeSend: () => { checks++; } }));
    const expired = caught(rpc.request("never-expired", {}, { timeoutMs: 12, beforeSend: () => { checks++; } }));
    const survivor = rpc.request("healthy-after-retirement", {});
    controller.abort();
    await expectCode(aborted, "RPC_REQUEST_ABORTED");
    await expectCode(expired, "RPC_REQUEST_TIMEOUT");
    assert.equal(child.stdin.calls.length, 1);
    child.stdin.release();
    await hold;
    await delay(0);
    assert.equal(checks, 0, "retired requests cannot consume future approval tickets");
    assert.deepEqual(child.stdin.calls.map(call => JSON.parse(call.frame).method), ["hold", "healthy-after-retirement"]);
    assert.equal(rpc.fatalError, null);
    child.stdin.finish(1);
    child.send({ id: 3, result: "ok" });
    assert.equal(await survivor, "ok");
    return { retiredFrames: 0, retiredAdmissionChecks: checks, healthyFrames: 1 };
  } finally { await rpc.terminate(); }
}
async function testGuardSeesImmutableOriginalFrameExactlyOnce() {
  const { child, rpc } = client();
  const frames = [];
  try {
    const hold = rpc.notify("hold");
    const params = { threadId: "original-thread", server: "codex-security", arguments: { scanId: "original-scan" } };
    const pending = rpc.request("mcpServer/tool/call", params, { beforeSend: frame => { frames.push(frame); } });
    params.threadId = "different-thread";
    params.arguments.scanId = "different-scan";
    assert.deepEqual(frames, []);
    child.stdin.release();
    await hold;
    assert.equal(frames.length, 1);
    assert.equal(frames[0], child.stdin.calls[1].frame);
    assert.deepEqual(JSON.parse(frames[0]), { id: 1, method: "mcpServer/tool/call", params: {
      threadId: "original-thread", server: "codex-security", arguments: { scanId: "original-scan" },
    } });
    child.stdin.finish(1);
    child.stdin.emit("drain");
    child.send({ id: 1, result: { ok: true } });
    assert.deepEqual(await pending, { ok: true });
    assert.equal(frames.length, 1);
    return { immutableFrameMatched: true, finalChecks: 1, sends: 1 };
  } finally { await rpc.terminate(); }
}
async function testAsynchronousOrInvalidGuardsNeverWrite() {
  const { child, rpc } = client();
  try {
    await expectCode(caught(rpc.request("async-forbidden", {}, { beforeSend: () => Promise.reject(new Error("fixture private value")) })), "RPC_INVALID_SEND_GUARD", true);
    await expectCode(caught(rpc.request("invalid-forbidden", {}, { beforeSend: true })), "RPC_INVALID_SEND_GUARD");
    await delay(0);
    assert.equal(child.stdin.calls.length, 0);
    assert.equal(rpc.fatalError, null);
    const pending = rpc.request("healthy", {});
    child.stdin.release();
    child.send({ id: 3, result: true });
    assert.equal(await pending, true);
    return { invalidFrames: 0, hostFatal: false, healthyFrames: 1 };
  } finally { await rpc.terminate(); }
}
async function testAbortInsideGuardNeverWrites() {
  const { child, rpc } = client();
  const controller = new AbortController();
  let checks = 0;
  try {
    const pending = caught(rpc.request("abort-at-final-check", {}, { signal: controller.signal, beforeSend: () => { checks++; controller.abort(); } }));
    await expectCode(pending, "RPC_REQUEST_ABORTED");
    await delay(0);
    assert.equal(checks, 1);
    assert.equal(child.stdin.calls.length, 0);
    assert.equal(rpc.fatalError, null);
    return { finalChecks: 1, sends: 0, hostFatal: false };
  } finally { await rpc.terminate(); }
}
async function testOnlyPrivateAdmissionErrorsAreNonfatal() {
  const { child, rpc } = client();
  try {
    const refused = caught(rpc.request("pre-send-denied", {}, { beforeSend: () => {
      throw Object.assign(new Error("private pre-send failure"), { code: "RPC_STDIN_ERROR" });
    } }));
    await expectCode(refused, "RPC_STDIN_ERROR", true);
    assert.equal(child.stdin.calls.length, 0);
    assert.equal(rpc.fatalError, null);
    const first = caught(rpc.request("transport-failure", {}));
    const second = caught(rpc.request("queued-sibling", {}));
    const forged = Object.assign(new Error("must not become admission refusal"), { code: "GRANT_REVOKED", unsent: true });
    assert.equal(isCodexRpcSendRejection(forged), false);
    child.stdin.finish(0, forged);
    const actual = await expectCode(first, "RPC_STDIN_ERROR");
    assert.equal(isCodexRpcSendRejection(actual), false);
    await expectCode(second, "RPC_STDIN_ERROR");
    assert.equal(child.stdin.calls.length, 1);
    assert.equal(rpc.fatalError?.code, "RPC_STDIN_ERROR");
    return { forgedAdmissionAccepted: false, transportFailureFatal: true, replayedFrames: 0 };
  } finally { await rpc.terminate(); }
}
async function main() {
  const output = process.argv[2];
  if (output && fs.existsSync(output)) throw new Error("evidence output already exists");
  const sourceFiles = ["app/agent-service/codex-rpc-write-queue.js", "app/agent-service/codex-jsonl-rpc.js", "app/agent-service/codex-runtime-host.js", "app/agent-service/codex-rpc-safety.js", "scripts/codex-rpc-final-send-unit.cjs"];
  const source = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.resolve(__dirname, "..", file))).digest("hex")]));
  const before = source();
  const tests = [testRevokedQueuedCallDoesNotSendOrRetireOtherRequests, testQueuedAbortAndDeadlineExpireBeforeAdmission,
    testGuardSeesImmutableOriginalFrameExactlyOnce, testAsynchronousOrInvalidGuardsNeverWrite,
    testAbortInsideGuardNeverWrites, testOnlyPrivateAdmissionErrorsAreNonfatal];
  const results = [];
  for (const test of tests) { results.push({ name: test.name, passed: true, detail: await test() }); process.stdout.write("PASS " + test.name + "\n"); }
  const after = source();
  assert.deepEqual(after, before);
  const evidence = { verified: true, scope: "production JSONL client and final write queue with controlled stdio; no native Host/account/model/tool business", sourceBefore: before, sourceAfter: after, sourceStable: true, results };
  if (output) fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write("codex RPC final-send unit: " + results.length + "/" + tests.length + "\n");
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
