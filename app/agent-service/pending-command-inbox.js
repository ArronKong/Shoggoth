"use strict";

const crypto = require("node:crypto");
const { setImmediate: yieldToService } = require("node:timers/promises");
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
const { PendingCommandWriter, serializeEnvelope } = require("./pending-command-write-worker");
const { storageIssueCode } = require("../system-issue");
const { serviceError } = require("./security");
const { validAttachments, attachmentFields } = require("./inspiration-media");
const { normalizeLegacyPluginSelection: normalizePluginSelection,
  validLegacyPluginSelection: validPluginSelection } = require("../core/legacy-plugin-selection");
// Read-only parser for historical encrypted inbox fingerprints. It grants no authority.
function normalizeLegacyConnectorSelection(value) {
  if(value===undefined)return null;
  if(!Array.isArray(value)||value.length>64||value.some(item=>!validOpaqueId(item))||new Set(value).size!==value.length)
    throw serviceError("CONNECTOR_SELECTION_INVALID","Historical connector selection is invalid");
  return Object.freeze([...value]);
}

const PENDING_COMMAND_INBOX_VERSION = 1;
const RECOVERABLE_PENDING_COMMAND_INBOX_VERSION = 2;
const MAX_PENDING_COMMAND_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_COMMANDS = 4096;
const MAX_COMMAND_TOMBSTONES = 4096;
const MAX_PROMPT_BYTES = 1024 * 1024;
const IDEMPOTENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OPERATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_DECRYPT_STARTUP_BUDGET_MS = 100;
const GROUP_COMMIT_DELAY_MS = 4;
const GROUP_COMMIT_LIMIT = 32;
const GROUP_COMMIT_BYTES = 256 * 1024;
const ASYNC_SERIALIZATION_THRESHOLD = 4 * 1024 * 1024;
const ASYNC_SERIALIZATION_BATCH_BYTES = 512 * 1024;
const GROUP_COMMIT_QUEUE_LIMIT = MAX_ACTIVE_COMMANDS;
const GROUP_COMMIT_QUEUE_BYTES = 16 * GROUP_COMMIT_BYTES;
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
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const RECEIPT_SCOPE_FIELDS = ["profileId", "sessionId"];

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

function ownCommand(table, operationId) {
  return Object.hasOwn(table, operationId) ? table[operationId] : null;
}

function fingerprintCommand(input) {
  return crypto.createHash("sha256").update(JSON.stringify([
    input.operationId,
    input.runId,
    input.sessionKey,
    input.prompt,
    input.createdAt,
    ...(input.attachments?.length ? [input.attachments] : []),
    ...(input.pluginSelection?.length ? [normalizePluginSelection(input.pluginSelection)] : []),
    ...(input.connectorSelection !== undefined ? ["connector-selection-v1", normalizeLegacyConnectorSelection(input.connectorSelection)] : []),
  ])).digest("hex");
}

// A domain-separated fingerprint records a never-admitted operation without a
// prompt, synthetic Run, or a new on-disk shape. Older readers still fence it as
// a canceled tombstone and cannot enqueue it again.
function rejectionFingerprint(operationId, sessionKey, createdAt) {
  return crypto.createHash("sha256").update(JSON.stringify([
    "shoggoth:never-admitted:v1", operationId, sessionKey, createdAt,
  ])).digest("hex");
}

function commandFields(input, base) {
  const fields = [...attachmentFields(input, base)];
  if (input?.pluginSelection !== undefined) fields.push("pluginSelection");
  if (input?.connectorSelection !== undefined) fields.push("connectorSelection");
  if (Object.hasOwn(input || {}, "acceptance")) fields.push("acceptance");
  if (Object.hasOwn(input || {}, "cancelRequested")) fields.push("cancelRequested");
  return fields;
}

function normalizeAcceptance(value, code) {
  if (!exactObject(value, [...RECEIPT_SCOPE_FIELDS, "workspace", "selectionFingerprint"])
    || !validOpaqueId(value.profileId) || typeof value.sessionId !== "string" || !UUID_PATTERN.test(value.sessionId)
    || !(value.workspace === null || (typeof value.workspace === "string" && value.workspace.trim().length > 0
      && value.workspace.length <= 4096 && value.workspace.isWellFormed() && !value.workspace.includes("\0")))
    || typeof value.selectionFingerprint !== "string" || !FINGERPRINT_PATTERN.test(value.selectionFingerprint)) {
    throw inboxError(code, "PendingCommand 接收归属无效");
  }
  return { profileId: value.profileId, sessionId: value.sessionId,
    workspace: value.workspace, selectionFingerprint: value.selectionFingerprint };
}

