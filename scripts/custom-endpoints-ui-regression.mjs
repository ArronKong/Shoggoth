#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const viteBin = path.join(uiRoot, "node_modules/vite/bin/vite.js");
const controllerPath = path.join(
  uiRoot,
  "src/pages/models/endpoint-controller.ts",
);
const panelPath = path.join(
  uiRoot,
  "src/pages/models/CustomEndpointsPanel.tsx",
);
const modalPath = path.join(
  uiRoot,
  "src/pages/models/EndpointModal.tsx",
);
const requested = new Set(process.argv.slice(2));
const knownFlags = new Set(["--controller", "--ui"]);
const unknownFlags = [...requested].filter((flag) => !knownFlags.has(flag));
if (unknownFlags.length > 0) {
  console.error(`custom endpoints UI regression: unknown option ${unknownFlags.join(", ")}`);
  process.exit(2);
}
const runController = requested.size === 0 || requested.has("--controller");
const runUi = requested.size === 0 || requested.has("--ui");

async function source(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function assertControllerSource(controller) {
  for (const exportedName of [
    "EndpointMutationStep",
    "EndpointMutationOutcome",
    "EndpointRecoveryView",
    "EndpointMutationSession",
  ]) {
    assert.match(
      controller,
      new RegExp(`export (?:type|interface) ${exportedName}`),
      `缺少导出契约 ${exportedName}`,
    );
  }
  assert.match(
    controller,
    /export interface EndpointController/,
    "缺少共享 EndpointController 契约",
  );
  assert.match(
    controller,
    /sync:\s*["']synced["']\s*\|\s*["']pending["']/,
    "Outcome 必须显式区分 synced/pending",
  );
  assert.match(
    controller,
    /createEndpointMutationSession/,
    "缺少稳定 root operation/session helper",
  );
  assert.match(
    controller,
    /isEndpointMutationComplete/,
    "缺少纯 outcome 完成门",
  );
  assert.match(
    controller,
    /createHermesEndpointController/,
    "缺少 Hermes REST controller 适配器",
  );
  const safeReference = controller.match(
    /export (?:type|interface) EndpointSafeReference\b[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(safeReference, /\bstore\s*:/, "安全引用缺少 store");
  for (const key of ["referenceKey", "scope", "agent", "profile"]) {
    assert.match(safeReference, new RegExp(`\\b${key}\\?\\s*:`), `安全引用缺少 ${key}`);
  }
  assert.doesNotMatch(
    safeReference,
    /\b(?:secret|apiKey|config|body|value)\b/i,
    "安全引用不得携带 secret/config body",
  );
}

function assertUiSource(panel, modal) {
  assert.match(
    panel,
    /controller:\s*EndpointController/,
    "CustomEndpointsPanel 尚未接收 controller",
  );
  assert.doesNotMatch(
    panel,
    /import\s*\{[^}]*\b(?:listCustomEndpoints|deleteCustomEndpoint)\b[^}]*\}\s*from\s*["'][^"']*api\/client["']/s,
    "Panel 不得直接调用 endpoint list/delete API",
  );
  assert.match(
    modal,
    /controller:\s*EndpointController/,
    "EndpointModal 尚未接收 controller",
  );
  assert.doesNotMatch(
    modal,
    /import\s*\{[^}]*\b(?:saveCustomEndpoint|validateCustomEndpoint)\b[^}]*\}\s*from\s*["'][^"']*api\/client["']/s,
    "Modal 不得直接调用 endpoint save/validate API",
  );
  assert.match(
    modal,
    /isEndpointMutationComplete/,
    "Modal 必须复用 applied + synced + snapshot 完成门",
  );
  assert.match(modal, /recoveryLocked/, "部分成功后 Modal 必须进入锁定恢复态");
  assert.match(modal, /controller\.retry/, "恢复态必须复用冻结 session 重试");
  assert.match(modal, /recoveryNeedsSecret/, "needs_secret 只能补充密钥");
  assert.match(modal, /controller\.confirmBlockedRemoval/, "模型引用阻塞必须支持二次确认");
  assert.match(modal, /mutationEpoch/, "Modal 必须忽略卸载或 controller 切换后的迟到响应");
  assert.match(panel, /mutationEpoch/, "Panel 删除必须忽略 controller 切换后的迟到响应");
  assert.match(panel, /deleteRecovery/, "整端点删除恢复必须保留原 session/operation id");
  assert.match(panel, /controller\.retry\(session\)/, "整端点删除必须复用原 session 重试");
  assert.match(panel, /disabled=\{Boolean\(deleteRecovery\)\}/, "删除恢复期间必须禁用端点编辑");
  assert.match(modal, /controller\.release/, "关闭或完成后必须释放冻结计划和密钥");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
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
  child.kill("SIGKILL");
  if (!(await waitForProcessExit(child, 1_500))) {
    throw new Error("Vite 进程 SIGKILL 后仍未退出");
  }
}

