#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const test = require("node:test");
const { WebSocketServer, WebSocket } = require("ws");
const {
  MIN_OPENCLAW_VERSION,
  assertSupportedOpenClawHello,
  sanitizeOpenClawHello,
  hasGatewayMethod,
  hasGatewayEvent,
  hasGatewayScope,
  hasGatewayCapability,
} = require("../app/core/openclaw-2-contract");
const deviceAuth = require("../app/core/device-auth");
const { attachChatBroker } = require("../app/core/chat-broker");

function hello(version = MIN_OPENCLAW_VERSION) {
  return {
    type: "hello-ok",
    protocol: 4,
    server: {
      version,
      buildId: "build-81",
      bootId: "secret-boot-id",
      connId: "secret-connection-id",
    },
    features: {
      methods: ["chat.send", "question.resolve"],
      events: ["question.requested", "progressCard.changed"],
      capabilities: ["questions-v2"],
    },
    snapshot: {
      configPath: "/secret/openclaw.json",
      stateDir: "/secret/state",
      presence: [],
      health: {},
      stateVersion: { presence: 1, health: 1 },
      uptimeMs: 1,
    },
    auth: {
      role: "operator",
      scopes: ["operator.read", "operator.questions"],
      deviceToken: "secret-device-token",
      issuedAtMs: 1,
    },
    policy: {
      maxPayload: 8_000_000,
      maxBufferedBytes: 16_000_000,
      tickIntervalMs: 1_000,
      attachments: { maxBytes: 7_000_000, maxImageBytes: 6_000_000 },
      allowedSessionVisibilities: ["shared", "read-only"],
    },
  };
}

test("OpenClaw 2 contract rejects pre-2026.8.1 and malformed hello responses", () => {
  assert.equal(assertSupportedOpenClawHello(hello("2026.8.1-2")).server.version, "2026.8.1-2");
  assert.throws(
    () => assertSupportedOpenClawHello(hello("2026.8.0")),
    (err) => err?.code === "OPENCLAW_VERSION_UNSUPPORTED"
      && err.currentVersion === "2026.8.0"
      && err.minimumVersion === MIN_OPENCLAW_VERSION,
  );
  assert.throws(
    () => assertSupportedOpenClawHello({ type: "hello-ok", protocol: 4 }),
    (err) => err?.code === "OPENCLAW_HELLO_INVALID",
  );
});

test("sanitized hello exposes negotiation only and powers exact feature checks", () => {
  const safe = sanitizeOpenClawHello(hello());
  assert.deepEqual(safe, {
    protocol: 4,
    server: { version: "2026.8.1", buildId: "build-81" },
    features: {
      methods: ["chat.send", "question.resolve"],
      events: ["question.requested", "progressCard.changed"],
      capabilities: ["questions-v2"],
    },
    auth: { role: "operator", scopes: ["operator.read", "operator.questions"] },
    policy: {
      maxPayload: 8_000_000,
      maxBufferedBytes: 16_000_000,
      attachments: { maxBytes: 7_000_000, maxImageBytes: 6_000_000 },
      allowedSessionVisibilities: ["shared", "read-only"],
    },
  });
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /secret-device-token|secret-boot-id|secret-connection-id|secret\/state/);
  assert.equal(hasGatewayMethod(safe, "question.resolve"), true);
  assert.equal(hasGatewayMethod(safe, "question.waitAnswer"), false);
  assert.equal(hasGatewayEvent(safe, "question.requested"), true);
  assert.equal(hasGatewayScope(safe, "operator.questions"), true);
  assert.equal(hasGatewayCapability(safe, "questions-v2"), true);
});