function normalizeCommand(input, corrupt = false) {
  if (!corrupt && input?.pluginSelection !== undefined) throw inboxError("PLUGIN_PLATFORM_RETIRED", "旧插件选择已停用，请重新选择连接器账号");
  if (!corrupt && input?.connectorSelection !== undefined) throw inboxError("OPEN_CONNECTOR_RETIRED","OpenConnector account selection is retired");
  if (input?.connectorSelection !== undefined) normalizeLegacyConnectorSelection(input.connectorSelection);
  const code = corrupt ? "PENDING_COMMAND_INBOX_CORRUPT" : "PENDING_COMMAND_INVALID";
  if (!exactObject(input, commandFields(input, COMMAND_FIELDS))
    || !validOpaqueId(input.operationId) || !validOpaqueId(input.runId)
    || !UUID_PATTERN.test(input.sessionKey)
    || typeof input.prompt !== "string" || (!input.prompt.length && !input.attachments?.length) || input.prompt.includes("\0")
    || (input.attachments !== undefined && !validAttachments(input.attachments))
    || (input.pluginSelection !== undefined && !validPluginSelection(input.pluginSelection))
    || (input.pluginSelection !== undefined && input.connectorSelection !== undefined)
    || Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !["pending", "dispatching"].includes(input.state)
    || (Object.hasOwn(input, "cancelRequested")
      && (!input.acceptance || input.state !== "pending" || input.cancelRequested !== true))) {
    throw inboxError(code, "PendingCommand 数据无效");
  }
  return Object.fromEntries(commandFields(input, COMMAND_FIELDS).map((field) => [field,
    field === "acceptance" ? normalizeAcceptance(input[field], code)
      : field === "pluginSelection" ? normalizePluginSelection(input[field])
      : field === "connectorSelection" ? normalizeLegacyConnectorSelection(input[field]) : clone(input[field])]));
}

function normalizeTombstone(input, corrupt = false) {
  const code = corrupt ? "PENDING_COMMAND_INBOX_CORRUPT" : "PENDING_COMMAND_INVALID";
  const hasReceipt = Object.hasOwn(input || {}, "receipt");
  const fields = hasReceipt ? [...TOMBSTONE_FIELDS, "receipt"] : TOMBSTONE_FIELDS;
  const receipt = input?.receipt;
  if (!exactObject(input, fields) || !validOpaqueId(input.operationId)
    || typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(input.fingerprint)
    || !["completed", "canceled"].includes(input.state)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !Number.isSafeInteger(input.finishedAt) || input.finishedAt < input.createdAt
    || (hasReceipt && (!exactObject(receipt, [...RECEIPT_SCOPE_FIELDS, "runId", "sessionKey"])
      || !validOpaqueId(receipt.profileId) || !validOpaqueId(receipt.runId)
      || typeof receipt.sessionId !== "string" || !UUID_PATTERN.test(receipt.sessionId)
      || typeof receipt.sessionKey !== "string" || !UUID_PATTERN.test(receipt.sessionKey)))) {
    throw inboxError(code, "PendingCommand tombstone 无效");
  }
  return Object.fromEntries(fields.map((field) => [field, clone(input[field])]));
}

function validatePlaintext(value, version = PENDING_COMMAND_INBOX_VERSION) {
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
    if (command.operationId !== operationId
      || (command.acceptance && version !== RECOVERABLE_PENDING_COMMAND_INBOX_VERSION)) {
      throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand inbox 损坏");
    }
    activeCommands[operationId] = command;
  }
  const tombstones = {};
  for (const [operationId, raw] of Object.entries(value.tombstones)) {
    const tombstone = normalizeTombstone(raw, true);
    if (tombstone.operationId !== operationId
      || (tombstone.receipt && version !== RECOVERABLE_PENDING_COMMAND_INBOX_VERSION)
      || Object.prototype.hasOwnProperty.call(activeCommands, operationId)) {
      throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand inbox 损坏");
    }
    tombstones[operationId] = tombstone;
  }
  return { idempotencyFloorMs: value.idempotencyFloorMs, activeCommands, tombstones };
}

