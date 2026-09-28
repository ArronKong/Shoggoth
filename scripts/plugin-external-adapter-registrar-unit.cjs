"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createExternalPluginAdapterRegistrar, parseToolAllowList } = require("../app/external-plugin-adapter-registrar");
const { credentialPath } = require("../app/agent-service/external-plugin-adapter-auth");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-adapter-registrar-"));
  try {
    const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), userDataRoot: root,
      profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
    const hermesHome = path.join(root, "hermes");
    fs.mkdirSync(hermesHome, { mode: 0o700 });
    const calls = [];
    let openclawPaths = ["/other/plugin"];
    let toolAllow = ["other_existing_tool"];
    const execFile = (_command, args, _options, callback) => {
      calls.push(args);
      if (args[0] === "config" && args[1] === "get") {
        callback(null, JSON.stringify(args[2] === "tools.alsoAllow" ? toolAllow : openclawPaths), "");
        return;
      }
      if (args[0] === "config" && args[1] === "set") {
        if (args[2] === "tools.alsoAllow") toolAllow = JSON.parse(args[3]);
        else openclawPaths = JSON.parse(args[3]);
      }
      callback(null, "", "");
    };
    const registrar = createExternalPluginAdapterRegistrar({ paths, packaged: true,
      resourcesRoot: path.join(__dirname, "../resources/external-plugin-adapters"),
      hermesHome, openclawBin: "openclaw-fixture", hermesBin: "hermes-fixture",
      listHermesProfiles: () => ["default"], execFile });
    const first = await registrar.reconcile();
    assert.equal(first.openclaw, true);
    assert.deepEqual(first.hermes, ["default"]);
    assert.deepEqual(first.errors, {});
    assert.equal(openclawPaths[0], "/other/plugin");
    assert(openclawPaths[1].startsWith(path.join(paths.stateDir, "external-plugin-adapters", "openclaw")));
    assert.deepEqual(toolAllow, ["other_existing_tool", "shoggoth_capability_search",
      "shoggoth_skill_read", "shoggoth_skill_file_read", "shoggoth_plugin_call"]);
    assert.equal(calls.some(args => args.includes("tools.deny") || args.includes("tools.allow")), false);
    const link = path.join(hermesHome, "plugins", "shoggoth_shared_capabilities");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert(fs.readlinkSync(link).startsWith(path.join(paths.stateDir, "external-plugin-adapters", "hermes")));
    assert.equal(fs.statSync(credentialPath(paths, "openclaw")).mode & 0o077, 0);
    assert.equal(fs.statSync(credentialPath(paths, "hermes")).mode & 0o077, 0);
    const writeCalls = calls.filter(args => args.includes("set") || args.includes("enable"));
    assert.equal(writeCalls.length, 3);
    const second = await registrar.reconcile();
    assert.equal(second.openclaw, true);
    assert.deepEqual(second.hermes, ["default"]);
    assert.equal(calls.filter(args => args.includes("set") || args.includes("enable")).length, 3);
    assert.deepEqual(parseToolAllowList(JSON.stringify({ ok: false,
      error: { type: "cli_error", message: "Config path is valid but unset: tools.alsoAllow." } })), []);
    assert.throws(() => parseToolAllowList(JSON.stringify(["good", ""])), /response invalid/);
    fs.unlinkSync(link);
    fs.mkdirSync(link);
    const conflict = await registrar.reconcile();
    assert.equal(conflict.hermes.length, 0);
    assert.match(conflict.errors["hermes:default"], /belongs to another plugin/);
    assert.equal(fs.lstatSync(link).isDirectory(), true);
    console.log("plugin-external-adapter-registrar-unit: ok");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
