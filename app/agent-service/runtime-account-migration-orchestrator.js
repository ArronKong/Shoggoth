"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  PRE_RUNTIME_SCHEMA_BACKUP_ID,
} = require("./runtime-schema-migration");
const {
  verifyRuntimeSchemaMetadataBackup,
} = require("./authority-backup");
const {
  MIGRATION_STAGES,
  RuntimeAccountMigrationJournal,
} = require("./runtime-account-migration-journal");
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  validateRuntimeAccount,
} = require("./runtime-account");
const {
  LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID,
  legacyManagedAccountId,
  runtimeAccountForLegacyProfile,
} = require("./runtime-account-migration");
const {
  CHAT_SESSION_STORE_VERSION,
  validateContainer: validateChatSessionContainer,
} = require("./chat-session-store");
const { legacyHomeId } = require("./legacy-runtime-home-store");
const {
  STORE_SCHEMA_VERSION,
  PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION,
} = require("./product-store");
const {
  runtimeBinding,
  runtimeSessionRef,
  runtimeTurnRef,
  validRuntime,
  validRuntimeAccountId,
  validRuntimeProfileId,
} = require("./runtime-adapter");
const { serviceError } = require("./security");

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_PREFIX_BYTES = 16 * 1024 * 1024;
const MAX_CHAT_SESSION_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const LEGACY_HOME_ID_PATTERN = /^legacy-home-[a-f0-9]{64}-v1$/u;
const ACTIVE_WORK_RUN_STATUSES = new Set([
  "starting", "running", "waiting_approval", "waiting_input",
]);
const PERSISTENT_REFERENCE_ENTRY_FIELDS = Object.freeze([
  "id", "runtime", "runtimeProfileId", "runtimeAccountId", "profileIds",
]);

function migrationError(code, message) {
  return serviceError(code, message);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function stageIndex(stage) {
  const index = MIGRATION_STAGES.indexOf(stage);
  if (index < 0) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_STAGE_CONFLICT",
      "Runtime account migration stage is invalid",
    );
  }
  return index;
}

function backupGeneration(manifest) {
  if (!Number.isSafeInteger(manifest?.createdAt) || manifest.createdAt < 0) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_BACKUP_MISMATCH",
      "Runtime account migration backup generation is invalid",
    );
  }
  return Math.max(1, manifest.createdAt);
}

function validateVerifiedBackup(verified) {
  const manifest = verified?.manifest;
  if (!verified || typeof verified.backupPath !== "string" || !path.isAbsolute(verified.backupPath)
    || !manifest || manifest.backupId !== PRE_RUNTIME_SCHEMA_BACKUP_ID
    || manifest.scope !== "runtime-schema-metadata"
    || typeof manifest.rootDigest !== "string" || !SHA256_PATTERN.test(manifest.rootDigest)
    || !Array.isArray(manifest.entries)) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_BACKUP_MISMATCH",
      "Runtime account migration backup is invalid",
    );
  }
  return verified;
}

function backupEntry(verified, name) {
  return verified.manifest.entries.find((entry) => entry.path === name) || null;
}

function readPinnedBackupPrefix(verified, name, maxBytes, fileSystem = fs) {
  const entry = backupEntry(verified, name);
  if (!entry) return null;
  if (entry.type !== "file" || !Number.isSafeInteger(entry.size) || entry.size < 0
    || typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_BACKUP_MISMATCH",
      "Runtime account migration backup entry is invalid",
    );
  }
  const target = path.join(verified.backupPath, "payload", name);
  let before;
  let descriptor;
  try {
    before = fileSystem.lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size !== entry.size
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw new Error("unsafe backup entry");
    }
    descriptor = fileSystem.openSync(
      target,
      fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0),
    );
    const opened = fileSystem.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.nlink !== 1) {
      throw new Error("backup entry changed");
    }
    const length = Math.min(opened.size, maxBytes);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = fileSystem.readSync(descriptor, bytes, offset, length - offset, offset);
      if (!Number.isSafeInteger(read) || read <= 0) throw new Error("short backup read");
      offset += read;
    }
    const after = fileSystem.fstatSync(descriptor);
    const pathAfter = fileSystem.lstatSync(target);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev
      || pathAfter.ino !== before.ino || pathAfter.size !== before.size) {
      throw new Error("backup entry changed");
    }
    return { bytes, complete: length === opened.size, entry };
  } catch (error) {
    if (error?.code === "RUNTIME_ACCOUNT_MIGRATION_BACKUP_MISMATCH") throw error;
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_BACKUP_MISMATCH",
      "Runtime account migration backup changed during inspection",
    );
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function parseSnapshotSource(verified, fileSystem) {
  const pinned = readPinnedBackupPrefix(
    verified,
    "state.snapshot.json",
    MAX_SNAPSHOT_BYTES + 1,
    fileSystem,
  );
  if (!pinned) return null;
  if (!pinned.complete || pinned.bytes.length > MAX_SNAPSHOT_BYTES
    || crypto.createHash("sha256").update(pinned.bytes).digest("hex") !== pinned.entry.sha256) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_SOURCE_UNINSPECTABLE",
      "Runtime account migration snapshot is too large or changed",
    );
  }
  try {
    const snapshot = JSON.parse(pinned.bytes.toString("utf8"));
    if (!Number.isSafeInteger(snapshot?.schemaVersion) || snapshot.schemaVersion < 1
      || snapshot.schemaVersion > STORE_SCHEMA_VERSION
      || !Array.isArray(snapshot.agentProfiles)) throw new Error("invalid snapshot");
    return snapshot;
  } catch {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_SOURCE_INVALID",
      "Runtime account migration snapshot is invalid",
    );
  }
}

