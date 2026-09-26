#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

function processGroupId(pid) {
  const inspected = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  const pgid = Number(inspected.stdout.trim());
  if (inspected.status !== 0 || !Number.isSafeInteger(pgid) || pgid <= 1) {
    throw new Error("failed to verify probe fixture process group");
  }
  return pgid;
}

process.on("SIGTERM", () => process.exit(0));
const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
], {
  detached: false,
  stdio: "ignore",
});
const pgid = processGroupId(process.pid);
if (processGroupId(descendant.pid) !== pgid) throw new Error("probe fixture descendant escaped process group");
const readyPath = process.env.CODEX_PROBE_READY_PATH;
const pendingReadyPath = `${readyPath}.${process.pid}.tmp`;
fs.writeFileSync(pendingReadyPath, `${JSON.stringify({ pid: process.pid, descendantPid: descendant.pid, pgid })}\n`, {
  mode: 0o600,
});
fs.renameSync(pendingReadyPath, readyPath);
setInterval(() => {}, 1_000);
