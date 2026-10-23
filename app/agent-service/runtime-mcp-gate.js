"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { assertRuntimeProfileId } = require("./codex-runtime-paths");
const { atomicWritePrivateFile } = require("./private-file");
const { validRuntimeAccountId } = require("./runtime-adapter");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");

const DEFAULT_GATE_TTL_MS = 45_000;
// Harness-child tickets are handed over at session/new|resume, but the runtime's
// harness starts the helper only when the first prompt runs. An unused ticket
// therefore lapses (its file is removed) instead of being forgotten, and the
// owning host renews it right before dispatching the prompt.
const HARNESS_RENEWAL_WINDOW_MS = 10 * 60_000;
const GATE_FILE_PATTERN = /^mcp-[a-f0-9]{64}\.gate$/u;

function gateError(code, message) {
  return serviceError(code, message);
}

function assertExecutable(fileSystem, target, code) {
  if (typeof target !== "string" || !path.isAbsolute(target) || target.includes("\0")) {
    throw gateError(code, "Runtime MCP executable path is invalid");
  }
  try {
    const direct = fileSystem.lstatSync(target);
    const resolved = fileSystem.realpathSync(target);
    const stat = fileSystem.lstatSync(resolved);
    if (!direct.isFile() || direct.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && ![0, process.getuid()].includes(stat.uid))) {
      throw new Error("unsafe executable");
    }
    fileSystem.accessSync(resolved, fileSystem.constants.X_OK);
    return resolved;
  } catch {
    throw gateError(code, "Runtime MCP executable is unavailable or unsafe");
  }
}

function assertBootstrap(fileSystem, target) {
  if (typeof target !== "string" || !path.isAbsolute(target) || target.includes("\0")) {
    throw gateError("RUNTIME_MCP_GATE_OPTIONS_INVALID", "Runtime MCP bootstrap path is invalid");
  }
  try {
    const direct = fileSystem.lstatSync(target);
    if (!direct.isFile() || direct.isSymbolicLink()) throw new Error("unsafe bootstrap");
    return path.resolve(target);
  } catch {
    throw gateError("RUNTIME_MCP_GATE_OPTIONS_INVALID", "Runtime MCP bootstrap is unavailable or unsafe");
  }
}

function bootstrapPathOption(target) {
  if (typeof target !== "string" || !path.isAbsolute(target) || target.includes("\0")) {
    throw gateError("RUNTIME_MCP_GATE_OPTIONS_INVALID", "Runtime MCP bootstrap path is invalid");
  }
  return path.resolve(target);
}

function validateArgs(value) {
  return Array.isArray(value) && value.length <= 32
    && value.every((item) => typeof item === "string" && item.isWellFormed()
      && !item.includes("\0") && Buffer.byteLength(item, "utf8") <= 4096);
}

function runtimeServicePaths(paths) {
  const fields = ["trustedRoot", "stateDir", "mcpAuthPath", "runtimeDir", "socketPath"];
  if (!fields.every((field) => typeof paths?.[field] === "string"
    && path.isAbsolute(paths[field]) && !paths[field].includes("\0"))
    || path.dirname(paths.mcpAuthPath) !== paths.stateDir
    || path.basename(paths.mcpAuthPath) !== "mcp-auth.json"
    || path.dirname(paths.socketPath) !== paths.runtimeDir
    || path.basename(paths.socketPath) !== "service.sock") {
    throw gateError("RUNTIME_MCP_GATE_OPTIONS_INVALID", "Runtime MCP service paths are invalid");
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, paths[field]])));
}

function secureEqual(left, right) {
  const a = Buffer.from(typeof left === "string" ? left : "");
  const b = Buffer.from(typeof right === "string" ? right : "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function defaultProcessIdentity(pid) {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4096,
    }).trim();
  } catch {
    return "";
  }
}

