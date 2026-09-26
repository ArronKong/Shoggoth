#!/usr/bin/env node
"use strict";

import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { createServer as createViteServer } from "../app/manage-ui/node_modules/vite/dist/node/index.js";
import viteConfig from "../app/manage-ui/vite.config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const manageUiRoot = resolve(here, "../app/manage-ui");
const paths = ["/__chatws", "/__kanbanws"];

function listen(server, port = 0) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen(server.address().port);
    });
  });
}

function closeHttp(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

function rejectedUpgrade(url, options) {
  return new Promise((resolveReject, reject) => {
    const ws = new WebSocket(url, options);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`rejection timed out: ${url}`));
    }, 3000);
    const finish = () => {
      clearTimeout(timer);
      resolveReject();
    };
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error(`upgrade unexpectedly succeeded: ${url}`));
    });
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      finish();
    });
    ws.once("error", finish);
  });
}

function acceptedUpgrade(url, origin) {
  return new Promise((resolveAccept, reject) => {
    const ws = new WebSocket(url, { origin });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`upgrade timed out: ${url}`));
    }, 3000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      resolveAccept();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const targetRequests = [];
const targetServer = http.createServer((_req, res) => {
  targetRequests.push({ kind: "http" });
  res.writeHead(404).end();
});
const targetWss = new WebSocketServer({ noServer: true });
targetServer.on("upgrade", (req, socket, head) => {
  targetRequests.push({
    kind: "ws",
    path: new URL(req.url, "http://127.0.0.1").pathname,
    host: req.headers.host,
    origin: req.headers.origin,
  });
  targetWss.handleUpgrade(req, socket, head, (ws) => targetWss.emit("connection", ws, req));
});

let vite;
try {
  const targetPort = await listen(targetServer);
  const target = `http://127.0.0.1:${targetPort}`;
  const configuredProxy = viteConfig.server?.proxy;
  assert.ok(configuredProxy, "vite proxy config must exist");

  const proxy = {};
  for (const path of paths) {
    const options = configuredProxy[path];
    assert.equal(options.target, "http://127.0.0.1:18799", `${path} production target`);
    assert.equal(options.ws, true, `${path} enables websocket proxying`);
    assert.equal(options.rewriteWsOrigin, true, `${path} rewrites the validated origin`);
    proxy[path] = { ...options, target };
  }

  const portProbe = http.createServer();
  const vitePort = await listen(portProbe);
  await closeHttp(portProbe);
  vite = await createViteServer({
    configFile: false,
    root: manageUiRoot,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: vitePort,
      strictPort: true,
      proxy,
    },
  });
  await vite.listen();

  const browserOrigin = `http://127.0.0.1:${vitePort}`;
  for (const path of paths) {
    await acceptedUpgrade(`ws://127.0.0.1:${vitePort}${path}`, browserOrigin);
  }
  assert.deepEqual(
    targetRequests,
    paths.map((path) => ({
      kind: "ws",
      path,
      host: `127.0.0.1:${targetPort}`,
      origin: target,
    })),
    "validated upgrades reach the target with its Host and rewritten Origin",
  );

  const rejected = [
    undefined,
    { origin: "null" },
    { origin: "https://evil.example" },
    { origin: `http://127.0.0.1:${vitePort + 1}` },
    { origin: `http://localhost:${vitePort}` },
    { origin: `https://127.0.0.1:${vitePort}` },
    { origin: `${browserOrigin}/path` },
    { origin: browserOrigin, headers: { Host: `127.0.0.1:${vitePort + 1}` } },
  ];
  for (const path of paths) {
    for (const options of rejected) {
      const before = targetRequests.length;
      await rejectedUpgrade(`ws://127.0.0.1:${vitePort}${path}`, options);
      assert.equal(targetRequests.length, before, `${path} rejected request must not reach target`);
    }
  }

  console.log("vite dev websocket proxy regression: ok");
} finally {
  if (vite) await vite.close();
  for (const client of targetWss.clients) client.terminate();
  targetWss.close();
  if (targetServer.listening) await closeHttp(targetServer);
}
