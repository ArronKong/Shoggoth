"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createAuthorityBackup, verifyAuthorityBackup } = require("./authority-backup");
const { lstatIfExists, serviceError } = require("./security");

const PRE_NATIVE_RUNTIME_IMPORT_BACKUP_ID = "pre-native-runtime-import-v1";

function migrationError(code, message) { return serviceError(code, message); }

function hasManagedRuntimeState(paths) {
  for (const runtime of [
    "codex", "claude-code", "grok-build", "pi", "antigravity", "deepseek-harness",
  ]) {
    const root = path.join(paths.stateDir, runtime);
    const stat = lstatIfExists(root);
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw migrationError("NATIVE_IMPORT_TARGET_UNSAFE", "Runtime 导入目标根目录不安全");
    }
    if (fs.readdirSync(root).length > 0) return true;
  }
  return false;
}

function ensureNativeRuntimeImportBackup(options) {
  const { paths, activeServiceLock } = options;
  if (lstatIfExists(paths.nativeRuntimeImportPath) || !hasManagedRuntimeState(paths)) return null;
  const backupPath = path.join(paths.backupsDir, PRE_NATIVE_RUNTIME_IMPORT_BACKUP_ID);
  if (lstatIfExists(backupPath)) {
    return verifyAuthorityBackup({ paths, backupId: PRE_NATIVE_RUNTIME_IMPORT_BACKUP_ID });
  }
  return createAuthorityBackup({
    paths,
    backupId: PRE_NATIVE_RUNTIME_IMPORT_BACKUP_ID,
    now: options.now,
    activeServiceLock,
  });
}

module.exports = {
  PRE_NATIVE_RUNTIME_IMPORT_BACKUP_ID,
  ensureNativeRuntimeImportBackup,
  hasManagedRuntimeState,
};
