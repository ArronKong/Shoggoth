"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile, statIfExists, fsyncPrivateParent } = require("./private-file");
const { serviceError } = require("./security");
const { STORE_SCHEMA_VERSION } = require("./product-store");

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const invalid = () => serviceError("STORE_MIGRATION_UNCONFIRMED", "Product schema migration could not be confirmed");

// Read validated legacy snapshots and journals in place, keeping their original
// checksums and sequence. Preserve the exact source before the first writable
// open; older binaries refuse the new format rather than drop new fields.
function preserveLegacyProduct({ paths, fs, sources, from, to }) {
  if (![15, 16].includes(from) || to !== STORE_SCHEMA_VERSION || !(sources instanceof Map)) throw invalid();
  const entries = [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([kind, bytes]) => {
    if (!["snapshot", "journal"].includes(kind) || !Buffer.isBuffer(bytes)) throw invalid();
    return { kind, bytes: bytes.length, sha256: hash(bytes) };
  });
  if (!entries.length) throw invalid();
  const digest = hash(JSON.stringify(entries));
  const directory = path.join(paths.stateDir, "product-schema-migrations", `${from}-to-${to}`, digest);
  const options = { fs, trustedRoot: paths.trustedRoot || paths.stateDir };
  const saveOnce = (name, bytes) => {
    const file = path.join(directory, name);
    if (recoverInterruptedPrivateFile(file, options) === "uncertain") throw invalid();
    if (statIfExists(fs, file)) {
      const retained = readPrivateFile(file, { fs, maxBytes: Math.max(bytes.length, 64 * 1024) });
      if (!retained.equals(bytes)) throw invalid();
    } else atomicWritePrivateFile(file, bytes, options);
  };
  for (const { kind } of entries) saveOnce(`${kind}.v${from}-source`, sources.get(kind));
  const receipt = Buffer.from(JSON.stringify({ version: 1, from, to, digest, entries,
    mode: `validated-legacy-read-new-writes-v${to}`, originalFilesRetained: true,
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
