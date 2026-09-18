"use strict";
// Throwaway CRUD smoke for the new management REST routes. Uses far-future /
// harmless specs and cleans up after itself. Run: node scripts/_crud-smoke.cjs [cron|tasks|skills|models|agents|all]
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HermesBackend } = require("../app/core/hermes-backend");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { sortAgentsByCreatedAt } = require("../app/core/agent-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { createConfigStore } = require("../app/core/config-store");
const { createModelChangeJournal } = require("../app/core/model-change-journal");
const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");

const WHICH = process.argv[2] || "all";
let failed = false;

// opts.raw：body 已是 Buffer（附件上传的原始字节，不再 JSON.stringify）。
// opts.rawResponse：响应体不当 JSON 解析，原样放在 .text（附件下载）。
function req(method, url, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : opts.raw ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) {
      headers["Content-Type"] = opts.raw ? "application/octet-stream" : "application/json";
      headers["Content-Length"] = payload.length;
    }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => {
        if (opts.rawResponse) return resolve({ status: res.statusCode, text: b, headers: res.headers });
        let j; try { j = JSON.parse(b); } catch { j = b; } resolve({ status: res.statusCode, json: j });
      });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
}
// HEAD-ish GET that returns only status + content-type (for binary /__media route).
function reqHead(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET" },
      (res) => {
        res.resume(); // drain body
        resolve({ status: res.statusCode, type: res.headers["content-type"] || "" });
      },
    );
    r.on("error", reject);
    r.end();
  });
}
const log = (...a) => console.log("[crud]", ...a);
const ok = (c, m) => {
  if (!c) failed = true;
  console.log(`${c ? "  ✅" : "  ❌"} ${m}`);
};

