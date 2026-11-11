"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { event, BUILD, tempProfile } = require("./helpers/product-telemetry-fixtures.cjs");
const { validateTelemetryEvent, validateTelemetrySignal, createTelemetryEvent, DAILY_EVENT, getUtcDay,
  isEligibleBuild } = require("../app/core/product-telemetry-schema");
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
    assert.deepEqual(original.telemetry, { enabled: true, detailedEnabled: true, policyVersion: 2 });
    store.write({ locale: "en", telemetry: { basicEnabled: false, detailedEnabled: true } });
    assert.equal(store.read().locale, "en");
    assert.deepEqual(store.read().telemetry, original.telemetry);
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

test("migration preserves opt-outs and distinguishes absent, invalid, and future preferences", () => {
  const p = tempProfile();
  const store = createConfigStore(p.configPath);
  const put = telemetry => fs.writeFileSync(p.configPath, JSON.stringify({ locale: "zh-CN", telemetry }));
  try {
    put(undefined);
    assert.deepEqual(store.getTelemetryPreferences(), {
      status: "ok", preferences: { enabled: true, detailedEnabled: true, policyVersion: 2 }, needsMigration: true,
    });
    put({ enabled: true, basicEnabled: false, detailedEnabled: false, policyVersion: 1 });
    assert.deepEqual(store.writeTelemetryPreferences(), { enabled: false, detailedEnabled: false, policyVersion: 2 });
    store.write({ theme: "dark", telemetry: { enabled: true, detailedEnabled: true } });
    assert.equal(store.getTelemetryPreferences().preferences.enabled, false);
    assert.equal(store.getTelemetryPreferences().preferences.detailedEnabled, false);
    assert.equal(store.read().theme, "dark");
    assert.throws(() => store.writeTelemetryPreferences("detailedEnabled", "true"));
    put({ detailedEnabled: "true" });
    assert.deepEqual(store.writeTelemetryPreferences(), { enabled: true, detailedEnabled: false, policyVersion: 2 });
    for (const invalid of [null, [], { enabled: "true" }, { basicEnabled: null }, { policyVersion: 3 }]) {
      put(invalid);
      assert.equal(store.getTelemetryPreferences().status, "invalid");
      assert.throws(() => store.writeTelemetryPreferences("enabled", true));
      store.write({ locale: "en" });
      assert.deepEqual(JSON.parse(fs.readFileSync(p.configPath)).telemetry, invalid);
    }
  } finally { p.cleanup(); }
});

test("detailed schema admits only catalog IDs, fixed counters and complete configuration projections", () => {
  const { uuid, distinct_id: distinctId, timestamp } = event();
  const daily = createTelemetryEvent(DAILY_EVENT, { uuid, distinctId, nowMs: Date.parse(timestamp), build: BUILD }, {
    catalog_version: 1, used_inspiration: true, inspiration_create_attempt_count: 2,
    observed_model: true, configured_model_ids: ["openai/gpt-6.1-sol"], configured_model_count: 1,
  });
  assert.equal(validateTelemetryEvent(daily), true);
  for (const mutation of [
    { used_model_ids: ["SECRET_CANARY"] }, { configured_model_ids: ["openai/gpt-6.1-sol", "openai/gpt-6.1-sol"] },
    { configured_model_ids: ["provider/private-model"] }, { configured_model_count: Infinity },
    { used_chat: "true" }, { used_dashboard: false }, { inspiration_create_attempt_count: -1 },
    { enabled_connector_ids: ["featured/cloudflare"] }, { catalog_version: 99 }, { path: "/SECRET_CANARY" },
  ]) assert.equal(validateTelemetryEvent({ ...daily, properties: { ...daily.properties, ...mutation } }), false);
  assert.equal(validateTelemetryEvent({ ...daily, timestamp }), false);
  const snapshot = { kind: "configuration_snapshot", collectionEpoch: uuid,
    payload: { dimension: "provider", values: { configured_provider_ids: ["anthropic", "custom"], configured_provider_count: 3 } } };
  assert.equal(validateTelemetrySignal(snapshot), true);
  snapshot.payload.values.secret = "SECRET_CANARY";
  assert.equal(validateTelemetrySignal(snapshot), false);
  const end = { kind: "feature_end", collectionEpoch: uuid, payload: {
    operationId: distinctId, outcome: "success", errorKind: null, usage: {
      runtimeType: "codex", providerId: "openai", modelId: "openai/gpt-6.1-sol",
    },
  } };
  assert.equal(validateTelemetrySignal(end), true);
  end.payload.usage.sessionId = "SECRET_CANARY";
  assert.equal(validateTelemetrySignal(end), false);
});
