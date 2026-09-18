"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("./runtime-account");
const {
  fsyncPrivateParent,
  openExistingPrivateFile,
  statIfExists,
  validateDirectoryStat,
  validatePrivateStat,
} = require("./private-file");
const {
  LEGACY_CODEX_API_KEY_MIGRATION_STAGES, LegacyCodexApiKeyMigrationJournal,
} = require("./legacy-codex-api-key-migration-journal");
const { resolveNativeHome, runtimePathsOverlap } = require("./runtime-account-resolver");
const { serviceError } = require("./security");

const LEGACY_CODEX_AUTH_BASENAME = "auth.json";
const LEGACY_CODEX_AUTH_QUARANTINE_BASENAME = ".auth.json.shoggoth-api-key-migration-v1";
const MAX_LEGACY_CODEX_AUTH_BYTES = 128 * 1024;
const MIGRATED_CREDENTIAL_PREFIX = "provider-credential-legacy-codex-";

function migrationError(code, message) {
  return serviceError(code, message);
}

function migrationFailure(error) {
  if (String(error?.code || "").startsWith("LEGACY_CODEX_API_KEY_MIGRATION_")) return error;
  if (String(error?.code || "").endsWith("COMMIT_UNCERTAIN")) {
    return migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_COMMIT_UNCERTAIN",
      "Legacy Codex API key migration commit is uncertain",
    );
  }
  return migrationError(
    "LEGACY_CODEX_API_KEY_MIGRATION_FAILED",
    "Legacy Codex API key migration failed",
  );
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameFileSnapshot(left, right) {
  return sameIdentity(left, right) && left?.size === right?.size
    && left?.mtimeMs === right?.mtimeMs && left?.ctimeMs === right?.ctimeMs;
}

function boundedPrivateFile(fileSystem, target) {
  let fd;
  const bytes = Buffer.alloc(MAX_LEGACY_CODEX_AUTH_BYTES + 1);
  try {
    fd = openExistingPrivateFile(target, fileSystem.constants.O_RDONLY, fileSystem);
    const before = validatePrivateStat(fileSystem.fstatSync(fd), target);
    if (!Number.isSafeInteger(before.size) || before.size < 0
      || before.size > MAX_LEGACY_CODEX_AUTH_BYTES) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_INVALID",
        "Legacy Codex auth file is invalid",
      );
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = fileSystem.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw migrationError(
          "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_INVALID",
          "Legacy Codex auth file is invalid",
        );
      }
      if (count === 0) break;
      offset += count;
    }
    const after = validatePrivateStat(fileSystem.fstatSync(fd), target);
    if (offset > MAX_LEGACY_CODEX_AUTH_BYTES || !sameIdentity(before, after)
      || before.size !== after.size || after.size !== offset
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_INVALID",
        "Legacy Codex auth file is invalid",
      );
    }
    return {
      bytes: Buffer.from(bytes.subarray(0, offset)),
      identity: {
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
      },
    };
  } catch (error) {
    throw migrationFailure(error);
  } finally {
    bytes.fill(0);
    if (fd !== undefined) fileSystem.closeSync(fd);
  }
}

