"use strict";

const { hasSecret } = require("./memory-engine");
const crypto = require("node:crypto");

const TERMINAL_PHASES = new Set(["completed", "failed", "cancelled"]);
const PHASES = new Set(["preparing", "queued", "running", "tool", "text", "waiting_approval", "waiting_input",
  "compacting", "compacted", "stopping", "reconciling", ...TERMINAL_PHASES]);
const TITLES = Object.freeze({ preparing: "准备执行", queued: "排队等待", running: "执行中", tool: "工具执行",
  text: "生成正文", waiting_approval: "等待审批", waiting_input: "等待补充", stopping: "停止待确认",
  reconciling: "执行待核对", compacting: "正在压缩上下文", compacted: "上下文已压缩",
  completed: "已完成", failed: "执行失败", cancelled: "已取消" });
const BINDING_FIELDS = ["groupId", "discussionId", "memberId", "opportunityId", "taskId", "attemptId", "runId", "executionGeneration"];
const SECRET_KEY = /(?:password|secret|token|credential|authorization|api[_-]?key|groupToken)/iu;
const MAX_DETAIL_BYTES = 2048;
const MAX_TEXT_CHARS = 4000;
const textTail = text => {
  if (text.length <= MAX_TEXT_CHARS) return text;
  let start = text.length - MAX_TEXT_CHARS + 1;
  if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
  return `…${text.slice(start)}`;
};

// Public Run events have already passed the Coordinator's disclosure rules. Apply a
// second, bounded redaction at the cross-backend projection boundary; never store raw logs.
function safeValue(value, depth = 0, budget = { bytes: MAX_DETAIL_BYTES }) {
  if (depth > 5 || budget.bytes <= 0) return "[截断]";
  budget.bytes -= 8;
  if (typeof value === "string") {
    if (hasSecret(value) || /gt1\.[tk]\.[a-f0-9-]{36}\.[A-Za-z0-9_-]+/u.test(value)) return "[已隐去]";
    let text = "";
    for (const char of value.toWellFormed().replace(/\0/gu, "\ufffd")) {
      const bytes = Buffer.byteLength(char); if (bytes > budget.bytes) break;
      budget.bytes -= bytes; text += char;
    }
    return text.length === value.length ? text : `${text}…`;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.slice(0, 24).map(item => safeValue(item, depth + 1, budget));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).slice(0, 24).map(([key, item]) => {
      budget.bytes -= Buffer.byteLength(key.slice(0, 96));
      return [key.slice(0, 96), SECRET_KEY.test(key) ? "[已隐去]" : safeValue(item, depth + 1, budget)];
    }));
  }
  return null;
}

function toolTitle(name, args) {
  const safe = safeValue(args);
  const tool = String(name ?? "").replace(/^(?:mcp__shoggoth__|shoggoth__|shoggoth\/)/u, "").toLowerCase();
  if (["exec", "exec_command", "execute_bash", "terminal", "run_shell_command"].includes(tool)) {
    const explicit = safe && typeof safe === "object" ? safe.title ?? safe.description : null;
    if (typeof explicit === "string" && explicit !== "[已隐去]") return explicit.replace(/\s+/gu, " ").slice(0, 100);
    return "执行命令";
  }
  const labels = { read: "读取文件", read_file: "读取文件", readfile: "读取文件", write: "写入文件", write_file: "写入文件",
    edit: "编辑文件", apply_patch: "编辑文件", edit_file: "编辑文件", grep: "搜索文件", grep_search: "搜索文件",
    glob: "查找文件", find: "查找文件", web_search: "搜索网页", web_fetch: "读取网页", browser: "浏览网页",
    update_plan: "更新计划", group_task: "推进群任务", group_collaborate: "群聊协作", group_messages_read: "读取群消息",
    group_chat_list: "查看群列表", group_chat_get: "查看群资料", group_chat_history: "读取群聊记录",
    group_chat_search: "搜索群消息", group_chat_dispatch: "安排群内工作",
    group_chat_prepare: "核对群变更", group_chat_create: "创建群聊", group_chat_members_add: "添加群成员",
    group_member_role_read: "读取成员角色" };
  return labels[tool] ?? "工具执行";
}

function phaseFor(status) {
  return ({ starting: "preparing", queued: "queued", running: "running", waiting_approval: "waiting_approval",
    waiting_input: "waiting_input", stopping: "stopping", unknown: "reconciling", unavailable: "reconciling",
    completed: "completed", failed: "failed", canceled: "cancelled", interrupted: "cancelled" })[status] ?? null;
}

