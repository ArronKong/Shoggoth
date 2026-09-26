#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// better-sqlite3 13 publishes Node-API binaries in its integrity-locked npm
// package. No Electron-ABI-specific download or local compiler is needed.
const root = path.resolve(import.meta.dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const manifest = read('build/inspiration-sqlite-manifest.json');
const pkg = read('package.json');
const installed = read('node_modules/better-sqlite3/package.json');
const locked = read('package-lock.json').packages['node_modules/better-sqlite3'];
if (pkg.dependencies['better-sqlite3'] !== manifest.version || installed.version !== manifest.version
  || pkg.devDependencies.electron !== manifest.electronVersion || manifest.nativeApi !== 'Node-API'
  || locked.integrity !== manifest.source.integrity) throw new Error('SQLITE_RELEASE_RUNTIME_MISMATCH');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const verified = ['arm64', 'x64'].map(arch => {
  const entry = manifest.architectures[arch];
  if (entry.packageFile !== `prebuilds/darwin-${arch}.node`) throw new Error('SQLITE_PACKAGE_PATH_INVALID');
  const binary = fs.readFileSync(path.join(root, 'node_modules/better-sqlite3', entry.packageFile));
  if (hash(binary) !== entry.binarySha256) throw new Error(`SQLITE_BINARY_HASH_MISMATCH:${arch}`);
  return { arch, binary };
});
for (const { arch, binary } of verified) {
  const destination = path.join(root, '.vendor/sqlite', arch, 'better_sqlite3.node');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(`${destination}.tmp`, binary);
  fs.renameSync(`${destination}.tmp`, destination);
}
console.log(`SQLite ${manifest.sqliteVersion} Node-API arm64/x64 binaries verified.`);
