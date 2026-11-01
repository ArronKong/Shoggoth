"use strict";

const path = require("node:path");
const { serviceError } = require("./security");
const { connectorJson, validateConnectorParams } = require("../core/connector-dto");
const { canonicalMcpCredentialField } = require("../core/mcp-credential-fields");
const { validateMcpRemoteUrl } = require("./native-mcp-store");
const { tokenizeCommand, resolveOnPath } = require("./mcp-package-launcher");
const { normalizeTicketmasterTransport } = require("./ticketmaster-mcp-launch");
const { normalizeFlightawareTransport } = require("./flightaware-mcp-launch");

const MAX_CONFIG_BYTES = 32 * 1024;
const SECRET_NAME = /token|secret|password|passwd|api.?key|authorization|credential|cookie|private.?key/iu;
const fail = code => { throw serviceError(code, code); };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const text = (value, max = 4096) => typeof value === "string" && value.isWellFormed() && !/[\0\r\n]/u.test(value) && Buffer.byteLength(value) <= max;
// Placeholders are field declarations, never values to send to a provider.
const placeholder = value => value === "" || /^(?:Bearer\s+)?(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|<[A-Za-z_][A-Za-z0-9_ -]*>|YOUR_[A-Z0-9_]+)$/iu.test(value);

function normalizeCustomMcpTransport(raw, paths) {
  let transport = structuredClone(raw);
  if (transport.kind === "remote") return { ...transport, url: validateMcpRemoteUrl(transport.url) };
  if (transport.kind !== "stdio-command") return transport;
  if (transport.commandLine) {
    const [command, ...args] = tokenizeCommand(transport.commandLine);
    transport = { kind: "stdio-command", command, args, cwd: transport.cwd || paths.defaultWorkspaceDir };
  } else transport.cwd ||= paths.defaultWorkspaceDir;
  transport = normalizeTicketmasterTransport(transport);
  transport = normalizeFlightawareTransport(transport);
  const base = path.basename(transport.command), args = transport.args;
  if (base === "npx" && args[0] === "-y" && typeof args[1] === "string") {
    const match = args[1].match(/^(@[^/]+\/[^@]+|[^@]+)@([^@]+)$/u);
    if (match) return { kind: "stdio-package", registryType: "npm", identifier: match[1], version: match[2], packageArgs: args.slice(2) };
  } else if (base === "uvx" && typeof args[0] === "string" && args[0].includes("==")) {
    const [identifier, version] = args[0].split("==");
    return { kind: "stdio-package", registryType: "pypi", identifier, version, packageArgs: args.slice(1) };
  }
  if (!path.isAbsolute(transport.command)) transport.command = resolveOnPath(transport.command);
  return transport;
}

function credentialMap(value, kind, fields, required) {
  if (value === undefined) return;
  if (!plain(value) || Object.keys(value).length > 64) fail("MCP_IMPORT_INVALID");
  const fixed = {};
  for (const [name, entry] of Object.entries(value)) {
    const field = canonicalMcpCredentialField(`${kind}:${name}`);
    if (!field || !text(entry, 16384)) fail("MCP_IMPORT_INVALID");
    if (placeholder(entry)) required.add(field);
    else if (SECRET_NAME.test(name) || /^(?:Bearer|Basic)\s+/iu.test(entry)) fail("MCP_SECRET_INVALID");
    else fixed[name] = entry;
  }
  if (Object.keys(fixed).length) fields[kind === "header" ? "headers" : "env"] = fixed;
}

