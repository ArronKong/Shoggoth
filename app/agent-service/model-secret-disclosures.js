"use strict";

const crypto = require("node:crypto");
const { SECRET_MESSAGES } = require("../core/chat-secret-contract");
const failure = code => Object.assign(new Error(SECRET_MESSAGES[code]), { code });
const same = (a, b) => a?.profileId === b?.profileId && a?.sessionId === b?.sessionId;

// Only metadata lives here. The paused HTTP handler retains its own body and
// authentication; neither is exposed through a listing, event, log or receipt.
class ModelSecretDisclosures {
  constructor({ now = Date.now, lifetimeMs = 90_000 } = {}) {
    this.now = now; this.lifetimeMs = lifetimeMs; this.pending = new Map();
  }
  list(scope) {
    const result = [];
    for (const entry of this.pending.values()) {
      if (entry.expiresAt <= this.now()) { entry.finish(null); continue; }
      try { entry.assertCurrent(); } catch { entry.finish(null); continue; }
      if (same(scope, entry.scope)) result.push({ id: entry.id, recipient: "OpenAI", expiresAt: entry.expiresAt });
    }
    return result;
  }
  wait({ scope, signal, assertCurrent }) {
    if (this.pending.size >= 64 || signal.aborted) throw failure("SECRET_DISCLOSURE_EXPIRED");
    assertCurrent();
    const id = crypto.randomBytes(32).toString("hex"), expiresAt = this.now() + this.lifetimeMs;
    return new Promise((resolve, reject) => {
      let timer;
      const entry = { id, scope: Object.freeze({ ...scope }), expiresAt, assertCurrent,
        finish: choice => {
          if (this.pending.get(id) !== entry) return;
          this.pending.delete(id); clearTimeout(timer); signal.removeEventListener("abort", abort);
          if (choice === "original" || choice === "retry") resolve(choice);
          else reject(failure(choice === "cancel" ? "SECRET_DISCLOSURE_CANCELED" : "SECRET_DISCLOSURE_EXPIRED"));
        } };
      const abort = () => entry.finish(null);
      this.pending.set(id, entry);
      timer = setTimeout(abort, this.lifetimeMs); timer.unref?.();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  decide(scope, id, choice) {
    const entry = this.pending.get(id);
    if (!entry || !same(scope, entry.scope) || !["original", "retry", "cancel"].includes(choice)) {
      throw failure("SECRET_DISCLOSURE_EXPIRED");
    }
    if (entry.expiresAt <= this.now()) { entry.finish(null); throw failure("SECRET_DISCLOSURE_EXPIRED"); }
    try { entry.assertCurrent(); } catch { entry.finish(null); throw failure("SECRET_DISCLOSURE_EXPIRED"); }
    entry.finish(choice);
    return { decided: true };
  }
  close() { for (const entry of this.pending.values()) entry.finish(null); }
}
module.exports = { ModelSecretDisclosures };