function firstEventSchemaVersion(verified, fileSystem) {
  const pinned = readPinnedBackupPrefix(
    verified,
    "events.jsonl",
    MAX_EVENT_PREFIX_BYTES + 1,
    fileSystem,
  );
  if (!pinned || pinned.entry.size === 0) return null;
  const newline = pinned.bytes.indexOf(0x0a);
  if (newline < 0 || newline > MAX_EVENT_PREFIX_BYTES) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_SOURCE_UNINSPECTABLE",
      "Runtime account migration event prefix is unavailable",
    );
  }
  try {
    const event = JSON.parse(pinned.bytes.subarray(0, newline).toString("utf8"));
    if (!Number.isSafeInteger(event?.schemaVersion) || event.schemaVersion < 1
      || event.schemaVersion > STORE_SCHEMA_VERSION) throw new Error("invalid event");
    return event.schemaVersion;
  } catch {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_SOURCE_INVALID",
      "Runtime account migration event prefix is invalid",
    );
  }
}

function legacyChatSessionsFromBackup(verified, fileSystem = fs) {
  const pinned = readPinnedBackupPrefix(
    verified,
    "chat-sessions.json",
    MAX_CHAT_SESSION_BYTES + 1,
    fileSystem,
  );
  if (!pinned) {
    return Object.freeze({ present: false, sessions: Object.freeze([]) });
  }
  if (!pinned.complete || pinned.bytes.length > MAX_CHAT_SESSION_BYTES
    || crypto.createHash("sha256").update(pinned.bytes).digest("hex")
      !== pinned.entry.sha256) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_SOURCE_UNINSPECTABLE",
      "Runtime account migration ChatSession metadata is too large or changed",
    );
  }
  let container;
  try {
    const parsed = JSON.parse(pinned.bytes.toString("utf8"));
    if (!Number.isSafeInteger(parsed?.version) || parsed.version < 1
      || parsed.version > CHAT_SESSION_STORE_VERSION) throw new Error("version");
    container = validateChatSessionContainer(parsed);
  } catch {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_SOURCE_INVALID",
      "Runtime account migration ChatSession metadata is invalid",
    );
  }
  const sessions = [];
  try {
    for (const [sessionKey, session] of Object.entries(container.sessions)) {
      if (session.sessionKey !== sessionKey) throw new Error("session key mismatch");
      if (session.runtimeSessionId !== null) {
        sessions.push(Object.freeze({
          sessionKey,
          sessionId: session.id,
          profileId: session.profileId,
          runtimeSessionId: session.runtimeSessionId,
          workspace: session.workspace,
          status: session.status,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }));
      }
    }
  } catch {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_SOURCE_INVALID",
      "Runtime account migration ChatSession records are invalid",
    );
  }
  sessions.sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
  return Object.freeze({ present: true, sessions: Object.freeze(sessions) });
}

function safeLegacyRelativeHome(paths, relativePath, fileSystem) {
  const target = path.join(paths.stateDir, relativePath);
  const relative = path.relative(paths.stateDir, target);
  if (relative !== relativePath || relative === "" || relative === ".."
    || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_LEGACY_HOME_INVALID",
      "Legacy Runtime Home escapes Service state",
    );
  }
  let stat;
  try { stat = fileSystem.lstatSync(target); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_LEGACY_HOME_INVALID",
      "Legacy Runtime Home is unavailable",
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_LEGACY_HOME_INVALID",
      "Legacy Runtime Home is unsafe",
    );
  }
  return relative;
}

