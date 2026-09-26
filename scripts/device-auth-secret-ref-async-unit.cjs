"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readLocalGatewayTokenAsync, createAuthResolver } = require("../app/core/device-auth");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-secret-async-"));
const fakeToken = "synthetic-async-token-no-actual-credential"; // gitleaks:allow
function fixture(name, body) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  const bin = path.join(dir, "openclaw.mjs");
  fs.writeFileSync(bin, "throw new Error('fixture CLI fallback unavailable');");
  fs.writeFileSync(path.join(dir, "dist/gateway-auth-token-fixture.mjs"),
    `export async function gatewayAuthTokenCommand() { ${body} }`);
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ gateway: { auth: { token: { source: "store", id: "TEST_TOKEN" } } } }));
  return { bin, config };
}
const realSpawn = (command, args, options) => {
  assert.equal(command, "/usr/bin/env");
  return spawn(process.execPath, args.slice(1), options);
};
async function main() {
  const slow = fixture("single-flight", `await new Promise(r => setTimeout(r, 150)); process.stdout.write(${JSON.stringify(fakeToken + "\n")});`);
  let spawns = 0;
  let timerRan = false;
  setTimeout(() => { timerRan = true; }, 5);
  const source = fs.readFileSync(slow.config, "utf8");
  const values = await Promise.all(Array.from({ length: 8 }, () => readLocalGatewayTokenAsync(slow.config, {
    platform: "darwin", openclawBin: slow.bin,
    spawnImpl(...args) { spawns++; return realSpawn(...args); },
  })));
  assert.equal(spawns, 1);
  assert.equal(timerRan, true, "event loop must run while credential child waits");
  assert.equal(values.every(value => value === fakeToken), true);
  assert.equal(fs.readFileSync(slow.config, "utf8"), source);
  console.log("ok - eight concurrent reads share one real child while the event loop stays responsive and config remains unchanged");

  const failed = fixture("slow-miss", "throw new Error('fixture credential unavailable');");
  let clock = 1000;
  let failedSpawns = 0;
  const options = { platform: "darwin", openclawBin: failed.bin, now: () => clock,
    spawnImpl(...args) {
      failedSpawns++;
      const child = realSpawn(...args);
      child.once("close", () => { clock += 10000; });
      return child;
    },
  };
  assert.equal(await readLocalGatewayTokenAsync(failed.config, options), undefined);
  clock += 999;
  assert.equal(await readLocalGatewayTokenAsync(failed.config, options), undefined);
  assert.equal(failedSpawns, 1);
  clock++;
  assert.equal(await readLocalGatewayTokenAsync(failed.config, options), undefined);
  assert.equal(failedSpawns, 2);
  console.log("ok - asynchronous failure cache starts at completion and retries after its unchanged TTL");

  const flood = fixture("output-cap", "process.stdout.write('x'.repeat(65536)); await new Promise(r => setTimeout(r, 20000));");
  assert.equal(await readLocalGatewayTokenAsync(flood.config, { platform: "darwin", openclawBin: flood.bin, spawnImpl: realSpawn }), undefined);
  console.log("ok - excessive child output fails closed without leaking captured bytes");

  const hang = fixture("deadline", "await new Promise(() => { setInterval(() => {}, 1000); });");
  let pid;
  const value = await readLocalGatewayTokenAsync(hang.config, { platform: "darwin", openclawBin: hang.bin,
    spawnImpl(...args) { const child = realSpawn(...args); pid = child.pid; return child; },
  });
  assert.equal(value, undefined);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  console.log("ok - real ten-second deadline terminates only the owned child group and naturally closes");

  const resolver = createAuthResolver({ getConfig: () => ({ gatewayUrl: "wss://example.invalid" }),
    credentialsDir: path.join(root, "credentials"), operatorIdentityDir: path.join(root, "missing-operator"),
    localGatewayConfigPath: slow.config,
  });
  const remote = await resolver.resolveConnectAuthAsync();
  assert.equal(remote.token, undefined);
  assert.equal(remote.deviceToken, undefined);
  console.log("ok - asynchronous remote Gateway auth never borrows the local SecretRef token");
  console.log("5 asynchronous SecretRef tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
