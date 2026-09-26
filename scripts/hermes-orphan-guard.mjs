// 复现并锁定「.openclaw 孤儿 hermes-default 让聊天出错」这一整类 bug 的回归。
//
// 根因：归属判定 ownsAgentId 依赖运行时就绪（Hermes 要等 dashboard 起来填 profileById），
// 启动竞态窗口里自家 agent 被误判无主 → ① 切模型的 session-write 漏给上游网关建孤儿；
// ② 孤儿又让 hermes-* 行提前进 roster、缓存降级能力。修复引入静态命名空间 claimsAgentId
// （hermes-* 前缀，不随就绪翻转），三处共用：透传闸拒漏、注入滤孤儿、能力打 notReady。
//
// 本脚本用真实 proxy + registry + 假上游网关（故意返回孤儿），断言：
//   A. 未就绪时上游 agents.list 里的孤儿 hermes-* 被滤掉
//   B. 未就绪时上游 sessions.list 里的孤儿 agent:hermes-*:… session 被滤掉
//   C. 未就绪时 hermes-* 的 sessions.patch{model} 被拒(BACKEND_NOT_READY)且绝不透传上游
//   D. 非 hermes 命名空间的未知 agent 不被误伤(仍按旧语义)
//   E. 就绪后 hermes-live 正常注入、孤儿仍被滤

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { BackendRegistry } from "../app/core/backend-registry.js";
import { AgentBackend } from "../app/core/agent-backend.js";
import { startProxyGateway } from "../app/core/proxy-gateway.js";

// 模拟未就绪→就绪的 Hermes：claimsAgentId 恒认 hermes-*（静态命名空间），
// ownsAgentId 只在就绪后认领具体 profile（模拟 profileById 填充时机）。
class HermesNsBackend extends AgentBackend {
  constructor() { super(); this.ready = false; this.modelSwitches = []; }
  get id() { return "mock-hermes"; }
  claimsAgentId(id) { return typeof id === "string" && id.startsWith("hermes-"); }
  ownsAgentId(id) { return this.ready && id === "hermes-live"; }
  getAgents() { return this.ready ? [{ id: "hermes-live", name: "Hermes Live" }] : []; }
  getSessionRows() { return this.ready ? [{ key: "agent:hermes-live:main", kind: "direct" }] : []; }
  async setSessionModel(sessionKey, opts) { this.modelSwitches.push({ sessionKey, ...opts }); return { model: opts.model, scope: "session" }; }
}

const ORPHAN_AGENT = "hermes-default"; // 上游网关因孤儿 store 而返回的 hermes-* agent
const ORPHAN_SESSION = "agent:hermes-default:ed3fa720-eaa7-432e-a644-28548d929c53";

// --- 假上游 OpenClaw 网关：故意在 agents/sessions list 里带孤儿 ---
const upstreamReceived = [];
const upstreamHttp = createServer();
const upstreamWss = new WebSocketServer({ server: upstreamHttp });
upstreamWss.on("connection", (sock) => {
  sock.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n1" } }));
  sock.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    upstreamReceived.push(frame);
    if (frame.type !== "req") return;
    const ok = (payload) => sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    if (frame.method === "connect") return ok({ type: "hello-ok", protocol: 1, auth: { role: "operator", scopes: [] } });
    if (frame.method === "agents.list") return ok({ agents: [{ id: "main", name: "Main" }, { id: ORPHAN_AGENT, name: "orphan!" }] });
    if (frame.method === "sessions.list") return ok({ sessions: [{ key: "agent:main:main", kind: "direct" }, { key: ORPHAN_SESSION, kind: "direct" }], count: 2 });
    return ok({});
  });
});
await new Promise((r) => upstreamHttp.listen(0, "127.0.0.1", r));
const upstreamUrl = `ws://127.0.0.1:${upstreamHttp.address().port}`;

// --- proxy + registry ---
const registry = new BackendRegistry();
const hermes = new HermesNsBackend();
registry.register(hermes);
const proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => upstreamUrl, registry });

// --- 假 UI client ---
const client = new WebSocket(proxy.url);
const frames = [];
const waiters = [];
client.on("message", (data) => {
  const f = JSON.parse(data.toString());
  frames.push(f);
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].match(f)) waiters.splice(i, 1)[0].resolve(f);
});
function waitFor(match, label, ms = 2500) {
  const hit = frames.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
}
const send = (f) => client.send(JSON.stringify(f));
await new Promise((r) => client.on("open", r));

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra });

