"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runtimeFailureDetail, runtimeFailureFromError, failureDetailText } = require("../app/agent-service/runtime-failure-detail");
const { normalizeCodexEvent } = require("../app/agent-service/codex-event-normalizer");

test("extracts the actual English API reason, HTTP status and upstream code", () => {
  const reason = "User location is not supported for the API use.";
  const detail = runtimeFailureDetail(`agent executor error: Error 400, Message: ${reason}, Status: FAILED_PRECONDITION, Details: []: Error 400, Message: ${reason}, Status: FAILED_PRECONDITION, Details: []`);
  assert.deepEqual(detail, { message: reason, httpStatus: 400, upstreamCode: "FAILED_PRECONDITION" });
  assert.equal(failureDetailText(detail), `上游原因：${reason}\nHTTP 400 · FAILED_PRECONDITION`);
});

test("retains unknown structured causes without copying request bodies or stack traces", () => {
  assert.deepEqual(runtimeFailureDetail({ message: JSON.stringify({ error: {
    message: "Workspace policy requires a verified project.", code: "project_verification_required" },
  request: { prompt: "private prompt" } }), stack: "private stack" }), {
    message: "Workspace policy requires a verified project.", upstreamCode: "project_verification_required",
  });
  assert.equal(runtimeFailureDetail({ stack: "private stack", request: { message: "private prompt" } }), null);
  assert.equal(runtimeFailureDetail({ message: "Provider failed\n    at privateFunction (/Users/user/file.js:10:5)" }).message, "Provider failed");
  assert.equal(runtimeFailureDetail({ message: "x".repeat(100_000) }), null);
});

test("redacts credentials and private identifiers before limiting diagnostic length", () => {
  const detail = runtimeFailureDetail({ message: "Connection failed for https://alice:password@example.com/api?token=short\nAuthorization: Bearer tiny\nCookie: sid=123\npassword=abc\ncontact alice@example.com /Users/alice/private/file\nfixture-secret-value", statusCode: 503 }, ["fixture-secret-value"]);
  const output = JSON.stringify(detail);
  for (const secret of ["password", "alice", "short", "tiny", "sid=123", "abc", "fixture-secret-value", "private/file"]) assert.ok(!output.includes(secret), secret);
  assert.equal(detail.httpStatus, 503);
  assert.equal(runtimeFailureDetail({ message: "-----BEGIN PRIVATE KEY-----\nprivate bytes\n-----END PRIVATE KEY-----\nFailure" }).message.includes("private bytes"), false);
});

test("Codex gateway errors preserve HTTP status without publishing the local route", () => {
  const routeToken = "a1".repeat(32);
  const route = `http://127.0.0.1:12345/${routeToken}/responses`;
  const error = { message: `unexpected status 502 Bad Gateway: Model service temporarily unavailable., url: ${route}` };
  const detail = runtimeFailureDetail(error);
  assert.equal(detail.httpStatus, 502);
  assert.match(detail.message, /Model service temporarily unavailable/u);
  assert.doesNotMatch(failureDetailText(detail), /127\.0\.0\.1|\/responses/u);
  assert.ok(!detail.message.includes(routeToken));
  const event = normalizeCodexEvent({ method: "error", params: { willRetry: false, error } });
  assert.doesNotMatch(JSON.stringify(event), /127\.0\.0\.1|\/responses/u);
  assert.ok(!JSON.stringify(event).includes(routeToken));
  assert.equal(runtimeFailureDetail("Provider error at https://example.com/models").message,
    "Provider error at https://example.com/models");
});

test("a structured Codex transport status survives a completion with no HTTP status in its text", () => {
  const message = "The selected model is unavailable.";
  const error = { message, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } };
  const event = normalizeCodexEvent({ method: "turn/completed", params: { turn: { id: "turn-1", status: "failed", error } } });
  assert.deepEqual(event.failure, { message, httpStatus: 502 });
});

test("DeepSeek private bridge diagnostics are redacted by the Host before publication", () => {
  const { DeepSeekHarnessRuntimeHost } = require("../app/agent-service/deepseek-harness-runtime-host");
  const events = [];
  const host = Object.assign(Object.create(DeepSeekHarnessRuntimeHost.prototype), {
    registeredSecrets: ["fixture-provider-credential"], _publish: event => events.push(event), _finishActive() {},
  });
  host._handleEvent({ settled: false }, { type: "complete", status: "failed", errorCode: "RUNTIME_AUTH_REQUIRED",
    failure: { message: "Invalid credentials. fixture-provider-credential", httpStatus: 401, upstreamCode: "AUTH", stack: "private stack" } });
  assert.match(events[0].failure.message, /Invalid credentials/u);
  assert.ok(!/fixture-provider-credential|private stack/u.test(JSON.stringify(events)));
  host._handleEvent({ settled: false }, { type: "complete", status: "canceled", failure: { message: "stale error" } });
  assert.equal(events[1].failure, undefined);
});

test("start error wrappers preserve explicit diagnostics and ignore arbitrary Error messages", () => {
  const upstream = Object.assign(new Error("private local message"), { failure: { message: "Project is disabled", httpStatus: 403 } });
  assert.deepEqual(runtimeFailureFromError(new Error("stage failed", { cause: new Error("wrapper", { cause: upstream }) })), upstream.failure);
  assert.equal(runtimeFailureFromError(new Error("private local path", { cause: "private string" })), null);
  const cycle = new Error("private"); cycle.cause = cycle;
  assert.equal(runtimeFailureFromError(cycle), null);
  assert.equal(runtimeFailureFromError({ get failure() { throw Error("do not invoke"); } }), null);
});
