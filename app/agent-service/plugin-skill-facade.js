"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { evaluatePluginSkill } = require("./plugin-skill-eligibility");

const MAX_PLUGIN_SKILLS = 5_000;
const MENTION = /\$([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-])/gu;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message) => { throw serviceError(code, message); };

// The model-facing name is stable for one installation/component lineage and
// cannot collide merely because two packages declare the same Skill name.
function aliasOf(componentId) { return `plugin-${componentId.slice(0, 56)}`; }

class PluginSkillFacade {
  constructor({ nativeStore, resolver, toolCatalogRegistry = null } = {}) {
    if (["catalog", "select", "read", "readEnabledFile"].some((name) =>
      typeof nativeStore?.[name] !== "function")
      || typeof resolver?.listEnabledSkillDescriptors !== "function"
      || typeof resolver?.inspectSkill !== "function"
      || typeof resolver?.inspectSkillFile !== "function"
      || (toolCatalogRegistry !== null
        && typeof toolCatalogRegistry?.listForBinding !== "function")) {
      throw new TypeError("PluginSkillFacade requires native Skill and plugin readers");
    }
    this.nativeStore = nativeStore;
    this.resolver = resolver;
    this.toolCatalogRegistry = toolCatalogRegistry;
  }

  _plugins(profileId, options = {}) {
    const descriptors = this.resolver.listEnabledSkillDescriptors(profileId);
    if (descriptors.length > MAX_PLUGIN_SKILLS) {
      fail("SKILL_CATALOG_LIMIT", "插件 Skill 目录超出容量上限");
    }
    const aliases = new Set();
    return descriptors.map((descriptor) => {
      const name = aliasOf(descriptor.componentId);
      if (aliases.has(name)) fail("SKILL_NAME_CONFLICT", "插件 Skill 标识发生冲突");
      aliases.add(name);
      const contentHash = hash([descriptor.installationId, descriptor.componentId,
        descriptor.releaseDigest, descriptor.descriptorDigest, descriptor.bindingId,
        descriptor.bindingRevision]);
      const eligibility = evaluatePluginSkill(descriptor, options);
      const item = Object.freeze({ id: descriptor.componentId, name,
        version: descriptor.declaredVersion || descriptor.releaseDigest.slice(0, 12),
        description: `${descriptor.packageName}: ${descriptor.description}`,
        source: "plugin", contentHash, requiredTools: eligibility.requiredTools,
        requiredRuntimeCapabilities: eligibility.requiredRuntimeCapabilities,
        sourceCompatibility: [], assessment: eligibility.assessment,
        globalEnabled: descriptor.global === true, enabled: true,
        eligible: eligibility.eligible, ineligibleReason: eligibility.reason,
        reason: eligibility.reason, dependency: eligibility.dependency });
      return { descriptor, item };
    });
  }

  _pluginOptions(profileId, options) {
    return { ...options,
      pluginTools: Array.isArray(options.pluginToolProjection)
        ? options.pluginToolProjection : [] };
  }

  _merged(profileId, options = {}) {
    const native = this.nativeStore.catalog(profileId, options);
    if (options.allowPluginSkills === false) return { catalog: native, plugins: [] };
    const plugins = this._plugins(profileId, this._pluginOptions(profileId, options));
    if (plugins.length === 0) return { catalog: native, plugins };
    const nativeNames = new Set([...native.items, ...native.ineligible].map((item) => item.name));
    if (plugins.some(({ item }) => nativeNames.has(item.name))) {
      fail("SKILL_NAME_CONFLICT", "插件 Skill 名称与独立 Skill 冲突");
    }
    return { plugins, catalog: {
      ...native,
      registryRevision: hash([native.registryRevision, plugins.map(({ item }) =>
        [item.id, item.contentHash, item.eligible, item.reason, item.dependency])]),
      items: [...native.items, ...plugins.filter(({ item }) => item.eligible).map(({ item }) => item)],
      ineligible: [...native.ineligible,
        ...plugins.filter(({ item }) => !item.eligible).map(({ item }) => item)],
    } };
  }

