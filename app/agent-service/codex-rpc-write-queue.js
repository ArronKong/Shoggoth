"use strict";

const { rpcError } = require("./codex-rpc-safety");

class CodexRpcWriteQueue {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 5_000;
    this.maxQueuedWrites = options.maxQueuedWrites ?? 256;
    this.maxQueuedWriteBytes = options.maxQueuedWriteBytes ?? (16 * 1024 * 1024);
    this.onFatal = options.onFatal;
    this.entries = [];
    this.queuedBytes = 0;
    this.active = null;
    this.closedError = null;
  }

  enqueue(frame) {
    if (this.closedError) return Promise.reject(this.closedError);
    const bytes = Buffer.byteLength(frame);
    if (this.entries.length >= this.maxQueuedWrites || this.queuedBytes + bytes > this.maxQueuedWriteBytes) {
      const error = rpcError("RPC_WRITE_QUEUE_OVERFLOW", "Codex stdin write queue exceeded its limit");
      this.fail(error);
      this.onFatal?.(error);
      return Promise.reject(error);
    }
    const result = new Promise((resolve, reject) => {
      this.entries.push({ frame, bytes, resolve, reject, timer: null, onDrain: null, settled: false });
    });
    this.queuedBytes += bytes;
    this._pump();
    return result;
  }

  fail(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const entry of this.entries) {
      entry.settled = true;
      clearTimeout(entry.timer);
      if (entry.onDrain) this.stream.removeListener("drain", entry.onDrain);
      entry.reject(error);
    }
    this.entries = [];
    this.queuedBytes = 0;
    this.active = null;
  }

  _pump() {
    if (this.closedError || this.active || this.entries.length === 0) return;
    const entry = this.entries[0];
    this.active = entry;
    let callbackDone = false;
    let drainDone = true;
    let writeReturned = false;
    const complete = () => {
      if (!writeReturned || !callbackDone || !drainDone || entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      if (entry.onDrain) this.stream.removeListener("drain", entry.onDrain);
      this.entries.shift();
      this.queuedBytes -= entry.bytes;
      this.active = null;
      entry.resolve();
      this._pump();
    };
    const fatal = (error) => {
      if (entry.settled || this.closedError) return;
      this.fail(error);
      this.onFatal?.(error);
    };
    entry.timer = setTimeout(
      () => fatal(rpcError("RPC_WRITE_TIMEOUT", "Codex stdin write timed out")),
      this.writeTimeoutMs,
    );
    try {
      const accepted = this.stream.write(entry.frame, "utf8", (error) => {
        if (error) {
          fatal(rpcError("RPC_STDIN_ERROR", "Codex stdin write failed"));
          return;
        }
        callbackDone = true;
        complete();
      });
      drainDone = accepted !== false;
      writeReturned = true;
      if (!drainDone) {
        entry.onDrain = () => {
          drainDone = true;
          complete();
        };
        this.stream.once("drain", entry.onDrain);
      }
      complete();
    } catch {
      writeReturned = true;
      fatal(rpcError("RPC_STDIN_ERROR", "Codex stdin write failed"));
    }
  }
}

module.exports = { CodexRpcWriteQueue };
