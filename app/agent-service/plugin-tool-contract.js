"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

const HASH = /^[a-f0-9]{64}$/u;
const STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_TOOLS = 256;
const MAX_CATALOG_BYTES = 256 * 1024;

function fail() { throw serviceError("MCP_SERVER_RESPONSE_INVALID", "MCP 工具合同无效"); }
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value, depth = 0) {
  if (depth > 32) fail();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  fail();
}

function pluginToolContractDigest(tool) { return digest(canonical(tool)); }

function pluginToolUi(tool) {
  const ui = tool?._meta?.ui;
  if (ui === undefined) return { ui: null, appUnsupported: false };
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
    return { ui: null, appUnsupported: true };
  }
  const visibility = ui.visibility ?? ["model", "app"];
  if (!Array.isArray(visibility) || visibility.length > 2
    || new Set(visibility).size !== visibility.length
    || visibility.some((item) => !["model", "app"].includes(item))) {
    return { ui: null, appUnsupported: true };
  }
  if (ui.resourceUri !== undefined) {
    let parsed;
    try { parsed = new URL(ui.resourceUri); } catch { return { ui: null, appUnsupported: true }; }
    if (typeof ui.resourceUri !== "string" || ui.resourceUri.length > 2048
      || !ui.resourceUri.startsWith("ui://") || /[\u0000-\u0020\u007f]/u.test(ui.resourceUri)
      || parsed.protocol !== "ui:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
      return { ui: null, appUnsupported: true };
    }
  }
  return { ui: Object.freeze({ ...(ui.resourceUri === undefined ? {} : { resourceUri: ui.resourceUri }),
    visibility: Object.freeze([...visibility]) }), appUnsupported: false };
}

function buildPluginToolCatalog({ installationId, componentId, connectionId, tools } = {}) {
  if (!STORE_ID.test(installationId) || !HASH.test(componentId)
    || !STORE_ID.test(connectionId) || !Array.isArray(tools)
    || tools.length > MAX_TOOLS) fail();
  const seen = new Set();
  let totalBytes = 0;
  const entries = tools.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)
      || typeof tool.name !== "string" || !tool.name
      || Buffer.byteLength(tool.name, "utf8") > 128
      || !tool.inputSchema || typeof tool.inputSchema !== "object"
      || Array.isArray(tool.inputSchema) || seen.has(tool.name)) fail();
    seen.add(tool.name);
    const serialized = canonical(tool);
    totalBytes += Buffer.byteLength(serialized, "utf8");
    if (totalBytes > MAX_CATALOG_BYTES) fail();
    const metadata = pluginToolUi(tool);
    return Object.freeze({ downstreamName: tool.name,
      toolIdentity: `plugin:${installationId}:${componentId}:${connectionId}:${digest(tool.name)}`,
      contractDigest: digest(serialized),
      ...(metadata.ui ? { ui: metadata.ui } : {}),
      ...(metadata.appUnsupported ? { ui: null, appUnsupported: true } : {}) });
  }).sort((left, right) => left.downstreamName < right.downstreamName ? -1
    : left.downstreamName > right.downstreamName ? 1 : 0);
  const serialized = canonical(entries.map((entry) =>
    [entry.toolIdentity, entry.contractDigest]));
  if (Buffer.byteLength(serialized, "utf8") > MAX_CATALOG_BYTES) fail();
  return Object.freeze({ generationDigest: digest(serialized),
    entries: Object.freeze(entries) });
}

module.exports = { buildPluginToolCatalog, pluginToolContractDigest, pluginToolUi };
