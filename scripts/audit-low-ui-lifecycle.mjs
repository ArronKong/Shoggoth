#!/usr/bin/env node

// R116 A1 生命周期真实回归：React renderer + fake timer + deferred Promise。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const requireFromUi = createRequire(path.join(uiRoot, "package.json"));
const React = requireFromUi("react");
const TestRenderer = requireFromUi("react-test-renderer");
const esbuild = requireFromUi("esbuild");
const { act } = TestRenderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const results = [];

// 每项输出独立结果，RED 时能区分真实行为缺口与测试脚手架错误。
function check(name, condition) {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

// 生成可手动结算的 Promise，用来稳定复现迟到响应。
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// 将真实生产模块打包到 UI 目录，确保 external React 与 renderer 共用同一实例。
async function compileTarget(relativePath, name, plugins = []) {
  const dir = fs.mkdtempSync(path.join(uiRoot, ".audit-lifecycle-"));
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(root, relativePath)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["react", "react-test-renderer"],
    loader: { ".css": "empty" },
    plugins,
    logLevel: "silent",
  });
  return {
    mod: createRequire(outfile)(outfile),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const i18nStub = {
  name: "i18n-stub",
  setup(build) {
    build.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "react-i18next", namespace: "audit-stub" }));
    build.onLoad({ filter: /.*/, namespace: "audit-stub" }, () => ({
      loader: "js",
      contents: "export const useTranslation = () => ({ t: (key, vars) => vars ? `${key}:${JSON.stringify(vars)}` : key });",
    }));
  },
};

// 真实挂载 CronCalendar：同日 tick 不得重置 expanded/scroll，跨午夜应推进当前周。
{
  const previousDate = globalThis.Date;
  const previousWindow = globalThis.window;
  let nowMs = new previousDate(2026, 6, 18, 23, 58, 30).getTime(); // Saturday
  const timers = new Map();
  let timerSeq = 0;
  class FakeDate extends previousDate {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  }
  globalThis.Date = FakeDate;
  globalThis.window = {
    setTimeout(fn) { const id = ++timerSeq; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const scrollNode = {
    scrollTop: 0,
    querySelectorAll: () => Array.from({ length: 24 }, (_, hour) => ({ offsetTop: hour * 100 })),
  };
  const compiled = await compileTarget("app/manage-ui/src/pages/CronCalendar.tsx", "calendar", [i18nStub]);
  let renderer;
  let controlledCursor;
  try {
    const jobs = Array.from({ length: 6 }, (_, index) => ({
      id: `job-${index}`,
      name: `job-${index}`,
      backendId: "openclaw",
      enabled: true,
      schedule: { kind: "cron", expr: "0 23 * * *" },
    }));
    function CalendarHarness() {
      const [cursor, setCursor] = React.useState(() => new FakeDate());
      const [mode, setMode] = React.useState("week");
      controlledCursor = cursor;
      return React.createElement(compiled.mod.default, {
        jobs,
        cursor,
        mode,
        onCursorChange: setCursor,
        onModeChange: setMode,
      });
    }
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CalendarHarness), {
        createNodeMock: (element) => String(element.props?.className || "").includes("cal-tg-body") ? scrollNode : {},
      });
    });
    const rootNode = renderer.root;
    const more = rootNode.findAll((node) => node.type === "button" && node.props.className === "cal-hmore")[0];
    await act(async () => { more.props.onClick(); });
    scrollNode.scrollTop = 333;
    const rangeTitle = () => compiled.mod.calendarRangeTitle(
      controlledCursor,
      "week",
      (key, vars) => vars ? `${key}:${JSON.stringify(vars)}` : key,
    );
    const titleBefore = rangeTitle();
    const runNextTimer = async () => {
      const entry = timers.entries().next().value;
      assert.ok(entry, "日历应安排下一分钟 timer");
      timers.delete(entry[0]);
      await act(async () => { entry[1](); });
    };

    nowMs = new previousDate(2026, 6, 18, 23, 59, 5).getTime();
    await runNextTimer();
    check("真实 CronCalendar 同日 tick 保留 expanded", rootNode.findAllByProps({ className: "cal-hless" }).length === 1);
    check("真实 CronCalendar 同日 tick 不重置 scroll", scrollNode.scrollTop === 333);
    check("真实 CronCalendar 同日 tick 不推进周标题", rangeTitle() === titleBefore);

    nowMs = new previousDate(2026, 6, 19, 0, 0, 5).getTime(); // Sunday
    await runNextTimer();
    check("真实 CronCalendar 跨午夜推进当前周", rangeTitle() !== titleBefore);
    await act(async () => { renderer.unmount(); });
  } finally {
    compiled.cleanup();
    globalThis.Date = previousDate;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
}

