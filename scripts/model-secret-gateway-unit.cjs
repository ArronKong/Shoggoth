"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretGateway, TARGETS } = require("../app/agent-service/model-secret-gateway");
const SCOPE = { profileId: "fixture-agent", sessionId: "fixture-session" };
const SYNTHETIC_AUTH = "Bearer synthetic-fixture-auth-not-a-real-credential";
async function fixture(action) {
  const root = fs.mkdtempSync("/private/tmp/sg-gateway-unit-"), received = [], diagnostics = [];
  const secrets = await new TemporarySecretStore({ paths: { stateDir: path.join(root, "state"), trustedRoot: root },
    cryptoBroker: { encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse() } }).open();
  let respond = (_req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end("data: public-result\n\n"); };
  const provider = http.createServer(async (req, res) => {
    let data = ""; for await (const chunk of req) data += chunk;
    received.push({ path: req.url, headers: req.headers, body: JSON.parse(data) }); respond(req, res);
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const projection = new ModelSecretProjection({ secrets });
  const gateway = new ModelSecretGateway({ projection, onDiagnostic: event => diagnostics.push(event), request(url, options, callback) {
    assert(Object.values(TARGETS).some(base => url.href.startsWith(base)), "only the approved production endpoints can be selected");
    // Dependency injection redirects the wire to a loopback fixture; no real
    // credentials, user history, external account or external request is used.
    return http.request(new URL(url.pathname, `http://127.0.0.1:${provider.address().port}`), options, callback);
  } });
  try { await action({ gateway, secrets, received, diagnostics, projection, respond: handler => { respond = handler; } }); }
  finally { await gateway.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await secrets.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
async function send(route, body, headers = {}, suffix = "/responses") {
  const response = await startRequest(route, body, headers, suffix);
  return { status: response.status, text: await response.text(), headers: response.headers };
}
function startRequest(route, body, headers = {}, suffix = "/responses") {
  return fetch(route.baseUrl + suffix, { method: "POST", headers: { "content-type": "application/json",
    authorization: SYNTHETIC_AUTH, "chatgpt-account-id": "synthetic-account", ...headers }, body: JSON.stringify(body) });
}
test("actual upstream body is protected while original auth stays on the approved route", async () => fixture(async ({ gateway, received }) => {
  const route = await gateway.bind({ scope: SCOPE, providerKind: "openai-api-key" });
  const file = { type: "input_file", filename: "original.pages", file_data: "data:application/octet-stream;base64,AAECA/8=" };
  const result = await send(route, { model: "fixture", instructions: "password: 123456", input: [
    { type: "function_call_output", call_id: "call-123456", output: "123456\nPublic receipt" },
    { type: "message", role: "user", content: [file] }] }, { cookie: "must-not-forward", "x-arbitrary-secret": "must-not-forward" });
  assert.equal(result.status, 200); assert.equal(result.text, "data: public-result\n\n");
  assert.equal(received.length, 1); assert.equal(received[0].path, "/v1/responses");
  assert.equal(received[0].headers.authorization, SYNTHETIC_AUTH);
  assert.equal(received[0].headers["chatgpt-account-id"], "synthetic-account");
  assert.deepEqual(received[0].body.input[1].content, [file]);
  assert.equal(received[0].headers.cookie, undefined); assert.equal(received[0].headers["x-arbitrary-secret"], undefined);
  assert(!received[0].body.input[0].output.includes("123456")); assert(received[0].body.input[0].output.includes("Public receipt"));
  assert.equal(received[0].body.input[0].call_id, "call-123456"); assert(!result.text.includes(SYNTHETIC_AUTH));
}));
test("a response without a media type follows the requested stream mode and still records opaque proof", async () => fixture(async ({ gateway, respond }) => {
  const recorded = [];
  gateway.provenance = { verifier: async () => () => false, record: (_scope, value) => recorded.push(value) };
  const route = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  const item = { type: "reasoning", encrypted_content: "synthetic-response-proof" };
  const stream = `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`;
  respond((_req, res) => { res.writeHead(200); res.end(stream); });
  const streamed = await send(route, { stream: true, input: "public" });
  assert.equal(streamed.status, 200); assert.equal(streamed.headers.get("content-type"), "text/event-stream");
  assert.equal(streamed.text, stream); assert.deepEqual(recorded, [item]);
  recorded.length = 0;
  const json = JSON.stringify({ output: [item] });
  respond((_req, res) => { res.writeHead(200); res.end(json); });
  const plain = await send(route, { stream: false, input: "public" });
  assert.equal(plain.headers.get("content-type"), "application/json");
  assert.equal(plain.text, json); assert.deepEqual(recorded, [[item]]);
}));
test("malformed frames and proof-write failures terminate Codex with a safe non-retryable event", async () => fixture(async ({ gateway, respond, diagnostics }) => {
  gateway.provenance = { verifier: async () => () => false, record: (_scope, value) => {
    if (value.encrypted_content) throw Error(SYNTHETIC_AUTH);
  } };
  const route = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  const created = 'data: {"type":"response.created","response":{"id":"fixture"}}\r\n\r\n';
  for (const rejected of [`data: ${SYNTHETIC_AUTH}\n\n`, 'data: {"item":{"encrypted_content":"opaque-fixture"}}\n\n']) {
    respond((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(created);
      res.write(rejected.slice(0, 13));
      setTimeout(() => res.end(rejected.slice(13)), 25);
    });
    const response = await send(route, { stream: true, input: "public" });
    assert.equal(response.status, 200);
    assert(response.text.startsWith(created + "event: response.failed\n"));
    assert.match(response.text, /"code":"invalid_prompt","message":"SECRET_MODEL_RESPONSE_INVALID"/u);
    assert.doesNotMatch(response.text, /opaque-fixture|synthetic-fixture-auth/u);
    const { elapsedMs, ...diagnostic } = diagnostics.at(-1);
    assert(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0);
    assert.deepEqual(diagnostic, { reason: "local_rejection", bytes: Buffer.byteLength(created + rejected) });
  }
  assert.equal(diagnostics.length, 2);
}));
test("a dropped stream and a revoked route produce distinct bounded diagnostics", async () => fixture(async ({ gateway, respond, diagnostics }) => {
  const created = 'data: {"type":"response.created","response":{"id":"fixture"}}\n\n';
  let upstream;
  respond((_req, res) => {
    upstream = res;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(created);
  });
  for (const reason of ["upstream_unavailable", "canceled"]) {
    const route = await gateway.bind({ scope: SCOPE, providerKind: "openai-api-key" });
    const response = await startRequest(route, { stream: true, input: "public" });
    const reader = response.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), created);
    if (reason === "upstream_unavailable") {
      upstream.destroy();
      await assert.rejects(reader.read());
    } else {
      route.close();
      const failed = Buffer.from((await reader.read()).value).toString();
      assert.match(failed, /"code":"invalid_prompt","message":"SECRET_MODEL_CANCELED"/u);
      assert.equal((await reader.read()).done, true);
    }
    const { elapsedMs, ...diagnostic } = diagnostics.at(-1);
    assert(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0);
    assert.deepEqual(diagnostic, { reason, bytes: Buffer.byteLength(created) });
  }
  assert.equal(diagnostics.length, 2);
}));
test("Grok's original-content fallback does not expose a retryable transport failure", async () => fixture(async ({ gateway, projection, respond, received }) => {
  projection.project = async () => { throw Object.assign(Error("fixture"), { code: "SECRET_MEDIA_UNAVAILABLE" }); };
  const route = await gateway.bindGrokSession({ providerKind: "grok-api-key", resolveScope: () => SCOPE });
  respond((_req, res) => res.writeHead(503).end());
  assert.equal((await send(route, { stream: true, input: "original fixture" })).status, 400);
  assert.equal(received.length, 1);
  assert.equal(received[0].body.input, "original fixture");
}));
test("sessions have separate routes and known-value matching does not cross scope", async () => fixture(async ({ gateway, received, secrets }) => {
  await secrets.prepare({ scope: SCOPE, operationId: "secret", text: "password: 123456" });
  const a = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  const b = await gateway.bind({ scope: { ...SCOPE, sessionId: "other" }, providerKind: "chatgpt" });
  assert.notEqual(a.baseUrl, b.baseUrl);
  await send(a, { input: "123456" }); await send(b, { input: "123456" });
  assert.match(received[0].body.input, /^\{\{SHOGGOTH_SECRET_/u);
  assert.equal(received[1].body.input, "123456"); assert.equal(received[0].path, "/backend-api/codex/responses");
  a.close(); assert.equal((await send(a, { input: "public" })).status, 400); assert.equal(received.length, 2);
}));
test("browser requests, arbitrary destinations and unverified remote history never dispatch", async () => fixture(async ({ gateway, received }) => {
  const route = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  for (const [body, headers, suffix] of [
    [{ input: "public" }, { origin: "https://untrusted.invalid" }, "/responses"],
    [{ input: "public" }, {}, "/responses?upstream=https://untrusted.invalid"],
    [{ input: "public" }, {}, "/v1/models"],
    [{ input: "public", previous_response_id: "unverified" }, {}, "/responses"],
  ]) assert.equal((await send(route, body, headers, suffix)).status, 400);
  await assert.rejects(gateway.bind({ scope: SCOPE, providerKind: "custom-responses" }), { code: "SECRET_MODEL_ROUTE_UNSUPPORTED" });
  assert.equal(received.length, 0);
}));
test("unverified opaque history continues unchanged under the original-content policy", async () => fixture(async ({ gateway, received }) => {
  const route = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  const original = { input: [{ type: "reasoning", encrypted_content: "old-opaque-value" }] };
  assert.equal((await send(route, original)).status, 200);
  assert.deepEqual(received[0].body, original); assert.equal(received.length, 1);
}));
test("redirects and upstream diagnostics cannot disclose auth or create a second request", async () => fixture(async ({ gateway, received, respond }) => {
  const route = await gateway.bind({ scope: SCOPE, providerKind: "openai-api-key" });
  respond((_req, res) => { res.writeHead(307, { location: "https://untrusted.invalid/steal", "set-cookie": "private" }); res.end(SYNTHETIC_AUTH); });
  const result = await send(route, { input: "public" });
  assert.equal(result.status, 400); assert.equal(result.headers.get("location"), null); assert.equal(result.headers.get("set-cookie"), null);
  assert(!result.text.includes(SYNTHETIC_AUTH)); assert.equal(received.length, 1);
  respond((_req, res) => { res.writeHead(401); res.end(SYNTHETIC_AUTH); });
  const denied = await send(route, { input: "public" }); assert.equal(denied.status, 401);
  assert(!denied.text.includes(SYNTHETIC_AUTH)); assert.equal(received.length, 2);
}));
test("revocation while projection awaits cannot reach the upstream", async () => fixture(async ({ gateway, projection, received }) => {
  let began, finish; const started = new Promise(resolve => { began = resolve; });
  projection.project = async () => { began(); return new Promise(resolve => { finish = resolve; }); };
  const route = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  const pending = send(route, { input: "public" }); await started; route.close(); finish({ input: "public" });
  assert.equal((await pending).status, 400); assert.equal(received.length, 0);
}));
test("closing and restarting invalidates every old route", async () => fixture(async ({ gateway, received }) => {
  const route = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  await gateway.close(); gateway.reset();
  const current = await gateway.bind({ scope: SCOPE, providerKind: "chatgpt" });
  assert.notEqual(current.baseUrl, route.baseUrl);
  assert.equal((await send(current, { input: "public" }, {}, "/responses/compact")).status, 200);
  assert.equal(received[0].path, "/backend-api/codex/responses/compact");
}));

test("a local multi-session runtime cannot project unbound sessions or change ownership in flight", async () => fixture(async ({ gateway, secrets, projection, received }) => {
  await secrets.prepare({ scope: SCOPE, operationId: "secret", text: "password: 123456" });
  const scopes = new Map([["native-a", SCOPE], ["native-b", { ...SCOPE, sessionId: "other" }]]);
  const route = await gateway.bindLocalSessions({ resolveScope: id => scopes.get(id) });
  assert.equal(route.ready(), false);
  assert.equal((await send(route, { protocol: 1 }, {}, "/ready")).status, 200); assert.equal(route.ready(), true);
  const project = id => send(route, { sessionId: id, payload: { input: "123456" } }, {}, "/project");
  assert(!(await project("native-a")).text.includes("123456"));
  assert.equal(JSON.parse((await project("native-b")).text).input, "123456");
  assert.equal((await project("forged")).status, 503);
  assert.equal((await send(route, { input: "public" })).status, 503);
  let began, finish; const started = new Promise(resolve => { began = resolve; });
  projection.project = async () => { began(); return new Promise(resolve => { finish = resolve; }); };
  const waiting = project("native-a"); await started; scopes.set("native-a", scopes.get("native-b")); finish({ input: "public" });
  assert.equal((await waiting).status, 503); assert.equal(received.length, 0);
  route.close(); assert.equal(route.ready(), false);
}));
