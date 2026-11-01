"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { spawn } = require("node:child_process"), { pathToFileURL } = require("node:url");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretGateway } = require("../app/agent-service/model-secret-gateway");
const { ExternalModelProjection } = require("../app/agent-service/external-model-projection");
const identity = { backendId: "openclaw", instanceId: "fixture-instance", agentId: "fixture-agent", sessionId: "session-a", runId: "run-a", toolCallId: "model-a" };
const params = { identity, credentialToken: "synthetic-local-pairing" };
async function fixture(action) {
  const root = fs.mkdtempSync("/private/tmp/sg-external-egress-");
  const secrets = await new TemporarySecretStore({ paths: { stateDir: path.join(root, "state"), trustedRoot: root },
    cryptoBroker: { encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse() } }).open();
  const projection = new ModelSecretProjection({ secrets });
  const gateway = new ModelSecretGateway({ projection, request() { throw Error("external local leases cannot forward to a provider"); } });
  let enabled = true, ownership = true;
  const service = new ExternalModelProjection({ gateway, paths: {}, authorize: (_p, _b, token) => enabled && token === params.credentialToken,
    assertHostCurrent() { assert(enabled); }, getOwner: async request => ownership ? { backendId: request.backendId, agentId: request.agentId,
      profileId: "fixture-profile", sessionKey: request.sessionKey } : null });
  try { await action({ secrets, projection, gateway, service, revoke: () => { enabled = false; }, changeOwner: () => { ownership = false; } }); }
  finally { service.close(); await gateway.close(); await secrets.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
async function post(endpoint, body, suffix = "/project") {
  const response = await fetch(endpoint + suffix, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}
test("external leases enforce identity, private scopes, expiry and no provider forwarding", () => fixture(async ({ service, secrets }) => {
  await assert.rejects(service.handle("mcp.external.model.bind", { ...params, credentialToken: "wrong" }));
  await assert.rejects(service.handle("mcp.external.model.bind", { ...params, identity: { ...identity, profileId: "forged" } }));
  await secrets.prepare({ scope: { profileId: "fixture-profile", sessionId: "session-a" }, operationId: "password", text: "password: 123456" });
  const leases = await Promise.allSettled([service.handle("mcp.external.model.bind", params), service.handle("mcp.external.model.bind", params)]);
  assert.equal(leases.filter(x => x.status === "fulfilled").length, 1);
  const a = leases.find(x => x.status === "fulfilled").value;
  const bParams = { ...params, identity: { ...identity, sessionId: "session-b" } };
  const b = await service.handle("mcp.external.model.bind", bParams);
  const aBody = await post(a.endpoint, { input: "123456" }); assert.equal(aBody.status, 200); assert(!aBody.text.includes("123456"));
  assert.equal(JSON.parse((await post(b.endpoint, { input: "123456" })).text).input, "123456");
  assert.equal((await post(a.endpoint, { input: "public" }, "/responses")).status, 503);
  await service.handle("mcp.external.model.release", params);
  assert.equal((await post(a.endpoint, { input: "public" })).status, 503);
  service.close(); assert.equal((await post(b.endpoint, { input: "public" })).status, 503);
}));
test("changing the session owner during local projection prevents a response", () => fixture(async ({ service, projection, changeOwner }) => {
  const a = await service.handle("mcp.external.model.bind", params);
  const original = projection.project.bind(projection);
  projection.project = async (...args) => { const safe = await original(...args); changeOwner(); return safe; };
  assert.equal((await post(a.endpoint, { input: "password: 123456" })).status, 503);
}));
test("OpenClaw adapter receives only the projected body and fails after revocation", () => fixture(async ({ service, revoke }) => {
  const { createAdapter } = await import(pathToFileURL(path.resolve(__dirname, "../resources/external-plugin-adapters/openclaw/index.mjs")));
  const adapter = createAdapter({ requestService: (method, p) => service.handle(method, p), credential: () => params.credentialToken, instanceId: identity.instanceId });
  const scope = { agentId: identity.agentId, sessionId: identity.sessionId, runId: identity.runId, requestId: identity.toolCallId };
  const safe = await adapter.projectModelPayload({ messages: [{ role: "user", content: "password: 123456\nPublic receipt" }] }, scope);
  assert(!JSON.stringify(safe).includes("123456")); assert(JSON.stringify(safe).includes("Public receipt")); assert.equal(service.leases.size, 0);
  revoke(); await assert.rejects(adapter.projectModelPayload({ input: "password: 123456" }, scope), { code: "SECRET_MODEL_PROJECTION_UNAVAILABLE" });
}));
test("real Hermes middleware failure never invokes the local mock provider", () => fixture(async ({ service }) => {
  const modelBodies = []; let revoked = false;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url === "/model") { modelBodies.push(body); res.end(JSON.stringify({ ok: true })); return; }
      if (req.url === "/revoke") { revoked = true; service.close(); res.end("{}"); return; }
      if (revoked) throw Error("revoked");
      const result = await service.handle(body.method, body.params); res.end(JSON.stringify(result));
    } catch { res.writeHead(503); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.env.SHOGGOTH_HERMES_TEST_PYTHON || "python3", [path.join(__dirname, "fixtures/chat-secret-hermes-middleware.py"),
      `http://127.0.0.1:${server.address().port}`], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
    const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(status, 0, output); assert.equal(modelBodies.length, 1);
    assert(!JSON.stringify(modelBodies).includes("123456")); assert(JSON.stringify(modelBodies).includes("Public receipt"));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));
