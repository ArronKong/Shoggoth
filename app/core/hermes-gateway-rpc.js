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
const serverRequests = require("./hermes-server-requests");

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

// Dashboard descriptors are trusted Backend objects, never renderer input.
// A managed descriptor owns a frozen checker; once that checker or namespace
// fails, the captured transport cannot reconnect or fall back to another host.
function operationId(params, opts = {}) {
  const value = opts.operationId ?? params?.selection_dispatch?.operation_id ?? params?.operation_id;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw Object.assign(new Error("hermes gateway: invalid operation identity"), { code: "HERMES_GATEWAY_OPERATION_INVALID" });
  }
  return value;
}
function transportError(cause, dispatched, originalOperationId, managed = false) {
  const error = cause instanceof Error ? cause : new Error(String(cause || "hermes gateway: connection unavailable"));
  error.operationId = originalOperationId;
  error.originalOperationId = originalOperationId;
  error.receiptUncertain = dispatched === true;
  error.executionUncertain = dispatched === true;
  error.admissionAccepted = dispatched ? null : false;
  error.needsVerification = dispatched === true;
  error.state = dispatched ? "needs_verification" : "rejected";
  error.status = error.state;
  if (dispatched || managed) error.noAcpFallback = true;
  return error;
}
function retiredError() {
  return Object.assign(new Error("Hermes 受管宿主连接已退休，请核验原任务"), { code: "MANAGED_HERMES_ENDPOINT_RETIRED", managedRetired: true });
}
function bindDashboard(dash) {
  const checker = Object.getOwnPropertyDescriptor(dash || {}, "assertCurrent");
  const managed = dash?.managed === true || typeof checker?.value === "function";
  if (managed && (!Object.isFrozen(dash) || typeof checker?.value !== "function")) throw retiredError();
  const assertCurrent = () => {
    try { if (managed && checker.value.call(dash) !== true) throw retiredError(); }
    catch { throw retiredError(); }
    return true;
  };
  assertCurrent();
  const baseUrl = String(dash?.baseUrl || "").trim();
  const token = String(dash?.token || "").trim();
  if (!baseUrl || !token) throw new Error("hermes gateway: 缺少 dashboard baseUrl/token");
  const profile = managed ? dash.profile : null;
  if (managed && (typeof profile !== "string" || !profile || profile.length > 128 || [".", ".."].includes(profile)
    || /[\\/\u0000-\u001f\u007f]/u.test(profile))) throw retiredError();
  return Object.freeze({ managed, profile, wsUrl: `${baseUrl.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(token)}`,
    assertCurrent() {
      assertCurrent();
      if (String(dash?.baseUrl || "").trim() !== baseUrl || String(dash?.token || "").trim() !== token
        || managed && dash.profile !== profile) throw retiredError();
      return true;
    },
    serialize(id, method, params) {
      let scoped = params;
      const selectsProfile = managed && ["session.create", "session.resume"].includes(method);
      if (selectsProfile) {
        if (!params || typeof params !== "object" || Array.isArray(params)
          || params.profile !== undefined && params.profile !== profile) {
          throw Object.assign(new Error("Hermes 会话 profile 与受管宿主不匹配"), { code: "MANAGED_HERMES_PROFILE_MISMATCH" });
        }
        scoped = { ...params, profile };
      }
      const bytes = JSON.stringify({ jsonrpc: "2.0", id, method, params: scoped });
      // Serialization can execute user-defined getters/toJSON. Recheck both
      // authority and the actual wire profile after it, before any socket send.
      this.assertCurrent();
      if (selectsProfile && JSON.parse(bytes)?.params?.profile !== profile) {
        throw Object.assign(new Error("Hermes 会话 profile 与受管宿主不匹配"), { code: "MANAGED_HERMES_PROFILE_MISMATCH" });
      }
      return bytes;
    },
  });
}

