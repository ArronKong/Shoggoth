#!/usr/bin/env node
"use strict";

// R116 Task C 基础设施低危回归。
// 测试直接执行生产模块或生产函数源码，覆盖 ACP/HTTP/Electron 配置/upgrade 生命周期。

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { WebSocket, WebSocketServer } = require("ws");

const ROOT = path.resolve(__dirname, "..");
const checks = [];

// 逐项运行并收集失败，RED 时一次展示全部缺口，GREEN 时给出稳定计数。
function check(name, run) {
  checks.push({ name, run });
}

// 从 CommonJS 源码中抽出一个具名函数，测试执行的仍是生产函数本体。
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `未找到生产函数 ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`生产函数 ${name} 大括号不完整`);
}

// 构造可控 ACP 子进程，允许精确触发 spawn error、旧进程 exit 与初始化响应。
function createFakeAcpProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writable: true,
    writes: [],
    write(value) {
      this.writes.push(String(value));
      return true;
    },
  };
  child.kill = () => {};
  return child;
}

check("BackendRegistry 同步/异步 getter 失败保持逐后端 fail-soft", async () => {
  const { BackendRegistry } = require(path.join(ROOT, "app/core/backend-registry.js"));
  const { AgentBackend } = require(path.join(ROOT, "app/core/agent-backend.js"));

  class SyncBadBackend extends AgentBackend {
    get id() { return "sync-bad"; }
    ownsAgentId() { throw new Error("sync owns failure"); }
    getAgents() { throw new Error("sync agents failure"); }
    getModelChoices() { throw new Error("sync models failure"); }
  }
  class AsyncBadBackend extends AgentBackend {
    get id() { return "async-bad"; }
    ownsAgentId() { return Promise.reject(new Error("async owns failure")); }
    getAgents() { return Promise.reject(new Error("async agents failure")); }
    getModelChoices() { return Promise.reject(new Error("async models failure")); }
  }
  class HealthyBackend extends AgentBackend {
    get id() { return "healthy"; }
    ownsAgentId(agentId) { return agentId === "healthy-agent"; }
    getAgents() { return [{ id: "healthy-agent", name: "Healthy" }]; }
    getModelChoices() { return [{ id: "healthy-model", name: "Healthy", provider: "test" }]; }
  }

  const registry = new BackendRegistry();
  registry.register(new SyncBadBackend());
  registry.register(new AsyncBadBackend());
  const healthy = new HealthyBackend();
  registry.register(healthy);

  assert.equal(registry.route("healthy-agent"), healthy, "坏 backend 的 ownsAgentId 不得阻断健康路由");
  assert.deepEqual(registry.aggregateAgents(), [{ id: "healthy-agent", name: "Healthy" }]);
  assert.deepEqual(registry.aggregateModels(), [{ id: "healthy-model", name: "Healthy", provider: "test" }]);
  // 让 production 给意外 thenable 挂上的 rejection handler 有机会执行；不得产生
  // unhandledRejection，也不能把异步返回误当作同步 truthy ownership。
  await new Promise((resolve) => setImmediate(resolve));
});

check("#31 spawn error/exit exactly-once 终止并允许安全重启", async () => {
  const source = fs.readFileSync(path.join(ROOT, "app/core/acp-client.js"), "utf8");
  const children = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require(id) {
      if (id === "node:child_process") {
        return {
          spawn() {
            const child = createFakeAcpProcess();
            children.push(child);
            return child;
          },
        };
      }
      return require(id);
    },
    Buffer,
    console,
    // AcpClient 的初始化 deadline 使用标准定时器；VM mock 必须提供同一运行时能力。
    setTimeout,
    clearTimeout,
  }, { filename: "app/core/acp-client.js" });

  const { AcpClient } = module.exports;
  const exitEvents = [];
  const client = new AcpClient({ onExit: (code) => exitEvents.push(code) });
  const firstStart = client.start();
  const first = children[0];
  first.emit("error", new Error("spawn ENOENT"));
  await assert.rejects(firstStart, /spawn ENOENT/);
  assert.equal(client.proc, null, "spawn error 后 proc 必须复位");
  assert.equal(client.initPromise, null, "spawn error 后 initPromise 必须复位");
  assert.equal(client.pending.size, 0, "spawn error 后 pending 必须全部拒绝并清空");
  assert.equal(exitEvents.length, 1, "spawn error 必须触发一次 onExit 供 Hermes 清理 session 映射");

  first.emit("exit", 1);
  assert.equal(exitEvents.length, 1, "同一旧进程 error 后的 exit 不得重复触发 onExit");

  const secondStart = client.start();
  assert.equal(children.length, 2, "下一次 start 必须重新 spawn");
  const second = children[1];
  first.emit("error", new Error("late old error"));
  first.emit("exit", 2);
  assert.equal(client.proc, second, "旧进程迟到 error/exit 不得清掉新进程");
  assert.equal(exitEvents.length, 1, "旧进程迟到事件不得触发新一轮终止回调");
  const initialize = JSON.parse(second.stdin.writes[0]);
  second.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: initialize.id, result: { agentCapabilities: {} } })}\n`));
  await secondStart;
  assert.equal(client.pending.size, 0, "新进程 initialize 完成后不得遗留 pending");
  second.emit("exit", 0);
  assert.equal(exitEvents.length, 2, "新进程 exit 必须独立触发一次 onExit");
  assert.equal(client.proc, null);
  assert.equal(client.initPromise, null);
  assert.equal(client.pending.size, 0);
});

