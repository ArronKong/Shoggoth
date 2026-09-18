"use strict";

const assert = require("node:assert/strict");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

function hello(version = "2026.8.1") {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version, buildId: "build", connId: "must-not-survive" },
    features: {
      methods: ["sessions.search", "question.resolve"],
      events: ["question.requested"],
      capabilities: ["session-scoped-chat-metadata"],
    },
    auth: {
      role: "operator",
      scopes: ["operator.read", "operator.questions"],
      deviceToken: "must-not-survive",
    },
    policy: {
      maxPayload: 1_000_000,
      maxBufferedBytes: 2_000_000,
      attachments: { maxBytes: 30_000_000, maxImageBytes: 7_000_000 },
    },
    snapshot: { configPath: "/secret/path" },
  };
}

{
  const backend = new OpenClawBackend();
  const capabilities = backend.getChatCapabilities("main");
  assert.deepEqual({ ...capabilities, permissions: undefined }, {
    attachments: {
      image: { maxBytes: 6 * 1024 * 1024 },
      pdf: { maxBytes: 20 * 1024 * 1024 },
      file: { maxBytes: 20 * 1024 * 1024 },
    },
    gatewayPolicy: true,
    notReady: true,
    permissions: undefined,
  });
  assert.deepEqual(capabilities.permissions.options.map((option) => option.id), [
    "read-only", "guarded", "workspace", "full",
  ]);
}

{
  const backend = new OpenClawBackend();
  backend._acceptGatewayHello(hello());
  assert.equal(backend.hasGatewayMethod("sessions.search"), true);
  assert.deepEqual({ ...backend.getChatCapabilities("main"), permissions: undefined }, {
    attachments: {
      image: { maxBytes: 7_000_000 },
      pdf: { maxBytes: 30_000_000 },
      file: { maxBytes: 30_000_000 },
    },
    maxPayloadBytes: 1_000_000,
    gatewayPolicy: true,
    permissions: undefined,
  });
  const serialized = JSON.stringify(backend.getGatewayContract());
  assert.equal(serialized.includes("must-not-survive"), false);
  assert.equal(serialized.includes("/secret/path"), false);
}

{
  const backend = new OpenClawBackend();
  assert.throws(
    () => backend._acceptGatewayHello(hello("2026.7.99")),
    (error) => error?.code === "OPENCLAW_VERSION_UNSUPPORTED",
  );
  assert.equal(backend.getGatewayContract(), null);
}

async function testUsageFallsBackWhenLocalTranscriptScanIsEmpty() {
  const backend = new OpenClawBackend();
  backend._isLocalGateway = () => true;
  backend._getUsageCube = async () => ({
    days: new Map(),
    sessions: new Map(),
    agentIds: ["main"],
    truncated: 0,
    scannedFiles: 0,
  });
  backend._connect = async () => {};
  assert.equal(backend._usageRangeParams("today").agentScope, "all");
  const calls = [];
  backend.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "usage.cost") {
      return {
        daily: [{ date: "2026-09-01", totalTokens: 123, input: 100, output: 23 }],
        totals: { totalTokens: 123, input: 100, output: 23 },
        cacheStatus: { status: "fresh" },
      };
    }
    if (method === "sessions.usage") {
      return {
        aggregates: { byModel: [{ model: "gpt-test", count: 1, totals: { totalTokens: 123 } }] },
        sessions: [],
        totals: { totalTokens: 123 },
        cacheStatus: { status: "fresh" },
      };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  assert.equal((await backend.getUsageSeries("30d")).totals.totalTokens, 123);
  assert.equal((await backend.getUsageBreakdown("30d")).totals.totalTokens, 123);
  assert.deepEqual(calls.map(({ method, params }) => ({ method, agentScope: params.agentScope })), [
    { method: "usage.cost", agentScope: "all" },
    { method: "sessions.usage", agentScope: "all" },
  ]);
}

testUsageFallsBackWhenLocalTranscriptScanIsEmpty()
  .then(() => console.log("openclaw 2 backend: PASS"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
