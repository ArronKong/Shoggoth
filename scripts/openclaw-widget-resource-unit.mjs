import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  AgentBackend,
  WIDGET_RESOURCE_MAX_BYTES,
  normalizeWidgetResourceContentType,
} = require("../app/core/agent-backend.js");
const { BackendRegistry } = require("../app/core/backend-registry.js");
const { CONNECT_CAPS } = require("../app/core/device-auth.js");
const {
  OpenClawBackend,
  gatewayHttpResourceUrl,
  normalizeCanvasWidgetResourcePath,
} = require("../app/core/openclaw-backend.js");
const { startStaticServer } = require("../app/static-server.js");

const CANVAS_PREFIX = "/__openclaw__/canvas/documents/";
const DOCUMENT_PATH = `${CANVAS_PREFIX}cv_test/index.html`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function requestLoopback(baseUrl, pathname, { method = "GET", headers = {} } = {}) {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: base.hostname,
      port: base.port,
      method,
      path: pathname,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

assert.deepEqual(CONNECT_CAPS, ["tool-events", "inline-widgets"]);
assert.equal(normalizeWidgetResourceContentType("text/html; charset=UTF-8"), "text/html; charset=utf-8");
assert.equal(normalizeWidgetResourceContentType("text/html; charset=iso-8859-1"), null);
assert.equal(normalizeWidgetResourceContentType("application/xhtml+xml"), null);

{
  const backend = new AgentBackend();
  assert.deepEqual(await backend.fetchWidgetResource(DOCUMENT_PATH), {
    supported: false,
    reason: "unsupported",
  });
}

{
  const valid = [
    DOCUMENT_PATH,
    `${CANVAS_PREFIX}cv-a_1.2/sub%20dir/%E6%96%87%E6%A1%A3.html`,
  ];
  for (const candidate of valid) {
    assert.equal(normalizeCanvasWidgetResourcePath(candidate), candidate);
  }
  const invalid = [
    "https://evil.example/widget.html",
    "/__openclaw__/canvas/documents/cv_test",
    `${CANVAS_PREFIX}cv_test/../secret`,
    `${CANVAS_PREFIX}cv_test/%2e%2e/secret`,
    `${CANVAS_PREFIX}cv_test/%2Fetc`,
    `${CANVAS_PREFIX}cv_test/%5cetc`,
    `${CANVAS_PREFIX}cv:test/index.html`,
    `${CANVAS_PREFIX}cv_test/index.html?token=secret`,
    `${CANVAS_PREFIX}cv_test/index.html#fragment`,
    `${CANVAS_PREFIX}cv_test/%00.html`,
    `${CANVAS_PREFIX}cv_test/%zz`,
    `${CANVAS_PREFIX}cv_test//index.html`,
    `${CANVAS_PREFIX}${"a".repeat(129)}/index.html`,
    `${CANVAS_PREFIX}cv_test/${"a".repeat(769)}`,
    `${CANVAS_PREFIX}cv_test/${Array.from({ length: 32 }, (_, i) => `s${i}`).join("/")}`,
  ];
  for (const candidate of invalid) {
    assert.equal(normalizeCanvasWidgetResourcePath(candidate), null, candidate);
  }

  assert.equal(
    gatewayHttpResourceUrl("wss://gateway.example:9443/rpc?leak=no", DOCUMENT_PATH)?.href,
    `https://gateway.example:9443${DOCUMENT_PATH}`,
  );
  assert.equal(gatewayHttpResourceUrl("https://gateway.example", DOCUMENT_PATH), null);
  assert.equal(gatewayHttpResourceUrl("ws://user:pass@gateway.example", DOCUMENT_PATH), null);
}

{
  const html = Buffer.from("<!doctype html><style>body{color:red}</style><script>document.body.append('ok')</script>");
  const upstreamCalls = [];
  const upstream = http.createServer((req, res) => {
    upstreamCalls.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (req.url === `${CANVAS_PREFIX}cv_test/redirect.html`) {
      res.writeHead(302, { Location: "http://127.0.0.1:1/must-not-follow" });
      res.end();
      return;
    }
    if (req.url === `${CANVAS_PREFIX}cv_test/wrong.bin`) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("not html");
      return;
    }
    if (req.url === `${CANVAS_PREFIX}cv_test/declared-large.html`) {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": WIDGET_RESOURCE_MAX_BYTES + 1,
      });
      res.end();
      return;
    }
    if (req.url === `${CANVAS_PREFIX}cv_test/stream-large.html`) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(Buffer.alloc(WIDGET_RESOURCE_MAX_BYTES + 1, 0x61));
      return;
    }
    if (req.url !== DOCUMENT_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=UTF-8",
      "Content-Length": html.length,
      "Content-Security-Policy": "default-src *; connect-src *",
      "Set-Cookie": "gateway-secret=must-not-cross",
      "X-Upstream-Secret": "must-not-cross",
    });
    res.end(req.method === "HEAD" ? undefined : html);
  });
  const upstreamPort = await listen(upstream);
  const backend = new OpenClawBackend({
    getUpstreamUrl: () => `ws://127.0.0.1:${upstreamPort}/rpc?must=disappear`,
    authResolver: {
      resolveConnectAuth: () => ({ token: "gateway-secret" }),
      storeDeviceToken() {},
      clearDeviceToken() {},
    },
  });
  backend._connect = async () => {};
  try {
    const result = await backend.fetchWidgetResource(DOCUMENT_PATH);
    assert.deepEqual(result, {
      supported: true,
      ok: true,
      contentType: "text/html; charset=utf-8",
      contentLength: html.length,
      body: html,
    });
    assert.deepEqual(upstreamCalls[0], {
      method: "GET",
      url: DOCUMENT_PATH,
      authorization: "Bearer gateway-secret",
    });

    const head = await backend.fetchWidgetResource(DOCUMENT_PATH, { method: "HEAD" });
    assert.deepEqual(head, {
      supported: true,
      ok: true,
      contentType: "text/html; charset=utf-8",
      contentLength: html.length,
    });
    assert.equal((await backend.fetchWidgetResource(`${CANVAS_PREFIX}cv_test/redirect.html`)).reason, "upstream-rejected");
    assert.equal((await backend.fetchWidgetResource(`${CANVAS_PREFIX}cv_test/wrong.bin`)).reason, "content-type");
    assert.equal((await backend.fetchWidgetResource(`${CANVAS_PREFIX}cv_test/declared-large.html`)).reason, "too-large");
    assert.equal((await backend.fetchWidgetResource(`${CANVAS_PREFIX}cv_test/stream-large.html`)).reason, "too-large");
    assert.equal((await backend.fetchWidgetResource(`${CANVAS_PREFIX}cv_test/missing.html`)).reason, "not-found");
    assert.equal((await backend.fetchWidgetResource("https://evil.example/widget.html")).reason, "invalid-path");
    assert.equal((await backend.fetchWidgetResource(DOCUMENT_PATH, { method: "POST" })).reason, "invalid-method");
  } finally {
    await close(upstream);
  }
}

