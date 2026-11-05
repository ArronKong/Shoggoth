import { useEffect, useState } from "react";
import { getConfig } from "../api/client";
import type { ChatPermissionModeOption, GlobalPermissionMode } from "../types";
import { sessionCategoryOf, type SessionCategoryRow } from "./sessionKind";

// One permission choice in Settings applies to every Agent chat. Each runtime
// keeps its own native options; this module maps the global choice onto them.
export const GLOBAL_PERMISSION_MODES: readonly GlobalPermissionMode[] = Object.freeze([
  "request-approval",
  "auto-review",
  "full-access",
]);
export const DEFAULT_GLOBAL_PERMISSION_MODE: GlobalPermissionMode = "auto-review";

export const GLOBAL_PERMISSION_MODE_TEXT: Readonly<Record<GlobalPermissionMode, {
  label: string; description: string; risk: NonNullable<ChatPermissionModeOption["risk"]>;
}>> = Object.freeze({
  "request-approval": { label: "requestApproval", description: "requestApprovalDescription", risk: "standard" },
  "auto-review": { label: "approveForMe", description: "approveForMeDescription", risk: "elevated" },
  "full-access": { label: "fullAccess", description: "broadAccessDescription", risk: "danger" },
});

export function normalizeGlobalPermissionMode(value: unknown): GlobalPermissionMode {
  return GLOBAL_PERMISSION_MODES.includes(value as GlobalPermissionMode)
    ? value as GlobalPermissionMode : DEFAULT_GLOBAL_PERMISSION_MODE;
}

// Shoggoth runtimes expose the three global IDs directly. Other backends
// (OpenClaw, Hermes) publish their own options with a risk level, so match by
// risk and fall back to the next stricter level when a level is missing.
const RISK_PREFERENCE: Readonly<Record<GlobalPermissionMode, ReadonlyArray<ChatPermissionModeOption["risk"]>>> = {
  "request-approval": ["standard", "safe"],
  "auto-review": ["elevated", "standard"],
  "full-access": ["danger"],
};

export function sessionPermissionModeFor(
  mode: GlobalPermissionMode,
  options: readonly ChatPermissionModeOption[] | undefined,
): string | null {
  if (!options?.length) return null;
  const direct = options.find((option) => option.id === mode);
  if (direct) return direct.id;
  for (const risk of RISK_PREFERENCE[mode]) {
    const match = options.find((option) => option.risk === risk);
    if (match) return match.id;
  }
  return null;
}

// Group chats, scheduled tasks and inspiration notes run with full access under
// their own rules. Group sessions never reach the chat list; the other two can,
// so leave their sessions alone when someone sends a follow-up there.
export function followsGlobalPermission(row: SessionCategoryRow): boolean {
  const category = sessionCategoryOf(row);
  return category !== "task" && category !== "inspiration";
}

let cached: GlobalPermissionMode | null = null;
let request: Promise<GlobalPermissionMode> | null = null;
const listeners = new Set<(mode: GlobalPermissionMode) => void>();

export function applyGlobalPermissionMode(value: unknown): GlobalPermissionMode {
  const next = normalizeGlobalPermissionMode(value);
  const changed = next !== cached;
  cached = next;
  if (changed) for (const listener of listeners) listener(next);
  return next;
}

function fetchGlobalPermissionMode(): Promise<GlobalPermissionMode> {
  request ??= getConfig()
    .then((config) => applyGlobalPermissionMode(config.chatPermissionMode))
    .catch(() => cached ?? DEFAULT_GLOBAL_PERMISSION_MODE)
    .finally(() => { request = null; });
  return request;
}

// Read the saved value before a send. A failed read keeps the last known value.
export function loadGlobalPermissionMode(): Promise<GlobalPermissionMode> {
  return cached ? Promise.resolve(cached) : fetchGlobalPermissionMode();
}

if (typeof window !== "undefined") {
  // Settings announces every save; another window may also have changed it.
  window.addEventListener("openclaw:config-changed", () => { void fetchGlobalPermissionMode(); });
  window.addEventListener("focus", () => { if (cached) void fetchGlobalPermissionMode(); });
}

export function useGlobalPermissionMode(): GlobalPermissionMode {
  const [mode, setMode] = useState<GlobalPermissionMode>(cached ?? DEFAULT_GLOBAL_PERMISSION_MODE);
  useEffect(() => {
    listeners.add(setMode);
    void loadGlobalPermissionMode().then(setMode);
    return () => { listeners.delete(setMode); };
  }, []);
  return mode;
}