function parseAuthRecord(bytes) {
  let text = null;
  let roundTrip = null;
  try {
    text = bytes.toString("utf8");
    roundTrip = Buffer.from(text, "utf8");
    if (!roundTrip.equals(bytes)) throw new Error("invalid utf8");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid object");
    if (value.auth_mode === "chatgpt") {
      if (!Object.prototype.hasOwnProperty.call(value, "auth_mode")
        || (Object.prototype.hasOwnProperty.call(value, "OPENAI_API_KEY")
          && value.OPENAI_API_KEY !== null)) {
        throw new Error("mixed credential authority");
      }
      return { kind: "chatgpt", secret: null };
    }
    const fields = Object.keys(value);
    if (value.auth_mode !== "apikey" || fields.length !== 2
      || !Object.prototype.hasOwnProperty.call(value, "auth_mode")
      || !Object.prototype.hasOwnProperty.call(value, "OPENAI_API_KEY")
      || typeof value.OPENAI_API_KEY !== "string" || value.OPENAI_API_KEY.length === 0
      || value.OPENAI_API_KEY.includes("\0") || !value.OPENAI_API_KEY.isWellFormed()
      || Buffer.byteLength(value.OPENAI_API_KEY, "utf8") > 64 * 1024) {
      throw new Error("non-canonical api key auth");
    }
    return { kind: "apikey", secret: value.OPENAI_API_KEY };
  } catch {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_INVALID",
      "Legacy Codex auth file is invalid",
    );
  } finally {
    if (roundTrip) roundTrip.fill(0);
    text = null;
    bytes.fill(0);
  }
}

function readAuthRecord(fileSystem, target) {
  const loaded = boundedPrivateFile(fileSystem, target);
  const parsed = parseAuthRecord(loaded.bytes);
  return { ...parsed, identity: loaded.identity };
}

function assertLegacyRuntimeProfileId(runtimeProfileId) {
  if (typeof runtimeProfileId !== "string" || runtimeProfileId.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runtimeProfileId)) {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_INVALID",
      "Legacy Codex API key owner is invalid",
    );
  }
  return runtimeProfileId;
}

function legacyPaths(paths, runtimeProfileId) {
  assertLegacyRuntimeProfileId(runtimeProfileId);
  const base = path.join(paths.stateDir, "codex");
  const home = path.join(base, runtimeProfileId);
  if (path.relative(base, home) !== runtimeProfileId) {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_INVALID",
      "Legacy Codex API key owner is invalid",
    );
  }
  return {
    base,
    home,
    auth: path.join(home, LEGACY_CODEX_AUTH_BASENAME),
    quarantine: path.join(home, LEGACY_CODEX_AUTH_QUARANTINE_BASENAME),
  };
}

function inspectLegacyAuth(fileSystem, paths, runtimeProfileId) {
  const targets = legacyPaths(paths, runtimeProfileId);
  try {
    const baseStat = statIfExists(fileSystem, targets.base);
    if (!baseStat) return { ...targets, source: "absent", record: null };
    validateDirectoryStat(baseStat, targets.base);
    const homeStat = statIfExists(fileSystem, targets.home);
    if (!homeStat) return { ...targets, source: "absent", record: null };
    validateDirectoryStat(homeStat, targets.home);
    const authStat = statIfExists(fileSystem, targets.auth);
    const quarantineStat = statIfExists(fileSystem, targets.quarantine);
    if (authStat && quarantineStat) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_CONFLICT",
        "Legacy Codex auth migration evidence is ambiguous",
      );
    }
    if (authStat) {
      return { ...targets, source: "auth", record: readAuthRecord(fileSystem, targets.auth) };
    }
    if (quarantineStat) {
      const record = readAuthRecord(fileSystem, targets.quarantine);
      if (record.kind !== "apikey") {
        throw migrationError(
          "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_INVALID",
          "Legacy Codex auth quarantine is invalid",
        );
      }
      return { ...targets, source: "quarantine", record };
    }
    return { ...targets, source: "absent", record: null };
  } catch (error) {
    throw migrationFailure(error);
  }
}

function deterministicCredentialRef(profileId, providerId) {
  const digest = crypto.createHash("sha256")
    .update("shoggoth-legacy-codex-api-key-v1\0", "utf8")
    .update(JSON.stringify([profileId, providerId]), "utf8")
    .digest("hex");
  return `${MIGRATED_CREDENTIAL_PREFIX}${digest}`;
}

