import { createAgentNameIndex, findAgentDisplayName, type AgentNameIndex } from "./agentDisplay";

interface LinkedSessionRow { key: string; agentName?: string }

/** Session keys use gateway routing ids, including the namespace of each backend. */
export function applyChatSessionAgentNames<T extends LinkedSessionRow>(
  rows: T[],
  currentNames: AgentNameIndex,
  previous: readonly T[] = [],
): T[] {
  const agentIdOf = (row: T) => row.key.split(":")[1] || row.key;
  const knownNames = createAgentNameIndex([...previous, ...rows].map((row) => ({
    id: agentIdOf(row), name: row.agentName,
  })));
  return rows.map((row) => {
    const id = agentIdOf(row);
    const name = findAgentDisplayName(currentNames, id)
      || row.agentName || findAgentDisplayName(knownNames, id);
    return name && name !== row.agentName ? { ...row, agentName: name } : row;
  });
}

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
