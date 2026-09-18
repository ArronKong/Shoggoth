import { useCallback, useEffect, useRef, useState } from "react";
import { getDashboardLiveWork } from "../../api/client";
import type { DashboardBackendSection, DashboardLiveWork } from "../../types";

// A failed source is not evidence that its running task has finished.
function retainFailedSources<T>(next: DashboardBackendSection<T>[], previous: DashboardBackendSection<T>[] = []) {
  return next.map(section => section.reason === "error"
    ? previous.find(old => old.backend === section.backend) || section : section);
}

export function useDashboardLiveWork(fallback?: DashboardLiveWork | null) {
  const [work, setWork] = useState<DashboardLiveWork>();
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const task = getDashboardLiveWork().then(next => {
      if (!mounted.current || request !== generation.current) return;
      setWork(previous => ({ ...next,
        running: retainFailedSources(next.running, previous?.running || fallbackRef.current?.running),
        approvals: retainFailedSources(next.approvals, previous?.approvals || fallbackRef.current?.approvals),
      }));
    }).catch(() => { /* Keep the last snapshot on a transient transport failure. */ });
    pending.current = task;
    await task;
    if (pending.current === task) pending.current = null;
  }, []);

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
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  return { work, refresh };
}
