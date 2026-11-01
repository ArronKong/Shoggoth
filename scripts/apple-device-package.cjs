"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SHA = /^[a-f0-9]{64}$/u;
const MAX_ADDON_BYTES = 16 * 1024 * 1024;
const ARCH_CPU = Object.freeze({ arm64: 0x0100000c, x86_64: 0x01000007 });
const identityError = () => new Error("Apple device native helper identity mismatch");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function readPhysicalFile(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) throw identityError();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.nlink !== 1) throw identityError();
    const bytes = Buffer.alloc(stat.size);
    let total = 0;
    while (total < bytes.length) {
      const count = fs.readSync(fd, bytes, total, bytes.length - total, total);
      if (!count) throw identityError();
      total += count;
    }
    if (fs.fstatSync(fd).size !== stat.size) throw identityError();
    return bytes;
  } finally { fs.closeSync(fd); }
}

function physicalDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw identityError();
}

function thinArchitecture(bytes, offset = 0, length = bytes.length) {
  if (length < 32 || offset < 0 || offset + length > bytes.length) throw identityError();
  const magic = bytes.subarray(offset, offset + 4).toString("hex");
  if (magic !== "cffaedfe" && magic !== "feedfacf") throw identityError();
  const read = magic === "cffaedfe" ? at => bytes.readUInt32LE(at) : at => bytes.readUInt32BE(at);
  const cpu = read(offset + 4);
  if (read(offset + 12) !== 8) throw identityError(); // MH_BUNDLE (Node addon).
  const arch = Object.keys(ARCH_CPU).find(key => ARCH_CPU[key] === cpu);
  if (!arch) throw identityError();
  return arch;
}

function nativeArchitectures(bytes) {
  if (bytes.length < 4) throw identityError();
  const magic = bytes.subarray(0, 4).toString("hex");
  if (magic === "cffaedfe" || magic === "feedfacf") return [thinArchitecture(bytes)];
  const fat64 = magic === "cafebabf" || magic === "bfbafeca";
  const little = magic === "bebafeca" || magic === "bfbafeca";
  if (!fat64 && magic !== "cafebabe" && magic !== "bebafeca") throw identityError();
  const read = little ? offset => bytes.readUInt32LE(offset) : offset => bytes.readUInt32BE(offset);
  const wide = little ? offset => bytes.readBigUInt64LE(offset) : offset => bytes.readBigUInt64BE(offset);
  if (bytes.length < 8) throw identityError();
  const count = read(4), entrySize = fat64 ? 32 : 20;
  if (count < 1 || count > 2 || bytes.length < 8 + count * entrySize) throw identityError();
  const ranges = [], result = [];
  for (let index = 0; index < count; index++) {
    const at = 8 + index * entrySize;
    const offset = fat64 ? Number(wide(at + 8)) : read(at + 8);
    const size = fat64 ? Number(wide(at + 16)) : read(at + 12);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 8 + count * entrySize || size < 32 || offset + size > bytes.length ||
      ranges.some(range => offset < range.end && offset + size > range.start)) throw identityError();
    const arch = thinArchitecture(bytes, offset, size);
    if (ARCH_CPU[arch] !== read(at) || result.includes(arch)) throw identityError();
    result.push(arch); ranges.push({ start: offset, end: offset + size });
  }
  return result.sort();
}

function packagedAppleDeviceManifest(appPath, update = false, options = {}) {
  if (typeof appPath !== "string" || !path.isAbsolute(appPath) || typeof update !== "boolean") throw identityError();
  const absolute = path.resolve(appPath);
  const directories = [absolute, path.join(absolute, "Contents"), path.join(absolute, "Contents", "Resources"),
    path.join(absolute, "Contents", "Resources", "apple-device")];
  for (const directory of directories) physicalDirectory(directory);
  const directory = directories.at(-1);
  const manifestPath = path.join(directory, "manifest.json");
  const executable = path.join(directory, "apple-device.node");
  const manifest = JSON.parse(readPhysicalFile(manifestPath, 16384).toString("utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.version !== 1 || manifest.napiVersion !== 8 ||
    manifest.minimumMacOS !== "13.0" || !Array.isArray(manifest.architectures) ||
    !["sourceSha256", "builderSha256", "headersSha256", "sha256"].every(key => typeof manifest[key] === "string" && SHA.test(manifest[key]))) throw identityError();
  const repo = options.repo ? path.resolve(options.repo) : path.resolve(__dirname, "..");
  if (hash(readPhysicalFile(path.join(repo, "resources/apple-device/apple-device.mm"), 1024 * 1024)) !== manifest.sourceSha256 ||
    hash(readPhysicalFile(path.join(repo, "scripts/build-apple-device-native.cjs"), 1024 * 1024)) !== manifest.builderSha256) throw identityError();
  const bytes = readPhysicalFile(executable, MAX_ADDON_BYTES);
  const actualArchitectures = nativeArchitectures(bytes);
  if (manifest.architectures.length !== actualArchitectures.length ||
    [...manifest.architectures].sort().some((arch, index) => arch !== actualArchitectures[index])) throw identityError();
  const targetArch = options.arch === "x64" ? "x86_64" : options.arch;
  if (targetArch && (targetArch === "universal" ? actualArchitectures.join(",") !== "arm64,x86_64" :
    !Object.hasOwn(ARCH_CPU, targetArch) || !actualArchitectures.includes(targetArch))) throw identityError();
  const sha256 = hash(bytes);
  if (!update && manifest.sha256 !== sha256) throw identityError();
  if (update) {
    // Nested signing changes only the output hash. Source/build identity remains
    // pinned, and the parent signs this final manifest into the outer app seal.
    const fd = fs.openSync(manifestPath, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw identityError();
      const updated = Buffer.from(JSON.stringify({ ...manifest, sha256 }, null, 2) + "\n");
      fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, updated);
    } finally { fs.closeSync(fd); }
  }
  return executable;
}

module.exports = { packagedAppleDeviceManifest, nativeArchitectures };

if (require.main === module) {
  const args = process.argv.slice(2);
  const appIndex = args.indexOf("--app");
  const arch = args.find(value => value.startsWith("--arch="))?.slice(7);
  if (appIndex < 0 || !args[appIndex + 1] || args.some((value, index) => index !== appIndex + 1 && value !== "--app" && value !== "--update" && !/^--arch=(arm64|x64|universal)$/u.test(value)))
    throw new Error("Usage: node scripts/apple-device-package.cjs --app /absolute/App.app [--update] [--arch=arm64|x64|universal]");
  console.log(packagedAppleDeviceManifest(args[appIndex + 1], args.includes("--update"), { arch }));
}
