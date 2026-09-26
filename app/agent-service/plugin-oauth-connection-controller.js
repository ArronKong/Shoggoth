"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { PluginOAuthSessionManager } = require("./plugin-oauth-session");
const { newPluginCredentialRef } = require("./plugin-credential-vault");
const { serviceError } = require("./security");
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code = "PLUGIN_REQUEST_INVALID") => { throw serviceError(code, "OAuth 连接请求无效或已失效"); };
const ACTIVE = new Set(["starting", "pending", "exchanging"]);

class PluginOAuthConnectionController {
  #pending = new Map();
  #flows = new Map();
  #starts = new Set();
  #closed = false;

  constructor({ store, productStore, manager, providers, vault, now = Date.now,
    lifetimeMs = 5 * 60_000 } = {}) {
    if (typeof store?.performManagementOperation !== "function" || typeof store?.createConnection !== "function"
      || typeof productStore?.getAgentProfile !== "function" || typeof manager?.component !== "function"
      || typeof providers?.forEndpoint !== "function" || typeof providers?.fetchFor !== "function"
      || typeof vault?.storePendingOAuthTokens !== "function" || typeof vault?.verifyAndActivate !== "function"
      || typeof now !== "function" || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000
      || lifetimeMs > 10 * 60_000) throw new TypeError("OAuth controller requires trusted Service dependencies");
    Object.assign(this, { store, productStore, manager, providers, vault, now, lifetimeMs });
  }

  #context(input) {
    if (this.#closed) fail("PLUGIN_UNAVAILABLE");
    const profile = this.productStore.getAgentProfile(input.profileId);
    if (!profile?.enabled) fail("PLUGIN_BINDING_INVALID");
    const context = this.manager.component(input.installationId, input.componentId);
    if (context.installation.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
    if (context.component.transport !== "streamable-http") fail("PLUGIN_OAUTH_PROVIDER_UNSUPPORTED");
    const provider = this.providers.forEndpoint(new URL(context.component.spec.url).href);
    const binding = this.store.listBindingsForProfile(input.profileId).find(item =>
      item.installationId === input.installationId && item.componentId === input.componentId) || null;
    return { profile, ...context, binding, provider };
  }

  #fence(context) {
    return digest({ profile: context.profile, installation: context.installation,
      descriptor: context.component.descriptorDigest, binding: context.binding,
      providerId: context.provider.id, scopes: context.provider.scopes,
      endpoint: context.provider.serverUrl, clientId: context.provider.clientId });
  }

