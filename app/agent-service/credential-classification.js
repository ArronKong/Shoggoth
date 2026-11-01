"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
const CLASSIFICATION_VERSION = 2;
const N8N_PUBLIC = Object.freeze({ LOG_LEVEL: /^(?:debug|info|warn|error|silent)$/u,
  DISABLE_CONSOLE_OUTPUT: /^(?:true|false)$/u, N8N_MCP_TELEMETRY_DISABLED: /^(?:true|false)$/u,
  MCP_MODE: /^(?:stdio|http)$/u });
const PUBLIC_HTTP_TYPES = new Set(["application/json", "text/event-stream", "application/json, text/event-stream", "text/event-stream, application/json"]);
function classificationFor(spec) {
  const t = spec?.transport;
  // Shipped schemas attest public configuration, never a remote "secret:false"
  // flag. Bind each decision to the currently selected executable/transport.
  const n8n = t?.kind === "stdio-package" && t.registryType === "npm" && t.identifier === "n8n-mcp"
    || t?.kind === "stdio-command" && /^node(?:\.exe)?$/u.test(path.basename(t.command || ""))
      && t.args?.length === 1 && /\/node_modules\/n8n-mcp\/(?:build|dist)\/index\.js$/u.test(t.args[0]);
  return { version: CLASSIFICATION_VERSION, rule: n8n ? "n8n-mcp-env-v1" : "unknown-protected",
    digest: crypto.createHash("sha256").update(JSON.stringify([CLASSIFICATION_VERSION, spec?.id ?? null, t ?? null])).digest("hex"),
    isPublic: (section, key, value) => n8n && section === "env" && Object.hasOwn(N8N_PUBLIC, key)
      && typeof value === "string" && N8N_PUBLIC[key].test(value)
      || t?.kind === "remote" && section === "headers" && /^(?:accept|content-type)$/iu.test(key)
        && PUBLIC_HTTP_TYPES.has(value) };
}
module.exports = { CLASSIFICATION_VERSION, classificationFor };
