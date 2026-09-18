"use strict";
// Isolated L2 fixture. Production Service, Backend, REST, proxy, Helper and UI;
// only the external Codex process and upstream federation transport are fake.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { createAgentService, PROTOCOL_VERSION } = require('../../app/agent-service/server');
const { requestService, readClientToken } = require('../../app/agent-service/client');
const { resolveServicePaths } = require('../../app/agent-service/paths');
const { DEFAULT_AGENT_PROFILE_ID } = require('../../app/agent-service/product-store');
const { CodexRuntimeHost } = require('../../app/agent-service/codex-runtime-host');
const { CodexRuntimePool } = require('../../app/agent-service/codex-runtime-pool');
const { prepareCodexRuntimeAccountHome } = require('../../app/agent-service/codex-runtime-paths');
const { ShoggothBackend } = require('../../app/core/shoggoth-backend');
const { BackendRegistry } = require('../../app/core/backend-registry');
const { startProxyGateway } = require('../../app/core/proxy-gateway');
const { createWorkAdmissionGate } = require('../../app/core/work-admission-gate');
const { DEFAULT_OPERATOR_SCOPES, generateIdentity } = require('../../app/core/device-auth');
const { startStaticServer } = require('../../app/static-server');
const { createFederationHostServer } = require('../../app/federation-host-server');
const { authenticateMcpSession, createMcpStdioHandler } = require('../../app/shoggoth-mcp-helper');
const ROOT = path.resolve(__dirname, '../..');

