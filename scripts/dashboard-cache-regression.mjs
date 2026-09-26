import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const manageUiRoot = path.join(projectRoot, "app/manage-ui");
const sourcePath = path.join(manageUiRoot, "src/lib/dashboardCache.ts");
const dashboardPagePath = path.join(manageUiRoot, "src/pages/DashboardPage.tsx");
const manageUiRequire = createRequire(path.join(manageUiRoot, "package.json"));
const ts = manageUiRequire("typescript");

/** 实际转译并执行 TypeScript 模块，确保测试覆盖真实导出与运行逻辑。 */
function loadDashboardCacheModule() {
  const source = fs.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });

  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(errors.length, 0, `TypeScript 转译失败：${errors.map((item) => item.messageText).join("; ")}`);

  const module = { exports: {} };
  const execute = new Function("exports", "require", "module", "__filename", "__dirname", transpiled.outputText);
  execute(module.exports, manageUiRequire, module, sourcePath, path.dirname(sourcePath));
  return module.exports;
}

const cache = loadDashboardCacheModule();
const requiredExports = [
  "DASHBOARD_CACHE_KEY",
  "decodeDashboardCache",
  "encodeDashboardCache",
  "readDashboardCache",
  "resolveDashboardViewState",
  "writeDashboardCache",
];
for (const exportName of requiredExports) {
  assert.ok(exportName in cache, `缺少导出：${exportName}`);
}

const {
  DASHBOARD_CACHE_KEY,
  decodeDashboardCache,
  encodeDashboardCache,
  readDashboardCache,
  resolveDashboardViewState,
  shouldWriteDashboardCache,
  writeDashboardCache,
} = cache;

const TODAY_NOON = new Date(2026, 6, 13, 12, 0, 0, 0).getTime();
const TODAY_START = new Date(2026, 6, 13, 0, 0, 0, 0).getTime();
const YESTERDAY_NOON = new Date(2026, 6, 12, 12, 0, 0, 0).getTime();

/** 生成满足最低安全形状的摘要，测试可按需覆盖局部字段。 */
function makeSummary(overrides = {}) {
  return {
    generatedAt: TODAY_NOON - 1_000,
    sinceMs: TODAY_START,
    status: [{ id: "openclaw", name: "OpenClaw", connected: true, info: {} }],
    runs: [{ backendId: "openclaw", jobId: "job-1" }],
    running: [{ backend: "openclaw", supported: true, items: [{ id: "running-1" }] }],
    approvals: [{ backend: "openclaw", supported: false, items: [] }],
    artifacts: [{
      backend: "openclaw",
      supported: true,
      items: [{ path: "/tmp/report.txt", name: "report.txt", area: "workspace", mtimeMs: TODAY_NOON, kind: "doc" }],
    }],
    usage: [{ backend: "openclaw" }],
    ...overrides,
  };
}

/** 生成 ActivityFeed 可安全渲染的活动条目，测试可覆盖单个坏字段。 */
function makeActivity(overrides = {}) {
  return {
    id: "activity-1",
    backendId: "openclaw",
    title: "Backend connected",
    occurredAt: TODAY_NOON,
    severity: "info",
    kind: "health",
    health: { targetType: "backend", targetId: "openclaw", state: "connected" },
    ...overrides,
  };
}

