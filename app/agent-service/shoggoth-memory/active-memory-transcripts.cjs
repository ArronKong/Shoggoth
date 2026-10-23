"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { core } = require("./host.cjs");
const { MAX_TRANSCRIPT_BYTES } = require("./active-memory-state.cjs");
const { ensurePrivateDirectoryTree, serviceError } = require("../security");
const { atomicWritePrivateFile, fsyncPrivateParent, readPrivateFile, validatePrivateStat } = require("../private-file");

const denied = () => serviceError("MEMORY_ACTIVE_TRANSCRIPT_SCOPE_INVALID", "自动召回诊断文件归属或留存设置已变化");
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

// An opt-in diagnostic copy of this invocation's existing scratch events. It is
// outside the memory workspace, never a recall source, and survives cancellation
// just like upstream. Disabling retention stops new copies, not past artifacts.
class ActiveMemoryTranscriptArtifacts {
  constructor(runtime, assertCurrent) {
    this.runtime = runtime; this.assertOwner = assertCurrent;
    this.saved = null; this.failure = null;
  }
  location() {
    const runtime = this.runtime;
    runtime.assertCurrent();
    if (!runtime.config.persistTranscripts || !runtime.target) throw denied();
    this.assertOwner?.();
    const directory = core.resolveSafeTranscriptDir(
      core.resolvePersistentTranscriptBaseDir(runtime.api, runtime.host.profileId), runtime.config.transcriptDir);
    return { directory, file: path.join(directory, `${runtime.target.sessionId}.jsonl`) };
  }
  mkdir(directory, options) {
    const expected = this.location();
    if (directory !== expected.directory || options?.recursive !== true || options?.mode !== 0o700
      || Object.keys(options).length !== 2) throw denied();
    ensurePrivateDirectoryTree(directory, this.runtime.host.paths.trustedRoot);
  }
  chmod(directory, mode) {
    if (directory !== this.location().directory || mode !== 0o700) throw denied();
    ensurePrivateDirectoryTree(directory, this.runtime.host.paths.trustedRoot);
  }
  async writeFile(file, text, options) {
    const expected = this.location();
    if (file !== expected.file || options?.encoding !== "utf8" || options?.mode !== 0o600
      || Object.keys(options).length !== 2 || typeof text !== "string"
      || Buffer.byteLength(text) > MAX_TRANSCRIPT_BYTES) throw denied();
    const record = await this.runtime.readRecord();
    if (this.location().file !== file || !record?.events.length
      || text !== `${[...new Set(record.events.map(event => JSON.stringify(event)))].join("\n")}\n`) throw denied();
    const storedText = `${[...new Set(this.runtime.persistedRecord(record).events.map(event => JSON.stringify(event)))].join("\n")}\n`;
    if (this.failure) throw this.failure;
    ensurePrivateDirectoryTree(expected.directory, this.runtime.host.paths.trustedRoot);
    if (this.saved) {
      const stat = validatePrivateStat(fs.lstatSync(file), file);
      if (!sameIdentity(stat, this.saved) || readPrivateFile(file, { maxBytes: MAX_TRANSCRIPT_BYTES }).toString("utf8") !== storedText) throw denied();
      return;
    }
    // Reserve a fresh path exclusively before using the existing atomic writer.
    // A collision or attacker-created link must never replace another artifact.
    let reserved, fd;
    try {
      fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      reserved = validatePrivateStat(fs.fstatSync(fd), file);
      fs.closeSync(fd); fd = undefined;
      atomicWritePrivateFile(file, storedText, { trustedRoot: this.runtime.host.paths.trustedRoot, expectedIdentity: reserved });
      this.saved = validatePrivateStat(fs.lstatSync(file), file);
    } catch (error) {
      this.failure = error;
      if (reserved && !error.committed && !error.committedUncertain) {
        try {
          const current = validatePrivateStat(fs.lstatSync(file), file);
          if (sameIdentity(current, reserved) && current.size === 0) { fs.unlinkSync(file); fsyncPrivateParent(expected.directory); }
        } catch {}
      }
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}

module.exports = { ActiveMemoryTranscriptArtifacts };
