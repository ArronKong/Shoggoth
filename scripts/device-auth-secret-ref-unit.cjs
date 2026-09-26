"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readLocalGatewayToken } = require("../app/core/device-auth");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-secret-ref-"));
const fakeToken = "synthetic-gateway-token-no-actual-credential"; // gitleaks:allow
function config(name) {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ gateway: { auth: { token: { source: "store", id: "TEST_TOKEN" } } } }));
  return file;
}
try {
  for (const extension of ["mjs", "js"]) {
    const cli = path.join(root, extension);
    fs.mkdirSync(path.join(cli, "dist"), { recursive: true });
    fs.writeFileSync(path.join(cli, "package.json"), '{"type":"module"}');
    const marker = path.join(cli, "fallback-ran");
    const bin = path.join(cli, "openclaw.mjs");
    fs.writeFileSync(bin, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'unexpected'); throw new Error('full CLI must not run');`);
    fs.writeFileSync(path.join(cli, "dist", `gateway-auth-token-fixture.${extension}`),
      `export async function gatewayAuthTokenCommand(runtime, options) { if (options.interactive !== true) throw new Error('interactive required'); process.stdout.write(${JSON.stringify(fakeToken + "\n")}); }`);
    const file = config(extension);
    const before = fs.readFileSync(file, "utf8");
    let calls = 0;
    const printed = [];
    const originalLog = console.log;
    const originalError = console.error;
    let result;
    try {
      console.log = (...values) => printed.push(values.join(" "));
      console.error = (...values) => printed.push(values.join(" "));
      result = readLocalGatewayToken(file, { platform: "darwin", openclawBin: bin,
        spawnSyncImpl(command, args, options) {
          calls++;
          assert.equal(command, "/usr/bin/env");
          assert.equal(options.timeout, 10000);
          // Run the generated loader in a real child, but select the test's
          // known Node binary instead of any ambient OpenClaw launcher.
          return spawnSync(process.execPath, args.slice(1), options);
        },
      });
    } finally { console.log = originalLog; console.error = originalError; }
    assert.equal(result, fakeToken);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(printed.some((line) => line.includes(fakeToken)), false);
    console.log(`ok - focused .${extension} loader resolves in a real child without CLI fallback, config mutation or parent token output`);
  }

  for (const success of [false, true]) {
    const file = config(success ? "slow-success" : "slow-failure");
    let clock = 1000;
    let calls = 0;
    const options = { platform: "darwin", openclawBin: "/fake/openclaw", now: () => clock,
      spawnSyncImpl() {
        calls++;
        clock += 10000;
        return success ? { status: 0, stdout: `${fakeToken}\n` } : { status: null, error: { code: "ETIMEDOUT" }, stdout: "" };
      },
    };
    assert.equal(readLocalGatewayToken(file, options), success ? fakeToken : undefined);
    clock += success ? 4999 : 999;
    assert.equal(readLocalGatewayToken(file, options), success ? fakeToken : undefined);
    assert.equal(calls, 1, "TTL must remain valid after slow resolution finishes");
    clock += 1;
    readLocalGatewayToken(file, options);
    assert.equal(calls, 2, "expired cache must retry rather than hide a repaired credential");
    console.log(`ok - slow ${success ? "success" : "failure"} cache TTL starts after resolution and expires normally`);
  }
  console.log("4 SecretRef resolver tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
