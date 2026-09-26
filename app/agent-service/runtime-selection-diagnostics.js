"use strict";

const { RUNTIME_ACCOUNT_RUNTIMES } = require("./runtime-account");
const { serviceError } = require("./security");

const MAX_SELECTION_DIAGNOSTIC_CANDIDATES = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// No free-form reason, prompt, path, account, model, provider or error text.
// Extend this vocabulary with the support contract, never by logging raw errors.
const RUNTIME_SELECTION_REASON_CODES = Object.freeze([
  "EXPLICIT_OVERRIDE", "CONVERSATION_AFFINITY", "FIXED_PROFILE", "PREFERRED_PROFILE",
  "AUTO_PRIORITY", "PRE_DISPATCH_FALLBACK", "NO_CANDIDATE", "SUPPORTED",
  "FACTS_UNKNOWN", "RUNTIME_DISABLED", "ADAPTER_MISSING", "ACCOUNT_MISSING",
  "AUTH_REQUIRED", "BINARY_UNAVAILABLE", "VERSION_UNSUPPORTED", "MODEL_UNSUPPORTED",
  "CAPABILITY_MISSING", "ATTACHMENT_UNSUPPORTED", "PERMISSION_UNSUPPORTED",
  "WORKSPACE_UNSUPPORTED", "PROVIDER_UNSUPPORTED", "SOURCE_UNSUPPORTED", "POLICY_DENIED",
]);

function exactDataRecord(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) throw new Error();
  return Object.fromEntries(keys.map((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new Error();
    return [key, field.value];
  }));
}

function reasonCode(value) {
  if (!RUNTIME_SELECTION_REASON_CODES.includes(value)) throw new Error();
  return value;
}

function runtimeId(value) {
  if (!RUNTIME_ACCOUNT_RUNTIMES.includes(value)) throw new Error();
  return value;
}

function runtimeSelectionDiagnostic(value) {
  try {
    const record = exactDataRecord(value, [
      "attemptId", "currentRuntime", "selectedRuntime", "reasonCode", "candidates",
    ]);
    if (typeof record.attemptId !== "string" || !UUID_PATTERN.test(record.attemptId)) throw new Error();
    const list = record.candidates;
    if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype) throw new Error();
    const length = Object.getOwnPropertyDescriptor(list, "length").value;
    if (length > MAX_SELECTION_DIAGNOSTIC_CANDIDATES
      || Reflect.ownKeys(list).length !== length + 1) throw new Error();
    const candidates = [];
    for (let index = 0; index < length; index += 1) {
      const field = Object.getOwnPropertyDescriptor(list, String(index));
      if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new Error();
      const candidate = exactDataRecord(field.value, ["runtime", "supported", "reasonCode"]);
      if (typeof candidate.supported !== "boolean") throw new Error();
      candidates.push(Object.freeze({
        runtime: runtimeId(candidate.runtime),
        supported: candidate.supported,
        reasonCode: reasonCode(candidate.reasonCode),
      }));
    }
    const selectedRuntime = record.selectedRuntime === null ? null : runtimeId(record.selectedRuntime);
    const code = reasonCode(record.reasonCode);
    if ((selectedRuntime === null) !== (code === "NO_CANDIDATE")
      || (selectedRuntime !== null && !candidates.some((candidate) => (
        candidate.runtime === selectedRuntime && candidate.supported
      )))) throw new Error();
    return Object.freeze({
      version: 1,
      mode: "shadow",
      attemptId: record.attemptId,
      currentRuntime: runtimeId(record.currentRuntime),
      selectedRuntime,
      reasonCode: code,
      candidates: Object.freeze(candidates),
    });
  } catch {
    throw serviceError("RUNTIME_SELECTION_DIAGNOSTIC_INVALID", "Runtime selection diagnostic is invalid");
  }
}

function createRuntimeSelectionDiagnostics({ enabled = false, emit } = {}) {
  // Kept as an opt-in diagnostic utility, not a V2.3 execution feature flag.
  if (typeof enabled !== "boolean" || (emit !== undefined && typeof emit !== "function")) {
    throw serviceError("RUNTIME_SELECTION_DIAGNOSTIC_INVALID", "Runtime selection diagnostic sink is invalid");
  }
  return Object.freeze({
    record(value) {
      // An off switch must not inspect an attempt, perform I/O, or call a sink.
      if (!enabled || !emit) return false;
      try {
        const event = runtimeSelectionDiagnostic(value);
        // A diagnostic failure must never fail, retry or reroute a real turn.
        Promise.resolve(emit("runtime.selection.shadow", event)).catch(() => {});
        return true;
      } catch {
        return false;
      }
    },
  });
}

module.exports = {
  MAX_SELECTION_DIAGNOSTIC_CANDIDATES,
  RUNTIME_SELECTION_REASON_CODES,
  createRuntimeSelectionDiagnostics,
  runtimeSelectionDiagnostic,
};
