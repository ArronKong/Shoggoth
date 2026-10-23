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

function fakeSdk(driver, createWorker = () => driver) {
  const factory = { new: (value) => value };
  return {
    CuaDriver: { createPrivateWorker: createWorker },
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
  let current = 1_000, authorized = true;
  const workers = [], workerOptions = [];
  const controller = new ComputerUseController({
    paths,
    binaryPath: path.join(root, "cua-driver"),
    binaryManifest: { version: "0.22.0", contractVersion: "0.7.0" },
    verifyBinary: false,
    sdkLoader: options.sdkLoader || (async () => fakeSdk(driver, input => {
      const worker = options.driverFactory ? options.driverFactory() : driver;
      workers.push(worker); workerOptions.push(input); return worker;
    })),
    isAuthorized: options.isAuthorized || (() => authorized),
    now: () => current,
    permissionStatus: Object.hasOwn(options, "permissionStatus") ? options.permissionStatus
      : (() => ({ accessibility: true, screenRecording: true })),
    getSystemIdleTime: () => idle,
    isScreenLocked: () => locked,
  });
  try {
    controller.open();
    await run({
      controller, driver, paths, workers, workerOptions,
      advance: milliseconds => { current += milliseconds; }, revoke: () => { authorized = false; },
      setIdle: (value) => { idle = value; }, setLocked: (value) => { locked = value; },
    });
  } finally {
    await controller.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const manifest = makeCapabilityManifest(["com.apple.TextEdit"]);
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
      allowedApplications: ["com.apple.TextEdit"],
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
      allowedApplications: ["com.apple.TextEdit"],
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
      allowedApplications: ["com.apple.TextEdit"],
    });
    await controller.closeForWorkRun("default", "run-3");
    assert.equal(controller.list("default").length, 0);
    assert.equal(session.workRunId, "run-3");
  });
  console.log("ok 5 - WorkRun terminal cleanup closes private worker");

  await withController(async ({ controller }) => {
    await assert.rejects(() => controller.create({
      profileId: "default", workRunId: "run-4",
      allowedApplications: ["com.apple.TextEdit"],
    }), { code: "COMPUTER_PERMISSION_REQUIRED" });
  }, { permissionStatus: () => ({ accessibility: false, screenRecording: false }) });
  console.log("ok 6 - missing macOS grants never starts a worker");

  await withController(async ({ controller }) => {
    const session = await controller.create({
      profileId: "default", workRunId: "run-5",
      allowedApplications: ["com.apple.TextEdit"],
    });
    await assert.rejects(() => controller.applicationList({
      sessionId: session.id, profileId: "default", workRunId: "run-5",
    }), { code: "COMPUTER_DRIVER_CRASHED" });
    assert.equal(controller.list("default")[0].status, "failed");
    await controller.closeForProfile("default");
    assert.equal(controller.list("default").length, 0);
  }, { driver: makeDriver({ crashOn: "list_apps" }) });
  console.log("ok 7 - private worker crash fails and closes only its profile session");

  await withController(async ({ controller, workers, workerOptions, advance }) => {
    const input = { profileId: "default", workRunId: "run-6", allowedApplications: ["com.apple.TextEdit"] };
    const session = await controller.create(input);
    assert.equal(session.expiresAt, null);
    const common = { sessionId: session.id, profileId: "default", workRunId: "run-6" };
    // Three days of reasoning/approval gaps, each far beyond the former 900s cap.
    for (let index = 0; index < 24; index++) {
      advance(3 * 60 * 60_000);
      await controller.reconcile();
      assert.equal(controller.list("default")[0].id, session.id);
      assert.equal(workers.at(-1).closed, true);
      assert.equal((await controller.applicationList(common)).applications.length, 1);
    }
    assert.equal(workers.length, 25);
    assert.equal(controller.list("default").length, 1);
    for (const options of workerOptions) {
      assert.deepEqual(options.configuredDriver.authorization.allowedModes, [1]);
      assert.equal(options.configuredDriver.authorization.compatibilityMode, 1);
      assert.equal(options.configuredDriver.authorization.unrestrictedAcknowledged, false);
    }
    await controller.closeForWorkRun("default", "run-6");
    assert.equal(controller.list("default").length, 0);
    assert.equal(workers.every(worker => worker.closed), true);
  }, { driverFactory: () => makeDriver() });
  console.log("ok 8 - task-owned session survives three days while idle bounded workers are reclaimed and recreated");

  await withController(async ({ controller }) => {
    const session = await controller.create({
      profileId: "default", workRunId: "run-7",
      allowedApplications: ["com.apple.TextEdit"],
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
      allowedApplications: ["com.apple.TextEdit"],
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

  for (const [options, reason] of [
    [{ permissionStatus: null, sdkLoader: async () => { throw new Error("private SDK failure"); } }, "COMPUTER_DRIVER_UNAVAILABLE"],
    [{ permissionStatus: () => { throw new Error("private permission failure"); } }, "COMPUTER_PERMISSION_STATUS_FAILED"],
    [{ permissionStatus: () => ({}) }, "COMPUTER_PERMISSION_STATUS_FAILED"],
  ]) {
    await withController(async ({ controller }) => {
      const state = await controller.status("default");
      assert.equal(state.available, false);
      assert.equal(state.reason, reason);
      assert.deepEqual(state.permissions, { accessibility: null, screenRecording: null });
      await assert.rejects(() => controller.create({ profileId: "default", workRunId: "run-diagnostic",
        allowedApplications: ["com.apple.TextEdit"] }), { code: reason });
    }, options);
  }
  console.log("ok 11 - SDK and permission-read failures are not reported as denied grants");

  let granted = false;
  let requests = 0;
  await withController(async ({ controller }) => {
    assert.deepEqual((await controller.status()).permissions,
      { accessibility: false, screenRecording: false });
    assert.deepEqual(await controller.requestPermissions(),
      { accessibility: true, screenRecording: true });
    assert.deepEqual((await controller.status()).permissions,
      { accessibility: true, screenRecording: true });
    assert.equal(requests, 1);
  }, { permissionStatus: null, sdkLoader: async () => ({ ...fakeSdk(makeDriver()),
    currentMacOsPermissionStatus: () => ({ accessibility: granted, screenRecording: granted }),
    requestMacOsPermissions: () => { requests += 1; granted = true; return { accessibility: true, screenRecording: true }; },
  }) });
  console.log("ok 12 - permission request and subsequent status run in the same Service SDK host");

  await withController(async ({ controller }) => {
    assert.deepEqual(await controller.requestPermissions(),
      { accessibility: false, screenRecording: false });
  }, { permissionStatus: () => ({ accessibility: false, screenRecording: false }),
    sdkLoader: async () => ({ ...fakeSdk(makeDriver()),
      requestMacOsPermissions: () => ({ accessibility: true, screenRecording: true }),
    }) });
  console.log("ok 13 - prompt response does not override the actual post-request permission check");
  await withController(async ({ controller, workers, advance }) => {
    const session = await controller.create({ profileId: "default", workRunId: "lease-refresh",
      allowedApplications: ["com.apple.TextEdit"] });
    const common = { sessionId: session.id, profileId: "default", workRunId: "lease-refresh" };
    const snapshot = await controller.snapshot({ ...common, pid: 42, windowId: 7 });
    // Keep the worker busy enough to avoid idle collection, but reach grant renewal.
    for (let i = 0; i < 14; i++) { advance(60_000); await controller.applicationList(common); }
    assert.equal(workers.length, 2);
    await assert.rejects(controller.action({ ...common, action: "click", pid: 42, windowId: 7,
      snapshotRevision: snapshot.snapshotRevision, ref: "c1" }), { code: "COMPUTER_SNAPSHOT_STALE" });
    assert.equal(workers.every(worker => worker.calls.every(call => call.name !== "click")), true);
    await assert.rejects(controller.closeSession({ ...common, workRunId: "other-run" }), { code: "COMPUTER_SESSION_FORBIDDEN" });
  }, { driverFactory: () => makeDriver() });
  console.log("ok 14 - continuous tasks renew bounded grants and old refs never reach the replacement worker");

  await withController(async ({ controller, workers, advance, revoke }) => {
    const session = await controller.create({ profileId: "default", workRunId: "revoked",
      allowedApplications: ["com.apple.TextEdit"] });
    advance(3 * 24 * 60 * 60_000); revoke();
    await controller.reconcile();
    assert.equal(controller.list("default").length, 0);
    assert.equal(workers.length, 1); assert.equal(workers[0].closed, true);
    await assert.rejects(controller.applicationList({ sessionId: session.id, profileId: "default", workRunId: "revoked" }),
      { code: "COMPUTER_SESSION_NOT_FOUND" });
  });
  console.log("ok 15 - revoked ownership is reclaimed without restarting an idle worker");

  let release, started = false, clicks = 0;
  const inFlight = new Promise(resolve => { release = resolve; });
  const delayed = makeDriver(), originalCall = delayed.callTool;
  delayed.callTool = async (name, args) => {
    if (name === "click") { clicks++; started = true; await inFlight; }
    return originalCall(name, args);
  };
  await withController(async ({ controller, advance }) => {
    const session = await controller.create({ profileId: "default", workRunId: "drain",
      allowedApplications: ["com.apple.TextEdit"] });
    const common = { sessionId: session.id, profileId: "default", workRunId: "drain" };
    const snapshot = await controller.snapshot({ ...common, pid: 42, windowId: 7 });
    const pending = controller.action({ ...common, action: "click", pid: 42, windowId: 7,
      snapshotRevision: snapshot.snapshotRevision, ref: "c1" });
    const rejected = assert.rejects(pending, { code: "COMPUTER_SESSION_NOT_FOUND" });
    while (!started) await new Promise(resolve => setImmediate(resolve));
    advance(180_000); await controller.reconcile();
    assert.equal(delayed.closed, undefined, "idle sweeps cannot interrupt input");
    await assert.rejects(controller.applicationList(common), { code: "COMPUTER_SESSION_BUSY" });
    const closing = controller.closeForWorkRun("default", "drain");
    assert.equal(delayed.closed, undefined, "teardown must drain the input outcome first");
    release(); await rejected; await closing;
    assert.equal(delayed.closed, true); assert.equal(clicks, 1);
    assert.equal(controller.list("default").length, 0);
  }, { driver: delayed });
  console.log("ok 16 - idle collection and task teardown drain in-flight input without replay");


  await withController(async ({ controller, workers, advance }) => {
    const session = await controller.create({ profileId: "default", workRunId: "paused-idle",
      allowedApplications: ["com.apple.TextEdit"] });
    const common = { sessionId: session.id, profileId: "default", workRunId: "paused-idle" };
    await controller.snapshot({ ...common, pid: 42, windowId: 7 });
    controller.pauseAll("system_suspended"); advance(120_001);
    await controller.reconcile();
    assert.equal(workers[0].closed, true);
    await controller.applicationList(common);
    assert.equal(workers.length, 2);
    assert.equal(controller.list()[0].status, "paused");
    assert.equal(controller.list()[0].pauseReason, "system_suspended");
    await assert.rejects(controller.focus({ ...common, pid: 42, bundleId: "com.apple.TextEdit", windowId: 7 }),
      { code: "COMPUTER_SESSION_PAUSED" });
    controller.resume(common);
    assert.equal(controller.list()[0].status, "ready");
    assert.equal(workers[1].calls.some(call => call.name === "bring_to_front"), false);
  }, { driverFactory: () => makeDriver() });
  console.log("ok 17 - idle recycling never resumes a session paused for user takeover or suspend");

  let releaseStart;
  const starting = new Promise(resolve => { releaseStart = resolve; });
  await withController(async ({ controller, workers }) => {
    const create = run => controller.create({ profileId: "default", workRunId: run,
      allowedApplications: ["com.apple.TextEdit"] });
    const first = create("starting-a"), rejected = assert.rejects(first, { code: "COMPUTER_SESSION_NOT_FOUND" });
    const second = create("starting-b");
    while (workers.length < 2) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(create("starting-c"), { code: "COMPUTER_SESSION_CAPACITY" });
    const closing = controller.closeForWorkRun("default", "starting-a");
    releaseStart(); await closing; await rejected;
    const opened = await second;
    assert.equal(controller.list().length, 1); assert.equal(controller.list()[0].id, opened.id);
    assert.equal(workers[0].closed, true); assert.equal(workers[1].closed, undefined);
  }, { driverFactory: () => {
    const worker = makeDriver(), metadata = worker.metadata;
    worker.metadata = async () => { await starting; return metadata(); };
    return worker;
  } });
  console.log("ok 18 - asynchronous startup reserves capacity and cancelled startup cannot publish or leak a worker");

  let refuseShutdown = true;
  const retained = makeDriver();
  retained.shutdown = async () => { if (refuseShutdown) throw new Error("private shutdown failure"); retained.closed = true; };
  await withController(async ({ controller, workers, advance }) => {
    const session = await controller.create({ profileId: "default", workRunId: "uncertain-exit",
      allowedApplications: ["com.apple.TextEdit"] });
    advance(120_001); await controller.reconcile(); await controller.reconcile();
    assert.equal(controller.list()[0].status, "close_failed");
    await assert.rejects(controller.applicationList({ sessionId: session.id, profileId: "default", workRunId: "uncertain-exit" }),
      { code: "COMPUTER_SESSION_NOT_FOUND" });
    assert.equal(workers.length, 1, "an unconfirmed exit cannot create a replacement worker");
    refuseShutdown = false; await controller.reconcile();
    assert.equal(controller.list().length, 0); assert.equal(retained.closed, true);
  }, { driver: retained });
  console.log("ok 19 - unconfirmed worker exit retains ownership and capacity until cleanup succeeds");

  let releasePausedStart;
  const pausedStart = new Promise(resolve => { releasePausedStart = resolve; });
  await withController(async ({ controller, workers }) => {
    const opening = controller.create({ profileId: "default", workRunId: "paused-start",
      allowedApplications: ["com.apple.TextEdit"] });
    while (workers.length < 1) await new Promise(resolve => setImmediate(resolve));
    controller.pauseAll("system_suspended");
    releasePausedStart();
    const session = await opening;
    assert.equal(session.status, "paused"); assert.equal(session.pauseReason, "system_suspended");
    await assert.rejects(controller.focus({ sessionId: session.id, profileId: "default", workRunId: "paused-start",
      pid: 42, bundleId: "com.apple.TextEdit", windowId: 7 }), { code: "COMPUTER_SESSION_PAUSED" });
    assert.equal(workers[0].calls.some(call => call.name === "bring_to_front"), false);
  }, { driverFactory: () => {
    const worker = makeDriver(), metadata = worker.metadata;
    worker.metadata = async () => { await pausedStart; return metadata(); };
    return worker;
  } });
  console.log("ok 20 - suspend during startup cannot publish an automatically resumed session");

  let releaseClosingCall, enteredClosingCall;
  const closingCall = new Promise(resolve => { releaseClosingCall = resolve; });
  const enteredClosing = new Promise(resolve => { enteredClosingCall = resolve; });
  const stoppingDriver = makeDriver(), originalClosingCall = stoppingDriver.callTool;
  stoppingDriver.callTool = async (...args) => { enteredClosingCall(); await closingCall; return originalClosingCall(...args); };
  await withController(async ({ controller }) => {
    const session = await controller.create({ profileId: "default", workRunId: "service-stop",
      allowedApplications: ["com.apple.TextEdit"] });
    const operation = controller.applicationList({ sessionId: session.id, profileId: "default", workRunId: "service-stop" });
    const rejectedOperation = assert.rejects(operation, { code: "COMPUTER_CONTROLLER_CLOSED" });
    await enteredClosing;
    const closing = controller.close();
    await assert.rejects(controller.create({ profileId: "default", workRunId: "late-start",
      allowedApplications: ["com.apple.TextEdit"] }), { code: "COMPUTER_CONTROLLER_CLOSED" });
    assert.equal(stoppingDriver.closed, undefined);
    releaseClosingCall(); await rejectedOperation; await closing;
    assert.equal(stoppingDriver.closed, true); assert.equal(controller.sessions.size, 0);
  }, { driver: stoppingDriver });
  console.log("ok 21 - service stop revokes new session admission before draining operations");

  let permissionsGranted = true;
  await withController(async ({ controller, driver }) => {
    const session = await controller.create({ profileId: "default", workRunId: "tcc-revoked",
      allowedApplications: ["com.apple.TextEdit"] });
    permissionsGranted = false;
    await assert.rejects(controller.applicationList({ sessionId: session.id, profileId: "default", workRunId: "tcc-revoked" }),
      { code: "COMPUTER_PERMISSION_REQUIRED" });
    await controller.closeForWorkRun("default", "tcc-revoked");
    assert.equal(driver.calls.length, 0); assert.equal(driver.closed, true); assert.equal(controller.list().length, 0);
  }, { permissionStatus: () => ({ accessibility: permissionsGranted, screenRecording: permissionsGranted }) });
  console.log("ok 22 - every operation rechecks TCC before using an existing worker");

}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