const corePath = path.join(root, "app/manage-ui/src/lib/lowUiLifecycle.ts");
if (!fs.existsSync(corePath)) {
  check("生产目标请求 guard 可真实执行", false);
  check("真实目标请求 guard 拒绝 A→B 的迟到 A", false);
  check("生产逐字段 mutation guard 可真实执行", false);
  check("真实 mutation guard 隔离 profile 与同字段新旧请求", false);
  check("生产 Settings 生命周期 guard 可真实执行", false);
  check("真实 Settings guard 阻止卸载/旧 refresh 迟到落状态与主题", false);
  check("真实 Settings guard 用 config epoch 作废旧连接测试", false);
  check("生产 Cron 详情 controller 可真实执行", false);
  check("真实 Cron controller 阻止 A 动作迟到刷新 B", false);
  check("真实 Cron controller 为当前 A 使用最新 runs filters", false);
  check("生产 Tasks 切板 controller 可真实执行", false);
  check("真实 Tasks controller 仅提交最后成功的 C", false);
  check("真实 Tasks controller 忽略旧 B 的迟到失败", false);
  check("真实 Tasks controller 让最新失败反馈且保留已确认板", false);
  check("真实 Tasks controller 在后端变化后作废请求", false);
  check("真实 Tasks controller 在卸载后作废请求", false);
  check("生产通用异步请求 controller 可真实执行", false);
  check("真实 Tasks 辅助请求按 channel 独立结算且同 channel 只收最新", false);
  check("真实 Tasks 辅助请求在后端变化后拒绝旧响应", false);
  check("真实 Tasks 辅助请求在卸载后拒绝旧响应", false);
  check("真实 Cron intent 在每个 await 后拒绝旧 edit", false);
  check("真实 Cron intent 用 create 作废旧 detail", false);
  check("真实 Cron intent 在 close/unmount 后不重开", false);
} else {
  const compiled = await compileTarget("app/manage-ui/src/lib/lowUiLifecycle.ts", "core");
  try {
    const {
      createSettingsLifecycleGuard,
      createCronSelectionController,
      createBoardSwitchController,
      createAsyncRequestController,
      createTargetRequestGuard,
      createKeyedMutationGuard,
    } = compiled.mod;

    if (typeof createAsyncRequestController !== "function") {
      check("生产通用异步请求 controller 可真实执行", false);
      check("真实 Tasks 辅助请求按 channel 独立结算且同 channel 只收最新", false);
      check("真实 Tasks 辅助请求在后端变化后拒绝旧响应", false);
      check("真实 Tasks 辅助请求在卸载后拒绝旧响应", false);
      check("真实 Cron intent 在每个 await 后拒绝旧 edit", false);
      check("真实 Cron intent 用 create 作废旧 detail", false);
      check("真实 Cron intent 在 close/unmount 后不重开", false);
    } else {
      // Tasks 的 boards/orchestration 共用 backend generation，但各自保留 latest 序号。
      const tasksController = createAsyncRequestController();
      tasksController.mount();
      let currentBackend = "shoggoth";
      const taskWrites = [];
      const loadTaskAux = async (channel, backend, pending) => {
        const ticket = tasksController.begin(channel, backend);
        const value = await pending;
        if (tasksController.isCurrent(ticket, currentBackend)) taskWrites.push(value);
      };
      const boardsOld = deferred();
      const boardsNew = deferred();
      const orch = deferred();
      const oldBoardsLoad = loadTaskAux("boards", currentBackend, boardsOld.promise);
      const orchLoad = loadTaskAux("orchestration", currentBackend, orch.promise);
      const newBoardsLoad = loadTaskAux("boards", currentBackend, boardsNew.promise);
      boardsNew.resolve("boards-new");
      orch.resolve("orch");
      boardsOld.resolve("boards-old");
      await Promise.all([oldBoardsLoad, orchLoad, newBoardsLoad]);
      check("生产通用异步请求 controller 可真实执行", true);
      check(
        "真实 Tasks 辅助请求按 channel 独立结算且同 channel 只收最新",
        taskWrites.sort().join(",") === "boards-new,orch",
      );

      const staleBackend = deferred();
      const staleBackendLoad = loadTaskAux("boards", currentBackend, staleBackend.promise);
      currentBackend = "hermes";
      tasksController.invalidate();
      staleBackend.resolve("stale-shoggoth");
      await staleBackendLoad;
      check("真实 Tasks 辅助请求在后端变化后拒绝旧响应", !taskWrites.includes("stale-shoggoth"));

      const staleUnmount = deferred();
      const staleUnmountLoad = loadTaskAux("orchestration", currentBackend, staleUnmount.promise);
      tasksController.unmount();
      staleUnmount.resolve("stale-unmount");
      await staleUnmountLoad;
      check("真实 Tasks 辅助请求在卸载后拒绝旧响应", !taskWrites.includes("stale-unmount"));

      // Cron 所有 view/edit/create 共用同一 channel；detail 与 ensureAgents 每段 await 后都复核。
      const cronIntent = createAsyncRequestController();
      cronIntent.mount();
      const cronWrites = [];
      const openCron = async (intent, detailPending, agentsPending = null) => {
        const ticket = cronIntent.begin("detail", intent);
        await detailPending;
        if (!cronIntent.isCurrent(ticket, intent)) return;
        if (agentsPending) {
          await agentsPending;
          if (!cronIntent.isCurrent(ticket, intent)) return;
        }
        cronWrites.push(intent);
      };
      const shoggothDetail = deferred();
      const shoggothAgents = deferred();
      const staleShoggoth = openCron("edit:shoggoth:A", shoggothDetail.promise, shoggothAgents.promise);
      shoggothDetail.resolve();
      await shoggothDetail.promise;
      const hermesAgents = deferred();
      const freshHermes = openCron("edit:hermes:B", Promise.resolve(), hermesAgents.promise);
      shoggothAgents.resolve();
      hermesAgents.resolve();
      await Promise.all([staleShoggoth, freshHermes]);
      check("真实 Cron intent 在每个 await 后拒绝旧 edit", cronWrites.join(",") === "edit:hermes:B");

      const staleViewDetail = deferred();
      const staleView = openCron("view:shoggoth:C", staleViewDetail.promise);
      const createAgents = deferred();
      const freshCreate = openCron("create:hermes", createAgents.promise);
      staleViewDetail.resolve();
      createAgents.resolve();
      await Promise.all([staleView, freshCreate]);
      check("真实 Cron intent 用 create 作废旧 detail", cronWrites.at(-1) === "create:hermes" && !cronWrites.includes("view:shoggoth:C"));

      const closePending = deferred();
      const closedCreate = openCron("create:shoggoth", closePending.promise);
      cronIntent.invalidate();
      closePending.resolve();
      await closedCreate;
      const unmountPending = deferred();
      const unmountedEdit = openCron("edit:openclaw:D", unmountPending.promise);
      cronIntent.unmount();
      unmountPending.resolve();
      await unmountedEdit;
      check(
        "真实 Cron intent 在 close/unmount 后不重开",
        !cronWrites.includes("create:shoggoth") && !cronWrites.includes("edit:openclaw:D"),
      );
    }

    if (typeof createTargetRequestGuard === "function") {
      const guard = createTargetRequestGuard();
      const fileA = guard.begin("openclaw\u0000agent-a\u0000AGENTS.md");
      const fileB = guard.begin("openclaw\u0000agent-b\u0000AGENTS.md");
      check("生产目标请求 guard 可真实执行", guard.isCurrent(fileB, fileB.target));
      check("真实目标请求 guard 拒绝 A→B 的迟到 A", !guard.isCurrent(fileA, fileA.target));
    } else {
      check("生产目标请求 guard 可真实执行", false);
      check("真实目标请求 guard 拒绝 A→B 的迟到 A", false);
    }

    if (typeof createKeyedMutationGuard === "function") {
      const guard = createKeyedMutationGuard();
      const oldReasoning = guard.begin("profile-a", "reasoningEffort");
      const newReasoning = guard.begin("profile-a", "reasoningEffort");
      const serviceTier = guard.begin("profile-a", "serviceTier");
      check("生产逐字段 mutation guard 可真实执行", guard.isCurrent(newReasoning, "profile-a", "reasoningEffort") && guard.isCurrent(serviceTier, "profile-a", "serviceTier"));
      guard.invalidateScope();
      check("真实 mutation guard 隔离 profile 与同字段新旧请求", !guard.isCurrent(oldReasoning, "profile-a", "reasoningEffort") && !guard.isCurrent(newReasoning, "profile-b", "reasoningEffort") && !guard.isCurrent(serviceTier, "profile-a", "serviceTier"));
    } else {
      check("生产逐字段 mutation guard 可真实执行", false);
      check("真实 mutation guard 隔离 profile 与同字段新旧请求", false);
    }

    // 薄组件使用生产 guard 执行真实 mount/unmount 与 deferred Promise 结算。
    const settingsApi = { stateWrites: [], themeCalls: [], testWrites: [] };
    function SettingsHarness({ api }) {
      const guardRef = React.useRef(null);
      if (!guardRef.current) guardRef.current = createSettingsLifecycleGuard();
      const guard = guardRef.current;
      const [, setValue] = React.useState("");
      React.useEffect(() => {
        guard.mount();
        api.startRefresh = (pending) => {
          const ticket = guard.beginRefresh();
          pending.then((theme) => {
            if (!guard.isRefreshCurrent(ticket)) return;
            api.themeCalls.push(theme);
            api.stateWrites.push(theme);
            setValue(theme);
          });
          return ticket;
        };
        api.startTest = (key, pending) => {
          const ticket = guard.beginTest(key);
          pending.then((value) => {
            if (!guard.isTestCurrent(ticket)) return;
            api.testWrites.push(value);
            setValue(value);
          });
          return ticket;
        };
        return () => guard.unmount();
      }, [api, guard]);
      return React.createElement("span");
    }

    let settingsRenderer;
    await act(async () => { settingsRenderer = TestRenderer.create(React.createElement(SettingsHarness, { api: settingsApi })); });
    const unmountConfig = deferred();
    settingsApi.startRefresh(unmountConfig.promise);
    await act(async () => { settingsRenderer.unmount(); });
    await act(async () => { unmountConfig.resolve("unmounted-theme"); await unmountConfig.promise; });
    check("生产 Settings 生命周期 guard 可真实执行", typeof createSettingsLifecycleGuard === "function");
    check("真实 Settings guard 阻止卸载后 getConfig 落状态/applyTheme", settingsApi.stateWrites.length === 0 && settingsApi.themeCalls.length === 0);

    const raceApi = { stateWrites: [], themeCalls: [], testWrites: [] };
    await act(async () => { settingsRenderer = TestRenderer.create(React.createElement(SettingsHarness, { api: raceApi })); });
    const oldRefresh = deferred();
    const newRefresh = deferred();
    raceApi.startRefresh(oldRefresh.promise);
    raceApi.startRefresh(newRefresh.promise);
    await act(async () => { newRefresh.resolve("dark"); await newRefresh.promise; });
    await act(async () => { oldRefresh.resolve("light"); await oldRefresh.promise; });
    check("真实 Settings guard 阻止旧 refresh 覆盖新主题", raceApi.themeCalls.join(",") === "dark" && raceApi.stateWrites.join(",") === "dark");

    const staleTest = deferred();
    const firstTicket = raceApi.startTest("openclaw", staleTest.promise);
    const configRefresh = deferred();
    raceApi.startRefresh(configRefresh.promise);
    const freshTest = deferred();
    const secondTicket = raceApi.startTest("openclaw", freshTest.promise);
    await act(async () => { staleTest.resolve("stale-test"); await staleTest.promise; });
    await act(async () => { freshTest.resolve("fresh-test"); await freshTest.promise; });
    check("真实 Settings guard 用 config epoch 作废旧连接测试", raceApi.testWrites.join(",") === "fresh-test" && secondTicket.seq > firstTicket.seq);
    await act(async () => { configRefresh.resolve("system"); await configRefresh.promise; settingsRenderer.unmount(); });

    // Cron 薄组件用生产 controller 在 A await 期间切换到 B。
    const cronApi = { writes: [] };
    function CronHarness({ api }) {
      const controllerRef = React.useRef(null);
      if (!controllerRef.current) controllerRef.current = createCronSelectionController({ sortDir: "desc", limit: 25 });
      const controller = controllerRef.current;
      const [, render] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        api.open = (job) => { controller.select(job); render(); };
        api.filters = (filters) => { controller.setFilters(filters); render(); };
        api.run = async (id, pending) => {
          await pending;
          const current = controller.currentForAction(id);
          if (current) api.writes.push({ id: current.job.id, filters: current.filters });
        };
      }, [api, controller]);
      return React.createElement("span");
    }
    let cronRenderer;
    await act(async () => { cronRenderer = TestRenderer.create(React.createElement(CronHarness, { api: cronApi })); });
    await act(async () => { cronApi.open({ id: "A" }); });
    const runA = deferred();
    const lateA = cronApi.run("A", runA.promise);
    await act(async () => { cronApi.open({ id: "B" }); });
    await act(async () => { runA.resolve(); await lateA; });
    check("生产 Cron 详情 controller 可真实执行", typeof createCronSelectionController === "function");
    check("真实 Cron controller 阻止 A 动作迟到刷新 B", cronApi.writes.length === 0);

    await act(async () => { cronApi.open({ id: "A" }); });
    const currentA = deferred();
    const currentRun = cronApi.run("A", currentA.promise);
    await act(async () => { cronApi.filters({ sortDir: "asc", limit: 7 }); });
    await act(async () => { currentA.resolve(); await currentRun; });
    check("真实 Cron controller 为当前 A 使用最新 runs filters", cronApi.writes.length === 1 && cronApi.writes[0].filters.limit === 7);
    await act(async () => { cronRenderer.unmount(); });

    if (typeof createBoardSwitchController !== "function") {
      check("生产 Tasks 切板 controller 可真实执行", false);
      check("真实 Tasks controller 仅提交最后成功的 C", false);
      check("真实 Tasks controller 忽略旧 B 的迟到失败", false);
      check("真实 Tasks controller 让最新失败反馈且保留已确认板", false);
      check("真实 Tasks controller 在后端变化后作废请求", false);
      check("真实 Tasks controller 在卸载后作废请求", false);
    } else {
      // 薄组件使用生产 controller 驱动两次 deferred 切板，验证真实 React 生命周期中的乱序结算。
      const createBoardApi = () => ({ active: "A", writes: [], errors: [] });
      function BoardHarness({ api }) {
        const controllerRef = React.useRef(null);
        if (!controllerRef.current) controllerRef.current = createBoardSwitchController();
        const controller = controllerRef.current;
        const [active, setActive] = React.useState("A");
        api.active = active;
        React.useEffect(() => {
          controller.mount();
          api.switch = async (target, pending) => {
            const ticket = controller.begin(target);
            try {
              await pending;
              if (!controller.isCurrent(ticket, target)) return;
              api.writes.push(target);
              setActive(target);
            } catch (error) {
              if (!controller.isCurrent(ticket, target)) return;
              api.errors.push(error instanceof Error ? error.message : String(error));
            }
          };
          api.changeBackend = () => controller.invalidate();
          return () => controller.unmount();
        }, [api, controller]);
        return React.createElement("span", null, active);
      }

      const raceApi = createBoardApi();
      let boardRenderer;
      await act(async () => { boardRenderer = TestRenderer.create(React.createElement(BoardHarness, { api: raceApi })); });
      const boardB = deferred();
      const boardC = deferred();
      const switchB = raceApi.switch("B", boardB.promise);
      const switchC = raceApi.switch("C", boardC.promise);
      await act(async () => { boardC.resolve(); await switchC; });
      await act(async () => { boardB.resolve(); await switchB; });
      check("生产 Tasks 切板 controller 可真实执行", typeof createBoardSwitchController === "function");
      check("真实 Tasks controller 仅提交最后成功的 C", raceApi.active === "C" && raceApi.writes.join(",") === "C");

      const staleFailure = deferred();
      const freshSuccess = deferred();
      const staleSwitch = raceApi.switch("B", staleFailure.promise);
      const freshSwitch = raceApi.switch("C", freshSuccess.promise);
      await act(async () => { freshSuccess.resolve(); await freshSwitch; });
      await act(async () => { staleFailure.reject(new Error("stale B")); await staleSwitch; });
      check("真实 Tasks controller 忽略旧 B 的迟到失败", raceApi.active === "C" && raceApi.errors.length === 0 && raceApi.writes.join(",") === "C,C");
      await act(async () => { boardRenderer.unmount(); });

      const currentFailureApi = createBoardApi();
      await act(async () => { boardRenderer = TestRenderer.create(React.createElement(BoardHarness, { api: currentFailureApi })); });
      const currentFailure = deferred();
      const failedSwitch = currentFailureApi.switch("C", currentFailure.promise);
      await act(async () => { currentFailure.reject(new Error("latest C")); await failedSwitch; });
      check("真实 Tasks controller 让最新失败反馈且保留已确认板", currentFailureApi.active === "A" && currentFailureApi.writes.length === 0 && currentFailureApi.errors.join(",") === "latest C");

      const backendPending = deferred();
      const backendSwitch = currentFailureApi.switch("B", backendPending.promise);
      currentFailureApi.changeBackend();
      await act(async () => { backendPending.resolve(); await backendSwitch; });
      check("真实 Tasks controller 在后端变化后作废请求", currentFailureApi.active === "A" && currentFailureApi.writes.length === 0);

      const unmountPending = deferred();
      const unmountSwitch = currentFailureApi.switch("C", unmountPending.promise);
      await act(async () => { boardRenderer.unmount(); });
      await act(async () => { unmountPending.resolve(); await unmountSwitch; });
      check("真实 Tasks controller 在卸载后作废请求", currentFailureApi.writes.length === 0 && currentFailureApi.errors.join(",") === "latest C");
    }
  } finally {
    compiled.cleanup();
  }
}

