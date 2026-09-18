#!/usr/bin/env node
// Headless proof for the chat translation in app/core/proxy-gateway.js.
// Fake upstream gateway + mock foreign backend. Verifies:
//   1. chat.history for a foreign sessionKey is served from the backend (not forwarded)
//   2. chat.send for a foreign sessionKey is answered locally and emits
//      `chat` events with state:"delta" then state:"final", with matching
//      runId + sessionKey + assistant content blocks
//   3. real (non-foreign) chat.send still passes through to upstream

import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { startProxyGateway, OPENCLAW_START_RPC_METHODS } = require("../app/core/proxy-gateway.js");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate.js");
const { BackendRegistry } = require("../app/core/backend-registry.js");
const { AgentBackend } = require("../app/core/agent-backend.js");
const { HermesBackend } = require("../app/core/hermes-backend.js");

const HERMES_AGENTS = [{ id: "hermes-default", name: "default · Hermes", model: "grok-4.3" }];
const HERMES_TRANSCRIPTS = new Map([
  [
    "agent:hermes-default:main",
    [{ role: "assistant", content: [{ type: "text", text: "prior greeting" }] }],
  ],
]);
const HERMES_HISTORICAL_MSGS = new Map([
  [
    "agent:hermes-default:hist-1",
    [
      { role: "user", content: [{ type: "text", text: "what's up" }] },
      { role: "assistant", content: [{ type: "text", text: "all good" }] },
    ],
  ],
]);
const HERMES_SESSION_ROWS = [
  {
    key: "agent:hermes-default:hist-1",
    kind: "direct",
    label: "what's up",
    displayName: "what's up",
    updatedAt: 1_700_000_000_000,
    sessionId: "hist-1",
    model: "grok-4.3",
  },
];

const HERMES_MODEL_CHOICES = [
  { id: "grok-4.3", name: "grok-4.3", provider: "xai-oauth" },
  { id: "xiaomi/mimo-v2-pro", name: "xiaomi/mimo-v2-pro", provider: "nous" },
];

// Flipped to false to simulate the backend being offline / not yet ready — the
// window in which ownsAgentId() stops recognizing its own agents.
let hermesOnline = true;

// setSessionModel() calls the proxy routed here, so a check can assert how the
// `provider/model` ref was split.
const modelSwitchCalls = [];
const compactCalls = [];
const promptResponses = [];
const sessionMutationCalls = [];
const asyncCreateCalls = [];
let shoggothOnline = true;
let failAsyncCreate = false;
let shoggothWatchMode = "active";
const shoggothWatchRecords = [];
const shoggothAbortCalls = [];
const shoggothHistoryBehaviors = [];
const shoggothSendRecords = [];
let mainCloseWatchRecord = null;
const sendCalls = [];
const createCalls = [];

class MockChatBackend extends AgentBackend {
  get id() { return "mock-hermes"; }
  ownsAgentId(id) { return hermesOnline && HERMES_AGENTS.some((a) => a.id === id); }
  getAgents() { return HERMES_AGENTS; }
  getModelChoices() { return HERMES_MODEL_CHOICES; }
  getSessionRows() { return HERMES_SESSION_ROWS; }
  claimsAgentId(id) { return typeof id === "string" && id.startsWith("hermes-"); }
  async getHistory(sk) {
    return { messages: HERMES_HISTORICAL_MSGS.get(sk) ?? HERMES_TRANSCRIPTS.get(sk) ?? [] };
  }
  async createSession(agentId, options) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    const key = `agent:${agentId}:${randomUUID()}`;
    createCalls.push({ agentId, options, key });
    return key;
  }
  async abortChat(sessionKey) {
    sessionMutationCalls.push({ method: "abort", sessionKey });
  }
  async renameSession(sessionKey, label) {
    sessionMutationCalls.push({ method: "rename", sessionKey, label });
  }
  async deleteSession(sessionKey) {
    sessionMutationCalls.push({ method: "delete", sessionKey });
  }
  async setSessionModel(sessionKey, opts) {
    modelSwitchCalls.push({ sessionKey, ...opts });
    return { model: opts.model, scope: "session" };
  }
  async sendMessage(sessionKey, message, idempotencyKey, hooks) {
    sendCalls.push({ sessionKey, message, idempotencyKey });
    if (message === "legacy errored final") {
      hooks.final?.("legacy backend failure", true);
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
    hooks.delta?.("hi");
    await new Promise((r) => setTimeout(r, 10));
    hooks.delta?.("hi there");
    await new Promise((r) => setTimeout(r, 10));
    // Hermes 网关路径的 final 携带 per-turn usage/model（S3）；proxy 必须把它
    // 钉到广播的 final message 上（footer/ctx 计量条的数据源）。
    hooks.final?.("hi there", false, {
      usage: { input: 12, output: 3, contextUsed: 500, contextMax: 1000, contextPercent: 50 },
      model: "grok-4.3",
    });
  }
  async compactSession(sessionKey) {
    compactCalls.push(sessionKey);
    return { headline: "compacted!", tokenLine: "12k → 3k tokens" };
  }
  async respondChatPrompt(sessionKey, data) {
    promptResponses.push({ sessionKey, ...data });
    return { resolved: 1 };
  }
}

// Deliberately Promise-returning: Shoggoth creates its durable Service session
// before the gateway key exists, while Hermes still returns its key
// synchronously. The proxy contract must support both without backend branches.
class AsyncChatBackend extends AgentBackend {
  get id() { return "fake-shoggoth"; }
  ownsAgentId(id) { return shoggothOnline && id === "shoggoth-default"; }
  claimsAgentId(id) { return typeof id === "string" && id.startsWith("shoggoth-"); }
  getAgents() { return [{ id: "shoggoth-default", name: "Shoggoth", model: "openai/gpt-5" }]; }
  getSessionRows() {
    return [{
      key: "agent:shoggoth-default:real-default",
      kind: "direct",
      label: "Shoggoth",
      updatedAt: 1_700_000_000_001,
      sessionId: "real-default",
    }];
  }
  async getHistory() {
    const behavior = shoggothHistoryBehaviors.shift() || {};
    if (behavior.gate) await behavior.gate;
    if (behavior.delayMs) await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
    if (behavior.fail) throw Object.assign(new Error("history unavailable"), { code: "SERVICE_DISCONNECTED" });
    return { messages: [] };
  }
  async createSession(agentId, options) {
    asyncCreateCalls.push({ agentId, options });
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (failAsyncCreate) throw new Error("async create failed");
    return `agent:${agentId}:created-async`;
  }
  async abortChat(sessionKey) {
    shoggothAbortCalls.push(sessionKey);
  }
  async sendMessage(sessionKey, message, runId, hooks = {}, opts = {}) {
    const record = {
      sessionKey, message, runId, actualRunId: `service-${runId}`, aborted: false, settled: false,
    };
    shoggothSendRecords.push(record);
    if (message.startsWith("capacity-complete-")) {
      record.settled = true;
      hooks.final?.(message, false, { runId: record.actualRunId });
      return;
    }
    await new Promise((resolve) => {
      const finish = () => {
        if (record.settled) return;
        record.settled = true;
        opts.signal?.removeEventListener?.("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        record.aborted = true;
        finish();
      };
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener?.("abort", onAbort, { once: true });
      record.emitPrompt = (prompt) => {
        if (record.aborted || record.settled) return;
        hooks.prompt?.(prompt);
      };
      record.emitFinal = (text, actualRunId = record.actualRunId) => {
        if (record.aborted || record.settled) return;
        hooks.final?.(text, false, { runId: actualRunId });
        finish();
      };
    });
  }
  async watchSession(sessionKey, hooks = {}, opts = {}) {
    const index = shoggothWatchRecords.length + 1;
    const previous = shoggothWatchRecords.at(-1);
    const record = {
      sessionKey,
      mode: shoggothWatchMode,
      aborted: false,
      settled: false,
      startedAfterPreviousSettled: !previous || previous.settled,
    };
    shoggothWatchRecords.push(record);
    if (record.mode === "none") {
      record.settled = true;
      return;
    }
    if (record.mode === "error") {
      record.settled = true;
      throw Object.assign(new Error("watch failed token=super-secret"), { code: "SERVICE_DISCONNECTED" });
    }
    await new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        if (record.settled) return;
        if (timer) clearTimeout(timer);
        record.settled = true;
        opts.signal?.removeEventListener?.("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        record.aborted = true;
        // Replacement must await the old observer, not merely flip its signal.
        timer = setTimeout(finish, 20);
      };
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener?.("abort", onAbort, { once: true });
      queueMicrotask(() => {
        if (record.aborted || record.settled) return;
        hooks.delta?.(`recovered-${index}`);
        hooks.thinking?.(`reasoning-${index}`);
        hooks.tool?.({ toolCallId: `tool-${index}`, name: "read", phase: "start" });
        hooks.plan?.([{ content: `plan-${index}`, status: "in_progress" }]);
        hooks.status?.({ kind: "running", text: "running" });
        hooks.prompt?.({ kind: "approval", requestId: `request-${index}`, choices: ["once", "deny"] });
      });
      record.finish = finish;
      record.emitFinal = (text, actualRunId = `service-watch-${sessionKey}`) => {
        if (record.aborted || record.settled) return;
        hooks.final?.(text, false, { runId: actualRunId });
        finish();
      };
    });
  }
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}

