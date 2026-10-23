#!/usr/bin/env node
'use strict';
// Credentialless echo child for the native API fixture. Its only file writes
// are to the exact mkdtemp log passed by that fixture; no network or model API.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = fs.realpathSync(process.argv[2]);
const logFile = path.join(root, 'mcp-events.jsonl');
if (!root.startsWith('/private/tmp/sgcodex-mcp-native-') || !fs.lstatSync(root).isDirectory()
  || (fs.statSync(root).mode & 0o777) !== 0o700 || fs.statSync(root).uid !== process.getuid()) throw new Error('private fixture root required');
const log = item => fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...item }) + '\n', { mode: 0o600 });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const error = (id, code) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'fixture protocol rejected' } }) + '\n');
const tools = ['echo', 'delay', 'finish'].map(name => ({ name, description: 'Read-only synthetic local echo',
  inputSchema: { type: 'object', additionalProperties: false, properties: { marker: { type: 'string' } }, required: ['marker'] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
const input = readline.createInterface({ input: process.stdin });
log({ phase: 'started' });
input.on('line', line => {
  let request; try { request = JSON.parse(line); } catch { process.exitCode = 1; input.close(); return; }
  if (request.method === 'initialize') return reply(request.id, { protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'native-thread-local-echo', version: '1' } });
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'notifications/cancelled') { log({ phase: 'cancel-notification' }); return; }
  if (request.method === 'tools/list') return reply(request.id, { tools });
  if (request.method === 'tools/call') {
    const params = request.params;
    if (!['echo', 'delay', 'finish'].includes(params?.name) || typeof params.arguments?.marker !== 'string'
      || Object.keys(params.arguments).length !== 1) return error(request.id, -32602);
    const summary = { marker: params.arguments.marker, nativeThreadId: params._meta?.threadId ?? null,
      metaKeys: Object.keys(params._meta || {}).sort() };
    log({ phase: 'call', tool: params.name, requestId: request.id, ...summary });
    const finish = () => { log({ phase: 'responded', marker: summary.marker, requestId: request.id });
      reply(request.id, { content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: summary, isError: false });
      // Fixture-only graceful shutdown after the actual final tool result. This
      // is not a scanner cancel implementation or a production Host.stop claim.
      if (params.name === 'finish') setImmediate(() => { input.close(); process.stdin.destroy(); }); };
    if (params.name === 'delay') setTimeout(finish, 300); else finish();
    return;
  }
  if (Object.hasOwn(request, 'id')) error(request.id, -32601);
});
input.once('close', () => log({ phase: 'stdin-eof' }));
process.once('exit', code => log({ phase: 'exit', code }));
