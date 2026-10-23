#!/usr/bin/env node
"use strict";
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { createManagedOpenClawProviderCredentialClient } = require("../app/managed-openclaw-provider-credential-client");
const { writePrivateToken } = require("../app/agent-service/instance-state");
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-cred-ipc-")); fs.chmodSync(root, 0o700);
const run = path.join(root, "run"); fs.mkdirSync(run, { mode: 0o700 });
const tokenPath = path.join(run, "client.token"), socketPath = path.join(run, "service.sock");
const token = writePrivateToken(tokenPath);
const service = { instanceNonce: "a".repeat(48), pid: process.pid, startedAt: Date.now() - 1000, protocolVersion: SERVICE_PROTOCOL_VERSION };
const scope = { backendId: "openclaw", providerKey: "local", baseUrl: "http://127.0.0.1:12345/v1", api: "openai-completions",
  operationId: "channel-contract", requestDigest: "b".repeat(64) };
const writer = { version: 1, backendId: "openclaw", operationId: scope.operationId, requestDigest: scope.requestDigest,
  pid: process.pid, startIdentity: "synthetic channel contract only", nonce: "c".repeat(64), generation: "synthetic-generation", runtimeRoot: "/private/tmp/schema-runtime",
  runtimeTreeSha256: "d".repeat(64), dataRoot: "/private/tmp/schema-host-data", interpreterPath: "/private/tmp/external-node", entryPath: "/private/tmp/schema-runtime/openclaw.mjs", expiresAt: Date.now() + 120000 };
const permit = { version: 1, owner: { ownerId: "original-holder", capability: "e".repeat(64) }, scope, service, writer };
let current = true, handler, requests = [], connections = 0, children = new Set();
const server = net.createServer(socket => { connections++; children.add(socket); socket.on("close", () => children.delete(socket));
  let body = ""; socket.on("data", bytes => { body += bytes.toString(); if (!body.endsWith("\n")) return;
    const request = JSON.parse(body); requests.push(request); handler(socket, request); }); });
const envelope = (phase = "candidate", assertOnly = false) => ({ version: 1, ...scope, bindingRevision: 1, credentialRevision: 1,
  ownerGeneration: "original-logical-owner", expiresAt: Date.now() + 20000,
  ...(phase === "previous" ? { phase, previousScope: Object.fromEntries(Object.entries(scope).slice(0, 4)) } : { action: "set" }),
  ...(!assertOnly ? { apiKey: "synthetic-channel-canary" } : {}) });
