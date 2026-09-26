#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { getModelCatalogCache, modelCatalogIdentity } = require("../app/agent-service/model-catalog-cache");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("catalog cold readers join one refresh; known warm model resumes while freshness waits", async () => {
  const cache = getModelCatalogCache({});
  let clock = 1000;
  let calls = 0;
  let next = deferred();
  const options = { key: "account/provider/version/auth", now: () => clock,
    load: () => { calls += 1; return next.promise; } };
  const first = cache.read(options);
  const second = cache.read(options);
  await Promise.resolve();
  assert.equal(calls, 1);
  const original = [{ model: "provider/selected" }];
  next.resolve(original);
  assert.equal(await first, original);
  assert.equal(await second, original);
  clock += 5 * 60 * 1000;
  next = deferred();
  const staleOptions = { ...options, allowStale: (models) => models.some((row) => row.model === "provider/selected") };
  assert.equal(await cache.read(staleOptions), original);
  assert.equal(await cache.read(staleOptions), original);
  assert.equal(calls, 2);
  let freshSettled = false;
  const fresh = cache.read(options).then((value) => { freshSettled = true; return value; });
  await Promise.resolve();
  assert.equal(freshSettled, false);
  const refreshed = [{ model: "provider/changed" }];
  next.resolve(refreshed);
  assert.equal(await fresh, refreshed);
  assert.equal(calls, 2);
});

test("known auth refresh failure cannot be hidden by the stale snapshot", async () => {
  const cache = getModelCatalogCache({});
  let clock = 1;
  const authError = Object.assign(new Error("private upstream diagnostic"), { code: "AUTH_REQUIRED" });
  await cache.read({ key: "identity", now: () => clock, load: async () => ["model"] });
  clock += 5 * 60 * 1000;
  const next = deferred();
  const errors = [];
  const options = { key: "identity", now: () => clock, allowStale: true,
    load: () => next.promise, onRefreshError: (error) => errors.push(error.code) };
  assert.deepEqual(await cache.read(options), ["model"]);
  next.reject(authError);
  await assert.rejects(cache.read({ ...options, allowStale: false }), { code: "AUTH_REQUIRED" });
  assert.deepEqual(errors, ["AUTH_REQUIRED"]);
  await assert.rejects(cache.read(options), { code: "AUTH_REQUIRED" });
});

test("identity and auth generation invalidate pending writes, without poisoning the replacement", async () => {
  const cache = getModelCatalogCache({});
  const old = deferred();
  let identity = "account-a";
  const previous = cache.read({ key: identity, load: () => old.promise,
    isCurrent: () => identity === "account-a" });
  await Promise.resolve();
  identity = "account-b";
  cache.invalidate();
  const current = ["account-b-model"];
  assert.equal(await cache.read({ key: identity, load: async () => current }), current);
  old.resolve(["old-account-model"]);
  await assert.rejects(previous, { code: "RUNTIME_MODEL_CATALOG_CHANGED" });
  assert.equal(await cache.read({ key: identity, load: () => assert.fail("must use current cache") }), current);
});

test("a retired host does not start a queued refresh or return its late response", async () => {
  const cache = getModelCatalogCache({});
  let alive = true;
  const stoppedBeforeLoad = cache.read({ key: "host", isCurrent: () => alive,
    load: () => assert.fail("a stopped host must not spawn a control process") });
  alive = false;
  await assert.rejects(stoppedBeforeLoad, { code: "RUNTIME_MODEL_CATALOG_CHANGED" });
  alive = true;
  const next = deferred();
  const stoppedDuringLoad = cache.read({ key: "host", isCurrent: () => alive, load: () => next.promise });
  await Promise.resolve();
  alive = false;
  next.resolve(["late"]);
  await assert.rejects(stoppedDuringLoad, { code: "RUNTIME_MODEL_CATALOG_CHANGED" });
});

test("expired stale window and cold failure still require real validation", async () => {
  const cache = getModelCatalogCache({});
  let clock = 1;
  await cache.read({ key: "key", now: () => clock, load: async () => ["old"] });
  clock += 30 * 60 * 1000;
  const failure = Object.assign(new Error("catalog failed"), { code: "RUNTIME_MODEL_CATALOG_UNAVAILABLE" });
  await assert.rejects(cache.read({ key: "key", now: () => clock, allowStale: true,
    load: async () => { throw failure; } }), { code: failure.code });
  await assert.rejects(cache.read({ key: "cold", allowStale: true,
    load: async () => { throw failure; } }), { code: failure.code });
});

test("catalog identity separates account, provider, CLI, auth generation and native file edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-catalog-identity-"));
  try {
    const file = path.join(root, "provider.json");
    fs.writeFileSync(file, "fixture", { mode: 0o600 });
    const values = { account: "account-a", provider: "provider-a", version: "1", authGeneration: 0 };
    const fingerprint = (input = values) => modelCatalogIdentity({ fs, values: input, files: [file] });
    const initial = fingerprint();
    assert.equal(fingerprint({ ...values }), initial);
    for (const key of Object.keys(values)) assert.notEqual(fingerprint({ ...values, [key]: "changed" }), initial);
    fs.writeFileSync(file, "updated fixture", { mode: 0o600 });
    assert.notEqual(fingerprint(), initial);
    fs.unlinkSync(file);
    assert.notEqual(fingerprint(), initial);
    const profile = path.join(root, "profiles", "custom");
    fs.mkdirSync(profile, { recursive: true });
    const settings = path.join(profile, "settings.yaml");
    fs.writeFileSync(settings, "provider: first");
    const directoryFingerprint = () => modelCatalogIdentity({ fs, values,
      directories: [path.join(root, "profiles")] });
    const profileIdentity = directoryFingerprint();
    fs.writeFileSync(settings, "provider: changed-endpoint");
    assert.notEqual(directoryFingerprint(), profileIdentity, "nested provider config edits invalidate identity");
    assert.throws(() => modelCatalogIdentity({ fs: { statSync() { throw Object.assign(new Error(), { code: "EACCES" }); } },
      values, files: [file] }), { code: "RUNTIME_MODEL_CATALOG_IDENTITY_UNAVAILABLE" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
