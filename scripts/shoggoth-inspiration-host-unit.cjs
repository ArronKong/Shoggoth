"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createFederationHostServer } = require("../app/federation-host-server");
const { FederationHostClient } = require("../app/agent-service/federation-host-client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { FEDERATION_PROTOCOL_VERSION, validateFederationParams, validateFederationResult } = require("../app/federation-host-protocol");

const method = (name) => `inspiration.external.${name}`;
const identity = () => ({ executionId: crypto.randomUUID(), runId: crypto.randomUUID(),
  backendId: "openclaw", agentId: "fixture-agent" });
const binding = () => ({ sessionKey: "agent:fixture:opaque/key", workspace: "/fixture/workspace", mode: "openclaw" });
const snapshot = (params) => ({ ...Object.fromEntries(["executionId", "runId", "backendId", "agentId", "sessionKey", "workspace", "mode"]
  .map((key) => [key, params[key]])), status: "running", sequence: 1, resultSummary: null,
  errorCode: null, finishedAt: null, attention: null });
const registry = { getBackend() { assert.fail("Runner owns external target resolution"); },
  async getStatus() { assert.fail("External status must remain readable when a backend is offline"); } };

function fixturePaths(t) {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "insp-host-"));
  fs.chmodSync(trustedRoot, 0o700);
  t.after(() => fs.rmSync(trustedRoot, { recursive: true, force: true }));
  return resolveServicePaths({ trustedRoot, stateRoot: path.join(trustedRoot, "state"),
    profileRoot: path.join(trustedRoot, "profile"), cacheRoot: path.join(trustedRoot, "cache") });
}

async function fixture(t, overrides = {}, options = {}) {
  const paths = fixturePaths(t);
  const hostId = crypto.randomUUID();
  const calls = [];
  const runner = {
    async prepare(params) { calls.push(["prepare", params]); return { hostId, binding: binding() }; },
    async start(params) { calls.push(["start", params]); return { hostId, snapshot: snapshot(params) }; },
    async get(params) { calls.push(["get", params]); return { hostId, snapshot: snapshot(params) }; },
    async respond(params) { calls.push(["respond", params]); return { hostId, snapshot: snapshot(params) }; },
    async cancel(params) { calls.push(["cancel", params]); return { hostId, snapshot: snapshot(params) }; },
    reset() { calls.push(["reset"]); },
    ...overrides,
  };
  const host = createFederationHostServer({ paths, registry, inspirationRunner: runner });
  await host.start();
  t.after(() => host.stop());
  const client = new FederationHostClient({ paths, ...options });
  const base = { ...identity(), ...binding(), hostId };
  const prepare = { ...identity(), sessionKey: null, workspace: null, operationId: "fixture-operation" };
  return { paths, hostId, calls, runner, host, client, base, prepare };
}

test("Private host routes all five external methods without colliding prepare/start operation ids", async (t) => {
  const f = await fixture(t);
  const prepared = await f.client.request(method("prepare"), f.prepare);
  assert.deepEqual(await f.client.request(method("prepare"), f.prepare), prepared);
  const base = { ...f.prepare, ...prepared.binding, hostId: prepared.hostId };
  delete base.operationId;
  const start = { ...base, prompt: "Original idea", operationId: f.prepare.operationId };
  assert.equal((await f.client.request(method("start"), start)).snapshot.agentId, f.prepare.agentId);
  await f.client.request(method("start"), start);
  await f.client.request(method("get"), base);
  await f.client.request(method("respond"), { ...base, operationId: "response-operation", requestId: "request-1",
    response: { action: "submit", answers: { secret: "fixture-secret" } } });
  await f.client.request(method("cancel"), { ...base, operationId: "cancel-operation" });
  assert.deepEqual(f.calls.map(([name]) => name), ["prepare", "start", "get", "respond", "cancel"]);
  await assert.rejects(f.client.request(method("start"), { ...start, prompt: "Changed idea" }),
    { code: "FEDERATION_OPERATION_CONFLICT" });
  await f.host.stop();
  assert.equal(f.calls.at(-1)[0], "reset");
});

test("External methods retain strict authenticated request validation and remain optional", async (t) => {
  const f = await fixture(t);
  for (const invalid of [{ ...f.prepare, extra: true }, { ...f.prepare, backendId: "codex" },
    { ...f.prepare, workspace: "relative/path" }, { ...f.prepare, runId: "not-a-uuid" }]) {
    assert.equal(validateFederationParams(method("prepare"), invalid), false);
    await assert.rejects(f.client.request(method("prepare"), invalid), { code: "APP_HOST_INVALID_REQUEST" });
  }
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection(f.paths.federationSocketPath);
    let body = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => { body += chunk; });
    socket.on("end", () => resolve(JSON.parse(body)));
    socket.on("connect", () => socket.write(JSON.stringify({ id: "bad-token", token: "wrong",
      version: FEDERATION_PROTOCOL_VERSION, method: method("prepare"), params: f.prepare }) + "\n"));
  });
  assert.equal(response.error.code, "APP_HOST_INVALID_REQUEST");
  assert.equal(f.calls.length, 0);
  await f.host.stop();
  const optionalHost = createFederationHostServer({ paths: f.paths, registry });
  await optionalHost.start();
  t.after(() => optionalHost.stop());
  await assert.rejects(f.client.request(method("prepare"), f.prepare), { code: "APP_HOST_UNAVAILABLE" });
});

