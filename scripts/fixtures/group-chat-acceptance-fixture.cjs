"use strict";

// Production Service, Backend, Registry, private bridge, OpenClaw adapter and UI.
// The Gateway and native executor are isolated fixtures; no installed Agent or Provider is used.
const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { OpenClawBackend } = require("../../app/core/openclaw-backend");
const { ExternalInspirationRunner } = require("../../app/external-inspiration-runner");
const { generateIdentity, DEFAULT_OPERATOR_SCOPES } = require("../../app/core/device-auth");
const { startInspirationFixture } = require("./inspiration-service-fixture.cjs");

async function startGroupAcceptanceFixture() {
  const gateway = http.createServer(), sockets = new WebSocketServer({ server: gateway });
  const gatewayRuns = new Map(), nativeRuns = new Map(), bindings = new Map(), calls = [];
  let fixture, workspace;
  const methods = ["agents.list", "sessions.create", "sessions.list", "agent", "tasks.list", "tasks.get", "tasks.cancel",
    "chat.abort", "question.list", "question.resolve", "exec.approval.list", "exec.approval.get", "exec.approval.resolve"];
  sockets.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "isolated-group-fixture" } }));
    socket.on("message", raw => {
      const frame = JSON.parse(raw), params = frame.params ?? {};
      let payload;
      if (frame.method === "connect") payload = { type: "hello-ok", protocol: 3, server: { version: "2026.9.9" },
        features: { methods, events: ["agent"] }, auth: { role: "operator", scopes: DEFAULT_OPERATOR_SCOPES },
        policy: { maxPayload: 1024 * 1024, maxBufferedBytes: 1024 * 1024 } };
      else if (frame.method === "agents.list") payload = { defaultId: "main", agents: [{ id: "main", name: "OpenClaw 核验员", workspace }] };
      else if (frame.method === "sessions.create") payload = { ok: true, key: params.key, runStarted: false };
      else if (frame.method === "sessions.list") payload = { sessions: [...gatewayRuns.values()].map(run => ({ key: run.sessionKey,
        hasActiveRun: run.status === "running" })) };
      else if (frame.method === "agent") {
        const run = { id: params.idempotencyKey, runId: params.idempotencyKey, taskId: params.idempotencyKey,
          sessionKey: params.sessionKey, agentId: params.agentId, status: "running", socket, requestId: frame.id };
        gatewayRuns.set(run.id, run); calls.push({ kind: "openclaw", runId: run.id, sessionKey: run.sessionKey });
        payload = { runId: run.id, sessionKey: run.sessionKey, agentId: run.agentId, status: "accepted" };
      } else if (frame.method === "tasks.list") payload = { tasks: [...gatewayRuns.values()].filter(run => run.sessionKey === params.sessionKey)
        .map(({ socket: _socket, requestId: _requestId, ...run }) => run) };
      else if (frame.method === "tasks.get") {
        const run = gatewayRuns.get(params.taskId);
        const { socket: _socket, requestId: _requestId, ...task } = run ?? {};
        payload = { task: run ? task : null };
      } else if (frame.method === "question.list") payload = { questions: [] };
      else if (frame.method === "exec.approval.list") payload = [];
      else if (["chat.abort", "tasks.cancel"].includes(frame.method)) {
        const run = gatewayRuns.get(params.runId ?? params.taskId); if (run) run.status = "cancelled";
        payload = { ok: true, found: Boolean(run), cancelled: Boolean(run), aborted: Boolean(run), runIds: run ? [run.id] : [] };
      } else payload = { ok: true };
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayUrl = `ws://127.0.0.1:${gateway.address().port}`;
  class FixtureOpenClawBackend extends OpenClawBackend {
    async start() { await this._connect(); return true; }
    async listAgents() { return [{ id: "main", name: "OpenClaw 核验员", backendId: "openclaw" }]; }
    async listSessions() { return []; }
    async getAgent(id) {
      if (id !== "main") throw new Error("fixture Agent missing");
      return { id, name: "OpenClaw 核验员", model: "fixture", workspace, backendId: "openclaw" };
    }
    async getAgentFile(_id, name) {
      return { name, missing: false, content: name === "IDENTITY.md" ? "- 角色：公开资料核验员\n## 专长\n- 事实核对"
        : "负责核对公开资料，提供明确的结论和证据。" };
    }
  }
  const auth = { ...generateIdentity(), scopes: DEFAULT_OPERATOR_SCOPES, token: crypto.randomBytes(24).toString("base64url") };
  const openclaw = new FixtureOpenClawBackend({ getUpstreamUrl: () => gatewayUrl, authResolver: { resolveConnectAuth: () => auth } });
  const nativeExecutor = {
    async ensureSession(binding) {
      const result = await fixture.ipc("chat.session.create", { operationId: `acceptance-${binding.memberId}-${binding.threadId}`,
        profileId: binding.profileId, workspace: null, createdAt: Date.now() });
      bindings.set(result.session.sessionKey, binding); return result.session.sessionKey;
    },
    async start({ sessionKey, operationId }) {
      const binding = bindings.get(sessionKey), run = { id: crypto.randomUUID(), source: "chat", sourceId: sessionKey,
        profileId: binding.profileId, idempotencyKey: `shoggoth:chat-send:${operationId}`, status: "completed",
        text: "已按职责核对本轮内容。结论保留在当前群内，完成后停止。", errorCode: null };
      nativeRuns.set(run.id, run); calls.push({ kind: "native", runId: run.id, groupId: binding.groupId }); return run;
    },
    getRun: runId => nativeRuns.get(runId), findRun: () => null, finalText: run => run.text,
    async abort({ runId }) { const run = nativeRuns.get(runId); if (run) run.status = "canceled"; },
  };
  try {
    fixture = await startInspirationFixture({ agentCount: 32, extraBackends: [openclaw],
      groupRunner: registry => new ExternalInspirationRunner({ registry, adapterOptions: { sessionPurpose: "group" } }),
      serviceOptions: { groupChatExecutor: nativeExecutor, groupChatExternalPollMs: 40, prewarmMcpAuth: false } });
    workspace = fixture.root;
    fixture.service.groupChatDriver.drafts.pollMs = 40;
    const store = fixture.service.groupChatStore, profiles = fixture.service.productStore.listAgentProfiles().filter(profile => profile.enabled);
    const definitions = fixture.service.groupMemberDirectory.definitionStore;
    const old = definitions.get(profiles[0].id);
    definitions.update({ profileId: profiles[0].id, expectedRevision: old.manifest.revision, actor: "user",
      documents: { IDENTITY: "- 角色：公开核验员\n## 专长\n- 样本与源码核验", SOUL: "公开角色🙂协作。\n".repeat(850) + "旧版本完整尾部" } });
    const large = store.createGroup({ operationId: "acceptance-large", name: "32 人群 · 本机协作验收", purpose: "隔离验收：完整目录与角色版本",
      members: profiles.map(profile => ({ backendId: "shoggoth", agentId: profile.agentId, profileId: profile.id, displayName: profile.name })) }).groupId;
    await fixture.service.groupMemberDirectory.refresh(large);
    const first = store.getGroup(large).members[0];
    const before = definitions.get(profiles[0].id);
    definitions.update({ profileId: profiles[0].id, expectedRevision: before.manifest.revision, actor: "user",
      documents: { SOUL: "公开核验的新版协作说明🙂。\n".repeat(620) + "新版本完整尾部" } });
    await fixture.service.groupMemberDirectory.refresh(large);
    store.appendUserMessage({ groupId: large, clientMessageId: "large-seed", body: "@all 请全体按职责核对当前内容，每人给一句结论后停止。", mentionMemberIds: [] });
    fixture.service.groupChatDriver.wake(large);
    const draft = store.createGroup({ operationId: "acceptance-draft", name: "OpenClaw 草稿 · 本机运行验收", purpose: "隔离验收：原始运行草稿、替换与最终发布",
      members: [{ backendId: "shoggoth", agentId: profiles[0].agentId, profileId: profiles[0].id, displayName: profiles[0].name },
        { backendId: "openclaw", agentId: "main", displayName: "OpenClaw 核验员" }] }).groupId;
    await fixture.service.groupMemberDirectory.refresh(draft);
    const member = store.getGroup(draft).members.find(value => value.backendId === "openclaw");
    store.appendUserMessage({ groupId: draft, clientMessageId: "draft-seed", body: `@${member.handle} 请核对草稿通道，再只发布最终结论。`, mentionMemberIds: [member.id] });
    fixture.service.groupChatDriver.wake(draft);
    const emit = (run, seq, data, extra = {}) => run.socket.send(JSON.stringify({ type: "event", event: "agent",
      payload: { runId: run.id, sessionKey: run.sessionKey, agentId: run.agentId, stream: "assistant", seq, data, ...extra } }));
    const finish = () => {
      for (const run of gatewayRuns.values()) {
        run.status = "completed";
        run.socket.send(JSON.stringify({ type: "res", id: run.requestId, ok: true, payload: { runId: run.id,
          sessionKey: run.sessionKey, agentId: run.agentId, status: "ok", result: { payloads: [{ text: "最终结论：本机 OpenClaw 草稿已核对。中间文本未写入公开消息。" }] } } }));
      }
    };
    return { fixture, calls, gatewayRuns, emit, finish, groups: { large, draft }, first,
      async close() { await fixture.close(); for (const socket of sockets.clients) socket.terminate();
        await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => gateway.close(resolve)); } };
  } catch (error) {
    await fixture?.close(); await openclaw.stop(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => gateway.close(resolve)); throw error;
  }
}

