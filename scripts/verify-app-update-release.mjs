#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { fileDigest } from "./release-draft.cjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repoRoot, "dist");
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const metadata = yaml.load(await readFile(path.join(dist, "latest-mac.yml"), "utf8"));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--arch"
  && ["arm64", "x64"].includes(args[1])), "Usage: verify-app-update-release.mjs [--arch arm64|x64]");
const architectures = args.length ? [args[1]] : ["arm64", "x64"];

assert.equal(metadata.version, packageJson.version, "latest-mac.yml version must match package.json");
assert.ok(Array.isArray(metadata.files), "latest-mac.yml must include a files list");

const expected = architectures.map(arch =>
  `Shoggoth-${packageJson.version}-${arch === "arm64" ? "arm64-mac" : "mac"}.zip`);
for (const name of expected) {
  const entry = metadata.files.find((item) => item?.url === name);
  assert.ok(entry, `latest-mac.yml does not reference ${name}`);
  assert.match(entry.sha512, /^[A-Za-z0-9+/]{80,}={0,2}$/u, `${name} has no SHA-512 digest`);
  const artifact = path.join(dist, name);
  await access(artifact);
  assert.equal((await stat(artifact)).size, entry.size, `${name} size differs from latest-mac.yml`);
  assert.equal(await fileDigest(artifact, "sha512", "base64"), entry.sha512,
    `${name} digest differs from latest-mac.yml`);
}

for (const arch of architectures) {
  const appDirectory = arch === "arm64" ? "mac-arm64" : "mac";
  const resources = path.join(dist, appDirectory, "Shoggoth.app", "Contents", "Resources");
  const marker = JSON.parse(await readFile(path.join(resources, "shoggoth-release.json"), "utf8"));
  assert.deepEqual({
    schemaVersion: marker.schemaVersion,
    distribution: marker.distribution,
    signingMode: marker.signingMode,
    updateChannel: marker.updateChannel,
    version: marker.version,
  }, {
    schemaVersion: 1,
    distribution: "official",
    signingMode: "developer-id",
    updateChannel: "stable",
    version: packageJson.version,
  });
  const updateConfig = yaml.load(await readFile(path.join(resources, "app-update.yml"), "utf8"));
  assert.equal(updateConfig.provider, "github");
  assert.equal(updateConfig.owner, "ArronKong");
  assert.equal(updateConfig.repo, "Shoggoth");
}

console.log(`App update release verified: ${expected.join(", ")}`);
