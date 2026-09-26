"use strict";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CODE = /^[A-Z_]{1,64}$/u;
const TOOL_ID = /^plugin:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const digest = (value) => typeof value === "string" && HASH.test(value);
const id = (value) => typeof value === "string" && ID.test(value);

function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length
    && fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}
function text(value, bytes = 2048) {
  return typeof value === "string" && value.isWellFormed()
    && Buffer.byteLength(value, "utf8") <= bytes;
}
function invalid() { throw new TypeError("invalid plugin management result"); }
function installation(value) {
  if (!exact(value, ["installationId", "releaseDigest", "desiredState",
    "revision", "createdAt", "updatedAt", "sourceKind"])
    || !id(value.installationId) || !digest(value.releaseDigest)
    || !["enabled", "disabled"].includes(value.desiredState)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
    || !["directory", "git", "legacy-directory", "remote-git", "bundled"].includes(value.sourceKind)) invalid();
  return { ...value };
}
function binding(value) {
  if (!exact(value, ["bindingId", "profileId", "installationId", "componentId",
    "enabled", "revision"])
    || !id(value.bindingId) || !id(value.profileId)
    || !id(value.installationId) || !digest(value.componentId)
    || typeof value.enabled !== "boolean"
    || !Number.isSafeInteger(value.revision) || value.revision < 1) invalid();
  return { ...value };
}
function mcpStatus(value) {
  if (!exact(value, ["installationId", "profileId", "items"])
    || !id(value.installationId) || !id(value.profileId)
    || !Array.isArray(value.items) || value.items.length > 256) invalid();
  const items = value.items.map((item) => {
    if (!exact(item, ["componentId", "connections", "binding"])
      || !digest(item.componentId)
      || !exact(item.connections, ["pending", "verified", "disconnected"])) invalid();
    for (const count of Object.values(item.connections)) {
      if (!Number.isSafeInteger(count) || count < 0) invalid();
    }
    let selected = null;
    if (item.binding !== null) {
      const current = item.binding;
      if (!exact(current, ["bindingId", "connectionId", "enabled", "revision",
        "connectionState", "grants"])
        || !id(current.bindingId) || !id(current.connectionId)
        || typeof current.enabled !== "boolean"
        || !Number.isSafeInteger(current.revision) || current.revision < 1
        || !["pending", "ready", "disconnected", null].includes(current.connectionState)
        || !exact(current.grants, ["allow", "deny"])
        || !Number.isSafeInteger(current.grants.allow) || current.grants.allow < 0
        || !Number.isSafeInteger(current.grants.deny) || current.grants.deny < 0) invalid();
      selected = { bindingId: current.bindingId, connectionId: current.connectionId,
        enabled: current.enabled, revision: current.revision,
        connectionState: current.connectionState,
        grants: { allow: current.grants.allow, deny: current.grants.deny } };
    }
    return { componentId: item.componentId, connections: { ...item.connections },
      binding: selected };
  });
  return { installationId: value.installationId, profileId: value.profileId, items };
}
function mcpTools(value) {
  if (!exact(value, ["profileId", "bindingId", "available", "catalogRevision",
    "items"])
    || !id(value.profileId) || !id(value.bindingId)
    || typeof value.available !== "boolean"
    || (value.available ? !UUID.test(value.catalogRevision)
      : value.catalogRevision !== null)
    || !Array.isArray(value.items) || value.items.length > 256
    || (!value.available && value.items.length !== 0)) invalid();
  return { profileId: value.profileId, bindingId: value.bindingId,
    available: value.available, catalogRevision: value.catalogRevision,
    items: value.items.map((item) => {
      if (!exact(item, ["toolIdentity", "name", "contractDigest", "savedGrant"])
        || typeof item.toolIdentity !== "string" || !TOOL_ID.test(item.toolIdentity)
        || !text(item.name, 128) || item.name.length === 0
        || !digest(item.contractDigest)) invalid();
      let savedGrant = null;
      if (item.savedGrant !== null) {
        const grant = item.savedGrant;
        if (!exact(grant, ["effect", "approvalMode", "revision", "expired",
          "matchesCurrentContract"])
          || !["allow", "deny"].includes(grant.effect)
          || !["always", "each-call"].includes(grant.approvalMode)
          || !Number.isSafeInteger(grant.revision) || grant.revision < 1
          || typeof grant.expired !== "boolean"
          || typeof grant.matchesCurrentContract !== "boolean") invalid();
        savedGrant = { ...grant };
      }
      return { toolIdentity: item.toolIdentity, name: item.name,
        contractDigest: item.contractDigest, savedGrant };
    }) };
}
function grantReceipt(value) {
  if (!exact(value, ["bindingId", "toolIdentity", "effect", "revision", "epoch"])
    || !id(value.bindingId) || typeof value.toolIdentity !== "string"
    || !TOOL_ID.test(value.toolIdentity) || value.effect !== "deny"
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.epoch) || value.epoch < 0) invalid();
  return { ...value };
}
function grantBulkReceipt(value) {
  if (!exact(value, ["bindingId", "revokedCount", "bindingRevision", "epoch"])
    || !id(value.bindingId)
    || !Number.isSafeInteger(value.revokedCount) || value.revokedCount < 0
    || !Number.isSafeInteger(value.bindingRevision) || value.bindingRevision < 1
    || !Number.isSafeInteger(value.epoch) || value.epoch < 0) invalid();
  return { ...value };
}
function operation(value) {
  if (!exact(value, ["operationId", "kind", "phase", "result", "createdAt", "updatedAt"])
    || !id(value.operationId)
    || !["install", "installation-state", "skill-binding-set",
      "grant-revoke", "grants-revoke-all", "mcp-connect", "grant-allow", "uninstall"].includes(value.kind)
    || !["created", "committed", "completed", "failed"].includes(value.phase)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) invalid();
  let result;
  if (value.phase === "completed") result = value.kind === "skill-binding-set"
    ? binding(value.result) : value.kind === "grant-revoke"
      ? grantReceipt(value.result) : value.kind === "grants-revoke-all"
        ? grantBulkReceipt(value.result) : ["mcp-connect", "grant-allow"].includes(value.kind)
          ? consentReceipt(value.result) : value.kind === "uninstall"
            ? uninstallReceipt(value.result) : installation(value.result);
  else if (value.phase === "failed") {
    if (!exact(value.result, ["code"])
      || typeof value.result.code !== "string"
      || !CODE.test(value.result.code)) invalid();
    result = { code: value.result.code };
  } else {
    if (value.result !== null) invalid();
    result = null;
  }
  return { operationId: value.operationId, kind: value.kind, phase: value.phase,
    result, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function preview(value) {
  if (!exact(value, ["sourceKind", "previewDigest", "expectedRevision",
    "specVersion", "name", "declaredVersion", "installable",
    "components", "diagnostics"])
    || !["directory", "git", "legacy-directory", "remote-git", "bundled"].includes(value.sourceKind)
    || !digest(value.previewDigest)
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
    || !text(value.specVersion, 64) || !text(value.name, 256)
    || (value.declaredVersion !== null && !text(value.declaredVersion, 256))
    || typeof value.installable !== "boolean"
    || !exact(value.components, ["skills", "mcpServers"])
    || !Array.isArray(value.components.skills) || value.components.skills.length > 256
    || !Array.isArray(value.components.mcpServers) || value.components.mcpServers.length > 256
    || !Array.isArray(value.diagnostics) || value.diagnostics.length > 256) invalid();
  const skills = value.components.skills.map((item) => {
    if (!exact(item, ["name", "description", "descriptorDigest"])
      || !text(item.name, 256) || !text(item.description, 2048)
      || !digest(item.descriptorDigest)) invalid();
    return { name: item.name, description: item.description,
      descriptorDigest: item.descriptorDigest };
  });
  const mcpServers = value.components.mcpServers.map((item) => {
    if (!exact(item, ["name", "type", "descriptorDigest"])
      || !text(item.name, 256)
      || !["stdio", "streamable-http"].includes(item.type)
      || !digest(item.descriptorDigest)) invalid();
    return { name: item.name, type: item.type,
      descriptorDigest: item.descriptorDigest };
  });
  const diagnostics = value.diagnostics.map((item) => {
    const hasName = Object.hasOwn(item, "name");
    if (!exact(item, hasName ? ["scope", "name", "reasonCode"]
      : ["scope", "reasonCode"])
      || !text(item.scope, 64) || (hasName && !text(item.name, 256))
      || typeof item.reasonCode !== "string" || !CODE.test(item.reasonCode)) invalid();
    return { scope: item.scope, ...(hasName ? { name: item.name } : {}),
      reasonCode: item.reasonCode };
  });
  return { sourceKind: value.sourceKind, previewDigest: value.previewDigest,
    expectedRevision: value.expectedRevision, specVersion: value.specVersion,
    name: value.name, declaredVersion: value.declaredVersion,
    installable: value.installable,
    components: { skills, mcpServers }, diagnostics };
}

function consentReceipt(value) {
  if (!exact(value, ["kind", "profileId", "bindingId", "toolIdentity", "revision"])
    || !["mcp-connect", "grant-allow"].includes(value.kind)
    || !id(value.profileId) || !id(value.bindingId)
    || (value.kind === "mcp-connect" ? value.toolIdentity !== null
      : typeof value.toolIdentity !== "string" || !TOOL_ID.test(value.toolIdentity))
    || !Number.isSafeInteger(value.revision) || value.revision < 1) invalid();
  return { ...value };
}

function uninstallReceipt(value) {
  if (!exact(value, ["installationId", "releaseDigest", "revision", "revokedBindings",
    "retainedConnections", "dataRetained", "credentialsRetained", "packageRemoved"])
    || !id(value.installationId) || !digest(value.releaseDigest)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !["revokedBindings", "retainedConnections"].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || value.dataRetained !== true || value.credentialsRetained !== true
    || typeof value.packageRemoved !== "boolean") invalid();
  return { ...value };
}

function validatePluginManagementResult(method, value) {
  if (method === "plugins.uninstall.preview") {
    if (!exact(value, ["installationId", "expectedRevision", "releaseDigest", "requiresDisable",
      "bindingCount", "affectedAgentCount", "connectionCount", "activeCallCount", "dataRetained", "credentialsRetained"])
      || !id(value.installationId) || !digest(value.releaseDigest)
      || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
      || !["bindingCount", "affectedAgentCount", "connectionCount", "activeCallCount"].every(key =>
        Number.isSafeInteger(value[key]) && value[key] >= 0)
      || typeof value.requiresDisable !== "boolean"
      || value.dataRetained !== true || value.credentialsRetained !== true) invalid();
    return { ...value };
  }
  if (method === "plugins.uninstall") {
    if (!exact(value, ["uninstall", "operation"])) invalid();
    const receipt = operation(value.operation);
    if (receipt.kind !== "uninstall") invalid();
    return { uninstall: uninstallReceipt(value.uninstall), operation: receipt };
  }
  if (method === "plugins.mcp.consent.prepare") {
    if (!exact(value, ["challenge", "expiresAt", "summary"])
      || typeof value.challenge !== "string" || !UUID.test(value.challenge)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
      || !exact(value.summary, ["action", "agent", "package", "capability", "approvalMode"])
      || !["connect", "allow"].includes(value.summary.action)
      || (value.summary.action === "connect" ? value.summary.approvalMode !== null
        : !["always", "each-call"].includes(value.summary.approvalMode))
      || !["agent", "package", "capability"].every(key => text(value.summary[key], 256))) invalid();
    return { challenge: value.challenge, expiresAt: value.expiresAt, summary: { ...value.summary } };
  }
  if (method === "plugins.mcp.consent.commit") {
    if (!exact(value, ["canceled", "receipt"]) || typeof value.canceled !== "boolean"
      || (value.canceled && value.receipt !== null)) invalid();
    return { canceled: value.canceled, receipt: value.canceled ? null : consentReceipt(value.receipt) };
  }
  if (method === "plugins.mcp.discover") {
    if (!exact(value, ["profileId", "bindingId", "catalogRevision"])
      || !id(value.profileId) || !id(value.bindingId)
      || typeof value.catalogRevision !== "string" || !UUID.test(value.catalogRevision)) invalid();
    return { ...value };
  }
  if (method === "plugins.install.preview") return preview(value);
  if (method === "plugins.install") {
    if (!exact(value, ["installation", "operation"])) invalid();
    const receipt = operation(value.operation);
    if (receipt.kind !== "install") invalid();
    return { installation: installation(value.installation),
      operation: receipt };
  }
  if (method === "plugins.installations.set") {
    if (!exact(value, ["installation", "operation"])) invalid();
    const receipt = operation(value.operation);
    if (receipt.kind !== "installation-state") invalid();
    return { installation: installation(value.installation), operation: receipt };
  }
  if (method === "plugins.skills.bindings.list") {
    if (!exact(value, ["profileId", "items"]) || !id(value.profileId)
      || !Array.isArray(value.items) || value.items.length > 256) invalid();
    return { profileId: value.profileId, items: value.items.map(binding) };
  }
  if (method === "plugins.mcp.status") return mcpStatus(value);
  if (method === "plugins.mcp.tools.list") return mcpTools(value);
  if (method === "plugins.mcp.grants.revoke") {
    if (!exact(value, ["grant", "operation"])) invalid();
    const receipt = operation(value.operation);
    if (receipt.kind !== "grant-revoke") invalid();
    return { grant: grantReceipt(value.grant), operation: receipt };
  }
  if (method === "plugins.mcp.grants.revoke-all") {
    if (!exact(value, ["revocation", "operation"])) invalid();
    const receipt = operation(value.operation);
    if (receipt.kind !== "grants-revoke-all") invalid();
    return { revocation: grantBulkReceipt(value.revocation), operation: receipt };
  }
  if (method === "plugins.skills.bindings.set") {
    if (!exact(value, ["binding", "operation"])) invalid();
    const receipt = operation(value.operation);
    if (receipt.kind !== "skill-binding-set") invalid();
    return { binding: binding(value.binding), operation: receipt };
  }
  if (method === "plugins.operations.get") {
    if (!exact(value, ["found", "operation"]) || typeof value.found !== "boolean"
      || (value.found ? value.operation === null : value.operation !== null)) invalid();
    return { found: value.found,
      operation: value.found ? operation(value.operation) : null };
  }
  invalid();
}

module.exports = { validatePluginManagementResult };
