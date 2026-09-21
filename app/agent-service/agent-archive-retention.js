"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_AGENT_PROFILE_ID } = require("./product-store");
const { BUILTIN_CLI_AGENT_PROFILES } = require("./builtin-cli-profiles");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { validateCanonicalOwnedDirectory, sameIdentity } = require("./runtime-storage-inspector");

const AGENT_ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_ARCHIVE_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const PROTECTED = new Set([DEFAULT_AGENT_PROFILE_ID, ...BUILTIN_CLI_AGENT_PROFILES.map((p) => p.id)]);
const RUNTIMES = new Set(["codex", "grok-build", "antigravity", "pi", "claude-code", "deepseek-harness"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BUSY = new Set(["queued", "starting", "running", "waiting_approval", "waiting_input"]);

function fail(code = "AGENT_RETENTION_FAILED") {
  throw serviceError(code, code === "AGENT_RETENTION_EXPIRED"
    ? "Agent 的 7 天保留期已结束，无法恢复" : "Agent 归档清理未完成，将保留记录重试");
}

// Owned by the Service's lifecycle queue. The journal carries deadlines and
// crash recovery intent only; no workspace or Runtime Home is a cleanup target.
class AgentArchiveRetention {
  constructor(options) {
    this.options = options;
    this.paths = options.paths;
    this.productStore = options.productStore;
    this.now = options.now || Date.now;
    this.filePath = path.join(this.paths.stateDir, "agent-archive-retention.json");
    this.trashDir = path.join(this.paths.stateDir, "agent-archive-trash");
    this.entries = {};
    this.opened = false;
    this.poisoned = false;
    this.timer = null;
    this.inFlight = null;
    this.runExclusive = null;
    this.onError = null;
    this.generation = 0;
    this.retryAfter = 0;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
  }

  open() {
    if (this.opened) return;
    // macOS exposes /var and /tmp through system aliases. Resolve the trusted
    // root once, while rejecting links introduced inside that root.
    const trustedRoot = fs.realpathSync(this.paths.trustedRoot);
    const relative = path.relative(this.paths.trustedRoot, this.paths.stateDir);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)
      || fs.lstatSync(this.paths.trustedRoot).isSymbolicLink()
      || fs.realpathSync(this.paths.stateDir) !== path.join(trustedRoot, relative)) fail();
    this.paths = { ...this.paths, trustedRoot, stateDir: path.join(trustedRoot, relative) };
    this.filePath = path.join(this.paths.stateDir, "agent-archive-retention.json");
    this.trashDir = path.join(this.paths.stateDir, "agent-archive-trash");
    validateCanonicalOwnedDirectory(this.paths.stateDir, { trustedRoot: this.paths.trustedRoot });
    if (recoverInterruptedPrivateFile(this.filePath, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail();
    let entries = {};
    if (lstatIfExists(this.filePath)) {
      const value = JSON.parse(readPrivateFile(this.filePath, { maxBytes: 4 * 1024 * 1024 }).toString("utf8"));
      if (!value || value.version !== 1 || Object.keys(value).length !== 2
        || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) fail();
      entries = value.entries;
      if (Object.keys(entries).length > 8192) fail();
      for (const [id, entry] of Object.entries(entries)) {
        if (!ID.test(id) || PROTECTED.has(id) || !entry || Object.keys(entry).length !== 6
          || !["profileId", "runtime", "runtimeProfileId", "archivedAt", "deleteAfter", "phase"]
            .every((key) => Object.hasOwn(entry, key))
          || entry.profileId !== id || typeof entry.runtimeProfileId !== "string"
          || !ID.test(entry.runtimeProfileId) || !RUNTIMES.has(entry.runtime)
          || !Number.isSafeInteger(entry.archivedAt) || entry.archivedAt < 0
          || !Number.isSafeInteger(entry.deleteAfter)
          || entry.deleteAfter !== entry.archivedAt + AGENT_ARCHIVE_RETENTION_MS
          || !["retained", "purging"].includes(entry.phase)) fail();
      }
    }
    this.entries = entries;
    this.poisoned = false;
    this.opened = true;
  }

  _assertOpen() { if (!this.opened || this.poisoned) fail(); }
  _time() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - AGENT_ARCHIVE_RETENTION_MS) fail();
    return value;
  }
  _save(entries) {
    this._assertOpen();
    try {
      atomicWritePrivateFile(this.filePath, `${JSON.stringify({ version: 1, entries })}\n`, {
        trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (error?.committed !== true) {
        if (error?.committedUncertain) {
          this.poisoned = true;
          this._clearTimer();
          // Archive/restore writes may happen without a scheduled sweep. A
          // failed journal commit must still reach the Service's fatal handler.
          if (!this.inFlight) this._reportError(error, this.generation, this.onError);
        }
        fail();
      }
    }
    this.entries = entries;
    this._scheduleNext();
  }

  recordArchive(profile) {
    this._assertOpen();
    if (profile.enabled || profile.isDefault || PROTECTED.has(profile.id)
      || !ID.test(profile.id) || !ID.test(profile.runtimeProfileId) || !RUNTIMES.has(profile.runtime)) fail();
    if (this.entries[profile.id]) return;
    const archivedAt = this._time();
    this._save({ ...this.entries, [profile.id]: {
      profileId: profile.id, runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
      archivedAt, deleteAfter: archivedAt + AGENT_ARCHIVE_RETENTION_MS, phase: "retained",
    } });
  }

  assertRestorable(profileId) {
    this._assertOpen();
    const entry = this.entries[profileId];
    if (entry && (entry.phase === "purging" || this._time() >= entry.deleteAfter)) fail("AGENT_RETENTION_EXPIRED");
  }

  cancel(profileId) {
    this._assertOpen();
    if (!this.entries[profileId]) return;
    const entries = { ...this.entries };
    delete entries[profileId];
    this._save(entries);
  }

  _busy(profileId) {
    return this.productStore.listWorkRuns({ profileId }).some((run) => BUSY.has(run.status))
      || this.productStore.listMcpToolCalls().some((call) => call.status === "pending"
        && (call.profileId === profileId || call.binding?.profileId === profileId
          || call.binding?.targetProfileId === profileId));
  }

  async sweep({ resumeOnly = false } = {}) {
    this._assertOpen();
    if (this.options.ready && !this.options.ready()) {
      if (resumeOnly && Object.values(this.entries).some((entry) => entry.phase === "purging")) fail();
      return;
    }
    // Legacy archives get a full seven days from first observation by this
    // version. Disabled, unfinished provisioning is never treated as archival.
    for (const profile of resumeOnly ? [] : this.productStore.listAgentProfiles()) {
      if (profile.enabled) {
        if (this.entries[profile.id]?.phase === "retained") this.cancel(profile.id);
      } else if (!profile.isDefault && !PROTECTED.has(profile.id) && !this._busy(profile.id)) {
        this.recordArchive(profile);
      }
    }
    for (const entry of Object.values(this.entries)) {
      if (resumeOnly && entry.phase !== "purging") continue;
      // Once deletion starts it must finish, even if the system clock moves
      // backwards before the next Service startup.
      if (entry.phase !== "purging" && this._time() < entry.deleteAfter) continue;
      const profile = this.productStore.getAgentProfile(entry.profileId);
      if (profile) {
        if (profile.enabled || profile.isDefault || PROTECTED.has(profile.id) || this._busy(profile.id)) continue;
        if (profile.runtime !== entry.runtime || profile.runtimeProfileId !== entry.runtimeProfileId) fail();
        await this.options.stopProfile(profile);
        this._assertOpen();
        if (this.productStore.getAgentProfile(profile.id)?.updatedAt !== profile.updatedAt
          || this._busy(profile.id)) continue;
        for (const [, target] of this._fileTargets(entry)) {
          if (lstatIfExists(target)) validateCanonicalOwnedDirectory(target, { trustedRoot: this.paths.stateDir });
        }
        // Persist intent before touching any Store. A partial purge cannot be
        // restored into a partly deleted Agent; the next sweep resumes it.
        if (entry.phase !== "purging") this._save({ ...this.entries, [entry.profileId]: { ...entry, phase: "purging" } });
        this._removePublishedArtifacts(profile.id);
        this.options.purgeProfile(profile);
      } else if (entry.phase !== "purging") {
        this.cancel(entry.profileId);
        continue;
      }
      this._removeFiles(entry);
      this.cancel(entry.profileId);
    }
    if (resumeOnly && Object.values(this.entries).some((entry) => entry.phase === "purging")) fail();
  }

  _fileTargets(entry) {
    return [
      ["agent", path.join(this.paths.stateDir, "agents", entry.profileId)],
      ["computer", path.join(this.paths.stateDir, "computer", "artifacts",
        crypto.createHash("sha256").update(entry.profileId).digest("hex").slice(0, 32))],
      ["ledger", path.join(this.paths.stateDir, "runtime-ledgers", entry.runtime, entry.runtimeProfileId)],
    ];
  }

  _removePublishedArtifacts(profileId) {
    const artifacts = this.options.listPublishedArtifacts?.() || [];
    const shared = new Set(artifacts.filter((item) => item.profileId !== profileId).map((item) => item.storageKey));
    const keys = [...new Set(artifacts.filter((item) => item.profileId === profileId
      && /^artifacts\/[a-f0-9]{64}$/u.test(item.storageKey) && !shared.has(item.storageKey))
      .map((item) => item.storageKey))];
    if (keys.length === 0) return;
    const root = path.join(this.paths.stateDir, "artifacts");
    if (!lstatIfExists(root)) return;
    validateCanonicalOwnedDirectory(root, { trustedRoot: this.paths.stateDir });
    const targets = keys.map((key) => path.join(this.paths.stateDir, key));
    // Remove the private copy before its Store references, so an interrupted
    // purge can always rediscover the remaining files on the next attempt.
    for (const target of targets) {
      const stat = lstatIfExists(target);
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail();
    }
    for (const target of targets) {
      try { fs.unlinkSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const fd = fs.openSync(root, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  _removeFiles(entry) {
    ensurePrivateDirectoryTree(this.trashDir, this.paths.trustedRoot);
    for (const [kind, source] of this._fileTargets(entry)) {
      const staged = path.join(this.trashDir, `${entry.profileId}-${kind}`);
      const existing = lstatIfExists(source);
      if (existing) {
        if (lstatIfExists(staged)) fail();
        const identity = validateCanonicalOwnedDirectory(source, { trustedRoot: this.paths.stateDir });
        validateCanonicalOwnedDirectory(this.trashDir, { trustedRoot: this.paths.stateDir });
        if (!sameIdentity(identity, fs.lstatSync(source))) fail();
        fs.renameSync(source, staged);
        for (const dir of [path.dirname(source), this.trashDir]) {
          const fd = fs.openSync(dir, fs.constants.O_RDONLY);
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
      }
      if (lstatIfExists(staged)) {
        validateCanonicalOwnedDirectory(staged, { trustedRoot: this.paths.stateDir });
        // rm unlinks nested symlinks; it never traverses their targets.
        fs.rmSync(staged, { recursive: true });
      }
    }
  }

  _clearTimer() {
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
  }

  _reportError(error, generation, onError) {
    if (!onError) return;
    // A fatal reporter may stop Service, whose close() awaits inFlight.
    setImmediate(() => {
      if (generation === this.generation && this.opened) onError(error);
    });
  }

  _scheduleNext() {
    this._clearTimer();
    if (!this.opened || this.poisoned || !this.runExclusive || this.inFlight) return;
    const entries = Object.values(this.entries);
    if (entries.length === 0) {
      this.retryAfter = 0;
      return;
    }
    const now = this._time();
    const next = Math.min(...entries.map((entry) => {
      const due = entry.phase === "purging" ? now : entry.deleteAfter;
      return due <= now ? Math.max(now, this.retryAfter) : due;
    }));
    const generation = this.generation;
    // A clock correction may put a deadline beyond Node's timer range.
    // On wake, sweep still compares the persisted deadline before deleting.
    this.timer = this.setTimeout(() => {
      if (generation !== this.generation) return;
      this.timer = null;
      this._tick();
    }, Math.max(1, Math.min(MAX_TIMER_DELAY_MS, next - now)));
    this.timer.unref?.();
  }

  _tick() {
    if (!this.opened || this.poisoned || !this.runExclusive || this.inFlight) return;
    this._clearTimer();
    const generation = this.generation;
    const runExclusive = this.runExclusive;
    const onError = this.onError;
    this.inFlight = Promise.resolve().then(() => runExclusive(() => this.sweep())).catch((error) => {
      this._reportError(error, generation, onError);
    }).finally(() => {
      this.inFlight = null;
      if (generation !== this.generation || !this.runExclusive || this.poisoned) return;
      // An expired archive that is busy or failed must not spin on a zero-delay
      // timer. Retry it later; future archives retain their own exact deadline.
      this.retryAfter = this._time() + AGENT_ARCHIVE_RETRY_DELAY_MS;
      this._scheduleNext();
    });
  }

  start(runExclusive, onError) {
    this._assertOpen();
    if (this.runExclusive) return;
    this.generation += 1;
    this.retryAfter = 0;
    this.runExclusive = runExclusive;
    this.onError = onError;
    this._tick();
  }

  async close() {
    this.generation += 1;
    this.runExclusive = null;
    this._clearTimer();
    await this.inFlight;
    this.opened = false;
  }
}

module.exports = { AgentArchiveRetention, AGENT_ARCHIVE_RETENTION_MS, AGENT_ARCHIVE_RETRY_DELAY_MS };
