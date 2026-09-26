#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveServicePaths } = require("../app/agent-service/paths");
const {
  NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
  NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("../app/agent-service/runtime-account");
const { createRuntimeCliAuth } = require("../app/runtime-cli-auth");

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cli-auth-")));
  const userHome = path.join(root, "user");
  const userDataRoot = path.join(root, "data");
  fs.mkdirSync(userHome, { mode: 0o700 });
  fs.mkdirSync(userDataRoot, { mode: 0o700 });
  const paths = resolveServicePaths({ userDataRoot, homeDir: userHome });
  fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  const binaryResolvers = Object.fromEntries([
    "codex", "grok-build", "antigravity", "pi", "claude-code", "deepseek-harness",
  ].map((runtime) => [runtime, () => path.join(root, "bin", runtime)]));
  const create = (overrides = {}) => createRuntimeCliAuth({
    paths,
    homedir: () => userHome,
    parentEnv: {},
    resolveBundledCodexLayout: () => ({ runtimePath: path.join(root, "bundled", "codex") }),
    binaryResolvers,
    ...overrides,
  });
  return { root, userHome, paths, create };
}

test("catalog exposes seven available account-scoped environments without creating Runtime Homes", () => {
  const value = fixture();
  try {
    const before = fs.readdirSync(value.paths.stateDir);
    const catalog = value.create();
    assert.ok(catalog.every((item) => !item.runtimeAccountId.includes("claude")));
    assert.equal(catalog.length, 7);
    assert.equal(new Set(catalog.map((entry) => entry.runtimeAccountId)).size, 7);
    const internal = catalog.find((entry) => (
      entry.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
    ));
    const nativeCodex = catalog.find((entry) => (
      entry.runtimeAccountId === NATIVE_CODEX_RUNTIME_ACCOUNT_ID
    ));
    const nativeGrok = catalog.find((entry) => (
      entry.runtimeAccountId === NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID
    ));
    const antigravity = catalog.find((entry) => (
      entry.runtimeAccountId === NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID
    ));
    const deepseek = catalog.find((entry) => (
      entry.runtimeAccountId === NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID
    ));
    assert.equal(deepseek.name, "DeepSeek");
    assert.deepEqual({
      internalHome: internal.accountHome,
      internalKind: internal.accountKind,
      nativeCodexHome: nativeCodex.accountHome,
      nativeCodexKind: nativeCodex.accountKind,
      nativeGrokHome: nativeGrok.accountHome,
      nativeGrokProcessHome: nativeGrok.processHome,
      antigravityHome: antigravity.accountHome,
      antigravityProcessHome: antigravity.processHome,
    }, {
      internalHome: path.join(
        value.paths.runtimeAccountsDir,
        "codex",
        SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        "home",
      ),
      internalKind: "shoggoth-managed",
      nativeCodexHome: path.join(value.userHome, ".codex"),
      nativeCodexKind: "native-user",
      nativeGrokHome: path.join(value.userHome, ".grok"),
      nativeGrokProcessHome: value.userHome,
      antigravityHome: path.join(
        value.paths.runtimeIntegrationDir,
        "antigravity",
        NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
        "home",
      ),
      antigravityProcessHome: path.join(
        value.paths.runtimeIntegrationDir,
        "antigravity",
        NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
        "home",
      ),
    });
    assert.deepEqual(fs.readdirSync(value.paths.stateDir), before);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("retired profile Homes never replace the current managed account Home", () => {
  const value = fixture();
  try {
    const legacyHome = path.join(
      value.paths.stateDir,
      "codex",
      "retired-profile",
    );
    fs.mkdirSync(legacyHome, { recursive: true, mode: 0o700 });
    const internal = value.create().find((entry) => (
      entry.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
    ));
    assert.equal(internal.accountHome, path.join(
      value.paths.runtimeAccountsDir, "codex", SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID, "home",
    ));
    assert.ok(fs.statSync(legacyHome).isDirectory());
    assert.equal(fs.existsSync(value.paths.runtimeAccountsDir), false);
    fs.mkdirSync(internal.accountHome, { recursive: true, mode: 0o700 });
    const current = value.create().find((entry) => (
      entry.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
    ));
    assert.equal(current.accountHome, internal.accountHome);
    assert.ok(current.binaryPath);
    assert.equal(current.unavailableReason, undefined);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("invalid native Home override is visible and never creates a replacement", () => {
  const value = fixture();
  try {
    const grok = value.create({ parentEnv: { GROK_HOME: "relative-home" } })
      .find((entry) => entry.runtimeAccountId === NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID);
    assert.deepEqual({
      binaryPath: grok.binaryPath,
      accountHome: grok.accountHome,
      unavailableReason: grok.unavailableReason,
    }, {
      binaryPath: null,
      accountHome: path.join(value.userHome, ".grok"),
      unavailableReason: "Grok CLI Home is invalid or unsafe",
    });
    assert.equal(fs.existsSync(path.join(value.userHome, ".grok")), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("Codex authority overlap fails both descriptors closed without creating Homes", () => {
  for (const overlap of ["equal", "ancestor", "descendant"]) {
    const value = fixture();
    try {
      const managedHome = path.join(
        value.paths.runtimeAccountsDir,
        "codex",
        SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        "home",
      );
      const nativeHome = overlap === "equal" ? managedHome
        : overlap === "ancestor" ? value.paths.stateDir
          : path.join(managedHome, "native-codex-child");
      const before = fs.readdirSync(value.paths.stateDir);
      const catalog = value.create({ parentEnv: { CODEX_HOME: nativeHome } });
      for (const accountId of [
        SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
      ]) {
        const descriptor = catalog.find((entry) => entry.runtimeAccountId === accountId);
        assert.deepEqual({
          binaryPath: descriptor.binaryPath,
          unavailableReason: descriptor.unavailableReason,
          loginArgs: descriptor.loginArgs,
          logoutArgs: descriptor.logoutArgs,
        }, {
          binaryPath: null,
          unavailableReason: "Native and Shoggoth-managed Codex Homes overlap",
          loginArgs: [],
          logoutArgs: [],
        });
      }
      assert.deepEqual(fs.readdirSync(value.paths.stateDir), before);
      assert.equal(fs.existsSync(managedHome), false);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("DeepSeek authority overlap rejects equal, ancestor, and descendant Homes without writes", () => {
  for (const overlap of ["equal", "ancestor", "descendant"]) {
    const value = fixture();
    try {
      const integrationRoot = path.join(
        value.paths.runtimeIntegrationDir,
        "deepseek-harness",
        NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
      );
      const nativeHome = overlap === "equal" ? integrationRoot
        : overlap === "ancestor" ? value.paths.stateDir
          : path.join(integrationRoot, "native-dsh-child");
      const before = fs.readdirSync(value.paths.stateDir);
      const descriptor = value.create({ parentEnv: { DSH_HOME: nativeHome } })
        .find((entry) => (
          entry.runtimeAccountId === NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID
        ));
      assert.deepEqual({
        binaryPath: descriptor.binaryPath,
        unavailableReason: descriptor.unavailableReason,
        loginArgs: descriptor.loginArgs,
        logoutArgs: descriptor.logoutArgs,
      }, {
        binaryPath: null,
        unavailableReason: "Native DeepSeek Home overlaps its Shoggoth integration Home",
        loginArgs: [],
        logoutArgs: [],
      });
      assert.deepEqual(fs.readdirSync(value.paths.stateDir), before);
      assert.equal(fs.existsSync(integrationRoot), false);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("Antigravity native and integration authority overlap is unavailable without writes", () => {
  const value = fixture();
  try {
    const nativeHome = path.join(value.userHome, ".gemini");
    const paths = {
      ...value.paths,
      runtimeIntegrationDir: path.join(nativeHome, "shoggoth-integration"),
    };
    const before = fs.readdirSync(value.userHome);
    const descriptor = value.create({ paths }).find((entry) => (
      entry.runtimeAccountId === NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID
    ));
    assert.deepEqual({
      binaryPath: descriptor.binaryPath,
      unavailableReason: descriptor.unavailableReason,
      loginArgs: descriptor.loginArgs,
      logoutArgs: descriptor.logoutArgs,
    }, {
      binaryPath: null,
      unavailableReason: "Native Antigravity Home overlaps its Shoggoth integration Home",
      loginArgs: [],
      logoutArgs: [],
    });
    assert.deepEqual(fs.readdirSync(value.userHome), before);
    assert.equal(fs.existsSync(nativeHome), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
