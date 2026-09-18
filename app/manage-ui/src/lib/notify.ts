// Desktop-notification helpers shared by the app-level <Notifier/>.
//
// Pure classifiers + a single fireNotification() that routes to either:
//  - the Electron main process (native macOS Notification, authoritative gating
//    on config + window focus), via window.openclawDesktop.notify; or
//  - the Web Notification API fallback in the dev harness (manage-serve, no
//    Electron), which gates on document focus here instead.
//
// Kept framework-free (no React) so the logic is testable in isolation.

export type NotifyCategory = "chat" | "cron" | "task";

export interface NotifyPayload {
  category: NotifyCategory;
  title: string;
  body: string;
  // chat 传 sessionKey，cron 传统一任务 ID；task 暂无单任务详情，因此传 null。
  target?: string | null;
  force?: boolean; // 设置 test button: bypass focus + toggle gating
}

export interface OpenTargetPayload {
  category: NotifyCategory;
  target: string | null;
}

interface OpenclawDesktop {
  notify?: (p: NotifyPayload) => Promise<boolean> | boolean;
  onOpenTarget?: (cb: (p: OpenTargetPayload) => void) => () => void;
}
function desktop(): OpenclawDesktop | undefined {
  return (window as unknown as { openclawDesktop?: OpenclawDesktop }).openclawDesktop;
}
export function isElectron(): boolean {
  return !!desktop()?.notify;
}

export function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
export function agentOf(key: string): string {
  const segs = String(key || "").split(":");
  return segs[1] || segs[0] || key;
}

// Tail kind after `agent:<id>:` — decides which sessions count as "chat" (i.e.
// something I drove from the UI) vs channel/cron/internal (handled elsewhere or
// not "me"). Mirrors the conventions used in ChatPage.
export function sessionTailKind(key: string): "chat" | "cron" | "channel" | "internal" {
  const tail = String(key || "").split(":").slice(2).join(":");
  if (/^cron/i.test(tail)) return "cron";
  if (/^(sub-?agent|dream)/i.test(tail)) return "internal";
  if (/^telegram/i.test(tail)) return "channel";
  return "chat"; // main, dashboard:*, or any other UI-driven session
}

const HEARTBEAT = /^(HEARTBEAT_OK|NO_REPLY)\b/;

// Join an assistant message's visible text blocks (skip thinking/toolCall);
// "" when nothing renderable.
export function extractAssistantText(message: unknown): string {
  const m = message as { role?: string; content?: unknown } | null;
  if (!m || m.role !== "assistant") return "";
  let text = "";
  if (Array.isArray(m.content)) {
    for (const c of m.content as Array<{ type?: string; text?: string }>) {
      if (c && c.type !== "thinking" && c.type !== "toolCall" && typeof c.text === "string") text += c.text;
    }
  } else if (typeof m.content === "string") {
    text = m.content;
  }
  return text.trim();
}

export function snippet(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// Build a chat notification from a final assistant message, or null when it is
// NOT notify-worthy: not a UI-driven session, an error/empty turn, or a
// heartbeat ack. (Channel/cron/internal sessions are intentionally skipped —
// cron has its own polled category; telegram has its own app.)
export function chatNotificationFor(message: unknown, sessionKey: string): NotifyPayload | null {
  if (message && typeof message === "object" && "shoggoth" in message
    && (message.shoggoth as { source?: string } | null)?.source === "cron") return null;
  if (sessionTailKind(sessionKey) !== "chat") return null;
  const m = message as { stopReason?: string; isError?: boolean } | null;
  if (m?.stopReason === "error" || m?.isError) return null;
  const text = extractAssistantText(message);
  if (!text || HEARTBEAT.test(text)) return null;
  return { category: "chat", title: cap(agentOf(sessionKey)) || "OpenClaw", body: snippet(text), target: sessionKey };
}

// Fire a notification through the best available channel. In Electron the main
// process re-gates authoritatively (config toggle + window focus); the optional
// onClick is only used by the Web fallback (Electron routes clicks via IPC).
export async function fireNotification(p: NotifyPayload, opts?: { onClick?: () => void }): Promise<boolean> {
  const d = desktop();
  if (d?.notify) {
    try {
      return Boolean(await d.notify(p));
    } catch {
      return false;
    }
  }
  // Dev / web fallback.
  if (typeof Notification === "undefined") return false;
  if (!p.force && typeof document !== "undefined" && document.hasFocus()) return false;
  // 创建成功才向调用方报告 true，设置页据此给出可见反馈。
  const show = (): boolean => {
    try {
      const n = new Notification(p.title, { body: p.body });
      if (opts?.onClick) {
        n.onclick = () => {
          try { window.focus(); } catch { /* ignore */ }
          opts.onClick?.();
        };
      }
      return true;
    } catch {
      return false;
    }
  };
  if (Notification.permission === "granted") return show();
  if (Notification.permission === "denied") return false;
  try {
    const permission = await Notification.requestPermission();
    return permission === "granted" ? show() : false;
  } catch {
    return false;
  }
}

// Subscribe to notification click-throughs from the Electron main process.
// No-op (returns an empty unsubscribe) outside Electron.
export function onOpenTarget(cb: (p: OpenTargetPayload) => void): () => void {
  const d = desktop();
  if (d?.onOpenTarget) return d.onOpenTarget(cb);
  return () => {};
}
