#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PRE_RUNTIME_SCHEMA_BACKUP_ID } = require("../app/agent-service/runtime-schema-migration");
const {
  RuntimeBackupStore,
  backupEntryId,
} = require("../app/agent-service/runtime-backup-store");
const { RuntimeBackupCleanup } = require("../app/agent-service/runtime-backup-cleanup");

const NOW = 2_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-backups-")));
  const stateDir = path.join(root, "state");
  const backupsDir = path.join(stateDir, "backups");
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const paths = {
    trustedRoot: root,
    stateDir,
    backupsDir,
    backupCleanupAuditPath: path.join(backupsDir, ".cleanup-audit.jsonl"),
  };
  const makeBackup = (name, bytes = 16, mtime = NOW) => {
    const target = path.join(backupsDir, name);
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(path.join(target, "payload.bin"), Buffer.alloc(bytes));
    const seconds = mtime / 1_000;
    fs.utimesSync(target, seconds, seconds);
    return target;
  };
  return { root, stateDir, backupsDir, paths, makeBackup };
}

function cleanupFixture(value) {
  fs.rmSync(value.root, { recursive: true, force: true });
}

test("inventory classifies known history, retains current/unknown, and lists direct directories only", () => {
  const value = fixture();
  try {
    const expected = new Map([
      ["pre-native-runtime-import-v1", ["native-runtime-import", "reclaimable"]],
      ["pre-runtime-schema-v5", ["runtime-schema-history", "reclaimable"]],
      ["pre-runtime-schema-v6", ["runtime-schema-history", "reclaimable"]],
      ["pre-runtime-schema-v7", ["runtime-schema-history", "reclaimable"]],
      [PRE_RUNTIME_SCHEMA_BACKUP_ID, ["runtime-schema-current", "retained"]],
      ["pre-native-capabilities-20260826", ["native-capabilities", "reclaimable"]],
      ["pre-shoggoth-memory-v1", ["memory-migration", "reclaimable"]],
      ["permission-policy-all-native-20260902", ["permission-policy", "reclaimable"]],
      ["upgrade-generation-1", ["unknown", "retained"]],
      ["pre-runtime-schema-v999", ["unknown", "retained"]],
      [".staging-pre-native-runtime-import-v1-old", ["staging", "reclaimable"]],
      [".staging-pre-native-runtime-import-v1-recent", ["staging", "retained"]],
    ]);
    for (const name of expected.keys()) {
      const mtime = name.endsWith("-old") ? NOW - DAY_MS - 1 : NOW;
      value.makeBackup(name, 16, mtime);
    }
    fs.mkdirSync(path.join(value.backupsDir, "upgrade-generation-1", "nested"), { mode: 0o700 });
    fs.writeFileSync(path.join(value.backupsDir, ".DS_Store"), "ignored");
    fs.symlinkSync(
      path.join(value.backupsDir, "pre-runtime-schema-v5"),
      path.join(value.backupsDir, "pre-runtime-schema-v4"),
    );

    const manifest = new RuntimeBackupStore({ paths: value.paths, now: () => NOW }).refresh();
    assert.equal(manifest.entries.length, expected.size);
    for (const entry of manifest.entries) {
      assert.deepEqual([entry.category, entry.role], expected.get(entry.backupName));
      assert.equal(entry.path, path.join(value.backupsDir, entry.backupName));
      assert.equal(entry.id, backupEntryId(value.backupsDir, entry.backupName));
      assert.equal(entry.stats.incomplete, false);
    }
    assert.equal(manifest.entries.some((entry) => entry.backupName === "pre-runtime-schema-v4"), false);
    assert.equal(manifest.entries.some((entry) => entry.backupName === "nested"), false);
  } finally {
    cleanupFixture(value);
  }
});

