"use strict";

// Strict projections of Service plugin setup/credential results. Credential
// values never appear here: only names, configured flags and destinations.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/u;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const STEP = /^(?:provide_secret:[A-Z][A-Z0-9_]{0,63}|activate|configure_in_plugins|ready_next_turn)$/u;
const STATES = new Set(["ready", "secret_required", "activation_required", "unsupported",
  "interpreter_unavailable", "connection_failed", "installed_inactive", "connection_required",
  "permission_required"]);
const MAX_ITEMS = 64;

function invalid() { throw new TypeError("invalid plugin setup response"); }
function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function text(value, max = 256, empty = false) {
  return typeof value === "string" && (empty || value.length > 0) && value.length <= max && !value.includes("\0");
}
function count(value, nullable = false) {
  return (nullable && value === null) || (Number.isSafeInteger(value) && value >= 0 && value <= 100_000);
}
function list(value, map, max = MAX_ITEMS) {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value.map(map);
}
function names(value) {
  return list(value, item => { if (!text(item, 128)) invalid(); return item; }, 256);
}
function steps(value) {
  return list(value, item => { if (typeof item !== "string" || !STEP.test(item)) invalid(); return item; });
}
function secretState(value) {
  if (!exact(value, ["name", "configured"]) || !SECRET.test(value.name || "")
    || typeof value.configured !== "boolean") invalid();
  return { name: value.name, configured: value.configured };
}
const COMPONENT = ["componentId", "name", "transport", "target", "interpreter", "interpreterReady",
  "secrets", "state", "reason", "tools", "granted"];
function component(value, activation = false) {
  const keys = activation ? [...COMPONENT, "eachCallTools"] : COMPONENT;
  if (!exact(value, keys) || !HASH.test(value.componentId || "") || !text(value.name, 128)
    || !text(value.transport, 64) || !text(value.target, 256, true)
    || ![null, "node", "python"].includes(value.interpreter)
    || (value.interpreter === null ? value.interpreterReady !== null : typeof value.interpreterReady !== "boolean")
    || !STATES.has(value.state) || (value.reason !== null && (typeof value.reason !== "string" || !CODE.test(value.reason)))
    || !count(value.tools, true) || !count(value.granted)) invalid();
  return { componentId: value.componentId, name: value.name, transport: value.transport,
    target: value.target, interpreter: value.interpreter, interpreterReady: value.interpreterReady,
    secrets: list(value.secrets, secretState, 16), state: value.state, reason: value.reason,
    tools: value.tools, granted: value.granted,
    ...(activation ? { eachCallTools: names(value.eachCallTools) } : {}) };
}
function destination(value) {
  if (!value || typeof value !== "object" || !["env", "header"].includes(value.kind)
    || !exact(value, value.kind === "env" ? ["component", "kind", "key"] : ["component", "kind", "key", "origin"])
    || !text(value.component, 128) || !text(value.key, 128)
    || (value.kind === "header" && !text(value.origin, 2048, true))) invalid();
  return { ...value };
}
function challenge(value, summary) {
  if (!exact(value, ["challenge", "expiresAt", "summary"]) || !text(value.challenge, 128)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) invalid();
  return { challenge: value.challenge, expiresAt: value.expiresAt, summary: summary(value.summary) };
}

