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
test("hosted extraction blocks private input and final URLs", async () => {
  for (const url of ["http://127.1", "http://[::1]", "http://169.254.169.254", "http://2130706433", "http://private.example/page"]) {
    const f = fixture("tinyfish", {}, key, async () => [{ address: "192.168.1.1", family: 4 }]);
    await assert.rejects(f.service.call("web_fetch", { url }), { code: "WEB_URL_BLOCKED" });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture("tinyfish", { results: [{ url: "https://example.com/page", final_url: "http://192.168.1.1/final", text: "fixture" }] });
  await assert.rejects(f.service.call("web_fetch", { url: "https://example.com/page" }), { code: "WEB_URL_BLOCKED" });
  assert.equal(f.calls.length, 1);
  for (const url of ["http://user:secret@example.com", "file:///etc/passwd"]) {
    const f = fixture("tinyfish", {}); await assert.rejects(f.service.call("web_fetch", { url }), { code: "WEB_INVALID" }); assert.equal(f.calls.length, 0);
  }
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
function network(status, headers = {}, payload = "{}") {
  const calls = [];
  const request = (url, options, callback) => {
    calls.push({ url, options }); const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => { const response = new EventEmitter(); response.statusCode = status; response.headers = headers; response.destroy = () => {};
      callback(response); queueMicrotask(() => { response.emit("data", Buffer.from(typeof payload === "function" ? payload(body) : payload)); response.emit("end"); }); };
    return req;
  };
  return { calls, request };
}
test("authenticated GET redirects cannot forward provider keys", async () => {
  const n = network(302, { location: "https://other.example/steal" });
  await assert.rejects(requestPublic("https://api.search.tinyfish.ai/?query=q", { providerRequest: true, allowRedirects: false,
    headers: { "X-API-Key": key }, lookup: pub, request: n.request }), { code: "WEB_REDIRECT_BLOCKED" });
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

const fakeDns = async () => [{ address: "198.18.0.42", family: 4 }];
for (const provider of ["exa", "brave", "tavily", "tinyfish"]) test(`${provider} search works through proxy fake-IP DNS with TLS verification and a pinned address`, async () => {
  const rows = [{ title: "Documentation", url: "https://example.com/docs", snippet: "Public documentation" }];
  const n = network(200, {}, JSON.stringify(provider === "brave" ? { web: { results: rows } } : { results: rows }));
  let lookups = 0;
  const service = new WebService({ settings: { resolve: async () => ({ provider, apiKey: key }), assertSafe: value => assert(!value.includes(key)) },
    request: (url, options) => requestPublic(url, { ...options, lookup: async () => { lookups++; return fakeDns(); }, request: n.request }) });
  const result = await service.call("web_search", { query: "documentation" });
  assert.equal(result.provider, provider); assert.equal(result.sources[0].url, rows[0].url);
  assert.equal(n.calls.length, 1); assert.equal(lookups, 1);
  const { url, options } = n.calls[0];
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, url.hostname);
  options.lookup(url.hostname, { all: true }, (error, addresses) => {
    assert.equal(error, null); assert.deepEqual(addresses, [{ address: "198.18.0.42", family: 4 }]);
  });
  options.lookup(url.hostname, {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, "198.18.0.42"); assert.equal(family, 4);
  });
  assert.equal(lookups, 1, "the transport must not resolve the hostname again");
});
test("Exa keyless MCP completes initialization and search through fake-IP DNS", async () => {
  const n = network(200, {}, body => {
    const rpc = JSON.parse(body);
    return JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize"
      ? { protocolVersion: "2025-03-26" }
      : { content: [{ type: "text", text: "Title: Documentation\nURL: https://example.com/docs\nPublic documentation" }] } });
  });
  const service = new WebService({ request: (url, options) => requestPublic(url, { ...options, lookup: fakeDns, request: n.request }) });
  assert.equal((await service.call("web_search", { query: "documentation" })).sources[0].url, "https://example.com/docs");
  assert.equal(n.calls.length, 3);
  assert(n.calls.every(({ url, options }) => url.href === "https://mcp.exa.ai/mcp" && options.rejectUnauthorized === true));
});
test("hosted extraction accepts Fake-IP for HTTPS provider and page hostnames", async () => {
  for (const provider of ["exa", "tavily", "tinyfish"]) {
    const n = network(200, {}, JSON.stringify({ results: [{ url: "https://example.com/page", final_url: "https://example.com/final", text: "Page text", raw_content: "Page text" }] }));
    const targets = [];
    const service = new WebService({ settings: { resolve: async () => ({ provider, apiKey: key }), assertSafe: value => assert(!value.includes(key)) },
      lookup: async host => { targets.push(host); return fakeDns(); },
      request: (url, options) => requestPublic(url, { ...options, lookup: fakeDns, request: n.request }) });
    const result = await service.call("web_fetch", { url: "https://example.com/page" });
    assert.equal(result.text, "Page text"); assert.equal(result.finalUrl, "https://example.com/final");
    assert.deepEqual(targets, ["example.com", "example.com"]);
    assert.equal(n.calls.length, 1);
  }
});
test("literal Fake-IP, local names and plain HTTP through Fake-IP stay blocked", async () => {
  for (const url of [
    "https://198.18.0.42/", "http://198.19.255.255/", "https://0xc612002a/", "http://3323068458/",
    "https://[::ffff:198.18.0.42]/", "http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/",
    "http://localhost/", "http://localhost../", "http://printer/", "https://printer./", "http://router.local/", "http://router.local../", "http://router.internal/",
    "http://router.home/", "http://router.lan/",
    "http://public.example/",
  ]) {
    const n = network(200);
    await assert.rejects(requestPublic(url, { lookup: fakeDns, request: n.request }), { code: "WEB_URL_BLOCKED" }, url);
    assert.equal(n.calls.length, 0);
  }
});
test("basic URL validation still rejects unsupported protocols and embedded credentials", async () => {
  for (const url of ["https://user:password@public.example/", "file:///etc/passwd", "ftp://public.example/", "not a URL"]) {
    await assert.rejects(requestPublic(url, { lookup: fakeDns,
      request: () => assert.fail("must not connect") }), { code: "WEB_INVALID" }, url);
  }
});
test("direct HTTP and HTTPS pages can follow public redirects through fake-IP DNS", async () => {
  for (const protocol of ["http:", "https:"]) {
    const start = `${protocol}//public.example/page`, final = "https://docs.example/page";
    const first = network(302, { location: final }), second = network(200, { "content-type": "text/html" }, "<title>Docs</title><p>Public page</p>");
    const lookups = [];
    const service = new WebService({ request: (url, options) => requestPublic(url, { ...options,
      lookup: async host => {
        lookups.push(host);
        return [{ address: host === "docs.example" ? "198.19.0.1" : protocol === "https:" ? "198.18.0.42" : "8.8.8.8", family: 4 }];
      },
      request: (url, ...args) => (url.hostname === "public.example" ? first : second).request(url, ...args) }) });
    const result = await service.call("web_fetch", { url: start });
    assert.equal(result.text, "Public page"); assert.equal(result.title, "Docs"); assert.equal(result.finalUrl, final);
    assert.deepEqual(lookups, ["public.example", "docs.example"]);
    assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 1);
    const options = second.calls[0].options;
    assert.equal(options.servername, "docs.example"); assert.equal(options.rejectUnauthorized, true);
    options.lookup("docs.example", {}, (error, address) => { assert.equal(error, null); assert.equal(address, "198.19.0.1"); });
  }
});
test("page redirects apply the same DNS and URL policy to the new target", async () => {
  for (const location of ["http://127.0.0.1/", "http://169.254.169.254/", "http://198.18.0.42/", "http://router.local/", "https://private.example/", "http://public.example/downgrade"]) {
    const first = network(302, { location }), second = network(200);
    const lookup = async host => host === "private.example" ? [{ address: "192.168.1.1", family: 4 }] : fakeDns();
    await assert.rejects(requestPublic("https://public.example/", { lookup,
      request: (url, ...args) => (first.calls.length === 0 ? first : second).request(url, ...args) }), { code: "WEB_URL_BLOCKED" });
    assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 0);
  }
});
test("provider requests block private, special or mixed DNS answers", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1",
    "198.51.100.1", "203.0.113.1", "::1", "fc00::1", "::ffff:198.18.0.42"]) {
    for (const addresses of [[{ address }], [...await fakeDns(), { address }]]) {
      const n = network(200);
      await assert.rejects(requestPublic("https://api.search.tinyfish.ai/", { providerRequest: true, allowRedirects: false,
        lookup: async () => addresses, request: n.request }), { code: "WEB_URL_BLOCKED" });
      assert.equal(n.calls.length, 0);
    }
  }
  for (const address of ["198.18.0.0", "198.19.255.255"]) {
    const n = network(200);
    await requestPublic("https://api.search.tinyfish.ai/", { providerRequest: true, allowRedirects: false,
      lookup: async () => [{ address, family: 4 }, { address: "8.8.8.8", family: 4 }], request: n.request });
    assert.equal(n.calls.length, 1);
  }
});
test("DNS failures stay network errors rather than public target policy errors", async () => {
  for (const lookup of [async () => [], async () => { throw Object.assign(new Error("fixture"), { code: "ENOTFOUND" }); }]) {
    await assert.rejects(requestPublic("https://public.example/", { lookup,
      request: () => assert.fail("unresolved targets cannot connect") }), { code: "WEB_UNAVAILABLE" });
  }
});
test("direct page reading blocks both literal and DNS loopback targets", async t => {
  const http = require("node:http"), requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url); res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>Fixture</title><p>Isolated page</p>");
  });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await assert.rejects(new WebService().call("web_fetch", { url: `http://127.0.0.1:${port}/literal` }), { code: "WEB_URL_BLOCKED" });
  const throughDns = new WebService({ request: (url, options) => requestPublic(url, { ...options,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }] }) });
  await assert.rejects(throughDns.call("web_fetch", { url: `http://local.fixture:${port}/dns` }), { code: "WEB_URL_BLOCKED" });
  assert.deepEqual(requests, []);
});
test("provider redirects never forward credentials, even when allowRedirects is accidentally enabled", async () => {
  for (const location of ["https://api.search.tinyfish.ai/?query=again", "https://api.exa.ai/search", "https://other.example/", "http://127.0.0.1/"]) {
    for (const allowRedirects of [false, true]) {
      const n = network(302, { location });
      await assert.rejects(requestPublic("https://api.search.tinyfish.ai/", { providerRequest: true, allowRedirects,
        headers: { "X-API-Key": key }, lookup: fakeDns, request: n.request }), { code: "WEB_REDIRECT_BLOCKED" });
      assert.equal(n.calls.length, 1);
    }
  }
});
test("missing and excessive redirects report a redirect failure", async () => {
  for (const headers of [{}, { location: "https://public.example/loop" }]) {
    const n = network(302, headers);
    await assert.rejects(requestPublic("https://public.example/", { lookup: fakeDns, request: n.request }), { code: "WEB_REDIRECT_FAILED" });
    assert.equal(n.calls.length, headers.location ? 6 : 1);
  }
});
test("fake-IP HTTPS transport verifies the hostname for both provider and ordinary page requests", async t => {
  const fs = require("node:fs"), path = require("node:path"), https = require("node:https");
  const { execFileSync } = require("node:child_process");
  const root = fs.mkdtempSync("/private/tmp/sg-web-tls-"), requests = [], errors = [], sockets = new Set();
  let server;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=api.search.tinyfish.ai", "-addext", "subjectAltName=DNS:api.search.tinyfish.ai",
    "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem")], { stdio: "ignore" });
  const cert = fs.readFileSync(path.join(root, "cert.pem"));
  server = https.createServer({ cert, key: fs.readFileSync(path.join(root, "key.pem")) }, (req, res) => {
    requests.push({ host: req.headers.host, key: req.headers["x-api-key"] }); res.end("{}");
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  // Route only this fixture's socket to loopback. Keep production TLS options
  // and the URL hostname, trusting the generated certificate only in this test.
  const request = (url, options, callback) => {
    const req = https.request(url, { ...options, port: server.address().port, ca: cert,
      lookup: (_host, opts, done) => done(null, opts?.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4) }, callback);
    req.once("error", error => errors.push(error.code)); return req;
  };
  const options = { allowRedirects: false, lookup: fakeDns, request,
    signal: AbortSignal.timeout(5000), headers: { "X-API-Key": key } };
  for (const providerRequest of [true, false]) {
    assert.equal((await requestPublic("https://api.search.tinyfish.ai/", { ...options, providerRequest })).status, 200);
    await assert.rejects(requestPublic("https://api.exa.ai/search", { ...options, providerRequest, method: "POST" }), { code: "WEB_UNAVAILABLE" });
  }
  assert.deepEqual(errors, ["ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERT_ALTNAME_INVALID"]);
  assert.equal(requests.length, 2, "the mismatched certificate must receive no HTTP request or API key");
  assert(requests.every(request => request.key === key));
});
