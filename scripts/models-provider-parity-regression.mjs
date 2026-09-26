#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const viteBin = path.join(uiRoot, "node_modules/vite/bin/vite.js");
const require = createRequire(import.meta.url);
const playwrightCandidates = [
  path.join(root, "node_modules/playwright"),
  path.join(uiRoot, "node_modules/playwright"),
  path.join(os.homedir(), "node_modules/playwright"),
  path.join(os.homedir(), ".openclaw/workspace/node_modules/playwright"),
];
let chromium;
for (const candidate of playwrightCandidates) {
  try {
    ({ chromium } = require(candidate));
    break;
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
  }
}
assert.ok(chromium, "找不到 Playwright；请先安装项目测试依赖");
const requested = new Set(process.argv.slice(2));
const knownFlags = new Set(["--provider", "--tool-keys"]);
const unknownFlags = [...requested].filter((flag) => !knownFlags.has(flag));

if (unknownFlags.length > 0) {
  console.error(`models provider parity regression: unknown option ${unknownFlags.join(", ")}`);
  process.exit(2);
}

const runProvider = requested.size === 0 || requested.has("--provider");
const runToolKeys = requested.size === 0 || requested.has("--tool-keys");
const REDACTED = "••••sentinel";
const REVEALED_SENTINEL = "revealed-sentinel";
const INPUT_SENTINEL = "input-sentinel";
const ADDED_KEY = "MiXeD_TOOL_KEY";
const ADDED_VALUE = "  added-secret-sentinel  ";
const LATE_KEY = "LATE_TOOL_KEY";
const REDACTED_AFTER_SAVE = "••••changed";
const BASE_URL = "https://api.example.test/v1";
const EDITED_BASE_URL = "https://edited.example.test/v1";

function revision(char) {
  return char.repeat(64);
}

