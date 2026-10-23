"use strict";

// Run the fixed official llama.cpp embedding factory against an invented GGUF
// header and a Node HTTP worker. Native preparation, preset reload, transport,
// runtime inspection and leases all execute; no model or binary is downloaded.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { withMemoryHost } = require("../app/agent-service/shoggoth-memory/host-bridge.cjs");
const { createLocalServiceFixture, until, bounded, rows, read } = require("./shoggoth-memory-local-service-smoke.cjs");

const workerSource = String.raw`
"use strict";
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const root = process.argv[2], port = Number(process.argv[4]);
const file = name => path.join(root, name);
const append = (name, value) => fs.appendFileSync(file(name), JSON.stringify(value) + "\n");
const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8") : "";
const modelId = "embeddinggemma-300m-qat-q8_0";
const modelPath = () => /^model\s*=\s*(.+)$/m.exec(read("models.ini"))?.[1]?.trim();
append("starts.jsonl", { pid: process.pid, marker: process.env.SHOGGOTH_FIXTURE_MARKER });
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8"), body = text ? JSON.parse(text) : undefined;
  append("requests.jsonl", { method: req.method, url: req.url, headers: req.headers, ...(body ? { body } : {}) });
  res.setHeader("content-type", "application/json");
  if (req.url === "/models?reload=1") { append("reloads.jsonl", { model: modelPath() }); res.end('{"reloaded":true}'); }
  else if (req.url === "/v1/embeddings") {
    const mode = read("request.mode").trim();
    if (mode === "error") { res.writeHead(401); res.end("invented fixture HTTP failure"); }
    else if (mode === "stall") {
      res.writeHead(200); res.write('{"data":'); fs.writeFileSync(file("stall.ready"), "yes");
      res.once("close", () => append("cancelled.jsonl", { url: req.url }));
    } else res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [3 * (index + 1), 4 * (index + 1)] })).reverse() }));
  } else if (req.url.startsWith("/props?")) res.end(JSON.stringify({ model_path: modelPath(), build_info: "synthetic factory worker", modalities: { vision: false } }));
  else if (req.url.startsWith("/metrics?")) { res.setHeader("content-type", "text/plain"); res.end("fixture_ready 1\n"); }
  else if (req.url === "/models") res.end(JSON.stringify({ data: [{ id: modelId, path: modelPath() }] }));
  else res.end('{"ready":true}');
});
server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => { fs.writeFileSync(file("stopping"), "yes"); server.closeAllConnections(); server.close(() => process.exit(0)); });
`;

async function factoryFixture(core, directory, signal, runWithHost = withMemoryHost) {
  const f = await createLocalServiceFixture(core, directory, signal, workerSource);
  const resource = await f.resource("llama-cpp", { idleStopMs: 1_500 });
  resource.service.args.push("--models-preset", resource.file("models.ini"));
  resource.service.healthUrl = resource.baseUrl.replace(/\/v1$/, "/health");
  resource.config.api = "openai-completions";
  resource.config.headers = { "x-factory-fixture": "invented-local-owner" };
  const stateDir = path.join(directory, "fixture-state"), cacheDir = path.join(stateDir, "models/llama.cpp");
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const defaultPath = path.join(cacheDir, core.DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE);
  const customA = path.join(cacheDir, "invented-custom-A.gguf"), customB = path.join(cacheDir, "invented-custom-B.gguf");
  for (const file of [defaultPath, customA, customB]) fs.writeFileSync(file, "GGUF synthetic fixture header only", { mode: 0o600 });
  let stateReads = 0, current = true;
  const host = { assertCurrent() { assert.equal(current, true); }, resolveStateDir() { stateReads++; return stateDir; },
    getEmbeddingProvider(id) { throw new Error(`Fixture has no other adapter ${id}`); } };
  const targets = [], releases = [];
  const acquireLocalService = async (target, callSignal) => {
    const record = { target, signal: callSignal, released: 0 }; targets.push(record);
    assert.equal(target.providerId, "llama-cpp"); assert.equal(target.baseUrl, resource.baseUrl);
    assert.equal(target.reconcile, core.reconcileManagedLlamaServer, "Official factory must inject real preset reconciliation");
    const lease = await f.acquire(target, callSignal); assert.equal(typeof lease?.release, "function");
    return { release() { record.released++; releases.push(record); return lease.release(); } };
  };
  const options = (modelPath = customA, extra = {}) => ({ config: f.config, provider: "local", model: "invented-ignored-wire-model",
    local: { modelPath }, acquireLocalService, dimensions: 2, ...extra });
  Object.assign(f, { resource, stateDir, cacheDir, defaultPath, customA, customB, targets, releases,
    options, run: action => runWithHost(host, action),
    stateReads: () => stateReads,
    requests: () => rows(resource.file("requests.jsonl")),
    embeds: () => rows(resource.file("requests.jsonl")).filter(row => row.url === "/v1/embeddings"),
    facts: provider => provider[Symbol.for("openclaw.localEmbeddingRuntimeFacts")](),
    create: request => runWithHost(host, () => core.llamaCppEmbeddingProviderAdapter.create(request)),
    revoke: () => { current = false; },
  });
  return f;
}

