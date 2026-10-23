'use strict';

// The normal real Hermes Desktop Gateway, production adapter/private transport,
// real isolated Service and local MCP echo. No external account or model IO.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { BackendRegistry } = require('../app/core/backend-registry');
const { startProxyGateway } = require('../app/core/proxy-gateway');
const { HermesGatewaySocket } = require('../app/core/hermes-gateway-rpc');
const { HermesBackend } = require('../app/core/hermes-backend');
const { ShoggothBackend } = require('../app/core/shoggoth-backend');
const { requestService } = require('../app/agent-service/client');
const { SERVICE_PROTOCOL_VERSION } = require('../app/agent-service/service-protocol-version');
const { createFixture } = require('./plugin-real-host-service-fixture.cjs');
const { materialize, verify, MANIFEST, DEFAULT_SOURCE } = require('./hermes-selection-host-patch.cjs');
const SOURCE = process.env.SHOGGOTH_TEST_HERMES_SOURCE || DEFAULT_SOURCE;
const PYTHON = process.env.SHOGGOTH_TEST_HERMES_PYTHON || path.join(SOURCE, 'venv/bin/python');
const OWNER = 'shoggoth_shared_capabilities';
const MODEL = 'sgh-selection-service-offline';
const root = fs.mkdtempSync('/private/tmp/sgh-selection-service-');
const reusedHost = process.env.SHOGGOTH_TEST_HERMES_PATCHED_SOURCE;
const HOST = reusedHost ? path.resolve(reusedHost) : path.join(root, 'host');
const home = path.join(root, 'home');
const tracePath = path.join(root, 'adapter-trace.jsonl');
const token = 'sgh-local-hermes-selection-session';
const requests = [];
const events = [];
const physicalOwners = new Map();
let host, socket, hermes, business, held, proxy, product, unauthorized, modelError, verifierCalls = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, label, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (modelError) throw modelError;
    if (await predicate()) return;
    if (host?.exitCode != null) throw new Error('Hermes exited before ' + label);
    await sleep(75);
  }
  throw new Error(label + ' timeout');
}
const fixture = createFixture(root, 'hermes', {
  externalPluginAgentVerifier: async identity => {
    verifierCalls += 1;
    const owner = physicalOwners.get(identity.sessionId);
    if (!owner || owner.agentId !== identity.agentId || owner.instanceId !== identity.instanceId) return null;
    const agent = await hermes.getAgent(identity.agentId);
    assert.equal(agent.backendId, 'hermes');
    assert.equal(agent.profile, 'default');
    return agent;
  },
});
function modelReply(response, body, tool) {
  if (response.destroyed || response.writableEnded) return;
  const message = tool ? { role: 'assistant', content: '', tool_calls: [{ id: 'actual_selection_tool_' + tool.name,
    type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
    : { role: 'assistant', content: latestText(body).includes('SGH product ordinary held queue')
      ? 'ORDINARY_PREVIOUS_TURN' : latestText(body).includes('SGH product queued selected')
        ? 'SELECTED_QUEUED_TURN' : 'Local selected turn complete' };
  const finish = tool ? 'tool_calls' : 'stop';
  response.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
  if (!body.stream) return response.end(JSON.stringify({ id: 'sgh-local', object: 'chat.completion', created: 1,
    model: MODEL, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 } }));
  const deltas = tool ? [{ role: 'assistant', tool_calls: [{ index: 0, id: message.tool_calls[0].id,
    type: 'function', function: { name: tool.name, arguments: '' } }] },
  { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.args) } }] }] : [message];
  for (const delta of deltas) response.write('data: ' + JSON.stringify({ id: 'sgh-local', object: 'chat.completion.chunk', created: 1,
    model: MODEL, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  response.write('data: ' + JSON.stringify({ id: 'sgh-local', object: 'chat.completion.chunk', created: 1,
    model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\n');
  response.end('data: [DONE]\n\n');
}
const server = http.createServer((req, res) => { void (async () => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 4_000_000) { res.destroy(); return; } }
  const body = JSON.parse(raw);
  requests.push(body);
  const prior = body.messages?.filter(row => row.role === 'tool') || [];
  const text = JSON.stringify(body.messages);
  if ((latestText(body).includes('SGH selected held cancellation') || latestText(body).includes('SGH product ordinary held queue') || latestText(body).includes('SGH attachment submit ACK held') || latestText(body).includes('SGH attachment ordinary held')) && prior.length === 0) { held = () => { modelReply(res, body, null); held = null; }; return; }
  let tool;
  if (text.includes('SGH selected MCP roundtrip')) {
    if (prior.length === 0) tool = { name: 'tool_describe', args: { names: ['shoggoth_plugin_call'] } };
    else if (prior.length === 1) tool = { name: 'tool_call', args: { calls: [{ name: 'shoggoth_plugin_call',
      arguments: { serverId: business.serverId, toolName: business.toolName, arguments: { value: 'selected-local-echo' } } }] } };
    else assert(prior.some(row => row.content?.includes('selected-local-echo')), 'actual model did not receive echo tool result');
  }
  modelReply(res, body, tool);
})().catch(error => { modelError = error; res.writeHead(500); res.end('local fixture model rejected'); }); });
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function trace() { return fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function latestText(body) {
  return JSON.stringify(body.messages?.filter(row => row.role === 'user').at(-1)?.content || '');
}
async function productClient(url, authenticate = true) {
  const connection = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1' } });
  const frames = [], pending = new Map(); let sequence = 0, connectSent = false;
  let readyResolve, readyReject; const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = 'hermes-product-' + (++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    connection.send(JSON.stringify({ type: 'req', id, method, params }));
  });
  const fail = error => { readyReject(error); for (const item of pending.values()) item.reject(error); pending.clear(); };
  connection.on('error', fail); connection.on('close', () => fail(new Error('product socket closed')));
  connection.on('open', () => { if (!authenticate) readyResolve(); });
  connection.on('message', bytes => {
    const frame = JSON.parse(bytes.toString()); frames.push(frame);
    if (frame.type === 'event' && frame.event === 'connect.challenge' && authenticate && !connectSent) {
      connectSent = true; void request('connect').then(readyResolve, readyReject); return;
    }
    if (frame.type !== 'res') return;
    const entry = pending.get(frame.id); if (!entry) return; pending.delete(frame.id);
    if (frame.ok) entry.resolve(frame.payload);
    else entry.reject(Object.assign(new Error(frame.error?.message || 'product RPC rejected'), { code: frame.error?.code }));
  });
  await ready; return { frames, request, close: () => connection.close() };
}
function verifyReusedHost() {
  assert(HOST.startsWith('/private/tmp/sgh-p5-hermes-'), 'only the owned retained temporary host can be reused');
  assert.equal(fs.realpathSync(HOST), HOST, 'retained Host must use its owned canonical path');
  assert(!fs.lstatSync(HOST).isSymbolicLink(), 'retained Host directory cannot be a symlink');
  verify(SOURCE);
  for (const item of MANIFEST.files) {
    const file = path.join(HOST, item.path); assert(!fs.lstatSync(file).isSymbolicLink());
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), item.patchedSha256, 'retained Host drift: ' + item.path);
  }
}
async function newSession() {
  const session = await socket.request('session.create', { model: MODEL, provider: 'custom', cwd: path.join(root, 'workspace') });
  assert.equal(typeof session.session_id, 'string');
  const caps = await socket.request('prompt.selection.capabilities', { session_id: session.session_id });
  assert.equal(caps.version, 1); assert.equal(caps.adapters.length, 1);
  const registered = caps.adapters[0]; assert.equal(registered.required_adapter_id, OWNER);
  const agent = await hermes.getAgent(registered.agent_id);
  assert.equal(agent.id, registered.agent_id);
  assert.equal(requests.length, 0, 'capability warming unexpectedly sent a model');
  const subject = { backendId: 'hermes', instanceId: registered.instance_id,
    agentId: registered.agent_id, sessionId: caps.runtime_session_id };
  physicalOwners.set(caps.runtime_session_id, subject);
  return { sessionId: session.session_id, registered, subject };
}
function wire(envelope) {
  assert.deepEqual(Object.keys(envelope).sort(), ['version', 'operationId', 'dispatchRef', 'selectionDigest', 'requiredAdapterId', 'adapterGeneration'].sort());
  return { version: envelope.version, operation_id: envelope.operationId, dispatch_ref: envelope.dispatchRef,
    selection_digest: envelope.selectionDigest, required_adapter_id: envelope.requiredAdapterId, adapter_generation: envelope.adapterGeneration };
}
const EVIDENCE_FILES = [
  "app/core/hermes-backend.js", "app/core/hermes-plugin-selection.js", "app/core/hermes-selection-input.js",
  "app/core/hermes-gateway-rpc.js", "app/core/plugin-external-selection-dto.js", "app/core/proxy-gateway.js",
  "app/agent-service/server.js", "app/agent-service/external-plugin-selection-dispatch.js",
  "app/agent-service/plugin-service-controller.js", "app/agent-service/plugin-catalog-restorer.js",
  "app/agent-service/plugin-mcp-consent.js", "app/agent-service/plugin-store.js", "app/agent-service/plugin-tool-catalog-registry.js",
  "resources/external-plugin-adapters/hermes/__init__.py",
  "resources/external-plugin-host-patches/hermes/v1-c7c2df1/manifest.json",
  "scripts/plugin-hermes-selection-service-real-host-fixture.cjs", "scripts/hermes-selection-host-patch.cjs",
  "scripts/fixtures/hermes-selection-dispatch-unit.py", "scripts/fixtures/hermes-selection-input-unit.py",
  "scripts/plugin-hermes-selection-attachments-boundary-unit.cjs", "scripts/plugin-hermes-selection-readiness-unit.cjs",
];
const evidenceHash = relative => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", relative))).digest("hex");
async function main() {
  const codeHashes = Object.fromEntries(EVIDENCE_FILES.map(relative => [relative, evidenceHash(relative)]));
  assert.equal(process.argv.length, 2, 'This fixture has no live/remote mode');
  try {
    if (reusedHost) verifyReusedHost(); else await materialize({ source: SOURCE, output: HOST });
    await fixture.start();
    business = await fixture.installMcpTool();
    const backend = new ShoggothBackend({ paths: fixture.paths });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const plugin = path.join(home, 'plugins', OWNER); fs.mkdirSync(plugin, { recursive: true });
    fs.mkdirSync(path.join(root, 'workspace'));
    const source = path.join(__dirname, '../resources/external-plugin-adapters/hermes');
    fs.copyFileSync(path.join(source, 'plugin.yaml'), path.join(plugin, 'plugin.yaml'));
    fs.writeFileSync(path.join(plugin, '__init__.py'), `import importlib.util\nimport json\nimport pathlib\nimport sys\nsource=pathlib.Path(${JSON.stringify(path.join(source, '__init__.py'))})\nspec=importlib.util.spec_from_file_location('_selection_production_adapter',source,submodule_search_locations=[str(source.parent)])\nmodule=importlib.util.module_from_spec(spec)\nsys.modules[spec.name]=module\nspec.loader.exec_module(module)\nmodule.request_service.__globals__['_root']=lambda:pathlib.Path(${JSON.stringify(fixture.paths.userDataRoot)})\nlog_path=pathlib.Path(${JSON.stringify(tracePath)})\ndef log(value):\n    with log_path.open('a') as out:out.write(json.dumps(value)+'\\n')\ndef request(method,params,**kwargs):\n    log({'phase':'request','method':method,'identity':params.get('identity'),'envelope':params.get('envelope',params.get('selectionEnvelope'))})\n    try:\n        result=module.request_service(method,params,**kwargs)\n    except Exception as exc:\n        log({'phase':'error','method':method,'code':getattr(exc,'code','ADAPTER_FAILED')})\n        raise\n    if method=='plugin.external.selection.bind':log({'phase':'bound','envelope':result['envelope'],'receipt':result['receipt'],'selectedPlugins':result['selectedPlugins']})\n    elif method=='plugin.external.selection.finish':log({'phase':'finished','receipt':result})\n    return result\ndef register(ctx):\n    bridge=module.Adapter(ctx.profile_name,request=request)\n    bridge.register(ctx)\n`);
    fs.writeFileSync(path.join(home, 'config.yaml'), `model:\n  default: ${MODEL}\n  provider: custom\n  base_url: http://127.0.0.1:${server.address().port}/v1\n  api_key: fixture-only\n  api_mode: chat_completions\n  context_length: 128000\n  supports_vision: true\nauxiliary:\n  title_generation:\n    enabled: false\n    model_upgrade_enabled: false\nplugins:\n  enabled: [${OWNER}]\n  entries:\n    ${OWNER}:\n      allow_selection_dispatch_gate: true\ndashboard:\n  input_mode: interrupt\n  process_isolation:\n    enabled: false\n`);
    const port = await freePort();
    host = spawn(PYTHON, ['-m', 'hermes_cli.main', 'serve', '--isolated', '--port', String(port), '--no-open'], {
      cwd: HOST, env: { HOME: root, HERMES_HOME: home, PATH: process.env.PATH || '/usr/bin:/bin', PYTHONPATH: HOST,
        PYTHONDONTWRITEBYTECODE: '1', LANG: 'en_US.UTF-8', HERMES_DASHBOARD_SESSION_TOKEN: token }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Drain child output; no config, credentials or provider/tool body is printed.
    host.stdout.resume(); host.stderr.resume();
    const dash = { baseUrl: 'http://127.0.0.1:' + port, token, proc: null, spawned: false };
    await wait(async () => {
      const candidate = new HermesGatewaySocket(dash, { label: 'selection-Service-real-Host', onEvent(event) { events.push(event); } });
      try { await candidate.ensureConnected(); socket = candidate; return true; } catch { candidate.close(); return false; }
    }, 'Gateway ready');
    hermes = new HermesBackend({ getConfig: () => ({ hermesMode: 'local', hermesRemotes: [] }) });
    hermes.dashboards.set('default', dash);
    await hermes._refreshAgentsFor(dash);
    assert.equal((await hermes.getAgent('hermes-default')).backendId, 'hermes');
    const sessions = [];
    for (let i = 0; i < 4; i++) sessions.push(await newSession());
    const prepare = (s, operationId) => backend.prepareExternalPluginSelection({ subject: s.subject, operationId,
      requiredAdapterId: s.registered.required_adapter_id, adapterGeneration: s.registered.adapter_generation,
      pluginSelection: [{ installationId: business.installationId, revision: business.installationRevision }] });
    const hostReceipt = async (s, e, expected) => {
      let receipt; await wait(async () => { receipt = (await socket.request('prompt.selection.get', {
        session_id: s.sessionId, operation_id: e.operation_id })).selection_dispatch; return expected.includes(receipt.state); }, 'host receipt ' + expected);
      return receipt;
    };
    const serviceReceipt = (s, e) => backend.getExternalPluginSelection({ subject: s.subject, operationId: e.operation_id });
    const noTool = await prepare(sessions[0], 'production-no-tool');
    const noToolWire = wire(noTool.envelope);
    const accepted = await socket.request('prompt.submit', { session_id: sessions[0].sessionId,
      text: 'SGH selected production no tool', selection_dispatch: noToolWire });
    assert.equal(accepted.status, 'streaming');
    const completed = await hostReceipt(sessions[0], noToolWire, ['complete']);
    assert.equal(requests.length, 1); assert.equal((await serviceReceipt(sessions[0], noToolWire)).state, 'completed');
    const bound = trace().find(row => row.phase === 'bound' && row.envelope.operationId === noToolWire.operation_id);
    assert(bound); assert.equal(bound.selectedPlugins[0].installationId, business.installationId);
    assert.equal(bound.selectedPlugins[0].revision, business.installationRevision);
    assert.equal(bound.selectedPlugins[0].packageName, 'project-assistant');
    for (const body of requests) {
      const modelText = JSON.stringify(body); assert(modelText.includes('project-assistant'));
      assert(modelText.includes(bound.selectedPlugins[0].installationId));
      for (const key of ['operationId', 'dispatchRef', 'selectionDigest', 'adapterGeneration']) assert(!modelText.includes(noTool.envelope[key]), 'raw selection ref entered model');
    }
    assert.deepEqual(bound.receipt.identity, { ...sessions[0].subject, taskId: completed.actual_task_id, turnId: completed.actual_turn_id });
    const roundtrip = await prepare(sessions[1], 'production-tool-roundtrip');
    const roundtripWire = wire(roundtrip.envelope); const beforeTool = requests.length;
    await socket.request('prompt.submit', { session_id: sessions[1].sessionId, text: 'SGH selected MCP roundtrip', selection_dispatch: roundtripWire });
    const toolDone = await hostReceipt(sessions[1], roundtripWire, ['complete']);
    assert.equal(requests.length, beforeTool + 3);
    assert(requests.at(-1).messages.some(row => row.role === 'tool' && row.content?.includes('selected-local-echo')));
    assert.equal((await serviceReceipt(sessions[1], roundtripWire)).state, 'completed');
    await wait(() => events.some(event => event.type === 'message.complete'
      && event.selection_dispatch?.operation_id === roundtripWire.operation_id), 'selected exact terminal sideband');
    const responseEvents = events.filter(event => event.session_id === sessions[1].sessionId
      && ['selection.dispatch.bound','message.delta','message.complete','tool.start','tool.complete'].includes(event.type));
    assert(responseEvents.some(event => event.type === 'selection.dispatch.bound'));
    assert(responseEvents.some(event => event.type === 'tool.start'));
    assert(responseEvents.some(event => event.type === 'tool.complete'));
    for (const event of responseEvents) {
      const proof = event.selection_dispatch; assert(proof, 'selected actual tool/response event lacks core sideband');
      for (const key of Object.keys(roundtripWire)) assert.equal(proof[key], roundtripWire[key]);
      assert.equal(proof.dispatch_id, toolDone.dispatch_id);
      assert.equal(proof.runtime_session_id, toolDone.actual_session_id);
      assert.equal(proof.actual_session_id, toolDone.actual_session_id);
      assert.equal(proof.actual_task_id, toolDone.actual_task_id);
      assert.equal(proof.actual_turn_id, toolDone.actual_turn_id);
    }
    for (const body of requests.slice(beforeTool)) {
      const text = JSON.stringify(body);
      assert(text.includes('project-assistant'));
      for (const key of ['operationId','dispatchRef','selectionDigest','adapterGeneration']) assert(!text.includes(roundtrip.envelope[key]));
    }

    const toolIdentity = { ...sessions[1].subject, taskId: toolDone.actual_task_id, turnId: toolDone.actual_turn_id };
    const toolOpen = trace().filter(row => row.phase === 'request' && row.method === 'plugin.external.open'
      && row.identity.sessionId === toolIdentity.sessionId);
    assert.equal(toolOpen.length, 1); assert.deepEqual(toolOpen[0].envelope, roundtrip.envelope);
    for (const key of Object.keys(toolIdentity)) assert.equal(toolOpen[0].identity[key], toolIdentity[key]);
    const audits = (await fixture.listAuditedCalls('hermes')).items;
    const audit = audits.find(row => row.sessionId === toolIdentity.sessionId && row.taskId === toolIdentity.taskId
      && row.turnId === toolIdentity.turnId && row.toolCallId === toolOpen[0].identity.toolCallId);
    assert(audit); assert.equal(audit.instanceId, toolIdentity.instanceId); assert.equal(audit.agentId, toolIdentity.agentId);
    assert.equal(audit.installationId, business.installationId); assert.equal(audit.bindingId, business.bindingId);
    assert.equal(audit.toolIdentity, business.toolIdentity); assert.equal(audit.status, 'confirmed');
    const adapterRequest = (method, params) => requestService(fixture.paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params }, { timeoutMs: 5000 });
    await assert.rejects(adapterRequest('plugin.external.open', { credentialToken: fixture.credential,
      identity: { ...toolIdentity, toolCallId: 'post-completion' }, selectionEnvelope: roundtrip.envelope }), { code: 'EXTERNAL_PLUGIN_SELECTION_INVALID' });
    const canceled = await prepare(sessions[2], 'production-canceled-before-model');
    const canceledWire = wire(canceled.envelope);
    await backend.cancelExternalPluginSelection({ subject: sessions[2].subject, operationId: canceledWire.operation_id });
    const cancelCount = requests.length;
    await socket.request('prompt.submit', { session_id: sessions[2].sessionId, text: 'SGH canceled selection', selection_dispatch: canceledWire });
    await hostReceipt(sessions[2], canceledWire, ['failed', 'unknown']);
    assert.equal(requests.length, cancelCount); assert.equal((await serviceReceipt(sessions[2], canceledWire)).state, 'canceled');
    const heldSelection = await prepare(sessions[3], 'production-selected-stop');
    const heldWire = wire(heldSelection.envelope);
    await socket.request('prompt.submit', { session_id: sessions[3].sessionId, text: 'SGH selected held cancellation', selection_dispatch: heldWire });
    await wait(() => held != null, 'selected held model');
    const heldState = await serviceReceipt(sessions[3], heldWire); assert.equal(heldState.state, 'bound');
    const leaseIdentity = { ...heldState.identity, toolCallId: 'held-selection-tool' };
    await assert.rejects(adapterRequest('plugin.external.open', { credentialToken: fixture.credential, identity: leaseIdentity }), { code: 'EXTERNAL_PLUGIN_SELECTION_INVALID' });
    const lease = await adapterRequest('plugin.external.open', { credentialToken: fixture.credential,
      identity: leaseIdentity, selectionEnvelope: heldSelection.envelope });
    await backend.cancelExternalPluginSelection({ subject: sessions[3].subject, operationId: heldWire.operation_id });
    await assert.rejects(adapterRequest('plugin.external.search', { token: lease.token, identity: leaseIdentity,
      query: '', cursor: 0, limit: 5 }), { code: 'EXTERNAL_PLUGIN_LEASE_INVALID' });
    const stopCount = requests.length;
    await socket.request('session.interrupt', { session_id: sessions[3].sessionId });
    const stopped = await hostReceipt(sessions[3], heldWire, ['stopped']);
    assert.equal(stopped.actual_task_id, heldState.identity.taskId);
    assert.equal(stopped.actual_turn_id, heldState.identity.turnId);
    held?.(); assert.equal(requests.length, stopCount);
    const old = (await serviceReceipt(sessions[3], heldWire)); assert.equal(old.state, 'canceled');
    const replay = await socket.request('prompt.submit', { session_id: sessions[3].sessionId,
      text: 'SGH selected held cancellation', selection_dispatch: heldWire });
    assert.equal(replay.replayed, true); await sleep(100); assert.equal(requests.length, stopCount);
    const ordinaryBefore = requests.length;
    await socket.request('prompt.submit', { session_id: sessions[0].sessionId, text: 'SGH ordinary chat after completion' });
    await wait(() => requests.length === ordinaryBefore + 1, 'ordinary chat');
    assert.equal(trace().filter(row => row.phase === 'bound').length, 3);
    assert.equal(trace().filter(row => row.phase === 'finished').length, 3);
    assert(verifierCalls >= 5);
    // Full product route: renderer only names installed plugin identities.
    // Production Backend/Proxy own capability lookup, Service prepare, dispatch,
    // event association, idempotence, operation query and Stop ordering.
    hermes.attachExternalPluginSelectionService(backend);
    const attachProxy = async () => {
      const registry = new BackendRegistry(); registry.register(hermes);
      proxy = await startProxyGateway({ port: 0, origin: 'http://127.0.0.1', getUpstreamUrl: () => '', registry });
      product = await productClient(proxy.url);
    };
    await attachProxy();
    const selectedRows = [{ installationId: business.installationId, revision: business.installationRevision }];
    const productSession = async () => {
      const sessionKey = await hermes.createSession('hermes-default', { model: MODEL, provider: 'custom', workspace: path.join(root, 'workspace') });
      const { m, sock } = await hermes._gwEnsureRuntime(sessionKey, { eagerBuild: true });
      const caps = await sock.request('prompt.selection.capabilities', { session_id: m.runtimeId });
      assert.equal(caps.adapters.length, 1); const registered = caps.adapters[0];
      assert.equal(registered.agent_id, 'hermes-default');
      const subject = { backendId: 'hermes', instanceId: registered.instance_id, agentId: registered.agent_id, sessionId: caps.runtime_session_id };
      physicalOwners.set(caps.runtime_session_id, subject);
      return { sessionKey, sessionId: m.runtimeId, subject, sock };
    };
    const chatFrames = (key, offset = 0) => product.frames.slice(offset).filter(frame => frame.type === 'event'
      && frame.event === 'chat' && frame.payload?.runId === key);
    const final = async key => { await wait(() => chatFrames(key).some(frame => ['final','error','aborted'].includes(frame.payload?.state)), 'product final ' + key); return chatFrames(key).at(-1); };
    const productReceipt = async (session, key, states) => {
      let observed; await wait(async () => { observed = await product.request('chat.operation.get', {
        sessionKey: session.sessionKey, idempotencyKey: key }); return observed.status === 'found' && states.includes(observed.run?.status); }, 'product operation ' + key);
      return observed;
    };
    const routeSession = await productSession();
    const route = { sessionKey: routeSession.sessionKey, message: 'SGH selected MCP roundtrip PRODUCT_ROUTE',
      idempotencyKey: 'hermes-product-selected', pluginSelection: selectedRows };
    const routeBefore = requests.length, routeFrameBefore = product.frames.length;
    assert.equal((await product.request('chat.send', route)).status, 'started');
    const routeFinal = await final(route.idempotencyKey); assert.equal(routeFinal.payload.state, 'final');
    const routeReceipt = await productReceipt(routeSession, route.idempotencyKey, ['completed']);
    assert.equal(requests.length, routeBefore + 3);
    const routeBound = trace().find(row => row.phase === 'bound' && row.envelope.operationId === route.idempotencyKey);
    assert(routeBound); assert.deepEqual(routeBound.receipt.subject, routeSession.subject);
    assert.equal(routeBound.receipt.identity.turnId, routeReceipt.run.runId);
    assert(chatFrames(route.idempotencyKey, routeFrameBefore).some(frame => frame.payload.state === 'accepted'));
    assert(chatFrames(route.idempotencyKey, routeFrameBefore).some(frame => frame.payload.state === 'delta'));
    assert(requests.at(-1).messages.some(row => row.role === 'tool' && row.content?.includes('selected-local-echo')));
    const routeAudit = (await fixture.listAuditedCalls('hermes')).items.find(row => row.sessionId === routeSession.subject.sessionId
      && row.turnId === routeBound.receipt.identity.turnId && row.toolIdentity === business.toolIdentity);
    assert(routeAudit); assert.equal(routeAudit.status, 'confirmed');
    const replayBefore = requests.length, replayBindBefore = trace().filter(row => row.phase === 'bound').length;
    const replayFrames = product.frames.length; await product.request('chat.send', route);
    // Proxy deliberately delivers one terminal per real run/client. A retry
    // observes the original durable receipt rather than demanding a duplicate
    // final frame. The actual Backend replay hook must still contain that final.
    await wait(() => chatFrames(route.idempotencyKey, replayFrames).some(frame => frame.payload.state === 'accepted'), 'same-key original accepted observation');
    assert.deepEqual(await product.request('chat.operation.get', { sessionKey: routeSession.sessionKey,
      idempotencyKey: route.idempotencyKey }), routeReceipt);
    let replayTerminal;
    await hermes.sendMessage(route.sessionKey, route.message, route.idempotencyKey,
      { final: (...args) => { replayTerminal = args; } }, { pluginSelection: selectedRows });
    await wait(() => replayTerminal != null, 'Backend exact cached terminal');
    assert.equal(replayTerminal[1], false);
    assert.equal(chatFrames(route.idempotencyKey, replayFrames).some(frame => frame.payload.state === 'error'), false);
    assert.equal(requests.length, replayBefore); assert.equal(trace().filter(row => row.phase === 'bound').length, replayBindBefore);
    for (const changed of [{ ...route, message: 'changed selected product message' },
      { ...route, pluginSelection: [{ ...selectedRows[0], revision: selectedRows[0].revision + 1 }] }]) {
      const offset = product.frames.length;
      await product.request('chat.send', changed);
      await wait(() => chatFrames(route.idempotencyKey, offset).some(frame => frame.payload.state === 'error'), 'same-key conflict');
      assert.equal(requests.length, replayBefore); assert.equal(trace().filter(row => row.phase === 'bound').length, replayBindBefore);
    }
    unauthorized = await productClient(proxy.url, false);
    await assert.rejects(unauthorized.request('chat.send', route), { code: 'UNAUTHORIZED' }); unauthorized.close(); unauthorized = null;
    await assert.rejects(product.request('chat.send', { ...route, selection_dispatch: wire(routeBound.envelope) }), { code: 'PLUGIN_SELECTION_UNAVAILABLE' });
    assert.equal(requests.length, replayBefore);
    const stopSession = await productSession();
    const stopRoute = { sessionKey: stopSession.sessionKey, message: 'SGH selected held cancellation PRODUCT_STOP',
      idempotencyKey: 'hermes-product-stop', pluginSelection: selectedRows };
    const stopBefore = requests.length; await product.request('chat.send', stopRoute);
    await wait(() => held != null && trace().some(row => row.phase === 'bound' && row.envelope.operationId === stopRoute.idempotencyKey), 'product Stop model held');
    const stopBound = trace().find(row => row.phase === 'bound' && row.envelope.operationId === stopRoute.idempotencyKey);
    const stopIdentity = { ...stopBound.receipt.identity, toolCallId: 'product-remaining-selected-lease' };
    const remainingLease = await adapterRequest('plugin.external.open', { credentialToken: fixture.credential,
      identity: stopIdentity, selectionEnvelope: stopBound.envelope });
    await product.request('chat.abort', { sessionKey: stopSession.sessionKey });
    const stopReceipt = await productReceipt(stopSession, stopRoute.idempotencyKey, ['canceled']);
    assert.equal(stopReceipt.run.runId, stopBound.receipt.identity.turnId);
    assert.equal((await backend.getExternalPluginSelection({ subject: stopSession.subject, operationId: stopRoute.idempotencyKey })).state, 'canceled');
    await assert.rejects(adapterRequest('plugin.external.search', { token: remainingLease.token, identity: stopIdentity,
      query: '', cursor: 0, limit: 5 }), { code: 'EXTERNAL_PLUGIN_LEASE_INVALID' });
    await assert.rejects(adapterRequest('plugin.external.open', { credentialToken: fixture.credential,
      identity: { ...stopIdentity, toolCallId: 'post-stop-no-envelope' } }), { code: 'EXTERNAL_PLUGIN_SELECTION_INVALID' });
    held?.(); await final(stopRoute.idempotencyKey); assert.equal(requests.length, stopBefore + 1);
    const queuedSession = await productSession();
    // A genuine other client starts the prior ordinary Host turn. The product
    // observer then owns the queued selected operation, never its predecessor.
    await socket.request('prompt.submit', { session_id: queuedSession.sessionId, text: 'SGH product ordinary held queue' });
    await wait(() => held != null, 'prior ordinary Host model held');
    const queueRoute = { sessionKey: queuedSession.sessionKey, message: 'SGH product queued selected',
      idempotencyKey: 'hermes-product-queued', pluginSelection: selectedRows };
    const queueBefore = requests.length; await product.request('chat.send', queueRoute);
    await wait(() => chatFrames(queueRoute.idempotencyKey).some(frame => frame.payload.state === 'accepted'), 'queued product accepted');
    const waiting = await product.request('chat.operation.get', { sessionKey: queuedSession.sessionKey, idempotencyKey: queueRoute.idempotencyKey });
    assert.equal(waiting.status, 'found'); assert.equal(waiting.run.status, 'queued'); assert.equal(waiting.run.runId, null);
    assert.equal(chatFrames(queueRoute.idempotencyKey).some(frame => ['delta','final'].includes(frame.payload.state)), false);
    held?.(); const queueFinal = await final(queueRoute.idempotencyKey); assert.equal(queueFinal.payload.state, 'final');
    const queueReceipt = await productReceipt(queuedSession, queueRoute.idempotencyKey, ['completed']);
    assert(queueReceipt.run.runId); assert.equal(requests.length, queueBefore + 1);
    const queueText = JSON.stringify(chatFrames(queueRoute.idempotencyKey));
    assert(queueText.includes('SELECTED_QUEUED_TURN')); assert(!queueText.includes('ORDINARY_PREVIOUS_TURN'));
    const queryBefore = requests.length, queryBindBefore = trace().filter(row => row.phase === 'bound').length;
    product.close(); product = null; await proxy.close(); proxy = null; await hermes.stop();
    hermes = new HermesBackend({ getConfig: () => ({ hermesMode: 'local', hermesRemotes: [] }), externalPluginSelectionService: backend });
    hermes.dashboards.set('default', dash); await hermes._refreshAgentsFor(dash); await attachProxy();
    const recovered = await product.request('chat.operation.get', { sessionKey: routeSession.sessionKey, idempotencyKey: route.idempotencyKey });
    assert.deepEqual(recovered, routeReceipt);
    const recoveredStop = await product.request('chat.operation.get', { sessionKey: stopSession.sessionKey, idempotencyKey: stopRoute.idempotencyKey });
    assert.deepEqual(recoveredStop, stopReceipt);
    const missing = await product.request('chat.operation.get', { sessionKey: routeSession.sessionKey, idempotencyKey: 'hermes-product-not-found' });
    assert.equal(missing.status, 'not_found');
    assert.equal(requests.length, queryBefore); assert.equal(trace().filter(row => row.phase === 'bound').length, queryBindBefore);
    // Observe the immutable original receipts and unchanged current Grant.
    // The production restorer re-discovers the real local MCP without login,
    // a new Grant, old pool injection or direct authority mutations.
    const profilesBeforeRestart = await backend._page('profile.list', { backendId: 'shoggoth', enabledOnly: true },
      'profiles', { maxBytes: 512000, maxItems: 256 });
    const profileBeforeRestart = profilesBeforeRestart.find(row => row.enabled); assert(profileBeforeRestart);
    const beforeRestartCatalog = await backend._call('plugins.mcp.tools.list', { profileId: profileBeforeRestart.id,
      bindingId: business.bindingId });
    const beforeRestartEcho = beforeRestartCatalog.items.find(row => row.name === business.toolName); assert(beforeRestartEcho);
    assert.equal(beforeRestartEcho.savedGrant?.matchesCurrentContract, true);
    await fixture.restart();
    assert.equal((await serviceReceipt(sessions[1], roundtripWire)).state, 'completed');
    assert.equal((await serviceReceipt(sessions[3], heldWire)).state, 'canceled');
    assert.equal((await backend.getExternalPluginSelection({ subject: routeSession.subject,
      operationId: route.idempotencyKey })).state, 'completed');
    assert.equal((await backend.getExternalPluginSelection({ subject: stopSession.subject,
      operationId: stopRoute.idempotencyKey })).state, 'canceled');
    // The formal tools.list read waits for that exact installed plugin's
    // startup/on-demand recovery. It must return the current fresh contract,
    // never a cached old directory; no manual discover is required.
    const profiles = await backend._page('profile.list', { backendId: 'shoggoth', enabledOnly: true },
      'profiles', { maxBytes: 512000, maxItems: 256 });
    const profile = profiles.find(row => row.enabled); assert(profile);
    const restoredCatalog = await backend._call('plugins.mcp.tools.list', { profileId: profile.id,
      bindingId: business.bindingId });
    assert.equal(restoredCatalog.available, true);
    const restoredEcho = restoredCatalog.items.find(row => row.name === business.toolName); assert(restoredEcho);
    assert.deepEqual(restoredEcho.savedGrant, beforeRestartEcho.savedGrant, 'restart must preserve the original exact Grant');
    assert.equal(restoredEcho.toolIdentity, business.toolIdentity);
    assert.equal(restoredEcho.savedGrant?.effect, 'allow'); assert.equal(restoredEcho.savedGrant?.matchesCurrentContract, true);
    const restartSession = await productSession();
    const restartRoute = { sessionKey: restartSession.sessionKey, message: 'SGH selected MCP roundtrip PRODUCT_AFTER_SERVICE_RESTART',
      idempotencyKey: 'hermes-product-service-restart', pluginSelection: selectedRows };
    const restartBefore = requests.length;
    await product.request('chat.send', restartRoute);
    assert.equal((await final(restartRoute.idempotencyKey)).payload.state, 'final');
    const restartReceipt = await productReceipt(restartSession, restartRoute.idempotencyKey, ['completed']);
    assert.equal(requests.length, restartBefore + 3);
    assert(requests.at(-1).messages.some(row => row.role === 'tool' && row.content?.includes('selected-local-echo')));
    const restartBound = trace().find(row => row.phase === 'bound' && row.envelope.operationId === restartRoute.idempotencyKey);
    assert(restartBound); assert.deepEqual(restartBound.receipt.subject, restartSession.subject);
    assert.equal(restartBound.receipt.identity.turnId, restartReceipt.run.runId);
    const restartedAudit = (await fixture.listAuditedCalls('hermes')).items.find(row => row.sessionId === restartSession.subject.sessionId
      && row.turnId === restartReceipt.run.runId && row.toolIdentity === business.toolIdentity);
    assert(restartedAudit); assert.equal(restartedAudit.bindingId, business.bindingId); assert.equal(restartedAudit.status, 'confirmed');
    for (const [selection, start, end] of [[routeBound, routeBefore, routeBefore + 3],
      [restartBound, restartBefore, restartBefore + 3]]) for (const body of requests.slice(start, end)) {
      const modelText = JSON.stringify(body);
      assert(modelText.includes(selection.selectedPlugins[0].installationId));
      for (const field of ['operationId','dispatchRef','selectionDigest','adapterGeneration']) assert(!modelText.includes(selection.envelope[field]));
    }
    // Attachment operations use their own immutable private snapshot. The
    // Gateway RPC trace records method/operation only, never bytes or prompt.
    const rpcCalls = [], rpcFailures = [];
    const originalRequest = HermesGatewaySocket.prototype.request;
    let lostAck = null;
    HermesGatewaySocket.prototype.request = async function(method, params = {}, options) {
      rpcCalls.push({ method, operationId: params.operation_id || params.selection_dispatch?.operation_id || null });
      let result;
      try { result = await originalRequest.call(this, method, params, options); }
      catch (error) { rpcFailures.push({ method, code: error.contractCode || error.code || "HOST_RPC_FAILED" }); throw error; }
      if (lostAck && method === lostAck.method && (params.operation_id || params.selection_dispatch?.operation_id) === lostAck.operationId) {
        lostAck = null; throw new Error('fixture dropped a served acknowledgement');
      }
      return result;
    };
    const count = method => rpcCalls.filter(row => row.method === method).length;
    const attachmentCountBefore = requests.length;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlV8AAAAASUVORK5CYII=', 'base64');
    const pngData = png.toString('base64');
    const image = (name, suffix = '') => ({ type: 'image', fileName: name, mimeType: 'image/png', content: Buffer.concat([png, Buffer.from(suffix)]).toString('base64') });
    const pdfBody = () => {
      const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 80] /Resources << >> /Contents 4 0 R >>',
        '<< /Length 30 >>\nstream\n0 0 1 rg 0 0 60 60 re f\nendstream'];
      let body = '%PDF-1.4\n', offsets = [0];
      for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index+1} 0 obj\n${object}\nendobj\n`; }
      const xref = Buffer.byteLength(body);
      body += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')
        + `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return Buffer.from(body);
    };
    const mixedAttachments = [image('selected.png'), { type:'pdf',fileName:'selected.pdf',mimeType:'application/pdf',content:pdfBody().toString('base64') },
      { type:'file',fileName:'selected.txt',mimeType:'text/plain',content:Buffer.from('SCOPED_FILE_MARKER').toString('base64') }];
    const latestUser = body => body.messages.filter(row=>row.role==='user').at(-1)?.content;
    const imageUrls = body => (Array.isArray(latestUser(body)) ? latestUser(body) : []).filter(part=>part.type==='image_url').map(part=>part.image_url?.url);
    const rebuildProduct = async () => {
      product.close(); product=null;await proxy.close();proxy=null;await hermes.stop();
      hermes=new HermesBackend({getConfig:()=>({hermesMode:'local',hermesRemotes:[]}),externalPluginSelectionService:backend});
      hermes.dashboards.set('default',dash);await hermes._refreshAgentsFor(dash);await attachProxy();
    };
    try {
      const attachmentSession = await productSession();
      assert.equal(await hermes.getPluginSelectionReadiness({agentId:'hermes-default',sessionKey:attachmentSession.sessionKey}),true);
      assert.equal(await hermes.getPluginSelectionReadiness({agentId:'hermes-neighbor',sessionKey:attachmentSession.sessionKey}),false);
      const attachmentRoute = {sessionKey:attachmentSession.sessionKey,message:'SGH selected MCP roundtrip operation scoped image PDF file',
        idempotencyKey:'hermes-attachment-mixed',pluginSelection:selectedRows,attachments:mixedAttachments};
      const mixedBefore=requests.length;
      await product.request('chat.send',attachmentRoute);const mixedFinal=await final(attachmentRoute.idempotencyKey);
      assert.equal(mixedFinal.payload.state,'final','mixed attachment path: '+JSON.stringify({rpcFailures,adapterFailures:trace().filter(row=>row.phase==='error').map(row=>row.code)}));
      const mixedReceipt=await productReceipt(attachmentSession,attachmentRoute.idempotencyKey,['completed']);
      assert.equal(requests.length,mixedBefore+3);for(const body of requests.slice(mixedBefore,mixedBefore+3)){
        assert.equal(imageUrls(body).length,2);assert(JSON.stringify(body).includes(business.installationId));
      }
      assert.equal(imageUrls(requests.at(-1)).length,2,'image and every PDF page must reach actual model');
      assert(imageUrls(requests.at(-1)).includes('data:image/png;base64,'+pngData));
      assert(JSON.stringify(latestUser(requests.at(-1))).includes('SCOPED_FILE_MARKER'),'file text must reach actual model');
      assert(JSON.stringify(requests.at(-1)).includes(business.installationId),'trusted selected context missing');
      const inputReceipt=await attachmentSession.sock.request('prompt.selection.input.get',{session_id:attachmentSession.sessionId,
        operation_id:attachmentRoute.idempotencyKey,owner_session_id:attachmentSession.subject.sessionId});
      assert(!JSON.stringify(requests.at(-1)).includes(inputReceipt.selection_input.input_digest),'opaque input digest entered model');
      assert.equal(inputReceipt.selection_input.attachments.length,3);assert.equal(inputReceipt.selection_input.owner_session_id,attachmentSession.subject.sessionId);
      const scopedBefore={stage:count('prompt.selection.input.stage'),submit:count('prompt.submit'),models:requests.length};
      await product.request('chat.send',attachmentRoute);await sleep(75);
      assert.equal(count('prompt.selection.input.stage'),scopedBefore.stage);assert.equal(count('prompt.submit'),scopedBefore.submit);assert.equal(requests.length,scopedBefore.models);
      await rebuildProduct();
      assert.deepEqual(await product.request('chat.operation.get',{sessionKey:attachmentSession.sessionKey,idempotencyKey:attachmentRoute.idempotencyKey}),mixedReceipt);
      await assert.rejects(hermes.sendMessage(attachmentRoute.sessionKey,attachmentRoute.message,attachmentRoute.idempotencyKey,{},
        {pluginSelection:selectedRows,attachments:mixedAttachments}),{code:'PLUGIN_SELECTION_NEEDS_VERIFICATION'});
      assert.equal(count('prompt.selection.input.stage'),scopedBefore.stage);assert.equal(count('prompt.submit'),scopedBefore.submit);assert.equal(requests.length,scopedBefore.models);
      for (const changed of [{message:'changed original payload',attachments:mixedAttachments},
        {message:attachmentRoute.message,attachments:mixedAttachments.slice(0,2)}]) {
        // A reconstructed Backend has no in-memory fingerprint cache.
        await rebuildProduct();
        await assert.rejects(hermes.sendMessage(attachmentRoute.sessionKey,changed.message,attachmentRoute.idempotencyKey,{},
          {pluginSelection:selectedRows,attachments:changed.attachments}),{code:'PLUGIN_SELECTION_ATTACHMENTS_CONFLICT'});
        assert.equal(count('prompt.selection.input.stage'),scopedBefore.stage);assert.equal(count('prompt.submit'),scopedBefore.submit);assert.equal(requests.length,scopedBefore.models);
      }
      await rebuildProduct();
      await assert.rejects(hermes.sendMessage(attachmentRoute.sessionKey,attachmentRoute.message,attachmentRoute.idempotencyKey,{},
        {pluginSelection:[{...selectedRows[0],revision:selectedRows[0].revision+1}],attachments:mixedAttachments}),{code:'EXTERNAL_PLUGIN_SELECTION_CONFLICT'});
      assert.equal(count('prompt.selection.input.stage'),scopedBefore.stage);assert.equal(count('prompt.submit'),scopedBefore.submit);assert.equal(requests.length,scopedBefore.models);
      const stagedSession=await productSession();
      const stagedRoute={sessionKey:stagedSession.sessionKey,message:'SGH observed staged ACK before submit',idempotencyKey:'hermes-attachment-stage-ack',
        pluginSelection:selectedRows,attachments:[image('stage-ack.png')]};
      const stagedBefore={stage:count('prompt.selection.input.stage'),submit:count('prompt.submit'),models:requests.length};
      lostAck={method:'prompt.selection.input.stage',operationId:stagedRoute.idempotencyKey};
      await assert.rejects(hermes.sendMessage(stagedRoute.sessionKey,stagedRoute.message,stagedRoute.idempotencyKey,{},
        {pluginSelection:selectedRows,attachments:stagedRoute.attachments}),{code:'PLUGIN_SELECTION_NEEDS_VERIFICATION'});
      assert.equal(count('prompt.selection.input.stage'),stagedBefore.stage+1);assert.equal(count('prompt.submit'),stagedBefore.submit);assert.equal(requests.length,stagedBefore.models);
      assert.equal(await backend.getExternalPluginSelection({subject:stagedSession.subject,operationId:stagedRoute.idempotencyKey}),null,'failed upload must not mint a Service ref');
      await rebuildProduct();await product.request('chat.send',stagedRoute);assert.equal((await final(stagedRoute.idempotencyKey)).payload.state,'final');
      await productReceipt(stagedSession,stagedRoute.idempotencyKey,['completed']);
      assert.equal(count('prompt.selection.input.stage'),stagedBefore.stage+1,'lost stage ACK must reuse verified original snapshot');
      assert.equal(count('prompt.submit'),stagedBefore.submit+1);assert.equal(requests.length,stagedBefore.models+1);
      const ackSession=await productSession();
      const ackRoute={sessionKey:ackSession.sessionKey,message:'SGH attachment submit ACK held',idempotencyKey:'hermes-attachment-submit-ack',
        pluginSelection:selectedRows,attachments:[image('submit-ack.png')]};
      let uncertain=false;lostAck={method:'prompt.submit',operationId:ackRoute.idempotencyKey};
      const ackBefore=requests.length;
      await hermes.sendMessage(ackRoute.sessionKey,ackRoute.message,ackRoute.idempotencyKey,{final:(_text,_error,meta)=>{uncertain=meta?.executionUncertain===true;}},
        {pluginSelection:selectedRows,attachments:ackRoute.attachments});
      assert(uncertain);await wait(()=>held!=null,'selected attachment model after lost submit ACK');
      const ackCounts={stage:count('prompt.selection.input.stage'),submit:count('prompt.submit')};
      await rebuildProduct();
      await assert.rejects(hermes.sendMessage(ackRoute.sessionKey,ackRoute.message,ackRoute.idempotencyKey,{},
        {pluginSelection:selectedRows,attachments:ackRoute.attachments}),{code:'PLUGIN_SELECTION_NEEDS_VERIFICATION'});
      const observedAck=await product.request('chat.operation.get',{sessionKey:ackRoute.sessionKey,idempotencyKey:ackRoute.idempotencyKey});
      assert.equal(observedAck.status,'found');assert.equal(observedAck.run.status,'running');assert(observedAck.run.runId);
      assert.equal(count('prompt.selection.input.stage'),ackCounts.stage);assert.equal(count('prompt.submit'),ackCounts.submit);assert.equal(requests.length,ackBefore+1);
      held?.();await productReceipt(ackSession,ackRoute.idempotencyKey,['completed']);
      // Genuine ordinary predecessor and future ordinary media surround a
      // selected queue item; none may claim another operation's image paths.
      const queueAttachmentSession=await productSession();
      const ordinaryImage=image('ordinary-first.png','ordinary-first');
      await socket.request('image.attach_bytes',{session_id:queueAttachmentSession.sessionId,content_base64:ordinaryImage.content,filename:'ordinary-first.png'});
      await socket.request('prompt.submit',{session_id:queueAttachmentSession.sessionId,text:'SGH attachment ordinary held'});
      await wait(()=>held!=null,'ordinary predecessor with media');
      assert(imageUrls(requests.at(-1)).includes('data:image/png;base64,'+ordinaryImage.content));
      const futureImage=image('ordinary-future.png','ordinary-future');
      await socket.request('image.attach_bytes',{session_id:queueAttachmentSession.sessionId,content_base64:futureImage.content,filename:'ordinary-future.png'});
      const queueImage=image('selected-queue.png','selected-queue');
      const queueAttachmentRoute={sessionKey:queueAttachmentSession.sessionKey,message:'SGH operation scoped queued image',idempotencyKey:'hermes-attachment-queued',
        pluginSelection:selectedRows,attachments:[queueImage]};
      const queueModelBefore=requests.length;await product.request('chat.send',queueAttachmentRoute);
      await wait(()=>chatFrames(queueAttachmentRoute.idempotencyKey).some(frame=>frame.payload.state==='accepted'),'selected attachments queued receipt');
      assert.equal(requests.length,queueModelBefore);assert(!chatFrames(queueAttachmentRoute.idempotencyKey).some(frame=>['delta','final'].includes(frame.payload.state)));
      held?.();assert.equal((await final(queueAttachmentRoute.idempotencyKey)).payload.state,'final');
      await productReceipt(queueAttachmentSession,queueAttachmentRoute.idempotencyKey,['completed']);
      assert.equal(requests.length,queueModelBefore+1);assert.deepEqual(imageUrls(requests.at(-1)),['data:image/png;base64,'+queueImage.content]);
      const afterQueue=requests.length;await socket.request('prompt.submit',{session_id:queueAttachmentSession.sessionId,text:'SGH ordinary future image after selected'});
      await wait(()=>requests.length===afterQueue+1,'future ordinary media');assert.deepEqual(imageUrls(requests.at(-1)),['data:image/png;base64,'+futureImage.content]);
      await wait(()=>events.some(event=>event.type==='message.complete' && event.session_id===queueAttachmentSession.sessionId),'ordinary media completion');
      const canceledAttachmentSession=await productSession();
      await socket.request('prompt.submit',{session_id:canceledAttachmentSession.sessionId,text:'SGH attachment ordinary held'});
      await wait(()=>held!=null,'ordinary predecessor of canceled selected media');
      const canceledFuture=image('ordinary-after-cancel.png','ordinary-after-cancel');
      await socket.request('image.attach_bytes',{session_id:canceledAttachmentSession.sessionId,content_base64:canceledFuture.content,filename:'ordinary-after-cancel.png'});
      const canceledAttachmentRoute={sessionKey:canceledAttachmentSession.sessionKey,message:'SGH operation scoped canceled queued image',
        idempotencyKey:'hermes-attachment-canceled-queued',pluginSelection:selectedRows,attachments:[image('canceled-selected.png','canceled-selected')]};
      const canceledModelBefore=requests.length;
      await product.request('chat.send',canceledAttachmentRoute);
      await wait(()=>chatFrames(canceledAttachmentRoute.idempotencyKey).some(frame=>frame.payload.state==='accepted'),'canceled selected queued receipt');
      const canceledSelection=await backend.cancelExternalPluginSelection({subject:canceledAttachmentSession.subject,operationId:canceledAttachmentRoute.idempotencyKey});
      assert.equal(canceledSelection.state,'canceled');assert.equal(canceledSelection.identity,null);
      held?.();assert.equal((await final(canceledAttachmentRoute.idempotencyKey)).payload.state,'error');
      assert.equal(requests.length,canceledModelBefore,'revoked queued media must send zero selected model requests');
      const canceledHost=await productReceipt(canceledAttachmentSession,canceledAttachmentRoute.idempotencyKey,['failed']);
      assert(canceledHost.run.runId,'Host generated exact task/turn before rejecting gate; it is not a successful Service bind');
      assert.equal((await backend.getExternalPluginSelection({subject:canceledAttachmentSession.subject,operationId:canceledAttachmentRoute.idempotencyKey})).identity,null);
      const canceledFutureBefore=requests.length;
      await socket.request('prompt.submit',{session_id:canceledAttachmentSession.sessionId,text:'SGH ordinary media after queued cancellation'});
      await wait(()=>requests.length===canceledFutureBefore+1,'ordinary media after selected cancellation');
      assert.deepEqual(imageUrls(requests.at(-1)),['data:image/png;base64,'+canceledFuture.content]);
      const failedSession=await productSession();
      const failBefore={stage:count('prompt.selection.input.stage'),submit:count('prompt.submit'),models:requests.length};
      const failKey='hermes-attachment-invalid-pdf';
      await assert.rejects(hermes.sendMessage(failedSession.sessionKey,'SGH invalid PDF upload never sent',failKey,{},
        {pluginSelection:selectedRows,attachments:[{type:'pdf',name:'invalid.pdf',mimeType:'application/pdf',content:Buffer.from('%PDF-invalid').toString('base64')}]}),
        {code:'PLUGIN_SELECTION_ATTACHMENTS_REJECTED'});
      assert.equal(count('prompt.selection.input.stage'),failBefore.stage+1);assert.equal(count('prompt.submit'),failBefore.submit);assert.equal(requests.length,failBefore.models);
      assert.equal(await backend.getExternalPluginSelection({subject:failedSession.subject,operationId:failKey}),null);
      assert.equal(count('file.attach'),0);assert.equal(count('pdf.attach'),0);
      assert.equal(count('image.attach_bytes'),3,'only explicit ordinary media may use session-global uploads');
      assert.equal(requests.length-attachmentCountBefore,10);
    } finally { HermesGatewaySocket.prototype.request=originalRequest; }
    if (reusedHost) verifyReusedHost();
    const result = { ok: true, host: 'hermes', pinnedCommit: 'c7c2df1a536d62b45fda8907bb1898981721794d',
      productionGateAndFinish: true, realAgentLookup: true, noToolSelection: true,
      modelToolModel: true, canonicalToolIdentity: true, exactAudit: true, exactToolAndResponseEvents: true, rawEnvelopeHidden: true,
      canceledBeforeModelRequests: 0, canceledLeaseDenied: true, noOrdinaryLeaseDowngrade: true,
      knownStoppedIdentity: true, canceledReplayNoResend: true, ordinaryChatPreserved: true, serviceRestartReceipt: true,
      modelRequests: requests.length, productProxySend: true, productRetryNoModel: true, productConflictNoModel: true,
      productOperationResume: true, productStopRevokesLease: true, productQueuedIdentity: true, productRetryOriginalAccepted: true,
      operationScopedAttachments: true, imagePdfFileActualModel: true, multipartModelToolModel: true, queuedAttachmentOwnership: true, revokedQueuedAttachmentsNoModel: true, ordinaryMediaPreserved: true,
      stageAckLossNoRetransfer: true, submitAckLossBackendRestartNoRetransferOrResend: true, reconstructedPayloadConflict: true, failedUploadNoMintOrModel: true,
      serviceRestartAutomaticRecovery: true, serviceRestartGrantUnchanged: true, serviceRestartNewSelectedToolCall: true, loopbackHandshake: true, notChatPageOrReleaseAcceptance: true };
    for (const relative of EVIDENCE_FILES) assert.equal(evidenceHash(relative), codeHashes[relative], "Evidence source changed during proof: " + relative);
    const evidence = { schemaVersion: 1, verifiedAt: new Date().toISOString(),
      scope: "pinned-real-local-host-and-production-service-backend-proxy", result, codeHashes,
      units: { hostContract: 18, inputStorage: 11, attachmentsBridge: 9, readiness: 8 },
      realSupplierAccount: false, actualChatPage: false, packagedApp: false, originalGlobalHostChanged: false };
    if (process.env.SHOGGOTH_TEST_HERMES_EVIDENCE_OUTPUT) {
      fs.writeFileSync(path.resolve(process.env.SHOGGOTH_TEST_HERMES_EVIDENCE_OUTPUT), JSON.stringify(evidence, null, 2) + "\n");
    }
    console.log(JSON.stringify(result));
  } finally {
    held?.(); product?.close(); unauthorized?.close(); await proxy?.close(); socket?.close(); await hermes?.stop().catch(() => {});
    if (host?.pid && host.exitCode == null) {
      try { process.kill(-host.pid, 'SIGTERM'); } catch { host.kill('SIGTERM'); }
      await Promise.race([new Promise(resolve => host.once('close', resolve)), sleep(4000)]);
      if (host.exitCode == null) { try { process.kill(-host.pid, 'SIGKILL'); } catch { host.kill('SIGKILL'); } }
    }
    await fixture.stop(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error('Hermes selection Service proof stopped: ' + error.message + ' [' + (error.stack?.split('\n').find(line=>line.includes('plugin-hermes-selection-service-real-host-fixture.cjs:'))?.trim() || 'no source line') + ']'); process.exitCode = 1; });