// --- fake upstream gateway --------------------------------------------------
const upstreamReceived = [];
const upstreamHttp = createServer();
const upstreamWss = new WebSocketServer({ server: upstreamHttp });
upstreamWss.on("connection", (sock) => {
  sock.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n1" } }));
  sock.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    upstreamReceived.push(frame);
    if (frame.type !== "req") return;
    if (frame.method === "connect") {
      sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", protocol: 1, auth: { role: "operator", scopes: [] } } }));
    } else if (frame.method === "models.list") {
      sock.send(JSON.stringify({
        type: "res", id: frame.id, ok: true,
        payload: { models: [{ id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7", provider: "anthropic" }] },
      }));
    } else if (frame.method === "sessions.list") {
      sock.send(JSON.stringify({
        type: "res", id: frame.id, ok: true,
        payload: { ts: 1, path: "/", count: 1, defaults: {}, sessions: [
          { key: "agent:main:main", kind: "direct", updatedAt: 1 },
        ] },
      }));
    } else if (frame.method === "agents.list") {
      sock.send(JSON.stringify({
        type: "res", id: frame.id, ok: true,
        payload: { agents: [{ id: "main", name: "Diva" }] },
      }));
    } else if (frame.method === "chat.send" || frame.method === "chat.history") {
      sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "started" } }));
    } else {
      sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
    }
  });
});
await listen(upstreamHttp, 0);
const upstreamUrl = `ws://127.0.0.1:${upstreamHttp.address().port}`;

// --- proxy ------------------------------------------------------------------
const registry = new BackendRegistry();
registry.register(new MockChatBackend());
registry.register(new AsyncChatBackend());
let idempotentExecutions = 0;
const idempotentBackend = new HermesBackend({
  getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }),
});
idempotentBackend.profileById.set("hermes-idem", "idem");
idempotentBackend.agents = [{ id: "hermes-idem", name: "idem · Hermes" }];
idempotentBackend._sendMessageInner = async (_sessionKey, _message, _key, hooks) => {
  idempotentExecutions += 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  hooks.final?.("once", false);
};
registry.register(idempotentBackend);
const workAdmissionGate = createWorkAdmissionGate();

const proxy = await startProxyGateway({
  port: 0,
  getUpstreamUrl: () => upstreamUrl,
  registry,
  workAdmissionGate,
});

// --- fake UI client ---------------------------------------------------------
const client = new WebSocket(proxy.url);
const clientFrames = [];
const waiters = [];
client.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  clientFrames.push(frame);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].match(frame)) waiters.splice(i, 1)[0].resolve(frame);
  }
});
function waitFor(match, label, ms = 2500) {
  const existing = clientFrames.find(match);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
}
const send = (frame) => client.send(JSON.stringify(frame));
await new Promise((r) => client.on("open", r));

async function openAuthedTestClient(label) {
  const socket = new WebSocket(proxy.url);
  const frames = [];
  const localWaiters = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    frames.push(frame);
    for (let index = localWaiters.length - 1; index >= 0; index -= 1) {
      if (localWaiters[index].match(frame)) localWaiters.splice(index, 1)[0].resolve(frame);
    }
  });
  const wait = (match, item, ms = 2500) => {
    const existing = frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label} ${item}`)), ms);
      localWaiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
    });
  };
  await new Promise((resolve) => socket.on("open", resolve));
  await wait((frame) => frame.type === "event" && frame.event === "connect.challenge", "challenge");
  socket.send(JSON.stringify({ type: "req", id: `${label}-connect`, method: "connect", params: {} }));
  await wait((frame) => frame.type === "res" && frame.id === `${label}-connect`, "connect response");
  return {
    socket,
    frames,
    send: (frame) => socket.send(JSON.stringify(frame)),
    wait,
    close: () => new Promise((resolve) => {
      socket.once("close", resolve);
      socket.close();
    }),
  };
}

const client2 = new WebSocket(proxy.url);
const client2Frames = [];
const client2Waiters = [];
client2.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  client2Frames.push(frame);
  for (let i = client2Waiters.length - 1; i >= 0; i--) {
    if (client2Waiters[i].match(frame)) client2Waiters.splice(i, 1)[0].resolve(frame);
  }
});
function waitFor2(match, label, ms = 2500) {
  const existing = client2Frames.find(match);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for second client ${label}`)), ms);
    client2Waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
  });
}
const send2 = (frame) => client2.send(JSON.stringify(frame));
await new Promise((resolve) => client2.on("open", resolve));

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); };