function legacyHomesFromSnapshot(paths, snapshot, fileSystem = fs) {
  if (!snapshot || snapshot.schemaVersion >= PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION) return [];
  const homes = new Map();
  const addHome = ({
    runtime,
    runtimeProfileId,
    runtimeAccountId,
    relativePath,
    classification,
  }) => {
    const safeRelativePath = safeLegacyRelativeHome(paths, relativePath, fileSystem);
    if (safeRelativePath === null) return;
    const entry = {
      id: legacyHomeId(runtime, runtimeProfileId, runtimeAccountId),
      runtime,
      runtimeProfileId,
      runtimeAccountId,
      relativePath: safeRelativePath,
      classification,
    };
    const current = homes.get(safeRelativePath);
    if (current && current.id !== entry.id) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_SOURCE_INVALID",
        "Legacy Home has conflicting RuntimeAccount lineage",
      );
    }
    if (!current || entry.classification === "managed-canonical") {
      homes.set(safeRelativePath, entry);
    }
  };
  for (const profile of snapshot.agentProfiles) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)
      || typeof profile.id !== "string" || profile.id.length === 0
      || !validRuntime(profile.runtime) || !validRuntimeProfileId(profile.runtimeProfileId)) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_SOURCE_INVALID",
        "Legacy AgentProfile identity is invalid",
      );
    }
    let runtimeAccountId;
    try {
      runtimeAccountId = runtimeAccountForLegacyProfile(profile).runtimeAccountId;
    } catch {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_SOURCE_INVALID",
        "Legacy AgentProfile RuntimeAccount lineage is invalid",
      );
    }
    const classification = profile.id === LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID
      && profile.runtime === "codex" ? "managed-canonical" : "managed-reclaimable";
    addHome({
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId,
      relativePath: path.join(profile.runtime, profile.runtimeProfileId),
      classification,
    });
    if (snapshot.schemaVersion === 7 && profile.backendId === "shoggoth"
      && profile.runtime === "codex" && profile.isDefault === false) {
      const legacyAccountId = legacyManagedAccountId(profile.id, profile.runtime);
      if (profile.runtimeAccountId === legacyAccountId) {
        addHome({
          runtime: "codex",
          runtimeProfileId: legacyAccountId,
          runtimeAccountId,
          relativePath: path.join("runtime-accounts", "codex", legacyAccountId, "home"),
          classification: "managed-reclaimable",
        });
      }
    }
  }
  return [...homes.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function inspectMigrationSource(paths, verified, fileSystem = fs) {
  const snapshot = parseSnapshotSource(verified, fileSystem);
  const sourceVersion = snapshot?.schemaVersion
    ?? firstEventSchemaVersion(verified, fileSystem);
  const legacyChat = legacyChatSessionsFromBackup(verified, fileSystem);
  return Object.freeze({
    needsRuntimeAccountMigration: sourceVersion !== null
      && sourceVersion < PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION,
    sourceVersion,
    legacyHomes: Object.freeze(legacyHomesFromSnapshot(paths, snapshot, fileSystem)),
    legacyChatMetadataPresent: legacyChat.present,
    legacyChatSessions: legacyChat.sessions,
  });
}

function canonicalProductProjection(productStore) {
  if (!productStore || [
    "listRuntimeAccounts", "listAgentProfiles", "listWorkRuns",
  ].some((method) => typeof productStore[method] !== "function")) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_STORE_INVALID",
      "Runtime account migration requires an open v8 ProductStore",
    );
  }
  const accounts = productStore.listRuntimeAccounts().map(validateRuntimeAccount)
    .sort((left, right) => left.id.localeCompare(right.id));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  for (const required of DEFAULT_RUNTIME_ACCOUNTS) {
    const actual = accountById.get(required.id);
    if (!actual || [
      "runtime", "kind", "installationKind", "homeKind", "isDefault",
    ].some((field) => actual[field] !== required[field])) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_ACCOUNT_MISMATCH",
        "A fixed RuntimeAccount is missing or inconsistent",
      );
    }
  }

  const profiles = productStore.listAgentProfiles().map((profile) => {
    if (!profile || typeof profile.id !== "string" || profile.id.length === 0) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_PROFILE_MISMATCH",
        "A migrated AgentProfile identity is invalid",
      );
    }
    const binding = runtimeBinding({
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
    });
    if (accountById.get(binding.runtimeAccountId)?.runtime !== binding.runtime) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_PROFILE_MISMATCH",
        "A migrated AgentProfile references the wrong RuntimeAccount",
      );
    }
    return { id: profile.id, ...binding };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

  const runs = productStore.listWorkRuns().map((run) => {
    const profile = profileById.get(run?.profileId);
    if (!profile || typeof run.id !== "string" || run.id.length === 0) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_REF_MISMATCH",
        "A migrated WorkRun identity is invalid",
      );
    }
    let session = null;
    let turn = null;
    try {
      const binding = {
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
      };
      if (run.runtimeSessionRef !== null) {
        session = runtimeSessionRef(binding, run.runtimeSessionRef.sessionId);
        if (JSON.stringify(session) !== JSON.stringify(run.runtimeSessionRef)) throw new Error("ref");
      }
      if (run.runtimeTurnRef !== null) {
        turn = runtimeTurnRef(binding, run.runtimeTurnRef.sessionId, run.runtimeTurnRef.turnId);
        if (JSON.stringify(turn) !== JSON.stringify(run.runtimeTurnRef)) throw new Error("ref");
      }
      if (turn !== null && (session === null || turn.sessionId !== session.sessionId)) {
        throw new Error("turn without session");
      }
    } catch {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_REF_MISMATCH",
        "A migrated WorkRun Runtime ref is inconsistent",
      );
    }
    return { id: run.id, profileId: run.profileId, runtimeSessionRef: session, runtimeTurnRef: turn };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const projection = { accounts, profiles, runs };
  return Object.freeze({
    digest: crypto.createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
    projection,
  });
}

