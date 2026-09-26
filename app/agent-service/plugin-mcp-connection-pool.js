"use strict";

const crypto = require("node:crypto");
const { PluginMcpClient, endpointOf } = require("./plugin-mcp-client");
const { PluginDataScopeLeaseManager } = require("./plugin-data-scope-lease");
const { serviceError } = require("./security");

const HASH = /^[a-f0-9]{64}$/u;
const INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_CONNECTIONS = 32;

function fail(code, message) { throw serviceError(code, message); }
function httpKey(installationId, componentId, connectionId, executionScope) {
  return JSON.stringify([installationId, componentId, connectionId, executionScope]);
}
function identityOf(options = {}) {
  if (!INSTALLATION_ID.test(options.installationId) || !HASH.test(options.scopeId)
    || !HASH.test(options.releaseDigest)
    || typeof options.componentId !== "string" || !options.componentId
    || typeof options.connectionId !== "string" || !options.connectionId
    || typeof options.principalIdentity !== "string" || !options.principalIdentity
    || !Number.isSafeInteger(options.authRevision) || options.authRevision < 1
    || typeof options.executionScope !== "string" || !options.executionScope) {
    fail("PLUGIN_CONNECTION_IDENTITY_INVALID", "插件连接身份不完整");
  }
  const scopeKey = `${options.installationId}:${options.scopeId}`;
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
    releaseDigest: options.releaseDigest, componentId: options.componentId,
    connectionId: options.connectionId, principalIdentity: options.principalIdentity,
    authRevision: options.authRevision, executionScope: options.executionScope,
    command: options.command, args: options.args, cwd: options.cwd,
    env: options.env, timeoutMs: options.timeoutMs, appSupport: options.appSupport === true,
    dependencyFingerprint: options.dependencyFingerprint || null,
  })).digest("hex");
  return { scopeKey, fingerprint };
}
function httpIdentityOf(options = {}) {
  if (!INSTALLATION_ID.test(options.installationId) || !HASH.test(options.releaseDigest)
    || typeof options.componentId !== "string" || !options.componentId || options.componentId.length > 128
    || typeof options.connectionId !== "string" || !options.connectionId || options.connectionId.length > 128
    || typeof options.principalIdentity !== "string" || !options.principalIdentity
    || options.principalIdentity.length > 1024
    || !Number.isSafeInteger(options.authRevision) || options.authRevision < 1
    || typeof options.executionScope !== "string" || !options.executionScope
    || options.executionScope.length > 128
    || typeof options.url !== "string" || options.url.length > 4096
    || (options.credentialProvider != null
      && (typeof options.credentialProvider !== "function"
        || typeof options.credentialProvider.assertCurrent !== "function"))
    || (options.fetchImpl != null && typeof options.fetchImpl !== "function")) {
    fail("PLUGIN_CONNECTION_IDENTITY_INVALID", "插件 HTTP 连接身份不完整");
  }
  const endpoint = endpointOf(options.url, options.allowLoopback === true);
  const connectionKey = httpKey(options.installationId, options.componentId,
    options.connectionId, options.executionScope);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
    releaseDigest: options.releaseDigest, endpoint: endpoint.href,
    principalIdentity: options.principalIdentity, authRevision: options.authRevision,
    allowLoopback: options.allowLoopback === true, timeoutMs: options.timeoutMs,
    versionMode: options.versionMode, appSupport: options.appSupport === true,
  })).digest("hex");
  return { connectionKey, fingerprint,
    credentialProvider: options.credentialProvider ?? null,
    fetchImpl: options.fetchImpl ?? globalThis.fetch };
}

class PluginMcpConnectionPool {
  #leaseManager;
  #authorizeEgress;
  #onToolsChanged;
  #onConnectionInvalidated;
  #canAcquire;
  #slots = new Map();
  #httpSlots = new Map();
  #blockedInstallations = new Set();
  #blockedConnections = new Set();
  #closed = false;

  constructor({ leaseManager, authorizeEgress, onToolsChanged = null,
    onConnectionInvalidated = null,
    canAcquire = null } = {}) {
    if (!(leaseManager instanceof PluginDataScopeLeaseManager)
      || typeof authorizeEgress !== "function"
      || (onToolsChanged !== null && typeof onToolsChanged !== "function")
      || (onConnectionInvalidated !== null
        && typeof onConnectionInvalidated !== "function")
      || (canAcquire !== null && typeof canAcquire !== "function")) {
      throw new TypeError("PluginMcpConnectionPool requires data lease and egress gate");
    }
    this.#leaseManager = leaseManager;
    this.#authorizeEgress = authorizeEgress;
    this.#onToolsChanged = onToolsChanged;
    this.#onConnectionInvalidated = onConnectionInvalidated;
    this.#canAcquire = canAcquire;
  }

