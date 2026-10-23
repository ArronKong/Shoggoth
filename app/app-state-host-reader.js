"use strict";

const { APP_STATE_HOST_SECTIONS, validAppStateArguments } = require("./agent-service/app-state-contract");
const { AppStatePager, snapshot, sourceUnavailable, fields, text, number, timestamp,
  stateError, resourceRevision } = require("./agent-service/app-state-projection");
const EXTERNAL_BACKENDS = new Set(["openclaw", "hermes"]);
const tokenFields = ["totalTokens", "totalCost", "inputTokens", "outputTokens", "cacheReadTokens",
  "cacheWriteTokens", "reasoningTokens", "missingCostEntries", "estimatedCostEntries"];
function id(value) { return typeof value === "number" || typeof value === "string" ? text(String(value), 512) : null; }
function requireRows(value) {
  if (!Array.isArray(value)) throw stateError("APP_STATE_SOURCE_UNAVAILABLE");
  return value;
}
function runRow(row, backendId, kind) {
  return { id: id(row.id ?? row.runId) || `${kind}:${id(row.jobId ?? row.sessionKey) || "unknown"}:${timestamp(row.startedAt) ?? 0}`,
    backendId, kind, ...fields(row, ["agentId", "sessionKey", "jobId", "status", "runtime"]),
    title: text(row.title ?? row.jobName, 512), ...fields(row, ["createdAt", "startedAt", "finishedAt"], "timestamp") };
}

