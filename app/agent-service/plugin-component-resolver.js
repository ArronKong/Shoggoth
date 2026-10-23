"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { hasSecret } = require("./memory-engine");
const { componentId } = require("./plugin-component-catalog");
const { previewPluginDirectory, readPluginMcpServer } = require("./plugin-package-parser");
const { isGraphSidecar } = require("./plugin-microsoft-graph-sidecar");
const { SOURCE_IDENTITY: GOG_GMAIL_SOURCE_IDENTITY } = require("./plugin-gogcli-gmail-sidecar");
const { serviceError } = require("./security");

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_SKILL_BYTES = 256 * 1024;
function graphSidecarId(sourceIdentity) {
  const packageId = sourceIdentity?.startsWith("bundled:")
    ? sourceIdentity.slice("bundled:".length) : null;
  return isGraphSidecar(packageId) ? packageId : false;
}
function internalSidecarIdentity(sourceIdentity) {
  return ["bundled:codex-security", GOG_GMAIL_SOURCE_IDENTITY].includes(sourceIdentity)
    ? sourceIdentity : null;
}

function skillFileParts(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.isWellFormed()
    || Buffer.byteLength(relativePath, "utf8") > 1024 || relativePath.includes("\\")) {
    fail("PLUGIN_COMPONENT_INVALID", "插件 Skill 附属文件路径无效");
  }
  const parts = relativePath.split("/");
  if (parts.length > 12 || relativePath === "SKILL.md"
    || parts.some(part => !part || part === "." || part === ".." || part.includes("\0"))) {
    fail("PLUGIN_COMPONENT_INVALID", "插件 Skill 附属文件路径越界");
  }
  return parts;
}

// Paths for supporting material are expressed from the installed package root,
// not by accepting `../` from a Skill directory. Other Skills' own files must
// be opened through their separate catalog/eligibility decision.
function packageResourceParts(relativePath, skillName) {
  if (typeof relativePath !== "string" || !relativePath.isWellFormed()
    || Buffer.byteLength(relativePath, "utf8") > 1024 || relativePath.includes("\\")) {
    fail("PLUGIN_COMPONENT_INVALID", "插件包资源路径无效");
  }
  const parts = relativePath.split("/");
  if (parts.length < 2 || parts.length > 12
    || parts.some(part => !part || part === "." || part === ".."
      || part.startsWith(".") || part.includes("\0"))
    // APFS is commonly case-insensitive. `Skills/other/SKILL.md` must not
    // bypass the selected Skill boundary by resolving to `skills/other`.
    || (parts[0].toLowerCase() === "skills" && (parts.length < 3
      || parts[1] !== skillName || parts[2].toLowerCase() === "skill.md"))) {
    fail("PLUGIN_COMPONENT_INVALID", "插件包资源路径越界");
  }
  return parts;
}

function fail(code, message) { throw serviceError(code, message); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function readOwnedSkill(target) {
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size > MAX_SKILL_BYTES || (typeof process.getuid === "function"
      && before.uid !== process.getuid())) {
    fail("PACKAGE_CHANGED", "插件 Skill 文件类型、所有权或大小已变化");
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("PACKAGE_CHANGED", "插件 Skill 文件读取期间被替换");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(target);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev
      || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) {
      fail("PACKAGE_CHANGED", "插件 Skill 文件读取期间变化");
    }
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { fail("PACKAGE_CHANGED", "插件 Skill 内容不是有效 UTF-8"); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(content)) {
      fail("PACKAGE_CHANGED", "插件 Skill 内容不是纯文本");
    }
    if (hasSecret(content)) fail("SKILL_SECRET_REJECTED", "插件 Skill 内容包含敏感信息");
    return { content, descriptorDigest: sha256(bytes) };
  } finally { fs.closeSync(fd); }
}

