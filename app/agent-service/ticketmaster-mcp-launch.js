"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");

const COMMAND = "shoggoth-ticketmaster";
const BRIDGE_ENTRY = path.join(__dirname, "ticketmaster-mcp-bridge.js");
const CLI_ENTRY = path.join(__dirname, "ticketmaster-cli.py");
const KEY_FIELD = "TICKETMASTER_API_KEY";

function matchTicketmasterBridgeLaunch(command, args) {
  return command === process.execPath && Array.isArray(args) && args.length === 1 && args[0] === BRIDGE_ENTRY;
}

function normalizeTicketmasterTransport(transport) {
  if (transport.kind !== "stdio-command" || transport.command !== COMMAND) return transport;
  if (!Array.isArray(transport.args) || transport.args.length) throw serviceError("MCP_SERVER_COMMAND_FORBIDDEN");
  return { ...transport, command: process.execPath, args: [BRIDGE_ENTRY] };
}

function validateTicketmasterBridgeLaunch(command, args, { fsModule = fs } = {}) {
  if (!matchTicketmasterBridgeLaunch(command, args)) throw serviceError("MCP_SERVER_PATH_INVALID");
  try {
    const parent = fsModule.realpathSync(__dirname);
    for (const entry of [BRIDGE_ENTRY, CLI_ENTRY]) {
      const stat = fsModule.lstatSync(entry);
      if (!stat.isFile() || stat.isSymbolicLink() || fsModule.realpathSync(entry) !== path.join(parent, path.basename(entry))) throw new Error();
    }
  } catch { throw serviceError("MCP_SERVER_PATH_INVALID"); }
}

function ticketmasterBridgeEnvironment(command, args) {
  if (!matchTicketmasterBridgeLaunch(command, args)) return {};
  validateTicketmasterBridgeLaunch(command, args);
  return { ELECTRON_RUN_AS_NODE: "1" };
}

function validateTicketmasterBridgeCredentials(transport, fields = {}) {
  if (transport?.kind !== "stdio-command" || !matchTicketmasterBridgeLaunch(transport.command, transport.args)) return;
  const invalid = () => { throw serviceError("MCP_SECRET_INVALID"); };
  if (!fields || Object.getPrototypeOf(fields) !== Object.prototype || Object.entries(fields).some(([key, value]) => key !== "env" && value !== null && value !== undefined)) invalid();
  const env = fields.env || {};
  if (Object.getPrototypeOf(env) !== Object.prototype || Object.keys(env).some(key => key !== KEY_FIELD)) invalid();
  if (env[KEY_FIELD] !== undefined && (typeof env[KEY_FIELD] !== "string" || !/^[\x21-\x7e]{1,1024}$/u.test(env[KEY_FIELD].trim()))) invalid();
}

module.exports = { COMMAND, BRIDGE_ENTRY, CLI_ENTRY, KEY_FIELD, matchTicketmasterBridgeLaunch,
  normalizeTicketmasterTransport, validateTicketmasterBridgeLaunch, ticketmasterBridgeEnvironment, validateTicketmasterBridgeCredentials };