async function waitFor(check, label, timeout = 7_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function formatError(error) {
  return error instanceof Error ? (error.stack || error.message) : String(error);
}

function processExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForProcessExit(child, timeout) {
  if (processExited(child)) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeout);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function stopProcess(child) {
  if (processExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForProcessExit(child, 1_500)) return;
  if (!child.kill("SIGKILL") && !processExited(child)) {
    throw new Error("Vite 进程 SIGKILL 发送失败");
  }
  if (!(await waitForProcessExit(child, 1_500))) throw new Error("Vite 进程 SIGKILL 后仍未退出");
}

function envVar({
  key,
  category,
  isSet,
  isPassword = true,
  provider,
  providerLabel,
  description = "",
  tools,
}) {
  return {
    key,
    isSet,
    redactedValue: isSet ? REDACTED : null,
    description,
    url: null,
    category,
    isPassword,
    advanced: false,
    ...(provider ? { provider } : {}),
    ...(providerLabel ? { providerLabel } : {}),
    ...(tools ? { tools } : {}),
  };
}

function createState(backend) {
  return {
    backend,
    calls: [],
    unexpectedRequests: [],
    provider: {
      baseUrl: BASE_URL,
      keyConfigured: true,
    },
    vars: [
      envVar({
        key: "OPENROUTER_BASE_URL",
        category: "provider",
        isSet: true,
        isPassword: false,
        provider: "openrouter",
        providerLabel: "OpenRouter",
      }),
      envVar({
        key: "OPENROUTER_API_KEY",
        category: "provider",
        isSet: true,
        provider: "openrouter",
        providerLabel: "OpenRouter",
      }),
      envVar({
        key: "EXA_API_KEY",
        category: "tool",
        isSet: true,
        description: "Search tool credential",
        tools: ["exa"],
      }),
      envVar({
        key: LATE_KEY,
        category: "tool",
        isSet: true,
      }),
      ...(backend === "hermes"
        ? [
            envVar({
              key: "FIRECRAWL_API_KEY",
              category: "tool",
              isSet: false,
              description: "Unset directory entry",
              tools: ["firecrawl"],
            }),
          ]
        : []),
    ],
    delayNextAdd: false,
  };
}

function providerDirectory(state) {
  return {
    supported: true,
    providers: [
      {
        id: "openrouter",
        label: "OpenRouter",
        logoKey: "openrouter",
        getKeyUrl: null,
        inConfig: true,
        api: "openai-responses",
        baseUrl: { value: state.provider.baseUrl, defaultValue: BASE_URL, editable: true },
        key: {
          configured: state.provider.keyConfigured,
          clearable: true,
          source: state.provider.keyConfigured ? "config" : null,
          redacted: state.provider.keyConfigured ? REDACTED : null,
        },
        keyProbePath: "/key",
        configured: true,
        custom: false,
        modelsCount: 1,
        defaultModelId: "fixture-model",
        oauth: [],
      },
      ...(state.backend === "openclaw" ? [
        {
          id: "auth-only-custom",
          label: "Auth-only Custom",
          logoKey: "auth-only-custom",
          getKeyUrl: null,
          inConfig: false,
          api: null,
          baseUrl: { value: null, defaultValue: null, editable: false },
          key: { configured: true, clearable: true, source: "auth-profile", redacted: REDACTED },
          keyProbePath: null,
          configured: true,
          custom: true,
          modelsCount: 0,
          defaultModelId: null,
          oauth: [],
        },
        {
          id: "manual-no-url",
          label: "Manual No URL",
          logoKey: "manual-no-url",
          getKeyUrl: null,
          inConfig: true,
          api: "openai-completions",
          baseUrl: { value: null, defaultValue: null, editable: true },
          key: { configured: false, clearable: false, source: null, redacted: null },
          keyProbePath: null,
          configured: true,
          custom: true,
          modelsCount: 1,
          defaultModelId: "manual-model",
          oauth: [],
        },
      ] : []),
    ],
  };
}

function recordCall(state, { kind, method, backend, key, valueMatchesExpected }) {
  // 只记录无敏感信息的契约摘要；submitted value 永不进入状态、断言错误或日志。
  state.calls.push({ kind, method, backend, key, valueMatchesExpected });
}

function setEnvState(state, key, isSet) {
  let item = state.vars.find((entry) => entry.key === key);
  if (!item) {
    item = envVar({ key, category: "tool", isSet: false });
    state.vars.push(item);
  }
  item.isSet = isSet;
  item.redactedValue = isSet ? (key === LATE_KEY ? REDACTED_AFTER_SAVE : REDACTED) : null;
}

async function installApiFake(page, state) {
  await page.route("**/__api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const rawBackend = url.searchParams.get("backend");
    const globalRoute = url.pathname === "/__api/config" || url.pathname === "/__api/status";
    const rejectUnexpected = async (expectedMethods = [], status) => {
      state.unexpectedRequests.push({
        method,
        backend: rawBackend,
        path: url.pathname,
        expectedMethods,
      });
      await route.fulfill({
        status: status ?? (expectedMethods.length > 0 ? 405 : 404),
        json: { error: "unexpected fixture request" },
      });
    };
    if (url.pathname === "/__api/backends") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: { backends: [] } });
      return;
    }
    if (url.pathname === "/__api/shoggoth/status") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ status: 503, json: { error: "native service is outside the provider fixture" } });
      return;
    }
    if (!globalRoute && rawBackend !== state.backend) return rejectUnexpected([], 400);
    const backend = globalRoute ? state.backend : rawBackend;

    if (url.pathname === "/__api/config") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({
        json: {
          config: {
            gatewayUrl: "",
            token: "fixture-token",
            locale: "zh-CN",
            theme: "light",
            disabledBackends: [],
            notifications: { chat: false, cron: false, task: false },
            setupCompletedAt: 1,
          },
        },
      });
      return;
    }
    if (url.pathname === "/__api/status") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({
        json: {
          backends: [
            { id: "openclaw", name: "OpenClaw", connected: true },
            { id: "hermes", name: "Hermes", connected: true },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/__api/models/config/capabilities") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({
        json:
          backend === "hermes"
            ? {
                supported: true,
                create: true,
                update: true,
                rename: true,
                delete: true,
                updateProvider: true,
                perAgentModelSettings: true,
                providerDirectory: false,
                blockers: [],
              }
            : {
                supported: true,
                create: true,
                update: true,
                rename: true,
                delete: true,
                updateProvider: true,
                perAgentModelSettings: false,
                providerDirectory: true,
                blockers: [],
              },
      });
      return;
    }
    if (url.pathname === "/__api/models/config/pending") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: { operations: [] } });
      return;
    }
    if (url.pathname === "/__api/models/config") {
      if (method === "GET") {
        await route.fulfill({ json: { providers: [] } });
        return;
      }
      if (method !== "PUT") return rejectUnexpected(["GET", "PUT"]);
      const body = request.postDataJSON();
      if (body.baseUrl) {
        state.provider.baseUrl = body.baseUrl;
        recordCall(state, {
          kind: "save-provider-base-url",
          method,
          backend: rawBackend,
          key: body.providerKey,
          valueMatchesExpected:
            body.providerKey === "openrouter" && body.baseUrl === EDITED_BASE_URL,
        });
      }
      if (body.apiKey) {
        state.provider.keyConfigured = true;
        recordCall(state, {
          kind: "save-provider-secret",
          method,
          backend: rawBackend,
          key: body.providerKey,
          valueMatchesExpected:
            body.providerKey === "openrouter" && body.apiKey === INPUT_SENTINEL,
        });
      }
      if (body.clearBaseUrl) {
        state.provider.baseUrl = null;
        recordCall(state, {
          kind: "clear-provider-base-url",
          method,
          backend: rawBackend,
          key: body.providerKey,
          valueMatchesExpected:
            body.providerKey === "openrouter" && body.clearBaseUrl === true,
        });
      }
      if (body.clearApiKey) {
        state.provider.keyConfigured = false;
        recordCall(state, {
          kind: "clear-provider-secret",
          method,
          backend: rawBackend,
          key: body.providerKey,
          valueMatchesExpected:
            body.providerKey === "openrouter" && body.clearApiKey === true,
        });
      }
      await route.fulfill({
        json: {
          operationId: "fixture-operation",
          status: "applied",
          stage: "commit",
          activation: null,
        },
      });
      return;
    }
    if (url.pathname === "/__api/models/config/reveal") {
      if (method !== "POST") return rejectUnexpected(["POST"]);
      const body = request.postDataJSON();
      recordCall(state, {
        kind: "reveal-provider-secret",
        method,
        backend: rawBackend,
        key: body.providerKey,
        valueMatchesExpected: body.providerKey === "openrouter",
      });
      await route.fulfill({ json: { apiKey: REVEALED_SENTINEL, reason: "env" } });
      return;
    }
    if (url.pathname === "/__api/models/provider-directory") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: providerDirectory(state) });
      return;
    }
    if (url.pathname === "/__api/models/endpoints/validate") {
      if (method !== "POST") return rejectUnexpected(["POST"]);
      const body = request.postDataJSON();
      recordCall(state, {
        kind: "validate-provider-secret",
        method,
        backend: rawBackend,
        key: body.name,
        valueMatchesExpected:
          body.name === "openrouter" && body.apiKey === INPUT_SENTINEL,
      });
      await route.fulfill({ json: { ok: true, reachable: true, message: "", models: [] } });
      return;
    }
    if (url.pathname === "/__api/models/endpoints") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({
        json: {
          supported: true,
          endpoints: [],
          profiles: [],
          form: backend === "openclaw" ? {
            apiOptions: ["openai-completions", "openai-responses"],
            defaultApi: "openai-completions",
            nameEditable: false,
            firstModelIsDefault: false,
          } : {
            nameEditable: true,
            firstModelIsDefault: true,
          },
        },
      });
      return;
    }
    if (url.pathname === "/__api/models") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({
        json: {
          models: [],
          catalogRevision: backend === "hermes" ? revision("a") : revision("b"),
          unchanged: false,
        },
      });
      return;
    }
    if (url.pathname === "/__api/models/active") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: { byScope: {}, providerByScope: {} } });
      return;
    }
    if (url.pathname === "/__api/models/auth-profiles") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: { supported: false, profiles: [] } });
      return;
    }
    if (url.pathname === "/__api/oauth") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: { providers: [], profiles: [] } });
      return;
    }
    if (url.pathname === "/__api/env") {
      if (method === "GET") {
        await route.fulfill({ json: { vars: state.vars } });
        return;
      }
      const body = request.postDataJSON();
      let activation = null;
      if (method === "PUT") {
        const isAddedTool = !state.vars.some((entry) => entry.key === body.key);
        if (isAddedTool && state.delayNextAdd) {
          state.delayNextAdd = false;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        setEnvState(state, body.key, true);
        const kind = isAddedTool
          ? "add-tool-secret"
          : body.key === "EXA_API_KEY"
            ? "save-tool-secret"
            : body.key === LATE_KEY
              ? "save-late-tool-secret"
              : body.key.endsWith("_BASE_URL")
                ? "save-provider-base-url"
                : "save-provider-secret";
        const expectedValue = isAddedTool
          ? ADDED_VALUE
          : body.key.endsWith("_BASE_URL")
            ? EDITED_BASE_URL
            : INPUT_SENTINEL;
        recordCall(state, {
          kind,
          method,
          backend: rawBackend,
          key: body.key,
          valueMatchesExpected:
            body.value === expectedValue && (!isAddedTool || body.key === ADDED_KEY),
        });
        if (isAddedTool) activation = { kind: "gateway_restart", available: false };
      } else if (method === "DELETE") {
        setEnvState(state, body.key, false);
        const kind = body.key === "EXA_API_KEY" ? "clear-tool-secret" : "clear-provider-secret";
        recordCall(state, {
          kind,
          method,
          backend: rawBackend,
          key: body.key,
          valueMatchesExpected: Object.keys(body).length === 1,
        });
      } else return rejectUnexpected(["GET", "PUT", "DELETE"]);
      await route.fulfill({ json: { ok: true, activation } });
      return;
    }
    if (url.pathname === "/__api/env/reveal") {
      if (method !== "POST") return rejectUnexpected(["POST"]);
      const body = request.postDataJSON();
      const kind = body.key === "EXA_API_KEY"
        ? "reveal-tool-secret"
        : body.key === LATE_KEY
          ? "reveal-late-tool-secret"
          : body.key.endsWith("_BASE_URL")
            ? "reveal-provider-base-url"
            : "reveal-provider-secret";
      recordCall(state, {
        kind,
        method,
        backend: rawBackend,
        key: body.key,
        valueMatchesExpected: Object.keys(body).length === 1,
      });
      if (body.key === LATE_KEY) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const value = body.key.endsWith("_BASE_URL") ? state.provider.baseUrl : REVEALED_SENTINEL;
      await route.fulfill({ json: { value } });
      return;
    }
    if (url.pathname === "/__api/env/validate") {
      if (method !== "POST") return rejectUnexpected(["POST"]);
      const body = request.postDataJSON();
      recordCall(state, {
        kind: "validate-provider-secret",
        method,
        backend: rawBackend,
        key: body.key,
        valueMatchesExpected:
          body.key === "OPENROUTER_API_KEY" && body.value === INPUT_SENTINEL,
      });
      await route.fulfill({ json: { supported: true, valid: true } });
      return;
    }

    await rejectUnexpected();
  });
}

