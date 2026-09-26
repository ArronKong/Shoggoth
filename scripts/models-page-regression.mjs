#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const viteBin = path.join(uiRoot, "node_modules/vite/bin/vite.js");
const port = 41873;
const baseUrl = `http://127.0.0.1:${port}`;
const require = createRequire(import.meta.url);
let chromium;
for (const candidate of [
  path.join(root, "node_modules/playwright"),
  path.join(uiRoot, "node_modules/playwright"),
  path.join(os.homedir(), ".openclaw/workspace/node_modules/playwright"),
]) {
  try {
    chromium = require(candidate).chromium;
    break;
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
  }
}
assert.ok(chromium, "找不到 Playwright；请先安装项目测试依赖");

// Task 19 的文本契约要求新增界面文案全部经过 i18n，避免英文界面夹杂中文。
const editorSource = fs.readFileSync(path.join(uiRoot, "src/pages/models/ModelEditorDrawer.tsx"), "utf8");
const modelsSource = fs.readFileSync(path.join(uiRoot, "src/pages/ModelsPage.tsx"), "utf8");
const apiClientSource = fs.readFileSync(path.join(uiRoot, "src/api/client.ts"), "utf8");
const agentModelCardsSource = fs.readFileSync(
  path.join(uiRoot, "src/pages/agents/AgentModelCards.tsx"),
  "utf8",
);
const agentModelHookSource = fs.readFileSync(
  path.join(uiRoot, "src/pages/agents/useAgentModelSettings.ts"),
  "utf8",
);
const zhLocaleSource = fs.readFileSync(path.join(uiRoot, "src/i18n/locales/zh-CN.ts"), "utf8");
const enLocaleSource = fs.readFileSync(path.join(uiRoot, "src/i18n/locales/en.ts"), "utf8");
for (const key of ["editorAddTitle", "saveApply", "impactPreview", "discardNavigation", "changeErrorGeneric"]) {
  assert.match(zhLocaleSource, new RegExp(`${key}:`), `中文 locale 缺少 models.${key}`);
  assert.match(enLocaleSource, new RegExp(`${key}:`), `英文 locale 缺少 models.${key}`);
}
assert.match(editorSource, /useTranslation\(\)/, "统一模型编辑器必须通过 i18n 输出文案");
assert.equal(editorSource.includes("放弃尚未保存的模型修改"), false, "模型编辑器不应硬编码中文确认文案");
assert.equal(modelsSource.includes("显示现有 Key"), false, "Provider reveal 文案不应硬编码中文");
assert.match(
  apiClientSource,
  /addModelConfig\([\s\S]*?operationId\?: string[\s\S]*?JSON\.stringify\(\{ \.\.\.spec, \.\.\.\(operationId \? \{ operationId \} : \{\}\) \}\)/,
  "旧 addModelConfig API 客户端必须把显式 operationId 放入 POST body",
);
assert.doesNotMatch(
  modelsSource,
  /setAuxiliaryModel|resetAllToMain/,
  "per-agent 辅助模型设置不得重新回到共享模型页",
);
assert.match(agentModelCardsSource, /data-testid="agent-model-cards"/);
assert.match(agentModelCardsSource, /resetAllToMain/);
assert.match(agentModelHookSource, /setAuxiliaryModel\(backend, task, provider, model, profile\)/);

async function waitFor(check, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}`);
}

const server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: uiRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
await waitFor(async () => {
  try { return (await fetch(baseUrl)).ok; } catch { return false; }
}, "Vite 服务启动", 10_000);

const browser = await chromium.launch({ channel: "chrome" });

function revision(char) { return char.repeat(64); }

// 每个场景使用独立浏览器上下文与内存后端，真实穿过 React、store 和 API client。
async function createHarness({
  viewport = { width: 1280, height: 800 },
  reducedMotion = "no-preference",
  locale = "zh-CN",
  ...overrides
} = {}) {
  const context = await browser.newContext({ locale, viewport, reducedMotion });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const state = {
    revision: revision("1"),
    revisionChar: 1,
    models: [
      { id: "shared-model", name: "Alpha Shared", provider: "alpha", backendId: "openclaw", contextWindow: 8192, reasoning: false },
      { id: "shared-model", name: "Beta Shared", provider: "beta", backendId: "openclaw" },
      { id: "builtin", name: "Builtin", provider: "managed", backendId: "openclaw" },
    ],
    config: {
      providers: [
        {
          key: "alpha", baseUrl: "https://api.alpha.example/v1", api: "openai-responses",
          hasApiKey: true, source: "config", editable: true,
          models: [{ id: "shared-model", catalogId: "shared-model", name: "Alpha Shared", contextWindow: 8192, maxTokens: 2048, reasoning: false }],
        },
        {
          key: "beta", baseUrl: "https://api.beta.example/v1", hasApiKey: false,
          source: "config", editable: true,
          models: [{ id: "shared-model", catalogId: "shared-model", name: "Beta Shared" }],
        },
      ],
    },
    capabilities: { supported: true, create: true, update: true, rename: true, delete: true, updateProvider: true, auxiliary: true, blockers: [] },
    active: {},
    providerByScope: {},
    previewCalls: [],
    applyCalls: [],
    revealCalls: 0,
    providerPuts: 0,
    deletes: 0,
    compatCalls: [],
    auxiliaryPosts: 0,
    auxiliary: {
      main: { provider: "hermes", model: "hermes-model" },
      slots: [{ task: "vision", provider: "auto", model: "" }],
    },
    preview: { references: [], blockers: [], runtimeApply: "hot" },
    applyStatuses: ["applied"],
    applyResults: [],
    applyErrors: [],
    compatStatus: "applied",
    compatStatuses: [],
    pendingOperations: [],
    pendingApplyRoute: null,
    deferApply: false,
    pendingRevealRoute: null,
    deferReveal: false,
    ...overrides,
  };

  function nextRevision() {
    state.revisionChar += 1;
    state.revision = revision(String(state.revisionChar % 10));
  }

  function catalogWire() {
    return { models: state.models, catalogRevision: state.revision };
  }

  function applySpec(body) {
    const sourceId = body.sourceModelId;
    const target = body.model;
    const provider = state.config.providers.find((item) => item.key === body.providerKey);
    if (!provider && body.providerMode === "new") {
      state.config.providers.push({
        key: body.providerKey,
        baseUrl: body.baseUrl,
        api: body.api,
        hasApiKey: !!body.apiKey,
        source: "config",
        editable: true,
        models: [],
      });
    }
    const targetProvider = state.config.providers.find((item) => item.key === body.providerKey);
    if (targetProvider) {
      targetProvider.models = targetProvider.models.filter((item) => item.id !== (sourceId || target.id));
      targetProvider.models.push({ ...target, catalogId: target.id });
    }
    state.models = state.models.filter((item) => !(item.provider === body.providerKey && item.id === (sourceId || target.id)));
    state.models.push({ ...target, name: target.name || target.id, provider: body.providerKey, backendId: "openclaw" });
    nextRevision();
  }

  await page.route("**/__api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const backend = url.searchParams.get("backend") || "openclaw";
    if (url.pathname === "/__api/config") {
      await route.fulfill({ json: { config: { gatewayUrl: "", token: "test", locale: "zh-CN", theme: "light", disabledBackends: [], notifications: {}, setupCompletedAt: 1 } } });
      return;
    }
    if (url.pathname === "/__api/models/config/capabilities") {
      await route.fulfill({ json: state.capabilities });
      return;
    }
    if (url.pathname === "/__api/models/config/pending") {
      await route.fulfill({ json: { operations: state.pendingOperations } });
      return;
    }
    if (url.pathname === "/__api/models/config/preview") {
      const body = request.postDataJSON();
      state.previewCalls.push(body);
      await route.fulfill({ json: {
        previewToken: `preview-${state.previewCalls.length}`,
        capabilities: state.capabilities,
        fingerprints: { config: state.revision },
        ...state.preview,
      } });
      return;
    }
    if (url.pathname === "/__api/models/config/model") {
      const body = request.postDataJSON();
      state.applyCalls.push(body);
      if (state.deferApply) {
        state.pendingApplyRoute = route;
        return;
      }
      const applyError = state.applyErrors.shift();
      if (applyError) {
        await route.fulfill({
          status: 409,
          json: { error: "model change rejected", ...applyError },
        });
        return;
      }
      const applyResult = state.applyResults.shift();
      if (applyResult) {
        if (applyResult.status === "applied") applySpec(body);
        await route.fulfill({ json: { operationId: body.operationId, ...applyResult, ...(applyResult.status === "applied" ? { catalog: catalogWire() } : {}) } });
        return;
      }
      const status = state.applyStatuses.shift() || "applied";
      if (status === "applied") applySpec(body);
      await route.fulfill({ json: status === "applied"
        ? { operationId: body.operationId, status, stage: "commit", catalog: catalogWire() }
        : { operationId: body.operationId, status, stage: "migrate", details: [{ stage: "migrate", status: "pending", retryable: true, message: "待重试" }] }
      });
      return;
    }
    if (url.pathname === "/__api/models/config/reveal") {
      state.revealCalls += 1;
      if (state.deferReveal) {
        state.pendingRevealRoute = route;
        return;
      }
      await route.fulfill({ json: { apiKey: "existing-secret", reason: "env" } });
      return;
    }
    if (url.pathname === "/__api/models/config") {
      if (method === "GET") {
        await route.fulfill({ json: backend === "openclaw" ? state.config : { providers: [] } });
        return;
      }
      if (method === "PUT") state.providerPuts += 1;
      if (method === "DELETE") state.deletes += 1;
      const body = method === "PUT" ? request.postDataJSON() : null;
      const operationId = body?.operationId || url.searchParams.get("operationId") || `compat-${state.providerPuts + state.deletes}`;
      state.compatCalls.push({ method, operationId, body, url: url.toString() });
      const compatStatus = state.compatStatuses.shift() || state.compatStatus;
      if (compatStatus !== "applied") {
        await route.fulfill({ json: {
          operationId,
          status: compatStatus,
          stage: "migrate",
          details: [{ stage: "migrate", status: "pending", message: "兼容写待重试", retryable: true }],
        } });
        return;
      }
      nextRevision();
      await route.fulfill({ json: { operationId, status: "applied", stage: "commit", catalog: catalogWire() } });
      return;
    }
    if (url.pathname === "/__api/models") {
      const models = backend === "openclaw" ? state.models : [{ id: "hermes-model", name: "Hermes Model", provider: "hermes", backendId: "hermes" }];
      const catalogRevision = backend === "openclaw" ? state.revision : revision("9");
      if (url.searchParams.get("knownRevision") === catalogRevision) {
        await route.fulfill({ json: { catalogRevision, unchanged: true } });
      } else {
        await route.fulfill({ json: { models, catalogRevision, unchanged: false } });
      }
      return;
    }
    if (url.pathname === "/__api/models/active") {
      await route.fulfill({ json: { byScope: state.active, providerByScope: state.providerByScope } });
      return;
    }
    if (url.pathname === "/__api/models/auxiliary") {
      if (method === "POST") state.auxiliaryPosts += 1;
      await route.fulfill({ json: state.auxiliary });
      return;
    }
    if (url.pathname === "/__api/models/credentials") {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto(`${baseUrl}/#/models`, { waitUntil: "domcontentloaded" });
  await page.locator(".models-page .model-card").first().waitFor();
  return { context, page, state };
}