function listLegacyProfiles(productStore) {
  let profiles;
  try { profiles = productStore.listAgentProfiles(); } catch (error) { throw migrationFailure(error); }
  if (!Array.isArray(profiles)) {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_INVALID",
      "Legacy Codex API key owner is invalid",
    );
  }
  const candidates = profiles.filter((profile) => profile && typeof profile === "object"
    && !Array.isArray(profile) && profile.backendId === "shoggoth" && profile.runtime === "codex")
    .sort((left, right) => left.id.localeCompare(right.id));
  const runtimeProfileIds = new Set();
  for (const profile of candidates) {
    assertLegacyRuntimeProfileId(profile.runtimeProfileId);
    if (runtimeProfileIds.has(profile.runtimeProfileId)) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_AMBIGUOUS",
        "Legacy Codex API key does not have one Profile owner",
      );
    }
    runtimeProfileIds.add(profile.runtimeProfileId);
  }
  return candidates;
}

function assertNativeCodexHomeSeparated(fileSystem, paths, profiles, options = {}) {
  const configuredHome = options.homedir ?? os.homedir;
  let userHome;
  try { userHome = typeof configuredHome === "function" ? configuredHome() : configuredHome; } catch {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_NATIVE_HOME_INVALID",
      "Native Codex Home could not be resolved safely",
    );
  }
  if (typeof userHome !== "string" || !path.isAbsolute(userHome) || userHome.includes("\0")) {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_NATIVE_HOME_INVALID",
      "Native Codex Home could not be resolved safely",
    );
  }
  let nativeHome;
  try {
    nativeHome = resolveNativeHome(
      fileSystem,
      options.parentEnv ?? process.env,
      path.resolve(userHome),
      "codex",
    );
  } catch {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_NATIVE_HOME_INVALID",
      "Native Codex Home could not be resolved safely",
    );
  }
  const base = path.join(paths.stateDir, "codex");
  const baseStat = statIfExists(fileSystem, base);
  if (!baseStat) return;
  validateDirectoryStat(baseStat, base);
  const runtimeProfileIds = new Set(profiles.map((profile) => profile.runtimeProfileId));
  let names;
  try { names = fileSystem.readdirSync(base); } catch {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_HOME_INVALID",
      "Legacy Codex Homes could not be inspected safely",
    );
  }
  for (const name of names) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) runtimeProfileIds.add(name);
  }
  for (const runtimeProfileId of runtimeProfileIds) {
    const { home } = legacyPaths(paths, runtimeProfileId);
    const homeStat = statIfExists(fileSystem, home);
    if (!homeStat) continue;
    validateDirectoryStat(homeStat, home);
    let canonicalHome;
    try { canonicalHome = fileSystem.realpathSync(home); } catch {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_HOME_INVALID",
        "Legacy Codex Home could not be resolved safely",
      );
    }
    if (runtimePathsOverlap(nativeHome, canonicalHome)) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_NATIVE_HOME_CONFLICT",
        "Native and legacy Shoggoth Codex Homes overlap",
      );
    }
  }
}

function resolveEntryOwner(productStore, profiles, entry) {
  const profile = profiles.find((candidate) => candidate.id === entry.profileId);
  if (!profile || profile.runtimeProfileId !== entry.runtimeProfileId
    || profile.runtimeAccountId !== SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
    || profile.providerRef !== entry.providerId) {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_AMBIGUOUS",
      "Legacy Codex API key does not have one Profile owner",
    );
  }
  const bindings = profiles.filter((candidate) => candidate.providerRef === entry.providerId);
  if (bindings.length !== 1 || bindings[0].id !== profile.id) {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_AMBIGUOUS",
      "Legacy Codex API key does not have one Profile owner",
    );
  }
  let provider;
  try { provider = productStore.getModelProvider(entry.providerId); } catch (error) {
    throw migrationFailure(error);
  }
  if (!provider || provider.kind !== "openai-api-key") {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_AMBIGUOUS",
      "Legacy Codex API key does not have one Profile owner",
    );
  }
  return { profile, provider };
}

