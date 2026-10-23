"use strict";

const crypto = require("node:crypto");
const core = require("./core.cjs");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const validId = value => typeof value === "string" && ID.test(value) && !forbidden.has(value);
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isRecord = value => value && Object.getPrototypeOf(value) === Object.prototype;
const transportHeaderNames = new Set(["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "content-length", "te", "trailer", "upgrade"]);
const sensitiveHeader = name => /authorization|cookie|api[-_]?key|token|secret|credential|password/iu.test(name);
const credentialName = /(?:^|[-_])(?:api[-_]?key|access[-_]?token|token|auth|authorization|password|secret|credential|signature|sig)(?:$|[-_])/iu;
const API_KEY_KINDS = new Set(["openai-api-key", "openrouter", "ollama", "lmstudio", "custom-responses", "external-provider-api-key"]);
const OWNER_FIELDS = new Set(["ownerRef", "profileId", "providerId", "baseUrl", "credentialRef", "credentialKind", "revision", "headers"]);

function publicHeaders(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Reflect.ownKeys(value).length > 64) fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID");
  const headers = {}, seen = new Set();
  if (Reflect.ownKeys(value).some(name => typeof name !== "string" || !Object.getOwnPropertyDescriptor(value, name)?.enumerable)) fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID");
  for (const name of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name), lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || forbidden.has(name) || sensitiveHeader(name) || transportHeaderNames.has(lower)
      || seen.has(lower) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "string" || descriptor.value.length > 4096 || /[\r\n\0]/u.test(descriptor.value)) {
      fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID");
    }
    seen.add(lower); headers[name] = descriptor.value;
  }
  return Object.freeze(headers);
}

