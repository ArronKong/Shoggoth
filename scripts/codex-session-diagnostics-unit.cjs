#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexJsonlRpcClient } = require("../app/agent-service/codex-jsonl-rpc");
const { classifyCodexSessionRemoteError, recordCodexSessionFailure } = require("../app/agent-service/codex-session-diagnostics");

const binding = { runtime: "codex", runtimeProfileId: "private-profile-name", runtimeAccountId: "private-account-name" };
const threadId = "01a11046-d832-70a1-90ed-e42091fa1137";
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-diag-unit-")));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { trustedRoot: root, runtimeDir: path.join(root, "run") };
  return { root, paths, file: path.join(paths.runtimeDir, "codex-session-diagnostics.json") };
}
function error(code = "RPC_REMOTE_ERROR") {
  return Object.assign(new Error("secret-message-token-and-path"), {
    code, rpcCode: -32603, remoteClassification: "MCP_INITIALIZE_FAILED",
    startupDiagnostic: "MCP_HELPER_AUTH_FAILED", secret: "private-credential",
  });
}
function writeFailure(paths, extra = {}) {
  return recordCodexSessionFailure({
    paths, binding, operationName: "threadResume", phase: "rpc", error: error(),
    params: { threadId, developerInstructions: "private prompt 中文", cwd: "/private/workspace", token: "private-token" },
    ...extra,
  });
}

test("remote classification is bounded and never retains remote text", () => {
  const values = [
    ["required MCP servers failed to initialize: private-token", "MCP_INITIALIZE_FAILED"],
    ["no rollout found for thread /private/history", "SESSION_NOT_FOUND"],
    ["No space left on device: /private/history", "STORAGE_FULL"],
    ["invalid params containing private-token", "REQUEST_INVALID"],
    [`thread ${threadId} already has an active writer`, "SESSION_WRITER_BUSY"],
    ["secret-message-token-and-path", "UNKNOWN_REMOTE_ERROR"],
    ["x".repeat(8192) + "No space left on device", "UNKNOWN_REMOTE_ERROR"],
  ];
  for (const [message, expected] of values) assert.equal(classifyCodexSessionRemoteError(message), expected);
});

test("session RPC keeps a fixed class and numeric code without exposing error text", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const rpc = new CodexJsonlRpcClient(child);
  try {
    const pending = rpc.request("thread/resume", { threadId });
    child.stdout.write(`${JSON.stringify({ id: 1, error: { code: -32603, message: "required MCP servers failed to initialize: private-credential" } })}\n`);
    await assert.rejects(pending, (caught) => {
      assert.equal(caught.remoteClassification, "MCP_INITIALIZE_FAILED");
      assert.equal(caught.rpcCode, -32603);
      assert.equal(caught.message, "Codex RPC request failed");
      assert.equal(JSON.stringify(caught).includes("private-credential"), false);
      return true;
    });
  } finally { await rpc.terminate(); }
});

test("native writer contention preserves its public cause and never authorizes a retry", async () => {
  const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
  const { isRetryablePreTurnStageError, runtimeStageError, runtimeStageFromError } = require("../app/agent-service/runtime-stage-error");
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const rpc = new CodexJsonlRpcClient(child);
  let calls = 0;
  const host = {
    terminated: new Promise(() => {}),
    threadResume(params) {
      calls++;
      const pending = rpc.request("thread/resume", params);
      child.stdout.write(`${JSON.stringify({ id: 1, error: { code: -32600, message: `thread ${threadId} already has an active writer private-credential` } })}\n`);
      return pending;
    },
  };
  try {
    const handle = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host } }).acquire(binding);
    await assert.rejects(handle.sessionResume({ sessionId: threadId }), error => {
      assert.equal(error.code, "RUNTIME_SESSION_WRITER_BUSY");
      assert.equal(error.message, error.code);
      assert.equal(JSON.stringify(error).includes("private-credential"), false);
      assert.equal(runtimeStageError("session_start_or_resume", error), error);
      assert.equal(runtimeStageFromError(error), "session_start_or_resume");
      assert.equal(isRetryablePreTurnStageError(error), false);
      return true;
    });
    assert.equal(calls, 1);
  } finally { await rpc.terminate(); }
});

test("private records retain only metadata, fixed enums and a bounded number of failures", (t) => {
  const { paths, file } = fixture(t);
  for (let index = 0; index < 40; index += 1) assert.equal(writeFailure(paths), true);
  const text = fs.readFileSync(file, "utf8");
  const saved = JSON.parse(text);
  assert.equal(saved.version, 1); assert.equal(saved.records.length, 32);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.runtimeDir).mode & 0o777, 0o700);
  assert.ok(Buffer.byteLength(text) < 64 * 1024);
  const record = saved.records.at(-1);
  assert.equal(record.threadId, threadId); assert.equal(record.phase, "rpc");
  assert.equal(record.instructionBytes, Buffer.byteLength("private prompt 中文"));
  assert.match(record.bindingHash, /^[a-f0-9]{64}$/);
  for (const forbidden of ["private prompt", "中文", "private-token", "/private/workspace", "secret-message", "private-credential", binding.runtimeProfileId, binding.runtimeAccountId]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  saved.records[0].untrustedText = "untrusted-record-secret";
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(writeFailure(paths), true);
  assert.equal(fs.readFileSync(file, "utf8").includes("untrusted-record-secret"), false);
});

