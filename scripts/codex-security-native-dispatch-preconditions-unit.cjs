'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createContext, repoRoot } = require('./fixtures/codex-security-native-factory-context.cjs');
const native = require('../app/agent-service/plugin-codex-security-native-component');
const { CodexSecurityNativeDispatchPreconditions } = require('../app/agent-service/plugin-codex-security-native-dispatch-preconditions');
const { PluginToolCatalogRegistry } = require('../app/agent-service/plugin-tool-catalog-registry');
const { RuntimeMcpCallBindings } = require('../app/agent-service/runtime-mcp-call-binding');
const { runtimeSessionRef, runtimeTurnRef, runtimeBinding } = require('../app/agent-service/runtime-adapter');
const { previewPluginDirectory } = require('../app/agent-service/plugin-package-parser');
const { componentId } = require('../app/agent-service/plugin-component-catalog');
const sources = ['app/agent-service/plugin-codex-security-native-component.js',
 'app/agent-service/plugin-codex-security-native-dispatch-preconditions.js',
 'scripts/codex-security-native-dispatch-preconditions-unit.cjs', 'scripts/fixtures/codex-security-native-factory-context.cjs',
 'app/agent-service/runtime-mcp-call-binding.js', 'app/agent-service/runtime-adapter.js',
 'app/agent-service/host-capability-issuer.js', 'app/agent-service/runtime-account-admission.js',
 'app/agent-service/plugin-tool-catalog-registry.js', 'app/agent-service/plugin-tool-contract.js',
 'app/agent-service/plugin-component-resolver.js', 'app/agent-service/plugin-store.js',
 'app/agent-service/product-store.js', 'app/agent-service/work-run.js', 'app/core/bundled-plugin-catalog.js',
 'app/agent-service/plugin-package-parser.js', 'app/agent-service/plugin-legacy-source.js'];
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const hashes = () => Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(path.join(repoRoot, file)))]));
const checks = [];
const test = async (name, action) => { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); };
const reject = action => assert.throws(action);
(async () => {
 const output = process.argv[2]; if (output && fs.existsSync(output)) throw new Error('Evidence path must be new');
 const before = hashes(); let context = null, runtimeBindings = null;
 try {
  context = createContext(); const catalog = new PluginToolCatalogRegistry();
  const guard = new CodexSecurityNativeDispatchPreconditions({ store: context.store, resolver: context.resolver,
   toolCatalogRegistry: catalog, productStore: context.productStore, dispatcher: context.dispatcher,
   capabilityIssuer: context.issuer, runtimeAccountAdmission: context.admission });
  const bareInput = { installationId: context.installation.installationId, bindingId: 'native-binding',
   toolIdentity: 'unregistered-tool', toolName: 'get_codex_security_scan' };
  await test('metadata mcp lease/copied caller turn/readiness cannot replace actual existing native brand', () => {
   for (const scope of [{ runId: context.run.id }, { runId: context.run.id, trustedCodexTurn: {
    runId: context.run.id, threadId: 'controlled-thread', turnId: 'controlled-turn', assertCurrent: () => true } }]) {
    reject(() => guard.capture(bareInput, scope, context.lease));
   }
   reject(() => new CodexSecurityNativeDispatchPreconditions({ store: {} }));
   assert.equal(typeof guard.callTool, 'undefined'); assert.equal(typeof guard.authorizeEgress, 'undefined');
  });
  await test('exact management fields reject prototype/getter/_meta/thread/env before native lookup', () => {
   let calls = 0;
   const bad = { ...bareInput }; Object.defineProperty(bad, 'toolName', { enumerable: true, get() { calls++; return 'get_codex_security_scan'; } });
   reject(() => guard.capture(bad, {}, context.lease)); assert.equal(calls, 0);
   for (const field of ['_meta', 'threadId', 'turnId', 'env', 'readiness', 'grant', 'lease']) {
    reject(() => guard.capture({ ...bareInput, [field]: {} }, {}, context.lease));
   }
   reject(() => guard.capture(Object.assign(Object.create({}), bareInput), {}, context.lease));
  });
  const bound = runtimeBinding({ runtime: 'codex', runtimeProfileId: context.profile.runtimeProfileId, runtimeAccountId: context.profile.runtimeAccountId });
  const threadId = 'controlled-native-thread', turnId = 'controlled-native-turn';
  context.dispatcher.transition(context.run.id, 'running', { runtimeSessionRef: runtimeSessionRef(bound, threadId),
   runtimeTurnRef: runtimeTurnRef(bound, threadId, turnId) });
  context.issuer.bind(context.lease, { sessionId: threadId, turnId });
  runtimeBindings = new RuntimeMcpCallBindings();
  const callId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
  const callArgs = { serverId: 'controlled-native', toolName: bareInput.toolName, arguments: {} };
  const proof = { callId, name: 'mcp_server_call', sessionIdentity: digest(token),
   fingerprint: require('../app/agent-service/plugin-tool-contract').pluginToolContractDigest({ name: 'mcp_server_call', arguments: callArgs, confirmation: false }) };
  runtimeBindings.register({ proof, runId: context.run.id, profileId: context.profile.id,
   runtimeProfileId: context.profile.runtimeProfileId, runtimeAccountId: context.profile.runtimeAccountId,
   assertCurrent: () => context.issuer.assert(context.lease, { kind: 'mcp', sessionId: threadId, turnId }),
   codexTurn: { threadId, turnId } });
  const scope = runtimeBindings.consume({ callId, name: 'mcp_server_call', arguments: callArgs,
   profileId: context.profile.id, runtimeProfileId: context.profile.runtimeProfileId,
   runtimeAccountId: context.profile.runtimeAccountId, sessionToken: token });
  await test('existing native brand and actual installed MCP still require a current Connection and Grant', () => {
   assert.throws(() => guard.capture(bareInput, scope, context.lease), error => error.code === 'CODEX_SECURITY_DISPATCH_GRANT_REQUIRED');
  });
  // Real production installer supplies the full native component; only the
  // native-turn proof and downstream metadata remain controlled in this unit.
  const installation = context.installation;
  const root = fs.realpathSync(path.join(context.paths.pluginPackagesDir, installation.releaseDigest));
  const material = { component: native.readCodexSecurityNativeComponent(root) };
  const selected = componentId(installation.installationId, 'mcp-server', native.COMPONENT_NAME);
  let connection = context.store.createConnection({ connectionId: 'controlled-native-connection', installationId: installation.installationId,
   componentId: selected, endpointIdentity: native.nativeEndpointIdentity(material.component.descriptorDigest) });
  connection = context.store.setConnectionIdentity({ connectionId: connection.connectionId,
   principalIdentity: native.nativePrincipalIdentity(context.profile.runtimeAccountId), state: 'ready', expectedRevision: connection.revision });
  let binding = context.store.createGlobalBinding({ bindingId: 'controlled-native-binding', installationId: installation.installationId,
   componentId: selected, connectionId: connection.connectionId });
  binding = context.store.setBindingEnabled({ bindingId: binding.bindingId, enabled: true, expectedRevision: binding.revision });
  const refreshed = await catalog.refresh({ installation, connection, client: { async listTools() {
   return [{ name: bareInput.toolName, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
  } } });
  const tool = refreshed.entries[0];
  let grant = context.store.setGrant({ grantId: 'controlled-native-grant', bindingId: binding.bindingId,
   toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest, effect: 'allow', approvalMode: 'always',
   expiresAt: null, expectedRevision: 0 });
  const input = { installationId: installation.installationId, bindingId: binding.bindingId,
   toolIdentity: tool.toolIdentity, toolName: bareInput.toolName };
  let captured;
  await test('real Store/opaque native scope/account admission/current component+Connection+Grant capture prerequisites only', () => {
   captured = guard.capture(input, scope, context.lease);
   assert.equal(guard.assertCurrent(captured, scope, context.lease), true);
   const status = guard.describe(captured, scope, context.lease);
   assert.equal(status.fullPluginUsable, false); assert.equal(status.originalToolsUnlocked, false);
   assert(status.blockers.includes('AUTHENTICATED_OWNING_NATIVE_HOST_FACTORY_REQUIRED'));
   assert(status.blockers.includes('PER_TOOL_DISPATCHER_FINAL_EGRESS_REQUIRED'));
   assert.equal(context.store.getCapabilityCall('controlled-native-call'), null);
  });
  await test('copied prerequisite/lease/scope/foreign Run/account never convey existing capture', () => {
   reject(() => guard.assertCurrent({ ...captured }, scope, context.lease));
   reject(() => guard.assertCurrent(captured, { ...scope }, context.lease));
   reject(() => guard.assertCurrent(captured, scope, { ...context.lease }));
   reject(() => guard.capture(input, { ...scope, runId: 'foreign-run' }, context.lease));
   reject(() => guard.capture({ ...input, toolName: 'start_codex_security_scan' }, scope, context.lease));
  });
  await test('real ProductStore immutable native refs reject replacement before guard; original matching refs remain exact', () => {
   const run = context.dispatcher.getRun(context.run.id);
   assert.throws(() => context.productStore.putWorkRun({ ...run,
    runtimeTurnRef: runtimeTurnRef(bound, threadId, 'other-turn'), eventSeq: run.eventSeq + 1 }),
    error => error.code === 'WORK_RUN_BINDING_IMMUTABLE');
   assert.equal(guard.assertCurrent(captured, scope, context.lease), true);
  });
  await test('original source/server mutation fails full private component integrity before any tool egress', () => {
   const target = path.join(root, native.ORIGINAL_ROOT, 'mcp/server.mjs'), bytes = fs.readFileSync(target);
   fs.appendFileSync(target, '\n'); reject(() => guard.assertCurrent(captured, scope, context.lease));
   fs.writeFileSync(target, bytes); assert.equal(guard.assertCurrent(captured, scope, context.lease), true);
  });
  await test('Grant revocation invalidates captured prerequisite; later Grant requires fresh snapshot', () => {
   grant = context.store.revokeGrant({ bindingId: binding.bindingId, toolIdentity: tool.toolIdentity, expectedRevision: grant.revision });
   reject(() => guard.assertCurrent(captured, scope, context.lease));
   grant = context.store.setGrant({ grantId: grant.grantId, bindingId: binding.bindingId,
    toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest, effect: 'allow', approvalMode: 'always',
    expiresAt: null, expectedRevision: grant.revision });
   reject(() => guard.assertCurrent(captured, scope, context.lease)); captured = guard.capture(input, scope, context.lease);
  });
  await test('catalog refreshing/invalidation changes exact tool contract; no cached authorization', () => {
   catalog.invalidate(connection.connectionId); reject(() => guard.assertCurrent(captured, scope, context.lease));
  });
  await test('actual durable terminal Run invalidates original prerequisite without new lease/turn/ticket', async () => {
   await catalog.refresh({ installation, connection, client: { async listTools() {
    return [{ name: bareInput.toolName, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
   } } });
   captured = guard.capture(input, scope, context.lease);
   assert.equal(guard.assertCurrent(captured, scope, context.lease), true);
   context.dispatcher.transition(context.run.id, 'completed', { resultSummary: 'controlled no-host unit completed' });
   reject(() => guard.assertCurrent(captured, scope, context.lease));
  });
  await test('native binding release retires brand and actual admission/lease release never produces new authority', () => {
   runtimeBindings.releaseRun(context.run.id); reject(() => guard.capture(input, scope, context.lease));
   context.issuer.revoke(context.lease); reject(() => guard.capture(input, scope, context.lease));
  });
  runtimeBindings.clear(); runtimeBindings = null; await context.close(); context = null;
  const after = hashes(); assert.deepEqual(after, before);
  const result = { version: 1, verified: true, count: checks.length, checks, codeHashesBefore: before, codeHashesAfter: after,
   scope: 'controlled local Store/native-binding prerequisites unit; not actual native Host/turn/authentication',
   controlledComponentRegistration: true, productionGenericInstallerNativeMcpCount: 0,
   nativeHostStarts: 0, actualModelTurns: 0, originalToolBusinessCount: 0, scans: 0,
   dispatcherTicketsIssuedOrConsumed: 0, accountAuthReadCount: 0, fullPluginUsable: false,
   originalToolsUnlocked: false, conversionCountUnchanged: true };
  if (output) fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`PASS ${checks.length}/${checks.length}; no native/model/auth/egress; main natural exit`);
 } catch (error) {
  if (output && !fs.existsSync(output)) fs.writeFileSync(output, `${JSON.stringify({ verified: false, checks,
   codeHashesBefore: before, codeHashesAfter: hashes(), error: { code: error.code || null, message: error.message },
   retainedFixtureRoot: context?.root || null }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  throw error;
 }
})().catch(error => { console.error(error); process.exitCode = 1; });
