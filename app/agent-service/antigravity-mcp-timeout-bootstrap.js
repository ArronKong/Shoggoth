"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const SHA = /^[a-f0-9]{64}$/u;
const fail = () => Object.assign(new Error("Antigravity MCP timeout helper is unavailable"), { code: "ANTIGRAVITY_MCP_TIMEOUT_UNAVAILABLE" });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function physicalFile(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum
    || (stat.mode & 0o022) || ![0, process.getuid()].includes(stat.uid)) throw fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw fail();
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size || fs.fstatSync(fd).size !== stat.size) throw fail();
    return bytes;
  } finally { fs.closeSync(fd); }
}

function bootstrapArchitectures(bytes) {
  const thin = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 32 || offset + length > bytes.length
      || bytes.subarray(offset, offset + 4).toString("hex") !== "cffaedfe" || bytes.readUInt32LE(offset + 12) !== 2) throw fail();
    const architecture = { 16777228: "arm64", 16777223: "x86_64" }[bytes.readUInt32LE(offset + 4)];
    if (!architecture) throw fail();
    return architecture;
  };
  if (bytes.subarray(0, 4).toString("hex") === "cffaedfe") return [thin(0, bytes.length)];
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0xcafebabe) throw fail();
  const count = bytes.readUInt32BE(4), ranges = [], result = [];
  if (count < 1 || count > 2 || bytes.length < 8 + count * 20) throw fail();
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 20, offset = bytes.readUInt32BE(at + 8), size = bytes.readUInt32BE(at + 12);
    if (offset < 8 + count * 20 || ranges.some(range => offset < range.end && offset + size > range.start)) throw fail();
    const architecture = thin(offset, size);
    if (result.includes(architecture) || bytes.readUInt32LE(offset + 4) !== bytes.readUInt32BE(at)) throw fail();
    result.push(architecture); ranges.push({ start: offset, end: offset + size });
  }
  return result.sort();
}

function readBootstrap(directory, arch = process.arch) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || ![0, process.getuid()].includes(stat.uid)) throw fail();
  const manifest = JSON.parse(physicalFile(path.join(directory, "manifest.json"), 16384));
  const executable = path.join(directory, "harness-bootstrap"), bytes = physicalFile(executable, 1024 * 1024);
  const architectures = bootstrapArchitectures(bytes), target = arch === "x64" ? "x86_64" : arch;
  if (manifest.version !== 1 || !["sourceSha256", "builderSha256", "sha256"].every(key => SHA.test(manifest[key]))
    || manifest.sha256 !== hash(bytes) || !Array.isArray(manifest.architectures)
    || [...manifest.architectures].sort().join(",") !== architectures.join(",")
    || (target === "universal" ? architectures.join(",") !== "arm64,x86_64" : !architectures.includes(target))
    || !(fs.statSync(executable).mode & 0o111)) throw fail();
  return { executable: fs.realpathSync(executable), manifest, architectures };
}

function resolveAntigravityMcpTimeoutBootstrap(options = {}) {
  try {
    if (process.platform !== "darwin") throw fail();
    const resources = options.resourcesPath ?? process.resourcesPath;
    const directory = options.directory || (resources ? path.join(resources, "antigravity-mcp-timeout")
      : path.resolve(__dirname, "../../.vendor/antigravity-mcp-timeout"));
    return readBootstrap(directory, options.arch).executable;
  } catch { throw fail(); }
}

module.exports = { resolveAntigravityMcpTimeoutBootstrap, readBootstrap, bootstrapArchitectures };
