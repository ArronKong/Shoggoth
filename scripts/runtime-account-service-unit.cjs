#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  RuntimeAccountServiceController,
} = require("../app/agent-service/runtime-account-service-controller");
const {
  validateRuntimeAccountServiceParams,
  validateRuntimeAccountServiceResult,
} = require("../app/agent-service/runtime-account-service-protocol");
const {
  NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  DEFAULT_RUNTIME_ACCOUNTS,
} = require("../app/agent-service/runtime-account");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixture(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-account-service-")));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const paths = {
    trustedRoot: root,
    stateDir,
    runtimeAccountsDir: path.join(stateDir, "runtime-accounts"),
  };
  const accounts = DEFAULT_RUNTIME_ACCOUNTS.filter((account) => [
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
    ...(options.loginManagers ? [NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID, NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID] : []),
  ].includes(account.id)).map((account) => ({ ...account }));
  const profiles = [
    {
      id: "agent-codex-default", runtime: "codex", runtimeProfileId: "codex-main",
      runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID, isDefault: true,
    },
    {
      id: "agent-codex-old", runtime: "codex", runtimeProfileId: "codex-old",
      runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID, isDefault: false,
    },
    {
      id: "agent-codex-native", runtime: "codex", runtimeProfileId: "codex-native",
      runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID, isDefault: false,
    },
    {
      id: "agent-grok", runtime: "grok-build", runtimeProfileId: "grok-old",
      runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID, isDefault: true,
    },
  ];
  for (const profile of profiles) {
    const home = path.join(stateDir, profile.runtime, profile.runtimeProfileId);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, "payload.bin"), Buffer.alloc(16));
  }
  const productStore = {
    listRuntimeAccounts: () => accounts.map((account) => ({ ...account })),
    getRuntimeAccount: (id) => accounts.find((account) => account.id === id) || null,
    listAgentProfiles: () => profiles.map((profile) => ({ ...profile })),
  };
  const authCalls = [];
  const accountAuthManager = {
    read: async (input) => {
      authCalls.push(["read", input]);
      return { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true, login: null };
    },
    loginStart: async (input) => {
      authCalls.push(["start", input]);
      return {
        requestId: "request-1", mode: input.mode, status: "waiting", loginId: "login-1",
        authUrl: "https://example.com/login",
      };
    },
    loginCancel: async (input) => {
      authCalls.push(["cancel", input]);
      return { requestId: input.requestId, status: "canceled" };
    },
    logout: async (input) => {
      authCalls.push(["logout", input]);
      return { loggedOut: true };
    },
  };
  const homeDir = path.join(root, "home");
  const nativeGrokHome = path.join(root, "native-grok-home");
  fs.mkdirSync(homeDir, { mode: 0o700 });
  fs.mkdirSync(nativeGrokHome, { mode: 0o700 });
  fs.writeFileSync(path.join(nativeGrokHome, "native.bin"), Buffer.alloc(24));
  const controller = new RuntimeAccountServiceController({
    productStore,
    runtimeAccountAdmission: {
      read: (id) => ({
        runtimeAccountId: id,
        generation: 1,
        active: 0,
        maxActive: 1,
        mutationActive: false,
        backoffUntil: null,
      }),
    },
    accountAuthManager,
    ...(options.loginManagers ? { loginManagers: options.loginManagers } : {}),
    paths,
    fs: options.fs,
    now: options.now || (() => 1_000),
    ...(options.defaultStorage
      ? { parentEnv: { GROK_HOME: nativeGrokHome }, homedir: homeDir }
      : {
        readAccountStorage: (account) => ({
          runtimeAccountId: account.id,
          scope: account.kind === "native-user" ? "native-system" : "managed-account",
          available: true,
          bytes: 16,
          files: 1,
          dirs: 1,
          symlinks: 0,
          incomplete: false,
          limitReason: null,
        }),
      }),
  });
  controller.open();
  return {
    root,
    stateDir,
    controller,
    authCalls,
  };
}

