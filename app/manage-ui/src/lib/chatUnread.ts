import { sessionKindOf } from "./sessionKind";

const STORAGE_KEY = "shoggoth.chat.sessionUnread.v2";
type Times = Record<string, number>;
export interface ChatUnreadState {
  /** First launch of this unread policy; older history never produces badges. */
  since: number;
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
      return { since: value.since, read: times(value.read), replies: times(value.replies) };
    }
  } catch { /* An unavailable or corrupt cache does not block chat. */ }
  // Retire the v1/Agent caches once: their historical dots predate this policy.
  const state = { since: now, read: {}, replies: {} };
  // Persist during app bootstrap, before a later first visit to ChatPage.
  writeChatUnread(storage, state);
  return state;
}
export function writeChatUnread(storage: Pick<Storage, "setItem">, state: ChatUnreadState): void {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* best effort */ }
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
