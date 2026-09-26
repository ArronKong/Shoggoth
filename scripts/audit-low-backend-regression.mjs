#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { WebSocket, WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const openClawModule = require("../app/core/openclaw-backend.js");
const {
  OpenClawBackend,
  normalizeOpenClawAgentId,
  defaultOpenClawAgentWorkspace,
  OPENCLAW_CREATE_EMOJIS,
} = openClawModule;
const { dirCreatedAtMs, sortAgentsByCreatedAt } = require("../app/core/agent-backend.js");
const { HermesBackend } = require("../app/core/hermes-backend.js");
const proxyModule = require("../app/core/proxy-gateway.js");
const { startProxyGateway } = proxyModule;

let passed = 0;
let failed = 0;

// 注册并运行一个异步断言；单项失败不阻断后续覆盖，便于一次看全 RED/GREEN。
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  \u2717 ${name}`);
    console.error(`    ${error?.stack || error}`);
  }
}

// 构造可手动完成的 Promise，用于稳定复现“旧代际异步结果迟到”的竞态。
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 在限定时间内轮询条件，避免专项测试因永久等待而卡住整个验证流程。
async function waitFor(predicate, label, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时: ${label}`);
}

// 申请一个当前空闲端口，供“先断线、后启动上游”的降级重连场景使用。
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

console.log("\nR116 low backend regression\n");

await test("#7 旧 OpenClaw socket close 不冲掉新连接及其 pending RPC", async () => {
  const sockets = [];
  const requests = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      requests.push({ socket, frame });
      if (frame.method === "connect") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
      }
    });
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "test" } }));
  });

  const port = wss.address().port;
  const backend = new OpenClawBackend({
    getUpstreamUrl: () => `ws://127.0.0.1:${port}`,
    authResolver: {
      resolveConnectAuth: () => ({}),
      clearDeviceToken() {},
      storeDeviceToken() {},
    },
  });
  backend._sendConnect = () => backend.request("connect", {}, 500);

  try {
    await backend._connect();
    const oldSocket = backend._ws;
    backend._ready = false;
    backend._ws = null;
    await backend._connect();
    const newSocket = backend._ws;
    assert.notEqual(newSocket, oldSocket);

    const newConnectCount = () => requests.filter(
      (row) => row.socket === sockets[1] && row.frame.method === "connect",
    ).length;
    assert.equal(newConnectCount(), 1);
    sockets[0].send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "stale" } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(newConnectCount(), 1);

    const pending = backend.request("probe", {}, 1000);
    // 旧实现会立即 reject；先挂失败处理，避免 Node 把预期 RED 当成未处理拒绝中止。
    const pendingOutcome = pending.then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
    const probe = await waitFor(
      () => requests.find((row) => row.socket === sockets[1] && row.frame.method === "probe"),
      "新 socket 收到 probe",
    );
    sockets[0].terminate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(backend._ready, true);
    assert.equal(backend._ws, newSocket);
    assert.equal(backend._pending.has(probe.frame.id), true);
    sockets[1].send(JSON.stringify({ type: "res", id: probe.frame.id, ok: true, payload: { live: true } }));
    assert.deepEqual(await pendingOutcome, { status: "fulfilled", value: { live: true } });
  } finally {
    await backend.stop().catch(() => {});
    await new Promise((resolve) => wss.close(resolve));
  }
});

