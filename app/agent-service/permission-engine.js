"use strict";

const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");

function permissionError(code, message) { return serviceError(code, message); }

class PermissionEngine {
  constructor(options = {}) {
    if (!options.toolRegistry || typeof options.toolRegistry.get !== "function") {
      throw new TypeError("PermissionEngine 需要 ToolRegistry");
    }
    this.toolRegistry = options.toolRegistry;
    this.paths = options.paths || null;
    this.profileOverrides = new Map();
    this.revision = 1;
    this.opened = this.paths === null;
  }
  open(profileIds = []) {
    if (this.opened) return;
    const knownProfiles = new Set(profileIds);
    if (lstatIfExists(this.paths.toolPolicyPath)) {
      let state;
      try {
        state = JSON.parse(readPrivateFile(this.paths.toolPolicyPath, {
          maxBytes: 4 * 1024 * 1024,
        }).toString("utf8"));
      } catch {
        throw permissionError("TOOL_PERMISSION_STORE_INVALID", "工具权限状态无效");
      }
      if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision)
        || state.revision < 1 || !state.profiles || typeof state.profiles !== "object"
        || Array.isArray(state.profiles) || Object.getPrototypeOf(state.profiles) !== Object.prototype) {
        throw permissionError("TOOL_PERMISSION_STORE_INVALID", "工具权限状态无效");
      }
      const restored = new Map();
      for (const [profileId, entries] of Object.entries(state.profiles)) {
        if (!knownProfiles.has(profileId) || !entries || typeof entries !== "object"
          || Array.isArray(entries) || Object.getPrototypeOf(entries) !== Object.prototype) {
          throw permissionError("TOOL_PERMISSION_STORE_INVALID", "工具权限 Profile 无效");
        }
        const values = new Map();
        for (const [toolName, effect] of Object.entries(entries)) {
          if (!["allow", "deny"].includes(effect)) {
            throw permissionError("TOOL_PERMISSION_STORE_INVALID", "工具权限条目无效");
          }
          if (!this.toolRegistry.get(toolName)) {
            throw permissionError("TOOL_PERMISSION_STORE_INVALID", "工具权限条目无效");
          }
          values.set(toolName, effect);
        }
        restored.set(profileId, values);
      }
      this.profileOverrides = restored;
      this.revision = state.revision;
      this.opened = true;
    }
    this.opened = true;
  }
  close() { if (this.paths) this.opened = false; }
  _assertOpen() {
    if (!this.opened) throw permissionError("TOOL_PERMISSION_STORE_CLOSED", "工具权限状态未打开");
  }
  _persist() {
    if (!this.paths) return;
    const profiles = Object.fromEntries([...this.profileOverrides].map(([profileId, entries]) => (
      [profileId, Object.fromEntries(entries)]
    )));
    atomicWritePrivateFile(this.paths.toolPolicyPath, `${JSON.stringify({
      schemaVersion: 1, revision: this.revision, profiles,
    })}\n`, { trustedRoot: this.paths.trustedRoot });
  }
  setProfileOverride(profileId, toolName, effect, expectedRevision = this.revision) {
    this._assertOpen();
    if (typeof profileId !== "string" || typeof toolName !== "string"
      || !["allow", "deny"].includes(effect) || !this.toolRegistry.get(toolName)) {
      throw permissionError("TOOL_PERMISSION_INVALID", "工具权限修改无效");
    }
    if (expectedRevision !== this.revision) {
      throw permissionError("TOOL_PERMISSION_REVISION_CONFLICT", "工具权限 revision 已变化");
    }
    const current = new Map(this.profileOverrides.get(profileId) || []);
    current.set(toolName, effect);
    this.profileOverrides.set(profileId, current);
    this.revision += 1;
    this._persist();
    return this.revision;
  }
  profileProjection(profileId) {
    this._assertOpen();
    const overrides = this.profileOverrides.get(profileId) || new Map();
    return {
      registryRevision: this.toolRegistry.revision,
      revision: this.revision,
      tools: this.toolRegistry.list().filter((tool) => tool.modelVisible !== false).map((tool) => ({
        name: tool.tool,
        domain: tool.domain,
        description: tool.description,
        risk: tool.risk,
        enabled: tool.enabled,
        effect: overrides.get(tool.tool) || "allow",
      })),
    };
  }
  purgeProfile(profileId) {
    this._assertOpen();
    if (!this.profileOverrides.has(profileId)) return;
    const previous = this.profileOverrides.get(profileId);
    this.profileOverrides.delete(profileId);
    this.revision += 1;
    try { this._persist(); } catch (error) {
      this.profileOverrides.set(profileId, previous);
      this.revision -= 1;
      throw error;
    }
  }
  authorize(input) {
    this._assertOpen();
    const tool = this.toolRegistry.get(input.name);
    if (!tool || !tool.enabled) throw permissionError("MCP_TOOL_FORBIDDEN", "工具已撤销或不存在");
    if (input.profile !== undefined
      && (!input.profile || input.profile.id !== input.profileId || input.profile.enabled !== true)) {
      throw permissionError("MCP_TOOL_FORBIDDEN", "Profile 无权调用工具");
    }
    if (this.profileOverrides.get(input.profileId)?.get(input.name) === "deny") {
      throw permissionError("MCP_TOOL_FORBIDDEN", "工具权限已撤销");
    }
    if (["confirm", "destructive"].includes(tool.risk) && input.confirmed !== true) {
      throw permissionError("MCP_TOOL_CONFIRMATION_REQUIRED", "工具需要本次用户确认");
    }
    if (input.run !== null && input.run !== undefined) {
      if (input.run.profileId !== input.profileId) {
        throw permissionError("MCP_TOOL_FORBIDDEN", "WorkRun 不属于当前 Profile");
      }
      if (input.workspace !== undefined && input.workspace !== input.run.workspace) {
        throw permissionError("MCP_TOOL_FORBIDDEN", "工具 workspace 超出 WorkRun 范围");
      }
    }
    return Object.freeze({
      toolRevision: this.toolRegistry.revision,
      permissionRevision: this.revision,
      risk: tool.risk,
    });
  }

  // Candidate plugin Runtime calls use this evaluator at ticket issuance and
  // final egress. Records and approval views come from Service-owned stores and
  // opaque dispatcher receipts, never from model-provided authority fields.
  authorizeCapability(input) {
    this._assertOpen();
    const deny = (code = "CAPABILITY_FORBIDDEN") => {
      throw permissionError(code, "插件能力未获当前授权");
    };
    const { authority, execution, installation, binding, connection, grant,
      envelope, authorityIncarnation, toolIdentity, contractDigest, argumentDigest, now = Date.now() } = input || {};
    if (!authority || !execution || !installation || !binding || !connection || !grant
      || !envelope || typeof toolIdentity !== "string" || !toolIdentity
      || typeof contractDigest !== "string" || !/^[a-f0-9]{64}$/u.test(contractDigest)
      || typeof argumentDigest !== "string" || !/^[a-f0-9]{64}$/u.test(argumentDigest)
      || !Number.isSafeInteger(now) || now < 0) deny();
    if (authority.kind !== "native-profile"
      || authority.profile?.id !== authority.profileId || authority.profile.enabled !== true
      || authority.profileId !== binding.subjectId
      || binding.subjectKind !== "native-profile" || execution.profileId !== authority.profileId) deny();
    // Product-level deny, disabled tool, Profile, Run and confirmation rules
    // remain upper bounds. A plugin Grant cannot widen them.
    const product = this.authorize({ name: "mcp_server_call", profileId: authority.profileId,
      profile: authority.profile, confirmed: authority.confirmed === true,
      run: execution.run || null, workspace: execution.workspace });
    if (installation.installationId !== binding.installationId
      || installation.desiredState !== "enabled" || binding.enabled !== true
      || connection.connectionId !== binding.connectionId
      || connection.state !== "ready" || !connection.principalIdentity
      || grant.bindingId !== binding.bindingId || grant.connectionId !== connection.connectionId
      || grant.principalIdentity !== connection.principalIdentity
      || grant.effect !== "allow" || grant.toolIdentity !== toolIdentity
      || grant.contractDigest !== contractDigest || grant.argumentScope != null
      || !Number.isSafeInteger(grant.epoch) || grant.epoch < 0
      || !Number.isSafeInteger(binding.revision) || binding.revision < 1
      || !Number.isSafeInteger(connection.authRevision) || connection.authRevision < 1
      || (grant.expiresAt != null && grant.expiresAt <= now)) deny("GRANT_REVOKED");
    if ((typeof authorityIncarnation !== "string"
        || !/^[a-f0-9]{64}$/u.test(authorityIncarnation)
        || envelope.authorityIncarnation !== authorityIncarnation)
      || envelope.bindingId !== binding.bindingId
      || envelope.installationId !== installation.installationId
      || envelope.releaseDigest !== installation.activeReleaseDigest
      || envelope.componentId !== binding.componentId
      || envelope.connectionId !== connection.connectionId
      || envelope.principalIdentity !== connection.principalIdentity
      || envelope.bindingRevision !== binding.revision
      || envelope.grantEpoch !== grant.epoch
      || envelope.connectionAuthRevision !== connection.authRevision
      || envelope.toolIdentity !== toolIdentity
      || envelope.contractDigest !== contractDigest) deny("TOOL_CONTRACT_CHANGED");
    if (execution.kind === "native-run") {
      if (!execution.run || envelope.runId !== execution.run.id) deny();
    } else if (execution.kind === "user-interaction") {
      if (authority.managementTicket !== execution.managementTicket
        || !authority.managementTicket || authority.managementTicketVerified !== true) deny();
    } else deny();
    if (grant.approvalMode === "each-call") {
      const approval = execution.approval;
      if (!approval || approval.bindingId !== binding.bindingId
        || approval.connectionId !== connection.connectionId
        || approval.principalIdentity !== connection.principalIdentity
        || approval.toolIdentity !== toolIdentity
        || (execution.kind === "native-run" && approval.runId !== execution.run.id)
        || approval.contractDigest !== contractDigest
        || approval.argumentDigest !== argumentDigest
        || !Number.isSafeInteger(approval.expiresAt)
        || approval.expiresAt <= now || approval.consumed !== false) deny();
    } else if (grant.approvalMode !== "always") deny();
    return Object.freeze({
      toolRevision: product.toolRevision,
      permissionRevision: product.permissionRevision,
      grantEpoch: grant.epoch,
      bindingRevision: binding.revision,
      connectionAuthRevision: connection.authRevision,
      contractDigest,
    });
  }
}

module.exports = { PermissionEngine };