test("untrusted properties are dropped and unsafe diagnostic files are untouched", (t) => {
  const { root, paths, file } = fixture(t);
  const caught = Object.assign(error(), { code: "private-code-secret", remoteClassification: "private-class-secret", startupDiagnostic: "private-startup-secret" });
  assert.equal(writeFailure(paths, { error: caught, params: { threadId: "private-thread-secret" } }), true);
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).records[0];
  assert.equal(saved.errorCode, "UNKNOWN_LOCAL_ERROR");
  assert.equal(saved.threadId, undefined); assert.equal(saved.remoteClassification, undefined); assert.equal(saved.startupDiagnostic, undefined);
  fs.unlinkSync(file);
  const other = path.join(root, "other-private-file");
  fs.writeFileSync(other, "keep-this", { mode: 0o600 });
  fs.symlinkSync(other, file);
  assert.equal(writeFailure(paths), false);
  assert.equal(fs.readFileSync(other, "utf8"), "keep-this");
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

for (const phase of ["request_schema", "rpc", "response_schema"]) {
  test(`Host records ${phase} while preserving the original error and cleanup`, async (t) => {
    const { paths, file } = fixture(t);
    const caught = error(phase === "rpc" ? "RPC_REMOTE_ERROR" : "CODEX_SCHEMA_ERROR");
    const trace = [];
    const receiver = {
      paths, binding, _assertReady() {},
      schemaContract: {
        operations: { threadResume: { method: "thread/resume" } },
        validateParams() { trace.push("request_schema"); if (phase === "request_schema") throw caught; },
        validateResponse() { trace.push("response_schema"); if (phase === "response_schema") throw caught; },
      },
      rpc: { async request() { trace.push("rpc"); if (phase === "rpc") throw caught; return {}; } },
      async _markFatal(value) { assert.equal(value, caught); trace.push("fatal"); },
    };
    await assert.rejects(CodexRuntimeHost.prototype._request.call(receiver, "threadResume", { threadId }), (value) => value === caught);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).records[0].phase, phase);
    assert.equal(trace.includes("fatal"), phase === "response_schema");
    fs.unlinkSync(file); fs.mkdirSync(file, { mode: 0o700 });
    await assert.rejects(CodexRuntimeHost.prototype._request.call(receiver, "threadResume", { threadId }), (value) => value === caught);
    assert.equal(fs.lstatSync(file).isDirectory(), true);
  });
}

test("successful and unrelated RPC requests do not create session diagnostics", async (t) => {
  const { paths, file } = fixture(t);
  const receiver = {
    paths, binding, _assertReady() {},
    schemaContract: { operations: { threadResume: { method: "thread/resume" }, modelList: { method: "model/list" } }, validateParams() {}, validateResponse() {} },
    rpc: { async request() { return { accepted: true }; } },
    async _markFatal() { assert.fail("success should not mark the Host fatal"); },
  };
  assert.deepEqual(await CodexRuntimeHost.prototype._request.call(receiver, "threadResume", { threadId }), { accepted: true });
  assert.equal(fs.existsSync(file), false);
  receiver.rpc.request = async () => { throw error(); };
  await assert.rejects(CodexRuntimeHost.prototype._request.call(receiver, "modelList", {}));
  assert.equal(fs.existsSync(file), false);
});

for (const phase of ["handle_request", "handle_response"]) {
  test(`V1 ${phase} rejection is diagnosed even when the native Host has no error`, async (t) => {
    const { paths, file } = fixture(t);
    const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
    let calls = 0;
    const raw = { ...binding, host: { paths }, capabilities: { "session.resume": true },
      subscribe() { return () => {}; }, terminated: new Promise(() => {}),
      async sessionResume() { calls++; return { session: { id: "unexpected-session" }, secret: "private-response-secret" }; },
    };
    const handle = runtimeHandleV1(raw, binding);
    const payload = phase === "handle_request" ? { sessionId: threadId, invalid: Infinity } : { sessionId: threadId };
    await assert.rejects(handle.sessionResume(payload), { code: "RUNTIME_PROTOCOL_INVALID" });
    assert.equal(calls, phase === "handle_request" ? 0 : 1);
    const text = fs.readFileSync(file, "utf8");
    const saved = JSON.parse(text).records[0];
    assert.equal(saved.phase, phase); assert.equal(saved.errorCode, "RUNTIME_PROTOCOL_INVALID");
    assert.equal(text.includes("private-response-secret"), false);
  });
}
