"use strict";

// Runs against locally installed host CLIs, but writes only to a throwaway Home.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createExternalPluginAdapterRegistrar } = require("../app/external-plugin-adapter-registrar");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-external-hosts-"));
  try {
    const hermesHome = path.join(root, "hermes");
    fs.mkdirSync(hermesHome, { mode: 0o700 });
    const env = { ...process.env, HOME: root, HERMES_HOME: hermesHome,
      OPENCLAW_STATE_DIR: path.join(root, "openclaw"), TMPDIR: os.tmpdir(),
      PYTHONDONTWRITEBYTECODE: "1" };
    const paths = resolveServicePaths({ stateRoot: path.join(root, "shoggoth"), userDataRoot: root,
      profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
    const registrar = createExternalPluginAdapterRegistrar({ paths, packaged: true,
      resourcesRoot: path.join(__dirname, "../resources/external-plugin-adapters"),
      openclawBin: process.env.SHOGGOTH_TEST_OPENCLAW_BIN || "openclaw",
      hermesBin: process.env.SHOGGOTH_TEST_HERMES_BIN || "hermes", hermesHome, env });
    const outcome = await registrar.reconcile();
    assert.equal(outcome.openclaw, true, JSON.stringify(outcome.errors));
    assert.deepEqual(outcome.hermes, ["default"], JSON.stringify(outcome.errors));
    const pluginList = JSON.parse(execFileSync(process.env.SHOGGOTH_TEST_OPENCLAW_BIN || "openclaw",
      ["plugins", "list", "--json"], { env, encoding: "utf8", timeout: 15_000 }));
    const plugin = pluginList.plugins.find(item => item.id === "shoggoth-shared-capabilities");
    assert.equal(plugin?.status, "loaded", JSON.stringify(plugin));
    assert.deepEqual(plugin.toolNames.sort(), ["shoggoth_capability_search",
      "shoggoth_plugin_call", "shoggoth_skill_file_read", "shoggoth_skill_read"]);
    const alsoAllow = JSON.parse(execFileSync(process.env.SHOGGOTH_TEST_OPENCLAW_BIN || "openclaw",
      ["config", "get", "tools.alsoAllow", "--json"],
      { env, encoding: "utf8", timeout: 15_000 }));
    assert.deepEqual(alsoAllow, ["shoggoth_capability_search", "shoggoth_skill_read",
      "shoggoth_skill_file_read", "shoggoth_plugin_call"]);
    const hermesList = execFileSync(process.env.SHOGGOTH_TEST_HERMES_BIN || "hermes",
      ["plugins", "list", "--plain", "--no-bundled"],
      { env, encoding: "utf8", timeout: 15_000 });
    assert.match(hermesList, /enabled\s+user\s+0\.1\.0\s+shoggoth_shared_capabilities/u);
    console.log("plugin-external-adapter-host-fixture: ok");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
