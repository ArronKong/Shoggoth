"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { validateNativeMemoryConfigProjection: validate, validateNativeMemoryRemoteHeaders: headers,
  validateNativeMemoryProviderRefs: refs } = require("../app/agent-service/native-memory-config-protocol");
const projection = search => ({ revision: 7, config: { memory: { search } } });
const invalid = value => assert.throws(() => validate(value), { code: "NATIVE_MEMORY_CONFIG_INVALID" });
const remote = { provider: "gemini", model: "gemini-embedding-2", fallback: "none", inputType: "search",
  queryInputType: "query", documentInputType: "document", outputDimensionality: 128,
  remote: { baseUrl: "https://fictional.example.invalid/v1", headers: { "X-Project": "synthetic:project", "X-Trace": "fixture" }, batch: { enabled: true } },
  providerRefs: { gemini: "owner:primary", openai: "owner:fallback" },
  multimodal: { enabled: true, modalities: ["image", "audio"], maxFileBytes: 1048576 } };

test("formal upstream remote fields round-trip frozen without credential or runtime additions", () => {
  const actual = validate(projection(remote)); assert.deepEqual(actual, projection(remote));
  assert.ok(Object.isFrozen(actual.config.memory.search.remote.headers)); assert.ok(Object.isFrozen(actual.config.memory.search.providerRefs));
  assert.equal(actual.config.memory.search.remote.apiKey, undefined);
  assert.deepEqual(validate(projection({ provider: "private-compatible", model: "", fallback: "none" })).config.memory.search,
    { provider: "private-compatible", model: "", fallback: "none" });
});
test("Profile references stay sparse and independently override their provider keys", () => {
  const value = projection({ ...remote, multimodal: { enabled: false } });
  value.config.agents = { entries: { a: { memory: { search: { providerRefs: { openai: "owner:profile" }, remote: { batch: { enabled: false } } } } },
    b: { memory: { search: { provider: "local", local: { modelPath: "/fictional/e.gguf" } } } } } };
  assert.deepEqual(validate(value), value);
  assert.deepEqual(validate(value).config.agents.entries.a.memory.search.providerRefs, { openai: "owner:profile" });
  assert.equal(validate(value).config.agents.entries.a.memory.search.providerRefs.gemini, undefined);
});
test("none, E5 and GGUF configurations remain valid with dormant remote choices preserved", () => {
  for (const provider of ["none", "shoggoth-e5", "local"]) {
    const search = { provider, local: { modelPath: "hf:fictional/model/e.gguf" }, providerRefs: { openai: "owner:future" },
      model: "local-model", fallback: "none", multimodal: { enabled: false, modalities: ["all"] } };
    assert.deepEqual(validate(projection(search)).config.memory.search, search);
  }
});
test("only opaque string owners and exact safe provider identifiers are public", () => {
  for (const provider of ["openai", "google", "gemini", "voyage", "mistral", "bedrock", "ollama", "lmstudio", "custom:adapter"]) {
    assert.equal(validate(projection({ provider })).config.memory.search.provider, provider);
  }
  for (const provider of ["", " openai", "openai ", "unknown/provider", "__proto__", "constructor", "a".repeat(129)]) invalid(projection({ provider }));
  for (const providerRefs of [{ openai: null }, { openai: { credentialRef: "fictional" } }, { openai: " padded" },
    { openai: "a".repeat(129) }, JSON.parse('{"__proto__":"fixture"}'), { constructor: "fixture" }]) invalid(projection({ providerRefs }));
  assert.deepEqual(refs({ openai: "fixture.primary", mistral: "fixture:fallback" }), { mistral: "fixture:fallback", openai: "fixture.primary" });
});
test("secret properties and auth headers cannot enter the public projection", () => {
  for (const search of [{ apiKey: "fictional" }, { credentialRef: "fictional" }, { runtimeCredentials: {} }, { remote: { apiKey: "fictional" } },
    { remote: { credentialRef: "fictional" } }, { remote: { auth: {} } }, { remote: { env: {} } }]) invalid(projection(search));
  for (const name of ["Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie", "X-API-Key", "x_access_token", "X-Password", "X-Secret", "X-Session", "xSignature"]) {
    invalid(projection({ remote: { headers: { [name]: "synthetic" } } }));
  }
  for (const value of ["Bearer fictional", "basic fictional", "token fictional", "sk-fictionalabcdefgh", "header\r\nInjected: value", "\ud800"]) {
    invalid(projection({ remote: { headers: { "X-Project": value } } }));
  }
  assert.deepEqual(headers({ "X-Project": "public-project", "X-Trace": "synthetic-id" }), { "X-Project": "public-project", "X-Trace": "synthetic-id" });
});
test("public custom headers cannot replace the endpoint authority or HTTP framing", () => {
  for (const name of ["Host", "hOsT", "Connection", "Proxy-Connection", "Keep-Alive", "Transfer-Encoding", "Content-Length", "TE", "Trailer", "Upgrade", ":authority"]) {
    invalid(projection({ remote: { headers: { [name]: "fictional-other.invalid" } } }));
    assert.throws(() => headers({ [name.toLowerCase()]: "fixture" }), { code: "NATIVE_MEMORY_CONFIG_INVALID" });
  }
});
test("headers reject case collisions, accessors, symbols and exotic records without executing getters", () => {
  let reads = 0; const getter = Object.defineProperty({}, "X-Project", { enumerable: true, get() { reads++; return "fictional"; } });
  for (const value of [getter, Object.create({ "X-Project": "fixture" }), { "X-Trace": "one", "x-trace": "two" }, { [Symbol("hidden")]: "fixture" },
    JSON.parse('{"__proto__":"fixture"}')]) invalid(projection({ remote: { headers: value } }));
  assert.equal(reads, 0);
  assert.throws(() => refs(Object.defineProperty({}, "openai", { enumerable: true, get() { reads++; return "owner"; } })), { code: "NATIVE_MEMORY_CONFIG_INVALID" });
  assert.equal(reads, 0);
});
test("public endpoints allow clean HTTP destinations and reject credential or ambiguous routing", () => {
  for (const baseUrl of ["http://127.0.0.1:19477/v1", "https://fictional.example.invalid/api/"]) assert.equal(validate(projection({ remote: { baseUrl } })).config.memory.search.remote.baseUrl, baseUrl);
  for (const baseUrl of ["file:///fixture", "ftp://fixture.invalid/", "https://user:fictional@fixture.invalid/v1", "https://fixture.invalid/?api_key=fictional", "https://fixture.invalid/?region=fictional", "https://fixture.invalid/#part", " https://fixture.invalid", "https://fixture.invalid\n"]) invalid(projection({ remote: { baseUrl } }));
});
test("active media follows native Gemini 2 stable and preview model normalization", () => {
  for (const model of ["gemini-embedding-2", "gemini-embedding-2-preview", "models/gemini-embedding-2", "models/google/gemini-embedding-2-preview", "gemini/gemini-embedding-2", "google/gemini-embedding-2"]) {
    assert.equal(validate(projection({ ...remote, model })).config.memory.search.model, model);
  }
  for (const model of [undefined, "", "gemini-embedding-001", "text-embedding-3-small", "Gemini-embedding-2"]) invalid(projection({ ...remote, model }));
  for (const modalities of [["video"], ["pdf"], ["IMAGE"]]) invalid(projection({ ...remote, multimodal: { enabled: true, modalities } }));
  for (const maxFileBytes of [0, -1, 1.5, Infinity]) invalid(projection({ ...remote, multimodal: { enabled: true, maxFileBytes } }));
});
test("inherited media validates every Profile model and fallback before any runtime admission", () => {
  for (const override of [{ fallback: "openai" }, { model: "gemini-embedding-001" }, { provider: "local" }]) {
    const value = projection(remote); value.config.agents = { entries: { a: { memory: { search: override } } } }; invalid(value);
  }
  const value = projection(remote); value.config.agents = { entries: { a: { memory: { search: { model: "gemini-embedding-2-preview", providerRefs: { gemini: "owner:profile" } } } } } };
  assert.deepEqual(validate(value), value);
  invalid(projection({ ...remote, fallback: "openai" }));
  assert.deepEqual(validate(projection({ ...remote, fallback: "openai", multimodal: { enabled: true, modalities: [] } })).config.memory.search.multimodal.modalities, []);
  assert.ok(validate(projection({ ...remote, model: "text", fallback: "openai", multimodal: { enabled: false } })));
});
test("unknown upstream private knobs and oversized public resource maps remain closed", () => {
  for (const search of [{ taskType: "QUERY" }, { timeout: 1 }, { query: { hybrid: true } }, { remote: { batch: { timeoutMs: 1 } } },
    { remote: { batch: { wait: true } } }, { remote: { discovery: {} } }, { multimodal: { allowed: ["image"] } }]) invalid(projection(search));
  invalid(projection({ providerRefs: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`p${i}`, `r${i}`])) }));
  invalid(projection({ remote: { headers: { "X-Large": "x".repeat(4097) } } }));
  invalid({ revision: -1, config: {} });
});


