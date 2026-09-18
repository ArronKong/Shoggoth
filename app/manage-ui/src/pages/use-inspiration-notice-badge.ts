import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InspirationGrowthResult } from '../types';

type Failure = InspirationGrowthResult['failures'][number];
const READ_KEY = 'shoggoth.inspiration.notices.read.v1';
const EMPTY_FAILURES: Failure[] = [];

function restoreReadNotices(): Map<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(READ_KEY) || '[]');
    if (Array.isArray(stored)) return new Map(stored.filter((entry): entry is [string, string] =>
      Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string')));
  } catch { /* Storage may be unavailable; viewing notices still works. */ }
  return new Map();
}

export function useInspirationNoticeBadge(failures = EMPTY_FAILURES, open = false) {
  const [read, setRead] = useState(restoreReadNotices);
  // A retry can fail again on the same idea without changing the list's size.
  // Track its execution and error, rather than acknowledging a total count.
  const unread = useMemo(() => failures.map(failure => [failure.ideaId,
    JSON.stringify([failure.runId, failure.attempts, failure.errorCode])] as const)
    .filter(([id, signature]) => read.get(id) !== signature), [failures, read]);
  const markRead = useCallback(() => {
    if (!unread.length) return;
    const next = new Map(read);
    for (const [id, signature] of unread) next.set(id, signature);
    setRead(next);
    try { localStorage.setItem(READ_KEY, JSON.stringify([...next])); }
    catch { /* Keep the current page's read state when storage is unavailable. */ }
  }, [read, unread]);

  // Updates shown while the list is open have already been seen, including
  // the refresh triggered by opening it.
  useEffect(() => { if (open) markRead(); }, [open, markRead]);
  return { unreadCount: open ? 0 : unread.length, markRead };
}