async function createHarness(browser, baseUrl, backend) {
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await context.addInitScript((selectedBackend) => {
    localStorage.setItem("openclaw.i18n.locale", "zh-CN");
    localStorage.setItem(
      "shoggoth.ui.v1",
      JSON.stringify({ version: 1, values: { "backend.models": selectedBackend } }),
    );
  }, backend);
  const page = await context.newPage();
  page.setDefaultTimeout(7_000);
  const state = createState(backend);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Credential reveal is desktop IPC only. Keep the browser fixture isolated
  // with a fake preload bridge; never reopen the retired HTTP secret route.
  await page.exposeFunction("__providerFixtureReveal", (owner, key, modelProvider) => {
    assert.equal(owner, backend);
    const baseUrl = !modelProvider && key.endsWith("_BASE_URL");
    recordCall(state, {
      kind: baseUrl ? "reveal-provider-base-url" : "reveal-provider-secret",
      method: "IPC", backend: owner, key, valueMatchesExpected: true,
    });
    return { ok: true, value: modelProvider
      ? { apiKey: REVEALED_SENTINEL }
      : { value: baseUrl ? state.provider.baseUrl : REVEALED_SENTINEL } };
  });
  await page.addInitScript(() => {
    window.openclawDesktop = {
      revealEnvVar: (owner, key) => window.__providerFixtureReveal(owner, key, false),
      revealModelProviderKey: (owner, key) => window.__providerFixtureReveal(owner, key, true),
    };
  });
  await installApiFake(page, state);
  await page.goto(`${baseUrl}/#/models`, { waitUntil: "domcontentloaded" });

  const providerTitle = backend === "hermes" ? "模型 Provider" : "模型 Provider（API Key）";
  await page.getByRole("heading", { name: providerTitle, exact: true }).waitFor();
  await page.locator("span").filter({ hasText: /^OpenRouter$/ }).first().waitFor();
  if (backend === "openclaw") {
    await page.getByText("Auth-only Custom", { exact: true }).waitFor();
    await page.getByText("Manual No URL", { exact: true }).waitFor();
  }
  const harness = { backend, context, page, pageErrors, state };
  assertHarnessClean(harness);
  return harness;
}

