#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

async function run() {
  // Keep the Unix socket pathname within macOS's short sun_path limit.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/shg-cli-install-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache") });
  let service;
  const start = async (installed) => {
    service = createAgentService({ paths, version: "first-install-cli-regression",
      builtinCliProfiles: true, builtinCliInstalledAccountIds: installed });
    await service.start();
    return service.productStore.listAgentProfiles();
  };
  try {
    let profiles = await start([]);
    assert.deepEqual(profiles.map(profile => profile.name), ["Shoggoth"]);
    assert.equal(profiles[0].runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
    await service.stop();

    profiles = await start([NATIVE_CODEX_RUNTIME_ACCOUNT_ID]);
    assert.deepEqual(profiles.map(profile => profile.name), ["Shoggoth", "Codex"]);
    assert.equal(profiles[1].runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
    await service.stop();

    profiles = await start([]);
    assert.deepEqual(profiles.map(profile => profile.name), ["Shoggoth", "Codex"],
      "a previously created Agent must keep its persisted identity after CLI removal");
    console.log("PASS fresh install: bundled Shoggoth works without system CLI; only installed CLI seeds a native Agent; existing profile is preserved");
  } finally {
    await service?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
