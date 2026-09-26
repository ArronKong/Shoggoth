"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore, PLUGIN_STORE_SCHEMA_VERSION } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");

const fixture = path.join(__dirname, "fixtures/plugins/project-assistant");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-install-"));
const paths = resolveServicePaths({
  stateRoot: path.join(temp, "state"), userDataRoot: temp,
  profileRoot: path.join(temp, "profile"), cacheRoot: path.join(temp, "cache"),
  trustedRoot: temp,
});
const store = new PluginStore({ paths }).open();
const installer = new PluginPackageInstaller({ store });
const op = (suffix) => `test-${suffix}`;
function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

try {
  const preview = installer.preview(fixture);
  assert.equal(preview.expectedRevision, 0);
  assert.equal(preview.installable, true);
  const installed = installer.install({ sourcePath: fixture, previewDigest: preview.contentDigest,
    operationId: op("first"), expectedRevision: 0 });
  assert.equal(installed.desiredState, "disabled");
  assert.equal(installed.revision, 1);
  assert.equal(store.getRelease(preview.sourceIdentity, preview.contentDigest).components.skills.length, 1);
  assert.equal(store.listInstallations().length, 1);
  const catalog = new PluginComponentCatalog({ store }).list();
  assert.equal(catalog[0].components.length, 3);
  assert.equal(catalog[0].components.every((component) => component.state === "installed_inactive"), true);
  assert.deepEqual(installer.install({ sourcePath: fixture, previewDigest: preview.contentDigest,
    operationId: op("first"), expectedRevision: 0 }), installed);
  assert.deepEqual(installer.install({ sourcePath: fixture, previewDigest: preview.contentDigest,
    operationId: op("same-content"), expectedRevision: 1 }), installed);
  assert.throws(() => installer.install({ sourcePath: fixture,
    previewDigest: "a".repeat(64), operationId: op("first"), expectedRevision: 0 }),
  (failure) => failure.code === "REVISION_CONFLICT");

  const modeChangedSource = path.join(temp, "mode-changed-source");
  fs.cpSync(fixture, modeChangedSource, { recursive: true });
  const modePreview = installer.preview(modeChangedSource);
  fs.chmodSync(path.join(modeChangedSource, "bin/issue-fixture"), 0o700);
  assert.throws(() => installer.install({ sourcePath: modeChangedSource,
    previewDigest: modePreview.contentDigest, operationId: op("mode-changed"),
    expectedRevision: 0 }), (failure) => failure.code === "PACKAGE_CHANGED");

  const source = path.join(temp, "source");
  fs.cpSync(fixture, source, { recursive: true });
  const sourceExecutable = path.join(source, "bin/issue-fixture");
  fs.chmodSync(sourceExecutable, 0o700);
  const firstPreview = installer.preview(source);
  assert.notEqual(firstPreview.contentDigest, preview.contentDigest,
    "executable mode is part of immutable package identity");
  const changeFile = path.join(source, "skills/issue-summary/SKILL.md");
  fs.appendFileSync(changeFile, "\nChanged after preview.\n");
  assert.throws(() => installer.install({ sourcePath: source,
    previewDigest: firstPreview.contentDigest, operationId: op("changed"), expectedRevision: 0 }),
  (failure) => failure.code === "PACKAGE_CHANGED");
  assert.equal(store.getOperation(op("changed")).phase, "failed");

  const newPreview = installer.preview(source);
  let crash = true;
  const crashingInstaller = new PluginPackageInstaller({ store, onPhase(phase) {
    if (phase === "published" && crash) {
      crash = false;
      throw Object.assign(new Error("simulated crash"), { code: "PLUGIN_SIMULATED_CRASH" });
    }
  } });
  assert.throws(() => crashingInstaller.install({ sourcePath: source,
    previewDigest: newPreview.contentDigest, operationId: op("resume"), expectedRevision: 0 }),
  (failure) => failure.code === "PLUGIN_SIMULATED_CRASH");
  assert.equal(store.getOperation(op("resume")).phase, "created");
  const resumed = installer.install({ sourcePath: source,
    previewDigest: newPreview.contentDigest, operationId: op("resume"), expectedRevision: 0 });
  assert.equal(resumed.revision, 1);
  const installedExecutable = path.join(paths.pluginPackagesDir, resumed.releaseDigest,
    "bin/issue-fixture");
  assert.equal(fs.statSync(installedExecutable).mode & 0o777, 0o700);
  fs.chmodSync(sourceExecutable, 0o600);
  assert.notEqual(installer.preview(source).contentDigest, newPreview.contentDigest,
    "a mode-only change must change the package digest");
  fs.chmodSync(sourceExecutable, 0o700);
  assert.notEqual(resumed.installationId, installed.installationId);
  assert.notEqual(resumed.releaseDigest, installed.releaseDigest);
  const beforeUpdate = new PluginComponentCatalog({ store }).list()
    .find((item) => item.installationId === resumed.installationId);
  fs.appendFileSync(changeFile, "\nSecond revision with the same declared version.\n");
  const updatePreview = installer.preview(source);
  assert.equal(updatePreview.expectedRevision, 1);
  const updated = installer.install({ sourcePath: source,
    previewDigest: updatePreview.contentDigest, operationId: op("update"), expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.equal(updated.desiredState, "disabled");
  assert.equal(store.getRelease(updatePreview.sourceIdentity, newPreview.contentDigest).contentDigest,
    newPreview.contentDigest);
  const afterUpdate = new PluginComponentCatalog({ store }).list()
    .find((item) => item.installationId === resumed.installationId);
  assert.equal(afterUpdate.components[0].componentId, beforeUpdate.components[0].componentId);
  assert.notEqual(afterUpdate.components[0].descriptorDigest, beforeUpdate.components[0].descriptorDigest);

  const stagedSource = path.join(temp, "staged-source");
  fs.cpSync(fixture, stagedSource, { recursive: true });
  const stagedPreview = installer.preview(stagedSource);
  let stageCrash = true;
  const stageCrashingInstaller = new PluginPackageInstaller({ store, onPhase(phase) {
    if (phase === "staged" && stageCrash) {
      stageCrash = false;
      throw Object.assign(new Error("simulated crash"), { code: "PLUGIN_SIMULATED_CRASH" });
    }
  } });
  assert.throws(() => stageCrashingInstaller.install({ sourcePath: stagedSource,
    previewDigest: stagedPreview.contentDigest, operationId: op("staged"), expectedRevision: 0 }),
  (failure) => failure.code === "PLUGIN_SIMULATED_CRASH");
  assert.equal(store.getOperation(op("staged")).phase, "created");
  const resumedStage = installer.install({ sourcePath: stagedSource,
    previewDigest: stagedPreview.contentDigest, operationId: op("staged"), expectedRevision: 0 });
  assert.equal(resumedStage.revision, 1);
  assert.equal(new PluginComponentCatalog({ store }).list().length, 3);

  const gitRepo = path.join(temp, "git-repo");
  fs.mkdirSync(gitRepo);
  git(gitRepo, "init", "-q");
  fs.cpSync(fixture, path.join(gitRepo, "package"), { recursive: true });
  fs.chmodSync(path.join(gitRepo, "package/bin/issue-fixture"), 0o755);
  git(gitRepo, "add", "package");
  git(gitRepo, "-c", "user.name=Plugin Test", "-c", "user.email=plugin-test@example.invalid",
    "commit", "-q", "-m", "fixed fixture");
  const commit = git(gitRepo, "rev-parse", "HEAD");
  const gitInput = { repositoryPath: gitRepo, commit, subdir: "package" };
  const gitPreview = installer.previewGit(gitInput);
  assert.notEqual(gitPreview.contentDigest, preview.contentDigest);
  const gitInstallation = installer.installGit({ ...gitInput,
    previewDigest: gitPreview.contentDigest, operationId: op("git"), expectedRevision: 0 });
  assert.equal(gitInstallation.desiredState, "disabled");
  assert.equal(store.getRelease(gitPreview.sourceIdentity, gitPreview.contentDigest).sourceIdentity,
    gitPreview.sourceIdentity);
  assert.notEqual(gitInstallation.installationId, installed.installationId);
  assert.equal(fs.statSync(path.join(paths.pluginPackagesDir, gitInstallation.releaseDigest,
    "bin/issue-fixture")).mode & 0o777, 0o700);
  assert.throws(() => installer.previewGit({ ...gitInput, commit: "HEAD" }),
    (failure) => failure.code === "GIT_SOURCE_INVALID");
  fs.symlinkSync("../../outside", path.join(gitRepo, "package", "unsafe-link"));
  git(gitRepo, "add", "package/unsafe-link");
  git(gitRepo, "-c", "user.name=Plugin Test", "-c", "user.email=plugin-test@example.invalid",
    "commit", "-q", "-m", "unsafe symlink");
  assert.throws(() => installer.previewGit({ ...gitInput, commit: git(gitRepo, "rev-parse", "HEAD") }),
    (failure) => failure.code === "GIT_SOURCE_INVALID");

  store.close();
  const reopened = new PluginStore({ paths }).open();
  assert.equal(reopened.listInstallations().length, 4);
  assert.equal(reopened.getOperation(op("resume")).phase, "completed");
  reopened.close();

  const badPaths = resolveServicePaths({ stateRoot: path.join(temp, "bad-state"),
    userDataRoot: temp, profileRoot: path.join(temp, "profile"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  new PluginStore({ paths: badPaths }).open().close();
  const raw = new Database(badPaths.pluginCatalogPath);
  raw.pragma(`user_version = ${PLUGIN_STORE_SCHEMA_VERSION + 1}`);
  raw.close();
  const before = fs.readFileSync(badPaths.pluginCatalogPath);
  assert.throws(() => new PluginStore({ paths: badPaths }).open(),
    (failure) => failure.code === "PLUGIN_STORE_UNSUPPORTED");
  assert.deepEqual(fs.readFileSync(badPaths.pluginCatalogPath), before);

  const oldPaths = resolveServicePaths({ stateRoot: path.join(temp, "old-state"),
    userDataRoot: temp, profileRoot: path.join(temp, "profile"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  new PluginStore({ paths: oldPaths }).open().close();
  const oldDb = new Database(oldPaths.pluginCatalogPath);
  oldDb.pragma(`user_version = ${PLUGIN_STORE_SCHEMA_VERSION - 1}`);
  oldDb.close();
  const oldBytes = fs.readFileSync(oldPaths.pluginCatalogPath);
  assert.throws(() => new PluginStore({ paths: oldPaths }).open(),
    (failure) => failure.code === "PLUGIN_STORE_UNSUPPORTED");
  assert.deepEqual(fs.readFileSync(oldPaths.pluginCatalogPath), oldBytes);
  console.log("plugin package installer: PASS");
} finally {
  store.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
