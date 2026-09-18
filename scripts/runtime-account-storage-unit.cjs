#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { LegacyRuntimeHomeStore, legacyHomeId } = require(path.join(
  ROOT,
  "app",
  "agent-service",
  "legacy-runtime-home-store.js",
));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const {
  LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account-resolver.js"));
const { RuntimeStorageCleanup } = require(path.join(
  ROOT,
  "app",
  "agent-service",
  "runtime-storage-cleanup.js",
));
const { inspectRuntimeStorage } = require(path.join(
  ROOT,
  "app",
  "agent-service",
  "runtime-storage-inspector.js",
));

const tests = [];
const roots = [];
function test(name, action) { tests.push({ name, action }); }

const cleanupReady = async () => ({ serviceReady: true, cleanupEligible: true });

function fixture(options = {}) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    "shoggoth-runtime-storage-",
  )));
  roots.push(tempRoot);
  const paths = resolveServicePaths({
    stateRoot: path.join(tempRoot, "state"),
    cacheRoot: path.join(tempRoot, "cache"),
  });
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.stateDir, 0o700);
  let now = options.now ?? 1_000;
  return {
    root: tempRoot,
    paths,
    now: () => now,
    advance(milliseconds) { now += milliseconds; },
  };
}

function account(id) {
  const selected = DEFAULT_RUNTIME_ACCOUNTS.find((candidate) => candidate.id === id);
  assert.ok(selected, `missing RuntimeAccount fixture ${id}`);
  return selected;
}

function managedAccount(id) {
  return {
    id,
    runtime: "codex",
    kind: "shoggoth-managed",
    installationKind: "bundled",
    homeKind: "managed-shared",
    providerRef: null,
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function profile(id, runtime, runtimeProfileId, runtimeAccountId, isDefault = false) {
  return { id, runtime, runtimeProfileId, runtimeAccountId, isDefault };
}

function makeHome(paths, runtime, runtimeProfileId, files = {}) {
  const home = path.join(paths.stateDir, runtime, runtimeProfileId);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [relative, value] of Object.entries(files)) {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, value, { mode: 0o600 });
  }
  return home;
}

function v7ManagedAccountId(profileId, runtime = "codex") {
  const digest = crypto.createHash("sha256")
    .update("shoggoth-runtime-account-legacy-profile-v1\0", "utf8")
    .update(JSON.stringify([profileId, runtime]), "utf8")
    .digest("hex");
  return `legacy-managed-${digest}-v1`;
}

function inventoryFixture(options = {}) {
  const ctx = fixture(options);
  const nativeSystemHome = path.join(ctx.root, "native-user-home", ".grok");
  fs.mkdirSync(nativeSystemHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(nativeSystemHome, "native-session.json"), "native", { mode: 0o600 });
  const canonical = makeHome(ctx.paths, "codex", LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID, {
    "auth.json": "auth",
  });
  const reclaimable = makeHome(ctx.paths, "codex", "managed-secondary", {
    "cache/data.bin": "duplicate-cache",
  });
  const nativeLegacy = makeHome(ctx.paths, "grok-build", "old-grok-profile", {
    "Library/pnpm/store/pkg": "old-package",
  });
  const profiles = [
    profile(
      "agent-default",
      "codex",
      LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID,
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      true,
    ),
    profile(
      "agent-secondary",
      "codex",
      "managed-secondary",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ),
    profile(
      "agent-grok",
      "grok-build",
      "old-grok-profile",
      NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
    ),
  ];
  const accounts = [
    account(SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID),
    account(NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID),
  ];
  const store = new LegacyRuntimeHomeStore({
    paths: ctx.paths,
    now: ctx.now,
    scanLimits: options.scanLimits,
  });
  const inventory = () => store.refresh({ profiles, accounts });
  return {
    ...ctx,
    accounts,
    canonical,
    inventory,
    nativeLegacy,
    nativeSystemHome,
    profiles,
    reclaimable,
    store,
  };
}