const response = (socket, request, result) => socket.end(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
const context = (timeoutMs = 1000, signal) => ({ deadlineAt: Date.now() + timeoutMs, signal, assertCurrent() { if (!current) throw new Error("retired synthetic owner"); } });
const client = createManagedOpenClawProviderCredentialClient({ serviceUserDataRoot: root, assertCurrent: () => current });
const groups = [];
async function main() { try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); fs.chmodSync(socketPath, 0o600);
  handler = (socket, request) => response(socket, request, { service, envelope: envelope(request.params.phase, request.method.endsWith("assert")) });
  assert.equal((await client.read(permit, "candidate", context())).envelope.apiKey, "synthetic-channel-canary");
  assert.equal((await client.assert(permit, "previous", context())).envelope.phase, "previous");
  for (const request of requests) {
    assert.deepEqual(Object.keys(request).sort(), ["id", "method", "params", "token", "version"]);
    assert.equal(request.token, token); assert.equal(request.version, SERVICE_PROTOCOL_VERSION);
    assert.deepEqual(request.params.owner, permit.owner); assert.deepEqual(request.params.scope, scope); assert.deepEqual(request.params.writer, writer);
    assert(!JSON.stringify(request).includes("synthetic-channel-canary"));
  }
  assert.deepEqual(Object.keys(requests[0].params).sort(), ["owner", "phase", "recovery", "scope", "writer"]);
  assert.deepEqual(Object.keys(requests[1].params).sort(), ["owner", "phase", "scope", "writer"]);
  groups.push("real Unix socket carries only fixed file-token lease read/assert, exact owner/scope/writer and phase, with no key sent to Service");
  const validTokenBytes = fs.readFileSync(tokenPath), beforeMalformed = connections;
  for (const malformed of ["t".repeat(43), "A".repeat(64), "a".repeat(63), "a".repeat(66), "a".repeat(64) + "\n\n", "g".repeat(64)]) {
    fs.writeFileSync(tokenPath, malformed); await assert.rejects(client.read(permit, "candidate", context()), { code: "MANAGED_MODEL_CREDENTIAL_CHANNEL_INVALID" });
  }
  fs.writeFileSync(tokenPath, validTokenBytes); validTokenBytes.fill(0); assert.equal(connections, beforeMalformed);
  groups.push("formal Service token producer's exact lower64hex format works; base64/upperhex/short/long/extra newline/nonhex reject before connection");
  const before = connections; const abort = new AbortController(); abort.abort(); await assert.rejects(client.read(permit, "candidate", context(1000, abort.signal)));
  await assert.rejects(client.read({ ...permit, secret: "x" }, "candidate", context()));
  await assert.rejects(client.read(permit, "arbitrary-history", context()));
  assert.equal(connections, before); groups.push("pre-abort, caller secret and arbitrary phase fail before creating a connection");
  handler = (socket, request) => socket.end(JSON.stringify({ id: request.id, ok: true, result: { service: { ...service, pid: service.pid + 1 }, envelope: envelope() } }) + "\n");
  await assert.rejects(client.read(permit, "candidate", context()), { code: "MANAGED_MODEL_CREDENTIAL_CONTRACT_INVALID" });
  groups.push("success-shaped response from another Service process cannot publish credential material");
  for (const variant of ["id", "extra", "multi", "trailing", "malformed", "oversize"]) {
    handler = (socket, request) => { let frame = JSON.stringify({ id: request.id, ok: true, result: { service, envelope: envelope() } });
      if (variant === "id") frame = JSON.stringify({ id: "foreign", ok: true, result: { service, envelope: envelope() } });
      if (variant === "extra") frame = JSON.stringify({ id: request.id, ok: true, result: { service, envelope: envelope() }, callerAuthority: true });
      if (variant === "multi") frame += "\n{}"; if (variant === "trailing") frame += "\nx";
      if (variant === "malformed") frame = "{"; if (variant === "oversize") frame = "x".repeat(65537); socket.end(frame + "\n"); };
    await assert.rejects(client.read(permit, "candidate", context()));
  }
  groups.push("foreign id/extra authority/multiple frames/trailing bytes/malformed/oversize frames reject with fixed64KiB boundary");
  handler = (socket, request) => response(socket, request, { service, envelope: envelope("candidate", false) });
  await assert.rejects(client.assert(permit, "candidate", context()), { code: "MANAGED_MODEL_CREDENTIAL_CONTRACT_INVALID" });
  groups.push("assert must contain zero apiKey, even when authenticated response claims success");
  handler = socket => { current = false; socket.end("{}\n"); };
  await assert.rejects(client.read(permit, "candidate", context()), { code: "MANAGED_MODEL_CREDENTIAL_REQUEST_RETIRED" }); current = true;
  groups.push("owner retirement between dispatched request and frame prevents late material without a retry");
  handler = socket => { const old = tokenPath + ".old"; fs.renameSync(tokenPath, old); fs.writeFileSync(tokenPath, "b".repeat(64) + "\n", { mode: 0o600 }); socket.end("{}\n"); };
  await assert.rejects(client.read(permit, "candidate", context()), { code: "MANAGED_MODEL_CREDENTIAL_PATH_CHANGED" });
  fs.unlinkSync(tokenPath); fs.renameSync(tokenPath + ".old", tokenPath);
  groups.push("credential path inode replacement after connection rejects before accepting old material");
  handler = () => {};
  await assert.rejects(client.read(permit, "candidate", context(50)), { code: "MANAGED_MODEL_CREDENTIAL_REQUEST_TIMEOUT" });
  const flightAbort = new AbortController(); const pending = client.read(permit, "candidate", context(1000, flightAbort.signal));
  setTimeout(() => flightAbort.abort(), 20); await assert.rejects(pending, { code: "MANAGED_MODEL_CREDENTIAL_REQUEST_RETIRED" });
  groups.push("deadline and in-flight abort close their exact private socket; no replay or new owner is minted");
  handler = (socket, request) => { assert.deepEqual(Object.keys(request.params).sort(), ["outcome", "owner", "scope", "writer"]);
    response(socket, request, { service, envelope: { version: 1, backendId: "openclaw", providerKey: scope.providerKey,
      state: request.params.outcome, hasSecret: false, operationId: scope.operationId } }); };
  assert.equal((await client.settle(permit, "compensated", context())).envelope.state, "compensated");
  groups.push("settlement carries fixed outcome only and returns exact public status6, without material or phase");
  handler = (socket, request) => socket.end(JSON.stringify({ id: request.id, ok: false, error: { code: "X", message: "synthetic-channel-canary" } }) + "\n");
  await assert.rejects(client.read(permit, "candidate", context()), error => error.code === "MANAGED_MODEL_CREDENTIAL_SERVICE_REJECTED" && !error.message.includes("canary"));
  assert.equal(Object.hasOwn(client, "request"), false);
  groups.push("server error body is scrubbed and helper exposes no arbitrary method, path, plugin credential or transport fallback");
  process.stdout.write(JSON.stringify({ status: "PASS", groups: groups.length, cases: groups, serviceRequests: requests.length, hostStarts: 0, modelRequests: 0,
    secretWrites: 0, boundary: "real private Unix-socket transport + synthetic Service DTO; not physical Service Gate or Host credential application" }) + "\n");
} finally { for (const socket of children) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); } }
const watchdog = setTimeout(() => { process.stderr.write("credential channel watchdog\n"); process.exit(2); }, 15000);
main().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
