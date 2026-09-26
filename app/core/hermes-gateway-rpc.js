"use strict";

// One-shot JSON-RPC over the Hermes dashboard's `/api/ws`.
//
// The dashboard serves TWO API surfaces on the same port + same session token:
// the REST endpoints we use everywhere else (`/api/*`), and this newline-JSON
// JSON-RPC 2.0 socket, which is what the official Hermes desktop app actually
// drives (tui_gateway/server.py, ~100 methods incl. `config.set`). A few things
// exist ONLY here — notably session-scoped model switching: REST's
// `/api/model/set` takes scope main|auxiliary and cannot target a session.
//
// Two access styles live here:
//   gatewayRpc()          — connection-per-call, for low-frequency control ops
//                           (a model switch): open, request, resolve, close.
//   HermesGatewaySocket   — persistent connection for the CHAT plane (S2): the
//                           gateway binds a session's event stream to the last
//                           socket that acted on it, so chat turns need the
//                           submitting socket to stay open.
//
// Requires Hermes >= 0.19.0 on named profiles: 0.18.2 answers `/api/ws` with
// HTTP 500 under `--isolated` (unified/default-profile servers are unaffected),
// so a dashboard process left running across a Hermes upgrade still fails here.
// Callers surface that as a "restart the dashboard" condition rather than a
// generic transport error.

const { WebSocket } = require("ws");

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Issue one JSON-RPC call against a dashboard's `/api/ws`.
 * @param {{baseUrl: string, token: string}} dash
 * @param {string} method
 * @param {object} [params]
 * @returns {Promise<object>} the RPC `result`
 */