class PluginComponentResolver {
  constructor({ store } = {}) {
    if (!store?.paths?.pluginsDir || !store.paths.pluginPackagesDir
      || typeof store.getInstallation !== "function" || typeof store.getRelease !== "function") {
      throw new TypeError("PluginComponentResolver requires PluginStore");
    }
    this.store = store;
  }

  _packageRoot(releaseDigest) {
    if (!HASH_PATTERN.test(releaseDigest || "")) {
      fail("PLUGIN_COMPONENT_INVALID", "插件包摘要无效");
    }
    const root = path.join(this.store.paths.pluginPackagesDir, releaseDigest);
    for (const directory of [this.store.paths.pluginsDir, this.store.paths.pluginPackagesDir, root]) {
      let stat;
      try { stat = fs.lstatSync(directory); }
      catch { fail("PACKAGE_CHANGED", "插件摘要包路径不存在"); }
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        fail("PACKAGE_CHANGED", "插件摘要包路径不安全");
      }
    }
    try { return fs.realpathSync(root); }
    catch { fail("PACKAGE_CHANGED", "插件摘要包路径已变化"); }
  }

  verifyInstallation(installationId) {
    const installation = this.store.getInstallation(installationId);
    if (!installation) fail("PLUGIN_INSTALLATION_INVALID", "插件安装不存在");
    this._verifyPackage(this._packageRoot(installation.releaseDigest),
      installation.releaseDigest, installation.sourceIdentity);
    return installation;
  }

  _current({ installationId, componentId: selectedId, releaseDigest, descriptorDigest }, kind,
    allowDisabled = false) {
    if (typeof installationId !== "string" || !HASH_PATTERN.test(selectedId || "")
      || !HASH_PATTERN.test(releaseDigest || "") || !HASH_PATTERN.test(descriptorDigest || "")) {
      fail("PLUGIN_COMPONENT_INVALID", "插件组件解析参数无效");
    }
    const installation = this.store.getInstallation(installationId);
    if (!installation || (!allowDisabled && installation.desiredState !== "enabled")
      || !["enabled", "disabled"].includes(installation.desiredState)
      || this.store.hasPendingInstallationDisable?.(installationId)) {
      fail("PLUGIN_COMPONENT_INACTIVE", "插件安装未启用");
    }
    if (installation.releaseDigest !== releaseDigest) {
      fail("PLUGIN_COMPONENT_REVISION_CHANGED", "插件安装代次已变化");
    }
    const release = this.store.getRelease(installation.sourceIdentity, releaseDigest);
    const group = kind === "skill" ? release?.components?.skills : kind === "hook" ? release?.components?.hooks : release?.components?.mcpServers;
    const component = group?.find((item) => componentId(installationId, kind, item.name) === selectedId);
    if (!component) fail("PLUGIN_COMPONENT_NOT_FOUND", "插件组件不存在");
    if (component.descriptorDigest !== descriptorDigest) {
      fail("PLUGIN_COMPONENT_REVISION_CHANGED", "插件组件合同已变化");
    }
    // /var and /private/var can name the same macOS tree. Pass the canonical
    // root to the package parser so its realpath containment check is stable.
    return { root: this._packageRoot(releaseDigest), component,
      sourceIdentity: installation.sourceIdentity };
  }

  _verifyPackage(root, releaseDigest, sourceIdentity) {
    try {
      const preview = previewPluginDirectory(root,
        { trustedBundled: sourceIdentity?.startsWith("bundled:") === true,
          allowGraphSidecar: graphSidecarId(sourceIdentity),
          nativeSourceIdentity: internalSidecarIdentity(sourceIdentity) });
      if (!preview.installable || preview.contentDigest !== releaseDigest) {
        fail("PACKAGE_CHANGED", "插件摘要包内容已变化");
      }
    } catch (error) {
      if (error?.code === "PACKAGE_CHANGED") throw error;
      fail("PACKAGE_CHANGED", "插件摘要包无法重新验证");
    }
  }

  inspectFrozenHook(reference, workspace) {
    const release = this.store.getRelease(reference.sourceIdentity, reference.releaseDigest);
    const component = release?.components.hooks?.find(item => componentId(reference.installationId, "hook", item.name) === reference.componentId);
    if (!component || component.descriptorDigest !== reference.descriptorDigest) fail("PLUGIN_COMPONENT_REVISION_CHANGED", "插件 Hook 合同已变化");
    const root = this._packageRoot(reference.releaseDigest);
    this._verifyPackage(root, reference.releaseDigest, reference.sourceIdentity);
    const { readPluginHookSource } = require("./plugin-hook-parser");
    const { validateDefinition, digest } = require("./hook-contract");
    if (digest({ definition: component.definition, requiresConnections: component.requiresConnections }) !== component.descriptorDigest) fail("PACKAGE_CHANGED", "插件 Hook 元数据已变化");
    let sourceFile = null;
    const handler = component.definition.handler.type === "script" ? (() => {
      const read = readPluginHookSource(root, component.definition.handler.relativePath, component.definition.handler.sha256);
      sourceFile = read.sourceFile;
      return { type: "script", language: component.definition.handler.language, source: read.source,
        ...(component.definition.handler.compatibility ? { compatibility: component.definition.handler.compatibility } : {}),
        ...(component.definition.handler.access ? { access: component.definition.handler.access } : {}) };
    })() : component.definition.handler;
    return { definition: validateDefinition({ ...component.definition, handler }, workspace), sourceFile };
  }

  // Read-only inspection. Runtime selection and authorization remain owned by
  // PluginStore bindings and the capability dispatcher, never by Skill Registry.
  inspectSkill(input) {
    const { root, component, sourceIdentity } = this._current(input, "skill");
    const target = path.join(root, "skills", component.name, "SKILL.md");
    let content;
    let descriptorDigest;
    try { ({ content, descriptorDigest } = readOwnedSkill(target)); }
    catch (error) {
      if (["PACKAGE_CHANGED", "SKILL_SECRET_REJECTED"].includes(error?.code)) throw error;
      fail("PACKAGE_CHANGED", "插件 Skill 无法读取");
    }
    if (descriptorDigest !== input.descriptorDigest) {
      fail("PACKAGE_CHANGED", "插件 Skill 内容摘要已变化");
    }
    this._verifyPackage(root, input.releaseDigest, sourceIdentity);
    return Object.freeze({ source: "plugin", installationId: input.installationId,
      releaseDigest: input.releaseDigest, componentId: input.componentId,
      descriptorDigest, name: component.name, description: component.description, content });
  }

  inspectSkillFile(input, relativePath) {
    const parts = skillFileParts(relativePath);
    const { root, component, sourceIdentity } = this._current(input, "skill");
    const skillRoot = path.join(root, "skills", component.name);
    const target = path.join(skillRoot, ...parts);
    let content;
    let fileHash;
    try {
      const canonical = fs.realpathSync(target);
      if (!canonical.startsWith(skillRoot + path.sep)) {
        fail("PACKAGE_CHANGED", "插件 Skill 附属文件路径已变化");
      }
      ({ content, descriptorDigest: fileHash } = readOwnedSkill(target));
    } catch (error) {
      if (["PACKAGE_CHANGED", "SKILL_SECRET_REJECTED"].includes(error?.code)) throw error;
      fail("PACKAGE_CHANGED", "插件 Skill 附属文件无法读取");
    }
    this._verifyPackage(root, input.releaseDigest, sourceIdentity);
    return Object.freeze({ source: "plugin", installationId: input.installationId,
      releaseDigest: input.releaseDigest, componentId: input.componentId,
      name: component.name, relativePath, fileHash, content });
  }

  inspectPackageResource(input, relativePath) {
    const { root, component, sourceIdentity } = this._current(input, "skill");
    const parts = packageResourceParts(relativePath, component.name);
    const target = path.join(root, ...parts);
    let content;
    let fileHash;
    try {
      let directory = root;
      for (const part of parts.slice(0, -1)) {
        directory = path.join(directory, part);
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()
          || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
          fail("PACKAGE_CHANGED", "插件包资源目录已变化");
        }
      }
      const canonical = fs.realpathSync(target);
      if (!canonical.startsWith(root + path.sep)) {
        fail("PACKAGE_CHANGED", "插件包资源路径已变化");
      }
      ({ content, descriptorDigest: fileHash } = readOwnedSkill(target));
    } catch (error) {
      if (["PACKAGE_CHANGED", "SKILL_SECRET_REJECTED"].includes(error?.code)) throw error;
      fail("PACKAGE_CHANGED", "插件包资源无法读取");
    }
    this._verifyPackage(root, input.releaseDigest, sourceIdentity);
    return Object.freeze({ source: "plugin", installationId: input.installationId,
      releaseDigest: input.releaseDigest, componentId: input.componentId,
      name: component.name, relativePath, fileHash, content });
  }

  listEnabledSkillDescriptors(profileId) {
    const selected = [];
    // Package installation is global regardless of its source. Skill bindings
    // from the older per-profile flow remain stored for migration/audit but
    // cannot narrow or expand the current public Skill projection.
    for (const installation of this.store.listInstallations()) {
      if (installation.desiredState !== "enabled"
        || this.store.hasPendingInstallationDisable?.(installation.installationId)) continue;
      const release = this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
      if (!release) fail("PLUGIN_COMPONENT_NOT_FOUND", "已安装的插件版本不存在");
      for (const component of release.components.skills) {
        const selectedId = componentId(installation.installationId, "skill", component.name);
        selected.push(Object.freeze({ source: "plugin", global: true,
          bindingId: `global-${selectedId}`, bindingRevision: installation.revision,
          installationId: installation.installationId, releaseDigest: installation.releaseDigest,
          sourceIdentity: installation.sourceIdentity,
          componentId: selectedId, descriptorDigest: component.descriptorDigest,
          name: component.name, description: component.description,
          requiredTools: component.requiredTools || [],
          requiredRuntimeCapabilities: component.requiredRuntimeCapabilities || [],
          declaredAllowedTools: component.declaredAllowedTools === true,
          packageName: release.name, declaredVersion: release.declaredVersion }));
      }
    }
    return selected;
  }

  listEnabledSkills(profileId) {
    return this.listEnabledSkillDescriptors(profileId).map((item) => Object.freeze({
      bindingId: item.bindingId, bindingRevision: item.bindingRevision,
      ...this.inspectSkill(item),
    }));
  }

  inspectMcpServer(input) {
    return this._inspectMcpServer(input, false);
  }

  inspectMcpDependency(input) {
    return this._inspectMcpServer(input, true);
  }

  _inspectMcpServer(input, allowDisabled) {
    const { root, component, sourceIdentity } = this._current(input, "mcp-server", allowDisabled);
    let server;
    try { server = readPluginMcpServer(root, component.name,
      { allowGraphSidecar: graphSidecarId(sourceIdentity),
        nativeSourceIdentity: internalSidecarIdentity(sourceIdentity) }); }
    catch (error) {
      if (error?.code === "PACKAGE_CHANGED") throw error;
      fail("PACKAGE_CHANGED", "插件 MCP 组件无法读取");
    }
    if (server.descriptorDigest !== input.descriptorDigest) {
      fail("PACKAGE_CHANGED", "插件 MCP 组件摘要已变化");
    }
    this._verifyPackage(root, input.releaseDigest, sourceIdentity);
    return Object.freeze({ source: "plugin", installationId: input.installationId,
      releaseDigest: input.releaseDigest, componentId: input.componentId,
      descriptorDigest: server.descriptorDigest, name: component.name,
      transport: server.type, spec: server.spec,
      oauthResource: server.oauthResource });
  }
}

module.exports = { PluginComponentResolver };
