#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { WebSocket, WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const { attachKanbanBroker } = require("../app/core/kanban-broker");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function expectRejected(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for rejected upgrade"));
    }, 2_000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error("unexpectedly accepted upgrade"));
    });
    ws.once("error", () => {});
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const upstreamHttp = http.createServer();
const upstreamWss = new WebSocketServer({ server: upstreamHttp });
let upstreamConnections = 0;
upstreamWss.on("connection", (socket) => {
  upstreamConnections += 1;
  socket.on("error", () => {});
});

const upstreamPort = await listen(upstreamHttp);
const brokerHttp = http.createServer();
const brokerWss = attachKanbanBroker(brokerHttp, {
  registry: {
    getBackend() {
      return {
        getKanbanEventsTarget() {
          return { wsUrl: `ws://127.0.0.1:${upstreamPort}/events`, token: "secret" };
        },
      };
    },
  },
});
const brokerPort = await listen(brokerHttp);
const brokerUrl = `ws://127.0.0.1:${brokerPort}/__kanbanws`;

try {
  await expectRejected(brokerUrl, { origin: "https://evil.example" });
  assert.equal(upstreamConnections, 0, "evil Origin must not reach the privileged upstream");

  await expectRejected(brokerUrl);
  assert.equal(upstreamConnections, 0, "missing Origin must not reach the privileged upstream");

  const upstreamConnected = new Promise((resolve) => upstreamWss.once("connection", resolve));
  const browser = new WebSocket(brokerUrl, {
    origin: `http://127.0.0.1:${brokerPort}`,
  });
  browser.on("error", () => {});
  await upstreamConnected;
  assert.equal(upstreamConnections, 1, "exact loopback Origin should reach the upstream");
  browser.terminate();

  console.log("kanban-origin-regression: all passed");
} finally {
  for (const socket of brokerWss.clients) socket.terminate();
  for (const socket of upstreamWss.clients) socket.terminate();
  await Promise.all([
    new Promise((resolve) => brokerWss.close(resolve)),
    new Promise((resolve) => upstreamWss.close(resolve)),
  ]);
  await Promise.all([closeServer(brokerHttp), closeServer(upstreamHttp)]);
}
