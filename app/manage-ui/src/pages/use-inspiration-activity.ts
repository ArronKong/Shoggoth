import { useEffect, useState } from 'react';
import { getInspirationActivity } from '../api/client';
import type { InspirationActivity, InspirationExecution } from '../types';
import { inspirationActivitySession, watchInspirationActivity } from './inspiration-activity-events';

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'unknown']);

// The card and the full trajectory read the same run-scoped projection.
export function useInspirationActivity(ideaId: string, execution: InspirationExecution, enabled = true) {
  const [activity, setActivity] = useState<InspirationActivity | null>(null);
  const [errorRun, setErrorRun] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const live = ACTIVE.has(execution.status);
  const sessionKey = inspirationActivitySession(execution);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, pending = false, dirty = false;
    let unwatch: (() => void) | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      if (disposed || pending || document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      pending = true;
      dirty = false;
      try {
        const result = await getInspirationActivity(ideaId, execution.runId, controller.signal);
        if (!disposed && result.runId === execution.runId) { setActivity(result); setErrorRun(null); }
      } catch { if (!disposed) setErrorRun(execution.runId); }
      finally {
        pending = false;
        // Events arriving during a read need a trailing refresh. The slower
        // poll is recovery for a disconnected stream or a missing notification.
        if (!disposed && live) timer = setTimeout(() => { void refresh(); }, dirty ? 100 : 5000);
      }
    };
    const changed = () => {
      if (disposed || document.visibilityState === 'hidden' || dirty) return;
      dirty = true;
      if (!pending) { clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 100); }
    };
    const visible = () => {
      unwatch?.(); unwatch = undefined;
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') return;
      if (live && sessionKey) unwatch = watchInspirationActivity(sessionKey, execution.runId, changed);
      void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    visible();
    return () => { disposed = true; unwatch?.(); controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [ideaId, execution.runId, execution.status, sessionKey, live, enabled, retry]);
  return { activity: activity?.runId === execution.runId ? activity : null,
    error: errorRun === execution.runId, live, retry: () => setRetry(value => value + 1) };
}
