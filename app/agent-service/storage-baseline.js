"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { readPrivateFile, statIfExists } = require("./private-file");
const { STORE_SCHEMA_VERSION } = require("./product-store");
const { assertPluginCatalogBaseline } = require("./plugin-store");
const { serviceError } = require("./security");

// This unpublished build starts a new data baseline. Refuse old state before
// opening writers, credential stores or recovery workers; never reset on startup.
function assertCurrentStorageBaseline(paths) {
  const productSchemaVersion = paths.productSchemaVersion ?? STORE_SCHEMA_VERSION;
  const resetRequired = () => {
    throw serviceError("SHOGGOTH_DATA_RESET_REQUIRED",
      "此版本需要全新的 Shoggoth 数据目录，请退出 App 后重置 Shoggoth 本地数据再启动");
  };
  if (productSchemaVersion !== STORE_SCHEMA_VERSION) resetRequired();
  if (statIfExists(fs, paths.stateSnapshotPath)) {
    const snapshot = JSON.parse(readPrivateFile(paths.stateSnapshotPath, { fs, maxBytes: Number.MAX_SAFE_INTEGER }).toString("utf8"));
    if (snapshot?.schemaVersion !== productSchemaVersion) resetRequired();
  }
  if (statIfExists(fs, paths.eventLogPath)) {
    const bytes = readPrivateFile(paths.eventLogPath, { fs, maxBytes: Number.MAX_SAFE_INTEGER });
    const completeEnd = bytes.lastIndexOf(0x0a);
    if (completeEnd >= 0) {
      for (const line of bytes.subarray(0, completeEnd).toString("utf8").split("\n")) {
        if (JSON.parse(line)?.schemaVersion !== productSchemaVersion) resetRequired();
      }
    }
  }
  for (const [relative, field, version] of [
    ["chat-sessions.json", "version", 8], ["native-cron.json", "version", 3],
    ["native-kanban.json", "version", 4], ["account-auth-state-v2.json", "version", 2],
    ["runtime-session-ownership/ownership-v1.json", "version", 2],
    ["skills/registry.json", "schemaVersion", 2],
  ]) {
    const target = path.join(paths.stateDir, relative);
    if (statIfExists(fs, target)) {
      const data = JSON.parse(readPrivateFile(target, { fs, maxBytes: 64 * 1024 * 1024 }).toString("utf8"));
      if (data?.[field] !== version) resetRequired();
    }
  }
  const inspirationPath = path.join(paths.stateDir, "inspirations.sqlite");
  if (statIfExists(fs, inspirationPath)) {
    const db = require("./inspiration-database").openDatabase(inspirationPath, { readOnly: true });
    try {
      if (![0, 3].includes(db.prepare("PRAGMA user_version").get().user_version)) resetRequired();
    } finally { db.close(); }
  }
  // These files have no reader in this baseline. Detect them even if someone
  // removed only the Product snapshot, so an incomplete reset is explicit.
  for (const name of ["inspirations.json", "inspirations.migrated.json",
    "account-auth-state.json", "runtime-account-migration-v1.json",
    "memory-authority-v1.json", "native-runtime-imports", "legacy-runtime-homes"]) {
    if (statIfExists(fs, path.join(paths.stateDir, name))) resetRequired();
  }
  assertPluginCatalogBaseline(paths);
}

module.exports = { assertCurrentStorageBaseline };
