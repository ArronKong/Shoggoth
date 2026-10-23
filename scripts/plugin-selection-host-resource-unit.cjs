#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yaml = require("js-yaml");
const { FileMatcher } = require("app-builder-lib/out/fileMatcher");
const root = path.resolve(__dirname, "..");
const config = yaml.load(fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
const entries = config.extraResources.filter(item => item.to === "external-plugin-host-patches");
assert.equal(entries.length, 1);
assert.equal(entries[0].from, "resources/external-plugin-host-patches");
const source = path.join(root, entries[0].from);
const matcher = new FileMatcher(source, path.join(root, ".artifacts", "selection-resource-filter-test"),
  value => value, entries[0].filter).createFilter();
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
let verified = 0;
function included(file, digest) {
  const target = path.join(source, file);
  const stat = fs.lstatSync(target);
  assert(stat.isFile() && !stat.isSymbolicLink());
  assert(matcher(target, stat), `Host resource omitted: ${file}`);
  if (digest) assert.equal(sha(fs.readFileSync(target)), digest, `Host resource changed: ${file}`);
  verified++;
}
const openclawPrefix = "openclaw/2026.9.5/";
const openclaw = JSON.parse(fs.readFileSync(path.join(source, openclawPrefix, "openclaw-2026.9.5-selection.json")));
included(openclawPrefix + "openclaw-2026.9.5-selection.json");
included(openclawPrefix + "openclaw-2026.9.5-selection.patch");
for (const item of openclaw.licenseFiles) included(openclawPrefix + item.path, item.sha256);
for (const item of openclaw.newFiles) included(openclawPrefix + item.source, item.sha256);
const managedPrefix = "openclaw/2026.9.5-managed-v1/";
const managed = JSON.parse(fs.readFileSync(path.join(source, managedPrefix, "openclaw-2026.9.5-managed.json")));
included(managedPrefix + "openclaw-2026.9.5-managed.json");
for (const item of managed.licenseFiles) included(managedPrefix + item.path, item.sha256);
for (const item of managed.newFiles) included(managedPrefix + item.source, item.sha256);
const hermesPrefix = "hermes/v1-c7c2df1/";
const hermes = JSON.parse(fs.readFileSync(path.join(source, hermesPrefix, "manifest.json")));
included(hermesPrefix + "manifest.json");
included(hermesPrefix + "host.patch");
included(hermesPrefix + "LICENSE");
for (const item of hermes.files) included(hermesPrefix + "patched/" + item.path, item.patchedSha256);
const hermesManagedPrefix = "hermes/managed-v1/";
const hermesManaged = JSON.parse(fs.readFileSync(path.join(source, hermesManagedPrefix, "manifest.json")));
included(hermesManagedPrefix + "manifest.json");
assert.equal(hermesManaged.files.length, 24);
for (const item of hermesManaged.licenseFiles) included(hermesManagedPrefix + item.path, item.sha256);
for (const item of hermesManaged.files) included(hermesManagedPrefix + "patched/" + item.path, item.patchedSha256);
assert.equal(matcher(path.join(source, hermesPrefix, "patched/__pycache__/module.pyc"),
  fs.statSync(path.join(source, hermesPrefix, "LICENSE"))), false);
console.log(`Host compatibility resource filter: PASS (${verified} manifests, payloads and notices retained; no package created)`);
