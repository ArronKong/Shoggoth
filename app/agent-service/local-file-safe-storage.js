"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  preparePrivateParent,
  readPrivateFile,
  statIfExists,
} = require("./private-file");
const { serviceError } = require("./security");

const LOCAL_CRYPTO_KEY_FILENAME = "local-crypto-master-key.v1";
const LOCAL_CRYPTO_KEY_BYTES = 32;
const LOCAL_CRYPTO_NONCE_BYTES = 12;
const LOCAL_CRYPTO_TAG_BYTES = 16;
const MAX_LOCAL_CRYPTO_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const LOCAL_CRYPTO_MAGIC = Buffer.from([0x53, 0x48, 0x47, 0x4c, 0x43, 0x00, 0x00, 0x01]);
const LOCAL_CRYPTO_HEADER_BYTES = LOCAL_CRYPTO_MAGIC.length
  + LOCAL_CRYPTO_NONCE_BYTES + LOCAL_CRYPTO_TAG_BYTES;
const LOCAL_CRYPTO_AAD = Buffer.from("ai.shoggoth.desktop/local-file-safe-storage/v1", "utf8");

function localCryptoError(cause = null) {
  const error = serviceError("LOCAL_CRYPTO_UNAVAILABLE", "local_crypto_unavailable");
  if (cause instanceof Error) error.cause = cause;
  return error;
}

function localCryptoKeyPath(paths) {
  if (!paths || typeof paths !== "object"
    || typeof paths.trustedRoot !== "string" || !path.isAbsolute(paths.trustedRoot)
    || typeof paths.stateDir !== "string" || !path.isAbsolute(paths.stateDir)
    || paths.trustedRoot.includes("\0") || paths.stateDir.includes("\0")) {
    throw localCryptoError();
  }
  const trustedRoot = path.resolve(paths.trustedRoot);
  const stateDir = path.resolve(paths.stateDir);
  const relative = path.relative(trustedRoot, stateDir);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw localCryptoError();
  }
  return path.join(stateDir, LOCAL_CRYPTO_KEY_FILENAME);
}

function readMasterKey(target, options) {
  const key = readPrivateFile(target, {
    fs: options.fs,
    maxBytes: LOCAL_CRYPTO_KEY_BYTES,
  });
  if (!Buffer.isBuffer(key) || key.length !== LOCAL_CRYPTO_KEY_BYTES) {
    if (Buffer.isBuffer(key)) key.fill(0);
    throw localCryptoError();
  }
  return key;
}

function loadOrCreateMasterKey(paths, options) {
  const target = localCryptoKeyPath(paths);
  preparePrivateParent(target, paths.trustedRoot, options.fs);
  if (!statIfExists(options.fs, target)) {
    let candidate = null;
    try {
      candidate = options.randomBytes(LOCAL_CRYPTO_KEY_BYTES);
      if (!Buffer.isBuffer(candidate) || candidate.length !== LOCAL_CRYPTO_KEY_BYTES) {
        throw localCryptoError();
      }
      atomicWritePrivateFile(target, candidate, {
        fs: options.fs,
        trustedRoot: paths.trustedRoot,
      });
    } finally {
      if (Buffer.isBuffer(candidate)) candidate.fill(0);
    }
  }
  return readMasterKey(target, options);
}

function loadMasterKeyReadOnly(paths, options) {
  return readMasterKey(localCryptoKeyPath(paths), options);
}

class LocalFileSafeStorage {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.key = null;
    try {
      if (typeof this.randomBytes !== "function") throw localCryptoError();
      const load = options.readOnly === true ? loadMasterKeyReadOnly : loadOrCreateMasterKey;
      this.key = load(options.paths, {
        fs: this.fs,
        randomBytes: this.randomBytes,
      });
    } catch (error) {
      if (Buffer.isBuffer(this.key)) this.key.fill(0);
      this.key = null;
      throw localCryptoError(error);
    }
  }

  isEncryptionAvailable() {
    return Buffer.isBuffer(this.key) && this.key.length === LOCAL_CRYPTO_KEY_BYTES;
  }

  encryptString(value) {
    let plaintext = null;
    let nonce = null;
    let encrypted = null;
    let tag = null;
    try {
      this.#assertAvailable();
      if (typeof value !== "string") throw localCryptoError();
      plaintext = Buffer.from(value, "utf8");
      if (plaintext.length > MAX_LOCAL_CRYPTO_PLAINTEXT_BYTES) throw localCryptoError();
      nonce = this.randomBytes(LOCAL_CRYPTO_NONCE_BYTES);
      if (!Buffer.isBuffer(nonce) || nonce.length !== LOCAL_CRYPTO_NONCE_BYTES) {
        throw localCryptoError();
      }
      const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonce, {
        authTagLength: LOCAL_CRYPTO_TAG_BYTES,
      });
      cipher.setAAD(LOCAL_CRYPTO_AAD, { plaintextLength: plaintext.length });
      encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      tag = cipher.getAuthTag();
      return Buffer.concat([LOCAL_CRYPTO_MAGIC, nonce, tag, encrypted]);
    } catch {
      throw localCryptoError();
    } finally {
      if (plaintext) plaintext.fill(0);
      if (nonce) nonce.fill(0);
      if (encrypted) encrypted.fill(0);
      if (tag) tag.fill(0);
    }
  }

  decryptString(value) {
    let plaintext = null;
    try {
      this.#assertAvailable();
      if (!Buffer.isBuffer(value)
        || value.length < LOCAL_CRYPTO_HEADER_BYTES
        || value.length > LOCAL_CRYPTO_HEADER_BYTES + MAX_LOCAL_CRYPTO_PLAINTEXT_BYTES
        || !crypto.timingSafeEqual(value.subarray(0, LOCAL_CRYPTO_MAGIC.length), LOCAL_CRYPTO_MAGIC)) {
        throw localCryptoError();
      }
      const nonceStart = LOCAL_CRYPTO_MAGIC.length;
      const tagStart = nonceStart + LOCAL_CRYPTO_NONCE_BYTES;
      const ciphertextStart = tagStart + LOCAL_CRYPTO_TAG_BYTES;
      const nonce = value.subarray(nonceStart, tagStart);
      const tag = value.subarray(tagStart, ciphertextStart);
      const ciphertext = value.subarray(ciphertextStart);
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, nonce, {
        authTagLength: LOCAL_CRYPTO_TAG_BYTES,
      });
      decipher.setAAD(LOCAL_CRYPTO_AAD, { plaintextLength: ciphertext.length });
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const result = plaintext.toString("utf8");
      const canonical = Buffer.from(result, "utf8");
      try {
        if (!canonical.equals(plaintext)) throw localCryptoError();
      } finally {
        canonical.fill(0);
      }
      return result;
    } catch {
      throw localCryptoError();
    } finally {
      if (plaintext) plaintext.fill(0);
    }
  }

  close() {
    if (Buffer.isBuffer(this.key)) this.key.fill(0);
    this.key = null;
  }

  #assertAvailable() {
    if (!this.isEncryptionAvailable()) throw localCryptoError();
  }
}

function createLocalFileSafeStorage(options = {}) {
  return new LocalFileSafeStorage(options);
}

module.exports = {
  LOCAL_CRYPTO_KEY_BYTES,
  LOCAL_CRYPTO_KEY_FILENAME,
  LocalFileSafeStorage,
  createLocalFileSafeStorage,
  localCryptoKeyPath,
};
