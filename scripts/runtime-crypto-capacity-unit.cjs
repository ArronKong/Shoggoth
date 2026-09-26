#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  McpCryptoBroker, MAX_QUEUED_REQUESTS, MAX_CAPACITY_WAITERS, MAX_BUFFERED_PAYLOAD_BYTES,
} = require("../app/agent-service/mcp-crypto-broker");
const { encodeWorkerResponse } = require("../app/agent-service/mcp-crypto-protocol");
const { McpSessionManager, createMcpChallengeProof } = require("../app/agent-service/mcp-session-manager");
const tick = () => new Promise(resolve => setImmediate(resolve));

function cryptoFixture(options = {}) {
  const requests = [];
  let release;
  const broker = new McpCryptoBroker({
    paths: { trustedRoot: "/tmp/fixture", stateDir: "/tmp/fixture/state",
      mcpAuthPath: "/tmp/fixture/state/mcp-auth.json", profileDir: "/tmp/fixture/profile", cacheDir: "/tmp/fixture/cache" },
    callerRole: "agent-service", executablePath: process.execPath, appRoot: process.cwd(),
    platform: "win32", parentEnv: {}, requestTimeoutMs: 5000,
    termGraceMs: 10, killConfirmMs: 10, ...options,
    spawn() {
      const child = new EventEmitter();
      child.pid = 1234; child.exitCode = null; child.signalCode = null;
      child.stdin = new PassThrough(); child.stdout = new PassThrough();
      const gatePipe = new PassThrough(); child.stdio = [child.stdin, child.stdout, null, gatePipe];
      const chunks = []; const gates = [];
      child.stdin.on("data", chunk => chunks.push(Buffer.from(chunk)));
      gatePipe.on("data", chunk => gates.push(Buffer.from(chunk)));
      child.kill = signal => {
        child.signalCode = signal; child.stdout.end(); child.emit("exit", null, signal); child.emit("close", null, signal); return true;
      };
      child.stdin.on("end", () => {
        const request = Buffer.concat(chunks);
        const newline = request.indexOf(10);
        const body = request.subarray(newline + 1);
        requests.push(body.toString());
        const complete = () => {
          const frame = encodeWorkerResponse({ gate: JSON.parse(Buffer.concat(gates).toString()), payload: Buffer.from(body), ok: true });
          child.stdout.end(frame);
          setImmediate(() => { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); });
        };
        if (requests.length === 1) release = complete;
        else complete();
      });
      return child;
    },
  }).open({ generation: 1 });
  return { broker, requests, release: () => release() };
}
function fill(broker) {
  return Array.from({ length: MAX_QUEUED_REQUESTS }, (_, index) => broker.encrypt(Buffer.from(`queued-${index}`)));
}

test("128 queued requests are serialized; startup waits FIFO and snapshots its input", async () => {
  const f = cryptoFixture();
  const queued = fill(f.broker);
  await assert.rejects(f.broker.encrypt(Buffer.from("ordinary-overflow")), { code: "MCP_CRYPTO_UNAVAILABLE" });
  const input = Buffer.from("startup-snapshot");
  const first = f.broker.encrypt(input, { waitForCapacity: true });
  input.fill(0);
  const second = f.broker.encrypt(Buffer.from("startup-second"), { waitForCapacity: true });
  assert.equal(f.broker.queuedRequests, 128);
  assert.equal(f.broker.capacityWaiters.length, 2);
  await tick(); assert.equal(f.requests.length, 1);
  f.release();
  const results = await Promise.all([...queued, first, second]);
  assert.equal(results.at(-2).toString(), "startup-snapshot");
  assert.deepEqual(f.requests.slice(-2), ["startup-snapshot", "startup-second"]);
  assert.equal(f.broker.queuedRequests, 0);
  assert.equal(f.broker.capacityWaiters.length, 0);
  assert.equal(f.broker.bufferedPayloadBytes, 0);
  await f.broker.close();
});

test("startup capacity wait is bounded, abortable, and close rejects every retained request", async () => {
  const f = cryptoFixture();
  const queued = fill(f.broker).map(value => value.catch(error => error));
  const controller = new AbortController();
  const canceled = f.broker.encrypt(Buffer.from("secret-waiter"), { waitForCapacity: true, signal: controller.signal });
  const canceledCheck = assert.rejects(canceled, error => error.code === "MCP_CRYPTO_CANCELED" && !error.message.includes("secret"));
  controller.abort(); await canceledCheck;
  assert.equal(f.broker.capacityWaiters.length, 0);
  const waits = Array.from({ length: MAX_CAPACITY_WAITERS }, () => f.broker.encrypt(Buffer.from("waiting"), { waitForCapacity: true }).catch(error => error));
  await assert.rejects(f.broker.encrypt(Buffer.from("overflow"), { waitForCapacity: true }), { code: "MCP_CRYPTO_BACKPRESSURE" });
  await tick();
  await f.broker.close();
  const outcomes = await Promise.all([...queued, ...waits]);
  assert.ok(outcomes.every(error => error.code === "MCP_CRYPTO_UNAVAILABLE"));
  assert.equal(f.broker.capacityWaiters.length, 0);
  assert.equal(f.broker.queuedRequests, 0);
  assert.equal(f.broker.bufferedPayloadBytes, 0);
  f.broker.open({ generation: 2 });
  await assert.rejects(f.broker.encrypt(Buffer.from("old-generation"), { generation: 1, waitForCapacity: true }));
  await f.broker.close();
});

