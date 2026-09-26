#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { audit } = require("./runtime-upgrade-audit.cjs");
const { manifestTree } = require("./runtime-upgrade-backup.cjs");
const { assertInstallProcesses, PERMIT_ENV } = require("./runtime-install-process-guard.cjs");
const repo = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  assert.ok(["--evidence-dir", "--package-dir", "--version", "--external-mcp-permit"].includes(args[index])
    && args[index + 1] && !options.has(args[index]), "invalid install arguments");
  options.set(args[index], args[index + 1]);
}
const root = path.resolve(options.get("--evidence-dir") || path.join(repo, ".artifacts/runtime-v2-s6-installed"));
const packageRoot = path.resolve(options.get("--package-dir") || path.join(repo, ".artifacts/runtime-v2-s6-package"));
const expectedVersion = options.get("--version") || "0.8.129";
const permitPath = options.get("--external-mcp-permit") || process.env[PERMIT_ENV] || null;
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/u);
for (const directory of [root, packageRoot]) {
  assert.ok(directory.startsWith(path.join(repo, ".artifacts") + path.sep), "evidence must stay in repository artifacts");
}
const source = path.join(packageRoot, "mac-arm64/Shoggoth.app");
const installed = "/Applications/Shoggoth.app";
const staged = "/Applications/.Shoggoth-runtime-v23-staged.app";
const previous = path.join(root, "previous/Shoggoth.app");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const asar = app => path.join(app, "Contents/Resources/app.asar");
function stopped(paths) {
  const snapshot = audit(paths);
  assert.ok(snapshot.quiescent && snapshot.product.activeRuns === 0, "Service and all runs must be stopped");
  const processGuard = assertInstallProcesses({ permitPath });
  try {
    execFileSync("/bin/launchctl", ["print", `gui/${process.getuid()}/com.shoggoth.agent-service`], { stdio: "pipe" });
    throw new Error("LaunchAgent must be stopped");
  } catch (error) { if (error.status !== 113) throw error; }
  return processGuard;
}
function main() {
  const paths = resolveCanonicalServicePaths();
  const backup = JSON.parse(fs.readFileSync(path.join(root, "pre-upgrade/receipt.json")));
  const receipt = JSON.parse(fs.readFileSync(path.join(packageRoot, "package-receipt.json")));
  assert.ok(backup.verified && receipt.packageSmoke.passed && receipt.packageSmoke.naturalExit === 0);
  assert.equal(receipt.version, expectedVersion);
  assert.ok(!fs.existsSync(previous) && !fs.existsSync(staged) && !fs.existsSync(path.join(root, "install-receipt.json")));
  const processGuard = stopped(paths);
  assert.deepEqual(backup.processGuard || { permittedExternalMcpPids: [], permitSha256: null }, processGuard,
    "process exception must match the verified backup");
  assert.equal(manifestTree(paths.stateDir).digest, backup.manifestDigest, "state must still match verified backup");
  const expectedHash = receipt.files.find(row => row.file.endsWith("app.asar")).sha256;
  assert.equal(hash(asar(source)), expectedHash);
  assert.equal(execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString",
    path.join(source, "Contents/Info.plist")], { encoding: "utf8" }).trim(), expectedVersion);
  const previousHash = hash(asar(installed));
  const oldVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString",
    path.join(installed, "Contents/Info.plist")], { encoding: "utf8" }).trim();
  execFileSync("/usr/bin/ditto", [source, staged], { stdio: "pipe", timeout: 180000 });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged], { stdio: "pipe", timeout: 60000 });
  assert.equal(hash(asar(staged)), expectedHash);
  stopped(paths);
  assert.equal(manifestTree(paths.stateDir).digest, backup.manifestDigest, "state changed during staging");
  fs.mkdirSync(path.dirname(previous), { recursive: true, mode: 0o700 });
  fs.renameSync(installed, previous);
  try { fs.renameSync(staged, installed); }
  catch (error) { fs.renameSync(previous, installed); throw error; }
  assert.equal(hash(asar(installed)), expectedHash);
  const result = { installedAt: new Date().toISOString(), installedPath: installed, version: receipt.version,
    architecture: "arm64", previousApp: previous, previousVersion: oldVersion, previousAsarSha256: previousHash,
    asarSha256: expectedHash, backupReceipt: path.join(root, "pre-upgrade/receipt.json"),
    signatureVerified: true, distribution: "internal", launched: false, processGuard,
    // These clients may predate the immediately previous App replacement.
    // Their startup version is not inferred from the on-disk App version.
    retainedHelperVersion: null, retainedHelpersRestarted: false };
  fs.writeFileSync(path.join(root, "install-receipt.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(result));
}
try { main(); } catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
