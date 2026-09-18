"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const {
  ALLOWED_CUA_TOOLS,
  ComputerUseController,
  makeCapabilityManifest,
  validateDriverBinary,
} = require("../app/agent-service/computer-use-controller");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-computer-unit-"));
  fs.chmodSync(root, 0o700);
  return root;
}

function fakeSdk(driver) {
  const factory = { new: (value) => value };
  return {
    CuaDriver: { createPrivateWorker: () => driver },
    RuntimeAuthorizationOptions: factory,
    ConfiguredDriverOptions: factory,
    PrivateWorkerOptions: factory,
    EmbeddedEnvironmentVariable: factory,
    StartSessionInput: factory,
    EndSessionInput: factory,
    SessionPermissionMode: { Bounded: 1 },
    currentMacOsPermissionStatus: () => ({ accessibility: true, screenRecording: true }),
  };
}

function makeDriver(options = {}) {
  const calls = [];
  const driver = {
    calls,
    async metadata() {
      return {
        driverVersion: "0.22.0", contractVersion: "0.7.0", embedded: true, pid: 987,
      };
    },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async shutdown() { driver.closed = true; },
    async callTool(name, argsJson) {
      const args = JSON.parse(argsJson);
      calls.push({ name, args });
      if (options.crashOn === name) throw new Error("private detail");
      if (options.permissionLossOn === name) return {
        isError: true, errorCode: "permission_denied", images: [], structuredJson: "{}",
      };
      if (name === "list_apps") return {
        isError: false, degraded: false, images: [],
        structuredJson: JSON.stringify({ apps: [
          { name: "TextEdit", bundle_id: "com.apple.TextEdit", pid: 42, running: true, active: false },
          { name: "Other", bundle_id: "com.example.Other", pid: 99, running: true, active: true },
        ] }),
      };
      if (name === "list_windows") return {
        isError: false, degraded: false, images: [],
        structuredJson: JSON.stringify({ windows: [
          { app_name: "TextEdit", pid: 42, window_id: 7, title: "Doc", bounds: { x: 1, y: 2, width: 3, height: 4 }, is_on_screen: true },
          { app_name: "Other", pid: 99, window_id: 8, title: "Secret", bounds: {}, is_on_screen: true },
        ] }),
      };
      if (name === "get_window_state") return {
        isError: false,
        degraded: false,
        images: [{ mimeType: "image/png", dataBase64: Buffer.from("tiny-image").toString("base64") }],
        structuredJson: JSON.stringify({
          snapshot_id: "s12345678",
          tree_markdown: "window tree",
          degraded: false,
          elements: [
            { element_index: 1, element_token: "token-one", role: "button", label: "Save", value: "", frame: { x: 1, y: 1, w: 2, h: 2 } },
            { element_index: 2, element_token: "token-two", role: "secure text field", label: "Password", value: "do-not-return", frame: { x: 3, y: 3, w: 4, h: 4 } },
          ],
        }),
      };
      return {
        isError: false, degraded: false, images: [], structuredJson: "{}",
        action: { effect: 0, route: 0 },
      };
    },
  };
  return driver;
}

