"use strict";
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");

// Each Service-owned native backend has its own execution/background budget.
// OpenClaw and Hermes keep their own schedulers and never enter these budgets.
const limits = { backend: 4, account: 4, backendBackground: 2, profile: 4 };

function migrateLegacyProfileConcurrency(store, paths) {
  const marker = paths ? path.join(paths.stateDir, "native-concurrency-v1.json") : null;
  if (marker) {
    if (recoverInterruptedPrivateFile(marker, { trustedRoot: paths.trustedRoot }) === "uncertain") {
      throw serviceError("NATIVE_CONCURRENCY_MIGRATION_UNCERTAIN", "原生并发设置迁移尚未确认");
    }
    if (lstatIfExists(marker)) {
      const value = JSON.parse(readPrivateFile(marker, { maxBytes: 1024 }).toString("utf8"));
      if (value?.version !== 1 || Object.keys(value).length !== 1) {
        throw serviceError("NATIVE_CONCURRENCY_MIGRATION_INVALID", "原生并发设置迁移记录无效");
      }
      return 0;
    }
  }
  let changed = 0;
  for (const profile of store.listAgentProfiles()) {
    // Upgrade the old generated default, preserving other custom policies.
    if (profile.concurrency.maxActive !== 1 || profile.concurrency.maxWorkspaceWrites !== 1) continue;
    store.putAgentProfile({ ...profile, concurrency: {
      maxActive: limits.profile, maxWorkspaceWrites: limits.profile,
    } });
    changed += 1;
  }
  // Mark only after every profile write is durable. A crash repeats a partial
  // migration safely; later intentional 1/1 policies are no longer upgraded.
  if (marker) atomicWritePrivateFile(marker, `${JSON.stringify({ version: 1 })}\n`, { trustedRoot: paths.trustedRoot });
  return changed;
}

module.exports = Object.freeze({ ...limits, migrateLegacyProfileConcurrency });
