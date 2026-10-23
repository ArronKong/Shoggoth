"use strict";

// Every case owns a separate process, private SQLite, invented GGUF headers and
// a synthetic Node HTTP worker. The fixed native factory and real Product index
// execute; no model/binary download, production Service or remote request runs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");
const { MemoryLocalEmbeddingHost } = require("../app/agent-service/shoggoth-memory/local-embedding-host.cjs");
const { withMemoryHost } = require("../app/agent-service/shoggoth-memory/host-bridge.cjs");
const { createLocalServiceFixture, until, rows, read, bounded, delay } = require("./shoggoth-memory-local-service-smoke.cjs");

const workerSource = String.raw`
"use strict";
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const root = process.argv[2], port = Number(process.argv[4]), id = "embeddinggemma-300m-qat-q8_0";
const file = name => path.join(root, name), read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8") : "";
const append = (name, value) => fs.appendFileSync(file(name), JSON.stringify(value) + "\n");
const preset = () => /^model\s*=\s*(.+)$/m.exec(read("models.ini"))?.[1]?.trim();
let loaded = preset();
append("starts.jsonl", { pid: process.pid });
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8"), body = text ? JSON.parse(text) : undefined;
  append("requests.jsonl", { url: req.url, ...(body ? { body } : {}), loaded });
  res.setHeader("content-type", "application/json");
  if (req.url === "/models?reload=1") { loaded = preset(); append("reloads.jsonl", { loaded }); res.end('{"reloaded":true}'); }
  else if (req.url === "/v1/embeddings") {
    if (read("request.mode").trim() === "error") { res.writeHead(503); res.end("invented fixture failure"); return; }
    if (read("request.mode").trim() === "wrong-model") loaded = loaded.replace("custom-A.gguf", "custom-B.gguf");
    const dimensions = body.dimensions || 2, second = /custom-B/.test(loaded || "");
    const embedding = Array.from({ length: dimensions }, (_, i) => i === (second ? 1 : 0) ? 1 : 0);
    res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding })).reverse() }));
  } else if (req.url.startsWith("/props?")) {
    const finish = () => res.end(JSON.stringify({ model_path: loaded, build_info: "synthetic Product index", modalities: { vision: false } }));
    if (read("props.hold").trim()) {
      append("props-held.jsonl", { loaded }); const timer = setInterval(() => { if (read("props.gate").trim()) { clearInterval(timer); finish(); } }, 5);
      res.once("close", () => clearInterval(timer));
    } else finish();
  } else if (req.url.startsWith("/metrics?")) { res.setHeader("content-type", "text/plain"); res.end("fixture_ready 1\n"); }
  else if (req.url === "/models") res.end(JSON.stringify({ data: [{ id, path: loaded }] }));
  else res.end('{"ready":true}');
});
server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => { fs.writeFileSync(file("stopping"), "yes"); server.closeAllConnections(); server.close(() => process.exit(0)); });
`;

