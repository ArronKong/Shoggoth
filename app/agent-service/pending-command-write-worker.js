"use strict";

const { isMainThread, parentPort, workerData, Worker } = require("node:worker_threads");
const { atomicWritePrivateFile } = require("./private-file");
const { storageIssueCode } = require("../system-issue");

function serializeEnvelope(version, revision, encrypted) {
  return `${JSON.stringify({ version, revision, ciphertext: encrypted.toString("base64") })}\n`;
}

if (!isMainThread) {
  const { target, trustedRoot } = workerData;
  parentPort.on("message", ({ id, value }) => {
    try {
      const encrypted = Buffer.from(value.encrypted.buffer, value.encrypted.byteOffset, value.encrypted.byteLength);
      let serialized;
      try {
        serialized = serializeEnvelope(value.version, value.revision, encrypted);
      } finally {
        encrypted.fill(0);
      }
      atomicWritePrivateFile(target, serialized, { trustedRoot });
      parentPort.postMessage({ id });
    } catch (error) {
      parentPort.postMessage({ id, error: {
        code: error?.code, committed: error?.committed === true, committedUncertain: error?.committedUncertain === true,
        systemIssue: storageIssueCode(error),
      } });
    }
  });
}

class PendingCommandWriter {
  constructor(target, trustedRoot) {
    this.target = target;
    this.trustedRoot = trustedRoot;
    this.nextId = 0;
  }

  #start() {
    const worker = new Worker(__filename, { workerData: { target: this.target, trustedRoot: this.trustedRoot } });
    this.worker = worker;
    worker.on("message", ({ id, error }) => {
      if (worker !== this.worker || this.pending?.id !== id) return;
      const { resolve, reject } = this.pending;
      this.pending = null;
      worker.unref();
      if (error) reject(Object.assign(new Error("PendingCommand private write failed"), error));
      else resolve();
    });
    const stopped = () => {
      if (worker !== this.worker) return;
      this.worker = null;
      const pending = this.pending;
      this.pending = null;
      // A lost reply cannot distinguish a committed replacement from one
      // that stopped before the rename. Retain the Inbox's uncertainty fence.
      pending?.reject(Object.assign(new Error("PendingCommand writer stopped before confirmation"), {
        committedUncertain: true,
      }));
    };
    // A worker emits error before exit. Keep the writer occupied until exit
    // proves that this worker can no longer touch the file or its evidence.
    worker.on("error", () => {});
    worker.on("exit", stopped);
    return worker;
  }

  write(value) {
    if (this.pending) throw new Error("PendingCommand writer only accepts one in-flight commit");
    const worker = this.worker || this.#start();
    worker.ref();
    const id = ++this.nextId;
    const { promise, resolve, reject } = Promise.withResolvers();
    this.pending = { id, resolve, reject };
    try { worker.postMessage({ id, value }); }
    catch (error) { this.pending = null; worker.unref(); reject(error); }
    return promise;
  }

  async close() {
    if (!this.worker) return;
    const worker = this.worker;
    await worker.terminate();
  }
}

module.exports = { PendingCommandWriter, serializeEnvelope };
