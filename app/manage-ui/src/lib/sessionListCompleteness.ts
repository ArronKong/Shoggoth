export interface SessionListRow {
  key?: string;
  updatedAt?: number | null;
}

// A list response can be authoritative for one backend and partial for another
// (for example OpenClaw is live while Hermes dashboards are still starting).
// Fresh rows always win by key; only absent rows from explicitly incomplete
// partitions survive from the previous snapshot.
export function mergeIncompleteSessionRows<T extends SessionListRow>(
  previous: T[],
  next: T[],
  incompleteBackends: Set<string>,
  backendOfRow: (row: T) => string,
): T[] {
  if (!incompleteBackends.size) return next;
  const have = new Set(next.map((row) => row?.key));
  const kept = previous.filter(
    (row) => row?.key && !have.has(row.key) && incompleteBackends.has(backendOfRow(row)),
  );
  if (!kept.length) return next;
  return [...next, ...kept].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
