#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertPublicBundledPluginClearance,
  checkPublicBundledPluginRelease,
} = require("./check-bundled-plugin-public-release.cjs");

const SHA = "a".repeat(64);
const BATCH = "b".repeat(64);
const file = { path: "skills/example/SKILL.md", sha256: "c".repeat(64) };
const catalog = { batchDigest: BATCH, packages: [
  { id: "example", sourceDigest: SHA, fileCount: 1 },
] };
const evidence = { batchDigest: BATCH, packages: [
  { id: "example", sourceDigest: SHA, files: [file] },
] };
const review = { schemaVersion: 1, batchDigest: BATCH, packages: [
  { id: "example", sourceDigest: SHA, decision: "approved", reviewer: "release reviewer",
    reviewedAt: "2026-09-27", files: [
      { ...file, decision: "approved", evidence: "license-review-record:example/skill",
        obligationsMet: true },
    ] },
] };
const sbom = { components: [
  { "bom-ref": "urn:shoggoth:bundled-plugin:example", properties: [
    { name: "shoggoth:source-digest-sha256", value: SHA },
    { name: "shoggoth:redistribution-review", value: "verified" },
  ] },
] };
const input = { catalog, evidence, review, sbom };
assert.deepEqual(assertPublicBundledPluginClearance(input), { packages: 1, files: 1 });
const altered = (change) => {
  const copy = structuredClone(input);
  change(copy);
  return copy;
};
for (const invalid of [
  altered((copy) => { copy.review = null; }),
  altered((copy) => { copy.review.packages[0].files = []; }),
  altered((copy) => { copy.review.packages[0].files[0].sha256 = "d".repeat(64); }),
  altered((copy) => { copy.review.packages[0].files[0].obligationsMet = false; }),
  altered((copy) => { copy.review.packages[0].files[0].evidence = ""; }),
  altered((copy) => { copy.sbom.components[0].properties[1].value = "unverified"; }),
  altered((copy) => { copy.catalog.packages[0].sourceDigest = "d".repeat(64); }),
]) assert.throws(() => assertPublicBundledPluginClearance(invalid), /PUBLIC_RELEASE_BLOCKED/u);
assert.deepEqual(assertPublicBundledPluginClearance({
  catalog: { packages: [] }, sbom: { components: [] },
}), { packages: 0, files: 0 });

const root = path.resolve(__dirname, "..");
assert.throws(() => checkPublicBundledPluginRelease(root),
  /PUBLIC_RELEASE_BLOCKED:REVIEW_MISSING_OR_STALE/u,
  "current frozen batch has evidence but no per-file redistribution approval");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-public-plugin-release-"));
try {
  const packaged = path.join(scratch, "catalog.json");
  fs.writeFileSync(packaged, JSON.stringify({ ...catalog, packages: [] }));
  assert.throws(() => checkPublicBundledPluginRelease(root, packaged),
    /PUBLIC_RELEASE_BLOCKED:PACKAGED_CATALOG_MISMATCH/u);

  const source = path.join(scratch, "public-source");
  const resources = path.join(source, "resources", "bundled-plugins");
  const build = path.join(source, "build");
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(build, { recursive: true });
  const emptyCatalog = { batchDigest: BATCH, packages: [] };
  fs.writeFileSync(path.join(resources, "catalog.json"), JSON.stringify(emptyCatalog));
  fs.writeFileSync(path.join(build, "release-sbom.cdx.json"), JSON.stringify({ components: [] }));
  assert.deepEqual(checkPublicBundledPluginRelease(source, path.join(resources, "catalog.json")),
    { packages: 0, files: 0 });
  fs.writeFileSync(path.join(resources, "stray-plugin.txt"), "not catalogued");
  assert.throws(() => checkPublicBundledPluginRelease(source, path.join(resources, "catalog.json")),
    /PUBLIC_RELEASE_BLOCKED:PACKAGED_RESOURCE_SET_MISMATCH/u);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("Public bundled-plugin release gate: reviewed files required; current batch blocked");
