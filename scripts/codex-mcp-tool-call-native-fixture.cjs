#!/usr/bin/env node
'use strict';
// Real pinned Codex app-server -> real local MCP stdio. No model, login,
// Security launcher, Service RPC, renderer transport or ambient daemon.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { CodexRuntimeHost, defaultKillProcessGroup } = require('../app/agent-service/codex-runtime-host');
const { CodexSchemaContract } = require('../app/agent-service/codex-schema-contract');
const { RuntimeAccountResolver, defaultRuntimeAccountLookup } = require('../app/agent-service/runtime-account-resolver');
const { resolveServicePaths } = require('../app/agent-service/paths');
const REPO = path.resolve(__dirname, '..');
const EXPECTED_BINARY_SHA = '16593cc2f422d5f398a8e40f550ebbaf1245392528957be342c295920a300704';
const SOURCE_FILES = [
  'app/agent-service/codex-schema-contract.js', 'app/agent-service/codex-runtime-host.js',
  'app/agent-service/codex-jsonl-rpc.js', 'app/agent-service/codex-rpc-safety.js',
  'app/agent-service/codex-rpc-write-queue.js', 'app/agent-service/codex-event-normalizer.js',
  'app/agent-service/codex-binary-probe.js', 'app/agent-service/codex-runtime-paths.js',
  'app/agent-service/runtime-account-resolver.js', 'app/agent-service/runtime-account.js',
  'app/agent-service/runtime-adapter.js', 'app/agent-service/paths.js',
  'scripts/codex-mcp-tool-call-native-fixture.cjs', 'scripts/fixtures/codex-mcp-thread-echo.cjs',
  'schemas/codex-app-server/0.159.2/schema-manifest.json',
  'schemas/codex-app-server/0.159.2/json/codex_app_server_protocol.schemas.json',
  'schemas/codex-app-server/0.159.2/json/codex_app_server_protocol.v2.schemas.json',
];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes = () => Object.fromEntries(SOURCE_FILES.map(file => [file, hash(path.join(REPO, file))]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) { assert.ok(Date.now() < end, `${label} bounded observation expired`); await delay(10); }
}
async function bounded(promise, label, timeoutMs = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
async function main() {
  assert.equal(process.argv.length, 3, 'one fresh /private/tmp evidence output path required');
  const output = process.argv[2];
  assert.ok(path.isAbsolute(output) && path.dirname(output) === '/private/tmp' && !fs.existsSync(output), 'fresh exact private tmp output required');
  const before = hashes(); const checks = [];
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/sgcodex-mcp-native-'));
  fs.chmodSync(root, 0o700);
  const userHome = path.join(root, 'home'); fs.mkdirSync(userHome, { mode: 0o700 });
  const work = path.join(root, 'workspace'); fs.mkdirSync(work, { mode: 0o700 });
  const paths = resolveServicePaths({ homeDir: userHome, userDataRoot: path.join(root, 'app'), cacheRoot: path.join(root, 'cache'), trustedRoot: root });
  const parentEnv = { HOME: userHome, PATH: '/usr/bin:/bin', TMPDIR: root };
  const binding = { runtime: 'codex', runtimeProfileId: 'local-mcp-api', runtimeAccountId: 'shoggoth-internal-codex-default-v1' };
  const environment = new RuntimeAccountResolver({ paths, homedir: userHome, parentEnv, repoRoot: REPO })
    .resolve(binding, defaultRuntimeAccountLookup(binding.runtimeAccountId));
  assert.deepEqual(fs.readdirSync(userHome), []); assert.deepEqual(fs.readdirSync(environment.home), []);
  const binary = environment.binaryPath;
  assert.equal(hash(binary), EXPECTED_BINARY_SHA);
  const version = spawnSync(binary, ['--version'], { cwd: root, env: { ...parentEnv, CODEX_HOME: environment.home }, encoding: 'utf8', timeout: 5000 });
  assert.equal(version.status, 0); assert.equal(version.signal, null); assert.match(version.stdout, /^codex-cli 0\.159\.2\s*$/);
  checks.push({ name: 'pinned binary and two empty isolated homes', passed: true });
  let host, child, exitReceipt, closingPromise;
  const outgoing = [], kills = [], diagnostics = [];
  const logFile = path.join(root, 'mcp-events.jsonl');
  const logs = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  let success = false;
  let failure;
  try {
    host = new CodexRuntimeHost({ repoRoot: REPO, paths, runtimeBinding: binding, runtimeEnvironment: environment,
      cwd: work, parentEnv, homedir: userHome, schemaContract: new CodexSchemaContract({ repoRoot: REPO }),
      requestTimeoutMs: 5000, onDiagnostic: item => diagnostics.push(item.code),
      killProcessGroup(pid, signal) { kills.push({ pid, signal }); return defaultKillProcessGroup(pid, signal); },
      spawnProcess(command, args, options) {
        assert.equal(command, binary); assert.equal(options.env.HOME, userHome); assert.equal(options.env.CODEX_HOME, environment.home);
        assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.CODEX_API_KEY, undefined);
        assert.equal(options.env.CHATGPT_ACCESS_TOKEN, undefined); assert.equal(options.env.HTTPS_PROXY, undefined);
        child = spawn(command, args, options);
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (chunk, ...rest) => { const frame = JSON.parse(String(chunk)); outgoing.push({ method: frame.method, id: frame.id }); return write(chunk, ...rest); };
        child.once('exit', (code, signal) => { exitReceipt = { pid: child.pid, code, signal }; });
        closingPromise = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        return child;
      },
    });
    await host.initialize();
    assert.equal(host.runtimeVersion, '0.159.2');
    assert.deepEqual(await host.accountRead({ refreshToken: false }), { account: null, requiresOpenaiAuth: true });
    assert.equal(fs.existsSync(path.join(environment.home, 'auth.json')), false);
    const started = await host.threadStart({ cwd: work, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
      config: { mcp_servers: { local_echo: { command: fs.realpathSync(process.execPath),
        args: [path.join(REPO, 'scripts/fixtures/codex-mcp-thread-echo.cjs'), root],
        env_vars: [], startup_timeout_sec: 5, tool_timeout_sec: 2 } } } });
    const threadId = started.thread.id; assert.equal(typeof threadId, 'string'); assert.ok(threadId.length > 10);
    const status = await host.mcpServerStatusList({ threadId, detail: 'toolsAndAuthOnly', limit: 100 });
    const server = status.data.find(item => item.name === 'local_echo'); assert.ok(server, 'actual per-thread MCP server absent');
    assert.ok(Object.keys(server.tools).some(name => name.endsWith('echo')), 'actual MCP tool enumeration absent');
    checks.push({ name: 'real native thread and per-thread local MCP startup with no account', passed: true, nativeThreadIdSha256: crypto.createHash('sha256').update(threadId).digest('hex'), tools: Object.keys(server.tools).length });
    const params = marker => ({ server: 'local_echo', threadId, tool: 'echo', arguments: { marker } });
    const echo = await host.mcpServerToolCall(params('actual-echo'));
    assert.equal(echo.isError, false); assert.equal(echo.structuredContent.marker, 'actual-echo');
    assert.equal(echo.structuredContent.nativeThreadId, threadId); assert.deepEqual(echo.structuredContent.metaKeys, ['progressToken', 'threadId']);
    assert.deepEqual(JSON.parse(echo.content[0].text), echo.structuredContent);
    const overwritten = await host.mcpServerToolCall({ ...params('native-meta-overwrite'), _meta: { threadId: 'fixture-self-claimed' } });
    assert.equal(overwritten.structuredContent.nativeThreadId, threadId);
    checks.push({ name: 'actual tool result and native processor injects/overwrites canonical threadId', passed: true, modelTurnRequired: false });
    const beforeRejected = logs().filter(item => item.phase === 'call').length;
    const rejected = [];
    for (const [name, values] of [['wrong-server', { ...params('must-not-run-server'), server: 'absent_server' }],
      ['wrong-thread', { ...params('must-not-run-thread'), threadId: '00000000-0000-4000-8000-000000000000' }],
      ['wrong-tool', { ...params('must-not-run-tool'), tool: 'absent_tool' }]]) {
      await assert.rejects(host.mcpServerToolCall(values), error => { assert.equal(error.code, 'RPC_REMOTE_ERROR'); rejected.push({ name, code: error.code, rpcCode: error.rpcCode }); return true; });
    }
    assert.equal(logs().filter(item => item.phase === 'call').length, beforeRejected); assert.equal(host.state, 'ready');
    checks.push({ name: 'native server/thread/tool ownership lookup rejects without echo execution', passed: true, rejected });
    const preAborted = new AbortController(); preAborted.abort(); const beforeAbort = outgoing.length;
    await assert.rejects(host.mcpServerToolCall(params('must-not-run-aborted'), { signal: preAborted.signal }), { code: 'RPC_REQUEST_ABORTED' });
    assert.equal(outgoing.length, beforeAbort);
    checks.push({ name: 'pre-aborted call emits zero native requests', passed: true });
    const controller = new AbortController();
    const pending = host.mcpServerToolCall({ ...params('inflight-abort'), tool: 'delay' }, { signal: controller.signal });
    const abortResult = pending.then(() => { throw new Error('inflight abort unexpectedly accepted'); }, error => error);
    await until(() => logs().some(item => item.phase === 'call' && item.marker === 'inflight-abort'), 'native tool entered before abort');
    controller.abort(); assert.equal((await abortResult).code, 'RPC_REQUEST_ABORTED');
    await until(() => logs().some(item => item.phase === 'responded' && item.marker === 'inflight-abort'), 'actual tool finishes after local abort');
    await delay(30); assert.equal(host.state, 'ready'); assert.equal(host.rpc.pending.size, 0);
    assert.equal(logs().filter(item => item.phase === 'call' && item.marker === 'inflight-abort').length, 1);
    checks.push({ name: 'in-flight abort is local unknown: actual tool still finishes once, late ACK ignored', passed: true, nativeCancellationClaimed: false, automaticReplay: false });
    const timed = host.mcpServerToolCall({ ...params('inflight-timeout'), tool: 'delay' }, { timeoutMs: 50 });
    await assert.rejects(timed, { code: 'RPC_REQUEST_TIMEOUT' });
    await until(() => logs().some(item => item.phase === 'responded' && item.marker === 'inflight-timeout'), 'actual tool finishes after local timeout');
    await delay(30); assert.equal(host.rpc.pending.size, 0); assert.equal(host.state, 'ready');
    assert.equal(logs().filter(item => item.phase === 'call' && item.marker === 'inflight-timeout').length, 1);
    const last = await host.mcpServerToolCall(params('healthy-after-late-replies'));
    assert.equal(last.structuredContent.nativeThreadId, threadId);
    assert.equal(outgoing.filter(item => item.method === 'mcpServer/tool/call').length, 8);
    assert.equal(outgoing.some(item => item.method === 'turn/start' || item.method.startsWith('account/login')), false);
    assert.equal(logs().some(item => item.phase === 'cancel-notification'), false);
    checks.push({ name: 'timeout also remains unknown; late response cannot poison subsequent actual call', passed: true, originalToolDeadlineSeconds: 2, rpcTimeoutMs: 50 });
    // No model turn materializes an archiveable thread. The local synthetic
    // MCP first finishes its own stdio after delivering this final tool result.
    // This is not a scanner-cancel or production Host.stop lifecycle claim.
    const finished = await host.mcpServerToolCall({ ...params('fixture-only-finish'), tool: 'finish' });
    assert.equal(finished.structuredContent.nativeThreadId, threadId);
    await until(() => logs().some(item => item.phase === 'exit' && item.code === 0), 'local MCP natural exit');
    child.stdin.end();
    const closed = await bounded(closingPromise, 'Codex EOF close');
    await host.stop();
    assert.equal(closed.code, 0); assert.equal(closed.signal, null); assert.equal(exitReceipt.code, 0); assert.equal(exitReceipt.signal, null);
    checks.push({ name: 'fixture-only MCP finish and original native app-server stdin EOF both exit naturally', passed: true });
    success = true;
  } catch (error) {
    failure = { code: error.code || 'FIXTURE_ASSERTION_FAILED', message: String(error.message).slice(0, 250) };
  } finally {
    if (!success) { try { await host?.stop(); } catch (error) { failure.cleanupCode = error.code || 'CLEANUP_FAILED'; } }
  }
  const after = hashes(); const frozen = JSON.stringify(before) === JSON.stringify(after);
  const events = logs();
  const echoExits = events.filter(item => item.phase === 'exit').map(item => ({ pid: item.pid, code: item.code }));
  const calls = events.filter(item => item.phase === 'call').map(item => ({ marker: item.marker, tool: item.tool, metaKeys: item.metaKeys }));
  let removed = false;
  if (success && frozen) { fs.rmSync(root, { recursive: true }); removed = !fs.existsSync(root); }
  const evidence = { version: 1, generatedAt: new Date().toISOString(), verified: success && frozen && removed,
    scope: { productionNodeHost: true, pinnedCodexVersion: '0.159.2', binarySha256: EXPECTED_BINARY_SHA,
      realNativeThread: true, realLocalMcpTool: true, serviceApiExposed: false, rendererExecuted: false,
      modelTurnExecuted: false, authenticated: false, originalSecurityPluginExecuted: false, fullPluginUsable: false },
    checkCount: checks.length, checks, nativeProcesses: { version: { code: version.status, signal: version.signal }, appServer: exitReceipt || null, echoExits },
    nativeRequests: outgoing.map(item => item.method), echoCalls: calls, nativeKillAttempts: kills,
    sourceHashesBefore: before, sourceHashesAfter: after, sourceHashesStable: frozen,
    cleanup: { exactFixtureRoot: root, removed, retainedForFailure: !removed }, diagnostics, ...(failure ? { failure } : {}) };
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  assert.equal(evidence.verified, true, `native bridge fixture failed: ${failure?.code || 'SOURCE_OR_CLEANUP_FAILURE'}`);
  console.log(JSON.stringify({ verified: true, checks: checks.length, nativeExit: exitReceipt, echoExits, output, sourceHashesStable: frozen, exactFixtureRootRemoved: removed }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