function decodeCiphertext(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
    || value.length > MAX_PENDING_COMMAND_FILE_BYTES) {
    throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand 密文容器损坏");
  }
  // Buffer accepts whitespace, URL-safe characters and noncanonical padding.
  // The round trip rejects those forms without a per-quartet regex stack.
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    bytes.fill(0);
    throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand 密文容器损坏");
  }
  return bytes;
}

function envelopeBytes(version, revision, encryptedBytes) {
  return Buffer.byteLength(serializeEnvelope(version, revision, Buffer.alloc(0)))
    + Math.ceil(encryptedBytes / 3) * 4;
}

async function encodePlaintext(value) {
  const parts = [Buffer.from(`{"idempotencyFloorMs":${value.idempotencyFloorMs},"activeCommands":{`)];
  let batchBytes = 0;
  async function appendRows(rows) {
    let prefix = "";
    for (const [id, row] of Object.entries(rows)) {
      const part = Buffer.from(`${prefix}${JSON.stringify(id)}:${JSON.stringify(row)}`);
      parts.push(part);
      prefix = ",";
      batchBytes += part.length;
      if (batchBytes >= ASYNC_SERIALIZATION_BATCH_BYTES) {
        batchBytes = 0;
        await yieldToService();
      }
    }
  }
  try {
    await appendRows(value.activeCommands);
    parts.push(Buffer.from('},"tombstones":{'));
    await appendRows(value.tombstones);
    parts.push(Buffer.from("}}"));
    return Buffer.concat(parts);
  } finally {
    for (const part of parts) part.fill(0);
  }
}

function envelopeFields(value) {
  if (!exactObject(value, ["version", "revision", "ciphertext"])
    || ![PENDING_COMMAND_INBOX_VERSION, RECOVERABLE_PENDING_COMMAND_INBOX_VERSION].includes(value.version)
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand 密文容器损坏");
  }
  return { version: value.version, revision: value.revision, ciphertext: value.ciphertext };
}

