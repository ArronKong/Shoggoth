"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createProductTelemetry } = require("../app/core/product-telemetry");
const { createConfigStore } = require("../app/core/config-store");
const { validateState } = require("../app/core/product-telemetry-store");
const { LIMITS } = require("../app/core/product-telemetry-schema");
const { BUILD, fakeClock, tempProfile } = require("./helpers/product-telemetry-fixtures.cjs");

function fixture(options = {}) {
  const profile = tempProfile();
  const clock = fakeClock();
  const config = createConfigStore(profile.configPath);
  config.ensure();
  const sent = [];
  const instances = [];
  const make = (overrides = {}) => {
    const instance = createProductTelemetry({
      statePath: profile.statePath, readConfigStatus: config.getReadStatus, clock, buildConfig: BUILD,
      transport: { async sendBatch(events) {
        // Budget and day receipt MUST already be on disk when transport is called.
        const stored = JSON.parse(fs.readFileSync(profile.statePath, "utf8"));
        for (const event of events) assert.ok(stored.outbox.find((row) => row.event.uuid === event.uuid)?.attemptsTotal > 0);
        sent.push(JSON.parse(JSON.stringify(events)));
        return { kind: "ok" };
      } },
      ...options, ...overrides,
    });
    instances.push(instance);
    return instance;
  };
  return { ...profile, clock, config, sent, make,
    read: () => JSON.parse(fs.readFileSync(profile.statePath, "utf8")),
    cleanup() { for (const item of instances) item.close(); profile.cleanup(); },
  };
}

