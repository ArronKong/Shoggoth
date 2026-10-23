"use strict";

// The Luckin plugin an Agent once shipped with a 251-line stdio bridge now
// needs only an HTTP declaration with `${secret:LUCKIN_MCP_TOKEN}`. The real
// Agent path (plugin_create → plugin_install → plugin_setup_get) accepts it
// on an isolated Service; no network request is made.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFixture } = require("./plugin-real-host-service-fixture.cjs");

const source = path.join(__dirname, "../examples/plugins/luckin-coffee");
const ENDPOINT = "https://gwmcp.lkcoffee.com/order/user/mcp";

function packageFiles(root, directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === ".codex-plugin" ? [] : packageFiles(root, target);
    return [{ path: path.relative(root, target).split(path.sep).join("/"), content: fs.readFileSync(target, "utf8") }];
  });
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, ".codex-plugin/plugin.json"), "utf8"));
  const files = packageFiles(source);
  assert.deepEqual(files.map(file => file.path).sort(), [".mcp.json", "README.md", "skills/luckin-coffee/SKILL.md"],
    "no bridge script or token file");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-lk-")));
  const fixture = createFixture(root, "openclaw");
  try {
    const service = await fixture.start();
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    const authority = (extra = {}) => ({ profileId: profile.id, callId: crypto.randomUUID(), ...extra });
    const invoke = (name, args, actor = authority()) => service.mcpProductToolController.handle(name, args, actor);

    const draft = await invoke("plugin_create", { name: manifest.name, description: manifest.description,
      version: manifest.version, files });
    assert.equal(draft.installable, true, JSON.stringify(draft.diagnostics));
    assert.deepEqual(draft.previewComponents.mcpServers.map(item => [item.name, item.type]), [["my-coffee", "streamable-http"]]);
    const installed = await invoke("plugin_install", { draftId: draft.draftId, previewDigest: draft.previewDigest,
      expectedRevision: 0, enable: true }, authority({ confirmation: true }));
    const installationId = installed.installation.installationId;
    assert.deepEqual(installed.nextSteps, ["provide_secret:LUCKIN_MCP_TOKEN"]);

    const setup = await invoke("plugin_setup_get", { installationId });
    assert.deepEqual(setup.components.map(item => [item.name, item.transport, item.target, item.state, item.secrets]),
      [["my-coffee", "streamable-http", ENDPOINT, "secret_required", [{ name: "LUCKIN_MCP_TOKEN", configured: false }]]]);
    assert.deepEqual(service.pluginQuickSetup.listSecrets({ profileId: profile.id, installationId }).items, [{
      name: "LUCKIN_MCP_TOKEN", configured: false,
      destinations: [{ component: "my-coffee", kind: "header", key: "Authorization", origin: "https://gwmcp.lkcoffee.com" }] }]);
    console.log("PASS luckin example: HTTP + ${secret:LUCKIN_MCP_TOKEN} installs through the Agent path without a bridge");
  } finally {
    await fixture.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