// Read the same backend surfaces used by the App. All output is an allowlist;
// no raw backend error, prompt, command, credential, approval payload or file
// body crosses the private federation socket.
class AppStateHostReader {
  constructor({ registry, getStatuses, now = Date.now }) {
    this.registry = registry; this.getStatuses = getStatuses; this.now = now;
    this.pager = new AppStatePager({ now });
  }
  async read(args) {
    if (!validAppStateArguments(args, APP_STATE_HOST_SECTIONS)) throw stateError("APP_HOST_INVALID_REQUEST");
    if (args.cursor !== null) return this.pager.page({ section: args.section }, args);
    const items = [], unavailable = [];
    const statuses = await this.getStatuses();
    const targets = statuses.filter(status => ["models", "runtime_accounts"].includes(args.section)
      || EXTERNAL_BACKENDS.has(status.id));
    let readableSources = 0;
    for (const status of targets) {
      const backendId = status.id;
      if (status.disabled || !status.connected) {
        unavailable.push(sourceUnavailable(backendId, status.disabled ? "BACKEND_DISABLED" : "BACKEND_DISCONNECTED"));
        continue;
      }
      try {
        const backend = this.registry.getBackend(backendId);
        if (!backend) throw stateError("APP_STATE_SOURCE_UNAVAILABLE");
        const partial = [];
        const rows = await this.#rows(args.section, backendId, backend, partial);
        items.push(...rows); unavailable.push(...partial); readableSources += 1;
      } catch { unavailable.push(sourceUnavailable(backendId)); }
    }
    const result = snapshot(args.section, items, unavailable, args.section === "usage" ? { range: "30d" }
      : args.section === "runs" ? { externalHistory: "recent_cron_and_live_work", historyLimitPerBackend: 100 } : {}, this.now());
    result.available = readableSources > 0 || result.complete;
    return this.pager.page(result, args);
  }
  async #rows(section, backendId, backend, unavailable) {
    if (section === "agents") return requireRows(await backend.listAgents()).map(row => ({
      backendId, agentId: id(row.id), name: text(row.name, 256) || id(row.id), kind: "external",
      connected: true, enabled: true, isDefault: row.isDefault === true,
      model: text(row.model, 512), provider: text(row.provider, 256),
    }));
    if (section === "cron") return requireRows(await backend.getCronJobs({ strict: true })).map(row => ({
      id: id(row.id), backendId, agentId: id(row.agentId), name: text(row.name, 256) || id(row.id), revision: resourceRevision("cron", row),
      enabled: row.enabled !== false, status: text(row.state ?? row.lastStatus, 128),
      stateLabel: text(row.stateLabel, 256), schedule: text(row.scheduleDisplay, 512)
        ?? (row.schedule?.kind === "cron" ? text(row.schedule.expr, 512)
          : row.schedule?.kind === "every" ? `every ${number(row.schedule.everyMs)}ms`
            : row.schedule?.kind === "at" ? id(row.schedule.at) : null),
      model: text(row.model, 512), provider: text(row.provider, 256),
      ...fields(row, ["createdAt", "lastRunAt", "nextRunAt"], "timestamp"),
      lastStatus: text(row.lastStatus, 128), hasError: Boolean(row.lastError)
        || ["failed", "error", "exhausted"].includes(row.lastStatus),
    }));
    if (section === "kanban") {
      const kind = backend.getBackendDescriptor?.()?.surfaces?.kanban?.kind;
      const boards = kind === "boards" || backendId === "hermes"
        ? requireRows(await backend.getBoards({ strict: true })) : [{ id: "default", name: "Default" }];
      const rows = [];
      for (const board of boards) {
        const boardId = id(board.slug ?? board.id);
        rows.push({ type: "board", id: boardId, backendId, name: text(board.name, 512) || boardId, revision: resourceRevision("board", board) });
        const view = await backend.getTaskBoard({ board: boardId, includeArchived: true, readOnly: true });
        if (!view || !Array.isArray(view.columns)) throw stateError("APP_STATE_SOURCE_UNAVAILABLE");
        if (view.error || view.refreshError) unavailable.push(sourceUnavailable(backendId, "APP_STATE_SOURCE_INCOMPLETE"));
        for (const column of view.columns) for (const task of requireRows(column.tasks)) rows.push({
          type: "card", id: id(task.id), boardId, backendId, title: text(task.title, 512), revision: resourceRevision("card", task),
          agentId: id(task.agentId ?? task.assignee), status: text(task.status ?? task.column ?? column.id, 128),
          priority: typeof task.priority === "number" ? number(task.priority) : id(task.priorityLevel ?? task.priority), archived: task.archived === true || task.wb?.archived === true || column.id === "archived",
          ...fields(task, ["createdAt", "updatedAt"], "timestamp"),
          runId: id(task.runId ?? task.wb?.lifecycle?.runId),
          runStatus: text(task.wb?.lifecycle?.status ?? task.runStatus, 128),
        });
      }
      return rows;
    }
    if (section === "sessions") {
      const result = await backend.getSessionRowsSnapshot();
      if (result?.complete === false) unavailable.push(sourceUnavailable(backendId, "APP_STATE_SOURCE_INCOMPLETE"));
      return requireRows(result?.rows).map(row => ({
        id: id(row.key ?? row.id), backendId, agentId: id(row.agentId) ?? text(/^agent:([^:]+):/u.exec(row.key || "")?.[1]),
        title: text(row.title ?? row.label, 512), model: text(row.model, 512),
        status: text(row.status, 128) ?? (row.active === true ? "active" : "unknown"),
        ...fields(row, ["createdAt", "updatedAt"], "timestamp"),
      }));
    }
    if (section === "runs") {
      const rows = [];
      try {
        const live = await backend.getRunningWork();
        if (live?.supported !== true) throw stateError("APP_STATE_SOURCE_UNAVAILABLE");
        rows.push(...requireRows(live.items).map(row => runRow(row, backendId, "live_work")));
      } catch { unavailable.push(sourceUnavailable(`${backendId}:live_work`)); }
      try {
        const history = await backend.getRecentCronRuns({ sinceMs: 0, limit: 100 });
        rows.push(...requireRows(history?.runs).map(row => runRow(row, backendId, "cron_history")));
      } catch { unavailable.push(sourceUnavailable(`${backendId}:cron_history`)); }
      // External App surfaces expose a recent window, not an all-history count.
      unavailable.push(sourceUnavailable(backendId, "APP_STATE_HISTORY_WINDOW"));
      return [...new Map(rows.map(row => [row.id, row])).values()];
    }
    if (section === "runtime_accounts") {
      if (EXTERNAL_BACKENDS.has(backendId)) return [{ type: "backend_runtime", id: backendId, backendId,
        version: text((await backend.getStatus())?.info?.version, 128), connected: true }];
      if (backend.getBackendDescriptor?.()?.surfaces?.runtimeStatus !== true) return [];
      return requireRows(await backend.getRuntimeStatuses()).map(row => ({
        type: "installation", id: id(row.runtimeAccountId), backendId,
        ...fields(row, ["runtime", "name", "runtimeAccountId", "installation"]),
        releaseEnabled: row.releaseEnabled === true, enabled: row.enabled === true,
        serviceConnected: row.serviceConnected === true,
      }));
    }
    if (section === "models") {
      const result = await backend.getModelCatalogSources({ fresh: false });
      return requireRows(result?.models).map(row => ({ type: "model", id: id(row.id), backendId,
        name: text(row.name, 256) || id(row.id), provider: text(row.provider, 256), source: "catalog",
        contextWindow: number(row.contextWindow), maxTokens: number(row.maxTokens),
      }));
    }
    if (section === "skills") return requireRows(await backend.getSkills({ strict: true })).map(row => ({
      id: id(row.id ?? row.name), backendId, name: text(row.name, 256),
      source: text(row.source, 128), version: text(row.version, 128),
      enabled: typeof row.enabled === "boolean" ? row.enabled : row.disabled === true ? false : null,
      eligible: typeof row.eligible === "boolean" ? row.eligible : null,
    }));
    if (section === "usage") {
      const result = await backend.getUsageSeries("30d");
      if (result?.availability === "unavailable" || !Number.isFinite(result?.totals?.totalTokens)) throw stateError("APP_STATE_SOURCE_UNAVAILABLE");
      const availability = result.availability === "partial" || result.cacheStatus === "refreshing" ? "partial" : "complete";
      if (availability === "partial") unavailable.push(sourceUnavailable(backendId, "APP_STATE_SOURCE_INCOMPLETE"));
      return [{ backendId, range: "30d", availability, ...fields(result.totals, tokenFields, "number") }];
    }
    throw stateError("APP_HOST_INVALID_REQUEST");
  }
}

module.exports = { AppStateHostReader };
