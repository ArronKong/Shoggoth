import { useCallback, useEffect, useRef, useState } from "react";
import { getBackendRunDetail } from "../../api/client";
import type { BackendRunDetail } from "../../types";
import { isTerminalRun } from "./runPresentation";

export function useDashboardRunDetail(backendId: string, runId: string, open: boolean) {
  const [detail, setDetail] = useState<BackendRunDetail | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    if (!open) return;
    let cancelled = false, pending = false, terminal = false;
    let controller: AbortController | null = null;
    const read = async () => {
      if (cancelled || pending || document.visibilityState !== "visible") return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 15_000);
      try {
        const next = await getBackendRunDetail(backendId, runId, controller.signal);
        if (cancelled) return;
        if (next.backendId !== backendId || next.runId !== runId) throw new Error("Run identity mismatch");
        terminal = isTerminalRun(next.status);
        setDetail(next);
        setError(false);
        setNow(Date.now());
      } catch {
        if (!cancelled) { terminal = false; setError(true); }
      } finally {
        window.clearTimeout(timeout);
        pending = false;
      }
    };
    const tick = () => {
      if (document.visibilityState !== "visible" || terminal) return;
      setNow(Date.now());
      void read();
    };
    refreshRef.current = () => { void read(); };
    tick();
    const timer = window.setInterval(tick, 2_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      controller?.abort();
      refreshRef.current = () => {};
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [backendId, runId, open]);
  return { detail, error, now, refresh };
}
