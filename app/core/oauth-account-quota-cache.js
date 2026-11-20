"use strict";

const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("../agent-service/private-file");
const { validQuotaScope, validQuotaSnapshot } = require("./oauth-account-quota");

const MAX_ENTRIES = 64;
const MAX_BYTES = 1024 * 1024;
const SLOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const slotKey = (backend, provider) => JSON.stringify([backend, provider]);

function createOAuthAccountQuotaCache({ trustedRoot, directory = "ui-state" }) {
  const file = path.join(trustedRoot, directory, "oauth-account-quotas.json");
  const snapshots = new Map();
  try {
    recoverInterruptedPrivateFile(file, { trustedRoot });
    const saved = JSON.parse(readPrivateFile(file, { maxBytes: MAX_BYTES }).toString("utf8"));
    if (saved?.version === 1 && Array.isArray(saved.entries) && saved.entries.length <= MAX_ENTRIES) {
      for (const entry of saved.entries) {
        if (!Array.isArray(entry) || entry.length !== 3) continue;
        const [backend, provider, quota] = entry;
        if (typeof backend === "string" && SLOT_ID.test(backend) && typeof provider === "string" && SLOT_ID.test(provider)
          && validQuotaSnapshot(quota) && quota.status === "available" && validQuotaScope(quota.quotaScope)) {
          snapshots.set(slotKey(backend, provider), quota);
        }
      }
    }
  } catch { /* This cache can be rebuilt from successful reads. */ }

  const accounts = new Map();
  let sequence = 0;
  let dirty = false;

  function persist() {
    if (!dirty) return;
    try {
      const entries = [...snapshots].map(([key, quota]) => [...JSON.parse(key), quota]);
      atomicWritePrivateFile(file, JSON.stringify({ version: 1, entries }), { trustedRoot });
      dirty = false;
    } catch { /* Keep serving live quotas if local storage is unavailable. */ }
  }

  // Order identity observations by request start. A late reply must not restore
  // data from before an account change, even if that account later signs in again.
  function observe(key, scope, order) {
    const before = accounts.get(key);
    if (before && order < before.observedAt) {
      return before.scope === scope && order >= before.changedAt ? before : null;
    }
    const saved = snapshots.get(key);
    const changed = (before && before.scope !== scope) || (saved && saved.quotaScope !== scope);
    const state = { scope, observedAt: order, changedAt: changed ? order : before?.changedAt ?? 0,
      savedAt: changed ? 0 : before?.savedAt ?? 0 };
    accounts.set(key, state);
    if (saved && saved.quotaScope !== scope) dirty = snapshots.delete(key);
    return state;
  }

  return {
    begin() { return ++sequence; },
    attach(backend, inventory, order) {
      if (!Array.isArray(inventory?.providers)) return inventory;
      const providers = inventory.providers.map(provider => {
        const status = provider?.status;
        if (!provider?.id || !status || status.error || status.verification) return provider;
        const key = slotKey(backend, provider.id);
        if (provider.connection?.enabled === false) return provider;
        if ((status.loggedIn === false || provider.quotaScope === null)
          && (provider.canReadQuota || accounts.has(key) || snapshots.has(key))) {
          observe(key, null, order);
          return provider;
        }
        if (!provider.canReadQuota || !status.loggedIn || !validQuotaScope(provider.quotaScope) || !observe(key, provider.quotaScope, order)
          || (status.expiresAt && !(Date.parse(status.expiresAt) > Date.now()))) return provider;
        const cachedQuota = snapshots.get(key);
        return cachedQuota ? { ...provider, cachedQuota } : provider;
      });
      persist();
      return { ...inventory, providers };
    },
    complete(backend, provider, quota, order) {
      const key = slotKey(backend, provider);
      if (order < (accounts.get(key)?.changedAt ?? 0)) return { status: "unavailable" };
      if (quota.status !== "available" || !validQuotaScope(quota.quotaScope)) return quota;
      const account = observe(key, quota.quotaScope, order);
      if (!account) return { status: "unavailable" };
      if (order < account.savedAt) return snapshots.get(key) ?? quota;
      account.savedAt = order;
      snapshots.delete(key);
      snapshots.set(key, quota);
      if (snapshots.size > MAX_ENTRIES) snapshots.delete(snapshots.keys().next().value);
      dirty = true;
      persist();
      return quota;
    },
    forget(backend, provider) {
      observe(slotKey(backend, provider), null, ++sequence);
      persist();
    },
  };
}

module.exports = { createOAuthAccountQuotaCache };
