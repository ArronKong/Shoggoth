#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { bundledPluginSbomComponents, withoutBundledPlugins } from './bundled-plugin-sbom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const catalog = read('resources/bundled-plugins/catalog.json');
const frozen = read('docs/architecture/bundled-plugin-inventory-2026-09-26.json');
const scope = read('docs/architecture/bundled-plugin-scope-2026-10-02.json');
const components = bundledPluginSbomComponents(catalog, frozen, scope);
assert.equal(components.length, 9);
assert.equal(new Set(components.map((entry) => entry['bom-ref'])).size, 9);
for (const entry of components) {
  assert.equal(Object.hasOwn(entry, 'licenses'), false,
    'a manifest declaration is not a redistribution-license conclusion');
  assert.equal(entry.properties.find((property) => property.name === 'shoggoth:redistribution-review')?.value,
    'unverified');
}
const sbom = read('build/release-sbom.cdx.json');
const rootDependency = sbom.dependencies.find((entry) => entry.ref === sbom.metadata.component['bom-ref']);
assert.ok(rootDependency);
for (const expected of components) {
  assert.deepEqual(sbom.components.find((entry) => entry['bom-ref'] === expected['bom-ref']), expected);
  assert.equal(rootDependency.dependsOn.includes(expected['bom-ref']), true);
}
assert.equal(sbom.components.filter((entry) => entry['bom-ref'].startsWith('urn:shoggoth:bundled-plugin:')).length,
  components.length);
const emptyCatalog = { version: catalog.version,
  batchDigest: crypto.createHash('sha256').update('[]').digest('hex'), packages: [] };
assert.deepEqual(bundledPluginSbomComponents(emptyCatalog, null), []);
const publicSbom = withoutBundledPlugins(sbom, catalog);
assert.equal(publicSbom.components.some((entry) =>
  entry['bom-ref'].startsWith('urn:shoggoth:bundled-plugin:')), false);
assert.equal(publicSbom.dependencies.find((entry) =>
  entry.ref === rootDependency.ref).dependsOn.some((ref) =>
  ref.startsWith('urn:shoggoth:bundled-plugin:')), false);
assert.deepEqual(withoutBundledPlugins(publicSbom, emptyCatalog), publicSbom);
assert.equal(publicSbom.components.length, sbom.components.length - 9);

const copy = (value) => structuredClone(value);
const changedDigest = copy(catalog);
changedDigest.packages[0].sourceDigest = '0'.repeat(64);
assert.throws(() => bundledPluginSbomComponents(changedDigest, frozen, scope), /INVENTORY_MISMATCH/u);
const missing = copy(catalog);
missing.packages.pop();
assert.throws(() => bundledPluginSbomComponents(missing, frozen, scope), /INVENTORY_MISMATCH/u);
const duplicated = copy(catalog);
duplicated.packages[1] = copy(duplicated.packages[0]);
assert.throws(() => bundledPluginSbomComponents(duplicated, frozen, scope), /INVENTORY_MISMATCH/u);
const staleSbom = copy(sbom);
staleSbom.components.find((entry) => entry['bom-ref'] === components[0]['bom-ref'])
  .properties.find((property) => property.name === 'shoggoth:source-digest-sha256').value = '0'.repeat(64);
assert.throws(() => withoutBundledPlugins(staleSbom, catalog), /PUBLIC_BUNDLED_SBOM_INVALID/u);
console.log('Bundled plugin SBOM: 9 App resources, source digests, public redaction, unverified rights');
