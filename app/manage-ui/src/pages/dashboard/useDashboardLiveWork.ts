import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getDashboardLiveWork } from "../../api/client";
import { dashboardPromptResponseRevision, subscribeDashboardPromptResponses,
  withoutRespondedDashboardPrompts } from "../../lib/dashboardPromptResponses";
import type { DashboardBackendSection, DashboardLiveWork } from "../../types";

// A failed source is not evidence that its running task has finished.
function retainFailedSources<T>(next: DashboardBackendSection<T>[], previous: DashboardBackendSection<T>[] = []) {
  return next.map(section => section.reason === "error"
    ? previous.find(old => old.backend === section.backend) || section : section);
}

export function useDashboardLiveWork(fallback?: DashboardLiveWork | null, backendScopeKey = "") {
  const responseRevision = useSyncExternalStore(subscribeDashboardPromptResponses, dashboardPromptResponseRevision);
  const summaryFallback = useMemo(() => fallback ? { ...fallback, approvals: [],
    running: fallback.running.map(section => ({ ...section, items: section.items.filter(item =>
      !["waiting_approval", "waiting_input"].includes(item.status || "")) })),
  } : undefined, [fallback]);
  const [work, setWork] = useState<DashboardLiveWork>();
  const [previousScopeKey, setPreviousScopeKey] = useState(backendScopeKey);
  if (previousScopeKey !== backendScopeKey) {
    setPreviousScopeKey(backendScopeKey);
    setWork(undefined);
  }
  const fallbackRef = useRef(summaryFallback);
  fallbackRef.current = summaryFallback;
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const task = getDashboardLiveWork().then(next => {
      if (!mounted.current || request !== generation.current) return;
      setWork(previous => ({ ...next,
        running: retainFailedSources(next.running, previous?.running || fallbackRef.current?.running),
        approvals: retainFailedSources(next.approvals, previous?.approvals),
      }));
    }).catch(() => { /* Keep the last snapshot on a transient transport failure. */ });
    pending.current = task;
    await task;
    if (pending.current === task) pending.current = null;
  }, [backendScopeKey]);

  useEffect(() => {
    mounted.current = true;
    const tick = () => {
      if (document.visibilityState === "visible" && !pending.current) void refresh();
    };
    tick();
    const timer = window.setInterval(tick, 3_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      mounted.current = false;
      generation.current++;
      pending.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  const currentWork = useMemo(() => {
    // A summary may predate a response made in Chat or a previous App launch.
    // Only live reads can establish pending approvals; keep cached statistics
    // and running work available while that first read is pending or fails.
    const current = work || summaryFallback;
    return current ? withoutRespondedDashboardPrompts(current) : undefined;
  }, [work, summaryFallback, responseRevision]);
  return { work: currentWork, refresh };
}
