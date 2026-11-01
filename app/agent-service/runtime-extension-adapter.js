"use strict";
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { EventEmitter, once } = require("node:events");
const { PassThrough } = require("node:stream");
const { AcpJsonlClient } = require("./acp-jsonl-client");
const { RuntimeExecutableIdentity, executableInterpreter } = require("./runtime-executable-identity");
const { RUNTIME_CAPABILITY_KEYS, runtimeBinding, runtimeCapabilities } = require("./runtime-adapter");
const { RUNTIME_V1_METHODS, runtimeData } = require("./runtime-handle-v1");
const { executionRunIdForPool } = require("./runtime-pool-capacity");
const { AcpProductBridge } = require("./runtime-acp-product-bridge");
const { serviceError, ensurePrivateDirectoryTree } = require("./security");
const error = code => serviceError(code, "Configured runtime extension could not perform the operation");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const terminal = status => ["completed", "failed", "canceled"].includes(status);
const fenced = new Set(["sessionStart", "sessionResume", "turnStart", "turnSteer", "sessionRename", "sessionArchive",
  "sessionUnarchive", "sessionDelete", "commandExecute", "commandsList", "modelsList", "accountRead", "accountLogin", "accountLogout"]);
function freeze(value) {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function canonical(value) {
  return JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
class RuntimeExtensionAdapter {
  constructor({ manifest, paths, verify, getToken = () => null, getAccountGeneration = () => null, getManifestIdentity = () => null, expectedManifestIdentity,
    mcpGateIssuer = null, resolveMaxHosts = () => 16, canRetireChangedHost = null, onDiagnostic = null }) {
    this.manifest = freeze(structuredClone(manifest)); this.paths = paths; this.verify = verify; this.getToken = getToken;
    this.getAccountGeneration = getAccountGeneration; this.getManifestIdentity = getManifestIdentity;
    this.expectedManifestIdentity = expectedManifestIdentity === undefined ? getManifestIdentity() : expectedManifestIdentity;
    this.mcpGateIssuer = mcpGateIssuer; this.resolveMaxHosts = resolveMaxHosts; this.canRetireChangedHost = canRetireChangedHost;
    this.onDiagnostic = onDiagnostic;
    this.capacityRetirement = null;
    this.executableIdentity = new RuntimeExecutableIdentity(); this.handles = new Map(); this.stoppingProfiles = new Map(); this.closing = false; this.stopGeneration = 0; this.stoppingAll = null;
    // Arbitrary plugins cannot self-attest tool-free isolation.
    this.modelOnly = false;
  }
  _observe({ verifyFiles = true } = {}) {
    // New admissions recheck the complete signed package. Existing hosts only
    // need its immutable manifest identity plus executable stat/ctime fences;
    // a settings read must not hash a large interpreter on the Service thread.
    if (verifyFiles) {
      const verified = this.verify();
      if (verified !== undefined && canonical(verified) !== canonical(this.manifest)) throw error("RUNTIME_EXTENSION_UNTRUSTED");
    }
    const signingIdentity = this.getManifestIdentity();
    if (signingIdentity !== this.expectedManifestIdentity) throw error("RUNTIME_EXTENSION_UNTRUSTED");
    if (signingIdentity !== null && (typeof signingIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(signingIdentity))) throw error("RUNTIME_IDENTITY_UNAVAILABLE");
    const m = this.manifest;
    const interpreterPath = m.transport === "remote" ? null : executableInterpreter(m.command, process.env.PATH || "/usr/bin:/bin");
    const observation = m.transport === "remote" ? null : this.executableIdentity.observe({ binaryPath: m.command,
      interpreterPath,
      extraPaths: m.files.map(file => file.path).filter(file => file !== m.command) });
    const manifestDigest = digest(canonical([m, signingIdentity]));
    return { observation, interpreterPath, manifestDigest, stamp: digest(canonical([manifestDigest, observation?.stamp ?? null])) };
  }
  _accountGeneration(binding) {
    const value = this.getAccountGeneration(binding.runtimeAccountId);
    if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw error("RUNTIME_ACCOUNT_GENERATION_STALE");
    return value;
  }
  runtimeIdentityKey(value) {
    const binding = runtimeBinding(value);
    if (binding.runtime !== this.manifest.runtime) throw error("RUNTIME_BINDING_INVALID");
    return digest(canonical([this._observe({ verifyFiles: false }).stamp, this._accountGeneration(binding)]));
  }
  async acquire(value, options = {}) {
    const binding = runtimeBinding(value);
    if (binding.runtime !== this.manifest.runtime) throw error("RUNTIME_BINDING_INVALID");
    if (this.closing) throw error("RUNTIME_REGISTRY_STOPPING");
    const generation = this.stopGeneration;
    while (this.stoppingProfiles.has(binding.runtimeProfileId)) await this.stoppingProfiles.get(binding.runtimeProfileId);
    const assertAcquiring = () => {
      if (this.closing || this.stopGeneration !== generation) throw error("RUNTIME_REGISTRY_STOPPING");
      if ([...this.handles.values()].some(entry => entry.binding.runtimeProfileId === binding.runtimeProfileId
        && entry.host?.cleanupIncomplete)) throw error("RUNTIME_STOP_UNCONFIRMED");
    };
    assertAcquiring();
    const observed = this._observe(), accountGeneration = this._accountGeneration(binding);
    const policy = options.permissionPolicy;
    if (policy?.sandbox !== "danger-full-access" || !(this.manifest.transport === "acp"
      ? ["never", "on-request"].includes(policy?.approvalPolicy) : policy?.approvalPolicy === "never")) throw error("RUNTIME_PERMISSION_UNSUPPORTED");
    const permissionPolicy = freeze(runtimeData(policy)), policyKey = canonical(permissionPolicy);
    const executionRunId = this.manifest.transport === "acp" ? executionRunIdForPool(options) : null;
    const key = JSON.stringify([binding, options.workspace ?? null, executionRunId]);
    const current = this.handles.get(key);
    if (current) {
      if (current.retiring) { await current.retiring; assertAcquiring(); return this.acquire(value, options); }
      if (current.host?.cleanupIncomplete) throw error("RUNTIME_STOP_UNCONFIRMED");
      if (current.observed.stamp !== observed.stamp) throw error("RUNTIME_EXECUTABLE_CHANGED");
      if (current.accountGeneration !== accountGeneration) throw error("RUNTIME_ACCOUNT_GENERATION_STALE");
      if (current.policyKey !== policyKey) throw error("RUNTIME_PERMISSION_CHANGED");
      const handle = await current.promise;
      assertAcquiring(); handle.host.assertRuntimeIdentityCurrent();
      return handle;
    }
    if (this.handles.size >= this._hostLimit()) {
      await this._retireForCapacity(executionRunId); assertAcquiring(); return this.acquire(value, options);
    }
    // Keep one slot per binding/workspace/run while identity capture and startup are
    // pending. A changed executable/policy cannot create a parallel replacement.
    const entry = { key, binding, observed, accountGeneration, permissionPolicy, policyKey, executionRunId, host: null,
      activeTurns: new Set(), completedTurns: new Set(), executionUnknown: false };
    this.handles.set(key, entry);
    entry.promise = this.start(binding, { ...options, permissionPolicy }, entry).catch(e => {
      if (!entry.host?.cleanupIncomplete && this.handles.get(key) === entry) this.handles.delete(key);
      throw e;
    });
    const handle = await entry.promise;
    assertAcquiring(); return handle;
  }
  _hostLimit() {
    const value = this.resolveMaxHosts();
    if (!Number.isSafeInteger(value) || value < 1 || value > 128) throw error("RUNTIME_HOST_CAPACITY");
    return value;
  }
  _retireForCapacity(executionRunId) {
    if (this.capacityRetirement) return this.capacityRetirement;
    let selected;
    if (typeof this.canRetireChangedHost === "function") for (const entry of this.handles.values()) {
      if (entry.retiring || !entry.host || this.stoppingProfiles.has(entry.binding.runtimeProfileId)) continue;
      try {
        if (entry.host.canRetireIdle?.() !== true
          || this.canRetireChangedHost(entry.binding, entry.host, executionRunId) !== true) continue;
      } catch { continue; }
      selected = entry; break;
    }
    if (!selected) return Promise.reject(error("RUNTIME_HOST_CAPACITY"));
    const retiring = this._stopEntries([selected]).finally(() => {
      if (this.capacityRetirement === retiring) this.capacityRetirement = null;
      if (selected.retiring === retiring) selected.retiring = null;
    });
    selected.retiring = retiring; this.capacityRetirement = retiring;
    return retiring;
  }
  async start(binding, options, entry) {
    const m = this.manifest, captured = entry.observed.observation
      ? await this.executableIdentity.capture(entry.observed.observation) : null;
    const runtimeIdentity = Object.freeze({ version: 1, stamp: entry.observed.stamp,
      digest: digest(canonical([entry.observed.manifestDigest, captured?.digest ?? null])),
      interpreted: captured?.interpreted ?? false, coverage: captured?.coverage ?? "signed-extension-endpoint" });
    const home = path.join(this.paths.stateDir, "runtime-extension-homes", binding.runtime, binding.runtimeAccountId);
    ensurePrivateDirectoryTree(home, this.paths.trustedRoot);
    const workspace = options.workspace ?? home;
    if (!path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory()) throw error("RUNTIME_WORKSPACE_INVALID");
    let child, socket, close, rpc, token = null, resolveClosed, stopping = null;
    const terminated = new Promise(resolve => { resolveClosed = resolve; });
    const host = entry.host = { ...binding, home, workspace, transport: m.transport, runtimeIdentity,
      accountGeneration: entry.accountGeneration, permissionPolicy: entry.permissionPolicy,
      mcpExecutionRunId: entry.executionRunId, runtimeProcessExecutable: entry.observed.interpreterPath || entry.observed.observation?.binaryPath || null,
      state: "starting", cleanupIncomplete: false,
      pendingOperations: 0, terminated,
      assertRuntimeIdentityCurrent: () => {
        if (!["starting", "ready"].includes(host.state)) throw error(host.cleanupIncomplete ? "RUNTIME_STOP_UNCONFIRMED" : "RUNTIME_HANDLE_TERMINATED");
        let current;
        try { current = this._observe({ verifyFiles: false }); } catch { throw error("RUNTIME_EXECUTABLE_CHANGED"); }
        if (current.stamp !== runtimeIdentity.stamp) throw error("RUNTIME_EXECUTABLE_CHANGED");
        if (this._accountGeneration(binding) !== host.accountGeneration) throw error("RUNTIME_ACCOUNT_GENERATION_STALE");
      },
      canRetireIdle: () => host.state === "ready" && !host.cleanupIncomplete && host.pendingOperations === 0
        && !rpc?.pending.size && !rpc?.activeServerRequestIds.size && !entry.executionUnknown && entry.activeTurns.size === 0
        && (!host.acpBridge || host.acpBridge.isIdle()),
      stop: () => {
        if (host.state === "stopped") return Promise.resolve();
        if (stopping) return stopping;
        host.state = "stopping";
        stopping = Promise.resolve().then(async () => {
          let revokeFailure;
          try { host.acpBridge?.close(); } catch (error) { revokeFailure = error; }
          await close?.();
          if (revokeFailure) throw revokeFailure;
        }).then(() => {
          rpc?.terminate(); host.cleanupIncomplete = false; host.state = "stopped";
          if (this.handles.get(entry.key) === entry) this.handles.delete(entry.key);
          resolveClosed();
        }, () => { host.cleanupIncomplete = true; host.state = "cleanupIncomplete"; throw error("RUNTIME_STOP_UNCONFIRMED"); })
          .finally(() => { stopping = null; });
        return stopping;
      },
    };
    try {
      host.assertRuntimeIdentityCurrent();
      if (m.transport === "remote") {
        token = await this.getToken(m.credentialRef);
        if (typeof token !== "string" || token.length < 32) throw error("AUTH_REQUIRED");
        host.assertRuntimeIdentityCurrent();
        const url = new URL(m.endpoint);
        socket = url.protocol === "tls:" ? require("node:tls").connect({ host: url.hostname, port: Number(url.port),
          servername: require("node:net").isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: true })
          : require("node:net").connect({ host: "127.0.0.1", port: Number(url.port) });
        let closed = false;
        const ended = new Promise(resolve => socket.once("close", () => { closed = true; resolve(); }));
        close = async () => {
          socket.destroy();
          if (!closed) await Promise.race([ended, delay(3000)]);
          if (!closed) throw error("RUNTIME_STOP_UNCONFIRMED");
        };
        const connection = once(socket, url.protocol === "tls:" ? "secureConnect" : "connect");
        let timer;
        try { await Promise.race([connection, new Promise((_, reject) => { timer = setTimeout(() => reject(error("RUNTIME_REMOTE_CONNECT_TIMEOUT")), 15_000); })]); }
        finally { clearTimeout(timer); }
        child = new EventEmitter(); child.stdin = socket; child.stdout = socket; child.stderr = new PassThrough();
        socket.once("close", () => child.emit("close"));
      } else {
        const env = { HOME: home, PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: process.env.TMPDIR || "/tmp",
          LANG: "en_US.UTF-8", SHOGGOTH_RUNTIME_HOME: home };
        child = require("node:child_process").spawn(m.command, m.args, { cwd: workspace, env, shell: false,
          detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
        let exited = false; const ended = new Promise(resolve => child.once("close", () => { exited = true; resolve(); }));
        const groupState = () => {
          if (process.platform === "win32" || !child.pid) return exited ? "gone" : "alive";
          try { process.kill(-child.pid, 0); return "alive"; }
          catch (e) { if (e.code === "ESRCH") return "gone"; if (e.code === "EPERM") return "unknown"; throw e; }
        };
        close = async () => {
          // Keep TERM's 1s plus KILL's 3s as one total budget. macOS can briefly
          // report EPERM after child.close; that proves neither ownership nor
          // disappearance of descendants. Only ESRCH confirms the group is gone.
          const deadline = Date.now() + 4000;
          let onlyObserveGone = false;
          const observe = async (untilGone = false) => {
            for (;;) {
              const state = groupState();
              if (state === "gone") return state;
              if (state === "unknown" && exited) onlyObserveGone = true;
              if (Date.now() >= deadline) return "unknown";
              if (state === "alive" && !untilGone && !onlyObserveGone) return state;
              await delay(Math.min(25, deadline - Date.now()));
            }
          };
          const kill = signal => {
            try {
              const sent = process.platform !== "win32" && child.pid > 1
                ? process.kill(-child.pid, signal) : child.kill(signal);
              if (sent === false) { onlyObserveGone = true; return "unknown"; }
              return "sent";
            } catch (e) {
              if (e.code === "ESRCH") return "gone";
              if (e.code === "EPERM") { onlyObserveGone = true; return "unknown"; }
              throw e;
            }
          };
          let state = await observe();
          if (state === "gone") return;
          if (state !== "alive") throw error("RUNTIME_STOP_UNCONFIRMED");
          const term = kill("SIGTERM");
          if (term === "gone") return;
          if (term === "sent") await Promise.race([ended, delay(Math.min(1000, Math.max(0, deadline - Date.now())))]);
          state = await observe();
          if (state === "gone") return;
          if (state !== "alive") throw error("RUNTIME_STOP_UNCONFIRMED");
          if (kill("SIGKILL") === "gone") return;
          if (await observe(true) !== "gone") throw error("RUNTIME_STOP_UNCONFIRMED");
        };
      }
      host.child = child;
      rpc = host.rpc = new AcpJsonlClient(child, { requestTimeoutMs: 180_000, maxFrameBytes: 8 * 1024 * 1024,
        stderrAuthHints: m.transport !== "acp" });
      rpc.terminated.catch(() => { void host.stop().catch(() => {}); });
      let handle;
      if (m.transport === "acp") {
        host.acpBridge = new AcpProductBridge({ binding, host, rpc, mcpGateIssuer: this.mcpGateIssuer,
          executionContract: options.executionContract ?? null });
        handle = await require("./runtime-acp-handle").createAcpHandle({ binding, rpc, home, workspace,
          stateDir: this.paths.stateDir, trustedRoot: this.paths.trustedRoot, host, stop: host.stop, terminated,
          onDiagnostic: this.onDiagnostic });
      } else {
        const hello = await rpc.request("initialize", { version: 1, binding, workspace,
          permissionPolicy: options.permissionPolicy, ...(token ? { token } : {}) }, { timeoutMs: 15_000 });
        if (hello?.version !== 1 || JSON.stringify(runtimeBinding(hello.binding)) !== JSON.stringify(binding)
          || typeof hello.homeIdentity !== "string" || hello.homeIdentity.length > 512) throw error("RUNTIME_HANDLE_INVALID");
        // A signed plugin still cannot self-attest isolated model execution or
        // its resolution/release helpers. They belong to the same unavailable
        // adapter guarantee, regardless of the worker capability advertisement.
        const capabilities = runtimeCapabilities({ ...hello.capabilities, "turn.start.prepare": false, ...Object.fromEntries(
          RUNTIME_CAPABILITY_KEYS.filter(key => key.startsWith("model.")).map(key => [key, false])) });
        rpc.subscribe(message => {
          if (message.method !== "runtime/event") return;
          const event = message.params;
          if (event?.known !== true || event.type !== "complete" || !terminal(event.status)
            || typeof event.sessionId !== "string" || typeof event.turnId !== "string") return;
          const key = JSON.stringify([event.sessionId, event.turnId]);
          entry.activeTurns.delete(key); entry.completedTurns.add(key);
          while (entry.completedTurns.size > 4096) entry.completedTurns.delete(entry.completedTurns.values().next().value);
        });
        handle = { ...binding, capabilities, homeIdentity: hello.homeIdentity, workspace, terminated, stop: host.stop,
          registeredSecrets: token ? [token] : [],
          authenticationState: input => rpc.request("runtime/authenticationState", input),
          subscribe: listener => rpc.subscribe(message => { if (message.method === "runtime/event") listener(message.params); }),
          registerServerRequestHandler: (method, handler) => rpc.registerServerRequestHandler(method, handler),
        };
        for (const [method, capability] of Object.entries(RUNTIME_V1_METHODS)) if (capabilities[capability]) {
          handle[method] = async input => {
            const { signal, ...params } = input || {};
            if (signal?.aborted) throw error("WORK_RUN_CANCELED");
            if (method === "turnStart" && entry.executionUnknown) throw error("RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
            try {
              const result = await rpc.request(`runtime/${method}`, params);
              if (method === "turnStart") {
                if (typeof result?.turn?.id !== "string" || !result.turn.id) { entry.executionUnknown = true; throw error("RUNTIME_TURN_ACCEPTANCE_UNKNOWN"); }
                const key = JSON.stringify([params.sessionId, result.turn.id]);
                if (!terminal(result.turn.status) && !entry.completedTurns.has(key)) entry.activeTurns.add(key);
              }
              return result;
            } catch (e) {
              if (method === "turnStart" && e.dispatchState !== "not_sent") { entry.executionUnknown = true; throw error("RUNTIME_TURN_ACCEPTANCE_UNKNOWN"); }
              throw e;
            }
          };
        }
      }
      handle.host = host;
      for (const method of [...Object.keys(RUNTIME_V1_METHODS), "authenticationState"]) {
        if (typeof handle[method] !== "function") continue;
        const operation = handle[method];
        handle[method] = async function (...args) {
          if (host.state !== "ready") throw error(host.cleanupIncomplete ? "RUNTIME_STOP_UNCONFIRMED" : "RUNTIME_HANDLE_TERMINATED");
          if (fenced.has(method) || method === "authenticationState") host.assertRuntimeIdentityCurrent();
          host.pendingOperations++;
          try { return await operation.apply(this, args); } finally { host.pendingOperations--; }
        };
      }
      host.assertRuntimeIdentityCurrent(); host.state = "ready";
      return handle;
    } catch (e) { await host.stop(); throw e; }
  }
  isBindingIdle(value) {
    const binding = runtimeBinding(value);
    if (binding.runtime !== this.manifest.runtime || this.closing || this.stoppingProfiles.has(binding.runtimeProfileId)) return false;
    for (const entry of this.handles.values()) {
      if (entry.binding.runtimeProfileId !== binding.runtimeProfileId) continue;
      if (entry.binding.runtimeAccountId !== binding.runtimeAccountId || entry.host?.canRetireIdle?.() !== true) return false;
    }
    return true;
  }
  async _stopEntries(entries) {
    await Promise.allSettled(entries.map(entry => entry.promise));
    const results = await Promise.allSettled(entries.map(entry => entry.host?.stop()));
    if (results.some(item => item.status === "rejected") || entries.some(entry => entry.host?.cleanupIncomplete)) throw error("RUNTIME_STOP_UNCONFIRMED");
  }
  stop(value) {
    const binding = runtimeBinding(value);
    if (binding.runtime !== this.manifest.runtime) return Promise.reject(error("RUNTIME_BINDING_INVALID"));
    if (this.stoppingProfiles.has(binding.runtimeProfileId)) return this.stoppingProfiles.get(binding.runtimeProfileId);
    const stopping = this._stopEntries([...this.handles.values()].filter(entry => entry.binding.runtimeProfileId === binding.runtimeProfileId))
      .finally(() => { if (this.stoppingProfiles.get(binding.runtimeProfileId) === stopping) this.stoppingProfiles.delete(binding.runtimeProfileId); });
    this.stoppingProfiles.set(binding.runtimeProfileId, stopping);
    return stopping;
  }
  stopAll() {
    if (this.stoppingAll) return this.stoppingAll;
    this.closing = true; this.stopGeneration++;
    const stopping = this._stopEntries([...this.handles.values()]).finally(() => {
      if (this.stoppingAll === stopping) { this.stoppingAll = null; this.closing = false; }
    });
    this.stoppingAll = stopping; return stopping;
  }
}
module.exports = { RuntimeExtensionAdapter };
