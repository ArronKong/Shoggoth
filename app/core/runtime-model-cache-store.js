"use strict";

// Last good native composer model catalogs, so the first model menu after a
// launch shows them while each Runtime refreshes. Disposable: an unreadable or
// unexpected file is an empty cache.
const path = require("node:path");
const { readPrivateFile, atomicWritePrivateFile, recoverInterruptedPrivateFile } = require("../agent-service/private-file");

const MAX_BYTES = 8 * 1024 * 1024;

function createRuntimeModelCacheStore({ trustedRoot, directory = "ui-state" } = {}) {
  const filePath = path.join(trustedRoot, directory, "runtime-model-catalogs.json");
  return {
    filePath,
    read() {
      try {
        recoverInterruptedPrivateFile(filePath, { trustedRoot });
        const value = JSON.parse(readPrivateFile(filePath, { maxBytes: MAX_BYTES }).toString("utf8"));
        return value?.version === 1 && value.entries && typeof value.entries === "object" ? value.entries : {};
      } catch { return {}; }
    },
    write(entries) {
      atomicWritePrivateFile(filePath, JSON.stringify({ version: 1, entries }), { trustedRoot });
    },
  };
}

module.exports = { createRuntimeModelCacheStore };