function secretsEqual(left, right) {
  const leftBytes = Buffer.from(typeof left === "string" ? left : "", "utf8");
  const rightBytes = Buffer.from(typeof right === "string" ? right : "", "utf8");
  try {
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function credentialMetadata(secretStore, credentialRef) {
  let metadata;
  try { metadata = secretStore.listMetadata(); } catch (error) { throw migrationFailure(error); }
  if (!Array.isArray(metadata)) {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_SECRET_INVALID",
      "Legacy Codex API key encrypted credential is invalid",
    );
  }
  const matches = metadata.filter((entry) => entry?.credentialRef === credentialRef);
  if (matches.length > 1 || (matches.length === 1 && matches[0].kind !== "openai-api-key")) {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_SECRET_INVALID",
      "Legacy Codex API key encrypted credential is invalid",
    );
  }
  return matches[0] || null;
}

async function readCredential(secretStore, credentialRef) {
  if (!credentialMetadata(secretStore, credentialRef)) return null;
  let secret;
  try { secret = await secretStore.get(credentialRef); } catch (error) { throw migrationFailure(error); }
  if (typeof secret !== "string" || secret.length === 0) {
    secret = null;
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_SECRET_INVALID",
      "Legacy Codex API key encrypted credential is invalid",
    );
  }
  return secret;
}

async function selectCredentialRef(secretStore, owner, sourceSecret) {
  if (owner.provider.credentialRef === null) {
    const credentialRef = deterministicCredentialRef(owner.profile.id, owner.provider.id);
    let existing = null;
    try {
      existing = await readCredential(secretStore, credentialRef);
      if (existing !== null && !secretsEqual(existing, sourceSecret)) {
        throw migrationError(
          "LEGACY_CODEX_API_KEY_MIGRATION_EXISTING_CREDENTIAL_CONFLICT",
          "OpenAI Provider already has a conflicting credential",
        );
      }
      return credentialRef;
    } finally {
      existing = null;
    }
  }
  if (typeof owner.provider.credentialRef !== "string") {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_EXISTING_CREDENTIAL_CONFLICT",
      "OpenAI Provider already has a conflicting credential",
    );
  }
  let existing = null;
  try {
    existing = await readCredential(secretStore, owner.provider.credentialRef);
    if (!secretsEqual(existing, sourceSecret)) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_EXISTING_CREDENTIAL_CONFLICT",
        "OpenAI Provider already has a conflicting credential",
      );
    }
    return owner.provider.credentialRef;
  } finally {
    existing = null;
  }
}

function advanceJournalEntryTo(journal, profileId, target) {
  let current = journal.read().entries.find((entry) => entry.profileId === profileId);
  if (!current) {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_STAGE_CONFLICT",
      "Legacy Codex API key migration stage is invalid",
    );
  }
  const targetIndex = LEGACY_CODEX_API_KEY_MIGRATION_STAGES.indexOf(target);
  while (LEGACY_CODEX_API_KEY_MIGRATION_STAGES.indexOf(current.stage) < targetIndex) {
    const currentIndex = LEGACY_CODEX_API_KEY_MIGRATION_STAGES.indexOf(current.stage);
    const recorded = journal.advance(
      profileId,
      LEGACY_CODEX_API_KEY_MIGRATION_STAGES[currentIndex + 1],
    );
    current = recorded.entries.find((entry) => entry.profileId === profileId);
  }
  return current;
}

async function ensureEncryptedCredential(secretStore, credentialRef, sourceSecret) {
  let stored = null;
  try {
    stored = await readCredential(secretStore, credentialRef);
    if (stored === null) {
      if (typeof sourceSecret !== "string") {
        throw migrationError(
          "LEGACY_CODEX_API_KEY_MIGRATION_SECRET_MISSING",
          "Legacy Codex API key encrypted credential is missing",
        );
      }
      try {
        await secretStore.put(credentialRef, sourceSecret, { kind: "openai-api-key" });
      } catch (error) {
        throw migrationFailure(error);
      }
      stored = await readCredential(secretStore, credentialRef);
    }
    if (typeof sourceSecret === "string" && !secretsEqual(stored, sourceSecret)) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_EXISTING_CREDENTIAL_CONFLICT",
        "OpenAI Provider already has a conflicting credential",
      );
    }
  } finally {
    stored = null;
  }
}

