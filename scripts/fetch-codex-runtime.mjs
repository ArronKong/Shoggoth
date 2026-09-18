#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, chmod, lstat } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, "..");
const defaultManifestPath = path.join(defaultRepoRoot, "build", "codex-runtime-manifest.json");
const allowedPlatforms = ["darwin-arm64", "darwin-x64"];
const platformArchitectures = {
  "darwin-arm64": "arm64",
  "darwin-x64": "x64",
};
const platformTargets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};
const allowedDownloadHosts = new Set([
  "releases.openai.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const defaultMaxDownloadSize = 512 * 1024 * 1024;
const defaultCurlConnectTimeoutSeconds = 10;
const defaultCurlMaxTimeSeconds = 300;
const expectedPackageDirectories = [
  "bin",
  "codex-path",
  "codex-resources",
  "codex-resources/zsh",
  "codex-resources/zsh/bin",
];
const expectedPackageExecutables = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-path/rg",
  "codex-resources/zsh/bin/zsh",
];
const expectedPackageRegularFiles = ["codex-package.json"];

function runtimeError(platform, field, message) {
  return new Error(`[${platform}] ${field}: ${message}`);
}

export function validateDownloadUrl(value, context = "download URL") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${context}: invalid download URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${context}: download URL must use HTTPS`);
  }
  if (!allowedDownloadHosts.has(url.hostname)) {
    throw new Error(`${context}: download URL host is not allowed (${url.hostname})`);
  }
  if (url.username || url.password) {
    throw new Error(`${context}: download URL credentials are not allowed`);
  }
  if (url.port) {
    throw new Error(`${context}: download URL custom ports are not allowed`);
  }
  if (url.hash) {
    throw new Error(`${context}: download URL fragments are not allowed`);
  }
  return url;
}

export function selectPlatforms(requestedPlatform, hostPlatform = process.platform, hostArch = process.arch) {
  if (requestedPlatform === "all") {
    return [...allowedPlatforms];
  }
  if (requestedPlatform !== undefined) {
    if (!allowedPlatforms.includes(requestedPlatform)) {
      throw new Error(`[runtime] platform: unsupported platform ${requestedPlatform}`);
    }
    return [requestedPlatform];
  }

  if (hostPlatform !== "darwin" || !["arm64", "x64"].includes(hostArch)) {
    throw new Error(`[runtime] platform: unsupported host platform/architecture ${hostPlatform}/${hostArch}`);
  }
  return [`darwin-${hostArch}`];
}

function safeUrlForMessage(url) {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export async function downloadArchive(urlValue, destination, options = {}) {
  const maxRedirects = options.maxRedirects ?? 5;
  const httpsGet = options.httpsGet ?? https.get;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const sizeLimit = options.expectedSize ?? options.maxDownloadSize ?? defaultMaxDownloadSize;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("download timeout must be a positive integer");
  }
  if (!Number.isInteger(sizeLimit) || sizeLimit <= 0) {
    throw new Error("download size limit must be a positive integer");
  }
  let createdDestination = false;

  async function request(currentValue, redirectCount) {
    const currentUrl = validateDownloadUrl(currentValue);
    await new Promise((resolve, reject) => {
      let activePipeline;
      let output;
      let requestHandle;
      let response;
      let responseUsesPipeline = false;
      let settled = false;
      let timeoutHandle;

      function clearIdleTimeout() {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }

      function cancelActive() {
        response?.destroy?.();
        output?.destroy?.();
        requestHandle?.destroy?.();
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        clearIdleTimeout();
        cancelActive();
        const streamsClosed = activePipeline ? activePipeline.catch(() => {}) : Promise.resolve();
        streamsClosed.then(() => reject(error));
      }

      function armIdleTimeout() {
        if (settled) return;
        clearIdleTimeout();
        timeoutHandle = setTimeout(() => {
          fail(new Error(`download timeout after ${timeoutMs} ms`));
        }, timeoutMs);
      }

      function finish(value) {
        if (settled) return;
        settled = true;
        clearIdleTimeout();
        resolve(value);
      }

      armIdleTimeout();
      try {
        requestHandle = httpsGet(
          currentUrl,
          {
            headers: {
              Accept: "application/octet-stream",
              "User-Agent": "Shoggoth-Codex-Runtime-Fetcher",
            },
          },
          (incomingResponse) => {
            response = incomingResponse;
            const statusCode = response.statusCode ?? 0;
            const isRedirect = [301, 302, 303, 307, 308].includes(statusCode);

            response.on("error", (error) => {
              if (settled || responseUsesPipeline) return;
              const label = isRedirect ? "redirect response" : "response stream";
              fail(new Error(`download failed: ${label} failed (${error.message})`));
            });
            response.on("data", armIdleTimeout);
            armIdleTimeout();

            if (isRedirect) {
              const location = response.headers.location;
              if (!location) {
                fail(
                  new Error(
                    `download failed: redirect from ${safeUrlForMessage(currentUrl)} had no location`,
                  ),
                );
                return;
              }
              if (redirectCount >= maxRedirects) {
                fail(new Error(`download failed: too many HTTPS redirects from ${currentUrl.hostname}`));
                return;
              }
              let redirectedUrl;
              try {
                redirectedUrl = new URL(location, currentUrl);
                validateDownloadUrl(redirectedUrl);
              } catch (error) {
                fail(error);
                return;
              }
              response.once("end", () => {
                if (settled) return;
                settled = true;
                clearIdleTimeout();
                request(redirectedUrl, redirectCount + 1).then(resolve, reject);
              });
              response.resume();
              return;
            }

            if (statusCode < 200 || statusCode >= 300) {
              fail(
                new Error(`download failed: ${safeUrlForMessage(currentUrl)} returned HTTP ${statusCode}`),
              );
              return;
            }

            let downloadedBytes = 0;
            const byteLimiter = new Transform({
              transform(chunk, _encoding, callback) {
                downloadedBytes += chunk.length;
                if (downloadedBytes > sizeLimit) {
                  callback(new Error(`download exceeded size limit of ${sizeLimit} bytes`));
                  return;
                }
                callback(null, chunk);
              },
            });
            output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
            output.once("open", () => {
              createdDestination = true;
            });
            responseUsesPipeline = true;
            activePipeline = pipeline(response, byteLimiter, output);
            activePipeline.then(finish, fail);
          },
        );
        requestHandle.on("error", (error) => {
          fail(new Error(`download failed: network request error (${error.code ?? error.name})`));
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  try {
    await request(urlValue, 0);
  } catch (error) {
    if (createdDestination) {
      try {
        await rm(destination, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "download failed and partial destination cleanup failed",
        );
      }
    }
    throw error;
  }
}

export async function downloadArchiveWithCurl(urlValue, destination, options = {}) {
  const url = validateDownloadUrl(urlValue, "curl download URL");
  if (url.hostname !== "releases.openai.com") {
    throw new Error("curl download URL: curl transport only allows releases.openai.com");
  }

  const connectTimeoutSeconds =
    options.connectTimeoutSeconds ?? defaultCurlConnectTimeoutSeconds;
  const maxTimeSeconds = options.maxTimeSeconds ?? defaultCurlMaxTimeSeconds;
  const sizeLimit = options.expectedSize ?? options.maxDownloadSize ?? defaultMaxDownloadSize;
  if (!Number.isFinite(connectTimeoutSeconds) || connectTimeoutSeconds <= 0) {
    throw new Error("curl connect timeout must be a positive number");
  }
  if (!Number.isFinite(maxTimeSeconds) || maxTimeSeconds <= 0) {
    throw new Error("curl max time must be a positive number");
  }
  if (!Number.isInteger(sizeLimit) || sizeLimit <= 0) {
    throw new Error("curl download size limit must be a positive integer");
  }

  const args = [
    "--disable",
    "--fail",
    "--silent",
    "--show-error",
    "--connect-timeout",
    String(connectTimeoutSeconds),
    "--max-time",
    String(maxTimeSeconds),
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--location",
    "--max-redirs",
    "0",
    "--output",
    "-",
    "--url",
    url.href,
  ];
  const spawnImpl = options.spawnImpl ?? spawn;
  let child;
  try {
    child = spawnImpl("curl", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`could not start curl (${error.code ?? error.name})`);
  }

  let capturedStderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    capturedStderrBytes += Math.min(chunk.length, Math.max(0, 64 * 1024 - capturedStderrBytes));
  });
  child.stderr.on("error", () => {});

  let childClosed = false;
  const childExit = new Promise((resolve, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`could not start curl (${error.code ?? error.name})`));
    });
    child.once("close", (status, signal) => {
      childClosed = true;
      if (settled) return;
      settled = true;
      if (status === 0) {
        resolve();
        return;
      }
      if (status === 28) {
        reject(new Error(`curl download timed out after ${maxTimeSeconds} seconds`));
        return;
      }
      const suffix = signal ? ` (signal ${signal})` : "";
      reject(new Error(`curl exited with status ${status ?? "unknown"}${suffix}`));
    });
  });

  let downloadedBytes = 0;
  const byteLimiter = new Transform({
    transform(chunk, _encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > sizeLimit) {
        callback(new Error(`curl download exceeded size limit of ${sizeLimit} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
  const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
  let createdDestination = false;
  output.once("open", () => {
    createdDestination = true;
  });
  const outputPipeline = pipeline(child.stdout, byteLimiter, output);

  try {
    await Promise.all([outputPipeline, childExit]);
  } catch (error) {
    if (!childClosed) child.kill("SIGTERM");
    child.stdout.destroy();
    output.destroy();
    await Promise.allSettled([outputPipeline, childExit]);
    if (createdDestination) {
      try {
        await rm(destination, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "curl download failed and partial destination cleanup failed",
        );
      }
    }
    throw error;
  }
}