function endpoint(value) {
  let url; try { url = new URL(value); } catch { fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID"); }
  if (typeof value !== "string" || value.length > 4096 || !["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => credentialName.test(key))
    || /[\u0000-\u0020\u007f]/u.test(value)) fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID");
  return value;
}

// The catalog and credential store are trusted Service resources. A public
// ownerRef never names a SecretStore entry and cannot authorize another Profile
// or destination. Native factories alone construct payloads, auth and identity.
class MemoryRemoteProviderResources {
  constructor({ getConfig, assertCurrent = () => {}, resolveOwner, secretStore } = {}) {
    if (typeof getConfig !== "function" || typeof assertCurrent !== "function"
      || resolveOwner !== undefined && typeof resolveOwner !== "function") throw new TypeError("Invalid remote memory resources");
    this.getConfig = getConfig; this.assertAuthority = assertCurrent;
    this.resolveOwner = resolveOwner || (() => null); this.secretStore = secretStore;
    this.controller = new AbortController(); this.pending = new Set(); this.handles = new Set(); this.adapters = new Map();
    this.closed = false;
    for (const name of ["capture", "assertCurrent", "resolveAdapter", "close"]) this[name] = this[name].bind(this);
  }
  refs(agentId, cfg = this.getConfig(agentId)) {
    if (!validId(agentId)) fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID");
    const global = cfg.memory?.search?.providerRefs || {}, selected = cfg.agents?.entries?.[agentId] ?? cfg.agents?.list?.find(agent => agent.id === agentId);
    const local = selected?.memory?.search?.providerRefs || {};
    if (!isRecord(global) || !isRecord(local)) fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID");
    const refs = {};
    for (const source of [global, local]) for (const providerId of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, providerId);
      if (!validId(providerId) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !validId(descriptor.value)) {
        fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID");
      }
      refs[providerId] = descriptor.value;
    }
    return Object.fromEntries(Object.entries(refs).sort(([a], [b]) => a.localeCompare(b)));
  }
  describe(agentId, providerId, ownerRef) {
    let entry; try { entry = this.resolveOwner({ agentId, providerId, ownerRef }); }
    catch { fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID"); }
    if (entry === null || entry === undefined) return null;
    if (!isRecord(entry) || Reflect.ownKeys(entry).some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(entry, name);
      return !OWNER_FIELDS.has(name) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
    })) fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID");
    if (entry.ownerRef !== ownerRef || entry.profileId !== agentId
      || entry.providerId !== providerId || !Number.isSafeInteger(entry.revision) || entry.revision < 0
      || !(entry.credentialRef === null || validId(entry.credentialRef))
      || !(entry.credentialKind === null || API_KEY_KINDS.has(entry.credentialKind))
      || (entry.credentialRef === null) !== (entry.credentialKind === null)) fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID");
    const owner = { ownerRef, profileId: agentId, providerId, revision: entry.revision, baseUrl: endpoint(entry.baseUrl),
      credentialRef: entry.credentialRef, credentialKind: entry.credentialKind, headers: publicHeaders(entry.headers) };
    let credentialRevision = null, credentialAvailable = owner.credentialRef === null;
    if (owner.credentialRef !== null) {
      try {
        const metadata = this.secretStore?.listMetadata?.(), revision = this.secretStore?.getCredentialRevision?.(owner.credentialRef);
        const match = Array.isArray(metadata) ? metadata.filter(value => value?.credentialRef === owner.credentialRef) : [];
        credentialAvailable = match.length === 1 && match[0].kind === owner.credentialKind && Number.isSafeInteger(revision) && revision >= 0;
        if (credentialAvailable) credentialRevision = revision;
      } catch { fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID"); }
    }
    return Object.freeze({ ...owner, credentialRevision, credentialAvailable });
  }
  snapshot(agentId) {
    if (this.closed) fail("MEMORY_SCOPE_REVOKED");
    this.assertAuthority(agentId);
    const config = this.getConfig(agentId), refs = this.refs(agentId, config);
    const owners = Object.entries(refs).map(([providerId, ownerRef]) => ({ providerId, ownerRef,
      owner: this.describe(agentId, providerId, ownerRef) }));
    // Admission is separate from native availability/fallback. A configured
    // primary destination cannot borrow its key or hide a destination mismatch
    // behind a valid fallback. This gate reads only public fields and metadata.
    const defaults = config.memory?.search, selected = config.agents?.entries?.[agentId]
      ?? config.agents?.list?.find(agent => agent.id === agentId), override = selected?.memory?.search;
    const enabled = override?.enabled ?? defaults?.enabled ?? true;
    const configured = (override?.provider ?? defaults?.provider)?.trim();
    const providerId = configured === "auto" ? "openai" : configured;
    const baseUrl = override?.remote?.baseUrl ?? defaults?.remote?.baseUrl;
    const primary = owners.find(value => value.providerId === providerId)?.owner;
    if (enabled && primary && !["none", "shoggoth-e5", "local"].includes(providerId) && baseUrl !== undefined
      && !core.embeddingProviderOwnsDestination({ baseUrl: endpoint(baseUrl), providerBaseUrl: primary.baseUrl })) {
      fail("MEMORY_REMOTE_PROVIDER_DESTINATION_MISMATCH");
    }
    return { configHash: hash(config), refs: owners };
  }
  capture(agentId) { return hash(this.snapshot(agentId)); }
  assertCurrent(agentId, stamp) {
    if (this.capture(agentId) !== stamp) fail("MEMORY_REMOTE_PROVIDER_CHANGED");
  }
  binding(agentId, providerId, options) {
    this.assertAuthority(agentId);
    const ownerRef = this.refs(agentId)[providerId];
    if (!ownerRef) fail("MEMORY_EMBEDDING_CREDENTIAL_REQUIRED");
    const owner = this.describe(agentId, providerId, ownerRef);
    if (!owner || !owner.credentialAvailable) fail("MEMORY_EMBEDDING_CREDENTIAL_REQUIRED");
    if (options.remote?.apiKey !== undefined) fail("MEMORY_REMOTE_PROVIDER_OWNER_INVALID");
    const baseUrl = options.remote?.baseUrl;
    if (baseUrl && !core.embeddingProviderOwnsDestination({ baseUrl: endpoint(baseUrl), providerBaseUrl: owner.baseUrl })) {
      fail("MEMORY_REMOTE_PROVIDER_DESTINATION_MISMATCH");
    }
    return owner;
  }
  publicOptions(agentId, providerId, options) {
    const owner = this.binding(agentId, providerId, options), headers = publicHeaders(options.remote?.headers);
    return { owner, options: { ...options, remote: { ...options.remote, baseUrl: owner.baseUrl,
      ...(owner.headers || headers ? { headers: { ...owner.headers, ...headers } } : {}) } } };
  }
  track(action) {
    const pending = Promise.resolve().then(action); this.pending.add(pending);
    pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending)); return pending;
  }
  invoke(agentId, stamp, action, signal, physical = new Set()) {
    this.assertCurrent(agentId, stamp);
    const currentSignal = core.memoryEmbeddingExecutionSignal(signal);
    const combined = currentSignal ? AbortSignal.any([currentSignal, this.controller.signal]) : this.controller.signal;
    const check = () => { combined.throwIfAborted(); this.assertCurrent(agentId, stamp); };
    const pending = this.track(() => core.withMemoryEmbeddingExecution({ signal: combined, assertCurrent: check,
      assertRequestCurrent: check }, () => action(combined)));
    physical.add(pending); pending.then(() => physical.delete(pending), () => physical.delete(pending)); return pending;
  }
  wrapResult(agentId, stamp, result) {
    if (!result.provider) return result;
    const native = result.provider, physical = new Set(); let retired = false, closing;
    const admitted = Object.create(Object.getPrototypeOf(native), Object.getOwnPropertyDescriptors(native));
    const handle = { close: () => {
      retired = true;
      if (closing) return closing;
      const close = (async () => { await Promise.allSettled([...physical]); await native.close?.(); this.handles.delete(handle); })();
      closing = close; close.catch(() => { if (closing === close) closing = undefined; }); return close;
    } };
    const checkHandle = () => { if (retired) fail("MEMORY_SCOPE_REVOKED"); };
    for (const method of ["embed", "embedBatch"]) if (typeof native[method] === "function") Object.defineProperty(admitted, method, {
      enumerable: true, configurable: true, writable: true,
      value: (input, options) => { checkHandle(); return this.invoke(agentId, stamp, signal => native[method](input, { ...options, signal }), options?.signal, physical); },
    });
    Object.defineProperty(admitted, "close", { enumerable: true, configurable: true, writable: true, value: handle.close });
    this.handles.add(handle);
    const runtime = result.runtime?.batchEmbed ? { ...result.runtime, batchEmbed: options => {
      checkHandle(); return this.invoke(agentId, stamp, () => result.runtime.batchEmbed(options), options?.signal, physical);
    } } : result.runtime;
    return { ...result, provider: admitted, runtime };
  }
  resolveAdapter({ agentId, providerId, adapter }) {
    if (!validId(agentId) || !validId(providerId) || !adapter || typeof adapter.create !== "function") throw new TypeError("Invalid remote memory adapter");
    const key = `${agentId}:${providerId}`; let cached = this.adapters.get(key);
    if (cached?.native === adapter) return cached.wrapper;
    const wrapper = Object.create(Object.getPrototypeOf(adapter), Object.getOwnPropertyDescriptors(adapter));
    if (typeof adapter.resolveIndexIdentity === "function") Object.defineProperty(wrapper, "resolveIndexIdentity", {
      enumerable: true, configurable: true, writable: true,
      value: options => adapter.resolveIndexIdentity(this.publicOptions(agentId, providerId, options).options),
    });
    Object.defineProperty(wrapper, "create", { enumerable: true, configurable: true, writable: true, value: options => {
      const stamp = this.capture(agentId), selected = this.publicOptions(agentId, providerId, options);
      return this.track(async () => {
        const check = () => { this.controller.signal.throwIfAborted(); this.assertCurrent(agentId, stamp); };
        check(); let apiKey;
        if (selected.owner.credentialRef !== null) {
          try { apiKey = await this.secretStore.get(selected.owner.credentialRef); }
          catch { fail("MEMORY_EMBEDDING_CREDENTIAL_REQUIRED"); }
          check();
          if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 64 * 1024 || /[\r\n\0]/u.test(apiKey)) fail("MEMORY_EMBEDDING_CREDENTIAL_REQUIRED");
        }
        // Keep the original create result even after logical retirement. Registry
        // admission owns every late physical resource and will close this handle.
        const result = await core.withGuardedFetchRequestAuthority(check, () => adapter.create({ ...selected.options,
          remote: { ...selected.options.remote, ...(apiKey === undefined ? {} : { apiKey }) } }), check);
        apiKey = undefined;
        return this.wrapResult(agentId, stamp, result);
      });
    } });
    this.adapters.set(key, { native: adapter, wrapper }); return wrapper;
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.controller.abort();
    const close = (async () => {
      await Promise.allSettled([...this.pending]);
      const retired = await Promise.allSettled([...this.handles].map(handle => handle.close()));
      const errors = retired.filter(value => value.status === "rejected").map(value => value.reason);
      if (errors.length) throw new AggregateError(errors, "Remote memory resources did not retire");
      this.adapters.clear();
    })();
    this.closePromise = close; close.catch(() => { if (this.closePromise === close) this.closePromise = undefined; }); return close;
  }
}

module.exports = { MemoryRemoteProviderResources };
