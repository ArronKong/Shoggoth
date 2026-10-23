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
const { evaluatePluginSkill } = require("../app/agent-service/plugin-skill-eligibility");

const changedFrozen = { sourceIdentity: "bundled:figma", name: "figma-design-to-code",
  descriptorDigest: "0".repeat(64) };
assert.deepEqual({ eligible: evaluatePluginSkill(changedFrozen).eligible,
  reason: evaluatePluginSkill(changedFrozen).reason,
  assessment: evaluatePluginSkill(changedFrozen).assessment },
{ eligible: false, reason: "review_required", assessment: "frozen_changed" });
assert.equal(evaluatePluginSkill({ ...changedFrozen,
  sourceIdentity: "local:/fixture" }).eligible, true);

const machine = { name: "echo-workflow", installationId: "install-a",
  sourceIdentity: "local:a", descriptorDigest: "f".repeat(64),
  requiredTools: ["echo"] };
const tool = { name: "echo", installationId: "install-a", sourceIdentity: "local:a" };
assert.equal(evaluatePluginSkill(machine, { pluginTools: [tool] }).eligible, true);
assert.equal(evaluatePluginSkill(machine, { pluginTools: [
  { ...tool, installationId: "install-b" } ] }).reason, "tool_missing",
"a same-name tool from another installation cannot satisfy a Skill dependency");
assert.equal(evaluatePluginSkill({ ...machine, declaredAllowedTools: true },
  { pluginTools: [tool] }).reason, "tool_contract_unverified",
"a machine requirement cannot validate a separate unreviewed allowed-tools list");
assert.equal(evaluatePluginSkill({ ...changedFrozen, installationId: "install-a",
  descriptorDigest: "66b1ad8a1f72e5295c178548ced3c9dd4038432bb08e5f7a4617e399d59be9cd" },
{ pluginTools: [{ ...tool, name: "get_design_context" }] }).reason, "tool_missing",
"a frozen Codex connector requires exact provider-contract review");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-skill-facade-"));
const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
const store = new PluginStore({ paths }).open();
const nativeItem = { id: "native-review", name: "native-review", version: "1.0.0",
  description: "Native review", source: "user", contentHash: "a".repeat(64),
  requiredTools: [], requiredRuntimeCapabilities: [] };
