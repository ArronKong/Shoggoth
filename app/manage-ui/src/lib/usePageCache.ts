import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// 管理页在路由切换时整页卸载重挂（App.tsx 只保活 ChatPage），每次进页都要重拉
// 数据、过一遍加载态。这里是全站统一的 stale-while-revalidate：结果留在模块级
// Map（键必须含 backend tab / filters / range 等一切影响结果的输入），重挂载命中
// 即首帧渲染旧数据，effect 照常后台刷新并回写；fetch 完成时即使组件已卸载也落
// 缓存（首次加载中途切走，扫完回来仍秒开）。refresh() 写穿缓存且不进加载态，
// 供变更操作后与手动刷新键调用。
// 连接配置变化通过 invalidatePageCache 统一失效，不删除用户数据或草稿。
const PAGE_CACHE_LIMIT = 64;
const cache = new Map<string, unknown>();
const generations = new Map<string, number>();
let cacheRevision = 0;
const revisionListeners = new Set<() => void>();
const readRevision = () => cacheRevision;
const subscribeRevision = (listener: () => void) => {
  revisionListeners.add(listener);
  return () => { revisionListeners.delete(listener); };
};

// A saved connection change invalidates mounted pages and pages revisited later.
// Revision-qualified keys also prevent old requests from repopulating the cache.
export function invalidatePageCache(): void {
  cacheRevision += 1;
  cache.clear();
  generations.clear();
  for (const listener of revisionListeners) listener();
}

// generation 让同 key 的本地 mutation 可以淘汰更早发出的迟到 GET。
function generationOf(key: string): number {
  return generations.get(key) || 0;
}

function advanceGeneration(key: string): number {
  const next = generationOf(key) + 1;
  generations.set(key, next);
  return next;
}

// 读取命中项时移动到 Map 尾部，Map 的插入顺序就能充当轻量 LRU 队列。
function readCache<T>(key: string): T | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key) as T | undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

// 写缓存后淘汰最久未使用的键，避免筛选组合长期累积撑大渲染进程内存。
// generations 与 cache 同步淘汰（键由用户输入拼成，只淘汰值会让计数器无界增长）；
// 被淘汰键的在途请求 generation 归零后失配即丢弃 —— 宁可少一次回写，不给脏数据。
function writeCache<T>(key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > PAGE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
    generations.delete(oldest);
  }
}

export type PageCache<T> = {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  /** 页面级动作想复用同一条错误横幅时用（如 CronPage 的 act）。 */
  setError: (msg: string | null) => void;
  refresh: () => Promise<void>;
  /** 原子替换当前 key，并使此前同 key 的在途请求失效。 */
  replace: (next: T) => void;
};

export function usePageCache<T>(resourceKey: string, fetcher: () => Promise<T>): PageCache<T> {
  const revision = useSyncExternalStore(subscribeRevision, readRevision, readRevision);
  const key = `${revision}:${resourceKey}`;
  // fetcher 是每次渲染新建的闭包：走 ref 出依赖，只在 key 变化时重新拉。
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // 始终记录当前渲染所属 key，供在途 refresh 判断结果是否还能回写当前页面。
  const keyRef = useRef(key);
  keyRef.current = key;
  // refresh() 不受 key effect 的局部 alive 变量约束，单独记录组件挂载状态。
  const mountedRef = useRef(false);

  const [data, setData] = useState<T | undefined>(() => readCache<T>(key));
  const [loading, setLoading] = useState(!cache.has(key));
  const [error, setError] = useState<string | null>(null);

  // key 变化（切 backend tab / 改 filters）：render 期间同步换成新键的缓存，
  // 避免旧键数据在新键下闪一帧（React 官方 adjust-state-during-render 模式）。
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    const cached = cache.has(key);
    setData(cached ? readCache<T>(key) : undefined);
    setLoading(!cached);
    setError(null);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    // 每次真实 fetch 都领取新代际；同 key 的 effect/refresh 反序完成时只允许
    // 最后发起的一次写 cache 与 UI。replace() 也走同一代际，因此 mutation 优先。
    const requestGeneration = advanceGeneration(key);
    fetcherRef.current().then(
      (result) => {
        // 失配（期间有更新请求/变更写穿，或键被淘汰使计数器归零）整次丢弃；
        // loading/error 也只能由当前代际结算，避免旧请求提前结束新请求的加载态。
        const fresh = generationOf(key) === requestGeneration;
        if (fresh) writeCache(key, result); // 卸载后也落缓存
        if (!alive || !fresh) return;
        setData(result);
        setLoading(false);
      },
      (e) => {
        if (!alive || generationOf(key) !== requestGeneration) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [key]);

  const refresh = useCallback(async () => {
    // 捕获本次请求的 key；切换后端后结果仍写旧缓存，但不得覆盖新 key 的 UI 状态。
    const requestKey = key;
    const requestFetcher = fetcherRef.current;
    const requestGeneration = advanceGeneration(requestKey);
    if (mountedRef.current && keyRef.current === requestKey) setError(null);
    try {
      const result = await requestFetcher();
      if (generationOf(requestKey) !== requestGeneration) return;
      writeCache(requestKey, result);
      if (!mountedRef.current || keyRef.current !== requestKey) return;
      setData(result);
      setLoading(false);
    } catch (e) {
      // 旧 key 的失败也不能把当前页面改成错误态。
      if (generationOf(requestKey) !== requestGeneration) return;
      if (!mountedRef.current || keyRef.current !== requestKey) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [key]);

  // apply 成功后的复合状态一次性替换，先递增 generation 再写缓存和 React state。
  const replace = useCallback((next: T) => {
    const targetKey = key;
    advanceGeneration(targetKey);
    writeCache(targetKey, next);
    if (!mountedRef.current || keyRef.current !== targetKey) return;
    setData(next);
    setLoading(false);
    setError(null);
  }, [key]);

  return { data, loading, error, setError, refresh, replace };
}
