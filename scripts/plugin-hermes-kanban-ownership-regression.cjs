'use strict';
// Real Backend/Scope/broker over synthetic loopback HTTP/WS. No Host, model,
// credential store, legacy Home, or installed Hermes process is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const { WebSocket, WebSocketServer } = require('ws');
const { HermesBackend } = require('../app/core/hermes-backend');
const { attachKanbanBroker } = require('../app/core/kanban-broker');

const sourceFiles = ['app/core/hermes-backend.js', 'app/core/hermes-local-runtime-scope.js', 'app/core/kanban-broker.js', 'scripts/plugin-hermes-kanban-ownership-regression.cjs'];
const digest = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, p))).digest('hex');
const codeHashes = Object.fromEntries(sourceFiles.map(p => [p, digest(p)]));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label) {
  const expires = Date.now() + 2000;
  while (!condition()) { assert.ok(Date.now() < expires, `${label} deadline`); await sleep(5); }
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const results = [];
const tests = [];
const test = (name, run) => tests.push({name, run});

async function context(run) {
  const temporary = fs.realpathSync(fs.mkdtempSync('/private/tmp/hermes-kanban-regression-'));
  const runtimeRoot = path.join(temporary, 'runtime'), stateDir = path.join(temporary, 'private-data');
  const home = path.join(stateDir, 'home'), workspace = path.join(stateDir, 'workspace');
  for (const p of [runtimeRoot, path.join(runtimeRoot, 'hermes_cli'), stateDir, home, workspace, path.join(stateDir, 'profiles', 'coder')]) fs.mkdirSync(p, {recursive: true, mode: 0o700});
  const interpreterPath = path.join(runtimeRoot, 'python'), entryPath = path.join(runtimeRoot, 'hermes_cli/main.py'), configPath = path.join(stateDir, 'config.yaml');
  for (const p of [interpreterPath, entryPath, configPath]) fs.writeFileSync(p, '# never executed: scope boundary fixture\n', {mode: 0o600});
  const execution = {runtimeRoot, stateDir, interpreterPath, entryPath, home, workspace, configPath, env: {HOME: home, HERMES_HOME: stateDir}};
  const peers = [], boardQueries = [], browsers = [], brokerServers = [], brokerWebSockets = [], backends = [];
  let endpoint, executionValue = execution, upstreamUpgrades = 0;
  const upstream = http.createServer((req, res) => {
    boardQueries.push(new URL(req.url, 'http://127.0.0.1'));
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({latest_event_id: 2, columns: []}));
  });
  upstream.on('upgrade', () => { upstreamUpgrades++; });
  const upstreamWs = new WebSocketServer({server: upstream});
  upstreamWs.on('connection', (ws, req) => { ws.on('error', () => {}); peers.push({ws, url: new URL(req.url, endpoint.baseUrl)}); });
  await listen(upstream);
  endpoint = {baseUrl: `http://127.0.0.1:${upstream.address().port}`, token: 'a'.repeat(64), identity: {pid: process.pid, startIdentity: 'isolated-kanban-audit', nonce: 'b'.repeat(64)}, runtimeRoot, dataRoot: stateDir, interpreterPath, entryPath};
  const makeBackend = (profile = 'coder') => {
    const backend = new HermesBackend({bin: 'never-spawn', getManagedExecution: () => executionValue, getManagedEndpoint: () => endpoint});
    backend.dashboards.set(profile, backend._localRuntime.bindDashboard(profile));
    backend._installProfileRows([{name: profile}]);
    backend._kanbanDrainDeadlineMs = 1000;
    backends.push(backend);
    return backend;
  };
  async function browserFor(registry) {
    const server = http.createServer();
    const wss = attachKanbanBroker(server, {registry});
    brokerServers.push(server); brokerWebSockets.push(wss);
    await listen(server);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = new WebSocket(origin.replace('http', 'ws') + '/__kanbanws?board=synthetic-board', {headers: {Origin: origin}});
    const frames = [];
    browser.on('error', () => {});
    browser.on('message', data => frames.push(JSON.parse(data.toString())));
    browsers.push(browser);
    await until(() => browser.readyState !== WebSocket.CONNECTING, 'browser handshake');
    return {browser, frames};
  }
  const frame = (id, cursor = id) => ({events: [{id, created_at: Date.now()/1000, event: 'task.created', task_id: 'synthetic-task'}], cursor});
  const send = (peer, body) => { if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify(body)); };
  try {
    await run({makeBackend, peers, boardQueries, browserFor, frame, send, upstreamUrl: endpoint.baseUrl, upgrades: () => upstreamUpgrades,
      rotate: () => { endpoint = {...endpoint, identity: {...endpoint.identity, nonce: 'c'.repeat(64)}}; },
      unavailable: () => { executionValue = null; },
    });
  } finally {
    for (const backend of backends) await backend.stop().catch(() => {});
    for (const browser of browsers) browser.terminate();
    for (const wss of brokerWebSockets) for (const ws of wss.clients) ws.terminate();
    for (const ws of upstreamWs.clients) ws.terminate();
    await Promise.all(brokerServers.map(close));
    await close(upstream);
    for (const wss of brokerWebSockets) await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => upstreamWs.close(resolve));
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}