async function openCreate(page) {
  await page.getByRole("button", { name: "新增模型" }).click();
  const drawer = page.getByRole("dialog", { name: "新增模型" });
  await drawer.waitFor();
  return drawer;
}

async function openAlphaEdit(page) {
  await page.locator(".model-card").filter({ hasText: "Alpha Shared" }).click();
  const detail = page.getByRole("dialog", { name: "Alpha Shared" });
  await detail.getByRole("button", { name: "编辑模型" }).click();
  const editor = page.getByRole("dialog", { name: "编辑模型" });
  await editor.waitFor();
  return editor;
}

try {
  // 新增与编辑使用同一 Drawer；保存后必须经过 preview/apply 并立即出现新卡片。
  {
    const { context, page, state } = await createHarness();
    const drawer = await openCreate(page);
    assert.match(await drawer.getByRole("combobox", { name: "Provider", exact: true }).textContent(), /alpha/);
    await drawer.getByLabel("模型 ID").fill("new-model");
    await drawer.getByLabel("显示名").fill("New Model");
    await drawer.getByRole("button", { name: "保存并应用" }).click();
    await drawer.waitFor({ state: "hidden" });
    assert.equal(state.previewCalls.length, 1);
    assert.equal(state.applyCalls.length, 1);
    await page.locator(".model-card").filter({ hasText: "New Model" }).waitFor();

    const editor = await openAlphaEdit(page);
    assert.equal(await editor.getByLabel("模型 ID").inputValue(), "shared-model");
    assert.equal(await editor.getByLabel("显示名").inputValue(), "Alpha Shared");
    assert.equal(await editor.getByLabel("上下文窗口").inputValue(), "8192");
    assert.equal(await editor.getByLabel("最大 tokens").inputValue(), "2048");
    assert.equal(await editor.getByRole("combobox", { name: "Provider", exact: true }).isDisabled(), true);
    await context.close();
  }

  // 同一新增 payload 在退场未结束时快速重开，也必须 remount 新 editor session，
  // 不能复用上一轮 reducer/form DOM 再等 passive effect 擦除旧值。
  {
    const { context, page } = await createHarness();
    const firstDrawer = await openCreate(page);
    const firstIdInput = firstDrawer.getByLabel("模型 ID");
    await firstIdInput.fill("stale-session-model");
    const firstInputHandle = await firstIdInput.elementHandle();
    assert.ok(firstInputHandle);
    page.once("dialog", (dialog) => dialog.accept());
    await firstDrawer.getByRole("button", { name: "关闭" }).click();
    await page.evaluate(() => {
      document.querySelectorAll("[inert]").forEach((node) => node.removeAttribute("inert"));
      const addButton = [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "新增模型");
      if (!addButton) throw new Error("快速重开的新增模型按钮不存在");
      addButton.click();
    });
    await page.waitForFunction(
      (previous) => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')]
          .find((node) => node.getAttribute("aria-labelledby")
            && node.textContent?.includes("新增模型"));
        const current = dialog?.querySelector('input[aria-label="模型 ID"]')
          ?? [...(dialog?.querySelectorAll("label") ?? [])]
            .find((label) => label.textContent?.includes("模型 ID"))?.querySelector("input");
        return Boolean(current && current !== previous);
      },
      firstInputHandle,
    );
    const reopenedDrawer = page.getByRole("dialog", { name: "新增模型" });
    await reopenedDrawer.waitFor();
    const reopenedInput = reopenedDrawer.getByLabel("模型 ID");
    const inputWasRemounted = await reopenedInput.evaluate(
      (node, previous) => node !== previous,
      firstInputHandle,
    );
    assert.equal(inputWasRemounted, true, "快速重开复用了上一轮 ModelEditorDrawer DOM/session");
    assert.equal(await reopenedInput.inputValue(), "");
    await context.close();
  }

  // 能力门控在填表前生效；rename=false 只锁 ID，不锁其它字段。
  {
    const { context, page } = await createHarness({
      capabilities: { supported: true, create: false, update: true, rename: false, delete: false, blockers: ["upgrade_required"] },
    });
    assert.equal(await page.getByRole("button", { name: "新增模型" }).isDisabled(), true);
    const editor = await openAlphaEdit(page);
    assert.equal(await editor.getByLabel("模型 ID").getAttribute("readonly"), "");
    assert.equal(await editor.getByLabel("显示名").isEnabled(), true);
    await context.close();
  }

  // 后端明确不支持的模型字段必须隐藏且不进入请求，避免 Hermes 假成功后静默丢值。
  {
    const { context, page, state } = await createHarness({
      capabilities: {
        supported: true,
        create: true,
        update: true,
        rename: true,
        delete: true,
        updateProvider: true,
        blockers: [],
        fields: { id: true, name: false, contextWindow: true, maxTokens: false, reasoning: false },
      },
    });
    const drawer = await openCreate(page);
    assert.equal(await drawer.getByLabel("显示名").count(), 0);
    assert.equal(await drawer.getByLabel("最大 tokens").count(), 0);
    assert.equal(await drawer.getByLabel("推理模型").count(), 0);
    await drawer.getByLabel("模型 ID").fill("hermes-field-model");
    await drawer.getByLabel("上下文窗口").fill("4096");
    await drawer.getByRole("button", { name: "保存并应用" }).click();
    await drawer.waitFor({ state: "hidden" });
    assert.deepEqual(state.applyCalls[0].model, { id: "hermes-field-model", contextWindow: 4096 });
    await context.close();
  }

  // 后端整体不支持安全写入时，填表前直接显示可读只读原因，不能只暴露内部 blocker code。
  {
    const { context, page } = await createHarness({
      capabilities: {
        supported: false,
        create: false,
        update: false,
        rename: false,
        delete: false,
        blockers: ["hermes_conditional_write_unsupported"],
      },
    });
    assert.equal(await page.getByRole("button", { name: "新增模型" }).isDisabled(), true);
    const notice = page.getByRole("status");
    await notice.waitFor();
    assert.match(await notice.textContent(), /条件写入/);
    assert.doesNotMatch(await notice.textContent(), /hermes_conditional_write_unsupported/);
    await context.close();
  }

  // 字段错误有显式 aria 关联；dirty 关闭取消后保留输入。
  {
    const { context, page } = await createHarness();
    const drawer = await openCreate(page);
    await drawer.getByLabel("模型 ID").fill("dirty-model");
    await drawer.getByLabel("上下文窗口").fill("1.5");
    const contextInput = drawer.getByLabel("上下文窗口");
    assert.equal(await contextInput.getAttribute("aria-invalid"), "true");
    const errorId = await contextInput.getAttribute("aria-describedby");
    assert.ok(errorId);
    assert.equal(await drawer.locator(`#${errorId}`).isVisible(), true);
    page.once("dialog", (dialog) => dialog.dismiss());
    await drawer.getByRole("button", { name: "关闭" }).click();
    assert.equal(await drawer.isVisible(), true);
    assert.equal(await drawer.getByLabel("模型 ID").inputValue(), "dirty-model");
    await context.close();
  }

  // blocker 保留 Drawer 且零 apply；影响确认默认聚焦取消并列出引用/restart。
  {
    const blocked = await createHarness({ preview: {
      references: [],
      blockers: [{ code: "topology_changed", store: "config", message: "配置变化", referenceKey: "providers.alpha" }],
      runtimeApply: "hot",
    } });
    let drawer = await openCreate(blocked.page);
    await drawer.getByLabel("模型 ID").fill("blocked-model");
    await drawer.getByRole("button", { name: "保存并应用" }).click();
    await blocked.page.getByText("模型引用关系已变化，请重新检查。", { exact: true }).first().waitFor();
    assert.equal(blocked.state.applyCalls.length, 0);
    assert.equal(await drawer.isVisible(), true);
    // blocker 可能是瞬时拓扑变化；重试必须重新 preview，不能被旧 blocker 永久锁死。
    blocked.state.preview = { references: [], blockers: [], runtimeApply: "hot" };
    await drawer.getByRole("button", { name: "重试应用" }).click();
    await drawer.waitFor({ state: "hidden" });
    assert.equal(blocked.state.previewCalls.length, 2);
    assert.equal(blocked.state.applyCalls.length, 1);
    await blocked.context.close();

    const impact = await createHarness({ preview: {
      references: [{ store: "cron", referenceKey: "job-1:model", writable: true }],
      blockers: [],
      runtimeApply: "restart-required",
    } });
    drawer = await openAlphaEdit(impact.page);
    await drawer.getByLabel("模型 ID").fill("renamed-model");
    await drawer.getByRole("button", { name: "保存并应用" }).click();
    const alert = drawer.getByRole("alertdialog", { name: "确认模型变更影响" });
    await alert.waitFor();
    assert.match(await drawer.textContent(), /cron · 1/);
    assert.match(await drawer.textContent(), /需要重启后端/);
    assert.equal(await alert.getByRole("button", { name: "取消" }).evaluate((node) => node === document.activeElement), true);
    await alert.getByRole("button", { name: "确认并应用" }).click();
    await drawer.waitFor({ state: "hidden" });
    assert.equal(impact.state.applyCalls.length, 1);
    await impact.context.close();
  }

  // Provider 设置与模型写入共用 capability；只读后端不得绕过 UI 发 PUT/DELETE。
  {
    const readOnly = await createHarness({
      capabilities: {
        supported: false,
        create: false,
        update: false,
        rename: false,
        delete: false,
        updateProvider: false,
        blockers: ["runtime_apply_unsupported"],
      },
    });
    await readOnly.page.getByRole("button", { name: "编辑端点" }).first().click();
    const provider = readOnly.page.getByRole("dialog", { name: "编辑 provider 端点" });
    const notices = provider.getByRole("status");
    await notices.waitFor();
    assert.match(await notices.textContent(), /只读|未提供/);
    assert.doesNotMatch(await notices.textContent(), /runtime_apply_unsupported/);
    assert.equal(await provider.getByRole("button", { name: "保存", exact: true }).isDisabled(), true);
    assert.equal(await provider.getByRole("button", { name: "删除 Provider" }).isDisabled(), true);
    assert.deepEqual({ puts: readOnly.state.providerPuts, deletes: readOnly.state.deletes }, { puts: 0, deletes: 0 });
    await readOnly.context.close();
  }

  // partial 保留表单并复用 operationId；应用中 Escape 不可关闭。
  {
    const retry = await createHarness({ applyStatuses: ["partial", "applied"] });
    let drawer = await openCreate(retry.page);
    await drawer.getByLabel("模型 ID").fill("retry-model");
    await drawer.getByRole("button", { name: "保存并应用" }).click();
    await drawer.getByRole("button", { name: "重试应用" }).waitFor();
    await drawer.getByRole("button", { name: "重试应用" }).click();
    await drawer.waitFor({ state: "hidden" });
    assert.equal(retry.state.applyCalls.length, 2);
    assert.equal(retry.state.applyCalls[0].operationId, retry.state.applyCalls[1].operationId);
    await retry.context.close();

    const pending = await createHarness({ deferApply: true });
    drawer = await openCreate(pending.page);
    await drawer.getByLabel("模型 ID").fill("pending-model");
    await drawer.getByRole("button", { name: "保存并应用" }).click();
    await waitFor(() => !!pending.state.pendingApplyRoute, "apply 进入 pending");
    await pending.page.keyboard.press("Escape");
    assert.equal(await drawer.isVisible(), true);
    const body = pending.state.applyCalls[0];
    pending.state.deferApply = false;
    {
      // 完成假后端写入并返回已验证目录。
      const provider = pending.state.config.providers.find((item) => item.key === body.providerKey);
      provider.models.push({ ...body.model, catalogId: body.model.id });
      pending.state.models.push({ ...body.model, name: body.model.name || body.model.id, provider: body.providerKey, backendId: "openclaw" });
      pending.state.revision = revision("7");
      await pending.state.pendingApplyRoute.fulfill({ json: {
        operationId: body.operationId, status: "applied", stage: "commit",
        catalog: { models: pending.state.models, catalogRevision: pending.state.revision },
      } });
    }
    await drawer.waitFor({ state: "hidden" });
    await pending.context.close();
  }

  // 无 details 的 cleanup_pending 也必须显示阶段并可用同 operationId 向前恢复。
  {
    const cleanup = await createHarness({
      applyResults: [
        { status: "cleanup_pending", code: "runtime_ghost", stage: "commit-retire" },
        { status: "applied", stage: "recovery" },
      ],
    });
    const drawer = await openCreate(cleanup.page);
    await drawer.getByLabel("模型 ID").fill("cleanup-model");
    await drawer.getByRole("button", { name: "保存并应用" }).click();
    const resultAlert = drawer.getByRole("alert");
    await resultAlert.waitFor();
    assert.match(await resultAlert.textContent(), /commit-retire/);
    await drawer.getByRole("button", { name: "重试应用" }).click();
    await drawer.waitFor({ state: "hidden" });
    assert.equal(cleanup.state.applyCalls.length, 2);
    assert.equal(cleanup.state.applyCalls[0].operationId, cleanup.state.applyCalls[1].operationId);
    await cleanup.context.close();
  }

  // preview_stale 发生在 journal 前；重试必须生成新 preview 与新 operationId。
  {
    const stale = await createHarness({
      applyErrors: [{ code: "preview_stale", stage: "preflight" }],
    });
    const drawer = await openCreate(stale.page);
    await drawer.getByLabel("模型 ID").fill("stale-model");
    await drawer.getByRole("button", { name: "保存并应用" }).click();
    await drawer.getByRole("button", { name: "重试应用" }).waitFor();
    await drawer.getByRole("button", { name: "重试应用" }).click();
    await drawer.waitFor({ state: "hidden" });
    assert.equal(stale.state.previewCalls.length, 2);
    assert.equal(stale.state.applyCalls.length, 2);
    assert.notEqual(stale.state.applyCalls[0].operationId, stale.state.applyCalls[1].operationId);
    await stale.context.close();
  }

  // 兼容删除/Provider PUT 的可恢复状态（包括 blocked）保留 Drawer，并以同 operationId 续提。
  {
    const deletion = await createHarness({ compatStatuses: ["blocked", "applied"] });
    await deletion.page.locator(".model-card").filter({ hasText: "Alpha Shared" }).click();
    const detail = deletion.page.getByRole("dialog", { name: "Alpha Shared" });
    await detail.getByRole("button", { name: "删除模型配置" }).click();
    await deletion.page.getByRole("alertdialog").getByRole("button", { name: "删除模型配置" }).click();
    await deletion.page.getByText(/模型变更未完成（阶段：migrate）/).waitFor();
    assert.equal(deletion.state.deletes, 1);
    assert.equal(await detail.isVisible(), true);
    await detail.getByRole("button", { name: "删除模型配置" }).click();
    await deletion.page.getByRole("alertdialog").getByRole("button", { name: "删除模型配置" }).click();
    await detail.waitFor({ state: "hidden" });
    assert.equal(deletion.state.deletes, 2);
    assert.equal(deletion.state.compatCalls[0].operationId, deletion.state.compatCalls[1].operationId);
    await deletion.context.close();

    const providerUpdate = await createHarness({ compatStatuses: ["needs_secret", "applied"] });
    await providerUpdate.page.getByRole("button", { name: "编辑端点" }).first().click();
    const providerDrawer = providerUpdate.page.getByRole("dialog", { name: "编辑 provider 端点" });
    await providerDrawer.getByLabel("Base URL").fill("https://changed.example/v1");
    await providerDrawer.getByRole("button", { name: "保存" }).click();
    await providerUpdate.page.getByText(/模型变更未完成（阶段：migrate）/).waitFor();
    assert.equal(providerUpdate.state.providerPuts, 1);
    assert.equal(await providerDrawer.isVisible(), true);
    await providerDrawer.getByLabel("API Key").fill("retry-secret");
    await providerDrawer.getByRole("button", { name: "保存" }).click();
    await providerDrawer.waitFor({ state: "hidden" });
    assert.equal(providerUpdate.state.providerPuts, 2);
    assert.equal(providerUpdate.state.compatCalls[0].operationId, providerUpdate.state.compatCalls[1].operationId);
    await providerUpdate.context.close();
  }

  // App 重启后从 pending 查询恢复 Provider operationId，续提不得创建新 operation。
  {
    const resumed = await createHarness({
      pendingOperations: [{
        operationId: "persisted-provider-op",
        backendId: "openclaw",
        providerKey: "alpha",
        kind: "update-provider",
        status: "needs_secret",
        stage: "stage-target",
        source: null,
        target: { provider: "alpha" },
      }],
    });
    await resumed.page.getByRole("button", { name: "编辑端点" }).first().click();
    const drawer = resumed.page.getByRole("dialog", { name: "编辑 provider 端点" });
    // App 重启后表单只显示当前公开值；用户重新输入 pending patch 时仍应续提原 operation。
    await drawer.getByLabel("Base URL").fill("https://pending.example/v2");
    await drawer.getByLabel("API Key").fill("resume-secret");
    await drawer.getByRole("button", { name: "保存" }).click();
    await drawer.waitFor({ state: "hidden" });
    assert.equal(resumed.state.compatCalls[0].operationId, "persisted-provider-op");
    await resumed.context.close();
  }

  // 普通新会话修改公开 patch 时不能借用上一次会话内的 operationId。
  {
    const fresh = await createHarness({ compatStatuses: ["needs_secret", "applied"] });
    await fresh.page.getByRole("button", { name: "编辑端点" }).first().click();
    const drawer = fresh.page.getByRole("dialog", { name: "编辑 provider 端点" });
    await drawer.getByLabel("Base URL").fill("https://first.example/v1");
    await drawer.getByRole("button", { name: "保存" }).click();
    await fresh.page.getByText(/模型变更未完成（阶段：migrate）/).waitFor();
    const firstOperationId = fresh.state.compatCalls[0].operationId;
    await drawer.getByLabel("Base URL").fill("https://second.example/v1");
    await drawer.getByRole("button", { name: "保存" }).click();
    await drawer.waitFor({ state: "hidden" });
    assert.notEqual(fresh.state.compatCalls[1].operationId, firstOperationId);
    await fresh.context.close();
  }

  // Provider 明文默认零请求；显式显示才 reveal，迟到响应不得覆盖用户输入。
  {
    const { context, page, state } = await createHarness();
    await page.getByRole("button", { name: "编辑端点" }).first().click();
    const provider = page.getByRole("dialog", { name: "编辑 provider 端点" });
    const keyInput = provider.getByLabel("API Key");
    assert.equal(state.revealCalls, 0);
    assert.equal(await keyInput.getAttribute("type"), "password");
    assert.equal(await keyInput.inputValue(), "");
    await provider.getByRole("button", { name: "显示现有 Key" }).click();
    await waitFor(async () => await keyInput.inputValue() === "existing-secret", "显式 reveal 回填 Key");
    assert.equal(await keyInput.inputValue(), "existing-secret");
    await provider.getByRole("button", { name: "隐藏" }).click();
    assert.equal(await keyInput.getAttribute("type"), "password");
    assert.equal(await keyInput.inputValue(), "existing-secret");
    await context.close();

    const delayed = await createHarness({ deferReveal: true });
    await delayed.page.getByRole("button", { name: "编辑端点" }).first().click();
    const delayedProvider = delayed.page.getByRole("dialog", { name: "编辑 provider 端点" });
    const delayedInput = delayedProvider.getByLabel("API Key");
    await delayedProvider.getByRole("button", { name: "显示现有 Key" }).click();
    await waitFor(() => !!delayed.state.pendingRevealRoute, "reveal 进入 pending");
    await delayedInput.fill("user-secret");
    await delayed.state.pendingRevealRoute.fulfill({ json: { apiKey: "late-secret" } });
    await delayed.page.waitForTimeout(100);
    assert.equal(await delayedInput.inputValue(), "user-secret");
    await delayed.context.close();
  }

  // 原生卡片支持 Enter；dirty 时切 backend 必须先确认，取消保留表单。
  {
    const { context, page } = await createHarness();
    const card = page.locator(".model-card").filter({ hasText: "Builtin" });
    await card.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Builtin" }).waitFor();
    await page.getByRole("dialog", { name: "Builtin" }).getByRole("button", { name: "关闭" }).click();
    const drawer = await openCreate(page);
    await drawer.getByLabel("模型 ID").fill("guarded-model");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator('[role="tab"]').filter({ hasText: "Hermes" }).click({ force: true });
    assert.equal(await drawer.isVisible(), true);
    assert.equal(await drawer.getByLabel("模型 ID").inputValue(), "guarded-model");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator('a[aria-label="设置"]').click({ force: true });
    assert.match(page.url(), /#\/models$/);
    await context.close();
  }

  // 窄视口下 footer 固定可见、正文独立滚动，长引用不制造横向滚动。
  {
    const longReference = `agents.${"very-long-reference-segment-".repeat(14)}model`;
    const { context, page } = await createHarness({
      viewport: { width: 900, height: 700 },
      preview: {
        references: [{ store: "agents", referenceKey: longReference, writable: true }],
        blockers: [],
        runtimeApply: "restart-required",
      },
    });
    const drawer = await openAlphaEdit(page);
    await drawer.getByLabel("模型 ID").fill("responsive-model");
    await drawer.getByRole("button", { name: "保存并应用" }).click();
    const cancel = drawer.getByRole("alertdialog").getByRole("button", { name: "取消" });
    await cancel.waitFor();
    const box = await drawer.boundingBox();
    assert.ok(box && box.height <= 700 && box.y >= 0, "900×700 下 Drawer 必须完整位于视口内");
    assert.equal(await drawer.locator("footer").isVisible(), true, "窄屏下 footer 必须保持可见");
    assert.equal(await cancel.evaluate((node) => node === document.activeElement), true, "危险确认默认焦点必须可见并落在取消按钮");
    const reference = drawer.getByText(longReference, { exact: true });
    assert.equal(
      await reference.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      true,
      "长 reference 必须在容器内换行",
    );
    assert.equal(
      await drawer.evaluate((node) => [...node.children].some((child) => {
        const style = getComputedStyle(child);
        return style.overflowY === "auto" && child.scrollHeight > child.clientHeight;
      })),
      true,
      "Drawer 正文必须独立滚动，不能把 footer 推出视口",
    );
    await context.close();
  }

  // 减少动态效果时 Drawer 直接处于最终位置，状态理解不依赖入场动画。
  {
    const { context, page } = await createHarness({ reducedMotion: "reduce" });
    const drawer = await openCreate(page);
    assert.equal(
      await drawer.evaluate((node) => getComputedStyle(node).transitionDuration === "0s"),
      true,
      "prefers-reduced-motion 下 Drawer 不应保留过渡动画",
    );
    await context.close();
  }

  console.log("models page interaction regression: PASS");
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  if (server.exitCode && server.exitCode !== 0) process.stderr.write(serverLog);
}
