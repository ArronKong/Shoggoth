"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "cua-driver-manifest.json"), "utf8"));
const sbom = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "release-sbom.cdx.json"), "utf8"));
const builder = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
const controller = fs.readFileSync(path.join(ROOT, "app", "agent-service", "computer-use-controller.js"), "utf8");

function sha256(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

assert.equal(manifest.version, "0.22.0");
assert.equal(manifest.contractVersion, "0.7.0");
assert.deepEqual(manifest.architectures, ["arm64", "x86_64"]);
const binary = path.join(ROOT, ...manifest.destination.split("/"));
assert.equal(fs.statSync(binary).size, manifest.binarySizeBytes);
assert.equal(sha256(binary), manifest.binarySha256);
assert.deepEqual(execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" })
  .trim().split(/\s+/u).sort(), ["arm64", "x86_64"]);

assert.equal(manifest.nodePackages.length, 4);
assert.equal(new Set(manifest.nodePackages.map((entry) => entry.destination)).size, 4);
for (const entry of manifest.nodePackages) {
  assert.match(entry.archiveUrl, /^https:\/\/registry\.npmjs\.org\//u);
  assert.match(entry.archiveSha256, /^[a-f0-9]{64}$/u);
  const packageRoot = path.join(ROOT, ...entry.destination.split("/"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.name, entry.name);
  assert.equal(packageJson.version, entry.version);
  assert.deepEqual(packageJson.os, ["darwin"]);
  assert.deepEqual(packageJson.cpu, [entry.arch]);
  const sbomComponent = sbom.components.find((component) => (
    component.name === entry.name && component.version === entry.version
  ));
  assert.equal(sbomComponent.hashes.some((hash) => (
    hash.alg === "SHA-256" && hash.content === entry.archiveSha256
  )), true, `${entry.name} archive hash must be in the SBOM`);
}

assert.match(builder, /from: \.vendor\/cua\/node-modules\/\$\{arch\}\/node_modules/u);
assert.match(builder, /^npmRebuild: false$/mu);
assert.match(builder, /node_modules\/@trycua\/\*\*\/\*/u);
assert.match(builder, /node_modules\/@ubjs\/\*\*\/\*/u);
assert.match(builder, /!node_modules\/@trycua\/cua-driver\/node_modules\/\*\*\/\*/u);
assert.match(builder, /!node_modules\/@ubjs\/node\/node_modules\/\*\*\/\*/u);
assert.match(builder, /afterSign: scripts\/notarize\.cjs/u);
assert.match(builder, /release-sbom\.cdx\.json/u);
assert.doesNotMatch(controller, /CUA_DRIVER_RS_UPDATE_CHECK/u);
assert.match(controller, /CUA_DRIVER_RS_TELEMETRY_ENABLED", "false"/u);

for (const file of [
  "resources/legal/CUA-LICENSE.md",
  "resources/legal/CUA-NOTICE.md",
  "resources/legal/THIRD-PARTY-NOTICES.md",
]) assert.equal(fs.statSync(path.join(ROOT, file)).isFile(), true);

console.log("Cua release supply-chain unit: PASS (binary, 4 native packages, SBOM, licenses, no self-update)");
