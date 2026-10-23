"use strict";

// Configuration only: no provider construction, binary/model acquisition,
// inference, credentials or production files. Endpoints are fictional.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { validateNativeMemoryConfigProjection: validate, validateNativeMemoryLocalModels } = require("../app/agent-service/native-memory-config-protocol");
const { createConfigStore, projectNativeMemoryConfig } = require("../app/core/config-store");
const { NativeMemoryConfig } = require("../app/agent-service/native-memory-config");
const unavailable = { code: "NATIVE_MEMORY_CONFIG_INVALID" };
const provider = () => ({ baseUrl: "http://127.0.0.1:19432/v1", models: [], params: { modelCacheDir: "/fixture/models" },
  localService: { command: "/fixture/llama-server", args: ["--host", "127.0.0.1", "--port", "19432"],
    cwd: "/fixture", healthUrl: "http://127.0.0.1:19432/health", readyTimeoutMs: 30_000, idleStopMs: 0 } });
const settings = () => ({ memory: { search: { provider: "local", local: { modelPath: "/fixture/embedding.gguf" }, outputDimensionality: 768 } },
  models: { providers: { "llama-cpp": provider() } }, agents: { entries: {
    alpha: { memory: { search: { local: { modelPath: "other.gguf" }, outputDimensionality: 384 } } },
    beta: { memory: { search: { provider: "none" } } } } } });
const projection = config => validate({ revision: 7, config });
const withProvider = value => ({ models: { providers: { "llama-cpp": value } } });

test("complete local GGUF resources remain frozen and distinct from per-Profile search overrides", () => {
  const config = settings();
  config.models.providers["llama-cpp"].models.push({ id: "shared-chat", name: "Prepared chat model", params: { modelPath: "~/models/chat.gguf" } });
  const value = projection(config);
  assert.deepEqual(value, { revision: 7, config });
  assert.deepEqual(validateNativeMemoryLocalModels(config.models), value.config.models);
  assert.throws(() => validateNativeMemoryLocalModels({ ...config.models, workspace: "/private" }), unavailable);
  assert.ok(Object.isFrozen(value.config.models.providers["llama-cpp"].localService.args));
  assert.ok(Object.isFrozen(value.config.agents.entries.alpha.memory.search.local));
  assert.equal(value.config.models.providers["llama-cpp"].localService.idleStopMs, 0);
  assert.equal(value.config.agents.entries.alpha.memory.search.outputDimensionality, 384);
  assert.deepEqual(projection({ memory: { search: { provider: "none" } } }).config.memory.search, { provider: "none" });
  assert.deepEqual(projection({ memory: { search: { provider: "shoggoth-e5" } } }).config.memory.search, { provider: "shoggoth-e5" });
});

test("model sources and optional dimensions retain upstream local/default and public-download choices", () => {
  for (const modelPath of ["/fixture/model.gguf", "relative/model.gguf", "~/models/model.gguf", "hf:owner/repo/model.gguf",
    "hf:owner/repo/model.gguf@revision", "https://models.example/model.gguf", "http://models.example/model.gguf?download=true", "", " "]) {
    assert.equal(projection({ memory: { search: { provider: "local", local: { modelPath } } } }).config.memory.search.local.modelPath, modelPath);
  }
  assert.deepEqual(projection({ memory: { search: { provider: "local" } } }).config.memory.search, { provider: "local" });
  assert.equal(projection({ memory: { search: { outputDimensionality: 1 } } }).config.memory.search.outputDimensionality, 1);
  for (const modelPath of ["https://user:private@models.example/model.gguf", "https://models.example/model.gguf?apiKey=private",
    "https://models.example/model.gguf?access_token=private", "https://models.example/model.gguf?X-Amz-Credential=private",
    "https://models.example/model.gguf#secret=private", "https://models.example/model.gguf#token=private", "hf://private@repo/model.gguf", "file:///fixture/model.gguf", "bad\npath", "bad\0path"]) {
    assert.throws(() => projection({ memory: { search: { local: { modelPath } } } }), unavailable);
  }
  for (const outputDimensionality of [0, -1, 1.5, NaN, Infinity, "768", null]) {
    assert.throws(() => projection({ memory: { search: { outputDimensionality } } }), unavailable);
  }
  assert.throws(() => projection({ memory: { search: { local: { outputDimensionality: 768 } } } }), unavailable);
});