function validatePluginSetupResult(method, value) {
  if (method === "plugins.setup.get") {
    if (!exact(value, ["installationId", "packageName", "declaredVersion", "releaseDigest", "desiredState",
      "revision", "skills", "components", "nextSteps"]) || !ID.test(value.installationId || "")
      || !text(value.packageName, 128) || (value.declaredVersion !== null && !text(value.declaredVersion, 128))
      || !HASH.test(value.releaseDigest || "") || !["enabled", "disabled"].includes(value.desiredState)
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || !count(value.skills)) invalid();
    return { ...value, components: list(value.components, item => component(item)), nextSteps: steps(value.nextSteps) };
  }
  if (method === "plugins.setup.prepare") {
    return challenge(value, summary => {
      if (!exact(summary, ["action", "package", "version", "skills", "components", "unsupported"])
        || summary.action !== "plugin-quick-enable" || !text(summary.package, 128)
        || !text(summary.version, 128, true) || !count(summary.skills)) invalid();
      return { ...summary, unsupported: names(summary.unsupported),
        components: list(summary.components, item => {
          if (!exact(item, ["name", "target", "interpreter", "missingSecrets"]) || !text(item.name, 128)
            || !text(item.target, 256, true) || ![null, "node", "python"].includes(item.interpreter)) invalid();
          return { ...item, missingSecrets: names(item.missingSecrets) };
        }) };
    });
  }
  if (method === "plugins.setup.commit") {
    if (!exact(value, ["canceled", "result"]) || typeof value.canceled !== "boolean"
      || (value.canceled !== (value.result === null))) invalid();
    if (value.canceled) return { canceled: true, result: null };
    const result = value.result;
    if (!exact(result, ["installationId", "packageName", "desiredState", "components", "nextSteps"])
      || !ID.test(result.installationId || "") || !text(result.packageName, 128)
      || !["enabled", "disabled"].includes(result.desiredState)) invalid();
    return { canceled: false, result: { ...result,
      components: list(result.components, item => component(item, true)), nextSteps: steps(result.nextSteps) } };
  }
  if (method === "plugins.secrets.list") {
    if (!exact(value, ["installationId", "packageName", "items"]) || !ID.test(value.installationId || "")
      || !text(value.packageName, 128)) invalid();
    return { ...value, items: list(value.items, item => {
      if (!exact(item, ["name", "configured", "destinations"]) || !SECRET.test(item.name || "")
        || typeof item.configured !== "boolean") invalid();
      return { name: item.name, configured: item.configured, destinations: list(item.destinations, destination) };
    }) };
  }
  if (method === "plugins.secrets.prepare") {
    return challenge(value, summary => {
      if (!exact(summary, ["action", "package", "name", "destinations"])
        || !["plugin-secret-set", "plugin-secret-clear"].includes(summary.action)
        || !text(summary.package, 128) || !SECRET.test(summary.name || "")) invalid();
      return { ...summary, destinations: list(summary.destinations, destination) };
    });
  }
  if (method === "plugins.secrets.commit") {
    if (!exact(value, ["canceled", "result"]) || typeof value.canceled !== "boolean"
      || (value.canceled !== (value.result === null))) invalid();
    if (value.canceled) return { canceled: true, result: null };
    const result = value.result;
    if (!exact(result, ["installationId", "name", "configured", "components", "nextSteps"])
      || !ID.test(result.installationId || "") || !SECRET.test(result.name || "")
      || typeof result.configured !== "boolean") invalid();
    return { canceled: false, result: { ...result, nextSteps: steps(result.nextSteps),
      components: list(result.components, item => {
        if (!item || typeof item !== "object" || !exact(item, Object.hasOwn(item, "reason")
          ? ["name", "state", "reason"] : ["name", "state"]) || !text(item.name, 128) || !STATES.has(item.state)
          || (Object.hasOwn(item, "reason") && !CODE.test(item.reason || ""))) invalid();
        return { ...item };
      }) } };
  }
  invalid();
}

// First-party plugins ship in the App; the list carries display metadata and
// the installation state used to offer a reinstall after an uninstall.
const FIRST_PARTY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const FIRST_PARTY_STATES = new Set(["enabled", "disabled", "uninstalled", "not-installed"]);
function validateFirstPartyResult(method, value) {
  if (method === "plugins.firstParty.list") {
    if (!exact(value, ["items"])) invalid();
    return { items: list(value.items, item => {
      if (!exact(item, ["packageId", "name", "version", "description", "installationId", "installationState"])
        || !FIRST_PARTY_ID.test(item.packageId || "") || !text(item.name, 128)
        || (item.version !== null && !text(item.version, 64)) || !text(item.description, 1024, true)
        || (item.installationId !== null && !ID.test(item.installationId || ""))
        || !FIRST_PARTY_STATES.has(item.installationState)) invalid();
      return { ...item };
    }) };
  }
  if (method === "plugins.firstParty.install") {
    const installation = value?.installation;
    if (!exact(value, ["installation"]) || !installation || typeof installation !== "object"
      || !ID.test(installation.installationId || "") || !HASH.test(installation.releaseDigest || "")
      || !["enabled", "disabled"].includes(installation.desiredState)
      || installation.sourceKind !== "first-party") invalid();
    return { installation: { installationId: installation.installationId, releaseDigest: installation.releaseDigest,
      desiredState: installation.desiredState, revision: installation.revision, sourceKind: installation.sourceKind } };
  }
  invalid();
}

module.exports = { validatePluginSetupResult, validateFirstPartyResult };
