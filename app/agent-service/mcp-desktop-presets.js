"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { serviceError } = require("./security");

// These are the vendors' documented MCP entry points, not a general allowance
// for /Applications or /usr/local. Check the Apple signing chain at each launch.
const DESKTOP_PRESETS = Object.freeze([
  Object.freeze({ command: "/Applications/Fantastical.app/Contents/Helpers/FantasticalMCP.app/Contents/MacOS/FantasticalMCP", args: Object.freeze([]), team: "85C27NK92C" }),
  Object.freeze({ command: "/usr/local/bin/dayone", args: Object.freeze(["mcp"]), team: "5U8NS4GX82" }),
  Object.freeze({ command: "/usr/local/bin/1password-mcp", args: Object.freeze([]), team: "2BUA8C4S2C" }),
]);

function desktopPreset(command, args) {
  // 1Password installs a PATH entry rather than documenting one absolute path.
  // Accept only that executable name with no arguments, then verify its vendor
  // signature below. Other binaries from the same publisher are not matched.
  const knownCommand = typeof command === "string" && path.isAbsolute(command) && path.basename(command) === "1password-mcp"
    ? "/usr/local/bin/1password-mcp" : command;
  return DESKTOP_PRESETS.find(value => value.command === knownCommand && Array.isArray(args)
    && value.args.length === args.length && value.args.every((arg, index) => args[index] === arg));
}

function validateDesktopPreset(command, args, realPath, options = {}) {
  const preset = desktopPreset(command, args);
  if (!preset || (options.platform || process.platform) !== "darwin") throw serviceError("MCP_SERVER_PATH_INVALID");
  const run = options.spawnSync || spawnSync;
  // A TeamIdentifier string alone is insufficient: require an Apple-trusted
  // signature with the pinned publisher as well as the exact MCP arguments.
  const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${preset.team}"`;
  let result;
  try {
    result = run("/usr/bin/codesign", ["--verify", "--strict", "--test-requirement", requirement, realPath], {
      encoding: "utf8", timeout: 20000, maxBuffer: 64 * 1024,
    });
  } catch { throw serviceError("MCP_SERVER_PATH_INVALID"); }
  if (!result || result.error || result.status !== 0) throw serviceError("MCP_SERVER_PATH_INVALID");
}

module.exports = { DESKTOP_PRESETS, desktopPreset, validateDesktopPreset };