function assertFacts(f, core, provider, modelPath, state = "ready") {
  const facts = f.facts(provider);
  assert.equal(facts.engine, "llama.cpp"); assert.equal(facts.state, state);
  assert.equal(facts.buildInfo, "synthetic factory worker");
  assert.deepEqual(facts.model, { id: core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID, path: modelPath });
  assert.deepEqual(facts.capabilities, { vision: false, draft: false });
  assert.deepEqual(facts.endpoints, { health: "ready", models: "ready", props: "ready", metrics: "ready" });
  const urls = f.requests().map(row => row.url);
  for (const endpoint of ["/health", "/models", `/props?model=${core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID}&autoload=false`,
    `/metrics?model=${core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID}&autoload=false`]) assert.ok(urls.includes(endpoint), `Missing real inspection ${endpoint}`);
}
function assertReleased(f, count) {
  assert.equal(f.targets.length, count); assert.equal(f.releases.length, count);
  assert.ok(f.targets.every(record => record.released === 1), "Every official request releases its actual native lease exactly once");
}

const cases = {
  async identity(f, core) {
    const adapter = core.llamaCppEmbeddingProviderAdapter;
    assert.equal(adapter.id, "local"); assert.equal(adapter.transport, "local");
    assert.equal(adapter.defaultModel, core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    const defaults = f.run(() => adapter.resolveIndexIdentity(f.options(f.defaultPath)));
    assert.equal(defaults.model, core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    assert.deepEqual(defaults.cacheKeyData, { provider: "local", model: defaults.model, outputDimensionality: 2 });
    const aliases = defaults.aliases.map(value => value.model);
    assert.ok(aliases.includes(f.defaultPath)); assert.ok(aliases.includes(core.DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE));
    assert.ok(aliases.includes(path.join(os.homedir(), ".node-llama-cpp/models", core.DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE)));
    assert.equal(new Set(aliases).size, aliases.length);
    for (const alias of defaults.aliases) assert.deepEqual(alias.cacheKeyData, { provider: "local", model: alias.model, outputDimensionality: 2 });
    const custom = f.run(() => adapter.resolveIndexIdentity(f.options(f.customA, { dimensions: 3 })));
    assert.deepEqual(custom, { model: f.customA, cacheKeyData: { provider: "local", model: f.customA, outputDimensionality: 3 }, aliases: [] });
    const unknownDimensions = f.run(() => adapter.resolveIndexIdentity(f.options(f.customA, { dimensions: undefined })));
    assert.deepEqual(unknownDimensions.cacheKeyData, { provider: "local", model: f.customA });
    assert.ok(f.stateReads() > 0); assert.equal(f.resource.starts().length, 0); assert.equal(f.targets.length, 0);
  },
  async default_factory(f, core) {
    const identity = f.run(() => core.llamaCppEmbeddingProviderAdapter.resolveIndexIdentity(f.options(f.defaultPath)));
    const { provider, runtime } = await f.create(f.options(f.defaultPath));
    assert.equal(provider.id, "local"); assert.equal(provider.model, core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL); assert.equal(provider.dimensions, 2);
    assert.equal(runtime.id, "local"); assert.deepEqual(runtime.cacheKeyData, identity.cacheKeyData); assert.deepEqual(runtime.indexIdentityAliases, identity.aliases);
    assert.equal(runtime.inlineQueryTimeoutMs, 5 * 60_000); assert.equal(runtime.inlineBatchTimeoutMs, 10 * 60_000);
    assert.equal(f.resource.starts().length, 0, "Factory preparation does not start the request-leased server");
    const preset = read(f.resource.file("models.ini")); assert.ok(preset.includes(`model = ${f.defaultPath}`)); assert.match(preset, /ubatch-size = 2048/);
    const phases = [], control = core.createMemorySearchDeadlineControl(), unsubscribe = control.subscribe(value => phases.push(value));
    try {
      assert.deepEqual(await f.run(() => provider.embed("Invented default-memory item.", {
        signal: f.signal, inputType: "query", [core.MEMORY_SEARCH_DEADLINE_CONTROL]: control,
      })), [3, 4]);
    } finally { unsubscribe(); }
    assert.deepEqual(phases, ["pause", "resume"]);
    const request = f.embeds()[0]; assert.equal(request.body.model, core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID);
    assert.equal(request.body.dimensions, 2); assert.deepEqual(request.body.input, ["Invented default-memory item."]);
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers["x-factory-fixture"], "invented-local-owner");
    assert.equal(rows(f.resource.file("reloads.jsonl"))[0].model, f.defaultPath);
    assertFacts(f, core, provider, f.defaultPath); assertReleased(f, 1); await f.stopped(f.resource);
  },
  async custom_payload(f, core) {
    const { provider, runtime } = await f.create(f.options(f.customA, {
      queryInputType: "fixture-query", documentInputType: "fixture-document",
      remote: { baseUrl: "https://example.invalid/ignored", apiKey: "synthetic-unused-remote-key" },
    }));
    assert.equal(provider.id, "local"); assert.equal(provider.model, f.customA);
    assert.deepEqual(runtime.cacheKeyData, { provider: "local", model: f.customA, outputDimensionality: 2 });
    assert.equal(runtime.indexIdentityAliases, undefined);
    assert.deepEqual(await f.run(() => provider.embed({ text: "ignored text", parts: [{ type: "text", text: "Invented " }, { type: "text", text: "query." }] },
      { inputType: "query", signal: f.signal })), [3, 4]);
    assert.deepEqual(await f.run(() => provider.embedBatch(["Invented first document.", "Invented second document."],
      { inputType: "document", signal: f.signal })), [[3, 4], [6, 8]]);
    assert.deepEqual(await f.run(() => provider.embedBatch([], { signal: f.signal })), []);
    const requests = f.embeds(); assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(row => row.body.input_type), ["fixture-query", "fixture-document"]);
    assert.deepEqual(requests[0].body.input, ["Invented query."]);
    assert.deepEqual(requests[1].body.input, ["Invented first document.", "Invented second document."]);
    assert.ok(requests.every(row => row.body.model === core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID && row.body.dimensions === 2));
    assert.ok(requests.every(row => row.headers.authorization === undefined), "Remote override does not enter official managed factory options");
    assert.equal(rows(f.resource.file("reloads.jsonl")).length, 1); assertFacts(f, core, provider, f.customA); assertReleased(f, 2);
    assert.equal(f.resource.starts().length, 1); await f.stopped(f.resource);
  },
  async factory_transition(f, core) {
    const paths = [f.customA, f.customB, f.customA], identities = [];
    for (const modelPath of paths) {
      const { provider, runtime } = await f.create(f.options(modelPath));
      identities.push(core.resolveMemoryIndexProviderIdentities({ provider, cacheKeyData: runtime.cacheKeyData }));
      assert.deepEqual(await f.run(() => provider.embed("Invented transition item.", { signal: f.signal })), [3, 4]);
      assertFacts(f, core, provider, modelPath);
    }
    assert.deepEqual(rows(f.resource.file("reloads.jsonl")).map(row => row.model), paths);
    assert.deepEqual(identities[0], identities[2]); assert.notDeepEqual(identities[0], identities[1]);
    assert.equal(f.resource.starts().length, 1, "Official factory transitions reuse the host-owned server");
    assertReleased(f, 3); await f.stopped(f.resource);
  },
  async request_cleanup(f, core) {
    const { provider } = await f.create(f.options());
    fs.writeFileSync(f.resource.file("request.mode"), "error");
    await assert.rejects(f.run(() => provider.embed("Invented HTTP failure item.", { signal: f.signal })), /HTTP 401/);
    assertFacts(f, core, provider, f.customA, "failed"); assertReleased(f, 1);
    fs.writeFileSync(f.resource.file("request.mode"), "stall");
    const controller = new AbortController(), reason = new Error("synthetic factory body cancelled");
    const rejected = assert.rejects(f.run(() => provider.embed("Invented cancelled item.", {
      signal: AbortSignal.any([controller.signal, f.signal]), inputType: "query",
    })), error => error === reason || error.name === "AbortError" || error.message.includes(reason.message));
    await until(() => fs.existsSync(f.resource.file("stall.ready")), "Official request did not reach stalled body", f.signal);
    controller.abort(reason); await rejected;
    await until(() => rows(f.resource.file("cancelled.jsonl")).length === 1, "Cancelled HTTP response did not physically close", f.signal);
    assertFacts(f, core, provider, f.customA, "failed"); assertReleased(f, 2); await f.stopped(f.resource);
  },
  async invalid_gguf(f) {
    const invalid = path.join(f.cacheDir, "invented-invalid.gguf"); fs.writeFileSync(invalid, "not a GGUF model");
    await assert.rejects(f.create(f.options(invalid)), /Model is not a GGUF file/);
    await assert.rejects(f.create(f.options(path.join(f.cacheDir, "invented-missing.gguf"))), /Model file is missing/);
    assert.equal(fs.existsSync(f.resource.file("models.ini")), false); assert.equal(f.resource.starts().length, 0); assert.equal(f.targets.length, 0);
  },
  async bundled(f, core) {
    const { provider, runtime } = await f.create(f.options());
    assert.equal(provider.id, "local"); assert.equal(provider.model, f.customA);
    assert.deepEqual(runtime.cacheKeyData, { provider: "local", model: f.customA, outputDimensionality: 2 });
    assert.deepEqual(await f.run(() => provider.embedBatch(["Invented standalone artifact item."], { signal: f.signal, inputType: "document" })), [[3, 4]]);
    assert.equal(f.embeds()[0].body.model, core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID);
    assert.equal(rows(f.resource.file("reloads.jsonl"))[0].model, f.customA);
    assertFacts(f, core, provider, f.customA); assertReleased(f, 1); await f.stopped(f.resource);
    f.assertStandalone();
  },
};

