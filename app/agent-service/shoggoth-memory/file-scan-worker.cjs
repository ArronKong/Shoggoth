"use strict";

const { parentPort } = require("node:worker_threads");
const { FileMemoryStore, projectInvalidation } = require("./file-store.cjs");
const { sha256 } = require("./migration.cjs");
const { canonicalSharedPath } = require("./shared-document.cjs");

// The owner passes a validated workspace and an optional previous filesystem
// identity. This Worker has no database or writer access.
let active = null;
let lastId = 0;
async function scan({ id, profileId, root, snapshotStamp }) {
  const reader = new FileMemoryStore({ paths: {}, database: null,
    migration: { locations: () => ({ workspace: root }) }, getHost: () => null });
  const reply = result => parentPort.postMessage({ id, ...result });
  try {
    const identities = [];
    const fileStamp = reader._filesystemStamp(profileId, true, identities);
    if (fileStamp === snapshotStamp) {
      reply({ fileStamp, identities, unchanged: true });
    } else {
      const { rows, current, tracked } = await new Promise(resolve => {
        active.resolveMetadata = resolve;
        reply({ needsMetadata: true });
      });
      const files = reader._files(profileId, true);
      const metadata = new Map(rows.map(row => [row.id, JSON.parse(row.data)]));
      const projection = reader._projectSnapshot(profileId, files, metadata, true);
      const fingerprint = sha256(JSON.stringify(files));
      const revision = current.revision + Number(current.fingerprint !== fingerprint);
      const invalidation = projectInvalidation(tracked, files, fingerprint, revision);
      if (fileStamp !== reader._filesystemStamp(profileId, true)) {
        reply({ errorCode: "MEMORY_REVISION_CONFLICT" });
      } else {
        const sharedDocuments = new Map(files.filter(file => canonicalSharedPath(file.path))
          .map(file => [file.path, file.content]));
        reply({ fileStamp, identities, fingerprint, ...projection, sharedDocuments, metadata, invalidation });
      }
    }
  } catch (error) {
    reply({ errorCode: error?.code === "MEMORY_SCAN_TOO_LARGE" ? error.code : "MEMORY_SCAN_UNAVAILABLE" });
  } finally { active = null; }
}

parentPort.on("message", message => {
  if (!active && message.scan && Number.isSafeInteger(message.id) && message.id > lastId) {
    lastId = message.id;
    active = { id: message.id, resolveMetadata: null };
    void scan({ ...message.scan, id: message.id });
  } else if (active?.resolveMetadata && message.id === active.id && message.metadata) {
    const resolve = active.resolveMetadata;
    active.resolveMetadata = null;
    resolve(message.metadata);
  }
});
