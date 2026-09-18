import { useEffect, useRef, useSyncExternalStore } from "react";

// 全站统一的刷新入口：再点一次左侧导航栏里已选中的那颗 icon = 重拉本页主数据
// （R361 起页面上不再各摆一颗「刷新」按钮）。这里是「路由 → 刷新函数」的登记表，
// 页面挂载时把自己的重拉函数登进来、卸载时注销，App.tsx 的导航项负责触发。
//
// 必须按路由分键、不能用单槽位：ChatPage 在路由间常驻不卸载（App.tsx 只隐藏它），
// 单槽位会被它永久占住，切到别的页面就再也刷不动。
export type PageRefreshHandler = () => void | Promise<unknown>;

const handlers = new Map<string, PageRefreshHandler>();
const loadings = new Set<string>();
const listeners = new Set<() => void>();

function notifyAll(): void {
  listeners.forEach((notify) => notify());
}

// useSyncExternalStore 的 subscribe 必须是稳定引用，否则每次渲染都要退订重订。
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** 页面登记自己的「重拉主数据」；handler 每次渲染新建也无妨（走 ref 出依赖）。 */
export function useRegisterPageRefresh(path: string, handler: PageRefreshHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    handlers.set(path, () => handlerRef.current());
    notifyAll();
    return () => {
      handlers.delete(path);
      notifyAll();
    };
  }, [path]);
}

// 导航项的 tooltip 要如实说明「这颗能不能刷」，而它渲染在页面登记之前：sidebar 在
// JSX 里排在 content 前面，effect 也就先跑，同步读表恒为空。故走订阅，等页面挂上
// 来登记时再翻牌。玻璃/组件这类无数据页永远不登记，tooltip 也就不会撒谎。
export function useHasPageRefresh(path: string): boolean {
  return useSyncExternalStore(subscribe, () => handlers.has(path));
}

/**
 * 页面上报「主数据正在加载」（R373）。导航图标的动画在加载期间持续播放，数据落地
 * 才停——所以慢后端会一直转，快后端只闪一下（App.tsx 另有最短播放时长兜底）。
 */
export function useRegisterPageLoading(path: string, loading: boolean): void {
  useEffect(() => {
    if (!loading) return;
    loadings.add(path);
    notifyAll();
    return () => {
      loadings.delete(path);
      notifyAll();
    };
  }, [path, loading]);
}

export function usePageLoading(path: string): boolean {
  return useSyncExternalStore(subscribe, () => loadings.has(path));
}

/** 触发某路由的刷新。返回 null = 该页没登记（玻璃/组件这些无数据的自建页）。 */
export function runPageRefresh(path: string): Promise<unknown> | null {
  const handler = handlers.get(path);
  if (!handler) return null;
  try {
    return Promise.resolve(handler());
  } catch (e) {
    return Promise.reject(e);
  }
}
