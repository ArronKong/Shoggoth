"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginMcpLaunchPlanner } = require("../app/agent-service/plugin-mcp-launch-planner");

const fixture = path.join(__dirname, "fixtures/plugins/project-assistant");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-launch-plan-"));
const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), trustedRoot: temp });
const store = new PluginStore({ paths }).open();
try {
  const installer = new PluginPackageInstaller({ store });
  const planner = new PluginMcpLaunchPlanner({ store });
  function install(source, operationId) {
    const preview = installer.preview(source);
    const installed = installer.install({ sourcePath: source, previewDigest: preview.contentDigest,
      operationId, expectedRevision: 0 });
    store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const components = new PluginComponentCatalog({ store }).list()
      .find((item) => item.installationId === installed.installationId).components;
    const input = (name) => {
      const component = components.find((item) => item.localName === name);
      return { installationId: installed.installationId, releaseDigest: installed.releaseDigest,
        componentId: component.componentId, descriptorDigest: component.descriptorDigest };
    };
    return { installed, input };
  }

  const nonExecutable = path.join(temp, "non-executable");
  fs.cpSync(fixture, nonExecutable, { recursive: true });
  const first = install(nonExecutable, "launch-non-executable");
  assert.throws(() => planner.planStdio(first.input("local-issues")),
    (error) => error.code === "DEPENDENCY_MISSING");
  assert.throws(() => planner.planStdio(first.input("remote-issues")),
    (error) => error.code === "MCP_SERVER_TRANSPORT_UNSUPPORTED");

  const executable = path.join(temp, "executable");
  fs.cpSync(fixture, executable, { recursive: true });
  fs.chmodSync(path.join(executable, "bin/issue-fixture"), 0o700);
  const second = install(executable, "launch-executable");
  const plan = planner.planStdio(second.input("local-issues"));
  assert.equal(plan.source, "plugin");
  assert.equal(plan.command, path.join(plan.pluginRoot, "bin/issue-fixture"));
  assert.equal(fs.statSync(plan.command).mode & 0o777, 0o700);
  assert.equal(plan.cwd, "${PLUGIN_ROOT}");
  assert.deepEqual(plan.args, ["--data", "${PLUGIN_DATA}/issues"]);
  fs.chmodSync(plan.command, 0o600);
  assert.throws(() => planner.planStdio(second.input("local-issues")),
    (error) => error.code === "PACKAGE_CHANGED");

  const bare = path.join(temp, "bare-command");
  fs.cpSync(fixture, bare, { recursive: true });
  const mcpPath = path.join(bare, "mcp.json");
  const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  mcp.mcpServers["local-issues"].command = "node";
  fs.writeFileSync(mcpPath, JSON.stringify(mcp));
  const third = install(bare, "launch-bare");
  assert.throws(() => planner.planStdio(third.input("local-issues")),
    (error) => error.code === "DEPENDENCY_PREPARATION_REQUIRED");
  console.log("plugin MCP launch planner: PASS");
} finally {
  store.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
