#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const { createEventBuffer } = require(path.join(ROOT, "app", "agent-service", "event-buffer.js"));
const {
  DEFAULT_AGENT_PROFILE_ID,
  defaultAgentProfile,
  snapshotChecksum,
  JsonlProductStore,
  STORE_SCHEMA_VERSION,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const {
  ensurePrivateDirectoryTree,
} = require(path.join(ROOT, "app", "agent-service", "security.js"));
const {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  createAgentService,
} = require(path.join(ROOT, "app", "agent-service", "server.js"));
const {
  readClientToken,
  requestService,
} = require(path.join(ROOT, "app", "agent-service", "client.js"));
const {
  startAgentServiceProcess,
} = require(path.join(ROOT, "app", "agent-service.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fixturePaths(prefix = "shoggoth-phase12-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("等待条件超时");
}

test("RED event ring 拒绝数组 accessor 且 getter 零执行", () => {
  let getterCalls = 0;
  const payload = [];
  Object.defineProperty(payload, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return "fixture-secret-canary";
    },
  });
  payload.length = 1;
  const events = createEventBuffer(MAX_FRAME_BYTES);
  assert.throws(
    () => events.append("fixture.hostile", payload),
    (error) => error.code === "INVALID_EVENT",
  );
  assert.equal(getterCalls, 0);
  assert.equal(events.stats().count, 0);
});

test("RED private directory tree 收紧已存在中间目录为 0700", () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-phase12-perms-"));
  const intermediate = path.join(trustedRoot, "owned-but-wide");
  const target = path.join(intermediate, "private", "state");
  fs.mkdirSync(intermediate, { mode: 0o755 });
  fs.chmodSync(intermediate, 0o755);
  ensurePrivateDirectoryTree(target, trustedRoot);
  assert.equal(fs.statSync(trustedRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(intermediate).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(intermediate, "private")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(target).mode & 0o777, 0o700);
});

