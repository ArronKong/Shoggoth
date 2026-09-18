"use strict";

// Federating gateway proxy (v2 — multi-backend registry).
//
// The Control UI normally connects straight to the OpenClaw gateway. Here it
// connects to THIS local WebSocket instead, and every frame is relayed to/from
// the real gateway untouched — so the connect / device-auth handshake passes
// through transparently and OpenClaw behaves exactly as before.
//
// On top of that pure passthrough we do ONE thing: rewrite the `agents.list`
// response to add foreign agents from all registered backends so they appear
// in the official contact list. A `chat.send` addressed to such an agent is
// routed to the owning backend so it doesn't error against the real gateway.

const http = require("node:http");
const { WebSocketServer, WebSocket } = require("ws");
const {
  normalizeFederationInputProvenance,
} = require("../federation-chat-provenance");
const { normalizeInteractiveRequestV1 } = require("./shoggoth-interaction-contract");

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

const SAFE_BACKEND_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function safeWatcherErrorMessage(error) {
  const code = typeof error?.code === "string" && SAFE_BACKEND_ERROR_CODE.test(error.code)
    ? error.code
    : "BACKEND_ERROR";
  return `Shoggoth 会话恢复失败 (${code})`;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const WS_CLOSE_GRACE_MS = 100;

// A loopback WebSocket is reachable from ANY page — the same-origin policy does
// not gate WS handshakes. Since this proxy answers foreign-backend RPCs locally
// (chat.send to a Hermes agent runs tools), a cross-site page must not get in.
// Browsers always send Origin; native clients (the broker, the smokes) don't and
// stay allowed. "null" (sandboxed iframe / file://) is a known bypass → refused.
// Port isn't checked: the broker presents DEFAULT_ORIGIN ("http://127.0.0.1").
function isAllowedInboundOrigin(origin) {
  if (origin === undefined) return true; // native client, not a browser
  if (!origin || origin === "null") return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Foreign-owned RPCs that this proxy short-circuits and serves locally. They
// never reach the real gateway, so the gateway's device-auth never sees them —
// we must enforce the handshake ourselves or they'd be callable by anyone who
// can open the socket.
const FOREIGN_ROUTED_METHODS = new Set([
  "chat.history",
  "chat.send",
  "chat.abort",
  "chat.respond",
  "sessions.patch",
  "sessions.delete",
  "sessions.create",
  "sessions.compact",
]);

// OpenClaw 启动型 RPC 的版本锁定清单。新增 gateway 启动入口时必须同时更新
// proxy-chat-smoke；只读/配置 RPC 不得被模型切换 drain 误伤。
const OPENCLAW_START_RPC_METHODS = Object.freeze([
  "chat.send",
  "agent",
  "cron.run",
  "workboard.cards.dispatch",
]);
const OPENCLAW_START_RPC_METHOD_SET = new Set(OPENCLAW_START_RPC_METHODS);
const MAX_CLIENT_HISTORY_WATCHES = 64;
const MAX_CLIENT_TERMINAL_DELIVERIES = 256;
const MAX_FEDERATION_PROMPTS = 128;

// Session keys look like "agent:<id>" or "agent:<id>:<name>". Return <id>.
function agentIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") {
    return null;
  }
  const match = /^agent:([^:]+)/.exec(sessionKey);
  return match ? match[1] : null;
}

// Every agent id that may determine a routed frame's backend. sessions.create
// prefers an owned explicit id but falls back to an owned parent; auth/static
// namespace gates must therefore inspect BOTH candidates before routing.
function targetAgentIdsOf(frame) {
  if (frame?.method === "sessions.create") {
    const candidates = [
      typeof frame.params?.agentId === "string" ? frame.params.agentId : null,
      agentIdFromSessionKey(frame.params?.parentSessionKey),
    ];
    return [...new Set(candidates.filter(Boolean))];
  }
  const agentId = agentIdFromSessionKey(frame?.params?.sessionKey ?? frame?.params?.key);
  return agentId ? [agentId] : [];
}

// The UI sends backend-neutral model identity fields. OpenClaw's public RPCs
// still expect one qualified `provider/model` string and reject unknown fields,
// so adapt only at the upstream boundary after foreign routing has had a chance
// to consume the structured hints locally.
function adaptModelHintsForOpenClaw(frame, raw) {
  if (
    !frame
    || (frame.method !== "sessions.patch" && frame.method !== "sessions.create")
    || !frame.params
    || typeof frame.params !== "object"
  ) {
    return raw;
  }
  const hasProviderHint = Object.prototype.hasOwnProperty.call(frame.params, "modelProvider");
  const hasAcpHint = Object.prototype.hasOwnProperty.call(frame.params, "acpProviderRef");
  if (!hasProviderHint && !hasAcpHint) return raw;
  const params = { ...frame.params };
  const provider = String(params.modelProvider ?? "").trim();
  delete params.modelProvider;
  delete params.acpProviderRef;
  if (provider && typeof params.model === "string" && params.model) {
    params.model = `${provider}/${params.model}`;
  }
  return JSON.stringify({ ...frame, params });
}

// Session-MUTATING RPCs (FOREIGN_ROUTED_METHODS minus read-only chat.history).
// The gateway never validates the agentId inside a session key — it just
// persists whatever it is handed, growing agents/<id>/sessions/sessions.json
// for agents it doesn't have. Anything in here is dropped instead of forwarded
// when its target agent is known-foreign; see the guard before sendToUpstream.
const SESSION_WRITE_METHODS = new Set(
  [...FOREIGN_ROUTED_METHODS].filter((method) => method !== "chat.history"),
);

// Append foreign agents to an `agents.list` response payload, skipping any id
// the real gateway already returned. `isForeignNamespace(id)` (optional) drops
// upstream rows whose id belongs to a foreign backend's static namespace —
// those are orphans (e.g. a leaked `hermes-default` agent store on the OpenClaw
// gateway), never legitimate gateway agents; keeping them would resurrect the
// exact bug this guards against.
function injectIntoAgentsList(resFrame, agents, isForeignNamespace) {
  if (!resFrame.ok || !resFrame.payload || typeof resFrame.payload !== "object") {
    return resFrame;
  }
  const payload = resFrame.payload;
  const rawExisting = Array.isArray(payload.agents) ? payload.agents : [];
  const existing = typeof isForeignNamespace === "function"
    ? rawExisting.filter((entry) => !(entry && entry.id && isForeignNamespace(entry.id)))
    : rawExisting;
  const orphansDropped = existing.length !== rawExisting.length;
  const have = new Set(existing.map((entry) => entry && entry.id));
  const additions = agents
    .filter((agent) => agent && agent.id && !have.has(agent.id))
    .map((agent) => {
      const row = { id: agent.id, name: agent.name, identity: { name: agent.name } };
      // GatewayAgentModel = { primary?, fallbacks? }. `primary` shows the agent's
      // active model; `fallbacks` carries the full per-profile model list so the
      // skin can filter the chat-model dropdown to just that agent's choices.
      if (agent.model || (agent.fallbacks && agent.fallbacks.length)) {
        row.model = {};
        if (agent.model) row.model.primary = agent.model;
        if (Array.isArray(agent.fallbacks) && agent.fallbacks.length) {
          row.model.fallbacks = agent.fallbacks;
        }
      }
      return row;
    });
  // 无新增且没滤掉孤儿 → 原样返回；只要滤掉过孤儿就必须重建 payload。
  if (additions.length === 0 && !orphansDropped) {
    return resFrame;
  }
  return { ...resFrame, payload: { ...payload, agents: [...existing, ...additions] } };
}

// Append foreign ModelChoice entries to a `models.list` response, skipping any
// id the real gateway already returned. Lets the chat composer's model dropdown
// resolve + display Hermes models instead of falling back to OpenClaw defaults.
//
// User config (OpenClaw `~/.openclaw/openclaw.json` providers) is authoritative:
// if upstream returns `{ provider: "xiaomi", id: "mimo-v2.5-pro" }`, we must NOT
// let a Hermes profile re-inject the same model as the slash-qualified id
// `xiaomi/mimo-v2.5-pro` (e.g. nous/openrouter-style profiles do this), which
// would otherwise show up as a duplicate row under the Xiaomi group in the
// agent-page Primary-model dropdown. So the "have" set blocks both forms.
function injectIntoModelsList(resFrame, choices) {
  if (!resFrame.ok || !resFrame.payload || typeof resFrame.payload !== "object") {
    return resFrame;
  }
  const payload = resFrame.payload;
  const existing = Array.isArray(payload.models) ? payload.models : [];
  const have = new Set();
  for (const entry of existing) {
    if (!entry || !entry.id) continue;
    have.add(entry.id);
    if (entry.provider) {
      have.add(`${entry.provider}/${entry.id}`);
    }
  }
  // Tag injections so the skin can distinguish "truly Hermes-only" ids from
  // OpenClaw-native ids that happen to share a name with a Hermes profile's
  // model. Without this the chat-page filter
  // (chat-agent-list.js → filterChatModelOptionsForActiveAgent) over-hides
  // legitimate OpenClaw rows on OpenClaw-native agents.
  const additions = choices
    .filter((c) => c && c.id && !have.has(c.id))
    .map((c) => ({ ...c, hermesInjected: true }));
  if (additions.length === 0) {
    return resFrame;
  }
  return { ...resFrame, payload: { ...payload, models: [...existing, ...additions] } };
}

