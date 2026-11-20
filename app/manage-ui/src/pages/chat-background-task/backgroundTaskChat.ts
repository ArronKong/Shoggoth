import type { HistoryTransportPage } from "../../lib/chatHistoryPager";
import { createNativeChatFrameAssembler } from "../../lib/nativeChatUiFrames";
import type { BackgroundTaskMessage } from "../../types";

export interface BackgroundChatEvent {
  event: "chat" | "session.tool";
  payload: Record<string, unknown>;
}

export interface BackgroundChatHistoryPage extends HistoryTransportPage<unknown> {
  brief?: BackgroundTaskMessage | null;
}

export interface BackgroundChatConnection {
  history(cursor: string | null): Promise<BackgroundChatHistoryPage>;
  close(): void;
}

export type ConnectBackgroundChat = (scope: { sessionKey: string; taskId: string }, handlers: {
  ready(): void;
  event(frame: BackgroundChatEvent): void;
  disconnected(): void;
}) => BackgroundChatConnection;

export const connectBackgroundChat: ConnectBackgroundChat = ({ sessionKey, taskId }, handlers) => {
  const viewKey = `background-task:${sessionKey}:${taskId}`;
  const pending = new Map<string, {
    resolve: (page: BackgroundChatHistoryPage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let socket: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  const disconnected = () => new Error("Background chat disconnected");
  const failPending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(disconnected());
    }
    pending.clear();
  };
  const open = () => {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${location.host}/__chatws`);
    socket = ws;
    const frames = createNativeChatFrameAssembler();
    let incoming = Promise.resolve();
    ws.onopen = () => { if (!closed && socket === ws) handlers.ready(); };
    ws.onmessage = message => {
      incoming = incoming.then(async () => {
        const frame = await frames.accept(JSON.parse(message.data));
        if (!frame || closed || socket !== ws) return;
        if (frame.type === "res") {
          const request = pending.get(frame.id);
          if (!request) return;
          pending.delete(frame.id);
          clearTimeout(request.timer);
          if (frame.ok) request.resolve(frame.payload);
          else request.reject(Object.assign(new Error(frame.error?.message), { code: frame.error?.code }));
        } else if (frame.type === "event" && frame.payload?.sessionKey === viewKey
          && (frame.event === "chat" || frame.event === "session.tool")) handlers.event(frame);
      }).catch(() => { if (!closed && socket === ws) ws.close(); });
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      failPending();
      if (!closed) { handlers.disconnected(); retry = setTimeout(open, 3_000); }
    };
  };
  open();
  return {
    history(cursor) {
      const ws = socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(disconnected());
      return new Promise((resolve, reject) => {
        const id = `background-history-${++sequence}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Background chat history timed out"));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ type: "req", id, method: "chat.history",
            params: { sessionKey, backgroundTaskId: taskId, page: true, cursor, limit: 50 } }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      closed = true;
      clearTimeout(retry);
      failPending();
      socket?.close();
      socket = null;
    },
  };
};
