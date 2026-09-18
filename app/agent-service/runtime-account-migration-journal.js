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
const {
  validRuntime,
  validRuntimeAccountId,
  validRuntimeProfileId,
} = require("./runtime-adapter");
const { serviceError } = require("./security");

const MIGRATION_JOURNAL_VERSION = 1;
const MAX_MIGRATION_JOURNAL_BYTES = 1024 * 1024;
const MAX_LEGACY_HOMES = 2_048;
const MIGRATION_STAGES = Object.freeze([
  "planned",
  "metadata_backed_up",
  "accounts_committed",
  "profiles_rebound",
  "runtime_refs_reconciled",
  "service_verified",
  "cleanup_eligible",
]);
const JOURNAL_FIELDS = Object.freeze([
  "version", "generation", "stage", "inputDigest", "outputDigest", "legacyHomes", "updatedAt",
]);
const LEGACY_HOME_FIELDS = Object.freeze([
  "id", "runtime", "runtimeProfileId", "runtimeAccountId", "relativePath", "classification",
]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const LEGACY_HOME_ID_PATTERN = /^legacy-home-[a-f0-9]{64}-v1$/u;
const CLASSIFICATIONS = new Set(["managed-canonical", "managed-reclaimable"]);

function journalError(code, message) {
  return serviceError(code, message);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096
    || value.includes("\0") || !value.isWellFormed() || path.isAbsolute(value)) {
    throw journalError("RUNTIME_ACCOUNT_MIGRATION_INVALID", "Legacy Home path is invalid");
  }
  const normalized = path.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw journalError("RUNTIME_ACCOUNT_MIGRATION_INVALID", "Legacy Home path escapes state");
  }
  return value;
}

function normalizeLegacyHome(value) {
  if (!exactObject(value, LEGACY_HOME_FIELDS)
    || typeof value.id !== "string" || !LEGACY_HOME_ID_PATTERN.test(value.id)
    || !validRuntime(value.runtime) || !validRuntimeProfileId(value.runtimeProfileId)
    || !validRuntimeAccountId(value.runtimeAccountId)
    || !CLASSIFICATIONS.has(value.classification)) {
    throw journalError("RUNTIME_ACCOUNT_MIGRATION_INVALID", "Legacy Home record is invalid");
  }
  return {
    id: value.id,
    runtime: value.runtime,
    runtimeProfileId: value.runtimeProfileId,
    runtimeAccountId: value.runtimeAccountId,
    relativePath: normalizeRelativePath(value.relativePath),
    classification: value.classification,
  };
}

function normalizeJournal(value, corrupt = false) {
  const fail = () => {
    throw journalError(
      corrupt ? "RUNTIME_ACCOUNT_MIGRATION_CORRUPT" : "RUNTIME_ACCOUNT_MIGRATION_INVALID",
      "Runtime account migration journal is invalid",
    );
  };
  if (!exactObject(value, JOURNAL_FIELDS)
    || value.version !== MIGRATION_JOURNAL_VERSION
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !MIGRATION_STAGES.includes(value.stage)
    || typeof value.inputDigest !== "string" || !DIGEST_PATTERN.test(value.inputDigest)
    || (value.outputDigest !== null
      && (typeof value.outputDigest !== "string" || !DIGEST_PATTERN.test(value.outputDigest)))
    || !Array.isArray(value.legacyHomes) || value.legacyHomes.length > MAX_LEGACY_HOMES
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) fail();
  let legacyHomes;
  try { legacyHomes = value.legacyHomes.map(normalizeLegacyHome); } catch { fail(); }
  const ids = new Set(legacyHomes.map((home) => home.id));
  const paths = new Set(legacyHomes.map((home) => home.relativePath));
  if (ids.size !== legacyHomes.length || paths.size !== legacyHomes.length) fail();
  legacyHomes.sort((left, right) => left.id.localeCompare(right.id));
  return {
    version: MIGRATION_JOURNAL_VERSION,
    generation: value.generation,
    stage: value.stage,
    inputDigest: value.inputDigest,
    outputDigest: value.outputDigest,
    legacyHomes,
    updatedAt: value.updatedAt,
  };
}