function planEntry(name, spec, paths) {
  if (!text(name, 256) || !name.trim() || !plain(spec)
    || Object.keys(spec).some(key => !["command", "args", "cwd", "env", "url", "headers", "type", "transport", "oauthClient", "requiredFields"].includes(key))
    || Boolean(spec.url) === Boolean(spec.command)) fail("MCP_IMPORT_INVALID");
  const required = new Set(), fields = {};
  credentialMap(spec.env, "env", fields, required);
  credentialMap(spec.headers, "header", fields, required);
  if (spec.requiredFields !== undefined) {
    if (!Array.isArray(spec.requiredFields) || spec.requiredFields.length > 64) fail("MCP_IMPORT_INVALID");
    for (const field of spec.requiredFields) {
      const canonical = canonicalMcpCredentialField(field);
      if (!canonical) fail("MCP_IMPORT_INVALID");
      required.add(canonical);
    }
  }
  if (spec.oauthClient !== undefined) {
    if (!spec.url || !plain(spec.oauthClient) || Object.keys(spec.oauthClient).some(key => !["clientId", "clientSecret"].includes(key))) fail("MCP_IMPORT_INVALID");
    for (const [key, value] of Object.entries(spec.oauthClient)) {
      if (!text(value) || !placeholder(value)) fail("MCP_SECRET_INVALID");
      required.add(`oauthClient:${key}`);
    }
    required.add("oauthClient:clientId");
  }
  if (required.size > 64) fail("MCP_IMPORT_INVALID");
  const protocol = spec.type || spec.transport;
  if (spec.type && spec.transport && spec.type !== spec.transport
    || protocol && !(spec.url ? ["http", "streamable-http", "sse"] : ["stdio"]).includes(protocol)) fail("MCP_IMPORT_INVALID");
  let option;
  if (spec.url) {
    if (spec.args !== undefined || spec.cwd !== undefined || spec.env !== undefined
      || [...required].some(field => field.startsWith("env:"))) fail("MCP_IMPORT_INVALID");
    option = { kind: "remote", protocol: protocol === "sse" ? "sse" : "streamable-http", url: validateMcpRemoteUrl(spec.url) };
  } else {
    if (!text(spec.command) || !spec.command || spec.headers !== undefined || spec.oauthClient !== undefined
      || spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.length > 64 || spec.args.some(value => !text(value)))
      || spec.cwd !== undefined && !text(spec.cwd)) fail("MCP_IMPORT_INVALID");
    option = normalizeCustomMcpTransport({ kind: "stdio-command", command: spec.command, args: spec.args || [], cwd: spec.cwd || paths.defaultWorkspaceDir }, paths);
    if ([...required].some(field => !field.startsWith("env:"))) fail("MCP_IMPORT_INVALID");
  }
  const auth = [...required].some(field => field.startsWith("oauthClient:")) ? { kind: "oauth-client" }
    : [...required].some(field => field.startsWith("header:")) || fields.headers ? { kind: "headers" } : undefined;
  const input = { source: { kind: "custom" }, name: name.trim(), option, fields, ...(auth ? { auth } : {}), expectedRevision: 1 };
  try { validateConnectorParams("connector.mcp.add", input); } catch { fail("MCP_IMPORT_INVALID"); }
  return { input, requiredFields: [...required].sort() };
}

function planAgentMcpSetup(tool, args, paths) {
  if (tool === "mcp_server_add") return [planEntry(args.name || new URL(args.url).hostname, {
    url: args.url, ...(args.protocol ? { type: args.protocol } : {}), ...(args.requiredFields ? { requiredFields: args.requiredFields } : {}),
  }, paths)];
  let config;
  try { config = connectorJson(JSON.parse(args.config), MAX_CONFIG_BYTES); } catch { fail("MCP_IMPORT_INVALID"); }
  if (!plain(config)) fail("MCP_IMPORT_INVALID");
  const wrapper = Object.hasOwn(config, "mcpServers") ? "mcpServers" : Object.hasOwn(config, "servers") ? "servers" : null;
  if (wrapper && Object.keys(config).length !== 1) fail("MCP_IMPORT_INVALID");
  const servers = wrapper ? config[wrapper] : { Imported: config };
  if (!plain(servers) || !Object.keys(servers).length || Object.keys(servers).length > 64) fail("MCP_IMPORT_INVALID");
  return Object.entries(servers).map(([name, spec]) => planEntry(name, spec, paths));
}

module.exports = { MAX_CONFIG_BYTES, normalizeCustomMcpTransport, planAgentMcpSetup };