test("Antigravity signs in through its Service manager and Codex progress reads the same shape", async () => {
  const calls = [];
  const manager = {
    start: async (input) => {
      calls.push(["start", input]);
      return { requestId: "agy-1", mode: "browser", status: "waiting", loginId: "agy-1", authUrl: null };
    },
    read: async (input) => {
      calls.push(["read", input]);
      return { login: { requestId: "agy-1", mode: "browser", status: "waiting", updatedAt: 5, errorCode: null,
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x", stage: "waiting", browserOpened: true,
        instructions: null, codeRequired: false } };
    },
    cancel: async (input) => {
      calls.push(["cancel", input]);
      return { requestId: input.requestId, status: "canceled" };
    },
    close: () => { calls.push(["close"]); },
  };
  const value = fixture({ loginManagers: { antigravity: manager } });
  const agy = NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID;
  try {
    const start = await value.controller.handle("runtime.account.login.start", { runtimeAccountId: agy, mode: "browser" });
    assert.equal(validateRuntimeAccountServiceResult("runtime.account.login.start", start).authUrl, null,
      "a runtime that opens the browser itself reports its URL later");
    const read = await value.controller.handle("runtime.account.login.read", { runtimeAccountId: agy });
    assert.equal(validateRuntimeAccountServiceResult("runtime.account.login.read", read).login.browserOpened, true);
    assert.deepEqual(await value.controller.handle("runtime.account.login.cancel", { runtimeAccountId: agy, requestId: "agy-1" }),
      { requestId: "agy-1", status: "canceled" });
    await assert.rejects(value.controller.handle("runtime.account.login.start", { runtimeAccountId: agy, mode: "deviceCode" }),
      { code: "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED" });
    for (const method of ["runtime.account.auth.read", "runtime.account.logout"]) {
      await assert.rejects(value.controller.handle(method, { runtimeAccountId: agy }), { code: "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED" });
    }
    const codex = await value.controller.handle("runtime.account.login.read", { runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID });
    assert.deepEqual(validateRuntimeAccountServiceResult("runtime.account.login.read", codex), { login: null });
    assert.deepEqual(value.authCalls.map(([name]) => name), ["read"], "only Codex reaches the Codex auth manager");
    assert.deepEqual(calls.map(([name]) => name), ["start", "read", "cancel"]);
  } finally {
    value.controller.close();
    fs.rmSync(value.root, { recursive: true });
  }
  assert.deepEqual(calls.at(-1), ["close"], "closing the controller stops active sign-ins");
});

