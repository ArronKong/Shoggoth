"use strict";
const crypto = require("node:crypto");
const { probeGroupNativeToolSupport } = require("./group-native-capability-probe");

// Preparing an empty Runtime session loads MCP without sending a user prompt,
// starting a WorkRun or granting access to any group. Only authenticated tools/list
// observations (or the Runtime's actual inventory) can promote the capability.
class GroupNativeToolPreparation {
  constructor({ inspect = probeGroupNativeToolSupport, now = Date.now,
    pause = ms => new Promise(resolve => setTimeout(resolve, ms)), maxWaitMs = 10_000, pollMs = 200 } = {}) {
    this.inspect = inspect; this.now = now; this.pause = pause;
    this.maxWaitMs = maxWaitMs; this.pollMs = pollMs;
    this.entries = new WeakMap(); this.pending = new Set(); this.closed = false;
  }
  async probe(input) {
    const proof = await this.inspect(input);
    if (this.closed || input.runId || proof.collaborationActions || !proof.collaborationSupport
      || !input.assertCurrent || !input.host?.host
      || !["session.start", "session.resume", "turn.start"].every(key => input.host.capabilities?.[key] === true)
      || typeof input.host.host.mcpServerStatusList !== "function" && typeof input.host.sessionList !== "function") return proof;
    let entry = this.entries.get(input.host.host);
    if (!entry) {
      entry = { callbacks: new Set(), done: false }; this.entries.set(input.host.host, entry);
      const task = Promise.resolve().then(() => this.#prepare(input)).catch(() => {
        // Unknown session acceptance is retained by the Runtime's ledger. This
        // host never starts a second preparation session in response to polling.
      }).finally(() => {
        entry.done = true; this.pending.delete(task);
        if (!this.closed) for (const callback of entry.callbacks) { try { callback(); } catch {} }
        entry.callbacks.clear();
      });
      this.pending.add(task);
    }
    if (!entry.done && typeof input.onCapabilitiesChanged === "function" && entry.callbacks.size < 64) {
      entry.callbacks.add(input.onCapabilitiesChanged);
    }
    return proof;
  }
  async #prepare(input) {
    const { host, profile, binding } = input;
    const fence = () => { if (this.closed) throw Error("group preparation stopped"); input.assertCurrent(); };
    fence();
    if (typeof host.host.mcpServerStatusList !== "function") {
      const source = "shoggoth:group-tools:" + crypto.createHash("sha256")
        .update(JSON.stringify([binding, profile.workspace, profile.runtimeHostPermissionPolicy ?? profile.permissionPolicy])).digest("hex");
      const params = { cwd: profile.workspace, permissionPolicy: profile.permissionPolicy,
        permissionMode: profile.permissionMode };
      if (profile.defaultModel) params.model = profile.defaultModel;
      // Query metadata by the host's own contract, never inspect private ledger
      // files or ordinary conversation history. A reconnect reuses this exact
      // empty session instead of accumulating hidden sessions on every host.
      let found = null;
      for (const archived of [false, true]) {
        let cursor; const cursors = new Set(); let exhausted = false;
        for (let page = 0; page < 5; page++) {
          fence();
          const listed = await host.sessionList({ limit: 100, archived, ...(cursor ? { cursor } : {}) });
          fence();
          if (!Array.isArray(listed?.data)) throw Error("group preparation inventory invalid");
          for (const candidate of listed.data) if (candidate.source === source) {
            if (found || archived || candidate.archived) throw Error("group preparation session ambiguous");
            if (typeof candidate.id !== "string" || !candidate.id) throw Error("group preparation session invalid");
            found = candidate;
          }
          if (!listed.nextCursor) { exhausted = true; break; }
          if (cursors.has(listed.nextCursor)) throw Error("group preparation inventory repeated");
          cursor = listed.nextCursor; cursors.add(cursor);
        }
        if (!exhausted) throw Error("group preparation inventory incomplete");
      }
      fence();
      const response = found ? await host.sessionResume({ ...params, sessionId: found.id })
        : await host.sessionStart({ ...params, source, persistent: false });
      fence();
      if (typeof response?.session?.id !== "string" || !response.session.id
        || found && response.session.id !== found.id) throw Error("group preparation session missing");
    }
    const deadline = this.now() + this.maxWaitMs;
    do {
      fence();
      const proof = await this.inspect(input);
      fence();
      if (proof.groupTools && proof.collaborationActions) return;
      if (this.now() >= deadline) return;
      await this.pause(Math.min(this.pollMs, deadline - this.now()));
    } while (!this.closed);
  }
  async idle() { await Promise.allSettled([...this.pending]); }
  stop() { this.closed = true; }
}
module.exports = { GroupNativeToolPreparation };
