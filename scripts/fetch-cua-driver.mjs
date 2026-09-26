#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "build", "cua-driver-manifest.json");

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function exactManifest(value) {
  const keys = [
    "schemaVersion", "version", "contractVersion", "archiveUrl", "archiveSha256",
    "archiveSizeBytes", "binarySha256", "binarySizeBytes", "architectures", "destination",
    "nodePackages",
  ];
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
    && value.schemaVersion === 1
    && value.version === "0.22.0"
    && value.contractVersion === "0.7.0"
    && /^https:\/\/github\.com\/trycua\/cua\/releases\/download\/cua-driver-rs-v0\.22\.0\//u.test(value.archiveUrl)
    && /^[a-f0-9]{64}$/u.test(value.archiveSha256)
    && /^[a-f0-9]{64}$/u.test(value.binarySha256)
    && Number.isSafeInteger(value.archiveSizeBytes) && value.archiveSizeBytes > 0
    && Number.isSafeInteger(value.binarySizeBytes) && value.binarySizeBytes > 0
    && JSON.stringify(value.architectures) === JSON.stringify(["arm64", "x86_64"])
    && value.destination === ".vendor/cua/package/cua-driver"
    && validNodePackages(value.nodePackages);
}

function validNodePackages(packages) {
  const expected = [
    ["@trycua/cua-driver-darwin-arm64", "0.22.0", "arm64"],
    ["@ubjs/node-darwin-arm64", "0.31.0-3", "arm64"],
    ["@trycua/cua-driver-darwin-x64", "0.22.0", "x64"],
    ["@ubjs/node-darwin-x64", "0.31.0-3", "x64"],
  ];
  return Array.isArray(packages) && packages.length === expected.length
    && packages.every((entry, index) => {
      const [name, version, arch] = expected[index];
      const leaf = name.slice(name.indexOf("/") + 1);
      const keys = [
        "name", "version", "arch", "archiveUrl", "archiveSha256", "archiveSizeBytes",
        "destination",
      ];
      return entry && typeof entry === "object" && !Array.isArray(entry)
        && Object.keys(entry).sort().join("\0") === [...keys].sort().join("\0")
        && entry.name === name && entry.version === version && entry.arch === arch
        && entry.archiveUrl === `https://registry.npmjs.org/${name}/-/${leaf}-${version}.tgz`
        && /^[a-f0-9]{64}$/u.test(entry.archiveSha256)
        && Number.isSafeInteger(entry.archiveSizeBytes) && entry.archiveSizeBytes > 0
        && entry.destination === `.vendor/cua/node-modules/${arch}/node_modules/${name}`;
    });
}

async function download(url, target, maxBytes) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { fs.unlinkSync(target); } catch {}
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`CUA_DOWNLOAD_FAILED:${response.status}`);
      const file = fs.openSync(target, "wx", 0o600);
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw new Error("CUA_ARCHIVE_TOO_LARGE");
          fs.writeSync(file, chunk);
        }
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      return bytes;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function assertSafeArchive(archive) {
  const entries = execFileSync("/usr/bin/tar", ["-tzf", archive], {
    encoding: "utf8", timeout: 30_000,
  }).trim().split("\n").filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => (
    !entry.startsWith("package/") || entry.startsWith("/")
    || entry.split("/").includes("..") || entry.includes("\0")
  ))) throw new Error("CUA_NODE_ARCHIVE_LAYOUT_INVALID");
  const verbose = execFileSync("/usr/bin/tar", ["-tvzf", archive], {
    encoding: "utf8", timeout: 30_000,
  }).trim().split("\n").filter(Boolean);
  if (verbose.length !== entries.length || verbose.some((line) => !["-", "d"].includes(line[0]))) {
    throw new Error("CUA_NODE_ARCHIVE_TYPE_INVALID");
  }
}

function assertSafeTree(target) {
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error("CUA_NODE_PACKAGE_LINK_INVALID");
    if (stat.isDirectory()) assertSafeTree(child);
    else if (!stat.isFile() || stat.nlink !== 1) throw new Error("CUA_NODE_PACKAGE_TYPE_INVALID");
  }
}

async function obtainArchive(entry, target) {
  const localRoot = process.env.SHOGGOTH_CUA_NODE_ARCHIVE_DIR;
  if (localRoot !== undefined) {
    if (!path.isAbsolute(localRoot)) throw new Error("CUA_NODE_LOCAL_ARCHIVE_DIR_INVALID");
    const source = path.join(localRoot, path.basename(new URL(entry.archiveUrl).pathname));
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("CUA_NODE_LOCAL_ARCHIVE_INVALID");
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    return stat.size;
  }
  return download(entry.archiveUrl, target, entry.archiveSizeBytes);
}

function replaceGeneratedDirectory(current, staged) {
  const previous = `${current}.previous-${process.pid}`;
  if (fs.existsSync(previous)) throw new Error("CUA_NODE_PREVIOUS_DIRECTORY_EXISTS");
  const exists = fs.existsSync(current);
  if (exists) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("CUA_NODE_DESTINATION_INVALID");
    fs.renameSync(current, previous);
  }
  try {
    fs.renameSync(staged, current);
  } catch (error) {
    if (exists) fs.renameSync(previous, current);
    throw error;
  }
  if (exists) fs.rmSync(previous, { recursive: true, force: false });
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!exactManifest(manifest)) throw new Error("CUA_MANIFEST_INVALID");
const destination = path.join(repoRoot, ...manifest.destination.split("/"));
const binaryReady = fs.existsSync(destination)
  && fs.statSync(destination).isFile()
  && fs.statSync(destination).size === manifest.binarySizeBytes
  && digest(destination) === manifest.binarySha256;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-cua-fetch-"));
