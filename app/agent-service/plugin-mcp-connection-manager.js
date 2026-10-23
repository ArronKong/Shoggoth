"use strict";

const crypto = require("node:crypto");
const { componentId } = require("./plugin-component-catalog");
const { PluginMcpLaunchPlanner } = require("./plugin-mcp-launch-planner");
const { OutlookCalendarGraphMcpClient } = require("./outlook-calendar-graph-mcp-client");
const { MicrosoftGraphFamilyMcpClient } = require("./plugin-microsoft-graph-mcp-client");
const { componentFor: graphComponentFor, isGraphSidecar,
  TRANSPORT: GRAPH_TRANSPORT, GRAPH_ENDPOINT_IDENTITY } =
  require("./plugin-microsoft-graph-sidecar");
const { serviceError } = require("./security");
const { SOURCE_IDENTITY: LOVABLE_SOURCE, COMPONENT_NAME: LOVABLE_COMPONENT,
  SERVER: LOVABLE_SERVER, isLovableReadOnlyTool } =
  require("./plugin-lovable-official-sidecar");
const { COMPONENT_NAME: HIGGSFIELD_COMPONENT, SERVER: HIGGSFIELD_SERVER } =
  require("./plugin-higgsfield-official-overlay");
const { ISSUER: HIGGSFIELD_ISSUER } = require("./plugin-higgsfield-official-oauth");
const { SOURCE_IDENTITY: SLACK_SOURCE } = require("./plugin-slack-official-sidecar");
const { LEGACY_COMPONENT, FULL_COMPONENT, PUBLIC_SCOPES, slackToolAccess } =
  require("./plugin-slack-access-policy");
const { SERVER: SLACK_SERVER, AUDIENCE: SLACK_AUDIENCE } = require("./plugin-slack-oauth");
const { assertReservedOfficialEndpoint, reservedEndpointKind } = require("./plugin-reserved-official-endpoints");
const { secretReference } = require("../core/plugin-secret-placeholders");
const { PluginMcpClient } = require("./plugin-mcp-client");
const { ENDPOINT: FIGMA_DESKTOP_ENDPOINT, isFigmaDesktopComponent,
  isFigmaDesktopTool } = require("../core/figma-desktop-mcp");
const { verifyFigmaDesktopListener } = require("./plugin-figma-desktop-listener");
const { SOURCE_IDENTITY: GMAIL_SOURCE, COMPONENT_NAME: GMAIL_COMPONENT,
  TRANSPORT: GMAIL_TRANSPORT, endpointIdentity: gmailEndpointIdentity } =
  require("./plugin-gogcli-gmail-sidecar");
const { EMAIL: GMAIL_EMAIL } = require("./plugin-gogcli-gmail-runtime");
const { SOURCE_IDENTITY: CLOUDFLARE_SOURCE, cloudflareToolAccess } =
  require("./plugin-cloudflare-access-policy");

const stdioScopeId = (componentId, connectionId, principalIdentity) => crypto.createHash("sha256")
  .update(JSON.stringify([componentId, connectionId, principalIdentity])).digest("hex");