const nativeStore = {
  catalog() { return { registryRevision: "native-revision", registryVersion: 7, profileRevision: 1,
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
  readEnabledFile(input) {
    if (input.name !== nativeItem.name) {
      const failure = new Error("Skill not enabled");
      failure.code = "SKILL_NOT_ENABLED";
      throw failure;
    }
    return { ...nativeItem, relativePath: input.relativePath,
      fileHash: "b".repeat(64), content: "Native reference" };
  },
};

try {
  const installer = new PluginPackageInstaller({ store });
  const installations = [];
  for (const suffix of ["a", "b"]) {
    const source = path.join(root, `source-${suffix}`);
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source,
      { recursive: true });
    fs.mkdirSync(path.join(source, "skills", "issue-summary", "references"));
    fs.writeFileSync(path.join(source, "skills", "issue-summary", "references", "guide.md"),
      "Shared reference fixture\n");
    fs.mkdirSync(path.join(source, "shared"));
    fs.writeFileSync(path.join(source, "shared", "workflow.md"),
      "Shared package workflow\n");
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
  assert.equal(catalog.registryVersion, 7, "merged plugin catalogs retain the native installation CAS version");
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
  const pluginFile = facade.readFile({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash, relativePath: "references/guide.md" });
  assert.equal(pluginFile.content, "Shared reference fixture\n");
  assert.equal(pluginFile.fileHash.length, 64);
  assert.equal(facade.readResource({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash, relativePath: "shared/workflow.md" }).content,
  "Shared package workflow\n");
  assert.throws(() => facade.readResource({ profileId: "agent-a", name: nativeItem.name,
    contentHash: nativeItem.contentHash, relativePath: "shared/workflow.md" }),
  { code: "SKILL_INELIGIBLE" });
  assert.equal(facade.readFile({ profileId: "agent-a", name: nativeItem.name,
    contentHash: nativeItem.contentHash, relativePath: "references/native.md" }).content,
  "Native reference");
  assert.throws(() => facade.readFile({ profileId: "agent-a", name: plugins[0].name,
    contentHash: "c".repeat(64), relativePath: "references/guide.md" }),
  { code: "SKILL_REVISION_CHANGED" });
  const first = installations[0];
  const disabled = store.setInstallationDesiredState({ installationId: first.installationId,
    desiredState: "disabled", expectedRevision: first.revision });
  assert.throws(() => facade.read({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash }), { code: "SKILL_NOT_ENABLED" });
  assert.throws(() => facade.readFile({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash, relativePath: "references/guide.md" }),
  { code: "SKILL_NOT_ENABLED" });
  assert.throws(() => facade.readResource({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash, relativePath: "shared/workflow.md" }),
  { code: "SKILL_INELIGIBLE" });
  assert.equal(facade.catalog("agent-b").items.filter(item => item.source === "plugin").length, 1);
  store.setInstallationDesiredState({ installationId: first.installationId,
    desiredState: "enabled", expectedRevision: disabled.revision });
  assert.throws(() => facade.read({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash }), { code: "SKILL_REVISION_CHANGED" });
  assert.throws(() => facade.readFile({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash, relativePath: "references/guide.md" }),
  { code: "SKILL_REVISION_CHANGED" });
  assert.throws(() => facade.readResource({ profileId: "agent-a", name: plugins[0].name,
    contentHash: plugins[0].contentHash, relativePath: "shared/workflow.md" }),
  { code: "SKILL_REVISION_CHANGED" });
  assert.notEqual(facade.catalog("agent-a").registryRevision, catalog.registryRevision);

  const gatedSource = path.join(root, "source-gated");
  fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), gatedSource,
    { recursive: true });
  const gatedSkillPath = path.join(gatedSource, "skills", "issue-summary", "SKILL.md");
  fs.writeFileSync(gatedSkillPath, fs.readFileSync(gatedSkillPath, "utf8").replace(
    "description: Find project issues and summarize them; create a test issue only after approval.\n",
    "description: Find project issues and summarize them; create a test issue only after approval.\n"
      + "x-shoggoth:\n  requiredTools:\n    - echo\n"));
  fs.mkdirSync(path.join(gatedSource, "skills", "issue-summary", "references"));
  fs.writeFileSync(path.join(gatedSource, "skills", "issue-summary", "references", "guide.md"),
    "Gated support text\n");
  fs.mkdirSync(path.join(gatedSource, "shared"));
  fs.writeFileSync(path.join(gatedSource, "shared", "workflow.md"),
    "Gated package workflow\n");
  const gatedPreview = installer.preview(gatedSource);
  const gatedInstalled = installer.install({ sourcePath: gatedSource,
    previewDigest: gatedPreview.contentDigest, operationId: "skill-install-gated",
    expectedRevision: 0 });
  store.setInstallationDesiredState({ installationId: gatedInstalled.installationId,
    desiredState: "enabled", expectedRevision: gatedInstalled.revision });
  const gated = facade.catalog("agent-a").ineligible.find((item) =>
    item.source === "plugin" && item.requiredTools.includes("echo"));
  assert.equal(gated?.ineligibleReason, "tool_missing");
  assert.throws(() => facade.read({ profileId: "agent-a", name: gated.name,
    contentHash: gated.contentHash }), { code: "SKILL_INELIGIBLE" });
  assert.throws(() => facade.readFile({ profileId: "agent-a", name: gated.name,
    contentHash: gated.contentHash, relativePath: "references/guide.md" }),
  { code: "SKILL_INELIGIBLE" });
  assert.throws(() => facade.readResource({ profileId: "agent-a", name: gated.name,
    contentHash: gated.contentHash, relativePath: "shared/workflow.md" }),
  { code: "SKILL_INELIGIBLE" });
  const authorized = { pluginToolProjection: [{ name: "echo",
    installationId: gatedInstalled.installationId,
    sourceIdentity: store.getInstallation(gatedInstalled.installationId).sourceIdentity }] };
  assert.equal(facade.catalog("agent-a", authorized).items.find((item) =>
    item.name === gated.name)?.eligible, true);
  assert.match(facade.read({ profileId: "agent-a", name: gated.name,
    contentHash: gated.contentHash, ...authorized }).content, /issue-summary/u);
  assert.equal(facade.readFile({ profileId: "agent-a", name: gated.name,
    contentHash: gated.contentHash, relativePath: "references/guide.md",
    ...authorized }).content, "Gated support text\n");
  assert.equal(facade.readResource({ profileId: "agent-a", name: gated.name,
    contentHash: gated.contentHash, relativePath: "shared/workflow.md",
    ...authorized }).content, "Gated package workflow\n");
  assert.throws(() => facade.read({ profileId: "agent-a", name: gated.name,
    contentHash: gated.contentHash, pluginToolProjection: [] }),
  { code: "SKILL_INELIGIBLE" });
  console.log("plugin Skill facade: PASS");
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
