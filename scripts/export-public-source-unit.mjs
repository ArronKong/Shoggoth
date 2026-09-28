import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { isPublicSourcePath, publicSourceBytes } from './export-public-source.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');
const config = fs.readFileSync(new URL('../electron-builder.yml', import.meta.url));
const original = yaml.load(config.toString());
const exportedBytes = publicSourceBytes('electron-builder.yml', config);
const exported = yaml.load(exportedBytes.toString());
assert.deepEqual(exported.extraResources, original.extraResources.filter(item =>
  !String(item.from).startsWith('resources/bundled-plugins/packages/')));
assert.deepEqual(exported.files, original.files);
assert.deepEqual(exported.mac, original.mac);
assert.deepEqual(exported.publish, original.publish);
assert.deepEqual(publicSourceBytes('electron-builder.yml', exportedBytes), exportedBytes);
const catalog = JSON.parse(publicSourceBytes('resources/bundled-plugins/catalog.json', Buffer.from('{}')));
assert.deepEqual(catalog.packages, []);
for (const file of ['docs/private.md', 'resources/bundled-plugins/packages/temporal/assets/.gitkeep', 'app/.DS_Store']) {
  assert.equal(isPublicSourcePath(file), false);
}
assert.equal(isPublicSourcePath('LICENSE'), true);
console.log('Public source export policy: PASS');
