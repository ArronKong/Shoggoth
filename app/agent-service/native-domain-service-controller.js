"use strict";

const crypto = require("node:crypto");
const {
  chunkDomainContent,
  createContentMeta,
  createDomainQueryCursorCodec,
  mapDomainServiceError,
  paginateDomainServiceItems,
  validateDomainServiceParams,
  validateDomainServiceResult,
} = require("./domain-service-protocol");
const { computeNextOccurrence, normalizeSchedule } = require("./native-cron-store");

const TRUSTED_LOCAL_ACTOR_ID = "shoggoth-local-user";
// 合法 request id 最坏可由 256 个 JSON `\uXXXX` 控制字符组成。
const MAX_RESPONSE_ID_RESERVATION = "\u0001".repeat(256);
const CRON_RUN_KINDS = new Set(["schedule", "manual", "retry"]);

const KANBAN_STORE_METHODS = Object.freeze([
  "listBoards", "getBoard", "createBoard", "updateBoard",
  "listCards", "getCard", "createCard", "updateCard", "setCardStatus", "setCardArchived",
  "listComments", "getComment", "addComment", "listAttachments", "listArtifacts", "listAuditEvents",
  "listCardRunLinks", "getCardRunLinkByRunId",
]);
const KANBAN_RUN_SERVICE_METHODS = Object.freeze([
  "dispatchCard", "retryCard", "completeCardManually",
]);
const CRON_STORE_METHODS = Object.freeze([
  "listJobs", "getJob", "createJob", "updateJobDerived", "deleteJob", "setJobEnabledDerived",
]);
const CRON_SCHEDULER_METHODS = Object.freeze(["tick", "triggerJob", "retryRun"]);
const WORK_DISPATCHER_METHODS = Object.freeze(["getRun", "listRuns"]);

function requireMethods(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`NativeDomainServiceController 需要 ${name}`);
  }
}

function ownDataObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true
      && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && descriptor.value !== undefined;
  });
}

function probeOwnDataValue(value, key) {
  try {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return { ok: true, found: false, value: undefined };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { ok: true, found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return { ok: false, found: false, value: undefined };
    }
    return { ok: true, found: true, value: descriptor.value };
  } catch {
    return { ok: false, found: false, value: undefined };
  }
}

function internalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function domainForMethod(method) {
  if (typeof method !== "string") return null;
  if (method.startsWith("kanban.")) return "kanban";
  if (method.startsWith("cron.")) return "cron";
  return null;
}

function stableTimestampKey(createdAt, id) {
  return `${String(createdAt).padStart(16, "0")}:${id}`;
}

function stableJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) {
    throw internalError("DOMAIN_RESPONSE_INVALID");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw internalError("DOMAIN_RESPONSE_INVALID");
      return `[${value.map((item) => stableJson(item, ancestors)).join(",")}]`;
    }
    if (!ownDataObject(value)) throw internalError("DOMAIN_RESPONSE_INVALID");
    return `{${Object.keys(value).sort().map((key) => {
      const item = Object.getOwnPropertyDescriptor(value, key).value;
      return `${JSON.stringify(key)}:${stableJson(item, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function dtoContentMeta(content) {
  try {
    return createContentMeta(content);
  } catch {
    throw internalError("DOMAIN_RESPONSE_INVALID");
  }
}

function cardDto(value) {
  if (!ownDataObject(value)) return value;
  const {
    id, boardId, profileId, title, body, status, position, archivedAt,
    completionRequest, completion, createdAt, updatedAt,
  } = value;
  return {
    id,
    boardId,
    profileId,
    title,
    bodyMeta: body === null ? null : dtoContentMeta(body),
    status,
    position,
    archivedAt,
    completionRequest,
    completion,
    createdAt,
    updatedAt,
  };
}

function commentDto(value) {
  if (!ownDataObject(value)) return value;
  const { id, cardId, authorType, authorId, body, createdAt } = value;
  return {
    id,
    cardId,
    authorType,
    authorId,
    bodyMeta: dtoContentMeta(body),
    createdAt,
  };
}

function cronJobDto(value) {
  if (!ownDataObject(value)) return value;
  const {
    id, name, enabled, profileId, prompt, workspace, schedule,
    misfirePolicy, maxCatchUp, overlapPolicy, threadPolicy, threadId,
    nextRunAt, createdAt, updatedAt,
  } = value;
  return {
    id,
    name,
    enabled,
    profileId,
    promptMeta: dtoContentMeta(prompt),
    workspace,
    schedule,
    misfirePolicy,
    maxCatchUp,
    overlapPolicy,
    threadPolicy,
    threadId,
    nextRunAt,
    createdAt,
    updatedAt,
  };
}

function requireEntity(value, code) {
  if (value === null || value === undefined) throw internalError(code);
  return value;
}

class NativeDomainServiceController {
  constructor(options = {}) {
    requireMethods(options.kanbanStore, KANBAN_STORE_METHODS, "NativeKanbanStore");
    requireMethods(options.kanbanRunService, KANBAN_RUN_SERVICE_METHODS, "KanbanRunService");
    requireMethods(options.cronStore, CRON_STORE_METHODS, "NativeCronStore");
    requireMethods(options.cronScheduler, CRON_SCHEDULER_METHODS, "NativeCronScheduler");
    requireMethods(options.workDispatcher, WORK_DISPATCHER_METHODS, "WorkDispatcher");
    if (typeof options.getDomainAvailability !== "function") {
      throw new TypeError("NativeDomainServiceController 需要 getDomainAvailability");
    }
    if (options.onFatalDomainError !== undefined
      && typeof options.onFatalDomainError !== "function") {
      throw new TypeError("NativeDomainServiceController onFatalDomainError 必须是函数");
    }
    if (options.describeCronRun !== undefined && typeof options.describeCronRun !== "function") {
      throw new TypeError("NativeDomainServiceController describeCronRun 必须是函数");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("NativeDomainServiceController now 必须是函数");
    }
    if (options.randomUUID !== undefined && typeof options.randomUUID !== "function") {
      throw new TypeError("NativeDomainServiceController randomUUID 必须是函数");
    }

    // 由协议 helper 统一检查 secret 的字节下限；Controller 只保留私有副本。
    createDomainQueryCursorCodec({ secret: options.cursorSecret });
    this.cursorSecret = Buffer.isBuffer(options.cursorSecret)
      ? Buffer.from(options.cursorSecret) : Buffer.from(options.cursorSecret, "utf8");
    this.kanbanStore = options.kanbanStore;
    this.kanbanRunService = options.kanbanRunService;
    this.cronStore = options.cronStore;
    this.cronScheduler = options.cronScheduler;
    this.workDispatcher = options.workDispatcher;
    this.getDomainAvailability = options.getDomainAvailability;
    this.onFatalDomainError = options.onFatalDomainError || null;
    this.describeCronRun = options.describeCronRun || null;
    this.getRunSessionKey = options.getRunSessionKey || (() => null);
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.poisoned = { kanban: null, cron: null };
  }

  async handle(method, rawParams) {
    let params;
    try {
      // 不可信参数必须在 availability、Store、Scheduler 或 Dispatcher 前完成 canonical validation。
      params = validateDomainServiceParams(method, rawParams);
    } catch (error) {
      throw mapDomainServiceError(error, { method });
    }
    const domain = domainForMethod(method);
    if (this.poisoned[domain]) throw this.poisoned[domain];
    try {
      this.#assertAvailable(domain);
      const rawResult = await this.#route(method, params);
      return validateDomainServiceResult(method, rawResult, params);
    } catch (error) {
      const fatal = this.#isFatal(domain, error);
      let safeError = mapDomainServiceError(error, { method });
      if (fatal && safeError.code !== `${domain.toUpperCase()}_COMMIT_UNCERTAIN`) {
        safeError = mapDomainServiceError(
          internalError(`${domain.toUpperCase()}_UNAVAILABLE`),
          { method },
        );
      }
      if (fatal) this.#poison(domain, safeError);
      throw this.poisoned[domain] || safeError;
    }
  }

  #assertAvailable(domain) {
    try {
      const availability = this.getDomainAvailability();
      if (!ownDataObject(availability)) throw internalError("DOMAIN_AVAILABILITY_INVALID");
      const domainProbe = probeOwnDataValue(availability, domain);
      if (!domainProbe.ok || !domainProbe.found || !ownDataObject(domainProbe.value)) {
        throw internalError("DOMAIN_AVAILABILITY_INVALID");
      }
      const availableProbe = probeOwnDataValue(domainProbe.value, "available");
      if (!availableProbe.ok || !availableProbe.found || availableProbe.value !== true) {
        throw internalError("DOMAIN_AVAILABILITY_INVALID");
      }
    } catch {
      throw internalError(`${domain.toUpperCase()}_UNAVAILABLE`);
    }
  }

  #isFatal(domain, error) {
    const codeProbe = probeOwnDataValue(error, "code");
    const committedProbe = probeOwnDataValue(error, "committedUncertain");
    const poisonedProbe = probeOwnDataValue(error, "poisoned");
    if (!codeProbe.ok || !committedProbe.ok || !poisonedProbe.ok) return true;
    const code = codeProbe.found && typeof codeProbe.value === "string" ? codeProbe.value : "";
    if (code === `${domain.toUpperCase()}_UNAVAILABLE`) return false;
    if (committedProbe.value === true || poisonedProbe.value === true
      || code.endsWith("COMMIT_UNCERTAIN") || code.endsWith("POISONED")) return true;
    const store = domain === "kanban" ? this.kanbanStore : this.cronStore;
    const service = domain === "kanban" ? this.kanbanRunService : this.cronScheduler;
    const healthProbe = probeOwnDataValue(store, "commitUncertain");
    const poisonProbe = probeOwnDataValue(service, "poisonError");
    if (!healthProbe.ok || !poisonProbe.ok) return true;
    return healthProbe.value === true
      || poisonProbe.value !== null && poisonProbe.value !== undefined;
  }

  #poison(domain, safeError) {
    if (this.poisoned[domain]) return;
    // mapDomainServiceError 返回只含 public code/message 的 frozen object；先发布 sticky
    // 状态，再通知宿主，保证 callback 重入也只能观察到同一个脱敏错误。
    this.poisoned[domain] = safeError;
    if (!this.onFatalDomainError) return;
    try {
      Promise.resolve(this.onFatalDomainError(domain, safeError)).catch(() => {});
    } catch {}
  }

  #snapshotCursorCodec(method, entries) {
    const ordered = [...entries].sort((left, right) => (
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0
    ));
    const digest = crypto.createHash("sha256");
    digest.update(method, "utf8");
    for (const entry of ordered) {
      digest.update("\0", "utf8");
      digest.update(entry.key, "utf8");
      digest.update("\0", "utf8");
      digest.update(stableJson(entry.item), "utf8");
    }
    const secret = crypto.createHmac("sha256", this.cursorSecret)
      .update(digest.digest()).digest();
    return createDomainQueryCursorCodec({ secret });
  }

  #page(method, params, entries) {
    const result = paginateDomainServiceItems({
      method,
      params,
      entries,
      cursorCodec: this.#snapshotCursorCodec(method, entries),
      responseId: MAX_RESPONSE_ID_RESERVATION,
    });
    return validateDomainServiceResult(method, result, params);
  }

  #stableEntries(items, project = (value) => value, key = (value) => (
    stableTimestampKey(value.createdAt, value.id)
  )) {
    return items.map((value) => ({ key: key(value), item: project(value) }));
  }

  #content(method, params, content) {
    const result = chunkDomainContent({
      method,
      params,
      content,
      cursorCodec: createDomainQueryCursorCodec({ secret: this.cursorSecret }),
      responseId: MAX_RESPONSE_ID_RESERVATION,
    });
    return validateDomainServiceResult(method, result, params);
  }

  #authoritativeKanbanDispatch(method, params, dispatched) {
    const initial = validateDomainServiceResult(method, {
      ...dispatched,
      card: cardDto(dispatched?.card),
    }, params);
    const runValue = requireEntity(
      this.workDispatcher.getRun(initial.run.id), "WORK_RUN_NOT_FOUND",
    );
    const cardValue = requireEntity(this.kanbanStore.getCard(params.cardId), "KANBAN_CARD_NOT_FOUND");
    const linkValue = requireEntity(
      this.kanbanStore.getCardRunLinkByRunId(runValue.id), "STATE_CONFLICT",
    );
    return { run: runValue, card: cardDto(cardValue), link: linkValue };
  }

  #nextRunAt(schedule, enabled, updatedAt) {
    if (!enabled) return null;
    return computeNextOccurrence(normalizeSchedule(schedule), updatedAt);
  }

  async #mutateCronAndTick(operation, authoritativeJob = false) {
    const result = await operation();
    await this.cronScheduler.tick();
    if (authoritativeJob && ownDataObject(result) && typeof result.id === "string") {
      return this.cronStore.getJob(result.id) ?? result;
    }
    return result;
  }

  #listCronRuns(params) {
    if (!this.describeCronRun) throw internalError("CRON_UNAVAILABLE");
    const job = requireEntity(this.cronStore.getJob(params.jobId), "CRON_JOB_NOT_FOUND");
    const runs = this.workDispatcher.listRuns({ source: "cron", sourceId: params.jobId })
      .filter((value) => value.source === "cron" && value.sourceId === params.jobId)
      .filter((value) => value.profileId === job.profileId)
      .filter((value) => params.status === null || value.status === params.status);
    const entries = runs.map((runValue) => {
      const description = this.describeCronRun(runValue);
      if (!ownDataObject(description) || Object.keys(description).length !== 2
        || !CRON_RUN_KINDS.has(description.kind)
        || !Number.isSafeInteger(description.createdAt) || description.createdAt < 0) {
        throw internalError("DOMAIN_RESPONSE_INVALID");
      }
      return {
        key: stableTimestampKey(description.createdAt, runValue.id),
        item: { run: runValue, kind: description.kind, createdAt: description.createdAt,
          ...(this.getRunSessionKey(runValue) ? { sessionKey: this.getRunSessionKey(runValue) } : {}) },
      };
    });
    return this.#page("cron.run.list", params, entries);
  }

  async #route(method, params) {
    if (method === "kanban.board.list") {
      const values = this.kanbanStore.listBoards()
        .filter((value) => value.profileId === params.profileId);
      return this.#page(method, params, this.#stableEntries(values));
    }
    if (method === "kanban.board.get") {
      return { board: requireEntity(this.kanbanStore.getBoard(params.boardId), "KANBAN_BOARD_NOT_FOUND") };
    }
    if (method === "kanban.board.create") {
      return { board: await this.kanbanStore.createBoard(params) };
    }
    if (method === "kanban.board.update") {
      return { board: await this.kanbanStore.updateBoard(params) };
    }
    if (method === "kanban.card.list") {
      const values = this.kanbanStore.listCards({ boardId: params.boardId })
        .filter((value) => params.status === null || value.status === params.status);
      return this.#page(method, params, this.#stableEntries(values, cardDto));
    }
    if (method === "kanban.card.get") {
      return { card: cardDto(requireEntity(
        this.kanbanStore.getCard(params.cardId), "KANBAN_CARD_NOT_FOUND",
      )) };
    }
    if (method === "kanban.card.body.read") {
      const value = requireEntity(this.kanbanStore.getCard(params.cardId), "KANBAN_CARD_NOT_FOUND");
      return this.#content(method, params, value.body ?? "");
    }
    if (method === "kanban.card.create") {
      return { card: cardDto(await this.kanbanStore.createCard(params)) };
    }
    if (method === "kanban.card.update") {
      return { card: cardDto(await this.kanbanStore.updateCard(params)) };
    }
    if (method === "kanban.card.status.set") {
      return { card: cardDto(await this.kanbanStore.setCardStatus({
        ...params,
        actor: "human",
        actorId: TRUSTED_LOCAL_ACTOR_ID,
      })) };
    }
    if (method === "kanban.card.archived.set") {
      return { card: cardDto(await this.kanbanStore.setCardArchived({
        ...params,
        actor: "human",
        actorId: TRUSTED_LOCAL_ACTOR_ID,
      })) };
    }
    if (method === "kanban.card.complete.manual") {
      await this.kanbanRunService.completeCardManually({
        ...params,
        actorId: TRUSTED_LOCAL_ACTOR_ID,
      });
      const cardValue = requireEntity(this.kanbanStore.getCard(params.cardId), "KANBAN_CARD_NOT_FOUND");
      const auditValues = this.kanbanStore.listAuditEvents(params.cardId).filter((value) => (
        value.kind === "manual_completion" && value.actorId === TRUSTED_LOCAL_ACTOR_ID
        && value.note === params.note && value.createdAt === params.createdAt
      ));
      if (auditValues.length !== 1) throw internalError("DOMAIN_RESPONSE_INVALID");
      return {
        card: cardDto(cardValue),
        audit: auditValues[0],
      };
    }
    if (method === "kanban.comment.list") {
      return this.#page(method, params, this.#stableEntries(
        this.kanbanStore.listComments(params.cardId), commentDto,
      ));
    }
    if (method === "kanban.comment.body.read") {
      const value = requireEntity(
        this.kanbanStore.getComment(params.commentId), "KANBAN_COMMENT_NOT_FOUND",
      );
      return this.#content(method, params, value.body);
    }
    if (method === "kanban.comment.add") {
      return { comment: commentDto(await this.kanbanStore.addComment({
        ...params,
        authorType: "human",
        authorId: TRUSTED_LOCAL_ACTOR_ID,
      })) };
    }
    if (method === "kanban.attachment.list") {
      return this.#page(method, params, this.#stableEntries(
        this.kanbanStore.listAttachments(params.cardId),
      ));
    }
    if (method === "kanban.artifact.list") {
      return this.#page(method, params, this.#stableEntries(
        this.kanbanStore.listArtifacts(params.cardId),
      ));
    }
    if (method === "kanban.audit.list") {
      return this.#page(method, params, this.#stableEntries(
        this.kanbanStore.listAuditEvents(params.cardId),
      ));
    }
    if (method === "kanban.run.list") {
      const entries = [];
      for (const linkValue of this.kanbanStore.listCardRunLinks(params.cardId)) {
        const runValue = requireEntity(this.workDispatcher.getRun(linkValue.runId), "WORK_RUN_NOT_FOUND");
        if (params.status !== null && runValue.status !== params.status) continue;
        entries.push({
          key: stableTimestampKey(linkValue.createdAt, runValue.id),
          item: runValue,
        });
      }
      return this.#page(method, params, entries);
    }
    if (method === "kanban.run.dispatch" || method === "kanban.run.retry") {
      const dispatched = method === "kanban.run.dispatch"
        ? await this.kanbanRunService.dispatchCard(params)
        : await this.kanbanRunService.retryCard(params);
      return this.#authoritativeKanbanDispatch(method, params, dispatched);
    }
    if (method === "cron.job.list") {
      const query = { profileId: params.profileId };
      if (params.enabled !== null) query.enabled = params.enabled;
      return this.#page(method, params, this.#stableEntries(
        this.cronStore.listJobs(query), cronJobDto,
      ));
    }
    if (method === "cron.job.get") {
      return { job: cronJobDto(requireEntity(
        this.cronStore.getJob(params.jobId), "CRON_JOB_NOT_FOUND",
      )) };
    }
    if (method === "cron.job.prompt.read") {
      const value = requireEntity(this.cronStore.getJob(params.jobId), "CRON_JOB_NOT_FOUND");
      return this.#content(method, params, value.prompt);
    }
    if (method === "cron.job.create") {
      const nextRunAt = this.#nextRunAt(params.schedule, params.enabled, params.createdAt);
      const value = await this.#mutateCronAndTick(
        () => this.cronStore.createJob({ ...params, nextRunAt }),
        true,
      );
      return { job: cronJobDto(value) };
    }
    if (method === "cron.job.update") {
      const value = await this.#mutateCronAndTick(
        () => this.cronStore.updateJobDerived(params),
        true,
      );
      return { job: cronJobDto(value) };
    }
    if (method === "cron.job.delete") {
      await this.#mutateCronAndTick(() => this.cronStore.deleteJob(params));
      return { jobId: params.jobId, deleted: true };
    }
    if (method === "cron.job.enabled.set") {
      const value = await this.#mutateCronAndTick(
        () => this.cronStore.setJobEnabledDerived(params),
        true,
      );
      return { job: cronJobDto(value) };
    }
    if (method === "cron.run.list") return this.#listCronRuns(params);
    if (method === "cron.run.trigger" || method === "cron.run.retry") {
      const scheduled = method === "cron.run.trigger"
        ? await this.cronScheduler.triggerJob(params)
        : await this.cronScheduler.retryRun(params);
      const initial = validateDomainServiceResult(method, { run: scheduled }, params);
      const authoritative = requireEntity(
        this.workDispatcher.getRun(initial.run.id), "WORK_RUN_NOT_FOUND",
      );
      return { run: authoritative };
    }
    throw internalError("INVALID_PARAMS");
  }
}

function createNativeDomainServiceController(options) {
  return new NativeDomainServiceController(options);
}

module.exports = {
  NativeDomainServiceController,
  TRUSTED_LOCAL_ACTOR_ID,
  createNativeDomainServiceController,
};
