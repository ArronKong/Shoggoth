"use strict";
const assert = require("node:assert/strict");
const { HermesBackend } = require("../app/core/hermes-backend");

// Exercise the actual backend method without constructing/spawning a live host.
async function fixture(command, responses) {
  const calls = [];
  const backend = Object.create(HermesBackend.prototype);
  backend._slashDash = () => ({});
  backend._gwEnsureRuntime = async () => ({ m: { runtimeId: "fixture-runtime" }, sock: {
    async request(method, params, options) {
      calls.push({ method, params, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  } });
  const result = await backend.execSlash("hermes-default", "fixture-session", command);
  return { result, calls };
}

(async () => {
  for (const command of ["/compress", "compress", "/compress --keep 10"]) {
    const { result, calls } = await fixture(command, [{ type: "exec", output: "Compressed" }]);
    assert.equal(result.text, "Compressed");
    assert.equal(calls[0].options.timeoutMs, 660_000, "manual compression can outlast the gateway's 630s waiter");
    assert.equal(calls[0].params.session_id, "fixture-runtime");
    assert.equal(calls.length, 1);
  }
  for (const command of ["/status", "/compressor"]) {
    const { calls } = await fixture(command, [{ output: "ok" }]);
    assert.equal(calls[0].options.timeoutMs, 60_000, "ordinary commands keep their existing bound");
  }
  const alias = await fixture("/compact", [{ type: "alias", target: "/compress" }, { type: "exec", output: "done" }]);
  assert.deepEqual(alias.calls.map(call => call.options.timeoutMs), [60_000, 660_000]);
  for (const message of ["slash.exec 超时", "连接中断"]) {
    const { result, calls } = await fixture("/compress", [Object.assign(new Error(message), { executionUncertain: true })]);
    assert.deepEqual(result, { kind: "output", text: message, executionUncertain: true });
    assert.equal(calls.length, 1, "uncertain side effects cannot be retried automatically");
  }
  for (const error of [new Error("permission denied"), Object.assign(new Error("not sent"), { executionUncertain: false })]) {
    await assert.rejects(fixture("/compress", [error]), caught => caught === error, "explicit rejection remains a failure");
  }
  const pending = await fixture("/compress", [{ type: "exec", status: "pending", output: "still compressing" }]);
  assert.equal(pending.result.executionUncertain, true, "Hermes pending ACK is not a completed command");
  for (const [type, payload, expected] of [["send", { message: "expanded" }, "expanded"], ["prefill", { text: "draft" }, "draft"]]) {
    const { result } = await fixture("/command", [{ type, ...payload }]);
    assert.deepEqual(result, { kind: type, text: expected });
  }
  console.log("PASS Hermes slash execution: bounded compression wait, ordinary limits, alias, uncertainty/no retry, rejection, pending ACK, typed output");
})().catch(error => { console.error(error); process.exitCode = 1; });
