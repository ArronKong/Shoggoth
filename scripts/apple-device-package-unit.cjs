"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { packagedAppleDeviceManifest, nativeArchitectures } = require("./apple-device-package.cjs");
const { createAppleDeviceNative } = require("../app/apple-device-native");
const { scanDirectory } = require("./check-release-private-keys.cjs");

const builtDirectory = path.join(__dirname, "../.vendor/apple-device");
const compiled = fs.existsSync(path.join(builtDirectory, "apple-device.node"));
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-apple-package-"));
  const appPath = path.join(directory, "Fixture.app");
  const nativeDirectory = path.join(appPath, "Contents", "Resources", "apple-device");
  fs.mkdirSync(nativeDirectory, { recursive: true });
  for (const file of ["manifest.json", "apple-device.node"]) fs.copyFileSync(path.join(builtDirectory, file), path.join(nativeDirectory, file));
  return { directory, appPath, nativeDirectory, manifestPath: path.join(nativeDirectory, "manifest.json"), executable: path.join(nativeDirectory, "apple-device.node"),
    close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function updateManifest(scratch, patch) {
  fs.writeFileSync(scratch.manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(scratch.manifestPath, "utf8")), ...patch }));
}
function thin(cpu) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(cpu, 4); bytes.writeUInt32LE(8, 12);
  return bytes;
}

test("architecture inspection rejects foreign executables and malformed fat slice bounds", () => {
  assert.deepEqual(nativeArchitectures(thin(0x0100000c)), ["arm64"]);
  assert.deepEqual(nativeArchitectures(thin(0x01000007)), ["x86_64"]);
  for (const bytes of [Buffer.alloc(0), Buffer.from("ELF executable"), thin(7)]) assert.throws(() => nativeArchitectures(bytes), /identity mismatch/u);
  const executable = thin(0x0100000c); executable.writeUInt32LE(2, 12);
  assert.throws(() => nativeArchitectures(executable), /identity mismatch/u);
  const fat = Buffer.alloc(64); fat.writeUInt32BE(0xcafebabe); fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(0x0100000c, 8); fat.writeUInt32BE(500, 16); fat.writeUInt32BE(32, 20);
  assert.throws(() => nativeArchitectures(fat), /identity mismatch/u);
});

test("packaged identity pins source/build hashes, binary bytes and target architectures", { skip: !compiled }, () => {
  const scratch = fixture();
  try {
    assert.equal(packagedAppleDeviceManifest(scratch.appPath, false, { arch: "arm64" }), scratch.executable);
    assert.equal(packagedAppleDeviceManifest(scratch.appPath, false, { arch: "x64" }), scratch.executable);
    assert.equal(packagedAppleDeviceManifest(scratch.appPath, false, { arch: "universal" }), scratch.executable);
    const original = fs.readFileSync(scratch.manifestPath);
    for (const patch of [{ sourceSha256: "a".repeat(64) }, { builderSha256: "b".repeat(64) }, { headersSha256: "invalid" }, { architectures: ["arm64"] }, { minimumMacOS: "12.0" }, { napiVersion: 99 }]) {
      updateManifest(scratch, patch);
      assert.throws(() => packagedAppleDeviceManifest(scratch.appPath), /identity mismatch/u);
      assert.throws(() => packagedAppleDeviceManifest(scratch.appPath, true), /identity mismatch/u);
      fs.writeFileSync(scratch.manifestPath, original);
    }
    updateManifest(scratch, { sha256: "c".repeat(64) });
    assert.throws(() => packagedAppleDeviceManifest(scratch.appPath), /identity mismatch/u);
    packagedAppleDeviceManifest(scratch.appPath, true);
    assert.equal(JSON.parse(fs.readFileSync(scratch.manifestPath, "utf8")).sha256, sha(scratch.executable));
    assert.throws(() => packagedAppleDeviceManifest(scratch.appPath, false, { arch: "linux" }), /identity mismatch/u);
  } finally { scratch.close(); }
});

test("packaging rejects symlink resources, hardlinked manifest and oversized metadata", { skip: !compiled }, () => {
  const scratch = fixture();
  try {
    const original = fs.readFileSync(scratch.manifestPath);
    const external = path.join(scratch.directory, "original-manifest.json");
    fs.renameSync(scratch.manifestPath, external); fs.symlinkSync(external, scratch.manifestPath);
    assert.throws(() => packagedAppleDeviceManifest(scratch.appPath), /identity mismatch/u);
    fs.unlinkSync(scratch.manifestPath); fs.copyFileSync(external, scratch.manifestPath);
    const link = path.join(scratch.directory, "manifest-hardlink.json"); fs.linkSync(scratch.manifestPath, link);
    assert.throws(() => packagedAppleDeviceManifest(scratch.appPath, true), /identity mismatch/u);
    fs.unlinkSync(link);
    fs.writeFileSync(scratch.manifestPath, " ".repeat(16385));
    assert.throws(() => packagedAppleDeviceManifest(scratch.appPath), /identity mismatch/u);
    fs.writeFileSync(scratch.manifestPath, original);
    const moved = path.join(scratch.directory, "native-resources");
    fs.renameSync(scratch.nativeDirectory, moved); fs.symlinkSync(moved, scratch.nativeDirectory);
    assert.throws(() => packagedAppleDeviceManifest(scratch.appPath), /identity mismatch/u);
  } finally { scratch.close(); }
});

