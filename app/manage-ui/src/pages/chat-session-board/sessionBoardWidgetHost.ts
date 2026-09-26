import type { SessionBoardWidget } from "../../types";

type DesktopEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

export interface SessionBoardWidgetLease {
  frameUrl: string;
  ticketId: string;
  nonce: string;
  widgetIdentity: { name: string; revision: number; instanceId: string };
}

export interface SessionBoardWidgetTheme {
  mode: "light" | "dark";
  tokens: Record<string, string>;
}

type DesktopBoardWidgetBridge = {
  mintSessionBoardHtmlWidget?: (
    backend: string,
    agentId: string,
    sessionKey: string,
    spec: { name: string; revision: number; instanceId: string },
  ) => Promise<DesktopEnvelope<SessionBoardWidgetLease>>;
  readySessionBoardHtmlWidget?: (
    ticketId: string,
    nonce: string,
  ) => Promise<DesktopEnvelope<{ ready: true }>>;
  revokeSessionBoardHtmlWidget?: (
    ticketId: string,
  ) => Promise<DesktopEnvelope<{ revoked: true }>>;
};

function bridge(): DesktopBoardWidgetBridge | null {
  return (window as unknown as { openclawDesktop?: DesktopBoardWidgetBridge }).openclawDesktop ?? null;
}

function safeLease(value: unknown, expected: { name: string; revision: number; instanceId: string }): SessionBoardWidgetLease | null {
  if (!value || typeof value !== "object") return null;
  const lease = value as Partial<SessionBoardWidgetLease>;
  if (typeof lease.ticketId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(lease.ticketId)
    || typeof lease.nonce !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(lease.nonce)
    || typeof lease.frameUrl !== "string" || !lease.widgetIdentity
    || lease.widgetIdentity.name !== expected.name
    || lease.widgetIdentity.revision !== expected.revision
    || lease.widgetIdentity.instanceId !== expected.instanceId) return null;
  try {
    const url = new URL(lease.frameUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
      || url.search || url.hash || url.pathname !== `/v1/board-widget/${lease.ticketId}`) return null;
  } catch {
    return null;
  }
  return lease as SessionBoardWidgetLease;
}

export function hostableSessionBoardWidget(
  widget: SessionBoardWidget,
): widget is SessionBoardWidget & { instanceId: string } {
  return widget.content.kind === "html"
    && (widget.grantState === "none" || widget.grantState === "granted")
    && typeof widget.instanceId === "string"
    && widget.instanceId.length > 0;
}

export async function mintSessionBoardWidget(
  backend: string,
  agentId: string,
  sessionKey: string,
  widget: SessionBoardWidget & { instanceId: string },
): Promise<SessionBoardWidgetLease> {
  const mint = bridge()?.mintSessionBoardHtmlWidget;
  if (!mint) throw new Error("BOARD_WIDGET_DESKTOP_REQUIRED");
  const expected = { name: widget.name, revision: widget.revision, instanceId: widget.instanceId };
  const response = await mint(backend, agentId, sessionKey, expected);
  if (!response?.ok) throw new Error(response?.error?.code || "BOARD_WIDGET_MINT_FAILED");
  const lease = safeLease(response.value, expected);
  if (!lease) throw new Error("BOARD_WIDGET_INVALID_LEASE");
  return lease;
}

export async function markSessionBoardWidgetReady(lease: SessionBoardWidgetLease): Promise<void> {
  const ready = bridge()?.readySessionBoardHtmlWidget;
  if (!ready) throw new Error("BOARD_WIDGET_DESKTOP_REQUIRED");
  const response = await ready(lease.ticketId, lease.nonce);
  if (!response?.ok || response.value?.ready !== true) {
    throw new Error(response?.ok ? "BOARD_WIDGET_READY_FAILED" : response?.error?.code);
  }
}

export async function revokeSessionBoardWidget(ticketId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticketId)) return;
  try { await bridge()?.revokeSessionBoardHtmlWidget?.(ticketId); } catch { /* idempotent cleanup */ }
}

