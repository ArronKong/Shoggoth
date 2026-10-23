"use strict";

const APP_MANAGE_OPERATIONS = Object.freeze([
  "cron_create", "cron_update", "cron_set_enabled", "cron_delete", "cron_run_now", "cron_run_retry",
  "kanban_board_create", "kanban_board_update", "kanban_card_create", "kanban_card_update", "kanban_card_move",
  "kanban_card_archive", "kanban_card_delete", "kanban_run_dispatch", "kanban_run_retry", "kanban_add_comment",
]);
const EXTERNAL_MANAGE_BACKENDS = new Set(["openclaw", "hermes"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
function object(value) { return value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).every(key => typeof key === "string" && (() => {
    const field = Object.getOwnPropertyDescriptor(value, key); return field.enumerable && Object.hasOwn(field, "value");
  })()); }
function data(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => data(item, depth + 1));
  return object(value) && Object.keys(value).length <= 64 && Object.values(value).every(item => data(item, depth + 1));
}
function exact(value, names) { return object(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key)); }
function string(value, bytes, nullable = false) { return nullable && value === null || typeof value === "string"
  && value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(value) <= bytes; }
function schedule(value) {
  if (!object(value)) return false;
  if (value.kind === "cron") return exact(value, ["kind", "expr", "tz"]) && string(value.expr, 256) && string(value.tz, 128);
  if (value.kind === "every") return exact(value, ["kind", "everyMs", "anchorMs"])
    && Number.isSafeInteger(value.everyMs) && value.everyMs >= 60_000 && Number.isSafeInteger(value.anchorMs) && value.anchorMs >= 0;
  return exact(value, ["kind", "at"]) && value.kind === "at" && Number.isSafeInteger(value.at) && value.at >= 0;
}
function priority(value, backendId, nullable = false) {
  if (nullable && value === null) return true;
  return backendId === "hermes" ? Number.isSafeInteger(value) && value >= 0 && value <= 3
    : ["low", "normal", "high", "urgent"].includes(value);
}
function patch(value, allowed, backendId) {
  return object(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => allowed.includes(key)
    && (key === "enabled" ? typeof item === "boolean" : key === "schedule" ? schedule(item) : key === "priority" ? priority(item, backendId)
      : string(item, ["prompt", "body"].includes(key) ? 16 * 1024 : 512, ["model", "provider", "assignee", "priority"].includes(key))));
}
function validExternalManageArguments(operation, args, backendId) {
  const requestedSchedule = args.schedule ?? args.patch?.schedule;
  // Hermes accepts backend-local cron expressions and whole-minute intervals;
  // it has no timezone/anchor API. Reject discarded fields before an effect.
  if (requestedSchedule && backendId === "hermes" && (requestedSchedule.kind === "cron" && requestedSchedule.tz !== ""
    || requestedSchedule.kind === "every" && (requestedSchedule.everyMs % 60_000 !== 0 || requestedSchedule.anchorMs !== 0))) return false;
  if (backendId === "openclaw" && args.patch && Object.hasOwn(args.patch, "provider")) return false;
  if (operation === "cron_create") return exact(args, ["agentId", "name", "prompt", "schedule", "enabled", "model"])
    && ID.test(args.agentId || "") && string(args.name, 256) && string(args.prompt, 16 * 1024) && schedule(args.schedule)
    && typeof args.enabled === "boolean" && string(args.model, 512, true);
  if (operation === "cron_update") return exact(args, ["jobId", "patch"]) && ID.test(args.jobId || "")
    && patch(args.patch, ["name", "prompt", "schedule", "model", "provider", "enabled"], backendId);
  if (operation === "cron_set_enabled") return exact(args, ["jobId", "enabled"]) && ID.test(args.jobId || "") && typeof args.enabled === "boolean";
  if (["cron_delete", "cron_run_now"].includes(operation)) return exact(args, ["jobId"]) && ID.test(args.jobId || "");
  if (operation === "kanban_card_create") return exact(args, ["boardId", "title", "body", "assignee", "priority"])
    && string(args.boardId, 128) && string(args.title, 512) && string(args.body, 16 * 1024)
    && string(args.assignee, 128, true) && priority(args.priority, backendId, true);
  if (operation === "kanban_card_update") return exact(args, ["cardId", "boardId", "patch"])
    && string(args.cardId, 256) && string(args.boardId, 128)
    && patch(args.patch, ["title", "body", "column", "assignee", "priority"], backendId);
  if (operation === "kanban_card_move") return exact(args, ["cardId", "boardId", "status"])
    && string(args.cardId, 256) && string(args.boardId, 128) && string(args.status, 128);
  if (operation === "kanban_card_delete") return exact(args, ["cardId", "boardId"])
    && string(args.cardId, 256) && string(args.boardId, 128);
  return false;
}
function validAppManageArguments(value, validateNative) {
  if (!exact(value, ["operation", "backendId", "targetProfileId", "expectedRevision", "arguments"])
    || !APP_MANAGE_OPERATIONS.includes(value.operation) || !ID.test(value.backendId || "")
    || !(value.targetProfileId === null || ID.test(value.targetProfileId || ""))
    || !(value.expectedRevision === null || /^[a-f0-9]{64}$/u.test(value.expectedRevision || ""))
    || !object(value.arguments) || !data(value.arguments) || Buffer.byteLength(JSON.stringify(value.arguments)) > 32 * 1024) return false;
  const creation = ["cron_create", "kanban_board_create", "kanban_card_create"].includes(value.operation);
  if (creation !== (value.expectedRevision === null)) return false;
  if (EXTERNAL_MANAGE_BACKENDS.has(value.backendId)) return value.targetProfileId === null && validExternalManageArguments(value.operation, value.arguments, value.backendId);
  if (value.operation === "kanban_card_delete") return false; // Native cards use archive.
  if (value.operation === "kanban_card_archive") return exact(value.arguments, ["cardId", "archived"])
    && ID.test(value.arguments.cardId || "") && typeof value.arguments.archived === "boolean";
  return typeof validateNative === "function" && validateNative(value.operation, value.arguments);
}
function validHostManageArguments(value) {
  if (!object(value) || !Object.hasOwn(value, "operationId") || !Object.hasOwn(value, "createdAt")) return false;
  const { operationId, createdAt, ...args } = value;
  return /^mcp-v1-[a-f0-9]{48}$/u.test(operationId || "") && Number.isSafeInteger(createdAt) && createdAt >= 0
    && EXTERNAL_MANAGE_BACKENDS.has(args.backendId) && validAppManageArguments(args);
}

module.exports = { APP_MANAGE_OPERATIONS, EXTERNAL_MANAGE_BACKENDS, validAppManageArguments, validHostManageArguments };
