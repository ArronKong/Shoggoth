import { sessionKindOf } from "./sessionKind";
import type { ChatReadState } from "../types";

const STORAGE_KEY = "shoggoth.chat.sessionUnread.v3";
type Times = Record<string, number>;
export interface ChatUnreadState {
  /** Shared first-launch cutoff. The browser copy is only a cache. */
  since: number;
  installationId?: string;
  read: Times;
  replies: Times;
}
const times = (value: unknown): Times => Object.fromEntries(
  Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {})
    .filter(([, at]) => typeof at === "number" && Number.isFinite(at) && at >= 0),
);
export function readChatUnread(storage: Pick<Storage, "getItem" | "setItem">, now = Date.now()): ChatUnreadState {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
    if (value && Number.isFinite(value.since) && value.since > 0) {
      return { since: value.since, installationId: typeof value.installationId === "string" ? value.installationId : undefined,
        read: times(value.read), replies: times(value.replies) };
    }
  } catch { /* An unavailable or corrupt cache does not block chat. */ }
  // Old browser-only read records cannot establish the shared install baseline.
  // Until the server confirms its identity, callers suppress badges entirely.
  const state = { since: now, read: {}, replies: {} };
  writeChatUnread(storage, state);
  return state;
}
export function writeChatUnread(storage: Pick<Storage, "setItem">, state: ChatUnreadState): void {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* best effort */ }
}
/** Late server snapshots cannot undo local or other-window read acknowledgements. */
export function mergeSharedChatReadState(state: ChatUnreadState, shared: ChatReadState): ChatUnreadState {
  const same = state.installationId === shared.installationId;
  const read = { ...shared.read };
  if (same) for (const [key, at] of Object.entries(state.read)) read[key] = Math.max(read[key] || 0, at);
  // The first fetch can race a canonical history read in this mount. Preserve
  // those replies, but never carry replies from a different installation.
  const replies = same || !state.installationId ? state.replies : {};
  if (same && state.since === shared.since && Object.keys(read).length === Object.keys(state.read).length
    && Object.entries(read).every(([key, at]) => state.read[key] === at)) return state;
  return { installationId: shared.installationId, since: shared.since, read, replies };
}
export function sessionReadAt(state: ChatUnreadState, key: string, _kind?: string): number {
  return Math.max(state.since, state.read[key] ?? 0);
}
export function hasUnreadReply(state: ChatUnreadState, key: string, kind?: string): boolean {
  return (state.replies[key] ?? 0) > sessionReadAt(state, key, kind);
}
export function observeSessionReply(state: ChatUnreadState, key: string, at: number): ChatUnreadState {
  if (!key || !Number.isFinite(at) || at <= (state.replies[key] ?? 0)) return state;
  return { ...state, replies: { ...state.replies, [key]: at } };
}
export function readSessionThrough(state: ChatUnreadState, key: string, at: number, kind?: string): ChatUnreadState {
  if (!key || !Number.isFinite(at) || at <= sessionReadAt(state, key, kind)) return state;
  return { ...state, read: { ...state.read, [key]: at } };
}
/** Cron replies are user-facing; internal runs still cannot create ordinary-chat badges. */
export function supportsSessionUnread(key: string, declaredKind?: string): boolean {
  return !["subagent", "dream", "system"].includes(sessionKindOf(key, declaredKind));
}

/** Align the beginning of a reply, including after content-visibility resolves.
 * Cancel on real user input; delayed Markdown layout must not fight the reader. */
export function anchorUnreadMessage(thread: HTMLElement, target: HTMLElement): () => void {
  let frame = 0, attempts = 0, stable = 0, stopped = false;
  const cancel = () => {
    stopped = true; cancelAnimationFrame(frame);
    for (const event of ["wheel", "pointerdown", "touchstart", "keydown"]) thread.removeEventListener(event, cancel);
  };
  const align = () => {
    if (stopped || !thread.isConnected || !target.isConnected) return cancel();
    const bounds = thread.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(thread).paddingTop) || 0;
    const header = thread.parentElement?.querySelector(".chat-topdock")?.getBoundingClientRect();
    const top = Math.max(bounds.top + inset, header ? header.bottom + 12 : bounds.top);
    const delta = target.getBoundingClientRect().top - top;
    const before = thread.scrollTop;
    thread.scrollTop += delta;
    stable = Math.abs(delta) < 1 || Math.abs(thread.scrollTop - before) < 1 ? stable + 1 : 0;
    if (++attempts < 8 && stable < 2) frame = requestAnimationFrame(align);
    else cancel();
  };
  for (const event of ["wheel", "pointerdown", "touchstart", "keydown"]) thread.addEventListener(event, cancel, { passive: true });
  align();
  return cancel;
}