async function withHarnesses(browser, baseUrl, run) {
  const harnesses = [];
  try {
    harnesses.push(await createHarness(browser, baseUrl, "hermes"));
    harnesses.push(await createHarness(browser, baseUrl, "openclaw"));
  } catch (error) {
    await Promise.allSettled(harnesses.map(({ context }) => context.close()));
    throw error;
  }

  let result;
  let runError;
  try {
    result = await run(harnesses);
  } catch (error) {
    runError = error;
  }

  let harnessError;
  try {
    for (const harness of harnesses) assertHarnessClean(harness);
  } catch (error) {
    harnessError = error;
  }
  const closeResults = await Promise.allSettled(
    harnesses.map(({ context }) => context.close()),
  );
  const closeErrors = closeResults
    .filter((entry) => entry.status === "rejected")
    .map((entry) => entry.reason);
  if (harnessError) throw harnessError;
  if (closeErrors.length > 0) throw new AggregateError(closeErrors, "关闭 Playwright context 失败");
  if (runError) throw runError;
  return result;
}

function assertHarnessClean({ backend, pageErrors, state }) {
  assert.deepEqual(pageErrors, [], `${backend} fixture 触发了 React pageerror`);
  assert.deepEqual(
    state.unexpectedRequests,
    [],
    `${backend} fixture 收到未声明的 API 路由或 method`,
  );
}

