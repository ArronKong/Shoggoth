'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const Module = require('node:module');
const {WebSocketServer} = require('ws');
const repo = path.resolve(__dirname, '..');
const productionBackend = path.join(repo, 'app/core/hermes-backend.js');
const argument = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const reviewSource = argument('--backend-source');
let HermesBackend;
if (reviewSource) {
  // Review-only candidate code resolves the exact production dependencies. The
  // original file is neither replaced nor patched; evidence labels this mode.
  const candidate = new Module(productionBackend, module);
  candidate.filename = productionBackend;
  candidate.paths = Module._nodeModulePaths(path.dirname(productionBackend));
  candidate._compile(fs.readFileSync(reviewSource, 'utf8'), productionBackend);
  ({HermesBackend} = candidate.exports);
} else ({HermesBackend} = require('../app/core/hermes-backend'));

const sourceFiles = ['app/core/hermes-backend.js', 'app/core/hermes-local-runtime-scope.js', 'app/core/hermes-gateway-rpc.js', 'scripts/plugin-hermes-slash-owner-regression.cjs'];
const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const codeHashes = Object.fromEntries(sourceFiles.map(p => [p, digest(path.join(repo, p))]));
const reviewSourceHash = reviewSource ? digest(reviewSource) : null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label) {
  const expires = Date.now() + 2000;
  while (!condition()) { assert.ok(Date.now() < expires, `${label} deadline`); await sleep(5); }
}
const tests = [], groups = [];
const test = (name, run) => tests.push({name, run});