test('normal named-profile drain writes its journal and preserves HTTP/WS profile', () => context(async c => {
  const backend = c.makeBackend();
  const result = backend.getRecentKanbanActivities();
  await until(() => c.peers.length === 1, 'drain peer');
  assert.equal(c.boardQueries[0].searchParams.get('profile'), 'coder');
  assert.equal(c.peers[0].url.searchParams.get('profile'), 'coder');
  assert.equal(c.peers[0].url.searchParams.get('since'), '0');
  c.send(c.peers[0], c.frame(2));
  assert.equal((await result).supported, true);
  const journal = backend._ensureDashboardJournal();
  assert.equal(journal.getKanbanEvents('hermes:coder').length, 1);
  assert.equal(journal.getKanbanCursor('hermes:coder'), 2);
}));

for (const transition of ['stop', 'identity-rotation']) test(`drain ${transition} discards buffered and late rows without advancing cursor`, () => context(async c => {
  const backend = c.makeBackend(), journal = backend._ensureDashboardJournal();
  journal.setKanbanCursor('hermes:coder', 0);
  const pending = backend.getRecentKanbanActivities();
  await until(() => c.peers.length === 1, 'drain peer');
  c.send(c.peers[0], c.frame(1));
  await sleep(15);
  if (transition === 'stop') await backend.stop(); else c.rotate();
  c.send(c.peers[0], c.frame(2));
  assert.equal((await pending).supported, false);
  assert.equal(journal.getKanbanEvents('hermes:coder').length, 0);
  assert.equal(journal.getKanbanCursor('hermes:coder'), 0);
}));

test('managed caller cannot invoke a raw unbound drain or counterfeit a dashboard', () => context(async c => {
  const backend = c.makeBackend();
  for (const dashboard of [undefined, {managed: true, profile: 'coder', assertCurrent: () => true}]) {
    const result = await backend._drainKanbanEvents({wsUrl: c.upstreamUrl.replace('http', 'ws') + '/api/plugins/kanban/events', token: 'caller-invented', since: 7, latest: 8, deadlineMs: 20, dashboard});
    assert.deepEqual(result, {rows: [], cursor: 7, complete: false, retired: true});
  }
  await sleep(20);
  assert.equal(c.upgrades(), 0);
}));

test('unavailable managed owner returns no target and performs zero WS upgrades', () => context(async c => {
  const backend = c.makeBackend(); c.unavailable();
  assert.equal(backend.getKanbanEventsTarget(), null);
  const {browser, frames} = await c.browserFor({getBackend: () => backend});
  await until(() => browser.readyState === WebSocket.CLOSED, 'unavailable browser close');
  assert.equal(c.upgrades(), 0); assert.equal(frames.length, 0);
}));

for (const transition of ['stop', 'identity-rotation', 'registry-withdrawal']) test(`live bridge ${transition} rejects late frames and closes without reconnect`, () => context(async c => {
  const backend = c.makeBackend(); let enabled = true;
  const {browser, frames} = await c.browserFor({getBackend: () => enabled ? backend : null});
  await until(() => c.peers.length === 1, 'live peer');
  assert.equal(c.peers[0].url.searchParams.get('profile'), 'coder');
  assert.equal(c.peers[0].url.searchParams.get('board'), 'synthetic-board');
  c.send(c.peers[0], c.frame(1));
  await until(() => frames.length === 1, 'current live frame');
  if (transition === 'stop') await backend.stop();
  else if (transition === 'identity-rotation') c.rotate();
  else enabled = false;
  c.send(c.peers[0], c.frame(2));
  await until(() => browser.readyState === WebSocket.CLOSED, 'retired live browser close');
  assert.equal(frames.length, 1); assert.equal(c.upgrades(), 1);
}));

test('target getter exception closes browser safely with zero upstream effects', () => context(async c => {
  const {browser, frames} = await c.browserFor({getBackend: () => ({getKanbanEventsTarget() { throw Error('fixture target lookup failure'); }})});
  await until(() => browser.readyState === WebSocket.CLOSED, 'lookup failure close');
  assert.equal(frames.length, 0); assert.equal(c.upgrades(), 0);
}));

test('broker final send guard rejects retirement during URL serialization', () => context(async c => {
  // Fault injection only for the broker's final-send boundary. All managed
  // success/ownership tests above use the real Scope's private WeakMap brand.
  let retired = false;
  const target = {wsUrl: {toString() { retired = true; return c.upstreamUrl.replace('http', 'ws') + '/api/plugins/kanban/events'; }}, token: 'fixture-only', assertCurrent() { if (retired) throw Error('retired'); return true; }};
  const fixtureBackend = {getKanbanEventsTarget: () => target};
  const {browser, frames} = await c.browserFor({getBackend: () => fixtureBackend});
  await until(() => browser.readyState === WebSocket.CLOSED, 'serialization retirement close');
  assert.equal(retired, true); assert.equal(frames.length, 0); assert.equal(c.upgrades(), 0);
}));

(async () => {
  for (const {name, run} of tests) { await run(); results.push({name, passed: true}); process.stdout.write(`PASS ${name}\n`); }
  assert.ok(sourceFiles.every(p => digest(p) === codeHashes[p]), 'Source changed during proof; rerun against stable sources');
  const evidence = {version: 1, verified: true, generatedAt: new Date().toISOString(), sourceStable: true, codeHashes, passed: results.length, groups: results,
    actualLocalHttp: true, actualLocalWebSocket: true, realManagedRuntimeExecuted: false, realModelOrAccount: false, boundary: 'Production HermesBackend/Scope and Kanban broker; injected private scope and synthetic loopback data; final-serialization fault uses a fixture descriptor only'};
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) { const output = process.argv[outputIndex + 1]; assert.ok(output); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600}); }
  process.stdout.write(JSON.stringify(evidence) + '\n');
})().catch(e => { process.stderr.write(String(e.stack || e) + '\n'); process.exitCode = 1; });