check("#32 JSON body 按 UTF-8 字节限流且溢出 Promise 有界结算", async () => {
  const source = fs.readFileSync(path.join(ROOT, "app/static-server.js"), "utf8");
  const readJsonBodySource = extractFunction(source, "readJsonBody");
  // 生产函数依赖模块级常量；测试沙箱显式注入同值，确保验证的仍是生产实现。
  const context = {
    EventEmitter,
    Buffer,
    setTimeout,
    clearTimeout,
    MAX_JSON_BODY_BYTES: 1024 * 1024,
    result: null,
  };
  vm.runInNewContext(`${readJsonBodySource}\nresult = readJsonBody;`, context);

  const req = new EventEmitter();
  req.destroyCount = 0;
  req.resumeCount = 0;
  req.destroy = function destroy() { this.destroyCount += 1; };
  req.resume = function resume() { this.resumeCount += 1; };
  let rejectionCount = 0;
  const bodyPromise = context.result(req).catch((error) => {
    rejectionCount += 1;
    throw error;
  });
  // 字符数小于旧阈值，但 UTF-8 字节数超过 1 MiB。
  req.emit("data", Buffer.from("你".repeat(349_526)));
  const outcome = await Promise.race([
    bodyPromise.then(
      (value) => ({ kind: "resolved", value }),
      (error) => ({ kind: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 80)),
  ]);
  assert.equal(outcome.kind, "rejected", "溢出必须立即 reject，不能等待永远不会来的 end");
  assert.match(String(outcome.error?.message || outcome.error), /too large|过大/i);
  assert.equal(req.destroyCount, 0, "溢出不能销毁承载 413 响应的 socket");
  assert.equal(req.resumeCount, 1, "溢出后必须切换为排空剩余请求体");

  // 结算后即使还有大块 data 及多个终止事件，也不能继续缓存或重复结算。
  req.emit("data", Buffer.alloc(2 * 1024 * 1024));
  req.emit("end");
  req.emit("error", new Error("late stream error"));
  req.emit("close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejectionCount, 1, "溢出 Promise 只能结算一次");
});

// 对真实 REST 路由发送超限 body，验证 413 能穿过 HTTP socket 返回客户端。
check("#32 真实 HTTP PUT 超限请求在有界时间返回 413", async () => {
  const { startStaticServer } = require(path.join(ROOT, "app/static-server.js"));
  let writes = 0;
  const registry = { backends: new Map() };
  const configStore = {
    read: () => ({ gatewayUrl: "ws://127.0.0.1:18792" }),
    write(value) { writes += 1; return value; },
  };
  const server = await startStaticServer(0, { registry, configStore });
  const payload = Buffer.alloc((1024 * 1024) + 100, 0x61);
  try {
    const requestResult = new Promise((resolve) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        resolve(value);
      };
      const req = http.request({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/__api/config",
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Connection: "close",
        },
      }, (res) => {
        res.resume();
        res.once("end", () => finish({ kind: "response", status: res.statusCode }));
      });
      req.once("error", (error) => finish({ kind: "error", error }));
      req.end(payload);
    });
    const outcome = await Promise.race([
      requestResult,
      new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 1500)),
    ]);
    assert.deepEqual(outcome, { kind: "response", status: 413 });
    assert.equal(writes, 0, "超限配置不得进入 configStore.write");
  } finally {
    await server.close();
  }
});

