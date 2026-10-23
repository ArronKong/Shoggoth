"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { defaultConfig, validateConfig, localParts, inActiveHours } = require("../app/agent-service/proactive-service-protocol");
const { ProactiveStore } = require("../app/agent-service/proactive-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ProactiveService } = require("../app/agent-service/proactive-service");
const { validateHeartbeatSettingsArguments, HEARTBEAT_SETTINGS_TOOL_DEFINITIONS } = require("../app/agent-service/heartbeat-settings-tools");
const NOW = Date.UTC(2026, 9, 16, 4);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-heartbeat-defaults-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const store = new ProactiveStore({ paths, now: () => NOW }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return store;
}
function assertDefaults(config) {
  assert.equal(config.enabled, true);
  assert.equal(config.schedule.everyMs, 30 * 60_000);
  assert.equal(config.timezone, "system");
  assert.deepEqual(config.activeHours, { start: "08:00", end: "22:00" });
  assert.deepEqual(config.budget, { maxRunsPerDay: 24, maxTokensPerDay: 10_000_000 });
}
test("conversational heartbeat contracts cover every setting and reject owner or rule mutations", () => {
  assert.equal(validateHeartbeatSettingsArguments("heartbeat_settings_get", {}), true);
  const config = { enabled: true, intervalMinutes: 15, maxRunsPerDay: 24, maxTokensPerDay: 10_000_000,
    timezone: "system", activeHours: { start: "08:00", end: "22:00" }, push: false };
  const valid = patch => validateHeartbeatSettingsArguments("heartbeat_settings_set", { expectedRevision: 1, config: patch });
  assert.equal(valid(config), true);
  for (const [key, value] of Object.entries(config)) assert.equal(valid({ [key]: value }), true, key);
  for (const value of [null, { start: "22:00", end: "08:00" }]) assert.equal(valid({ activeHours: value }), true);
  assert.equal(valid({ timezone: "America/New_York" }), true);
  for (const patch of [{}, { intervalMinutes: 0 }, { intervalMinutes: 1.5 }, { intervalMinutes: Infinity },
    { maxRunsPerDay: 49 }, { maxTokensPerDay: 10_000_001 }, { maxTokensPerDay: 1023 }, { enabled: "true" },
    { timezone: "not/a-zone" }, { activeHours: { start: "24:00", end: "08:00" } },
    { activeHours: { start: "08:00", end: "08:00" } }, { activeHours: { start: "08:00", end: "22:00", timezone: "UTC" } },
    { profileId: "another-agent" }, { runId: "other-run" }, { target: {} }, { scopes: {} }, { checklist: [] }, { push: 1 }]) assert.equal(valid(patch), false);
  assert.equal(validateHeartbeatSettingsArguments("heartbeat_settings_get", { profileId: "other-agent" }), false);
  assert.equal(validateHeartbeatSettingsArguments("heartbeat_settings_set", { expectedRevision: -1, config }), false);
  assert.equal(validateHeartbeatSettingsArguments("heartbeat_settings_set", { expectedRevision: 1, config, profileId: "other-agent" }), false);
  let reads = 0;
  assert.equal(valid(Object.defineProperty({}, "enabled", { enumerable: true, get() { reads++; return true; } })), false);
  assert.equal(reads, 0);
  const setter = HEARTBEAT_SETTINGS_TOOL_DEFINITIONS.find(tool => tool.name === "heartbeat_settings_set");
  assert.equal(setter.inputSchema.properties.config.additionalProperties, false);
  assert.equal(setter.inputSchema.properties.config.properties.maxTokensPerDay.maximum, 10_000_000);
});
test("heartbeat defaults enable local-time checks and accept the full ten-million budget", () => {
  const config = defaultConfig("heartbeat", "agent-a", NOW);
  assertDefaults(config);
  assert.deepEqual(validateConfig(config), config);
  assert.throws(() => validateConfig({ ...config, budget: { ...config.budget, maxTokensPerDay: 10_000_001 } }), { code: "PROACTIVE_INVALID" });
  const inspiration = defaultConfig("inspiration", "agent-a", NOW, "UTC");
  assert.equal(inspiration.enabled, false);
  assert.equal(inspiration.activeHours, null);
  assert.deepEqual(inspiration.budget, { maxRunsPerDay: 1, maxTokensPerDay: 20_000 });
  assert.throws(() => validateConfig({ ...inspiration, budget: { ...inspiration.budget, maxTokensPerDay: 10_000_000 } }), { code: "PROACTIVE_INVALID" });
});
test("system timezone follows the computer across zones and changes, including active-hour boundaries", () => {
  const protocol = require.resolve("../app/agent-service/proactive-service-protocol");
  const result = spawnSync(process.execPath, ["-e", `
    const { localParts, inActiveHours } = require(${JSON.stringify(protocol)});
    const hours = { start: "08:00", end: "22:00" }, now = ${NOW};
    const rows = ["Asia/Shanghai", "America/Los_Angeles", "Europe/Berlin"].map(zone => {
      process.env.TZ = zone;
      return { zone, parts: localParts(now, "system"), explicit: localParts(now, zone), active: inActiveHours(now, "system", hours) };
    });
    console.log(JSON.stringify(rows));
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  for (const row of rows) assert.deepEqual(row.parts, row.explicit);
  assert.equal(rows[0].parts.time, "12:00");
  assert.equal(rows[1].parts.day, "2026-10-15");
  assert.equal(rows[1].parts.time, "21:00");
  assert.equal(rows[2].parts.time, "06:00");
  assert.equal(rows[2].active, false);
  for (const [hour, minute, active] of [[7, 59, false], [8, 0, true], [21, 59, true], [22, 0, false]]) {
    assert.equal(inActiveHours(Date.UTC(2026, 9, 16, hour, minute), "UTC", { start: "08:00", end: "22:00" }), active);
  }
  assert.equal(localParts(NOW, "UTC").time, "04:00");
});
test("saved monitors receive defaults once without overwriting rules, scope or notification preferences", t => {
  const store = fixture(t), config = { ...defaultConfig("heartbeat", "existing-agent", NOW, "UTC"), enabled: false,
    schedule: { kind: "every", everyMs: 60 * 60_000, anchorMs: NOW - 60_000 }, activeHours: null, push: false,
    budget: { maxRunsPerDay: 12, maxTokensPerDay: 20_000 },
    checklist: [{ id: "task", instruction: "Keep my existing rule", enabled: true, mode: "review" }],
    scopes: { inspiration: false, runIds: ["run-a"] }, target: { mode: "explicit", sessionKey: "session-a" } };
  const before = store.setMonitor({ operationId: crypto.randomUUID(), expectedRevision: 0, config });
  const monitor = store.ensureHeartbeatMonitor(config.profileId);
  assertDefaults(monitor.config);
  assert.equal(monitor.revision, before.revision + 1);
  assert.equal(monitor.createdAt, before.createdAt);
  assert.equal(monitor.nextRunAt, NOW + 29 * 60_000);
  for (const key of ["checklist", "scopes", "target", "push"]) assert.deepEqual(monitor.config[key], config[key]);
  assert.deepEqual(store.ensureHeartbeatMonitor(config.profileId), monitor);
  const edited = store.setMonitor({ operationId: crypto.randomUUID(), expectedRevision: monitor.revision,
    config: { ...monitor.config, enabled: false, budget: { maxRunsPerDay: 3, maxTokensPerDay: 8192 } } });
  store.close(); store.open();
  assert.deepEqual(store.ensureHeartbeatMonitor(config.profileId), edited);
  const fresh = store.ensureHeartbeatMonitor("new-agent");
  assertDefaults(fresh.config);
  assert.equal(fresh.revision, 1);
  assert.equal(fresh.nextRunAt, NOW + 30 * 60_000);
  store.close(); store.open();
  assert.deepEqual(store.getMonitor(fresh.config.id), fresh);
});
test("non-Codex Agent settings can be saved without granting unverified Runtime execution", async t => {
  const store = fixture(t), profile = { id: "agent-pi", enabled: true, runtime: "pi" };
  let modelCalls = 0;
  const service = new ProactiveService({ store, productStore: { getAgentProfile: () => profile },
    dispatcher: { listRuns: () => [], enqueue() { modelCalls++; assert.fail("Unverified Runtime must not execute"); } },
    delivery: { open() {}, close() {} }, getCapability: () => ({ semanticVerified: false, reason: "PROACTIVE_RUNTIME_UNVERIFIED" }),
    verifyCapability: async () => { throw Object.assign(new Error("Unsupported Runtime"), { code: "PROACTIVE_RUNTIME_UNVERIFIED" }); },
    getProfileAvailability: () => true, now: () => NOW });
  service.activate(); t.after(() => service.close());
  const initial = store.ensureHeartbeatMonitor(profile.id);
  store.setMonitor({ operationId: crypto.randomUUID(), expectedRevision: initial.revision,
    config: { ...initial.config, checklist: [{ id: "review", instruction: "Check only when authorized", enabled: true, mode: "review" }] } });
  const before = store.getMonitor(initial.config.id);
  const saved = await service.handleSettingsTool("heartbeat_settings_set", profile.id,
    { expectedRevision: before.revision, config: { intervalMinutes: 15, activeHours: null, maxTokensPerDay: 10_000_000 } },
    { operationId: crypto.randomUUID(), assertCurrent() {} });
  assert.equal(saved.config.enabled, true); assert.equal(saved.config.intervalMinutes, 15);
  assert.equal(saved.status.capabilities.semanticVerified, false);
  const occurrence = store.claimOccurrence(initial.config.id, NOW, NOW);
  await service.check(occurrence);
  assert.equal(store.history(initial.config.id)[0].reason, "runtime_unverified"); assert.equal(modelCalls, 0);
});