// Append foreign GatewaySessionRow entries to a `sessions.list` response,
// skipping any key the real gateway already returned. `isForeignNamespace(id)`
// (optional) drops upstream sessions whose agent id belongs to a foreign
// backend's namespace — orphan session stores the gateway persisted for an id
// it doesn't really own (the `agent:hermes-default:<uuid>` rows in
// ~/.openclaw/agents/hermes-default/). Without this filter such an orphan makes
// the hermes-default row appear in the UI roster BEFORE Hermes is ready, which
// caches a degraded (image-only, no-slash) capability set for the whole session.
function injectIntoSessionsList(resFrame, rows, isForeignNamespace) {
  if (!resFrame.ok || !resFrame.payload || typeof resFrame.payload !== "object") {
    return resFrame;
  }
  const payload = resFrame.payload;
  const rawExisting = Array.isArray(payload.sessions) ? payload.sessions : [];
  const existing = typeof isForeignNamespace === "function"
    ? rawExisting.filter((row) => !(row && row.key && isForeignNamespace(agentIdFromSessionKey(row.key))))
    : rawExisting;
  const orphansDropped = existing.length !== rawExisting.length;
  const have = new Set(existing.map((row) => row && row.key));
  const additions = rows.filter((row) => row && row.key && !have.has(row.key));
  if (additions.length === 0 && !orphansDropped) {
    return resFrame;
  }
  const sessions = [...existing, ...additions];
  return {
    ...resFrame,
    payload: { ...payload, sessions, count: sessions.length },
  };
}

// `degradedBackends` means this sessions.list response is not authoritative for
// those backend partitions. Preserve any marker already present on a locally
// synthesized OpenClaw-down response and union registry-reported starting rows.
function markIncompleteSessionBackends(resFrame, backendIds) {
  if (!resFrame.ok || !resFrame.payload || typeof resFrame.payload !== "object") return resFrame;
  const ids = new Set(Array.isArray(resFrame.payload.degradedBackends) ? resFrame.payload.degradedBackends : []);
  for (const id of Array.isArray(backendIds) ? backendIds : []) {
    if (typeof id === "string" && id) ids.add(id);
  }
  if (ids.size === 0) return resFrame;
  return {
    ...resFrame,
    payload: { ...resFrame.payload, degradedBackends: [...ids] },
  };
}

function readRegistrySessionSnapshot(registry, filter) {
  if (!registry) return { rows: [], incompleteBackends: [] };
  if (typeof registry.aggregateSessionSnapshot === "function") {
    return registry.aggregateSessionSnapshot(filter);
  }
  // Compatibility for small embedders/tests that provide the older rows-only
  // registry surface. Such a source cannot report incompleteness, but its rows
  // must continue to be injected.
  const rows = typeof registry.aggregateSessions === "function"
    ? registry.aggregateSessions(filter)
    : [];
  return { rows: Array.isArray(rows) ? rows : [], incompleteBackends: [] };
}

// 每个浏览器连接独立跟踪三类 list 请求；降级本地答复、上游答复和连接关闭
// 都通过同一 helper 释放，避免请求 id 集合随连接寿命无限增长。
function createProxyListRequestTracker() {
  const agents = new Set();
  const models = new Map();
  const sessions = new Map();
  return {
    // 只记录需要在响应阶段注入/改写的 list 请求。
    track(frame) {
      if (!frame?.id) return;
      if (frame.method === "agents.list") agents.add(frame.id);
      else if (frame.method === "models.list") {
        const agentId = typeof frame.params?.agentId === "string" ? frame.params.agentId : undefined;
        models.set(frame.id, { agentId });
      }
      else if (frame.method === "sessions.list") {
        const agentId = typeof frame.params?.agentId === "string" ? frame.params.agentId : undefined;
        sessions.set(frame.id, { agentId });
      }
    },
    // 降级模式已在本地答复时按 id 同时清掉所有潜在记录。
    forget(id) {
      agents.delete(id);
      models.delete(id);
      sessions.delete(id);
    },
    // 上游响应路径“取出即删除”，返回是否确实命中过记录。
    takeAgents(id) {
      return agents.delete(id);
    },
    takeModels(id) {
      if (!models.has(id)) return { tracked: false };
      const meta = models.get(id);
      models.delete(id);
      return { tracked: true, agentId: meta?.agentId };
    },
    takeSessions(id) {
      if (!sessions.has(id)) return { tracked: false };
      const meta = sessions.get(id);
      sessions.delete(id);
      return { tracked: true, agentId: meta?.agentId };
    },
    // 浏览器 socket close 时一次性释放全部连接级状态。
    clear() {
      agents.clear();
      models.clear();
      sessions.clear();
    },
    // 专项回归只读诊断，不泄露实际请求内容。
    sizes() {
      return { agents: agents.size, models: models.size, sessions: sessions.size };
    },
  };
}

/**
 * @param {object} opts
 * @param {number} opts.port            local port the Control UI connects to
 * @param {() => string} opts.getUpstreamUrl  resolves the real gateway ws URL (read fresh per connection)
 * @param {number} [opts.upstreamRetryMs]  degraded-mode upstream retry interval (default 4000; tests shrink it)
 * @param {number} [opts.upstreamHandshakeTimeoutMs] degraded recovery handshake deadline (default 8000)
 * @param {string} [opts.origin]        Origin header to present upstream (mirrors the UI page origin)
 * @param {import('./backend-registry').BackendRegistry} [opts.registry]  multi-backend registry for routing
 * @param {{enter:(backendId:string,kind:string)=>Function}} [opts.workAdmissionGate] 新工作入口闸门
 * @param {() => Array<{id:string,name:string}>} [opts.getInjectAgents]  fallback when no registry is provided
 * @returns {Promise<{url:string, port:number, close:() => Promise<void>}>}
 */
