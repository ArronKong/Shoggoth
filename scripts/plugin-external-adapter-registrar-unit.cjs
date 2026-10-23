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
    let pluginPolicy = { allow: ["other-existing-plugin"], deny: ["other-blocked-plugin"] };
    let beforePluginAllowWrite;
    let ignorePluginAllowWrite = false;
    const execFile = (_command, args, _options, callback) => {
      calls.push(args);
      if (args[0] === "config" && args[1] === "get") {
        const value = args[2] === "plugins" ? pluginPolicy
          : args[2] === "tools.alsoAllow" ? toolAllow : openclawPaths;
        if (value === undefined) {
          callback(new Error("unset"), JSON.stringify({ ok: false, error: {
            type: "cli_error", message: `Config path is valid but unset: ${args[2]}.`,
          } }), "");
        } else callback(null, JSON.stringify(value), "");
        return;
      }
      if (args[0] === "config" && args[1] === "set") {
        if (args[2] === "plugins.allow") {
          beforePluginAllowWrite?.();
          const expectedAt = args.indexOf("--expect-current-json");
          assert(expectedAt > 0, "plugin allow writes must preserve concurrent edits");
          if (JSON.stringify(pluginPolicy.allow) !== args[expectedAt + 1]) {
            callback(new Error("plugins.allow changed concurrently"), "", "");
            return;
          }
          if (!ignorePluginAllowWrite) pluginPolicy.allow = JSON.parse(args[3]);
        } else if (args[2] === "tools.alsoAllow") toolAllow = JSON.parse(args[3]);
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
    assert.deepEqual(pluginPolicy, { allow: ["other-existing-plugin", "shoggoth-shared-capabilities"],
      deny: ["other-blocked-plugin"] });
    assert.deepEqual(toolAllow, ["other_existing_tool", "group_member_role_read", "group_messages_read", "group_task", "group_collaborate", "shoggoth_capability_search",
      "shoggoth_skill_read", "shoggoth_skill_file_read",
      "shoggoth_plugin_resource_read", "shoggoth_plugin_call"]);
    assert.equal(calls.some(args => args.includes("tools.deny") || args.includes("tools.allow")), false);
    const link = path.join(hermesHome, "plugins", "shoggoth_shared_capabilities");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert(fs.readlinkSync(link).startsWith(path.join(paths.stateDir, "external-plugin-adapters", "hermes")));
    assert.equal(fs.statSync(credentialPath(paths, "openclaw")).mode & 0o077, 0);
    assert.equal(fs.statSync(credentialPath(paths, "hermes")).mode & 0o077, 0);
    const writeCalls = calls.filter(args => args.includes("set") || args.includes("enable"));
    assert.equal(writeCalls.length, 4);
    const second = await registrar.reconcile();
    assert.equal(second.openclaw, true);
    assert.deepEqual(second.hermes, ["default"]);
    assert.equal(calls.filter(args => args.includes("set") || args.includes("enable")).length, 4);
    assert.deepEqual(parseToolAllowList(JSON.stringify({ ok: false,
      error: { type: "cli_error", message: "Config path is valid but unset: tools.alsoAllow." } })), []);
    assert.throws(() => parseToolAllowList(JSON.stringify(["good", ""])), /response invalid/);
    const managedCalls = [];
    const managedRegistrar = createExternalPluginAdapterRegistrar({ paths, packaged: true,
      resourcesRoot: path.join(__dirname, "../resources/external-plugin-adapters"),
      getOpenClawMode: () => "managed", getHermesMode: () => "managed",
      execFile(command, args, _options, callback) { managedCalls.push([command, args]); callback(null, "", ""); } });
    assert.equal((await managedRegistrar.reconcile()).openclaw, false);
    assert.equal(managedCalls.length, 0, "managed Host adapters must never write the old global OpenClaw configuration");

    const writes = () => calls.filter(args => args[0] === "config" && args[1] === "set");
    for (const policy of [undefined, {}, { allow: [] }]) {
      pluginPolicy = policy;
      const before = writes().length;
      assert.equal((await registrar.reconcile()).openclaw, true);
      assert.deepEqual(pluginPolicy, policy, "unrestricted plugin policies must stay unrestricted");
      assert.equal(writes().length, before);
    }
    for (const [policy, reason] of [
      [{ enabled: false }, "plugins.enabled"],
      [{ deny: [" Shoggoth-Shared-Capabilities "] }, "plugins.deny"],
      [{ entries: { "shoggoth-shared-capabilities": { enabled: false } } }, "plugins.entries"],
    ]) {
      pluginPolicy = policy;
      const before = writes().length;
      const blocked = await registrar.reconcile();
      assert.equal(blocked.openclaw, false);
      assert(blocked.errors.openclaw.includes(reason), blocked.errors.openclaw);
      assert.deepEqual(blocked.hermes, ["default"], "OpenClaw denial must not block Hermes registration");
      assert.deepEqual(pluginPolicy, policy);
      assert.equal(writes().length, before, "explicit plugin denial must not cause config writes");
    }
    for (const policy of [null, [], { allow: "wrong" }, { deny: [null] },
      { enabled: "false" }, { entries: { "shoggoth-shared-capabilities": { enabled: "false" } } },
      { ok: false, error: { type: "cli_error", message: "Configuration cannot be read" } }]) {
      pluginPolicy = policy;
      const before = writes().length;
      const invalid = await registrar.reconcile();
      assert.equal(invalid.openclaw, false);
      assert.match(invalid.errors.openclaw, /response invalid/);
      assert.equal(writes().length, before, "unreadable policy must not be replaced");
    }
    pluginPolicy = { allow: ["other-existing-plugin"] };
    beforePluginAllowWrite = () => { pluginPolicy.allow.push("concurrent-plugin"); };
    const raced = await registrar.reconcile();
    assert.equal(raced.openclaw, false);
    assert.match(raced.errors.openclaw, /changed concurrently/);
    assert.deepEqual(pluginPolicy.allow, ["other-existing-plugin", "concurrent-plugin"]);
    beforePluginAllowWrite = undefined;
    assert.equal((await registrar.reconcile()).openclaw, true, "the next startup must recover after a concurrent edit");
    assert.deepEqual(pluginPolicy.allow, ["other-existing-plugin", "concurrent-plugin", "shoggoth-shared-capabilities"]);
    pluginPolicy = { allow: ["other-existing-plugin"] };
    ignorePluginAllowWrite = true;
    const unverified = await registrar.reconcile();
    assert.equal(unverified.openclaw, false, "CLI success without a persisted allow entry is not registration success");
    assert.match(unverified.errors.openclaw, /plugins.allow/);
    ignorePluginAllowWrite = false;
    assert.equal((await registrar.reconcile()).openclaw, true);
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
