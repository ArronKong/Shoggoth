export const SYSTEM_ISSUE_KEYS = {
  STORAGE_FULL: "common.diskFull",
  UI_RESOURCE_UNAVAILABLE: "common.uiResourceUnavailable",
} as const;

export type SystemIssueCode = keyof typeof SYSTEM_ISSUE_KEYS;
type Listener = (code: SystemIssueCode) => void;
const listeners = new Set<Listener>();
const pending = new Set<SystemIssueCode>();
let lastStorageIssueAt = -Infinity;

export function parseSystemIssue(value: unknown): SystemIssueCode | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as { code?: unknown }).code;
  return code === "STORAGE_FULL" || code === "UI_RESOURCE_UNAVAILABLE" ? code : null;
}

// Bootstrap/API failures can precede React mounting. Keep at most one pending
// notice per known code; this queue neither retries nor repeats the operation.
export function publishSystemIssue(code: SystemIssueCode): void {
  if (code === "STORAGE_FULL") {
    lastStorageIssueAt = Date.now();
    pending.delete("UI_RESOURCE_UNAVAILABLE");
  }
  else if (Date.now() - lastStorageIssueAt < 30_000) return;
  if (!listeners.size) { pending.add(code); return; }
  for (const listener of listeners) {
    try { listener(code); } catch { /* reporting must not replace the original failure */ }
  }
}

export function subscribeSystemIssues(listener: Listener): () => void {
  listeners.add(listener);
  for (const code of pending) {
    try { listener(code); } catch { /* reporting must not replace the original failure */ }
  }
  pending.clear();
  return () => { listeners.delete(listener); };
}
