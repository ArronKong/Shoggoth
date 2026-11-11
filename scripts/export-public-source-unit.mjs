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
assert.equal(original.extraResources.some(item => ["resources/bundled-plugins", "resources/shoggoth-plugins", ".vendor/gogcli"].some(prefix => String(item.from).startsWith(prefix))), false);
assert.equal(original.extraResources.some(item => ["open-connector", "open-connector-runtime", "gogcli"].includes(item.to)), false);
for (const file of ['docs/private.md', 'resources/bundled-plugins/packages/temporal/assets/.gitkeep', 'resources/shoggoth-plugins/old/plugin.json', 'app/.DS_Store', 'resources/open-connector/host.json', 'resources/open-connector-runtime/runtime.json', 'resources/gogcli/bin/gog', 'resources/shoggoth-skills/shoggoth-plugin-authoring/SKILL.md']) {
  assert.equal(isPublicSourcePath(file), false);
}
assert.equal(isPublicSourcePath('LICENSE'), true);
for (const file of ['docs/privacy.md', 'docs/privacy.en.md']) {
  assert.equal(isPublicSourcePath(file), true);
  assert.ok(fs.statSync(new URL('../' + file, import.meta.url)).size > 0);
}
console.log('Public source export policy: PASS');
