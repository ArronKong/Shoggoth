import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

interface GuardRegistration {
  dirty: boolean;
  busy: boolean;
  onDiscard: () => void;
}

interface NavigationGuardContextValue {
  requestNavigation: (target: string | (() => void)) => boolean;
  register: (id: symbol, guard: GuardRegistration | null) => void;
}

const NavigationGuardContext = createContext<NavigationGuardContextValue | null>(null);

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const guardsRef = useRef(new Map<symbol, GuardRegistration>());
  const acceptedPathRef = useRef(`${location.pathname}${location.search}${location.hash}`);
  const bypassPathRef = useRef<string | null>(null);

  // 所有显式导航入口共用同步门：busy 直接阻断，dirty 默认焦点由浏览器确认框处理。
  const requestNavigation = useCallback((target: string | (() => void)): boolean => {
    const guards = [...guardsRef.current.values()];
    if (guards.some((guard) => guard.busy)) return false;
    const dirtyGuards = guards.filter((guard) => guard.dirty);
    if (dirtyGuards.length > 0 && !window.confirm(t("models.discardNavigation"))) return false;
    for (const guard of dirtyGuards) guard.onDiscard();
    if (typeof target === "string") {
      bypassPathRef.current = target;
      navigate(target);
    } else {
      target();
    }
    return true;
  }, [navigate, t]);

  // 捕获浏览器 back/forward 这类未经过 requestNavigation 的 hash 跳转。
  useEffect(() => {
    const nextPath = `${location.pathname}${location.search}${location.hash}`;
    if (nextPath === acceptedPathRef.current) return;
    if (bypassPathRef.current === nextPath) {
      bypassPathRef.current = null;
      acceptedPathRef.current = nextPath;
      return;
    }
    const guards = [...guardsRef.current.values()];
    const dirtyGuards = guards.filter((guard) => guard.dirty);
    if (guards.some((guard) => guard.busy)
      || (dirtyGuards.length > 0 && !window.confirm(t("models.discardNavigation")))) {
      bypassPathRef.current = acceptedPathRef.current;
      navigate(acceptedPathRef.current, { replace: true });
      return;
    }
    for (const guard of dirtyGuards) guard.onDiscard();
    acceptedPathRef.current = nextPath;
  }, [location.hash, location.pathname, location.search, navigate, t]);

  // 浏览器窗口关闭/刷新无法使用自定义文案，只设置标准 beforeunload 阻断信号。
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const guards = [...guardsRef.current.values()];
      if (!guards.some((guard) => guard.dirty || guard.busy)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const value = useMemo<NavigationGuardContextValue>(() => ({
    requestNavigation,
    register: (id, guard) => {
      if (guard) guardsRef.current.set(id, guard);
      else guardsRef.current.delete(id);
    },
  }), [requestNavigation]);
  return <NavigationGuardContext.Provider value={value}>{children}</NavigationGuardContext.Provider>;
}

export function useNavigationGuard({
  dirty,
  busy,
  onDiscard,
}: GuardRegistration): void {
  const context = useContext(NavigationGuardContext);
  if (!context) throw new Error("useNavigationGuard 必须位于 NavigationGuardProvider 内");
  const discardRef = useRef(onDiscard);
  const registrationId = useRef(Symbol("navigation-guard"));
  discardRef.current = onDiscard;
  useEffect(() => {
    const id = registrationId.current;
    context.register(id, { dirty, busy, onDiscard: () => discardRef.current() });
    return () => context.register(id, null);
  }, [busy, context, dirty]);
}

export function useNavigationRequest(): NavigationGuardContextValue["requestNavigation"] {
  const context = useContext(NavigationGuardContext);
  if (!context) throw new Error("useNavigationRequest 必须位于 NavigationGuardProvider 内");
  return context.requestNavigation;
}
