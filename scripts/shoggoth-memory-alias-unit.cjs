"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { resolveMemoryCatalogModel: resolve, memoryModelAliases } = require("../app/agent-service/shoggoth-memory/model-aliases.cjs");
const { validateNativeMemoryConfigProjection: validate, validateNativeMemoryModelAliases } = require("../app/agent-service/native-memory-config-protocol");
const catalog = ["alpha/a", "alpha/b", "beta/a", "pi-chat"].map(model => ({ model }));
const select = (raw, aliases, rows = catalog) => resolve({ raw, aliases, catalog: rows, profileId: "profile", runtime: "pi" });
const deny = operation => assert.throws(operation, { code: "MODEL_NOT_FOUND" });

test("pinned alias index retains authored order, agent replacement, omission and explicit removal", () => {
  const defaults = { "alpha/a": { alias: " Recall " }, "alpha/b": { alias: "recall" } };
  assert.equal(select("RECALL", { defaults }), "alpha/b");
  assert.equal(select("recall", { defaults: { "alpha/b": defaults["alpha/b"], "alpha/a": defaults["alpha/a"] } }), "alpha/a");
  assert.equal(select("recall", { defaults, agent: { "alpha/a": {} } }), "alpha/b");
  assert.equal(select("recall", { defaults, agent: { "alpha/a": { alias: "recall" } } }), "alpha/a");
  assert.equal(select("recall", { defaults, agent: { "alpha/b": { alias: "" } } }), "alpha/a");
  deny(() => select("recall", { defaults, agent: { "alpha/a": { alias: " " }, "alpha/b": { alias: "" } } }));
  assert.equal(select("working memory", { defaults: { "pi-chat": { alias: "Working Memory" } } }), "pi-chat");
});

test("provider-qualified aliases retain scope even when the same bare name belongs to another provider", () => {
  const defaults = { "alpha/a": { alias: "shared" }, "beta/a": { alias: "SHARED" } };
  assert.equal(select("shared", { defaults }), "beta/a");
  assert.equal(select(" ALPHA/shared ", { defaults }), "alpha/a");
  assert.equal(select("beta/shared", { defaults }), "beta/a");
  const scoped = { "alpha/b": { alias: "beta/a" } };
  assert.equal(select("beta/a", { defaults: scoped }), "beta/a");
  assert.equal(select("alpha/beta/a", { defaults: scoped }), "alpha/b");
});

test("original static normalization maps only to a visible unambiguous native catalog ID", () => {
  const rows = ["anthropic/opus", "anthropic/claude-opus-5-5", "google/gemini-3-pro-preview", "alpha/alpha/a"].map(model => ({ model }));
  assert.equal(select("recall", { defaults: { "Anthropic/opus": { alias: "recall" } } }, rows), "anthropic/claude-opus-5-5");
  assert.equal(select("alpha/a", {}, rows), "alpha/alpha/a");
  deny(() => select("alpha/a", {}, [{ model: "ALPHA/a" }, { model: "Alpha/a" }]));
  deny(() => select("remember", { defaults: { "alpha/a": { alias: "remember" } } }, [{ model: "alpha/a", hidden: true }]));
  deny(() => select("remember", { defaults: { "outside/model": { alias: "remember" } } }));
  deny(() => select("all", { defaults: { "alpha/*": { alias: "all" } } }));
});

test("auth-profile suffixes cannot change Product accounts, including indirect alias targets", () => {
  const defaults = { "alpha/a": { alias: "recall" } };
  deny(() => select("recall@other-account", { defaults }));
  deny(() => select("recall", { defaults: { "alpha/a@other-account": { alias: "recall" } } }, [{ model: "alpha/a@other-account" }]));
  assert.equal(select("recall", { defaults: { "alpha/a@20261007@q8_0": { alias: "recall" } } }, [{ model: "alpha/a@20261007@q8_0" }]), "alpha/a@20261007@q8_0");
});

test("configuration preserves model insertion order and exposes only bounded plain alias fields", () => {
  const models = { "zeta/z": { alias: "same" }, "alpha/a": { alias: "same" } };
  const value = validate({ revision: 2, config: { agents: { defaults: { models }, entries: { profile: { models: { "alpha/a": {} } } } } } });
  assert.deepEqual(Object.keys(value.config.agents.defaults.models), ["zeta/z", "alpha/a"]);
  assert.ok(Object.isFrozen(value.config.agents.defaults.models["alpha/a"]));
  assert.deepEqual(memoryModelAliases(value.config, "other"), { defaults: models });
  let read = false;
  const getter = {}; Object.defineProperty(getter, "alpha/a", { enumerable: true, get() { read = true; return {}; } });
  for (const models of [getter, JSON.parse('{"__proto__":{"alias":"a"}}'), { "alpha/a": { apiKey: "private" } },
    { "alpha/a": { alias: null } }, { "alpha/a": { alias: "line\nbreak" } }, { "": {} },
    { "alpha/a": { params: { thinking: "high" } } }, Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`alpha/${i}`, {}]))]) {
    assert.throws(() => validateNativeMemoryModelAliases({ defaults: models }), { code: "NATIVE_MEMORY_CONFIG_INVALID" });
  }
  assert.equal(read, false);
});
