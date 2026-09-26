"use strict";

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 32 * 1024;
const DEFAULT_MAX_REGISTERED_SECRETS = 256;
const DEFAULT_MAX_REGISTERED_SECRET_BYTES = 1024 * 1024;
const SECRET_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  /\b(?:[a-z0-9]+[_-])*(?:token|api[_-]?key|secret(?:[_-]access[_-]key)?|authorization)\s*[:=]\s*["']?[^\s"']{8,}/gi,
]);

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validRequestId(id) {
  return (typeof id === "string" && id.length > 0)
    || (typeof id === "number" && Number.isSafeInteger(id));
}

function validateRegisteredSecrets(values = []) {
  if (!Array.isArray(values)) {
    throw rpcError("RPC_REGISTERED_SECRET_INVALID", "Registered secrets must be an array");
  }
  const secrets = [];
  let totalBytes = 0;
  for (const value of values) {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 4) {
      throw rpcError(
        "RPC_REGISTERED_SECRET_INVALID",
        "Registered secrets must be strings of at least 4 UTF-8 bytes",
      );
    }
    if (secrets.includes(value)) continue;
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (secrets.length >= DEFAULT_MAX_REGISTERED_SECRETS
      || totalBytes + valueBytes > DEFAULT_MAX_REGISTERED_SECRET_BYTES) {
      throw rpcError("RPC_REGISTERED_SECRET_LIMIT", "Registered secret capacity was exceeded");
    }
    secrets.push(value);
    totalBytes += valueBytes;
  }
  return secrets;
}

function containsRegisteredSecret(value, registeredSecrets = []) {
  const text = String(value ?? "");
  return registeredSecrets.some((secret) => text.includes(secret));
}

function redactionMarker(registeredSecrets) {
  for (const candidate of ["[REDACTED]", "[FILTERED]", "[HIDDEN]", "<MASK>", "!"]) {
    if (!containsRegisteredSecret(candidate, registeredSecrets)) return candidate;
  }
  return "!";
}

function redactDiagnostic(value, registeredSecrets = []) {
  const secrets = validateRegisteredSecrets(registeredSecrets);
  let text = String(value ?? "");
  const marker = redactionMarker(secrets);
  for (const secret of secrets) {
    text = text.split(secret).join(marker);
  }
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, marker);
  // Different replacements can join at their boundaries and form another
  // registered value. Never emit a diagnostic unless the final text is clean.
  if (containsRegisteredSecret(text, secrets)) return "";
  return text;
}

function truncateUtf8Tail(value, limit) {
  if (limit <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return value;
  return bytes.subarray(bytes.length - limit).toString("utf8").replace(/^\uFFFD+/, "");
}

function boundedTimeout(task, timeoutMs, timeoutError) {
  if (timeoutMs === null) return Promise.resolve().then(task);
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = {
  boundedTimeout,
  containsRegisteredSecret,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_REGISTERED_SECRETS,
  DEFAULT_MAX_REGISTERED_SECRET_BYTES,
  DEFAULT_MAX_STDERR_BYTES,
  redactDiagnostic,
  rpcError,
  truncateUtf8Tail,
  validateRegisteredSecrets,
  validRequestId,
};
