"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { declaredReasoningOptions, knownEndpointReasoningOptions } = require("../agent-service/model-reasoning-catalog");

const HERMES_THINKING_LEVELS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const OPENROUTER_CATALOG = "https://openrouter.ai/api/v1/models";
const NOUS_CATALOG = "https://inference-api.nousresearch.com/v1/models";
const MAX_CACHE_AGE_MS = 24 * 60 * 60_000;

// Hermes deliberately omits supported_efforts from the dashboard DTO. Its own
// per-profile cache contains the declarations used by the request transport.
function readHermesReasoningCatalog(home, now = Date.now()) {
  const maximumBytes = 1024 * 1024;
  let fd;
  try {
    const file = path.join(home, "cache", "reasoning_caps.json");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    // The Hermes catalog is public metadata. Older writers left it readable by other users.
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > maximumBytes
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return {};
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) return {};
    const value = JSON.parse(bytes.toString("utf8", 0, offset));
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => Number.isFinite(entry?.ts)
      && entry.ts * 1000 <= now && now - entry.ts * 1000 < MAX_CACHE_AGE_MS
      && entry.caps && !Array.isArray(entry.caps) && typeof entry.caps === "object")
      .map(([url, entry]) => [url, entry.caps]));
  } catch { return {}; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function cachedOptions(provider, model, cache, builtin) {
  const builtinCatalogs = { openrouter: OPENROUTER_CATALOG, nous: NOUS_CATALOG };
  const fromEndpoint = typeof provider.api_url === "string"
    ? `${provider.api_url.replace(/\/+$/u, "")}/models` : null;
  const catalogUrl = fromEndpoint ?? (builtin && Object.hasOwn(builtinCatalogs, provider.slug) ? builtinCatalogs[provider.slug] : null);
  if (![OPENROUTER_CATALOG, NOUS_CATALOG].includes(catalogUrl)) return null;
  // A named custom row is allowed only if it actually uses the matching
  // official root. A similarly named relay never inherits these values.
  return declaredReasoningOptions(cache[catalogUrl]?.[model]);
}

function hermesModelThinkingOptions(provider, model, capability, cache = {}) {
  const builtin = provider.is_user_defined !== true && provider.source !== "user-config"
    && !String(provider.slug).startsWith("custom:");
  const declared = declaredReasoningOptions(capability);
  const cached = declared === null ? cachedOptions(provider, model, cache, builtin) : null;
  const options = declared ?? cached ?? nativeOptions(provider, model, builtin) ?? [];
  return HERMES_THINKING_LEVELS.filter(level => (options.includes(level) || level === "none" && options.includes("off"))
    && (level !== "none" || capability?.can_disable_reasoning !== false));
}

function nativeOptions(provider, model, builtin) {
  // The built-in Xiaomi Chat profile does not forward effort. Named custom
  // routes have their own compatibility rules and routing identity.
  if (builtin && provider.slug === "xiaomi") return null;
  const transport = provider.api_mode === "codex_responses" ? "responses" : "chat-completions";
  const options = provider.api_mode === "anthropic_messages" ? null
    : knownEndpointReasoningOptions(provider.api_url, model, transport);
  if (options !== null || provider.api_url || !builtin) return options;
  if (provider.slug === "deepseek") return knownEndpointReasoningOptions("https://api.deepseek.com/v1", model, transport);
  if (provider.slug === "zai") {
    // Hermes' native Z.AI provider maps these exact models on the chat wire.
    if (["glm-5.3", "glm-5.3-flash"].includes(model)) return ["none", "low", "medium", "high", "max"];
    if (model === "glm-5.2") return ["none", "high", "max"];
  }
  if (provider.slug === "openai-codex") {
    // Hermes' Codex transport clamps to these sets before sending (see
    // upstream agent/reasoning_effort.py).
    const levels = ["low", "medium", "high", "xhigh"];
    if (["gpt-6-astra", "gpt-6-astra-900k", "gpt-6.1-sol"].includes(model)) return [...levels, "max"];
    if (["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-luna", "gpt-6-luna-900k", "gpt-6-sol"].includes(model)) {
      return ["none", ...levels, "max"];
    }
    if (["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2-codex"].includes(model)) {
      return ["none", ...levels];
    }
  }
  return null;
}

module.exports = { HERMES_THINKING_LEVELS, hermesModelThinkingOptions, readHermesReasoningCatalog };
