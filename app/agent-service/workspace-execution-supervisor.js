"use strict";
// Trusted launcher, copied into private control storage before execution. The
// sandboxed process receives only its own scratch directory and standard pipes.
const { spawn, spawnSync } = require("node:child_process");
const parent = process.ppid;
let stopped = false, input = Buffer.alloc(0), config = null;
const clean = () => {
  if (!config) return { cleared: false };
  const result = spawnSync(config.processOwner, [config.marker, config.guard], { encoding: "utf8", timeout: 3000,
    maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const value = JSON.parse(result.stdout);
    if (result.status === 0 && value.version === 1 && value.cleared === true) return value;
  } catch {}
  return { cleared: false };
};
const killGroup = (alreadyClean = false) => {
  if (stopped) return;
  stopped = true;
  if (alreadyClean !== true) clean();
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
  if (input.length > 128 * 1024) killGroup();
});
process.stdin.on("end", () => {
  try {
    config = JSON.parse(input.toString("utf8"));
    if (config.parentPid !== parent || !Number.isInteger(config.timeoutMs)
      // This launcher is copied standalone; mirror the shared 30-minute budget.
      || config.timeoutMs < 1 || config.timeoutMs > 30 * 60_000) throw new Error("config");
    const child = spawn("/usr/bin/sandbox-exec", ["-p", config.profile, "/bin/sh", "-c", config.command],
      { cwd: config.cwd, env: config.env, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    const deadline = setTimeout(killGroup, config.timeoutMs + 500);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    const finish = result => {
      clearInterval(monitor); clearTimeout(deadline);
      const cleanup = clean();
      if (process.send) process.send({ ...result, cleanup }, () => killGroup(cleanup.cleared === true));
      else killGroup();
    };
    child.on("error", () => finish({ launchFailed: true }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
  } catch { killGroup(); }
});