// One Service-owned transport factory for management discovery and Run dispatch.
// Scope identity is stable across token refresh/reconnect, never a per-call UUID.
class PluginMcpConnectionManager {
  constructor({ store, resolver, pool, auth, allowLoopback = false,
    graphCalendar = null, authorizeEgress = null,
    lovableRegistration = null, lovableFetchImpl = globalThis.fetch,
    higgsfieldRegistration = null,
    slackRegistration = null, slackScopes = null, slackFetchImpl = globalThis.fetch,
    dropboxRegistration = null, figmaFetchImpl = globalThis.fetch,
    figmaVerifyListener = verifyFigmaDesktopListener, gmailRuntime = null, secrets = null } = {}) {
    this.store = store;
    this.secrets = secrets;
    this.resolver = resolver;
    this.pool = pool;
    this.auth = auth;
    this.allowLoopback = allowLoopback;
    this.graphCalendar = graphCalendar;
    this.authorizeEgress = authorizeEgress;
    this.lovableRegistration = lovableRegistration;
    this.lovableFetchImpl = lovableFetchImpl;
    this.higgsfieldRegistration = higgsfieldRegistration;
    this.slackRegistration = slackRegistration;
    this.slackScopes = slackScopes;
    this.slackFetchImpl = slackFetchImpl;
    this.dropboxRegistration = dropboxRegistration;
    this.figmaFetchImpl = figmaFetchImpl;
    this.figmaVerifyListener = figmaVerifyListener;
    this.gmailRuntime = gmailRuntime;
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

  async probeFigmaDesktop(input) {
    const current = this.component(input.installationId, input.componentId);
    if (!isFigmaDesktopComponent(current)) {
      throw serviceError("CONNECTION_AUTH_REQUIRED", "Figma 桌面 MCP 配置已变化");
    }
    if (await this.figmaVerifyListener() !== true) {
      throw serviceError("FIGMA_DESKTOP_IDENTITY_UNVERIFIED", "无法验证 Figma 桌面 MCP 监听进程身份");
    }
    // A prospective connection only initializes and lists tools. It cannot
    // call a tool, and it sends no token to the Desktop process.
    const client = await PluginMcpClient.connectHttp({
      url: FIGMA_DESKTOP_ENDPOINT, allowLoopback: true,
      fetchImpl: this.figmaFetchImpl,
      connectionId: "figma-desktop-probe", principalIdentity: "local:figma-desktop",
      authorizeEgress: () => { throw serviceError("CAPABILITY_FORBIDDEN", "探测不允许执行 MCP 工具"); },
      timeoutMs: 5_000,
    });
    try {
      const tools = await client.listTools();
      if (!tools.some(tool => tool.name === "get_design_context")) {
        throw serviceError("FIGMA_DESKTOP_TOOLS_UNAVAILABLE", "Figma 桌面 MCP 未提供设计读取工具");
      }
    } finally { await client.close(); }
  }

  // A user package's HTTP endpoint without a registered provider: no OAuth or
  // bearer vault, only its declared headers and `${secret:NAME}` values.
  selfContainedHttp({ installation, component }) {
    return component.transport === "streamable-http" && component.oauthResource === null
      && !installation.sourceIdentity.startsWith("bundled:")
      && reservedEndpointKind(component.spec.url) === null;
  }

  async #resolveSecret(installationId, name) {
    const value = this.secrets ? await this.secrets.read(installationId, name) : null;
    if (typeof value !== "string" || !value) {
      throw serviceError("PLUGIN_SECRET_REQUIRED", `插件凭据 ${name} 尚未配置`);
    }
    return value;
  }

