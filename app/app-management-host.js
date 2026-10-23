"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./agent-service/private-file");
const { ensurePrivateDirectoryTree, lstatIfExists } = require("./agent-service/security");
const { resourceRevision, text, stateError } = require("./agent-service/app-state-projection");
const RECEIPT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
function array(value) { if (!Array.isArray(value)) throw stateError("FEDERATION_RESPONSE_INVALID"); return value; }
function fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function externalSchedule(schedule, backendId) {
  if (schedule?.kind === "at") return { kind: "at", at: new Date(schedule.at).toISOString() };
  return schedule;
}

// Reserve a durable receipt before an external effect. A lost response or App
// restart must never turn a Cron trigger/create into an automatic resend.
class AppManagementHost {
  constructor({ paths, now = Date.now }) {
    this.paths = paths; this.now = now; this.receipts = null; this.inFlight = new Map();
    this.receiptPath = path.join(paths.stateDir, "app-management-receipts.json");
  }
  #load() {
    if (this.receipts) return;
    this.receipts = {};
    if (!lstatIfExists(this.receiptPath)) return;
    try {
      const value = JSON.parse(readPrivateFile(this.receiptPath, { maxBytes: 4 * 1024 * 1024 }).toString("utf8"));
      if (value.version !== 1 || !value.receipts || Object.getPrototypeOf(value.receipts) !== Object.prototype
        || Object.keys(value.receipts).length > 1024) throw new Error();
      for (const [id, receipt] of Object.entries(value.receipts)) if (!/^mcp-v1-[a-f0-9]{48}$/u.test(id)
        || !/^[a-f0-9]{64}$/u.test(receipt.fingerprint || "") || !Number.isSafeInteger(receipt.createdAt)
        || !["pending", "completed", "unknown"].includes(receipt.status)) throw new Error();
      this.receipts = value.receipts;
    } catch { this.receipts = null; throw stateError("APP_HOST_UNAVAILABLE"); }
  }
  #persist() {
    ensurePrivateDirectoryTree(this.paths.stateDir, this.paths.trustedRoot);
    atomicWritePrivateFile(this.receiptPath, `${JSON.stringify({ version: 1, receipts: this.receipts })}\n`, { trustedRoot: this.paths.trustedRoot });
  }
  async run(params, backend) {
    this.#load();
    const digest = fingerprint(params), existing = this.receipts[params.operationId];
    if (existing) {
      if (existing.fingerprint !== digest) throw stateError("FEDERATION_OPERATION_CONFLICT");
      if (this.inFlight.has(params.operationId)) return this.inFlight.get(params.operationId);
      if (existing.status === "completed") return structuredClone(existing.result);
      throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
    }
    if (params.createdAt < this.now() - RECEIPT_WINDOW_MS || params.createdAt > this.now() + 60_000) throw stateError("FEDERATION_OPERATION_CONFLICT");
    const prepared = await this.#prepare(params, backend);
    // Concurrent equal requests may both finish their read-only preparation.
    if (this.receipts[params.operationId]) return this.run(params, backend);
    for (const [id, receipt] of Object.entries(this.receipts)) if (receipt.createdAt < this.now() - RECEIPT_WINDOW_MS) delete this.receipts[id];
    if (Object.keys(this.receipts).length >= 1024) throw stateError("APP_MANAGE_CAPACITY");
    this.receipts[params.operationId] = { fingerprint: digest, createdAt: params.createdAt, status: "pending" };
    try { this.#persist(); } catch { delete this.receipts[params.operationId]; throw stateError("APP_HOST_UNAVAILABLE"); }
    const promise = Promise.resolve().then(() => this.#execute(params, backend, prepared)).then(result => {
      this.receipts[params.operationId] = { fingerprint: digest, createdAt: params.createdAt, status: "completed", result };
      try { this.#persist(); } catch { this.receipts[params.operationId].status = "unknown"; throw stateError("APP_MANAGE_OUTCOME_UNKNOWN"); }
      return result;
    }, () => {
      this.receipts[params.operationId].status = "unknown";
      try { this.#persist(); } catch {}
      throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
    }).finally(() => this.inFlight.delete(params.operationId));
    this.inFlight.set(params.operationId, promise);
    return promise;
  }
  async #board(backend, backendId, boardId) {
    if (backendId === "hermes" && !array(await backend.getBoards({ strict: true })).some(row => String(row.slug ?? row.id) === boardId)) throw stateError("AGENT_NOT_FOUND");
    const value = await backend.getTaskBoard({ board: boardId, includeArchived: true, readOnly: true });
    if (!value || value.error || value.refreshError) throw stateError("BACKEND_UNAVAILABLE");
    return array(value.columns).flatMap(column => array(column.tasks));
  }
  async #prepare(params, backend) {
    const { operation, backendId, expectedRevision, arguments: args } = params;
    if (operation === "cron_create") {
      if (!array(await backend.listAgents()).some(row => row.id === args.agentId)) throw stateError("AGENT_NOT_FOUND");
      if (typeof backend.createCronJob !== "function") throw stateError("BACKEND_UNAVAILABLE");
      return null;
    }
    if (operation.startsWith("cron_")) {
      const job = array(await backend.getCronJobs({ strict: true })).find(row => row.id === args.jobId);
      if (!job || job.backendId && job.backendId !== backendId) throw stateError("AGENT_NOT_FOUND");
      if (resourceRevision("cron", job) !== expectedRevision) throw stateError("APP_MANAGE_RESOURCE_CHANGED");
      const action = operation === "cron_delete" ? "delete" : operation === "cron_set_enabled" ? "toggle" : operation === "cron_run_now" ? "run" : "edit";
      if (job.actions?.[action] === false) throw stateError("APP_MANAGE_OPERATION_UNSUPPORTED");
      const method = operation === "cron_delete" ? "deleteCronJob" : operation === "cron_run_now" ? "runCronJob" : "updateCronJob";
      if (typeof backend[method] !== "function") throw stateError("BACKEND_UNAVAILABLE");
      return job;
    }
    if (backendId === "openclaw" && args.boardId !== "default") throw stateError("AGENT_NOT_FOUND");
    const tasks = await this.#board(backend, backendId, args.boardId);
    const assignee = operation === "kanban_card_create" ? args.assignee : args.patch?.assignee;
    if (assignee != null && !array(await backend.listAgents()).some(row => row.id === assignee)) throw stateError("AGENT_NOT_FOUND");
    if (operation === "kanban_card_create") {
      if (typeof backend.createTask !== "function") throw stateError("BACKEND_UNAVAILABLE");
      return null;
    }
    const method = operation === "kanban_card_delete" ? "deleteTask" : "updateTask";
    if (typeof backend[method] !== "function") throw stateError("BACKEND_UNAVAILABLE");
    const task = tasks.find(row => String(row.id) === args.cardId);
    if (!task) throw stateError("AGENT_NOT_FOUND");
    if (resourceRevision("card", task) !== expectedRevision) throw stateError("APP_MANAGE_RESOURCE_CHANGED");
    return task;
  }
  async #execute(params, backend, before) {
    const { operation, backendId, arguments: args } = params;
    let targetId, agentId = null, status = "saved", revision = null;
    if (operation.startsWith("cron_")) {
      if (operation === "cron_create") {
        const result = await backend.createCronJob({ ...args, schedule: externalSchedule(args.schedule, backendId) });
        targetId = text(result?.id, 512); agentId = args.agentId;
        if (!targetId) throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
      } else {
        targetId = args.jobId; agentId = before.agentId ?? null;
        if (operation === "cron_delete") { await backend.deleteCronJob(targetId); status = "deleted"; }
        else if (operation === "cron_run_now") {
          const value = await backend.runCronJob(targetId);
          if (value?.ok === false || value?.ran === false) throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
          return { operation, backendId, targetId, agentId, status: "accepted", revision: resourceRevision("cron", before) };
        } else {
          const patch = operation === "cron_set_enabled" ? { enabled: args.enabled } : { ...args.patch };
          if (patch.schedule) patch.schedule = externalSchedule(patch.schedule, backendId);
          for (const key of ["model", "provider"]) if (patch[key] === null) patch[key] = "";
          await backend.updateCronJob(targetId, patch);
        }
      }
      const after = array(await backend.getCronJobs({ strict: true })).find(row => row.id === targetId);
      if (status === "deleted" ? after !== undefined : !after) throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
      if (after) {
        const patch = operation === "cron_update" ? args.patch : operation === "cron_set_enabled" ? { enabled: args.enabled } : args;
        for (const key of ["name", "enabled", "prompt", "model", "provider", "agentId"]) if (Object.hasOwn(patch, key)
          && (patch[key] ?? null) !== (after[key] ?? null)) throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
        if (patch.schedule) {
          const expected = patch.schedule, actual = after.schedule;
          if (actual?.kind !== expected.kind || expected.kind === "cron" && (actual.expr !== expected.expr
              || backendId === "openclaw" && (actual.tz ?? "") !== expected.tz)
            || expected.kind === "every" && (actual.everyMs !== expected.everyMs
              || backendId === "openclaw" && (actual.anchorMs ?? 0) !== expected.anchorMs)
            || expected.kind === "at" && (typeof actual.at === "number" ? actual.at : Date.parse(actual.at)) !== expected.at)
            throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
        }
        revision = resourceRevision("cron", after); agentId = after.agentId ?? agentId;
      }
    } else {
      const opts = { board: args.boardId };
      if (operation === "kanban_card_create") {
        const spec = { title: args.title, body: args.body, assignee: args.assignee, priority: args.priority ?? 0 };
        if (backendId === "openclaw") { delete spec.assignee; delete spec.priority; spec.agentId = args.assignee; spec.priorityLevel = args.priority ?? "normal"; }
        const value = await backend.createTask(spec, opts);
        targetId = typeof value?.id === "number" ? String(value.id) : text(value?.id, 512);
        if (!targetId) throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
      } else {
        targetId = args.cardId;
        if (operation === "kanban_card_delete") { await backend.deleteTask(targetId, opts); status = "deleted"; }
        else {
          const patch = operation === "kanban_card_move" ? { column: args.status } : { ...args.patch };
          if (backendId === "openclaw") {
            if (Object.hasOwn(patch, "assignee")) { patch.agentId = patch.assignee; delete patch.assignee; }
            if (Object.hasOwn(patch, "priority")) { patch.priorityLevel = patch.priority; delete patch.priority; }
          } else if (patch.assignee === null) patch.assignee = "";
          await backend.updateTask(targetId, patch, opts);
        }
      }
      const after = (await this.#board(backend, backendId, args.boardId)).find(row => String(row.id) === targetId);
      if (status === "deleted" ? after !== undefined : !after) throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
      if (after) {
        const patch = operation === "kanban_card_create" ? args : operation === "kanban_card_move" ? { column: args.status } : args.patch;
        let detail = after;
        if (Object.hasOwn(patch, "body") && after.body === undefined && after.wb?.notes === undefined) {
          if (typeof backend.getTask !== "function") throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
          detail = await backend.getTask(targetId, opts);
        }
        for (const key of ["title", "body", "column", "assignee", "priority"]) {
          if (!Object.hasOwn(patch, key)) continue;
          const actual = key === "body" ? detail.body ?? detail.wb?.notes ?? ""
            : key === "column" ? detail.column ?? detail.status
              : key === "assignee" ? detail.agentId ?? detail.assignee ?? null
                : key === "priority" ? detail.priorityLevel ?? detail.priority : detail[key];
          const expected = key === "priority" && patch[key] === null ? backendId === "openclaw" ? "normal" : 0 : patch[key];
          if ((actual === "" && key === "assignee" ? null : actual) !== expected) throw stateError("APP_MANAGE_OUTCOME_UNKNOWN");
        }
        revision = resourceRevision("card", after); agentId = after.agentId ?? after.assignee ?? null;
      }
    }
    return { operation, backendId, targetId, agentId: text(agentId, 128), status, revision };
  }
}

module.exports = { AppManagementHost };
