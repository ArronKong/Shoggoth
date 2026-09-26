"use strict";

const fs = require("node:fs");
const path = require("node:path");

// electron-builder deliberately excludes better-sqlite3/build and prebuilds.
// All Electron database users must load the pinned, signed Resources/sqlite
// addon instead of relying on the npm package's development lookup paths.
function sqliteNativeBinding() {
  if (!process.versions.electron) return null;
  const packaged = path.resolve(__dirname, "../../../sqlite/better_sqlite3.node");
  const development = path.resolve(__dirname, "../../.vendor/sqlite", process.arch, "better_sqlite3.node");
  const target = __dirname.includes(`${path.sep}app.asar${path.sep}`) ? packaged : development;
  if (!fs.existsSync(target)) {
    throw Object.assign(new Error("The bundled SQLite runtime is unavailable"), { code: "SQLITE_RUNTIME_MISSING" });
  }
  return target;
}

module.exports = { sqliteNativeBinding };