/** 生成内存 storage，并记录所有操作，便于验证单键覆盖和坏缓存清理。 */
function makeStorage(initialValue) {
  const values = new Map();
  if (initialValue !== undefined) values.set(DASHBOARD_CACHE_KEY, initialValue);
  const calls = [];
  return {
    calls,
    values,
    getItem(key) {
      calls.push(["getItem", key]);
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      calls.push(["setItem", key, value]);
      values.set(key, value);
    },
    removeItem(key) {
      calls.push(["removeItem", key]);
      values.delete(key);
    },
  };
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test("合法同日数据可以编解码并通过 storage 往返", () => {
  const summary = makeSummary();
  const storage = makeStorage();
  assert.equal(writeDashboardCache(summary, { storage, now: TODAY_NOON }), true);
  assert.deepEqual(readDashboardCache({ storage, now: TODAY_NOON }), summary);
});

test("完整合法活动、统计和额外字段可无损往返", () => {
  const summary = makeSummary({
    status: [{ id: "openclaw", name: "OpenClaw", connected: true, info: { agents: 2 }, futureStatusField: { enabled: true } }],
    running: [{ backend: "openclaw", supported: true, items: [{ id: "running-1", futureItemField: "保留" }], futureSectionField: 42 }],
    activityPage: {
      items: [
        makeActivity({ kind: "cron", run: { backendId: "openclaw", jobId: "run-1", futureRunField: "cron-extra" }, futureActivityField: 1 }),
        makeActivity({ id: "activity-2", kind: "kanban", kanban: { taskId: "task-1", action: "moved", futureKanbanField: true } }),
        makeActivity({ id: "activity-3", kind: "health", health: { targetType: "backend", targetId: "local", state: "connected", futureHealthField: [] } }),
      ],
      degradedSources: [{ backend: "openclaw", source: "remote", reason: "timeout", futureDegradedField: "extra" }],
      hasMore: true,
      futurePageField: { cursorVersion: 2 },
    },
    runStats: {
      total: { ok: 3, error: 1, skipped: 2, other: 4, total: 10, futureBucketField: 99 },
      byBackend: [],
      futureStatsField: "extra",
    },
    futureTopLevelField: { nested: ["中文", "😀"] },
  });
  const storage = makeStorage();

  assert.equal(writeDashboardCache(summary, { storage, now: TODAY_NOON }), true);
  assert.deepEqual(readDashboardCache({ storage, now: TODAY_NOON }), summary);
});

for (const [name, savedAt] of [
  ["昨日 savedAt", YESTERDAY_NOON],
  ["未来 savedAt", TODAY_NOON + 1],
  ["字符串 savedAt", "123"],
  ["null savedAt", null],
]) {
  test(`${name} 被拒绝并清理`, () => {
    const storage = makeStorage(JSON.stringify({ version: 1, savedAt, data: makeSummary() }));
    assert.equal(readDashboardCache({ storage, now: TODAY_NOON }), null);
    assert.equal(storage.values.has(DASHBOARD_CACHE_KEY), false);
  });
}

test("Infinity savedAt 被拒绝", () => {
  const raw = JSON.stringify({ version: 1, savedAt: 0, data: makeSummary() }).replace('"savedAt":0', '"savedAt":1e309');
  assert.equal(decodeDashboardCache(raw, TODAY_NOON), null);
});

test("昨日 summary 禁止在今日写入", () => {
  const storage = makeStorage();
  assert.equal(writeDashboardCache(makeSummary({ sinceMs: TODAY_START - 86_400_000 }), { storage, now: TODAY_NOON }), false);
  assert.equal(storage.calls.length, 0);
});

for (const [name, raw] of [
  ["损坏 JSON", "{"],
  ["错误版本", JSON.stringify({ version: 2, savedAt: TODAY_NOON, data: makeSummary() })],
]) {
  test(`${name} 被拒绝`, () => {
    assert.equal(decodeDashboardCache(raw, TODAY_NOON), null);
  });
}

for (const field of ["status", "runs", "usage"]) {
  test(`${field} 不接受 null 元素`, () => {
    assert.equal(encodeDashboardCache(makeSummary({ [field]: [null] }), TODAY_NOON), null);
  });
}

test("section 数组不接受 null 元素", () => {
  assert.equal(encodeDashboardCache(makeSummary({ running: [null] }), TODAY_NOON), null);
});

test("section 的 items 不接受 null", () => {
  assert.equal(encodeDashboardCache(makeSummary({ approvals: [{ supported: true, items: null }] }), TODAY_NOON), null);
});

test("section 的 items 不接受 null 元素", () => {
  assert.equal(encodeDashboardCache(makeSummary({ artifacts: [{ supported: true, items: [null] }] }), TODAY_NOON), null);
});

for (const [name, item] of [
  ["未知 kind", { kind: "unknown", run: {} }],
  ["cron 缺少 run", { kind: "cron" }],
  ["kanban 的 kanban 为 null", { kind: "kanban", kanban: null }],
  ["health 的 health 为数组", { kind: "health", health: [] }],
]) {
  test(`activityPage 拒绝${name}`, () => {
    const activityPage = { items: [item], degradedSources: [], hasMore: false };
    assert.equal(encodeDashboardCache(makeSummary({ activityPage }), TODAY_NOON), null);
  });
}

test("activityPage 拒绝错误容器形状", () => {
  const activityPage = { items: [], degradedSources: null, hasMore: "false" };
  assert.equal(encodeDashboardCache(makeSummary({ activityPage }), TODAY_NOON), null);
});

for (const [name, overrides] of [
  ["id 非字符串", { id: {} }],
  ["backendId 非字符串", { backendId: {} }],
  ["title 非字符串", { title: {} }],
  ["occurredAt 非有限数字", { occurredAt: Infinity }],
  ["severity 非字符串", { severity: {} }],
  ["agentId 非字符串", { agentId: {} }],
  ["summary 非字符串", { summary: {} }],
]) {
  test(`activityPage 拒绝活动公共字段：${name}`, () => {
    const activityPage = { items: [makeActivity(overrides)], degradedSources: [], hasMore: false };
    assert.equal(encodeDashboardCache(makeSummary({ activityPage }), TODAY_NOON), null);
  });
}

for (const [name, degradedSources] of [
  ["null 条目", [null]],
  ["backend 非字符串", [{ backend: {}, source: "cron", reason: "error" }]],
  ["source 非字符串", [{ backend: "openclaw", source: {}, reason: "error" }]],
  ["reason 非字符串", [{ backend: "openclaw", source: "cron", reason: {} }]],
]) {
  test(`activityPage 拒绝 degradedSources ${name}`, () => {
    const activityPage = { items: [], degradedSources, hasMore: false };
    assert.equal(encodeDashboardCache(makeSummary({ activityPage }), TODAY_NOON), null);
  });
}

test("running 拒绝会让摘要清理崩溃的 progressSummary 对象", () => {
  const running = [{ backend: "openclaw", supported: true, items: [{ id: "running-1", progressSummary: {} }] }];
  assert.equal(encodeDashboardCache(makeSummary({ running }), TODAY_NOON), null);
});

for (const [name, status] of [
  ["id", { id: {}, name: "OpenClaw", connected: true, info: {} }],
  ["name", { id: "openclaw", name: {}, connected: true, info: {} }],
  ["connected", { id: "openclaw", name: "OpenClaw", connected: "yes", info: {} }],
  ["info", { id: "openclaw", name: "OpenClaw", connected: true, info: null }],
  ["info.agents", { id: "openclaw", name: "OpenClaw", connected: true, info: { agents: "2" } }],
  ["info.cronJobs", { id: "openclaw", name: "OpenClaw", connected: true, info: { cronJobs: Infinity } }],
  ["info.profiles", { id: "openclaw", name: "OpenClaw", connected: true, info: { profiles: {} } }],
]) {
  test(`status 拒绝不安全字段 ${name}`, () => {
    assert.equal(encodeDashboardCache(makeSummary({ status: [status] }), TODAY_NOON), null);
  });
}

for (const [field, invalid] of [
  ["backendId", {}], ["jobId", {}],
  ["jobName", {}], ["agentId", {}], ["status", {}], ["error", {}], ["summary", {}],
  ["deliveryStatus", {}], ["model", {}], ["sessionKey", {}],
  ["startedAt", "1"], ["finishedAt", Infinity], ["durationMs", {}], ["synthesized", "yes"],
]) {
  test(`runs 拒绝不安全字段 ${field}`, () => {
    const run = { backendId: "openclaw", jobId: "job-1", [field]: invalid };
    assert.equal(encodeDashboardCache(makeSummary({ runs: [run] }), TODAY_NOON), null);
  });
}

for (const [field, invalid] of [
  ["id", {}], ["title", {}], ["kind", {}], ["agentId", {}], ["progressSummary", {}], ["startedAt", Infinity],
]) {
  test(`running items 拒绝不安全字段 ${field}`, () => {
    const running = [{ backend: "openclaw", supported: true, items: [{ id: "running-1", [field]: invalid }] }];
    assert.equal(encodeDashboardCache(makeSummary({ running }), TODAY_NOON), null);
  });
}

for (const [field, invalid] of [
  ["id", {}], ["commandPreview", {}], ["commandText", {}], ["agentId", {}],
  ["allowedDecisions", ["once", {}]], ["createdAtMs", Infinity], ["expiresAtMs", {}],
]) {
  test(`approval items 拒绝不安全字段 ${field}`, () => {
    const approvals = [{ backend: "openclaw", supported: true, items: [{ id: "approval-1", [field]: invalid }] }];
    assert.equal(encodeDashboardCache(makeSummary({ approvals }), TODAY_NOON), null);
  });
}

for (const [field, invalid] of [
  ["path", {}], ["name", {}], ["area", {}], ["mtimeMs", Infinity], ["kind", {}],
  ["agentId", {}], ["ext", {}], ["size", {}],
]) {
  test(`artifact items 拒绝不安全字段 ${field}`, () => {
    const item = { path: "/tmp/report.txt", name: "report.txt", area: "workspace", mtimeMs: TODAY_NOON, kind: "doc", [field]: invalid };
    const artifacts = [{ backend: "openclaw", supported: true, items: [item] }];
    assert.equal(encodeDashboardCache(makeSummary({ artifacts }), TODAY_NOON), null);
  });
}

for (const [field, invalid] of [
  ["backend", {}], ["error", {}],
  ["today", null],
  ["today", { date: {}, totalTokens: 1, totalCost: 1 }],
  ["today", { date: "2026-07-13", totalTokens: Infinity, totalCost: 1 }],
  ["yesterday", { date: "2026-07-12", totalTokens: 1, totalCost: {} }],
]) {
  test(`usage 拒绝不安全字段 ${field}`, () => {
    assert.equal(encodeDashboardCache(makeSummary({ usage: [{ backend: "openclaw", [field]: invalid }] }), TODAY_NOON), null);
  });
}

const validSectionItems = {
  running: [{ id: "running-1" }],
  approvals: [{ id: "approval-1" }],
  artifacts: [{ path: "/tmp/report.txt", name: "report.txt", area: "workspace", mtimeMs: TODAY_NOON, kind: "doc" }],
};
for (const sectionName of Object.keys(validSectionItems)) {
  for (const [field, invalid] of [["backend", {}], ["supported", "yes"], ["reason", {}]]) {
    test(`${sectionName} section 拒绝不安全字段 ${field}`, () => {
      const section = { backend: "openclaw", supported: true, items: validSectionItems[sectionName], [field]: invalid };
      assert.equal(encodeDashboardCache(makeSummary({ [sectionName]: [section] }), TODAY_NOON), null);
    });
  }
}

for (const [name, item] of [
  ["cron run", makeActivity({ kind: "cron", run: { backendId: {}, jobId: "job-1" } })],
  ["kanban taskId", makeActivity({ kind: "kanban", kanban: { taskId: {}, action: "moved" } })],
  ["kanban action", makeActivity({ kind: "kanban", kanban: { taskId: "task-1", action: {} } })],
  ["kanban board", makeActivity({ kind: "kanban", kanban: { taskId: "task-1", action: "moved", board: {} } })],
  ["health targetType", makeActivity({ health: { targetType: {}, targetId: "openclaw", state: "connected" } })],
  ["health targetId", makeActivity({ health: { targetType: "backend", targetId: {}, state: "connected" } })],
  ["health state", makeActivity({ health: { targetType: "backend", targetId: "openclaw", state: {} } })],
  ["health detectedAfterRestart", makeActivity({ health: { targetType: "backend", targetId: "openclaw", state: "connected", detectedAfterRestart: "yes" } })],
]) {
  test(`activityPage 拒绝不安全分支字段 ${name}`, () => {
    const activityPage = { items: [item], degradedSources: [], hasMore: false };
    assert.equal(encodeDashboardCache(makeSummary({ activityPage }), TODAY_NOON), null);
  });
}

for (const [name, total] of [
  ["total 为 null", null],
  ["计数字段缺失", { ok: 1, error: 0, skipped: 0, other: 0 }],
  ["计数字段无限", { ok: 1, error: 0, skipped: 0, other: 0, total: Infinity }],
]) {
  test(`runStats 拒绝${name}`, () => {
    assert.equal(encodeDashboardCache(makeSummary({ runStats: { total } }), TODAY_NOON), null);
  });
}

test("ASCII 原始缓存超过 1MiB 时在解析前拒绝", () => {
  const originalParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = () => {
    parseCalls += 1;
    throw new Error("超限缓存不应进入 JSON.parse");
  };
  try {
    assert.equal(decodeDashboardCache("a".repeat(1024 * 1024 + 1), TODAY_NOON), null);
    assert.equal(parseCalls, 0);
  } finally {
    JSON.parse = originalParse;
  }
});

test("中文和 emoji 按 UTF-8 字节计算超限", () => {
  const raw = `{"padding":"${"中😀".repeat(150_000)}"}`;
  assert.ok(raw.length < 1024 * 1024);
  assert.ok(Buffer.byteLength(raw, "utf8") > 1024 * 1024);
  const originalParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = () => {
    parseCalls += 1;
    throw new Error("UTF-8 超限缓存不应进入 JSON.parse");
  };
  try {
    assert.equal(decodeDashboardCache(raw, TODAY_NOON), null);
    assert.equal(parseCalls, 0);
  } finally {
    JSON.parse = originalParse;
  }
});

test("默认 localStorage getter 抛错时读取 fail-safe", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("getter"); } });
  try {
    assert.equal(readDashboardCache({ now: TODAY_NOON }), null);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("默认 localStorage getter 抛错时写入 fail-safe", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("getter"); } });
  try {
    assert.equal(writeDashboardCache(makeSummary(), { now: TODAY_NOON }), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("storage.getItem 抛错时读取 fail-safe", () => {
  const storage = { getItem() { throw new Error("get"); }, setItem() {}, removeItem() {} };
  assert.equal(readDashboardCache({ storage, now: TODAY_NOON }), null);
});

test("storage.setItem 抛错时写入 fail-safe", () => {
  const storage = { getItem() { return null; }, setItem() { throw new Error("set"); }, removeItem() {} };
  assert.equal(writeDashboardCache(makeSummary(), { storage, now: TODAY_NOON }), false);
});

test("坏缓存清理时 removeItem 抛错仍 fail-safe", () => {
  const storage = { getItem() { return "{"; }, setItem() {}, removeItem() { throw new Error("remove"); } };
  assert.equal(readDashboardCache({ storage, now: TODAY_NOON }), null);
});

test("成功写入始终覆盖同一个 key", () => {
  const storage = makeStorage("old");
  assert.equal(writeDashboardCache(makeSummary(), { storage, now: TODAY_NOON }), true);
  assert.equal(writeDashboardCache(makeSummary({ generatedAt: TODAY_NOON }), { storage, now: TODAY_NOON }), true);
  const setCalls = storage.calls.filter(([operation]) => operation === "setItem");
  assert.equal(setCalls.length, 2);
  assert.deepEqual(new Set(setCalls.map(([, key]) => key)), new Set([DASHBOARD_CACHE_KEY]));
  assert.equal(storage.values.size, 1);
});

test("持久缓存可直接承载加载首帧且不显示 loading", () => {
  const persistedData = makeSummary({ generatedAt: TODAY_NOON - 2_000 });
  const view = resolveDashboardViewState(undefined, persistedData, true, null);

  assert.equal(view.data, persistedData);
  assert.equal(view.showLoading, false);
  assert.equal(view.blockingError, null);
  assert.equal(view.nonBlockingError, null);
});

test("持久缓存遇到网络错误时保留数据并显示非阻塞错误", () => {
  const persistedData = makeSummary({ generatedAt: TODAY_NOON - 2_000 });
  const view = resolveDashboardViewState(undefined, persistedData, false, "network failed");

  assert.equal(view.data, persistedData);
  assert.equal(view.showLoading, false);
  assert.equal(view.blockingError, null);
  assert.equal(view.nonBlockingError, "network failed");
});

test("无可用数据时网络错误保持阻塞", () => {
  const view = resolveDashboardViewState(undefined, null, false, "network failed");

  assert.equal(view.data, undefined);
  assert.equal(view.showLoading, false);
  assert.equal(view.blockingError, "network failed");
  assert.equal(view.nonBlockingError, null);
});

test("实时摘要存在时优先于不同的持久缓存", () => {
  const persistedData = makeSummary({ generatedAt: TODAY_NOON - 2_000 });
  const liveData = makeSummary({ generatedAt: TODAY_NOON });
  const view = resolveDashboardViewState(liveData, persistedData, true, "stale error");

  assert.equal(view.data, liveData);
  assert.notEqual(view.data, persistedData);
  assert.equal(view.showLoading, false);
  assert.equal(view.blockingError, null);
  assert.equal(view.nonBlockingError, "stale error");
});

test("无任何数据的加载阶段显示 loading", () => {
  const view = resolveDashboardViewState(undefined, null, true, null);

  assert.equal(view.data, undefined);
  assert.equal(view.showLoading, true);
  assert.equal(view.blockingError, null);
  assert.equal(view.nonBlockingError, null);
});

test("generatedAt 去重保留首次网络写入并跳过重复持久化", () => {
  assert.equal(typeof shouldWriteDashboardCache, "function", "缺少 generatedAt 写入去重函数");
  const liveData = makeSummary({ generatedAt: TODAY_NOON });

  assert.equal(shouldWriteDashboardCache(liveData, undefined), true);
  assert.equal(shouldWriteDashboardCache(liveData, TODAY_NOON - 1_000), true);
  assert.equal(shouldWriteDashboardCache(liveData, TODAY_NOON), false);
});

test("后端范围变化时整份摘要缓存失效，重连和离线沿用相同范围约定", () => {
  const both = makeSummary({ status: [
    { id: "openclaw", name: "OpenClaw", connected: true, info: {} },
    { id: "shoggoth", name: "Shoggoth", connected: true, info: {} },
  ] });
  const shoggoth = makeSummary({ status: [
    { id: "openclaw", name: "OpenClaw", connected: false, disabled: true, info: {} },
    { id: "shoggoth", name: "Shoggoth", connected: false, info: {} },
  ] });
  assert.equal(resolveDashboardViewState(both, both, true, null, ["shoggoth"]).data, undefined,
    "旧内存和持久缓存不能把已断开后端的费用、任务、产物带回页面");
  assert.equal(resolveDashboardViewState(shoggoth, both, false, null, ["shoggoth"]).data, shoggoth,
    "已启用但暂时离线的后端不等于用户断开");
  assert.equal(resolveDashboardViewState(undefined, shoggoth, true, null, ["shoggoth", "openclaw"]).data, undefined,
    "重连也不能复用缺少新后端的统计");
  assert.equal(resolveDashboardViewState(both, null, false, null, ["shoggoth", "openclaw"]).data, both,
    "范围比较忽略后端排序");
  assert.equal(resolveDashboardViewState(both, null, false, null, []).data, undefined);
});

test("Dashboard 页面接入持久缓存并按统一视图状态渲染", () => {
  const source = fs.readFileSync(dashboardPagePath, "utf8");

  assert.match(
    source,
    /import\s*\{[^}]*readDashboardCache[^}]*resolveDashboardViewState[^}]*writeDashboardCache[^}]*\}\s*from\s*["']\.\.\/lib\/dashboardCache["']/s,
  );
  assert.match(source, /const\s*\[persistedData\]\s*=\s*useState\(\(\)\s*=>\s*readDashboardCache\(\)\)/);
  assert.match(source, /useRef\(persistedData\?\.generatedAt\)/);
  assert.match(source, /data:\s*liveData/);
  assert.match(
    source,
    /resolveDashboardViewState\(\s*liveData,\s*persistedData,\s*loading,\s*error,\s*enabledBackendIds,?\s*\)/,
  );
  assert.match(source, /usePageCache\(`dashboard:\$\{backendScopeKey\}`/);
  assert.match(source, /shouldWriteDashboardCache\(liveData,\s*cachedGeneratedAtRef\.current\)/);
  assert.match(
    source,
    /if\s*\(writeDashboardCache\(liveData\)\)\s*cachedGeneratedAtRef\.current\s*=\s*liveData\.generatedAt/,
  );
  assert.match(source, /\},\s*\[liveData\]\s*\)/);
  assert.match(source, /blockingError\s*&&[\s\S]*?<div\s+className=["']dash-error["']\s+role=["']alert["']/);
  assert.match(source, /nonBlockingError\s*&&/);
  assert.match(source, /showLoading\s*&&/);
});

let passed = 0;
for (const { name, run } of tests) {
  try {
    run();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

console.log(`dashboard cache regression: ${passed}/${tests.length} passed`);