check("#33 原生菜单更新 locale 后同步 appliedConfig 快照", () => {
  const source = fs.readFileSync(path.join(ROOT, "app/ui-entry.js"), "utf8");
  const fn = extractFunction(source, "setLocaleAndApply");
  const context = {
    SUPPORTED_LOCALES: new Set(["", "zh-CN", "en"]),
    stored: { gatewayUrl: "ws://one", locale: "zh-CN" },
    appliedConfig: { gatewayUrl: "ws://one", locale: "zh-CN" },
    menuBuilds: 0,
    reloads: 0,
  };
  vm.runInNewContext(`
    let appliedConfig = globalThis.appliedConfig;
    const SUPPORTED_LOCALES = globalThis.SUPPORTED_LOCALES;
    const readConfig = () => globalThis.stored;
    const writeConfig = (next) => { globalThis.stored = { ...next }; return globalThis.stored; };
    const buildMenu = () => { globalThis.menuBuilds += 1; };
    const mainWindow = { webContents: { reload: () => { globalThis.reloads += 1; } } };
    ${fn}
    setLocaleAndApply("en");
    globalThis.result = { appliedConfig, stored: globalThis.stored };
  `, context);
  assert.equal(context.result.stored.locale, "en");
  assert.equal(context.result.appliedConfig.locale, "en", "appliedConfig 必须与刚写入的 locale 同步");
});

check("#35 remote profile 按最终 Hermes agent identity 保留首个合法项", () => {
  const { sanitizeRemotes } = require(path.join(ROOT, "app/core/config-store.js"));
  const rows = sanitizeRemotes([
    { profile: "Alpha Team", baseUrl: "" },
    { profile: "Alpha Team", baseUrl: "http://alpha-first/", token: "one" },
    { profile: "alpha-team", baseUrl: "http://alpha-hyphen", token: "two" },
    { profile: " ALPHA TEAM ", baseUrl: "http://alpha-space", token: "three" },
    { profile: "Alpha.Team", baseUrl: "http://alpha-punctuation", token: "four" },
    { profile: "Beta@Team", baseUrl: "http://beta-first", token: "five" },
    { profile: "beta team", baseUrl: "http://beta-second", token: "six" },
    { profile: "---", baseUrl: "http://default-first", token: "seven" },
    { profile: "!!!", baseUrl: "http://default-punctuation", token: "eight" },
    { profile: "", baseUrl: "http://default-empty", token: "nine" },
  ]);
  assert.deepEqual(rows, [
    { profile: "Alpha Team", baseUrl: "http://alpha-first", token: "one" },
    { profile: "Beta@Team", baseUrl: "http://beta-first", token: "five" },
    { profile: "---", baseUrl: "http://default-first", token: "seven" },
  ]);
});

