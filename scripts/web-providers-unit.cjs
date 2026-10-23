"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { WebService, requestPublic } = require("../app/agent-service/web-service");
const pub = async () => [{ address: "8.8.8.8", family: 4 }];
const reply = value => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(value)) });
const key = "fixture-private-web-key";
function fixture(provider, value, apiKey = key, lookup = pub) {
  const calls = [], settings = { resolve: async () => ({ provider, apiKey }), assertSafe: value => assert(!value.includes(key)) };
  const service = new WebService({ settings, lookup, request: async (url, options) => { calls.push({ url, options }); return reply(value); } });
  return { service, calls };
}
for (const provider of ["exa", "brave", "tavily", "tinyfish"]) test(`${provider} search uses official endpoint/auth and a bounded common result`, async () => {
  const rows = [{ title: "Page", url: "https://example.com/page", highlights: ["Exa excerpt"], content: "Tavily excerpt", snippet: "TinyFish excerpt", description: "Brave excerpt" },
    { title: "private", url: "http://127.0.0.1/private" }, { title: "duplicate", url: "https://example.com/page" }];
  const f = fixture(provider, provider === "brave" ? { type: "search", web: { results: rows } } : { results: rows });
  const result = await f.service.call("web_search", { query: "中文 docs", limit: 2 });
  assert.equal(result.provider, provider); assert.equal(result.untrusted, true); assert.deepEqual(result.sources, [{ title: "Page", url: "https://example.com/page" }]);
  assert.match(result.text, /excerpt/u); assert.equal(f.calls.length, 1);
  const { url, options } = f.calls[0];
  assert.equal(new URL(url).hostname, { exa: "api.exa.ai", brave: "api.search.brave.com", tavily: "api.tavily.com", tinyfish: "api.search.tinyfish.ai" }[provider]);
  assert.equal(options.allowRedirects, false); assert.equal(options.providerRequest, true);
  assert(!url.includes(key)); assert(!String(options.body).includes(key));
  assert.equal(options.headers[provider === "brave" ? "X-Subscription-Token" : provider === "tavily" ? "Authorization" : "X-API-Key"], provider === "tavily" ? `Bearer ${key}` : key);
  if (["exa", "tavily"].includes(provider)) assert.equal(JSON.parse(options.body)[provider === "exa" ? "numResults" : "max_results"], 2);
  else assert.equal(new URL(url).searchParams.get(provider === "brave" ? "q" : "query"), "中文 docs");
});
for (const provider of ["exa", "tavily", "tinyfish"]) test(`${provider} fetch extracts text and validates final public URL`, async () => {
  const f = fixture(provider, { results: [{ url: "https://example.com/page", final_url: "https://example.com/final", title: "New title", text: "Readable page", raw_content: "Readable page" }] });
  const result = await f.service.call("web_fetch", { url: "https://example.com/page" });
  assert.equal(result.provider, provider); assert.equal(result.text, "Readable page"); assert.equal(result.title, "New title");
  assert.equal(result.finalUrl, "https://example.com/final"); assert.equal(result.untrusted, true);
  assert.deepEqual(JSON.parse(f.calls[0].options.body).urls, ["https://example.com/page"]);
  assert.equal(new URL(f.calls[0].url).pathname, { exa: "/contents", tavily: "/extract", tinyfish: "/" }[provider]);
});
test("missing credentials never send an API request or fall back to another provider", async () => {
  for (const provider of ["brave", "tavily", "tinyfish"]) {
    const f = fixture(provider, {}, null);
    await assert.rejects(f.service.call("web_search", { query: "q" }), { code: "WEB_API_KEY_REQUIRED" }); assert.equal(f.calls.length, 0);
  }
  const f = fixture("exa", {}, null);
  await assert.rejects(f.service.call("web_fetch", { url: "https://example.com" }), { code: "WEB_API_KEY_REQUIRED" }); assert.equal(f.calls.length, 0);
});
test("provider URL extraction rejects private input, DNS and returned redirect targets", async () => {
  for (const url of ["http://127.1", "http://[::1]", "http://user:secret@example.com", "http://169.254.169.254", "http://2130706433"]) {
    const f = fixture("tinyfish", {}); await assert.rejects(f.service.call("web_fetch", { url }), { code: "WEB_URL_BLOCKED" }); assert.equal(f.calls.length, 0);
  }
  const privateDns = fixture("tinyfish", {}, key, async () => [{ address: "192.168.1.1" }]);
  await assert.rejects(privateDns.service.call("web_fetch", { url: "https://example.com" }), { code: "WEB_URL_BLOCKED" }); assert.equal(privateDns.calls.length, 0);
  const f = fixture("tinyfish", { results: [{ url: "https://example.com", final_url: "http://127.0.0.1", text: "secret" }] });
  await assert.rejects(f.service.call("web_fetch", { url: "https://example.com" }), { code: "WEB_URL_BLOCKED" });
});
test("HTTP-200 extraction failures and empty bodies stay failures", async () => {
  for (const [provider, payload] of [["tinyfish", { results: [], errors: [{ error: "bot_blocked", message: key }] }],
    ["tavily", { results: [], failed_results: [{ error: key }] }], ["exa", { results: [{ text: "ok" }], statuses: [{ status: "error" }] }],
    ["tinyfish", { results: [{ url: "https://example.com", text: "   " }] }],
    ["tinyfish", { results: [{ text: "Missing source URL" }] }]]) {
    const f = fixture(provider, payload);
    await assert.rejects(f.service.call("web_fetch", { url: "https://example.com" }), { code: "WEB_FETCH_FAILED", message: "服务商未能读取此网页，请检查地址或使用 Browser Use" });
  }
});
test("malformed search results and provider credential echoes are refused", async () => {
  for (const payload of [{ error: { message: key } }, { results: null }, { results: [{ url: "file:///etc/passwd" }] }]) {
    const f = fixture("tavily", payload); await assert.rejects(f.service.call("web_search", { query: "q" }), { code: "WEB_RESPONSE_INVALID" });
  }
  const f = fixture("tavily", { results: [{ title: "echo", url: "https://example.com", content: key }] });
  await assert.rejects(f.service.call("web_search", { query: "q" }), { code: "WEB_RESPONSE_INVALID" });
  const empty = fixture("brave", { type: "search" }); assert.deepEqual((await empty.service.call("web_search", { query: "q" })).sources, []);
});
test("captured keys stay protected after rotation and before JSON escaping", async () => {
  const captured = 'fixture-"old-key';
  const service = new WebService({ settings: { resolve: async () => ({ provider: "tavily", apiKey: captured }), assertSafe() {} },
    request: async () => reply({ results: [{ title: "echo", url: "https://example.com", content: captured }] }) });
  await assert.rejects(service.call("web_search", { query: "q" }), { code: "WEB_RESPONSE_INVALID" });
});
test("provider excerpts and Unicode stay inside the existing transport envelope", async () => {
  const f = fixture("tavily", { results: Array.from({ length: 10 }, (_, n) => ({ title: "😀".repeat(1000), url: `https://example.com/${n}?x=${"x".repeat(5000)}`, content: "😀".repeat(20000) })) });
  const result = await f.service.call("web_search", { query: "q", limit: 10, maxChars: 16000 });
  assert(Buffer.byteLength(JSON.stringify(result)) <= 28 * 1024); assert.equal(result.truncated, true); assert(result.text.isWellFormed());
});
function network(status, headers = {}) {
  const calls = [];
  const request = (url, options, callback) => {
    calls.push({ url, options }); const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => { const response = new EventEmitter(); response.statusCode = status; response.headers = headers; response.destroy = () => {};
      callback(response); queueMicrotask(() => { response.emit("data", Buffer.from("{}")); response.emit("end"); }); };
    return req;
  };
  return { calls, request };
}
test("authenticated GET redirects cannot forward provider keys", async () => {
  const n = network(302, { location: "https://other.example/steal" });
  await assert.rejects(requestPublic("https://api.search.tinyfish.ai/?query=q", { providerRequest: true, allowRedirects: false,
    headers: { "X-API-Key": key }, lookup: pub, request: n.request }), { code: "WEB_URL_BLOCKED" });
  assert.equal(n.calls.length, 1);
});
test("provider authentication, quota and rate failures have distinct safe codes", async () => {
  for (const [status, code] of [[401, "WEB_AUTH_FAILED"], [403, "WEB_AUTH_FAILED"], [402, "WEB_QUOTA_EXCEEDED"], [432, "WEB_QUOTA_EXCEEDED"], [433, "WEB_QUOTA_EXCEEDED"], [429, "WEB_RATE_LIMITED"]]) {
    const n = network(status); await assert.rejects(requestPublic("https://api.exa.ai/search", { providerRequest: true, allowRedirects: false,
      lookup: pub, request: n.request }), { code });
  }
});
test("Brave query limits and settings resolution cancellation are bounded", async () => {
  const f = fixture("brave", {}); await assert.rejects(f.service.call("web_search", { query: "x".repeat(601) }), { code: "WEB_QUERY_TOO_LONG" }); assert.equal(f.calls.length, 0);
  const abort = new AbortController(), service = new WebService({ settings: { resolve: () => new Promise(() => {}) } });
  const call = service.call("web_search", { query: "q" }, { signal: abort.signal }); abort.abort();
  await assert.rejects(call, { code: "WEB_CANCELED" }); assert.equal(service.active, 0);
});