export function clampSessionBoardWidgetHeight(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1200, Math.max(160, Math.round(value)))
    : 320;
}

export function mountSessionBoardWidgetLease({
  frame,
  lease,
  getTheme,
  onReady,
  onHeight,
  onFailure,
}: {
  frame: HTMLIFrameElement;
  lease: SessionBoardWidgetLease;
  getTheme: () => SessionBoardWidgetTheme;
  onReady: () => void;
  onHeight: (height: number) => void;
  onFailure: () => void;
}): () => void {
  let connected = false;
  let closed = false;
  let readyReceived = false;
  let readyAcknowledged = false;
  let controlPort: MessagePort | null = null;
  let pendingHeight: number | null = null;
  let heightTimer: number | null = null;

  const fail = () => {
    if (closed) return;
    closed = true;
    controlPort?.close();
    controlPort = null;
    void revokeSessionBoardWidget(lease.ticketId);
    onFailure();
  };
  const sendTheme = () => {
    if (closed) return;
    try { controlPort?.postMessage({ type: "theme", ...getTheme() }); } catch { fail(); }
  };
  const onWindowMessage = (event: MessageEvent) => {
    if (closed) {
      event.ports.forEach((port) => port.close());
      return;
    }
    const frameWindow = frame.contentWindow;
    if (!frameWindow || event.source !== frameWindow || event.origin !== "null") return;
    event.ports.forEach((port) => port.close());
    const message = event.data as Record<string, unknown> | null;
    if (event.ports.length !== 0 || !message || Object.keys(message).length !== 2
      || message.type !== "shoggoth:board-widget-bootstrap" || message.nonce !== lease.nonce
      || connected) return;
    connected = true;
    const channel = new MessageChannel();
    controlPort = channel.port1;
    channel.port1.addEventListener("message", (portEvent) => {
      portEvent.ports.forEach((port) => port.close());
      if (closed) return;
      const payload = portEvent.data as Record<string, unknown> | null;
      if (!payload || typeof payload.type !== "string") return;
      if (payload.type === "ready") {
        if (readyReceived || Object.keys(payload).length !== 2 || payload.nonce !== lease.nonce) return;
        readyReceived = true;
        void markSessionBoardWidgetReady(lease).then(() => {
          if (closed) return;
          readyAcknowledged = true;
          onReady();
        }).catch(fail);
        return;
      }
      if (payload.type === "height" && readyReceived && Object.keys(payload).length === 2) {
        pendingHeight = clampSessionBoardWidgetHeight(payload.height);
        if (heightTimer === null) {
          heightTimer = window.setTimeout(() => {
            heightTimer = null;
            if (!closed && pendingHeight !== null) onHeight(pendingHeight);
            pendingHeight = null;
          }, 80);
        }
      }
    });
    channel.port1.start();
    try {
      frameWindow.postMessage({
        type: "shoggoth:board-widget-connect",
        nonce: lease.nonce,
        theme: getTheme(),
      }, "*", [channel.port2]);
      sendTheme();
    } catch {
      fail();
    }
  };

  window.addEventListener("message", onWindowMessage);
  frame.addEventListener("error", fail);
  const observer = new MutationObserver(sendTheme);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const timeout = window.setTimeout(() => {
    if (!readyAcknowledged) fail();
  }, 9_000);
  try {
    // The loopback shell posts bootstrap only once. Start navigation only after
    // its listener exists; setting src in React's commit leaves a real race.
    frame.setAttribute("src", lease.frameUrl);
  } catch {
    fail();
  }

  return () => {
    if (!closed) void revokeSessionBoardWidget(lease.ticketId);
    closed = true;
    window.clearTimeout(timeout);
    if (heightTimer !== null) window.clearTimeout(heightTimer);
    observer.disconnect();
    window.removeEventListener("message", onWindowMessage);
    frame.removeEventListener("error", fail);
    controlPort?.close();
    controlPort = null;
  };
}
