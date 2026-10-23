"use strict";

// Product defaults are projected only after Core has supplied authenticated
// policy. An explicit old allowlist (including []) and saved switches win.
function defaultNativeMemoryProjection() {
  return { revision: 0, config: { plugins: { entries: {
    "active-memory": { enabled: true, config: { mode: "escalate" } },
  } } } };
}

function projectActiveMemoryDefaults(config, profileIds) {
  const entry = config.plugins?.entries?.["active-memory"];
  const authenticated = Number.isSafeInteger(config._shoggothConfigRevision)
    && config._shoggothConfigRevision >= 0;
  if (!authenticated && entry?.enabled !== true) return config;
  const policy = entry?.config || {};
  const validList = values => Array.isArray(values)
    && values.every(value => typeof value === "string");
  // Invalid trusted/offline input must not become an enabled broad roster.
  const valid = (policy.agents === undefined || validList(policy.agents))
    && (policy.excludedAgents === undefined || validList(policy.excludedAgents));
  const exclusions = new Set((validList(policy.excludedAgents) ? policy.excludedAgents : []).map(value => value.trim()));
  const candidates = valid ? policy.agents ?? profileIds : [];
  const agents = [...new Set(candidates.filter(value => typeof value === "string")
    .map(value => value.trim()).filter(value => value && !exclusions.has(value)))];
  return { ...config, plugins: { ...config.plugins, entries: { ...config.plugins?.entries,
    "active-memory": { ...entry, enabled: entry?.enabled ?? true,
      config: { ...policy,
        // Native Runtime discovery and the first authorized index lookup share
        // the hook's wall-clock budget. Keep the native 15s recall budget and
        // allow bounded cold setup only when the user left both times unset.
        ...(policy.timeoutMs === undefined && policy.setupGraceTimeoutMs === undefined ? { setupGraceTimeoutMs: 10_000 } : {}),
        mode: policy.mode ?? "escalate", agents } },
  } } };
}

module.exports = { defaultNativeMemoryProjection, projectActiveMemoryDefaults };
