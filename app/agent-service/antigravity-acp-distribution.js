"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { readCodeIdentityAsync } = require("./code-identity");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

// Google's official Antigravity ACP server (ACP registry id `antigravity-acp`).
// Shoggoth pins one verified release; upgrading means editing this manifest
// and re-running the live acceptance, never following the registry silently.
const ANTIGRAVITY_ACP_SERVER_VERSION = "1.2.1";
const GOOGLE_TEAM_IDENTIFIER = "EQHXZ8M8AV";
const googleRequirement = (identifier) => `identifier "${identifier}" and anchor apple generic`
  + " and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */"
  + " and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */"
  + ` and certificate leaf[subject.OU] = ${GOOGLE_TEAM_IDENTIFIER}`;
const SERVER_FILE = "agy_acp_server.par";
const HARNESS_FILE = "localharness_external";
const RELEASES = Object.freeze({
  "darwin-arm64": Object.freeze({
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip",
    archiveBytes: 111_725_488,
    archiveSha256: "0fab9938812e6b32b3b543e65e4f3a0025ceef755413db13542d9a9b81ea803c",
    files: Object.freeze({
      [SERVER_FILE]: Object.freeze({
        bytes: 276_920_768,
        sha256: "c93c86c0f505fcdf8b13c695bed26d306141ef5446189d591397074d324db34e",
        requirement: googleRequirement("agy_acp_server"),
      }),
      [HARNESS_FILE]: Object.freeze({
        bytes: 120_663_872,
        sha256: "1b8a2b712ca312c9769e425b800bfbcceec4770f19736404474d1e8e50d65456",
        requirement: googleRequirement("localharness_external"),
      }),
    }),
  }),
});
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1_000;
const PROXY_ENV = Object.freeze([
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
]);
const verifiedFiles = new Map();

function distributionError(code, message) {
  return serviceError(code, message);
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function releaseFor(platform, arch) {
  const release = RELEASES[platformKey(platform, arch)];
  if (!release) {
    throw distributionError(
      "ANTIGRAVITY_ACP_PLATFORM_UNSUPPORTED",
      "The official Antigravity ACP server has no verified build for this platform",
    );
  }
  return release;
}

function installRoot(paths) {
  if (!paths || typeof paths.stateDir !== "string" || !path.isAbsolute(paths.stateDir)
    || typeof paths.trustedRoot !== "string" || !path.isAbsolute(paths.trustedRoot)) {
    throw distributionError("ANTIGRAVITY_ACP_PATHS_INVALID", "Antigravity ACP install paths are invalid");
  }
  return path.join(paths.stateDir, "runtime-bin", "antigravity-acp");
}

function installDirectory(paths) {
  return path.join(installRoot(paths), ANTIGRAVITY_ACP_SERVER_VERSION);
}

function safeFile(fileSystem, target, expectedBytes) {
  let stat;
  try { stat = fileSystem.lstatSync(target); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw distributionError("ANTIGRAVITY_ACP_INTEGRITY_FAILED", "Antigravity ACP server file is unreadable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== expectedBytes
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || (stat.mode & 0o022) !== 0 || (stat.mode & 0o100) === 0) {
    throw distributionError("ANTIGRAVITY_ACP_INTEGRITY_FAILED", "Antigravity ACP server file is unsafe");
  }
  return stat;
}

// Cheap, synchronous shape check used when resolving a RuntimeAccount. The
// full hash and signature verification is `verifyAntigravityAcpServer`.
function resolveAntigravityAcpServer(options = {}) {
  const fileSystem = options.fs || fs;
  const release = releaseFor(options.platform, options.arch);
  const directory = installDirectory(options.paths);
  const serverPath = path.join(directory, SERVER_FILE);
  const harnessPath = path.join(directory, HARNESS_FILE);
  let directoryStat;
  try { directoryStat = fileSystem.lstatSync(directory); } catch (error) {
    if (error?.code !== "ENOENT") {
      throw distributionError("ANTIGRAVITY_ACP_INTEGRITY_FAILED", "Antigravity ACP install directory is unreadable");
    }
  }
  if (!directoryStat) {
    throw distributionError("ANTIGRAVITY_ACP_NOT_INSTALLED", "The official Antigravity ACP server is not installed");
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())) {
    throw distributionError("ANTIGRAVITY_ACP_INTEGRITY_FAILED", "Antigravity ACP install directory is unsafe");
  }
  const server = safeFile(fileSystem, serverPath, release.files[SERVER_FILE].bytes);
  const harness = safeFile(fileSystem, harnessPath, release.files[HARNESS_FILE].bytes);
  if (!server || !harness) {
    throw distributionError("ANTIGRAVITY_ACP_NOT_INSTALLED", "The official Antigravity ACP server is incomplete");
  }
  return Object.freeze({ version: ANTIGRAVITY_ACP_SERVER_VERSION, directory, serverPath, harnessPath });
}

function sha256File(fileSystem, target) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fileSystem.createReadStream(target);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyFile(fileSystem, target, expected, readIdentity) {
  const stat = safeFile(fileSystem, target, expected.bytes);
  if (!stat) throw distributionError("ANTIGRAVITY_ACP_NOT_INSTALLED", "Antigravity ACP server file is missing");
  const key = JSON.stringify([target, stat.dev, stat.ino, stat.size, stat.mtimeMs, expected.sha256]);
  if (verifiedFiles.get(target) === key) return;
  const digest = await sha256File(fileSystem, target);
  if (digest !== expected.sha256) {
    throw distributionError("ANTIGRAVITY_ACP_INTEGRITY_FAILED", "Antigravity ACP server hash does not match");
  }
  let identity;
  try { identity = await readIdentity(target); } catch {
    throw distributionError("ANTIGRAVITY_ACP_INTEGRITY_FAILED", "Antigravity ACP server signature is invalid");
  }
  if (identity?.teamIdentifier !== GOOGLE_TEAM_IDENTIFIER
    || identity?.designatedRequirement !== expected.requirement) {
    throw distributionError("ANTIGRAVITY_ACP_INTEGRITY_FAILED", "Antigravity ACP server is not signed by Google");
  }
  verifiedFiles.set(target, key);
}

async function verifyAntigravityAcpServer(options = {}) {
  const fileSystem = options.fs || fs;
  const release = releaseFor(options.platform, options.arch);
  const resolved = resolveAntigravityAcpServer(options);
  const readIdentity = options.readCodeIdentity || ((target) => readCodeIdentityAsync(target));
  await verifyFile(fileSystem, resolved.serverPath, release.files[SERVER_FILE], readIdentity);
  await verifyFile(fileSystem, resolved.harnessPath, release.files[HARNESS_FILE], readIdentity);
  return resolved;
}

async function antigravityAcpInstallState(options = {}) {
  try {
    const resolved = await verifyAntigravityAcpServer(options);
    return Object.freeze({ state: "installed", version: resolved.version });
  } catch (error) {
    const state = {
      ANTIGRAVITY_ACP_NOT_INSTALLED: "missing",
      ANTIGRAVITY_ACP_PLATFORM_UNSUPPORTED: "unsupported",
    }[error?.code] || "corrupt";
    return Object.freeze({ state, version: ANTIGRAVITY_ACP_SERVER_VERSION, code: error?.code || null });
  }
}

function run(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error) => (error ? reject(error) : resolve()));
  });
}

