"use strict";

// Original provider adapters and HTTP jobs, using only invented text/keys and
// loopback servers. No Product provider, Vault access or vendor request occurs.
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
const key = "synthetic-batch-key-placeholder";
const reflected = "PRIVATE-FICTIONAL-BATCH-RESPONSE";
const adapters = { openai: core.openAiMemoryEmbeddingProviderAdapter, gemini: core.geminiMemoryEmbeddingProviderAdapter,
  voyage: core.voyageMemoryEmbeddingProviderAdapter };
const chunks = [{ text: "Fictional amber observatory." }, { text: "Fictional violet telescope." }];
const controls = { chunks, agentId: "batch-fixture", wait: true, concurrency: 2, pollIntervalMs: 1, timeoutMs: 500 };
const json = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };

test("copied batch adapters run with only the bundle and built-in Node modules", async t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-batch-bundle-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ["core.cjs", "host-bridge.cjs"]) fs.copyFileSync(path.join(__dirname, "../app/agent-service/shoggoth-memory", name), path.join(directory, name));
  const source = `
    const Module = require('node:module'), load = Module._load;
    Module._load = function(id, ...args) {
      if (!Module.isBuiltin(id) && !id.startsWith('.') && !id.startsWith('/')) throw Error('External dependency: ' + id);
      return load.call(this, id, ...args);
    };
    const http = require('node:http');
    const server = http.createServer((req,res) => {
      req.resume();
      const gemini = req.url.includes('gemini') || req.url.includes('uploadType') || req.url.includes(':download');
      if (req.method === 'POST' && req.url.includes('/files')) res.end(JSON.stringify(gemini ? {file:{name:'files/input'}} : {id:'input'}));
      else if (req.method === 'POST') res.end(JSON.stringify(gemini ? {name:'batches/job',done:true,response:{responsesFile:'files/output'}} : {id:'job',status:'completed',output_file_id:'output'}));
      else res.end(JSON.stringify(gemini ? {key:'0',embedding:{values:[3,4,...Array(126).fill(0)]}} : {custom_id:'0',response:{body:{data:[{embedding:[1,0]}]}}}));
    });
    server.listen(0,'127.0.0.1',async () => {
      try {
        const core = require('./core.cjs');
        for (const kind of ['openAi','gemini','voyage']) {
          const adapter=core[kind+'MemoryEmbeddingProviderAdapter'];
          const {runtime}=await adapter.create({config:{},model:kind==='gemini'?'gemini-embedding-001':'fixture',dimensions:kind==='gemini'?128:2,remote:{apiKey:'synthetic-only',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'}});
          const result=await runtime.batchEmbed({chunks:[{text:'Fictional telescope'}],agentId:'fixture',wait:true,concurrency:1,pollIntervalMs:1,timeoutMs:1000});
          if (result.length!==1 || result[0][0] !== (kind==='gemini'?0.6:1)) throw Error('Invalid copied batch result');
        }
        process.stdout.write('bundled-batches-ok');
      } catch(error) {process.stderr.write(String(error));process.exitCode=1;}
      finally {server.close();server.closeAllConnections();}
    });`;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", source], { cwd: directory, timeout: 8000 });
  assert.equal(stdout, "bundled-batches-ok");
});

