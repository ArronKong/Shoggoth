"use strict";

const { cryptoError, decodeWorkerResponse } = require("./mcp-crypto-protocol");
const { FrameReader, encodeRequest } = require("./crypto-worker-channel");

const WORKER_INTERRUPTED = "MCP_CRYPTO_WORKER_INTERRUPTED";

// The broker's existing FIFO, byte budget, generation fence and fail-closed
// policy still own admission. Only encrypt/decrypt reuse this isolated worker.
class PersistentCryptoWorker {
  constructor({ broker, gate, args, env }) {
    this.broker = broker; this.sequence = 0; this.pending = null; this.closed = false; this.stopping = null;
    this.responded = false;
    this.interrupted = false;
    this.child = broker.spawn(broker.executablePath, args, { detached: broker.platform !== "win32",
      env: { ...env, SHOGGOTH_CRYPTO_PERSISTENT: "1" }, stdio: ["pipe", "pipe", "ignore", "pipe"] });
    const child = this.child;
    this.reader = new FrameReader(body => {
      const pending = this.pending;
      if (!pending || this.closed) throw cryptoError();
      let result;
      try { result = decodeWorkerResponse(body, pending.gate, pending.responseOptions); }
      catch { this.fail(); return; }
      this.responded = true;
      this.pending = null; clearTimeout(pending.timer); pending.resolve(result);
    }, () => this.fail());
    child.stdout.on("data", chunk => { this.reader.push(chunk); if (Buffer.isBuffer(chunk)) chunk.fill(0); });
    child.stdout.on("error", () => this.interrupt());
    child.stdin.on("error", () => this.interrupt());
    child.stdio[3].on("error", () => this.fail());
    child.on("error", () => this.interrupt());
    child.on("exit", () => { this.interrupt(); this.reject(); });
    child.on("close", () => { this.interrupt(); this.reader.clear(); this.reject(); });
    child.stdout.on("end", () => this.interrupt());
    child.stdio[3].end(`${JSON.stringify(gate)}\n`);
  }
  request({ gate, request, payload, responseOptions }) {
    if (this.closed || this.pending) return Promise.reject(cryptoError(this.interrupted ? WORKER_INTERRUPTED : undefined));
    let bytes;
    try { bytes = encodeRequest(gate, request, payload, ++this.sequence); } catch { return Promise.reject(cryptoError()); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.interrupt(), this.broker.requestTimeoutMs);
      this.pending = { gate, responseOptions, resolve, reject, timer };
      try { this.child.stdin.write(bytes, error => { bytes.fill(0); if (error) this.interrupt(); }); }
      catch { bytes.fill(0); this.interrupt(); }
    });
  }
  reject() {
    if (!this.pending) return;
    const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
    pending.reject(cryptoError(this.interrupted ? WORKER_INTERRUPTED : undefined));
  }
  interrupt() {
    if (this.closed) return;
    // Replacing a worker is safe only after a verified reply in this process.
    // A failed handshake or a rejected response still fences this generation.
    this.interrupted = this.responded;
    this.fail();
  }
  fail() { this.closed = true; void this.close().catch(() => {}); }
  close() {
    if (this.stopping) return this.stopping;
    this.closed = true;
    const child = this.child, broker = this.broker;
    const validPid = Number.isSafeInteger(child.pid) && child.pid > 0;
    const signal = name => {
      if (!validPid) return;
      try { if (broker.platform !== "win32") broker.signalProcess(-child.pid, name); else child.kill(name); }
      // macOS may return EPERM while the group is exiting. Only the bounded
      // absence check below can authorize starting a replacement worker.
      catch (error) { if (error.code !== "ESRCH" && error.code !== "EPERM") throw error; }
    };
    const exists = () => {
      if (!validPid) return false;
      if (broker.platform === "win32") return child.exitCode === null && child.signalCode === null;
      try { broker.signalProcess(-child.pid, 0); return true; }
      catch (error) {
        if (error.code === "ESRCH") return false;
        if (error.code === "EPERM") return true;
        throw error;
      }
    };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    this.stopping = (async () => {
      try {
        signal("SIGTERM"); await wait(broker.termGraceMs);
        if (exists()) signal("SIGKILL");
        const until = Date.now() + broker.killConfirmMs;
        while (exists()) { if (Date.now() >= until) throw cryptoError(); await wait(10); }
      } catch { if (validPid) broker.residualGroups.add(child.pid); throw cryptoError(); }
      finally { this.reader.clear(); this.reject(); }
    })();
    return this.stopping;
  }
}

module.exports = { PersistentCryptoWorker, WORKER_INTERRUPTED };
