"use strict";

// Same-origin Hermes kanban event-stream broker.
//
// The browser tasks page connects to /__kanbanws and receives the Hermes
// dashboard's kanban events (task created/moved/edited/…) so the board can stay
// live without polling. For each browser connection the broker opens an upstream
// WS to the Hermes dashboard's `/api/plugins/kanban/events` (authenticated with
// the per-dashboard session token, server-side) and relays frames downstream.
// One-way: the browser only subscribes; it never sends frames upstream.
//
// Unlike the chat broker this needs NO device-auth handshake — the Hermes
// dashboard authenticates via a `?token=` query param. Hermes-only by design
// (the kanban is a Hermes dashboard plugin); OpenClaw contributes nothing here.

const { WebSocketServer, WebSocket } = require("ws");
const { isAllowedBrowserOrigin } = require("./chat-broker");

const KANBAN_WS_PATH = "/__kanbanws";

/**
 * Attach the kanban event broker to an http server.
 * @param {import('node:http').Server} httpServer
 * @param {{ registry: { getBackend: (id: string) => object|null } }} opts
 */
function attachKanbanBroker(httpServer, { registry } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://127.0.0.1").pathname;
    } catch {
      pathname = req.url;
    }
    if (pathname !== KANBAN_WS_PATH) return; // not ours — leave for any other handler
    // DNS-rebinding guard: loopback-only origin (mirrors chat-broker / static-server).
    const host = String(req.headers.host || "").trim().replace(/:\d+$/, "").toLowerCase();
    if (!(host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1")) {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    // This endpoint is browser-only and injects the private Hermes token into
    // its upstream URL. Require our exact page Origin before reading that token.
    const selfPort = httpServer.address()?.port;
    if (typeof req.headers.origin !== "string"
      || !isAllowedBrowserOrigin(req.headers.origin, selfPort)) {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => bridge(client, req));
  });

  function bridge(client, req) {
    const hermes = registry?.getBackend?.("hermes"); // 走 registry 的「已禁用后端」门，禁用即视作不存在
    const target = hermes && typeof hermes.getKanbanEventsTarget === "function"
      ? hermes.getKanbanEventsTarget()
      : null;
    if (!target || !target.wsUrl) {
      try { client.close(1011, "kanban events unavailable"); } catch { /* ignore */ }
      return;
    }

    let board = "";
    try { board = new URL(req.url, "http://127.0.0.1").searchParams.get("board") || ""; } catch { /* ignore */ }

    const q = new URLSearchParams({ since: "0" });
    if (target.token) q.set("token", target.token);
    if (board) q.set("board", board);

    let upstream;
    try {
      upstream = new WebSocket(`${target.wsUrl}?${q.toString()}`);
    } catch {
      try { client.close(1011, "upstream connect failed"); } catch { /* ignore */ }
      return;
    }

    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(data.toString()); } catch { /* ignore */ }
      }
    });
    upstream.on("close", () => { try { client.close(); } catch { /* ignore */ } });
    upstream.on("error", () => { try { client.close(1011, "upstream error"); } catch { /* ignore */ } });

    const releaseUpstream = () => {
      // Downstream 已消失时没人再等待优雅握手；直接终止，避免 static server
      // 关闭后遗留一个仍持有事件循环的 Hermes upstream socket。
      try { upstream.terminate(); } catch { /* already closed */ }
    };
    client.on("close", releaseUpstream);
    client.on("error", releaseUpstream);
  }

  return wss;
}

module.exports = { attachKanbanBroker, KANBAN_WS_PATH };
