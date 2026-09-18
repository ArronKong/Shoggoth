"use strict";

// 统一活动流纯数据层：把 cron 运行、看板事件、灵感执行、健康事件映射成
// DashboardActivityEntry，做降噪、排序、稳定游标分页与 fail-soft 聚合。
// 事件词表对照真实上游（见 docs/superpowers/plans/2026-07-12-dashboard-unified-activity.md）：
// - OpenClaw workboard 没有 started/completed/failed/blocked/restored 这些 kind——
//   完成=moved→done、阻塞=moved→blocked、失败=attempt_updated+metadata.attempts
//   里对应 runId 的 status==="failed"、恢复=unarchived。
// - Hermes task_events.created_at 是秒；kind 词表是 claimed/spawned/promoted/
//   done/gave_up/timed_out/… 而非字面 started/failed。

const ACTIVITY_KINDS = new Set(["cron", "kanban", "inspiration", "health"]);
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;
const DENOISE_WINDOW_MS = 2000;
const DEFAULT_MAX_PER_SOURCE = 5000;

function cronSeverity(status) {
  if (status === "ok") return "success";
  if (status === "error") return "error";
  if (status === "skipped") return "warning";
  return "info"; // Hermes 真实 run 行无 status → 中性「已运行」
}

function cronRunToActivity(run) {
  const occurredAt = Number.isFinite(run.startedAt) ? run.startedAt
    : Number.isFinite(run.finishedAt) ? run.finishedAt : 0;
  return {
    id: `cron:${run.backendId}:${run.jobId}:${occurredAt}:${run.runId || ""}`,
    backendId: run.backendId,
    kind: "cron",
    occurredAt,
    severity: cronSeverity(run.status),
    title: run.jobName || run.jobId,
    summary: run.summary || run.error || undefined,
    agentId: run.agentId,
    run,
  };
}

function inspirationExecutionToActivity(execution) {
  const status = execution.status;
  return {
    id: `inspiration:${execution.backendId}:${execution.id}`,
    backendId: execution.backendId,
    kind: "inspiration",
    occurredAt: execution.createdAt,
    severity: status === "completed" ? "success" : status === "failed" ? "error"
      : ["waiting_input", "waiting_approval", "canceled", "interrupted", "skipped", "unknown"].includes(status) ? "warning" : "info",
    title: execution.title,
    summary: execution.summary || undefined,
    agentId: execution.agentId,
    inspiration: { ideaId: execution.ideaId, runId: execution.runId, status },
  };
}

// OpenClaw workboard 卡片事件 → 活动条目（真实 kind 词表）
function workboardCardToActivities(card, { sinceMs = 0, backendId = "openclaw" } = {}) {
  const events = Array.isArray(card?.events) ? card.events : [];
  const attempts = Array.isArray(card?.metadata?.attempts) ? card.metadata.attempts : [];
  const attemptByRunId = new Map(attempts.filter((a) => a && a.runId).map((a) => [a.runId, a]));
  const out = [];
  for (const ev of events) {
    if (!ev || !Number.isFinite(ev.at) || ev.at < sinceMs) continue;
    let action = null;
    let severity = "info";
    let summary;
    switch (ev.kind) {
      case "created":
        action = "created";
        break;
      case "moved":
        if (ev.toStatus === "done") { action = "completed"; severity = "success"; }
        else if (ev.toStatus === "blocked") { action = "blocked"; severity = "warning"; }
        else action = "moved";
        break;
      case "attempt_started":
        action = "started";
        break;
      case "attempt_updated": {
        const attempt = ev.runId ? attemptByRunId.get(ev.runId) : null;
        if (attempt && attempt.status === "failed") {
          action = "failed";
          severity = "error";
          summary = attempt.error || undefined;
        }
        break; // 非 failed 的 attempt 进度是噪声
      }
      case "archived":
        action = "archived";
        break;
      case "unarchived":
        action = "restored";
        break;
      default:
        break; // heartbeat/edited/comment_added/diagnostic/… 噪声
    }
    if (!action) continue;
    out.push({
      id: `kanban:${backendId}:${card.id}:${ev.id}`,
      backendId,
      kind: "kanban",
      occurredAt: ev.at,
      severity,
      title: card.title || "",
      summary,
      agentId: card.agentId,
      kanban: { taskId: card.id, action, fromStatus: ev.fromStatus, toStatus: ev.toStatus },
    });
  }
  return out;
}

const HERMES_KANBAN_ACTION = new Map([
  ["created", ["created", "info"]],
  ["claimed", ["started", "info"]],
  ["spawned", ["started", "info"]],
  ["promoted", ["moved", "info"]],
  ["promoted_manual", ["moved", "info"]],
  ["reprioritized", ["moved", "info"]],
  ["unblocked", ["moved", "info"]],
  ["blocked", ["blocked", "warning"]],
  ["done", ["completed", "success"]],
  ["completed", ["completed", "success"]],
  ["gave_up", ["failed", "error"]],
  ["timed_out", ["failed", "error"]],
  ["archived", ["archived", "info"]],
  ["deleted", ["deleted", "info"]],
]);

