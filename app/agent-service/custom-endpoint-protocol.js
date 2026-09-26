"use strict";

const { normalizedApiRoot } = require("./codex-provider-service");
const text = (value, max = 512) => typeof value === "string" && value.isWellFormed()
  && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.byteLength(value, "utf8") <= max;
const strings = (value, maxCount = 500) => Array.isArray(value) && value.length <= maxCount
  && value.every((item) => text(item));

function validateCustomEndpointResult(method, value) {
  if (method === "provider.endpoints.discover") {
    if (!value || typeof value.ok !== "boolean" || typeof value.reachable !== "boolean"
      || !strings(value.models) || !text(value.message) || (value.code !== undefined
        && !["invalid_url", "authentication_failed", "catalog_unavailable", "catalog_too_large", "invalid_catalog", "timeout"].includes(value.code))) {
      throw new TypeError("Invalid model discovery response");
    }
    return { ok: value.ok, reachable: value.reachable, models: [...value.models], message: value.message,
      ...(value.code ? { code: value.code } : {}) };
  }
  if (!value || value.supported !== true || !strings(value.profiles)
    || !Array.isArray(value.endpoints) || value.endpoints.length > 500) throw new TypeError("Invalid endpoint snapshot");
  const endpoints = value.endpoints.map((entry) => {
    if (!entry || !text(entry.id, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.id)
      || !text(entry.name) || !text(entry.baseUrl, 4096) || normalizedApiRoot(entry.baseUrl) !== entry.baseUrl
      || !text(entry.model) || !strings(entry.models) || !entry.models.includes(entry.model)
      || !strings(entry.profiles) || !strings(entry.activeIn)
      || entry.api !== "openai-responses" || typeof entry.hasApiKey !== "boolean"
      || typeof entry.isCurrent !== "boolean" || entry.discoverModels !== false) throw new TypeError("Invalid endpoint entry");
    return { id: entry.id, name: entry.name, baseUrl: entry.baseUrl, model: entry.model,
      models: [...entry.models], api: entry.api, hasApiKey: entry.hasApiKey, isCurrent: entry.isCurrent,
      discoverModels: false, profiles: [...entry.profiles], activeIn: [...entry.activeIn] };
  });
  return { supported: true, profiles: [...value.profiles], endpoints,
    form: { apiOptions: ["openai-responses"], defaultApi: "openai-responses", nameEditable: false, firstModelIsDefault: true } };
}

module.exports = { validateCustomEndpointResult };
