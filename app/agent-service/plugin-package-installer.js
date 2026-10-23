"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { identifyGitSource, materializeGitSource } = require("./plugin-git-source");
const { PluginRemoteGitFetcher, identifyRemoteGitSource } = require("./plugin-remote-git-fetcher");
const { identifyLegacySource, scanLegacySource, materializeLegacySource,
  assertLegacySourceCurrent } = require("./plugin-legacy-source");
const { previewPluginDirectory } = require("./plugin-package-parser");
const { isGraphSidecar, materializeGraphSidecar } =
  require("./plugin-microsoft-graph-sidecar");
const { PACKAGE_ID: LOVABLE_PACKAGE_ID, materializeLovableOfficialSidecar } =
  require("./plugin-lovable-official-sidecar");
const { PACKAGE_ID: HIGGSFIELD_PACKAGE_ID, applyHiggsfieldOfficialOverlay } =
  require("./plugin-higgsfield-official-overlay");
const { PACKAGE_ID: SLACK_PACKAGE_ID } = require("./plugin-slack-official-sidecar");
const { materializeSlackMcpPlugin } = require("./plugin-slack-official-plugin");
const { PACKAGE_ID: GOG_GMAIL_PACKAGE_ID, SOURCE_IDENTITY: GOG_GMAIL_SOURCE_IDENTITY,
  materializeGogGmailSidecar } = require("./plugin-gogcli-gmail-sidecar");
const { PACKAGE_ID: SECURITY_PACKAGE_ID, SOURCE_IDENTITY: SECURITY_SOURCE_IDENTITY,
  materializeCodexSecurityNativeComponent } = require("./plugin-codex-security-native-component");
const { serviceError, assertPrivateDirectory } = require("./security");

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FIRST_PARTY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const FIRST_PARTY_COMPONENTS = Object.freeze(["skills", "mcp-servers"]);

function fail(code, message) { throw serviceError(code, message); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function isBundledSidecar(packageId) {
  return isGraphSidecar(packageId) || packageId === LOVABLE_PACKAGE_ID
    || packageId === SLACK_PACKAGE_ID || packageId === SECURITY_PACKAGE_ID
    || packageId === GOG_GMAIL_PACKAGE_ID;
}
function materializeBundledSidecar(destination, packageId, digest, bundledCatalog) {
  if (packageId === SECURITY_PACKAGE_ID) return materializeCodexSecurityNativeComponent(destination, { bundledCatalog });
  if (packageId === GOG_GMAIL_PACKAGE_ID) return materializeGogGmailSidecar(destination, digest);
  return packageId === LOVABLE_PACKAGE_ID
    ? materializeLovableOfficialSidecar(destination, digest)
    : packageId === SLACK_PACKAGE_ID
      ? materializeSlackMcpPlugin(destination, digest)
      : materializeGraphSidecar(destination, packageId, digest);
}
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}
function fsyncDirectory(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function safeRemoveTree(target) {
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
    fail("PACKAGE_PATH_INVALID", "暂存目录包含不安全路径，拒绝清理");
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) safeRemoveTree(path.join(target, name));
    fs.rmdirSync(target);
  } else fs.unlinkSync(target);
}
function readPinnedFile(source, root, expected) {
  const before = fs.lstatSync(source);
  if (!before.isFile() || before.nlink !== 1 || before.size !== expected.size
    || ((before.mode & 0o111) !== 0) !== expected.executable
    || !within(root, fs.realpathSync(source))) {
    fail("PACKAGE_CHANGED", "插件源文件或路径发生变化");
  }
  const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.mode !== before.mode) {
      fail("PACKAGE_CHANGED", "插件源文件读取期间被替换");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(source);
    if (bytes.length !== expected.size || hash(bytes) !== expected.sha256
      || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.mode !== before.mode
      || !within(root, fs.realpathSync(source))) {
      fail("PACKAGE_CHANGED", "插件源文件读取期间变化");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}
function writeStagedFile(target, bytes, executable) {
  const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, executable ? 0o700 : 0o600);
    fs.fsyncSync(fd);
  }
  finally { fs.closeSync(fd); }
}
function stagePackage(preview, stagingPath, trustedBundled = false, allowGraphSidecar = false,
  nativeSourceIdentity = null) {
  fs.mkdirSync(stagingPath, { mode: 0o700 });
  const directories = new Set([stagingPath]);
  for (const file of preview.files) {
    const source = path.join(preview.root, ...file.path.split("/"));
    const destination = path.join(stagingPath, ...file.path.split("/"));
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    let cursor = parent;
    while (within(stagingPath, cursor)) {
      directories.add(cursor);
      if (cursor === stagingPath) break;
      cursor = path.dirname(cursor);
    }
    writeStagedFile(destination, readPinnedFile(source, preview.root, file), file.executable);
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    fs.chmodSync(directory, 0o700);
    fsyncDirectory(directory);
  }
  const staged = previewPluginDirectory(stagingPath, { trustedBundled, allowGraphSidecar, nativeSourceIdentity });
  if (!staged.installable || staged.contentDigest !== preview.contentDigest) {
    fail("PACKAGE_CHANGED", "插件暂存摘要不匹配");
  }
}