function normalizeArchiveEntry(rawEntry, platform) {
  if (!rawEntry || rawEntry.includes("\0") || rawEntry.startsWith("/")) {
    throw runtimeError(platform, "archiveEntry", `unsafe archive path ${JSON.stringify(rawEntry)}`);
  }

  let normalized = rawEntry;
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (!normalized || normalized.startsWith("-") || normalized.split("/").includes("..")) {
    throw runtimeError(platform, "archiveEntry", `unsafe archive path ${JSON.stringify(rawEntry)}`);
  }
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export async function runTar(args, platform, field, captureOutput, options = {}) {
  return await new Promise((resolve, reject) => {
    const spawnImpl = options.spawnImpl ?? spawn;
    const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const terminationGraceMs = options.terminationGraceMs ?? 2_000;
    const child = spawnImpl("tar", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationError;
    let terminationTimer;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(terminationTimer);
      if (error) reject(error);
      else resolve(value);
    }

    function terminate(error) {
      if (settled || terminationError) return;
      terminationError = error;
      try { child.kill("SIGKILL"); } catch {}
      terminationTimer = setTimeout(
        () => finish(runtimeError(platform, field, `${error.message}; tar did not close after termination`)),
        terminationGraceMs,
      );
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 1024 * 1024) {
        terminate(runtimeError(platform, field, "tar listing exceeded 1 MiB"));
        return;
      }
      if (captureOutput) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on("error", (error) => {
      finish(runtimeError(platform, field, `could not start tar (${error.code ?? error.name})`));
    });
    child.on("close", (status) => {
      if (terminationError) return finish(terminationError);
      if (status !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        return finish(runtimeError(platform, field, `tar exited with status ${status}${detail ? `: ${detail}` : ""}`));
      }
      finish(undefined, captureOutput ? Buffer.concat(stdout).toString("utf8") : "");
    });
    const timeoutTimer = setTimeout(
      () => terminate(runtimeError(platform, field, `tar timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
}

async function verifyArchive(archivePath, platform, platformManifest) {
  const archiveStat = await lstat(archivePath);
  if (!archiveStat.isFile()) {
    throw runtimeError(platform, "archive", "downloaded archive is not a regular file");
  }
  if (archiveStat.size !== platformManifest.archiveSize) {
    throw runtimeError(
      platform,
      "archiveSize",
      `expected ${platformManifest.archiveSize} bytes but downloaded ${archiveStat.size}`,
    );
  }

  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(archivePath)) {
    hash.update(chunk);
  }
  const actualSha256 = hash.digest("hex");
  if (actualSha256 !== platformManifest.archiveSha256) {
    throw runtimeError(
      platform,
      "archiveSha256",
      `expected ${platformManifest.archiveSha256} but downloaded ${actualSha256}`,
    );
  }
}

function assertExactEntries(platform, label, actual, expected) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((entry, index) => entry !== sortedExpected[index])
  ) {
    const missing = sortedExpected.filter((entry) => !sortedActual.includes(entry));
    const extra = sortedActual.filter((entry) => !sortedExpected.includes(entry));
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      extra.length > 0 ? `unexpected ${extra.join(", ")}` : "",
      sortedActual.length !== new Set(sortedActual).size ? "duplicate entries" : "",
    ].filter(Boolean).join("; ");
    throw runtimeError(platform, "packageEntries", `${label} do not match (${details || "different entries"})`);
  }
}

async function inspectArchive(archivePath, platform, packageEntries) {
  const output = await runTar(["-tzf", archivePath], platform, "archiveEntry", true);
  const rawEntries = output.split(/\r?\n/).filter(Boolean);
  const verboseOutput = await runTar(["-tvzf", archivePath], platform, "archiveEntry", true);
  const verboseEntries = verboseOutput.split(/\r?\n/).filter(Boolean);
  if (verboseEntries.length !== rawEntries.length) {
    throw runtimeError(platform, "archiveEntry", "could not determine every archive member type");
  }
  const directories = [];
  const regularFiles = [];

  for (const [index, rawEntry] of rawEntries.entries()) {
    const memberType = verboseEntries[index][0];
    const isDirectory = memberType === "d";
    if (isDirectory && /^(\.\/)+$/.test(rawEntry)) continue;
    const normalized = normalizeArchiveEntry(rawEntry, platform);
    if (isDirectory) {
      directories.push(normalized);
      continue;
    }
    if (memberType !== "-") {
      throw runtimeError(platform, "packageEntries", `archive member ${normalized} must be a regular file`);
    }
    regularFiles.push(normalized);
  }

  assertExactEntries(platform, "archive directories", directories, packageEntries.directories);
  assertExactEntries(
    platform,
    "archive files",
    regularFiles,
    [...packageEntries.executableFiles, ...packageEntries.regularFiles],
  );
}

function arraysEqual(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function validatePlatformManifest(platform, platformManifest) {
  if (!platformManifest || typeof platformManifest !== "object" || Array.isArray(platformManifest)) {
    throw runtimeError(platform, "platform", "manifest entry is missing");
  }
  const expectedArch = platformArchitectures[platform];
  if (platformManifest.arch !== expectedArch) {
    throw runtimeError(platform, "arch", `expected ${expectedArch}`);
  }
  if (!Number.isInteger(platformManifest.archiveSize) || platformManifest.archiveSize <= 0) {
    throw runtimeError(platform, "archiveSize", "must be a positive integer");
  }
  if (!/^[0-9a-f]{64}$/.test(platformManifest.archiveSha256)) {
    throw runtimeError(platform, "archiveSha256", "must be 64 lowercase hexadecimal characters");
  }
  if (typeof platformManifest.archiveEntry !== "string") {
    throw runtimeError(platform, "archiveEntry", "must be a string");
  }
  const normalizedEntry = normalizeArchiveEntry(platformManifest.archiveEntry, platform);
  if (normalizedEntry !== platformManifest.archiveEntry || platformManifest.archiveEntry.endsWith("/")) {
    throw runtimeError(platform, "archiveEntry", "must be a normalized non-directory path");
  }
  validateDownloadUrl(platformManifest.archiveUrl, `${platform}.archiveUrl download URL`);

  const expectedPackageDestination = `.vendor/codex/${expectedArch}/package`;
  const expectedDestination = `${expectedPackageDestination}/bin/codex`;
  const expectedHostDestination = `${expectedPackageDestination}/bin/codex-code-mode-host`;
  if (platformManifest.destination !== expectedDestination) {
    throw runtimeError(platform, "destination", `must equal ${expectedDestination}`);
  }
  if (platformManifest.packageDestination !== expectedPackageDestination) {
    throw runtimeError(platform, "packageDestination", `must equal ${expectedPackageDestination}`);
  }
  if (platformManifest.hostDestination !== expectedHostDestination) {
    throw runtimeError(platform, "hostDestination", `must equal ${expectedHostDestination}`);
  }
  const packageEntries = platformManifest.packageEntries;
  if (!packageEntries || typeof packageEntries !== "object" || Array.isArray(packageEntries)) {
    throw runtimeError(platform, "packageEntries", "must be an object");
  }
  if (
    !arraysEqual(packageEntries.directories, expectedPackageDirectories) ||
    !arraysEqual(packageEntries.executableFiles, expectedPackageExecutables) ||
    !arraysEqual(packageEntries.regularFiles, expectedPackageRegularFiles) ||
    Object.keys(packageEntries).sort().join(",") !== "directories,executableFiles,regularFiles"
  ) {
    throw runtimeError(platform, "packageEntries", "must match the pinned Codex package layout");
  }
  if (platformManifest.archiveEntry !== expectedPackageExecutables[0]) {
    throw runtimeError(platform, "archiveEntry", `must equal ${expectedPackageExecutables[0]}`);
  }
}

async function prepareDestination(repoRootValue, platform, platformManifest) {
  const repoRoot = path.resolve(repoRootValue);
  const repoRootStat = await lstat(repoRoot);
  if (!repoRootStat.isDirectory() || repoRootStat.isSymbolicLink()) {
    throw runtimeError(platform, "destination", "repoRoot must be a real directory");
  }
  const packageDestination = path.resolve(repoRoot, platformManifest.packageDestination);
  const relativeDestination = path.relative(repoRoot, packageDestination);
  if (
    relativeDestination === ".." ||
    relativeDestination.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDestination)
  ) {
    throw runtimeError(platform, "destination", "must stay inside repoRoot");
  }

  const destinationDirectory = path.dirname(packageDestination);
  let currentDirectory = repoRoot;
  for (const segment of path.relative(repoRoot, destinationDirectory).split(path.sep).filter(Boolean)) {
    currentDirectory = path.join(currentDirectory, segment);
    try {
      const currentStat = await lstat(currentDirectory);
      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
        throw runtimeError(platform, "destination", `${currentDirectory} is not a safe directory`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(currentDirectory);
    }
  }
  try {
    const packageStat = await lstat(packageDestination);
    if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
      throw runtimeError(platform, "packageDestination", "existing package must be a real directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    destination: path.resolve(repoRoot, platformManifest.destination),
    hostDestination: path.resolve(repoRoot, platformManifest.hostDestination),
    packageDestination,
    destinationDirectory,
  };
}

async function verifyExtractedPackage(stagingPackage, platform, packageEntries, runtimeVersion) {
  for (const relativeDirectory of packageEntries.directories) {
    const entryStat = await lstat(path.join(stagingPackage, relativeDirectory));
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
      throw runtimeError(platform, "packageEntries", `${relativeDirectory} must extract as a real directory`);
    }
  }
  for (const relativeFile of [...packageEntries.executableFiles, ...packageEntries.regularFiles]) {
    const entryStat = await lstat(path.join(stagingPackage, relativeFile));
    if (!entryStat.isFile() || entryStat.isSymbolicLink() || entryStat.nlink !== 1) {
      throw runtimeError(platform, "packageEntries", `${relativeFile} must extract as a regular non-linked file`);
    }
  }
  for (const relativeFile of packageEntries.executableFiles) {
    await chmod(path.join(stagingPackage, relativeFile), 0o755);
  }
  for (const relativeFile of packageEntries.regularFiles) {
    await chmod(path.join(stagingPackage, relativeFile), 0o644);
  }

  const metadataPath = path.join(stagingPackage, "codex-package.json");
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    throw runtimeError(platform, "codex-package.json", "must contain valid JSON");
  }
  const expectedMetadata = {
    layoutVersion: 1,
    version: runtimeVersion,
    target: platformTargets[platform],
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  };
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw runtimeError(platform, "codex-package.json", "must contain an object");
  }
  const actualKeys = Object.keys(metadata).sort();
  const expectedKeys = Object.keys(expectedMetadata).sort();
  if (!arraysEqual(actualKeys, expectedKeys)) {
    throw runtimeError(platform, "codex-package.json", "fields must match the pinned package contract");
  }
  for (const [field, expected] of Object.entries(expectedMetadata)) {
    if (metadata[field] !== expected) {
      throw runtimeError(platform, "codex-package.json", `${field} must equal ${JSON.stringify(expected)}`);
    }
  }
}

async function installPlatform({ manifest, repoRoot, platform, downloader, cleanup, renameImpl }) {
  const platformManifest = manifest.platforms?.[platform];
  validatePlatformManifest(platform, platformManifest);
  if (typeof manifest.runtime?.version !== "string" || !manifest.runtime.version) {
    throw runtimeError(platform, "runtime.version", "must be a non-empty string");
  }

  const { destination, hostDestination, packageDestination, destinationDirectory } = await prepareDestination(
    repoRoot,
    platform,
    platformManifest,
  );
  const temporaryDirectory = await mkdtemp(path.join(destinationDirectory, ".codex-install-"));
  const stagingPackage = await mkdtemp(path.join(destinationDirectory, ".codex-package-staging-"));
  const backupDestination = path.join(
    destinationDirectory,
    `.codex-package-backup-${crypto.randomUUID()}`,
  );
  let committed = false;
  let backupMoved = false;
  let primaryError;
  let result;
  try {
    const archivePath = path.join(temporaryDirectory, "runtime.tar.gz");
    try {
      await downloader(platformManifest.archiveUrl, archivePath, {
        expectedSize: platformManifest.archiveSize,
      });
    } catch (error) {
      throw runtimeError(platform, "archiveUrl", error.message);
    }
    await verifyArchive(archivePath, platform, platformManifest);

    await inspectArchive(archivePath, platform, platformManifest.packageEntries);
    await runTar(
      ["-xzf", archivePath, "-C", stagingPackage],
      platform,
      "packageEntries",
      false,
    );
    await verifyExtractedPackage(
      stagingPackage,
      platform,
      platformManifest.packageEntries,
      manifest.runtime.version,
    );

    try {
      await lstat(packageDestination);
      await renameImpl(packageDestination, backupDestination);
      backupMoved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw runtimeError(platform, "packageDestination", `could not create backup (${error.message})`);
    }
    try {
      await renameImpl(stagingPackage, packageDestination);
    } catch (commitError) {
      if (backupMoved) {
        try {
          await renameImpl(backupDestination, packageDestination);
          backupMoved = false;
        } catch (rollbackError) {
          throw new AggregateError(
            [commitError, rollbackError],
            `[${platform}] packageDestination: package commit failed and backup rollback failed`,
          );
        }
      }
      throw runtimeError(platform, "packageDestination", `package commit failed (${commitError.message})`);
    }
    committed = true;

    result = {
      platform,
      version: manifest.runtime.version,
      destination,
      hostDestination,
      packageDestination,
      archiveSha256: platformManifest.archiveSha256,
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  for (const cleanupPath of [temporaryDirectory, stagingPackage, ...(committed && backupMoved ? [backupDestination] : [])]) {
    try {
      await cleanup(cleanupPath, { recursive: true, force: true });
      if (cleanupPath === backupDestination) backupMoved = false;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `[${platform}] cleanup: install failed and cleanup failed`,
    );
  }
  if (cleanupErrors.length > 0 && committed) {
    throw new Error(
      `[${platform}] cleanup: install committed but cleanup failed (${cleanupErrors[0].message})`,
      { cause: cleanupErrors[0] },
    );
  }
  if (primaryError) throw primaryError;
  return result;
}

export async function fetchCodexRuntime(options = {}) {
  const manifestPath = path.resolve(options.manifestPath ?? defaultManifestPath);
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const requestedPlatforms = selectPlatforms(
    options.requestedPlatform,
    options.hostPlatform,
    options.hostArch,
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`[manifest] ${manifestPath}: could not read valid JSON (${error.code ?? error.name})`);
  }

  const downloader =
    options.downloader ??
    ((url, destination, downloadOptions) => {
      const transport =
        validateDownloadUrl(url).hostname === "releases.openai.com"
          ? (options.curlDownloader ?? downloadArchiveWithCurl)
          : (options.nodeDownloader ?? downloadArchive);
      return transport(url, destination, downloadOptions);
    });
  const cleanup = options.cleanup ?? rm;
  const renameImpl = options.renameImpl ?? rename;
  const results = [];
  for (const platform of requestedPlatforms) {
    results.push(await installPlatform({ manifest, repoRoot, platform, downloader, cleanup, renameImpl }));
  }
  return results;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--platform", "--manifest", "--repo-root"].includes(argument)) {
      throw new Error(`[cli] unsupported argument ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`[cli] ${argument} requires a value`);
    }
    index += 1;
    if (argument === "--platform") options.requestedPlatform = value;
    if (argument === "--manifest") options.manifestPath = path.resolve(value);
    if (argument === "--repo-root") options.repoRoot = path.resolve(value);
  }
  return options;
}

async function main() {
  const results = await fetchCodexRuntime(parseArguments(process.argv.slice(2)));
  for (const result of results) {
    console.log(JSON.stringify(result));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[fetch-codex-runtime] FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