function advanceTo(journal, targetStage, outputDigest) {
  let current = journal.read();
  const target = stageIndex(targetStage);
  while (stageIndex(current.stage) < target) {
    const nextStage = MIGRATION_STAGES[stageIndex(current.stage) + 1];
    current = journal.advance({
      generation: current.generation,
      inputDigest: current.inputDigest,
      nextStage,
      outputDigest: outputDigest ?? undefined,
    });
  }
  return current;
}

function backfillRuntimeSessionOwnership({ productStore, chatSessionStore, ownershipStore }) {
  if (!productStore || typeof productStore.getAgentProfile !== "function"
    || !chatSessionStore || typeof chatSessionStore.listSessions !== "function"
    || !ownershipStore || ["assertOwned", "claim"].some(
      (method) => typeof ownershipStore[method] !== "function",
    )) {
    throw migrationError(
      "RUNTIME_SESSION_OWNERSHIP_BACKFILL_INVALID",
      "Runtime session ownership backfill dependencies are invalid",
    );
  }
  let claimed = 0;
  let unchanged = 0;
  for (const session of chatSessionStore.listSessions()) {
    const runtimeSessionId = session?.runtimeSessionId ?? session?.codexThreadId ?? null;
    if (runtimeSessionId === null) continue;
    const profile = productStore.getAgentProfile(session.profileId);
    if (!profile) {
      throw migrationError(
        "RUNTIME_SESSION_OWNERSHIP_BACKFILL_MISMATCH",
        "A Shoggoth ChatSession references a missing AgentProfile",
      );
    }
    const binding = runtimeBinding({
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
    });
    const status = session.status === "archived" ? "archived" : "active";
    const input = {
      ...binding,
      sessionId: runtimeSessionId,
      profileId: profile.id,
      workspace: session.workspace,
      status,
      createdAt: session.createdAt,
      lastSeenAt: session.updatedAt,
    };
    let existing = null;
    try {
      existing = ownershipStore.assertOwned({
        binding,
        profileId: profile.id,
        sessionId: runtimeSessionId,
        workspace: session.workspace,
      });
    } catch (error) {
      if (error?.code !== "RUNTIME_SESSION_NOT_OWNED") throw error;
    }
    // Runtime ownership can be created after its ChatSession. claim preserves
    // that timestamp, so comparing creation times would rewrite it every boot.
    if (existing && existing.status === status
      && existing.lastSeenAt >= session.updatedAt) {
      unchanged += 1;
      continue;
    }
    ownershipStore.claim(input);
    claimed += 1;
  }
  return Object.freeze({ claimed, unchanged });
}

function migrationIdFor(inputDigest, sessionKey, runtimeSessionId, legacyHomeIdValue) {
  return crypto.createHash("sha256")
    .update("shoggoth-runtime-session-migration-v1\0", "utf8")
    .update(JSON.stringify([inputDigest, sessionKey, runtimeSessionId, legacyHomeIdValue]), "utf8")
    .digest("hex");
}

function legacyHomeForProfile(productStore, profile, sourceVersion) {
  if (profile.id === LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID) return null;
  const account = productStore.getRuntimeAccount(profile.runtimeAccountId);
  if (!account || account.runtime !== profile.runtime) {
    throw migrationError(
      "RUNTIME_SESSION_MIGRATION_PROFILE_MISMATCH",
      "A legacy ChatSession references an invalid RuntimeAccount",
    );
  }
  if (sourceVersion < 7) {
    return legacyHomeId(profile.runtime, profile.runtimeProfileId, profile.runtimeAccountId);
  }
  if (sourceVersion === 7 && account.kind === "shoggoth-managed"
    && profile.runtime === "codex") {
    const legacyAccountId = legacyManagedAccountId(profile.id, profile.runtime);
    return legacyHomeId(profile.runtime, legacyAccountId, profile.runtimeAccountId);
  }
  // Schema v7 native accounts already used their official native Home. Those
  // sessions must not be detached merely because an unrelated older directory
  // with a matching Profile name is still present under stateDir.
  return null;
}

