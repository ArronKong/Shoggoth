#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { atomicWritePrivateFile } = require(path.join(ROOT, "app", "agent-service", "private-file.js"));

let AccountAuthStateStore;
let moduleLoadError = null;
try {
  ({ AccountAuthStateStore } = require(path.join(
    ROOT, "app", "agent-service", "account-auth-state-store.js",
  )));
} catch (error) {
  moduleLoadError = error;
}
let AccountAuthManager;
let stableAccountRead;
let managerLoadError = null;
try {
  ({ AccountAuthManager, stableAccountRead } = require(path.join(
    ROOT, "app", "agent-service", "account-auth-manager.js",
  )));
} catch (error) {
  managerLoadError = error;
}

const tests = [];
const fixtureRoots = new Set();
const pendingFixtureRoots = new Set();
function test(name, fn) { tests.push({ name, fn }); }

function fixturePaths(prefix = "shoggoth-account-auth-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureRoots.add(root);
  pendingFixtureRoots.add(root);
  return resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
}

test("AccountAuthStateStore 模块与固定非敏感状态路径可用", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof AccountAuthStateStore, "function");
  const paths = fixturePaths();
  assert.equal(paths.accountAuthStatePath, path.join(paths.stateDir, "account-auth-state.json"));
  assert.equal(paths.accountAuthStateV2Path, path.join(paths.stateDir, "account-auth-state-v2.json"));
});

function waitingSession(runtimeAccountId = "runtime-auth") {
  return {
    requestId: "request-auth-1",
    runtimeAccountId,
    mode: "browser",
    status: "waiting",
    createdAt: 100,
    updatedAt: 101,
    errorCode: null,
  };
}

test("状态容器仅保存严格非敏感摘要并以 0600 原子跨重启恢复", async () => {
  const paths = fixturePaths();
  const first = new AccountAuthStateStore({ paths });
  first.open();
  assert.deepEqual(first.put(waitingSession()), waitingSession());
  assert.equal(fs.statSync(paths.accountAuthStateV2Path).mode & 0o777, 0o600);
  const serialized = fs.readFileSync(paths.accountAuthStateV2Path, "utf8");
  for (const forbidden of ["loginId", "authUrl", "verificationUrl", "userCode", "email", "token", "apiKey"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  const canary = "account-state-secret-canary";
  assert.throws(
    () => first.put({ ...waitingSession(), authUrl: `https://example.test/${canary}` }),
    (error) => error.code === "AUTH_STATE_INVALID"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
  );
  assert.equal(fs.readFileSync(paths.accountAuthStateV2Path, "utf8").includes(canary), false);

  const restarted = new AccountAuthStateStore({ paths, now: () => 102 });
  restarted.open();
  assert.deepEqual(restarted.get("runtime-auth"), {
    ...waitingSession(),
    status: "interrupted",
    updatedAt: 102,
    errorCode: "SERVICE_RESTARTED",
  });
  const afterRecovery = fs.readFileSync(paths.accountAuthStateV2Path, "utf8");
  const third = new AccountAuthStateStore({ paths });
  third.open();
  assert.deepEqual(third.get("runtime-auth"), restarted.get("runtime-auth"));
  assert.equal(fs.readFileSync(paths.accountAuthStateV2Path, "utf8"), afterRecovery);
  await third.close();
});

test("v1 Profile 状态只读保留并确定性合并为 v2 Account 状态", async () => {
  const paths = fixturePaths("shoggoth-account-v1-migration-");
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const legacy = {
    version: 1,
    revision: 7,
    sessions: {
      "profile-newer": {
        requestId: "request-newer",
        runtimeProfileId: "profile-newer",
        mode: "deviceCode",
        status: "waiting",
        createdAt: 200,
        updatedAt: 300,
        errorCode: null,
      },
      "profile-older": {
        requestId: "request-older",
        runtimeProfileId: "profile-older",
        mode: "browser",
        status: "succeeded",
        createdAt: 100,
        updatedAt: 150,
        errorCode: null,
      },
      "profile-separate": {
        requestId: "request-separate",
        runtimeProfileId: "profile-separate",
        mode: "browser",
        status: "failed",
        createdAt: 120,
        updatedAt: 160,
        errorCode: "LOGIN_START_FAILED",
      },
    },
  };
  const legacyBytes = `${JSON.stringify(legacy)}\n`;
  fs.writeFileSync(paths.accountAuthStatePath, legacyBytes, { mode: 0o600 });

  const store = new AccountAuthStateStore({
    paths,
    now: () => 350,
    resolveRuntimeAccountId(runtimeProfileId) {
      return runtimeProfileId === "profile-separate" ? "account-separate" : "account-shared";
    },
  });
  store.open();
  assert.deepEqual(store.list(), [{
    requestId: "request-separate",
    runtimeAccountId: "account-separate",
    mode: "browser",
    status: "failed",
    createdAt: 120,
    updatedAt: 160,
    errorCode: "LOGIN_START_FAILED",
  }, {
    requestId: "request-newer",
    runtimeAccountId: "account-shared",
    mode: "deviceCode",
    status: "interrupted",
    createdAt: 200,
    updatedAt: 350,
    errorCode: "SERVICE_RESTARTED",
  }]);
  assert.equal(fs.readFileSync(paths.accountAuthStatePath, "utf8"), legacyBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.accountAuthStateV2Path, "utf8")), {
    version: 2,
    revision: 8,
    sessions: Object.fromEntries(store.list().map((session) => [session.runtimeAccountId, session])),
  });
  await store.close();

  const reopened = new AccountAuthStateStore({ paths });
  reopened.open();
  assert.equal(reopened.get("account-shared").status, "interrupted");
  assert.equal(fs.readFileSync(paths.accountAuthStatePath, "utf8"), legacyBytes);
  await reopened.close();
});

test("v1 存在但缺少 Profile→Account resolver 时 fail closed 且不创建 v2", () => {
  const paths = fixturePaths("shoggoth-account-v1-no-resolver-");
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.accountAuthStatePath, `${JSON.stringify({
    version: 1,
    revision: 1,
    sessions: {
      "profile-only": {
        requestId: "request-only",
        runtimeProfileId: "profile-only",
        mode: "browser",
        status: "succeeded",
        createdAt: 1,
        updatedAt: 2,
        errorCode: null,
      },
    },
  })}\n`, { mode: 0o600 });
  assert.throws(
    () => new AccountAuthStateStore({ paths }).open(),
    (error) => error.code === "AUTH_STATE_MIGRATION_RESOLVER_REQUIRED",
  );
  assert.equal(fs.existsSync(paths.accountAuthStateV2Path), false);
});

