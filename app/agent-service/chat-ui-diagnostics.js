"use strict";
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { MESSAGES } = require("./chat-ui-messages");
const STAGES = new Set(["publication.prepare", "publication.publish", "publication.state.read", "service.request",
  ...["describe", "open", "read", "export", "renew", "close", "state.save", "action", "operation.get", "import"].map(name => `service.${name}`),
  "renderer.mount", "renderer.ready", "renderer.failure", "renderer.close"]);
const CODES = new Set(["OK", "UNKNOWN", ...Object.keys(MESSAGES), "UI_HOST_CLOSED", "UI_HOST_CAPACITY", "UI_MOUNT_INVALID",
  "UI_MOUNT_CONFLICT", "UI_NAVIGATION_BLOCKED", "UI_BRIDGE_REJECTED"]);
const IDS = ["profileId", "sessionKey", "artifactId", "sourceEventId", "publicationId", "operationId",
  "actionRequestId", "runId", "leaseId", "mountId"];
const STATUSES = new Set(["preparing", "ready", "accepted", "queued", "running", "completed", "failed", "cancelled", "expired", "unknown", "closed"]);
const NUMBERS = ["revision", "stateRevision", "htmlBytes", "requestBytes", "responseBytes"];
function diagnosticBytes(value) {
  try { const text = JSON.stringify(value); return text === undefined ? 0 : Math.min(Buffer.byteLength(text), 16 * 1024 * 1024); }
  catch { return 0; }
}
function diagnosticMetadata(input, result) {
  const part = result?.part || result, record = {};
  for (const key of [...IDS, ...NUMBERS]) record[key] = part?.[key] ?? result?.[key] ?? input?.[key];
  record.requestBytes = diagnosticBytes(input); record.responseBytes = diagnosticBytes(result);
  if (result?.errorCode) record.code = result.errorCode;
  else if (["failed", "expired", "unknown"].includes(result?.status)) record.code = "UNKNOWN";
  record.status = result?.status; return record;
}
// Operational logs are separate from the private journal. No HTML, state,
// prompts, paths, declarations, error messages or credentials cross this sink.
function createChatUiDiagnostics({ plane = "service", sink, now = Date.now, clock = () => performance.now(), intervalMs = 5000 } = {}) {
  const recent = [], buckets = new Map();
  const write = sink || (record => console.info("[native-chat-ui]", JSON.stringify(record)));
  const emit = (stage, metadata = {}) => {
    try {
      if (!STAGES.has(stage)) return null;
      const code = CODES.has(metadata.code) ? metadata.code : "UNKNOWN";
      const at = now(), record = { component: "native-chat-ui", plane: plane === "renderer" ? "renderer" : "service", stage, code,
        at: Number.isSafeInteger(at) ? at : Date.now(), durationMs: Number.isFinite(metadata.durationMs) ? Math.max(0, Math.round(metadata.durationMs * 1000) / 1000) : 0 };
      if (STATUSES.has(metadata.status)) record.status = metadata.status;
      for (const key of IDS) if (typeof metadata[key] === "string" && metadata[key].length <= 1024) {
        record[`${key}Hash`] = crypto.createHash("sha256").update(metadata[key]).digest("hex").slice(0, 32);
      }
      for (const key of NUMBERS) if (Number.isSafeInteger(metadata[key]) && metadata[key] >= 0) record[key] = Math.min(metadata[key], 16 * 1024 * 1024);
      const key = `${stage}:${code}`, old = buckets.get(key), throttled = old && at >= old.at && at - old.at < intervalMs;
      if (!throttled && old?.suppressed) record.suppressed = old.suppressed;
      recent.push(Object.freeze(record)); if (recent.length > 128) recent.shift();
      if (throttled) { old.suppressed = Math.min(Number.MAX_SAFE_INTEGER, old.suppressed + 1); return record; }
      // Both stage and code are closed sets; also bound observation caches.
      if (buckets.size >= 128 && !buckets.has(key)) buckets.delete(buckets.keys().next().value);
      buckets.set(key, { at, suppressed: 0 });
      try { const pending = write(Object.freeze({ ...record })); pending?.catch?.(() => {}); } catch { /* Observation cannot change authority. */ }
      return record;
    } catch { return null; }
  };
  const tick = () => { try { const value = clock(); return Number.isFinite(value) ? value : performance.now(); } catch { return performance.now(); } };
  const measure = (stage, metadata, task) => {
    const started = tick();
    const finish = (value, error) => { try {
      const details = typeof metadata === "function" ? metadata(value) : metadata;
      emit(stage, { ...details, durationMs: tick() - started, code: error?.code || (error ? "UNKNOWN" : details?.code || "OK") });
    } catch { /* Keep the original result. */ } };
    try {
      const result = task();
      if (result && typeof result.then === "function") return Promise.resolve(result).then(value => { finish(value); return value; }, error => { finish(null, error); throw error; });
      finish(result); return result;
    } catch (error) { finish(null, error); throw error; }
  };
  return { emit, measure, snapshot: () => recent.map(record => ({ ...record })) };
}
module.exports = { createChatUiDiagnostics, diagnosticBytes, diagnosticMetadata };
