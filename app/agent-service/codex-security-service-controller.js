"use strict";

const crypto = require("node:crypto");
const { CodexSecurityServicePreflight } = require("./codex-security-service-preflight");
const { WorkRunCoordinator } = require("./work-run-coordinator");
const { agentRuntimeProfileViews } = require("./agent-runtime-profile-views");
const { validateRuntimeAccount } = require("./runtime-account");
const { componentId } = require("./plugin-component-catalog");
const { serviceError } = require("./security");

const SOURCE = "bundled:codex-security";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const METHOD = "plugins.codex-security.status";
const PUBLIC_MESSAGES = Object.freeze({
  CODEX_SECURITY_SERVICE_INVALID: "Codex Security 状态参数无效",
  CODEX_SECURITY_SERVICE_CLOSED: "Codex Security 前置检查尚未就绪",
  CODEX_SECURITY_SERVICE_UNAVAILABLE: "Codex Security 前置检查暂不可用",
  CODEX_SECURITY_SERVICE_SOURCE_CHANGED: "Codex Security 安装或公共连接已变化，请重新检查",
});
const fail = (code, message) => { throw serviceError(`CODEX_SECURITY_SERVICE_${code}`, message); };
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable === true && Object.hasOwn(field, "value");
  });
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const validOptionalId = value => value === null || (typeof value === "string" && ID.test(value));

// This is a Service-only qualification controller. Its IPC projection never
// acquires a Run lease or creates a thread. Native turn/scan/tools remain absent.
class CodexSecurityServiceController {
  #opened = false;
  #generation = 0;
  #coordinator = null;

  constructor({ preflight, getCoordinator } = {}) {
    if (!(preflight instanceof CodexSecurityServicePreflight) || typeof getCoordinator !== "function") {
      throw new TypeError("Codex Security Service requires its real preflight");
    }
    this.preflight = preflight;
    this.getCoordinator = getCoordinator;
  }

