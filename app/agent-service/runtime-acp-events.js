"use strict";
const crypto = require("node:crypto");
const { unknownRuntimeContextUsage } = require("./runtime-context-usage");
const { acpData, acpId: id, acpPlain: plain } = require("./runtime-acp-ledger");
const { serviceError } = require("./security");
const fail = () => { throw serviceError("RUNTIME_PROTOCOL_INVALID", "ACP update is invalid"); };
const string = (v, max = 512 * 1024) => typeof v === "string" && v.isWellFormed() && !v.includes("\0") && Buffer.byteLength(v) <= max;
const integer = v => Number.isSafeInteger(v) && v >= 0;
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
function catalogs(result, current = null) {
  if (!plain(result)) fail();
  const next = current || { models: null, modes: null, commands: [], configOptions: [], contextUsage: null, revision: 0 };
  if (result.modes !== undefined && result.modes !== null) {
    const m = result.modes;
    if (!plain(m) || !id(m.currentModeId) || !Array.isArray(m.availableModes) || m.availableModes.length > 256
      || !m.availableModes.every(v => plain(v) && id(v.id) && string(v.name, 16384))
      || new Set(m.availableModes.map(v => v.id)).size !== m.availableModes.length
      || !m.availableModes.some(v => v.id === m.currentModeId)) fail();
    next.modes = JSON.parse(JSON.stringify(acpData(m, 256 * 1024)));
  }
  if (result.configOptions !== undefined) next.configOptions = result.configOptions === null ? [] : configOptions(result.configOptions);
  next.revision += 1;
  return next;
}
function configOptions(value) {
  if (!Array.isArray(value) || value.length > 256 || new Set(value.map(v => v?.id)).size !== value.length) fail();
  for (const option of value) {
    if (!plain(option) || !id(option.id) || !string(option.name, 16384) || !id(option.type)) fail();
    if (option.type === "select") {
      if (!id(option.currentValue) || !Array.isArray(option.options) || option.options.length > 256
        || !option.options.every(v => plain(v) && (id(v.value) && string(v.name, 16384)
          || id(v.group) && Array.isArray(v.options) && v.options.length <= 256
          && v.options.every(child => plain(child) && id(child.value) && string(child.name, 16384))))) fail();
    } else if (option.type === "boolean" && typeof option.currentValue !== "boolean") fail();
    // Legal future option types remain bounded opaque catalog entries. The
    // selection path rejects every type this adapter cannot execute.
    acpData(option, 64 * 1024);
  }
  return JSON.parse(JSON.stringify(acpData(value, 256 * 1024)));
}
function contentBlock(value) {
  if (!plain(value) || !id(value.type)) fail();
  if (value.type === "text" && !string(value.text)) fail();
  return snapshot(value);
}
function compaction(session, turn, update, now) {
  if (!id(update.compactionId)) fail();
  const all = session.metadata.compactions ||= [];
  let entity = all.find(v => v.id === update.compactionId);
  if (!entity) {
    if (all.length >= 512) fail();
    entity = { id: update.compactionId, itemId: `acp-compaction-${crypto.createHash("sha256")
      .update(JSON.stringify([session.id, update.compactionId])).digest("hex").slice(0, 32)}`,
      status: "in_progress", turnId: turn?.id ?? null, completedObserved: false };
    all.push(entity);
  }
  if (update.sessionUpdate === "compaction_update") {
    if (!id(update.status)) fail(); entity.status = update.status;
    if (Object.hasOwn(update, "summary")) {
      if (update.summary !== null && (!Array.isArray(update.summary) || update.summary.length > 1024)) fail();
      entity.summary = update.summary === null || update.summary.length === 0 ? null : update.summary.map(contentBlock);
      delete entity.summaryChunkMetadata;
    }
    if (Object.hasOwn(update, "error")) {
      if (update.error !== null && !string(update.error, 16384)) fail(); entity.error = update.error;
    }
    if (Object.hasOwn(update, "_meta")) {
      if (update._meta !== null && !plain(update._meta)) fail(); entity._meta = update._meta === null ? null : snapshot(update._meta);
    }
  } else {
    const block = contentBlock(update.content); entity.summary ||= [];
    if (entity.summary.length >= 1024 || (update._meta !== undefined && update._meta !== null && !plain(update._meta))) fail();
    entity.summary.push(block);
    if (update._meta != null) { entity.summaryChunkMetadata ||= [];
      entity.summaryChunkMetadata.push({ index: entity.summary.length - 1, metadata: snapshot(update._meta) }); }
  }
  const firstCompleted = entity.status === "completed" && !entity.completedObserved;
  if (firstCompleted) entity.completedObserved = true;
  acpData(entity, 512 * 1024);
  const owner = entity.turnId === turn?.id ? turn : session.turns?.find(v => v.id === entity.turnId);
  if (owner) {
    let item = owner.items.find(v => v.id === entity.itemId);
    if (item && item.type !== "contextCompaction") fail();
    const patch = { id: entity.itemId, type: "contextCompaction", compactionId: entity.id, status: entity.status,
      ...Object.fromEntries(["summary", "error", "_meta", "summaryChunkMetadata"].filter(key => Object.hasOwn(entity, key)).map(key => [key, entity[key]])) };
    if (!item) { if (owner.items.length >= 4096) fail(); owner.items.push(patch); }
    else { for (const key of ["summary", "error", "_meta", "summaryChunkMetadata"]) delete item[key]; Object.assign(item, patch); }
    boundary(owner);
  }
  const compact = { id: entity.id, status: entity.status,
    ...Object.fromEntries(["summary", "error", "_meta"].filter(key => Object.hasOwn(entity, key)).map(key => [key, entity[key]])) };
  const base = { sessionId: session.id, ...(turn ? { turnId: turn.id } : {}), itemId: entity.itemId };
  if (firstCompleted) {
    const contextUsage = unknownRuntimeContextUsage(session.id, { contextWindow: session.metadata.contextUsage?.contextWindow, observedAt: now });
    session.metadata.contextUsage = contextUsage;
    return { metadata: true, boundary: true, events: [{ ...base, type: "context_compacted", compactionId: entity.id, compaction: compact, contextUsage }] };
  }
  const status = entity.status === "in_progress" ? "compacting" : entity.status === "failed" ? "compaction_failed"
    : entity.status === "cancelled" ? "compaction_cancelled" : entity.status === "completed" ? "compaction_updated" : "compaction_unknown";
  return { metadata: true, boundary: true, events: [{ ...base, type: "status", status, compaction: compact }] };
}

