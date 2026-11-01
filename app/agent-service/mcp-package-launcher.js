"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");
const fail = (code = "MCP_PACKAGE_INVALID") => { throw serviceError(code, code); };
const text = (v, n = 4096) => typeof v === "string" && v.isWellFormed() && !v.includes("\0") && Buffer.byteLength(v) <= n;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const NPM_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const PYPI_VERSION = /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/u;
function validatePackageTransport(t) {
  if (!t || t.kind !== "stdio-package" || !["npm", "pypi", "oci"].includes(t.registryType)
    || !text(t.identifier, 512) || !text(t.version || "", 256)
    || !Array.isArray(t.packageArgs || []) || (t.packageArgs || []).length > 64
    || (t.packageArgs || []).some(v => !text(v))) fail();
  if (t.registryType === "npm" && (!NPM_NAME.test(t.identifier) || !NPM_VERSION.test(t.version))) fail("MCP_PACKAGE_VERSION_INVALID");
  if (t.registryType === "pypi" && (!PYPI_NAME.test(t.identifier) || !PYPI_VERSION.test(t.version))) fail("MCP_PACKAGE_VERSION_INVALID");
  if (t.registryType === "oci") {
    const image = t.identifier;
    if (!/^[a-z0-9][a-z0-9._:/@-]*$/u.test(image) || image.includes("..") || image.includes("//")) fail();
    const digest = image.match(/@sha256:([a-f0-9]{64})$/u);
    const tag = !digest && image.slice(image.lastIndexOf("/") + 1).match(/:([A-Za-z0-9][A-Za-z0-9_.-]*)$/u)?.[1];
    const specified = tag || t.version;
    if (!digest && (!specified || !/^v?\d+(?:[._-][A-Za-z0-9]+)*$/u.test(specified))) fail("MCP_PACKAGE_VERSION_INVALID");
    if (tag && t.version && tag !== t.version) fail("MCP_PACKAGE_VERSION_INVALID");
  }
  return { kind: "stdio-package", registryType: t.registryType, identifier: t.identifier,
    version: t.version, packageArgs: [...(t.packageArgs || [])] };
}
// Tokenization only: no expansion, command substitution, redirection or shell execution.
function tokenizeCommand(input) {
  if (!text(input, 16 * 1024) || !input.trim()) fail("MCP_SERVER_COMMAND_FORBIDDEN");
  const tokens = []; let value = "", quote = null, escaped = false, started = false;
  for (const char of input) {
    if (escaped) { value += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = null; else value += char; started = true; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/u.test(char)) { if (started) { tokens.push(value); value = ""; started = false; } continue; }
    if ("|;&<>`$".includes(char)) fail("MCP_SERVER_COMMAND_FORBIDDEN");
    value += char; started = true;
  }
  if (quote || escaped) fail("MCP_SERVER_COMMAND_FORBIDDEN");
  if (started) tokens.push(value);
  if (!tokens.length || tokens.length > 65) fail();
  return tokens;
}
function resolveOnPath(name, env = process.env, fileSystem = fs) {
  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try { if (!fileSystem.statSync(candidate).isFile()) continue; fileSystem.accessSync(candidate, fs.constants.X_OK); return fileSystem.realpathSync(candidate); } catch {}
  }
  fail("MCP_PACKAGE_RUNTIME_MISSING");
}
class McpPackageLauncher {
  constructor(options = {}) { this.fs = options.fs || fs; this.env = options.env || process.env; this.resolveRuntime = options.resolveRuntime || ((name, env) => resolveOnPath(name, env, this.fs)); }
  async resolve(input, options = {}) {
    const t = validatePackageTransport(input?.transport || input);
    const runtime = { npm: "npx", pypi: "uvx", oci: "docker" }[t.registryType];
    const command = await this.resolveRuntime(runtime, options.env || this.env);
    if (!text(command) || !path.isAbsolute(command)) fail("MCP_PACKAGE_RUNTIME_MISSING");
    let args;
    if (runtime === "npx") args = ["--yes", `${t.identifier}@${t.version}`, ...t.packageArgs];
    else if (runtime === "uvx") args = [`${t.identifier}==${t.version}`, ...t.packageArgs];
    else {
      const image = /@sha256:/u.test(t.identifier) || /:[^/]+$/u.test(t.identifier) ? t.identifier : `${t.identifier}:${t.version}`;
      // Pass secret env through the parent's environment, never KEY=value argv.
      const names = Object.keys(options.env || {}).filter(k => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(k));
      args = ["run", "-i", "--rm", ...names.flatMap(k => ["--env", k]), image, ...t.packageArgs];
    }
    return { command, args, cwd: options.cwd || input?.cwd || process.cwd() };
  }
  async prepare(input, options) { return this.resolve(input, options); }
}
module.exports = { McpPackageLauncher, validatePackageTransport, tokenizeCommand, resolveOnPath };
