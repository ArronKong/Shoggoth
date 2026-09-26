#!/usr/bin/env node

// R116 Task D：共享缓存、玻璃渲染、Cron、API、用量与媒体工具的真实行为回归。

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const requireFromUi = createRequire(path.join(uiRoot, "package.json"));
const esbuild = requireFromUi("esbuild");
const React = requireFromUi("react");
const TestRenderer = requireFromUi("react-test-renderer");
const { act } = TestRenderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const results = [];

// 每条断言独立输出，方便 RED 阶段直接定位缺口。
function check(name, condition) {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

// 生成可控 Promise，稳定复现卸载后的迟到 refresh。
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// 将真实生产模块打包为 CJS；插件只用于替换浏览器或翻译依赖。
async function compileTarget(relativePath, name, { plugins = [], external = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(uiRoot, ".audit-shared-"));
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(root, relativePath)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external,
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
      contents: "export const useTranslation = () => ({ t: (key) => key });",
    }));
  },
};

// #23：连续写入超过上限后，最旧键应被 LRU 淘汰，读取命中还必须刷新新旧顺序。
{
  const compiled = await compileTarget("app/manage-ui/src/lib/usePageCache.ts", "page-cache", {
    external: ["react"],
  });
  let renderer;
  const api = { latest: null };
  const calls = new Map();
  function Harness({ cacheKey }) {
    const state = compiled.mod.usePageCache(cacheKey, async () => {
      calls.set(cacheKey, (calls.get(cacheKey) ?? 0) + 1);
      return cacheKey;
    });
    api.latest = state;
    return React.createElement("span", null, state.data ?? "");
  }
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { cacheKey: "lru-0" })); });
    for (let i = 1; i < 64; i += 1) {
      await act(async () => { renderer.update(React.createElement(Harness, { cacheKey: `lru-${i}` })); });
    }
    // 读取最旧的 key0，把它提升为最近使用；随后写 key64 应淘汰次旧 key1。
    await act(async () => { renderer.update(React.createElement(Harness, { cacheKey: "lru-0" })); });
    await act(async () => { renderer.update(React.createElement(Harness, { cacheKey: "lru-64" })); });
    act(() => { renderer.update(React.createElement(Harness, { cacheKey: "lru-1" })); });
    check("#23 LRU read touch 后淘汰次旧键", api.latest?.loading === true);
    await act(async () => { await Promise.resolve(); });
    act(() => { renderer.update(React.createElement(Harness, { cacheKey: "lru-0" })); });
    check("#23 LRU read touch 后保留当前键", api.latest?.loading === false);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { renderer.unmount(); });
  } finally {
    compiled.cleanup();
  }
}

// #24：真实 React hook 在 A→B 换键后，A 的迟到成功或失败都不能写入 B 视图。
{
  const compiled = await compileTarget("app/manage-ui/src/lib/usePageCache.ts", "page-cache-key-race", {
    external: ["react"],
  });
  let renderer;
  const api = { latest: null };
  function Harness({ cacheKey, pending }) {
    api.latest = compiled.mod.usePageCache(cacheKey, () => pending.promise);
    return React.createElement("span", null, api.latest.data ?? "");
  }
  try {
    const successA = deferred();
    const successB = deferred();
    await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { cacheKey: "success-A", pending: successA })); });
    await act(async () => { renderer.update(React.createElement(Harness, { cacheKey: "success-B", pending: successB })); });
    await act(async () => { successA.resolve("stale-A"); await successA.promise; });
    check("#24 A→B 后 A 迟到 success 不写 B", api.latest?.data === undefined && api.latest?.error === null);
    await act(async () => { successB.resolve("fresh-B"); await successB.promise; });
    check("#24 B 当前 success 正常落状态", api.latest?.data === "fresh-B" && api.latest?.error === null);

    const errorA = deferred();
    const errorB = deferred();
    await act(async () => { renderer.update(React.createElement(Harness, { cacheKey: "error-A", pending: errorA })); });
    await act(async () => { renderer.update(React.createElement(Harness, { cacheKey: "error-B", pending: errorB })); });
    await act(async () => { errorA.reject(new Error("stale-error")); try { await errorA.promise; } catch {} });
    check("#24 A→B 后 A 迟到 error 不写 B", api.latest?.data === undefined && api.latest?.error === null);
    await act(async () => { errorB.resolve("fresh-after-error"); await errorB.promise; });
    await act(async () => { renderer.unmount(); });
  } finally {
    compiled.cleanup();
  }
}

