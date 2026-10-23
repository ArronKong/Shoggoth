"use strict";

// Shared by MCP helpers and the Service; importing this contract performs no IO.
const DRAFT_ID = /^[a-f0-9]{64}$/u;
const INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_AUTHORING_BYTES = 48 * 1024;
const MANIFEST_PATH = ".codex-plugin/plugin.json";
const RESERVED = new Set([MANIFEST_PATH, "plugin.json", "mcp.json", "legacy-provenance.json"]);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length
  && fields.every(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
const text = (value, size, empty = false) => typeof value === "string" && value.isWellFormed()
  && !value.includes("\0") && (empty || value.length > 0) && Buffer.byteLength(value, "utf8") <= size;

function validFile(file) {
  if (!exact(file, ["path", "content", ...(Object.hasOwn(file || {}, "executable") ? ["executable"] : [])])
    || !text(file.path, 512) || !text(file.content, 32 * 1024, true)
    || (file.executable !== undefined && typeof file.executable !== "boolean")) return false;
  const parts = file.path.split("/");
  return parts.length <= 8 && parts.every(part => /^[A-Za-z0-9_.-]+$/u.test(part)
    && part !== "." && part !== "..") && !RESERVED.has(file.path)
    && (file.path === ".mcp.json" || /^(?:skills|scripts|references|assets|shared|server)\//u.test(file.path)
      || ["README.md", "LICENSE"].includes(file.path));
}

function validatePluginAuthoringArguments(name, args) {
  if (name === "plugin_create") {
    return exact(args, ["name", "description", "files", ...(Object.hasOwn(args || {}, "version") ? ["version"] : [])])
      && typeof args.name === "string" && /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(args.name)
      && text(args.description, 2048) && Boolean(args.description.trim())
      && (args.version === undefined || typeof args.version === "string"
        && args.version.length <= 128 && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(args.version))
      && Array.isArray(args.files) && args.files.length >= 1 && args.files.length <= 64
      && args.files.every(validFile) && new Set(args.files.map(file => file.path.toLowerCase())).size === args.files.length
      && Buffer.byteLength(JSON.stringify(args), "utf8") <= MAX_AUTHORING_BYTES;
  }
  if (name === "plugin_status") return exact(args, ["draftId"]) && typeof args.draftId === "string" && DRAFT_ID.test(args.draftId);
  if (name === "plugin_setup_get") return exact(args, ["installationId"]) && INSTALLATION_ID.test(args.installationId || "");
  if (name === "plugin_activate") return exact(args, ["installationId", "releaseDigest"])
    && INSTALLATION_ID.test(args.installationId || "") && typeof args.releaseDigest === "string"
    && DRAFT_ID.test(args.releaseDigest);
  if (name === "plugin_secret_request") return exact(args, ["installationId", "name", "reason"])
    && INSTALLATION_ID.test(args.installationId || "") && typeof args.name === "string"
    && /^[A-Z][A-Z0-9_]{0,63}$/u.test(args.name) && text(args.reason, 512) && Boolean(args.reason.trim());
  if (name === "plugin_install") return exact(args, ["draftId", "previewDigest", "expectedRevision", "enable"])
    && typeof args.draftId === "string" && DRAFT_ID.test(args.draftId)
    && typeof args.previewDigest === "string" && DRAFT_ID.test(args.previewDigest)
    && Number.isSafeInteger(args.expectedRevision) && args.expectedRevision >= 0 && typeof args.enable === "boolean";
  return false;
}

const PLUGIN_AUTHORING_TOOL_DEFINITIONS = Object.freeze([
  { name: "plugin_create", description: "Create and validate a local Codex-format plugin draft from UTF-8 files. The Service generates .codex-plugin/plugin.json; supply skills/<name>/SKILL.md and/or .mcp.json, plus supporting files. Default version is 0.1.0. Calling it again with the same name replaces that draft, so plugin_install updates the same installation. No process runs or plugin is installed. Read app_help_get(featureId=mcp) for the workflow. Never include credentials.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
      description: { type: "string", minLength: 1, maxLength: 2048 },
      version: { type: "string", maxLength: 128 },
      files: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", properties: {
        path: { type: "string", minLength: 1, maxLength: 512 },
        content: { type: "string", maxLength: 32768 }, executable: { type: "boolean" },
      }, required: ["path", "content"], additionalProperties: false } },
    }, required: ["name", "description", "files"], additionalProperties: false } },
  { name: "plugin_install", description: "Install the exact validated draft into Shoggoth Plugins after product confirmation. Use plugin_create/plugin_status.previewDigest and expectedRevision. enable=true makes eligible Skills globally available to native Agents and bridged Hermes/OpenClaw on their next turn. If plugin_status shows an installation, this updates it in place; an enabled old version is disabled and drained inside the same confirmation, and its MCP tools need plugin_activate again. This never runs a server or grants its tools; finish MCP setup with plugin_setup_get and plugin_activate.",
    inputSchema: { type: "object", properties: {
      draftId: { type: "string", pattern: "^[a-f0-9]{64}$" }, previewDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      expectedRevision: { type: "integer", minimum: 0 }, enable: { type: "boolean" },
    }, required: ["draftId", "previewDigest", "expectedRevision", "enable"], additionalProperties: false } },
  { name: "plugin_status", description: "Revalidate your authored plugin draft and read its current installation and component readiness. Returns the source package path, exact preview, installed version, Plugins UI link and nextSteps: confirm_install for a new or changed draft, otherwise the plugin_setup_get steps. Installation alone does not prove MCP connectivity or CLI availability.",
    inputSchema: { type: "object", properties: { draftId: { type: "string", pattern: "^[a-f0-9]{64}$" } },
      required: ["draftId"], additionalProperties: false } },
]);

