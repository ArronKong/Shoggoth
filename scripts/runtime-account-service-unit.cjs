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
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
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
