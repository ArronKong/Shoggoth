"use strict";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const AUTH_SOURCE = "AccountAuthManager.readForProfile -> canonical RuntimeAccount account/read";
const STATES = new Set(["enabled", "disabled", "uninstalled"]);
const AUTH = new Set(["unobserved", "unauthenticated", "authenticated"]);
const BLOCKERS = new Set(["INSTALLED_ENABLED_RELEASE_REQUIRED", "ORIGINAL_MCP_NOT_CONVERTED",
  "INSTALLED_NATIVE_MCP_COMPONENT_MISSING", "SHARED_MCP_BINDING_MISSING", "SHARED_MCP_CONNECTION_NOT_READY",
  "CODEX_ACCOUNT_AUTH_NOT_OBSERVED", "CODEX_ACCOUNT_NOT_AUTHENTICATED", "OWNING_RUN_AUTHORITY_NOT_OBSERVED",
  "OWNING_NATIVE_TURN_ADAPTER_REQUIRED", "FULL_SCAN_ACCEPTANCE_UNVERIFIED", "REDISTRIBUTION_APPROVAL_PENDING"]);
const MUST_BLOCK = ["OWNING_RUN_AUTHORITY_NOT_OBSERVED", "OWNING_NATIVE_TURN_ADAPTER_REQUIRED",
  "FULL_SCAN_ACCEPTANCE_UNVERIFIED", "REDISTRIBUTION_APPROVAL_PENDING"];
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
const id = value => typeof value === "string" && ID.test(value);
const optionalId = value => value === null || id(value);
const hash = value => typeof value === "string" && HASH.test(value);
const count = (value, max = 10_000) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const safe = (value, max = 256) => typeof value === "string" && value.isWellFormed()
  && Buffer.byteLength(value, "utf8") <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const frozen = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
};
const invalid = () => { throw new TypeError("invalid Codex Security read-only status"); };
const codeList = (value, max = 32) => Array.isArray(value) && value.length <= max
  && new Set(value).size === value.length && value.every(item => typeof item === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(item));
const blockerList = value => codeList(value, BLOCKERS.size) && value.every(item => BLOCKERS.has(item))
  && MUST_BLOCK.every(item => value.includes(item));

function validateCodexSecurityStatusInput(value) {
  if (!exact(value, ["installationId", "agentId"]) || !optionalId(value.installationId) || !optionalId(value.agentId)) invalid();
  return Object.freeze({ ...value });
}

