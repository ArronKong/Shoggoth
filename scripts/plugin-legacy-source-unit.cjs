#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { previewPluginDirectory, readPluginMcpServer } = require("../app/agent-service/plugin-package-parser");
const { identifyLegacySource, scanLegacySource } = require("../app/agent-service/plugin-legacy-source");

function write(root, relative, content, mode = 0o600) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode });
}
function createLegacy(root, format = "claude-plugin") {
  fs.mkdirSync(root, { mode: 0o700 });
  write(root, `.${format}/plugin.json`, JSON.stringify({ name: "legacy-fixture", version: "1.0.0",
    description: "Legacy import fixture", hooks: "./hooks/hooks.json" }));
  write(root, "skills/review/SKILL.md", "---\nname: review\ndescription: Fixture review\n---\nRead references/guide.md.\n");
  write(root, "skills/review/references/guide.md", "Fixture guide\n");
  write(root, "bin/server", "#!/bin/sh\ntouch NEVER_EXECUTE\nexit 99\n", 0o700);
  write(root, "hooks/hooks.json", JSON.stringify({ command: "touch NEVER_EXECUTE" }));
  write(root, ".mcp.json", JSON.stringify({ mcpServers: {
    local: { command: "./bin/server" },
    remote: { type: "http", url: "https://example.invalid/mcp" },
    denied: { type: "http", url: "https://example.invalid/private", headers: { Authorization: "fixture-secret" } },
  } }));
}
function withFixture(run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-legacy-source-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), userDataRoot: temp,
    profileRoot: path.join(temp, "profiles"), cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  let store = new PluginStore({ paths }).open();
  const sourcePath = path.join(temp, "source");
  createLegacy(sourcePath);
  const source = { sourcePath, format: "claude-plugin", components: ["skills", "mcp-servers"] };
  const state = { paths, temp, source, get store() { return store; },
    get installer() { return new PluginPackageInstaller({ store }); },
    reopen() { store.close(); store = new PluginStore({ paths }).open(); } };
  try { run(state); }
  finally { store.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
function request(source, preview, operationId) {
  return { ...source, previewDigest: preview.contentDigest, expectedRevision: preview.expectedRevision, operationId };
}

test("legacy directory preview/install is disabled, immutable, standard-readable and source-preserving", () => {
  withFixture(({ installer, store, paths, source }) => {
    const original = scanLegacySource(identifyLegacySource(source));
    const preview = installer.previewLegacy(source);
    assert.equal(preview.expectedRevision, 0);
    assert.equal(preview.installable, true);
    assert.equal(preview.root, undefined, "private temporary root is not returned");
    assert.ok(preview.sourceIdentity.startsWith("legacy:"));
    assert.notEqual(preview.sourceIdentity, `local:${fs.realpathSync(source.sourcePath)}`);
    assert.equal(preview.skills.length, 1);
    assert.equal(preview.mcpServers.length, 2);
    assert.ok(preview.diagnostics.some((entry) => entry.reasonCode === "LEGACY_CREDENTIAL_UNSUPPORTED"));
    assert.deepEqual(fs.readdirSync(paths.pluginStagingDir), []);
    const installed = installer.installLegacy(request(source, preview, "legacy-first"));
    assert.equal(installed.revision, 1);
    assert.equal(installed.desiredState, "disabled");
    const root = fs.realpathSync(path.join(paths.pluginPackagesDir, installed.releaseDigest));
    const storedPreview = previewPluginDirectory(root);
    assert.equal(storedPreview.contentDigest, preview.contentDigest);
    assert.equal(readPluginMcpServer(root, "remote").spec.type, "streamable-http");
    assert.equal(fs.statSync(path.join(root, "bin/server")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, "plugin.json")).mode & 0o777, 0o600);
    const provenance = JSON.parse(fs.readFileSync(path.join(root, "legacy-provenance.json"), "utf8"));
    assert.deepEqual(provenance.components, ["mcp-servers", "skills"]);
    assert.equal(provenance.inputDigest, original.conversion.provenance.inputDigest);
    assert.doesNotMatch(JSON.stringify(provenance), /fixture-secret|sourcePath/);
    assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);
    assert.equal(fs.existsSync(path.join(root, "NEVER_EXECUTE")), false);
    assert.equal(fs.existsSync(path.join(source.sourcePath, "NEVER_EXECUTE")), false);
    const after = scanLegacySource(identifyLegacySource(source));
    assert.equal(after.conversion.provenance.inputDigest, original.conversion.provenance.inputDigest);
    assert.ok(store.getRelease(preview.sourceIdentity, preview.contentDigest).diagnostics
      .some((entry) => entry.reasonCode === "LEGACY_CREDENTIAL_UNSUPPORTED"));
    assert.deepEqual(fs.readdirSync(paths.pluginStagingDir), []);
  });
});