function bindProviderCredential(productStore, owner, credentialRef) {
  let current;
  try { current = productStore.getModelProvider(owner.provider.id); } catch (error) {
    throw migrationFailure(error);
  }
  if (!current || current.kind !== "openai-api-key") {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_INVALID",
      "Legacy Codex API key owner is invalid",
    );
  }
  if (current.credentialRef !== null && current.credentialRef !== credentialRef) {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_EXISTING_CREDENTIAL_CONFLICT",
      "OpenAI Provider already has a conflicting credential",
    );
  }
  if (current.credentialRef === null) {
    try {
      current = productStore.putModelProvider({
        ...current,
        credentialRef,
        validationStatus: "unverified",
      });
    } catch (error) {
      throw migrationFailure(error);
    }
  }
  if (current?.credentialRef !== credentialRef || current.kind !== "openai-api-key") {
    throw migrationError(
      "LEGACY_CODEX_API_KEY_MIGRATION_PROVIDER_COMMIT_FAILED",
      "Legacy Codex API key Provider binding failed",
    );
  }
}

function moveAuthToQuarantine(fileSystem, state) {
  try {
    if (statIfExists(fileSystem, state.quarantine)) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_CONFLICT",
        "Legacy Codex auth migration evidence is ambiguous",
      );
    }
    const current = validatePrivateStat(fileSystem.lstatSync(state.auth), state.auth);
    if (!sameFileSnapshot(current, state.record.identity)) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_CHANGED",
        "Legacy Codex auth file changed during migration",
      );
    }
    fileSystem.renameSync(state.auth, state.quarantine);
    const moved = validatePrivateStat(fileSystem.lstatSync(state.quarantine), state.quarantine);
    if (!sameIdentity(moved, state.record.identity)) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_CHANGED",
        "Legacy Codex auth file changed during migration",
      );
    }
    fsyncPrivateParent(state.home, fileSystem);
  } catch (error) {
    throw migrationFailure(error);
  }
}

function deleteQuarantinedAuth(fileSystem, state) {
  try {
    const current = validatePrivateStat(fileSystem.lstatSync(state.quarantine), state.quarantine);
    if (!sameFileSnapshot(current, state.record.identity)) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_CHANGED",
        "Legacy Codex auth quarantine changed during migration",
      );
    }
    fileSystem.unlinkSync(state.quarantine);
    fsyncPrivateParent(state.home, fileSystem);
  } catch (error) {
    throw migrationFailure(error);
  }
}

function inspectProfileSources(fileSystem, paths, profiles, recorded = null) {
  const runtimeProfileIds = new Set(profiles.map((profile) => profile.runtimeProfileId));
  for (const entry of recorded?.entries || []) runtimeProfileIds.add(entry.runtimeProfileId);
  return new Map([...runtimeProfileIds].sort().map((runtimeProfileId) => [
    runtimeProfileId,
    inspectLegacyAuth(fileSystem, paths, runtimeProfileId),
  ]));
}

function clearSourceSecrets(sources) {
  for (const source of sources?.values?.() || []) {
    if (source.record) source.record.secret = null;
  }
}

