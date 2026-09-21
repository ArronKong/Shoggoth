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

const NATIVE_KANBAN_STORE_VERSION = 4;
const PREVIOUS_NATIVE_KANBAN_STORE_VERSION = 3;
const INTEGRITY_NATIVE_KANBAN_STORE_VERSION = 2;
const LEGACY_NATIVE_KANBAN_STORE_VERSION = 1;
const MAX_NATIVE_KANBAN_STORE_BYTES = 64 * 1024 * 1024;
const IDEMPOTENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OPERATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CARD_STATUSES = new Set([
  "triage", "backlog", "queued", "running", "review", "waiting", "done", "failed", "canceled",
]);
const DEFAULT_CAPACITIES = Object.freeze({
  boards: 128,
  cards: 8192,
  comments: 32768,
  attachments: 16384,
  artifacts: 32768,
  cardRunLinks: 32768,
  auditEvents: 16384,
  operations: 65536,
});
const LEGAL_STATUS_TRANSITIONS = Object.freeze({
  triage: new Set(["backlog", "canceled"]),
  backlog: new Set(["triage", "queued", "canceled"]),
  queued: new Set(["backlog", "running", "waiting", "failed", "canceled"]),
  running: new Set(["review", "waiting", "failed", "canceled"]),
  review: new Set(["backlog", "waiting", "failed", "canceled"]),
  waiting: new Set(["queued", "running", "review", "failed", "canceled"]),
  failed: new Set(["queued", "canceled"]),
  canceled: new Set(["queued"]),
  done: new Set(),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BOARD_FIELDS = Object.freeze([
  "id", "profileId", "slug", "name", "description", "createdAt", "updatedAt",
]);
const CARD_FIELDS = Object.freeze([
  "id", "boardId", "profileId", "title", "body", "status", "position",
  "archivedAt", "completionRequest", "completion", "createdAt", "updatedAt",
]);
const PREVIOUS_CARD_FIELDS = Object.freeze(CARD_FIELDS.filter((field) => field !== "archivedAt"));
const COMMENT_FIELDS = Object.freeze([
  "id", "cardId", "authorType", "authorId", "body", "createdAt",
]);
const ATTACHMENT_FIELDS = Object.freeze([
  "id", "cardId", "name", "mimeType", "sizeBytes", "sha256", "storageKey", "createdAt",
]);
const ARTIFACT_FIELDS = Object.freeze([
  "id", "cardId", "runId", "name", "kind", "mimeType", "sizeBytes", "sha256",
  "storageKey", "createdAt",
]);
const CARD_RUN_LINK_FIELDS = Object.freeze([
  "id", "cardId", "runId", "retryOf", "createdAt",
]);
const PROPOSED_WORK_RUN_FIELDS = Object.freeze([
  "id", "source", "sourceId", "idempotencyKey", "profileId", "workspace", "retryOf",
]);
const AUDIT_FIELDS = Object.freeze([
  "id", "cardId", "kind", "actorId", "runId", "note", "createdAt",
]);
const LEGACY_OPERATION_FIELDS = Object.freeze([
  "operationId", "kind", "fingerprint", "createdAt", "resultType", "resultId", "result",
]);
const OPERATION_FIELDS = Object.freeze([...LEGACY_OPERATION_FIELDS, "integrity"]);
const CONTAINER_FIELDS = Object.freeze([
  "version", "revision", "clockHighWaterMs", "idempotencyFloorMs", "boards", "cards", "comments",
  "attachments", "artifacts", "cardRunLinks", "auditEvents", "operations",
]);
const LEGACY_CONTAINER_FIELDS = Object.freeze([
  "version", "revision", "boards", "cards", "comments", "attachments", "artifacts",
  "cardRunLinks", "auditEvents", "operations",
]);
const RESULT_MAPS = Object.freeze({
  board: "boards",
  card: "cards",
  comment: "comments",
  attachment: "attachments",
  artifact: "artifacts",
  cardRunLink: "cardRunLinks",
});
const OPERATION_RESULT_TYPES = Object.freeze({
  create_board: "board",
  update_board: "board",
  create_card: "card",
  update_card: "card",
  set_card_status: "card",
  set_card_archived: "card",
  request_card_completion: "card",
  complete_card_by_product: "card",
  complete_card_manually: "card",
  add_comment: "comment",
  add_attachment: "attachment",
  add_artifact: "artifact",
  link_card_run: "cardRunLink",
});

function kanbanError(code, message) {
  return serviceError(code, message);
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => own(value, field));
}

function validOpaqueId(value, maxLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && OPAQUE_ID_PATTERN.test(value);
}

function validText(value, maxBytes, nullable = false, allowEmpty = false) {
  if (nullable && value === null) return true;
  return typeof value === "string" && (allowEmpty || value.length > 0) && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validPosition(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validStorageKey(value) {
  if (!validText(value, 4096) || path.isAbsolute(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function fingerprintOperation(kind, input) {
  return crypto.createHash("sha256").update(canonicalJson({ kind, input })).digest("hex");
}

function operationIntegrity(value) {
  const payload = Object.fromEntries(LEGACY_OPERATION_FIELDS.map((field) => [field, value[field]]));
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function normalizationError(corrupt, entity) {
  return kanbanError(
    corrupt ? "KANBAN_STORE_CORRUPT" : `KANBAN_${entity.toUpperCase()}_INVALID`,
    `${entity} 数据无效`,
  );
}

function normalizeCompletionRequest(value, corrupt = false) {
  if (value === null) return null;
  if (!exactObject(value, ["runId", "requestedAt"])
    || !validOpaqueId(value.runId) || !validTimestamp(value.requestedAt)) {
    throw normalizationError(corrupt, "card");
  }
  return { runId: value.runId, requestedAt: value.requestedAt };
}

function normalizeCompletion(value, corrupt = false) {
  if (value === null) return null;
  const common = value && ["manual", "run"].includes(value.mode)
    && validOpaqueId(value.actorId) && validTimestamp(value.at);
  if (!common) throw normalizationError(corrupt, "card");
  if (value.mode === "run") {
    if (!exactObject(value, ["mode", "runId", "actorId", "at"])
      || !validOpaqueId(value.runId)) throw normalizationError(corrupt, "card");
    return { mode: value.mode, runId: value.runId, actorId: value.actorId, at: value.at };
  }
  if (!exactObject(value, ["mode", "runId", "actorId", "at", "note"])
    || value.runId !== null || !validText(value.note, 4096, true, true)) {
    throw normalizationError(corrupt, "card");
  }
  return {
    mode: value.mode, runId: null, actorId: value.actorId, at: value.at, note: value.note,
  };
}

function normalizeBoard(value, corrupt = false) {
  if (!exactObject(value, BOARD_FIELDS) || !UUID_PATTERN.test(value.id)
    || !validOpaqueId(value.profileId) || !SLUG_PATTERN.test(value.slug)
    || !validText(value.name, 512) || !validText(value.description, 16 * 1024, true, true)
    || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt) throw normalizationError(corrupt, "board");
  return Object.fromEntries(BOARD_FIELDS.map((field) => [field, value[field]]));
}

function normalizeCard(value, corrupt = false) {
  if (!exactObject(value, CARD_FIELDS) || !UUID_PATTERN.test(value.id)
    || !UUID_PATTERN.test(value.boardId) || !validOpaqueId(value.profileId)
    || !validText(value.title, 2048) || !validText(value.body, 1024 * 1024, true, true)
    || !CARD_STATUSES.has(value.status) || !validPosition(value.position)
    || !(value.archivedAt === null || validTimestamp(value.archivedAt))
    || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt) throw normalizationError(corrupt, "card");
  const completionRequest = normalizeCompletionRequest(value.completionRequest, corrupt);
  const completion = normalizeCompletion(value.completion, corrupt);
  if ((value.status === "done") !== (completion !== null)) throw normalizationError(corrupt, "card");
  return { ...Object.fromEntries(CARD_FIELDS.map((field) => [field, value[field]])), completionRequest, completion };
}

function normalizePreviousCard(value, corrupt = false) {
  if (!exactObject(value, PREVIOUS_CARD_FIELDS)) throw normalizationError(corrupt, "card");
  const normalized = normalizeCard({ ...value, archivedAt: null }, corrupt);
  return Object.fromEntries(PREVIOUS_CARD_FIELDS.map((field) => [field, normalized[field]]));
}

function normalizeComment(value, corrupt = false) {
  if (!exactObject(value, COMMENT_FIELDS) || !UUID_PATTERN.test(value.id)
    || !UUID_PATTERN.test(value.cardId) || !["human", "agent", "product"].includes(value.authorType)
    || !validOpaqueId(value.authorId) || !validText(value.body, 64 * 1024)
    || !validTimestamp(value.createdAt)) throw normalizationError(corrupt, "comment");
  return Object.fromEntries(COMMENT_FIELDS.map((field) => [field, value[field]]));
}

function normalizeAttachment(value, corrupt = false) {
  if (!exactObject(value, ATTACHMENT_FIELDS) || !UUID_PATTERN.test(value.id)
    || !UUID_PATTERN.test(value.cardId) || !validText(value.name, 1024)
    || !validText(value.mimeType, 256, true) || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 0 || !SHA256_PATTERN.test(value.sha256)
    || !validStorageKey(value.storageKey) || !validTimestamp(value.createdAt)) {
    throw normalizationError(corrupt, "attachment");
  }
  return Object.fromEntries(ATTACHMENT_FIELDS.map((field) => [field, value[field]]));
}

function normalizeArtifact(value, corrupt = false) {
  if (!exactObject(value, ARTIFACT_FIELDS) || !UUID_PATTERN.test(value.id)
    || !UUID_PATTERN.test(value.cardId) || !validOpaqueId(value.runId)
    || !validText(value.name, 1024) || !validOpaqueId(value.kind, 64)
    || !validText(value.mimeType, 256, true) || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 0 || !SHA256_PATTERN.test(value.sha256)
    || !validStorageKey(value.storageKey) || !validTimestamp(value.createdAt)) {
    throw normalizationError(corrupt, "artifact");
  }
  return Object.fromEntries(ARTIFACT_FIELDS.map((field) => [field, value[field]]));
}

function normalizeCardRunLink(value, corrupt = false) {
  if (!exactObject(value, CARD_RUN_LINK_FIELDS) || !UUID_PATTERN.test(value.id)
    || !UUID_PATTERN.test(value.cardId) || !validOpaqueId(value.runId)
    || !(value.retryOf === null || validOpaqueId(value.retryOf))
    || value.retryOf === value.runId || !validTimestamp(value.createdAt)) {
    throw normalizationError(corrupt, "card_run_link");
  }
  return Object.fromEntries(CARD_RUN_LINK_FIELDS.map((field) => [field, value[field]]));
}

function normalizeAudit(value, corrupt = false) {
  if (!exactObject(value, AUDIT_FIELDS) || !UUID_PATTERN.test(value.id)
    || !UUID_PATTERN.test(value.cardId) || value.kind !== "manual_completion"
    || !validOpaqueId(value.actorId) || value.runId !== null
    || !validText(value.note, 4096, true, true) || !validTimestamp(value.createdAt)) {
    throw normalizationError(corrupt, "audit");
  }
  return Object.fromEntries(AUDIT_FIELDS.map((field) => [field, value[field]]));
}

function normalizeOperationShape(value, corrupt = false, legacy = false, cardNormalizer = normalizeCard) {
  const fields = legacy ? LEGACY_OPERATION_FIELDS : OPERATION_FIELDS;
  if (!exactObject(value, fields) || !validOpaqueId(value.operationId)
    || !validOpaqueId(value.kind, 64) || !SHA256_PATTERN.test(value.fingerprint)
    || !validTimestamp(value.createdAt) || !own(RESULT_MAPS, value.resultType)
    || !UUID_PATTERN.test(value.resultId)
    || (!legacy && !SHA256_PATTERN.test(value.integrity))) {
    throw normalizationError(corrupt, "operation");
  }
  let result;
  try {
    if (value.resultType === "board") result = normalizeBoard(value.result, corrupt);
    else if (value.resultType === "card") result = cardNormalizer(value.result, corrupt);
    else if (value.resultType === "comment") result = normalizeComment(value.result, corrupt);
    else if (value.resultType === "attachment") result = normalizeAttachment(value.result, corrupt);
    else if (value.resultType === "artifact") result = normalizeArtifact(value.result, corrupt);
    else result = normalizeCardRunLink(value.result, corrupt);
  } catch {
    throw normalizationError(corrupt, "operation");
  }
  if (result.id !== value.resultId) throw normalizationError(corrupt, "operation");
  const core = {
    ...Object.fromEntries(LEGACY_OPERATION_FIELDS.map((field) => [field, value[field]])),
    result,
  };
  const integrity = operationIntegrity(core);
  if (!legacy && value.integrity !== integrity) throw normalizationError(corrupt, "operation");
  return { ...core, integrity };
}

function normalizeOperation(value, corrupt = false) {
  return normalizeOperationShape(value, corrupt, false);
}

function normalizeLegacyOperation(value, corrupt = false) {
  return normalizeOperationShape(value, corrupt, true, normalizePreviousCard);
}

function normalizePreviousOperation(value, corrupt = false) {
  return normalizeOperationShape(value, corrupt, false, normalizePreviousCard);
}

function normalizeMap(value, limit, normalize, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length > limit) {
    throw kanbanError("KANBAN_STORE_CORRUPT", `${label} 容器损坏`);
  }
  const entries = Object.entries(value).map(([id, raw]) => {
    const item = normalize(raw, true);
    if (item.id !== id && item.operationId !== id) {
      throw kanbanError("KANBAN_STORE_CORRUPT", `${label} 索引损坏`);
    }
    return [id, item];
  });
  return Object.fromEntries(entries);
}

function validateContainerShape(
  value, version, operationNormalizer = normalizeOperation, cardNormalizer = normalizeCard,
) {
  if (!exactObject(value, CONTAINER_FIELDS) || value.version !== version
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !validTimestamp(value.clockHighWaterMs)
    || value.clockHighWaterMs > Number.MAX_SAFE_INTEGER - MAX_OPERATION_FUTURE_SKEW_MS
    || !validTimestamp(value.idempotencyFloorMs)
    || value.idempotencyFloorMs > value.clockHighWaterMs) {
    throw kanbanError("KANBAN_STORE_CORRUPT", "Native Kanban 容器损坏");
  }
  const boards = normalizeMap(value.boards, DEFAULT_CAPACITIES.boards, normalizeBoard, "Board");
  const cards = normalizeMap(value.cards, DEFAULT_CAPACITIES.cards, cardNormalizer, "Card");
  const comments = normalizeMap(value.comments, DEFAULT_CAPACITIES.comments, normalizeComment, "Comment");
  const attachments = normalizeMap(
    value.attachments, DEFAULT_CAPACITIES.attachments, normalizeAttachment, "Attachment",
  );
  const artifacts = normalizeMap(value.artifacts, DEFAULT_CAPACITIES.artifacts, normalizeArtifact, "Artifact");
  const cardRunLinks = normalizeMap(
    value.cardRunLinks, DEFAULT_CAPACITIES.cardRunLinks, normalizeCardRunLink, "CardRunLink",
  );
  const auditEvents = normalizeMap(
    value.auditEvents, DEFAULT_CAPACITIES.auditEvents, normalizeAudit, "AuditEvent",
  );
  const operations = normalizeMap(
    value.operations, DEFAULT_CAPACITIES.operations, operationNormalizer, "Operation",
  );

  const slugs = new Set();
  for (const board of Object.values(boards)) {
    if (slugs.has(board.slug)) throw kanbanError("KANBAN_STORE_CORRUPT", "Board slug 重复");
    slugs.add(board.slug);
  }
  for (const card of Object.values(cards)) {
    const board = boards[card.boardId];
    if (!board || board.profileId !== card.profileId) {
      throw kanbanError("KANBAN_STORE_CORRUPT", "Card 的 Board/Profile 引用无效");
    }
  }
  const linksByRunId = new Map();
  const cardRunPairs = new Set();
  for (const link of Object.values(cardRunLinks)) {
    if (!cards[link.cardId] || linksByRunId.has(link.runId)) {
      throw kanbanError("KANBAN_STORE_CORRUPT", "CardRunLink 引用无效");
    }
    linksByRunId.set(link.runId, link);
    cardRunPairs.add(`${link.cardId}\0${link.runId}`);
  }
  for (const link of Object.values(cardRunLinks)) {
    if (link.retryOf !== null) {
      const prior = linksByRunId.get(link.retryOf);
      if (!prior || prior.cardId !== link.cardId || prior.createdAt > link.createdAt) {
        throw kanbanError("KANBAN_STORE_CORRUPT", "CardRunLink retryOf 引用无效");
      }
    }
  }
  for (const [items, label] of [
    [comments, "Comment"], [attachments, "Attachment"], [auditEvents, "AuditEvent"],
  ]) {
    if (Object.values(items).some((item) => !cards[item.cardId])) {
      throw kanbanError("KANBAN_STORE_CORRUPT", `${label} 的 Card 引用无效`);
    }
  }
  const manualAuditByCard = new Map();
  for (const audit of Object.values(auditEvents)) {
    const completion = cards[audit.cardId]?.completion;
    if (manualAuditByCard.has(audit.cardId) || completion?.mode !== "manual"
      || completion.actorId !== audit.actorId || completion.note !== audit.note
      || completion.at !== audit.createdAt) {
      throw kanbanError("KANBAN_STORE_CORRUPT", "人工完成审计与 Card completion 不匹配");
    }
    manualAuditByCard.set(audit.cardId, audit);
  }
  for (const card of Object.values(cards)) {
    if (card.completion?.mode === "manual" && !manualAuditByCard.has(card.id)) {
      throw kanbanError("KANBAN_STORE_CORRUPT", "人工完成缺少唯一审计证据");
    }
  }
  for (const artifact of Object.values(artifacts)) {
    if (!cards[artifact.cardId] || !cardRunPairs.has(`${artifact.cardId}\0${artifact.runId}`)) {
      throw kanbanError("KANBAN_STORE_CORRUPT", "Artifact 的 Card/Run 引用无效");
    }
  }
  for (const card of Object.values(cards)) {
    for (const runId of [card.completionRequest?.runId, card.completion?.runId].filter(Boolean)) {
      if (!cardRunPairs.has(`${card.id}\0${runId}`)) {
        throw kanbanError("KANBAN_STORE_CORRUPT", "Card completion 的 Run 引用无效");
      }
    }
  }
  for (const operation of Object.values(operations)) {
    const map = RESULT_MAPS[operation.resultType];
    const live = {
      boards, cards, comments, attachments, artifacts, cardRunLinks,
    }[map][operation.resultId];
    if (OPERATION_RESULT_TYPES[operation.kind] !== operation.resultType || !live) {
      throw kanbanError("KANBAN_STORE_CORRUPT", "Operation result 引用无效");
    }
    if (operation.resultType === "board") {
      if (["id", "profileId", "slug", "createdAt"].some(
        (field) => operation.result[field] !== live[field],
      ) || operation.result.updatedAt > live.updatedAt) {
        throw kanbanError("KANBAN_STORE_CORRUPT", "Operation Board replay 语义损坏");
      }
    } else if (operation.resultType === "card") {
      if (["id", "boardId", "profileId", "createdAt"].some(
        (field) => operation.result[field] !== live[field],
      ) || operation.result.updatedAt > live.updatedAt) {
        throw kanbanError("KANBAN_STORE_CORRUPT", "Operation Card replay 语义损坏");
      }
      const board = boards[operation.result.boardId];
      if (!board || board.profileId !== operation.result.profileId) {
        throw kanbanError("KANBAN_STORE_CORRUPT", "Operation Card replay 引用损坏");
      }
      for (const runId of [
        operation.result.completionRequest?.runId,
        operation.result.completion?.runId,
      ].filter(Boolean)) {
        if (!cardRunPairs.has(`${operation.result.id}\0${runId}`)) {
          throw kanbanError("KANBAN_STORE_CORRUPT", "Operation Card replay Run 引用损坏");
        }
      }
    } else if (canonicalJson(operation.result) !== canonicalJson(live)) {
      throw kanbanError("KANBAN_STORE_CORRUPT", "Operation replay 快照与实体不一致");
    }
  }
  return {
    version,
    revision: value.revision,
    clockHighWaterMs: value.clockHighWaterMs,
    idempotencyFloorMs: value.idempotencyFloorMs,
    boards,
    cards,
    comments,
    attachments,
    artifacts,
    cardRunLinks,
    auditEvents,
    operations,
  };
}

function validateContainer(value) {
  return validateContainerShape(value, NATIVE_KANBAN_STORE_VERSION);
}

function migratePreviousContainer(value, version, operationNormalizer) {
  const provisional = validateContainerShape(
    value, version, operationNormalizer, normalizePreviousCard,
  );
  const cards = Object.fromEntries(Object.entries(provisional.cards).map(([id, card]) => [id, {
    ...card,
    archivedAt: null,
  }]));
  const operations = Object.fromEntries(Object.entries(provisional.operations).map(([id, operation]) => {
    const core = operation.resultType === "card"
      ? { ...operation, result: { ...operation.result, archivedAt: null } }
      : operation;
    return [id, { ...core, integrity: operationIntegrity(core) }];
  }));
  return validateContainer({
    ...provisional,
    version: NATIVE_KANBAN_STORE_VERSION,
    revision: provisional.revision + 1,
    cards,
    operations,
  });
}

function migrateV3Container(value) {
  return migratePreviousContainer(
    value, PREVIOUS_NATIVE_KANBAN_STORE_VERSION, normalizePreviousOperation,
  );
}

function migrateV2Container(value) {
  return migratePreviousContainer(
    value, INTEGRITY_NATIVE_KANBAN_STORE_VERSION, normalizeLegacyOperation,
  );
}

function migrateV1Container(value, trustedTime) {
  if (value?.version !== LEGACY_NATIVE_KANBAN_STORE_VERSION
    || (!exactObject(value, CONTAINER_FIELDS) && !exactObject(value, LEGACY_CONTAINER_FIELDS))) {
    throw kanbanError("KANBAN_STORE_CORRUPT", "Native Kanban v1 容器损坏");
  }
  const transitional = exactObject(value, CONTAINER_FIELDS);
  const provisional = validateContainerShape({
    ...value,
    clockHighWaterMs: transitional ? value.clockHighWaterMs : trustedTime,
    idempotencyFloorMs: transitional ? value.idempotencyFloorMs : 0,
  }, LEGACY_NATIVE_KANBAN_STORE_VERSION, normalizeLegacyOperation, normalizePreviousCard);
  const clockHighWaterMs = Math.max(provisional.clockHighWaterMs, trustedTime);
  const idempotencyFloorMs = Math.max(
    provisional.idempotencyFloorMs,
    Math.max(0, clockHighWaterMs - IDEMPOTENCY_WINDOW_MS),
  );
  return migratePreviousContainer({
    ...provisional,
    version: LEGACY_NATIVE_KANBAN_STORE_VERSION,
    revision: provisional.revision + 1,
    clockHighWaterMs,
    idempotencyFloorMs,
    operations: Object.fromEntries(Object.entries(provisional.operations)
      .filter(([, operation]) => operation.createdAt >= idempotencyFloorMs)),
  }, LEGACY_NATIVE_KANBAN_STORE_VERSION, normalizePreviousOperation);
}

function assertNoSensitive(value, matcher, location = "payload", seen = new Set()) {
  if (typeof value === "string") {
    if (matcher) {
      let sensitive;
      try { sensitive = matcher(value); } catch {
        throw kanbanError("KANBAN_SENSITIVE_CHECK_FAILED", "敏感值判定器执行失败");
      }
      if (sensitive === true) throw kanbanError("KANBAN_SENSITIVE_VALUE", "拒绝持久化敏感值");
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw kanbanError("KANBAN_INVALID_JSON", `${location} 不是可持久化 JSON`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitive(item, matcher, `${location}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
      if (["token", "apikey", "authorization", "secret", "password", "credential", "privatekey", "cookie"]
        .some((term) => normalized.includes(term))) {
        throw kanbanError("KANBAN_SENSITIVE_FIELD", "拒绝持久化敏感字段");
      }
      assertNoSensitive(item, matcher, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function normalizeCapacities(input) {
  if (input === undefined) return { ...DEFAULT_CAPACITIES };
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).some((key) => !own(DEFAULT_CAPACITIES, key))) {
    throw kanbanError("KANBAN_CAPACITY_INVALID", "Kanban 容量配置无效");
  }
  const result = { ...DEFAULT_CAPACITIES };
  for (const [key, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_CAPACITIES[key]) {
      throw kanbanError("KANBAN_CAPACITY_INVALID", "Kanban 容量配置无效");
    }
    result[key] = value;
  }
  return result;
}

class NativeKanbanStore {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot) {
      throw kanbanError("KANBAN_PATHS_REQUIRED", "NativeKanbanStore 需要 Service paths");
    }
    if (typeof options.profileExists !== "function" || typeof options.getRun !== "function") {
      throw kanbanError("KANBAN_REFERENCE_RESOLVERS_REQUIRED", "NativeKanbanStore 需要 Profile/Run resolver");
    }
    if (options.isSensitiveValue !== undefined && typeof options.isSensitiveValue !== "function") {
      throw kanbanError("KANBAN_OPTIONS_INVALID", "isSensitiveValue 必须是函数");
    }
    this.paths = options.paths;
    this.filePath = path.join(this.paths.stateDir, "native-kanban.json");
    this.fs = options.fs || fs;
    this.atomicWrite = options.atomicWrite || atomicWritePrivateFile;
    this.acquireWriterLease = options.acquireWriterLease || acquirePrivateWriterLease;
    this.profileExists = options.profileExists;
    this.getRun = options.getRun;
    this.isSensitiveValue = options.isSensitiveValue || null;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.capacities = normalizeCapacities(options.capacities);
    this.writerLease = null;
    this.cleanupPending = false;
    this.opened = false;
    this.commitUncertain = false;
    this.mutationGeneration = 0;
    this.preparedCardRunLink = null;
    this.container = this.#emptyContainer();
  }

  open() {
    if (this.opened) return this;
    preparePrivateParent(this.filePath, this.paths.trustedRoot, this.fs);
    const lease = this.acquireWriterLease({
      lockPath: path.join(this.paths.stateDir, "native-kanban.writer.lock"),
      trustedRoot: this.paths.trustedRoot,
      fs: this.fs,
    });
    try {
      const recovery = recoverInterruptedPrivateFile(this.filePath, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
      if (recovery === "uncertain") {
        // target/backup 无法证明谁已提交时，必须先发布可关闭的 poisoned ownership；
        // 禁止 parse、secret matcher 或外部引用 resolver 用次级错误遮蔽证据。
        this.container = this.#emptyContainer();
        this.commitUncertain = true;
        this.writerLease = lease;
        this.cleanupPending = false;
        this.opened = true;
        return this;
      }
      const stat = statIfExists(this.fs, this.filePath);
      const openTime = this.#currentTime();
      const parsed = stat ? this.#parse(readPrivateFile(this.filePath, {
        fs: this.fs,
        maxBytes: MAX_NATIVE_KANBAN_STORE_BYTES,
      }), openTime) : { container: this.#emptyContainer(), migrated: false };
      this.container = parsed.container;
      assertNoSensitive(this.container, this.isSensitiveValue);
      this.#assertExternalReferences(this.container);
      this.commitUncertain = false;
      if (parsed.migrated) this.container = this.#write(this.container);
      this.#refreshWindow(openTime, Boolean(stat));
      this.writerLease = lease;
      this.cleanupPending = false;
      this.opened = true;
      return this;
    } catch (openError) {
      try {
        lease.release();
      } catch (releaseError) {
        this.writerLease = lease;
        this.cleanupPending = true;
        const cleanupError = kanbanError("LEASE_RELEASE_FAILED", "NativeKanbanStore writer lease 清理失败");
        cleanupError.cause = releaseError;
        throw new AggregateError([openError, cleanupError], "NativeKanbanStore open 与 lease 清理均失败");
      }
      this.writerLease = null;
      this.cleanupPending = false;
      throw openError;
    }
  }

  close() {
    const lease = this.writerLease;
    if (lease) {
      try { lease.release(); } catch (error) {
        this.cleanupPending = true;
        throw error;
      }
    }
    this.writerLease = null;
    this.cleanupPending = false;
    this.opened = false;
    this.preparedCardRunLink = null;
    this.container = this.#emptyContainer();
  }

  preflightOperationTimestamp(createdAt) {
    this.#assertOpen();
    if (!validTimestamp(createdAt)) {
      throw kanbanError("KANBAN_TIMESTAMP_INVALID", "operation createdAt 无效");
    }
    const trustedTime = Math.max(this.container.clockHighWaterMs, this.#currentTime());
    const floor = Math.max(
      this.container.idempotencyFloorMs,
      Math.max(0, trustedTime - IDEMPOTENCY_WINDOW_MS),
    );
    if (createdAt > trustedTime + MAX_OPERATION_FUTURE_SKEW_MS) {
      throw kanbanError("KANBAN_TIMESTAMP_INVALID", "operation createdAt 超出未来时钟偏差");
    }
    if (createdAt <= floor) {
      throw kanbanError("KANBAN_OPERATION_EXPIRED", "operation 已超出 30 天幂等窗口");
    }
    return trustedTime;
  }

  preflightDurableOperationTimestamp(createdAt) {
    this.#assertOpen();
    if (!validTimestamp(createdAt)) {
      throw kanbanError("KANBAN_TIMESTAMP_INVALID", "durable operation createdAt 无效");
    }
    const trustedTime = Math.max(this.container.clockHighWaterMs, this.#currentTime());
    if (createdAt > trustedTime + MAX_OPERATION_FUTURE_SKEW_MS) {
      throw kanbanError("KANBAN_TIMESTAMP_INVALID", "durable operation createdAt 超出未来时钟偏差");
    }
    return trustedTime;
  }

  preflightCardRunLink(input, proposedRun) {
    if (validTimestamp(input) && proposedRun === undefined) {
      return this.#reserveOperationWindow(input);
    }
    this.preparedCardRunLink = null;
    this.#assertCardRunLinkInput(input);
    const run = this.#normalizeProposedRun(proposedRun, input);
    const beforeReservation = this.container;
    const beforeGeneration = this.mutationGeneration;
    const reservationFence = this.#captureMutationFence();
    try {
      const time = this.#currentTime();
      const reservation = this.#windowCandidate(time, true);
      this.#assertOperationTimestamp(input.createdAt, reservation);
      this.#assertCapacity(reservation, "operations");
      this.#assertCapacity(reservation, "cardRunLinks");
      const card = reservation.cards[input.cardId];
      if (!card) throw kanbanError("KANBAN_REFERENCE_INVALID", "CardRunLink.cardId 不存在");
      this.#assertProposedRunBinding(run, card, input);
      if (Object.values(reservation.cardRunLinks).some((link) => link.runId === input.runId)) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "Run 已链接到其他 Card");
      }
      if (input.retryOf !== null) {
        const prior = Object.values(reservation.cardRunLinks)
          .find((link) => link.runId === input.retryOf);
        if (!prior || prior.cardId !== card.id) {
          throw kanbanError("KANBAN_REFERENCE_INVALID", "retryOf 未链接到同一 Card");
        }
      }
      const candidate = clone(reservation);
      const link = normalizeCardRunLink({
        id: this.#newId(candidate.cardRunLinks),
        cardId: input.cardId,
        runId: input.runId,
        retryOf: input.retryOf,
        createdAt: input.createdAt,
      });
      candidate.cardRunLinks[link.id] = link;
      const operation = {
        operationId: input.operationId,
        kind: "link_card_run",
        fingerprint: fingerprintOperation("link_card_run", input),
        createdAt: input.createdAt,
        resultType: "cardRunLink",
        resultId: link.id,
        result: clone(link),
      };
      candidate.operations[input.operationId] = normalizeOperation({
        ...operation,
        integrity: operationIntegrity(operation),
      });
      candidate.revision += 1;
      const validatedCandidate = this.#validateWriteCandidate(candidate, run).validated;
      this.#assertMutationFence(reservationFence, "KANBAN_PREPARED_STALE");

      if (reservation !== beforeReservation) {
        this.container = this.#write(reservation, {
          fence: reservationFence,
          staleCode: "KANBAN_PREPARED_STALE",
        });
      }
      const preparedFence = this.#captureMutationFence();
      const token = Object.freeze({});
      this.preparedCardRunLink = {
        token,
        baseContainer: preparedFence.container,
        baseRevision: preparedFence.revision,
        baseGeneration: preparedFence.generation,
        fingerprint: fingerprintOperation("link_card_run", input),
        candidate: validatedCandidate,
        proposedRun: clone(run),
      };
      return token;
    } catch (error) {
      if (!this.commitUncertain && this.mutationGeneration === beforeGeneration) {
        this.container = beforeReservation;
      }
      throw error;
    }
  }

  #reserveOperationWindow(createdAt) {
    this.#assertOpen();
    if (!validTimestamp(createdAt)) {
      throw kanbanError("KANBAN_TIMESTAMP_INVALID", "operation createdAt 无效");
    }
    const time = this.#currentTime();
    const trustedTime = Math.max(this.container.clockHighWaterMs, time);
    const floor = Math.max(
      this.container.idempotencyFloorMs,
      Math.max(0, trustedTime - IDEMPOTENCY_WINDOW_MS),
    );
    if (createdAt > trustedTime + MAX_OPERATION_FUTURE_SKEW_MS) {
      throw kanbanError("KANBAN_TIMESTAMP_INVALID", "operation createdAt 超出未来时钟偏差");
    }
    if (createdAt <= floor) {
      throw kanbanError("KANBAN_OPERATION_EXPIRED", "operation 已超出 30 天幂等窗口");
    }
    this.#assertCapacity(this.container, "operations");
    this.#assertCapacity(this.container, "cardRunLinks");
    const beforeReservation = this.container;
    const beforeGeneration = this.mutationGeneration;
    const reservationFence = this.#captureMutationFence();
    try {
      // 入队前持久 Store 自己观察到的时钟，crash 后不依赖可回拨的系统时钟。
      const candidate = this.#windowCandidate(time, true);
      if (candidate !== beforeReservation) {
        this.container = this.#write(candidate, { fence: reservationFence });
      }
      return this.container.clockHighWaterMs;
    } catch (error) {
      if (!this.commitUncertain && this.mutationGeneration === beforeGeneration) {
        this.container = beforeReservation;
      }
      throw error;
    }
  }

  trustedRepairTimestamp() {
    this.#assertOpen();
    return Math.max(this.container.clockHighWaterMs, this.#currentTime());
  }

  createBoard(input) {
    this.#assertMutationBase(input, [
      "operationId", "profileId", "slug", "name", "description", "createdAt",
    ]);
    if (!validOpaqueId(input.profileId) || !SLUG_PATTERN.test(input.slug)
      || !validText(input.name, 512) || !validText(input.description, 16 * 1024, true, true)) {
      throw kanbanError("KANBAN_BOARD_INVALID", "createBoard 输入无效");
    }
    return this.#mutate("create_board", input, (candidate) => {
      if (!this.#profileExists(input.profileId)) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "Board.profileId 不存在");
      }
      if (Object.values(candidate.boards).some((board) => board.slug === input.slug)) {
        throw kanbanError("KANBAN_BOARD_CONFLICT", "Board slug 已存在");
      }
      this.#assertCapacity(candidate, "boards");
      const board = normalizeBoard({
        id: this.#newId(candidate.boards),
        profileId: input.profileId,
        slug: input.slug,
        name: input.name,
        description: input.description,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
      candidate.boards[board.id] = board;
      return { resultType: "board", resultId: board.id };
    });
  }

  updateBoard(input) {
    this.#assertMutationBase(input, ["operationId", "boardId", "patch", "createdAt"]);
    if (!UUID_PATTERN.test(input.boardId)
      || !this.#validPatch(input.patch, ["name", "description"])
      || (own(input.patch, "name") && !validText(input.patch.name, 512))
      || (own(input.patch, "description") && !validText(input.patch.description, 16 * 1024, true, true))) {
      throw kanbanError("KANBAN_BOARD_INVALID", "updateBoard 输入无效");
    }
    return this.#mutate("update_board", input, (candidate) => {
      const board = candidate.boards[input.boardId];
      if (!board) throw kanbanError("KANBAN_BOARD_NOT_FOUND", "Board 不存在");
      candidate.boards[board.id] = normalizeBoard({
        ...board,
        ...input.patch,
        updatedAt: Math.max(board.updatedAt, input.createdAt),
      });
      return { resultType: "board", resultId: board.id };
    });
  }

  getBoard(boardId) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(boardId)) throw kanbanError("KANBAN_BOARD_INVALID", "boardId 无效");
    return clone(this.container.boards[boardId] || null);
  }

  listBoards() {
    this.#assertOpen();
    return this.#sorted(this.container.boards);
  }

  purgeProfile(profileId) {
    this.#assertOpen();
    if (!validOpaqueId(profileId)) throw kanbanError("KANBAN_BOARD_INVALID", "Profile 无效");
    const boardIds = new Set(Object.values(this.container.boards)
      .filter((board) => board.profileId === profileId).map((board) => board.id));
    const cardIds = new Set(Object.values(this.container.cards)
      .filter((card) => card.profileId === profileId || boardIds.has(card.boardId)).map((card) => card.id));
    const belongs = (record) => record && (record.profileId === profileId
      || boardIds.has(record.id) || boardIds.has(record.boardId)
      || cardIds.has(record.id) || cardIds.has(record.cardId));
    const candidate = { ...this.container, revision: this.container.revision + 1 };
    for (const field of ["boards", "cards", "comments", "attachments", "artifacts", "cardRunLinks", "auditEvents"]) {
      candidate[field] = Object.fromEntries(Object.entries(this.container[field])
        .filter(([, record]) => !belongs(record)));
    }
    candidate.operations = Object.fromEntries(Object.entries(this.container.operations)
      .filter(([, operation]) => !belongs(operation.result)));
    this.container = this.#write(candidate);
  }

  createCard(input) {
    this.#assertMutationBase(input, [
      "operationId", "boardId", "profileId", "title", "body", "status", "position", "createdAt",
    ]);
    if (!UUID_PATTERN.test(input.boardId) || !validOpaqueId(input.profileId)
      || !validText(input.title, 2048) || !validText(input.body, 1024 * 1024, true, true)
      || !["triage", "backlog"].includes(input.status) || !validPosition(input.position)) {
      throw kanbanError("KANBAN_CARD_INVALID", "createCard 输入无效");
    }
    return this.#mutate("create_card", input, (candidate) => {
      const board = candidate.boards[input.boardId];
      if (!board || board.profileId !== input.profileId || !this.#profileExists(input.profileId)) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "Card 的 Profile/Board 引用无效");
      }
      this.#assertCapacity(candidate, "cards");
      const card = normalizeCard({
        id: this.#newId(candidate.cards),
        boardId: input.boardId,
        profileId: input.profileId,
        title: input.title,
        body: input.body,
        status: input.status,
        position: input.position,
        archivedAt: null,
        completionRequest: null,
        completion: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
      candidate.cards[card.id] = card;
      return { resultType: "card", resultId: card.id };
    });
  }

  updateCard(input) {
    this.#assertMutationBase(input, ["operationId", "cardId", "patch", "createdAt"]);
    if (!UUID_PATTERN.test(input.cardId)
      || !this.#validPatch(input.patch, ["title", "body", "position"])
      || (own(input.patch, "title") && !validText(input.patch.title, 2048))
      || (own(input.patch, "body") && !validText(input.patch.body, 1024 * 1024, true, true))
      || (own(input.patch, "position") && !validPosition(input.patch.position))) {
      throw kanbanError("KANBAN_CARD_INVALID", "updateCard 输入无效");
    }
    return this.#mutate("update_card", input, (candidate) => {
      const card = candidate.cards[input.cardId];
      if (!card) throw kanbanError("KANBAN_CARD_NOT_FOUND", "Card 不存在");
      candidate.cards[card.id] = normalizeCard({
        ...card,
        ...input.patch,
        updatedAt: Math.max(card.updatedAt, input.createdAt),
      });
      return { resultType: "card", resultId: card.id };
    });
  }

  getCard(cardId) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(cardId)) throw kanbanError("KANBAN_CARD_INVALID", "cardId 无效");
    return clone(this.container.cards[cardId] || null);
  }

  listCards(query = {}) {
    this.#assertOpen();
    if (!exactObject(query, own(query, "boardId") ? ["boardId"] : [])
      || (query.boardId !== undefined && !UUID_PATTERN.test(query.boardId))) {
      throw kanbanError("KANBAN_CARD_INVALID", "Card 查询无效");
    }
    return this.#sorted(this.container.cards)
      .filter((card) => query.boardId === undefined || card.boardId === query.boardId);
  }

  setCardStatus(input) {
    this.#assertMutationBase(input, [
      "operationId", "cardId", "status", "actor", "actorId", "createdAt",
    ]);
    if (!UUID_PATTERN.test(input.cardId) || !CARD_STATUSES.has(input.status) || input.status === "done"
      || !["human", "product"].includes(input.actor) || !validOpaqueId(input.actorId)) {
      throw kanbanError("KANBAN_CARD_INVALID", "setCardStatus 输入无效");
    }
    return this.#mutate("set_card_status", input, (candidate) => {
      const card = candidate.cards[input.cardId];
      if (!card) throw kanbanError("KANBAN_CARD_NOT_FOUND", "Card 不存在");
      if (card.archivedAt !== null) {
        throw kanbanError("KANBAN_STATUS_TRANSITION_INVALID", "归档 Card 必须先取消归档");
      }
      if (card.status !== input.status && !LEGAL_STATUS_TRANSITIONS[card.status].has(input.status)) {
        throw kanbanError("KANBAN_STATUS_TRANSITION_INVALID", "Card 状态迁移非法");
      }
      candidate.cards[card.id] = normalizeCard({
        ...card,
        status: input.status,
        completionRequest: ["running", "review", "waiting"].includes(input.status)
          ? card.completionRequest : null,
        updatedAt: Math.max(card.updatedAt, input.createdAt),
      });
      return { resultType: "card", resultId: card.id };
    });
  }

  setCardArchived(input) {
    this.#assertMutationBase(input, [
      "operationId", "cardId", "archived", "actor", "actorId", "createdAt",
    ]);
    if (!UUID_PATTERN.test(input.cardId) || typeof input.archived !== "boolean"
      || !["human", "product"].includes(input.actor) || !validOpaqueId(input.actorId)) {
      throw kanbanError("KANBAN_CARD_INVALID", "setCardArchived 输入无效");
    }
    return this.#mutate("set_card_archived", input, (candidate) => {
      const card = candidate.cards[input.cardId];
      if (!card) throw kanbanError("KANBAN_CARD_NOT_FOUND", "Card 不存在");
      if (input.archived && ["queued", "running", "waiting"].includes(card.status)) {
        throw kanbanError("KANBAN_STATUS_TRANSITION_INVALID", "活动 Card 不能归档");
      }
      const archivedAt = input.archived ? input.createdAt : null;
      candidate.cards[card.id] = normalizeCard({
        ...card,
        archivedAt,
        updatedAt: Math.max(card.updatedAt, input.createdAt),
      });
      return { resultType: "card", resultId: card.id };
    });
  }

  requestCardCompletion(input) {
    this.#assertMutationBase(input, ["operationId", "cardId", "runId", "createdAt"]);
    if (!UUID_PATTERN.test(input.cardId) || !validOpaqueId(input.runId)) {
      throw kanbanError("KANBAN_CARD_INVALID", "requestCardCompletion 输入无效");
    }
    return this.#mutate("request_card_completion", input, (candidate) => {
      const card = candidate.cards[input.cardId];
      if (!card) throw kanbanError("KANBAN_CARD_NOT_FOUND", "Card 不存在");
      if (card.archivedAt !== null) {
        throw kanbanError("KANBAN_STATUS_TRANSITION_INVALID", "归档 Card 不能请求完成");
      }
      if (!["running", "waiting"].includes(card.status)
        || !this.#hasLinkedRun(candidate, card.id, input.runId)
        || this.#latestLinkedRunId(candidate, card.id) !== input.runId) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "完成请求未引用当前 Card 的活动 Run");
      }
      const run = this.#resolveRun(input.runId);
      if (!["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(run.status)) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "完成请求未引用活动 WorkRun");
      }
      candidate.cards[card.id] = normalizeCard({
        ...card,
        completionRequest: { runId: input.runId, requestedAt: input.createdAt },
        updatedAt: Math.max(card.updatedAt, input.createdAt),
      });
      return { resultType: "card", resultId: card.id };
    });
  }

  // done 的两个可信入口按调用方能力分开，避免把可伪造的 actor 字段当授权依据。
  completeCardByProduct(input) {
    this.#assertMutationBase(input, [
      "operationId", "cardId", "actorId", "runId", "createdAt",
    ]);
    if (!UUID_PATTERN.test(input.cardId) || !validOpaqueId(input.actorId)
      || !validOpaqueId(input.runId)) {
      throw kanbanError("KANBAN_CARD_INVALID", "completeCardByProduct 输入无效");
    }
    return this.#mutate("complete_card_by_product", input, (candidate) => {
      const card = candidate.cards[input.cardId];
      if (!card) throw kanbanError("KANBAN_CARD_NOT_FOUND", "Card 不存在");
      if (card.archivedAt !== null) {
        throw kanbanError("KANBAN_STATUS_TRANSITION_INVALID", "归档 Card 不能完成");
      }
      if (!["running", "waiting"].includes(card.status)) {
        throw kanbanError("KANBAN_STATUS_TRANSITION_INVALID", "Card 当前状态不能由 Run 完成");
      }
      if (card.completionRequest?.runId !== input.runId
        || !this.#hasLinkedRun(candidate, card.id, input.runId)
        || this.#latestLinkedRunId(candidate, card.id) !== input.runId) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "Product 完成未引用 Agent completion request");
      }
      const run = this.#resolveRun(input.runId);
      if (run.status !== "completed") {
        throw kanbanError("KANBAN_RUN_NOT_COMPLETED", "WorkRun 尚未完成");
      }
      candidate.cards[card.id] = normalizeCard({
        ...card,
        status: "done",
        completion: {
          mode: "run", runId: input.runId, actorId: input.actorId, at: input.createdAt,
        },
        updatedAt: Math.max(card.updatedAt, input.createdAt),
      });
      return { resultType: "card", resultId: card.id };
    });
  }

  completeCardManually(input) {
    this.#assertMutationBase(input, [
      "operationId", "cardId", "actorId", "note", "createdAt",
    ]);
    if (!UUID_PATTERN.test(input.cardId) || !validOpaqueId(input.actorId)
      || !validText(input.note, 4096, true, true)) {
      throw kanbanError("KANBAN_CARD_INVALID", "completeCardManually 输入无效");
    }
    return this.#mutate("complete_card_manually", input, (candidate) => {
      const card = candidate.cards[input.cardId];
      if (!card) throw kanbanError("KANBAN_CARD_NOT_FOUND", "Card 不存在");
      if (card.archivedAt !== null) {
        throw kanbanError("KANBAN_STATUS_TRANSITION_INVALID", "归档 Card 不能完成");
      }
      if (card.status === "done") throw kanbanError("KANBAN_STATUS_TRANSITION_INVALID", "Card 已完成");
      this.#assertCapacity(candidate, "auditEvents");
      const audit = normalizeAudit({
        id: this.#newId(candidate.auditEvents),
        cardId: card.id,
        kind: "manual_completion",
        actorId: input.actorId,
        runId: null,
        note: input.note,
        createdAt: input.createdAt,
      });
      candidate.auditEvents[audit.id] = audit;
      candidate.cards[card.id] = normalizeCard({
        ...card,
        status: "done",
        completion: {
          mode: "manual", runId: null, actorId: input.actorId, at: input.createdAt, note: input.note,
        },
        updatedAt: Math.max(card.updatedAt, input.createdAt),
      });
      return { resultType: "card", resultId: card.id };
    });
  }

  addComment(input) {
    this.#assertMutationBase(input, [
      "operationId", "cardId", "authorType", "authorId", "body", "createdAt",
    ]);
    try { normalizeComment(this.#entityCandidate(input, COMMENT_FIELDS)); } catch {
      throw kanbanError("KANBAN_COMMENT_INVALID", "addComment 输入无效");
    }
    return this.#mutate("add_comment", input, (candidate) => {
      if (!candidate.cards[input.cardId]) throw kanbanError("KANBAN_REFERENCE_INVALID", "Comment.cardId 不存在");
      this.#assertCapacity(candidate, "comments");
      const comment = normalizeComment(this.#entityCandidate(
        input, COMMENT_FIELDS, this.#newId(candidate.comments),
      ));
      candidate.comments[comment.id] = comment;
      return { resultType: "comment", resultId: comment.id };
    });
  }

  getComment(commentId) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(commentId)) {
      throw kanbanError("KANBAN_COMMENT_INVALID", "commentId 无效");
    }
    return clone(this.container.comments[commentId] || null);
  }

  listComments(cardId) { return this.#listForCard("comments", cardId); }

  addAttachment(input) {
    this.#assertMutationBase(input, [
      "operationId", "cardId", "name", "mimeType", "sizeBytes", "sha256", "storageKey", "createdAt",
    ]);
    this.#validateEntityInput(input, ATTACHMENT_FIELDS, normalizeAttachment, "KANBAN_ATTACHMENT_INVALID");
    return this.#mutate("add_attachment", input, (candidate) => {
      if (!candidate.cards[input.cardId]) throw kanbanError("KANBAN_REFERENCE_INVALID", "Attachment.cardId 不存在");
      this.#assertCapacity(candidate, "attachments");
      const attachment = normalizeAttachment(this.#entityCandidate(
        input, ATTACHMENT_FIELDS, this.#newId(candidate.attachments),
      ));
      candidate.attachments[attachment.id] = attachment;
      return { resultType: "attachment", resultId: attachment.id };
    });
  }

  listAttachments(cardId) { return this.#listForCard("attachments", cardId); }

  addArtifact(input) {
    this.#assertMutationBase(input, [
      "operationId", "cardId", "runId", "name", "kind", "mimeType", "sizeBytes", "sha256",
      "storageKey", "createdAt",
    ]);
    this.#validateEntityInput(input, ARTIFACT_FIELDS, normalizeArtifact, "KANBAN_ARTIFACT_INVALID");
    return this.#mutate("add_artifact", input, (candidate) => {
      if (!candidate.cards[input.cardId]
        || !this.#hasLinkedRun(candidate, input.cardId, input.runId)) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "Artifact 的 Card/Run 引用无效");
      }
      this.#assertCapacity(candidate, "artifacts");
      const artifact = normalizeArtifact(this.#entityCandidate(
        input, ARTIFACT_FIELDS, this.#newId(candidate.artifacts),
      ));
      candidate.artifacts[artifact.id] = artifact;
      return { resultType: "artifact", resultId: artifact.id };
    });
  }

  listArtifacts(cardId) { return this.#listForCard("artifacts", cardId); }

  linkCardRun(input, prepared = undefined) {
    this.#assertCardRunLinkInput(input);
    if (prepared !== undefined) return this.#commitPreparedCardRunLink(input, prepared);
    return this.#mutate("link_card_run", input, (candidate) => {
      const card = candidate.cards[input.cardId];
      if (!card) throw kanbanError("KANBAN_REFERENCE_INVALID", "CardRunLink.cardId 不存在");
      if (Object.values(candidate.cardRunLinks).some((link) => link.runId === input.runId)) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "Run 已链接到其他 Card");
      }
      const run = this.#resolveRun(input.runId);
      if (run.source !== "kanban" || run.sourceId !== card.id || run.profileId !== card.profileId
        || (run.retryOf ?? null) !== input.retryOf) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "WorkRun 与 CardRunLink 不匹配");
      }
      if (input.retryOf !== null) {
        const prior = Object.values(candidate.cardRunLinks)
          .find((link) => link.runId === input.retryOf);
        if (!prior || prior.cardId !== card.id) {
          throw kanbanError("KANBAN_REFERENCE_INVALID", "retryOf 未链接到同一 Card");
        }
      }
      this.#assertCapacity(candidate, "cardRunLinks");
      const link = normalizeCardRunLink({
        id: this.#newId(candidate.cardRunLinks),
        cardId: input.cardId,
        runId: input.runId,
        retryOf: input.retryOf,
        createdAt: input.createdAt,
      });
      candidate.cardRunLinks[link.id] = link;
      return { resultType: "cardRunLink", resultId: link.id };
    });
  }

  #assertCardRunLinkInput(input) {
    this.#assertMutationBase(input, ["operationId", "cardId", "runId", "retryOf", "createdAt"]);
    if (!UUID_PATTERN.test(input.cardId) || !validOpaqueId(input.runId)
      || !(input.retryOf === null || validOpaqueId(input.retryOf)) || input.retryOf === input.runId) {
      throw kanbanError("KANBAN_CARD_RUN_LINK_INVALID", "linkCardRun 输入无效");
    }
  }

  #normalizeProposedRun(value, input) {
    assertNoSensitive(value, this.isSensitiveValue);
    if (!exactObject(value, PROPOSED_WORK_RUN_FIELDS)
      || !validOpaqueId(value.id) || value.source !== "kanban"
      || !UUID_PATTERN.test(value.sourceId) || !validText(value.idempotencyKey, 1024)
      || !validOpaqueId(value.profileId)
      || !(value.workspace === null || validText(value.workspace, 4096))
      || !(value.retryOf === null || validOpaqueId(value.retryOf))
      || value.id !== input.runId) {
      throw kanbanError("KANBAN_CARD_RUN_PREFLIGHT_INVALID", "CardRunLink proposed WorkRun 无效");
    }
    let existing;
    try { existing = this.getRun(value.id); } catch {
      throw kanbanError("KANBAN_REFERENCE_CHECK_FAILED", "Run 引用校验失败");
    }
    if (existing !== null && existing !== undefined) {
      throw kanbanError("KANBAN_REFERENCE_INVALID", "proposed WorkRun id 已存在");
    }
    return Object.fromEntries(PROPOSED_WORK_RUN_FIELDS.map((field) => [field, value[field]]));
  }

  #assertProposedRunBinding(run, card, input) {
    if (run.sourceId !== card.id || run.profileId !== card.profileId
      || run.retryOf !== input.retryOf) {
      throw kanbanError("KANBAN_REFERENCE_INVALID", "proposed WorkRun 与 CardRunLink 不匹配");
    }
  }

  #commitPreparedCardRunLink(input, token) {
    const prepared = this.preparedCardRunLink;
    this.preparedCardRunLink = null;
    if (!prepared || prepared.token !== token
      || prepared.fingerprint !== fingerprintOperation("link_card_run", input)) {
      throw kanbanError("KANBAN_PREPARED_STALE", "CardRunLink prepared candidate 已失效");
    }
    const fence = {
      container: prepared.baseContainer,
      revision: prepared.baseRevision,
      generation: prepared.baseGeneration,
    };
    this.#assertMutationFence(fence, "KANBAN_PREPARED_STALE");
    const actualRun = this.#resolveRun(input.runId);
    this.#assertMutationFence(fence, "KANBAN_PREPARED_STALE");
    if (PROPOSED_WORK_RUN_FIELDS.some(
      (field) => !own(actualRun, field) || actualRun[field] !== prepared.proposedRun[field],
    )) {
      throw kanbanError("KANBAN_REFERENCE_INVALID", "入队 WorkRun 与 CardRunLink preflight 不匹配");
    }
    this.#assertMutationFence(fence, "KANBAN_PREPARED_STALE");
    this.container = this.#write(prepared.candidate, {
      fence,
      staleCode: "KANBAN_PREPARED_STALE",
    });
    return this.#operationResult(this.container.operations[input.operationId]);
  }

  listCardRunLinks(cardId) { return this.#listForCard("cardRunLinks", cardId); }

  getCardRunLinkByRunId(runId) {
    this.#assertOpen();
    if (!validOpaqueId(runId)) throw kanbanError("KANBAN_CARD_RUN_LINK_INVALID", "runId 无效");
    return clone(Object.values(this.container.cardRunLinks).find((link) => link.runId === runId) || null);
  }

  listAuditEvents(cardId) { return this.#listForCard("auditEvents", cardId); }

  #assertMutationBase(input, fields) {
    this.#assertOpen();
    assertNoSensitive(input, this.isSensitiveValue);
    if (!exactObject(input, fields) || !validOpaqueId(input.operationId)
      || !validTimestamp(input.createdAt)) {
      throw kanbanError("KANBAN_OPERATION_INVALID", "Kanban operation 输入无效");
    }
  }

  #mutate(kind, input, apply) {
    const time = this.#currentTime();
    const beforeRefresh = this.container;
    const beforeGeneration = this.mutationGeneration;
    try {
      // 高水位只接受 Store 自己观察到的时钟；调用方 createdAt 无权推动它。
      this.#refreshWindow(time, false);
      if (input.createdAt > this.container.clockHighWaterMs + MAX_OPERATION_FUTURE_SKEW_MS) {
        throw kanbanError("KANBAN_TIMESTAMP_INVALID", "operation createdAt 超出未来时钟偏差");
      }
      const fingerprint = fingerprintOperation(kind, input);
      const existing = own(this.container.operations, input.operationId)
        ? this.container.operations[input.operationId] : null;
      if (existing) {
        if (existing.kind !== kind || existing.fingerprint !== fingerprint) {
          throw kanbanError("KANBAN_OPERATION_ID_CONFLICT", "operationId 已用于不同操作");
        }
        return this.#operationResult(existing);
      }
      if (input.createdAt <= this.container.idempotencyFloorMs) {
        throw kanbanError("KANBAN_OPERATION_EXPIRED", "operation 已超出 30 天幂等窗口");
      }
      this.#assertCapacity(this.container, "operations");
      // mutation 只改候选快照；原子提交确定成功后才替换内存状态，容量/校验失败均零部分写。
      const mutationFence = this.#captureMutationFence();
      const candidate = clone(this.container);
      const outcome = apply(candidate);
      const operation = {
        operationId: input.operationId,
        kind,
        fingerprint,
        createdAt: input.createdAt,
        resultType: outcome.resultType,
        resultId: outcome.resultId,
        result: clone(candidate[RESULT_MAPS[outcome.resultType]][outcome.resultId]),
      };
      candidate.operations[input.operationId] = normalizeOperation({
        ...operation,
        integrity: operationIntegrity(operation),
      });
      candidate.revision += 1;
      this.container = this.#write(candidate, { fence: mutationFence });
      return this.#operationResult(candidate.operations[input.operationId]);
    } catch (error) {
      // 非提交不确定失败不得让未落盘的时钟观察或 window 清理污染当前内存视图。
      // 若同步回调已完成另一次 durable mutation，必须保留其新状态。
      if (!this.commitUncertain && this.mutationGeneration === beforeGeneration) {
        this.container = beforeRefresh;
      }
      throw error;
    }
  }

  #operationResult(operation) {
    return clone(operation.result);
  }

  #listForCard(map, cardId) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(cardId)) throw kanbanError("KANBAN_CARD_INVALID", "cardId 无效");
    return this.#sorted(this.container[map]).filter((item) => item.cardId === cardId);
  }

  #sorted(value) {
    return Object.values(value).map(clone)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  #validPatch(value, allowed) {
    return value && typeof value === "object" && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length > 0
      && Object.keys(value).every((key) => allowed.includes(key));
  }

  #validateEntityInput(input, fields, normalize, code) {
    const candidate = this.#entityCandidate(input, fields);
    try { normalize(candidate); } catch { throw kanbanError(code, "实体输入无效"); }
  }

  #entityCandidate(input, fields, id = crypto.randomUUID()) {
    return Object.fromEntries(fields.map((field) => [field, field === "id" ? id : input[field]]));
  }

  #assertCapacity(candidate, key) {
    if (Object.keys(candidate[key]).length >= this.capacities[key]) {
      throw kanbanError("KANBAN_CAPACITY", `${key} 容量已满`);
    }
  }

  #profileExists(profileId) {
    try { return this.profileExists(profileId) === true; } catch {
      throw kanbanError("KANBAN_REFERENCE_CHECK_FAILED", "Profile 引用校验失败");
    }
  }

  #resolveRun(runId) {
    let run;
    try { run = this.getRun(runId); } catch {
      throw kanbanError("KANBAN_REFERENCE_CHECK_FAILED", "Run 引用校验失败");
    }
    if (!run || typeof run !== "object" || run.id !== runId) {
      throw kanbanError("KANBAN_REFERENCE_INVALID", "Run 不存在");
    }
    return run;
  }

  #hasLinkedRun(candidate, cardId, runId) {
    return Object.values(candidate.cardRunLinks)
      .some((link) => link.cardId === cardId && link.runId === runId);
  }

  #latestLinkedRunId(candidate, cardId) {
    let latest = null;
    for (const link of Object.values(candidate.cardRunLinks)) {
      if (link.cardId !== cardId) continue;
      if (latest === null || link.createdAt > latest.createdAt
        // 同毫秒创建的 retry 以持久化插入顺序为准；随机 UUID 不能代表先后关系。
        || link.createdAt === latest.createdAt) {
        latest = link;
      }
    }
    return latest?.runId ?? null;
  }

  #assertExternalReferences(candidate, proposedRun = null) {
    // 外部引用由 Service 注入的只读 resolver 核验，Store 因而不依赖 ProductStore 实现。
    for (const board of Object.values(candidate.boards)) {
      if (!this.#profileExists(board.profileId)) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "Board.profileId 不存在");
      }
    }
    for (const link of Object.values(candidate.cardRunLinks)) {
      const card = candidate.cards[link.cardId];
      const run = proposedRun?.id === link.runId ? proposedRun : this.#resolveRun(link.runId);
      if (run.source !== "kanban" || run.sourceId !== card.id || run.profileId !== card.profileId
        || (run.retryOf ?? null) !== link.retryOf) {
        throw kanbanError("KANBAN_REFERENCE_INVALID", "持久化 CardRunLink 引用失配");
      }
    }
  }

  #newId(map) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.randomUUID();
      if (UUID_PATTERN.test(id) && !own(map, id)) return id;
    }
    throw kanbanError("KANBAN_ID_CONFLICT", "无法生成唯一实体 ID");
  }

  #currentTime() {
    const value = this.now();
    if (!validTimestamp(value) || value > Number.MAX_SAFE_INTEGER - MAX_OPERATION_FUTURE_SKEW_MS) {
      throw kanbanError("KANBAN_TIMESTAMP_INVALID", "本地时钟无效");
    }
    return value;
  }

  #assertOperationTimestamp(createdAt, container) {
    if (createdAt > container.clockHighWaterMs + MAX_OPERATION_FUTURE_SKEW_MS) {
      throw kanbanError("KANBAN_TIMESTAMP_INVALID", "operation createdAt 超出未来时钟偏差");
    }
    if (createdAt <= container.idempotencyFloorMs) {
      throw kanbanError("KANBAN_OPERATION_EXPIRED", "operation 已超出 30 天幂等窗口");
    }
  }

  #windowCandidate(time, persist) {
    const clockHighWaterMs = Math.max(this.container.clockHighWaterMs, time);
    const floor = Math.max(
      this.container.idempotencyFloorMs,
      Math.max(0, clockHighWaterMs - IDEMPOTENCY_WINDOW_MS),
    );
    const operations = Object.fromEntries(Object.entries(this.container.operations)
      .filter(([, operation]) => operation.createdAt >= floor));
    if (clockHighWaterMs === this.container.clockHighWaterMs
      && floor === this.container.idempotencyFloorMs
      && Object.keys(operations).length === Object.keys(this.container.operations).length) {
      return this.container;
    }
    return {
      ...this.container,
      revision: persist ? this.container.revision + 1 : this.container.revision,
      clockHighWaterMs,
      idempotencyFloorMs: floor,
      operations,
    };
  }

  #refreshWindow(time, persist = true) {
    const candidate = this.#windowCandidate(time, persist);
    if (candidate === this.container) return;
    this.container = persist ? this.#write(candidate) : validateContainer(candidate);
  }

  #parse(bytes, trustedTime) {
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      if (value?.version === LEGACY_NATIVE_KANBAN_STORE_VERSION) {
        return { container: migrateV1Container(value, trustedTime), migrated: true };
      }
      if (value?.version === PREVIOUS_NATIVE_KANBAN_STORE_VERSION) {
        return { container: migrateV3Container(value), migrated: true };
      }
      if (value?.version === INTEGRITY_NATIVE_KANBAN_STORE_VERSION) {
        return { container: migrateV2Container(value), migrated: true };
      }
      return { container: validateContainer(value), migrated: false };
    } catch (error) {
      if (error?.code === "KANBAN_STORE_CORRUPT") throw error;
      if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      throw kanbanError("KANBAN_STORE_CORRUPT", "Native Kanban 容器损坏");
    }
  }

  #validateWriteCandidate(candidate, proposedRun = null) {
    const validated = validateContainer(candidate);
    this.#assertExternalReferences(validated, proposedRun);
    assertNoSensitive(validated, this.isSensitiveValue);
    const serialized = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_NATIVE_KANBAN_STORE_BYTES) {
      throw kanbanError("KANBAN_CAPACITY", "Native Kanban 文件容量已满");
    }
    return { validated, serialized };
  }

  #captureMutationFence() {
    return Object.freeze({
      container: this.container,
      revision: this.container.revision,
      generation: this.mutationGeneration,
    });
  }

  #assertMutationFence(fence, code = "KANBAN_MUTATION_STALE") {
    if (this.commitUncertain) {
      throw kanbanError("KANBAN_COMMIT_UNCERTAIN", "Native Kanban 提交状态不确定，必须重新打开");
    }
    if (!fence || this.container !== fence.container
      || this.container.revision !== fence.revision
      || this.mutationGeneration !== fence.generation) {
      throw kanbanError(code, "Native Kanban mutation candidate 已失效");
    }
  }

  #write(candidate, options = {}) {
    const fence = options.fence || null;
    const staleCode = options.staleCode || "KANBAN_MUTATION_STALE";
    if (fence) this.#assertMutationFence(fence, staleCode);
    const { validated, serialized } = this.#validateWriteCandidate(candidate);
    // resolver / secret matcher 都可能是同步外部回调；原子写前最后一刻重查 fence。
    if (fence) this.#assertMutationFence(fence, staleCode);
    try {
      this.atomicWrite(this.filePath, serialized, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (error?.committed === true) {
        this.mutationGeneration += 1;
        return validated;
      }
      if (error?.committedUncertain === true) {
        this.commitUncertain = true;
        this.mutationGeneration += 1;
        this.container = this.#emptyContainer();
        const uncertain = kanbanError(
          "KANBAN_COMMIT_UNCERTAIN", "Native Kanban 提交状态不确定，必须重新打开",
        );
        uncertain.committedUncertain = true;
        throw uncertain;
      }
      if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      throw kanbanError("KANBAN_WRITE_FAILED", "Native Kanban 写入失败");
    }
    this.mutationGeneration += 1;
    return validated;
  }

  #emptyContainer() {
    return {
      version: NATIVE_KANBAN_STORE_VERSION,
      revision: 0,
      clockHighWaterMs: 0,
      idempotencyFloorMs: 0,
      boards: {},
      cards: {},
      comments: {},
      attachments: {},
      artifacts: {},
      cardRunLinks: {},
      auditEvents: {},
      operations: {},
    };
  }

  #assertOpen() {
    if (this.commitUncertain) {
      throw kanbanError("KANBAN_COMMIT_UNCERTAIN", "Native Kanban 提交状态不确定，必须重新打开");
    }
    if (!this.opened) throw kanbanError("KANBAN_STORE_CLOSED", "NativeKanbanStore 未打开");
  }
}

module.exports = {
  CARD_STATUSES,
  DEFAULT_CAPACITIES,
  IDEMPOTENCY_WINDOW_MS,
  LEGACY_NATIVE_KANBAN_STORE_VERSION,
  LEGAL_STATUS_TRANSITIONS,
  MAX_NATIVE_KANBAN_STORE_BYTES,
  MAX_OPERATION_FUTURE_SKEW_MS,
  NATIVE_KANBAN_STORE_VERSION,
  PREVIOUS_NATIVE_KANBAN_STORE_VERSION,
  NativeKanbanStore,
  fingerprintOperation,
  validateContainer,
};