function publicTool(tool) {
  if (!tool) return null;
  const budget = { bytes: MAX_DETAIL_BYTES };
  const result = { ...tool };
  for (const key of ["input", "output", "error", "progress"]) if (result[key] !== undefined) result[key] = safeValue(result[key], 0, budget);
  // JSON escaping of unusual keys or control characters may exceed a text
  // budget. Bound the actual serialized details as well as their source text.
  const size = () => Buffer.byteLength(JSON.stringify(Object.fromEntries(["input", "output", "error", "progress"]
    .filter(key => result[key] !== undefined).map(key => [key, result[key]]))), "utf8");
  for (const key of ["progress", "error", "output", "input"]) {
    if (size() <= 4 * 1024) break;
    if (result[key] !== undefined) result[key] = "[截断]";
  }
  return result;
}

/** Rebuildable facts for ONE execution. No scheduling, permissions or Run terminal decisions. */
class GroupActivityProjection {
  constructor(binding, { now = Date.now } = {}) {
    this.binding = Object.freeze(Object.fromEntries(BINDING_FIELDS.map(key => [key, binding[key] ?? null])));
    this.now = now; this.streamGeneration = null; this.retiredStreams = new Set(); this.eventSeq = 0;
    this.phase = "preparing"; this.observedAt = null; this.lastProgressAt = null; this.tools = new Map();
    this.items = new Map(); this.itemHashes = new Map(); this.lastItem = null; this.currentToolId = null; this.terminal = false;
    this.statusSignature = null;
    this.compaction = null;
  }
  matches(binding) { return BINDING_FIELDS.every(key => this.binding[key] === (binding[key] ?? null)); }
  setStream(stream) {
    if (typeof stream !== "string" || !stream || this.retiredStreams.has(stream)) return false;
    if (this.streamGeneration === stream) return true;
    if (this.streamGeneration !== null) this.retiredStreams.add(this.streamGeneration);
    this.streamGeneration = stream; this.eventSeq = 0; this.items.clear(); this.itemHashes.clear(); this.lastItem = null;
    this.tools.clear(); this.currentToolId = null;
    this.compaction = null;
    if (["compacting", "compacted"].includes(this.phase)) this.phase = "running";
    return true;
  }
  #progress(at) { this.lastProgressAt = Math.max(this.lastProgressAt ?? 0, at); }
  #text(id, text, delta = false) {
    if (typeof text !== "string" || delta && text.length === 0) return false;
    const previous = this.itemHashes.get(id);
    const hash = delta && previous ? previous.hash.copy().update(text) : crypto.createHash("sha256").update(text);
    const signature = hash.copy().digest("hex");
    if (signature === previous?.signature && this.lastItem === id) return false;
    this.itemHashes.set(id, { hash, signature });
    this.items.set(id, textTail(delta ? (this.items.get(id) ?? "") + text : text));
    while (this.items.size > 32) { const oldest = this.items.keys().next().value; this.items.delete(oldest); this.itemHashes.delete(oldest); }
    this.lastItem = id; this.phase = "text"; this.currentToolId = null;
    return true;
  }
  observeStatus(status, { at = this.now(), cancelRequested = false, recovery = false } = {}) {
    this.observedAt = this.now();
    if (this.terminal) return false;
    let phase = phaseFor(status); if (!phase) return false;
    if (!TERMINAL_PHASES.has(phase)) phase = cancelRequested ? "stopping" : recovery ? "reconciling" : phase;
    const signature = `${phase}`;
    if (signature === this.statusSignature) return false;
    this.statusSignature = signature;
    // Repeated running snapshots must not erase a more specific tool/text activity.
    if (phase === "running" && ["tool", "text", "compacting", "compacted"].includes(this.phase)) return false;
    this.phase = phase; this.terminal = TERMINAL_PHASES.has(phase); this.#progress(at); return true;
  }
  observeEvents(events, stream) {
    if (!this.setStream(stream)) return false;
    let changed = false;
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      if (!Number.isSafeInteger(event?.seq) || event.seq <= this.eventSeq
        || event.runId !== undefined && event.runId !== this.binding.runId
        || event.streamId !== undefined && event.streamId !== stream) continue;
      this.eventSeq = event.seq; this.observedAt = this.now();
      if (this.terminal) continue;
      const p = event.payload ?? {}; const at = Number.isSafeInteger(event.createdAt) ? Math.min(event.createdAt, this.now())
        : Number.isSafeInteger(event.occurredAt) ? Math.min(event.occurredAt, this.now()) : this.now();
      if (event.type === "terminal" || event.type === "status") {
        if (event.type === "status" && ["compacting", "compacted"].includes(p.status)) {
          if (this.compaction?.status !== p.status) {
            this.phase = p.status;
            this.compaction = { status: p.status, eventSeq: event.seq, observedAt: at, lastObservedAt: at };
            this.#progress(at); changed = true;
          } else if (at > this.compaction.lastObservedAt) {
            // These Runtime status contracts have no stable compaction-cycle ID.
            // Retain later observations, but do not claim a new cycle or replace
            // tool/text progress until an explicit state transition is observed.
            this.compaction = { ...this.compaction, lastObservedAt: at }; changed = true;
          }
          continue;
        }
        changed = this.observeStatus(p.status, { at }) || changed; continue;
      }
      if (["text", "text.delta"].includes(event.type) && p.delivery !== "async" && p.phase !== "analysis"
        && p.phase !== "reasoning") {
        const id = p.itemId ?? "default";
        if (!this.#text(id, event.type === "text" ? p.text : p.delta, event.type === "text.delta")) continue;
        this.#progress(at); changed = true; continue;
      }
      if (!["tool.start", "tool.update", "tool.result"].includes(event.type)) continue;
      const id = p.toolCallId ?? p.itemId; if (typeof id !== "string" || !id || id.length > 512 || !id.isWellFormed() || id.includes("\0")) continue;
      const prior = this.tools.get(id);
      // A tool result is a protocol phase, including empty output. A later update
      // must never turn the same completed call back into an active call.
      if (prior?.finishedAt != null) continue;
      const raw = p.tool ?? {};
      const descriptor = { name: typeof raw.name === "string" ? safeValue(raw.name.slice(0, 512)) : undefined, status: raw.status,
        isError: raw.isError === true || raw.success === false || typeof raw.exitCode === "number" && raw.exitCode !== 0,
        durationMs: Number.isFinite(raw.durationMs) && raw.durationMs >= 0 && raw.durationMs <= Number.MAX_SAFE_INTEGER
          ? Math.round(raw.durationMs) : undefined };
      for (const field of ["arguments", "input", "displayArgs", "output", "resultSummary", "error", "errorCode"])
        if (raw[field] !== undefined) descriptor[field] = safeValue(raw[field]);
      const next = { ...(prior ?? { id, name: null, title: "工具执行", input: null, output: null, error: null,
        status: "running", startedAt: at, finishedAt: null, durationMs: null }),
        name: descriptor.name ?? prior?.name ?? null, updatedAt: at };
      if (descriptor.arguments !== undefined || descriptor.input !== undefined || descriptor.displayArgs !== undefined)
        next.input = descriptor.arguments ?? descriptor.input ?? descriptor.displayArgs;
      if (descriptor.output !== undefined || descriptor.resultSummary !== undefined) next.output = descriptor.output ?? descriptor.resultSummary;
      if (descriptor.error !== undefined || descriptor.errorCode !== undefined) next.error = descriptor.error ?? descriptor.errorCode;
      if (descriptor.durationMs !== undefined) next.durationMs = descriptor.durationMs;
      next.title = toolTitle(next.name, next.input);
      if (event.type === "tool.update") next.progress = safeValue({ delta: p.delta, patch: p.patch,
        progress: p.progress, changes: p.changes, message: p.message });
      if (event.type === "tool.result") {
        next.finishedAt = at; next.status = descriptor.status === "failed" || descriptor.isError === true || next.error ? "failed" : "completed";
        next.durationMs ??= Math.max(0, at - next.startedAt);
      }
      const signature = value => JSON.stringify({ ...value, updatedAt: null });
      if (prior && signature(prior) === signature(next)) continue;
      this.tools.set(id, next); while (this.tools.size > 32) this.tools.delete(this.tools.keys().next().value);
      this.currentToolId = event.type === "tool.result" ? [...this.tools.values()].reverse().find(tool => tool.finishedAt === null)?.id ?? null : id;
      this.phase = this.currentToolId ? "tool" : "running"; this.#progress(at); changed = true;
    }
    return changed;
  }
  draft() { return this.lastItem === null ? null : textTail([...this.items.values()].filter(Boolean).join("\n\n")); }
  observeDraft(text) {
    if (this.terminal || !this.#text("draft", text)) return false;
    this.observedAt = this.now(); this.#progress(this.observedAt); return true;
  }
  adopt(activity) {
    if (!validGroupActivity(activity) || activity.runId !== this.binding.runId || this.terminal
      || !this.setStream(activity.streamGeneration) || activity.eventSeq < this.eventSeq) return false;
    this.observedAt = this.now();
    const before = JSON.stringify(this.snapshot());
    this.eventSeq = activity.eventSeq; this.phase = activity.phase; this.terminal = TERMINAL_PHASES.has(activity.phase);
    this.lastProgressAt = activity.lastProgressAt;
    this.compaction = activity.compaction ? { ...activity.compaction } : null;
    const sanitize = tool => ({ ...tool, input: safeValue(tool.input), output: safeValue(tool.output), error: safeValue(tool.error),
      ...(tool.progress === undefined ? {} : { progress: safeValue(tool.progress) }) });
    this.tools = new Map(activity.recentTools.map(tool => [tool.id, sanitize(tool)]));
    if (activity.tool) this.tools.set(activity.tool.id, sanitize(activity.tool));
    this.currentToolId = activity.tool?.id ?? null;
    return before !== JSON.stringify(this.snapshot());
  }
  snapshot() {
    const value = { ...this.binding, phase: this.phase, title: this.phase === "tool" && this.currentToolId
      ? this.tools.get(this.currentToolId)?.title ?? TITLES.tool : TITLES[this.phase],
      eventSeq: this.eventSeq, streamGeneration: this.streamGeneration, observedAt: this.observedAt,
      lastProgressAt: this.lastProgressAt, tool: this.currentToolId ? publicTool(this.tools.get(this.currentToolId)) : null,
      recentTools: [...this.tools.values()].slice(-8).map(publicTool),
      ...(this.compaction ? { compaction: { ...this.compaction } } : {}) };
    while (value.recentTools.length && Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) value.recentTools.shift();
    return value;
  }
}