function validateEnvelope(value) {
  const envelope = envelopeFields(value);
  decodeCiphertext(envelope.ciphertext).fill(0);
  return envelope;
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
    this.fileWriter = options.workerWrites && !options.fs && !options.atomicWrite
      ? new PendingCommandWriter(this.filePath, this.paths.trustedRoot) : null;
    this.committedPlaintextBytes = null;
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
    this.version = PENDING_COMMAND_INBOX_VERSION;
    this.idempotencyFloorMs = 0;
    this.activeCommands = {};
    this.tombstones = {};
    this.queue = Promise.resolve();
    this.lifecycleGeneration = 0;
  }

  async open() {
    if (this.opened) return this;
    this.openedAt = this.#currentTime();
    this.loadedFromDisk = false;
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
        let ciphertext;
        try {
          envelope = envelopeFields(JSON.parse(readPrivateFile(this.filePath, {
            fs: this.fs,
            maxBytes: MAX_PENDING_COMMAND_FILE_BYTES,
          }).toString("utf8")));
          ciphertext = decodeCiphertext(envelope.ciphertext);
        } catch (error) {
          if (error?.code === "PENDING_COMMAND_INBOX_CORRUPT") throw error;
          if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
          throw inboxError("PENDING_COMMAND_INBOX_CORRUPT", "PendingCommand 密文容器损坏");
        }
        let plaintext = null;
        let decryptLocked = false;
        try {
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
            this.#scheduleLateUnlock(decryptAttempt, openGeneration, envelope.version);
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
        this.version = envelope.version;
        if (decryptLocked) {
          // 保留磁盘密文和 writer lease；内存不能把未知内容误当成空 Inbox。
          if (Buffer.isBuffer(plaintext)) plaintext.fill(0);
          plaintext = null;
          this.contentLocked = true;
          this.activeCommands = {};
          this.tombstones = {};
          this.idempotencyFloorMs = 0;
        } else try {
          const container = validatePlaintext(JSON.parse(plaintext.toString("utf8")), envelope.version);
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
        this.version = PENDING_COMMAND_INBOX_VERSION;
        this.committedPlaintextBytes = null;
        this.idempotencyFloorMs = 0;
      }
      this.commitUncertain = recovery === "uncertain";
      if (!this.commitUncertain && !this.contentLocked) {
        await this.#refreshWindow(this.#currentTime(), Boolean(stat));
      }
      this.loadedFromDisk = Boolean(stat);
      this.writerLease = lease;
      this.cleanupPending = false;
      this.opened = true;
      this.closing = false;
      return this;
    } catch (openError) {
      await this.fileWriter?.close();
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
    this.#sealGroup();
    this.closing = true;
    this.lifecycleGeneration += 1;
    await this.queue;
    await this.fileWriter?.close();
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
    this.committedPlaintextBytes = null;
    this.idempotencyFloorMs = 0;
  }

  isLocked() {
    return this.opened && !this.closing && this.contentLocked;
  }

  enqueue(input, { groupCommit = false } = {}) {
    this.#assertOpen();
    if (Object.hasOwn(input || {}, "cancelRequested")
      || !exactObject(input, commandFields(input, ["operationId", "runId", "sessionKey", "prompt", "createdAt"]))) {
      throw inboxError("PENDING_COMMAND_INVALID", "PendingCommand 输入无效");
    }
    const command = normalizeCommand({ ...input, state: "pending" });
    const bytes = groupCommit && command.acceptance ? Buffer.byteLength(JSON.stringify(command)) : 0;
    if (bytes) return this.#enqueueGroup(command, bytes);
    return this.#enqueueMutation(() => this.#commitOne(command));
  }

  async #commitOne(command, observedTime) {
    this.#assertOpen(true);
    const time = observedTime ?? this.#currentTime();
    const window = this.#nextWindow(time);
    let existing;
    try {
      existing = this.#validateEnqueue(command, time, window, this.activeCommands, Object.keys(this.activeCommands).length);
    } catch (error) {
      // Even a rejected/replayed request must retain a newly observed
      // floor across clock rollback and reopen, as in the original path.
      await this.#persistWindow(window);
      throw error;
    }
    if (existing) {
      await this.#persistWindow(window);
      return clone(existing);
    }
    try {
      await this.#commit({ ...this.activeCommands, [command.operationId]: command }, window.tombstones, window.floor);
    } catch (error) {
      // A definite failure must still be covered by an observed floor.
      // An uncertain write is fenced and can only be classified on reopen.
      if (!this.commitUncertain) await this.#persistWindow(window);
      throw error;
    }
    return clone(command);
  }

  #validateEnqueue(command, time, window, activeCommands, activeCount) {
    if (command.createdAt > time + MAX_OPERATION_FUTURE_SKEW_MS) {
      throw inboxError("PENDING_COMMAND_TIMESTAMP_INVALID", "createdAt 超出未来时钟偏差");
    }
    const existing = ownCommand(activeCommands, command.operationId) || ownCommand(window.tombstones, command.operationId);
    if (existing) {
      const same = "prompt" in existing
        ? fingerprintCommand(existing) === fingerprintCommand(command)
          && (!command.acceptance || JSON.stringify(existing.acceptance) === JSON.stringify(command.acceptance))
        : existing.fingerprint === fingerprintCommand(command);
      if (!same) throw inboxError("PENDING_COMMAND_IDEMPOTENCY_CONFLICT", "operationId 已对应不同 PendingCommand");
      return existing;
    }
    if (command.createdAt <= window.floor) throw inboxError("OPERATION_EXPIRED", "operation 已超出 30 天幂等窗口");
    if (activeCount >= this.maxActiveCommands) throw inboxError("PENDING_COMMAND_CAPACITY", "PendingCommand inbox 已满");
    return null;
  }

  #enqueueGroup(command, bytes) {
    if ((this.groupPending ?? 0) >= GROUP_COMMIT_QUEUE_LIMIT
      || (this.groupPendingBytes ?? 0) + bytes > GROUP_COMMIT_QUEUE_BYTES) {
      throw inboxError("PENDING_COMMAND_CAPACITY", "PendingCommand inbox 已满");
    }
    if (this.openGroup && this.openGroup.bytes + bytes > GROUP_COMMIT_BYTES) this.#sealGroup();
    if (!this.openGroup) {
      const { promise, resolve } = Promise.withResolvers();
      const group = { items: [], bytes: 0, seal: resolve };
      this.openGroup = group;
      group.timer = setTimeout(() => this.#sealGroup(), GROUP_COMMIT_DELAY_MS);
      // Reserve the FIFO position immediately. Later writes must wait even
      // when this group is still collecting consecutive acceptances.
      this.queue = this.queue.then(async () => {
        await promise;
        try { await this.#commitGroup(group.items); }
        catch (error) { for (const item of group.items) item.reject(error); }
        finally { this.groupPending -= group.items.length; this.groupPendingBytes -= group.bytes; }
      });
    }
    const group = this.openGroup;
    const { promise, resolve, reject } = Promise.withResolvers();
    group.items.push({ command, bytes, resolve, reject });
    group.bytes += bytes;
    this.groupPending = (this.groupPending ?? 0) + 1;
    this.groupPendingBytes = (this.groupPendingBytes ?? 0) + bytes;
    if (group.items.length >= GROUP_COMMIT_LIMIT || group.bytes >= GROUP_COMMIT_BYTES) this.#sealGroup();
    return promise;
  }

  #sealGroup() {
    const group = this.openGroup;
    if (!group) return;
    this.openGroup = null;
    clearTimeout(group.timer);
    group.seal();
  }

  async #commitGroup(items) {
    this.#assertOpen(true);
    let window = { floor: this.idempotencyFloorMs, tombstones: this.tombstones };
    const estimateCiphertext = bytes => this.cryptoBroker.encryptedBytes?.(bytes);
    const canEstimate = Number.isSafeInteger(estimateCiphertext(1));
    let activeCount = Object.keys(this.activeCommands).length;
    const activeCommands = { ...this.activeCommands };
    const results = [];
    let addedBytes = 0;
    let added = false;
    for (const item of items) {
      try {
        const time = this.#currentTime();
        item.observedTime = time;
        window = this.#nextWindow(time, window);
        const existing = this.#validateEnqueue(item.command, time, window, activeCommands, activeCount);
        if (!existing) {
          Object.defineProperty(activeCommands, item.command.operationId, { value: item.command, configurable: true, enumerable: true });
          if (canEstimate) addedBytes += item.bytes + JSON.stringify(item.command.operationId).length + 1 + Number(activeCount > 0);
          activeCount++;
          added = true;
        }
        results.push({ item, receipt: existing || item.command });
      } catch (error) { results.push({ item, error }); }
    }
    if (added) {
      if (canEstimate) {
        const size = estimateCiphertext(this.#plaintextBytesAt(window.floor, window.tombstones) + addedBytes);
        if (Number.isSafeInteger(size) && envelopeBytes(RECOVERABLE_PENDING_COMMAND_INBOX_VERSION,
          this.revision + 1, size) > MAX_PENDING_COMMAND_FILE_BYTES) {
          await this.#commitGroupAtCapacity(items, window);
          return;
        }
      }
      try { await this.#commit(activeCommands, window.tombstones, window.floor); }
      catch (error) {
        if (error?.code === "PENDING_COMMAND_CAPACITY") {
          await this.#commitGroupAtCapacity(items, window);
          return;
        }
        if (!this.commitUncertain) await this.#persistWindow(window);
        throw error;
      }
    } else {
      await this.#persistWindow(window);
    }
    for (const { item, error, receipt } of results) {
      if (error) item.reject(error);
      else item.resolve(clone(receipt));
    }
  }

  async #commitGroupAtCapacity(items, window) {
    const activeCommands = { ...this.activeCommands };
    let activeCount = Object.keys(activeCommands).length;
    const ciphertextBytes = bytes => this.cryptoBroker.encryptedBytes?.(bytes);
    if (!Number.isSafeInteger(ciphertextBytes(1))
      || Object.keys(window.tombstones).length !== Object.keys(this.tombstones).length) {
      await this.#commitGroupIndividually(items);
      return;
    }
    // Adding a row changes JSON by the escaped key, colon, row bytes and
    // (if nonempty) one comma. A commit installed by this writer has the
    // canonical body size already, so an overflow need not encode it twice.
    let plaintextBytes = this.#plaintextBytesAt(window.floor, window.tombstones);
    const results = [];
    let validationWindow = { floor: this.idempotencyFloorMs, tombstones: this.tombstones };
    try {
      for (const item of items) {
        const command = item.command;
        try {
          if (item.observedTime === undefined) {
            throw inboxError("PENDING_COMMAND_TIMESTAMP_INVALID", "本地时钟无效");
          }
          validationWindow = this.#nextWindow(item.observedTime, validationWindow);
          const existing = this.#validateEnqueue(command, item.observedTime, validationWindow, activeCommands, activeCount);
          if (existing) {
            results.push({ item, receipt: existing });
            continue;
          }
          const rowBytes = item.bytes + JSON.stringify(command.operationId).length + 1 + Number(activeCount > 0);
          const nextBytes = plaintextBytes + rowBytes;
          const encryptedBytes = ciphertextBytes(nextBytes);
          if (!Number.isSafeInteger(encryptedBytes)) {
            await this.#commitGroupIndividually(items);
            return;
          }
          if (envelopeBytes(RECOVERABLE_PENDING_COMMAND_INBOX_VERSION, this.revision + 1,
            encryptedBytes) > MAX_PENDING_COMMAND_FILE_BYTES) {
            throw inboxError("PENDING_COMMAND_CAPACITY", "PendingCommand inbox 已满");
          }
          Object.defineProperty(activeCommands, command.operationId, { value: command, enumerable: true, configurable: true });
          activeCount++;
          plaintextBytes = nextBytes;
          results.push({ item, receipt: command });
        } catch (error) { results.push({ item, error }); }
      }
      await yieldToService();
      if (activeCount !== Object.keys(this.activeCommands).length) {
        await this.#commit(activeCommands, window.tombstones, window.floor);
      } else await this.#persistWindow(window);
    } catch (error) {
      if (error?.code === "PENDING_COMMAND_CAPACITY") {
        await this.#commitGroupIndividually(items);
        return;
      }
      if (!this.commitUncertain) await this.#persistWindow(window);
      throw error;
    }
    for (const { item, error, receipt } of results) {
      if (error) item.reject(error);
      else item.resolve(clone(receipt));
    }
  }

  #plaintextBytesAt(floor, tombstones) {
    if (this.committedPlaintextBytes !== null && Object.keys(tombstones).length === Object.keys(this.tombstones).length) {
      return this.committedPlaintextBytes + String(floor).length - String(this.idempotencyFloorMs).length;
    }
    return Buffer.byteLength(JSON.stringify({
      idempotencyFloorMs: floor, activeCommands: this.activeCommands, tombstones,
    }));
  }

  async #commitGroupIndividually(items) {
    // Unknown ciphertext overhead must use actual encryption, and an oversized
    // command cannot consume room that a later smaller one could still use.
    for (const item of items) {
      await yieldToService();
      try {
        if (item.observedTime === undefined) {
          throw inboxError("PENDING_COMMAND_TIMESTAMP_INVALID", "本地时钟无效");
        }
        item.resolve(await this.#commitOne(item.command, item.observedTime));
      }
      catch (error) { item.reject(error); }
    }
  }

  get(operationId) {
    this.#assertOpen();
    if (!validOpaqueId(operationId)) {
      throw inboxError("PENDING_COMMAND_INVALID", "operationId 无效");
    }
    return clone(ownCommand(this.activeCommands, operationId) || ownCommand(this.tombstones, operationId));
  }

  hasPendingSession(sessionKey) {
    this.#assertOpen();
    return Object.values(this.activeCommands).some(command => command.sessionKey === sessionKey);
  }

  hasPendingAcceptance() {
    return (this.groupPending ?? 0) > 0;
  }

  requestAcceptedCancellation(operationId, receipt) {
    this.#assertOpen();
    if (!validOpaqueId(operationId) || !validOpaqueId(receipt?.runId)
      || !validOpaqueId(receipt?.profileId) || !UUID_PATTERN.test(receipt?.sessionKey)
      || !UUID_PATTERN.test(receipt?.sessionId)) {
      throw inboxError("PENDING_COMMAND_INVALID", "取消归属无效");
    }
    return this.#enqueueMutation(async () => {
      const command = ownCommand(this.activeCommands, operationId);
      if (!command?.acceptance || command.state !== "pending" || command.runId !== receipt.runId
        || command.sessionKey !== receipt.sessionKey || command.acceptance.profileId !== receipt.profileId
        || command.acceptance.sessionId !== receipt.sessionId) return false;
      if (!command.cancelRequested) {
        await this.#commit({ ...this.activeCommands, [operationId]: { ...command, cancelRequested: true } },
          this.tombstones);
      }
      return true;
    });
  }

  isUnadmittedRejection(operationId, sessionKey) {
    const entry = this.get(operationId);
    return entry?.state === "canceled" && entry.fingerprint === rejectionFingerprint(
      operationId, sessionKey, entry.createdAt);
  }

  rejectUnadmitted({ operationId, sessionKey, createdAt }) {
    this.#assertOpen();
    if (!validOpaqueId(operationId) || !UUID_PATTERN.test(sessionKey)
      || !Number.isSafeInteger(createdAt) || createdAt <= 0) {
      throw inboxError("PENDING_COMMAND_INVALID", "原发送观察记录无效");
    }
    return this.#enqueueMutation(async () => {
      const time = this.#currentTime();
      await this.#refreshWindow(time);
      const existing = ownCommand(this.activeCommands, operationId) || ownCommand(this.tombstones, operationId);
      const fingerprint = rejectionFingerprint(operationId, sessionKey, createdAt);
      if (existing) return existing.state === "canceled" && existing.fingerprint === fingerprint;
      // The coordinator serializes this with same-session admission; this
      // mutation also fences any late enqueue before reporting non-admission.
      // Retained state covers the full window. A fresh Inbox only covers sends
      // created since it opened; it cannot prove absence in missing old state.
      if ((!this.loadedFromDisk && createdAt < this.openedAt) || createdAt > time
        || createdAt <= this.idempotencyFloorMs) return false;
      if (Object.keys(this.tombstones).length >= this.maxTombstones) {
        throw inboxError("PENDING_COMMAND_CAPACITY", "PendingCommand 幂等窗口容量已满");
      }
      const rejected = normalizeTombstone({ operationId, fingerprint, state: "canceled",
        createdAt, finishedAt: time });
      await this.#commit(this.activeCommands, { ...this.tombstones, [operationId]: rejected });
      return true;
    });
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
    const command = ownCommand(this.activeCommands, operationId);
    if (!command) {
      const tombstone = ownCommand(this.tombstones, operationId);
      if (!tombstone) throw inboxError("PENDING_COMMAND_NOT_FOUND", "PendingCommand 不存在");
      if (tombstone.state === nextState) return clone(tombstone);
      throw inboxError("PENDING_COMMAND_TRANSITION_INVALID", "PendingCommand 状态迁移非法");
    }
    if (command.state === nextState) return clone(command);
    if (!LEGAL_TRANSITIONS[command.state].has(nextState) || (command.cancelRequested && nextState !== "canceled")) {
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
        ...(command.acceptance ? { receipt: { profileId: command.acceptance.profileId,
          sessionId: command.acceptance.sessionId, runId: command.runId, sessionKey: command.sessionKey } } : {}),
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
    const version = this.version === RECOVERABLE_PENDING_COMMAND_INBOX_VERSION
      || Object.values(activeCommands).some(command => command.acceptance)
      || Object.values(tombstones).some(tombstone => tombstone.receipt)
      ? RECOVERABLE_PENDING_COMMAND_INBOX_VERSION : PENDING_COMMAND_INBOX_VERSION;
    const validated = validatePlaintext({ idempotencyFloorMs, activeCommands, tombstones }, version);
    const plaintext = this.fileWriter && this.committedPlaintextBytes >= ASYNC_SERIALIZATION_THRESHOLD
      ? await encodePlaintext(validated)
      : Buffer.from(JSON.stringify(validated), "utf8");
    const plaintextBytes = plaintext.length;
    let encrypted = null;
    try {
      encrypted = await this.cryptoBroker.encrypt(plaintext);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error("invalid ciphertext");
    } catch {
      throw lockedError();
    } finally {
      plaintext.fill(0);
    }
    const revision = this.revision + 1;
    if (envelopeBytes(version, revision, encrypted.length) > MAX_PENDING_COMMAND_FILE_BYTES) {
      encrypted.fill(0);
      throw inboxError("PENDING_COMMAND_CAPACITY", "PendingCommand inbox 已满");
    }
    try {
      if (this.fileWriter) await this.fileWriter.write({ version, revision, encrypted });
      else this.atomicWrite(this.filePath, serializeEnvelope(version, revision, encrypted),
        { fs: this.fs, trustedRoot: this.paths.trustedRoot });
    } catch (error) {
      if (error?.committed !== true && error?.committedUncertain === true) {
        this.commitUncertain = true;
        this.activeCommands = {};
        this.tombstones = {};
        this.idempotencyFloorMs = 0;
        this.committedPlaintextBytes = null;
        const uncertain = inboxError(
          "PENDING_COMMAND_COMMIT_UNCERTAIN",
          "PendingCommand 提交状态不确定，必须重新打开",
        );
        uncertain.committedUncertain = true;
        uncertain.systemIssue = storageIssueCode(error);
        throw uncertain;
      }
      if (error?.committed === true) {
        // 目标文件已提交；仅 cleanup 失败不能把已安装 candidate 当成未知提交。
      } else if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      else {
        const failure = inboxError("PENDING_COMMAND_WRITE_FAILED", "PendingCommand 写入失败");
        failure.systemIssue = storageIssueCode(error);
        throw failure;
      }
    } finally {
      encrypted.fill(0);
    }
    this.activeCommands = validated.activeCommands;
    this.tombstones = validated.tombstones;
    this.idempotencyFloorMs = validated.idempotencyFloorMs;
    this.revision = revision;
    this.version = version;
    this.committedPlaintextBytes = plaintextBytes;
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
    const window = this.#nextWindow(time);
    if (persist) await this.#persistWindow(window);
    else {
      this.idempotencyFloorMs = window.floor;
      this.tombstones = window.tombstones;
    }
  }

  #nextWindow(time, current = { floor: this.idempotencyFloorMs, tombstones: this.tombstones }) {
    const floor = Math.max(
      current.floor,
      Math.max(0, time - IDEMPOTENCY_WINDOW_MS),
    );
    if (floor === current.floor) return current;
    return { floor, tombstones: Object.fromEntries(Object.entries(current.tombstones)
      .filter(([, tombstone]) => tombstone.finishedAt >= floor)) };
  }

  async #persistWindow({ floor, tombstones }) {
    if (floor !== this.idempotencyFloorMs) await this.#commit(this.activeCommands, tombstones, floor);
  }

  #assertOpen(admittedBeforeClose = false) {
    if (this.opened && this.contentLocked) throw lockedError();
    if (this.commitUncertain) {
      throw inboxError(
        "PENDING_COMMAND_COMMIT_UNCERTAIN",
        "PendingCommand 提交状态不确定，必须重新打开",
      );
    }
    if (!this.opened || (this.closing && !admittedBeforeClose)) {
      throw inboxError("PENDING_COMMAND_INBOX_CLOSED", "PendingCommandInbox 未打开");
    }
  }

  #enqueueMutation(action) {
    this.#sealGroup();
    const result = this.queue.then(() => {
      // A prior queued write can poison the Inbox before this action gets
      // the writer slot. Recheck at execution; shutdown still joins actions
      // already admitted to this FIFO.
      this.#assertOpen(true);
      return action();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  #scheduleLateUnlock(decryptAttempt, openGeneration, version) {
    void Promise.resolve(decryptAttempt).then(async (outcome) => {
      let plaintext = Buffer.isBuffer(outcome?.value) ? outcome.value : null;
      let container = null;
      try {
        if (outcome?.error || !plaintext || plaintext.length === 0) return;
        container = validatePlaintext(JSON.parse(plaintext.toString("utf8")), version);
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
  RECOVERABLE_PENDING_COMMAND_INBOX_VERSION,
  PendingCommandInbox,
  fingerprintCommand,
  normalizeCommand,
  normalizeTombstone,
  validateEnvelope,
  validatePlaintext,
};