// Models apply：同 key replace 后，apply 前已发出的迟到 effect/refresh 都不得复活旧复合状态。
{
  const compiled = await compileTarget("app/manage-ui/src/lib/usePageCache.ts", "page-cache-replace-race", {
    external: ["react"],
  });
  let renderer;
  const api = { latest: null };
  const initial = deferred();
  const refreshPending = deferred();
  let calls = 0;
  function Harness() {
    api.latest = compiled.mod.usePageCache("models-replace", () => (++calls === 1 ? initial.promise : refreshPending.promise));
    return React.createElement("span", null, api.latest.data?.revision || "");
  }
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
    await act(async () => { api.latest.replace({ revision: "apply-winner" }); });
    await act(async () => { initial.resolve({ revision: "late-effect" }); await initial.promise; });
    check("Models replace 拒绝同 key 迟到 effect", api.latest?.data?.revision === "apply-winner");

    const refresh = api.latest.refresh();
    await act(async () => { api.latest.replace({ revision: "newer-apply-winner" }); });
    await act(async () => { refreshPending.resolve({ revision: "late-refresh" }); await refresh; });
    check("Models replace 拒绝同 key 迟到 refresh", api.latest?.data?.revision === "newer-apply-winner");
    await act(async () => { renderer.unmount(); });
  } finally {
    compiled.cleanup();
  }
}

// BUG-017：同一个 key 的每次真实 fetch 都必须 latest-wins。初始 effect 与 refresh
// 反序完成时，旧 success/error 不能覆盖较新的 success/error。
{
  const compiled = await compileTarget("app/manage-ui/src/lib/usePageCache.ts", "page-cache-same-key-race", {
    external: ["react"],
  });
  let renderer;
  const api = { latest: null };
  const first = deferred();
  const second = deferred();
  let calls = 0;
  function Harness() {
    api.latest = compiled.mod.usePageCache("same-key-latest", () => (++calls === 1 ? first.promise : second.promise));
    return React.createElement("span", null, api.latest.data ?? "");
  }
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
    const refresh = api.latest.refresh();
    await act(async () => { second.resolve("newer"); await refresh; });
    await act(async () => { first.resolve("older"); await first.promise; });
    check("BUG-017 同 key 旧 success 不覆盖新 refresh", api.latest?.data === "newer" && api.latest?.error === null);
    await act(async () => { renderer.unmount(); });

    const oldReject = deferred();
    const newSuccess = deferred();
    calls = 0;
    function ErrorHarness() {
      api.latest = compiled.mod.usePageCache("same-key-error", () => (++calls === 1 ? oldReject.promise : newSuccess.promise));
      return React.createElement("span", null, api.latest.data ?? "");
    }
    await act(async () => { renderer = TestRenderer.create(React.createElement(ErrorHarness)); });
    const newer = api.latest.refresh();
    await act(async () => { newSuccess.resolve("fresh-after-error"); await newer; });
    await act(async () => { oldReject.reject(new Error("stale-error")); try { await oldReject.promise; } catch {} });
    check("BUG-017 同 key 旧 reject 不覆盖新 success", api.latest?.data === "fresh-after-error" && api.latest?.error === null);
    await act(async () => { renderer.unmount(); });

    const oldSuccess = deferred();
    const currentReject = deferred();
    calls = 0;
    function LatestErrorHarness() {
      api.latest = compiled.mod.usePageCache("same-key-current-error", () => (++calls === 1 ? oldSuccess.promise : currentReject.promise));
      return React.createElement("span", null, api.latest.data ?? "");
    }
    await act(async () => { renderer = TestRenderer.create(React.createElement(LatestErrorHarness)); });
    const rejectedRefresh = api.latest.refresh();
    await act(async () => { currentReject.reject(new Error("current-error")); await rejectedRefresh; });
    await act(async () => { oldSuccess.resolve("stale-success"); await oldSuccess.promise; });
    check("BUG-017 当前 refresh 失败会结束初始 loading", api.latest?.loading === false && api.latest?.error === "current-error" && api.latest?.data === undefined);
    await act(async () => { renderer.unmount(); });
  } finally {
    compiled.cleanup();
  }
}

