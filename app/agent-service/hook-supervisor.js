"use strict";
// Trusted launcher, separate from the sandboxed user script. The worker
// inherits this process group, so a Service timeout kills both. If the Service
// dies, this supervisor destroys the worker before its workspace lease can be
// recovered. Never import Service credentials or application modules here.
const { spawn } = require("node:child_process");
const parent = process.ppid;
let child = null, stopped = false, input = Buffer.alloc(0);
const killGroup = () => {
  if (stopped) return;
  stopped = true;
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(3); }
};
process.on("SIGTERM", killGroup);
process.on("SIGINT", killGroup);
const monitor = setInterval(() => {
  if (process.ppid !== parent) killGroup();
  try { process.kill(parent, 0); } catch { killGroup(); }
}, 100);
process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  if (input.length > 65536) killGroup();
});
process.stdin.on("end", () => {
  try {
    const config = JSON.parse(input.toString("utf8"));
    if (config.parentPid !== parent || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1
      || config.timeoutMs > 60000 || typeof config.input !== "string") throw new Error("config");
    child = spawn(config.sandboxExecutable, ["-p", config.profile, config.interpreter, ...config.args],
      { cwd: config.scratch, env: config.env, shell: false, detached: false, stdio: ["pipe", "pipe", "pipe"] });
    const deadline = setTimeout(killGroup, config.timeoutMs + 500);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.stdin.on("error", () => {});
    child.on("error", () => killGroup());
    child.on("close", code => {
      stopped = true; clearInterval(monitor); clearTimeout(deadline);
      process.exitCode = code === 0 ? 0 : 2;
    });
    child.stdin.end(config.input);
  } catch { killGroup(); }
});
