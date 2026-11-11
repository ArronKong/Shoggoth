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
  return child;
};
