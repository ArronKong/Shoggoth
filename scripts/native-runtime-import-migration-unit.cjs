#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  PRE_NATIVE_RUNTIME_IMPORT_BACKUP_ID,
  ensureNativeRuntimeImportBackup,
} = require(path.join(ROOT, "app", "agent-service", "native-runtime-import-migration.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { ensurePrivateDirectoryTree } = require(path.join(
  ROOT, "app", "agent-service", "security.js",
));

function write(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, value, { mode: 0o600 });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-import-backup-"));
fs.chmodSync(root, 0o700);
try {
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
  write(path.join(paths.stateDir, "codex", "existing-profile", "AGENTS.md"), "# Existing\n");
  write(
    path.join(paths.nativeRuntimeImportStagingDir, "abandoned", "payload", "config.toml"),
    "staged\n",
  );

  const first = ensureNativeRuntimeImportBackup({ paths, now: () => 42 });
  assert.equal(first.manifest.backupId, PRE_NATIVE_RUNTIME_IMPORT_BACKUP_ID);
  assert.equal(first.manifest.createdAt, 42);
  assert.equal(first.manifest.entries.some((entry) => (
    entry.path === "codex/existing-profile/AGENTS.md"
  )), false);
  assert.equal(first.manifest.entries.some((entry) => (
    entry.path.startsWith("native-runtime-imports/staging/")
  )), false);

  const second = ensureNativeRuntimeImportBackup({ paths, now: () => 99 });
  assert.equal(second.manifest.rootDigest, first.manifest.rootDigest);
  assert.equal(second.manifest.createdAt, 42);

  write(paths.nativeRuntimeImportPath, JSON.stringify({ schemaVersion: 1 }));
  assert.equal(ensureNativeRuntimeImportBackup({ paths }), null);
  console.log("PASS native Runtime import migration backup unit");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
