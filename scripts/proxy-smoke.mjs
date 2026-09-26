#!/usr/bin/env node
// Headless proof for app/core/proxy-gateway.js — no Electron, no real gateway.
//
// Spins up a fake upstream gateway, puts the proxy in front of it, connects a
// fake Control UI client, and asserts:
//   1. agents.list responses get the foreign "hermes" agent injected
//   2. chat.send to the foreign agent is answered locally (never reaches upstream)
//   3. chat.send to a real agent passes through to upstream
//   4. unrelated frames pass through verbatim (both directions)
//   5. degraded mode: upstream unreachable → handshake synthesized, foreign
//      backends still served, upstream-bound reqs get UPSTREAM_DOWN
//   6. recovery: gateway comes back → proxy reconnects in place, relays the
//      fresh challenge for the broker to re-sign, restores passthrough, and
//      emits agents.changed so the UI re-pulls

import { WebSocketServer, WebSocket } from "ws";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import net from "node:net";

const require = createRequire(import.meta.url);
const { startProxyGateway } = require("../app/core/proxy-gateway.js");
const { BackendRegistry } = require("../app/core/backend-registry.js");
const { AgentBackend } = require("../app/core/agent-backend.js");

const INJECT = [
  {
    id: "hermes",
    name: "Hermes (demo)",
    model: "grok-4.3",
    fallbacks: ["grok-4.3", "grok-4.20-0309-non-reasoning"],
  },
];

class MockBackend extends AgentBackend {
  constructor() {
    super();
    this.sends = [];
  }
  get id() { return "mock-hermes"; }
  ownsAgentId(id) { return INJECT.some((a) => a.id === id); }
  getAgents() { return INJECT; }
  async sendMessage(sessionKey, message, idempotencyKey, hooks, opts) {
    this.sends.push({ sessionKey, message, idempotencyKey, inputProvenance: opts.inputProvenance });
    if (message === "inspiration-notification-fixture") hooks.final("Inspiration result", false,
      { runId: "inspiration-hook-run", notificationCategory: "inspiration" });
  }
}

