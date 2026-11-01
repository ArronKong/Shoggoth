"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readBootstrap, bootstrapArchitectures } = require("../app/agent-service/antigravity-mcp-timeout-bootstrap");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function packagedAntigravityMcpTimeoutManifest(appPath, update = false, { arch = process.arch, repo = path.resolve(__dirname, "..") } = {}) {
  if (!path.isAbsolute(appPath || "") || typeof update !== "boolean") throw new Error("Antigravity timeout package identity mismatch");
  const directory = path.join(appPath, "Contents/Resources/antigravity-mcp-timeout");
  const manifestPath = path.join(directory, "manifest.json"), executable = path.join(directory, "harness-bootstrap");
  // Source/build identity is verified before and after signing. Signing can
  // change the output hash only; the final manifest is covered by the App seal.
  const before = fs.lstatSync(manifestPath), stat = fs.lstatSync(executable), parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size > 16384 || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024
    || (before.mode & 0o022) || (stat.mode & 0o022)) throw new Error("Antigravity timeout package identity mismatch");
  const manifest = JSON.parse(fs.readFileSync(manifestPath)), bytes = fs.readFileSync(executable);
  if (manifest.version !== 1 || manifest.sourceSha256 !== hash(fs.readFileSync(path.join(repo, "resources/antigravity-mcp-timeout/harness-bootstrap.c")))
    || manifest.builderSha256 !== hash(fs.readFileSync(path.join(repo, "scripts/build-antigravity-mcp-timeout.cjs")))
    || !Array.isArray(manifest.architectures) || bootstrapArchitectures(bytes).join(",") !== [...manifest.architectures].sort().join(",")) {
    throw new Error("Antigravity timeout package identity mismatch");
  }
  if (update) {
    const fd = fs.openSync(manifestPath, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
    try {
      const current = fs.fstatSync(fd);
      if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size) throw new Error("Antigravity timeout package changed");
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, JSON.stringify({ ...manifest, sha256: hash(bytes) }, null, 2) + "\n");
    } finally { fs.closeSync(fd); }
  }
  return readBootstrap(directory, arch).executable;
}

module.exports = { packagedAntigravityMcpTimeoutManifest };
