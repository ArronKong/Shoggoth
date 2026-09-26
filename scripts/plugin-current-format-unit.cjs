"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths, resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { JsonlProductStore, STORE_SCHEMA_VERSION, snapshotChecksum } = require("../app/agent-service/product-store");
const { assertCurrentStorageBaseline } = require("../app/agent-service/storage-baseline");
const { PluginStore } = require("../app/agent-service/plugin-store");

const root = fs.mkdtempSync("/tmp/sg-current-");
try {
  const userInfo = () => ({ homedir: root });
  const canonical = resolveCanonicalServicePaths({ userInfo });
  assert.equal(canonical.userDataRoot, path.join(root, "Library/Application Support/Shoggoth"));
  assert.equal(canonical.productSchemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(STORE_SCHEMA_VERSION, 15);
  // Stale, even corrupt experiment selectors must have no effect on startup.
  const selector = path.join(root, "Library/Application Support/Shoggoth Agent Service/product-profile/selection.json");
  fs.mkdirSync(path.dirname(selector), { recursive: true, mode: 0o700 });
  fs.writeFileSync(selector, "broken experimental selector", { mode: 0o600 });
  assert.deepEqual(resolveCanonicalServicePaths({ userInfo }), canonical);
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "data"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  assertCurrentStorageBaseline(paths);
  new JsonlProductStore({ paths }).open().close();
  const store = new PluginStore({ paths }).open();
  const authority = store.getAuthorityIncarnation(); store.close();
  assertCurrentStorageBaseline(paths);
  const reopened = new PluginStore({ paths }).open();
  assert.equal(reopened.getAuthorityIncarnation(), authority); reopened.close();
  const current = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  for (const unsupported of [14, 16]) {
    const snapshot = { ...current, schemaVersion: unsupported };
    snapshot.checksum = snapshotChecksum(snapshot);
    fs.writeFileSync(paths.stateSnapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
    const before = fs.readFileSync(paths.stateSnapshotPath);
    assert.throws(() => assertCurrentStorageBaseline(paths), { code: "SHOGGOTH_DATA_RESET_REQUIRED" });
    assert.throws(() => new JsonlProductStore({ paths }).open(), { code: "STORE_SCHEMA_UNSUPPORTED" });
    assert.deepEqual(fs.readFileSync(paths.stateSnapshotPath), before, "unsupported data is never migrated or erased implicitly");
  }
  assert.throws(() => new JsonlProductStore({ paths: { ...paths, productSchemaVersion: 14 } }), { code: "STORE_INVALID_OPTIONS" });
  console.log("PASS current product format: plugins by default, single root, ignored old selector, restart and no automatic data rewrite");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
