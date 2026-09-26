#!/usr/bin/env node
"use strict";

// S2 传输迁移回归：真 HermesBackend + 假 /api/ws 网关（ws 包起的 loopback 服务）。
// 覆盖：create/resume 选路、流式事件翻译（delta 累积/tool 富化/thinking/todos）、
// message.complete 三态（complete/error/empty）、interim 封段、usage 差分、
// final 后转录失效、审批卡 respondChatPrompt 往返、拨号失败回落 ACP。
//
// 不依赖真实 dashboard；不烧 token。跑法：node scripts/hermes-gateway-chat-regression.cjs

const http = require("node:http");
const { WebSocketServer } = require("ws");
const { HermesBackend } = require("../app/core/hermes-backend");

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake gateway ---------------------------------------------------------

const TOKEN = "fake-token";

function startFakeGateway() {
  const state = {
    frames: [], // every JSON-RPC request received, in order
    // per-method behavior: method -> (params, reply, emit) => void
    behavior: new Map(),
    sockets: new Set(),
    restMessages: [], // rows served by GET /api/sessions/{id}/messages
    restSessions: [], // rows served by GET /api/sessions
    restDeletes: [], // ids received by DELETE /api/sessions/{id}
  };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://x").pathname;
    const deleteMatch = req.method === "DELETE" && /^\/api\/sessions\/([^/]+)$/.exec(pathname);
    if (deleteMatch) {
      const sessionId = decodeURIComponent(deleteMatch[1]);
      state.restDeletes.push(sessionId);
      state.restSessions = state.restSessions.filter((row) => row.id !== sessionId);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // REST used by getHistory refetch — a canned transcript (scenarios can swap
    // `state.restMessages` to exercise the row → chat-message mapping).
    if (/^\/api\/sessions\/[^/]+\/messages/.test(req.url || "")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ session_id: "st1", messages: state.restMessages }));
      return;
    }
    if (pathname === "/api/sessions") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ sessions: state.restSessions }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const wss = new WebSocketServer({ server, path: "/api/ws" });
  wss.on("connection", (sock, req) => {
    const url = new URL(req.url, "http://x");
    if (url.searchParams.get("token") !== TOKEN) {
      sock.close();
      return;
    }
    state.sockets.add(sock);
    const emit = (type, sessionId, payload) =>
      sock.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload } }));
    sock.on("close", () => state.sockets.delete(sock));
    sock.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || msg.method == null) return;
      state.frames.push({ method: msg.method, params: msg.params });
      const reply = (result) => sock.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      const replyErr = (code, message) =>
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } }));
      const handler = state.behavior.get(msg.method);
      if (handler) handler(msg.params || {}, reply, emit, replyErr);
      else reply({});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, wss, state, port: server.address().port }));
  });
}

function makeBackend(port) {
  const be = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  be.profileById.set("hermes-t", "tp");
  be.dashboards.set("tp", { baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, proc: null, spawned: false });
  return be;
}

function collectHooks() {
  const log = { deltas: [], finals: [], errors: [], interims: [], thinking: [], tools: [], plans: [], statuses: [], prompts: [] };
  return {
    log,
    hooks: {
      delta: (t) => log.deltas.push(t),
      final: (t, errored, meta) => log.finals.push({ t, errored, meta }),
      error: (m) => log.errors.push(m),
      interim: (t) => log.interims.push(t),
      thinking: (t) => log.thinking.push(t),
      tool: (d) => log.tools.push(d),
      plan: (e) => log.plans.push(e),
      status: (s) => log.statuses.push(s),
      prompt: (p) => log.prompts.push(p),
    },
  };
}

// ---- scenarios ------------------------------------------------------------