function segment(turn, kind, nativeId) {
  if (nativeId !== undefined && !id(nativeId)) fail();
  const key = `${kind}:${nativeId || "implicit"}`;
  if (nativeId && turn.segments[key]) { turn.segments.openKind = kind; turn.segments.openId = turn.segments[key]; return turn.segments[key]; }
  if (!nativeId && turn.segments.openKind === kind && turn.segments.openId) return turn.segments.openId;
  if (turn.items.length >= 4096) fail();
  const itemId = nativeId || `${turn.id}-segment-${++turn.sequence}`;
  if (nativeId) turn.segments[key] = itemId;
  turn.segments.openKind = kind; turn.segments.openId = itemId;
  return itemId;
}
const boundary = turn => { delete turn.segments.openKind; delete turn.segments.openId; };
function snapshot(value) { return JSON.parse(JSON.stringify(acpData(value, 64 * 1024))); }
function sealContent(session, turn) {
  if (!turn || !["reasoning", "agentMessage"].includes(turn.segments.openKind)) return [];
  const item = turn.items.find(v => v.id === turn.segments.openId);
  if (!item || !["reasoning", "agentMessage"].includes(item.type)) return [];
  const key = `content-snapshot:${item.id}`, version = crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex");
  if (turn.segments[key] === version) return [];
  turn.segments[key] = version;
  const base = { sessionId: session.id, turnId: turn.id, itemId: item.id };
  return item.type === "reasoning" ? [{ ...base, type: "reasoning", reasoning: [...item.content] }]
    : [{ ...base, type: "text", text: item.text, phase: item.phase }];
}

