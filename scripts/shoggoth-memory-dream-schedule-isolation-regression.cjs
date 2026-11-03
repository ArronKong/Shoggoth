"use strict";

// One Profile whose config cannot be read must not stop Dreaming for the
// other Profiles, and must not leave the scheduler without a wake-up time.
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { MemoryMaintenance } = require("../app/agent-service/shoggoth-memory/maintenance.cjs");

function fakeService({ broken }) {
  const warnings = [], dreams = [];
  const service = {
    opened: true, jobs: new Map(), blockedProfiles: new Set(), now: () => Date.UTC(2026, 10, 3, 12),
    database: { db: new DatabaseSync(":memory:") },
    logger: { warn: message => warnings.push(message) },
    profiles: () => [{ id: "broken", enabled: true }, { id: "healthy", enabled: true }],
    profileSignal: () => new AbortController().signal,
    config(profileId) {
      if (broken && profileId === "broken") throw Object.assign(new Error("credential missing"), { code: "MEMORY_OWNER_CREDENTIAL_MISSING" });
      return { plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true, timezone: "UTC" } } } } } };
    },
    async dream(profileId) { dreams.push(profileId); return { handled: true }; },
  };
  service.maintenance = new MemoryMaintenance(service);
  service.maintenance.open();
  return { service, warnings, dreams };
}

test("a Profile with unreadable config is skipped and the others still dream", async () => {
  const { service, warnings, dreams } = fakeService({ broken: true });
  const due = service.maintenance.nextDueAt();
  assert.ok(Number.isSafeInteger(due) && due > service.now(), "the healthy Profile still gives the scheduler a wake-up time");
  service.maintenance.tick(due);
  await Promise.all([...service.maintenance.pending.values()]);
  assert.deepEqual(dreams, ["healthy"]);
  assert.equal(service.database.db.prepare("SELECT state FROM memory_dream_schedule WHERE profile_id='healthy'").get().state, "completed");
  assert.ok(warnings.some(message => message.includes("profile=broken") && message.includes("MEMORY_OWNER_CREDENTIAL_MISSING")));
  await service.maintenance.close();
});

test("healthy Profiles keep the original schedule", async () => {
  const { service, warnings, dreams } = fakeService({ broken: false });
  const due = service.maintenance.nextDueAt();
  service.maintenance.tick(due);
  await Promise.all([...service.maintenance.pending.values()]);
  assert.deepEqual(dreams.sort(), ["broken", "healthy"]);
  assert.deepEqual(warnings, []);
  await service.maintenance.close();
});
