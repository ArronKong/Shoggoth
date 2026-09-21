import type { InspirationIdea, InspirationPageResult, InspirationStatus } from '../types';

const ACTIVE = new Set<InspirationStatus>(['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'unknown']);
type State = { signature: string; active: boolean };
export type InspirationNotificationSnapshot = { since: number; states: Map<string, State> };
type Reader = {
  list: (query: { query: string; filter: 'all' | 'active'; cursor: string | null; limit: number }) => Promise<InspirationPageResult>;
  get: (id: string) => Promise<{ idea: InspirationIdea }>;
};

export function inspirationNotificationStatus(idea: InspirationIdea): InspirationStatus {
  const execution = idea.latestExecution;
  if (execution?.attention?.active) {
    return execution.attention.request.kind === 'user_input' ? 'waiting_input' : 'waiting_approval';
  }
  return execution?.status ?? idea.status;
}

// Read recent changes plus all active notes, rather than the entire saved history
// every tick. Execution updates do not change idea.updatedAt: if an active note
// leaves the active list, resolve its final outcome through the detail endpoint.
export async function readInspirationNotifications(previous: InspirationNotificationSnapshot | null, reader: Reader) {
  const ideas = new Map<string, InspirationIdea>();
  let since = previous?.since ?? 0;
  for (const filter of ['all', 'active'] as const) {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page = await reader.list({ query: '', filter, cursor, limit: 50 });
      for (const idea of page.items) ideas.set(idea.id, idea);
      if (filter === 'all') {
        for (const idea of page.items) since = Math.max(since, idea.updatedAt);
        // The all-list is sorted by updatedAt descending. The initial recent
        // page seeds silently; active notes are seeded independently below.
        if (!previous || page.items.some(idea => idea.updatedAt < previous.since)) break;
      }
      if (!page.hasMore) break;
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error('Invalid inspiration notification cursor');
      cursor = page.nextCursor;
      cursors.add(cursor);
    } while (true);
  }

  // A failed detail read must leave the previous snapshot intact for a retry.
  // Deleted notes no longer have anything to notify; other errors propagate.
  for (const [id, state] of previous?.states ?? []) {
    if (!state.active || ideas.has(id)) continue;
    try { ideas.set(id, (await reader.get(id)).idea); }
    catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }

  const states = new Map<string, State>();
  const changed: InspirationIdea[] = [];
  for (const idea of ideas.values()) {
    const status = inspirationNotificationStatus(idea);
    const execution = idea.latestExecution;
    const state = {
      signature: JSON.stringify([execution?.runId, status, execution?.attention?.active ? execution.attention.request.requestId : null]),
      active: idea.archivedAt === null && ACTIVE.has(status),
    };
    states.set(idea.id, state);
    if (!previous || idea.archivedAt !== null) continue;
    const before = previous.states.get(idea.id);
    // An old completed note edited or unarchived today is not a new execution.
    const newActivity = idea.createdAt >= previous.since || (execution?.createdAt ?? -1) >= previous.since;
    if (before ? before.signature !== state.signature : newActivity) changed.push(idea);
  }
  return { snapshot: { since, states }, changed };
}
