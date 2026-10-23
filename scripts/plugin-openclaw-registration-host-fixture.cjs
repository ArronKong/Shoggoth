"use strict";

// Exercise the production registrar and installed OpenClaw CLI in disposable
// homes. No Gateway, model turn, live configuration or external tool is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createExternalPluginAdapterRegistrar } = require("../app/external-plugin-adapter-registrar");

const ID = "shoggoth-shared-capabilities";
const TOOLS = ["shoggoth_capability_search", "shoggoth_skill_read",
  "shoggoth_skill_file_read", "shoggoth_plugin_resource_read", "shoggoth_plugin_call"];
const bin = process.env.SHOGGOTH_TEST_OPENCLAW_BIN || "openclaw";

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-openclaw-registration-"));
  try {
    for (const [name, plugins, blockedBy] of [
      ["fresh", undefined],
      ["empty-allow", { allow: [] }],
      ["existing-allow", { allow: ["memory-core"] }],
      ["disabled", { enabled: false }, "plugins.enabled"],
      ["denied", { allow: ["memory-core"], deny: [ID] }, "plugins.deny"],
      ["entry-disabled", { entries: { [ID]: { enabled: false } } }, "plugins.entries"],
    ]) {
      const home = path.join(root, name);
      const state = path.join(home, "openclaw");
      fs.mkdirSync(state, { recursive: true, mode: 0o700 });
      const configPath = path.join(state, "openclaw.json");
      const initial = { gateway: { mode: "local" },
        tools: { alsoAllow: ["read"] }, ...(plugins ? { plugins } : {}) };
      fs.writeFileSync(configPath, JSON.stringify(initial, null, 2) + "\n", { mode: 0o600 });
      const env = { ...process.env, HOME: home, OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_AUTO_UPDATE: "1", SHOGGOTH_SERVICE_USER_DATA_ROOT: home };
      delete env.OPENCLAW_PROFILE;
      const paths = resolveServicePaths({ stateRoot: path.join(home, "shoggoth"), userDataRoot: home,
        profileRoot: path.join(home, "profile"), cacheRoot: path.join(home, "cache"), trustedRoot: home });
      const registrar = createExternalPluginAdapterRegistrar({ paths, packaged: true,
        resourcesRoot: path.join(__dirname, "../resources/external-plugin-adapters"),
        openclawBin: bin, getHermesMode: () => "managed", env, timeoutMs: 30_000 });
      const before = fs.readFileSync(configPath);
      const outcome = await registrar.reconcile();
      if (blockedBy) {
        assert.equal(outcome.openclaw, false, name);
        assert(outcome.errors.openclaw.includes(blockedBy), JSON.stringify(outcome.errors));
        assert.deepEqual(fs.readFileSync(configPath), before, "user refusal must leave config untouched");
      } else {
        assert.equal(outcome.openclaw, true, JSON.stringify(outcome.errors));
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        assert.deepEqual(config.plugins.allow, name === "existing-allow" ? ["memory-core", ID] : plugins?.allow);
        assert.deepEqual(config.tools.alsoAllow, ["read", ...TOOLS]);
        const report = JSON.parse(execFileSync(bin, ["plugins", "inspect", ID, "--runtime", "--json"],
          { env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
        assert.equal(report.plugin?.status, "loaded", JSON.stringify(report.plugin));
        assert.deepEqual([...report.plugin.toolNames].sort(), [...TOOLS].sort());
        const registered = fs.readFileSync(configPath);
        assert.equal((await registrar.reconcile()).openclaw, true, `${name}: repeated startup`);
        assert.deepEqual(fs.readFileSync(configPath), registered, "repeated startup must not rewrite config");
      }
      console.log(`plugin-openclaw-registration-host-fixture: ${name} ok`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