// #24：用最小 React hook 运行时执行真实 refresh，cleanup 后不得再调用任何 setter。
{
  globalThis.__sharedAuditEffects = [];
  globalThis.__sharedAuditSetters = [];
  const reactHookStub = {
    name: "react-hook-stub",
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "hook-stub" }));
      build.onLoad({ filter: /.*/, namespace: "hook-stub" }, () => ({
        loader: "js",
        contents: `
          export const useRef = (value) => ({ current: value });
          export const useState = (value) => [typeof value === "function" ? value() : value, (next) => globalThis.__sharedAuditSetters.push(next)];
          export const useEffect = (fn) => globalThis.__sharedAuditEffects.push(fn);
          export const useCallback = (fn) => fn;
        `,
      }));
    },
  };
  const compiled = await compileTarget("app/manage-ui/src/lib/usePageCache.ts", "page-cache-unmount", {
    plugins: [reactHookStub],
  });
  try {
    const initial = deferred();
    const lateRefresh = deferred();
    let call = 0;
    const state = compiled.mod.usePageCache("alive-key", () => (++call === 1 ? initial.promise : lateRefresh.promise));
    const cleanups = globalThis.__sharedAuditEffects.map((effect) => effect()).filter((cleanup) => typeof cleanup === "function");
    const refresh = state.refresh();
    for (const cleanup of cleanups.reverse()) cleanup();
    globalThis.__sharedAuditSetters.length = 0;
    lateRefresh.resolve("late");
    await refresh;
    check("#24 refresh 卸载后不再 setState", globalThis.__sharedAuditSetters.length === 0);
    initial.resolve("late-effect");
    await initial.promise;
    check("#24 key effect 卸载后迟到 success 不再 setState", globalThis.__sharedAuditSetters.length === 0);

    globalThis.__sharedAuditEffects.length = 0;
    globalThis.__sharedAuditSetters.length = 0;
    const lateError = deferred();
    compiled.mod.usePageCache("unmount-error", () => lateError.promise);
    const errorCleanups = globalThis.__sharedAuditEffects.map((effect) => effect()).filter((cleanup) => typeof cleanup === "function");
    for (const cleanup of errorCleanups.reverse()) cleanup();
    globalThis.__sharedAuditSetters.length = 0;
    lateError.reject(new Error("late-unmount-error"));
    try { await lateError.promise; } catch {}
    check("#24 key effect 卸载后迟到 error 不再 setState", globalThis.__sharedAuditSetters.length === 0);
  } finally {
    compiled.cleanup();
    delete globalThis.__sharedAuditEffects;
    delete globalThis.__sharedAuditSetters;
  }
}

