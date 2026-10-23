"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, statIfExists } = require("./private-file");
const { runtimeBinding } = require("./runtime-adapter");
const { serviceError } = require("./security");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const validId = id => typeof id === "string" && id.length > 0 && id.length <= 512 && !id.includes("\0");

// Receipts contain hashes only. A session/new receipt proves which immutable
// rules the native system plane accepted; it never authorizes a user operation.
class RuntimeInstructionState {
  constructor({ directory, trustedRoot, binding, fs: fileSystem = fs }) {
    this.binding = runtimeBinding(binding);
    this.identity = JSON.stringify(this.binding);
    this.target = path.join(directory, `instruction-state-${hash(this.identity).slice(0, 24)}.json`);
    this.trustedRoot = trustedRoot;
    this.fs = fileSystem;
  }
  read() {
    if (!statIfExists(this.fs, this.target)) return {};
    let value;
    try { value = JSON.parse(readPrivateFile(this.target, { fs: this.fs, maxBytes: 2 * 1024 * 1024 })); }
    catch (cause) { throw serviceError("RUNTIME_INSTRUCTION_STATE_INVALID", "Native instruction receipt is unreadable"); }
    if (value?.version !== 1 || Object.keys(value).sort().join(",") !== "checksum,identity,sessions,version"
      || value.identity !== this.identity || !value.sessions
      || Object.getPrototypeOf(value.sessions) !== Object.prototype
      || Object.keys(value.sessions).length > 4096
      || Object.entries(value.sessions).some(([id, digest]) => !validId(id) || !/^[a-f0-9]{64}$/u.test(digest))
      || value.checksum !== hash(JSON.stringify(value.sessions))) {
      throw serviceError("RUNTIME_INSTRUCTION_STATE_INVALID", "Native instruction receipt is invalid");
    }
    return value.sessions;
  }
  matches(sessionId, instructions) { return this.read()[sessionId] === hash(instructions); }
  has(sessionId) { return Object.hasOwn(this.read(), sessionId); }
  record(sessionId, instructions) {
    if (!validId(sessionId) || typeof instructions !== "string") throw new TypeError("Invalid instruction receipt");
    const sessions = { ...this.read(), [sessionId]: hash(instructions) };
    if (Object.keys(sessions).length > 4096) throw serviceError("RUNTIME_INSTRUCTION_STATE_CAPACITY", "Native instruction receipt capacity exceeded");
    const serialized = JSON.stringify({ version: 1, identity: this.identity,
      sessions, checksum: hash(JSON.stringify(sessions)) });
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
      throw serviceError("RUNTIME_INSTRUCTION_STATE_CAPACITY", "Native instruction receipt capacity exceeded");
    }
    atomicWritePrivateFile(this.target, serialized, { fs: this.fs, trustedRoot: this.trustedRoot });
  }
}

function instructionRenewal(error) {
  const own = (value, key) => Object.getOwnPropertyDescriptor(value ?? {}, key)?.value;
  for (let i = 0; error && i < 8; i++, error = own(error, "cause")) {
    if (own(error, "code") === "RUNTIME_SESSION_INSTRUCTIONS_CHANGED"
      && own(error, "acceptance") === "not_sent" && validId(own(error, "sessionId"))) {
      return { sessionId: own(error, "sessionId") };
    }
  }
  return null;
}

module.exports = { RuntimeInstructionState, instructionRenewal };
