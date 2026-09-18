#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { AgentDefinitionStore } = require(path.join(
  ROOT, "app", "agent-service", "agent-definition-store.js",
));
const { MemoryEngine } = require(path.join(ROOT, "app", "agent-service", "memory-engine.js"));
const {
  PRE_MEMORY_AUTHORITY_BACKUP_ID,
  completeMemoryMigration,
  ensureMemoryMigrationBackup,
  readMarker,
} = require(path.join(ROOT, "app", "agent-service", "memory-migration.js"));
const { MemoryStore } = require(path.join(ROOT, "app", "agent-service", "memory-store.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-memory-migration-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.lockPath, "owned-lock\n", { mode: 0o600 });
  const lock = fs.lstatSync(paths.lockPath);
  return { root, paths, activeServiceLock: { dev: lock.dev, ino: lock.ino } };
}

function openMemory(paths) {
  let id = 0;
  const randomUUID = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const definitions = new AgentDefinitionStore({ paths, now: () => 200, randomUUID });
  definitions.open();
  definitions.ensureProfile({ profileId: "profile-1" });
  const store = new MemoryStore({ paths });
  store.open();
  const engine = new MemoryEngine({ store, definitionStore: definitions, now: () => 200, randomUUID });
  engine.open(["profile-1"]);
  return { definitions, store, engine };
}

const value = fixture();
try {
  const nativeRoot = path.join(value.paths.stateDir, "codex", "runtime-1", "memories");
  fs.mkdirSync(nativeRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(nativeRoot, "preference.md"), "User prefers migration backups.", {
    mode: 0o600,
  });

  const backup = ensureMemoryMigrationBackup({
    paths: value.paths,
    activeServiceLock: value.activeServiceLock,
    now: () => 100,
  });
  assert.equal(path.basename(backup.backupPath), PRE_MEMORY_AUTHORITY_BACKUP_ID);
  assert.equal(fs.readFileSync(path.join(
    backup.backupPath, "payload", "codex", "runtime-1", "memories", "preference.md",
  ), "utf8"), "User prefers migration backups.");

  const memory = openMemory(value.paths);
  const profiles = [{ id: "profile-1", runtime: "codex", runtimeProfileId: "runtime-1" }];
  const marker = completeMemoryMigration({
    paths: value.paths, memoryEngine: memory.engine, profiles, now: () => 300,
  });
  assert.deepEqual(marker.imports, [{
    profileId: "profile-1", runtimeProfileId: "runtime-1", imported: 1,
  }]);
  assert.equal(memory.store.list("profile-1", { status: "candidate" }).length, 1);
  assert.deepEqual(completeMemoryMigration({
    paths: value.paths, memoryEngine: memory.engine, profiles, now: () => 400,
  }), marker, "完成标记存在时不得重复导入");
  assert.deepEqual(readMarker(value.paths), marker);
  assert.equal(memory.store.list("profile-1", { status: "candidate" }).length, 1);
  memory.engine.close();
  memory.store.close();
  memory.definitions.close();
  console.log("ok - Codex memory 迁移先备份、后导入并以完成标记幂等收口");

  const unsafe = fixture();
  try {
    const secondRoot = path.join(unsafe.paths.stateDir, "codex", "runtime-1", "memories");
    fs.mkdirSync(secondRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(secondRoot, "memory.md"), "legacy", { mode: 0o600 });
    assert.throws(() => ensureMemoryMigrationBackup({
      paths: unsafe.paths,
      activeServiceLock: { ...unsafe.activeServiceLock, ino: unsafe.activeServiceLock.ino + 1 },
    }), (error) => error.code === "BACKUP_SERVICE_ACTIVE");
    assert.equal(fs.existsSync(unsafe.paths.memoryMigrationPath), false);
    console.log("ok - Memory 迁移备份拒绝非当前 Service lock inode");
  } finally {
    fs.rmSync(unsafe.root, { recursive: true, force: true });
  }
  console.log("2 memory migration regression passed");
} finally {
  fs.rmSync(value.root, { recursive: true, force: true });
}