function caseRuntime(name, directory) {
  if (name !== "bundled") return { core: require("../app/agent-service/shoggoth-memory/core.cjs"), runWithHost: withMemoryHost, restore() {} };
  const copied = path.join(directory, "standalone-artifact"); fs.mkdirSync(copied, { mode: 0o700 });
  const files = ["core.cjs", "host-bridge.cjs"];
  for (const filename of files) fs.copyFileSync(path.join(__dirname, "../app/agent-service/shoggoth-memory", filename), path.join(copied, filename));
  const coreFile = path.join(copied, "core.cjs"), bridgeFile = path.join(copied, "host-bridge.cjs");
  const Module = require("node:module"), original = Module._load;
  const builtins = new Set(Module.builtinModules.map(value => value.replace(/^node:/, ""))), loaded = [];
  Module._load = function (id, parent, ...args) {
    if (builtins.has(id.replace(/^node:/, ""))) return original.call(this, id, parent, ...args);
    if (id === coreFile || id === bridgeFile || id === "./host-bridge.cjs" && parent?.filename === coreFile) {
      loaded.push(id); return original.call(this, id, parent, ...args);
    }
    throw new Error(`Standalone memory artifact attempted an external module: ${id}`);
  };
  try {
    const bridge = require(bridgeFile), core = require(coreFile);
    return { core, runWithHost: bridge.withMemoryHost, restore: () => { Module._load = original; },
      assertStandalone() {
        assert.deepEqual(fs.readdirSync(copied).sort(), [...files].sort());
        assert.ok(loaded.includes(coreFile)); assert.ok(loaded.includes(bridgeFile));
        assert.ok(loaded.every(id => id === coreFile || id === bridgeFile || id === "./host-bridge.cjs"));
      } };
  } catch (error) { Module._load = original; throw error; }
}

