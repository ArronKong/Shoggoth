"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { WebService, requestPublic, isPublicAddress, publicUrl, extractHtml, rpcPayload } = require("../app/agent-service/web-service");
const { validateWebArguments } = require("../app/agent-service/web-tools");
const { DEFAULT_TOOL_REGISTRY, validateMcpProductToolArguments } = require("../app/agent-service/mcp-product-tool-controller");
test("both web tools have validated read-only open-world contracts", () => {
  for (const name of ["web_search","web_fetch"]) {
    const definition = DEFAULT_TOOL_REGISTRY.mcpDefinitions().find(t => t.name === name);
    assert.equal(definition.annotations.readOnlyHint, true); assert.equal(definition.annotations.openWorldHint, true);
  }
  assert.equal(validateMcpProductToolArguments("web_search", { query: "news", limit: 5 }), true);
  assert.equal(validateWebArguments("web_search", { query: "", limit: 5 }), false);
  assert.equal(validateWebArguments("web_fetch", { url: "https://example.com", limit: 5 }), false);
  assert.equal(validateWebArguments("web_search", { query: "news", limit: 11 }), false);
  assert.equal(validateWebArguments("web_search", { query: "news", apiKey: "hidden" }), false);
});
test("public network policy rejects local, encoded, mapped and special addresses", () => {
  for (const address of ["127.0.0.1","0.0.0.0","10.1.2.3","169.254.169.254","100.64.0.1","172.20.0.2","192.168.3.2","198.18.0.1","224.0.0.1",
    "::1","::ffff:127.0.0.1","fc00::1","fe80::1","2001:db8::1","2002:7f00:1::","2001::1"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["1.1.1.1","8.8.8.8","2606:4700:4700::1111","2001:4860:4860::8888"]) assert.equal(isPublicAddress(address), true, address);
  for (const value of ["file:///etc/passwd","http://user:pass@example.com","http://localhost","http://x.local"]) assert.throws(() => publicUrl(value));
  assert.throws(() => publicUrl("http://2130706433"), { code: "WEB_URL_BLOCKED" });
});
function fakeRequest(replies, seen) {
  return (url, options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {}; req.end = body => {
      seen.push({ url: url.href, options, body });
      options.lookup(url.hostname, { all: true }, (error, rows) => { assert.equal(error, null); assert.equal(rows[0].address, "8.8.8.8"); });
      const reply = replies.shift(); const res = new EventEmitter(); res.headers = reply.headers || {}; res.statusCode = reply.status || 200;
      res.destroy = () => {}; callback(res);
      queueMicrotask(() => { res.emit("data", Buffer.from(reply.body || "")); res.emit("end"); });
    }; return req;
  };
}
test("DNS is pinned and every redirect target is rechecked", async () => {
  const seen = [], lookup = async host => [{ address: host === "private.example" ? "127.0.0.1" : "8.8.8.8", family: 4 }];
  await assert.rejects(requestPublic("https://public.example", { lookup, request: fakeRequest([{ status:302, headers:{ location:"http://private.example/secret" } }],seen) }), { code: "WEB_URL_BLOCKED" });
  assert.equal(seen.length, 1);
  await assert.rejects(requestPublic("https://mixed.example", { lookup: async () => [{address:"8.8.8.8",family:4},{address:"10.0.0.1",family:4}], request: () => assert.fail("must not connect") }), { code:"WEB_URL_BLOCKED" });
});
test("response byte limits and provider rate errors are enforced", async () => {
  const lookup = async () => [{address:"8.8.8.8",family:4}];
  await assert.rejects(requestPublic("https://public.example",{ lookup, maxBytes:4, request:fakeRequest([{body:"12345"}],[]) }), {code:"WEB_TOO_LARGE"});
  await assert.rejects(requestPublic("https://public.example",{ lookup, request:fakeRequest([{status:429}],[]) }), {code:"WEB_RATE_LIMITED"});
});
test("HTML is extracted without executing or retaining scripts", async () => {
  const html = '<html><head><title>A &amp; B</title><style>HIDDEN</style></head><body><h1>Hello</h1><script>PRIVATE SCRIPT</script><p>world &#x4e2d;</p></body></html>';
  const value = extractHtml(html); assert.equal(value.title,"A & B"); assert.match(value.text,/Hello/); assert.match(value.text,/world 中/); assert.doesNotMatch(value.text,/HIDDEN|SCRIPT/);
  assert.doesNotMatch(extractHtml("<p>hi</p><script>unterminated").text,/unterminated/);
  const web = new WebService({request:async () => ({ url:"https://example.com/final", headers:{"content-type":"text/html; charset=utf-8"}, body:Buffer.from(html) }), now:()=>0});
  const result = await web.call("web_fetch",{url:"https://example.com"}); assert.equal(result.finalUrl,"https://example.com/final"); assert.equal(result.untrusted,true); assert.equal(result.retrievedAt,"1970-01-01T00:00:00.000Z");
});
test("MCP initialization, SSE, source URLs and cancellation", async () => {
  const seen = [];
  const web = new WebService({request:async (_url,options) => {
    const body = JSON.parse(options.body); seen.push(body);
    if (body.method === "initialize") return {headers:{},body:Buffer.from(JSON.stringify({jsonrpc:"2.0",id:1,result:{protocolVersion:"2025-03-26"}}))};
    if (body.method === "notifications/initialized") return {headers:{},body:Buffer.alloc(0)};
    return {headers:{"content-type":"text/event-stream"},body:Buffer.from('event: message\ndata: '+JSON.stringify({jsonrpc:"2.0",id:2,result:{content:[{type:"text",text:"Title: Documentation\nURL: https://example.com/docs\nHighlights: Reference."}]}})+'\n\n')};
  }});
  const result=await web.call("web_search",{query:"docs",limit:2});
  assert.equal(seen[2].params.name,"web_search_exa"); assert.equal(seen[2].params.arguments.numResults,2); assert.equal(result.sources[0].url,"https://example.com/docs");
  const controller=new AbortController(); controller.abort(); await assert.rejects(web.call("web_search",{query:"docs"},{signal:controller.signal}),{code:"WEB_CANCELED"});
  assert.throws(()=>rpcPayload({headers:{},body:Buffer.from('{"id":2,"error":{"message":"oops"}}')},2),{code:"WEB_RESPONSE_INVALID"});
});

test("malformed HTML and escaped text stay bounded without retaining executable content", async () => {
  assert.equal(extractHtml("<a".repeat(10000)).text, "a".repeat(10000));
  const web = new WebService({ request: async () => ({ url: "https://example.com", headers: { "content-type": "text/plain" },
    body: Buffer.from("\u0001".repeat(16000)) }) });
  const value = await web.call("web_fetch", { url: "https://example.com", maxChars: 16000 });
  assert.equal(value.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 28 * 1024);
});
test("concurrent requests are bounded and released after completion", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const web = new WebService({ request: async () => { await gate; return {
    url: "https://example.com", headers: { "content-type": "text/plain" }, body: Buffer.from("ok") }; } });
  const pending = Array.from({ length: 8 }, () => web.call("web_fetch", { url: "https://example.com" }));
  await assert.rejects(web.call("web_fetch", { url: "https://example.com" }), { code: "WEB_BUSY" });
  release(); await Promise.all(pending); assert.equal((await web.call("web_fetch", { url: "https://example.com" })).text, "ok");
});

