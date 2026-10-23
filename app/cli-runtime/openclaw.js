"use strict";

// Shared CLI discovery only. Service role consumers must not load the
// OpenClaw product adapter through this standard-library-only module.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// The rootless installer pins a supported Node in ~/.local/bin/openclaw.
// Selecting the global npm symlink first discards that interpreter choice.
function resolveOpenclawBin({ env = process.env, home = os.homedir() } = {}) {
  if (env.OPENCLAW_BIN) return env.OPENCLAW_BIN;
  const candidates = [
    path.join(home, ".local", "bin", "openclaw"),
    ...(env.PATH || "").split(path.delimiter).filter(path.isAbsolute).map(dir => path.join(dir, "openclaw")),
    "/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw",
    path.join(home, ".npm-global", "bin", "openclaw"),
  ];
  return candidates.find(isFile) || "openclaw";
}

function resolveOpenclawProgram(bin) {
  let entryPath = bin;
  try {
    entryPath = fs.realpathSync(bin);
    // Recognize only the installer's literal `exec NODE CLI "$@"` launcher.
    // Do not evaluate shell text, expansions, additional arguments or commands.
    if (fs.statSync(entryPath).size > 4096) return { entryPath };
    const text = fs.readFileSync(entryPath, "utf8");
    const match = /^#![^\n]*\/(?:ba)?sh\r?\n\s*exec\s+([^\r\n]+)\s+"\$@"\s*$/u.exec(text);
    if (!match) return { entryPath };
    const words = match[1].match(/"[^"$`\\]*"|'[^']*'|[^\s"'$`\\;&|<>]+/gu) || [];
    if (words.length !== 2 || words.join(" ") !== match[1].trim().replace(/\s+/gu, " ")) return { entryPath };
    const [node, cli] = words.map(word => /^["']/u.test(word) ? word.slice(1, -1) : word);
    if (!path.isAbsolute(node) || !path.isAbsolute(cli) || !isFile(node) || !isFile(cli)
      || path.basename(node) !== "node") return { entryPath };
    return { entryPath: fs.realpathSync(cli), interpreterPath: fs.realpathSync(node) };
  } catch { return { entryPath }; }
}

function legacyOpenclawNode(bin, args = []) {
  const { interpreterPath } = resolveOpenclawProgram(bin);
  return { file: interpreterPath || "node", args, env: interpreterPath
    ? { ...process.env, PATH: [path.dirname(interpreterPath), process.env.PATH || ""].join(path.delimiter) }
    : process.env };
}

module.exports = { resolveOpenclawBin, resolveOpenclawProgram, legacyOpenclawNode };