test("only explicit loopback HTTP inference and readiness endpoints are admitted", () => {
  for (const baseUrl of ["http://127.0.0.1:19432/v1", "http://localhost:19432/v1", "http://[::1]:19432/v1"]) {
    assert.equal(projection(withProvider({ ...provider(), baseUrl })).config.models.providers["llama-cpp"].baseUrl, baseUrl);
  }
  for (const address of ["https://remote.example/v1", "http://remote.example:19432/v1", "http://0.0.0.0:19432/v1",
    "http://127.1:19432/v1", "http://0x7f000001:19432/v1", "http://127.0.0.1/v1", "http://127.0.0.1:0/v1",
    "http://127.0.0.1:65536/v1", "http://private@127.0.0.1:19432/v1", "http://127.0.0.1:19432/v1?token=private",
    "http://127.0.0.1:19432/v1#fragment", "http://127.0.0.1:19432/../v1?x=1"]) {
    for (const health of [false, true]) {
      const value = provider(); if (health) value.localService.healthUrl = address; else value.baseUrl = address;
      assert.throws(() => projection(withProvider(value)), unavailable);
    }
  }
});

test("resource schema rejects secret, remote, discovery, arbitrary-adapter and argv bypasses", () => {
  for (const field of ["apiKey", "auth", "authHeader", "headers", "env", "discovery", "api", "agentRuntime", "request", "region"]) {
    assert.throws(() => projection(withProvider({ ...provider(), [field]: "private" })), unavailable);
  }
  for (const config of [withProvider({ ...provider(), params: { env: {} } }),
    withProvider({ ...provider(), localService: { ...provider().localService, env: { KEY: "private" } } }),
    withProvider({ ...provider(), models: [{ id: "prepared", name: "Prepared", apiKey: "private" }] }),
    withProvider({ ...provider(), models: [{ id: "prepared", name: "Prepared", params: { env: {} } }] }),
    { models: { providers: { openai: provider() } } },
    { models: { providers: { "llama-cpp": { baseUrl: "http://127.0.0.1:19432/v1", models: [] } } } }]) {
    assert.throws(() => projection(config), unavailable);
  }
  for (const args of [["--host", "0.0.0.0"], ["--host=remote.example"], ["--api-key", "private"], ["--api-key=private"],
    ["--password=private"], ["--headers", "Authorization: private"], ["--env", "KEY=private"], ["-H", "private"]]) {
    assert.throws(() => projection(withProvider({ ...provider(), localService: { ...provider().localService, args } })), unavailable);
  }
  assert.deepEqual(projection(withProvider({ ...provider(), localService: { command: "llama-server", args: ["--host=::1", "--embedding"] } }))
    .config.models.providers["llama-cpp"].localService.args, ["--host=::1", "--embedding"]);
});

test("resource validators reject getters and malformed arrays without reading them", () => {
  let accessed = false;
  const value = provider(); Object.defineProperty(value, "localService", { enumerable: true, get() { accessed = true; return {}; } });
  assert.throws(() => projection(withProvider(value)), unavailable); assert.equal(accessed, false);
  for (const args of [new Array(1), Object.assign([], { extra: "unwanted" })]) {
    assert.throws(() => projection(withProvider({ ...provider(), localService: { ...provider().localService, args } })), unavailable);
  }
  const config = JSON.parse('{"models":{"providers":{"__proto__":{}}}}');
  assert.throws(() => projection(config), unavailable);
});

test("Core CAS and last-applied Service persistence round-trip complete GGUF config without selecting an owner", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-gguf-config-"))); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createConfigStore(path.join(root, "core.json")); store.write({ locale: "en", theme: "dark" });
  const config = settings();
  const saved = store.writeNativeMemoryConfig({ expectedRevision: 0, config });
  const current = projectNativeMemoryConfig(saved);
  assert.equal(current.revision, 1); assert.deepEqual(current.config, config);
  assert.equal(saved.locale, "en"); assert.equal(saved.theme, "dark"); assert.equal(Object.hasOwn(saved, "memoryCore"), false);
  assert.throws(() => store.writeNativeMemoryConfig({ expectedRevision: 0, config: {} }), { code: "NATIVE_MEMORY_CONFIG_STALE" });
  assert.deepEqual(projectNativeMemoryConfig(createConfigStore(store.path).read()), current);
  const service = new NativeMemoryConfig({ paths: { stateDir: path.join(root, "state"), trustedRoot: root } }); service.open(); service.apply(current);
  const reopened = new NativeMemoryConfig({ paths: { stateDir: path.join(root, "state"), trustedRoot: root } }); reopened.open();
  assert.deepEqual(reopened.read(), current);
  assert.throws(() => reopened.apply({ revision: 1, config: {} }), { code: "NATIVE_MEMORY_CONFIG_CONFLICT" });
  assert.deepEqual(reopened.read(), current);
});
