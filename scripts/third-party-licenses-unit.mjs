import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectThirdPartyLicenses } from './third-party-licenses.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shoggoth-license-test-'));
function write(file, text) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof text === 'string' ? text : `${JSON.stringify(text)}\n`);
}
try {
  write('resources/legal/source-components.json', { components: [], npmOverrides: [] });
  write('package-lock.json', { packages: {
    '': { name: 'test' },
    'node_modules/shared': { version: '1.0.0', license: 'MIT' },
    'node_modules/build-only': { version: '1.0.0', license: 'ISC', dev: true },
  } });
  write('app/manage-ui/package-lock.json', { packages: {
    'node_modules/shared': { version: '1.0.0', license: 'MIT' },
    'node_modules/frontend-only': { version: '2.0.0', license: 'ISC' },
  } });
  for (const [prefix, name, version] of [
    ['', 'shared', '1.0.0'], ['app/manage-ui/', 'shared', '1.0.0'],
    ['app/manage-ui/', 'frontend-only', '2.0.0'],
  ]) {
    write(`${prefix}node_modules/${name}/package.json`, { name, version });
    write(`${prefix}node_modules/${name}/LICENSE`, `Fixture full license for ${name}\nCopyright fixture author\n`);
  }
  const inventory = collectThirdPartyLicenses(root);
  assert.equal(inventory.distributedCount, 2);
  assert.equal(inventory.npm.length, 3);
  assert.deepEqual(inventory.npm.find(item => item.name === 'shared').scopes, ['desktop', 'frontend']);
  assert.equal(inventory.npm.find(item => item.name === 'build-only').distributed, false);
  collectThirdPartyLicenses(root, { check: true });
  const notice = path.join(root, 'resources/legal/THIRD-PARTY-NOTICES.md');
  fs.writeFileSync(notice, 'tampered');
  assert.throws(() => collectThirdPartyLicenses(root, { check: true }), /out of date/);
  assert.equal(fs.readFileSync(notice, 'utf8'), 'tampered', 'check must never rewrite files');
  collectThirdPartyLicenses(root);
  write('resources/legal/licenses/npm/stale@0/LICENSE', 'stale generated file');
  write('resources/legal/licenses/source/MANUAL.txt', 'preserve upstream source notice');
  assert.throws(() => collectThirdPartyLicenses(root, { check: true }), /out of date/);
  collectThirdPartyLicenses(root);
  assert.equal(fs.existsSync(path.join(root, 'resources/legal/licenses/npm/stale@0/LICENSE')), false);
  assert.equal(fs.readFileSync(path.join(root, 'resources/legal/licenses/source/MANUAL.txt'), 'utf8'), 'preserve upstream source notice');
  const dependency = 'app/manage-ui/node_modules/frontend-only';
  fs.unlinkSync(path.join(root, dependency, 'LICENSE'));
  assert.throws(() => collectThirdPartyLicenses(root), /Full license text missing: frontend-only/);
  write(`${dependency}/LICENSE`, 'restored fixture license');
  write(`${dependency}/package.json`, { name: 'frontend-only', version: '2.0.1' });
  assert.throws(() => collectThirdPartyLicenses(root), /version mismatch/);
  console.log('PASS license generator: both lockfiles, deduplication, completeness, version matching, read-only check, safe stale cleanup');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
