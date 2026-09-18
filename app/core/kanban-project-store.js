"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeProjectKey, taskIdentity } = require("./kanban-federation");

const STORE_VERSION = 1;
const MAX_PROJECTS = 512;
const MAX_TASK_BINDINGS = 50_000;

function emptyState() {
  return { version: STORE_VERSION, projects: {}, taskProjects: {} };
}

function cleanText(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function normalizeState(raw) {
  if (!raw || raw.version !== STORE_VERSION || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("kanban project store schema is invalid");
  }
  const state = emptyState();
  for (const value of Object.values(raw.projects || {}).slice(0, MAX_PROJECTS)) {
    const key = normalizeProjectKey(value?.key || value?.slug, "");
    if (!key) continue;
    state.projects[key] = {
      key,
      name: cleanText(value?.name, 160) || key,
      ...(cleanText(value?.description, 2_000) ? { description: cleanText(value.description, 2_000) } : {}),
      archived: value?.archived === true,
      createdAt: Number.isSafeInteger(value?.createdAt) ? value.createdAt : 0,
      updatedAt: Number.isSafeInteger(value?.updatedAt) ? value.updatedAt : 0,
    };
  }
  for (const [identity, projectKey] of Object.entries(raw.taskProjects || {}).slice(0, MAX_TASK_BINDINGS)) {
    if (!identity || typeof projectKey !== "string") continue;
    const key = normalizeProjectKey(projectKey, "");
    if (key) state.taskProjects[identity] = key;
  }
  return state;
}

class KanbanProjectStore {
  constructor(filePath) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new TypeError("KanbanProjectStore filePath must be absolute");
    }
    this.filePath = filePath;
    this._state = null;
    this._readError = null;
  }

  _load() {
    if (this._state) return this._state;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this._state = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code === "ENOENT") {
        this._state = emptyState();
      } else {
        this._readError = error;
        this._state = emptyState();
      }
    }
    return this._state;
  }

  _write(next) {
    if (this._readError) {
      throw new Error(`kanban project store is unreadable: ${this._readError.message}`);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
    this._state = next;
  }

  listProjects() {
    return Object.values(this._load().projects).map((project) => ({ ...project }));
  }

  projectForTask(backendId, taskId) {
    return this._load().taskProjects[taskIdentity(backendId, taskId)] || null;
  }

  upsertProject(spec = {}, now = Date.now()) {
    const key = normalizeProjectKey(spec.key || spec.slug || spec.name, "");
    if (!key) throw new Error("project key is required");
    const state = structuredClone(this._load());
    const previous = state.projects[key];
    if (!previous && Object.keys(state.projects).length >= MAX_PROJECTS) {
      throw new Error("too many kanban projects");
    }
    const name = cleanText(spec.name, 160) || previous?.name || key;
    const description = spec.description === ""
      ? undefined : cleanText(spec.description, 2_000) || previous?.description;
    state.projects[key] = {
      key,
      name,
      ...(description ? { description } : {}),
      archived: spec.archived === true,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    this._write(state);
    return { ...state.projects[key] };
  }

  deleteProject(projectKey) {
    const key = normalizeProjectKey(projectKey, "");
    if (!key) throw new Error("project key is required");
    if (key === "default") throw new Error("Default 项目不能删除");
    const state = structuredClone(this._load());
    let changed = Object.prototype.hasOwnProperty.call(state.projects, key);
    delete state.projects[key];
    for (const [identity, boundProject] of Object.entries(state.taskProjects)) {
      if (boundProject !== key) continue;
      delete state.taskProjects[identity];
      changed = true;
    }
    if (changed) this._write(state);
    return changed;
  }

  bindTask(backendId, taskId, projectKey) {
    const identity = taskIdentity(backendId, taskId);
    const key = normalizeProjectKey(projectKey, "");
    if (!backendId || !taskId || !key) throw new Error("task project binding is invalid");
    const state = structuredClone(this._load());
    if (!Object.prototype.hasOwnProperty.call(state.taskProjects, identity)
      && Object.keys(state.taskProjects).length >= MAX_TASK_BINDINGS) {
      throw new Error("too many kanban task bindings");
    }
    state.taskProjects[identity] = key;
    this._write(state);
  }

  removeTaskBinding(backendId, taskId) {
    const identity = taskIdentity(backendId, taskId);
    const state = structuredClone(this._load());
    if (!Object.prototype.hasOwnProperty.call(state.taskProjects, identity)) return;
    delete state.taskProjects[identity];
    this._write(state);
  }
}

function createKanbanProjectStore(filePath) {
  return new KanbanProjectStore(filePath);
}

module.exports = { KanbanProjectStore, createKanbanProjectStore };