test("状态文件损坏、symlink 与 hardlink 均 fail closed 并保留证据", () => {
  const corruptPaths = fixturePaths("shoggoth-account-corrupt-");
  fs.mkdirSync(corruptPaths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(corruptPaths.accountAuthStateV2Path, "{broken\n", { mode: 0o600 });
  assert.throws(
    () => new AccountAuthStateStore({ paths: corruptPaths }).open(),
    (error) => error.code === "AUTH_STATE_CORRUPT",
  );
  assert.equal(fs.readFileSync(corruptPaths.accountAuthStateV2Path, "utf8"), "{broken\n");

  for (const kind of ["symlink", "hardlink"]) {
    const paths = fixturePaths(`shoggoth-account-${kind}-`);
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    const victim = path.join(path.dirname(paths.stateDir), `victim-${kind}`);
    fs.writeFileSync(victim, "account-state-victim", { mode: 0o600 });
    if (kind === "symlink") fs.symlinkSync(victim, paths.accountAuthStateV2Path);
    else fs.linkSync(victim, paths.accountAuthStateV2Path);
    assert.throws(
      () => new AccountAuthStateStore({ paths }).open(),
      (error) => ["UNSAFE_SYMLINK", "UNSAFE_HARDLINK"].includes(error.code),
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "account-state-victim");
  }
});

test("close 持久化 active→interrupted 若提交不确定则 poison 当前 Store", async () => {
  const paths = fixturePaths("shoggoth-account-close-uncertain-");
  let writes = 0;
  const store = new AccountAuthStateStore({
    paths,
    atomicWrite(target, value, options) {
      writes += 1;
      if (writes === 2) {
        const error = new Error("injected committed uncertain");
        error.code = "PRIVATE_FILE_COMMIT_UNCERTAIN";
        error.committedUncertain = true;
        throw error;
      }
      return atomicWritePrivateFile(target, value, options);
    },
  });
  store.open();
  store.put(waitingSession("runtime-close"));
  await assert.rejects(
    store.close(),
    (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN",
  );
  for (const action of [
    () => store.get("runtime-close"),
    () => store.list(),
    () => store.put(waitingSession("runtime-after-poison")),
  ]) assert.throws(action, (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN");
});

test("AccountAuthManager 模块可用", () => {
  assert.ifError(managerLoadError);
  assert.equal(typeof AccountAuthManager, "function");
});

test("Bedrock account 摘要统一使用 usesCodexManagedCredentials boolean", () => {
  assert.deepEqual(stableAccountRead({
    account: { type: "amazonBedrock", usesCodexManagedCredentials: true },
    requiresOpenaiAuth: false,
  }), {
    account: { type: "amazonBedrock", usesCodexManagedCredentials: true },
    requiresOpenaiAuth: false,
  });
});

class FakeAuthHost {
  constructor(options = {}) {
    this.calls = [];
    this.listeners = new Set();
    this.authListeners = new Set();
    this.authSubscriberErrors = [];
    this.loginCounter = 0;
    this.accountResponse = options.accountResponse || {
      account: {
        type: "chatgpt",
        email: "private@example.test",
        name: "Private Person",
        token: "account-token-canary",
        planType: "plus",
      },
      requiresOpenaiAuth: true,
    };
    this.startHook = options.startHook || null;
    this.cancelHook = options.cancelHook || null;
    this.loginIds = options.loginIds || null;
    this.readHook = options.readHook || null;
    this.terminated = new Promise((resolve, reject) => {
      this.resolveTerminated = resolve;
      this.rejectTerminated = reject;
    });
    this.terminated.catch(() => {});
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  subscribeAccountAuth(listener) {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  emitAuth(event) {
    for (const listener of this.authListeners) {
      try { listener(event); } catch (error) { this.authSubscriberErrors.push(error); }
    }
  }

  async accountRead(params) {
    this.calls.push(["read", params]);
    if (this.readHook) return this.readHook(this, params);
    return this.accountResponse;
  }

  async accountLoginStart(params) {
    this.calls.push(["start", params]);
    this.loginCounter += 1;
    const loginId = this.loginIds?.[this.loginCounter - 1] || `login-${this.loginCounter}`;
    await this.startHook?.(this, loginId);
    if (params.type === "chatgpt") {
      return { type: "chatgpt", loginId, authUrl: "https://auth.example.test/login" };
    }
    return {
      type: "chatgptDeviceCode",
      loginId,
      verificationUrl: "https://auth.example.test/device",
      userCode: "ABCD-EFGH",
    };
  }

  async accountLoginCancel(params) {
    this.calls.push(["cancel", params]);
    await this.cancelHook?.(this, params);
    return { status: "canceled" };
  }

  async accountLogout() {
    this.calls.push(["logout"]);
    return {};
  }
}

class FakeRuntimePool {
  constructor(host) {
    this.host = host;
    this.getCalls = [];
    this.stopCalls = [];
  }

  async get(runtimeProfileId) {
    this.getCalls.push(runtimeProfileId);
    if (this.getHook) return this.getHook(runtimeProfileId);
    return this.host;
  }

  async stop(runtimeProfileId) {
    this.stopCalls.push(runtimeProfileId);
    await this.stopHook?.(runtimeProfileId);
  }
}

class FakeRuntimeAccountAdmission {
  constructor() {
    this.calls = [];
    this.mutation = null;
  }

  beginMutation(input) {
    assert.equal(this.mutation, null);
    this.mutation = structuredClone(input);
    this.calls.push(["begin", structuredClone(input)]);
    return structuredClone(input);
  }

  finishMutation(input) {
    assert.deepEqual(input, this.mutation);
    this.calls.push(["finish", structuredClone(input)]);
    this.mutation = null;
  }

  cancelMutation(input) {
    this.calls.push(["cancel", structuredClone(input)]);
    if (this.mutation?.operationId === input.operationId) this.mutation = null;
  }
}

test("Manager 核心按 Account key 且两个 Profile facade 共享同一登录状态", async () => {
  const paths = fixturePaths("shoggoth-account-manager-shared-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 900 });
  stateStore.open();
  const host = new FakeAuthHost();
  const pool = new FakeRuntimePool(host);
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: pool,
    now: () => 900,
    randomUUID: () => "request-shared",
    resolveRuntimeAccountBinding(runtimeAccountId) {
      return { runtime: "codex", runtimeProfileId: "profile-canonical", runtimeAccountId };
    },
    resolveProfileAuthBinding(runtimeProfileId) {
      return { runtime: "codex", runtimeProfileId, runtimeAccountId: "account-shared" };
    },
  });
  manager.open();

  await manager.loginStartForProfile({ runtimeProfileId: "profile-a", mode: "browser" });
  await assert.rejects(
    manager.loginStartForProfile({ runtimeProfileId: "profile-b", mode: "browser" }),
    (error) => error.code === "AUTH_LOGIN_IN_PROGRESS",
  );
  assert.deepEqual((await manager.readForProfile({ runtimeProfileId: "profile-b" })).login, {
    requestId: "request-shared",
    mode: "browser",
    status: "waiting",
    updatedAt: 900,
    errorCode: null,
  });
  assert.deepEqual((await manager.read({ runtimeAccountId: "account-shared" })).login,
    (await manager.readForProfile({ runtimeProfileId: "profile-a" })).login);
  assert.deepEqual(await manager.loginCancelForProfile({
    runtimeProfileId: "profile-b",
    requestId: "request-shared",
  }), { requestId: "request-shared", status: "canceled" });
  assert.deepEqual(pool.stopCalls, ["profile-canonical"]);
  assert.deepEqual(stateStore.list(), [{
    requestId: "request-shared",
    runtimeAccountId: "account-shared",
    mode: "browser",
    status: "canceled",
    createdAt: 900,
    updatedAt: 900,
    errorCode: null,
  }]);
  const serialized = fs.readFileSync(paths.accountAuthStateV2Path, "utf8");
  assert.equal(serialized.includes("profile-a"), false);
  assert.equal(serialized.includes("profile-b"), false);
  await manager.close();
  await stateStore.close();
});

test("Manager 启动浏览器/设备码登录并只返回与持久化稳定非 PII 摘要", async () => {
  assert.ifError(managerLoadError);
  const paths = fixturePaths("shoggoth-account-manager-start-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 1_000 });
  stateStore.open();
  const host = new FakeAuthHost();
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 1_000,
    randomUUID: (() => {
      const ids = ["request-browser", "request-device"];
      return () => ids.shift();
    })(),
    loginTimeoutMs: 60_000,
  });
  manager.open();

  const browser = await manager.loginStart({ runtimeProfileId: "runtime-browser", mode: "browser" });
  assert.deepEqual(browser, {
    requestId: "request-browser",
    mode: "browser",
    status: "waiting",
    loginId: "login-1",
    authUrl: "https://auth.example.test/login",
  });
  const device = await manager.loginStart({ runtimeProfileId: "runtime-device", mode: "deviceCode" });
  assert.deepEqual(device, {
    requestId: "request-device",
    mode: "deviceCode",
    status: "waiting",
    loginId: "login-2",
    verificationUrl: "https://auth.example.test/device",
    userCode: "ABCD-EFGH",
  });
  assert.deepEqual(await manager.read({ runtimeProfileId: "runtime-browser" }), {
    account: { type: "chatgpt", planType: "plus" },
    requiresOpenaiAuth: true,
    login: {
      requestId: "request-browser",
      mode: "browser",
      status: "waiting",
      updatedAt: 1_000,
      errorCode: null,
    },
  });

  const serialized = fs.readFileSync(paths.accountAuthStateV2Path, "utf8");
  for (const forbidden of [
    "login-1", "login-2", "auth.example.test", "ABCD-EFGH",
    "private@example.test", "Private Person", "account-token-canary",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  await manager.close();
  await stateStore.close();
});

test("Manager 关联提前/乱序完成通知且 terminal 状态对重复晚到通知保持 sticky", async () => {
  const paths = fixturePaths("shoggoth-account-manager-order-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 2_000 });
  stateStore.open();
  const host = new FakeAuthHost({
    startHook(currentHost, loginId) {
      currentHost.emitAuth({
        type: "account_login",
        method: "account/login/completed",
        loginId: "unrelated-login",
        status: "failed",
        errorCode: "UNRELATED",
      });
      currentHost.emitAuth({
        type: "account_login",
        method: "account/login/completed",
        loginId,
        status: "succeeded",
      });
    },
  });
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 2_000,
    randomUUID: () => "request-ordered",
  });
  manager.open();
  const result = await manager.loginStart({ runtimeProfileId: "runtime-ordered", mode: "browser" });
  assert.equal(result.status, "succeeded");
  assert.equal(stateStore.get("runtime-ordered").status, "succeeded");
  const terminalFile = fs.readFileSync(paths.accountAuthStateV2Path, "utf8");

  host.emitAuth({
    type: "account_login",
    method: "account/login/completed",
    loginId: "login-1",
    status: "failed",
    errorCode: "LATE_FAILURE",
  });
  host.emitAuth({
    type: "account_login",
    method: "account/login/completed",
    loginId: "unrelated-login",
    status: "succeeded",
  });
  assert.equal(stateStore.get("runtime-ordered").status, "succeeded");
  assert.equal(fs.readFileSync(paths.accountAuthStateV2Path, "utf8"), terminalFile);
  await manager.close();
  await stateStore.close();
});

test("Manager cancel 幂等且 timeout 只调用生成 schema 中的原生 cancel", async () => {
  const cancelPaths = fixturePaths("shoggoth-account-manager-cancel-");
  const cancelStore = new AccountAuthStateStore({ paths: cancelPaths, now: () => 3_000 });
  cancelStore.open();
  const cancelHost = new FakeAuthHost();
  const cancelPool = new FakeRuntimePool(cancelHost);
  const cancelManager = new AccountAuthManager({
    stateStore: cancelStore,
    runtimePool: cancelPool,
    now: () => 3_000,
    randomUUID: () => "request-cancel",
  });
  cancelManager.open();
  await cancelManager.loginStart({ runtimeProfileId: "runtime-cancel", mode: "deviceCode" });
  const cancelInput = { runtimeProfileId: "runtime-cancel", requestId: "request-cancel" };
  assert.deepEqual(await cancelManager.loginCancel(cancelInput), {
    requestId: "request-cancel",
    status: "canceled",
  });
  assert.deepEqual(await cancelManager.loginCancel(cancelInput), {
    requestId: "request-cancel",
    status: "canceled",
  });
  assert.equal(cancelHost.calls.filter(([method]) => method === "cancel").length, 1);
  assert.deepEqual(cancelPool.stopCalls, ["runtime-cancel"]);
  assert.equal(cancelHost.listeners.size, 0);
  assert.equal(cancelHost.authListeners.size, 0);
  assert.equal(cancelManager.bindings.size, 0);
  await cancelManager.close();
  await cancelStore.close();

  const timeoutPaths = fixturePaths("shoggoth-account-manager-timeout-");
  const timeoutStore = new AccountAuthStateStore({ paths: timeoutPaths, now: () => 4_000 });
  timeoutStore.open();
  const timeoutHost = new FakeAuthHost();
  const timeoutPool = new FakeRuntimePool(timeoutHost);
  let timeoutCallback;
  const timeoutManager = new AccountAuthManager({
    stateStore: timeoutStore,
    runtimePool: timeoutPool,
    now: () => 4_000,
    randomUUID: () => "request-timeout",
    setTimeout(callback) {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeout() {},
  });
  timeoutManager.open();
  await timeoutManager.loginStart({ runtimeProfileId: "runtime-timeout", mode: "browser" });
  timeoutCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timeoutStore.get("runtime-timeout"), {
    requestId: "request-timeout",
    runtimeAccountId: "runtime-timeout",
    mode: "browser",
    status: "timed_out",
    createdAt: 4_000,
    updatedAt: 4_000,
    errorCode: "LOGIN_TIMEOUT",
  });
  assert.equal(timeoutHost.calls.filter(([method]) => method === "cancel").length, 1);
  assert.deepEqual(timeoutPool.stopCalls, ["runtime-timeout"]);
  assert.equal(timeoutHost.listeners.size, 0);
  assert.equal(timeoutHost.authListeners.size, 0);
  assert.equal(timeoutManager.bindings.size, 0);
  await timeoutManager.close();
  await timeoutStore.close();
});

test("Manager 将 active Host crash 明确持久化为 interrupted", async () => {
  const paths = fixturePaths("shoggoth-account-manager-crash-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 5_000 });
  stateStore.open();
  const host = new FakeAuthHost();
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 5_000,
    randomUUID: () => "request-crash",
  });
  manager.open();
  await manager.loginStart({ runtimeProfileId: "runtime-crash", mode: "browser" });
  const crash = new Error("fake host crashed with private detail");
  host.rejectTerminated(crash);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stateStore.get("runtime-crash").status, "interrupted");
  assert.equal(stateStore.get("runtime-crash").errorCode, "HOST_TERMINATED");
  assert.equal(fs.readFileSync(paths.accountAuthStateV2Path, "utf8").includes(crash.message), false);
  await manager.close();
  await stateStore.close();
});

test("account/updated 只触发重新 read 并发布稳定有界摘要", async () => {
  const paths = fixturePaths("shoggoth-account-manager-update-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 6_000 });
  stateStore.open();
  const host = new FakeAuthHost();
  const events = [];
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 6_000,
    randomUUID: () => "request-update",
    onEvent: (event) => events.push(event),
  });
  manager.open();
  await manager.loginStart({ runtimeProfileId: "runtime-update", mode: "browser" });
  host.emit({
    known: true,
    type: "account_updated",
    method: "account/updated",
    authMode: "chatgpt",
    unknownRaw: "notification-secret-canary",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{
    type: "auth.updated",
    runtimeAccountId: "runtime-update",
    account: { type: "chatgpt", planType: "plus" },
    requiresOpenaiAuth: true,
  }]);
  assert.equal(JSON.stringify(events).includes("private@example.test"), false);
  assert.equal(JSON.stringify(events).includes("notification-secret-canary"), false);
  assert.equal(host.calls.filter(([method]) => method === "read").length, 1);
  await manager.close();
  await stateStore.close();
});

test("登录成功在解绑 Host 后失效 RuntimeAccount，完成前不释放 admission", async () => {
  const paths = fixturePaths("shoggoth-account-manager-login-invalidate-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 6_100 });
  stateStore.open();
  const host = new FakeAuthHost();
  const admission = new FakeRuntimeAccountAdmission();
  let releaseInvalidation;
  const invalidationGate = new Promise((resolve) => { releaseInvalidation = resolve; });
  const invalidations = [];
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    runtimeAccountAdmission: admission,
    now: () => 6_100,
    randomUUID: () => "request-login-invalidate",
    resolveRuntimeAccountBinding(runtimeAccountId) {
      return { runtime: "codex", runtimeProfileId: "profile-canonical", runtimeAccountId };
    },
    async invalidateRuntimeAccount(input) {
      invalidations.push(structuredClone(input));
      assert.equal(host.listeners.size, 0);
      assert.equal(host.authListeners.size, 0);
      host.resolveTerminated();
      await invalidationGate;
    },
  });
  manager.open();
  await manager.loginStart({ runtimeAccountId: "account-login-invalidate", mode: "browser" });
  host.emitAuth({
    type: "account_login",
    method: "account/login/completed",
    loginId: "login-1",
    status: "succeeded",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stateStore.get("account-login-invalidate").status, "succeeded");
  assert.equal(manager.active.size, 0);
  assert.equal(manager.bindings.size, 0);
  assert.notEqual(admission.mutation, null);
  assert.deepEqual(admission.calls.map(([method]) => method), ["begin"]);
  assert.deepEqual(invalidations, [{
    runtimeAccountId: "account-login-invalidate",
    binding: {
      runtime: "codex",
      runtimeProfileId: "profile-canonical",
      runtimeAccountId: "account-login-invalidate",
    },
    reason: "login-succeeded",
  }]);

  releaseInvalidation();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admission.mutation, null);
  assert.deepEqual(admission.calls.map(([method]) => method), ["begin", "finish"]);
  assert.equal(stateStore.get("account-login-invalidate").status, "succeeded");
  await manager.close();
  await stateStore.close();
});

test("登录成功后的 RuntimeAccount 失效失败会 poison 且保留 admission mutation", async () => {
  const paths = fixturePaths("shoggoth-account-manager-login-invalidate-failure-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 6_200 });
  stateStore.open();
  const host = new FakeAuthHost();
  const admission = new FakeRuntimeAccountAdmission();
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    runtimeAccountAdmission: admission,
    now: () => 6_200,
    randomUUID: () => "request-login-invalidate-failure",
    async invalidateRuntimeAccount() {
      throw new Error("private invalidation detail");
    },
  });
  manager.open();
  const terminated = assert.rejects(
    manager.terminated,
    (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN"
      && !error.message.includes("private invalidation detail"),
  );
  await manager.loginStart({
    runtimeProfileId: "runtime-login-invalidate-failure",
    mode: "browser",
  });
  host.emitAuth({
    type: "account_login",
    method: "account/login/completed",
    loginId: "login-1",
    status: "succeeded",
  });
  await terminated;

  assert.equal(stateStore.get("runtime-login-invalidate-failure").status, "succeeded");
  assert.notEqual(admission.mutation, null);
  assert.deepEqual(admission.calls.map(([method]) => method), ["begin"]);
  await assert.rejects(
    manager.read({ runtimeProfileId: "runtime-login-invalidate-failure" }),
    (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN",
  );
  await assert.rejects(
    manager.close(),
    (error) => error.code === "AUTH_MANAGER_CLOSE_FAILED"
      && error.errors.some((entry) => entry.code === "AUTH_STATE_COMMIT_UNCERTAIN"),
  );
  await stateStore.close();
});

test("start response 未到时 cancel 终止 Host 且晚到 response 不复活登录", async () => {
  const paths = fixturePaths("shoggoth-account-manager-start-cancel-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 7_000 });
  stateStore.open();
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const host = new FakeAuthHost({ startHook: () => startGate });
  const pool = new FakeRuntimePool(host);
  pool.stopHook = () => host.resolveTerminated();
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: pool,
    now: () => 7_000,
    randomUUID: () => "request-start-cancel",
  });
  manager.open();
  const starting = manager.loginStart({ runtimeProfileId: "runtime-start-cancel", mode: "browser" });
  const startingRejected = assert.rejects(starting, (error) => error.code === "AUTH_LOGIN_CANCELED");
  while (stateStore.get("runtime-start-cancel")?.status !== "starting") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await manager.loginCancel({
    runtimeProfileId: "runtime-start-cancel",
    requestId: "request-start-cancel",
  }), { requestId: "request-start-cancel", status: "canceled" });
  assert.deepEqual(pool.stopCalls, ["runtime-start-cancel"]);
  assert.equal(host.listeners.size, 0);
  assert.equal(host.authListeners.size, 0);
  assert.equal(manager.bindings.size, 0);
  releaseStart();
  await startingRejected;
  assert.equal(stateStore.get("runtime-start-cancel").status, "canceled");
  await manager.close();
  await stateStore.close();
});

