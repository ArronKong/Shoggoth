"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BUILD = Object.freeze({
  exportEnabled: true, isPackaged: true, projectToken: "phc_SyntheticProjectNotForProduction",
  region: "us", revision: 1, appVersion: "0.8.79", platform: "darwin", arch: "arm64",
});

function event(at = "2026-09-10T02:00:00.000Z") {
  return {
    event: "shoggoth_app_active",
    uuid: "30000000-0000-4000-8000-000000000003",
    distinct_id: "20000000-0000-4000-8000-000000000002",
    timestamp: at,
    properties: {
      schema_version: 1, policy_version: 1, app_version: "0.8.79", os_family: "macos", arch: "arm64",
      report_day: at.slice(0, 10), $process_person_profile: false, $geoip_disable: true,
    },
  };
}

function tempProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-telemetry-test-"));
  return {
    root, configPath: path.join(root, "config.json"), statePath: path.join(root, "product-telemetry/state.json"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function fakeClock(start = "2026-09-10T02:00:00.000Z") {
  let now = Date.parse(start);
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    set: (value) => { now = typeof value === "number" ? value : Date.parse(value); },
    advance: (ms) => { now += ms; },
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    timers,
    async runDue() {
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) await timer.fn();
      }
    },
  };
}

module.exports = { BUILD, event, tempProfile, fakeClock };
