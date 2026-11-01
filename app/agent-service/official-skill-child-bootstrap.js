"use strict";

// Official Node CLIs may create sign-in/signing workers. Keep those workers in
// the managed command's process group so cancellation, disconnect and app exit
// also stop descendants. This module is injected only by the fixed bridge.
const childProcess = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const home = process.env.HOME;
if (!home || !path.isAbsolute(home)) throw new Error("OFFICIAL_SKILL_RUNTIME_MISSING");
process.umask(0o077);
// Commander detects Electron even in Node mode. Managed CLIs receive
// [executable, script, ...args]; select its script convention so packaged hosts
// do not parse the script pathname as the first command.
if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === "1") process.defaultApp = true;
if (path.basename(path.dirname(path.dirname(home))) === "meituan-paotui") {
  // @mtuser/pt-passport 1.0.5 hardcodes /tmp for this client session despite
  // TMPDIR and PT_PASSPORT_AUTH_FILE. Redirect only that audited fixed pathname;
  // two managed installations must not share PKCE state with each other or a
  // user's independently installed CLI.
  const source = "/tmp/pt_passport_session_9fbb5793917d7477.json";
  const destination = path.join(home, "tmp", path.basename(source));
  const rewrite = value => value === source ? destination : value;
  for (const method of ["existsSync", "readFileSync", "writeFileSync", "unlinkSync", "openSync", "statSync", "lstatSync", "accessSync"]) {
    const original = fs[method];
    fs[method] = function isolatedSession(target, ...args) { return original.call(this, rewrite(target), ...args); };
  }
}
const spawn = childProcess.spawn;
childProcess.spawn = function managedSpawn(command, args, options = {}) {
  if (!Array.isArray(args)) { options = args || {}; args = []; }
  const child = spawn.call(this, command, args, { ...options, detached: false, cwd: home,
    env: { ...(options.env || process.env), HOME: home, NODE_OPTIONS: `--require=${JSON.stringify(__filename)}`, ELECTRON_RUN_AS_NODE: "1" } });
  const ncmEntry = path.join(path.dirname(home), "runtime", "dist", "index.js");
  if (path.basename(path.dirname(path.dirname(home))) === "netease-music"
    && process.argv[1] === ncmEntry && command === process.execPath && options.env?.NETEASE_BG_WORKER === "1"
    && args.length === 5 && args[0] === ncmEntry && args.slice(1).join("\0") === "login\0--background\0--output\0json") {
    // The pinned CLI unrefs its login poller after printing the link. Keep only
    // that worker referenced so the command remains the group's live owner
    // until authorization ends; the bridge still cancels/reaps the whole group.
    child.unref = () => child;
    child.once("exit", (code, signal) => { if (code !== 0 || signal) process.exitCode = code || 1; });
  }
  return child;
};
