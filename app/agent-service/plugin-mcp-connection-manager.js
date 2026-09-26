"use strict";

const crypto = require("node:crypto");
const { componentId } = require("./plugin-component-catalog");
const { PluginMcpLaunchPlanner } = require("./plugin-mcp-launch-planner");
const { serviceError } = require("./security");

// One Service-owned transport factory for management discovery and Run dispatch.
// Scope identity is stable across token refresh/reconnect, never a per-call UUID.
class PluginMcpConnectionManager {
  constructor({ store, resolver, pool, auth, allowLoopback = false } = {}) {
    this.store = store;
    this.resolver = resolver;
    this.pool = pool;
    this.auth = auth;
    this.allowLoopback = allowLoopback;
    this.planner = new PluginMcpLaunchPlanner({ store, resolver });
    this.providers = new Map();
  }

  component(installationId, selectedId) {
    const installation = this.store.getInstallation(installationId);
    if (installation?.desiredState !== "enabled"
      || this.store.hasPendingInstallationDisable(installationId)) {
      throw serviceError("PLUGIN_COMPONENT_INACTIVE", "插件安装未启用");
    }
    const release = this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
    const descriptor = release.components.mcpServers.find(item =>
      componentId(installationId, "mcp-server", item.name) === selectedId);
    if (!descriptor) throw serviceError("PLUGIN_COMPONENT_NOT_FOUND", "MCP 组件不存在");
    const input = { installationId, componentId: selectedId,
      releaseDigest: installation.releaseDigest, descriptorDigest: descriptor.descriptorDigest };
    return { installation, release, input, component: this.resolver.inspectMcpServer(input) };
  }

  async acquire({ installation, binding, connection }) {
    const current = this.component(installation.installationId, binding.componentId);
    const live = this.store.getConnection(connection.connectionId);
    if (current.installation.releaseDigest !== installation.releaseDigest
      || !live || live.state !== "ready" || live.authRevision !== connection.authRevision
      || live.principalIdentity !== connection.principalIdentity
      || live.endpointIdentity !== connection.endpointIdentity
      || live.installationId !== installation.installationId
      || live.componentId !== binding.componentId || binding.connectionId !== live.connectionId) {
      throw serviceError("CONNECTION_IDENTITY_CHANGED", "插件连接身份已变化");
    }
    const common = { installationId: installation.installationId,
      releaseDigest: installation.releaseDigest, componentId: binding.componentId,
      connectionId: live.connectionId, principalIdentity: live.principalIdentity,
      authRevision: live.authRevision, executionScope: live.connectionId, appSupport: true };
    const validate = async handle => {
      const latest = this.store.getConnection(connection.connectionId);
      const installed = this.store.getInstallation(installation.installationId);
      const bound = this.store.getBinding(binding.bindingId);
      if (JSON.stringify(latest) !== JSON.stringify(live)
        || installed?.desiredState !== "enabled" || installed.revision !== current.installation.revision
        || bound?.revision !== binding.revision || bound?.enabled !== true
        || this.store.hasPendingInstallationDisable(installation.installationId)) {
        await handle.release();
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "连接等待期间授权已变化");
      }
      return handle;
    };
    if (current.component.transport === "stdio") {
      if (live.endpointIdentity !== `stdio:${current.component.descriptorDigest}`) {
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "本地 MCP 启动合同已变化");
      }
      const scopeId = crypto.createHash("sha256").update(JSON.stringify([
        binding.componentId, live.connectionId, live.principalIdentity,
      ])).digest("hex");
      return validate(await this.pool.acquireStdio({ ...common, scopeId,
        ...this.planner.planStdio(current.input) }));
    }
    const url = current.component.spec.url;
    if (new URL(url).href !== live.endpointIdentity) {
      throw serviceError("CONNECTION_IDENTITY_CHANGED", "MCP 端点已变化");
    }
    const providerKey = JSON.stringify([live.connectionId, live.authRevision,
      live.principalIdentity, live.endpointIdentity]);
    let credentialProvider = this.providers.get(providerKey);
    if (!credentialProvider) {
      credentialProvider = this.auth.credentialProvider(live);
      for (const key of this.providers.keys()) {
        if (JSON.parse(key)[0] === live.connectionId) this.providers.delete(key);
      }
      if (this.providers.size >= 128) this.providers.clear();
      this.providers.set(providerKey, credentialProvider);
    }
    return validate(await this.pool.acquireHttp({ ...common, url, credentialProvider,
      allowLoopback: this.allowLoopback }));
  }

  clear() { this.providers.clear(); }
}

module.exports = { PluginMcpConnectionManager };
