"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { discoverCustomResponseModels, MAX_CATALOG_BYTES, MAX_MODELS } = require("../app/agent-service/custom-response-models");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const input = { baseUrl: "https://gateway.example/openai/v1/", apiKey: "fixture-discovery-key" };
const json = (body, options) => new Response(JSON.stringify(body), options);

test("discovery only GETs the exact API root's catalog with a non-redirecting Bearer request", async () => {
  let calls = 0;
  const result = await discoverCustomResponseModels(input, async (url, options) => {
    calls += 1;
    assert.equal(url, "https://gateway.example/openai/v1/models");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.authorization, `Bearer ${input.apiKey}`);
    assert.equal(options.redirect, "manual");
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return json({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: true, reachable: true, message: "", models: ["model-a", "model-b"] });
});

test("accepts common catalog shapes and rejects malformed/reflected-secret model IDs", async () => {
  for (const body of [
    ["one", { id: "two" }],
    { models: [{ name: "one" }, { id: "two" }] },
    { data: [{ id: " one " }, { id: "two" }, { id: {} }, { name: "" }, null,
      { id: input.apiKey }, { id: `echo-${input.apiKey}` }, { id: "a\nb" }, { id: "x".repeat(1025) }] },
  ]) {
    const result = await discoverCustomResponseModels(input, async () => json(body));
    assert.deepEqual(result.models, ["one", "two"]);
  }
  const result = await discoverCustomResponseModels(input, async () => json({ data: [] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, []);
});

test("invalid API roots and header injection are rejected before any network request", async () => {
  const request = () => { throw new Error("must not request"); };
  for (const baseUrl of ["file:///tmp/models", "https://user:pass@gateway.example/v1",
    "https://gateway.example/v1?key=secret", "https://gateway.example/v1#secret",
    "https://gateway.example/v1/responses", "https://gateway.example/v1/chat/completions",
    "https://gateway.example/v1/%252Fresponses"]) {
    assert.equal((await discoverCustomResponseModels({ ...input, baseUrl }, request)).code, "invalid_url");
  }
  for (const apiKey of ["bad\r\nX-Key: injected", "x".repeat(65537)]) {
    assert.equal((await discoverCustomResponseModels({ ...input, apiKey }, request)).code, "authentication_failed");
  }
});

test("auth failures and redirects never expose response bodies or follow another host", async () => {
  for (const status of [401, 403, 302, 404, 500]) {
    let calls = 0;
    const result = await discoverCustomResponseModels(input, async () => {
      calls += 1;
      return new Response(`echo ${input.apiKey}`, { status, headers: { location: "https://other.example/models" } });
    });
    assert.equal(result.ok, false);
    assert.equal(result.reachable, true);
    assert.equal(result.code, status === 401 || status === 403 ? "authentication_failed" : "catalog_unavailable");
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(input.apiKey), false);
  }
});

test("catalog size, row count, malformed JSON and network errors have bounded safe results", async () => {
  for (const response of [
    new Response("", { headers: { "content-length": String(MAX_CATALOG_BYTES + 1) } }),
    new Response("x".repeat(MAX_CATALOG_BYTES + 1)),
  ]) {
    assert.equal((await discoverCustomResponseModels(input, async () => response)).code, "catalog_too_large");
  }
  const many = await discoverCustomResponseModels(input, async () => json({ data: Array.from({ length: 800 }, (_, i) => ({ id: `model-${i}` })) }));
  assert.equal(many.models.length, MAX_MODELS);
  for (const response of [new Response("not JSON"), json({ error: "not a catalog" })]) {
    assert.equal((await discoverCustomResponseModels(input, async () => response)).code, "invalid_catalog");
  }
  for (const name of ["TimeoutError", "TypeError"]) {
    const result = await discoverCustomResponseModels(input, async () => { throw Object.assign(new Error(input.apiKey), { name }); });
    assert.equal(result.code, name === "TimeoutError" ? "timeout" : "catalog_unavailable");
    assert.equal(JSON.stringify(result).includes(input.apiKey), false);
  }
});

test("Shoggoth delegates discovery to the selected native Profile without a mutation", async () => {
  const backend = new ShoggothBackend({ readToken: () => "fixture-token", requestService: async (_paths, request) => {
    assert.equal(request.method, "provider.endpoints.discover");
    assert.deepEqual(request.params, { profileId: "profile-second", endpoint: input });
    return { ok: true, reachable: true, message: "", models: ["discovered-model"] };
  } });
  const result = await backend.validateCustomEndpoint(input, { profile: "profile-second" });
  assert.deepEqual(result.models, ["discovered-model"]);
  const local = await discoverCustomResponseModels({ baseUrl: "http://localhost:11434/v1" }, async (_url, options) => {
    assert.equal(options.headers.authorization, undefined);
    return json({ data: [{ id: "local-model" }] });
  });
  assert.deepEqual(local.models, ["local-model"]);
});
