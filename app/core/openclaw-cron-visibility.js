"use strict";

const DREAMING_EVENTS = new Set([
  "__openclaw_memory_core_short_term_promotion_dream__",
  "__openclaw_memory_core_light_sleep__",
  "__openclaw_memory_core_rem_sleep__",
]);

// Names, delivery settings and NO_REPLY are also valid for user-created jobs.
// Recognize only OpenClaw's reserved declarations and internal payloads.
function isOpenClawSystemCronJob(job) {
  if (job?.systemManaged === true) return true;
  const declaration = job?.declarationKey;
  if (typeof declaration === "string" && (
    declaration === "memory-core:memory-dreaming-promotion"
    || declaration.startsWith("heartbeat:")
    || declaration.startsWith("skill-collection-review:")
  )) return true;
  // heartbeat-task: declarations can belong to imported user tasks.
  const payload = job?.payload;
  if (payload?.kind === "heartbeat" || payload?.kind === "skillCollectionReview") return true;
  const token = payload?.kind === "agentTurn" ? payload.message
    : payload?.kind === "systemEvent" ? payload.text : undefined;
  return typeof token === "string" && DREAMING_EVENTS.has(token.trim());
}

function cronJobIdFromTask(task) {
  const match = /^agent:[^:]+:cron:(.+?)(?::run:[^:]+)?$/.exec(task?.sessionKey || "");
  return match ? `openclaw:${match[1]}` : null;
}

module.exports = { isOpenClawSystemCronJob, cronJobIdFromTask };
