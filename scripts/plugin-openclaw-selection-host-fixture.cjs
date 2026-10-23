'use strict';
// Real pinned npm host in an isolated /private/tmp copy, local model HTTP only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const { buildConnectParams, generateIdentity } = require('../app/core/device-auth');
const { prepareRuntime, validatePinnedSource, loadManifest } = require('./openclaw-selection-host-patch.cjs');
const ID = 'shoggoth-shared-capabilities';
const MODEL = 'shoggoth-selection-host-proof';
const TOKEN = 'isolated-selection-fixture-only';
const NODE = process.env.SHOGGOTH_TEST_OPENCLAW_NODE || (process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await fn()) return; await delay(100); }
  throw new Error(`${label} timed out`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
function stream(response, text, tool = false) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const deltas = tool ? [{ role: 'assistant', tool_calls: [{ index: 0, id: 'call_selection_fixture', type: 'function', function: { name: 'shoggoth_selection_probe', arguments: '{}' } }] }, {}] : [{ role: 'assistant', content: text }, {}];
  for (const delta of deltas) response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-selection-fixture', object: 'chat.completion.chunk', created: 1, model: MODEL,
    choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : tool ? 'tool_calls' : 'stop' }],
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}
async function client(url, identity) {
  const socket = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1' } });
  const pending = new Map(); let count = 0; let connectSent = false; const events = [];
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = `selection-proof-${++count}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 12000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
  const fail = err => { readyReject(err); for (const entry of pending.values()) entry.reject(err); pending.clear(); };
  socket.on('error', fail); socket.on('close', () => fail(new Error('gateway socket closed')));
  socket.on('message', bytes => {
    const frame = JSON.parse(bytes.toString());
    if (frame.type === 'event') {
      events.push(frame);
      if (frame.event === 'connect.challenge' && !connectSent) {
        connectSent = true;
        void request('connect', buildConnectParams({ ...identity, token: TOKEN, scopes: ['operator.write'] }, frame.payload?.nonce)).then(readyResolve, readyReject);
      }
      return;
    }
    const entry = pending.get(frame.id); if (!entry) return; pending.delete(frame.id);
    if (frame.ok) entry.resolve(frame.payload);
    else entry.reject(new Error(`${frame.error?.code}: ${frame.error?.message}`));
  });
  await ready;
  return { request, events, close: () => socket.close() };
}

async function main() {
  let prepared;
  if (process.env.SHOGGOTH_TEST_OPENCLAW_REUSE_ROOT) {
    const root = fs.realpathSync(process.env.SHOGGOTH_TEST_OPENCLAW_REUSE_ROOT);
    assert.ok(root.startsWith('/private/tmp/shoggoth-openclaw-selection-'));
    const runtime = path.join(root, 'openclaw');
    const { manifest } = loadManifest();
    for (const item of [...manifest.files, ...manifest.newFiles]) {
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime, item.path))).digest('hex'), item.afterSha256 || item.sha256);
    }
    const fixtureRoot = fs.realpathSync(fs.mkdtempSync('/private/tmp/shoggoth-openclaw-selection-retest-'));
    prepared = { root: fixtureRoot, runtime, entry: path.join(runtime, 'openclaw.mjs') };
    validatePinnedSource('/opt/homebrew/lib/node_modules/openclaw');
  } else prepared = prepareRuntime();
  const root = prepared.root;
  const state = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const plugin = path.join(root, 'adapter');
  for (const dir of [state, workspace, plugin]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const control = path.join(root, 'adapter-mode.json');
  const gateLog = path.join(root, 'gate-events.jsonl');
  const adapterSource = path.join(plugin, 'index.mjs');
  fs.writeFileSync(control, JSON.stringify({ mode: 'ok' }));
  fs.writeFileSync(adapterSource, `import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
export default { id: ${JSON.stringify(ID)}, name: 'Isolated Shoggoth selection proof', register(api) {
  const localInstanceId = randomUUID();
  const pending = new Map();
  const log = event => fs.appendFileSync(${JSON.stringify(gateLog)}, JSON.stringify(event) + '\\n');
  api.registerCapabilitySelectionGate(async request => {
    log(request);
    const mode = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8')).mode;
    if (mode === 'error') throw new Error('fixture gate failure');
    if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 5500));
    const proof = { ...request.capabilitySelection, ...request.identity };
    if (mode === 'wrong-proof') proof.actualRunId = 'another-run';
    return { proof, prependSystemContext: mode === 'empty-context' ? '' : 'USER_SELECTED_PLUGIN_PREFERENCE_FIXTURE: prefer the installed fixture plugin.' };
  }, { instanceId: localInstanceId, onTerminal: async event => {
    if (JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8')).mode === 'terminal-error') throw new Error('fixture terminal failure');
    log({ phase: 'terminal', ...event });
  } });
  api.on('before_tool_call', (event, ctx) => {
    if (event.toolName !== 'shoggoth_selection_probe') return;
    if (!ctx.capabilitySelection || !ctx.selectionAdapterInstanceId) return { block: true, blockReason: 'Core selection binding unavailable' };
    const captured = { capabilitySelection: ctx.capabilitySelection,
      identity: { backendId: 'openclaw', instanceId: ctx.selectionAdapterInstanceId, agentId: ctx.agentId, sessionId: ctx.sessionId, runId: ctx.runId, toolCallId: event.toolCallId },
      sessionKey: ctx.sessionKey, localInstanceId, contextFrozen: Object.isFrozen(ctx), envelopeFrozen: Object.isFrozen(ctx.capabilitySelection) };
    pending.set(event.toolCallId, captured);
    log({ phase: 'tool-hook', ...captured });
  });
  api.registerTool(context => ({ name: 'shoggoth_selection_probe', label: 'Selection fixture probe',
    description: 'Read the isolated local proof fixture.', parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(callId) {
      const captured = pending.get(callId); pending.delete(callId);
      if (!captured || captured.identity.agentId !== context.agentId || captured.identity.sessionId !== context.sessionId) throw new Error('Exact trusted selected tool identity unavailable');
      log({ phase: 'tool-execution', ...captured });
      return { content: [{ type: 'text', text: 'SELECTION_TOOL_RESULT_FIXTURE' }] };
    }
  }), { name: 'shoggoth_selection_probe' });
} };
`);
  fs.writeFileSync(path.join(plugin, 'openclaw.plugin.json'), JSON.stringify({ id: ID, name: 'Selection fixture adapter', activation: { onStartup: true }, contracts: { tools: ['shoggoth_selection_probe'] },
    configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  const trustPath = path.join(root, 'selection-trust.json');
  fs.writeFileSync(trustPath, JSON.stringify({ version: 1, adapterId: ID, sourcePath: adapterSource,
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(adapterSource)).digest('hex') }), { mode: 0o600 });
  const calls = []; let modelFailure = null; let heldResponse = null; let gateway = null; let connection = null; let foreign = null; let logs = '';
  const model = http.createServer(async (req, res) => {
    try {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    if (JSON.stringify(body.messages?.filter(item => item.role === 'user').at(-1)).includes('hold-first-selection-model') || JSON.stringify(body.messages?.filter(item => item.role === 'user').at(-1)).includes('hold-stop-selection-model')) { heldResponse = res; return; }
    if (JSON.stringify(body.messages?.filter(item => item.role === 'user').at(-1)).includes('exercise-selected-tool') && !body.messages.some(item => item.role === 'tool')) {
      assert.ok(body.tools.some(item => item.function?.name === 'shoggoth_selection_probe'), 'fixture tool must be offered by actual host');
      stream(res, '', true); return;
    }
    stream(res, body.messages?.some(item => item.role === 'tool') ? 'The exact selected tool completed.' : 'The isolated host completed without calling a tool.');
    } catch (error) { modelFailure = error; if (!res.headersSent) res.writeHead(500); res.end('Isolated fixture failed.'); }
  });
  await new Promise((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve); });
  const port = await freePort(); const configPath = path.join(root, 'openclaw.json');
  const config = {
    models: { mode: 'replace', providers: { probe: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only',
      api: 'openai-completions', agentRuntime: { id: 'openclaw' }, models: [{ id: MODEL, name: MODEL, reasoning: false,
        input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] } } },
    agents: { defaults: { model: { primary: `probe/${MODEL}` }, workspace, skipBootstrap: true } },
    logging: { level: 'debug', consoleLevel: 'debug', file: path.join(root, 'host-diagnostic.log') },
    tools: { profile: 'minimal', alsoAllow: ['shoggoth_selection_probe'] },
    gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token: TOKEN }, controlUi: { enabled: true } },
    discovery: { mdns: { mode: 'off' } }, update: { checkOnStart: false },
    plugins: { load: { paths: [plugin] }, entries: { [ID]: { enabled: true, hooks: { allowConversationAccess: true } } } },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const env = { HOME: root, PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: '/private/tmp',
    USER: process.env.USER || 'fixture', LOGNAME: process.env.LOGNAME || 'fixture', OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_SELECTION_TRUST_PATH: trustPath, OPENCLAW_NO_AUTO_UPDATE: '1', OPENCLAW_DISABLE_BONJOUR: '1' };
  const identity = generateIdentity(); const cases = [];
  const start = async () => {
    gateway = spawn(NODE, [prepared.entry, 'gateway', 'run', '--port', String(port), '--auth', 'token', '--token', TOKEN, '--verbose'],
      { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    gateway.stdout.on('data', chunk => { logs += chunk; }); gateway.stderr.on('data', chunk => { logs += chunk; });
    await until(async () => {
      if (gateway.exitCode !== null) throw new Error(`gateway exited: ${logs.slice(-3500)}`);
      try { connection = await client(`ws://127.0.0.1:${port}`, identity); return true; } catch { return false; }
    }, 'gateway ready', 30000);
  };
  const stop = async () => {
    connection?.close(); connection = null;
    if (gateway && gateway.exitCode === null) {
      const child = gateway; try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
      if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }
    gateway = null;
  };
  let generation;
  const envelope = op => ({ version: 1, operationId: op, dispatchRef: `dispatch-${op}`,
    selectionDigest: crypto.createHash('sha256').update(op).digest('hex'), requiredAdapterId: ID, adapterGeneration: generation });
  const send = async (op, message = 'Complete this ordinary task.', additions = {}) => {
    const sessionKey = additions.sessionKey || `agent:main:${op}`;
    const preflight = await connection.request('chat.selection.capabilities', { sessionKey, agentId: 'main' });
    assert.equal(preflight.subject.sessionKey, sessionKey); assert.ok(preflight.subject.sessionId);
    return connection.request('chat.send', { sessionKey, sessionId: preflight.subject.sessionId,
      message, idempotencyKey: op, capabilitySelection: envelope(op), ...additions });
  };
  const query = (op, sessionKey = `agent:main:${op}`) => connection.request('chat.selection.get', { operationId: op, sessionKey });
  const gates = () => fs.existsSync(gateLog) ? fs.readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(item => !item.phase) : [];
  try {
    await start();
    const capabilities = await connection.request('chat.selection.capabilities');
    assert.equal(capabilities.version, 1); assert.equal(capabilities.adapters.length, 1, JSON.stringify({ capabilities, logs: logs.slice(-3000) }));
    generation = capabilities.adapters[0].adapterGeneration; assert.match(generation, /^[a-f0-9-]{36}$/);
    const canonicalInstanceId = capabilities.adapters[0].instanceId; assert.match(canonicalInstanceId, /^[a-f0-9-]{36}$/);
    cases.push('host-owned trusted registration generation, adapter instance and capability negotiation');
    const ack = await send('selected-no-tools');
    assert.equal(ack.capabilitySelection.actualRunId, null); assert.equal(ack.capabilitySelection.status, 'accepted');
    let selected;
    await until(async () => { selected = await query('selected-no-tools'); if (['failed', 'blocked', 'aborted'].includes(selected.status)) throw new Error(`selected initial status ${selected.status}`); return selected.status === 'completed'; }, 'selected no tools completion');
    assert.equal(selected.actualRunId, 'selected-no-tools'); assert.equal(selected.dispatchRef, 'dispatch-selected-no-tools');
    const gate = gates().find(item => item.capabilitySelection.operationId === 'selected-no-tools');
    assert.equal(gate.identity.actualRunId, selected.actualRunId); assert.equal(gate.identity.sessionId, selected.sessionId);
    assert.equal(gate.identity.sessionKey, selected.sessionKey); assert.equal(gate.identity.agentId, selected.agentId);
    assert.equal(calls.length, 1); assert.ok(JSON.stringify(calls[0]).includes('USER_SELECTED_PLUGIN_PREFERENCE_FIXTURE')); cases.push('selected no-tool-call success bound before first model request');
    const beforeReplay = calls.length;
    const replay = await send('selected-no-tools'); assert.equal(replay.replayed, true); assert.equal(replay.capabilitySelection.actualRunId, selected.actualRunId);
    await assert.rejects(send('selected-no-tools', 'Changed text.'), /OPERATION_CONFLICT/);
    await assert.rejects(send('selected-no-tools', undefined, { capabilitySelection: { ...envelope('selected-no-tools'), selectionDigest: 'a'.repeat(64) } }), /OPERATION_CONFLICT/);
    await assert.rejects(connection.request('chat.send', { sessionKey: selected.sessionKey, sessionId: selected.sessionId, message: 'Complete this ordinary task.', idempotencyKey: 'selected-no-tools' }), /OPERATION_CONFLICT/);
    assert.equal(calls.length, beforeReplay); cases.push('full-envelope durable idempotence and omitted-envelope conflict');
    for (const mode of ['error', 'wrong-proof', 'timeout', 'empty-context']) {
      fs.writeFileSync(control, JSON.stringify({ mode })); const op = `selected-${mode}`; const before = calls.length;
      await send(op);
      await until(async () => (await query(op)).status === 'blocked', `gate ${mode}`);
      assert.equal(calls.length, before, `${mode} gate must cause zero model requests`);
    }
    fs.writeFileSync(control, JSON.stringify({ mode: 'ok' })); cases.push('gate error, wrong proof, timeout and missing preference context fail closed with zero model requests');
    const beforeRejects = calls.length;
    await assert.rejects(send('bad-generation', undefined, { capabilitySelection: { ...envelope('bad-generation'), adapterGeneration: 'caller-invented-generation' } }), /GENERATION_CHANGED/);
    await assert.rejects(send('bad-operation', undefined, { capabilitySelection: { ...envelope('bad-operation'), operationId: 'different-op' } }), /INVALID/);
    await assert.rejects(send('unknown-envelope-field', undefined, { capabilitySelection: { ...envelope('unknown-envelope-field'), installationIds: ['forbidden'] } }), /invalid chat.send/);
    for (const queueMode of ['steer', 'collect', 'interrupt']) await assert.rejects(send(`selected-${queueMode}`, undefined, { queueMode }), /PATH_UNSUPPORTED/);
    await assert.rejects(send('selected-command', '/status'), /PATH_UNSUPPORTED/);
    assert.equal(calls.length, beforeRejects); cases.push('closed schema, operation binding, stale generation, selected command/steer/collect/interrupt rejected');
    foreign = await client(`ws://127.0.0.1:${port}`, generateIdentity());
    await assert.rejects(foreign.request('chat.selection.get', { operationId: 'selected-no-tools', sessionKey: selected.sessionKey }), /FORBIDDEN/);
    foreign.close(); foreign = null; cases.push('selection query owner isolation');
    const ordinaryBefore = calls.length;
    await connection.request('chat.send', { sessionKey: 'agent:main:ordinary', message: 'Ordinary no selection.', idempotencyKey: 'ordinary' });
    await until(() => calls.length === ordinaryBefore + 1 && connection.events.some(event => event.event === 'chat' && event.payload?.runId === 'ordinary' && event.payload?.state === 'final'), 'ordinary chat completion');
    assert.equal(gates().some(item => item.capabilitySelection.operationId === 'ordinary'), false); cases.push('ordinary unselected chat remains unchanged');
    const toolBefore = calls.length;
    await send('selected-toolcall', 'exercise-selected-tool');
    let toolReceipt;
    await until(async () => { if (modelFailure) throw modelFailure; toolReceipt = await query('selected-toolcall'); if (['failed', 'blocked', 'aborted'].includes(toolReceipt.status)) throw new Error(`selected tool failed: ${toolReceipt.status}`); return toolReceipt.status === 'completed'; }, 'selected tool completion');
    assert.equal(calls.length, toolBefore + 2, 'actual model/tool/model loop must run');
    const toolEvents = fs.readFileSync(gateLog, 'utf8').trim().split('\n').map(JSON.parse).filter(item => item.phase === 'tool-execution');
    assert.equal(toolEvents.length, 1);
    const toolEvent = toolEvents[0]; const toolGate = gates().find(item => item.capabilitySelection.operationId === 'selected-toolcall');
    assert.deepEqual(toolEvent.capabilitySelection, envelope('selected-toolcall'));
    assert.equal(toolEvent.identity.instanceId, canonicalInstanceId);
    assert.notEqual(toolEvent.localInstanceId, canonicalInstanceId, 'per-model scoped adapter UUID must differ from authoritative Gateway identity');
    assert.equal(toolEvent.identity.agentId, toolGate.identity.agentId); assert.equal(toolEvent.identity.sessionId, toolGate.identity.sessionId);
    assert.equal(toolEvent.identity.runId, toolGate.identity.actualRunId); assert.equal(toolEvent.sessionKey, toolGate.identity.sessionKey);
    assert.equal(toolEvent.identity.runId, toolReceipt.actualRunId); assert.equal(toolEvent.contextFrozen, true); assert.equal(toolEvent.envelopeFrozen, true);
    assert.ok(JSON.stringify(calls.at(-1)).includes('SELECTION_TOOL_RESULT_FIXTURE'));
    cases.push('actual model/tool/model loop retains exact canonical selection identity across scoped adapter fork');
    const queueSession = 'agent:main:selected-queue';
    await send('queue-first', 'hold-first-selection-model', { sessionKey: queueSession });
    await until(() => heldResponse !== null, 'first queued-model hold');
    const queuedAck = await send('queue-second', 'Second selected task.', { sessionKey: queueSession, queueMode: 'followup' });
    assert.equal(queuedAck.capabilitySelection.actualRunId, null);
    await until(async () => (await query('queue-second', queueSession)).status === 'queued', 'selected followup deferred');
    stream(heldResponse, 'First selected task completed.'); heldResponse = null;
    let queued;
    await until(async () => { queued = await query('queue-second', queueSession); return queued.status === 'completed'; }, 'selected followup completion');
    assert.ok(queued.actualRunId); assert.notEqual(queued.actualRunId, 'queue-second');
    const queuedGate = gates().find(item => item.capabilitySelection.operationId === 'queue-second');
    assert.equal(queuedGate.identity.actualRunId, queued.actualRunId); assert.equal(queuedGate.identity.sessionKey, queueSession);
    cases.push('normal followup queue preserves dispatch ref and distinct actual run identity');
    await send('selected-stop', 'hold-stop-selection-model');
    await until(() => heldResponse !== null, 'selected stop model start');
    await connection.request('chat.abort', { sessionKey: 'agent:main:selected-stop', runId: 'selected-stop' });
    heldResponse.destroy(); heldResponse = null;
    await until(async () => (await query('selected-stop')).status === 'aborted', 'selected stop terminal confirmation');
    const terminalEvents = fs.readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(item => item.phase === 'terminal');
    assert.ok(terminalEvents.some(item => item.capabilitySelection.operationId === 'selected-stop' && item.status === 'aborted' && item.identity.actualRunId === 'selected-stop'));
    cases.push('selected Stop confirms exact bound run terminal receipt');
    fs.writeFileSync(control, JSON.stringify({ mode: 'terminal-error' }));
    const terminalBefore = calls.length;
    await send('selected-terminal-error');
    await until(async () => (await query('selected-terminal-error')).status === 'needs-verification', 'terminal confirmation failure');
    assert.equal(calls.length, terminalBefore + 1);
    const terminalReplay = await send('selected-terminal-error'); assert.equal(terminalReplay.replayed, true);
    assert.equal(terminalReplay.capabilitySelection.status, 'needs-verification'); assert.equal(calls.length, terminalBefore + 1);
    fs.writeFileSync(control, JSON.stringify({ mode: 'ok' }));
    cases.push('terminal confirmation failure enters needs-verification without replay');

    for (const call of calls) {
      const serialized = JSON.stringify(call);
      assert.equal(serialized.includes('capabilitySelection'), false);
      for (const item of gates()) {
        assert.equal(serialized.includes(item.capabilitySelection.dispatchRef), false);
        assert.equal(serialized.includes(item.capabilitySelection.selectionDigest), false);
        assert.equal(serialized.includes(item.capabilitySelection.adapterGeneration), false);
      }
    }
    cases.push('selection envelope and binding proof absent from every model request');
    await stop(); await start();
    const observed = await query('selected-no-tools'); assert.deepEqual(observed, selected);
    const newCapabilities = await connection.request('chat.selection.capabilities');
    assert.notEqual(newCapabilities.adapters[0].adapterGeneration, generation);
    const restartBefore = calls.length;
    const restartedReplay = await send('selected-no-tools'); assert.equal(restartedReplay.replayed, true);
    assert.equal(restartedReplay.capabilitySelection.actualRunId, selected.actualRunId);
    assert.equal(calls.length, restartBefore); cases.push('receipt survives real Gateway restart without replaying selected work');
    generation = newCapabilities.adapters[0].adapterGeneration;
    await stop(); config.plugins.entries[ID].enabled = false; fs.writeFileSync(configPath, JSON.stringify(config)); await start();
    const absent = await connection.request('chat.selection.capabilities'); assert.deepEqual(absent.adapters, []);
    const absentBefore = calls.length;
    await assert.rejects(send('selected-adapter-absent'), /ADAPTER_UNAVAILABLE/);
    await delay(500); assert.equal(calls.length, absentBefore); cases.push('adapter absent rejects selected turn with zero model requests');
    validatePinnedSource('/opt/homebrew/lib/node_modules/openclaw');
    const evidence = { version: 1, status: 'passed', hostVersion: '2026.9.5', runtime: prepared.runtime,
      model: 'local HTTP fixture only', modelRequests: calls.length, gateRequests: gates().length, cases,
      globalRuntimeUnchanged: true, actualQueuedRunId: queued.actualRunId, selectedToolRunId: toolReceipt.actualRunId, selectedToolAdapterInstanceId: canonicalInstanceId, scopedToolAdapterInstanceId: toolEvent.localInstanceId, scope: 'normal built-in chat.send and followup queue; external harnesses explicitly unsupported' };
    fs.writeFileSync(path.join(root, 'selection-host-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    error.message += `; fixture=${root}; debug=${JSON.stringify({ modelRequests: calls.length, gateRequests: gates(), events: connection?.events.filter(item => ['chat', 'agent', 'chat.send_timing'].includes(item.event)).slice(-16) }).slice(0, 6500)}`;
    throw error;
  } finally {
    heldResponse?.destroy(); foreign?.close(); await stop(); await new Promise(resolve => model.close(resolve));
    fs.writeFileSync(path.join(root, 'gateway-fixture.log'), logs, { mode: 0o600 });
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
