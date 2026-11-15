"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { atomicWritePrivateFile } = require("./agent-service/private-file");

const runFile = promisify(execFile);
const INSTALL_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;
const ERROR_DOMAINS = new Set(["NSCocoaErrorDomain", "NSPOSIXErrorDomain", "NSOSStatusErrorDomain",
  "NSURLErrorDomain", "SQRLUpdaterErrorDomain", "SQRLCodeSignatureErrorDomain", "SQRLZipArchiverErrorDomain"]);
const ERROR_CODES = new Set(["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "ENOENT", "EIO", "ETIMEDOUT"]);
const FAILURE_REASONS = new Set([
  "disk-space", "signature-invalid", "install-permission", "install-check-failed", "install-failed",
  "active-runs", "background-busy", "background-unavailable", "background-stop-failed", "background-restore-failed",
]);

function installFailureReason(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current) && seen.size < 4; current = current.cause) {
    seen.add(current);
    const message = typeof current.message === "string" ? current.message.slice(0, 16 * 1024) : "";
    if (["ENOSPC", "EDQUOT"].includes(current.code)
      || (current.domain === "NSCocoaErrorDomain" && current.code === 640)
      || (current.domain === "NSPOSIXErrorDomain" && [28, 69].includes(current.code))
      || /\bENOSPC\b|no space left|not enough (?:free )?(?:disk )?space|disk (?:is )?full|磁盘空间不足|没有足够的空间/iu.test(message)) {
      return "disk-space";
    }
    if (current.domain === "SQRLCodeSignatureErrorDomain"
      || /code signature.*(?:validation|invalid|failed)|signature.*(?:did not pass|could not be verified)/iu.test(message)) {
      return "signature-invalid";
    }
    if (["EACCES", "EPERM", "EROFS"].includes(current.code)
      || (current.domain === "SQRLUpdaterErrorDomain" && current.code === 8)
      || (current.domain === "NSCocoaErrorDomain" && [257, 513, 642].includes(current.code))
      || /permission denied|read.only volume|只读宗卷/iu.test(message)) return "install-permission";
  }
  return "install-failed";
}

async function checkDesktopAppInstallSpace({ downloadedFile, applicationPath,
  stagingPath = path.dirname(downloadedFile || "."), fileSystem = fs.promises, run = runFile } = {}) {
  if (!path.isAbsolute(downloadedFile || "") || !path.isAbsolute(applicationPath || "")) {
    throw new Error("APP_UPDATE_PACKAGE_UNAVAILABLE");
  }
  const archive = await fileSystem.stat(downloadedFile);
  if (!archive.isFile() || !Number.isSafeInteger(archive.size) || archive.size <= 0) {
    throw new Error("APP_UPDATE_PACKAGE_UNAVAILABLE");
  }
  // Read only ZIP metadata, never unpack a large update to estimate its size.
  // zipinfo is supplied by macOS; force English output for the numeric summary.
  const { stdout } = await run("/usr/bin/zipinfo", ["-t", downloadedFile], {
    env: { ...process.env, LC_ALL: "C", LANG: "C" }, timeout: 10_000, maxBuffer: 64 * 1024,
  });
  const summary = stdout.trim().match(/^\d+ files?, (\d+) bytes uncompressed, \d+ bytes compressed:/u);
  const unpackedBytes = summary ? Number(summary[1]) : NaN;
  const requiredBytes = archive.size + unpackedBytes + INSTALL_SPACE_RESERVE_BYTES;
  if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes <= 0 || !Number.isSafeInteger(requiredBytes)) {
    throw new Error("APP_UPDATE_PACKAGE_SIZE_UNKNOWN");
  }
  // With autoInstallOnAppQuit=false, Squirrel fetches another ZIP from the local
  // update server and extracts it only after the user asks to install. The
  // downloaded ZIP is therefore not the total disk space needed for installation.
  const locations = [
    { target: stagingPath, requiredBytes },
    { target: applicationPath, requiredBytes: unpackedBytes + INSTALL_SPACE_RESERVE_BYTES },
  ];
  let stagingAvailableBytes;
  for (const location of locations) {
    const disk = await fileSystem.statfs(location.target);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) throw new Error("APP_UPDATE_SPACE_UNKNOWN");
    if (stagingAvailableBytes === undefined) stagingAvailableBytes = availableBytes;
    if (availableBytes < location.requiredBytes) {
      return { blockReason: "disk-space", availableBytes, requiredBytes: location.requiredBytes };
    }
  }
  return { blockReason: null, availableBytes: stagingAvailableBytes, requiredBytes };
}

function recordAppUpdateFailure(app, { phase, reason, availableVersion, storage, error } = {}) {
  try {
    if (!["preflight", "prepare", "install", "recover"].includes(phase) || !FAILURE_REASONS.has(reason)) return false;
    const version = (value) => typeof value === "string" && /^[0-9A-Za-z.+-]{1,64}$/u.test(value) ? value : null;
    const record = { schemaVersion: 1, time: new Date().toISOString(), phase, reason,
      currentVersion: version(app.getVersion()), availableVersion: version(availableVersion) };
    if (ERROR_DOMAINS.has(error?.domain) && Number.isSafeInteger(error?.code)) {
      record.error = { domain: error.domain, code: error.code };
    } else if (ERROR_CODES.has(error?.code)) record.error = { code: error.code };
    if (storage && [storage.availableBytes, storage.requiredBytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
      record.storage = { availableBytes: storage.availableBytes, requiredBytes: storage.requiredBytes };
    }
    const root = app.getPath("userData");
    // Keep one bounded private diagnostic. Raw errors can contain local paths,
    // signed download URLs or credentials, and must not be persisted or sent to UI.
    atomicWritePrivateFile(path.join(root, "run", "app-update-diagnostics.json"), JSON.stringify(record), { trustedRoot: root });
    return true;
  } catch { return false; /* diagnostics must not hide the original failure, including ENOSPC */ }
}

module.exports = { INSTALL_SPACE_RESERVE_BYTES, checkDesktopAppInstallSpace, installFailureReason, recordAppUpdateFailure };
