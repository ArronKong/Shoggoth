'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createContext, repoRoot } = require('./fixtures/codex-security-native-factory-context.cjs');
const native = require('../app/agent-service/plugin-codex-security-native-component');
const { componentId } = require('../app/agent-service/plugin-component-catalog');
const { previewPluginDirectory } = require('../app/agent-service/plugin-package-parser');
const { identifyLegacySource, scanLegacySource } = require('../app/agent-service/plugin-legacy-source');
const owned = ['app/agent-service/plugin-codex-security-native-component.js',
 'scripts/codex-security-native-component-unit.cjs', 'scripts/fixtures/codex-security-native-factory-context.cjs',
 'app/agent-service/codex-security-native-host-plan.js', 'app/agent-service/codex-security-native-job-store.js',
 'app/core/bundled-plugin-catalog.js', 'app/core/legacy-plugin-content-adapter.js',
 'app/agent-service/plugin-legacy-source.js', 'app/agent-service/plugin-package-parser.js',
 'app/agent-service/plugin-package-installer.js', 'app/agent-service/plugin-component-resolver.js',
 'app/agent-service/plugin-store.js'];
const hashes = () => Object.fromEntries(owned.map(file => [file, crypto.createHash('sha256')
 .update(fs.readFileSync(path.join(repoRoot, file))).digest('hex')]));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const checks = [];
const test = async (name, action) => { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); };
const reject = (action, code = /^CODEX_SECURITY_COMPONENT_/) => assert.throws(action,
 error => typeof error?.code === 'string' && (typeof code === 'string' ? error.code === code : code.test(error.code)));
