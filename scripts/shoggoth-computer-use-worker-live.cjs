"use strict";

// Opt-in macOS smoke: real pinned SDK/private workers, temporary manifests,
// nonexistent application scope, no app discovery, snapshots or desktop input.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repo = path.resolve(__dirname, "..");
if (process.platform !== "darwin") throw new Error("This opt-in smoke requires macOS");
const { makeCapabilityManifest, validateDriverBinary } = require(path.join(repo, "app/agent-service/computer-use-controller.js"));
const manifest = require(path.join(repo, "build/cua-driver-manifest.json"));

async function main() {
  const binaryPath = fs.realpathSync(path.join(repo, manifest.destination));
  validateDriverBinary(binaryPath, manifest);
  const packageRoot = path.join(repo, "node_modules/@trycua/cua-driver");
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const entry = path.join(packageRoot, packageJson.exports["."].import);
  const sdk = await import(pathToFileURL(entry).href);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-worker-lifetime-live-")));
  const pids = [];
  let driver;
  try {
    for (let index = 0; index < 2; index++) {
      const manifestPath = path.join(root, `capabilities-${index}.yaml`);
      const capability = makeCapabilityManifest(["com.shoggoth.lifetime.fixture"]);
      fs.writeFileSync(manifestPath, JSON.stringify(capability), { mode: 0o600 });
      const seconds = BigInt(capability.expires_after.slice(0, -1));
      assert.equal(capability.idle_timeout, capability.expires_after);
      const authorization = sdk.RuntimeAuthorizationOptions.new({
        allowedModes: [sdk.SessionPermissionMode.Bounded], compatibilityMode: sdk.SessionPermissionMode.Bounded,
        compatibilityCapabilityManifestPath: manifestPath, unrestrictedAcknowledged: false,
        maxSessionTtlSeconds: seconds, maxIdleTtlSeconds: seconds,
      });
      driver = sdk.CuaDriver.createPrivateWorker(sdk.PrivateWorkerOptions.new({
        binaryPath, hostBundleId: "ai.shoggoth.desktop", startupTimeoutMs: 10_000n, shutdownTimeoutMs: 3_000n,
        configuredDriver: sdk.ConfiguredDriverOptions.new({ claudeCodeCompatibility: false, authorization }),
        environment: [sdk.EmbeddedEnvironmentVariable.new({ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" })],
        inheritStderr: false,
      }));
      const metadata = await driver.metadata();
      assert.equal(metadata.driverVersion, "0.22.0"); assert.equal(metadata.contractVersion, "0.7.0");
      assert.equal(metadata.embedded, true); assert(metadata.pid > 0); pids.push(metadata.pid);
      const session = "shoggoth-lifetime-fixture";
      const opened = await driver.startSession(sdk.StartSessionInput.new({ session }));
      assert.equal(opened.active, true);
      await driver.endSession(sdk.EndSessionInput.new({ session }));
      await driver.shutdown(); driver = null;
    }
    assert.notEqual(pids[0], pids[1]);
    console.log(JSON.stringify({ verified: true, driver: "0.22.0", contract: "0.7.0", bounded: true,
      workersCreatedAndClosed: pids.length, desktopInput: false, tccAcceptance: false }));
  } finally {
    if (driver) await driver.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
