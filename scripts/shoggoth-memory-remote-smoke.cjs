"use strict";

// These tests use synthetic text/keys and servers bound exclusively to loopback.
// They do not instantiate a Product provider, read the Vault, or call a vendor.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const core = require("../app/agent-service/shoggoth-memory/core.cjs");
const { withMemoryHost } = require("../app/agent-service/shoggoth-memory/host-bridge.cjs");
const { validateNativeMemoryConfigProjection } = require("../app/agent-service/native-memory-config-protocol");

const fixtureKey = "synthetic-memory-test-placeholder";
const input = "Fictional amber telescope catalogue.";
const deadline = () => AbortSignal.timeout(3000);
async function localServer(t, handle) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const request = { method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null };
    requests.push(request);
    await handle(request, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const ended = once(server, "close"); server.close(); server.closeAllConnections(); await ended; });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
const vectors = (request, res) => res.end(JSON.stringify({ data: request.body.input.map((_, index) => ({ index, embedding: [index + 1, 0.5] })).reverse() }));
const options = (server, extra = {}) => ({ config: {}, agentDir: "/private/tmp/unused-memory-fixture", model: "fixture-embedding", fallback: "none",
  remote: { baseUrl: server.baseUrl, apiKey: fixtureKey }, ...extra });
const geminiValues = () => [3, 4, ...Array(126).fill(0)];
const geminiVector = () => [0.6, 0.8, ...Array(126).fill(0)];
const geminiVectors = (request, res) => res.end(JSON.stringify(request.body?.requests
  ? { embeddings: request.body.requests.map(() => ({ values: geminiValues() })) }
  : { embedding: { values: geminiValues() } }));
const geminiOptions = (server, extra = {}) => options(server, { model: "google/gemini-embedding-001", dimensions: 128, ...extra });

test("copied provider factories work without checkout or external transport dependencies", async t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-transport-bundle-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ["core.cjs", "host-bridge.cjs"]) fs.copyFileSync(path.join(__dirname, "../app/agent-service/shoggoth-memory", name), path.join(directory, name));
  const script = `
    const Module = require('node:module'), load = Module._load;
    Module._load = function(id, ...args) { if (['undici', 'typebox', 'string-width', 'strip-ansi'].includes(id.split('/')[0])) throw new Error('Unbundled dependency'); return load.call(this, id, ...args); };
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      req.resume();
      res.end(req.url.includes('/models/') ? '{"embedding":{"values":[3,4]}}'
        : req.url.includes('/api/embed') ? '{"embeddings":[[3,4]]}' : '{"data":[{"embedding":[1,0]}]}');
    });
    server.listen(0, '127.0.0.1', async () => {
      try {
        const core = require('./core.cjs');
        const { provider } = await core.createOpenAiEmbeddingProvider({ config: {}, model: 'fixture', remote: {
          apiKey: 'synthetic-placeholder', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' } });
        const result = await provider.embed('fictional item', { signal: AbortSignal.timeout(2000) });
        if (JSON.stringify(result) !== '[1,0]') throw new Error('Invalid fixture result');
        for (const create of [core.createGeminiEmbeddingProvider, core.createOllamaEmbeddingProvider]) {
          const next = await create({ config: {}, model: 'fixture', remote: {
            apiKey: 'synthetic-placeholder', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' } });
          const vector = await next.provider.embed('fictional item', { inputType: 'query', signal: AbortSignal.timeout(2000) });
          if (JSON.stringify(vector) !== '[0.6,0.8]') throw new Error('Invalid bundled provider result');
        }
        process.stdout.write('bundled-transport-ok');
      } catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
      finally { server.close(); server.closeAllConnections(); }
    });`;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", script], { cwd: directory, timeout: 5000 });
  assert.equal(stdout, "bundled-transport-ok");
});

