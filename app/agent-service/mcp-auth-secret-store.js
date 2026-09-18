"use strict";

const crypto = require("node:crypto");
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

const MCP_AUTH_STORE_VERSION = 1;
const MCP_AUTH_SECRET_BYTES = 32;
const MAX_MCP_AUTH_FILE_BYTES = 4096;

function mcpAuthError(code, message) {
  return serviceError(code, message);
}

function lockedError() {
  return mcpAuthError("credentials_locked", "credentials_locked");
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw mcpAuthError("MCP_AUTH_STORE_CORRUPT", "mcp_auth_store_corrupt");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw mcpAuthError("MCP_AUTH_STORE_CORRUPT", "mcp_auth_store_corrupt");
  }
  return bytes;
}

function parseContainer(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw mcpAuthError("MCP_AUTH_STORE_CORRUPT", "mcp_auth_store_corrupt");
  }
  if (!exactObject(value, ["version", "ciphertext"])
    || value.version !== MCP_AUTH_STORE_VERSION) {
    throw mcpAuthError("MCP_AUTH_STORE_CORRUPT", "mcp_auth_store_corrupt");
  }
  decodeCanonicalBase64(value.ciphertext);
  return { version: MCP_AUTH_STORE_VERSION, ciphertext: value.ciphertext };
}

function decodeSecretPlaintext(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw lockedError();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== MCP_AUTH_SECRET_BYTES || bytes.toString("base64url") !== value) {
    bytes.fill(0);
    throw lockedError();
  }
  return bytes;
}

function assertReadOnlyDirectoryTree(paths, fileSystem) {
  const trustedRoot = path.resolve(paths.trustedRoot);
  const stateDir = path.resolve(paths.stateDir);
  const relative = path.relative(trustedRoot, stateDir);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw mcpAuthError("UNSAFE_PATH", "mcp_auth_path_unsafe");
  }
  let cursor = trustedRoot;
  const segments = ["", ...relative.split(path.sep)];
  for (const segment of segments) {
    if (segment) cursor = path.join(cursor, segment);
    const stat = fileSystem.lstatSync(cursor);
    if (stat.isSymbolicLink?.()) throw mcpAuthError("UNSAFE_SYMLINK", "mcp_auth_path_unsafe");
    if (!stat.isDirectory?.()) throw mcpAuthError("UNSAFE_PATH", "mcp_auth_path_unsafe");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw mcpAuthError("UNSAFE_OWNER", "mcp_auth_path_unsafe");
    }
    if (cursor === stateDir && (stat.mode & 0o077) !== 0) {
      throw mcpAuthError("UNSAFE_PERMISSIONS", "mcp_auth_path_unsafe");
    }
  }
}