  prepare(input) {
    this.sweep();
    if (!exact(input, ["profileId", "installationId", "componentId", "expectedRevision", "operationId"])
      || !["profileId", "installationId", "operationId"].every(key => typeof input[key] === "string" && ID.test(input[key]))
      || typeof input.componentId !== "string" || !HASH.test(input.componentId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail();
    const context = this.#context(input);
    if (this.#pending.size >= 32 || this.#flows.size >= 128
      || [...this.#flows.values()].filter(flow => ACTIVE.has(flow.status)).length >= 16) {
      fail("PLUGIN_CONNECTION_LIMIT");
    }
    const challenge = crypto.randomUUID();
    const expiresAt = this.now() + 120_000;
    this.#pending.set(challenge, { input: structuredClone(input), fence: this.#fence(context), expiresAt });
    return { challenge, expiresAt, summary: { action: "oauth-connect", agent: context.profile.name,
      package: context.release.name, capability: context.component.name, provider: context.provider.name,
      scopes: [...context.provider.scopes], reconnect: context.binding !== null } };
  }

  commit(input) {
    const pending = this.#commit(input);
    this.#starts.add(pending);
    void pending.finally(() => this.#starts.delete(pending)).catch(() => {});
    return pending;
  }

  async #commit(input) {
    if (!exact(input, ["challenge", "approved"]) || typeof input.challenge !== "string"
      || typeof input.approved !== "boolean") fail();
    const pending = this.#pending.get(input.challenge);
    this.#pending.delete(input.challenge);
    if (!pending || pending.expiresAt <= this.now() || this.#closed) fail("PLUGIN_CONSENT_EXPIRED");
    if (!input.approved) return { canceled: true, flow: null };
    this.sweep();
    if (this.#flows.size >= 128 || [...this.#flows.values()].filter(flow => ACTIVE.has(flow.status)).length >= 16) {
      fail("PLUGIN_CONNECTION_LIMIT");
    }
    const context = this.#context(pending.input);
    if (this.#fence(context) !== pending.fence) fail("REVISION_CONFLICT");
    const connectionId = digest(["oauth", pending.input.profileId, pending.input.installationId,
      pending.input.componentId, pending.input.operationId]);
    if (this.store.getConnection(connectionId) || this.store.getOperation(pending.input.operationId)
      || [...this.#flows.values()].some(flow => ACTIVE.has(flow.status)
        && flow.input.profileId === pending.input.profileId
        && flow.input.installationId === pending.input.installationId
        && flow.input.componentId === pending.input.componentId)) fail("REVISION_CONFLICT");
    const flowId = crypto.randomUUID();
    const flow = { flowId, input: pending.input, connectionId, provider: context.provider,
      status: "starting", expiresAt: this.now() + this.lifetimeMs, reasonCode: null, bindingId: null,
      fence: null, server: null, tasks: new Set(), timer: null, receipt: null, abort: new AbortController() };
    let finishStart;
    flow.startFinished = new Promise(resolve => { finishStart = resolve; });
    this.#flows.set(flowId, flow);
    try {
      // Reconnect immediately narrows this Profile's binding, including queued
      // calls. Other Profiles sharing the old Connection keep their authority.
      if (context.binding) {
        this.store.revokeAllGrants({ bindingId: context.binding.bindingId, expectedRevision: context.binding.revision });
        this.store.setBindingEnabled({ bindingId: context.binding.bindingId, enabled: false,
          expectedRevision: context.binding.revision });
      }
      flow.fence = this.#fence(this.#context(flow.input));
      this.store.createConnection({ connectionId, installationId: flow.input.installationId,
        componentId: flow.input.componentId, endpointIdentity: flow.provider.serverUrl,
        credentialRef: newPluginCredentialRef() });
      const trustedFetch = this.providers.fetchFor(flow.provider.serverUrl);
      flow.oauth = new PluginOAuthSessionManager({ fetchImpl: (input, init) => {
        const request = new Request(input, init);
        return trustedFetch(request, { signal: AbortSignal.any([request.signal, flow.abort.signal]) });
      },
        now: this.now, lifetimeMs: this.lifetimeMs });
      flow.server = http.createServer((request, response) => {
        const task = this.#callback(flow, request, response);
        flow.tasks.add(task);
        void task.finally(() => flow.tasks.delete(task)).catch(() => {});
      });
      flow.server.headersTimeout = 5000;
      flow.server.requestTimeout = 5000;
      flow.server.maxConnections = 4;
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(serviceError("CONNECTION_AUTH_REQUIRED", "OAuth 连接已取消"));
        flow.abort.signal.addEventListener("abort", onAbort, { once: true });
        flow.server.once("error", reject);
        flow.server.listen({ port: 0, host: "127.0.0.1", signal: flow.abort.signal }, () => {
          flow.abort.signal.removeEventListener("abort", onAbort); resolve();
        });
      });
      this.#assert(flow);
      const redirectUrl = `http://127.0.0.1:${flow.server.address().port}/oauth/callback`;
      flow.redirectUrl = redirectUrl;
      const started = await flow.oauth.start({ connectionId, serverUrl: flow.provider.serverUrl, redirectUrl,
        clientId: flow.provider.clientId, scope: flow.provider.scopes.join(" "), allowLoopback: true });
      this.#assert(flow);
      const authorizationUrl = this.providers.assertAuthorizationUrl(flow.provider.serverUrl, started.authorizationUrl, redirectUrl);
      flow.status = "pending";
      flow.timer = setTimeout(() => { this.#terminate(flow, "expired", "PLUGIN_CONSENT_EXPIRED"); },
        Math.max(1, flow.expiresAt - this.now()));
      flow.timer.unref?.();
      return { canceled: false, flow: { flowId, status: "pending", expiresAt: flow.expiresAt, authorizationUrl } };
    } catch (error) {
      this.#terminate(flow, "failed", "CONNECTION_AUTH_REQUIRED");
      throw error;
    } finally { finishStart(); }
  }

  #assert(flow) {
    if (this.#closed || !ACTIVE.has(flow.status) || flow.expiresAt <= this.now()) fail("PLUGIN_CONSENT_EXPIRED");
    if (this.#fence(this.#context(flow.input)) !== flow.fence) fail("REVISION_CONFLICT");
  }

  async #callback(flow, request, response) {
    const finish = (status, message) => {
      if (response.destroyed) return;
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'" });
      response.end(message);
    };
    if (flow.status !== "pending" || request.method !== "GET" || !flow.redirectUrl
      || request.headers.host !== new URL(flow.redirectUrl).host || typeof request.url !== "string"
      || request.url.length > 16_384) { finish(400, "Invalid authorization callback"); return; }
    let callback;
    try { callback = new URL(request.url, flow.redirectUrl); }
    catch { finish(400, "Invalid authorization callback"); return; }
    if (callback.origin !== new URL(flow.redirectUrl).origin || callback.pathname !== "/oauth/callback") {
      finish(400, "Invalid authorization callback"); return;
    }
    try {
      this.#assert(flow);
      flow.status = "exchanging";
      await flow.oauth.finish({ connectionId: flow.connectionId, callbackUrl: callback.href });
      this.#assert(flow);
      await flow.oauth.consumeTokens({ connectionId: flow.connectionId, commit: async (tokens, metadata) => {
        this.#assert(flow);
        if (new URL(metadata.issuer).href !== flow.provider.issuer || metadata.audience !== flow.provider.audience
          || JSON.stringify(metadata.requestedScopes) !== JSON.stringify(flow.provider.scopes)) fail("CONNECTION_AUTH_REQUIRED");
        await this.vault.storePendingOAuthTokens({ connectionId: flow.connectionId,
          expectedRevision: 1, tokens, ...metadata });
      } });
      this.#assert(flow);
      await this.vault.verifyAndActivate({ connectionId: flow.connectionId, expectedRevision: 1 });
      this.#assert(flow);
      const result = this.store.performManagementOperation({ operationId: flow.input.operationId, kind: "mcp-connect",
        fingerprint: digest(["oauth-connect", flow.input, flow.connectionId]), apply: () => {
          this.#assert(flow);
          let binding = this.#context(flow.input).binding;
          if (!binding) binding = this.store.createBinding({ bindingId: digest(["mcp-binding", flow.input.profileId,
            flow.input.installationId, flow.input.componentId]), profileId: flow.input.profileId,
          installationId: flow.input.installationId, componentId: flow.input.componentId, connectionId: flow.connectionId });
          else binding = this.store.setMcpBindingConnection({ bindingId: binding.bindingId,
            connectionId: flow.connectionId, expectedRevision: binding.revision });
          binding = this.store.setBindingEnabled({ bindingId: binding.bindingId, enabled: true, expectedRevision: binding.revision });
          return { kind: "mcp-connect", profileId: flow.input.profileId, bindingId: binding.bindingId,
            toolIdentity: null, revision: binding.revision };
        } });
      flow.receipt = result.result;
      flow.bindingId = result.result.bindingId;
      flow.status = "ready";
      finish(200, "Authorization completed. You can close this window.");
      this.#closeListener(flow);
    } catch (error) {
      if (flow.status === "exchanging" && flow.oauth.status(flow.connectionId).status === "pending") {
        flow.status = "pending"; // A wrong state must not consume someone else's login.
      } else if (ACTIVE.has(flow.status)) this.#terminate(flow, "failed", "CONNECTION_AUTH_REQUIRED");
      finish(400, "Authorization was not completed. Return to Shoggoth and try again.");
    }
  }

  #closeListener(flow) {
    clearTimeout(flow.timer);
    flow.server?.close();
    flow.server?.closeIdleConnections();
  }

  #terminate(flow, status, reasonCode) {
    if (!ACTIVE.has(flow.status)) return;
    flow.status = status; flow.reasonCode = reasonCode;
    flow.abort.abort();
    flow.oauth?.cancel(flow.connectionId);
    const connection = this.store.getConnection(flow.connectionId);
    if (connection && connection.state !== "disconnected") this.store.setConnectionIdentity({
      connectionId: flow.connectionId, principalIdentity: connection.principalIdentity || `unverified:${flow.flowId}`,
      state: "disconnected", expectedRevision: connection.revision });
    this.#closeListener(flow);
  }

  #selected(input) {
    if (!exact(input, ["profileId", "flowId"]) || typeof input.profileId !== "string" || !ID.test(input.profileId)
      || typeof input.flowId !== "string" || !ID.test(input.flowId)) fail();
    const flow = this.#flows.get(input.flowId);
    if (!flow || flow.input.profileId !== input.profileId) fail("PLUGIN_OAUTH_FLOW_NOT_FOUND");
    return flow;
  }

  status(input) {
    this.sweep();
    const flow = this.#selected(input);
    if (ACTIVE.has(flow.status)) {
      try { this.#assert(flow); } catch { this.#terminate(flow, "failed", "CONNECTION_IDENTITY_CHANGED"); }
    }
    return { flowId: flow.flowId, status: flow.status, expiresAt: flow.expiresAt,
      reasonCode: flow.reasonCode, bindingId: flow.bindingId, receipt: flow.receipt ? { ...flow.receipt } : null };
  }

  cancel(input) {
    const flow = this.#selected(input);
    this.#terminate(flow, "canceled", null);
    return this.status(input);
  }

  async cancelStaleForBindings(bindings) {
    if (!Array.isArray(bindings) || bindings.length > 1024 || bindings.some(binding =>
      !binding || !ID.test(binding.subjectId) || !ID.test(binding.installationId)
      || !HASH.test(binding.componentId))) fail();
    const matches = input => bindings.some(binding => input.profileId === binding.subjectId
      && input.installationId === binding.installationId && input.componentId === binding.componentId);
    for (const [challenge, pending] of this.#pending) {
      if (!matches(pending.input)) continue;
      try { if (this.#fence(this.#context(pending.input)) !== pending.fence) this.#pending.delete(challenge); }
      catch { this.#pending.delete(challenge); }
    }
    const selected = [...this.#flows.values()].filter(flow => {
      if (!ACTIVE.has(flow.status) || !matches(flow.input)) return false;
      try { this.#assert(flow); return false; } catch { return true; }
    });
    // Synchronous termination fences late token verification and binding commit
    // before waiting for any already-running callback or metadata request. A
    // retry of old disconnect cleanup cannot cancel a newly confirmed login.
    for (const flow of selected) this.#terminate(flow, "canceled", "CONNECTION_IDENTITY_CHANGED");
    await Promise.allSettled(selected.flatMap(flow => [flow.startFinished, ...flow.tasks]));
    return { canceled: selected.length };
  }

  sweep() {
    const now = this.now();
    for (const [id, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(id);
    for (const [id, flow] of this.#flows) {
      if (flow.expiresAt <= now) this.#terminate(flow, "expired", "PLUGIN_CONSENT_EXPIRED");
      if (flow.expiresAt + 10 * 60_000 <= now && !ACTIVE.has(flow.status)) this.#flows.delete(id);
    }
  }

  async close() {
    this.#closed = true; this.#pending.clear();
    for (const flow of this.#flows.values()) this.#terminate(flow, "canceled", null);
    await Promise.allSettled([...this.#starts, ...[...this.#flows.values()].flatMap(flow => [...flow.tasks])]);
    this.#flows.clear();
  }
}

module.exports = { PluginOAuthConnectionController };