  catalog(profileId, options = {}) {
    return this._merged(profileId, options).catalog;
  }

  installGlobalFromDirectory(input) {
    if (typeof this.nativeStore.installGlobalFromDirectory !== "function") {
      fail("MCP_TOOL_UNAVAILABLE", "Skill 安装存储不可用");
    }
    return this.nativeStore.installGlobalFromDirectory(input);
  }

  select(profileId, query, options = {}) {
    const source = String(query || "");
    const mentions = [...source.matchAll(MENTION)].map((match) => match[1]);
    if (new Set(mentions).size > 4) {
      fail("SKILL_SELECTION_LIMIT", "单次 Run 最多显式选择四个 Skill");
    }
    const { catalog, plugins } = this._merged(profileId, options);
    if (plugins.length === 0) return this.nativeStore.select(profileId, source, options);
    const byAlias = new Map(plugins.filter(({ item }) => item.eligible)
      .map(({ item }) => [item.name, item]));
    const nativeQuery = source.replace(MENTION, (match, name) =>
      byAlias.has(name) ? " ".repeat(match.length) : match);
    const nativeSelected = this.nativeStore.select(profileId, nativeQuery, options).selected;
    const byName = new Map(nativeSelected.map((item) => [item.name, item]));
    const selected = [...new Set(mentions)].map((name) => byAlias.get(name) || byName.get(name))
      .filter(Boolean);
    return { ...catalog, selected };
  }

  read(input) {
    if (input.allowPluginSkills === false) return this.nativeStore.read(input);
    const selected = this._plugins(input.profileId, this._pluginOptions(input.profileId, input))
      .find(({ item }) => item.name === input.name);
    if (!selected) return this.nativeStore.read(input);
    if (!selected.item.eligible) {
      fail("SKILL_INELIGIBLE", "插件 Skill 所需工具或运行能力当前不可用");
    }
    if (input.contentHash !== undefined && input.contentHash !== selected.item.contentHash) {
      fail("SKILL_REVISION_CHANGED", "插件 Skill 内容版本已变化");
    }
    const inspected = this.resolver.inspectSkill(selected.descriptor);
    return { ...selected.item, content: inspected.content };
  }

  readFile(input) {
    if (input.allowPluginSkills === false) return this.nativeStore.readEnabledFile(input);
    const selected = this._plugins(input.profileId, this._pluginOptions(input.profileId, input))
      .find(({ item }) => item.name === input.name);
    if (!selected) return this.nativeStore.readEnabledFile(input);
    if (!selected.item.eligible) {
      fail("SKILL_INELIGIBLE", "插件 Skill 所需工具或运行能力当前不可用");
    }
    if (input.contentHash !== selected.item.contentHash) {
      fail("SKILL_REVISION_CHANGED", "插件 Skill 内容版本已变化");
    }
    const inspected = this.resolver.inspectSkillFile(selected.descriptor, input.relativePath);
    return { ...selected.item, relativePath: inspected.relativePath,
      fileHash: inspected.fileHash, content: inspected.content };
  }

  readResource(input) {
    if (input.allowPluginSkills === false) {
      fail("SKILL_INELIGIBLE", "只有当前已安装插件的 Skill 能读取包级资源");
    }
    const selected = this._plugins(input.profileId, this._pluginOptions(input.profileId, input))
      .find(({ item }) => item.name === input.name);
    if (!selected || !selected.item.eligible) {
      fail("SKILL_INELIGIBLE", "插件 Skill 当前不可用");
    }
    if (input.contentHash !== selected.item.contentHash) {
      fail("SKILL_REVISION_CHANGED", "插件 Skill 内容版本已变化");
    }
    const inspected = this.resolver.inspectPackageResource(selected.descriptor, input.relativePath);
    return { ...selected.item, relativePath: inspected.relativePath,
      fileHash: inspected.fileHash, content: inspected.content };
  }
}

module.exports = { PluginSkillFacade, aliasOf };