test("upstream OpenAI-compatible request preserves router model, dimensions, input kinds and response order", async t => {
  const server = await localServer(t, vectors);
  const { provider } = await core.createOpenAiEmbeddingProvider(options(server, {
    model: "openai/text-embedding-3-small", dimensions: 2, queryInputType: "search_query", documentInputType: "search_document",
  }));
  assert.deepEqual(await provider.embedBatch([input, "A fictional second item."], { signal: deadline() }), [[1, 0.5], [2, 0.5]]);
  assert.deepEqual(await provider.embed(input, { inputType: "query", signal: deadline() }), [1, 0.5]);
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0].url, "/v1/embeddings");
  assert.equal(server.requests[0].headers.authorization, `Bearer ${fixtureKey}`);
  assert.deepEqual(server.requests.map(row => row.body.input_type), ["search_document", "search_query"]);
  assert.equal(server.requests[0].body.model, "openai/text-embedding-3-small");
  assert.equal(server.requests[0].body.dimensions, 2);
});

test("native OpenAI factory normalizes its own prefix without making a request", async () => {
  const { client, provider } = await core.createOpenAiEmbeddingProvider({ config: {}, model: "openai/text-embedding-3-small",
    remote: { apiKey: fixtureKey }, fallback: "none" });
  assert.equal(client.model, "text-embedding-3-small");
  assert.equal(provider.maxInputTokens, 8192);
  assert.equal(core.OPENAI_DEFAULT_EMBEDDING_MODEL, "text-embedding-3-small");
});

test("Mistral and Voyage use original model normalization and Voyage query/document payloads", async t => {
  const server = await localServer(t, vectors);
  const mistral = await core.createMistralEmbeddingProvider(options(server, { model: "mistral/mistral-embed" }));
  const voyage = await core.createVoyageEmbeddingProvider(options(server, { model: "voyage/voyage-3-lite" }));
  await mistral.provider.embed(input, { inputType: "query", signal: deadline() });
  await voyage.provider.embed(input, { inputType: "query", signal: deadline() });
  await voyage.provider.embed(input, { inputType: "document", signal: deadline() });
  assert.deepEqual(server.requests.map(row => row.body.model), ["mistral-embed", "voyage-3-lite", "voyage-3-lite"]);
  assert.deepEqual(server.requests.map(row => row.body.input_type), [undefined, "query", "document"]);
  assert.equal(voyage.provider.maxInputTokens, 16000);
  assert.equal(core.DEFAULT_MISTRAL_EMBEDDING_MODEL, "mistral-embed");
  assert.equal(core.DEFAULT_VOYAGE_EMBEDDING_MODEL, "voyage-4-large");
});

test("upstream response validation rejects missing, duplicated, mixed, empty and nonfinite rows", async t => {
  let payload;
  const server = await localServer(t, (_request, res) => res.end(payload));
  const { provider } = await core.createOpenAiEmbeddingProvider(options(server));
  const rows = [[], [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }],
    [{ index: 0, embedding: [1] }, { embedding: [2] }], [{ embedding: [] }, { embedding: [1] }],
    [{ index: -1, embedding: [1] }, { index: 1, embedding: [2] }], [{ embedding: [null] }, { embedding: [2] }]];
  for (const data of rows) {
    payload = JSON.stringify({ data });
    await assert.rejects(provider.embedBatch([input, input], { signal: deadline() }), /malformed JSON response/);
  }
  payload = '{"data":[{"embedding":[1e999]},{"embedding":[2]}]}';
  await assert.rejects(provider.embedBatch([input, input], { signal: deadline() }), /malformed JSON response/);
});

test("bounded original response reader rejects oversized, invalid UTF-8 and invalid JSON bodies", async () => {
  await assert.rejects(core.readResponseJsonWithLimit(new Response("{}", { headers: { "content-length": "999" } }), { maxBytes: 16, errorPrefix: "fixture" }), /too large|exceed/i);
  await assert.rejects(core.readResponseJsonWithLimit(new Response("x".repeat(65)), { maxBytes: 64, errorPrefix: "fixture" }), /too large|exceed/i);
  await assert.rejects(core.readResponseJsonWithLimit(new Response(new Uint8Array([0xff, 0xff])), { maxBytes: 64, errorPrefix: "fixture" }), /encoded data|encoding/i);
  await assert.rejects(core.readResponseJsonWithLimit(new Response("{broken"), { errorPrefix: "fixture" }), /malformed JSON/);
});