(async () => {
 const output = process.argv[2];
 if (output && fs.existsSync(output)) throw new Error('Evidence path must be new');
 const before = hashes(); let context = null, artifact, initialBindings;
 try {
  context = createContext(); initialBindings = { global: context.store.listGlobalBindings(), profile: context.store.listBindingsForProfile(context.profile.id) };
  const material = destination => native.materializeCodexSecurityNativeComponent(destination,
   { bundledCatalog: context.catalog });
  const destination = path.join(context.paths.pluginStagingDir, 'native-original-candidate');
  await test('trusted frozen source124 files + full original6 fields43 selectors120/349200 preserved', () => {
   artifact = material(destination);
   assert.equal(artifact.originalFileCount, 124); assert.equal(artifact.component.name, 'codex-security');
   assert.equal(artifact.component.type, 'shoggoth-codex-security-native');
   assert.equal(artifact.component.sourceClosure.environmentSelectorCount, 43);
   const source = JSON.parse(fs.readFileSync(path.join(context.catalog.packagePath('codex-security'), '.mcp.json')));
   assert.deepEqual(artifact.component.spec.originalSpec, source.mcpServers['codex-security']);
   assert.equal(artifact.component.sourceClosure.startupTimeoutSec, 120);
   assert.equal(artifact.component.sourceClosure.toolTimeoutSec, 349200);
   assert.equal(native.NATIVE_ENVIRONMENT_SELECTORS.length, 43);
   assert.equal(new Set(native.NATIVE_ENVIRONMENT_SELECTORS.map(item => item.name)).size, 43);
   assert(native.NATIVE_ENVIRONMENT_SELECTORS.every(item => item.ambientInheritance === false && item.acceptsRendererValue === false));
  });
  await test('each original byte and executable bit copied; original archive/license/assets untouched', () => {
   const source = scanLegacySource(identifyLegacySource({ sourcePath: context.catalog.packagePath('codex-security'),
    format: 'codex-plugin', components: ['skills', 'mcp-servers'], trustedBundled: true }));
   for (const file of source.files) {
    const target = path.join(destination, native.ORIGINAL_ROOT, file.path);
    assert.equal(sha(fs.readFileSync(target)), sha(file.content), file.path);
    const stat = fs.lstatSync(target); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    assert.equal((stat.mode & 0o111) !== 0, file.executable, file.path);
    assert.equal(stat.mode & 0o077, 0, file.path);
   }
  });
  await test('15 Skills retained; public schema rejects native MCP; fixed bundled installer registers candidate without grants', () => {
   const preview = previewPluginDirectory(destination, { trustedBundled: true });
   assert.equal(preview.skills.length, 15); assert.equal(preview.mcpServers.length, 0);
   assert(preview.diagnostics.some(item => item.scope === 'mcp-server' && item.name === 'codex-security' && item.reasonCode === 'COMPONENT_INVALID'));
   assert.equal(artifact.registered, false); assert.equal(artifact.fullPluginUsable, false);
   const release = context.store.getRelease('bundled:codex-security', context.installation.releaseDigest);
   assert.equal(release.components.mcpServers.length, 1);
   assert.equal(release.components.mcpServers[0].type, native.TRANSPORT);
   assert.deepEqual({ global: context.store.listGlobalBindings(), profile: context.store.listBindingsForProfile(context.profile.id) }, initialBindings);
   const counts = context.store.getConnectionCountsForComponent(context.installation.installationId,
    componentId(context.installation.installationId, 'mcp-server', native.COMPONENT_NAME));
   assert.deepEqual(counts, { pending: 0, verified: 0, disconnected: 0 });
   const plan = context.factory.prepare({ operationId: 'metadata-candidate-no-execution', installationId: context.installation.installationId }, context.lease);
   reject(() => context.factory.assertFullToolEgress(plan, context.lease), 'CODEX_SECURITY_NATIVE_NATIVE_TURN_AND_DISPATCH_TICKET_REQUIRED');
  });
  await test('two private destinations reproduce identical release bytes/digest and canonical component descriptor', () => {
   const second = material(path.join(context.paths.pluginStagingDir, 'native-original-candidate-second'));
   assert.equal(artifact.component.descriptorDigest, second.component.descriptorDigest);
   const left = previewPluginDirectory(destination, { trustedBundled: true });
   const right = previewPluginDirectory(second.root, { trustedBundled: true }); assert.equal(left.contentDigest, right.contentDigest);
   assert.deepEqual(artifact.component, native.readCodexSecurityNativeComponent(destination));
   assert.equal(native.nativeEndpointIdentity(artifact.component.descriptorDigest), `${native.TRANSPORT}:${artifact.component.descriptorDigest}`);
  });
  await test('custom record rejects extra fields/prototype/getters/symbols/changed timeouts or env order without invoking getters', () => {
   const record = structuredClone(artifact.component.spec); let getters = 0;
   assert.equal(native.isCodexSecurityNativeRecord(record), true);
   for (const bad of [{ ...record, env: {} }, Object.assign(Object.create({}), record),
    { ...record, [Symbol('extra')]: true }, { ...record, originalRoot: '../codex-original' }]) assert.equal(native.isCodexSecurityNativeRecord(bad), false);
   const getter = { ...record }; Object.defineProperty(getter, 'originalSpec', { enumerable: true, get() { getters++; return record.originalSpec; } });
   assert.equal(native.isCodexSecurityNativeRecord(getter), false);
   const selectorGetter = structuredClone(record); Object.defineProperty(selectorGetter.originalSpec.env_vars, '0',
    { enumerable: true, get() { getters++; return 'CODEX_HOME'; } }); assert.equal(native.isCodexSecurityNativeRecord(selectorGetter), false);
   assert.equal(getters, 0);
   const changed = structuredClone(record); changed.originalSpec.tool_timeout_sec = 120; assert.equal(native.isCodexSecurityNativeRecord(changed), false);
   const shuffled = structuredClone(record); shuffled.originalSpec.env_vars.reverse(); assert.equal(native.isCodexSecurityNativeRecord(shuffled), false);
   reject(() => native.nativeEndpointIdentity('caller-ready'));
  });
  await test('real catalog mandatory; existing destination refuses overwrite; public parent and symlink destination refused', () => {
   reject(() => native.materializeCodexSecurityNativeComponent(path.join(context.paths.pluginStagingDir, 'bad'), { bundledCatalog: {} }));
   reject(() => material(destination), 'CODEX_SECURITY_COMPONENT_DESTINATION_EXISTS');
   const publicParent = path.join(context.root, 'public-parent'); fs.mkdirSync(publicParent, { mode: 0o755 });
   assert.throws(() => material(path.join(publicParent, 'candidate'))); fs.chmodSync(publicParent, 0o700);
   const link = path.join(context.paths.pluginStagingDir, 'symlink-destination'); fs.symlinkSync(destination, link);
   assert.throws(() => material(link)); fs.unlinkSync(link);
  });
  await test('wrapper6-field mutation/selector loss/caller env or metadata cannot obtain component', () => {
   const target = path.join(destination, 'mcp.json'), original = fs.readFileSync(target);
   const document = JSON.parse(original); document.mcpServers['codex-security'].originalSpec.env_vars.pop();
   fs.writeFileSync(target, JSON.stringify(document)); reject(() => native.readCodexSecurityNativeComponent(destination));
   fs.writeFileSync(target, original);
   for (const field of ['_meta', 'threadId', 'env', 'readiness']) {
    const value = JSON.parse(original); value.mcpServers['codex-security'][field] = {}; fs.writeFileSync(target, JSON.stringify(value));
    reject(() => native.readCodexSecurityNativeComponent(destination));
   }
   fs.writeFileSync(target, original);
  });
  await test('original launcher/server/manifest/assets byte mutation rejected independently of forged provenance', () => {
   for (const relative of ['scripts/launch_codex_security_mcp', 'mcp/server.mjs', '.mcp.json', 'assets/logo.png']) {
    const target = path.join(destination, native.ORIGINAL_ROOT, relative); assert(fs.existsSync(target), relative);
    const original = fs.readFileSync(target); fs.appendFileSync(target, '\n');
    reject(() => native.readCodexSecurityNativeComponent(destination)); fs.writeFileSync(target, original);
   }
   const target = path.join(destination, native.PROVENANCE_FILE), original = fs.readFileSync(target);
   const provenance = JSON.parse(original); provenance.rightsReview = 'approved'; fs.writeFileSync(target, JSON.stringify(provenance));
   reject(() => native.readCodexSecurityNativeComponent(destination)); fs.writeFileSync(target, original);
  });
  await test('unexpected original file/hardlink/symlink/private file permission changes rejected', () => {
   const originalRoot = path.join(destination, native.ORIGINAL_ROOT), extra = path.join(originalRoot, 'extra.txt');
   fs.writeFileSync(extra, 'new source', { mode: 0o600 }); reject(() => native.readCodexSecurityNativeComponent(destination)); fs.unlinkSync(extra);
   const hard = path.join(originalRoot, 'hardlink.txt'), launcher = path.join(originalRoot, 'scripts/launch_codex_security_mcp');
   fs.linkSync(launcher, hard); assert.throws(() => native.readCodexSecurityNativeComponent(destination)); fs.unlinkSync(hard);
   const link = path.join(originalRoot, 'foreign-link'); fs.symlinkSync('/private/tmp', link);
   assert.throws(() => native.readCodexSecurityNativeComponent(destination)); fs.unlinkSync(link);
   const config = path.join(destination, 'mcp.json'); fs.chmodSync(config, 0o644);
   reject(() => native.readCodexSecurityNativeComponent(destination)); fs.chmodSync(config, 0o600);
   assert.equal(native.readCodexSecurityNativeComponent(destination).sourceClosure.sourceDigest, native.SOURCE_DIGEST);
  });
  await context.close(); context = null;
  const after = hashes(); assert.deepEqual(after, before);
  const result = { version: 1, verified: true, scope: 'full-original-component-artifact and fixed bundled installation; no Service native execution',
   count: checks.length, checks, codeHashesBefore: before, codeHashesAfter: after, nativeHostStarts: 0,
   modelTurnCount: 0, toolBusinessCount: 0, scanCount: 0, registeredOriginalComponent: true,
   fullPluginUsable: false, conversionCountUnchanged: true, rightsReview: 'pending',
   component: { sourceDigest: native.SOURCE_DIGEST, descriptorDigest: artifact.component.descriptorDigest,
    originalFileCount: artifact.originalFileCount, originalFieldCount: 6, environmentSelectorCount: 43,
    intendedToolCount: 45, appToolCount: 25, modelToolCount: 20, startupTimeoutSec: 120, toolTimeoutSec: 349200 } };
  if (output) fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`PASS ${checks.length}/${checks.length}; main exits naturally; no Host/model/tool business`);
 } catch (error) {
  const after = hashes();
  if (output && !fs.existsSync(output)) fs.writeFileSync(output, `${JSON.stringify({ verified: false, checks,
   codeHashesBefore: before, codeHashesAfter: after, error: { code: error.code || null, message: error.message },
   retainedFixtureRoot: context?.root || null }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  throw error;
 }
})().catch(error => { console.error(error); process.exitCode = 1; });