async function runCase(name, directory) {
  const runtime = caseRuntime(name, directory), core = runtime.core;
  for (const key of ["createConfiguredProviderLocalServiceAcquirer", "stopManagedProviderLocalServices", "getManagedProviderLocalServiceDiagnosticsForTest",
    "hasManagedProviderLocalServices", "reconcileManagedLlamaServer", "resolveMemoryIndexProviderIdentities", "createMemorySearchDeadlineControl"]) {
    assert.equal(typeof core[key], "function", `Missing native factory bundle export ${key}`);
  }
  for (const key of ["DEFAULT_LLAMA_CPP_EMBEDDING_MODEL", "DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID", "DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE"]) {
    assert.equal(typeof core[key], "string", `Missing pinned default ${key}`);
  }
  assert.equal(typeof core.MEMORY_SEARCH_DEADLINE_CONTROL, "symbol"); assert.equal(typeof core.llamaCppEmbeddingProviderAdapter?.create, "function");
  assert.equal(core.hasManagedProviderLocalServices(), false);
  const lifetime = new AbortController(), terminate = () => lifetime.abort(new Error("Isolated factory fixture terminated"));
  process.once("SIGTERM", terminate);
  const f = await factoryFixture(core, directory, lifetime.signal, runtime.runWithHost), errors = [];
  f.assertStandalone = runtime.assertStandalone;
  try { await cases[name](f, core); }
  catch (error) { errors.push(error); lifetime.abort(error); }
  try { await f.cleanup(); }
  catch (error) { errors.push(error); }
  f.revoke(); process.removeListener("SIGTERM", terminate); runtime.restore();
  if (errors.length) throw new AggregateError(errors, `Official llama factory case ${name} failed`);
  process.stdout.write(`fixture-llama-factory-ok:${name}\n`);
}