  #invalidate(connectionId) {
    const result = this.#onConnectionInvalidated?.({ connectionId });
    if (result && typeof result.then === "function") {
      fail("TOOL_CONTRACT_CHANGED", "连接目录失效回调必须同步完成");
    }
  }

  #markDraining(slot) {
    if (slot.draining) return;
    slot.draining = true;
    this.#invalidate(slot.connectionId);
  }

  #assertInstallationActive(options) {
    if (this.#blockedConnections.has(options.connectionId)) {
      fail("CONNECTION_IDENTITY_CHANGED", "插件账号已断开");
    }
    if (this.#blockedInstallations.has(options.installationId)
      || (this.#canAcquire && this.#canAcquire({ installationId: options.installationId,
        releaseDigest: options.releaseDigest }) !== true)) {
      fail("PLUGIN_COMPONENT_INACTIVE", "插件安装已停用或代次已变化");
    }
  }

  async acquireStdio(options = {}) {
    if (this.#closed) fail("PLUGIN_CONNECTION_CLOSED", "插件连接池已关闭");
    const { scopeKey, fingerprint } = identityOf(options);
    while (true) {
      if (this.#closed) fail("PLUGIN_CONNECTION_CLOSED", "插件连接池已关闭");
      this.#assertInstallationActive(options);
      let slot = this.#slots.get(scopeKey);
      if (slot && !slot.draining && slot.fingerprint === fingerprint) {
        slot.references += 1;
        let client;
        try { client = await slot.clientPromise; }
        catch (error) {
          slot.references -= 1;
          if (slot.references === 0 && slot.registry.get(slot.scopeKey) === slot) {
            slot.registry.delete(slot.scopeKey);
          }
          throw error;
        }
        if (!slot.draining && client.isAlive()) {
          return this.#handle(slot, client);
        }
        slot.references -= 1;
      }
      if (slot) {
        this.#markDraining(slot);
        if (slot.references > 0) {
          fail("ACTIVATION_DEFERRED", "旧连接仍被使用，等待释放后再接管数据 scope");
        }
        await this.#closeSlot(slot);
        continue;
      }
      if (this.#slots.size + this.#httpSlots.size >= MAX_CONNECTIONS) {
        fail("PLUGIN_CONNECTION_LIMIT", "插件连接 scope 已达上限");
      }
      this.#invalidate(options.connectionId);
      slot = { scopeKey, installationId: options.installationId,
        connectionId: options.connectionId, fingerprint,
        registry: this.#slots, references: 1, draining: false,
        closingPromise: null, clientPromise: null };
      this.#slots.set(scopeKey, slot);
      slot.clientPromise = PluginMcpClient.connectStdio({ ...options,
        authorizeEgress: this.#authorizeEgress,
        onToolsChanged: this.#onToolsChanged,
        onDisconnected: () => this.#invalidate(options.connectionId),
        dataScope: { leaseManager: this.#leaseManager,
          installationId: options.installationId, scopeId: options.scopeId } });
      let client;
      try { client = await slot.clientPromise; }
      catch (error) {
        slot.references -= 1;
        if (slot.references === 0 && this.#slots.get(scopeKey) === slot) {
          this.#slots.delete(scopeKey);
        }
        throw error;
      }
      if (slot.draining || !client.isAlive()) {
        slot.references -= 1;
        if (slot.references === 0) await this.#closeSlot(slot);
        fail("ACTIVATION_DEFERRED", "插件连接在启动期间被排空");
      }
      return this.#handle(slot, client);
    }
  }

  async acquireHttp(options = {}) {
    if (this.#closed) fail("PLUGIN_CONNECTION_CLOSED", "插件连接池已关闭");
    const { connectionKey, fingerprint, credentialProvider, fetchImpl } = httpIdentityOf(options);
    while (true) {
      if (this.#closed) fail("PLUGIN_CONNECTION_CLOSED", "插件连接池已关闭");
      this.#assertInstallationActive(options);
      let slot = this.#httpSlots.get(connectionKey);
      if (slot && !slot.draining && slot.fingerprint === fingerprint
        && slot.credentialProvider === credentialProvider && slot.fetchImpl === fetchImpl) {
        slot.references += 1;
        let client;
        try { client = await slot.clientPromise; }
        catch (error) {
          slot.references -= 1;
          if (slot.references === 0 && slot.registry.get(slot.scopeKey) === slot) {
            slot.registry.delete(slot.scopeKey);
          }
          throw error;
        }
        if (!slot.draining && client.isAlive()) return this.#handle(slot, client);
        slot.references -= 1;
      }
      if (slot) {
        this.#markDraining(slot);
        if (slot.references > 0) {
          fail("ACTIVATION_DEFERRED", "旧连接仍被使用，等待释放后再切换 HTTP 连接");
        }
        await this.#closeSlot(slot);
        continue;
      }
      if (this.#slots.size + this.#httpSlots.size >= MAX_CONNECTIONS) {
        fail("PLUGIN_CONNECTION_LIMIT", "插件连接已达上限");
      }
      this.#invalidate(options.connectionId);
      slot = { scopeKey: connectionKey, installationId: options.installationId,
        connectionId: options.connectionId, fingerprint, credentialProvider, fetchImpl,
        registry: this.#httpSlots, references: 1, draining: false,
        closingPromise: null, clientPromise: null };
      this.#httpSlots.set(connectionKey, slot);
      slot.clientPromise = PluginMcpClient.connectHttp({ ...options,
        fetchImpl, authorizeEgress: this.#authorizeEgress,
        onToolsChanged: this.#onToolsChanged,
        onDisconnected: () => this.#invalidate(options.connectionId) });
      let client;
      try { client = await slot.clientPromise; }
      catch (error) {
        slot.references -= 1;
        if (slot.references === 0 && this.#httpSlots.get(connectionKey) === slot) {
          this.#httpSlots.delete(connectionKey);
        }
        throw error;
      }
      if (slot.draining || !client.isAlive()) {
        slot.references -= 1;
        if (slot.references === 0) await this.#closeSlot(slot);
        fail("ACTIVATION_DEFERRED", "插件 HTTP 连接在启动期间被排空");
      }
      return this.#handle(slot, client);
    }
  }

  #handle(slot, client) {
    const pool = this;
    let released = false;
    let releasePromise = null;
    const inFlight = new Set();
    const assertHeld = () => {
      if (released || slot.draining || !client.isAlive()) {
        fail("PLUGIN_CONNECTION_CLOSED", "插件连接租约已失效");
      }
    };
    const track = async (operation) => {
      inFlight.add(operation);
      try { return await operation; }
      finally { inFlight.delete(operation); }
    };
    return Object.freeze({
      getProtocol() { assertHeld(); return client.getProtocol(); },
      async listTools() { assertHeld(); return track(client.listTools()); },
      async readAppResource(input) {
        assertHeld();
        if (typeof input?.assertCurrent !== "function") fail("CAPABILITY_FORBIDDEN", "资源读取缺少受信门禁");
        return track(client.readAppResource({ ...input, assertCurrent() {
          assertHeld();
          return input.assertCurrent();
        } }));
      },
      async callTool(name, args, authority) {
        assertHeld();
        return track(client.callTool(name, args, authority));
      },
      release() {
        if (releasePromise) return releasePromise;
        released = true;
        releasePromise = (async () => {
          await Promise.allSettled([...inFlight]);
          slot.references -= 1;
          if (slot.references === 0 && slot.draining) await pool.#closeSlot(slot);
        })();
        return releasePromise;
      },
    });
  }

  async #closeSlot(slot) {
    if (!slot.closingPromise) {
      slot.closingPromise = (async () => {
        const client = await slot.clientPromise;
        await client.close();
        if (slot.registry.get(slot.scopeKey) === slot) slot.registry.delete(slot.scopeKey);
      })();
    }
    try { await slot.closingPromise; }
    catch (error) {
      // Keep the slot reserved when child exit is unconfirmed. A later drain
      // may retry close() after the transport finally reports process close.
      slot.closingPromise = null;
      throw error;
    }
  }

  async drainScope({ installationId, scopeId }) {
    if (!INSTALLATION_ID.test(installationId) || !HASH.test(scopeId)) {
      fail("PLUGIN_DATA_SCOPE_INVALID", "插件数据 scope 身份无效");
    }
    const slot = this.#slots.get(`${installationId}:${scopeId}`);
    if (!slot) return;
    this.#markDraining(slot);
    if (slot.references > 0) {
      fail("ACTIVATION_DEFERRED", "插件连接仍被使用，等待释放");
    }
    await this.#closeSlot(slot);
  }

  async drainHttp({ installationId, componentId, connectionId, executionScope } = {}) {
    if (!INSTALLATION_ID.test(installationId) || typeof componentId !== "string" || !componentId
      || typeof connectionId !== "string" || !connectionId
      || typeof executionScope !== "string" || !executionScope) {
      fail("PLUGIN_CONNECTION_IDENTITY_INVALID", "插件 HTTP 连接身份无效");
    }
    const slot = this.#httpSlots.get(httpKey(installationId, componentId, connectionId,
      executionScope));
    if (!slot) return;
    this.#markDraining(slot);
    if (slot.references > 0) fail("ACTIVATION_DEFERRED", "插件 HTTP 连接仍被使用，等待释放");
    await this.#closeSlot(slot);
  }

  async drainInstallation(installationId) {
    if (!INSTALLATION_ID.test(installationId)) {
      fail("PLUGIN_INSTALLATION_INVALID", "插件安装身份无效");
    }
    this.#blockedInstallations.add(installationId);
    const slots = [...this.#slots.values(), ...this.#httpSlots.values()]
      .filter((slot) => slot.installationId === installationId);
    // Fence every handle before the first await. Existing calls may finish,
    // but no new call can enter a draining transport.
    for (const slot of slots) this.#markDraining(slot);
    const active = slots.some((slot) => slot.references > 0);
    const outcomes = await Promise.allSettled(slots.filter((slot) => slot.references === 0)
      .map((slot) => this.#closeSlot(slot)));
    const failures = outcomes.filter((outcome) => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (failures.length > 0) {
      const error = new AggregateError(failures, "插件安装连接未能完整关闭");
      error.code = "PLUGIN_CONNECTION_CLOSE_FAILED";
      throw error;
    }
    if (active) fail("ACTIVATION_DEFERRED", "插件连接仍被使用，等待释放后重试停用");
  }

  async drainConnection(connectionId) {
    if (typeof connectionId !== "string" || !INSTALLATION_ID.test(connectionId)) {
      fail("PLUGIN_CONNECTION_IDENTITY_INVALID", "插件连接身份无效");
    }
    // Connection IDs are never reused by management reconnect. Fence both
    // existing handles and a waiting acquire before the first asynchronous step.
    this.#blockedConnections.add(connectionId);
    const slots = [...this.#slots.values(), ...this.#httpSlots.values()]
      .filter(slot => slot.connectionId === connectionId);
    for (const slot of slots) this.#markDraining(slot);
    const outcomes = await Promise.allSettled(slots.map(slot => this.#closeSlot(slot)));
    if (outcomes.some(outcome => outcome.status === "rejected")) {
      fail("PLUGIN_CONNECTION_CLOSE_FAILED", "插件账号权限已撤销，旧连接仍待关闭");
    }
  }

  resumeInstallation(installationId) {
    if (!INSTALLATION_ID.test(installationId)) {
      fail("PLUGIN_INSTALLATION_INVALID", "插件安装身份无效");
    }
    this.#blockedInstallations.delete(installationId);
  }

  // Service shutdown fences handles immediately, then closes every transport.
  // A stdio child whose exit cannot be confirmed keeps its scope reserved and
  // makes shutdown fail; the next Service generation must not take that writer.
  async close() {
    this.#closed = true;
    const slots = [...this.#slots.values(), ...this.#httpSlots.values()];
    for (const slot of slots) this.#markDraining(slot);
    const outcomes = await Promise.allSettled(slots.map((slot) => this.#closeSlot(slot)));
    const failures = outcomes.filter((outcome) => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (failures.length > 0) {
      const error = new AggregateError(failures, "插件连接池未能完整关闭");
      error.code = "PLUGIN_CONNECTION_CLOSE_FAILED";
      throw error;
    }
  }

  open() {
    if (this.#slots.size > 0 || this.#httpSlots.size > 0) {
      fail("PLUGIN_CONNECTIONS_ACTIVE", "旧插件连接尚未关闭");
    }
    this.#blockedInstallations.clear();
    this.#blockedConnections.clear();
    this.#closed = false;
    return this;
  }
}

module.exports = { PluginMcpConnectionPool };