function validateRecordedCoverage(recorded, sources) {
  const byRuntimeProfileId = new Map(
    recorded.entries.map((entry) => [entry.runtimeProfileId, entry]),
  );
  for (const [runtimeProfileId, source] of sources) {
    const entry = byRuntimeProfileId.get(runtimeProfileId) || null;
    if (!entry) {
      if (source.source === "absent" || source.record?.kind === "chatgpt") continue;
      throw migrationError(
        source.source === "auth"
          ? "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_REAPPEARED"
          : "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_CONFLICT",
        "Unplanned legacy Codex API key auth appeared during migration",
      );
    }
    if (entry.stage === "complete") {
      const freshChatGptAuth = source.source === "auth" && source.record?.kind === "chatgpt";
      if (source.source !== "absent" && !freshChatGptAuth) {
        throw migrationError(
          "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_REAPPEARED",
          "Legacy Codex API key auth reappeared after migration",
        );
      }
    } else if (source.record?.kind === "chatgpt") {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_CONFLICT",
        "Legacy Codex auth authority changed during migration",
      );
    }
  }
}

async function planInitialMigrations(productStore, secretStore, profiles, sources) {
  const entries = [];
  const credentialRefs = new Set();
  for (const profile of profiles) {
    const source = sources.get(profile.runtimeProfileId);
    if (source.source === "quarantine") {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_CONFLICT",
        "Legacy Codex auth migration evidence is ambiguous",
      );
    }
    if (source.record?.kind !== "apikey") continue;
    const seed = {
      profileId: profile.id,
      providerId: profile.providerRef,
      runtimeProfileId: profile.runtimeProfileId,
    };
    const owner = resolveEntryOwner(productStore, profiles, seed);
    const credentialRef = await selectCredentialRef(
      secretStore,
      owner,
      source.record.secret,
    );
    source.record.secret = null;
    if (credentialRefs.has(credentialRef)) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_AMBIGUOUS",
        "Legacy Codex API key does not have one Profile owner",
      );
    }
    credentialRefs.add(credentialRef);
    entries.push({ ...seed, credentialRef });
  }
  return entries;
}

async function migrateJournalEntry(options) {
  const { fileSystem, journal, paths, productStore, secretStore } = options;
  let entry = options.entry;
  let source = null;
  let sourceSecret = null;
  let storedSecret = null;
  try {
    const profiles = listLegacyProfiles(productStore);
    const owner = resolveEntryOwner(productStore, profiles, entry);
    source = inspectLegacyAuth(fileSystem, paths, entry.runtimeProfileId);
    if (source.record?.kind === "chatgpt") {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_CONFLICT",
        "Legacy Codex auth authority changed during migration",
      );
    }
    sourceSecret = source.record?.secret ?? null;
    await ensureEncryptedCredential(secretStore, entry.credentialRef, sourceSecret);
    entry = advanceJournalEntryTo(journal, entry.profileId, "secret_stored");

    const currentProfiles = listLegacyProfiles(productStore);
    const currentOwner = resolveEntryOwner(productStore, currentProfiles, entry);
    bindProviderCredential(productStore, currentOwner, entry.credentialRef);
    entry = advanceJournalEntryTo(journal, entry.profileId, "provider_bound");

    if (source?.record) source.record.secret = null;
    source = inspectLegacyAuth(fileSystem, paths, entry.runtimeProfileId);
    if (source.record?.kind === "chatgpt") {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_CONFLICT",
        "Legacy Codex auth authority changed during migration",
      );
    }
    sourceSecret = source.record?.secret ?? null;
    storedSecret = await readCredential(secretStore, entry.credentialRef);
    if (storedSecret === null
      || (sourceSecret !== null && !secretsEqual(storedSecret, sourceSecret))) {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_EXISTING_CREDENTIAL_CONFLICT",
        "OpenAI Provider already has a conflicting credential",
      );
    }
    if (source.source === "auth") {
      moveAuthToQuarantine(fileSystem, source);
      entry = advanceJournalEntryTo(journal, entry.profileId, "auth_quarantined");
      source.record.secret = null;
      source = inspectLegacyAuth(fileSystem, paths, entry.runtimeProfileId);
      sourceSecret = source.record?.secret ?? null;
    }
    if (source.source === "quarantine") {
      if (!secretsEqual(storedSecret, sourceSecret)) {
        throw migrationError(
          "LEGACY_CODEX_API_KEY_MIGRATION_EXISTING_CREDENTIAL_CONFLICT",
          "OpenAI Provider already has a conflicting credential",
        );
      }
      entry = advanceJournalEntryTo(journal, entry.profileId, "auth_quarantined");
      deleteQuarantinedAuth(fileSystem, source);
      source.record.secret = null;
      source = inspectLegacyAuth(fileSystem, paths, entry.runtimeProfileId);
    }
    if (source.source !== "absent") {
      throw migrationError(
        "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_DELETE_FAILED",
        "Legacy Codex API key auth file could not be removed",
      );
    }
    fsyncPrivateParent(source.home, fileSystem);
    return advanceJournalEntryTo(journal, entry.profileId, "complete");
  } finally {
    sourceSecret = null;
    storedSecret = null;
    if (source?.record) source.record.secret = null;
  }
}

