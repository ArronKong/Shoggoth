#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { startStaticServer } = require("../app/static-server");
const { registerDesktopSecretIpc } = require("../app/desktop-secret-ipc");

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: response.status, body, text };
}

async function testHttpBoundary() {
  const calls = [];
  const backend = {
    async revealModelProviderKey(providerKey) {
      calls.push(["provider", providerKey]);
      return { apiKey: "secret-http-canary" };
    },
    async revealEnvVar(key) {
      calls.push(["env", key]);
      return { value: "secret-env-http-canary" };
    },
  };
  const server = await startStaticServer(0, {
    registry: { backends: new Map([["hermes", backend]]) },
  });
  try {
    const headers = { Origin: server.url, "Content-Type": "application/json" };
    let result = await request(
      server.url,
      "/__api/models/config/reveal?backend=hermes",
      { method: "POST", headers, body: JSON.stringify({ providerKey: "openai" }) },
    );
    assert.equal(result.status, 403);
    assert.equal(result.body?.code, "DESKTOP_BRIDGE_REQUIRED");
    assert.equal(result.text.includes("secret-http-canary"), false);

    result = await request(
      server.url,
      "/__api/env/reveal?backend=hermes",
      { method: "POST", headers, body: JSON.stringify({ key: "OPENAI_API_KEY" }) },
    );
    assert.equal(result.status, 403);
    assert.equal(result.body?.code, "DESKTOP_BRIDGE_REQUIRED");
    assert.equal(result.text.includes("secret-env-http-canary"), false);
    assert.deepEqual(calls, [], "HTTP 管理面不得触发任何明文读取");
  } finally {
    await server.close();
  }
}

async function testTrustedIpcBoundary() {
  const handlers = new Map();
  const removed = [];
  const ipcMain = {
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false);
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      removed.push(channel);
      handlers.delete(channel);
    },
  };
  const webContents = { id: 42, isDestroyed: () => false };
  const mainFrame = { routingId: 7 };
  webContents.mainFrame = mainFrame;
  const window = { isDestroyed: () => false, webContents };
  const calls = [];
  const backend = {
    async revealModelProviderKey(providerKey) {
      calls.push(["provider", providerKey]);
      return {
        apiKey: "secret-ipc-canary",
        baseUrl: "https://api.example.test/v1",
        reason: "env",
        envVar: "OPENAI_API_KEY",
        internalPath: "/private/never-cross",
      };
    },
    async revealEnvVar(key) {
      calls.push(["env", key]);
      return { value: "secret-env-ipc-canary", internal: true };
    },
  };
  const dispose = registerDesktopSecretIpc({
    ipcMain,
    getMainWindow: () => window,
    getRegistry: () => ({ backends: new Map([["hermes", backend]]) }),
  });
  assert.deepEqual([...handlers.keys()].sort(), [
    "shoggoth:secret:reveal-env",
    "shoggoth:secret:reveal-model-provider",
  ]);

  const modelHandler = handlers.get("shoggoth:secret:reveal-model-provider");
  const envHandler = handlers.get("shoggoth:secret:reveal-env");
  const trustedEvent = { sender: webContents, senderFrame: mainFrame };
  const untrustedEvent = { sender: { id: 99 }, senderFrame: {} };

  assert.deepEqual(await modelHandler(untrustedEvent, {
    backend: "hermes", providerKey: "openai",
  }), {
    ok: false,
    error: { code: "PRIVILEGED_RENDERER_REQUIRED", message: "仅桌面应用可读取凭据" },
  });
  assert.deepEqual(calls, []);

  assert.deepEqual(await modelHandler(trustedEvent, {
    backend: "hermes", providerKey: "openai",
  }), {
    ok: true,
    value: {
      apiKey: "secret-ipc-canary",
      baseUrl: "https://api.example.test/v1",
      reason: "env",
      envVar: "OPENAI_API_KEY",
    },
  });
  assert.deepEqual(await envHandler(trustedEvent, {
    backend: "hermes", key: "OPENAI_API_KEY",
  }), { ok: true, value: { value: "secret-env-ipc-canary" } });

  assert.deepEqual(await envHandler(trustedEvent, {
    backend: "../hermes", key: "OPENAI_API_KEY",
  }), {
    ok: false,
    error: { code: "INVALID_SECRET_REQUEST", message: "凭据请求参数无效" },
  });
  assert.deepEqual(await envHandler(trustedEvent, {
    backend: "unknown", key: "OPENAI_API_KEY",
  }), {
    ok: false,
    error: { code: "SECRET_BACKEND_UNAVAILABLE", message: "目标后端不可用" },
  });

  dispose();
  assert.deepEqual(removed.sort(), [
    "shoggoth:secret:reveal-env",
    "shoggoth:secret:reveal-model-provider",
  ]);
  assert.equal(handlers.size, 0);
}

(async () => {
  await testHttpBoundary();
  await testTrustedIpcBoundary();
  console.log("desktop-secret-boundary-unit: all passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