class DelayedBackend extends AgentBackend {
  get id() { return "mock-delayed"; }
  // ready 前不暴露 agent，用来复现 Hermes 慢启动导致首轮 agents.list 缺项。
  ownsAgentId(id) { return id === "late-agent" || id === "late-agent-2"; }
  getAgents() {
    const agents = [];
    if (this.ready) agents.push({ id: "late-agent", name: "Late Agent" });
    if (this.readyExtra) agents.push({ id: "late-agent-2", name: "Later Agent" });
    return agents;
  }
  getSessionRows() {
    const rows = [];
    if (this.ready) rows.push({ key: "agent:late-agent:main", updatedAt: 2 });
    if (this.readyExtra) rows.push({ key: "agent:late-agent-2:main", updatedAt: 1 });
    return rows;
  }
  // 直到全部分批启动结束前，这份列表都只是局部快照。生产实现由 HermesBackend
  // 提供同一契约；mock 显式覆盖以验证 proxy/registry 不依赖后端名称。
  getSessionRowsSnapshot() {
    return { rows: this.getSessionRows(), complete: this.readyExtra === true };
  }
  // 模拟本地 backend 在 UI 已连接之后才完成 profile/agent 加载，且**分批**就绪
  // （Hermes 每个 profile 一个 dashboard 进程，各自冷启动数秒）。第一批就绪就
  // 靠 onPartialReady 广播，不等最慢的那批——否则 UI 要空等到全部完成。
  async start(hooks) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    this.ready = true;
    hooks?.onPartialReady?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    this.readyExtra = true;
    return true;
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
  // Mimic the real handshake: challenge -> (client connects) -> hello-ok.
  sock.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n1" } }));
  sock.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    upstreamReceived.push(frame);
    if (frame.type !== "req") return;
    if (frame.method === "connect") {
      sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", protocol: 1, auth: { role: "operator", scopes: [] } } }));
    } else if (frame.method === "agents.list") {
      sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { defaultId: "main", mainKey: "agent:main", scope: "default", agents: [{ id: "main", name: "Main" }] } }));
    } else if (frame.method === "chat.send") {
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
const mockBackend = new MockBackend();
registry.register(mockBackend);
registry.register(new DelayedBackend());

const proxy = await startProxyGateway({
  port: 0,
  getUpstreamUrl: () => upstreamUrl,
  registry,
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
function waitFor(match, label, ms = 2000) {
  const existing = clientFrames.find(match);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
}
const send = (frame) => client.send(JSON.stringify(frame));
await new Promise((r) => client.on("open", r));

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); };

try {
  // challenge should pass through verbatim
  await waitFor((f) => f.type === "event" && f.event === "connect.challenge", "connect.challenge");
  check("challenge passthrough", true);

  // The real broker answers the challenge before relaying anything. Foreign RPCs
  // are refused until it does, so settle the handshake first.
  send({ type: "req", id: "r0", method: "connect", params: {} });
  const connectRes = await waitFor((f) => f.type === "res" && f.id === "r0", "connect res");
  check("connect handshake ok", connectRes.ok === true);

  // 1. agents.list injection
  send({ type: "req", id: "r1", method: "agents.list", params: {} });
  const agentsRes = await waitFor((f) => f.type === "res" && f.id === "r1", "agents.list res");
  const ids = (agentsRes.payload?.agents ?? []).map((a) => a.id);
  check("agents.list keeps real 'main'", ids.includes("main"));
  check("agents.list injects 'hermes'", ids.includes("hermes"));
  const hermesRow = agentsRes.payload.agents.find((a) => a.id === "hermes");
  check("hermes has display name", hermesRow?.name === "Hermes (demo)");
  check("hermes row carries per-profile model", hermesRow?.model?.primary === "grok-4.3");
  check("hermes row carries per-profile fallbacks", Array.isArray(hermesRow?.model?.fallbacks) && hermesRow.model.fallbacks.length === 2);

  // 1b. UI 首次拉 sessions 时 delayed backend 尚未 ready。响应必须与 OpenClaw
  // 断线使用同一个完整性标记，聊天页才会保留 localStorage 里的旧 agent 行。
  send({ type: "req", id: "r1s", method: "sessions.list", params: {} });
  const initialSessions = await waitFor((f) => f.type === "res" && f.id === "r1s", "initial sessions.list res");
  check(
    "starting backend marks the initial sessions snapshot incomplete",
    initialSessions.payload?.degradedBackends?.includes("mock-delayed"),
  );

  // 2. chat.send to foreign agent answered locally, never forwarded
  const upstreamCountBefore = upstreamReceived.filter((f) => f.method === "chat.send").length;
  send({ type: "req", id: "r2", method: "chat.send", params: { sessionKey: "agent:hermes:main", message: "hi" } });
  const hermesSend = await waitFor((f) => f.type === "res" && f.id === "r2", "hermes chat.send res");
  check("hermes chat.send answered ok", hermesSend.ok === true && hermesSend.payload?.status === "started");
  await new Promise((r) => setTimeout(r, 150));
  const upstreamCountAfterHermes = upstreamReceived.filter((f) => f.method === "chat.send").length;
  check("hermes chat.send NOT forwarded upstream", upstreamCountAfterHermes === upstreamCountBefore);
  check("direct Hermes chat.send has no internal provenance",
    mockBackend.sends[0]?.inputProvenance === null);

  send({ type: "req", id: "r2f", method: "chat.send", params: {
    sessionKey: "agent:hermes:main",
    message: "delegated",
    systemInputProvenance: { kind: "inter_session", sourceTool: "federation_agent_run" },
  } });
  await waitFor((f) => f.type === "res" && f.id === "r2f", "federated hermes chat.send res");
  await new Promise((r) => setTimeout(r, 20));
  check("federated Hermes chat.send preserves internal provenance",
    JSON.stringify(mockBackend.sends[1]?.inputProvenance)
      === JSON.stringify({ kind: "inter_session", sourceTool: "federation_agent_run" }));

  send({ type: "req", id: "r2i", method: "chat.send", params: {
    sessionKey: "agent:hermes:inspiration-session", message: "inspiration-notification-fixture",
  } });
  const inspirationHookFinal = await waitFor(f => f.event === "chat" && f.payload?.state === "final"
    && f.payload?.sessionKey === "agent:hermes:inspiration-session", "inspiration hook final");
  check("inspiration hook final preserves notification provenance",
    inspirationHookFinal.payload?.message?.shoggoth?.source === "inspiration");

  // 3. chat.send to real agent passes through
  send({ type: "req", id: "r3", method: "chat.send", params: { sessionKey: "agent:main:main", message: "yo" } });
  await waitFor((f) => f.type === "res" && f.id === "r3", "real chat.send res");
  const upstreamCountAfterReal = upstreamReceived.filter((f) => f.method === "chat.send").length;
  check("real chat.send forwarded upstream", upstreamCountAfterReal === upstreamCountBefore + 1);

  // 3b. device-auth gate: a socket that never completed `connect` must NOT be able
  //     to drive a foreign backend (it bypasses the gateway's own auth entirely).
  {
    const naked = new WebSocket(proxy.url);
    const nakedFrames = [];
    await new Promise((r) => naked.on("open", r));
    naked.on("message", (d) => nakedFrames.push(JSON.parse(d.toString())));
    const lateAuth = new WebSocket(proxy.url);
    const lateAuthFrames = [];
    const lateAuthWaiters = [];
    lateAuth.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      lateAuthFrames.push(frame);
      for (let i = lateAuthWaiters.length - 1; i >= 0; i--) {
        if (lateAuthWaiters[i].match(frame)) {
          lateAuthWaiters.splice(i, 1)[0].resolve(frame);
        }
      }
    });
    const lateAuthWait = (match, label, ms = 2000) => {
      const existing = lateAuthFrames.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
        lateAuthWaiters.push({
          match,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    };
    await new Promise((r) => lateAuth.on("open", r));
    await lateAuthWait(
      (frame) => frame.type === "event" && frame.event === "connect.challenge",
      "late-auth connect.challenge",
    );
    const sendBefore = upstreamReceived.filter((f) => f.method === "chat.send").length;
    naked.send(
      JSON.stringify({ type: "req", id: "x1", method: "chat.send", params: { sessionKey: "agent:hermes:main", message: "pwn" } }),
    );
    const denied = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for unauthed chat.send res")), 2500);
      const tick = setInterval(() => {
        const f = nakedFrames.find((x) => x.type === "res" && x.id === "x1");
        if (f) { clearTimeout(t); clearInterval(tick); resolve(f); }
      }, 10);
    });
    check("unauthed foreign chat.send refused", denied.ok === false && denied.error?.code === "UNAUTHORIZED");
    check(
      "unauthed foreign chat.send NOT forwarded upstream",
      upstreamReceived.filter((f) => f.method === "chat.send").length === sendBefore,
    );

    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes", name: "Hermes (demo)", agentIds: ["hermes"],
      activity: { kind: "sessions.changed", sessionKey: "agent:hermes:context-session" },
    });
    const contextChanged = await waitFor((frame) => frame.type === "event" && frame.event === "sessions.changed",
      "native context session invalidation");
    check("native context invalidation is scoped and contains no usage or content",
      JSON.stringify(contextChanged.payload) === JSON.stringify({ sessionKey: "agent:hermes:context-session", backendId: "mock-hermes" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    check("native context invalidation requires an authenticated socket",
      !nakedFrames.some((frame) => frame.event === "sessions.changed") && !lateAuthFrames.some((frame) => frame.event === "sessions.changed"));

    const completedAt = Date.now();
    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes",
      name: "Hermes (demo)",
      agentIds: ["hermes"],
      activity: {
        kind: "federation.chat.terminal",
        runId: "run-federation-visible-1",
        sessionKey: "agent:hermes:target-session",
        status: "completed",
        result: "目标 Agent 的独立 session 回复",
        errorCode: null,
        finishedAt: completedAt,
      },
    });
    const federatedFinal = await waitFor(
      (f) => f.type === "event" && f.event === "chat"
        && f.payload?.runId === "run-federation-visible-1",
      "native federation target final",
    );
    check(
      "native federation terminal is delivered on the target session",
      federatedFinal.payload?.sessionKey === "agent:hermes:target-session"
        && federatedFinal.payload?.state === "final"
        && federatedFinal.payload?.message?.content?.[0]?.text === "目标 Agent 的独立 session 回复",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(
      "native federation terminal is hidden from unauthenticated sockets",
      !nakedFrames.some((frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.runId === "run-federation-visible-1"),
    );
    check(
      "agents.changed never carries the target reply",
      !nakedFrames.some((frame) => frame.type === "event" && frame.event === "agents.changed"
        && frame.payload?.activity),
    );

    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes", name: "Hermes (demo)", agentIds: ["hermes"],
      activity: {
        kind: "federation.chat.terminal", runId: "run-native-cron-visible",
        sessionKey: "agent:hermes:cron-product-uuid", status: "completed",
        result: "我收到了啊", errorCode: null, finishedAt: completedAt,
        notificationCategory: "cron",
      },
    });
    const cronFinal = await waitFor((frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.runId === "run-native-cron-visible", "native cron final");
    check("native cron reply reaches chat with its notification category",
      cronFinal.payload?.message?.content?.[0]?.text === "我收到了啊"
        && cronFinal.payload?.message?.shoggoth?.source === "cron");
    check("native cron reply is hidden from unauthenticated sockets",
      !nakedFrames.some((frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.runId === "run-native-cron-visible"));

    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes", name: "Hermes (demo)", agentIds: ["hermes"],
      activity: {
        kind: "federation.chat.terminal", runId: "run-inspiration-visible",
        sessionKey: "agent:hermes:inspiration-session", status: "completed",
        result: "Inspiration result", errorCode: null, finishedAt: completedAt,
        notificationCategory: "inspiration",
      },
    });
    const inspirationFinal = await waitFor(frame => frame.event === "chat"
      && frame.payload?.runId === "run-inspiration-visible", "inspiration terminal final");
    check("inspiration terminal preserves notification provenance",
      inspirationFinal.payload?.message?.shoggoth?.source === "inspiration");

    const requestId = "request-federation-visible-1";
    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes",
      name: "Hermes (demo)",
      agentIds: ["hermes"],
      activity: {
        kind: "federation.chat.interaction",
        runId: "run-federation-visible-2",
        sessionKey: "agent:hermes:target-approval-session",
        interaction: {
          phase: "requested",
          eventType: "approval",
          requestId,
          payload: {
            requestId,
            method: "item/commandExecution/requestApproval",
            kind: "command",
            command: "shoggoth__notification_send",
            reason: "发送测试通知",
            sessionApprovalAvailable: true,
            expiresAt: null,
          },
        },
      },
    });
    const federationRosterChanged = await waitFor(
      (f) => f.type === "event" && f.event === "agents.changed"
        && f.payload?.backendId === "mock-hermes",
      "native federation target session refresh",
    );
    check(
      "native federation prompt refreshes the target agent sessions without leaking activity",
      federationRosterChanged.payload?.agentIds?.includes("hermes")
        && federationRosterChanged.payload?.activity === undefined,
    );
    const federatedPrompt = await waitFor(
      (f) => f.type === "event" && f.event === "chat"
        && f.payload?.runId === "run-federation-visible-2"
        && f.payload?.state === "prompt",
      "native federation target prompt",
    );
    check(
      "native federation approval is delivered on the exact target session",
      federatedPrompt.payload?.sessionKey === "agent:hermes:target-approval-session"
        && federatedPrompt.payload?.prompt?.requestId === requestId
        && federatedPrompt.payload?.prompt?.kind === "runtime_approval"
        && federatedPrompt.payload?.prompt?.message === "发送测试通知"
        && federatedPrompt.payload?.prompt?.approvalChoices?.includes("session"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(
      "native federation approval is hidden from unauthenticated sockets",
      !nakedFrames.some((frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.runId === "run-federation-visible-2")
        && !nakedFrames.some((frame) => frame.type === "event"
          && frame.event === "agents.changed" && frame.payload?.backendId === "mock-hermes"),
    );
    check(
      "native federation approval is not emitted before a socket authenticates",
      !lateAuthFrames.some((frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.runId === "run-federation-visible-2"),
    );
    const redactedRequestId = "request-federation-redacted-1";
    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes",
      name: "Hermes (demo)",
      agentIds: ["hermes"],
      activity: {
        kind: "federation.chat.interaction",
        runId: "run-federation-redacted-1",
        sessionKey: "agent:hermes:redacted-approval-session",
        interaction: {
          phase: "requested",
          eventType: "approval",
          requestId: redactedRequestId,
          payload: {
            requestId: redactedRequestId,
            method: "redacted",
            kind: "permissions",
            reason: "审批详情无法安全完整显示，只能拒绝或取消",
            sessionApprovalAvailable: true,
            expiresAt: null,
            redacted: true,
          },
        },
      },
    });
    const redactedPrompt = await waitFor(
      (frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.runId === "run-federation-redacted-1"
        && frame.payload?.state === "prompt",
      "redacted federation approval prompt",
    );
    check(
      "redacted federation approval is deny-only even if its source claims session approval",
      redactedPrompt.payload?.sessionKey === "agent:hermes:redacted-approval-session"
        && redactedPrompt.payload?.prompt?.title === "审批详情不可用"
        && JSON.stringify(redactedPrompt.payload?.prompt?.approvalChoices)
          === JSON.stringify(["deny", "cancel"]),
    );
    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes",
      name: "Hermes (demo)",
      agentIds: ["hermes"],
      activity: {
        kind: "federation.chat.interaction",
        runId: "run-federation-redacted-1",
        sessionKey: "agent:hermes:redacted-approval-session",
        interaction: {
          phase: "resolved",
          eventType: "approval",
          requestId: redactedRequestId,
          payload: null,
        },
      },
    });
    await waitFor(
      (frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.runId === "run-federation-redacted-1"
        && frame.payload?.state === "promptExpire",
      "redacted federation approval expiry",
    );
    registry.emit("backend.sessionActivity", {
      backendId: "mock-delayed",
      name: "Delayed",
      agentIds: ["hermes"],
      activity: {
        kind: "federation.chat.terminal",
        runId: "run-federation-visible-2",
        sessionKey: "agent:hermes:target-approval-session",
        status: "completed",
        result: "伪造终态",
        errorCode: null,
        finishedAt: completedAt + 1,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(
      "wrong-backend terminal cannot forge a target-session final or clear its approval",
      !clientFrames.some((frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.runId === "run-federation-visible-2"
        && frame.payload?.state === "final"),
    );
    lateAuth.send(JSON.stringify({
      type: "req", id: "late-connect", method: "connect", params: {},
    }));
    const lateConnect = await lateAuthWait(
      (frame) => frame.type === "res" && frame.id === "late-connect",
      "late-auth connect response",
    );
    const replayedRoster = await lateAuthWait(
      (frame) => frame.type === "event" && frame.event === "agents.changed"
        && frame.payload?.backendId === "mock-hermes",
      "late-auth federation roster replay",
    );
    const replayedPrompt = await lateAuthWait(
      (frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.runId === "run-federation-visible-2"
        && frame.payload?.state === "prompt",
      "late-auth federation prompt replay",
    );
    check(
      "pending federation approval replays after authentication in response-first order",
      lateConnect.ok === true
        && lateAuthFrames.indexOf(lateConnect) < lateAuthFrames.indexOf(replayedRoster)
        && lateAuthFrames.indexOf(replayedRoster) < lateAuthFrames.indexOf(replayedPrompt)
        && replayedPrompt.payload?.sessionKey === "agent:hermes:target-approval-session"
        && replayedPrompt.payload?.prompt?.requestId === requestId,
    );

    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes",
      name: "Hermes (demo)",
      agentIds: ["hermes"],
      activity: {
        kind: "federation.chat.interaction",
        runId: "run-federation-visible-2",
        sessionKey: "agent:hermes:target-approval-session",
        interaction: {
          phase: "resolved",
          eventType: "approval",
          requestId,
          payload: null,
        },
      },
    });
    const federatedPromptExpire = await waitFor(
      (f) => f.type === "event" && f.event === "chat"
        && f.payload?.runId === "run-federation-visible-2"
        && f.payload?.state === "promptExpire",
      "native federation target prompt expiry",
    );
    check(
      "native federation approval is cleared on the exact target session",
      federatedPromptExpire.payload?.sessionKey
          === "agent:hermes:target-approval-session"
        && federatedPromptExpire.payload?.requestId === requestId,
    );
    const replayedPromptExpire = await lateAuthWait(
      (frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.runId === "run-federation-visible-2"
        && frame.payload?.state === "promptExpire",
      "late-auth federation prompt expiry",
    );
    check(
      "replayed federation approval clears for the late-authenticated socket",
      replayedPromptExpire.payload?.sessionKey === "agent:hermes:target-approval-session"
        && replayedPromptExpire.payload?.requestId === requestId,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(
      "native federation approval expiry is hidden from unauthenticated sockets",
      !nakedFrames.some((frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.runId === "run-federation-visible-2"),
    );

    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes",
      name: "Hermes (demo)",
      agentIds: ["hermes"],
      activity: {
        kind: "federation.chat.terminal",
        runId: "run-federation-visible-2",
        sessionKey: "agent:hermes:target-approval-session",
        status: "completed",
        result: "通知已发送",
        errorCode: null,
        finishedAt: completedAt + 1,
      },
    });
    const federatedFinalAfterPrompt = await waitFor(
      (f) => f.type === "event" && f.event === "chat"
        && f.payload?.runId === "run-federation-visible-2"
        && f.payload?.state === "final",
      "native federation final after prompt",
    );
    check(
      "native federation prompt does not consume the terminal delivery key",
      federatedFinalAfterPrompt.payload?.message?.content?.[0]?.text === "通知已发送",
    );

    const resetHermesRequestId = "request-federation-reset-hermes";
    const resetDelayedRequestId = "request-federation-reset-delayed";
    const emitResetFixturePrompt = ({ backendId, agentId, runId, sessionKey, requestId }) => {
      registry.emit("backend.sessionActivity", {
        backendId,
        name: backendId,
        agentIds: [agentId],
        activity: {
          kind: "federation.chat.interaction",
          runId,
          sessionKey,
          interaction: {
            phase: "requested",
            eventType: "approval",
            requestId,
            payload: {
              requestId,
              method: "item/commandExecution/requestApproval",
              kind: "command",
              command: "fixture",
              reason: "断流恢复审批",
              sessionApprovalAvailable: false,
              expiresAt: null,
            },
          },
        },
      });
    };
    emitResetFixturePrompt({
      backendId: "mock-hermes",
      agentId: "hermes",
      runId: "run-federation-reset-hermes",
      sessionKey: "agent:hermes:reset-session",
      requestId: resetHermesRequestId,
    });
    emitResetFixturePrompt({
      backendId: "mock-delayed",
      agentId: "late-agent",
      runId: "run-federation-reset-delayed",
      sessionKey: "agent:late-agent:reset-session",
      requestId: resetDelayedRequestId,
    });
    await waitFor(
      (frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.state === "prompt"
        && frame.payload?.prompt?.requestId === resetDelayedRequestId,
      "second backend federation prompt before reset",
    );
    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes",
      name: "Hermes (demo)",
      agentIds: [],
      activity: { kind: "federation.chat.interaction.reset" },
    });
    const resetExpire = await waitFor(
      (frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.state === "promptExpire"
        && frame.payload?.requestId === resetHermesRequestId,
      "backend-scoped federation prompt reset",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(
      "federation reset expires only the emitting backend cache",
      resetExpire.payload?.sessionKey === "agent:hermes:reset-session"
        && !clientFrames.some((frame) => frame.type === "event" && frame.event === "chat"
          && frame.payload?.state === "promptExpire"
          && frame.payload?.requestId === resetDelayedRequestId),
    );
    check(
      "federation reset remains hidden from unauthenticated sockets",
      !nakedFrames.some((frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.requestId === resetHermesRequestId),
    );

    const resetClient = new WebSocket(proxy.url);
    const resetFrames = [];
    resetClient.on("message", (data) => resetFrames.push(JSON.parse(data.toString())));
    await new Promise((resolve) => resetClient.on("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
    resetClient.send(JSON.stringify({
      type: "req", id: "reset-connect", method: "connect", params: {},
    }));
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 2_000;
      const poll = () => {
        if (resetFrames.some((frame) => frame.type === "res" && frame.id === "reset-connect")
          && resetFrames.some((frame) => frame.type === "event" && frame.event === "chat"
            && frame.payload?.state === "prompt"
            && frame.payload?.prompt?.requestId === resetDelayedRequestId)) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("timeout waiting for backend-scoped reset replay"));
          return;
        }
        setTimeout(poll, 5);
      };
      poll();
    });
    check(
      "late authentication replays the untouched backend but not reset stale prompts",
      resetFrames.some((frame) => frame.type === "event" && frame.event === "chat"
        && frame.payload?.state === "prompt"
        && frame.payload?.prompt?.requestId === resetDelayedRequestId)
        && !resetFrames.some((frame) => frame.type === "event" && frame.event === "chat"
          && frame.payload?.state === "prompt"
          && frame.payload?.prompt?.requestId === resetHermesRequestId),
    );
    const replayOffset = clientFrames.length;
    emitResetFixturePrompt({
      backendId: "mock-hermes",
      agentId: "hermes",
      runId: "run-federation-reset-hermes",
      sessionKey: "agent:hermes:reset-session",
      requestId: resetHermesRequestId,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(
      "authoritative reconciliation can replay the still-pending approval after reset",
      clientFrames.slice(replayOffset).some((frame) => frame.type === "event"
        && frame.event === "chat" && frame.payload?.state === "prompt"
        && frame.payload?.prompt?.requestId === resetHermesRequestId),
    );
    const clearOffset = clientFrames.length;
    registry.emit("backend.sessionActivity", {
      backendId: "mock-hermes",
      name: "Hermes (demo)",
      agentIds: ["hermes"],
      activity: {
        kind: "federation.chat.interaction.clear",
        runId: "run-federation-reset-hermes",
        sessionKey: "agent:hermes:reset-session",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(
      "archived target cleanup expires the cached run without emitting a final",
      clientFrames.slice(clearOffset).some((frame) => frame.type === "event"
        && frame.event === "chat" && frame.payload?.state === "promptExpire"
        && frame.payload?.requestId === resetHermesRequestId)
        && !clientFrames.slice(clearOffset).some((frame) => frame.type === "event"
          && frame.event === "chat" && frame.payload?.state === "final"
          && frame.payload?.runId === "run-federation-reset-hermes"),
    );
    registry.emit("backend.sessionActivity", {
      backendId: "mock-delayed",
      name: "mock-delayed",
      agentIds: ["late-agent"],
      activity: {
        kind: "federation.chat.interaction",
        runId: "run-federation-reset-delayed",
        sessionKey: "agent:late-agent:reset-session",
        interaction: {
          phase: "resolved",
          eventType: "approval",
          requestId: resetDelayedRequestId,
          payload: null,
        },
      },
    });
    resetClient.close();
    naked.close();
    lateAuth.close();
  }

  // 4. Backend ready after initial page load should notify the UI to reload agents.
  const delayedReadyOffset = clientFrames.length;
  const delayedReady = registry.start();
  const changedEvt = await waitFor(
    (f) => f.type === "event" && f.event === "agents.changed"
      && f.payload?.backendId === "mock-delayed"
      && clientFrames.indexOf(f) >= delayedReadyOffset,
    "agents.changed for delayed backend",
  );
  check("backend ready emits agents.changed", changedEvt.payload?.agentIds?.includes("late-agent"));
  // 这第一条正是分批广播的第一批：它必须只带已就绪的 agent，晚一批的还不在。
  check("partial ready broadcasts only the agents already ready", !changedEvt.payload?.agentIds?.includes("late-agent-2"));
  send({ type: "req", id: "r4p", method: "sessions.list", params: {} });
  const partialSessions = await waitFor((f) => f.type === "res" && f.id === "r4p", "partial sessions.list res");
  const partialKeys = (partialSessions.payload?.sessions ?? []).map((row) => row.key);
  check("partial sessions snapshot exposes the ready row", partialKeys.includes("agent:late-agent:main"));
  check("partial sessions snapshot remains incomplete", partialSessions.payload?.degradedBackends?.includes("mock-delayed"));
  const laterEvt = await waitFor(
    (f) => f.type === "event" && f.event === "agents.changed"
      && f.payload?.backendId === "mock-delayed" && f.payload?.agentIds?.includes("late-agent-2"),
    "agents.changed for the later batch",
  );
  check("later batch emits its own agents.changed", laterEvt.payload?.agentIds?.includes("late-agent"));
  await delayedReady;
  send({ type: "req", id: "r4", method: "agents.list", params: {} });
  const refreshedAgents = await waitFor((f) => f.type === "res" && f.id === "r4", "agents.list after delayed backend");
  const refreshedIds = (refreshedAgents.payload?.agents ?? []).map((a) => a.id);
  check("agents.list includes delayed backend after ready", refreshedIds.includes("late-agent"));
  send({ type: "req", id: "r4s", method: "sessions.list", params: {} });
  const completeSessions = await waitFor((f) => f.type === "res" && f.id === "r4s", "complete sessions.list res");
  const completeKeys = (completeSessions.payload?.sessions ?? []).map((row) => row.key);
  check("complete sessions snapshot contains every delayed row", completeKeys.includes("agent:late-agent:main") && completeKeys.includes("agent:late-agent-2:main"));
  check("complete sessions snapshot clears the incomplete marker", !completeSessions.payload?.degradedBackends?.includes("mock-delayed"));

  // 5. Degraded mode: upstream unreachable → client survives, foreign backends served.
  const downProxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => "ws://127.0.0.1:1", registry });
  const dClient = new WebSocket(downProxy.url);
  const dFrames = [];
  const dWaiters = [];
  dClient.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    dFrames.push(frame);
    for (let i = dWaiters.length - 1; i >= 0; i--) {
      if (dWaiters[i].match(frame)) dWaiters.splice(i, 1)[0].resolve(frame);
    }
  });
  const dWait = (match, label, ms = 2000) => {
    const existing = dFrames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
      dWaiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
    });
  };
  const dSend = (frame) => dClient.send(JSON.stringify(frame));
  await new Promise((r) => dClient.on("open", r));

  await dWait((f) => f.type === "event" && f.event === "connect.challenge", "synthesized challenge");
  check("degraded: challenge synthesized without upstream", true);
  const degradedRequestId = "request-federation-degraded";
  registry.emit("backend.sessionActivity", {
    backendId: "mock-hermes",
    name: "Hermes (demo)",
    agentIds: ["hermes"],
    activity: {
      kind: "federation.chat.interaction",
      runId: "run-federation-degraded",
      sessionKey: "agent:hermes:degraded-approval-session",
      interaction: {
        phase: "requested",
        eventType: "approval",
        requestId: degradedRequestId,
        payload: {
          requestId: degradedRequestId,
          method: "item/commandExecution/requestApproval",
          kind: "command",
          command: "shoggoth__notification_send",
          reason: "降级连接中的测试通知",
          sessionApprovalAvailable: true,
          expiresAt: null,
        },
      },
    },
  });
  check(
    "degraded: pending federation approval stays hidden before local authentication",
    !dFrames.some((frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.runId === "run-federation-degraded"),
  );
  dSend({ type: "req", id: "d0", method: "connect", params: {} });
  const dConnect = await dWait((f) => f.type === "res" && f.id === "d0", "degraded connect res");
  check("degraded: connect answered ok locally", dConnect.ok === true && dConnect.payload?.degraded === true);
  const degradedPrompt = await dWait(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.runId === "run-federation-degraded"
      && frame.payload?.state === "prompt",
    "degraded federation prompt replay",
  );
  check(
    "degraded: pending federation approval replays after the local connect response",
    dFrames.indexOf(dConnect) < dFrames.indexOf(degradedPrompt)
      && degradedPrompt.payload?.sessionKey === "agent:hermes:degraded-approval-session"
      && degradedPrompt.payload?.prompt?.requestId === degradedRequestId,
  );
  registry.emit("backend.sessionActivity", {
    backendId: "mock-hermes",
    name: "Hermes (demo)",
    agentIds: ["hermes"],
    activity: {
      kind: "federation.chat.interaction",
      runId: "run-federation-degraded",
      sessionKey: "agent:hermes:degraded-approval-session",
      interaction: {
        phase: "resolved",
        eventType: "approval",
        requestId: degradedRequestId,
        payload: null,
      },
    },
  });
  const degradedPromptExpire = await dWait(
    (frame) => frame.type === "event" && frame.event === "chat"
      && frame.payload?.runId === "run-federation-degraded"
      && frame.payload?.state === "promptExpire",
    "degraded federation prompt expiry",
  );
  check(
    "degraded: replayed federation approval clears on resolution",
    degradedPromptExpire.payload?.requestId === degradedRequestId,
  );
  dSend({ type: "req", id: "d1", method: "agents.list", params: {} });
  const dAgents = await dWait((f) => f.type === "res" && f.id === "d1", "degraded agents.list res");
  const dIds = (dAgents.payload?.agents ?? []).map((a) => a.id);
  check("degraded: agents.list serves foreign agents", dIds.includes("hermes"));
  check("degraded: agents.list has no upstream agents", !dIds.includes("main"));
  dSend({ type: "req", id: "d2", method: "chat.send", params: { sessionKey: "agent:hermes:main", message: "hi" } });
  const dHermesSend = await dWait((f) => f.type === "res" && f.id === "d2", "degraded hermes chat.send res");
  check("degraded: foreign chat.send still served", dHermesSend.ok === true && dHermesSend.payload?.status === "started");
  dSend({ type: "req", id: "d3", method: "chat.send", params: { sessionKey: "agent:main:main", message: "yo" } });
  const dRealSend = await dWait((f) => f.type === "res" && f.id === "d3", "degraded openclaw chat.send res");
  check("degraded: upstream-bound req gets UPSTREAM_DOWN", dRealSend.ok === false && dRealSend.error?.code === "UPSTREAM_DOWN");
  dSend({ type: "req", id: "d4", method: "sessions.list", params: {} });
  const dSessions = await dWait((f) => f.type === "res" && f.id === "d4", "degraded sessions.list res");
  check("degraded: sessions.list answered locally", dSessions.ok === true && Array.isArray(dSessions.payload?.sessions));
  // 这份本地合成的列表整段缺了 OpenClaw 的会话行。据实报出缺席名单，UI 才能保留那些
  // 行的上一份快照——否则网关一重启 agent 整组蒸发（连 localStorage 缓存都被覆盖）。
  check(
    "degraded: sessions.list reports the absent backend",
    Array.isArray(dSessions.payload?.degradedBackends) &&
      dSessions.payload.degradedBackends.includes("openclaw"),
  );
  dClient.close();
  await downProxy.close();

  // 5b. Upstream 未配置（OpenClaw 被禁用/未连）：getUpstreamUrl 返回空串——这正是用户
  // 「只连 Hermes」的形态。兜底文案必须中性，code=BACKEND_NOT_READY，且绝不出现 "OpenClaw"。
  const offProxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => "", registry });
  const offClient = new WebSocket(offProxy.url);
  const offFrames = [];
  const offWaiters = [];
  offClient.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    offFrames.push(frame);
    for (let i = offWaiters.length - 1; i >= 0; i--) {
      if (offWaiters[i].match(frame)) offWaiters.splice(i, 1)[0].resolve(frame);
    }
  });
  const offWait = (match, label, ms = 2000) => {
    const existing = offFrames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
      offWaiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
    });
  };
  const offSend = (frame) => offClient.send(JSON.stringify(frame));
  await new Promise((r) => offClient.on("open", r));
  await offWait((f) => f.type === "event" && f.event === "connect.challenge", "synthesized challenge (upstream off)");
  offSend({ type: "req", id: "o0", method: "connect", params: {} });
  await offWait((f) => f.type === "res" && f.id === "o0", "connect res (upstream off)");
  offSend({ type: "req", id: "o1", method: "chat.send", params: { sessionKey: "agent:main:main", message: "yo" } });
  const offReal = await offWait((f) => f.type === "res" && f.id === "o1", "upstream-off openclaw chat.send res");
  check("upstream off: bottom-out req is BACKEND_NOT_READY (not UPSTREAM_DOWN)", offReal.ok === false && offReal.error?.code === "BACKEND_NOT_READY");
  check("upstream off: error message never names OpenClaw", offReal.ok === false && !/OpenClaw/i.test(offReal.error?.message || ""));
  // 反向用例：没配上游（= 未配置，或用户在设置页主动「断开连接」）不是「缺席」，是
  // 明确意图。不报 degradedBackends，UI 那边 agent 行照旧整组消失，不留灰行。
  offSend({ type: "req", id: "o2", method: "sessions.list", params: {} });
  const offSessions = await offWait((f) => f.type === "res" && f.id === "o2", "upstream-off sessions.list res");
  check(
    "upstream off: sessions.list reports NO absent backend (deliberate disconnect)",
    offSessions.ok === true && offSessions.payload?.degradedBackends === undefined,
  );
  offClient.close();
  await offProxy.close();

  // 6. Recovery: start degraded (dead port), then bring a gateway up on that
  // port and assert the proxy reconnects in place and restores passthrough.
  const probe = createServer();
  await listen(probe, 0);
  const rPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const rProxy = await startProxyGateway({
    port: 0,
    getUpstreamUrl: () => `ws://127.0.0.1:${rPort}`,
    registry,
    upstreamRetryMs: 200,
  });
  const rClient = new WebSocket(rProxy.url);
  const rFrames = [];
  const rWaiters = [];
  rClient.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    rFrames.push(frame);
    for (let i = rWaiters.length - 1; i >= 0; i--) {
      if (rWaiters[i].match(frame)) rWaiters.splice(i, 1)[0].resolve(frame);
    }
  });
  const rWait = (match, label, ms = 4000) => {
    const existing = rFrames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
      rWaiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
    });
  };
  const rSend = (frame) => rClient.send(JSON.stringify(frame));
  await new Promise((r) => rClient.on("open", r));

  // Degraded first: synthesized challenge, local connect, foreign-only list.
  await rWait((f) => f.type === "event" && f.event === "connect.challenge", "initial synthesized challenge");
  rSend({ type: "req", id: "broker-connect", method: "connect", params: {} });
  await rWait((f) => f.type === "res" && f.id === "broker-connect", "degraded connect ok");
  rSend({ type: "req", id: "rc1", method: "agents.list", params: {} });
  const rDegradedAgents = await rWait((f) => f.type === "res" && f.id === "rc1", "degraded agents.list");
  check("recovery: starts degraded (no upstream agents)", !(rDegradedAgents.payload?.agents ?? []).some((a) => a.id === "main"));
  const framesBeforeRecovery = rFrames.length;

  // Gateway comes up on the SAME port (mimic the real handshake like the main fake).
  const lateHttp = createServer();
  const lateWss = new WebSocketServer({ server: lateHttp });
  lateWss.on("connection", (sock) => {
    sock.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n2" } }));
    sock.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type !== "req") return;
      if (frame.method === "connect") {
        sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", protocol: 1 } }));
      } else if (frame.method === "agents.list") {
        sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { agents: [{ id: "main", name: "Main" }] } }));
      } else {
        sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
      }
    });
  });
  await listen(lateHttp, rPort);

  // The proxy retries (200ms), relays the fresh challenge; we play the broker
  // and re-sign; hello-ok flips it back and emits agents.changed.
  const relayed = await rWait(
    (f, i) => f.type === "event" && f.event === "connect.challenge" && rFrames.indexOf(f) >= framesBeforeRecovery,
    "relayed fresh challenge",
  );
  check("recovery: fresh challenge relayed to broker", relayed.payload?.nonce === "n2");
  rSend({ type: "req", id: "broker-connect", method: "connect", params: {} });
  await rWait((f) => f.type === "event" && f.event === "agents.changed" && rFrames.indexOf(f) >= framesBeforeRecovery, "recovery agents.changed");
  check("recovery: agents.changed emitted on restore", true);
  rSend({ type: "req", id: "rc2", method: "agents.list", params: {} });
  const rRestoredAgents = await rWait((f) => f.type === "res" && f.id === "rc2", "restored agents.list");
  const rIds = (rRestoredAgents.payload?.agents ?? []).map((a) => a.id);
  check("recovery: passthrough restored (upstream agents back)", rIds.includes("main"));
  check("recovery: injection still applied after restore", rIds.includes("hermes"));
  rClient.close();
  await rProxy.close();
  await new Promise((r) => lateWss.close(() => lateHttp.close(r)));
} catch (err) {
  check(`exception: ${err.message}`, false);
}