check("#35 config remote identity 与 Hermes agentIdForProfile 完全一致", () => {
  const { remoteProfileIdentity } = require(path.join(ROOT, "app/core/config-store.js"));
  const { agentIdForProfile } = require(path.join(ROOT, "app/core/hermes-backend.js"));
  assert.equal(typeof remoteProfileIdentity, "function");
  for (const profile of [
    "Alpha Team",
    "alpha-team",
    " ALPHA TEAM ",
    "Alpha.Team",
    "alpha_team",
    "---",
    "!!!",
    "",
  ]) {
    assert.equal(remoteProfileIdentity(profile), agentIdForProfile(profile), `profile=${JSON.stringify(profile)}`);
  }
});

check("#36 manage-serve 实时配置与 model recovery 启动顺序", async () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts/manage-serve.cjs"), "utf8");
  let config = { gatewayUrl: "ws://127.0.0.1:19991", disabledBackends: [] };
  let proxyOptions = null;
  let staticOptions = null;
  let coordinatorOptions = null;
  let runtimeOptions = null;
  let modelChangeOptions = null;
  let hermesModelChangeOptions = null;
  const lifecycle = [];
  const sharedGate = { enter() {}, beginDrain() {} };
  const hostController = { topology: "local", capabilities: {} };
  const runtimeApply = { inspect() {}, acquireForApply() {}, invalidateConnectionGeneration() {} };
  const modelChangeAdapter = { getCapabilities() {}, preview() {}, apply() {}, recover() {} };
  const hermesMutationGate = { withProfiles() {}, withCoordinatorContext() {} };
  const hermesModelChangeAdapter = { getCapabilities() {}, preview() {}, apply() {}, recover() {} };
  const store = { ensure() {}, read: () => config };
  class HermesBackend {
    constructor(options) { this.options = options; }
    get id() { return "hermes"; }
    attachModelChangeAdapter(value) { this.modelChangeAdapter = value; }
    async start() { lifecycle.push("hermes.start"); return true; }
    stop() {}
  }
  class OpenClawBackend {
    get id() { return "openclaw"; }
    attachModelRuntimeApply(value) { this.runtimeApply = value; }
    attachModelChangeAdapter(value) { this.modelChangeAdapter = value; }
    async start() { lifecycle.push("openclaw.start"); return true; }
  }
  class BackendRegistry {
    constructor() { this.backends = new Map(); }
    register(backend) { this.backends.set(backend.id, backend); }
    setDisabledBackendsProvider() {}
    attachDashboardJournal() {}
    async start() {
      lifecycle.push("registry.start");
      for (const backend of this.backends.values()) await backend.start();
      return new Map();
    }
    startDashboardHealthSampler() { lifecycle.push("health.start"); }
  }
  class ModelChangeCoordinator {
    constructor(options) {
      coordinatorOptions = options;
      this.ready = false;
    }
    async recoverPending() { lifecycle.push("coordinator.recoverPending"); }
    markReady() { this.ready = true; lifecycle.push("coordinator.markReady"); }
    isReady() { return this.ready; }
  }
  const processStub = {
    env: { MANAGE_SERVE_PORT: "0", MANAGE_PROXY_PORT: "0" },
    on() {},
    exit() {},
  };
  const context = {
    module: { exports: {} },
    exports: {},
    __dirname: path.join(ROOT, "scripts"),
    process: processStub,
    console: { log() {}, error() {} },
    require(id) {
      if (id === "node:os") return os;
      if (id === "node:path") return path;
      if (id === "../app/core/hermes-backend") return { HermesBackend };
      if (id === "../app/core/openclaw-backend") return { OpenClawBackend };
      if (id === "../app/core/backend-registry") return { BackendRegistry };
      if (id === "../app/core/proxy-gateway") return { startProxyGateway: async (opts) => { proxyOptions = opts; return { close: async () => {} }; } };
      if (id === "../app/static-server") return { startStaticServer: async (_port, opts) => {
        staticOptions = opts;
        lifecycle.push("static.start");
        return { url: "http://127.0.0.1:1", close: async () => {} };
      } };
      if (id === "../app/core/config-store") return { createConfigStore: () => store };
      if (id === "../app/core/dashboard-journal") return { createDashboardJournal: () => ({}) };
      if (id === "../app/core/model-change-journal") return { createModelChangeJournal: (filePath) => ({ filePath }) };
      if (id === "../app/core/model-change-coordinator") return { ModelChangeCoordinator };
      if (id === "../app/core/work-admission-gate") return { createWorkAdmissionGate: () => sharedGate };
      if (id === "../app/openclaw-host") return { createOpenclawHostController: () => hostController };
      if (id === "../app/core/openclaw-runtime-apply") return { createOpenClawRuntimeApply: (options) => {
        runtimeOptions = options;
        return runtimeApply;
      } };
      if (id === "../app/core/openclaw-model-change") return { createOpenClawModelChange: (options) => {
        modelChangeOptions = options;
        return modelChangeAdapter;
      } };
      if (id === "../app/core/hermes-model-mutation") return { createHermesModelMutationGate: () => hermesMutationGate };
      if (id === "../app/core/hermes-model-change") return { createHermesModelChange: (options) => {
        hermesModelChangeOptions = options;
        return hermesModelChangeAdapter;
      } };
      if (id === "../app/core/device-auth") return { createAuthResolver: () => ({}) };
      return require(id);
    },
  };
  vm.runInNewContext(source, context, { filename: "scripts/manage-serve.cjs" });
  for (let i = 0; i < 20 && !lifecycle.includes("coordinator.markReady"); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(proxyOptions, "dev harness 必须启动 proxy");
  assert.equal(proxyOptions.getUpstreamUrl(), "ws://127.0.0.1:19991");
  config = { gatewayUrl: "ws://127.0.0.1:19992", disabledBackends: [] };
  assert.equal(proxyOptions.getUpstreamUrl(), "ws://127.0.0.1:19992", "getter 必须读取最新 configStore");
  assert.ok(coordinatorOptions?.journal?.filePath.endsWith(".shoggoth-dev-model-change-journal.json"));
  assert.equal(staticOptions?.modelChangeCoordinator instanceof ModelChangeCoordinator, true);
  assert.equal(runtimeOptions?.admissionGate, sharedGate, "runtime 必须使用组合根单例 gate");
  assert.equal(runtimeOptions?.supervisor, hostController, "runtime 必须使用显式 host controller");
  assert.equal(modelChangeOptions?.runtimeApply, runtimeApply, "model-change 必须复用已注入的 runtime");
  assert.equal(modelChangeOptions?.backend?.modelChangeAdapter, modelChangeAdapter, "model-change 必须注入同一 backend");
  assert.equal(hermesModelChangeOptions?.mutationGate, hermesMutationGate, "Hermes adapter 必须复用组合根 mutation gate");
  assert.equal(hermesModelChangeOptions?.backend?.modelChangeAdapter, hermesModelChangeAdapter, "Hermes adapter 必须注入同一 backend");
  assert.equal(proxyOptions?.workAdmissionGate, sharedGate, "proxy 必须共享同一 gate");
  assert.equal(staticOptions?.workAdmissionGate, sharedGate, "REST 必须共享同一 gate");
  assert.equal(coordinatorOptions?.workAdmissionGate, sharedGate, "coordinator 必须共享同一 gate");
  const ordered = ["static.start", "registry.start", "coordinator.recoverPending", "coordinator.markReady", "health.start"];
  assert.deepEqual(
    lifecycle.filter((event) => ordered.includes(event)),
    ordered,
    "只读 server 必须先启动，backend ready 后才恢复并开放 mutation，最后启动健康采样",
  );
});

