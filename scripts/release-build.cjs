"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { assertAcceptedReceipt, buildNotarytoolArgs } = require("./notarize.cjs");
const { recordBuild, packageNames } = require("./release-draft.cjs");

async function main() {
  const arch = process.env.BUILD_ARCH;
  assert.equal(process.platform, "darwin");
  assert.ok(["arm64", "x64"].includes(arch));
  assert.equal(process.env.SHOGGOTH_CODESIGN_MODE, "developer-id");
  assert.equal(process.env.SHOGGOTH_RELEASE_DISTRIBUTION, "official");
  const root = path.resolve(__dirname, "..");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(sha, process.env.RELEASE_SOURCE_SHA);
  execFileSync("git", ["diff", "--exit-code", "HEAD", "--"], { cwd: root, stdio: "inherit" });
  assert.equal(execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).trim(), "",
    "Unexpected files in the frozen public checkout");
  const version = require("../package.json").version;
  assert.equal(process.env.RELEASE_TAG, `v${version}`);
  const run = (file, args, timeout = 30 * 60_000) => execFileSync(file, args, { cwd: root, stdio: "inherit", timeout });
  const app = path.join(root, "dist", arch === "arm64" ? "mac-arm64" : "mac", "Shoggoth.app");
  const evidence = path.join(root, "dist", `signing-${arch}`);
  fs.mkdirSync(evidence, { recursive: true });
  run("npx", ["--no-install", "electron-builder", "--mac", "zip", `--${arch}`, "--publish", "never"], 90 * 60_000);
  run(process.execPath, ["scripts/shoggoth-source-parity.cjs", path.join(app, "Contents/Resources/app.asar"),
    path.join(evidence, "source-parity.json"), arch]);
  run(process.execPath, ["scripts/verify-app-update-release.mjs", "--arch", arch]);
  run("/usr/bin/unzip", ["-tq", path.join(root, "dist", packageNames(version, arch)[0])]);
  run(process.execPath, ["scripts/create-macos-dmg.mjs", "--arch", arch, "--distribution", "official"]);
  const dmg = path.join(root, "dist", `Shoggoth-${version}-${arch}.dmg`);
  const receiptPath = path.join(evidence, "dmg-notarization.json");
  const result = execFileSync("/usr/bin/xcrun", buildNotarytoolArgs(dmg,
    process.env.SHOGGOTH_NOTARY_KEYCHAIN_PROFILE, process.env.SHOGGOTH_NOTARY_KEYCHAIN), {
    cwd: root, encoding: "utf8", timeout: 30 * 60_000,
  });
  fs.writeFileSync(receiptPath, result);
  assertAcceptedReceipt(result);
  run("/usr/bin/xcrun", ["stapler", "staple", dmg]);
  run("/usr/bin/xcrun", ["stapler", "validate", dmg]);
  run("/usr/bin/hdiutil", ["verify", dmg]);
  fs.copyFileSync(`${app}.notarization.json`, path.join(evidence, "app-notarization.json"));
  await recordBuild(path.join(root, "dist"), version, arch, sha, process.env.GITHUB_RUN_ID,
    `${app}.notarization.json`, receiptPath);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