// #25：DPR 必须按调用时读取，且 backing store 在跨屏与 resize 后真实更新。
{
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  const compiled = await compileTarget("app/manage-ui/src/pages/GlassLab.tsx", "glass-lab", {
    plugins: [i18nStub],
    external: ["react"],
  });
  try {
    const first = compiled.mod.readGlassDpr?.();
    const canvas = { width: 0, height: 0, style: {} };
    const texture = { width: 0, height: 0 };
    compiled.mod.syncGlassBackingStore?.(canvas, texture, 100, 50);
    const firstBackingStoreOk = canvas.width === 100 && canvas.height === 50 && texture.width === 100 && texture.height === 50;
    globalThis.window.devicePixelRatio = 2.5;
    const second = compiled.mod.readGlassDpr?.();
    compiled.mod.syncGlassBackingStore?.(canvas, texture, 120, 60);
    check("#25 GlassLab DPR 动态读取并限制为 2", first === 1 && second === 2);
    check(
      "#25 DPR/resize 后 backing store 与 CSS 尺寸实际更新",
      firstBackingStoreOk && canvas.width === 240 && canvas.height === 120 && texture.width === 240 && texture.height === 120
        && canvas.style.width === "120px" && canvas.style.height === "60px",
    );
  } finally {
    compiled.cleanup();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
}

// 构造足以运行真实 LiquidGlassGL 的 WebGL mock，并记录资源重建和绘制。
function createFakeWebGl() {
  let objectId = 0;
  const calls = new Map();
  const count = (name) => calls.set(name, (calls.get(name) ?? 0) + 1);
  const gl = new Proxy({
    drawingBufferWidth: 200,
    drawingBufferHeight: 100,
    LINK_STATUS: 1,
    COMPILE_STATUS: 1,
    VERTEX_SHADER: 2,
    FRAGMENT_SHADER: 3,
    ARRAY_BUFFER: 4,
    STATIC_DRAW: 5,
    TEXTURE_2D: 6,
    RGBA: 7,
    UNSIGNED_BYTE: 8,
    TEXTURE_MIN_FILTER: 9,
    TEXTURE_MAG_FILTER: 10,
    TEXTURE_WRAP_S: 11,
    TEXTURE_WRAP_T: 12,
    LINEAR: 13,
    CLAMP_TO_EDGE: 14,
    FRAMEBUFFER: 15,
    COLOR_ATTACHMENT0: 16,
    TRIANGLE_STRIP: 17,
    FLOAT: 18,
    TEXTURE0: 19,
    TEXTURE1: 20,
    UNPACK_FLIP_Y_WEBGL: 21,
    BLEND: 22,
    SRC_ALPHA: 23,
    ONE_MINUS_SRC_ALPHA: 24,
    COLOR_BUFFER_BIT: 25,
    SCISSOR_TEST: 26,
    createProgram() { count("createProgram"); return { id: ++objectId }; },
    createShader() { count("createShader"); return { id: ++objectId }; },
    createBuffer() { count("createBuffer"); return { id: ++objectId }; },
    createTexture() { count("createTexture"); return { id: ++objectId }; },
    createFramebuffer() { count("createFramebuffer"); return { id: ++objectId }; },
    texImage2D() { count("texImage2D"); },
    getProgramParameter() { return true; },
    getShaderParameter() { return true; },
    getAttribLocation() { return 0; },
    getUniformLocation() { return {}; },
    drawArrays() { count("drawArrays"); },
    get calls() { return calls; },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => undefined;
    },
  });
  return gl;
}

