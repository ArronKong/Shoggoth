"use strict";

const { createHash } = require("node:crypto");
const { compareVersions } = require("./version-checker");

// Read adapters audited against shipped OpenClaw 2026.9.5 and Hermes 0.21.4.
// OpenClaw: gateway/server-methods/plugins.ts (`plugins.list`).
// Hermes: web_routers/dashboard_ui.py + web_server_dashboard.py (plugins/hub).
// Hermes' `runtime_status` is derived from config, not a running-process receipt.
const MINIMUM_VERSIONS = Object.freeze({ openclaw: "2026.9.5", hermes: "0.21.4" });
const HASH = /^[a-f0-9]{64}$/u;
const MAX_ITEMS = 1024;
const MAX_BYTES = 2 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u;
const READ_ONLY_CAPABILITIES = Object.freeze({ list: false, install: false,
  update: false, enable: false, disable: false, uninstall: false,
  activationObserve: false, perAgentScope: false, cancel: false });

function error(code) {
  return Object.assign(new Error(code), { code });
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function boundedText(value, bytes, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !value.isWellFormed()
    || Buffer.byteLength(value) > bytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw error("PLUGIN_EXTERNAL_RESPONSE_INVALID");
  }
  return value;
}
function identity(value) {
  const result = boundedText(value, 256);
  if (!result || result.trim() !== result) throw error("PLUGIN_EXTERNAL_RESPONSE_INVALID");
  return result;
}
function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function target(backendId, scope) {
  return { kind: "external-backend", backendId, scopeId: hash([backendId, scope]) };
}
function normalizeExternalPluginQuery(input = {}) {
  if (!record(input) || Object.keys(input).some((key) =>
    !["agentId", "limit", "cursor", "catalogRevision"].includes(key))) {
    throw error("PLUGIN_EXTERNAL_QUERY_INVALID");
  }
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || (input.agentId !== undefined && (typeof input.agentId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(input.agentId)))
    || (input.cursor !== undefined && (typeof input.cursor !== "string"
      || !/^(?:0|[1-9][0-9]{0,3})$/u.test(input.cursor)))
    || (input.catalogRevision !== undefined && (typeof input.catalogRevision !== "string"
      || !HASH.test(input.catalogRevision)))
    || (input.cursor !== undefined && input.catalogRevision === undefined)) {
    throw error("PLUGIN_EXTERNAL_QUERY_INVALID");
  }
  return { ...input, limit };
}
function supportedExternalPluginVersion(backendId, value) {
  return typeof value === "string" && VERSION.test(value) && value.length <= 80
    && MINIMUM_VERSIONS[backendId] !== undefined
    && compareVersions(value, MINIMUM_VERSIONS[backendId]) >= 0;
}
function unavailableExternalPluginCatalog(backendId, reasonCode = "PLUGIN_UNSUPPORTED", scope = "unavailable") {
  return { supported: false, reasonCode, target: target(backendId, scope),
    hostVersion: null, observedAt: null, catalogRevision: null,
    capabilities: { ...READ_ONLY_CAPABILITIES }, items: [], nextCursor: null };
}
function capabilitiesFromCatalog(catalog) {
  const { items: _items, nextCursor: _cursor, ...capabilities } = catalog;
  return capabilities;
}
function project(backendId, payload, context, mapItem, activationObserve) {
  if (!record(payload) || !Array.isArray(payload.plugins)
    || payload.plugins.length > MAX_ITEMS || Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) {
    throw error("PLUGIN_EXTERNAL_RESPONSE_INVALID");
  }
  const query = normalizeExternalPluginQuery(context.query);
  if (!supportedExternalPluginVersion(backendId, context.hostVersion)) {
    return unavailableExternalPluginCatalog(backendId, "PLUGIN_EXTERNAL_VERSION_UNSUPPORTED", context.scope);
  }
  const items = payload.plugins.map(mapItem).filter(Boolean)
    .sort((left, right) => left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0);
  if (new Set(items.map((item) => item.pluginId)).size !== items.length) {
    throw error("PLUGIN_EXTERNAL_RESPONSE_INVALID");
  }
  const targetRef = target(backendId, context.scope);
  const catalogRevision = hash([targetRef, context.hostVersion,
    context.connectionGeneration, context.runtimeGeneration ?? null, items]);
  if (query.catalogRevision && query.catalogRevision !== catalogRevision) {
    throw error("PLUGIN_EXTERNAL_CATALOG_CHANGED");
  }
  const offset = Number(query.cursor || 0);
  if (offset > items.length) throw error("PLUGIN_EXTERNAL_QUERY_INVALID");
  return { supported: true, reasonCode: null, target: targetRef,
    hostVersion: context.hostVersion, observedAt: Date.now(), catalogRevision,
    capabilities: { ...READ_ONLY_CAPABILITIES, list: true, activationObserve },
    items: items.slice(offset, offset + query.limit),
    nextCursor: offset + query.limit < items.length ? String(offset + query.limit) : null };
}
function projectOpenClawExternalPlugins(payload, context) {
  const runtimeGeneration = Number.isSafeInteger(payload?.generation) && payload.generation >= 0
    ? payload.generation : null;
  const runtimeStates = ["active", "disabled", "unloaded", "service-failed"];
  const activationObserve = runtimeGeneration !== null && Array.isArray(payload?.plugins)
    && payload.plugins.every((item) => item?.installed === false
      || (record(item?.runtime) && runtimeStates.includes(item.runtime.state)));
  return project("openclaw", payload, { ...context, runtimeGeneration }, (item) => {
    if (!record(item) || typeof item.installed !== "boolean"
      || typeof item.enabled !== "boolean") throw error("PLUGIN_EXTERNAL_RESPONSE_INVALID");
    if (!item.installed) return null; // Curated install suggestions are not installed authority.
    const pluginId = identity(item.id);
    const desiredState = item.enabled ? "enabled" : "disabled";
    const state = activationObserve && record(item.runtime) ? item.runtime.state : null;
    const observedState = runtimeStates.includes(state) ? state : "unknown";
    return { pluginId, name: boundedText(item.name, 512) || pluginId,
      version: boundedText(item.version, 128, { optional: true }),
      sourceKind: ["bundled", "global", "workspace", "config", "official"].includes(item.origin)
        ? item.origin : "external",
      desiredState, observedState,
      effectiveAt: (item.enabled && observedState === "active")
        || (!item.enabled && observedState === "disabled") ? "now" : "unknown" };
  }, activationObserve);
}
function projectHermesExternalPlugins(payload, context) {
  return project("hermes", payload, context, (item) => {
    if (!record(item) || !["enabled", "disabled", "inactive"].includes(item.runtime_status)) {
      throw error("PLUGIN_EXTERNAL_RESPONSE_INVALID");
    }
    const name = identity(item.name);
    // Hermes 0.21.4 omits the discovery key from plugins/hub. Bare manifest
    // names can repeat across categories (e.g. image_gen/xai, video_gen/xai).
    // Bind identity to the reported source/location without exposing or opening
    // a host path. Do this for every row so adding a namesake never changes IDs.
    const source = boundedText(item.source, 64, { optional: true });
    const location = boundedText(item.path, 4096, { optional: true });
    const pluginId = `hermes:${hash(location
      ? ["location", source, location] : ["name", source, name])}`;
    return { pluginId, name,
      version: boundedText(item.version, 128, { optional: true }),
      sourceKind: ["bundled", "user", "git"].includes(item.source) ? item.source : "external",
      desiredState: item.runtime_status === "inactive" ? "unknown" : item.runtime_status,
      observedState: "unknown", effectiveAt: "unknown" };
  }, false);
}
function externalPluginWriteUnsupported() {
  throw error("PLUGIN_EXTERNAL_WRITE_UNSUPPORTED");
}

module.exports = { MAX_BYTES, normalizeExternalPluginQuery, supportedExternalPluginVersion,
  unavailableExternalPluginCatalog, capabilitiesFromCatalog,
  projectOpenClawExternalPlugins, projectHermesExternalPlugins, externalPluginWriteUnsupported };
