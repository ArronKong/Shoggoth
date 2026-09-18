"use strict";

// Dev harness: serve the React control-plane UI + management plane in a plain
// browser (no Electron, no GUI). Starts HermesBackend + BackendRegistry, then
// serves the React SPA at the loopback root with /__api (REST) wired and the
// native-chat /__chatws broker, on a fixed port. The REST-backed pages work
// without the OpenClaw gateway; chat needs the gateway live. Ctrl-C to stop.
//
// Usage: node scripts/manage-serve.cjs   (open http://127.0.0.1:18801)

const os = require("node:os");
const path = require("node:path");
const { HermesBackend } = require("../app/core/hermes-backend");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { startStaticServer } = require("../app/static-server");
const { createConfigStore } = require("../app/core/config-store");
const { createDashboardJournal } = require("../app/core/dashboard-journal");
const { createModelChangeJournal } = require("../app/core/model-change-journal");
const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { createOpenClawRuntimeApply } = require("../app/core/openclaw-runtime-apply");
const { createOpenClawModelChange } = require("../app/core/openclaw-model-change");
const { createOpenclawHostController } = require("../app/openclaw-host");
const { createHermesModelMutationGate } = require("../app/core/hermes-model-mutation");
const { createHermesModelChange } = require("../app/core/hermes-model-change");

const PORT = Number(process.env.MANAGE_SERVE_PORT || 18801);
const GATEWAY_URL = "ws://127.0.0.1:18792"; // the real OpenClaw gateway
// Dev-only proxy port (the Electron app owns 18790; avoid EADDRINUSE if it runs).
const PROXY_PORT = Number(process.env.MANAGE_PROXY_PORT || 18795);
// Dev config so the 设置 page is editable without Electron.
const configStore = createConfigStore(
  path.join(os.homedir(), ".shoggoth-dev-config.json"),
  { defaultGatewayUrl: GATEWAY_URL },
);
configStore.ensure();
// 统一认证解析器(dev 态):与 Electron 主进程同构,凭证存 ~/.shoggoth-dev-credentials。
const { createAuthResolver } = require("../app/core/device-auth");
const authResolver = createAuthResolver({
  getConfig: () => configStore.read(),
  credentialsDir: path.join(os.homedir(), ".shoggoth-dev-credentials"),
});

async function main() {
  const hermesModelMutationGate = createHermesModelMutationGate();
  const hb = new HermesBackend({
    getConfig: () => configStore.read(),
    modelMutationGate: hermesModelMutationGate,
  });
  const hermesModelChange = createHermesModelChange({
    backend: hb,
    mutationGate: hermesModelMutationGate,
  });
  hb.attachModelChangeAdapter(hermesModelChange);

  // dev 组合根与 Electron 保持同一依赖方向和同一 gate 实例。
  const workAdmissionGate = createWorkAdmissionGate();
  const openclawHostController = createOpenclawHostController();
  const openclawBackend = new OpenClawBackend({
    getUpstreamUrl: () => configStore.read().gatewayUrl || GATEWAY_URL,
    authResolver,
  });
  const openclawRuntimeApply = createOpenClawRuntimeApply({
    backend: openclawBackend,
    admissionGate: workAdmissionGate,
    supervisor: openclawHostController,
  });
  openclawBackend.attachModelRuntimeApply(openclawRuntimeApply);
  const openclawModelChange = createOpenClawModelChange({
    backend: openclawBackend,
    runtimeApply: openclawRuntimeApply,
  });
  openclawBackend.attachModelChangeAdapter(openclawModelChange);
  const registry = new BackendRegistry();
  registry.register(openclawBackend);
  registry.register(hb);
  registry.setDisabledBackendsProvider(() => configStore.read().disabledBackends);
  // 与 Electron 同款 journal（dev 路径注入，照 config-store 惯例）
  registry.attachDashboardJournal(
    createDashboardJournal(path.join(os.homedir(), ".shoggoth-dev-dashboard-journal.json")),
  );
  // 独立 model journal 禁止内存降级；coordinator 初始保持未 ready，server 可先提供只读页面。
  const modelChangeCoordinator = new ModelChangeCoordinator({
    registry,
    journal: createModelChangeJournal(path.join(os.homedir(), ".shoggoth-dev-model-change-journal.json")),
    workAdmissionGate,
  });

  // Federating proxy (chat path): the React 聊天 connects to the loopback
  // /__chatws broker, which auto-auths to this proxy (Hermes federation + relay).
  const proxy = await startProxyGateway({
    port: PROXY_PORT,
    // 与 OpenClawBackend 共用实时配置 getter；设置页改 URL 后 proxy 立即跟随。
    // OpenClaw 断开时视作未配置 → proxy 走既有降级路径（只剩外籍后端）。
    getUpstreamUrl: () => {
      const cfg = configStore.read();
      return cfg.disabledBackends.includes("openclaw") ? "" : (cfg.gatewayUrl || GATEWAY_URL);
    },
    origin: "http://127.0.0.1",
    registry,
    workAdmissionGate,
  });

  const server = await startStaticServer(PORT, {
    registry,
    chatUpstreamUrl: `ws://127.0.0.1:${PROXY_PORT}`,
    chatOrigin: "http://127.0.0.1",
    configStore,
    authResolver,
    modelChangeCoordinator,
    workAdmissionGate,
    // Dev: reconnect Hermes/OpenClaw on config save (no window to reload).
    onConfigChanged: async () => {
      const hbk = registry.backends.get("hermes");
      if (hbk) {
        // 断开的 hermes 只停不重启；否则 reconfigure（stop+start）应用新配置。
        const disabled = configStore.read().disabledBackends.includes("hermes");
        try {
          if (disabled) await hbk.stop();
          else if (typeof hbk.reconfigure === "function") await hbk.reconfigure();
        } catch (e) { console.error("[serve] hermes reconfigure:", e?.message || e); }
      }
      const oc = registry.backends.get("openclaw");
      if (oc && typeof oc.stop === "function") {
        try { await oc.stop(); } catch { /* ignore */ }
      }
    },
  });

  // 后端全部启动后才允许恢复；恢复未收敛时保留只读 server，但绝不开放 mutation readiness。
  await registry.start();
  try {
    await modelChangeCoordinator.recoverPending();
    modelChangeCoordinator.markReady();
  } catch (error) {
    console.error("[serve] model change recovery incomplete:", error?.code || error?.message || error);
  } finally {
    registry.startDashboardHealthSampler();
  }
  console.log(`[serve] ready at ${server.url}`);
  console.log(`[serve]   React UI: ${server.url}/`);
  console.log(`[serve]   chat WS:  ${server.url.replace("http", "ws")}/__chatws (proxy :${PROXY_PORT})`);
  console.log(`[serve]   REST:     ${server.url}/__api/cron/jobs`);

  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    try {
      await proxy.close();
    } catch {
      /* ignore */
    }
    try {
      hb.stop();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[serve] FAILED:", err);
  process.exit(1);
});
