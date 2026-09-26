import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

// 管理页在路由切换时整页卸载重挂（App.tsx 只保活 ChatPage），工具栏上的 tab /
// 筛选 / 搜索词随之丢回默认值——数据侧有 usePageCache 兜底「秒开」，但用户选过的
// 视角每次进页都要重选。这里是全站统一的「工具栏状态」持久化：模块级 Map 是实时
// 源，启动时从单个 localStorage 键一次性水合，改动防抖整体回写。
// 只放 tab / 筛选 / 搜索词 / 视图模式这类可重放的选择；抽屉开关、选中行、
// loading 这类瞬时态不要进来（切回来自动弹抽屉很突兀）。
//
// ★ 改了某个 key 的值形状（枚举改名、对象字段语义变化…）就提 STORE_VERSION，
//   否则老机器上的旧值会喂进新代码。
const STORE_KEY = "shoggoth.ui.v1";
const STORE_VERSION = 1;
const FLUSH_MS = 150;

const store = new Map<string, unknown>();

// localStorage 在配额满/隐私模式下会抛错：全部 try/catch 吞掉，退化成纯内存，
// 行为等价于没有持久化之前，不能让工具栏状态把页面搞崩。
try {
  const raw = window.localStorage.getItem(STORE_KEY);
  const parsed = raw ? (JSON.parse(raw) as { version?: number; values?: Record<string, unknown> }) : null;
  if (parsed && parsed.version === STORE_VERSION && parsed.values) {
    for (const [key, value] of Object.entries(parsed.values)) store.set(key, value);
  }
} catch {
  /* 读不到就从空开始 */
}

let flushTimer: number | undefined;

function flush(): void {
  flushTimer = undefined;
  try {
    window.localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ version: STORE_VERSION, values: Object.fromEntries(store) }),
    );
  } catch {
    /* 写不进就只留内存 */
  }
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(flush, FLUSH_MS);
}

// 关窗前补一次，避免最后一次改动正好落在防抖窗口里丢掉。
try {
  window.addEventListener("pagehide", () => {
    if (flushTimer === undefined) return;
    window.clearTimeout(flushTimer);
    flush();
  });
} catch {
  /* 无 window 的宿主（测试/构建）跳过 */
}

// 存值与当前默认值类型对不上（旧版本遗留、手改过 localStorage）就丢弃：宁可回到
// 默认，也不要把脏值喂给页面。
function restore<T>(key: string, initial: T): T {
  if (!store.has(key)) return initial;
  const stored = store.get(key);
  if (stored === null || typeof stored !== typeof initial) return initial;
  if (Array.isArray(stored) !== Array.isArray(initial)) return initial;
  return stored as T;
}

/**
 * 这个 key 是否已经有用户存档。给「服务端提供默认值」的场景用：只有用户从没选过
 * 时才拿服务端默认值盖上去，选过就以用户为准（看板的 lanes/归档默认值走这条）。
 */
export function hasStickyValue(key: string): boolean {
  return store.has(key);
}

/**
 * useState 的持久化版本：切页、重开 App 后仍是上次选的那个视角。
 * key 必须是常量——本 hook 不处理 key 变化（换 key 只会把当前值写到新 key 名下，
 * 不会读出新 key 的存档）。想按后端/看板分档记忆，另开一个状态，别拼动态 key。
 * @param override 深链等外部指定值，优先于已存值（仅首帧生效）。
 */
export function useStickyState<T>(
  key: string,
  initial: T,
  override?: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (override === undefined ? restore(key, initial) : override));
  useEffect(() => {
    store.set(key, value);
    scheduleFlush();
  }, [key, value]);
  return [value, setValue];
}
