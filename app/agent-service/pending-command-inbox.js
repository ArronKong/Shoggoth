"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  preparePrivateParent,
  readPrivateFile,
  recoverInterruptedPrivateFile,
  statIfExists,
} = require("./private-file");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { serviceError } = require("./security");
const { validAttachments, attachmentFields } = require("./inspiration-media");

const PENDING_COMMAND_INBOX_VERSION = 1;
const MAX_PENDING_COMMAND_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_COMMANDS = 4096;
const MAX_COMMAND_TOMBSTONES = 4096;
const MAX_PROMPT_BYTES = 1024 * 1024;
const IDEMPOTENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OPERATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_DECRYPT_STARTUP_BUDGET_MS = 100;
const COMMAND_FIELDS = Object.freeze([
  "operationId", "runId", "sessionKey", "prompt", "createdAt", "state",
]);
const TOMBSTONE_FIELDS = Object.freeze([
  "operationId", "fingerprint", "state", "createdAt", "finishedAt",
]);
const COMMAND_STATES = new Set(["pending", "dispatching", "completed", "canceled"]);
const LEGAL_TRANSITIONS = Object.freeze({
  pending: new Set(["dispatching", "canceled"]),
  dispatching: new Set(["pending", "completed", "canceled"]),
  completed: new Set(),
  canceled: new Set(),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function inboxError(code, message) {
  return serviceError(code, message);
}

function lockedError() {
  return inboxError("pending_commands_locked", "pending_commands_locked");
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validOpaqueId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function fingerprintCommand(input) {
  return crypto.createHash("sha256").update(JSON.stringify([
    input.operationId,
    input.runId,
    input.sessionKey,
    input.prompt,
    input.createdAt,
    ...(input.attachments?.length ? [input.attachments] : []),
  ])).digest("hex");
}

function normalizeCommand(input, corrupt = false) {
  const code = corrupt ? "PENDING_COMMAND_INBOX_CORRUPT" : "PENDING_COMMAND_INVALID";
  if (!exactObject(input, attachmentFields(input, COMMAND_FIELDS))
    || !validOpaqueId(input.operationId) || !validOpaqueId(input.runId)
    || !UUID_PATTERN.test(input.sessionKey)
    || typeof input.prompt !== "string" || (!input.prompt.length && !input.attachments?.length) || input.prompt.includes("\0")
    || (input.attachments !== undefined && !validAttachments(input.attachments))
    || Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !["pending", "dispatching"].includes(input.state)) {
    throw inboxError(code, "PendingCommand 数据无效");
  }
  return Object.fromEntries(attachmentFields(input, COMMAND_FIELDS).map((field) => [field, clone(input[field])]));
}

function normalizeTombstone(input, corrupt = false) {
  const code = corrupt ? "PENDING_COMMAND_INBOX_CORRUPT" : "PENDING_COMMAND_INVALID";
  if (!exactObject(input, TOMBSTONE_FIELDS) || !validOpaqueId(input.operationId)
    || typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(input.fingerprint)
    || !["completed", "canceled"].includes(input.state)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !Number.isSafeInteger(input.finishedAt) || input.finishedAt < input.createdAt) {
    throw inboxError(code, "PendingCommand tombstone 无效");
  }
  return Object.fromEntries(TOMBSTONE_FIELDS.map((field) => [field, input[field]]));
}

function validatePlaintext(value) {
  if (!exactObject(value, ["idempotencyFloorMs", "activeCommands", "tombstones"])
    || !Number.isSafeInteger(value.idempotencyFloorMs) || value.idempotencyFloorMs < 0
    || !value.activeCommands || typeof value.activeCommands !== "object"
    || Array.isArray(value.activeCommands)
    || Object.getPrototypeOf(value.activeCommands) !== Object.prototype
    || Object.keys(value.activeCommands).length > MAX_ACTIVE_COMMANDS
    || !value.tombstones || typeof value.tombstones !== "object"
    || Array.isArray(value.tombstones)
    || Object.getPrototypeOf(value.tombstones) !== Object.prototype
    || Object.keys(value.tombstones).length > MAX_COMMAND_TOMBSTONES) {
    throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand inbox 损坏");
  }
  const activeCommands = {};
  for (const [operationId, raw] of Object.entries(value.activeCommands)) {
    const command = normalizeCommand(raw, true);
    if (command.operationId !== operationId) {
      throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand inbox 损坏");
    }
    activeCommands[operationId] = command;
  }
  const tombstones = {};
  for (const [operationId, raw] of Object.entries(value.tombstones)) {
    const tombstone = normalizeTombstone(raw, true);
    if (tombstone.operationId !== operationId
      || Object.prototype.hasOwnProperty.call(activeCommands, operationId)) {
      throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand inbox 损坏");
    }
    tombstones[operationId] = tombstone;
  }
  return { idempotencyFloorMs: value.idempotencyFloorMs, activeCommands, tombstones };
}

function decodeCiphertext(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand 密文容器损坏");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand 密文容器损坏");
  }
  return bytes;
}

function validateEnvelope(value) {
  if (!exactObject(value, ["version", "revision", "ciphertext"])
    || value.version !== PENDING_COMMAND_INBOX_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand 密文容器损坏");
  }
  decodeCiphertext(value.ciphertext);
  return { version: value.version, revision: value.revision, ciphertext: value.ciphertext };
}

class PendingCommandInbox {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot) {
      throw inboxError("PENDING_COMMAND_PATHS_REQUIRED", "PendingCommandInbox 需要 Service paths");
    }
    this.paths = options.paths;
    this.filePath = path.join(this.paths.stateDir, "pending-commands.json");
    this.fs = options.fs || fs;
    this.atomicWrite = options.atomicWrite || atomicWritePrivateFile;
    this.cryptoBroker = options.cryptoBroker || {
      async encrypt(payload) {
        const safeStorage = options.safeStorage;
        if (!safeStorage || safeStorage.isEncryptionAvailable?.() !== true) throw lockedError();
        const plaintext = payload.toString("utf8");
        const encrypted = safeStorage.encryptString(plaintext);
        if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw lockedError();
        return Buffer.from(encrypted);
      },
      async decrypt(payload) {
        const safeStorage = options.safeStorage;
        if (!safeStorage || safeStorage.isEncryptionAvailable?.() !== true) throw lockedError();
        const plaintext = safeStorage.decryptString(payload);
        if (typeof plaintext !== "string" || plaintext.length === 0) throw lockedError();
        return Buffer.from(plaintext, "utf8");
      },
    };
    this.acquireWriterLease = options.acquireWriterLease || acquirePrivateWriterLease;
    this.writerLease = null;
    this.cleanupPending = false;
    this.now = options.now || Date.now;
    this.maxActiveCommands = options.maxActiveCommands ?? MAX_ACTIVE_COMMANDS;
    this.maxTombstones = options.maxTombstones ?? MAX_COMMAND_TOMBSTONES;
    this.decryptStartupBudgetMs = options.decryptStartupBudgetMs
      ?? DEFAULT_DECRYPT_STARTUP_BUDGET_MS;
    this.onUnlocked = typeof options.onUnlocked === "function" ? options.onUnlocked : null;
    if (!Number.isSafeInteger(this.maxActiveCommands) || this.maxActiveCommands <= 0
      || this.maxActiveCommands > MAX_ACTIVE_COMMANDS
      || !Number.isSafeInteger(this.maxTombstones) || this.maxTombstones <= 0
      || this.maxTombstones > MAX_COMMAND_TOMBSTONES
      || !Number.isSafeInteger(this.decryptStartupBudgetMs)
      || this.decryptStartupBudgetMs < 10 || this.decryptStartupBudgetMs > 1_000) {
      throw inboxError("PENDING_COMMAND_CAPACITY_INVALID", "PendingCommand 容量配置无效");
    }
    this.opened = false;
    this.closing = false;
    this.contentLocked = false;
    this.commitUncertain = false;
    this.revision = 0;
    this.idempotencyFloorMs = 0;
    this.activeCommands = {};
    this.tombstones = {};
    this.queue = Promise.resolve();
    this.lifecycleGeneration = 0;
  }

  async open() {
    if (this.opened) return this;
    const openGeneration = this.lifecycleGeneration + 1;
    this.lifecycleGeneration = openGeneration;
    preparePrivateParent(this.filePath, this.paths.trustedRoot, this.fs);
    const lease = this.acquireWriterLease({
      lockPath: path.join(this.paths.stateDir, "pending-commands.writer.lock"),
      trustedRoot: this.paths.trustedRoot,
      fs: this.fs,
    });
    try {
      const recovery = recoverInterruptedPrivateFile(this.filePath, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
      const stat = statIfExists(this.fs, this.filePath);
      if (stat) {
        let envelope;
        try {
          envelope = validateEnvelope(JSON.parse(readPrivateFile(this.filePath, {
            fs: this.fs,
            maxBytes: MAX_PENDING_COMMAND_FILE_BYTES,
          }).toString("utf8")));
        } catch (error) {
          if (error?.code === "PENDING_COMMAND_INBOX_CORRUPT") throw error;
          if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
          throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand 密文容器损坏");
        }
        let plaintext = null;
        let ciphertext = null;
        let decryptLocked = false;
        try {
          ciphertext = decodeCiphertext(envelope.ciphertext);
          // packaged identity 校验可能超过启动预算；decrypt 在 selector 完成前不会读取
          // payload。给在途操作独立所有权，外层才能立即清零 envelope 解码缓冲区，
          // 同时保证 late-unlock 读取到的不是已被清零的数据。
          const decryptPayload = Buffer.from(ciphertext);
          const decryptAttempt = Promise.resolve().then(
            () => this.cryptoBroker.decrypt(decryptPayload),
          ).then(
            (value) => ({ value }),
            () => ({ error: true }),
          ).finally(() => decryptPayload.fill(0));
          let startupTimer;
          const startupTimeout = new Promise((resolve) => {
            startupTimer = setTimeout(() => resolve({ timeout: true }), this.decryptStartupBudgetMs);
          });
          const outcome = await Promise.race([decryptAttempt, startupTimeout]);
          clearTimeout(startupTimer);
          if (outcome.timeout) {
            decryptLocked = true;
            // 先让 Service 以只读 locked 状态启动；若 one-shot worker 在自身硬期限内
            // 随后成功，则在仍为同一 open generation 且零写入的前提下原子解锁。
            // 真正卡死/解密失败仍由 broker hard timeout 收敛并保持 locked。
            this.#scheduleLateUnlock(decryptAttempt, openGeneration);
          } else if (outcome.error || !Buffer.isBuffer(outcome.value) || outcome.value.length === 0) {
            decryptLocked = true;
            if (Buffer.isBuffer(outcome.value)) outcome.value.fill(0);
          } else {
            plaintext = outcome.value;
          }
        } catch {
          decryptLocked = true;
        } finally {
          if (ciphertext) ciphertext.fill(0);
        }
        this.revision = envelope.revision;
        if (decryptLocked) {
          // 保留磁盘密文和 writer lease；内存不能把未知内容误当成空 Inbox。
          if (Buffer.isBuffer(plaintext)) plaintext.fill(0);
          plaintext = null;
          this.contentLocked = true;
          this.activeCommands = {};
          this.tombstones = {};
          this.idempotencyFloorMs = 0;
        } else try {
          const container = validatePlaintext(JSON.parse(plaintext.toString("utf8")));
          this.activeCommands = container.activeCommands;
          this.tombstones = container.tombstones;
          this.idempotencyFloorMs = container.idempotencyFloorMs;
          this.revision = envelope.revision;
        } catch (error) {
          if (error?.code === "PENDING_COMMAND_INBOX_CORRUPT") throw error;
          throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand 明文结构损坏");
        } finally {
          if (plaintext) plaintext.fill(0);
        }
      } else {
        this.contentLocked = false;
        this.activeCommands = {};
        this.tombstones = {};
        this.revision = 0;
        this.idempotencyFloorMs = 0;
      }
      this.commitUncertain = recovery === "uncertain";
      if (!this.commitUncertain && !this.contentLocked) {
        await this.#refreshWindow(this.#currentTime(), Boolean(stat));
      }
      this.writerLease = lease;
      this.cleanupPending = false;
      this.opened = true;
      this.closing = false;
      return this;
    } catch (openError) {
      try {
        lease.release();
      } catch (releaseError) {
        this.writerLease = lease;
        this.cleanupPending = true;
        this.opened = false;
        const cleanupError = inboxError(
          "LEASE_RELEASE_FAILED",
          "PendingCommandInbox open 失败后的 writer lease 清理失败",
        );
        cleanupError.cause = releaseError;
        throw new AggregateError(
          [openError, cleanupError],
          "PendingCommandInbox open 与 writer lease 清理均失败",
        );
      }
      this.writerLease = null;
      this.cleanupPending = false;
      throw openError;
    }
  }

  async close() {
    if (this.closing) return this.queue;
    this.closing = true;
    this.lifecycleGeneration += 1;
    await this.queue;
    const lease = this.writerLease;
    if (lease) {
      try {
        lease.release();
      } catch (error) {
        this.cleanupPending = true;
        this.closing = false;
        throw error;
      }
    }
    this.writerLease = null;
    this.cleanupPending = false;
    this.opened = false;
    this.closing = false;
    this.contentLocked = false;
    this.activeCommands = {};
    this.tombstones = {};
    this.idempotencyFloorMs = 0;
  }

  isLocked() {
    return this.opened && !this.closing && this.contentLocked;
  }

  enqueue(input) {
    this.#assertOpen();
    if (!exactObject(input, attachmentFields(input, ["operationId", "runId", "sessionKey", "prompt", "createdAt"]))) {
      throw inboxError("PENDING_COMMAND_INVALID", "PendingCommand 输入无效");
    }
    const command = normalizeCommand({ ...input, state: "pending" });
    return this.#enqueueMutation(async () => {
    const time = this.#currentTime();
    await this.#refreshWindow(time);
    if (command.createdAt > time + MAX_OPERATION_FUTURE_SKEW_MS) {
      throw inboxError("PENDING_COMMAND_TIMESTAMP_INVALID", "createdAt 超出未来时钟偏差");
    }
    const existing = this.activeCommands[command.operationId];
    if (existing) {
      const same = fingerprintCommand(existing) === fingerprintCommand(command);
      if (!same) {
        throw inboxError(
          "PENDING_COMMAND_IDEMPOTENCY_CONFLICT",
          "operationId 已对应不同 PendingCommand",
        );
      }
      return clone(existing);
    }
    const tombstone = this.tombstones[command.operationId];
    if (tombstone) {
      if (tombstone.fingerprint !== fingerprintCommand(command)) {
        throw inboxError(
          "PENDING_COMMAND_IDEMPOTENCY_CONFLICT",
          "operationId 已对应不同 PendingCommand",
        );
      }
      return clone(tombstone);
    }
    if (command.createdAt <= this.idempotencyFloorMs) {
      throw inboxError("OPERATION_EXPIRED", "operation 已超出 30 天幂等窗口");
    }
    if (Object.keys(this.activeCommands).length >= this.maxActiveCommands) {
      throw inboxError("PENDING_COMMAND_CAPACITY", "PendingCommand inbox 已满");
    }
    await this.#commit(
      { ...this.activeCommands, [command.operationId]: command },
      this.tombstones,
    );
    return clone(command);
    });
  }

  get(operationId) {
    this.#assertOpen();
    if (!validOpaqueId(operationId)) {
      throw inboxError("PENDING_COMMAND_INVALID", "operationId 无效");
    }
    return clone(this.activeCommands[operationId] || this.tombstones[operationId] || null);
  }

  list(query = {}) {
    this.#assertOpen();
    if (!exactObject(query, Object.prototype.hasOwnProperty.call(query, "state") ? ["state"] : [])
      || (query.state !== undefined && !COMMAND_STATES.has(query.state))) {
      throw inboxError("PENDING_COMMAND_INVALID", "PendingCommand 查询无效");
    }
    return [...Object.values(this.activeCommands), ...Object.values(this.tombstones)]
      .filter((command) => query.state === undefined || command.state === query.state)
      .map(clone);
  }

  transition(operationId, nextState) {
    this.#assertOpen();
    if (!validOpaqueId(operationId) || !COMMAND_STATES.has(nextState)) {
      throw inboxError("PENDING_COMMAND_INVALID", "PendingCommand 状态迁移输入无效");
    }
    return this.#enqueueMutation(async () => {
    const time = this.#currentTime();
    await this.#refreshWindow(time);
    const command = this.activeCommands[operationId];
    if (!command) {
      const tombstone = this.tombstones[operationId];
      if (!tombstone) throw inboxError("PENDING_COMMAND_NOT_FOUND", "PendingCommand 不存在");
      if (tombstone.state === nextState) return clone(tombstone);
      throw inboxError("PENDING_COMMAND_TRANSITION_INVALID", "PendingCommand 状态迁移非法");
    }
    if (command.state === nextState) return clone(command);
    if (!LEGAL_TRANSITIONS[command.state].has(nextState)) {
      throw inboxError("PENDING_COMMAND_TRANSITION_INVALID", "PendingCommand 状态迁移非法");
    }
    if (nextState === "completed" || nextState === "canceled") {
      const activeCommands = { ...this.activeCommands };
      delete activeCommands[operationId];
      const tombstones = { ...this.tombstones };
      if (Object.keys(tombstones).length >= this.maxTombstones) {
        throw inboxError("PENDING_COMMAND_CAPACITY", "PendingCommand 幂等窗口容量已满");
      }
      const terminal = normalizeTombstone({
        operationId,
        fingerprint: fingerprintCommand(command),
        state: nextState,
        createdAt: command.createdAt,
        finishedAt: Math.max(time, command.createdAt),
      });
      tombstones[operationId] = terminal;
      await this.#commit(activeCommands, tombstones);
      return clone(terminal);
    }
    const updated = { ...command, state: nextState };
    await this.#commit(
      { ...this.activeCommands, [operationId]: updated },
      this.tombstones,
    );
    return clone(updated);
    });
  }

  async #commit(activeCommands, tombstones, idempotencyFloorMs = this.idempotencyFloorMs) {
    const validated = validatePlaintext({ idempotencyFloorMs, activeCommands, tombstones });
    let plaintext = Buffer.from(JSON.stringify(validated), "utf8");
    let encrypted = null;
    try {
      encrypted = await this.cryptoBroker.encrypt(plaintext);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error("invalid ciphertext");
    } catch {
      throw lockedError();
    } finally {
      plaintext.fill(0);
    }
    const envelope = {
      version: PENDING_COMMAND_INBOX_VERSION,
      revision: this.revision + 1,
      ciphertext: encrypted.toString("base64"),
    };
    encrypted.fill(0);
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_PENDING_COMMAND_FILE_BYTES) {
      throw inboxError("PENDING_COMMAND_CAPACITY", "PendingCommand inbox 已满");
    }
    try {
      this.atomicWrite(this.filePath, serialized, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (error?.committed !== true && error?.committedUncertain === true) {
        this.commitUncertain = true;
        this.activeCommands = {};
        this.tombstones = {};
        this.idempotencyFloorMs = 0;
        const uncertain = inboxError(
          "PENDING_COMMAND_COMMIT_UNCERTAIN",
          "PendingCommand 提交状态不确定，必须重新打开",
        );
        uncertain.committedUncertain = true;
        throw uncertain;
      }
      if (error?.committed === true) {
        // 目标文件已提交；仅 cleanup 失败不能把已安装 candidate 当成未知提交。
      } else if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      else throw inboxError("PENDING_COMMAND_WRITE_FAILED", "PendingCommand 写入失败");
    }
    this.activeCommands = validated.activeCommands;
    this.tombstones = validated.tombstones;
    this.idempotencyFloorMs = validated.idempotencyFloorMs;
    this.revision = envelope.revision;
  }

  #currentTime() {
    const time = this.now();
    if (!Number.isSafeInteger(time) || time < 0
      || time > Number.MAX_SAFE_INTEGER - MAX_OPERATION_FUTURE_SKEW_MS) {
      throw inboxError("PENDING_COMMAND_TIMESTAMP_INVALID", "本地时钟无效");
    }
    return time;
  }

  async #refreshWindow(time, persist = true) {
    const idempotencyFloorMs = Math.max(
      this.idempotencyFloorMs,
      Math.max(0, time - IDEMPOTENCY_WINDOW_MS),
    );
    const tombstones = Object.fromEntries(Object.entries(this.tombstones)
      .filter(([, tombstone]) => tombstone.finishedAt >= idempotencyFloorMs));
    const changed = idempotencyFloorMs !== this.idempotencyFloorMs
      || Object.keys(tombstones).length !== Object.keys(this.tombstones).length;
    if (!changed) return;
    if (persist) await this.#commit(this.activeCommands, tombstones, idempotencyFloorMs);
    else {
      this.idempotencyFloorMs = idempotencyFloorMs;
      this.tombstones = tombstones;
    }
  }

  #assertOpen() {
    if (this.opened && !this.closing && this.contentLocked) throw lockedError();
    if (this.commitUncertain) {
      throw inboxError(
        "PENDING_COMMAND_COMMIT_UNCERTAIN",
        "PendingCommand 提交状态不确定，必须重新打开",
      );
    }
    if (!this.opened || this.closing) {
      throw inboxError("PENDING_COMMAND_INBOX_CLOSED", "PendingCommandInbox 未打开");
    }
  }

  #enqueueMutation(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  #scheduleLateUnlock(decryptAttempt, openGeneration) {
    void Promise.resolve(decryptAttempt).then(async (outcome) => {
      let plaintext = Buffer.isBuffer(outcome?.value) ? outcome.value : null;
      let container = null;
      try {
        if (outcome?.error || !plaintext || plaintext.length === 0) return;
        container = validatePlaintext(JSON.parse(plaintext.toString("utf8")));
      } catch {
        return;
      } finally {
        if (plaintext) plaintext.fill(0);
        plaintext = null;
      }

      const applied = this.queue.then(() => {
        if (this.lifecycleGeneration !== openGeneration || !this.opened || this.closing
          || !this.contentLocked || this.commitUncertain) return false;
        this.activeCommands = container.activeCommands;
        this.tombstones = container.tombstones;
        this.idempotencyFloorMs = container.idempotencyFloorMs;
        this.contentLocked = false;
        return true;
      });
      this.queue = applied.catch(() => {});
      if (await applied && this.onUnlocked) await this.onUnlocked();
    }).catch(() => {
      // late decrypt/callback failure must remain an isolated locked capability.
    });
  }
}

module.exports = {
  COMMAND_STATES,
  LEGAL_TRANSITIONS,
  MAX_ACTIVE_COMMANDS,
  MAX_COMMAND_TOMBSTONES,
  MAX_PENDING_COMMAND_FILE_BYTES,
  MAX_PROMPT_BYTES,
  IDEMPOTENCY_WINDOW_MS,
  MAX_OPERATION_FUTURE_SKEW_MS,
  DEFAULT_DECRYPT_STARTUP_BUDGET_MS,
  PENDING_COMMAND_INBOX_VERSION,
  PendingCommandInbox,
  fingerprintCommand,
  normalizeCommand,
  normalizeTombstone,
  validateEnvelope,
  validatePlaintext,
};