async function main() {
  const gw = await startFakeGateway();
  const { state } = gw;

  // — 场景 0：显式 /new 直接拿 stored id 作为 canonical UI key。首发复用
  // 预装 runtime，不得再 create；REST 稍后出现同一 stored id 时自然同 key 收敛。
  {
    const be = makeBackend(gw.port);
    const createCountBefore = state.frames.filter((f) => f.method === "session.create").length;
    state.behavior.set("session.create", (params, reply) => {
      reply({
        session_id: "rt0",
        stored_session_id: "st0",
        info: { lazy: true, model: "google/gemini-3", provider: "openrouter" },
      });
    });
    const key = await be.createSession("hermes-t", {
      model: "google/gemini-3",
      provider: "openrouter",
    });
    const createFrame = state.frames.filter((f) => f.method === "session.create").at(-1);
    check("S0: /new 返回 stored id canonical key", key === "agent:hermes-t:st0", key);
    check(
      "S0: create 保留 provider + 含 slash 的 model id",
      createFrame?.params?.provider === "openrouter" && createFrame?.params?.model === "google/gemini-3",
      JSON.stringify(createFrame?.params),
    );
    check(
      "S0: create 预装 runtime/stored 映射",
      be.gwRuntimeByKey.get(key)?.runtimeId === "rt0" && be.gwRuntimeByKey.get(key)?.storedId === "st0",
    );
    check("S0: 首条 prompt 前仍按未持久化会话处理", be.freshSessionKeys.has(key));
    check("S0: fresh canonical 记录 gateway mint transport", be.freshSessionTransports.get(key) === "gateway");
    state.restSessions = [{
      id: "st0",
      title: "canonical",
      source: "desktop",
      started_at: 1783900800,
      last_active: 1783900801,
      model: "google/gemini-3",
    }];
    const rows = await be.refreshSessions();
    check(
      "S0: REST refresh 与 canonical key 收敛且不重复",
      rows.filter((row) => row.key === key).length === 1 && !rows.some((row) => row.key !== key),
      JSON.stringify(rows.map((row) => row.key)),
    );
    const { log, hooks } = collectHooks();
    state.behavior.set("prompt.submit", (params, reply, emit) => {
      reply({ status: "streaming" });
      setTimeout(() => emit("message.complete", "rt0", { text: "created", status: "complete" }), 5);
    });
    await be.sendMessage(key, "hello", "created-run", hooks, {});
    check("S0: canonical 会话首发复用预装 runtime", log.finals[0]?.t === "created");
    check("S0: prompt 接受后解除未持久化标记", !be.freshSessionKeys.has(key));
    check("S0: prompt 接受后清理 mint transport", !be.freshSessionTransports.has(key));
    check(
      "S0: canonical 会话首发不重复 session.create",
      state.frames.filter((f) => f.method === "session.create").length === createCountBefore + 1,
    );
    state.restSessions = [];
  }

  // — 场景 0a：裸 model id 自身含 `/` 时不得被误拆成 provider/model；gateway
  // fresh 删除仍是 local-only，不应误删尚未持久化的 stored id。
  {
    const be = makeBackend(gw.port);
    state.frames.length = 0;
    state.behavior.set("session.create", (_params, reply) => {
      reply({ session_id: "rt0a", stored_session_id: "st0a" });
    });
    const deletesBefore = state.restDeletes.length;
    const key = await be.createSession("hermes-t", { model: "ZhipuAI/GLM-5.2" });
    const createFrame = state.frames.find((f) => f.method === "session.create");
    check(
      "S0a: 裸含 slash model id 不误拆 provider",
      createFrame?.params?.model === "ZhipuAI/GLM-5.2" && !("provider" in createFrame.params),
      JSON.stringify(createFrame?.params),
    );
    await be.deleteSession(key);
    check("S0a: gateway fresh 删除不发 REST DELETE", state.restDeletes.length === deletesBefore);
    await be.stop();
  }

  // — 场景 0b：网关创建失败回落 ACP 后，即使网关在首发前恢复，也必须
  // 复用 ACP canonical identity，不能给同一个 UI key 再建一个 stored id。
  {
    const previousMode = process.env.SHOGGOTH_HERMES_CHAT;
    process.env.SHOGGOTH_HERMES_CHAT = "gateway";
    const be = makeBackend(gw.port);
    const realGwSocket = be._gwSocket.bind(be);
    be._gwSocket = () => ({ request: async () => { throw new Error("gateway unavailable"); } });
    let newSessionCalls = 0;
    let promptCalls = 0;
    const modelSelections = [];
    const fakeClient = {
      stderrTail: [],
      supportsImages: () => false,
      newSession: async () => {
        newSessionCalls += 1;
        return `acp-canonical-${newSessionCalls}`;
      },
      setSessionModel: async (sessionId, modelId) => {
        modelSelections.push({ sessionId, modelId });
        return {};
      },
      prompt: async (_sessionId, _content, onUpdate) => {
        promptCalls += 1;
        onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "acp-created" } });
        return { stopReason: "end_turn" };
      },
    };
    be._clientForProfile = () => fakeClient;
    be.modelChoices = [{
      id: "ZhipuAI/GLM-5.2",
      provider: "my-modelscope",
      acpProviderRef: "custom:my-modelscope",
    }];
    try {
      const key = await be.createSession("hermes-t", {
        model: "ZhipuAI/GLM-5.2",
        provider: "my-modelscope",
      });
      check("S0b: 创建降级 ACP 后返回 canonical session id", key === "agent:hermes-t:acp-canonical-1", key);
      check("S0b: ACP 首发前保持 local-only 标记", be.freshSessionKeys.has(key));
      check("S0b: fresh canonical 记录 ACP mint transport", be.freshSessionTransports.get(key) === "acp");
      check(
        "S0b: ACP 创建复用 acpProviderRef 三段模型引用",
        modelSelections[0]?.sessionId === "acp-canonical-1"
          && modelSelections[0]?.modelId === "custom:my-modelscope:ZhipuAI/GLM-5.2",
        JSON.stringify(modelSelections),
      );
      const deletesBefore = state.restDeletes.length;
      const discardedKey = await be.createSession("hermes-t");
      await be.deleteSession(discardedKey);
      check(
        "S0b: ACP fresh 删除清理已持久化 session",
        state.restDeletes.length === deletesBefore + 1
          && state.restDeletes.at(-1) === "acp-canonical-2",
        JSON.stringify(state.restDeletes),
      );
      check(
        "S0b: ACP fresh 删除清理本地 transport/mapping",
        !be.acpSessionByKey.has(discardedKey)
          && !be.freshSessionKeys.has(discardedKey)
          && !be.freshSessionTransports.has(discardedKey),
      );
      be._gwSocket = realGwSocket;
      be.gwChatDisabledUntil.delete("tp");
      const gatewayFramesBeforeSettings = state.frames.length;
      await be.setSessionModel(key, { provider: "nous", model: "tencent/hy3:free" });
      check(
        "S0b: ACP fresh 会话切模型仍留在 ACP",
        modelSelections[1]?.modelId === "nous:tencent/hy3:free"
          && state.frames.length === gatewayFramesBeforeSettings,
        JSON.stringify(modelSelections),
      );
      let slashError;
      await be.execSlash("hermes-t", key, "/help").catch((err) => { slashError = err; });
      check(
        "S0b: ACP fresh 会话的网关 Slash fail-closed",
        /已绑定 ACP/.test(String(slashError?.message)) && state.frames.length === gatewayFramesBeforeSettings,
        slashError?.message,
      );
      const gatewayFramesBefore = state.frames.length;
      const newSessionCallsBeforePrompt = newSessionCalls;
      const { log, hooks } = collectHooks();
      await be.sendMessage(key, "hello", "acp-created-run", hooks, {});
      check(
        "S0b: ACP 首发复用预装映射",
        newSessionCalls === newSessionCallsBeforePrompt && promptCalls === 1,
      );
      check("S0b: 网关恢复后首发不创建第二 identity", state.frames.length === gatewayFramesBefore);
      check("S0b: ACP prompt 成功后解除 local-only 标记", !be.freshSessionKeys.has(key));
      check("S0b: ACP prompt 成功后清理 mint transport", !be.freshSessionTransports.has(key));
      check("S0b: ACP canonical 会话正常返回", log.finals[0]?.t === "acp-created");
    } finally {
      if (previousMode == null) delete process.env.SHOGGOTH_HERMES_CHAT;
      else process.env.SHOGGOTH_HERMES_CHAT = previousMode;
      await be.stop();
    }
  }

  // — 场景 0e：ACP session/new 已持久化；若继承模型的 session/set_model 失败，
  // create 必须保留原始错误，同时 best-effort 删除刚创建的 durable row。
  {
    const previousMode = process.env.SHOGGOTH_HERMES_CHAT;
    process.env.SHOGGOTH_HERMES_CHAT = "gateway";
    const be = makeBackend(gw.port);
    be._gwSocket = () => ({ request: async () => { throw new Error("gateway unavailable"); } });
    be._clientForProfile = () => ({
      newSession: async () => "acp-model-failed",
      setSessionModel: async () => { throw new Error("model setup failed"); },
    });
    const deletesBefore = state.restDeletes.length;
    let setupError;
    try {
      await be.createSession("hermes-t", { model: "vendor/model", provider: "builtin" });
    } catch (err) {
      setupError = err;
    }
    check("S0e: set_model 失败保留原始错误", setupError?.message === "model setup failed", setupError?.message);
    check(
      "S0e: set_model 失败清理 durable ACP session",
      state.restDeletes.length === deletesBefore + 1
        && state.restDeletes.at(-1) === "acp-model-failed",
      JSON.stringify(state.restDeletes),
    );
    check(
      "S0e: set_model 失败不暴露 canonical 本地状态",
      !be.acpSessionByKey.has("agent:hermes-t:acp-model-failed")
        && !be.freshSessionKeys.has("agent:hermes-t:acp-model-failed")
        && !be.freshSessionTransports.has("agent:hermes-t:acp-model-failed"),
    );
    if (previousMode == null) delete process.env.SHOGGOTH_HERMES_CHAT;
    else process.env.SHOGGOTH_HERMES_CHAT = previousMode;
    await be.stop();
  }

  // — 场景 0d：ACP mint 后子进程若在首发前退出，canonical id 已不可恢复。
  // 必须要求重建，而不是把 UI key 静默挂到新的 ACP/Gateway identity。
  {
    const previousMode = process.env.SHOGGOTH_HERMES_CHAT;
    process.env.SHOGGOTH_HERMES_CHAT = "gateway";
    const be = makeBackend(gw.port);
    const realGwSocket = be._gwSocket.bind(be);
    be._gwSocket = () => ({ request: async () => { throw new Error("gateway unavailable"); } });
    let newSessionCalls = 0;
    const fakeClient = {
      stderrTail: [],
      supportsImages: () => false,
      newSession: async () => {
        newSessionCalls += 1;
        return `acp-lost-${newSessionCalls}`;
      },
      prompt: async () => ({ stopReason: "end_turn" }),
    };
    be._clientForProfile = () => fakeClient;
    try {
      const key = await be.createSession("hermes-t");
      be._gwSocket = realGwSocket;
      be.gwChatDisabledUntil.delete("tp");
      be.acpSessionByKey.delete(key); // mirrors AcpClient.onExit cleanup
      const gatewayFramesBefore = state.frames.length;
      const { log, hooks } = collectHooks();
      await be.sendMessage(key, "hello", "acp-lost-run", hooks, {});
      check("S0d: ACP exit 后首发明确失败", log.errors.some((m) => /重新创建会话/.test(m)));
      check("S0d: ACP exit 后不新建第二 ACP identity", newSessionCalls === 1);
      check("S0d: ACP exit 后不切到 gateway identity", state.frames.length === gatewayFramesBefore);
      check(
        "S0d: 失败后仍保留 canonical transport 证据",
        be.freshSessionKeys.has(key) && be.freshSessionTransports.get(key) === "acp",
      );
    } finally {
      if (previousMode == null) delete process.env.SHOGGOTH_HERMES_CHAT;
      else process.env.SHOGGOTH_HERMES_CHAT = previousMode;
      await be.stop();
    }
  }

  // — 场景 0c：gateway canonical identity 只有在 prompt.submit 接受后才
  // 持久化；提交失败要保留 fresh 标记，且绝不能跨 transport 重建。
  {
    const be = makeBackend(gw.port);
    state.behavior.set("session.create", (_params, reply) => {
      reply({ session_id: "rt0c", stored_session_id: "st0c" });
    });
    const key = await be.createSession("hermes-t");
    let acpCalls = 0;
    be._clientForProfile = () => {
      acpCalls += 1;
      throw new Error("ACP must not be reached");
    };
    state.behavior.set("prompt.submit", (_params, _reply, _emit, replyErr) => {
      replyErr(-32000, "submit failed");
    });
    const { log, hooks } = collectHooks();
    await be.sendMessage(key, "hello", "gateway-submit-failed", hooks, {});
    check("S0c: gateway prompt 拒绝后仍保持 local-only 标记", be.freshSessionKeys.has(key));
    check("S0c: gateway prompt 拒绝后保留 mint transport", be.freshSessionTransports.get(key) === "gateway");
    check("S0c: gateway prompt 拒绝不回落 ACP 重建", acpCalls === 0 && !be.acpSessionByKey.has(key));
    check("S0c: gateway prompt 拒绝返回错误终态", log.finals[0]?.errored === true);
    await be.stop();
  }

  // — 场景 1：main 键 create + 全事件流 + usage 差分 + 转录失效
  {
    const be = makeBackend(gw.port);
    const { log, hooks } = collectHooks();
    state.behavior.set("session.create", (params, reply) => {
      reply({ session_id: "rt1", stored_session_id: "st1", message_count: 0, messages: [] });
    });
    state.behavior.set("prompt.submit", (params, reply, emit) => {
      reply({ status: "streaming" });
      setTimeout(() => {
        emit("message.delta", "rt1", { text: "Hel" });
        emit("message.delta", "rt1", { text: "lo " });
        emit("reasoning.delta", "rt1", { text: "think…" });
        emit("tool.start", "rt1", { tool_id: "t1", name: "terminal", args_text: '{"command":"ls"}' });
        emit("tool.complete", "rt1", {
          tool_id: "t1",
          name: "terminal",
          args: { command: "ls" },
          result_text: "a.txt",
          duration_s: 1.5,
          inline_diff: "@@ -1 +1 @@\n-x\n+y",
          todos: [{ content: "step 1", status: "completed" }],
        });
        emit("status.update", "rt1", { kind: "compacting", text: "…" });
        emit("message.complete", "rt1", {
          text: "Hello world",
          status: "complete",
          usage: { input: 100, output: 20, total: 120, calls: 1, context_used: 1234, context_max: 100000, context_percent: 1, model: "m1" },
        });
      }, 10);
    });
    await be.sendMessage("agent:hermes-t:main", "hi", "run1", hooks, {});
    const createFrame = state.frames.find((f) => f.method === "session.create");
    check("S1: main 键走 session.create（source=desktop）", createFrame && createFrame.params.source === "desktop");
    check("S1: prompt.submit 带 runtime session_id", state.frames.some((f) => f.method === "prompt.submit" && f.params.session_id === "rt1"));
    check("S1: delta 以全量累积转发", log.deltas.length === 2 && log.deltas[1] === "Hello ", JSON.stringify(log.deltas));
    check("S1: thinking 转发", log.thinking.length === 1 && log.thinking[0] === "think…");
    check(
      "S1: tool start+result 富化（duration/diffText）",
      log.tools.length === 2 && log.tools[1].phase === "result" && log.tools[1].durationS === 1.5 && /@@/.test(log.tools[1].diffText || ""),
      JSON.stringify(log.tools),
    );
    check("S1: todos → plan hook", log.plans.length === 1 && log.plans[0][0].content === "step 1");
    check("S1: 压缩状态 → status hook", log.statuses.length === 1 && log.statuses[0].kind === "compacting");
    check(
      "S1: final 带 per-turn usage 差分 + ctx 三元组",
      log.finals.length === 1 &&
        log.finals[0].t === "Hello world" &&
        log.finals[0].meta?.usage?.input === 100 &&
        log.finals[0].meta?.usage?.contextMax === 100000 &&
        log.finals[0].meta?.usage?.contextPercent === 1 &&
        log.finals[0].meta?.model === "m1",
      JSON.stringify(log.finals[0]?.meta),
    );
    check("S1: final 后转录失效（下次 history 走 REST 权威）", !be.transcripts.has("agent:hermes-t:main"));
    check("S1: runtime 映射 storedId 记账", be.gwRuntimeByKey.get("agent:hermes-t:main")?.storedId === "st1");
    // 第二轮：usage 差分应减去上一轮快照
    const r2 = collectHooks();
    state.behavior.set("prompt.submit", (params, reply, emit) => {
      reply({ status: "streaming" });
      setTimeout(() => {
        emit("message.complete", "rt1", {
          text: "again",
          status: "complete",
          usage: { input: 150, output: 30, context_used: 2000, context_max: 100000, context_percent: 2, model: "m1" },
        });
      }, 5);
    });
    await be.sendMessage("agent:hermes-t:main", "again", "run2", r2.hooks, {});
    check(
      "S1b: 第二轮 usage 差分（150-100=50 / 30-20=10）",
      r2.log.finals[0]?.meta?.usage?.input === 50 && r2.log.finals[0]?.meta?.usage?.output === 10,
      JSON.stringify(r2.log.finals[0]?.meta),
    );
    await be.stop();
  }

  // — 场景 2：非 UUID 历史 tail（telegram/cron 来源）走 session.resume 而非 create
  {
    const be = makeBackend(gw.port);
    const { log, hooks } = collectHooks();
    state.frames.length = 0;
    state.behavior.set("session.resume", (params, reply) => {
      reply({ session_id: "rt9", resumed: params.session_id, message_count: 3, messages: [] });
    });
    state.behavior.set("prompt.submit", (params, reply, emit) => {
      reply({ status: "streaming" });
      setTimeout(() => emit("message.complete", "rt9", { text: "resumed reply", status: "complete", usage: {} }), 5);
    });
    await be.sendMessage("agent:hermes-t:telegram_abc123", "hello", "r", hooks, {});
    const resumeFrame = state.frames.find((f) => f.method === "session.resume");
    check("S2: 历史会话走 session.resume（任何来源可恢复）", resumeFrame && resumeFrame.params.session_id === "telegram_abc123");
    check("S2: 没有误走 session.create", !state.frames.some((f) => f.method === "session.create"));
    check("S2: final 正常", log.finals.length === 1 && log.finals[0].t === "resumed reply");
    await be.stop();
  }

  // — 场景 3：审批阻塞 → prompt hook → respondChatPrompt 往返
  {
    const be = makeBackend(gw.port);
    const { log, hooks } = collectHooks();
    state.frames.length = 0;
    state.behavior.set("session.create", (p, reply) => reply({ session_id: "rt3", stored_session_id: "st3" }));
    let approvalResolved = null;
    state.behavior.set("approval.respond", (params, reply) => {
      approvalResolved = params;
      reply({ resolved: 1 });
    });
    state.behavior.set("prompt.submit", (params, reply, emit) => {
      reply({ status: "streaming" });
      setTimeout(() => emit("approval.request", "rt3", { command: "rm -rf /tmp/x", allow_permanent: true, choices: ["once", "session", "always", "deny"] }), 5);
    });
    const sendP = be.sendMessage("agent:hermes-t:main", "do it", "r", hooks, {});
    await wait(80);
    check(
      "S3: approval.request → prompt hook（kind/choices/command）",
      log.prompts.length === 1 && log.prompts[0].kind === "approval" && log.prompts[0].choices.length === 4 && /rm -rf/.test(log.prompts[0].command),
      JSON.stringify(log.prompts),
    );
    await be.respondChatPrompt("agent:hermes-t:main", { kind: "approval", choice: "once" });
    check("S3: approval.respond 打到网关（FIFO 无 request_id + choice）", approvalResolved && approvalResolved.choice === "once" && approvalResolved.session_id === "rt3" && approvalResolved.all === false);
    // 审批放行后模型继续 → complete 收轮
    for (const sock of state.sockets) {
      sock.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "message.complete", session_id: "rt3", payload: { text: "done", status: "complete", usage: {} } } }));
    }
    await sendP;
    check("S3: 审批放行后 final 到达", log.finals.length === 1 && log.finals[0].t === "done");
    await be.stop();
  }

  // — 场景 4：interim 封段（工具间隔解说） + complete 只带最后一段
  {
    const be = makeBackend(gw.port);
    const { log, hooks } = collectHooks();
    state.behavior.set("session.create", (p, reply) => reply({ session_id: "rt4", stored_session_id: "st4" }));
    state.behavior.set("prompt.submit", (params, reply, emit) => {
      reply({ status: "streaming" });
      setTimeout(() => {
        emit("message.delta", "rt4", { text: "seg1" });
        emit("message.interim", "rt4", { text: "seg1", already_streamed: true });
        emit("message.delta", "rt4", { text: "seg2" });
        emit("message.complete", "rt4", { text: "seg2", status: "complete", usage: {} });
      }, 5);
    });
    await be.sendMessage("agent:hermes-t:main", "x", "r", hooks, {});
    check("S4: interim hook 收到封段文本", log.interims.length === 1 && log.interims[0] === "seg1");
    check("S4: interim 后 delta 从零重新累积", log.deltas.join("|") === "seg1|seg2", JSON.stringify(log.deltas));
    check("S4: final 只是最后一段", log.finals.length === 1 && log.finals[0].t === "seg2");
    await be.stop();
  }

  // — 场景 5：complete status=error / 空回复 → error hook（不发 final）
  {
    const be = makeBackend(gw.port);
    const c1 = collectHooks();
    state.behavior.set("session.create", (p, reply) => reply({ session_id: "rt5", stored_session_id: "st5" }));
    state.behavior.set("prompt.submit", (params, reply, emit) => {
      reply({ status: "streaming" });
      setTimeout(() => emit("message.complete", "rt5", { text: "", status: "error", failure_reason: "billing wall hit", usage: {} }), 5);
    });
    await be.sendMessage("agent:hermes-t:main", "x", "s5-1", c1.hooks, {});
    check("S5: status=error → error hook（failure_reason 透出）", c1.log.errors.length === 1 && c1.log.errors[0] === "billing wall hit" && c1.log.finals.length === 0);
    const c2 = collectHooks();
    state.behavior.set("prompt.submit", (params, reply, emit) => {
      reply({ status: "streaming" });
      setTimeout(() => emit("message.complete", "rt5", { text: "", status: "complete", usage: {} }), 5);
    });
    await be.sendMessage("agent:hermes-t:main", "x", "s5-2", c2.hooks, {});
    check("S5: 空成功回复 → error hook（防 UI final 重载环）", c2.log.errors.length === 1 && c2.log.finals.length === 0, JSON.stringify(c2.log.errors));
    // 额度墙的真实载荷形状（tui_gateway/server.py: `if _billing_block:` 那一段）：
    // text=全文（含充值链接）、billing=结构化块、failure_reason=裸枚举 "billing"，
    // 且 failure_reason **只有额度墙才会出现**。裸枚举若排在前面，就把信息量最大的
    // 一类错误渲染成「billing」一个词——用户看不出撞了额度墙，更拿不到链接。
    const c3 = collectHooks();
    const billingText =
      "Billing or credits exhausted: HTTP 400: You're out of extra usage.\n\n" +
      "anthropic reported that your Claude subscription usage is exhausted for " +
      "claude-opus-4-8 (included quota + extra-usage credits).\n" +
      "Options: wait for the billing cycle to reset, or add extra usage at " +
      "https://claude.ai/settings/usage";
    state.behavior.set("prompt.submit", (params, reply, emit) => {
      reply({ status: "streaming" });
      setTimeout(
        () =>
          emit("message.complete", "rt5", {
            text: billingText,
            status: "error",
            failure_reason: "billing",
            billing: {
              provider: "anthropic",
              provider_label: "Anthropic",
              model: "claude-opus-4-8",
              billing_url: "https://claude.ai/settings/usage",
              is_nous: false,
              message: "anthropic reported that your Claude subscription usage is exhausted…",
            },
            usage: {},
          }),
        5,
      );
    });
    await be.sendMessage("agent:hermes-t:main", "x", "s5-3", c3.hooks, {});
    const billErr = c3.log.errors[0] || "";
    check("S5: 额度墙不吐裸枚举「billing」", billErr !== "billing", billErr);
    check(
      "S5: 额度墙气泡带全文 + 充值链接",
      /extra-usage credits/.test(billErr) && /claude\.ai\/settings\/usage/.test(billErr),
      billErr,
    );
    // 错误轮的转录行必须带 stopReason:"error"——error hook 的红气泡是内存态，
    // 下一次 loadHistory 会被 getHistory 的转录行整体替换；行上没有错误标记时
    // UI 按普通 assistant 气泡渲染（用户实拍：红错「过了一会儿」变白气泡）。
    const errRows = (be.transcripts.get("agent:hermes-t:main") || []).filter((m) => m.role === "assistant");
    const lastErrRow = errRows[errRows.length - 1];
    check(
      "S5: 错误转录行带 stopReason=error（重载后仍是红气泡）",
      lastErrRow && lastErrRow.stopReason === "error",
      JSON.stringify(lastErrRow && { stopReason: lastErrRow.stopReason }),
    );
    await be.stop();
  }

  // — 场景 7：切模型对齐官方桌面 —— resume 历史会话 + config.set --session --provider
  //   打到 live session_id，覆写 session override（不再降级 --global 遮蔽）。
  //   这是「切同一模型每个会话报各自旧 provider 错」bug 的根治验证。
  {
    const be = makeBackend(gw.port);
    state.frames.length = 0;
    state.behavior.set("session.resume", (params, reply) => reply({ session_id: "rt7", resumed: params.session_id }));
    let configSet = null;
    state.behavior.set("config.set", (params, reply) => { configSet = params; reply({ value: params.value }); });
    // 历史会话（xiaomi 的陈旧模型），切到 modelscope/ZhipuAI-GLM-5.2
    const res = await be.setSessionModel("agent:hermes-t:20260529_stale", { model: "ZhipuAI/GLM-5.2", provider: "modelscope" });
    const resumeFrame = state.frames.find((f) => f.method === "session.resume");
    check("S7: 历史会话切模型先 resume 建 live session", resumeFrame && resumeFrame.params.session_id === "20260529_stale");
    check("S7: config.set 打到 live runtime session_id（非空/非历史 tail）", configSet && configSet.session_id === "rt7");
    check("S7: value 带 --session（会话级覆写，不是 --global）", configSet && / --session\b/.test(configSet.value) && !/--global/.test(configSet.value), configSet?.value);
    check("S7: value 带显式 --provider（绕坏 agent build）", configSet && /--provider modelscope/.test(configSet.value), configSet?.value);
    check("S7: 返回 scope=session（不再 persist）", res.scope === "session");
    // main 键（还没发消息）→ create 一个 runtime 再 --session 覆写
    state.frames.length = 0; configSet = null;
    state.behavior.set("session.create", (p, reply) => reply({ session_id: "rt7m", stored_session_id: "st7m" }));
    await be.setSessionModel("agent:hermes-t:main", { model: "open/gpt-x", provider: "open" });
    check("S7: main 键切模型走 session.create", state.frames.some((f) => f.method === "session.create"));
    check("S7: main config.set 也 --session 到新 runtime", configSet && configSet.session_id === "rt7m" && / --session\b/.test(configSet.value));
    await be.stop();
  }

  // — 场景 8：切模型必须落在**已建好的 agent** 上（eager_build）+ 预热失败回退，
  //   以及网关追加的「切模型标记」不再当报错气泡渲染。
  //   病理：冷 resume 只还历史、agent 50ms 后台再建；这窗口里 config.set 带显式
  //   provider 会跳过网关自己的强制 build，`_apply_model_switch` 只把 override 钉进
  //   内存，随后延迟构建走 resume_runtime_overrides（state.db 的陈旧身份）把它丢掉
  //   → 切模型报成功、下一条消息仍走旧模型。
  {
    const be = makeBackend(gw.port);
    state.frames.length = 0;
    let configSet = null;
    state.behavior.set("session.resume", (params, reply) => reply({ session_id: "rt8", resumed: params.session_id }));
    state.behavior.set("config.set", (params, reply) => { configSet = params; reply({ value: params.value }); });
    await be.setSessionModel("agent:hermes-t:20260529_stale", { model: "tencent/hy3:free", provider: "nous" });
    const eager = state.frames.find((f) => f.method === "session.resume");
    check("S8: 切模型的 resume 带 eager_build（agent 建好再切，override 才不被丢）", eager?.params?.eager_build === true, JSON.stringify(eager?.params));
    check("S8: 仍打到 live runtime + --session --provider", configSet?.session_id === "rt8" && /--provider nous/.test(configSet.value));

    check("S8: agent 已建好时不做多余的构建探针", !state.frames.some((f) => f.method === "process.list"));

    // 思考档/fast 同款（create_*_override 被同一个分支丢掉）
    state.frames.length = 0;
    state.behavior.set("session.resume", (params, reply) => reply({ session_id: "rt8c", resumed: params.session_id }));
    await be.setSessionThinking("agent:hermes-t:20260531_x", { level: "high" });
    check("S8: 思考档同样 eager_build", state.frames.find((f) => f.method === "session.resume")?.params?.eager_build === true);

    state.frames.length = 0;
    const permission = await be.setSessionPermission("agent:hermes-t:20260531_x", { mode: "yolo" });
    const permissionSet = state.frames.find((f) => f.method === "config.set");
    check(
      "S8: 权限模式通过会话级 yolo 配置写入",
      permissionSet?.params?.key === "yolo" && permissionSet?.params?.value === "1"
        && permission.scope === "session",
      JSON.stringify(permissionSet?.params),
    );
    check(
      "S8: 权限模式即时投影回会话行",
      be.sessionLiveMeta.get("agent:hermes-t:20260531_x")?.permissionMode === "yolo",
    );

    // 网关在 in-place 切换后追加的标记行 → 时间线 notice，不是 system 报错文本
    state.restMessages = [
      { id: 1, role: "user", content: "hi", timestamp: 1 },
      {
        id: 2,
        role: "user",
        display_kind: "model_switch",
        timestamp: 2,
        content:
          "[System: The active model for this chat has changed to tencent/hy3:free via provider nous. " +
          "From this point forward, use this runtime metadata when answering questions about what model/provider is active.]",
      },
    ];
    const rows = await be._fetchHistoricalMessages("agent:hermes-t:20260529_stale");
    const marker = rows.find((r) => r.notice === "modelSwitch");
    check("S8: model_switch 行标成 notice（UI 折成一行，不再渲染成红色报错）", !!marker);
    check("S8: notice 带解析出的模型/提供方", marker?.model === "tencent/hy3:free" && marker?.provider === "nous", JSON.stringify(marker));
    check("S8: 原文保留在 content 里（hover 排障）", /From this point forward/.test(marker?.content?.[0]?.text || ""));
    check("S8: 普通消息不受影响", rows.filter((r) => r.role === "user" && !r.notice).length === 1);
    state.restMessages = [];
    await be.stop();
  }

  // — 场景 9：agent 建不出来的会话，切模型必须**报真实原因**，不许假成功。
  //   病理（R303）：网关的 `_apply_model_switch` 在 agent 为 None 时只把 override 钉进
  //   内存就回 ok（不换 client、不落 state.db、不追加标记），而 `_persist_live_session_runtime`
  //   见 agent 为 None 直接 early-return → UI 弹「已切换」，下一条消息仍走旧身份。
  //   两种建不出来：① 预热 resume 直接抛（stored provider 已不在 config / 凭证没了）；
  //   ② 会话早已 live 但 agent 是 None（resume 命中「已 live」快路，eager_build 被忽略，
  //   info 是 lazy 形状）。
  {
    const be = makeBackend(gw.port);
    // ① 预热失败 = 这条会话的存储身份构不出来 → 抛错带网关原文，且不再白发 config.set
    state.frames.length = 0;
    // 真机形状：**只有** eager resume 抛（`_make_agent` 立刻构不出来），冷 resume 照旧
    // 成功（它只还历史、把构建丢给后台定时器）——旧实现正是被这条"成功"骗了。
    state.behavior.set("session.resume", (params, reply, _emit, replyErr) => {
      if (params.eager_build) return replyErr(5000, "resume failed: Unknown provider 'custom:xm'. Check 'hermes model' for available providers");
      reply({ session_id: "rt9a", resumed: params.session_id });
    });
    let err9 = null;
    await be.setSessionModel("agent:hermes-t:20260610_dangling", { model: "minimaxai/minimax-m3", provider: "nvida" }).catch((e) => { err9 = e; });
    check("S9: 悬空 provider 的会话切模型抛错（不再假成功）", !!err9, String(err9));
    check("S9: 错误里带网关给的真实原因", /custom:xm/.test(err9?.message || ""), err9?.message);
    check("S9: 落不了地就不白发 config.set", !state.frames.some((f) => f.method === "config.set"));

    // ② 已 live 但 agent 未建（info.lazy）→ 只读 process.list 逼网关同步 build → 再切
    state.frames.length = 0;
    let configSet9 = null;
    state.behavior.set("session.resume", (params, reply) =>
      reply({ session_id: "rt9b", resumed: params.session_id, info: { lazy: true, model: "mimo-v2.5" } }),
    );
    state.behavior.set("process.list", (_p, reply) => reply({ processes: [] }));
    state.behavior.set("config.set", (params, reply) => { configSet9 = params; reply({ value: params.value }); });
    const res9 = await be.setSessionModel("agent:hermes-t:20260611_wedged", { model: "minimaxai/minimax-m3", provider: "nvida" });
    const probe = state.frames.find((f) => f.method === "process.list");
    check("S9: lazy live 会话先用 process.list 逼建 agent", probe?.params?.session_id === "rt9b", JSON.stringify(probe?.params));
    check("S9: 逼建成功后照旧 --session --provider 落地", configSet9?.session_id === "rt9b" && /--provider nvida/.test(configSet9.value) && res9.scope === "session");
    check("S9: 构建探针排在 config.set 之前", state.frames.findIndex((f) => f.method === "process.list") < state.frames.findIndex((f) => f.method === "config.set"));

    // ③ 逼建也失败 → 抛错带原因，仍不发 config.set
    state.frames.length = 0; configSet9 = null;
    state.behavior.set("process.list", (_p, reply, _emit, replyErr) => replyErr(5032, "No Anthropic credentials found."));
    let err9b = null;
    await be.setSessionModel("agent:hermes-t:20260612_wedged2", { model: "minimaxai/minimax-m3", provider: "nvida" }).catch((e) => { err9b = e; });
    check("S9: 逼建失败也抛错（凭证没了的会话）", /Anthropic credentials/.test(err9b?.message || ""), err9b?.message);
    check("S9: 逼建失败不发 config.set", !state.frames.some((f) => f.method === "config.set"));

    // ④ 新会话（create 路径）info 同样是 lazy，但**不**做构建探针——新会话没有陈旧
    //    override，钉进内存的 override 会被延迟构建采纳；R279「切模型不依赖坏 agent
    //    能初始化」这条路一步都不能丢。
    state.frames.length = 0; configSet9 = null;
    state.behavior.set("session.create", (_p, reply) => reply({ session_id: "rt9m", info: { lazy: true } }));
    await be.setSessionModel("agent:hermes-t:main", { model: "minimaxai/minimax-m3", provider: "nvida" });
    check("S9: main/新会话不做构建探针（守 R279）", !state.frames.some((f) => f.method === "process.list"));
    check("S9: main/新会话照旧切成", configSet9?.session_id === "rt9m" && /--provider nvida/.test(configSet9.value));

    // ⑤ 思考档/fast 同款（同一个 _apply_model_switch 假成功机理）
    state.frames.length = 0;
    state.behavior.set("session.resume", (params, reply, _emit, replyErr) => {
      if (params.eager_build) return replyErr(5000, "resume failed: Unknown provider 'custom:xm'");
      reply({ session_id: "rt9c", resumed: params.session_id });
    });
    let err9c = null;
    await be.setSessionThinking("agent:hermes-t:20260613_dangling", { level: "high" }).catch((e) => { err9c = e; });
    check("S9: 思考档同样报真实原因", /custom:xm/.test(err9c?.message || ""), err9c?.message);
    await be.stop();
  }

  // — 场景 6：网关拨不通 → GW_UNAVAILABLE → 回落 ACP（stub）+ 降级 TTL
  {
    const be = makeBackend(1); // 端口 1：必然拒连
    let acpCalled = null;
    be._sendViaAcp = async (ctx) => {
      acpCalled = ctx.sessionKey;
      ctx.hooks.final?.("acp says hi", false);
    };
    const { log, hooks } = collectHooks();
    await be.sendMessage("agent:hermes-t:main", "x", "r", hooks, {});
    check("S6: 拨号失败回落 ACP", acpCalled === "agent:hermes-t:main" && log.finals[0]?.t === "acp says hi");
    check("S6: 降级 TTL 记账", (be.gwChatDisabledUntil.get("tp") || 0) > Date.now());
    await be.stop();
  }

  // — 场景 10：idempotencyKey 在 Hermes 实例内跨调用去重；并发重复共享
  // 同一轮事件，已完成重复重放终态，不同 key / 无 key 保持原语义。
  {
    const be = makeBackend(gw.port);
    state.frames.length = 0;
    state.behavior.set("session.create", (_p, reply) => reply({ session_id: "rt10", stored_session_id: "st10" }));
    state.behavior.set("session.resume", (params, reply) => reply({
      session_id: `rt10-${params.session_id}`,
      resumed: params.session_id,
    }));
    let submits = 0;
    state.behavior.set("prompt.submit", (params, reply, emit) => {
      const submitNo = ++submits;
      reply({ status: "streaming" });
      setTimeout(() => emit("message.complete", params.session_id, { text: `answer-${submitNo}`, status: "complete", usage: {} }), 25);
    });
    const first = collectHooks();
    const duplicate = collectHooks();
    await Promise.all([
      be.sendMessage("agent:hermes-t:main", "hello", "idem-1", first.hooks, {}),
      be.sendMessage("agent:hermes-t:main", "hello", "idem-1", duplicate.hooks, {}),
    ]);
    check("S10: 并发同 key 只提交一次", submits === 1, `submit=${submits}`);
    check(
      "S10: 并发重复调用都收到同一终态",
      first.log.finals[0]?.t === "answer-1" && duplicate.log.finals[0]?.t === "answer-1",
      JSON.stringify([first.log.finals, duplicate.log.finals]),
    );

    const settled = collectHooks();
    await be.sendMessage("agent:hermes-t:main", "hello", "idem-1", settled.hooks, {});
    check("S10: settled 同 key 不重复提交", submits === 1);
    check("S10: settled 同 key 重放终态", settled.log.finals[0]?.t === "answer-1");

    const different = collectHooks();
    await be.sendMessage("agent:hermes-t:main", "hello", "idem-2", different.hooks, {});
    check("S10: 不同 key 保持独立提交", submits === 2, `submit=${submits}`);

    const crossA = collectHooks();
    const crossB = collectHooks();
    await Promise.all([
      be.sendMessage("agent:hermes-t:cross-a", "hello", "same-cross-key", crossA.hooks, {}),
      be.sendMessage("agent:hermes-t:cross-b", "hello", "same-cross-key", crossB.hooks, {}),
    ]);
    check("S10: 同 key 不同 session 不互相去重", submits === 4, `submit=${submits}`);
    check("S10: 不同 session 各自收到终态", crossA.log.finals.length === 1 && crossB.log.finals.length === 1);

    const noKeyA = collectHooks();
    const noKeyB = collectHooks();
    await be.sendMessage("agent:hermes-t:main", "hello", undefined, noKeyA.hooks, {});
    await be.sendMessage("agent:hermes-t:main", "hello", undefined, noKeyB.hooks, {});
    check("S10: 缺 key 不启用去重", submits === 6, `submit=${submits}`);
    await be.stop();
  }

  // — 场景 10b：settled cache 有 TTL 且按 LRU 有界；命中项不能被下一次
  // 容量淘汰，而过期项必须自然释放。
  {
    const be = makeBackend(1);
    const sessionKey = "agent:hermes-t:main";
    let executions = 0;
    be._sendMessageInner = async (_session, _message, _key, hooks) => {
      executions += 1;
      hooks.final?.("fresh", false);
    };
    const resolved = Promise.resolve();
    for (let index = 0; index < 256; index += 1) {
      be._idempotentSends.set(JSON.stringify([sessionKey, `seed-${index}`]), {
        listeners: new Set(),
        terminal: { method: "final", args: [`seed-${index}`, false] },
        settledAt: Date.now(),
        promise: resolved,
      });
    }
    const hit = collectHooks();
    await be.sendMessage(sessionKey, "ignored", "seed-0", hit.hooks, {});
    check("S10b: settled cache 命中不重新执行", executions === 0 && hit.log.finals[0]?.t === "seed-0");
    await be.sendMessage(sessionKey, "new", "new-key", collectHooks().hooks, {});
    check("S10b: cache 容量保持 256", be._idempotentSends.size === 256, String(be._idempotentSends.size));
    check(
      "S10b: LRU 命中项保留、最旧未命中项淘汰",
      be._idempotentSends.has(JSON.stringify([sessionKey, "seed-0"]))
        && !be._idempotentSends.has(JSON.stringify([sessionKey, "seed-1"])),
    );
    const expiredKey = JSON.stringify([sessionKey, "seed-2"]);
    be._idempotentSends.get(expiredKey).settledAt = 1;
    await be.sendMessage(sessionKey, "newer", "newer-key", collectHooks().hooks, {});
    check("S10b: TTL 过期项被淘汰", !be._idempotentSends.has(expiredKey));
    check("S10b: 淘汰后新 key 正常执行", executions === 2);
    await be.stop();
  }

  // — 场景 11：stop 必须经唯一收尾路径结束 live turn，清 timer 并让 send
  // promise 及时退出；不能只 clear map 留下 30 分钟悬挂 Promise。
  {
    const be = makeBackend(gw.port);
    state.frames.length = 0;
    state.behavior.set("session.create", (_p, reply) => reply({ session_id: "rt11", stored_session_id: "st11" }));
    state.behavior.set("prompt.submit", (_params, reply) => reply({ status: "streaming" }));
    const collector = collectHooks();
    const sending = be.sendMessage("agent:hermes-t:main", "never finishes", "stop-live", collector.hooks, {});
    const deadline = Date.now() + 1000;
    while (be.gwTurns.size === 0 && Date.now() < deadline) await wait(5);
    const turn = [...be.gwTurns.values()][0];
    check("S11: 已建立 live turn", !!turn);
    const before = JSON.stringify(collector.log);
    await be.stop();
    const settled = await Promise.race([
      sending.then(() => "resolved", () => "rejected"),
      wait(250).then(() => "timeout"),
    ]);
    check("S11: stop 后 send promise 及时退出", settled === "rejected", settled);
    check("S11: stop 经收尾路径清 timer/map", turn?.ended === true && turn?.timer === null && be.gwTurns.size === 0);
    await wait(40);
    check("S11: stop 后无迟到 hook", JSON.stringify(collector.log) === before);
    await be.stop();
  }

  gw.wss.close();
  gw.server.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("regression crashed:", err);
  process.exit(1);
});
