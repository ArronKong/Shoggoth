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
const { resolveSystemCli } = require("../app/agent-service/system-cli-discovery");
const { resolveOpenCodeBinary } = require("../app/agent-service/opencode-runtime-paths");

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

test("OpenCode auto-discovery recognizes its vendor directory after the existing fallbacks", t => {
  const { root, userHome, create } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const standard = path.join(root, "standard");
  const fileSystem = {
    ...fs, realpathSync: target => fs.realpathSync(target.replace(/^\/(opt\/homebrew|usr\/local)\/bin\//u, `${standard}/$1/`)),
  };
  const writeExecutable = (target, mode = 0o755) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "fixture", { mode });
    return target;
  };
  const vendor = path.join(userHome, ".opencode", "bin", "opencode");
  const options = { fs: fileSystem, parentEnv: { PATH: "/usr/bin:/bin" }, homedir: userHome };
  assert.throws(() => resolveOpenCodeBinary(options), { code: "OPENCODE_BINARY_NOT_FOUND" });
  writeExecutable(vendor);
  assert.equal(resolveOpenCodeBinary(options), vendor);
  let descriptor = create({ ...options, binaryResolvers: {}, systemOnly: true }).find(row => row.runtime === "opencode");
  assert.equal(descriptor.binaryPath, vendor);
  assert.equal(descriptor.binarySource, "vendor-bin");

  const standardBinary = writeExecutable(path.join(standard, "opt", "homebrew", "opencode"));
  assert.equal(resolveOpenCodeBinary(options), standardBinary);
  const userBinary = writeExecutable(path.join(userHome, ".local", "bin", "opencode"));
  assert.equal(resolveOpenCodeBinary(options), userBinary);

  const nonExecutable = writeExecutable(path.join(root, "no-execute", "opencode"), 0o644);
  const broken = path.join(root, "broken", "opencode");
  fs.mkdirSync(path.dirname(broken));
  fs.symlinkSync(path.join(root, "missing"), broken);
  const shim = path.join(root, "prefix with spaces", "opencode");
  fs.mkdirSync(path.dirname(shim));
  fs.symlinkSync(vendor, shim);
  const env = { PATH: ["relative", path.dirname(nonExecutable), path.dirname(broken), path.dirname(shim),
    path.dirname(standardBinary), path.dirname(shim)].join(path.delimiter) };
  descriptor = create({ ...options, parentEnv: env, binaryResolvers: {}, systemOnly: true }).find(row => row.runtime === "opencode");
  assert.equal(descriptor.binaryPath, vendor);
  assert.equal(descriptor.binaryCandidatePath, shim);
  assert.equal(descriptor.binarySource, "path");
  assert.equal(resolveOpenCodeBinary({ ...options, binaryPath: userBinary }), userBinary);
  assert.throws(() => resolveOpenCodeBinary({ ...options, binaryPath: broken }), { code: "OPENCODE_BINARY_INVALID" });

  for (const [runtime, command] of Object.entries({
    codex: "codex", "grok-build": "grok", pi: "pi", "claude-code": "claude", "deepseek-harness": "dsh",
  })) {
    const executable = writeExecutable(path.join(userHome, ".local", "bin", command));
    assert.equal(resolveSystemCli(runtime, options).binaryPath, executable);
  }
});

test("catalog exposes eight available account-scoped environments without creating Runtime Homes", () => {
  const value = fixture();
  try {
    const before = fs.readdirSync(value.paths.stateDir);
    const catalog = value.create();
    const claude = catalog.find((item) => item.runtime === "claude-code");
    // The user's own CLI sign-in: Shoggoth only hands the official commands over.
    assert.deepEqual({ homeEnv: claude.homeEnv, loginArgs: claude.loginArgs, logoutArgs: claude.logoutArgs },
      { homeEnv: "CLAUDE_CONFIG_DIR", loginArgs: ["auth", "login", "--claudeai"], logoutArgs: ["auth", "logout"] });
    assert.equal(catalog.length, 8);
    assert.equal(new Set(catalog.map((entry) => entry.runtimeAccountId)).size, 8);
    const internal = catalog.find((entry) => (
      entry.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
    ));
    const nativeCodex = catalog.find((entry) => (
      entry.runtimeAccountId === NATIVE_CODEX_RUNTIME_ACCOUNT_ID
    ));
    assert.equal(internal.name, "Shoggoth");
    assert.equal(nativeCodex.name, "Codex");
    assert.deepEqual(value.create({ nativeOnly: true }).map((entry) => entry.runtimeAccountId),
      catalog.filter((entry) => entry.accountKind === "native-user").map((entry) => entry.runtimeAccountId));
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
    assert.equal(descriptor.loginCommand, undefined, "an unsafe authority layout offers no sign-in");
    assert.deepEqual(fs.readdirSync(value.userHome), before);
    assert.equal(fs.existsSync(nativeHome), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("Antigravity signs in through Shoggoth's own script, even before the ACP server is installed", () => {
  const value = fixture();
  try {
    const before = fs.readdirSync(value.paths.stateDir);
    const executablePath = path.join(value.root, "Shoggoth.app", "Contents", "MacOS", "Shoggoth");
    const repoRoot = path.join(value.root, "app.asar");
    let received;
    const descriptor = value.create({
      executablePath,
      repoRoot,
      binaryResolvers: {
        antigravity: (options) => {
          received = options;
          throw Object.assign(new Error("missing"), { code: "ANTIGRAVITY_ACP_NOT_INSTALLED" });
        },
      },
    }).find((entry) => entry.runtimeAccountId === NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID);
    assert.equal(received.paths, value.paths, "the ACP server lives under Shoggoth's state directory");
    assert.equal(descriptor.binaryPath, null);
    assert.equal(descriptor.unavailableReason, "Antigravity ACP server is not installed; Sign in installs it");
    assert.deepEqual(descriptor.loginCommand, {
      executable: executablePath,
      args: [path.join(repoRoot, "app", "agent-service", "antigravity-acp-login.js"),
        "--account", NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    assert.ok(fs.existsSync(descriptor.loginCommand.args[0].replace(repoRoot, path.join(__dirname, ".."))),
      "the command points at a script that ships with the app");
    const other = value.create({ executablePath, repoRoot })
      .filter((entry) => entry.runtimeAccountId !== NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID);
    assert.ok(other.every((entry) => entry.loginCommand === undefined), "other runtimes keep their CLI login");
    assert.deepEqual(fs.readdirSync(value.paths.stateDir), before);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
