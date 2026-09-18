#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PRE_RUNTIME_SCHEMA_BACKUP_ID } = require("../app/agent-service/runtime-schema-migration");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");

function safeStorageFixture() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`fixture:${value}`, "utf8"),
    decryptString: (value) => Buffer.from(value).toString("utf8").slice("fixture:".length),
  };
}

(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rb-")));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  const historical = path.join(paths.backupsDir, "pre-runtime-schema-v6");
  fs.mkdirSync(historical, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(historical, "payload.bin"), Buffer.alloc(256));
  const service = createAgentService({
    paths,
    version: "runtime-backup-service-test",
    safeStorage: safeStorageFixture(),
  });
  try {
    await service.start();
    const currentPath = path.join(paths.backupsDir, PRE_RUNTIME_SCHEMA_BACKUP_ID);
    if (!fs.existsSync(currentPath)) {
      fs.mkdirSync(currentPath, { mode: 0o700 });
      fs.writeFileSync(path.join(currentPath, "payload.bin"), Buffer.alloc(32));
    }
    const token = readClientToken(paths);
    const listed = await requestService(paths, {
      method: "runtime.account.backups.list",
      token,
      version: PROTOCOL_VERSION,
      params: { cursor: null, limit: 100 },
    });
    const history = listed.backups.find(
      (backup) => backup.category === "runtime-schema-history",
    );
    const current = listed.backups.find(
      (backup) => backup.category === "runtime-schema-current",
    );
    assert.ok(history);
    assert.equal(history.role, "reclaimable");
    assert.ok(current);
    assert.equal(current.role, "retained");
    assert.equal(JSON.stringify(listed).includes(root), false);
    assert.equal(JSON.stringify(listed).includes("pre-runtime-schema-v6"), false);

    await assert.rejects(
      requestService(paths, {
        method: "runtime.account.backups.cleanup.prepare",
        token,
        version: PROTOCOL_VERSION,
        params: { entryId: current.id },
      }),
      { code: "RUNTIME_BACKUP_CANDIDATE_NOT_RECLAIMABLE" },
    );
    const plan = await requestService(paths, {
      method: "runtime.account.backups.cleanup.prepare",
      token,
      version: PROTOCOL_VERSION,
      params: { entryId: history.id },
    });
    assert.equal(plan.bytes, 256);
    assert.equal(JSON.stringify(plan).includes(root), false);
    const result = await requestService(paths, {
      method: "runtime.account.backups.cleanup.commit",
      token,
      version: PROTOCOL_VERSION,
      params: { planId: plan.planId },
    });
    assert.equal(result.bytesReleased, 256);
    assert.equal(fs.existsSync(historical), false);
    assert.equal(fs.existsSync(path.join(paths.backupsDir, PRE_RUNTIME_SCHEMA_BACKUP_ID)), true);
    assert.equal(fs.existsSync(paths.backupCleanupAuditPath), true);
    process.stdout.write("PASS Runtime backup Service inventory + readiness gate + opaque cleanup\n");
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