function defaultProcessLink(pid) {
  try {
    const read = (field) => execFileSync("/bin/ps", ["-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4096,
    }).trim();
    return { ppid: Number(read("ppid")), executable: read("comm") };
  } catch {
    return { ppid: 0, executable: "" };
  }
}

class RuntimeMcpGateIssuer {
  constructor(options = {}) {
    if (!options.paths?.runtimeDir || !options.paths?.trustedRoot
      || !options.mcpHelperLaunch || !validateArgs(options.mcpHelperLaunch.argsPrefix || [])) {
      throw gateError("RUNTIME_MCP_GATE_OPTIONS_INVALID", "Runtime MCP gate options are invalid");
    }
    const ttlMs = options.ttlMs ?? DEFAULT_GATE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60_000) {
      throw gateError("RUNTIME_MCP_GATE_OPTIONS_INVALID", "Runtime MCP gate TTL is invalid");
    }
    this.paths = options.paths;
    this.servicePaths = runtimeServicePaths(options.paths);
    this.fs = options.fs || fs;
    this.helperCommand = assertExecutable(
      this.fs,
      options.mcpHelperLaunch.command,
      "RUNTIME_MCP_GATE_OPTIONS_INVALID",
    );
    this.bootstrapPath = bootstrapPathOption(
      options.bootstrapPath || path.join(__dirname, "..", "bootstrap.js"),
    );
    this.now = options.now || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;
    this.getProcessIdentity = options.getProcessIdentity || defaultProcessIdentity;
    this.getProcessLink = options.getProcessLink || defaultProcessLink;
    this.ttlMs = ttlMs;
    this.gateRoot = path.join(this.paths.runtimeDir, "mcp-gates");
    this.issued = new Map();
    this.opened = false;
  }

  open() {
    if (this.opened) return this;
    this.bootstrapPath = assertBootstrap(this.fs, this.bootstrapPath);
    ensurePrivateDirectoryTree(this.gateRoot, this.paths.trustedRoot);
    for (const name of this.fs.readdirSync(this.gateRoot)) {
      if (!GATE_FILE_PATTERN.test(name)) {
        throw gateError("RUNTIME_MCP_GATE_UNSAFE", "Runtime MCP gate directory is contaminated");
      }
      const target = path.join(this.gateRoot, name);
      const stat = this.fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw gateError("RUNTIME_MCP_GATE_UNSAFE", "Runtime MCP gate file is unsafe");
      }
      this.fs.unlinkSync(target);
    }
    this.opened = true;
    return this;
  }

  createMcpServer(input = {}) {
    const reservation = this.reserveMcpServer(input);
    try {
      this.bindMcpServer(input.ancestorExecutable === undefined ? {
        reservationId: reservation.reservationId,
        parentPid: input.parentPid,
      } : {
        reservationId: reservation.reservationId,
        ancestorPid: input.ancestorPid,
      });
    } catch (error) {
      this.revokeMcpServer({ reservationId: reservation.reservationId });
      throw error;
    }
    const { reservationId, ...descriptor } = reservation;
    // Only harness-child tickets are renewable; their host keeps this handle.
    return Object.freeze(input.ancestorExecutable === undefined
      ? descriptor : { ...descriptor, reservationId });
  }

  reserveMcpServer(input = {}) {
    if (!this.opened) {
      throw gateError("RUNTIME_MCP_GATE_CLOSED", "Runtime MCP gate issuer is closed");
    }
    let runtimeProfileId;
    try { runtimeProfileId = assertRuntimeProfileId(input.runtimeProfileId); } catch {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP profile is invalid");
    }
    if (!validRuntimeAccountId(input.runtimeAccountId)) {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP account is invalid");
    }
    const runtimeAccountId = input.runtimeAccountId;
    // "resident" lists only core product tools plus product_tool_search/call
    // (see product-tool-exposure.js); it narrows the list and grants nothing.
    const toolExposure = input.toolExposure ?? "all";
    if (!["all", "resident"].includes(toolExposure)) {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP tool exposure is invalid");
    }
    const executionRunId = input.executionRunId ?? null;
    if (executionRunId !== null && (typeof executionRunId !== "string"
      || !executionRunId.trim() || executionRunId.includes("\0")
      || Buffer.byteLength(executionRunId, "utf8") > 256)) {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP execution binding is invalid");
    }
    const parentExecutable = assertExecutable(
      this.fs,
      input.parentExecutable,
      "RUNTIME_MCP_GATE_INPUT_INVALID",
    );
    // Harness-child tickets: the MCP helper's parent is `parentExecutable`
    // (a pinned harness) whose own parent is the bound `ancestorExecutable`.
    const ancestorExecutable = input.ancestorExecutable === undefined ? null : assertExecutable(
      this.fs,
      input.ancestorExecutable,
      "RUNTIME_MCP_GATE_INPUT_INVALID",
    );
    const nonceBytes = this.randomBytes(32);
    if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 32) {
      throw gateError("RUNTIME_MCP_GATE_RANDOM_FAILED", "Runtime MCP gate randomness failed");
    }
    const nonce = nonceBytes.toString("hex");
    nonceBytes.fill(0);
    const gatePath = path.join(this.gateRoot, `mcp-${nonce}.gate`);
    if (this.issued.has(gatePath) || lstatIfExists(gatePath)) {
      throw gateError("RUNTIME_MCP_GATE_COLLISION", "Runtime MCP gate collision detected");
    }
    const expiresAt = this.now() + this.ttlMs;
    const timer = this.#scheduleExpiry(gatePath, this.ttlMs + 1_000);
    this.issued.set(gatePath, {
      bound: false,
      dev: null,
      ino: null,
      timer,
      nonce,
      runtimeProfileId,
      runtimeAccountId,
      parentPid: null,
      executionRunId,
      parentExecutable,
      parentIdentity: null,
      ancestorExecutable,
      ancestorPid: null,
      ancestorIdentity: null,
      consumed: false,
      expiresAt,
      renewUntil: ancestorExecutable === null ? null : this.now() + HARNESS_RENEWAL_WINDOW_MS,
    });
    return Object.freeze({
      reservationId: nonce,
      name: "shoggoth",
      command: this.helperCommand,
      args: Object.freeze([
        this.bootstrapPath,
        "--shoggoth-internal-role=mcp",
        `--shoggoth-runtime-profile=${runtimeProfileId}`,
        `--shoggoth-runtime-account=${runtimeAccountId}`,
        ...(toolExposure === "resident" ? ["--shoggoth-tool-exposure=resident"] : []),
      ]),
      env: Object.freeze([
        Object.freeze({ name: "ELECTRON_RUN_AS_NODE", value: "1" }),
        Object.freeze({ name: "SHOGGOTH_INTERNAL_LAUNCH", value: "launch-agent-v1" }),
        Object.freeze({ name: "SHOGGOTH_RUNTIME_MCP_GATE_FILE", value: gatePath }),
        Object.freeze({ name: "SHOGGOTH_RUNTIME_MCP_GATE_NONCE", value: nonce }),
      ]),
    });
  }

  bindMcpServer(input = {}) {
    if (!this.opened) {
      throw gateError("RUNTIME_MCP_GATE_CLOSED", "Runtime MCP gate issuer is closed");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.reservationId || "")) {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP reservation is invalid");
    }
    const gatePath = path.join(this.gateRoot, `mcp-${input.reservationId}.gate`);
    const record = this.issued.get(gatePath);
    if (!record || record.bound || record.expiresAt < this.now()) {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP reservation is unavailable");
    }
    const harnessChild = record.ancestorExecutable !== null;
    const boundPid = harnessChild ? input.ancestorPid : input.parentPid;
    if (!Number.isSafeInteger(boundPid) || boundPid <= 1
      || (harnessChild ? input.parentPid !== undefined : input.ancestorPid !== undefined)) {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP reservation is invalid");
    }
    const boundIdentity = this.getProcessIdentity(boundPid);
    if (typeof boundIdentity !== "string" || boundIdentity.length === 0
      || Buffer.byteLength(boundIdentity, "utf8") > 4096) {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP parent process is unavailable");
    }
    const identity = this.#publish(gatePath, record, boundPid, record.expiresAt);
    record.bound = true;
    record.dev = identity.dev;
    record.ino = identity.ino;
    if (harnessChild) {
      record.ancestorPid = boundPid;
      record.ancestorIdentity = boundIdentity;
    } else {
      record.parentPid = boundPid;
      record.parentIdentity = boundIdentity;
    }
    return Object.freeze({ bound: true });
  }

  // Restarts a harness-child ticket's TTL, including one that lapsed while its
  // session/new was slow. Consumed, revoked or direct-parent tickets stay as they are.
  renewMcpServer(input = {}) {
    if (!this.opened) {
      throw gateError("RUNTIME_MCP_GATE_CLOSED", "Runtime MCP gate issuer is closed");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.reservationId || "")) {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP reservation is invalid");
    }
    const gatePath = path.join(this.gateRoot, `mcp-${input.reservationId}.gate`);
    const record = this.issued.get(gatePath);
    if (!record || record.bound !== true) {
      throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP reservation is unavailable");
    }
    if (record.renewUntil === null) return Object.freeze({ renewed: false });
    if (this.now() >= record.renewUntil) {
      this.#removeIssued(gatePath);
      throw gateError("RUNTIME_MCP_GATE_EXPIRED", "Runtime MCP reservation expired");
    }
    if (this.getProcessIdentity(record.ancestorPid) !== record.ancestorIdentity) {
      this.#removeIssued(gatePath);
      throw gateError("RUNTIME_MCP_GATE_PARENT_MISMATCH", "Runtime MCP ancestor changed");
    }
    // A consumed receipt proves the eager helper is connected. Missing/revoked
    // reservations never masquerade as that success, and cannot be revived.
    if (record.consumed) return Object.freeze({ renewed: false, consumed: true });
    // Replace rather than overwrite: an overwrite leaves backup links that the
    // gate directory's naming invariant rejects after a crash.
    try {
      let current;
      try { current = this.fs.lstatSync(gatePath); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (record.dev === null ? current !== undefined
        : !current || current.dev !== record.dev || current.ino !== record.ino
          || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
          || (current.mode & 0o077) !== 0) {
        throw gateError("RUNTIME_MCP_GATE_REPLACED", "Runtime MCP gate changed");
      }
      this.#unlinkBound(gatePath, record);
      record.dev = null;
      record.ino = null;
      const expiresAt = Math.min(this.now() + this.ttlMs, record.renewUntil);
      const identity = this.#publish(gatePath, record, record.ancestorPid, expiresAt);
      record.expiresAt = expiresAt;
      record.dev = identity.dev;
      record.ino = identity.ino;
      this.clearTimer(record.timer);
      record.timer = this.#scheduleExpiry(gatePath, expiresAt - this.now() + 1_000);
    } catch (error) {
      try { this.#removeIssued(gatePath); } catch {}
      throw error;
    }
    return Object.freeze({ renewed: true });
  }

  revokeMcpServer(input = {}) {
    if (!/^[a-f0-9]{64}$/u.test(input.reservationId || "")) {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP reservation is invalid");
    }
    const gatePath = path.join(this.gateRoot, `mcp-${input.reservationId}.gate`);
    const revoked = this.issued.has(gatePath);
    this.#removeIssued(gatePath);
    return Object.freeze({ revoked });
  }

  consume(input = {}) {
    if (!this.opened) {
      throw gateError("RUNTIME_MCP_GATE_CLOSED", "Runtime MCP gate issuer is closed");
    }
    let runtimeProfileId;
    try { runtimeProfileId = assertRuntimeProfileId(input.runtimeProfileId); } catch {
      throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP gate is invalid");
    }
    if (!validRuntimeAccountId(input.runtimeAccountId)) {
      throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP gate is invalid");
    }
    const runtimeAccountId = input.runtimeAccountId;
    if (typeof input.gatePath !== "string" || !path.isAbsolute(input.gatePath)
      || path.dirname(path.resolve(input.gatePath)) !== this.gateRoot
      || !GATE_FILE_PATTERN.test(path.basename(input.gatePath))
      || !/^[a-f0-9]{64}$/u.test(input.nonce || "")
      || !Number.isSafeInteger(input.parentPid) || input.parentPid <= 1) {
      throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP gate is invalid");
    }
    const record = this.issued.get(input.gatePath);
    const harnessChild = record?.ancestorExecutable !== null && record?.ancestorExecutable !== undefined;
    if (!record || record.consumed || record.bound !== true || record.runtimeProfileId !== runtimeProfileId
      || record.runtimeAccountId !== runtimeAccountId
      || !secureEqual(record.nonce, input.nonce)
      || record.expiresAt < this.now()) {
      throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP gate is invalid");
    }
    if (harnessChild) {
      // The relay reports its direct parent. It must be the pinned harness
      // executable, running directly under the still-live bound runtime process.
      const link = this.getProcessLink(input.parentPid);
      if (link?.ppid !== record.ancestorPid
        || path.resolve(link?.executable || "") !== path.resolve(record.parentExecutable)
        || this.getProcessIdentity(record.ancestorPid) !== record.ancestorIdentity) {
        throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP gate is invalid");
      }
    } else if (record.parentPid !== input.parentPid
      || this.getProcessIdentity(record.parentPid) !== record.parentIdentity) {
      throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP gate is invalid");
    }
    const flags = this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0);
    let fd;
    try {
      fd = this.fs.openSync(input.gatePath, flags);
      const stat = this.fs.fstatSync(fd);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > 4096
        || stat.dev !== record.dev || stat.ino !== record.ino
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP gate is invalid");
      }
      const gate = JSON.parse(this.fs.readFileSync(fd, "utf8"));
      const expectedKeys = harnessChild
        ? "ancestorExecutable,ancestorPid,expiresAt,nonce,parentExecutable,parentPid,runtimeAccountId,runtimeProfileId,schemaVersion,servicePaths"
        : "expiresAt,nonce,parentExecutable,parentPid,runtimeAccountId,runtimeProfileId,schemaVersion,servicePaths";
      if (!gate || Object.keys(gate).sort().join(",") !== expectedKeys
        || gate.schemaVersion !== (harnessChild ? 3 : 2) || gate.parentPid !== record.parentPid
        || (harnessChild && (gate.ancestorPid !== record.ancestorPid
          || gate.ancestorExecutable !== record.ancestorExecutable))
        || gate.runtimeProfileId !== record.runtimeProfileId
        || gate.runtimeAccountId !== record.runtimeAccountId
        || gate.parentExecutable !== record.parentExecutable
        || JSON.stringify(gate.servicePaths) !== JSON.stringify(this.servicePaths)
        || gate.expiresAt !== record.expiresAt || !secureEqual(gate.nonce, record.nonce)) {
        throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP gate is invalid");
      }
      const current = this.fs.lstatSync(input.gatePath);
      if (current.dev !== stat.dev || current.ino !== stat.ino) {
        throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP gate is invalid");
      }
    } catch (error) {
      if (error?.code === "RUNTIME_MCP_GATE_INVALID") throw error;
      throw gateError("RUNTIME_MCP_GATE_INVALID", "Runtime MCP gate is invalid");
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
    }
    this.#removeIssued(input.gatePath);
    if (harnessChild) {
      // Retain only a bounded in-memory consumption receipt for the owning
      // host's first prompt. No gate file or reusable authority remains.
      record.consumed = true;
      record.dev = null;
      record.ino = null;
      record.timer = this.#scheduleExpiry(input.gatePath, Math.max(1, record.renewUntil - this.now()));
      this.issued.set(input.gatePath, record);
    }
    return Object.freeze({ consumed: true,
      ...(record.executionRunId ? { executionRunId: record.executionRunId } : {}) });
  }

  close() {
    for (const target of [...this.issued.keys()]) this.#removeIssued(target);
    this.opened = false;
  }

  #removeIssued(target) {
    const record = this.issued.get(target);
    if (!record) return;
    this.issued.delete(target);
    this.clearTimer(record.timer);
    if (record.bound !== true) {
      let fd;
      try {
        const flags = this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0);
        fd = this.fs.openSync(target, flags);
        const stat = this.fs.fstatSync(fd);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
          || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > 4096
          || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return;
        const gate = JSON.parse(this.fs.readFileSync(fd, "utf8"));
        if (gate?.nonce !== record.nonce) return;
        const current = this.fs.lstatSync(target);
        if (current.dev === stat.dev && current.ino === stat.ino) this.fs.unlinkSync(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      } finally {
        if (fd !== undefined) this.fs.closeSync(fd);
      }
      return;
    }
    this.#unlinkBound(target, record);
  }

  #unlinkBound(target, record) {
    if (record.dev === null) return;
    try {
      const stat = this.fs.lstatSync(target);
      if (stat.dev === record.dev && stat.ino === record.ino && stat.isFile()
        && !stat.isSymbolicLink() && stat.nlink === 1) this.fs.unlinkSync(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  #scheduleExpiry(target, delayMs) {
    const timer = this.setTimer(() => {
      if (this.issued.get(target)?.timer !== timer) return;
      try {
        this.#expire(target);
      } catch {
        // #removeIssued and a lapse both revoke the in-memory ticket before
        // touching the file. A cleanup failure is therefore fail-closed, but must
        // not escape a timer callback and terminate the Service process.
        try { this.onDiagnostic?.({ code: "RUNTIME_MCP_GATE_CLEANUP_FAILED" }); } catch {}
      }
    }, delayMs);
    timer?.unref?.();
    return timer;
  }

  #expire(target) {
    const record = this.issued.get(target);
    if (!record) return;
    if (record.consumed || record.bound !== true || record.renewUntil === null || this.now() >= record.renewUntil) {
      this.#removeIssued(target);
      return;
    }
    // Lapse: the file goes away, the reservation waits for its first prompt.
    try {
      this.#unlinkBound(target, record);
    } catch (error) {
      this.issued.delete(target);
      throw error;
    }
    record.dev = null;
    record.ino = null;
    record.timer = this.#scheduleExpiry(target, record.renewUntil - this.now());
  }

  #publish(target, record, boundPid, expiresAt) {
    const gate = `${JSON.stringify(record.ancestorExecutable !== null ? {
      schemaVersion: 3,
      nonce: record.nonce,
      parentPid: null,
      parentExecutable: record.parentExecutable,
      ancestorPid: boundPid,
      ancestorExecutable: record.ancestorExecutable,
      runtimeProfileId: record.runtimeProfileId,
      runtimeAccountId: record.runtimeAccountId,
      expiresAt,
      servicePaths: this.servicePaths,
    } : {
      schemaVersion: 2,
      nonce: record.nonce,
      parentPid: boundPid,
      parentExecutable: record.parentExecutable,
      runtimeProfileId: record.runtimeProfileId,
      runtimeAccountId: record.runtimeAccountId,
      expiresAt,
      servicePaths: this.servicePaths,
    })}\n`;
    if (Buffer.byteLength(gate, "utf8") > 4096) {
      throw gateError("RUNTIME_MCP_GATE_INPUT_INVALID", "Runtime MCP gate is too large");
    }
    atomicWritePrivateFile(target, gate, { trustedRoot: this.paths.trustedRoot, fs: this.fs });
    return this.fs.lstatSync(target);
  }
}

module.exports = { RuntimeMcpGateIssuer };
