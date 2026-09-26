#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { JsonlProductStore } = require("../app/agent-service/product-store");
const { createAgentService } = require("../app/agent-service/server");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-account-wiring-"));
const paths = resolveServicePaths({
  stateRoot: path.join(root, "state"),
  cacheRoot: path.join(root, "cache"),
});
const runtimeStorageHomedir = path.join(root, "native-home");
fs.mkdirSync(runtimeStorageHomedir, { recursive: true, mode: 0o700 });
const parentEnv = Object.freeze({
  HOME: runtimeStorageHomedir,
  PATH: process.env.PATH || "/usr/bin:/bin",
});
const productStore = new JsonlProductStore({ paths });
const sentinel = Object.freeze({ id: "sentinel-runtime-account", runtime: "codex" });
const unusedSentinel = Object.freeze({ id: "unused-runtime-account", runtime: "codex" });
productStore.getRuntimeAccount = (runtimeAccountId) => (
  runtimeAccountId === sentinel.id ? sentinel
    : runtimeAccountId === unusedSentinel.id ? unusedSentinel : null
);
const profiles = [{
  id: "0000-archived-profile",
  runtime: "codex",
  runtimeProfileId: "archived-runtime-profile",
  runtimeAccountId: sentinel.id,
  isDefault: false,
  enabled: false,
}, {
  id: "8888-default-custom-provider-profile",
  runtime: "codex",
  runtimeProfileId: "custom-provider-runtime-profile",
  runtimeAccountId: sentinel.id,
  isDefault: true,
  enabled: true,
  providerRef: "custom-responses-provider",
}, {
  id: "ffff-enabled-profile",
  runtime: "codex",
  runtimeProfileId: "enabled-runtime-profile",
  runtimeAccountId: sentinel.id,
  isDefault: false,
  enabled: true,
}];
productStore.listAgentProfiles = () => profiles;
productStore.getAgentRuntimeBindings = (profileId) => ({ bindings: profiles
  .filter((profile) => profile.id === profileId)
  .map((profile) => ({ id: `${profile.id}-binding`, runtime: profile.runtime,
    runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
    enabled: true })) });

const service = createAgentService({
  paths,
  productStore,
  parentEnv,
  runtimeStorageHomedir,
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => Buffer.from(value).toString("utf8"),
  },
});

try {
  const pools = [
    service.runtimePool,
    service.grokBuildRuntimePool,
    service.antigravityRuntimePool,
    service.piRuntimePool,
    service.claudeCodeRuntimePool,
    service.openCodeRuntimePool,
    service.deepSeekHarnessRuntimePool,
  ];
  assert.equal(pools.length, 7);
  for (const pool of pools) {
    assert.strictEqual(pool.runtimeAccountLookup(sentinel.id), sentinel);
    assert.strictEqual(pool.options.parentEnv, parentEnv);
    assert.equal(pool.options.homedir, runtimeStorageHomedir);
  }
  assert.deepEqual(
    service.contextCompiler.runtimeCapabilitiesForProfile({ runtime: "codex" }),
    ["mcp", "filesystem", "shell"],
  );
  assert.strictEqual(
    service.runtimeAccountAdmission.runtimeAccountLookup(sentinel.id),
    sentinel,
  );
  assert.deepEqual(
    service.accountAuthManager.resolveRuntimeAccountBinding(sentinel.id),
    {
      runtime: "codex",
      runtimeProfileId: "enabled-runtime-profile",
      runtimeAccountId: sentinel.id,
    },
    "account auth must prefer an enabled sibling without a Profile provider override over "
      + "the default custom-provider Profile and a lexically earlier archived Profile",
  );
  assert.throws(
    () => service.accountAuthManager.resolveRuntimeAccountBinding(unusedSentinel.id),
    (error) => error?.code === "AUTH_ACCOUNT_BINDING_INVALID",
    "an account without Profiles remains unavailable to account auth",
  );
  assert.ok(service.runtimeSessionOwnershipStore);
  assert.equal(Object.hasOwn(service, "runtimeAccountMigrationOrchestrator"), false,
    "current-only authority must not expose legacy migration");
  assert.equal(Object.hasOwn(service, "runtimeBackupStore"), false,
    "current-only authority must not expose legacy backup migration");
  assert.equal(Object.hasOwn(service, "runtimeBackupCleanup"), false,
    "current-only authority must not expose legacy backup cleanup");
  assert.equal(Object.hasOwn(service, "nativeSkillProjector"), false,
    "legacy per-Profile Skill projection must not be exposed by production service wiring");
  for (const runtime of [
    "codex", "grok-build", "antigravity", "pi", "claude-code", "opencode", "deepseek-harness",
  ]) {
    assert.equal(fs.existsSync(path.join(paths.stateDir, runtime)), false,
      `constructing the service must not prepare the legacy ${runtime} Profile-Home root`);
  }
  assert.equal(fs.existsSync(paths.backupsDir), false,
    "constructing the service must not create or mutate the backup authority");
  console.log("PASS server wires RuntimeAccount authority without legacy Profile-Home projection");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
