"use strict";

const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");

const MAX_BYTES = 16 * 1024;
const MAX_RECORDS = 32;
const METHODS = new Set(["service.hello", "service.status", "service.stopImpact", "chat.send", "chat.operation.get",
  "chat.session.runtime.get", "chat.session.runtime.state", "agent.binding.list", "agent.binding.sync",
  "profile.models.list", "profile.binding.models.list", "run.get", "run.events", "run.events.read",
  "group.get", "group.list", "group.history", "group.response.read", "group.member.models",
  "group.members.model", "group.send"]);
const PHASES = new Set(["connect", "response"]);

function normalizeRecord(value) {
  if (!value || !Number.isSafeInteger(value.timeMs) || value.timeMs < 0
    || !PHASES.has(value.phase) || value.code !== "REQUEST_TIMEOUT"
    || ![value.elapsedMs, value.timeoutMs, value.responseBytes].every(number => Number.isSafeInteger(number) && number >= 0)
    || value.timeoutMs === 0) return null;
  return { timeMs: value.timeMs, method: METHODS.has(value.method) ? value.method : "other",
    code: "REQUEST_TIMEOUT", phase: value.phase, elapsedMs: value.elapsedMs,
    timeoutMs: value.timeoutMs, responseBytes: value.responseBytes };
}

// Only the App backend writes this bounded support record. No request body,
// identifiers, paths, token, remote error or user text is persisted.
function recordServiceRequestTimeout({ paths, method, error }) {
  try {
    if (error?.code !== "REQUEST_TIMEOUT" || !path.isAbsolute(paths?.runtimeDir || "")
      || !path.isAbsolute(paths?.trustedRoot || "")) return false;
    const record = normalizeRecord({ ...error.serviceRequestDiagnostic, timeMs: Date.now(), method, code: "REQUEST_TIMEOUT" });
    if (!record) return false;
    const target = path.join(paths.runtimeDir, "service-request-diagnostics.json");
    let records = [];
    try {
      const previous = JSON.parse(readPrivateFile(target, { maxBytes: MAX_BYTES }).toString("utf8"));
      if (previous?.version !== 1 || !Array.isArray(previous.records)) return false;
      records = previous.records.slice(-(MAX_RECORDS - 1)).map(normalizeRecord).filter(Boolean);
    } catch (readError) {
      if (readError?.code !== "ENOENT") return false;
    }
    records.push(record);
    const body = `${JSON.stringify({ version: 1, records })}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) return false;
    atomicWritePrivateFile(target, body, { trustedRoot: paths.trustedRoot });
    return true;
  } catch {
    // Support logging must never change the result, retry, or admission state.
    return false;
  }
}

module.exports = { recordServiceRequestTimeout };