// Setup of any installed plugin: read what is missing, collect a declared
// credential through a Service card, and activate the generic MCP servers.
const PLUGIN_SETUP_TOOL_DEFINITIONS = Object.freeze([
  { name: "plugin_setup_get", description: "Read an installed plugin's setup state: releaseDigest, each MCP server's launch target, declared ${secret:NAME} credentials (configured or not, never values), interpreter readiness, connection/tool grant state and nextSteps (provide_secret:NAME, activate, configure_in_plugins, ready_next_turn). Read only; no process runs.",
    inputSchema: { type: "object", properties: { installationId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" } },
      required: ["installationId"], additionalProperties: false } },
  { name: "plugin_secret_request", description: "Ask the user for one credential the plugin declares as ${secret:NAME}. Shoggoth shows a password card in this conversation; the value goes straight to encrypted local storage and is injected only into that plugin's declared process env or endpoint header. You never receive the value: the result is only stored/canceled plus the updated readiness. reason states why it is needed and where to obtain it. Never ask for credentials in chat or write them to files.",
    inputSchema: { type: "object", properties: {
      installationId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
      name: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
      reason: { type: "string", minLength: 1, maxLength: 512 },
    }, required: ["installationId", "name", "reason"], additionalProperties: false } },
  { name: "plugin_activate", description: "After user confirmation, make an installed plugin usable: enable it, pin a local Node/Python interpreter when its stdio server needs one, connect each generic MCP server, discover its tools and allow them for all Agents (tools annotated destructiveHint ask per call). Use releaseDigest from plugin_setup_get. Servers needing a provider account, and servers with missing credentials, are reported instead. New tools are available from the next turn, not the current one.",
    inputSchema: { type: "object", properties: {
      installationId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
      releaseDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }, required: ["installationId", "releaseDigest"], additionalProperties: false } },
]);
const PLUGIN_SETUP_TOOL_NAMES = Object.freeze(PLUGIN_SETUP_TOOL_DEFINITIONS.map(item => item.name));

module.exports = { MANIFEST_PATH, DRAFT_ID, MAX_AUTHORING_BYTES,
  PLUGIN_AUTHORING_TOOL_DEFINITIONS, PLUGIN_SETUP_TOOL_DEFINITIONS, PLUGIN_SETUP_TOOL_NAMES,
  validatePluginAuthoringArguments };
