"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const core = require("./core.cjs");
const { validateNativeMemoryLocalModels } = require("../native-memory-config-protocol");

// The original provider owns processes globally and its model alias is fixed.
// Coordinate complete requests across Product Service instances, including
// Services sharing a preset file through different loopback endpoints.
const reservations = new Map(), owners = new Set();
let stopping;
const failure = code => Object.assign(new Error(code), { code });
const stamp = config => JSON.stringify(config);
const canonical = file => {
  const absolute = path.resolve(file);
  try { return fs.realpathSync.native(absolute); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    return path.join(canonical(path.dirname(absolute)), path.basename(absolute));
  }
};

function reserve(keys) {
  const previous = [...new Set(keys.map(key => reservations.get(key)).filter(Boolean))];
  let release;
  const ticket = new Promise(resolve => { release = resolve; });
  for (const key of keys) reservations.set(key, ticket);
  return { ready: Promise.all(previous), release() {
    for (const key of keys) if (reservations.get(key) === ticket) reservations.delete(key);
    release();
  } };
}

class MemoryLocalEmbeddingHost {
  constructor({ getConfig, assertCurrent = () => {} }) {
    if (typeof getConfig !== "function") throw new TypeError("Local embedding configuration is required");
    this.getConfig = getConfig; this.assertAuthority = assertCurrent;
    this.scope = new AsyncLocalStorage(); this.controller = new AbortController();
    this.pending = new Set(); this.leases = new Set(); this.closed = false;
    this.acquireLocalService = this.acquireLocalService.bind(this);
    this.assertLocalEmbeddingConfig = this.assertLocalEmbeddingConfig.bind(this);
    this.runLocalEmbedding = this.runLocalEmbedding.bind(this);
    this.acquireConfigured = core.createConfiguredProviderLocalServiceAcquirer(() => {
      const operation = this.scope.getStore();
      if (!operation) throw failure("MEMORY_SCOPE_REVOKED");
      operation.check(); return operation.options.config;
    });
  }

  provider(config) {
    const provider = config?.models?.providers?.["llama-cpp"];
    if (!provider) throw failure("MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE");
    validateNativeMemoryLocalModels({ providers: { "llama-cpp": provider } });
    return provider;
  }

  assertLocalEmbeddingConfig({ config, agentId }) {
    if (this.closed) throw failure("MEMORY_SCOPE_REVOKED");
    this.assertAuthority(agentId);
    this.provider(config);
    if (stamp(config) !== stamp(this.getConfig(agentId))) throw failure("MEMORY_CONFIG_CHANGED");
  }

  async acquireLocalService(target, signal) {
    const operation = this.scope.getStore();
    if (!operation) throw failure("MEMORY_SCOPE_REVOKED");
    operation.check();
    const lease = await this.acquireConfigured(target, signal);
    if (!lease) throw failure("MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE");
    let released = false;
    const owned = { release: () => {
      if (released) return;
      released = true; this.leases.delete(owned); return lease.release();
    } };
    this.leases.add(owned);
    try { operation.check(); }
    catch (error) { owned.release(); throw error; }
    return owned;
  }

  runLocalEmbedding({ options, agentId, signal, prepare }, action) {
    this.assertLocalEmbeddingConfig({ config: options.config, agentId });
    const provider = this.provider(options.config), expectedConfig = stamp(options.config);
    const local = core.readLlamaCppIdentityLocalOptions(options);
    const model = core.resolveLlamaCppEmbeddingModel(local);
    // Native modelPromises uses the destination as its global key. Serialize
    // owners of a cache so one owner's cancelled cold download cannot become
    // a second owner's download Promise with a different cancellation scope.
    const keys = [`origin:${new URL(provider.baseUrl).origin}`, `cache:${canonical(model.cacheDir)}`];
    const args = provider.localService.args || [];
    const preset = args.find((_, index) => args[index - 1] === "--models-preset");
    if (preset) keys.push(`preset:${canonical(path.resolve(provider.localService.cwd || process.cwd(), preset))}`);
    const reservation = reserve(keys);
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    const check = () => {
      combined.throwIfAborted(); this.assertAuthority(agentId);
      if (expectedConfig !== stamp(this.getConfig(agentId))) throw failure("MEMORY_CONFIG_CHANGED");
    };
    owners.add(this);
    const run = (async () => {
      // A cancelled queued request still waits for its predecessor before
      // releasing its reservation. Logical cancellation cannot unlock work
      // that still owns native model preparation or an HTTP response body.
      await reservation.ready;
      if (stopping) await stopping;
      check();
      return this.scope.run({ options, check }, async () => {
        // Prewarm through the original resolver with Product cancellation.
        // Original preparation and factory bodies then consume this cache.
        await core.ensureLlamaCppModel({ source: model.source, cacheDir: model.cacheDir,
          download: true, signal: combined });
        check();
        if (prepare) {
          await core.prepareLlamaCppEmbeddingServer(options, model.source, model.isDefault);
          check();
        }
        const result = await action();
        // Factory results must reach their original Registry even if they
        // arrive after retirement, so the Registry can close the actual handle.
        if (!prepare) return result;
        check();
        const expectedPath = await core.ensureLlamaCppModel({ source: model.source,
          cacheDir: model.cacheDir, download: false, signal: combined });
        check();
        const facts = await core.inspectLlamaServerRuntime({ baseUrl: provider.baseUrl,
          modelId: core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID });
        check();
        if (!facts.model.path || canonical(facts.model.path) !== canonical(expectedPath)) {
          throw failure("MEMORY_EMBEDDING_MODEL_MISMATCH");
        }
        return result;
      });
    })();
    this.pending.add(run);
    const complete = run.finally(() => { this.pending.delete(run); reservation.release(); });
    complete.catch(() => {});
    return complete;
  }

  close() {
    this.closed = true; this.controller.abort(failure("MEMORY_SCOPE_REVOKED"));
    if (this.closing) return this.closing;
    const closing = (async () => {
      await Promise.allSettled([...this.pending]);
      for (const lease of [...this.leases]) lease.release();
      const owned = owners.delete(this);
      if (owned && owners.size === 0) {
        const stop = Promise.resolve().then(() => core.stopManagedProviderLocalServices());
        stopping = stop;
        try { await stop; }
        catch (error) { owners.add(this); throw error; }
        finally { if (stopping === stop) stopping = undefined; }
      }
    })();
    this.closing = closing;
    closing.catch(() => { if (this.closing === closing) this.closing = undefined; });
    return closing;
  }
}

module.exports = { MemoryLocalEmbeddingHost };
