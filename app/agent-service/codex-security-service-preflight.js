"use strict";

const crypto = require("node:crypto");
const { BundledPluginCatalog } = require("../core/bundled-plugin-catalog");
const { PluginStore } = require("./plugin-store");
const { PluginComponentResolver } = require("./plugin-component-resolver");
const { HostCapabilityIssuer } = require("./host-capability-issuer");
const { RuntimeAccountAdmission } = require("./runtime-account-admission");
const { AccountAuthManager } = require("./account-auth-manager");
const { validateRuntimeAccount } = require("./runtime-account");
const { runtimeBinding } = require("./runtime-adapter");
const { componentId } = require("./plugin-component-catalog");
const { ACTIVE_WORK_RUN_STATUSES, canonicalWorkspace } = require("./work-run");
const { serviceError } = require("./security");

const SOURCE_IDENTITY = "bundled:codex-security";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message) => { throw serviceError(`CODEX_SECURITY_PREFLIGHT_${code}`, message); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable === true && Object.hasOwn(field, "value");
  });
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// Read-only Service preflight. Installation, shared MCP Connection and model
// authentication are three distinct sources. None proves a working scanner.
class CodexSecurityServicePreflight {
  #admissions = new WeakMap();
  #active = new Map();

  constructor({ store, resolver, bundledCatalog, productStore, dispatcher,
    capabilityIssuer, runtimeAccountAdmission, accountAuthManager } = {}) {
    if (!(store instanceof PluginStore) || !(resolver instanceof PluginComponentResolver)
      || resolver.store !== store || !(bundledCatalog instanceof BundledPluginCatalog)
      || typeof productStore?.getRuntimeAccount !== "function"
      || typeof productStore?.resolveAgentRuntimeProfile !== "function"
      || typeof dispatcher?.getRun !== "function"
      || !(capabilityIssuer instanceof HostCapabilityIssuer)
      || !(runtimeAccountAdmission instanceof RuntimeAccountAdmission)
      || !(accountAuthManager instanceof AccountAuthManager)) {
      throw new TypeError("Codex Security preflight requires trusted Service authorities");
    }
    this.store = store; this.resolver = resolver; this.bundledCatalog = bundledCatalog;
    this.productStore = productStore; this.dispatcher = dispatcher; this.capabilityIssuer = capabilityIssuer;
    this.runtimeAccountAdmission = runtimeAccountAdmission; this.accountAuthManager = accountAuthManager;
  }

