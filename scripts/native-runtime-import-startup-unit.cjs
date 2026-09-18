#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { createAgentService } = require(path.join(
  ROOT, "app", "agent-service", "server.js",
));
const { acquirePrivateWriterLease } = require(path.join(
  ROOT, "app", "agent-service", "private-writer-lease.js",
));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));

const PERSISTENT_WRITER_LOCKS = Object.freeze([
  "chat-sessions.writer.lock",
  "native-cron.writer.lock",
  "native-kanban.writer.lock",
  "pending-commands.writer.lock",
]);

function write(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, value, { mode: 0o600 });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sri-"));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  write(path.join(home, ".codex", "AGENTS.md"), "# Imported instructions\n");
  write(
    path.join(paths.stateDir, "codex", "existing-profile", "AGENTS.md"),
    "# Existing managed instructions\n",
  );
  for (const lockBasename of PERSISTENT_WRITER_LOCKS) {
    acquirePrivateWriterLease({
      lockPath: path.join(paths.stateDir, lockBasename),
      trustedRoot: paths.trustedRoot,
      pid: 2_147_483_647,
      getProcessIdentity: () => "stale-writer-test-owner",
    });
  }
  let service = createAgentService({
    paths,
    version: "native-import-startup",
    builtinCliProfiles: true,
    nativeRuntimeImportHome: home,
  });
  try {
    await service.start();
    const imported = path.join(
      paths.stateDir, "codex", "shoggoth-codex-cli-v1", "AGENTS.md",
    );
    assert.equal(fs.readFileSync(imported, "utf8"), "# Imported instructions\n");
    assert.equal(fs.existsSync(paths.nativeRuntimeImportPath), true);
    assert.equal(
      fs.existsSync(path.join(paths.backupsDir, "pre-native-runtime-import-v1")),
      true,
    );
    const summary = service.getNativeRuntimeImportSummary();
    assert.equal(summary.results.length, 6);
    assert.equal(summary.results.find((result) => result.runtime === "codex").status, "imported");
    await service.stop();

    write(path.join(home, ".codex", "AGENTS.md"), "# Changed after snapshot\n");
    service = createAgentService({
      paths,
      version: "native-import-startup-restart",
      builtinCliProfiles: true,
      nativeRuntimeImportHome: home,
    });
    await service.start();
    assert.equal(fs.readFileSync(imported, "utf8"), "# Imported instructions\n");
    assert.equal(service.getNativeRuntimeImportSummary().results
      .find((result) => result.runtime === "codex").status, "already_imported");
    await service.stop();
    assert.deepEqual(
      fs.readdirSync(paths.stateDir).filter((name) => name.includes(".writer.lock")),
      [],
    );
    console.log("PASS native Runtime import startup unit");
  } finally {
    await service.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