/** One JSON-RPC call. opts.operationId is the existing App operation, never minted here. */
function gatewayRpc(dash, method, params = {}, opts = {}) {
  const originalOperationId = operationId(params, opts);
  let binding;
  try { binding = bindDashboard(dash); binding.assertCurrent(); }
  catch (error) { throw transportError(error, false, originalOperationId, dash?.managed === true); }
  return new Promise((resolve, reject) => {
    let ws, requestTimer = null, connectTimer = null, settled = false, dispatched = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true; clearTimeout(connectTimer); clearTimeout(requestTimer);
      try { ws?.close(); } catch { /* already closing */ }
      fn(value);
    };
    const fail = error => finish(reject, transportError(error, dispatched, originalOperationId, binding.managed));
    const current = () => { try { binding.assertCurrent(); return true; } catch { fail(retiredError()); return false; } };
    try {
      if (!current()) return;
      ws = new WebSocket(binding.wsUrl);
    } catch (error) { fail(error); return; }
    connectTimer = setTimeout(() => fail(new Error(`hermes gateway rpc: 连接超时 (${method})`)), CONNECT_TIMEOUT_MS);
    ws.on("open", () => {
      if (settled || !current()) return;
      clearTimeout(connectTimer);
      try {
        const bytes = binding.serialize(1, method, params);
        if (!current()) return;
        requestTimer = setTimeout(() => fail(new Error(`hermes gateway rpc: ${method} 超时`)),
          Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS);
        // After send is attempted, receipt loss is uncertain even if a later
        // write callback reports an error; it cannot prove Host non-admission.
        dispatched = true; ws.send(bytes);
      } catch (error) { fail(error); }
    });
    ws.on("message", data => {
      if (settled || !current()) return;
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (!current() || msg?.id !== 1) return;
      if (msg.error) {
        const error = new Error(msg.error.message || `hermes gateway rpc: ${method} 失败`); error.code = msg.error.code; error.jsonRpc = true;
        if (typeof msg.error.data?.code === "string" && /^SELECTION_[A-Z_]{1,60}$/u.test(msg.error.data.code)) error.contractCode = msg.error.data.code;
        finish(reject, error); return;
      }
      finish(resolve, msg.result ?? {});
    });
    ws.on("error", error => {
      if (/unexpected server response: 500/i.test(String(error?.message || error))) {
        fail(new Error("hermes gateway rpc: dashboard 不支持 /api/ws（Hermes 0.18.x 的 --isolated 已知缺陷）。请重启该 profile 的 dashboard 进程以加载已安装的新版本。"));
      } else fail(error);
    });
    ws.on("close", () => fail(new Error(`hermes gateway rpc: 连接已关闭 (${method})`)));
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
  constructor(dash, opts = {}) {
    this.dash = dash;
    // Never use an unchecked managed getter in a diagnostic label.
    this.label = opts.label || "hermes-gateway";
    this.onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
    this.onReconnect = typeof opts.onReconnect === "function" ? opts.onReconnect : null;
    this.onServerRequest = typeof opts.onServerRequest === "function" ? opts.onServerRequest : null;
    this.onServerRequestCancel = typeof opts.onServerRequestCancel === "function" ? opts.onServerRequestCancel : null;
    this.serverRequestsSupported = false;
    this._serverRequests = new Map();
    this._serverRequestTombstones = new Set();
    this.generation = 0;
    this._ws = null;
    this._dialWs = null;
    this._closed = false;
    this._retired = false;
    this._binding = null;
    this._connectPromise = null;
    this._rejectDial = null;
    this._nextId = 1;
    this._pending = new Map();
    this._backoffMs = RECONNECT_BACKOFF_START_MS;
    this._reconnectTimer = null;
  }
  _assertCurrent() {
    if (this._closed) throw this._retired ? retiredError() : new Error("hermes gateway socket: 已关闭");
    try {
      this._binding ||= bindDashboard(this.dash);
      this._binding.assertCurrent();
      return this._binding;
    } catch {
      this._retire(); throw retiredError();
    }
  }
  _wsUrl() { return this._assertCurrent().wsUrl; }
  _retire() { this._retired = true; this.close(); }
  ensureConnected() {
    let binding;
    try { binding = this._assertCurrent(); }
    catch (error) { return Promise.reject(transportError(error, false, null, this.dash?.managed === true)); }
    if (this._connectPromise) return this._connectPromise;
    if (this._ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    const promise = new Promise((resolve, reject) => {
      let ws, settled = false, connectTimer = null;
      const fail = error => {
        if (settled) return;
        settled = true; clearTimeout(connectTimer); this._rejectDial = null;
        if (this._dialWs === ws) this._dialWs = null;
        try { ws?.close(); } catch { /* ignore */ }
        reject(error);
      };
      this._rejectDial = fail;
      try { this._assertCurrent(); ws = new WebSocket(binding.wsUrl); this._dialWs = ws; }
      catch (error) { fail(error); return; }
      connectTimer = setTimeout(() => fail(new Error("hermes gateway socket: 连接超时")), CONNECT_TIMEOUT_MS);
      ws.on("open", () => {
        if (settled) return;
        try { this._assertCurrent(); }
        catch (error) { fail(error); return; }
        this._ws = ws; this._dialWs = null; this.generation += 1;
        this._serverRequestTombstones.clear(); this.serverRequestsSupported = false;
        const ready = () => {
          if (settled || ws !== this._ws) return;
          try { this._assertCurrent(); } catch (error) { fail(error); return; }
          settled = true; clearTimeout(connectTimer); this._rejectDial = null;
          this._backoffMs = RECONNECT_BACKOFF_START_MS; resolve();
          if (this.generation > 1) {
            try { this.onReconnect?.(this.generation); }
            catch (error) { if (!this._closed) console.error(`[hermes-gw ${this.label}] onReconnect handler threw:`, error?.message || error); }
          }
        };
        if (!this.onServerRequest) { ready(); return; }
        // Use the current physical socket before releasing session/prompt calls.
        this._requestOnSocket("client.capabilities", { server_requests: true }, { timeoutMs: CONNECT_TIMEOUT_MS })
          .then(() => { if (ws === this._ws) this.serverRequestsSupported = true; ready(); }, error => {
            if (error?.jsonRpc && error.code === -32601) ready(); // older Hermes
            else fail(error);
          });
      });
      ws.on("message", data => this._handleFrame(data, ws));
      const gone = error => { if (!settled) fail(error); this._handleDrop(ws); };
      ws.on("error", gone);
      ws.on("close", () => gone(new Error("hermes gateway socket: 连接已关闭")));
    });
    this._connectPromise = promise;
    promise.then(() => { if (this._connectPromise === promise) this._connectPromise = null; },
      () => { if (this._connectPromise === promise) this._connectPromise = null; });
    return promise;
  }
  _handleFrame(data, ws) {
    if (this._closed || ws !== this._ws || ws.readyState !== WebSocket.OPEN) return;
    try { this._assertCurrent(); } catch { return; }
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    try { this._assertCurrent(); } catch { return; }
    if (typeof msg?.method === "string" && msg.id != null) {
      this._acceptServerRequest(msg, ws); return;
    }
    if (msg?.method === "event") {
      if (msg.params?.type === "request.cancel") {
        this._forgetServerRequest(msg.params.payload?.id, msg.params.session_id);
      }
      if (msg.params && typeof msg.params === "object") {
        try { this._assertCurrent(); this.onEvent?.(msg.params); }
        catch (error) { if (!this._closed) console.error(`[hermes-gw ${this.label}] onEvent handler threw:`, error?.message || error); }
      }
      return;
    }
    const entry = msg?.id != null ? this._pending.get(msg.id) : null;
    if (!entry || entry.ws !== ws) return;
    this._pending.delete(msg.id); clearTimeout(entry.timer);
    if (msg.error) {
      const error = new Error(msg.error.message || "hermes gateway socket: RPC 失败"); error.code = msg.error.code; error.jsonRpc = true;
      if (typeof msg.error.data?.code === "string" && /^SELECTION_[A-Z_]{1,60}$/u.test(msg.error.data.code)) error.contractCode = msg.error.data.code;
      entry.reject(error);
    } else entry.resolve(msg.result ?? {});
  }
  _handleDrop(ws) {
    // An obsolete dial/socket can never clear or resolve a later socket's map.
    if (this._ws !== ws) { if (!this._ws && !this._dialWs) this._scheduleReconnect(); return; }
    this._ws = null;
    this._clearServerRequests(); this.serverRequestsSupported = false;
    for (const [id, entry] of this._pending) if (entry.ws === ws) {
      clearTimeout(entry.timer); this._pending.delete(id);
      entry.reject(transportError(new Error("hermes gateway socket: 连接中断"), entry.dispatched, entry.operationId, this._binding?.managed));
    }
    this._scheduleReconnect();
  }
  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    try { this._assertCurrent(); } catch { return; }
    const delay = this._backoffMs; this._backoffMs = Math.min(this._backoffMs * 2, RECONNECT_BACKOFF_CAP_MS);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closed) return;
      this.ensureConnected().catch(() => { /* transient failures retain this namespace only */ });
    }, delay);
  }
  /** opts.operationId carries the existing original App operation. */
  async request(method, params = {}, opts = {}) {
    const originalOperationId = operationId(params, opts);
    let binding;
    try { binding = this._assertCurrent(); await this.ensureConnected(); binding = this._assertCurrent(); }
    catch (error) { throw transportError(error, false, originalOperationId, this.dash?.managed === true); }
    return this._requestOnSocket(method, params, opts);
  }
  _requestOnSocket(method, params = {}, opts = {}) {
    const originalOperationId = operationId(params, opts);
    let binding;
    try { binding = this._assertCurrent(); }
    catch (error) { return Promise.reject(transportError(error, false, originalOperationId, this.dash?.managed === true)); }
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(transportError(new Error("hermes gateway socket: 连接不可用"), false, originalOperationId, binding.managed));
    const id = this._nextId++;
    let bytes;
    try { bytes = binding.serialize(id, method, params); this._assertCurrent(); }
    catch (error) { try { this._assertCurrent(); } catch { error = retiredError(); } throw transportError(error, false, originalOperationId, binding.managed); }
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, ws, dispatched: false, operationId: originalOperationId };
      entry.timer = setTimeout(() => {
        if (this._pending.get(id) !== entry) return;
        this._pending.delete(id);
        reject(transportError(new Error(`hermes gateway socket: ${method} 超时`), entry.dispatched, originalOperationId, binding.managed));
      }, timeoutMs);
      this._pending.set(id, entry);
      try {
        this._assertCurrent();
        if (ws !== this._ws || ws.readyState !== WebSocket.OPEN) throw new Error("hermes gateway socket: 连接不可用");
        entry.dispatched = true; ws.send(bytes);
      } catch (error) {
        clearTimeout(entry.timer); this._pending.delete(id);
        reject(transportError(error, entry.dispatched, originalOperationId, binding.managed));
      }
    });
  }
  _sendServerResponse(entry, body) {
    this._assertCurrent();
    if (entry.ws !== this._ws || entry.generation !== this.generation || entry.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Hermes 请求连接已失效，请等待重新核对");
    }
    const bytes = JSON.stringify({ jsonrpc: "2.0", id: entry.frame.id, ...body });
    this._assertCurrent();
    return new Promise((resolve, reject) => entry.ws.send(bytes, error => error ? reject(error) : resolve({ status: "sent" })));
  }
  _acceptServerRequest(frame, ws = this._ws) {
    if (!this.onServerRequest || ws !== this._ws || !serverRequests.validRequest(frame)) return;
    if (this._serverRequestTombstones.has(frame.id) || this._serverRequests.has(frame.id)) return;
    const entry = { frame, ws, generation: this.generation, delivered: false };
    if (!serverRequests.KINDS.has(frame.method) || !serverRequests.promptForRequest(frame)) {
      const code = serverRequests.WINDOW_REQUESTS.has(frame.method) ? 4404 : -32601;
      this._sendServerResponse(entry, { error: { code, message: "Shoggoth cannot handle this Hermes request" } }).catch(() => {});
      this._rememberServerRequest(frame.id); return;
    }
    if (this._serverRequests.size >= 128) {
      this._sendServerResponse(entry, { error: { code: -32000, message: "Too many pending Hermes requests" } }).catch(() => {}); return;
    }
    this._serverRequests.set(frame.id, entry);
    this._deliverServerRequest(entry);
  }
  _deliverServerRequest(entry) {
    if (entry.delivered || entry.ws !== this._ws) return;
    try { this._assertCurrent(); entry.delivered = this.onServerRequest?.(entry.frame) === true; }
    catch (error) {
      if (error?.code !== "HERMES_REQUEST_OWNER_UNVERIFIED") return;
      this._serverRequests.delete(entry.frame.id); this._rememberServerRequest(entry.frame.id);
      this._sendServerResponse(entry, { error: { code: -32001, message: "Selected-turn request ownership is unavailable" } }).catch(() => {});
    }
  }
  restoreServerRequests(frames, sessionId) {
    if (!Array.isArray(frames)) return;
    for (const frame of frames.slice(0, 128)) {
      if (frame?.params?.session_id === sessionId) this._acceptServerRequest(frame);
    }
  }
  replayServerRequests(sessionId) {
    for (const entry of this._serverRequests.values()) if (entry.frame.params.session_id === sessionId) this._deliverServerRequest(entry);
  }
  pendingServerRequestPrompts(sessionId) {
    if (this._closed || this._retired || this._ws?.readyState !== WebSocket.OPEN) return [];
    try { this._assertCurrent(); } catch { return []; }
    return [...this._serverRequests.values()].filter(entry => entry.delivered
      && entry.ws === this._ws && entry.generation === this.generation
      && entry.frame.params.session_id === sessionId)
      .map(entry => serverRequests.promptForRequest(entry.frame)).filter(Boolean);
  }
  _rememberServerRequest(id) {
    this._serverRequestTombstones.add(id);
    while (this._serverRequestTombstones.size > 256) this._serverRequestTombstones.delete(this._serverRequestTombstones.values().next().value);
  }
  _forgetServerRequest(id, sessionId) {
    if (typeof id !== "string") return;
    const entry = this._serverRequests.get(id);
    if (entry && entry.frame.params.session_id !== sessionId) return;
    this._rememberServerRequest(id); this._serverRequests.delete(id);
    if (entry?.delivered) this.onServerRequestCancel?.(entry.frame);
  }
  forgetServerRequestsForSession(sessionId) {
    for (const [id, entry] of this._serverRequests) {
      if (entry.frame.params.session_id === sessionId) this._forgetServerRequest(id, sessionId);
    }
  }
  _clearServerRequests() {
    for (const entry of this._serverRequests.values()) {
      if (entry.delivered) try { this.onServerRequestCancel?.(entry.frame); } catch { /* close every request */ }
    }
    this._serverRequests.clear();
  }
  async respondServerRequest(sessionId, data) {
    const entry = this._serverRequests.get(data.requestId);
    if (!entry || !entry.delivered || entry.frame.params.session_id !== sessionId) throw new Error("Hermes 请求已失效或不属于当前会话");
    const result = serverRequests.responseForRequest(entry.frame, data);
    // Remove before dispatch: a lost response receipt must never approve twice.
    this._serverRequests.delete(data.requestId); this._rememberServerRequest(data.requestId);
    try { return await this._sendServerResponse(entry, { result }); }
    finally { try { this.onServerRequestCancel?.(entry.frame); } catch { /* detached observer */ } }
  }
  close() {
    this._clearServerRequests();
    this._closed = true;
    clearTimeout(this._reconnectTimer); this._reconnectTimer = null;
    const error = this._retired ? retiredError() : new Error("hermes gateway socket: 已关闭");
    this._rejectDial?.(error); this._rejectDial = null;
    const sockets = new Set([this._ws, this._dialWs]); this._ws = null; this._dialWs = null;
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      // Use a fresh Error per entry so identities cannot overwrite each other.
      const cause = this._retired ? retiredError() : new Error(error.message);
      entry.reject(transportError(cause, entry.dispatched, entry.operationId, this._binding?.managed));
    }
    this._pending.clear();
    for (const ws of sockets) if (ws) try { ws.close(); } catch { /* ignore */ }
  }
}

module.exports = { gatewayRpc, modelSwitchValue, HermesGatewaySocket };