test("inventory is read-only, bounded, and rejects a non-canonical backup root", () => {
  const value = fixture();
  try {
    value.makeBackup("pre-runtime-schema-v6");
    fs.writeFileSync(path.join(value.backupsDir, "metadata-1"), "1");
    assert.throws(
      () => new RuntimeBackupStore({
        paths: value.paths,
        now: () => NOW,
        maxDirectories: 1,
      }).refresh(),
      { code: "RUNTIME_BACKUP_INVENTORY_LIMIT" },
    );
    const alias = path.join(value.stateDir, "backup-alias");
    fs.symlinkSync(value.backupsDir, alias);
    assert.throws(
      () => new RuntimeBackupStore({
        paths: { ...value.paths, backupsDir: alias },
        now: () => NOW,
      }).refresh(),
      { code: "RUNTIME_STORAGE_ROOT_INVALID" },
    );
  } finally {
    cleanupFixture(value);
  }
});

function cleaner(value, overrides = {}) {
  const store = overrides.store || new RuntimeBackupStore({
    paths: value.paths,
    now: () => NOW,
  });
  return new RuntimeBackupCleanup({
    paths: value.paths,
    inventory: () => store.refresh(),
    readCleanupState: overrides.readCleanupState
      || (async () => ({ serviceReady: true, cleanupEligible: true })),
    isInUse: overrides.isInUse || (async () => false),
    now: overrides.now || (() => NOW),
    randomBytes: overrides.randomBytes,
    planTtlMs: overrides.planTtlMs,
  });
}

test("cleanup is gated by Service readiness and migration cleanup eligibility", async () => {
  const value = fixture();
  try {
    value.makeBackup("pre-native-runtime-import-v1", 32);
    const entryId = backupEntryId(value.backupsDir, "pre-native-runtime-import-v1");
    for (const state of [
      { serviceReady: false, cleanupEligible: true },
      { serviceReady: true, cleanupEligible: false },
    ]) {
      await assert.rejects(
        cleaner(value, { readCleanupState: async () => state }).prepare({ entryId }),
        { code: "RUNTIME_BACKUP_CLEANUP_NOT_READY" },
      );
      assert.equal(fs.existsSync(path.join(value.backupsDir, "pre-native-runtime-import-v1")), true);
    }
  } finally {
    cleanupFixture(value);
  }
});

test("retained, in-use, and incomplete candidates fail closed", async () => {
  const value = fixture();
  try {
    value.makeBackup(PRE_RUNTIME_SCHEMA_BACKUP_ID, 8);
    value.makeBackup("upgrade-unknown", 8);
    value.makeBackup("pre-runtime-schema-v6", 8);
    const cleanup = cleaner(value);
    for (const name of [PRE_RUNTIME_SCHEMA_BACKUP_ID, "upgrade-unknown"]) {
      await assert.rejects(
        cleanup.prepare({ entryId: backupEntryId(value.backupsDir, name) }),
        { code: "RUNTIME_BACKUP_CANDIDATE_NOT_RECLAIMABLE" },
      );
    }
    await assert.rejects(
      cleaner(value, { isInUse: async () => ({ backupActive: true }) }).prepare({
        entryId: backupEntryId(value.backupsDir, "pre-runtime-schema-v6"),
      }),
      { code: "RUNTIME_BACKUP_CANDIDATE_IN_USE" },
    );
    const boundedStore = new RuntimeBackupStore({
      paths: value.paths,
      now: () => NOW,
      scanLimits: { maxEntries: 1 },
    });
    await assert.rejects(
      cleaner(value, { store: boundedStore }).prepare({
        entryId: backupEntryId(value.backupsDir, "pre-runtime-schema-v6"),
      }),
      { code: "RUNTIME_BACKUP_CANDIDATE_NOT_RECLAIMABLE" },
    );
  } finally {
    cleanupFixture(value);
  }
});