const stagedNodeRoot = path.join(repoRoot, ".vendor", "cua", `.node-modules-${process.pid}.tmp`);
try {
  if (!binaryReady) {
    const archive = path.join(tempRoot, "cua-driver.tar.gz");
    const localArchive = process.env.SHOGGOTH_CUA_ARCHIVE_PATH;
    let bytes;
    if (localArchive !== undefined) {
      if (!path.isAbsolute(localArchive)) throw new Error("CUA_LOCAL_ARCHIVE_INVALID");
      const sourceStat = fs.lstatSync(localArchive);
      if (!sourceStat.isFile() || sourceStat.nlink !== 1) throw new Error("CUA_LOCAL_ARCHIVE_INVALID");
      fs.copyFileSync(localArchive, archive, fs.constants.COPYFILE_EXCL);
      bytes = fs.statSync(archive).size;
    } else {
      bytes = await download(manifest.archiveUrl, archive, manifest.archiveSizeBytes);
    }
    if (bytes !== manifest.archiveSizeBytes || digest(archive) !== manifest.archiveSha256) {
      throw new Error("CUA_ARCHIVE_INTEGRITY_FAILED");
    }
    const entries = execFileSync("/usr/bin/tar", ["-tzf", archive], {
      encoding: "utf8", timeout: 30_000,
    }).trim().split("\n");
    if (!entries.includes("cua-driver") || entries.some((entry) => (
      entry.startsWith("/") || entry.split("/").includes("..") || entry.includes("\0")
    ))) throw new Error("CUA_ARCHIVE_LAYOUT_INVALID");
    const extracted = path.join(tempRoot, "extract");
    fs.mkdirSync(extracted, { mode: 0o700 });
    execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", extracted, "cua-driver"], {
      timeout: 60_000, stdio: "ignore",
    });
    const binary = path.join(extracted, "cua-driver");
    const stat = fs.lstatSync(binary);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== manifest.binarySizeBytes
      || digest(binary) !== manifest.binarySha256) throw new Error("CUA_BINARY_INTEGRITY_FAILED");
    const archs = execFileSync("/usr/bin/lipo", ["-archs", binary], {
      encoding: "utf8", timeout: 10_000,
    }).trim().split(/\s+/u).sort();
    if (JSON.stringify(archs) !== JSON.stringify([...manifest.architectures].sort())) {
      throw new Error("CUA_BINARY_ARCHITECTURE_INVALID");
    }
    const destinationDir = path.dirname(destination);
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
    const staged = path.join(destinationDir, `.cua-driver-${process.pid}.tmp`);
    fs.copyFileSync(binary, staged, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, destination);
  }

  if (fs.existsSync(stagedNodeRoot)) throw new Error("CUA_NODE_STAGING_EXISTS");
  fs.mkdirSync(stagedNodeRoot, { recursive: true, mode: 0o700 });
  for (const [index, entry] of manifest.nodePackages.entries()) {
    const archive = path.join(tempRoot, `node-${index}.tgz`);
    const bytes = await obtainArchive(entry, archive);
    if (bytes !== entry.archiveSizeBytes || digest(archive) !== entry.archiveSha256) {
      throw new Error("CUA_NODE_ARCHIVE_INTEGRITY_FAILED");
    }
    assertSafeArchive(archive);
    const extracted = path.join(tempRoot, `node-${index}`);
    fs.mkdirSync(extracted, { mode: 0o700 });
    execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", extracted], {
      timeout: 60_000, stdio: "ignore",
    });
    const packageRoot = path.join(extracted, "package");
    assertSafeTree(packageRoot);
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (packageJson.name !== entry.name || packageJson.version !== entry.version
      || JSON.stringify(packageJson.os) !== JSON.stringify(["darwin"])
      || JSON.stringify(packageJson.cpu) !== JSON.stringify([entry.arch])) {
      throw new Error("CUA_NODE_PACKAGE_METADATA_INVALID");
    }
    const prefix = `.vendor/cua/node-modules/${entry.arch}/node_modules/`;
    const relative = entry.destination.slice(prefix.length);
    const stagedDestination = path.join(stagedNodeRoot, entry.arch, "node_modules", relative);
    fs.mkdirSync(path.dirname(stagedDestination), { recursive: true, mode: 0o700 });
    fs.cpSync(packageRoot, stagedDestination, { recursive: true, force: false, errorOnExist: true });
  }
  const nodeRoot = path.join(repoRoot, ".vendor", "cua", "node-modules");
  replaceGeneratedDirectory(nodeRoot, stagedNodeRoot);
  process.stdout.write(`Cua Driver ${manifest.version} and arm64/x64 Node runtimes verified\n`);
} finally {
  if (fs.existsSync(stagedNodeRoot)) fs.rmSync(stagedNodeRoot, { recursive: true, force: false });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
