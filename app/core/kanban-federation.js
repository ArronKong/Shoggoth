"use strict";

const crypto = require("node:crypto");

const CANONICAL_KANBAN_STATUSES = Object.freeze([
  "triage",
  "ready",
  "in_progress",
  "review",
  "blocked",
  "done",
  "archived",
]);

const STATUS_LABELS = Object.freeze({
  triage: "灵感",
  ready: "待执行",
  in_progress: "进行中",
  review: "审核",
  blocked: "阻塞",
  done: "完成",
  archived: "归档",
});

const STATUS_GROUPS = Object.freeze({
  workboard: Object.freeze({
    triage: "triage",
    backlog: "ready",
    todo: "ready",
    scheduled: "ready",
    ready: "ready",
    running: "in_progress",
    review: "review",
    blocked: "blocked",
    done: "done",
  }),
  hermes: Object.freeze({
    triage: "triage",
    todo: "ready",
    scheduled: "ready",
    ready: "ready",
    running: "in_progress",
    review: "review",
    blocked: "blocked",
    done: "done",
    archived: "archived",
  }),
  native: Object.freeze({
    triage: "triage",
    backlog: "ready",
    queued: "ready",
    running: "in_progress",
    review: "review",
    waiting: "blocked",
    failed: "blocked",
    canceled: "blocked",
    done: "done",
  }),
});

function normalizeProjectKey(value, fallback = "default") {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 96);
  if (normalized) return normalized;
  const digest = crypto.createHash("sha256").update(raw.normalize("NFKC")).digest("hex").slice(0, 12);
  return `project-${digest}`;
}

function taskIdentity(backendId, taskId) {
  return `${String(backendId || "")}\0${String(taskId || "")}`;
}

function agentIdentity(backendId, agentId) {
  return `${String(backendId || "")}:${String(agentId || "")}`;
}

function parseAgentIdentity(value) {
  const text = typeof value === "string" ? value : "";
  const separator = text.indexOf(":");
  if (separator <= 0 || separator === text.length - 1) return null;
  return { backendId: text.slice(0, separator), agentId: text.slice(separator + 1) };
}

function taskProjectKey(task, storedProject) {
  if (storedProject) return normalizeProjectKey(storedProject);
  const automationBoard = task?.wb?.metadata?.automation?.boardId;
  if (typeof automationBoard === "string" && automationBoard.trim()) {
    return normalizeProjectKey(automationBoard);
  }
  if (typeof task?.projectKey === "string" && task.projectKey.trim()) {
    return normalizeProjectKey(task.projectKey);
  }
  return "default";
}

function isArchivedTask(kind, task, rawStatus) {
  if (rawStatus === "archived") return true;
  if (kind === "native" && typeof task?.archivedAt === "number") return true;
  if (kind === "workboard") {
    return task?.wb?.archived === true
      || typeof task?.wb?.metadata?.archivedAt === "number"
      || typeof task?.archivedAt === "number";
  }
  return false;
}

function canonicalStatus(kind, rawStatus, task) {
  const safeKind = STATUS_GROUPS[kind] ? kind : "";
  const raw = String(rawStatus || task?.column || "").trim().toLowerCase();
  if (isArchivedTask(safeKind, task, raw)) return "archived";
  return STATUS_GROUPS[safeKind]?.[raw] || "blocked";
}

function nativeTargetForCanonical(kind, target, rawStatus, task) {
  if (!CANONICAL_KANBAN_STATUSES.includes(target)) return null;
  const current = canonicalStatus(kind, rawStatus, task);
  if (current === target) return { action: "none" };
  if (target === "archived") {
    return { action: "archive", archived: true };
  }
  const targets = {
    workboard: {
      triage: "triage", ready: "ready", review: "review", blocked: "blocked", done: "done",
    },
    hermes: {
      triage: "triage", ready: "ready", blocked: "blocked", done: "done",
    },
    native: {
      triage: "triage", ready: "backlog", blocked: "waiting", done: "done",
    },
  };
  const status = targets[kind]?.[target];
  if (!status) return null;
  if (current === "archived") return { action: "unarchive", archived: false };
  return status ? { action: "move", status } : null;
}

