"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { prepareBackgroundRoleActivation } = require("../app/background-role-activation");
const bootstrap = require("../app/bootstrap-role");

test("all internal background launches are hidden, including rejected role arguments", () => {
  for (const role of ["agent-service", "mcp", "mcp-crypto", "unknown", ""]) {
    const calls = [];
    assert.equal(prepareBackgroundRoleActivation({
      argv: [`--shoggoth-internal-role=${role}`], platform: "darwin", env: {},
      electronApp: { setActivationPolicy: (policy) => calls.push(policy) },
    }), true);
    assert.deepEqual(calls, ["prohibited"]);
  }
});

test("UI, Node-mode and non-macOS processes keep their normal launch behavior", () => {
  for (const options of [
    { argv: [] },
    { argv: ["--shoggoth-internal-role=ui"] },
    { env: { ELECTRON_RUN_AS_NODE: "1" } },
    { platform: "linux" },
    { platform: "win32" },
  ]) {
    assert.equal(prepareBackgroundRoleActivation({
      platform: "darwin", argv: ["--shoggoth-internal-role=mcp"], env: {},
      electronApp: { setActivationPolicy: () => assert.fail("unexpected activation change") },
      ...options,
    }), false);
  }
});

test("production bootstrap hides before loading validators and still rejects invalid roles", async () => {
  const calls = [];
  const argv = ["--shoggoth-internal-role=agent-service"];
  const electronApp = {
    setActivationPolicy: (policy) => calls.push(policy),
    exit: (code) => calls.push(`exit:${code}`),
  };
  const source = fs.readFileSync(path.join(__dirname, "../app/bootstrap.js"), "utf8");
  await vm.runInNewContext(source, {
    require(name) {
      if (name === "./background-role-activation") return {
        prepareBackgroundRoleActivation: () => prepareBackgroundRoleActivation({
          argv, env: {}, platform: "darwin", electronApp,
        }),
      };
      if (name === "./bootstrap-role") {
        calls.push("load-validators");
        return {
          bootstrapFailureCode: bootstrap.bootstrapFailureCode,
          main: () => bootstrap.main(argv, {}, { platform: "darwin" }, {
            ui: () => assert.fail("rejected role must not start UI"),
            service: () => assert.fail("rejected role must not start Service"),
          }),
        };
      }
      if (name === "electron") return { app: electronApp };
      assert.fail(`unexpected module ${name}`);
    },
    console: { error: (message) => calls.push(message) },
  });
  assert.deepEqual(calls, [
    "prohibited", "load-validators",
    "[bootstrap] startup failure: BOOTSTRAP_ROLE_REJECTED", "exit:1",
  ]);
});
