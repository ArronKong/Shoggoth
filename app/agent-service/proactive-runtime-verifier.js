"use strict";
const { digest, fail } = require("./proactive-service-protocol");
const { readRuntimeAuthenticationState } = require("./runtime-adapter");
const POLICY = "codex-proactive-readonly-response-tool-v3";
class ProactiveRuntimeVerifier {
  constructor({ store, productStore, codexAdapter, now = Date.now }) {
    this.store = store; this.products = productStore; this.adapter = codexAdapter; this.now = now; this.pending = new Map();
  }
  #profile(id) { try { return this.products.resolveAgentRuntimeProfile(id); } catch { return null; } }
  #fingerprint(profile) { return digest([POLICY, profile.id, profile.selectedBindingId, profile.runtime,
    profile.runtimeProfileId, profile.runtimeAccountId, profile.updatedAt, profile.permissionPolicy, profile.providerRef, profile.defaultModel]); }
  capability(value) {
    const profile = this.#profile(value.id);
    if (!profile || profile.runtime !== "codex") return { semanticVerified: false, reason: "PROACTIVE_RUNTIME_UNVERIFIED" };
    const proof = this.store.getCursor(`capability:${profile.id}`);
    return proof?.policy === POLICY && proof.fingerprint === this.#fingerprint(profile)
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
    if (profile.runtime !== "codex") fail("PROACTIVE_RUNTIME_UNVERIFIED");
    this.store.setCursor(`capability:${id}`, null);
    try {
      const handle = await this.adapter.acquire({ runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId }, { permissionPolicy: profile.permissionPolicy });
      const auth = await readRuntimeAuthenticationState(handle, { allowDeferred: false });
      if (auth.status !== "authenticated") fail("PROACTIVE_PROFILE_UNAVAILABLE");
      await handle.verifyProactiveReview();
      const current = this.#profile(id); if (!current || this.#fingerprint(current) !== this.#fingerprint(profile)) fail("PROACTIVE_SCOPE_INVALID");
      this.store.setCursor(`capability:${id}`, { policy: POLICY, fingerprint: this.#fingerprint(profile), verifiedAt: this.now() });
      return this.capability(profile);
    } catch (error) {
      if (["PROACTIVE_PROFILE_UNAVAILABLE", "PROACTIVE_SCOPE_INVALID"].includes(error.code)) throw error;
      fail("PROACTIVE_RUNTIME_UNVERIFIED");
    }
  }
}
module.exports = { ProactiveRuntimeVerifier, PROACTIVE_READONLY_POLICY: POLICY };
