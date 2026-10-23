'use strict';
// Reproducible compatibility proof only: reads the pinned package and writes a
// fresh, owned /private/tmp copy. Never patches an installed host in place.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const PATCH_ROOT = path.join(__dirname, '../resources/external-plugin-host-patches/openclaw/2026.9.5');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function loadManifest(root = PATCH_ROOT) {
  return { root, manifest: JSON.parse(fs.readFileSync(path.join(root, 'openclaw-2026.9.5-selection.json'), 'utf8')) };
}
function validatePinnedSource(source, root = PATCH_ROOT) {
  const { manifest } = loadManifest(root);
  const actual = fs.realpathSync(source);
  const pkg = JSON.parse(fs.readFileSync(path.join(actual, 'package.json'), 'utf8'));
  if (pkg.name !== manifest.package || pkg.version !== manifest.packageVersion) throw new Error('OPENCLAW_PATCH_VERSION_MISMATCH');
  for (const notice of manifest.licenseFiles || []) {
    if (sha(fs.readFileSync(path.join(actual, notice.path))) !== notice.sha256) throw new Error(`OPENCLAW_PATCH_LICENSE_SOURCE_MISMATCH:${notice.path}`);
    if (sha(fs.readFileSync(path.join(root, notice.path))) !== notice.sha256) throw new Error(`OPENCLAW_PATCH_LICENSE_ARTIFACT_MISMATCH:${notice.path}`);
  }
  for (const dependency of manifest.dependencies || []) {
    if (sha(fs.readFileSync(path.join(actual, dependency.path))) !== dependency.sha256) throw new Error(`OPENCLAW_PATCH_DEPENDENCY_MISMATCH:${dependency.path}`);
  }
  const changes = [];
  for (const file of manifest.files) {
    const original = fs.readFileSync(path.join(actual, file.path), 'utf8');
    if (sha(original) !== file.beforeSha256) throw new Error(`OPENCLAW_PATCH_SOURCE_MISMATCH:${file.path}`);
    let patched = original;
    for (const edit of file.edits) {
      const index = patched.indexOf(edit.before);
      if (index < 0 || patched.indexOf(edit.before, index + 1) >= 0) throw new Error(`OPENCLAW_PATCH_ANCHOR_MISMATCH:${file.path}`);
      patched = patched.slice(0, index) + edit.after + patched.slice(index + edit.before.length);
    }
    if (sha(patched) !== file.afterSha256) throw new Error(`OPENCLAW_PATCH_OUTPUT_MISMATCH:${file.path}`);
    changes.push({ path: file.path, content: patched });
  }
  for (const file of manifest.newFiles) {
    const content = fs.readFileSync(path.join(root, file.source), 'utf8');
    if (sha(content) !== file.sha256) throw new Error(`OPENCLAW_PATCH_ARTIFACT_MISMATCH:${file.path}`);
    if (fs.existsSync(path.join(actual, file.path))) throw new Error(`OPENCLAW_PATCH_SOURCE_ALREADY_MODIFIED:${file.path}`);
    changes.push({ path: file.path, content });
  }
  return { actual, changes, manifest };
}
function prepareRuntime({ source = '/opt/homebrew/lib/node_modules/openclaw', target, artifactRoot = PATCH_ROOT } = {}) {
  const { actual, changes, manifest } = validatePinnedSource(source, artifactRoot);
  const parent = fs.realpathSync('/private/tmp');
  let ownedRoot;
  if (target) {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(`${parent}${path.sep}`) || fs.existsSync(resolved)) throw new Error('OPENCLAW_PATCH_TARGET_MUST_BE_NEW_PRIVATE_TMP_DIRECTORY');
    fs.mkdirSync(resolved, { mode: 0o700 });
    ownedRoot = fs.realpathSync(resolved);
  } else ownedRoot = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'shoggoth-openclaw-selection-')));
  const runtime = path.join(ownedRoot, 'openclaw');
  fs.cpSync(actual, runtime, { recursive: true, dereference: false, verbatimSymlinks: true });
  for (const change of changes) fs.writeFileSync(path.join(runtime, change.path), change.content);
  fs.writeFileSync(path.join(ownedRoot, 'patch-evidence.json'), JSON.stringify({
    version: 1, packageVersion: manifest.packageVersion, source: actual, runtime,
    files: manifest.files.map(({ path: file, beforeSha256, afterSha256 }) => ({ path: file, beforeSha256, afterSha256 })),
    newFiles: manifest.newFiles.map(({ path: file, sha256 }) => ({ path: file, sha256 })),
  }, null, 2), { mode: 0o600 });
  // Re-read original sources after the copy; a test cannot pass by mutating the global host.
  validatePinnedSource(actual, artifactRoot);
  return { root: ownedRoot, runtime, entry: path.join(runtime, 'openclaw.mjs') };
}
module.exports = { loadManifest, validatePinnedSource, prepareRuntime };
if (require.main === module) {
  const command = process.argv[2];
  if (command === '--check') {
    const result = validatePinnedSource(process.argv[3] || '/opt/homebrew/lib/node_modules/openclaw');
    console.log(JSON.stringify({ status: 'verified', version: result.manifest.packageVersion, sourceFiles: result.manifest.files.length }));
  } else if (command === '--prepare') console.log(JSON.stringify(prepareRuntime({ source: process.argv[3], target: process.argv[4] })));
  else { console.error('Usage: node scripts/openclaw-selection-host-patch.cjs --check [source] | --prepare [source] [new /private/tmp target]'); process.exitCode = 2; }
}