// #26：丢失时阻止默认恢复并停绘；恢复时完整重建 program/buffer/texture。
{
  const listeners = new Map();
  const gl = createFakeWebGl();
  const canvas = {
    getContext: () => gl,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const compiled = await compileTarget("app/manage-ui/src/pages/glass/liquidGlassGL.ts", "liquid-glass");
  try {
    const renderer = new compiled.mod.LiquidGlassGL(canvas);
    const source = { width: 100, height: 50, videoWidth: 0 };
    renderer.setScene(source);
    const config = compiled.mod.DEFAULT_CONFIG;
    renderer.render([{ cx: 50, cy: 25, w: 20, h: 10 }], config, 1);
    const beforeLostDraws = gl.calls.get("drawArrays") ?? 0;
    let prevented = false;
    listeners.get("webglcontextlost")?.({ preventDefault: () => { prevented = true; } });
    renderer.render([{ cx: 50, cy: 25, w: 20, h: 10 }], config, 1);
    const afterLostDraws = gl.calls.get("drawArrays") ?? 0;
    const programsBeforeRestore = gl.calls.get("createProgram") ?? 0;
    const uploadsBeforeRestore = gl.calls.get("texImage2D") ?? 0;
    listeners.get("webglcontextrestored")?.({});
    const programsAfterRestore = gl.calls.get("createProgram") ?? 0;
    const uploadsAfterRestore = gl.calls.get("texImage2D") ?? 0;
    renderer.render([{ cx: 50, cy: 25, w: 20, h: 10 }], config, 1);
    const afterRestoreDraws = gl.calls.get("drawArrays") ?? 0;
    check("#26 context lost 调用 preventDefault", prevented);
    check("#26 context lost 后停止无效绘制", beforeLostDraws === afterLostDraws);
    check("#26 context restored 后完整重建 GL 资源", programsAfterRestore >= programsBeforeRestore + 3);
    check("#26 context restored 后重新上传最后场景", uploadsAfterRestore > uploadsBeforeRestore);
    check("#26 context restored 后恢复绘制", afterRestoreDraws > afterLostDraws);
    renderer.dispose();
    check("#26 dispose 移除 lost/restored listeners", listeners.size === 0);
  } finally {
    compiled.cleanup();
  }
}

// #26：恢复阶段资源重建失败必须通知上层切换 CSS 降级。
{
  const listeners = new Map();
  const gl = createFakeWebGl();
  let failLink = false;
  gl.getProgramParameter = () => !failLink;
  const canvas = {
    getContext: () => gl,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const compiled = await compileTarget("app/manage-ui/src/pages/glass/liquidGlassGL.ts", "liquid-glass-failure");
  try {
    let failures = 0;
    const renderer = new compiled.mod.LiquidGlassGL(canvas, { onContextFailure: () => { failures += 1; } });
    listeners.get("webglcontextlost")?.({ preventDefault() {} });
    failLink = true;
    const previousConsoleError = console.error;
    console.error = () => undefined;
    try {
      listeners.get("webglcontextrestored")?.({});
    } finally {
      console.error = previousConsoleError;
    }
    check("#26 context restore 失败触发 CSS 降级回调", failures === 1);
    renderer.dispose();
  } finally {
    compiled.cleanup();
  }
}

// #30：未来 anchor 之前，日视图与小时视图都不得反向推导幽灵执行。
{
  const compiled = await compileTarget("app/manage-ui/src/lib/cronOccurrences.ts", "cron-occurrences");
  try {
    const day = new Date(2026, 6, 15);
    const anchor = new Date(2026, 6, 16, 12, 0).getTime();
    const job = { id: "future", name: "future", schedule: { kind: "every", everyMs: 60 * 60_000, anchorMs: anchor } };
    check("#30 future anchor 前 occurrences 为空", compiled.mod.occurrencesOnDay(job, day).count === 0);
    check("#30 future anchor 前 hourly occurrences 为空", compiled.mod.hourlyOccurrencesOnDay(job, day).size === 0);
  } finally {
    compiled.cleanup();
  }
}

// #34：query=all 是字面搜索词；只有筛选枚举里的 all 作为哨兵省略。
{
  const previousFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const parsed = new URL(String(url), "http://audit.local");
    const payload = parsed.searchParams.get("action") === "runs" ? { runs: [] } : { jobs: [] };
    return { ok: true, text: async () => JSON.stringify(payload) };
  };
  const compiled = await compileTarget("app/manage-ui/src/api/client.ts", "api-client");
  try {
    await compiled.mod.listCronJobs({ query: "all", enabled: "all", scheduleKind: "all" });
    await compiled.mod.getCronRuns("job/1", { query: "all", status: "all", deliveryStatus: "all" });
    const listUrl = new URL(requested[0], "http://audit.local");
    const runsUrl = new URL(requested[1], "http://audit.local");
    check("#34 listCronJobs 字面 query=all 保留", listUrl.searchParams.get("query") === "all");
    check("#34 listCronJobs enum all 哨兵省略", !listUrl.searchParams.has("enabled") && !listUrl.searchParams.has("scheduleKind"));
    check("#34 getCronRuns 字面 query=all 保留", runsUrl.searchParams.get("query") === "all");
    check("#34 getCronRuns enum all 哨兵省略", !runsUrl.searchParams.has("status") && !runsUrl.searchParams.has("deliveryStatus"));
    check("#34 getCronRuns 保留 id/action 接线", runsUrl.searchParams.get("id") === "job/1" && runsUrl.searchParams.get("action") === "runs");
  } finally {
    compiled.cleanup();
    globalThis.fetch = previousFetch;
  }
}

// #43：只显示 top 子集时，百分比分母仍使用调用方提供的完整总量。
{
  const previousWindow = globalThis.window;
  globalThis.window = {
    ...(previousWindow || {}),
    matchMedia: () => ({ matches: true }),
  };
  const compiled = await compileTarget("app/manage-ui/src/pages/usage/charts.tsx", "usage-charts", {
    plugins: [i18nStub],
    external: ["react", "@base-ui/react/meter"],
  });
  try {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(compiled.mod.RankBars, {
        rows: [{ label: "visible", value: 60 }],
        totalValue: 100,
        fmt: (n) => String(n),
      }));
    });
    const text = renderer.root.findAllByType("span").map((node) => node.children.join("")).join(" ");
    check("#43 RankBars 用完整总量计算百分比", text.includes("60.0%") && !text.includes("100.0%"));
    await act(async () => { renderer.unmount(); });
  } finally {
    compiled.cleanup();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
}