test("legacy identity includes format and selected families, while normalized selection is stable", () => {
  withFixture(({ installer, source, paths }) => {
    const all = installer.previewLegacy(source);
    const reorder = installer.previewLegacy({ ...source, components: [...source.components].reverse() });
    assert.equal(all.sourceIdentity, reorder.sourceIdentity);
    assert.equal(all.contentDigest, reorder.contentDigest);
    const skillSource = { ...source, components: ["skills"] };
    const skills = installer.previewLegacy(skillSource);
    assert.notEqual(skills.sourceIdentity, all.sourceIdentity);
    assert.notEqual(skills.contentDigest, all.contentDigest);
    const installed = installer.installLegacy(request(skillSource, skills, "skills-only"));
    const root = path.join(paths.pluginPackagesDir, installed.releaseDigest);
    assert.equal(fs.existsSync(path.join(root, "mcp.json")), false);
    write(source.sourcePath, ".codex-plugin/plugin.json", JSON.stringify({ name: "legacy-fixture", version: "1.0.0" }));
    assert.notEqual(installer.previewLegacy({ ...source, format: "codex-plugin" }).sourceIdentity, all.sourceIdentity);
  });
});

test("source or executable changes after preview reject the operation, including omitted source controls", () => {
  withFixture(({ installer, source, store }) => {
    const preview = installer.previewLegacy(source);
    const manifestPath = path.join(source.sourcePath, ".claude-plugin/plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.hooks = { command: "a different ignored hook" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => installer.installLegacy(request(source, preview, "changed-ignored")), { code: "PACKAGE_CHANGED" });
    assert.equal(store.getOperation("changed-ignored").phase, "failed");
    const current = installer.previewLegacy(source);
    fs.chmodSync(path.join(source.sourcePath, "bin/server"), 0o600);
    assert.throws(() => installer.installLegacy(request(source, current, "changed-mode")), { code: "PACKAGE_CHANGED" });
    assert.equal(store.listInstallations().length, 0);
  });
});

test("install replays receipts but conflicts on operation reuse and stale source revisions", () => {
  withFixture(({ installer, source, store }) => {
    const preview = installer.previewLegacy(source);
    const input = request(source, preview, "idempotent");
    const installed = installer.installLegacy(input);
    fs.appendFileSync(path.join(source.sourcePath, "skills/review/SKILL.md"), "Later source change\n");
    assert.deepEqual(installer.installLegacy(input), installed, "completed receipt must not replay installation");
    assert.throws(() => installer.installLegacy({ ...input, components: ["skills"] }), { code: "REVISION_CONFLICT" });
    assert.equal(store.getOperation("idempotent").phase, "completed");
    const changed = installer.previewLegacy(source);
    assert.throws(() => installer.installLegacy({ ...request(source, changed, "stale-revision"), expectedRevision: 0 }),
      { code: "REVISION_CONFLICT" });
    const updated = installer.installLegacy(request(source, changed, "update-disabled"));
    assert.equal(updated.revision, 2);
    assert.equal(updated.installationId, installed.installationId);
    assert.notEqual(updated.releaseDigest, installed.releaseDigest);
    assert.equal(updated.desiredState, "disabled");
  });
});

test("legacy update requires completed disable and preserves prior immutable versions", () => {
  withFixture(({ installer, source, store, paths }) => {
    const preview = installer.previewLegacy(source);
    const installed = installer.installLegacy(request(source, preview, "enabled-base"));
    const enabled = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    fs.appendFileSync(path.join(source.sourcePath, "skills/review/SKILL.md"), "Update\n");
    const candidate = installer.previewLegacy(source);
    assert.throws(() => installer.installLegacy(request(source, candidate, "update-enabled")),
      { code: "PLUGIN_UPDATE_REQUIRES_DISABLE" });
    store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "disabled", expectedRevision: enabled.revision });
    const next = installer.previewLegacy(source);
    const updated = installer.installLegacy(request(source, next, "update-after-disable"));
    assert.equal(updated.revision, 4);
    assert.equal(updated.desiredState, "disabled");
    assert.equal(previewPluginDirectory(path.join(paths.pluginPackagesDir, installed.releaseDigest)).contentDigest,
      installed.releaseDigest);
  });
});