async function actionButtonOrder(locator) {
  return locator.locator("button:not(.field-input)").evaluateAll((buttons) =>
    buttons.map((button) =>
      button.getAttribute("aria-label") || button.textContent?.trim() || "",
    ),
  );
}

function callCount(state, kind) {
  return state.calls.filter((call) => call.kind === kind).length;
}

function assertSingleCall(state, kind, expected) {
  const matching = state.calls.filter((call) => call.kind === kind);
  assert.deepEqual(matching, [{ kind, ...expected }], `${state.backend}: ${kind} 请求契约`);
}

async function confirmClear(page) {
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "清除", exact: true }).click();
}

async function exerciseProviderHarness(harness) {
  const { backend, page, state } = harness;
  const fields = page.locator("[data-provider-fields]").first();
  const slots = fields.locator(":scope > *");
  assert.equal(await slots.count(), 2, `${backend}: Provider 字段必须恰好为 Base URL → API Key`);
  const baseField = slots.nth(0);
  const secretField = slots.nth(1);

  await baseField.locator("button").first().click();
  const baseInput = baseField.locator("input");
  await baseInput.waitFor();
  assert.match(
    (await baseInput.getAttribute("aria-label")) || "",
    /base.?url|_BASE_URL/i,
    `${backend}: Provider 首字段必须是 Base URL`,
  );
  const baseEditButtons = await actionButtonOrder(baseField);
  assert.deepEqual(baseEditButtons, ["保存", "取消"], `${backend}: Base URL 编辑按钮顺序`);
  await baseInput.fill(EDITED_BASE_URL);
  await baseInput.press("Escape");
  await baseInput.waitFor({ state: "hidden" });
  assert.equal(callCount(state, "save-provider-base-url"), 0, `${backend}: Escape 不得保存 Base URL`);

  if (backend === "openclaw") {
    await baseField.locator("button").first().click();
    await baseInput.fill("ftp://invalid.example");
    const invalidSaveDisabled = await baseField.getByRole("button", { name: "保存", exact: true }).isDisabled();
    await baseInput.press("Enter");
    await page.waitForTimeout(100);
    const invalidSaveCalls = callCount(state, "save-provider-base-url");
    assert.deepEqual(
      { invalidSaveDisabled, invalidSaveCalls },
      { invalidSaveDisabled: true, invalidSaveCalls: 0 },
      "openclaw: 非 HTTP(S) Base URL 必须禁用保存且 Enter 不得提交",
    );
    await baseInput.press("Escape");
    await baseInput.waitFor({ state: "hidden" });
  }

  await baseField.locator("button").first().click();
  await baseInput.fill(EDITED_BASE_URL);
  await baseInput.press("Enter");
  await waitFor(() => callCount(state, "save-provider-base-url") === 1, `${backend} Enter 保存 Base URL`);
  assertSingleCall(state, "save-provider-base-url", {
    method: "PUT",
    backend,
    key: backend === "hermes" ? "OPENROUTER_BASE_URL" : "openrouter",
    valueMatchesExpected: true,
  });

  await secretField.locator("button").first().click();
  const secretInput = secretField.locator("input");
  await secretInput.waitFor();
  const secretInputLabel = (await secretInput.getAttribute("aria-label")) || "";
  assert.match(
    secretInputLabel,
    /api.?key|_API_KEY/i,
    `${backend}: Provider 第二字段必须是 API Key`,
  );
  const secretEditButtons = await actionButtonOrder(secretField);
  assert.deepEqual(
    secretEditButtons,
    ["校验", "保存", "取消"],
    `${backend}: API Key 编辑按钮顺序`,
  );
  await secretInput.fill(INPUT_SENTINEL);
  await secretField.getByRole("button", { name: "校验", exact: true }).click();
  await waitFor(
    () => callCount(state, "validate-provider-secret") === 1,
    `${backend} API Key validate`,
  );
  assertSingleCall(state, "validate-provider-secret", {
    method: "POST",
    backend,
    key: backend === "hermes" ? "OPENROUTER_API_KEY" : "openrouter",
    valueMatchesExpected: true,
  });
  await secretInput.press("Escape");
  await secretInput.waitFor({ state: "hidden" });

  const secretReadFieldLabel = await secretField.locator("button.field-input").getAttribute("aria-label");
  assert.ok(
    secretReadFieldLabel?.includes(secretInputLabel),
    `${backend}: API Key 读态编辑入口必须有可识别字段的 aria-label`,
  );
  const secretReadButtons = await actionButtonOrder(secretField);
  assert.deepEqual(
    secretReadButtons,
    ["查看明文", "清除"],
    `${backend}: API Key 读态按钮顺序`,
  );
  await secretField.getByRole("button", { name: "查看明文", exact: true }).click();
  await secretField.getByText(REVEALED_SENTINEL, { exact: true }).waitFor();
  assertSingleCall(state, "reveal-provider-secret", {
    method: "IPC",
    backend,
    key: backend === "hermes" ? "OPENROUTER_API_KEY" : "openrouter",
    valueMatchesExpected: true,
  });
  await secretField.getByRole("button", { name: "隐藏", exact: true }).click();
  await secretField.getByRole("button", { name: "查看明文", exact: true }).waitFor();

  await secretField.locator("button").first().click();
  await secretInput.fill(INPUT_SENTINEL);
  await secretInput.press("Enter");
  await waitFor(() => callCount(state, "save-provider-secret") === 1, `${backend} Enter 保存 API Key`);
  assertSingleCall(state, "save-provider-secret", {
    method: "PUT",
    backend,
    key: backend === "hermes" ? "OPENROUTER_API_KEY" : "openrouter",
    valueMatchesExpected: true,
  });

  await secretField.getByRole("button", { name: "清除", exact: true }).click();
  await confirmClear(page);
  await waitFor(() => callCount(state, "clear-provider-secret") === 1, `${backend} 清除 API Key`);
  assertSingleCall(state, "clear-provider-secret", {
    method: backend === "hermes" ? "DELETE" : "PUT",
    backend,
    key: backend === "hermes" ? "OPENROUTER_API_KEY" : "openrouter",
    valueMatchesExpected: true,
  });
  assertHarnessClean(harness);

  return {
    baseEditButtons,
    secretEditButtons,
    secretReadButtons,
  };
}