function projectCodexSecurityServiceStatus(value, request) {
  if (!exact(request, ["installationId", "runtimeProfileId"]) || !optionalId(request.installationId) || !optionalId(request.runtimeProfileId)
    || !exact(value, ["version", "qualificationScope", "sourceIdentity", "bundle", "installation", "installedComponents",
      "sharedBindings", "candidate", "authentication", "owningRunQualified", "lifecycleReady", "lifecycleBlockers",
      "fullPluginUsable", "fullPluginBlockers", "modelTurnStarted", "scanStarted", "originalToolsUnlocked"])
    || value.version !== 1 || value.qualificationScope !== "installation-and-account" || value.sourceIdentity !== "bundled:codex-security"
    || value.owningRunQualified !== false || value.lifecycleReady !== false || value.fullPluginUsable !== false
    || value.modelTurnStarted !== false || value.scanStarted !== false || value.originalToolsUnlocked !== false
    || !Array.isArray(value.lifecycleBlockers) || value.lifecycleBlockers.length !== 1 || value.lifecycleBlockers[0] !== "OWNING_RUN_AUTHORITY_NOT_OBSERVED"
    || !blockerList(value.fullPluginBlockers)) invalid();
  const bundle = value.bundle;
  if (!exact(bundle, ["version", "sourceDigest", "fileCount", "license", "components", "converted", "unconvertedMcp"])
    || !safe(bundle.version, 32) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(bundle.version)
    || !hash(bundle.sourceDigest) || !count(bundle.fileCount) || bundle.fileCount < 1
    || (bundle.license !== null && !safe(bundle.license, 256))
    || !exact(bundle.components, ["skills", "allSkillFiles", "apps", "mcp"])
    || !Object.values(bundle.components).every(value => count(value))
    || !exact(bundle.converted, ["skills", "mcp"]) || !count(bundle.converted.skills) || !count(bundle.converted.mcp)
    || bundle.converted.skills > bundle.components.skills || bundle.converted.mcp > bundle.components.mcp
    || !Array.isArray(bundle.unconvertedMcp) || bundle.unconvertedMcp.length > 64
    || !bundle.unconvertedMcp.every(item => exact(item, ["name", "reasonCode"]) && id(item.name)
      && ["LEGACY_MCP_FIELD_UNSUPPORTED", "LEGACY_MCP_ENTRY_INVALID"].includes(item.reasonCode))) invalid();
  const installation = value.installation, installed = value.installedComponents;
  if (installation !== null && (!exact(installation, ["installationId", "revision", "releaseDigest", "desiredState", "pendingDisable"])
    || !id(installation.installationId) || !count(installation.revision, Number.MAX_SAFE_INTEGER) || installation.revision < 1
    || !hash(installation.releaseDigest) || !STATES.has(installation.desiredState) || typeof installation.pendingDisable !== "boolean"
    || (request.installationId !== null && request.installationId !== installation.installationId))) invalid();
  const native = installed?.nativeComponent;
  const nativeCandidate = native !== undefined && exact(native, ["transport", "descriptorDigest", "sourceDigest", "originalFileCount"])
    && native.transport === "shoggoth-codex-security-native"
    && native.descriptorDigest === "b7bc2a19d4d2f073c453c0b311f593285f298073bad4307a551993754705109b"
    && native.sourceDigest === "8d32d2544f37f8cc8f43df98216b2a505e6f71d9628c555086039daf1062e9fb"
    && native.originalFileCount === 124 && bundle.fileCount === 124 && bundle.version === "0.1.24"
    && bundle.sourceDigest === native.sourceDigest && bundle.components.mcp === 1
    && Array.isArray(installed.mcpServerNames) && installed.mcpServerNames.length === 1
    && installed.mcpServerNames[0] === "codex-security";
  if (native !== undefined && !nativeCandidate) invalid();
  if (installed !== null && (!exact(installed, ["skillCount", "mcpServerNames", "diagnosticCodes",
    ...(nativeCandidate ? ["nativeComponent"] : [])])
    || !count(installed.skillCount) || installed.skillCount > bundle.converted.skills
    || !Array.isArray(installed.mcpServerNames) || installed.mcpServerNames.length > 64
    || new Set(installed.mcpServerNames).size !== installed.mcpServerNames.length || !installed.mcpServerNames.every(id)
    || (installed.mcpServerNames.length > bundle.converted.mcp && !nativeCandidate) || !codeList(installed.diagnosticCodes))) invalid();
  if ((installation === null || installation.desiredState === "uninstalled") ? installed !== null : installed === null) invalid();
  if (!Array.isArray(value.sharedBindings) || value.sharedBindings.length > 64) invalid();
  const bindings = new Set();
  for (const binding of value.sharedBindings) {
    const connection = binding?.connection;
    if (!exact(binding, ["bindingId", "revision", "enabled", "componentId", "serverName", "connection"])
      || !id(binding.bindingId) || bindings.has(binding.bindingId) || !count(binding.revision, Number.MAX_SAFE_INTEGER) || binding.revision < 1
      || typeof binding.enabled !== "boolean" || !hash(binding.componentId) || !id(binding.serverName)
      || !installed?.mcpServerNames.includes(binding.serverName)
      || !exact(connection, ["connectionId", "state", "authRevision", "principalPresent"]) || !id(connection.connectionId)
      || !["missing", "ready", "auth_required", "auth_failed", "connecting", "disconnected", "revoked", "error", "pending", "unknown"].includes(connection.state)
      || (connection.authRevision !== null && (!count(connection.authRevision, Number.MAX_SAFE_INTEGER) || connection.authRevision < 1))
      || typeof connection.principalPresent !== "boolean") invalid();
    bindings.add(binding.bindingId);
  }
  const candidate = value.candidate;
  if (request.runtimeProfileId === null ? candidate !== null : (!exact(candidate, ["profileId", "runtimeProfileId", "runtimeAccountId", "runtimeAccountKind", "accountGeneration"])
    || !id(candidate.profileId) || candidate.runtimeProfileId !== request.runtimeProfileId || !id(candidate.runtimeAccountId)
    || candidate.runtimeAccountKind !== "shoggoth-managed" || !count(candidate.accountGeneration, Number.MAX_SAFE_INTEGER) || candidate.accountGeneration < 1)) invalid();
  const authentication = value.authentication;
  if (!exact(authentication, ["status", "source", "loginState"]) || !AUTH.has(authentication.status)
    || authentication.source !== AUTH_SOURCE || (authentication.loginState !== null && !safe(authentication.loginState, 32))
    || (candidate === null ? authentication.status !== "unobserved" : authentication.status === "unobserved")) invalid();
  const required = [];
  if (!installation || installation.desiredState !== "enabled" || installation.pendingDisable) required.push("INSTALLED_ENABLED_RELEASE_REQUIRED");
  if (bundle.converted.mcp !== bundle.components.mcp) required.push("ORIGINAL_MCP_NOT_CONVERTED");
  if (!installed?.mcpServerNames.includes("codex-security")) required.push("INSTALLED_NATIVE_MCP_COMPONENT_MISSING");
  if (!value.sharedBindings.some(binding => binding.enabled)) required.push("SHARED_MCP_BINDING_MISSING");
  if (!value.sharedBindings.some(binding => binding.enabled && binding.connection.state === "ready")) required.push("SHARED_MCP_CONNECTION_NOT_READY");
  if (authentication.status === "unobserved") required.push("CODEX_ACCOUNT_AUTH_NOT_OBSERVED");
  else if (authentication.status !== "authenticated") required.push("CODEX_ACCOUNT_NOT_AUTHENTICATED");
  if (required.some(code => !value.fullPluginBlockers.includes(code))) invalid();
  const result = { version: 1, packageId: "codex-security", source: { version: bundle.version, fileCount: bundle.fileCount },
    installation: { state: installation?.desiredState || "not-installed", integrity: installed === null ? "not-installed" : "verified",
      skillCount: installed?.skillCount || 0, mcpCount: installed?.mcpServerNames.length || 0, pendingDisable: installation?.pendingDisable || false },
    authentication: authentication.status,
    connections: { total: value.sharedBindings.length, ready: value.sharedBindings.filter(binding => binding.enabled && binding.connection.state === "ready").length },
    fullPluginUsable: false, originalToolsUnlocked: false, blockers: [...value.fullPluginBlockers] };
  return validateCodexSecurityPublicStatus(result);
}

