import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, getSessionRuntimeModels, selectSessionRuntimeModel } from "../api/client";
import { useToast } from "../components/ui";
import type { SessionRuntimeModel, SessionRuntimeModels } from "../types";
import { sessionRuntimeSupportKey } from "./sessionRuntimeSupport";

type RuntimeCatalog = Pick<SessionRuntimeModels, "models" | "runtimes">;
type ReadState = { key: string; data?: SessionRuntimeModels; error?: boolean };
type PickRequest = { model: string; bindingId: string; permissionMode: string | null; quiet: boolean;
  modelProviderRef?: string; activeTurn: boolean };

// Opening the menu re-reads only a catalog older than this.
const MENU_REFRESH_AFTER_MS = 30_000;
const REMEMBERED_SESSIONS = 64;
// Last read of each conversation, shown at once when it is reopened while its own read refreshes it.
const sessionReads = new Map<string, { data: SessionRuntimeModels; at: number }>();
// Last catalog of each Agent, shown for a conversation that has no read yet. Display only:
// the selection, capabilities and every write wait for that conversation's own read.
const agentCatalogs = new Map<string, RuntimeCatalog>();

function remember(key: string, agentKey: string, data: SessionRuntimeModels) {
  sessionReads.delete(key);
  sessionReads.set(key, { data, at: Date.now() });
  while (sessionReads.size > REMEMBERED_SESSIONS) sessionReads.delete(sessionReads.keys().next().value!);
  agentCatalogs.set(agentKey, { models: data.models, runtimes: data.runtimes });
}

