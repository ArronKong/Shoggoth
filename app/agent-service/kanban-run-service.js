"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { canonicalWorkspace } = require("./work-run");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ACTIVE_RUN_STATUSES = new Set([
  "starting", "running", "waiting_approval", "waiting_input",
]);
const TERMINAL_RUN_STATUSES = new Set([
  "completed", "failed", "canceled", "interrupted", "skipped",
]);
const MAX_RUN_ERROR_RECORDS = 64;
const MAX_FATAL_ERROR_PROTOTYPE_DEPTH = 16;
const CANONICAL_COMMIT_UNCERTAIN_CODES = new Set([
  "STORE_COMMIT_UNCERTAIN",
  "KANBAN_COMMIT_UNCERTAIN",
  "PENDING_COMMAND_COMMIT_UNCERTAIN",
]);
const KANBAN_INTENT_PREFIX = "shoggoth:kanban:v2";
const KANBAN_INTENT_PATTERN = /^shoggoth:kanban:v2:([a-f0-9]{64}):([0-9]+):([a-f0-9]{64})$/u;
const RUN_STATUS_TO_CARD_STATUS = Object.freeze({
  queued: "queued",
  starting: "queued",
  running: "running",
  waiting_approval: "waiting",
  waiting_input: "waiting",
  failed: "failed",
  interrupted: "failed",
  canceled: "canceled",
  skipped: "canceled",
});
const DISPATCH_FIELDS = Object.freeze([
  "operationId", "cardId", "workspace", "createdAt",
]);
const RETRY_FIELDS = Object.freeze([
  "operationId", "cardId", "retryOf", "workspace", "createdAt",
]);
const COMPLETION_REQUEST_FIELDS = Object.freeze([
  "operationId", "cardId", "runId", "createdAt",
]);
const MANUAL_COMPLETION_FIELDS = Object.freeze([
  "operationId", "cardId", "actorId", "note", "createdAt",
]);

function kanbanServiceError(code, message) {
  return serviceError(code, message);
}

