#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createProductHostController } = require("../app/product-host-controller");

const ACCOUNT_ID = "native-grok-build-default-v1";
const ENTRY_ID = `legacy-home-${"b".repeat(64)}-v1`;
const PLAN_ID = "c".repeat(64);
const BACKUP_ENTRY_ID = `runtime-backup-${"d".repeat(64)}-v1`;
const BACKUP_PLAN_ID = "e".repeat(64);

function account() {
  return {
    id: ACCOUNT_ID,
    runtime: "grok-build",
    kind: "native-user",
    installationKind: "system",
    homeKind: "system-default",
    isDefault: true,
    sharedAgentCount: 3,
    admission: {
      generation: 1,
      active: 0,
      maxActive: 1,
      mutationActive: false,
      backoffUntil: null,
    },
  };
}

function home() {
  return {
    id: ENTRY_ID,
    runtime: "grok-build",
    runtimeAccountId: ACCOUNT_ID,
    accountKind: "native-user",
    role: "reclaimable",
    affectedAgentCount: 3,
    bytes: 2_048,
    files: 2,
    dirs: 1,
    symlinks: 0,
    incomplete: false,
    lastModifiedAt: 1_000,
  };
}

function backup() {
  return {
    id: BACKUP_ENTRY_ID,
    category: "native-runtime-import",
    role: "reclaimable",
    bytes: 8_192,
    files: 8,
    dirs: 2,
    symlinks: 0,
    incomplete: false,
    lastModifiedAt: 900,
  };
}

const calls = [];
const serviceRequest = async (method, params) => {
  calls.push([method, params]);
  if (method === "runtime.account.list") {
    return { accounts: [account()], nextCursor: null, hasMore: false };
  }
  if (method === "runtime.account.legacyHomes.list") {
    return { homes: [home()], nextCursor: null, hasMore: false };
  }
  if (method === "runtime.account.backups.list") {
    return { backups: [backup()], nextCursor: null, hasMore: false };
  }
  if (method === "runtime.account.storage.read") {
    return {
      runtimeAccountId: ACCOUNT_ID,
      scope: "native-system",
      available: true,
      bytes: 4096,
      files: 4,
      dirs: 2,
      symlinks: 0,
      incomplete: false,
      limitReason: null,
    };
  }
  if (method === "runtime.account.legacyHomes.cleanup.prepare") {
    return {
      planId: PLAN_ID,
      entryId: ENTRY_ID,
      runtime: "grok-build",
      runtimeAccountId: ACCOUNT_ID,
      affectedAgentCount: 3,
      bytes: 2_048,
      files: 2,
      dirs: 1,
      symlinks: 0,
      expiresAt: 2_000,
    };
  }
  if (method === "runtime.account.legacyHomes.cleanup.commit") {
    return {
      entryId: ENTRY_ID,
      runtime: "grok-build",
      runtimeAccountId: ACCOUNT_ID,
      bytesReleased: 2_048,
      filesRemoved: 2,
      dirsRemoved: 1,
      symlinksRemoved: 0,
      deletedAt: 1_500,
    };
  }
  if (method === "runtime.account.backups.cleanup.prepare") {
    return {
      planId: BACKUP_PLAN_ID,
      entryId: BACKUP_ENTRY_ID,
      category: "native-runtime-import",
      bytes: 8_192,
      files: 8,
      dirs: 2,
      symlinks: 0,
      expiresAt: 2_000,
    };
  }
  if (method === "runtime.account.backups.cleanup.commit") {
    return {
      entryId: BACKUP_ENTRY_ID,
      category: "native-runtime-import",
      bytesReleased: 8_192,
      filesRemoved: 8,
      dirsRemoved: 2,
      symlinksRemoved: 0,
      deletedAt: 1_500,
    };
  }
  throw new Error(`unexpected method ${method}`);
};

(async () => {
  const host = createProductHostController({
    serviceRequest,
    launchAgent: { status: async () => ({ supported: false, reason: "unsupported-platform" }) },
  });

  const snapshot = await host.listRuntimeAccounts();
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.accounts[0].storage.bytes, 4_096);
  assert.equal(JSON.stringify(snapshot).includes("/Users/"), false);
  assert.equal(JSON.stringify(snapshot).includes("runtimeProfileId"), false);
  assert.equal(JSON.stringify(snapshot).includes("providerRef"), false);

  assert.deepEqual(Object.keys(snapshot), ["accounts"]);
  for (const method of ["prepareLegacyRuntimeHomeCleanup", "commitLegacyRuntimeHomeCleanup", "listRuntimeBackups", "prepareRuntimeBackupCleanup", "commitRuntimeBackupCleanup"]) assert.equal(host[method], undefined);
  await assert.rejects(host.readRuntimeAccountStorage({ runtimeAccountId: ACCOUNT_ID, path: "/tmp/forged" }), { code: "HOST_RUNTIME_ACCOUNT_PARAMS_INVALID" });

  const mismatchedHost = createProductHostController({
    serviceRequest: async (method) => {
      if (method === "runtime.account.list") {
        return { accounts: [account()], nextCursor: null, hasMore: false };
      }
      if (method === "runtime.account.legacyHomes.list") {
        return { homes: [], nextCursor: null, hasMore: false };
      }
      if (method === "runtime.account.backups.list") {
        return { backups: [], nextCursor: null, hasMore: false };
      }
      if (method === "runtime.account.storage.read") {
        return {
          runtimeAccountId: "native-pi-default-v1",
          scope: "native-system",
          available: false,
          bytes: 0,
          files: 0,
          dirs: 0,
          symlinks: 0,
          incomplete: false,
          limitReason: null,
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
    launchAgent: { status: async () => ({ supported: false, reason: "unsupported-platform" }) },
  });
  await assert.rejects(
    mismatchedHost.listRuntimeAccounts(),
    { code: "HOST_RUNTIME_ACCOUNT_RESPONSE_INVALID" },
  );

  let activeScans = 0;
  const queuedHost = createProductHostController({
    serviceRequest: async (method, params) => {
      if (method === "runtime.account.list") return {
        accounts: [account(), { ...account(), id: "native-pi-default-v1", runtime: "pi" }],
        nextCursor: null, hasMore: false,
      };
      if (method === "runtime.account.storage.read") {
        assert.equal(activeScans, 0, "storage requests must not queue behind another synchronous scan");
        activeScans += 1;
        await new Promise((resolve) => setImmediate(resolve));
        activeScans -= 1;
        return { ...(await serviceRequest(method, params)), runtimeAccountId: params.runtimeAccountId };
      }
      return serviceRequest(method, params);
    },
    launchAgent: { status: async () => ({ supported: false, reason: "unsupported-platform" }) },
  });
  const queued = await queuedHost.listRuntimeAccounts();
  assert.equal(queued.accounts.length, 2);

  process.stdout.write("PASS RuntimeAccount product host current DTO, retired API absence and bounded sequential scans\n");
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