test("late source edits are rejected after staging and before publication", () => {
  withFixture(({ source, store, paths }) => {
    const installer = new PluginPackageInstaller({ store, onPhase(phase) {
      if (phase === "staged") fs.appendFileSync(path.join(source.sourcePath, "skills/review/SKILL.md"), "race\n");
    } });
    const preview = installer.previewLegacy(source);
    assert.throws(() => installer.installLegacy(request(source, preview, "late-edit")), { code: "PACKAGE_CHANGED" });
    assert.equal(store.getOperation("late-edit").phase, "failed");
    assert.deepEqual(fs.readdirSync(paths.pluginStagingDir), []);
    assert.deepEqual(fs.readdirSync(paths.pluginPackagesDir), []);
  });
});

test("published legacy package can resume the same operation after Store restart", () => {
  withFixture((state) => {
    const installer = new PluginPackageInstaller({ store: state.store, onPhase(phase) {
      if (phase === "published") throw Object.assign(new Error("fixture crash"), { code: "PLUGIN_SIMULATED_CRASH" });
    } });
    const preview = installer.previewLegacy(state.source);
    const input = request(state.source, preview, "legacy-restart");
    assert.throws(() => installer.installLegacy(input), { code: "PLUGIN_SIMULATED_CRASH" });
    assert.equal(state.store.getOperation("legacy-restart").phase, "created");
    state.reopen();
    const installed = state.installer.installLegacy(input);
    assert.equal(installed.releaseDigest, preview.contentDigest);
    assert.equal(state.store.getOperation("legacy-restart").phase, "completed");
    assert.deepEqual(fs.readdirSync(state.paths.pluginStagingDir), []);
  });
});

test("legacy source cannot overlap managed plugin storage before staging or journaling", () => {
  withFixture(({ installer, source, store, paths, temp }) => {
    const child = path.join(paths.pluginPackagesDir, "legacy-source");
    createLegacy(child);
    const sources = [temp, paths.pluginsDir, paths.pluginStagingDir, child];
    const stagingBefore = fs.readdirSync(paths.pluginStagingDir);
    for (const [index, sourcePath] of sources.entries()) {
      const overlap = { ...source, sourcePath };
      assert.throws(() => installer.previewLegacy(overlap), { code: "LEGACY_SOURCE_OVERLAP" });
      const operationId = `overlap-${index}`;
      assert.throws(() => installer.installLegacy({ ...overlap, previewDigest: "a".repeat(64),
        expectedRevision: 0, operationId }), { code: "LEGACY_SOURCE_OVERLAP" });
      assert.equal(store.getOperation(operationId), null);
    }
    assert.deepEqual(fs.readdirSync(paths.pluginStagingDir), stagingBefore);
    assert.equal(store.listInstallations().length, 0);
  });
});

test("legacy scan rejects symlinks, hardlinks, nonregular files, foreign ownership and oversized sources", () => {
  withFixture(({ installer, source, temp }) => {
    const unsafe = path.join(source.sourcePath, "unsafe");
    fs.symlinkSync(path.join(source.sourcePath, "bin/server"), unsafe);
    assert.throws(() => installer.previewLegacy(source), { code: "LEGACY_SOURCE_INVALID" });
    fs.unlinkSync(unsafe);
    fs.linkSync(path.join(source.sourcePath, "bin/server"), unsafe);
    assert.throws(() => installer.previewLegacy(source), { code: "LEGACY_SOURCE_INVALID" });
    fs.unlinkSync(unsafe);
    if (process.platform !== "win32") {
      const fifo = spawnSync("mkfifo", [unsafe]);
      assert.equal(fifo.status, 0);
      assert.throws(() => installer.previewLegacy(source), { code: "LEGACY_SOURCE_INVALID" });
      fs.unlinkSync(unsafe);
    }
    if (typeof process.getuid === "function") {
      const getuid = process.getuid;
      try {
        process.getuid = () => getuid() + 1;
        assert.throws(() => installer.previewLegacy(source), { code: "LEGACY_SOURCE_INVALID" });
      } finally { process.getuid = getuid; }
    }
    const linkedRoot = path.join(temp, "linked-root");
    fs.symlinkSync(source.sourcePath, linkedRoot);
    assert.throws(() => installer.previewLegacy({ ...source, sourcePath: linkedRoot }), { code: "LEGACY_SOURCE_INVALID" });
    write(source.sourcePath, "oversized", Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.throws(() => installer.previewLegacy(source), { code: "LEGACY_SOURCE_INVALID" });
  });
});
