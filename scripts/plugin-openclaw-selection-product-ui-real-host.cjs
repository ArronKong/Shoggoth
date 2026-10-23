#!/usr/bin/env node
'use strict';
// A single live chain: production React -> real __chatws broker/Proxy ->
// independently owned managed OpenClaw Gateway -> exact adapter -> Service.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { WebSocket } = require('ws');
const { createManagedPluginHostRuntimeManager } = require('../app/managed-plugin-host-runtime');
const { startStaticServer } = require('../app/static-server');
const { createAuthResolver } = require('../app/core/device-auth');
const { createConfigStore } = require('../app/core/config-store');
const pins = require('../app/managed-openclaw-runtime-pins.json');
const REPO = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = [
  'app/core/plugin-selection-readiness-dto.js', 'app/core/shoggoth-backend.js', 'app/static-server.js',
  'app/core/openclaw-backend.js', 'app/core/openclaw-local-runtime-scope.js', 'app/core/openclaw-plugin-selection.js',
  'app/core/proxy-gateway.js', 'app/core/backend-registry.js', 'app/core/chat-broker.js', 'app/core/device-auth.js',
  'app/managed-openclaw-host-supervisor.js', 'app/managed-plugin-host-runtime.js', 'app/managed-openclaw-runtime-pins.json',
  'app/agent-service/server.js', 'app/agent-service/external-plugin-selection-dispatch.js',
  'app/agent-service/external-plugin-tool-service.js', 'resources/external-plugin-adapters/openclaw/index.mjs',
  'resources/external-plugin-adapters/openclaw/transport.mjs', 'app/manage-ui/src/pages/ChatPage.tsx',
  'app/manage-ui/src/pages/ChatPluginPicker.tsx', 'app/manage-ui/src/lib/usePluginSelectionReadiness.ts',
  'app/manage-ui/src/api/client.ts', 'app/manage-ui/src/lib/chatSendRecovery.ts',
  'scripts/fixtures/plugin-openclaw-product-ui-local-mcp.cjs', 'scripts/plugin-openclaw-selection-service-real-host-fixture.cjs',
  'scripts/plugin-openclaw-selection-product-ui-real-host.cjs', 'scripts/fixtures/plugin-openclaw-product-ui-driver.cjs',
];
function sourceHashes() { return Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(REPO, file)))])); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const startedHashes = sourceHashes();
  const sharedState = process.env.SHOGGOTH_TEST_OPENCLAW_MANAGED_CANDIDATE_STATE;
  assert.ok(sharedState && path.isAbsolute(sharedState) && fs.realpathSync(sharedState).startsWith('/private/tmp/sg-managed-openclaw-'),
    'set SHOGGOTH_TEST_OPENCLAW_MANAGED_CANDIDATE_STATE to the verified private fixture candidate state');
  const manager = createManagedPluginHostRuntimeManager({ stateDir: fs.realpathSync(sharedState),
    resourcesRoot: path.join(REPO, 'resources/external-plugin-host-patches'), inputPins: pins });
  const candidate = manager.getCandidate('openclaw'); assert.ok(candidate);
  assert.equal(candidate.runtimeTreeSha256, pins.hosts.openclaw.outputTreeSha256);
  const output = path.resolve(process.env.SHOGGOTH_TEST_PRODUCT_UI_OUTPUT || '/private/tmp/plugin-openclaw-product-ui');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const uiArtifacts = fs.readdirSync(path.join(REPO, 'app/manage-ui/dist/assets')).filter(file => file.endsWith('.js'));
  const buildHashes = Object.fromEntries(uiArtifacts.map(file => [file, sha(fs.readFileSync(path.join(REPO, 'app/manage-ui/dist/assets', file)))]));
  const { main: prepareActualHost } = require('./plugin-openclaw-selection-service-real-host-fixture.cjs');
  const result = await prepareActualHost({ managedCandidate: candidate, runProductUi: async context => {
    const { root, backend, registry, proxy, installation, supervisor } = context;
    const sessionKey = 'agent:main:product-ui-joint';
    // Actual authenticated Host API materializes the isolated fixture session.
    // This is setup; the subsequent readiness GET is separately proved read-only.
    const physical = await backend.request('chat.selection.capabilities', { agentId: 'main', sessionKey });
    assert.equal(physical.subject.sessionKey, sessionKey); assert.ok(physical.subject.sessionId);
    const actualRows = (await backend.request('sessions.list', { limit: 20 })).sessions;
    const row = actualRows.find(item => item.key === sessionKey); assert.ok(row, 'actual session must be discoverable');
    const configStore = createConfigStore(path.join(root, 'app-ui-config.json'));
    configStore.write({ ...configStore.read(), locale: 'zh-CN', setupCompletedAt: Date.now() });
    const authResolver = createAuthResolver({ getConfig: () => ({ gatewayUrl: context.gatewayUrl, token: context.gatewayToken }),
      credentialsDir: path.join(root, 'browser-backend-credentials'), operatorIdentityDir: path.join(root, 'browser-operator'),
      localGatewayConfigPath: context.configPath });
    const observed = { browserRequests: [], deliveredFrames: [], selectedHostForwards: [], readinessCalls: [], dropped: null };
    let armDrop = false, web, child, childOutput = '', childError = '', uiReport;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data, ...args) {
      let frame; try { frame = JSON.parse(data.toString()); } catch {}
      if (frame?.type === 'req' && this.url === new URL(proxy.url).href) {
        observed.browserRequests.push(frame);
      }
      if (frame?.type === 'req' && this.url === new URL(context.gatewayUrl).href && frame.method === 'chat.send'
        && frame.params?.capabilitySelection) observed.selectedHostForwards.push(frame.params.capabilitySelection.operationId);
      if (web && this._isServer && this._socket?.localPort === Number(new URL(web.url).port) && frame) {
        const request = observed.browserRequests.find(item => item.id === frame.id && item.method === 'chat.send'
          && item.params?.message?.includes('JOINT_LOST_ACK'));
        if (armDrop && request && frame.type === 'res' && frame.ok && frame.payload?.capabilitySelection?.status === 'accepted') {
          armDrop = false; observed.dropped = { operationId: request.params.idempotencyKey, runId: frame.payload.runId,
            sessionKey: request.params.sessionKey, admissionStatus: frame.payload.capabilitySelection.status };
          // One actual browser TCP is cut after the real Host's durable ACK.
          // This drops the transport receipt; no RPC response is fabricated.
          this.terminate(); return;
        }
        observed.deliveredFrames.push(frame);
      }
      return originalSend.call(this, data, ...args);
    };
    const originalReadiness = backend.getPluginSelectionReadiness.bind(backend);
    backend.getPluginSelectionReadiness = async input => {
      const before = { models: context.modelCalls.length, prepares: context.getPrepareCalls() };
      const answer = await originalReadiness(input);
      observed.readinessCalls.push({ input: { ...input }, answer, before,
        after: { models: context.modelCalls.length, prepares: context.getPrepareCalls() } }); return answer;
    };
    try {
      web = await startStaticServer(0, { homeDir: root, userDataRoot: root, registry, configStore,
        chatUpstreamUrl: proxy.url, chatOrigin: 'http://127.0.0.1', authResolver, workAdmissionGate: context.admissionGate });
      const boot = { url: `${web.url}#/chat`, output, sessionKey,
        // Routing cache contains only the actual Host row; no plugin selection,
        // readiness, lease, native context or accepted state is seeded.
        session: { ...row, backendId: 'openclaw', agentName: 'OpenClaw', updatedAt: Date.now() },
        installationId: installation.installationId, revision: installation.revision, packageName: 'project-assistant', businessMarker: context.business.marker };
      const bootPath = path.join(root, 'product-ui-boot.json'); fs.writeFileSync(bootPath, JSON.stringify(boot), { mode: 0o600 });
      child = spawn(require('electron'), [path.join(__dirname, 'fixtures/plugin-openclaw-product-ui-driver.cjs'), bootPath],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
      child.stdout.on('data', bytes => { childOutput += bytes; }); child.stderr.on('data', bytes => { childError += bytes; });
      child.on('message', async message => {
        if (message?.type !== 'fixture-command') return;
        try {
          let value;
          if (message.command === 'inspect') value = { modelRequests: context.modelCalls.length, prepares: context.getPrepareCalls(),
            held: context.getHeld() !== null, events: context.serviceEvents, browserRequests: observed.browserRequests,
            deliveredFrames: observed.deliveredFrames, forwards: observed.selectedHostForwards, dropped: observed.dropped,
            modelError: context.getModelError()?.message || null };
          else if (message.command === 'release-tool') { context.releaseHeldTool(); value = true; }
          else if (message.command === 'discard-held') { context.discardHeld(); value = true; }
          else if (message.command === 'arm-lost-ack') { armDrop = true; value = true; }
          else if (message.command === 'report') { uiReport = message.value; value = true; }
          else throw Error('unknown fixture coordination command');
          if (child.connected) child.send({ id: message.id, ok: true, value });
        } catch(error) { if(child.connected) child.send({ id: message.id, ok: false, error: String(error.message) }); }
      });
      let timeout;
      const exit = await Promise.race([new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('joint production UI timed out')), 160000); })])
        .finally(() => clearTimeout(timeout));
      assert.equal(exit.code, 0, `actual product UI failed: ${childOutput}\n${childError}`); assert.ok(uiReport?.passed);
      assert.equal(context.getModelError(), null);
      const sends = observed.browserRequests.filter(item => item.method === 'chat.send' && item.params?.pluginSelection);
      assert.equal(sends.length, 3); assert.equal(new Set(sends.map(item => item.params.idempotencyKey)).size, 3);
      for (const item of sends) {
        assert.equal(item.params.sessionKey, sessionKey); assert.deepEqual(item.params.pluginSelection,
          [{ installationId: installation.installationId, revision: installation.revision }]);
        assert.equal(Object.hasOwn(item.params, 'capabilitySelection'), false);
        assert.equal(observed.selectedHostForwards.filter(operation => operation === item.params.idempotencyKey).length, 1);
        const binding = context.serviceEvents.find(event => event.kind === 'bind:success' && event.identity.runId === item.params.idempotencyKey);
        assert.ok(binding); assert.equal(binding.identity.sessionId, physical.subject.sessionId);
        assert.equal(binding.identity.agentId, 'main');
      }
      const completed = sends.filter(item => !item.params.message.includes('JOINT_STOP'));
      const mcpCalls = [];
      for (const item of completed) {
        const operationId = item.params.idempotencyKey;
        const calls = context.serviceEvents.filter(event => event.kind === 'call:success' && event.identity.runId === operationId);
        assert.equal(calls.length, 1, 'each completed UI task must execute the real MCP tool exactly once');
        const call = calls[0], expectedIssue = item.params.message.includes('JOINT_LOST_ACK') ? 'fixture-002' : 'fixture-001';
        assert.equal(call.identity.agentId, 'main'); assert.equal(call.identity.sessionId, physical.subject.sessionId);
        assert.equal(call.identity.instanceId, physical.adapters.find(adapter => adapter.adapterId === 'shoggoth-shared-capabilities').instanceId);
        assert.equal(call.serverId, context.business.serverId); assert.equal(call.toolName, context.business.toolName);
        assert.equal(call.argumentIssueId, expectedIssue); assert.equal(call.isError, false);
        assert.equal(call.result.marker, context.business.marker); assert.equal(call.result.issue.id, expectedIssue);
        assert.ok(Number.isSafeInteger(call.result.executingProcessId) && call.result.executingProcessId !== process.pid);
        const command = execFileSync('/bin/ps', ['-p', String(call.result.executingProcessId), '-o', 'command='], { encoding: 'utf8' });
        assert.ok(command.includes(root) && command.includes('/bin/issue-fixture'), 'result must come from the actual private MCP subprocess');
        mcpCalls.push({ operationId, serverId: call.serverId, toolName: call.toolName, issueId: expectedIssue,
          marker: call.result.marker, processId: call.result.executingProcessId });
        assert.ok(context.serviceEvents.some(event => event.kind === 'finish:success' && event.identity.runId === operationId && event.state === 'completed'));
      }
      const stopOperation = sends.find(item => item.params.message.includes('JOINT_STOP')).params.idempotencyKey;
      assert.equal(context.serviceEvents.filter(event => event.kind === 'call:request' && event.identity.runId === stopOperation).length, 0);
      assert.equal(context.serviceEvents.filter(event => event.kind === 'search:success').length, 0, 'search summaries never count as MCP business execution');
      assert.ok(observed.dropped); assert.equal(observed.dropped.admissionStatus, 'accepted');
      assert.ok(observed.browserRequests.some(item => item.method === 'chat.operation.get'
        && item.params?.idempotencyKey === observed.dropped.operationId && item.params?.sessionKey === sessionKey));
      assert.ok(observed.readinessCalls.some(item => item.answer === true && item.before.models === 0 && item.after.models === 0
        && item.before.prepares === 0 && item.after.prepares === 0));
      const operationObservations = observed.deliveredFrames.flatMap((frame, index) => {
        const value = frame?.payload;
        if (frame.type !== 'res' || frame.ok !== true || value?.status !== 'found' || value.backendId !== 'openclaw'
          || value.sessionKey !== sessionKey || !sends.some(send => send.params.idempotencyKey === value.operationId)) return [];
        const matchingTerminalIndex = observed.deliveredFrames.findIndex(terminal => terminal.type === 'event'
          && terminal.event === 'chat' && terminal.payload?.runId === value.operationId && terminal.payload?.sessionKey === sessionKey
          && ['final', 'error', 'aborted'].includes(terminal.payload?.state));
        return [{ operationId: value.operationId, sessionKey: value.sessionKey, backendId: value.backendId,
          status: value.run.status, admissionAccepted: value.admissionAccepted === true,
          afterMatchingTerminal: matchingTerminalIndex >= 0 && index > matchingTerminalIndex }];
      });
      const terminalReceiptLagObserved = operationObservations.some(item => item.afterMatchingTerminal
        && ['accepted', 'queued', 'running'].includes(item.status));
      assert.equal(terminalReceiptLagObserved, true, 'the real Host final-before-durable-terminal observation must be exercised');
      const adapterEvents = context.readAdapterEvents();
      assert.ok(adapterEvents.some(event => event.phase === 'tool-execute' && event.name === 'shoggoth_plugin_call'));
      return { passed: true, ui: uiReport, selectedSends: sends.map(item => ({ operationId: item.params.idempotencyKey,
        sessionKey, selection: item.params.pluginSelection, marker: item.params.message.split(' ').at(-1) })),
        business: { ...context.business, calls: mcpCalls, readOnlyFixture: true, actualStdioSubprocess: true },
        modelRequests: context.modelCalls.length, selectedHostForwards: observed.selectedHostForwards,
        operationObservations, terminalReceiptLagObserved,
        droppedAck: observed.dropped, readinessObservations: observed.readinessCalls,
        physicalHost: { agentId: 'main', sessionId: physical.subject.sessionId,
          adapterInstanceId: physical.adapters.find(item => item.adapterId === 'shoggoth-shared-capabilities').instanceId,
          supervisorGeneration: supervisor.getStatus().generation, identity: supervisor.getStatus().identity },
        scope: 'Single production bundle/React/picker -> live loopback HTTP/__chatws/Proxy -> actual managed Gateway/adapter -> actual Service global binding/current read Grant -> actual credentialless MCP stdio child -> model -> final; deterministic local model and synthetic local Issues only',
        accountsUsed: false, installedAppAcceptance: false, fullCodexSecurityScanner: false };
    } catch(error) {
      fs.writeFileSync(path.join(output, 'joint-failure.json'), JSON.stringify({ error: error.stack, childOutput, childError,
        observed, serviceEvents: context.serviceEvents, modelRequests: context.modelCalls.length }, null, 2)); throw error;
    } finally {
      if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(4000)]); }
      await web?.close(); WebSocket.prototype.send = originalSend; backend.getPluginSelectionReadiness = originalReadiness;
    }
  } });
  for (const processId of new Set(result.business.calls.map(call => call.processId))) {
    await delay(50);
    assert.throws(() => process.kill(processId, 0), { code: 'ESRCH' }, 'Service cleanup must terminate its owned MCP child');
  }
  assert.deepEqual(sourceHashes(), startedHashes, 'loaded product sources changed during joint proof; rerun stable versions');
  assert.equal(manager.getCandidate('openclaw').runtimeTreeSha256, candidate.runtimeTreeSha256);
  const evidence = { version: 1, date: '2026-09-28', ...result, runtimeTreeSha256: candidate.runtimeTreeSha256,
    codeHashes: startedHashes, buildHashes, cleanup: 'owned Gateway and MCP subprocess confirmed absent; shared immutable candidate retained; isolated Service/auth state removed' };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: result.ui.checks.length, modelRequests: result.modelRequests,
    selectedSends: result.selectedSends.length, output: path.join(output, 'report.json') }));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
