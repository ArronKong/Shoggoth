"use strict";

// First-party plugins ship in the App under resources/shoggoth-plugins/<id>/.
// On a real isolated Service: the first start installs and enables them, a
// restart changes nothing, an uninstall is remembered across restarts and App
// updates, a changed package updates in place (an enabled one is drained and
// enabled again with its old MCP bindings revoked; a disabled one stays
// disabled), an update interrupted after its drain resumes, moving the App
// keeps one installation, an invalid package is skipped without blocking the
// others, and an explicit reinstall works. The real shipped packages must
// all preview as installable so a broken one cannot be released.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFixture } = require("./plugin-real-host-service-fixture.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { FirstPartyPluginSync, firstPartyPluginRoot } = require("../app/agent-service/first-party-plugin-sync");

function write(directory, file, content, mode = 0o644) {
  const target = path.join(directory, ...file.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode });
  fs.chmodSync(target, mode);
}
const echoFiles = [
  { path: ".mcp.json", content: JSON.stringify({ mcpServers: { echo: { command: "./server/echo", args: [], cwd: "." } } }) },
  { path: "server/mcp-sdk-fixture.cjs", content: fs.readFileSync(path.join(__dirname, "fixtures/plugins/mcp-sdk-fixture.cjs"), "utf8") },
  { path: "server/echo", mode: 0o755, content: `#!${process.execPath}\nconst readline = require("node:readline");\n`
    + `const { handle } = require("./mcp-sdk-fixture.cjs");\nreadline.createInterface({ input: process.stdin }).on("line", line => {\n`
    + `  const response = handle(JSON.parse(line));\n  if (response) process.stdout.write(JSON.stringify(response) + "\\n");\n});\n` },
];
function codexPackage(root, id, version, extra = []) {
  const directory = path.join(root, id);
  fs.rmSync(directory, { recursive: true, force: true });
  write(directory, ".codex-plugin/plugin.json", JSON.stringify({ name: id, description: `${id} first-party fixture`,
    version, skills: "./skills/", ...(extra.length ? { mcpServers: "./.mcp.json" } : {}) }));
  write(directory, `skills/${id}/SKILL.md`, `---\nname: ${id}\ndescription: Use the ${id} fixture workflow.\n---\n# ${id}\nVersion ${version}.\n`);
  for (const file of extra) write(directory, file.path, file.content, file.mode);
}
function nativePackage(root, id, version) {
  const directory = path.join(root, id);
  fs.rmSync(directory, { recursive: true, force: true });
  write(directory, "plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: id, version, description: `${id} native fixture` }));
  write(directory, `skills/${id}/SKILL.md`, `---\nname: ${id}\ndescription: Use the ${id} native fixture.\n---\n# ${id}\nVersion ${version}.\n`);
}
const sha = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48);

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-fp-")));
  const resources = path.join(root, "resources-a");
  codexPackage(resources, "alpha", "1.0.0");
  codexPackage(resources, "echo-tools", "1.0.0", echoFiles);
  nativePackage(resources, "gamma", "1.0.0");
  fs.mkdirSync(path.join(resources, "broken", "skills", "broken"), { recursive: true });
  write(path.join(resources, "broken"), ".codex-plugin/plugin.json", JSON.stringify({ name: "broken", skills: "./skills/" }));
  write(path.join(resources, "broken"), "skills/broken/SKILL.md", "No frontmatter\n");
  fs.mkdirSync(path.join(resources, "Not_A_Package"));
  write(resources, "README.md", "Not a package\n");
  const options = { firstPartyPluginRoot: resources };
  const fixture = createFixture(root, "openclaw", options);
  try {
    let service = await fixture.start();
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    const backend = new ShoggothBackend({ paths: fixture.paths });
    backend._profilesByAgent.set(profile.agentId, profile);
    const ids = report => Object.fromEntries(Object.entries(report).map(([kind, items]) =>
      [kind, items.map(item => item.reason ? `${item.packageId}:${item.reason}` : item.packageId).sort()]));
    const of = id => service.pluginStore.getBySource(`first-party:${id}`);
    const set = (id, desiredState, operationId) => service.pluginServiceController.handle("plugins.installations.set", {
      installationId: of(id).installationId, desiredState, expectedRevision: of(id).revision, operationId });

    // First start: valid packages are installed and enabled; the broken one is skipped.
    assert.deepEqual(ids(await service.firstPartyPluginSyncDone()), { installed: ["alpha", "echo-tools", "gamma"],
      updated: [], unchanged: [], skipped: ["broken:PACKAGE_INVALID"], failed: [] });
    for (const id of ["alpha", "echo-tools", "gamma"]) assert.equal(of(id).desiredState, "enabled", id);
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 20, catalogRevision: null });
    assert.deepEqual(page.items.filter(item => item.sourceKind === "first-party").map(item => item.packageName).sort(),
      ["alpha", "echo-tools", "gamma"], "installed first-party plugins join the installed catalog");
    assert.deepEqual((await backend.listFirstPartyPlugins()).items.map(item => [item.packageId, item.installationState]),
      [["alpha", "enabled"], ["broken", "not-installed"], ["echo-tools", "enabled"], ["gamma", "enabled"]]);

    service = await fixture.restart();
    assert.deepEqual(ids(await service.firstPartyPluginSyncDone()).unchanged, ["alpha", "echo-tools", "gamma"]);

    // One confirmed activation gives echo-tools an MCP binding.
    const echoId = of("echo-tools").installationId;
    const activated = await service.pluginQuickSetup.activate({ profileId: profile.id, installationId: echoId,
      releaseDigest: of("echo-tools").releaseDigest, callId: crypto.randomUUID() });
    assert.deepEqual(activated.components.map(item => item.state), ["ready"], JSON.stringify(activated));
    const echoBindings = () => service.pluginStore.listGlobalBindings().filter(item => item.installationId === echoId);
    assert.equal(echoBindings().filter(item => item.enabled).length, 1);

    // The user uninstalls alpha and disables gamma.
    await set("alpha", "disabled", "fp-user-disable-alpha");
    await service.pluginServiceController.handle("plugins.uninstall", { installationId: of("alpha").installationId,
      expectedRevision: of("alpha").revision, operationId: "fp-user-uninstall-alpha" });
    await set("gamma", "disabled", "fp-user-disable-gamma");

    // A new App version changes every package.
    codexPackage(resources, "alpha", "1.1.0");
    codexPackage(resources, "echo-tools", "1.1.0", echoFiles);
    nativePackage(resources, "gamma", "1.1.0");
    service = await fixture.restart();
    assert.deepEqual(ids(await service.firstPartyPluginSyncDone()), { installed: [], updated: ["echo-tools", "gamma"],
      unchanged: [], skipped: ["alpha:USER_UNINSTALLED", "broken:PACKAGE_INVALID"], failed: [] });
    assert.equal(of("alpha").desiredState, "uninstalled", "an uninstall is remembered");
    assert.equal(of("echo-tools").desiredState, "enabled", "an enabled plugin is enabled again after its update");
    assert.equal(of("gamma").desiredState, "disabled", "a disabled plugin stays disabled");
    assert.equal(echoBindings().filter(item => item.enabled).length, 0, "the update revoked the old MCP binding");
    assert.deepEqual(service.pluginQuickSetup.inspect({ profileId: profile.id, installationId: echoId }).nextSteps, ["activate"]);

    // An update interrupted right after its drain resumes and enables again.
    codexPackage(resources, "echo-tools", "1.2.0", echoFiles);
    const digest = service.pluginPackageInstaller.previewFirstParty("echo-tools").contentDigest;
    await set("echo-tools", "disabled", `first-party-disable-${sha(["echo-tools", digest])}`);
    service = await fixture.restart();
    assert.deepEqual(ids(await service.firstPartyPluginSyncDone()).updated, ["echo-tools"]);
    assert.deepEqual([of("echo-tools").releaseDigest, of("echo-tools").desiredState], [digest, "enabled"]);

    // Moving the App keeps one installation per package.
    const moved = path.join(root, "resources-b");
    fs.cpSync(resources, moved, { recursive: true });
    options.firstPartyPluginRoot = moved;
    const before = service.pluginStore.listInstallations().length;
    service = await fixture.restart();
    assert.deepEqual(ids(await service.firstPartyPluginSyncDone()).unchanged, ["echo-tools", "gamma"]);
    assert.equal(service.pluginStore.listInstallations().length, before);

    // The user may reinstall an uninstalled first-party plugin explicitly.
    const reinstalled = await backend.installFirstPartyPlugin("alpha");
    assert.deepEqual([reinstalled.installation.sourceKind, reinstalled.installation.desiredState], ["first-party", "enabled"]);
    assert.equal(service.runtimeSkillStore.catalog(profile.id).items.some(item => item.description.includes("alpha")), true);
    await assert.rejects(backend.installFirstPartyPlugin("missing"), error => /FIRST_PARTY_PLUGIN_NOT_FOUND|not found/u.test(String(error?.code || error?.message)));

    // Every package that actually ships must be installable.
    const shipped = new FirstPartyPluginSync({ root: firstPartyPluginRoot(), installer: new PluginPackageInstaller({
      store: service.pluginStore, firstPartyRoot: firstPartyPluginRoot() }), store: service.pluginStore,
    setInstallationState: async () => { throw new Error("not used"); } });
    for (const id of shipped.packageIds()) {
      const preview = shipped.installer.previewFirstParty(id);
      assert.equal(preview.installable, true, `${id}: ${JSON.stringify(preview.diagnostics)}`);
    }
    console.log(`PASS first-party plugins: install, unchanged restart, remembered uninstall, update (enabled drained and re-enabled, disabled kept), resume, App move, invalid skip, reinstall; ${shipped.packageIds().length} shipped package(s) installable`);
  } finally {
    await fixture.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