// --- report -----------------------------------------------------------------
const clientClosedByShutdown = new Promise((resolve) => client.once("close", resolve));
const proxyClosing = proxy.close();
const proxyClosedInTime = await Promise.race([
  proxyClosing.then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 300)),
]);
if (!proxyClosedInTime) {
  // Keep the RED regression itself bounded on the old implementation.
  client.terminate();
  await proxyClosing;
}
check("proxy close is bounded with an active client", proxyClosedInTime);
check("proxy close is idempotent", proxy.close() === proxyClosing);
await Promise.race([clientClosedByShutdown, new Promise((resolve) => setTimeout(resolve, 100))]);
check("proxy close closes the active client", client.readyState === WebSocket.CLOSED);
await new Promise((r) => upstreamWss.close(() => upstreamHttp.close(r)));

// A normal ws server automatically answers close frames, so use a raw upgraded
// socket to prove that client-first shutdown also reclaims a stubborn upstream.
const rawSockets = new Set();
let rawUpgraded = false;
const ignoreCloseUpstream = net.createServer((socket) => {
  rawSockets.add(socket);
  socket.on("close", () => rawSockets.delete(socket));
  let head = "";
  socket.on("data", (chunk) => {
    if (rawUpgraded) return; // Deliberately ignore the later WebSocket close frame.
    head += chunk.toString("latin1");
    if (!head.includes("\r\n\r\n")) return;
    const key = /Sec-WebSocket-Key:\s*(.+)\r\n/i.exec(head)?.[1]?.trim();
    if (!key) return;
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    rawUpgraded = true;
  });
});
await listen(ignoreCloseUpstream, 0);
const leakProxy = await startProxyGateway({
  port: 0,
  getUpstreamUrl: () => `ws://127.0.0.1:${ignoreCloseUpstream.address().port}`,
});
const leakClient = new WebSocket(leakProxy.url);
await new Promise((resolve) => leakClient.once("open", resolve));
const connectDeadline = Date.now() + 1000;
while (!rawUpgraded && Date.now() < connectDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
check("stubborn upstream completes its WebSocket upgrade", rawUpgraded);
leakClient.close();
await new Promise((resolve) => leakClient.once("close", resolve));
await leakProxy.close();
await new Promise((resolve) => setTimeout(resolve, 150));
check("client-first close reclaims an upstream that ignores close", rawSockets.size === 0);
for (const socket of rawSockets) socket.destroy();
await new Promise((resolve) => ignoreCloseUpstream.close(resolve));

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
