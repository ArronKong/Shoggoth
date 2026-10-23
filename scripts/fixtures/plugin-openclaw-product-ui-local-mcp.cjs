'use strict';
// Local-only synthetic business service. This file is copied into a private
// plugin release and executed by the real Service MCP stdio connection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { pluginServerId } = require('../../app/agent-service/plugin-runtime-tool-service');
const MARKER = 'SHOGGOTH_LOCAL_READ_ISSUE';
const TOOL = Object.freeze({ name: 'read_fixture_issue', description: 'Read one synthetic local fixture Issue',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { issueId: { type: 'string', enum: ['fixture-001', 'fixture-002'] } }, required: ['issueId'] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
const ISSUES = Object.freeze({
  'fixture-001': Object.freeze({ id: 'fixture-001', title: 'Fixture issue one', state: 'open' }),
  'fixture-002': Object.freeze({ id: 'fixture-002', title: 'Fixture issue two', state: 'closed' }),
});
function runLocalMcp() {
  const input = readline.createInterface({ input: process.stdin });
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  input.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { process.exitCode = 1; input.close(); return; }
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
    if (message.method === 'initialize') return reply(message.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} },
      serverInfo: { name: 'shoggoth-local-read-issue-fixture', version: '1' } });
    if (message.method === 'tools/list') return reply(message.id, { tools: [TOOL] });
    if (message.method === 'tools/call') {
      const args = message.params?.arguments;
      if (message.params?.name !== TOOL.name || !args || Object.keys(args).length !== 1
        || !Object.hasOwn(ISSUES, args.issueId)) return reply(message.id, { content: [{ type: 'text', text: 'Invalid fixture input' }], isError: true });
      const issue = ISSUES[args.issueId];
      return reply(message.id, { content: [{ type: 'text', text: `${MARKER} ${issue.id}: ${issue.title}` }],
        structuredContent: { marker: MARKER, issue, executingProcessId: process.pid }, isError: false });
    }
    if (Object.hasOwn(message, 'id')) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      error: { code: -32601, message: 'Method not found' } }) + '\n');
  });
  process.stdout.on('error', () => process.exit(0));
}
function prepareSource(source) {
  // The child is standalone: it has no product imports, network or user-data IO.
  const original = fs.readFileSync(__filename, 'utf8');
  const child = "#!" + process.execPath + '\n' + original.slice(original.indexOf("const MARKER"), original.indexOf('\nfunction prepareSource'))
    .replace('function runLocalMcp() {', "const readline = require('node:readline');\nfunction runLocalMcp() {") + '\nrunLocalMcp();\n';
  const bin = path.join(source, 'bin/issue-fixture');
  fs.writeFileSync(bin, child, { mode: 0o700 }); fs.chmodSync(bin, 0o700);
  fs.writeFileSync(path.join(source, 'mcp.json'), JSON.stringify({ '$schema': 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {
    'local-issues': { type: 'stdio', command: './bin/issue-fixture', args: [], cwd: '${PLUGIN_ROOT}' },
  } }, null, 2) + '\n');
}
async function connectAndGrant({ service, backend, installation }) {
  const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
  assert.ok(profile, 'real isolated native Profile is required to configure shared settings');
  backend._profilesByAgent.set(profile.agentId, profile);
  const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
  const item = page.items.find(row => row.installationId === installation.installationId);
  const component = item?.components.find(row => row.localName === 'local-issues'); assert.ok(component);
  const prepared = await backend.preparePluginMcpConsent({ action: 'connect', agentId: profile.agentId,
    installationId: item.installationId, componentId: component.componentId,
    expectedRevision: installation.revision, operationId: 'joint-ui-local-mcp-connect' });
  const connected = await backend.commitPluginMcpConsent({ challenge: prepared.challenge, approved: true });
  assert.equal(connected.canceled, false); const bindingId = connected.receipt.bindingId;
  await backend.discoverPluginMcpTools(profile.agentId, bindingId);
  const catalog = await backend.getPluginMcpTools(profile.agentId, bindingId);
  assert.equal(catalog.available, true);
  const tool = catalog.items.find(row => row.name === TOOL.name); assert.ok(tool); assert.equal(tool.savedGrant, null);
  const grant = await backend.preparePluginMcpConsent({ action: 'allow', agentId: profile.agentId, bindingId,
    toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest, catalogRevision: catalog.catalogRevision,
    approvalMode: 'always', expectedRevision: 0, operationId: 'joint-ui-local-read-grant' });
  const committed = await backend.commitPluginMcpConsent({ challenge: grant.challenge, approved: true }); assert.equal(committed.canceled, false);
  const current = (await backend.getPluginMcpTools(profile.agentId, bindingId)).items.find(row => row.name === TOOL.name);
  assert.equal(current.savedGrant.effect, 'allow'); assert.equal(current.savedGrant.approvalMode, 'always');
  assert.equal(current.savedGrant.matchesCurrentContract, true); assert.equal(current.savedGrant.expired, false);
  assert.ok(service.pluginStore.listGlobalBindings().some(binding => binding.bindingId === bindingId), 'the real MCP binding must belong to the Shoggoth public catalog');
  const records = service.pluginStore.getCapabilityRecords(bindingId, tool.toolIdentity);
  assert.equal(records.connection.state, 'ready'); assert.equal(records.binding.enabled, true);
  assert.equal(records.binding.installationId, installation.installationId);
  assert.equal(records.grant.contractDigest, tool.contractDigest);
  return { marker: MARKER, serverId: pluginServerId(bindingId), toolName: TOOL.name,
    bindingId, toolIdentity: tool.toolIdentity, connectionId: records.connection.connectionId,
    contractDigest: tool.contractDigest, grantRevision: current.savedGrant.revision,
    releaseDigest: records.installation.activeReleaseDigest };
}
module.exports = { MARKER, TOOL, prepareSource, connectAndGrant };
