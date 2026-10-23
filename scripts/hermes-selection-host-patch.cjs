'use strict';

// Reproducible, hash-gated compatibility proof. Never patches an installed host.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const PAYLOAD = path.resolve(__dirname, '../resources/external-plugin-host-patches/hermes/v1-c7c2df1');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PAYLOAD, 'manifest.json'), 'utf8'));
const DEFAULT_SOURCE = require('node:path').join(require('node:os').homedir(), '.hermes', 'hermes-agent');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function verify(source) {
  source = fs.realpathSync(source);
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  assert.equal(actual, MANIFEST.sourceCommit, 'Pinned Hermes commit mismatch; no fallback patch is permitted');
  for (const item of MANIFEST.files) {
    assert.ok(!path.isAbsolute(item.path) && !item.path.split('/').includes('..'), 'Unsafe manifest path');
    const input = path.join(source, item.path);
    if (item.originalSha256 === null) assert.ok(!fs.existsSync(input), 'New compatibility file already exists');
    else {
      assert.ok(!fs.lstatSync(input).isSymbolicLink(), 'Pinned source may not be a symlink');
      assert.equal(sha(fs.readFileSync(input)), item.originalSha256, `Pinned source hash mismatch: ${item.path}`);
    }
    const payload = path.join(PAYLOAD, 'patched', item.path);
    assert.ok(!fs.lstatSync(payload).isSymbolicLink(), 'Patch payload may not be a symlink');
    assert.equal(sha(fs.readFileSync(payload)), item.patchedSha256, `Patch payload hash mismatch: ${item.path}`);
  }
  return { source, sourceCommit: MANIFEST.sourceCommit, fileCount: MANIFEST.files.length };
}

function archive(source, output) {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['archive', '--format=tar', MANIFEST.sourceCommit], { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-C', output], { stdio: ['pipe', 'ignore', 'pipe'] });
    git.stdout.pipe(tar.stdin);
    let gitExit; let tarExit; let ended = false;
    const fail = () => {
      if (ended) return; ended = true;
      git.kill('SIGTERM'); tar.kill('SIGTERM'); reject(new Error('Pinned Hermes source archive failed'));
    };
    const settle = () => { if (gitExit === undefined || tarExit === undefined || ended) return;
      if (gitExit !== 0 || tarExit !== 0) { fail(); return; }
      ended = true; resolve(); };
    git.on('error', fail); tar.on('error', fail); tar.stdin.on('error', fail);
    // Host stdout/body/config never gets copied to tool output.
    git.stderr.resume(); tar.stderr.resume();
    git.once('close', code => { gitExit = code; settle(); });
    tar.once('close', code => { tarExit = code; settle(); });
  });
}

async function materialize({ source = DEFAULT_SOURCE, output }) {
  const verified = verify(source);
  if (typeof output !== 'string' || !output) throw new Error('An empty, new temporary output path is required');
  const parent = fs.realpathSync(path.dirname(path.resolve(output)));
  const tempRoot = fs.realpathSync('/private/tmp');
  assert.ok(parent === tempRoot || parent.startsWith(tempRoot + path.sep), 'Output must be under /private/tmp');
  const target = path.join(parent, path.basename(output));
  assert.ok(!fs.existsSync(target), 'Output already exists; no overwrite is permitted');
  const volume = fs.statfsSync(parent);
  assert.ok(Number(volume.bavail) * Number(volume.bsize) >= 512 * 1024 * 1024, 'Less than 512 MiB free; do not materialize host');
  fs.mkdirSync(target, { mode: 0o700 });
  try {
    await archive(verified.source, target);
    for (const item of MANIFEST.files) {
      const dest = path.join(target, item.path);
      if (item.originalSha256 !== null) assert.equal(sha(fs.readFileSync(dest)), item.originalSha256, 'Archive source hash mismatch');
      else assert.ok(!fs.existsSync(dest), 'Archive already contains new compatibility file');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(PAYLOAD, 'patched', item.path), dest);
      assert.equal(sha(fs.readFileSync(dest)), item.patchedSha256, 'Materialized hash mismatch');
    }
    return { ...verified, output: target, compatibilityProofOnly: true };
  } catch (error) {
    // This function created this exact previously absent temporary directory.
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const allowed = new Set(['--verify', '--source', '--output']);
  for (let i = 0; i < args.length; i++) {
    assert.ok(allowed.has(args[i]), `Unknown argument: ${args[i]}`);
    if (args[i] !== '--verify') { assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), 'Missing argument value'); i++; }
  }
  const promise = args.includes('--verify') ? Promise.resolve(verify(get('--source') || DEFAULT_SOURCE))
    : materialize({ source: get('--source') || DEFAULT_SOURCE, output: get('--output') });
  promise.then(result => console.log(JSON.stringify({ ok: true, ...result })), error => {
    console.error('Hermes host compatibility patch stopped: ' + error.message); process.exitCode = 1;
  });
}
module.exports = { materialize, verify, MANIFEST, PAYLOAD, DEFAULT_SOURCE };
