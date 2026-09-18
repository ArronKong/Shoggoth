#!/usr/bin/env node

// 导航图标动画生命周期回归：真实挂载 GuardedNavLink，并用假时钟稳定复现快速切页。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const requireFromUi = createRequire(path.join(uiRoot, "package.json"));
const React = requireFromUi("react");
const TestRenderer = requireFromUi("react-test-renderer");
const { createMemoryRouter, RouterProvider } = requireFromUi("react-router-dom");
const esbuild = requireFromUi("esbuild");
const { act } = TestRenderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const results = [];

// 每条断言独立输出，RED 时可以区分测试脚手架与真实生命周期缺口。
function check(name, condition) {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

// 只替换 GuardedNavLink 的外围依赖；被测组件和它的状态机仍来自真实 App.tsx。
async function compileGuardedNavLink() {
  const dir = fs.mkdtempSync(path.join(uiRoot, ".nav-animation-regression-"));
  const outfile = path.join(dir, "guarded-nav-link.cjs");
  const stubs = {
    "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
    "./components/ui": "export const useToast = () => ({ success() {}, error() {}, info() {} });",
    "./components/debug/store": "export const useDebugEnabled = () => false;",
    "./components/ScrollbarProvider": "export default function ScrollbarProvider() { return null; }",
    "./lib/navigation-guard": `
      export const useNavigationRequest = () => (target) => {
        if (typeof target === "function") target();
        return true;
      };
    `,
    "./lib/page-refresh": `
      export const runPageRefresh = () => globalThis.__navAnimationRefresh?.() ?? null;
      export const useHasPageRefresh = () => true;
      export const usePageLoading = () => false;
    `,
  };
  const plugin = {
    name: "nav-animation-regression-stubs",
    setup(build) {
      build.onLoad({ filter: /[/\\]App\.tsx$/ }, (args) => {
        const source = fs.readFileSync(args.path, "utf8").replace(
          "function GuardedNavLink(",
          "export function GuardedNavLink(",
        );
        return { contents: source, loader: "tsx", resolveDir: path.dirname(args.path) };
      });
      build.onResolve({ filter: /^react-i18next$/ }, () => ({
        path: "react-i18next",
        namespace: "nav-stub",
      }));
      for (const specifier of Object.keys(stubs).filter((key) => key !== "react-i18next")) {
        build.onResolve({ filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }, () => ({
          path: specifier,
          namespace: "nav-stub",
        }));
      }
      build.onResolve({ filter: /^\.\/pages\// }, (args) => ({
        path: args.path,
        namespace: "nav-page-stub",
      }));
      build.onResolve({
        filter: /^\.\/components\/(?:Notifier|SetupOverlay|debug\/DebugInspector)$/,
      }, (args) => ({
        path: args.path,
        namespace: "nav-component-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "nav-stub" }, (args) => ({
        contents: stubs[args.path],
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "nav-page-stub" }, () => ({
        contents: "export default function StubPage() { return null; }",
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "nav-component-stub" }, () => ({
        contents: "export default function StubComponent() { return null; }",
        loader: "js",
      }));
    },
  };

  await esbuild.build({
    entryPoints: [path.join(uiRoot, "src/App.tsx")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["react", "react-test-renderer", "react-router-dom"],
    loader: { ".svg": "dataurl" },
    plugins: [plugin],
    logLevel: "silent",
  });
  return {
    mod: createRequire(outfile)(outfile),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const previousWindow = globalThis.window;
const previousDateNow = Date.now;
let nowMs = 0;
let timerSeq = 0;
const timers = new Map();

// 假时钟只实现被测状态机使用的 timeout API，并按到期顺序结算回调。
globalThis.window = {
  setTimeout(callback, delay = 0) {
    const id = ++timerSeq;
    timers.set(id, { at: nowMs + Number(delay), callback });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
  matchMedia() {
    return { matches: false };
  },
};
Date.now = () => nowMs;

// 按真实到期时刻逐个执行 timer，确保回调触发的 effect 可以继续登记下一阶段 timer。
async function advanceTo(targetMs) {
  while (true) {
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.at <= targetMs)
      .sort((left, right) => left[1].at - right[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    nowMs = due[1].at;
    await act(async () => {
      due[1].callback();
    });
  }
  nowMs = targetMs;
}

const compiled = await compileGuardedNavLink();
let renderer;
try {
  const entry = { to: "/dashboard", labelKey: "nav.dashboard", iconSrc: "dashboard.svg" };
  const router = createMemoryRouter(
    [{
      path: "*",
      element: React.createElement(compiled.mod.GuardedNavLink, { entry, label: "总览" }),
    }],
    {
      initialEntries: ["/dashboard"],
      future: { v7_startTransition: true },
    },
  );

  await act(async () => {
    renderer = TestRenderer.create(React.createElement(RouterProvider, {
      router,
      future: { v7_startTransition: true },
    }));
  });
  check(
    "进入当前页会启动导航图标反馈",
    renderer.root.findByType("a").props.className.includes("is-refreshing"),
  );

  nowMs = 200;
  await act(async () => {
    await router.navigate("/chat");
  });

  // 推进超过两个完整周期；旧导航项必须完成收尾，不能永久保留播放 class。
  await advanceTo(2600);
  const inactiveClass = renderer.root.findByType("a").props.className;
  check(
    "快速离页后旧导航项最终移除 is-refreshing",
    !inactiveClass.includes("active") && !inactiveClass.includes("is-refreshing"),
  );

  await act(async () => {
    renderer.unmount();
  });
  renderer = undefined;
  timers.clear();
  nowMs = 0;
  globalThis.__navAnimationRefresh = () => Promise.resolve();

  const returningRouter = createMemoryRouter(
    [{
      path: "*",
      element: React.createElement(compiled.mod.GuardedNavLink, { entry, label: "总览" }),
    }],
    {
      initialEntries: ["/dashboard"],
      future: { v7_startTransition: true },
    },
  );
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(RouterProvider, {
      router: returningRouter,
      future: { v7_startTransition: true },
    }));
  });
  await act(async () => {
    renderer.root.findByType("a").props.onClick({ preventDefault() {} });
    await Promise.resolve();
  });
  await advanceTo(100);
  await act(async () => {
    await returningRouter.navigate("/chat");
  });
  await advanceTo(200);
  await act(async () => {
    await returningRouter.navigate("/dashboard");
  });

  // 旧刷新在 t=1200 到期；新进页应至少播到 t=1400，不能被旧代次提前关掉。
  await advanceTo(1300);
  check(
    "旧刷新 timer 不会截断返回后的新一轮动画",
    renderer.root.findByType("a").props.className.includes("is-refreshing"),
  );
  await advanceTo(2500);
  check(
    "返回后的新一轮动画最终正常收尾",
    !renderer.root.findByType("a").props.className.includes("is-refreshing"),
  );
} finally {
  if (renderer) {
    await act(async () => {
      renderer.unmount();
    });
  }
  compiled.cleanup();
  Date.now = previousDateNow;
  delete globalThis.__navAnimationRefresh;
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

const failed = results.filter((result) => !result.ok);
console.log(`RESULT ${results.length - failed.length}/${results.length} pass`);
assert.equal(failed.length, 0, `${failed.length} 项导航动画生命周期回归失败`);