function ownershipIdentity(profile, session, runtimeSessionId) {
  const binding = runtimeBinding({
    runtime: profile.runtime,
    runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId,
  });
  return {
    binding,
    sessionId: runtimeSessionId,
    profileId: profile.id,
    workspace: session.workspace,
  };
}

function retireLegacyOwnership(ownershipStore, profile, session, source) {
  const identity = ownershipIdentity(profile, session, source.runtimeSessionId);
  let record = ownershipStore.readRecord(identity);
  if (!record) {
    ownershipStore.claim({
      ...identity.binding,
      sessionId: identity.sessionId,
      profileId: identity.profileId,
      workspace: identity.workspace,
      status: source.status === "archived" ? "archived" : "active",
      createdAt: source.createdAt,
      lastSeenAt: source.updatedAt,
    });
    record = ownershipStore.readRecord(identity);
  }
  if (record.status !== "deleted") {
    ownershipStore.mark({ ...identity, status: "deleted" });
  }
}

function legacyMigrationMatches(marker, lineage) {
  return marker
    && marker.migrationId === lineage.migrationId
    && marker.sessionKey === lineage.sessionKey
    && marker.chatSessionId === lineage.sessionId
    && marker.profileId === lineage.profileId
    && marker.legacyHomeId === lineage.legacyHomeId
    && marker.legacyRuntimeSessionId === lineage.runtimeSessionId;
}

function legacyHomeLineageMatches(home, entry) {
  return home
    && home.id === entry.id
    && home.runtime === entry.runtime
    && home.runtimeProfileId === entry.runtimeProfileId
    && home.runtimeAccountId === entry.runtimeAccountId
    && home.classification === "managed-reclaimable";
}

function recordLegacySessionMigration(
  ownershipStore,
  profile,
  session,
  lineage,
  transcriptRevision,
) {
  const identity = ownershipIdentity(profile, session, lineage.runtimeSessionId);
  return ownershipStore.recordLegacyMigration({
    ...identity,
    createdAt: lineage.createdAt,
    lastSeenAt: lineage.updatedAt,
    migrationId: lineage.migrationId,
    sessionKey: lineage.sessionKey,
    chatSessionId: lineage.sessionId,
    legacyHomeId: lineage.legacyHomeId,
    transcriptRevision,
  });
}

