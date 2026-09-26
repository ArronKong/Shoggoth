"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
const { PluginSkillFacade } = require("../app/agent-service/plugin-skill-facade");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-skill-facade-"));
const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
const store = new PluginStore({ paths }).open();
const nativeItem = { id: "native-review", name: "native-review", version: "1.0.0",
  description: "Native review", source: "user", contentHash: "a".repeat(64),
  requiredTools: [], requiredRuntimeCapabilities: [] };
const nativeStore = {
  catalog() { return { registryRevision: "native-revision", profileRevision: 1,
    items: [nativeItem], ineligible: [] }; },
  select(profileId, query) {
    if (query.includes("$plugin-")) {
      const failure = new Error("Skill not found");
      failure.code = "SKILL_NOT_FOUND";
      throw failure;
    }
    return { ...this.catalog(profileId), selected:
      query.includes("$native-review") ? [nativeItem] : [] };
  },
  read(input) {
    if (input.name !== nativeItem.name) {
      const failure = new Error("Skill not enabled");
      failure.code = "SKILL_NOT_ENABLED";
      throw failure;
    }
    return { ...nativeItem, content: "Native content" };
  },
};

try {
  const installer = new PluginPackageInstaller({ store });
  const installations = [];
  for (const suffix of ["a", "b"]) {
    const source = path.join(root, `source-${suffix}`);
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source,
      { recursive: true });
    const preview = installer.preview(source);
    const installed = installer.install({ sourcePath: source,
      previewDigest: preview.contentDigest, operationId: `skill-install-${suffix}`,
      expectedRevision: 0 });
    installations.push(store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision }));
  }
  const facade = new PluginSkillFacade({ nativeStore,
    resolver: new PluginComponentResolver({ store }) });
  const catalog = facade.catalog("agent-a");
  const plugins = catalog.items.filter((item) => item.source === "plugin");
  assert.equal(plugins.length, 2);
  assert.notEqual(plugins[0].name, plugins[1].name);
  assert(plugins.every((item) => /^plugin-[a-f0-9]{56}$/u.test(item.name)));
  assert.deepEqual(facade.catalog("agent-b").items.filter(item => item.source === "plugin"), plugins,
    "future profiles discover locally installed package Skills without a binding");
  assert.deepEqual(facade.catalog("agent-a", { allowPluginSkills: false }),
    nativeStore.catalog("agent-a"));
  assert.throws(() => facade.select("agent-a", `$${plugins[0].name}`,
    { allowPluginSkills: false }), { code: "SKILL_NOT_FOUND" });
  const query = `$native-review $${plugins[0].name} $${plugins[1].name}`;
  assert.deepEqual(facade.select("agent-a", query).selected.map((item) => item.name),
    [nativeItem.name, plugins[0].name, plugins[1].name]);
  assert.throws(() => facade.select("agent-a", `${query} $missing $other`),
    { code: "SKILL_SELECTION_LIMIT" });
  const read = facade.read({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash });
  assert.match(read.content, /issue-summary/u);
  assert.equal(facade.read({ profileId: "agent-a", name: nativeItem.name }).content,
    "Native content");
  const first = installations[0];
  const disabled = store.setInstallationDesiredState({ installationId: first.installationId,
    desiredState: "disabled", expectedRevision: first.revision });
  assert.throws(() => facade.read({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash }), { code: "SKILL_NOT_ENABLED" });
  assert.equal(facade.catalog("agent-b").items.filter(item => item.source === "plugin").length, 1);
  store.setInstallationDesiredState({ installationId: first.installationId,
    desiredState: "enabled", expectedRevision: disabled.revision });
  assert.throws(() => facade.read({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash }), { code: "SKILL_REVISION_CHANGED" });
  assert.notEqual(facade.catalog("agent-a").registryRevision, catalog.registryRevision);
  console.log("plugin Skill facade: PASS");
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