try {
  // Passthrough warm-up: receive challenge, then settle the device-auth handshake
  // (the broker does this before relaying; foreign RPCs are gated on it).
  await waitFor((f) => f.type === "event" && f.event === "connect.challenge", "challenge");
  shoggothOnline = false;
  const upstreamBeforeUnauthed = upstreamReceived.length;
  send({
    type: "req",
    id: "unauth-shoggoth",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:real-default" },
  });
  const unauthShoggoth = await waitFor(
    (f) => f.type === "res" && f.id === "unauth-shoggoth",
    "unauthenticated Shoggoth response",
  );
  check(
    "static Shoggoth namespace still requires auth while backend starts",
    unauthShoggoth.ok === false && unauthShoggoth.error?.code === "UNAUTHORIZED",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check("unauthenticated Shoggoth request never reaches upstream", upstreamReceived.length === upstreamBeforeUnauthed);
  shoggothOnline = true;
  const createCallsBeforeMixedAuth = asyncCreateCalls.length;
  const upstreamBeforeMixedAuth = upstreamReceived.length;
  send({
    type: "req",
    id: "unauth-mixed-create",
    method: "sessions.create",
    params: {
      agentId: "main",
      parentSessionKey: "agent:shoggoth-default:real-default",
    },
  });
  const unauthMixedCreate = await waitFor(
    (f) => f.type === "res" && f.id === "unauth-mixed-create",
    "unauthenticated mixed-parent create response",
  );
  check(
    "sessions.create authenticates every explicit/parent routing candidate",
    unauthMixedCreate.ok === false && unauthMixedCreate.error?.code === "UNAUTHORIZED",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check(
    "unauthenticated mixed-parent create calls no backend and no upstream",
    asyncCreateCalls.length === createCallsBeforeMixedAuth
      && upstreamReceived.length === upstreamBeforeMixedAuth,
  );
  send({ type: "req", id: "c0", method: "connect", params: {} });
  const connectRes = await waitFor((f) => f.type === "res" && f.id === "c0", "connect res");
  check("connect handshake ok", connectRes.ok === true);
  await waitFor2((f) => f.type === "event" && f.event === "connect.challenge", "challenge");
  send2({ type: "req", id: "c0-second", method: "connect", params: {} });
  const connectRes2 = await waitFor2((f) => f.type === "res" && f.id === "c0-second", "connect res");
  check("second connect handshake ok", connectRes2.ok === true);

  const createCallsBeforeMixedRoute = asyncCreateCalls.length;
  const upstreamBeforeMixedRoute = upstreamReceived.length;
  send({
    type: "req",
    id: "auth-mixed-create",
    method: "sessions.create",
    params: {
      agentId: "main",
      parentSessionKey: "agent:shoggoth-default:real-default",
    },
  });
  const authMixedCreate = await waitFor(
    (frame) => frame.type === "res" && frame.id === "auth-mixed-create",
    "authenticated mixed-parent create response",
  );
  check(
    "sessions.create rejects an explicit/parent backend routing conflict",
    authMixedCreate.ok === false && authMixedCreate.error?.code === "BACKEND_ROUTE_CONFLICT",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check(
    "authenticated mixed-parent create calls no backend and no upstream",
    asyncCreateCalls.length === createCallsBeforeMixedRoute
      && upstreamReceived.length === upstreamBeforeMixedRoute,
  );

  // 0a. global sessions.list response gets Hermes historical session merged in.
  send({ type: "req", id: "sl1", method: "sessions.list", params: { includeGlobal: true, includeUnknown: true, configuredAgentsOnly: true, limit: 500 } });
  const sessionsRes = await waitFor((f) => f.type === "res" && f.id === "sl1", "sessions.list res");
  const sessionKeys = (sessionsRes.payload?.sessions ?? []).map((s) => s.key);
  check("sessions.list keeps real session", sessionKeys.includes("agent:main:main"));
  check("sessions.list injects hermes historical (global scope)", sessionKeys.includes("agent:hermes-default:hist-1"));
  check("sessions.list injects real Shoggoth default session", sessionKeys.includes("agent:shoggoth-default:real-default"));
  check("sessions.list count reflects merge", sessionsRes.payload?.count === sessionKeys.length);

  // 0b. agentId-scoped to an OpenClaw agent: Hermes rows must NOT be injected
  //     (would otherwise pollute sessionsResult on a per-agent reload).
  send({ type: "req", id: "sl2", method: "sessions.list", params: { agentId: "main", limit: 500 } });
  const sl2 = await waitFor((f) => f.type === "res" && f.id === "sl2", "sessions.list (main) res");
  const sl2Keys = (sl2.payload?.sessions ?? []).map((s) => s.key);
  check("sessions.list (agentId=main) NOT polluted with hermes", !sl2Keys.some((k) => k.startsWith("agent:hermes-")));

  // 0d. models.list response gets Hermes model choices merged in.
  send({ type: "req", id: "ml1", method: "models.list", params: { view: "configured" } });
  const ml1 = await waitFor((f) => f.type === "res" && f.id === "ml1", "models.list res");
  const modelIds = (ml1.payload?.models ?? []).map((m) => m.id);
  check("models.list keeps real model", modelIds.includes("anthropic/claude-opus-4.7"));
  check("models.list injects hermes models", modelIds.includes("grok-4.3") && modelIds.includes("xiaomi/mimo-v2-pro"));

  // 0d-2. agentId-scoped to an OpenClaw agent: keep the configured upstream
  //       catalog exact. Foreign choices belong to the unscoped management view.
  send({ type: "req", id: "ml2", method: "models.list", params: { view: "configured", agentId: "main" } });
  const ml2 = await waitFor((f) => f.type === "res" && f.id === "ml2", "models.list (main) res");
  const ml2Ids = (ml2.payload?.models ?? []).map((m) => m.id);
  check("models.list (agentId=main) keeps configured upstream model", ml2Ids.includes("anthropic/claude-opus-4.7"));
  check("models.list (agentId=main) NOT polluted with hermes", !ml2Ids.includes("grok-4.3") && !ml2Ids.includes("xiaomi/mimo-v2-pro"));

  // 0e. Async Shoggoth create must settle before returning the gateway key;
  //     Hermes' existing synchronous create contract remains valid.
  send({
    type: "req",
    id: "create-async",
    method: "sessions.create",
    params: { agentId: "shoggoth-default", workspace: "/tmp/shoggoth-project" },
  });
  const asyncCreated = await waitFor((f) => f.type === "res" && f.id === "create-async", "async sessions.create res");
  check(
    "async sessions.create awaits backend key",
    asyncCreated.ok === true
      && asyncCreated.payload?.key === "agent:shoggoth-default:created-async"
      && asyncCreateCalls.length === 1
      && asyncCreateCalls[0]?.options?.workspace === "/tmp/shoggoth-project",
  );
  send({ type: "req", id: "create-sync", method: "sessions.create", params: { agentId: "hermes-default" } });
  const syncCreated = await waitFor((f) => f.type === "res" && f.id === "create-sync", "sync sessions.create res");
  check(
    "sync Hermes-style sessions.create remains compatible",
    syncCreated.ok === true && /^agent:hermes-default:/.test(syncCreated.payload?.key || ""),
  );
  const upstreamBeforeCreateFailure = upstreamReceived.length;
  failAsyncCreate = true;
  send({ type: "req", id: "create-async-fail", method: "sessions.create", params: { agentId: "shoggoth-default" } });
  const asyncCreateFailure = await waitFor(
    (f) => f.type === "res" && f.id === "create-async-fail",
    "failed async sessions.create res",
  );
  failAsyncCreate = false;
  check(
    "async sessions.create failure is a stack-free BACKEND_ERROR",
    asyncCreateFailure.ok === false
      && asyncCreateFailure.error?.code === "BACKEND_ERROR"
      && asyncCreateFailure.error?.message === "async create failed"
      && !("stack" in (asyncCreateFailure.error || {})),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check("failed async sessions.create never reaches upstream", upstreamReceived.length === upstreamBeforeCreateFailure);

  // A successful Shoggoth history reload attaches this browser client to the
  // active Run. Its events use the same gateway shapes as chat.send.
  const historyFrameStart = clientFrames.length;
  send({
    type: "req",
    id: "watch-history-1",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:real-default" },
  });
  const watchHistory1 = await waitFor(
    (f) => f.type === "res" && f.id === "watch-history-1",
    "watch history response",
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const recoveredDelta1 = clientFrames.find(
    (f, index) => index >= historyFrameStart
      && f.type === "event" && f.event === "chat"
      && f.payload?.sessionKey === "agent:shoggoth-default:real-default"
      && f.payload?.state === "delta"
      && f.payload?.message?.content?.[0]?.text === "recovered-1",
  );
  const recoveredThinking1 = clientFrames.find(
    (f, index) => index >= historyFrameStart
      && f.type === "event" && f.event === "chat"
      && f.payload?.state === "thinking" && f.payload?.thinking === "reasoning-1",
  );
  const recoveredTool1 = clientFrames.find(
    (f, index) => index >= historyFrameStart
      && f.type === "event" && f.event === "session.tool"
      && f.payload?.sessionKey === "agent:shoggoth-default:real-default"
      && f.payload?.data?.toolCallId === "tool-1",
  );
  check(
    "successful Shoggoth history starts one active-run watcher after its response",
    watchHistory1.ok === true
      && shoggothWatchRecords.length === 1
      && clientFrames.indexOf(watchHistory1) < clientFrames.indexOf(recoveredDelta1),
  );
  check(
    "history watcher reuses chat thinking and tool gateway event mapping",
    !!recoveredThinking1 && !!recoveredTool1,
  );

  // An older history success that arrives after a newer request failed is
  // stale. It must not tear down the still-valid watcher from the last
  // authoritative history load.
  shoggothHistoryBehaviors.push(
    { delayMs: 60 },
    { fail: true },
  );
  send({
    type: "req",
    id: "watch-history-stale-slow",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:real-default" },
  });
  send({
    type: "req",
    id: "watch-history-newer-fail",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:real-default" },
  });
  const newerHistoryFailure = await waitFor(
    (f) => f.type === "res" && f.id === "watch-history-newer-fail",
    "newer failed history response",
  );
  const staleHistorySuccess = await waitFor(
    (f) => f.type === "res" && f.id === "watch-history-stale-slow",
    "stale slow history response",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  check(
    "stale history success cannot cancel the current watcher",
    newerHistoryFailure.ok === false
      && staleHistorySuccess.ok === true
      && shoggothWatchRecords.length === 1
      && shoggothWatchRecords[0].aborted === false,
  );

  // Re-reading the same session replaces, aborts and AWAITS the prior watcher,
  // otherwise two pollers would duplicate every active-run event.
  send({
    type: "req",
    id: "watch-history-2",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:real-default" },
  });
  await waitFor((f) => f.type === "res" && f.id === "watch-history-2", "replacement watch history response");
  await new Promise((resolve) => setTimeout(resolve, 70));
  check(
    "duplicate history aborts and awaits the previous same-client/session watcher",
    shoggothWatchRecords.length === 2
      && shoggothWatchRecords[0].aborted === true
      && shoggothWatchRecords[1].startedAfterPreviousSettled === true,
  );

  // Observer discovery failure is asynchronous to history and must never leak
  // Service tokens or replace the already-successful history response.
  shoggothWatchMode = "error";
  const errorFrameStart = clientFrames.length;
  send({
    type: "req",
    id: "watch-history-error",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:real-default" },
  });
  const historyBeforeWatchError = await waitFor(
    (f) => f.type === "res" && f.id === "watch-history-error",
    "history before watcher error response",
  );
  await new Promise((resolve) => setTimeout(resolve, 70));
  const sanitizedWatchError = clientFrames.find(
    (f, index) => index >= errorFrameStart
      && f.type === "event" && f.event === "chat"
      && f.payload?.sessionKey === "agent:shoggoth-default:real-default"
      && f.payload?.state === "error",
  );
  check(
    "watcher failure cannot overturn a successful history response",
    historyBeforeWatchError.ok === true && sanitizedWatchError?.payload?.errorMessage,
  );
  check(
    "watcher failure is code-only and secret-free",
    sanitizedWatchError?.payload?.errorMessage?.includes("SERVICE_DISCONNECTED")
      && !sanitizedWatchError.payload.errorMessage.includes("super-secret")
      && !sanitizedWatchError.payload.errorMessage.includes("token="),
  );

  // No active run returns quietly and does not synthesize chat events.
  shoggothWatchMode = "none";
  const noActiveFrameStart = clientFrames.length;
  send({
    type: "req",
    id: "watch-history-none",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:real-default" },
  });
  const noActiveHistory = await waitFor(
    (f) => f.type === "res" && f.id === "watch-history-none",
    "no-active history response",
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  check(
    "no-active Shoggoth watcher returns without chat events",
    noActiveHistory.ok === true
      && !clientFrames.slice(noActiveFrameStart).some((f) => f.type === "event" && f.event === "chat"),
  );
  shoggothWatchMode = "active";

  // A statically claimed namespace remains foreign before the backend's live
  // roster is ready. Every foreign RPC is refused locally, not only writes.
  shoggothOnline = false;
  const upstreamBeforeStarting = upstreamReceived.length;
  for (const [index, [method, params]] of [
    ["chat.history", { sessionKey: "agent:shoggoth-default:real-default" }],
    ["chat.respond", { sessionKey: "agent:shoggoth-default:real-default", kind: "approval", choice: "deny" }],
    ["sessions.compact", { key: "agent:shoggoth-default:real-default" }],
    ["sessions.create", { agentId: "shoggoth-default" }],
  ].entries()) {
    const id = `starting-shoggoth-${index}`;
    send({ type: "req", id, method, params });
    const response = await waitFor((f) => f.type === "res" && f.id === id, `${method} starting Shoggoth res`);
    check(
      `starting Shoggoth ${method} is refused locally`,
      response.ok === false && response.error?.code === "BACKEND_NOT_READY",
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  check("starting Shoggoth foreign RPCs never reach upstream", upstreamReceived.length === upstreamBeforeStarting);
  shoggothOnline = true;

  // 0c. agentId-scoped to a Hermes agent: only THAT hermes agent's rows show up.
  send({ type: "req", id: "sl3", method: "sessions.list", params: { agentId: "hermes-default", limit: 500 } });
  const sl3 = await waitFor((f) => f.type === "res" && f.id === "sl3", "sessions.list (hermes-default) res");
  const sl3Keys = (sl3.payload?.sessions ?? []).map((s) => s.key);
  check("sessions.list (agentId=hermes-default) includes hermes row", sl3Keys.includes("agent:hermes-default:hist-1"));

  // 0e. Foreign sessions.create may be asynchronous (Hermes asks its gateway
  // for the durable stored id). The proxy must await it and pass model hints,
  // never serialize a Promise as the session key or forward the request.
  const createUpstreamBefore = upstreamReceived.filter((f) => f.method === "sessions.create").length;
  send({
    type: "req",
    id: "create-1",
    method: "sessions.create",
    params: {
      agentId: "hermes-default",
      model: "google/gemini-3",
      modelProvider: "openrouter",
      acpProviderRef: "custom:openrouter-local",
    },
  });
  const created = await waitFor((f) => f.type === "res" && f.id === "create-1", "foreign sessions.create res");
  check(
    "foreign async sessions.create 返回 resolved canonical key",
    created.ok === true && created.payload?.key === createCalls.at(-1)?.key,
  );
  check(
    "foreign sessions.create 传递结构化 model hints",
    createCalls.at(-1)?.options?.model === "google/gemini-3"
      && createCalls.at(-1)?.options?.provider === "openrouter"
      && createCalls.at(-1)?.options?.acpProviderRef === "custom:openrouter-local",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check(
    "foreign sessions.create NEVER reaches upstream",
    upstreamReceived.filter((f) => f.method === "sessions.create").length === createUpstreamBefore,
  );

  // Gateway-owned sessions keep the UI's neutral identity shape until the
  // proxy boundary, then arrive upstream as the legacy qualified model only.
  send({
    type: "req",
    id: "create-openclaw",
    method: "sessions.create",
    params: {
      agentId: "main",
      model: "google/gemini-3",
      modelProvider: "openrouter",
      acpProviderRef: "custom:must-not-leak",
    },
  });
  const openclawCreated = await waitFor(
    (f) => f.type === "res" && f.id === "create-openclaw",
    "gateway sessions.create res",
  );
  const upstreamCreate = upstreamReceived.find((f) => f.id === "create-openclaw");
  check("gateway sessions.create 仍正常转发", openclawCreated.ok === true);
  check(
    "gateway sessions.create 边界重组 qualified model 并剥离 hints",
    upstreamCreate?.params?.model === "openrouter/google/gemini-3"
      && !("modelProvider" in upstreamCreate.params)
      && !("acpProviderRef" in upstreamCreate.params),
    JSON.stringify(upstreamCreate?.params),
  );

  // 1. chat.history for foreign historical session: backend serves real messages.
  const histUpstreamBefore = upstreamReceived.filter((f) => f.method === "chat.history").length;
  send({ type: "req", id: "h1", method: "chat.history", params: { sessionKey: "agent:hermes-default:hist-1", limit: 100, maxChars: 4000 } });
  const histRes = await waitFor((f) => f.type === "res" && f.id === "h1", "chat.history res");
  check("chat.history served locally", histRes.ok === true);
  check("chat.history returns historical messages", Array.isArray(histRes.payload?.messages) && histRes.payload.messages.length === 2);
  check("chat.history first message is user", histRes.payload.messages[0]?.role === "user");
  await new Promise((r) => setTimeout(r, 50));
  check("chat.history NOT forwarded upstream", upstreamReceived.filter((f) => f.method === "chat.history").length === histUpstreamBefore);
  check("Hermes history never starts a Shoggoth active-run watcher", shoggothWatchRecords.length === 4);

  const openClawHistoryBefore = upstreamReceived.filter((frame) => frame.method === "chat.history").length;
  send({
    type: "req",
    id: "openclaw-history-no-watch",
    method: "chat.history",
    params: { sessionKey: "agent:main:main" },
  });
  await waitFor(
    (frame) => frame.type === "res" && frame.id === "openclaw-history-no-watch",
    "OpenClaw history response",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check(
    "OpenClaw history stays upstream and never starts a Shoggoth watcher",
    shoggothWatchRecords.length === 4
      && upstreamReceived.filter((frame) => frame.method === "chat.history").length === openClawHistoryBefore + 1,
  );

  // Leave one live observer for the connection-close lifecycle assertion.
  send({
    type: "req",
    id: "watch-until-client-close",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:real-default" },
  });
  await waitFor(
    (f) => f.type === "res" && f.id === "watch-until-client-close",
    "watch until client close history response",
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  check("client owns one live Shoggoth watcher before close", shoggothWatchRecords.length === 5);
  mainCloseWatchRecord = shoggothWatchRecords.at(-1);

  // 2. chat.send to foreign session: local res + delta + final events.
  const sendUpstreamBefore = upstreamReceived.filter((f) => f.method === "chat.send").length;
  // UI sends `idempotencyKey` in the real chat.send params (not `runId`).
  send({
    type: "req",
    id: "s1",
    method: "chat.send",
    params: {
      sessionKey: "agent:hermes-default:main",
      message: "hi",
      idempotencyKey: "run-zzz",
      // Compatibility noise must not override the protocol's authoritative key.
      runId: "legacy-run-id",
    },
  });
  const sendRes = await waitFor((f) => f.type === "res" && f.id === "s1", "chat.send res");
  check("chat.send answered ok", sendRes.ok === true && sendRes.payload?.status === "started");
  check("chat.send passes idempotencyKey to backend", sendCalls.at(-1)?.idempotencyKey === "run-zzz");

  const deltaEvt = await waitFor(
    (f) => f.type === "event" && f.event === "chat" && f.payload?.state === "delta" && f.payload?.runId === "run-zzz",
    "chat delta",
  );
  check("delta has matching sessionKey", deltaEvt.payload.sessionKey === "agent:hermes-default:main");
  check("delta carries assistant text block", deltaEvt.payload.message?.content?.[0]?.type === "text");

  const finalEvt = await waitFor(
    (f) => f.type === "event" && f.event === "chat" && f.payload?.state === "final" && f.payload?.runId === "run-zzz",
    "chat final",
  );
  check("final text is full reply", finalEvt.payload.message?.content?.[0]?.text === "hi there");
  await new Promise((r) => setTimeout(r, 50));
  check("foreign chat.send NOT forwarded upstream", upstreamReceived.filter((f) => f.method === "chat.send").length === sendUpstreamBefore);

  // 2b. 真实 Hermes 幂等层会把同一终态回调给两个调用者；proxy 必须只做一次
  // 全局 broadcast，否则两个 socket 都会收到两份 final。
  send({
    type: "req",
    id: "idem-a",
    method: "chat.send",
    params: { sessionKey: "agent:hermes-idem:main", message: "same", idempotencyKey: "shared-key" },
  });
  send2({
    type: "req",
    id: "idem-b",
    method: "chat.send",
    params: { sessionKey: "agent:hermes-idem:main", message: "same", idempotencyKey: "shared-key" },
  });
  await Promise.all([
    waitFor((f) => f.type === "res" && f.id === "idem-a", "first idempotent started"),
    waitFor2((f) => f.type === "res" && f.id === "idem-b", "second idempotent started"),
    waitFor((f) => f.type === "event" && f.event === "chat" && f.payload?.state === "final"
      && f.payload?.runId === "shared-key", "first idempotent final"),
    waitFor2((f) => f.type === "event" && f.event === "chat" && f.payload?.state === "final"
      && f.payload?.runId === "shared-key", "second idempotent final"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const finalCount = (frames) => frames.filter((f) => f.type === "event" && f.event === "chat"
    && f.payload?.state === "final" && f.payload?.runId === "shared-key").length;
  check("cross-socket idempotency executes once", idempotentExecutions === 1);
  check("cross-socket idempotent final reaches each client exactly once",
    finalCount(clientFrames) === 1 && finalCount(client2Frames) === 1);

  // 3. real chat.send still passes through.
  send({ type: "req", id: "s2", method: "chat.send", params: { sessionKey: "agent:main:main", message: "yo", runId: "run-real" } });
  await waitFor((f) => f.type === "res" && f.id === "s2", "real chat.send res");
  check("real chat.send forwarded upstream", upstreamReceived.filter((f) => f.method === "chat.send").length === sendUpstreamBefore + 1);

  // 4. 模型切换进入 drain 后，所有已声明的 OpenClaw 启动型 RPC 都必须在
  // 本地失败，不能漏到上游；Hermes 自有 chat.send 不受 OpenClaw drain 影响。
  check(
    "OpenClaw startup RPC set is version-pinned",
    JSON.stringify([...OPENCLAW_START_RPC_METHODS]) === JSON.stringify([
      "chat.send",
      "agent",
      "cron.run",
      "workboard.cards.dispatch",
    ]),
  );
  const drain = workAdmissionGate.beginDrain("openclaw", "model-apply");
  try {
    const upstreamBeforeDrain = upstreamReceived.length;
    for (const [index, method] of [...OPENCLAW_START_RPC_METHODS].entries()) {
      const id = `drain-${index}`;
      const params = method === "chat.send"
        ? { sessionKey: "agent:main:main", message: "blocked" }
        : {};
      send({ type: "req", id, method, params });
      const response = await waitFor((f) => f.type === "res" && f.id === id, `${method} drain response`);
      check(`${method} rejected while draining`, response.ok === false && response.error?.code === "GATEWAY_DRAINING");
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    check("draining startup RPCs never reach upstream", upstreamReceived.length === upstreamBeforeDrain);

    send({
      type: "req",
      id: "s3-hermes-drain",
      method: "chat.send",
      params: {
        sessionKey: "agent:hermes-default:main",
        message: "still available",
        idempotencyKey: "run-hermes-drain",
      },
    });
    const hermesDuringDrain = await waitFor(
      (f) => f.type === "res" && f.id === "s3-hermes-drain",
      "Hermes chat during OpenClaw drain",
    );
    check("Hermes foreign chat remains available during OpenClaw drain", hermesDuringDrain.ok === true);
  } finally {
    drain.release();
  }

  const resumedBefore = upstreamReceived.filter((frame) => frame.method === "chat.send").length;
  send({
    type: "req",
    id: "s4-after-drain",
    method: "chat.send",
    params: { sessionKey: "agent:main:main", message: "resumed" },
  });
  const resumed = await waitFor((f) => f.type === "res" && f.id === "s4-after-drain", "chat after drain");
  check("OpenClaw startup RPC resumes after drain release", resumed.ok === true);
  check(
    "released OpenClaw chat reaches upstream",
    upstreamReceived.filter((frame) => frame.method === "chat.send").length === resumedBefore + 1,
  );

  // 5. Foreign session writes must NEVER reach upstream — not even when the
  //    owning backend is offline and ownsAgentId() stops recognizing the id.
  //    The gateway doesn't validate the agentId in a sessionKey: it just creates
  //    agents/<id>/sessions/sessions.json for whatever it's handed. That's how a
  //    real ~/.openclaw/agents/hermes-default/ orphan store grew (a Hermes
  //    session's model override leaked upstream and was persisted there).
  send({ type: "req", id: "al1", method: "agents.list", params: {} });
  const al1 = await waitFor((f) => f.type === "res" && f.id === "al1", "agents.list res");
  check("agents.list keeps the gateway's own agent", (al1.payload?.agents ?? []).some((a) => a.id === "main"));

  // 4b. Model switching is a session PROPERTY, not a chat message. It used to be
  //     sent as `/model …` via chat.send for Hermes, which required a live
  //     session — so an agent with a broken model config could never be fixed
  //     from the UI. It rides sessions.patch now, like label does.
  {
    const smPatchBefore = upstreamReceived.filter((f) => f.method === "sessions.patch").length;
    modelSwitchCalls.length = 0;
    send({
      type: "req",
      id: "sm1",
      method: "sessions.patch",
      params: {
        key: "agent:hermes-default:hist-1",
        model: "mimo-v2.5-pro",
        modelProvider: "xm",
        acpProviderRef: "custom:xm",
      },
    });
    const sm1 = await waitFor((f) => f.type === "res" && f.id === "sm1", "foreign model patch res");
    check("foreign sessions.patch {model} routed to backend", sm1.ok === true);
    check("foreign model patch echoes the gateway's resolved shape", sm1.payload?.resolved?.model === "mimo-v2.5-pro");
    check(
      "foreign model patch NEVER reaches upstream",
      upstreamReceived.filter((f) => f.method === "sessions.patch").length === smPatchBefore,
    );
    check(
      "setSessionModel receives structured provider/acpProviderRef",
      modelSwitchCalls.at(-1)?.provider === "xm"
        && modelSwitchCalls.at(-1)?.model === "mimo-v2.5-pro"
        && modelSwitchCalls.at(-1)?.acpProviderRef === "custom:xm",
    );

    // Provider travels separately, so an openrouter-style model id keeps its own
    // slash instead of being truncated to `gemini-3`.
    send({
      type: "req",
      id: "sm2",
      method: "sessions.patch",
      params: {
        key: "agent:hermes-default:hist-1",
        model: "google/gemini-3",
        modelProvider: "openrouter",
      },
    });
    await waitFor((f) => f.type === "res" && f.id === "sm2", "openrouter-style model patch res");
    check(
      "openrouter-style model id keeps its slash",
      modelSwitchCalls.at(-1)?.provider === "openrouter" && modelSwitchCalls.at(-1)?.model === "google/gemini-3",
    );

    // A bare id (no provider segment) must not invent one.
    send({
      type: "req",
      id: "sm3",
      method: "sessions.patch",
      params: { key: "agent:hermes-default:hist-1", model: "mimo-v2.5" },
    });
    await waitFor((f) => f.type === "res" && f.id === "sm3", "bare model patch res");
    check(
      "bare model id passes through with no provider",
      modelSwitchCalls.at(-1)?.provider === "" && modelSwitchCalls.at(-1)?.model === "mimo-v2.5",
    );

    // Ambiguous catalog inheritance deliberately omits provider. A raw model id
    // containing `/` must still stay whole and inherit the current provider.
    send({
      type: "req",
      id: "sm4",
      method: "sessions.patch",
      params: { key: "agent:hermes-default:hist-1", model: "ZhipuAI/GLM-5.2" },
    });
    await waitFor((f) => f.type === "res" && f.id === "sm4", "slashful bare model patch res");
    check(
      "bare slashful model id 不误拆 provider",
      modelSwitchCalls.at(-1)?.provider === ""
        && modelSwitchCalls.at(-1)?.model === "ZhipuAI/GLM-5.2",
    );

    send({
      type: "req",
      id: "sm-openclaw",
      method: "sessions.patch",
      params: {
        key: "agent:main:main",
        model: "google/gemini-3",
        modelProvider: "openrouter",
        acpProviderRef: "custom:must-not-leak",
      },
    });
    await waitFor((f) => f.type === "res" && f.id === "sm-openclaw", "gateway model patch res");
    const upstreamPatch = upstreamReceived.find((f) => f.id === "sm-openclaw");
    check(
      "gateway sessions.patch 边界重组 qualified model 并剥离 hints",
      upstreamPatch?.params?.model === "openrouter/google/gemini-3"
        && !("modelProvider" in upstreamPatch.params)
        && !("acpProviderRef" in upstreamPatch.params),
      JSON.stringify(upstreamPatch?.params),
    );
  }

  // 4c. Foreign sessions.compact → backend.compactSession（Hermes session.compress），
  //     display hints 原样回吐，绝不上游。chat.respond（审批/澄清卡回应）同理。
  {
    const compactUpBefore = upstreamReceived.filter((f) => f.method === "sessions.compact").length;
    send({ type: "req", id: "cp1", method: "sessions.compact", params: { key: "agent:hermes-default:hist-1" } });
    const cp1 = await waitFor((f) => f.type === "res" && f.id === "cp1", "foreign compact res");
    check("foreign sessions.compact routed to backend", cp1.ok === true && compactCalls.at(-1) === "agent:hermes-default:hist-1");
    check("foreign compact echoes display hints", cp1.payload?.result?.tokenLine === "12k → 3k tokens");
    await new Promise((r) => setTimeout(r, 30));
    check(
      "foreign sessions.compact NEVER reaches upstream",
      upstreamReceived.filter((f) => f.method === "sessions.compact").length === compactUpBefore,
    );

    send({
      type: "req",
      id: "pr1",
      method: "chat.respond",
      params: {
        sessionKey: "agent:hermes-default:hist-1",
        kind: "clarify",
        requestId: "input-1",
        choice: "once",
        all: false,
        value: "legacy",
        answers: { question_1: "structured" },
      },
    });
    const pr1 = await waitFor((f) => f.type === "res" && f.id === "pr1", "chat.respond res");
    check(
      "chat.respond routed to backend.respondChatPrompt",
      pr1.ok === true
        && promptResponses.at(-1)?.kind === "clarify"
        && promptResponses.at(-1)?.choice === "once"
        && promptResponses.at(-1)?.requestId === "input-1"
        && promptResponses.at(-1)?.all === false
        && promptResponses.at(-1)?.value === "legacy"
        && promptResponses.at(-1)?.answers?.question_1 === "structured",
    );
    check(
      "chat.respond NEVER reaches upstream",
      !upstreamReceived.some((f) => f.method === "chat.respond"),
    );

    const responseCount = promptResponses.length;
    send({
      type: "req",
      id: "pr-invalid-answers",
      method: "chat.respond",
      params: { sessionKey: "agent:hermes-default:hist-1", kind: "clarify", answers: ["not", "an", "object"] },
    });
    const invalidAnswers = await waitFor(
      (f) => f.type === "res" && f.id === "pr-invalid-answers",
      "invalid chat.respond answers res",
    );
    check(
      "chat.respond rejects non-plain answers before backend",
      invalidAnswers.ok === false
        && invalidAnswers.error?.code === "BACKEND_ERROR"
        && promptResponses.length === responseCount,
    );

    // CRUD routing remains backend-generic; none of these writes may reach
    // OpenClaw merely because this backend is not OpenClaw.
    const mutationsBefore = upstreamReceived.length;
    send({ type: "req", id: "abort-foreign", method: "chat.abort", params: { sessionKey: "agent:hermes-default:hist-1" } });
    send({ type: "req", id: "rename-foreign", method: "sessions.patch", params: { key: "agent:hermes-default:hist-1", label: "Renamed" } });
    send({ type: "req", id: "delete-foreign", method: "sessions.delete", params: { key: "agent:hermes-default:hist-1" } });
    const [abortForeign, renameForeign, deleteForeign] = await Promise.all([
      waitFor((f) => f.type === "res" && f.id === "abort-foreign", "foreign abort res"),
      waitFor((f) => f.type === "res" && f.id === "rename-foreign", "foreign rename res"),
      waitFor((f) => f.type === "res" && f.id === "delete-foreign", "foreign delete res"),
    ]);
    check(
      "foreign abort/rename/delete route through the backend contract",
      abortForeign.ok === true && renameForeign.ok === true && deleteForeign.ok === true
        && sessionMutationCalls.some((call) => call.method === "abort")
        && sessionMutationCalls.some((call) => call.method === "rename" && call.label === "Renamed")
        && sessionMutationCalls.some((call) => call.method === "delete"),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    check("foreign abort/rename/delete never reach upstream", upstreamReceived.length === mutationsBefore);
  }

  // 4d. Hermes final 的 usage/model meta 必须钉到广播的 final message 上。
  {
    send({ type: "req", id: "meta1", method: "chat.send", params: { sessionKey: "agent:hermes-default:main", message: "hi", idempotencyKey: "meta-run" } });
    const finalEv = await waitFor(
      (f) => f.type === "event" && f.event === "chat" && f.payload?.state === "final" && f.payload?.runId === "meta-run",
      "final event with meta",
    );
    const mu = finalEv.payload?.message?.usage;
    check(
      "final message carries per-turn usage + ctx trio + model",
      mu?.input === 12 && mu?.contextPercent === 50 && finalEv.payload?.message?.model === "grok-4.3",
    );
  }

  // 4e. 兼容旧 backend 的 final(text, true)：errored 是终态语义，不得伪装成成功 final。
  {
    send({
      type: "req",
      id: "error-final-1",
      method: "chat.send",
      params: {
        sessionKey: "agent:hermes-default:main",
        message: "legacy errored final",
        idempotencyKey: "error-final-run",
      },
    });
    await waitFor((f) => f.type === "res" && f.id === "error-final-1", "errored final chat.send res");
    const errorEvent = await waitFor(
      (f) => f.type === "event" && f.event === "chat"
        && f.payload?.runId === "error-final-run" && f.payload?.state === "error",
      "errored final mapped to chat error",
    );
    check("errored final preserves backend error text", errorEvent.payload?.errorMessage === "legacy backend failure");
    await new Promise((r) => setTimeout(r, 30));
    check(
      "errored final never emits successful final",
      !clientFrames.some((f) => f.type === "event" && f.event === "chat"
        && f.payload?.runId === "error-final-run" && f.payload?.state === "final"),
    );
  }

  hermesOnline = false;
  try {
    const patchBefore = upstreamReceived.filter((f) => f.method === "sessions.patch").length;
    send({ type: "req", id: "off1", method: "sessions.patch", params: { key: "agent:hermes-default:hist-1", model: "grok-4.3" } });
    const off1 = await waitFor((f) => f.type === "res" && f.id === "off1", "offline sessions.patch res");
    check("offline foreign sessions.patch refused", off1.ok === false);
    await new Promise((r) => setTimeout(r, 50));
    check(
      "offline foreign sessions.patch NEVER reaches upstream",
      upstreamReceived.filter((f) => f.method === "sessions.patch").length === patchBefore,
    );

    // chat.send leaking is worse still: upstream would mint a transcript and
    // actually run a model under the foreign agent id.
    const offSendBefore = upstreamReceived.filter((f) => f.method === "chat.send").length;
    send({ type: "req", id: "off2", method: "chat.send", params: { sessionKey: "agent:hermes-default:main", message: "hi", idempotencyKey: "run-off" } });
    const off2 = await waitFor((f) => f.type === "res" && f.id === "off2", "offline chat.send res");
    check("offline foreign chat.send refused", off2.ok === false);
    await new Promise((r) => setTimeout(r, 50));
    check(
      "offline foreign chat.send NEVER reaches upstream",
      upstreamReceived.filter((f) => f.method === "chat.send").length === offSendBefore,
    );

    // FOREIGN_ROUTED_METHODS 里的每个 mutation 都必须共享同一 offline gate。
    // 这两项曾漏出 SESSION_WRITE_METHODS，因而错误写进 OpenClaw upstream。
    for (const [index, method, params] of [
      [0, "sessions.compact", { key: "agent:hermes-default:hist-1" }],
      [1, "chat.respond", { sessionKey: "agent:hermes-default:hist-1", kind: "approval", choice: "once" }],
    ]) {
      const before = upstreamReceived.filter((f) => f.method === method).length;
      const id = `off-mutation-${index}`;
      send({ type: "req", id, method, params });
      const response = await waitFor((f) => f.type === "res" && f.id === id, `offline ${method} res`);
      check(`offline foreign ${method} refused`, response.ok === false);
      await new Promise((r) => setTimeout(r, 30));
      check(
        `offline foreign ${method} NEVER reaches upstream`,
        upstreamReceived.filter((f) => f.method === method).length === before,
      );
    }

    // …while the gateway's own agents keep passing through untouched.
    const mainPatchBefore = upstreamReceived.filter((f) => f.method === "sessions.patch").length;
    send({ type: "req", id: "off3", method: "sessions.patch", params: { key: "agent:main:main", label: "renamed" } });
    const off3 = await waitFor((f) => f.type === "res" && f.id === "off3", "gateway sessions.patch res");
    check("gateway-owned sessions.patch still forwarded", off3.ok === true
      && upstreamReceived.filter((f) => f.method === "sessions.patch").length === mainPatchBefore + 1);

    // …and an id NOBODY has claimed (e.g. an agent just created upstream, before
    // our roster catches up) must pass through — swallowing it would break the
    // first message ever sent to a new agent.
    const freshBefore = upstreamReceived.filter((f) => f.method === "chat.send").length;
    send({ type: "req", id: "off4", method: "chat.send", params: { sessionKey: "agent:brand-new:main", message: "yo" } });
    const off4 = await waitFor((f) => f.type === "res" && f.id === "off4", "brand-new agent chat.send res");
    check("agent nobody claims is still forwarded", off4.ok === true
      && upstreamReceived.filter((f) => f.method === "chat.send").length === freshBefore + 1);
  } finally {
    hermesOnline = true;
  }

  // Real reconnect handoff: the old socket's send observer must stop locally
  // on close, while the WorkRun remains alive for the new socket's history
  // watcher to finish exactly once.
  const oldClient = await openAuthedTestClient("handoff-old");
  oldClient.send({
    type: "req",
    id: "handoff-send",
    method: "chat.send",
    params: {
      sessionKey: "agent:shoggoth-default:real-default",
      message: "keep running",
      idempotencyKey: "handoff-run",
    },
  });
  await oldClient.wait(
    (frame) => frame.type === "res" && frame.id === "handoff-send",
    "send response",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const oldSendObserver = shoggothSendRecords.at(-1);
  await oldClient.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  check(
    "old socket close cancels only its local chat.send observer",
    oldSendObserver?.aborted === true && shoggothAbortCalls.length === 0,
  );

  // A history refresh on the SAME live client is a read/revalidation, not a
  // reconnect handoff. It must not cancel the chat.send observer or prompts
  // that arrive after the refresh will be invisible until another reload.
  const refreshClient = await openAuthedTestClient("live-history-refresh");
  refreshClient.send({
    type: "req",
    id: "live-refresh-send",
    method: "chat.send",
    params: {
      sessionKey: "agent:shoggoth-default:live-refresh",
      message: "keep the live observer",
      idempotencyKey: "live-refresh-run",
    },
  });
  await refreshClient.wait(
    (frame) => frame.type === "res" && frame.id === "live-refresh-send",
    "live refresh send response",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const refreshSend = shoggothSendRecords.at(-1);
  const refreshWatchCount = shoggothWatchRecords.length;
  refreshClient.send({
    type: "req",
    id: "live-refresh-history",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:live-refresh" },
  });
  await refreshClient.wait(
    (frame) => frame.type === "res" && frame.id === "live-refresh-history",
    "live refresh history response",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("same-client chat.history does not cancel active chat.send observer",
    refreshSend?.aborted === false && shoggothWatchRecords.length === refreshWatchCount);
  refreshSend?.emitPrompt?.({
    kind: "product_confirmation",
    requestId: "live-refresh-prompt",
    title: "确认继续",
    fields: [],
    actions: { submitLabel: "确认", cancelLabel: "取消" },
  });
  await refreshClient.wait(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.state === "prompt"
      && frame.payload?.prompt?.requestId === "live-refresh-prompt",
    "prompt after live history refresh",
  );
  check("prompt remains live after same-client history refresh", refreshSend?.aborted === false);
  const replayStart = refreshClient.frames.length;
  refreshClient.send({
    type: "req",
    id: "live-prompt-history",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:live-refresh" },
  });
  await refreshClient.wait(
    (frame) => frame.type === "res" && frame.id === "live-prompt-history",
    "live prompt history response",
  );
  await refreshClient.wait(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.state === "prompt"
      && frame.payload?.prompt?.requestId === "live-refresh-prompt",
    "prompt replay after session history reload",
  );
  check("session history reload restores the active prompt card",
    refreshClient.frames.slice(replayStart).some((frame) => frame.type === "event"
      && frame.event === "chat" && frame.payload?.state === "prompt"
      && frame.payload?.prompt?.requestId === "live-refresh-prompt"));
  refreshSend?.emitFinal?.("live refresh complete");
  await refreshClient.wait(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.state === "final"
      && frame.payload?.message?.content?.[0]?.text === "live refresh complete",
    "live refresh final",
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  check("history recovery watcher attaches after live send settles",
    shoggothWatchRecords.length === refreshWatchCount + 1);
  await refreshClient.close();

  const resumedClient = await openAuthedTestClient("handoff-new");
  const resumedFrameStart = resumedClient.frames.length;
  resumedClient.send({
    type: "req",
    id: "handoff-history",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:real-default" },
  });
  await resumedClient.wait(
    (frame) => frame.type === "res" && frame.id === "handoff-history",
    "history response",
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const resumedWatcher = shoggothWatchRecords.at(-1);
  resumedWatcher?.emitFinal?.("handoff complete");
  await resumedClient.wait(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.state === "final"
      && frame.payload?.message?.content?.[0]?.text === "handoff complete",
    "resumed final",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const resumedFinals = resumedClient.frames.slice(resumedFrameStart).filter(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.state === "final"
      && frame.payload?.message?.content?.[0]?.text === "handoff complete",
  );
  check("reconnected history watcher emits the terminal exactly once", resumedFinals.length === 1);
  await resumedClient.close();

  // Two live clients may observe the same Shoggoth Run. The sender receives its
  // local observer while the second client receives its history watcher; the
  // sender's final must not also be broadcast into the second client.
  const senderClient = await openAuthedTestClient("overlap-sender");
  const watcherClient = await openAuthedTestClient("overlap-watcher");
  const notifierClient = await openAuthedTestClient("overlap-notifier");
  const unauthNotifier = new WebSocket(proxy.url);
  const unauthFrames = [];
  unauthNotifier.on("message", (data) => unauthFrames.push(JSON.parse(data.toString())));
  await new Promise((resolve) => unauthNotifier.on("open", resolve));
  while (!unauthFrames.some((frame) => frame.type === "event"
    && frame.event === "connect.challenge")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const senderStart = senderClient.frames.length;
  const watcherStart = watcherClient.frames.length;
  const notifierStart = notifierClient.frames.length;
  senderClient.send({
    type: "req",
    id: "overlap-send",
    method: "chat.send",
    params: {
      sessionKey: "agent:shoggoth-default:real-default",
      message: "overlap",
      idempotencyKey: "overlap-run",
    },
  });
  await senderClient.wait((frame) => frame.type === "res" && frame.id === "overlap-send", "send response");
  watcherClient.send({
    type: "req",
    id: "overlap-history",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:real-default" },
  });
  await watcherClient.wait(
    (frame) => frame.type === "res" && frame.id === "overlap-history",
    "history response",
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const overlapActualRunId = "service-overlap-actual";
  shoggothSendRecords.at(-1)?.emitFinal?.("overlap complete", overlapActualRunId);
  shoggothWatchRecords.at(-1)?.emitFinal?.("overlap complete", overlapActualRunId);
  await senderClient.wait(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.state === "final"
      && frame.payload?.message?.content?.[0]?.text === "overlap complete",
    "sender final",
  );
  await watcherClient.wait(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.state === "final"
      && frame.payload?.message?.content?.[0]?.text === "overlap complete",
    "watcher final",
  );
  await notifierClient.wait(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.state === "final"
      && frame.payload?.message?.content?.[0]?.text === "overlap complete",
    "passive notifier final",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const overlapFinals = (frames, start) => frames.slice(start).filter(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.state === "final"
      && frame.payload?.message?.content?.[0]?.text === "overlap complete",
  ).length;
  check("simultaneous Shoggoth observers receive one terminal each",
    overlapFinals(senderClient.frames, senderStart) === 1
      && overlapFinals(watcherClient.frames, watcherStart) === 1
      && overlapFinals(notifierClient.frames, notifierStart) === 1);
  check("terminal broadcast excludes clients without a completed handshake",
    overlapFinals(unauthFrames, 0) === 0);
  await senderClient.close();
  await watcherClient.close();
  await notifierClient.close();
  await new Promise((resolve) => {
    unauthNotifier.once("close", resolve);
    unauthNotifier.close();
  });

  // Completed sends must not consume the per-client history recovery budget.
  // Every send uses a distinct session to expose leaked generation entries.
  const sendCapacityClient = await openAuthedTestClient("send-capacity");
  for (let index = 0; index < 64; index += 1) {
    const id = `capacity-send-${index}`;
    sendCapacityClient.send({
      type: "req",
      id,
      method: "chat.send",
      params: {
        sessionKey: `agent:shoggoth-default:capacity-${index}`,
        message: `capacity-complete-${index}`,
        idempotencyKey: `capacity-key-${index}`,
      },
    });
    await sendCapacityClient.wait(
      (frame) => frame.type === "res" && frame.id === id,
      `capacity send ${index}`,
    );
    await sendCapacityClient.wait(
      (frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.state === "final"
        && frame.payload?.message?.content?.[0]?.text === `capacity-complete-${index}`,
      `capacity final ${index}`,
    );
  }
  sendCapacityClient.send({
    type: "req",
    id: "history-after-completed-sends",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:history-after-sends" },
  });
  const historyAfterSends = await sendCapacityClient.wait(
    (frame) => frame.type === "res" && frame.id === "history-after-completed-sends",
    "history after completed sends",
  );
  check("completed chat.send observers release history generation capacity",
    historyAfterSends.ok === true);
  await sendCapacityClient.close();

  // A repeated terminal is a recent ledger access. It must survive the next
  // insertion instead of being evicted by FIFO order and delivered again.
  const lruSender = await openAuthedTestClient("terminal-lru-sender");
  const lruObserver = await openAuthedTestClient("terminal-lru-observer");
  const lruStart = lruObserver.frames.length;
  let lruRequest = 0;
  const sendAutoTerminal = async (suffix, expectDelivery) => {
    const id = `terminal-lru-${suffix}-${lruRequest++}`;
    const text = `capacity-complete-${suffix}`;
    lruSender.send({
      type: "req", id, method: "chat.send",
      params: {
        sessionKey: "agent:shoggoth-default:terminal-lru",
        message: text,
        idempotencyKey: `terminal-${suffix}`,
      },
    });
    await lruSender.wait((frame) => frame.type === "res" && frame.id === id, `terminal ${suffix}`);
    if (expectDelivery) {
      await lruObserver.wait(
        (frame) => frame.type === "event" && frame.event === "chat"
          && frame.payload?.state === "final"
          && frame.payload?.message?.content?.[0]?.text === text,
        `terminal delivery ${suffix}`,
      );
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await sendAutoTerminal("a", true);
  for (let index = 0; index < 255; index += 1) {
    await sendAutoTerminal(`fill-${index}`, true);
  }
  await sendAutoTerminal("a", false);
  await sendAutoTerminal("new", true);
  await sendAutoTerminal("a", false);
  const lruAFinals = lruObserver.frames.slice(lruStart).filter(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.state === "final"
      && frame.payload?.message?.content?.[0]?.text === "capacity-complete-a",
  ).length;
  check("terminal dedupe refreshes recent hits before bounded LRU eviction", lruAFinals === 1);
  await lruSender.close();
  await lruObserver.close();

  // Per-client history generations are limited to active/in-flight work. A
  // burst beyond the hard cap is rejected, and failed loads release capacity.
  const boundedClient = await openAuthedTestClient("bounded-history");
  let releaseHistory;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  for (let index = 0; index < 64; index += 1) {
    shoggothHistoryBehaviors.push({ gate: historyGate, fail: true });
    boundedClient.send({
      type: "req",
      id: `bounded-${index}`,
      method: "chat.history",
      params: { sessionKey: `agent:shoggoth-default:${String(index).padStart(4, "0")}` },
    });
  }
  boundedClient.send({
    type: "req",
    id: "bounded-overflow",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:overflow" },
  });
  const overflow = await boundedClient.wait(
    (frame) => frame.type === "res" && frame.id === "bounded-overflow",
    "history capacity response",
  );
  check("in-flight history watcher registry has a hard per-client cap",
    overflow.ok === false && overflow.error?.code === "BACKEND_BUSY");
  releaseHistory();
  await Promise.all(Array.from({ length: 64 }, (_, index) => boundedClient.wait(
    (frame) => frame.type === "res" && frame.id === `bounded-${index}`,
    `bounded history ${index}`,
  )));
  boundedClient.send({
    type: "req",
    id: "bounded-after-failure",
    method: "chat.history",
    params: { sessionKey: "agent:shoggoth-default:after-failure" },
  });
  const afterFailure = await boundedClient.wait(
    (frame) => frame.type === "res" && frame.id === "bounded-after-failure",
    "history after failures",
  );
  check("failed history loads release watcher generation capacity", afterFailure.ok === true);
  await boundedClient.close();
} catch (err) {
  check(`exception: ${err.message}`, false);
}

// --- report -----------------------------------------------------------------
client2.close();
client.close();
await proxy.close();
check(
  "client close aborts its watcher without calling chat.abort",
  mainCloseWatchRecord?.aborted === true
    && shoggothAbortCalls.length === 0,
);
await idempotentBackend.stop();
await new Promise((r) => upstreamWss.close(() => upstreamHttp.close(r)));

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