// Hermes task_events 行 → 活动条目；created_at 为秒（真实 DB schema）
function hermesKanbanEventToActivity(ev, { profile, backendId = "hermes", titleByTaskId, agentId, board } = {}) {
  if (!ev || !HERMES_KANBAN_ACTION.has(ev.kind)) return null;
  const [action, severity] = HERMES_KANBAN_ACTION.get(ev.kind);
  const raw = Number(ev.created_at) || 0;
  const occurredAt = raw > 1e12 ? raw : raw * 1000;
  return {
    id: `kanban:${backendId}:${profile}:${ev.id}`,
    backendId,
    kind: "kanban",
    occurredAt,
    severity,
    title: (titleByTaskId && titleByTaskId.get(ev.task_id)) || "",
    agentId,
    kanban: { taskId: ev.task_id, board, action },
  };
}

function healthEventToActivity(ev) {
  return {
    id: `health:${ev.targetId}:${ev.at}`,
    backendId: ev.backendId,
    kind: "health",
    occurredAt: ev.at,
    severity: ev.state === "connected" ? "success" : "error",
    title: ev.targetId,
    summary: ev.reason || undefined,
    health: {
      targetType: ev.targetType,
      targetId: ev.targetId,
      state: ev.state,
      detectedAfterRestart: ev.detectedAfterRestart || undefined,
    },
  };
}

