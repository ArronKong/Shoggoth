import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { getChatReadState, mergeChatReadState } from "../api/client";
import type { ChatReadState } from "../types";
import { mergeSharedChatReadState, readChatUnread, writeChatUnread, type ChatUnreadState } from "./chatUnread";

/** A server-confirmed installation owns the cutoff; localStorage is a cache. */
export function useChatUnread() {
  const [state, setState] = useState(() => readChatUnread(localStorage));
  const stateRef = useRef(state);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const synchronizeRef = useRef<() => void>(() => {});
  const update = useCallback((action: SetStateAction<ChatUnreadState>) => {
    const next = typeof action === "function" ? action(stateRef.current) : action;
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => { writeChatUnread(localStorage, state); }, [state]);
  useEffect(() => {
    let stopped = false, working = false, requested = false;
    let shared: ChatReadState | undefined;
    const controller = new AbortController();
    const accept = (next: ChatReadState) => {
      if (!next || next.version !== 1 || typeof next.installationId !== "string" || !next.installationId
        || !Number.isSafeInteger(next.since) || next.since <= 0 || !Number.isSafeInteger(next.revision)
        || !next.read || typeof next.read !== "object" || Array.isArray(next.read)) throw Error("Invalid read state");
      shared = next;
      update(current => mergeSharedChatReadState(current, next));
      setReady(true);
    };
    const synchronize = async () => {
      if (stopped) return;
      if (working) { requested = true; return; }
      working = true;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
        const result = await getChatReadState(shared, signal);
        if (stopped) return;
        if (result.state) accept(result.state);
        if (!shared) return;
        // Reads merge by max on both sides. A slow response, another browser or
        // a lost acknowledgement cannot roll back any already-read session.
        while (!stopped && stateRef.current.installationId === shared.installationId) {
          const pending = Object.fromEntries(Object.entries(stateRef.current.read)
            .filter(([key, at]) => at > Math.max(shared!.since, shared!.read[key] || 0)).slice(0, 256));
          if (!Object.keys(pending).length) break;
          const saved = await mergeChatReadState(shared.installationId, pending, signal);
          if (stopped) return;
          accept(saved.state);
        }
      } catch {
        // Keep local acknowledgements for the next sync. Without a confirmed
        // installation, an unavailable server must never resurrect old dots.
      } finally {
        working = false;
        if (!stopped) setLoading(false);
        if (requested && !stopped) { requested = false; void synchronize(); }
      }
    };
    synchronizeRef.current = () => { void synchronize(); };
    const refreshVisible = () => { if (document.visibilityState !== "hidden") void synchronize(); };
    void synchronize();
    const timer = window.setInterval(refreshVisible, 5000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      stopped = true; controller.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      synchronizeRef.current = () => {};
    };
  }, [update]);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => synchronizeRef.current(), 100);
    return () => window.clearTimeout(timer);
  }, [state.read, ready]);
  return { state, update, ready, loading };
}
