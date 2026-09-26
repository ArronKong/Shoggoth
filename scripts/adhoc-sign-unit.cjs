"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildCodesignArgs,
  buildNestedCodesignArgs,
  isMachOFile,
  listNativeNodeModules,
  nestedHostOptionalDependencyPaths,
  writeReleaseMarker,
  shouldSignMachO,
  inspectCodeSignature,
} = require("./adhoc-sign.cjs");

assert.equal(typeof buildCodesignArgs, "function", "签名脚本必须导出可测试的参数构造器");

assert.deepEqual(buildCodesignArgs({
  appPath: "/tmp/Shoggoth.app",
  entitlementsPath: "/repo/build/entitlements.mac.plist",
  identity: "-",
}), [
  "--force",
  "--deep",
  "--options", "runtime",
  "--timestamp=none",
  "--entitlements", "/repo/build/entitlements.mac.plist",
  "--sign", "-",
  "/tmp/Shoggoth.app",
]);

assert.deepEqual(buildCodesignArgs({
  appPath: "/tmp/Shoggoth.app",
  entitlementsPath: "/repo/build/entitlements.mac.plist",
  identity: "Developer ID Application: Shoggoth (TEAMID)",
  keychainPath: "/tmp/release.keychain-db",
  timestamp: true,
}), [
  "--force", "--deep", "--options", "runtime", "--timestamp",
  "--entitlements", "/repo/build/entitlements.mac.plist",
  "--keychain", "/tmp/release.keychain-db",
  "--sign", "Developer ID Application: Shoggoth (TEAMID)", "/tmp/Shoggoth.app",
]);

assert.deepEqual(buildNestedCodesignArgs({
  targetPath: "/tmp/addon.node",
  identity: "Developer ID Application: Shoggoth (TEAMID)",
  keychainPath: "/tmp/release.keychain-db",
  timestamp: true,
}), [
  "--force", "--options", "runtime", "--timestamp",
  "--keychain", "/tmp/release.keychain-db",
  "--sign", "Developer ID Application: Shoggoth (TEAMID)", "/tmp/addon.node",
]);

const nativeRoot = path.join(__dirname, ".adhoc-sign-native-fixture");
try {
  fs.mkdirSync(path.join(nativeRoot, "nested"), { recursive: true });
  fs.writeFileSync(path.join(nativeRoot, "nested", "runtime.node"), "fixture");
  fs.writeFileSync(path.join(nativeRoot, "nested", "ignore.dylib"), "fixture");
  assert.deepEqual(listNativeNodeModules(nativeRoot), [path.join(nativeRoot, "nested", "runtime.node")]);
} finally {
  fs.rmSync(nativeRoot, { recursive: true, force: true });
}

assert.deepEqual(nestedHostOptionalDependencyPaths("/tmp/Shoggoth.app"), [
  "/tmp/Shoggoth.app/Contents/Resources/app.asar.unpacked/node_modules/@trycua/cua-driver/node_modules",
  "/tmp/Shoggoth.app/Contents/Resources/app.asar.unpacked/node_modules/@ubjs/node/node_modules",
]);

const releaseFixture = path.join(__dirname, ".adhoc-sign-release-fixture", "Shoggoth.app");
try {
  fs.mkdirSync(path.join(releaseFixture, "Contents", "Resources"), { recursive: true });
  const markerPath = writeReleaseMarker(releaseFixture, { mode: "developer-id", version: "0.8.125" });
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, "utf8")), {
    schemaVersion: 1,
    distribution: "official",
    signingMode: "developer-id",
    updateChannel: "stable",
    version: "0.8.125",
  });
  writeReleaseMarker(releaseFixture, { mode: "adhoc", version: "0.8.125" });
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, "utf8")), {
    schemaVersion: 1,
    distribution: "internal",
    signingMode: "adhoc",
    updateChannel: null,
    version: "0.8.125",
  });
  writeReleaseMarker(releaseFixture, {
    mode: "developer-id", distribution: "internal", version: "0.8.127",
  });
  const internalSigned = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.deepEqual(internalSigned, {
    schemaVersion: 1, distribution: "internal", signingMode: "developer-id",
    updateChannel: null, version: "0.8.127",
  });
  const { supportStatus } = require("../app/desktop-app-update");
  assert.deepEqual(supportStatus({
    platform: "darwin", isPackaged: true,
    resourcesPath: path.dirname(markerPath), existsSync: () => true,
  }), { supported: false, reason: "internal-build" });
  assert.throws(() => writeReleaseMarker(releaseFixture, {
    mode: "adhoc", distribution: "official", version: "0.8.127",
  }), TypeError);
} finally {
  fs.rmSync(path.dirname(releaseFixture), { recursive: true, force: true });
}

