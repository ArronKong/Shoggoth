"use strict";

// Real Service/socket/Backend/REST and encrypted persistence. Every authority,
// key and payload belongs to a newly created isolated temporary fixture.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const http = require("node:http"), { once } = require("node:events"), { spawn } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
// Keep macOS Unix socket paths short; Linux does not have /private/tmp.
const fixtureTmpDir = process.platform === "darwin" ? "/private/tmp" : require("node:os").tmpdir();
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
  const root = fs.mkdtempSync(path.join(fixtureTmpDir, "sg-owner-service-")); fs.chmodSync(root, 0o700);
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

const {core}=load("app/agent-service/shoggoth-memory/host.cjs");
async function ownedEmbeddingServer(t,f) {
  const requests=[],errors=[],server=http.createServer(async(req,res)=>{
    try {const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString();const body=raw?JSON.parse(raw):{};
      requests.push({url:req.url,headers:req.headers,body});res.setHeader('Content-Type','application/json');
      const vector=()=>[3,4,...Array((body.dimensions||body.outputDimensionality||body.requests?.[0]?.outputDimensionality||2)-2).fill(0)];
      if(req.url.includes(':batchEmbedContents'))res.end(JSON.stringify({embeddings:body.requests.map(()=>({values:vector()}))}));
      else if(req.url.includes(':embedContent'))res.end(JSON.stringify({embedding:{values:vector()}}));
      else if(req.url.includes('/api/embed'))res.end(JSON.stringify({embeddings:(Array.isArray(body.input)?body.input:[body.input]).map(()=>vector())}));
      else res.end(JSON.stringify({data:(Array.isArray(body.input)?body.input:[body.input]).map((_,index)=>({index,embedding:vector()})).reverse()}));
    } catch(error){errors.push(error);res.destroy();}
  });server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;f.allowed.add(origin);
  t.after(async()=>{const close=once(server,'close');server.close();server.closeAllConnections();await close;assert.deepEqual(errors,[]);});
  return{requests,baseUrl:origin+'/v1'};
}
async function queryFresh(f,id=alpha) {return f.service.memoryEngine.searchMemory({profileId:id,workspace:f.service.memoryEngine.host(id).workspaceDir,
  query:'Fresh cobalt telescope',minScore:0,record:false,maxSensitivity:'private'});}
function nativeRows(index){return index.db.prepare('SELECT model,embedding,text FROM memory_index_chunks').all();}
for(const providerId of ['openai','mistral','voyage','gemini','ollama','openai-compatible']) {
 test(`fresh formal catalog ${providerId}: REST registration, native document/query identity, rotation and persisted restart`,{timeout:30000},async t=>{
  const f=await fixture(t);await f.web();const remote=await ownedEmbeddingServer(t,f),key=`invented-fresh-${providerId}-key-827164`;
  const request=creation({providerId,baseUrl:remote.baseUrl,secret:key,operationId:`fresh-${providerId}-create`,
    ...(providerId==='openai-compatible'?{api:'openai-completions'}:{})});
  const reply=await f.http('POST','',request);assert.equal(reply.status,200);const created=reply.data;assertPublic(created);
  assert.equal(remote.requests.length,0,'account registration must never probe the provider');
  const search={provider:providerId,fallback:'none',model:providerId==='gemini'?'gemini-embedding-2':`fresh-${providerId}-embedding`,
    sources:['memory'],outputDimensionality:providerId==='gemini'?128:2,rememberAcrossConversations:false,query:{minScore:0},cache:{enabled:false},providerRefs:{[providerId]:created.ownerRef}};
  await f.configure({memory:{search}});const engine=f.service.memoryEngine,index=engine.host(alpha).searchIndex;
  if(engine.embedding)engine.embedding.encode=async()=>assert.fail('native remote factory must never call E5');
  await engine.propose({profileId:alpha,id:`fresh-${providerId}-fact`,content:'Fresh cobalt telescope calibration uses the invented zircon code.',
    scope:'agent',sourceRefs:[`user-edit:fresh-${providerId}`],type:'semantic',classification:'explicit'});
  await index.sync({force:true});const before=remote.requests.length;assert.ok(before>0);const result=await queryFresh(f);
  assert.ok(result.items.some(row=>row.id===`fresh-${providerId}-fact`));assert.ok(remote.requests.length>before,'query must use native embeddings');
  assert.equal(index.searchOwner.provider,index.embeddingExecutor.provider);
  assert.equal(index.searchOwner.providerRuntime.cacheKeyData,index.embeddingExecutor.providerRuntime.cacheKeyData);
  assert.equal(index.searchOwner.providerRuntime.indexIdentityAliases,index.embeddingExecutor.providerRuntime.indexIdentityAliases);
  assert.deepEqual(core.resolveMemoryIndexProviderIdentities({provider:index.searchOwner.provider,cacheKeyData:index.searchOwner.providerRuntime.cacheKeyData,aliases:index.searchOwner.providerRuntime.indexIdentityAliases}),index.providerIdentities);
  assert.equal(index.searchOwner.providerKey,index.providerIdentities[0].providerKey);
  if(index.searchOwner.providerRuntime.batchEmbed)assert.notEqual(index.searchOwner.providerRuntime.batchEmbed,index.embeddingExecutor.providerRuntime.batchEmbed,'executor owns the real guarded batch wrapper');
  assert.equal(index.searchOwner.provider.id,providerId);assert.ok(nativeRows(index).every(row=>row.model===index.searchOwner.provider.model));
  assert.ok(nativeRows(index).every(row=>core.decodeMemoryEmbedding(row.embedding).length===(providerId==='gemini'?128:2)));
  for(const row of remote.requests){assert.equal(row.headers[providerId==='gemini'?'x-goog-api-key':'authorization'],providerId==='gemini'?key:`Bearer ${key}`);}
  const publicConfig=await f.ipc('memory.config.read',{});assert.equal(JSON.stringify(publicConfig).includes(key),false);
  assert.equal(fs.readFileSync(f.paths.encryptedSecretsPath,'utf8').includes(key),false);
  const oldProvider=index.searchOwner.provider,newKey=`invented-rotated-${providerId}-key-174682`,rotated=await f.http('POST','',update(created,{baseUrl:remote.baseUrl,secretAction:'set',secret:newKey}));
  assert.equal(rotated.status,200);await index.sync({force:true});const start=remote.requests.length;assert.ok((await queryFresh(f)).items.length);
  for(const row of remote.requests.slice(start))assert.equal(row.headers[providerId==='gemini'?'x-goog-api-key':'authorization'],providerId==='gemini'?newKey:`Bearer ${newKey}`);
  assert.throws(()=>oldProvider.embed('old retired handle'),/retired|REVOKED|CANCELLED/i);
  await f.restart();const afterRestart=f.service.memoryEngine.host(alpha).searchIndex;await afterRestart.sync({force:true});assert.ok((await queryFresh(f)).items.length);
  assert.equal((await f.context()).owners[0].revision,rotated.data.ownerRevision);assert.equal(afterRestart.searchOwner.provider.id,providerId);
  await f.configure({memory:{search:{provider:'none'}}});const revoked=await f.apply(revoke(rotated.data));assert.equal(revoked.status,'revoked');assert.equal(f.store.listMetadata().length,0);
  assert.equal(f.requests.filter(row=>!row.url.startsWith(remote.baseUrl.slice(0,-3))&&!row.url.startsWith(f.server?.url||'never')&&!row.url.includes('/__api/')).length,0);
 });
}