function entryOrderDesc(a, b) {
  if (a.occurredAt !== b.occurredAt) return b.occurredAt - a.occurredAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// 2 秒窗降噪：终态覆盖同任务的泛化迁移（moved），创建覆盖初始状态设置。
// 输出按 (occurredAt,id) 倒序，输入顺序不影响结果（确定性）。
function denoiseKanban(entries) {
  const byTask = new Map();
  for (const e of entries) {
    const key = `${e.backendId}\0${e.kanban?.taskId}`;
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(e);
  }
  const drop = new Set();
  for (const group of byTask.values()) {
    const terminals = group.filter((e) => e.kanban.action === "completed" || e.kanban.action === "failed");
    const created = group.filter((e) => e.kanban.action === "created");
    for (const e of group) {
      if (e.kanban.action !== "moved") continue;
      const coveredByTerminal = terminals.some((t) => Math.abs(t.occurredAt - e.occurredAt) <= DENOISE_WINDOW_MS);
      const coveredByCreate = created.some((c) =>
        e.occurredAt >= c.occurredAt && e.occurredAt - c.occurredAt <= DENOISE_WINDOW_MS);
      if (coveredByTerminal || coveredByCreate) drop.add(e.id);
    }
  }
  return entries.filter((e) => !drop.has(e.id)).sort(entryOrderDesc);
}

function encodeCursor({ occurredAt, id }) {
  return Buffer.from(JSON.stringify([occurredAt, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [occurredAt, id] = parsed;
    if (!Number.isFinite(occurredAt) || typeof id !== "string") return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

// 统一分页：倒序 (occurredAt,id)、按 id 去重、opaque cursor、筛选校验。
// 非法 cursor / kind 抛错（路由层映射 400）。
function buildActivityPage(entries, { limit, cursor, backend, kind, degradedSources = [] } = {}) {
  if (kind !== undefined && kind !== null && kind !== "" && !ACTIVITY_KINDS.has(kind)) {
    throw new Error(`invalid kind: ${kind}`);
  }
  let after = null;
  if (cursor !== undefined && cursor !== null && cursor !== "") {
    after = decodeCursor(cursor);
    if (!after) throw new Error("invalid cursor");
  }
  const pageLimit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Number.isFinite(limit) ? limit : DEFAULT_PAGE_LIMIT));
  const seen = new Set();
  let list = [];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (backend && e.backendId !== backend) continue;
    if (kind && e.kind !== kind) continue;
    list.push(e);
  }
  list.sort(entryOrderDesc);
  if (after) {
    list = list.filter((e) => e.occurredAt < after.occurredAt
      || (e.occurredAt === after.occurredAt && e.id < after.id));
  }
  const items = list.slice(0, pageLimit);
  const hasMore = list.length > pageLimit;
  return {
    items,
    hasMore,
    nextCursor: hasMore && items.length
      ? encodeCursor({ occurredAt: items[items.length - 1].occurredAt, id: items[items.length - 1].id })
      : undefined,
    degradedSources,
  };
}

// 当天全量 cron 成败计数（KPI 数据源，替代 runsLimit=50 截断口径）
function computeRunStats(runs) {
  const mk = () => ({ ok: 0, error: 0, skipped: 0, other: 0, total: 0 });
  const total = mk();
  const byBackend = new Map();
  for (const r of runs) {
    if (!byBackend.has(r.backendId)) byBackend.set(r.backendId, mk());
    for (const bucket of [total, byBackend.get(r.backendId)]) {
      bucket.total++;
      if (r.status === "ok") bucket.ok++;
      else if (r.status === "error") bucket.error++;
      else if (r.status === "skipped") bucket.skipped++;
      else bucket.other++;
    }
  }
  return { total, byBackend: [...byBackend.entries()].map(([backend, s]) => ({ backend, ...s })) };
}

// 契约形状：getRecentCronRuns 返回 {runs, truncated?, latestOnly?}（registry
// 消费 .runs）；兼容裸数组与 {items} 以防御性归一。
function normalizeRunsResult(r) {
  if (Array.isArray(r)) return { items: r };
  if (r && typeof r === "object") {
    const items = Array.isArray(r.runs) ? r.runs : Array.isArray(r.items) ? r.items : [];
    return { items, truncated: !!r.truncated, latestOnly: !!r.latestOnly };
  }
  return { items: [] };
}

// OpenClaw heartbeat 的成功、失败、跳过结果都是系统保活噪声。
// 与 ActivityFeed 的旧缓存过滤保持一致；不按 jobName 过滤用户自定义任务。
function isHeartbeatCronNoise(run) {
  return run?.backendId === "openclaw" && [run.summary, run.error].some((message) =>
    typeof message === "string" && /^heartbeat (?:(?:wake requested|(?:task )?completed)$|(?:failed|skipped):)/.test(message),
  );
}

// 铁律 4：单源失败静默降级为 degradedSources 一行，绝不 throw。
async function collectActivities({ backends, sinceMs, healthEvents = [], inspirationOwner, maxPerSource = DEFAULT_MAX_PER_SOURCE }) {
  const entries = [];
  const degradedSources = [];
  const allRuns = [];
  const activeIds = new Set(backends.map((b) => b.id));
  const inspirationPromise = (async () => {
    if (!inspirationOwner?.getRecentInspirationActivities) return;
    try {
      const result = await inspirationOwner.getRecentInspirationActivities({ sinceMs, limit: maxPerSource });
      if (result.supported) {
        entries.push(...result.items.filter(item => activeIds.has(item.backendId)).slice(0, maxPerSource));
        if (result.truncated || result.items.length > maxPerSource) {
          degradedSources.push({ backend: inspirationOwner.id, source: "inspiration", reason: "truncated" });
        }
      } else if (result.reason && result.reason !== "unsupported") {
        degradedSources.push({ backend: inspirationOwner.id, source: "inspiration", reason: result.reason });
      }
    } catch {
      degradedSources.push({ backend: inspirationOwner.id, source: "inspiration", reason: "error" });
    }
  })();
  await Promise.all([inspirationPromise, ...backends.map(async (backend) => {
    // 两个独立来源并发拉取；慢 cron 不应串行阻塞 kanban（反之亦然）。
    await Promise.all([
      (async () => {
        try {
          const r = normalizeRunsResult(await backend.getRecentCronRuns({ sinceMs, limit: maxPerSource }));
          let items = r.items;
          let truncated = r.truncated || items.length > maxPerSource;
          if (items.length > maxPerSource) items = items.slice(0, maxPerSource);
          allRuns.push(...items);
          entries.push(...items.filter((run) => !isHeartbeatCronNoise(run)).map(cronRunToActivity));
          const latestOnly = r.latestOnly || (items.length > 0 && items.every((x) => x.synthesized));
          if (latestOnly) degradedSources.push({ backend: backend.id, source: "cron", reason: "latest-only" });
          if (truncated) degradedSources.push({ backend: backend.id, source: "cron", reason: "truncated" });
        } catch {
          degradedSources.push({ backend: backend.id, source: "cron", reason: "error" });
        }
      })(),
      (async () => {
        try {
          const r = (await backend.getRecentKanbanActivities({ sinceMs })) || { supported: false, reason: "unsupported", items: [] };
          if (r.supported === false) {
            // 本来就不支持 ≠ 降级；其它原因（remote/unavailable/error）要透出
            if (r.reason && r.reason !== "unsupported") {
              degradedSources.push({ backend: backend.id, source: "kanban", reason: r.reason });
            }
          } else {
            let items = Array.isArray(r.items) ? r.items : [];
            let truncated = !!r.truncated || items.length > maxPerSource;
            if (items.length > maxPerSource) items = items.slice(0, maxPerSource);
            entries.push(...denoiseKanban(items));
            if (truncated) degradedSources.push({ backend: backend.id, source: "kanban", reason: "truncated" });
          }
        } catch {
          degradedSources.push({ backend: backend.id, source: "kanban", reason: "error" });
        }
      })(),
    ]);
  })]);
  // journal 的健康事件是历史留存；「断开连接」的后端不在 backends 里，它的
  // 旧健康波动也一并隐藏（断开语义 = 各页面不再显示该后端的数据）。
  for (const ev of healthEvents) {
    if (!activeIds.has(ev.backendId)) continue;
    if (Number.isFinite(ev.at) && ev.at >= sinceMs) entries.push(healthEventToActivity(ev));
  }
  return { entries, degradedSources, runs: allRuns, runStats: computeRunStats(allRuns) };
}

module.exports = {
  cronRunToActivity,
  inspirationExecutionToActivity,
  workboardCardToActivities,
  hermesKanbanEventToActivity,
  healthEventToActivity,
  denoiseKanban,
  encodeCursor,
  decodeCursor,
  buildActivityPage,
  computeRunStats,
  collectActivities,
};