{
  class FixtureBackend extends AgentBackend {
    get id() { return "fixture"; }
    get name() { return "Fixture"; }
    async fetchWidgetResource() {
      return {
        supported: true,
        ok: true,
        contentType: "text/html",
        contentLength: 7,
        body: Buffer.from("content"),
        contentSecurityPolicy: "default-src *",
        headers: { "Set-Cookie": "secret" },
        secret: "must-not-cross",
      };
    }
  }
  const registry = new BackendRegistry();
  registry.register(new FixtureBackend());
  assert.deepEqual(await registry.fetchWidgetResource("fixture", DOCUMENT_PATH), {
    supported: true,
    ok: true,
    contentType: "text/html; charset=utf-8",
    contentLength: 7,
    body: Buffer.from("content"),
  });
  assert.deepEqual(await registry.fetchWidgetResource("missing", DOCUMENT_PATH), {
    supported: false,
    reason: "unknown-backend",
  });
}

{
  const calls = [];
  const registry = {
    async fetchWidgetResource(backendId, resourcePath, options) {
      calls.push({ backendId, resourcePath, options });
      if (resourcePath.endsWith("wrong.bin")) {
        return { supported: true, ok: true, contentType: "application/octet-stream", body: Buffer.from("x") };
      }
      if (resourcePath.endsWith("large.html")) {
        return {
          supported: true,
          ok: true,
          contentType: "text/html",
          body: Buffer.alloc(WIDGET_RESOURCE_MAX_BYTES + 1),
        };
      }
      if (resourcePath.endsWith("timeout.html")) {
        return { supported: true, ok: false, reason: "timeout", error: "secret" };
      }
      return {
        supported: true,
        ok: true,
        contentType: "text/html",
        contentLength: 14,
        body: Buffer.from("<p>fixture</p>"),
        contentSecurityPolicy: "default-src *; connect-src https:",
        headers: { "Set-Cookie": "secret=must-not-cross" },
      };
    },
  };
  const server = await startStaticServer(0, { registry });
  const route = `/__widget/fixture${DOCUMENT_PATH}`;
  const sameOrigin = { "Sec-Fetch-Site": "same-origin" };
  try {
    const get = await requestLoopback(server.url, route, { headers: sameOrigin });
    assert.equal(get.status, 200);
    assert.equal(get.body.toString("utf8"), "<p>fixture</p>");
    assert.equal(get.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(get.headers["cache-control"], "no-store");
    assert.equal(get.headers["x-content-type-options"], "nosniff");
    assert.equal(get.headers["referrer-policy"], "no-referrer");
    assert.equal(get.headers["cross-origin-resource-policy"], "same-origin");
    assert.match(get.headers["permissions-policy"], /camera=\(\)/);
    assert.equal(get.headers["set-cookie"], undefined);
    assert.match(get.headers["content-security-policy"], /default-src 'none'/);
    assert.match(get.headers["content-security-policy"], /(?:^|;)\s*sandbox allow-scripts(?:;|$)/,
      "the response itself must stay sandboxed if its URL is opened outside the chat iframe");
    assert.match(get.headers["content-security-policy"], /connect-src 'none'/);
    assert.doesNotMatch(get.headers["content-security-policy"], /https:|default-src \*/);
    assert.deepEqual(calls[0], {
      backendId: "fixture",
      resourcePath: DOCUMENT_PATH,
      options: { method: "GET" },
    });

    const head = await requestLoopback(server.url, route, { method: "HEAD", headers: sameOrigin });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers["content-length"], "14");

    const beforeBlocked = calls.length;
    for (const fetchSite of [undefined, "none", "cross-site"]) {
      const headers = fetchSite ? { "Sec-Fetch-Site": fetchSite } : {};
      const blocked = await requestLoopback(server.url, route, { headers });
      assert.equal(blocked.status, 403);
    }
    // Sandboxed child resources have an opaque origin and are deliberately
    // cross-site in M7a, even though the generic route can represent the path.
    const child = await requestLoopback(server.url, `/__widget/fixture${CANVAS_PREFIX}cv_test/style.css`, {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    assert.equal(child.status, 403);
    assert.equal(calls.length, beforeBlocked);

    assert.equal((await requestLoopback(server.url, route, { method: "POST", headers: sameOrigin })).status, 405);
    assert.equal((await requestLoopback(server.url, `${route}?leak=1`, { headers: sameOrigin })).status, 404);
    assert.equal((await requestLoopback(server.url, "/__widget/%2Fbad/x", { headers: sameOrigin })).status, 404);
    assert.equal((await requestLoopback(server.url, "/__widget/%zz/x", { headers: sameOrigin })).status, 404);
    assert.equal((await requestLoopback(server.url, route, {
      headers: { ...sameOrigin, Host: "evil.example" },
    })).status, 403);
    assert.equal((await requestLoopback(server.url, `/__widget/fixture${CANVAS_PREFIX}cv_test/wrong.bin`, {
      headers: sameOrigin,
    })).status, 415);
    assert.equal((await requestLoopback(server.url, `/__widget/fixture${CANVAS_PREFIX}cv_test/large.html`, {
      headers: sameOrigin,
    })).status, 413);
    assert.equal((await requestLoopback(server.url, `/__widget/fixture${CANVAS_PREFIX}cv_test/timeout.html`, {
      headers: sameOrigin,
    })).status, 504);
  } finally {
    await server.close();
  }
}

console.log("openclaw widget resource: PASS");
