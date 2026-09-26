"use strict";

const os = require("node:os");
const { collectTranscriptReferencedArtifacts } = require("./session-artifact-references");

const MAX_PARTS = 300;
const MAX_BYTES = 384 * 1024;
const cut = (value, length = 6000) => typeof value === "string" ? value.slice(0, length) : "";
const contentText = value => typeof value === "string" ? value : Array.isArray(value)
  ? value.filter(part => part?.type === "text").map(part => part.text || "").join("") : "";
function timestamp(value) {
  const at = typeof value === "string" ? Date.parse(value) : value;
  return Number.isFinite(at) && at > 0 ? Math.round(at < 1e11 ? at * 1000 : at) : null;
}

function selectExecutionMessages(messages, execution, prompt, exactRun = false, local = false) {
  if (!Array.isArray(messages)) return { supported: false, reason: "unavailable", messages: [] };
  if (exactRun) return { supported: true, reason: null, messages };
  const identified = messages.filter(message => message?.runId === execution.runId);
  if (identified.length) return { supported: true, reason: null, messages: identified };
  // Unidentified remote timestamps cannot prove ownership across clock skew.
  if (!local) return { supported: false, reason: "run-unavailable", messages: [] };
  let start = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const at = timestamp(message?.timestamp);
    if (message?.role === "user" && contentText(message.content) === prompt && at !== null
      && at >= execution.createdAt && (execution.finishedAt === null || at <= execution.finishedAt)) start = i;
  }
  if (start < 0) return { supported: false, reason: "run-unavailable", messages: [] };
  let end = messages.findIndex((message, index) => index > start && message?.role === "user"
    && !(Array.isArray(message.content) && message.content.some(part => ["tool_result", "toolResult"].includes(part?.type))));
  if (end < 0) end = messages.length;
  return { supported: true, reason: null, messages: messages.slice(start, end) };
}

function activityParts(messages) {
  const parts = [];
  let bytes = 0, truncated = messages.length > 1000;
  const append = part => {
    const size = Buffer.byteLength(JSON.stringify(part));
    parts.push(part); bytes += size;
    while (parts.length > MAX_PARTS || bytes > MAX_BYTES) {
      bytes -= Buffer.byteLength(JSON.stringify(parts.shift())); truncated = true;
    }
  };
  for (const [index, message] of messages.slice(-1000).entries()) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const results = blocks.filter(part => ["tool_result", "toolResult"].includes(part?.type));
    if (results.length && ["tool", "toolResult", "user"].includes(message?.role)) {
      for (const [partIndex, part] of results.entries()) append({ id: `${message.id || index}:${partIndex}`, ts: timestamp(message.timestamp),
        type: "toolResult", toolCallId: cut(part.tool_use_id || part.toolCallId, 512), toolName: cut(part.name || message.toolName, 256),
        text: cut(contentText(part.content)), isError: part.is_error === true || part.isError === true,
        ...(Number.isFinite(part.durationS) ? { durationS: part.durationS } : {}) });
      continue;
    }
    if (!["assistant", "tool", "toolResult"].includes(message?.role)) continue;
    const base = { id: String(message.id || `message-${index}`), ts: timestamp(message.timestamp) };
    if (["tool", "toolResult"].includes(message.role)) {
      append({ ...base, type: "toolResult", toolCallId: cut(message.toolCallId || message.tool_call_id, 512),
        toolName: cut(message.toolName || message.name, 256), text: cut(contentText(message.content)), isError: message.isError === true,
        ...(Number.isFinite(message.durationS) ? { durationS: message.durationS } : {}) });
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: contentText(message.content) }];
    for (const [partIndex, part] of content.entries()) {
      if (!part || typeof part !== "object") continue;
      const identity = { ...base, id: `${base.id}:${partIndex}` };
      if (["toolCall", "tool_use"].includes(part.type)) {
        const args = part.arguments ?? part.args ?? part.input;
        const serialized = JSON.stringify(args ?? null);
        append({ ...identity, type: "toolCall", toolCallId: cut(part.id || part.toolCallId, 512),
          toolName: cut(part.name || part.toolName || "tool", 256),
          toolArgs: serialized.length <= 8000 ? args ?? null : cut(serialized, 8000) });
      } else if (part.type === "thinking") {
        append({ ...identity, type: "thinking", text: cut(part.thinking ?? part.text) });
      } else if (part.type === "plan" && Array.isArray(part.planEntries)) {
        append({ ...identity, type: "plan", planEntries: part.planEntries.slice(0, 30)
          .filter(entry => typeof entry?.content === "string")
          .map(entry => ({ content: cut(entry.content, 500), status: cut(entry.status, 32) })) });
      } else if (["image", "file", "audio", "video"].includes(part.type)) {
        const file = part.path || part.filePath || part.source?.path;
        if (typeof file === "string" && file.startsWith("/")) append({ ...identity, type: "artifact", text: cut(file, 4096) });
      } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        append({ ...identity, type: "text", text: cut(part.text) });
      }
    }
  }
  return { parts, truncated };
}