/** A conversation owns its Runtime and model selection, independently of the Agent default. */
export function useSessionRuntimeModels(backend: string, agentId: string, sessionKey: string | null,
  enabled: boolean, connected: boolean, connectionEpoch = 0) {
  const toast = useToast();
  const { t } = useTranslation();
  const key = enabled && sessionKey ? `${backend}:${agentId}:${sessionKey}` : "";
  const agentKey = `${backend}:${agentId}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const mounted = useRef(false);
  const [pendingSelections, setPendingSelections] = useState(() => new Map<string, SessionRuntimeModel>());
  const selecting = useRef(pendingSelections);
  const flight = useRef<{ key: string; request: number; promise: Promise<void>; controller: AbortController } | null>(null);
  // One write chain per conversation. A pick made while a write runs replaces any pick
  // not yet written; the chain resolves with the outcome of the last one.
  const writes = useRef(new Map<string, { latest: PickRequest | null; done: Promise<boolean> }>());
  const [state, setState] = useState<ReadState>({ key: "" });
  // Mirrors `state` synchronously, so a write that waited for a read sees its result at once.
  const confirmed = useRef<ReadState>(state);
  const commit = (next: ReadState) => {
    confirmed.current = next;
    if (next.data) remember(next.key, agentKey, next.data);
    setState(next);
  };
  const [loading, setLoading] = useState(false);
  const remembered = key ? sessionReads.get(key)?.data : undefined;
  const data = state.key === key ? state.data ?? (state.error ? undefined : remembered) : remembered;
  const error = state.key === key && state.error === true;
  const catalog: RuntimeCatalog | undefined = data ?? (key ? agentCatalogs.get(agentKey) : undefined);
  const pendingModel = pendingSelections.get(key);
  const changePending = (choice?: SessionRuntimeModel) => {
    const next = new Map(selecting.current);
    if (choice) next.set(key, choice); else next.delete(key);
    selecting.current = next;
    if (mounted.current) setPendingSelections(next);
  };

  const cancelRead = useCallback(() => {
    generation.current++;
    const previous = flight.current;
    flight.current = null;
    previous?.controller.abort();
  }, []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  // `force`: a pick that is shown but not yet written reads its conversation's revision.
  const read = useCallback(async (force: boolean) => {
    if (currentKey.current !== key) return;
    if (!key || !sessionKey || !connected) { setLoading(false); return; }
    if (!force && selecting.current.has(key)) return;
    if (flight.current?.key === key) return flight.current.promise;
    const request = ++generation.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    setLoading(true);
    const promise = (async () => {
      try {
        const next = await getSessionRuntimeModels(backend, agentId, sessionKey, controller.signal);
        if (mounted.current && currentKey.current === key && generation.current === request) commit({ key, data: next });
      } catch {
        if (mounted.current && currentKey.current === key && generation.current === request) {
          const previous = confirmed.current;
          commit({ key, data: previous.key === key ? previous.data : undefined, error: true });
        }
      } finally {
        clearTimeout(timer);
        if (flight.current?.request === request) flight.current = null;
        if (mounted.current && currentKey.current === key && generation.current === request) setLoading(false);
      }
    })();
    flight.current = { key, request, promise, controller };
    return promise;
  }, [backend, agentId, sessionKey, key, connected, connectionEpoch]);
  const refresh = useCallback(() => read(false), [read]);
  // A reconnected Service must not join a read owned by its previous connection.
  // Cancel on disconnect/session changes and reject any late response by generation.
  useEffect(() => { void refresh(); return cancelRead; }, [refresh, cancelRead]);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  // The menu reads again only when this conversation's catalog is old or not yet confirmed.
  const refreshIfStale = useCallback(() => {
    const read = key ? sessionReads.get(key) : undefined;
    const current = confirmed.current;
    if (current.key === key && current.data && !current.error && read && Date.now() - read.at < MENU_REFRESH_AFTER_MS) {
      return Promise.resolve();
    }
    return refresh();
  }, [key, refresh]);
  const partialCatalog = data?.runtimes.some(group => group.unavailableSource) === true;
  // Retry once per transition to partial. A second partial response leaves manual reload available.
  useEffect(() => {
    if (!connected || !partialCatalog || pendingModel) return;
    const retry = setTimeout(() => { void refresh(); }, 1500);
    return () => clearTimeout(retry);
  }, [connected, partialCatalog, pendingModel, refresh]);

  // Writes one pick. `isLast` tells whether no newer pick is waiting: only the last one
  // clears the shown choice, reports a failure and re-reads after it.
  const write = async (pick: PickRequest, isLast: () => boolean) => {
    // A catalog shown from an earlier read carries an old revision: write after this conversation's own read.
    if (confirmed.current.key !== key || !confirmed.current.data) {
      await (flight.current?.key === key ? flight.current.promise : read(true));
    }
    const current = mounted.current && currentKey.current === key && confirmed.current.key === key && !confirmed.current.error
      ? confirmed.current.data : undefined;
    const choice = current?.models.find(item => item.id === pick.model && item.bindingId === pick.bindingId
      && item.modelProviderRef === pick.modelProviderRef);
    if (!current || !choice || (!current.selection.canSwitch && pick.bindingId !== current.selection.bindingId)) {
      if (isLast()) changePending();
      return false;
    }
    const candidate = current.selection.candidates.find(item => item.bindingId === pick.bindingId);
    cancelRead();
    const writeGeneration = generation.current;
    setLoading(false);
    // Selecting a model also selects its Runtime. Apply that Runtime's compatible
    // permission mode as part of the same explicit action, without a second prompt.
    const acceptAdjustments = pick.bindingId !== current.selection.bindingId
      || candidate?.adjustments.clearModelOverride === true
      || candidate?.adjustments.permissionMode !== pick.permissionMode;
    try {
      const selection = await selectSessionRuntimeModel(backend, agentId, sessionKey!, { model: pick.model,
        bindingId: pick.bindingId, revision: current.selection.revision, acceptAdjustments,
        ...(pick.modelProviderRef ? { modelProviderRef: pick.modelProviderRef } : {}) });
      // Navigation can invalidate the view while the Service still saves this conversation's pick.
      if (!mounted.current || currentKey.current !== key || generation.current !== writeGeneration) return true;
      const runtime = current.runtimes.find(group => group.bindingId === selection.bindingId)
        ?? current.runtimes.find(group => !group.bindingId && group.runtime === selection.runtime);
      const capabilities = runtime?.capabilities ?? current.capabilities;
      commit({ key, data: { ...current, selection, capabilities: pick.activeTurn
        ? { ...capabilities, steer: current.capabilities.steer } : capabilities } });
      return true;
    } catch (error) {
      // Support codes arrive untranslated; everything else already has a public message.
      const supportKey = error instanceof ApiError ? sessionRuntimeSupportKey(error.code) : null;
      if (mounted.current && currentKey.current === key && generation.current === writeGeneration && !pick.quiet && isLast()) {
        toast.error(supportKey ? t(supportKey) : error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (isLast()) changePending();
      // A return to this session or a reconnect may have skipped its read while the write was outstanding.
      if (mounted.current && currentKey.current === key && generation.current !== writeGeneration) void latestRefresh.current();
    }
    // Restore the previous choice while re-reading a potentially changed revision.
    if (isLast() && mounted.current && currentKey.current === key && generation.current === writeGeneration) await latestRefresh.current();
    return false;
  };

  // The choice shows at once and is written in the background, so the composer never
  // waits for it; `settled` lets a send or a setting change wait for the write.
  // `quiet`: an automatic choice fails silently; the menu still offers every model.
  const select = (model: string, bindingId: string, permissionMode: string | null,
    { quiet = false, modelProviderRef, activeTurn = false }: { quiet?: boolean; modelProviderRef?: string; activeTurn?: boolean } = {}) => {
    if (!sessionKey || currentKey.current !== key || !connected) return Promise.resolve(false);
    const choice = catalog?.models.find(item => item.id === model && item.bindingId === bindingId
      && item.modelProviderRef === modelProviderRef);
    if (!choice || (data && !data.selection.canSwitch && bindingId !== data.selection.bindingId)) return Promise.resolve(false);
    changePending(choice);
    const pick = { model, bindingId, permissionMode, quiet, modelProviderRef, activeTurn };
    const running = writes.current.get(key);
    if (running) { running.latest = pick; return running.done; }
    const chain: { latest: PickRequest | null; done: Promise<boolean> } = { latest: pick, done: Promise.resolve(false) };
    writes.current.set(key, chain);
    chain.done = (async () => {
      let saved = false;
      try {
        while (chain.latest) {
          const next = chain.latest;
          chain.latest = null;
          saved = await write(next, () => chain.latest === null);
        }
      } finally {
        if (writes.current.get(key) === chain) writes.current.delete(key);
      }
      return saved;
    })();
    return chain.done;
  };
  // Resolves when this conversation's picks are written: true unless the last one failed.
  const settled = useCallback(() => writes.current.get(key)?.done ?? Promise.resolve(true), [key]);
  return { data, catalog, loading: !!key && connected && (loading || (!data && !error)), error,
    confirmed: state.key === key && !!state.data && !error,
    pending: !!pendingModel, pendingModel, refresh, refreshIfStale, select, settled };
}
