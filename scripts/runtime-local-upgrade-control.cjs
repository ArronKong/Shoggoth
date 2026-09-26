#!/usr/bin/env node
"use strict";

// Explicit local installation support. Stops only this installed UI and the
// authenticated, idle native Service; external Gateway/dashboard are untouched.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { createLaunchAgentController } = require("../app/agent-service/launch-agent");
const appPath = "/Applications/Shoggoth.app";
const executablePath = `${appPath}/Contents/MacOS/Shoggoth`;
const resourcesPath = `${appPath}/Contents/Resources`;
const label = `gui/${process.getuid()}/com.shoggoth.agent-service`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const mode = process.argv[2];
  assert.ok(["status", "stop", "start"].includes(mode));
  if (mode === "start") {
    const result = await createLaunchAgentController({ appPath, executablePath, resourcesPath }).start();
    console.log(JSON.stringify(result));
    return;
  }
  const paths = resolveCanonicalServicePaths(), token = readClientToken(paths);
  const call = method => requestService(paths, { token, version: SERVICE_PROTOCOL_VERSION, method });
  if (mode === "status") {
    console.log(JSON.stringify({ status: await call("service.status"), impact: await call("service.stopImpact") }));
    return;
  }
  const requireIdle = async () => {
    const impact = await call("service.stopImpact");
    assert.ok(impact.availability === "available" && impact.totalCount === 0, "Service has active work; defer replacement");
  };
  await requireIdle();
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
  const ui = rows.map(row => /^\s*(\d+)\s+(.*)$/u.exec(row)).filter(Boolean)
    .filter(row => (row[2] === executablePath || row[2].startsWith(executablePath + " "))
      && !row[2].includes("--shoggoth-internal-role="));
  assert.ok(ui.length <= 1, "ambiguous installed UI process");
  for (const row of ui) {
    const pid = Number(row[1]);
    assert.equal(execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim(), row[2]);
    process.kill(pid, "SIGTERM");
    let gone = false;
    for (let i = 0; i < 150; i++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") { gone = true; break; } throw error; }
      await delay(100);
    }
    assert.ok(gone, "UI did not stop");
  }
  await requireIdle();
  execFileSync("/bin/launchctl", ["disable", label]);
  try {
    await requireIdle();
    await call("service.stop");
    for (let i = 0; i < 200 && fs.existsSync(paths.lockPath); i++) await delay(100);
    assert.ok(!fs.existsSync(paths.lockPath), "Service checkpoint did not complete");
    execFileSync("/bin/launchctl", ["bootout", label]);
  } catch (error) {
    execFileSync("/bin/launchctl", ["enable", label]);
    throw error;
  }
  console.log(JSON.stringify({ stopped: true, activeWork: 0, uiPids: ui.map(row => Number(row[1])), externalServicesChanged: false }));
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