async function waitForVite(baseUrl, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (processExited(child)) {
      throw new Error(`Vite 提前退出：${stderr.join("")}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Vite 尚未监听。
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`等待 Vite 启动超时：${stderr.join("")}`);
}

function loadChromium() {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.join(root, "node_modules/playwright"),
    path.join(uiRoot, "node_modules/playwright"),
    path.join(os.homedir(), "node_modules/playwright"),
    path.join(os.homedir(), ".openclaw/workspace/node_modules/playwright"),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate).chromium;
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("找不到 Playwright；请先安装项目测试依赖");
}

function browserLaunchOptions() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

async function runControllerRuntime() {
  const chromium = loadChromium();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const viteStderr = [];
  const vite = spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: uiRoot,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  vite.stderr.on("data", (chunk) => viteStderr.push(String(chunk)));

  let browser;
  let context;
  try {
    await waitForVite(baseUrl, vite, viteStderr);
    browser = await chromium.launch(browserLaunchOptions());
    context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    const calls = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/__api/models/endpoints**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const body = request.postData() ? request.postDataJSON() : null;
      calls.push({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
      });
      if (url.pathname === "/__api/models/endpoints/validate") {
        await route.fulfill({
          json: {
            ok: true,
            reachable: true,
            message: "",
            models: ["fixture-model"],
          },
        });
        return;
      }
      if (method === "GET") {
        await route.fulfill({
          json: {
            supported: true,
            endpoints: [],
            profiles: ["default"],
          },
        });
        return;
      }
      if (method === "POST") {
        await route.fulfill({
          json: {
            supported: true,
            endpoints: [
              {
                id: "fixture",
                name: "Fixture",
                baseUrl: "https://fixture.test/v1",
                model: "fixture-model",
                models: ["fixture-model"],
                hasApiKey: true,
                apiKeyPreview: "••••safe",
                discoverModels: false,
              },
            ],
            profiles: ["default"],
          },
        });
        return;
      }
      if (method === "DELETE") {
        await route.fulfill({
          json: {
            supported: true,
            endpoints: [],
            profiles: ["default"],
          },
        });
        return;
      }
      await route.abort("failed");
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async () => {
      const module = await import("/src/pages/models/endpoint-controller.ts");
      const controller = module.createHermesEndpointController("hermes fixture");
      const input = {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.test/v1",
        model: "fixture-model",
        models: ["fixture-model"],
        apiKey: "do-not-leak-secret",
        discoverModels: false,
      };
      const endpoint = {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.test/v1",
        model: "fixture-model",
        models: ["fixture-model"],
        hasApiKey: true,
        discoverModels: false,
      };
      const list = await controller.list();
      const validation = await controller.validate(input);
      const saveSession = module.createEndpointMutationSession(
        "hermes fixture",
        "edit",
        "endpoint-root-save",
      );
      const save = await controller.save(input, saveSession);
      const deleteSession = module.createEndpointMutationSession(
        "hermes fixture",
        "delete",
        "endpoint-root-delete",
      );
      const remove = await controller.remove(endpoint, deleteSession, true);
      const completeCases = {
        applied: module.isEndpointMutationComplete(save),
        partial: module.isEndpointMutationComplete({
          ...save,
          status: "partial",
        }),
        pending: module.isEndpointMutationComplete({
          ...save,
          sync: "pending",
        }),
        missingSnapshot: module.isEndpointMutationComplete({
          ...save,
          snapshot: undefined,
        }),
      };
      return {
        backend: controller.backend,
        optionalCapabilities: {
          reveal: typeof controller.revealApiKey,
          clear: typeof controller.clearApiKey,
        },
        list,
        validation,
        saveSession,
        save,
        deleteSession,
        remove,
        completeCases,
      };
    });

    assert.equal(result.backend, "hermes fixture");
    assert.deepEqual(result.optionalCapabilities, {
      reveal: "undefined",
      clear: "undefined",
    });
    assert.equal(result.list.supported, true);
    assert.deepEqual(result.validation.models, ["fixture-model"]);
    assert.equal(result.saveSession.rootOperationId, "endpoint-root-save");
    assert.deepEqual(result.saveSession, {
      rootOperationId: "endpoint-root-save",
      backend: "hermes fixture",
      kind: "edit",
    });
    assert.equal(result.save.operationId, result.saveSession.rootOperationId);
    assert.equal(result.remove.operationId, result.deleteSession.rootOperationId);
    for (const outcome of [result.save, result.remove]) {
      assert.equal(outcome.status, "applied");
      assert.equal(outcome.stage, "commit");
      assert.equal(outcome.sync, "synced");
      assert.ok(outcome.snapshot);
      assert.deepEqual(outcome.steps, []);
      assert.doesNotMatch(
        JSON.stringify(outcome),
        /do-not-leak-secret/,
        "Hermes outcome 不得回显输入 secret",
      );
    }
    assert.deepEqual(result.completeCases, {
      applied: true,
      partial: false,
      pending: false,
      missingSnapshot: false,
    });
    assert.deepEqual(calls, [
      {
        method: "GET",
        path: "/__api/models/endpoints",
        query: { backend: "hermes fixture" },
        body: null,
      },
      {
        method: "POST",
        path: "/__api/models/endpoints/validate",
        query: { backend: "hermes fixture" },
        body: {
          id: "fixture",
          name: "Fixture",
          baseUrl: "https://fixture.test/v1",
          model: "fixture-model",
          models: ["fixture-model"],
          apiKey: "do-not-leak-secret",
          discoverModels: false,
        },
      },
      {
        method: "POST",
        path: "/__api/models/endpoints",
        query: { backend: "hermes fixture" },
        body: {
          id: "fixture",
          name: "Fixture",
          baseUrl: "https://fixture.test/v1",
          model: "fixture-model",
          models: ["fixture-model"],
          apiKey: "do-not-leak-secret",
          discoverModels: false,
        },
      },
      {
        method: "DELETE",
        path: "/__api/models/endpoints",
        query: { backend: "hermes fixture", id: "fixture" },
        body: null,
      },
    ]);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopProcess(vite);
  }
}

async function runUiRuntime() {
  const chromium = loadChromium();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const viteStderr = [];
  const vite = spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: uiRoot,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  vite.stderr.on("data", (chunk) => viteStderr.push(String(chunk)));

  let browser;
  let context;
  try {
    await waitForVite(baseUrl, vite, viteStderr);
    browser = await chromium.launch(browserLaunchOptions());
    context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const result = await page.evaluate(async () => {
      const ReactModule = await import("/node_modules/.vite/deps/react.js");
      const React = ReactModule.default ?? ReactModule;
      const ReactDomModule = await import("/node_modules/.vite/deps/react-dom_client.js");
      const createRoot = ReactDomModule.createRoot ?? ReactDomModule.default?.createRoot;
      const ReactDomCore = await import("/node_modules/.vite/deps/react-dom.js");
      const flushSync = ReactDomCore.flushSync ?? ReactDomCore.default?.flushSync;
      const [{ default: CustomEndpointsPanel }, { default: EndpointModal }, { UiProvider }, i18nModule] =
        await Promise.all([
          import("/src/pages/models/CustomEndpointsPanel.tsx"),
          import("/src/pages/models/EndpointModal.tsx"),
          import("/src/components/ui.tsx"),
          import("/src/i18n/index.ts"),
        ]);
      await i18nModule.default.changeLanguage("en");

      const waitFor = async (predicate, message, timeout = 2_500) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const value = predicate();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        throw new Error(message);
      };
      const endpoint = (id, extra = {}) => ({
        id,
        name: id === "old" ? "Old endpoint" : id === "new" ? "New endpoint" : `Endpoint ${id}`,
        baseUrl: `https://${id}.test/v1`,
        model: `${id}-model`,
        models: [`${id}-model`],
        hasApiKey: true,
        apiKeyPreview: "••••safe",
        discoverModels: false,
        ...extra,
      });
      const snapshot = (items, form) => ({
        supported: true,
        endpoints: items,
        profiles: ["default"],
        ...(form ? { form } : {}),
      });
      const outcome = (operationId, overrides = {}) => ({
        operationId,
        status: "partial",
        code: "fixture_partial",
        stage: "commit",
        sync: "synced",
        steps: [],
        ...overrides,
      });
      const deferred = () => {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      };
      const mount = () => {
        document.body.innerHTML = '<div id="ui-test-root"></div>';
        return createRoot(document.getElementById("ui-test-root"));
      };
      const render = (root, child) => {
        flushSync(() => {
          root.render(React.createElement(UiProvider, null, child));
        });
      };
      const clickButton = (label) => {
        const button = [...document.querySelectorAll("button")].find(
          (item) => item.textContent?.trim() === label,
        );
        if (!button) throw new Error(`missing button: ${label}`);
        button.click();
        return button;
      };
      const clickButtonContaining = (label) => {
        const button = [...document.querySelectorAll("button")].find(
          (item) => item.textContent?.includes(label),
        );
        if (!button) throw new Error(`missing button containing: ${label}`);
        button.click();
        return button;
      };
      const confirmDanger = async () => {
        const dialog = await waitFor(
          // 上一轮确认框会为退场动画继续挂载 160ms；只操作当前可交互的新实例，
          // 否则程序化 click 会命中 inert 的旧按钮并被 requestId 守卫正确忽略。
          () => document.querySelector('[role="alertdialog"]:not([inert])'),
          "confirmation dialog did not open",
        );
        const button = [...dialog.querySelectorAll("button")].find(
          (item) => item.classList.contains("btn-danger"),
        );
        if (!button) throw new Error("danger confirmation button missing");
        button.click();
      };
      const clickSave = async () => {
        const button = await waitFor(
          () => [...document.querySelectorAll("button")].find(
            (item) => item.textContent?.trim() === "Save" && !item.disabled,
          ),
          "enabled Save button missing",
        );
        button.click();
      };

      // 列表必须只走 controller；同 controller 失败保留旧快照，身份切换隔离迟到响应并关窗。
      let listCalls = 0;
      const lateA = deferred();
      const pendingB = deferred();
      const controllerA = {
        backend: "backend-a",
        list() {
          listCalls += 1;
          if (listCalls === 1) return Promise.resolve(snapshot([endpoint("old")]));
          if (listCalls === 2) return Promise.reject(new Error("same backend failed"));
          return lateA.promise;
        },
        validate: async () => ({ ok: true, reachable: true, message: "", models: [] }),
        save: async (_input, session) => outcome(session.rootOperationId),
        remove: async (_item, session) => outcome(session.rootOperationId),
      };
      const controllerB = {
        ...controllerA,
        backend: "backend-b",
        list: () => pendingB.promise,
      };
      let root = mount();
      const panelProps = (controller, active = true) =>
        React.createElement(CustomEndpointsPanel, {
          key: controller.backend,
          controller,
          active,
          onChanged() {},
        });
      render(root, panelProps(controllerA));
      await waitFor(() => document.body.textContent.includes("Old endpoint"), "controller list was not rendered");
      render(root, panelProps(controllerA, false));
      await new Promise((resolve) => setTimeout(resolve, 30));
      render(root, panelProps(controllerA, true));
      await waitFor(() => listCalls === 2, "same-controller reload did not run");
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (!document.body.textContent.includes("Old endpoint")) {
        throw new Error("same-controller list rejection discarded the prior snapshot");
      }
      clickButtonContaining("Old endpoint");
      await waitFor(() => document.querySelector('[role="dialog"]'), "edit modal did not open");
      render(root, panelProps(controllerA, false));
      await new Promise((resolve) => setTimeout(resolve, 30));
      render(root, panelProps(controllerA, true));
      await waitFor(() => listCalls === 3, "late list request was not started");
      render(root, panelProps(controllerB));
      await waitFor(
        () => (
          !document.body.textContent.includes("Edit endpoint")
          && !document.body.textContent.includes("Old endpoint")
        ),
        `controller identity switch retained old backend UI: ${document.body.textContent}`,
      );
      lateA.resolve(snapshot([endpoint("old")]));
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (document.body.textContent.includes("Old endpoint")) {
        throw new Error("late old-controller list response leaked into the new backend");
      }
      pendingB.resolve(snapshot([endpoint("new")]));
      await waitFor(() => document.body.textContent.includes("New endpoint"), "new controller snapshot missing");
      root.unmount();

      // 同一端点在上一轮退场未完成前快速重开，也必须获得全新的表单与 mutation session。
      const reopenEndpoint = endpoint("reopen", { name: "Reopen endpoint" });
      const reopenSnapshot = snapshot([reopenEndpoint]);
      const reopenController = {
        backend: "reopen-backend",
        list: async () => reopenSnapshot,
        validate: async () => ({ ok: true, reachable: true, message: "", models: [] }),
        save: async (_input, session) => outcome(session.rootOperationId),
        remove: async (_item, session) => outcome(session.rootOperationId),
      };
      root = mount();
      render(
        root,
        React.createElement(CustomEndpointsPanel, {
          controller: reopenController,
          active: true,
          onChanged() {},
        }),
      );
      await waitFor(() => document.body.textContent.includes("Reopen endpoint"), "reopen fixture did not list");
      clickButtonContaining("Reopen endpoint");
      let reopenDialog = await waitFor(
        () => document.querySelector('[role="dialog"]'),
        "reopen modal did not open",
      );
      const reopenName = [...reopenDialog.querySelectorAll("label")]
        .find((field) => field.textContent.includes("Name"))?.querySelector("input");
      if (!reopenName) throw new Error("reopen modal name field missing");
      const setNativeInputValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!setNativeInputValue) throw new Error("native input value setter missing");
      setNativeInputValue.call(reopenName, "Stale form value");
      reopenName.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => reopenName.value === "Stale form value", "reopen fixture input did not update");
      reopenDialog.querySelector('button[aria-label="Close"]')?.click();
      // 不等 160ms ending 完成，直接触发被遮罩挡住的同一行，覆盖生命周期反转路径。
      document.querySelectorAll("[inert]").forEach((node) => node.removeAttribute("inert"));
      const reopenRow = document.querySelector('button[class*="endpointMain"]');
      if (!reopenRow) throw new Error("reopen endpoint row missing");
      reopenRow.click();
      reopenDialog = await waitFor(
        () => {
          const dialog = document.querySelector('[role="dialog"]');
          const input = dialog && [...dialog.querySelectorAll("label")]
            .find((field) => field.textContent.includes("Name"))?.querySelector("input");
          return input && input !== reopenName ? dialog : null;
        },
        "rapidly reopened modal did not remount its form",
      );
      const reopenedName = [...reopenDialog.querySelectorAll("label")]
        .find((field) => field.textContent.includes("Name"))?.querySelector("input");
      if (reopenedName?.value !== "Reopen endpoint") {
        throw new Error(`rapid reopen reused stale endpoint form: ${reopenedName?.value}`);
      }
      root.unmount();

      // Modal 能力与完成门：只在 applied+synced+snapshot 时关闭；所有重试复用 session。
      const modalEndpoint = endpoint("caps", {
        name: "Locked name",
        api: "chat-completions",
        canRevealApiKey: true,
        canClearApiKey: true,
      });
      const modalSnapshot = snapshot([modalEndpoint], {
        nameEditable: false,
        apiOptions: ["chat-completions", "responses"],
        defaultApi: "responses",
        firstModelIsDefault: false,
      });
      const saveCalls = [];
      const clearCalls = [];
      const activations = [];
      let savedCount = 0;
      let saveIndex = 0;
      const modalController = {
        backend: "caps-backend",
        list: async () => modalSnapshot,
        validate: async () => ({ ok: true, reachable: true, message: "", models: ["caps-model"] }),
        revealApiKey: async () => "sk-visible-fixture",
        clearApiKey: async (_item, session) => {
          clearCalls.push(session);
          return outcome(session.rootOperationId, {
            status: "cleanup_pending",
            code: "cleanup_pending",
          });
        },
        save: async (input, session) => {
          saveCalls.push({ input, session });
          saveIndex += 1;
          if (saveIndex === 1) {
            return outcome(session.rootOperationId, {
              activation: { kind: "gateway_restart", available: true },
            });
          }
          if (saveIndex === 2) {
            return outcome(session.rootOperationId, {
              status: "applied",
              code: undefined,
              sync: "pending",
              snapshot: modalSnapshot,
            });
          }
          return outcome(session.rootOperationId, {
            status: "applied",
            code: undefined,
            sync: "synced",
            snapshot: modalSnapshot,
          });
        },
        remove: async (_item, session) => outcome(session.rootOperationId),
      };
      root = mount();
      render(
        root,
        React.createElement(EndpointModal, {
          open: true,
          controller: modalController,
          snapshot: modalSnapshot,
          endpoint: modalEndpoint,
          onClose() {},
          onOpenChangeComplete() {},
          onSaved() {
            savedCount += 1;
          },
          onActivation(value) {
            activations.push(value);
          },
        }),
      );
      await waitFor(() => document.querySelector('[role="dialog"]'), "capability modal missing");
      const fields = [...document.querySelectorAll("label.field")];
      const nameInput = fields.find((field) => field.textContent.includes("Name"))?.querySelector("input");
      const idInput = fields.find((field) => field.textContent.includes("Provider ID"))?.querySelector("input");
      if (!nameInput?.disabled || !idInput?.disabled) {
        throw new Error("nameEditable:false edit fields are not read-only");
      }
      if (document.body.textContent.includes("default") || document.querySelector("[class*='chipDefault']")) {
        throw new Error("firstModelIsDefault:false still claims a default model");
      }
      clickButton("Advanced");
      await waitFor(() => document.body.textContent.includes("API protocol"), "advanced API control did not expand");
      clickButton("Reveal");
      await waitFor(() => document.body.textContent.includes("sk-visible-fixture"), "revealed key preview missing");
      clickButton("Hide");
      await waitFor(
        () => !document.body.textContent.includes("sk-visible-fixture"),
        "hidden key remains visible",
      );
      clickButton("Clear key");
      await confirmDanger();
      await waitFor(() => clearCalls.length === 1, "clear-key controller was not called");
      if (!document.querySelector('[role="dialog"]')) throw new Error("noncomplete clear closed the modal");
      clickButton("Clear key");
      await confirmDanger();
      await waitFor(() => clearCalls.length === 2, "clear-key retry was not called");
      if (clearCalls[0].rootOperationId !== clearCalls[1].rootOperationId) {
        throw new Error("clear-key retries did not reuse the mutation session");
      }
      await waitFor(
        () => [...document.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Save" && !button.disabled,
        ),
        "save did not recover after clear-key retry",
      );
      await clickSave();
      await waitFor(() => saveCalls.length === 1, "partial save was not called");
      if (!document.querySelector('[role="dialog"]') || savedCount !== 0) {
        throw new Error("partial save passed the completion gate");
      }
      await clickSave();
      await waitFor(() => saveCalls.length === 2, "sync-pending save was not called");
      if (!document.querySelector('[role="dialog"]') || savedCount !== 0) {
        throw new Error("sync-pending save passed the completion gate");
      }
      await clickSave();
      await waitFor(() => savedCount === 1, "complete save did not call onSaved");
      if (new Set(saveCalls.map((call) => call.session.rootOperationId)).size !== 1) {
        throw new Error("save retries did not reuse the mutation session");
      }
      if (saveCalls.some((call) => Object.hasOwn(call.input, "api"))) {
        throw new Error("unchanged/collapsed API protocol was submitted");
      }
      if (activations.length !== 1) throw new Error("partial outcome activation was not surfaced immediately");
      root.unmount();

      // 删除：仅 references_exist 可二次 force，安全引用可见，且两次调用复用 session。
      const deleteCalls = [];
      let changedCount = 0;
      const deleteController = {
        backend: "delete-backend",
        list: async () => snapshot([endpoint("delete")]),
        validate: async () => ({ ok: true, reachable: true, message: "", models: [] }),
        save: async (_input, session) => outcome(session.rootOperationId),
        remove: async (_item, session, force) => {
          deleteCalls.push({ session, force });
          if (!force) {
            return outcome(session.rootOperationId, {
              status: "blocked",
              code: "references_exist",
              recovery: {
                code: "references_exist",
                references: [{
                  store: "agents.json",
                  referenceKey: "model.primary",
                  scope: "agent",
                  agent: "agent-safe",
                  profile: "default",
                }],
              },
              steps: [{
                operationId: `${session.rootOperationId}:preview`,
                status: "blocked",
                code: "references_exist",
                blockers: [{ code: "references_exist" }],
                references: [{
                  store: "agents.json",
                  referenceKey: "model.primary",
                  scope: "agent",
                  agent: "agent-safe",
                  profile: "default",
                }],
              }],
              activation: { kind: "gateway_restart", available: true },
            });
          }
          return outcome(session.rootOperationId, {
            status: "applied",
            code: undefined,
            sync: "synced",
            snapshot: snapshot([]),
          });
        },
      };
      const deleteActivations = [];
      root = mount();
      render(
        root,
        React.createElement(CustomEndpointsPanel, {
          controller: deleteController,
          active: true,
          onChanged() {
            changedCount += 1;
          },
          onActivation(value) {
            deleteActivations.push(value);
          },
        }),
      );
      await waitFor(() => document.body.textContent.includes("Endpoint delete"), "delete fixture did not list");
      clickButton("Delete");
      await confirmDanger();
      await waitFor(() => deleteCalls.length === 1, "initial safe delete was not called");
      await waitFor(
        () => ["agents.json", "model.primary", "agent-safe", "default"].every(
          (value) => document.body.textContent.includes(value),
        ),
        "force confirmation omitted safe reference identifiers",
      );
      await confirmDanger();
      await waitFor(() => deleteCalls.length === 2, "force delete was not called");
      await waitFor(
        () => ![...document.querySelectorAll("button")].some(
          (button) => button.textContent?.includes("Endpoint delete"),
        ),
        "completed delete kept row",
      );
      if (deleteCalls[0].force !== false || deleteCalls[1].force !== true) {
        throw new Error("delete force sequence is incorrect");
      }
      if (deleteCalls[0].session.rootOperationId !== deleteCalls[1].session.rootOperationId) {
        throw new Error("forced delete did not reuse the session");
      }
      if (changedCount !== 1 || deleteActivations.length !== 1) {
        throw new Error("delete completion/activation callbacks were not gated correctly");
      }
      root.unmount();

      // primary_model_in_use 等硬阻塞不得出现 force。
      const hardCalls = [];
      const hardController = {
        ...deleteController,
        backend: "hard-backend",
        list: async () => snapshot([endpoint("hard")]),
        remove: async (_item, session, force) => {
          hardCalls.push({ session, force });
          return outcome(session.rootOperationId, {
            status: "blocked",
            code: "primary_model_in_use",
            steps: [{
              operationId: `${session.rootOperationId}:preview`,
              status: "blocked",
              blockers: [{ code: "primary_model_in_use" }],
            }],
          });
        },
      };
      root = mount();
      render(
        root,
        React.createElement(CustomEndpointsPanel, {
          controller: hardController,
          active: true,
          onChanged() {},
        }),
      );
      await waitFor(() => document.body.textContent.includes("Endpoint hard"), "hard blocker fixture did not list");
      clickButton("Delete");
      await confirmDanger();
      await waitFor(() => hardCalls.length === 1, "hard-blocked delete was not called");
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (hardCalls.some((call) => call.force)
        || document.querySelector('[role="alertdialog"]:not([inert])')) {
        throw new Error("hard blocker incorrectly offered force delete");
      }
      if (!document.body.textContent.includes("Endpoint hard")) {
        throw new Error("hard-blocked delete removed its row");
      }
      root.unmount();

      return {
        listCalls,
        saveCalls: saveCalls.length,
        clearCalls: clearCalls.length,
        deleteCalls: deleteCalls.length,
        hardCalls: hardCalls.length,
      };
    });

    assert.deepEqual(result, {
      listCalls: 3,
      saveCalls: 3,
      clearCalls: 2,
      deleteCalls: 2,
      hardCalls: 1,
    });
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopProcess(vite);
  }
}

const [controller, panel, modal] = await Promise.all([
  source(controllerPath),
  source(panelPath),
  source(modalPath),
]);

if (runController) {
  assertControllerSource(controller);
  await runControllerRuntime();
  console.log("custom endpoints controller regression: PASS");
}
if (runUi) {
  await runUiRuntime();
  assertUiSource(panel, modal);
  console.log("custom endpoints UI regression: PASS");
}