if (process.argv[2] === "--llama-factory-case") {
  runCase(process.argv[3], process.argv[4]).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const test = require("node:test");
  const descriptions = {
    identity: "official local GGUF identity preserves canonical defaults, aliases and requested dimensions",
    default_factory: "official default GGUF factory prepares a real preset and leases HTTP transport with readiness control",
    custom_payload: "official custom GGUF factory preserves canonical identity, query/document payloads and runtime inspection",
    factory_transition: "official GGUF factory applies A to B to A with canonical index identity and one shared server",
    request_cleanup: "official GGUF factory releases native request leases after HTTP failure and body cancellation",
    invalid_gguf: "official GGUF factory rejects missing or invalid local headers before preparing or starting resources",
    bundled: "copied core and host bridge run the official GGUF factory without checkout or external modules",
  };
  for (const [name, description] of Object.entries(descriptions)) test(description, { timeout: 40_000 }, async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `shoggoth-memory-llama-factory-${name}-`));
    const child = spawn(process.execPath, [__filename, "--llama-factory-case", name, directory], {
      cwd: path.resolve(__dirname, ".."), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", errorOutput = "", timedOut = false;
    child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { errorOutput += value; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 25_000);
    try {
      const [code, signal] = await bounded(once(child, "close"), `Factory fixture did not exit; retained at ${directory}`, 35_000);
      assert.equal(timedOut, false, `Factory fixture timed out: ${errorOutput}`);
      assert.equal(signal, null, errorOutput); assert.equal(code, 0, errorOutput);
      assert.equal(output, `fixture-llama-factory-ok:${name}\n`); fs.rmSync(directory, { recursive: true });
    } finally { clearTimeout(timer); }
  });
}