async function startInspirationFixture(options = {}) {
  // Leave room for app-host.sock within macOS's Unix socket path limit.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shg-insp-')));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, 'state'),
    profileRoot: path.join(root, 'profiles'), cacheRoot: path.join(root, 'cache') });
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
  const responsesPath = path.join(root, 'responses.jsonl');
  const runtimePool = new CodexRuntimePool({ paths, repoRoot: ROOT, failureThreshold: 100,
    runtimeAccountResolver: { resolve(binding, account) {
      const home = prepareCodexRuntimeAccountHome(paths, binding.runtimeAccountId);
      return Object.freeze({ runtime: binding.runtime, runtimeAccountId: binding.runtimeAccountId,
        kind: account.kind, installationKind: 'bundled', homeKind: account.homeKind, strategy: 'managed-shared',
        home, nativeHome: null, integrationRoot: null, binaryPath: process.execPath,
        launchArgs: Object.freeze(['app-server']), spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: home }), configurationMode: 'overlay' });
    } },
    hostFactory: (hostOptions) => new CodexRuntimeHost({ ...hostOptions, repoRoot: ROOT,
      packageVersion: '0.8.79', probeBinary: async () => {},
      spawnEnv: { CODEX_FAKE_BEHAVIOR: 'mcp-elicitation',
        CODEX_FAKE_PROFILE: options.agentCount > 1 ? `inspiration-${hostOptions.runtimeProfileId}` : 'inspiration-ui',
        CODEX_FAKE_ID_NAMESPACE: options.agentCount > 1 ? hostOptions.runtimeProfileId : '',
        CODEX_FAKE_ELICITATION_MODE: 'valid', CODEX_FAKE_ELICITATION_RESPONSE_PATH: responsesPath,
        CODEX_FAKE_ELICITATION_REPEAT: '1', CODEX_FAKE_COMPLETE_AFTER_ELICITATION: '1',
        CODEX_FAKE_INDEPENDENT_IDS: '1', CODEX_FAKE_INSPIRATION_APPROVALS: '1' },
      spawnProcess(_cmd, _args, options) { return spawn(process.execPath, [path.join(ROOT, 'scripts/fixtures/codex-app-server-fake.cjs')], options); },
      requestTimeoutMs: 2000, initializeTimeoutMs: 2000, serverRequestTimeoutMs: 300000,
      shutdownGraceMs: 100, killGraceMs: 100,
    }) });
  const service = createAgentService({ paths, safeStorage, runtimePool, version: 'inspiration-l2' });
  await service.start();
  const token = readClientToken(paths);
  const ipc = (method, params) => requestService(paths, { id: crypto.randomUUID(), token, version: PROTOCOL_VERSION, method, params });
  const profile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  for (let index = 1; index < (options.agentCount || 1); index++) {
    await ipc('agent.create', { operationId: `inspiration-fixture-agent-${index}`, backendId: 'shoggoth',
      name: `Growth Agent ${index + 1}`, defaultCwd: null, createdAt: Date.now() });
  }
  let helperAuthentications = 0;
  const loadSession = async () => {
    const session = await authenticateMcpSession({ paths, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, safeStorage });
    helperAuthentications++;
    return session;
  };
  const session = await loadSession();
  const backend = new ShoggothBackend({ paths, pollIntervalMs: 15, readinessIntervalMs: 10, readinessTimeoutMs: 5000 });
  const registry = new BackendRegistry(); registry.register(backend); registry.setInspirationOwner(backend);
  // Registry installs the same session/activity observers as the desktop app.
  if ((await registry.start()).get(backend.id) !== true) { await service.stop(); throw new Error('Fixture backend did not start'); }
  const desktopHost = createFederationHostServer({ paths, registry });
  try { await desktopHost.start(); }
  catch (error) { session.close?.(); await backend.stop(); await service.stop(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture' } }));
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()); if (frame.type !== 'req') return;
      let payload = {};
      if (frame.method === 'connect') payload = { type: 'hello-ok', protocol: 1, server: { version: '2026.8.1' },
        features: { methods: [], events: [] }, auth: { role: 'operator', scopes: [] }, policy: { maxPayload: 65536, maxBufferedBytes: 262144 } };
      else if (frame.method === 'agents.list') payload = { agents: [{ id: 'main', name: 'Fixture' }] };
      else if (frame.method === 'models.list') payload = { models: [] };
      else if (frame.method === 'sessions.list') payload = { ts: Date.now(), path: '/', count: 0, defaults: {}, sessions: [] };
      socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => `ws://127.0.0.1:${upstream.address().port}`,
    registry, workAdmissionGate: createWorkAdmissionGate() });
  const identity = generateIdentity();
  const staticServer = await startStaticServer(options.port || 0, { registry, chatUpstreamUrl: proxy.url, chatOrigin: 'http://127.0.0.1',
    hostOps: options.hostOps,
    configStore: options.configStore,
    authResolver: { resolveConnectAuth: () => ({ ...identity, token: 'inspiration-fixture', scopes: DEFAULT_OPERATOR_SCOPES }), storeDeviceToken() {} } });
  const helper = createMcpStdioHandler({ paths, runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId, sessionToken: session.token,
    sessionExpiresAt: session.expiresAt, refreshSession: loadSession, requestService });
  await helper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18",
    capabilities: {}, clientInfo: { name: "inspiration-l2", version: "1" } } });
  let helperSequence = 1;
  const inspect = async () => {
    const runs = service.productStore.listWorkRuns().filter((run) => run.source === 'inspiration');
    let runtimeContext = null;
    const active = runs.find((run) => ['running', 'waiting_input', 'waiting_approval'].includes(run.status));
    if (active) runtimeContext = await helper({ jsonrpc: '2.0', id: ++helperSequence, method: 'tools/call',
      params: { name: 'runtime_context_get', arguments: { source: 'inspiration', sourceId: active.sourceId } } });
    return { ideas: service.inspirationStore.list(), runs, runtimeContext, helperAuthentications,
      growth: service.inspirationService.growthView(),
      responses: fs.existsSync(responsesPath) ? fs.readFileSync(responsesPath, 'utf8').trim().split('\n').filter(Boolean).length : 0,
      coordinator: service.workRunCoordinator.getMemoryStats(),
      errors: [...service.workRunCoordinator.lastErrors.entries()].map(([runId, error]) => ({ runId, code: error.code, message: error.message })),
      backend: { prompts: backend._promptByRequest.size, active: backend._activeBySession.size },
      sessions: service.chatSessionStore.listSessions().map((item) => ({ id: item.id, status: item.status })) };
  };
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    helper.close?.(); session.close?.();
    await staticServer.close();
    await proxy.close(); await desktopHost.stop(); await backend.stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    await service.stop(); fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, paths, service, backend, registry, desktopHost, ipc, inspect, close, url: staticServer.url };
}
module.exports = { startInspirationFixture };

if (require.main === module) {
  startInspirationFixture({ agentCount: Number(process.env.INSPIRATION_FIXTURE_AGENTS || 1) }).then((fixture) => {
    const control = http.createServer(async (req, res) => {
      try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await fixture.inspect())); }
      catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error.stack || error) })); }
    });
    control.listen(0, '127.0.0.1', () => {
      const info = { url: fixture.url, stateUrl: `http://127.0.0.1:${control.address().port}`, root: fixture.root };
      const target = process.argv[2]; if (target) fs.writeFileSync(target, JSON.stringify(info), { mode: 0o600 });
      console.log(JSON.stringify(info));
    });
    const stop = async () => { await new Promise((resolve) => control.close(resolve)); await fixture.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch((error) => { console.error(error); process.exit(1); });
}
