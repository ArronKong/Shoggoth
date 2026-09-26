"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, preparePrivateParent, readPrivateFile,
  recoverInterruptedPrivateFile, statIfExists } = require("./private-file");
const { serviceError } = require("./security");
const { runtimeBinding } = require("./runtime-adapter");
const { validateFrozenExecutionProviderRoute } = require("./execution-provider-route");

// Recovery includes the encoded context plus the command and encryption
// envelope. It must not impose a smaller limit than the native request path.
const MAX_BYTES = 32 * 1024 * 1024;
const IDENTITY_FIELDS = ["id", "profileId", "source", "sourceId", "idempotencyKey", "workspace"];
function identity(run) {
  return Object.fromEntries(IDENTITY_FIELDS.map((key) => [key, run[key] ?? null]));
}
function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function invalid() { return serviceError("EXECUTION_BINDING_INVALID", "Execution binding is invalid"); }
function validPolicy(policy) {
  return policy && Object.keys(policy).sort().join(",") === "approvalPolicy,sandbox"
    && ["untrusted", "on-failure", "on-request", "never"].includes(policy.approvalPolicy)
    && ["read-only", "workspace-write", "danger-full-access"].includes(policy.sandbox);
}

// Private, encrypted recovery descriptors. Product WorkRun remains the authority
// for status; these records never authorize replay by themselves. The Service
// writer lease owns this store, just as it owns the Product/Transcript stores.
class RunExecutionStore {
  constructor({ paths, cryptoBroker, fs: fileSystem = fs, atomicWrite = atomicWritePrivateFile }) {
    if (!paths?.stateDir || !paths.trustedRoot || !cryptoBroker?.encrypt || !cryptoBroker?.decrypt) {
      throw invalid();
    }
    this.paths = paths;
    this.cryptoBroker = cryptoBroker;
    this.fs = fileSystem;
    this.atomicWrite = atomicWrite;
  }

  #path(run) {
    if (typeof run?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(run.id)) {
      throw invalid();
    }
    return path.join(this.paths.stateDir, "run-executions", `${fingerprint(run.id)}.json`);
  }

  #validate(value, run) {
    if (!value || ![1, 2].includes(value.version) || Object.keys(value).sort().join(",")
      !== "command,contract,identity,version" || fingerprint(value.identity) !== fingerprint(identity(run))) {
      throw invalid();
    }
    const c = value.contract;
    const command = value.command;
    if (!c || c.runId !== run.id || c.profileId !== run.profileId || c.source !== run.source
      || c.sourceId !== run.sourceId || c.workspace !== run.workspace
      || typeof c.runtime !== "string" || typeof c.runtimeProfileId !== "string"
      || typeof c.runtimeAccountId !== "string" || !validPolicy(c.permissionPolicy)
      || !validPolicy(c.runtimeHostPermissionPolicy) || typeof c.developerInstructions !== "string"
      || !command || command.runId !== run.id || typeof command.operationId !== "string"
      || typeof command.prompt !== "string"
      || (run.source === "chat" ? command.kind !== "chat" : command.kind !== "domain")) throw invalid();
    try {
      runtimeBinding({ runtime: c.runtime, runtimeProfileId: c.runtimeProfileId, runtimeAccountId: c.runtimeAccountId });
    } catch { throw invalid(); }
    if (value.version === 2) {
      try { validateFrozenExecutionProviderRoute(c); } catch { throw invalid(); }
      if (!(c.bindingId === null || (typeof c.bindingId === "string" && c.bindingId.length > 0
        && c.bindingId.length <= 128 && !c.bindingId.includes("\0")))) throw invalid();
    }
    return value;
  }

  async put(run, contract, command, fence = () => {}, cryptoOptions = {}) {
    // Account generations belong to one Service lifetime and must be reacquired.
    const { runtimeAccountGeneration: ignored, ...frozenContract } = contract;
    const record = this.#validate({ version: 2, identity: identity(run),
      contract: frozenContract, command: structuredClone(command) }, run);
    let plaintext = Buffer.from(JSON.stringify(record));
    let ciphertext;
    try {
      if (plaintext.length > MAX_BYTES / 2) throw invalid();
      ciphertext = await this.cryptoBroker.encrypt(plaintext, cryptoOptions);
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw invalid();
      fence();
      const serialized = JSON.stringify({ version: 1, ciphertext: ciphertext.toString("base64") });
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw invalid();
      this.atomicWrite(this.#path(run), serialized, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
    } finally {
      plaintext.fill(0);
      ciphertext?.fill?.(0);
    }
  }

  async get(run) {
    const target = this.#path(run);
    preparePrivateParent(target, this.paths.trustedRoot, this.fs);
    recoverInterruptedPrivateFile(target, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
    if (!statIfExists(this.fs, target)) return null;
    let plaintext;
    let ciphertext;
    try {
      const envelope = JSON.parse(readPrivateFile(target, { fs: this.fs, maxBytes: MAX_BYTES }));
      if (!envelope || Object.keys(envelope).sort().join(",") !== "ciphertext,version"
        || envelope.version !== 1 || typeof envelope.ciphertext !== "string") throw invalid();
      ciphertext = Buffer.from(envelope.ciphertext, "base64");
      if (!ciphertext.length || ciphertext.toString("base64") !== envelope.ciphertext) throw invalid();
      plaintext = await this.cryptoBroker.decrypt(ciphertext);
      if (!Buffer.isBuffer(plaintext) || plaintext.length > MAX_BYTES / 2) throw invalid();
      return this.#validate(JSON.parse(plaintext.toString("utf8")), run);
    } catch {
      // Never expose decrypted content, crypto diagnostics or local paths.
      throw invalid();
    } finally {
      plaintext?.fill?.(0);
      ciphertext?.fill?.(0);
    }
  }

  has(run) {
    const target = this.#path(run);
    preparePrivateParent(target, this.paths.trustedRoot, this.fs);
    recoverInterruptedPrivateFile(target, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
    if (!statIfExists(this.fs, target)) return false;
    readPrivateFile(target, { fs: this.fs, maxBytes: MAX_BYTES }).fill(0);
    return true;
  }

  remove(run) {
    const target = this.#path(run);
    preparePrivateParent(target, this.paths.trustedRoot, this.fs);
    recoverInterruptedPrivateFile(target, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
    if (!statIfExists(this.fs, target)) return;
    // Validate file kind/owner/mode before removing only the hashed run path.
    readPrivateFile(target, { fs: this.fs, maxBytes: MAX_BYTES }).fill(0);
    this.fs.unlinkSync(target);
  }
}

module.exports = { RunExecutionStore };
