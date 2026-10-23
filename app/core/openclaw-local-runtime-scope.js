"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveOpenclawProgram, legacyOpenclawNode } = require("../cli-runtime/openclaw");

function unavailable() {
  throw Object.assign(new Error("App 管理的 OpenClaw 运行环境尚未验证，请先完成启动"), {
    code: "MANAGED_PLUGIN_HOST_UNAVAILABLE", status: 503,
  });
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function actualPath(value, directory = false, privateOwned = false) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value !== path.resolve(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) unavailable();
  const stat = fs.lstatSync(value);
  if (stat.isSymbolicLink() || fs.realpathSync(value) !== value
    || (directory ? !stat.isDirectory() : !stat.isFile())
    || (privateOwned && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) unavailable();
  return value;
}

// This resolver is injected only by the trusted desktop composition root.
// undefined selects the existing user Host; null means managed-but-unverified
// and must never fall back to the user's Home or CLI.
function createOpenClawLocalRuntimeScope({ getManagedExecution = null, resolveLegacyBin } = {}) {
  if ((getManagedExecution !== null && typeof getManagedExecution !== "function")
    || typeof resolveLegacyBin !== "function") throw new TypeError("Invalid OpenClaw local scope");
  const current = () => {
    if (getManagedExecution === null) return undefined;
    const value = getManagedExecution();
    if (value === undefined) return undefined;
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) unavailable();
    try {
      const runtimeRoot = actualPath(value.runtimeRoot, true);
      const entryPath = actualPath(value.entryPath);
      const interpreterPath = actualPath(value.interpreterPath);
      const home = actualPath(value.home, true, true);
      const stateDir = actualPath(value.stateDir, true, true);
      const workspace = actualPath(value.workspace, true, true);
      const configPath = actualPath(value.configPath, false, true);
      const dataRoot = actualPath(path.dirname(home), true, true);
      if (!inside(runtimeRoot, entryPath) || path.basename(entryPath) !== "openclaw.mjs"
        || path.dirname(stateDir) !== dataRoot || path.dirname(workspace) !== dataRoot
        || !inside(dataRoot, configPath) || !value.env || Object.getPrototypeOf(value.env) !== Object.prototype
        || value.env.HOME !== home || value.env.OPENCLAW_STATE_DIR !== stateDir
        || value.env.OPENCLAW_CONFIG_PATH !== configPath
        || Object.values(value.env).some(item => typeof item !== "string")) unavailable();
      return Object.freeze({ runtimeRoot, entryPath, interpreterPath, home, stateDir, workspace, configPath,
        env: Object.freeze({ ...value.env }) });
    } catch { unavailable(); }
  };
  const isManaged = () => getManagedExecution !== null && getManagedExecution() !== undefined;
  return Object.freeze({
    current, isManaged,
    stateDir: () => current()?.stateDir || path.resolve(process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw")),
    home: () => current()?.home || os.homedir(),
    configPath: () => current()?.configPath || path.resolve(process.env.OPENCLAW_CONFIG_PATH
      || path.join(process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"), "openclaw.json")),
    cli(args) {
      const scope = current();
      return scope ? Object.freeze({ file: scope.interpreterPath, args: [scope.entryPath, ...args],
        env: scope.env, cwd: scope.workspace }) : { file: resolveLegacyBin(), args, env: process.env };
    },
    node(args) {
      const scope = current();
      return scope ? Object.freeze({ file: scope.interpreterPath, args, env: scope.env, cwd: scope.workspace })
        : legacyOpenclawNode(resolveLegacyBin(), args);
    },
    sdkPath() {
      const scope = current();
      return path.join(scope?.runtimeRoot || path.dirname(resolveOpenclawProgram(resolveLegacyBin()).entryPath), "dist", "plugin-sdk", "agent-runtime.js");
    },
  });
}

module.exports = { createOpenClawLocalRuntimeScope };
