"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createAuthorityBackup, verifyAuthorityBackup } = require("./authority-backup");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");

const PRE_MEMORY_AUTHORITY_BACKUP_ID = "pre-shoggoth-memory-v1";
const MEMORY_MIGRATION_SCHEMA_VERSION = 1;

function migrationError(code, message) { return serviceError(code, message); }

function assertSafeDirectory(target) {
  const stat = lstatIfExists(target);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw migrationError("MEMORY_MIGRATION_SOURCE_UNSAFE", "Codex memory 迁移源不安全");
  }
  return stat;
}

function nativeMemoryRoots(paths) {
  const codexRoot = path.join(paths.stateDir, "codex");
  if (!assertSafeDirectory(codexRoot)) return [];
  const roots = [];
  for (const profileName of fs.readdirSync(codexRoot).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(profileName)) continue;
    const profileRoot = path.join(codexRoot, profileName);
    if (!assertSafeDirectory(profileRoot)) continue;
    const memoryRoot = path.join(profileRoot, "memories");
    if (!assertSafeDirectory(memoryRoot)) continue;
    const files = fs.readdirSync(memoryRoot);
    if (files.length > 0) roots.push({ runtimeProfileId: profileName, root: memoryRoot });
  }
  return roots;
}

function readMarker(paths) {
  if (!lstatIfExists(paths.memoryMigrationPath)) return null;
  let marker;
  try { marker = JSON.parse(readPrivateFile(paths.memoryMigrationPath, { maxBytes: 64 * 1024 }).toString("utf8")); }
  catch (error) { if (error?.code) throw error; throw migrationError("MEMORY_MIGRATION_MARKER_INVALID", "Memory migration marker 无效"); }
  if (!marker || marker.schemaVersion !== MEMORY_MIGRATION_SCHEMA_VERSION
    || !Number.isSafeInteger(marker.completedAt) || marker.completedAt < 0
    || !Array.isArray(marker.imports)) {
    throw migrationError("MEMORY_MIGRATION_MARKER_INVALID", "Memory migration marker 无效");
  }
  return marker;
}

function ensureMemoryMigrationBackup(options) {
  const { paths, activeServiceLock } = options;
  if (readMarker(paths)) return null;
  if (nativeMemoryRoots(paths).length === 0) return null;
  const backupPath = path.join(paths.backupsDir, PRE_MEMORY_AUTHORITY_BACKUP_ID);
  if (lstatIfExists(backupPath)) {
    return verifyAuthorityBackup({ paths, backupId: PRE_MEMORY_AUTHORITY_BACKUP_ID });
  }
  return createAuthorityBackup({
    paths,
    backupId: PRE_MEMORY_AUTHORITY_BACKUP_ID,
    now: options.now,
    activeServiceLock,
    // This API is retained only for an explicit legacy migration. Normal
    // startup no longer calls it. Its rollback contract still needs the old
    // Codex memories that it is about to import.
    runtimeHomeMode: "legacy-full",
  });
}

function completeMemoryMigration(options) {
  const { paths, memoryEngine, profiles } = options;
  const existing = readMarker(paths);
  if (existing) return existing;
  const roots = new Map(nativeMemoryRoots(paths).map((entry) => [entry.runtimeProfileId, entry.root]));
  const imports = [];
  for (const profile of profiles) {
    if (profile.runtime !== "codex") continue;
    const root = roots.get(profile.runtimeProfileId);
    if (!root) continue;
    const result = memoryEngine.importCodexNative({ profileId: profile.id, root });
    imports.push({ profileId: profile.id, runtimeProfileId: profile.runtimeProfileId, imported: result.imported });
  }
  const marker = {
    schemaVersion: MEMORY_MIGRATION_SCHEMA_VERSION,
    completedAt: options.now ? options.now() : Date.now(),
    imports,
  };
  atomicWritePrivateFile(paths.memoryMigrationPath, `${JSON.stringify(marker)}\n`, {
    trustedRoot: paths.trustedRoot,
  });
  return marker;
}

module.exports = {
  MEMORY_MIGRATION_SCHEMA_VERSION,
  PRE_MEMORY_AUTHORITY_BACKUP_ID,
  completeMemoryMigration,
  ensureMemoryMigrationBackup,
  nativeMemoryRoots,
  readMarker,
};
