"use strict";

// Fresh-install connection regression: hermetic, no real CLI/gateway mutation.
// Covers OpenClaw plaintext + SecretRef auth discovery, missing-token repair,
// SetupOverlay auto-trigger, and proxy isolation when upstream auth is rejected.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("node:http");
const { WebSocket, WebSocketServer } = require("ws");
const { readLocalGatewayToken } = require("../app/core/device-auth");
const { startOpenclawGateway } = require("../app/openclaw-host");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { BackendRegistry } = require("../app/core/backend-registry");
const { AgentBackend } = require("../app/core/agent-backend");

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${name}: ${error?.stack || error}`);
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeWebSocketServer(wss, server) {
  return new Promise((resolve) => wss.close(() => server.close(resolve)));
}

class NativeBackend extends AgentBackend {
  get id() { return "native-test"; }
  ownsAgentId(agentId) { return agentId === "native-default"; }
  getAgents() { return [{ id: "native-default", name: "Native" }]; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-fresh-connect-"));

(async () => {
  await check("OpenClaw SecretRef 通过官方本机 CLI 解析，短缓存避免重复取密钥", () => {
    const configPath = path.join(tmp, "secret-ref.json");
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: {
        mode: "local",
        auth: { mode: "token", token: { source: "store", provider: "default", id: "GATEWAY_AUTH_TOKEN" } },
      },
    }));
    const fakeToken = "0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow -- synthetic test fixture; not a usable credential
    const calls = [];
    const spawnSyncImpl = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: `${fakeToken}\r\n`, stderr: "" };
    };
    const first = readLocalGatewayToken(configPath, {
      platform: "darwin",
      openclawBin: "/fake/openclaw",
      spawnSyncImpl,
      now: 1000,
    });
    const second = readLocalGatewayToken(configPath, {
      platform: "darwin",
      openclawBin: "/fake/openclaw",
      spawnSyncImpl: () => { throw new Error("cache miss"); },
      now: 1100,
    });
    assert.strictEqual(first, fakeToken);
    assert.strictEqual(second, fakeToken);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].command, "/usr/bin/env");
    assert.strictEqual(calls[0].args[0], "node");
    assert.strictEqual(calls[0].args[1], "-e");
    assert.match(calls[0].args[2], /gateway.*auth-token.*show/);
    assert.strictEqual(calls[0].options.env.OPENCLAW_CONFIG_PATH, configPath);
  });

  await check("密钥解析子进程输出含多个候选值时 fail-closed", () => {
    const configPath = path.join(tmp, "ambiguous-secret-ref.json");
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { auth: { mode: "token", token: { source: "store", id: "TOKEN" } } },
    }));
    const value = readLocalGatewayToken(configPath, {
      platform: "darwin",
      openclawBin: "/fake/openclaw",
      spawnSyncImpl: () => ({
        status: 0,
        stdout: "0123456789abcdef\r\nfedcba9876543210\r\n",
        stderr: "",
      }),
      now: 2000,
    });
    assert.strictEqual(value, undefined);
  });

  const fakeBin = path.join(tmp, "openclaw");
  const commandLog = path.join(tmp, "commands.log");
  fs.writeFileSync(fakeBin, `#!/bin/sh
printf '%s\\n' "$*" >> '${commandLog}'
if [ "$2" = "doctor" ]; then
  node -e 'const fs=require("node:fs");const p=process.env.OPENCLAW_CONFIG_PATH;const c=JSON.parse(fs.readFileSync(p,"utf8"));c.gateway.auth.token="sentinel-secret-must-not-leak";fs.writeFileSync(p,JSON.stringify(c));'
  printf '%s\\n' 'generated gateway token: sentinel-secret-must-not-leak'