class RuntimeAccountMigrationJournal {
  constructor(options = {}) {
    const target = options.paths?.runtimeAccountMigrationPath;
    if (typeof target !== "string" || path.dirname(target) !== options.paths?.stateDir
      || path.basename(target) !== "runtime-account-migration-v1.json"
      || typeof options.paths?.trustedRoot !== "string") {
      throw journalError(
        "RUNTIME_ACCOUNT_MIGRATION_PATHS_REQUIRED",
        "Runtime account migration journal requires fixed Service paths",
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
    preparePrivateParent(this.paths.runtimeAccountMigrationPath, this.paths.trustedRoot, this.fs);
    const recovery = recoverInterruptedPrivateFile(this.paths.runtimeAccountMigrationPath, {
      fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
    });
    const stat = statIfExists(this.fs, this.paths.runtimeAccountMigrationPath);
    this.journal = stat ? this.#parse(readPrivateFile(this.paths.runtimeAccountMigrationPath, {
      fs: this.fs,
      maxBytes: MAX_MIGRATION_JOURNAL_BYTES,
    })) : null;
    this.commitUncertain = recovery === "uncertain";
    this.opened = true;
    return this;
  }

  close() {
    this.#assertOpen();
    this.opened = false;
  }

  read() {
    this.#assertOpen();
    return this.journal === null ? null : structuredClone(this.journal);
  }

  plan(input) {
    this.#assertOpen();
    const candidate = normalizeJournal({
      version: MIGRATION_JOURNAL_VERSION,
      generation: input?.generation,
      stage: "planned",
      inputDigest: input?.inputDigest,
      outputDigest: null,
      legacyHomes: input?.legacyHomes,
      updatedAt: this.now(),
    });
    if (this.journal !== null) {
      if (this.journal.generation === candidate.generation
        && this.journal.inputDigest === candidate.inputDigest
        && JSON.stringify(this.journal.legacyHomes) === JSON.stringify(candidate.legacyHomes)) {
        return this.read();
      }
      throw journalError(
        "RUNTIME_ACCOUNT_MIGRATION_CONFLICT",
        "A different Runtime account migration is already recorded",
      );
    }
    this.#commit(candidate);
    return this.read();
  }

  advance(input) {
    this.#assertOpen();
    if (this.journal === null || input?.generation !== this.journal.generation
      || input?.inputDigest !== this.journal.inputDigest) {
      throw journalError(
        "RUNTIME_ACCOUNT_MIGRATION_CONFLICT",
        "Runtime account migration generation does not match",
      );
    }
    const currentIndex = MIGRATION_STAGES.indexOf(this.journal.stage);
    const nextIndex = MIGRATION_STAGES.indexOf(input.nextStage);
    if (nextIndex <= currentIndex) {
      if (nextIndex === currentIndex
        && (input.outputDigest ?? this.journal.outputDigest) === this.journal.outputDigest) {
        return this.read();
      }
      throw journalError(
        "RUNTIME_ACCOUNT_MIGRATION_STAGE_CONFLICT",
        "Runtime account migration stage is stale",
      );
    }
    if (nextIndex !== currentIndex + 1) {
      throw journalError(
        "RUNTIME_ACCOUNT_MIGRATION_STAGE_CONFLICT",
        "Runtime account migration stages cannot be skipped",
      );
    }
    const candidate = normalizeJournal({
      ...this.journal,
      stage: input.nextStage,
      outputDigest: input.outputDigest ?? this.journal.outputDigest,
      updatedAt: Math.max(this.journal.updatedAt, this.now()),
    });
    this.#commit(candidate);
    return this.read();
  }

  #commit(candidate) {
    const serialized = `${JSON.stringify(candidate)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_MIGRATION_JOURNAL_BYTES) {
      throw journalError(
        "RUNTIME_ACCOUNT_MIGRATION_CAPACITY",
        "Runtime account migration journal exceeds its capacity",
      );
    }
    try {
      this.atomicWrite(this.paths.runtimeAccountMigrationPath, serialized, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (error?.committed === true || error?.committedUncertain === true) {
        this.commitUncertain = true;
        throw journalError(
          "RUNTIME_ACCOUNT_MIGRATION_COMMIT_UNCERTAIN",
          "Runtime account migration journal commit is uncertain",
        );
      }
      if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      throw journalError(
        "RUNTIME_ACCOUNT_MIGRATION_WRITE_FAILED",
        "Runtime account migration journal could not be written",
      );
    }
    this.journal = candidate;
  }

  #parse(bytes) {
    try { return normalizeJournal(JSON.parse(bytes.toString("utf8")), true); } catch (error) {
      if (error?.code === "RUNTIME_ACCOUNT_MIGRATION_CORRUPT") throw error;
      throw journalError(
        "RUNTIME_ACCOUNT_MIGRATION_CORRUPT",
        "Runtime account migration journal is corrupt",
      );
    }
  }

  #assertOpen() {
    if (this.commitUncertain) {
      throw journalError(
        "RUNTIME_ACCOUNT_MIGRATION_COMMIT_UNCERTAIN",
        "Runtime account migration journal commit is uncertain",
      );
    }
    if (!this.opened) {
      throw journalError(
        "RUNTIME_ACCOUNT_MIGRATION_CLOSED",
        "Runtime account migration journal is closed",
      );
    }
  }
}

module.exports = {
  MAX_LEGACY_HOMES,
  MAX_MIGRATION_JOURNAL_BYTES,
  MIGRATION_JOURNAL_VERSION,
  MIGRATION_STAGES,
  RuntimeAccountMigrationJournal,
  normalizeJournal,
};