test("idle start creates neither identity nor state; first real activity persists once then sends", async () => {
  const f = fixture();
  try {
    const c = f.make();
    assert.equal(fs.existsSync(path.dirname(f.statePath)), false);
    f.clock.advance(86_400_000);
    await f.clock.runDue();
    assert.equal(f.sent.length, 0);
    assert.equal(fs.existsSync(f.statePath), false);
    assert.equal(c.recordActivity({ page: "chat" }), false);
    assert.equal(c.recordActivity(), true);
    const state = f.read();
    assert.equal(validateState(state), true);
    assert.equal(state.outbox.length, 1);
    assert.equal(state.outbox[0].attemptsTotal, 0);
    assert.equal(fs.statSync(path.dirname(f.statePath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(f.statePath).mode & 0o777, 0o600);
    for (let n = 0; n < 500; n++) assert.equal(c.recordActivity(), false);
    assert.equal(f.sent.length, 0, "recording is independent of network");
    f.clock.advance(5000);
    await f.clock.runDue();
    assert.deepEqual(f.sent, [[state.outbox[0].event]]);
    assert.equal(f.read().outbox.length, 0);
    assert.equal(Object.hasOwn(c.getStatus(), "distinctId"), false);
    c.close();
    assert.equal(f.clock.timers.size, 0);
    assert.equal(c.recordActivity(), false);
  } finally { f.cleanup(); }
});

test("same-day restart/upgrade preserves identity and does not create another logical day", async () => {
  const f = fixture();
  try {
    let c = f.make();
    c.recordActivity();
    const event = f.read().outbox[0].event;
    c.close();
    c = f.make({ buildConfig: { ...BUILD, appVersion: "0.8.80" } });
    assert.equal(c.recordActivity(), false);
    await c.flush();
    assert.deepEqual(f.sent, [[event]], "queued metadata must not change on upgrade");
    c.close();
    c = f.make();
    assert.equal(c.recordActivity(), false);
    f.clock.set("2026-09-11T00:00:00Z");
    assert.equal(c.recordActivity(), true);
    assert.equal(f.read().distinctId, event.distinct_id);
    assert.notEqual(f.read().outbox[0].event.uuid, event.uuid);
  } finally { f.cleanup(); }
});

test("UTC midnight, month end, leap day and old-clock rollback use a bounded watermark", () => {
  const f = fixture();
  try {
    f.clock.set("2024-02-29T23:59:59.900Z");
    const c = f.make();
    assert.equal(c.recordActivity(), true);
    f.clock.set("2024-03-01T00:00:00.000Z");
    assert.equal(c.recordActivity(), true);
    assert.deepEqual(f.read().outbox.map((row) => row.event.properties.report_day), ["2024-02-29", "2024-03-01"]);
    f.clock.set("2026-09-30T23:59:59.999Z");
    assert.equal(c.recordActivity(), true);
    f.clock.advance(1);
    assert.equal(c.recordActivity(), true);
    for (const time of ["2026-09-30T23:59:00Z", "2025-01-01T00:00:00Z", "2024-02-29T00:00:00Z"]) {
      f.clock.set(time);
      assert.equal(c.recordActivity(), false);
    }
    assert.equal(f.read().lastActiveDay, "2026-10-01");
    assert.ok(f.read().outbox.length <= 2);
  } finally { f.cleanup(); }
});

test("unpackaged/disabled/unconfigured builds have zero state, timers, transport calls or config reads", async () => {
  for (const patch of [{ isPackaged: false }, { exportEnabled: false }, { projectToken: "" }, { region: "other" }]) {
    const f = fixture();
    try {
      let touched = 0;
      const c = f.make({ buildConfig: { ...BUILD, ...patch }, readConfigStatus() { touched++; return "ok"; },
        transport: { sendBatch() { touched++; } } });
      assert.equal(c.recordActivity(), false);
      await c.flush();
      assert.equal(touched, 0);
      assert.equal(f.clock.timers.size, 0);
      assert.equal(fs.existsSync(f.statePath), false);
    } finally { f.cleanup(); }
  }
});

test("configuration faults pause without resetting files; lost config with existing state cannot act as new install", async () => {
  const f = fixture();
  try {
    const c = f.make();
    c.recordActivity();
    const original = fs.readFileSync(f.statePath, "utf8");
    fs.writeFileSync(f.configPath, '{"token":"SECRET_CANARY",');
    assert.equal(c.recordActivity(), false);
    await c.flush();
    assert.equal(c.getStatus().pausedReason, "config_error");
    assert.equal(f.sent.length, 0);
    assert.equal(fs.readFileSync(f.statePath, "utf8"), original);
    c.close();
    fs.unlinkSync(f.configPath);
    const restarted = f.make();
    assert.equal(restarted.getStatus().pausedReason, "config_error");
    f.config.ensure();
    assert.equal(restarted.recordActivity(), false, "startup anomaly stays paused in this process");
    assert.equal(fs.readFileSync(f.statePath, "utf8"), original);
  } finally { f.cleanup(); }
});

test("new-install missing config is distinct from failure, and existing schema ignores unimplemented toggles", async () => {
  const f = fixture();
  try {
    fs.unlinkSync(f.configPath);
    const c = f.make();
    assert.equal(c.getStatus().collecting, true);
    f.config.ensure();
    f.config.write({ telemetry: { basicEnabled: false, enabled: false, detailedEnabled: true } });
    assert.equal(c.recordActivity(), true);
    await c.flush();
    assert.equal(f.sent.length, 1);
    assert.deepEqual(Object.keys(f.sent[0][0].properties).sort(), ["$geoip_disable", "$process_person_profile", "app_version", "arch", "os_family", "policy_version", "report_day", "schema_version"]);
  } finally { f.cleanup(); }
});

test("retry events are immutable and persisted budgets/backoff survive restart", async () => {
  const f = fixture();
  try {
    const calls = [];
    const transport = { async sendBatch(events) { calls.push(structuredClone(events)); return { kind: "retry" }; } };
    let c = f.make({ transport });
    c.recordActivity();
    const original = f.read().outbox[0].event;
    for (let n = 1; n <= 10; n++) {
      await c.flush();
      assert.equal(f.read().outbox[0].attemptsToday, n);
      c.close();
      c = f.make({ transport });
      await c.flush();
      assert.equal(calls.length, n, "restart must preserve nextAttemptAt");
      f.clock.advance(LIMITS.retryMaxMs);
    }
    await c.flush();
    assert.equal(calls.length, 10);
    assert.equal(f.read().outbox[0].attemptsTotal, 10);
    f.clock.set("2026-09-09T03:00:00Z");
    await c.flush();
    assert.equal(calls.length, 10, "clock rollback cannot reset a daily budget");
    f.clock.set("2026-09-11T03:00:00Z");
    await c.flush();
    assert.equal(calls.length, 11);
    assert.equal(f.read().outbox[0].attemptsTotal, 11);
    assert.equal(f.read().outbox[0].attemptsToday, 1);
    for (const batch of calls) assert.deepEqual(batch, [original]);
  } finally { f.cleanup(); }
});

test("70 total attempts and seven-day TTL bound offline/repeated restart data", async () => {
  const f = fixture();
  try {
    let attempts = 0;
    const c = f.make({ transport: { async sendBatch() { attempts++; return { kind: "retry" }; } } });
    c.recordActivity();
    for (let day = 10; day <= 16; day++) {
      f.clock.set(`2026-09-${day}T03:00:00Z`);
      for (let n = 0; n < 10; n++) { await c.flush(); f.clock.advance(LIMITS.retryMaxMs); }
    }
    assert.equal(attempts, 70);
    await c.flush();
    assert.equal(f.read().outbox.length, 0);
    assert.equal(c.recordActivity(), true);
    f.clock.set("2026-09-24T04:00:00Z");
    await c.flush();
    assert.equal(attempts, 70, "expired events must not be dispatched");
    assert.equal(f.read().outbox.length, 0);
  } finally { f.cleanup(); }
});

test("six-day offline events retain original timestamp and the queue stays bounded over months", async () => {
  const f = fixture();
  try {
    let c = f.make();
    c.recordActivity();
    const event = f.read().outbox[0].event;
    c.close();
    f.clock.advance(6 * 86_400_000);
    c = f.make();
    await c.flush();
    assert.deepEqual(f.sent, [[event]]);
    for (let n = 0; n < 200; n++) { f.clock.advance(86_400_000); c.recordActivity(); }
    assert.ok(f.read().outbox.length <= 7);
    assert.ok(fs.statSync(f.statePath).size < LIMITS.stateBytes);
  } finally { f.cleanup(); }
});

test("permanent receiver failures persist until a maintainer transport revision changes", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const transport = { async sendBatch() { calls++; return { kind: "pause", code: "http_rejected" }; } };
    let c = f.make({ transport });
    c.recordActivity();
    await c.flush();
    assert.equal(f.read().pausedReason, "http_rejected");
    c.close();
    f.clock.advance(86_400_000);
    c = f.make({ transport });
    assert.equal(c.recordActivity(), true, "receiver pause must not turn into an unbounded collection buffer");
    await c.flush();
    assert.equal(calls, 1);
    c.close();
    c = f.make({ buildConfig: { ...BUILD, revision: 2 } });
    await c.flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].length, 2);
    assert.equal(f.read().pausedReason, null);
  } finally { f.cleanup(); }
});