test("Exa keyless quota text is a rate-limit error even in a successful MCP envelope", async () => {
  const quota = "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.\n\nFix: Create API key at https://dashboard.exa.ai/api-keys";
  for (const isError of [false, true]) {
    const web = new WebService({ request: async (_url, options) => {
      const request = JSON.parse(options.body);
      const result = request.method === "initialize" ? { protocolVersion: "2025-03-26" }
        : { isError, content: [{ type: "text", text: quota }] };
      return { headers: {}, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result })) };
    } });
    await assert.rejects(web.call("web_search", { query: "docs" }), error => {
      assert.equal(error.code, "WEB_RATE_LIMITED");
      assert.doesNotMatch(error.message, /dashboard|api-keys/);
      return true;
    });
    assert.equal(web.active, 0);
  }
});
test("search snippets that quote rate-limit wording remain valid results", async () => {
  const web = new WebService({ request: async (_url, options) => {
    const request = JSON.parse(options.body);
    const result = request.method === "initialize" ? { protocolVersion: "2025-03-26" }
      : { content: [{ type: "text", text: "Title: Search documentation\nURL: https://example.com/docs\nHighlights: You've hit Exa's free MCP rate limit is an example error." }] };
    return { headers: {}, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result })) };
  } });
  assert.equal((await web.call("web_search", { query: "docs" })).sources.length, 1);
});
