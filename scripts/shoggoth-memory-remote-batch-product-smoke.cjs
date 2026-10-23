"use strict";

// Product index + Service credential resources + original OpenAI batch runtime.
// All files, settings and keys are synthetic; all HTTP is bound to 127.0.0.1.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

if (!process.versions.electron) {
  test("Product OpenAI batch checks run under actual Electron and exit naturally", { timeout: 60000 }, async t => {
    const { stdout, stderr } = await promisify(execFile)(require("electron"), ["--test", "--test-reporter=tap", __filename], {
      cwd: path.resolve(__dirname, ".."), env: { ELECTRON_RUN_AS_NODE: "1" }, timeout: 55000, maxBuffer: 512 * 1024,
    });
    assert.match(stdout, /# fail 0/u);
    assert.match(stdout, /"electron":"44\.4\.2"/u);
    assert.match(stdout, /"physicalCleanup":true/u);
    t.diagnostic(stdout.trim());
    if (stderr.trim()) t.diagnostic(stderr.trim());
  });
} else {
  const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
  const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
  const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");
  const { MemoryRemoteProviderResources } = require("../app/agent-service/shoggoth-memory/remote-provider-resources.cjs");
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const key = "synthetic-product-openai-batch-key", role = "synthetic-document-role";
  const json = (res, body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  async function until(read, message) {
    const deadline = Date.now() + 10000;
    while (!read()) { if (Date.now() > deadline) assert.fail(message); await delay(5); }
  }
  function values(text) { return text.includes("Amber") ? [3, 4] : [4, 3]; }
  function assertVector(actual, expected) {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6));
  }
  async function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-memory-product-batch-")); fs.chmodSync(root, 0o700);
    const workspace = path.join(root, "one"); fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
    const requests = [], failures = [], files = new Map(), jobs = new Map(), held = [], secretReads = [];
    let credentialRevision = 0, mode = "normal", closed = false;
    const complete = job => ({ id: job.id, status: "completed", output_file_id: `output-${job.n}`,
      request_counts: { total: job.rows.length, completed: job.rows.length, failed: 0 } });
    const pending = job => ({ id: job.id, status: "in_progress", request_counts: { total: job.rows.length, completed: 0, failed: 0 } });
    const server = http.createServer((req, res) => { void (async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), text = bytes.toString("utf8"), contentType = String(req.headers["content-type"] || "");
      const request = { method: req.method, pathname: new URL(req.url, "http://127.0.0.1").pathname,
        headers: req.headers, body: contentType.includes("application/json") && text ? JSON.parse(text) : null, rows: null, responseClosed: false };
      if (contentType.startsWith("multipart/form-data")) {
        const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
        assert.equal(form.get("purpose"), "batch");
        request.rows = (await form.get("file").text()).split("\n").filter(Boolean).map(JSON.parse);
      }
      requests.push(request); res.once("close", () => { request.responseClosed = true; });
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      if (req.method === "POST" && request.pathname === "/v1/files") {
        assert.ok(request.rows?.length); const id = `input-${files.size + 1}`; files.set(id, request.rows);
        if (mode === "rotate-after-upload") credentialRevision++;
        json(res, { id }); return;
      }
      if (req.method === "POST" && request.pathname === "/v1/batches") {
        const n = jobs.size + 1, job = { n, id: `job-${n}`, rows: files.get(request.body.input_file_id), polls: 0 };
        assert.ok(job.rows); jobs.set(job.id, job); json(res, pending(job)); return;
      }
      if (req.method === "GET" && request.pathname.startsWith("/v1/batches/")) {
        const job = jobs.get(request.pathname.split("/").at(-1)); assert.ok(job); job.polls++;
        if (mode === "hold-poll") { held.push({ request, finish: () => { if (!res.destroyed) json(res, complete(job)); } }); return; }
        json(res, complete(job)); return;
      }
      if (req.method === "GET" && request.pathname.startsWith("/v1/files/output-")) {
        const job = jobs.get(`job-${request.pathname.match(/output-(\d+)/u)[1]}`); assert.ok(job);
        res.setHeader("content-type", "application/jsonl");
        res.end(job.rows.slice().reverse().map(row => JSON.stringify({ custom_id: row.custom_id,
          response: { status_code: 200, body: { data: [{ embedding: values(row.body.input) }] } } })).join("\n") + "\n"); return;
      }
      if (req.method === "POST" && request.pathname === "/v1/embeddings") {
        const inputs = Array.isArray(request.body.input) ? request.body.input : [request.body.input];
        json(res, { data: inputs.map((text, index) => ({ index, embedding: values(text) })) }); return;
      }
      throw new Error(`Unexpected synthetic batch route: ${request.method} ${request.pathname}`);
    })().catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end("Synthetic batch fixture failed"); }); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const paths = { trustedRoot: root, stateDir: path.join(root, "state"), agentsDir: path.join(root, "agents") };
    const database = new MemoryDatabase({ paths, databasePath: path.join(paths.agentsDir, "one.sqlite") }); database.open();
    const config = { _shoggothConfigRevision: 0, memory: { search: { provider: "openai", model: "text-embedding-3-small", sources: ["memory"],
      outputDimensionality: 2, queryInputType: "synthetic-query-role", documentInputType: role, query: { minScore: 0 },
      cache: { enabled: true }, providerRefs: { openai: "synthetic-owner" }, remote: { batch: { enabled: true } } } } };
    const owner = { ownerRef: "synthetic-owner", profileId: "one", providerId: "openai", baseUrl, revision: 0,
      credentialRef: "synthetic-key-ref", credentialKind: "external-provider-api-key" };
    const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
      roster: () => [{ id: "one", workspace }], sessions: { list: () => [] } });
    const resources = new MemoryRemoteProviderResources({ getConfig: agentId => { assert.equal(agentId, "one"); return config; },
      assertCurrent: agentId => { assert.equal(agentId, "one"); host.assertCurrent(); },
      resolveOwner: binding => { assert.deepEqual(binding, { agentId: "one", providerId: "openai", ownerRef: "synthetic-owner" }); return owner; },
      secretStore: { listMetadata: () => [{ credentialRef: owner.credentialRef, kind: owner.credentialKind }],
        getCredentialRevision: ref => { assert.equal(ref, owner.credentialRef); return credentialRevision; },
        get: async ref => { assert.equal(ref, owner.credentialRef); secretReads.push(ref); return key; } } });
    const index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true, getConfig: () => config,
      remoteEmbeddingResources: resources, backgroundSync: false, logger: { warn() {}, debug() {} },
      embedding: { identity: "unused-E5", encode: async () => assert.fail("Product native batch must not use E5") } });
    const chunks = () => database.db.prepare("SELECT id,path,text,model,embedding FROM memory_index_chunks ORDER BY path,id").all();
    const write = (text, relative = "MEMORY.md") => fs.writeFileSync(path.join(workspace, relative), text, { mode: 0o600 });
    const close = async () => {
      if (closed) return; closed = true;
      const errors = [];
      try { await index.close(); } catch (error) { errors.push(error); }
      try { await resources.close(); } catch (error) { errors.push(error); }
      for (const entry of held.splice(0)) entry.finish();
      assert.equal(index.embeddingExecutors.size, 0); assert.equal(index.searchOwners.size, 0);
      assert.equal(resources.pending.size, 0); assert.equal(resources.handles.size, 0);
      const shadows = fs.readdirSync(path.dirname(database.path)).filter(name => name.includes(".memory-reindex-"));
      assert.deepEqual(shadows, []);
      database.close(); const stopped = once(server, "close"); server.close(); server.closeAllConnections(); await stopped;
      fs.rmSync(root, { recursive: true, force: true }); assert.deepEqual(failures, []);
      t.diagnostic(JSON.stringify({ electron: process.versions.electron, requests: requests.map(row => `${row.method} ${row.pathname}`),
        secretReads: secretReads.length, physicalCleanup: true }));
      if (errors.length) throw new AggregateError(errors, "Product batch resources failed to close");
    };
    t.after(close);
    return { config, owner, host, resources, index, database, requests, jobs, held, secretReads, chunks, write, close,
      mode: value => { mode = value; } };
  }
  function sameGeneration(f) {
    assert.equal(f.index.searchOwner.provider, f.index.embeddingExecutor.provider);
    assert.equal(f.index.searchOwner.providerRuntime.cacheKeyData, f.index.embeddingExecutor.providerRuntime.cacheKeyData);
    assert.equal(f.index.embeddingExecutor.batch.enabled, true);
    assert.equal(f.index.embeddingExecutor.providerRuntime.sourceWideBatchEmbed, true);
    assert.equal(f.index.embeddingExecutor.batch.pollIntervalMs, 2000);
    assert.ok(f.chunks().every(row => row.model === "text-embedding-3-small"));
    const persisted = JSON.stringify([f.config, ...f.database.db.prepare("SELECT * FROM memory_index_meta").all(),
      ...f.database.db.prepare("SELECT * FROM memory_embedding_cache").all()]);
    assert.equal(persisted.includes(key), false);
  }
  test("Product source-wide OpenAI text batch uploads, creates, polls, maps output and reuses native cache; query stays inline", { timeout: 20000 }, async t => {
    const f = await fixture(t);
    f.write("Amber synthetic observatory watches the northern telescope.");
    f.write("Violet synthetic observatory watches the southern telescope.", "memory/violet.md");
    await f.index.sync(); sameGeneration(f); assert.equal(f.chunks().length, 2);
    assert.deepEqual(f.requests.map(row => `${row.method} ${row.pathname}`), ["POST /v1/files", "POST /v1/batches", "GET /v1/batches/job-1", "GET /v1/files/output-1/content"]);
    const upload = f.requests[0], create = f.requests[1];
    assert.equal(upload.rows.length, 2);
    assert.ok(upload.rows.every(row => row.method === "POST" && row.url === "/v1/embeddings" && row.body.model === "text-embedding-3-small"
      && row.body.dimensions === 2 && row.body.input_type === role));
    assert.deepEqual(new Set(upload.rows.map(row => row.body.input)), new Set(f.chunks().map(row => row.text)));
    assert.equal(create.body.input_file_id, "input-1"); assert.equal(create.body.endpoint, "/v1/embeddings");
    // This transport metadata is emitted by the pinned upstream OpenAI adapter.
    // Renaming the Product module must not rewrite the upstream request contract.
    assert.equal(create.body.completion_window, "24h"); assert.deepEqual(create.body.metadata, { source: "openclaw-memory", agent: "one" });
    for (const row of f.chunks()) assertVector(core.decodeMemoryEmbedding(row.embedding), values(row.text));
    const cached = f.database.db.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get().n; assert.equal(cached, 2);
    const documents = f.requests.length;
    await f.index.sync({ force: true }); sameGeneration(f); assert.equal(f.requests.length, documents, "forced shadow rebuild must reuse the original published cache");
    const results = await f.index.search("Amber telescope", { minScore: 0, record: false });
    assert.ok(results.some(row => row.path === "MEMORY.md")); sameGeneration(f);
    const queries = f.requests.slice(documents); assert.ok(queries.length > 0);
    assert.ok(queries.every(row => row.method === "POST" && row.pathname === "/v1/embeddings" && row.body.input_type === "synthetic-query-role"));
  });
  test("Product credential revision after upload forbids batch creation, polling, output and inline fallback", { timeout: 10000 }, async t => {
    const f = await fixture(t); f.mode("rotate-after-upload"); f.write("Amber synthetic credential withdrawal batch.");
    await assert.rejects(f.index.sync(), { code: "MEMORY_CONFIG_CHANGED" });
    await until(() => f.resources.pending.size === 0 && f.index.embeddingExecutor.pending.size === 0, "retired upload work did not physically drain");
    assert.deepEqual(f.requests.map(row => `${row.method} ${row.pathname}`), ["POST /v1/files"]);
    assert.deepEqual(f.chunks(), []); await f.close();
  });
  test("Product caller cancellation ends the original batch polling delay without later requests", { timeout: 10000 }, async t => {
    const f = await fixture(t); f.write("Amber synthetic batch delay cancellation.");
    const controller = new AbortController(), operation = f.index.sync({ signal: controller.signal });
    const rejected = assert.rejects(operation, { code: "MEMORY_EMBEDDING_CANCELLED" });
    await until(() => f.jobs.size === 1, "original batch was never submitted");
    controller.abort(Object.assign(new Error("Synthetic polling cancellation"), { code: "MEMORY_EMBEDDING_CANCELLED" }));
    await rejected; await f.index.tail.catch(() => {});
    await until(() => f.resources.pending.size === 0 && f.index.embeddingExecutor.pending.size === 0, "cancelled batch delay did not physically drain");
    const count = f.requests.length; await delay(2100);
    assert.equal(f.requests.length, count); assert.equal(count, 2); assert.deepEqual(f.chunks(), []);
    await f.close();
  });
  test("Product cancellation physically aborts an in-flight native batch poll and retains published semantic rows", { timeout: 15000 }, async t => {
    const f = await fixture(t); f.write("Amber synthetic stable batch publication."); await f.index.sync(); const before = f.chunks();
    f.mode("hold-poll"); f.write("Amber synthetic changed document waits inside the native poll.");
    const controller = new AbortController(), operation = f.index.sync({ signal: controller.signal });
    const rejected = assert.rejects(operation, { code: "MEMORY_EMBEDDING_CANCELLED" });
    await until(() => f.held.length === 1, "native Product batch poll did not reach the held response");
    const held = f.held[0], count = f.requests.length;
    controller.abort(Object.assign(new Error("Synthetic held poll cancellation"), { code: "MEMORY_EMBEDDING_CANCELLED" }));
    await rejected; await f.index.tail.catch(() => {});
    await until(() => held.request.responseClosed, "native batch poll socket did not physically abort");
    assert.equal(f.resources.pending.size, 0); assert.equal(f.index.embeddingExecutor.pending.size, 0);
    assert.deepEqual(f.chunks(), before); await delay(2100); assert.equal(f.requests.length, count);
    await f.close();
  });
}