// usage smoke 只验证契约形状和数值类型，允许真实环境暂无用量数据。
function isNumeric(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// 校验 token 用量返回结构，确保前端可以安全渲染新增 dashboard 字段。
// OpenClaw 的 usage.cost / sessions.usage 实测必带拆分与聚合块（spec
// 2026-06-11-usage-dashboard-design §1）；Hermes 拆分已有、聚合块可缺。
// 冷缓存(refreshing)时数值可为 0，但键必须存在。
function assertUsagePayload(backend, seriesPayload, breakdownPayload) {
  const series = seriesPayload.json.series;
  const breakdown = breakdownPayload.json.breakdown;
  const requireFull = backend === "openclaw";
  const seriesOk =
    seriesPayload.status === 200 &&
    series &&
    Array.isArray(series.daily) &&
    series.totals &&
    isNumeric(series.totals.totalTokens) &&
    isNumeric(series.totals.totalCost) &&
    series.daily.every(
      (d) => !requireFull || (isNumeric(d.inputTokens) && isNumeric(d.cacheWriteTokens)),
    );
  ok(seriesOk, `${backend} usage series shape -> ${seriesPayload.status}`);
  const breakdownOk =
    breakdownPayload.status === 200 &&
    breakdown &&
    Array.isArray(breakdown.byModel) &&
    Array.isArray(breakdown.bySource) &&
    (breakdown.sourceKind === "agent" || breakdown.sourceKind === "profile") &&
    breakdown.totals &&
    isNumeric(breakdown.totals.totalTokens) &&
    isNumeric(breakdown.totals.totalCost);
  ok(breakdownOk, `${backend} usage breakdown shape -> ${breakdownPayload.status}`);
  const aggregatesOk =
    !requireFull ||
    (Array.isArray(breakdown.byChannel) &&
      Array.isArray(breakdown.modelDaily) &&
      Array.isArray(breakdown.dailyActivity) &&
      Array.isArray(breakdown.dailyLatency) &&
      Array.isArray(breakdown.topSessions) &&
      breakdown.tools &&
      isNumeric(breakdown.tools.totalCalls));
  ok(aggregatesOk, `${backend} usage breakdown aggregates`);
}

/**
 * 为 CRUD smoke 注入纯内存模型变更 adapter：穿过真实 coordinator/journal/REST，
 * 但绝不调用用户 OpenClaw/Hermes 配置写接口。返回 restore 供进程结束前还原方法。
 */
function installSmokeModelAdapter(backend) {
  const providers = new Map();
  // 触达过的 fixture key 归内存 adapter 所有，删除后也不能重新暴露真实同名
  // config/auth provider。只隔离测试投影，不删除或修改底层配置与凭证。
  const touchedProviders = new Set();
  let version = 0;
  const originals = new Map();
  for (const method of [
    "getModelConfig", "getModelCatalogSources", "getModelChangeCapabilities",
    "previewModelChange", "applyModelChange", "revealModelProviderKey",
  ]) {
    originals.set(method, backend[method]);
  }
  const originalGetConfig = typeof backend.getModelConfig === "function"
    ? backend.getModelConfig.bind(backend)
    : async () => ({ providers: [] });

  /** 把内存 Provider 转成只含公开字段的配置响应。 */
  function publicProvider(provider) {
    return {
      key: provider.key,
      name: provider.key,
      baseUrl: provider.baseUrl || "",
      api: provider.api || "",
      hasApiKey: Boolean(provider.apiKey),
      source: "config",
      editable: true,
      models: provider.models.map((model) => ({ ...model, catalogId: model.id })),
    };
  }

  backend.getModelConfig = async () => {
    const base = await originalGetConfig();
    const untouched = (Array.isArray(base?.providers) ? base.providers : [])
      .filter((provider) => !touchedProviders.has(provider.key));
    return { ...base, providers: [...untouched, ...[...providers.values()].map(publicProvider)] };
  };
  backend.getModelCatalogSources = async () => {
    const rows = [...providers.values()].flatMap((provider) => provider.models.map((model) => ({
      ...model,
      provider: provider.key,
      backendId: backend.id,
    })));
    return { models: rows, config: rows, runtime: rows };
  };
  backend.getModelChangeCapabilities = async () => ({
    supported: true, create: true, update: true, rename: true, delete: true, blockers: [],
  });
  backend.previewModelChange = async () => ({
    references: [], blockers: [], runtimeApply: "hot", fingerprints: { smokeVersion: String(version) },
  });
  backend.applyModelChange = async (safeSpec, context, secretEnvelope) => {
    context.assertProviderLease();
    if (secretEnvelope?.apiKey) {
      await context.recordStage("provider-secret", { secretStep: "applied" });
    }
    await context.markCommitting();
    touchedProviders.add(safeSpec.providerKey);
    if (["create", "update", "rename"].includes(safeSpec.kind)) {
      const provider = providers.get(safeSpec.providerKey) || {
        key: safeSpec.providerKey, baseUrl: "", api: "", apiKey: "", models: [],
      };
      if (safeSpec.sourceModelId) {
        provider.models = provider.models.filter((model) => model.id !== safeSpec.sourceModelId);
      }
      provider.models = provider.models.filter((model) => model.id !== safeSpec.model.id);
      provider.models.push({ ...safeSpec.model });
      if (safeSpec.baseUrl) provider.baseUrl = safeSpec.baseUrl;
      if (safeSpec.api) provider.api = safeSpec.api;
      if (secretEnvelope?.apiKey) provider.apiKey = secretEnvelope.apiKey;
      providers.set(provider.key, provider);
    } else if (safeSpec.kind === "update-provider") {
      const provider = providers.get(safeSpec.providerKey) || {
        key: safeSpec.providerKey, baseUrl: "", api: "", apiKey: "", models: [],
      };
      if (safeSpec.patch.clearBaseUrl === true) provider.baseUrl = "";
      if (typeof safeSpec.patch.baseUrl === "string") provider.baseUrl = safeSpec.patch.baseUrl;
      if (typeof safeSpec.patch.api === "string") provider.api = safeSpec.patch.api;
      if (secretEnvelope?.apiKey) provider.apiKey = secretEnvelope.apiKey;
      providers.set(provider.key, provider);
    } else if (safeSpec.kind === "delete-model") {
      const provider = providers.get(safeSpec.providerKey);
      if (provider) {
        provider.models = provider.models.filter((model) => model.id !== safeSpec.sourceModelId);
        if (provider.models.length === 0) providers.delete(provider.key);
      }
    } else if (safeSpec.kind === "delete-provider") {
      providers.delete(safeSpec.providerKey);
    }
    version += 1;
    await context.markCommitted();
    return { status: "applied", stage: "verify-ready" };
  };
  backend.revealModelProviderKey = async (providerKey) => {
    const provider = providers.get(providerKey);
    if (provider) return { apiKey: provider.apiKey || null, baseUrl: provider.baseUrl || "", reason: provider.apiKey ? undefined : "none" };
    if (touchedProviders.has(providerKey)) return { apiKey: null, baseUrl: "", reason: "none" };
    const original = originals.get("revealModelProviderKey");
    return typeof original === "function" ? original.call(backend, providerKey) : { apiKey: null, reason: "none" };
  };

  return () => {
    for (const [method, implementation] of originals) backend[method] = implementation;
  };
}

async function main() {
  if (WHICH === "inspiration" || WHICH === "all") {
    await require("./shoggoth-inspiration-rest-smoke.cjs").runInspirationRestSmoke();
    if (WHICH === "inspiration") return;
  }
  const hb = new HermesBackend();
  await hb.start();
  const oc = new OpenClawBackend();
  const registry = new BackendRegistry();
  registry.register(oc);
  registry.register(hb);
  // Scratch config store: exercises the /__api/config plane (设置页 + SetupOverlay
  // 首启盖章) without ever touching the real userData config.json.
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "crud-smoke-cfg-"));
  const configStore = createConfigStore(path.join(cfgDir, "config.json"));
  // 与两个入口(main.js / manage-serve.cjs)同款：断开的后端从聚合/路由消失。
  registry.setDisabledBackendsProvider(() => configStore.read().disabledBackends);
  // perAgentModelSettings（R300）是**静态能力位**，模型页据它决定形态（凭证层 vs
  // 目录网格）。必须在 installSmokeModelAdapter 覆盖 getModelChangeCapabilities
  // **之前**取真实值——否则断言打的是测试替身的固定返回，毫无意义。
  // OpenClaw 没装 adapter 时该方法会抛（_requireModelChangeAdapter），catch 成
  // undefined 正是期望的 falsy。
  const realPerAgentModelSettings = {
    hermes: (await hb.getModelChangeCapabilities().catch(() => ({}))).perAgentModelSettings,
    openclaw: (await oc.getModelChangeCapabilities().catch(() => ({}))).perAgentModelSettings,
  };
  const restoreModelAdapters = [];
  let modelChangeCoordinator;
  if (WHICH === "models" || WHICH === "all") {
    restoreModelAdapters.push(installSmokeModelAdapter(oc), installSmokeModelAdapter(hb));
    modelChangeCoordinator = new ModelChangeCoordinator({
      registry,
      journal: createModelChangeJournal(path.join(cfgDir, "model-change-journal.json")),
    });
    modelChangeCoordinator.markReady();
  }
  const server = await startStaticServer(0, { registry, configStore, modelChangeCoordinator });
  const B = server.url;
  log(`server ${B}; hermes agents=[${hb.agents.map((a) => a.id).join(",")}]`);
  const hermesAgent = hb.agents[0]?.id;

  if (WHICH === "config" || WHICH === "all") {
    log("--- APP CONFIG ---");
    try {
      let r = await req("GET", `${B}/__api/config`);
      ok(r.status === 200 && r.json.config?.setupCompletedAt === 0,
        `config GET fresh -> ${r.status}, setupCompletedAt=${r.json.config?.setupCompletedAt}`);
      // SetupOverlay 的盖章路径：PUT 局部字段 → 数值 round-trip 持久化。
      const STAMP = 1750000000000;
      r = await req("PUT", `${B}/__api/config`, { setupCompletedAt: STAMP });
      ok(r.status === 200 && r.json.config?.setupCompletedAt === STAMP,
        `config PUT stamp -> ${r.status}, setupCompletedAt=${r.json.config?.setupCompletedAt}`);
      r = await req("GET", `${B}/__api/config`);
      ok(r.status === 200 && r.json.config?.setupCompletedAt === STAMP, `config stamp persisted`);
      // 非法值被 normalize 兜回 0，而不是把垃圾写进盘。
      r = await req("PUT", `${B}/__api/config`, { setupCompletedAt: "junk" });
      ok(r.status === 200 && r.json.config?.setupCompletedAt === 0,
        `config junk stamp normalized -> ${r.json.config?.setupCompletedAt}`);
      // 窗口尺寸:默认值 + UI 不得回写(设置页整份 PUT 会带着它打开那一刻的旧值,
      // 放行就会覆盖掉桌面壳刚在 resize 里存下的尺寸)。
      r = await req("GET", `${B}/__api/config`);
      ok(r.json.config?.windowBounds?.width === 1728 && r.json.config?.windowBounds?.height === 1117,
        `config windowBounds default -> ${JSON.stringify(r.json.config?.windowBounds)}`);
      r = await req("PUT", `${B}/__api/config`, { windowBounds: { width: 300, height: 200 } });
      ok(r.status === 200 && r.json.config?.windowBounds?.width === 1728,
        `config windowBounds ignored on PUT -> ${JSON.stringify(r.json.config?.windowBounds)}`);
      // hermesKeepAlive:缺字段默认开;显式 false 要能落盘 round-trip;
      // 非布尔值一律 normalize 成 false —— 决定「杀不杀进程」的开关不能被脏值带成开。
      r = await req("GET", `${B}/__api/config`);
      ok(r.json.config?.hermesKeepAlive === true,
        `config hermesKeepAlive default on -> ${r.json.config?.hermesKeepAlive}`);
      r = await req("PUT", `${B}/__api/config`, { hermesKeepAlive: false });
      ok(r.status === 200 && r.json.config?.hermesKeepAlive === false,
        `config hermesKeepAlive PUT false -> ${r.json.config?.hermesKeepAlive}`);
      r = await req("GET", `${B}/__api/config`);
      ok(r.json.config?.hermesKeepAlive === false, `config hermesKeepAlive false persisted`);
      r = await req("PUT", `${B}/__api/config`, { hermesKeepAlive: "junk" });
      ok(r.status === 200 && r.json.config?.hermesKeepAlive === false,
        `config hermesKeepAlive junk normalized -> ${r.json.config?.hermesKeepAlive}`);
    } catch (e) {
      ok(false, `app config: ${e.message}`);
    }
  }

  if (WHICH === "chat" || WHICH === "all") {
    log("--- CHAT CAPABILITIES (附件能力契约) ---");
    try {
      // 两个后端都必须声明三类附件——OpenClaw 曾漏声明，UI 因此只放行图片，
      // 而它的网关 chat.send 其实 acceptNonImage:true 且无 MIME 白名单。
      // 上限不可互换：OpenClaw 图片 6MiB / 其它 20MB；Hermes 图片 25MB /
      // PDF 50MB / 文件 25MB（各自网关的真实约束）。
      // 按 backend= 查：本 smoke 没有真 gateway，OpenClaw 离线不认领 agent，
      // 而附件能力是与在线无关的静态传输属性。
      let r = await req("GET", `${B}/__api/chat/capabilities?backend=openclaw`);
      const oa = r.json?.attachments || {};
      ok(r.status === 200 && !!oa.image && !!oa.pdf && !!oa.file,
        `openclaw caps -> image/pdf/file 三类齐全 (${Object.keys(oa).join(",")})`);
      ok(oa.image?.maxBytes === 6 * 1024 * 1024 && oa.file?.maxBytes === 20 * 1024 * 1024,
        `openclaw caps 上限 -> image=${oa.image?.maxBytes} file=${oa.file?.maxBytes}`);
      if (hermesAgent) {
        r = await req("GET", `${B}/__api/chat/capabilities?agent=${encodeURIComponent(hermesAgent)}`);
        const ha = r.json?.attachments || {};
        ok(r.status === 200 && !!ha.image, `hermes caps -> ${Object.keys(ha).join(",")}`);
        ok(ha.pdf?.maxPages === 25 || !ha.pdf, `hermes pdf 页数上限 -> ${ha.pdf?.maxPages ?? "(ACP 降级，无 pdf)"}`);
      }
      r = await req("GET", `${B}/__api/chat/capabilities?agent=definitely-not-an-agent`);
      ok(r.status === 404, `caps unknown agent -> ${r.status}`);
      r = await req("POST", `${B}/__api/chat/capabilities?backend=openclaw`);
      ok(r.status === 405, `caps POST -> ${r.status}`);
      // 斜杠命令目录：OpenClaw 无服务端命令面 → supported:false（UI 回落内置表）。
      r = await req("GET", `${B}/__api/chat/slash?backend=openclaw`);
      ok(r.status === 200 && r.json?.supported === false,
        `openclaw slash catalog -> supported=${r.json?.supported}`);
    } catch (e) {
      ok(false, `chat capabilities: ${e.message}`);
    }
  }

  if (WHICH === "status" || WHICH === "all") {
    log("--- STATUS (S1 reason 语义) ---");
    try {
      const r = await req("GET", `${B}/__api/status`);
      const list = Array.isArray(r.json) ? r.json : r.json?.backends || [];
      const oc = list.find((b) => b.id === "openclaw");
      ok(r.status === 200 && !!oc, `status GET -> ${r.status}, openclaw entry ${oc ? "present" : "MISSING"}`);
      ok(typeof oc?.info?.gatewayUrl === "string" && typeof oc?.info?.hasIdentity === "boolean",
        `status openclaw shape -> gatewayUrl/hasIdentity`);
      // S1:失败必须带 classifyAuthError 的 reason 机器码;成功则无 reason。
      ok(oc?.connected ? oc.info.reason === undefined : typeof oc?.info?.reason === "string",
        `status reason 语义 -> connected=${oc?.connected}, reason=${oc?.info?.reason ?? "-"}`);
    } catch (e) {
      ok(false, `status: ${e.message}`);
    }
  }

  if (WHICH === "disconnect" || WHICH === "all") {
    log("--- DISCONNECT (设置页断开/重连) ---");
    try {
      // 断开 hermes：status 返回合成的 disabled 行，聚合面不再触达该后端。
      let r = await req("PUT", `${B}/__api/config`, { disabledBackends: ["hermes"] });
      ok(r.status === 200 && JSON.stringify(r.json.config?.disabledBackends) === '["hermes"]',
        `config PUT disabledBackends -> ${r.status}, ${JSON.stringify(r.json.config?.disabledBackends)}`);
      r = await req("GET", `${B}/__api/status`);
      let list = Array.isArray(r.json) ? r.json : r.json?.backends || [];
      const hm = list.find((b) => b.id === "hermes");
      ok(hm?.disabled === true && hm?.connected === false,
        `status hermes 断开行 -> disabled=${hm?.disabled}, connected=${hm?.connected}`);
      ok(list.find((b) => b.id === "openclaw")?.disabled === undefined, "openclaw 不受影响");
      r = await req("GET", `${B}/__api/agents?backend=hermes`);
      ok(r.status === 200 && Array.isArray(r.json?.agents) && r.json.agents.length === 0,
        `断开后 agents?backend=hermes 为空 -> ${r.json?.agents?.length}`);
      // 重连：status 恢复真实行（不再带 disabled）。
      r = await req("PUT", `${B}/__api/config`, { disabledBackends: [] });
      const st = await req("GET", `${B}/__api/status`);
      list = Array.isArray(st.json) ? st.json : st.json?.backends || [];
      ok(r.status === 200 && list.find((b) => b.id === "hermes")?.disabled === undefined,
        "复位后 hermes 恢复启用");
    } catch (e) {
      ok(false, `disconnect: ${e.message}`);
    } finally {
      // 无论成败都复位，后续 smoke 段要打满两个后端。
      await req("PUT", `${B}/__api/config`, { disabledBackends: [] }).catch(() => {});
    }
  }

  if (WHICH === "host" || WHICH === "all") {
    log("--- HOST (openclaw 侦察) ---");
    try {
      const r = await req("GET", `${B}/__api/host/openclaw`);
      const h = r.json?.host;
      ok(r.status === 200 && h && (h.binPath === null || typeof h.binPath === "string"),
        `host GET -> ${r.status}, binPath=${h?.binPath ? "found" : "null"}`);
      ok(["gatewayRunning", "configExists", "localTokenReadable", "identityExists"]
        .every((k) => typeof h?.[k] === "boolean"), "host 布尔形状齐全");
      const bad = await req("PUT", `${B}/__api/host/openclaw`);
      ok(bad.status === 405, `host 非法方法 -> ${bad.status}`);
    } catch (e) { ok(false, `host: ${e.message}`); }
  }

  if (WHICH === "discovery" || WHICH === "all") {
    log("--- DISCOVERY (LAN 浏览) ---");
    try {
      const r = await req("GET", `${B}/__api/discovery/openclaw`);
      ok(r.status === 200 && Array.isArray(r.json?.gateways),
        `discovery GET -> ${r.status}, ${Array.isArray(r.json?.gateways) ? r.json.gateways.length : "?"} 个`);
      const bad = await req("PUT", `${B}/__api/discovery/openclaw`);
      ok(bad.status === 405, `discovery 非法方法 -> ${bad.status}`);
      // LAN 发现开关只读路径(PUT 是实写网关配置,不进 smoke——preview 手测)。
      const st = await req("GET", `${B}/__api/discovery/state?backend=openclaw`);
      ok(st.status === 200 && st.json?.supported === true && typeof st.json?.enabled === "boolean",
        `discovery state(openclaw) -> supported=${st.json?.supported}, enabled=${st.json?.enabled}, managed=${st.json?.managed}`);
      const hm = await req("GET", `${B}/__api/discovery/state?backend=hermes`);
      ok(hm.status === 200 && hm.json?.supported === false, `discovery state(hermes) -> supported=false`);
    } catch (e) { ok(false, `discovery: ${e.message}`); }
  }

  if (WHICH === "cli" || WHICH === "all") {
    log("--- CLI USAGE ---");
    // Reads local ~/.openclaw JSONL only (no gateway RPC), so this runs offline.
    try {
      const u = await req("GET", `${B}/__api/cli/usage`);
      const backends = u.json?.backends;
      ok(u.status === 200 && Array.isArray(backends),
        `cli/usage -> ${Array.isArray(backends) ? backends.length + " backends" : JSON.stringify(u.json)}`);
      if (Array.isArray(backends)) {
        const oc = backends.find((b) => b.backend === "openclaw");
        // 新结构：commands[cmd] 是 { agentId: count } 对象（per-agent 拆分）。
        const ocCmds = oc?.commands || {};
        const sample = Object.values(ocCmds)[0];
        const nested = sample === undefined || (typeof sample === "object" && sample !== null && !Array.isArray(sample)
          && Object.values(sample).every((n) => typeof n === "number"));
        ok(oc && typeof oc.supported === "boolean" && typeof ocCmds === "object" && nested,
          `openclaw per-agent shape -> supported=${oc?.supported}, ${Object.keys(ocCmds).length} cmds, nested=${nested}`);
        log(`openclaw cli usage: ${Object.keys(ocCmds).length} unique commands (0 ⇒ check MAX_FILES / data reality)`);
        const hm = backends.find((b) => b.backend === "hermes");
        // Local Hermes now parses on-disk session transcripts (terminal tool) → supported:true;
        // remote → supported:false. Shape-check both; command count is machine-dependent.
        const hmCmds = hm?.commands || {};
        const hmSample = Object.values(hmCmds)[0];
        const hmNested = hmSample === undefined || (typeof hmSample === "object" && hmSample !== null && !Array.isArray(hmSample)
          && Object.values(hmSample).every((n) => typeof n === "number"));
        ok(hm && typeof hm.supported === "boolean" && typeof hmCmds === "object" && hmNested,
          `hermes shape -> supported=${hm?.supported}, ${Object.keys(hmCmds).length} cmds, reason=${hm?.reason || "-"}`);
      }
    } catch (e) {
      ok(false, `cli/usage threw: ${e.message}`);
    }
  }

  if (WHICH === "updates" || WHICH === "all") {
    log("--- SELF-UPDATE ---");
    // 只验证路由与返回形状，绝不 POST 真实 backend（会真的 npm/git 更新 + 重启服务）。
    try {
      const s = await req("GET", `${B}/__api/updates`);
      const rows = s.json?.updates;
      const shapeOk =
        s.status === 200 &&
        Array.isArray(rows) &&
        rows.length >= 2 &&
        rows.every((r) => typeof r.id === "string" && typeof r.supported === "boolean");
      ok(shapeOk, `updates status shape -> ${s.status}, ${Array.isArray(rows) ? rows.length : "?"} backends`);
      const missing = await req("POST", `${B}/__api/updates/run`);
      ok(missing.status === 400, `run without ?backend= -> ${missing.status}`);
      const unknown = await req("POST", `${B}/__api/updates/run?backend=nope`);
      ok(unknown.status === 404, `run unknown backend -> ${unknown.status}`);
    } catch (e) {
      ok(false, `updates threw: ${e.message}`);
    }
  }

  if (WHICH === "grants" || WHICH === "all") {
    log("--- STANDING APPROVAL GRANTS ---");
    // 只读并验证浏览器边界的安全投影；绝不撤销用户已有授权。
    try {
      const listed = await req("GET", `${B}/__api/approval-grants?backend=openclaw&limit=10`);
      const grants = listed.json?.grants;
      const safe = Array.isArray(grants) && grants.every((grant) =>
        grant && typeof grant === "object"
          && !Object.hasOwn(grant, "command")
          && !Object.hasOwn(grant, "cwd"));
      ok(listed.status === 200 && typeof listed.json?.supported === "boolean" && safe,
        `approval grants safe projection -> ${listed.status}, ${Array.isArray(grants) ? grants.length : "?"} rows`);
      const missing = await req("DELETE", `${B}/__api/approval-grants?backend=openclaw`);
      ok(missing.status === 400, `approval grant revoke missing id -> ${missing.status}`);
    } catch (e) {
      ok(false, `approval grants threw: ${e.message}`);
    }
  }

  if (WHICH === "media" || WHICH === "all") {
    log("--- MEDIA ---");
    // /__media serves agent-attached images (OpenClaw `MEDIA:` directive). Guards: must be
    // inside the OpenClaw tree AND an image type. Happy path uses a temp PNG written under
    // ~/.openclaw; the out-of-tree guard is asserted regardless of write success.
    const tmpDir = path.join(os.homedir(), ".openclaw", "workspace", ".shoggoth-media-smoke");
    const tmpPng = path.join(tmpDir, "probe.png");
    const tmpTxt = path.join(tmpDir, "secret.txt");
    // 1x1 transparent PNG.
    const PNG_1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    let wrote = false;
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(tmpPng, PNG_1x1);
      fs.writeFileSync(tmpTxt, "not an image");
      wrote = true;
    } catch {
      /* ~/.openclaw not writable here — skip the file-backed assertions */
    }
    if (wrote) {
      try {
        const good = await reqHead(`${B}/__media?path=${encodeURIComponent(tmpPng)}`);
        ok(good.status === 200 && /image\/png/.test(good.type), `serve in-tree png -> ${good.status} ${good.type}`);
        const nonImg = await reqHead(`${B}/__media?path=${encodeURIComponent(tmpTxt)}`);
        ok(nonImg.status === 404, `in-tree non-image refused -> ${nonImg.status}`);
      } catch (e) {
        ok(false, `media serve threw: ${e.message}`);
      }
    } else {
      log("  (skip file-backed checks: ~/.openclaw not writable)");
    }
    try {
      const trav = await reqHead(`${B}/__media?path=${encodeURIComponent("/etc/passwd")}`);
      ok(trav.status === 404, `out-of-tree path refused -> ${trav.status}`);
    } catch (e) {
      ok(false, `media out-of-tree threw: ${e.message}`);
    }
    try {
      if (wrote) {
        fs.unlinkSync(tmpPng);
        fs.unlinkSync(tmpTxt);
        fs.rmdirSync(tmpDir);
      }
    } catch {
      /* best-effort cleanup */
    }
  }

  if (WHICH === "cron" || WHICH === "all") {
    log("--- CRON ---");
    // OpenClaw create → update → runs → delete (far-future, never runs)
    try {
      const c = await req("POST", `${B}/__api/cron/jobs`, {
        backendId: "openclaw", name: "[smoke] oc", description: "advanced smoke", prompt: "noop",
        schedule: { kind: "at", at: "2031-01-01T00:00:00.000Z" }, enabled: false,
        sessionTarget: "isolated", wakeMode: "next-heartbeat", deleteAfterRun: false,
        delivery: { mode: "none" }, failureAlert: { after: 2, cooldownMs: 60000, mode: "announce" },
      });
      ok(c.status === 200 && c.json.job?.id, `OpenClaw create -> ${c.json.job?.id || JSON.stringify(c.json)}`);
      const id = c.json.job?.id;
      if (id) {
        // failureAlert:null mirrors the form with the toggle off — gateway only
        // accepts false|object, so the backend must map null→false (see R45).
        const u = await req("PUT", `${B}/__api/cron/jobs/${encodeURIComponent(id)}`, {
          name: "[smoke] oc2", prompt: "noop2", delivery: { mode: "none" }, failureAlert: null,
        });
        ok(u.status === 200 && u.json.job?.name === "[smoke] oc2" && !u.json.job?.failureAlert,
          `OpenClaw update name + disable alert -> ${u.json.job?.name}, alert=${u.json.job?.failureAlert}`);
        const run = await req("POST", `${B}/__api/cron/jobs/${encodeURIComponent(id)}/run`, { mode: "due" });
        ok(run.status === 200, `OpenClaw run due -> ${run.status}`);
        const r = await req("GET", `${B}/__api/cron/jobs/${encodeURIComponent(id)}/runs?status=ok&limit=5`);
        ok(r.status === 200 && Array.isArray(r.json.runs), `OpenClaw runs -> ${r.json.runs?.length} entries`);
        const dlv = await req("GET", `${B}/__api/cron/jobs/${encodeURIComponent(id)}/delivery`);
        ok(dlv.status === 200 && typeof dlv.json.source === "string", `OpenClaw delivery -> source=${dlv.json.source}`);
        // R342 trajectory:无 sessionKey → supported:false 的 200 降级(形状即契约)
        const trj = await req("GET", `${B}/__api/cron/jobs/${encodeURIComponent(id)}/trajectory`);
        ok(trj.status === 200 && trj.json.supported === false && Array.isArray(trj.json.parts),
          `OpenClaw trajectory no-session -> supported=${trj.json.supported}`);
        const d = await req("DELETE", `${B}/__api/cron/jobs/${encodeURIComponent(id)}`);
        ok(d.status === 200, `OpenClaw delete -> ${d.status}`);
      }
    } catch (e) { ok(false, `OpenClaw cron: ${e.message}`); }
    // Hermes create → update → delete
    if (hermesAgent) {
      try {
        const c = await req("POST", `${B}/__api/cron/jobs`, {
          agentId: hermesAgent, name: "[smoke] h", prompt: "noop", schedule: { kind: "cron", expr: "0 5 31 12 *" },
          // Smoke 只验证可移植的高级字段，不依赖用户目录中偶然存在的脚本文件。
          backendId: "hermes", skills: ["watchers"],
          workdir: "", profile: "", repeat: 1, enabledToolsets: ["terminal"], enabled: false,
        });
        ok(c.status === 200 && c.json.job?.id, `Hermes create -> ${c.json.job?.id || JSON.stringify(c.json)}`);
        const id = c.json.job?.id;
        if (id) {
          const u = await req("PUT", `${B}/__api/cron/jobs/${encodeURIComponent(id)}`, { name: "[smoke] h2", enabled: true });
          ok(u.status === 200, `Hermes update -> ${u.status} name=${u.json.job?.name}`);
          const p = await req("PUT", `${B}/__api/cron/jobs/${encodeURIComponent(id)}`, { enabled: false });
          ok(p.status === 200, `Hermes pause -> ${p.status}`);
          const d = await req("DELETE", `${B}/__api/cron/jobs/${encodeURIComponent(id)}`);
          ok(d.status === 200, `Hermes delete -> ${d.status}`);
        }
      } catch (e) { ok(false, `Hermes cron: ${e.message}`); }
    }
    // agentIds 多选筛选（工具栏 Agent 面板）：命中任一即保留，未知 id 必须筛空。
    try {
      const all = await req("GET", `${B}/__api/cron/jobs`);
      const withAgent = (all.json.jobs || []).filter((j) => j.agentId);
      const none = await req("GET", `${B}/__api/cron/jobs?agentIds=${encodeURIComponent("__smoke_no_such_agent__")}`);
      ok(none.status === 200 && (none.json.jobs || []).length === 0,
        `cron agentIds unknown -> ${none.json.jobs?.length} jobs`);
      if (withAgent.length) {
        const pick = withAgent[0].agentId;
        const one = await req("GET", `${B}/__api/cron/jobs?agentIds=${encodeURIComponent(pick)}`);
        const rows = one.json.jobs || [];
        ok(one.status === 200 && rows.length > 0 && rows.every((j) => j.agentId === pick),
          `cron agentIds=${pick} -> ${rows.length} jobs, all match`);
        const two = await req("GET", `${B}/__api/cron/jobs?agentIds=${encodeURIComponent(`${pick},__smoke_no_such_agent__`)}`);
        ok(two.status === 200 && (two.json.jobs || []).length === rows.length,
          `cron agentIds multi-select -> ${two.json.jobs?.length} jobs (union)`);
      } else {
        log("  (no cron job carries an agentId — skipped positive agentIds case)");
      }
    } catch (e) { ok(false, `cron agentIds filter: ${e.message}`); }
  }

  if (WHICH === "tasks" || WHICH === "all") {
    log("--- TASKS ---");
    // OpenClaw = gateway workboard plugin (create→move→archive→delete, real cards)
    try {
      const board = await req("GET", `${B}/__api/tasks?backend=openclaw`);
      const cols = board.json.board?.columns || [];
      const caps = board.json.board?.capabilities || {};
      ok(board.status === 200 && caps.kind === "workboard",
        `openclaw board -> ${cols.length} cols, caps.kind=${caps.kind}, ${cols.reduce((s,c)=>s+(c.tasks?.length||0),0)} cards`);
      // 列集随 gateway workboard 版本变化（6 列 → 9 列），只校验契约形状：
      // 非空且含本 smoke 依赖的关键列（todo=建卡、review=move 目标、done）。
      const colIds = cols.map((c) => c.id);
      ok(cols.length >= 1 && ["todo", "review", "done"].every((k) => colIds.includes(k)),
        `openclaw columns (need todo/review/done) -> ${colIds.join(",")}`);
      // 工作板扩展载荷（1:1 官方视图的输入）：statuses/sessions/agents + 卡片 wb。
      ok(Array.isArray(board.json.board?.statuses) && board.json.board.statuses.length >= 6,
        `openclaw statuses -> ${(board.json.board?.statuses || []).join(",")}`);
      ok(Array.isArray(board.json.board?.sessions), `openclaw board sessions -> ${(board.json.board?.sessions || []).length}`);
      ok(Array.isArray(board.json.board?.agents?.agents), `openclaw board agents -> ${(board.json.board?.agents?.agents || []).length}`);
      const c = await req("POST", `${B}/__api/tasks?backend=openclaw`,
        { title: "[smoke] wb", body: "smoke", column: "todo", priorityLevel: "high", labels: ["smoke"] });
      const id = c.json.task?.id;
      ok(c.status === 200 && id && c.json.task?.priorityLevel === "high", `openclaw create -> ${id} P=${c.json.task?.priorityLevel}`);
      if (id) {
        const u = await req("PUT", `${B}/__api/tasks?backend=openclaw&id=${encodeURIComponent(id)}`, { title: "[smoke] wb2", body: "edited" });
        ok(u.status === 200 && u.json.task?.title === "[smoke] wb2", `openclaw update -> ${u.json.task?.title}`);
        const mv = await req("POST", `${B}/__api/tasks?backend=openclaw&id=${encodeURIComponent(id)}&action=move`, { status: "review", position: 999000 });
        ok(mv.status === 200 && mv.json.task?.column === "review", `openclaw move -> ${mv.json.task?.column}`);
        // 操作员备注（官方 workboard.cards.comment）。
        const cm = await req("POST", `${B}/__api/tasks?backend=openclaw&id=${encodeURIComponent(id)}&action=comment`, { body: "[smoke] note" });
        ok(cm.status === 200, `openclaw comment -> ${cm.status}`);
        const det = await req("GET", `${B}/__api/tasks?backend=openclaw&id=${encodeURIComponent(id)}`);
        ok(det.status === 200 && (det.json.task?.comments || []).some((x) => x.body === "[smoke] note"),
          `openclaw comment visible -> ${(det.json.task?.comments || []).length}`);
        // stop（官方 Nm）：无会话/无任务的卡应为安全 no-op（ok:false + reason）。
        const st = await req("POST", `${B}/__api/tasks?backend=openclaw&id=${encodeURIComponent(id)}&action=stop`);
        ok(st.status === 200 && st.json.result?.ok === false, `openclaw stop(no-session) -> ok=${st.json.result?.ok} ${st.json.result?.reason || ""}`);
        const ub = await req("POST", `${B}/__api/tasks?backend=openclaw&id=${encodeURIComponent(id)}&action=unblock`);
        ok(ub.status === 200, `openclaw unblock -> ${ub.status}`);
        const ar = await req("POST", `${B}/__api/tasks?backend=openclaw&id=${encodeURIComponent(id)}&action=archive`, { archived: true });
        ok(ar.status === 200, `openclaw archive -> ${ar.status}`);
        const d = await req("DELETE", `${B}/__api/tasks?backend=openclaw&id=${encodeURIComponent(id)}`);
        ok(d.status === 200, `openclaw delete -> ${d.status}`);
      }
      // 注：workboard dispatch（提醒调度器）有真实副作用（promote/启动 ready 卡），
      // 与 Hermes nudge 不同没有 dryRun 参数 → 不进 smoke。
    } catch (e) { ok(false, `openclaw tasks: ${e.message}`); }
    // Hermes = kanban plugin (create→update→move→archive→delete, real cards)
    try {
      const board = await req("GET", `${B}/__api/tasks?backend=hermes`);
      const cols = board.json.board?.columns || [];
      const caps = board.json.board?.capabilities || {};
      ok(board.status === 200 && caps.kind === "hermes" && caps.drag && caps.archive,
        `hermes board -> ${cols.length} cols, caps.kind=${caps.kind} drag=${!!caps.drag} archive=${!!caps.archive}`);
      const c = await req("POST", `${B}/__api/tasks?backend=hermes`, { title: "[smoke] task", body: "smoke body", column: cols[0]?.id });
      const id = c.json.task?.id;
      ok(c.status === 200 && id, `hermes create -> ${id || JSON.stringify(c.json).slice(0,80)}`);
      if (id) {
        const u = await req("PUT", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}`, { title: "[smoke] task2", body: "edited" });
        ok(u.status === 200, `hermes update -> ${u.status}`);
        const moveTo = cols[1]?.id || "in_progress";
        const mv = await req("POST", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}&action=move`, { status: moveTo, position: 0 });
        ok(mv.status === 200 && mv.json.task?.column === moveTo, `hermes move -> ${mv.json.task?.column}`);
        // R64: 批量更新（后端扇出复用单任务端点）。建第 2 张卡，bulk 归档两张（顺带清理 id2）。
        const c2 = await req("POST", `${B}/__api/tasks?backend=hermes`, { title: "[smoke] task-bulk", body: "x", column: cols[0]?.id });
        const bulkIds = [id, c2.json.task?.id].filter(Boolean);
        const bk = await req("POST", `${B}/__api/tasks?backend=hermes&action=bulk`, { ids: bulkIds, patch: { archive: true } });
        ok(bk.status === 200 && bk.json.result?.failed === 0 && bk.json.result?.total === bulkIds.length,
          `hermes bulk archive ${bulkIds.length} -> total=${bk.json.result?.total} failed=${bk.json.result?.failed}`);
        // bulk archive(true) 已把 id 与 id2 都归档（Hermes 无硬删除，即清理），无需再单独 cleanup。
      }
    } catch (e) { ok(false, `hermes tasks: ${e.message}`); }
  }

  if (WHICH === "kanban" || WHICH === "all") {
    log("--- HERMES KANBAN (comments/runs/diagnostics) ---");
    try {
      const board = await req("GET", `${B}/__api/tasks?backend=hermes`);
      const brd = board.json.board || {};
      const cols = brd.columns || [];
      ok(brd.capabilities?.kind === "hermes" && Array.isArray(brd.tenants) && Array.isArray(brd.assignees),
        `board enriched -> kind=${brd.capabilities?.kind} tenants=${(brd.tenants||[]).length} assignees=${(brd.assignees||[]).length}`);
      const c = await req("POST", `${B}/__api/tasks?backend=hermes`, { title: "[smoke] kanban", body: "x", column: cols[0]?.id, tenant: "smoke-tenant" });
      const id = c.json.task?.id;
      ok(!!id, `create -> ${id}`);
      if (id) {
        const cm = await req("POST", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}&action=comment`, { body: "[smoke] hi" });
        ok(cm.status === 200, `add comment -> ${cm.status}`);
        const det = await req("GET", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}`);
        const t = det.json.task || {};
        ok(det.status === 200 && Array.isArray(t.comments) && Array.isArray(t.runs) && Array.isArray(t.diagnostics),
          `detail comments(${(t.comments||[]).length})/runs(${(t.runs||[]).length})/diag(${(t.diagnostics||[]).length}); comment present=${(t.comments||[]).some(x=>(x.body||'').includes('[smoke]'))}`);
        ok(t.tenant === "smoke-tenant", `create extras -> tenant=${t.tenant} skills=${JSON.stringify(t.skills)} goal=${t.goalMode}`);
        const b2 = await req("GET", `${B}/__api/tasks?backend=hermes`);
        const found = (b2.json.board?.columns || []).flatMap((c2) => c2.tasks || []).find((x) => x.id === id);
        ok(found && typeof found.createdAt === "number",
          `card enriched -> createdAt=${found?.createdAt} comments=${found?.commentCount ?? "-"} links=${found?.linkCount ? found.linkCount.parents + found.linkCount.children : "-"}`);
        // Drawer extras (Slice 6): reassign / worker log / link+unlink a 2nd card — while id is still active.
        const who = (brd.assignees || [])[0];
        if (who) {
          const rs = await req("POST", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}&action=reassign`, { assignee: who });
          ok(rs.status === 200, `reassign -> ${rs.status} (@${who})`);
        }
        // worker log 是结构体（content/exists/size_bytes/truncated/path），不是裸串——
        // 旧实现读不存在的 j.log、兜底把整个 JSON 回吐给抽屉 <pre>。
        const lg = await req("GET", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}&action=log`);
        ok(lg.status === 200 && lg.json.log && typeof lg.json.log.content === "string" && typeof lg.json.log.exists === "boolean",
          `worker log -> ${lg.status} exists=${lg.json.log?.exists} len=${(lg.json.log?.content || "").length}`);
        const c2 = await req("POST", `${B}/__api/tasks?backend=hermes`, { title: "[smoke] dep child", body: "x" });
        const id2 = c2.json.task?.id;
        if (id2) {
          const lk = await req("POST", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}&action=link`, { parent: id, child: id2 });
          ok(lk.status === 200, `link add -> ${lk.status}`);
          const det2 = await req("GET", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}`);
          ok((det2.json.task?.linkIds?.children || []).includes(id2), `link visible -> children=${JSON.stringify(det2.json.task?.linkIds?.children || [])}`);
          const ul = await req("POST", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}&action=unlink`, { parent: id, child: id2 });
          ok(ul.status === 200, `link remove -> ${ul.status}`);
          // 官方 POST /tasks/bulk（早期版本没有，旧实现是 N 次扇出）：一次请求、
          // per-id 成败。混一个不存在的 id 进去，验证「一坏不拖垮整批」+ failedIds。
          const bulk = await req("POST", `${B}/__api/tasks?backend=hermes&action=bulk`,
            { ids: [id, id2, "t_zzzz_nonexistent"], patch: { priority: 3 } });
          ok(bulk.status === 200 && bulk.json.result?.total === 3 && bulk.json.result?.failed === 1
            && (bulk.json.result?.failedIds || []).includes("t_zzzz_nonexistent"),
            `bulk priority -> total=${bulk.json.result?.total} failed=${bulk.json.result?.failed} failedIds=${JSON.stringify(bulk.json.result?.failedIds)}`);
          // 批量永久删除（垃圾桶 / BulkActionBar 的 Delete）——顺带清掉 id2。
          const bdel = await req("POST", `${B}/__api/tasks?backend=hermes&action=bulkDelete`, { ids: [id2] });
          ok(bdel.status === 200 && bdel.json.result?.failed === 0, `bulk delete -> total=${bdel.json.result?.total} failed=${bdel.json.result?.failed}`);
        }
        // 附件全链路：上传原始字节 → 列表可见 → 下载原样回来 → 删除。
        const attBody = Buffer.from("hello shoggoth attachment\n");
        const attUp = await req("POST",
          `${B}/__api/tasks/attachments?backend=hermes&id=${encodeURIComponent(id)}&filename=smoke.txt&contentType=text%2Fplain`,
          attBody, { raw: true });
        ok(attUp.status === 200 && attUp.json.attachment?.id, `attachment upload -> ${attUp.json.attachment?.filename} #${attUp.json.attachment?.id}`);
        const attId = attUp.json.attachment?.id;
        if (attId) {
          const attList = await req("GET", `${B}/__api/tasks/attachments?backend=hermes&id=${encodeURIComponent(id)}`);
          ok(attList.status === 200 && (attList.json.attachments || []).some((a) => String(a.id) === String(attId)),
            `attachment list -> ${(attList.json.attachments || []).length}`);
          const attDl = await req("GET", `${B}/__api/tasks/attachments/${encodeURIComponent(attId)}?backend=hermes`, null, { rawResponse: true });
          ok(attDl.status === 200 && attDl.text === attBody.toString(), `attachment download -> ${attDl.status} bytes=${(attDl.text || "").length}`);
          const attDel = await req("DELETE", `${B}/__api/tasks/attachments/${encodeURIComponent(attId)}?backend=hermes`);
          ok(attDel.status === 200, `attachment delete -> ${attDel.status}`);
        }
        // Home 频道订阅：列出已配置 home 的平台；有则对本卡订阅→退订往返（卡稍后被删）。
        const hc = await req("GET", `${B}/__api/tasks/home-channels?backend=hermes&id=${encodeURIComponent(id)}`);
        ok(hc.status === 200 && Array.isArray(hc.json.channels), `home channels -> ${(hc.json.channels || []).length}`);
        const plat = (hc.json.channels || [])[0]?.platform;
        if (plat) {
          const sub = await req("POST", `${B}/__api/tasks/home-channels?backend=hermes&id=${encodeURIComponent(id)}&platform=${encodeURIComponent(plat)}`);
          const hc2 = await req("GET", `${B}/__api/tasks/home-channels?backend=hermes&id=${encodeURIComponent(id)}`);
          const on = (hc2.json.channels || []).find((c3) => c3.platform === plat)?.subscribed;
          const unsub = await req("DELETE", `${B}/__api/tasks/home-channels?backend=hermes&id=${encodeURIComponent(id)}&platform=${encodeURIComponent(plat)}`);
          ok(sub.status === 200 && on === true && unsub.status === 200, `home subscribe round-trip (${plat}) -> on=${on}`);
        }
        // R135 起归档与真删除分离：archive 走 action=archive，DELETE 是官方硬删除。
        const ar = await req("POST", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}&action=archive`, { archived: true });
        ok(ar.status === 200, `archive -> ${ar.status}`);
        const arch = await req("GET", `${B}/__api/tasks?backend=hermes&archived=1`);
        const archCol = (arch.json.board?.columns || []).find((c2) => c2.id === "archived");
        ok(arch.status === 200 && !!archCol && (archCol.tasks || []).some((x) => x.id === id),
          `archived filter -> col=${!!archCol} hasCard=${archCol ? (archCol.tasks || []).some((x) => x.id === id) : false}`);
        const d = await req("DELETE", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}`);
        ok(d.status === 200, `hard delete -> ${d.status}`);
        const gone = await req("GET", `${B}/__api/tasks?backend=hermes&id=${encodeURIComponent(id)}`);
        ok(gone.status !== 200 || !gone.json.task, `hard delete verified gone -> ${gone.status}`);
        // Nudge dispatcher: dry-run only (never spawn real workers in smoke).
        const nd = await req("POST", `${B}/__api/tasks?backend=hermes&action=dispatch`, { dryRun: true, max: 1 });
        ok(nd.status === 200 && typeof nd.json.result?.spawned === "number",
          `dispatch dry-run -> claimed=${nd.json.result?.claimed} spawned=${nd.json.result?.spawned}`);
        // Multi-board: create throwaway (no switch) → list includes it → switch → restore default → delete.
        const bslug = "smoke-board-" + Math.random().toString(36).slice(2, 8);
        const cb = await req("POST", `${B}/__api/tasks/boards?backend=hermes`, { slug: bslug, name: "[smoke] board", switch: false });
        ok(cb.status === 200 && cb.json.board?.slug === bslug, `board create -> ${cb.json.board?.slug}`);
        const lb = await req("GET", `${B}/__api/tasks/boards?backend=hermes`);
        ok(lb.status === 200 && (lb.json.boards || []).some((b) => b.slug === bslug), `board list incl -> ${(lb.json.boards || []).length}`);
        const sw = await req("POST", `${B}/__api/tasks/boards/${bslug}/switch?backend=hermes`);
        ok(sw.status === 200, `board switch -> ${sw.status}`);
        await req("POST", `${B}/__api/tasks/boards/default/switch?backend=hermes`); // restore current
        // 板设置（名/描述/项目目录）——只改这块一次性的临时板，随后删掉。
        const pb = await req("PATCH", `${B}/__api/tasks/boards/${bslug}?backend=hermes`,
          { name: "[smoke] renamed", description: "smoke desc", defaultWorkdir: "" });
        const lb2 = await req("GET", `${B}/__api/tasks/boards?backend=hermes`);
        const renamed = (lb2.json.boards || []).find((b) => b.slug === bslug);
        ok(pb.status === 200 && renamed?.name === "[smoke] renamed", `board settings patch -> ${renamed?.name}`);
        const dbd = await req("DELETE", `${B}/__api/tasks/boards/${bslug}?backend=hermes`);
        ok(dbd.status === 200, `board delete (cleanup) -> ${dbd.status}`);
        // 看板前端偏好（官方 lane_by_profile 默认 true——UI 的默认分泳道来源）。
        const kcfg = await req("GET", `${B}/__api/tasks/config?backend=hermes`);
        ok(kcfg.status === 200 && typeof kcfg.json.config?.laneByProfile === "boolean",
          `board config -> lanes=${kcfg.json.config?.laneByProfile} archived=${kcfg.json.config?.includeArchivedByDefault} md=${kcfg.json.config?.renderMarkdown}`);
        // 任务级模型覆盖的候选目录（空 providers 也算通过：UI 会退化成自由文本）。
        const mopt = await req("GET", `${B}/__api/tasks/model-options?backend=hermes`);
        ok(mopt.status === 200 && Array.isArray(mopt.json.options?.providers),
          `task model options -> providers=${(mopt.json.options?.providers || []).length}`);
        // 编排 profile 名单 + 描述写回（原值 no-op，绝不改用户配置；⚗ 自动生成是
        // LLM 调用，故意不跑）。
        const profs = await req("GET", `${B}/__api/tasks/profiles?backend=hermes`);
        const prof0 = (profs.json.profiles || [])[0];
        ok(profs.status === 200 && Array.isArray(profs.json.profiles),
          `board profiles -> ${(profs.json.profiles || []).length}`);
        if (prof0) {
          const pp = await req("PATCH", `${B}/__api/tasks/profiles/${encodeURIComponent(prof0.name)}?backend=hermes`,
            { description: prof0.description || "" });
          ok(pp.status === 200, `profile description no-op (${prof0.name}) -> ${pp.status}`);
        }
        // Orchestration: GET, then a NO-OP PUT (write current values back — never changes config.yaml).
        const og = await req("GET", `${B}/__api/tasks/orchestration?backend=hermes`);
        const orch = og.json.orchestration || {};
        ok(og.status === 200 && typeof orch.autoDecompose === "boolean", `orchestration get -> auto=${orch.autoDecompose} promote=${orch.autoPromoteChildren}`);
        const op = await req("PUT", `${B}/__api/tasks/orchestration?backend=hermes`, { autoDecompose: orch.autoDecompose, autoPromoteChildren: orch.autoPromoteChildren });
        ok(op.status === 200, `orchestration put no-op -> ${op.status}`);
        // Kanban events WS broker (Slice 9): connect to /__kanbanws; expect it to OPEN
        // and stay open (upstream Hermes dashboard accepted the token = relay works).
        const WS = require("ws");
        await new Promise((resolve) => {
          const wsk = new WS(`${B.replace(/^http/, "ws")}/__kanbanws`, { origin: B });
          let opened = false, closedEarly = false;
          const to = setTimeout(() => {
            ok(opened && !closedEarly, `kanban events WS -> open=${opened} closedEarly=${closedEarly}`);
            try { wsk.close(); } catch { /* ignore */ }
            resolve();
          }, 2500);
          wsk.on("open", () => { opened = true; });
          wsk.on("close", () => { if (opened) closedEarly = true; });
          wsk.on("error", () => { clearTimeout(to); ok(false, `kanban events WS error`); resolve(); });
        });
      }
    } catch (e) { ok(false, `kanban: ${e.message}`); }
  }

  if (WHICH === "skills" || WHICH === "all") {
    log("--- SKILLS ---");
    for (const backend of ["openclaw", "hermes"]) {
      try {
        const list = await req("GET", `${B}/__api/skills?backend=${backend}`);
        const skills = list.json.skills || [];
        ok(list.status === 200, `${backend} skills -> ${skills.length}`);
        const s = skills[0];
        if (s) {
          // idempotent no-op toggle (sets enabled to its CURRENT value) — verifies
          // the PUT route + backend without changing the user's config.
          const u = await req("PUT", `${B}/__api/skills?backend=${backend}&name=${encodeURIComponent(s.name)}`, { enabled: s.enabled });
          ok(u.status === 200, `${backend} toggle no-op (${s.name}) -> ${u.status}`);
        }
      } catch (e) { ok(false, `${backend} skills: ${e.message}`); }
    }
    // 使用次数叠加层（R359）：与 cli/usage 同形，读本机 JSONL，无需网关在线。
    try {
      const u = await req("GET", `${B}/__api/skills/usage`);
      const backends = u.json?.backends;
      ok(u.status === 200 && Array.isArray(backends),
        `skills/usage -> ${Array.isArray(backends) ? backends.length + " backends" : JSON.stringify(u.json)}`);
      for (const id of ["openclaw", "hermes"]) {
        const row = Array.isArray(backends) ? backends.find((b) => b.backend === id) : null;
        const map = row?.skills || {};
        const sample = Object.values(map)[0];
        // skills[name] 必须是 { agentId: count }（per-agent 拆分），不是裸数字。
        const nested = sample === undefined || (typeof sample === "object" && sample !== null && !Array.isArray(sample)
          && Object.values(sample).every((n) => typeof n === "number"));
        ok(row && typeof row.supported === "boolean" && typeof map === "object" && nested,
          `${id} skill usage shape -> supported=${row?.supported}, ${Object.keys(map).length} skills, reason=${row?.reason || "-"}`);
      }
    } catch (e) { ok(false, `skills/usage threw: ${e.message}`); }
  }

  if (WHICH === "models" || WHICH === "all") {
    log("--- MODELS ---");
    for (const backend of ["openclaw", "hermes"]) {
      try {
        const list = await req("GET", `${B}/__api/models?backend=${backend}`);
        ok(list.status === 200, `${backend} models -> ${(list.json.models||[]).length}`);
        const act = await req("GET", `${B}/__api/models/active?backend=${backend}`);
        ok(act.status === 200, `${backend} active -> ${JSON.stringify(act.json).slice(0,80)}`);
      } catch (e) { ok(false, `${backend} models: ${e.message}`); }
    }
    // auxiliary model slots: Hermes returns task slots, OpenClaw returns empty.
    try {
      const ax = await req("GET", `${B}/__api/models/auxiliary?backend=hermes`);
      const slots = ax.json.slots || [];
      ok(ax.status === 200 && slots.length > 0, `hermes auxiliary -> ${slots.length} slots, main=${ax.json.main?.model || "?"}`);
      const oc = await req("GET", `${B}/__api/models/auxiliary?backend=openclaw`);
      ok(oc.status === 200 && (oc.json.slots || []).length === 0, `openclaw auxiliary -> empty (${(oc.json.slots || []).length})`);
    } catch (e) { ok(false, `auxiliary: ${e.message}`); }
    // 模型设置整合面（R286，只读断言）：Hermes 聚合快照带目录（含未配置 provider）
    // 与辅助/默认段；OpenClaw settings 契约仍为 supported:false，但自定义端点已提供
    // 只读 config 投影，写入继续走 ModelChangeCoordinator。
    try {
      const st = await req("GET", `${B}/__api/models/settings?backend=hermes`);
      const providers = st.json.providers || [];
      const unconfigured = providers.filter((p) => p.authenticated === false).length;
      ok(
        st.status === 200 && st.json.supported === true && providers.length > 0,
        `hermes settings -> profile=${st.json.profile} providers=${providers.length} (unconfigured=${unconfigured}) main=${st.json.main?.provider || "?"}/${st.json.main?.model || "?"}`,
      );
      ok(
        Array.isArray(st.json.auxiliary?.slots) && st.json.defaults && typeof st.json.defaults.reasoningEffort === "string",
        `hermes settings sections -> aux=${(st.json.auxiliary?.slots || []).length} effort="${st.json.defaults?.reasoningEffort}" tier="${st.json.defaults?.serviceTier}" moa=${st.json.moa ? "yes" : "null"} fallbacks=${(st.json.fallbacks || []).length}`,
      );
      const stOc = await req("GET", `${B}/__api/models/settings?backend=openclaw`);
      ok(stOc.status === 200 && stOc.json.supported === false, "openclaw settings -> supported:false");
      const rec = await req("GET", `${B}/__api/models/settings/recommended?backend=hermes&provider=nous`);
      ok(rec.status === 200 && typeof rec.json.model === "string", `hermes recommended(nous) -> "${rec.json.model}"`);
      const ep = await req("GET", `${B}/__api/models/endpoints?backend=hermes`);
      ok(
        ep.status === 200 && Array.isArray(ep.json.endpoints),
        `hermes endpoints -> supported=${ep.json.supported} count=${ep.json.endpoints.length}`,
      );
      const epOc = await req("GET", `${B}/__api/models/endpoints?backend=openclaw`);
      ok(
        epOc.status === 200
          && epOc.json.supported === true
          && Array.isArray(epOc.json.endpoints)
          && epOc.json.form?.nameEditable === false
          && epOc.json.form?.firstModelIsDefault === false,
        `openclaw endpoints -> supported=${epOc.json.supported} count=${(epOc.json.endpoints || []).length}`,
      );
      const badProfile = await req("GET", `${B}/__api/models/settings?backend=hermes&profile=shoggoth-no-such-profile`);
      ok(badProfile.status === 200 && badProfile.json.supported === false, "hermes settings unknown profile -> supported:false");
      // perAgentModelSettings（R300）：模型页据它决定形态——true = 本页只承载跨 agent
      // 的凭证层（per-agent 的主模型等归「代理」页概览），falsy = 目录网格。
      // 读的是 adapter 覆盖前抓的真实值（见 main() 里的 realPerAgentModelSettings）；
      // 走 HTTP 会拿到 smoke 替身的固定返回，断言不到真实现。
      // 它必须是**静态位**：Hermes 即使条件写探测失败（supported:false）也得为 true，
      // 否则一次 provider 读取失败会把页面形态整个翻转。
      ok(
        realPerAgentModelSettings.hermes === true,
        `hermes capabilities -> perAgentModelSettings=${realPerAgentModelSettings.hermes}`,
      );
      ok(
        !realPerAgentModelSettings.openclaw,
        `openclaw capabilities -> perAgentModelSettings=${realPerAgentModelSettings.openclaw ?? "absent"}`,
      );
      // 路由确实原样透传该字段（替身也是同一条路径，只验证不被 registry 层吃掉）。
      const capRoute = await req("GET", `${B}/__api/models/config/capabilities?backend=hermes`);
      ok(capRoute.status === 200 && typeof capRoute.json.supported === "boolean",
        `capabilities route -> 200 supported=${capRoute.json.supported}`);
    } catch (e) { ok(false, `model settings: ${e.message}`); }
    // custom model config CRUD：加一个无害假 provider（本机死端口，永不真调用、
    // 不烧 token）→ 可见 → 删除 → 消失。Hermes 写后 dashboard 可能 reconfigure，
    // 读走一次 1s 重试。finally 兜底清理。
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const readCfg = async (backend) => {
      let r = await req("GET", `${B}/__api/models/config?backend=${backend}`);
      if (r.status !== 200 || !Array.isArray(r.json.providers)) { await settle(1000); r = await req("GET", `${B}/__api/models/config?backend=${backend}`); }
      return r;
    };
    // OpenClaw gateway 对 config.patch 有控制面写预算（≈40s/次）；两连写会 500
    // "rate limit exceeded ... retry after Ns" → 按提示等待后重试一次。
    const writeCfg = async (method, url, body) => {
      let r = await req(method, url, body);
      const msg = r.json && r.json.error ? String(r.json.error) : "";
      const m = msg.match(/retry after (\d+)s/i);
      if (r.status === 500 && m) {
        await settle(Math.min(Number(m[1]) + 2, 70) * 1000);
        r = await req(method, url, body);
      }
      return r;
    };
    for (const backend of ["openclaw", "hermes"]) {
      const P = "shoggoth-smoke";
      const MID = "smoke-model-1";
      try {
        const beforeCatalog = await req("GET", `${B}/__api/models?backend=${backend}`);
        const changeSpec = {
          providerKey: P,
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "smoke-key",
          model: { id: MID, name: "Smoke Model", contextWindow: 8000 },
        };
        const preview = await req("POST", `${B}/__api/models/config/preview?backend=${backend}`, changeSpec);
        ok(preview.status === 200 && typeof preview.json.previewToken === "string",
          `${backend} model-config preview -> ${preview.status}`);
        const add = await writeCfg("PUT", `${B}/__api/models/config/model?backend=${backend}`, {
          ...changeSpec,
          previewToken: preview.json.previewToken,
          operationId: `smoke-${backend}-preview-apply`,
        });
        ok(add.status === 200 && add.json.status === "applied" && add.json.catalog?.catalogRevision,
          `${backend} model-config preview→apply -> ${add.status}/${add.json.status}`);
        ok(add.json.catalog?.catalogRevision !== beforeCatalog.json.catalogRevision,
          `${backend} applied revision changed and returned immediately`);
        await settle(backend === "hermes" ? 1000 : 200);
        const cfg = await readCfg(backend);
        const prov = (cfg.json.providers || []).find((p) => p.key === P);
        ok(!!prov && prov.models.some((mm) => mm.id === MID), `${backend} model-config visible -> ${prov ? prov.models.length : 0} models`);
        // PUT：改 provider 端点字段（baseUrl），读回验证
        const upd = await writeCfg("PUT", `${B}/__api/models/config?backend=${backend}`, {
          providerKey: P,
          baseUrl: "http://127.0.0.1:9/v2",
        });
        ok(upd.status === 200, `${backend} provider update -> ${upd.status}${upd.json?.error ? ` ${upd.json.error}` : ""}`);
        await settle(backend === "hermes" ? 1000 : 200);
        const cfg1 = await readCfg(backend);
        const prov1 = (cfg1.json.providers || []).find((p) => p.key === P);
        ok(!!prov1 && prov1.baseUrl === "http://127.0.0.1:9/v2", `${backend} provider baseUrl updated -> ${prov1 ? prov1.baseUrl : "?"}`);
        // reveal：loopback HTTP 不是权限边界，明文只允许受信 Electron preload IPC。
        const rev = await req("POST", `${B}/__api/models/config/reveal?backend=${backend}`, { providerKey: P });
        ok(rev.status === 403 && rev.json.code === "DESKTOP_BRIDGE_REQUIRED"
          && !Object.hasOwn(rev.json, "apiKey"),
        `${backend} provider key HTTP reveal blocked -> ${rev.status}/${rev.json.code || "?"}`);
        // 删整个 provider（DELETE 不带 id）——假 provider，不碰真实条目
        const delProv = await writeCfg("DELETE", `${B}/__api/models/config?backend=${backend}&provider=${encodeURIComponent(P)}`);
        ok(delProv.status === 200 && delProv.json.status === "applied",
          `${backend} provider delete -> ${delProv.status}/${delProv.json.status} (${delProv.json.code || "ok"})`);
        await settle(backend === "hermes" ? 1000 : 200);
        const cfgP = await readCfg(backend);
        const remainingProvider = (cfgP.json.providers || []).find((p) => p.key === P);
        ok(!remainingProvider, `${backend} provider gone after provider-delete${remainingProvider ? ` (source=${remainingProvider.source}, models=${remainingProvider.models?.length})` : ""}`);
        // 再建一次，验证删单个模型的路径（DELETE 带 id）仍然工作
        const add2 = await writeCfg("POST", `${B}/__api/models/config?backend=${backend}`, {
          providerKey: P, baseUrl: "http://127.0.0.1:9/v1", apiKey: "smoke-key",
          model: { id: MID, name: "Smoke Model", contextWindow: 8000 },
        });
        ok(add2.status === 200, `${backend} model-config re-add -> ${add2.status}`);
        await settle(backend === "hermes" ? 1000 : 200);
        const del = await writeCfg("DELETE", `${B}/__api/models/config?backend=${backend}&provider=${encodeURIComponent(P)}&id=${encodeURIComponent(MID)}`);
        ok(del.status === 200 && del.json.status === "applied",
          `${backend} model-config delete -> ${del.status}/${del.json.status} (${del.json.code || "ok"})`);
        await settle(backend === "hermes" ? 1000 : 200);
        const cfg2 = await readCfg(backend);
        const remainingModelProvider = (cfg2.json.providers || []).find((p) => p.key === P);
        ok(!remainingModelProvider, `${backend} model-config gone${remainingModelProvider ? ` (source=${remainingModelProvider.source}, models=${remainingModelProvider.models?.length})` : ""}`);
      } catch (e) {
        ok(false, `${backend} model-config: ${e.message}`);
      } finally {
        await writeCfg("DELETE", `${B}/__api/models/config?backend=${backend}&provider=${encodeURIComponent(P)}&id=${encodeURIComponent(MID)}`).catch(() => {});
      }
    }
    // provider 分类：OpenClaw 全是配置文件条目；Hermes 还有一批凭证在 .env 的
    // 内置目录 provider（只读断言，不碰真实 key）。
    try {
      const oc = await req("GET", `${B}/__api/models/config?backend=openclaw`);
      const ocp = oc.json.providers || [];
      // config 条目 + auth 合成条目(内置 provider 凭证型,R181)都可编辑;
      // auth 条目端点由网关内置,models 恒空
      ok(ocp.length > 0 && ocp.every((p) => ["config", "auth"].includes(p.source) && p.editable),
        `openclaw providers all source config/auth -> ${ocp.length}`);
      ok(ocp.filter((p) => p.source === "auth").every((p) => p.hasApiKey && p.models.length === 0),
        "openclaw auth-source providers are key-only");
      const hm = await req("GET", `${B}/__api/models/config?backend=hermes`);
      const hmp = hm.json.providers || [];
      const envP = hmp.filter((p) => p.source === "env");
      const cfgP = hmp.filter((p) => p.source === "config");
      // env 类 provider：目录由上游给（models 恒空），凭证要么在环境变量里，
      // 要么只在凭证池里（copilot=gh_cli / openai-codex=oauth）。
      ok(envP.length > 0 && envP.every((p) => p.models.length === 0 && (p.keyEnv || p.baseUrlEnv || p.poolCount > 0)),
        `hermes env providers -> ${envP.length} (config: ${cfgP.length})`);
    } catch (e) { ok(false, `provider source split: ${e.message}`); }
    // 凭证池（Hermes credential_pool）：只读断言——绝不删真实轮换 key。
    try {
      const hm = await req("GET", `${B}/__api/models/config?backend=hermes`);
      const pooled = (hm.json.providers || []).filter((p) => (p.poolCount || 0) > 0);
      ok(pooled.length > 0, `hermes providers with pooled creds -> ${pooled.length}`);
      const probe = pooled[0];
      const list = await req("GET", `${B}/__api/models/credentials?backend=hermes&provider=${encodeURIComponent(probe.key)}`);
      const entries = list.json.entries || [];
      ok(list.status === 200 && entries.length === probe.poolCount && entries.every((e) => e.index >= 1 && typeof e.source === "string"),
        `hermes pool list (${probe.key}) -> ${entries.length} entries, 1-based index + source`);
      // 池条目不回明文 key（只给 token_preview 脱敏串）
      ok(entries.every((e) => !("accessToken" in e) && !("access_token" in e)),
        `hermes pool entries carry no raw token`);
      const oc = await req("GET", `${B}/__api/models/credentials?backend=openclaw&provider=modelscope`);
      ok(oc.status === 200 && (oc.json.entries || []).length === 0, `openclaw pool -> empty (no pool concept)`);
    } catch (e) { ok(false, `credential pool: ${e.message}`); }
    // env / API keys (Hermes-only); list is redacted. Don't test set/delete/reveal (mutates real keys).
    try {
      const ev = await req("GET", `${B}/__api/env?backend=hermes`);
      const vars = ev.json.vars || [];
      const providerKeys = vars.filter((v) => v.category === "provider");
      ok(ev.status === 200 && vars.length > 0 && providerKeys.length > 0, `hermes env -> ${vars.length} vars (${providerKeys.length} provider keys)`);
      // 密钥面板按这三个字段分区（工具 chip / 渠道页归属 / 自定义键），丢了就整段塌
      ok(vars.some((v) => Array.isArray(v.tools)) && vars.some((v) => "channelManaged" in v && "custom" in v),
        `hermes env rows carry tools/channelManaged/custom`);
      // R356 起 OpenClaw 实现 env 四方法（config env.vars 段 = 工具密钥卡）：
      // 行全部 category:"tool"，isSet 恒真（config 里有键即已设）。数量随用户配置走，
      // 只断形状不断条数（为空也合法）。
      const oce = await req("GET", `${B}/__api/env?backend=openclaw`);
      const ocVars = oce.json.vars || [];
      ok(oce.status === 200 && ocVars.every((v) => v.category === "tool" && v.isSet === true),
        `openclaw env -> ${ocVars.length} tool vars (all category:tool)`);
    } catch (e) { ok(false, `env: ${e.message}`); }
    // OAuth provider 登录（Hermes-only）。只读列表 + 取消一个不存在的会话；
    // 不真跑 start/submit（会开浏览器并动真凭证）。
    try {
      const oa = await req("GET", `${B}/__api/oauth?backend=hermes`);
      const provs = oa.json.providers || [];
      const shaped = provs.every((p) => p.id && p.flow && p.status && Array.isArray(p.connectedProfiles));
      ok(oa.status === 200 && provs.length > 0 && shaped && (oa.json.profiles || []).length > 0,
        `hermes oauth -> ${provs.length} providers / ${(oa.json.profiles || []).length} profiles`);
      const cancel = await req("POST", `${B}/__api/oauth/cancel?backend=hermes`, { sessionId: "smoke-not-a-session" });
      ok(cancel.status === 200 && cancel.json.ok === false, `hermes oauth cancel unknown session -> ok:false`);
      // OpenClaw 侧（快照 + models.authStatus 拼装）：全部 external 流、可断开、
      // 不发真登录（列表本身只读；start/submit/poll 对 openclaw 是契约默认 throw）。
      const oco = await req("GET", `${B}/__api/oauth?backend=openclaw`);
      const ocProvs = oco.json.providers || [];
      ok(oco.status === 200 && ocProvs.length >= 6
        && ocProvs.every((p) => p.flow === "external" && p.disconnectable && p.cliCommand)
        && ocProvs.some((p) => p.id === "anthropic"),
        `openclaw oauth -> ${ocProvs.length} providers, all external (has anthropic)`);

      // OpenClaw provider 目录（快照∪config∪auth 三源合并）：规模 + 获取密钥覆盖 +
      // 已配置至少一家（本机必有 config provider）。纯只读。
      const dir = await req("GET", `${B}/__api/models/provider-directory?backend=openclaw`);
      const dirProvs = dir.json.providers || [];
      ok(dir.status === 200 && dir.json.supported === true && dirProvs.length >= 31
        && dirProvs.filter((p) => p.getKeyUrl).length >= 20
        && dirProvs.some((p) => p.configured)
        && dirProvs.every((p) => p.id && p.label && p.baseUrl && p.key && typeof p.inConfig === "boolean"),
        `openclaw provider-directory -> ${dirProvs.length} providers (${dirProvs.filter((p) => p.configured).length} configured)`);
      const dirHermes = await req("GET", `${B}/__api/models/provider-directory?backend=hermes`);
      ok(dirHermes.status === 200 && dirHermes.json.supported === false,
        `hermes provider-directory -> supported:false (contract default)`);

      // /__api/host/terminal 的白名单闸门。`/__api` 是无鉴权 loopback 面，本机任何
      // 进程都能打它 → 这个口子**只认 {provider,kind}**，命令必须由服务端从上面那次
      // oauth 目录里解析出来。两条断言证明闸门在：目录里没有的 provider 一律 400；
      // 目录里有的解析得到命令（开发态没有 Electron hostOps → 501 且回吐 command，
      // 所以**不会真的拉起终端**，smoke 零副作用）。
      const noProv = await req("POST", `${B}/__api/host/terminal`, { backend: "hermes", kind: "cli" });
      ok(noProv.status === 400, `host/terminal missing provider -> ${noProv.status} (expect 400)`);
      const bogus = await req("POST", `${B}/__api/host/terminal`, { backend: "hermes", provider: "not-a-provider", kind: "cli" });
      ok(bogus.status === 400, `host/terminal unknown provider -> ${bogus.status} (expect 400, allowlist holds)`);
      const withCmd = provs.find((p) => p.cliCommand);
      if (withCmd) {
        const real = await req("POST", `${B}/__api/host/terminal`, { backend: "hermes", provider: withCmd.id, kind: "cli" });
        ok(real.status === 501 && real.json.command === withCmd.cliCommand,
          `host/terminal ${withCmd.id} -> 501 + resolved "${real.json.command}" (no Electron host in dev harness)`);
      }
      // 目录里的 provider 但那个 kind 没命令（多数 provider 没有 disconnectCommand）→ 也 400。
      const noDisc = provs.find((p) => !p.disconnectCommand);
      if (noDisc) {
        const r = await req("POST", `${B}/__api/host/terminal`, { backend: "hermes", provider: noDisc.id, kind: "disconnect" });
        ok(r.status === 400, `host/terminal ${noDisc.id} disconnect (no such command) -> ${r.status} (expect 400)`);
      }
    } catch (e) { ok(false, `oauth: ${e.message}`); }
  }

  if (WHICH === "usage" || WHICH === "all") {
    log("--- USAGE ---");
    for (const backend of ["openclaw", "hermes"]) {
      try {
        const series = await req("GET", `${B}/__api/usage?backend=${backend}&range=30d`);
        const breakdown = await req("GET", `${B}/__api/usage/breakdown?backend=${backend}&range=30d`);
        assertUsagePayload(backend, series, breakdown);
        // "today" 覆盖：OpenClaw 走 startDate/endDate（当天自然日），Hermes 走
        // days=1（最近 24h）。验证两后端接受该 range 且 series/breakdown 形状不破。
        const tSeries = await req("GET", `${B}/__api/usage?backend=${backend}&range=today`);
        const tBd = await req("GET", `${B}/__api/usage/breakdown?backend=${backend}&range=today`);
        ok(
          tSeries.status === 200 &&
            Array.isArray(tSeries.json.series?.daily) &&
            tBd.status === 200 &&
            Array.isArray(tBd.json.breakdown?.byModel),
          `${backend} usage range=today shape -> ${tSeries.status}/${tBd.status}`,
        );
        // Top 会话预览（R217）：有 top 行才打（真实环境可能空）；断言契约形状
        // { supported, messages[] }，supported=false（远程网关等）也是合法降级。
        const topRow = (breakdown.json.breakdown?.topSessions || []).find((s) => s && s.agentId && s.key);
        if (topRow) {
          const q = new URLSearchParams({ backend, agentId: topRow.agentId, key: topRow.key });
          if (topRow.sessionId) q.set("sid", topRow.sessionId);
          const pv = await req("GET", `${B}/__api/sessions/preview?${q.toString()}`);
          const p = pv.json.preview;
          ok(
            pv.status === 200 && p && typeof p.supported === "boolean" && Array.isArray(p.messages),
            `${backend} session preview shape -> ${pv.status} supported=${p?.supported} msgs=${p?.messages?.length ?? "?"}`,
          );
        } else {
          log(`${backend} session preview skipped (no top sessions)`);
        }
      } catch (e) {
        ok(false, `${backend} usage: ${e.message}`);
      }
    }
  }

  if (WHICH === "agents" || WHICH === "all") {
    log("--- AGENTS ---");
    for (const backend of ["openclaw", "hermes"]) {
      try {
        const list = await req("GET", `${B}/__api/agents?backend=${backend}`);
        const agents = list.json.agents || [];
        ok(list.status === 200, `${backend} agents -> ${agents.length}`);
        const sortedIds = sortAgentsByCreatedAt(agents).map((agent) => agent.id);
        ok(JSON.stringify(agents.map((agent) => agent.id)) === JSON.stringify(sortedIds),
          `${backend} agents ordered by createdAt -> ${agents.map((agent) => agent.id).join(",")}`);
        if (agents[0]) {
          const aid = agents[0].id;
          const det = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}?backend=${backend}`);
          const files = det.json.agent?.files || [];
          ok(det.status === 200 && det.json.agent, `${backend} agent detail -> ${det.json.agent?.name} files=${files.length}`);
          if (files[0]) {
            const f = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}/file?backend=${backend}&file=${encodeURIComponent(files[0].name)}`);
            ok(f.status === 200 && f.json.file, `${backend} file ${files[0].name} -> ${(f.json.file?.content||'').length} chars`);
          }
          const ch = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}/channels?backend=${backend}`);
          ok(ch.status === 200, `${backend} channels -> ${(ch.json.channels||[]).length}`);
          // Persistent Agent Harness 是 AgentBackend 契约的一部分；外部 backend
          // 明确投影 supported:false，证明 REST 层没有按 backend id 特判。
          const def = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}/definition?backend=${backend}`);
          const mem = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}/memories?backend=${backend}&cursor=0&limit=1`);
          const tx = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}/transcripts?backend=${backend}&cursor=0&limit=1`);
          const tools = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}/tools?backend=${backend}`);
          const retiredBrowser = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}/browser?backend=${backend}`);
          const computer = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}/computer?backend=${backend}`);
          ok(def.status === 200 && def.json.definition?.supported === false,
            `${backend} persistent definition -> supported:false`);
          ok(mem.status === 200 && mem.json.memories?.supported === false,
            `${backend} persistent memory -> supported:false`);
          ok(tx.status === 200 && tx.json.transcripts?.supported === false,
            `${backend} persistent transcripts -> supported:false`);
          ok(tools.status === 200 && tools.json.tools?.supported === false,
            `${backend} persistent tools -> supported:false`);
          ok(retiredBrowser.status === 404, `${backend} retired browser route -> 404`);
          ok(computer.status === 200 && computer.json.computer?.supported === false,
            `${backend} computer use -> supported:false`);
          // 模型降级链回写：原样写回同一组 {model, fallbacks}。后端对「已收敛」是
          // 零写（不发 config.patch，不触发网关热重载），所以 smoke 可以安全地跑真
          // agent —— 断言 200 且读回来一字不差。
          const fb = det.json.agent?.fallbacks;
          if (Array.isArray(fb) && fb.length) {
            const put = await req("PUT", `${B}/__api/agents/${encodeURIComponent(aid)}?backend=${backend}`,
              { model: det.json.agent.model, fallbacks: fb });
            const after = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}?backend=${backend}`);
            ok(put.status === 200 && JSON.stringify(after.json.agent?.fallbacks) === JSON.stringify(fb),
              `${backend} fallbacks round-trip (${fb.length}) -> ${put.status} unchanged=${JSON.stringify(after.json.agent?.fallbacks) === JSON.stringify(fb)}`);
          }
          // agent 页「文件」tab：该 agent 的产出文件（本地磁盘扫描，只读）。
          const art = await req("GET", `${B}/__api/agents/${encodeURIComponent(aid)}/artifacts?backend=${backend}`);
          const artBody = art.json.artifacts || {};
          ok(art.status === 200 && typeof artBody.supported === "boolean" && Array.isArray(artBody.items),
            `${backend} artifacts -> supported=${artBody.supported}${artBody.reason ? `(${artBody.reason})` : ""} ${(artBody.items || []).length} files`);
          // agent 页 Kanban tab：只读取板（readOnly=1 禁掉工作板的生命周期回写），
          // 前端再按 agentId / assignee 过滤出该 agent 的卡。
          const kb = await req("GET", `${B}/__api/tasks?backend=${backend}&readOnly=1`);
          const kcols = kb.json.board?.columns || [];
          ok(kb.status === 200 && Array.isArray(kcols),
            `${backend} board readOnly -> ${kcols.length} cols, ${kcols.reduce((s,c)=>s+(c.tasks?.length||0),0)} cards`);
        }
      } catch (e) { ok(false, `${backend} agents: ${e.message}`); }
    }
    // agent 页 workspace 行的「打开文件夹」：host 能力，不经 registry。这里只验路由
    // 契约（缺 path → 400），绝不真开目录。开发态无 Electron hostOps → 501。
    try {
      const bad = await req("POST", `${B}/__api/host/open-path`, {});
      ok(bad.status === 400, `host/open-path missing path -> ${bad.status} (expect 400)`);
      const badReveal = await req("POST", `${B}/__api/host/reveal-path`, {});
      ok(badReveal.status === 400, `host/reveal-path missing path -> ${badReveal.status} (expect 400)`);
    } catch (e) { ok(false, `host path actions: ${e.message}`); }
  }

  if (WHICH === "archive" || WHICH === "all") {
    log("--- ARCHIVE (sealed/reset session history) ---");
    try {
      // OpenClaw: discover an agent, probe its :main archive — assert CONTRACT shape
      // (count is machine-dependent: only agents reset by the gateway have segments).
      const list = await req("GET", `${B}/__api/agents?backend=openclaw`);
      const aid = (list.json.agents || [])[0]?.id;
      if (aid) {
        const key = `agent:${aid}:main`;
        const a = await req("GET", `${B}/__api/sessions/archive?backend=openclaw&agentId=${encodeURIComponent(aid)}&key=${encodeURIComponent(key)}`);
        const arc = a.json.archive;
        ok(a.status === 200 && typeof arc?.supported === "boolean" && Array.isArray(arc?.segments),
          `openclaw archive shape (${aid}) -> supported=${arc?.supported} segs=${arc?.segments?.length}`);
        const seg = arc?.segments?.[0];
        if (seg) ok(seg.sessionId && Array.isArray(seg.messages), `  segment -> ${String(seg.sessionId).slice(0, 8)} msgs=${seg.messages?.length} fromReset=${seg.fromReset}`);
      } else { log("  (no openclaw agents online — shape check skipped)"); }
      // missing params → 400
      const bad = await req("GET", `${B}/__api/sessions/archive?backend=openclaw`);
      ok(bad.status === 400, `archive missing params -> ${bad.status}`);
      // Hermes inherits the default → not supported
      if (hermesAgent) {
        const h = await req("GET", `${B}/__api/sessions/archive?backend=hermes&agentId=${encodeURIComponent(hermesAgent)}&key=${encodeURIComponent(`agent:${hermesAgent}:main`)}`);
        ok(h.status === 200 && h.json.archive?.supported === false, `hermes archive not-supported -> ${h.json.archive?.supported}`);
      }
    } catch (e) { ok(false, `archive: ${e.message}`); }
  }

  if (WHICH === "chatsearch" || WHICH === "all") {
    log("--- CHAT SEARCH (global, all agents) ---");
    try {
      // The registry fans out across all active backends and agents. Hit counts are machine data.
      const s = await req("GET", `${B}/__api/chat/search?q=${encodeURIComponent("的")}`);
      const sr = s.json.search;
      ok(s.status === 200
        && typeof sr?.searchedAgents === "number"
        && typeof sr?.unsupportedAgents === "number"
        && typeof sr?.failedAgents === "number"
        && typeof sr?.truncated === "boolean"
        && typeof sr?.offset === "number"
        && typeof sr?.hasMore === "boolean"
        && (!sr?.hasMore || typeof sr?.nextOffset === "number")
        && Array.isArray(sr?.results),
      `global search shape -> searched=${sr?.searchedAgents} unsupported=${sr?.unsupportedAgents} failed=${sr?.failedAgents} hits=${sr?.results?.length}`);
      const hit = sr?.results?.[0];
      if (hit) ok(
        typeof hit.backendId === "string"
          && typeof hit.agentId === "string"
          && typeof hit.agentName === "string"
          && typeof hit.key === "string"
          && typeof hit.snippet === "string",
        `  hit -> ${hit.backendId}/${hit.agentId} ${String(hit.key).slice(0, 28)}… "${String(hit.snippet).slice(0, 24)}…"`,
      );
      if (sr?.hasMore) {
        const next = await req("GET", `${B}/__api/chat/search?q=${encodeURIComponent("的")}&limit=10&offset=${sr.nextOffset}`);
        ok(next.status === 200
          && next.json.search?.offset === sr.nextOffset
          && Array.isArray(next.json.search?.results)
          && next.json.search.results.length > 0,
        `  next page -> offset=${next.json.search?.offset} hits=${next.json.search?.results?.length}`);
      }
      const bad = await req("GET", `${B}/__api/chat/search`);
      ok(bad.status === 400, `search missing q -> ${bad.status}`);
    } catch (e) { ok(false, `chatsearch: ${e.message}`); }
  }

  if (WHICH === "advanced" || WHICH === "all") {
    log("--- ENVIRONMENTS + ADVANCED SESSIONS (read-only) ---");
    try {
      const methodNames = [
        "environments.list",
        "sessions.describe",
        "sessions.branches.list",
        "sessions.fork",
      ];
      const boardMethodNames = [
        "board.get",
        "board.update",
        "board.widget.put",
        "board.widget.grant",
      ];
      const environmentResponse = await req("GET", `${B}/__api/environments?backend=openclaw`);
      const inventory = environmentResponse.json;
      const methodShape = methodNames.every((name) => typeof inventory?.methods?.[name] === "boolean")
        && Object.keys(inventory?.methods || {}).length === methodNames.length;
      const serialized = JSON.stringify(inventory);
      const sensitiveKeysAbsent = [
        "invocableCommands", "command", "leaseId", "attachedSessionIds", "recoveryError",
      ].every((key) => !serialized.includes(`\"${key}\"`));
      ok(
        environmentResponse.status === 200
          && inventory?.supported === true
          && methodShape
          && Array.isArray(inventory.environments)
          && Array.isArray(inventory.profiles)
          && sensitiveKeysAbsent,
        `openclaw environments -> supported=${inventory?.supported} envs=${inventory?.environments?.length ?? "?"} profiles=${inventory?.profiles?.length ?? "?"}`,
      );

      const agents = await req("GET", `${B}/__api/agents?backend=openclaw`);
      const agentId = (agents.json.agents || [])[0]?.id;
      if (agentId) {
        const key = `agent:${agentId}:main`;
        const query = new URLSearchParams({ backend: "openclaw", agentId, key });
        const descriptionResponse = await req("GET", `${B}/__api/sessions/describe?${query.toString()}`);
        const description = descriptionResponse.json;
        ok(
          descriptionResponse.status === 200
            && typeof description?.supported === "boolean"
            && methodNames.every((name) => typeof description?.methods?.[name] === "boolean")
            && (description.session === null || description.session?.key === key),
          `openclaw session describe (${agentId}) -> supported=${description?.supported} found=${Boolean(description?.session)}`,
        );
        const branchResponse = await req("GET", `${B}/__api/sessions/branches?${query.toString()}`);
        const branches = branchResponse.json;
        ok(
          branchResponse.status === 200
            && typeof branches?.supported === "boolean"
            && Array.isArray(branches?.branches)
            && methodNames.every((name) => typeof branches?.methods?.[name] === "boolean"),
          `openclaw session branches (${agentId}) -> supported=${branches?.supported} branches=${branches?.branches?.length ?? "?"}`,
        );
        const artifactResponse = await req("GET", `${B}/__api/sessions/artifacts?${query.toString()}`);
        const artifacts = artifactResponse.json?.artifacts;
        ok(
          artifactResponse.status === 200
            && typeof artifacts?.supported === "boolean"
            && Array.isArray(artifacts?.items),
          `openclaw session artifacts (${agentId}) -> supported=${artifacts?.supported} items=${artifacts?.items?.length ?? "?"}`,
        );
        // Persistent Session Board is deliberately read-only in smoke: mutation
        // routes have deterministic unit coverage and must not touch user data.
        const boardQuery = new URLSearchParams({ backend: "openclaw", agentId, sessionKey: key });
        const boardResponse = await req("GET", `${B}/__api/session-board?${boardQuery.toString()}`);
        const board = boardResponse.json;
        const boardShape = boardMethodNames.every((name) => typeof board?.methods?.[name] === "boolean")
          && Object.keys(board?.methods || {}).length === boardMethodNames.length
          && typeof board?.capabilities?.["board-widget-put-canvas-doc"] === "boolean"
          && Object.keys(board?.capabilities || {}).length === 1;
        const boardSerialized = JSON.stringify(board);
        const boardSensitiveKeysAbsent = [
          "frameUrl", "viewTicket", "viewTicketTtlMs", "viewGeneration", "sandboxUrl",
          "sandboxPort", "sandboxOrigin", "declared", "declaredSummary", "props", "pluginKind",
        ].every((field) => !boardSerialized.includes(`\"${field}\"`));
        ok(
          boardResponse.status === 200
            && typeof board?.supported === "boolean"
            && boardShape
            && boardSensitiveKeysAbsent
            && (board.snapshot === null || (
              board.snapshot?.sessionKey === key
              && Array.isArray(board.snapshot?.tabs)
              && Array.isArray(board.snapshot?.widgets)
            )),
          `openclaw session board (${agentId}) -> supported=${board?.supported} tabs=${board?.snapshot?.tabs?.length ?? "?"} widgets=${board?.snapshot?.widgets?.length ?? "?"}`,
        );
      } else {
        log("  (no openclaw agents online — describe/branches/board shape checks skipped)");
      }

      const unsupported = await req("GET", `${B}/__api/environments?backend=hermes`);
      ok(
        unsupported.status === 200
          && unsupported.json?.supported === false
          && Array.isArray(unsupported.json?.environments)
          && Array.isArray(unsupported.json?.profiles)
          && methodNames.every((name) => unsupported.json?.methods?.[name] === false),
        "hermes environments -> supported:false with closed method map",
      );
      // All four routes stay backend-explicit. Use Hermes' contract defaults and
      // a deliberately nonexistent slash-bearing key so this also exercises the
      // query/body transport without reading or mutating a real session.
      const routedAgent = "smoke-route-agent";
      const routedKey = "agent:smoke-route-agent:branch/with/slash";
      const routedQuery = new URLSearchParams({
        backend: "hermes",
        agentId: routedAgent,
        key: routedKey,
      });
      const unsupportedDescription = await req(
        "GET", `${B}/__api/sessions/describe?${routedQuery.toString()}`,
      );
      const unsupportedBranches = await req(
        "GET", `${B}/__api/sessions/branches?${routedQuery.toString()}`,
      );
      const unsupportedArtifacts = await req(
        "GET", `${B}/__api/sessions/artifacts?${routedQuery.toString()}`,
      );
      const unsupportedFork = await req("POST", `${B}/__api/sessions/fork`, {
        backend: "hermes",
        agentId: routedAgent,
        key: routedKey,
        entryId: "entry/with/slash",
      });
      ok(
        unsupportedDescription.status === 200
          && unsupportedDescription.json?.supported === false
          && unsupportedDescription.json?.session === null,
        "hermes explicit session describe -> supported:false",
      );
      ok(
        unsupportedBranches.status === 200
          && unsupportedBranches.json?.supported === false
          && Array.isArray(unsupportedBranches.json?.branches),
        "hermes explicit session branches -> supported:false",
      );
      ok(
        unsupportedArtifacts.status === 200
          && unsupportedArtifacts.json?.artifacts?.supported === false
          && Array.isArray(unsupportedArtifacts.json?.artifacts?.items),
        "hermes explicit session artifacts -> supported:false with items array",
      );
      ok(
        unsupportedFork.status === 200 && unsupportedFork.json?.supported === false,
        "hermes explicit session fork -> supported:false (no mutation)",
      );
      const unsupportedBoardQuery = new URLSearchParams({
        backend: "hermes",
        agentId: routedAgent,
        sessionKey: routedKey,
      });
      const unsupportedBoard = await req(
        "GET", `${B}/__api/session-board?${unsupportedBoardQuery.toString()}`,
      );
      ok(
        unsupportedBoard.status === 200
          && unsupportedBoard.json?.supported === false
          && unsupportedBoard.json?.snapshot === null
          && boardMethodNames.every((name) => unsupportedBoard.json?.methods?.[name] === false)
          && unsupportedBoard.json?.capabilities?.["board-widget-put-canvas-doc"] === false,
        "hermes explicit session board -> supported:false (read-only)",
      );
      const missing = await req("GET", `${B}/__api/environments`);
      ok(missing.status === 400, `environments missing backend -> ${missing.status}`);
      const missingBoard = await req("GET", `${B}/__api/session-board`);
      ok(missingBoard.status === 400, `session board missing params -> ${missingBoard.status}`);
    } catch (e) { ok(false, `advanced sessions: ${e.message}`); }
  }

  if (WHICH === "dashboard" || WHICH === "all") {
    log("--- DASHBOARD (总览聚合) ---");
    try {
      // 形状断言 only：内容是机器数据，且 gateway 离线时各 section 必须降级而非 500
      //（registry.getDashboardSummary 绝不 throw 是这条 smoke 守护的回归线）。
      const r = await req("GET", `${B}/__api/dashboard?sinceMs=0&runsLimit=5&artifactsLimit=5`);
      const s = r.json.summary;
      ok(r.status === 200 && s && typeof s === "object", `dashboard -> ${r.status}`);
      ok(isNumeric(s?.generatedAt) && isNumeric(s?.sinceMs), `  meta -> generatedAt/sinceMs numeric`);
      ok(Array.isArray(s?.status) && s.status.every((b) => b.id && typeof b.connected === "boolean"),
        `  status -> ${s?.status?.length} backends (${(s?.status || []).map((b) => `${b.id}:${b.connected}`).join(", ")})`);
      ok(Array.isArray(s?.runs) && s.runs.every((x) => typeof x.jobId === "string" && typeof x.backendId === "string"),
        `  runs -> ${s?.runs?.length} entries`);
      for (const key of ["running", "approvals", "artifacts"]) {
        const secs = s?.[key];
        ok(
          Array.isArray(secs) &&
            secs.every((x) => typeof x.backend === "string" && typeof x.supported === "boolean" && Array.isArray(x.items)),
          `  ${key} -> ${(secs || []).map((x) => `${x.backend}:${x.supported ? x.items.length : x.reason || "unsupported"}`).join(", ")}`,
        );
      }
      // 本机默认 loopback gateway URL → artifacts 的 openclaw 条目必须 supported
      //（_isLocalGateway 只看 URL 不看连通性，离线也成立）。
      const art = (s?.artifacts || []).find((x) => x.backend === "openclaw");
      ok(art?.supported === true, `  artifacts openclaw local -> supported=${art?.supported}`);
      ok(Array.isArray(s?.usage) && s.usage.every((x) => typeof x.backend === "string"),
        `  usage -> ${(s?.usage || []).map((x) => x.backend).join(", ")}`);
      // 无参调用：sinceMs = 服务端本地时区今日 0 点。
      const r2 = await req("GET", `${B}/__api/dashboard`);
      const since = r2.json.summary?.sinceMs;
      const now = Date.now();
      ok(r2.status === 200 && isNumeric(since) && since <= now && now - since < 86400000,
        `  default sinceMs = local midnight (${new Date(since).toLocaleString()})`);
      // 非 GET → 405
      const bad = await req("POST", `${B}/__api/dashboard`, {});
      ok(bad.status === 405, `  POST -> ${bad.status}`);
      // ---- 统一活动流（activityPage + runStats + /activities 端点） ----
      // 首屏附带 activityPage（默认筛选、cursor 分页第一页）与 runStats（当天
      // 全量 cron 计数，KPI 换此口径消除 runsLimit=50 截断矛盾）。
      const ap = r2.json.summary?.activityPage;
      ok(ap && Array.isArray(ap.items) && typeof ap.hasMore === "boolean" && Array.isArray(ap.degradedSources),
        `  activityPage -> ${ap?.items?.length} items, degraded=[${(ap?.degradedSources || []).map((d) => `${d.backend}/${d.source}:${d.reason}`).join(",")}]`);
      const rs = r2.json.summary?.runStats;
      ok(rs && rs.total && isNumeric(rs.total.total) && Array.isArray(rs.byBackend),
        `  runStats -> total=${rs?.total?.total} ok=${rs?.total?.ok} error=${rs?.total?.error}`);
      const act = await req("GET", `${B}/__api/dashboard/activities`);
      const pg = act.json;
      ok(act.status === 200 && Array.isArray(pg?.items) && typeof pg?.hasMore === "boolean" && Array.isArray(pg?.degradedSources),
        `  activities -> ${pg?.items?.length} items hasMore=${pg?.hasMore}`);
      ok(isNumeric(pg?.sinceMs) && pg.sinceMs <= now && now - pg.sinceMs < 86400000,
        `  activities default sinceMs = local midnight`);
      const sortedDesc = (pg?.items || []).every((x, i, a) =>
        i === 0 || a[i - 1].occurredAt > x.occurredAt ||
        (a[i - 1].occurredAt === x.occurredAt && a[i - 1].id > x.id));
      ok(sortedDesc, `  activities sorted (occurredAt,id) desc`);
      ok((pg?.items || []).every((x) => typeof x.id === "string" && typeof x.backendId === "string"
        && ["cron", "kanban", "inspiration", "health"].includes(x.kind) && isNumeric(x.occurredAt)
        && ["success", "error", "warning", "info"].includes(x.severity)),
        `  activities entry shape (id/backendId/kind/occurredAt/severity)`);
      // 筛选 + 分页 + 参数校验
      const fk = await req("GET", `${B}/__api/dashboard/activities?kind=cron&limit=1`);
      ok(fk.status === 200 && (fk.json.items || []).every((x) => x.kind === "cron"),
        `  activities kind=cron -> ${fk.json.items?.length}`);
      if (fk.json.hasMore && fk.json.nextCursor) {
        const p2 = await req("GET", `${B}/__api/dashboard/activities?kind=cron&limit=1&cursor=${encodeURIComponent(fk.json.nextCursor)}`);
        const noDup = p2.status === 200 && (p2.json.items || []).every((x) => x.id !== fk.json.items[0]?.id);
        ok(noDup, `  activities cursor page2 no-dup -> ${p2.json.items?.length}`);
      }
      const badKind = await req("GET", `${B}/__api/dashboard/activities?kind=nope`);
      ok(badKind.status === 400, `  activities kind=nope -> ${badKind.status}`);
      const badCursor = await req("GET", `${B}/__api/dashboard/activities?cursor=garbage!!`);
      ok(badCursor.status === 400, `  activities bad cursor -> ${badCursor.status}`);
      const badBackend = await req("GET", `${B}/__api/dashboard/activities?backend=nope`);
      ok(badBackend.status === 400, `  activities backend=nope -> ${badBackend.status}`);
      const actPost = await req("POST", `${B}/__api/dashboard/activities`, {});
      ok(actPost.status === 405, `  activities POST -> ${actPost.status}`);
      // ---- 预览路由（重验证；越界/缺参/方法守卫） ----
      const pvNoParam = await req("GET", `${B}/__api/dashboard/preview`);
      ok(pvNoParam.status === 400, `  preview no-param -> ${pvNoParam.status}`);
      const pvBadBackend = await req("GET", `${B}/__api/dashboard/preview?backend=nope&path=/tmp/x.png`);
      ok(pvBadBackend.status === 400, `  preview bad backend -> ${pvBadBackend.status}`);
      const pvEscape = await req("GET", `${B}/__api/dashboard/preview?backend=openclaw&path=${encodeURIComponent("/etc/hosts")}`);
      ok(pvEscape.status === 404, `  preview out-of-root -> ${pvEscape.status}`);
      const pvPost = await req("POST", `${B}/__api/dashboard/preview`, {});
      ok(pvPost.status === 405, `  preview POST -> ${pvPost.status}`);
      // 有真实图片产出时顺手验证 200（机器相关，条件断言）
      const img = (r.json.summary?.artifacts || []).flatMap((sec) => sec.items.map((x) => ({ ...x, backend: sec.backend })))
        .find((x) => x.kind === "image");
      if (img) {
        const pvOk = await req("GET", `${B}/__api/dashboard/preview?backend=${img.backend}&path=${encodeURIComponent(img.path)}`);
        ok(pvOk.status === 200, `  preview real image (${img.name}) -> ${pvOk.status}`);
      }
    } catch (e) { ok(false, `dashboard: ${e.message}`); }
  }

  await server.close();
  for (const restore of restoreModelAdapters) restore();
  hb.stop();
  fs.rmSync(cfgDir, { recursive: true, force: true });
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
}
if (require.main === module) {
  main().catch((e) => { console.error("[crud] FAILED", e); process.exit(1); });
}
module.exports = { installSmokeModelAdapter };
