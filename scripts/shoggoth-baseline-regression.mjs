#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const {
  createAuthorityBackup,
  restoreAuthorityBackup,
  verifyAuthorityBackup,
} = require(path.join(ROOT, "app", "agent-service", "authority-backup.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-baseline-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "user-data", "shoggoth-core"),
    profileRoot: path.join(root, "user-data", "agent-service-profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.stateDir, 0o700);
  return { root, paths };
}

function writePrivate(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(target), 0o700);
  fs.writeFileSync(target, value, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function sha256(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function seedLegacyAuthority(paths) {
  writePrivate(paths.stateSnapshotPath, "legacy-product-snapshot\n");
  writePrivate(paths.eventLogPath, "legacy-product-event\n");
  writePrivate(path.join(paths.stateDir, "chat-sessions.json"), "legacy-chat-session\n");
  writePrivate(path.join(paths.stateDir, "native-kanban.json"), "legacy-kanban\n");
  writePrivate(path.join(paths.stateDir, "native-cron.json"), "legacy-cron\n");
  writePrivate(
    path.join(paths.stateDir, "codex", "profile-a", "sessions", "thread-1.jsonl"),
    "legacy-codex-transcript\n",
  );
  writePrivate(
    path.join(paths.stateDir, "codex", "profile-a", "memories", "memory-1.md"),
    "legacy-codex-memory\n",
  );
  writePrivate(
    path.join(paths.stateDir, "codex", "profile-a", "auth.json"),
    "legacy-managed-auth\n",
  );
  writePrivate(
    path.join(paths.stateDir, "codex", "profile-a", "config.toml"),
    "legacy-managed-config\n",
  );
  fs.chmodSync(path.join(paths.stateDir, "codex", "profile-a", "memories"), 0o500);
  fs.chmodSync(
    path.join(paths.stateDir, "codex", "profile-a", "memories", "memory-1.md"),
    0o400,
  );
}

test("离线备份只保留 Shoggoth authority 与 managed Codex 小文件白名单", () => {
  const { root, paths } = fixture();
  seedLegacyAuthority(paths);
  const runtimeTmp = path.join(paths.stateDir, "codex", "profile-a", "tmp", "arg0");
  fs.mkdirSync(runtimeTmp, { recursive: true, mode: 0o700 });
  fs.symlinkSync(
    "/Applications/Shoggoth.app/Contents/Resources/codex/package/bin/codex",
    path.join(runtimeTmp, "apply_patch"),
  );
  writePrivate(
    path.join(paths.nativeRuntimeImportStagingDir, "abandoned", "payload", "config.toml"),
    "staged-runtime-import\n",
  );
  const antigravityRoot = path.join(
    paths.stateDir, "antigravity", "profile-a", ".gemini", "antigravity-cli",
  );
  writePrivate(path.join(antigravityRoot, "settings.json"), "{}\n");
  writePrivate(path.join(antigravityRoot, "log", "cli-1.log"), "runtime log\n");
  fs.symlinkSync("log/cli-1.log", path.join(antigravityRoot, "cli.log"));
  const deepSeekProfile = path.join(
    paths.stateDir, "deepseek-harness", "profile-a", "profiles",
  );
  writePrivate(path.join(deepSeekProfile, "package.json"), "{}\n");
  const projectedDependency = path.join(root, "external-dsh-dependency");
  fs.mkdirSync(projectedDependency, { mode: 0o700 });
  fs.mkdirSync(path.join(deepSeekProfile, "node_modules"), { mode: 0o700 });
  fs.symlinkSync(projectedDependency, path.join(deepSeekProfile, "node_modules", "dependency"));
  const grokRoot = path.join(paths.stateDir, "grok-build", "profile-a");
  writePrivate(path.join(grokRoot, "settings.json"), "{}\n");
  const pnpmProjects = path.join(grokRoot, "Library", "pnpm", "store", "v11", "projects");
  fs.mkdirSync(pnpmProjects, { recursive: true, mode: 0o700 });
  fs.symlinkSync(projectedDependency, path.join(pnpmProjects, "project"));
  const accountHome = path.join(
    paths.runtimeAccountsDir, "codex", "managed-account-a", "home",
  );
  writePrivate(path.join(accountHome, "auth.json"), "account-managed-auth\n");
  writePrivate(path.join(accountHome, "config.toml"), "account-managed-config\n");
  writePrivate(path.join(accountHome, "sessions", "thread.jsonl"), "runtime-session\n");
  writePrivate(
    path.join(paths.runtimeIntegrationDir, "antigravity", "account-a", "large-cache.bin"),
    Buffer.alloc(1024 * 1024),
  );
  assert.equal(paths.backupsDir, path.join(paths.stateDir, "backups"));
  const result = createAuthorityBackup({
    paths,
    backupId: "stage-a-baseline",
    now: () => 1_700_000_000_000,
  });
  assert.equal(result.backupPath, path.join(paths.backupsDir, "stage-a-baseline"));
  const verified = verifyAuthorityBackup({ paths, backupId: "stage-a-baseline" });
  assert.equal(verified.manifest.createdAt, 1_700_000_000_000);
  assert.match(verified.manifest.rootDigest, /^[a-f0-9]{64}$/u);
  const files = verified.manifest.entries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path);
  assert.equal(files.includes("state.snapshot.json"), true);
  assert.equal(files.includes("chat-sessions.json"), true);
  assert.equal(files.includes("codex/profile-a/auth.json"), true);
  assert.equal(files.includes("codex/profile-a/config.toml"), true);
  assert.equal(files.includes("runtime-accounts/codex/managed-account-a/home/auth.json"), true);
  assert.equal(files.includes("runtime-accounts/codex/managed-account-a/home/config.toml"), true);
  assert.equal(files.includes("codex/profile-a/sessions/thread-1.jsonl"), false);
  assert.equal(files.includes("codex/profile-a/memories/memory-1.md"), false);
  assert.equal(files.some((entry) => entry.startsWith("antigravity/")), false);
  assert.equal(files.some((entry) => entry.startsWith("deepseek-harness/")), false);
  assert.equal(files.some((entry) => entry.startsWith("grok-build/")), false);
  assert.equal(files.some((entry) => entry.startsWith("runtime-integration/")), false);
  assert.equal(files.some((entry) => entry.includes("/sessions/")), false);
  assert.equal(files.some((entry) => entry.startsWith("codex/profile-a/tmp/")), false);
  assert.equal(
    files.some((entry) => entry.startsWith(
      "antigravity/profile-a/.gemini/antigravity-cli/log/",
    )),
    false,
  );
  assert.equal(
    files.includes("antigravity/profile-a/.gemini/antigravity-cli/cli.log"),
    false,
  );
  assert.equal(
    files.some((entry) => entry.startsWith(
      "deepseek-harness/profile-a/profiles/node_modules/",
    )),
    false,
  );
  assert.equal(
    files.some((entry) => entry.startsWith("grok-build/profile-a/Library/pnpm/store/")),
    false,
  );
  assert.equal(files.some((entry) => entry.startsWith("native-runtime-imports/staging/")), false);
  assert.equal(files.some((entry) => entry.startsWith("backups/")), false);
  for (const entry of verified.manifest.entries) {
    assert.equal(Number.isInteger(entry.mode), true);
    if (entry.type === "file") assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
  }
});

test("备份可验证恢复到新的空目录，且不受源数据后续修改影响", () => {
  const { root, paths } = fixture();
  seedLegacyAuthority(paths);
  const expected = sha256(path.join(paths.stateDir, "chat-sessions.json"));
  createAuthorityBackup({ paths, backupId: "restore-fixture" });
  writePrivate(path.join(paths.stateDir, "chat-sessions.json"), "newer-data\n");
  const destinationStateDir = path.join(root, "restore-candidate");
  const restored = restoreAuthorityBackup({
    paths,
    backupId: "restore-fixture",
    destinationStateDir,
  });
  assert.equal(restored.destinationStateDir, destinationStateDir);
  assert.equal(sha256(path.join(destinationStateDir, "chat-sessions.json")), expected);
  assert.equal(fs.readFileSync(path.join(
    destinationStateDir, "codex", "profile-a", "auth.json",
  ), "utf8"), "legacy-managed-auth\n");
  assert.equal(fs.readFileSync(path.join(
    destinationStateDir, "codex", "profile-a", "config.toml",
  ), "utf8"), "legacy-managed-config\n");
  assert.equal(fs.existsSync(path.join(
    destinationStateDir, "codex", "profile-a", "sessions",
  )), false);
  assert.equal(fs.existsSync(path.join(
    destinationStateDir, "codex", "profile-a", "memories",
  )), false);
  assert.throws(
    () => restoreAuthorityBackup({
      paths,
      backupId: "restore-fixture",
      destinationStateDir,
    }),
    (error) => error.code === "BACKUP_RESTORE_TARGET_EXISTS",
  );
});

test("在线 Service、symlink 或损坏 payload 均 fail closed", () => {
  const active = fixture();
  seedLegacyAuthority(active.paths);
  fs.mkdirSync(active.paths.runtimeDir, { recursive: true, mode: 0o700 });
  writePrivate(active.paths.lockPath, "active\n");
  assert.throws(
    () => createAuthorityBackup({ paths: active.paths, backupId: "active-service" }),
    (error) => error.code === "BACKUP_SERVICE_ACTIVE",
  );

  const linked = fixture();
  seedLegacyAuthority(linked.paths);
  const victim = path.join(linked.root, "victim.txt");
  writePrivate(victim, "victim\n");
  fs.symlinkSync(victim, path.join(linked.paths.stateDir, "unsafe-link"));
  assert.throws(
    () => createAuthorityBackup({ paths: linked.paths, backupId: "unsafe-source" }),
    (error) => error.code === "BACKUP_UNSAFE_SOURCE",
  );

  const corrupt = fixture();
  seedLegacyAuthority(corrupt.paths);
  const created = createAuthorityBackup({ paths: corrupt.paths, backupId: "corrupt-backup" });
  writePrivate(path.join(created.backupPath, "payload", "chat-sessions.json"), "tampered\n");
  assert.throws(
    () => verifyAuthorityBackup({ paths: corrupt.paths, backupId: "corrupt-backup" }),
    (error) => error.code === "BACKUP_CORRUPT",
  );
});

test("备份流程不读取或改写 OpenClaw/Hermes 外部 authority", () => {
  const { root, paths } = fixture();
  seedLegacyAuthority(paths);
  const openclaw = path.join(root, ".openclaw", "marker.json");
  const hermes = path.join(root, ".hermes", "marker.json");
  writePrivate(openclaw, "openclaw-authority\n");
  writePrivate(hermes, "hermes-authority\n");
  const before = { openclaw: sha256(openclaw), hermes: sha256(hermes) };
  createAuthorityBackup({ paths, backupId: "external-isolation" });
  assert.deepEqual({ openclaw: sha256(openclaw), hermes: sha256(hermes) }, before);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`PASS ${name}`);
}
console.log(`PASS shoggoth baseline regression (${tests.length})`);
