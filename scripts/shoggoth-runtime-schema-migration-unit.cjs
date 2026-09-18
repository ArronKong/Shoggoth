#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { CHAT_SESSION_STORE_VERSION, ChatSessionStore } = require(path.join(
  ROOT, "app", "agent-service", "chat-session-store.js",
));
const {
  DEFAULT_AGENT_PROFILE_ID,
  JsonlProductStore,
  STORE_SCHEMA_VERSION,
  snapshotChecksum,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { resolveServicePaths } = require(path.join(
  ROOT, "app", "agent-service", "paths.js",
));
const {
  RUNTIME_SCHEMA_METADATA_BACKUP_SCHEMA_VERSION,
  RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE,
  RUNTIME_SCHEMA_METADATA_FILES,
  createAuthorityBackup,
  createRuntimeSchemaMetadataBackup,
  restoreAuthorityBackup,
  verifyAuthorityBackup,
  verifyRuntimeSchemaMetadataBackup,
} = require(path.join(ROOT, "app", "agent-service", "authority-backup.js"));
const {
  PRE_RUNTIME_SCHEMA_BACKUP_ID,
  ensureRuntimeSchemaMigrationBackup,
  needsRuntimeSchemaMigration,
} = require(path.join(ROOT, "app", "agent-service", "runtime-schema-migration.js"));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-migration-"));
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  return { root, paths };
}

let fixtureWriterLeaseSequence = 0;
function acquireFixtureWriterLease({ lockPath }) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const candidatePath = `${lockPath}.fixture-${++fixtureWriterLeaseSequence}`;
  fs.writeFileSync(candidatePath, "fixture-writer\n", { flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(candidatePath, lockPath);
  } catch (error) {
    fs.unlinkSync(candidatePath);
    if (error?.code === "EEXIST") {
      const held = new Error("fixture writer lease held");
      held.code = "WRITER_LEASE_HELD";
      throw held;
    }
    throw error;
  }
  let released = false;
  return {
    lockPath,
    release() {
      if (released) return false;
      fs.unlinkSync(lockPath);
      fs.unlinkSync(candidatePath);
      released = true;
      return true;
    },
  };
}

function ensureFixtureRuntimeSchemaMigrationBackup(options) {
  return ensureRuntimeSchemaMigrationBackup({
    ...options,
    acquireWriterLease: acquireFixtureWriterLease,
  });
}

function createFixtureRuntimeSchemaMetadataBackup(options) {
  return createRuntimeSchemaMetadataBackup({
    ...options,
    acquireWriterLease: acquireFixtureWriterLease,
  });
}

function verifyFixtureRuntimeSchemaMetadataBackup(options) {
  return verifyRuntimeSchemaMetadataBackup({
    ...options,
    acquireWriterLease: acquireFixtureWriterLease,
  });
}

