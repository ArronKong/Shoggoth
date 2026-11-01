"use strict";
const protocol = require("./runtime-extension-status-protocol");
const { runtimeFeatureSupport } = require("./runtime-capability-evidence");
const { executableFileStamp } = require("./runtime-executable-identity");
// A read must not acquire, await startup, ask a worker, or infer authentication
// from a signed executable. Admission checks immutable catalog/package identity;
// execution features and auth come only from current locally held instances.
function createRuntimeExtensionStatusController({ productStore, extensionCatalog, extensionRuntimeAdapters, runtimeManager }) {
  const packages = new Map();
  const stamps = adapter => (adapter.manifest?.files || []).map(file => executableFileStamp(file.path));
  for (const [runtime, adapter] of extensionRuntimeAdapters) {
    try {
      const before = stamps(adapter);
      // Verify once while establishing the inventory baseline, then use only
      // immutable catalog identity and cheap file stamps for subsequent reads.
      adapter.verify?.();
      const after = stamps(adapter);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("package changed");
      packages.set(runtime, after);
    } catch { packages.set(runtime, null); }
  }
  function read() {
    let catalog;
    try { catalog = extensionCatalog.read({ verifyEnabled: false }); } catch { catalog = null; }
    const accounts = productStore.listRuntimeAccounts().filter(account => account.runtime.startsWith("ext-"));
    if (accounts.length > protocol.MAX_ENTRIES) throw require("./security").serviceError("RUNTIME_EXTENSION_STATUS_INVALID", "Runtime extension status is unavailable");
    const profiles = productStore.listAgentProfiles().filter(profile => profile.enabled && !profile.archivedAt);
    const entries = accounts.map(account => {
      const descriptor = catalog?.find(entry => entry.envelope.manifest.runtime === account.runtime);
      const adapter = extensionRuntimeAdapters.get(account.runtime);
      const result = { runtime: account.runtime, runtimeAccountId: account.id, enabled: descriptor?.enabled === true,
        availability: "unavailable", code: !catalog ? "RUNTIME_EXTENSION_CATALOG_UNAVAILABLE"
          : descriptor && !descriptor.enabled ? "RUNTIME_EXTENSION_DISABLED" : "RUNTIME_EXTENSION_UNAVAILABLE",
        authentication: "unverified", features: runtimeFeatureSupport(null) };
      if (!descriptor?.enabled || !adapter) return result;
      try {
        // The adapter was created only from a verified signed package. Its
        // identity observer compares the current catalog envelope/key and file
        // stamps with that admitted package, without hashing an interpreter.
        const baseline = packages.get(account.runtime);
        if (!baseline || JSON.stringify(baseline) !== JSON.stringify(stamps(adapter))) throw Error("package changed");
        adapter.runtimeIdentityKey({ runtime: account.runtime, runtimeAccountId: account.id, runtimeProfileId: "status-inventory" });
      } catch (error) {
        result.code = error?.code === "RUNTIME_ACCOUNT_GENERATION_STALE" ? error.code : "RUNTIME_EXTENSION_UNTRUSTED";
        return result;
      }
      result.availability = "available"; result.code = null;
      const snapshots = [], seen = new Set();
      for (const profile of profiles) for (const binding of productStore.getAgentRuntimeBindings(profile.id).bindings) {
        if (!binding.enabled || binding.runtime !== account.runtime || binding.runtimeAccountId !== account.id) continue;
        const target = { runtime: binding.runtime, runtimeAccountId: binding.runtimeAccountId, runtimeProfileId: binding.runtimeProfileId };
        const host = runtimeManager.peek?.(target, { permissionPolicy: profile.permissionPolicy });
        if (!host || seen.has(host)) continue;
        let authentication = "unverified";
        // Only Generic ACP exposes a trusted local accessor. A plugin's
        // authenticationState is RPC, including when a handle is already held.
        try {
          const auth = host.host?.transport === "acp" ? host.host.getCachedAuthenticationState?.() : null;
          if (["authenticated", "unauthenticated"].includes(auth?.status)) authentication = auth.status;
        } catch { continue; }
        if (runtimeManager.peek?.(target, { permissionPolicy: profile.permissionPolicy }) !== host) continue;
        seen.add(host); snapshots.push({ authentication, features: runtimeFeatureSupport(host.capabilityEvidence) });
      }
      if (snapshots.length) {
        result.authentication = snapshots.every(snapshot => snapshot.authentication === "authenticated") ? "authenticated"
          : snapshots.every(snapshot => snapshot.authentication === "unauthenticated") ? "unauthenticated" : "unverified";
        result.features = { attachments: ["image", "pdf", "file"].filter(kind => snapshots.every(snapshot => snapshot.features.attachments.includes(kind))),
          ...Object.fromEntries(["resume", "compact", "steer"].map(key => [key, snapshots.every(snapshot => snapshot.features[key] === snapshots[0].features[key])
            ? snapshots[0].features[key] : "unverified"])) };
      }
      return result;
    });
    return protocol.validateResult({ entries });
  }
  return { read };
}
module.exports = { createRuntimeExtensionStatusController };