function gatewayRpc(dash, method, params = {}) {
  const baseUrl = String(dash?.baseUrl || "").trim();
  const token = String(dash?.token || "").trim();
  if (!baseUrl) throw new Error("hermes gateway rpc: 缺少 dashboard baseUrl");
  if (!token) throw new Error("hermes gateway rpc: 缺少 dashboard token");

  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(token)}`;

  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      fn(value);
    };

    const connectTimer = setTimeout(
      () => finish(reject, new Error(`hermes gateway rpc: 连接超时 (${method})`)),
      CONNECT_TIMEOUT_MS,
    );
    let requestTimer = null;

    ws.on("open", () => {
      clearTimeout(connectTimer);
      requestTimer = setTimeout(
        () => finish(reject, new Error(`hermes gateway rpc: ${method} 超时`)),
        REQUEST_TIMEOUT_MS,
      );
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });

    ws.on("message", (data) => {
      // The socket pushes `event` notifications (gateway.ready, agent stream
      // frames) alongside replies — match on our id and ignore everything else.
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg?.id !== 1) return;
      if (msg.error) {
        const err = new Error(msg.error.message || `hermes gateway rpc: ${method} 失败`);
        err.code = msg.error.code;
        finish(reject, err);
        return;
      }
      finish(resolve, msg.result ?? {});
    });

    ws.on("error", (err) => {
      // 0.18.2 + --isolated rejects the upgrade with HTTP 500; say so plainly
      // instead of leaking "Unexpected server response: 500".
      const msg = String(err?.message || err);
      if (/unexpected server response: 500/i.test(msg)) {
        finish(
          reject,
          new Error(
            "hermes gateway rpc: dashboard 不支持 /api/ws（Hermes 0.18.x 的 --isolated 已知缺陷）。" +
              "请重启该 profile 的 dashboard 进程以加载已安装的新版本。",
          ),
        );
        return;
      }
      finish(reject, err instanceof Error ? err : new Error(msg));
    });

    ws.on("close", () => finish(reject, new Error(`hermes gateway rpc: 连接已关闭 (${method})`)));
  });
}

/**
 * Build the `config.set` model value string. Hermes parses this with the same
 * flag parser `/model` uses (hermes_cli.model_switch.parse_model_flags_detailed):
 *
 *   `--provider <p>` — pins the provider AND lets Hermes skip building the agent
 *     first (server.py only calls _start_agent_build when no explicit provider
 *     is given). That is what makes this work on an agent whose configured
 *     provider is broken — the exact case where the old chat-stream `/model`
 *     could never land.
 *   `--session` — this session only, no config write (resolve_persist_behavior).
 *   `--global`  — persist to the profile's config.yaml.
 *
 * @param {string} model
 * @param {string} [provider]
 * @param {"session"|"persist"} [scope="session"]
 */
function modelSwitchValue(model, provider, scope = "session") {
  const parts = [String(model || "").trim()];
  if (!parts[0]) throw new Error("hermes gateway rpc: 缺少 model");
  const p = String(provider || "").trim();
  if (p) parts.push("--provider", p);
  parts.push(scope === "persist" ? "--global" : "--session");
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Persistent gateway socket (S2 chat transport).
//
// One long-lived `/api/ws` connection per dashboard, carrying the chat plane:
// session.create / session.resume / prompt.submit / session.interrupt plus the
// server's `event` notifications (message.delta, tool.*, session.info, …).
// The one-shot gatewayRpc above stays for low-frequency control calls
// (config.set) — this class exists because a chat turn NEEDS the socket that
// submitted the prompt to stay open: the gateway binds a session's event
// transport to the last socket that acted on it.
//
// Reconnect: exponential backoff 1s → 15s cap, forever until close(). Each
// successful (re)connect bumps `generation` and fires onReconnect —
// hermes-backend re-issues session.resume for live sessions so their event
// transports rebind to the new socket. In-flight requests reject on drop.

const RECONNECT_BACKOFF_START_MS = 1_000;
const RECONNECT_BACKOFF_CAP_MS = 15_000;

class HermesGatewaySocket {
  /**
   * @param {{baseUrl: string, token: string}} dash
   * @param {{onEvent?: (params: {type: string, session_id?: string, payload?: object}) => void,
   *          onReconnect?: (generation: number) => void,
   *          label?: string}} [opts]
   */
  constructor(dash, opts = {}) {
    this.dash = dash;
    this.label = opts.label || dash?.baseUrl || "hermes-gateway";
    this.onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
    this.onReconnect = typeof opts.onReconnect === "function" ? opts.onReconnect : null;
    this.generation = 0; // bumps on every successful (re)connect
    this._ws = null;
    this._closed = false;
    this._connectPromise = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._backoffMs = RECONNECT_BACKOFF_START_MS;
    this._reconnectTimer = null;
  }

  _wsUrl() {
    const baseUrl = String(this.dash?.baseUrl || "").trim();
    const token = String(this.dash?.token || "").trim();
    if (!baseUrl || !token) throw new Error("hermes gateway socket: 缺少 dashboard baseUrl/token");
    return `${baseUrl.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(token)}`;
  }

  /** Resolve once the socket is open (dials if needed). Rejects on dial failure. */
  ensureConnected() {
    if (this._closed) return Promise.reject(new Error("hermes gateway socket: 已关闭"));
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this._wsUrl());
      } catch (err) {
        this._connectPromise = null;
        reject(err);
        return;
      }
      let settled = false;
      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._connectPromise = null;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("hermes gateway socket: 连接超时"));
      }, CONNECT_TIMEOUT_MS);
      ws.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this._connectPromise = null;
        if (this._closed) {
          // 在途 dial 期间被 close()：这条 socket 只存在于闭包里，close() 摸不到，
          // 只能在这里收尾，且绝不能装进 this._ws / 触发 onReconnect。
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error("hermes gateway socket: 已关闭"));
          return;
        }
        this._ws = ws;
        this._backoffMs = RECONNECT_BACKOFF_START_MS;
        this.generation += 1;
        resolve();
        if (this.generation > 1) {
          try { this.onReconnect?.(this.generation); } catch (err) {
            console.error(`[hermes-gw ${this.label}] onReconnect handler threw:`, err?.message || err);
          }
        }
      });
      ws.on("message", (data) => this._handleFrame(data));
      const onGone = (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          this._connectPromise = null;
          reject(err instanceof Error ? err : new Error(String(err?.message || err || "connection failed")));
        }
        this._handleDrop(ws);
      };
      ws.on("error", onGone);
      ws.on("close", () => onGone(new Error("hermes gateway socket: 连接已关闭")));
    });
    return this._connectPromise;
  }

  _handleFrame(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg?.method === "event") {
      const params = msg.params;
      if (params && typeof params === "object") {
        try { this.onEvent?.(params); } catch (err) {
          console.error(`[hermes-gw ${this.label}] onEvent handler threw:`, err?.message || err);
        }
      }
      return;
    }
    if (msg?.id != null && this._pending.has(msg.id)) {
      const entry = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || "hermes gateway socket: RPC 失败");
        err.code = msg.error.code;
        // 显式标记「服务端答复的 JSON-RPC 错误」：网络层错误（ECONNREFUSED 等）
        // 也带 code，调用方不能用 code 有无来区分要不要回落 ACP。
        err.jsonRpc = true;
        entry.reject(err);
      } else {
        entry.resolve(msg.result ?? {});
      }
    }
  }

  _handleDrop(ws) {
    if (this._ws !== ws && ws !== null) {
      // A superseded socket (old dial) died — nothing to do.
      if (!this._ws) this._scheduleReconnect();
      return;
    }
    this._ws = null;
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("hermes gateway socket: 连接中断"));
    }
    this._pending.clear();
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const delay = this._backoffMs;
    this._backoffMs = Math.min(this._backoffMs * 2, RECONNECT_BACKOFF_CAP_MS);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closed) return;
      this.ensureConnected().catch(() => {
        /* dial failed → ensureConnected's close handler re-schedules */
      });
    }, delay);
  }

  /**
   * Issue a JSON-RPC request over the persistent socket (dials if needed).
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?: number}} [opts]
   */
  async request(method, params = {}, opts = {}) {
    await this.ensureConnected();
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("hermes gateway socket: 连接不可用");
    }
    const id = this._nextId++;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`hermes gateway socket: ${method} 超时`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Permanently close (no reconnect). Pending requests reject. */
  close() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const ws = this._ws;
    this._ws = null;
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("hermes gateway socket: 已关闭"));
    }
    this._pending.clear();
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
  }
}

module.exports = { gatewayRpc, modelSwitchValue, HermesGatewaySocket };