test("prepare and one-shot commit revalidate then audit an opaque deletion", async () => {
  const value = fixture();
  try {
    const target = value.makeBackup("pre-native-capabilities-20260826", 128);
    fs.symlinkSync(path.join(value.stateDir, "outside"), path.join(target, "ignored-link"));
    const cleanup = cleaner(value, { randomBytes: () => Buffer.alloc(32, 7) });
    const entryId = backupEntryId(value.backupsDir, "pre-native-capabilities-20260826");
    const plan = await cleanup.prepare({ entryId });
    assert.deepEqual(Object.keys(plan), [
      "planId", "entryId", "category", "bytes", "files", "dirs", "symlinks", "expiresAt",
    ]);
    assert.equal(plan.planId, Buffer.alloc(32, 7).toString("hex"));
    assert.equal(plan.bytes, 128 + Buffer.byteLength(path.join(value.stateDir, "outside")));
    assert.equal(plan.symlinks, 1);
    assert.equal(JSON.stringify(plan).includes(value.root), false);
    const result = await cleanup.commit({ planId: plan.planId });
    assert.equal(result.entryId, entryId);
    assert.equal(result.bytesReleased, plan.bytes);
    assert.equal(fs.existsSync(target), false);
    await assert.rejects(
      cleanup.commit({ planId: plan.planId }),
      { code: "RUNTIME_BACKUP_PLAN_NOT_FOUND" },
    );
    const audit = fs.readFileSync(value.paths.backupCleanupAuditPath, "utf8");
    assert.match(audit, /"status":"deleted"/u);
    assert.equal(audit.includes(value.root), false);
    assert.equal(audit.includes("pre-native-capabilities-20260826"), false);
    assert.equal(fs.statSync(value.paths.backupCleanupAuditPath).mode & 0o077, 0);
  } finally {
    cleanupFixture(value);
  }
});

test("commit rejects content, identity, and migration-state changes without deletion", async () => {
  const value = fixture();
  try {
    const target = value.makeBackup("pre-runtime-schema-v6", 64);
    let state = { serviceReady: true, cleanupEligible: true };
    const cleanup = cleaner(value, { readCleanupState: async () => state });
    let entryId = backupEntryId(value.backupsDir, "pre-runtime-schema-v6");
    let plan = await cleanup.prepare({ entryId });
    fs.appendFileSync(path.join(target, "payload.bin"), Buffer.alloc(1));
    await assert.rejects(
      cleanup.commit({ planId: plan.planId }),
      { code: "RUNTIME_BACKUP_CANDIDATE_CHANGED" },
    );
    assert.equal(fs.existsSync(target), true);

    fs.rmSync(target, { recursive: true });
    value.makeBackup("pre-runtime-schema-v6", 64);
    plan = await cleanup.prepare({ entryId });
    state = { serviceReady: true, cleanupEligible: false };
    await assert.rejects(
      cleanup.commit({ planId: plan.planId }),
      { code: "RUNTIME_BACKUP_CLEANUP_NOT_READY" },
    );
    assert.equal(fs.existsSync(target), true);

    state = { serviceReady: true, cleanupEligible: true };
    plan = await cleanup.prepare({ entryId });
    const replacement = path.join(value.stateDir, "replacement");
    fs.renameSync(target, replacement);
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(path.join(target, "payload.bin"), Buffer.alloc(64));
    await assert.rejects(
      cleanup.commit({ planId: plan.planId }),
      { code: "RUNTIME_BACKUP_CANDIDATE_CHANGED" },
    );
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(replacement), true);
  } finally {
    cleanupFixture(value);
  }
});

test("expired plans are consumed and never delete the target", async () => {
  const value = fixture();
  let clock = NOW;
  try {
    const target = value.makeBackup("pre-shoggoth-memory-v1", 32);
    const store = new RuntimeBackupStore({ paths: value.paths, now: () => clock });
    const cleanup = cleaner(value, {
      store,
      now: () => clock,
      planTtlMs: 10,
    });
    const plan = await cleanup.prepare({
      entryId: backupEntryId(value.backupsDir, "pre-shoggoth-memory-v1"),
    });
    clock += 10;
    await assert.rejects(
      cleanup.commit({ planId: plan.planId }),
      { code: "RUNTIME_BACKUP_PLAN_EXPIRED" },
    );
    assert.equal(fs.existsSync(target), true);
  } finally {
    cleanupFixture(value);
  }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${name}\n${error?.stack || error}\n`);
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${passed}/${tests.length} passed\n`);
})();