test("bounded inspector counts files and symlinks without following them", () => {
  const ctx = fixture();
  const home = makeHome(ctx.paths, "codex", "scan-home", {
    "one.txt": "1234",
    "nested/two.txt": "56",
  });
  const victim = path.join(ctx.root, "outside-victim.txt");
  fs.writeFileSync(victim, "do-not-count-or-touch", { mode: 0o600 });
  fs.symlinkSync(victim, path.join(home, "nested", "outside-link"));

  const inspected = inspectRuntimeStorage(home, { trustedRoot: ctx.paths.stateDir });
  assert.deepEqual(
    {
      files: inspected.files,
      dirs: inspected.dirs,
      symlinks: inspected.symlinks,
      incomplete: inspected.incomplete,
    },
    { files: 2, dirs: 2, symlinks: 1, incomplete: false },
  );
  assert.equal(inspected.bytes, 6 + Buffer.byteLength(victim));
  assert.equal(fs.readFileSync(victim, "utf8"), "do-not-count-or-touch");

  const bounded = inspectRuntimeStorage(home, {
    trustedRoot: ctx.paths.stateDir,
    maxEntries: 2,
  });
  assert.equal(bounded.incomplete, true);
  assert.equal(bounded.limitReason, "entries");
  const byteBounded = inspectRuntimeStorage(home, {
    trustedRoot: ctx.paths.stateDir,
    maxBytes: 1,
  });
  assert.equal(byteBounded.incomplete, true);
  assert.equal(byteBounded.limitReason, "bytes");
});

test("inspector rejects a symlink or non-canonical root", () => {
  const ctx = fixture();
  const home = makeHome(ctx.paths, "codex", "real-home");
  const alias = path.join(ctx.paths.stateDir, "codex", "home-alias");
  fs.symlinkSync(home, alias);
  assert.throws(
    () => inspectRuntimeStorage(alias, { trustedRoot: ctx.paths.stateDir }),
    (error) => error.code === "RUNTIME_STORAGE_ROOT_INVALID",
  );
});

test("read-only IPC scanning counts payloads while strict cleanup scanning rejects sockets", () => {
  const ctx = fixture();
  const home = makeHome(ctx.paths, "codex", "live-home", { "data.bin": "data", "ipc": "" });
  const socketPath = path.join(home, "ipc");
  const fileSystem = Object.create(fs);
  fileSystem.lstatSync = (target) => {
    const stat = fs.lstatSync(target);
    if (target === socketPath) {
      stat.isFile = () => false;
      stat.isSocket = () => true;
    }
    return stat;
  };
  const options = { fs: fileSystem, trustedRoot: ctx.paths.stateDir };
  assert.throws(() => inspectRuntimeStorage(home, options), {
    code: "RUNTIME_STORAGE_ENTRY_TYPE_INVALID",
  });
  const stats = inspectRuntimeStorage(home, { ...options, ignoreIpcEntries: true });
  assert.equal(stats.bytes, 4);
  assert.equal(stats.files, 1);
  assert.equal(stats.entries, 3);
  assert.equal(stats.incomplete, false);
  assert.equal(fs.existsSync(socketPath), true);
});

test("legacy manifest chooses one managed canonical and excludes native system Home", () => {
  const ctx = inventoryFixture();
  const manifest = ctx.inventory();
  assert.equal(manifest.entries.length, 3);
  assert.deepEqual(
    manifest.entries.map((entry) => [entry.runtimeProfileId, entry.accountKind, entry.role]),
    [
      ["managed-secondary", "shoggoth-managed", "reclaimable"],
      [LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID, "shoggoth-managed", "canonical"],
      ["old-grok-profile", "native-user", "reclaimable"],
    ],
  );
  assert.equal(
    manifest.entries.filter((entry) => (
      entry.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
        && entry.role === "canonical"
    )).length,
    1,
  );
  assert.equal(manifest.entries.some((entry) => entry.path === ctx.nativeSystemHome), false);
  assert.deepEqual(ctx.store.read(), manifest);
  assert.equal(fs.statSync(ctx.paths.legacyRuntimeHomesPath).mode & 0o777, 0o600);
});

