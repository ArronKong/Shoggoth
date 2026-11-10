"use strict";
const { digest, fail } = require("./proactive-service-protocol");
const { readRuntimeAuthenticationState } = require("./runtime-adapter");
const codexSessionProvider = require("./codex-session-provider");
const POLICY = "proactive-main-session-runtime-v5";
class ProactiveRuntimeVerifier {
  constructor({ store, productStore, codexAdapter, runtimeManager, getMainSession = () => null, now = Date.now }) {
    this.store = store; this.products = productStore; this.adapter = codexAdapter; this.runtimes = runtimeManager;
    this.now = now; this.pending = new Map();
    this.getMainSession = getMainSession;
  }
  #profile(id) { try {
    const session = this.getMainSession(id);
    const profile = this.products.resolveAgentRuntimeProfile(id, session?.runtimeBindingId ?? undefined);
    if (session?.modelProviderRef && codexSessionProvider.supportsSessionProviders(profile)) {
      return { ...profile, providerRef: codexSessionProvider.resolveProviderSelection(this.products, profile, session.modelProviderRef) };
    }
    return profile;
  } catch { return null; } }
  #fingerprint(profile) { return digest([POLICY, profile.id, profile.selectedBindingId, profile.runtime,
    profile.runtimeProfileId, profile.runtimeAccountId, profile.permissionPolicy, profile.providerRef,
    this.runtimes?.runtimeIdentityKey?.({ runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId }) ?? null]); }
  #supported(profile) { return !!profile; }
  capability(value) {
    const profile = this.#profile(value.id);
    if (!this.#supported(profile)) return { semanticVerified: false, reason: "PROACTIVE_RUNTIME_UNVERIFIED" };
    const proof = this.store.getCursor(`capability:${profile.id}`);
    let fingerprint; try { fingerprint = this.#fingerprint(profile); } catch { return { semanticVerified: false, reason: "PROACTIVE_RUNTIME_UNVERIFIED" }; }
    return proof?.policy === POLICY && proof.fingerprint === fingerprint
      ? { semanticVerified: true, reason: null, runtime: profile.runtime, runtimeAccountId: profile.runtimeAccountId,
        verification: { policy: POLICY, verifiedAt: proof.verifiedAt } }
      : { semanticVerified: false, reason: "PROACTIVE_RUNTIME_UNVERIFIED" };
  }
  async verify(id) {
    if (this.pending.has(id)) return this.pending.get(id);
    const task = this.#verify(id).finally(() => this.pending.delete(id)); this.pending.set(id, task); return task;
  }
  async #verify(id) {
    const profile = this.#profile(id);
    if (!profile || !profile.enabled) fail("PROACTIVE_PROFILE_UNAVAILABLE");
    if (!this.#supported(profile)) fail("PROACTIVE_RUNTIME_UNVERIFIED");
    this.store.setCursor(`capability:${id}`, null);
    let handle;
    try {
      const codex = profile.runtime === "codex";
      handle = await (codex ? this.adapter : this.runtimes).acquire({ runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId }, { permissionPolicy: profile.permissionPolicy });
      const auth = await readRuntimeAuthenticationState(handle, { allowDeferred: !codex });
      // The built-in Codex process reports ChatGPT sign-in; a default source
      // with its own credential (custom endpoint) does not depend on it.
      const ownCredential = codex && codexSessionProvider.supportsSessionProviders(profile)
        && !codexSessionProvider.routeRequiresOpenaiAuth(this.products, { provider: { providerRef: profile.providerRef } });
      if (!ownCredential && (auth.status === "unauthenticated" || codex && auth.status !== "authenticated")) {
        fail("PROACTIVE_PROFILE_UNAVAILABLE");
      }
      require("./runtime-capability-evidence").assertRuntimeOperation(handle, "chat");
      if (["sessionList", "sessionStart", "sessionRead", "turnStart"].some(name => typeof handle[name] !== "function")) fail("PROACTIVE_RUNTIME_UNVERIFIED");
      const current = this.#profile(id); if (!current || this.#fingerprint(current) !== this.#fingerprint(profile)) fail("PROACTIVE_SCOPE_INVALID");
      this.store.setCursor(`capability:${id}`, { policy: POLICY, fingerprint: this.#fingerprint(profile), verifiedAt: this.now() });
      return this.capability(profile);
    } catch (error) {
      if (["PROACTIVE_PROFILE_UNAVAILABLE", "PROACTIVE_SCOPE_INVALID"].includes(error.code)) throw error;
      fail("PROACTIVE_RUNTIME_UNVERIFIED");
    }
  }
}
module.exports = { ProactiveRuntimeVerifier, PROACTIVE_MAIN_SESSION_POLICY: POLICY };