async function withController(run, options = {}) {
  const root = makeRoot();
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  const driver = options.driver || makeDriver();
  let idle = 100;
  let locked = false;
  const expiryCallbacks = [];
  const controller = new ComputerUseController({
    paths,
    binaryPath: path.join(root, "cua-driver"),
    binaryManifest: { version: "0.22.0", contractVersion: "0.7.0" },
    verifyBinary: false,
    sdkLoader: async () => fakeSdk(driver),
    permissionStatus: options.permissionStatus || (() => ({ accessibility: true, screenRecording: true })),
    getSystemIdleTime: () => idle,
    isScreenLocked: () => locked,
    ...(options.captureExpiry ? {
      scheduleExpiry: (callback) => { expiryCallbacks.push(callback); return { unref() {} }; },
      cancelExpiry: () => {},
    } : {}),
  });
  try {
    controller.open();
    await run({
      controller, driver, paths, expiryCallbacks,
      setIdle: (value) => { idle = value; }, setLocked: (value) => { locked = value; },
    });
  } finally {
    await controller.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const manifest = makeCapabilityManifest(["com.apple.TextEdit"], 60);
  assert.equal(manifest.version, 3);
  assert.deepEqual(manifest.allow.tools, ALLOWED_CUA_TOOLS);
  assert.deepEqual(manifest.resources.apps.map((entry) => entry.bundle_id), ["com.apple.TextEdit"]);
  assert.equal(manifest.resources.desktop.display, true);
  assert.equal(manifest.allow.tools.includes("get_desktop_state"), false);
  console.log("ok 1 - bounded manifest fixes tool and application scope");

  const binaryRoot = makeRoot();
  try {
    const binary = path.join(binaryRoot, "cua-driver");
    fs.writeFileSync(binary, "verified-binary", { mode: 0o700 });
    const data = fs.readFileSync(binary);
    const binaryManifest = {
      version: "0.22.0",
      contractVersion: "0.7.0",
      binarySizeBytes: data.length,
      binarySha256: crypto.createHash("sha256").update(data).digest("hex"),
    };
    validateDriverBinary(binary, binaryManifest);
    fs.symlinkSync(binary, `${binary}.link`);
    assert.throws(() => validateDriverBinary(`${binary}.link`, binaryManifest), { code: "COMPUTER_DRIVER_INVALID" });
  } finally {
    fs.rmSync(binaryRoot, { recursive: true, force: true });
  }
  console.log("ok 2 - driver integrity rejects symlink and accepts exact hash");

  await withController(async ({ controller, driver, paths }) => {
    const session = await controller.create({
      profileId: "default", workRunId: "run-1",
      allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 60,
    });
    const capabilities = JSON.parse(fs.readFileSync(path.join(
      paths.computerEphemeralDir, session.id, "capabilities.yaml",
    ), "utf8"));
    assert.equal(capabilities.resources.apps[0].bundle_id, "com.apple.TextEdit");
    assert.deepEqual((await controller.applicationList({
      sessionId: session.id, profileId: "default", workRunId: "run-1",
    })).applications.map((app) => app.bundleId), ["com.apple.TextEdit"]);
    assert.deepEqual((await controller.windowList({
      sessionId: session.id, profileId: "default", workRunId: "run-1", onScreenOnly: true,
    })).windows.map((window) => window.windowId), [7]);
    const snapshot = await controller.snapshot({
      sessionId: session.id, profileId: "default", workRunId: "run-1", pid: 42, windowId: 7,
    });
    assert.equal(snapshot.elements[0].ref, "c1");
    assert.equal(snapshot.elements[1].secure, true);
    assert.equal(snapshot.elements[1].value, "");
    assert.equal(snapshot.image.artifact.sizeBytes, Buffer.byteLength("tiny-image"));
    const clicked = await controller.action({
      action: "click", sessionId: session.id, profileId: "default", workRunId: "run-1",
      snapshotRevision: snapshot.snapshotRevision, pid: 42, windowId: 7, ref: "c1",
    });
    assert.equal(clicked.requiresFreshSnapshot, true);
    assert.deepEqual(driver.calls.at(-1), {
      name: "click",
      args: {
        session: `shoggoth-${session.id}`, pid: 42, window_id: 7,
        delivery_mode: "background", element_token: "token-one",
      },
    });
    await assert.rejects(() => controller.action({
      action: "click", sessionId: session.id, profileId: "default", workRunId: "run-1",
      snapshotRevision: snapshot.snapshotRevision, pid: 42, windowId: 7, ref: "c1",
    }), { code: "COMPUTER_SNAPSHOT_STALE" });
  });
  console.log("ok 3 - discovery filters apps and action consumes snapshot once");

  await withController(async ({ controller, setIdle }) => {
    const session = await controller.create({
      profileId: "default", workRunId: "run-2",
      allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 60,
    });
    const secure = await controller.snapshot({
      sessionId: session.id, profileId: "default", workRunId: "run-2", pid: 42, windowId: 7,
    });
    await assert.rejects(() => controller.action({
      action: "type", sessionId: session.id, profileId: "default", workRunId: "run-2",
      snapshotRevision: secure.snapshotRevision, pid: 42, windowId: 7,
      ref: "c2", text: "secret",
    }), { code: "COMPUTER_SECURE_INPUT_FORBIDDEN" });
    const next = await controller.snapshot({
      sessionId: session.id, profileId: "default", workRunId: "run-2", pid: 42, windowId: 7,
    });
    setIdle(0);
    await assert.rejects(() => controller.action({
      action: "click", sessionId: session.id, profileId: "default", workRunId: "run-2",
      snapshotRevision: next.snapshotRevision, pid: 42, windowId: 7, ref: "c1",
    }), { code: "COMPUTER_USER_TAKEOVER" });
    assert.equal(controller.list("default")[0].status, "paused");
    assert.equal(controller.resume({
      sessionId: session.id, profileId: "default", workRunId: "run-2",
    }).status, "ready");
  });
  console.log("ok 4 - secure input and user takeover fail closed");

  await withController(async ({ controller }) => {
    const session = await controller.create({
      profileId: "default", workRunId: "run-3",
      allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 60,
    });
    await controller.closeForWorkRun("default", "run-3");
    assert.equal(controller.list("default").length, 0);
    assert.equal(session.workRunId, "run-3");
  });
  console.log("ok 5 - WorkRun terminal cleanup closes private worker");

  await withController(async ({ controller }) => {
    await assert.rejects(() => controller.create({
      profileId: "default", workRunId: "run-4",
      allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 60,
    }), { code: "COMPUTER_PERMISSION_REQUIRED" });
  }, { permissionStatus: () => ({ accessibility: false, screenRecording: false }) });
  console.log("ok 6 - missing macOS grants never starts a worker");

  await withController(async ({ controller }) => {
    const session = await controller.create({
      profileId: "default", workRunId: "run-5",
      allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 60,
    });
    await assert.rejects(() => controller.applicationList({
      sessionId: session.id, profileId: "default", workRunId: "run-5",
    }), { code: "COMPUTER_DRIVER_CRASHED" });
    assert.equal(controller.list("default")[0].status, "failed");
    await controller.closeForProfile("default");
    assert.equal(controller.list("default").length, 0);
  }, { driver: makeDriver({ crashOn: "list_apps" }) });
  console.log("ok 7 - private worker crash fails and closes only its profile session");

  await withController(async ({ controller, expiryCallbacks }) => {
    await controller.create({
      profileId: "default", workRunId: "run-6",
      allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 60,
    });
    assert.equal(expiryCallbacks.length, 1);
    expiryCallbacks[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.list("default").length, 0);
  }, { captureExpiry: true });
  console.log("ok 8 - session TTL closes the private worker without another tool call");

  await withController(async ({ controller }) => {
    const session = await controller.create({
      profileId: "default", workRunId: "run-7",
      allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 60,
    });
    await assert.rejects(() => controller.applicationList({
      sessionId: session.id, profileId: "default", workRunId: "run-7",
    }), { code: "COMPUTER_PERMISSION_REQUIRED" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.list("default").length, 0);
  }, { driver: makeDriver({ permissionLossOn: "list_apps" }) });
  console.log("ok 9 - macOS permission loss closes the active session immediately");

  await withController(async ({ controller, setLocked }) => {
    const session = await controller.create({
      profileId: "default", workRunId: "run-8",
      allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 60,
    });
    setLocked(true);
    await assert.rejects(() => controller.snapshot({
      sessionId: session.id, profileId: "default", workRunId: "run-8", pid: 42, windowId: 7,
    }), { code: "COMPUTER_SCREEN_LOCKED" });
    assert.deepEqual(controller.list("default").map(({ status, pauseReason }) => ({ status, pauseReason })), [
      { status: "paused", pauseReason: "screen_locked" },
    ]);
  });
  console.log("ok 10 - screen lock pauses before any new snapshot is captured");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
