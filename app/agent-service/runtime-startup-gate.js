"use strict";

const { serviceError } = require("./security");

// A reservation is made synchronously before queued -> starting, and spans
// encryption, host acquisition, session setup and the turnStart acknowledgement.
class RuntimeStartupGate {
  constructor({ getConfig }) {
    this.getConfig = getConfig;
    this.active = new Set();
    this.waiters = new Map();
  }

  acquire(runId) {
    const config = this.getConfig();
    if (!config.flags.runtimeAdmissionV1) return true;
    if (!Number.isSafeInteger(config.startupConcurrency)
      || config.startupConcurrency < 1 || config.startupConcurrency > 16) {
      throw serviceError("NATIVE_RUNTIME_CONFIG_INVALID", "原生启动并发配置无效");
    }
    if (this.active.has(runId)) return true;
    if (this.active.size >= config.startupConcurrency) return false;
    this.active.add(runId);
    return true;
  }

  wait(runId, signal) {
    if (signal?.aborted) return Promise.reject(serviceError("RUNTIME_STARTUP_CANCELED", "运行时启动已取消"));
    if (this.acquire(runId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiters.delete(runId);
        reject(serviceError("RUNTIME_STARTUP_CANCELED", "运行时启动已取消"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.set(runId, () => { signal?.removeEventListener("abort", abort); resolve(); });
    });
  }

  drain() {
    for (const [id, resume] of this.waiters) {
      if (!this.acquire(id)) break;
      this.waiters.delete(id);
      resume();
    }
  }

  release(runId) {
    const released = this.active.delete(runId);
    this.drain();
    return released;
  }
  clear() { this.active.clear(); }
  read() { return { active: this.active.size, limit: this.getConfig().startupConcurrency }; }
}

module.exports = { RuntimeStartupGate };