test("native CLI env Home 与 legacy 路径碰撞时 inventory、prepare、commit 均 fail closed", async () => {
  const ctx = fixture();
  const runtimeProfileId = "native-grok-collision";
  const legacyPath = makeHome(ctx.paths, "grok-build", runtimeProfileId, {
    "session.json": "must-survive",
  });
  const alternateHome = path.join(ctx.root, "native-grok-home");
  fs.mkdirSync(alternateHome, { recursive: true, mode: 0o700 });
  const nestedNativeHome = path.join(legacyPath, "native-home");
  fs.mkdirSync(nestedNativeHome, { mode: 0o700 });
  const parentEnv = { GROK_HOME: legacyPath };
  const profiles = [profile(
    "agent-native-grok-collision",
    "grok-build",
    runtimeProfileId,
    NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  )];
  const accounts = [account(NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID)];
  const store = new LegacyRuntimeHomeStore({
    paths: ctx.paths,
    now: ctx.now,
    parentEnv,
    homedir: ctx.root,
  });
  const inventory = () => store.refresh({ profiles, accounts });
  const entryId = legacyHomeId(
    "grok-build",
    runtimeProfileId,
    NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  );
  for (const overlappingHome of [
    legacyPath,
    path.dirname(legacyPath),
    nestedNativeHome,
  ]) {
    parentEnv.GROK_HOME = overlappingHome;
    assert.deepEqual(inventory().entries, []);
  }
  parentEnv.GROK_HOME = legacyPath;

  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory,
    readCleanupState: cleanupReady,
    isInUse: () => false,
    now: ctx.now,
  });
  await assert.rejects(
    cleanup.prepare({ entryId }),
    (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_NOT_RECLAIMABLE",
  );

  parentEnv.GROK_HOME = alternateHome;
  const plan = await cleanup.prepare({ entryId });
  parentEnv.GROK_HOME = legacyPath;
  await assert.rejects(
    cleanup.commit({ planId: plan.planId }),
    (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_NOT_RECLAIMABLE",
  );
  assert.equal(fs.readFileSync(path.join(legacyPath, "session.json"), "utf8"), "must-survive");
});

test("legacy manifest allows zero canonical Homes when the internal default legacy Home is absent", () => {
  const ctx = inventoryFixture();
  fs.rmSync(ctx.canonical, { recursive: true });

  const manifest = ctx.inventory();
  assert.deepEqual(
    manifest.entries.map((entry) => [entry.runtimeProfileId, entry.role]),
    [
      ["managed-secondary", "reclaimable"],
      ["old-grok-profile", "reclaimable"],
    ],
  );
});

test("legacy manifest never treats a non-internal managed account Home as canonical", () => {
  const ctx = fixture();
  const runtimeAccountId = "legacy-managed-reviewer-v1";
  const runtimeProfileId = "managed-reviewer";
  makeHome(ctx.paths, "codex", runtimeProfileId, { "cache/data.bin": "legacy" });
  fs.mkdirSync(
    path.join(ctx.paths.runtimeAccountsDir, "codex", runtimeAccountId, "home"),
    { recursive: true, mode: 0o700 },
  );
  const store = new LegacyRuntimeHomeStore({ paths: ctx.paths, now: ctx.now });

  const manifest = store.refresh({
    profiles: [profile("agent-reviewer", "codex", runtimeProfileId, runtimeAccountId)],
    accounts: [managedAccount(runtimeAccountId)],
  });
  assert.deepEqual(
    manifest.entries.map((entry) => [entry.runtimeAccountId, entry.runtimeProfileId, entry.role]),
    [[runtimeAccountId, runtimeProfileId, "reclaimable"]],
  );
});

