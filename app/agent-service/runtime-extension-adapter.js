"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { once } = require("node:events");
const { GrokBuildAcpJsonlClient } = require("./grok-build-acp-jsonl");
const { runtimeBinding, runtimeCapabilities } = require("./runtime-adapter");
const { RUNTIME_V1_METHODS } = require("./runtime-handle-v1");
const { serviceError, ensurePrivateDirectoryTree } = require("./security");
const error = code => serviceError(code, "Configured runtime extension could not perform the operation");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class RuntimeExtensionAdapter {
  constructor({ manifest, paths, verify, getToken = () => null }) {
    this.manifest = manifest; this.paths = paths; this.verify = verify; this.getToken = getToken; this.handles = new Map();
    // Arbitrary plugins cannot self-attest tool-free isolation.
    this.modelOnly = false;
  }
  async acquire(value, options = {}) {
    const binding = runtimeBinding(value), m = this.manifest;
    if (binding.runtime !== m.runtime) throw error("RUNTIME_BINDING_INVALID");
    this.verify();
    const policy = options.permissionPolicy;
    if (policy?.sandbox !== "danger-full-access" || policy?.approvalPolicy !== "never") throw error("RUNTIME_PERMISSION_UNSUPPORTED");
    const key = JSON.stringify([binding, options.workspace ?? null]);
    if (this.handles.has(key)) return this.handles.get(key);
    const pending = this.start(binding, options).catch(e => { if (this.handles.get(key) === pending) this.handles.delete(key); throw e; });
    this.handles.set(key, pending);
    const handle = await pending;
    handle.terminated.finally(() => { if (this.handles.get(key) === pending) this.handles.delete(key); }).catch(() => {});
    return handle;
  }
  async start(binding, options) {
    const m = this.manifest;
    const home = path.join(this.paths.stateDir, "runtime-extension-homes", binding.runtime, binding.runtimeAccountId);
    ensurePrivateDirectoryTree(home, this.paths.trustedRoot);
    const workspace = options.workspace ?? home;
    if (!path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory()) throw error("RUNTIME_WORKSPACE_INVALID");
    let child, socket, close, token = null;
    if (m.transport === "remote") {
      token = await this.getToken(m.credentialRef);
      if (typeof token !== "string" || token.length < 32) throw error("AUTH_REQUIRED");
      const url = new URL(m.endpoint);
      socket = url.protocol === "tls:" ? require("node:tls").connect({ host: url.hostname, port: Number(url.port),
        servername: require("node:net").isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: true })
        : require("node:net").connect({ host: "127.0.0.1", port: Number(url.port) });
      const connection = once(socket, url.protocol === "tls:" ? "secureConnect" : "connect");
      let timer;
      try { await Promise.race([connection, new Promise((_, reject) => { timer = setTimeout(() => reject(error("RUNTIME_REMOTE_CONNECT_TIMEOUT")), 15_000); })]); }
      catch (e) { socket.destroy(); throw e; } finally { clearTimeout(timer); }
      child = new EventEmitter(); child.stdin = socket; child.stdout = socket; child.stderr = new PassThrough();
      socket.once("close", () => child.emit("close"));
      close = async () => { socket.destroy(); };
    } else {
      const env = { HOME: home, PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: process.env.TMPDIR || "/tmp",
        LANG: "en_US.UTF-8", SHOGGOTH_RUNTIME_HOME: home };
      child = require("node:child_process").spawn(m.command, m.args, { cwd: workspace, env, shell: false,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      let exited = false; const ended = new Promise(resolve => child.once("close", () => { exited = true; resolve(); }));
      const alive = () => {
        if (process.platform === "win32") return !exited;
        if (!child.pid) return !exited;
        try { process.kill(-child.pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; }
      };
      close = async () => {
        if (!alive()) return;
        const kill = signal => { try { if (process.platform !== "win32" && child.pid > 1) process.kill(-child.pid, signal); else child.kill(signal); } catch (e) { if (e.code !== "ESRCH") throw e; } };
        kill("SIGTERM"); await Promise.race([ended, delay(1000)]);
        if (alive()) { kill("SIGKILL"); const deadline = Date.now() + 3000;
          while (alive() && Date.now() < deadline) await delay(25); }
        if (alive()) throw error("RUNTIME_STOP_UNCONFIRMED");
      };
    }
    const rpc = new GrokBuildAcpJsonlClient(child, { requestTimeoutMs: 180_000, maxFrameBytes: 8 * 1024 * 1024 });
    let resolveClosed, rejectClosed;
    const terminated = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; }); terminated.catch(() => {});
    let stopping = null;
    const stop = () => stopping ||= close().then(() => { rpc.terminate(); resolveClosed(); }, e => { rejectClosed(e); throw e; });
    rpc.terminated.catch(() => { void stop().catch(() => {}); });
    try {
      if (m.transport === "acp") return await require("./runtime-acp-handle").createAcpHandle({ binding, rpc, home, workspace,
        stateDir: this.paths.stateDir, trustedRoot: this.paths.trustedRoot, stop, terminated });
      const hello = await rpc.request("initialize", { version: 1, binding, workspace,
        permissionPolicy: options.permissionPolicy, ...(token ? { token } : {}) }, { timeoutMs: 15_000 });
      if (hello?.version !== 1 || JSON.stringify(runtimeBinding(hello.binding)) !== JSON.stringify(binding)
        || typeof hello.homeIdentity !== "string" || hello.homeIdentity.length > 512) throw error("RUNTIME_HANDLE_INVALID");
      const capabilities = runtimeCapabilities({ ...hello.capabilities, "model.generate.toolFree": false });
      const handle = { ...binding, capabilities, homeIdentity: hello.homeIdentity, workspace, terminated, stop,
        registeredSecrets: token ? [token] : [],
        authenticationState: input => rpc.request("runtime/authenticationState", input),
        subscribe: listener => rpc.subscribe(message => { if (message.method === "runtime/event") listener(message.params); }),
        registerServerRequestHandler: (method, handler) => rpc.registerServerRequestHandler(method, handler),
      };
      for (const [method, capability] of Object.entries(RUNTIME_V1_METHODS)) if (capabilities[capability]) {
        handle[method] = async input => {
          const { signal, ...params } = input || {};
          if (signal?.aborted) throw error("WORK_RUN_CANCELED");
          try { return await rpc.request(`runtime/${method}`, params); }
          catch (e) { if (method === "turnStart" && e.dispatchState !== "not_sent") throw error("RUNTIME_TURN_ACCEPTANCE_UNKNOWN"); throw e; }
        };
      }
      return handle;
    } catch (e) { await stop(); throw e; }
  }
  async stop(binding) {
    const handles = await Promise.all([...this.handles.values()]);
    await Promise.all(handles.filter(handle => handle.runtimeProfileId === binding.runtimeProfileId).map(handle => handle.stop()));
  }
  async stopAll() { const handles = await Promise.allSettled([...this.handles.values()]);
    const results = await Promise.allSettled(handles.filter(item => item.status === "fulfilled").map(item => item.value.stop()));
    if (results.some(item => item.status === "rejected")) throw error("RUNTIME_STOP_UNCONFIRMED"); }
}
module.exports = { RuntimeExtensionAdapter };
