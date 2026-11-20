#!/usr/bin/env node
"use strict";

// Visual preview of native background tasks: a real Service, ShoggothBackend,
// proxy and static server serving app/manage-ui/dist. Only the Codex process is
// a FakeHost. The script replays the acceptance order in one chat: dispatch →
// an independent second answer → a report with a file, plus a task still
// running. Usage: TMPDIR=/private/tmp/sgbg node scripts/shoggoth-background-task-preview.cjs [port]
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./fixtures/runtime-bridge-harness.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { DEFAULT_OPERATOR_SCOPES, generateIdentity } = require("../app/core/device-auth");
const { startStaticServer } = require("../app/static-server");

const tool = (f, run, name, args) => {
  const current = f.service.workRunCoordinator.getRun(run.id);
  const { runtimeProfileId, runtimeAccountId } = current.runtimeSessionRef;
  return f.service.workRunCoordinator.invokeRuntimeCapability({ runId: run.id, runtimeProfileId, runtimeAccountId, kind: "mcp" },
    scope => f.service.mcpProductToolController.handle(name, args, { profileId: run.profileId, callId: crypto.randomUUID() }, scope));
};

async function childRun(f, taskId) {
  await waitUntil(() => f.service.backgroundTaskStore.get(taskId)?.generations.at(-1).runId, "child accepted", 8000);
  const id = f.service.backgroundTaskStore.get(taskId).generations.at(-1).runId;
  await waitUntil(() => f.service.workRunCoordinator.getRun(id)?.status === "running", "child running", 8000);
  return f.service.workRunCoordinator.getRun(id);
}

async function startPreview(port) {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: false } });
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1, maxActive: 16,
    flags: { ...config.flags, runtimeAdmissionV1: true, runtimeContextLifecycleV1: true } });

  // One conversation replays the acceptance order.
  // FakeHost has no approval channel, so the chat keeps the fixture's permission mode.
  const source = f.createSession();
  const parent = await f.send(source.sessionKey, "preview-op-1", "后台帮我比较 A、B、C 三款产品的定价，整理成表格，做好发这里。");
  const pricing = (await tool(f, parent, "background_task_start", {
    brief: "比较产品 A、B、C 的定价\n整理成 CSV 表格，指出最便宜的方案。" })).task;
  const researchTitle = "调研三家竞品最近一季度的发布节奏，按公司与时间整理主要功能、价格和适用范围，核对每次更新对应的官方公告和产品文档。区分已经上线的功能、灰度测试和后续计划，并在对比表中为每条结论附上直达链接和可核对的发布日期。";
  const research = (await tool(f, parent, "background_task_start", {
    brief: `${researchTitle}\n每家列出主要发布和日期。` })).task;
  const pricingRun = await childRun(f, pricing.taskId);
  await childRun(f, research.taskId);
  await f.complete(parent, "好的，我已经交给后台去比较定价，另一项竞品调研也在后台进行。你可以先问别的。");
  const second = await f.send(source.sessionKey, "preview-op-2", "合同里的续费条款是什么意思？");
  await f.complete(second, "续费条款的意思是：合同到期后默认自动续一年，除非你在到期前 30 天书面通知不续约。");
  const child = f.service.chatSessionStore.getSession(f.service.backgroundTaskStore.get(pricing.taskId).childSessionKey);
  fs.writeFileSync(path.join(child.workspace, "pricing.csv"), "产品,基础版,专业版\nA,10,30\nB,8,28\nC,12,35\n");
  const published = await tool(f, pricingRun, "artifact_publish", { runId: pricingRun.id, name: "pricing.csv", kind: "report",
    mimeType: "text/csv", relativePath: "pricing.csv" });
  await f.complete(pricingRun, `结论：B 最便宜，基础版每月 8 元，专业版 28 元。\n\n| 产品 | 基础版 | 专业版 |\n| --- | --- | --- |\n| A | 10 | 30 |\n| B | 8 | 28 |\n| C | 12 | 35 |\n\n完整表格：[pricing.csv](${published.file.url})`);
  await waitUntil(() => f.service.backgroundTaskStore.get(pricing.taskId).generations[0].report.state === "delivered", "report", 8000);

  // The App starts with these conversations already known to its backend.
  const registry = new BackendRegistry();
  const backend = new ShoggothBackend({ paths: f.paths, pollIntervalMs: 50, readinessIntervalMs: 10, readinessTimeoutMs: 5000 });
  registry.register(backend); registry.setInspirationOwner(backend); registry.setChatSecretOwner(backend);
  if ((await registry.start()).get(backend.id) !== true) throw new Error("Preview backend did not start");
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "preview" } }));
    socket.on("message", data => {
      const frame = JSON.parse(data.toString()); if (frame.type !== "req") return;
      const payload = frame.method === "connect" ? { type: "hello-ok", protocol: 1, server: { version: "2026.8.1" },
        features: { methods: [], events: [] }, auth: { role: "operator", scopes: [] }, policy: { maxPayload: 65536, maxBufferedBytes: 262144 } }
        : frame.method === "sessions.list" ? { ts: Date.now(), path: "/", count: 0, defaults: {}, sessions: [] }
        : frame.method === "agents.list" ? { agents: [] } : frame.method === "models.list" ? { models: [] } : {};
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => `ws://127.0.0.1:${upstream.address().port}`,
    registry, workAdmissionGate: createWorkAdmissionGate() });
  const identity = generateIdentity();
  const staticServer = await startStaticServer(port, { registry, chatUpstreamUrl: proxy.url, chatOrigin: "http://127.0.0.1",
    homeDir: f.root, userDataRoot: path.join(f.root, "desktop-assets"),
    authResolver: { resolveConnectAuth: () => ({ ...identity, token: "background-preview", scopes: DEFAULT_OPERATOR_SCOPES }), storeDeviceToken() {} } });

  const researchRun = await childRun(f, research.taskId);
  const completeResearch = () => f.complete(researchRun,
    "三家竞品上季度各有两次主要发布：A 在 7 月和 9 月，B 在 8 月和 9 月，C 在 7 月和 8 月。");
  const url = `${staticServer.url}/#/chat`;
  return { url, base: staticServer.url, fixture: f, tasks: { pricing: pricing.taskId, research: research.taskId }, researchTitle, completeResearch,
    sessionKey: `agent:${f.profile.agentId}:${source.sessionKey}`, close: async () => {
    await staticServer.close(); await proxy.close(); await backend.stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => upstream.close(resolve));
    await f.close();
  } };
}

if (require.main === module) {
  const port = Number(process.argv[2] || 61806);
  startPreview(port).then(async preview => {
    // GET /fixture/complete finishes the second task while the page is open.
    const control = http.createServer(async (request, response) => {
      if (request.url !== "/fixture/complete") { response.writeHead(404).end(); return; }
      try { await preview.completeResearch(); response.writeHead(200).end("ok"); }
      catch (error) { response.writeHead(500).end(String(error?.message || error)); }
    });
    await new Promise(resolve => control.listen(port + 1, "127.0.0.1", resolve));
    console.log(JSON.stringify({ url: preview.url, control: `http://127.0.0.1:${port + 1}/fixture/complete`, sessionKey: preview.sessionKey }));
    const stop = () => { control.close(); void preview.close().finally(() => process.exit(0)); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  }, error => { console.error(error); process.exit(1); });
}

module.exports = { startPreview };
