"use strict";
const { OpenClawBackend } = require("../../app/core/openclaw-backend");
const { HermesBackend } = require("../../app/core/hermes-backend");
const { ShoggothBackend } = require("../../app/core/shoggoth-backend");
const { BackendRegistry } = require("../../app/core/backend-registry");

const cases = [
  { id: "openclaw", agentId: "history-openclaw", backendId: "openclaw", name: "OpenClaw" },
  { id: "hermes", agentId: "hermes-history", backendId: "hermes", name: "Hermes" },
  { id: "native", agentId: "shoggoth-history", backendId: "shoggoth", name: "Native" },
  { id: "desktop", agentId: "shoggoth-desktop", backendId: "shoggoth", name: "Codex Desktop" },
].map(row => ({ ...row, key: `agent:${row.agentId}:history-fixture` }));
function transcript(label, count = 181) {
  const messages = [], timestamp = 1800000000000;
  const add = (role, content, extra = {}) => messages.push({
    id: `${label}-${messages.length}`, role, content, timestamp: timestamp + messages.length * 1000, ...extra,
  });
  for (let index = 0; index < count; index++) {
    if (index % 2) {
      add("assistant", [{ type: "thinking", thinking: "检查分页边界与工具过程。" }]);
      add("assistant", [{ type: "toolCall", id: `tool-${index}`, name: "fixture_read", arguments: { index } }]);
      add("toolResult", [{ type: "text", text: "隔离工具结果" }], { toolCallId: `tool-${index}`, toolName: "fixture_read" });
    }
    add(index % 2 ? "assistant" : "user", [{ type: "text",
      text: `HIST_${label}_${String(index).padStart(3, "0")} ${index % 2 ? "这是助手正文，工具和思考不计入 50 条。" : "这是用户消息。"}`
        + (index === 73 ? "\n\n这是一段较长的历史正文，用于检查翻页后视口是否保持原位。".repeat(120) : ""),
    }]);
    if (index % 10 === 0) {
      add("user", [{ type: "text", text: "[OpenClaw heartbeat poll]" }]);
      add("assistant", [{ type: "text", text: "HEARTBEAT_OK" }]);
      add("user", [{ type: "text", text: "[Inter-session message] sourceSession=hidden internal input" }]);
      add("user", [{ type: "text", text: "[Request interrupted by user]" }]);
    }
  }
  return messages;
}
function createHistoryBackends() {
  const registry = new BackendRegistry(), histories = new Map(cases.map(row => [row.key, transcript(row.id)]));
  const revisions = new Map(cases.map(row => [row.key, 1]));
  const controls = { fail: new Set(), delay: 20, requests: [], watches: [], hooks: new Map(), created: [] };
  const createEmpty = agentId => {
    const row = cases.find(item => item.agentId === agentId);
    const key = `agent:${agentId}:fresh-${controls.created.length + 1}`;
    controls.created.push({ ...row, key }); histories.set(key, []); revisions.set(key, 1);
    return key;
  };
  const waitRead = async (kind, key, cursor) => {
    controls.requests.push({ kind, key, cursor });
    await new Promise(resolve => setTimeout(resolve, controls.delay));
    if (cursor && controls.fail.has(key)) throw Object.assign(Error("isolated history failure"), { code: "FIXTURE_OFFLINE" });
  };
  const openclaw = new OpenClawBackend({ authResolver: {} });
  openclaw.createSession = async agentId => createEmpty(agentId);
  const binding = { digest: "isolated-history-source" };
  openclaw._endpointGuard = { capture: () => binding, isCurrent: value => value === binding };
  openclaw.request = async (method, params) => {
    if (method !== "chat.history") throw Error(`unexpected upstream call: ${method}`);
    await waitRead("openclaw", params.sessionKey, params.offset);
    const all = histories.get(params.sessionKey), end = all.length - (params.offset || 0), start = Math.max(0, end - params.limit);
    return { messages: all.slice(start, end), sessionId: "physical", totalMessages: all.length,
      hasMore: start > 0, ...(start ? { nextOffset: all.length - start } : {}) };
  };
  const hermes = new HermesBackend({});
  hermes.profileById.set("hermes-history", "isolated");
  hermes.dashboards.set("isolated", { baseUrl: "http://127.0.0.1:1", token: "fixture" });
  hermes.getChatCacheScope = () => "isolated-hermes";
  hermes._gatewayChatEnabled = () => true;
  hermes._settingsGet = async () => ({ model: "fixture-model", provider: "fixture" });
  hermes._gwSocket = () => ({ generation: 1, request: async method => {
    if (method !== "session.create") throw Error(`unexpected Hermes gateway call: ${method}`);
    const key = createEmpty(cases[1].agentId), storedId = key.split(":").slice(2).join(":");
    return { session_id: `runtime-${storedId}`, stored_session_id: storedId, info: { lazy: true } };
  } });
  hermes._httpGet = async input => {
    const url = new URL(input), query = url.searchParams;
    const key = `agent:${cases[1].agentId}:${decodeURIComponent(url.pathname.split("/")[3])}`;
    const limit = Number(query.get("limit")), offset = Number(query.get("offset"));
    if (query.get("order") !== "latest") throw Error("fixture expects explicit latest paging");
    await waitRead("hermes", key, offset);
    if (hermes.freshSessionKeys.has(key)) return { status: 404, body: "{}" };
    const all = histories.get(key).map((row, index) => ({
      id: index + 1, role: row.role === "toolResult" ? "tool" : row.role,
      content: row.content.filter(part => part.type === "text").map(part => part.text).join(""),
      reasoning: row.content.find(part => part.type === "thinking")?.thinking,
      tool_calls: row.content.filter(part => part.type === "toolCall").map(part => ({
        id: part.id, function: { name: part.name, arguments: JSON.stringify(part.arguments) },
      })),
      tool_call_id: row.toolCallId, tool_name: row.toolName, timestamp: row.timestamp / 1000,
    }));
    const end = all.length - offset, start = Math.max(0, end - limit), messages = all.slice(start, end);
    return { status: 200, body: JSON.stringify({ session_id: "durable", messages,
      pagination: { limit, offset, order: "latest", returned: messages.length } }) };
  };
  const native = new ShoggothBackend({ requestService: async () => { throw Error("real Service forbidden"); } });
  native.createSession = async agentId => createEmpty(agentId);
  native._nativeUiAvailable = true;
  native._codexDesktopEntries.set(cases[3].key, { threadId: cases[3].key, homeIdentity: "isolated-desktop" });
  native._sessionTarget = key => ({ profile: { id: key.split(":")[1] }, sessionKey: key,
    session: { runtimeBindingId: "fixture-binding", status: "idle" } });
  native._call = async (method, params) => {
    if (!["chat.history", "codex.desktop.history"].includes(method)) throw Error(`unexpected Service method ${method}`);
    const key = params.sessionKey || params.threadId;
    await waitRead(method, key, params.cursor);
    const position = params.cursor ? JSON.parse(params.cursor) : null;
    if (position && position.revision !== revisions.get(key)) throw Object.assign(Error("cursor revision changed"), { code: "CURSOR_INVALID" });
    const all = histories.get(key), end = position?.end ?? all.length, start = Math.max(0, end - params.limit);
    return { messages: all.slice(start, end).map(message => ({ fragment: null, payload: { message } })),
      hasMore: start > 0, nextCursor: start ? JSON.stringify({ end: start, revision: revisions.get(key) }) : null };
  };
  for (const backend of [openclaw, hermes, native]) {
    const owned = cases.filter(row => row.backendId === backend.id);
    backend.getAgents = () => owned.map(row => ({ id: row.agentId, name: row.name, backendId: row.backendId }));
    backend.ownsAgentId = id => owned.some(row => row.agentId === id);
    backend.claimsAgentId = backend.ownsAgentId;
    backend.getSessionRows = () => [...owned, ...controls.created.filter(row => row.backendId === backend.id)].map(row => ({ key: row.key, label: row.name, agentName: row.name,
      backendId: row.backendId, updatedAt: 1800000000000 }));
    backend.getAgentsSnapshot = () => ({ agents: backend.getAgents(), complete: true });
    backend.getSessionRowsSnapshot = () => ({ rows: backend.getSessionRows(), complete: true });
    backend.getModelChoices = () => [];
    backend.watchSession = (key, hooks, { signal }) => new Promise(resolve => {
      controls.watches.push(key); controls.hooks.set(key, hooks);
      signal.addEventListener("abort", () => { if (controls.hooks.get(key) === hooks) controls.hooks.delete(key); resolve(); }, { once: true });
    });
    backend.getPendingChatPrompts = () => [];
    registry.register(backend);
  }
  return { registry, histories, controls, cases,
    append(key) {
      const row = [...cases, ...controls.created].find(row => row.key === key), all = histories.get(key);
      hermes.freshSessionKeys.delete(key); hermes.freshSessionTransports.delete(key);
      const added = { id: `${row.id}-arrival-${revisions.get(key)}`, role: "assistant",
        content: [{ type: "text", text: `HIST_${row.id}_999 新消息到达，保留已展开的历史。` }], timestamp: 1800001000000 };
      all.push(added); revisions.set(key, revisions.get(key) + 1);
      controls.hooks.get(key)?.final(added.content[0].text, false, { runId: "fixture-arrival" });
    },
  };
}
module.exports = { cases, transcript, createHistoryBackends };
