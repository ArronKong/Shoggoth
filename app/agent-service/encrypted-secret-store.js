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

const SECRET_CONTAINER_VERSION = 1;
const MAX_ENCRYPTED_SECRET_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CREDENTIALS = 1024;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const CUSTOM_PROVIDER_SECRET_KINDS = new Set([
  "openai-api-key", "openrouter", "ollama", "lmstudio", "custom-responses", "runtime-worker-token",
  "mcp-oauth",
]);

function secretError(code, message = code) {
  return serviceError(code, message);
}

function assertCredentialRef(value) {
  if (typeof value !== "string" || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw secretError("SECRET_CREDENTIAL_REF_INVALID", "credentialRef 必须是 opaque ID");
  }
  return value;
}

function assertExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function decodeCiphertext(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw secretError("SECRET_STORE_CORRUPT", "密文容器结构无效");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw secretError("SECRET_STORE_CORRUPT", "密文容器结构无效");
  }
  return bytes;
}

function validateContainer(value) {
  if (!assertExactKeys(value, ["version", "revision", "credentials"])
    || value.version !== SECRET_CONTAINER_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !value.credentials || typeof value.credentials !== "object"
    || Array.isArray(value.credentials) || Object.getPrototypeOf(value.credentials) !== Object.prototype
    || Object.keys(value.credentials).length > MAX_CREDENTIALS) {
    throw secretError("SECRET_STORE_CORRUPT", "密文容器结构无效");
  }
  const credentials = {};
  for (const [credentialRef, entry] of Object.entries(value.credentials)) {
    try {
      assertCredentialRef(credentialRef);
      if (!assertExactKeys(entry, ["kind", "ciphertext"])
        || !CUSTOM_PROVIDER_SECRET_KINDS.has(entry.kind)) {
        throw new Error("invalid metadata");
      }
      decodeCiphertext(entry.ciphertext);
    } catch {
      throw secretError("SECRET_STORE_CORRUPT", "密文容器结构无效");
    }
    credentials[credentialRef] = { kind: entry.kind, ciphertext: entry.ciphertext };
  }
  const normalized = { version: SECRET_CONTAINER_VERSION, revision: value.revision, credentials };
  if (Buffer.byteLength(`${JSON.stringify(normalized)}\n`, "utf8") > MAX_ENCRYPTED_SECRET_FILE_BYTES) {
    throw secretError("SECRET_STORE_CAPACITY", "密文容器超过容量限制");
  }
  return normalized;
}

function lockedError() {
  return secretError("credentials_locked", "credentials_locked");
}

