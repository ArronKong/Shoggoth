"use strict";

const fs = require("node:fs"), path = require("node:path");
const { serviceError } = require("./security");
const { COMMAND, KEY_FIELD, METERED_FIELD, METERED_ENABLED, METERED_DISABLED, METERED_MARKER } = require("../core/flightaware-connector-policy.json");
const BRIDGE_ENTRY = path.join(__dirname, "flightaware-mcp-bridge.js");
const CLI_ENTRY = path.join(__dirname, "flightaware-cli.py");
// Distinct policy values must not be ordinary strings such as true/false:
// the existing credential redactor treats all encrypted env values as secrets.

function matchFlightawareBridgeLaunch(command, args) {
  return command === process.execPath && Array.isArray(args) && args.length === 1 && args[0] === BRIDGE_ENTRY;
}
function normalizeFlightawareTransport(transport) {
  if (transport.kind !== "stdio-command" || transport.command !== COMMAND) return transport;
  if (!Array.isArray(transport.args) || transport.args.length) throw serviceError("MCP_SERVER_COMMAND_FORBIDDEN");
  return { ...transport, command: process.execPath, args: [BRIDGE_ENTRY] };
}
function validateFlightawareBridgeLaunch(command, args, { fsModule = fs } = {}) {
  if (!matchFlightawareBridgeLaunch(command, args)) throw serviceError("MCP_SERVER_PATH_INVALID");
  try {
    const parent = fsModule.realpathSync(__dirname);
    for (const entry of [BRIDGE_ENTRY, CLI_ENTRY]) {
      const stat = fsModule.lstatSync(entry);
      if (!stat.isFile() || stat.isSymbolicLink() || fsModule.realpathSync(entry) !== path.join(parent, path.basename(entry))) throw new Error();
    }
  } catch { throw serviceError("MCP_SERVER_PATH_INVALID"); }
}
function flightawareBridgeEnvironment(command, args) {
  if (!matchFlightawareBridgeLaunch(command, args)) return {};
  validateFlightawareBridgeLaunch(command, args);
  return { ELECTRON_RUN_AS_NODE: "1" };
}
function validateFlightawareBridgeCredentials(transport, fields = {}) {
  if (transport?.kind !== "stdio-command" || !matchFlightawareBridgeLaunch(transport.command, transport.args)) return;
  const invalid = () => { throw serviceError("MCP_SECRET_INVALID"); };
  if (!fields || Object.getPrototypeOf(fields) !== Object.prototype || Object.entries(fields).some(([key, value]) => key !== "env" && value !== null && value !== undefined)) invalid();
  const env = fields.env || {};
  if (Object.getPrototypeOf(env) !== Object.prototype || Object.keys(env).some(key => ![KEY_FIELD, METERED_FIELD].includes(key))) invalid();
  if (env[KEY_FIELD] !== undefined && (typeof env[KEY_FIELD] !== "string" || !/^[\x21-\x7e]{1,1024}$/u.test(env[KEY_FIELD].trim()))) invalid();
  if (env[METERED_FIELD] !== undefined && ![METERED_ENABLED, METERED_DISABLED].includes(env[METERED_FIELD])) invalid();
}
function flightawareConfiguredFields(transport, configured, fields) {
  if (transport?.kind !== "stdio-command" || !matchFlightawareBridgeLaunch(transport.command, transport.args) || fields?.env?.[METERED_FIELD] === undefined) return configured;
  const result = configured.filter(field => field !== METERED_MARKER);
  // Presentation only. Runtime admission always uses the encrypted value.
  if (fields.env[METERED_FIELD] === METERED_ENABLED) result.push(METERED_MARKER);
  return result;
}
module.exports = { COMMAND, BRIDGE_ENTRY, CLI_ENTRY, KEY_FIELD, METERED_FIELD, METERED_ENABLED, METERED_DISABLED, METERED_MARKER,
  matchFlightawareBridgeLaunch, normalizeFlightawareTransport, validateFlightawareBridgeLaunch,
  flightawareBridgeEnvironment, validateFlightawareBridgeCredentials, flightawareConfiguredFields };