// #44：并发成功首开只 open 一次，两位调用方都复用同一个连接。
{
  const previousIndexedDb = globalThis.indexedDB;
  let opens = 0;
  globalThis.indexedDB = {
    open() {
      opens += 1;
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => ({
            objectStore: () => ({ get: () => {
              const getReq = {};
              queueMicrotask(() => { getReq.result = undefined; getReq.onsuccess?.(); });
              return getReq;
            } }),
          }),
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
  const compiled = await compileTarget("app/manage-ui/src/lib/imageCache.ts", "image-cache-singleflight");
  try {
    await Promise.all([compiled.mod.getImages("first"), compiled.mod.getImages("second")]);
    check("#44 并发首开成功只调用一次 indexedDB.open", opens === 1);
  } finally {
    compiled.cleanup();
    if (previousIndexedDb === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previousIndexedDb;
  }
}

// #44：并发失败也应单飞、不得产生 unhandledRejection，之后调用可以重试成功。
{
  const previousIndexedDb = globalThis.indexedDB;
  let opens = 0;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  globalThis.indexedDB = {
    open() {
      const attempt = ++opens;
      const req = { error: new Error("transient") };
      queueMicrotask(() => {
        if (attempt === 1) {
          req.onerror?.();
          return;
        }
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => ({
            objectStore: () => ({ get: () => {
              const getReq = {};
              queueMicrotask(() => { getReq.result = undefined; getReq.onsuccess?.(); });
              return getReq;
            } }),
          }),
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
  const compiled = await compileTarget("app/manage-ui/src/lib/imageCache.ts", "image-cache-retry");
  try {
    await Promise.all([compiled.mod.getImages("first"), compiled.mod.getImages("second")]);
    await new Promise((resolve) => setImmediate(resolve));
    check("#44 并发失败首开仍只调用一次 indexedDB.open", opens === 1);
    check("#44 openDb 失败不产生 unhandledRejection", unhandled.length === 0);
    await compiled.mod.getImages("retry");
    check("#44 openDb 瞬时失败后允许重试", opens === 2);
  } finally {
    compiled.cleanup();
    process.off("unhandledRejection", onUnhandled);
    if (previousIndexedDb === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previousIndexedDb;
  }
}

// #45：快速路径大小写不敏感，lowercase media 指令仍进入真实解析。
{
  const compiled = await compileTarget("app/manage-ui/src/lib/agentMedia.ts", "agent-media");
  try {
    const result = compiled.mod.extractAgentMedia("完成\nmedia:https://example.com/a.png");
    check("#45 lowercase media 指令可解析", result.srcs[0] === "https://example.com/a.png" && result.text === "完成");
  } finally {
    compiled.cleanup();
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