  open() {
    const coordinator = this.getCoordinator();
    if (!(coordinator instanceof WorkRunCoordinator)
      || coordinator.hostCapabilityIssuer !== this.preflight.capabilityIssuer
      || coordinator.dispatcher !== this.preflight.dispatcher
      || coordinator.productStore !== this.preflight.productStore
      || coordinator.runtimeAccountAdmission !== this.preflight.runtimeAccountAdmission
      || coordinator.state !== "open") {
      fail("UNAVAILABLE", "前置检查缺少当前 Service 的真实 WorkRun authority");
    }
    if (this.#opened && this.#coordinator === coordinator) return this;
    if (this.#opened) fail("UNAVAILABLE", "Service coordinator 已变化");
    this.#coordinator = coordinator; this.#generation += 1; this.#opened = true;
    return this;
  }

  close() {
    this.#opened = false; this.#generation += 1; this.#coordinator = null;
  }

  async status(input) {
    if (!exact(input, ["installationId", "runtimeProfileId"])
      || !validOptionalId(input.installationId) || !validOptionalId(input.runtimeProfileId)) {
      fail("INVALID", "只读状态仅接受安装 ID 和候选 Runtime profile ID");
    }
    const request = Object.freeze({ ...input });
    const generation = this.#generation;
    this.#assertCurrent(generation);
    const metadata = this.#metadata(request.installationId);
    const candidate = this.#candidate(request.runtimeProfileId);
    let authentication = { status: "unobserved", source: "AccountAuthManager.readForProfile -> canonical RuntimeAccount account/read", loginState: null };
    if (candidate) {
      const observation = await this.preflight.accountAuthManager.readForProfile({ runtimeProfileId: candidate.runtimeProfileId });
      if (typeof observation?.requiresOpenaiAuth !== "boolean"
        || (observation.account !== null && (!observation.account || typeof observation.account !== "object" || Array.isArray(observation.account)))) {
        fail("UNAVAILABLE", "Runtime account/read 回应无效");
      }
      authentication = { ...authentication, status: observation.account !== null || observation.requiresOpenaiAuth === false
        ? "authenticated" : "unauthenticated", loginState: observation.login?.status || null };
    }
    this.#assertCurrent(generation);
    if (hash(metadata) !== hash(this.#metadata(request.installationId)) || hash(candidate) !== hash(this.#candidate(request.runtimeProfileId))) {
      fail("SOURCE_CHANGED", "读取期间安装、公共连接或候选账号 binding 已变化");
    }
    const blockers = [];
    if (!metadata.installation || metadata.installation.desiredState !== "enabled" || metadata.installation.pendingDisable) blockers.push("INSTALLED_ENABLED_RELEASE_REQUIRED");
    if (metadata.bundle.converted.mcp !== metadata.bundle.components.mcp) blockers.push("ORIGINAL_MCP_NOT_CONVERTED");
    if (!metadata.installedComponents?.mcpServerNames.includes("codex-security")) blockers.push("INSTALLED_NATIVE_MCP_COMPONENT_MISSING");
    if (!metadata.sharedBindings.some(binding => binding.enabled)) blockers.push("SHARED_MCP_BINDING_MISSING");
    if (!metadata.sharedBindings.some(binding => binding.enabled && binding.connection.state === "ready")) blockers.push("SHARED_MCP_CONNECTION_NOT_READY");
    if (authentication.status === "unobserved") blockers.push("CODEX_ACCOUNT_AUTH_NOT_OBSERVED");
    else if (authentication.status !== "authenticated") blockers.push("CODEX_ACCOUNT_NOT_AUTHENTICATED");
    blockers.push("OWNING_RUN_AUTHORITY_NOT_OBSERVED", "OWNING_NATIVE_TURN_ADAPTER_REQUIRED", "FULL_SCAN_ACCEPTANCE_UNVERIFIED", "REDISTRIBUTION_APPROVAL_PENDING");
    return freeze({ version: 1, qualificationScope: "installation-and-account", ...structuredClone(metadata),
      candidate: candidate ? { ...candidate, accountGeneration: candidate.accountGeneration } : null,
      authentication, owningRunQualified: false, lifecycleReady: false,
      lifecycleBlockers: ["OWNING_RUN_AUTHORITY_NOT_OBSERVED"], fullPluginUsable: false, fullPluginBlockers: blockers,
      modelTurnStarted: false, scanStarted: false, originalToolsUnlocked: false });
  }

  // No RPC forwards this method. Only trusted Service code may name its actual
  // admitted execution; the coordinator supplies the current branded lease.
  async inspectOwningRun(input) {
    if (!exact(input, ["runId", "runtimeProfileId", "runtimeAccountId", "installationId", "owningBindingId"])
      || ![input.runId, input.runtimeProfileId, input.runtimeAccountId, input.owningBindingId]
        .every(value => typeof value === "string" && ID.test(value)) || !validOptionalId(input.installationId)) {
      fail("INVALID", "内部前置检查参数无效");
    }
    const request = Object.freeze({ ...input }), generation = this.#generation;
    const coordinator = this.#assertCurrent(generation);
    return coordinator.withCurrentRuntimeCapabilityLease({ runId: request.runId,
      runtimeProfileId: request.runtimeProfileId, runtimeAccountId: request.runtimeAccountId }, async ({ lease, assertCurrent }) => {
      assertCurrent(); this.#assertCurrent(generation);
      const qualification = await this.preflight.inspect({ installationId: request.installationId,
        owningBindingId: request.owningBindingId }, lease);
      assertCurrent(); this.#assertCurrent(generation);
      return Object.freeze({ ...qualification, qualificationScope: "owning-run", owningRunQualified: true });
    });
  }

  #assertCurrent(generation) {
    if (!this.#opened || generation !== this.#generation || this.getCoordinator() !== this.#coordinator
      || this.#coordinator?.state !== "open") fail("CLOSED", "前置检查的 Service 生命周期已变化");
    return this.#coordinator;
  }

  #candidate(runtimeProfileId) {
    if (runtimeProfileId === null) return null;
    const matches = agentRuntimeProfileViews(this.preflight.productStore).filter(view => view.runtimeProfileId === runtimeProfileId);
    if (matches.length !== 1 || matches[0].enabled !== true || matches[0].runtime !== "codex") fail("INVALID", "候选 profile 必须是唯一且启用的真实 Codex binding");
    const profile = matches[0], account = validateRuntimeAccount(this.preflight.productStore.getRuntimeAccount(profile.runtimeAccountId));
    if (account.runtime !== "codex" || account.kind !== "shoggoth-managed") fail("INVALID", "候选账号必须是实际受管 Codex account");
    return { profileId: profile.id, runtimeProfileId, runtimeAccountId: account.id, runtimeAccountKind: account.kind,
      accountGeneration: this.preflight.runtimeAccountAdmission.read(account.id).generation };
  }

  #nativeComponent(release, installation) {
    const descriptor = release.components.mcpServers.find(server => server.name === "codex-security"
      && server.type === "shoggoth-codex-security-native");
    if (!descriptor) return {};
    const server = this.preflight.resolver.inspectMcpDependency({ installationId: installation.installationId,
      releaseDigest: installation.releaseDigest,
      componentId: componentId(installation.installationId, "mcp-server", "codex-security"),
      descriptorDigest: descriptor.descriptorDigest });
    return { nativeComponent: { transport: server.transport, descriptorDigest: server.descriptorDigest,
      sourceDigest: server.spec.sourceDigest, originalFileCount: 124 } };
  }

  #metadata(installationId) {
    const { store, resolver, bundledCatalog } = this.preflight;
    const bundle = bundledCatalog.assertCurrent("codex-security");
    const installation = installationId === null ? store.getBySource(SOURCE) : store.getInstallation(installationId);
    if (installation && installation.sourceIdentity !== SOURCE) fail("INVALID", "安装记录不是固定内置 Codex Security 来源");
    let release = null;
    if (installation && installation.desiredState !== "uninstalled") {
      resolver.verifyInstallation(installation.installationId);
      release = store.getRelease(installation.sourceIdentity, installation.releaseDigest);
      if (!release || release.sourceIdentity !== SOURCE || release.contentDigest !== installation.releaseDigest
        || release.name !== "codex-security" || release.declaredVersion !== bundle.version) fail("SOURCE_CHANGED", "实际 installed release 与固定来源不符");
    }
    const sharedBindings = [];
    for (const binding of store.listGlobalBindings().filter(item => item.installationId === installation?.installationId && item.componentKind === "mcp-server")) {
      const serverName = release?.components.mcpServers.map(server => server.name).find(name => componentId(installation.installationId, "mcp-server", name) === binding.componentId);
      if (!serverName) fail("SOURCE_CHANGED", "公共 binding 不属于当前 installed release");
      const connection = store.getConnection(binding.connectionId);
      if (connection && (connection.installationId !== installation.installationId || connection.componentId !== binding.componentId)) fail("SOURCE_CHANGED", "公共 connection 不属于当前安装组件");
      sharedBindings.push({ bindingId: binding.bindingId, revision: binding.revision, enabled: binding.enabled,
        componentId: binding.componentId, serverName, connection: { connectionId: binding.connectionId,
          state: connection?.state || "missing", authRevision: connection?.authRevision ?? null, principalPresent: !!connection?.principalIdentity } });
    }
    return { sourceIdentity: SOURCE, bundle: { version: bundle.version, sourceDigest: bundle.sourceDigest,
      fileCount: bundle.fileCount, license: bundle.license, components: bundle.components, converted: bundle.converted,
      unconvertedMcp: bundle.unconvertedMcp }, installation: installation ? { installationId: installation.installationId,
      revision: installation.revision, releaseDigest: installation.releaseDigest, desiredState: installation.desiredState,
      pendingDisable: store.hasPendingInstallationDisable(installation.installationId) } : null,
      installedComponents: release ? { skillCount: release.components.skills.length,
        mcpServerNames: release.components.mcpServers.map(server => server.name),
        diagnosticCodes: [...new Set(release.diagnostics.map(item => item.reasonCode))].sort(),
        ...this.#nativeComponent(release, installation) } : null,
      sharedBindings: sharedBindings.sort((a, b) => a.bindingId.localeCompare(b.bindingId)) };
  }
}

// The production factory always constructs the actual preflight from Service
// authorities. There is no caller readiness/lease or fixture-fallback option.
function createCodexSecurityServiceController({ getCoordinator, ...authorities } = {}) {
  if (Object.hasOwn(authorities, "preflight")) throw new TypeError("Production Codex Security factory owns its preflight");
  return new CodexSecurityServiceController({ preflight: new CodexSecurityServicePreflight(authorities), getCoordinator });
}

module.exports = { CodexSecurityServiceController, createCodexSecurityServiceController,
  CODEX_SECURITY_STATUS_METHOD: METHOD, CODEX_SECURITY_PUBLIC_MESSAGES: PUBLIC_MESSAGES };
