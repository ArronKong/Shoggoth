#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app/agent-service/paths.js"));
const { MAX_INSTALL_BATCH, NativeSkillStore } = require(path.join(
  ROOT, "app/agent-service/native-skill-store.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-skills-"));
  fs.chmodSync(root, 0o700);
  const stateRoot = path.join(root, "state");
  const builtinRoot = path.join(root, "builtins");
  fs.mkdirSync(builtinRoot, { mode: 0o700 });
  const paths = resolveServicePaths({ stateRoot, trustedRoot: root });
  const profiles = new Set(["profile-a", "profile-b"]);
  const store = new NativeSkillStore({
    paths,
    builtinRoot,
    profileExists: (profileId) => profiles.has(profileId),
    now: () => 1_777_777_777_000,
  });
  return {
    root, stateRoot, builtinRoot, paths, profiles, store,
    cleanup() { try { store.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function packageDir(root, spec = {}) {
  const name = spec.name || "careful-review";
  const target = path.join(root, spec.directory || `${name}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const manifest = {
    schemaVersion: 1,
    id: spec.id || name,
    name,
    version: spec.version || "1.0.0",
    description: spec.description || "Review a change carefully before it is shipped.",
    entry: "SKILL.md",
    requiredTools: spec.requiredTools || [],
    requiredRuntimeCapabilities: spec.requiredRuntimeCapabilities || [],
    sourceCompatibility: spec.sourceCompatibility || ["shoggoth", "codex"],
  };
  if (spec.extraManifest) Object.assign(manifest, spec.extraManifest);
  fs.writeFileSync(path.join(target, "skill.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(target, "SKILL.md"), spec.content || [
    "---",
    `name: ${name}`,
    `description: ${manifest.description}`,
    "---",
    "",
    "# Workflow",
    "",
    "Inspect the requested change, state evidence, and preserve user data.",
    "",
  ].join("\n"));
  return target;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function writeStoredZip(target, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const bytes = Buffer.from(entry.bytes || "");
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode || 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, bytes);
    centrals.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(target, Buffer.concat([...locals, centralBytes, eocd]), { mode: 0o600 });
}

test("同名版本并存时启用锁定目标版本，禁用或卸载旧版本不影响新版", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    for (const version of ["1.0.0", "1.0.1"]) {
      value.store.installFromDirectory({
        sourcePath: packageDir(value.root, { version }),
        expectedRevision: value.store.revision,
        operationId: `install-${version}`,
      });
    }
    const change = (version, enabled) => value.store.setProfileSkill({
      profileId: "profile-a", skillId: "careful-review", source: "user", version, enabled,
      expectedRevision: value.store.list("profile-a").profileRevision,
    });
    change("1.0.0", true);
    change("1.0.1", true);
    change("1.0.0", false);
    assert.deepEqual(value.store.list("profile-a").items.map(({ version, enabled }) => ({ version, enabled })), [
      { version: "1.0.0", enabled: false }, { version: "1.0.1", enabled: true },
    ]);
    value.store.uninstall({
      skillId: "careful-review", source: "user", version: "1.0.0",
      expectedRevision: value.store.revision,
    });
    assert.equal(value.store.list("profile-a").items[0].version, "1.0.1");
    assert.equal(value.store.list("profile-a").items[0].enabled, true);
  } finally { value.cleanup(); }
});

test("安装原生包后 registry 成为唯一真源，重启仍可验证", () => {
  const value = fixture();
  try {
    const source = packageDir(value.root);
    value.store.open(["profile-a", "profile-b"]);
    const installed = value.store.installFromDirectory({
      sourcePath: source,
      expectedRevision: value.store.revision,
      operationId: "install-careful-review-v1",
    });
    assert.equal(installed.package.id, "careful-review");
    assert.equal(installed.package.source, "user");
    assert.match(installed.package.contentHash, /^[a-f0-9]{64}$/u);
    assert.equal(installed.revision, 2);
    const registry = JSON.parse(fs.readFileSync(value.paths.skillRegistryPath, "utf8"));
    assert.equal(registry.revision, 2);
    assert.equal(registry.packages.length, 1);
    assert.equal(fs.lstatSync(path.join(
      value.paths.skillPackagesDir, "careful-review", "1.0.0", "SKILL.md",
    )).isFile(), true);
    value.store.close();
    value.store.open(["profile-a", "profile-b"]);
    assert.equal(value.store.list("profile-a").items[0].contentHash, installed.package.contentHash);
  } finally { value.cleanup(); }
});

test("提交前完整校验旧包，篡改导致失败时磁盘和内存 Registry 均不前进", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    value.store.installFromDirectory({ sourcePath: packageDir(value.root, { name: "precommit-old" }),
      expectedRevision: 1, operationId: "install-precommit-old" });
    const before = fs.readFileSync(value.paths.skillRegistryPath);
    const oldPath = path.join(value.paths.skillPackagesDir, "precommit-old", "1.0.0", "SKILL.md");
    const original = fs.readFileSync(oldPath);
    fs.appendFileSync(oldPath, "\nchanged after install\n");
    assert.throws(() => value.store.installFromDirectory({
      sourcePath: packageDir(value.root, { name: "precommit-new" }),
      expectedRevision: 2, operationId: "install-precommit-new",
    }), { code: "SKILL_REGISTRY_CORRUPT" });
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), before);
    assert.equal(value.store.revision, 2);
    fs.writeFileSync(oldPath, original);
    value.store.close();
    value.store.open(["profile-a"]);
    assert.deepEqual(value.store.list("profile-a").items.map((item) => item.name), ["precommit-old"]);
    assert.equal(fs.existsSync(path.join(value.paths.skillPackagesDir, "precommit-new", "1.0.0")), false,
      "uncommitted package must be removed by startup orphan recovery");
  } finally { value.cleanup(); }
});

test("Registry 已提交但 backup 清理失败时内存 revision 跟随已提交结果", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    value.store.installFromDirectory({ sourcePath: packageDir(value.root, { name: "commit-first" }),
      expectedRevision: 1, operationId: "install-commit-first" });
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = function failBackupCleanup(target, ...args) {
      if (String(target).startsWith(`${value.paths.skillRegistryPath}.backup-`)) {
        throw Object.assign(new Error("injected backup cleanup failure"), { code: "EIO" });
      }
      return originalUnlink.call(this, target, ...args);
    };
    try {
      assert.throws(() => value.store.installBatchFromDirectories({
        items: [
          { sourcePath: packageDir(value.root, { name: "commit-second" }) },
          { sourcePath: packageDir(value.root, { name: "commit-third" }) },
        ],
        expectedRevision: 2, operationId: "install-commit-second",
      }), (error) => error.committed === true
        && error.code === "PRIVATE_FILE_COMMITTED_WITH_CLEANUP_FAILURE");
    } finally { fs.unlinkSync = originalUnlink; }
    assert.equal(JSON.parse(fs.readFileSync(value.paths.skillRegistryPath, "utf8")).revision, 3);
    assert.equal(value.store.revision, 3, "an acknowledged commit must update in-memory CAS state");
    assert.deepEqual(value.store.list("profile-a").items.map((item) => item.name),
      ["commit-first", "commit-second", "commit-third"]);
    assert.throws(() => value.store.installFromDirectory({
      sourcePath: packageDir(value.root, { name: "commit-stale" }),
      expectedRevision: 2, operationId: "install-commit-stale",
    }), { code: "SKILL_REGISTRY_REVISION_CONFLICT" });
  } finally { value.cleanup(); }
});

test("Registry 提交状态不确定后停用 Store，并拒绝带歧义证据的重启", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    value.store.installFromDirectory({ sourcePath: packageDir(value.root, { name: "uncertain-first" }),
      expectedRevision: 1, operationId: "install-uncertain-first" });
    const originalRename = fs.renameSync;
    const originalFsync = fs.fsyncSync;
    let registryRenamed = false;
    fs.renameSync = function failRollback(from, target, ...args) {
      if (from === `${value.paths.skillRegistryPath}.tmp` && target === value.paths.skillRegistryPath) {
        const result = originalRename.call(this, from, target, ...args);
        registryRenamed = true;
        return result;
      }
      if (registryRenamed && String(from).startsWith(`${value.paths.skillRegistryPath}.backup-`)
        && target === value.paths.skillRegistryPath) {
        throw Object.assign(new Error("injected rollback failure"), { code: "EIO" });
      }
      return originalRename.call(this, from, target, ...args);
    };
    fs.fsyncSync = function failRegistryParentSync(fd, ...args) {
      if (registryRenamed && fs.fstatSync(fd).isDirectory()) {
        throw Object.assign(new Error("injected Registry parent fsync failure"), { code: "EIO" });
      }
      return originalFsync.call(this, fd, ...args);
    };
    try {
      assert.throws(() => value.store.installBatchFromDirectories({
        items: [{ sourcePath: packageDir(value.root, { name: "uncertain-second" }) }],
        expectedRevision: 2, operationId: "install-uncertain-second",
      }), (error) => error.committedUncertain === true
        && error.code === "PRIVATE_FILE_COMMIT_UNCERTAIN");
    } finally {
      fs.renameSync = originalRename;
      fs.fsyncSync = originalFsync;
    }
    assert.equal(fs.existsSync(path.join(value.paths.skillPackagesDir, "uncertain-second", "1.0.0")), true,
      "uncertain durable Registry may reference the newly materialized batch target");
    assert.throws(() => value.store.list("profile-a"), { code: "SKILL_REGISTRY_COMMIT_UNCERTAIN" });
    assert.throws(() => value.store.revision, { code: "SKILL_REGISTRY_COMMIT_UNCERTAIN" });
    value.store.close();
    assert.throws(() => value.store.open(["profile-a"]), { code: "SKILL_REGISTRY_COMMIT_UNCERTAIN" });
  } finally { value.cleanup(); }
});

test("有界批量安装仅提交一次且重启后全部可读，全局版本保持唯一", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    const firstSource = packageDir(value.root, { name: "batch-shared", version: "1.0.0" });
    value.store.installFromDirectory({ sourcePath: firstSource,
      expectedRevision: 1, operationId: "install-batch-shared-v1", globalEnabled: true });
    const sources = [
      packageDir(value.root, { name: "batch-shared", version: "1.1.0" }),
      packageDir(value.root, { name: "batch-second" }),
      packageDir(value.root, { name: "batch-third" }),
    ];
    const oldPath = path.join(value.paths.skillPackagesDir, "batch-shared", "1.0.0", "SKILL.md");
    const originalRead = fs.readFileSync;
    let oldPackageReads = 0;
    fs.readFileSync = function countedRead(target, ...args) {
      if (target === oldPath) oldPackageReads += 1;
      return originalRead.call(this, target, ...args);
    };
    let installed;
    try {
      installed = value.store.installBatchFromDirectories({
        operationId: "batch-install-three", expectedRevision: 2,
        items: sources.map((sourcePath) => ({ sourcePath, globalEnabled: true })),
      });
    } finally { fs.readFileSync = originalRead; }
    assert.equal(installed.revision, 3, "one batch advances the Registry once");
    assert.equal(installed.packages.length, 3);
    assert.equal(oldPackageReads, 1, "old installed package is fully rescanned once per batch");
    const current = value.store.list("profile-a").items;
    assert.equal(current.length, 4);
    assert.equal(current.find((item) => item.name === "batch-shared" && item.version === "1.0.0")
      .globalEnabled, false);
    assert.equal(current.find((item) => item.name === "batch-shared" && item.version === "1.1.0")
      .globalEnabled, true);
    value.store.close();
    value.store.open(["profile-a"]);
    for (const name of ["batch-shared", "batch-second", "batch-third"]) {
      assert.match(value.store.read({ profileId: "profile-a", name }).content, /Inspect the requested change/u);
    }
    assert.equal(value.store.registry.packages.length, 4);
  } finally { value.cleanup(); }
});

test("批量上限、重复版本和旧包篡改均在提交前拒绝，重启清理孤儿", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    const source = packageDir(value.root, { name: "batch-first" });
    const beforeEmpty = fs.readFileSync(value.paths.skillRegistryPath);
    assert.throws(() => value.store.installBatchFromDirectories({
      operationId: "batch-too-many", expectedRevision: 1,
      items: Array.from({ length: MAX_INSTALL_BATCH + 1 }, () => ({ sourcePath: source })),
    }), { code: "SKILL_INSTALL_INVALID" });
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), beforeEmpty);
    assert.throws(() => value.store.installBatchFromDirectories({
      operationId: "batch-duplicate", expectedRevision: 1,
      items: [{ sourcePath: source }, { sourcePath: source }],
    }), { code: "SKILL_BATCH_DUPLICATE" });
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), beforeEmpty);
    const duplicateManifest = packageDir(value.root, { name: "batch-first" });
    assert.throws(() => value.store.installBatchFromDirectories({
      operationId: "batch-duplicate-version", expectedRevision: 1,
      items: [{ sourcePath: source }, { sourcePath: duplicateManifest }],
    }), { code: "SKILL_BATCH_DUPLICATE" });
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), beforeEmpty);
    assert.equal(fs.existsSync(path.join(value.paths.skillPackagesDir, "batch-first", "1.0.0")), false,
      "a definite batch failure removes the exact newly materialized target immediately");
    value.store.close();
    value.store.open(["profile-a"]);
    assert.equal(fs.existsSync(path.join(value.paths.skillPackagesDir, "batch-first", "1.0.0")), false);
    value.store.installFromDirectory({ sourcePath: source,
      expectedRevision: 1, operationId: "install-batch-first" });
    const beforeTamper = fs.readFileSync(value.paths.skillRegistryPath);
    const installedPath = path.join(value.paths.skillPackagesDir, "batch-first", "1.0.0", "SKILL.md");
    const original = fs.readFileSync(installedPath);
    fs.appendFileSync(installedPath, "\ntampered\n");
    assert.throws(() => value.store.installBatchFromDirectories({
      operationId: "batch-tampered-old", expectedRevision: 2,
      items: [{ sourcePath: packageDir(value.root, { name: "batch-after-tamper" }) }],
    }), { code: "SKILL_REGISTRY_CORRUPT" });
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), beforeTamper);
    assert.equal(value.store.revision, 2);
    assert.equal(fs.existsSync(path.join(value.paths.skillPackagesDir, "batch-after-tamper", "1.0.0")), false);
    fs.writeFileSync(installedPath, original);
    value.store.close();
    value.store.open(["profile-a"]);
    assert.equal(fs.existsSync(path.join(value.paths.skillPackagesDir, "batch-after-tamper", "1.0.0")), false);
  } finally { value.cleanup(); }
});

test("批量中的既有同摘要版本保持幂等，显式全局提升只提交一次", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    const source = packageDir(value.root, { name: "batch-existing" });
    value.store.installFromDirectory({ sourcePath: source,
      expectedRevision: 1, operationId: "install-batch-existing" });
    const before = fs.readFileSync(value.paths.skillRegistryPath);
    const unchanged = value.store.installBatchFromDirectories({
      operationId: "batch-existing-again", expectedRevision: 2,
      items: [{ sourcePath: source }],
    });
    assert.equal(unchanged.revision, 2);
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), before);
    const promoted = value.store.installBatchFromDirectories({
      operationId: "batch-existing-promote", expectedRevision: 2,
      items: [{ sourcePath: source, globalEnabled: true }],
    });
    assert.equal(promoted.revision, 3);
    assert.equal(value.store.listGlobalEnabled()[0].name, "batch-existing");
    const changedSource = packageDir(value.root, { name: "batch-existing", content: "# Changed\n" });
    const promotedRegistry = fs.readFileSync(value.paths.skillRegistryPath);
    assert.throws(() => value.store.installBatchFromDirectories({
      operationId: "batch-existing-conflict", expectedRevision: 3,
      items: [{ sourcePath: changedSource }],
    }), { code: "SKILL_VERSION_CONFLICT" });
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), promotedRegistry);
  } finally { value.cleanup(); }
});

test("批量 Registry 原子写入未提交时立即清理本批目标，旧 revision 可继续使用", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    const before = fs.readFileSync(value.paths.skillRegistryPath);
    const first = packageDir(value.root, { name: "batch-write-first" });
    const second = packageDir(value.root, { name: "batch-write-second" });
    const originalRename = fs.renameSync;
    fs.renameSync = function failRegistryRename(from, target, ...args) {
      if (from === `${value.paths.skillRegistryPath}.tmp` && target === value.paths.skillRegistryPath) {
        throw Object.assign(new Error("injected Registry rename failure"), { code: "EIO" });
      }
      return originalRename.call(this, from, target, ...args);
    };
    try {
      assert.throws(() => value.store.installBatchFromDirectories({
        operationId: "batch-write-failed", expectedRevision: 1,
        items: [{ sourcePath: first }, { sourcePath: second }],
      }), { code: "EIO" });
    } finally { fs.renameSync = originalRename; }
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), before);
    assert.equal(value.store.revision, 1);
    for (const name of ["batch-write-first", "batch-write-second"]) {
      assert.equal(fs.existsSync(path.join(value.paths.skillPackagesDir, name, "1.0.0")), false);
    }
    const retry = value.store.installBatchFromDirectories({
      operationId: "batch-write-retry", expectedRevision: 1,
      items: [{ sourcePath: first }, { sourcePath: second }],
    });
    assert.equal(retry.revision, 2);
  } finally { value.cleanup(); }
});

test("Registry 超过重启读取上限时拒绝提交并保留旧文件", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    value.store.installFromDirectory({
      sourcePath: packageDir(value.root, { name: "registry-capacity-base" }),
      expectedRevision: 1, operationId: "install-registry-capacity-base",
    });
    const before = fs.readFileSync(value.paths.skillRegistryPath);
    const template = value.store.registry.packages[0];
    const tooLarge = Array.from({ length: 1_300 }, (_, index) => ({
      ...template, id: `registry-capacity-${index}`, description: "x".repeat(4_096),
    }));
    assert.throws(() => value.store._commitRegistry(tooLarge), { code: "SKILL_REGISTRY_TOO_LARGE" });
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), before);
    assert.equal(value.store.revision, 2);
    value.store.close();
    value.store.open(["profile-a"]);
    assert.equal(value.store.list("profile-a").items.length, 1);
  } finally { value.cleanup(); }
});

test("批量不能同时全局启用同一 Skill 的两个版本，并立即回滚新目录", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    const first = packageDir(value.root, { name: "batch-versions", version: "1.0.0" });
    const second = packageDir(value.root, { name: "batch-versions", version: "1.1.0" });
    const before = fs.readFileSync(value.paths.skillRegistryPath);
    assert.throws(() => value.store.installBatchFromDirectories({
      operationId: "batch-two-global-versions", expectedRevision: 1,
      items: [{ sourcePath: first, globalEnabled: true },
        { sourcePath: second, globalEnabled: true }],
    }), { code: "SKILL_BATCH_GLOBAL_CONFLICT" });
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), before);
    assert.equal(value.store.revision, 1);
    assert.equal(fs.existsSync(path.join(value.paths.skillPackagesDir, "batch-versions", "1.0.0")), false);
    assert.equal(fs.existsSync(path.join(value.paths.skillPackagesDir, "batch-versions", "1.1.0")), false);
  } finally { value.cleanup(); }
});

test("ZIP 安装支持单层包装目录并拒绝路径穿越与 symlink 条目", () => {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: "zip-review",
    name: "zip-review",
    version: "1.0.0",
    description: "Install a Skill from a safe local ZIP.",
    entry: "SKILL.md",
    requiredTools: [],
    requiredRuntimeCapabilities: [],
    sourceCompatibility: ["shoggoth", "codex"],
  });
  const required = [
    { name: "zip-review/skill.json", bytes: manifest },
    { name: "zip-review/SKILL.md", bytes: "# ZIP review\n\nReview the package.\n" },
  ];
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    const archive = path.join(value.root, "zip-review.zip");
    writeStoredZip(archive, required);
    const installed = value.store.installFromDirectory({
      sourcePath: archive, expectedRevision: 1, operationId: "install-zip-review",
    });
    assert.equal(installed.package.name, "zip-review");
    assert.equal(fs.readdirSync(value.paths.skillStagingDir).length, 0);
  } finally { value.cleanup(); }

  if (fs.existsSync("/usr/bin/zip")) {
    const standard = fixture();
    try {
      standard.store.open(["profile-a"]);
      const source = packageDir(standard.root, { name: "standard-zip", directory: "standard-zip" });
      const archive = path.join(standard.root, "standard-zip.zip");
      execFileSync("/usr/bin/zip", ["-q", "-r", archive, path.basename(source)], {
        cwd: standard.root,
        stdio: "ignore",
      });
      assert.equal(standard.store.installFromDirectory({
        sourcePath: archive, expectedRevision: 1, operationId: "install-standard-zip",
      }).package.name, "standard-zip");
    } finally { standard.cleanup(); }
  }

  for (const hostile of [
    { name: "../escape", bytes: "bad" },
    { name: "zip-review/references/link", bytes: "../../outside", mode: 0o120777 },
  ]) {
    const rejected = fixture();
    try {
      rejected.store.open(["profile-a"]);
      const archive = path.join(rejected.root, "hostile.zip");
      writeStoredZip(archive, [...required, hostile]);
      assert.throws(() => rejected.store.installFromDirectory({
        sourcePath: archive, expectedRevision: 1, operationId: "reject-hostile-zip",
      }), (error) => ["SKILL_PATH_INVALID", "UNSAFE_SYMLINK"].includes(error.code));
      assert.equal(fs.readdirSync(rejected.paths.skillStagingDir).length, 0);
    } finally { rejected.cleanup(); }
  }
});

test("包校验拒绝未知 manifest 字段、secret、symlink 与 hardlink", () => {
  const cases = [
    {
      code: "SKILL_MANIFEST_INVALID",
      mutate(target) {
        const file = path.join(target, "skill.json");
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        manifest.unknown = true;
        fs.writeFileSync(file, `${JSON.stringify(manifest)}\n`);
      },
    },
    {
      code: "SKILL_SECRET_REJECTED",
      mutate(target) { fs.appendFileSync(path.join(target, "SKILL.md"), "\nOPENAI_API_KEY=sk-secretsecretsecretsecret\n"); },
    },
    {
      code: "UNSAFE_SYMLINK",
      mutate(target) {
        fs.mkdirSync(path.join(target, "references"), { mode: 0o700 });
        fs.symlinkSync(path.join(target, "SKILL.md"), path.join(target, "references", "escape.md"));
      },
    },
    {
      code: "UNSAFE_HARDLINK",
      mutate(target) {
        fs.mkdirSync(path.join(target, "references"), { mode: 0o700 });
        fs.linkSync(path.join(target, "SKILL.md"), path.join(target, "references", "duplicate.md"));
      },
    },
  ];
  for (const current of cases) {
    const value = fixture();
    try {
      const source = packageDir(value.root);
      current.mutate(source);
      value.store.open(["profile-a"]);
      assert.throws(() => value.store.installFromDirectory({
        sourcePath: source,
        expectedRevision: value.store.revision,
        operationId: `reject-${current.code}`,
      }), (error) => error.code === current.code, current.code);
      assert.equal(value.store.list("profile-a").items.length, 0);
    } finally { value.cleanup(); }
  }
});

test("Profile 启用、版本锁定和依赖解析彼此隔离", () => {
  const value = fixture();
  try {
    const source = packageDir(value.root, {
      requiredTools: ["artifact_publish"],
      requiredRuntimeCapabilities: ["mcp"],
    });
    value.store.open(["profile-a", "profile-b"]);
    value.store.installFromDirectory({
      sourcePath: source, expectedRevision: 1, operationId: "install-profile-test",
    });
    const enabled = value.store.setProfileSkill({
      profileId: "profile-a", skillId: "careful-review", source: "user", version: "1.0.0",
      enabled: true, expectedRevision: 1,
    });
    assert.equal(enabled.revision, 2);
    assert.equal(value.store.list("profile-a").items[0].enabled, true);
    assert.equal(value.store.list("profile-b").items[0].enabled, false);
    assert.deepEqual(value.store.catalog("profile-a", {
      availableTools: ["artifact_publish"], allowedTools: ["artifact_publish"],
      runtimeCapabilities: ["mcp"],
    }).items.map((item) => item.name), ["careful-review"]);
    const missing = value.store.catalog("profile-a", {
      availableTools: ["artifact_publish"], allowedTools: [], runtimeCapabilities: ["mcp"],
    });
    assert.equal(missing.items.length, 0);
    assert.equal(missing.ineligible[0].reason, "tool_forbidden");
    assert.throws(() => value.store.setProfileSkill({
      profileId: "profile-a", skillId: "careful-review", source: "user", version: "1.0.0",
      enabled: false, expectedRevision: 1,
    }), (error) => error.code === "SKILL_PROFILE_REVISION_CONFLICT");
  } finally { value.cleanup(); }
});

test("显式调用冻结 Skill ref，成功读取才记录使用次数", () => {
  const value = fixture();
  try {
    const source = packageDir(value.root);
    value.store.open(["profile-a"]);
    value.store.installFromDirectory({ sourcePath: source, expectedRevision: 1, operationId: "install-select" });
    value.store.setProfileSkill({
      profileId: "profile-a", skillId: "careful-review", source: "user", version: "1.0.0",
      enabled: true, expectedRevision: 1,
    });
    const selected = value.store.select("profile-a", "Please use $careful-review for this change", {
      availableTools: [], allowedTools: [], runtimeCapabilities: [],
    });
    assert.equal(selected.selected.length, 1);
    assert.equal(selected.selected[0].name, "careful-review");
    assert.match(selected.registryRevision, /^[a-f0-9]{64}$/u);
    assert.deepEqual(value.store.usage("profile-a").skills, {});
    const read = value.store.read({
      profileId: "profile-a", name: "careful-review",
      contentHash: selected.selected[0].contentHash,
      recordUsage: true,
    });
    assert.match(read.content, /Inspect the requested change/u);
    assert.equal(value.store.usage("profile-a").skills["careful-review"]["profile-a"], 1);
    value.store.setProfileSkill({
      profileId: "profile-a", skillId: "careful-review", source: "user", version: "1.0.0",
      enabled: false, expectedRevision: 2,
    });
    assert.throws(() => value.store.select("profile-a", "$careful-review", {
      availableTools: [], allowedTools: [], runtimeCapabilities: [],
    }), (error) => error.code === "SKILL_NOT_ENABLED");
  } finally { value.cleanup(); }
});

test("Registry 全局启用不依赖逐 Profile 写入，停用和卸载对当前及未来 Profile 生效", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a", "profile-b"]);
    const installed = value.store.installFromDirectory({
      sourcePath: packageDir(value.root, { name: "shared-review" }),
      expectedRevision: value.store.revision, operationId: "install-shared-review",
      globalEnabled: true,
    });
    for (const profileId of ["profile-a", "profile-b"]) {
      assert.equal(value.store.list(profileId).items[0].enabled, true);
      assert.equal(value.store.catalog(profileId).items[0].name, "shared-review");
      assert.match(value.store.read({ profileId, name: "shared-review" }).content, /Inspect the requested change/u);
      assert.deepEqual(value.store.ensureProfile(profileId).selections, [],
        "global availability does not create a per-profile installation");
    }
    value.profiles.add("profile-c");
    assert.equal(value.store.list("profile-c").items[0].enabled, true);
    const disabled = value.store.setGlobalSkill({ skillId: installed.package.id,
      source: "user", version: installed.package.version, enabled: false,
      expectedRevision: installed.revision });
    assert.equal(disabled.skill.enabled, false);
    assert.deepEqual(value.store.catalog("profile-a").items, []);
    assert.deepEqual(value.store.catalog("profile-c").items, []);
    assert.throws(() => value.store.read({ profileId: "profile-b", name: "shared-review" }),
      { code: "SKILL_NOT_ENABLED" });
    assert.throws(() => value.store.setGlobalSkill({ skillId: installed.package.id,
      source: "user", version: installed.package.version, enabled: true,
      expectedRevision: installed.revision }), { code: "SKILL_REGISTRY_REVISION_CONFLICT" });
    const enabled = value.store.setGlobalSkill({ skillId: installed.package.id,
      source: "user", version: installed.package.version, enabled: true,
      expectedRevision: disabled.revision });
    assert.equal(value.store.catalog("profile-b").items.length, 1);
    const upgraded = value.store.installFromDirectory({
      sourcePath: packageDir(value.root, { name: "shared-review", version: "1.1.0" }),
      expectedRevision: enabled.revision, operationId: "upgrade-shared-review",
      globalEnabled: true,
    });
    const oldDisabled = value.store.setGlobalSkill({ skillId: installed.package.id,
      source: "user", version: installed.package.version, enabled: false,
      expectedRevision: upgraded.revision });
    assert.equal(value.store.catalog("profile-c").items[0].version, "1.1.0",
      "disabling an old version must not turn off a newer global version");
    value.store.setGlobalSkill({ skillId: upgraded.package.id,
      source: "user", version: upgraded.package.version, enabled: false,
      expectedRevision: oldDisabled.revision });
    value.store.uninstall({ skillId: installed.package.id, source: "user",
      version: installed.package.version, expectedRevision: value.store.revision });
    assert.equal(value.store.list("profile-a").items.length, 1);
    assert.equal(value.store.list("profile-a").items[0].enabled, false);
  } finally { value.cleanup(); }
});

test("全局安装启用所有现有 Profile，后建 Profile 自动继承且普通安装仍保持隔离", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a", "profile-b"]);
    const source = packageDir(value.root, { name: "shared-fetch" });
    const installed = value.store.installGlobalFromDirectory({
      sourcePath: source,
      expectedRevision: value.store.revision,
      operationId: "install-shared-fetch-global",
      profileIds: ["profile-a", "profile-b"],
    });
    assert.equal(installed.complete, true);
    assert.equal(installed.availableToFutureProfiles, true);
    assert.deepEqual(installed.enabledProfiles, ["profile-a", "profile-b"]);
    assert.equal(value.store.list("profile-a").items[0].enabled, true);
    assert.equal(value.store.list("profile-b").items[0].enabled, true);
    assert.equal(value.store.list("profile-a").items[0].globalEnabled, true);

    value.profiles.add("profile-c");
    value.store.ensureProfile("profile-c");
    assert.equal(value.store.list("profile-c").items[0].enabled, true);

    value.store.close();
    value.store.open(["profile-a", "profile-b", "profile-c"]);
    assert.equal(value.store.list("profile-c").items[0].globalEnabled, true);
    assert.equal(value.store.list("profile-c").items[0].enabled, true);

    value.store.installGlobalFromDirectory({
      sourcePath: packageDir(value.root, { name: "shared-fetch", version: "1.1.0" }),
      expectedRevision: value.store.revision,
      operationId: "upgrade-shared-fetch-global",
      profileIds: ["profile-a", "profile-b", "profile-c"],
    });
    const versions = value.store.list("profile-a").items
      .filter((item) => item.name === "shared-fetch")
      .map(({ version, enabled, globalEnabled }) => ({ version, enabled, globalEnabled }));
    assert.deepEqual(versions, [
      { version: "1.0.0", enabled: false, globalEnabled: false },
      { version: "1.1.0", enabled: true, globalEnabled: true },
    ]);

    const localOnly = packageDir(value.root, { name: "local-only" });
    value.store.installFromDirectory({
      sourcePath: localOnly,
      expectedRevision: value.store.revision,
      operationId: "install-local-only",
    });
    value.profiles.add("profile-d");
    value.store.ensureProfile("profile-d");
    const byName = new Map(value.store.list("profile-d").items.map((item) => [item.name, item]));
    assert.equal(byName.get("shared-fetch").enabled, true);
    assert.equal(byName.get("shared-fetch").version, "1.1.0");
    assert.equal(byName.get("local-only").enabled, false);
  } finally { value.cleanup(); }
});

test("外部宿主只读取全局安装的独立 Skill，撤权和文件变化立即拒绝", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    const globalSource = packageDir(value.root, { name: "external-global" });
    fs.mkdirSync(path.join(globalSource, "references"), { mode: 0o700 });
    fs.writeFileSync(path.join(globalSource, "references", "guide.md"), "Reference fixture\n");
    const global = value.store.installFromDirectory({
      sourcePath: globalSource,
      expectedRevision: value.store.revision, operationId: "install-external-global",
      globalEnabled: true,
    });
    value.store.installFromDirectory({
      sourcePath: packageDir(value.root, { name: "profile-only" }),
      expectedRevision: value.store.revision, operationId: "install-profile-only",
    });
    const [descriptor] = value.store.listGlobalEnabled();
    assert.equal(descriptor.name, "external-global");
    assert.match(value.store.readGlobalEnabled({ skillId: descriptor.id,
      version: descriptor.version, contentHash: descriptor.contentHash,
      registryRevision: descriptor.registryRevision }).content, /Inspect the requested change/u);
    assert.equal(value.store.readGlobalEnabledFile({ skillId: descriptor.id,
      version: descriptor.version, contentHash: descriptor.contentHash,
      registryRevision: descriptor.registryRevision,
      relativePath: "references/guide.md" }).content, "Reference fixture\n");
    const installedReference = path.join(value.paths.skillPackagesDir, descriptor.id,
      descriptor.version, "references", "guide.md");
    const originalReference = fs.readFileSync(installedReference);
    fs.appendFileSync(installedReference, "changed\n");
    assert.throws(() => value.store.readGlobalEnabledFile({ skillId: descriptor.id,
      version: descriptor.version, contentHash: descriptor.contentHash,
      registryRevision: descriptor.registryRevision,
      relativePath: "references/guide.md" }), { code: "SKILL_PACKAGE_CHANGED" });
    fs.writeFileSync(installedReference, originalReference);
    assert.throws(() => value.store.readGlobalEnabledFile({ skillId: descriptor.id,
      version: descriptor.version, contentHash: descriptor.contentHash,
      registryRevision: descriptor.registryRevision,
      relativePath: "references/../../skill.json" }), { code: "SKILL_PATH_INVALID" });
    assert.throws(() => value.store.readGlobalEnabledFile({ skillId: descriptor.id,
      version: descriptor.version, contentHash: descriptor.contentHash,
      registryRevision: descriptor.registryRevision,
      relativePath: "skill.json" }), { code: "SKILL_PATH_INVALID" });
    assert.throws(() => value.store.readGlobalEnabled({ skillId: descriptor.id,
      version: descriptor.version, contentHash: descriptor.contentHash,
      registryRevision: descriptor.registryRevision - 1 }), { code: "SKILL_REVISION_CHANGED" });
    const skillPath = path.join(value.paths.skillPackagesDir, descriptor.id,
      descriptor.version, "SKILL.md");
    const originalContent = fs.readFileSync(skillPath);
    fs.appendFileSync(skillPath, "\nchanged after install\n");
    assert.throws(() => value.store.readGlobalEnabled({ skillId: descriptor.id,
      version: descriptor.version, contentHash: descriptor.contentHash,
      registryRevision: descriptor.registryRevision }), { code: "SKILL_PACKAGE_CHANGED" });
    fs.writeFileSync(skillPath, originalContent);
    value.store.setGlobalSkill({ skillId: global.package.id,
      version: global.package.version, source: "user", enabled: false,
      expectedRevision: value.store.revision });
    assert.deepEqual(value.store.listGlobalEnabled(), []);
    assert.throws(() => value.store.readGlobalEnabled({ skillId: descriptor.id,
      version: descriptor.version, contentHash: descriptor.contentHash,
      registryRevision: descriptor.registryRevision }), { code: "SKILL_REVISION_CHANGED" });
  } finally { value.cleanup(); }
});

test("旧版 Skill registry 明确拒绝且不改写", () => {
  const value = fixture();
  try {
    value.store.open(["profile-a"]);
    value.store.installFromDirectory({
      sourcePath: packageDir(value.root, { name: "legacy-local" }),
      expectedRevision: value.store.revision,
      operationId: "install-legacy-local",
    });
    value.store.close();
    const legacy = JSON.parse(fs.readFileSync(value.paths.skillRegistryPath, "utf8"));
    legacy.schemaVersion = 1;
    legacy.packages = legacy.packages.map(({ globalEnabled, ...record }) => record);
    fs.writeFileSync(value.paths.skillRegistryPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const before = fs.readFileSync(value.paths.skillRegistryPath);
    assert.throws(() => value.store.open(["profile-a"]), { code: "SKILL_REGISTRY_CORRUPT" });
    assert.deepEqual(fs.readFileSync(value.paths.skillRegistryPath), before);
  } finally { value.cleanup(); }
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS shoggoth native skill engine unit (${tests.length})`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
