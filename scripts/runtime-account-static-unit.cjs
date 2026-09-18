#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { startStaticServer } = require("../app/static-server");

const ENTRY_ID = `legacy-home-${"d".repeat(64)}-v1`;
const PLAN_ID = "e".repeat(64);
const BACKUP_ENTRY_ID = `runtime-backup-${"f".repeat(64)}-v1`;
const BACKUP_PLAN_ID = "a".repeat(64);

async function request(base, target, options = {}) {
  const response = await fetch(`${base}${target}`, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: response.status, body, text };
}

(async () => {
  const calls = [];
  const snapshot = {
    accounts: [{
      id: "native-grok-build-default-v1",
      runtime: "grok-build",
      kind: "native-user",
      installationKind: "system",
      homeKind: "system-default",
      isDefault: true,
      sharedAgentCount: 2,
      admission: {
        generation: 1, active: 0, maxActive: 1, mutationActive: false, backoffUntil: null,
      },
      storage: {
        runtimeAccountId: "native-grok-build-default-v1",
        scope: "native-system",
        available: true,
        bytes: 1024,
        files: 1,
        dirs: 1,
        symlinks: 0,
        incomplete: false,
        limitReason: null,
      },
      legacyHomes: [],
    }],
    backups: [],
    legacyReclaimableBytes: 1024,
    backupReclaimableBytes: 0,
  };
  const productHost = {
    listRuntimeAccounts: async () => snapshot,
    listLegacyRuntimeHomes: async (input) => {
      calls.push(["legacy.list", input]);
      return { homes: [] };
    },
    listRuntimeBackups: async () => {
      calls.push(["backups.list", {}]);
      return {
        backups: [{
          id: BACKUP_ENTRY_ID,
          category: "native-runtime-import",
          role: "reclaimable",
          bytes: 2_048,
          files: 2,
          dirs: 1,
          symlinks: 0,
          incomplete: false,
          lastModifiedAt: 900,
        }],
      };
    },
    readRuntimeAccount: async (input) => {
      calls.push(["account.read", input]);
      return { account: snapshot.accounts[0], storage: snapshot.accounts[0].storage, legacyHomes: [] };
    },
    readRuntimeAccountAuth: async (input) => {
      calls.push(["auth.read", input]);
      return { account: null, requiresOpenaiAuth: true, login: null };
    },
    readRuntimeAccountStorage: async (input) => {
      calls.push(["storage.read", input]);
      return snapshot.accounts[0].storage;
    },
    startRuntimeAccountLogin: async (input) => {
      calls.push(["login.start", input]);
      return { requestId: "request-1", mode: "browser", status: "waiting", loginId: "login-1", authUrl: "https://example.test/login" };
    },
    cancelRuntimeAccountLogin: async (input) => {
      calls.push(["login.cancel", input]);
      return { requestId: input.requestId, status: "canceled" };
    },
    logoutRuntimeAccount: async (input) => {
      calls.push(["logout", input]);
      return { loggedOut: true };
    },
    prepareLegacyRuntimeHomeCleanup: async (input) => {
      calls.push(["cleanup.prepare", input]);
      return {
        planId: PLAN_ID,
        entryId: input.entryId,
        runtime: "grok-build",
        runtimeAccountId: "native-grok-build-default-v1",
        affectedAgentCount: 2,
        bytes: 1024,
        files: 1,
        dirs: 1,
        symlinks: 0,
        expiresAt: 2_000,
      };
    },
    commitLegacyRuntimeHomeCleanup: async (input) => {
      calls.push(["cleanup.commit", input]);
      return {
        entryId: ENTRY_ID,
        runtime: "grok-build",
        runtimeAccountId: "native-grok-build-default-v1",
        bytesReleased: 1024,
        filesRemoved: 1,
        dirsRemoved: 1,
        symlinksRemoved: 0,
        deletedAt: 1_500,
      };
    },
    prepareRuntimeBackupCleanup: async (input) => {
      calls.push(["backup.cleanup.prepare", input]);
      return {
        planId: BACKUP_PLAN_ID,
        entryId: input.entryId,
        category: "native-runtime-import",
        bytes: 2_048,
        files: 2,
        dirs: 1,
        symlinks: 0,
        expiresAt: 2_000,
      };
    },
    commitRuntimeBackupCleanup: async (input) => {
      calls.push(["backup.cleanup.commit", input]);
      return {
        entryId: BACKUP_ENTRY_ID,
        category: "native-runtime-import",
        bytesReleased: 2_048,
        filesRemoved: 2,
        dirsRemoved: 1,
        symlinksRemoved: 0,
        deletedAt: 1_500,
      };
    },
  };
  const registry = {
    backends: new Map(),
    getBackend: () => null,
    listBackendDescriptors: () => [],
  };
  const server = await startStaticServer(0, { registry, productHost });
  try {
    const headers = { Origin: server.url, "Content-Type": "application/json" };
    let result = await request(server.url, "/__api/shoggoth/runtime-accounts", { headers });
    assert.equal(result.status, 200);
    assert.equal(result.body.accounts[0].runtime, "grok-build");
    assert.equal(result.text.includes("/Users/"), false);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/native-grok-build-default-v1/auth",
      { headers },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), [
      "auth.read", { runtimeAccountId: "native-grok-build-default-v1" },
    ]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/native-grok-build-default-v1",
      { headers },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), [
      "account.read", { runtimeAccountId: "native-grok-build-default-v1" },
    ]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/native-grok-build-default-v1/storage",
      { headers },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), [
      "storage.read", { runtimeAccountId: "native-grok-build-default-v1" },
    ]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/legacy-homes",
      { headers },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), ["legacy.list", { runtimeAccountId: null }]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/backups",
      { headers },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.backups[0].id, BACKUP_ENTRY_ID);
    assert.deepEqual(calls.at(-1), ["backups.list", {}]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/native-grok-build-default-v1/login",
      { method: "POST", headers, body: JSON.stringify({ mode: "browser" }) },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), [
      "login.start",
      { runtimeAccountId: "native-grok-build-default-v1", mode: "browser" },
    ]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/native-grok-build-default-v1/login/cancel",
      { method: "POST", headers, body: JSON.stringify({ requestId: "request-1" }) },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), [
      "login.cancel",
      { runtimeAccountId: "native-grok-build-default-v1", requestId: "request-1" },
    ]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/native-grok-build-default-v1/logout",
      { method: "POST", headers, body: JSON.stringify({}) },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), [
      "logout", { runtimeAccountId: "native-grok-build-default-v1" },
    ]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/legacy-homes/cleanup/prepare",
      { method: "POST", headers, body: JSON.stringify({ entryId: ENTRY_ID }) },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.planId, PLAN_ID);
    assert.deepEqual(calls.at(-1), ["cleanup.prepare", { entryId: ENTRY_ID }]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/legacy-homes/cleanup/commit",
      { method: "POST", headers, body: JSON.stringify({ planId: PLAN_ID }) },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), ["cleanup.commit", { planId: PLAN_ID }]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/backups/cleanup/prepare",
      { method: "POST", headers, body: JSON.stringify({ entryId: BACKUP_ENTRY_ID }) },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.planId, BACKUP_PLAN_ID);
    assert.deepEqual(calls.at(-1), [
      "backup.cleanup.prepare",
      { entryId: BACKUP_ENTRY_ID },
    ]);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/backups/cleanup/commit",
      { method: "POST", headers, body: JSON.stringify({ planId: BACKUP_PLAN_ID }) },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), [
      "backup.cleanup.commit",
      { planId: BACKUP_PLAN_ID },
    ]);

    const before = calls.length;
    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/legacy-homes/cleanup/commit",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ planId: PLAN_ID, path: "/tmp/forged" }),
      },
    );
    assert.equal(result.status, 409);
    assert.equal(calls.length, before, "raw path body never reaches the product host");
    assert.equal(result.text.includes("/tmp/forged"), false);

    const beforeBackupForgery = calls.length;
    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/backups/cleanup/prepare",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ entryId: BACKUP_ENTRY_ID, path: "/tmp/forged-backup" }),
      },
    );
    assert.equal(result.status, 409);
    assert.equal(calls.length, beforeBackupForgery,
      "raw backup path body never reaches the product host");
    assert.equal(result.text.includes("/tmp/forged-backup"), false);

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/legacy-homes/cleanup/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId: ENTRY_ID }),
      },
    );
    assert.equal(result.status, 403, "cleanup requires a browser loopback Origin");

    result = await request(
      server.url,
      "/__api/shoggoth/runtime-accounts/backups/cleanup/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId: BACKUP_ENTRY_ID }),
      },
    );
    assert.equal(result.status, 403, "backup cleanup requires a browser loopback Origin");

    process.stdout.write("PASS RuntimeAccount static routes + CSRF + opaque cleanup\n");
  } finally {
    await server.close();
  }
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
