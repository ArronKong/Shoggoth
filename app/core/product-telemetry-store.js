"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { LIMITS, exactObject, isUtcDay, isUuid, getUtcDay, validateTelemetryEvent } = require("./product-telemetry-schema");

const PAUSE_REASONS = new Set([null, "http_rejected", "protocol_error", "quota_limited"]);
const STATE_VERSION = 1;
const ownUid = typeof process.getuid === "function" ? process.getuid() : null;
const safeOwner = (stat) => ownUid === null || stat.uid === ownUid;
const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const fail = () => { throw new Error("TELEMETRY_STATE_UNSAFE"); };

function validateState(state) {
  try {
    if (!exactObject(state, ["version", "distinctId", "lastActiveDay", "transportFingerprint", "pausedReason", "outbox"])
      || state.version !== STATE_VERSION || !isUuid(state.distinctId) || !isUtcDay(state.lastActiveDay)
      || typeof state.transportFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(state.transportFingerprint)
      || !PAUSE_REASONS.has(state.pausedReason) || !Array.isArray(state.outbox)
      || Object.getPrototypeOf(state.outbox) !== Array.prototype
      || Reflect.ownKeys(state.outbox).length !== state.outbox.length + 1
      || state.outbox.length > LIMITS.events) return false;
    const days = new Set();
    const ids = new Set();
    for (const row of state.outbox) {
      if (!exactObject(row, ["event", "attemptsTotal", "attemptDay", "attemptsToday", "nextAttemptAt"])
        || !validateTelemetryEvent(row.event) || row.event.distinct_id !== state.distinctId
        || row.event.properties.report_day > state.lastActiveDay
        || days.has(row.event.properties.report_day) || ids.has(row.event.uuid)
        || !Number.isInteger(row.attemptsTotal) || row.attemptsTotal < 0 || row.attemptsTotal > LIMITS.attemptsTotal
        || !Number.isInteger(row.attemptsToday) || row.attemptsToday < 0
        || row.attemptsToday > LIMITS.attemptsPerDay || row.attemptsToday > row.attemptsTotal
        || getUtcDay(row.nextAttemptAt) === null) return false;
      if (row.attemptsTotal === 0) {
        if (row.attemptDay !== null || row.attemptsToday !== 0 || row.nextAttemptAt !== 0) return false;
      } else if (!isUtcDay(row.attemptDay) || row.attemptDay < row.event.properties.report_day || row.attemptsToday === 0) {
        return false;
      }
      days.add(row.event.properties.report_day);
      ids.add(row.event.uuid);
    }
    return Buffer.byteLength(JSON.stringify(state), "utf8") <= LIMITS.stateBytes;
  } catch { return false; }
}

// UI Host owns the sole writer (after its single-instance lock). Only this small
// private subtree is touched. Unexpected edits/removal, unsafe types and corrupt
// data pause telemetry instead of resetting identity or overwriting unknown data.
function createProductTelemetryStore(filePath) {
  if (!path.isAbsolute(filePath) || path.basename(filePath) !== "state.json") fail();
  const directory = path.dirname(filePath);
  const root = path.dirname(directory);
  const realRoot = fs.realpathSync(root);
  let directoryIdentity = null;

  function inspect() {
    if (fs.realpathSync(root) !== realRoot) fail();
    let dirStat;
    try { dirStat = fs.lstatSync(directory); }
    catch (error) {
      if (error.code === "ENOENT" && !directoryIdentity) return null;
      fail();
    }
    if (!dirStat.isDirectory() || !safeOwner(dirStat) || (dirStat.mode & 0o777) !== 0o700
      || (directoryIdentity && !sameFile(dirStat, directoryIdentity))) fail();
    directoryIdentity = dirStat;
    let fd;
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || !safeOwner(stat) || (stat.mode & 0o777) !== 0o600
        || stat.size > LIMITS.stateBytes) fail();
      const bytes = Buffer.alloc(stat.size + 1);
      const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const after = fs.fstatSync(fd);
      if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
        || !sameFile(fs.lstatSync(filePath), stat)) fail();
      const raw = bytes.subarray(0, size).toString("utf8");
      const state = JSON.parse(raw);
      if (!validateState(state)) fail();
      return { raw, state, stat };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      fail();
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* read-only */ } }
    }
  }

  let expected = inspect();
  function assertCurrent() {
    const actual = inspect();
    if (Boolean(expected) !== Boolean(actual)
      || (expected && (!sameFile(expected.stat, actual.stat) || expected.raw !== actual.raw))) fail();
  }

  function write(next) {
    if (!validateState(next)) fail();
    assertCurrent();
    if (!directoryIdentity) {
      fs.mkdirSync(directory, { mode: 0o700 });
      directoryIdentity = fs.lstatSync(directory);
    }
    // One bounded scratch file. A crash leaving it behind fails closed on the
    // next commit; never truncate/follow/delete a pre-existing scratch path.
    const tmp = `${filePath}.tmp`;
    let fd;
    let createdStat;
    let dirFd;
    try {
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      createdStat = fs.fstatSync(fd);
      const raw = JSON.stringify(next);
      fs.writeFileSync(fd, raw, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      assertCurrent();
      if (!sameFile(fs.lstatSync(tmp), createdStat)) fail();
      dirFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!sameFile(fs.fstatSync(dirFd), directoryIdentity)) fail();
      fs.renameSync(tmp, filePath);
      fs.fsyncSync(dirFd);
      const committed = inspect();
      if (!committed || committed.raw !== raw) fail();
      expected = committed;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve original failure */ } }
      if (dirFd !== undefined) { try { fs.closeSync(dirFd); } catch { /* preserve original failure */ } }
      // Cleanup only the scratch inode that this call successfully created.
      if (createdStat) {
        try { if (sameFile(fs.lstatSync(tmp), createdStat)) fs.unlinkSync(tmp); } catch { /* absent or unsafe */ }
      }
    }
  }

  return { state: expected?.state || null, assertCurrent, write };
}

module.exports = { STATE_VERSION, PAUSE_REASONS, validateState, createProductTelemetryStore };