test("login/start 永不返回时有界 stop Host，晚 response 不复活且不残留 timer/订阅", async () => {
  const paths = fixturePaths("shoggoth-account-manager-start-timeout-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 7_500 });
  stateStore.open();
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const host = new FakeAuthHost({ startHook: () => startGate });
  const pool = new FakeRuntimePool(host);
  pool.stopHook = () => host.resolveTerminated();
  let timeoutCallback;
  let clears = 0;
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: pool,
    now: () => 7_500,
    randomUUID: () => "request-start-timeout",
    setTimeout(callback) {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeout() { clears += 1; },
  });
  manager.open();
  const starting = manager.loginStart({ runtimeProfileId: "runtime-start-timeout", mode: "deviceCode" });
  const startingRejected = assert.rejects(starting, (error) => error.code === "AUTH_LOGIN_TIMEOUT");
  while (stateStore.get("runtime-start-timeout")?.status !== "starting") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof timeoutCallback, "function");
  timeoutCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pool.stopCalls, ["runtime-start-timeout"]);
  assert.equal(stateStore.get("runtime-start-timeout").status, "timed_out");
  assert.equal(stateStore.get("runtime-start-timeout").errorCode, "LOGIN_START_TIMEOUT");
  assert.equal(host.listeners.size, 0);
  assert.equal(host.authListeners.size, 0);
  assert.equal(manager.bindings.size, 0);
  assert.equal(clears, 1);
  releaseStart();
  await startingRejected;
  assert.equal(stateStore.get("runtime-start-timeout").status, "timed_out");
  await manager.close();
  await stateStore.close();
});

