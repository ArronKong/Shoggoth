"use strict";

const crypto = require("node:crypto");
const { MAX_PROMPT_BYTES } = require("./pending-command-inbox");
const { WORK_RUN_FIELDS, validateWorkRun } = require("./product-store");

const DOMAIN_SOURCES = new Set(["kanban", "cron", "inspiration"]);
const INSPIRATION_PAYLOAD_FIELDS = Object.freeze(["run", "execution", "prompt", "recovered"]);
const KANBAN_PAYLOAD_FIELDS = Object.freeze([
  "run", "card", "prompt", "recovered", "onStateChange",
]);
const CRON_PAYLOAD_FIELDS = Object.freeze([
  "run", "job", "prompt", "scheduledAt", "operationId", "threadPolicy", "threadId", "recovered",
]);
const TERMINAL_STATUSES = new Set([
  "completed", "failed", "canceled", "interrupted", "skipped",
]);

function executorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validOpaqueId(value, maxLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function assertDomainRun(run) {
  try {
    if (!exactObject(run, WORK_RUN_FIELDS)
      || WORK_RUN_FIELDS.some((field) => run[field] === undefined)) {
      throw new Error("WorkRun shape invalid");
    }
    const validated = validateWorkRun(run);
    if (!DOMAIN_SOURCES.has(validated.source) || !validOpaqueId(validated.profileId)) {
      throw new Error("WorkRun binding invalid");
    }
  } catch {
    throw executorError("DOMAIN_WORK_RUN_INVALID", "Domain executor 需要已持久化的领域 WorkRun");
  }
}

function assertDomainPayload(payload, run) {
  const fields = run.source === "inspiration" ? INSPIRATION_PAYLOAD_FIELDS
    : run.source === "kanban" ? KANBAN_PAYLOAD_FIELDS : CRON_PAYLOAD_FIELDS;
  const validCommon = exactObject(payload, fields)
    && validPrompt(payload.prompt)
    && typeof payload.recovered === "boolean";
  const validDomain = run.source === "inspiration"
    ? payload.execution && payload.execution.ideaId === run.sourceId
      && payload.execution.runId === run.id && payload.execution.profileId === run.profileId
      && payload.execution.workspace === run.workspace && validOpaqueId(payload.execution.sessionKey)
    : run.source === "kanban"
    ? payload.card && typeof payload.card === "object"
      && payload.card.id === run.sourceId
      && typeof payload.onStateChange === "function"
    : payload.job && typeof payload.job === "object"
      && payload.job.id === run.sourceId
      && Number.isSafeInteger(payload.scheduledAt) && payload.scheduledAt >= 0
      && payload.operationId === run.idempotencyKey
      && ["new", "continue"].includes(payload.threadPolicy)
      && (payload.threadId === null || validOpaqueId(payload.threadId, 256));
  if (!validCommon || !validDomain) {
    throw executorError("DOMAIN_WORK_RUN_PAYLOAD_INVALID", "Domain WorkRun executor payload 无效");
  }
}

function domainOperationId(run) {
  assertDomainRun(run);
  return `domain-${sha256(JSON.stringify([run.source, run.id, run.idempotencyKey]))}`;
}

function domainThreadSource(run, threadPolicy = "new") {
  assertDomainRun(run);
  if (run.source === "cron" && threadPolicy === "continue") {
    return `shoggoth:cron:${sha256(run.sourceId)}`;
  }
  return `shoggoth:work:${sha256(JSON.stringify([run.source, run.id]))}`;
}

function validPrompt(value) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_PROMPT_BYTES;
}

class DomainWorkRunExecutor {
  constructor(options = {}) {
    if ((!options.coordinator || typeof options.coordinator.executeDomainRun !== "function")
      && typeof options.getCoordinator !== "function") {
      throw executorError(
        "DOMAIN_WORK_RUN_EXECUTOR_DEPENDENCY_REQUIRED",
        "DomainWorkRunExecutor 需要 WorkRunCoordinator",
      );
    }
    this.coordinator = options.coordinator || null;
    this.getCoordinator = options.getCoordinator || (() => this.coordinator);
  }

  schedule(payload) {
    return this.#execute(payload);
  }

  recover(payload) {
    return this.#execute(payload);
  }

  async #execute(payload) {
    const run = payload?.run;
    assertDomainRun(run);
    assertDomainPayload(payload, run);
    const coordinator = this.getCoordinator();
    if (!coordinator || ["executeDomainRun", "getRun", "subscribeRun", "waitForTerminal"].some(
      (method) => typeof coordinator[method] !== "function",
    )) {
      throw executorError(
        "DOMAIN_WORK_RUN_EXECUTOR_DEPENDENCY_REQUIRED",
        "DomainWorkRunExecutor 的 Coordinator 不可用",
      );
    }
    const current = coordinator.getRun(run.id);
    if (!current || current.source !== run.source || current.sourceId !== run.sourceId
      || current.idempotencyKey !== run.idempotencyKey || current.profileId !== run.profileId
      || current.workspace !== run.workspace) {
      throw executorError("DOMAIN_WORK_RUN_BINDING_INVALID", "Domain executor 的 durable Run binding 不匹配");
    }

    const notify = () => {
      if (run.source === "kanban") payload.onStateChange();
    };
    if (TERMINAL_STATUSES.has(current.status)) {
      notify();
      return current;
    }

    let settled = false;
    let resolveTerminal;
    let rejectTerminal;
    const terminalPromise = new Promise((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    const finish = (error = null) => {
      if (settled) return;
      let latest = null;
      try {
        latest = coordinator.getRun(run.id);
      } catch (lookupError) {
        if (!error) error = lookupError;
      }
      if (!error && !TERMINAL_STATUSES.has(latest?.status)) return;
      settled = true;
      subscription?.unsubscribe();
      if (error) rejectTerminal(error);
      else resolveTerminal(latest);
    };
    const subscription = coordinator.subscribeRun(
      run.id,
      { streamId: null, afterSeq: 0 },
      (event) => {
        try {
          if (["status", "approval", "prompt", "terminal"].includes(event.type)) notify();
          if (event.type === "terminal") finish();
        } catch (error) {
          finish(error);
        }
      },
    );

    try {
      await coordinator.executeDomainRun({
        runId: run.id,
        operationId: domainOperationId(run),
        prompt: payload.prompt,
        threadSource: domainThreadSource(run, run.source === "cron" ? payload.threadPolicy : "new"),
        threadId: run.source === "cron" && payload.threadPolicy === "continue"
          ? payload.threadId : null,
      });
      const lifecycleWaiter = coordinator.waitForTerminal(run.id);
      void lifecycleWaiter.then(
        () => finish(),
        (error) => finish(error),
      );
      notify();
      finish();
    } catch (error) {
      finish(error);
    }
    return terminalPromise;
  }
}

module.exports = {
  DomainWorkRunExecutor,
  domainOperationId,
  domainThreadSource,
};
