// Loaded with group history and execution details, preserving the initial UI budget.
import { jsonFetch } from './client';
export interface GroupChatSearchResult {
  groupId: string; query: string; discussionId: string | null; authorKind: 'user' | 'member' | null; memberId: string | null;
  upperSeq: number; hits: Array<{ message: import('../types').GroupChatMessage; snippet: string; snippetOffset: number; partial: boolean }>;
  partial: boolean; hasMore: boolean; nextCursor: string | null;
}
export function searchGroupChatMessages(id: string, query: { query: string; discussionId?: string | null;
  authorKind?: 'user' | 'member' | null; memberId?: string | null; cursor?: string | null; limit?: number; signal?: AbortSignal }) {
  const params = new URLSearchParams({ id, query: query.query, limit: String(query.limit ?? 20) });
  for (const key of ['discussionId', 'authorKind', 'memberId', 'cursor'] as const) if (query[key]) params.set(key, query[key]!);
  return jsonFetch<GroupChatSearchResult>(`/__api/group-chats/messages/search?${params}`, { signal: query.signal });
}

export async function readGroupChatMessage(id: string, input: { seq: number; offset: number; digest: string | null }) {
  const params = new URLSearchParams({ id, seq: String(input.seq), offset: String(input.offset) });
  if (input.digest) params.set("digest", input.digest);
  const url = `/__api/group-chats/messages/read?${params}`;
  try {
    return await jsonFetch<{ page: import('../types').GroupResultPage }>(url);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // Only a transport read is replayed, with the original fixed source.
    // HTTP/policy errors and a second failure remain visible to the reader.
    await new Promise(resolve => setTimeout(resolve, 250));
    return jsonFetch<{ page: import('../types').GroupResultPage }>(url);
  }
}
