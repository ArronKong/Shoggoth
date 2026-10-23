"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { runtimeSessionResumeError, runtimeStageError, isRetryablePreTurnStageError,
  runtimeAccountBackoffError, runtimeSessionResumePreservesSession } = require("../app/agent-service/runtime-stage-error");
const { classifyAntigravitySessionRemoteError, isTransientAntigravitySessionError,
  recordAntigravitySessionDiagnostic } = require("../app/agent-service/antigravity-session-diagnostics");
const { FakeHost, openFixture, directRuntimeManager, sendAndDrain, SESSION_KEY } = require("./shoggoth-work-run-coordinator-unit.cjs");

const SESSION_ID = "11111111-1111-4111-8111-111111111112";
const binding = { runtime: "antigravity", runtimeProfileId: "private-profile-id", runtimeAccountId: "private-account-id" };
const networkError = () => Object.assign(new Error("private-detail"), { code: "ANTIGRAVITY_NETWORK_UNAVAILABLE" });
const staged = error => runtimeStageError("session_start_or_resume", error);

test("only a trusted native resume attestation allows network retries at the resume stage", () => {
  const forged = Object.assign(networkError(), { retryable: true, safeResume: true, remote: true });
  assert.equal(isRetryablePreTurnStageError(staged(forged)), false);
  assert.equal(isRetryablePreTurnStageError(staged(JSON.parse(JSON.stringify(forged)))), false);
  const safe = runtimeSessionResumeError(networkError(), { retryable: true });
  assert.equal(isRetryablePreTurnStageError(staged(safe)), true);
  assert.equal(runtimeSessionResumePreservesSession(staged(safe)), true);
  assert.equal(runtimeSessionResumePreservesSession(staged(forged)), false);
  const missing = runtimeSessionResumeError(new Error("history missing"), { preserveSession: false });
  assert.equal(isRetryablePreTurnStageError(staged(missing)), false);
  assert.equal(runtimeSessionResumePreservesSession(staged(missing)), false);
  for (const stage of ["runtime_acquire", "runtime_authentication", "turn_start"]) {
    assert.equal(isRetryablePreTurnStageError(runtimeStageError(stage, safe)), false);
  }
  assert.equal(isRetryablePreTurnStageError(staged(runtimeSessionResumeError(new Error("timeout")))), false);
  assert.equal(isRetryablePreTurnStageError(staged(runtimeAccountBackoffError(safe, 1234))), false);
  assert.throws(() => runtimeSessionResumeError(Object.assign(new Error(), { code: "AUTH_REQUIRED" }), { retryable: true }), TypeError);
});

test("remote classification distinguishes transient connections from permanent and unknown causes", () => {
  for (const [input, expected, transient = false] of [
    ["SSLEOFError: EOF occurred in violation of protocol", "TLS_EOF", true],
    ["Unable to connect to proxy", "PROXY_CONNECTION_FAILED", true],
    ["Connection reset by peer", "CONNECTION_FAILED", true],
    ["Name or service not known", "DNS_FAILED", true],
    ["ConnectTimeout: private-url", "CONNECT_TIMEOUT", true],
    ["There was a network issue connecting to the server", "NETWORK_UNAVAILABLE", true],
    ["network issue: MCP load failed for shoggoth", "MCP_INITIALIZE_FAILED"],
    ["TLS handshake: CERTIFICATE_VERIFY_FAILED", "CERTIFICATE_INVALID"],
    ["UNAVAILABLE model: model is unavailable", "REQUEST_INVALID"],
    ["network issue: UNAUTHENTICATED", "AUTHENTICATION_FAILED"],
    ["network issue: User location is not supported", "REGION_UNSUPPORTED"],
    ["network issue: RESOURCE_EXHAUSTED quota exhausted", "QUOTA_EXHAUSTED"],
    ["No space left on device", "STORAGE_FULL"],
    ["Read-only file system", "STORAGE_READ_ONLY"],
    ["permission denied", "STORAGE_PERMISSION_DENIED"],
    ["Unable to read conversation history: unexpected EOF", "HISTORY_READ_FAILED"],
    ["Session not found", "SESSION_NOT_FOUND"],
    ["Unexpected EOF in private path", "UNKNOWN_REMOTE_ERROR"],
    ["x".repeat(8192) + "network issue", "UNKNOWN_REMOTE_ERROR"],
  ]) {
    const classification = classifyAntigravitySessionRemoteError(input);
    assert.equal(classification, expected, input);
    assert.equal(isTransientAntigravitySessionError(classification), transient, input);
  }
});

