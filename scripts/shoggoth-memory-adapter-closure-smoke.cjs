"use strict";

// Fixed adapters execute in an independent Electron process with only the core,
// bridge and Node built-ins. All keys, settings and requests are synthetic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const directory = path.resolve(__dirname, "../build/shoggoth-memory");
const revision = "c10679395819ede78bb073f979f95c157e165bfa";
const additions = ["extensions/mistral/memory-embedding-adapter.ts", "extensions/ollama/src/memory-embedding-adapter.ts", "src/plugins/embedding-provider-config.ts"];
const pinnedArgument = process.argv.indexOf("--pinned-source");
const pinnedSource = pinnedArgument < 0 ? undefined : path.resolve(process.argv[pinnedArgument + 1]);

test("every imported input matches the fixed manifest and supplied pinned checkout", t => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.revision, revision);
  const entries = new Map();
  let upstream = 0, dependencies = 0;
  for (const entry of manifest.files) {
    assert.ok(["upstream", "dependency"].includes(entry.kind));
    const key = `${entry.kind}/${entry.path}`;
    assert.equal(entries.has(key), false, `Duplicate imported input ${key}`);
    entries.set(key, entry);
    const content = fs.readFileSync(path.join(directory, entry.kind === "upstream" ? "source" : "dependencies", entry.path));
    assert.equal(crypto.createHash("sha256").update(content).digest("hex"), entry.sha256, key);
    if (entry.kind === "upstream") {
      upstream += 1;
      if (pinnedSource) assert.deepEqual(content, fs.readFileSync(path.join(pinnedSource, entry.path)), key);
    } else dependencies += 1;
  }
  for (const relative of additions) assert.ok(entries.has(`upstream/${relative}`), relative);
  t.diagnostic(JSON.stringify({ revision, upstream, dependencies, pinnedCheckoutCompared: Boolean(pinnedSource) }));
});

