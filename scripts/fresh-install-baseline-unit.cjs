"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { JsonlProductStore, STORE_SCHEMA_VERSION, snapshotChecksum, eventChecksum } = require("../app/agent-service/product-store");
const { ensureBuiltinCliAgentProfiles } = require("../app/agent-service/builtin-cli-profiles");
const { assertCurrentStorageBaseline } = require("../app/agent-service/storage-baseline");
const { createAgentService } = require("../app/agent-service/server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { isNativeBindingDisabled, claimsNativeAgentId } = require("../app/agent-service/native-backend-identity");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID, DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME } = require("../app/agent-service/runtime-account");
const { isRuntimeAvailable } = require("../app/runtime-availability");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgfresh-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
    profileRoot: path.join(root, "profile"), trustedRoot: root });
  return { root, paths, open: () => new JsonlProductStore({ paths }).open() };
}
test("fresh profiles share one backend, use explicit runtime accounts and reopen without rewriting", t => {
  const f = fixture(t); assertCurrentStorageBaseline(f.paths);
  const store = f.open(); ensureBuiltinCliAgentProfiles(store);
  const profiles = store.listAgentProfiles();
  assert.equal(profiles.length, 1 + Object.keys(DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME).filter(isRuntimeAvailable).length);
  for (const profile of profiles) {
    assert.equal(profile.backendId, "shoggoth"); assert.ok(claimsNativeAgentId(profile.agentId));
    assert.equal(profile.runtimeAccountId, profile.isDefault ? SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
      : DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[profile.runtime]);
    assert.equal(store.getAgentRuntimeBindings(profile.id).bindings.length, 1);
  }
  store.close(); const before = fs.readFileSync(f.paths.stateSnapshotPath);
  const reopened = f.open(); assert.deepEqual(reopened.listAgentProfiles(), profiles);
  assert.deepEqual(ensureBuiltinCliAgentProfiles(reopened), []); reopened.close();
  assert.deepEqual(fs.readFileSync(f.paths.stateSnapshotPath), before);
  assertCurrentStorageBaseline(f.paths);
});
test("older and future snapshots are rejected without rewriting any data", t => {
  const f = fixture(t); f.open().close();
  const current = JSON.parse(fs.readFileSync(f.paths.stateSnapshotPath));
  for (const version of [1, 5, 8, 11, 12, 13, 14, STORE_SCHEMA_VERSION + 1]) {
    const snapshot = { ...current, schemaVersion: version }; snapshot.checksum = snapshotChecksum(snapshot);
    const bytes = Buffer.from(JSON.stringify(snapshot)); fs.writeFileSync(f.paths.stateSnapshotPath, bytes);
    assert.throws(() => assertCurrentStorageBaseline(f.paths), { code: "SHOGGOTH_DATA_RESET_REQUIRED" });
    assert.throws(() => f.open(), { code: "STORE_SCHEMA_UNSUPPORTED" });
    assert.deepEqual(fs.readFileSync(f.paths.stateSnapshotPath), bytes);
  }
  assert.equal(fs.existsSync(f.paths.backupsDir), false);
});
test("event-only old state is refused before crash-tail repair", t => {
  const f = fixture(t); const store = f.open();
  const events = fs.readFileSync(f.paths.eventLogPath, "utf8").trim().split("\n").map(JSON.parse);
  store.close(); fs.unlinkSync(f.paths.stateSnapshotPath);
  for (const event of events) { event.schemaVersion = STORE_SCHEMA_VERSION - 1; event.checksum = eventChecksum(event); }
  const bytes = Buffer.from(events.map(JSON.stringify).join("\n") + '\n{"partial":');
  fs.writeFileSync(f.paths.eventLogPath, bytes);
  assert.throws(() => assertCurrentStorageBaseline(f.paths), { code: "SHOGGOTH_DATA_RESET_REQUIRED" });
  assert.throws(() => f.open(), { code: "STORE_SCHEMA_UNSUPPORTED" });
  assert.deepEqual(fs.readFileSync(f.paths.eventLogPath), bytes);
});
test("Service refuses retired state before opening credential stores", async t => {
  const f = fixture(t); fs.mkdirSync(f.paths.stateDir, { recursive: true, mode: 0o700 });
  const legacy = path.join(f.paths.stateDir, "inspirations.json"), bytes = '{"version":2,"old":"keep until reset"}';
  fs.writeFileSync(legacy, bytes, { mode: 0o600 });
  let secretsOpened = false;
  const service = createAgentService({ paths: f.paths });
  service.secretStore.open = () => { secretsOpened = true; };
  await assert.rejects(service.start(), { code: "SHOGGOTH_DATA_RESET_REQUIRED" });
  assert.equal(secretsOpened, false); assert.equal(fs.readFileSync(legacy, "utf8"), bytes);
  assert.equal(fs.existsSync(f.paths.stateSnapshotPath), false);
  assert.equal(fs.existsSync(path.join(f.paths.stateDir, "inspirations.sqlite")), false);
});
test("registry accepts current ownership and refuses retired backend/resource aliases", () => {
  const registry = new BackendRegistry(), backend = new ShoggothBackend({ paths: {} }); registry.register(backend);
  assert.equal(registry.getBackend("shoggoth"), backend);
  for (const runtime of Object.keys(DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME)) {
    assert.equal(registry.getBackend(runtime), null);
    assert.equal(backend._nativeResourceLocalId(`${runtime}:11111111-1111-4111-8111-111111111111`), null);
    assert.throws(() => new ShoggothBackend({ id: runtime, paths: {} }));
  }
  for (const oldId of ["codex-old", "pi-old", "grok-old", "antigravity-old"]) assert.equal(claimsNativeAgentId(oldId), false);
  assert.equal(isNativeBindingDisabled("shoggoth-agent-a", "codex", ["codex"], SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID), false);
  assert.equal(isNativeBindingDisabled("shoggoth-agent-a", "codex", ["codex"], DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME.codex), true);
});

test("partial resets with retired domain stores fail before writers and leave bytes intact", async t => {
  const f = fixture(t); fs.mkdirSync(f.paths.stateDir, { recursive: true, mode: 0o700 });
  for (const [name, field, version] of [["chat-sessions.json", "version", 7], ["native-cron.json", "version", 2],
    ["native-kanban.json", "version", 3], ["account-auth-state-v2.json", "version", 1],
    ["runtime-session-ownership/ownership-v1.json", "version", 1], ["skills/registry.json", "schemaVersion", 1]]) {
    const file = path.join(f.paths.stateDir, name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify({ [field]: version }); fs.writeFileSync(file, bytes, { mode: 0o600 });
    assert.throws(() => assertCurrentStorageBaseline(f.paths), { code: "SHOGGOTH_DATA_RESET_REQUIRED" });
    assert.equal(fs.readFileSync(file, "utf8"), bytes); fs.unlinkSync(file);
  }
  const file = path.join(f.paths.stateDir, "inspirations.sqlite");
  const db = require("../app/agent-service/inspiration-database").openDatabase(file);
  db.exec("PRAGMA user_version=2; PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const before = fs.readFileSync(file);
  assert.throws(() => assertCurrentStorageBaseline(f.paths), { code: "SHOGGOTH_DATA_RESET_REQUIRED" });
  assert.deepEqual(fs.readFileSync(file), before);
});
