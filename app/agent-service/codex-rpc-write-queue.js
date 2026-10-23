"use strict";

const { rpcError } = require("./codex-rpc-safety");

// Only errors created at the final synchronous admission boundary are unsent.
// A public code/property must never turn a transport failure into an unsent call.
const rejectedBeforeSend = new WeakSet();
function sendRejection(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z_0-9]{0,79}$/.test(error.code)
    ? error.code : "RPC_REQUEST_SEND_REJECTED";
  const rejection = rpcError(code, "Codex RPC request was rejected before sending");
  rejectedBeforeSend.add(rejection);
  return rejection;
}
function isCodexRpcSendRejection(error) {
  return error !== null && typeof error === "object" && rejectedBeforeSend.has(error);
}

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

  enqueue(frame, { beforeSend } = {}) {
    if (this.closedError) return Promise.reject(this.closedError);
    if (beforeSend !== undefined && typeof beforeSend !== "function") {
      return Promise.reject(sendRejection(rpcError("RPC_INVALID_SEND_GUARD", "Invalid final send guard")));
    }
    const bytes = Buffer.byteLength(frame);
    if (this.entries.length >= this.maxQueuedWrites || this.queuedBytes + bytes > this.maxQueuedWriteBytes) {
      const error = rpcError("RPC_WRITE_QUEUE_OVERFLOW", "Codex stdin write queue exceeded its limit");
      this.fail(error);
      this.onFatal?.(error);
      return Promise.reject(error);
    }
    const result = new Promise((resolve, reject) => {
      this.entries.push({ frame, bytes, beforeSend, resolve, reject, timer: null, onDrain: null, settled: false });
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
      // Run after queue/backpressure waits, against the immutable serialized frame.
      // No await, timer, or other request may intervene before stream.write.
      const result = entry.beforeSend?.(entry.frame);
      if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        throw rpcError("RPC_INVALID_SEND_GUARD", "Final send guard must be synchronous");
      }
    } catch (error) {
      if (entry.settled || this.closedError) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      this.entries.shift();
      this.queuedBytes -= entry.bytes;
      this.active = null;
      entry.reject(sendRejection(error));
      this._pump();
      return;
    }
    if (entry.settled || this.closedError) return;
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

module.exports = { CodexRpcWriteQueue, isCodexRpcSendRejection };
