"use strict";

const fs = require("node:fs");
const { preparePrivateParent } = require("../private-file");
const { validatePrivateFileStat } = require("../security");

const invalid = () => Object.assign(new Error("Memory coordination database is outside its admitted scope"), { code: "MEMORY_LEASE_DATABASE_INVALID" });

// Native generation leases require rollback-journal SQLite locking. The
// ordinary Product database opener enables WAL and cannot serve this resource.
// Only the three fixed coordination siblings of this host's database are openable.
function openMemoryCoordinationDatabase(host, filename, options) {
  host.assertCurrent();
  const bases = [host.database.path, host.searchIndex?.databasePath].filter(Boolean);
  if (options !== undefined || typeof filename !== "string" || host.coordinationClosing
    || !bases.some(base => [".generation-writer.sqlite", ".generation-lock.sqlite", ".reindex-lock.sqlite"].some(suffix => filename === base + suffix))) throw invalid();
  preparePrivateParent(filename, host.paths.trustedRoot);
  try {
    const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.closeSync(fd);
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try { validatePrivateFileStat(fs.lstatSync(filename + suffix), filename + suffix); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let identity;
  try {
    identity = validatePrivateFileStat(fs.fstatSync(fd), filename);
    const header = Buffer.alloc(20), size = fs.readSync(fd, header, 0, header.length, 0);
    if (size && (size < 20 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0" || header[18] !== 1 || header[19] !== 1)) throw invalid();
  } finally { fs.closeSync(fd); }
  const assertPath = () => {
    const current = validatePrivateFileStat(fs.lstatSync(filename), filename);
    if (identity.dev !== current.dev || identity.ino !== current.ino) throw invalid();
  };
  assertPath();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(filename, { allowExtension: false });
  try { assertPath(); } catch (error) { db.close(); throw error; }
  host.coordinationDatabases ??= new Set();
  host.coordinationDatabases.add(db);
  const close = db.close.bind(db);
  db.close = () => {
    close();
    host.coordinationDatabases.delete(db);
    if (host.coordinationDatabases.size === 0) {
      for (const resolve of host.coordinationIdleWaiters || []) resolve();
      host.coordinationIdleWaiters?.clear();
    }
  };
  return db;
}

async function waitForMemoryCoordination(host) {
  if (!host.coordinationDatabases?.size) return;
  host.coordinationIdleWaiters ??= new Set();
  await new Promise(resolve => host.coordinationIdleWaiters.add(resolve));
}

module.exports = { openMemoryCoordinationDatabase, waitForMemoryCoordination };
