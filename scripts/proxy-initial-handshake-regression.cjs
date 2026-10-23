"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const { WebSocketServer, WebSocket } = require("ws");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { attachChatBroker } = require("../app/core/chat-broker");

(async () => {
  const dormant = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => dormant.once("listening", resolve));
  const upstreamUrl = `ws://127.0.0.1:${dormant.address().port}`;
  const agentId = "shoggoth-handshake-fixture";
  const backend = { id: "shoggoth", getHistory: async key => ({ messages: [{ role: "assistant", content: key }] }) };
  const registry = { aggregateAgents: () => [{ id: agentId, name: "Native" }], aggregateModels: () => [],
    aggregateSessions: () => [], claims: id => id === agentId, route: id => id === agentId ? backend : null };
  const proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => upstreamUrl,
    registry, upstreamHandshakeTimeoutMs: 80, upstreamRetryMs: 10000 });
  const server = http.createServer();
  const broker = attachChatBroker(server, { getUpstreamUrl: () => proxy.url, authResolver: {
    getGatewayUrl: () => upstreamUrl, resolveConnectAuth: () => ({}), getGatewayGeneration: () => null,
  } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/__chatws`);
  let closes = 0;
  client.on("close", () => closes++);
  const requests = new Map(); let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  client.on("message", data => {
    const frame = JSON.parse(data);
    if (frame.event === "gateway.ready") ready(frame.payload);
    if (frame.type === "res") requests.get(frame.id)?.(frame);
  });
  try {
    await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    let deadline;
    const hello = await Promise.race([readyPromise, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Error("initial dormant upstream blocks native chat handshake")), 1200);
    })]).finally(() => clearTimeout(deadline));
    assert.equal(hello.degraded, true);
    for (const session of ["first", "second", "first"]) {
      const id = `read-${session}-${requests.size}`;
      const response = new Promise(resolve => requests.set(id, resolve));
      client.send(JSON.stringify({ type: "req", id, method: "chat.history", params: {
        sessionKey: `agent:${agentId}:${session}`, limit: 100,
      } }));
      const frame = await response;
      assert.equal(frame.ok, true); assert.equal(frame.payload.messages.length, 1);
    }
    assert.equal(closes, 0, "startup and switching retain the same browser connection");
    console.log("PASS cold dormant upstream falls back before broker timeout; native history switches without reconnect");
  } finally {
    client.terminate(); for (const socket of broker.clients) socket.terminate();
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => server.close(resolve)); await proxy.close();
    for (const socket of dormant.clients) socket.terminate(); await new Promise(resolve => dormant.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
