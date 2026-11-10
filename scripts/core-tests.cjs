#!/usr/bin/env node
"use strict";

// A reviewed offline manifest, not a glob that can accidentally run live tools.
// Keep the existing node:test and standalone assertion runners unchanged.
const fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");

function runCoreTests(names, { root = ROOT, run = spawnSync, log = console.log } = {}) {
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length
    || names.some(name => typeof name !== "string" || !/^[a-z0-9-]+\.(?:cjs|mjs)$/u.test(name)
      || !fs.statSync(path.join(root, "scripts", name), { throwIfNoEntry: false })?.isFile())) {
    throw new Error("Core test manifest must contain unique existing script names");
  }
  const results = [];
  for (const name of names) {
    log(`CORE START ${name}`);
    const result = run(process.execPath, [path.join("scripts", name)], {
      cwd: root, env: process.env, stdio: "inherit", timeout: 600_000,
    });
    const passed = result.status === 0 && !result.signal && !result.error;
    results.push({ name, passed });
    log(`CORE ${passed ? "PASS" : "FAIL"} ${name}`);
  }
  log(`CORE RESULT ${results.filter(row => row.passed).length}/${names.length} scripts passed`);
  return results.every(row => row.passed);
}

if (require.main === module) {
  try { process.exitCode = runCoreTests(require("./core-test-scripts.json")) ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { runCoreTests };