test("RED Service stop drain 等待在途 mutation 响应完成后才拆 socket", async () => {
  const paths = fixturePaths("shoggoth-phase12-drain-");
  const entered = deferred();
  const release = deferred();
  const service = createAgentService({
    paths,
    version: "phase12-drain",
    nativeDomainServiceController: {
      async handle(method) {
        assert.equal(method, "kanban.board.list");
        entered.resolve();
        await release.promise;
        return { boards: [], nextCursor: null, hasMore: false };
      },
    },
  });
  await service.start();
  const token = readClientToken(paths);
  const outcome = requestService(paths, {
    token,
    version: PROTOCOL_VERSION,
    method: "kanban.board.list",
    params: { profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 10 },
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  await entered.promise;
  const stopping = service.stop({ notify: false });
  await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  const response = await outcome;
  await stopping.catch(() => {});
  assert.equal(response.ok, true, response.error?.code || response.error?.message);
  assert.deepEqual(response.value, { boards: [], nextCursor: null, hasMore: false });
});

test("Service stop drain 在 handler 返回后仍等待响应 write callback/EOF", async () => {
  const paths = fixturePaths("shoggoth-phase12-flush-");
  const writeEntered = deferred();
  const releaseWrite = deferred();
  let activeServer = null;
  const service = createAgentService({
    paths,
    version: "phase12-flush",
    onServerReady(server) { activeServer = server; },
  });
  await service.start();
  activeServer.on("connection", (socket) => {
    const originalWrite = socket.write.bind(socket);
    socket.write = (chunk, callback) => {
      writeEntered.resolve();
      void releaseWrite.promise.then(() => originalWrite(chunk, callback));
      return false;
    };
  });
  const token = readClientToken(paths);
  const outcome = requestService(paths, {
    token, version: PROTOCOL_VERSION, method: "service.status", params: {},
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  await writeEntered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = service.stop({ notify: false });
  await new Promise((resolve) => setImmediate(resolve));
  releaseWrite.resolve();
  const response = await outcome;
  await stopping.catch(() => {});
  assert.equal(response.ok, true, response.error?.code || response.error?.message);
  assert.equal(response.value.healthy, true);
});

test("RED Service 基础方法拒绝额外 envelope/params，不忽略未知 authority", async () => {
  const paths = fixturePaths("shoggoth-phase12-exact-");
  const service = createAgentService({ paths, version: "phase12-exact" });
  await service.start();
  try {
    const token = readClientToken(paths);
    for (const request of [
      {
        token,
        version: PROTOCOL_VERSION,
        method: "service.status",
        params: { actor: "attacker" },
      },
      {
        token,
        version: PROTOCOL_VERSION,
        method: "service.hello",
        params: {},
        actor: "attacker",
      },
      {
        token,
        version: PROTOCOL_VERSION,
        method: "service.hello",
        params: { actor: "attacker" },
      },
      {
        token,
        version: PROTOCOL_VERSION,
        method: "service.stop",
        params: { actor: "attacker" },
      },
      {
        token,
        version: PROTOCOL_VERSION,
        method: "events.subscribe",
        params: { afterSeq: 0, actor: "attacker" },
      },
      {
        token,
        version: PROTOCOL_VERSION,
        method: "events.subscribe",
        params: { afterSeq: -1 },
      },
      {
        token,
        version: PROTOCOL_VERSION,
        method: "events.subscribe",
        params: { afterSeq: "0" },
      },
      {
        token,
        version: PROTOCOL_VERSION,
        method: "events.subscribe",
        params: {},
        actor: "attacker",
      },
    ]) {
      await assert.rejects(
        requestService(paths, request),
        (error) => error.code === "INVALID_PARAMS" || error.code === "INVALID_REQUEST",
      );
    }
    assert.equal((await requestService(paths, {
      token, version: PROTOCOL_VERSION, method: "service.status", params: {},
    })).healthy, true, "invalid service.stop 必须零副作用");
  } finally {
    await service.stop({ notify: false });
  }
});

test("RED runtime server logger 对 hostile error descriptor 零读取且固定脱敏", async () => {
  const paths = fixturePaths("p12-log-");
  let activeServer = null;
  let getterCalls = 0;
  const logged = [];
  const originalConsoleError = console.error;
  const service = createAgentService({
    paths,
    version: "phase12-runtime-log",
    onServerReady(server) { activeServer = server; },
  });
  await service.start();
  const originalStop = service.stop;
  let errorTriggeredStop;
  let stopCalls = 0;
  service.stop = (options) => {
    stopCalls += 1;
    errorTriggeredStop = Reflect.apply(originalStop, service, [options]);
    return errorTriggeredStop;
  };
  let stopTimer;
  console.error = (...values) => { logged.push(values.map(String).join(" ")); };
  try {
    const hostile = {};
    Object.defineProperty(hostile, "code", {
      get() {
        getterCalls += 1;
        throw new Error("fixture-secret-canary getter");
      },
    });
    activeServer.emit("error", hostile);
    assert.equal(stopCalls, 1, "原 error handler 必须自行发起 stop");
    assert.equal(typeof errorTriggeredStop?.then, "function");
    // Stop drains resources after server.close; embedding close alone permits
    // two 2s waits. Observe its real Promise, not a 1s socket/log polling race.
    // The 10s bound only detects a stuck fixture; it does not alter product grace.
    await Promise.race([
      errorTriggeredStop,
      new Promise((_, reject) => {
        stopTimer = setTimeout(() => reject(new Error("fixture Service stop did not settle")), 10_000);
      }),
    ]);
    assert.equal(stopCalls, 1, "等待回执不得另行触发 stop");
    assert.equal(fs.existsSync(paths.socketPath), false);
    assert.equal(logged.length, 1);
  } finally {
    clearTimeout(stopTimer);
    service.stop = originalStop;
    console.error = originalConsoleError;
    await service.stop({ notify: false }).catch(() => {});
  }
  assert.equal(getterCalls, 0);
  assert.equal(logged.some((line) => line.includes("fixture-secret-canary")), false);
  assert.equal(logged.length, 1);
  assert.deepEqual(logged, ["[agent-service] runtime server failure: SERVER_ERROR"]);
});

test("agent-service 生产 runtime reporter 不读 hostile code 且不记录原始错误", async () => {
  const paths = fixturePaths("p12-process-log-");
  let activeServer = null;
  let getterCalls = 0;
  const logged = [];
  const originalConsoleError = console.error;
  const originalExitCode = process.exitCode;
  const service = await startAgentServiceProcess({
    paths,
    version: "phase12-process-log",
    onServerReady(server) { activeServer = server; },
  });
  console.error = (...values) => { logged.push(values.map(String).join(" ")); };
  try {
    const hostile = {};
    Object.defineProperty(hostile, "code", {
      get() {
        getterCalls += 1;
        return "fixture-secret-canary";
      },
    });
    activeServer.emit("error", hostile);
    await waitFor(() => !fs.existsSync(paths.socketPath) && logged.length > 0);
  } finally {
    console.error = originalConsoleError;
    process.exitCode = originalExitCode;
    await service.stop({ notify: false }).catch(() => {});
  }
  assert.equal(getterCalls, 0);
  assert.equal(logged.some((line) => line.includes("fixture-secret-canary")), false);
  assert.deepEqual(logged, ["[agent-service] shutdown failure: SERVICE_STOP_FAILED"]);
});

test("bootstrap crash logger 对 hostile message getter 零读取并只输出固定错误", async () => {
  const source = fs.readFileSync(path.join(ROOT, "app", "bootstrap.js"), "utf8");
  let getterCalls = 0;
  const logged = [];
  const exits = [];
  const calls = [];
  const diagnosticPaths = Object.freeze({ stateDir: "/fixture/bootstrap-private-state" });
  const hostile = {};
  Object.defineProperty(hostile, "message", {
    get() {
      getterCalls += 1;
      return "fixture-secret-canary";
    },
  });
  await vm.runInNewContext(source, {
    console: { error: (...values) => { logged.push(values.map(String).join(" ")); } },
    module: { exports: {} },
    exports: {},
    Promise,
    process: { exit: (code) => { exits.push(code); } },
    require(specifier) {
      if (specifier === "./background-role-activation") return {
        prepareBackgroundRoleActivation() { calls.push("activation"); },
      };
      if (specifier === "./bootstrap-role") return {
        main: () => { calls.push("main"); return Promise.reject(hostile); },
        resolveTestRolePaths: () => { calls.push("paths"); return diagnosticPaths; },
        bootstrapFailureCode: (error) => {
          assert.equal(error, hostile);
          calls.push("failure-code");
          return "BOOTSTRAP_FAILED";
        },
      };
      if (specifier === "./bootstrap-diagnostics") return {
        recordBootstrapFailure(error, options) {
          assert.equal(error, hostile);
          assert.equal(options.paths, diagnosticPaths);
          calls.push("diagnostic");
        },
      };
      if (specifier === "electron") return { app: { exit: (code) => { exits.push(code); } } };
      throw new Error(`unexpected require: ${specifier}`);
    },
  }, { filename: "bootstrap.js" });
  assert.deepEqual(calls, ["activation", "main", "paths", "diagnostic", "failure-code"]);
  assert.equal(getterCalls, 0);
  assert.equal(logged.some((line) => line.includes("fixture-secret-canary")), false);
  assert.deepEqual(logged, ["[bootstrap] startup failure: BOOTSTRAP_FAILED"]);
  assert.deepEqual(exits, [1]);
});

test("RED UI renderer crash 有单次有界恢复监听", () => {
  const source = fs.readFileSync(path.join(ROOT, "app", "ui-entry.js"), "utf8");
  assert.match(source, /webContents\.on\(["']render-process-gone["']/u);
  assert.match(source, /try\s*\{\s*const loading = windowForRecovery\.loadURL\(serverOrigin\)/u);
  assert.match(source, /Promise\.resolve\(loading\)\.catch/u);
});

test("窗口 closed 回调不再读取已销毁 BrowserWindow 的 webContents", () => {
  const source = fs.readFileSync(path.join(ROOT, "app", "ui-entry.js"), "utf8");
  assert.match(source, /const windowWebContentsId = windowForRecovery\.webContents\.id;/u);
  const closedStart = source.indexOf('mainWindow.on("closed"');
  const closedEnd = source.indexOf("\n  });", closedStart);
  assert.notEqual(closedStart, -1);
  assert.notEqual(closedEnd, -1);
  const closedHandler = source.slice(closedStart, closedEnd);
  assert.match(closedHandler, /revokeOwner\(windowWebContentsId\)/u);
  assert.doesNotMatch(closedHandler, /windowForRecovery\.webContents/u);
});

test("应用退出期间 renderer 消失不再显示崩溃弹窗", async () => {
  const source = fs.readFileSync(path.join(ROOT, "app", "ui-entry.js"), "utf8");
  assert.match(source, /let appIsQuitting = false;/u);
  const quitMarker = 'app.on("before-quit", async () => {';
  const quitStart = source.indexOf(quitMarker);
  assert.notEqual(quitStart, -1);
  assert.equal(source.indexOf(quitMarker, quitStart + quitMarker.length), -1);
  const firstCleanup = source.indexOf("groupSendJournalIpc.dispose();", quitStart);
  assert.ok(firstCleanup > quitStart);
  const quitPrelude = source.slice(quitStart, firstCleanup);
  assert.match(quitPrelude, /appIsQuitting = true;/u);
  assert.doesNotMatch(quitPrelude, /\bawait\b/u, "退出标记必须在首次 await 前同步更新");
  for (const scenario of [
    { name: "OpenClaw gate pending", openclaw: true, hermes: false, complete: false, quitting: false },
    { name: "Hermes gate pending", openclaw: false, hermes: true, complete: false, quitting: false },
    { name: "both managed gates complete", openclaw: true, hermes: true, complete: true, quitting: true },
    { name: "unmanaged hosts", openclaw: false, hermes: false, complete: false, quitting: true },
    { name: "absent hosts", openclaw: null, hermes: null, complete: false, quitting: true },
  ]) {
    let handler;
    const host = (managed) => managed === null ? null : { isManaged: () => managed };
    const context = {
      app: { on(name, callback) { assert.equal(name, "before-quit"); handler = callback; } },
      managedOpenClawProductHost: host(scenario.openclaw),
      managedHermesProductHost: host(scenario.hermes),
      managedQuitGate: { complete: () => scenario.complete },
      appIsQuitting: false,
      cleanupCalls: 0,
    };
    // Execute the real handler prefix; stop before the first product cleanup.
    vm.runInNewContext(`${quitPrelude}cleanupCalls += 1;\n});`, context);
    assert.equal(typeof handler, "function");
    const completion = handler();
    assert.equal(context.appIsQuitting, scenario.quitting, scenario.name);
    assert.equal(context.cleanupCalls, Number(scenario.quitting), scenario.name);
    await completion;
  }
  const goneStart = source.indexOf('webContents.on("render-process-gone"');
  const goneEnd = source.indexOf("\n  });", goneStart);
  assert.notEqual(goneStart, -1);
  assert.notEqual(goneEnd, -1);
  assert.match(source.slice(goneStart, goneEnd), /if \(appIsQuitting\) return;/u);
  const recoveryStart = source.indexOf("const closeAfterRendererFailure = () => {");
  const recoveryEnd = source.indexOf("\n  };", recoveryStart);
  assert.notEqual(recoveryStart, -1);
  assert.notEqual(recoveryEnd, -1);
  const recoverySource = source.slice(recoveryStart, recoveryEnd + "\n  };".length);
  assert.match(recoverySource, /if \(appIsQuitting\)/u);
  for (const quitting of [false, true]) {
    let closes = 0;
    let dialogs = 0;
    const window = { isDestroyed: () => false, close: () => { closes += 1; } };
    vm.runInNewContext(`${recoverySource}\ncloseAfterRendererFailure();`, {
      mainWindow: window,
      windowForRecovery: window,
      appIsQuitting: quitting,
      dialog: { showErrorBox: () => { dialogs += 1; } },
    });
    assert.equal(closes, 1);
    assert.equal(dialogs, quitting ? 0 : 1);
  }
});

test("RED UI 不把 renderer console message/source 原样写入主进程日志", () => {
  const source = fs.readFileSync(path.join(ROOT, "app", "ui-entry.js"), "utf8");
  assert.doesNotMatch(source, /console\.log\(`\[Renderer\] \$\{message\} \(\$\{sourceId\}/u);
});

test("UI host 边界日志不转发依赖错误、路径或 dev URL 原文", () => {
  const source = fs.readFileSync(path.join(ROOT, "app", "ui-entry.js"), "utf8");
  for (const unsafe of [
    /console\.error\([^\n;]*e\?\.message\s*\|\|\s*e/u,
    /console\.error\([^\n;]*err\?\.code\s*\|\|\s*err/u,
    /console\.error\([^\n;]*,\s*error\s*\)/u,
    /console\.warn\([^\n;]*e\?\.message\s*\|\|\s*e/u,
    /console\.log\(`\[Dev\][^`]*\$\{serverOrigin\}/u,
  ]) assert.doesNotMatch(source, unsafe);
});

test("旧版与未来版 snapshot 拒绝且原 snapshot/event log 不变", () => {
  for (const schemaVersion of [1, 2, 3, 4, STORE_SCHEMA_VERSION - 1, STORE_SCHEMA_VERSION + 1]) {
    const paths = fixturePaths(`shoggoth-phase12-reject-v${schemaVersion}-`);
    const initial = new JsonlProductStore({ paths, now: () => 100 });
    initial.open();
    initial.close();
    const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
    snapshot.schemaVersion = schemaVersion;
    snapshot.checksum = snapshotChecksum(snapshot);
    const unsupportedBytes = `${JSON.stringify(snapshot)}\n`;
    fs.writeFileSync(paths.stateSnapshotPath, unsupportedBytes, { mode: 0o600 });
    const eventBytes = fs.readFileSync(paths.eventLogPath);
    const names = fs.readdirSync(paths.stateDir).sort();
    const writeOpens = [];
    const guardedFs = Object.create(fs);
    guardedFs.openSync = (target, flags, ...args) => {
      if (typeof flags !== "number" || (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR
        | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0) {
        writeOpens.push(target);
      }
      return fs.openSync(target, flags, ...args);
    };
    const rejected = new JsonlProductStore({ paths, fs: guardedFs, now: () => 101 });
    assert.throws(() => rejected.open(), (error) => error.code === "STORE_SCHEMA_UNSUPPORTED");
    rejected.close();
    assert.deepEqual(writeOpens, []);
    assert.equal(fs.readFileSync(paths.stateSnapshotPath, "utf8"), unsupportedBytes);
    assert.deepEqual(fs.readFileSync(paths.eventLogPath), eventBytes);
    assert.deepEqual(fs.readdirSync(paths.stateDir).sort(), names);
    assert.equal(names.some((name) => name.endsWith(".tmp")), false);
  }
});

test("当前 snapshot close rename fault 保留原文件和已提交日志，可重开恢复", () => {
  const paths = fixturePaths("shoggoth-phase12-current-close-fault-");
  const initial = new JsonlProductStore({ paths, now: () => 100 });
  initial.open();
  initial.close();
  const originalSnapshot = fs.readFileSync(paths.stateSnapshotPath);
  assert.equal(JSON.parse(originalSnapshot).schemaVersion, STORE_SCHEMA_VERSION);
  let renameFaults = 0;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (source, target) => {
    if (target === paths.stateSnapshotPath && source.endsWith(".tmp")) {
      renameFaults += 1;
      throw Object.assign(new Error("fixture snapshot rename fault"), { code: "EIO" });
    }
    return fs.renameSync(source, target);
  };
  const failing = new JsonlProductStore({ paths, fs: faultFs, now: () => 101 });
  failing.open();
  const updatedName = "Phase12 committed-before-close fixture";
  failing.putAgentProfile({ ...defaultAgentProfile(101), name: updatedName });
  const committedEvents = fs.readFileSync(paths.eventLogPath);
  assert.ok(committedEvents.length > 0);
  assert.equal(committedEvents.includes(Buffer.from(updatedName)), true);
  assert.throws(() => failing.close(), (error) => error.code === "EIO");
  assert.equal(renameFaults, 1);
  assert.deepEqual(fs.readFileSync(paths.stateSnapshotPath), originalSnapshot);
  assert.deepEqual(fs.readFileSync(paths.eventLogPath), committedEvents);
  assert.equal(fs.readdirSync(paths.stateDir).some((name) => name.endsWith(".tmp")), false);

  const recovered = new JsonlProductStore({ paths, now: () => 102 });
  recovered.open();
  assert.equal(recovered.getAgentProfile(DEFAULT_AGENT_PROFILE_ID).name, updatedName);
  recovered.close();
  const persisted = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.equal(persisted.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(persisted.checksum, snapshotChecksum(persisted));
  assert.equal(fs.readdirSync(paths.stateDir).some((name) => name.endsWith(".tmp")), false);
  const reopened = new JsonlProductStore({ paths, now: () => 103 });
  reopened.open();
  assert.equal(reopened.getAgentProfile(DEFAULT_AGENT_PROFILE_ID).name, updatedName);
  reopened.close();
});

(async () => {
  const pattern = process.env.PHASE12_TEST_PATTERN
    ? new RegExp(process.env.PHASE12_TEST_PATTERN, "u") : null;
  const selectedTests = pattern ? tests.filter(({ name }) => pattern.test(name)) : tests;
  let failed = 0;
  for (const { name, fn } of selectedTests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(error?.stack || error);
    }
  }
  if (failed > 0) {
    console.error(`RED shoggoth Phase12 recovery/security unit (${selectedTests.length - failed}/${selectedTests.length}, ${failed} gaps)`);
    process.exitCode = 1;
  } else {
    console.log(`PASS shoggoth Phase12 recovery/security unit (${selectedTests.length})`);
  }
})();