test("session diagnostics are private, bounded, sanitized and fail safely on an unsafe target", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-session-diag-")));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { trustedRoot: root, runtimeDir: path.join(root, "run") };
  const target = path.join(paths.runtimeDir, "antigravity-session-diagnostics.json");
  const record = extra => recordAntigravitySessionDiagnostic({ paths, binding, method: "session/resume", sessionId: SESSION_ID,
    executionRunId: "11111111-1111-4111-8111-111111111113", attempt: 1,
    error: Object.assign(new Error("private-message-canary"), { code: "ANTIGRAVITY_ACP_REMOTE_ERROR", rpcCode: -32603,
      rpcDetail: "secret-token-and-path" }), remoteClassification: "TLS_EOF", retryEligible: true, ...extra });
  for (let n = 0; n < 40; n++) assert.equal(record(), true);
  let text = fs.readFileSync(target, "utf8"), saved = JSON.parse(text);
  assert.equal(saved.records.length, 32);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.runtimeDir).mode & 0o777, 0o700);
  assert.ok(Buffer.byteLength(text) < 64 * 1024);
  assert.match(saved.records[0].bindingHash, /^[a-f0-9]{64}$/u);
  for (const secret of ["private-message-canary", "secret-token-and-path", binding.runtimeProfileId, binding.runtimeAccountId]) assert.equal(text.includes(secret), false);
  saved.records.at(-1).untrusted = "foreign-secret";
  fs.writeFileSync(target, JSON.stringify(saved));
  assert.equal(record({ remoteClassification: "unknown-private-value" }), true);
  text = fs.readFileSync(target, "utf8");
  assert.equal(text.includes("foreign-secret"), false);
  assert.equal(text.includes("unknown-private-value"), false);
  fs.unlinkSync(target);
  const other = path.join(root, "keep"); fs.writeFileSync(other, "unchanged", { mode: 0o600 }); fs.symlinkSync(other, target);
  assert.equal(record(), false);
  assert.equal(fs.readFileSync(other, "utf8"), "unchanged");
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
});

test("coordinator retries resume once, keeps the native session, and dispatches a single turn", async () => {
  const host = new FakeHost([], { accountReadSupported: false });
  const nativeResume = host.threadResume.bind(host), seen = [];
  host.threadResume = async params => {
    seen.push(params.threadId);
    if (seen.length === 1) throw runtimeSessionResumeError(networkError(), { retryable: true });
    return nativeResume(params);
  };
  const ctx = await openFixture({ runtime: "antigravity", sessionStatus: "ready", threadId: SESSION_ID,
    host, runtimeManager: directRuntimeManager(host, "antigravity") });
  try {
    const { ack } = await sendAndDrain(ctx, { operationId: "resume-network-once" });
    assert.equal(ctx.coordinator.getRun(ack.run.id).status, "running");
    assert.deepEqual(seen, [SESSION_ID, SESSION_ID]);
    assert.equal(host.threadStartCalls, 0);
    assert.equal(host.turnStartCalls, 1);
  } finally { await ctx.coordinator.close(); }
});

test("a repeated transient resume failure stops after two attempts without sending a prompt", async () => {
  const host = new FakeHost([], { accountReadSupported: false });
  let attempts = 0;
  host.threadResume = async () => { attempts++; throw runtimeSessionResumeError(networkError(), { retryable: true }); };
  const ctx = await openFixture({ runtime: "antigravity", sessionStatus: "ready", threadId: SESSION_ID,
    host, runtimeManager: directRuntimeManager(host, "antigravity") });
  try {
    const ack = await ctx.coordinator.send({ sessionKey: SESSION_KEY, operationId: "resume-network-always", prompt: "once" });
    const settled = await ctx.coordinator.waitForIdle(ack.run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, "ANTIGRAVITY_NETWORK_UNAVAILABLE");
    assert.equal(attempts, 2);
    assert.equal(host.turnStartCalls, 0);
    assert.equal(host.threadStartCalls, 0);
  } finally { await ctx.coordinator.close(); }
});

test("even an attested network failure during turn dispatch is never replayed", async () => {
  const host = new FakeHost([], { accountReadSupported: false,
    turnStartError: runtimeSessionResumeError(networkError(), { retryable: true }) });
  const ctx = await openFixture({ runtime: "antigravity", host, runtimeManager: directRuntimeManager(host, "antigravity") });
  try {
    const ack = await ctx.coordinator.send({ sessionKey: SESSION_KEY, operationId: "turn-no-replay", prompt: "once" });
    const settled = await ctx.coordinator.waitForIdle(ack.run.id);
    assert.equal(settled.status, "failed");
    assert.equal(host.turnStartCalls, 1);
  } finally { await ctx.coordinator.close(); }
});

test("a permanent native resume failure preserves the bound session even when semantic history exists", async () => {
  const host = new FakeHost([], { accountReadSupported: false });
  let attempts = 0;
  host.threadResume = async () => {
    attempts++;
    throw runtimeSessionResumeError(Object.assign(new Error("private"), { code: "ANTIGRAVITY_MCP_UNAVAILABLE" }));
  };
  const ctx = await openFixture({ runtime: "antigravity", sessionStatus: "ready", threadId: SESSION_ID,
    host, runtimeManager: directRuntimeManager(host, "antigravity"),
    transcriptStore: { listEvents: () => [{ kind: "user", runId: "old-run" }], appendEvent() {} } });
  try {
    const ack = await ctx.coordinator.send({ sessionKey: SESSION_KEY, operationId: "keep-original-session", prompt: "once" });
    const settled = await ctx.coordinator.waitForIdle(ack.run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, "ANTIGRAVITY_MCP_UNAVAILABLE");
    assert.equal(attempts, 1);
    assert.equal(host.threadStartCalls, 0);
    assert.equal(host.turnStartCalls, 0);
    assert.equal(ctx.sessions.session.runtimeSessionId, SESSION_ID);
  } finally { await ctx.coordinator.close(); }
});
