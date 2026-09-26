#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const { createEventBuffer } = require(path.join(ROOT, "app", "agent-service", "event-buffer.js"));
const {
  DEFAULT_AGENT_PROFILE_ID,
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

function snapshotBody(snapshot) {
  if (Object.prototype.hasOwnProperty.call(snapshot, "mcpToolCalls")) {
    return {
      schemaVersion: snapshot.schemaVersion,
      lastSeq: snapshot.lastSeq,
      modelProviders: snapshot.modelProviders,
      agentProfiles: snapshot.agentProfiles,
      workRuns: snapshot.workRuns,
      runNotes: snapshot.runNotes,
      mcpToolCalls: snapshot.mcpToolCalls,
    };
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "runNotes")) {
    return {
      schemaVersion: snapshot.schemaVersion,
      lastSeq: snapshot.lastSeq,
      modelProviders: snapshot.modelProviders,
      agentProfiles: snapshot.agentProfiles,
      workRuns: snapshot.workRuns,
      runNotes: snapshot.runNotes,
    };
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "modelProviders")) {
    return {
      schemaVersion: snapshot.schemaVersion,
      lastSeq: snapshot.lastSeq,
      modelProviders: snapshot.modelProviders,
      agentProfiles: snapshot.agentProfiles,
      workRuns: snapshot.workRuns,
    };
  }
  return {
    schemaVersion: snapshot.schemaVersion,
    lastSeq: snapshot.lastSeq,
    agentProfiles: snapshot.agentProfiles,
    workRuns: snapshot.workRuns,
  };
}

function encodeSnapshot(snapshot) {
  const candidate = { ...snapshot };
  candidate.checksum = crypto.createHash("sha256")
    .update(JSON.stringify(snapshotBody(candidate))).digest("hex");
  return `${JSON.stringify(candidate)}\n`;
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
    await waitFor(() => !fs.existsSync(paths.socketPath) && logged.length === 1);
  } finally {
    console.error = originalConsoleError;
    await service.stop({ notify: false }).catch(() => {});
  }
  assert.equal(getterCalls, 0);
  assert.equal(logged.some((line) => line.includes("fixture-secret-canary")), false);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /SERVER_ERROR/u);
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
  const hostile = {};
  Object.defineProperty(hostile, "message", {
    get() {
      getterCalls += 1;
      return "fixture-secret-canary";
    },
  });
  vm.runInNewContext(source, {
    console: { error: (...values) => { logged.push(values.map(String).join(" ")); } },
    module: { exports: {} },
    exports: {},
    Promise,
    process: { exit: (code) => { exits.push(code); } },
    require(specifier) {
      if (specifier === "./bootstrap-role") return {
        main: () => Promise.reject(hostile),
        bootstrapFailureCode: () => "BOOTSTRAP_FAILED",
      };
      if (specifier === "electron") return { app: { exit: (code) => { exits.push(code); } } };
      throw new Error(`unexpected require: ${specifier}`);
    },
  }, { filename: "bootstrap.js" });
  await new Promise((resolve) => setImmediate(resolve));
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

test("应用退出期间 renderer 消失不再显示崩溃弹窗", () => {
  const source = fs.readFileSync(path.join(ROOT, "app", "ui-entry.js"), "utf8");
  assert.match(source, /let appIsQuitting = false;/u);
  assert.match(source, /app\.on\("before-quit", async \(\) => \{\s*appIsQuitting = true;/u);
  const goneStart = source.indexOf('webContents.on("render-process-gone"');
  const goneEnd = source.indexOf("\n  });", goneStart);
  assert.notEqual(goneStart, -1);
  assert.notEqual(goneEnd, -1);
  assert.match(source.slice(goneStart, goneEnd), /if \(appIsQuitting\) return;/u);
  const recoveryStart = source.indexOf("const closeAfterRendererFailure = () => {");
  const recoveryEnd = source.indexOf("\n  };", recoveryStart);
  assert.notEqual(recoveryStart, -1);
  assert.notEqual(recoveryEnd, -1);
  assert.match(source.slice(recoveryStart, recoveryEnd), /if \(appIsQuitting\)/u);
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

test("旧版 snapshot close fault 保留原文件，可重开并迁移到当前 schema", () => {
  for (const schemaVersion of [1, 2, 3, 4]) {
    const paths = fixturePaths(`shoggoth-phase12-migrate-v${schemaVersion}-`);
    const initial = new JsonlProductStore({ paths, now: () => 100 });
    initial.open();
    initial.close();
    const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
    snapshot.schemaVersion = schemaVersion;
    delete snapshot.runtimeAccounts;
    delete snapshot.runtimeAccountTombstones;
    for (const profile of snapshot.agentProfiles) delete profile.runtimeAccountId;
    if (schemaVersion === 1) snapshot.modelProviders = undefined;
    if (schemaVersion < 3) {
      snapshot.runNotes = undefined;
      snapshot.mcpToolCalls = undefined;
    }
    const legacyBytes = encodeSnapshot(snapshot);
    fs.writeFileSync(paths.stateSnapshotPath, legacyBytes, { mode: 0o600 });

    const faultFs = Object.create(fs);
    faultFs.renameSync = (source, target) => {
      if (target === paths.stateSnapshotPath && source.endsWith(".tmp")) {
        throw Object.assign(new Error("fixture migration rename fault"), { code: "EIO" });
      }
      return fs.renameSync(source, target);
    };
    const failing = new JsonlProductStore({ paths, fs: faultFs, now: () => 101 });
    failing.open();
    assert.throws(() => failing.close(), (error) => error.code === "EIO");
    assert.equal(fs.readFileSync(paths.stateSnapshotPath, "utf8"), legacyBytes);
    assert.equal(fs.readdirSync(paths.stateDir).some((name) => name.endsWith(".tmp")), false);

    const recovered = new JsonlProductStore({ paths, now: () => 102 });
    recovered.open();
    assert.equal(recovered.getAgentProfile(DEFAULT_AGENT_PROFILE_ID).id, DEFAULT_AGENT_PROFILE_ID);
    recovered.close();
    assert.equal(
      JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8")).schemaVersion,
      STORE_SCHEMA_VERSION,
    );
  }
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
