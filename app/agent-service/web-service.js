"use strict";
const http = require("node:http"), https = require("node:https"), dns = require("node:dns/promises");
const { BlockList, isIP } = require("node:net");
const { serviceError } = require("./security");
const { WEB_PUBLIC_MESSAGES, validateWebArguments } = require("./web-tools");
const EXA_URL = "https://mcp.exa.ai/mcp";
const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],
  ["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],
  ["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]]) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::",23],["2001:db8::",32],["2002::",16],["3fff::",20]]) blocked.addSubnet(address, prefix, "ipv6");
function fail(code) { throw serviceError(code, WEB_PUBLIC_MESSAGES[code]); }
function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
function publicUrl(value) {
  let url; try { url = new URL(value); } catch { fail("WEB_INVALID"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || !url.hostname || /(?:^|\.)(?:localhost|local|internal|home|lan|onion)\.?$/iu.test(url.hostname)) fail("WEB_URL_BLOCKED");
  if (url.href.length > 8192) fail("WEB_INVALID");
  if (isIP(url.hostname.replace(/^\[|\]$/gu, "")) && !isPublicAddress(url.hostname.replace(/^\[|\]$/gu, ""))) fail("WEB_URL_BLOCKED");
  url.hash = ""; return url;
}
function abortError(signal) { fail(signal?.reason?.name === "TimeoutError" ? "WEB_TIMEOUT" : "WEB_CANCELED"); }
function raceAbort(promise, signal) {
  if (signal.aborted) { promise.catch(() => {}); abortError(signal); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { try { abortError(signal); } catch(e) { reject(e); } };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {});
  });
}
async function requestPublic(value, { method = "GET", headers = {}, body, signal, maxBytes = 1024 * 1024,
  allowRedirects = true, providerRequest = false, lookup = dns.lookup, request = (url, options, callback) => (url.protocol === "https:" ? https : http).request(url, options, callback) } = {}) {
  let url = publicUrl(value);
  signal ??= AbortSignal.timeout(20000);
  for (let hop = 0; hop <= 5; hop++) {
    if (signal.aborted) abortError(signal);
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    let addresses;
    try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await raceAbort(lookup(host, { all: true, verbatim: true }), signal); }
    catch (e) { if (signal.aborted) abortError(signal); fail(e.code?.startsWith("WEB_") ? e.code : "WEB_UNAVAILABLE"); }
    if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) fail("WEB_URL_BLOCKED");
    const pinned = addresses[0];
    const response = await new Promise((resolve, reject) => {
      const req = request(url, { method, agent: false, signal,
        lookup: (_hostname, options, callback) => callback(null, options?.all ? [pinned] : pinned.address, pinned.family),
        headers: { "User-Agent": "Shoggoth/1.0 (+public-web-reader)", "Accept-Encoding": "identity",
          Accept: "text/html, text/plain, application/json;q=0.9, text/markdown;q=0.9", ...headers } }, res => {
        const chunks = []; let size = 0;
        const declared = Number(res.headers["content-length"]);
        if (declared > maxBytes) { res.destroy(); req.destroy(); reject(serviceError("WEB_TOO_LARGE", WEB_PUBLIC_MESSAGES.WEB_TOO_LARGE)); return; }
        res.on("data", chunk => {
          size += chunk.length;
          if (size > maxBytes) { res.destroy(); req.destroy(); reject(serviceError("WEB_TOO_LARGE", WEB_PUBLIC_MESSAGES.WEB_TOO_LARGE)); }
          else chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: url.href }));
        res.on("error", () => reject(serviceError("WEB_UNAVAILABLE", WEB_PUBLIC_MESSAGES.WEB_UNAVAILABLE)));
      });
      req.on("error", () => reject(serviceError(signal.aborted ? signal.reason?.name === "TimeoutError" ? "WEB_TIMEOUT" : "WEB_CANCELED" : "WEB_UNAVAILABLE",
        WEB_PUBLIC_MESSAGES[signal.aborted ? signal.reason?.name === "TimeoutError" ? "WEB_TIMEOUT" : "WEB_CANCELED" : "WEB_UNAVAILABLE"])));
      req.end(body);
    });
    if ([301,302,303,307,308].includes(response.status)) {
      // Never redirect a provider POST or forward its protocol headers.
      if (!allowRedirects || method !== "GET" || !response.headers.location || hop === 5) fail("WEB_URL_BLOCKED");
      url = publicUrl(new URL(response.headers.location, url).href); continue;
    }
    if (response.status === 429) fail("WEB_RATE_LIMITED");
    if (providerRequest && [401,403].includes(response.status)) fail("WEB_AUTH_FAILED");
    if (providerRequest && [402,432,433].includes(response.status)) fail("WEB_QUOTA_EXCEEDED");
    if (response.status < 200 || response.status >= 300) fail("WEB_UNAVAILABLE");
    return response;
  }
  fail("WEB_UNAVAILABLE");
}
const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };
function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, key) => {
    if (!key.startsWith("#")) return entities[key.toLowerCase()] ?? whole;
    const n = parseInt(key.slice(key[1].toLowerCase() === "x" ? 2 : 1), key[1].toLowerCase() === "x" ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  });
}
function extractHtml(html) {
  // Never execute or render remote markup. Bounded tokenization also handles
  // unterminated script/style blocks without leaking their bodies into text.
  const out = [], title = []; let ignored = null, inTitle = false;
  for (const token of html.matchAll(/<!--[\s\S]*?(?:-->|$)|<![^<>]*>|<\/?([a-z][a-z0-9:-]*)\b[^<>]*>|[^<]+|</giu)) {
    const raw = token[0], tag = token[1]?.toLowerCase(), close = raw.startsWith("</");
    if (raw.startsWith("<!--") || raw.startsWith("<!")) continue;
    if (ignored) { if (tag === ignored && close) ignored = null; continue; }
    if (tag && ["script","style","noscript","svg","template"].includes(tag) && !close) { ignored = tag; continue; }
    if (tag === "title") { inTitle = !close; continue; }
    if (!tag && !raw.startsWith("<")) (inTitle ? title : out).push(decodeEntities(raw));
    else if (tag && /^(?:p|div|br|li|h[1-6]|tr|article|section|main|pre|blockquote|hr)$/u.test(tag)) out.push("\n");
  }
  return { title: title.join("").replace(/\s+/gu, " ").trim().slice(0, 500),
    text: out.join("").replace(/[ \t\f\v]+/gu, " ").replace(/ *\n */gu, "\n").replace(/\n{3,}/gu, "\n\n").trim() };
}
function truncate(value, maxChars) {
  // Keep the MCP 64 KiB envelope bounded even for four-byte Unicode text.
  let result = value.slice(0, maxChars).toWellFormed();
  while (Buffer.byteLength(JSON.stringify(result)) > 24000) result = result.slice(0, Math.floor(result.length * .9)).toWellFormed();
  return { text: result, truncated: result.length < value.length };
}
function rpcPayload(response, id) {
  const source = response.body.toString("utf8");
  const values = /text\/event-stream/iu.test(response.headers["content-type"] || "")
    ? source.split(/\r?\n\r?\n/u).map(block => block.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")).filter(Boolean)
    : [source];
  for (const value of values) {
    let message; try { message = JSON.parse(value); } catch { continue; }
    if (message.id !== id) continue;
    if (message.error || !message.result) fail("WEB_RESPONSE_INVALID"); return message.result;
  }
  fail("WEB_RESPONSE_INVALID");
}
class WebService {
  constructor({ request = requestPublic, now = Date.now, timeoutMs = 20000, settings = null, lookup = dns.lookup } = {}) {
    this.request = request; this.now = now; this.timeoutMs = timeoutMs; this.active = 0; this.settings = settings; this.lookup = lookup;
  }
  async call(name, args, { signal, profileId = null } = {}) {
    if (!validateWebArguments(name, args)) fail("WEB_INVALID");
    const timeout = AbortSignal.timeout(this.timeoutMs), boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (boundedSignal.aborted) abortError(boundedSignal);
    if (this.active >= 8) fail("WEB_BUSY");
    this.active++;
    try {
      let route;
      try { route = this.settings ? await raceAbort(this.settings.resolve(name, profileId), boundedSignal) : { provider: name === "web_search" ? "exa" : "direct", apiKey: null }; }
      catch { if (boundedSignal.aborted) abortError(boundedSignal); fail("WEB_CONFIG_UNAVAILABLE"); }
      if (boundedSignal.aborted) abortError(boundedSignal);
      const value = name === "web_search"
        ? route.provider === "exa" && !route.apiKey ? await this.search(args, boundedSignal) : await this.providerSearch(route, args, boundedSignal)
        : route.provider === "direct" ? await this.fetch(args, boundedSignal) : await this.providerFetch(route, args, boundedSignal);
      if (boundedSignal.aborted) abortError(boundedSignal);
      const result = { ...value, retrievedAt: new Date(this.now()).toISOString(), untrusted: true };
      // MCP may carry both text and structured content. Bound the whole result,
      // including source URLs and escaped control characters, before transport.
      while (Buffer.byteLength(JSON.stringify(result)) > 28 * 1024) {
        result.truncated = true;
        if (result.sources?.length) result.sources.pop();
        else if (result.text.length) result.text = result.text.slice(0, Math.floor(result.text.length * .8)).toWellFormed();
        else fail("WEB_TOO_LARGE");
      }
      try {
        const rawText = [result.text, result.title, result.url, result.finalUrl, result.query,
          ...(result.sources || []).flatMap(source => [source.title, source.url])].filter(value => typeof value === "string").join("\n");
        // Keep the captured key protected even if it was rotated/deleted while
        // this network request was in flight. Check raw text before JSON escapes.
        if (route.apiKey && rawText.includes(route.apiKey)) fail("WEB_RESPONSE_INVALID");
        this.settings?.assertSafe(JSON.stringify(result)); this.settings?.assertSafe(rawText);
      } catch { fail("WEB_RESPONSE_INVALID"); }
      return result;
    } finally { this.active--; }
  }
  async fetch({ url, maxChars = 12000 }, signal) {
    const response = await this.request(url, { signal });
    if (response.headers["content-encoding"] && response.headers["content-encoding"].toLowerCase() !== "identity") fail("WEB_CONTENT_UNSUPPORTED");
    const type = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!["text/html","application/xhtml+xml","text/plain","text/markdown","application/json","application/xml","text/xml"].includes(type)) fail("WEB_CONTENT_UNSUPPORTED");
    const charset = /charset=["']?([^;"'\s]+)/iu.exec(response.headers["content-type"] || "")?.[1] || "utf-8";
    let content; try { content = new TextDecoder(charset).decode(response.body); } catch { fail("WEB_CONTENT_UNSUPPORTED"); }
    const page = type.includes("html") ? extractHtml(content) : { title: "", text: content };
    return { provider: "direct", url, finalUrl: response.url, title: page.title, contentType: type, ...truncate(page.text, maxChars) };
  }
  async json(url, apiKey, { signal, body, header = "X-API-Key", method = "POST" }) {
    if (!apiKey) fail("WEB_API_KEY_REQUIRED");
    const response = await this.request(url, { method, signal, allowRedirects: false, providerRequest: true,
      maxBytes: 1024 * 1024, headers: { Accept: "application/json", "Content-Type": "application/json",
        [header]: header === "Authorization" ? `Bearer ${apiKey}` : apiKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let value;
    try { value = JSON.parse(response.body.toString("utf8")); } catch { fail("WEB_RESPONSE_INVALID"); }
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.error) fail("WEB_RESPONSE_INVALID");
    return value;
  }
  async providerSearch({ provider, apiKey }, { query, limit = 5, maxChars = 12000 }, signal) {
    let value, rows;
    if (provider === "exa") {
      value = await this.json("https://api.exa.ai/search", apiKey, { signal,
        body: { query, type: "auto", numResults: limit, contents: { highlights: true } } }); rows = value.results;
    } else if (provider === "brave") {
      if (query.length > 600 || query.trim().split(/\s+/u).length > 75) fail("WEB_QUERY_TOO_LONG");
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query); url.searchParams.set("count", String(limit)); url.searchParams.set("text_decorations", "false");
      value = await this.json(url.href, apiKey, { signal, method: "GET", header: "X-Subscription-Token" });
      rows = value.web?.results;
      // Brave omits web entirely for a valid search with no web results.
      if (value.web === undefined && value.type === "search") rows = [];
    } else if (provider === "tavily") {
      value = await this.json("https://api.tavily.com/search", apiKey, { signal, header: "Authorization",
        body: { query, max_results: limit, search_depth: "basic", include_answer: false, include_raw_content: false } }); rows = value.results;
    } else if (provider === "tinyfish") {
      const url = new URL("https://api.search.tinyfish.ai"); url.searchParams.set("query", query);
      value = await this.json(url.href, apiKey, { signal, method: "GET" }); rows = value.results;
    } else fail("WEB_CONFIG_UNAVAILABLE");
    if (!Array.isArray(rows)) fail("WEB_RESPONSE_INVALID");
    const sources = [], excerpts = [];
    for (const row of rows) {
      if (!row || typeof row.url !== "string") continue;
      let url; try { url = publicUrl(row.url).href; } catch { continue; }
      if (sources.some(item => item.url === url)) continue;
      const title = typeof row.title === "string" ? row.title.slice(0, 500).toWellFormed() : "";
      const snippet = [row.content, row.description, row.snippet, row.text,
        Array.isArray(row.highlights) ? row.highlights.filter(item => typeof item === "string").join("\n") : ""].find(item => typeof item === "string" && item);
      sources.push({ title, url }); excerpts.push(`Title: ${title}\nURL: ${url}\n${typeof snippet === "string" ? snippet.slice(0, maxChars) : ""}`);
      if (sources.length >= limit) break;
    }
    if (rows.length && !sources.length) fail("WEB_RESPONSE_INVALID");
    return { provider, query, sources, ...truncate(excerpts.join("\n\n"), maxChars) };
  }
  async publicTarget(value, signal) {
    const url = publicUrl(value), host = url.hostname.replace(/^\[|\]$/gu, "");
    let rows;
    try { rows = isIP(host) ? [{ address: host }] : await raceAbort(this.lookup(host, { all: true, verbatim: true }), signal); }
    catch { if (signal.aborted) abortError(signal); fail("WEB_UNAVAILABLE"); }
    if (!rows.length || rows.some(row => !isPublicAddress(row.address))) fail("WEB_URL_BLOCKED");
    return url.href;
  }
  async providerFetch({ provider, apiKey }, { url, maxChars = 12000 }, signal) {
    // Validate the target before sending it to a remote extractor. The provider
    // owns its network/redirect execution; Shoggoth validates its final URL too.
    if (!apiKey) fail("WEB_API_KEY_REQUIRED");
    const target = await this.publicTarget(url, signal);
    let value;
    if (provider === "exa") value = await this.json("https://api.exa.ai/contents", apiKey, { signal,
      body: { urls: [target], text: true } });
    else if (provider === "tavily") value = await this.json("https://api.tavily.com/extract", apiKey, { signal, header: "Authorization",
      body: { urls: [target], format: "markdown", extract_depth: "basic" } });
    else if (provider === "tinyfish") value = await this.json("https://api.fetch.tinyfish.ai", apiKey, { signal,
      body: { urls: [target], format: "markdown", per_url_timeout_ms: 18000 } });
    else fail("WEB_CONFIG_UNAVAILABLE");
    if ((Array.isArray(value.errors) && value.errors.length) || (Array.isArray(value.failed_results) && value.failed_results.length)
      || (Array.isArray(value.statuses) && value.statuses.some(row => row.status !== "success"))) fail("WEB_FETCH_FAILED");
    if (!Array.isArray(value.results) || value.results.length !== 1) fail("WEB_FETCH_FAILED");
    const page = value.results[0], text = provider === "tavily" ? page?.raw_content : page?.text;
    if (typeof text !== "string" || !text.trim() || typeof page.url !== "string") fail("WEB_FETCH_FAILED");
    publicUrl(page.url);
    const finalUrl = await this.publicTarget(page.final_url || page.url || target, signal);
    return { provider, url, finalUrl, title: typeof page.title === "string" ? page.title.slice(0, 500).toWellFormed() : "",
      contentType: provider === "exa" ? "text/plain" : "text/markdown", ...truncate(text, maxChars) };
  }
  async search({ query, limit = 5, maxChars = 12000 }, signal) {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const rpc = (method, params, id) => this.request(EXA_URL, { method: "POST", headers, signal, maxBytes: 512 * 1024, allowRedirects: false, providerRequest: true,
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }) });
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "shoggoth-web", version: "1.0.0" } }, 1);
    const initialized = rpcPayload(init, 1);
    if (!["2025-03-26", "2025-06-18", "2025-11-25"].includes(initialized.protocolVersion)) fail("WEB_RESPONSE_INVALID");
    headers["MCP-Protocol-Version"] = initialized.protocolVersion;
    if (init.headers["mcp-session-id"]) headers["Mcp-Session-Id"] = init.headers["mcp-session-id"];
    await rpc("notifications/initialized");
    const result = rpcPayload(await rpc("tools/call", { name: "web_search_exa", arguments: { query, numResults: limit, type: "auto", contextMaxCharacters: maxChars } }, 2), 2);
    if (!Array.isArray(result.content) || result.content.some(c => c.type !== "text" || typeof c.text !== "string")) fail("WEB_RESPONSE_INVALID");
    const content = result.content.map(c => c.text).join("\n");
    // Exa can return its keyless quota notice in a successful MCP envelope.
    // Match the provider notice prefix, never wording inside a search snippet.
    if (/^\s*You['’]ve hit Exa['’]s free MCP rate limit\b/iu.test(content)) fail("WEB_RATE_LIMITED");
    if (result.isError) fail("WEB_RESPONSE_INVALID");
    const sources = [];
    for (const match of content.matchAll(/(?:^|\n)Title: ([^\n]*)\n(?:(?!Title:)[\s\S])*?URL: (https?:\/\/[^\s]+)/gu)) {
      try { const url = publicUrl(match[2]).href; if (!sources.some(s => s.url === url)) sources.push({ title: match[1].slice(0, 500), url }); } catch {}
      if (sources.length >= limit) break;
    }
    return { provider: "exa", query, sources, ...truncate(content, maxChars) };
  }
}
module.exports = { WebService, requestPublic, publicUrl, isPublicAddress, extractHtml, rpcPayload, EXA_URL };
