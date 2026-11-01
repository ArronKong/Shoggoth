"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), https = require("node:https"), net = require("node:net");
const { execFileSync } = require("node:child_process");
const { EnvHttpProxyAgent } = require("undici");
const { createModelSecretTransport } = require("../app/agent-service/model-secret-transport");
const { buildCodexSpawnEnv } = require("../app/agent-service/codex-runtime-paths");

async function fixture(t) {
  const root = fs.mkdtempSync("/private/tmp/sg-model-transport-"), requests = [], tunnels = [], sockets = new Set(), transports = [];
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=model.fixture.invalid", "-addext", "subjectAltName=DNS:model.fixture.invalid,IP:127.0.0.1",
    "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem")], { stdio: "ignore" });
  const cert = fs.readFileSync(path.join(root, "cert.pem"));
  let response = (_req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end("data: synthetic-result\n\n"); };
  const provider = https.createServer({ key: fs.readFileSync(path.join(root, "key.pem")), cert }, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body }); response(req, res);
  });
  const proxy = http.createServer((_req, res) => { res.writeHead(400).end(); });
  const track = socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); };
  proxy.on("connection", track); provider.on("connection", track);
  proxy.on("connect", (req, client, head) => {
    tunnels.push({ authority: req.url, headers: req.headers });
    const upstream = net.connect(provider.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    track(upstream); client.once("close", () => upstream.destroy()); upstream.once("close", () => client.destroy());
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  class FixtureAgent extends EnvHttpProxyAgent {
    constructor(options) { super({ ...options, requestTls: { ca: cert }, connect: { ...options.connect, ca: cert } }); }
  }
  t.after(async () => {
    await Promise.all(transports.map(transport => transport.close()));
    for (const socket of sockets) socket.destroy();
    await Promise.all([provider, proxy].map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { requests, tunnels, setResponse: fn => { response = fn; },
    direct: `https://127.0.0.1:${provider.address().port}/responses`,
    transport(extra = {}) {
      const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
      const transport = createModelSecretTransport({ env: { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: "127.0.0.1", ...extra }, Agent: FixtureAgent });
      transports.push(transport); return transport;
    } };
}
const modelUrl = "https://model.fixture.invalid/responses";
const options = signal => ({ method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-only" }, signal });

test("the model transport uses the configured CONNECT proxy and honors NO_PROXY without exposing model headers to CONNECT", async t => {
  const f = await fixture(t), transport = f.transport(), data = '{"input":"synthetic projected text"}';
  const first = await transport.send(modelUrl, options(), data, 300000);
  assert.equal(first.statusCode, 200); assert.equal(await first.body.text(), "data: synthetic-result\n\n");
  assert.equal(f.tunnels.length, 1); assert.equal(f.tunnels[0].authority, "model.fixture.invalid:443");
  assert.equal(f.tunnels[0].headers.authorization, undefined);
  assert.equal(f.requests[0].headers.authorization, "Bearer synthetic-only"); assert.equal(f.requests[0].body, data);
  const second = await transport.send(f.direct, options(), data, 300000); await second.body.text();
  assert.equal(f.requests.length, 2); assert.equal(f.tunnels.length, 1, "NO_PROXY traffic connects directly");
  await transport.close(); await assert.rejects(transport.send(modelUrl, options(), data, 300000), { code: "SECRET_MODEL_GATEWAY_CLOSED" });
});

test("redirects remain unconsumed and invalid proxy aliases cannot dispatch", async t => {
  const f = await fixture(t), transport = f.transport();
  f.setResponse((_req, res) => { res.writeHead(307, { location: "https://untrusted.invalid/second" }); res.end("synthetic-redirect"); });
  const result = await transport.send(modelUrl, options(), "{}", 300000);
  assert.equal(result.statusCode, 307); result.body.destroy();
  assert.equal(f.requests.length, 1); assert.equal(f.tunnels.length, 1);
  const invalid = f.transport({ https_proxy: "http://127.0.0.1:1" });
  await assert.rejects(invalid.send(modelUrl, options(), "{}", 300000), { code: "SECRET_MODEL_PROXY_INVALID" });
  assert.equal(f.requests.length, 1); assert.equal(f.tunnels.length, 1);
});

test("canceling a streamed request closes that request and never resubmits its POST", async t => {
  const f = await fixture(t), transport = f.transport(), controller = new AbortController();
  let closed; const peerClosed = new Promise(resolve => { closed = resolve; });
  f.setResponse((_req, res) => { res.once("close", closed); res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: first\n\n"); });
  const result = await transport.send(modelUrl, options(controller.signal), "{}", 300000);
  const reading = result.body.text(); controller.abort();
  await assert.rejects(reading); await peerClosed;
  assert.equal(f.requests.length, 1);
  await transport.close();
});

test("Codex keeps remote proxies and user exclusions while protecting loopback even when NO_PROXY is empty", async t => {
  const f = await fixture(t);
  for (const noProxy of ["", "internal.example.test", "*"]) {
    const parentEnv = { HOME: "/private/tmp/synthetic", HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7898", NO_PROXY: noProxy, no_proxy: noProxy };
    const original = { ...parentEnv };
    const env = buildCodexSpawnEnv({ codexHome: "/private/tmp/synthetic/codex", parentEnv });
    assert.deepEqual(parentEnv, original);
    assert.equal(env.HTTP_PROXY, parentEnv.HTTP_PROXY); assert.equal(env.HTTPS_PROXY, parentEnv.HTTPS_PROXY);
    assert.equal(env.NO_PROXY, env.no_proxy);
    for (const host of ["localhost", "127.0.0.1", "::1", ...(noProxy ? [noProxy] : [])]) {
      assert(env.NO_PROXY.split(",").includes(host));
    }
    if (!noProxy) {
      const transport = f.transport({ NO_PROXY: env.NO_PROXY, no_proxy: env.no_proxy });
      const direct = await transport.send(f.direct, options(), "{}", 300000); await direct.body.text();
      assert.equal(f.tunnels.length, 0);
      const remote = await transport.send(modelUrl, options(), "{}", 300000); await remote.body.text();
      assert.equal(f.tunnels.length, 1, "remote models still use the configured proxy");
    }
  }
  assert.throws(() => buildCodexSpawnEnv({ codexHome: "/private/tmp/synthetic/codex",
    parentEnv: { NO_PROXY: "one.example", no_proxy: "two.example" } }), { code: "CODEX_SPAWN_ENV_INVALID" });
});