function probeDataProperty(target, property) {
  try {
    if ((typeof target !== "object" && typeof target !== "function") || target === null) {
      return { ok: true, found: false, value: undefined };
    }
    const seen = new Set();
    let cursor = target;
    for (let depth = 0; depth < MAX_FATAL_ERROR_PROTOTYPE_DEPTH; depth += 1) {
      if (seen.has(cursor)) return { ok: false, found: false, value: undefined };
      seen.add(cursor);
      const descriptor = Object.getOwnPropertyDescriptor(cursor, property);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          return { ok: false, found: true, value: undefined };
        }
        return { ok: true, found: true, value: descriptor.value };
      }
      cursor = Object.getPrototypeOf(cursor);
      if (cursor === null) return { ok: true, found: false, value: undefined };
    }
    return { ok: false, found: false, value: undefined };
  } catch {
    return { ok: false, found: false, value: undefined };
  }
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validOpaqueId(value, maxLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && OPAQUE_ID_PATTERN.test(value);
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function internalOperationId(kind, ...parts) {
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify([kind, ...parts]))
    .digest("hex");
  return `ks-${kind}-${digest}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function operationHash(operationId) {
  return sha256(operationId);
}

function intentFingerprint(intent) {
  return sha256(JSON.stringify([
    intent.cardId, intent.workspace, intent.retryOf, intent.createdAt,
  ]));
}

function workRunIdempotencyKey(operationId, intent) {
  return `${KANBAN_INTENT_PREFIX}:${operationHash(operationId)}:${intent.createdAt}:${intentFingerprint(intent)}`;
}

function parseWorkRunIntent(idempotencyKey) {
  if (typeof idempotencyKey !== "string") return null;
  const match = KANBAN_INTENT_PATTERN.exec(idempotencyKey);
  if (!match) return null;
  const createdAt = Number(match[2]);
  if (!validTimestamp(createdAt) || String(createdAt) !== match[2]) return null;
  return { operationHash: match[1], createdAt, fingerprint: match[3] };
}

function cardPrompt(card) {
  return card.body === null || card.body.length === 0
    ? card.title
    : `${card.title}\n\n${card.body}`;
}

class KanbanRunService {
  constructor(options = {}) {
    const dispatcher = options.dispatcher;
    const kanbanStore = options.kanbanStore;
    const executor = options.executor;
    if (!dispatcher || ["enqueue", "enqueueSkipped", "getRun", "listRuns", "transition"].some(
      (method) => typeof dispatcher[method] !== "function",
    )) {
      throw kanbanServiceError("KANBAN_DISPATCHER_REQUIRED", "KanbanRunService 需要 WorkDispatcher");
    }
    if (!kanbanStore || [
      "getCard", "listCardRunLinks", "getCardRunLinkByRunId", "linkCardRun",
      "setCardStatus", "requestCardCompletion", "completeCardByProduct",
      "completeCardManually", "preflightOperationTimestamp",
      "preflightDurableOperationTimestamp", "preflightCardRunLink", "trustedRepairTimestamp",
    ].every((method) => typeof kanbanStore[method] === "function") === false) {
      throw kanbanServiceError("KANBAN_STORE_REQUIRED", "KanbanRunService 需要 NativeKanbanStore");
    }
    if (!executor || typeof executor.schedule !== "function" || typeof executor.recover !== "function") {
      throw kanbanServiceError("KANBAN_EXECUTOR_REQUIRED", "KanbanRunService 需要 executor");
    }
    if (typeof options.resolveWorkspace !== "function") {
      throw kanbanServiceError("KANBAN_SERVICE_OPTIONS_INVALID", "resolveWorkspace 必须是函数");
    }
    if (typeof options.resolveTargetState !== "function") {
      throw kanbanServiceError("KANBAN_SERVICE_OPTIONS_INVALID", "resolveTargetState 必须是函数");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw kanbanServiceError("KANBAN_SERVICE_OPTIONS_INVALID", "now 必须是函数");
    }
    if (options.randomUUID !== undefined && typeof options.randomUUID !== "function") {
      throw kanbanServiceError("KANBAN_SERVICE_OPTIONS_INVALID", "randomUUID 必须是函数");
    }
    if (options.onFatalError !== undefined && typeof options.onFatalError !== "function") {
      throw kanbanServiceError("KANBAN_SERVICE_OPTIONS_INVALID", "onFatalError 必须是函数");
    }
    this.dispatcher = dispatcher;
    this.kanbanStore = kanbanStore;
    this.executor = executor;
    this.resolveWorkspace = options.resolveWorkspace;
    this.resolveTargetState = options.resolveTargetState;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.onFatalError = options.onFatalError || null;
    this.opened = false;
    this.generation = 0;
    this.operationNonce = crypto.randomBytes(16).toString("hex");
    this.operationSequence = 0;
    this.launchedRunIds = new Set();
    this.runTails = new Map();
    this.runErrors = new Map();
    this.poisonError = null;
  }

  open() {
    if (this.poisonError) throw this.poisonError;
    if (this.opened) return this;
    this.opened = true;
    this.generation += 1;
    try {
      const runs = this.dispatcher.listRuns({ source: "kanban" });
      this.#assertUniqueRootRuns(runs);
      this.#assertDurableRunIntents(runs);
      for (const run of runs) this.#ensureRunLink(run, this.kanbanStore.trustedRepairTimestamp());
      for (const run of runs) this.#reconcileRun(run.id);
      for (const original of runs) {
        let run = this.dispatcher.getRun(original.id);
        if (run?.status === "queued") run = this.#settleDisabledTarget(run);
        if (run?.status === "queued") this.#launch("schedule", run, true);
        else if (run && ACTIVE_RUN_STATUSES.has(run.status)) this.#launch("recover", run, true);
      }
      return this;
    } catch (error) {
      const failure = this.#fatalOrOriginal(error);
      if (this.opened) {
        this.opened = false;
        this.generation += 1;
      }
      throw failure;
    }
  }

  close() {
    if (!this.opened) {
      this.runErrors.clear();
      return;
    }
    // Service 生命周期关闭只阻止新的接管，不向 executor 发取消；UI 本身不持有该生命周期。
    this.opened = false;
    this.generation += 1;
    this.runErrors.clear();
  }

  dispatchCard(input) {
    this.#assertOpen();
    try {
      this.#assertDispatchInput(input, false);
      const card = this.#requireCard(input.cardId);
      const targetState = this.#targetState(card.profileId);
      this.kanbanStore.preflightOperationTimestamp(input.createdAt);
      const replay = this.#findRunByIntent(input.operationId, input, null, card.profileId);
      if (replay) return this.#resumeDispatch(replay, card, input.createdAt, false);
      const intent = this.#canonicalIntent(input, null, card.profileId);
      if (card.archivedAt !== null || card.status !== "backlog" || this.#latestRunForCard(card.id) !== null
        || this.kanbanStore.listCardRunLinks(card.id).length > 0) {
        throw kanbanServiceError(
          "KANBAN_CARD_NOT_DISPATCHABLE", "Card 已派发；失败或取消后请创建 retry WorkRun",
        );
      }
      const runId = this.#newRunId();
      const runInput = Object.freeze({
        id: runId,
        source: "kanban",
        sourceId: card.id,
        idempotencyKey: workRunIdempotencyKey(input.operationId, intent),
        profileId: card.profileId,
        workspace: intent.workspace,
        retryOf: null,
      });
      const linkInput = this.#runLinkInput(runId, card.id, null, intent.createdAt);
      const preparedLink = this.kanbanStore.preflightCardRunLink(linkInput, runInput);
      const run = targetState === "disabled"
        ? this.dispatcher.enqueueSkipped(runInput, "KANBAN_TARGET_DISABLED")
        : this.dispatcher.enqueue(runInput);
      return this.#resumeDispatch(run, card, input.createdAt, false, null, {
        input: linkInput, token: preparedLink,
      });
    } catch (error) {
      throw this.#fatalOrOriginal(error);
    }
  }

  retryCard(input) {
    this.#assertOpen();
    try {
      this.#assertDispatchInput(input, true);
      const card = this.#requireCard(input.cardId);
      const targetState = this.#targetState(card.profileId);
      this.kanbanStore.preflightOperationTimestamp(input.createdAt);
      const replay = this.#findRunByIntent(
        input.operationId, input, input.retryOf, card.profileId,
      );
      if (replay) return this.#resumeDispatch(replay, card, input.createdAt, false, input.retryOf);
      const intent = this.#canonicalIntent(input, input.retryOf, card.profileId);
      if (card.archivedAt !== null || !["failed", "canceled"].includes(card.status)) {
        throw kanbanServiceError("KANBAN_CARD_NOT_RETRYABLE", "只有失败或取消的 Card 可以重试");
      }
      const prior = this.dispatcher.getRun(input.retryOf);
      const latest = this.#latestRunForCard(card.id);
      const priorLink = this.kanbanStore.getCardRunLinkByRunId(input.retryOf);
      if (!prior || prior.source !== "kanban" || prior.sourceId !== card.id
        || prior.profileId !== card.profileId || latest?.id !== prior.id
        || priorLink?.cardId !== card.id || !TERMINAL_RUN_STATUSES.has(prior.status)) {
        throw kanbanServiceError("KANBAN_RETRY_REFERENCE_INVALID", "retryOf 不是 Card 的最新终态 WorkRun");
      }
      if (input.createdAt < priorLink.createdAt) {
        throw kanbanServiceError(
          "KANBAN_RETRY_TIMESTAMP_INVALID", "retry 的 createdAt 不能早于 prior CardRunLink",
        );
      }
      const runId = this.#newRunId();
      const runInput = Object.freeze({
        id: runId,
        source: "kanban",
        sourceId: card.id,
        idempotencyKey: workRunIdempotencyKey(input.operationId, intent),
        profileId: card.profileId,
        workspace: intent.workspace,
        retryOf: prior.id,
      });
      const linkCreatedAt = Math.max(intent.createdAt, priorLink.createdAt);
      const linkInput = this.#runLinkInput(runId, card.id, prior.id, linkCreatedAt);
      const preparedLink = this.kanbanStore.preflightCardRunLink(linkInput, runInput);
      const run = targetState === "disabled"
        ? this.dispatcher.enqueueSkipped(runInput, "KANBAN_TARGET_DISABLED")
        : this.dispatcher.enqueue(runInput);
      return this.#resumeDispatch(run, card, input.createdAt, false, prior.id, {
        input: linkInput, token: preparedLink,
      });
    } catch (error) {
      throw this.#fatalOrOriginal(error);
    }
  }

  reconcileRun(runId) {
    this.#assertOpen();
    if (!validOpaqueId(runId)) {
      throw kanbanServiceError("KANBAN_RUN_INVALID", "runId 无效");
    }
    try {
      return this.#reconcileRun(runId);
    } catch (error) {
      throw this.#fatalOrOriginal(error);
    }
  }

  requestCompletionFromAgent(input) {
    this.#assertOpen();
    if (!exactObject(input, COMPLETION_REQUEST_FIELDS) || !validOpaqueId(input.operationId)
      || !UUID_PATTERN.test(input.cardId) || !validOpaqueId(input.runId)
      || !validTimestamp(input.createdAt)) {
      throw kanbanServiceError("KANBAN_COMPLETION_REQUEST_INVALID", "Agent 完成请求无效");
    }
    try {
      const card = this.#requireCard(input.cardId);
      const run = this.#requireBoundRun(input.runId, card);
      if (this.#latestRunForCard(card.id)?.id !== run.id) {
        throw kanbanServiceError("KANBAN_COMPLETION_REQUEST_INVALID", "Agent 完成请求未引用最新 WorkRun");
      }
      return this.kanbanStore.requestCardCompletion(input);
    } catch (error) {
      throw this.#fatalOrOriginal(error);
    }
  }

  completeCardManually(input) {
    this.#assertOpen();
    if (!exactObject(input, MANUAL_COMPLETION_FIELDS) || !validOpaqueId(input.operationId)
      || !UUID_PATTERN.test(input.cardId) || !validOpaqueId(input.actorId)
      || !(input.note === null || (typeof input.note === "string" && !input.note.includes("\0")
        && Buffer.byteLength(input.note, "utf8") <= 4096))
      || !validTimestamp(input.createdAt)) {
      throw kanbanServiceError("KANBAN_MANUAL_COMPLETION_INVALID", "人工完成输入无效");
    }
    try {
      this.#requireCard(input.cardId);
      return this.kanbanStore.completeCardManually(input);
    } catch (error) {
      throw this.#fatalOrOriginal(error);
    }
  }

  async waitForIdle(runId) {
    this.#assertOpen();
    if (!validOpaqueId(runId)) throw kanbanServiceError("KANBAN_RUN_INVALID", "runId 无效");
    let tailFailed = false;
    while (true) {
      const tail = this.runTails.get(runId);
      if (!tail) break;
      try {
        await tail;
      } catch {
        tailFailed = true;
      }
      const current = this.runTails.get(runId);
      if (current && current !== tail) {
        tailFailed = false;
        continue;
      }
      if (current === tail) {
        await Promise.resolve();
        continue;
      }
      break;
    }
    if (this.poisonError) throw this.poisonError;
    const failure = this.runErrors.get(runId);
    if (failure) throw failure;
    if (tailFailed) {
      throw kanbanServiceError("KANBAN_EXECUTOR_FAILED", "Kanban executor 执行失败");
    }
    const run = this.dispatcher.getRun(runId);
    if (!run) throw kanbanServiceError("KANBAN_RUN_NOT_FOUND", "WorkRun 不存在");
    return run;
  }

  #assertDispatchInput(input, retry) {
    const fields = retry ? RETRY_FIELDS : DISPATCH_FIELDS;
    if (!exactObject(input, fields) || !validOpaqueId(input.operationId)
      || !UUID_PATTERN.test(input.cardId)
      || (retry && !validOpaqueId(input.retryOf))
      || !(input.workspace === null || (typeof input.workspace === "string"
        && input.workspace.trim().length > 0 && !input.workspace.includes("\0")))
      || !validTimestamp(input.createdAt)) {
      throw kanbanServiceError(
        retry ? "KANBAN_RETRY_INVALID" : "KANBAN_DISPATCH_INVALID",
        retry ? "Kanban retry 输入无效" : "Kanban dispatch 输入无效",
      );
    }
  }

  #resumeDispatch(run, card, createdAt, recovered, expectedRetryOf = null, preparedLink = null) {
    this.#assertRunIdentity(run, card, expectedRetryOf);
    const link = this.#ensureRunLink(run, createdAt, preparedLink);
    let projected = this.#reconcileRun(run.id);
    let currentRun = this.dispatcher.getRun(run.id);
    if (currentRun.status === "queued") {
      const settled = this.#settleDisabledTarget(currentRun);
      if (settled !== currentRun) projected = this.#requireCard(card.id);
      currentRun = settled;
    }
    if (currentRun.status === "queued") this.#launch("schedule", currentRun, recovered);
    else if (ACTIVE_RUN_STATUSES.has(currentRun.status)) this.#launch("recover", currentRun, recovered);
    return Object.freeze({ run: currentRun, card: projected, link });
  }

  #ensureRunLink(run, createdAt, preparedLink = null) {
    const card = this.#requireCard(run.sourceId);
    this.#assertRunIdentity(run, card, run.retryOf ?? null);
    const existing = this.kanbanStore.getCardRunLinkByRunId(run.id);
    if (existing) {
      if (existing.cardId !== card.id || existing.retryOf !== (run.retryOf ?? null)) {
        throw kanbanServiceError("KANBAN_RUN_LINK_CONFLICT", "WorkRun 的 CardRunLink 不匹配");
      }
      return existing;
    }
    const priorLink = run.retryOf === null || run.retryOf === undefined
      ? null : this.kanbanStore.getCardRunLinkByRunId(run.retryOf);
    if (run.retryOf !== null && run.retryOf !== undefined && !priorLink) {
      throw kanbanServiceError("KANBAN_RETRY_REFERENCE_INVALID", "retryOf 缺少 prior CardRunLink");
    }
    const linkCreatedAt = priorLink ? Math.max(createdAt, priorLink.createdAt) : createdAt;
    const linkInput = this.#runLinkInput(run.id, card.id, run.retryOf ?? null, linkCreatedAt);
    if (preparedLink) {
      if (JSON.stringify(preparedLink.input) !== JSON.stringify(linkInput)) {
        throw kanbanServiceError("KANBAN_RUN_LINK_CONFLICT", "CardRunLink preflight 输入不匹配");
      }
      return this.kanbanStore.linkCardRun(linkInput, preparedLink.token);
    }
    return this.kanbanStore.linkCardRun(linkInput);
  }

  #runLinkInput(runId, cardId, retryOf, createdAt) {
    return Object.freeze({
      operationId: internalOperationId("link", runId),
      cardId,
      runId,
      retryOf,
      createdAt,
    });
  }

  #reconcileRun(runId) {
    const run = this.dispatcher.getRun(runId);
    if (!run) throw kanbanServiceError("KANBAN_RUN_NOT_FOUND", "WorkRun 不存在");
    const card = this.#requireCard(run.sourceId);
    this.#assertRunIdentity(run, card, run.retryOf ?? null);
    const link = this.kanbanStore.getCardRunLinkByRunId(run.id);
    if (!link || link.cardId !== card.id || link.retryOf !== (run.retryOf ?? null)) {
      throw kanbanServiceError("KANBAN_RUN_LINK_MISSING", "WorkRun 缺少匹配的 CardRunLink");
    }
    if (card.status === "done" || this.#latestRunForCard(card.id)?.id !== run.id) {
      if (TERMINAL_RUN_STATUSES.has(run.status)) this.launchedRunIds.delete(run.id);
      return card;
    }
    if (run.status === "completed" && card.completionRequest?.runId === run.id) {
      const completed = this.#projectCardStatus(card, "review", run);
      this.launchedRunIds.delete(run.id);
      return completed;
    }
    const target = run.status === "completed" ? "waiting" : RUN_STATUS_TO_CARD_STATUS[run.status];
    if (!target) throw kanbanServiceError("KANBAN_RUN_STATUS_INVALID", "WorkRun 状态无法投影到 Card");
    const projected = this.#projectCardStatus(card, target, run);
    if (TERMINAL_RUN_STATUSES.has(run.status)) this.launchedRunIds.delete(run.id);
    return projected;
  }

  #projectCardStatus(original, target, run) {
    let card = original;
    if (card.status === target) return card;
    // 恢复可能落在 WorkRun 已提交而 Card 尚未写入的 crash cut；先补 queued 再走原生状态机。
    if (card.status === "running" && target === "queued") {
      card = this.#setCardStatus(card, "waiting", run, "bridge-waiting");
    }
    if (["backlog", "failed", "canceled"].includes(card.status)
      && !["queued", "canceled"].includes(target)) {
      card = this.#setCardStatus(card, "queued", run, "bridge-queued");
    }
    if (card.status !== target) card = this.#setCardStatus(card, target, run, "target");
    return card;
  }

  #setCardStatus(card, status, run, phase) {
    return this.kanbanStore.setCardStatus({
      // 同一 Run eventSeq 下 Card 仍可被人工合法移动；每次纠偏都是独立业务变更，不能 replay 旧快照。
      operationId: this.#nextOperationId("status", run.id, run.eventSeq, status, phase),
      cardId: card.id,
      status,
      actor: "product",
      actorId: "kanban-product-core",
      createdAt: this.kanbanStore.trustedRepairTimestamp(),
    });
  }

  #launch(method, run, recovered) {
    if (this.poisonError || this.launchedRunIds.has(run.id)) return;
    const card = this.#requireCard(run.sourceId);
    const generation = this.generation;
    this.launchedRunIds.add(run.id);
    this.runErrors.delete(run.id);
    const payload = Object.freeze({
      run,
      card,
      prompt: cardPrompt(card),
      recovered,
      onStateChange: () => this.reconcileRun(run.id),
    });
    let tail;
    tail = Promise.resolve().then(async () => {
      if (this.poisonError || !this.opened || generation !== this.generation) {
        if (this.#releaseOwnership(run.id, tail)) this.#handoffCurrentRun(run.id);
        return;
      }
      const currentRun = this.dispatcher.getRun(run.id);
      if (currentRun?.status === "queued"
        && this.#settleDisabledTarget(currentRun).status !== "queued") return;
      await this.executor[method](payload);
      if (this.poisonError) return;
      if (this.opened && generation === this.generation) this.#reconcileRun(run.id);
      else if (this.#releaseOwnership(run.id, tail)) this.#handoffCurrentRun(run.id);
    }).catch((error) => {
      const fatalCode = this.#fatalCode(error);
      let safeError = fatalCode ? this.#poison(fatalCode) : (this.poisonError || kanbanServiceError(
        "KANBAN_EXECUTOR_FAILED", "Kanban executor 执行失败",
      ));
      if (this.#releaseOwnership(run.id, tail)) {
        // close/open 会沿用尚未 settle 的旧 executor ownership；若它在新代打开后才失败，
        // open 的恢复扫描已经过去，必须由旧 tail 恰好触发一次新代接管。
        if (this.poisonError) {
          // durable uncertainty 对整个 Service 实例是 sticky 的，不能把旧 Run 交给新 generation。
        } else if (this.opened && generation !== this.generation) {
          try {
            this.#handoffCurrentRun(run.id);
            return;
          } catch (handoffError) {
            const handoffFatalCode = this.#fatalCode(handoffError);
            if (handoffFatalCode) safeError = this.#poison(handoffFatalCode);
            else this.#rememberRunError(run.id, safeError);
          }
        } else if (this.opened) this.#rememberRunError(run.id, safeError);
      }
      throw safeError;
    });
    this.runTails.set(run.id, tail);
    // 调用方可选择 waitForIdle 观察失败；无人订阅时也不能制造未处理 rejection。
    tail.catch(() => {});
    tail.finally(() => { this.#releaseOwnership(run.id, tail); }).catch(() => {});
  }

  #releaseOwnership(runId, tail) {
    if (this.runTails.get(runId) !== tail) return false;
    this.runTails.delete(runId);
    this.launchedRunIds.delete(runId);
    return true;
  }

  #handoffCurrentRun(runId) {
    if (this.poisonError || !this.opened) return;
    let currentRun = this.dispatcher.getRun(runId);
    if (currentRun?.status === "queued") currentRun = this.#settleDisabledTarget(currentRun);
    if (currentRun?.status === "queued") this.#launch("schedule", currentRun, true);
    else if (currentRun && ACTIVE_RUN_STATUSES.has(currentRun.status)) {
      this.#launch("recover", currentRun, true);
    } else if (currentRun && TERMINAL_RUN_STATUSES.has(currentRun.status)) {
      this.#reconcileRun(currentRun.id);
    }
  }

  #rememberRunError(runId, error) {
    this.runErrors.delete(runId);
    this.runErrors.set(runId, error);
    while (this.runErrors.size > MAX_RUN_ERROR_RECORDS) {
      this.runErrors.delete(this.runErrors.keys().next().value);
    }
  }

  #targetState(profileId) {
    try {
      const state = this.resolveTargetState(profileId);
      if (state === "enabled" || state === "disabled") return state;
    } catch {}
    throw kanbanServiceError("KANBAN_RUN_CORRUPT", "Kanban AgentProfile target state 无效");
  }

  #settleDisabledTarget(run) {
    if (run.status !== "queued" || this.#targetState(run.profileId) !== "disabled") return run;
    const skipped = this.dispatcher.transition(run.id, "skipped", {
      resultSummary: "KANBAN_TARGET_DISABLED",
    });
    this.#reconcileRun(skipped.id);
    return skipped;
  }

  #canonicalIntent(input, retryOf, profileId) {
    const resolvedWorkspace = this.resolveWorkspace(profileId, input.workspace);
    return Object.freeze({
      cardId: input.cardId,
      workspace: canonicalWorkspace(resolvedWorkspace),
      retryOf,
      createdAt: input.createdAt,
    });
  }

  #durableRunIntent(run) {
    const parsed = parseWorkRunIntent(run?.idempotencyKey);
    if (!parsed || run.source !== "kanban"
      || parsed.fingerprint !== intentFingerprint({
        cardId: run.sourceId,
        workspace: run.workspace,
        retryOf: run.retryOf ?? null,
        createdAt: parsed.createdAt,
      })) {
      throw kanbanServiceError("KANBAN_RUN_INTENT_INVALID", "WorkRun durable dispatch intent 无效");
    }
    this.kanbanStore.preflightDurableOperationTimestamp(parsed.createdAt);
    return parsed;
  }

  #assertDurableRunIntents(runs) {
    const owners = new Set();
    for (const run of runs) {
      const intent = this.#durableRunIntent(run);
      if (owners.has(intent.operationHash)) {
        throw kanbanServiceError("KANBAN_RUN_INTENT_INVALID", "同一 operation 存在多个 WorkRun");
      }
      owners.add(intent.operationHash);
    }
  }

  #findRunByIntent(operationId, input, retryOf, profileId) {
    const expectedHash = operationHash(operationId);
    const prefix = `${KANBAN_INTENT_PREFIX}:${expectedHash}:`;
    const matches = this.dispatcher.listRuns({ source: "kanban" })
      .filter((run) => typeof run.idempotencyKey === "string"
        && run.idempotencyKey.startsWith(prefix));
    if (matches.length > 1) {
      throw kanbanServiceError("KANBAN_OPERATION_ID_CONFLICT", "operationId 已属于多个 WorkRun");
    }
    if (matches.length === 0) return null;
    const run = matches[0];
    const persisted = this.#durableRunIntent(run);
    // A null workspace means "use the Profile default at first admission". That
    // binding is durable on the WorkRun; replay must not reinterpret the same
    // operation through a later defaultCwd value.
    const expectedWorkspace = input.workspace === null
      ? run.workspace
      : canonicalWorkspace(this.resolveWorkspace(profileId, input.workspace));
    const expectedIntent = {
      cardId: input.cardId,
      workspace: expectedWorkspace,
      retryOf,
      createdAt: input.createdAt,
    };
    if (persisted.operationHash !== expectedHash
      || persisted.createdAt !== expectedIntent.createdAt
      || persisted.fingerprint !== intentFingerprint(expectedIntent)) {
      throw kanbanServiceError("KANBAN_OPERATION_ID_CONFLICT", "operationId 已用于不同派发输入");
    }
    return run;
  }

  #latestRunForCard(cardId) {
    const runs = this.dispatcher.listRuns({ source: "kanban", sourceId: cardId });
    return runs.length === 0 ? null : runs[runs.length - 1];
  }

  #assertUniqueRootRuns(runs) {
    const rootRunByCard = new Map();
    for (const run of runs) {
      if (run.retryOf !== null && run.retryOf !== undefined) continue;
      const existing = rootRunByCard.get(run.sourceId);
      if (existing) {
        throw kanbanServiceError(
          "KANBAN_RUN_LINEAGE_INVALID", "同一 Card 存在多个 root WorkRun",
        );
      }
      rootRunByCard.set(run.sourceId, run.id);
    }
  }

  #requireCard(cardId) {
    const card = this.kanbanStore.getCard(cardId);
    if (!card) throw kanbanServiceError("KANBAN_CARD_NOT_FOUND", "Card 不存在");
    return card;
  }

  #requireBoundRun(runId, card) {
    const run = this.dispatcher.getRun(runId);
    if (!run) throw kanbanServiceError("KANBAN_RUN_NOT_FOUND", "WorkRun 不存在");
    this.#assertRunIdentity(run, card, run.retryOf ?? null);
    const link = this.kanbanStore.getCardRunLinkByRunId(run.id);
    if (!link || link.cardId !== card.id) {
      throw kanbanServiceError("KANBAN_RUN_LINK_MISSING", "WorkRun 缺少匹配的 CardRunLink");
    }
    return run;
  }

  #assertRunIdentity(run, card, retryOf) {
    if (!run || run.source !== "kanban" || run.sourceId !== card.id
      || run.profileId !== card.profileId || (run.retryOf ?? null) !== retryOf) {
      throw kanbanServiceError("KANBAN_RUN_BINDING_INVALID", "WorkRun 与 Card 绑定不匹配");
    }
  }

  #newRunId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.randomUUID();
      if (validOpaqueId(id) && !this.dispatcher.getRun(id)) return id;
    }
    throw kanbanServiceError("KANBAN_RUN_ID_CONFLICT", "无法生成唯一 WorkRun ID");
  }

  #nextOperationId(kind, ...parts) {
    this.operationSequence += 1;
    return internalOperationId(kind, this.operationNonce, this.operationSequence, ...parts);
  }

  #currentTime() {
    const value = this.now();
    if (!validTimestamp(value)) {
      throw kanbanServiceError("KANBAN_SERVICE_CLOCK_INVALID", "KanbanRunService 本地时钟无效");
    }
    return value;
  }

  #fatalOrOriginal(error) {
    if (this.poisonError) return this.poisonError;
    const fatalCode = this.#fatalCode(error);
    return fatalCode ? this.#poison(fatalCode) : error;
  }

  #fatalCode(error) {
    const codeProbe = probeDataProperty(error, "code");
    if (!codeProbe.ok) return "KANBAN_COMMIT_UNCERTAIN";
    const committedProbe = probeDataProperty(error, "committedUncertain");
    if (!committedProbe.ok) return "KANBAN_COMMIT_UNCERTAIN";
    const code = codeProbe.value;
    if (committedProbe.value !== true
      && !(typeof code === "string" && code.endsWith("COMMIT_UNCERTAIN"))) return null;
    return CANONICAL_COMMIT_UNCERTAIN_CODES.has(code)
      ? code : "KANBAN_COMMIT_UNCERTAIN";
  }

  #poison(code) {
    if (this.poisonError) return this.poisonError;
    const fatal = kanbanServiceError(
      code, "Kanban 持久化状态不确定，必须重启 Service",
    );
    fatal.committedUncertain = true;
    Object.freeze(fatal);
    // 先发布 sticky poison，callback 重入的任何操作都只能观察到同一个脱敏主错。
    this.poisonError = fatal;
    if (this.onFatalError) {
      try {
        Promise.resolve(this.onFatalError(fatal)).catch(() => {});
      } catch {}
    }
    return fatal;
  }

  #assertOpen() {
    if (this.poisonError) throw this.poisonError;
    if (!this.opened) throw kanbanServiceError("KANBAN_SERVICE_CLOSED", "KanbanRunService 未打开");
  }
}

module.exports = {
  KanbanRunService,
};
