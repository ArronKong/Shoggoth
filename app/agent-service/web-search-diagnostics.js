"use strict";

const path = require("node:path");
const { readPrivateFile, atomicWritePrivateFile } = require("./private-file");
const { PROVIDERS } = require("./web-settings-protocol");

const MAX_RECORDS = 32;
const MAX_BYTES = 8192;
const PHASES = new Set(["dns", "connect", "tls", "response", "body", "http"]);
const TRANSIENT_DNS_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "DNS_EMPTY"]);
const TRANSIENT_CONNECTION_CODES = new Set([
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTDOWN", "EHOSTUNREACH",
  "ENETDOWN", "ENETUNREACH", "EPIPE", "ETIMEDOUT",
]);
const CODES = new Set([
  ...TRANSIENT_DNS_CODES, ...TRANSIENT_CONNECTION_CODES,
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function webNetworkFailure(phase, code, status) {
  if (phase === "http" && Number.isInteger(status) && status >= 100 && status <= 599) {
    return { phase, code: "HTTP_STATUS", status };
  }
  return { phase, code: CODES.has(code) ? code : "OTHER" };
}

function normalizeRecord(value) {
  if (!value || !Number.isSafeInteger(value.timeMs) || value.timeMs < 0
    || !PROVIDERS.includes(value.provider) || !PHASES.has(value.phase)
    || typeof value.retry !== "boolean") return null;
  const { timeMs, provider, phase, code, status, retry } = value;
  return { timeMs, provider, ...webNetworkFailure(phase, code, status), retry };
}

// Keep only the bounded diagnostic projection. Request URLs, search text,
// headers, authorization and raw upstream errors never enter this file.
function recordWebSearchFailure(paths, failure) {
  try {
    const record = normalizeRecord({ ...failure, timeMs: Date.now() });
    if (!record || !path.isAbsolute(paths.runtimeDir) || !path.isAbsolute(paths.trustedRoot)) return false;
    const file = path.join(paths.runtimeDir, "web-search-diagnostics.json");
    let records = [];
    try {
      const previous = JSON.parse(readPrivateFile(file, { maxBytes: MAX_BYTES }).toString("utf8"));
      if (previous?.version !== 1 || !Array.isArray(previous.records)) return false;
      records = previous.records.slice(-(MAX_RECORDS - 1)).map(normalizeRecord).filter(Boolean);
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    records.push(record);
    atomicWritePrivateFile(file, `${JSON.stringify({ version: 1, records })}\n`, { trustedRoot: paths.trustedRoot });
    return true;
  } catch {
    return false;
  }
}

module.exports = { TRANSIENT_DNS_CODES, TRANSIENT_CONNECTION_CODES, webNetworkFailure, recordWebSearchFailure };