async function fixture(directory) {
  const lifetime = new AbortController();
  const f = await createLocalServiceFixture(core, directory, lifetime.signal, workerSource);
  const server = await f.resource("llama-cpp", { idleStopMs: undefined });
  // The public local-service projection deliberately does not admit env.
  // The synthetic worker inherits ELECTRON_RUN_AS_NODE from this case process.
  delete server.service.env;
  server.service.args.push("--models-preset", server.file("models.ini"));
  server.service.healthUrl = server.baseUrl.replace(/\/v1$/, "/health");
  const paths = { trustedRoot: directory, stateDir: path.join(directory, "state"), agentsDir: path.join(directory, "agents") };
  const cache = path.join(paths.stateDir, "models/llama.cpp"); fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const modelA = path.join(cache, "custom-A.gguf"), modelB = path.join(cache, "custom-B.gguf");
  const defaultPath = path.join(cache, core.DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE);
  for (const file of [modelA, modelB, defaultPath]) fs.writeFileSync(file, "GGUF synthetic header only", { mode: 0o600 });
  const indexes = [], leases = [], e5Calls = [], localHosts = [];
  function createLocalHost() {
    const lookup = id => {
      assert.equal(typeof id, "string", "Resource operations must carry their real Profile id");
      const value = indexes.find(value => value.id === id);
      assert.ok(value, `Unknown fixture Profile ${id}`); return value;
    };
    const host = new MemoryLocalEmbeddingHost({ getConfig: id => lookup(id).config,
      assertCurrent: id => { lifetime.signal.throwIfAborted(); lookup(id).host.assertCurrent(); } });
    const acquire = host.acquireLocalService;
    const acquireLocalService = async (target, signal) => {
      assert.equal(target.reconcile, core.reconcileManagedLlamaServer);
      const lease = await acquire(target, signal), record = { releases: 0 }; leases.push(record);
      return { release() { record.releases++; return lease.release(); } };
    };
    host.resources = { acquireLocalService, assertLocalEmbeddingConfig: host.assertLocalEmbeddingConfig,
      runLocalEmbedding: host.runLocalEmbedding };
    localHosts.push(host); return host;
  }
  const localHost = createLocalHost();
  function create(id = "one", { provider = "local", modelPath = modelA, dimensions = 2, serviceHost = localHost } = {}) {
    const workspace = path.join(directory, id); fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
    const database = new MemoryDatabase({ paths, databasePath: path.join(paths.agentsDir, `${id}.sqlite`) }); database.open();
    const config = { ...f.config, _shoggothConfigRevision: 0, memory: { search: {
      provider, sources: ["memory"], local: { modelPath }, outputDimensionality: dimensions, cache: { enabled: true } } } };
    const host = new ShoggothMemoryHost({ database, paths, profileId: id, workspaceDir: workspace,
      roster: () => [{ id, workspace }], sessions: { list: () => [] } });
    const embedding = { identity: "invented-e5-resource", encode: async (text, purpose) => { e5Calls.push({ text, purpose }); return [1, 0]; } };
    const index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true, embedding,
      getConfig: () => config, ...serviceHost.resources, backgroundSync: false,
      logger: { debug() {}, warn() {} } });
    const value = { id, workspace, database, config, host, index, localHost: serviceHost,
      write: text => fs.writeFileSync(path.join(workspace, "MEMORY.md"), text, { mode: 0o600 }),
      chunks: () => database.db.prepare("SELECT id,path,text,model,embedding FROM memory_index_chunks ORDER BY id").all(),
      metadata: () => core.readMemoryIndexMetadata(database.db).meta,
      run: action => host.run(action),
      change: changes => { Object.assign(config.memory.search, changes); config._shoggothConfigRevision++; },
    };
    indexes.push(value); return value;
  }
  const fakeHost = { assertCurrent() {}, resolveStateDir: () => paths.stateDir };
  const options = modelPath => ({ config: f.config, provider: "local", model: "ignored", local: { modelPath }, dimensions: 2, acquireLocalService: f.acquire });
  Object.assign(f, { server, paths, modelA, modelB, defaultPath, create, createLocalHost, localHost, indexes, leases, e5Calls, options,
    terminate: () => {
      lifetime.abort(new Error("Isolated local-index fixture terminated")); server.open("props.gate");
      for (const value of indexes) value.index.close().catch(() => {});
    },
    run: action => withMemoryHost(fakeHost, action),
    embeds: () => rows(server.file("requests.jsonl")).filter(row => row.url === "/v1/embeddings"),
    async cleanupIndexes() {
      server.open("props.gate");
      const errors = [];
      for (const value of indexes) {
        try { await bounded(value.index.close(), "Product index did not physically retire"); } catch (error) { errors.push(error); }
        try {
          assert.equal(value.index.searchOwners.size, 0); assert.equal(value.index.embeddingExecutors.size, 0);
          assert.equal(value.host.coordinationDatabases?.size || 0, 0); value.database.close();
        } catch (error) { errors.push(error); }
      }
      for (const host of localHosts) {
        try {
          await bounded(host.close(), "Product local resource host did not physically retire");
          assert.equal(host.pending.size, 0); assert.equal(host.leases.size, 0);
        } catch (error) { errors.push(error); }
      }
      try { await f.cleanup(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Product local-index cleanup failed");
    },
  });
  return f;
}

function sameGeneration(value) {
  const { index } = value, owner = index.searchOwner, executor = index.embeddingExecutor;
  assert.equal(owner.provider, executor.provider); assert.equal(owner.providerRuntime, executor.providerRuntime);
  assert.equal(owner.provider.id, "local"); assert.equal(owner.provider.model, index.model);
  assert.equal(owner.acquireLocalService, index.acquireLocalService);
  assert.equal(owner.providerKey, index.providerIdentities[0].providerKey);
  assert.deepEqual(core.resolveMemoryIndexProviderIdentities({ provider: owner.provider,
    cacheKeyData: owner.providerRuntime.cacheKeyData, aliases: owner.providerRuntime.indexIdentityAliases }), index.providerIdentities);
  const meta = value.metadata(); assert.equal(meta.provider, "local"); assert.equal(meta.model, index.model);
  assert.equal(meta.providerKey, owner.providerKey);
  const stored = value.database.db.prepare("SELECT value FROM memory_index_meta WHERE key='shoggoth-provider-identity'").get();
  assert.deepEqual(JSON.parse(stored.value), index.providerIdentities);
}

const cases = {
  async persistentHazard(f) {
    // Prove why Product admission must coordinate conflicting retained handles:
    // the pinned original factory canonical identity does not refresh its preset.
    const a = await f.run(() => core.llamaCppEmbeddingProviderAdapter.create(f.options(f.modelA)));
    assert.deepEqual(await f.run(() => a.provider.embed("Invented A first")), [1, 0]);
    const b = await f.run(() => core.llamaCppEmbeddingProviderAdapter.create(f.options(f.modelB)));
    assert.deepEqual(await f.run(() => b.provider.embed("Invented B first")), [0, 1]);
    assert.equal(a.provider.model, f.modelA);
    assert.deepEqual(await f.run(() => a.provider.embed("Invented A retained")), [0, 1]);
    assert.equal(a.provider[Symbol.for("openclaw.localEmbeddingRuntimeFacts")]().model.path, f.modelB);
  },
  async queryAndDocument(f) {
    const one = f.create(); one.write("Amber observatory remembers an invented telescope.");
    await one.index.sync(); sameGeneration(one);
    const results = await one.index.search("Amber telescope", { minScore: 0, record: false });
    assert.ok(results.length); assert.equal(f.e5Calls.length, 0);
    assert.ok(f.embeds().some(row => row.body.input.includes("Amber observatory remembers an invented telescope.")));
    assert.ok(f.embeds().some(row => row.body.input.includes("Amber telescope")));
    assert.ok(f.embeds().every(row => !Object.hasOwn(row.body, "input_type")), "The official GGUF adapter leaves input_type unset");
    assert.ok(f.embeds().every(row => row.body.model === core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID && row.loaded === f.modelA));
    assert.ok(f.leases.every(lease => lease.releases === 1));
    const old = one.index.searchOwner, key = old.providerKey;
    one.change({ outputDimensionality: 3 }); await one.index.sync(); sameGeneration(one);
    assert.equal(old.closed, true); assert.notEqual(one.index.searchOwner.providerKey, key);
    assert.equal(one.index.embeddingDimensions, 3);
    assert.ok(one.chunks().every(row => core.decodeMemoryEmbedding(row.embedding).length === 3));
    assert.equal(f.e5Calls.length, 0); assert.equal(f.server.starts().length, 1);
  },
  async sharedModels(f) {
    const a = f.create("one"); a.write("Amber observatory."); await a.index.sync(); sameGeneration(a);
    const b = f.create("two", { modelPath: f.modelB }); b.write("Blue observatory.");
    await b.index.sync(); sameGeneration(b); const persistentA = a.index.searchOwner.provider;
    await Promise.all([
      a.index.search("Amber A retained", { minScore: 0, record: false }),
      b.index.search("Blue B retained", { minScore: 0, record: false }),
    ]);
    sameGeneration(a); sameGeneration(b); assert.equal(a.index.searchOwner.provider, persistentA);
    assert.deepEqual(core.decodeMemoryEmbedding(a.chunks()[0].embedding), [1, 0]); assert.deepEqual(core.decodeMemoryEmbedding(b.chunks()[0].embedding), [0, 1]);
    const queries = f.embeds();
    assert.ok(queries.some(row => row.body.input[0].includes("Amber A retained") && row.loaded === f.modelA));
    assert.ok(queries.some(row => row.body.input[0].includes("Blue B retained") && row.loaded === f.modelB));
    assert.equal(persistentA[Symbol.for("openclaw.localEmbeddingRuntimeFacts")]().model.path, f.modelA);
    assert.equal(f.server.starts().length, 1); assert.equal(f.e5Calls.length, 0);
    await a.index.close();
    assert.equal(core.hasManagedProviderLocalServices(), true, "Profile retirement must preserve the peer's shared service");
    await b.index.search("Blue after peer retirement", { minScore: 0, record: false }); sameGeneration(b);
  },
  async sharedHostOwners(f) {
    const a = f.create("one"), peer = f.createLocalHost(), b = f.create("two", { modelPath: f.modelB, serviceHost: peer });
    a.write("Amber first resource owner."); b.write("Blue second resource owner.");
    await Promise.all([a.index.sync(), b.index.sync()]); sameGeneration(a); sameGeneration(b);
    const pid = f.pid(f.server);
    await a.index.close(); await a.localHost.close();
    assert.equal(core.hasManagedProviderLocalServices(), true);
    assert.equal(f.capture(pid).closed, false, "The second Service owner still owns the shared worker");
    await b.index.search("Blue after first Service close", { minScore: 0, record: false }); sameGeneration(b);
    assert.ok(f.embeds().some(row => row.body.input[0].includes("Blue after first Service close") && row.loaded === f.modelB));
    await b.index.close(); await peer.close();
    await f.stopped(f.server, pid); assert.equal(core.hasManagedProviderLocalServices(), false);
    assert.equal(f.server.starts().length, 1); assert.equal(f.e5Calls.length, 0);
  },
  async handleRetirement(f) {
    const one = f.create(); one.write("Amber handle retirement."); await one.index.sync();
    const executor = one.index.embeddingExecutor, handle = one.index.searchOwner.provider;
    f.server.open("props.hold");
    const call = one.run(() => handle.embed("Amber physical handle work", { inputType: "query" }));
    await until(() => rows(f.server.file("props-held.jsonl")).length > 0, "Native handle work did not pause");
    let settled = false; const closing = handle.close(); closing.then(() => { settled = true; });
    assert.equal(handle.close(), closing, "Physical handle close must be idempotent");
    assert.throws(() => one.run(() => handle.embed("Retired query")), { code: "MEMORY_SCOPE_REVOKED" });
    assert.throws(() => one.run(() => handle.embedBatch(["Retired document"])), { code: "MEMORY_SCOPE_REVOKED" });
    await delay(20); assert.equal(settled, false); assert.equal(executor.closed, false);
    assert.ok(executor.pending.size > 0);
    f.server.open("props.gate"); await call; await closing;
    assert.equal(executor.pending.size, 0); assert.equal(executor.closed, false);
    assert.throws(() => one.run(() => handle.embed("Still retired")), { code: "MEMORY_SCOPE_REVOKED" });
  },
  async switches(f) {
    const one = f.create("one", { provider: "shoggoth-e5" }); one.write("Amber observatory."); await one.index.sync();
    const old = one.index.searchOwner, e5Before = f.e5Calls.length;
    one.change({ provider: "local" }); await one.index.sync(); sameGeneration(one); assert.equal(old.closed, true);
    await one.index.search("Amber", { minScore: 0, record: false }); assert.equal(f.e5Calls.length, e5Before);
    const local = one.index.searchOwner, before = one.chunks();
    one.change({ enabled: false }); await one.index.sync(); assert.equal(local.closed, true);
    assert.equal(one.index.searchOwner, null); assert.deepEqual(one.chunks(), before);
    assert.deepEqual(await one.index.search("Amber"), []); assert.deepEqual(await one.index.listTriggerCandidates({ limit: 2 }), []);
    one.change({ enabled: true, provider: "none" }); await one.index.sync(); assert.equal(one.chunks()[0].model, "fts-only");
    one.write("Amber observatory after E5 is restored.");
    one.change({ provider: "shoggoth-e5" }); await one.index.sync(); assert.ok(f.e5Calls.length > e5Before);
    assert.equal(one.chunks()[0].model, "invented-e5-resource");
  },
  async failure(f) {
    const one = f.create(); one.write("Amber observatory."); await one.index.sync(); const before = one.chunks();
    fs.writeFileSync(f.server.file("request.mode"), "error"); one.write("Amber observatory changed by invented fixture.");
    await assert.rejects(one.index.sync(), { code: "MEMORY_EMBEDDING_UNAVAILABLE" });
    assert.deepEqual(one.chunks(), before, "failed local document calls must retain the existing semantic rows");
    fs.unlinkSync(f.server.file("request.mode")); await one.index.sync(); sameGeneration(one);
    assert.match(one.chunks()[0].text, /changed/); assert.equal(f.e5Calls.length, 0);
    assert.ok(f.leases.every(lease => lease.releases === 1));
  },
  async modelMismatch(f) {
    const one = f.create(); one.write("Amber verified model."); await one.index.sync(); const before = one.chunks();
    fs.writeFileSync(f.server.file("request.mode"), "wrong-model"); one.write("Amber source after unexpected runtime model switch.");
    await assert.rejects(one.index.sync(), { code: "MEMORY_EMBEDDING_UNAVAILABLE" });
    assert.deepEqual(one.chunks(), before, "An actual model-path mismatch must not publish the other model's vectors");
    assert.equal(f.e5Calls.length, 0);
    assert.ok(rows(f.server.file("requests.jsonl")).some(row => row.url.startsWith("/props?") && row.loaded === f.modelB));
  },
  async retirement(f) {
    const one = f.create(); one.write("Amber observatory."); await one.index.sync(); const old = one.index.searchOwner;
    f.server.open("props.hold");
    const querying = one.index.search("Amber", { minScore: 0, record: false });
    const rejected = assert.rejects(querying, { code: "MEMORY_CONFIG_CHANGED" });
    await until(() => rows(f.server.file("props-held.jsonl")).length > 0, "Physical native inspection did not pause");
    const before = one.chunks(); one.change({ local: { modelPath: f.modelB } });
    let settled = false; const reload = one.index.sync().then(() => { settled = true; });
    await rejected; await delay(30);
    assert.equal(settled, false, "replacement must join native metadata work after logical query cancellation");
    assert.equal(old.closed, false); assert.equal(old.executor.closed, true); assert.ok(old.executor.pending.size > 0);
    assert.deepEqual(one.chunks(), before);
    f.server.open("props.gate"); await reload; sameGeneration(one);
    assert.equal(old.closed, true); assert.equal(old.executor.pending.size, 0); assert.equal(one.index.model, f.modelB);
    assert.equal(one.index.embeddingDimensions, 2); assert.deepEqual(core.decodeMemoryEmbedding(one.chunks()[0].embedding), [0, 1]);
    const oldKey = old.cacheKey; assert.equal(old.embeddingProbeCache.has(oldKey), false);
  },
  async documentsRetirement(f) {
    const one = f.create(); one.write("Amber observatory."); await one.index.sync(); const old = one.index.searchOwner, before = one.chunks();
    one.write("Amber observatory document held before publication."); f.server.open("props.hold");
    const indexing = one.index.sync(), rejected = assert.rejects(indexing, { code: "MEMORY_CONFIG_CHANGED" });
    await until(() => rows(f.server.file("props-held.jsonl")).length > 0, "Physical document metadata did not pause");
    one.change({ local: { modelPath: f.modelB } });
    let settled = false; const reload = one.index.sync().then(() => { settled = true; });
    await delay(20); assert.equal(settled, false); assert.deepEqual(one.chunks(), before);
    f.server.open("props.gate"); await rejected; await reload; sameGeneration(one);
    assert.equal(old.closed, true); assert.equal(one.index.model, f.modelB);
    assert.ok(one.chunks().every(row => row.model === f.modelB && core.decodeMemoryEmbedding(row.embedding)[1] === 1));
  },
  async defaultIdentity(f) {
    const one = f.create("one", { modelPath: f.defaultPath }); one.write("Amber default model."); await one.index.sync(); sameGeneration(one);
    assert.equal(one.index.model, core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    assert.ok(one.index.providerIdentities.some(identity => identity.model === f.defaultPath));
    assert.ok(one.index.providerIdentities.some(identity => identity.model === core.DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE));
    assert.equal(one.index.searchOwner.provider[Symbol.for("openclaw.localEmbeddingRuntimeFacts")]().model.path, f.defaultPath);
    await one.index.search("Amber default", { minScore: 0, record: false });
    assert.ok(f.embeds().every(row => row.loaded === f.defaultPath)); assert.equal(f.e5Calls.length, 0);
  },
};

async function runCase(name, directory) {
  const f = await fixture(directory), errors = [];
  process.once("SIGTERM", f.terminate);
  try { await cases[name](f); } catch (error) { errors.push(error); }
  try { await f.cleanupIndexes(); } catch (error) { errors.push(error); }
  process.removeListener("SIGTERM", f.terminate);
  if (errors.length) throw new AggregateError(errors, `Product local-index ${name} failed`);
  process.stdout.write(`fixture-local-index-ok:${name}\n`);
}

if (process.argv[2] === "--local-index-case") {
  runCase(process.argv[3], process.argv[4]).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const test = require("node:test");
  for (const name of Object.keys(cases)) test(`Product managed GGUF index: ${name}`, { timeout: 45_000 }, async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `shoggoth-local-index-${name}-`));
    const child = spawn(process.execPath, [__filename, "--local-index-case", name, directory], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let output = "", error = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { error += value; });
    const closed = once(child, "close"), timer = setTimeout(() => child.kill("SIGTERM"), 35_000);
    try {
      const [code, signal] = await closed; assert.equal(signal, null, error); assert.equal(code, 0, `${output}\n${error}\nRetained fixture: ${directory}`);
      assert.match(output, new RegExp(`fixture-local-index-ok:${name}`));
      fs.rmSync(directory, { recursive: true, force: true });
    } finally { clearTimeout(timer); }
  });
}
