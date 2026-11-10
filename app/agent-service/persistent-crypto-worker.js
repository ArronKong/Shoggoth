"use strict";

const { cryptoError, decodeWorkerResponse } = require("./mcp-crypto-protocol");
const { FrameReader, encodeRequest } = require("./crypto-worker-channel");

// The broker's existing FIFO, byte budget, generation fence and fail-closed
// policy still own admission. Only encrypt/decrypt reuse this isolated worker.
class PersistentCryptoWorker {
  constructor({ broker, gate, args, env }) {
    this.broker = broker; this.sequence = 0; this.pending = null; this.closed = false; this.stopping = null;
    this.child = broker.spawn(broker.executablePath, args, { detached: broker.platform !== "win32",
      env: { ...env, SHOGGOTH_CRYPTO_PERSISTENT: "1" }, stdio: ["pipe", "pipe", "ignore", "pipe"] });
    const child = this.child;
    this.reader = new FrameReader(body => {
      const pending = this.pending;
      if (!pending || this.closed) throw cryptoError();
      let result;
      try { result = decodeWorkerResponse(body, pending.gate, pending.responseOptions); }
      catch { this.fail(); return; }
      this.pending = null; clearTimeout(pending.timer); pending.resolve(result);
    }, () => this.fail());
    child.stdout.on("data", chunk => { this.reader.push(chunk); if (Buffer.isBuffer(chunk)) chunk.fill(0); });
    child.stdout.on("error", () => this.fail());
    child.stdin.on("error", () => this.fail());
    child.stdio[3].on("error", () => this.fail());
    child.on("error", () => this.fail());
    child.on("exit", () => { this.closed = true; this.reject(); });
    child.on("close", () => { this.closed = true; this.reader.clear(); this.reject(); });
    child.stdout.on("end", () => { if (!this.closed) this.fail(); });
    child.stdio[3].end(`${JSON.stringify(gate)}\n`);
  }
  request({ gate, request, payload, responseOptions }) {
    if (this.closed || this.pending) return Promise.reject(cryptoError());
    let bytes;
    try { bytes = encodeRequest(gate, request, payload, ++this.sequence); } catch { return Promise.reject(cryptoError()); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), this.broker.requestTimeoutMs);
      this.pending = { gate, responseOptions, resolve, reject, timer };
      try { this.child.stdin.write(bytes, error => { bytes.fill(0); if (error) this.fail(); }); }
      catch { bytes.fill(0); this.fail(); }
    });
  }
  reject() {
    if (!this.pending) return;
    const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.reject(cryptoError());
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
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const exists = () => {
      if (!validPid) return false;
      if (broker.platform === "win32") return child.exitCode === null && child.signalCode === null;
      try { broker.signalProcess(-child.pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
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

module.exports = { PersistentCryptoWorker };
