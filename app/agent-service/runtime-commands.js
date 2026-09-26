"use strict";

const MAX_RUNTIME_COMMANDS = 256;
const MAX_COMMAND_NAME_BYTES = 128;
const MAX_COMMAND_DESCRIPTION_BYTES = 16 * 1024;
const MAX_COMMAND_ARGS_BYTES = 2 * 1024;
const COMMAND_CATEGORIES = new Set(["session", "model", "tools", "agents"]);

const SESSION_COMMANDS = new Set([
  "archive", "clear", "compact", "delete", "fork", "goal", "load", "new", "rename",
  "resume", "rewind", "rollback",
]);
const MODEL_COMMANDS = new Set([
  "effort", "fast", "model", "models", "permissions", "personality", "plan", "status",
]);
const AGENT_COMMANDS = new Set([
  "agent", "agents", "subagents", "tasks", "workflow",
]);

function safeString(value, maxBytes, { empty = false } = {}) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function normalizeRuntimeCommandName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^\/+/, "").toLowerCase();
  return safeString(name, MAX_COMMAND_NAME_BYTES)
    && /^[a-z0-9_][a-z0-9._:-]*$/u.test(name) ? name : null;
}

function inferRuntimeCommandCategory(name) {
  if (SESSION_COMMANDS.has(name)) return "session";
  if (MODEL_COMMANDS.has(name)) return "model";
  if (AGENT_COMMANDS.has(name)) return "agents";
  return "tools";
}

function commandArgumentHint(entry) {
  const candidates = [
    entry.args,
    entry.argumentHint,
    entry.input?.hint,
    entry.input?.placeholder,
  ];
  const value = candidates.find((candidate) => (
    safeString(candidate, MAX_COMMAND_ARGS_BYTES, { empty: true })
  ));
  return value ? value.trim() || null : null;
}

function normalizeRuntimeCommands(value, options = {}) {
  const errorCode = options.errorCode || "RUNTIME_COMMAND_CATALOG_INVALID";
  const errorMessage = options.errorMessage || "Runtime command catalog is invalid";
  const fail = () => {
    const error = new Error(errorMessage);
    error.code = errorCode;
    throw error;
  };
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_COMMANDS) fail();
  const claimedNames = new Set();
  const commands = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail();
    const name = normalizeRuntimeCommandName(entry.name);
    const description = safeString(
      entry.description,
      MAX_COMMAND_DESCRIPTION_BYTES,
      { empty: true },
    ) ? entry.description : null;
    if (!name || description === null || claimedNames.has(name)) fail();
    const aliases = [];
    if (entry.aliases !== undefined) {
      if (!Array.isArray(entry.aliases) || entry.aliases.length > 32) fail();
      for (const candidate of entry.aliases) {
        const alias = normalizeRuntimeCommandName(candidate);
        if (!alias || alias === name || aliases.includes(alias) || claimedNames.has(alias)) fail();
        aliases.push(alias);
      }
    }
    const category = COMMAND_CATEGORIES.has(entry.category)
      ? entry.category : inferRuntimeCommandCategory(name);
    claimedNames.add(name);
    for (const alias of aliases) claimedNames.add(alias);
    commands.push(Object.freeze({
      name,
      description,
      args: commandArgumentHint(entry),
      category,
      aliases: Object.freeze(aliases),
      ...(entry.source !== undefined ? {
        source: safeString(entry.source, 256) ? entry.source : fail(),
      } : {}),
      ...(entry.execution !== undefined ? {
        execution: ["runtime", "client", "cli"].includes(entry.execution) ? entry.execution : fail(),
      } : {}),
    }));
  }
  return Object.freeze(commands);
}

function parseRuntimeCommand(text, commands) {
  if (!safeString(text, 64 * 1024) || !text.trim().startsWith("/")) return null;
  const normalized = text.trim();
  const body = normalized.slice(1);
  const separator = body.search(/\s/u);
  const rawName = separator < 0 ? body : body.slice(0, separator);
  const name = normalizeRuntimeCommandName(rawName);
  if (!name) return null;
  const command = commands.find((candidate) => (
    candidate.name === name || candidate.aliases.includes(name)
  ));
  if (!command) return null;
  return Object.freeze({
    command,
    args: separator < 0 ? "" : body.slice(separator + 1).trim(),
    text: normalized,
  });
}

module.exports = {
  MAX_RUNTIME_COMMANDS,
  inferRuntimeCommandCategory,
  normalizeRuntimeCommandName,
  normalizeRuntimeCommands,
  parseRuntimeCommand,
};