async function providerScenario(browser, baseUrl) {
  await withHarnesses(browser, baseUrl, async (harnesses) => {
    const layoutByBackend = {};
    for (const { backend, page } of harnesses) {
      const providerTitle = backend === "hermes" ? "模型 Provider" : "模型 Provider（API Key）";
      const titles = ["Provider 登录（OAuth）", providerTitle, "自定义端点"];
      const cards = [];
      for (const title of titles) {
        const heading = title === "自定义端点"
          ? page.getByText(title, { exact: true })
          : page.getByRole("heading", { name: title, exact: true });
        assert.equal(await heading.count(), 1, `${backend}: 缺少唯一卡片 ${title}`);
        cards.push(await heading.evaluate((element) => {
          const section = element.closest("section");
          if (!section) throw new Error("heading is not inside a section");
          const rect = section.getBoundingClientRect();
          const style = getComputedStyle(section);
          return {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            paddingLeft: style.paddingLeft,
            paddingRight: style.paddingRight,
            borderRadius: style.borderRadius,
          };
        }));
      }
      assert.ok(
        cards.every((card, index) => index === 0 || card.top > cards[index - 1].top),
        `${backend}: 卡片顺序必须是 OAuth → Provider → 自定义端点`,
      );
      assert.equal(new Set(cards.map((card) => card.left)).size, 1, `${backend}: 卡片左边缘未对齐`);
      assert.equal(new Set(cards.map((card) => card.width)).size, 1, `${backend}: 卡片宽度不一致`);
      assert.equal(new Set(cards.map((card) => card.paddingLeft)).size, 1, `${backend}: 卡片左 padding 不一致`);
      assert.equal(new Set(cards.map((card) => card.paddingRight)).size, 1, `${backend}: 卡片右 padding 不一致`);
      assert.equal(new Set(cards.map((card) => card.borderRadius)).size, 1, `${backend}: 卡片圆角不一致`);
      const field = page.locator("[data-provider-fields] .field-input");
      assert.ok(await field.count() >= 2, `${backend}: Provider 字段不足`);
      const fieldHeight = await field.first().evaluate((element) =>
        Math.round(element.getBoundingClientRect().height));
      layoutByBackend[backend] = {
        width: cards[0].width,
        paddingLeft: cards[0].paddingLeft,
        paddingRight: cards[0].paddingRight,
        borderRadius: cards[0].borderRadius,
        fieldHeight,
      };
    }
    assert.deepEqual(
      layoutByBackend.hermes,
      layoutByBackend.openclaw,
      "Hermes/OpenClaw 卡宽、内边距、圆角与字段高度必须一致",
    );

    const markerCounts = Object.fromEntries(
      await Promise.all(
        harnesses.map(async ({ backend, page }) => [
          backend,
          await page.locator("[data-provider-fields]").count(),
        ]),
      ),
    );
    assert.deepEqual(
      markerCounts,
      { hermes: 1, openclaw: 3 },
      "每个可见 Provider 都必须使用 data-provider-fields 共享结构",
    );

    const results = [];
    for (const harness of harnesses) {
      try { results.push(await exerciseProviderHarness(harness)); }
      catch (error) { throw new Error(`${harness.backend}: ${formatError(error)}\nCalls: ${JSON.stringify(harness.state.calls)}`); }
    }
    assert.deepEqual(results[0], results[1], "Provider 两后端的字段及按钮顺序必须一致");
  });
}

