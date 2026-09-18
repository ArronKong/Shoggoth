import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveServicePaths } = require("../app/agent-service/paths");
const { legacyHomeId } = require("../app/agent-service/legacy-runtime-home-store");
const {
  MIGRATION_STAGES,
  RuntimeAccountMigrationJournal,
} = require("../app/agent-service/runtime-account-migration-journal");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-migration-"));
try {
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profiles"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  const inputDigest = "a".repeat(64);
  const outputDigest = "b".repeat(64);
  const legacyHomes = [{
    id: legacyHomeId(
      "codex",
      "profile-a-runtime-v1",
      "shoggoth-internal-codex-default-v1",
    ),
    runtime: "codex",
    runtimeProfileId: "profile-a-runtime-v1",
    runtimeAccountId: "shoggoth-internal-codex-default-v1",
    relativePath: path.join("codex", "profile-a-runtime-v1"),
    classification: "managed-canonical",
  }];
  let journal = new RuntimeAccountMigrationJournal({ paths, now: () => 100 }).open();
  journal.plan({ generation: 1, inputDigest, legacyHomes });
  journal.close();

  for (const nextStage of MIGRATION_STAGES.slice(1)) {
    journal = new RuntimeAccountMigrationJournal({ paths, now: () => 101 }).open();
    const current = journal.read();
    let injected = false;
    const crashing = new RuntimeAccountMigrationJournal({
      paths,
      now: () => 102,
      atomicWrite() {
        injected = true;
        throw Object.assign(new Error("simulated pre-commit crash"), { code: "EIO" });
      },
    }).open();
    assert.throws(
      () => crashing.advance({
        generation: 1,
        inputDigest,
        nextStage,
        outputDigest: nextStage === "metadata_backed_up" ? outputDigest : undefined,
      }),
      { code: "RUNTIME_ACCOUNT_MIGRATION_WRITE_FAILED" },
    );
    assert.equal(injected, true);
    crashing.close();
    assert.deepEqual(new RuntimeAccountMigrationJournal({ paths }).open().read(), current);
    journal.advance({
      generation: 1,
      inputDigest,
      nextStage,
      outputDigest: nextStage === "metadata_backed_up" ? outputDigest : undefined,
    });
    journal.close();
  }

  journal = new RuntimeAccountMigrationJournal({ paths }).open();
  assert.equal(journal.read().stage, "cleanup_eligible");
  assert.equal(journal.read().outputDigest, outputDigest);
  journal.close();
  process.stdout.write(`runtime account migration crash soak: ${MIGRATION_STAGES.length} stages passed\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