async function electronFixture() {
  const assert = require("node:assert/strict"), http = require("node:http"), crypto = require("node:crypto");
  const { once } = require("node:events"), Module = require("node:module"), load = Module._load;
  assert.ok(process.versions.electron, "The independent adapter fixture must execute under Electron");
  Module._load = function(id, ...args) {
    if (!Module.isBuiltin(id) && !id.startsWith(".")) throw new Error(`External adapter dependency: ${id}`);
    return load.call(this, id, ...args);
  };
  const core = require("./core.cjs"), { withMemoryHost } = require("./host-bridge.cjs");
  assert.equal(core.embeddingProviderOwnsDestination({ baseUrl: "http://127.0.0.1:1234/v1?owner=fixture", providerBaseUrl: "http://127.0.0.1:1234/v1?owner=fixture" }), true);
  assert.equal(core.embeddingProviderOwnsDestination({ baseUrl: "http://127.0.0.1:1234/v1?owner=other", providerBaseUrl: "http://127.0.0.1:1234/v1?owner=fixture" }), false);
  const requests = [];
  const values = [3, 4, ...Array(126).fill(0)];
  const server = http.createServer((req, res) => {
    void (async () => {
      const parts = []; for await (const part of req) parts.push(part);
      const raw = Buffer.concat(parts).toString("utf8"), body = raw ? JSON.parse(raw) : null;
      const request = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(request);
      res.setHeader("content-type", "application/json");
      if (req.url.includes("/models/")) res.end(JSON.stringify(body.requests
        ? { embeddings: body.requests.map(() => ({ values })) } : { embedding: { values } }));
      else if (req.url.endsWith("/api/embed")) res.end(JSON.stringify({ embeddings: (Array.isArray(body.input) ? body.input : [body.input]).map(() => [3, 4, 99]) }));
      else res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [3, 4] })).reverse() }));
    })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`, deadline = () => AbortSignal.timeout(3000);
  const text = "Fictional coral observatory.";
  const adapters = {
    openai: core.openAiMemoryEmbeddingProviderAdapter,
    gemini: core.geminiMemoryEmbeddingProviderAdapter,
    voyage: core.voyageMemoryEmbeddingProviderAdapter,
    mistral: core.mistralMemoryEmbeddingProviderAdapter,
    ollama: core.ollamaMemoryEmbeddingProviderAdapter,
    "openai-compatible": core.openAICompatibleEmbeddingProviderAdapter,
  };
  const models = { openai: "openai/text-embedding-3-small", gemini: "models/google/gemini-embedding-2", voyage: "voyage/voyage-3-lite",
    mistral: "mistral/mistral-embed", ollama: "ollama/nomic-embed-text", "openai-compatible": "fixture-custom/fixture-model" };
  const created = new Map();
  try {
    for (const [id, adapter] of Object.entries(adapters)) {
      assert.equal(adapter.id, id); assert.equal(adapter.transport, "remote");
      const key = `synthetic-adapter-${id}-placeholder`, providerId = id === "openai-compatible" ? "fixture-custom" : id;
      const options = { config: {}, provider: providerId, model: models[id], fallback: "none", dimensions: id === "gemini" ? 128 : 2,
        inputType: "fixture-general", queryInputType: "fixture-query", documentInputType: "fixture-document",
        remote: { baseUrl, apiKey: key, headers: { "x-fixture-tenant": "synthetic-tenant" } } };
      const result = await adapter.create(options), { provider, runtime } = result;
      assert.ok(provider && runtime); assert.equal(runtime.id, id); assert.ok(runtime.cacheKeyData);
      assert.equal(JSON.stringify(runtime.cacheKeyData).includes(key), false);
      const rotated = await adapter.create({ ...options, remote: { ...options.remote, apiKey: key + "-rotated" } });
      assert.deepEqual(rotated.runtime.cacheKeyData, runtime.cacheKeyData, `${id} key rotation must not change embedding identity`);
      await rotated.provider.close?.();
      created.set(id, result);
      const count = requests.length;
      const query = await provider.embed(text, { inputType: "query", signal: deadline() });
      const vectors = await provider.embedBatch([text, { text: "Fictional second document." }], { inputType: "document", signal: deadline() });
      assert.equal(vectors.length, 2); assert.equal(requests.length, count + 2);
      const q = requests[count], d = requests[count + 1];
      assert.equal(q.method, "POST"); assert.equal(d.method, "POST");
      assert.equal(q.headers["x-fixture-tenant"], "synthetic-tenant");
      if (id === "gemini") {
        assert.equal(q.headers["x-goog-api-key"], key); assert.equal(q.headers.authorization, undefined);
        assert.equal(provider.model, "gemini-embedding-2");
        assert.equal(q.url, "/v1/models/gemini-embedding-2:embedContent");
        assert.equal(d.url, "/v1/models/gemini-embedding-2:batchEmbedContents");
        assert.deepEqual(q.body.content.parts, [{ text: `task: search result | query: ${text}` }]);
        assert.equal(q.body.taskType, undefined); assert.equal(q.body.outputDimensionality, 128);
        assert.deepEqual(d.body.requests[0].content.parts, [{ text: `title: none | text: ${text}` }]);
        assert.equal(query.length, 128); assert.deepEqual(query.slice(0, 2), [0.6, 0.8]);
      } else {
        assert.equal(q.headers.authorization, `Bearer ${key}`); assert.equal(d.headers.authorization, `Bearer ${key}`);
        if (id === "ollama") {
          assert.equal(q.url, "/api/embed"); assert.equal(d.url, "/api/embed");
          assert.equal(provider.model, "nomic-embed-text"); assert.equal(q.body.input, `search_query: ${text}`);
          assert.deepEqual(d.body.input, [text, "Fictional second document."]); assert.deepEqual(query, [0.6, 0.8]);
          assert.equal(runtime.inlineBatchTimeoutMs, 600000);
          assert.equal(runtime.cacheKeyData.headersHash, crypto.createHash("sha256").update(JSON.stringify([["x-fixture-tenant", "synthetic-tenant"]])).digest("hex"));
        } else {
          assert.equal(q.url, "/v1/embeddings"); assert.equal(d.url, "/v1/embeddings"); assert.deepEqual(query, [3, 4]);
          assert.deepEqual(q.body.input, [text]); assert.deepEqual(d.body.input, [text, "Fictional second document."]);
          if (["openai", "openai-compatible"].includes(id)) {
            assert.equal(q.body.dimensions, 2); assert.equal(q.body.input_type, "fixture-query"); assert.equal(d.body.input_type, "fixture-document");
          } else if (id === "voyage") { assert.equal(q.body.input_type, "query"); assert.equal(d.body.input_type, "document"); }
          else { assert.equal(q.body.input_type, undefined); assert.equal(q.body.dimensions, undefined); }
          if (id === "mistral") {
            assert.equal(provider.model, "mistral-embed");
            assert.deepEqual(runtime.cacheKeyData, { provider: "mistral", model: "mistral-embed", baseUrl, headers: [["x-fixture-tenant", "synthetic-tenant"]] });
          }
          if (id === "voyage") assert.equal(provider.model, "voyage-3-lite");
          if (id === "openai") assert.equal(provider.model, "openai/text-embedding-3-small");
          if (id === "openai-compatible") {
            assert.equal(provider.model, "fixture-model"); assert.equal(runtime.inlineBatchTimeoutMs, 600000);
            assert.equal(runtime.cacheKeyData.provider, "fixture-custom");
          }
        }
      }
      const beforeRef = requests.length;
      await assert.rejects(adapter.create({ ...options, remote: { baseUrl, apiKey: { source: "env", provider: "default", id: "SYNTHETIC_UNRESOLVED" } } }), /SecretRef|secret.*not.*resolved|unresolved/i);
      assert.equal(requests.length, beforeRef);
      if (!["ollama", "openai-compatible"].includes(id)) {
        await assert.rejects(adapter.create({ ...options, remote: { baseUrl } }), /credentials are not configured|Service credential/);
        assert.equal(requests.length, beforeRef);
      }
    }
    const configs = { models: { providers: { Router: { api: "openai-responses" }, legacy: { baseUrl }, ollamaTenant: { api: "ollama" }, googleTenant: { api: "google-generative-ai" } } } };
    assert.equal(core.resolveConfiguredGenericEmbeddingProviderId("router", configs), "openai-compatible");
    assert.equal(core.resolveConfiguredGenericEmbeddingProviderId("legacy", configs), "openai-compatible");
    assert.equal(core.resolveConfiguredGenericEmbeddingProviderId("ollamaTenant", configs), "ollama");
    assert.equal(core.resolveConfiguredGenericEmbeddingProviderId("googleTenant", configs), "google-generative-ai");
    assert.equal(core.resolveConfiguredGenericEmbeddingProviderId("missing", configs), undefined);
    const host = { assertCurrent() {}, getMemoryEmbeddingProvider(id) { return adapters[id]; } };
    const beforeIdentity = requests.length;
    const identity = withMemoryHost(host, () => core.resolveEmbeddingProviderIndexIdentity({ config: {}, provider: "mistral", model: "", fallback: "none" }));
    assert.deepEqual(identity.provider, { id: "mistral", model: "mistral-embed" });
    assert.equal(requests.length, beforeIdentity);
    for (const [id, adapter] of Object.entries(adapters)) assert.equal(adapter.supportsMultimodalEmbeddings?.({ model: "gemini-embedding-2" }) ?? false, id === "gemini");
    assert.equal(adapters.gemini.supportsMultimodalEmbeddings({ model: "gemini-embedding-001" }), false);
    const media = { text: "Fictional image label", parts: [{ type: "text", text: "Fictional image label" }, { type: "inline-data", mimeType: "image/png", data: "AA==" }] };
    const beforeMedia = requests.length;
    assert.equal(await created.get("gemini").runtime.batchEmbed({ chunks: [{ text: media.text, embeddingInput: media }], agentId: "synthetic-adapter", wait: true, concurrency: 1, pollIntervalMs: 1, timeoutMs: 500 }), null);
    await assert.rejects(created.get("openai-compatible").provider.embed(media, { signal: deadline() }), /only support text/);
    assert.equal(requests.length, beforeMedia);
    await created.get("gemini").provider.embedBatch([media], { inputType: "document", signal: deadline() });
    assert.deepEqual(requests.at(-1).body.requests[0].content.parts, [{ text: media.text }, { inlineData: { mimeType: "image/png", data: "AA==" } }]);
    const noAuth = await adapters.ollama.create({ config: {}, model: "fixture", remote: { baseUrl } });
    await noAuth.provider.embed(text, { signal: deadline() }); assert.equal(requests.at(-1).headers.authorization, undefined);
    await noAuth.provider.close?.();
    process.stdout.write(JSON.stringify({ verified: true, electron: process.versions.electron, node: process.versions.node, adapters: Object.keys(adapters), requests: requests.length, externalDependencies: 0 }));
  } finally {
    await Promise.allSettled([...created.values()].map(result => result.provider.close?.()));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

test("all six original adapter runtimes and pure resolvers work in a standalone Electron loopback fixture", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-adapter-closure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["core.cjs", "host-bridge.cjs"]) fs.copyFileSync(path.join(__dirname, "../app/agent-service/shoggoth-memory", name), path.join(root, name));
  const script = path.join(root, "adapter-fixture.cjs");
  fs.writeFileSync(script, `(${electronFixture.toString()})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });\n`);
  const { stdout } = await promisify(execFile)(require("electron"), [script], { cwd: root, env: { ELECTRON_RUN_AS_NODE: "1" }, timeout: 20000, maxBuffer: 256 * 1024 });
  const evidence = JSON.parse(stdout); assert.equal(evidence.verified, true); assert.equal(evidence.adapters.length, 6); assert.equal(evidence.externalDependencies, 0);
  t.diagnostic(JSON.stringify(evidence));
});