const machoFixture = path.join(__dirname, ".adhoc-sign-macho-fixture");
try {
  fs.writeFileSync(machoFixture, Buffer.from("cffaedfe", "hex"));
  assert.equal(isMachOFile(machoFixture), true);
} finally {
  fs.rmSync(machoFixture, { force: true });
}
assert.equal(shouldSignMachO({ mode: "adhoc", valid: false, teamId: null }), true);
assert.equal(shouldSignMachO({ mode: "adhoc", valid: true, teamId: null }), false);
assert.equal(shouldSignMachO({ mode: "developer-id", valid: true, teamId: "2DC432GLL2" }), false);
assert.equal(shouldSignMachO({ mode: "developer-id", valid: true, teamId: "YCK386LBJ7" }), false);
assert.equal(shouldSignMachO({ mode: "developer-id", valid: true, teamId: "OTHERTEAM" }), true);

for (const teamId of ["2DC432GLL2", "YCK386LBJ7"]) {
  const signature = inspectCodeSignature("/tmp/vendor", {
    spawnSync(_command, args) {
      return args[0] === "-d"
        ? { status: 0, stderr: `TeamIdentifier=${teamId}\n` }
        : { status: 1, stderr: "signature verification unavailable" };
    },
  });
  assert.deepEqual(signature, { valid: false, teamId });
  for (const mode of ["adhoc", "local", "developer-id"]) {
    assert.throws(() => shouldSignMachO({ mode, ...signature }), /refusing to replace/);
  }
}

assert.deepEqual(buildCodesignArgs({
  appPath: "/tmp/Shoggoth.app",
  entitlementsPath: "/repo/build/entitlements.mac.plist",
  identity: "DDB8A6FEE24F4BD865BAB191D92C44062F213137",
  keychainPath: "/Users/test/Library/Keychains/shoggoth-local-signing.keychain-db",
}), [
  "--force",
  "--deep",
  "--options", "runtime",
  "--timestamp=none",
  "--entitlements", "/repo/build/entitlements.mac.plist",
  "--keychain", "/Users/test/Library/Keychains/shoggoth-local-signing.keychain-db",
  "--sign", "DDB8A6FEE24F4BD865BAB191D92C44062F213137",
  "/tmp/Shoggoth.app",
]);

assert.throws(() => buildCodesignArgs({
  appPath: "/tmp/Shoggoth.app",
  entitlementsPath: "/repo/build/entitlements.mac.plist",
  identity: "Stable",
  keychainPath: "relative-signing.keychain-db",
}), /absolute path/i);

assert.throws(() => buildCodesignArgs({
  appPath: "/tmp/Shoggoth.app",
  entitlementsPath: "/repo/build/entitlements.mac.plist",
  identity: "Stable",
  keychainPath: "/tmp/signing\0.keychain-db",
}), /NUL/i);

const builderConfig = fs.readFileSync(path.join(__dirname, "..", "electron-builder.yml"), "utf8");
assert.equal(
  builderConfig.match(/^  identity:\s*null\s*$/gmu)?.length,
  1,
  "electron-builder 必须禁用自动证书发现，签名只允许由 afterPack 完成",
);

console.log("Ad-hoc/local/Developer ID signing unit: PASS (including vendor verification failure)");
