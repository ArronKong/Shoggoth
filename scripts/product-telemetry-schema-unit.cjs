"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { event, BUILD, tempProfile } = require("./helpers/product-telemetry-fixtures.cjs");
const { validateTelemetryEvent, getUtcDay, isEligibleBuild } = require("../app/core/product-telemetry-schema");
const { createConfigStore } = require("../app/core/config-store");

test("UTC calendar days, including leap/month boundaries, reject invalid time", () => {
  assert.equal(getUtcDay(Date.parse("2026-09-10T07:59:59+08:00")), "2026-09-09");
  assert.equal(getUtcDay(Date.parse("2024-03-01T00:00:00Z")), "2024-03-01");
  for (const value of [NaN, Infinity, -1, "2026-09-10", 9e18]) assert.equal(getUtcDay(value), null);
});

test("only the exact minimal basic event is valid", () => {
  for (const raw of [null, [], "activity", { page: "chat" }, { backend: "hermes" }]) assert.equal(validateTelemetryEvent(raw), false);
  assert.equal(validateTelemetryEvent(event()), true);
  for (const patch of [
    { event: "shoggoth_daily_feature_usage" }, { uuid: "business-session-id" },
    { distinct_id: "email@example.test" }, { timestamp: "2026-02-30T02:00:00.000Z" },
    { timestamp: "2026-09-10" }, { tier: "basic" }, { text: "SECRET_CANARY" },
  ]) assert.equal(validateTelemetryEvent({ ...event(), ...patch }), false);
  for (const patch of [
    { page: "chat" }, { used_chat: true }, { backendType: "hermes" }, { model: "SECRET_CANARY" },
    { $set: { email: "SECRET_CANARY" } }, { $process_person_profile: true }, { $geoip_disable: false },
    { report_day: "2026-09-11" }, { arch: "custom-machine" }, { os_family: "MacBook" },
    { schema_version: "1" }, { policy_version: 2 }, { app_version: "SECRET_CANARY" },
    { prompt: "x".repeat(17000) },
  ]) assert.equal(validateTelemetryEvent({ ...event(), properties: { ...event().properties, ...patch } }), false);
});

test("validation never invokes accessors or custom serialization", () => {
  const raw = event();
  Object.defineProperty(raw, "properties", { enumerable: true, get() { throw new Error("secret"); } });
  assert.equal(validateTelemetryEvent(raw), false);
  assert.equal(validateTelemetryEvent({ ...event(), toJSON() { throw new Error("secret"); } }), false);
  assert.equal(validateTelemetryEvent(Object.assign(Object.create({ page: "chat" }), event())), false);
  assert.equal(validateTelemetryEvent({ ...event(), [Symbol("secret")]: true }), false);
});

test("release gate requires packaged build, public project token and fixed region", () => {
  assert.equal(isEligibleBuild(BUILD), true);
  for (const patch of [
    { exportEnabled: false }, { exportEnabled: "true" }, { isPackaged: false }, { projectToken: "" },
    { projectToken: "phx_PersonalSecret" }, { projectToken: "phs_ProjectSecret" },
    { projectToken: "phc_Token\n" }, { region: "https://attacker.test" }, { revision: 0 },
    { appVersion: "private-workspace" },
  ]) assert.equal(isEligibleBuild({ ...BUILD, ...patch }), false);
  assert.equal(isEligibleBuild(require("../app/product-telemetry-build-config")), false);
});

test("config health distinguishes first-run absence, errors and invalid root without exposing content", () => {
  const profile = tempProfile();
  try {
    const store = createConfigStore(profile.configPath);
    assert.equal(store.getReadStatus(), "missing");
    store.ensure();
    assert.equal(store.getReadStatus(), "ok");
    const original = store.read();
    assert.equal(Object.hasOwn(original, "telemetry"), false, "detailed preference schema is deferred");
    store.write({ locale: "en", telemetry: { basicEnabled: false, detailedEnabled: true } });
    assert.equal(store.read().locale, "en");
    assert.equal(Object.hasOwn(store.read(), "telemetry"), false);
    fs.writeFileSync(profile.configPath, '{"token":"SECRET_CANARY",');
    assert.equal(store.getReadStatus(), "parse_error");
    assert.equal(fs.readFileSync(profile.configPath, "utf8"), '{"token":"SECRET_CANARY",');
    for (const raw of ["null", "[]", "true", '"SECRET_CANARY"']) {
      fs.writeFileSync(profile.configPath, raw);
      assert.equal(store.getReadStatus(), "invalid");
    }
    fs.writeFileSync(profile.configPath, "x".repeat(1024 * 1024 + 1));
    assert.equal(store.getReadStatus(), "invalid");
    fs.unlinkSync(profile.configPath);
    fs.mkdirSync(profile.configPath);
    assert.equal(store.getReadStatus(), "read_error");
  } finally { profile.cleanup(); }
});
