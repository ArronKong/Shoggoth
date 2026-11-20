"use strict";

// Exact Service request shapes for the App's background-task management. The
// UI acts only on the conversation the user has open; ownership is checked
// again by BackgroundTaskService against the stored source conversation.
const { serviceError } = require("./security");
const { MAX_GENERATIONS, MAX_MESSAGE_BYTES, MAX_TASK_TITLE_BYTES, TASK_ID_PATTERN, validText } = require("./background-task-protocol");

const BACKGROUND_TASK_SERVICE_METHODS = new Set([
  "background.task.list", "background.task.get", "background.task.session", "background.task.send", "background.task.cancel", "background.task.respond",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

const ownObject = value => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, fields) => ownObject(value) && Object.keys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field));
const invalid = () => serviceError("INVALID_PARAMS", "后台任务参数无效");

function validAnswers(value) {
  return ownObject(value) && Object.keys(value).length <= 32 && Object.entries(value).every(([key, item]) => OPAQUE.test(key)
    && typeof item === "string" && item.isWellFormed() && !item.includes("\0") && Buffer.byteLength(item) <= 16 * 1024);
}

function validateBackgroundTaskParams(method, params) {
  const base = ["sessionKey"];
  const withTask = [...base, "taskId"];
  let ok;
  if (method === "background.task.list") ok = exact(params, base);
  else if (method === "background.task.get" || method === "background.task.session") ok = exact(params, withTask);
  else if (method === "background.task.send") ok = exact(params, [...withTask, "message", "operationId"])
    && validText(params.message, MAX_MESSAGE_BYTES);
  else if (method === "background.task.cancel") ok = exact(params, [...withTask, "operationId"]);
  else if (method === "background.task.respond") {
    ok = params?.kind === "approval"
      ? exact(params, [...withTask, "operationId", "requestId", "kind", "choice"]) && typeof params.choice === "string"
        && params.choice.length > 0 && params.choice.length <= 256
      : params?.kind === "input"
        ? exact(params, [...withTask, "operationId", "requestId", "kind", "action", "answers"])
          && ["submit", "cancel"].includes(params.action) && validAnswers(params.answers)
        : false;
    ok &&= OPAQUE.test(params.requestId);
  } else ok = false;
  if (!ok || !UUID.test(params.sessionKey) || (Object.hasOwn(params, "taskId") && !TASK_ID_PATTERN.test(params.taskId))
    || (Object.hasOwn(params, "operationId") && !OPAQUE.test(params.operationId))) throw invalid();
  return params;
}

const TASK_FIELDS = ["taskId", "title", "status", "runtime", "generation", "sourceRunId", "report", "errorCode",
  "createdAt", "updatedAt", "finishedAt", "startedAt"];
const responseInvalid = () => serviceError("CHAT_RESPONSE_INVALID", "后台任务响应无效");
const time = value => Number.isSafeInteger(value) && value >= 0;
const nullableTime = value => value === null || time(value);
const text = (value, max) => typeof value === "string" && value.isWellFormed() && Buffer.byteLength(value) <= max;

function validTask(value) {
  const { TASK_STATUSES, REPORT_STATES } = require("./background-task-protocol");
  return exact(value, TASK_FIELDS) && TASK_ID_PATTERN.test(value.taskId) && text(value.title, MAX_TASK_TITLE_BYTES)
    && TASK_STATUSES.includes(value.status) && OPAQUE.test(value.runtime) && Number.isSafeInteger(value.generation)
    && value.generation >= 1 && OPAQUE.test(value.sourceRunId) && REPORT_STATES.includes(value.report)
    && (value.errorCode === null || OPAQUE.test(value.errorCode)) && time(value.createdAt) && time(value.updatedAt)
    && nullableTime(value.finishedAt) && nullableTime(value.startedAt);
}

function validMessage(item) {
  return exact(item, ["id", "role", "text", "at", "runId", "activity"]) && OPAQUE.test(item.id)
    && ["user", "assistant"].includes(item.role) && text(item.text, 1024 * 1024) && time(item.at)
    && (item.runId === null || OPAQUE.test(item.runId)) && typeof item.activity === "boolean";
}

// The App backend accepts only these exact result shapes from the Service.
function validateBackgroundTaskResult(method, value) {
  let ok;
  if (method === "background.task.list") ok = exact(value, ["tasks"]) && Array.isArray(value.tasks) && value.tasks.length <= 4096
    && value.tasks.every(validTask);
  else if (method === "background.task.session") {
    ok = exact(value, ["session", "brief"]) && (value.brief === null || validMessage(value.brief) && value.brief.role === "user")
      && (value.session === null
      || (exact(value.session, ["sessionKey", "profileId", "runtimeBindingId", "status"])
        && UUID.test(value.session.sessionKey) && UUID.test(value.session.profileId) && OPAQUE.test(value.session.runtimeBindingId)
        && ["draft", "ready", "archived"].includes(value.session.status)));
  }
  else if (method === "background.task.get") {
    const hasQueued = Object.hasOwn(value || {}, "queuedFollowUps");
    ok = exact(value, ["task", "messages", "files", "interaction", "queueReason", ...(hasQueued ? ["queuedFollowUps"] : [])])
      && (!hasQueued || (Number.isSafeInteger(value.queuedFollowUps) && value.queuedFollowUps > 0 && value.queuedFollowUps < MAX_GENERATIONS))
      && validTask(value.task)
      && Array.isArray(value.messages) && value.messages.length <= 200 && value.messages.every(validMessage)
      && Array.isArray(value.files) && value.files.length <= 64 && value.files.every(item =>
        exact(item, ["fileId", "name", "generation", "url", "path"]) && OPAQUE.test(item.fileId) && text(item.name, 1024)
        && Number.isSafeInteger(item.generation) && (item.url === null || text(item.url, 2048))
        && (item.path === null || text(item.path, 4096)))
      && (value.interaction === null || (exact(value.interaction, ["runId", "type", "payload"]) && OPAQUE.test(value.interaction.runId)
        && ["approval", "prompt"].includes(value.interaction.type) && ownObject(value.interaction.payload)))
      && (value.queueReason === null || OPAQUE.test(value.queueReason));
  } else if (["background.task.send", "background.task.cancel", "background.task.respond"].includes(method)) {
    ok = ownObject(value) && validTask(value.task) && Object.keys(value).every(key => ["task", "delivered"].includes(key))
      && (value.delivered === undefined || ["steered", "new_run", "queued", "canceled"].includes(value.delivered));
  } else ok = false;
  if (!ok) throw responseInvalid();
  return structuredClone(value);
}

module.exports = { BACKGROUND_TASK_SERVICE_METHODS, validateBackgroundTaskParams, validateBackgroundTaskResult };
