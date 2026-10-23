"use strict";

// This is a release-process gate, not an automated legal opinion. A public
// package may include frozen third-party plugin files only after an explicit
// digest-pinned, file-by-file redistribution review has been recorded.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const REF_PREFIX = "urn:shoggoth:bundled-plugin:";
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(reason) {
  throw new Error(`BUNDLED_PLUGIN_PUBLIC_RELEASE_BLOCKED:${reason}`);
}

function uniqueMap(entries, key, label) {
  if (!Array.isArray(entries)) fail(`${label}_INVALID`);
  const result = new Map();
  for (const entry of entries) {
    const id = entry?.[key];
    if (typeof id !== "string" || !id || result.has(id)) fail(`${label}_DUPLICATE_OR_INVALID`);
    result.set(id, entry);
  }
  return result;
}

function assertPublicBundledPluginClearance({ catalog, evidence, review, sbom }) {
  if (!Array.isArray(catalog?.packages)) fail("CATALOG_INVALID");
  const source = uniqueMap(catalog.packages, "id", "CATALOG");
  const components = uniqueMap(
    sbom?.components?.filter((entry) => entry?.["bom-ref"]?.startsWith(REF_PREFIX)),
    "bom-ref", "SBOM",
  );
  if (source.size !== components.size) fail("SBOM_CATALOG_MISMATCH");
  if (source.size === 0) return { packages: 0, files: 0 };

  if (review?.schemaVersion !== 1 || review.batchDigest !== catalog.batchDigest
    || evidence?.batchDigest !== catalog.batchDigest) fail("REVIEW_MISSING_OR_STALE");
  const reviewed = uniqueMap(review.packages, "id", "REVIEW");
  const witnessed = uniqueMap(evidence.packages, "id", "EVIDENCE");
  if (reviewed.size !== source.size || witnessed.size !== source.size) fail("PACKAGE_SET_MISMATCH");
  let fileCount = 0;
  for (const [id, entry] of source) {
    const record = reviewed.get(id);
    const original = witnessed.get(id);
    const component = components.get(`${REF_PREFIX}${id}`);
    if (!record || !original || !component
      || !SHA256.test(entry.sourceDigest)
      || record.sourceDigest !== entry.sourceDigest
      || original.sourceDigest !== entry.sourceDigest
      || component.properties?.find((property) =>
        property.name === "shoggoth:source-digest-sha256")?.value !== entry.sourceDigest
      || component.properties?.find((property) =>
        property.name === "shoggoth:redistribution-review")?.value !== "verified"
      || record.decision !== "approved"
      || typeof record.reviewer !== "string" || !record.reviewer.trim()
      || typeof record.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(record.reviewedAt)) {
      fail(`PACKAGE_UNVERIFIED:${id}`);
    }
    const originalFiles = uniqueMap(original.files, "path", `EVIDENCE_FILES:${id}`);
    const reviewedFiles = uniqueMap(record.files, "path", `REVIEW_FILES:${id}`);
    if (originalFiles.size !== entry.fileCount || reviewedFiles.size !== originalFiles.size) {
      fail(`FILE_SET_MISMATCH:${id}`);
    }
    for (const [filePath, file] of originalFiles) {
      const result = reviewedFiles.get(filePath);
      if (!SHA256.test(file.sha256) || !result
        || result.sha256 !== file.sha256
        || result.decision !== "approved"
        || typeof result.evidence !== "string" || !result.evidence.trim()
        || result.obligationsMet !== true) {
        fail(`FILE_UNVERIFIED:${id}/${filePath}`);
      }
      fileCount += 1;
    }
  }
  return { packages: source.size, files: fileCount };
}

function checkPublicBundledPluginRelease(root = ROOT, packagedCatalogPath) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  const catalog = read("resources/bundled-plugins/catalog.json");
  if (packagedCatalogPath) {
    const packaged = JSON.parse(fs.readFileSync(packagedCatalogPath, "utf8"));
    if (JSON.stringify(packaged) !== JSON.stringify(catalog)) fail("PACKAGED_CATALOG_MISMATCH");
  }
  const sbom = read("build/release-sbom.cdx.json");
  let checked;
  if (catalog.packages.length === 0) {
    checked = assertPublicBundledPluginClearance({ catalog, sbom });
  } else {
    // The license evidence is a preserved 62-package source snapshot. Select
    // only the nine active source records, then bind review to today's catalog.
    const frozenEvidence = read("docs/architecture/bundled-license-evidence-2026-09-27.json");
    const scope = read("docs/architecture/bundled-plugin-scope-2026-10-02.json");
    if (scope.frozenBatchDigest !== frozenEvidence.batchDigest
      || catalog.packages.length !== scope.activePackageIds.length
      || catalog.packages.some(entry => !scope.activePackageIds.includes(entry.id))) {
      fail("ACTIVE_SCOPE_MISMATCH");
    }
    const frozenById = uniqueMap(frozenEvidence.packages, "id", "FROZEN_EVIDENCE");
    const evidence = { batchDigest: catalog.batchDigest, packages: catalog.packages.map(entry => {
      const record = frozenById.get(entry.id);
      if (!record || record.sourceDigest !== entry.sourceDigest) fail(`EVIDENCE_MISMATCH:${entry.id}`);
      return record;
    }) };
    const reviewPath = path.join(root, "docs/architecture/bundled-plugin-redistribution-review.json");
    const review = fs.existsSync(reviewPath) ? JSON.parse(fs.readFileSync(reviewPath, "utf8")) : null;
    checked = assertPublicBundledPluginClearance({ catalog, evidence, review, sbom });
  }
  if (packagedCatalogPath) {
    const resourceRoot = path.dirname(packagedCatalogPath);
    const expected = catalog.packages.map((entry) => entry.id).sort();
    const packageRoot = path.join(resourceRoot, "packages");
    const resourceEntries = fs.readdirSync(resourceRoot).sort();
    const expectedEntries = expected.length ? ["catalog.json", "packages"] : ["catalog.json"];
    if (JSON.stringify(resourceEntries) !== JSON.stringify(expectedEntries)) {
      fail("PACKAGED_RESOURCE_SET_MISMATCH");
    }
    const actual = fs.existsSync(packageRoot) ? fs.readdirSync(packageRoot).sort() : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("PACKAGED_PACKAGE_SET_MISMATCH");
    if (expected.length) {
      const { BundledPluginCatalog } = require("../app/core/bundled-plugin-catalog");
      const packaged = new BundledPluginCatalog(resourceRoot);
      for (const id of expected) packaged.assertCurrent(id);
    }
  }
  return checked;
}

if (require.main === module) {
  const checked = checkPublicBundledPluginRelease();
  process.stdout.write(`Public bundled-plugin review passed: ${checked.packages} packages, ${checked.files} files\n`);
}

module.exports = { assertPublicBundledPluginClearance, checkPublicBundledPluginRelease };