async function exerciseToolHarness(harness) {
  const { backend, page, state } = harness;
  const row = page.locator("[data-tool-key-row]").filter({ hasText: "EXA_API_KEY" }).first();
  const readButtons = await actionButtonOrder(row);
  assert.deepEqual(
    readButtons,
    ["查看明文", "替换", "清除"],
    `${backend}: 工具密钥读态按钮顺序`,
  );
  const valueDisplay = row.getByText(REDACTED, { exact: true });
  assert.equal(
    await valueDisplay.evaluate((element) => element.closest("button") === null),
    true,
    `${backend}: 工具密钥值必须是只读展示，不能兼作编辑按钮`,
  );

  await row.getByRole("button", { name: "查看明文", exact: true }).click();
  await row.getByText(REVEALED_SENTINEL, { exact: true }).waitFor();
  assertSingleCall(state, "reveal-tool-secret", {
    method: "POST",
    backend,
    key: "EXA_API_KEY",
    valueMatchesExpected: true,
  });
  await row.getByRole("button", { name: "隐藏", exact: true }).click();
  await row.getByRole("button", { name: "查看明文", exact: true }).waitFor();

  await row.getByRole("button", { name: "替换", exact: true }).click();
  const input = row.locator("input");
  await input.waitFor();
  const editButtons = await actionButtonOrder(row);
  assert.deepEqual(
    editButtons,
    backend === "hermes" ? ["保存", "校验", "取消"] : ["保存", "取消"],
    `${backend}: 工具密钥编辑态按钮顺序`,
  );
  await input.fill(INPUT_SENTINEL);
  await input.press("Escape");
  await input.waitFor({ state: "hidden" });
  assert.equal(callCount(state, "save-tool-secret"), 0, `${backend}: Escape 不得保存工具密钥`);

  await row.getByRole("button", { name: "替换", exact: true }).click();
  await input.fill(INPUT_SENTINEL);
  await input.press("Enter");
  await waitFor(() => callCount(state, "save-tool-secret") === 1, `${backend} Enter 保存工具密钥`);
  assertSingleCall(state, "save-tool-secret", {
    method: "PUT",
    backend,
    key: "EXA_API_KEY",
    valueMatchesExpected: true,
  });

  await row.getByRole("button", { name: "清除", exact: true }).click();
  await confirmClear(page);
  await waitFor(() => callCount(state, "clear-tool-secret") === 1, `${backend} 清除工具密钥`);
  assertSingleCall(state, "clear-tool-secret", {
    method: "DELETE",
    backend,
    key: "EXA_API_KEY",
    valueMatchesExpected: true,
  });
  assertHarnessClean(harness);

  return {
    readButtons,
  };
}

async function exerciseDelayedRevealHarness(harness) {
  const { backend, page } = harness;
  const row = page.locator("[data-tool-key-row]").filter({ hasText: LATE_KEY }).first();
  await row.getByRole("button", { name: "查看明文", exact: true }).click();
  await row.getByRole("button", { name: "替换", exact: true }).click();
  const input = row.locator("input");
  await input.fill(INPUT_SENTINEL);
  await input.press("Enter");
  await row.getByText(REDACTED_AFTER_SAVE, { exact: true }).waitFor();
  await page.waitForTimeout(450);
  assert.equal(
    await row.getByText(REVEALED_SENTINEL, { exact: true }).count(),
    0,
    `${backend}: 行身份变化后迟到 reveal 不得重新显示明文`,
  );
}