class EncryptedSecretStore {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot || !options.paths?.encryptedSecretsPath
      || path.dirname(options.paths.encryptedSecretsPath) !== options.paths.stateDir
      || path.basename(options.paths.encryptedSecretsPath) !== "encrypted-secrets.json") {
      throw secretError("SECRET_STORE_PATHS_REQUIRED", "EncryptedSecretStore 需要固定 Service paths");
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.cryptoBroker = options.cryptoBroker || {
      async encrypt(payload) {
        const safeStorage = options.safeStorage;
        if (!safeStorage || safeStorage.isEncryptionAvailable?.() !== true) throw lockedError();
        const plaintext = payload.toString("utf8");
        const encrypted = safeStorage.encryptString(plaintext);
        if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw lockedError();
        return Buffer.from(encrypted);
      },
      async decrypt(payload) {
        const safeStorage = options.safeStorage;
        if (!safeStorage || safeStorage.isEncryptionAvailable?.() !== true) throw lockedError();
        const plaintext = safeStorage.decryptString(payload);
        if (typeof plaintext !== "string" || plaintext.length === 0) throw lockedError();
        return Buffer.from(plaintext, "utf8");
      },
    };
    this.opened = false;
    this.closing = false;
    this.commitUncertain = false;
    this.queue = Promise.resolve();
    this.container = { version: SECRET_CONTAINER_VERSION, revision: 0, credentials: {} };
    this.plaintextCache = new Map();
    this.matcherCacheLocked = false;
  }

  async open() {
    if (this.opened) return this;
    preparePrivateParent(this.paths.encryptedSecretsPath, this.paths.trustedRoot, this.fs);
    const recovery = recoverInterruptedPrivateFile(this.paths.encryptedSecretsPath, {
      fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
    });
    const stat = statIfExists(this.fs, this.paths.encryptedSecretsPath);
    this.container = stat
      ? this.#parse(readPrivateFile(this.paths.encryptedSecretsPath, {
        fs: this.fs,
        maxBytes: MAX_ENCRYPTED_SECRET_FILE_BYTES,
      }))
      : { version: SECRET_CONTAINER_VERSION, revision: 0, credentials: {} };
    const backupPrefix = `${path.basename(this.paths.encryptedSecretsPath)}.backup-`;
    this.commitUncertain = recovery === "uncertain" || this.fs.readdirSync(this.paths.stateDir)
      .some((name) => name.startsWith(backupPrefix));
    this.opened = true;
    this.closing = false;
    await this.#refreshMatcherCache();
    return this;
  }

  async close() {
    if (!this.opened && !this.closing) return;
    this.closing = true;
    await this.queue;
    this.#clearPlaintextCache();
    this.opened = false;
    this.closing = false;
  }

  listMetadata() {
    this.#assertOpen();
    return Object.entries(this.container.credentials)
      .map(([credentialRef, entry]) => ({ credentialRef, kind: entry.kind }));
  }

  getCredentialRevision(credentialRef) {
    this.#assertOpen();
    assertCredentialRef(credentialRef);
    // The existing encrypted container owns one durable monotonic revision.
    // Using it conservatively fences even unrelated credential mutations and
    // detects delete/recreate ABA without exposing ciphertext or plaintext.
    return Object.hasOwn(this.container.credentials, credentialRef) ? this.container.revision : null;
  }

  matchesPlaintext(candidate) {
    if (typeof candidate !== "string") {
      throw secretError("SECRET_MATCH_VALUE_INVALID", "敏感值匹配输入必须是字符串");
    }
    return this.withPlaintextMatcher((matches) => matches(candidate));
  }

  withPlaintextMatcher(action) {
    this.#assertOpen();
    if (typeof action !== "function") {
      throw secretError("SECRET_MATCH_ACTION_INVALID", "敏感值匹配操作必须是函数");
    }
    const entries = Object.keys(this.container.credentials);
    let active = true;
    try {
      if (entries.length > 0 && (this.matcherCacheLocked
        || this.plaintextCache.size !== entries.length)) throw lockedError();
      const plaintextBuffers = [...this.plaintextCache.values()];
      const matches = (candidate) => {
        if (!active) throw secretError("SECRET_MATCHER_CLOSED", "敏感值 matcher 已关闭");
        if (typeof candidate !== "string") {
          throw secretError("SECRET_MATCH_VALUE_INVALID", "敏感值匹配输入必须是字符串");
        }
        const candidateBytes = Buffer.from(candidate, "utf8");
        try {
          return plaintextBuffers.some((secret) => candidateBytes.includes(secret));
        } finally {
          candidateBytes.fill(0);
        }
      };
      const result = action(matches);
      if (result && typeof result.then === "function") {
        throw secretError("SECRET_MATCH_ACTION_ASYNC", "敏感值匹配操作必须同步完成");
      }
      return result;
    } finally {
      active = false;
    }
  }

  get(credentialRef) {
    this.#assertOpen();
    assertCredentialRef(credentialRef);
    return this.#afterWrites(async () => {
      const entry = this.container.credentials[credentialRef];
      if (!entry) return null;
      const cached = this.plaintextCache.get(credentialRef);
      if (cached) return cached.toString("utf8");
      try {
        const plaintext = await this.#decryptEntry(entry);
        this.plaintextCache.set(credentialRef, plaintext);
        this.matcherCacheLocked = this.plaintextCache.size
          !== Object.keys(this.container.credentials).length;
        return plaintext.toString("utf8");
      } catch {
        throw lockedError();
      } finally {
        // 返回值已经转成调用方所需 string；临时 Buffer 不跨出 Store。
      }
    });
  }

  put(credentialRef, plaintextValue, metadata) {
    return this.#put(credentialRef, plaintextValue, metadata);
  }

  putIfRevision(credentialRef, plaintextValue, metadata, expectedRevision) {
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision)
      || expectedRevision < 0)) {
      return Promise.reject(secretError("SECRET_REVISION_CONFLICT", "凭据版本无效"));
    }
    return this.#put(credentialRef, plaintextValue, metadata, expectedRevision);
  }

  #put(credentialRef, plaintextValue, metadata, expectedRevision = undefined) {
    this.#assertOpen();
    assertCredentialRef(credentialRef);
    if (!assertExactKeys(metadata, ["kind"]) || !CUSTOM_PROVIDER_SECRET_KINDS.has(metadata.kind)) {
      return Promise.reject(secretError("SECRET_KIND_FORBIDDEN", "只允许受支持的 Provider 凭据"));
    }
    if (typeof plaintextValue !== "string" || plaintextValue.length === 0
      || Buffer.byteLength(plaintextValue, "utf8") > MAX_PLAINTEXT_BYTES || plaintextValue.includes("\0")) {
      return Promise.reject(secretError("SECRET_VALUE_INVALID", "凭据值无效"));
    }
    let plaintext = plaintextValue;
    const result = this.#enqueue(async () => {
      if (expectedRevision !== undefined
        && (Object.hasOwn(this.container.credentials, credentialRef)
          ? this.container.revision : null) !== expectedRevision) {
        throw secretError("SECRET_REVISION_CONFLICT", "凭据已变化");
      }
      let encrypted = null;
      let plaintextBytes = null;
      try {
        plaintextBytes = Buffer.from(plaintext, "utf8");
        encrypted = await this.cryptoBroker.encrypt(plaintextBytes);
        if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error("invalid ciphertext");
      } catch {
        throw lockedError();
      } finally {
        if (plaintextBytes) plaintextBytes.fill(0);
      }
      if (!Object.prototype.hasOwnProperty.call(this.container.credentials, credentialRef)
        && Object.keys(this.container.credentials).length >= MAX_CREDENTIALS) {
        throw secretError("SECRET_STORE_CAPACITY", "密文容器已满");
      }
      const ciphertext = encrypted.toString("base64");
      encrypted.fill(0);
      const candidate = {
        version: SECRET_CONTAINER_VERSION,
        revision: this.container.revision + 1,
        credentials: {
          ...this.container.credentials,
          [credentialRef]: { kind: metadata.kind, ciphertext },
        },
      };
      this.#write(candidate);
      this.container = candidate;
      const previous = this.plaintextCache.get(credentialRef);
      if (previous) previous.fill(0);
      this.plaintextCache.set(credentialRef, Buffer.from(plaintext, "utf8"));
      this.matcherCacheLocked = this.plaintextCache.size
        !== Object.keys(candidate.credentials).length;
      return { credentialRef, kind: metadata.kind, revision: candidate.revision };
    });
    return result.finally(() => {
      plaintext = null;
      plaintextValue = null;
    });
  }

  delete(credentialRef) {
    this.#assertOpen();
    assertCredentialRef(credentialRef);
    return this.#enqueue(async () => {
      if (!Object.prototype.hasOwnProperty.call(this.container.credentials, credentialRef)) return false;
      const credentials = { ...this.container.credentials };
      delete credentials[credentialRef];
      const candidate = {
        version: SECRET_CONTAINER_VERSION,
        revision: this.container.revision + 1,
        credentials,
      };
      this.#write(candidate);
      this.container = candidate;
      const cached = this.plaintextCache.get(credentialRef);
      if (cached) cached.fill(0);
      this.plaintextCache.delete(credentialRef);
      this.matcherCacheLocked = this.plaintextCache.size
        !== Object.keys(candidate.credentials).length;
      return true;
    });
  }

  #parse(bytes) {
    try {
      return validateContainer(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error?.code === "SECRET_STORE_CORRUPT") throw error;
      throw secretError("SECRET_STORE_CORRUPT", "密文容器结构无效");
    }
  }

  #write(candidate) {
    const serialized = `${JSON.stringify(candidate)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_ENCRYPTED_SECRET_FILE_BYTES) {
      throw secretError("SECRET_STORE_CAPACITY", "密文容器超过容量限制");
    }
    try {
      atomicWritePrivateFile(
        this.paths.encryptedSecretsPath,
        serialized,
        { fs: this.fs, trustedRoot: this.paths.trustedRoot },
      );
    } catch (error) {
      if (error?.committedUncertain === true || error?.committed === true) {
        if (error.committed === true) this.container = candidate;
        this.commitUncertain = true;
        const uncertain = new AggregateError([
          secretError("SECRET_COMMIT_FAILED", "密文容器目录提交失败"),
          secretError("SECRET_ROLLBACK_FAILED", "密文容器回滚未确认"),
        ], "密文容器提交状态不确定");
        uncertain.code = "SECRET_COMMIT_UNCERTAIN";
        uncertain.committedUncertain = true;
        throw uncertain;
      }
      if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      throw secretError("SECRET_WRITE_FAILED", "密文容器写入失败");
    }
  }

  async #refreshMatcherCache() {
    this.#clearPlaintextCache();
    this.matcherCacheLocked = false;
    try {
      for (const [credentialRef, entry] of Object.entries(this.container.credentials)) {
        const plaintext = await this.#decryptEntry(entry);
        this.plaintextCache.set(credentialRef, plaintext);
      }
    } catch {
      this.#clearPlaintextCache();
      this.matcherCacheLocked = Object.keys(this.container.credentials).length > 0;
    }
  }

  async #decryptEntry(entry) {
    let ciphertext = null;
    try {
      ciphertext = decodeCiphertext(entry.ciphertext);
      const plaintext = await this.cryptoBroker.decrypt(ciphertext);
      if (!Buffer.isBuffer(plaintext) || plaintext.length === 0
        || plaintext.length > MAX_PLAINTEXT_BYTES) {
        if (Buffer.isBuffer(plaintext)) plaintext.fill(0);
        throw lockedError();
      }
      return plaintext;
    } catch {
      throw lockedError();
    } finally {
      if (ciphertext) ciphertext.fill(0);
    }
  }

  #clearPlaintextCache() {
    for (const value of this.plaintextCache.values()) value.fill(0);
    this.plaintextCache.clear();
  }

  #assertOpen() {
    if (!this.opened || this.closing) throw secretError("SECRET_STORE_CLOSED", "EncryptedSecretStore 未打开");
    if (this.commitUncertain) throw lockedError();
  }

  #afterWrites(action) {
    return this.queue.then(action);
  }

  #enqueue(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
}

module.exports = {
  CUSTOM_PROVIDER_SECRET_KINDS,
  EncryptedSecretStore,
  MAX_ENCRYPTED_SECRET_FILE_BYTES,
  SECRET_CONTAINER_VERSION,
  assertCredentialRef,
  lockedError,
  secretError,
  validateContainer,
};
