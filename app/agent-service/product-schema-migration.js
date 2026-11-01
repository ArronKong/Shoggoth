"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile, statIfExists, fsyncPrivateParent } = require("./private-file");
const { serviceError } = require("./security");

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const invalid = () => serviceError("STORE_MIGRATION_UNCONFIRMED", "Product schema migration could not be confirmed");

// Version 16 reads the validated v15 snapshot/journal in place. New appends and
// snapshots use v16; mixed journals retain each original checksum and sequence.
// Preserve the exact source bytes before returning a writable Store. Older
// binaries reject v16 instead of taking over and erasing attempt evidence.
function preserveLegacyProduct({ paths, fs, sources, from, to }) {
  if (from !== 15 || to !== 16 || !(sources instanceof Map)) throw invalid();
  const entries = [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([kind, bytes]) => {
    if (!["snapshot", "journal"].includes(kind) || !Buffer.isBuffer(bytes)) throw invalid();
    return { kind, bytes: bytes.length, sha256: hash(bytes) };
  });
  if (!entries.length) throw invalid();
  const digest = hash(JSON.stringify(entries));
  const directory = path.join(paths.stateDir, "product-schema-migrations", "15-to-16", digest);
  const options = { fs, trustedRoot: paths.trustedRoot || paths.stateDir };
  const saveOnce = (name, bytes) => {
    const file = path.join(directory, name);
    if (recoverInterruptedPrivateFile(file, options) === "uncertain") throw invalid();
    if (statIfExists(fs, file)) {
      const retained = readPrivateFile(file, { fs, maxBytes: Math.max(bytes.length, 64 * 1024) });
      if (!retained.equals(bytes)) throw invalid();
    } else atomicWritePrivateFile(file, bytes, options);
  };
  for (const { kind } of entries) saveOnce(kind + ".v15-source", sources.get(kind));
  const receipt = Buffer.from(JSON.stringify({ version: 1, from, to, digest, entries,
    mode: "validated-legacy-read-new-writes-v16", originalFilesRetained: true,
    synthesizedAcceptance: false, synthesizedAttempts: false }) + "\n");
  saveOnce("receipt.json", receipt);
  // The receipt may live in a newly created hierarchy. Persist every new
  // directory entry before the caller is permitted to repair the source log.
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    fsyncPrivateParent(cursor, fs);
    if (cursor === paths.stateDir) break;
    if (cursor === path.dirname(cursor)) throw invalid();
  }
  return Object.freeze({ digest, entries: Object.freeze(entries) });
}

module.exports = { preserveLegacyProduct };
