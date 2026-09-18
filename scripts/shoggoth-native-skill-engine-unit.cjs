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
const { NativeSkillStore } = require(path.join(ROOT, "app/agent-service/native-skill-store.js"));

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
