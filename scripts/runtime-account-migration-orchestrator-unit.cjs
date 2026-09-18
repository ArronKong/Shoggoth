#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const {
  LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID,
  legacyManagedAccountId,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account-migration.js"));
const {
  LegacyRuntimeHomeStore,
  legacyHomeId,
} = require(path.join(ROOT, "app", "agent-service", "legacy-runtime-home-store.js"));
const { RuntimeStorageCleanup } = require(path.join(
  ROOT,
  "app",
  "agent-service",
  "runtime-storage-cleanup.js",
));
const { ChatSessionStore } = require(path.join(
  ROOT,
  "app",
  "agent-service",
  "chat-session-store.js",
));
const { TranscriptStore } = require(path.join(
  ROOT,
  "app",
  "agent-service",
  "transcript-store.js",
));
const {
  RuntimeAccountMigrationOrchestrator,
} = require(path.join(
  ROOT,
  "app",
  "agent-service",
  "runtime-account-migration-orchestrator.js",
));
const {
  RuntimeAccountMigrationJournal,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account-migration-journal.js"));
const {
  RuntimeSessionOwnershipStore,
} = require(path.join(ROOT, "app", "agent-service", "runtime-session-ownership-store.js"));
const {
  PRE_RUNTIME_SCHEMA_BACKUP_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-schema-migration.js"));

const DEFAULT_RUNTIME_PROFILE_ID = "shoggoth-f8a76c25-bd49-4c12-9d63-7b7d1eb1d0a4";

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

function fixture(schemaVersion = 7, sourceProfiles = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(
    os.tmpdir(),
    "shoggoth-runtime-orchestrator-",
  )));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    homeDir: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  privateDirectory(paths.stateDir);
  privateDirectory(path.join(paths.stateDir, "codex", DEFAULT_RUNTIME_PROFILE_ID));
  const profiles = (sourceProfiles || [{
    id: LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID,
    runtime: "codex",
    runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
  }]).map((profile) => {
    const backendId = profile.backendId
      ?? (profile.runtime === "codex" ? "shoggoth" : profile.runtime);
    const isDefault = profile.isDefault
      ?? profile.id === LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID;
    const runtimeAccountId = profile.runtimeAccountId ?? (
      schemaVersion === 7 && backendId === "shoggoth"
        && profile.runtime === "codex" && !isDefault
        ? legacyManagedAccountId(profile.id, profile.runtime)
        : undefined
    );
    return {
      ...profile,
      backendId,
      providerRef: profile.providerRef ?? null,
      isDefault,
      ...(runtimeAccountId === undefined ? {} : { runtimeAccountId }),
    };
  });
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion, agentProfiles: profiles })}\n`);
  const backupPath = privateDirectory(path.join(paths.backupsDir, PRE_RUNTIME_SCHEMA_BACKUP_ID));
  const payload = privateDirectory(path.join(backupPath, "payload"));
  const snapshotPath = path.join(payload, "state.snapshot.json");
  fs.writeFileSync(snapshotPath, bytes, { mode: 0o600 });
  fs.chmodSync(snapshotPath, 0o600);
  const manifest = {
    schemaVersion: 2,
    backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
    createdAt: 42,
    sourceRoot: "stateDir",
    scope: "runtime-schema-metadata",
    entries: [{
      path: "state.snapshot.json",
      type: "file",
      mode: 0o600,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    }],
    rootDigest: "a".repeat(64),
  };
  return {
    root,
    paths,
    verified: Object.freeze({ backupPath, manifest }),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function addBackupEntry(current, name, bytes) {
  const target = path.join(current.verified.backupPath, "payload", name);
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  current.verified.manifest.entries.push({
    path: name,
    type: "file",
    mode: 0o600,
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
}

function profileRecords() {
  return [{
    id: LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID,
    runtime: "codex",
    runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  }, {
    id: "grok-profile",
    runtime: "grok-build",
    runtimeProfileId: "grok-profile-runtime",
    runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  }];
}

function productStoreFixture() {
  const profiles = profileRecords();
  const runs = [{
    id: "run-one",
    profileId: LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID,
    runtimeSessionRef: {
      runtime: "codex",
      runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
      runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      sessionId: "runtime-session-one",
    },
    runtimeTurnRef: null,
  }];
  return {
    profiles,
    runs,
    listRuntimeAccounts: () => structuredClone(DEFAULT_RUNTIME_ACCOUNTS),
    getRuntimeAccount: (id) => structuredClone(
      DEFAULT_RUNTIME_ACCOUNTS.find((account) => account.id === id) || null,
    ),
    listAgentProfiles: () => structuredClone(profiles),
    listWorkRuns: () => structuredClone(runs),
    getAgentProfile: (id) => structuredClone(profiles.find((profile) => profile.id === id) || null),
  };
}

function migrationProductStore(profiles, runs = []) {
  return {
    listRuntimeAccounts: () => structuredClone(DEFAULT_RUNTIME_ACCOUNTS),
    getRuntimeAccount: (id) => structuredClone(
      DEFAULT_RUNTIME_ACCOUNTS.find((account) => account.id === id) || null,
    ),
    listAgentProfiles: () => structuredClone(profiles),
    getAgentProfile: (id) => structuredClone(
      profiles.find((profile) => profile.id === id) || null,
    ),
    listWorkRuns: () => structuredClone(runs),
  };
}

function ownershipIdentity(profile, session, sessionId) {
  return {
    binding: {
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
    },
    sessionId,
    profileId: profile.id,
    workspace: session.workspace,
  };
}

function cleanupEntry(runtime, runtimeProfileId, runtimeAccountId) {
  return {
    id: legacyHomeId(runtime, runtimeProfileId, runtimeAccountId),
    runtime,
    runtimeProfileId,
    runtimeAccountId,
    profileIds: [],
  };
}

function createBoundSessions(paths, definitions, now = 300) {
  const ids = definitions.flatMap((definition, index) => {
    const first = (index * 2 + 1).toString(16).padStart(12, "0");
    const second = (index * 2 + 2).toString(16).padStart(12, "0");
    return [
      `10000000-0000-4000-8000-${first}`,
      `20000000-0000-4000-8000-${second}`,
    ];
  });
  const store = new ChatSessionStore({
    paths,
    now: () => now,
    randomUUID: () => ids.shift(),
  }).open();
  const sessions = [];
  for (const definition of definitions) {
    const session = store.createSession({
      operationId: `create-${definition.profileId}`,
      profileId: definition.profileId,
      workspace: definition.workspace,
      createdAt: now,
    });
    store.requestBinding(session.sessionKey, `bind-${definition.profileId}`, now);
    store.completeBinding(
      session.sessionKey,
      `bind-${definition.profileId}`,
      definition.runtimeSessionId,
    );
    sessions.push(session);
  }
  return { sessions, store };
}

function appendSemanticTranscript(transcriptStore, session, suffix, occurredAt = 300) {
  transcriptStore.ensureSession({ profileId: session.profileId, sessionId: session.id });
  transcriptStore.appendEvent({
    profileId: session.profileId,
    sessionId: session.id,
    id: `migration-user-${suffix}`,
    runId: null,
    kind: "user",
    content: { text: `continue ${suffix}` },
    runtimeRef: null,
    occurredAt,
  });
}

function orchestrator(current, verified = current.verified) {
  return new RuntimeAccountMigrationOrchestrator({
    paths: current.paths,
    now: () => 100,
    verifyBackup: () => structuredClone(verified),
  });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("startup backfill accepts a session alias without rewriting canonical ownership or creation time", () => {
  const current = fixture(9);
  try {
    const productStore = productStoreFixture();
    const profile = productStore.getAgentProfile(LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID);
    const workspace = privateDirectory(path.join(current.root, "workspace"));
    const alias = path.join(current.root, "alias");
    fs.symlinkSync(workspace, alias);
    const ownership = new RuntimeSessionOwnershipStore({ paths: current.paths }).open();
    ownership.claim({
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
      profileId: profile.id,
      sessionId: "runtime-session-alias",
      workspace,
      createdAt: 20,
      lastSeenAt: 30,
    });
    const chatSessionStore = { listSessions: () => [{
      profileId: profile.id,
      runtimeSessionId: "runtime-session-alias",
      workspace: alias,
      status: "ready",
      createdAt: 10,
      updatedAt: 30,
    }] };
    const before = fs.readFileSync(current.paths.runtimeSessionOwnershipPath);
    const migration = orchestrator(current);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(migration.backfillOwnership({
        productStore, chatSessionStore, ownershipStore: ownership,
      }), { claimed: 0, unchanged: 1 });
    }
    assert.deepEqual(fs.readFileSync(current.paths.runtimeSessionOwnershipPath), before);
    ownership.close();
    migration.close();
  } finally {
    current.cleanup();
  }
});

test("pre-v8 migration resumes monotonically and backfills only Shoggoth ChatSessions", () => {
  const current = fixture(7);
  try {
    const productStore = productStoreFixture();
    const first = orchestrator(current);
    assert.equal(first.prepare({
      metadataBackup: current.verified,
      activeServiceLock: { dev: 1, ino: 2 },
    }).stage, "metadata_backed_up");
    assert.equal(first.reconcileAccountsAndProfiles(productStore).stage, "profiles_rebound");
    first.close();

    const resumed = orchestrator(current);
    assert.equal(resumed.prepare({
      metadataBackup: null,
      activeServiceLock: { dev: 1, ino: 2 },
    }).stage, "profiles_rebound");
    const ownership = new RuntimeSessionOwnershipStore({ paths: current.paths, now: () => 200 }).open();
    let listCalls = 0;
    const chatSessionStore = {
      listSessions() {
        listCalls += 1;
        return [{
          profileId: LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID,
          runtimeSessionId: "runtime-session-one",
          workspace: "/tmp/workspace",
          status: "ready",
          createdAt: 10,
          updatedAt: 20,
        }];
      },
    };
    assert.deepEqual(resumed.backfillOwnership({
      productStore,
      chatSessionStore,
      ownershipStore: ownership,
    }), { claimed: 1, unchanged: 0 });
    assert.deepEqual(resumed.backfillOwnership({
      productStore,
      chatSessionStore,
      ownershipStore: ownership,
    }), { claimed: 0, unchanged: 1 });
    assert.equal(listCalls, 2);
    assert.deepEqual(resumed.reconcileLegacyRuntimeSessions({
      productStore,
      chatSessionStore: {
        listSessions: () => [],
        getSession: () => null,
        detachRuntimeSession() { throw new Error("unexpected detach"); },
      },
      transcriptStore: { listEvents: () => [], getRevision: () => 0 },
      ownershipStore: ownership,
    }), {
      detached: 0, marked: 0, retained: 0, skipped: 0, metadataComplete: true,
    });
    assert.equal(resumed.reconcileRuntimeRefs(productStore).stage, "runtime_refs_reconciled");
    assert.equal(resumed.markServiceReady().stage, "cleanup_eligible");
    assert.deepEqual(resumed.rollbackVerificationReceipt(), {
      backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
      backupPath: current.verified.backupPath,
      generation: 42,
      rootDigest: "a".repeat(64),
      readOnly: true,
    });
    resumed.close();
    ownership.close();

    const journal = new RuntimeAccountMigrationJournal({ paths: current.paths }).open();
    assert.equal(journal.read().stage, "cleanup_eligible");
    assert.equal(journal.read().legacyHomes.length, 1);
    assert.equal(journal.read().legacyHomes[0].classification, "managed-canonical");
    assert.equal(
      journal.read().legacyHomes[0].id,
      legacyHomeId(
        "codex",
        DEFAULT_RUNTIME_PROFILE_ID,
        SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      ),
    );
    assert.equal(
      journal.read().legacyHomes[0].runtimeAccountId,
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    );
    journal.close();
  } finally {
    current.cleanup();
  }
});

test("存在但结构不完整的 legacy Chat metadata 不能作为 cleanup lineage 证明", () => {
  const current = fixture(6);
  try {
    addBackupEntry(
      current,
      "chat-sessions.json",
      Buffer.from(`${JSON.stringify({ version: 4, sessions: {} })}\n`),
    );
    assert.throws(
      () => orchestrator(current).prepare({
        metadataBackup: current.verified,
        activeServiceLock: { dev: 1, ino: 2 },
      }),
      (error) => error.code === "RUNTIME_ACCOUNT_MIGRATION_SOURCE_INVALID",
    );
  } finally {
    current.cleanup();
  }
});

test("v6 per-Profile sessions 仅在 Transcript 可语义续接时 detach，marker 使 crash/restart 与新绑定幂等", async () => {
  const profiles = [{
    id: "reviewer-profile",
    runtime: "codex",
    runtimeProfileId: "reviewer-runtime",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    isDefault: false,
  }, {
    id: "grok-profile",
    runtime: "grok-build",
    runtimeProfileId: "grok-runtime",
    runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
    isDefault: false,
  }];
  const sourceProfiles = profiles.map(({ id, runtime, runtimeProfileId }) => ({
    id, runtime, runtimeProfileId,
  }));
  const current = fixture(6, sourceProfiles);
  try {
    privateDirectory(path.join(
      current.paths.stateDir,
      profiles[0].runtime,
      profiles[0].runtimeProfileId,
    ));
    const definitions = profiles.map((profile, index) => ({
      profileId: profile.id,
      workspace: `/tmp/migration-${index}`,
      runtimeSessionId: `legacy-session-${index}`,
    }));
    let { sessions, store: chat } = createBoundSessions(current.paths, definitions);
    const chatBytes = fs.readFileSync(chat.filePath);
    chat.close();
    addBackupEntry(current, "chat-sessions.json", chatBytes);

    const productStore = migrationProductStore(profiles);
    let migration = orchestrator(current);
    migration.prepare({
      metadataBackup: current.verified,
      activeServiceLock: { dev: 1, ino: 2 },
    });
    migration.reconcileAccountsAndProfiles(productStore);
    const ownership = new RuntimeSessionOwnershipStore({
      paths: current.paths,
      now: () => 320,
    }).open();
    chat = new ChatSessionStore({ paths: current.paths, now: () => 320 }).open();
    const transcripts = new TranscriptStore({ paths: current.paths, now: () => 320 });
    transcripts.open();
    appendSemanticTranscript(transcripts, sessions[0], "codex");
    appendSemanticTranscript(transcripts, sessions[1], "grok");
    migration.backfillOwnership({ productStore, chatSessionStore: chat, ownershipStore: ownership });
    const interruptedOwnership = {
      claim: ownership.claim.bind(ownership),
      mark: ownership.mark.bind(ownership),
      readRecord: ownership.readRecord.bind(ownership),
      readLegacyMigration: ownership.readLegacyMigration.bind(ownership),
      recordLegacyMigration() {
        const error = new Error("simulated crash after ChatSession detach");
        error.code = "SIMULATED_CRASH";
        throw error;
      },
    };
    assert.throws(
      () => migration.reconcileLegacyRuntimeSessions({
        productStore,
        chatSessionStore: chat,
        transcriptStore: transcripts,
        ownershipStore: interruptedOwnership,
      }),
      (error) => error.code === "SIMULATED_CRASH",
    );
    const codexHomeId = legacyHomeId(
      "codex",
      "reviewer-runtime",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    );
    assert.equal(chat.getSession(sessions[0].sessionKey).codexThreadId, null);
    assert.equal(chat.getSession(sessions[1].sessionKey).codexThreadId, "legacy-session-1");
    assert.equal(ownership.readLegacyMigration(ownershipIdentity(
      profiles[0], sessions[0], "legacy-session-0",
    )), null);

    // The first restart repairs the crash window between ChatSession detach
    // and the atomic ownership-marker/deleted commit.
    migration.close();
    transcripts.close();
    chat.close();
    ownership.close();
    migration = orchestrator(current);
    assert.equal(migration.prepare({
      metadataBackup: null,
      activeServiceLock: { dev: 1, ino: 2 },
    }).stage, "profiles_rebound");
    const restartedOwnership = new RuntimeSessionOwnershipStore({
      paths: current.paths,
      now: () => 330,
    }).open();
    const restartedChat = new ChatSessionStore({ paths: current.paths, now: () => 330 }).open();
    const restartedTranscripts = new TranscriptStore({ paths: current.paths, now: () => 330 });
    restartedTranscripts.open();
    assert.deepEqual(migration.reconcileLegacyRuntimeSessions({
      productStore,
      chatSessionStore: restartedChat,
      transcriptStore: restartedTranscripts,
      ownershipStore: restartedOwnership,
    }), {
      detached: 2, marked: 0, retained: 0, skipped: 0, metadataComplete: true,
    });
    assert.equal(restartedOwnership.readLegacyMigration(ownershipIdentity(
      profiles[0], sessions[0], "legacy-session-0",
    )).legacyHomeId, codexHomeId);
    assert.deepEqual(migration.legacyHomePersistentReferences(cleanupEntry(
      "codex",
      "reviewer-runtime",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ), {
      productStore,
      chatSessionStore: restartedChat,
      ownershipStore: restartedOwnership,
    }), []);
    migration.close();
    restartedTranscripts.close();
    restartedChat.close();
    restartedOwnership.close();

    // A second restart sees the durable ownership lineage marker. Rebinding
    // to a shared-Home session must never make it detach that new session.
    migration = orchestrator(current);
    migration.prepare({
      metadataBackup: null,
      activeServiceLock: { dev: 1, ino: 2 },
    });
    const reboundOwnership = new RuntimeSessionOwnershipStore({
      paths: current.paths,
      now: () => 340,
    }).open();
    const reboundChat = new ChatSessionStore({ paths: current.paths, now: () => 340 }).open();
    const reboundTranscripts = new TranscriptStore({ paths: current.paths, now: () => 340 });
    reboundTranscripts.open();
    assert.deepEqual(migration.reconcileLegacyRuntimeSessions({
      productStore,
      chatSessionStore: reboundChat,
      transcriptStore: reboundTranscripts,
      ownershipStore: reboundOwnership,
    }), {
      detached: 0, marked: 2, retained: 0, skipped: 0, metadataComplete: true,
    });
    reboundChat.requestBinding(sessions[0].sessionKey, "semantic-rebind", 340);
    reboundChat.completeBinding(sessions[0].sessionKey, "semantic-rebind", "shared-session");
    assert.equal(reboundChat.getSession(sessions[0].sessionKey).codexThreadId, "shared-session");
    migration.reconcileLegacyRuntimeSessions({
      productStore,
      chatSessionStore: reboundChat,
      transcriptStore: reboundTranscripts,
      ownershipStore: reboundOwnership,
    });
    assert.equal(reboundChat.getSession(sessions[0].sessionKey).codexThreadId, "shared-session");
    assert.deepEqual(migration.legacyHomePersistentReferences(cleanupEntry(
      "codex",
      "reviewer-runtime",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ), {
      productStore,
      chatSessionStore: reboundChat,
      ownershipStore: reboundOwnership,
    }), []);
    assert.deepEqual(migration.legacyHomePersistentReferences(cleanupEntry(
      "codex",
      "appeared-after-backup",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ), {
      productStore,
      chatSessionStore: reboundChat,
      ownershipStore: reboundOwnership,
    }), ["legacy-home-lineage-unavailable"]);
    const lateHome = privateDirectory(path.join(
      current.paths.stateDir,
      profiles[1].runtime,
      profiles[1].runtimeProfileId,
    ));
    fs.writeFileSync(path.join(lateHome, "must-survive.txt"), "late", { mode: 0o600 });
    const legacyStore = new LegacyRuntimeHomeStore({
      paths: current.paths,
      now: () => 340,
      parentEnv: {},
      homedir: current.root,
    });
    const inventory = () => legacyStore.refresh({
      accounts: DEFAULT_RUNTIME_ACCOUNTS,
      profiles,
    });
    const lateEntry = inventory().entries.find((entry) => entry.path === lateHome);
    assert.ok(lateEntry);
    const cleanup = new RuntimeStorageCleanup({
      paths: current.paths,
      inventory,
      readCleanupState: () => ({ serviceReady: true, cleanupEligible: true }),
      isInUse: (entry) => {
        const reasons = migration.legacyHomePersistentReferences(entry, {
          productStore,
          chatSessionStore: reboundChat,
          ownershipStore: reboundOwnership,
        });
        return reasons.length === 0 ? false : { reasons };
      },
      now: () => 340,
    });
    await assert.rejects(
      cleanup.prepare({ entryId: lateEntry.id }),
      (error) => error.code === "RUNTIME_STORAGE_CANDIDATE_IN_USE"
        && error.reasons.includes("legacy-home-lineage-unavailable"),
    );
    assert.equal(fs.readFileSync(path.join(lateHome, "must-survive.txt"), "utf8"), "late");
    reboundTranscripts.close();
    reboundChat.close();
    reboundOwnership.close();
    migration.close();
  } finally {
    current.cleanup();
  }
});

test("v7 只 detach 非默认 managed Codex 旧账号 Home，native session 保持原生绑定", () => {
  const profiles = [{
    id: "reviewer-v7",
    runtime: "codex",
    runtimeProfileId: "reviewer-v7-runtime",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    isDefault: false,
  }, {
    id: "grok-v7",
    runtime: "grok-build",
    runtimeProfileId: "grok-v7-runtime",
    runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
    isDefault: false,
  }];
  const current = fixture(7, profiles.map(({ id, runtime, runtimeProfileId }) => ({
    id, runtime, runtimeProfileId,
  })));
  try {
    const v7LegacyAccountId = legacyManagedAccountId(profiles[0].id, "codex");
    privateDirectory(path.join(
      current.paths.stateDir,
      "runtime-accounts",
      "codex",
      v7LegacyAccountId,
      "home",
    ));
    const { sessions, store: initialChat } = createBoundSessions(current.paths, [{
      profileId: profiles[0].id,
      workspace: "/tmp/reviewer-v7",
      runtimeSessionId: "legacy-v7-managed",
    }, {
      profileId: profiles[1].id,
      workspace: "/tmp/grok-v7",
      runtimeSessionId: "native-v7-session",
    }]);
    addBackupEntry(current, "chat-sessions.json", fs.readFileSync(initialChat.filePath));
    initialChat.close();
    const productStore = migrationProductStore(profiles);
    const migration = orchestrator(current);
    migration.prepare({
      metadataBackup: current.verified,
      activeServiceLock: { dev: 1, ino: 2 },
    });
    assert.equal(migration.status().legacyHomes.some((home) => (
      home.id === legacyHomeId(
        "codex",
        v7LegacyAccountId,
        SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      )
      && home.relativePath === path.join(
        "runtime-accounts", "codex", v7LegacyAccountId, "home",
      )
    )), true);
    migration.reconcileAccountsAndProfiles(productStore);
    const ownership = new RuntimeSessionOwnershipStore({ paths: current.paths, now: () => 400 }).open();
    const chat = new ChatSessionStore({ paths: current.paths, now: () => 400 }).open();
    const transcripts = new TranscriptStore({ paths: current.paths, now: () => 400 });
    transcripts.open();
    appendSemanticTranscript(transcripts, sessions[0], "v7-managed", 400);
    appendSemanticTranscript(transcripts, sessions[1], "v7-native", 400);
    migration.backfillOwnership({ productStore, chatSessionStore: chat, ownershipStore: ownership });
    assert.deepEqual(migration.reconcileLegacyRuntimeSessions({
      productStore,
      chatSessionStore: chat,
      transcriptStore: transcripts,
      ownershipStore: ownership,
    }), {
      detached: 1, marked: 0, retained: 0, skipped: 1, metadataComplete: true,
    });
    assert.equal(chat.getSession(sessions[0].sessionKey).codexThreadId, null);
    assert.equal(chat.getSession(sessions[1].sessionKey).codexThreadId, "native-v7-session");
    assert.equal(
      ownership.readLegacyMigration(ownershipIdentity(
        profiles[0], sessions[0], "legacy-v7-managed",
      )).legacyHomeId,
      legacyHomeId(
        "codex",
        v7LegacyAccountId,
        SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      ),
    );
    assert.deepEqual(migration.legacyHomePersistentReferences(cleanupEntry(
      "codex",
      v7LegacyAccountId,
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ), {
      productStore,
      chatSessionStore: chat,
      ownershipStore: ownership,
    }), []);
    transcripts.close();
    chat.close();
    ownership.close();
    migration.close();
  } finally {
    current.cleanup();
  }
});

test("legacy Chat metadata 缺失时保留 runtime ref 并对 cleanup 持久门禁 fail closed", () => {
  const profile = {
    id: "incomplete-profile",
    runtime: "codex",
    runtimeProfileId: "incomplete-runtime",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    isDefault: false,
  };
  const current = fixture(6, [{
    id: profile.id, runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
  }]);
  try {
    privateDirectory(path.join(
      current.paths.stateDir,
      profile.runtime,
      profile.runtimeProfileId,
    ));
    const { sessions, store: chat } = createBoundSessions(current.paths, [{
      profileId: profile.id,
      workspace: "/tmp/incomplete",
      runtimeSessionId: "unproven-legacy-session",
    }]);
    const productStore = migrationProductStore([profile]);
    const migration = orchestrator(current);
    migration.prepare({
      metadataBackup: current.verified,
      activeServiceLock: { dev: 1, ino: 2 },
    });
    migration.reconcileAccountsAndProfiles(productStore);
    const ownership = new RuntimeSessionOwnershipStore({ paths: current.paths, now: () => 500 }).open();
    const transcripts = new TranscriptStore({ paths: current.paths, now: () => 500 });
    transcripts.open();
    appendSemanticTranscript(transcripts, sessions[0], "incomplete", 500);
    migration.backfillOwnership({ productStore, chatSessionStore: chat, ownershipStore: ownership });
    assert.deepEqual(migration.reconcileLegacyRuntimeSessions({
      productStore,
      chatSessionStore: chat,
      transcriptStore: transcripts,
      ownershipStore: ownership,
    }), {
      detached: 0, marked: 0, retained: 1, skipped: 0, metadataComplete: false,
    });
    assert.equal(chat.getSession(sessions[0].sessionKey).codexThreadId, "unproven-legacy-session");
    assert.deepEqual(migration.legacyHomePersistentReferences(cleanupEntry(
      profile.runtime,
      profile.runtimeProfileId,
      profile.runtimeAccountId,
    ), { productStore, chatSessionStore: chat, ownershipStore: ownership }), [
      "legacy-session-metadata-incomplete",
    ]);
    transcripts.close();
    chat.close();
    ownership.close();
    migration.close();
  } finally {
    current.cleanup();
  }
});

test("fresh installs and current-schema backups never create a RuntimeAccount journal", () => {
  const fresh = fixture(8);
  try {
    fs.rmSync(fresh.paths.runtimeAccountMigrationPath, { force: true });
    const none = orchestrator(fresh);
    assert.deepEqual(none.prepare({
      metadataBackup: null,
      activeServiceLock: { dev: 1, ino: 2 },
    }), { active: false, stage: null });
    assert.deepEqual(none.legacyHomePersistentReferences({ id: legacyHomeId(
      "codex",
      "unproven-runtime-profile",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    ) }), ["legacy-session-lineage-unavailable"]);
    assert.equal(fs.existsSync(fresh.paths.runtimeAccountMigrationPath), false);

    const chatOnly = orchestrator(fresh);
    assert.deepEqual(chatOnly.prepare({
      metadataBackup: fresh.verified,
      activeServiceLock: { dev: 1, ino: 2 },
    }), { active: false, stage: null });
    assert.equal(fs.existsSync(fresh.paths.runtimeAccountMigrationPath), false);
  } finally {
    fresh.cleanup();
  }
});

test("one orchestrator instance can be closed and prepared for a later Service generation", () => {
  const fresh = fixture(8);
  try {
    fs.rmSync(fresh.paths.runtimeAccountMigrationPath, { force: true });
    const reusable = orchestrator(fresh);
    const prepare = () => reusable.prepare({
      metadataBackup: null,
      activeServiceLock: { dev: 1, ino: 2 },
    });
    assert.deepEqual(prepare(), { active: false, stage: null });
    reusable.close();
    assert.deepEqual(prepare(), { active: false, stage: null });
    reusable.close();
    assert.equal(fs.existsSync(fresh.paths.runtimeAccountMigrationPath), false);
  } finally {
    fresh.cleanup();
  }
});

test("restart fails closed when the journal backup digest changes", () => {
  const current = fixture(7);
  try {
    const first = orchestrator(current);
    first.prepare({
      metadataBackup: current.verified,
      activeServiceLock: { dev: 1, ino: 2 },
    });
    first.close();
    const changed = structuredClone(current.verified);
    changed.manifest.rootDigest = "b".repeat(64);
    assert.throws(
      () => orchestrator(current, changed).prepare({
        metadataBackup: null,
        activeServiceLock: { dev: 1, ino: 2 },
      }),
      (error) => error.code === "RUNTIME_ACCOUNT_MIGRATION_BACKUP_MISMATCH",
    );
  } finally {
    current.cleanup();
  }
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS runtime account migration orchestrator (${tests.length})`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