class McpAuthSecretStore {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot || !options.paths?.mcpAuthPath
      || path.dirname(options.paths.mcpAuthPath) !== options.paths.stateDir
      || path.basename(options.paths.mcpAuthPath) !== "mcp-auth.json") {
      throw mcpAuthError("MCP_AUTH_PATHS_REQUIRED", "mcp_auth_paths_required");
    }
    this.paths = options.paths;
    if (options.access !== "service" && options.access !== "helper") {
      throw mcpAuthError("MCP_AUTH_ACCESS_REQUIRED", "mcp_auth_access_required");
    }
    this.access = options.access;
    this.fs = options.fs || fs;
    this.safeStorage = options.safeStorage || null;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.opened = false;
    this.commitUncertain = false;
    this.container = null;
  }

  open() {
    if (this.opened) return this;
    if (this.access === "helper") return this.#openReadOnly();
    preparePrivateParent(this.paths.mcpAuthPath, this.paths.trustedRoot, this.fs);
    const recovery = recoverInterruptedPrivateFile(this.paths.mcpAuthPath, {
      fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
    });
    const stat = statIfExists(this.fs, this.paths.mcpAuthPath);
    this.container = stat
      ? parseContainer(readPrivateFile(this.paths.mcpAuthPath, {
        fs: this.fs,
        maxBytes: MAX_MCP_AUTH_FILE_BYTES,
      }))
      : null;
    const backupPrefix = `${path.basename(this.paths.mcpAuthPath)}.backup-`;
    this.commitUncertain = recovery === "uncertain" || this.fs.readdirSync(this.paths.stateDir)
      .some((name) => name.startsWith(backupPrefix));
    this.opened = true;
    return this;
  }

  close() {
    this.opened = false;
    this.container = null;
  }

  loadOrCreateForService() {
    this.#assertReadable();
    if (this.access !== "service") {
      throw mcpAuthError("MCP_AUTH_ACCESS_FORBIDDEN", "mcp_auth_access_forbidden");
    }
    if (this.container) return this.#decrypt();
    return this.#createAndPersist();
  }

  rotateForService() {
    this.#assertReadable();
    if (this.access !== "service") {
      throw mcpAuthError("MCP_AUTH_ACCESS_FORBIDDEN", "mcp_auth_access_forbidden");
    }
    return this.#createAndPersist();
  }

  #createAndPersist() {
    this.#assertEncryptionAvailable();
    let secret;
    let plaintext = null;
    try {
      try {
        secret = this.randomBytes(MCP_AUTH_SECRET_BYTES);
      } catch {
        throw mcpAuthError("MCP_AUTH_RANDOM_FAILED", "mcp_auth_random_failed");
      }
      if (!Buffer.isBuffer(secret) || secret.length !== MCP_AUTH_SECRET_BYTES) {
        throw mcpAuthError("MCP_AUTH_RANDOM_FAILED", "mcp_auth_random_failed");
      }
      plaintext = secret.toString("base64url");
      let ciphertext;
      try {
        ciphertext = this.safeStorage.encryptString(plaintext);
      } catch {
        throw lockedError();
      }
      if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) throw lockedError();
      const candidate = {
        version: MCP_AUTH_STORE_VERSION,
        ciphertext: ciphertext.toString("base64"),
      };
      this.#write(candidate);
      this.container = candidate;
      return Buffer.from(secret);
    } finally {
      if (secret) secret.fill(0);
      plaintext = null;
    }
  }

  readForHelper() {
    this.#assertReadable();
    if (this.access !== "helper") {
      throw mcpAuthError("MCP_AUTH_ACCESS_FORBIDDEN", "mcp_auth_access_forbidden");
    }
    if (!this.container) {
      throw mcpAuthError("MCP_AUTH_NOT_INITIALIZED", "mcp_auth_not_initialized");
    }
    return this.#decrypt();
  }

  #decrypt() {
    this.#assertEncryptionAvailable();
    let plaintext = null;
    try {
      plaintext = this.safeStorage.decryptString(decodeCanonicalBase64(this.container.ciphertext));
      return decodeSecretPlaintext(plaintext);
    } catch {
      throw lockedError();
    } finally {
      plaintext = null;
    }
  }

  #openReadOnly() {
    let stateStat;
    try {
      stateStat = this.fs.lstatSync(this.paths.stateDir);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.container = null;
      this.commitUncertain = false;
      this.opened = true;
      return this;
    }
    if (!stateStat) {
      this.container = null;
      this.commitUncertain = false;
      this.opened = true;
      return this;
    }
    assertReadOnlyDirectoryTree(this.paths, this.fs);
    const temp = statIfExists(this.fs, `${this.paths.mcpAuthPath}.tmp`);
    const backupPrefix = `${path.basename(this.paths.mcpAuthPath)}.backup-`;
    const hasBackup = this.fs.readdirSync(this.paths.stateDir)
      .some((name) => name.startsWith(backupPrefix));
    this.commitUncertain = Boolean(temp) || hasBackup;
    if (this.commitUncertain) {
      this.container = null;
      this.opened = true;
      return this;
    }
    const stat = statIfExists(this.fs, this.paths.mcpAuthPath);
    this.container = stat
      ? parseContainer(readPrivateFile(this.paths.mcpAuthPath, {
        fs: this.fs,
        maxBytes: MAX_MCP_AUTH_FILE_BYTES,
      }))
      : null;
    this.opened = true;
    return this;
  }

  #write(candidate) {
    const serialized = `${JSON.stringify(candidate)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_MCP_AUTH_FILE_BYTES) {
      throw mcpAuthError("MCP_AUTH_STORE_CAPACITY", "mcp_auth_store_capacity");
    }
    try {
      atomicWritePrivateFile(this.paths.mcpAuthPath, serialized, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (error?.committedUncertain === true || error?.committed === true) {
        if (error.committed === true) this.container = candidate;
        this.commitUncertain = true;
        const uncertain = new AggregateError([
          mcpAuthError("MCP_AUTH_COMMIT_FAILED", "mcp_auth_commit_failed"),
          mcpAuthError("MCP_AUTH_ROLLBACK_FAILED", "mcp_auth_rollback_failed"),
        ], "mcp_auth_commit_uncertain");
        uncertain.code = "MCP_AUTH_COMMIT_UNCERTAIN";
        uncertain.committedUncertain = true;
        throw uncertain;
      }
      if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      throw mcpAuthError("MCP_AUTH_WRITE_FAILED", "mcp_auth_write_failed");
    }
  }

  #assertEncryptionAvailable() {
    try {
      if (!this.safeStorage || typeof this.safeStorage.isEncryptionAvailable !== "function"
        || typeof this.safeStorage.encryptString !== "function"
        || typeof this.safeStorage.decryptString !== "function"
        || this.safeStorage.isEncryptionAvailable() !== true) throw new Error("unavailable");
    } catch {
      throw lockedError();
    }
  }

  #assertReadable() {
    if (!this.opened) throw mcpAuthError("MCP_AUTH_STORE_CLOSED", "mcp_auth_store_closed");
    if (this.commitUncertain) throw lockedError();
  }
}

module.exports = {
  MAX_MCP_AUTH_FILE_BYTES,
  MCP_AUTH_SECRET_BYTES,
  MCP_AUTH_STORE_VERSION,
  McpAuthSecretStore,
};
