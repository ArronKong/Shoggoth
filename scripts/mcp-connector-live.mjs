#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NativeMcpClientManager } = require('../app/agent-service/native-mcp-client-manager');
const { McpPackageLauncher } = require('../app/agent-service/mcp-package-launcher');
const { McpRegistryClient } = require('../app/agent-service/mcp-registry-client');
const { McpConnectorSecrets } = require('../app/agent-service/mcp-connector-secrets');
const { EncryptedSecretStore } = require('../app/agent-service/encrypted-secret-store');
const { resolveServicePaths } = require('../app/agent-service/paths');
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !['--network', '--slow', '--skip-keychain'].includes(arg))) throw Error('Unknown test option');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgh-mcp-live-')));
fs.chmodSync(root, 0o700);
const service = `com.shoggoth.mcp-test.${crypto.randomUUID()}`;
const account = 'mcp-connector-live-test';
let testKeyAdded = false, vault, manager;
function security(command, { privateInput } = {}) {
  const options = { encoding: 'utf8', timeout: 15000, input: privateInput, stdio: ['pipe', 'pipe', 'pipe'] };
  const result = privateInput === undefined ? spawnSync('/usr/bin/security', command, options) : spawnSync('/usr/bin/security', ['-i'], options);
  if (result.error || result.status !== 0) throw Error('Disposable test Keychain operation failed');
  return result.stdout.trim();
}
try {
  const result = spawnSync(process.execPath, ['scripts/mcp-connector-runtime-unit.cjs'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 120000 });
  process.stdout.write(result.stdout || '');
  if (result.status !== 0) { process.stderr.write(result.stderr || ''); throw Error('Deterministic MCP fixture failed'); }
  let key;
  if (process.platform === 'darwin' && !args.has('--skip-keychain')) {
    // Feed the generated key on stdin to security's interactive parser; never put it in process argv.
    const generated = crypto.randomBytes(32).toString('hex');
    security([], { privateInput: `add-generic-password -a ${account} -s ${service} -w ${generated}\n` });
    testKeyAdded = true;
    const loaded = security(['find-generic-password', '-a', account, '-s', service, '-w']);
    assert.equal(loaded, generated); key = Buffer.from(loaded, 'hex');
  } else {
    key = crypto.randomBytes(32);
    console.log('SKIP real Keychain test (explicit --skip-keychain or non-macOS); using an isolated ephemeral key.');
  }
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, 'state'), profileRoot: path.join(root, 'profile'), cacheRoot: path.join(root, 'cache') });
  const broker = {
    async encrypt(plaintext) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(plaintext),c.final()]); return Buffer.concat([iv,c.getAuthTag(),data]); },
    async decrypt(ciphertext) { const iv = ciphertext.subarray(0,12), tag = ciphertext.subarray(12,28), data = ciphertext.subarray(28); const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(data),d.final()]); },
  };
  vault = new EncryptedSecretStore({ paths, cryptoBroker: broker }); await vault.open();
  const secrets = new McpConnectorSecrets({ secretStore: vault });
  const canary = `live-secret-${crypto.randomUUID()}`; await secrets.write('canary', { headers: { 'X-Test': canary } });
  assert.ok(!fs.readFileSync(paths.encryptedSecretsPath,'utf8').includes(canary));
  await vault.close(); await vault.open(); assert.equal((await secrets.read('canary')).headers['X-Test'],canary);
  console.log('PASS encrypted secret persistence with disposable Keychain-backed test key');
  const records = new Map(); const store = { get: id => records.get(id), getPrivate: id => records.get(id) };
  manager = new NativeMcpClientManager({ store, secrets, packageLauncher: new McpPackageLauncher() });
  const remote = (id,url) => ({id,name:id,enabled:true,updatedAt:1,transport:{kind:'remote',protocol:'streamable-http',url},auth:{kind:'none'}});
  if (args.has('--network')) {
    const fixtureFile = path.join(root, 'fixture.txt'); fs.writeFileSync(fixtureFile,'Shoggoth isolated MCP filesystem acceptance');
    const filesystem = {id:'filesystem',name:'Filesystem',enabled:true,updatedAt:1,transport:{kind:'stdio-package',registryType:'npm',identifier:'@modelcontextprotocol/server-filesystem',version:'2025.8.21',packageArgs:[root]},auth:{kind:'none'}};
    records.set(filesystem.id,filesystem);
    const localTools = await manager.listTools(filesystem.id); assert.ok(localTools.some(tool => tool.name === 'read_file' || tool.name === 'read_text_file'));
    const local = await manager.callTool(filesystem.id,localTools.some(tool => tool.name === 'read_text_file')?'read_text_file':'read_file',{path:fixtureFile});
    assert.ok(JSON.stringify(local).includes('Shoggoth isolated MCP filesystem acceptance'));
    console.log('PASS real pinned npm filesystem initialize, tools/list and isolated read');
    const deepwiki = remote('deepwiki','https://mcp.deepwiki.com/mcp'); records.set(deepwiki.id,deepwiki);
    const tools = await manager.listTools(deepwiki.id); assert.ok(tools.some(tool => tool.name === 'read_wiki_structure'));
    const wiki = await manager.callTool(deepwiki.id,'read_wiki_structure',{repoName:'modelcontextprotocol/typescript-sdk'}); assert.ok(wiki.content?.length && !wiki.isError);
    console.log('PASS real DeepWiki initialize, tools/list and harmless read_wiki_structure');
    const registry = new McpRegistryClient(); const page = await registry.list({search:'context7'});
    const item = page.items.find(item => item.registryName === 'io.github.upstash/context7' && item.options.some(option => option.transport.kind === 'remote'));
    assert.ok(item,'Registry returned no active latest Context7 remote connector');
    const option = item.options.find(option => option.transport.kind === 'remote' && !option.fields.some(field => field.required)); assert.ok(option,'Context7 now requires credentials; cannot claim unauthenticated proof');
    const context7 = { ...remote('context7',option.transport.url), transport:option.transport }; records.set(context7.id,context7);
    const contextTools = await manager.listTools(context7.id); assert.ok(contextTools.length);
    const resolver = contextTools.find(tool => tool.name === 'resolve-library-id'); assert.ok(resolver);
    const resolved = await manager.callTool(context7.id,resolver.name,{libraryName:'react',query:'React useState documentation'}); assert.ok(resolved.content?.length && !resolved.isError);
    console.log(`PASS Registry-resolved Context7 ${item.registryName}@${item.version} initialize, tools/list and library lookup`);
  }
  if (args.has('--slow')) {
    const file = path.join(root,'never-ready.cjs'); fs.writeFileSync(file,'setInterval(()=>{},1000)');
    const record = {id:'slow',name:'slow',enabled:true,transport:{kind:'stdio-command',command:process.execPath,args:[file],cwd:root}};
    const start = Date.now(); await assert.rejects(manager.probe(record),error=>error.code==='MCP_SERVER_TIMEOUT');
    assert.ok(Date.now()-start >= 89500 && Date.now()-start < 98000);
    console.log('PASS real 90-second readiness budget and timed-out child process reaping');
  }
} finally {
  await manager?.close(); await vault?.close();
  if (testKeyAdded) security(['delete-generic-password','-a',account,'-s',service]);
  fs.rmSync(root,{recursive:true,force:true});
}
