import type { AgentModelCatalog } from "./types";

export interface AgentModelCatalogState {
  data?: AgentModelCatalog;
  loading: boolean;
  error: string | null;
  revision: number;
}

export const EMPTY_AGENT_MODEL_CATALOG: AgentModelCatalogState = {
  loading: false, error: null, revision: 0,
};

// All consumers of an Agent share one snapshot and one in-flight read. The
// connection generation is part of identity, just like backend and Agent.
export function createAgentModelCatalogStore(
  fetcher: (backend: string, agentId: string) => Promise<AgentModelCatalog>,
  limit = 64,
) {
  const entries = new Map<string, ReturnType<typeof createEntry>>();

  function createEntry(backend: string, agentId: string) {
    let state = EMPTY_AGENT_MODEL_CATALOG;
    let generation = 0;
    let pending: Promise<void> | undefined;
    const listeners = new Set<() => void>();
    const publish = (next: AgentModelCatalogState) => {
      state = next;
      for (const listener of listeners) listener();
    };
    const entry = {
      backend,
      agentId,
      getSnapshot: () => state,
      get retained() { return listeners.size > 0 || !!pending; },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); prune(); };
      },
      refresh(): Promise<void> {
        if (pending) return pending;
        const requestGeneration = generation;
        publish({ ...state, loading: true, error: null });
        const request = Promise.resolve().then(() => fetcher(backend, agentId)).then(
          data => {
            if (requestGeneration === generation) publish({ ...state, data, loading: false, error: null });
          },
          error => {
            if (requestGeneration !== generation) return;
            publish({ ...state, loading: false, error: error instanceof Error ? error.message : String(error) });
            throw error;
          },
        ).finally(() => { if (pending === request) pending = undefined; });
        pending = request;
        return request;
      },
      invalidate() {
        generation += 1;
        pending = undefined;
        publish({ ...state, loading: false, error: null, revision: generation });
      },
    };
    return entry;
  }

  function prune(target = limit) {
    for (const [key, entry] of entries) {
      if (entries.size <= target) break;
      if (!entry.retained) entries.delete(key);
    }
  }

  return {
    get(backend: string, agentId: string, connectionRevision = 0) {
      const key = JSON.stringify([connectionRevision, backend, agentId]);
      let entry = entries.get(key);
      if (entry) entries.delete(key);
      else entry = createEntry(backend, agentId);
      // Prune before adding: a new entry must survive until React subscribes.
      prune(limit - 1);
      entries.set(key, entry);
      return entry;
    },
    invalidateBackend(backend: string) {
      for (const entry of entries.values()) if (entry.backend === backend) entry.invalidate();
    },
  };
}
