"use strict";

// `${secret:NAME}` is the only way a plugin MCP declaration names a credential
// the user supplies. It may be a stdio env value or an HTTP header value
// (optionally after "Bearer "). The Service resolves it when it starts the
// declared process or sends a request to the declared endpoint; the value never
// enters package files, the model context or the transcript. Pure: no IO.
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const REFERENCE = /^(Bearer )?\$\{secret:([A-Z][A-Z0-9_]{0,63})\}$/u;
const MARKER = "${secret:";
const MAX_COMPONENT_SECRETS = 16;
// A credential must never steer the loader, interpreter or shell of the process.
const UNSAFE_ENV = /^(?:NODE_|PYTHON|LD_|DYLD_|NPM_|UV_|VIRTUAL_ENV|CONDA|PATH$|HOME$|SHELL$|ENV$|BASH_ENV$|LOGNAME$|USER$|TMPDIR$|PLUGIN_ROOT$|PLUGIN_DATA$)/iu;
const UNSAFE_HEADERS = new Set(["cookie", "proxy-authorization", "host", "content-length",
  "content-type", "accept", "connection", "transfer-encoding", "mcp-session-id", "mcp-protocol-version"]);

function secretReference(value, { allowBearer = false } = {}) {
  if (typeof value !== "string") return null;
  const match = REFERENCE.exec(value);
  if (!match || (match[1] && !allowBearer)) return null;
  return Object.freeze({ name: match[2], prefix: match[1] || "" });
}

function mentionsSecret(value) {
  return typeof value === "string" && value.includes(MARKER);
}

// Returns the ordered secret references of one MCP server record, [] when it has
// none, and null when a reference is malformed or appears outside env/header values.
function declaredSecrets(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  const result = [];
  const visit = (map, target) => {
    if (map === undefined) return true;
    if (!map || typeof map !== "object" || Array.isArray(map)) return true;
    for (const [key, value] of Object.entries(map)) {
      if (!mentionsSecret(value)) continue;
      const reference = secretReference(value, { allowBearer: target === "header" });
      if (!reference || (target === "env" && UNSAFE_ENV.test(key))
        || (target === "header" && UNSAFE_HEADERS.has(key.toLowerCase()))) return false;
      result.push(Object.freeze({ name: reference.name, target, key, prefix: reference.prefix }));
    }
    return true;
  };
  const stdio = record.type === "stdio" || (record.type === undefined && typeof record.command === "string");
  if (!visit(record.env, "env") || (!stdio && !visit(record.headers, "header"))) return null;
  if (stdio && record.headers !== undefined && Object.values(record.headers || {}).some(mentionsSecret)) return null;
  const elsewhere = [record.command, record.cwd, record.url,
    ...(Array.isArray(record.args) ? record.args : [])];
  if (elsewhere.some(mentionsSecret) || result.length > MAX_COMPONENT_SECRETS) return null;
  return Object.freeze(result);
}

function secretNames(declared) {
  return Object.freeze([...new Set((declared || []).map(item => item.name))].sort());
}

module.exports = { SECRET_NAME, MAX_COMPONENT_SECRETS, secretReference, mentionsSecret,
  declaredSecrets, secretNames };