module.exports = { startGroupAcceptanceFixture };

if (require.main === module) void startGroupAcceptanceFixture().then(f => {
  const info = { url: f.fixture.url, root: f.fixture.root, groups: f.groups, first: f.first.id, tasks: f.tasks, pid: process.pid };
  fs.writeFileSync("/tmp/shoggoth-group-d17-ui.json", JSON.stringify(info));
  console.log(`READY ${f.fixture.url}/#/chat`);
  const timer = setInterval(() => { for (const run of f.gatewayRuns.values()) if (run.status === "running") {
    run.seq = (run.seq ?? 10) + 1; f.emit(run, run.seq, { text: "正在核对 OpenClaw 的公开草稿，最终结论会单独发布。" });
  } }, 1000);
  const close = async () => { clearInterval(timer); fs.writeFileSync("/tmp/shoggoth-group-d17-ui-result.json",
    JSON.stringify({ calls: f.calls, groups: Object.fromEntries(Object.entries(f.groups).map(([key, id]) => [key, f.fixture.service.groupChatStore.getGroup(id)])) }));
    await f.close(); process.exit(0); };
  process.on("SIGUSR2", () => { clearInterval(timer); f.finish(); });
  process.on("SIGTERM", close); process.on("SIGINT", close);
}).catch(error => { console.error(error); process.exitCode = 1; });
