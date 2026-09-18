interface LinkedSessionRow { key: string }

/** A metadata refresh is not proof that a pending link appeared in sessions.list. */
export function mergeLinkedSessionRows<T extends LinkedSessionRow>(
  rows: T[],
  linkedRows: Map<string, T>,
  authoritativeRows?: readonly T[],
): T[] {
  const have = new Set(rows.map((row) => row.key));
  if (authoritativeRows) {
    const listed = new Set(authoritativeRows.map((row) => row.key));
    for (const key of linkedRows.keys()) if (listed.has(key)) linkedRows.delete(key);
  }
  const missing = [...linkedRows.values()].filter((row) => !have.has(row.key));
  return missing.length ? [...rows, ...missing] : rows;
}

/** Opening may await cache/scope I/O. Apply report context only after it has selected the target. */
export async function openChatSessionLink(key: string, deps: {
  ensureSession(): void;
  openSession(key: string): Promise<void>;
  refreshSessions(): Promise<void>;
  isCurrent(): boolean;
  onOpened(): void;
  onError(error: unknown): void;
}): Promise<void> {
  deps.ensureSession();
  const opening = deps.openSession(key);
  // The session list can legitimately omit a retained Cron run; history is the
  // authority for its contents and its existing failure state remains visible.
  void deps.refreshSessions().catch(() => {});
  try {
    await opening;
    if (deps.isCurrent()) deps.onOpened();
  } catch (error) {
    if (deps.isCurrent()) deps.onError(error);
  }
}
