import { listInspirations } from '../api/client';
import type { InspirationFilter, InspirationIdea, InspirationPageResult } from '../types';

export type InspirationWallPages = InspirationPageResult & { pageCount: number };
export const INSPIRATION_WALL_PAGE_SIZE = 20;
type AgentScope = { backendId: string; agentId: string };

// Refresh the revealed portion using a fresh cursor chain. Insertions and
// growth can move page boundaries; stale cursors would skip or duplicate notes.
export async function readInspirationWallPages(query: string, filter: InspirationFilter, count: number,
  agent?: AgentScope): Promise<InspirationWallPages> {
  const items = new Map<string, InspirationIdea>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let total = 0;
  let pageCount = 0;
  let hasMore = false;
  do {
    const page = await listInspirations({ query, filter, cursor, limit: INSPIRATION_WALL_PAGE_SIZE, ...agent });
    if (!pageCount) total = page.total;
    pageCount++;
    for (const idea of page.items) {
      const previous = items.get(idea.id);
      if (!previous || idea.revision > previous.revision) items.set(idea.id, idea);
    }
    hasMore = page.hasMore;
    cursor = page.nextCursor;
    if (hasMore) {
      if (!cursor || cursors.has(cursor)) throw new Error('Invalid inspiration pagination cursor');
      cursors.add(cursor);
    }
  } while (hasMore && pageCount < Math.max(1, count));
  return { items: [...items.values()], total, hasMore, nextCursor: hasMore ? cursor : null, pageCount };
}

export async function readAllAgentInspirationPages(pageCount: number, agent: AgentScope) {
  // The API's "all" excludes notes marked as results. Read enough of each
  // cursor chain to render the combined list through the requested page.
  const [notes, results] = await Promise.all([
    readInspirationWallPages('', 'all', pageCount, agent),
    readInspirationWallPages('', 'archived', pageCount, agent),
  ]);
  const byId = new Map<string, InspirationIdea>();
  for (const idea of [...notes.items, ...results.items]) {
    const previous = byId.get(idea.id);
    if (!previous || idea.revision > previous.revision) byId.set(idea.id, idea);
  }
  const ordered = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const limit = pageCount * INSPIRATION_WALL_PAGE_SIZE;
  return { items: ordered.slice(0, limit), hasMore: notes.hasMore || results.hasMore || ordered.length > limit, pageCount };
}
