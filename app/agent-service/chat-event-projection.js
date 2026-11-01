"use strict";

// This policy is restricted to canonical private conversation events. It never
// accepts remote schemas. Every business string is projected AND checked; only
// locally defined wire keys/enums are treated as structure. Other event types
// retain the original whole-object check.
const fields = {
  text: ["method", "itemId", "toolCallId", "text", "phase", "delivery", "segmentId", "sourceEventId", "transcriptSeq"],
  "text.delta": ["method", "itemId", "toolCallId", "delta", "phase", "delivery", "segmentId"],
  "text.fragment": ["method", "itemId", "toolCallId", "data", "fragment", "phase", "delivery", "segmentId", "sourceEventId", "transcriptSeq"],
  reasoning: ["method", "itemId", "toolCallId", "text", "reasoning", "summaryIndex"],
  "reasoning.delta": ["method", "itemId", "toolCallId", "delta", "summaryIndex", "contentIndex"],
  plan: ["method", "itemId", "toolCallId", "text", "delta", "explanation", "plan"],
  "tool.start": ["method", "itemId", "toolCallId", "tool", "redacted"],
  "tool.update": ["method", "itemId", "toolCallId", "tool", "delta", "patch", "progress", "changes", "message", "redacted"],
  "tool.result": ["method", "itemId", "toolCallId", "tool", "redacted"],
  terminal: ["status", "resultSummary", "errorCode", "recovered", "cronOutput"],
  status: ["method", "status", "stage", "reason", "requestId", "queuedAt", "retryAt", "queueWaitMs"],
};
const toolKeys = new Set(["kind", "name", "status", "success", "exitCode", "errorCode", "displayArgs", "resultSummary", "resultTruncated", "pluginAppCallId", "durationMs"]);
const business = new Set(["text", "delta", "data", "reasoning", "explanation", "plan", "displayArgs", "resultSummary", "patch", "progress", "changes", "message", "cronOutput", "arguments", "output"]);
const enums = {
  status: ["queued", "starting", "running", "waiting_input", "waiting_approval", "completed", "failed", "canceled", "interrupted", "error", "declined"],
  phase: ["analysis", "commentary", "final", "final_answer"], delivery: ["append", "replace"],
  source: ["chat", "cron", "kanban", "inspiration", "compaction", "proactive", "automation"],
};
function ownPlain(value) { return value && Object.getPrototypeOf(value) === Object.prototype; }
function supported(payload, context) { return context.kind === "event" && fields[context.type] && ownPlain(payload); }
function strings(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(strings);
  return Object.entries(value).flatMap(([key, child]) => [key, ...strings(child)]);
}
function businessProjection(value, projectText) {
  if (typeof value === "string") return projectText(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => businessProjection(item, projectText));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [projectText(key), businessProjection(child, projectText)]));
}
function projectChatEvent(payload, context, projectText) {
  if (context.kind === "snapshot" && ownPlain(payload) && ownPlain(payload.run)) {
    require("./product-store").validateWorkRun(payload.run, payload.run.source === "automation" ? "automation" : null);
    return { ...payload, run: { ...payload.run,
      resultSummary: typeof payload.run.resultSummary === "string" ? projectText(payload.run.resultSummary) : payload.run.resultSummary } };
  }
  if (!supported(payload, context)) return payload;
  const result = {};
  for (const [key, value] of Object.entries(payload)) {
    if (business.has(key)) result[key] = businessProjection(value, projectText);
    else if (key === "tool" && ownPlain(value)) result[key] = Object.fromEntries(Object.entries(value)
      .map(([field, child]) => [field, business.has(field) ? businessProjection(child, projectText) : child]));
    else result[key] = value;
  }
  return result;
}
function checkProjectedChatEvent(payload, context, check) {
  if (context.kind === "snapshot" && ownPlain(payload) && ownPlain(payload.run)) {
    require("./product-store").validateWorkRun(payload.run, payload.run.source === "automation" ? "automation" : null);
    const { run, ...rest } = payload;
    const values = Object.entries(run).filter(([key, child]) => !enums[key]?.includes(child)).flatMap(([, child]) => valueStrings(child));
    return check([...values, ...strings(rest)], context);
  }
  if (!supported(payload, context)) return check(payload, context);
  const scan = [];
  const collect = (value, allowed) => {
    for (const [key, child] of Object.entries(value)) {
      if (!allowed.has(key)) { scan.push(key, ...strings(child)); continue; }
      if (key === "tool" && ownPlain(child)) collect(child, toolKeys);
      else if (Object.hasOwn(enums, key) && typeof child === "string" && enums[key].includes(child)) continue;
      else scan.push(...strings(child));
    }
  };
  collect(payload, new Set(fields[context.type]));
  // This callback still scans every free string and dynamic field name. No
  // completion result is declared safe merely because its operation succeeded.
  return check(scan, context);
}
function valueStrings(input) {
  if (typeof input === "string") return [input];
  return input && typeof input === "object" ? Object.values(input).flatMap(valueStrings) : [];
}
function projectTranscriptContent(content, projectText) {
  if (!ownPlain(content)) return content;
  const projected = projectChatEvent(content, { kind: "event", type: content.transcriptType }, projectText);
  if (projected !== content) return projected;
  return Object.fromEntries(Object.entries(content).map(([key, value]) => [key,
    business.has(key) ? businessProjection(value, projectText) : value]));
}
module.exports = { projectChatEvent, checkProjectedChatEvent, projectTranscriptContent };