async function fixture(t, kind, hooks = {}) {
  const requests = [], failures = [], files = new Map(), jobs = new Map();
  const complete = job => kind === "gemini" ? { name: `batches/${job.id}`, done: true, response: { responsesFile: `files/out-${job.n}` } }
    : { id: job.id, status: "completed", output_file_id: `out-${job.n}` };
  const pending = job => kind === "gemini" ? { name: `batches/${job.id}`, done: false, metadata: { state: "JOB_STATE_RUNNING" } }
    : { id: job.id, status: "in_progress", request_counts: { total: job.rows.length, completed: 0, failed: 0 } };
  const output = job => job.rows.map(row => {
    const id = row.custom_id ?? row.key, n = Number(id);
    return kind === "gemini" ? { key: id, response: { embedding: { values: [...(n % 2 ? [4, 3] : [3, 4]), ...Array(126).fill(0)] } } }
      : { custom_id: id, response: { status_code: 200, body: { data: [{ embedding: [n + 1, 0.5] }] } } };
  }).reverse().map(row => JSON.stringify(row)).join("\n") + "\n";
  const server = http.createServer((req, res) => { void (async () => {
    const parts = []; for await (const part of req) parts.push(part);
    const bytes = Buffer.concat(parts), text = bytes.toString("utf8"), contentType = String(req.headers["content-type"] || "");
    const request = { method: req.method, url: req.url, pathname: new URL(req.url, "http://localhost").pathname,
      headers: req.headers, body: contentType.includes("application/json") && text ? JSON.parse(text) : null, rows: null };
    if (contentType.startsWith("multipart/form-data")) {
      const form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
      assert.equal(form.get("purpose"), "batch");
      request.rows = (await form.get("file").text()).split("\n").filter(Boolean).map(JSON.parse);
    } else if (contentType.startsWith("multipart/related")) {
      const boundary = contentType.split("boundary=")[1];
      const part = text.split(`--${boundary}`).find(value => value.includes("Content-Type: application/jsonl"));
      assert.ok(part); request.rows = part.split("\r\n\r\n")[1].trim().split("\n").map(JSON.parse);
    }
    requests.push(request);
    if (req.method === "POST" && request.pathname.endsWith("/files")) {
      assert.ok(request.rows?.length);
      if (await hooks.upload?.(request, res)) return;
      const id = `input-${files.size + 1}`; files.set(id, request.rows);
      json(res, kind === "gemini" ? { file: { name: `files/${id}` } } : { id }); return;
    }
    if (req.method === "POST" && (request.pathname.endsWith("/batches") || request.pathname.endsWith(":asyncBatchEmbedContent"))) {
      const id = (kind === "gemini" ? request.body.batch.inputConfig.file_name : request.body.input_file_id).replace(/^files\//u, "");
      const n = jobs.size + 1, job = { n, id: `job-${n}`, rows: files.get(id), polls: 0 }; assert.ok(job.rows); jobs.set(job.id, job);
      if (await hooks.create?.(request, res, job, { complete, pending })) return;
      json(res, hooks.wait ? pending(job) : complete(job)); return;
    }
    if (req.method === "GET" && request.pathname.includes("/batches/")) {
      const job = jobs.get(request.pathname.split("/").at(-1)); assert.ok(job); job.polls++;
      if (await hooks.poll?.(request, res, job, { complete, pending })) return;
      json(res, complete(job)); return;
    }
    if (req.method === "GET" && request.pathname.includes("/files/")) {
      const id = request.pathname.split("/files/")[1].split(/\/content|:download/u)[0];
      if (id.startsWith("error-")) { if (await hooks.error?.(request, res)) return; throw Error("Unexpected error-file download"); }
      const job = jobs.get(`job-${id.replace(/^out-/u, "")}`); assert.ok(job);
      if (await hooks.output?.(request, res, job, output)) return;
      res.end(output(job)); return;
    }
    throw Error(`Unexpected fixture route: ${req.method} ${request.pathname}`);
  })().catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end("fixture failed"); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; assert.deepEqual(failures, []); });
  return { requests, jobs, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}
async function create(kind, server, extra = {}) {
  return adapters[kind].create({ config: {}, agentDir: "/private/tmp/unused-batch-fixture", fallback: "none",
    model: kind === "gemini" ? "gemini-embedding-001" : kind === "openai" ? "text-embedding-3-small" : "voyage-3",
    dimensions: kind === "gemini" ? 128 : 2, remote: { apiKey: key, baseUrl: server.baseUrl }, ...extra });
}

for (const kind of Object.keys(adapters)) {
  test(`${kind} index cancellation interrupts the native polling delay`, { timeout: 5000 }, async t => {
    let submitted; const ready = new Promise(resolve => { submitted = resolve; });
    const server = await fixture(t, kind, { create: (_request, res, job, states) => {
      json(res, states.pending(job)); submitted(); return true;
    } });
    const { runtime } = await create(kind, server), controller = new AbortController();
    const operation = core.withMemoryEmbeddingExecution({ signal: controller.signal, assertCurrent() {} },
      () => runtime.batchEmbed({ ...controls, pollIntervalMs: 60_000, timeoutMs: 120_000 }));
    const rejected = assert.rejects(operation);
    await ready; await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error("index cancelled")); await rejected;
    assert.equal(server.requests.length, 2);
  });
  test(`${kind} index cancellation aborts an active batch HTTP response`, { timeout: 5000 }, async t => {
    let polling, closed;
    const ready = new Promise(resolve => { polling = resolve; }), disconnected = new Promise(resolve => { closed = resolve; });
    const server = await fixture(t, kind, { wait: true, poll: (_request, res) => {
      res.once("close", closed); polling(); return true;
    } });
    const { runtime } = await create(kind, server), controller = new AbortController();
    const operation = core.withMemoryEmbeddingExecution({ signal: controller.signal, assertCurrent() {} },
      () => runtime.batchEmbed({ ...controls, timeoutMs: 120_000 }));
    const rejected = assert.rejects(operation);
    await ready; controller.abort(new Error("index cancelled")); await rejected; await disconnected;
    assert.equal(server.requests.length, 3); assert.equal(server.jobs.get("job-1").polls, 1);
  });
  test(`${kind} original adapter uploads JSONL and maps reverse output back to input order`, async t => {
    const server = await fixture(t, kind), { runtime } = await create(kind, server);
    const result = await runtime.batchEmbed(controls);
    assert.deepEqual(result, kind === "gemini" ? [[0.6, 0.8, ...Array(126).fill(0)], [0.8, 0.6, ...Array(126).fill(0)]] : [[1, 0.5], [2, 0.5]]);
    assert.equal(server.requests.length, 3);
    assert.equal(JSON.stringify(runtime.cacheKeyData).includes(key), false);
    assert.ok(server.requests.every(request => kind === "gemini" ? request.headers["x-goog-api-key"] === key : request.headers.authorization === `Bearer ${key}`));
    const upload = server.requests[0].rows, body = server.requests[1].body;
    if (kind === "openai") {
      assert.equal(runtime.sourceWideBatchEmbed, true); assert.equal(body.completion_window, "24h");
      assert.ok(upload.every(row => row.method === "POST" && row.url === "/v1/embeddings" && row.body.dimensions === 2));
      assert.deepEqual(upload.map(row => row.body.input), chunks.map(row => row.text));
    } else if (kind === "voyage") {
      assert.equal(body.completion_window, "12h"); assert.deepEqual(body.request_params, { model: "voyage-3", input_type: "document" });
      assert.deepEqual(upload.map(row => row.body.input), chunks.map(row => row.text));
    } else {
      assert.match(server.requests[0].url, /^\/upload\/v1\/files\?uploadType=multipart$/u);
      assert.ok(upload.every(row => row.request.taskType === "RETRIEVAL_DOCUMENT" && row.request.outputDimensionality === 128));
      assert.match(server.requests[2].url, /^\/v1\/files\/out-1:download\?alt=media$/u);
    }
  });
  test(`${kind} pending job polls to completion and wait=false submits without polling`, async t => {
    const server = await fixture(t, kind, { wait: true }), { runtime } = await create(kind, server);
    assert.equal((await runtime.batchEmbed(controls)).length, 2); assert.equal(server.jobs.get("job-1").polls, 1);
    await assert.rejects(runtime.batchEmbed({ ...controls, wait: false }), { code: "MEMORY_EMBEDDING_BATCH_FAILED" });
    assert.equal(server.jobs.get("job-2").polls, 0); assert.equal(server.requests.filter(row => row.method === "GET").length, 2);
  });
  test(`${kind} unfinished jobs honor the original total polling timeout`, async t => {
    const server = await fixture(t, kind, { wait: true, poll: (_request, res, job, states) => { json(res, states.pending(job)); return true; } });
    const { runtime } = await create(kind, server), started = Date.now();
    await assert.rejects(runtime.batchEmbed({ ...controls, timeoutMs: 50, pollIntervalMs: 1000 }), error => /timed out/u.test(error.message));
    assert.ok(Date.now() - started < 2000); assert.equal(server.requests.filter(row => row.method === "GET").length, 0);
  });
  test(`${kind} error and output files cannot leak reflected memory through the adapter or debug callback`, async t => {
    for (const mode of ["output", "terminal"]) {
      const hooks = mode === "output" ? { output: (_request, res) => { res.end(JSON.stringify(kind === "gemini"
        ? { key: "0", error: { message: reflected } } : { custom_id: "0", error: { message: reflected } })); return true; } }
        : kind === "gemini" ? { create: (_request, res, job) => { json(res, { name: `batches/${job.id}`, done: true, error: { code: 400, message: reflected } }); return true; } }
        : { create: (_request, res, job) => { json(res, { id: job.id, status: "completed", output_file_id: `out-${job.n}`, error_file_id: "error-1" }); return true; },
          error: (_request, res) => { res.end(JSON.stringify({ error: { message: reflected } })); return true; } };
      const server = await fixture(t, kind, hooks), { runtime } = await create(kind, server), debug = [];
      await assert.rejects(runtime.batchEmbed({ ...controls, debug: (...args) => debug.push(args) }), error => {
        assert.equal(error.code, "MEMORY_EMBEDDING_BATCH_FAILED"); assert.equal(String(error.stack).includes(reflected), false);
        assert.equal(error.cause, undefined); assert.equal(JSON.stringify(error).includes(reflected), false); return true;
      });
      assert.deepEqual(debug, []);
      if (mode === "terminal" && kind !== "gemini") assert.equal(server.requests.some(row => row.url.includes("/out-")), false, "error file takes precedence over success output");
    }
  });
}

test("Gemini unsupported batch retains its native unavailable classification and multimodal input bypasses batch", async t => {
  const server = await fixture(t, "gemini", { create: (_request, res) => { json(res, { error: { message: reflected } }, 404); return true; } });
  const { runtime } = await create("gemini", server);
  await assert.rejects(runtime.batchEmbed(controls), error => { assert.equal(core.isEmbeddingBatchUnavailableError(error), true); assert.equal(error.cause, undefined); return true; });
  const calls = server.requests.length;
  assert.equal(await runtime.batchEmbed({ ...controls, chunks: [{ text: "Fictional image", embeddingInput: { parts: [{ type: "inline-data", mimeType: "image/png", data: "AA==" }] } }] }), null);
  assert.equal(server.requests.length, calls);
});

test("OpenAI upload 413 recursively splits the original request group without losing custom-id order", async t => {
  const server = await fixture(t, "openai", { upload: (request, res) => {
    if (request.rows.length > 2) { json(res, { message: "fixture file too large" }, 413); return true; }
  } });
  const { client } = await core.createOpenAiEmbeddingProvider({ config: {}, model: "fixture", remote: { apiKey: key, baseUrl: server.baseUrl } });
  const requests = Array.from({ length: 5 }, (_, index) => ({ custom_id: String(index), method: "POST", url: "/v1/embeddings", body: { model: "fixture", input: `Fictional entry ${index}` } }));
  const result = await core.runOpenAiEmbeddingBatches({ ...controls, openAi: client, requests });
  assert.deepEqual(requests.map(row => result.get(row.custom_id)), requests.map((_, index) => [index + 1, 0.5]));
  assert.deepEqual(server.requests.filter(row => row.rows).map(row => row.rows.length), [5, 3, 2, 1, 2]);
});

test("OpenAI batch groups respect the original JSONL byte budget", async t => {
  const server = await fixture(t, "openai");
  const { client } = await core.createOpenAiEmbeddingProvider({ config: {}, model: "fixture", remote: { apiKey: key, baseUrl: server.baseUrl } });
  const requests = [0, 1, 2].map(index => ({ custom_id: String(index), method: "POST", url: "/v1/embeddings", body: { model: "fixture", input: `Fictional entry ${index}` } }));
  const result = await core.runOpenAiEmbeddingBatches({ ...controls, openAi: client, requests, maxJsonlBytes: Buffer.byteLength(JSON.stringify(requests[0])) });
  assert.equal(result.size, 3); assert.deepEqual(server.requests.filter(row => row.rows).map(row => row.rows.length), [1, 1, 1]);
});

test("OpenAI batch creation and polling use their original bounded transient retry", async t => {
  let creations = 0, polls = 0;
  const server = await fixture(t, "openai", { wait: true,
    create: (_request, res) => { if (++creations === 1) { json(res, { message: reflected }, 429); return true; } },
    poll: (_request, res) => { if (++polls === 1) { json(res, { message: reflected }, 503); return true; } },
  });
  const { runtime } = await create("openai", server);
  assert.equal((await runtime.batchEmbed({ ...controls, timeoutMs: 3000 })).length, 2);
  assert.equal(creations, 2); assert.equal(polls, 2);
});

test("batch outputs reject malformed, duplicate, missing and invalid vectors without returning partial results", async t => {
  for (const kind of Object.keys(adapters)) for (const mode of ["malformed", "duplicate", "missing", "invalid", "utf8", "oversize", "blank"]) {
    const server = await fixture(t, kind, { output: (_request, res, job, output) => {
      const rows = output(job).trim().split("\n");
      const value = mode === "malformed" ? '{"private":' : mode === "duplicate" ? `${rows[0]}\n${rows[0]}\n`
        : mode === "missing" ? rows[0] : mode === "utf8" ? Buffer.from([0xff, 0x0a])
        : mode === "oversize" ? "x".repeat(4 * 1024 * 1024 + 1) : mode === "blank" ? "\n\n\n"
        : JSON.stringify(kind === "gemini" ? { key: "0", embedding: { values: [null] } }
          : { custom_id: "0", response: { body: { data: [{ embedding: [null] }] } } });
      res.end(value); return true;
    } });
    const { runtime } = await create(kind, server);
    await assert.rejects(runtime.batchEmbed(controls), { code: "MEMORY_EMBEDDING_BATCH_FAILED" }, `${kind}/${mode}`);
  }
});

test("revoking request authority after upload prevents subsequent batch creation", async t => {
  for (const kind of Object.keys(adapters)) {
    let current = true;
    const server = await fixture(t, kind, { upload: () => { current = false; } }), { runtime } = await create(kind, server);
    await assert.rejects(core.withGuardedFetchRequestAuthority(() => { if (!current) throw Error("fixture authority withdrawn"); },
      () => runtime.batchEmbed(controls)), { code: "MEMORY_EMBEDDING_BATCH_FAILED" });
    assert.equal(server.requests.length, 1);
  }
});

test("original inline batch policy splits provider item caps and retains bounded query retry and cancellation", async () => {
  const groups = [], successful = [], waits = [];
  const result = await core.runMemoryEmbeddingBatchRetryWithSplit({ items: [1, 2, 3, 4, 5], run: async items => {
    groups.push([...items]); if (items.length > 2) throw Error("input array max 2"); return items.map(value => value * 10);
  }, waitForRetry: async ms => waits.push(ms), onSuccess: async items => successful.push([...items]) });
  assert.deepEqual(result, [10, 20, 30, 40, 50]); assert.deepEqual(groups.map(items => items.length), [5, 3, 2, 1, 2]);
  assert.deepEqual(successful, [[1, 2], [3], [4, 5]]); assert.deepEqual(waits, []);
  let calls = 0;
  await assert.rejects(core.runMemoryEmbeddingRetryLoop({ profile: "query", run: async () => { calls++; throw Object.assign(Error("rate limit"), { status: 429, retryAfterMs: 60000 }); }, waitForRetry: async ms => waits.push(ms) }));
  assert.equal(calls, 3); assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 8000);
  const controller = new AbortController(); calls = 0;
  await assert.rejects(core.runMemoryEmbeddingRetryLoop({ profile: "query", signal: controller.signal,
    run: async () => { calls++; controller.abort(); throw Error("network error"); }, waitForRetry: async () => assert.fail("cancelled work cannot wait for retry") }));
  assert.equal(calls, 1);
});
