import { listInspirations } from '../api/client';
import type { InspirationFilter, InspirationIdea, InspirationPageResult } from '../types';

export type InspirationWallPages = InspirationPageResult & { pageCount: number };

// Refresh the revealed portion using a fresh cursor chain. Insertions and
// growth can move page boundaries; stale cursors would skip or duplicate notes.
export async function readInspirationWallPages(query: string, filter: InspirationFilter, count: number,
  agent?: { backendId: string; agentId: string }): Promise<InspirationWallPages> {
  const items = new Map<string, InspirationIdea>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let total = 0;
  let pageCount = 0;
  let hasMore = false;
  do {
    const page = await listInspirations({ query, filter, cursor, limit: 20, ...agent });
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