test("OpenCode signs into a chosen provider through its manager", async () => {
  const calls = [];
  const manager = {
    read: async () => ({ login: null }),
    cancel: async (input) => ({ requestId: input.requestId, status: "canceled" }),
    options: async (input) => { calls.push(["options", input]); return { providers: [] }; },
    providerStart: async (input) => {
      calls.push(["providerStart", input]);
      return { requestId: "oc-1", mode: "browser", status: "waiting", loginId: "oc-1", authUrl: "https://github.com/login/device" };
    },
    submit: async (input) => { calls.push(["submit", input]); return { requestId: input.requestId, status: "succeeded" }; },
    apiKey: async (input) => { calls.push(["apiKey", input]); return { saved: true }; },
  };
  const value = fixture({ loginManagers: { opencode: manager } });
  const opencode = NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID;
  try {
    assert.deepEqual(await value.controller.handle("runtime.account.login.options", { runtimeAccountId: opencode }), { providers: [] });
    await value.controller.handle("runtime.account.login.provider.start",
      { runtimeAccountId: opencode, providerId: "github-copilot", method: 0, inputs: { deploymentType: "github.com" } });
    await value.controller.handle("runtime.account.login.submit", { runtimeAccountId: opencode, requestId: "oc-1", code: "abc" });
    await value.controller.handle("runtime.account.login.apikey",
      { runtimeAccountId: opencode, providerId: "deepseek", key: "sk-test", inputs: {} });
    assert.deepEqual(calls.map(([name]) => name), ["options", "providerStart", "submit", "apiKey"]);
    await assert.rejects(value.controller.handle("runtime.account.login.start", { runtimeAccountId: opencode, mode: "browser" }),
      { code: "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED" }, "OpenCode needs a provider choice");
    await assert.rejects(value.controller.handle("runtime.account.login.options", { runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID }),
      { code: "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED" }, "Codex has no provider choice");
    for (const params of [
      { runtimeAccountId: opencode, providerId: "../x", method: 0, inputs: {} },
      { runtimeAccountId: opencode, providerId: "openai", method: 9, inputs: {} },
      { runtimeAccountId: opencode, providerId: "openai", method: 0, inputs: { "bad key": "x" } },
    ]) {
      assert.throws(() => validateRuntimeAccountServiceParams("runtime.account.login.provider.start", params), { code: "INVALID_PARAMS" });
    }
    assert.throws(() => validateRuntimeAccountServiceParams("runtime.account.login.apikey",
      { runtimeAccountId: opencode, providerId: "deepseek", key: "line\nbreak", inputs: {} }), { code: "INVALID_PARAMS" });
  } finally {
    value.controller.close();
    fs.rmSync(value.root, { recursive: true });
  }
});

test("protocol rejects raw paths and response-only storage paths", () => {
  assert.throws(
    () => validateRuntimeAccountServiceParams(
      "runtime.account.backups.cleanup.prepare",
      { entryId: `runtime-backup-${"a".repeat(64)}-v1`, path: "/tmp/forged" },
    ),
    { code: "INVALID_PARAMS" },
  );
  assert.throws(
    () => validateRuntimeAccountServiceParams(
      "runtime.account.legacyHomes.cleanup.commit",
      { planId: "a".repeat(64), path: "/tmp/forged" },
    ),
    { code: "INVALID_PARAMS" },
  );
  assert.throws(
    () => validateRuntimeAccountServiceResult("runtime.account.storage.read", {
      runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
      scope: "native-system",
      available: true,
      bytes: 1,
      files: 1,
      dirs: 1,
      symlinks: 0,
      incomplete: false,
      limitReason: null,
      path: "/Users/private/.grok",
    }),
    { code: "RUNTIME_ACCOUNT_RESPONSE_INVALID" },
  );
  assert.throws(
    () => validateRuntimeAccountServiceResult("runtime.account.backups.list", {
      backups: [{
        id: `runtime-backup-${"a".repeat(64)}-v1`,
        category: "unknown",
        role: "retained",
        bytes: 1,
        files: 1,
        dirs: 1,
        symlinks: 0,
        incomplete: false,
        lastModifiedAt: 1,
        path: "/Users/private/backup",
      }],
      nextCursor: null,
      hasMore: false,
    }),
    { code: "RUNTIME_ACCOUNT_RESPONSE_INVALID" },
  );
});

test("account list exposes sharing and admission without authority internals", async () => {
  const value = fixture();
  try {
    const result = await value.controller.handle("runtime.account.list", { cursor: null, limit: 100 });
    assert.equal(result.accounts.length, 3);
    assert.equal(result.accounts.find(
      (account) => account.id === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ).sharedAgentCount, 2);
    assert.equal(result.accounts.find(
      (account) => account.id === NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    ).sharedAgentCount, 1);
    assert.equal(JSON.stringify(result).includes("providerRef"), false);
    assert.equal(JSON.stringify(result).includes("runtimeProfileId"), false);
  } finally {
    value.controller.close();
    fs.rmSync(value.root, { recursive: true });
  }
});