function projectUpdate(session, turn, update, now = Date.now()) {
  if (!plain(update) || !id(update.sessionUpdate)) fail();
  const kind = update.sessionUpdate, base = { sessionId: session.id, ...(turn ? { turnId: turn.id } : {}) };
  if (kind === "available_commands_update") {
    if (!Array.isArray(update.availableCommands) || update.availableCommands.length > 256
      || !update.availableCommands.every(c => plain(c) && id(c.name) && string(c.description, 16384))) fail();
    session.metadata.commands = snapshot(update.availableCommands); session.metadata.revision += 1;
    return { metadata: true, events: [] };
  }
  if (kind === "config_option_update") {
    session.metadata.configOptions = configOptions(update.configOptions); session.metadata.revision += 1;
    return { metadata: true, events: [] };
  }
  if (kind === "current_mode_update") {
    if (!id(update.currentModeId)) fail();
    if (session.metadata.modes) session.metadata.modes.currentModeId = update.currentModeId;
    session.metadata.revision += 1; return { metadata: true, events: [] };
  }
  if (kind === "session_info_update") {
    if (update.title !== undefined && update.title !== null && !string(update.title, 16384)) fail();
    if (update.updatedAt !== undefined && update.updatedAt !== null && !string(update.updatedAt, 256)) fail();
    // Product-local naming remains authoritative; native title is metadata only.
    if (Object.hasOwn(update, "title")) session.metadata.nativeTitle = update.title; session.metadata.revision += 1;
    return { metadata: true, events: [] };
  }
  if (kind === "usage_update") {
    if (!integer(update.used) || !integer(update.size)) fail();
    const contextUsage = { runtimeSessionId: session.id, usedTokens: update.used,
      contextWindow: update.size > 0 ? update.size : null, quality: "exact", source: "runtime_event", observedAt: now };
    session.metadata.contextUsage = contextUsage;
    if (Object.hasOwn(update, "cost")) {
      if (update.cost !== null && (!plain(update.cost) || typeof update.cost.amount !== "number" || !Number.isFinite(update.cost.amount)
        || update.cost.amount < 0 || !string(update.cost.currency, 16))) fail();
      session.metadata.cost = update.cost === null ? null : snapshot(update.cost);
    }
    return { metadata: true, events: [{ ...base, type: "context_usage", contextUsage }] };
  }
  if (["compaction_update", "compaction_summary_chunk"].includes(kind)) {
    const prior = sealContent(session, turn), result = compaction(session, turn, update, now);
    result.events.unshift(...prior); return result;
  }
  if (!turn) return { diagnostic: true, events: [] };
  if (["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(kind)) {
    if (!plain(update.content) || update.content.type !== "text" || !string(update.content.text)) fail();
    const itemKind = kind === "agent_message_chunk" ? "agentMessage" : kind === "agent_thought_chunk" ? "reasoning" : "userMessage";
    const prior = turn.segments.openKind !== itemKind || update.messageId != null && turn.segments.openId !== update.messageId ? sealContent(session, turn) : [];
    const itemId = segment(turn, itemKind, update.messageId ?? undefined);
    let item = turn.items.find(v => v.id === itemId);
    if (item && item.type !== itemKind) fail();
    if (!item) {
      item = itemKind === "reasoning" ? { id: itemId, type: itemKind, summary: [], content: [""] }
        : itemKind === "userMessage" ? { id: itemId, type: itemKind, content: [{ type: "text", text: "" }] }
          : { id: itemId, type: itemKind, text: "", phase: "final_answer" };
      turn.items.push(item);
    }
    if (itemKind === "reasoning") item.content[0] += update.content.text;
    else if (itemKind === "userMessage") item.content[0].text += update.content.text;
    else item.text += update.content.text;
    acpData(turn.items);
    return { boundary: prior.length > 0, events: [...prior, ...(itemKind === "userMessage" ? [] : [{ ...base,
      type: itemKind === "reasoning" ? "reasoning_delta" : "text_delta", itemId, delta: update.content.text }])] };
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    if (!id(update.toolCallId) || (kind === "tool_call" && !string(update.title, 16384))
      || (update.title !== undefined && update.title !== null && !string(update.title, 16384))
      || (update.kind !== undefined && update.kind !== null && !id(update.kind))
      || (update.status !== undefined && update.status !== null && !TOOL_STATUSES.has(update.status))) fail();
    const prior = sealContent(session, turn); boundary(turn); const itemId = update.toolCallId;
    let item = turn.items.find(v => v.id === itemId);
    if (item && item.type !== "dynamicToolCall") fail();
    if (!item) {
      if (kind !== "tool_call" || turn.items.length >= 4096) fail();
      item = { id: itemId, type: "dynamicToolCall", namespace: "acp", tool: update.title,
        arguments: null, status: "pending", success: null, contentItems: null }; turn.items.push(item);
    }
    if (update.title) item.tool = update.title;
    if (update.rawInput !== undefined) item.arguments = snapshot(update.rawInput);
    const previouslyCompleted = item.status === "completed" || item.status === "failed";
    if (update.status && (!previouslyCompleted || ["completed", "failed"].includes(update.status))) item.status = update.status;
    const completed = item.status === "completed" || item.status === "failed";
    if (completed) { item.success = item.status === "completed";
      if (update.rawOutput !== undefined || update.content !== undefined) item.contentItems = snapshot(update.rawOutput ?? update.content); }
    const tool = { name: item.tool, kind: update.kind || "other", status: item.status,
      ...(item.arguments !== null ? { input: item.arguments } : {}),
      ...(completed ? { success: item.success, output: item.contentItems } : {}) };
    const startKey = `tool-start:${itemId}`, resultKey = `tool-result:${itemId}`;
    const type = completed ? turn.segments[resultKey] ? "tool_update" : "tool_result"
      : kind === "tool_call" && !turn.segments[startKey] ? "tool_start" : "tool_update";
    turn.segments[startKey] = true; if (completed) turn.segments[resultKey] = true;
    return { boundary: true, events: [...prior, { ...base, type, itemId, toolCallId: itemId, tool }] };
  }
  if (kind === "plan") {
    if (!Array.isArray(update.entries) || update.entries.length > 256 || !update.entries.every(v => plain(v)
      && string(v.content, 16384) && ["high", "medium", "low"].includes(v.priority)
      && ["pending", "in_progress", "completed"].includes(v.status))) fail();
    const prior = sealContent(session, turn); boundary(turn); const itemId = `${turn.id}-plan`;
    let item = turn.items.find(v => v.id === itemId);
    const text = update.entries.map(v => v.content).join("\n");
    if (!item) { item = { id: itemId, type: "plan", text, entries: snapshot(update.entries) }; turn.items.push(item); }
    else { item.text = text; item.entries = snapshot(update.entries); }
    return { boundary: true, events: [...prior, { ...base, type: "plan", itemId, plan: snapshot(update.entries) }] };
  }
  // No unknown native method or field can upgrade acceptance, authority, usage
  // quality, compaction or retention. Caller keeps only a bounded kind counter.
  acpData(update, 64 * 1024); return { diagnostic: true, events: [] };
}
module.exports = { projectAcpUpdate: projectUpdate, acpSessionCatalogs: catalogs, sealAcpContent: sealContent };
