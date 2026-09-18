#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const UI_ROOT = path.join(ROOT, "app/manage-ui");
const requireFromUi = createRequire(path.join(UI_ROOT, "package.json"));
const esbuild = requireFromUi("esbuild");

const results = [];
function check(name, condition) {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

async function compileUiModule(relativePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-phase11-ui-"));
  const outfile = path.join(dir, "module.cjs");
  await esbuild.build({
    entryPoints: [path.join(UI_ROOT, relativePath)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  return { mod: createRequire(outfile)(outfile), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function compileClient() {
  return compileUiModule("src/api/client.ts");
}

{
  const compiled = await compileClient();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(String(init.body)) : null });
    const target = String(url);
    if (target === "/__api/shoggoth/status") {
      return new Response(JSON.stringify({ service: { healthy: true }, background: { supported: true } }), { status: 200 });
    }
    if (target === "/__api/shoggoth/providers" || target.startsWith("/__api/shoggoth/providers?profileId=")) {
      return new Response(JSON.stringify({ profile: null, providers: [] }), { status: 200 });
    }
    if (target === "/__api/shoggoth/chatgpt/models" || target.startsWith("/__api/shoggoth/chatgpt/models?profileId=")) {
      return new Response(JSON.stringify({ models: [{ id: "gpt-5", displayName: "GPT-5", description: "Model", isDefault: true }] }), { status: 200 });
    }
    if (target === "/__api/shoggoth/background/stop-impact") {
      return new Response(JSON.stringify({ availability: "available", revision: "a".repeat(64), totalCount: 0, runs: [] }), { status: 200 });
    }
    if (target.startsWith("/__api/shoggoth/background/")) {
      return new Response(JSON.stringify({ background: { supported: true, loaded: true } }), { status: 200 });
    }
    if (target === "/__api/shoggoth/providers/configure") {
      return new Response(JSON.stringify({ profile: { ready: true }, provider: { id: "provider-openai" } }), { status: 200 });
    }
    if (target === "/__api/shoggoth/chatgpt/bind") {
      return new Response(JSON.stringify({ profile: { ready: true, configuredProviderId: null } }), { status: 200 });
    }
    if (target === "/__api/shoggoth/providers/clear") {
      return new Response(JSON.stringify({ profile: { ready: false, configuredProviderId: null } }), { status: 200 });
    }
    if (target === "/__api/shoggoth/chatgpt/login") {
      return new Response(JSON.stringify({ mode: "browser", status: "waiting", authUrl: "https://auth.openai.test/device" }), { status: 200 });
    }
    if (target === "/__api/shoggoth/runtime-accounts/native-codex-default-v1/auth") {
      return new Response(JSON.stringify({
        account: { type: "chatgpt", planType: "plus" },
        requiresOpenaiAuth: true,
        login: null,
      }), { status: 200 });
    }
    if (target === "/__api/shoggoth/runtime-accounts/shoggoth-internal-codex-default-v1/logout") {
      return new Response(JSON.stringify({ loggedOut: true }), { status: 200 });
    }
    if (target.startsWith("/__api/dashboard/runs/") && target.endsWith("?backend=shoggoth")) {
      return new Response(JSON.stringify({ id: "shoggoth:run/1", backendId: "shoggoth", runId: "run/1", source: "chat", status: "running", events: [], artifacts: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ runId: "run/1", status: "running" }), { status: 200 });
  };
  try {
    const status = typeof compiled.mod.getShoggothProductStatus === "function"
      ? await compiled.mod.getShoggothProductStatus()
      : null;
    check("API 读取 Shoggoth 安全产品状态", status?.service?.healthy === true && calls.at(-1)?.url === "/__api/shoggoth/status");

    const providers = typeof compiled.mod.getShoggothProviders === "function"
      ? await compiled.mod.getShoggothProviders()
      : null;
    check("API 读取 renderer-safe provider 投影", Array.isArray(providers?.providers) && calls.at(-1)?.url === "/__api/shoggoth/providers");
    if (typeof compiled.mod.getShoggothProviders === "function") {
      await compiled.mod.getShoggothProviders("profile-second");
    }
    check("Provider snapshot 查询显式绑定 Profile", calls.at(-1)?.url === "/__api/shoggoth/providers?profileId=profile-second");

    const models = typeof compiled.mod.getShoggothChatGptModels === "function"
      ? await compiled.mod.getShoggothChatGptModels()
      : null;
    check("API 读取当前 ChatGPT authority 的真实模型目录", models?.models?.[0]?.id === "gpt-5" && calls.at(-1)?.url === "/__api/shoggoth/chatgpt/models");
    if (typeof compiled.mod.getShoggothChatGptModels === "function") {
      await compiled.mod.getShoggothChatGptModels("profile-second");
    }
    check("ChatGPT 模型目录查询显式绑定 Profile", calls.at(-1)?.url === "/__api/shoggoth/chatgpt/models?profileId=profile-second");

    if (typeof compiled.mod.runShoggothBackgroundAction === "function") {
      await compiled.mod.runShoggothBackgroundAction("repair");
    }
    check("后台修复只发送枚举 action 且无请求体", calls.at(-1)?.url === "/__api/shoggoth/background/repair" && calls.at(-1)?.method === "POST" && calls.at(-1)?.body === null);

    const stopImpact = await compiled.mod.getShoggothStopImpact();
    check("停止影响从后台实时读取", calls.at(-1)?.url === "/__api/shoggoth/background/stop-impact" && stopImpact.totalCount === 0);
    await compiled.mod.runShoggothBackgroundAction("stop", stopImpact.revision);
    check("停止请求携带已经确认的影响版本", calls.at(-1)?.url === "/__api/shoggoth/background/stop"
      && calls.at(-1)?.body?.revision === "a".repeat(64));

    const secret = "ui-provider-secret-canary-000001";
    if (typeof compiled.mod.configureShoggothProvider === "function") {
      await compiled.mod.configureShoggothProvider({
        operationId: "configure-ui-1", profileId: "profile-second",
        createdAt: 1_800_000_000_000, secret,
        provider: { id: "provider-openai", kind: "openai-api-key", name: "OpenAI API Key", model: "gpt-5", baseUrl: null, awsRegion: null, awsProfile: null },
      });
    }
    check("Provider onboarding 只向受保护 Host mutation 发送一次完整 saga 请求", calls.at(-1)?.url === "/__api/shoggoth/providers/configure" && calls.at(-1)?.method === "POST" && calls.at(-1)?.body?.secret === secret);

    if (typeof compiled.mod.bindShoggothChatGpt === "function") {
      await compiled.mod.bindShoggothChatGpt({
        operationId: "bind-ui-1", profileId: "profile-second",
        defaultModel: "gpt-5", createdAt: 1_800_000_000_001,
      });
    }
    check("ChatGPT null authority 绑定走独立 Host mutation", calls.at(-1)?.url === "/__api/shoggoth/chatgpt/bind" && calls.at(-1)?.method === "POST");

    if (typeof compiled.mod.startShoggothChatGptLogin === "function") {
      await compiled.mod.startShoggothChatGptLogin();
    }
    check("ChatGPT 登录只经安全 Host authority 路由", calls.at(-1)?.url === "/__api/shoggoth/chatgpt/login" && calls.at(-1)?.method === "POST" && JSON.stringify(calls.at(-1)?.body) === JSON.stringify({ mode: "browser", profileId: null }));

    const nativeAuth = typeof compiled.mod.getRuntimeAccountAuth === "function"
      ? await compiled.mod.getRuntimeAccountAuth("native-codex-default-v1")
      : null;
    check("首次授权只读取本机 Codex 的非敏感账号摘要", nativeAuth?.account?.type === "chatgpt"
      && calls.at(-1)?.url === "/__api/shoggoth/runtime-accounts/native-codex-default-v1/auth"
      && calls.at(-1)?.method === "GET");

    const loggedOut = typeof compiled.mod.logoutRuntimeAccount === "function"
      ? await compiled.mod.logoutRuntimeAccount("shoggoth-internal-codex-default-v1")
      : null;
    check("独立退出只提交 Shoggoth 内部 RuntimeAccount", loggedOut?.loggedOut === true
      && calls.at(-1)?.url === "/__api/shoggoth/runtime-accounts/shoggoth-internal-codex-default-v1/logout"
      && calls.at(-1)?.method === "POST" && JSON.stringify(calls.at(-1)?.body) === "{}");

    if (typeof compiled.mod.clearShoggothProvider === "function") {
      await compiled.mod.clearShoggothProvider({
        operationId: "clear-ui-1", profileId: "profile-second", createdAt: 1_800_000_000_002,
      });
    }
    check("Provider clear 保留目标 Profile identity", calls.at(-1)?.url === "/__api/shoggoth/providers/clear" && calls.at(-1)?.body?.profileId === "profile-second");

    const detail = typeof compiled.mod.getShoggothRunDetail === "function"
      ? await compiled.mod.getShoggothRunDetail("run/1")
      : null;
    check("运行详情对 path id 做编码", detail?.runId === "run/1" && calls.at(-1)?.url === "/__api/dashboard/runs/run%2F1?backend=shoggoth");

    if (typeof compiled.mod.respondShoggothPrompt === "function") {
      await compiled.mod.respondShoggothPrompt({ runId: "run/1", requestId: "req-1", kind: "approval", choice: "once" });
    }
    const responseCall = calls.at(-1);
    check("审批响应完整绑定 run/request 且不携带未知字段", responseCall?.url === "/__api/dashboard/prompts/respond?backend=shoggoth" && responseCall?.method === "POST" && JSON.stringify(responseCall?.body) === JSON.stringify({ runId: "run/1", requestId: "req-1", kind: "approval", choice: "once" }));
  } finally {
    globalThis.fetch = previousFetch;
    compiled.cleanup();
  }
}

{
  const compiled = await compileUiModule("src/lib/shoggothStartupRecovery.ts");
  try {
    const starting = {
      service: { healthy: false },
      background: {
        supported: true,
        installed: true,
        enabled: true,
        loaded: true,
        needsRepair: false,
      },
    };
    const healthy = {
      service: { healthy: true },
      background: starting.background,
    };
    const observedStatuses = [];
    const observedProviders = [];
    const recoveryCommits = [];
    let statusReads = 0;
    const recovery = await compiled.mod.recoverShoggothStartup({
      initialStatus: starting,
      retryDelaysMs: [1, 2],
      wait: async () => {},
      isCurrent: () => true,
      getStatus: async () => {
        statusReads += 1;
        return statusReads === 1 ? starting : healthy;
      },
      getProviders: async () => {
        recoveryCommits.push("read-providers");
        return { profile: null, providers: [] };
      },
      onStatus: (status) => {
        observedStatuses.push(status);
        recoveryCommits.push("status");
      },
      onProviders: (providers) => {
        observedProviders.push(providers);
        recoveryCommits.push("providers");
      },
    });
    check(
      "设置页冷启动未健康快照会自动收敛且不调用 repair",
      recovery === "recovered" && statusReads === 2
        && observedStatuses.at(-1)?.service?.healthy === true
        && observedProviders.length === 1
        && JSON.stringify(recoveryCommits.slice(-3))
          === JSON.stringify(["read-providers", "status", "providers"]),
    );

    const installTransition = {
      service: { healthy: false },
      background: {
        supported: true,
        installed: true,
        enabled: false,
        loaded: false,
        needsRepair: false,
      },
    };
    check(
      "设置页覆盖 install 到 bootstrap 之间的首启状态",
      compiled.mod.shouldRecoverShoggothStartup(installTransition) === true,
    );
    check(
      "设置页覆盖已 loaded 但仍在 enable 的首启状态",
      compiled.mod.shouldRecoverShoggothStartup({
        ...installTransition,
        background: { ...installTransition.background, loaded: true },
      }) === true,
    );

    let providerSnapshotOverwritten = false;
    let healthyStatusPublished = false;
    const providerFailureRecovery = await compiled.mod.recoverShoggothStartup({
      initialStatus: starting,
      retryDelaysMs: [0],
      wait: async () => {},
      isCurrent: () => true,
      getStatus: async () => healthy,
      getProviders: async () => { throw new Error("provider still warming up"); },
      onStatus: (status) => { healthyStatusPublished = status.service.healthy; },
      onProviders: () => { providerSnapshotOverwritten = true; },
    });
    check(
      "Service 健康但 Provider 瞬时失败时保留已有快照",
      providerFailureRecovery === "recovered" && healthyStatusPublished
        && providerSnapshotOverwritten === false,
    );

    let serviceOnlyRecovered = false;
    const serviceOnlyRecovery = await compiled.mod.recoverShoggothStartup({
      initialStatus: starting,
      retryDelaysMs: [0],
      wait: async () => {},
      getStatus: async () => healthy,
      onStatus: (status) => { serviceOnlyRecovered = status.service.healthy; },
    });
    check("账号迁出设置后，服务恢复可独立收敛", serviceOnlyRecovery === "recovered" && serviceOnlyRecovered);

  } finally {
    compiled.cleanup();
  }
}

{
  const setup = fs.readFileSync(path.join(UI_ROOT, "src/components/SetupOverlay.tsx"), "utf8");
  const settings = fs.readFileSync(path.join(UI_ROOT, "src/pages/SettingsPage.tsx"), "utf8");
  const serviceSettings = fs.readFileSync(path.join(UI_ROOT, "src/pages/settings/ServiceSettings.tsx"), "utf8");
  const providerSetup = fs.readFileSync(path.join(UI_ROOT, "src/components/ShoggothProviderSetup.tsx"), "utf8");
  const agents = fs.readFileSync(path.join(UI_ROOT, "src/pages/AgentsPage.tsx"), "utf8");
  const dashboard = fs.readFileSync(path.join(UI_ROOT, "src/pages/DashboardPage.tsx"), "utf8");
  const notifier = fs.readFileSync(path.join(UI_ROOT, "src/components/Notifier.tsx"), "utf8");
  const types = fs.readFileSync(path.join(UI_ROOT, "src/types.ts"), "utf8");
  const zh = fs.readFileSync(path.join(UI_ROOT, "src/i18n/locales/zh-CN.ts"), "utf8");
  const en = fs.readFileSync(path.join(UI_ROOT, "src/i18n/locales/en.ts"), "utf8");
  const uiEntry = fs.readFileSync(path.join(ROOT, "app/ui-entry.js"), "utf8");
  const backgroundAction = settings.slice(
    settings.indexOf("const runShoggothAction"),
    settings.indexOf("useEffect", settings.indexOf("const runShoggothAction")),
  );
  const reloadStart = uiEntry.indexOf("const reloadNativeBackends = async (");
  const reloadEnd = uiEntry.indexOf("const shoggothProductHost =", reloadStart);
  const reloadBody = uiEntry.slice(reloadStart, reloadEnd);
  const backgroundStart = uiEntry.indexOf("const backgroundStartup = app.isPackaged");
  const staticServerStart = uiEntry.indexOf("staticServer = await startStaticServer", backgroundStart);
  const registryStart = uiEntry.indexOf("registry.start()", staticServerStart);
  const windowStart = uiEntry.indexOf("createMainWindow();", registryStart);
  const backgroundContinuation = uiEntry.indexOf("void backgroundStartup.then", windowStart);
  const backgroundContinuationEnd = uiEntry.indexOf("// First-run onboarding", backgroundContinuation);
  const backgroundContinuationBody = uiEntry.slice(backgroundContinuation, backgroundContinuationEnd);
  const beforeQuitStart = uiEntry.indexOf('app.on("before-quit"');
  const beforeQuitRegistryStop = uiEntry.indexOf("appBackendRegistry.stop", beforeQuitStart);
  const beforeQuitPrefix = uiEntry.slice(beforeQuitStart, beforeQuitRegistryStop);

  const compileReload = (shoggothBackend, hostCanReload, readConfig = () => ({ disabledBackends: [] })) => Function(
    "nativeBackends",
    "hostCanReload",
    "readConfig",
    "registry",
    `"use strict";\n${reloadBody}\nreturn reloadNativeBackends;`,
  )([shoggothBackend], hostCanReload, readConfig, { start: () => shoggothBackend.start() });
  {
    let disabledBackends = [];
    let starts = 0;
    const reload = compileReload({
      id: "codex",
      async stop() { disabledBackends = ["codex"]; },
      async start() { starts += 1; },
    }, () => true, () => ({ disabledBackends }));
    await reload();
    check("后台恢复不得重连在 stop 期间被用户断开的 CLI", starts === 0);
  }
  {
    let backgroundCurrent = true;
    let releaseStop;
    let starts = 0;
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const reload = compileReload({
      async stop() { await stopGate; },
      async start() { starts += 1; },
    }, () => true);
    const pending = reload(() => backgroundCurrent);
    backgroundCurrent = false;
    releaseStop();
    await pending;
    check("后台 reload 等待 stop 期间被新手动意图撤销后不再 start", starts === 0);
  }
  {
    let starts = 0;
    const reload = compileReload({
      async stop() {},
      async start() { starts += 1; },
    }, () => true);
    await reload(() => true);
    check("仍为 current 的后台 reload 在 stop 后只 start 一次", starts === 1);
  }
  {
    let hostCurrent = true;
    let releaseStop;
    let starts = 0;
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const reload = compileReload({
      async stop() { await stopGate; },
      async start() { starts += 1; },
    }, () => hostCurrent);
    const pending = reload(() => true);
    hostCurrent = false;
    releaseStop();
    await pending;
    check("退出 fence 在 reload stop await 后仍阻止 backend start", starts === 0);
  }

  check("首启明确识别原生 Shoggoth 而不落入 Hermes 远程表单", /b\.id\s*===\s*["']shoggoth["']/.test(setup) && /getShoggothProductStatus/.test(setup));
  check("首启就绪口径不再要求所有外部后端全绿", !/statuses\.every\(\(b\)\s*=>\s*b\.connected\)/.test(setup));
  check("设置有独立 Shoggoth Service 分区和错误重试", /id=["']settings-shoggoth["']/.test(serviceSettings) && /getShoggothProductStatus/.test(settings) && /onRetry=\{shoggothRetry\}/.test(settings));
  check("后台 loaded 但 Service 断开时显示重新连接且仍可停止", /background\.loaded\s*&&\s*!status\.service\.healthy/.test(serviceSettings) && /action\("repair", "settings\.reconnect"/.test(serviceSettings) && /background\.loaded\s*&&\s*action\("stop", "settings\.shoggothStop"/.test(serviceSettings) && /onAction=\{\(action\) => void runShoggothAction\(action\)\}/.test(settings));
  check(
    "后台恢复后重载 Shoggoth Backend 清除未就绪缓存",
    /onProfileConfigured:\s*\(\)\s*=>\s*reloadNativeBackends\(\)/.test(uiEntry)
      && /onBackgroundReady:\s*\(_status,\s*stillCurrent\)\s*=>\s*reloadNativeBackends\(stillCurrent\)/.test(uiEntry),
  );
  check(
    "packaged 后台恢复不阻塞静态服务、Registry 与窗口启动",
    backgroundStart >= 0
      && !/await\s+shoggothProductHost\.ensureBackgroundRunning\(\)/.test(uiEntry)
      && staticServerStart > backgroundStart
      && registryStart > staticServerStart
      && windowStart > registryStart
      && backgroundContinuation > windowStart,
  );
  check(
    "后台启动成功后只通过 Backend 自身 notifier 触发一次恢复",
    /shoggothProductHost\.isBackgroundStartupCurrent\(status\)/.test(backgroundContinuationBody)
      && /status\?\.supported\s*===\s*true/.test(backgroundContinuationBody)
      && /status\.loaded\s*===\s*true/.test(backgroundContinuationBody)
      && /status\.enabled\s*===\s*true/.test(backgroundContinuationBody)
      && /status\.needsRepair\s*===\s*false/.test(backgroundContinuationBody)
      && /const stillCurrent\s*=\s*\(\)\s*=>\s*shoggothProductHost\.isBackgroundStartupCurrent\(status\)/.test(backgroundContinuationBody)
      && /return reloadNativeBackends\(stillCurrent\)/.test(backgroundContinuationBody)
      && /async \(stillCurrent\s*=\s*\(\)\s*=>\s*true\)/.test(reloadBody)
      && /const canReload\s*=\s*\(\)\s*=>\s*hostCanReload\(\)\s*&&\s*stillCurrent\(\)/.test(reloadBody)
      && reloadStart >= 0
      && reloadEnd > reloadStart
      && !/registry\.emit\(["']backend\.ready["']/.test(reloadBody),
  );
  check(
    "退出 generation fence 阻止迟到后台恢复重新启动 Shoggoth",
    /const startupGeneration\s*=\s*\+\+hostGeneration/.test(uiEntry)
      && /const hostCanReload\s*=\s*\(\)\s*=>\s*!hostStopping\s*&&\s*startupGeneration\s*===\s*hostGeneration/.test(uiEntry)
      && /if \(!canReload\(\)\) return;[\s\S]*?await Promise\.all\(nativeBackends\.map\(\(backend\)\s*=>\s*backend\.stop\(\)\)\);[\s\S]*?if \(!canReload\(\)\) return;[\s\S]*?await Promise\.all\(nativeBackends\.filter\([\s\S]*?\.map\(\(backend\)\s*=>\s*registry\.start\(backend\.id\)\)\);/.test(reloadBody)
      && /if \(!hostCanReload\(\)\) return;/.test(backgroundContinuationBody)
      && /hostStopping\s*=\s*true/.test(beforeQuitPrefix)
      && /hostGeneration\s*\+=\s*1/.test(beforeQuitPrefix),
  );
  check(
    "后台自动启动失败只记录固定诊断且返回 null",
    /const reportBackgroundStartupFailure = \(\) => \{\s*console\.error\(["']\[shoggoth\] background service auto-start unavailable["']\);\s*return null;\s*\};/.test(uiEntry),
  );
  check("账号迁出后设置只管理后台状态，不再加载 Provider", !/getShoggothProviders|setShoggothProviders|RuntimeAccountsPanel/.test(settings)
    && /getShoggothProviders/.test(fs.readFileSync(path.join(UI_ROOT, "src/pages/models/ModelAccounts.tsx"), "utf8")));
  check("后台动作返回失败后仍回读权威状态并保留启动/重连出口", /catch[\s\S]*getShoggothProductStatus\(\)[\s\S]*setShoggothStatus/.test(backgroundAction));
  check("后台启动响应的瞬时锁定状态会有界回读并自动收敛", /SHOGGOTH_POST_START_REFRESH_DELAYS_MS/.test(settings) && /for\s*\(const delayMs of SHOGGOTH_POST_START_REFRESH_DELAYS_MS\)/.test(backgroundAction));
  check("Provider 列表失败不会遮住后台启动修复状态", !/Promise\.all\(\[getShoggothProductStatus\(\), getShoggothProviders\(\)\]\)/.test(settings));
  check("所有后端的断开按钮遵循同一描述契约", /descriptor\.disconnectable/.test(settings) && /isDisconnectable\(b\)/.test(settings));
  check("无权威发布源的 Shoggoth 只显示当前版本而不伪造官方比较", /comparisonSupported\s*!==\s*false/.test(settings) && /showVersionComparison/.test(settings));
  check("Dashboard 审批可响应并刷新持久状态", /respondBackendPrompt/.test(dashboard) && /approvalResponding/.test(dashboard));
  check("Dashboard 能读取原生通用 Run 详情", /getBackendRunDetail/.test(dashboard) && /backendRunDetail/.test(dashboard));
  check("Notifier 聚合原生看板且保留逐后端失败隔离", /kanbanBackends/.test(notifier) && /if \(!board\) continue/.test(notifier));
  check("安全 DTO 类型不含凭据存储字段", /interface ShoggothProviderSummary/.test(types) && !/interface ShoggothProviderSummary[^}]*credentialRef/s.test(types) && !/interface ShoggothProviderSummary[^}]*headers/s.test(types));
  check("ChatGPT 模型只能从 authority 目录选择而非自由文本猜测", /getShoggothChatGptModels/.test(providerSetup) && /<Select\s+value=\{model\}/.test(providerSetup) && !/useState\(["']gpt-5["']\)/.test(providerSetup));
  check(
    "内置 Agent 展示 Service 自动复用的账号来源，独立授权仅保留为回退",
    /chatgpt\?\.authSource\s*===\s*["']native-codex["']/.test(providerSetup)
      && /nativeCodexConnected/.test(providerSetup)
      && /startShoggothChatGptLogin\(profileId\)/.test(providerSetup)
      && !/getRuntimeAccountAuth|detectNativeCodexAuth/.test(providerSetup)
      && !/copyFile|auth\.json/.test(providerSetup),
  );
  check(
      "内置 Agent 切换和退出只修改 Shoggoth 内部账号",
    /INTERNAL_CODEX_ACCOUNT_ID\s*=\s*["']shoggoth-internal-codex-default-v1["']/.test(providerSetup)
      && /logoutRuntimeAccount\(INTERNAL_CODEX_ACCOUNT_ID\)/.test(providerSetup)
      && /setLocallyLoggedOut\(true\)/.test(providerSetup)
      && /locallyLoggedOut\s*&&\s*chatgpt\?\.authState\s*!==\s*["']authenticated["']/.test(providerSetup)
      && /effectiveChatGptAuthState/.test(providerSetup)
      && /changeChatGptAccount\(["']switch["']\)/.test(providerSetup)
      && /changeChatGptAccount\(["']logout["']\)/.test(providerSetup),
  );
  check("非默认 Agent 的 Provider 使用 Profile 专属 ID 并显式携带 profileId", /profileProviderId/.test(providerSetup) && /profileId,/.test(providerSetup) && /ShoggothProviderSetup/.test(agents) && /profileId=\{detail\.profile\}/.test(agents));
  check("Agent Provider 清除走 profile-scoped Host mutation", /clearShoggothProvider/.test(providerSetup) && /profileId,/.test(providerSetup) && /providers\/clear/.test(fs.readFileSync(path.join(UI_ROOT, "src/api/client.ts"), "utf8")));
  check("Phase11 新产品文案中英文均已接入", /shoggothService/.test(zh) && /shoggothService/.test(en) && /approvalApprove/.test(zh) && /approvalApprove/.test(en));
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`${failed.length}/${results.length} Phase11 UI checks failed`);
  process.exit(1);
}
console.log(`${results.length}/${results.length} Phase11 UI checks passed`);
