#!/usr/bin/env node
'use strict';
// Real fixed OpenClaw Host -> exact production adapter -> isolated Service IPC.
// Only a fixture package and local HTTP model; no account/global host writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const { pathToFileURL } = require('node:url');
const { createAgentService } = require('../app/agent-service/server');
const { resolveServicePaths } = require('../app/agent-service/paths');
const { SERVICE_PROTOCOL_VERSION } = require('../app/agent-service/service-protocol-version');
const { requestService } = require('../app/agent-service/client');
const { ensureCredential } = require('../app/agent-service/external-plugin-adapter-auth');
const { ShoggothBackend } = require('../app/core/shoggoth-backend');
const { OpenClawBackend } = require('../app/core/openclaw-backend');
const { BackendRegistry } = require('../app/core/backend-registry');
const { createAuthResolver, buildConnectParams, generateIdentity } = require('../app/core/device-auth');
const { startProxyGateway } = require('../app/core/proxy-gateway');
const { createWorkAdmissionGate } = require('../app/core/work-admission-gate');
const { createFederationHostServer } = require('../app/federation-host-server');
const { FederationHostClient } = require('../app/agent-service/federation-host-client');
const { loadManifest, validatePinnedSource } = require('./openclaw-selection-host-patch.cjs');
const ID = 'shoggoth-shared-capabilities';
const SEARCH = 'shoggoth_capability_search';
const CALL = 'shoggoth_plugin_call';
const MODEL = 'shoggoth-selection-service-local-proof';
const GATEWAY_TOKEN = 'isolated-selection-service-gateway-only';
const NODE = (process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { if (await test()) return; await delay(100); }
  throw new Error(`${label} timed out`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function stream(response, tool, toolCallId = "call_selected_search", finalText = "The isolated selected task finished.") {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const deltas = tool ? [{ role: 'assistant', tool_calls: [{ index: 0, id: toolCallId, type: 'function',
    function: { name: tool === true ? SEARCH : tool.name, arguments: JSON.stringify(tool === true ? { query: '' } : tool.arguments) } }] }] : [{ role: 'assistant', content: finalText }];
  for (const delta of deltas) response.write(`data: ${JSON.stringify({ id: 'selection-service-local', object: 'chat.completion.chunk', created: 1,
    model: MODEL, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: 'selection-service-local', object: 'chat.completion.chunk', created: 1,
    model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
  response.end('data: [DONE]\n\n');
}
async function productClient(url, authenticate = true, identity = generateIdentity()) {
  const socket = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1' } });
  const pending = new Map(); const frames = []; let counter = 0; let connectSent = false;
  let readyResolve, readyReject; const ready = new Promise((resolve,reject) => { readyResolve = resolve; readyReject = reject; });
  const request = (method, params = {}) => new Promise((resolve,reject) => {
    const id = `product-selection-${++counter}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(id, { resolve: payload => { clearTimeout(timer); resolve(payload); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ type:'req',id,method,params }));
  });
  const fail = error => { readyReject(error); for (const item of pending.values()) item.reject(error); pending.clear(); };
  socket.on('error',fail); socket.on('close',() => fail(new Error('product proxy socket closed')));
  socket.on('open',() => { if (!authenticate) readyResolve(); });
  socket.on('message', bytes => {
    const frame = JSON.parse(bytes.toString()); frames.push(frame);
    if (frame.type === 'event' && frame.event === 'connect.challenge' && authenticate && !connectSent) {
      connectSent = true; void request('connect',buildConnectParams({ ...identity,token:GATEWAY_TOKEN,scopes:['operator.read','operator.write'] },frame.payload?.nonce)).then(readyResolve,readyReject); return;
    }
    if (frame.type !== 'res') return;
    const entry = pending.get(frame.id); if (!entry) return; pending.delete(frame.id);
    if (frame.ok) entry.resolve(frame.payload); else entry.reject(Object.assign(new Error(`${frame.error?.code}: ${frame.error?.message}`),{code:frame.error?.code}));
  });
  await ready; return {request,frames,identity,close:() => socket.close()};
}
function verifyRuntime() {
  const owned = fs.realpathSync(process.env.SHOGGOTH_TEST_OPENCLAW_REUSE_ROOT || '/private/tmp/shoggoth-openclaw-selection-TzyShA');
  assert.ok(owned.startsWith('/private/tmp/shoggoth-openclaw-selection-'), 'only an owned isolated runtime is accepted');
  const runtime = path.join(owned, 'openclaw'); const { manifest } = loadManifest();
  for (const item of [...manifest.files, ...manifest.newFiles]) assert.equal(sha(fs.readFileSync(path.join(runtime, item.path))), item.afterSha256 || item.sha256);
  validatePinnedSource('/opt/homebrew/lib/node_modules/openclaw');
  return runtime;
}
function publicCall(params) {
  return { ...(params.identity ? { identity: { ...params.identity } } : {}),
    ...(params.envelope ? { envelope: { ...params.envelope } } : {}),
    selectionEnvelopePresent: Object.hasOwn(params, 'selectionEnvelope') };
}

async function main(options = {}) {
  const productUi = typeof options.runProductUi === 'function';
  if (productUi) assert.ok(options.managedCandidate, 'joint UI requires an actual pinned managed candidate');
  const runtime = productUi ? options.managedCandidate.runtimeRoot : verifyRuntime();
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/sgocsel-svc-'));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, 'service'), cacheRoot: path.join(root, 'cache'), trustedRoot: root });
  const hostRoot = path.join(root, 'host'); const pluginDir = productUi
    ? path.join(hostRoot, 'adapter-resources/openclaw') : path.join(hostRoot, 'adapter'); const workspace = path.join(hostRoot, 'workspace');
  for (const dir of [hostRoot, pluginDir, workspace]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const adapterLog = path.join(root, 'adapter-events.jsonl'); const hostLog = path.join(root, 'gateway.log');
  const productionRoot = path.join(__dirname, '../resources/external-plugin-adapters/openclaw');
  const productionHashes = {};
  for (const [from, to] of [['index.mjs', 'production-adapter.mjs'], ['transport.mjs', 'transport.mjs']]) {
    const content = fs.readFileSync(path.join(productionRoot, from)); productionHashes[from] = sha(content);
    if (!productUi || from === 'transport.mjs') fs.writeFileSync(path.join(pluginDir, to), content, { mode: 0o600 });
  }
  const credential = ensureCredential(paths, 'openclaw');
  const adapterSource = path.join(pluginDir, 'index.mjs');
  // Exact production business logic, private injected credential/IPC transport.
  // The wrapper observes host registration and actual Service responses only.
  fs.writeFileSync(adapterSource, `import fs from 'node:fs';
import { createAdapter } from ${JSON.stringify(productUi ? pathToFileURL(path.join(productionRoot, 'index.mjs')).href : './production-adapter.mjs')};
import client from ${JSON.stringify(pathToFileURL(path.join(__dirname, '../app/agent-service/client.js')).href)};
import auth from ${JSON.stringify(pathToFileURL(path.join(__dirname, '../app/agent-service/external-plugin-adapter-auth.js')).href)};
const paths = ${JSON.stringify(paths)};
const log = value => fs.appendFileSync(${JSON.stringify(adapterLog)}, JSON.stringify(value) + '\\n');
export default { id: ${JSON.stringify(ID)}, name: 'Production adapter isolated Service proof', register(api) {
  const adapter = createAdapter({ credential: () => auth.readCredential(paths, 'openclaw'),
    requestService: async (method, params, options = {}) => {
      log({ phase: 'service-send', method, identity: params.identity, operationId: params.envelope?.operationId,
        selectionEnvelopePresent: Object.hasOwn(params, 'selectionEnvelope') });
      try {
        const value = await client.requestService(paths, { version: ${SERVICE_PROTOCOL_VERSION}, method, params },
          { timeoutMs: options.timeoutMs || 10000, signal: options.signal });
        log({ phase: 'service-ok', method, identity: params.identity,
          state: value.receipt?.state || value.state, itemNames: value.items?.map(item => item.name) });
        return value;
      } catch (error) { log({ phase: 'service-error', method, identity: params.identity, code: error.code || 'UNAVAILABLE' }); throw error; }
    } });
  adapter.register({
    registerCapabilitySelectionGate(handler, metadata) {
      const registration = api.registerCapabilitySelectionGate(handler, metadata);
      log({ phase: 'register', ...registration }); return registration;
    },
    on(name, handler) { api.on(name, (event, ctx) => {
      if (name === 'before_tool_call') log({ phase: 'hook', toolName: event.toolName, runId: ctx.runId,
        sessionId: ctx.sessionId, agentId: ctx.agentId, capabilitySelection: ctx.capabilitySelection,
        selectionAdapterInstanceId: ctx.selectionAdapterInstanceId });
      return handler(event, ctx);
    }); },
    registerTool(factory, options) { api.registerTool(context => {
      const tool = factory(context); const execute = tool.execute;
      return { ...tool, execute(callId, args, signal) { log({ phase: 'tool-execute', name: tool.name, callId,
        agentId: context.agentId, sessionId: context.sessionId }); return execute(callId, args, signal); } };
    }, options); }
  });
} };\n`, { mode: 0o600 });
  fs.copyFileSync(path.join(productionRoot, 'openclaw.plugin.json'), path.join(pluginDir, 'openclaw.plugin.json'));
  if (productUi) fs.copyFileSync(path.join(productionRoot, 'package.json'), path.join(pluginDir, 'package.json'));
  const trustPath = path.join(root, 'selection-trust.json');
  fs.writeFileSync(trustPath, JSON.stringify({ version: 1, adapterId: ID, sourcePath: adapterSource, sourceSha256: sha(fs.readFileSync(adapterSource)) }), { mode: 0o600 });
  let service, federation, registry, gateway, backend, model, proxy, proxyConnection, unauthedClient, restoreWsSend, drainLease, supervisor, lifecycleContext, held = null, heldSearchId = null, heldTool = null, modelError = null;
  let sequence = 0; let prepareCalls = 0; const serviceEvents = []; const modelCalls = []; const leases = []; const cases = [];
  const request = (method, params) => requestService(paths, { version: SERVICE_PROTOCOL_VERSION, method, params }, { timeoutMs: 10000 });
  const native = new ShoggothBackend({ paths }); let installation, business;
  const localMcp = productUi ? require('./fixtures/plugin-openclaw-product-ui-local-mcp.cjs') : null;
  const note = (kind, data = {}) => serviceEvents.push({ sequence: ++sequence, kind, ...data });
  const instrument = (target, method, label) => {
    const original = target[method].bind(target);
    target[method] = async params => {
      note(`${label}:request`, publicCall(params));
      try {
        const result = await original(params);
        if (label === 'open') leases.push({ token: result.token, identity: params.identity });
        note(`${label}:success`, { ...publicCall(params), state: result.receipt?.state || result.state,
          ...(label === 'search' ? { total: result.total, itemNames: result.items.map(item => item.name) } : {}),
          ...(label === 'call' ? { serverId: params.serverId, toolName: params.toolName, argumentIssueId: params.arguments?.issueId,
            result: result.result?.structuredContent, isError: result.result?.isError === true } : {}) });
        return result;
      } catch (error) { note(`${label}:error`, { ...publicCall(params), code: error.code || 'UNAVAILABLE' }); throw error; }
    };
  };
  try {
    service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {}, version: 'real-openclaw-selection-service-fixture' });
    await service.start();
    const prepareDispatch = service.externalPluginSelectionDispatch.prepare.bind(service.externalPluginSelectionDispatch);
    service.externalPluginSelectionDispatch.prepare = params => { prepareCalls += 1; return prepareDispatch(params); };
    instrument(service.externalPluginSelectionDispatch, 'bind', 'bind');
    instrument(service.externalPluginSelectionDispatch, 'finish', 'finish');
    instrument(service.externalPluginToolService, 'open', 'open');
    instrument(service.externalPluginToolService, 'search', 'search');
    if (productUi) instrument(service.externalPluginToolService, 'call', 'call');
    const cancelExecution = service.externalPluginToolService.cancelExecution.bind(service.externalPluginToolService);
    service.externalPluginToolService.cancelExecution = identity => {
      const canceledCount = cancelExecution(identity); note('cancel-execution', { identity: { ...identity }, canceledCount }); return canceledCount;
    };
    const source = path.join(root, 'fixture-plugin'); fs.cpSync(path.join(__dirname, 'fixtures/plugins/project-assistant'), source, { recursive: true });
    if (productUi) localMcp.prepareSource(source);
    const preview = await native.previewPluginInstall({ kind: 'directory', path: source }); assert.equal(preview.installable, true);
    const installed = await native.installPlugin({ source: { kind: 'directory', path: source }, previewDigest: preview.previewDigest,
      expectedRevision: preview.expectedRevision, operationId: 'openclaw-selection-fixture-install' });
    installation = (await native.setPluginInstallationState({ installationId: installed.installation.installationId, desiredState: 'enabled',
      expectedRevision: installed.installation.revision, operationId: 'openclaw-selection-fixture-enable' })).installation;
    if (productUi) business = await localMcp.connectAndGrant({ service, backend: native, installation });
    model = http.createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()); const entry = { sequence: ++sequence, body }; modelCalls.push(entry);
        const lastUserIndex = body.messages.findLastIndex(item => item.role === 'user');
        const lastUser = JSON.stringify(body.messages[lastUserIndex]);
        // Current-turn tool messages, not historical tools from previous turns,
        // determine whether this actual model request should remain held.
        if (lastUser.includes('HOLD_SELECTED') && !body.messages.slice(lastUserIndex + 1).some(item => item.role === 'tool')) {
          assert.ok(body.tools.some(item => item.function?.name === (productUi ? CALL : SEARCH))); assert.equal(held, null);
          heldTool = productUi ? { name: CALL, arguments: { serverId: business.serverId, toolName: business.toolName,
            arguments: { issueId: lastUser.includes('JOINT_LOST_ACK') ? 'fixture-002' : 'fixture-001' } } } : true;
          held = res; heldSearchId = productUi ? `joint_read_${sha(lastUser).slice(0, 16)}` : 'call_selected_search'; return;
        }
        let finalText;
        if (productUi) {
          const toolMessages = body.messages.slice(lastUserIndex + 1).filter(item => item.role === 'tool');
          const expectedIssue = lastUser.includes('JOINT_LOST_ACK') ? 'fixture-002' : 'fixture-001';
          assert.equal(toolMessages.length, 1, 'actual model completion requires exactly one real MCP result in this turn');
          const payload = JSON.stringify(toolMessages);
          assert.ok(payload.includes(business.marker) && payload.includes(expectedIssue), 'actual MCP business result must reach the next model request');
          finalText = `Local MCP read returned ${business.marker} ${expectedIssue}.`;
        }
        stream(res, false, undefined, finalText);
      } catch (error) { modelError = error; if (!res.headersSent) res.writeHead(500); res.end('isolated model fixture failed'); }
    });
    await new Promise((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve); });
    const port = await freePort(); const configPath = path.join(hostRoot, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({
      models: { mode: 'replace', providers: { probe: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only',
        api: 'openai-completions', agentRuntime: { id: 'openclaw' }, models: [{ id: MODEL, name: MODEL, reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] } } },
      agents: { defaults: { model: { primary: `probe/${MODEL}` }, workspace, skipBootstrap: true } },
      tools: { profile: 'minimal', alsoAllow: productUi ? [CALL] : [SEARCH] },
      gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token: GATEWAY_TOKEN }, controlUi: { enabled: true } },
      logging: { level: 'debug', file: path.join(hostRoot, 'diagnostic.log') },
      discovery: { mdns: { mode: 'off' } }, update: { checkOnStart: false },
      plugins: { load: { paths: [pluginDir] }, entries: { [ID]: { enabled: true, hooks: { allowConversationAccess: true } } } }
    }), { mode: 0o600 });
    const env = { HOME: hostRoot, PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: '/private/tmp',
      USER: process.env.USER || 'fixture', LOGNAME: process.env.LOGNAME || 'fixture', OPENCLAW_STATE_DIR: path.join(hostRoot, 'state'),
      OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_SELECTION_TRUST_PATH: trustPath, OPENCLAW_NO_AUTO_UPDATE: '1', OPENCLAW_DISABLE_BONJOUR: '1' };
    let gatewayUrl, gatewayToken = GATEWAY_TOKEN, actualConfigPath = configPath;
    if (productUi) {
      const { createManagedOpenClawHostSupervisor } = require('../app/managed-openclaw-host-supervisor');
      const localConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      supervisor = createManagedOpenClawHostSupervisor({ stateDir: path.join(hostRoot, 'app-state'),
        adapterResourcesRoot: path.dirname(pluginDir), getGatewayConfiguration: () => ({
          models: localConfig.models, agents: localConfig.agents, tools: localConfig.tools,
        }) });
      const abort = new AbortController();
      lifecycleContext = { backendId: 'openclaw', operationId: 'joint-ui-owned-start', candidate: options.managedCandidate,
        nonce: crypto.randomBytes(32).toString('hex'), deadlineAt: Date.now() + 60000, signal: abort.signal,
        assertCurrent() { assert.equal(abort.signal.aborted, false); assert.ok(Date.now() < this.deadlineAt); } };
      const fence = await supervisor.controller.claimExclusiveDataFence(lifecycleContext);
      lifecycleContext.identity = await supervisor.controller.startPaused(lifecycleContext);
      const health = await supervisor.controller.waitHealthy(lifecycleContext);
      assert.equal(health.paused, true); assert.equal(supervisor.getEndpoint(), null);
      assert.equal(modelCalls.length, 0);
      await supervisor.controller.resume(lifecycleContext); await fence.release();
      const endpoint = supervisor.getEndpoint(); assert.ok(endpoint);
      gatewayUrl = endpoint.url; gatewayToken = endpoint.token; actualConfigPath = supervisor.getExecution().configPath;
      cases.push('actual pinned managed Gateway starts paused, proves health with zero model work, then resumes under independent owning writer fence');
    } else {
      gateway = spawn(NODE, [path.join(runtime, 'openclaw.mjs'), 'gateway', 'run', '--port', String(port), '--auth', 'token', '--token', GATEWAY_TOKEN],
        { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let gatewayOutput = ''; gateway.stdout.on('data', chunk => { gatewayOutput += chunk; }); gateway.stderr.on('data', chunk => { gatewayOutput += chunk; });
      gateway.once('exit', () => fs.writeFileSync(hostLog, gatewayOutput, { mode: 0o600 }));
      gatewayUrl = `ws://127.0.0.1:${port}`;
    }
    backend = new OpenClawBackend({ getUpstreamUrl: () => gatewayUrl, getOrigin: () => 'http://127.0.0.1',
      ...(productUi ? { getManagedExecution: () => supervisor.getExecution() } : {}),
      authResolver: createAuthResolver({ getConfig: () => ({ gatewayUrl, token: gatewayToken }),
        credentialsDir: path.join(hostRoot, 'backend-credentials'), operatorIdentityDir: path.join(hostRoot, 'unused-operator'), localGatewayConfigPath: actualConfigPath }) });
    registry = new BackendRegistry(); registry.register(backend);
    if (productUi) registry.register(native);
    await registry.start(productUi ? 'openclaw' : undefined);
    let agentLookupError = null;
    try { await until(async () => { if (gateway && gateway.exitCode !== null) throw new Error('isolated Gateway exited');
      try { return (await backend.getAgent('main')).id === 'main'; }
      catch (error) { agentLookupError = { code: error.code || null, message: String(error.message).slice(0, 240) }; return false; }
    }, 'Gateway real Agent', 30000); }
    catch (error) { error.message += `; last actual Agent lookup=${JSON.stringify(agentLookupError)}`; throw error; }
    federation = createFederationHostServer({ paths, registry }); await federation.start();
    const client = new FederationHostClient({ paths });
    const actualAgent = (await client.request('agent.get', { backendId: 'openclaw', agentId: 'main' })).agent;
    assert.equal(actualAgent.backendId, 'openclaw'); assert.equal(actualAgent.id, 'main');
    cases.push('Service default federation verifier resolves actual isolated OpenClaw Agent');
    if (productUi) {
      backend.attachExternalPluginSelectionService(native);
      const admissionGate = createWorkAdmissionGate();
      proxy = await startProxyGateway({ port: 0, origin: 'http://127.0.0.1', getUpstreamUrl: () => gatewayUrl,
        registry, workAdmissionGate: admissionGate });
      const result = await options.runProductUi({ root, hostRoot, paths, service, native, backend, registry,
        installation, business, modelCalls, serviceEvents, productionHashes, supervisor, gatewayUrl, gatewayToken,
        configPath: actualConfigPath, proxy, admissionGate, request,
        getPrepareCalls: () => prepareCalls, getHeld: () => held, getModelError: () => modelError,
        releaseHeldTool() { assert.ok(held, 'actual selected model request must be held'); stream(held, heldTool, heldSearchId); held = null; heldSearchId = null; heldTool = null; },
        discardHeld() { held?.destroy(); held = null; heldSearchId = null; heldTool = null; },
        readAdapterEvents: () => fs.existsSync(adapterLog) ? fs.readFileSync(adapterLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
      });
      fs.writeFileSync(path.join(root, 'service-events-public.json'), JSON.stringify(serviceEvents, null, 2), { mode: 0o600 });
      return { ...result, preparationChecks: cases, fixtureRoot: root };
    }

    const prepare = async operationId => {
      const sessionKey = `agent:main:${operationId}`;
      const capabilities = await backend.request('chat.selection.capabilities', { sessionKey, agentId: actualAgent.id });
      assert.equal(capabilities.subject.agentId, actualAgent.id); assert.equal(capabilities.subject.sessionKey, sessionKey); assert.ok(capabilities.subject.sessionId);
      const adapter = capabilities.adapters.find(row => row.adapterId === ID); assert.ok(adapter);
      const subject = { backendId: 'openclaw', instanceId: adapter.instanceId, agentId: actualAgent.id, sessionId: capabilities.subject.sessionId };
      const prepared = await native.prepareExternalPluginSelection({ subject, operationId, requiredAdapterId: adapter.adapterId,
        adapterGeneration: adapter.adapterGeneration, pluginSelection: [{ installationId: installation.installationId, revision: installation.revision }] });
      assert.equal(prepared.receipt.state, 'prepared'); assert.deepEqual(prepared.receipt.subject, subject);
      return { subject, prepared, sessionKey, operationId };
    };
    const queryHost = op => backend.request('chat.selection.get', { operationId: op.operationId, sessionKey: op.sessionKey });
    const queryService = op => native.getExternalPluginSelection({ subject: op.subject, operationId: op.operationId });
    const send = (op, message = `HOLD_SELECTED ${op.operationId}`) => backend.request('chat.send', { sessionKey: op.sessionKey, sessionId: op.subject.sessionId,
      message, idempotencyKey: op.operationId, capabilitySelection: op.prepared.envelope });
    const waitHeld = async op => {
      let receipt; await until(async () => { if (modelError) throw modelError; receipt = await queryService(op); return receipt.state === 'bound' && held !== null; }, 'bound Service and first model'); return receipt;
    };
    const waitHost = async (op, status) => { let receipt; await until(async () => { if (modelError) throw modelError; receipt = await queryHost(op); if (receipt?.status === 'blocked' && status !== 'blocked') throw new Error(`unexpected Host blocked ${op.operationId}`); return receipt?.status === status; }, `Host ${op.operationId} ${status}`); return receipt; };
    const selectedOpen = (op, receipt, toolCallId) => request('plugin.external.open', { credentialToken: credential,
      identity: { ...receipt.identity, toolCallId }, selectionEnvelope: op.prepared.envelope });
    const assertNoFallback = async (op, receipt) => {
      for (const instanceId of [receipt.identity.instanceId, 'incorrect-scoped-adapter-instance']) {
        await assert.rejects(request('plugin.external.open', { credentialToken: credential,
          identity: { ...receipt.identity, instanceId, toolCallId: 'no-selected-downgrade' } }), { code: 'EXTERNAL_PLUGIN_SELECTION_INVALID' });
      }
    };
    const success = await prepare('real-selected-search');
    const beforeSuccess = modelCalls.length; const ack = await send(success);
    assert.equal(ack.capabilitySelection.actualRunId, null);
    const bound = await waitHeld(success);
    assert.equal(bound.identity.instanceId, success.subject.instanceId); assert.equal(bound.identity.sessionId, success.subject.sessionId);
    assert.equal(bound.identity.runId, 'real-selected-search');
    const extraIdentity = { ...bound.identity, toolCallId: 'terminal-unconsumed-lease' };
    const extraLease = await selectedOpen(success, bound, extraIdentity.toolCallId);
    stream(held, true); held = null;
    const hostCompleted = await waitHost(success, 'completed'); const serviceCompleted = await queryService(success);
    assert.equal(serviceCompleted.state, 'completed'); assert.deepEqual(serviceCompleted.identity, bound.identity);
    assert.equal(hostCompleted.actualRunId, bound.identity.runId); assert.equal(modelCalls.length, beforeSuccess + 2);
    const exactSearch = serviceEvents.filter(event => event.kind === 'search:success' && event.identity.runId === bound.identity.runId);
    assert.equal(exactSearch.length, 1); assert.ok(exactSearch[0].itemNames.includes('issue-summary'));
    const bindEvent = serviceEvents.find(event => event.kind === 'bind:success' && event.identity.runId === bound.identity.runId);
    assert.ok(bindEvent.sequence < modelCalls[beforeSuccess].sequence, 'Service binding must precede actual first model request');
    const selectedToolOpen = serviceEvents.find(event => event.kind === 'open:success' && event.identity.toolCallId === 'call_selected_search' && event.identity.runId === bound.identity.runId);
    assert.equal(selectedToolOpen.selectionEnvelopePresent, true); assert.equal(selectedToolOpen.identity.instanceId, bound.identity.instanceId);
    await assert.rejects(request('plugin.external.search', { token: extraLease.token, identity: extraIdentity, query: '', cursor: 0, limit: 5 }), { code: 'EXTERNAL_PLUGIN_LEASE_INVALID' });
    assert.ok(serviceEvents.some(event => event.kind === 'cancel-execution' && event.identity.runId === bound.identity.runId && event.canceledCount === 1), 'terminal must physically remove the unconsumed selected lease');
    await assertNoFallback(success, bound);
    cases.push('App authenticated prepare, physical Host subject/generation, production gate bind, actual model/search lease/model and terminal release');
    const noTool = await prepare('selected-no-tool-service'); const noToolBefore = modelCalls.length;
    const searchesBeforeNoTool = serviceEvents.filter(event => event.kind === 'search:success').length;
    await send(noTool, 'Complete this task without any tool call.');
    const noToolHost = await waitHost(noTool, 'completed'); const noToolService = await queryService(noTool);
    assert.equal(noToolService.state, 'completed'); assert.equal(noToolService.identity.runId, noToolHost.actualRunId);
    assert.equal(modelCalls.length, noToolBefore + 1); assert.equal(serviceEvents.filter(event => event.kind === 'search:success').length, searchesBeforeNoTool);
    const noToolBind = serviceEvents.find(event => event.kind === 'bind:success' && event.identity.runId === noToolHost.actualRunId);
    assert.ok(noToolBind.sequence < modelCalls[noToolBefore].sequence); assert.ok(JSON.stringify(modelCalls[noToolBefore].body).includes('project-assistant'));
    cases.push('selected no-tool turn still binds actual Service before model and confirms exact terminal receipt');
    const preCanceled = await prepare('cancel-before-host-gate'); const cancelBefore = modelCalls.length;
    assert.equal((await native.cancelExternalPluginSelection({ subject: preCanceled.subject, operationId: preCanceled.operationId })).state, 'canceled');
    await send(preCanceled); await waitHost(preCanceled, 'blocked'); assert.equal(modelCalls.length, cancelBefore);
    cases.push('prepared operation canceled before Host gate yields zero model requests');
    const preRevoked = await prepare('revoke-before-host-gate'); const revokeBefore = modelCalls.length;
    installation = (await native.setPluginInstallationState({ installationId: installation.installationId, desiredState: 'disabled',
      expectedRevision: installation.revision, operationId: 'pre-gate-disable' })).installation;
    await send(preRevoked); await waitHost(preRevoked, 'blocked'); assert.equal(modelCalls.length, revokeBefore);
    cases.push('installation revoked before Host gate yields zero model requests');
    installation = (await native.setPluginInstallationState({ installationId: installation.installationId, desiredState: 'enabled',
      expectedRevision: installation.revision, operationId: 'reenable-after-pre-gate' })).installation;
    for (const action of ['cancel', 'revoke']) {
      const operation = await prepare(`${action}-after-bind`); const before = modelCalls.length; const searchBefore = serviceEvents.filter(event => event.kind === 'search:success').length;
      await send(operation); const receipt = await waitHeld(operation);
      const outstandingIdentity = { ...receipt.identity, toolCallId: `${action}-unconsumed-lease` };
      const outstanding = await selectedOpen(operation, receipt, outstandingIdentity.toolCallId);
      if (action === 'cancel') assert.equal((await native.cancelExternalPluginSelection({ subject: operation.subject, operationId: operation.operationId })).state, 'canceled');
      else installation = (await native.setPluginInstallationState({ installationId: installation.installationId, desiredState: 'disabled',
        expectedRevision: installation.revision, operationId: 'mid-run-disable' })).installation;
      await assert.rejects(request('plugin.external.search', { token: outstanding.token, identity: outstandingIdentity, query: '', cursor: 0, limit: 5 }));
      await assertNoFallback(operation, receipt);
      stream(held, true); held = null;
      const observed = await waitHost(operation, 'completed');
      assert.equal(observed.actualRunId, receipt.identity.runId); assert.equal(modelCalls.length, before + 2);
      assert.equal(serviceEvents.filter(event => event.kind === 'search:success').length, searchBefore);
      const denied = serviceEvents.find(event => event.kind === 'open:error' && event.identity.runId === receipt.identity.runId && event.identity.toolCallId === 'call_selected_search');
      assert.ok(denied); assert.equal(denied.selectionEnvelopePresent, true);
      assert.equal(serviceEvents.some(event => event.kind === 'open:success' && event.identity.runId === receipt.identity.runId && !event.selectionEnvelopePresent), false);
      assert.equal((await queryService(operation)).state, action === 'cancel' ? 'canceled' : 'completed');
      cases.push(`${action} after bind revokes outstanding lease and denies actual selected tool without ordinary-lease fallback`);
      if (action === 'revoke') installation = (await native.setPluginInstallationState({ installationId: installation.installationId, desiredState: 'enabled',
        expectedRevision: installation.revision, operationId: 'reenable-after-mid-run' })).installation;
    }
    const ordinaryBefore = modelCalls.length;
    await backend.request('chat.send', { sessionKey: 'agent:main:ordinary-control', message: 'Ordinary no selection control.', idempotencyKey: 'ordinary-control' });
    await until(async () => {
      if (modelError) throw modelError;
      if (modelCalls.length !== ordinaryBefore + 1) return false;
      const history = await backend.request('chat.history', { sessionKey: 'agent:main:ordinary-control', limit: 10 });
      return history.messages?.some(message => message.role === 'assistant' && JSON.stringify(message).includes('The isolated selected task finished.'));
    }, 'ordinary persisted assistant completion');
    assert.equal(serviceEvents.some(event => event.kind === 'bind:request' && event.identity.runId === 'ordinary-control'), false);
    cases.push('ordinary unselected Host chat stays usable independently');
    // Product route: only renderer-level pluginSelection leaves this client.
    // The production Proxy/Backend helpers own capabilities+prepare+Host wire.
    backend.attachExternalPluginSelectionService(native);
    assert.equal(registry.route('main'), null, 'genuine OpenClaw backend deliberately uses upstream passthrough ownership');
    const forwardedSelectedSends=[]; const originalWsSend=WebSocket.prototype.send;
    WebSocket.prototype.send=function(data,...args) {
      if (this.url===new URL(gatewayUrl).href) {
        let frame; try { frame=JSON.parse(data.toString()); } catch {}
        if (frame?.type==='req' && frame.method==='chat.send' && frame.params?.capabilitySelection) forwardedSelectedSends.push(frame.params.capabilitySelection.operationId);
      }
      return originalWsSend.call(this,data,...args);
    };
    restoreWsSend=()=>{WebSocket.prototype.send=originalWsSend;};
    const admissionGate=createWorkAdmissionGate();
    proxy = await startProxyGateway({ port: 0, origin: 'http://127.0.0.1', getUpstreamUrl: () => gatewayUrl, registry, workAdmissionGate:admissionGate });
    proxyConnection = await productClient(proxy.url);
    const productParams = { sessionKey: 'agent:main:product-proxy-selection', message: 'HOLD_SELECTED PRODUCT_PROXY_SEARCH', idempotencyKey: 'product-proxy-selected',
      pluginSelection: [{ installationId: installation.installationId, revision: installation.revision }] };
    const productBefore = modelCalls.length; const productFrameBefore = proxyConnection.frames.length;
    const productAck = await proxyConnection.request('chat.send', productParams);
    assert.equal(productAck.runId, productParams.idempotencyKey); assert.equal(productAck.status, 'started');
    assert.equal(productAck.capabilitySelection.status, 'accepted');
    await until(() => held !== null && serviceEvents.some(event => event.kind === 'bind:success' && event.identity.runId === productParams.idempotencyKey), 'product gate bound before model');
    const productBinding = serviceEvents.find(event => event.kind === 'bind:success' && event.identity.runId === productParams.idempotencyKey);
    const productOperation = { subject: { backendId:'openclaw',instanceId:productBinding.identity.instanceId,agentId:productBinding.identity.agentId,sessionId:productBinding.identity.sessionId },
      sessionKey: productParams.sessionKey,operationId:productParams.idempotencyKey,prepared:{envelope:productBinding.envelope} };
    assert.equal(productAck.capabilitySelection.sessionId, productOperation.subject.sessionId);
    await until(() => proxyConnection.frames.slice(productFrameBefore).some(frame => frame.type === 'event' && frame.event === 'chat' && frame.payload?.state === 'accepted' && frame.payload?.runId === productParams.idempotencyKey), 'verified product accepted event');
    const productFrames = proxyConnection.frames.slice(productFrameBefore);
    const ackIndex = productFrames.findIndex(frame => frame.type === 'res' && frame.ok && frame.payload?.runId === productParams.idempotencyKey);
    const acceptedIndex = productFrames.findIndex(frame => frame.type === 'event' && frame.event === 'chat' && frame.payload?.state === 'accepted' && frame.payload?.runId === productParams.idempotencyKey);
    assert.ok(ackIndex >= 0 && acceptedIndex > ackIndex, 'accepted event must follow the verified actual Host acknowledgment');
    stream(held, true); held = null;
    await until(async () => (await proxyConnection.request('chat.selection.get',{operationId:productOperation.operationId,sessionKey:productOperation.sessionKey})).status === 'completed', 'product selected host completion');
    assert.equal((await queryService(productOperation)).state,'completed'); assert.equal(modelCalls.length,productBefore+2);
    assert.ok(serviceEvents.some(event => event.kind === 'search:success' && event.identity.runId === productParams.idempotencyKey));
    cases.push('authenticated real Proxy/BackendRegistry pluginSelection route prepares Service, confirms Host ACK, emits accepted and runs model/search/model');
    const replayBefore=modelCalls.length; const replay = await proxyConnection.request('chat.send', productParams);
    assert.equal(replay.replayed,true); assert.equal(replay.capabilitySelection.actualRunId,productParams.idempotencyKey);
    await assert.rejects(proxyConnection.request('chat.send',{...productParams,message:'Changed selected product message.'}));
    await assert.rejects(proxyConnection.request('chat.send',{...productParams,pluginSelection:[{installationId:installation.installationId,revision:installation.revision+1}]}));
    assert.equal(modelCalls.length,replayBefore);
    cases.push('real product route replays identical selection/message without model and rejects changed message or selection');
    unauthedClient=await productClient(proxy.url,false);
    await assert.rejects(unauthedClient.request('chat.send',productParams),{code:'UNAUTHORIZED'}); unauthedClient.close(); unauthedClient=null;
    await assert.rejects(proxyConnection.request('chat.send',{...productParams,capabilitySelection:productBinding.envelope}),{code:'PLUGIN_SELECTION_UNAVAILABLE'});
    assert.equal(modelCalls.length,replayBefore);
    cases.push('real Proxy blocks unauthenticated selection and caller-forged Host envelope');
    const stopParams={sessionKey:'agent:main:product-stop-selection',message:'HOLD_SELECTED PRODUCT_PROXY_STOP',idempotencyKey:'product-proxy-stop',
      pluginSelection:[{installationId:installation.installationId,revision:installation.revision}]};
    const stopBefore=modelCalls.length; await proxyConnection.request('chat.send',stopParams);
    await until(() => held!==null && serviceEvents.some(event=>event.kind==='bind:success'&&event.identity.runId===stopParams.idempotencyKey),'product Stop actual model start');
    const stopBinding=serviceEvents.find(event=>event.kind==='bind:success'&&event.identity.runId===stopParams.idempotencyKey);
    const stopOperation={subject:{backendId:'openclaw',instanceId:stopBinding.identity.instanceId,agentId:stopBinding.identity.agentId,sessionId:stopBinding.identity.sessionId},
      sessionKey:stopParams.sessionKey,operationId:stopParams.idempotencyKey,prepared:{envelope:stopBinding.envelope}};
    const stopIdentity={...stopBinding.identity,toolCallId:'product-stop-unconsumed-lease'};
    const stopLease=await selectedOpen(stopOperation,stopBinding,stopIdentity.toolCallId);
    await proxyConnection.request('chat.abort',{sessionKey:stopParams.sessionKey,runId:stopBinding.identity.runId});
    held.destroy(); held=null;
    let productStopReceipt;
    await until(async()=>{productStopReceipt=await proxyConnection.request('chat.selection.get',{operationId:stopOperation.operationId,sessionKey:stopOperation.sessionKey});return productStopReceipt.status === 'aborted';},'product Stop host terminal');
    assert.equal((await queryService(stopOperation)).state,'canceled'); assert.equal(productStopReceipt.actualRunId,stopBinding.identity.runId);
    assert.equal(modelCalls.length,stopBefore+1);
    await until(()=>proxyConnection.frames.some(frame=>frame.type==='event'&&frame.event==='chat'&&frame.payload?.runId===stopBinding.identity.runId&&frame.payload?.state==='aborted'),'actual product Stop aborted event');
    await assert.rejects(request('plugin.external.search',{token:stopLease.token,identity:stopIdentity,query:'',cursor:0,limit:5}),{code:'EXTERNAL_PLUGIN_LEASE_INVALID'});
    await assertNoFallback(stopOperation,stopBinding);
    cases.push('real product Proxy Stop cancels exact Service subject, aborts actual Host Run and revokes remaining selected lease');
    const queryModelBefore=modelCalls.length; const queryPrepareBefore=prepareCalls;
    const originalDevice=proxyConnection.identity; proxyConnection.close();
    proxyConnection=await productClient(proxy.url,true,originalDevice);
    const completedObservation=await proxyConnection.request('chat.operation.get',{sessionKey:productParams.sessionKey,idempotencyKey:productParams.idempotencyKey});
    assert.deepEqual(completedObservation,{status:'found',operationId:productParams.idempotencyKey,sessionKey:productParams.sessionKey,backendId:'openclaw',admissionAccepted:true,run:{status:'completed',runId:productBinding.identity.runId}});
    const stoppedObservation=await proxyConnection.request('chat.operation.get',{sessionKey:stopParams.sessionKey,idempotencyKey:stopParams.idempotencyKey});
    assert.deepEqual(stoppedObservation,{status:'found',operationId:stopParams.idempotencyKey,sessionKey:stopParams.sessionKey,backendId:'openclaw',admissionAccepted:true,run:{status:'canceled',runId:stopBinding.identity.runId}});
    const absentObservation=await proxyConnection.request('chat.operation.get',{sessionKey:productParams.sessionKey,idempotencyKey:'product-unknown-operation'});
    assert.deepEqual(absentObservation,{status:'not_found',operationId:'product-unknown-operation',sessionKey:productParams.sessionKey,backendId:'openclaw'});
    assert.equal(modelCalls.length,queryModelBefore); assert.equal(prepareCalls,queryPrepareBefore);
    cases.push('same-device real Proxy reconnect observes completed/canceled/not_found chat.operation.get without new prepare or model');
    assert.ok(forwardedSelectedSends.includes(productParams.idempotencyKey),'observer must see actual selected upstream send');
    const drainModelBefore=modelCalls.length; const drainSendBefore=forwardedSelectedSends.length; const drainFrameBefore=proxyConnection.frames.length;
    drainLease=admissionGate.beginDrain('openclaw','isolated-selection-drain-fixture');
    const drainParams={sessionKey:'agent:main:product-drain-selection',message:'HOLD_SELECTED MUST_NOT_SEND_DURING_DRAIN',idempotencyKey:'product-proxy-known-unsent-drain',
      pluginSelection:[{installationId:installation.installationId,revision:installation.revision}]};
    await assert.rejects(proxyConnection.request('chat.send',drainParams),{code:'GATEWAY_DRAINING'});
    const drainPrepareAfter=prepareCalls;
    const drainObservation=await proxyConnection.request('chat.operation.get',{sessionKey:drainParams.sessionKey,idempotencyKey:drainParams.idempotencyKey});
    assert.deepEqual(drainObservation,{status:'not_found',operationId:drainParams.idempotencyKey,sessionKey:drainParams.sessionKey,backendId:'openclaw'});
    assert.equal(prepareCalls,drainPrepareAfter); assert.equal(modelCalls.length,drainModelBefore); assert.equal(forwardedSelectedSends.length,drainSendBefore);
    const drainResponses=proxyConnection.frames.slice(drainFrameBefore).filter(frame=>frame.type==='res' && frame.error?.code==='GATEWAY_DRAINING');
    assert.equal(drainResponses.length,1);
    assert.equal(serviceEvents.some(event=>event.kind==='bind:request'&&event.identity.runId===drainParams.idempotencyKey),false);
    drainLease.release(); drainLease=null;
    cases.push('real WorkAdmissionGate drain rejects selected send once, with zero actual upstream chat.send/model/bind and original operation not_found');
    const adapterEvents = fs.readFileSync(adapterLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const actualHook = adapterEvents.find(event => event.phase === 'hook' && event.runId === bound.identity.runId);
    assert.equal(actualHook.selectionAdapterInstanceId, bound.identity.instanceId); assert.deepEqual(actualHook.capabilitySelection, success.prepared.envelope);
    const scopes = adapterEvents.filter(event => event.phase === 'register').map(event => event.instanceId);
    assert.ok(scopes.some(instanceId => instanceId !== bound.identity.instanceId), 'real Host must have exercised separate scoped adapter instances');
    for (const entry of modelCalls) {
      const serialized = JSON.stringify(entry.body); assert.equal(serialized.includes(credential), false);
      assert.equal(serialized.includes('capabilitySelection'), false); assert.equal(serialized.includes('selectionAdapterInstanceId'), false);
      for (const event of serviceEvents.filter(event => event.envelope)) for (const field of ['dispatchRef', 'selectionDigest', 'adapterGeneration']) assert.equal(serialized.includes(event.envelope[field]), false);
    }
    assert.ok(JSON.stringify(modelCalls[beforeSuccess].body).includes('project-assistant'));
    assert.ok(JSON.stringify(modelCalls[beforeSuccess + 1].body).includes('issue-summary'));
    cases.push('scoped production facade uses canonical Host identity and credentials/envelope/proof never enter model requests');
    validatePinnedSource('/opt/homebrew/lib/node_modules/openclaw');
    for (const [file, digest] of Object.entries(productionHashes)) assert.equal(sha(fs.readFileSync(path.join(productionRoot, file))), digest, 'production adapter changed during acceptance; rerun against one version');
    const evidence = { version: 1, status: 'passed', recordedAt: new Date().toISOString(), hostVersion: '2026.9.5', runtime,
      productionAdapterSourceHashes: productionHashes, fixtureRoot: root, model: 'local deterministic HTTP fixture',
      modelRequests: modelCalls.length, actualSelectedToolRunId: bound.identity.runId, canonicalAdapterInstanceId: bound.identity.instanceId,
      exactPhysicalSessionId: bound.identity.sessionId, serviceAgentVerifier: 'real BackendRegistry/OpenClawBackend/FederationHostServer; default Service verifier',
      searchSuccesses: serviceEvents.filter(event => event.kind === 'search:success').length,
      selectedToolOpenSuccesses: serviceEvents.filter(event => event.kind === 'open:success' && event.identity.toolCallId === 'call_selected_search').length,
      executionLeaseReleases: serviceEvents.filter(event => event.kind === 'cancel-execution').map(({identity,canceledCount}) => ({runId:identity.runId,canceledCount})),
      productKnownUnsentDrain:{responses:drainResponses.length,additionalUpstreamChatSends:0,additionalModelRequests:0,hostOperationStatus:drainObservation.status,observationWindow:'immediate authoritative lookup barrier; does not wait for a 60-second timer'},
      productOperationLookup:{sameDeviceReconnect:true,completed:completedObservation,stopped:stoppedObservation,absent:absentObservation,additionalModelRequests:0,additionalServicePrepareCalls:0},
      productProxyInitialAckStatus:productAck.status,productProxySelectedRunId:productBinding.identity.runId,productProxyStopRunId:stopBinding.identity.runId,productProxyStopHostStatus:productStopReceipt.status,productProxyAcceptedAfterHostAck:true,
      cases, globalRuntimeUnchanged: true, remoteModelOrAccountCalls: 0,
      scope: 'real authenticated product Proxy/BackendRegistry plus source-mode Host/production-adapter/Service IPC; renderer UX and production deployment remain separate' };
    fs.writeFileSync(path.join(root, 'selection-service-real-host-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'service-events-public.json'), JSON.stringify(serviceEvents, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(root, 'service-events-public.json'), JSON.stringify(serviceEvents, null, 2), { mode: 0o600 });
    error.message += `; isolated fixture=${root}; modelRequests=${modelCalls.length}`; throw error;
  } finally {
    held?.destroy(); unauthedClient?.close(); proxyConnection?.close();
    if (proxy) await proxy.close();
    drainLease?.release(); restoreWsSend?.();
    if (federation) await federation.stop();
    if (registry) await registry.stop();
    if (gateway && gateway.exitCode === null) {
      const child = gateway; try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
      if (child.exitCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    if (supervisor) {
      try { await supervisor.stopOwned({ operationId: 'joint-ui-owned-cleanup', timeoutMs: 15000 }); }
      catch (error) {
        await supervisor.controller.abortAndWait({ ...lifecycleContext, deadlineAt: Date.now() + 15000 });
        assert.equal(supervisor.getStatus().ownership, 'absent', 'joint UI cleanup must confirm owned writer exit');
      }
      assert.equal(supervisor.getStatus().ownership, 'absent');
      fs.rmSync(path.join(hostRoot, 'app-state/external-plugin-host-data'), { recursive: true, force: true });
    }
    if (service) await service.stop();
    if (model) await new Promise(resolve => model.close(resolve));
    // Only isolated auth material is removed; compact public proof is retained.
    try { fs.rmSync(path.join(root, 'service'), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(root, 'cache'), { recursive: true, force: true }); } catch {}
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
