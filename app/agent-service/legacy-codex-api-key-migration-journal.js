"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  preparePrivateParent,
  readPrivateFile,
  recoverInterruptedPrivateFile,
  statIfExists,
} = require("./private-file");
const { serviceError } = require("./security");

const LEGACY_CODEX_API_KEY_MIGRATION_VERSION = 1;
const LEGACY_CODEX_API_KEY_MIGRATION_STAGES = Object.freeze([
  "planned",
  "secret_stored",
  "provider_bound",
  "auth_quarantined",
  "complete",
]);
const MAX_LEGACY_CODEX_API_KEY_MIGRATION_ENTRIES = 2_048;
const MAX_LEGACY_CODEX_API_KEY_JOURNAL_BYTES = 1024 * 1024;
const JOURNAL_FIELDS = Object.freeze(["version", "entries", "updatedAt"]);
const ENTRY_FIELDS = Object.freeze([
  "stage", "profileId", "providerId", "runtimeProfileId", "credentialRef", "updatedAt",
]);

function journalError(code, message) {
  return serviceError(code, message);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value.isWellFormed() && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= 1024;
}

function validRuntimeProfileId(value) {
  return typeof value === "string" && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function validCredentialRef(value) {
  return typeof value === "string" && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function normalizeEntry(value) {
  if (!exactObject(value, ENTRY_FIELDS)
    || !LEGACY_CODEX_API_KEY_MIGRATION_STAGES.includes(value.stage)
    || !validIdentity(value.profileId) || !validIdentity(value.providerId)
    || !validRuntimeProfileId(value.runtimeProfileId)
    || !validCredentialRef(value.credentialRef)
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) {
    throw journalError(
      "LEGACY_CODEX_API_KEY_MIGRATION_JOURNAL_CORRUPT",
      "Legacy Codex API key migration journal is corrupt",
    );
  }
  return {
    stage: value.stage,
    profileId: value.profileId,
    providerId: value.providerId,
    runtimeProfileId: value.runtimeProfileId,
    credentialRef: value.credentialRef,
    updatedAt: value.updatedAt,
  };
}

function normalizeLegacyCodexApiKeyJournal(value) {
  if (!exactObject(value, JOURNAL_FIELDS)
    || value.version !== LEGACY_CODEX_API_KEY_MIGRATION_VERSION
    || !Array.isArray(value.entries) || value.entries.length === 0
    || value.entries.length > MAX_LEGACY_CODEX_API_KEY_MIGRATION_ENTRIES
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) {
    throw journalError(
      "LEGACY_CODEX_API_KEY_MIGRATION_JOURNAL_CORRUPT",
      "Legacy Codex API key migration journal is corrupt",
    );
  }
  const entries = value.entries.map(normalizeEntry)
    .sort((left, right) => left.profileId.localeCompare(right.profileId));
  for (const field of ["profileId", "providerId", "runtimeProfileId", "credentialRef"]) {
    if (new Set(entries.map((entry) => entry[field])).size !== entries.length) {
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_JOURNAL_CORRUPT",
        "Legacy Codex API key migration journal is corrupt",
      );
    }
  }
  return {
    version: value.version,
    entries,
    updatedAt: value.updatedAt,
  };
}

function entryIdentity(entry) {
  return JSON.stringify([
    entry.profileId, entry.providerId, entry.runtimeProfileId, entry.credentialRef,
  ]);
}

class LegacyCodexApiKeyMigrationJournal {
  constructor(options = {}) {
    const target = options.paths?.legacyCodexApiKeyMigrationPath;
    if (typeof target !== "string" || path.dirname(target) !== options.paths?.stateDir
      || path.basename(target) !== "legacy-codex-api-key-migration-v1.json"
      || typeof options.paths?.trustedRoot !== "string") {
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_PATHS_REQUIRED",
        "Legacy Codex API key migration requires fixed Service paths",
      );
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.atomicWrite = options.atomicWrite || atomicWritePrivateFile;
    this.now = options.now || Date.now;
    this.opened = false;
    this.commitUncertain = false;
    this.journal = null;
  }

  open() {
    if (this.opened) return this;
    preparePrivateParent(
      this.paths.legacyCodexApiKeyMigrationPath,
      this.paths.trustedRoot,
      this.fs,
    );
    const recovery = recoverInterruptedPrivateFile(
      this.paths.legacyCodexApiKeyMigrationPath,
      { fs: this.fs, trustedRoot: this.paths.trustedRoot },
    );
    const stat = statIfExists(this.fs, this.paths.legacyCodexApiKeyMigrationPath);
    this.journal = stat ? this.#parse(readPrivateFile(
      this.paths.legacyCodexApiKeyMigrationPath,
      { fs: this.fs, maxBytes: MAX_LEGACY_CODEX_API_KEY_JOURNAL_BYTES },
    )) : null;
    this.commitUncertain = recovery === "uncertain";
    this.opened = true;
    return this;
  }

  close() {
    this.opened = false;
  }

  read() {
    this.#assertOpen();
    return this.journal === null ? null : structuredClone(this.journal);
  }

  plan(entries) {
    this.#assertOpen();
    const timestamp = this.#timestamp();
    const candidate = normalizeLegacyCodexApiKeyJournal({
      version: LEGACY_CODEX_API_KEY_MIGRATION_VERSION,
      entries: Array.isArray(entries) ? entries.map((entry) => ({
        stage: "planned",
        profileId: entry?.profileId,
        providerId: entry?.providerId,
        runtimeProfileId: entry?.runtimeProfileId,
        credentialRef: entry?.credentialRef,
        updatedAt: timestamp,
      })) : entries,
      updatedAt: timestamp,
    });
    if (this.journal !== null) {
      const current = this.journal.entries.map(entryIdentity);
      const requested = candidate.entries.map(entryIdentity);
      if (JSON.stringify(current) === JSON.stringify(requested)) return this.read();
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_CONFLICT",
        "Legacy Codex API key migration authority changed",
      );
    }
    this.#commit(candidate);
    return this.read();
  }

  advance(profileId, nextStage) {
    this.#assertOpen();
    const entryIndex = this.journal?.entries.findIndex((entry) => entry.profileId === profileId) ?? -1;
    if (entryIndex < 0 || !LEGACY_CODEX_API_KEY_MIGRATION_STAGES.includes(nextStage)) {
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_STAGE_CONFLICT",
        "Legacy Codex API key migration stage is invalid",
      );
    }
    const currentEntry = this.journal.entries[entryIndex];
    const currentIndex = LEGACY_CODEX_API_KEY_MIGRATION_STAGES.indexOf(currentEntry.stage);
    const nextIndex = LEGACY_CODEX_API_KEY_MIGRATION_STAGES.indexOf(nextStage);
    if (nextIndex === currentIndex) return this.read();
    if (nextIndex !== currentIndex + 1) {
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_STAGE_CONFLICT",
        "Legacy Codex API key migration stages cannot be skipped",
      );
    }
    const timestamp = this.#timestamp();
    const entries = this.journal.entries.map((entry, index) => index === entryIndex ? {
      ...entry,
      stage: nextStage,
      updatedAt: Math.max(entry.updatedAt, timestamp),
    } : entry);
    this.#commit(normalizeLegacyCodexApiKeyJournal({
      ...this.journal,
      entries,
      updatedAt: Math.max(this.journal.updatedAt, timestamp),
    }));
    return this.read();
  }

  #timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_CLOCK_INVALID",
        "Legacy Codex API key migration clock is invalid",
      );
    }
    return value;
  }

  #commit(candidate) {
    const serialized = `${JSON.stringify(candidate)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_LEGACY_CODEX_API_KEY_JOURNAL_BYTES) {
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_JOURNAL_CAPACITY",
        "Legacy Codex API key migration journal exceeds its capacity",
      );
    }
    try {
      this.atomicWrite(this.paths.legacyCodexApiKeyMigrationPath, serialized, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (error?.committed === true || error?.committedUncertain === true) {
        this.commitUncertain = true;
        throw journalError(
          "LEGACY_CODEX_API_KEY_MIGRATION_COMMIT_UNCERTAIN",
          "Legacy Codex API key migration journal commit is uncertain",
        );
      }
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_JOURNAL_WRITE_FAILED",
        "Legacy Codex API key migration journal could not be written",
      );
    }
    this.journal = candidate;
  }

  #parse(bytes) {
    try {
      return normalizeLegacyCodexApiKeyJournal(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error?.code === "LEGACY_CODEX_API_KEY_MIGRATION_JOURNAL_CORRUPT") throw error;
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_JOURNAL_CORRUPT",
        "Legacy Codex API key migration journal is corrupt",
      );
    }
  }

  #assertOpen() {
    if (this.commitUncertain) {
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_COMMIT_UNCERTAIN",
        "Legacy Codex API key migration journal commit is uncertain",
      );
    }
    if (!this.opened) {
      throw journalError(
        "LEGACY_CODEX_API_KEY_MIGRATION_JOURNAL_CLOSED",
        "Legacy Codex API key migration journal is closed",
      );
    }
  }
}

module.exports = {
  LEGACY_CODEX_API_KEY_MIGRATION_STAGES,
  LEGACY_CODEX_API_KEY_MIGRATION_VERSION,
  LegacyCodexApiKeyMigrationJournal,
  MAX_LEGACY_CODEX_API_KEY_JOURNAL_BYTES,
  MAX_LEGACY_CODEX_API_KEY_MIGRATION_ENTRIES,
  normalizeLegacyCodexApiKeyJournal,
};