function migrationResult(status, entries) {
  const only = entries.length === 1 ? entries[0] : null;
  return Object.freeze({
    status,
    profileId: only?.profileId ?? null,
    providerId: only?.providerId ?? null,
  });
}

async function migrateLegacySharedCodexApiKey(options = {}) {
  const { paths, productStore, secretStore } = options;
  const fileSystem = options.fs || fs;
  const journal = new LegacyCodexApiKeyMigrationJournal({
    paths,
    fs: fileSystem,
    now: options.now,
    atomicWrite: options.atomicWrite,
  });
  let sources = null;
  try {
    const profiles = listLegacyProfiles(productStore);
    const homeOptions = { parentEnv: options.parentEnv, homedir: options.homedir };
    journal.open();
    let recorded = journal.read();
    sources = inspectProfileSources(fileSystem, paths, profiles, recorded);
    const hasMigrationSource = recorded?.entries.some((entry) => entry.stage !== "complete")
      || [...sources.values()].some((source) => source.record?.kind === "apikey");
    if (hasMigrationSource) {
      const knownRuntimeProfileIds = new Set(profiles.map((profile) => profile.runtimeProfileId));
      const recordedOnlyProfiles = (recorded?.entries || [])
        .filter((entry) => !knownRuntimeProfileIds.has(entry.runtimeProfileId))
        .map((entry) => ({ runtimeProfileId: entry.runtimeProfileId }));
      assertNativeCodexHomeSeparated(
        fileSystem,
        paths,
        [...profiles, ...recordedOnlyProfiles],
        homeOptions,
      );
    }
    if (recorded === null) {
      const entries = await planInitialMigrations(productStore, secretStore, profiles, sources);
      clearSourceSecrets(sources);
      if (entries.length === 0) return migrationResult("not_applicable", []);
      recorded = journal.plan(entries);
    } else {
      validateRecordedCoverage(recorded, sources);
    }

    const hadIncompleteEntry = recorded.entries.some((entry) => entry.stage !== "complete");
    for (const entry of recorded.entries) {
      if (entry.stage === "complete") continue;
      await migrateJournalEntry({
        entry,
        fileSystem,
        journal,
        paths,
        productStore,
        secretStore,
      });
    }
    recorded = journal.read();
    clearSourceSecrets(sources);
    sources = inspectProfileSources(fileSystem, paths, listLegacyProfiles(productStore), recorded);
    validateRecordedCoverage(recorded, sources);
    return migrationResult(hadIncompleteEntry ? "migrated" : "complete", recorded.entries);
  } catch (error) {
    throw migrationFailure(error);
  } finally {
    clearSourceSecrets(sources);
    journal.close();
  }
}

module.exports = {
  LEGACY_CODEX_AUTH_BASENAME,
  LEGACY_CODEX_AUTH_QUARANTINE_BASENAME,
  MAX_LEGACY_CODEX_AUTH_BYTES,
  MIGRATED_CREDENTIAL_PREFIX,
  deterministicCredentialRef,
  migrateLegacySharedCodexApiKey,
};