test("v7 derived account Home is visible and cleanup rechecks in-use and drift", async () => {
  const ctx = fixture();
  const profileId = "agent-v7-reviewer";
  const runtimeProfileId = "runtime-v7-reviewer";
  const legacyAccountId = v7ManagedAccountId(profileId);
  const legacyAccountHome = path.join(
    ctx.paths.runtimeAccountsDir,
    "codex",
    legacyAccountId,
    "home",
  );
  fs.mkdirSync(legacyAccountHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacyAccountHome, "auth.json"), "legacy", { mode: 0o600 });
  const unrelatedAccountHome = path.join(
    ctx.paths.runtimeAccountsDir,
    "codex",
    `legacy-managed-${"f".repeat(64)}-v1`,
    "home",
  );
  fs.mkdirSync(unrelatedAccountHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(unrelatedAccountHome, "keep.txt"), "keep", { mode: 0o600 });
  const currentAccountHome = path.join(
    ctx.paths.runtimeAccountsDir,
    "codex",
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    "home",
  );
  fs.mkdirSync(currentAccountHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(currentAccountHome, "keep.txt"), "current", { mode: 0o600 });
  const profiles = [profile(
    profileId,
    "codex",
    runtimeProfileId,
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  )];
  const accounts = [account(SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID)];
  const store = new LegacyRuntimeHomeStore({ paths: ctx.paths, now: ctx.now });
  const inventory = () => store.refresh({ profiles, accounts });

  const manifest = inventory();
  assert.deepEqual(manifest.entries.map((entry) => ({
    runtimeProfileId: entry.runtimeProfileId,
    runtimeAccountId: entry.runtimeAccountId,
    accountKind: entry.accountKind,
    profileIds: entry.profileIds,
    role: entry.role,
    path: entry.path,
  })), [{
    runtimeProfileId: legacyAccountId,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    accountKind: "shoggoth-managed",
    profileIds: [profileId],
    role: "reclaimable",
    path: legacyAccountHome,
  }]);

  let inUse = true;
  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory,
    readCleanupState: cleanupReady,
    isInUse: () => inUse,
    now: ctx.now,
  });
  await assert.rejects(
    cleanup.prepare({ entryId: manifest.entries[0].id }),
    (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_IN_USE",
  );
  inUse = false;
  let plan = await cleanup.prepare({ entryId: manifest.entries[0].id });
  fs.writeFileSync(path.join(legacyAccountHome, "drift.txt"), "changed", { mode: 0o600 });
  await assert.rejects(
    cleanup.commit({ planId: plan.planId }),
    (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_CHANGED",
  );
  plan = await cleanup.prepare({ entryId: manifest.entries[0].id });
  await cleanup.commit({ planId: plan.planId });

  assert.equal(fs.existsSync(legacyAccountHome), false);
  assert.equal(fs.readFileSync(path.join(unrelatedAccountHome, "keep.txt"), "utf8"), "keep");
  assert.equal(fs.readFileSync(path.join(currentAccountHome, "keep.txt"), "utf8"), "current");
});

test("v7 account Home discovery rejects an exact derived symlink", () => {
  const ctx = fixture();
  const profileId = "agent-v7-linked";
  const legacyAccountId = v7ManagedAccountId(profileId);
  const victim = path.join(ctx.root, "outside-victim");
  fs.mkdirSync(victim, { mode: 0o700 });
  const legacyAccountHome = path.join(
    ctx.paths.runtimeAccountsDir,
    "codex",
    legacyAccountId,
    "home",
  );
  fs.mkdirSync(path.dirname(legacyAccountHome), { recursive: true, mode: 0o700 });
  fs.symlinkSync(victim, legacyAccountHome);
  const store = new LegacyRuntimeHomeStore({ paths: ctx.paths, now: ctx.now });

  assert.throws(
    () => store.refresh({
      profiles: [profile(
        profileId,
        "codex",
        "runtime-v7-linked",
        SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      )],
      accounts: [account(SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID)],
    }),
    (error) => error.code === "LEGACY_RUNTIME_HOME_PATH_UNSAFE",
  );
  assert.equal(fs.existsSync(victim), true);
});

test("v7 discovery never inventories a derived Home for a native Codex account", () => {
  const ctx = fixture();
  const profileId = "agent-native-codex";
  const legacyAccountId = v7ManagedAccountId(profileId);
  const legacyAccountHome = path.join(
    ctx.paths.runtimeAccountsDir,
    "codex",
    legacyAccountId,
    "home",
  );
  fs.mkdirSync(legacyAccountHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacyAccountHome, "keep.txt"), "managed-looking", { mode: 0o600 });
  const nativeHome = path.join(ctx.root, "native-user-home", ".codex");
  fs.mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(nativeHome, "keep.txt"), "native", { mode: 0o600 });
  const store = new LegacyRuntimeHomeStore({ paths: ctx.paths, now: ctx.now });

  const manifest = store.refresh({
    profiles: [profile(
      profileId,
      "codex",
      "runtime-native-codex",
      NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    )],
    accounts: [account(NATIVE_CODEX_RUNTIME_ACCOUNT_ID)],
  });
  assert.deepEqual(manifest.entries, []);
  assert.equal(fs.readFileSync(path.join(legacyAccountHome, "keep.txt"), "utf8"), "managed-looking");
  assert.equal(fs.readFileSync(path.join(nativeHome, "keep.txt"), "utf8"), "native");
});