async function context(run) {
  const temporary = fs.realpathSync(fs.mkdtempSync('/private/tmp/hermes-slash-owner-regression-'));
  const runtimeRoot = path.join(temporary, 'runtime'), stateDir = path.join(temporary, 'private-data');
  const home = path.join(stateDir, 'home'), workspace = path.join(stateDir, 'workspace');
  for (const p of [runtimeRoot, path.join(runtimeRoot, 'hermes_cli'), stateDir, home, workspace, path.join(stateDir, 'profiles/coder')]) fs.mkdirSync(p, {recursive: true, mode: 0o700});
  const interpreterPath = path.join(runtimeRoot, 'python'), entryPath = path.join(runtimeRoot, 'hermes_cli/main.py'), configPath = path.join(stateDir, 'config.yaml');
  for (const p of [interpreterPath, entryPath, configPath]) fs.writeFileSync(p, '# scope fixture: never executed\n', {mode: 0o600});
  const execution = {runtimeRoot, stateDir, home, workspace, interpreterPath, entryPath, configPath, env: {HOME: home, HERMES_HOME: stateDir}};
  let endpoint, holdMethod = null, holdUpgrades = false;
  const frames = [], pending = [], heldUpgrades = [], peers = [], backends = [];
  const server = http.createServer(), wss = new WebSocketServer({noServer: true});
  const accept = ({req, socket, head}) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  server.on('upgrade', (req, socket, head) => { if (holdUpgrades) heldUpgrades.push({req, socket, head}); else accept({req, socket, head}); });
  wss.on('connection', (ws, req) => {
    ws.on('error', () => {}); peers.push(ws);
    ws.on('message', data => {
      const frame = JSON.parse(data.toString()); frames.push(frame);
      if (frame.method === holdMethod) pending.push({ws, id: frame.id});
      else ws.send(JSON.stringify({jsonrpc: '2.0', id: frame.id, result: frame.method === 'commands.catalog' ? {pairs: [['synthetic-current', 'Synthetic current command']]} : {items: [{value: '/synthetic-current'}]}}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = {baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'a'.repeat(64), identity: {pid: process.pid, startIdentity: 'private-slash-fixture', nonce: 'b'.repeat(64)}, runtimeRoot, dataRoot: stateDir, interpreterPath, entryPath};
  const makeBackend = ({managed = true, profile = 'default'} = {}) => {
    const backend = new HermesBackend({bin: 'never-spawn', getManagedExecution: () => managed ? execution : undefined, getManagedEndpoint: () => endpoint});
    backend._installProfileRows([{name: profile}]);
    backend.dashboards.set(profile, managed ? backend._localRuntime.bindDashboard(profile) : {profile, baseUrl: endpoint.baseUrl, token: endpoint.token});
    backends.push(backend); return backend;
  };
  try {
    await run({makeBackend, frames, pending, heldUpgrades,
      hold: method => { holdMethod = method; },
      holdUpgrade: () => { holdUpgrades = true; },
      acceptHeld: () => { holdUpgrades = false; for (const item of heldUpgrades.splice(0)) accept(item); },
      rotate: () => { endpoint = {...endpoint, identity: {...endpoint.identity, nonce: 'c'.repeat(64)}}; },
      reply: (item, result) => { item.ws.send(JSON.stringify({jsonrpc: '2.0', id: item.id, result})); },
    });
  } finally {
    for (const backend of backends) await backend.stop().catch(() => {});
    for (const item of heldUpgrades) item.socket.destroy();
    for (const ws of peers) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}

test('legacy default and named independent hosts preserve catalog/completion wire', () => context(async c => {
  for (const profile of ['default', 'coder']) {
    const backend = c.makeBackend({managed: false, profile});
    assert.equal((await backend.listSlashCommands(`hermes-${profile}`)).supported, true);
    assert.equal((await backend.completeSlash(`hermes-${profile}`, '/synthetic')).supported, true);
  }
  assert.deepEqual(c.frames.map(x => x.params), [{}, {text: '/synthetic'}, {}, {text: '/synthetic'}]);
}));

test('managed default catalog uses formal profile and completion keeps supported schema', () => context(async c => {
  const backend = c.makeBackend();
  assert.equal((await backend.listSlashCommands('hermes-default')).supported, true);
  assert.equal((await backend.completeSlash('hermes-default', '/synthetic')).supported, true);
  assert.deepEqual(c.frames.map(x => x.params), [{profile: 'default'}, {text: '/synthetic'}]);
}));

test('managed named metadata without exact supported scope is unavailable with zero RPC/model sessions', () => context(async c => {
  const backend = c.makeBackend({profile: 'coder'});
  assert.deepEqual(await backend.listSlashCommands('hermes-coder'), {supported: false, reason: 'profile-scope-unavailable', commands: []});
  assert.deepEqual(await backend.completeSlash('hermes-coder', '/synthetic'), {supported: false, reason: 'profile-scope-unavailable', items: []});
  assert.equal(c.frames.length, 0);
  assert.equal(backend.gwRuntimeByKey.size, 0); assert.equal(backend.acpClients.size, 0);
}));

for (const method of ['catalog', 'completion']) test(`one-shot ${method} rejects a late reply after Backend stop with live owner unchanged`, () => context(async c => {
  const backend = c.makeBackend(); c.hold(method === 'catalog' ? 'commands.catalog' : 'complete.slash');
  const pending = method === 'catalog' ? backend.listSlashCommands('hermes-default') : backend.completeSlash('hermes-default', '/synthetic');
  await until(() => c.pending.length === 1, 'pending one-shot read');
  await backend.stop();
  c.reply(c.pending[0], {pairs: [['old-profile-data', 'Old data']], items: [{value: 'old-profile-data'}]});
  const result = await pending;
  assert.equal(result.supported, false);
  assert.equal((result.commands || result.items).length, 0);
  assert.equal(c.frames.length, 1);
}));

test('one-shot rejects replaced same-profile dashboard Map identity without owner rotation', () => context(async c => {
  const backend = c.makeBackend(); c.hold('commands.catalog');
  const pending = backend.listSlashCommands('hermes-default');
  await until(() => c.pending.length === 1, 'pending catalog');
  backend.dashboards.set('default', backend._localRuntime.bindDashboard('default'));
  c.reply(c.pending[0], {pairs: [['old-binding-data', 'Old binding']]});
  const result = await pending; assert.equal(result.supported, false); assert.equal(result.commands.length, 0);
}));

test('one-shot still rejects actual Scope owner rotation and does not retry', () => context(async c => {
  const backend = c.makeBackend(); c.hold('commands.catalog');
  const pending = backend.listSlashCommands('hermes-default');
  await until(() => c.pending.length === 1, 'pending catalog'); c.rotate();
  c.reply(c.pending[0], {pairs: [['retired-owner-data', 'Retired owner']]});
  assert.equal((await pending).supported, false); assert.equal(c.frames.length, 1);
}));

test('retirement during completion text coercion causes zero business frames', () => context(async c => {
  const backend = c.makeBackend();
  const result = await backend.completeSlash('hermes-default', {toString() { backend.stop(); return '/synthetic'; }});
  assert.equal(result.supported, false); assert.equal(result.items.length, 0); assert.equal(c.frames.length, 0);
}));

test('in-flight actual WS upgrade rechecks Backend retirement before first send', () => context(async c => {
  const backend = c.makeBackend(); c.holdUpgrade();
  const pending = backend.listSlashCommands('hermes-default');
  await until(() => c.heldUpgrades.length === 1, 'held upgrade');
  await backend.stop(); c.acceptHeld();
  assert.equal((await pending).supported, false); assert.equal(c.frames.length, 0);
}));

(async () => {
  for (const {name, run} of tests) { await run(); groups.push({name, passed: true}); process.stdout.write(`PASS ${name}\n`); }
  assert.ok(sourceFiles.every(p => digest(path.join(repo, p)) === codeHashes[p]), 'Production dependency/source drift during proof');
  if (reviewSource) assert.equal(digest(reviewSource), reviewSourceHash, 'Review candidate changed during proof');
  const evidence = {version: 1, verified: true, generatedAt: new Date().toISOString(), passed: groups.length, groups, codeHashes, sourceStable: true,
    backendBoundary: reviewSource ? 'review-candidate-with-production-dependencies' : 'production-source', reviewSourceSha256: reviewSourceHash,
    actualLocalWebSocket: true, realHostModelAccountOrSkillExecuted: false, boundary: 'Real HermesBackend/Scope/gatewayRpc over synthetic loopback WS; private scope files never executed; no global CLI fallback'};
  const output = argument('--output'); if (output) fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
  process.stdout.write(JSON.stringify(evidence) + '\n');
})().catch(e => { process.stderr.write(String(e.stack || e) + '\n'); process.exitCode = 1; });