function validGroupActivity(value) {
  const keys = [...BINDING_FIELDS, "phase", "title", "eventSeq", "streamGeneration", "observedAt", "lastProgressAt", "tool", "recentTools"];
  const timestamp = time => time === null || Number.isSafeInteger(time) && time >= 0;
  const text = item => typeof item === "string" && item.length <= 512 && item.isWellFormed() && !item.includes("\0");
  const tool = item => item && typeof item === "object" && text(item.id) && (item.name === null || text(item.name))
    && text(item.title) && ["running", "completed", "failed"].includes(item.status)
    && ["startedAt", "updatedAt", "finishedAt", "durationMs"].every(key => timestamp(item[key]));
  const compaction = item => item === null || item && Object.getPrototypeOf(item) === Object.prototype
    && Object.keys(item).length === 4 && ["status", "eventSeq", "observedAt", "lastObservedAt"].every(key => Object.hasOwn(item, key))
    && ["compacting", "compacted"].includes(item.status) && Number.isSafeInteger(item.eventSeq)
    && item.eventSeq >= 0 && item.eventSeq <= value.eventSeq && timestamp(item.observedAt)
    && timestamp(item.lastObservedAt) && item.lastObservedAt >= item.observedAt;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length + (Object.hasOwn(value, "compaction") ? 1 : 0)
    || !keys.every(key => Object.hasOwn(value, key)) || !BINDING_FIELDS.every(key => value[key] === null || text(value[key]))
    || !PHASES.has(value.phase) || !text(value.title) || !Number.isSafeInteger(value.eventSeq) || value.eventSeq < 0
    || !(value.streamGeneration === null || text(value.streamGeneration))
    || !timestamp(value.observedAt) || !timestamp(value.lastProgressAt) || !(value.tool === null || tool(value.tool))
    || !Array.isArray(value.recentTools) || value.recentTools.length > 8 || !value.recentTools.every(tool)
    || Object.hasOwn(value, "compaction") && !compaction(value.compaction)) return false;
  try { return Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024; } catch { return false; }
}

module.exports = { GroupActivityProjection, PHASES, BINDING_FIELDS, safeValue, toolTitle, phaseFor, validGroupActivity };
