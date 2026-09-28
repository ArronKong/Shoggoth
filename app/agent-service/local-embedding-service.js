"use strict";

const path = require("node:path");
const { fork } = require("node:child_process");
const { embeddingError } = require("./e5-encoder");
const { e5AssetDirectory } = require("./e5-model-contract");

function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(embeddingError("E5_TIMEOUT")), timeoutMs);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

// One child per Agent Service, shared by native memory and conversation recall.
// It inherits no model/provider credentials or Node loader overrides.
class LocalEmbeddingService {
  constructor({ paths, assetDirectory = e5AssetDirectory(), spawn = fork } = {}) {
    this.paths = paths;
    this.assetDirectory = assetDirectory;
    this.spawn = spawn;
    this.child = null;
    this.initializing = null;
    this.nextId = 0;
    this.pending = new Map();
    this.state = "uninitialized";
    this.errorCode = null;
    this.model = null;
    this.closed = false;
    this.starts = 0;
    this.lastExit = null;
  }

  status() { return { status: this.state, ...(this.errorCode ? { reason: this.errorCode } : {}),
    ...(this.model ? { modelId: this.model.modelId, modelIdentity: this.model.identity } : {}) }; }

  start() {
    if (this.closed) return Promise.reject(embeddingError("E5_WORKER_CLOSED"));
    if (this.initializing) return this.initializing;
    if (this.starts >= 2) return Promise.reject(embeddingError("E5_WORKER_UNAVAILABLE"));
    this.starts++; this.state = "loading";
    const env = { ELECTRON_RUN_AS_NODE: "1" };
    for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "__CF_USER_TEXT_ENCODING"]) {
      if (typeof process.env[key] === "string") env[key] = process.env[key];
    }
    try {
      const child = this.spawn(path.join(__dirname, "embedding-worker.cjs"), [], {
        execPath: process.execPath, execArgv: [], cwd: path.dirname(process.execPath),
        env, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
      });
      this.child = child;
      child.on("message", packet => {
        const request = this.pending.get(packet?.id);
        if (!request) return;
        this.pending.delete(packet.id); clearTimeout(request.timer);
        if (packet.error) request.reject(embeddingError(/^E5_[A-Z0-9_]+$/u.test(packet.error)
          ? packet.error : "E5_WORKER_UNAVAILABLE"));
        else request.resolve(packet.result);
      });
      const retire = () => {
        if (this.child !== child) return;
        this.child = null;
        for (const request of this.pending.values()) {
          clearTimeout(request.timer); request.reject(embeddingError("E5_WORKER_UNAVAILABLE"));
        }
        this.pending.clear();
        if (!this.closed) { this.state = "unavailable"; this.errorCode ||= "E5_WORKER_UNAVAILABLE"; this.initializing = null; }
      };
      child.once("error", retire);
      child.once("exit", (code, signal) => { this.lastExit = { code, signal }; retire(); });
      this.initializing = this._send("init", { paths: this.paths, assetDirectory: this.assetDirectory }, 15_000)
        .then(model => { this.model = model; this.state = "ready"; this.errorCode = null; return model; })
        .catch(error => {
          this.state = "unavailable"; this.errorCode = error.code || "E5_WORKER_UNAVAILABLE";
          // Missing/corrupt resources require a repaired App, not a restart loop.
          this.starts = 2;
          child.kill("SIGTERM");
          throw error;
        });
      return this.initializing;
    } catch (error) {
      this.state = "unavailable"; this.errorCode = "E5_WORKER_UNAVAILABLE";
      return Promise.reject(embeddingError("E5_WORKER_UNAVAILABLE"));
    }
  }

  _send(method, args, timeoutMs) {
    const child = this.child;
    if (!child?.connected) return Promise.reject(embeddingError("E5_WORKER_UNAVAILABLE"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(embeddingError("E5_TIMEOUT"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, method, args }, error => {
        if (!error || !this.pending.has(id)) return;
        this.pending.delete(id); clearTimeout(timer); reject(embeddingError("E5_WORKER_UNAVAILABLE"));
      });
    });
  }

  async request(method, args, { timeoutMs = 1000 } = {}) {
    return bounded((async () => { await this.start(); return this._send(method, args, timeoutMs); })(), timeoutMs);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (child?.connected) {
      try { await this._send("close", {}, 2000); } catch { child.kill("SIGTERM"); }
      await bounded(new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", resolve);
      }), 2000).catch(() => child.kill("SIGKILL"));
    }
    this.state = "closed";
  }
}

module.exports = { LocalEmbeddingService, bounded };
