"use strict";

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_NESTING = 4;

function basename(value) {
  return String(value || "").replace(/^['"`]+|['"`]+$/gu, "").split("/").at(-1) || "";
}

function shellSegments(value) {
  const segments = [];
  let tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  const finishToken = () => {
    if (token.length > 0) tokens.push(token);
    token = "";
  };
  const finishSegment = () => {
    finishToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      finishToken();
      if (character === "\n") finishSegment();
    } else if (";&|()".includes(character)) {
      finishSegment();
    } else {
      token += character;
    }
  }
  if (escaped) token += "\\";
  finishSegment();
  return segments;
}

function executableIndex(tokens) {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index])) index += 1;
  while (index < tokens.length) {
    const executable = basename(tokens[index]).toLocaleLowerCase("en-US");
    if (["command", "exec", "nohup"].includes(executable)) {
      index += 1;
      continue;
    }
    if (executable === "sudo") {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith("-")) index += 1;
      continue;
    }
    if (executable === "env") {
      index += 1;
      while (index < tokens.length
        && (tokens[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]))) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function commandUsesReservedHostCapability(command, depth = 0) {
  if (typeof command !== "string" || command.length === 0 || depth > MAX_NESTING
    || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) return false;
  for (const tokens of shellSegments(command)) {
    const index = executableIndex(tokens);
    if (index >= tokens.length) continue;
    const executable = tokens[index].replace(/^['"`]+|['"`]+$/gu, "");
    const normalizedExecutable = executable.toLocaleLowerCase("en-US");
    const name = basename(executable).toLocaleLowerCase("en-US");
    if (name === "open" || normalizedExecutable.includes(".app/contents/macos/")) return true;
    if (name === "osascript" && /\b(?:tell\s+(?:application|app)|open\s+location|activate|launch)\b/iu
      .test(tokens.slice(index + 1).join(" "))) return true;
    if (["sh", "bash", "zsh"].includes(name)) {
      const optionIndex = tokens.slice(index + 1).findIndex((token) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(token));
      if (optionIndex >= 0) {
        const body = tokens[index + optionIndex + 2];
        if (commandUsesReservedHostCapability(body, depth + 1)) return true;
      }
    }
  }
  return false;
}

function runtimeCommandUsesReservedHostCapability(params) {
  const commands = [params?.command];
  if (Array.isArray(params?.commandActions)) {
    commands.push(...params.commandActions.map((action) => action?.command));
  }
  return commands.some((command) => commandUsesReservedHostCapability(command));
}

module.exports = { runtimeCommandUsesReservedHostCapability };