function startProxyGateway({
  port = 18790,
  getUpstreamUrl,
  origin,
  registry,
  workAdmissionGate,
  getInjectAgents,
  upstreamRetryMs = 4000,
  upstreamHandshakeTimeoutMs = 8000,
}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, verifyClient: (info) => isAllowedInboundOrigin(info.origin) });
  const clients = new Set();
  const authenticatedClients = new WeakSet();
  const terminalDeliveries = new WeakMap();
  const federationPrompts = new Map();
  const connectionShutdowns = new Set();
  let closing = false;
  let closePromise = null;

  const broadcast = (raw) => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  };

  const broadcastAuthenticated = (raw) => {
    for (const ws of clients) {
      if (authenticatedClients.has(ws) && ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  };

  const federationPromptKey = (backendId, sessionKey, runId, requestId) =>
    `${backendId}\0${sessionKey}\0${runId}\0${requestId}`;
  const rememberFederationPrompt = (record) => {
    const key = federationPromptKey(
      record.backendId,
      record.sessionKey,
      record.runId,
      record.requestId,
    );
    federationPrompts.delete(key);
    federationPrompts.set(key, record);
    if (federationPrompts.size > MAX_FEDERATION_PROMPTS) {
      federationPrompts.delete(federationPrompts.keys().next().value);
    }
  };
  const forgetFederationPrompt = (backendId, sessionKey, runId, requestId) => {
    federationPrompts.delete(federationPromptKey(backendId, sessionKey, runId, requestId));
  };
  const forgetFederationRunPrompts = (backendId, sessionKey, runId) => {
    const forgotten = [];
    for (const [key, record] of federationPrompts) {
      if (record.backendId === backendId
        && record.sessionKey === sessionKey && record.runId === runId) {
        federationPrompts.delete(key);
        forgotten.push(record);
      }
    }
    return forgotten;
  };

  // Foreign send observers broadcast completion so passive subscribers (for
  // example Notifier) are not blind. Service watchers and idempotent retries may
  // discover the same terminal concurrently, so each authenticated socket keeps
  // a bounded ledger keyed by durable Run id, falling back to idempotencyKey.
  const deliverTerminal = (ws, raw, terminalKey) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (typeof terminalKey !== "string" || terminalKey.length === 0
      || Buffer.byteLength(terminalKey, "utf8") > 512) {
      ws.send(raw);
      return;
    }
    let ledger = terminalDeliveries.get(ws);
    if (!ledger) {
      ledger = new Map();
      terminalDeliveries.set(ws, ledger);
    }
    if (ledger.has(terminalKey)) {
      ledger.delete(terminalKey);
      ledger.set(terminalKey, true);
      return;
    }
    ledger.set(terminalKey, true);
    if (ledger.size > MAX_CLIENT_TERMINAL_DELIVERIES) {
      const oldestKey = ledger.keys().next().value;
      ledger.delete(oldestKey);
    }
    ws.send(raw);
  };

  const broadcastTerminal = (raw, terminalKey) => {
    for (const ws of clients) {
      if (authenticatedClients.has(ws)) deliverTerminal(ws, raw, terminalKey);
    }
  };

  // The agent ids the gateway itself claims, read off each agents.list response
  // BEFORE foreign rows are injected. Shared across connections: one socket
  // learning the roster protects every socket. Re-filled (not merged) so agents
  // added or removed upstream are picked up on the next list.
  const upstreamAgentIds = new Set();
  const rememberUpstreamAgents = (resFrame) => {
    if (!resFrame.ok || !Array.isArray(resFrame.payload?.agents)) return;
    upstreamAgentIds.clear();
    for (const agent of resFrame.payload.agents) {
      if (agent?.id) upstreamAgentIds.add(agent.id);
    }
  };

  // Every agent id a backend has ever claimed — sticky on purpose. owns() goes
  // false the moment a backend drops, which is exactly when we still need to
  // know the id was never the gateway's to write. Never pruned: an id that was
  // foreign once must not become forwardable just because its backend died.
  const foreignAgentIds = new Set();
  const rememberForeignAgents = (ids) => {
    for (const id of ids) {
      if (id) foreignAgentIds.add(id);
    }
  };

  // Hermes 等本地 backend 可能在 UI 首轮 agents.list 之后才 ready。
  // registry 发出 ready 后，这里广播一个本地事件；新版 UI 收到后会重拉 agents/sessions。
  const onBackendReady = (event) => {
    if (!event || !Array.isArray(event.agentIds) || event.agentIds.length === 0) {
      return;
    }
    rememberForeignAgents(event.agentIds);
    broadcast(
      JSON.stringify({
        type: "event",
        event: "agents.changed",
        payload: event,
      }),
    );
  };
  const federationActivityAgentIds = (event, sessionKey) => {
    if (!Array.isArray(event?.agentIds) || event.agentIds.length === 0
      || event.agentIds.length > 256) return null;
    const agentIds = event.agentIds.filter((agentId) => typeof agentId === "string"
      && agentId.length > 0 && agentId.isWellFormed() && !agentId.includes("\0")
      && Buffer.byteLength(agentId, "utf8") <= 256);
    const targetAgentId = agentIdFromSessionKey(sessionKey);
    const targetBackend = targetAgentId === null ? null : registry?.route(targetAgentId);
    if (targetAgentId === null || !agentIds.includes(targetAgentId)
      || targetBackend?.id !== event.backendId) return null;
    return agentIds;
  };
  const onBackendSessionActivity = (event) => {
    const activity = event?.activity;
    if (!activity) return;
    if (activity.kind === "federation.chat.interaction.reset") {
      if (!isPlainRecord(activity) || Object.keys(activity).length !== 1
        || typeof event.backendId !== "string"
        || registry?.getBackend(event.backendId)?.id !== event.backendId) return;
      const expired = [];
      for (const [key, record] of federationPrompts) {
        if (record.backendId !== event.backendId) continue;
        federationPrompts.delete(key);
        expired.push(record);
      }
      for (const record of expired) {
        broadcastAuthenticated(JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId: record.runId,
            sessionKey: record.sessionKey,
            state: "promptExpire",
            requestId: record.requestId,
          },
        }));
      }
      return;
    }
    if (activity.kind === "federation.chat.interaction.clear") {
      if (!isPlainRecord(activity) || Object.keys(activity).length !== 3
        || typeof activity.runId !== "string" || activity.runId.length === 0
        || !activity.runId.isWellFormed() || activity.runId.includes("\0")
        || Buffer.byteLength(activity.runId, "utf8") > 128
        || typeof activity.sessionKey !== "string" || activity.sessionKey.length === 0
        || !activity.sessionKey.isWellFormed() || activity.sessionKey.includes("\0")
        || Buffer.byteLength(activity.sessionKey, "utf8") > 512
        || federationActivityAgentIds(event, activity.sessionKey) === null) return;
      const forgotten = forgetFederationRunPrompts(
        event.backendId,
        activity.sessionKey,
        activity.runId,
      );
      for (const record of forgotten) {
        broadcastAuthenticated(JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId: record.runId,
            sessionKey: record.sessionKey,
            state: "promptExpire",
            requestId: record.requestId,
          },
        }));
      }
      return;
    }
    if (activity.kind === "federation.chat.interaction") {
      const interaction = activity.interaction;
      if (typeof activity.runId !== "string" || activity.runId.length === 0
        || !activity.runId.isWellFormed() || activity.runId.includes("\0")
        || Buffer.byteLength(activity.runId, "utf8") > 128
        || typeof activity.sessionKey !== "string" || activity.sessionKey.length === 0
        || !activity.sessionKey.isWellFormed() || activity.sessionKey.includes("\0")
        || Buffer.byteLength(activity.sessionKey, "utf8") > 512
        || !isPlainRecord(interaction)
        || Object.keys(interaction).length !== 4
        || !["phase", "eventType", "requestId", "payload"]
          .every((key) => Object.prototype.hasOwnProperty.call(interaction, key))
        || !["requested", "resolved"].includes(interaction.phase)
        || !["approval", "prompt"].includes(interaction.eventType)
        || typeof interaction.requestId !== "string"
        || !SAFE_INTERACTION_ID.test(interaction.requestId)
        || (interaction.phase === "requested"
          && (!isPlainRecord(interaction.payload)
            || interaction.payload.requestId !== interaction.requestId))
        || (interaction.phase === "resolved" && interaction.payload !== null)) return;
      const agentIds = federationActivityAgentIds(event, activity.sessionKey);
      if (agentIds === null) return;
      if (interaction.phase === "requested") {
        let prompt;
        try {
          prompt = normalizeInteractiveRequestV1({
            runId: activity.runId,
            eventType: interaction.eventType,
            payload: interaction.payload,
            expiresAt: interaction.payload.expiresAt ?? null,
          });
        } catch {
          return;
        }
        rememberForeignAgents(agentIds);
        const rosterRaw = JSON.stringify({
          type: "event",
          event: "agents.changed",
          payload: {
            backendId: event.backendId,
            name: typeof event.name === "string" ? event.name : undefined,
            agentIds,
          },
        });
        const promptRaw = JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId: activity.runId,
            sessionKey: activity.sessionKey,
            state: "prompt",
            prompt,
          },
        });
        rememberFederationPrompt({
          backendId: event.backendId,
          sessionKey: activity.sessionKey,
          runId: activity.runId,
          requestId: interaction.requestId,
          rosterRaw,
          promptRaw,
        });
        broadcastAuthenticated(rosterRaw);
        broadcastAuthenticated(promptRaw);
      } else {
        forgetFederationPrompt(
          event.backendId,
          activity.sessionKey,
          activity.runId,
          interaction.requestId,
        );
        broadcastAuthenticated(JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId: activity.runId,
            sessionKey: activity.sessionKey,
            state: "promptExpire",
            requestId: interaction.requestId,
          },
        }));
      }
      return;
    }
    if (activity.kind !== "federation.chat.terminal"
      || typeof activity.runId !== "string" || activity.runId.length === 0
      || !activity.runId.isWellFormed() || activity.runId.includes("\0")
      || Buffer.byteLength(activity.runId, "utf8") > 256
      || typeof activity.sessionKey !== "string" || activity.sessionKey.length === 0
      || !activity.sessionKey.isWellFormed() || activity.sessionKey.includes("\0")
      || Buffer.byteLength(activity.sessionKey, "utf8") > 512
      || !["completed", "failed", "canceled", "interrupted", "skipped"].includes(activity.status)
      || (activity.result !== null && (typeof activity.result !== "string"
        || !activity.result.isWellFormed() || activity.result.includes("\0")
        || Buffer.byteLength(activity.result, "utf8") > 32 * 1024))
      || (activity.errorCode !== null && (typeof activity.errorCode !== "string"
        || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(activity.errorCode)))
      || !Number.isSafeInteger(activity.finishedAt) || activity.finishedAt < 0) return;
    if (federationActivityAgentIds(event, activity.sessionKey) === null) return;
    forgetFederationRunPrompts(event.backendId, activity.sessionKey, activity.runId);
    const payload = {
      runId: activity.runId,
      sessionKey: activity.sessionKey,
      state: activity.status === "completed" ? "final"
        : ["canceled", "interrupted"].includes(activity.status) ? "aborted" : "error",
    };
    if (payload.state === "final") {
      payload.message = {
        role: "assistant",
        content: [{ type: "text", text: activity.result || "" }],
        timestamp: activity.finishedAt,
        ...(activity.notificationCategory === "cron" ? { shoggoth: { source: "cron" } } : {}),
      };
    } else {
      payload.errorMessage = activity.errorCode || "AGENT_OPERATION_FAILED";
    }
    broadcastTerminal(
      JSON.stringify({ type: "event", event: "chat", payload }),
      `${activity.sessionKey}\0${activity.runId}`,
    );
  };
  if (registry && typeof registry.on === "function") {
    registry.on("backend.ready", onBackendReady);
    registry.on("backend.sessionActivity", onBackendSessionActivity);
  }

  wss.on("connection", (client) => {
    if (closing) {
      try { client.terminate(); } catch { /* already closed */ }
      return;
    }
    clients.add(client);
    // No early-close when the gateway is unconfigured/unreachable — the proxy
    // degrades instead (enterDegraded below) so foreign backends keep chatting.

    const injectAgents = () => {
      const agents = registry?.aggregateAgents() ?? getInjectAgents?.() ?? [];
      rememberForeignAgents(agents.map((agent) => agent?.id));
      return agents;
    };
    const owns = (agentId) => {
      if (!agentId) return false;
      // No registry → ownership is unknowable; don't claim it (mirrors the
      // injectAgents fallback above). `registry?.route(id) !== null` would be
      // `undefined !== null` === true here, wrongly owning every agent.
      return registry ? registry.route(agentId) !== null : false;
    };
    // 静态命名空间归属（不随就绪翻转）：一个外籍后端「声称」拥有这个 id 的地盘。
    // owns() 会在启动竞态窗口对自家 agent 误判 false（profileById 未填），claims()
    // 不会 —— 用它防 session-write 漏给上游网关建孤儿、滤上游同名孤儿行。
    const claims = (agentId) => (registry && agentId ? registry.claimsAgentId(agentId) : false);
    // Req ids whose responses we must rewrite (res frames carry no method).
    const listRequestTracker = createProxyListRequestTracker();
    // Coalesce upstream `session.message` events per sessionKey. The UI calls
    // chat.history on every session.message that matches host.sessionKey, and
    // upstream can emit them in rapid bursts (cron progress, background updates),
    // which lands as a chat.history loop that blocks send/reply. One reload per
    // sessionKey per 800ms is plenty for the visible state. Leading edge fires
    // immediately; the last frame of a burst is held and flushed when the window
    // closes (a pure leading-edge throttle silently drops the FINAL message of a
    // burst, leaving the UI on stale history with nothing left to trigger it).
    const SESSION_MESSAGE_COALESCE_MS = 800;
    const lastSessionMessageAt = new Map(); // sessionKey -> ts
    const pendingSessionMessage = new Map(); // sessionKey -> { raw, timer }

    // Device-auth gate for locally-served foreign RPCs. The proxy holds no
    // identity: it learns the handshake settled by watching `connect` succeed
    // (upstream hello-ok, or the local degraded answer when the gateway is down).
    let authed = false;
    const connectReqIds = new Set();

    // Upstream may be absent (no URL / constructor throw) or die later (gateway
    // restart). Either way the CLIENT connection survives: degraded mode answers
    // the device-auth handshake locally and serves list frames from the foreign
    // backends, so one backend's outage never takes down the others (the chat-
    // plane mirror of the registry's fail-soft aggregation). OpenClaw-bound
    // requests get a clean UPSTREAM_DOWN error instead of hanging. A degraded
    // connection retries the gateway every `upstreamRetryMs` and restores full
    // passthrough in place: the fresh gateway opens its own connect.challenge,
    // which we relay so the BROKER re-signs it (proxy holds no identity), and
    // its hello-ok flips us back. `agents.changed` tells the UI to re-pull lists
    // on both the way down and the way back up.
    let upstream = null;
    let upstreamReady = false;
    let upstreamDown = false;
    let reconnecting = false; // degraded + a fresh upstream handshake in flight
    let reconnectTimer = null;
    let reconnectHandshakeTimer = null;
    const backlog = [];
    let cleaned = false;

    const sendToClient = (data) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    };

    const replayFederationPrompts = () => {
      if (!authenticatedClients.has(client) || client.readyState !== WebSocket.OPEN) return;
      const rosterFrames = new Set();
      for (const record of federationPrompts.values()) rosterFrames.add(record.rosterRaw);
      for (const raw of rosterFrames) sendToClient(raw);
      for (const record of federationPrompts.values()) sendToClient(record.promptRaw);
    };

    // Active-run observation is scoped to one browser client. Re-reading the
    // same history replaces that client's watcher only; another browser keeps
    // its own stream. This never calls chat.abort — AbortController cancels the
    // local polling subscription, not the underlying WorkRun.
    const sessionWatchers = new Map();
    const sessionWatcherTasks = new Map();
    const sessionSendObservers = new Map();
    // Prompt cards are transient run state, not ordinary chat history. Keep the
    // latest live card per session so a same-browser session switch/history
    // reload can restore it without cancelling or duplicating the active send
    // observer.
    const livePromptsBySession = new Map();
    const historyWatchGenerations = new Map();
    let historyWatchSequence = 0;
    let clientWatchersClosed = false;

    const createChatHooks = ({ sessionKey, runId, broadcastFinal, promptOwner }) => {
      const chatEvent = (state, payload, terminalRunId = null) => {
        const rawEvent = JSON.stringify({
          type: "event",
          event: "chat",
          payload: { runId, sessionKey, state, ...payload },
        });
        if (state === "final") {
          if (livePromptsBySession.get(sessionKey)?.owner === promptOwner) {
            livePromptsBySession.delete(sessionKey);
          }
          const terminalKey = terminalRunId === null
            ? null : `${sessionKey}\0${terminalRunId}`;
          if (broadcastFinal) broadcastTerminal(rawEvent, terminalKey);
          else deliverTerminal(client, rawEvent, terminalKey);
          return;
        }
        sendToClient(rawEvent);
      };
      const emitMessage = (state, text, meta) =>
        chatEvent(state, {
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: Date.now(),
            ...(meta?.usage ? { usage: meta.usage } : {}),
            ...(meta?.model ? { model: meta.model } : {}),
          },
        }, meta?.runId ?? runId ?? null);
      return {
        delta: (text) => emitMessage("delta", text),
        final: (text, errored, meta) => {
          if (errored === true) chatEvent("error", { errorMessage: text });
          else emitMessage("final", text, meta);
        },
        interim: (text) => emitMessage("interim", text),
        error: (msg) => chatEvent("error", { errorMessage: msg }),
        tool: (data) =>
          sendToClient(
            JSON.stringify({ type: "event", event: "session.tool", payload: { sessionKey, data } }),
          ),
        thinking: (text) => chatEvent("thinking", { thinking: text }),
        plan: (entries) => chatEvent("plan", { plan: entries }),
        status: (data) => chatEvent("status", { statusKind: data?.kind, text: data?.text }),
        prompt: (data) => {
          livePromptsBySession.set(sessionKey, { runId, prompt: data, owner: promptOwner });
          chatEvent("prompt", { prompt: data });
        },
        promptExpire: (data) => {
          const live = livePromptsBySession.get(sessionKey);
          if (live?.owner === promptOwner
            && (!data?.requestId || live.prompt?.requestId === data.requestId)) {
            livePromptsBySession.delete(sessionKey);
          }
          chatEvent("promptExpire", { requestId: data?.requestId });
        },
      };
    };

    const queueSessionWatcher = (backend, sessionKey, generation) => {
      const priorTask = sessionWatcherTasks.get(sessionKey) || Promise.resolve();
      const task = priorTask.catch(() => {}).then(async () => {
        if (clientWatchersClosed
          || historyWatchGenerations.get(sessionKey) !== generation
          || typeof backend?.watchSession !== "function") return;
        const sends = [...(sessionSendObservers.get(sessionKey) || [])];
        // A history refresh may arrive while this SAME browser still owns the
        // live chat.send observer (for example session.message revalidation or
        // a manual refresh). It is a read, not a handoff: cancelling the send
        // observer here strands prompt/tool/delta events until another history
        // load happens. Let the live observer finish, then attach recovery.
        await Promise.allSettled(sends.map((send) => send.promise));
        if (clientWatchersClosed
          || historyWatchGenerations.get(sessionKey) !== generation) return;
        const previous = sessionWatchers.get(sessionKey);
        if (previous) {
          previous.controller.abort();
          await previous.promise.catch(() => {});
        }
        if (clientWatchersClosed
          || historyWatchGenerations.get(sessionKey) !== generation
          || typeof backend?.watchSession !== "function") return;

        const controller = new AbortController();
        const promptOwner = {};
        const hooks = createChatHooks({
          sessionKey, runId: undefined, broadcastFinal: false, promptOwner,
        });
        const entry = { controller, promise: null };
        entry.promise = Promise.resolve()
          .then(() => backend.watchSession(sessionKey, hooks, { signal: controller.signal }))
          .catch((error) => {
            if (!controller.signal.aborted && !clientWatchersClosed) {
              hooks.error(safeWatcherErrorMessage(error));
            }
          })
          .finally(() => {
            if (livePromptsBySession.get(sessionKey)?.owner === promptOwner) {
              livePromptsBySession.delete(sessionKey);
            }
            if (sessionWatchers.get(sessionKey) === entry) sessionWatchers.delete(sessionKey);
            if (historyWatchGenerations.get(sessionKey) === generation) {
              historyWatchGenerations.delete(sessionKey);
            }
          });
        sessionWatchers.set(sessionKey, entry);
      });
      sessionWatcherTasks.set(sessionKey, task);
      task.finally(() => {
        if (sessionWatcherTasks.get(sessionKey) === task) sessionWatcherTasks.delete(sessionKey);
      });
    };

    const startSendObserver = (
      backend, sessionKey, message, runId, hooks, promptOwner, attachments, inputProvenance,
    ) => {
      // A new send takes over this client's session stream. Invalidate queued
      // history watchers and locally cancel/await any previous send observer;
      // neither operation calls backend.abortChat or changes the WorkRun.
      const nextGeneration = ++historyWatchSequence;
      livePromptsBySession.delete(sessionKey);
      historyWatchGenerations.set(sessionKey, nextGeneration);
      const previousSends = [...(sessionSendObservers.get(sessionKey) || [])];
      // Snapshot only work that existed before this send. A chat.history that
      // arrives after chat.send must be allowed to wait for this observer; if
      // we looked the task up later both sides could await each other.
      const previousWatcherTask = sessionWatcherTasks.get(sessionKey);
      const previousWatcher = sessionWatchers.get(sessionKey);
      const controller = new AbortController();
      const entry = { controller, promise: null };
      const entries = sessionSendObservers.get(sessionKey) || new Set();
      entries.add(entry);
      sessionSendObservers.set(sessionKey, entries);
      entry.promise = Promise.resolve().then(async () => {
        for (const previous of previousSends) previous.controller.abort();
        await Promise.allSettled(previousSends.map((previous) => previous.promise));
        if (previousWatcherTask) await previousWatcherTask.catch(() => {});
        if (previousWatcher) {
          previousWatcher.controller.abort();
          await previousWatcher.promise.catch(() => {});
        }
        if (historyWatchGenerations.get(sessionKey) === nextGeneration) {
          historyWatchGenerations.delete(sessionKey);
        }
        if (controller.signal.aborted || clientWatchersClosed) return;
        await backend.sendMessage(
          sessionKey,
          message,
          runId,
          hooks,
          { attachments, inputProvenance, signal: controller.signal },
        );
      }).catch((error) => {
        if (!controller.signal.aborted && !clientWatchersClosed) {
          hooks.error(error && error.message ? error.message : String(error));
        }
      }).finally(() => {
        if (livePromptsBySession.get(sessionKey)?.owner === promptOwner) {
          livePromptsBySession.delete(sessionKey);
        }
        entries.delete(entry);
        if (entries.size === 0 && sessionSendObservers.get(sessionKey) === entries) {
          sessionSendObservers.delete(sessionKey);
        }
        if (historyWatchGenerations.get(sessionKey) === nextGeneration) {
          historyWatchGenerations.delete(sessionKey);
        }
      });
      return entry.promise;
    };

    const stopClientWatchers = () => {
      if (clientWatchersClosed) return;
      clientWatchersClosed = true;
      for (const watcher of sessionWatchers.values()) watcher.controller.abort();
      for (const sends of sessionSendObservers.values()) {
        for (const send of sends) send.controller.abort();
      }
      historyWatchGenerations.clear();
      livePromptsBySession.clear();
    };

    // Degraded-mode answers. Foreign-owned RPCs never reach here (the client
    // message handler serves them locally and returns); this covers only the
    // frames that would otherwise need the gateway.
    // A foreign RPC arrived before the device-auth handshake settled.
    const denyUnauthed = (id) => {
      sendToClient(
        JSON.stringify({
          type: "res",
          id,
          ok: false,
          error: { code: "UNAUTHORIZED", message: "未完成 device-auth 握手" },
        }),
      );
    };

    const answerDegraded = (raw) => {
      const frame = safeParse(raw);
      if (!frame || frame.type !== "req") return; // non-req frames have no reply path
      // 这次请求不会再收到上游响应，必须在本地答复前释放 list 跟踪记录。
      listRequestTracker.forget(frame.id);
      // 上游 URL 空 = OpenClaw 被禁用/未配置（只连 Hermes 的正常形态，或用户在设置页
      // 主动「断开连接」）；配了 URL 但连不上，才是真正的「不可达」。下面的缺席上报与
      // 兜底错误文案都按它分叉。
      const upstreamConfigured = !!(getUpstreamUrl?.() || "").trim();
      if (frame.method === "connect") {
        // Stand in for the gateway's hello-ok so the broker's handshake settles.
        // We can't verify the signature (no identity here), so this trusts the
        // socket — acceptable only because inbound Origin is already loopback-gated
        // and a local process that can sign could read the identity off disk anyway.
        authed = true;
        authenticatedClients.add(client);
        sendToClient(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { degraded: true } }));
        replayFederationPrompts();
        return;
      }
      if (frame.method === "agents.list") {
        sendToClient(
          JSON.stringify(
            injectIntoAgentsList({ type: "res", id: frame.id, ok: true, payload: { agents: [] } }, injectAgents()),
          ),
        );
        return;
      }
      if (frame.method === "models.list") {
        const agentIdParam = typeof frame.params?.agentId === "string" ? frame.params.agentId : undefined;
        let choices = [];
        if (!agentIdParam) choices = registry?.aggregateModels() ?? [];
        else {
          const backend = registry?.route(agentIdParam);
          if (backend?.getModelChoices) {
            try { choices = backend.getModelChoices() ?? []; } catch { choices = []; }
          }
        }
        sendToClient(
          JSON.stringify(
            injectIntoModelsList({ type: "res", id: frame.id, ok: true, payload: { models: [] } }, choices),
          ),
        );
        return;
      }
      if (frame.method === "sessions.list") {
        const agentIdParam = typeof frame.params?.agentId === "string" ? frame.params.agentId : undefined;
        let snapshot = { rows: [], incompleteBackends: [] };
        if (!agentIdParam) snapshot = readRegistrySessionSnapshot(registry);
        else if (registry?.route(agentIdParam)) snapshot = readRegistrySessionSnapshot(registry, { agentId: agentIdParam });
        // 这份列表是本地合成的：上游不可达时 OpenClaw 的会话行**整段缺席**。据实报出缺席
        // 名单，UI 才能保留那些行的上一份快照——否则网关一重启 agent 整组蒸发，连
        // localStorage 缓存都被这份残缺列表覆盖（重开 app 也看不到）。主动断开时
        // upstreamConfigured 为假：那是明确意图，不报缺席，列表照旧塌掉。
        const payload = { sessions: [] };
        if (upstreamConfigured) payload.degradedBackends = ["openclaw"];
        const marked = markIncompleteSessionBackends(
          { type: "res", id: frame.id, ok: true, payload },
          snapshot.incompleteBackends,
        );
        sendToClient(JSON.stringify(injectIntoSessionsList(marked, snapshot.rows)));
        return;
      }
      // 兜底：目标既不属于任何活跃后端、又需要上游。未配置上游时绝不点 OpenClaw 的名，
      // 给中性「后端未就绪」；配了 URL 但连不上，才是真正的「OpenClaw gateway 不可达」。
      sendToClient(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: upstreamConfigured
            ? { code: "UPSTREAM_DOWN", message: "OpenClaw gateway 不可达（其它后端仍可用）" }
            : { code: "BACKEND_NOT_READY", message: "目标后端尚未就绪，请稍后重试" },
        }),
      );
    };

    // Topology changed (gateway went away / came back) — the UI re-pulls its
    // lists on this event, so degraded entry/exit reflects without a reload.
    const notifyAgentsChanged = () => {
      sendToClient(
        JSON.stringify({ type: "event", event: "agents.changed", payload: { backendId: "openclaw" } }),
      );
    };

    const enterDegraded = () => {
      if (upstreamDown) return;
      upstreamDown = true;
      // The gateway normally OPENS the handshake; without one the broker sits on
      // its connect timeout and kills the browser socket. Synthesize the challenge
      // ourselves — an already-authed broker re-answers it, which is harmlessly
      // idempotent (its `connect` gets an ok from answerDegraded).
      sendToClient(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: `degraded-${Date.now().toString(36)}` },
        }),
      );
      while (backlog.length) answerDegraded(backlog.shift());
      notifyAgentsChanged();
    };

    const sendToUpstream = (data) => {
      const frame = safeParse(data.toString());
      let leaveAdmission = null;
      if (frame?.type === "req" && OPENCLAW_START_RPC_METHOD_SET.has(frame.method) && workAdmissionGate) {
        try {
          leaveAdmission = workAdmissionGate.enter("openclaw", frame.method);
        } catch (error) {
          if (error?.code === "gateway_draining") {
            sendToClient(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "GATEWAY_DRAINING", message: error.message },
            }));
            return;
          }
          sendToClient(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "ADMISSION_ERROR", message: "工作入口检查失败" },
          }));
          return;
        }
      }
      try {
        if (upstreamDown) {
          // During a recovery handshake the broker's re-signed `connect` must reach
          // the FRESH gateway, not the local degraded answerer.
          if (reconnecting && upstream && upstream.readyState === WebSocket.OPEN) {
            if (frame && frame.type === "req" && frame.method === "connect") {
              upstream.send(data);
              return;
            }
          }
          answerDegraded(data);
        } else if (upstreamReady && upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(data);
        } else {
          backlog.push(data);
        }
      } finally {
        // admission 只覆盖一次转发动作，完整任务生命周期由 runtime tasks.list 判断。
        leaveAdmission?.();
      }
    };

    // 清除当前恢复握手 deadline；成功、失败、close 三条路径共用。
    const clearReconnectHandshakeDeadline = () => {
      if (!reconnectHandshakeTimer) return;
      clearTimeout(reconnectHandshakeTimer);
      reconnectHandshakeTimer = null;
    };

    const onUpstreamGone = () => {
      clearReconnectHandshakeDeadline();
      upstream = null;
      upstreamReady = false;
      reconnecting = false;
      if (closing || cleaned) return;
      enterDegraded();
      scheduleUpstreamRetry();
    };

    const scheduleUpstreamRetry = () => {
      if (closing || cleaned || reconnectTimer || client.readyState !== WebSocket.OPEN) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (closing || cleaned || client.readyState !== WebSocket.OPEN || !upstreamDown) return;
        const sock = connectUpstream();
        if (!sock) {
          scheduleUpstreamRetry();
          return;
        }
        upstream = sock;
        reconnecting = true;
        clearReconnectHandshakeDeadline();
        reconnectHandshakeTimer = setTimeout(() => {
          if (sock !== upstream || !reconnecting) return;
          // 上游 TCP 已连通但始终不发 challenge/hello-ok：主动放弃并重试，
          // 不能让 reconnecting 永久占住这个浏览器连接。
          reconnectHandshakeTimer = null;
          upstream = null;
          upstreamReady = false;
          reconnecting = false;
          try { sock.terminate(); } catch { /* 已关闭 */ }
          scheduleUpstreamRetry();
        }, Math.max(10, Number(upstreamHandshakeTimeoutMs) || 8000));
        if (typeof reconnectHandshakeTimer.unref === "function") reconnectHandshakeTimer.unref();
      }, upstreamRetryMs);
    };

    // Build an upstream socket with the full handler set. Stale sockets (replaced
    // by a retry) are ignored via the `sock !== upstream` guard.
    const connectUpstream = () => {
      if (closing || cleaned) return null;
      const url = (getUpstreamUrl?.() || "").trim();
      if (!url) return null;
      let sock;
      try {
        sock = new WebSocket(url, origin ? { headers: { Origin: origin } } : undefined);
      } catch {
        return null;
      }
      sock.on("open", () => {
        if (sock !== upstream) return;
        upstreamReady = true;
        while (backlog.length) {
          // 排队后才开始 drain 的启动请求必须在真正转发时重新过 gate，不能绕过关闭窗口。
          sendToUpstream(backlog.shift());
        }
      });
      sock.on("message", (data) => {
        if (sock !== upstream) return;
        const raw = data.toString();
        if (reconnecting) {
          const frame = safeParse(raw);
          if (frame && frame.type === "res" && frame.id === "broker-connect") {
            if (frame.ok) {
              // Handshake settled — back to full passthrough. The relayed
              // hello-ok is idempotent for an already-ready broker.
              reconnecting = false;
              upstreamDown = false;
              clearReconnectHandshakeDeadline();
              sendToClient(raw);
              notifyAgentsChanged();
            } else {
              reconnecting = false;
              clearReconnectHandshakeDeadline();
              try {
                sock.close();
              } catch {
                /* ignore */
              }
            }
            return;
          }
          // Relay the fresh gateway's challenge (and any interim frames) so the
          // broker can re-sign; everything else stays degraded meanwhile.
          sendToClient(raw);
          return;
        }
        handleUpstreamMessage(raw);
      });
      sock.on("close", () => {
        if (sock === upstream) onUpstreamGone();
      });
      sock.on("error", () => {
        if (sock === upstream) onUpstreamGone();
      });
      return sock;
    };

    upstream = connectUpstream();
    if (!upstream) onUpstreamGone();

    // External inspiration Sessions retain their upstream keys and OpenClaw
    // ownership stays unchanged. Resolve their durable binding before the
    // ordinary owns()/passthrough routing, including replies and cancellation.
    const interceptExternalInspirationChat = async (frame) => {
      if (!["chat.history", "chat.send", "chat.respond", "chat.abort"].includes(frame.method)
        || registry?.hasExternalInspirationSessionBridge?.() !== true) return false;
      const sessionKey = frame.params?.sessionKey;
      const agentId = agentIdFromSessionKey(sessionKey);
      if (!agentId) return false;
      const owner = registry.route(agentId);
      const backendId = owner?.id === "hermes" ? "hermes"
        : owner === null && !claims(agentId) ? "openclaw" : null;
      if (!backendId) return false;
      if (!authed) { denyUnauthed(frame.id); return true; }
      try {
        const backend = await registry.getExternalInspirationSessionRoute({ backendId, agentId, sessionKey });
        if (!backend) return false;
        if (clientWatchersClosed) return true;
        if (frame.method === "chat.history") {
          if (!historyWatchGenerations.has(sessionKey)
            && historyWatchGenerations.size >= MAX_CLIENT_HISTORY_WATCHES) {
            sendToClient(JSON.stringify({ type: "res", id: frame.id, ok: false,
              error: { code: "BACKEND_BUSY", message: "活动会话恢复请求过多，请稍后重试" } }));
            return true;
          }
          const watchGeneration = ++historyWatchSequence;
          historyWatchGenerations.set(sessionKey, watchGeneration);
          try {
            const actualBackend = registry.getBackend(backendId);
            const payload = backendId === "hermes" && typeof actualBackend?.getHistory === "function"
              ? await actualBackend.getHistory(sessionKey)
              : backendId === "openclaw" && typeof actualBackend?.request === "function"
                ? await actualBackend.request("chat.history", frame.params, 15_000)
                : await Promise.reject(new Error("External Session history unavailable"));
            const displayed = typeof backend.projectHistory === "function" ? await backend.projectHistory(payload) : payload;
            sendToClient(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: displayed }));
            const livePrompt = livePromptsBySession.get(sessionKey);
            if (livePrompt) sendToClient(JSON.stringify({ type: "event", event: "chat", payload: {
              runId: livePrompt.runId, sessionKey, state: "prompt", prompt: livePrompt.prompt,
            } }));
            queueSessionWatcher(backend, sessionKey, watchGeneration);
          } catch (error) {
            if (historyWatchGenerations.get(sessionKey) === watchGeneration) historyWatchGenerations.delete(sessionKey);
            throw error;
          }
        } else if (frame.method === "chat.send") {
          const attachments = frame.params?.attachments;
          if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 0)) {
            const error = new Error("灵感会话暂不支持附件");
            error.code = "INSPIRATION_UNSUPPORTED";
            throw error;
          }
          let leaveAdmission = workAdmissionGate?.enter(backendId, "chat.send");
          const release = () => { const leave = leaveAdmission; leaveAdmission = null; leave?.(); };
          const runId = frame.params?.idempotencyKey ?? frame.params?.runId;
          const promptOwner = {};
          const hooks = createChatHooks({ sessionKey, runId, broadcastFinal: true, promptOwner });
          sendToClient(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "started" } }));
          const observerBackend = { sendMessage: (key, message, clientRunId, observerHooks, opts) =>
            backend.sendMessage(key, message, clientRunId, observerHooks, { ...opts, onAccepted: release }) };
          startSendObserver(observerBackend, sessionKey, String(frame.params?.message ?? ""), runId,
            hooks, promptOwner, undefined,
            normalizeFederationInputProvenance(frame.params?.systemInputProvenance)).finally(release);
        } else {
          let payload;
          if (frame.method === "chat.abort") payload = await backend.abortChat(sessionKey);
          else {
            payload = await backend.respondChatPrompt(sessionKey, frame.params || {});
            if (livePromptsBySession.get(sessionKey)?.prompt?.requestId === frame.params?.requestId) {
              livePromptsBySession.delete(sessionKey);
            }
          }
          sendToClient(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: payload || {} }));
        }
      } catch (error) {
        // A failed binding lookup cannot safely become a second raw chat.send.
        sendToClient(JSON.stringify({ type: "res", id: frame.id, ok: false, error: {
          code: error?.code === "gateway_draining" ? "GATEWAY_DRAINING"
            : typeof error?.code === "string" && /^INSPIRATION_[A-Z_]+$/.test(error.code)
              ? error.code : "INSPIRATION_UNAVAILABLE",
          message: error?.code === "gateway_draining" ? error.message
            : "灵感会话操作暂不可用，请查看灵感的执行状态后重试",
        } }));
      }
      return true;
    };

    // UI -> gateway
    client.on("message", async (data) => {
      const raw = data.toString();
      const frame = safeParse(raw);
      if (frame && frame.type === "req") {
        // Foreign RPCs are answered locally, bypassing the gateway's auth. Refuse
        // them until `connect` has succeeded, else anyone able to open this socket
        // could drive a Hermes agent (tools included) with no credentials at all.
        if (!authed && FOREIGN_ROUTED_METHODS.has(frame.method)) {
          // Use static namespace ownership, not live readiness: during startup
          // ownsAgentId() is intentionally false, but an unauthenticated caller
          // must not learn or drive that backend through a weaker path.
          if (targetAgentIdsOf(frame).some((agentId) => claims(agentId))) {
            denyUnauthed(frame.id);
            return; // never forward a foreign frame upstream
          }
        }
        if (registry?.hasExternalInspirationSessionBridge?.() === true
          && await interceptExternalInspirationChat(frame)) return;
        if (frame.method === "connect") {
          connectReqIds.add(frame.id);
        } else if (
          frame.method === "agents.list" ||
          frame.method === "models.list" ||
          frame.method === "sessions.list"
        ) {
          listRequestTracker.track(frame);
        } else if (frame.method === "chat.history") {
          const sessionKey = frame.params?.sessionKey;
          const agentId = agentIdFromSessionKey(sessionKey);
          const backend = owns(agentId) ? registry?.route(agentId) : null;
          if (backend?.getHistory) {
            if (!historyWatchGenerations.has(sessionKey)
              && historyWatchGenerations.size >= MAX_CLIENT_HISTORY_WATCHES) {
              sendToClient(JSON.stringify({
                type: "res",
                id: frame.id,
                ok: false,
                error: { code: "BACKEND_BUSY", message: "活动会话恢复请求过多，请稍后重试" },
              }));
              return;
            }
            const watchGeneration = ++historyWatchSequence;
            historyWatchGenerations.set(sessionKey, watchGeneration);
            // getHistory is async — historical sessions hit the backend
            // for messages on first access. Don't forward upstream either way.
            Promise.resolve()
              .then(() => backend.getHistory(sessionKey))
              .then((payload) => {
                sendToClient(
                  JSON.stringify({ type: "res", id: frame.id, ok: true, payload }),
                );
                const livePrompt = livePromptsBySession.get(sessionKey);
                if (livePrompt) {
                  sendToClient(JSON.stringify({
                    type: "event",
                    event: "chat",
                    payload: {
                      runId: livePrompt.runId,
                      sessionKey,
                      state: "prompt",
                      prompt: livePrompt.prompt,
                    },
                  }));
                }
                // The successful history frame is queued first. Observer
                // discovery/stream errors are isolated to later chat events.
                if (typeof backend.watchSession === "function") {
                  queueSessionWatcher(backend, sessionKey, watchGeneration);
                } else if (historyWatchGenerations.get(sessionKey) === watchGeneration) {
                  historyWatchGenerations.delete(sessionKey);
                }
              })
              .catch((err) => {
                if (historyWatchGenerations.get(sessionKey) === watchGeneration) {
                  historyWatchGenerations.delete(sessionKey);
                }
                sendToClient(
                  JSON.stringify({
                    type: "res",
                    id: frame.id,
                    ok: false,
                      error: { code: "BACKEND_ERROR", message: err?.message || String(err) },
                    }),
                );
              });
            return;
          }
        } else if (frame.method === "chat.send") {
          const sessionKey = frame.params?.sessionKey;
          const agentId = agentIdFromSessionKey(sessionKey);
          if (owns(agentId)) {
            const backend = registry?.route(agentId);
            const message = String(frame.params?.message ?? "");
            // Image attachments ride chat.send verbatim (base64 wire shape);
            // the backend converts/refuses — never silently dropped here.
            const attachments = Array.isArray(frame.params?.attachments)
              ? frame.params.attachments
              : undefined;
            // requestChatSend passes the client-generated UUID as
            // `idempotencyKey` (controllers/chat.ts:429), not `runId`. We need
            // it to echo on emitted `chat` events so the UI matches them to
            // its active chatRunId.
            const idempotencyKey = frame.params?.idempotencyKey ?? frame.params?.runId;
            const inputProvenance = normalizeFederationInputProvenance(
              frame.params?.systemInputProvenance,
            );
            sendToClient(
              JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "started" } }),
            );
            if (backend?.sendMessage) {
              const promptOwner = {};
              const hooks = createChatHooks({
                sessionKey,
                runId: idempotencyKey,
                broadcastFinal: true,
                promptOwner,
              });
              startSendObserver(
                backend,
                sessionKey,
                message,
                idempotencyKey,
                hooks,
                promptOwner,
                attachments,
                inputProvenance,
              );
            }
            return; // do NOT forward
          }
        } else if (
          frame.method === "chat.abort" ||
          frame.method === "chat.respond" ||
          frame.method === "sessions.patch" ||
          frame.method === "sessions.delete" ||
          frame.method === "sessions.compact"
        ) {
          // Session ops on a foreign (e.g. Hermes) session must NOT reach the
          // OpenClaw gateway — it doesn't own these keys, so forwarding either
          // errors confusingly or pollutes its session store. Route to the
          // owning backend (rename/delete/abort are real Hermes APIs now);
          // anything the backend can't do comes back as a clean error frame.
          const key = frame.params?.sessionKey ?? frame.params?.key;
          const agentId = agentIdFromSessionKey(key);
          if (owns(agentId)) {
            const backend = registry?.route(agentId);
            const run = async () => {
              if (frame.method === "chat.abort") {
                await backend?.abortChat?.(key);
                return {};
              }
              if (frame.method === "chat.respond") {
                // Answer a blocking agent prompt (approval/clarify/sudo/secret)
                // surfaced by the `chat` state:"prompt" event.
                if (!backend?.respondChatPrompt) throw new Error("该后端不支持回应 agent 请求");
                const hasAnswers = Object.prototype.hasOwnProperty.call(frame.params || {}, "answers");
                if (hasAnswers && !isPlainRecord(frame.params.answers)) {
                  throw new Error("answers 必须是普通对象");
                }
                const result = (await backend.respondChatPrompt(key, {
                  kind: frame.params?.kind,
                  requestId: frame.params?.requestId,
                  choice: frame.params?.choice,
                  all: frame.params?.all,
                  value: frame.params?.value,
                  action: frame.params?.action,
                  ...(hasAnswers ? { answers: frame.params.answers } : {}),
                })) ?? {};
                const livePrompt = livePromptsBySession.get(key);
                if (!frame.params?.requestId
                  || livePrompt?.prompt?.requestId === frame.params.requestId) {
                  livePromptsBySession.delete(key);
                }
                return result;
              }
              if (frame.method === "sessions.delete") {
                if (!backend?.deleteSession) throw new Error("该后端不支持删除会话");
                await backend.deleteSession(key);
                return {};
              }
              if (frame.method === "sessions.compact") {
                // /compact on a foreign session → the backend's own compressor
                // (Hermes session.compress). Echo the gateway's {result:{…}}
                // envelope; tokenLine/headline are display hints.
                if (!backend?.compactSession) throw new Error("该后端不支持压缩会话");
                const r = await backend.compactSession(key);
                return { result: { headline: r?.headline, tokenLine: r?.tokenLine } };
              }
              // sessions.patch on a foreign session: {label} → rename,
              // {model} → switch model, {thinkingLevel} → reasoning effort,
              // {fastMode} → fast toggle, {permissionMode} → next-turn permission mode.
              // Anything else → refuse.
              const patchKeys = Object.keys(frame.params || {}).filter((k) => k !== "key");
              if (patchKeys.length === 1 && patchKeys[0] === "label") {
                if (!backend?.renameSession) throw new Error("该后端不支持重命名会话");
                await backend.renameSession(key, frame.params.label);
                return {};
              }
              if (patchKeys.length === 1 && patchKeys[0] === "thinkingLevel") {
                if (!backend?.setSessionThinking) throw new Error("该后端不支持设置思考档");
                const r = await backend.setSessionThinking(key, { level: frame.params.thinkingLevel });
                return { entry: { thinkingLevel: r?.level }, scope: r?.scope };
              }
              if (patchKeys.length === 1 && patchKeys[0] === "fastMode") {
                if (!backend?.setSessionFast) throw new Error("该后端不支持快速模式");
                const r = await backend.setSessionFast(key, { fast: frame.params.fastMode === true });
                return { entry: {}, scope: r?.scope };
              }
              if (patchKeys.length === 1 && patchKeys[0] === "permissionMode") {
                if (!backend?.setSessionPermission) throw new Error("该后端不支持设置权限模式");
                const r = await backend.setSessionPermission(key, { mode: frame.params.permissionMode });
                return { entry: { permissionMode: r?.mode }, scope: r?.scope };
              }
              const modelPatchKeys = new Set(["model", "modelProvider", "acpProviderRef"]);
              if (patchKeys.includes("model") && patchKeys.every((k) => modelPatchKeys.has(k))) {
                // Model switching used to be sent as a `/model …` chat message
                // for Hermes, which needs a live session — so an agent whose
                // model config was broken could never be fixed from the UI (its
                // sends died before the command landed). It is a session
                // property like any other now, and rides the same patch the
                // gateway's own sessions use.
                if (!backend?.setSessionModel) throw new Error("该后端不支持切换会话模型");
                // `model` is always the raw id. Never infer provider from `/`:
                // valid model ids use that character too, and an absent provider
                // deliberately means "inherit the session/profile provider".
                const model = String(frame.params.model ?? "").trim();
                const provider = String(frame.params.modelProvider ?? "").trim();
                const acpProviderRef = String(frame.params.acpProviderRef ?? "").trim();
                const res = await backend.setSessionModel(key, {
                  model,
                  provider,
                  ...(acpProviderRef ? { acpProviderRef } : {}),
                });
                // Echo the gateway's patch shape so the chat UI's shared
                // response handler needs no per-backend branch.
                return {
                  resolved: { model: res?.model ?? model, modelProvider: provider || undefined },
                  entry: {},
                  scope: res?.scope,
                  warning: res?.warning,
                };
              }
              throw new Error(`该后端的会话不支持设置 ${patchKeys.join("/") || "(空)"}`);
            };
            run()
              .then((payload) =>
                sendToClient(JSON.stringify({ type: "res", id: frame.id, ok: true, payload })),
              )
              .catch((err) =>
                sendToClient(
                  JSON.stringify({
                    type: "res",
                    id: frame.id,
                    ok: false,
                    error: { code: "BACKEND_ERROR", message: err?.message || String(err) },
                  }),
                ),
              );
            return; // do NOT forward
          }
        } else if (frame.method === "sessions.create") {
          // UI's "+ New chat" sends sessions.create with {agentId, parentSessionKey,...}.
          // For Hermes agents, upstream OpenClaw rejects with "unknown parent
          // session" since it doesn't know hermes-* sessions. Mint locally.
          const explicitAgentId = frame.params?.agentId;
          const parentAgentId = agentIdFromSessionKey(frame.params?.parentSessionKey);
          if (typeof explicitAgentId === "string" && parentAgentId
            && explicitAgentId !== parentAgentId
            && (claims(explicitAgentId) || claims(parentAgentId))) {
            sendToClient(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: {
                code: "BACKEND_ROUTE_CONFLICT",
                message: "agentId 与 parentSessionKey 属于不同后端",
              },
            }));
            return;
          }
          const targetAgentId = typeof explicitAgentId === "string"
            ? (owns(explicitAgentId) ? explicitAgentId : null)
            : (owns(parentAgentId) ? parentAgentId : null);
          const createBackend = targetAgentId ? registry?.route(targetAgentId) : null;
          if (createBackend?.createSession) {
            // Shoggoth creates a durable Service session asynchronously; Hermes
            // may persist through another transport. Normalize both contracts
            // and forward backend-neutral model hints before publishing the key.
            Promise.resolve()
              .then(() => createBackend.createSession(targetAgentId, {
                model: frame.params?.model,
                provider: frame.params?.modelProvider,
                acpProviderRef: frame.params?.acpProviderRef,
                workspace: frame.params?.workspace,
                parentSessionKey: frame.params?.parentSessionKey,
              }))
              .then((newKey) => {
                if (typeof newKey !== "string" || !newKey) {
                  throw new Error("后端未返回有效的新会话 key");
                }
                sendToClient(
                  JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { key: newKey } }),
                );
              })
              .catch((err) =>
                sendToClient(
                  JSON.stringify({
                    type: "res",
                    id: frame.id,
                    ok: false,
                    error: { code: "BACKEND_ERROR", message: err?.message || String(err) },
                  }),
                ),
              );
            return; // do NOT forward
          }
        }

        // Last gate before the wire: every RPC in a statically foreign namespace
        // stays local even while its backend is starting. Writes would otherwise
        // mint OpenClaw orphan stores; reads/respond/compact would still cross a
        // backend boundary and expose a misleading upstream result.
        if (FOREIGN_ROUTED_METHODS.has(frame.method)) {
          const targetId = targetAgentIdsOf(frame).find((agentId) => claims(agentId));
          if (targetId) {
            sendToClient(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: false,
                error: {
                  code: "BACKEND_NOT_READY",
                  message: `目标后端尚未就绪，已拦下对「${targetId}」的操作（稍后重试）`,
                },
              }),
            );
            return;
          }
        }

        // Compatibility guard for dynamic-only foreign ids whose backend does
        // not expose a static claimsAgentId namespace.
        if (SESSION_WRITE_METHODS.has(frame.method)) {
          const targetId = targetAgentIdsOf(frame).find(
            (agentId) => foreignAgentIds.has(agentId) && !upstreamAgentIds.has(agentId),
          );
          // 非命名空间归属的兜底（保留旧语义）：gateway roster 还没追上的新建
          // upstream agent 可转发，upstream 认领了同名则让步，归属可无重启迁移。
          if (targetId) {
            sendToClient(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: false,
                error: {
                  code: "UNKNOWN_AGENT",
                  message: `网关不认识 agent「${targetId}」，已拦下该操作（对应后端当前不可用）`,
                },
              }),
            );
            return; // do NOT forward
          }
        }
      }
      sendToUpstream(adaptModelHintsForOpenClaw(frame, raw));
    });

    // gateway -> UI (rewrite agents.list + sessions.list responses; rest verbatim).
    // Bound per-socket inside connectUpstream so a rebuilt upstream keeps the
    // same injection behavior.
    function handleUpstreamMessage(raw) {
      const frame = safeParse(raw);
      let replayPromptsAfterSend = false;
      if (frame && frame.type === "res" && connectReqIds.has(frame.id)) {
        // The gateway accepted the handshake → foreign RPCs may be served locally.
        // A live gateway can still reject the initial auth (notably a fresh
        // OpenClaw token-mode install with only an ephemeral runtime token).
        // Never relay that failure to ChatBroker: it would close the one browser
        // socket and hide every healthy native backend. Drop only this upstream,
        // synthesize a fresh local challenge, and keep the client in degraded mode.
        connectReqIds.delete(frame.id);
        if (frame.ok) {
          authed = true;
          authenticatedClients.add(client);
          replayPromptsAfterSend = true;
        } else {
          const rejectedUpstream = upstream;
          upstream = null;
          upstreamReady = false;
          enterDegraded();
          scheduleUpstreamRetry();
          try { rejectedUpstream?.close(); } catch { /* already closed */ }
          return;
        }
      }
      if (frame && frame.type === "res" && listRequestTracker.takeAgents(frame.id)) {
        rememberUpstreamAgents(frame);
        // claims 过滤：上游返回的 hermes-* agent（孤儿泄漏）从 roster 里滤掉，
        // 只保留 Hermes 就绪后注入的那份。
        sendToClient(JSON.stringify(injectIntoAgentsList(frame, injectAgents(), claims)));
        return;
      }
      const modelsMeta = frame?.type === "res"
        ? listRequestTracker.takeModels(frame.id)
        : { tracked: false };
      if (frame && frame.type === "res" && modelsMeta.tracked) {
        let choices = [];
        if (!modelsMeta.agentId) choices = registry?.aggregateModels() ?? [];
        else {
          const backend = registry?.route(modelsMeta.agentId);
          if (backend?.getModelChoices) {
            try { choices = backend.getModelChoices() ?? []; } catch { choices = []; }
          }
        }
        sendToClient(JSON.stringify(injectIntoModelsList(frame, choices)));
        return;
      }
      const sessionsMeta = frame?.type === "res"
        ? listRequestTracker.takeSessions(frame.id)
        : { tracked: false };
      if (frame && frame.type === "res" && sessionsMeta.tracked) {
        // Conditional injection:
        //   - no agentId: global list → inject all foreign rows.
        //   - agentId belongs to a foreign backend: inject only THAT backend's rows.
        //   - agentId is an OpenClaw agent: inject nothing — don't pollute the
        //     scoped response (the UI hard-replaces sessionsResult with it).
        let snapshot = { rows: [], incompleteBackends: [] };
        if (!sessionsMeta.agentId) {
          snapshot = readRegistrySessionSnapshot(registry);
        } else if (registry?.route(sessionsMeta.agentId)) {
          snapshot = readRegistrySessionSnapshot(registry, { agentId: sessionsMeta.agentId });
        }
        // claims 过滤：上游返回的 agent:hermes-*:… 孤儿 session 从列表里滤掉，
        // 免得 hermes-default 行在 Hermes 就绪前提前进 roster、缓存降级能力。
        const marked = markIncompleteSessionBackends(frame, snapshot.incompleteBackends);
        sendToClient(JSON.stringify(injectIntoSessionsList(marked, snapshot.rows, claims)));
        return;
      }
      if (frame && frame.type === "event" && frame.event === "session.message") {
        const sk = frame.payload?.sessionKey;
        if (typeof sk === "string" && sk) {
          const now = Date.now();
          const lastAt = lastSessionMessageAt.get(sk) ?? 0;
          const waited = now - lastAt;
          const held = pendingSessionMessage.get(sk);
          if (held?.timer) clearTimeout(held.timer);
          if (waited < SESSION_MESSAGE_COALESCE_MS) {
            // Inside the window: hold the LATEST frame and flush it when the
            // window closes. Dropping it would strand the UI on stale history —
            // nothing else re-triggers a reload once the burst ends.
            const timer = setTimeout(() => {
              const queued = pendingSessionMessage.get(sk);
              pendingSessionMessage.delete(sk);
              if (!queued) return;
              lastSessionMessageAt.set(sk, Date.now());
              sendToClient(queued.raw);
            }, SESSION_MESSAGE_COALESCE_MS - waited);
            if (typeof timer.unref === "function") timer.unref();
            pendingSessionMessage.set(sk, { raw, timer });
            return;
          }
          // Leading edge: emit now and supersede anything queued.
          pendingSessionMessage.delete(sk);
          lastSessionMessageAt.set(sk, now);
        }
      }
      sendToClient(raw);
      if (replayPromptsAfterSend) replayFederationPrompts();
    }

    const releaseConnection = (forceUpstream = false) => {
      if (cleaned) {
        if (forceUpstream) {
          try { upstream?.terminate(); } catch { /* already closed */ }
        }
        return;
      }
      cleaned = true;
      clients.delete(client);
      stopClientWatchers();
      connectionShutdowns.delete(shutdownConnection);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearReconnectHandshakeDeadline();
      listRequestTracker.clear();
      connectReqIds.clear();
      for (const held of pendingSessionMessage.values()) clearTimeout(held.timer);
      pendingSessionMessage.clear();
      lastSessionMessageAt.clear();
      try {
        if (forceUpstream) upstream?.terminate();
        else upstream?.close();
      } catch {
        /* already closing */
      }
    };
    const shutdownConnection = (force = false) => {
      releaseConnection(force);
      try {
        if (force) client.terminate();
        else client.close(1001, "server shutdown");
      } catch {
        /* already closing */
      }
    };
    connectionShutdowns.add(shutdownConnection);
    client.on("close", () => {
      // The downstream has already gone away, so there is no value in waiting
      // for an upstream close handshake.  A peer that ignores the close frame
      // would otherwise be removed from connectionShutdowns while still
      // holding its socket (and the process) open.
      releaseConnection(true);
    });
    client.on("error", () => {
      shutdownConnection(true);
    });
  });

  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    if (registry && typeof registry.off === "function") {
      registry.off("backend.ready", onBackendReady);
      registry.off("backend.sessionActivity", onBackendSessionActivity);
    }
    federationPrompts.clear();
    const activeShutdowns = [...connectionShutdowns];
    for (const shutdown of activeShutdowns) shutdown(false);
    closePromise = (async () => {
      await new Promise((resolveClose) => {
        const forceTimer = setTimeout(() => {
          for (const shutdown of activeShutdowns) shutdown(true);
        }, WS_CLOSE_GRACE_MS);
        wss.close(() => {
          clearTimeout(forceTimer);
          resolveClose();
        });
      });
      await new Promise((resolveClose) => {
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close(() => resolveClose());
      });
    })();
    return closePromise;
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actualPort = server.address().port;
      resolve({
        url: `ws://127.0.0.1:${actualPort}`,
        port: actualPort,
        close,
      });
    });
  });
}

module.exports = {
  startProxyGateway,
  OPENCLAW_START_RPC_METHODS,
  injectIntoAgentsList,
  injectIntoSessionsList,
  injectIntoModelsList,
  agentIdFromSessionKey,
  createProxyListRequestTracker,
};
