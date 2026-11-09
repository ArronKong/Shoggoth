"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

for (const native of [false, true]) test(`intentional stop keeps partial ${native ? "native content" : "text"} and settles once`, async () => {
  const backend = new ShoggothBackend({}), calls = [];
  const parts = [{ type: "text", text: "已查到门店，尚未下单。", segmentId: "partial" }];
  const state = { text: parts[0].text, settled: false,
    ...(native ? { nativeContent: { hasUi: true, parts } } : {}) };
  const context = { sessionKey: "session-stop", run: { id: "run-stop" }, poll: {}, hooks: {
    final: (...args) => calls.push(["final", ...args]),
    error: (...args) => calls.push(["error", ...args]),
    nativeContent: (...args) => calls.push(["native", ...args]),
  } };
  backend._activeBySession.set(context.sessionKey, { runId: context.run.id });
  const terminal = { id: context.run.id, status: "canceled", errorCode: null };
  await backend._settleTerminal(context, state, terminal, { skipHistory: true });
  await backend._settleTerminal(context, state, terminal, { skipHistory: true });
  assert.equal(calls.length, 1, "exactly one terminal callback");
  if (native) assert.deepEqual(calls[0], ["native", "aborted", parts, { runId: "run-stop", displayId: "native-run:run-stop" }]);
  else assert.deepEqual(calls[0], ["final", parts[0].text, false,
    { runId: "run-stop", displayId: "native-run:run-stop", stopReason: "aborted" }]);
  assert.equal(backend._activeBySession.has(context.sessionKey), false);
});

test("a real failure remains visible even when the run is canceled", async () => {
  const backend = new ShoggothBackend({}), errors = [], finals = [];
  await backend._settleTerminal({ sessionKey: "session-stop", run: { id: "run-stop" }, poll: {},
    hooks: { error: value => errors.push(value), final: value => finals.push(value) } },
  { text: "partial", settled: false }, { id: "run-stop", status: "canceled", errorCode: "SERVICE_RESTARTED" }, { skipHistory: true });
  assert.deepEqual(errors, ["Agent Service 已重启，本次任务已中断，请重试"]);
  assert.deepEqual(finals, []);
});

test("a detached observer does not deliver a late stop into another conversation", async () => {
  const backend = new ShoggothBackend({});
  await backend._settleTerminal({ sessionKey: "session-stop", run: { id: "run-stop" }, poll: { consumerCancelled: true },
    hooks: { final: () => assert.fail("detached observer received a terminal"), error: () => assert.fail("detached observer received an error") } },
  { text: "partial", settled: false }, { id: "run-stop", status: "canceled", errorCode: null }, { skipHistory: true });
});
