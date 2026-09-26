"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { serviceError } = require("./security");
const { componentId } = require("./plugin-component-catalog");

const METHODS = Object.freeze(["plugins.bundled.list", "plugins.capabilities.list", "plugins.install.preview",
  "plugins.install", "plugins.installations.set", "plugins.skills.bindings.list",
  "plugins.skills.bindings.set", "plugins.mcp.status", "plugins.mcp.tools.list",
  "plugins.mcp.grants.revoke", "plugins.mcp.grants.revoke-all",
  "plugins.mcp.consent.prepare", "plugins.mcp.consent.commit", "plugins.mcp.discover",
  "plugins.uninstall.preview", "plugins.uninstall",
  "plugins.apps.prepare", "plugins.apps.commit", "plugins.apps.chunk", "plugins.apps.message", "plugins.apps.close",
  "plugins.oauth.prepare", "plugins.oauth.commit", "plugins.oauth.status", "plugins.oauth.cancel",
  "plugins.dependencies.preview", "plugins.dependencies.commit", "plugins.dependencies.status", "plugins.dependencies.operation",
  "plugins.connections.prepare", "plugins.connections.commit", "plugins.connections.operation",
  "plugins.rollback.list", "plugins.rollback.prepare", "plugins.rollback.commit", "plugins.rollback.operation",
  "plugins.operations.get"]);
const DIGEST = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TOOL_ID = /^plugin:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}$/u;
const MAX_RESULT_BYTES = 48 * 1024;

function fail() { throw serviceError("PLUGIN_REQUEST_INVALID", "插件管理参数无效"); }
function plain(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length
    && fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}
function absolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value)
    && value.isWellFormed() && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= 4096;
}
function sourceOf(value) {
  if (plain(value, ["kind", "packageId"]) && value.kind === "bundled"
    && typeof value.packageId === "string"
    && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.packageId)) return value;
  if (plain(value, ["kind", "repositoryUrl", "commit", "subdir"]) && value.kind === "remote-git"
    && typeof value.repositoryUrl === "string" && value.repositoryUrl.length <= 2048
    && typeof value.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.commit)
    && (value.subdir === null || (typeof value.subdir === "string" && value.subdir.length <= 512))) {
    try {
      const url = new URL(value.repositoryUrl);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) fail();
      return value;
    } catch { fail(); }
  }
  if (plain(value, ["kind", "path"]) && value.kind === "directory"
    && absolutePath(value.path)) return value;
  if (plain(value, ["kind", "path", "format", "components"]) && value.kind === "legacy-directory"
    && absolutePath(value.path) && ["claude-plugin", "codex-plugin"].includes(value.format)
    && Array.isArray(value.components) && value.components.length > 0 && value.components.length <= 2
    && new Set(value.components).size === value.components.length
    && value.components.every(item => ["skills", "mcp-servers"].includes(item))) return value;
  if (plain(value, ["kind", "repositoryPath", "commit", "subdir"])
    && value.kind === "git" && absolutePath(value.repositoryPath)
    && typeof value.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.commit)
    && (value.subdir === null || (typeof value.subdir === "string"
      && value.subdir.isWellFormed() && Buffer.byteLength(value.subdir, "utf8") <= 512
      && !value.subdir.includes("\0")))) return value;
  fail();
}
function bounded(value) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RESULT_BYTES) {
    throw serviceError("PLUGIN_RESPONSE_TOO_LARGE", "插件管理响应超出容量上限");
  }
  return value;
}
function publicInstallation(value) {
  if (!value || typeof value !== "object") {
    throw serviceError("PLUGIN_SERVICE_FAILED", "插件安装收据无效");
  }
  const { sourceIdentity } = value;
  if (typeof sourceIdentity !== "string"
    || (!sourceIdentity.startsWith("local:") && !sourceIdentity.startsWith("git:")
      && !sourceIdentity.startsWith("legacy:") && !sourceIdentity.startsWith("remote-git:")
      && !sourceIdentity.startsWith("bundled:"))) {
    throw serviceError("PLUGIN_SERVICE_FAILED", "插件来源标识无效");
  }
  return { installationId: value.installationId,
    releaseDigest: value.releaseDigest, desiredState: value.desiredState,
    revision: value.revision, createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    sourceKind: sourceIdentity.startsWith("bundled:") ? "bundled"
      : sourceIdentity.startsWith("remote-git:") ? "remote-git" : sourceIdentity.startsWith("legacy:") ? "legacy-directory"
        : sourceIdentity.startsWith("git:") ? "git" : "directory",
    ...(Object.hasOwn(value, "packageName") ? {
      packageName: value.packageName, declaredVersion: value.declaredVersion,
      components: value.components, diagnostics: value.diagnostics,
    } : {}),
  };
}
function publicOperation(value) {
  if (!value) return null;
  return { operationId: value.operationId, kind: value.kind, phase: value.phase,
    result: value.phase === "completed"
      ? value.kind === "skill-binding-set" ? publicBinding(value.result)
        : value.kind === "grant-revoke" ? publicGrantReceipt(value.result)
          : value.kind === "grants-revoke-all" ? publicGrantBulkReceipt(value.result)
          : ["mcp-connect", "grant-allow", "uninstall"].includes(value.kind) ? value.result
          : publicInstallation(value.result)
      : value.phase === "failed" ? { code: typeof value.result?.code === "string"
        && /^[A-Z_]{1,64}$/u.test(value.result.code)
        ? value.result.code : "PACKAGE_INVALID" } : null,
    createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function publicGrantReceipt(value) {
  if (!value || value.effect !== "deny" || !OPERATION_ID.test(value.bindingId)
    || typeof value.toolIdentity !== "string" || !TOOL_ID.test(value.toolIdentity)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.epoch) || value.epoch < 0) {
    throw serviceError("PLUGIN_SERVICE_FAILED", "工具撤权收据无效");
  }
  return { bindingId: value.bindingId, toolIdentity: value.toolIdentity,
    effect: "deny", revision: value.revision, epoch: value.epoch };
}

function publicGrantBulkReceipt(value) {
  if (!value || !OPERATION_ID.test(value.bindingId)
    || !Number.isSafeInteger(value.revokedCount) || value.revokedCount < 0
    || !Number.isSafeInteger(value.bindingRevision) || value.bindingRevision < 1
    || !Number.isSafeInteger(value.epoch) || value.epoch < 0) {
    throw serviceError("PLUGIN_SERVICE_FAILED", "批量撤权收据无效");
  }
  return { bindingId: value.bindingId, revokedCount: value.revokedCount,
    bindingRevision: value.bindingRevision, epoch: value.epoch };
}

function publicBinding(value) {
  if (!value || value.componentKind !== "skill" || value.connectionId !== null) {
    throw serviceError("PLUGIN_SERVICE_FAILED", "插件 Skill 绑定收据无效");
  }
  return { bindingId: value.bindingId, profileId: value.subjectId,
    installationId: value.installationId, componentId: value.componentId,
    enabled: value.enabled, revision: value.revision };
}

function fingerprint(kind, values) {
  return crypto.createHash("sha256").update(JSON.stringify([kind, ...values])).digest("hex");
}

class PluginServiceController {
  constructor({ store, installer, catalog, bundledCatalog = null, resolver, productStore,
    toolCatalogRegistry, drainInstallation, resumeInstallation, getConsent = () => null,
    getAppController = () => null, getOAuthController = () => null, getDependencyController = () => null,
    getConnectionController = () => null, getRollbackController = () => null } = {}) {
    if (typeof store?.getOperation !== "function"
      || typeof installer?.preview !== "function"
      || typeof installer?.install !== "function"
      || typeof catalog?.list !== "function"
      || typeof resolver?.verifyInstallation !== "function"
      || typeof productStore?.getAgentProfile !== "function"
      || typeof store?.beginInstallationDisable !== "function"
      || typeof store?.hasPendingInstallationDisable !== "function"
      || typeof store?.getConnectionCountsForComponent !== "function"
      || typeof store?.getGrantCountsForBinding !== "function"
      || typeof store?.getGrant !== "function"
      || typeof store?.revokeGrant !== "function"
      || typeof store?.revokeAllGrants !== "function"
      || typeof toolCatalogRegistry?.listForBinding !== "function"
      || typeof drainInstallation !== "function"
      || typeof resumeInstallation !== "function") {
      throw new TypeError("PluginServiceController requires Service-owned plugin components");
    }
    this.store = store;
    this.installer = installer;
    this.catalog = catalog;
    this.bundledCatalog = bundledCatalog;
    this.resolver = resolver;
    this.productStore = productStore;
    this.toolCatalogRegistry = toolCatalogRegistry;
    this.drainInstallation = drainInstallation;
    this.resumeInstallation = resumeInstallation;
    this.getConsent = getConsent;
    this.getAppController = getAppController;
    this.getOAuthController = getOAuthController;
    this.getDependencyController = getDependencyController;
    this.getConnectionController = getConnectionController;
    this.getRollbackController = getRollbackController;
  }

  handle(method, params) {
    if (!METHODS.includes(method)) fail();
    if (method === "plugins.bundled.list") {
      if (!plain(params, [])) fail();
      if (!this.bundledCatalog) throw serviceError("PLUGIN_UNAVAILABLE", "内置插件目录不可用");
      const catalog = this.bundledCatalog.list();
      return bounded({ ...catalog, items: catalog.items.map(item => {
        const installation = this.store.getBySource(`bundled:${item.id}`);
        return { ...item, installationState: installation
          && installation.desiredState !== "uninstalled" ? installation.desiredState : "not-installed",
        installedReleaseDigest: installation && installation.desiredState !== "uninstalled"
          ? installation.releaseDigest : null };
      }) });
    }
    if (method.startsWith("plugins.rollback.")) {
      const controller = this.getRollbackController();
      if (!controller) throw serviceError("PLUGIN_UNAVAILABLE", "插件回退管理不可用");
      return Promise.resolve(controller[method.slice("plugins.rollback.".length)](params)).then(bounded);
    }
    if (method.startsWith("plugins.connections.")) {
      const controller = this.getConnectionController();
      if (!controller) throw serviceError("PLUGIN_UNAVAILABLE", "插件账号管理不可用");
      return Promise.resolve(controller[method.slice("plugins.connections.".length)](params)).then(bounded);
    }
    if (method.startsWith("plugins.dependencies.")) {
      const controller = this.getDependencyController();
      if (!controller) throw serviceError("PLUGIN_UNAVAILABLE", "插件依赖管理不可用");
      return Promise.resolve(controller[method.slice("plugins.dependencies.".length)](params)).then(bounded);
    }
    if (method.startsWith("plugins.oauth.")) {
      const oauth = this.getOAuthController();
      if (!oauth) throw serviceError("PLUGIN_UNAVAILABLE", "插件账号连接不可用");
      return Promise.resolve(oauth[method.slice("plugins.oauth.".length)](params)).then(bounded);
    }
    if (method.startsWith("plugins.apps.")) {
      const apps = this.getAppController();
      if (!apps) throw serviceError("PLUGIN_UNAVAILABLE", "插件界面不可用");
      if (method === "plugins.apps.prepare") return bounded(apps.prepare(params));
      if (method === "plugins.apps.commit") return Promise.resolve(apps.commit(params)).then(bounded);
      if (method === "plugins.apps.chunk" && plain(params, ["transport", "index"])) {
        return bounded(apps.readChunk(params.transport, params.index));
      }
      if (method === "plugins.apps.message" && plain(params, ["transport", "message"])) {
        return Promise.resolve(apps.message(params.transport, params.message)).then(bounded);
      }
      if (method === "plugins.apps.close" && plain(params, ["transport"])) return bounded(apps.close(params.transport));
      fail();
    }
    if (["plugins.uninstall.preview", "plugins.uninstall"].includes(method)) {
      if (!plain(params, method === "plugins.uninstall.preview"
        ? ["installationId", "expectedRevision"] : ["installationId", "expectedRevision", "operationId"])
        || typeof params.installationId !== "string" || !OPERATION_ID.test(params.installationId)
        || !Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1
        || (method === "plugins.uninstall" && (typeof params.operationId !== "string"
          || !OPERATION_ID.test(params.operationId)))) fail();
      if (method === "plugins.uninstall.preview") return this.installer.previewUninstall(params);
      const pending = this.installer.beginUninstall(params);
      const finish = () => ({ uninstall: this.installer.uninstall(params),
        operation: publicOperation(this.store.getOperation(params.operationId)) });
      if (pending.phase === "completed") return finish();
      return Promise.resolve(this.drainInstallation(params.installationId)).then(finish);
    }
    if (["plugins.mcp.consent.prepare", "plugins.mcp.consent.commit",
      "plugins.mcp.discover"].includes(method)) {
      const consent = this.getConsent();
      if (!consent) throw serviceError("PLUGIN_UNAVAILABLE", "插件授权不可用");
      if (method === "plugins.mcp.consent.prepare") return consent.prepare(params);
      if (method === "plugins.mcp.consent.commit") {
        if (!plain(params, ["challenge", "approved"])) fail();
        return consent.commit(params);
      }
      if (!plain(params, ["profileId", "bindingId"])
        || typeof params.profileId !== "string" || !OPERATION_ID.test(params.profileId)
        || typeof params.bindingId !== "string" || !OPERATION_ID.test(params.bindingId)) fail();
      return consent.discover(params);
    }
    if (method === "plugins.capabilities.list") {
      if (!plain(params, ["cursor", "limit", "catalogRevision"])
        || !Number.isSafeInteger(params.cursor) || params.cursor < 0
        || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 20
        || (params.catalogRevision !== null
          && (typeof params.catalogRevision !== "string"
            || !DIGEST.test(params.catalogRevision)))) fail();
      const rows = this.catalog.list();
      const catalogRevision = crypto.createHash("sha256").update(JSON.stringify(rows.map(
        (item) => [item.installationId, item.releaseDigest, item.desiredState, item.revision],
      ))).digest("hex");
      if (params.cursor > rows.length || (params.cursor === 0
        ? params.catalogRevision !== null
        : params.catalogRevision !== catalogRevision)) {
        throw serviceError("REVISION_CONFLICT", "插件目录已变化，请从第一页重新读取");
      }
      const next = params.cursor + params.limit;
      return bounded({ supported: true, catalogRevision,
        items: rows.slice(params.cursor, next).map(publicInstallation),
        nextCursor: next < rows.length ? next : null });
    }
    if (method === "plugins.install.preview") {
      if (!plain(params, ["source"])) fail();
      const source = sourceOf(params.source);
      if (source.kind === "remote-git") return this.installer.previewRemoteGit(source).then(preview => bounded({
        sourceKind: source.kind, previewDigest: preview.contentDigest, expectedRevision: preview.expectedRevision,
        specVersion: preview.specVersion, name: preview.name, declaredVersion: preview.declaredVersion,
        installable: preview.installable, components: { skills: preview.skills.map(item => ({
          name: item.name, description: item.description, descriptorDigest: item.descriptorDigest,
        })), mcpServers: preview.mcpServers }, diagnostics: preview.diagnostics }));
      const preview = source.kind === "bundled"
        ? this.installer.previewBundled(source.packageId)
        : source.kind === "directory"
        ? this.installer.preview(source.path)
        : source.kind === "legacy-directory" ? this.installer.previewLegacy({
          sourcePath: source.path, format: source.format, components: source.components })
        : this.installer.previewGit({ repositoryPath: source.repositoryPath,
          commit: source.commit, subdir: source.subdir ?? undefined });
      return bounded({ sourceKind: source.kind,
        previewDigest: preview.contentDigest, expectedRevision: preview.expectedRevision,
        specVersion: preview.specVersion, name: preview.name,
        declaredVersion: preview.declaredVersion, installable: preview.installable,
        components: { skills: preview.skills.map((item) => ({
          name: item.name, description: item.description,
          descriptorDigest: item.descriptorDigest,
        })), mcpServers: preview.mcpServers },
        diagnostics: preview.diagnostics });
    }
    if (method === "plugins.install") {
      if (!plain(params, ["source", "previewDigest", "operationId", "expectedRevision"])
        || typeof params.previewDigest !== "string" || !DIGEST.test(params.previewDigest)
        || typeof params.operationId !== "string" || !OPERATION_ID.test(params.operationId)
        || !Number.isSafeInteger(params.expectedRevision)
        || params.expectedRevision < 0) fail();
      const source = sourceOf(params.source);
      const common = { previewDigest: params.previewDigest,
        operationId: params.operationId, expectedRevision: params.expectedRevision };
      if (source.kind === "remote-git") return this.installer.installRemoteGit({ ...source, ...common }).then(installation => bounded({
        installation: publicInstallation(installation), operation: publicOperation(this.store.getOperation(params.operationId)),
      }));
      const installation = source.kind === "bundled"
        ? this.installer.installBundled({ packageId: source.packageId, ...common })
        : source.kind === "directory"
        ? this.installer.install({ sourcePath: source.path, ...common })
        : source.kind === "legacy-directory" ? this.installer.installLegacy({
          sourcePath: source.path, format: source.format, components: source.components, ...common })
        : this.installer.installGit({ repositoryPath: source.repositoryPath,
          commit: source.commit, subdir: source.subdir ?? undefined, ...common });
      return bounded({ installation: publicInstallation(installation),
        operation: publicOperation(this.store.getOperation(params.operationId)) });
    }
    if (method === "plugins.installations.set") {
      if (!plain(params, ["installationId", "desiredState", "expectedRevision", "operationId"])
        || typeof params.installationId !== "string" || !OPERATION_ID.test(params.installationId)
        || !["enabled", "disabled"].includes(params.desiredState)
        || !Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1
        || typeof params.operationId !== "string" || !OPERATION_ID.test(params.operationId)) fail();
      const operationFingerprint = fingerprint("installation-state", [
        params.installationId, params.desiredState, params.expectedRevision]);
      const commit = () => {
        const result = this.store.performManagementOperation({ operationId: params.operationId,
          kind: "installation-state", fingerprint: operationFingerprint,
          apply: () => {
            if (params.desiredState === "enabled") {
              this.resolver.verifyInstallation(params.installationId);
            }
            return this.store.setInstallationDesiredState(params);
          } });
        return bounded({ installation: publicInstallation(result.result),
          operation: publicOperation(result.operation) });
      };
      // A replay must return its original receipt without draining a newer
      // generation that may have been enabled since the first operation.
      if (params.desiredState !== "disabled") {
        if (this.store.getOperation(params.operationId)) return commit();
        if (this.store.hasPendingInstallationDisable(params.installationId)) {
          throw serviceError("ACTIVATION_DEFERRED", "安装正等待停用连接排空");
        }
        const previous = this.store.getInstallation(params.installationId);
        const result = commit();
        if (previous?.desiredState === "disabled"
          && this.store.getInstallation(params.installationId)?.desiredState === "enabled") {
          this.resumeInstallation(params.installationId);
        }
        return result;
      }
      const pending = this.store.beginInstallationDisable({
        operationId: params.operationId, fingerprint: operationFingerprint,
        installationId: params.installationId, expectedRevision: params.expectedRevision,
      });
      if (pending.phase === "completed") return commit();
      if (pending.phase === "failed") {
        const current = this.store.getInstallation(params.installationId);
        if (current?.desiredState === "enabled"
          && !this.store.hasPendingInstallationDisable(params.installationId)) {
          this.resumeInstallation(params.installationId);
        }
        return bounded({ installation: publicInstallation(current),
          operation: publicOperation(pending) });
      }
      return Promise.resolve(this.drainInstallation(params.installationId)).then(commit);
    }
    if (method === "plugins.skills.bindings.list") {
      if (!plain(params, ["profileId"]) || typeof params.profileId !== "string"
        || !OPERATION_ID.test(params.profileId)) fail();
      if (!this.productStore.getAgentProfile(params.profileId)) {
        throw serviceError("PLUGIN_BINDING_INVALID", "Agent 不存在");
      }
      return bounded({ profileId: params.profileId,
        items: this.store.listBindingsForProfile(params.profileId)
          .filter((item) => item.componentKind === "skill").map(publicBinding) });
    }
    if (method === "plugins.mcp.status") {
      if (!plain(params, ["profileId", "installationId"])
        || typeof params.profileId !== "string" || !OPERATION_ID.test(params.profileId)
        || typeof params.installationId !== "string"
        || !OPERATION_ID.test(params.installationId)) fail();
      if (!this.productStore.getAgentProfile(params.profileId)) {
        throw serviceError("PLUGIN_BINDING_INVALID", "Agent 不存在");
      }
      const installation = this.store.getInstallation(params.installationId);
      if (!installation) throw serviceError("PLUGIN_INSTALLATION_INVALID", "能力包不存在");
      const release = this.store.getRelease(installation.sourceIdentity,
        installation.releaseDigest);
      if (!release) throw serviceError("PLUGIN_SERVICE_FAILED", "能力包版本不存在");
      const bindings = new Map(this.store.listBindingsForProfile(params.profileId)
        .filter((item) => item.installationId === params.installationId
          && item.componentKind === "mcp-server")
        .map((item) => [item.componentId, item]));
      const items = release.components.mcpServers.map((server) => {
        const id = componentId(params.installationId, "mcp-server", server.name);
        const binding = bindings.get(id) || null;
        const selected = binding && this.store.getConnection(binding.connectionId);
        const grants = binding ? this.store.getGrantCountsForBinding(binding.bindingId)
          : { allow: 0, deny: 0 };
        return { componentId: id,
          connections: this.store.getConnectionCountsForComponent(params.installationId, id),
          binding: binding ? { bindingId: binding.bindingId,
            connectionId: binding.connectionId, enabled: binding.enabled,
            revision: binding.revision,
            connectionState: selected?.installationId === params.installationId
              && selected.componentId === id ? selected.state : null,
            grants } : null,
        };
      });
      return bounded({ installationId: params.installationId,
        profileId: params.profileId, items });
    }
    if (method === "plugins.mcp.tools.list") {
      if (!plain(params, ["profileId", "bindingId"])
        || typeof params.profileId !== "string" || !OPERATION_ID.test(params.profileId)
        || typeof params.bindingId !== "string"
        || !OPERATION_ID.test(params.bindingId)) fail();
      if (!this.productStore.getAgentProfile(params.profileId)) {
        throw serviceError("PLUGIN_BINDING_INVALID", "Agent 不存在");
      }
      const binding = this.store.getBinding(params.bindingId);
      if (!binding || binding.subjectId !== params.profileId
        || binding.componentKind !== "mcp-server") {
        throw serviceError("PLUGIN_BINDING_INVALID", "MCP 绑定不存在");
      }
      const installation = this.store.getInstallation(binding.installationId);
      const connection = this.store.getConnection(binding.connectionId);
      const unavailable = { profileId: params.profileId, bindingId: binding.bindingId,
        available: false, catalogRevision: null, items: [] };
      if (!installation || installation.desiredState !== "enabled"
        || !binding.enabled || !connection || connection.state !== "ready") {
        return unavailable;
      }
      const snapshot = this.toolCatalogRegistry.listForBinding({
        installation: { ...installation,
          activeReleaseDigest: installation.releaseDigest }, binding, connection });
      if (!snapshot) return unavailable;
      return bounded({ profileId: params.profileId, bindingId: binding.bindingId,
        available: true, catalogRevision: snapshot.catalogRevision,
        items: snapshot.entries.map((item) => {
          const grant = this.store.getGrant(binding.bindingId, item.toolIdentity);
          return { toolIdentity: item.toolIdentity, name: item.downstreamName,
            contractDigest: item.contractDigest,
            savedGrant: grant ? { effect: grant.effect,
              approvalMode: grant.approvalMode, revision: grant.revision,
              expired: grant.expiresAt !== null && grant.expiresAt <= Date.now(),
              matchesCurrentContract: grant.connectionId === connection.connectionId
                && grant.principalIdentity === connection.principalIdentity
                && grant.contractDigest === item.contractDigest } : null };
        }) });
    }
    if (method === "plugins.mcp.grants.revoke") {
      if (!plain(params, ["profileId", "bindingId", "toolIdentity",
        "expectedRevision", "operationId"])
        || typeof params.profileId !== "string" || !OPERATION_ID.test(params.profileId)
        || typeof params.bindingId !== "string" || !OPERATION_ID.test(params.bindingId)
        || typeof params.toolIdentity !== "string" || !TOOL_ID.test(params.toolIdentity)
        || !Number.isSafeInteger(params.expectedRevision)
        || params.expectedRevision < 1
        || typeof params.operationId !== "string"
        || !OPERATION_ID.test(params.operationId)) fail();
      const result = this.store.performManagementOperation({
        operationId: params.operationId, kind: "grant-revoke",
        fingerprint: fingerprint("grant-revoke", [params.profileId,
          params.bindingId, params.toolIdentity, params.expectedRevision]),
        apply: () => {
          if (!this.productStore.getAgentProfile(params.profileId)) {
            throw serviceError("PLUGIN_BINDING_INVALID", "Agent 不存在");
          }
          const binding = this.store.getBinding(params.bindingId);
          if (!binding || binding.subjectId !== params.profileId
            || binding.componentKind !== "mcp-server") {
            throw serviceError("PLUGIN_BINDING_INVALID", "MCP 绑定不存在");
          }
          return publicGrantReceipt(this.store.revokeGrant({ bindingId: params.bindingId,
            toolIdentity: params.toolIdentity,
            expectedRevision: params.expectedRevision }));
        } });
      return bounded({ grant: publicGrantReceipt(result.result),
        operation: publicOperation(result.operation) });
    }
    if (method === "plugins.mcp.grants.revoke-all") {
      if (!plain(params, ["profileId", "bindingId", "expectedRevision",
        "operationId"])
        || typeof params.profileId !== "string" || !OPERATION_ID.test(params.profileId)
        || typeof params.bindingId !== "string" || !OPERATION_ID.test(params.bindingId)
        || !Number.isSafeInteger(params.expectedRevision)
        || params.expectedRevision < 1
        || typeof params.operationId !== "string"
        || !OPERATION_ID.test(params.operationId)) fail();
      const result = this.store.performManagementOperation({
        operationId: params.operationId, kind: "grants-revoke-all",
        fingerprint: fingerprint("grants-revoke-all", [params.profileId,
          params.bindingId, params.expectedRevision]),
        apply: () => {
          if (!this.productStore.getAgentProfile(params.profileId)) {
            throw serviceError("PLUGIN_BINDING_INVALID", "Agent 不存在");
          }
          const binding = this.store.getBinding(params.bindingId);
          if (!binding || binding.subjectId !== params.profileId
            || binding.componentKind !== "mcp-server") {
            throw serviceError("PLUGIN_BINDING_INVALID", "MCP 绑定不存在");
          }
          return publicGrantBulkReceipt(this.store.revokeAllGrants({
            bindingId: params.bindingId,
            expectedRevision: params.expectedRevision }));
        } });
      return bounded({ revocation: publicGrantBulkReceipt(result.result),
        operation: publicOperation(result.operation) });
    }
    if (method === "plugins.skills.bindings.set") {
      if (!plain(params, ["profileId", "installationId", "componentId", "enabled",
        "expectedRevision", "operationId"])
        || typeof params.profileId !== "string" || !OPERATION_ID.test(params.profileId)
        || typeof params.installationId !== "string" || !OPERATION_ID.test(params.installationId)
        || typeof params.componentId !== "string" || !DIGEST.test(params.componentId)
        || typeof params.enabled !== "boolean"
        || !Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0
        || typeof params.operationId !== "string" || !OPERATION_ID.test(params.operationId)) fail();
      const result = this.store.performManagementOperation({ operationId: params.operationId,
        kind: "skill-binding-set", fingerprint: fingerprint("skill-binding-set", [
          params.profileId, params.installationId, params.componentId,
          params.enabled, params.expectedRevision]),
        apply: () => {
          const profile = this.productStore.getAgentProfile(params.profileId);
          if (!profile || profile.enabled !== true) {
            throw serviceError("PLUGIN_BINDING_INVALID", "Agent 不可用于插件绑定");
          }
          const current = this.store.listBindingsForProfile(params.profileId).find((item) =>
            item.installationId === params.installationId
              && item.componentId === params.componentId);
          if ((current?.revision || 0) !== params.expectedRevision) {
            throw serviceError("REVISION_CONFLICT", "插件 Skill 绑定已变化");
          }
          const binding = current || this.store.createSkillBinding({
            bindingId: fingerprint("skill-binding", [params.profileId,
              params.installationId, params.componentId]),
            profileId: params.profileId, installationId: params.installationId,
            componentId: params.componentId });
          return this.store.setBindingEnabled({ bindingId: binding.bindingId,
            enabled: params.enabled, expectedRevision: binding.revision });
        } });
      return bounded({ binding: publicBinding(result.result),
        operation: publicOperation(result.operation) });
    }
    if (!plain(params, ["operationId"]) || typeof params.operationId !== "string"
      || !OPERATION_ID.test(params.operationId)) fail();
    const operation = this.store.getOperation(params.operationId);
    return bounded({ found: operation !== null, operation: publicOperation(operation) });
  }
}

module.exports = { PluginServiceController, PLUGIN_SERVICE_METHODS: METHODS };