await test("#8 getCliUsage 冷启动并发首扫单飞", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-cli-usage-"));
  fs.mkdirSync(path.join(home, "agents", "main", "sessions"), { recursive: true });
  const priorHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = home;
  const backend = new OpenClawBackend();
  const gate = deferred();
  let scans = 0;
  backend._scanCliUsage = async () => {
    scans += 1;
    await gate.promise;
    return { supported: true, commands: { git: { main: 1 } } };
  };
  try {
    const first = backend.getCliUsage();
    const second = backend.getCliUsage();
    await waitFor(() => scans >= 1, "首轮 CLI 扫描开始");
    await new Promise((resolve) => setTimeout(resolve, 30));
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(scans, 1);
    assert.deepEqual(a, b);
  } finally {
    if (priorHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test("#8 getCliUsage 首扫失败后清单飞锁并允许重试", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-cli-retry-"));
  fs.mkdirSync(path.join(home, "agents", "main", "sessions"), { recursive: true });
  const priorHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = home;
  const backend = new OpenClawBackend();
  let scans = 0;
  backend._scanCliUsage = async () => {
    scans += 1;
    if (scans === 1) throw new Error("transient scan failure");
    return { supported: true, commands: {} };
  };
  try {
    const firstWave = await Promise.allSettled([backend.getCliUsage(), backend.getCliUsage()]);
    assert.equal(firstWave.every((row) => row.status === "rejected"), true);
    assert.equal(scans, 1);
    assert.deepEqual(await backend.getCliUsage(), { supported: true, commands: {} });
    assert.equal(scans, 2);
  } finally {
    if (priorHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test("#9 archive 从 OPENCLAW_HOME 读取", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-openclaw-home-"));
  const sessionsDir = path.join(home, "agents", "safe-agent", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionKey = "agent:safe-agent:main";
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      [sessionKey]: {
        sessionId: "current-id",
        usageFamilySessionIds: ["prior-id", "current-id"],
      },
    }),
  );
  fs.writeFileSync(
    path.join(sessionsDir, "prior-id.jsonl"),
    `${JSON.stringify({ type: "message", message: { role: "user", content: "archived" } })}\n`,
  );
  const priorHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = home;
  const backend = new OpenClawBackend();
  try {
    const archive = await backend.getSessionArchive("safe-agent", sessionKey);
    assert.equal(archive.segments.length, 1);
    assert.equal(archive.segments[0].messages[0].content, "archived");
  } finally {
    if (priorHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test("#10 archive 拒绝多段、控制字符与穿越 agentId", async () => {
  const backend = new OpenClawBackend();
  for (const id of ["../outside", "a/b", "a\\b", ".", "..", "bad\u0000id", "bad\nid"]) {
    await assert.rejects(() => backend.getSessionArchive(id, "agent:x:main"), /agent id/i);
  }
});

await test("#10 sessions 目录 helper 做解析后 containment", () => {
  assert.equal(typeof openClawModule.resolveOpenClawSessionsDir, "function");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-containment-"));
  const priorHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = home;
  try {
    const resolved = openClawModule.resolveOpenClawSessionsDir("main");
    const root = path.resolve(home, "agents");
    assert.equal(path.relative(root, resolved).startsWith(".."), false);
    assert.equal(resolved, path.join(root, "main", "sessions"));
    assert.throws(() => openClawModule.resolveOpenClawSessionsDir("../outside"), /agent id/i);
  } finally {
    if (priorHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test("#11 self-update gate 接受 IPv6 loopback", () => {
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://[::1]:18792" });
  assert.equal(backend._isLocalGateway(), true);
  assert.equal(backend._selfUpdateGate(), null);
});

await test("#17 Hermes stop 清理跨模式 session/transcript/queue 状态", async () => {
  const backend = new HermesBackend();
  backend.sessionRows = [{ key: "agent:hermes-default:old" }];
  backend.transcripts.set("old", [{ role: "user" }]);
  backend.freshSessionKeys.add("old");
  backend.sendQueues.set("old", Promise.resolve());
  backend.acpSessionByKey.set("old", { profile: "default", acpSessionId: "old" });
  await backend.stop();
  assert.deepEqual(backend.sessionRows, []);
  assert.equal(backend.transcripts.size, 0);
  assert.equal(backend.freshSessionKeys.size, 0);
  assert.equal(backend.sendQueues.size, 0);
  assert.equal(backend.acpSessionByKey.size, 0);
});

await test("#17 stop 后迟到 refreshSessions 不回写旧 sessionRows", async () => {
  const backend = new HermesBackend();
  backend.dashboards.set("default", { profile: "default", spawned: false });
  backend.profileById.set("hermes-default", "default");
  const pendingRows = deferred();
  backend._fetchSessionsForDashboard = async () => pendingRows.promise;
  const refresh = backend.refreshSessions();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await backend.stop();
  pendingRows.resolve([{ key: "agent:hermes-default:stale" }]);
  await refresh;
  assert.deepEqual(backend.sessionRows, []);
});

await test("#17 stop 后迟到 getHistory 不污染新代际 transcripts", async () => {
  const backend = new HermesBackend();
  const pendingHistory = deferred();
  backend._fetchHistoricalMessages = async () => pendingHistory.promise;
  const history = backend.getHistory("agent:hermes-default:old");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await backend.stop();
  pendingHistory.resolve([{ role: "user", content: [{ type: "text", text: "stale" }] }]);
  await assert.rejects(history, /lifecycle|代际|stopped/i);
  assert.equal(backend.transcripts.size, 0);
});

await test("#17 stop 后旧 sendQueue 不进入新代际发送逻辑", async () => {
  const backend = new HermesBackend();
  const key = "agent:hermes-default:queued";
  const queueGate = deferred();
  let sends = 0;
  backend.sendQueues.set(key, queueGate.promise);
  backend._sendMessageInner = async () => {
    sends += 1;
  };
  const queued = backend.sendMessage(key, "old", "run-old");
  await backend.stop();
  queueGate.resolve();
  await assert.rejects(queued, /lifecycle|代际|stopped/i);
  assert.equal(sends, 0);
  assert.equal(backend.sendQueues.size, 0);
});

await test("#18 Hermes agent 写操作在 dashboard 缺失时给出可诊断错误", async () => {
  const backend = new HermesBackend();
  backend.profileById.set("hermes-old", "old");
  await assert.rejects(() => backend.updateAgent("hermes-old", { name: "new" }), /dashboard/i);
  await assert.rejects(() => backend.deleteAgent("hermes-old"), /dashboard/i);
  await assert.rejects(() => backend.getAgentFile("hermes-old"), /dashboard/i);
  await assert.rejects(() => backend.setAgentFile("hermes-old", "SOUL.md", "x"), /dashboard/i);
});

await test("#19 getHistory 不缓存 HTTP 瞬时失败，真实空历史可缓存", async () => {
  let hits = 0;
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      hits += 1;
      const ok = hits > 1;
      const body = hits === 1 ? "temporary" : hits === 3 ? "not-json" : JSON.stringify({ messages: [] });
      socket.end(
        `HTTP/1.1 ${ok ? "200 OK" : "503 Service Unavailable"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const backend = new HermesBackend();
  backend.profileById.set("hermes-default", "default");
  backend.dashboards.set("default", { baseUrl: `http://127.0.0.1:${server.address().port}`, token: null });
  const key = "agent:hermes-default:history-1";
  try {
    await assert.rejects(() => backend.getHistory(key), /503|history/i);
    assert.equal(backend.transcripts.has(key), false);
    assert.deepEqual(await backend.getHistory(key), { messages: [] });
    assert.equal(hits, 2);
    assert.deepEqual(await backend.getHistory(key), { messages: [] });
    assert.equal(hits, 2);
    const badKey = "agent:hermes-default:history-bad-json";
    await assert.rejects(() => backend.getHistory(badKey), /JSON/i);
    assert.equal(backend.transcripts.has(badKey), false);
    assert.deepEqual(await backend.getHistory(badKey), { messages: [] });
    assert.equal(hits, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test("#30 Agent 卡片编号按创建时间排序", () => {
  const sorted = sortAgentsByCreatedAt([
    { id: "new", createdAt: 300 },
    { id: "old", createdAt: 100 },
    { id: "mid", createdAt: 200 },
    { id: "unknown" },
    { id: "tie-b", createdAt: 100 },
  ]);
  assert.deepEqual(sorted.map((agent) => agent.id), ["old", "tie-b", "mid", "new", "unknown"]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agent-created-"));
  try {
    const createdAt = dirCreatedAtMs(tmp);
    assert.equal(typeof createdAt, "number");
    assert.ok(Math.abs(createdAt - Date.now()) < 60_000);
    assert.equal(dirCreatedAtMs("/no/such/agent-dir"), null);
    assert.equal(dirCreatedAtMs(""), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test("#31 OpenClaw createAgent 只传名称时补全 workspace 与 emoji", async () => {
  const previousHome = process.env.OPENCLAW_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-oc-home-"));
  process.env.OPENCLAW_HOME = tmp;
  try {
    assert.equal(normalizeOpenClawAgentId("Travel Planner"), "travel-planner");
    assert.equal(normalizeOpenClawAgentId("NeoBot"), "neobot");
    assert.equal(normalizeOpenClawAgentId("测试"), "ceshi");
    assert.equal(defaultOpenClawAgentWorkspace("NeoBot"), path.join(tmp, "agents", "neobot"));
    assert.equal(defaultOpenClawAgentWorkspace("测试"), path.join(tmp, "agents", "ceshi"));
    assert.equal(defaultOpenClawAgentWorkspace("main"), "");

    const backend = new OpenClawBackend();
    backend._connect = async () => {};
    const calls = [];
    backend.request = async (method, params) => {
      calls.push({ method, params });
      return { ok: true, agentId: params.agentId || normalizeOpenClawAgentId(params.name) };
    };

    await backend.createAgent({ name: "  NeoBot  " });
    assert.equal(calls[0]?.method, "agents.create");
    assert.equal(calls[0]?.params.name, "NeoBot");
    assert.equal(calls[0]?.params.workspace, path.join(tmp, "agents", "neobot"));
    assert.ok(OPENCLAW_CREATE_EMOJIS.includes(calls[0]?.params.emoji));
    assert.equal(calls.length, 1);

    calls.length = 0;
    await backend.createAgent({ name: "测试" });
    assert.equal(calls[0]?.params.name, "ceshi");
    assert.equal(calls[0]?.params.workspace, path.join(tmp, "agents", "ceshi"));
    assert.ok(OPENCLAW_CREATE_EMOJIS.includes(calls[0]?.params.emoji));
    assert.equal(calls[1]?.method, "agents.update");
    assert.equal(calls[1]?.params.agentId, "ceshi");
    assert.equal(calls[1]?.params.name, "测试");
    assert.equal(calls[1]?.params.emoji, calls[0]?.params.emoji);

    calls.length = 0;
    await backend.createAgent({ name: "Ada", workspace: "/custom/ada", emoji: "🧪", model: "xai/grok-4.3" });
    assert.equal(calls[0]?.params.workspace, "/custom/ada");
    assert.equal(calls[0]?.params.emoji, "🧪");
    assert.equal(calls[0]?.params.model, "xai/grok-4.3");
    await assert.rejects(() => backend.createAgent({ name: "   " }), /需要 name/);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test("#28 list request tracker 支持降级答复、上游答复和 close 三路释放", () => {
  assert.equal(typeof proxyModule.createProxyListRequestTracker, "function");
  const tracker = proxyModule.createProxyListRequestTracker();
  tracker.track({ id: "a", method: "agents.list", params: {} });
  tracker.track({ id: "m", method: "models.list", params: {} });
  tracker.track({ id: "s", method: "sessions.list", params: { agentId: "main" } });
  assert.deepEqual(tracker.sizes(), { agents: 1, models: 1, sessions: 1 });
  tracker.forget("a");
  assert.deepEqual(tracker.takeModels("m"), { tracked: true, agentId: undefined });
  assert.deepEqual(tracker.takeSessions("s"), { tracked: true, agentId: "main" });
  assert.deepEqual(tracker.sizes(), { agents: 0, models: 0, sessions: 0 });
  tracker.track({ id: "close-a", method: "agents.list", params: {} });
  tracker.clear();
  assert.deepEqual(tracker.sizes(), { agents: 0, models: 0, sessions: 0 });
});

await test("#27 degraded 重连握手超时后释放旧 socket 并再次重试", async () => {
  const upstreamPort = await reservePort();
  const proxy = await startProxyGateway({
    port: 0,
    getUpstreamUrl: () => `ws://127.0.0.1:${upstreamPort}`,
    upstreamRetryMs: 20,
    upstreamHandshakeTimeoutMs: 60,
  });
  const client = new WebSocket(proxy.url);
  const clientFrames = [];
  client.on("message", (raw) => clientFrames.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  try {
    await waitFor(
      () => clientFrames.find((frame) => frame.type === "event" && frame.event === "connect.challenge"),
      "降级 challenge",
    );
    client.send(JSON.stringify({ type: "req", id: "broker-connect", method: "connect", params: {} }));
    await waitFor(
      () => clientFrames.find((frame) => frame.type === "res" && frame.id === "broker-connect" && frame.ok),
      "降级 connect",
    );

    let connections = 0;
    const upstreamWss = new WebSocketServer({ port: upstreamPort, host: "127.0.0.1" });
    upstreamWss.on("connection", () => {
      connections += 1;
      // 故意不发 challenge，验证 deadline 会关闭本次恢复并安排下一次重试。
    });
    await new Promise((resolve) => upstreamWss.once("listening", resolve));
    try {
      await waitFor(() => connections >= 2, "握手超时后的第二次上游连接", 1000);
    } finally {
      for (const socket of upstreamWss.clients) socket.terminate();
      await new Promise((resolve) => upstreamWss.close(resolve));
    }
  } finally {
    client.terminate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await proxy.close();
  }
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exitCode = 1;