test("terminal 写与 stop 双失败仍在 start 前和已有 loginId 路径解绑且保留 poison 主错误", async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);

  async function runCase(name, holdStart) {
    const paths = fixturePaths(`shoggoth-account-manager-cancel-cleanup-${name}-`);
    const realStore = new AccountAuthStateStore({ paths, now: () => 7_800 });
    realStore.open();
    let rejectTerminal = false;
    const stateStore = {
      get: (...args) => realStore.get(...args),
      put(value) {
        if (rejectTerminal && value.status === "canceled") {
          throw Object.assign(new Error("terminal persistence private detail"), {
            code: "AUTH_STATE_WRITE_FAILED",
          });
        }
        return realStore.put(value);
      },
    };
    let releaseStart;
    const startGate = new Promise((resolve) => { releaseStart = resolve; });
    const host = new FakeAuthHost({ startHook: holdStart ? () => startGate : null });
    const pool = new FakeRuntimePool(host);
    pool.stopHook = async () => {
      throw new Error("runtime stop private detail");
    };
    const manager = new AccountAuthManager({
      stateStore,
      runtimePool: pool,
      now: () => 7_800,
      randomUUID: () => `request-cleanup-${name}`,
    });
    manager.open();
    const terminated = assert.rejects(
      manager.terminated,
      (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN",
    );
    const start = manager.loginStart({
      runtimeProfileId: `runtime-cleanup-${name}`,
      mode: "browser",
    });
    let startRejected = null;
    if (holdStart) {
      startRejected = assert.rejects(
        start,
        (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN",
      );
      while (host.calls.filter(([method]) => method === "start").length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    } else {
      await start;
    }

    rejectTerminal = true;
    const cancellation = manager.loginCancel({
      runtimeProfileId: `runtime-cleanup-${name}`,
      requestId: `request-cleanup-${name}`,
    });
    await assert.rejects(cancellation, (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.code, "AUTH_STATE_COMMIT_UNCERTAIN");
      assert.equal(error.errors[0]?.code, "AUTH_STATE_COMMIT_UNCERTAIN");
      assert.equal(error.errors.some((entry) => entry.code === "AUTH_HOST_CLEANUP_FAILED"), true);
      assert.equal(JSON.stringify(error).includes("private detail"), false);
      return true;
    });
    await terminated;
    assert.deepEqual(pool.stopCalls, [`runtime-cleanup-${name}`]);
    assert.equal(host.listeners.size, 0);
    assert.equal(host.authListeners.size, 0);
    assert.equal(manager.bindings.size, 0);

    if (holdStart) {
      releaseStart();
      await startRejected;
    }
    await assert.rejects(
      manager.close(),
      (error) => error.code === "AUTH_MANAGER_CLOSE_FAILED"
        && error.errors.some((entry) => entry.code === "AUTH_STATE_COMMIT_UNCERTAIN"),
    );
    rejectTerminal = false;
    await realStore.close();
  }

  try {
    await runCase("starting", true);
    await runCase("waiting", false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("terminal poison 后 stop 拒绝 pending login/start 时 cancel 与原 start 都返回 poison", async () => {
  const paths = fixturePaths("shoggoth-account-manager-start-stop-poison-");
  const realStore = new AccountAuthStateStore({ paths, now: () => 7_900 });
  realStore.open();
  let rejectTerminal = false;
  const stateStore = {
    get: (...args) => realStore.get(...args),
    put(value) {
      if (rejectTerminal && value.status === "canceled") {
        throw Object.assign(new Error("terminal write private detail"), {
          code: "AUTH_STATE_WRITE_FAILED",
        });
      }
      return realStore.put(value);
    },
  };
  let rejectStart;
  const startGate = new Promise((resolve, reject) => { rejectStart = reject; });
  const host = new FakeAuthHost({ startHook: () => startGate });
  const pool = new FakeRuntimePool(host);
  pool.stopHook = () => {
    rejectStart(Object.assign(new Error("rpc terminated private detail"), {
      code: "CODEX_RPC_TERMINATED",
    }));
  };
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: pool,
    now: () => 7_900,
    randomUUID: () => "request-start-stop-poison",
  });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    manager.open();
    const terminated = manager.terminated.then(
      () => ({ value: undefined }),
      (error) => ({ error }),
    );
    const start = manager.loginStart({
      runtimeProfileId: "runtime-start-stop-poison",
      mode: "browser",
    });
    const startOutcome = start.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    while (host.calls.filter(([method]) => method === "start").length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    rejectTerminal = true;
    await assert.rejects(
      manager.loginCancel({
        runtimeProfileId: "runtime-start-stop-poison",
        requestId: "request-start-stop-poison",
      }),
      (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN"
        && !JSON.stringify(error).includes("private detail"),
    );
    const [{ error: startError }, { error: terminationError }] = await Promise.all([
      startOutcome,
      terminated,
    ]);
    assert.equal(startError?.code, "AUTH_STATE_COMMIT_UNCERTAIN");
    assert.equal(terminationError?.code, "AUTH_STATE_COMMIT_UNCERTAIN");
    assert.notEqual(startError?.code, "CODEX_RPC_TERMINATED");
    assert.deepEqual(pool.stopCalls, ["runtime-start-stop-poison"]);
    assert.equal(host.listeners.size, 0);
    assert.equal(host.authListeners.size, 0);
    assert.equal(manager.bindings.size, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    await assert.rejects(
      manager.close(),
      (error) => error.code === "AUTH_MANAGER_CLOSE_FAILED"
        && error.errors.some((entry) => entry.code === "AUTH_STATE_COMMIT_UNCERTAIN"),
    );
    rejectTerminal = false;
    await realStore.close();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("logout 先取消 active login 且重复调用保持幂等", async () => {
  const paths = fixturePaths("shoggoth-account-manager-logout-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 8_000 });
  stateStore.open();
  const host = new FakeAuthHost();
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 8_000,
    randomUUID: () => "request-logout",
  });
  manager.open();
  await manager.loginStart({ runtimeProfileId: "runtime-logout", mode: "browser" });
  assert.deepEqual(await manager.logout({ runtimeProfileId: "runtime-logout" }), { loggedOut: true });
  assert.deepEqual(await manager.logout({ runtimeProfileId: "runtime-logout" }), { loggedOut: true });
  assert.equal(stateStore.get("runtime-logout").status, "canceled");
  assert.equal(host.calls.filter(([method]) => method === "cancel").length, 1);
  assert.equal(host.calls.filter(([method]) => method === "logout").length, 2);
  await manager.close();
  await stateStore.close();
});

test("logout 提交后先失效 RuntimeAccount 全部 Host，再释放 admission", async () => {
  const paths = fixturePaths("shoggoth-account-manager-logout-invalidate-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 8_100 });
  stateStore.open();
  const host = new FakeAuthHost();
  const admission = new FakeRuntimeAccountAdmission();
  let releaseInvalidation;
  const invalidationGate = new Promise((resolve) => { releaseInvalidation = resolve; });
  const invalidations = [];
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    runtimeAccountAdmission: admission,
    now: () => 8_100,
    randomUUID: () => "request-logout-invalidate",
    resolveRuntimeAccountBinding(runtimeAccountId) {
      return { runtime: "codex", runtimeProfileId: "profile-canonical", runtimeAccountId };
    },
    async invalidateRuntimeAccount(input) {
      invalidations.push(structuredClone(input));
      assert.equal(host.listeners.size, 0);
      assert.equal(host.authListeners.size, 0);
      await invalidationGate;
    },
  });
  manager.open();

  const logout = manager.logout({ runtimeAccountId: "account-logout-invalidate" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.calls.filter(([method]) => method === "logout").length, 1);
  assert.notEqual(admission.mutation, null);
  assert.deepEqual(admission.calls.map(([method]) => method), ["begin"]);
  assert.deepEqual(invalidations, [{
    runtimeAccountId: "account-logout-invalidate",
    binding: {
      runtime: "codex",
      runtimeProfileId: "profile-canonical",
      runtimeAccountId: "account-logout-invalidate",
    },
    reason: "logout",
  }]);

  releaseInvalidation();
  assert.deepEqual(await logout, { loggedOut: true });
  assert.equal(admission.mutation, null);
  assert.deepEqual(admission.calls.map(([method]) => method), ["begin", "finish"]);
  await manager.close();
  await stateStore.close();
});

test("logout 后 RuntimeAccount 失效失败会 poison 且不假装释放 admission", async () => {
  const paths = fixturePaths("shoggoth-account-manager-logout-invalidate-failure-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 8_200 });
  stateStore.open();
  const host = new FakeAuthHost();
  const admission = new FakeRuntimeAccountAdmission();
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    runtimeAccountAdmission: admission,
    now: () => 8_200,
    randomUUID: () => "request-logout-invalidate-failure",
    async invalidateRuntimeAccount() {
      throw new Error("private logout invalidation detail");
    },
  });
  manager.open();
  const terminated = assert.rejects(
    manager.terminated,
    (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN"
      && !error.message.includes("private logout invalidation detail"),
  );
  await assert.rejects(
    manager.logout({ runtimeProfileId: "runtime-logout-invalidate-failure" }),
    (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN",
  );
  await terminated;
  assert.notEqual(admission.mutation, null);
  assert.deepEqual(admission.calls.map(([method]) => method), ["begin"]);
  await assert.rejects(
    manager.close(),
    (error) => error.code === "AUTH_MANAGER_CLOSE_FAILED"
      && error.errors.some((entry) => entry.code === "AUTH_STATE_COMMIT_UNCERTAIN"),
  );
  await stateStore.close();
});

test("Service 默认 auth invalidator 会停止共享 RuntimeAccount 且不波及本机 Codex", async () => {
  const { createAgentService } = require(path.join(
    ROOT, "app", "agent-service", "server.js",
  ));
  const { ensureBuiltinCliAgentProfiles } = require(path.join(
    ROOT, "app", "agent-service", "builtin-cli-profiles.js",
  ));
  const { DEFAULT_AGENT_PROFILE_ID, JsonlProductStore } = require(path.join(
    ROOT, "app", "agent-service", "product-store.js",
  ));
  const paths = fixturePaths("shoggoth-account-server-invalidate-");
  const productStore = new JsonlProductStore({ paths, now: () => 8_300 });
  const stopCalls = [];
  const acquireCalls = [];
  const host = {
    terminated: new Promise(() => {}),
    subscribe() { return () => {}; },
    subscribeAccountAuth() { return () => {}; },
    async accountLogout() { return {}; },
  };
  const runtimeManager = {
    async acquire(binding) {
      acquireCalls.push(structuredClone(binding));
      return host;
    },
    async stop(binding) { stopCalls.push(structuredClone(binding)); },
    async stopAll() {},
  };
  const service = createAgentService({ paths, productStore, runtimeManager, now: () => 8_300 });
  await service.secretStore.open();
  productStore.open();
  service.accountAuthStateStore.open();
  service.accountAuthManager.open();
  try {
    ensureBuiltinCliAgentProfiles(productStore);
    const defaultProfile = productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    const nativeCodexProfile = productStore.listAgentProfiles()
      .find((profile) => profile.backendId === "codex");
    assert.ok(nativeCodexProfile);
    const peer = productStore.putAgentProfile({
      ...defaultProfile,
      id: "profile-auth-peer",
      agentId: "agent-auth-peer",
      runtimeProfileId: "runtime-auth-peer",
      name: "Auth peer",
      isDefault: false,
    });

    assert.deepEqual(await service.accountAuthManager.logout({
      runtimeAccountId: defaultProfile.runtimeAccountId,
    }), { loggedOut: true });
    assert.deepEqual(acquireCalls, [{
      runtime: defaultProfile.runtime,
      runtimeProfileId: defaultProfile.runtimeProfileId,
      runtimeAccountId: defaultProfile.runtimeAccountId,
    }]);
    assert.deepEqual(
      stopCalls.map((binding) => binding.runtimeProfileId).sort(),
      [defaultProfile.runtimeProfileId, peer.runtimeProfileId].sort(),
    );
    assert.equal(stopCalls.every((binding) => (
      binding.runtimeAccountId === defaultProfile.runtimeAccountId
    )), true);
    assert.equal(stopCalls.some((binding) => (
      binding.runtimeProfileId === nativeCodexProfile.runtimeProfileId
    )), false);
  } finally {
    await service.accountAuthManager.close();
    await service.accountAuthStateStore.close();
    await productStore.close();
    await service.secretStore.close();
  }
});

test("并发 cancel/logout/timeout 复用单一收敛且 Host terminated 竞态返回持久终态", async () => {
  const paths = fixturePaths("shoggoth-account-manager-cancel-flight-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 9_000 });
  stateStore.open();
  let releaseCancel;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const host = new FakeAuthHost({ cancelHook: () => cancelGate });
  let timeoutCallback;
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 9_000,
    randomUUID: () => "request-cancel-flight",
    setTimeout(callback) {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeout() {},
  });
  manager.open();
  await manager.loginStart({ runtimeProfileId: "runtime-cancel-flight", mode: "browser" });
  const input = { runtimeProfileId: "runtime-cancel-flight", requestId: "request-cancel-flight" };
  const first = manager.loginCancel(input);
  const second = manager.loginCancel(input);
  const logout = manager.logout({ runtimeProfileId: "runtime-cancel-flight" });
  timeoutCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.calls.filter(([method]) => method === "cancel").length, 1);
  releaseCancel();
  assert.deepEqual(await first, { requestId: "request-cancel-flight", status: "canceled" });
  assert.deepEqual(await second, { requestId: "request-cancel-flight", status: "canceled" });
  assert.deepEqual(await logout, { loggedOut: true });
  assert.equal(host.calls.filter(([method]) => method === "cancel").length, 1);

  const racePaths = fixturePaths("shoggoth-account-manager-cancel-terminated-");
  const raceStore = new AccountAuthStateStore({ paths: racePaths, now: () => 9_100 });
  raceStore.open();
  const raceHost = new FakeAuthHost({
    cancelHook(currentHost) { currentHost.resolveTerminated(); },
  });
  const raceManager = new AccountAuthManager({
    stateStore: raceStore,
    runtimePool: new FakeRuntimePool(raceHost),
    now: () => 9_100,
    randomUUID: () => "request-cancel-terminated",
  });
  raceManager.open();
  await raceManager.loginStart({ runtimeProfileId: "runtime-cancel-terminated", mode: "browser" });
  assert.deepEqual(await raceManager.loginCancel({
    runtimeProfileId: "runtime-cancel-terminated",
    requestId: "request-cancel-terminated",
  }), { requestId: "request-cancel-terminated", status: "interrupted" });
  assert.equal(raceStore.get("runtime-cancel-terminated").status, "interrupted");
  await manager.close();
  await stateStore.close();
  await raceManager.close();
  await raceStore.close();
});

test("Manager 只用完整 opaque loginId 关联 100/128/256B 完成通知", async () => {
  const paths = fixturePaths("shoggoth-account-manager-opaque-id-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 9_500 });
  stateStore.open();
  const loginIds = ["a".repeat(100), "b".repeat(128), "c".repeat(256)];
  const host = new FakeAuthHost({
    loginIds,
    startHook(currentHost, loginId) {
      currentHost.emitAuth({
        type: "account_login",
        method: "account/login/completed",
        loginId,
        status: "succeeded",
      });
    },
  });
  let idCounter = 0;
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 9_500,
    randomUUID: () => `request-opaque-${idCounter += 1}`,
  });
  manager.open();
  for (let index = 0; index < loginIds.length; index += 1) {
    const result = await manager.loginStart({
      runtimeProfileId: `runtime-opaque-${index}`,
      mode: "browser",
    });
    assert.equal(result.loginId, loginIds[index]);
    assert.equal(result.status, "succeeded");
    assert.equal(stateStore.get(`runtime-opaque-${index}`).status, "succeeded");
  }
  await manager.close();
  await stateStore.close();
});

test("Manager close singleflight 聚合持久化失败并 finally 清理全部 entry/binding/timer", async () => {
  const paths = fixturePaths("shoggoth-account-manager-close-failure-");
  const realStore = new AccountAuthStateStore({ paths, now: () => 9_800 });
  realStore.open();
  let rejectTerminalWrites = false;
  const stateStore = {
    get: (...args) => realStore.get(...args),
    put(value) {
      if (rejectTerminalWrites && value.status === "interrupted") {
        throw Object.assign(new Error(`close persistence detail ${value.runtimeAccountId}`), {
          code: "AUTH_STATE_WRITE_FAILED",
        });
      }
      return realStore.put(value);
    },
  };
  const host = new FakeAuthHost();
  let clearCalls = 0;
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 9_800,
    randomUUID: (() => {
      const ids = ["request-close-a", "request-close-b"];
      return () => ids.shift();
    })(),
    setTimeout() { return { unref() {} }; },
    clearTimeout() { clearCalls += 1; },
  });
  manager.open();
  await manager.loginStart({ runtimeProfileId: "runtime-close-a", mode: "browser" });
  await manager.loginStart({ runtimeProfileId: "runtime-close-b", mode: "deviceCode" });
  rejectTerminalWrites = true;
  const firstClose = manager.close();
  const closeRejected = assert.rejects(firstClose, (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.code, "AUTH_MANAGER_CLOSE_FAILED");
    assert.equal(error.errors.length, 2);
    assert.equal(JSON.stringify(error).includes("close persistence detail"), false);
    return true;
  });
  const secondClose = manager.close();
  assert.equal(firstClose, secondClose);
  await closeRejected;
  assert.equal(clearCalls, 2);
  assert.equal(host.listeners.size, 0);
  assert.equal(host.authListeners.size, 0);
  await assert.rejects(
    manager.loginStart({ runtimeProfileId: "runtime-after-close", mode: "browser" }),
    (error) => error.code === "AUTH_MANAGER_CLOSED",
  );
  rejectTerminalWrites = false;
  await realStore.close();
});

test("account/updated 异步 read 在 binding 终止或 Manager close 后不得发布", async () => {
  const paths = fixturePaths("shoggoth-account-manager-stale-update-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 9_900 });
  stateStore.open();
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const host = new FakeAuthHost({ readHook: () => readGate });
  const events = [];
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 9_900,
    randomUUID: () => "request-stale-update",
    onEvent: (event) => events.push(event),
  });
  manager.open();
  await manager.loginStart({ runtimeProfileId: "runtime-stale-update", mode: "browser" });
  host.emit({ known: true, type: "account_updated", method: "account/updated" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.calls.filter(([method]) => method === "read").length, 1);
  const closing = manager.close();
  releaseRead({
    account: { type: "chatgpt", planType: "plus", email: "late@example.test" },
    requiresOpenaiAuth: true,
  });
  await closing;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  await stateStore.close();
});

test("实时 terminal 写失败使 Manager poison，零 unhandled 且 close 仍聚合清理", async () => {
  const paths = fixturePaths("shoggoth-account-manager-terminal-poison-");
  const realStore = new AccountAuthStateStore({ paths, now: () => 10_000 });
  realStore.open();
  const stateStore = {
    get: (...args) => realStore.get(...args),
    put(value) {
      if (value.status === "succeeded") {
        throw Object.assign(new Error("terminal write private detail"), { code: "AUTH_STATE_WRITE_FAILED" });
      }
      return realStore.put(value);
    },
  };
  const host = new FakeAuthHost();
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 10_000,
    randomUUID: () => "request-terminal-poison",
  });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    manager.open();
    const terminated = assert.rejects(
      manager.terminated,
      (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN"
        && !error.message.includes("terminal write private detail"),
    );
    await manager.loginStart({ runtimeProfileId: "runtime-terminal-poison", mode: "browser" });
    host.emitAuth({
      type: "account_login",
      method: "account/login/completed",
      loginId: "login-1",
      status: "succeeded",
    });
    await terminated;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(realStore.get("runtime-terminal-poison").status, "waiting");
    assert.deepEqual(host.authSubscriberErrors, []);
    assert.deepEqual(unhandled, []);
    for (const action of [
      () => manager.read({ runtimeProfileId: "runtime-terminal-poison" }),
      () => manager.loginStart({ runtimeProfileId: "runtime-new", mode: "browser" }),
      () => manager.loginCancel({
        runtimeProfileId: "runtime-terminal-poison", requestId: "request-terminal-poison",
      }),
      () => manager.logout({ runtimeProfileId: "runtime-terminal-poison" }),
    ]) {
      await assert.rejects(action(), (error) => error.code === "AUTH_STATE_COMMIT_UNCERTAIN");
    }
    const closing = manager.close();
    await assert.rejects(closing, (error) => error.code === "AUTH_MANAGER_CLOSE_FAILED"
      && error.errors.some((entry) => entry.code === "AUTH_STATE_COMMIT_UNCERTAIN"));
    assert.equal(host.listeners.size, 0);
    assert.equal(host.authListeners.size, 0);
    await realStore.close();
    assert.equal(realStore.opened, false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("read/start/cancel/logout 每次 await 后拒绝 stale generation 且 pool.get 晚到不订阅", async () => {
  async function pendingPoolCase(name, invoke, prepare = async () => {}) {
    const paths = fixturePaths(`shoggoth-account-manager-stale-${name}-`);
    const stateStore = new AccountAuthStateStore({ paths, now: () => 10_100 });
    stateStore.open();
    const host = new FakeAuthHost();
    const pool = new FakeRuntimePool(host);
    const manager = new AccountAuthManager({
      stateStore,
      runtimePool: pool,
      now: () => 10_100,
      randomUUID: () => `request-stale-${name}`,
    });
    manager.open();
    await prepare({ manager, host, pool, stateStore });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    pool.getHook = () => gate;
    const pending = invoke({ manager, host, pool, stateStore });
    const rejected = assert.rejects(pending, (error) => error.code === "AUTH_MANAGER_CLOSED");
    await new Promise((resolve) => setImmediate(resolve));
    await manager.close();
    release(host);
    await rejected;
    assert.equal(host.listeners.size, 0);
    assert.equal(host.authListeners.size, 0);
    await stateStore.close();
  }

  await pendingPoolCase("read", ({ manager }) => manager.read({ runtimeProfileId: "runtime-stale-read" }));
  await pendingPoolCase("start", ({ manager }) => manager.loginStart({
    runtimeProfileId: "runtime-stale-start", mode: "browser",
  }));
  await pendingPoolCase("logout", ({ manager }) => manager.logout({
    runtimeProfileId: "runtime-stale-logout",
  }));

  const paths = fixturePaths("shoggoth-account-manager-stale-cancel-");
  const stateStore = new AccountAuthStateStore({ paths, now: () => 10_200 });
  stateStore.open();
  let releaseCancel;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const host = new FakeAuthHost({ cancelHook: () => cancelGate });
  const manager = new AccountAuthManager({
    stateStore,
    runtimePool: new FakeRuntimePool(host),
    now: () => 10_200,
    randomUUID: () => "request-stale-cancel",
  });
  manager.open();
  await manager.loginStart({ runtimeProfileId: "runtime-stale-cancel", mode: "browser" });
  const pendingCancel = manager.loginCancel({
    runtimeProfileId: "runtime-stale-cancel", requestId: "request-stale-cancel",
  });
  const cancelRejected = assert.rejects(
    pendingCancel,
    (error) => error.code === "AUTH_MANAGER_CLOSED",
  );
  await new Promise((resolve) => setImmediate(resolve));
  await manager.close();
  releaseCancel();
  await cancelRejected;
  assert.equal(host.listeners.size, 0);
  assert.equal(host.authListeners.size, 0);
  await stateStore.close();
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    let testFailed = false;
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      testFailed = true;
      failed += 1;
      process.stderr.write(`FAIL ${name}\n${error?.stack || error}\n`);
    } finally {
      try {
        for (const root of [...pendingFixtureRoots]) {
          fs.rmSync(root, { recursive: true, force: true });
          assert.equal(fs.existsSync(root), false, `残留 auth fixture: ${root}`);
          pendingFixtureRoots.delete(root);
        }
      } catch (error) {
        if (!testFailed) failed += 1;
        process.stderr.write(`FAIL ${name} fixture cleanup\n${error?.stack || error}\n`);
      }
    }
  }
  for (const root of fixtureRoots) assert.equal(fs.existsSync(root), false, `残留 auth fixture: ${root}`);
  if (failed > 0) process.exitCode = 1;
  else process.stdout.write(`PASS codex account auth unit (${tests.length})\n`);
})();
