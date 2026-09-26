"use strict";

// DashboardJournal：Dashboard 的小状态文件（非配置——配置唯一源仍是
// config-store.js）。两块内容：
//   health.lastStates/events —— 健康事件（断连/恢复），带抗抖动（连续 2 次
//     采样一致才确认）、重启检测（关闭期间的变化标 detectedAfterRestart，
//     不伪造发生时间）、7 天/1000 条裁剪、敏感串清洗（首行+去 URL+截断）。
//   kanbanCursors —— Hermes kanban 事件流 per-profile 游标（WS 回放起点）。
// 路径由入口注入（Electron main → userData；manage-serve → dev 路径），
// 本模块不 import electron。原子写（tmp+rename）、0600；写失败（磁盘满
// 病史）降级为内存态，绝不抛出、绝不阻断启动；损坏文件备份后置空恢复。

const fs = require("node:fs");
const path = require("node:path");

const VERSION = 1;
const MAX_EVENTS = 1000;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const CONFIRM_SAMPLES = 2; // 抗抖动：同状态连续采样次数
const MAX_REASON_LEN = 200;

function sanitizeReason(reason) {
  if (!reason) return undefined;
  const firstLine = String(reason).split(/\r?\n/, 1)[0];
  const cleaned = firstLine.replace(/https?:\/\/\S+/gi, "[url]").trim();
  return cleaned ? cleaned.slice(0, MAX_REASON_LEN) : undefined;
}

const MAX_KANBAN_EVENTS_PER_KEY = 2000;

function emptyState() {
  return { version: VERSION, health: { lastStates: {}, events: [] }, kanbanCursors: {}, kanbanEvents: {} };
}

function createDashboardJournal(filePath, { now = Date.now } = {}) {
  let state = emptyState();
  let warnedWriteFailure = false;

  // ---- load（损坏 → 备份 + 空状态，不阻断启动） ----
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      state = {
        version: VERSION,
        health: {
          lastStates: (parsed.health && parsed.health.lastStates) || {},
          events: Array.isArray(parsed.health && parsed.health.events) ? parsed.health.events : [],
        },
        kanbanCursors: parsed.kanbanCursors && typeof parsed.kanbanCursors === "object" ? parsed.kanbanCursors : {},
        kanbanEvents: parsed.kanbanEvents && typeof parsed.kanbanEvents === "object" ? parsed.kanbanEvents : {},
      };
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      try {
        fs.renameSync(filePath, `${filePath}.corrupt-${now()}`);
        console.warn(`[dashboard-journal] corrupt file backed up: ${filePath}`);
      } catch { /* 备份失败也继续空状态 */ }
    }
  }

  // 启动时带出来的旧目标 → 首次确认到不同状态时标 detectedAfterRestart
  const restoredTargets = new Set(Object.keys(state.health.lastStates));
  const confirmedSinceLoad = new Set();
  const pending = new Map(); // targetId -> { state, count }

  function prune() {
    const cutoff = now() - MAX_AGE_MS;
    let events = state.health.events.filter((e) => Number.isFinite(e.at) && e.at >= cutoff);
    events.sort((a, b) => a.at - b.at);
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    state.health.events = events;
  }

  function flush() {
    prune();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (err) {
      if (!warnedWriteFailure) {
        warnedWriteFailure = true;
        console.warn(`[dashboard-journal] write failed (degrading to memory-only): ${err?.message || err}`);
      }
    }
  }

  return {
    /** 一轮健康采样。targets: [{targetType,targetId,backendId,state,reason?}]；返回本轮落下的事件。 */
    recordHealthSample(targets, { atMs } = {}) {
      const at = Number.isFinite(atMs) ? atMs : now();
      const emitted = [];
      let dirty = false;
      for (const t of Array.isArray(targets) ? targets : []) {
        if (!t || !t.targetId) continue;
        if (t.state !== "connected" && t.state !== "disconnected") continue; // starting/unknown 不参与
        const p = pending.get(t.targetId);
        if (p && p.state === t.state) p.count += 1;
        else pending.set(t.targetId, { state: t.state, count: 1 });
        const cur = pending.get(t.targetId);
        if (cur.count < CONFIRM_SAMPLES) continue;

        const last = state.health.lastStates[t.targetId];
        const firstConfirm = !confirmedSinceLoad.has(t.targetId);
        confirmedSinceLoad.add(t.targetId);
        if (last && last.state === t.state) continue; // 无变化
        if (!last && t.state === "connected") {
          // 首次正常静默，只记基线
          state.health.lastStates[t.targetId] = { state: t.state, targetType: t.targetType, backendId: t.backendId };
          dirty = true;
          continue;
        }
        const event = {
          targetType: t.targetType,
          targetId: t.targetId,
          backendId: t.backendId,
          state: t.state,
          at,
        };
        const reason = sanitizeReason(t.reason);
        if (reason && t.state === "disconnected") event.reason = reason;
        if (last && restoredTargets.has(t.targetId) && firstConfirm) event.detectedAfterRestart = true;
        state.health.events.push(event);
        state.health.lastStates[t.targetId] = { state: t.state, targetType: t.targetType, backendId: t.backendId };
        emitted.push(event);
        dirty = true;
      }
      if (dirty) flush();
      return emitted;
    },

    getHealthEvents() {
      return state.health.events.slice();
    },

    getKanbanCursor(key) {
      const v = state.kanbanCursors[key];
      return Number.isFinite(v) ? v : undefined;
    },

    setKanbanCursor(key, id) {
      if (!key || !Number.isFinite(id)) return;
      if (state.kanbanCursors[key] === id) return;
      state.kanbanCursors[key] = id;
      flush();
    },

    /** cursor 前进后当天事件的留存区：按天裁剪、按事件 id 去重、每 key 上限 2000（保最新）。 */
    appendKanbanEvents(key, rows, { dayStartMs = 0 } = {}) {
      if (!key || !Array.isArray(rows)) return;
      const merged = new Map();
      for (const row of [...(state.kanbanEvents[key] || []), ...rows]) {
        if (!row || row.id == null) continue;
        const at = Number(row.created_at) || 0;
        const atMs = at > 1e12 ? at : at * 1000; // created_at 秒/毫秒两种单位都收
        if (atMs < dayStartMs) continue; // 跨天裁剪
        merged.set(row.id, row);
      }
      let list = [...merged.values()].sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
      if (list.length > MAX_KANBAN_EVENTS_PER_KEY) list = list.slice(-MAX_KANBAN_EVENTS_PER_KEY);
      state.kanbanEvents[key] = list;
      flush();
    },

    getKanbanEvents(key) {
      return (state.kanbanEvents[key] || []).slice();
    },
  };
}

module.exports = { createDashboardJournal };