function scheduledAtOf(task) {
  const value = task?.scheduledAt ?? task?.wb?.metadata?.automation?.scheduledAt;
  return Number.isFinite(value) ? Number(value) : undefined;
}

function projectSourceIdentity(source) {
  return [
    source?.backendId || "",
    source?.boardId || source?.board || source?.slug || "default",
    source?.agentId || "",
  ].join("\0");
}

function mergeProjectRows(rows, customProjects = []) {
  const projects = new Map();
  const ensure = (key, candidate = {}) => {
    const projectKey = normalizeProjectKey(key);
    let project = projects.get(projectKey);
    if (!project) {
      project = {
        key: projectKey,
        name: candidate.name || candidate.slug || projectKey,
        description: candidate.description || undefined,
        total: 0,
        sources: [],
      };
      projects.set(projectKey, project);
    } else {
      if ((!project.name || project.name === project.key) && candidate.name) project.name = candidate.name;
      if (!project.description && candidate.description) project.description = candidate.description;
    }
    return project;
  };

  for (const custom of Array.isArray(customProjects) ? customProjects : []) {
    if (custom?.archived) continue;
    ensure(custom?.key || custom?.slug, custom || {});
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const project = ensure(row?.projectKey || row?.slug || "default", row || {});
    const sourceId = projectSourceIdentity(row);
    if (!project.sources.some((source) => projectSourceIdentity(source) === sourceId)) {
      project.sources.push({ ...row, projectKey: project.key });
      project.total += Number(row?.total || 0);
    }
  }

  return [...projects.values()]
    .map((project) => ({
      ...project,
      sources: project.sources.sort((left, right) => projectSourceIdentity(left).localeCompare(projectSourceIdentity(right))),
    }))
    .sort((left, right) => {
      if (left.key === "default") return -1;
      if (right.key === "default") return 1;
      return left.name.localeCompare(right.name, "zh-CN");
    });
}

function normalizeFederatedTask(task, source, storedProject) {
  const rawStatus = String(task?.rawStatus || task?.column || "");
  const projectKey = source?.projectKey || taskProjectKey(task, storedProject);
  const backendId = String(source?.backendId || task?.backendId || "");
  const agentId = task?.agentId || source?.agentId || undefined;
  return {
    ...task,
    id: String(task?.id || ""),
    backendId,
    rawStatus,
    column: canonicalStatus(source?.kind, rawStatus, task),
    projectKey,
    taskKey: taskIdentity(backendId, task?.id),
    sourceBoard: source?.boardId || source?.board || source?.slug || undefined,
    sourceKind: source?.kind,
    agentId,
    agentKey: agentId ? agentIdentity(backendId, agentId) : undefined,
    scheduledAt: scheduledAtOf(task),
  };
}

function buildCanonicalColumns(tasks) {
  const buckets = new Map(CANONICAL_KANBAN_STATUSES.map((status) => [status, []]));
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = CANONICAL_KANBAN_STATUSES.includes(task?.column) ? task.column : "blocked";
    buckets.get(status).push(task);
  }
  return CANONICAL_KANBAN_STATUSES.map((status) => ({
    id: status,
    name: STATUS_LABELS[status],
    tasks: buckets.get(status).sort((left, right) => (
      Number(left.position || 0) - Number(right.position || 0)
      || Number(left.createdAt || 0) - Number(right.createdAt || 0)
      || left.taskKey.localeCompare(right.taskKey)
    )),
  }));
}

module.exports = {
  CANONICAL_KANBAN_STATUSES,
  STATUS_LABELS,
  agentIdentity,
  buildCanonicalColumns,
  canonicalStatus,
  mergeProjectRows,
  normalizeFederatedTask,
  normalizeProjectKey,
  nativeTargetForCanonical,
  parseAgentIdentity,
  projectSourceIdentity,
  scheduledAtOf,
  taskIdentity,
  taskProjectKey,
};
