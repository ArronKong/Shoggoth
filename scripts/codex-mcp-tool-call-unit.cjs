#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { CodexSchemaContract } = require('../app/agent-service/codex-schema-contract');
const { CodexRuntimeHost } = require('../app/agent-service/codex-runtime-host');
const { CodexJsonlRpcClient } = require('../app/agent-service/codex-jsonl-rpc');
const { RuntimeAccountResolver, defaultRuntimeAccountLookup } = require('../app/agent-service/runtime-account-resolver');
const { resolveServicePaths } = require('../app/agent-service/paths');
const REPO = path.resolve(__dirname, '..');
const PARAMS = { server: 'local-fixture', threadId: 'thread-owned', tool: 'echo', arguments: { marker: 'unit' } };
function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/codex-mcp-boundary-');
  const paths = resolveServicePaths({ homeDir: root, userDataRoot: path.join(root, 'app'), cacheRoot: path.join(root, 'cache'), trustedRoot: root });
  const parentEnv = { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root };
  const binding = { runtime: 'codex', runtimeProfileId: 'mcp-call-unit', runtimeAccountId: 'shoggoth-internal-codex-default-v1' };
  const runtimeEnvironment = new RuntimeAccountResolver({ paths, homedir: root, parentEnv, repoRoot: REPO })
    .resolve(binding, defaultRuntimeAccountLookup(binding.runtimeAccountId));
  const host = new CodexRuntimeHost({ repoRoot: REPO, runtimeBinding: binding, runtimeEnvironment, parentEnv });
  const frames = [];
  const child = new EventEmitter();
  child.stdin = new Writable({ write(chunk, _encoding, done) { frames.push(JSON.parse(String(chunk))); done(); } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const rpc = new CodexJsonlRpcClient(child, { requestTimeoutMs: 1000 });
  // This boundary unit has no process or model. The native fixture separately
  // proves authenticated protocol initialization with the actual pinned binary.
  host.state = 'ready'; host.rpc = rpc;
  const respond = (id, result, error) => child.stdout.write(JSON.stringify({ id, ...(error ? { error } : { result }) }) + '\n');
  t.after(async () => { await host.stop(); child.stdout.destroy(); child.stderr.destroy(); fs.rmSync(root, { recursive: true }); });
  return { host, rpc, frames, respond };
}
async function waitFor(predicate) {
  const until = Date.now() + 1000;
  while (!predicate()) { assert.ok(Date.now() < until, 'bounded frame observation expired'); await new Promise(resolve => setTimeout(resolve, 1)); }
}
test('pinned non-experimental schema maps the direct native MCP API', () => {
  const schema = new CodexSchemaContract({ repoRoot: REPO });
  assert.equal(schema.version, '0.159.2');
  assert.equal(schema.operations.mcpServerToolCall.method, 'mcpServer/tool/call');
  schema.validateParams('mcpServerToolCall', PARAMS);
  schema.validateResponse('mcpServerToolCall', { content: [], isError: false, structuredContent: { marker: 'unit' } });
});
test('bad required or typed parameters reject before any outbound frame', async t => {
  const f = fixture(t);
  for (const params of [null, { ...PARAMS, server: null }, { ...PARAMS, threadId: 3 }, { server: 'fixture', threadId: 't' }]) {
    await assert.rejects(f.host.mcpServerToolCall(params), { code: 'CODEX_SCHEMA_ERROR' });
  }
  assert.equal(f.frames.length, 0);
});
test('direct tool result content, structured data and MCP error flag preserve the native response', async t => {
  const f = fixture(t);
  const pending = f.host.mcpServerToolCall(PARAMS);
  await waitFor(() => f.frames.length === 1);
  assert.deepEqual(f.frames[0].params, PARAMS);
  assert.equal(f.frames[0].method, 'mcpServer/tool/call');
  const response = { content: [{ type: 'text', text: 'tool rejected input' }], isError: true, structuredContent: { marker: 'unit' }, _meta: { fixture: true } };
  f.respond(f.frames[0].id, response);
  assert.deepEqual(await pending, response);
  assert.equal(f.host.state, 'ready');
});
test('invalid native MCP response fails the Host protocol and closes the client', async t => {
  const f = fixture(t);
  const pending = f.host.mcpServerToolCall(PARAMS);
  await waitFor(() => f.frames.length === 1);
  f.respond(f.frames[0].id, { content: 'bad-array' });
  await assert.rejects(pending, { code: 'CODEX_SCHEMA_ERROR' });
  assert.equal(f.host.state, 'failed'); assert.equal(f.rpc.ended, true);
  await assert.rejects(f.host.terminated, { code: 'CODEX_SCHEMA_ERROR' });
});
test('pre-abort is unsent; in-flight abort retires only the local request without replay or native cancel', async t => {
  const f = fixture(t);
  const before = new AbortController(); before.abort();
  await assert.rejects(f.host.mcpServerToolCall(PARAMS, { signal: before.signal }), { code: 'RPC_REQUEST_ABORTED' });
  assert.equal(f.frames.length, 0);
  const current = new AbortController();
  const pending = f.host.mcpServerToolCall(PARAMS, { signal: current.signal });
  await waitFor(() => f.frames.length === 1); current.abort();
  await assert.rejects(pending, { code: 'RPC_REQUEST_ABORTED' });
  f.respond(f.frames[0].id, { content: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.frames.length, 1); assert.equal(f.rpc.pending.size, 0); assert.equal(f.host.state, 'ready');
  const next = f.host.mcpServerToolCall(PARAMS);
  await waitFor(() => f.frames.length === 2);
  f.respond(f.frames[1].id, { content: [] }); await next;
});
test('explicit timeout retires the original request and ignores its late response', async t => {
  const f = fixture(t);
  const pending = f.host.mcpServerToolCall(PARAMS, { timeoutMs: 15 });
  await assert.rejects(pending, { code: 'RPC_REQUEST_TIMEOUT' });
  assert.equal(f.frames.length, 1); assert.equal(f.rpc.pending.size, 0);
  f.respond(f.frames[0].id, { content: [] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.host.state, 'ready'); assert.equal(f.frames.length, 1);
});
test('per-call original 97-hour deadline is forwarded without substituting a shorter MCP client', async t => {
  const f = fixture(t); const observed = [];
  const real = f.host.rpc;
  f.host.rpc = { request: async (method, params, options) => { observed.push({ method, params, options }); return { content: [] }; }, terminate: () => real.terminate() };
  const options = { timeoutMs: 349200000, signal: new AbortController().signal };
  await f.host.mcpServerToolCall(PARAMS, options);
  assert.strictEqual(observed[0].options, options);
  assert.equal(observed[0].options.timeoutMs, 349200000);
});