fi
exit 0
`);
  fs.chmodSync(fakeBin, 0o755);

  await check("token 模式字段缺失时生成持久 token 后重启，输出不泄漏 token", async () => {
    const configPath = path.join(tmp, "missing-token.json");
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local", auth: { mode: "token" } } }));
    fs.writeFileSync(commandLog, "");
    const result = await startOpenclawGateway({
      mode: "start",
      paths: { binPath: fakeBin, configPath },
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(fs.readFileSync(commandLog, "utf8").trim().split("\n"), [
      "--no-color doctor --generate-gateway-token --non-interactive",
      "--no-color daemon restart",
    ]);
    assert.doesNotMatch(result.output, /sentinel-secret-must-not-leak/);
  });

  await check("已有 SecretRef 时绝不轮换 token", async () => {
    const configPath = path.join(tmp, "existing-secret-ref.json");
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: {
        mode: "local",
        auth: { mode: "token", token: { source: "store", provider: "default", id: "GATEWAY_AUTH_TOKEN" } },
      },
    }));
    fs.writeFileSync(commandLog, "");
    const result = await startOpenclawGateway({
      mode: "start",
      paths: { binPath: fakeBin, configPath },
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(fs.readFileSync(commandLog, "utf8").trim().split("\n"), [
      "--no-color daemon start",
    ]);
  });

  await check("SetupOverlay 仅对本机 token_missing 自动修复一次", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "app", "manage-ui", "src", "components", "SetupOverlay.tsx"),
      "utf8",
    );
    assert.match(source, /autoRepairAttempted\.current/);
    assert.match(source, /oc\.info\.reason !== "token_missing"/);
    assert.match(source, /autoRepairAttempted\.current = true;\s*void runStart\("start"\)/);
  });

  await check("上游首次认证拒绝时 Chat 降级存活并保留原生 Agent", async () => {
    const upstreamHttp = createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamHttp });
    upstreamWss.on("connection", (socket) => {
      socket.send(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "reject-initial" },
      }));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === "req" && frame.method === "connect") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "UNAUTHORIZED", message: "gateway token missing" },
          }));
        }
      });
    });
    await listen(upstreamHttp);

    const registry = new BackendRegistry();
    registry.register(new NativeBackend());
    const proxy = await startProxyGateway({
      port: 0,
      getUpstreamUrl: () => `ws://127.0.0.1:${upstreamHttp.address().port}`,
      registry,
      upstreamRetryMs: 10000,
    });
    const client = new WebSocket(proxy.url);
    const frames = [];
    const waiters = [];
    client.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(frame)) waiters.splice(i, 1)[0].resolve(frame);
      }
    });
    const waitFor = (match, label, timeoutMs = 1500) => {
      const existing = frames.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
        waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      });
    };
    await new Promise((resolve) => client.once("open", resolve));
    try {
      const firstChallenge = await waitFor(
        (frame) => frame.type === "event" && frame.event === "connect.challenge",
        "upstream challenge",
      );
      client.send(JSON.stringify({ type: "req", id: "connect-1", method: "connect", params: {} }));
      await waitFor(
        (frame) => frame !== firstChallenge && frame.type === "event" && frame.event === "connect.challenge",
        "degraded challenge",
      );
      assert.strictEqual(frames.some((frame) => frame.type === "res" && frame.id === "connect-1"), false);
      client.send(JSON.stringify({ type: "req", id: "connect-2", method: "connect", params: {} }));
      const connected = await waitFor(
        (frame) => frame.type === "res" && frame.id === "connect-2",
        "degraded connect",
      );
      assert.strictEqual(connected.ok, true);
      assert.strictEqual(connected.payload?.degraded, true);
      client.send(JSON.stringify({ type: "req", id: "agents", method: "agents.list", params: {} }));
      const agents = await waitFor(
        (frame) => frame.type === "res" && frame.id === "agents",
        "native agents",
      );
      assert.deepStrictEqual(agents.payload?.agents?.map((agent) => agent.id), ["native-default"]);
    } finally {
      client.terminate();
      await proxy.close();
      await closeWebSocketServer(upstreamWss, upstreamHttp);
    }
  });

  process.exit(failed ? 1 : 0);
})();
