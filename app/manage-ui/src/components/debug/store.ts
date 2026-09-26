// Debug-inspector enable flag. Lives in localStorage (NOT config-store) so the
// toggle takes effect instantly without a window reload — config-store changes
// reconnect backends + reload, which is wrong for a pure-frontend dev tool.
// SettingsPage flips it; App subscribes and mounts/unmounts <DebugInspector>.

import { useSyncExternalStore } from "react";

const KEY = "shoggoth.debug.inspector.v1";
const listeners = new Set<() => void>();

export function isDebugEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setDebugEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* localStorage unavailable — ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDebugEnabled(): boolean {
  return useSyncExternalStore(subscribe, isDebugEnabled, () => false);
}

// Persist the current override set into manage-ui/src/debug-overrides.css via the
// dev-only host route. Throws on failure (e.g. packaged build with no source dir).
export interface SaveResult {
  ok?: boolean;
  path?: string;
  selectors?: number;
}

// Probe whether the host can persist to source. False in the packaged app (no
// editable src dir) → the UI hides "save to source" and only offers "copy for AI".
export async function canSaveOverridesToSource(): Promise<boolean> {
  try {
    const res = await fetch("/__api/debug/overrides", { method: "GET" });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { canSave?: boolean };
    return data.canSave === true;
  } catch {
    return false;
  }
}

export async function saveOverridesToSource(
  overrides: Record<string, Record<string, string>>,
): Promise<SaveResult> {
  const res = await fetch("/__api/debug/overrides", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as SaveResult;
}
