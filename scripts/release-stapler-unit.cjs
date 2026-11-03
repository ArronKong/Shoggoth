"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runStapler } = require("./release-stapler.cjs");
const network = { status: 68, stdout: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' };
function scenario(results) {
  const calls = [], waits = [];
  return { calls, waits, options: {
    execute: (file, args) => { calls.push([file, ...args]); return results[Math.min(calls.length - 1, results.length - 1)]; },
    wait: ms => waits.push(ms), log: () => {},
  } };
}
test("a transient ticket lookup retries the same operation and requires actual success", () => {
  const f = scenario([network, { status: 0, stdout: "The validate action worked!" }]);
  assert.equal(runStapler("validate", "/tmp/fixture.app", f.options).attempts, 2);
  assert.deepEqual(f.calls[0], ["/usr/bin/xcrun", "stapler", "validate", "/tmp/fixture.app"]);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.deepEqual(f.waits, [3000]);
});
test("network retries are bounded and exhaustion remains a failure", () => {
  const f = scenario([{ status: 68, stderr: "Error Domain=NSURLErrorDomain Code=-1001" }]);
  assert.throws(() => runStapler("staple", "/tmp/fixture.dmg", f.options), /attempt 4/u);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.waits, [3000, 6000, 12000]);
});
test("invalid, absent, revoked, unknown and TLS trust errors never retry", () => {
  for (const result of [
    { status: 65, stdout: "The ticket data is invalid" },
    { status: 66, stdout: "The existing ticket is missing" },
    { status: 77, stdout: "The ticket has been revoked" },
    { status: 68, stdout: "Record not found" },
    { status: 68, stdout: "NSURLErrorDomain Code=-1200" },
    { status: null, error: new Error("spawn timed out") },
  ]) {
    const f = scenario([result]);
    assert.throws(() => runStapler("validate", "/tmp/fixture.app", f.options), /STAPLER_VALIDATE_FAILED/u);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.waits, []);
  }
});
test("a permanent failure after a transient error still stops immediately", () => {
  const f = scenario([network, { status: 65, stdout: "Invalid ticket" }, { status: 0 }]);
  assert.throws(() => runStapler("validate", "/tmp/fixture.app", f.options), /exit 65/u);
  assert.equal(f.calls.length, 2);
});