function validateCodexSecurityPublicStatus(value) {
  if (!exact(value, ["version", "packageId", "source", "installation", "authentication", "connections", "fullPluginUsable", "originalToolsUnlocked", "blockers"])
    || value.version !== 1 || value.packageId !== "codex-security" || !exact(value.source, ["version", "fileCount"])
    || !safe(value.source.version, 32) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(value.source.version)
    || !count(value.source.fileCount) || value.source.fileCount < 1
    || !exact(value.installation, ["state", "integrity", "skillCount", "mcpCount", "pendingDisable"])
    || !["not-installed", ...STATES].includes(value.installation.state) || !["not-installed", "verified"].includes(value.installation.integrity)
    || !count(value.installation.skillCount) || !count(value.installation.mcpCount) || typeof value.installation.pendingDisable !== "boolean"
    || (["not-installed", "uninstalled"].includes(value.installation.state) && value.installation.integrity !== "not-installed")
    || (["enabled", "disabled"].includes(value.installation.state) && value.installation.integrity !== "verified")
    || (["not-installed", "uninstalled"].includes(value.installation.state) && (value.installation.skillCount !== 0 || value.installation.mcpCount !== 0))
    || (!AUTH.has(value.authentication)) || !exact(value.connections, ["total", "ready"])
    || !count(value.connections.total, 64) || !count(value.connections.ready, 64) || value.connections.ready > value.connections.total
    || value.fullPluginUsable !== false || value.originalToolsUnlocked !== false || !blockerList(value.blockers)) invalid();
  return frozen(structuredClone(value));
}

module.exports = { validateCodexSecurityStatusInput, projectCodexSecurityServiceStatus, validateCodexSecurityPublicStatus };
