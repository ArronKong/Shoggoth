"use strict";

const { createHash } = require("node:crypto");
const { ACTIVE_WORK_RUN_STATUSES } = require("./work-run");

const MAX_STOP_IMPACT_RUNS = 50;
const SOURCES = new Set(["chat", "kanban", "cron", "inspiration"]);

function displayText(value, maxBytes) {
  if (typeof value !== "string" || !value.isWellFormed()) return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
  let result = "";
  for (const char of normalized) {
    if (Buffer.byteLength(result + char, "utf8") > maxBytes) break;
    result += char;
  }
  return result || null;
}

// Read all active states in one synchronous Service turn. Queues and schedules
// are retained; only runs whose execution will be interrupted belong here.
function createStopImpact({ runs, instanceNonce, profileFor, titleFor }) {
  const active = runs.filter((run) => ACTIVE_WORK_RUN_STATUSES.has(run.status))
    .sort((a, b) => a.id.localeCompare(b.id));
  const revision = createHash("sha256").update(JSON.stringify([
    instanceNonce,
    active.map((run) => [run.id, run.profileId, run.source, run.sourceId,
      run.status, run.waitingRequestId, run.runtimeTurnRef ?? run.codexTurnId]),
  ])).digest("hex");
  return {
    availability: "available",
    revision,
    totalCount: active.length,
    runs: active.slice(0, MAX_STOP_IMPACT_RUNS).map((run) => {
      // Missing/deleted display metadata must never hide an active run.
      let agentName = null;
      let title = null;
      try { agentName = displayText(profileFor(run.profileId)?.name, 128); } catch {}
      try { title = displayText(titleFor(run), 256); } catch {}
      return { runId: run.id, source: run.source, status: run.status, agentName, title };
    }),
  };
}

function validStopImpact(value) {
  const exact = (object, keys) => object && Object.getPrototypeOf(object) === Object.prototype
    && Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
  const text = (value, maxBytes) => value === null || (typeof value === "string"
    && value.length > 0 && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maxBytes);
  return exact(value, ["availability", "revision", "totalCount", "runs"])
    && value.availability === "available" && typeof value.revision === "string" && /^[a-f0-9]{64}$/u.test(value.revision)
    && Number.isSafeInteger(value.totalCount) && value.totalCount >= 0
    && Array.isArray(value.runs) && value.runs.length === Math.min(value.totalCount, MAX_STOP_IMPACT_RUNS)
    && new Set(value.runs.map((run) => run?.runId)).size === value.runs.length
    && value.runs.every((run) => exact(run, ["runId", "source", "status", "agentName", "title"])
      && typeof run.runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(run.runId)
      && SOURCES.has(run.source) && ACTIVE_WORK_RUN_STATUSES.has(run.status)
      && text(run.agentName, 128) && text(run.title, 256));
}

module.exports = { createStopImpact, validStopImpact, MAX_STOP_IMPACT_RUNS };
