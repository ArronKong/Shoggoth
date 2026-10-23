"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { normalizePluginSelection } = require("./plugin-chat-selection");

function fail(code = "PLUGIN_CATALOG_RESTORE_UNAVAILABLE") {
  throw serviceError(code, "插件工具目录尚未恢复或当前连接与授权已变化");
}
function keyOf(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function bounded(value, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("Invalid plugin catalog restore limit");
  return value;
}

// Rediscovery only: this class never creates/updates a Connection, Binding,
// credential or Grant. Its snapshots are fences, not reusable authority.
class PluginCatalogRestorer {
  #active = false;
  #generation = 0;
  #queue = [];
  #jobs = new Map();
  #running = new Set();
  #scheduled = null;
  #startupPending = false;

  constructor({ store, productStore, consent, registry, now = Date.now,
    concurrency, maxPending, timeoutMs, onFailure = null } = {}) {
    if (typeof store?.getCurrentAllowedGrantCount !== "function"
      || typeof store?.getCapabilityRecords !== "function"
      || typeof store?.listGlobalBindings !== "function"
      || typeof store?.listBindingsForProfile !== "function"
      || typeof store?.getAuthorityIncarnation !== "function"
      || typeof productStore?.listAgentProfiles !== "function"
      || typeof productStore?.getAgentProfile !== "function"
      || typeof consent?.discover !== "function" || typeof registry?.listForBinding !== "function"
      || typeof now !== "function" || (onFailure !== null && typeof onFailure !== "function")) {
      throw new TypeError("PluginCatalogRestorer requires current Service authorities");
    }
    Object.assign(this, { store, productStore, consent, registry, now, onFailure });
    this.concurrency = bounded(concurrency, 1, 4, 2);
    this.maxPending = bounded(maxPending, 1, 128, 64);
    // Management reads and selection preparation have a five-second IPC budget.
    this.timeoutMs = bounded(timeoutMs, 50, 4000, 4000);
  }

  #time() {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - this.timeoutMs) fail();
    return now;
  }
  #context(bindingId, profileId) {
    const profile = this.productStore.getAgentProfile(profileId);
    const records = this.store.getCapabilityRecords(bindingId, "__catalog_restore__");
    const { binding, installation, connection } = records || {};
    if (!profile?.enabled || !binding?.enabled || binding.componentKind !== "mcp-server"
      || !((binding.subjectKind === "global" && binding.subjectId === "all-agents")
        || (binding.subjectKind === "native-profile" && binding.subjectId === profileId))
      || installation?.desiredState !== "enabled" || !connection || connection.state !== "ready"
      || connection.installationId !== installation.installationId
      || connection.componentId !== binding.componentId || connection.connectionId !== binding.connectionId
      || !connection.principalIdentity || this.store.hasPendingInstallationDisable(installation.installationId)
      || this.store.getCurrentAllowedGrantCount(bindingId, this.#time()) < 1) return null;
    return { profileId, bindingId, installationId: installation.installationId,
      key: keyOf([this.store.getAuthorityIncarnation(), profileId, binding, installation, connection]) };
  }
  #hasCatalog(context) {
    const records = this.store.getCapabilityRecords(context.bindingId, "__catalog_restore__");
    return Boolean(records && this.registry.listForBinding(records));
  }
  #candidates(installationIds = null, globalOnly = false) {
    const profiles = this.productStore.listAgentProfiles().filter(item => item.enabled)
      .sort((a, b) => a.id.localeCompare(b.id));
    const rows = new Map();
    const add = (binding, profileId) => {
      if (binding.componentKind !== "mcp-server" || (installationIds && !installationIds.has(binding.installationId))) return;
      const context = this.#context(binding.bindingId, profileId);
      if (context) rows.set(binding.bindingId, context);
    };
    if (profiles[0]) for (const binding of this.store.listGlobalBindings()) add(binding, profiles[0].id);
    if (!globalOnly) for (const profile of profiles) for (const binding of this.store.listBindingsForProfile(profile.id)) add(binding, profile.id);
    return [...rows.values()];
  }
  #checkpoint(job) {
    if (!this.#active || job.generation !== this.#generation || job.canceled || this.#time() >= job.deadline) fail("PLUGIN_CATALOG_RESTORE_CANCELED");
    if (this.#context(job.context.bindingId, job.context.profileId)?.key !== job.context.key) fail("CONNECTION_IDENTITY_CHANGED");
    return true;
  }
  #settle(job, error = null) {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer);
    job.state = error ? "failed" : "restored";
    if (error) {
      job.reject(error);
      try { this.onFailure?.({ code: /^[A-Z0-9_]{1,64}$/u.test(error?.code || "") ? error.code : "PLUGIN_CATALOG_RESTORE_UNAVAILABLE" }); } catch { /* observer only */ }
    } else job.resolve();
  }
  #enqueue(context, priority = false) {
    if (this.#hasCatalog(context)) return Promise.resolve();
    const existing = this.#jobs.get(context.bindingId);
    if (existing && existing.context.key === context.key && !existing.settled) {
      if (priority && existing.state === "queued") {
        this.#queue = this.#queue.filter(item => item !== existing); this.#queue.unshift(existing);
      }
      return existing.promise;
    }
    // A timed-out transport still occupies its physical worker until it exits.
    // Repeated UI reads cannot spawn another unbounded set of blocked clients.
    if ([...this.#running].some(job => job.context.bindingId === context.bindingId)) {
      return Promise.reject(serviceError("PLUGIN_CATALOG_RESTORE_BUSY", "插件目录检测仍在结束，请稍后重试"));
    }
    for (const [key, job] of this.#jobs) if (job.settled && !this.#running.has(job)) this.#jobs.delete(key);
    if (this.#jobs.size >= this.maxPending) return Promise.reject(serviceError("PLUGIN_CATALOG_RESTORE_BUSY", "插件目录恢复队列已满"));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Startup is asynchronous; every background rejection is observed even if
    // there is no renderer waiting on this binding yet.
    void promise.catch(() => {});
    const job = { context, generation: this.#generation, deadline: this.#time() + this.timeoutMs,
      promise, resolve, reject, settled: false, canceled: false, state: "queued", timer: null };
    job.timer = setTimeout(() => {
      job.canceled = true; this.#settle(job, serviceError("PLUGIN_CATALOG_RESTORE_TIMEOUT", "插件目录恢复超时"));
      this.#queue = this.#queue.filter(item => item !== job); this.#drain();
    }, this.timeoutMs);
    this.#jobs.set(context.bindingId, job);
    if (priority) this.#queue.unshift(job); else this.#queue.push(job);
    this.#schedule(); return promise;
  }
  #schedule() {
    if (this.#scheduled !== null) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = null;
      if (this.#startupPending) {
        this.#startupPending = false;
        try {
          const candidates = this.#candidates();
          for (const context of candidates.slice(0, this.maxPending)) void this.#enqueue(context).catch(() => {});
        } catch (error) {
          // Optional catalog restoration cannot throw out of an already-started
          // native Service. Close this generation and leave selection unavailable.
          this.stop();
          try { this.onFailure?.({ code: /^[A-Z0-9_]{1,64}$/u.test(error?.code || "") ? error.code : "PLUGIN_CATALOG_RESTORE_UNAVAILABLE" }); } catch { /* observer only */ }
        }
      }
      this.#drain();
    });
  }
  #drain() {
    while (this.#active && this.#running.size < this.concurrency && this.#queue.length) {
      const job = this.#queue.shift();
      if (job.settled) continue;
      this.#running.add(job); job.state = "running";
      void Promise.resolve().then(() => {
        this.#checkpoint(job);
        return this.consent.discover({ profileId: job.context.profileId, bindingId: job.context.bindingId },
          { assertCurrent: () => this.#checkpoint(job) });
      }).then(() => { this.#checkpoint(job); this.#settle(job); }, error => this.#settle(job, error))
        .catch(error => this.#settle(job, error)).finally(() => { this.#running.delete(job); this.#drain(); });
    }
  }

  start() {
    if (this.#active) return this;
    this.#active = true; this.#generation += 1; this.#jobs.clear(); this.#queue = [];
    this.#startupPending = true; this.#schedule();
    return this;
  }
  stop() {
    this.#active = false; this.#generation += 1;
    if (this.#scheduled !== null) clearImmediate(this.#scheduled);
    this.#scheduled = null; this.#startupPending = false; this.#queue = [];
    for (const job of this.#jobs.values()) {
      job.canceled = true;
      this.#settle(job, serviceError("PLUGIN_CATALOG_RESTORE_CANCELED", "插件目录恢复代次已关闭"));
    }
  }
  #selectionCurrent(selection) {
    for (const row of selection) {
      const installation = this.store.getInstallation(row.installationId);
      if (!installation || installation.revision !== row.revision || installation.desiredState !== "enabled"
        || this.store.hasPendingInstallationDisable(row.installationId)) fail("PLUGIN_SELECTION_STALE");
    }
  }
  async prepareSelection(pluginSelection) {
    const selection = normalizePluginSelection(pluginSelection);
    if (!selection || !this.#active) fail("PLUGIN_SELECTION_UNAVAILABLE");
    this.#selectionCurrent(selection);
    const generation = this.#generation;
    const contexts = this.#candidates(new Set(selection.map(row => row.installationId)), true);
    try { await Promise.all(contexts.map(context => this.#enqueue(context, true))); }
    catch { fail("PLUGIN_SELECTION_UNAVAILABLE"); }
    if (!this.#active || generation !== this.#generation) fail("PLUGIN_SELECTION_UNAVAILABLE");
    this.#selectionCurrent(selection);
    // resolvePluginSelection and tool dispatch still evaluate the fresh exact
    // tool contracts against unchanged Grants. Discovery is not authorization.
  }
  getState() {
    const jobs = [...this.#jobs.values()];
    return Object.freeze({ active: this.#active, generation: this.#generation,
      running: this.#running.size, queued: this.#queue.length,
      restored: jobs.filter(job => job.state === "restored").length,
      failed: jobs.filter(job => job.state === "failed").length });
  }
}

module.exports = { PluginCatalogRestorer };