class PluginPackageInstaller {
  constructor({ store, onPhase = null, remoteGitFetcher = null, bundledCatalog = null, firstPartyRoot = null } = {}) {
    if (!store?.paths?.pluginPackagesDir || typeof store.beginInstall !== "function"
      || typeof store.hasPendingInstallationDisable !== "function") {
      throw new TypeError("PluginPackageInstaller requires PluginStore");
    }
    this.store = store;
    this.onPhase = onPhase;
    this.remoteGitFetcher = remoteGitFetcher || new PluginRemoteGitFetcher({ paths: store.paths });
    this.bundledCatalog = bundledCatalog;
    this.firstPartyRoot = firstPartyRoot;
  }
  // First-party packages ship inside the signed App. Their identity is the
  // directory name, not its path, so moving or updating the App keeps one
  // installation; contents get the same checks as any user package.
  _firstPartySource(packageId) {
    if (!this.firstPartyRoot || typeof packageId !== "string" || !FIRST_PARTY_ID.test(packageId)) {
      fail("FIRST_PARTY_PLUGIN_NOT_FOUND", "Shoggoth 内置插件不存在");
    }
    const sourcePath = path.join(this.firstPartyRoot, packageId);
    const codex = fs.existsSync(path.join(sourcePath, ".codex-plugin", "plugin.json"));
    if (!codex && !fs.existsSync(path.join(sourcePath, "plugin.json"))) {
      fail("FIRST_PARTY_PLUGIN_NOT_FOUND", "Shoggoth 内置插件不存在");
    }
    return { sourcePath, codex, sourceIdentity: `first-party:${packageId}` };
  }
  previewFirstParty(packageId) {
    const { sourcePath, codex, sourceIdentity } = this._firstPartySource(packageId);
    const expectedRevision = this.store.getBySource(sourceIdentity)?.revision || 0;
    if (!codex) {
      const { root: _root, ...preview } = previewPluginDirectory(sourcePath);
      return { ...preview, sourceIdentity, expectedRevision };
    }
    const { provenance: _provenance, ...preview } = this.previewLegacy({ sourcePath,
      format: "codex-plugin", components: FIRST_PARTY_COMPONENTS });
    return { ...preview, sourceIdentity, expectedRevision };
  }
  installFirstParty({ packageId, previewDigest, operationId, expectedRevision, activateOnInstall = false } = {}) {
    if (!HASH_PATTERN.test(previewDigest) || !OPERATION_PATTERN.test(operationId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof activateOnInstall !== "boolean") {
      fail("PLUGIN_OPERATION_INVALID", "内置插件安装请求无效");
    }
    const { sourcePath, codex, sourceIdentity } = this._firstPartySource(packageId);
    if (!codex) {
      return this._install({ root: sourcePath, sourceIdentity, previewDigest, operationId,
        expectedRevision, activateOnInstall });
    }
    const source = this._identifyLegacySource({ sourcePath, format: "codex-plugin", components: FIRST_PARTY_COMPONENTS });
    const fingerprint = hash(JSON.stringify({ sourceIdentity, previewDigest, expectedRevision }));
    const existing = this.store.beginInstall({ operationId, fingerprint });
    if (existing.phase === "completed") return existing.result;
    if (existing.phase === "failed") fail("PLUGIN_OPERATION_FAILED", "此前安装已失败，请新建操作");
    const temporary = path.join(this.store.paths.pluginStagingDir, `first-party-${crypto.randomUUID()}`);
    try {
      const snapshot = scanLegacySource(source);
      if (!snapshot.conversion.installable) fail("LEGACY_CONTENT_UNSUPPORTED", "所选历史组件无法转换");
      const materialized = materializeLegacySource(snapshot, temporary);
      assertLegacySourceCurrent(snapshot);
      return this._install({ root: materialized.root, sourceIdentity, previewDigest, operationId,
        expectedRevision, diagnostics: snapshot.conversion.diagnostics,
        validateSource: () => assertLegacySourceCurrent(snapshot), activateOnInstall });
    } catch (failure) {
      if (failure?.code !== "PLUGIN_SIMULATED_CRASH") this.store.markFailed(operationId, failure?.code || "PACKAGE_INVALID");
      throw failure;
    } finally { safeRemoveTree(temporary); }
  }
  previewUninstall(input) {
    return this.store.previewInstallationUninstall(input);
  }
  _uninstallInput({ installationId, expectedRevision, operationId } = {}) {
    if (!OPERATION_PATTERN.test(installationId) || !OPERATION_PATTERN.test(operationId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      fail("PLUGIN_OPERATION_INVALID", "卸载请求无效");
    }
    return { installationId, expectedRevision, operationId,
      fingerprint: hash(JSON.stringify(["uninstall", installationId, expectedRevision])) };
  }
  beginUninstall(input) {
    return this.store.beginInstallationUninstall(this._uninstallInput(input));
  }
  uninstall(input) {
    const request = this._uninstallInput(input);
    const previous = this.store.beginInstallationUninstall(request);
    if (previous.phase === "completed") return previous.result;
    const committed = this.store.commitInstallationUninstall(request);
    this.onPhase?.("uninstall-committed", { operationId: request.operationId });
    const digest = committed.result.releaseDigest;
    let packageRemoved = false;
    if (!this.store.isPackageReferenced(digest)) {
      // Only the exact immutable digest under the private package root is
      // eligible. Persistent data, source directories and encrypted credentials
      // are deliberately outside this operation's deletion scope.
      const root = this.store.paths.pluginPackagesDir;
      let directory = root;
      while (within(this.store.paths.trustedRoot, directory)) {
        assertPrivateDirectory(directory);
        if (directory === this.store.paths.trustedRoot) break;
        directory = path.dirname(directory);
      }
      if (directory !== this.store.paths.trustedRoot || !HASH_PATTERN.test(digest)) {
        fail("PACKAGE_PATH_INVALID", "插件包目录越过受控根");
      }
      safeRemoveTree(path.join(root, digest));
      fsyncDirectory(root);
      packageRemoved = true;
    }
    this.onPhase?.("uninstall-removed", { operationId: request.operationId });
    return this.store.finishInstallationUninstall({ ...request, packageRemoved });
  }
  preview(sourcePath) {
    const result = previewPluginDirectory(sourcePath);
    return {
      ...result,
      sourceIdentity: `local:${path.resolve(sourcePath)}`,
      expectedRevision: this.store.getBySource(`local:${path.resolve(sourcePath)}`)?.revision || 0,
    };
  }
  _identifyLegacySource(input, trustedBundled = false) {
    const source = identifyLegacySource({ ...input, trustedBundled });
    for (const directory of [this.store.paths.pluginsDir, this.store.paths.pluginPackagesDir,
      this.store.paths.pluginStagingDir, this.store.paths.pluginDataDir]) {
      const managed = fs.realpathSync(directory);
      if (within(source.root, managed) || within(managed, source.root)) {
        fail("LEGACY_SOURCE_OVERLAP", "历史插件来源不能与插件受控目录重叠");
      }
    }
    return source;
  }
  previewLegacy(input) {
    const source = this._identifyLegacySource(input);
    const snapshot = scanLegacySource(source);
    const temporary = path.join(this.store.paths.pluginStagingDir, `legacy-preview-${crypto.randomUUID()}`);
    try {
      const materialized = materializeLegacySource(snapshot, temporary);
      const { root: _root, ...preview } = previewPluginDirectory(materialized.root);
      return { ...preview, sourceIdentity: source.sourceIdentity,
        installable: preview.installable && snapshot.conversion.installable,
        diagnostics: [...snapshot.conversion.diagnostics, ...preview.diagnostics],
        provenance: materialized.provenance,
        expectedRevision: this.store.getBySource(source.sourceIdentity)?.revision || 0 };
    } finally { safeRemoveTree(temporary); }
  }
  previewBundled(packageId) {
    const entry = this.bundledCatalog?.assertCurrent(packageId);
    if (!entry) fail("BUNDLED_PLUGIN_NOT_FOUND", "内置插件不存在");
    if (isBundledSidecar(packageId)) {
      const temporary = path.join(this.store.paths.pluginStagingDir,
        `bundled-sidecar-preview-${crypto.randomUUID()}`);
      try {
        materializeBundledSidecar(temporary, packageId, entry.sourceDigest, this.bundledCatalog);
        const { root: _root, ...preview } = previewPluginDirectory(temporary,
          { trustedBundled: true, allowGraphSidecar: isGraphSidecar(packageId) ? packageId : false,
            nativeSourceIdentity: packageId === SECURITY_PACKAGE_ID ? SECURITY_SOURCE_IDENTITY
              : packageId === GOG_GMAIL_PACKAGE_ID ? GOG_GMAIL_SOURCE_IDENTITY : null });
        const sourceIdentity = `bundled:${packageId}`;
        return { ...preview, sourceIdentity,
          expectedRevision: this.store.getBySource(sourceIdentity)?.revision || 0 };
      } finally { safeRemoveTree(temporary); }
    }
    if (entry.importStatus !== "previewable") {
      fail("BUNDLED_PLUGIN_ADAPTER_REQUIRED", "内置插件仍需能力适配");
    }
    const source = this._identifyLegacySource({
      sourcePath: this.bundledCatalog.packagePath(packageId), format: "codex-plugin",
      components: ["skills", "mcp-servers"],
    }, true);
    const snapshot = scanLegacySource(source);
    const temporary = path.join(this.store.paths.pluginStagingDir, `bundled-preview-${crypto.randomUUID()}`);
    try {
      const materialized = materializeLegacySource(snapshot, temporary);
      if (packageId === HIGGSFIELD_PACKAGE_ID) {
        applyHiggsfieldOfficialOverlay(materialized.root, entry.sourceDigest);
      }
      const { root: _root, ...preview } = previewPluginDirectory(materialized.root,
        { trustedBundled: true });
      const sourceIdentity = `bundled:${packageId}`;
      return { ...preview, sourceIdentity,
        installable: preview.installable && snapshot.conversion.installable,
        diagnostics: [...snapshot.conversion.diagnostics, ...preview.diagnostics],
        expectedRevision: this.store.getBySource(sourceIdentity)?.revision || 0 };
    } finally { safeRemoveTree(temporary); }
  }
  installBundled({ packageId, previewDigest, operationId, expectedRevision } = {}) {
    if (!HASH_PATTERN.test(previewDigest) || !OPERATION_PATTERN.test(operationId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail("PLUGIN_OPERATION_INVALID", "内置插件安装请求无效");
    }
    const entry = this.bundledCatalog?.assertCurrent(packageId);
    if (!entry || (entry.importStatus !== "previewable" && !isBundledSidecar(packageId))) {
      fail("BUNDLED_PLUGIN_ADAPTER_REQUIRED", "内置插件仍需能力适配");
    }
    if (isBundledSidecar(packageId)) {
      const sourceIdentity = `bundled:${packageId}`;
      const fingerprint = hash(JSON.stringify({ sourceIdentity, previewDigest, expectedRevision }));
      const existing = this.store.beginInstall({ operationId, fingerprint });
      if (existing.phase === "completed") return existing.result;
      if (existing.phase === "failed") fail("PLUGIN_OPERATION_FAILED", "此前安装已失败，请新建操作");
      const temporary = path.join(this.store.paths.pluginStagingDir,
        `bundled-sidecar-${crypto.randomUUID()}`);
      try {
        materializeBundledSidecar(temporary, packageId, entry.sourceDigest, this.bundledCatalog);
        this.bundledCatalog.assertCurrent(packageId);
        return this._install({ root: temporary, sourceIdentity, previewDigest,
          operationId, expectedRevision, trustedBundled: true,
          allowGraphSidecar: isGraphSidecar(packageId) ? packageId : false,
          activateOnInstall: isGraphSidecar(packageId) || packageId === SECURITY_PACKAGE_ID
            || packageId === GOG_GMAIL_PACKAGE_ID,
          validateSource: () => this.bundledCatalog.assertCurrent(packageId) });
      } catch (failure) {
        if (failure?.code !== "PLUGIN_SIMULATED_CRASH") {
          this.store.markFailed(operationId, failure?.code || "PACKAGE_INVALID");
        }
        throw failure;
      } finally { safeRemoveTree(temporary); }
    }
    const source = this._identifyLegacySource({
      sourcePath: this.bundledCatalog.packagePath(packageId), format: "codex-plugin",
      components: ["skills", "mcp-servers"],
    }, true);
    const sourceIdentity = `bundled:${packageId}`;
    const fingerprint = hash(JSON.stringify({ sourceIdentity, previewDigest, expectedRevision }));
    const existing = this.store.beginInstall({ operationId, fingerprint });
    if (existing.phase === "completed") return existing.result;
    if (existing.phase === "failed") fail("PLUGIN_OPERATION_FAILED", "此前安装已失败，请新建操作");
    const temporary = path.join(this.store.paths.pluginStagingDir, `bundled-${crypto.randomUUID()}`);
    try {
      const snapshot = scanLegacySource(source);
      if (!snapshot.conversion.installable) fail("BUNDLED_PLUGIN_ADAPTER_REQUIRED", "内置插件仍需能力适配");
      const materialized = materializeLegacySource(snapshot, temporary);
      if (packageId === HIGGSFIELD_PACKAGE_ID) {
        applyHiggsfieldOfficialOverlay(materialized.root, entry.sourceDigest);
      }
      this.onPhase?.("bundled-materialized", { operationId });
      assertLegacySourceCurrent(snapshot);
      this.bundledCatalog.assertCurrent(packageId);
      return this._install({ root: materialized.root, sourceIdentity,
        previewDigest, operationId, expectedRevision,
        diagnostics: snapshot.conversion.diagnostics,
        validateSource: () => {
          assertLegacySourceCurrent(snapshot);
          this.bundledCatalog.assertCurrent(packageId);
        }, activateOnInstall: true, trustedBundled: true });
    } catch (failure) {
      if (failure?.code !== "PLUGIN_SIMULATED_CRASH") this.store.markFailed(operationId, failure?.code || "PACKAGE_INVALID");
      throw failure;
    } finally { safeRemoveTree(temporary); }
  }
  installLegacy({ sourcePath, format, components, previewDigest, operationId, expectedRevision } = {}) {
    if (!HASH_PATTERN.test(previewDigest) || !OPERATION_PATTERN.test(operationId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail("PLUGIN_OPERATION_INVALID", "历史插件安装请求无效");
    }
    const source = this._identifyLegacySource({ sourcePath, format, components });
    const sourceIdentity = source.sourceIdentity;
    const fingerprint = hash(JSON.stringify({ sourceIdentity, previewDigest, expectedRevision }));
    const existingOperation = this.store.beginInstall({ operationId, fingerprint });
    if (existingOperation.phase === "completed") return existingOperation.result;
    if (existingOperation.phase === "failed") fail("PLUGIN_OPERATION_FAILED", "此前安装已失败，请新建操作");
    const temporary = path.join(this.store.paths.pluginStagingDir, `legacy-${crypto.randomUUID()}`);
    try {
      const snapshot = scanLegacySource(source);
      if (!snapshot.conversion.installable) fail("LEGACY_CONTENT_UNSUPPORTED", "所选历史组件无法转换");
      const materialized = materializeLegacySource(snapshot, temporary);
      this.onPhase?.("legacy-materialized", { operationId });
      assertLegacySourceCurrent(snapshot);
      return this._install({ root: materialized.root, sourceIdentity,
        previewDigest, operationId, expectedRevision,
        diagnostics: snapshot.conversion.diagnostics,
        validateSource: () => assertLegacySourceCurrent(snapshot) });
    } catch (failure) {
      if (failure?.code !== "PLUGIN_SIMULATED_CRASH") this.store.markFailed(operationId, failure?.code || "PACKAGE_INVALID");
      throw failure;
    } finally { safeRemoveTree(temporary); }
  }
  previewGit(input) {
    const source = identifyGitSource(input);
    const temporary = path.join(this.store.paths.pluginStagingDir, `preview-${crypto.randomUUID()}`);
    try {
      materializeGitSource(source, temporary);
      const { root, ...result } = previewPluginDirectory(temporary);
      return {
        ...result,
        sourceIdentity: source.sourceIdentity,
        expectedRevision: this.store.getBySource(source.sourceIdentity)?.revision || 0,
      };
    } finally { safeRemoveTree(temporary); }
  }
  installGit({ repositoryPath, commit, subdir, previewDigest, operationId, expectedRevision }) {
    const source = identifyGitSource({ repositoryPath, commit, subdir });
    const temporary = path.join(this.store.paths.pluginStagingDir, `git-${crypto.randomUUID()}`);
    try {
      materializeGitSource(source, temporary);
      return this._install({ root: temporary, sourceIdentity: source.sourceIdentity,
        previewDigest, operationId, expectedRevision });
    } finally { safeRemoveTree(temporary); }
  }
  async previewRemoteGit(input, options = {}) {
    const identity = identifyRemoteGitSource(input);
    const fetched = await this.remoteGitFetcher.fetch(identity, options);
    const temporary = path.join(this.store.paths.pluginStagingDir, `remote-preview-${crypto.randomUUID()}`);
    try {
      const source = identifyGitSource({ ...fetched, subdir: fetched.subdir || null });
      materializeGitSource(source, temporary);
      const { root: _root, ...preview } = previewPluginDirectory(temporary);
      return { ...preview, sourceIdentity: identity.sourceIdentity,
        expectedRevision: this.store.getBySource(identity.sourceIdentity)?.revision || 0 };
    } finally { safeRemoveTree(temporary); await fetched.release(); }
  }
  async installRemoteGit({ repositoryUrl, commit, subdir, previewDigest, operationId, expectedRevision } = {}, options = {}) {
    if (typeof previewDigest !== "string" || !HASH_PATTERN.test(previewDigest)
      || typeof operationId !== "string" || !OPERATION_PATTERN.test(operationId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail("PLUGIN_OPERATION_INVALID", "远程 Git 安装请求无效");
    }
    const identity = identifyRemoteGitSource({ repositoryUrl, commit, subdir });
    const fingerprint = hash(JSON.stringify({ sourceIdentity: identity.sourceIdentity, previewDigest, expectedRevision }));
    const previous = this.store.beginInstall({ operationId, fingerprint });
    if (previous.phase === "completed") return previous.result;
    if (previous.phase === "failed") fail("PLUGIN_OPERATION_FAILED", "此前安装已失败，请新建操作");
    let fetched;
    const temporary = path.join(this.store.paths.pluginStagingDir, `remote-install-${crypto.randomUUID()}`);
    try {
      fetched = await this.remoteGitFetcher.fetch(identity, options);
      const source = identifyGitSource({ ...fetched, subdir: fetched.subdir || null });
      materializeGitSource(source, temporary);
      return this._install({ root: temporary, sourceIdentity: identity.sourceIdentity,
        previewDigest, operationId, expectedRevision });
    } catch (failure) {
      if (failure?.code !== "PLUGIN_SIMULATED_CRASH") this.store.markFailed(operationId, failure?.code || "GIT_REMOTE_FAILED");
      throw failure;
    } finally { safeRemoveTree(temporary); await fetched?.release(); }
  }
  install({ sourcePath, previewDigest, operationId, expectedRevision }) {
    if (typeof sourcePath !== "string" || sourcePath.length === 0 || sourcePath.length > 4096
      || !HASH_PATTERN.test(previewDigest) || !OPERATION_PATTERN.test(operationId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail("PLUGIN_OPERATION_INVALID", "安装请求无效");
    }
    const root = path.resolve(sourcePath);
    const sourceIdentity = `local:${root}`;
    return this._install({ root, sourceIdentity, previewDigest, operationId, expectedRevision });
  }
  _install({ root, sourceIdentity, previewDigest, operationId, expectedRevision,
    diagnostics = [], validateSource = null, activateOnInstall = false,
    trustedBundled = false, allowGraphSidecar = false }) {
    if (!HASH_PATTERN.test(previewDigest) || !OPERATION_PATTERN.test(operationId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail("PLUGIN_OPERATION_INVALID", "安装请求无效");
    }
    const fingerprint = hash(JSON.stringify({ sourceIdentity, previewDigest, expectedRevision }));
    const existingOperation = this.store.beginInstall({ operationId, fingerprint });
    if (existingOperation.phase === "completed") return existingOperation.result;
    if (existingOperation.phase === "failed") fail("PLUGIN_OPERATION_FAILED", "此前安装已失败，请新建操作");
    const stagingPath = path.join(this.store.paths.pluginStagingDir, operationId);
    const nativeSourceIdentity = trustedBundled
      && [SECURITY_SOURCE_IDENTITY, GOG_GMAIL_SOURCE_IDENTITY].includes(sourceIdentity)
      ? sourceIdentity : null;
    let published = false;
    try {
      const parsed = previewPluginDirectory(root, { trustedBundled, allowGraphSidecar, nativeSourceIdentity });
      const preview = { ...parsed, diagnostics: [...diagnostics, ...parsed.diagnostics] };
      if (!preview.installable || preview.contentDigest !== previewDigest) {
        fail("PACKAGE_CHANGED", "插件与预览不一致或包含不安全路径");
      }
      const existing = this.store.getBySource(sourceIdentity);
      if ((existing?.revision || 0) !== expectedRevision) {
        fail("REVISION_CONFLICT", "安装版本已变化，请重新预览");
      }
      if (existing && this.store.hasPendingInstallationDisable(existing.installationId)) {
        fail("ACTIVATION_DEFERRED", "安装正等待停用连接排空");
      }
      if (existing && existing.releaseDigest !== preview.contentDigest
        && existing.desiredState === "enabled") {
        fail("PLUGIN_UPDATE_REQUIRES_DISABLE", "更新前必须先停用并排空旧连接");
      }
      if (existing && existing.releaseDigest !== preview.contentDigest
        && this.store.getRelease(sourceIdentity, preview.contentDigest)) {
        fail("PLUGIN_ROLLBACK_REQUIRES_PREVIEW", "恢复已使用的代码版本须先核对数据回退预览");
      }
      safeRemoveTree(stagingPath);
      stagePackage(preview, stagingPath, trustedBundled, allowGraphSidecar, nativeSourceIdentity);
      this.onPhase?.("staged", { operationId });
      validateSource?.();
      const packagePath = path.join(this.store.paths.pluginPackagesDir, preview.contentDigest);
      if (fs.existsSync(packagePath)) {
        const existing = previewPluginDirectory(packagePath, { trustedBundled, allowGraphSidecar, nativeSourceIdentity });
        if (!existing.installable || existing.contentDigest !== preview.contentDigest) {
          fail("PACKAGE_INVALID", "已有同摘要包目录不匹配");
        }
        safeRemoveTree(stagingPath);
      } else {
        fs.renameSync(stagingPath, packagePath);
        fsyncDirectory(this.store.paths.pluginPackagesDir);
      }
      published = true;
      this.onPhase?.("published", { operationId });
      return this.store.commitInstall({
        operationId, fingerprint, installationId: hash(sourceIdentity),
        sourceIdentity, expectedRevision, preview, activateOnInstall,
      });
    } catch (failure) {
      // A crash after rename leaves an unreferenced immutable package. Retrying the
      // same operation verifies and adopts it; no package code is ever executed.
      if (failure?.code !== "PLUGIN_SIMULATED_CRASH") {
        if (!published) safeRemoveTree(stagingPath);
        this.store.markFailed(operationId, failure?.code || "PACKAGE_INVALID");
      }
      throw failure;
    }
  }
}

module.exports = { PluginPackageInstaller };