function semanticTranscriptRevision(transcriptStore, profileId, sessionId) {
  const events = transcriptStore.listEvents(profileId, sessionId);
  if (!events.some((event) => event.kind === "user" || event.kind === "assistant")) return null;
  const revision = transcriptStore.getRevision(profileId, sessionId);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function reconcileLegacyRuntimeSessions(options) {
  const {
    productStore,
    chatSessionStore,
    transcriptStore,
    ownershipStore,
    source,
    inputDigest,
  } = options;
  if (!productStore || [
    "getAgentProfile", "getRuntimeAccount", "listWorkRuns",
  ].some((method) => typeof productStore[method] !== "function")
    || !chatSessionStore || ["getSession", "detachRuntimeSession", "listSessions"]
      .some((method) => typeof chatSessionStore[method] !== "function")
    || !transcriptStore || ["listEvents", "getRevision"].some(
      (method) => typeof transcriptStore[method] !== "function",
    )
    || !ownershipStore || [
      "claim", "mark", "readRecord", "readLegacyMigration", "recordLegacyMigration",
    ].some(
      (method) => typeof ownershipStore[method] !== "function",
    )
    || !source || !Number.isSafeInteger(source.sourceVersion)
    || typeof inputDigest !== "string" || !SHA256_PATTERN.test(inputDigest)) {
    throw migrationError(
      "RUNTIME_SESSION_MIGRATION_INVALID",
      "Legacy Runtime session migration dependencies are invalid",
    );
  }
  const currentSessions = chatSessionStore.listSessions();
  const currentByKey = new Map(currentSessions.map((session) => [session.sessionKey, session]));
  const metadataComplete = source.legacyChatMetadataPresent || currentSessions.length === 0;
  if (!source.legacyChatMetadataPresent) {
    return Object.freeze({
      detached: 0,
      marked: 0,
      retained: metadataComplete ? 0 : currentSessions.length,
      skipped: 0,
      metadataComplete,
      lineages: Object.freeze([]),
    });
  }

  const activeRefs = new Set(productStore.listWorkRuns()
    .filter((run) => ACTIVE_WORK_RUN_STATUSES.has(run.status) && run.runtimeSessionRef !== null)
    .map((run) => `${run.profileId}\0${run.runtimeSessionRef.sessionId}`));
  const lineages = [];
  let detached = 0;
  let marked = 0;
  let retained = 0;
  let skipped = 0;
  for (const legacySession of source.legacyChatSessions) {
    const profile = productStore.getAgentProfile(legacySession.profileId);
    if (!profile) {
      if (currentByKey.has(legacySession.sessionKey)) {
        throw migrationError(
          "RUNTIME_SESSION_MIGRATION_PROFILE_MISMATCH",
          "A live legacy ChatSession references a missing AgentProfile",
        );
      }
      skipped += 1;
      continue;
    }
    const legacyHomeIdValue = legacyHomeForProfile(
      productStore,
      profile,
      source.sourceVersion,
    );
    if (legacyHomeIdValue === null) {
      skipped += 1;
      continue;
    }
    const migrationId = migrationIdFor(
      inputDigest,
      legacySession.sessionKey,
      legacySession.runtimeSessionId,
      legacyHomeIdValue,
    );
    const lineage = Object.freeze({
      ...legacySession,
      legacyHomeId: legacyHomeIdValue,
      migrationId,
    });
    lineages.push(lineage);
    const current = currentByKey.get(legacySession.sessionKey) || null;
    if (!current) {
      retireLegacyOwnership(ownershipStore, profile, legacySession, legacySession);
      skipped += 1;
      continue;
    }
    if (current.profileId !== legacySession.profileId || current.id !== legacySession.sessionId
      || current.workspace !== legacySession.workspace) {
      throw migrationError(
        "RUNTIME_SESSION_MIGRATION_CHAT_MISMATCH",
        "Legacy ChatSession identity changed during RuntimeAccount migration",
      );
    }
    const identity = ownershipIdentity(
      profile,
      current,
      legacySession.runtimeSessionId,
    );
    const existing = ownershipStore.readLegacyMigration(identity);
    if (existing) {
      if (!legacyMigrationMatches(existing, lineage)
        || current.runtimeSessionId === legacySession.runtimeSessionId) {
        throw migrationError(
          "RUNTIME_SESSION_MIGRATION_MARKER_MISMATCH",
          "Legacy Runtime session migration marker does not match its backup lineage",
        );
      }
      if (ownershipStore.readRecord(identity)?.status !== "deleted") {
        throw migrationError(
          "RUNTIME_SESSION_MIGRATION_MARKER_MISMATCH",
          "Legacy Runtime session migration marker is not retired",
        );
      }
      marked += 1;
      continue;
    }
    if (activeRefs.has(`${profile.id}\0${legacySession.runtimeSessionId}`)
      || !["ready", "archived"].includes(current.status)) {
      retained += 1;
      continue;
    }
    const transcriptRevision = semanticTranscriptRevision(
      transcriptStore,
      current.profileId,
      current.id,
    );
    if (transcriptRevision === null) {
      retained += 1;
      continue;
    }
    chatSessionStore.detachRuntimeSession({
      sessionKey: current.sessionKey,
      expectedRuntimeSessionId: legacySession.runtimeSessionId,
    });
    recordLegacySessionMigration(
      ownershipStore,
      profile,
      current,
      lineage,
      transcriptRevision,
    );
    detached += 1;
  }
  lineages.sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
  return Object.freeze({
    detached,
    marked,
    retained,
    skipped,
    metadataComplete,
    lineages: Object.freeze(lineages),
  });
}

class RuntimeAccountMigrationOrchestrator {
  constructor(options = {}) {
    if (!options.paths?.runtimeAccountMigrationPath || !options.paths?.stateDir
      || !options.paths?.trustedRoot) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_PATHS_REQUIRED",
        "Runtime account migration orchestration requires Service paths",
      );
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.now = options.now || Date.now;
    this.verifyBackup = options.verifyBackup || verifyRuntimeSchemaMetadataBackup;
    this.journalFactory = options.journalFactory || (() => new RuntimeAccountMigrationJournal({
      paths: this.paths,
      fs: this.fs,
      now: this.now,
    }));
    this.journal = null;
    this.activeServiceLock = null;
    this.backupReceipt = null;
    this.migrationSource = null;
    this.sessionMigrationResult = null;
    this.sessionRefsChecked = false;
    this.prepared = false;
    this.active = false;
  }

  prepare({ metadataBackup = null, activeServiceLock } = {}) {
    if (this.prepared) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_ALREADY_PREPARED",
        "Runtime account migration orchestration is already prepared",
      );
    }
    this.prepared = true;
    this.activeServiceLock = activeServiceLock;
    const journal = this.journalFactory().open();
    const existing = journal.read();
    if (existing === null && metadataBackup === null) {
      journal.close();
      return Object.freeze({ active: false, stage: null });
    }
    let verified = validateVerifiedBackup(this.verifyBackup({
      paths: this.paths,
      backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
      activeServiceLock,
    }));
    if (metadataBackup !== null
      && metadataBackup?.manifest?.rootDigest !== verified.manifest.rootDigest) {
      journal.close();
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_BACKUP_MISMATCH",
        "Runtime schema backup changed before migration planning",
      );
    }
    const verifiedRootDigest = verified.manifest.rootDigest;
    const source = inspectMigrationSource(this.paths, verified, this.fs);
    verified = validateVerifiedBackup(this.verifyBackup({
      paths: this.paths,
      backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
      activeServiceLock,
    }));
    if (verified.manifest.rootDigest !== verifiedRootDigest) {
      journal.close();
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_BACKUP_MISMATCH",
        "Runtime schema backup changed during migration planning",
      );
    }
    const generation = backupGeneration(verified.manifest);
    if (existing === null && !source.needsRuntimeAccountMigration) {
      journal.close();
      return Object.freeze({ active: false, stage: null });
    }
    if (existing === null) {
      journal.plan({
        generation,
        inputDigest: verified.manifest.rootDigest,
        legacyHomes: source.legacyHomes,
      });
    } else if (existing.generation !== generation
      || existing.inputDigest !== verified.manifest.rootDigest
      || (stageIndex(existing.stage) < stageIndex("cleanup_eligible")
        && JSON.stringify(existing.legacyHomes) !== JSON.stringify(source.legacyHomes))) {
      journal.close();
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_BACKUP_MISMATCH",
        "Runtime account migration journal does not match its metadata backup",
      );
    }
    this.journal = journal;
    this.active = true;
    this.migrationSource = source;
    this.backupReceipt = Object.freeze({
      backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
      backupPath: verified.backupPath,
      generation,
      rootDigest: verified.manifest.rootDigest,
      readOnly: true,
    });
    advanceTo(this.journal, "metadata_backed_up");
    return this.status();
  }

  reconcileAccountsAndProfiles(productStore) {
    if (!this.active) return this.status();
    const canonical = canonicalProductProjection(productStore);
    const current = this.journal.read();
    if (current.outputDigest !== null && current.outputDigest !== canonical.digest
      && stageIndex(current.stage) < stageIndex("cleanup_eligible")) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_OUTPUT_MISMATCH",
        "Migrated RuntimeAccount metadata differs from the journaled output",
      );
    }
    if (stageIndex(current.stage) < stageIndex("profiles_rebound")) {
      advanceTo(this.journal, "profiles_rebound", canonical.digest);
    }
    return this.status();
  }

  backfillOwnership(input) {
    return backfillRuntimeSessionOwnership(input);
  }

  reconcileLegacyRuntimeSessions(input) {
    if (!this.active) {
      this.sessionRefsChecked = true;
      this.sessionMigrationResult = Object.freeze({
        detached: 0,
        marked: 0,
        retained: 0,
        skipped: 0,
        metadataComplete: true,
        lineages: Object.freeze([]),
      });
      return this.sessionMigrationResult;
    }
    const current = this.journal.read();
    if (stageIndex(current.stage) < stageIndex("profiles_rebound")) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_STAGE_CONFLICT",
        "Runtime sessions cannot be reconciled before Profile bindings",
      );
    }
    const resultValue = reconcileLegacyRuntimeSessions({
      ...input,
      source: this.migrationSource,
      inputDigest: current.inputDigest,
    });
    this.sessionMigrationResult = resultValue;
    this.sessionRefsChecked = true;
    return Object.freeze({
      detached: resultValue.detached,
      marked: resultValue.marked,
      retained: resultValue.retained,
      skipped: resultValue.skipped,
      metadataComplete: resultValue.metadataComplete,
    });
  }

  legacyHomePersistentReferences(entry, input) {
    if (!this.active) return Object.freeze(["legacy-session-lineage-unavailable"]);
    if (!exactObject(entry, PERSISTENT_REFERENCE_ENTRY_FIELDS)
      || typeof entry.id !== "string" || !LEGACY_HOME_ID_PATTERN.test(entry.id)
      || !validRuntime(entry.runtime) || !validRuntimeProfileId(entry.runtimeProfileId)
      || !validRuntimeAccountId(entry.runtimeAccountId)
      || !Array.isArray(entry.profileIds) || entry.profileIds.length > 10_000
      || entry.profileIds.some((profileId) => typeof profileId !== "string"
        || profileId.length === 0 || !profileId.isWellFormed() || profileId.includes("\0"))) {
      throw migrationError(
        "RUNTIME_SESSION_MIGRATION_INVALID",
        "Legacy Home persistent-reference query is invalid",
      );
    }
    const sourceHome = this.migrationSource?.legacyHomes
      .find((home) => home.id === entry.id) || null;
    const journalHome = this.journal.read()?.legacyHomes
      .find((home) => home.id === entry.id) || null;
    if (!legacyHomeLineageMatches(sourceHome, entry)
      || !legacyHomeLineageMatches(journalHome, entry)
      || JSON.stringify(sourceHome) !== JSON.stringify(journalHome)) {
      return Object.freeze(["legacy-home-lineage-unavailable"]);
    }
    if (!this.sessionRefsChecked || !this.sessionMigrationResult) {
      return Object.freeze(["legacy-session-lineage-unreconciled"]);
    }
    if (!this.sessionMigrationResult.metadataComplete) {
      return Object.freeze(["legacy-session-metadata-incomplete"]);
    }
    const { productStore, chatSessionStore, ownershipStore } = input || {};
    if (!productStore || typeof productStore.getAgentProfile !== "function"
      || !chatSessionStore || typeof chatSessionStore.getSession !== "function"
      || !ownershipStore || ["readRecord", "readLegacyMigration"].some(
        (method) => typeof ownershipStore[method] !== "function",
      )) {
      throw migrationError(
        "RUNTIME_SESSION_MIGRATION_INVALID",
        "Legacy Home persistent-reference dependencies are invalid",
      );
    }
    const reasons = new Set();
    for (const lineage of this.sessionMigrationResult.lineages) {
      if (lineage.legacyHomeId !== entry.id) continue;
      const current = chatSessionStore.getSession(lineage.sessionKey);
      const profile = productStore.getAgentProfile(lineage.profileId);
      if (!profile) {
        reasons.add("persistent-profile-reference-unverifiable");
        continue;
      }
      const identity = ownershipIdentity(
        profile,
        current || lineage,
        lineage.runtimeSessionId,
      );
      const ownership = ownershipStore.readRecord(identity);
      const marker = ownershipStore.readLegacyMigration(identity);
      const oldRefDetached = !current
        || current.runtimeSessionId !== lineage.runtimeSessionId;
      if (legacyMigrationMatches(marker, lineage)
        && ownership?.status === "deleted" && oldRefDetached) continue;
      if (!current && ownership?.status === "deleted") continue;
      if (current) reasons.add("persistent-chat-session");
      if (!ownership || ownership.status !== "deleted") {
        reasons.add("persistent-runtime-session-ownership");
      }
    }
    return Object.freeze([...reasons].sort());
  }

  reconcileRuntimeRefs(productStore) {
    if (!this.active) return this.status();
    const current = this.journal.read();
    if (stageIndex(current.stage) < stageIndex("profiles_rebound")) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_STAGE_CONFLICT",
        "Runtime refs cannot be reconciled before Profile bindings",
      );
    }
    if (!this.sessionRefsChecked) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_STAGE_CONFLICT",
        "Runtime refs cannot be reconciled before legacy ChatSession lineage",
      );
    }
    const canonical = canonicalProductProjection(productStore);
    if (current.outputDigest !== null && current.outputDigest !== canonical.digest
      && stageIndex(current.stage) < stageIndex("cleanup_eligible")) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_OUTPUT_MISMATCH",
        "Migrated Runtime refs differ from the journaled output",
      );
    }
    if (stageIndex(current.stage) < stageIndex("runtime_refs_reconciled")) {
      advanceTo(this.journal, "runtime_refs_reconciled", canonical.digest);
    }
    return this.status();
  }

  markServiceReady() {
    if (!this.active) return this.status();
    const current = this.journal.read();
    if (stageIndex(current.stage) < stageIndex("runtime_refs_reconciled")) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_STAGE_CONFLICT",
        "Service cannot verify migration before Runtime refs are reconciled",
      );
    }
    advanceTo(this.journal, "cleanup_eligible", current.outputDigest);
    return this.status();
  }

  rollbackVerificationReceipt() {
    if (!this.active || this.backupReceipt === null) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_NOT_ACTIVE",
        "No Runtime account migration backup is active",
      );
    }
    return Object.freeze({ ...this.backupReceipt });
  }

  status() {
    if (!this.active) return Object.freeze({ active: false, stage: null });
    const current = this.journal.read();
    return Object.freeze({
      active: true,
      stage: current.stage,
      generation: current.generation,
      inputDigest: current.inputDigest,
      outputDigest: current.outputDigest,
      legacyHomes: Object.freeze(current.legacyHomes.map((home) => Object.freeze(home))),
    });
  }

  close() {
    if (this.journal !== null) this.journal.close();
    this.journal = null;
    this.active = false;
    this.prepared = false;
    this.activeServiceLock = null;
    this.backupReceipt = null;
    this.migrationSource = null;
    this.sessionMigrationResult = null;
    this.sessionRefsChecked = false;
  }
}

module.exports = {
  RuntimeAccountMigrationOrchestrator,
  backfillRuntimeSessionOwnership,
  canonicalProductProjection,
  inspectMigrationSource,
  legacyChatSessionsFromBackup,
  reconcileLegacyRuntimeSessions,
};