test("Host rejects cross-bound snapshots and prepare responses before sending them", async (t) => {
  const f = await fixture(t);
  const valid = { hostId: f.hostId, snapshot: snapshot(f.base) };
  for (const field of ["executionId", "runId", "backendId", "agentId", "sessionKey", "workspace", "mode", "hostId"]) {
    const forged = structuredClone(valid);
    if (field === "hostId") forged.hostId = crypto.randomUUID();
    else forged.snapshot[field] = field.endsWith("Id") && ["executionId", "runId"].includes(field)
      ? crypto.randomUUID() : field === "backendId" ? "hermes" : field === "workspace" ? "/another/workspace" : "other";
    const requestMethod = field === "hostId" ? "start" : "get";
    const params = field === "hostId" ? { ...f.base, prompt: "Prompt", operationId: "wrong-host" } : f.base;
    f.runner[requestMethod] = async () => forged;
    assert.equal(validateFederationResult(method(requestMethod), forged, params), false);
    await assert.rejects(f.client.request(method(requestMethod), params), { code: "FEDERATION_RESPONSE_INVALID" });
  }
  f.runner.get = async () => ({ ...valid, hostId: crypto.randomUUID() });
  assert.notEqual((await f.client.request(method("get"), f.base)).hostId, f.base.hostId,
    "Read-only recovery may discover a restarted host while preserving the execution binding");
  f.runner.prepare = async () => ({ hostId: f.hostId, binding: { ...binding(), mode: "acp" } });
  await assert.rejects(f.client.request(method("prepare"), f.prepare), { code: "FEDERATION_RESPONSE_INVALID" });
});

test("Host preserves only known public external codes, never private exception messages", async (t) => {
  const f = await fixture(t);
  for (const code of ["INSPIRATION_BINDING_INVALID", "INTERACTION_RESPONSE_INVALID", "OPENCLAW_REQUEST_STALE",
    "HERMES_INTERACTION_STALE", "OPENCLAW_PRIVATE_CANARY", "INTERNAL_PRIVATE_CANARY"]) {
    f.runner.get = async () => { throw Object.assign(new Error("fixture-private-canary"), { code }); };
    const expected = code.includes("PRIVATE_CANARY") ? "AGENT_OPERATION_FAILED" : code;
    await assert.rejects(f.client.request(method("get"), f.base), (error) => error.code === expected
      && !error.message.includes("fixture-private-canary"));
  }
});

test("External request deadlines distinguish reads from uncertain mutations", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [name, duration] of [["prepare", 30_000], ["start", 5_000], ["get", 5_000], ["respond", 15_000], ["cancel", 15_000]]) {
    let entered;
    const waiting = new Promise((resolve) => { entered = resolve; });
    f.runner[name] = () => { entered(); return new Promise(() => {}); };
    const params = name === "prepare" ? f.prepare : name === "start" ? { ...f.base, prompt: "Prompt", operationId: name }
      : name === "respond" ? { ...f.base, operationId: name, requestId: "request", response: { choice: "once" } }
        : name === "cancel" ? { ...f.base, operationId: name } : f.base;
    let settled = false;
    const request = f.client.request(method(name), params).finally(() => { settled = true; });
    const rejected = assert.rejects(request, { code: name === "get" ? "APP_HOST_UNAVAILABLE" : "FEDERATION_COMMIT_UNCERTAIN" });
    await waiting;
    t.mock.timers.tick(duration - 1);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await rejected;
  }
});

test("Client independently rejects forged bindings and treats a lost mutation reply as uncertain", async (t) => {
  const paths = fixturePaths(t);
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.federationTokenPath, crypto.randomBytes(32).toString("base64url"), { mode: 0o600 });
  const base = { ...identity(), ...binding(), hostId: crypto.randomUUID() };
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString());
      if (request.method === method("cancel")) { socket.end(); return; }
      socket.end(JSON.stringify({ id: request.id, ok: true,
        result: { hostId: base.hostId, snapshot: { ...snapshot(base), agentId: "another-agent" } } }) + "\n");
    });
  });
  await new Promise((resolve) => server.listen(paths.federationSocketPath, resolve));
  fs.chmodSync(paths.federationSocketPath, 0o600);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new FederationHostClient({ paths });
  await assert.rejects(client.request(method("get"), base), { code: "FEDERATION_RESPONSE_INVALID" });
  await assert.rejects(client.request(method("cancel"), { ...base, operationId: "lost-reply" }),
    { code: "FEDERATION_COMMIT_UNCERTAIN" });
});