async function executionArtifacts(execution, parts, runtimeHome = os.homedir()) {
  const calls = [];
  const events = parts.filter(part => part.type !== "thinking").map(part => {
    let toolCallId = part.toolCallId;
    if (part.type === "toolCall") { toolCallId ||= part.id; calls.push(toolCallId); }
    if (part.type === "toolResult") {
      if (toolCallId) { const index = calls.indexOf(toolCallId); if (index >= 0) calls.splice(index, 1); }
      else toolCallId = calls.shift() || part.id;
    }
    return {
    runId: execution.runId, occurredAt: part.ts || execution.finishedAt || Date.now(),
    kind: part.type === "toolCall" ? "tool_call" : part.type === "toolResult" ? "tool_result" : "assistant",
    content: { text: part.text, arguments: part.toolArgs, toolCallId,
      ...(part.type === "toolResult" ? { tool: { success: !part.isError } } : {}) },
  }; });
  if (execution.resultSummary) events.push({ runId: execution.runId, kind: "assistant",
    occurredAt: execution.finishedAt || Date.now(), content: { text: execution.resultSummary } });
  const items = await collectTranscriptReferencedArtifacts({ events,
    runs: [{ id: execution.runId, startedAt: execution.createdAt, finishedAt: execution.finishedAt }],
    workspace: execution.workspace, runtimeHome, sessionCreatedAt: execution.createdAt, agentId: execution.agentId });
  return { supported: true, reason: null, items: items.slice(0, 50), hasMore: items.length > 50 };
}

async function loadInspirationActivity(registry, id, runId) {
  const { execution, prompt } = await registry._requireInspirationOwner().getInspirationActivityBinding(id, runId);
  if (execution.ideaId !== id || execution.runId !== runId) {
    throw Object.assign(new Error("运行不属于这条灵感"), { code: "INSPIRATION_BINDING_INVALID" });
  }
  const backend = registry._activeGet(execution.backendId);
  const empty = reason => ({ runId, trajectory: { supported: false, reason, parts: [], truncated: false },
    artifacts: { supported: false, reason, items: [], hasMore: false } });
  if (!backend) return empty("backend-unavailable");
  if (!execution.sessionKey || !execution.workspace) return empty("preparing");
  let history, local = execution.backendId !== "openclaw" || backend._isLocalGateway?.() === true;
  try {
    if (typeof backend.getInspirationHistory === "function") history = await backend.getInspirationHistory(execution);
    else if (execution.backendId === "openclaw") {
      const result = await backend.request("chat.history", { sessionKey: execution.sessionKey, limit: 200 }, 10000);
      history = { messages: result?.messages, exactRun: false, local };
    } else if (execution.backendId === "hermes") {
      history = { ...await backend.getHistory(execution.sessionKey), exactRun: false, local: true };
    }
  } catch { history = null; }
  const selected = selectExecutionMessages(history?.messages, execution, prompt, history?.exactRun, local);
  const projected = activityParts(selected.messages);
  let artifacts = { supported: false, reason: local ? "unavailable" : "remote", items: [], hasMore: false };
  if (local) {
    try { artifacts = await executionArtifacts(execution, projected.parts, history?.runtimeHome); } catch { /* Keep trajectory available. */ }
  }
  return { runId, trajectory: { supported: selected.supported, reason: selected.reason, ...projected }, artifacts };
}

module.exports = { selectExecutionMessages, activityParts, executionArtifacts, loadInspirationActivity };
