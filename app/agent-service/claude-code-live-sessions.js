"use strict";

const { serviceError } = require("./security");

// One resident Claude Code process per native session. Execution Hosts stay
// isolated per WorkRun (and keep their own MCP ticket); they borrow the
// session's process for one turn and hand it back. An idle process is released
// after DEFAULT_LIVE_IDLE_MS and the next turn resumes the native session.
const DEFAULT_LIVE_IDLE_MS = 120_000;

function liveError(code, message) {
  return serviceError(code, message);
}

function liveSessionKey({ runtimeProfileId, runtimeAccountId, workspace, remoteSessionId }) {
  return JSON.stringify([runtimeProfileId, runtimeAccountId, workspace, remoteSessionId]);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class ClaudeCodeLiveQuery {
  constructor(options) {
    this.key = options.key;
    this.runtimeProfileId = options.runtimeProfileId;
    this.policyKey = options.policyKey;
    this.inputQueue = options.inputQueue;
    this.killProcessGroup = options.killProcessGroup;
    this.shutdownGraceMs = options.shutdownGraceMs;
    this.killGraceMs = options.killGraceMs;
    this.idleMs = options.idleMs;
    this.setTimer = options.setTimer;
    this.clearTimer = options.clearTimer;
    this.onIdle = options.onIdle;
    this.query = null;
    this.child = null;
    this.exit = deferred();
    this.owner = null;
    this.initSeen = false;
    this.closed = false;
    this.closing = null;
    this.idleTimer = null;
    this.cleanupIncomplete = false;
    this.trackedClosing = null;
  }

  trackChild(child) {
    if (this.child) throw liveError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code spawned an unexpected process");
    this.child = child;
    child.once("exit", () => this.exit.resolve());
    // A spawn failure without a PID never emits exit.
    child.once("error", () => { if (!Number.isSafeInteger(child.pid) || child.pid <= 1) this.exit.resolve(); });
  }

  attach(owner) {
    if (this.closed) throw liveError("CLAUDE_CODE_PROCESS_CLOSED", "Claude Code process is closed");
    if (this.owner) throw liveError("RUNTIME_SESSION_BUSY", "Claude Code session already has an active turn");
    this.#clearIdle();
    this.owner = owner;
  }

  detach(owner) {
    if (this.owner !== owner) return;
    this.owner = null;
    if (this.closed || this.idleMs === 0) return;
    this.#clearIdle();
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      if (!this.owner && !this.closed) this.onIdle(this);
    }, this.idleMs);
    this.idleTimer?.unref?.();
  }

  // Routes the shared query's messages to the turn that currently borrows the
  // process. The owner may belong to a later WorkRun's Host than the opener.
  async consume() {
    let failure = null;
    try {
      for await (const message of this.query) {
        const owner = this.owner;
        if (!owner) {
          this.#ownerless(message);
          continue;
        }
        try {
          await owner.host._onSdkMessage(owner.active, message);
        } catch (error) {
          owner.host._failActive(owner.active, owner.host._sdkFailure(error), {
            definitelyRejected: !owner.active.inputReleased,
          });
        }
      }
    } catch (error) {
      failure = error;
    }
    const owner = this.owner;
    this.onIdle(this);
    if (owner && !owner.active.settled) owner.host._liveEnded(owner.active, failure);
  }

  #ownerless(message) {
    if (message?.type === "system" && message.subtype === "init") this.initSeen = true;
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.#clearIdle();
    this.closing = (async () => {
      this.inputQueue.close();
      try { this.query?.close?.(); } catch {}
      if (!this.child) return;
      if (await this.#exited(this.shutdownGraceMs)) return;
      this.#signal("SIGTERM");
      if (await this.#exited(this.killGraceMs)) return;
      this.#signal("SIGKILL");
      if (await this.#exited(this.killGraceMs)) return;
      this.cleanupIncomplete = true;
    })();
    return this.closing;
  }

  #signal(signal) {
    if (!Number.isSafeInteger(this.child?.pid) || this.child.pid <= 1) return;
    try { this.killProcessGroup(this.child.pid, signal); } catch {}
  }

  async #exited(ms) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.exit.promise.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  #clearIdle() {
    if (this.idleTimer === null) return;
    this.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }
}

class ClaudeCodeLiveSessions {
  constructor(options = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_LIVE_IDLE_MS;
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 0) {
      throw liveError("CLAUDE_CODE_POOL_OPTIONS_INVALID", "Claude Code idle release is invalid");
    }
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.entries = new Map();
    this.closings = new Map();
  }

  create(options) {
    const existing = this.get(options.key);
    if (existing) throw liveError("RUNTIME_SESSION_BUSY", "Claude Code session already has a process");
    const live = new ClaudeCodeLiveQuery({
      ...options,
      idleMs: this.idleMs,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onIdle: (current) => { void this.close(current); },
    });
    this.entries.set(live.key, live);
    return live;
  }

  get(key) {
    const live = this.entries.get(key);
    return live && !live.closed ? live : null;
  }

  // A replaced or released process must exit before another process opens the
  // same native session; two writers would interleave one session transcript.
  settled(key) {
    return this.closings.get(key) || Promise.resolve();
  }

  close(live) {
    if (this.entries.get(live.key) === live) this.entries.delete(live.key);
    if (!live.trackedClosing) {
      const tracked = live.close().finally(() => {
        if (this.closings.get(live.key) === tracked) this.closings.delete(live.key);
      });
      live.trackedClosing = tracked;
      this.closings.set(live.key, tracked);
    }
    return live.trackedClosing;
  }

  async closeWhere(predicate) {
    const lives = [...this.entries.values()].filter(predicate);
    await Promise.all([
      ...lives.map((live) => this.close(live)),
      ...[...this.closings.values()],
    ]);
    return lives.filter((live) => live.cleanupIncomplete);
  }

  closeProfile(runtimeProfileId) {
    return this.closeWhere((live) => live.runtimeProfileId === runtimeProfileId);
  }

  closeAll() {
    return this.closeWhere(() => true);
  }
}

module.exports = {
  DEFAULT_LIVE_IDLE_MS,
  ClaudeCodeLiveQuery,
  ClaudeCodeLiveSessions,
  liveSessionKey,
};
