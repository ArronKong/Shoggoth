"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertReadOnlyDirectoryTree, decodeMcpAuthSecretPlaintext, MAX_MCP_AUTH_FILE_BYTES,
  MCP_AUTH_STORE_VERSION, parseMcpAuthContainer,
} = require("./mcp-auth-secret-store");
const {
  createLocalFileSafeStorage, isLocalFileCiphertext, localCryptoKeyPath,
} = require("./local-file-safe-storage");
const { atomicWritePrivateFile, fsyncPrivateParent, openExistingPrivateFile,
  readPrivateFile, statIfExists } = require("./private-file");
const { ensurePrivateDirectoryTree } = require("./security");
const { cryptoError } = require("./mcp-crypto-protocol");

function readMcpAuthMigrationSource(paths, fileSystem = fs) {
  assertReadOnlyDirectoryTree(paths, fileSystem);
  if (statIfExists(fileSystem, `${paths.mcpAuthPath}.tmp`)
    || fileSystem.readdirSync(paths.stateDir).some((name) => name.startsWith("mcp-auth.json.backup-"))) {
    throw cryptoError();
  }
  const fd = openExistingPrivateFile(paths.mcpAuthPath, fileSystem.constants.O_RDONLY, fileSystem);
  let bytes;
  try {
    const stat = fileSystem.fstatSync(fd);
    if (stat.size <= 0 || stat.size > MAX_MCP_AUTH_FILE_BYTES) throw cryptoError();
    bytes = fileSystem.readFileSync(fd);
    const container = parseMcpAuthContainer(bytes);
    const ciphertext = Buffer.from(container.ciphertext, "base64");
    const format = isLocalFileCiphertext(ciphertext) ? "local"
      : ciphertext.subarray(0, 3).equals(Buffer.from("v10")) ? "legacy-v10" : null;
    if (!format) throw cryptoError();
    return {
      bytes, ciphertext, format,
      identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
    };
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    fileSystem.closeSync(fd);
  }
}

function clearSource(source) {
  source?.bytes.fill(0);
  source?.ciphertext.fill(0);
}

function assertMcpAuthSourceUnchanged(paths, source, fileSystem = fs) {
  const current = readMcpAuthMigrationSource(paths, fileSystem);
  try {
    if (!current.bytes.equals(source.bytes)
      || Object.keys(source.identity).some((field) => current.identity[field] !== source.identity[field])) {
      throw cryptoError();
    }
  } finally { clearSource(current); }
}

async function migrateLegacyMcpAuth(options) {
  const { paths, rewrap, assertCurrent } = options;
  const fileSystem = options.fs || fs;
  const createStorage = options.createLocalFileSafeStorage || createLocalFileSafeStorage;
  let source, local, key, candidate, secret;
  try {
    assertCurrent();
    source = readMcpAuthMigrationSource(paths, fileSystem);
    // A migration must never manufacture or replace a root key, even if the
    // ordinary Service previously failed to open its local crypto delegate.
    key = readPrivateFile(localCryptoKeyPath(paths), { fs: fileSystem, maxBytes: 32 });
    if (key.length !== 32) throw cryptoError();
    local = createStorage({ paths, fs: fileSystem, readOnly: true });
    if (source.format === "local") {
      secret = decodeMcpAuthSecretPlaintext(local.decryptString(source.ciphertext));
      assertCurrent();
      return { migrated: false, restartRequired: false };
    }
    candidate = await rewrap();
    assertCurrent();
    if (!Buffer.isBuffer(candidate) || !isLocalFileCiphertext(candidate)
      || candidate.length > MAX_MCP_AUTH_FILE_BYTES) throw cryptoError();
    secret = decodeMcpAuthSecretPlaintext(local.decryptString(candidate));
    const assertKeyUnchanged = () => {
      const current = readPrivateFile(localCryptoKeyPath(paths), { fs: fileSystem, maxBytes: 32 });
      try {
        if (current.length !== key.length || !crypto.timingSafeEqual(current, key)) throw cryptoError();
      } finally { current.fill(0); }
    };
    assertKeyUnchanged();
    assertMcpAuthSourceUnchanged(paths, source, fileSystem);
    assertCurrent();

    // Keep rollback evidence outside the store's .backup-* transaction names;
    // those names intentionally lock ordinary readers until recovery completes.
    const recoveryRoot = path.join(paths.stateDir, "crypto-recovery");
    ensurePrivateDirectoryTree(recoveryRoot, paths.trustedRoot);
    const recoveryDir = fileSystem.mkdtempSync(path.join(recoveryRoot, "mcp-auth-v10-"));
    fileSystem.chmodSync(recoveryDir, 0o700);
    atomicWritePrivateFile(path.join(recoveryDir, "mcp-auth.json"), source.bytes, {
      fs: fileSystem, trustedRoot: paths.trustedRoot,
    });
    // Persist both directory entries before replacing the only active copy.
    fsyncPrivateParent(recoveryRoot, fileSystem);
    fsyncPrivateParent(paths.stateDir, fileSystem);
    assertCurrent();
    assertKeyUnchanged();
    assertMcpAuthSourceUnchanged(paths, source, fileSystem);
    const serialized = Buffer.from(`${JSON.stringify({
      version: MCP_AUTH_STORE_VERSION, ciphertext: candidate.toString("base64"),
    })}\n`);
    let committed = false;
    try {
      atomicWritePrivateFile(paths.mcpAuthPath, serialized, {
        fs: fileSystem, trustedRoot: paths.trustedRoot, expectedIdentity: source.identity,
      });
      committed = true;
      const installed = readMcpAuthMigrationSource(paths, fileSystem);
      let readback;
      try {
        if (!installed.bytes.equals(serialized)) throw cryptoError();
        readback = decodeMcpAuthSecretPlaintext(local.decryptString(installed.ciphertext));
        if (!crypto.timingSafeEqual(readback, secret)) throw cryptoError();
        assertKeyUnchanged();
      } finally { readback?.fill(0); clearSource(installed); }
    } catch (error) {
      if (committed || error?.committed === true || error?.committedUncertain === true) {
        throw cryptoError("MCP_CRYPTO_MIGRATION_COMMIT_UNCERTAIN");
      }
      throw error;
    } finally { serialized.fill(0); }
    return { migrated: true, restartRequired: true };
  } finally {
    clearSource(source);
    key?.fill(0);
    if (Buffer.isBuffer(candidate)) candidate.fill(0);
    secret?.fill(0);
    local?.close();
  }
}

module.exports = { assertMcpAuthSourceUnchanged, clearSource, migrateLegacyMcpAuth, readMcpAuthMigrationSource };