test("HTTP failures expose status without reflected memory or credential body", async t => {
  const server = await localServer(t, (_req, res) => { res.statusCode = 401; res.end(`${input} ${fixtureKey}`); });
  const { provider } = await core.createOpenAiEmbeddingProvider(options(server));
  await assert.rejects(provider.embed(input, { signal: deadline() }), error => {
    assert.equal(error.status, 401); assert.equal(error.code, "MEMORY_EMBEDDING_HTTP_FAILED");
    assert.ok(!String(error).includes(input)); assert.ok(!String(error).includes(fixtureKey));
    return true;
  });
});

test("cancellation closes a stalled response body and does not retry", async t => {
  let ready;
  const headersSent = new Promise(resolve => { ready = resolve; });
  const server = await localServer(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"data":['); ready(); });
  const { provider } = await core.createOpenAiEmbeddingProvider(options(server));
  const controller = new AbortController();
  const result = provider.embed(input, { signal: AbortSignal.any([controller.signal, deadline()]) });
  const checked = assert.rejects(result);
  await headersSent;
  controller.abort(new Error("fixture cancelled"));
  await checked;
  assert.equal(server.requests.length, 1);
});

test("request authority is rechecked immediately before dispatch, including redirects", async t => {
  const target = await localServer(t, vectors);
  const source = await localServer(t, (_req, res) => { res.writeHead(307, { location: `${target.baseUrl}/embeddings` }); res.end(); });
  const { provider } = await core.createOpenAiEmbeddingProvider(options(source));
  let checks = 0;
  await assert.rejects(core.withGuardedFetchRequestAuthority(() => {}, () => provider.embed(input, { signal: deadline() }), () => {
    if (++checks === 2) throw new Error("fixture authority revoked");
  }), /authority revoked/);
  assert.equal(source.requests.length, 1); assert.equal(target.requests.length, 0);
});

test("original redirect guard does not forward credentials or unsafe body across origins", async t => {
  const target = await localServer(t, (_request, res) => res.end('{"data":[{"embedding":[1,0]}]}'));
  const source = await localServer(t, (_req, res) => { res.writeHead(307, { location: `${target.baseUrl}/embeddings` }); res.end(); });
  const { provider } = await core.createOpenAiEmbeddingProvider(options(source));
  await provider.embed(input, { signal: deadline() });
  assert.equal(target.requests.length, 1);
  assert.equal(target.requests[0].headers.authorization, undefined);
  assert.equal(target.requests[0].body, null);
});

test("redirect cannot reuse the configured hostname exception for another loopback host", async t => {
  const source = await localServer(t, (_req, res) => { res.writeHead(307, { location: "http://127.0.0.2:1/embeddings" }); res.end(); });
  const { provider } = await core.createOpenAiEmbeddingProvider(options(source));
  await assert.rejects(provider.embed(input, { signal: deadline() }), error => error.name === "SsrFBlockedError");
  assert.equal(source.requests.length, 1);
});

test("inherited debug-proxy flag does not load Gateway capture or break the Service transport", async t => {
  const server = await localServer(t, vectors);
  const previous = process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
  process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
  try {
    const { provider } = await core.createOpenAiEmbeddingProvider(options(server));
    assert.deepEqual(await provider.embed(input, { signal: deadline() }), [1, 0.5]);
    assert.equal(server.requests.length, 1);
  } finally { if (previous === undefined) delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED; else process.env.OPENCLAW_DEBUG_PROXY_ENABLED = previous; }
});

test("missing credentials do not discover environment keys or contact the endpoint", async t => {
  const server = await localServer(t, vectors);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = fixtureKey;
  try {
    await assert.rejects(core.createOpenAiEmbeddingProvider(options(server, { remote: { baseUrl: server.baseUrl } })), /credentials are not configured|Service credential/);
    assert.equal(server.requests.length, 0);
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

test("original fallback resolver drops primary endpoint and auth and uses fallback model", async () => {
  let actual;
  const host = { assertCurrent() {}, getMemoryEmbeddingProvider(id) {
    return id === "primary" ? { id, defaultModel: "primary-default", create: async () => { throw new Error("synthetic setup failure"); } }
      : { id, defaultModel: "fallback-default", create: async options => { actual = options; return { provider: { id, model: options.model } }; } };
  } };
  const result = await withMemoryHost(host, () => core.createEmbeddingProvider({ config: {}, provider: "primary", model: "chosen-primary-model", fallback: "secondary",
    remote: { baseUrl: "http://127.0.0.1:1/v1", apiKey: fixtureKey, headers: { Authorization: `Bearer ${fixtureKey}` }, batch: { enabled: false } } }));
  assert.equal(result.fallbackFrom, "primary"); assert.equal(result.provider.id, "secondary");
  assert.equal(actual.model, "fallback-default");
  assert.deepEqual(actual.remote, { batch: { enabled: false } }); assert.equal(actual.fallback, "none");
});

test("production config permits formal remote fields and opaque owners while rejecting credential routing", () => {
  const search = { provider: "openai", model: "text-embedding-3-small", fallback: "mistral",
    inputType: "search", queryInputType: "query", documentInputType: "document", outputDimensionality: 128,
    providerRefs: { openai: "fictional-primary", mistral: "fictional-fallback" },
    remote: { baseUrl: "https://fictional.example.invalid/v1", headers: { "X-Project": "fixture" }, batch: { enabled: false } } };
  assert.deepEqual(validateNativeMemoryConfigProjection({ revision: 1, config: { memory: { search } } }).config.memory.search, search);
  for (const invalidSearch of [{ provider: "invalid/provider" }, { remote: { apiKey: fixtureKey } },
    { credentialRef: "synthetic-account" }, { providerRefs: { openai: { credentialRef: "synthetic-account" } } },
    { remote: { headers: { Authorization: "Bearer fictional" } } }, { remote: { headers: { "X-Api-Key": "fictional" } } },
    { remote: { baseUrl: "https://user:fictional@example.invalid/v1" } }, { taskType: "RETRIEVAL_QUERY" },
    { provider: "gemini", model: "gemini-embedding-001", multimodal: { enabled: true } },
    { provider: "gemini", model: "gemini-embedding-2", fallback: "openai", multimodal: { enabled: true } }]) {
    assert.throws(() => validateNativeMemoryConfigProjection({ revision: 1, config: { memory: { search: invalidSearch } } }), error => error.code === "NATIVE_MEMORY_CONFIG_INVALID");
  }
});

test("Gemini 001 preserves native routes, query/document tasks and vector normalization", async t => {
  const server = await localServer(t, geminiVectors);
  const { provider, client } = await core.createGeminiEmbeddingProvider(geminiOptions(server));
  assert.equal(provider.id, "gemini");
  assert.equal(provider.model, "gemini-embedding-001");
  assert.equal(provider.maxInputTokens, 2048);
  assert.equal(client.modelPath, "models/gemini-embedding-001");
  assert.equal(core.DEFAULT_GEMINI_EMBEDDING_MODEL, "gemini-embedding-001");
  assert.deepEqual(await provider.embed(input, { inputType: "query", signal: deadline() }), geminiVector());
  assert.deepEqual(await provider.embedBatch([input, "A second fictional document."], { signal: deadline() }), [geminiVector(), geminiVector()]);
  const [query, batch] = server.requests;
  assert.equal(query.url, "/v1/models/gemini-embedding-001:embedContent");
  assert.equal(batch.url, "/v1/models/gemini-embedding-001:batchEmbedContents");
  assert.equal(query.headers["x-goog-api-key"], fixtureKey);
  assert.equal(query.headers["content-type"], "application/json");
  assert.equal(query.headers["x-goog-api-client"], undefined);
  assert.deepEqual(query.body, { content: { parts: [{ text: input }] }, taskType: "RETRIEVAL_QUERY", outputDimensionality: 128 });
  assert.deepEqual(batch.body.requests.map(row => [row.model, row.taskType, row.outputDimensionality]),
    Array(2).fill(["models/gemini-embedding-001", "RETRIEVAL_DOCUMENT", 128]));
});

test("stable Gemini 2 uses original text prefixes and image/audio inline payloads", async t => {
  const server = await localServer(t, geminiVectors);
  const { provider } = await core.createGeminiEmbeddingProvider(geminiOptions(server, { model: "models/google/gemini-embedding-2", taskType: "QUESTION_ANSWERING" }));
  const image = { text: "Fictional image caption", parts: [{ type: "text", text: "Fictional image caption" },
    { type: "inline-data", mimeType: "image/png", data: Buffer.from("synthetic image bytes").toString("base64") }] };
  const audio = { text: "Fictional audio caption", parts: [{ type: "inline-data", mimeType: "audio/wav", data: Buffer.from("synthetic audio bytes").toString("base64") }] };
  assert.equal(provider.maxInputTokens, 8192);
  assert.deepEqual(await provider.embed(input, { inputType: "query", signal: deadline() }), geminiVector());
  assert.deepEqual(await provider.embedBatch([input, image, audio], { signal: deadline() }), Array(3).fill(geminiVector()));
  assert.deepEqual(server.requests[0].body.content.parts, [{ text: `task: question answering | query: ${input}` }]);
  const docs = server.requests[1].body.requests;
  assert.deepEqual(docs[0].content.parts, [{ text: `title: none | text: ${input}` }]);
  assert.deepEqual(docs[1].content.parts, [{ text: image.text }, { inlineData: { mimeType: "image/png", data: image.parts[1].data } }]);
  assert.deepEqual(docs[2].content.parts, [{ inlineData: { mimeType: "audio/wav", data: audio.parts[0].data } }]);
  assert.ok([server.requests[0].body, ...docs].every(row => row.taskType === undefined && row.outputDimensionality === 128));
  assert.equal(image.parts[0].text, image.text);
});

test("Gemini 2 preview retains taskType and stable models default to 3072 dimensions", async t => {
  const server = await localServer(t, geminiVectors);
  const preview = await core.createGeminiEmbeddingProvider(geminiOptions(server, { model: "gemini-embedding-2-preview" }));
  await preview.provider.embed(input, { inputType: "query", signal: deadline() });
  assert.equal(server.requests[0].body.taskType, "RETRIEVAL_QUERY");
  assert.deepEqual(server.requests[0].body.content.parts, [{ text: input }]);
  const stable = await core.createGeminiEmbeddingProvider(geminiOptions(server, { model: "gemini-embedding-2", dimensions: undefined }));
  assert.equal(stable.client.outputDimensionality, 3072);
  for (const dimensions of [0, 127, 3073, 128.5]) {
    await assert.rejects(core.createGeminiEmbeddingProvider(geminiOptions(server, { dimensions })), /outputDimensionality/);
  }
  assert.deepEqual(await stable.provider.embed("  ", { inputType: "query" }), []);
  assert.deepEqual(await stable.provider.embedBatch([]), []);
  assert.equal(server.requests.length, 1);
});

test("Gemini rejects malformed, nonfinite, empty, wrong-count and wrong-dimension vectors", async t => {
  let payload;
  const server = await localServer(t, (_req, res) => res.end(payload));
  const { provider } = await core.createGeminiEmbeddingProvider(geminiOptions(server));
  for (const value of [{}, { embedding: { values: [] } }, { embedding: { values: [null] } }, { embedding: { values: [1] } }]) {
    payload = JSON.stringify(value);
    await assert.rejects(provider.embed(input, { inputType: "query", signal: deadline() }), /malformed JSON|dimensions/);
  }
  payload = '{"embedding":{"values":[1e999]}}';
  await assert.rejects(provider.embed(input, { inputType: "query", signal: deadline() }), /malformed JSON/);
  payload = JSON.stringify({ embeddings: [{ values: geminiValues() }] });
  await assert.rejects(provider.embedBatch([input, input], { signal: deadline() }), /malformed JSON/);
  assert.equal(server.requests.length, 6);
});

test("Gemini success response caps and parser errors never retain reflected payloads", async t => {
  let mode = "large";
  const server = await localServer(t, (_req, res) => {
    if (mode === "large") res.end(Buffer.alloc(16 * 1024 * 1024 + 1, "x"));
    else if (mode === "utf8") res.end(Buffer.from([0xff]));
    else res.end(`${fixtureKey} ${input} malformed`);
  });
  const { provider } = await core.createGeminiEmbeddingProvider(geminiOptions(server));
  await assert.rejects(provider.embed(input, { inputType: "query", signal: deadline() }), /exceed/);
  for (mode of ["utf8", "json"]) {
    await assert.rejects(provider.embed(input, { inputType: "query", signal: deadline() }), error => {
      assert.match(error.message, /malformed JSON/);
      assert.equal(error.cause, undefined);
      assert.ok(!JSON.stringify(error).includes(fixtureKey));
      assert.ok(!String(error).includes(input));
      return true;
    });
  }
  assert.equal(server.requests.length, 3);
});

test("Gemini rate-limit RetryInfo survives bounded clone reads without retaining body secrets", async t => {
  const server = await localServer(t, (_req, res) => {
    res.writeHead(429, { "retry-after": "1" });
    res.end(JSON.stringify({ error: { message: `${input} ${fixtureKey} ${"x".repeat(1000)}`, details: [
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1.250000001s" },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "2.5s" },
    ] } }));
  });
  const { provider } = await core.createGeminiEmbeddingProvider(geminiOptions(server));
  await assert.rejects(provider.embed(input, { inputType: "query", signal: deadline() }), error => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 2500);
    assert.equal(error.code, "MEMORY_EMBEDDING_HTTP_FAILED");
    assert.equal(error.errorBody, undefined);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes(fixtureKey) && !String(error).includes(input));
    return true;
  });
  assert.equal(server.requests.length, 1);
});

test("Gemini retry hints beyond the original 16 KiB limit are not read", async t => {
  const server = await localServer(t, (_req, res) => {
    res.writeHead(429, { "retry-after": "3" });
    res.end(JSON.stringify({ error: { message: "x".repeat(20 * 1024), details: [
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "99s" },
    ] } }));
  });
  const { provider } = await core.createGeminiEmbeddingProvider(geminiOptions(server));
  await assert.rejects(provider.embed(input, { inputType: "query", signal: deadline() }), error => error.status === 429 && error.retryAfterMs === 3000);
  assert.equal(server.requests.length, 1);
});

test("Gemini transient failures retry the same explicit key within the original attempt bound", async t => {
  let attempts = 0, alwaysFail = false;
  const server = await localServer(t, (request, res) => {
    if (++attempts % 2 === 1 || alwaysFail) { res.statusCode = 503; res.end("synthetic transient failure"); }
    else geminiVectors(request, res);
  });
  const { provider } = await core.createGeminiEmbeddingProvider(geminiOptions(server));
  assert.deepEqual(await provider.embed(input, { inputType: "query", signal: deadline() }), geminiVector());
  assert.equal(attempts, 2);
  assert.deepEqual(server.requests.map(row => row.headers["x-goog-api-key"]), [fixtureKey, fixtureKey]);
  let checks = 0;
  await assert.rejects(core.withGuardedFetchRequestAuthority(() => {}, () => provider.embed(input, { inputType: "query", signal: deadline() }), () => {
    if (++checks === 2) throw new Error("fixture authority revoked");
  }), /authority revoked/);
  assert.equal(attempts, 3);
  alwaysFail = true;
  await assert.rejects(provider.embed(input, { inputType: "query", signal: deadline() }), error => error.status === 503);
  assert.equal(attempts, 5);
});

test("Gemini cancellation releases stalled success/error bodies and dispatches no second request", async t => {
  for (const status of [200, 429]) {
    let ready;
    const headersSent = new Promise(resolve => { ready = resolve; });
    const server = await localServer(t, (_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.write('{"embedding":'); ready(); });
    const { provider } = await core.createGeminiEmbeddingProvider(geminiOptions(server));
    const controller = new AbortController();
    const checked = assert.rejects(provider.embed(input, { inputType: "query", signal: AbortSignal.any([controller.signal, deadline()]) }));
    await headersSent;
    controller.abort(new Error("fixture cancelled"));
    await checked;
    assert.equal(server.requests.length, 1);
  }
});

test("Gemini does not inherit ambient credentials or another destination's provider headers", async t => {
  const server = await localServer(t, geminiVectors);
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = fixtureKey;
  try {
    await assert.rejects(core.createGeminiEmbeddingProvider(geminiOptions(server, { remote: { baseUrl: server.baseUrl } })), /credentials are not configured|Service credential/);
    await assert.rejects(core.createGeminiEmbeddingProvider({ config: {}, model: "gemini-embedding-001" }), error => error.code === "MEMORY_EMBEDDING_CREDENTIAL_REQUIRED");
    assert.equal(server.requests.length, 0);
    const { provider } = await core.createGeminiEmbeddingProvider(geminiOptions(server, {
      config: { models: { providers: { google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", headers: { "x-private-owner": "other-destination" } } } } },
      remote: { baseUrl: `${server.baseUrl}/openai?tenant=fixture%2Fopenai`, apiKey: JSON.stringify({ token: fixtureKey }) },
    }));
    await provider.embed(input, { inputType: "query", signal: deadline() });
    assert.equal(server.requests[0].headers.authorization, `Bearer ${fixtureKey}`);
    assert.equal(server.requests[0].headers["x-private-owner"], undefined);
    assert.equal(server.requests[0].headers["x-goog-api-key"], undefined);
    assert.equal(server.requests[0].url, "/v1/models/gemini-embedding-001:embedContent?tenant=fixture%2Fopenai");
  } finally { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; }
});

test("Gemini redirect guard drops API keys, body and authorization across origins", async t => {
  const target = await localServer(t, geminiVectors);
  const source = await localServer(t, (_req, res) => { res.writeHead(307, { location: `${target.baseUrl}/redirect` }); res.end(); });
  for (const apiKey of [fixtureKey, JSON.stringify({ token: fixtureKey })]) {
    const { provider } = await core.createGeminiEmbeddingProvider(geminiOptions(source, { remote: { baseUrl: source.baseUrl, apiKey } }));
    await provider.embed(input, { inputType: "query", signal: deadline() });
  }
  assert.equal(target.requests.length, 2);
  for (const request of target.requests) {
    assert.equal(request.headers["x-goog-api-key"], undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.body, null);
  }
});

const ollamaVectors = (request, res) => res.end(JSON.stringify({
  embeddings: (Array.isArray(request.body?.input) ? request.body.input : [request.body?.input]).map(() => [3, 4, 99]),
}));

test("Ollama normalizes routes/models and applies original query templates only to queries", async t => {
  const server = await localServer(t, ollamaVectors);
  const cases = [
    ["nomic-embed-text", `search_query: ${input}`],
    ["qwen3-embedding:4b", `Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:${input}`],
    ["mxbai-embed-large", `Represent this sentence for searching relevant passages: ${input}`],
    ["fixture-embedding", input],
  ];
  assert.equal(core.DEFAULT_OLLAMA_EMBEDDING_MODEL, "nomic-embed-text");
  for (const [model, expected] of cases) {
    const { provider } = await core.createOllamaEmbeddingProvider(options(server, { provider: "custom-local", model: `custom-local/${model}`, dimensions: 2 }));
    assert.equal(provider.model, model);
    assert.deepEqual(await provider.embed(input, { inputType: "query", signal: deadline() }), [0.6, 0.8]);
    assert.equal(server.requests.at(-1).body.input, expected);
    assert.deepEqual(await provider.embedBatch([input, { text: "A fictional second document." }], { signal: deadline() }), [[0.6, 0.8], [0.6, 0.8]]);
    assert.deepEqual(server.requests.at(-1).body, { model, input: [input, "A fictional second document."] });
    assert.deepEqual(await provider.embedBatch([], { signal: deadline() }), []);
  }
  assert.equal(server.requests.length, 8);
  assert.ok(server.requests.every(row => row.url === "/api/embed" && row.headers.authorization === `Bearer ${fixtureKey}`));
});

test("Ollama validates result count/types and retains original numeric sanitization", async t => {
  let payload;
  const server = await localServer(t, (_req, res) => res.end(payload));
  const { provider } = await core.createOllamaEmbeddingProvider(options(server));
  for (const value of [null, [], {}, { embeddings: [] }, { embeddings: [null] }, { embeddings: [["bad"]] }]) {
    payload = JSON.stringify(value);
    await assert.rejects(provider.embed(input, { signal: deadline() }), /non-object|missing embeddings|0 embeddings|non-array|non-number/);
  }
  payload = '{"embeddings":[[1e999,3,4]]}';
  assert.deepEqual(await provider.embed(input, { signal: deadline() }), [0, 0.6, 0.8]);
  payload = '{"embeddings":[[]]}';
  assert.deepEqual(await provider.embed(input, { signal: deadline() }), []);
});

test("Ollama original local/environment markers never read ambient keys or resolve SecretRefs", async t => {
  const server = await localServer(t, ollamaVectors);
  const previous = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "synthetic-ambient-key";
  try {
    for (const apiKey of [undefined, "ollama-local", "OLLAMA_API_KEY"]) {
      const { provider } = await core.createOllamaEmbeddingProvider(options(server, { remote: { baseUrl: server.baseUrl, apiKey } }));
      await provider.embed(input, { signal: deadline() });
      assert.equal(server.requests.at(-1).headers.authorization, undefined);
    }
    await assert.rejects(core.createOllamaEmbeddingProvider(options(server, { remote: undefined, config: { models: { providers: {
      ollama: { baseUrl: server.baseUrl, apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" } },
    } } } })), error => error.code === "MEMORY_EMBEDDING_CREDENTIAL_REQUIRED");
    assert.equal(server.requests.length, 3);
  } finally { if (previous === undefined) delete process.env.OLLAMA_API_KEY; else process.env.OLLAMA_API_KEY = previous; }
});

test("Ollama explicit endpoint overrides do not inherit other host credentials, headers or leases", async t => {
  const server = await localServer(t, ollamaVectors);
  let acquired = 0;
  const { provider } = await core.createOllamaEmbeddingProvider(options(server, {
    remote: { baseUrl: server.baseUrl }, acquireLocalService: async () => { acquired++; return { release() {} }; },
    config: { models: { providers: { ollama: { baseUrl: "http://127.0.0.1:1/v1", apiKey: fixtureKey,
      headers: { "x-private-owner": "other-origin" }, localService: { command: "never-run" } } } } },
  }));
  await provider.embed(input, { signal: deadline() });
  assert.equal(acquired, 0);
  assert.equal(server.requests[0].headers.authorization, undefined);
  assert.equal(server.requests[0].headers["x-private-owner"], undefined);
});

test("Ollama releases acquired local-service leases on success, HTTP failure and cancellation", async t => {
  let mode = "ok", ready;
  const server = await localServer(t, (request, res) => {
    if (mode === "ok") ollamaVectors(request, res);
    else if (mode === "error") { res.statusCode = 401; res.end(`${input} ${fixtureKey}`); }
    else { res.writeHead(200); res.write('{"embeddings":'); ready(); }
  });
  let acquisitions = 0, releases = 0;
  const { provider, client } = await core.createOllamaEmbeddingProvider(options(server, { remote: undefined, dimensions: 2,
    config: { models: { providers: { ollama: { baseUrl: server.baseUrl, apiKey: fixtureKey, localService: { command: "synthetic-lease" } } } } },
    acquireLocalService: async target => {
      assert.equal(target.baseUrl, server.baseUrl); acquisitions++;
      return { release() { releases++; } };
    },
  }));
  assert.deepEqual(await provider.embed(input, { signal: deadline() }), [0.6, 0.8]);
  assert.equal(releases, 1);
  mode = "error";
  await assert.rejects(client.embedBatch([input]), error => {
    assert.match(error.message, /HTTP 401/);
    assert.ok(!String(error).includes(input) && !String(error).includes(fixtureKey));
    assert.ok(!String(error.cause).includes(input) && !String(error.cause).includes(fixtureKey));
    return true;
  });
  assert.equal(releases, 2);
  mode = "stall";
  const headersSent = new Promise(resolve => { ready = resolve; });
  const controller = new AbortController();
  const checked = assert.rejects(provider.embed(input, { signal: AbortSignal.any([controller.signal, deadline()]) }));
  await headersSent; controller.abort(); await checked;
  assert.equal(acquisitions, 3); assert.equal(releases, 3);
});

test("Ollama's configured origin does not authorize redirects to another local port", async t => {
  const target = await localServer(t, ollamaVectors);
  const source = await localServer(t, (_req, res) => { res.writeHead(307, { location: `${target.baseUrl}/api/embed` }); res.end(); });
  const { provider } = await core.createOllamaEmbeddingProvider(options(source));
  await assert.rejects(provider.embed(input, { signal: deadline() }), error => error.name === "SsrFBlockedError");
  assert.equal(source.requests.length, 1); assert.equal(target.requests.length, 0);
});