test('fresh global and Profile catalog owners bind separate real provider generations and keys',{timeout:30000},async t=>{
 const f=await fixture(t);f.addBeta();await f.web();const remote=await ownedEmbeddingServer(t,f);
 const a=await f.http('POST','',creation({baseUrl:remote.baseUrl,secret:'invented-global-profile-key-93872'}));assert.equal(a.status,200);
 const b=await f.http('POST','',creation({baseUrl:remote.baseUrl,operationId:'fresh-beta-owner',expectedCatalogRevision:1,scope:{kind:'profile',profileId:beta},secret:'invented-beta-profile-key-19486'}));assert.equal(b.status,200);
 const common={provider:'openai',fallback:'none',model:'fresh-profile-model',outputDimensionality:2,sources:['memory'],cache:{enabled:false},providerRefs:{openai:a.data.ownerRef}};
 await f.configure({memory:{search:common},agents:{entries:{[beta]:{memory:{search:{providerRefs:{openai:b.data.ownerRef}}}}}}});
 const engine=f.service.memoryEngine;engine.store.ensureProfile(beta);
 for(const id of [alpha,beta]){await engine.propose({profileId:id,id:`fresh-${id}-profile-fact`,content:`Fresh cobalt telescope in ${id}.`,scope:'agent',sourceRefs:[`user-edit:fresh-${id}`],type:'semantic',classification:'explicit'});await engine.host(id).searchIndex.sync({force:true});}
 assert.equal((await f.context({profileId:alpha})).owners.some(row=>row.ownerRef===b.data.ownerRef),false);
 assert.equal((await f.context({profileId:beta})).owners.length,2);
 for(const [id,key]of [[alpha,'invented-global-profile-key-93872'],[beta,'invented-beta-profile-key-19486']]){const before=remote.requests.length;const result=await queryFresh(f,id);assert.ok(result.items.some(row=>row.id===`fresh-${id}-profile-fact`));assert.ok(remote.requests.length>before);for(const row of remote.requests.slice(before))assert.equal(row.headers.authorization,`Bearer ${key}`);}
 assert.notEqual(engine.host(alpha).searchIndex.searchOwner,engine.host(beta).searchIndex.searchOwner);
 assert.deepEqual(engine.config(beta).agents.entries[beta].memory.search.providerRefs,{openai:b.data.ownerRef});
});