function removeTree(fileSystem, target) {
  try { fileSystem.rmSync(target, { recursive: true, force: true }); } catch {}
}

// Explicit user action only (Settings). Downloads Google's archive over HTTPS,
// verifies it, and atomically moves the verified tree into place.
async function installAntigravityAcpServer(options = {}) {
  const fileSystem = options.fs || fs;
  const release = releaseFor(options.platform, options.arch);
  const root = installRoot(options.paths);
  const directory = installDirectory(options.paths);
  const execFileImpl = options.execFile || execFile;
  try { return await verifyAntigravityAcpServer(options); } catch (error) {
    if (error?.code === "ANTIGRAVITY_ACP_PLATFORM_UNSUPPORTED") throw error;
  }
  ensurePrivateDirectoryTree(root, options.paths.trustedRoot);
  const staging = fileSystem.mkdtempSync(path.join(root, ".staging-"));
  const archive = path.join(staging, "archive.zip");
  const extracted = path.join(staging, "tree");
  const parentEnv = options.parentEnv || process.env;
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const key of PROXY_ENV) {
    if (typeof parentEnv[key] === "string" && parentEnv[key].length > 0) env[key] = parentEnv[key];
  }
  try {
    try {
      await run(execFileImpl, "/usr/bin/curl", [
        "--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2",
        "--max-filesize", String(release.archiveBytes), "--output", archive, release.url,
      ], {
        env, timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 64 * 1024,
        // A sign-in canceled from the app stops the download at once.
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      throw distributionError("ANTIGRAVITY_ACP_DOWNLOAD_FAILED", "Downloading the Antigravity ACP server failed");
    }
    const archiveStat = fileSystem.lstatSync(archive);
    if (!archiveStat.isFile() || archiveStat.size !== release.archiveBytes
      || await sha256File(fileSystem, archive) !== release.archiveSha256) {
      throw distributionError("ANTIGRAVITY_ACP_INTEGRITY_FAILED", "The downloaded Antigravity ACP archive does not match");
    }
    fileSystem.mkdirSync(extracted, { mode: 0o700 });
    try {
      await run(execFileImpl, "/usr/bin/ditto", ["-x", "-k", archive, extracted], {
        env: { PATH: "/usr/bin:/bin" }, timeout: 5 * 60 * 1_000, maxBuffer: 64 * 1024,
      });
    } catch {
      throw distributionError("ANTIGRAVITY_ACP_INSTALL_FAILED", "Extracting the Antigravity ACP server failed");
    }
    const entries = fileSystem.readdirSync(extracted).sort();
    if (JSON.stringify(entries) !== JSON.stringify(Object.keys(release.files).sort())) {
      throw distributionError("ANTIGRAVITY_ACP_INTEGRITY_FAILED", "The Antigravity ACP archive layout changed");
    }
    for (const name of entries) fileSystem.chmodSync(path.join(extracted, name), 0o755);
    fileSystem.chmodSync(extracted, 0o700);
    removeTree(fileSystem, directory);
    fileSystem.renameSync(extracted, directory);
    return await verifyAntigravityAcpServer(options);
  } catch (error) {
    if (!error?.code?.startsWith?.("ANTIGRAVITY_ACP_")) {
      throw distributionError("ANTIGRAVITY_ACP_INSTALL_FAILED", "Installing the Antigravity ACP server failed");
    }
    throw error;
  } finally {
    removeTree(fileSystem, staging);
  }
}

module.exports = {
  ANTIGRAVITY_ACP_SERVER_VERSION,
  GOOGLE_TEAM_IDENTIFIER,
  antigravityAcpInstallState,
  installAntigravityAcpServer,
  resolveAntigravityAcpServer,
  verifyAntigravityAcpServer,
};
