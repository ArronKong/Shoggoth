import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { getAgentModels } from "../api/client";
import { createAgentModelCatalogStore, EMPTY_AGENT_MODEL_CATALOG } from "../agent-model-catalog-store";
import { subscribeModelCatalog } from "../model-catalog-store";
import type { UnifiedModel } from "../types";
import { usePageCacheRevision } from "./usePageCache";

const store = createAgentModelCatalogStore(getAgentModels);
const emptyModels: UnifiedModel[] = [];
const emptySnapshot = () => EMPTY_AGENT_MODEL_CATALOG;
const noSubscription = () => () => {};
const backendWatches = new Map<string, { users: number; stop: () => void }>();

// A management catalog change invalidates Agent reads, never replaces them
// with the backend-wide "all" catalog. Subscribe once even with three menus.
function watchBackend(backend: string) {
  let watch = backendWatches.get(backend);
  if (!watch) {
    watch = { users: 0, stop: subscribeModelCatalog(backend, snapshot => {
      if (snapshot.backendId === backend && !snapshot.legacyPlaceholder) store.invalidateBackend(backend);
    }) };
    backendWatches.set(backend, watch);
  }
  watch.users += 1;
  return () => {
    if (--watch.users === 0) { watch.stop(); backendWatches.delete(backend); }
  };
}

export function useAgentModelCatalog(backend: string, agentId: string, {
  enabled = true, connected = true, reloadToken = 0,
}: { enabled?: boolean; connected?: boolean; reloadToken?: number } = {}) {
  const connectionRevision = usePageCacheRevision();
  const entry = useMemo(() => enabled && backend && agentId
    ? store.get(backend, agentId, connectionRevision) : null,
  [enabled, backend, agentId, connectionRevision]);
  const state = useSyncExternalStore(entry?.subscribe ?? noSubscription,
    entry?.getSnapshot ?? emptySnapshot, entry?.getSnapshot ?? emptySnapshot);
  useEffect(() => entry ? watchBackend(backend) : undefined, [entry, backend]);
  useEffect(() => {
    if (entry && connected) void entry.refresh().catch(() => {});
  }, [entry, connected, reloadToken, state.revision]);
  const refresh = useCallback(() => entry && connected ? entry.refresh() : Promise.resolve(), [entry, connected]);
  const invalidate = useCallback(() => entry?.invalidate(), [entry]);
  return { data: state.data, models: state.data?.models ?? emptyModels,
    loading: !!entry && connected && (state.loading || (!state.data && !state.error)),
    error: state.error, refresh, invalidate };
}
