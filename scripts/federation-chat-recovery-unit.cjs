"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { HermesBackend } = require("../app/core/hermes-backend");
const { createFederatedAgentTaskRunner, runFederatedAgentViaBroker } = require("../app/federated-agent-runner");
const { federationRunErrorCode } = require("../app/federation-run-error");

function backend() {
  const be = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  be._installProfileRows([{ name: "bull", model: "deepseek-v4-flash", provider: "deepseek" }]);
  be.dashboards.set("bull", { baseUrl: "http://127.0.0.1:1", token: "fixture-token" });
  be.modelChoices = [{ id: "mimo-v2.6-flash", provider: "xiaomi", acpProviderRef: "custom:xiaomi" }];
  return be;
}

test("new delegated Hermes sessions inherit the saved profile model and named provider, for Gateway and ACP", async () => {
  for (const gateway of [true, false]) {
    const be = backend();
    be._settingsGet = async () => ({ model: "mimo-v2.6-flash", provider: "xiaomi" });
    be._gatewayChatEnabled = () => gateway;
    const requests = [];
    be._gwSocket = () => ({ generation: 1, request: async (method, params) => {
      requests.push({ method, params });
      return { session_id: "runtime", stored_session_id: "stored", info: { lazy: true } };
    } });
    be._clientForProfile = () => ({ newSession: async () => "stored",
      setSessionModel: async (id, model) => requests.push({ id, model }) });
    assert.equal(await be.createSession("hermes-bull"), "agent:hermes-bull:stored");
    if (gateway) assert.deepEqual(requests[0].params, {
      cols: 120, source: "desktop", model: "mimo-v2.6-flash", provider: "custom:xiaomi",
    });
    else assert.deepEqual(requests, [{ id: "stored", model: "custom:xiaomi:mimo-v2.6-flash" }]);
  }
});

test("Hermes discovery reads current per-profile model instead of a stale roster", async () => {
  const be = backend();
  be.getActiveModel = async () => ({ byScope: { "hermes-bull": "mimo-v2.6-flash" },
    providerByScope: { "hermes-bull": "xiaomi" } });
  be._settingsGet = async () => ({ model: "mimo-v2.6-flash", provider: "xiaomi" });
  for (const agent of [await be.getAgent("hermes-bull"), ...(await be.listAgents())]) {
    assert.equal(agent.model, "mimo-v2.6-flash");
    assert.equal(agent.provider, "xiaomi");
  }
});

test("unreadable or retired Hermes defaults cannot silently select the old model", async () => {
  for (const mode of ["unreadable", "empty", "retired"]) {
    const be = backend();
    let created = 0;
    be._settingsGet = async () => {
      if (mode === "unreadable") return null;
      if (mode === "empty") return { model: "", provider: "deepseek" };
      be.dashboards.set("bull", { baseUrl: "http://127.0.0.1:2", token: "new-token" });
      return { model: "mimo-v2.6-flash", provider: "xiaomi" };
    };
    be._gwSocket = () => { created++; throw new Error("must not create"); };
    await assert.rejects(be.createSession("hermes-bull"));
    assert.equal(created, 0);
  }
});

test("federation errors preserve actionable categories without raw provider details", () => {
  const cases = [
    ["HTTP 401: Authentication Fails, api key PRIVATE_CANARY", "AGENT_AUTH_REQUIRED"],
    ["No usable credentials found for provider 'xiaomi'", "AGENT_AUTH_REQUIRED"],
    ["Unknown model: vendor/model PRIVATE_CANARY", "AGENT_MODEL_UNAVAILABLE"],
    ["Error code: 429 private response PRIVATE_CANARY", "AGENT_QUOTA_EXHAUSTED"],
    ["maximum context length exceeded PRIVATE_CANARY", "AGENT_CONTEXT_LIMIT"],
    ["permission denied PRIVATE_CANARY", "AGENT_PERMISSION_DENIED"],
    ["ECONNREFUSED PRIVATE_CANARY", "AGENT_NETWORK_UNAVAILABLE"],
    ["PRIVATE_CANARY unrelated failure", "AGENT_OPERATION_FAILED"],
  ];
  for (const [message, code] of cases) assert.equal(federationRunErrorCode({ message }), code);
  assert.equal(federationRunErrorCode({ code: "PRIVATE_CANARY" }), "AGENT_OPERATION_FAILED");
  assert.equal(federationRunErrorCode({ code: "AUTH_REQUIRED", message: "PRIVATE_CANARY" }), "AGENT_AUTH_REQUIRED");
  assert.equal(federationRunErrorCode({ message: {}, errorMessage: "HTTP 401 PRIVATE_CANARY" }), "AGENT_AUTH_REQUIRED");
});

test("both federation runners classify asynchronous target errors and never replay prompts", async () => {
  const server = http.createServer();
  const ws = new WebSocketServer({ server, path: "/__chatws" });
  let sends = 0;
  let targetError;
  ws.on("connection", socket => socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
      payload: frame.method === "sessions.create" ? { key: "session-target" } : {} }));
    if (frame.method === "chat.send") {
      sends++;
      const emitError = () => socket.send(JSON.stringify({ type: "event", event: "chat", payload: {
        sessionKey: "session-target", state: "error", errorMessage: "HTTP 401 PRIVATE_CANARY",
      } }));
      if (sends === 1) setImmediate(emitError);
      else targetError = emitError;
    }
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runner = createFederatedAgentTaskRunner({ origin });
  try {
    await assert.rejects(runFederatedAgentViaBroker({ origin, agentId: "hermes-bull", prompt: "test", timeoutMs: 5000 }),
      error => error.code === "AGENT_AUTH_REQUIRED" && !error.message.includes("PRIVATE_CANARY"));
    const started = await runner.run({ backendId: "hermes", agentId: "hermes-bull", prompt: "test", timeoutMs: 5000 });
    targetError();
    const query = { backendId: "hermes", agentId: "hermes-bull", taskId: started.taskId };
    const deadline = Date.now() + 1000;
    while (runner.get(query).status === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    const task = runner.get(query);
    assert.equal(task.status, "failed");
    assert.equal(task.errorCode, "AGENT_AUTH_REQUIRED");
    assert.equal(JSON.stringify(task).includes("PRIVATE_CANARY"), false);
    assert.equal(sends, 2);
  } finally {
    await runner.close();
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
