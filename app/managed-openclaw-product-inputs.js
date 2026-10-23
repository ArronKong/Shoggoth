"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const pins = require("./managed-openclaw-runtime-pins.json");
const { resolveOpenclawProgram } = require("./cli-runtime/openclaw");
function resolveManagedOpenClawProductInputs({ openclawBin, runtimePath = process.env.PATH,
  homeDir = os.homedir(), architecture = process.arch } = {}) {
  const fail = () => { throw Object.assign(new Error("未找到此版本所需的本地 OpenClaw 和 Node"), {
    code: "MANAGED_HOST_LOCAL_RUNTIME_UNAVAILABLE", status: 503,
  }); };
  const paths = String(runtimePath || "").split(path.delimiter).filter(part => path.isAbsolute(part));
  function executable(candidates) {
    for (const candidate of candidates) {
      try { const actual = fs.realpathSync(candidate); const stat = fs.statSync(actual);
        if (stat.isFile() && (stat.mode & 0o111)) return actual;
      } catch { /* unsupported/missing candidates remain unavailable */ }
    }
    return null;
  }
  if (typeof openclawBin !== "string" || !openclawBin || !["arm64", "x64"].includes(architecture)) fail();
  const launcher = executable(path.isAbsolute(openclawBin) ? [openclawBin] : paths.map(root => path.join(root, openclawBin)));
  const entry = launcher && executable([resolveOpenclawProgram(launcher).entryPath]);
  const interpreter = executable([path.join(homeDir, ".local", "share", "node", `v${pins.hosts.openclaw.interpreter.version}`, "bin", "node"),
    "/opt/homebrew/bin/node", "/usr/local/bin/node", ...paths.map(root => path.join(root, "node"))]);
  if (!entry || !interpreter || path.basename(entry) !== "openclaw.mjs") fail();
  // This is discovery only. Exact version, architecture, interpreter, complete
  // source/dependency and resource digests are verified inside the worker.
  return Object.freeze({ sourceRoot: path.dirname(entry), interpreterPath: interpreter, architecture });
}
module.exports = { resolveManagedOpenClawProductInputs };
