import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BackendRegistry } = require("../app/core/backend-registry.js");
const { startStaticServer } = require("../app/static-server.js");
const { createConfigStore } = require("../app/core/config-store.js");
const { ShoggothBackend } = require("../app/core/shoggoth-backend.js");
const { OpenClawBackend } = require("../app/core/openclaw-backend.js");
const { HermesBackend } = require("../app/core/hermes-backend.js");

function requestJson(baseUrl, method, pathname, body) {
  const target = new URL(pathname, baseUrl);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(target, {
      method,
      headers: payload ? {
        "content-type": "application/json",
        "content-length": payload.length,
      } : undefined,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* status is enough */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload) req.end(payload); else req.end();
  });
}

const calls = {
  agent: 0,
  cron: 0,
  model: 0,
  task: 0,
  taskOptions: null,
  test: 0,
  discoveryRead: 0,
  discoveryWrite: 0,
  update: 0,
};
const backend = {
  id: "blocked",
  name: "Blocked",
  getAgents: () => [],
  ownsAgentId: (id) => id.startsWith("blocked-"),
  claimsAgentId: (id) => id.startsWith("blocked-"),
  createAgent: async () => { calls.agent++; return { id: "blocked-a" }; },
  createCronJob: async () => { calls.cron++; return { id: "blocked-job" }; },
  getActiveModel: async () => { calls.model++; return { modelId: "stub" }; },
  createTask: async (_spec, options) => {
    calls.task++;
    calls.taskOptions = options;
    return { id: "blocked-task" };
  },
  testConnection: async () => { calls.test++; return { ok: true }; },
  getLanDiscovery: async () => { calls.discoveryRead++; return { supported: true, enabled: false }; },
  setLanDiscovery: async () => { calls.discoveryWrite++; return { supported: true, enabled: true }; },
  runSelfUpdate: () => { calls.update++; return { supported: true, running: true }; },
};

const registry = new BackendRegistry();
registry.register(backend);
let disabled = ["blocked"];
registry.setDisabledBackendsProvider(() => disabled);

const server = await startStaticServer(0, { registry });
try {
  const blockedResponses = await Promise.all([
    requestJson(server.url, "POST", "/__api/agents?backend=blocked", { name: "Agent" }),
    requestJson(server.url, "POST", "/__api/cron/jobs", { backendId: "blocked", agentId: "blocked-a" }),
    requestJson(server.url, "GET", "/__api/models/active?backend=blocked"),
    requestJson(server.url, "POST", "/__api/tasks?backend=blocked&board=review", { title: "Task" }),
    requestJson(server.url, "PUT", "/__api/discovery/state?backend=blocked", { enabled: true }),
    requestJson(server.url, "POST", "/__api/updates/run?backend=blocked"),
  ]);
  assert.ok(blockedResponses.every((res) => res.status === 400 || res.status === 404),
    `禁用后端 CRUD 应拒绝，实际状态：${blockedResponses.map((res) => res.status).join(",")}`);
  assert.deepEqual(
    {
      agent: calls.agent,
      cron: calls.cron,
      model: calls.model,
      task: calls.task,
      discoveryWrite: calls.discoveryWrite,
      update: calls.update,
    },
    { agent: 0, cron: 0, model: 0, task: 0, discoveryWrite: 0, update: 0 },
    "禁用后端不能被 REST CRUD 触达或惰性重连",
  );

  const probe = await requestJson(server.url, "POST", "/__api/status/test", { backend: "blocked" });
  assert.equal(probe.status, 200, "显式 connection test 仍可探测 registered-but-disabled 后端");
  assert.equal(calls.test, 1);
  const settingProbe = await requestJson(server.url, "GET", "/__api/discovery/state?backend=blocked");
  assert.equal(settingProbe.status, 200, "显式设置状态探针仍可读取 registered-but-disabled 后端");
  assert.equal(calls.discoveryRead, 1);

  disabled = [];
  const activeResponses = await Promise.all([
    requestJson(server.url, "POST", "/__api/agents?backend=blocked", { name: "Agent" }),
    requestJson(server.url, "POST", "/__api/cron/jobs", { backendId: "blocked", agentId: "blocked-a" }),
    requestJson(server.url, "GET", "/__api/models/active?backend=blocked"),
    requestJson(server.url, "POST", "/__api/tasks?backend=blocked&board=review", { title: "Task" }),
    requestJson(server.url, "PUT", "/__api/discovery/state?backend=blocked", { enabled: true }),
    requestJson(server.url, "POST", "/__api/updates/run?backend=blocked"),
  ]);
  assert.ok(activeResponses.every((res) => res.status === 200),
    `重新启用后 CRUD 应恢复，实际状态：${activeResponses.map((res) => res.status).join(",")}`);
  assert.deepEqual(
    {
      agent: calls.agent,
      cron: calls.cron,
      model: calls.model,
      task: calls.task,
      discoveryWrite: calls.discoveryWrite,
      update: calls.update,
    },
    { agent: 1, cron: 1, model: 1, task: 1, discoveryWrite: 1, update: 1 },
  );
  assert.deepEqual(calls.taskOptions, { board: "review" }, "task create must forward the selected board");
} finally {
  await server.close();
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-connections-"));
const configStore = createConfigStore(path.join(temp, "config.json"));
configStore.ensure();
const connections = new BackendRegistry();
connections.register(new OpenClawBackend());
connections.register(new HermesBackend());
for (const id of ["shoggoth", "codex", "grok-build", "antigravity", "pi", "claude-code", "deepseek-harness"]) {
  connections.register(new ShoggothBackend({ id, name: id,
    connectionMode: id === "shoggoth" ? "builtin-service" : "native-runtime",
    readToken: () => { throw Error("Test must not access a real Service"); },
  }));
}
connections.setDisabledBackendsProvider(() => configStore.read().disabledBackends);
const configServer = await startStaticServer(0, { registry: connections, configStore });
try {
  const ids = [...connections.backends.keys()];
  for (const remaining of ids) {
    const disabledBackends = ids.filter((id) => id !== remaining);
    const result = await requestJson(configServer.url, "PUT", "/__api/config", { disabledBackends });
    assert.equal(result.status, 200, `${remaining} alone must satisfy the connection requirement`);
    assert.deepEqual(configStore.read().disabledBackends, disabledBackends);
    assert.deepEqual(connections._activeBackends().map(({ id }) => id), [remaining]);
    const before = fs.readFileSync(path.join(temp, "config.json"), "utf8");
    for (const lastDisabled of [ids, ids.map((id) => ` ${id} `)]) {
      const blocked = await requestJson(configServer.url, "PUT", "/__api/config", { disabledBackends: lastDisabled });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.json.code, "LAST_BACKEND_REQUIRED");
      assert.equal(fs.readFileSync(path.join(temp, "config.json"), "utf8"), before,
        "a rejected final disconnect must leave the config untouched");
    }
    const reconnected = await requestJson(configServer.url, "PUT", "/__api/config", { disabledBackends: [] });
    assert.equal(reconnected.status, 200);
    assert.equal(connections._activeBackends().length, ids.length);
  }
} finally {
  await configServer.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log("PASS disabled backend REST isolation and all 9 last-connection guards");
