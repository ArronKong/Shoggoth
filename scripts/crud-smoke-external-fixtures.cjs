"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SUITES = Object.freeze([
  "openclaw-8-cron-workboard-unit.mjs",
  "hermes-cron-contract-unit.mjs",
  "hermes-kanban-contract-unit.mjs",
  "hermes-task-create-board-regression.mjs",
  "kanban-origin-regression.mjs",
]);

async function runExternalMutationFixtures(selection = SUITES) {
  for (const suite of selection) {
    if (!SUITES.includes(suite)) throw new Error(`Unknown CRUD fixture: ${suite}`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-crud-fixture-"));
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    console.log(`[crud] ISOLATED_MUTATIONS ${suite}: fake upstream; no live execution/delivery proof`);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, suite)], {
          cwd: path.resolve(__dirname, ".."),
          env: { HOME: home, TMPDIR: root, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "en_US.UTF-8", ELECTRON_RUN_AS_NODE: "1" },
          stdio: "inherit",
        });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          if (code === 0 && !signal) resolve();
          else reject(new Error(`${suite} failed: exit=${code} signal=${signal || "none"}`));
        });
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`[crud] ISOLATED_MUTATIONS ${selection.length}/${selection.length} suites passed; live mutations intentionally untested`);
}

module.exports = { SUITES, runExternalMutationFixtures };
if (require.main === module) runExternalMutationFixtures().catch((error) => { console.error(error); process.exitCode = 1; });