try {
  await waitFor((f) => f.event === "connect.challenge", "challenge");
  send({ type: "req", id: "c", method: "connect", params: {} });
  await waitFor((f) => f.id === "c" && f.type === "res", "connect");

  // registry.claimsAgentId 单元断言（静态命名空间，不随就绪翻转）
  check("registry.claimsAgentId(hermes-*)=true 即使未就绪", registry.claimsAgentId("hermes-default") === true && hermes.ready === false);
  check("registry.claimsAgentId(非hermes)=false", registry.claimsAgentId("main") === false);
  check("registry.route(hermes-default)=null（未就绪）", registry.route("hermes-default") === null);

  // ---- A. 未就绪：agents.list 孤儿被滤 ----
  send({ type: "req", id: "a1", method: "agents.list", params: {} });
  const a1 = await waitFor((f) => f.id === "a1" && f.type === "res", "agents.list#1");
  const ids1 = (a1.payload?.agents ?? []).map((x) => x.id);
  check("A: agents.list 保留真实 main", ids1.includes("main"), JSON.stringify(ids1));
  check("A: agents.list 滤掉孤儿 hermes-default", !ids1.includes(ORPHAN_AGENT), JSON.stringify(ids1));

  // ---- B. 未就绪：sessions.list 孤儿 session 被滤 ----
  send({ type: "req", id: "s1", method: "sessions.list", params: {} });
  const s1 = await waitFor((f) => f.id === "s1" && f.type === "res", "sessions.list#1");
  const keys1 = (s1.payload?.sessions ?? []).map((x) => x.key);
  check("B: sessions.list 保留真实 agent:main:main", keys1.includes("agent:main:main"), JSON.stringify(keys1));
  check("B: sessions.list 滤掉孤儿 agent:hermes-default:…", !keys1.includes(ORPHAN_SESSION), JSON.stringify(keys1));

  // ---- C. 未就绪：hermes-* 的 sessions.patch{model} 被拒且不透传（根治点）----
  const patchBefore = upstreamReceived.filter((f) => f.method === "sessions.patch").length;
  send({ type: "req", id: "p1", method: "sessions.patch", params: { key: "agent:hermes-default:xyz", model: "qclaw/modelroute" } });
  const p1 = await waitFor((f) => f.id === "p1" && f.type === "res", "sessions.patch#1");
  check("C: hermes-* patch 未就绪被拒", p1.ok === false && p1.error?.code === "BACKEND_NOT_READY", JSON.stringify(p1.error));
  await new Promise((r) => setTimeout(r, 120));
  check("C: hermes-* patch 绝不透传上游（不建孤儿）", upstreamReceived.filter((f) => f.method === "sessions.patch").length === patchBefore);

  // ---- D. 非 hermes 命名空间不误伤：未知 agent 的 chat.send 仍透传 ----
  const sendBefore = upstreamReceived.filter((f) => f.method === "chat.send").length;
  send({ type: "req", id: "d1", method: "chat.send", params: { sessionKey: "agent:brand-new:main", message: "yo" } });
  await waitFor((f) => f.id === "d1" && f.type === "res", "chat.send#d1");
  await new Promise((r) => setTimeout(r, 120));
  check("D: 非命名空间未知 agent 仍透传（不误伤）", upstreamReceived.filter((f) => f.method === "chat.send").length === sendBefore + 1);

  // ---- E. 就绪后：hermes-live 正常注入，孤儿仍被滤，patch 本地处理 ----
  hermes.ready = true;
  send({ type: "req", id: "a2", method: "agents.list", params: {} });
  const a2 = await waitFor((f) => f.id === "a2" && f.type === "res", "agents.list#2");
  const ids2 = (a2.payload?.agents ?? []).map((x) => x.id);
  check("E: 就绪后注入 hermes-live", ids2.includes("hermes-live"), JSON.stringify(ids2));
  check("E: 就绪后孤儿 hermes-default 仍被滤", !ids2.includes(ORPHAN_AGENT), JSON.stringify(ids2));

  const patchBefore2 = upstreamReceived.filter((f) => f.method === "sessions.patch").length;
  send({ type: "req", id: "p2", method: "sessions.patch", params: { key: "agent:hermes-live:main", model: "grok/x" } });
  const p2 = await waitFor((f) => f.id === "p2" && f.type === "res", "sessions.patch#2");
  check("E: 就绪后 hermes-live patch 本地处理成功", p2.ok === true && p2.payload?.resolved?.model === "x", JSON.stringify(p2.payload));
  await new Promise((r) => setTimeout(r, 120));
  check("E: 就绪后 patch 仍不透传上游", upstreamReceived.filter((f) => f.method === "sessions.patch").length === patchBefore2);
  check("E: setSessionModel 收到 hermes-live 切换", hermes.modelSwitches.some((m) => m.sessionKey === "agent:hermes-live:main"));

  // ---- F. 真实 HermesBackend.getChatCapabilities 的 notReady 语义（命令退化的自愈钥匙）----
  // 不 start → profileById 空（模拟 dashboard 冷启动竞态窗口）。
  const { HermesBackend } = await import("../app/core/hermes-backend.js");
  const hb = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  const capNotReady = hb.getChatCapabilities("hermes-default");
  check("F: 未就绪 hermes-* → notReady:true（UI 不缓存、重取）", capNotReady.notReady === true && !capNotReady.slash, JSON.stringify(capNotReady));
  const capUnknown = hb.getChatCapabilities("totally-unknown");
  check("F: 未就绪非命名空间 → 不打 notReady（真未知，不无限重试）", !capUnknown.notReady, JSON.stringify(capUnknown));
  await hb.stop().catch(() => {});
} catch (err) {
  check(`exception: ${err.message}`, false);
}

client.close();
await proxy.close();
await new Promise((r) => upstreamWss.close(() => upstreamHttp.close(r)));

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  ${r.extra ?? ""}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
