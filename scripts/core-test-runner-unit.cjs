"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { runCoreTests } = require("./core-tests.cjs");
const names = ["memory-content-unit.cjs", "core-test-runner-unit.cjs"];

test("the core gate runs all named scripts and preserves process, launch and signal failures", () => {
  for (const failed of [{ status: 1 }, { status: null, signal: "SIGTERM" }, { status: 0, error: new Error("spawn failed") }]) {
    const called = [];
    assert.equal(runCoreTests(names, { log() {}, run(command, args) {
      assert.equal(command, process.execPath); called.push(args[0]);
      return called.length === 1 ? failed : { status: 0 };
    } }), false);
    assert.equal(called.length, 2, "a failure cannot hide another script's outcome");
  }
  assert.equal(runCoreTests(names, { log() {}, run: () => ({ status: 0 }) }), true);
});

test("an empty, duplicate, missing or escaping manifest fails before executing anything", () => {
  for (const manifest of [[], [names[0], names[0]], ["missing-unit.cjs"], ["../memory-content-unit.cjs"]]) {
    assert.throws(() => runCoreTests(manifest, { log() {}, run: () => assert.fail("invalid manifest executed") }), /manifest/u);
  }
});
