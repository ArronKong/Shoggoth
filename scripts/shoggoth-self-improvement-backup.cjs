"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
const { openLearningFixture } = require("./fixtures/self-improvement-service.cjs");
const { LearningStore } = require("../app/agent-service/self-improvement/store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAuthorityBackup, restoreAuthorityBackup, verifyAuthorityBackup } = require("../app/agent-service/authority-backup");
async function run() {
  const f = await openLearningFixture(); let restored;
  try {
    await f.review("auto"); const skill = f.service.learningStore.allSkills(f.profile.id)[0];
    await f.service.stop({ notify: false });
    const backup = createAuthorityBackup({ paths: f.paths, backupId: "learning-before-forget" });
    const source = new LearningStore({ paths: f.paths }).open();
    source.revokeVersion(f.profile.id, skill.id, skill.head); source.close();
    const destinationStateDir = path.join(f.root, "restored-state");
    const result = restoreAuthorityBackup({ paths: f.paths, backupId: "learning-before-forget", destinationStateDir });
    assert.equal(result.learningRestore.withdrawnVersions, 1); assert.equal(result.learningRestore.consentReset, true);
    restored = new LearningStore({ paths: resolveServicePaths({ stateRoot: destinationStateDir, trustedRoot: f.paths.trustedRoot }) }).open();
    assert.equal(restored.settings(f.profile.id).config.mode, "off"); assert.equal(restored.hasEnabledConsent(), false);
    assert.throws(() => restored.readFile(f.profile.id, skill.id, skill.head), { code: "LEARNING_VERSION_UNAVAILABLE" });
    assert.equal(restored.job(skill.lastJobId).proposal, null); assert.equal(restored.budget(f.profile.id).tokens, 720);
    assert.equal(verifyAuthorityBackup({ paths: f.paths, backupId: "learning-before-forget" }).manifest.rootDigest, backup.manifest.rootDigest);
    console.log("PASS real authority backup/restore: later withdrawal survives old snapshot, immutable backup unchanged, consent reset, no replay and quota retained");
  } finally { restored?.close(); await f.close(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