test("wait deadline and payload memory budget fail with fixed backpressure without poisoning crypto", async () => {
  const f = cryptoFixture({ capacityWaitTimeoutMs: 10 });
  const queued = fill(f.broker).map(value => value.catch(error => error));
  await assert.rejects(f.broker.encrypt(Buffer.from("private-body"), { waitForCapacity: true }), error => (
    error.code === "MCP_CRYPTO_BACKPRESSURE" && error.message === "mcp_crypto_unavailable"
  ));
  assert.equal(f.broker.generationUnavailable, false);
  await f.broker.close(); await Promise.all(queued);
  const large = cryptoFixture();
  const body = Buffer.alloc(16 * 1024 * 1024, 0x61);
  const pending = Array.from({ length: MAX_BUFFERED_PAYLOAD_BYTES / body.length }, () => large.broker.encrypt(body).catch(error => error));
  await assert.rejects(large.broker.encrypt(Buffer.from("over-budget"), { waitForCapacity: true }), { code: "MCP_CRYPTO_BACKPRESSURE" });
  assert.equal(large.broker.bufferedPayloadBytes, MAX_BUFFERED_PAYLOAD_BYTES);
  await large.broker.close(); await Promise.all(pending);
  assert.equal(large.broker.bufferedPayloadBytes, 0);
});

test("MCP defaults admit 256 simultaneous challenges and 256 separate Profile sessions", () => {
  const secret = Buffer.alloc(32, 9);
  const profiles = Array.from({ length: 257 }, (_, i) => ({ id: `p-${i}`, runtimeProfileId: `r-${i}`, runtimeAccountId: "account", enabled: true }));
  const manager = new McpSessionManager({ handshakeSecret: secret, profileStore: { listAgentProfiles: () => profiles }, protocolVersion: 1 });
  const issue = i => manager.issueChallenge({ protocolVersion: 1, runtimeProfileId: `r-${i}`, runtimeAccountId: "account", clientNonce: Buffer.alloc(32, 2).toString("base64url") });
  const exchange = challenge => {
    const { expiresAt, ...request } = challenge;
    return manager.exchangeChallenge({ ...request, proof: createMcpChallengeProof(secret, challenge) });
  };
  const challenges = Array.from({ length: 256 }, (_, i) => issue(i));
  assert.throws(() => issue(256), { code: "MCP_AUTH_BUSY" });
  const sessions = challenges.map(exchange);
  assert.equal(sessions.length, 256);
  assert.throws(() => exchange(issue(256)), { code: "MCP_AUTH_BUSY" });
  for (const session of sessions) assert.equal(manager.authorizeSession({ token: session.token, runtimeProfileId: session.runtimeProfileId, runtimeAccountId: "account" }).profileId, session.profileId);
  manager.close(); secret.fill(0);
});

test("packaged delegation preserves only fixed capacity/cancellation codes and forwards startup options", async () => {
  const { PackagedMcpCryptoBroker } = require("../app/agent-service/packaged-mcp-crypto-broker");
  const controller = new AbortController();
  let selectedCode = "MCP_CRYPTO_BACKPRESSURE";
  const delegate = { open() {}, close() {}, loadOrCreateForService() {}, readForHelper() {}, decrypt() {},
    encrypt(_payload, options) {
      assert.equal(options.waitForCapacity, true); assert.equal(options.signal, controller.signal);
      throw Object.assign(new Error("private-error-body"), { code: selectedCode });
    } };
  const broker = new PackagedMcpCryptoBroker({
    paths: { trustedRoot: "/tmp/fixture", stateDir: "/tmp/fixture/state", mcpAuthPath: "/tmp/fixture/state/mcp-auth.json",
      profileDir: "/tmp/fixture/profile", cacheDir: "/tmp/fixture/cache" },
    callerRole: "agent-service", executablePath: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth",
    appRoot: "/Applications/Shoggoth.app/Contents/Resources/app.asar", resourcesPath: "/Applications/Shoggoth.app/Contents/Resources",
    applicationsRoot: "/Applications", defaultApp: false, parentEnv: {},
    assertStableAppPaths() {}, readCodeIdentityAsync: async () => ({ teamIdentifier: "fixture", designatedRequirement: "fixture" }),
    createExternalBroker: () => delegate,
  }).open({ generation: 1 });
  for (const code of ["MCP_CRYPTO_BACKPRESSURE", "MCP_CRYPTO_CANCELED", "PRIVATE_CODE"]) {
    selectedCode = code;
    await assert.rejects(broker.encrypt(Buffer.from("private-input"), { waitForCapacity: true, signal: controller.signal }), error => (
      error.code === (code === "PRIVATE_CODE" ? "MCP_CRYPTO_UNAVAILABLE" : code)
      && error.message === "mcp_crypto_unavailable" && !error.stack.includes("private-error-body")
    ));
  }
  await broker.close();
});