async function exerciseOpenClawAdd(harness) {
  const { page, state } = harness;
  const card = page.getByRole("heading", { name: "工具密钥", exact: true })
    .locator("xpath=ancestor::section");
  const addButton = card.getByRole("button", { name: "添加变量", exact: true });

  await addButton.click();
  let inputs = card.locator("input");
  await inputs.nth(0).fill("temporary_key");
  await inputs.nth(1).fill("temporary-value");
  await inputs.nth(1).press("Escape");
  await inputs.nth(0).waitFor({ state: "hidden" });

  await addButton.click();
  inputs = card.locator("input");
  await inputs.nth(0).waitFor();
  assert.deepEqual(
    await inputs.evaluateAll((elements) => elements.map((element) => element.value)),
    ["", ""],
    "OpenClaw: Escape 取消新增后必须立即清空 key/value",
  );

  await inputs.nth(0).fill(ADDED_KEY);
  await inputs.nth(1).fill(ADDED_VALUE);
  state.delayNextAdd = true;
  await card.getByRole("button", { name: "保存", exact: true }).click();
  assert.equal(
    await card.getByRole("button", { name: "取消", exact: true }).isDisabled(),
    true,
    "OpenClaw: 新增请求在途时必须禁用取消，避免迟到响应恢复敏感表单状态",
  );
  await waitFor(() => callCount(state, "add-tool-secret") === 1, "OpenClaw 添加工具密钥");
  assertSingleCall(state, "add-tool-secret", {
    method: "PUT",
    backend: "openclaw",
    key: ADDED_KEY,
    valueMatchesExpected: true,
  });
  await page.locator("[data-tool-key-row]").filter({ hasText: ADDED_KEY }).waitFor();
  await page.getByText("改动已保存到配置。重启网关后新模型才会出现在聊天可用列表。", {
    exact: true,
  }).waitFor();
}

async function toolKeysScenario(browser, baseUrl) {
  await withHarnesses(browser, baseUrl, async (harnesses) => {
    const markerCounts = Object.fromEntries(
      await Promise.all(
        harnesses.map(async ({ backend, page }) => [
          backend,
          await page.locator("[data-tool-key-row]").filter({ hasText: "EXA_API_KEY" }).count(),
        ]),
      ),
    );
    assert.deepEqual(
      markerCounts,
      { hermes: 0, openclaw: 0 },
      "工具密钥隐藏时两后端都不得渲染 data-tool-key-row",
    );
    for (const { backend, page, state } of harnesses) {
      assert.equal(
        await page.getByRole("heading", { name: "工具密钥", exact: true }).count(),
        0,
        `${backend}: 工具密钥卡片必须保持可逆隐藏`,
      );
      assert.equal(
        state.calls.some(({ kind }) => kind.includes("tool-secret")),
        false,
        `${backend}: 隐藏工具密钥不得触发读取或写入`,
      );
    }
  });
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: uiRoot, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (chunk) => {
  serverLog += chunk;
});
server.stderr.on("data", (chunk) => {
  serverLog += chunk;
});

let browser;
let serverStoppedByHarness = false;
const failures = [];
try {
  await waitFor(async () => {
    if (server.exitCode !== null) throw new Error(`Vite 提前退出 (${server.exitCode})`);
    try {
      return (await fetch(baseUrl)).ok;
    } catch {
      return false;
    }
  }, "Vite 服务启动", 10_000);
  browser = await chromium.launch({ channel: "chrome" });

  if (runProvider) {
    try {
      await providerScenario(browser, baseUrl);
    } catch (error) {
      failures.push(`provider: ${formatError(error)}`);
    }
  }
  if (runToolKeys) {
    try {
      await toolKeysScenario(browser, baseUrl);
    } catch (error) {
      failures.push(`tool-keys: ${formatError(error)}`);
    }
  }
} catch (error) {
  failures.push(`runtime: ${formatError(error)}`);
} finally {
  let browserCloseError;
  try {
    if (browser) await browser.close();
  } catch (error) {
    browserCloseError = error;
  } finally {
    try {
      serverStoppedByHarness = !processExited(server);
      await stopProcess(server);
    } catch (error) {
      failures.push(`vite cleanup: ${formatError(error)}`);
    }
  }
  if (browserCloseError) failures.push(`browser cleanup: ${formatError(browserCloseError)}`);
}

if (!serverStoppedByHarness && server.exitCode && server.exitCode !== 0) {
  failures.push(`Vite exited with ${server.exitCode}${serverLog ? `\n${serverLog}` : ""}`);
}
if (failures.length > 0) {
  console.error(`models provider parity regression: FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const scenarios = [runProvider && "provider", runToolKeys && "tool-keys"].filter(Boolean);
  console.log(`models provider parity regression: PASS (${scenarios.join(", ")})`);
}
