#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");

const SOURCE_FILE = "app/agent-service.js";
const MARKER = "const CHAT_RELIABILITY_COMPATIBILITY_BUILD = false;";
const COMPATIBILITY_MARKER = "const CHAT_RELIABILITY_COMPATIBILITY_BUILD = true;";
const PROFILE = "chat-reliability-compatible-rollback";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function checkedPath(file, isDirectory) {
  const info = fs.lstatSync(file);
  assert.equal(fs.realpathSync(file), file, `Use a canonical, symlink-free path: ${file}`);
  assert.ok(info.uid === process.getuid() && !(info.mode & 0o022), `Unsafe ownership or mode: ${file}`);
  assert.ok(isDirectory ? info.isDirectory() : info.isFile() && info.nlink === 1,
    `Expected an independent ${isDirectory ? "directory" : "regular file"}: ${file}`);
  return info;
}

function readPinnedFile(file, expected) {
  const info = checkedPath(file, false);
  const bytes = fs.readFileSync(file, { flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  if (expected !== undefined) assert.equal(sha256(bytes), expected, `Frozen digest differs: ${file}`);
  return { info, bytes };
}

function writeExclusive(file, bytes, mode) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.unlinkSync(file);
    throw error;
  } finally { fs.closeSync(fd); }
}

function stage({ source, arch }) {
  assert.ok(typeof source === "string" && path.isAbsolute(source) && path.normalize(source) === source
    && path.basename(source) === "source", "Pass the absolute, canonical path of an independent frozen source directory");
  assert.ok(["arm64", "x64"].includes(arch), "Pass --arch arm64 or --arch x64");
  const stageRoot = path.dirname(source);
  const workspace = fs.realpathSync(path.join(__dirname, ".."));
  assert.ok(source !== workspace && !source.startsWith(`${workspace}${path.sep}`), "The live workspace cannot be staged");
  assert.equal(checkedPath(stageRoot, true).mode & 0o777, 0o700, "The independent stage parent must have mode 0700");
  checkedPath(source, true);
  checkedPath(path.join(source, "app"), true);
  assert.ok(!fs.existsSync(path.join(source, ".git")), "A Git working tree cannot be staged in place");

  const manifestPath = path.join(stageRoot, "source-manifest.json");
  const { bytes: manifestBytes } = readPinnedFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const originalHash = manifest?.files?.[SOURCE_FILE];
  assert.match(manifest?.head ?? "", /^[a-f0-9]{40}$/u, "Frozen source HEAD is missing");
  assert.match(originalHash ?? "", /^[a-f0-9]{64}$/u, `Frozen digest is missing for ${SOURCE_FILE}`);
  assert.match(manifest.files["package.json"] ?? "", /^[a-f0-9]{64}$/u, "Frozen package digest is missing");
  const { bytes: packageBytes } = readPinnedFile(path.join(source, "package.json"), manifest.files["package.json"]);
  const { version } = JSON.parse(packageBytes);
  assert.match(version, /^\d+\.\d+\.\d+$/u, "Invalid package version");

  const target = path.join(source, SOURCE_FILE);
  const receiptPath = path.join(stageRoot, "chat-compatibility-build.json");
  assert.ok(!fs.existsSync(receiptPath), "A compatibility build receipt already exists");
  const { info, bytes } = readPinnedFile(target, originalHash);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const declarations = text.split(/\r?\n/u).filter(line => /^\s*const\s+CHAT_RELIABILITY_COMPATIBILITY_BUILD\b/u.test(line));
  assert.deepEqual(declarations, [MARKER], "Expected one exact active package marker");
  const line = text.indexOf(`\n${MARKER}`) + 1;
  assert.ok((line > 0 || text.startsWith(MARKER)) && text.slice(line, line + MARKER.length) === MARKER);
  const patched = Buffer.from(`${text.slice(0, line)}${COMPATIBILITY_MARKER}${text.slice(line + MARKER.length)}`, "utf8");
  const receipt = {
    version: 1, profile: PROFILE, architecture: arch, sourceHead: manifest.head,
    sourceManifestSha256: sha256(manifestBytes), packageVersion: version,
    sourceFile: SOURCE_FILE, originalSha256: originalHash, stagedSha256: sha256(patched),
    artifactBasename: `Shoggoth-${version}-${arch}-compatible-rollback-mac.zip`,
  };

  const stage = fs.mkdtempSync(path.join(path.dirname(target), ".compatibility-stage-"));
  const stagedSource = path.join(stage, "agent-service.js");
  let installed = false;
  try {
    writeExclusive(stagedSource, patched, info.mode & 0o777);
    const current = readPinnedFile(target, originalHash).info;
    assert.ok(["dev", "ino", "mtimeMs", "ctimeMs"].every(key => current[key] === info[key]), "Frozen source changed while staging");
    // Reserve the receipt name exclusively before the atomic source swap. A
    // downstream packager must validate stagedSha256 before using the receipt.
    writeExclusive(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
    try {
      fs.renameSync(stagedSource, target);
      installed = true;
    } finally {
      if (!installed) fs.unlinkSync(receiptPath);
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  return { receiptPath, ...receipt };
}

if (require.main === module) {
  try {
    const { values } = parseArgs({ options: { source: { type: "string" }, arch: { type: "string" } } });
    console.log(JSON.stringify(stage(values)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { stage };
