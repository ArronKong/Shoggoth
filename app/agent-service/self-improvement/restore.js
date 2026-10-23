"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("../inspiration-database");
const { validateCanonicalOwnedDirectory } = require("../runtime-storage-inspector");
const { fail, id, hash, integer, LIMITS } = require("./protocol");

// Called only by the stopped-Service authority restore protocol. This is
// metadata, never an authorization grant or a copy of learned content.
function readLearningRestoreBarrier(paths) {
  const file = path.join(paths.stateDir, "self-improvement.sqlite");
  if (!fs.existsSync(file)) return null;
  validateCanonicalOwnedDirectory(paths.stateDir, { trustedRoot: paths.trustedRoot });
  const db = openDatabase(file, { readOnly: true });
  try {
    if (![1, 2].includes(db.prepare("PRAGMA user_version").get().user_version)
      || db.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("LEARNING_STORE_CORRUPT");
    const liveVersions = db.prepare("SELECT versions.data FROM versions JOIN skills ON skills.id=versions.skill_id WHERE versions.revoked=0").all()
      .map(row => { const value = JSON.parse(row.data);
        if (!id(value.profileId) || !id(value.skillId) || !hash(value.hash)) fail("LEARNING_STORE_CORRUPT");
        return { profileId: value.profileId, skillId: value.skillId, hash: value.hash }; });
    const calls = db.prepare("SELECT * FROM calls").all();
    for (const call of calls) if (!id(call.job_id) || !id(call.profile_id) || !integer(call.attempt, 1, LIMITS.calls)
      || !integer(call.charge) || typeof call.day !== "string") fail("LEARNING_STORE_CORRUPT");
    return { liveVersions, calls };
  } finally { db.close(); }
}
module.exports = { readLearningRestoreBarrier };