test("device connect requests question scope and implemented rendering caps", () => {
  const identity = deviceAuth.generateIdentity();
  const params = deviceAuth.buildConnectParams(
    { ...identity, scopes: deviceAuth.DEFAULT_OPERATOR_SCOPES },
    "nonce-81",
  );
  assert.equal(params.scopes.includes("operator.questions"), true);
  assert.deepEqual(params.caps, ["tool-events", "inline-widgets"]);
  assert.deepEqual(deviceAuth.CONNECT_CAPS, ["tool-events", "inline-widgets"]);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeWss(wss) {
  for (const socket of wss.clients) socket.terminate();
  return new Promise((resolve) => wss.close(() => resolve()));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitForFrame(frames, match, label, timeoutMs = 2_000) {
  const existing = frames.find(match);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    let poll;
    const deadline = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    poll = setInterval(() => {
      const frame = frames.find(match);
      if (!frame) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(frame);
    }, 5);
  });
}

async function createBrokerHarness(helloPayload) {
  const upstreamFrames = [];
  const upstreamHttp = createServer();
  const upstreamWss = new WebSocketServer({ server: upstreamHttp });
  upstreamWss.on("connection", (socket) => {
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-81" },
    }));
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      upstreamFrames.push(frame);
      if (frame.method === "connect") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: helloPayload }));
      } else if (frame.method === "sessions.list") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { sessions: [] } }));
      }
    });
  });
  await listen(upstreamHttp);

  const storedTokens = [];
  const identity = deviceAuth.generateIdentity();
  const authResolver = {
    resolveConnectAuth: () => ({
      ...identity,
      token: "secret-shared-token",
      scopes: deviceAuth.DEFAULT_OPERATOR_SCOPES,
    }),
    storeDeviceToken: (...args) => storedTokens.push(args),
  };
  const brokerHttp = createServer();
  const brokerWss = attachChatBroker(brokerHttp, {
    getUpstreamUrl: () => `ws://127.0.0.1:${upstreamHttp.address().port}`,
    getOrigin: () => undefined,
    authResolver,
  });
  await listen(brokerHttp);

  const client = new WebSocket(`ws://127.0.0.1:${brokerHttp.address().port}/__chatws`);
  const clientFrames = [];
  const clientClosed = new Promise((resolve) => {
    client.once("close", (code, reason) => resolve({ code, reason }));
  });
  client.on("message", (data) => clientFrames.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });

  return {
    client,
    clientClosed,
    clientFrames,
    upstreamFrames,
    storedTokens,
    async close() {
      client.terminate();
      await Promise.all([closeWss(brokerWss), closeWss(upstreamWss)]);
      await Promise.all([closeServer(brokerHttp), closeServer(upstreamHttp)]);
    },
  };
}

test("chat broker emits an app-owned sanitized gateway.ready before releasing queued RPCs", async () => {
  const harness = await createBrokerHarness(hello());
  try {
    harness.client.send(JSON.stringify({ type: "req", id: "queued-list", method: "sessions.list", params: {} }));
    const ready = await waitForFrame(
      harness.clientFrames,
      (frame) => frame.type === "event" && frame.event === "gateway.ready",
      "gateway.ready",
    );
    await waitForFrame(
      harness.clientFrames,
      (frame) => frame.type === "res" && frame.id === "queued-list",
      "queued response",
    );
    assert.equal(ready.payload.server.version, "2026.8.1");
    assert.equal(ready.payload.auth.scopes.includes("operator.questions"), true);
    assert.equal(harness.clientFrames.indexOf(ready) < harness.clientFrames.findIndex((f) => f.id === "queued-list"), true);
    assert.doesNotMatch(
      JSON.stringify(harness.clientFrames),
      /secret-device-token|secret-shared-token|secret-connection-id|secret\/openclaw\.json/,
    );
    const connect = harness.upstreamFrames.find((frame) => frame.method === "connect");
    assert.equal(connect.params.scopes.includes("operator.questions"), true);
    assert.deepEqual(connect.params.caps, ["tool-events", "inline-widgets"]);
    assert.deepEqual(harness.storedTokens, [["secret-device-token", 1]]);
  } finally {
    await harness.close();
  }
});

test("chat broker rejects an authenticated pre-2026.8.1 gateway", async () => {
  const harness = await createBrokerHarness(hello("2026.8.0"));
  try {
    const result = await harness.clientClosed;
    assert.equal(result.code, 1011);
    assert.equal(result.reason.toString(), "unsupported OpenClaw version");
    assert.equal(harness.clientFrames.some((frame) => frame.event === "gateway.ready"), false);
    assert.deepEqual(harness.storedTokens, []);
  } finally {
    await harness.close();
  }
});