// 发起真实 HTTP 请求并收集 JSON，验证路径边界在 REST 层表现为 400。
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* 非 JSON 由断言报告 */ }
        resolve({ status: res.statusCode, body });
      });
    }).on("error", reject);
  });
}

// 发送一个未知 WebSocket upgrade，并判断服务端是否在 deadline 内主动断开。
async function unknownUpgradeClosed(port, pathname) {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise((resolve) => {
    socket.once("close", () => resolve(true));
    socket.once("end", () => resolve(true));
  });
  socket.write([
    `GET ${pathname} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", // gitleaks:allow -- synthetic test fixture; not a usable credential
    "",
    "",
  ].join("\r\n"));
  const result = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 120))]);
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return result;
}

check("#37/#38 双 broker 后统一销毁未知 upgrade，已知 kanban 路径仍由 handler 接管", async () => {
  const { startStaticServer } = require(path.join(ROOT, "app/static-server.js"));
  const registry = {
    backends: new Map(),
    getSessionArchive: async () => ({ supported: true, segments: [] }),
    searchChat: async () => ({ supported: true, results: [] }),
  };
  const server = await startStaticServer(0, {
    registry,
    chatUpstreamUrl: "ws://127.0.0.1:9",
    authResolver: {},
  });
  let chatUnknownClosed = false;
  let kanbanUnknownClosed = false;
  let knownOpened = false;
  try {
    chatUnknownClosed = await unknownUpgradeClosed(server.port, "/__chatws-unknown");
    kanbanUnknownClosed = await unknownUpgradeClosed(server.port, "/__kanbanws-unknown");
    const known = new WebSocket(`ws://127.0.0.1:${server.port}/__kanbanws`, {
      origin: server.url,
    });
    knownOpened = await new Promise((resolve) => {
      let didOpen = false;
      known.once("open", () => { didOpen = true; });
      known.once("close", () => resolve(didOpen));
      known.once("error", () => resolve(didOpen));
      setTimeout(() => resolve(didOpen), 300);
    });
    known.terminate();
  } finally {
    // RED 旧实现会把未知 upgrade 留成不受 http.Server 管理的悬空 socket，
    // 不等待 close 回调，避免测试本身被同一个缺陷挂死。
    void server.close();
  }
  assert.equal(chatUnknownClosed, true);
  assert.equal(kanbanUnknownClosed, true);
  assert.equal(knownOpened, true, "统一兜底不得抢先销毁已知 kanban upgrade");
});