test("Core CAS and Service last-applied persistence retain formal remote settings without selecting a memory owner", t => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { createConfigStore, projectNativeMemoryConfig } = require("../app/core/config-store");
  const { NativeMemoryConfig } = require("../app/agent-service/native-memory-config");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-remote-public-config-"))); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createConfigStore(path.join(root, "core.json")); store.write({ locale: "zh-CN", theme: "dark" });
  const config = { memory: { search: remote }, agents: { entries: { a: { memory: { search: { providerRefs: { gemini: "owner:profile" }, remote: { headers: {} } } } } } } };
  const saved = store.writeNativeMemoryConfig({ expectedRevision: 0, config }), current = projectNativeMemoryConfig(saved);
  assert.equal(current.revision, 1); assert.deepEqual(current.config, config);
  assert.equal(saved.locale, "zh-CN"); assert.equal(saved.theme, "dark"); assert.equal(Object.hasOwn(saved, "memoryCore"), false);
  assert.deepEqual(projectNativeMemoryConfig(createConfigStore(store.path).read()), current);
  assert.throws(() => store.writeNativeMemoryConfig({ expectedRevision: 0, config: {} }), { code: "NATIVE_MEMORY_CONFIG_STALE" });
  const service = new NativeMemoryConfig({ paths: { stateDir: path.join(root, "state"), trustedRoot: root } }); service.open(); service.apply(current);
  const reopened = new NativeMemoryConfig({ paths: { stateDir: path.join(root, "state"), trustedRoot: root } }); reopened.open();
  assert.deepEqual(reopened.read(), current);
  assert.throws(() => reopened.apply({ revision: 1, config: {} }), { code: "NATIVE_MEMORY_CONFIG_CONFLICT" });
  assert.deepEqual(reopened.read(), current);
});