test("isolated addon signing refreshes manifest before a safe status load and rejects tampering", { skip: process.platform !== "darwin" || !compiled }, async () => {
  const scratch = fixture();
  try {
    // Scan the exact isolated resource-only app before any signing command.
    assert.equal(scanDirectory(scratch.appPath).fileCount, 2);
    const executable = packagedAppleDeviceManifest(scratch.appPath);
    const before = sha(executable);
    execFileSync("/usr/bin/codesign", ["--force", "--options", "runtime", "--timestamp=none", "--identifier", "shoggoth.apple-device.fixture", "--sign", "-", executable],
      { encoding: "utf8", stdio: "pipe", timeout: 30000 });
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", executable], { encoding: "utf8", stdio: "pipe", timeout: 30000 });
    assert.notEqual(sha(executable), before);
    assert.throws(() => packagedAppleDeviceManifest(scratch.appPath), /identity mismatch/u);
    packagedAppleDeviceManifest(scratch.appPath, true);
    assert.equal(packagedAppleDeviceManifest(scratch.appPath), executable);
    const status = await createAppleDeviceNative({ platform: "darwin", addonPath: executable }).invoke("status");
    const allowed = new Set(["notDetermined", "fullAccess", "writeOnly", "denied", "restricted", "unavailable"]);
    assert.ok(allowed.has(status.calendar)); assert.ok(allowed.has(status.reminders));
    // Never modify the already-loaded inode: tamper with a separate copy so the
    // running process's mapped code remains intact and nothing reaches require.
    const tampered = path.join(scratch.directory, "Tampered.app");
    fs.cpSync(scratch.appPath, tampered, { recursive: true });
    const tamperedAddon = path.join(tampered, "Contents", "Resources", "apple-device", "apple-device.node");
    fs.appendFileSync(tamperedAddon, Buffer.from([0]));
    assert.throws(() => packagedAppleDeviceManifest(tampered), /identity mismatch/u);
    await assert.rejects(createAppleDeviceNative({ platform: "darwin", addonPath: tamperedAddon }).invoke("status"), error => error.code === "APPLE_DEVICE_UNAVAILABLE");
  } finally { scratch.close(); }
});

test("exact outer App signing flags preserve the sealed nested addon hash", { skip: process.platform !== "darwin" || !compiled }, () => {
  const scratch = fixture();
  try {
    const executableDirectory = path.join(scratch.appPath, "Contents", "MacOS"); fs.mkdirSync(executableDirectory);
    const main = path.join(executableDirectory, "Fixture"); fs.copyFileSync("/usr/bin/true", main); fs.chmodSync(main, 0o755);
    fs.writeFileSync(path.join(scratch.appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.shoggoth.apple.fixture</string>
      <key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Fixture</string>
      <key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>`);
    assert.equal(scanDirectory(scratch.appPath).fileCount, 4);
    packagedAppleDeviceManifest(scratch.appPath, false, { arch: "universal" });
    const { buildNestedCodesignArgs, buildCodesignArgs } = require("./adhoc-sign.cjs");
    execFileSync("/usr/bin/xattr", ["-cr", scratch.appPath], { stdio: "pipe", timeout: 10000 });
    execFileSync("/usr/bin/codesign", buildNestedCodesignArgs({ targetPath: scratch.executable, identity: "-" }), { stdio: "pipe", timeout: 30000 });
    packagedAppleDeviceManifest(scratch.appPath, true, { arch: "universal" });
    const nestedHash = sha(scratch.executable);
    execFileSync("/usr/bin/codesign", buildCodesignArgs({ appPath: scratch.appPath, entitlementsPath: path.join(__dirname, "../build/entitlements.mac.plist"), identity: "-" }),
      { stdio: "pipe", timeout: 30000 });
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", scratch.appPath], { stdio: "pipe", timeout: 30000 });
    assert.equal(sha(scratch.executable), nestedHash);
    assert.equal(packagedAppleDeviceManifest(scratch.appPath, false, { arch: "universal" }), scratch.executable);
  } finally { scratch.close(); }
});