check("static server 持有活跃 chat/kanban WebSocket 时仍有界关闭", async () => {
  const { startStaticServer } = require(path.join(ROOT, "app/static-server.js"));
  const upstreamHttp = http.createServer();
  const upstreamWss = new WebSocketServer({ server: upstreamHttp });
  const upstreamSockets = new Set();
  upstreamWss.on("connection", (socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
  });
  await new Promise((resolve) => upstreamHttp.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `ws://127.0.0.1:${upstreamHttp.address().port}`;
  const registry = {
    backends: new Map(),
    getBackend(id) {
      return id === "hermes" ? { getKanbanEventsTarget: () => ({ wsUrl: upstreamUrl }) } : null;
    },
  };
  const server = await startStaticServer(0, {
    registry,
    chatUpstreamUrl: upstreamUrl,
    authResolver: { resolveConnectAuth: () => ({}) },
  });
  const origin = { headers: { Origin: server.url } };
  const chat = new WebSocket(`${server.url.replace("http:", "ws:")}/__chatws`, origin);
  const kanban = new WebSocket(`${server.url.replace("http:", "ws:")}/__kanbanws`, origin);
  const opened = (socket) => new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let closing;
  try {
    await Promise.all([opened(chat), opened(kanban)]);
    const deadline = Date.now() + 500;
    while (upstreamSockets.size < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(upstreamSockets.size, 2, "两个 broker 都应持有活跃 upstream");

    closing = server.close();
    const closedInTime = await Promise.race([
      closing.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    if (!closedInTime) {
      // Keep the RED regression bounded on the old implementation.
      chat.terminate();
      kanban.terminate();
      for (const socket of upstreamSockets) socket.terminate();
      await closing;
    }
    assert.equal(closedInTime, true, "active WS 不得让 static server.close 永久等待");
    assert.equal(server.close(), closing, "重复 close 必须复用同一个 shutdown Promise");
    const clientCloseDeadline = Date.now() + 150;
    while ((chat.readyState !== WebSocket.CLOSED || kanban.readyState !== WebSocket.CLOSED)
      && Date.now() < clientCloseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(chat.readyState, WebSocket.CLOSED);
    assert.equal(kanban.readyState, WebSocket.CLOSED);
    const upstreamCloseDeadline = Date.now() + 150;
    while (upstreamSockets.size > 0 && Date.now() < upstreamCloseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(upstreamSockets.size, 0, "static server.close 必须释放两个 broker 的 upstream");
  } finally {
    if (!closing) {
      try { chat.terminate(); } catch { /* ignore */ }
      try { kanban.terminate(); } catch { /* ignore */ }
      await server.close();
    }
    for (const socket of upstreamSockets) socket.terminate();
    await new Promise((resolve) => upstreamWss.close(() => upstreamHttp.close(resolve)));
  }
});

check("Task B #10 非法 agent id 与路径边界错误在 REST 层映射 400", async () => {
  const { startStaticServer } = require(path.join(ROOT, "app/static-server.js"));
  let archiveCalls = 0;
  const registry = {
    backends: new Map(),
    async getSessionArchive(_backend, agentId) {
      archiveCalls += 1;
      if (agentId === "boundary") {
        // Task B 当前真实 helper 抛普通 Error；REST 层仍必须保留 400 语义。
        throw new Error("openclaw: invalid agent id containment");
      }
      return { supported: true, segments: [] };
    },
    async searchChat() { return { supported: true, results: [] }; },
  };
  const server = await startStaticServer(0, { registry });
  try {
    const traversal = new URL("/__api/sessions/archive", server.url);
    traversal.searchParams.set("backend", "openclaw");
    traversal.searchParams.set("agentId", "../victim");
    traversal.searchParams.set("key", "agent:victim:main");
    const invalid = await getJson(traversal);
    assert.equal(invalid.status, 400);
    assert.equal(archiveCalls, 0, "明显非法 id 不应进入 registry");

    const control = new URL("/__api/sessions/archive", server.url);
    control.searchParams.set("backend", "openclaw");
    control.searchParams.set("agentId", "victim\u0001");
    control.searchParams.set("key", "agent:victim:main");
    const invalidControl = await getJson(control);
    assert.equal(invalidControl.status, 400);
    assert.equal(archiveCalls, 0, "控制字符 id 不应进入 registry");

    const boundary = new URL("/__api/sessions/archive", server.url);
    boundary.searchParams.set("backend", "openclaw");
    boundary.searchParams.set("agentId", "boundary");
    boundary.searchParams.set("key", "agent:boundary:main");
    const mapped = await getJson(boundary);
    assert.equal(mapped.status, 400, "后端 containment 错误必须保持客户端 400 语义");
  } finally {
    await server.close();
  }
});

async function main() {
  let passed = 0;
  const selected = process.env.AUDIT_CASE
    ? checks.filter((item) => item.name.includes(process.env.AUDIT_CASE))
    : checks;
  for (const item of selected) {
    try {
      await item.run();
      passed += 1;
      console.log(`ok - ${item.name}`);
    } catch (error) {
      console.error(`not ok - ${item.name}`);
      console.error(error?.stack || error);
    }
  }
  console.log(`${passed}/${selected.length} infrastructure regression checks passed`);
  if (passed !== selected.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
