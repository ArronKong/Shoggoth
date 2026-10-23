'use strict';
// Small synthetic package lifecycle using actual pinned Node/Python executables.
// This is not acceptance of a production OpenClaw/Hermes supervisor.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const {
  createManagedPluginHostRuntimeManager, createManagedHostRuntimeAuthority,
  snapshotRuntimeTree, hashFile, nodeEngineSupported, patchedTreeDigest,
} = require('../app/managed-plugin-host-runtime');
const NODE = process.env.MANAGED_HOST_FIXTURE_NODE || (process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node'));
const PYTHON = process.env.MANAGED_HOST_FIXTURE_PYTHON || require('node:path').join(require('node:os').homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sg-managed-host-'));
const results = [];
const controllers = [];
const plainJson = value => JSON.stringify(value);
function write(file, bytes, mode = 0o600) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, bytes, { mode }); }
function processIdentity(pid) { return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim(); }
async function check(name, body) { await body(); results.push(name); }
async function rejects(code, body) { await assert.rejects(body, error => error?.code === code, code); }
const ENTRY = `const FLAVOR = 'original';
if (!process.argv.includes('--fixture-host')) process.stdout.write(FLAVOR);
else {
  let paused = true;
  process.on('message', m => {
    if (m.action === 'resume') paused = false;
    if (m.action === 'drain') paused = true;
    process.send({ id: m.id, flavor: FLAVOR, paused, running: 0, queued: 0,
      pid: process.pid, nonce: process.env.MANAGED_HOST_NONCE });
  });
}
`;
function fixture(name, host = 'openclaw') {
  const base = path.join(root, name);
  const source = path.join(base, 'source');
  const resources = path.join(base, 'resources');
  const state = path.join(base, 'state');
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  const payloadRelative = `${host}/fixture-v1`;
  const payload = path.join(resources, payloadRelative);
  const license = 'Synthetic test fixture license; no upstream source is redistributed here.\n';
  write(path.join(source, 'LICENSE'), license);
  write(path.join(payload, 'LICENSE'), license);
  const identityFile = host === 'openclaw' ? 'package.json' : 'pyproject.toml';
  const entryRelative = host === 'openclaw' ? 'openclaw.mjs' : 'hermes_cli/main.py';
  const dependencyPath = host === 'openclaw' ? 'node_modules' : 'venv';
  write(path.join(source, identityFile), host === 'openclaw'
    ? plainJson({ name: 'openclaw', version: '2026.9.5', engines: { node: '>=24.16.0 <25 || >=26.1.0' } })
    : '[project]\nversion = "0.21.4"\nrequires-python = ">=3.11,<3.14"\n');
  write(path.join(source, entryRelative), ENTRY);
  write(path.join(source, dependencyPath, 'dependency.txt'), 'fixed dependency\n');
  if (host === 'openclaw') {
    write(path.join(source, dependencyPath, '.bin', '.keep'), 'bin\n');
    fs.symlinkSync('../dependency.txt', path.join(source, dependencyPath, '.bin', 'dependency'));
  } else {
    write(path.join(source, 'venv', 'pyvenv.cfg'), 'include-system-site-packages = false\n');
    write(path.join(source, 'hermes_cli', 'web_dist', 'index.html'), '<!doctype html>fixture');
  }
  const changed = ENTRY.replace("'original'", "'patched'");
  const manifestFile = 'manifest.json';
  const hostVersion = host === 'openclaw' ? '2026.9.5' : 'c7c2df1a536d62b45fda8907bb1898981721794d';
  const manifest = host === 'openclaw' ? { version: 1, package: host, packageVersion: hostVersion,
    files: [{ path: entryRelative, beforeSha256: sha(ENTRY), afterSha256: sha(changed),
      edits: [{ before: "'original'", after: "'patched'" }] }], newFiles: [], dependencies: [] }
    : { version: 1, host, sourceCommit: hostVersion,
      files: [{ path: entryRelative, originalSha256: sha(ENTRY), patchedSha256: sha(changed) }] };
  if (host === 'hermes') write(path.join(payload, 'patched', entryRelative), changed);
  write(path.join(payload, manifestFile), plainJson(manifest));
  const interpreterPath = host === 'openclaw' ? NODE : PYTHON;
  const probe = host === 'openclaw' ? JSON.parse(execFileSync(NODE, ['-p',
    'JSON.stringify({version:process.versions.node,architecture:process.arch,platform:process.platform})'], { encoding: 'utf8' }))
    : JSON.parse(execFileSync(PYTHON, ['-I', '-B', '-c', "import json,platform,sys; print(json.dumps({'version':platform.python_version(),'architecture':'arm64' if platform.machine() in ('arm64','aarch64') else 'x64','platform':sys.platform}))"], { encoding: 'utf8' }));
  const pin = { version: 1, backendId: host, hostVersion, inputTreeSha256: snapshotRuntimeTree(source).sha256,
    outputTreeSha256: patchedTreeDigest(snapshotRuntimeTree(source), [{ path: entryRelative, bytes: Buffer.from(changed) }]),
    dependencyTreeSha256: snapshotRuntimeTree(path.join(source, dependencyPath), { containmentRoot: source }).sha256,
    payloadTreeSha256: snapshotRuntimeTree(payload).sha256, payloadManifestSha256: hashFile(path.join(payload, manifestFile)),
    identityFile, identityFileSha256: hashFile(path.join(source, identityFile)), dependencyPath,
    entryRelative, payloadRelative, manifestFile, licenseFiles: [{ path: 'LICENSE', sha256: sha(license) }],
    interpreter: { ...probe, sha256: hashFile(fs.realpathSync(interpreterPath)) } };
  const inputPins = { version: 1, hosts: { [host]: pin } };
  const args = { backendId: host, sourceRoot: source, interpreterPath, architecture: probe.architecture };
  const options = { stateDir: state, resourcesRoot: resources, inputPins };
  return { base, source, resources, state, payload, pin, inputPins, args, options, host };
}
function actualController(f) {
  const dataRoot = path.join(f.base, 'data');
  fs.mkdirSync(dataRoot, { mode: 0o700 });
  const counters = { start: 0, stop: 0, failClosed: 0, fence: 0 };
  let child = null; let currentIdentity = null; let fenceFd = null; let fencePath = null; let drained = false;
  let healthReject = false; let foreign = false;
  const pending = new Map();
  const rpc = action => new Promise((resolve, reject) => {
    if (!child || child.exitCode !== null) return reject(new Error('fixture writer absent'));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('fixture IPC timeout')); }, 4000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); }); child.send({ id, action });
  });
  const cleanupFence = () => {
    if (fenceFd !== null) { fs.closeSync(fenceFd); fenceFd = null; }
    if (fencePath) { try { fs.unlinkSync(fencePath); } catch {} fencePath = null; }
  };
  const close = async () => {
    const active = child;
    if (active && active.exitCode === null) {
      const exited = new Promise(resolve => active.once('exit', resolve)); active.kill('SIGTERM'); await exited;
    }
    child = null; currentIdentity = null; cleanupFence();
  };
  const bind = context => ({ backendId: context.backendId, operationId: context.operationId, dataRoot });
  const proof = (context, state) => ({ ...bind(context), identity: currentIdentity,
    runtimeTreeSha256: context.candidate.runtimeTreeSha256, selectionSupported: true,
    adapterGeneration: 'synthetic-fixture-v1', paused: state.paused });
  const controller = {
    async inspectWriter(context) {
      if (foreign) return { backendId: context.backendId, dataRoot, ownership: 'unknown', identity: null };
      return { backendId: context.backendId, dataRoot, ownership: child?.exitCode === null ? 'managed' : 'absent',
        identity: child?.exitCode === null ? currentIdentity : null };
    },
    async acquireDrain(context) {
      if (child?.exitCode === null) assert.equal((await rpc('drain')).paused, true);
      drained = true;
      const nonce = crypto.randomBytes(32).toString('hex');
      return { async assertValid() { assert.equal(drained, true); return { ...bind(context), leaseNonce: nonce, expiresAt: Date.now() + 30000 }; },
        async release() { drained = false; } };
    },
    async assertIdle(context) { const state = child?.exitCode === null ? await rpc('state') : { running: 0, queued: 0 };
      return { ...bind(context), complete: true, running: state.running, queued: state.queued }; },
    async stopWriter(context) { assert.equal(drained, true); assert.deepEqual(context.previousWriter, currentIdentity); counters.stop++; await close(); },
    async claimExclusiveDataFence(context) {
      counters.fence++;
      fencePath = path.join(dataRoot, 'writer.fence');
      // Exclusive create is a real fixture boundary, not a native Host flock certification.
      try { fenceFd = fs.openSync(fencePath, 'wx', 0o600); } catch (error) { fencePath = null; throw error; }
      const heldFd = fenceFd;
      fs.writeFileSync(fenceFd, context.nonce); fs.fsyncSync(fenceFd);
      return { async assertValid() { assert.equal(fenceFd, heldFd); return { ...bind(context), exclusive: true, fenceNonce: context.nonce }; },
        async release() { if (!child || child.exitCode !== null) cleanupFence(); } };
    },
    async startPaused(context) {
      assert.equal(drained, true); assert.notEqual(fenceFd, null); counters.start++;
      child = spawn(context.candidate.launch.executable, [...context.candidate.launch.args, '--fixture-host'], {
        cwd: context.candidate.launch.cwd,
        env: { ...process.env, ...context.candidate.launch.env, MANAGED_HOST_NONCE: context.nonce },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.on('message', value => { const callback = pending.get(value.id); if (callback) { pending.delete(value.id); callback(value); } });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      currentIdentity = { pid: child.pid, startIdentity: processIdentity(child.pid), nonce: context.nonce };
      assert.equal((await rpc('state')).paused, true);
      return currentIdentity;
    },
    async waitHealthy(context) {
      if (healthReject) throw Object.assign(new Error('intentional fixture health failure'), { code: 'FIXTURE_HEALTH_FAILED' });
      const state = await rpc('health'); assert.equal(state.flavor, 'patched'); assert.equal(state.nonce, currentIdentity.nonce);
      assert.equal(processIdentity(child.pid), currentIdentity.startIdentity);
      return proof(context, state);
    },
    async resume(context) { return proof(context, await rpc('resume')); },
    async failClosed() { counters.failClosed++; await close(); },
    async abortAndWait(context) { await close(); return { ...bind(context), complete: true }; },
  };
  const result = { controller, counters, close, dataRoot,
    rejectHealth: value => { healthReject = value; }, foreignOwner: value => { foreign = value; },
    isAlive: () => child?.exitCode === null, writerIdentity: () => currentIdentity };
  controllers.push(result);
  return result;
}

(async () => {
  const f = fixture('core');
  const manager = createManagedPluginHostRuntimeManager(f.options);
  let candidate;
  await check('full input/dependency/payload/license and actual Node engine/architecture', async () => {
    const inspected = await manager.inspectSource(f.args);
    assert.equal(inspected.sourceVerified, true); assert.equal(inspected.activationAvailable, false);
    assert.equal(inspected.interpreter.version, '24.21.0'); assert.equal(inspected.links, 1);
    assert.equal(fs.existsSync(f.state), false);
    assert.equal(nodeEngineSupported('22.22.3'), false); assert.equal(nodeEngineSupported('24.15.0'), false);
    assert.equal(nodeEngineSupported('24.16.0'), true); assert.equal(nodeEngineSupported('25.3.0'), false);
    assert.equal(nodeEngineSupported('26.0.9'), false); assert.equal(nodeEngineSupported('26.1.0'), true);
  });
  await check('persistent immutable patched candidate; original inputs unchanged', async () => {
    const before = snapshotRuntimeTree(f.source).sha256;
    candidate = await manager.prepareCandidate(f.args);
    assert.equal(execFileSync(candidate.launch.executable, candidate.launch.args, { encoding: 'utf8' }), 'patched');
    assert.equal(execFileSync(NODE, [path.join(f.source, 'openclaw.mjs')], { encoding: 'utf8' }), 'original');
    assert.equal(snapshotRuntimeTree(f.source).sha256, before); assert.equal(candidate.candidateColdStartVerified, false);
    assert.ok(Object.isFrozen(candidate)); assert.equal(fs.lstatSync(candidate.runtimeRoot).mode & 0o222, 0);
    assert.equal(manager.getActive('openclaw'), null);
    assert.equal(createManagedPluginHostRuntimeManager(f.options).getCandidate('openclaw').candidateId, candidate.candidateId);
  });
  await check('default activation refuses without a supervisor and spawns no writer', async () => {
    await rejects('RUNTIME_SUPERVISOR_UNAVAILABLE', () => manager.activateCandidate({ backendId: 'openclaw', candidateId: candidate.candidateId, operationId: 'default-no-host' }));
    assert.equal(fs.existsSync(path.join(f.state, 'external-plugin-host-runtimes/openclaw/activation.json')), false);
  });
  await check('serialized or cross-manager authority cannot activate', async () => {
    assert.throws(() => createManagedPluginHostRuntimeManager({ ...f.options, activationAuthority: { ready: true } }), e => e.code === 'RUNTIME_ACTIVATION_AUTHORITY_INVALID');
    const actual = actualController(f); const handle = createManagedHostRuntimeAuthority(actual.controller);
    createManagedPluginHostRuntimeManager({ ...f.options, activationAuthority: handle });
    assert.throws(() => createManagedPluginHostRuntimeManager({ ...f.options, activationAuthority: handle }), e => e.code === 'RUNTIME_ACTIVATION_AUTHORITY_INVALID');
    assert.throws(() => createManagedPluginHostRuntimeManager({ ...f.options, activationAuthority: JSON.parse(JSON.stringify(handle)) }), e => e.code === 'RUNTIME_ACTIVATION_AUTHORITY_INVALID');
  });
  await check('full tree catches extra/modified dependency; unsupported update preserves pointers', async () => {
    const pointerPath = path.join(f.state, 'external-plugin-host-runtimes/openclaw/candidate.json');
    const pointer = fs.readFileSync(pointerPath, 'utf8');
    write(path.join(f.source, '.unreviewed-input'), 'polluted');
    await rejects('RUNTIME_INPUT_TREE_MISMATCH', () => manager.prepareCandidate(f.args)); fs.unlinkSync(path.join(f.source, '.unreviewed-input'));
    write(path.join(f.source, 'node_modules/dependency.txt'), 'polluted dependency');
    await rejects('RUNTIME_INPUT_TREE_MISMATCH', () => manager.prepareCandidate(f.args)); write(path.join(f.source, 'node_modules/dependency.txt'), 'fixed dependency\n');
    const pkg = fs.readFileSync(path.join(f.source, 'package.json'));
    write(path.join(f.source, 'package.json'), plainJson({ name: 'openclaw', version: '2026.10.0', engines: { node: '>=24.16.0 <25 || >=26.1.0' } }));
    await rejects('RUNTIME_SOURCE_IDENTITY_MISMATCH', () => manager.prepareCandidate(f.args)); write(path.join(f.source, 'package.json'), pkg);
    assert.equal(fs.readFileSync(pointerPath, 'utf8'), pointer); assert.equal(manager.getActive('openclaw'), null);
  });
  await check('escaping and broken symlinks are rejected; internal links relocate', async () => {
    fs.symlinkSync(process.execPath, path.join(f.source, 'escape'));
    await rejects('RUNTIME_LINK_ESCAPE', () => manager.inspectSource(f.args)); fs.unlinkSync(path.join(f.source, 'escape'));
    fs.symlinkSync('absent', path.join(f.source, 'broken'));
    await rejects('RUNTIME_LINK_BROKEN', () => manager.inspectSource(f.args)); fs.unlinkSync(path.join(f.source, 'broken'));
    assert.equal(fs.realpathSync(path.join(candidate.runtimeRoot, 'node_modules/.bin/dependency')), path.join(candidate.runtimeRoot, 'node_modules/dependency.txt'));
  });
  await check('license/payload corruption and unpinned inputs are rejected before state write', async () => {
    const notice = fs.readFileSync(path.join(f.payload, 'LICENSE'));
    write(path.join(f.payload, 'LICENSE'), 'different'); await rejects('RUNTIME_PAYLOAD_TREE_MISMATCH', () => manager.inspectSource(f.args)); write(path.join(f.payload, 'LICENSE'), notice);
    await rejects('RUNTIME_INPUT_UNPINNED', () => createManagedPluginHostRuntimeManager({ ...f.options, inputPins: { version: 1, hosts: {} } }).inspectSource(f.args));
    const wrongLicense = JSON.parse(JSON.stringify(f.inputPins)); wrongLicense.hosts.openclaw.licenseFiles[0].sha256 = '0'.repeat(64);
    await rejects('RUNTIME_LICENSE_MISMATCH', () => createManagedPluginHostRuntimeManager({ ...f.options, inputPins: wrongLicense }).inspectSource(f.args));
  });
  await check('actual interpreter hash/architecture/engine mismatch refuses execution eligibility', async () => {
    await rejects('RUNTIME_INTERPRETER_PLATFORM_MISMATCH', () => manager.inspectSource({ ...f.args, architecture: f.args.architecture === 'arm64' ? 'x64' : 'arm64' }));
    await rejects('RUNTIME_INTERPRETER_HASH_MISMATCH', () => manager.inspectSource({ ...f.args, interpreterPath: process.execPath }));
    const old = JSON.parse(execFileSync(process.execPath, ['-p', 'JSON.stringify({version:process.versions.node,architecture:process.arch,platform:process.platform})'], { encoding: 'utf8' }));
    const pins = JSON.parse(JSON.stringify(f.inputPins)); pins.hosts.openclaw.interpreter = { ...old, sha256: hashFile(fs.realpathSync(process.execPath)) };
    await rejects('RUNTIME_NODE_ENGINE_UNSUPPORTED', () => createManagedPluginHostRuntimeManager({ ...f.options, inputPins: pins }).inspectSource({ ...f.args, interpreterPath: process.execPath }));
  });
  await check('candidate reuse is deterministic and validates full output again', async () => {
    assert.equal((await manager.prepareCandidate(f.args)).candidateId, candidate.candidateId);
    const file = path.join(candidate.runtimeRoot, 'node_modules/dependency.txt');
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, 'mutated candidate'); fs.chmodSync(file, 0o400);
    assert.throws(() => manager.getCandidate('openclaw'), e => e.code === 'RUNTIME_CANDIDATE_TREE_MISMATCH');
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, 'fixed dependency\n'); fs.chmodSync(file, 0o400);
    assert.equal(manager.getCandidate('openclaw').candidateId, candidate.candidateId);
  });
  await check('changing descriptor and output together cannot substitute arbitrary code or candidate identity', async () => {
    const file = path.join(path.dirname(candidate.runtimeRoot), 'descriptor.json');
    const original = fs.readFileSync(file);
    const descriptor = JSON.parse(original); descriptor.runtimeTreeSha256 = '0'.repeat(64);
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, plainJson(descriptor)); fs.chmodSync(file, 0o400);
    assert.throws(() => manager.getCandidate('openclaw'), e => e.code === 'RUNTIME_DESCRIPTOR_INVALID');
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, original); fs.chmodSync(file, 0o400);
    const forgedId = '1'.repeat(64); const copied = path.join(path.dirname(path.dirname(candidate.runtimeRoot)), forgedId);
    fs.cpSync(path.dirname(candidate.runtimeRoot), copied, { recursive: true, dereference: false });
    fs.chmodSync(copied, 0o700);
    const forged = { ...JSON.parse(original), candidateId: forgedId };
    fs.chmodSync(path.join(copied, 'descriptor.json'), 0o600); fs.writeFileSync(path.join(copied, 'descriptor.json'), plainJson(forged)); fs.chmodSync(path.join(copied, 'descriptor.json'), 0o400);
    const pointerPath = path.join(f.state, 'external-plugin-host-runtimes/openclaw/candidate.json');
    const pointerOriginal = fs.readFileSync(pointerPath);
    fs.writeFileSync(pointerPath, plainJson({ version: 1, backendId: 'openclaw', candidateId: forgedId, descriptorDigest: sha(plainJson(forged)) }));
    assert.throws(() => manager.getCandidate('openclaw'), e => e.code === 'RUNTIME_CANDIDATE_ID_MISMATCH');
    fs.writeFileSync(pointerPath, pointerOriginal);
  });
  const lifecycle = fixture('lifecycle'); const real = actualController(lifecycle);
  const managed = createManagedPluginHostRuntimeManager({ ...lifecycle.options,
    activationAuthority: createManagedHostRuntimeAuthority(real.controller) });
  let lifecycleCandidate;
  await check('real synthetic child: exclusive fence → paused health → atomic active → resume', async () => {
    lifecycleCandidate = await managed.prepareCandidate(lifecycle.args);
    const value = await managed.activateCandidate({ backendId: 'openclaw', candidateId: lifecycleCandidate.candidateId, operationId: 'activate-1' });
    assert.equal(value.healthVerified, true); assert.equal(real.counters.start, 1); assert.equal(real.counters.stop, 0);
    assert.equal(real.isAlive(), true); assert.ok(fs.existsSync(path.join(real.dataRoot, 'writer.fence')));
    assert.equal(managed.getActive('openclaw').activationStatus, 'verified-in-current-process');
    const restarted = createManagedPluginHostRuntimeManager(lifecycle.options);
    assert.equal(restarted.getActive('openclaw').activationStatus, 'needs_verification');
    await rejects('RUNTIME_SUPERVISOR_UNAVAILABLE', () => restarted.activateCandidate({ backendId: 'openclaw', candidateId: lifecycleCandidate.candidateId, operationId: 'restart-unsafe' }));
  });
  await check('managed handoff verifies old child exit before starting exact new identity', async () => {
    const previous = real.writerIdentity();
    await managed.activateCandidate({ backendId: 'openclaw', candidateId: lifecycleCandidate.candidateId, operationId: 'activate-2' });
    assert.equal(real.counters.start, 2); assert.equal(real.counters.stop, 1);
    assert.notEqual(real.writerIdentity().pid, previous.pid); assert.notEqual(real.writerIdentity().nonce, previous.nonce);
    assert.throws(() => process.kill(previous.pid, 0), e => e.code === 'ESRCH');
  });
  await check('unknown owner has zero stop/start/fence and preserves actual active', async () => {
    const before = fs.readFileSync(path.join(lifecycle.state, 'external-plugin-host-runtimes/openclaw/active.json'), 'utf8');
    const counts = { ...real.counters }; real.foreignOwner(true);
    await rejects('RUNTIME_WRITER_OWNER_UNKNOWN', () => managed.activateCandidate({ backendId: 'openclaw', candidateId: lifecycleCandidate.candidateId, operationId: 'unknown-owner' }));
    real.foreignOwner(false); assert.deepEqual(real.counters, counts); assert.equal(real.isAlive(), true);
    assert.equal(fs.readFileSync(path.join(lifecycle.state, 'external-plugin-host-runtimes/openclaw/active.json'), 'utf8'), before);
  });
  await check('failed post-start health preserves prior pointer, closes owned child, durable uncertainty blocks replay', async () => {
    const before = fs.readFileSync(path.join(lifecycle.state, 'external-plugin-host-runtimes/openclaw/active.json'), 'utf8');
    real.rejectHealth(true);
    await rejects('FIXTURE_HEALTH_FAILED', () => managed.activateCandidate({ backendId: 'openclaw', candidateId: lifecycleCandidate.candidateId, operationId: 'health-failure' }));
    assert.equal(real.isAlive(), false); assert.equal(real.counters.failClosed, 1);
    assert.equal(fs.readFileSync(path.join(lifecycle.state, 'external-plugin-host-runtimes/openclaw/active.json'), 'utf8'), before);
    assert.throws(() => managed.getActive('openclaw'), e => e.code === 'RUNTIME_ACTIVATION_NEEDS_VERIFICATION');
    const starts = real.counters.start;
    await rejects('RUNTIME_ACTIVATION_NEEDS_VERIFICATION', () => managed.activateCandidate({ backendId: 'openclaw', candidateId: lifecycleCandidate.candidateId, operationId: 'no-replay' }));
    assert.equal(real.counters.start, starts);
  });
  await check('same data fence contention prevents second writer before any start', async () => {
    const blocked = fixture('fenced'); const owner = actualController(blocked);
    const m = createManagedPluginHostRuntimeManager({ ...blocked.options,
      activationAuthority: createManagedHostRuntimeAuthority(owner.controller) });
    const c = await m.prepareCandidate(blocked.args);
    write(path.join(owner.dataRoot, 'writer.fence'), 'unknown foreign owner');
    await assert.rejects(() => m.activateCandidate({ backendId: 'openclaw', candidateId: c.candidateId, operationId: 'held-fence' }), e => e.code === 'EEXIST');
    assert.equal(owner.counters.start, 0); assert.equal(owner.counters.stop, 0);
    assert.equal(fs.readFileSync(path.join(owner.dataRoot, 'writer.fence'), 'utf8'), 'unknown foreign owner');
  });
  await check('bounded cooperative timeout retires the operation before any writer start', async () => {
    const bounded = fixture('timeout-cooperative'); const owner = actualController(bounded);
    owner.controller.acquireDrain = context => new Promise((_, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    });
    const m = createManagedPluginHostRuntimeManager({ ...bounded.options, stageTimeoutMs: 50,
      activationAuthority: createManagedHostRuntimeAuthority(owner.controller) });
    const c = await m.prepareCandidate(bounded.args);
    await assert.rejects(() => m.activateCandidate({ backendId: 'openclaw', candidateId: c.candidateId, operationId: 'cooperative-timeout' }),
      e => e.code === 'RUNTIME_SUPERVISOR_TIMEOUT' && e.stage === 'acquireDrain' && e.cancellationConfirmed === true);
    assert.equal(owner.counters.start, 0); assert.equal(owner.counters.stop, 0);
    assert.throws(() => m.getActive('openclaw'), e => e.code === 'RUNTIME_ACTIVATION_NEEDS_VERIFICATION');
  });
  await check('uncooperative timeout is unknown, never falsely reported canceled', async () => {
    const bounded = fixture('timeout-uncooperative'); const owner = actualController(bounded);
    owner.controller.acquireDrain = () => new Promise(() => {});
    const m = createManagedPluginHostRuntimeManager({ ...bounded.options, stageTimeoutMs: 50,
      activationAuthority: createManagedHostRuntimeAuthority(owner.controller) });
    const c = await m.prepareCandidate(bounded.args);
    await assert.rejects(() => m.activateCandidate({ backendId: 'openclaw', candidateId: c.candidateId, operationId: 'uncooperative-timeout' }),
      e => e.code === 'RUNTIME_SUPERVISOR_TIMEOUT' && e.cancellationConfirmed === false);
    assert.equal(owner.counters.start, 0);
    const journal = JSON.parse(fs.readFileSync(path.join(bounded.state, 'external-plugin-host-runtimes/openclaw/activation.json')));
    assert.equal(journal.phase, 'needs_verification'); assert.equal(journal.cancellationConfirmed, false);
  });
  await check('retired start callback cannot perform a delayed writer spawn', async () => {
    const bounded = fixture('timeout-start'); const owner = actualController(bounded);
    const start = owner.controller.startPaused.bind(owner.controller);
    owner.controller.startPaused = async context => {
      await new Promise(resolve => setTimeout(resolve, 160)); context.assertCurrent(); return start(context);
    };
    const m = createManagedPluginHostRuntimeManager({ ...bounded.options, stageTimeoutMs: 50,
      activationAuthority: createManagedHostRuntimeAuthority(owner.controller) });
    const c = await m.prepareCandidate(bounded.args);
    await assert.rejects(() => m.activateCandidate({ backendId: 'openclaw', candidateId: c.candidateId, operationId: 'delayed-start' }),
      e => e.code === 'RUNTIME_SUPERVISOR_TIMEOUT' && e.stage === 'startPaused' && e.cancellationConfirmed === false);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(owner.counters.start, 0); assert.equal(owner.isAlive(), false);
  });
  await check('retired resume cannot publish active or leave a surviving synthetic writer', async () => {
    const bounded = fixture('timeout-resume'); const owner = actualController(bounded);
    const resume = owner.controller.resume.bind(owner.controller); let resumed = 0;
    owner.controller.resume = async context => {
      await new Promise(resolve => setTimeout(resolve, 800)); context.assertCurrent(); resumed++; return resume(context);
    };
    const m = createManagedPluginHostRuntimeManager({ ...bounded.options, stageTimeoutMs: 500,
      activationAuthority: createManagedHostRuntimeAuthority(owner.controller) });
    const c = await m.prepareCandidate(bounded.args);
    await assert.rejects(() => m.activateCandidate({ backendId: 'openclaw', candidateId: c.candidateId, operationId: 'delayed-resume' }),
      e => e.code === 'RUNTIME_SUPERVISOR_TIMEOUT' && e.stage === 'resume');
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(resumed, 0); assert.equal(owner.isAlive(), false);
    assert.equal(fs.existsSync(path.join(bounded.state, 'external-plugin-host-runtimes/openclaw/active.json')), false);
  });
  await check('Hermes actual interpreter dependency probe never promotes borrowed venv', async () => {
    const h = fixture('hermes', 'hermes'); const m = createManagedPluginHostRuntimeManager(h.options);
    const inspected = await m.inspectSource(h.args);
    assert.equal(inspected.interpreter.version, '3.11.15'); assert.equal(inspected.interpreter.uvicorn, true);
    assert.equal(inspected.dependencyMode, 'external-verified-not-self-contained');
    await rejects('RUNTIME_HERMES_EXTERNAL_VENV', () => m.prepareCandidate(h.args));
    assert.equal(m.getCandidate('hermes'), null); assert.equal(m.getActive('hermes'), null);
    const stages = fs.readdirSync(path.join(h.state, 'external-plugin-host-runtimes/hermes/candidates'));
    assert.deepEqual(stages, []);
  });
  await check('symlink state directory and unknown mutation owner fail closed', async () => {
    const s = fixture('unsafe-state'); fs.symlinkSync(f.state, s.state);
    await rejects('RUNTIME_PRIVATE_DIRECTORY_UNSAFE', () => createManagedPluginHostRuntimeManager(s.options).prepareCandidate(s.args));
    const lock = path.join(f.state, 'external-plugin-host-runtimes/openclaw/.mutation-lock'); fs.mkdirSync(lock, { mode: 0o700 });
    await rejects('RUNTIME_MUTATION_OWNER_UNKNOWN', () => manager.prepareCandidate(f.args)); fs.rmdirSync(lock);
  });
  console.log(JSON.stringify({ status: 'PASS', groups: results.length, cases: results,
    boundary: 'Synthetic small input tree and genuine interpreter/child lifecycle; no production Host supervisor certification',
    sourceOrGlobalWrites: 0, productionHostStarts: 0, modelRequests: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const c of controllers) await c.close();
  const loosen = dir => { fs.chmodSync(dir, 0o700); for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) loosen(path.join(dir, entry.name));
  } };
  loosen(root); fs.rmSync(root, { recursive: true, force: true });
});
