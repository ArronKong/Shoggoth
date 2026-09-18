#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const {
  LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID,
  RuntimeAccountResolver,
  runtimePathsOverlap,
  validateResolvedEnvironment,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account-resolver.js"));
const {
  prepareDeepSeekHarnessRuntimeAccountIntegration,
} = require(path.join(ROOT, "app", "agent-service", "deepseek-harness-runtime-paths.js"));
const {
  CodexRuntimeConfigWriter,
} = require(path.join(ROOT, "app", "agent-service", "codex-runtime-config.js"));
const {
  CODEX_VERSION,
} = require(path.join(ROOT, "app", "agent-service", "codex-schema-contract.js"));

const ACCOUNT_BY_RUNTIME = new Map(
  DEFAULT_RUNTIME_ACCOUNTS.filter((account) => account.kind === "native-user")
    .map((account) => [account.runtime, account]),
);
const INTERNAL_ACCOUNT = DEFAULT_RUNTIME_ACCOUNTS.find(
  (account) => account.id === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
);

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

function regularFile(target, text, mode = 0o600) {
  privateDirectory(path.dirname(target));
  fs.writeFileSync(target, text, { mode });
  fs.chmodSync(target, mode);
  return target;
}

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-account-resolver-")),
  );
  fs.chmodSync(root, 0o700);
  const home = privateDirectory(path.join(root, "home"));
  const userDataRoot = privateDirectory(path.join(root, "user-data"));
  const paths = resolveServicePaths({
    homeDir: home,
    userDataRoot,
    stateRoot: path.join(userDataRoot, "shoggoth-core"),
    profileRoot: path.join(userDataRoot, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  const binary = regularFile(path.join(root, "bin", "runtime"), "#!/bin/sh\nexit 0\n", 0o700);
  const bridge = regularFile(path.join(root, "bridge.mjs"), "export default {};\n");
  return { root, home, paths, binary, bridge };
}

function binding(runtime, runtimeProfileId, runtimeAccountId) {
  return { runtime, runtimeProfileId, runtimeAccountId };
}

function assertFrozenEnvironment(environment, expectedBinding) {
  assert.equal(validateResolvedEnvironment(environment, expectedBinding), environment);
  assert.equal(Object.isFrozen(environment), true);
  assert.equal(Object.isFrozen(environment.launchArgs), true);
  assert.equal(Object.isFrozen(environment.spawnEnv), true);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("Runtime authority overlap detects equal, ancestor, and descendant paths", () => {
  assert.equal(runtimePathsOverlap("/tmp/runtime-home", "/tmp/runtime-home"), true);
  assert.equal(runtimePathsOverlap("/tmp/runtime-home", "/tmp/runtime-home/child"), true);
  assert.equal(runtimePathsOverlap("/tmp/runtime-home/child", "/tmp/runtime-home"), true);
  assert.equal(runtimePathsOverlap("/tmp/runtime-home-a", "/tmp/runtime-home-b"), false);
});

test("native RuntimeAccounts reuse the real CLI Home across Profiles", () => {
  const current = fixture();
  try {
    const resolver = new RuntimeAccountResolver({
      paths: current.paths,
      homedir: current.home,
      parentEnv: {},
      repoRoot: ROOT,
    });
    const expectedHomes = {
      codex: path.join(current.home, ".codex"),
      "grok-build": path.join(current.home, ".grok"),
      antigravity: path.join(current.home, ".gemini"),
      pi: path.join(current.home, ".pi", "agent"),
      "claude-code": path.join(current.home, ".claude"),
      "deepseek-harness": path.join(current.home, ".dsh"),
    };
    for (const [runtime, account] of ACCOUNT_BY_RUNTIME) {
      const firstBinding = binding(runtime, "profile-one", account.id);
      const secondBinding = binding(runtime, "profile-two", account.id);
      const first = resolver.resolve(firstBinding, account, { binaryPath: current.binary });
      const second = resolver.resolve(secondBinding, account, { binaryPath: current.binary });
      assertFrozenEnvironment(first, firstBinding);
      assertFrozenEnvironment(second, secondBinding);
      assert.equal(first.home, second.home);
      assert.equal(first.binaryPath, current.binary);
      assert.equal(first.nativeHome, expectedHomes[runtime]);
      if (runtime === "antigravity") {
        assert.equal(first.home, path.join(
          current.paths.runtimeIntegrationDir,
          "antigravity",
          account.id,
          "home",
        ));
        assert.equal(first.strategy, "account-integration");
      } else {
        assert.equal(first.home, expectedHomes[runtime]);
      }
    }
    assert.equal(fs.existsSync(path.join(current.paths.stateDir, "grok-build", "profile-one")), false);
    assert.equal(fs.existsSync(path.join(current.paths.stateDir, "pi", "profile-one")), false);
    assert.equal(fs.existsSync(path.join(current.paths.stateDir, "claude-code", "profile-one")), false);
    assert.equal(fs.existsSync(path.join(current.home, ".gemini")), false);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("native Codex uses the installed CLI while managed Codex keeps its bundled runtime", () => {
  const current = fixture();
  try {
    const nativeRuntimePath = regularFile(
      path.join(current.root, "bin", "codex"),
      "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\n",
      0o700,
    );
    const resourcesPath = privateDirectory(path.join(current.root, "resources"));
    const packageRoot = privateDirectory(path.join(resourcesPath, "codex", "package"));
    const runtimePath = regularFile(
      path.join(packageRoot, "bin", "codex"),
      `#!/bin/sh\nprintf 'codex-cli ${CODEX_VERSION}\\n'\n`,
      0o700,
    );
    regularFile(path.join(packageRoot, "bin", "codex-code-mode-host"), "#!/bin/sh\nexit 0\n", 0o700);
    regularFile(path.join(packageRoot, "codex-package.json"), JSON.stringify({
      layoutVersion: 1,
      version: CODEX_VERSION,
      variant: "codex",
      entrypoint: "bin/codex",
    }));
    regularFile(path.join(resourcesPath, "codex", "runtime-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      runtime: { name: "codex", version: CODEX_VERSION },
      schema: { version: CODEX_VERSION, includeExperimental: false },
      platforms: { "darwin-arm64": {} },
    }));
    const resolver = new RuntimeAccountResolver({
      paths: current.paths,
      homedir: current.home,
      parentEnv: { PATH: path.dirname(nativeRuntimePath) },
      repoRoot: ROOT,
      packaged: true,
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
    });
    const account = ACCOUNT_BY_RUNTIME.get("codex");
    const currentBinding = binding("codex", "native-profile", account.id);
    const environment = resolver.resolve(currentBinding, account);

    assertFrozenEnvironment(environment, currentBinding);
    assert.equal(environment.binaryPath, nativeRuntimePath);
    assert.equal(environment.home, path.join(current.home, ".codex"));
    assert.equal(environment.nativeHome, environment.home);
    assert.equal(environment.spawnEnv.CODEX_HOME, environment.home);
    assert.equal(environment.strategy, "native");
    assert.equal(environment.installationKind, "system");

    const managed = resolver.resolve(binding("codex", "managed-profile", INTERNAL_ACCOUNT.id), INTERNAL_ACCOUNT);
    assert.equal(managed.binaryPath, runtimePath);
    assert.equal(managed.installationKind, "bundled");
    assert.equal(managed.strategy, "managed-shared");
    assert.notEqual(managed.home, environment.home);

    // A missing system CLI must not fall back to the still-available bundled one.
    const missing = new RuntimeAccountResolver({
      paths: current.paths,
      homedir: current.home,
      parentEnv: {},
      repoRoot: ROOT,
      packaged: true,
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
      fs: {
        ...fs,
        realpathSync(target, options) {
          if (!path.resolve(target).startsWith(current.root + path.sep)) {
            throw Object.assign(new Error("Missing fixture path"), { code: "ENOENT" });
          }
          return fs.realpathSync(target, options);
        },
      },
    });
    assert.throws(() => missing.resolve(currentBinding, account),
      (error) => error.code === "CODEX_SYSTEM_BINARY_NOT_FOUND");
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("managed Codex uses one account Home and never a caller Profile Home", () => {
  const current = fixture();
  try {
    const resolver = new RuntimeAccountResolver({
      paths: current.paths,
      homedir: current.home,
      parentEnv: {},
      repoRoot: ROOT,
    });
    const custom = {
      id: "managed-codex-imported-v1",
      runtime: "codex",
      kind: "shoggoth-managed",
      installationKind: "bundled",
      homeKind: "managed-shared",
      providerRef: null,
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
    };
    const firstBinding = binding("codex", "profile-one", custom.id);
    const secondBinding = binding("codex", "profile-two", custom.id);
    const first = resolver.resolve(firstBinding, custom);
    const second = resolver.resolve(secondBinding, custom);
    assertFrozenEnvironment(first, firstBinding);
    assert.equal(first.home, second.home);
    assert.equal(first.home, path.join(
      current.paths.runtimeAccountsDir,
      "codex",
      custom.id,
      "home",
    ));
    assert.equal(first.configurationMode, "overlay");
    assert.equal(fs.existsSync(path.join(current.paths.stateDir, "codex", "profile-one")), false);
    assert.equal(fs.existsSync(path.join(current.paths.stateDir, "codex", "profile-two")), false);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("native Codex and bundled Codex Homes cannot share an authority tree", () => {
  const current = fixture();
  try {
    const nativeAccount = ACCOUNT_BY_RUNTIME.get("codex");
    const managedHomes = [
      path.join(
        current.paths.stateDir,
        "codex",
        LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID,
      ),
      path.join(
        current.paths.runtimeAccountsDir,
        "codex",
        INTERNAL_ACCOUNT.id,
        "home",
      ),
    ];
    for (const managedHome of managedHomes) {
      for (const nativeHome of [managedHome, path.dirname(managedHome), path.join(managedHome, "native")]) {
        const resolver = new RuntimeAccountResolver({
          paths: current.paths,
          homedir: current.home,
          parentEnv: { CODEX_HOME: nativeHome },
          repoRoot: ROOT,
        });
        assert.throws(
          () => resolver.resolve(
            binding("codex", "native-profile", nativeAccount.id),
            nativeAccount,
            { binaryPath: current.binary },
          ),
          (error) => error.code === "RUNTIME_ACCOUNT_HOME_CONFLICT",
        );
        assert.throws(
          () => resolver.resolve(
            binding("codex", "managed-profile", INTERNAL_ACCOUNT.id),
            INTERNAL_ACCOUNT,
          ),
          (error) => error.code === "RUNTIME_ACCOUNT_HOME_CONFLICT",
        );
      }
    }
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("native integration Homes cannot overlap Antigravity or DeepSeek account integration", () => {
  const current = fixture();
  try {
    const deepSeekAccount = ACCOUNT_BY_RUNTIME.get("deepseek-harness");
    const deepSeekIntegration = path.join(
      current.paths.runtimeIntegrationDir,
      "deepseek-harness",
      deepSeekAccount.id,
    );
    for (const nativeHome of [
      deepSeekIntegration,
      path.dirname(deepSeekIntegration),
      path.join(deepSeekIntegration, "native"),
    ]) {
      const resolver = new RuntimeAccountResolver({
        paths: current.paths,
        homedir: current.home,
        parentEnv: { DSH_HOME: nativeHome },
        repoRoot: ROOT,
      });
      assert.throws(
        () => resolver.resolve(
          binding("deepseek-harness", "dsh-profile", deepSeekAccount.id),
          deepSeekAccount,
          { binaryPath: current.binary },
        ),
        (error) => error.code === "RUNTIME_ACCOUNT_HOME_CONFLICT",
      );
    }

    const antigravityAccount = ACCOUNT_BY_RUNTIME.get("antigravity");
    const nestedNativeHome = privateDirectory(path.join(
      current.paths.runtimeIntegrationDir,
      "antigravity",
      antigravityAccount.id,
    ));
    let resolver = new RuntimeAccountResolver({
      paths: current.paths,
      homedir: nestedNativeHome,
      parentEnv: {},
      repoRoot: ROOT,
    });
    assert.throws(
      () => resolver.resolve(
        binding("antigravity", "antigravity-profile", antigravityAccount.id),
        antigravityAccount,
        { binaryPath: current.binary },
      ),
      (error) => error.code === "RUNTIME_ACCOUNT_HOME_CONFLICT",
    );

    const antigravityNativeRoot = privateDirectory(path.join(current.home, ".gemini"));
    const nestedPaths = resolveServicePaths({
      homeDir: current.home,
      userDataRoot: current.paths.userDataRoot,
      stateRoot: path.join(antigravityNativeRoot, "shoggoth-state"),
      profileRoot: current.paths.profileDir,
      cacheRoot: current.paths.cacheDir,
      trustedRoot: current.root,
    });
    resolver = new RuntimeAccountResolver({
      paths: nestedPaths,
      homedir: current.home,
      parentEnv: {},
      repoRoot: ROOT,
    });
    assert.throws(
      () => resolver.resolve(
        binding("antigravity", "antigravity-profile", antigravityAccount.id),
        antigravityAccount,
        { binaryPath: current.binary },
      ),
      (error) => error.code === "RUNTIME_ACCOUNT_HOME_CONFLICT",
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("default bundled Codex reuses the exact legacy Shoggoth Home", () => {
  const current = fixture();
  try {
    assert.equal(
      LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID,
      "shoggoth-f8a76c25-bd49-4c12-9d63-7b7d1eb1d0a4",
    );
    const legacyHome = privateDirectory(path.join(
      current.paths.stateDir,
      "codex",
      LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID,
    ));
    const resolver = new RuntimeAccountResolver({
      paths: current.paths,
      homedir: current.home,
      parentEnv: {},
      repoRoot: ROOT,
    });
    const runtimeBinding = binding(
      "codex",
      "another-profile",
      INTERNAL_ACCOUNT.id,
    );
    const environment = resolver.resolve(runtimeBinding, INTERNAL_ACCOUNT);
    assertFrozenEnvironment(environment, runtimeBinding);
    assert.equal(environment.home, legacyHome);
    assert.equal(environment.strategy, "managed-shared");
    assert.equal(fs.existsSync(path.join(
      current.paths.runtimeAccountsDir,
      "codex",
      INTERNAL_ACCOUNT.id,
      "home",
    )), false);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("resolver validates the looked-up account and binding match", () => {
  const current = fixture();
  try {
    const resolver = new RuntimeAccountResolver({
      paths: current.paths,
      homedir: current.home,
      parentEnv: {},
      repoRoot: ROOT,
    });
    const codex = ACCOUNT_BY_RUNTIME.get("codex");
    const grok = ACCOUNT_BY_RUNTIME.get("grok-build");
    assert.throws(
      () => resolver.resolve(binding("codex", "profile", codex.id), grok, {
        binaryPath: current.binary,
      }),
      (error) => error.code === "RUNTIME_ACCOUNT_BINDING_MISMATCH",
    );
    assert.throws(
      () => resolver.resolve(binding("codex", "profile", codex.id), null, {
        binaryPath: current.binary,
      }),
      (error) => error.code === "RUNTIME_ACCOUNT_NOT_FOUND",
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("resolved Runtime environments reject legacy persistent Profile-Home mode", () => {
  const current = fixture();
  try {
    const account = ACCOUNT_BY_RUNTIME.get("codex");
    const currentBinding = binding("codex", "profile", account.id);
    const resolver = new RuntimeAccountResolver({
      paths: current.paths,
      homedir: current.home,
      parentEnv: {},
      repoRoot: ROOT,
    });
    const environment = resolver.resolve(currentBinding, account, { binaryPath: current.binary });
    assert.throws(
      () => validateResolvedEnvironment(Object.freeze({
        ...environment,
        configurationMode: "persistent",
      }), currentBinding),
      (error) => error.code === "RUNTIME_ACCOUNT_ENVIRONMENT_INVALID",
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("Codex per-Profile configuration is a process overlay, not a shared-Home write", () => {
  const current = fixture();
  try {
    const writer = new CodexRuntimeConfigWriter({
      paths: current.paths,
      mcpHelperLaunch: { command: current.binary, argsPrefix: [] },
    });
    const result = writer.overlay({
      runtimeProfileId: "profile-overlay",
      runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      runtimeConfig: null,
    });
    assert.equal(Object.isFrozen(result.args), true);
    assert.equal(result.args.length % 2, 0);
    for (let index = 0; index < result.args.length; index += 2) {
      assert.equal(result.args[index], "-c");
    }
    assert.equal(
      result.args.some((value) => value.includes("--shoggoth-runtime-profile=profile-overlay")),
      true,
    );
    assert.equal(fs.existsSync(path.join(current.paths.stateDir, "codex")), false);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("DeepSeek Harness integration is account-shared and occupied roots fail closed", () => {
  const current = fixture();
  try {
    const accountId = ACCOUNT_BY_RUNTIME.get("deepseek-harness").id;
    const first = prepareDeepSeekHarnessRuntimeAccountIntegration(
      current.paths,
      accountId,
      { bridgePath: current.bridge },
    );
    const second = prepareDeepSeekHarnessRuntimeAccountIntegration(
      current.paths,
      accountId,
      { bridgePath: current.bridge },
    );
    assert.deepEqual(first, second);
    assert.equal(first.profile, "headless");
    assert.equal(fs.readFileSync(first.patchPath, "utf8").includes("shoggoth-runtime-bridge"), true);

    const conflictId = "native-deepseek-conflict-v1";
    const conflictRoot = privateDirectory(path.join(
      current.paths.runtimeIntegrationDir,
      "deepseek-harness",
      conflictId,
    ));
    regularFile(path.join(conflictRoot, "foreign.txt"), "foreign\n");
    assert.throws(
      () => prepareDeepSeekHarnessRuntimeAccountIntegration(
        current.paths,
        conflictId,
        { bridgePath: current.bridge },
      ),
      (error) => error.code === "DEEPSEEK_HARNESS_INTEGRATION_CONFLICT",
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS runtime account resolver (${tests.length})`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