test("native storage inspection is read-only and constrained to a temporary CLI Home", async () => {
  const value = fixture({ defaultStorage: true });
  try {
    const result = await value.controller.handle("runtime.account.storage.read", {
      runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
    });
    assert.deepEqual(result, {
      runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
      scope: "native-system",
      available: true,
      bytes: 24,
      files: 1,
      dirs: 1,
      symlinks: 0,
      incomplete: false,
      limitReason: null,
    });
    assert.equal(JSON.stringify(result).includes(value.root), false);
  } finally {
    value.controller.close();
    fs.rmSync(value.root, { recursive: true });
  }
});

test("native storage endpoint tolerates live IPC entries and stays within its scan budget", async () => {
  const fileSystem = Object.create(fs);
  fileSystem.lstatSync = (target) => {
    const stat = fs.lstatSync(target);
    if (path.basename(target) === "ipc") {
      stat.isFile = () => false;
      stat.isSocket = () => true;
    }
    return stat;
  };
  const value = fixture({ defaultStorage: true, fs: fileSystem });
  const ipc = path.join(value.root, "native-grok-home", "ipc");
  fs.writeFileSync(ipc, "");
  const realNow = Date.now;
  try {
    const result = await value.controller.handle("runtime.account.storage.read", {
      runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
    });
    assert.equal(result.bytes, 24);
    assert.equal(result.files, 1);
    assert.equal(result.incomplete, false);
    assert.equal(fs.existsSync(ipc), true);
    // Deterministic elapsed time; no long sleeps or large fixture needed.
    let tick = 0;
    Date.now = () => (tick += 600);
    const bounded = await value.controller.handle("runtime.account.storage.read", {
      runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
    });
    assert.equal(bounded.incomplete, true);
    assert.equal(bounded.limitReason, "duration");
  } finally {
    Date.now = realNow;
    value.controller.close();
    fs.rmSync(value.root, { recursive: true });
  }
});

test("both Codex accounts forward only the RuntimeAccount identity", async () => {
  const value = fixture();
  try {
    for (const runtimeAccountId of [
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    ]) {
      const auth = await value.controller.handle("runtime.account.auth.read", {
        runtimeAccountId,
      });
      assert.deepEqual(auth.account, { type: "chatgpt", planType: "plus" });
      await value.controller.handle("runtime.account.login.start", {
        runtimeAccountId,
        mode: "browser",
      });
      await value.controller.handle("runtime.account.login.cancel", {
        runtimeAccountId,
        requestId: "request-1",
      });
      await value.controller.handle("runtime.account.logout", { runtimeAccountId });
    }
    assert.deepEqual(value.authCalls, [
      ["read", { runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID }],
      ["start", {
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        mode: "browser",
      }],
      ["cancel", {
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        requestId: "request-1",
      }],
      ["logout", { runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID }],
      ["read", { runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID }],
      ["start", {
        runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
        mode: "browser",
      }],
      ["cancel", {
        runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
        requestId: "request-1",
      }],
      ["logout", { runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID }],
    ]);
  } finally {
    value.controller.close();
    fs.rmSync(value.root, { recursive: true });
  }
});

test("non-Codex auth operations fail closed before touching the Codex auth manager", async () => {
  const value = fixture();
  try {
    const operations = [
      ["runtime.account.auth.read", {
        runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
      }],
      ["runtime.account.login.start", {
        runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
        mode: "browser",
      }],
      ["runtime.account.login.cancel", {
        runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
        requestId: "request-1",
      }],
      ["runtime.account.login.read", {
        runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
      }],
      ["runtime.account.logout", {
        runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
      }],
    ];
    for (const [method, params] of operations) {
      await assert.rejects(
        value.controller.handle(method, params),
        { code: "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED" },
      );
    }
    assert.deepEqual(value.authCalls, []);
  } finally {
    value.controller.close();
    fs.rmSync(value.root, { recursive: true });
  }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${name}\n${error?.stack || error}\n`);
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${passed}/${tests.length} passed\n`);
})();