test("cleanup rejects arbitrary derived-looking and current account Homes", async () => {
  const ctx = fixture();
  const profileId = "agent-v7-forgery";
  const arbitraryId = `legacy-managed-${"e".repeat(64)}-v1`;
  const currentDerivedId = v7ManagedAccountId(profileId);
  const targets = [
    {
      runtimeProfileId: arbitraryId,
      runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      path: path.join(ctx.paths.runtimeAccountsDir, "codex", arbitraryId, "home"),
    },
    {
      runtimeProfileId: currentDerivedId,
      runtimeAccountId: currentDerivedId,
      path: path.join(ctx.paths.runtimeAccountsDir, "codex", currentDerivedId, "home"),
    },
    {
      runtimeProfileId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      path: path.join(
        ctx.paths.runtimeAccountsDir,
        "codex",
        SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        "home",
      ),
    },
  ];
  for (const target of targets) {
    fs.mkdirSync(target.path, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(target.path, "keep.txt"), "keep", { mode: 0o600 });
    const entry = {
      id: legacyHomeId(
        "codex",
        target.runtimeProfileId,
        target.runtimeAccountId,
      ),
      runtime: "codex",
      runtimeProfileId: target.runtimeProfileId,
      runtimeAccountId: target.runtimeAccountId,
      accountKind: "shoggoth-managed",
      profileIds: [profileId],
      role: "reclaimable",
      path: target.path,
    };
    const cleanup = new RuntimeStorageCleanup({
      paths: ctx.paths,
      inventory: () => ({ entries: [entry] }),
      readCleanupState: cleanupReady,
      isInUse: () => false,
      now: ctx.now,
    });
    await assert.rejects(
      cleanup.prepare({ entryId: entry.id }),
      (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_OUTSIDE_LEGACY_ROOTS",
    );
    assert.equal(fs.readFileSync(path.join(target.path, "keep.txt"), "utf8"), "keep");
  }
});

test("legacy discovery fails closed on a symlink candidate", () => {
  const ctx = fixture();
  const victim = path.join(ctx.root, "native-home");
  fs.mkdirSync(victim, { mode: 0o700 });
  const linked = path.join(ctx.paths.stateDir, "grok-build", "linked-profile");
  fs.mkdirSync(path.dirname(linked), { recursive: true, mode: 0o700 });
  fs.symlinkSync(victim, linked);
  const store = new LegacyRuntimeHomeStore({ paths: ctx.paths, now: ctx.now });
  assert.throws(
    () => store.refresh({
      profiles: [profile(
        "agent-linked",
        "grok-build",
        "linked-profile",
        NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
      )],
      accounts: [account(NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID)],
    }),
    (error) => error.code === "LEGACY_RUNTIME_HOME_PATH_UNSAFE",
  );
  assert.equal(fs.existsSync(victim), true);
});

test("cleanup uses an opaque one-shot plan, preserves canonical/native Home, and audits", async () => {
  const ctx = inventoryFixture();
  const victim = path.join(ctx.root, "symlink-victim");
  fs.mkdirSync(victim, { mode: 0o700 });
  fs.writeFileSync(path.join(victim, "keep.txt"), "keep", { mode: 0o600 });
  fs.symlinkSync(victim, path.join(ctx.reclaimable, "outside-link"));
  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory: ctx.inventory,
    readCleanupState: cleanupReady,
    isInUse: () => false,
    now: ctx.now,
  });
  const entryId = legacyHomeId(
    "codex",
    "managed-secondary",
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  );
  await assert.rejects(
    cleanup.prepare({ entryId, path: ctx.reclaimable }),
    (error) => error.code === "RUNTIME_STORAGE_PREPARE_INVALID",
  );
  const plan = await cleanup.prepare({ entryId });
  assert.match(plan.planId, /^[a-f0-9]{64}$/u);
  assert.equal(plan.planId.includes("managed-secondary"), false);
  await assert.rejects(
    cleanup.commit({ planId: plan.planId, path: ctx.reclaimable }),
    (error) => error.code === "RUNTIME_STORAGE_COMMIT_INVALID",
  );
  const result = await cleanup.commit({ planId: plan.planId });
  assert.equal(result.entryId, entryId);
  assert.equal(fs.existsSync(ctx.reclaimable), false);
  assert.equal(fs.existsSync(ctx.canonical), true);
  assert.equal(fs.existsSync(ctx.nativeSystemHome), true);
  assert.equal(fs.readFileSync(path.join(victim, "keep.txt"), "utf8"), "keep");
  const auditLines = fs.readFileSync(ctx.paths.runtimeCleanupAuditPath, "utf8").trim().split("\n");
  assert.equal(JSON.parse(auditLines.at(-1)).status, "deleted");
  assert.equal(ctx.store.read().entries.some((entry) => entry.id === entryId), false);
  await assert.rejects(
    cleanup.commit({ planId: plan.planId }),
    (error) => error.code === "RUNTIME_STORAGE_PLAN_NOT_FOUND",
  );
});

