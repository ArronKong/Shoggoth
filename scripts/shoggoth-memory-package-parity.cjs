#!/usr/bin/env node
"use strict";

// Compare the memory deliverable's current source with one built app.asar.
// Read-only: this script does not extract files to disk or modify the App.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const repository = path.resolve(__dirname, "..");
const groups = [
  { name: "agent-service JS", directory: "app/agent-service", accepts: (name) => /\.(?:js|cjs)$/u.test(name) },
  { name: "core JS", directory: "app/core", accepts: (name) => name.endsWith(".js") },
  { name: "static server", file: "app/static-server.js" },
  { name: "built management UI", directory: "app/manage-ui/dist", accepts: () => true },
];

function usage() {
  throw new Error("Usage: node scripts/shoggoth-memory-package-parity.cjs --app /absolute/path/Shoggoth.app");
}
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--app") usage();
const appInput = argv[1];
if (typeof appInput !== "string" || !path.isAbsolute(appInput)
  || appInput.includes("\0") || !appInput.isWellFormed()) usage();
const appPath = path.normalize(appInput);
const appStat = fs.lstatSync(appPath);
if (!appStat.isDirectory() || appStat.isSymbolicLink()) throw new Error("App path must be a directory, not a link");
const archive = path.join(appPath, "Contents", "Resources", "app.asar");
const archiveStat = fs.lstatSync(archive);
if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new Error("App archive must be a regular file");
const canonicalApp = fs.realpathSync(appPath);
const canonicalArchive = fs.realpathSync(archive);
if (!canonicalArchive.startsWith(`${canonicalApp}${path.sep}`)) {
  throw new Error("App archive resolves outside the selected App");
}

function sourceFiles(group) {
  if (group.file) {
    const target = path.join(repository, group.file);
    if (!fs.lstatSync(target).isFile()) throw new Error(`Source file is missing: ${group.file}`);
    return [group.file];
  }
  const root = path.join(repository, group.directory);
  if (!fs.lstatSync(root).isDirectory()) throw new Error(`Source directory is missing: ${group.directory}`);
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(repository, target).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Source link is not allowed: ${relative}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && group.accepts(relative)) result.push(relative);
      else if (!entry.isFile()) throw new Error(`Unexpected source entry: ${relative}`);
    }
  };
  visit(root);
  return result.sort();
}

function inGroup(relative, group) {
  return group.file ? relative === group.file
    : relative.startsWith(`${group.directory}/`) && group.accepts(relative);
}

async function sha256File(target) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const bundled = asar.listPackage(archive).map((name) => name.replace(/^\//u, ""));
  const bundledSet = new Set(bundled);
  const errors = [];
  let totalFiles = 0;
  let totalBytes = 0;
  for (const group of groups) {
    const sources = sourceFiles(group);
    if (sources.length === 0) throw new Error(`No source files found in ${group.name}`);
    const expected = new Set(sources);
    let matched = 0;
    let bytes = 0;
    for (const relative of sources) {
      if (!bundledSet.has(relative)) {
        errors.push(`MISSING ${relative}`);
        continue;
      }
      const sourcePath = path.join(repository, ...relative.split("/"));
      const sourceStat = fs.lstatSync(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        errors.push(`SOURCE_CHANGED ${relative}`);
        continue;
      }
      try {
        const sourceHash = await sha256File(sourcePath);
        // extractFile returns one Buffer at a time; no large asset set is
        // materialized in memory. Source files are streamed separately.
        const packed = asar.extractFile(archive, relative);
        const packedHash = crypto.createHash("sha256").update(packed).digest("hex");
        if (sourceHash !== packedHash || sourceStat.size !== packed.length) {
          errors.push(`MISMATCH ${relative} source=${sourceHash} asar=${packedHash}`);
          continue;
        }
        matched++;
        bytes += packed.length;
      } catch (error) {
        errors.push(`UNREADABLE ${relative}: ${error.message}`);
      }
    }
    let extra = 0;
    for (const relative of bundled) {
      if (!inGroup(relative, group) || expected.has(relative)) continue;
      const info = asar.statFile(archive, relative);
      if (info.files) continue; // ASAR directory, not an extra file.
      errors.push(`EXTRA ${relative}`);
      extra++;
    }
    totalFiles += matched;
    totalBytes += bytes;
    console.log(`${group.name}: ${matched}/${sources.length} files, ${bytes} bytes, ${extra} extra`);
  }
  if (errors.length) {
    for (const error of errors.slice(0, 50)) console.error(error);
    if (errors.length > 50) console.error(`... ${errors.length - 50} more differences`);
    throw new Error(`Package parity failed with ${errors.length} difference(s)`);
  }
  console.log(`PASS ${totalFiles} files, ${totalBytes} bytes SHA-256 identical to ${archive}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