// 真实挂载默认参数 hook：同字段乱序失败必须回到服务端确认值，并隔离字段与 profile 生命周期。
{
  const apiStub = {
    name: "agent-model-defaults-api-stub",
    setup(build) {
      build.onResolve({ filter: /api\/client$/ }, () => ({ path: "agent-model-api", namespace: "agent-model-stub" }));
      build.onResolve({ filter: /components\/ui$/ }, () => ({ path: "agent-model-ui", namespace: "agent-model-stub" }));
      build.onLoad({ filter: /^agent-model-api$/, namespace: "agent-model-stub" }, () => ({
        loader: "js",
        contents: `
          const api = () => globalThis.__agentModelDefaultsApi;
          export const getModelSettings = (...args) => api().getModelSettings(...args);
          export const setModelDefaults = (...args) => api().setModelDefaults(...args);
          export const applyMainModel = (...args) => api().applyMainModel(...args);
          export const getRecommendedDefaultModel = (...args) => api().getRecommendedDefaultModel(...args);
          export const listOAuthProviders = (...args) => api().listOAuthProviders(...args);
          export const saveMoaConfig = (...args) => api().saveMoaConfig(...args);
          export const setAuxiliaryModel = (...args) => api().setAuxiliaryModel(...args);
          export const setEnvVar = (...args) => api().setEnvVar(...args);
          export const setFallbackModels = (...args) => api().setFallbackModels(...args);
        `,
      }));
      build.onLoad({ filter: /^agent-model-ui$/, namespace: "agent-model-stub" }, () => ({
        loader: "js",
        contents: "export const useToast = () => globalThis.__agentModelDefaultsToast;",
      }));
    },
  };
  const compiled = await compileTarget(
    "app/manage-ui/src/pages/agents/useAgentModelSettings.ts",
    "agent-model-defaults",
    [i18nStub, apiStub],
  );
  const snapshotFor = (profile, reasoningEffort = "medium", serviceTier = "normal") => ({
    supported: true,
    profile,
    profiles: [profile],
    main: { provider: "provider", model: "model" },
    providers: [{
      name: "Provider",
      slug: "provider",
      models: ["model"],
      capabilities: { model: { reasoning: true, fast: true } },
    }],
    auxiliary: { slots: [], main: {} },
    defaults: { reasoningEffort, serviceTier },
    fallbacks: [],
    moa: null,
  });
  const makeApi = (snapshots) => {
    const writes = [];
    return {
      writes,
      getModelSettings: async (_backend, profile) => structuredClone(snapshots[profile]),
      setModelDefaults(_backend, profile, patch) {
        const pending = writes.shift();
        assert.ok(pending, `缺少 ${profile} ${JSON.stringify(patch)} 的 deferred mutation`);
        return pending.promise;
      },
      applyMainModel: async () => ({ ok: true, provider: "provider", model: "model", staleAux: [] }),
      getRecommendedDefaultModel: async () => ({ provider: "provider", model: "model", freeTier: null }),
      listOAuthProviders: async () => ({ providers: [], profiles: [] }),
      saveMoaConfig: async (_backend, _profile, config) => config,
      setAuxiliaryModel: async () => undefined,
      setEnvVar: async () => ({ ok: true }),
      setFallbackModels: async () => ({ ok: true }),
    };
  };
  const state = { current: null };
  function DefaultsHarness({ profile }) {
    state.current = compiled.mod.useAgentModelSettings({
      backend: "hermes",
      profile,
      reloadToken: 0,
      onMainModelChanged() {},
      onNavigate() {},
    });
    return React.createElement("span", null, `${state.current.effortValue}:${state.current.fastOn}`);
  }
  const flushLoad = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  let renderer;
  try {
    const errors = [];
    globalThis.__agentModelDefaultsToast = { success() {}, error(message) { errors.push(message); } };

    const bothFailApi = makeApi({ alpha: snapshotFor("alpha") });
    const oldFailure = deferred();
    const latestFailure = deferred();
    bothFailApi.writes.push(oldFailure, latestFailure);
    globalThis.__agentModelDefaultsApi = bothFailApi;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DefaultsHarness, { profile: "alpha" }));
      await flushLoad();
    });
    let oldWrite;
    let latestWrite;
    await act(async () => { oldWrite = state.current.writeDefault({ reasoningEffort: "high" }); });
    await act(async () => { latestWrite = state.current.writeDefault({ reasoningEffort: "low" }); });
    await act(async () => { latestFailure.reject(new Error("latest low failed")); await latestWrite; });
    await act(async () => { oldFailure.reject(new Error("stale high failed")); await oldWrite; });
    check("真实默认参数同字段双失败回到确认值", state.current.effortValue === "medium");
    check("真实默认参数只报告最新失败", errors.length === 1 && errors[0].includes("latest low failed"));
    await act(async () => { renderer.unmount(); });

    errors.length = 0;
    const confirmedApi = makeApi({ alpha: snapshotFor("alpha") });
    const confirmedSuccess = deferred();
    const afterSuccessFailure = deferred();
    confirmedApi.writes.push(confirmedSuccess, afterSuccessFailure);
    globalThis.__agentModelDefaultsApi = confirmedApi;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DefaultsHarness, { profile: "alpha" }));
      await flushLoad();
    });
    let confirmedWrite;
    await act(async () => { confirmedWrite = state.current.writeDefault({ reasoningEffort: "high" }); });
    await act(async () => { confirmedSuccess.resolve({ ok: true }); await confirmedWrite; });
    let failedAfterSuccess;
    await act(async () => { failedAfterSuccess = state.current.writeDefault({ reasoningEffort: "low" }); });
    await act(async () => { afterSuccessFailure.reject(new Error("low failed")); await failedAfterSuccess; });
    check("真实默认参数仅成功推进确认值", state.current.effortValue === "high");
    await act(async () => { renderer.unmount(); });

    errors.length = 0;
    const staleSuccessApi = makeApi({ alpha: snapshotFor("alpha") });
    const staleSuccess = deferred();
    const latestFailureBeforeSuccess = deferred();
    staleSuccessApi.writes.push(staleSuccess, latestFailureBeforeSuccess);
    globalThis.__agentModelDefaultsApi = staleSuccessApi;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DefaultsHarness, { profile: "alpha" }));
      await flushLoad();
    });
    let staleSuccessWrite;
    let latestFailureWrite;
    await act(async () => { staleSuccessWrite = state.current.writeDefault({ reasoningEffort: "high" }); });
    await act(async () => { latestFailureWrite = state.current.writeDefault({ reasoningEffort: "low" }); });
    await act(async () => {
      latestFailureBeforeSuccess.reject(new Error("latest low failed before old success"));
      await latestFailureWrite;
    });
    check("真实默认参数最新失败先回到初始确认值", state.current.effortValue === "medium");
    await act(async () => { staleSuccess.resolve({ ok: true }); await staleSuccessWrite; });
    check("真实默认参数旧成功晚到后同步服务端确认值", state.current.effortValue === "high");
    check("真实默认参数旧成功晚到不重复报告失败", errors.length === 1 && errors[0].includes("latest low failed before old success"));
    await act(async () => { renderer.unmount(); });

    errors.length = 0;
    const fieldsApi = makeApi({ alpha: snapshotFor("alpha") });
    const reasoningFailure = deferred();
    const tierSuccess = deferred();
    fieldsApi.writes.push(reasoningFailure, tierSuccess);
    globalThis.__agentModelDefaultsApi = fieldsApi;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DefaultsHarness, { profile: "alpha" }));
      await flushLoad();
    });
    let reasoningWrite;
    let tierWrite;
    await act(async () => { reasoningWrite = state.current.writeDefault({ reasoningEffort: "high" }); });
    await act(async () => { tierWrite = state.current.writeDefault({ serviceTier: "fast" }); });
    await act(async () => { tierSuccess.resolve({ ok: true }); await tierWrite; });
    await act(async () => { reasoningFailure.reject(new Error("reasoning failed")); await reasoningWrite; });
    check("真实默认参数不同字段并发互不回滚", state.current.effortValue === "medium" && state.current.fastOn === true);
    await act(async () => { renderer.unmount(); });

    errors.length = 0;
    const profileApi = makeApi({
      alpha: snapshotFor("alpha"),
      beta: snapshotFor("beta", "low"),
    });
    const staleProfileWrite = deferred();
    profileApi.writes.push(staleProfileWrite);
    globalThis.__agentModelDefaultsApi = profileApi;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DefaultsHarness, { profile: "alpha" }));
      await flushLoad();
    });
    let profileWrite;
    await act(async () => { profileWrite = state.current.writeDefault({ reasoningEffort: "high" }); });
    await act(async () => {
      renderer.update(React.createElement(DefaultsHarness, { profile: "beta" }));
      await flushLoad();
    });
    await act(async () => { staleProfileWrite.reject(new Error("stale profile")); await profileWrite; });
    check("真实默认参数 profile 切换作废旧回滚", state.current.effortValue === "low" && errors.length === 0);
    await act(async () => { renderer.unmount(); });

    errors.length = 0;
    const unmountApi = makeApi({ alpha: snapshotFor("alpha") });
    const unmountFailure = deferred();
    unmountApi.writes.push(unmountFailure);
    globalThis.__agentModelDefaultsApi = unmountApi;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DefaultsHarness, { profile: "alpha" }));
      await flushLoad();
    });
    let unmountWrite;
    await act(async () => { unmountWrite = state.current.writeDefault({ reasoningEffort: "high" }); });
    await act(async () => { renderer.unmount(); });
    await act(async () => { unmountFailure.reject(new Error("after unmount")); await unmountWrite; });
    check("真实默认参数卸载作废旧回滚与错误反馈", errors.length === 0);
  } finally {
    if (renderer) {
      try { await act(async () => { renderer.unmount(); }); } catch { /* 已卸载 */ }
    }
    compiled.cleanup();
    delete globalThis.__agentModelDefaultsApi;
    delete globalThis.__agentModelDefaultsToast;
  }
}

// Electron 通知直接执行真实 helper：resolve true/false 与 reject 都要有确定结果。
{
  const previousWindow = globalThis.window;
  const compiled = await compileTarget("app/manage-ui/src/lib/notify.ts", "notify");
  try {
    globalThis.window = { openclawDesktop: { notify: async () => true } };
    check("真实 Electron notify resolve true", await compiled.mod.fireNotification({ category: "chat", title: "t", body: "b" }) === true);
    globalThis.window.openclawDesktop.notify = async () => false;
    check("真实 Electron notify resolve false", await compiled.mod.fireNotification({ category: "chat", title: "t", body: "b" }) === false);
    globalThis.window.openclawDesktop.notify = async () => { throw new Error("mock reject"); };
    check("真实 Electron notify reject 返回 false", await compiled.mod.fireNotification({ category: "chat", title: "t", body: "b" }) === false);
  } finally {
    compiled.cleanup();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`RESULT ${results.length - failed.length}/${results.length} pass`);
assert.equal(failed.length, 0, `${failed.length} 项真实生命周期回归失败`);