test("single flight, next-day activity during ACK, cancellation and late ACK are isolated", async () => {
  const f = fixture();
  try {
    let resolve;
    let signal;
    let calls = 0;
    const c = f.make({ transport: { sendBatch(_events, opts) {
      calls++; signal = opts.signal; return new Promise((done) => { resolve = done; });
    } } });
    c.recordActivity();
    const first = c.flush();
    const second = c.flush();
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    f.clock.advance(86_400_000);
    c.recordActivity();
    resolve({ kind: "ok" });
    await first;
    assert.equal(f.read().outbox.length, 1);
    assert.equal(f.read().outbox[0].event.properties.report_day, "2026-09-11");
    const last = c.flush();
    await Promise.resolve();
    c.close();
    assert.equal(signal.aborted, true);
    const before = fs.readFileSync(f.statePath, "utf8");
    resolve({ kind: "ok" });
    await last;
    assert.equal(fs.readFileSync(f.statePath, "utf8"), before);
    assert.equal(f.clock.timers.size, 0);
  } finally { f.cleanup(); }
});

test("failed initial write sends nothing; failed ACK commit can only retry the original event", async () => {
  const f = fixture();
  const originalRename = fs.renameSync;
  try {
    let c = f.make();
    fs.renameSync = (from, to) => { if (to === f.statePath) throw new Error("synthetic ENOSPC"); return originalRename(from, to); };
    assert.equal(c.recordActivity(), false);
    await c.flush();
    assert.equal(f.sent.length, 0);
    assert.equal(fs.existsSync(f.statePath), false);
    c.close();
    fs.renameSync = originalRename;
    const calls = [];
    c = f.make({ transport: { async sendBatch(events) {
      calls.push(structuredClone(events));
      fs.renameSync = (from, to) => { if (to === f.statePath) throw new Error("synthetic ACK disk failure"); return originalRename(from, to); };
      return { kind: "ok" };
    } } });
    c.recordActivity();
    await c.flush();
    assert.equal(c.getStatus().pausedReason, "state_error");
    assert.equal(f.read().outbox.length, 1);
    c.close();
    fs.renameSync = originalRename;
    f.clock.advance(LIMITS.retryMaxMs);
    c = f.make();
    await c.flush();
    assert.deepEqual(f.sent, calls);
  } finally { fs.renameSync = originalRename; f.cleanup(); }
});