test("commit rechecks in-use state and consumes the blocked plan", async () => {
  const ctx = inventoryFixture();
  let checks = 0;
  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory: ctx.inventory,
    readCleanupState: cleanupReady,
    isInUse() {
      checks += 1;
      return checks === 1 ? false : { activeHost: true };
    },
    now: ctx.now,
  });
  const entryId = legacyHomeId(
    "codex",
    "managed-secondary",
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  );
  const plan = await cleanup.prepare({ entryId });
  await assert.rejects(
    cleanup.commit({ planId: plan.planId }),
    (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_IN_USE"
      && error.reasons.includes("active-host"),
  );
  assert.equal(fs.existsSync(ctx.reclaimable), true);
  await assert.rejects(
    cleanup.commit({ planId: plan.planId }),
    (error) => error.code === "RUNTIME_STORAGE_PLAN_NOT_FOUND",
  );
});

test("persistent session lineage reasons block cleanup at prepare and are rechecked at commit", async () => {
  const ctx = inventoryFixture();
  let reasons = ["legacy-session-lineage-unavailable"];
  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory: ctx.inventory,
    readCleanupState: cleanupReady,
    isInUse: () => ({ reasons }),
    now: ctx.now,
  });
  const entryId = legacyHomeId(
    "codex",
    "managed-secondary",
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  );
  await assert.rejects(
    cleanup.prepare({ entryId }),
    (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_IN_USE"
      && error.reasons.includes("legacy-session-lineage-unavailable"),
  );

  reasons = [];
  const plan = await cleanup.prepare({ entryId });
  reasons = ["persistent-chat-session"];
  await assert.rejects(
    cleanup.commit({ planId: plan.planId }),
    (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_IN_USE"
      && error.reasons.includes("persistent-chat-session"),
  );
  assert.equal(fs.existsSync(ctx.reclaimable), true);
});

test("expired plan cannot delete anything", async () => {
  const ctx = inventoryFixture();
  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory: ctx.inventory,
    readCleanupState: cleanupReady,
    isInUse: () => false,
    now: ctx.now,
    planTtlMs: 10,
  });
  const plan = await cleanup.prepare({
    entryId: legacyHomeId(
      "codex",
      "managed-secondary",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ),
  });
  ctx.advance(11);
  await assert.rejects(
    cleanup.commit({ planId: plan.planId }),
    (error) => error.code === "RUNTIME_STORAGE_PLAN_EXPIRED",
  );
  assert.equal(fs.existsSync(ctx.reclaimable), true);
});

test("cleanup rechecks Service and migration readiness at prepare and commit", async () => {
  const ctx = inventoryFixture();
  let ready = false;
  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory: ctx.inventory,
    readCleanupState: async () => ({ serviceReady: ready, cleanupEligible: ready }),
    isInUse: () => false,
    now: ctx.now,
  });
  const entryId = legacyHomeId(
    "codex",
    "managed-secondary",
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  );
  await assert.rejects(
    cleanup.prepare({ entryId }),
    (error) => error.code === "RUNTIME_STORAGE_CLEANUP_NOT_READY",
  );
  ready = true;
  const plan = await cleanup.prepare({ entryId });
  ready = false;
  await assert.rejects(
    cleanup.commit({ planId: plan.planId }),
    (error) => error.code === "RUNTIME_STORAGE_CLEANUP_NOT_READY",
  );
  assert.equal(fs.existsSync(ctx.reclaimable), true);
});