  async #secretEnv(installationId, declared) {
    if (!declared?.length) return null;
    const result = {};
    for (const { key, name } of declared) result[key] = await this.#resolveSecret(installationId, name);
    return result;
  }

  // Clearing a `${secret:NAME}` closes the process or client that received the
  // old value. Unlike disconnect, the Connection stays usable for a new value.
  async releaseSecretHolder({ installationId, componentId, connectionId }) {
    const live = this.store.getConnection(connectionId);
    if (!live || live.installationId !== installationId || live.componentId !== componentId) return;
    await this.pool.drainScope({ installationId,
      scopeId: stdioScopeId(componentId, connectionId, live.principalIdentity) });
    await this.pool.drainHttp({ installationId, componentId, connectionId, executionScope: connectionId });
  }

  async #declaredHeaders(installationId, headers) {
    if (!headers || !Object.keys(headers).length) return null;
    const result = {};
    for (const [key, value] of Object.entries(headers)) {
      const reference = secretReference(value, { allowBearer: true });
      result[key] = reference
        ? `${reference.prefix}${await this.#resolveSecret(installationId, reference.name)}` : value;
    }
    return result;
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
    if (current.component.transport === GRAPH_TRANSPORT) {
      const packageId = installation.sourceIdentity.startsWith("bundled:")
        ? installation.sourceIdentity.slice("bundled:".length) : null;
      if (!isGraphSidecar(packageId)
        || current.component.name !== graphComponentFor(packageId)
        || JSON.stringify(current.component.spec) !== JSON.stringify({ type: GRAPH_TRANSPORT })
        || live.endpointIdentity !== GRAPH_ENDPOINT_IDENTITY(current.component.descriptorDigest)
        || !/^microsoft-graph:[a-f0-9]{64}$/u.test(live.principalIdentity)
        || !this.graphCalendar || typeof this.authorizeEgress !== "function") {
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "Graph 插件连接合同已变化");
      }
      const assertCurrent = () => {
        const latest = this.store.getConnection(live.connectionId);
        const installed = this.store.getInstallation(installation.installationId);
        const bound = this.store.getBinding(binding.bindingId);
        if (JSON.stringify(latest) !== JSON.stringify(live)
          || installed?.desiredState !== "enabled"
          || installed.releaseDigest !== current.installation.releaseDigest
          || bound?.enabled !== true || bound.connectionId !== live.connectionId
          || bound.revision !== binding.revision
          || this.store.hasPendingInstallationDisable(installation.installationId)) {
          throw serviceError("CONNECTION_IDENTITY_CHANGED", "Graph 连接或绑定已变化");
        }
      };
      await this.graphCalendar.activatePluginAccount({
        principalIdentity: live.principalIdentity, assertCurrent, packageId });
      const Client = packageId === "outlook-calendar"
        ? OutlookCalendarGraphMcpClient : MicrosoftGraphFamilyMcpClient;
      return validate(new Client({ calendar: this.graphCalendar,
        broker: this.graphCalendar, packageId,
        authorizeEgress: this.authorizeEgress, connectionId: live.connectionId,
        principalIdentity: live.principalIdentity, assertCurrent }));
    }
    if (current.component.transport === GMAIL_TRANSPORT) {
      const email = live.principalIdentity?.startsWith("gmail:")
        ? live.principalIdentity.slice("gmail:".length) : null;
      if (installation.sourceIdentity !== GMAIL_SOURCE
        || current.component.name !== GMAIL_COMPONENT
        || JSON.stringify(current.component.spec) !== JSON.stringify({ type: GMAIL_TRANSPORT })
        || live.endpointIdentity !== gmailEndpointIdentity(current.component.descriptorDigest)
        || !email || !GMAIL_EMAIL.test(email) || !this.gmailRuntime?.configured()) {
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "Gmail 连接合同或账号已变化");
      }
      const policy = this.gmailRuntime.capabilities();
      const allowed = this.gmailRuntime.allowedTools();
      const assertPolicy = () => {
        if (this.gmailRuntime.capabilities().revision !== policy.revision
          || !this.gmailRuntime.configured()) {
          throw serviceError("CONNECTION_IDENTITY_CHANGED", "Gmail 本机权限已变化");
        }
      };
      const scopeId = crypto.createHash("sha256").update(JSON.stringify([
        binding.componentId, live.connectionId, live.principalIdentity,
      ])).digest("hex");
      const handle = await this.pool.acquireStdio({ ...common, scopeId,
        ...this.gmailRuntime.launch(email) });
      return validate(Object.freeze({
        getProtocol: () => handle.getProtocol(),
        listTools: async () => {
          assertPolicy();
          const tools = await handle.listTools();
          assertPolicy();
          return tools.filter(tool => allowed.has(tool.name));
        },
        readAppResource: () => { throw serviceError("MCP_APP_UNSUPPORTED", "Gmail 连接不提供交互式 App 资源"); },
        callTool: (name, args, authority, options) => {
          assertPolicy();
          if (!allowed.has(name)) throw serviceError("CAPABILITY_FORBIDDEN", "Gmail 工具未在本机权限清单内");
          return handle.callTool(name, args, authority, options);
        },
        release: () => handle.release(),
      }));
    }
    if (current.component.transport === "stdio") {
      if (live.endpointIdentity !== `stdio:${current.component.descriptorDigest}`) {
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "本地 MCP 启动合同已变化");
      }
      const scopeId = stdioScopeId(binding.componentId, live.connectionId, live.principalIdentity);
      const plan = this.planner.planStdio(current.input);
      return validate(await this.pool.acquireStdio({ ...common, scopeId, ...plan,
        secretEnv: await this.#secretEnv(installation.installationId, plan.secretEnvRefs) }));
    }
    if (this.selfContainedHttp(current)
      && this.store.getConnectionAuth?.(live.connectionId)?.credentialRef === null) {
      const endpoint = current.component.spec.url;
      if (new URL(endpoint).href !== live.endpointIdentity) {
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "MCP 端点已变化");
      }
      const headers = current.component.spec.headers || {};
      return validate(await this.pool.acquireHttp({ ...common, url: endpoint,
        staticHeaders: await this.#declaredHeaders(installation.installationId, headers),
        secretHeaders: Object.values(headers).some(value => secretReference(value, { allowBearer: true }) !== null),
        allowLoopback: this.allowLoopback }));
    }
    const url = current.component.spec.url;
    if (new URL(url).href !== live.endpointIdentity) {
      throw serviceError("CONNECTION_IDENTITY_CHANGED", "MCP 端点已变化");
    }
    if (isFigmaDesktopComponent(current)) {
      if (live.principalIdentity !== `local:${process.getuid?.() ?? "user"}`
        || url !== FIGMA_DESKTOP_ENDPOINT) {
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "Figma 桌面 MCP 连接身份已变化");
      }
      if (await this.figmaVerifyListener() !== true) {
        throw serviceError("FIGMA_DESKTOP_IDENTITY_UNVERIFIED", "无法验证 Figma 桌面 MCP 监听进程身份");
      }
      const handle = await this.pool.acquireHttp({ ...common, url,
        credentialProvider: null, allowLoopback: true,
        fetchImpl: this.figmaFetchImpl });
      return validate(Object.freeze({
        getProtocol: () => handle.getProtocol(),
        listTools: async () => (await handle.listTools()).filter(tool => isFigmaDesktopTool(tool.name)),
        readAppResource: () => { throw serviceError("MCP_APP_UNSUPPORTED", "Figma 桌面 MCP 没有交互式 App 资源"); },
        callTool: (name, args, authority, options) => {
          if (!isFigmaDesktopTool(name)) {
            throw serviceError("CAPABILITY_FORBIDDEN", "Figma 桌面 MCP 工具不在本地支持清单内");
          }
          return handle.callTool(name, args, authority, options);
        },
        release: () => handle.release(),
      }));
    }
    const official = assertReservedOfficialEndpoint({
      sourceIdentity: installation.sourceIdentity, componentName: current.component.name,
      serverUrl: url, oauthResource: current.component.oauthResource });
    const lovable = official === "lovable";
    const higgsfield = official === "higgsfield";
    const slack = official === "slack";
    const dropbox = official === "dropbox";
    if (lovable && (current.component.name !== LOVABLE_COMPONENT
      || url !== LOVABLE_SERVER || current.component.oauthResource !== LOVABLE_SERVER)) {
      throw serviceError("CONNECTION_IDENTITY_CHANGED", "Lovable 官方 MCP 侧车合同已变化");
    }
    if (higgsfield && (current.component.name !== HIGGSFIELD_COMPONENT
      || url !== HIGGSFIELD_SERVER || current.component.oauthResource !== HIGGSFIELD_SERVER)) {
      throw serviceError("CONNECTION_IDENTITY_CHANGED", "Higgsfield 官方 MCP 来源或资源合同已变化");
    }
    if (slack && (![LEGACY_COMPONENT, FULL_COMPONENT].includes(current.component.name)
      || url !== SLACK_SERVER || current.component.oauthResource !== SLACK_AUDIENCE)) {
      throw serviceError("CONNECTION_IDENTITY_CHANGED", "Slack 官方 MCP 侧车合同已变化");
    }
    const assertRegistration = () => {
      if (lovable && (typeof this.lovableRegistration !== "function"
        || this.lovableRegistration(live.principalIdentity) !== true)) {
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "Lovable 客户端登记已变化");
      }
      if (higgsfield && (typeof this.higgsfieldRegistration !== "function"
        || this.higgsfieldRegistration(live.principalIdentity) !== true)) {
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "Higgsfield 客户端登记已变化");
      }
      if (slack && (typeof this.slackRegistration !== "function"
        || this.slackRegistration(live.principalIdentity) !== true)) {
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "Slack 客户端登记已变化");
      }
      if (dropbox && (typeof this.dropboxRegistration !== "function"
        || this.dropboxRegistration(live.principalIdentity) !== true)) {
        throw serviceError("CONNECTION_IDENTITY_CHANGED", "Dropbox 客户端登记已变化");
      }
    };
    assertRegistration();
    const providerKey = JSON.stringify([live.connectionId, live.authRevision,
      live.principalIdentity, live.endpointIdentity, current.component.oauthResource]);
    let credentialProvider = this.providers.get(providerKey);
    if (!credentialProvider) {
      const baseProvider = this.auth.credentialProvider({ ...live,
        audience: current.component.oauthResource,
        ...(higgsfield ? { issuer: HIGGSFIELD_ISSUER } : {}) });
      if (lovable || higgsfield || slack || dropbox) {
        const assertCurrent = () => { assertRegistration(); baseProvider.assertCurrent(); };
        credentialProvider = async () => {
          assertCurrent();
          const credential = await baseProvider();
          assertCurrent();
          return credential;
        };
        credentialProvider.assertCurrent = assertCurrent;
      } else credentialProvider = baseProvider;
      for (const key of this.providers.keys()) {
        if (JSON.parse(key)[0] === live.connectionId) this.providers.delete(key);
      }
      if (this.providers.size >= 128) this.providers.clear();
      this.providers.set(providerKey, credentialProvider);
    }
    const handle = await this.pool.acquireHttp({ ...common, url, credentialProvider,
      allowLoopback: this.allowLoopback,
      ...(lovable ? { fetchImpl: this.lovableFetchImpl }
        : slack ? { fetchImpl: this.slackFetchImpl } : {}) });
    if (higgsfield) {
      // tools/list is the only permitted remote MCP probe until the provider's
      // generation contracts and paid side effects have been accepted.
      return validate(Object.freeze({
        getProtocol: () => handle.getProtocol(),
        listTools: async () => {
          assertRegistration();
          await handle.listTools();
          assertRegistration();
          return [];
        },
        readAppResource: () => { throw serviceError("CAPABILITY_FORBIDDEN", "Higgsfield 工具尚未验收"); },
        callTool: () => { throw serviceError("CAPABILITY_FORBIDDEN", "Higgsfield 工具尚未验收"); },
        release: () => handle.release(),
      }));
    }
    if (installation.sourceIdentity === CLOUDFLARE_SOURCE) {
      const allowedTool = name => cloudflareToolAccess({ installation, connection: live }, name).allowed;
      return validate(Object.freeze({
        getProtocol: () => handle.getProtocol(),
        listTools: async () => (await handle.listTools()).filter(tool => allowedTool(tool.name)),
        readAppResource: input => {
          if (!allowedTool(input?.toolName)) {
            throw serviceError("CAPABILITY_FORBIDDEN", "Cloudflare 工具未在已核对清单内");
          }
          return handle.readAppResource(input);
        },
        callTool: (name, args, authority, options) => {
          if (!allowedTool(name)) {
            throw serviceError("CAPABILITY_FORBIDDEN", "Cloudflare 工具未在已核对清单内");
          }
          return handle.callTool(name, args, authority, options);
        },
        release: () => handle.release(),
      }));
    }
    if (!lovable && !slack) return validate(handle);
    // Only tools covered by the live Service-owned scopes and local reviewed
    // names can be discovered or called. Remote annotations cannot broaden it.
    const allowedTool = lovable ? isLovableReadOnlyTool : name => {
      assertRegistration();
      const scopes = typeof this.slackScopes === "function"
        ? this.slackScopes(live.principalIdentity)
        : current.component.name === LEGACY_COMPONENT ? PUBLIC_SCOPES : null;
      return slackToolAccess({ componentName: current.component.name, scopes, toolName: name }).allowed;
    };
    return validate(Object.freeze({
      getProtocol: () => handle.getProtocol(),
      listTools: async () => {
        assertRegistration();
        const tools = await handle.listTools();
        assertRegistration();
        return tools.filter(tool => allowedTool(tool.name));
      },
      readAppResource: input => {
        assertRegistration();
        if (!allowedTool(input?.toolName)) {
          throw serviceError("CAPABILITY_FORBIDDEN", "工具未在当前登记权限和核对清单内");
        }
        return handle.readAppResource(input);
      },
      callTool: (name, args, authority, options) => {
        assertRegistration();
        if (!allowedTool(name)) {
          throw serviceError("CAPABILITY_FORBIDDEN", "工具未在当前登记权限和核对清单内");
        }
        return handle.callTool(name, args, authority, options);
      },
      release: () => handle.release(),
    }));
  }

  clear() { this.providers.clear(); }
}

module.exports = { PluginMcpConnectionManager };