  async inspect(input, lease) {
    if (!exact(input, ["installationId", "owningBindingId"])
      || (input.installationId !== null && (typeof input.installationId !== "string" || !ID.test(input.installationId)))
      || typeof input.owningBindingId !== "string" || !ID.test(input.owningBindingId)) {
      fail("INVALID", "前置检查只接受安装 ID 和 owning Agent 的 binding ID");
    }
    const request = Object.freeze({ ...input });
    const owner = this.#owner(lease);
    const target = this.productStore.resolveAgentRuntimeProfile(owner.profileId, request.owningBindingId);
    const targetBinding = runtimeBinding({ runtime: target.runtime, runtimeProfileId: target.runtimeProfileId,
      runtimeAccountId: target.runtimeAccountId });
    const account = validateRuntimeAccount(this.productStore.getRuntimeAccount(target.runtimeAccountId));
    const generation = this.#generation(lease, targetBinding);
    const before = this.#metadata(request.installationId);
    const lifecycleBlockers = [];
    if (!before.installation || before.installation.desiredState !== "enabled" || before.installation.pendingDisable) lifecycleBlockers.push("INSTALLED_ENABLED_RELEASE_REQUIRED");
    if (target.runtime !== "codex" || account.runtime !== "codex" || account.kind !== "shoggoth-managed"
      || target.runtimeProfileId === owner.runtimeProfileId) lifecycleBlockers.push("DISTINCT_MANAGED_CODEX_BINDING_REQUIRED");
    let authentication = { status: "unobserved", source: "AccountAuthManager.readForProfile -> canonical RuntimeAccount account/read", loginState: null };
    if (!lifecycleBlockers.length) {
      // Resolve the owning profile's actual account through AccountAuthManager.
      // Its canonical shared auth host is not proof of an authenticated owning turn.
      const observation = await this.accountAuthManager.readForProfile({ runtimeProfileId: target.runtimeProfileId });
      if (typeof observation?.requiresOpenaiAuth !== "boolean"
        || (observation.account !== null && (!observation.account || typeof observation.account !== "object"))) {
        fail("AUTH_RESPONSE_INVALID", "账号只读回应无效");
      }
      authentication = { status: observation.account !== null || observation.requiresOpenaiAuth === false
        ? "authenticated" : "unauthenticated", source: authentication.source, loginState: observation.login?.status || null };
      if (authentication.status !== "unauthenticated") lifecycleBlockers.push("CREDENTIALLESS_LIFECYCLE_REQUIRED");
    }
    this.#assertSnapshot({ request, owner, targetBinding, generation, metadataDigest: hash(before) }, lease);
    const fullPluginBlockers = [];
    if (!before.installation || before.installation.desiredState !== "enabled" || before.installation.pendingDisable) fullPluginBlockers.push("INSTALLED_ENABLED_RELEASE_REQUIRED");
    if (before.bundle.converted.mcp !== before.bundle.components.mcp) fullPluginBlockers.push("ORIGINAL_MCP_NOT_CONVERTED");
    if (!before.installedComponents?.mcpServerNames.includes("codex-security")) fullPluginBlockers.push("INSTALLED_NATIVE_MCP_COMPONENT_MISSING");
    if (!before.sharedBindings.some(binding => binding.enabled)) fullPluginBlockers.push("SHARED_MCP_BINDING_MISSING");
    if (!before.sharedBindings.some(binding => binding.enabled && binding.connection.state === "ready")) fullPluginBlockers.push("SHARED_MCP_CONNECTION_NOT_READY");
    if (authentication.status !== "authenticated") fullPluginBlockers.push("CODEX_ACCOUNT_NOT_AUTHENTICATED");
    fullPluginBlockers.push("OWNING_NATIVE_TURN_ADAPTER_REQUIRED", "FULL_SCAN_ACCEPTANCE_UNVERIFIED", "REDISTRIBUTION_APPROVAL_PENDING");
    let lifecycleAdmission = null;
    if (!lifecycleBlockers.length) {
      lifecycleAdmission = Object.freeze({ version: 1, kind: "codex-security-owning-agent-lifecycle-admission" });
      this.#admissions.set(lifecycleAdmission, Object.freeze({ request, owner, targetBinding, generation, installationId: before.installation.installationId,
        metadataDigest: hash(before), lease }));
    }
    return Object.freeze({ ...freeze(structuredClone(before)), owningAgent: freeze({ ...owner, owningBindingId: request.owningBindingId,
      targetBinding, runtimeAccountKind: account.kind, runtimeAccountGeneration: generation }),
      authentication: freeze(authentication), lifecycleReady: lifecycleBlockers.length === 0,
      lifecycleBlockers: Object.freeze(lifecycleBlockers), lifecycleAdmission,
      fullPluginUsable: false, fullPluginBlockers: Object.freeze(fullPluginBlockers),
      modelTurnStarted: false, scanStarted: false, originalToolsUnlocked: false });
  }

  activateAdmission(receipt, lease) {
    const record = this.#admissions.get(receipt);
    if (!record || record.lease !== lease) fail("ADMISSION_INVALID", "前置准入必须是当前 Service 的品牌对象");
    this.#assertSnapshot(record, lease);
    const key = hash(record.owner);
    const previous = this.#active.get(key);
    if (previous && (previous.lease !== lease || hash(previous.targetBinding) !== hash(record.targetBinding))) {
      fail("ADMISSION_CONFLICT", "同一 owning Run 的生命周期 binding 已固定");
    }
    this.#active.set(key, record);
    return Object.freeze({ targetBinding: record.targetBinding, installationId: record.installationId,
      fullPluginUsable: false, modelTurnStarted: false, scanStarted: false });
  }

  assertOwner(owner, lease) {
    const record = this.#active.get(hash(owner));
    if (!record || record.lease !== lease) fail("ADMISSION_INVALID", "owning Agent 没有当前生命周期准入");
    this.#assertSnapshot(record, lease);
    return true;
  }

  bindingForOwner(owner) {
    const record = this.#active.get(hash(owner));
    if (!record) fail("ADMISSION_INVALID", "owning Agent 没有当前生命周期准入");
    this.assertOwner(owner, record.lease);
    return record.targetBinding;
  }

  deactivateAdmission(receipt, lease) {
    const record = this.#admissions.get(receipt);
    if (!record || record.lease !== lease) fail("ADMISSION_INVALID", "准入对象不属于当前 Service lease");
    const key = hash(record.owner);
    if (this.#active.get(key) === record) this.#active.delete(key);
  }

  #owner(lease) {
    const identity = this.capabilityIssuer.assert(lease, { kind: "mcp" });
    const run = this.dispatcher.getRun(identity.runId);
    if (!run || !ACTIVE_WORK_RUN_STATUSES.has(run.status) || run.profileId !== identity.profileId
      || !run.workspace || run.workspace !== identity.workspace || canonicalWorkspace(run.workspace) !== run.workspace) {
      fail("OWNER_INVALID", "前置检查必须绑定真实已准入的 owning Agent Run");
    }
    const profile = this.productStore.resolveAgentRuntimeProfile(identity.profileId, identity.bindingId);
    if (!profile.enabled || profile.runtime !== identity.runtime || profile.runtimeAccountId !== identity.runtimeAccountId) {
      fail("OWNER_INVALID", "owning Agent 的实际 Runtime binding 已失效");
    }
    return Object.freeze({ runId: run.id, profileId: run.profileId, bindingId: identity.bindingId,
      runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
      attemptId: identity.attemptId, workspace: run.workspace, contextSnapshotId: run.contextSnapshotId });
  }

  #generation(lease, targetBinding) {
    const identity = this.capabilityIssuer.assert(lease, { kind: "mcp" });
    if (targetBinding.runtimeAccountId !== identity.runtimeAccountId
      || !Number.isSafeInteger(identity.accountGeneration) || identity.accountGeneration < 1) {
      fail("ACCOUNT_ADMISSION_REQUIRED", "owning Codex account 必须有真实 Run 的 RuntimeAccount 准入代际");
    }
    try {
      this.runtimeAccountAdmission.assertRunAdmitted({ runtimeAccountId: targetBinding.runtimeAccountId,
        runId: identity.runId, generation: identity.accountGeneration });
    } catch {
      fail("ACCOUNT_ADMISSION_REQUIRED", "owning Run 的实际账号准入已失效");
    }
    return identity.accountGeneration;
  }

  #assertSnapshot(record, lease) {
    if (hash(this.#owner(lease)) !== hash(record.owner)) fail("STALE", "owning Agent Run 已变化");
    const current = this.productStore.resolveAgentRuntimeProfile(record.owner.profileId, record.request.owningBindingId);
    const binding = runtimeBinding({ runtime: current.runtime, runtimeProfileId: current.runtimeProfileId, runtimeAccountId: current.runtimeAccountId });
    if (hash(binding) !== hash(record.targetBinding) || this.#generation(lease, binding) !== record.generation
      || hash(this.#metadata(record.request.installationId)) !== record.metadataDigest) {
      fail("STALE", "安装、公共 binding/连接或 owning account 代际已变化");
    }
  }

  #metadata(installationId) {
    const bundle = this.bundledCatalog.assertCurrent("codex-security");
    const installation = installationId === null ? this.store.getBySource(SOURCE_IDENTITY) : this.store.getInstallation(installationId);
    if (installation && installation.sourceIdentity !== SOURCE_IDENTITY) fail("SOURCE_MISMATCH", "安装记录不是固定内置 Codex Security 来源");
    let release = null;
    if (installation && installation.desiredState !== "uninstalled") {
      this.resolver.verifyInstallation(installation.installationId);
      release = this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
      if (!release || release.sourceIdentity !== SOURCE_IDENTITY || release.contentDigest !== installation.releaseDigest
        || release.name !== "codex-security" || release.declaredVersion !== bundle.version) {
        fail("RELEASE_INVALID", "实际安装 release 与 Codex Security 固定版本不一致");
      }
    }
    const sharedBindings = [];
    for (const binding of this.store.listGlobalBindings().filter(item => item.installationId === installation?.installationId
      && item.componentKind === "mcp-server")) {
      const names = release?.components.mcpServers.map(server => server.name) || [];
      const server = names.find(name => componentId(installation.installationId, "mcp-server", name) === binding.componentId);
      if (!server) fail("BINDING_INVALID", "公共 binding 不属于当前 installed release");
      const connection = this.store.getConnection(binding.connectionId);
      if (connection && (connection.installationId !== installation.installationId || connection.componentId !== binding.componentId)) {
        fail("BINDING_INVALID", "公共 connection 不属于对应组件");
      }
      sharedBindings.push({ bindingId: binding.bindingId, revision: binding.revision, enabled: binding.enabled,
        componentId: binding.componentId, serverName: server,
        connection: { connectionId: binding.connectionId, state: connection?.state || "missing",
          authRevision: connection?.authRevision ?? null, principalPresent: !!connection?.principalIdentity } });
    }
    return { sourceIdentity: SOURCE_IDENTITY,
      bundle: { version: bundle.version, sourceDigest: bundle.sourceDigest, fileCount: bundle.fileCount,
        license: bundle.license, components: bundle.components, converted: bundle.converted,
        unconvertedMcp: bundle.unconvertedMcp },
      installation: installation ? { installationId: installation.installationId, revision: installation.revision,
        releaseDigest: installation.releaseDigest, desiredState: installation.desiredState,
        pendingDisable: this.store.hasPendingInstallationDisable(installation.installationId) } : null,
      installedComponents: release ? { skillCount: release.components.skills.length,
        mcpServerNames: release.components.mcpServers.map(server => server.name),
        diagnosticCodes: [...new Set(release.diagnostics.map(item => item.reasonCode))].sort() } : null,
      sharedBindings: sharedBindings.sort((a, b) => a.bindingId.localeCompare(b.bindingId)) };
  }
}

module.exports = { CodexSecurityServicePreflight };
