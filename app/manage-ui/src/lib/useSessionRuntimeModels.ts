import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, getSessionRuntimeModels, selectSessionRuntimeModel } from "../api/client";
import { useToast } from "../components/ui";
import type { SessionRuntimeModels } from "../types";
import { sessionRuntimeSupportKey } from "./sessionRuntimeSupport";

/** A conversation owns its Runtime and model selection, independently of the Agent default. */
export function useSessionRuntimeModels(backend: string, agentId: string, sessionKey: string | null,
  enabled: boolean, connected: boolean, connectionEpoch = 0) {
  const toast = useToast();
  const { t } = useTranslation();
  const key = enabled && sessionKey ? `${backend}:${agentId}:${sessionKey}` : "";
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const mounted = useRef(false);
  const selecting = useRef(false);
  const flight = useRef<{ key: string; request: number; promise: Promise<void>; controller: AbortController } | null>(null);
  const [state, setState] = useState<{ key: string; data?: SessionRuntimeModels; error?: boolean }>({ key: "" });
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const data = state.key === key ? state.data : undefined;

  const cancelRead = useCallback(() => {
    generation.current++;
    const previous = flight.current;
    flight.current = null;
    previous?.controller.abort();
  }, []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const refresh = useCallback(async () => {
    if (!key || !sessionKey || !connected) { setLoading(false); return; }
    if (selecting.current) return;
    if (flight.current?.key === key) return flight.current.promise;
    const request = ++generation.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    setLoading(true);
    const promise = (async () => {
      try {
        const next = await getSessionRuntimeModels(backend, agentId, sessionKey, controller.signal);
        if (mounted.current && currentKey.current === key && generation.current === request) setState({ key, data: next });
      } catch {
        if (mounted.current && currentKey.current === key && generation.current === request) {
          setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, error: true }));
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
  // A reconnected Service must not join a read owned by its previous connection.
  // Cancel on disconnect/session changes and reject any late response by generation.
  useEffect(() => { void refresh(); return cancelRead; }, [refresh, cancelRead]);

  // `quiet`: an automatic choice fails silently; the menu still offers every model.
  const select = async (model: string, bindingId: string, permissionMode: string | null, { quiet = false } = {}) => {
    if (!sessionKey || !data || !connected || selecting.current || state.error) return false;
    const choice = data.models.find(item => item.id === model && item.bindingId === bindingId);
    if (!choice || (!data.selection.canSwitch && bindingId !== data.selection.bindingId)) return false;
    const candidate = data.selection.candidates.find(item => item.bindingId === bindingId);
    selecting.current = true; setPending(true); cancelRead();
    // Selecting a model also selects its Runtime. Apply that Runtime's compatible
    // permission mode as part of the same explicit action, without a second prompt.
    const acceptAdjustments = bindingId !== data.selection.bindingId
      || candidate?.adjustments.clearModelOverride === true
      || candidate?.adjustments.permissionMode !== permissionMode;
    try {
      const selection = await selectSessionRuntimeModel(backend, agentId, sessionKey,
        { model, bindingId, revision: data.selection.revision, acceptAdjustments });
      if (!mounted.current || currentKey.current !== key) return false;
      setState({ key, data: { ...data, selection,
        capabilities: data.runtimes.find(group => group.runtime === choice.runtime)?.capabilities || data.capabilities } });
      return true;
    } catch (error) {
      // Support codes arrive untranslated; everything else already has a public message.
      const supportKey = error instanceof ApiError ? sessionRuntimeSupportKey(error.code) : null;
      if (mounted.current && currentKey.current === key && !quiet) {
        toast.error(supportKey ? t(supportKey) : error instanceof Error ? error.message : String(error));
      }
      // CAS/busy/auth failures never leave a speculative model or Runtime in the UI.
      selecting.current = false; flight.current = null;
      await refresh();
      return false;
    } finally {
      selecting.current = false;
      if (mounted.current) { setPending(false); setLoading(false); }
    }
  };
  return { data, loading: !!key && connected && (loading || (!data && !state.error)), error: state.key === key && state.error === true, pending, refresh, select };
}
