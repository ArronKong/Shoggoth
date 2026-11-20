"use strict";

// Identities and public wire shapes for native background tasks. This module
// stays dependency-free: the transcript store and context compiler use the
// report predicate while loading, before any Service component is available.
const crypto = require("node:crypto");

const TASK_ID_PATTERN = /^bgt-[a-f0-9]{48}$/u;
const REPORT_EVENT_PATTERN = /^background-report-[a-f0-9]{64}$/u;
const MAX_BRIEF_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_TITLE_CHARS = 80;
const MAX_GENERATIONS = 16;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const WAITING_RUN_STATUSES = new Set(["waiting_approval", "waiting_input"]);
const TASK_STATUSES = Object.freeze(["starting", "queued", "running", "waiting_approval", "waiting_input",
  "stopping", "completed", "failed", "canceled", "interrupted", "needs_verification"]);
const REPORT_STATES = Object.freeze(["none", "pending", "delivered", "held", "withheld"]);
const BRIEF_MARKER = "\n\nTask brief:\n";
const FOLLOW_UP_MARKER = "\n\nInstruction:\n";
const STEER_PREFIX = "Additional instruction from the user for this background task:\n";
// Runtimes whose separate session, permissions, approval/stop, terminal state
// and public final answer were verified for background work. Others are
// rejected before acceptance.
const BACKGROUND_TASK_RUNTIMES = Object.freeze(new Set(["codex", "pi", "opencode", "deepseek-harness", "antigravity"]));

const PUBLIC_MESSAGES = Object.freeze({
  BACKGROUND_TASK_SOURCE_REQUIRED: "Background tasks can be started and managed only from the user's direct chat with this native Agent, in the conversation that started them. Background sessions cannot start further background tasks.",
  BACKGROUND_TASK_NOT_FOUND: "No background task with this ID belongs to the current conversation. Call background_task_get without taskId to list this conversation's tasks.",
  BACKGROUND_TASK_LIMIT: "This Agent already has the maximum number of unfinished background tasks. Wait for one to finish or stop one first.",
  BACKGROUND_TASK_BINDING_UNAVAILABLE: "The requested runtime binding is not an enabled binding of this Agent that supports background tasks. Keep the current runtime or ask the user to choose an available one.",
  BACKGROUND_TASK_WAITING: "This background task is waiting for the user's approval or input. The user answers it from the task card in this conversation; do not answer it yourself.",
  BACKGROUND_TASK_STOPPING: "This background task is stopping. Wait until it has stopped before sending more instructions.",
  BACKGROUND_TASK_CONFLICT: "This operation was already used with different arguments. Start a new tool call instead of retrying with changed input.",
  BACKGROUND_TASK_UNAVAILABLE: "Background tasks are temporarily unavailable. Report this to the user; do not retry immediately.",
});

const sha256 = (...parts) => {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(String(part)).update("\0");
  return hash.digest("hex");
};

function backgroundTaskId(profileId, operationId) {
  return `bgt-${sha256("shoggoth-background-task-v1", profileId, operationId).slice(0, 48)}`;
}

function backgroundReportEventId(taskId, generation) {
  return `background-report-${sha256("shoggoth-background-report-v1", taskId, generation)}`;
}

function backgroundTaskOperations(taskId, generation) {
  return { create: `bg-create-${taskId}`, send: `bg-send-${taskId}-${generation}` };
}

function isBackgroundTaskOperation(operationId) {
  return typeof operationId === "string" && (operationId.startsWith("bg-send-bgt-") || operationId.startsWith("bg-steer-bgt-"));
}

function visibleBackgroundInstruction(text) {
  if (typeof text !== "string") return "";
  if (text.startsWith("[Shoggoth background task")) {
    for (const marker of [BRIEF_MARKER, FOLLOW_UP_MARKER]) {
      const at = text.indexOf(marker);
      if (at >= 0) return text.slice(at + marker.length);
    }
  }
  return text.startsWith(STEER_PREFIX) ? text.slice(STEER_PREFIX.length) : text;
}

// Runless publications are written by the Service only. The report reuses the
// published-notice context path, so its identity must be derivable from its
// own task and generation and never from model output.
function isBackgroundTaskReportEvent(event) {
  const report = event?.content?.backgroundTaskReport;
  return event?.kind === "assistant" && event.runId === null && event.runtimeRef === null
    && !!report && typeof report === "object" && TASK_ID_PATTERN.test(report.taskId ?? "")
    && Number.isSafeInteger(report.generation) && report.generation >= 1 && report.generation <= MAX_GENERATIONS
    && REPORT_EVENT_PATTERN.test(event.id ?? "") && event.id === backgroundReportEventId(report.taskId, report.generation)
    && typeof event.content.text === "string" && event.content.text.trim().length > 0;
}

function utf8Bytes(value) { return Buffer.byteLength(value, "utf8"); }

function validText(value, maxBytes) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
    && value.trim().length > 0 && utf8Bytes(value) <= maxBytes;
}

function deriveTitle(brief) {
  const line = brief.split(/\r?\n/u).map(item => item.trim()).find(Boolean) || "";
  const chars = [...line.replace(/\s+/gu, " ")];
  return chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join("")}…` : chars.join("");
}

module.exports = {
  BACKGROUND_TASK_RUNTIMES, MAX_BRIEF_BYTES, MAX_GENERATIONS, MAX_MESSAGE_BYTES, MAX_TITLE_CHARS,
  PUBLIC_MESSAGES, REPORT_STATES, TASK_ID_PATTERN, TASK_STATUSES, TERMINAL_RUN_STATUSES, WAITING_RUN_STATUSES,
  BRIEF_MARKER, FOLLOW_UP_MARKER, STEER_PREFIX, visibleBackgroundInstruction,
  backgroundReportEventId, backgroundTaskId, backgroundTaskOperations, deriveTitle, isBackgroundTaskOperation,
  isBackgroundTaskReportEvent, validText,
};