test("corruption, unknown fields, oversized state, unsafe links/permissions and live edits fail closed", async () => {
  for (const kind of ["unknown", "detail", "oversize", "version", "duplicate", "symlink", "hardlink", "permissions", "removed"]) {
    const f = fixture();
    try {
      const c = f.make();
      c.recordActivity();
      const s = f.read();
      if (kind === "unknown") s.outbox[0].event.properties.prompt = "SECRET_CANARY";
      if (kind === "detail") s.outbox[0].event.event = "shoggoth_daily_feature_usage";
      if (kind === "version") s.version = 999;
      if (kind === "duplicate") s.outbox.push(structuredClone(s.outbox[0]));
      if (["unknown", "detail", "version", "duplicate"].includes(kind)) fs.writeFileSync(f.statePath, JSON.stringify(s));
      if (kind === "oversize") fs.writeFileSync(f.statePath, "x".repeat(LIMITS.stateBytes + 1));
      if (kind === "permissions") fs.chmodSync(f.statePath, 0o644);
      if (kind === "hardlink") fs.linkSync(f.statePath, path.join(f.root, "hardlink"));
      if (kind === "removed") fs.unlinkSync(f.statePath);
      if (kind === "symlink") {
        fs.renameSync(f.statePath, path.join(f.root, "real-state"));
        fs.symlinkSync(path.join(f.root, "real-state"), f.statePath);
      }
      await c.flush();
      assert.equal(c.getStatus().pausedReason, "state_error", kind);
      assert.equal(f.sent.length, 0, kind);
      c.close();
      if (kind !== "removed") {
        const restarted = f.make();
        assert.equal(restarted.getStatus().pausedReason, "state_error", `restart ${kind}`);
        await restarted.flush();
        assert.equal(f.sent.length, 0);
      }
    } finally { f.cleanup(); }
  }
});

test("a competing writer or crash-left scratch file never overwrites unknown state or dispatches", async () => {
  const f = fixture();
  try {
    const first = f.make();
    const second = f.make();
    assert.equal(first.recordActivity(), true);
    const original = fs.readFileSync(f.statePath, "utf8");
    assert.equal(second.recordActivity(), false);
    assert.equal(second.getStatus().pausedReason, "state_error");
    assert.equal(fs.readFileSync(f.statePath, "utf8"), original);
    first.close(); second.close();
    const scratch = `${f.statePath}.tmp`;
    fs.writeFileSync(scratch, "SECRET_CANARY existing scratch", { flag: "wx", mode: 0o600 });
    const restarted = f.make();
    await restarted.flush();
    assert.equal(restarted.getStatus().pausedReason, "state_error");
    assert.equal(f.sent.length, 0);
    assert.equal(fs.readFileSync(f.statePath, "utf8"), original);
    assert.equal(fs.readFileSync(scratch, "utf8"), "SECRET_CANARY existing scratch");
  } finally { f.cleanup(); }
});