function assertRejectsLstatSwap(target, swap, verify) {
  const originalLstatSync = fs.lstatSync;
  const resolvedTarget = path.resolve(target);
  let swapped = false;
  fs.lstatSync = (candidate, ...args) => {
    const stat = originalLstatSync(candidate, ...args);
    if (!swapped && typeof candidate === "string"
      && path.resolve(candidate) === resolvedTarget) {
      swapped = true;
      swap();
    }
    return stat;
  };
  try {
    assert.throws(verify, (error) => error.code === "BACKUP_CORRUPT");
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(swapped, true);
}

function replaceDirectoryWithSymlink(target, movedTarget) {
  fs.renameSync(target, movedTarget);
  fs.symlinkSync(
    movedTarget,
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function seedLegacySchemas(paths) {
  const product = new JsonlProductStore({ paths, now: () => 100 });
  product.open();
  const profile = product.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const baseRun = {
    id: "legacy-run",
    source: "chat",
    sourceId: "legacy-session",
    idempotencyKey: "legacy-run-key",
    profileId: profile.id,
    workspace: null,
    status: "queued",
    runtimeSessionRef: null,
    runtimeTurnRef: null,
    eventSeq: 1,
    waitingRequestId: null,
    startedAt: null,
    finishedAt: null,
    resultSummary: null,
    errorCode: null,
    retryOf: null,
  };
  product.putWorkRun(baseRun);
  product.putWorkRun({
    ...baseRun,
    status: "running",
    runtimeSessionRef: {
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
      sessionId: "legacy-thread",
    },
    runtimeTurnRef: {
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
      sessionId: "legacy-thread",
      turnId: "legacy-turn",
    },
    eventSeq: 2,
    startedAt: 100,
  });
  product.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  snapshot.schemaVersion = 3;
  delete snapshot.runtimeAccounts;
  delete snapshot.runtimeAccountTombstones;
  snapshot.agentProfiles = snapshot.agentProfiles.map(({
    runtimeAccountId: _runtimeAccountId,
    ...profile
  }) => profile);
  snapshot.workRuns = snapshot.workRuns.map(({
    contextSnapshotId: _contextSnapshotId,
    runtimeSessionRef: sessionRef,
    runtimeTurnRef: turnRef,
    ...run
  }) => ({
    ...run,
    codexThreadId: sessionRef?.sessionId ?? null,
    codexTurnId: turnRef?.turnId ?? null,
  }));
  snapshot.checksum = snapshotChecksum(snapshot);
  fs.writeFileSync(paths.stateSnapshotPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });

  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const sessions = new ChatSessionStore({
    paths,
    now: () => 100,
    randomUUID: () => ids.shift(),
    acquireWriterLease: acquireFixtureWriterLease,
  });
  sessions.open();
  sessions.createSession({
    operationId: "legacy-create",
    profileId: "profile-legacy",
    workspace: null,
    createdAt: 100,
  });
  sessions.close();
  const chatPath = path.join(paths.stateDir, "chat-sessions.json");
  const chat = JSON.parse(fs.readFileSync(chatPath, "utf8"));
  chat.version = 2;
  for (const session of Object.values(chat.sessions)) {
    session.codexThreadId = session.runtimeSessionId;
    delete session.runtimeSessionId;
    delete session.permissionMode;
  }
  fs.writeFileSync(chatPath, `${JSON.stringify(chat)}\n`, { mode: 0o600 });
  return chatPath;
}

function acquireFixtureServiceLock(paths) {
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.lockPath, "owned-lock\n", { mode: 0o600 });
  const stat = fs.lstatSync(paths.lockPath);
  return { dev: stat.dev, ino: stat.ino };
}

function seedGenericRuntimeV4(paths) {
  const product = new JsonlProductStore({ paths, now: () => 300 });
  product.open();
  const profile = product.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  product.putWorkRun({
    id: "generic-v4-run",
    source: "cron",
    sourceId: "cron-v4",
    idempotencyKey: "generic-v4-key",
    profileId: profile.id,
    workspace: null,
    status: "queued",
    runtimeSessionRef: null,
    runtimeTurnRef: null,
    eventSeq: 1,
    waitingRequestId: null,
    startedAt: null,
    finishedAt: null,
    resultSummary: null,
    errorCode: null,
    retryOf: null,
  });
  product.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  snapshot.schemaVersion = 4;
  delete snapshot.runtimeAccounts;
  delete snapshot.runtimeAccountTombstones;
  snapshot.agentProfiles = snapshot.agentProfiles.map(({
    runtimeAccountId: _runtimeAccountId,
    ...profile
  }) => profile);
  snapshot.workRuns = snapshot.workRuns.map(({ contextSnapshotId: _contextSnapshotId, ...run }) => run);
  snapshot.checksum = snapshotChecksum(snapshot);
  fs.writeFileSync(paths.stateSnapshotPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

function run() {
  assert.equal(PRE_RUNTIME_SCHEMA_BACKUP_ID, `pre-runtime-schema-v${STORE_SCHEMA_VERSION}`);
  const { root, paths } = fixture();
  const chatPath = seedLegacySchemas(paths);
  const runtimeSentinel = path.join(paths.stateDir, "codex", "profile-large", "auth-cache.bin");
  fs.mkdirSync(path.dirname(runtimeSentinel), { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtimeSentinel, Buffer.alloc(4 * 1024 * 1024, 0x5a), { mode: 0o600 });
  const metadataBeforeBackup = Object.fromEntries(RUNTIME_SCHEMA_METADATA_FILES.map((name) => [
    name,
    fs.readFileSync(path.join(paths.stateDir, name)),
  ]));
  const activeServiceLock = acquireFixtureServiceLock(paths);
  assert.equal(needsRuntimeSchemaMigration(paths), true);
  const backup = ensureFixtureRuntimeSchemaMigrationBackup({
    paths,
    activeServiceLock,
    now: () => 200,
  });
  assert.equal(path.basename(backup.backupPath), PRE_RUNTIME_SCHEMA_BACKUP_ID);
  assert.equal(backup.manifest.schemaVersion, RUNTIME_SCHEMA_METADATA_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.manifest.scope, RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE);
  const backupRoot = path.join(backup.backupPath, "payload");
  assert.deepEqual(
    backup.manifest.entries.map((entry) => entry.path),
    RUNTIME_SCHEMA_METADATA_FILES,
  );
  assert.equal(backup.manifest.entries.every((entry) => entry.type === "file"), true);
  assert.equal(fs.existsSync(path.join(backupRoot, "codex")), false);
  assert.equal(backup.manifest.entries.some((entry) => entry.path.includes("auth-cache.bin")), false);
  for (const [name, expected] of Object.entries(metadataBeforeBackup)) {
    assert.deepEqual(fs.readFileSync(path.join(backupRoot, name)), expected);
    assert.deepEqual(fs.readFileSync(path.join(paths.stateDir, name)), expected);
  }
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(backupRoot, "state.snapshot.json"), "utf8",
  )).schemaVersion, 3);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(backupRoot, "chat-sessions.json"), "utf8",
  )).version, 2);
  assert.deepEqual(
    verifyFixtureRuntimeSchemaMetadataBackup({
      paths,
      backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
      activeServiceLock,
    }).manifest,
    backup.manifest,
  );
  assert.deepEqual(
    ensureFixtureRuntimeSchemaMigrationBackup({ paths, activeServiceLock }).manifest,
    backup.manifest,
  );
  assert.throws(
    () => verifyAuthorityBackup({ paths, backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID }),
    (error) => error.code === "BACKUP_SCOPE_MISMATCH",
  );
  const restoredStateDir = path.join(root, "restored-runtime-schema-metadata");
  assert.throws(
    () => restoreAuthorityBackup({
      paths,
      backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
      destinationStateDir: restoredStateDir,
    }),
    (error) => error.code === "BACKUP_SCOPE_MISMATCH",
  );
  assert.equal(fs.existsSync(restoredStateDir), false);

  const product = new JsonlProductStore({ paths, now: () => 201 });
  product.open();
  assert.equal(product.getWorkRun("legacy-run").runtimeSessionRef.sessionId, "legacy-thread");
  product.recoverActiveRunAfterServiceRestart("legacy-run");
  product.close();
  const sessions = new ChatSessionStore({
    paths,
    now: () => 201,
    acquireWriterLease: acquireFixtureWriterLease,
  });
  sessions.open();
  const session = sessions.listSessions()[0];
  sessions.setModelOverride(session.sessionKey, "gpt-migration-test");
  sessions.close();
  assert.equal(
    JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8")).schemaVersion,
    STORE_SCHEMA_VERSION,
  );
  assert.equal(JSON.stringify(JSON.parse(
    fs.readFileSync(paths.stateSnapshotPath, "utf8"),
  )).includes("codexThreadId"), false);
  assert.equal(JSON.parse(fs.readFileSync(chatPath, "utf8")).version, CHAT_SESSION_STORE_VERSION);
  assert.equal(needsRuntimeSchemaMigration(paths), false);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(backupRoot, "state.snapshot.json"), "utf8",
  )).schemaVersion, 3, "迁移后不得改写回滚备份");
  console.log("PASS Runtime schema metadata 备份使用独立 scope，不含 Runtime Home 且不可当作全量恢复");

  const second = fixture();
  seedLegacySchemas(second.paths);
  const secondLock = acquireFixtureServiceLock(second.paths);
  assert.throws(
    () => ensureFixtureRuntimeSchemaMigrationBackup({
      paths: second.paths,
      activeServiceLock: { ...secondLock, ino: secondLock.ino + 1 },
    }),
    (error) => error.code === "BACKUP_SERVICE_ACTIVE",
  );
  assert.equal(needsRuntimeSchemaMigration(second.paths), true);
  const missingLock = fixture();
  seedLegacySchemas(missingLock.paths);
  assert.throws(
    () => ensureFixtureRuntimeSchemaMigrationBackup({
      paths: missingLock.paths,
      activeServiceLock: { dev: 1, ino: 1 },
    }),
    (error) => error.code === "BACKUP_SERVICE_ACTIVE",
  );
  const changedLock = fixture();
  seedLegacySchemas(changedLock.paths);
  const changedLockIdentity = acquireFixtureServiceLock(changedLock.paths);
  assert.throws(
    () => ensureFixtureRuntimeSchemaMigrationBackup({
      paths: changedLock.paths,
      activeServiceLock: changedLockIdentity,
      now: () => {
        fs.unlinkSync(changedLock.paths.lockPath);
        return 225;
      },
    }),
    (error) => error.code === "BACKUP_SERVICE_ACTIVE",
  );
  assert.equal(fs.existsSync(path.join(
    changedLock.paths.backupsDir, PRE_RUNTIME_SCHEMA_BACKUP_ID,
  )), false);
  console.log("PASS Runtime schema 备份在创建/复用前后都要求精确 Service lock inode");

  const legacyFull = fixture();
  seedLegacySchemas(legacyFull.paths);
  const legacyRuntimeFile = path.join(
    legacyFull.paths.stateDir, "codex", "profile-old", "sessions", "thread.jsonl",
  );
  fs.mkdirSync(path.dirname(legacyRuntimeFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(legacyRuntimeFile, "legacy runtime authority\n", { mode: 0o600 });
  const existing = createAuthorityBackup({
    paths: legacyFull.paths,
    backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
    now: () => 250,
  });
  const legacyFullLock = acquireFixtureServiceLock(legacyFull.paths);
  assert.throws(
    () => ensureFixtureRuntimeSchemaMigrationBackup({
      paths: legacyFull.paths,
      activeServiceLock: legacyFullLock,
      now: () => 251,
    }),
    (error) => error.code === "BACKUP_SCOPE_MISMATCH",
  );
  assert.equal(existing.manifest.entries.some(
    (entry) => entry.path === "codex/profile-old/sessions/thread.jsonl",
  ), false);
  assert.deepEqual(
    fs.readdirSync(legacyFull.paths.backupsDir),
    [PRE_RUNTIME_SCHEMA_BACKUP_ID],
  );
  console.log("PASS 同名 scope-less 最小 authority 备份 fail closed，不会被当作 metadata 备份");

  const interrupted = fixture();
  fs.mkdirSync(interrupted.paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(interrupted.paths.stateDir, "chat-sessions.json"),
    `${JSON.stringify({ version: 2 })}\n`,
    { mode: 0o600 },
  );
  const interruptedLock = acquireFixtureServiceLock(interrupted.paths);
  const interruptedBackup = ensureFixtureRuntimeSchemaMigrationBackup({
    paths: interrupted.paths,
    activeServiceLock: interruptedLock,
    now: () => 275,
  });
  assert.deepEqual(
    interruptedBackup.manifest.entries.map((entry) => entry.path),
    ["chat-sessions.json"],
  );
  const sealedChat = fs.readFileSync(path.join(
    interruptedBackup.backupPath, "payload", "chat-sessions.json",
  ));
  const interruptedProduct = new JsonlProductStore({ paths: interrupted.paths, now: () => 276 });
  interruptedProduct.open();
  interruptedProduct.close();
  assert.equal(fs.existsSync(interrupted.paths.stateSnapshotPath), true);
  assert.equal(fs.existsSync(interrupted.paths.eventLogPath), true);
  assert.deepEqual(
    ensureFixtureRuntimeSchemaMigrationBackup({
      paths: interrupted.paths,
      activeServiceLock: interruptedLock,
    }).manifest,
    interruptedBackup.manifest,
  );
  assert.deepEqual(fs.readFileSync(path.join(
    interruptedBackup.backupPath, "payload", "chat-sessions.json",
  )), sealedChat);
  console.log("PASS 中断启动新增 metadata 后可复用已封存备份且不改写 payload");

  const currentSchemaDrift = fixture();
  const driftProduct = new JsonlProductStore({ paths: currentSchemaDrift.paths, now: () => 277 });
  driftProduct.open();
  driftProduct.close();
  const driftIds = [
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
  ];
  const driftChat = new ChatSessionStore({
    paths: currentSchemaDrift.paths,
    now: () => 277,
    randomUUID: () => driftIds.shift(),
    acquireWriterLease: acquireFixtureWriterLease,
  });
  driftChat.open();
  driftChat.createSession({
    operationId: "current-chat-generation",
    profileId: "current-profile",
    workspace: null,
    createdAt: 277,
  });
  driftChat.close();
  const currentSnapshot = fs.readFileSync(currentSchemaDrift.paths.stateSnapshotPath);
  const currentChat = fs.readFileSync(path.join(
    currentSchemaDrift.paths.stateDir,
    "chat-sessions.json",
  ));
  const legacySnapshot = JSON.parse(currentSnapshot.toString("utf8"));
  legacySnapshot.schemaVersion = STORE_SCHEMA_VERSION - 1;
  fs.writeFileSync(
    currentSchemaDrift.paths.stateSnapshotPath,
    `${JSON.stringify(legacySnapshot)}\n`,
    { mode: 0o600 },
  );
  const legacyChat = JSON.parse(currentChat.toString("utf8"));
  legacyChat.version = CHAT_SESSION_STORE_VERSION - 1;
  for (const sessionValue of Object.values(legacyChat.sessions)) {
    delete sessionValue.permissionMode;
  }
  fs.writeFileSync(
    path.join(currentSchemaDrift.paths.stateDir, "chat-sessions.json"),
    `${JSON.stringify(legacyChat)}\n`,
    { mode: 0o600 },
  );
  const currentSchemaDriftLock = acquireFixtureServiceLock(currentSchemaDrift.paths);
  const oldRuntimeBackup = createFixtureRuntimeSchemaMetadataBackup({
    paths: currentSchemaDrift.paths,
    backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
    activeServiceLock: currentSchemaDriftLock,
    now: () => 278,
  });
  const sealedOldChat = fs.readFileSync(path.join(
    oldRuntimeBackup.backupPath,
    "payload",
    "chat-sessions.json",
  ));
  fs.writeFileSync(currentSchemaDrift.paths.stateSnapshotPath, currentSnapshot, { mode: 0o600 });
  fs.writeFileSync(
    path.join(currentSchemaDrift.paths.stateDir, "chat-sessions.json"),
    currentChat,
    { mode: 0o600 },
  );
  assert.equal(needsRuntimeSchemaMigration(currentSchemaDrift.paths), false);
  assert.equal(ensureFixtureRuntimeSchemaMigrationBackup({
    paths: currentSchemaDrift.paths,
    activeServiceLock: currentSchemaDriftLock,
  }), null);
  assert.equal(ensureFixtureRuntimeSchemaMigrationBackup({
    paths: currentSchemaDrift.paths,
    activeServiceLock: currentSchemaDriftLock,
  }), null);
  assert.deepEqual(fs.readFileSync(path.join(
    oldRuntimeBackup.backupPath,
    "payload",
    "chat-sessions.json",
  )), sealedOldChat);
  console.log("PASS v8 + ChatSession v4 不触发二次迁移，旧 pre-v8 备份在 chat 漂移和重启后保持封存");

  const changedGeneration = fixture();
  fs.mkdirSync(changedGeneration.paths.stateDir, { recursive: true, mode: 0o700 });
  const changedChatPath = path.join(changedGeneration.paths.stateDir, "chat-sessions.json");
  fs.writeFileSync(
    changedChatPath,
    `${JSON.stringify({ version: CHAT_SESSION_STORE_VERSION - 1, generation: "a" })}\n`,
    { mode: 0o600 },
  );
  const changedGenerationLock = acquireFixtureServiceLock(changedGeneration.paths);
  const changedGenerationBackup = ensureFixtureRuntimeSchemaMigrationBackup({
    paths: changedGeneration.paths,
    activeServiceLock: changedGenerationLock,
    now: () => 280,
  });
  fs.writeFileSync(
    changedChatPath,
    `${JSON.stringify({ version: CHAT_SESSION_STORE_VERSION - 1, generation: "b" })}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => ensureFixtureRuntimeSchemaMigrationBackup({
      paths: changedGeneration.paths,
      activeServiceLock: changedGenerationLock,
    }),
    (error) => error.code === "MIGRATION_BACKUP_STALE",
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(
    changedGenerationBackup.backupPath, "payload", "chat-sessions.json",
  ), "utf8")).generation, "a");

  const addedLegacy = fixture();
  fs.mkdirSync(addedLegacy.paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(addedLegacy.paths.stateDir, "chat-sessions.json"),
    `${JSON.stringify({ version: CHAT_SESSION_STORE_VERSION - 1 })}\n`,
    { mode: 0o600 },
  );
  const addedLegacyLock = acquireFixtureServiceLock(addedLegacy.paths);
  ensureFixtureRuntimeSchemaMigrationBackup({
    paths: addedLegacy.paths,
    activeServiceLock: addedLegacyLock,
    now: () => 281,
  });
  fs.writeFileSync(
    addedLegacy.paths.stateSnapshotPath,
    `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION - 1 })}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => ensureFixtureRuntimeSchemaMigrationBackup({
      paths: addedLegacy.paths,
      activeServiceLock: addedLegacyLock,
    }),
    (error) => error.code === "MIGRATION_BACKUP_STALE",
  );

  const continuedEvents = fixture();
  fs.mkdirSync(continuedEvents.paths.stateDir, { recursive: true, mode: 0o700 });
  const legacyEvent = `${JSON.stringify({
    schemaVersion: STORE_SCHEMA_VERSION - 1,
    type: "legacy",
  })}\n`;
  fs.writeFileSync(continuedEvents.paths.eventLogPath, legacyEvent, { mode: 0o600 });
  const continuedEventsLock = acquireFixtureServiceLock(continuedEvents.paths);
  const continuedEventsBackup = ensureFixtureRuntimeSchemaMigrationBackup({
    paths: continuedEvents.paths,
    activeServiceLock: continuedEventsLock,
    now: () => 282,
  });
  fs.appendFileSync(
    continuedEvents.paths.eventLogPath,
    `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, type: "migrated" })}\n`,
  );
  assert.deepEqual(
    ensureFixtureRuntimeSchemaMigrationBackup({
      paths: continuedEvents.paths,
      activeServiceLock: continuedEventsLock,
    }).manifest,
    continuedEventsBackup.manifest,
  );
  fs.writeFileSync(
    continuedEvents.paths.eventLogPath,
    `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION - 1, type: "rollback" })}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => ensureFixtureRuntimeSchemaMigrationBackup({
      paths: continuedEvents.paths,
      activeServiceLock: continuedEventsLock,
    }),
    (error) => error.code === "MIGRATION_BACKUP_STALE",
  );
  console.log("PASS 备份复用绑定 legacy generation，仅允许当前 schema event 续写");

  const writerFenced = fixture();
  fs.mkdirSync(writerFenced.paths.stateDir, { recursive: true, mode: 0o700 });
  const writerFencedChat = path.join(writerFenced.paths.stateDir, "chat-sessions.json");
  fs.writeFileSync(
    writerFencedChat,
    `${JSON.stringify({ version: CHAT_SESSION_STORE_VERSION - 1, generation: "sealed" })}\n`,
    { mode: 0o600 },
  );
  const writerFencedLock = acquireFixtureServiceLock(writerFenced.paths);
  const originalWriterReadSync = fs.readSync;
  let competingWriterAttempted = false;
  let competingWriterRejected = false;
  fs.readSync = (...args) => {
    if (!competingWriterAttempted) {
      competingWriterAttempted = true;
      try {
        const competingLease = acquireFixtureWriterLease({
          lockPath: path.join(writerFenced.paths.stateDir, "chat-sessions.writer.lock"),
        });
        try {
          fs.writeFileSync(writerFencedChat, "transient writer mutation\n", { mode: 0o600 });
        } finally {
          competingLease.release();
        }
      } catch (error) {
        if (error?.code !== "WRITER_LEASE_HELD") throw error;
        competingWriterRejected = true;
      }
    }
    return originalWriterReadSync(...args);
  };
  let writerFencedBackup;
  try {
    writerFencedBackup = createFixtureRuntimeSchemaMetadataBackup({
      paths: writerFenced.paths,
      backupId: "writer-fenced-metadata",
      activeServiceLock: writerFencedLock,
    });
  } finally {
    fs.readSync = originalWriterReadSync;
  }
  assert.equal(competingWriterAttempted, true);
  assert.equal(competingWriterRejected, true);
  assert.deepEqual(
    fs.readFileSync(path.join(writerFencedBackup.backupPath, "payload", "chat-sessions.json")),
    fs.readFileSync(writerFencedChat),
  );
  const forgedLease = acquireFixtureWriterLease({
    lockPath: path.join(writerFenced.paths.stateDir, "chat-sessions.writer.lock"),
  });
  try {
    const forgedStat = fs.lstatSync(forgedLease.lockPath);
    assert.throws(
      () => createFixtureRuntimeSchemaMetadataBackup({
        paths: writerFenced.paths,
        backupId: "forged-writer-fence",
        activeServiceLock: writerFencedLock,
        activeWriterLocks: [{
          lockPath: path.join(writerFenced.paths.stateDir, "chat-sessions.writer.lock"),
          dev: forgedStat.dev,
          ino: forgedStat.ino,
        }],
      }),
      (error) => error.code === "BACKUP_SERVICE_ACTIVE",
    );
  } finally {
    forgedLease.release();
  }
  console.log("PASS metadata 复制全程持有不可伪造 writer lease，短暂 writer 无法进入修改窗口");

  const backupPathRace = fixture();
  fs.mkdirSync(backupPathRace.paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(backupPathRace.paths.stateDir, "chat-sessions.json"),
    `${JSON.stringify({ version: CHAT_SESSION_STORE_VERSION - 1 })}\n`,
    { mode: 0o600 },
  );
  const backupPathRaceLock = acquireFixtureServiceLock(backupPathRace.paths);
  const backupPathRaceBackup = createFixtureRuntimeSchemaMetadataBackup({
    paths: backupPathRace.paths,
    backupId: "backup-path-race",
    activeServiceLock: backupPathRaceLock,
  });
  const movedBackupPath = path.join(backupPathRace.paths.backupsDir, "backup-path-race-moved");
  assertRejectsLstatSwap(
    backupPathRaceBackup.backupPath,
    () => replaceDirectoryWithSymlink(backupPathRaceBackup.backupPath, movedBackupPath),
    () => verifyFixtureRuntimeSchemaMetadataBackup({
      paths: backupPathRace.paths,
      backupId: "backup-path-race",
      activeServiceLock: backupPathRaceLock,
    }),
  );

  const manifestRace = fixture();
  fs.mkdirSync(manifestRace.paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(manifestRace.paths.stateDir, "chat-sessions.json"),
    `${JSON.stringify({ version: CHAT_SESSION_STORE_VERSION - 1 })}\n`,
    { mode: 0o600 },
  );
  const manifestRaceLock = acquireFixtureServiceLock(manifestRace.paths);
  const manifestRaceBackup = createFixtureRuntimeSchemaMetadataBackup({
    paths: manifestRace.paths,
    backupId: "manifest-race",
    activeServiceLock: manifestRaceLock,
  });
  const manifestPath = path.join(manifestRaceBackup.backupPath, "manifest.json");
  const movedManifestPath = path.join(manifestRaceBackup.backupPath, "manifest-original.json");
  assertRejectsLstatSwap(
    manifestPath,
    () => {
      fs.renameSync(manifestPath, movedManifestPath);
      fs.copyFileSync(movedManifestPath, manifestPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(manifestPath, 0o600);
    },
    () => verifyFixtureRuntimeSchemaMetadataBackup({
      paths: manifestRace.paths,
      backupId: "manifest-race",
      activeServiceLock: manifestRaceLock,
    }),
  );

  const payloadRace = fixture();
  fs.mkdirSync(payloadRace.paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(payloadRace.paths.stateDir, "chat-sessions.json"),
    `${JSON.stringify({ version: CHAT_SESSION_STORE_VERSION - 1 })}\n`,
    { mode: 0o600 },
  );
  const payloadRaceLock = acquireFixtureServiceLock(payloadRace.paths);
  const payloadRaceBackup = createFixtureRuntimeSchemaMetadataBackup({
    paths: payloadRace.paths,
    backupId: "payload-race",
    activeServiceLock: payloadRaceLock,
  });
  const payloadPath = path.join(payloadRaceBackup.backupPath, "payload");
  const movedPayloadPath = path.join(payloadRaceBackup.backupPath, "payload-original");
  assertRejectsLstatSwap(
    payloadPath,
    () => replaceDirectoryWithSymlink(payloadPath, movedPayloadPath),
    () => verifyFixtureRuntimeSchemaMetadataBackup({
      paths: payloadRace.paths,
      backupId: "payload-race",
      activeServiceLock: payloadRaceLock,
    }),
  );
  console.log("PASS verifier pin 住 backup、manifest 与 payload 顶层 identity");

  const linkedSource = fixture();
  fs.mkdirSync(linkedSource.paths.stateDir, { recursive: true, mode: 0o700 });
  const linkedVictim = path.join(linkedSource.root, "linked-victim.json");
  fs.writeFileSync(linkedVictim, "legacy snapshot\n", { mode: 0o600 });
  fs.symlinkSync(linkedVictim, linkedSource.paths.stateSnapshotPath);
  const linkedSourceLock = acquireFixtureServiceLock(linkedSource.paths);
  assert.throws(
    () => createFixtureRuntimeSchemaMetadataBackup({
      paths: linkedSource.paths,
      backupId: "linked-metadata",
      activeServiceLock: linkedSourceLock,
    }),
    (error) => error.code === "BACKUP_UNSAFE_SOURCE",
  );

  const racedSource = fixture();
  fs.mkdirSync(racedSource.paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    racedSource.paths.stateSnapshotPath,
    Buffer.alloc(128 * 1024, 0x41),
    { mode: 0o600 },
  );
  const racedSourceLock = acquireFixtureServiceLock(racedSource.paths);
  const racedHardlink = path.join(racedSource.root, "raced-hardlink.json");
  const originalReadSync = fs.readSync;
  let hardlinkInjected = false;
  fs.readSync = (...args) => {
    const bytes = originalReadSync(...args);
    if (!hardlinkInjected && bytes > 0) {
      hardlinkInjected = true;
      fs.linkSync(racedSource.paths.stateSnapshotPath, racedHardlink);
    }
    return bytes;
  };
  try {
    assert.throws(
      () => createFixtureRuntimeSchemaMetadataBackup({
        paths: racedSource.paths,
        backupId: "raced-metadata",
        activeServiceLock: racedSourceLock,
      }),
      (error) => error.code === "BACKUP_UNSAFE_SOURCE",
    );
  } finally {
    fs.readSync = originalReadSync;
  }
  assert.equal(hardlinkInjected, true);
  assert.equal(fs.existsSync(path.join(
    racedSource.paths.backupsDir, "raced-metadata",
  )), false);
  console.log("PASS metadata 复制拒绝 symlink 与复制期间新增的 hardlink");

  const third = fixture();
  seedGenericRuntimeV4(third.paths);
  const thirdLock = acquireFixtureServiceLock(third.paths);
  const thirdBackup = ensureFixtureRuntimeSchemaMigrationBackup({
    paths: third.paths,
    activeServiceLock: thirdLock,
    now: () => 301,
  });
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(thirdBackup.backupPath, "payload", "state.snapshot.json"), "utf8",
  )).schemaVersion, 4);
  const migrated = new JsonlProductStore({ paths: third.paths, now: () => 302 });
  migrated.open();
  assert.equal(migrated.getWorkRun("generic-v4-run").contextSnapshotId, null);
  migrated.close();
  assert.equal(
    JSON.parse(fs.readFileSync(third.paths.stateSnapshotPath, "utf8")).schemaVersion,
    STORE_SCHEMA_VERSION,
  );
  console.log(`PASS v4 通用 Runtime WorkRun 原样迁移到 v${STORE_SCHEMA_VERSION}，并显式补 null ContextSnapshot binding`);
  console.log("PASS shoggoth runtime schema migration unit (9)");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
