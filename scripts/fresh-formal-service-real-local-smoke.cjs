"use strict";

// Real Service/socket/Backend/REST and encrypted persistence. Every authority,
// key and payload belongs to a newly created isolated temporary fixture.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const http = require("node:http"), { once } = require("node:events"), { spawn } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const load = relative => require(path.join(ROOT, relative));
const { createAgentService, PROTOCOL_VERSION } = load("app/agent-service/server.js");
const { requestService, readClientToken } = load("app/agent-service/client.js");
const { resolveServicePaths } = load("app/agent-service/paths.js");
const { DEFAULT_AGENT_PROFILE_ID: alpha, AGENT_PROFILE_FIELDS } = load("app/agent-service/product-store.js");
const { EncryptedSecretStore } = load("app/agent-service/encrypted-secret-store.js");
const { ShoggothBackend } = load("app/core/shoggoth-backend.js");
const { BackendRegistry } = load("app/core/backend-registry.js");
const { startStaticServer } = load("app/static-server.js");
const P = load("app/agent-service/memory-provider-owner-protocol.cjs");
const beta = "catalog-beta-profile", KEY = "invented-catalog-service-key-924715";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const failCode = (action, code) => assert.rejects(action, error => error.code === code);
function broker(key) { return {
  async open() {}, async close() {},
  async encrypt(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
  async decrypt(value) { const cipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]); },
}; }
function pathsFor(root) { return resolveServicePaths({ trustedRoot: root, homeDir: root, userDataRoot: root,
  stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") }); }
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync("/private/tmp/sg-owner-service-"); fs.chmodSync(root, 0o700);
  const paths = pathsFor(root), aes = crypto.randomBytes(32), cryptoBroker = broker(aes);
  const allowed = new Set(), requests = [], originalFetch = globalThis.fetch;
  let gate = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.hostname, "127.0.0.1", "fixture must never send to a real destination");
    assert.ok(allowed.has(url.origin), `unowned HTTP resource: ${url.origin}`);
    requests.push({ url: url.href, init });
    const response = await originalFetch(input, init);
    if (gate && url.pathname === "/v1/embeddings" && String(init?.body).includes(gate.text)) {
      const captured = gate; gate = null; captured.entered.resolve(); await captured.release.promise;
    }
    return response;
  };
  // The pinned guarded-fetch explicitly selects an injected mock transport
  // when this metadata exists. This wrapper still performs real owned HTTP;
  // it adds authority inspection and a physical-response gate only.
  globalThis.fetch.mock = {};
  let service = null, store = null, backend = null, server = null;
  const config = { memory: { search: { provider: "none", rememberAcrossConversations: false } } };
  const runtimeManager = { async acquire() { assert.fail("catalog management must not acquire a Runtime/model"); }, async stop() {}, async stopAll() {} };
  const f = { root, paths, config, allowed, requests, cryptoBroker, syntheticAesKeyHex: aes.toString("hex"),
    get service() { return service; }, get store() { return store; }, get backend() { return backend; },
    get server() { return server; }, holdNext(text) { assert.equal(typeof text, "string"); gate = { text, entered: deferred(), release: deferred() }; return gate; },
    ipc(method, params, patch = {}) { return requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths),
      version: PROTOCOL_VERSION, method, params, ...patch }, { timeoutMs: 30_000 }); },
    context(params = {}) { return this.ipc(P.METHODS[0], params); },
    apply(params) { return this.ipc(P.METHODS[1], params); },
    recover(params) { return this.ipc(P.METHODS[2], params); },
    async open() {
      store = new EncryptedSecretStore({ paths, cryptoBroker });
      service = createAgentService({ paths, secretStore: store, cryptoBroker, memoryCore: true, memoryCoreConfig: config,
        runtimeManager, prewarmMcpAuth: false, version: "synthetic-owner-service", ...options });
      try { await service.start(); } catch (error) {
        const describe = value => ({ code: value?.code, name: value?.name, message: value?.message,
          errors: value?.errors?.map(describe), cause: value?.cause ? describe(value.cause) : undefined });
        console.error("isolated Service startup diagnostic", JSON.stringify(describe(error))); throw error;
      } return service;
    },
    async close() { if (server) { await server.close(); server = null; } if (backend) { await backend.stop(); backend = null; }
      if (service) { await service.stop({ notify: false }); service = null; } },
    async stopExpectFailure() { const current = service; await assert.rejects(() => current.stop({ notify: false }), { code: "SERVICE_STOP_FAILED" }); service = null; },
    async restart() { await this.close(); return this.open(); },
    async web() { backend = new ShoggothBackend({ paths }); backend._state = "started";
      const registry = new BackendRegistry(); registry.register(backend);
      server = await startStaticServer(0, { registry, homeDir: root, userDataRoot: path.join(root, "ui") });
      allowed.add(server.url); return server; },
    async http(method, suffix = "", body, origin = server.url) {
      const response = await fetch(`${server.url}/__api/memory-provider-owners${suffix}`, { method,
        headers: { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const raw = await response.text(); return { status: response.status, data: raw.startsWith("{") ? JSON.parse(raw) : raw };
    },
    addBeta() {
      const source = service.productStore.getAgentProfile(alpha);
      const profile = Object.fromEntries(AGENT_PROFILE_FIELDS.map(field => [field, source[field]]));
      Object.assign(profile, { id: beta, agentId: "catalog-beta-agent", name: "Synthetic Beta", runtimeProfileId: "catalog-beta-runtime", isDefault: false });
      return service.productStore.putAgentProfile(profile);
    },
    async configure(next) { const current = service.nativeMemoryConfig.read(); return this.ipc("memory.config.apply", { revision: current.revision + 1, config: next }); },
  };
  t.after(async () => { try { await f.close(); assert.equal(gate, null); }
    finally { globalThis.fetch = originalFetch; aes.fill(0); }
    fs.rmSync(root, { recursive: true, force: true }); });
  await f.open(); return f;
}
function creation(extra = {}) { return { action: "create", operationId: `create-${crypto.randomUUID()}`, expectedCatalogRevision: 0,
  scope: { kind: "global" }, providerId: "openai", label: "Synthetic Owner", baseUrl: "http://127.0.0.1:1/v1",
  secretAction: "set", secret: KEY, ...extra }; }
function update(row, extra = {}) { return { action: "update", operationId: `update-${crypto.randomUUID()}`,
  expectedCatalogRevision: row.catalogRevision, ownerRef: row.ownerRef, expectedOwnerRevision: row.ownerRevision,
  label: "Synthetic Updated", baseUrl: "http://127.0.0.1:1/v1", secretAction: "preserve", ...extra }; }
function revoke(row, extra = {}) { return { action: "revoke", operationId: `revoke-${crypto.randomUUID()}`,
  expectedCatalogRevision: row.catalogRevision, ownerRef: row.ownerRef, expectedOwnerRevision: row.ownerRevision, ...extra }; }
function assertPublic(value) { const text = JSON.stringify(value); for (const secret of [KEY, "credentialRef", "fingerprint", "idempotencyKey", "requestDigest"]) assert.equal(text.includes(secret), false, secret); }
function authority(f) { return ["memory-provider-owners.json", "encrypted-secrets.json", "native-memory-config.json"]
  .map(name => { const file = path.join(f.paths.stateDir, name); return [name, fs.existsSync(file) ? sha(fs.readFileSync(file)) : null]; }); }

const {core}=load('app/agent-service/shoggoth-memory/host.cjs');
const {withMemoryHost}=load('app/agent-service/shoggoth-memory/host-bridge.cjs');
function fileHash(target) {const hash=crypto.createHash('sha256'),fd=fs.openSync(target,'r'),chunk=Buffer.alloc(1024*1024);try{let n;while((n=fs.readSync(fd,chunk,0,chunk.length,null))>0)hash.update(chunk.subarray(0,n));return hash.digest('hex');}finally{fs.closeSync(fd);}}
function resourceProof(target,expected){const stat=fs.lstatSync(target);assert.ok(stat.isFile()&&!stat.isSymbolicLink());const hash=fileHash(target);assert.equal(hash,expected);return{path:target,dev:stat.dev,ino:stat.ino,bytes:stat.size,sha256:hash};}
const model='/private/tmp/shoggoth-memory-real-gguf-20261008/state/models/llama.cpp/hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf';
const command='/private/tmp/shoggoth-memory-real-gguf-20261008/verified-native-kx__0eto/llama-b10809/llama-server';
const modelSha='6fa0c02a9c302be6f977521d399b4de3a46310a4f2621ee0063747881b673f67',commandSha='d707b6db4c1397a7383176fba12d339e5b33c7513669d74c8fbc2a76f6979a72';
test('fresh actual Service public local config uses verified real GGUF for documents/query and physically retires',{timeout:180000},async t=>{
 const before={model:resourceProof(model,modelSha),command:resourceProof(command,commandSha)},f=await fixture(t);
 const managed=await withMemoryHost({assertCurrent(){},resolveStateDir:()=>f.paths.stateDir},()=>core.prepareManagedLlamaServer({chatModel:{mode:'remove'},embeddingModelPath:model,embeddingModelIsDefault:true,localService:{command},isolated:true}));
 f.allowed.add(new URL(managed.baseUrl).origin);const cacheDir=path.join(f.paths.stateDir,'models/llama.cpp');
 await f.configure({memory:{search:{provider:'local',fallback:'none',local:{modelPath:model},sources:['memory'],query:{minScore:0},cache:{enabled:false},rememberAcrossConversations:false}},
  models:{providers:{'llama-cpp':{baseUrl:managed.baseUrl,models:[],params:{modelCacheDir:cacheDir},localService:{command,args:managed.args,healthUrl:managed.healthUrl,readyTimeoutMs:120000,idleStopMs:0}}}}});
 const engine=f.service.memoryEngine;
 if(engine.embedding)engine.embedding.encode=async()=>assert.fail('the local original GGUF factory must not call E5');
 for(const [id,content]of [['fresh-local-observatory','The invented cobalt telescope station is on the northern mountain ridge. Its calibration code is zircon-47.'],['fresh-local-tea','The invented cafe sells jasmine tea and lemon cookies in the afternoon.']])await engine.propose({profileId:alpha,id,content,scope:'agent',sourceRefs:[`user-edit:${id}`],type:'semantic',classification:'explicit'});
 const index=engine.host(alpha).searchIndex;await index.sync({force:true});
 assert.equal(index.searchOwner.provider.id,'local');assert.equal(index.searchOwner.provider,index.embeddingExecutor.provider);assert.equal(index.searchOwner.providerRuntime,index.embeddingExecutor.providerRuntime);
 const rows=index.db.prepare('SELECT model,embedding FROM memory_index_chunks').all();assert.ok(rows.length>=2);for(const row of rows){const vector=core.decodeMemoryEmbedding(row.embedding);assert.equal(vector.length,768);assert.ok(vector.some(n=>n!==0));assert.ok(vector.every(Number.isFinite));assert.equal(row.model,index.searchOwner.provider.model);}
 const result=await engine.searchMemory({profileId:alpha,workspace:engine.host(alpha).workspaceDir,query:'Where is the telescope station located?',minScore:0,record:false,maxSensitivity:'private'});
 assert.equal(result.items[0].id,'fresh-local-observatory');
 const provider=index.searchOwner.provider;const [a,b]=await engine.host(alpha).run(()=>Promise.all([provider.embed('Invented telescope on a mountain'),provider.embed('Invented jasmine tea and lemon cookies')]));assert.equal(a.length,768);assert.equal(b.length,768);assert.notDeepEqual(a,b);
 const facts=provider[Symbol.for('openclaw.localEmbeddingRuntimeFacts')]();assert.equal(fs.realpathSync.native(facts.model.path),model);assert.match(facts.buildInfo,/b10809/);
 const diagnostics=core.getManagedProviderLocalServiceDiagnosticsForTest();assert.ok(diagnostics.length>0);
 const publicConfig=await f.ipc('memory.config.read',{});assert.equal(publicConfig.config.memory.search.provider,'local');assert.equal((await f.context()).owners.length,0);
 await f.close();assert.deepEqual(core.getManagedProviderLocalServiceDiagnosticsForTest(),[]);
 assert.deepEqual(resourceProof(model,modelSha),before.model);assert.deepEqual(resourceProof(command,commandSha),before.command);
 const evidence={runtime:process.versions,publicConfigProvider:'local',sourceHead:'22d7e13700d890fa0144939079414c4cda54c10a',resources:before,baseUrl:managed.baseUrl,rows:rows.length,dimensions:768,topItem:result.items[0].id,distinctVectors:true,nativeFactoryAndPhysicalRetirement:true,diagnostics,externalInference:false,realUserDataRead:false};
 fs.writeFileSync(path.join(ROOT,process.versions.electron?'fresh-real-local-electron-evidence.json':'fresh-real-local-node-evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
});