test("commit rejects content drift after prepare", async () => {
  const ctx = inventoryFixture();
  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory: ctx.inventory,
    readCleanupState: cleanupReady,
    isInUse: () => false,
    now: ctx.now,
  });
  const plan = await cleanup.prepare({
    entryId: legacyHomeId(
      "codex",
      "managed-secondary",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ),
  });
  fs.writeFileSync(path.join(ctx.reclaimable, "added-after-confirmation"), "changed", {
    mode: 0o600,
  });
  await assert.rejects(
    cleanup.commit({ planId: plan.planId }),
    (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_CHANGED",
  );
  assert.equal(fs.existsSync(ctx.reclaimable), true);
});

test("TOCTOU symlink swap is rejected before rename and never touches its victim", async () => {
  const ctx = inventoryFixture();
  const victim = path.join(ctx.root, "native-victim");
  fs.mkdirSync(victim, { mode: 0o700 });
  fs.writeFileSync(path.join(victim, "keep.txt"), "untouched", { mode: 0o600 });
  let checks = 0;
  const moved = `${ctx.reclaimable}-moved`;
  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory: ctx.inventory,
    readCleanupState: cleanupReady,
    isInUse() {
      checks += 1;
      if (checks === 2) {
        fs.renameSync(ctx.reclaimable, moved);
        fs.symlinkSync(victim, ctx.reclaimable);
      }
      return false;
    },
    now: ctx.now,
  });
  const plan = await cleanup.prepare({
    entryId: legacyHomeId(
      "codex",
      "managed-secondary",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ),
  });
  await assert.rejects(
    cleanup.commit({ planId: plan.planId }),
    (error) => error.code === "RUNTIME_STORAGE_ROOT_INVALID",
  );
  assert.equal(fs.readFileSync(path.join(victim, "keep.txt"), "utf8"), "untouched");
  assert.equal(fs.lstatSync(ctx.reclaimable).isSymbolicLink(), true);
});

test("cleanup rejects native system paths even from a forged inventory", async () => {
  const ctx = fixture();
  const nativeHome = path.join(ctx.root, "real-user-home", ".grok");
  fs.mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
  const runtimeProfileId = "forged-native";
  const runtimeAccountId = NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID;
  const entryId = legacyHomeId("grok-build", runtimeProfileId, runtimeAccountId);
  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory: () => ({
      entries: [{
        id: entryId,
        runtime: "grok-build",
        runtimeProfileId,
        runtimeAccountId,
        role: "reclaimable",
        path: nativeHome,
        profileIds: ["agent-grok"],
      }],
    }),
    readCleanupState: cleanupReady,
    isInUse: () => false,
    now: ctx.now,
  });
  await assert.rejects(
    cleanup.prepare({ entryId }),
    (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_OUTSIDE_LEGACY_ROOTS",
  );
  assert.equal(fs.existsSync(nativeHome), true);
});

test("cleanup refuses an incomplete bounded size scan", async () => {
  const ctx = inventoryFixture({ scanLimits: { maxEntries: 1 } });
  const cleanup = new RuntimeStorageCleanup({
    paths: ctx.paths,
    inventory: ctx.inventory,
    readCleanupState: cleanupReady,
    isInUse: () => false,
    now: ctx.now,
    scanLimits: { maxEntries: 1 },
  });
  await assert.rejects(
    cleanup.prepare({
      entryId: legacyHomeId(
        "codex",
        "managed-secondary",
        SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      ),
    }),
    (error) => error.code === "RUNTIME_STORAGE_SCAN_INCOMPLETE",
  );
  assert.equal(fs.existsSync(ctx.reclaimable), true);
});

(async () => {
  let passed = 0;
  try {
    for (const { name, action } of tests) {
      try {
        await action();
        passed += 1;
        process.stdout.write(`ok - ${name}\n`);
      } catch (error) {
        process.stderr.write(`not ok - ${name}\n${error.stack || error}\n`);
        process.exitCode = 1;
      }
    }
  } finally {
    for (const root of roots) {
      if (root.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
  if (process.exitCode) {
    process.stderr.write(`FAIL runtime account storage (${passed}/${tests.length})\n`);
  } else {
    process.stdout.write(`PASS runtime account storage (${passed}/${tests.length})\n`);
  }
})();
