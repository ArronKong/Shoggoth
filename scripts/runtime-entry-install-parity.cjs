"use strict";
// Read-only compatibility proof for the six already-running IPC-only helpers.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");
const installedApp = "/Applications/Shoggoth.app";
const sourceApp = path.resolve(__dirname, "../.artifacts/runtime-v2-s6-package-0.8.132/mac-arm64/Shoggoth.app");
const output = process.argv[2];
assert.ok(path.isAbsolute(output || "") && !fs.existsSync(output));
const archives = [installedApp, sourceApp].map(app => path.join(app, "Contents/Resources/app.asar"));
const executables = [installedApp, sourceApp].map(app => path.join(app, "Contents/MacOS/Shoggoth"));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hashFile = file => hash(fs.readFileSync(file));
function manifest(archive, prefix) {
  return asar.listPackage(archive).map(p => p.replace(/^\//u, ""))
    .filter(p => p === prefix || p.startsWith(prefix + "/")).map(p => {
      const stat = asar.statFile(archive, p);
      return stat.files ? { path: p, directory: true } : { path: p, sha256: hash(asar.extractFile(archive, p)) };
    }).sort((a, b) => a.path.localeCompare(b.path));
}
const prefixes = ["app/bootstrap.js", "app/bootstrap-role.js", "app/background-role-activation.js",
  "app/shoggoth-mcp-helper.js", "app/agent-service.js", "app/agent-service", "app/cua-sdk-loader.js"];
const code = prefixes.map(prefix => {
  const left = manifest(archives[0], prefix), right = manifest(archives[1], prefix);
  assert.ok(left.length > 0); assert.deepEqual(left, right, `${prefix} must remain byte-identical`);
  return { path: prefix, files: left.length, identical: true, manifestSha256: hash(JSON.stringify(left)) };
});
const packages = archives.map(archive => JSON.parse(asar.extractFile(archive, "package.json")));
const [oldVersion, newVersion] = packages.map(item => item.version);
assert.equal(oldVersion, "0.8.131"); assert.equal(newVersion, "0.8.132");
packages.forEach(item => delete item.version); assert.deepEqual(...packages);
const signatures = [installedApp, sourceApp].map(app => {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
  return { verified: true };
});
// codesign writes identity information to stderr; capture it without printing.
const { spawnSync } = require("node:child_process");
const teams = [installedApp, sourceApp].map(app => {
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
  assert.equal(result.status, 0); return /^TeamIdentifier=(.+)$/mu.exec(result.stderr)?.[1];
});
assert.equal(teams[0], "MK3JHXWR7H"); assert.equal(teams[0], teams[1]);
const originalHashes = executables.map(hashFile);
const temp = fs.mkdtempSync("/tmp/shoggoth-runtime-entry-parity-");
let unsignedExecutableSha256;
try {
  const hashes = executables.map((file, i) => {
    const copy = path.join(temp, String(i)); fs.copyFileSync(file, copy);
    execFileSync("/usr/bin/codesign", ["--remove-signature", copy], { stdio: "pipe" });
    return hashFile(copy);
  });
  assert.equal(hashes[0], hashes[1]); unsignedExecutableSha256 = hashes[0];
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
assert.deepEqual(executables.map(hashFile), originalHashes);
const result = { version: 1, recordedAt: new Date().toISOString(), installedApp, sourceApp,
  oldVersion, newVersion, oldAsarSha256: hashFile(archives[0]), newAsarSha256: hashFile(archives[1]),
  oldExecutableSha256: originalHashes[0], newExecutableSha256: originalHashes[1], unsignedExecutableSha256,
  code, signing: { team: teams[0], verified: signatures.every(value => value.verified) }, compatible: true };
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ compatible: true, oldVersion, newVersion, codeFiles: code.reduce((n, row) => n + row.files, 0), output }));
