"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");
const {
  normalizeInteractiveRequestV1,
  validateInteractiveResponseV1,
} = require("./shoggoth-interaction-contract");

const TERMINAL = new Set(["completed", "failed", "canceled", "interrupted"]);
const FINAL_RESULT_GRACE_MS = 5000;
const FINAL_RESULT_RETENTION_MS = 5 * 60 * 1000;
const METHOD_SCOPES = {
  "agents.list": "operator.read",
  "sessions.create": "operator.write",
  "sessions.list": "operator.read",
  agent: "operator.write",
  "tasks.list": "operator.read",
  "tasks.get": "operator.read",
  "tasks.cancel": "operator.write",
  "chat.abort": "operator.write",
  "question.list": "operator.questions",
  "question.resolve": "operator.questions",
  "exec.approval.list": "operator.approvals",
  "exec.approval.get": "operator.approvals",
  "exec.approval.resolve": "operator.approvals",
};

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function string(value, max = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.isWellFormed() && !/[\u0000-\u001f]/u.test(value);
}

function workspacePath(value) {
  if (!string(value)) throw failure("OPENCLAW_WORKSPACE_UNAVAILABLE");
  // This path belongs to the Gateway host. Never realpath it on the app host.
  const syntax = path.posix.isAbsolute(value) ? path.posix : path.win32;
  if (!syntax.isAbsolute(value)) throw failure("OPENCLAW_WORKSPACE_UNAVAILABLE");
  return syntax.normalize(value).replace(/[\\/]+$/u, "") || syntax.parse(value).root;
}

function identity(input) {
  if (!input || typeof input.agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(input.agentId)
    || !string(input.sessionKey, 512)
    || !new RegExp(`^agent:${input.agentId}:dashboard:inspiration-[a-f0-9]{64}$`, "u").test(input.sessionKey)
    || !string(input.runId, 128)) throw failure("OPENCLAW_EXECUTION_IDENTITY_INVALID");
  return { agentId: input.agentId, sessionKey: input.sessionKey, runId: input.runId };
}

function matches(value, target) {
  return value?.sessionKey === target.sessionKey && value?.runId === target.runId
    && (value.agentId === undefined || value.agentId === null || value.agentId === target.agentId);
}

function snapshot(status, errorCode = null, resultSummary = "", attention = null) {
  return { status, resultSummary, errorCode, attention };
}

function resultText(value) {
  let result = "", bytes = 2;
  for (const character of value.toWellFormed().replace(/\0/gu, "\ufffd")) {
    const size = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
    if (result.length + character.length > 4000 || bytes + size > 16 * 1024) break;
    result += character;
    bytes += size;
  }
  return result;
}

function finalResultText(payload) {
  if (!Array.isArray(payload?.result?.payloads)) return null;
  const parts = [];
  let length = 0;
  for (const item of payload.result.payloads.slice(0, 1024)) {
    if (!item || typeof item.text !== "string" || item.isReasoning === true
      || item.isCommentary === true || item.isError === true || !item.text.trim()) continue;
    const text = resultText(item.text.trim());
    parts.push(text);
    length += text.length + 2;
    if (length >= 4000) break;
  }
  return parts.length ? resultText(parts.join("\n\n")) : null;
}

function taskSnapshot(task) {
  const status = ({ queued: "starting", running: "running", completed: "completed",
    failed: "failed", timed_out: "failed", cancelled: "canceled" })[task?.status] || "unknown";
  const result = [task?.result, task?.terminalSummary, task?.progressSummary]
    .find((value) => typeof value === "string" && value.length > 0) || "";
  const error = status === "failed"
    ? (task.status === "timed_out" ? "OPENCLAW_RUN_TIMED_OUT" : "OPENCLAW_RUN_FAILED")
    : status === "unknown" ? "OPENCLAW_TASK_STATUS_UNKNOWN" : null;
  return snapshot(status, error, resultText(result));
}

/**
 * Stateless bridge for Service-owned, durable inspiration execution identities.
 * Uses OpenClawBackend.request and its _connect/hasGatewayMethod/_hasGatewayScope
 * helpers; no workboard task matching, federation handle, or native Profile.
 * sessions.create key and agent idempotencyKey are explicit Gateway contracts.
 * Gateway dedupe is short-lived, so callers must inspect uncertain starts instead
 * of invoking start again after process or Gateway recovery.
 */
class OpenClawInspirationAdapter {
  constructor({ backend, now = Date.now }) {
    if (!backend || typeof backend.request !== "function" || typeof now !== "function") {
      throw failure("OPENCLAW_ADAPTER_INVALID");
    }
    this.backend = backend;
    this.now = now;
    this.observations = new Map();
  }

  _observationKey(target) { return `${target.sessionKey}\0${target.runId}`; }

  reset() {
    for (const observation of this.observations.values()) {
      observation.invalid = true;
      observation.controller.abort();
      clearTimeout(observation.timer);
    }
    this.observations.clear();
  }

  _retainObservation(key, observation) {
    if (observation.timer) return;
    observation.timer = setTimeout(() => {
      observation.controller.abort();
      if (this.observations.get(key) === observation) this.observations.delete(key);
    }, FINAL_RESULT_RETENTION_MS);
    observation.timer.unref?.();
  }

  _terminalResult(state, target) {
    const key = this._observationKey(target);
    const stored = this.observations.get(key);
    const observation = stored?.invalid ? null : stored;
    if (state.status === "completed" && observation && !observation.closed && !observation.final) {
      observation.completedAt ??= this.now();
      if (this.now() - observation.completedAt < FINAL_RESULT_GRACE_MS) return snapshot("running");
      observation.controller.abort();
    }
    if (observation) this._retainObservation(key, observation);
    // The durable CLI task's result is normally the literal "completed".
    // Only the final response to our original RPC supplies model output.
    return { ...state, resultSummary: observation?.final ? observation.resultSummary : null,
      errorCode: state.status === "completed" && !observation?.resultSummary ? "OPENCLAW_RESULT_UNAVAILABLE" : state.errorCode };
  }

  async _ready() {
    if (typeof this.backend._connect === "function") await this.backend._connect();
  }

  _require(method) {
    if (typeof this.backend.hasGatewayMethod === "function" && !this.backend.hasGatewayMethod(method)) {
      throw failure("OPENCLAW_INSPIRATION_UNSUPPORTED");
    }
    if (typeof this.backend._hasGatewayScope === "function"
      && !this.backend._hasGatewayScope(METHOD_SCOPES[method])) {
      throw failure("OPENCLAW_INSPIRATION_SCOPE_REQUIRED");
    }
  }

  async _request(method, params) {
    await this._ready();
    this._require(method);
    return this.backend.request(method, params, 15000);
  }

  async _workspace(agentId, requested) {
    const result = await this._request("agents.list", {});
    const agents = (Array.isArray(result?.agents) ? result.agents : []).filter((agent) => agent?.id === agentId);
    if (agents.length !== 1) throw failure("OPENCLAW_AGENT_UNAVAILABLE");
    const workspace = workspacePath(agents[0].workspace);
    if (requested !== undefined && requested !== null && requested !== ""
      && workspacePath(requested) !== workspace) throw failure("OPENCLAW_WORKSPACE_MISMATCH");
    return workspace;
  }

  async prepare({ agentId, sessionId, sessionKey, workspace } = {}) {
    if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agentId)
      || (!sessionKey && !string(sessionId, 128))) throw failure("OPENCLAW_EXECUTION_IDENTITY_INVALID");
    await this._ready();
    // A run can ask a question or request execution approval at any time.
    for (const method of Object.keys(METHOD_SCOPES)) this._require(method);
    const resolved = await this._workspace(agentId, workspace);
    if (sessionKey) {
      identity({ agentId, sessionKey, runId: "prepare" });
      return { sessionKey, workspace: resolved, mode: "openclaw" };
    }
    const suffix = createHash("sha256").update(sessionId).digest("hex");
    sessionKey = `agent:${agentId}:dashboard:inspiration-${suffix}`;
    const result = await this._request("sessions.create", {
      agentId, key: sessionKey, idempotencyKey: `inspiration-session:${sessionId}`,
      label: `Inspiration ${suffix.slice(0, 12)}`,
    });
    if (result?.ok !== true || result.key !== sessionKey || result.runStarted === true) {
      throw failure("OPENCLAW_SESSION_IDENTITY_MISMATCH");
    }
    return { sessionKey, workspace: resolved, mode: "openclaw" };
  }

  async start(input, onUpdate = null) {
    const target = identity(input);
    if (typeof input.prompt !== "string" || !input.prompt.trim() || !input.prompt.isWellFormed()
      || input.prompt.includes("\0")) throw failure("OPENCLAW_PROMPT_INVALID");
    if (!input.workspace) throw failure("OPENCLAW_WORKSPACE_UNAVAILABLE");
    await this._workspace(target.agentId, input.workspace);
    await this._ready();
    this._require("agent");
    let result;
    const params = { agentId: target.agentId, sessionKey: target.sessionKey, message: input.prompt,
      idempotencyKey: target.runId, deliver: false };
    let observation;
    try {
      if (typeof this.backend.requestWithFinalObservation === "function") {
        const key = this._observationKey(target);
        if (this.observations.has(key)) throw failure("OPENCLAW_START_ALREADY_OBSERVED");
        observation = { controller: new AbortController(), closed: false, final: false,
          invalid: false, resultSummary: null, completedAt: null, timer: null };
        this.observations.set(key, observation);
        const publish = () => {
          if (typeof onUpdate !== "function") return;
          this.inspect(target).then(value => {
            if (this.observations.get(key) === observation && !observation.invalid) onUpdate(value);
          }).catch(() => {});
        };
        result = await this.backend.requestWithFinalObservation("agent", params, {
          signal: observation.controller.signal,
          onClose: () => { observation.closed = true; this._retainObservation(key, observation); },
          onFinal: frame => {
            if (this.observations.get(key) !== observation) return;
            observation.closed = true;
            this._retainObservation(key, observation);
            const payload = frame?.payload;
            if (payload?.runId !== target.runId
              || (payload.sessionKey !== undefined && payload.sessionKey !== target.sessionKey)
              || (payload.agentId !== undefined && payload.agentId !== target.agentId)
              || !["ok", "error", "timeout"].includes(payload.status)) return;
            observation.final = true;
            observation.resultSummary = finalResultText(payload);
            publish();
          },
        }, 15000);
      } else result = await this.backend.request("agent", params, 15000);
    } catch {
      // Even a transport failure can follow successful acceptance. Never replay.
      return snapshot("unknown", "OPENCLAW_START_UNCERTAIN");
    }
    if (observation?.final && result?.runId === target.runId
      && ["ok", "error", "timeout"].includes(result.status)) return this.inspect(target);
    if (result?.runId !== target.runId || result?.sessionKey !== target.sessionKey
      || (result.agentId !== undefined && result.agentId !== target.agentId)) {
      if (observation) { observation.invalid = true; observation.controller.abort(); }
      return snapshot("unknown", "OPENCLAW_START_IDENTITY_MISMATCH");
    }
    if (!["accepted", "in_flight", "ok", "completed", "error"].includes(result.status)) {
      return snapshot("unknown", "OPENCLAW_START_UNCERTAIN");
    }
    // agent can return an accepted response before its task ledger row exists.
    return snapshot("starting");
  }

  async _task(target) {
    const tasks = new Map();
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await this._request("tasks.list", {
        sessionKey: target.sessionKey, agentId: target.agentId, limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result?.tasks)) throw failure("OPENCLAW_TASK_RESPONSE_INVALID");
      for (const task of result.tasks) {
        if (!matches(task, target)) continue;
        const id = task.taskId || task.id;
        if (!string(id, 256)) throw failure("OPENCLAW_TASK_RESPONSE_INVALID");
        tasks.set(id, task);
      }
      if (!result.nextCursor) {
        if (tasks.size > 1) throw failure("OPENCLAW_TASK_IDENTITY_AMBIGUOUS");
        if (tasks.size === 0) return null;
        const [taskId] = tasks.keys();
        const detail = await this._request("tasks.get", { taskId });
        if (!matches(detail?.task, target) || (detail.task.taskId || detail.task.id) !== taskId) {
          throw failure("OPENCLAW_TASK_IDENTITY_MISMATCH");
        }
        return detail.task;
      }
      if (!string(result.nextCursor, 256) || cursors.has(result.nextCursor)) break;
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw failure("OPENCLAW_TASK_SCAN_INCOMPLETE");
  }

  async _inactive(target) {
    const result = await this._request("sessions.list", { agentId: target.agentId, search: target.sessionKey, limit: 100 });
    if (!Array.isArray(result?.sessions)) return false;
    const sessions = result.sessions.filter((session) => session?.key === target.sessionKey);
    return sessions.length === 1 && sessions[0].hasActiveRun === false;
  }

  _question(row, target) {
    if (!Array.isArray(row.questions) || row.questions.length === 0 || row.questions.length > 32) {
      throw failure("OPENCLAW_QUESTION_INVALID");
    }
    const properties = {};
    row.questions.forEach((question, index) => {
      if (!string(question?.questionId, 128) || typeof question.question !== "string"
        || typeof question.header !== "string"
        || !Array.isArray(question.options) || question.options.length > 32
        || question.options.some((option) => !string(option?.label, 512))) {
        throw failure("OPENCLAW_QUESTION_INVALID");
      }
      const labels = question.options.map((option) => option.label);
      if (new Set(labels).size !== labels.length) throw failure("OPENCLAW_QUESTION_INVALID");
      const spec = { type: "string", title: question.header || question.question,
        description: question.question, writeOnly: question.isSecret === true || Boolean(question.secretStore) };
      if (labels.length >= 2 && !question.multiSelect && !question.isOther && !spec.writeOnly) {
        spec.enum = labels;
        spec.description += `\n${question.options.map((option) => `${option.label}: ${option.description || ""}`).join("\n")}`;
      } else if (labels.length || question.multiSelect) {
        spec.description += `${labels.length ? `\n选项：${labels.join("、")}` : ""}`;
        if (question.multiSelect) spec.description += "\n可以选择多项，每行填写一个选项。";
        if (question.isOther) spec.description += "\n也可以填写其他答案。";
      }
      if (question.secretStore) {
        if (!string(question.secretStore.name, 128)
          || !["env", "secret"].includes(question.secretStore.kind)
          || (question.secretStore.allowedHosts !== undefined
            && (!Array.isArray(question.secretStore.allowedHosts)
              || question.secretStore.allowedHosts.some((host) => !string(host, 256))))) {
          throw failure("OPENCLAW_QUESTION_INVALID");
        }
        spec.description += `\n此答案将保存到 OpenClaw ${question.secretStore.kind === "env" ? "环境变量" : "密钥"}：${question.secretStore.name}。`;
        if (Array.isArray(question.secretStore.allowedHosts)) {
          spec.description += `\n允许的主机：${question.secretStore.allowedHosts.join("、")}`;
        }
        if (typeof question.secretStore.reason === "string") spec.description += `\n${question.secretStore.reason}`;
        if (question.secretStoreExisting) {
          if (!Number.isSafeInteger(question.secretStoreExisting.updatedAtMs)
            || question.secretStoreExisting.updatedAtMs < 0) throw failure("OPENCLAW_QUESTION_INVALID");
          spec.description += "\n此位置已有保存值；提交会更新该值。";
        }
      }
      // Do not let normalization silently discard options or credential consent.
      if (!spec.description.isWellFormed() || spec.description.includes("\0")
        || Buffer.byteLength(spec.description, "utf8") > 2048) throw failure("OPENCLAW_QUESTION_UNSUPPORTED");
      properties[`question_${index}`] = spec;
    });
    const request = normalizeInteractiveRequestV1({ runId: target.runId, eventType: "prompt",
      expiresAt: row.expiresAtMs, payload: { requestId: row.id, message: "OpenClaw 需要补充信息",
        requestedSchema: { type: "object", properties, required: Object.keys(properties) } } });
    return { request, active: true, occurredAt: row.createdAtMs, command: null, cwd: null, details: null };
  }

  async _approval(row, target) {
    const detail = await this._request("exec.approval.get", { id: row.id });
    if (detail?.id !== row.id || (detail.agentId !== undefined && detail.agentId !== null && detail.agentId !== target.agentId)) {
      throw failure("OPENCLAW_APPROVAL_IDENTITY_MISMATCH");
    }
    const command = detail.commandText || row.request.command;
    const choices = Array.isArray(detail.allowedDecisions) ? detail.allowedDecisions : row.request.allowedDecisions;
    if (!Array.isArray(choices) || !choices.includes("deny")) throw failure("OPENCLAW_APPROVAL_INVALID");
    const base = normalizeInteractiveRequestV1({ runId: target.runId, eventType: "approval",
      expiresAt: row.expiresAtMs, payload: { requestId: row.id,
        reason: row.request.warningText || "OpenClaw 请求执行以下命令",
        redacted: typeof command !== "string" || !command.trim() || !command.isWellFormed() || command.includes("\0")
          || Buffer.byteLength(command, "utf8") > 16 * 1024,
      } });
    const canAllow = base.approvalChoices.includes("once") && choices.includes("allow-once");
    // allow-always is permanent, not an InteractiveRequestV1 session grant.
    const request = Object.freeze({ ...base, approvalChoices: canAllow ? ["once", "deny", "cancel"] : ["deny", "cancel"] });
    return { request, active: true, occurredAt: row.createdAtMs,
      command: canAllow ? command : null,
      cwd: canAllow && string(row.request.cwd) ? row.request.cwd : null, details: null };
  }

  async _pending(target) {
    const questions = await this._request("question.list", {});
    const approvals = await this._request("exec.approval.list", {});
    const approvalRows = Array.isArray(approvals) ? approvals : approvals?.approvals ?? approvals?.items;
    if (!Array.isArray(questions?.questions) || !Array.isArray(approvalRows)) {
      throw failure("OPENCLAW_INTERACTION_RESPONSE_INVALID");
    }
    const result = [];
    for (const [kind, rows] of [["question", questions.questions], ["approval", approvalRows]]) {
      for (const row of rows) {
        const owner = kind === "question" ? row : row?.request;
        if (owner?.sessionKey !== target.sessionKey || (owner.runId && owner.runId !== target.runId)) continue;
        if (!Number.isSafeInteger(row.expiresAtMs) || !Number.isSafeInteger(row.createdAtMs) || row.createdAtMs < 0) {
          throw failure("OPENCLAW_INTERACTION_RESPONSE_INVALID");
        }
        if (row.expiresAtMs <= this.now() || (kind === "question" && row.status !== "pending")) continue;
        if (!matches(owner, target)) throw failure("OPENCLAW_INTERACTION_IDENTITY_UNAVAILABLE");
        const attention = kind === "question" ? this._question(row, target) : await this._approval(row, target);
        if (result.some((entry) => entry.row.id === row.id)) throw failure("OPENCLAW_INTERACTION_IDENTITY_AMBIGUOUS");
        result.push({ kind, row, attention });
      }
    }
    return result.sort((a, b) => a.row.createdAtMs - b.row.createdAtMs || a.row.id.localeCompare(b.row.id));
  }

  async inspect(input) {
    const target = identity(input);
    try {
      const task = await this._task(target);
      const state = task ? taskSnapshot(task) : snapshot("unknown", "OPENCLAW_TASK_NOT_FOUND");
      if (state.status === "canceled") {
        return await this._inactive(target) ? this._terminalResult(state, target)
          : snapshot("unknown", "OPENCLAW_STOP_UNCONFIRMED", state.resultSummary);
      }
      if (TERMINAL.has(state.status)) return this._terminalResult(state, target);
      const pending = await this._pending(target);
      if (pending.length) {
        const first = pending[0];
        return snapshot(first.kind === "question" ? "waiting_input" : "waiting_approval", null,
          state.resultSummary, first.attention);
      }
      return state;
    } catch (error) {
      return snapshot("unknown", error?.code?.startsWith("OPENCLAW_") ? error.code : "OPENCLAW_INSPECT_UNAVAILABLE");
    }
  }

  async respond(input) {
    const target = identity(input);
    const task = await this._task(target);
    if (task && TERMINAL.has(taskSnapshot(task).status)) throw failure("OPENCLAW_REQUEST_STALE");
    const pending = await this._pending(target);
    const entry = pending.find((value) => value.row.id === input.requestId);
    if (!entry || entry.row.expiresAtMs <= this.now()) throw failure("OPENCLAW_REQUEST_STALE");
    const response = validateInteractiveResponseV1(entry.attention.request, input.response);
    let method, params, expected;
    if (entry.kind === "approval") {
      method = "exec.approval.resolve";
      params = { id: entry.row.id, decision: response.choice === "once" ? "allow-once" : "deny" };
      expected = (result) => result?.ok === true;
    } else {
      method = "question.resolve";
      if (response.action === "cancel") {
        params = { id: entry.row.id, cancel: true };
        expected = (result) => result?.status === "cancelled";
      } else {
        const answers = Object.create(null);
        entry.row.questions.forEach((question, index) => {
          const value = response.answers[`question_${index}`];
          const submitted = question.multiSelect ? value.split(/\r?\n/u).map((answer) => answer.trim()) : [value];
          // OpenClaw matches option labels after trimming while retaining their
          // canonical spelling. Free-text secrets keep the submitted bytes.
          const values = question.options.length ? submitted.map((answer) => {
            const option = question.options.find((item) => item.label.trim() === answer.trim());
            return option?.label ?? answer.trim();
          }) : submitted;
          if (!Array.isArray(values) || values.length === 0 || values.length > 32
            || values.some((answer) => typeof answer !== "string" || !answer.trim())
            || new Set(values).size !== values.length
            || (question.options.length && !question.isOther
              && values.some((answer) => !question.options.some((option) => option.label === answer)))) {
            throw failure("INTERACTION_RESPONSE_INVALID");
          }
          answers[question.questionId] = values;
        });
        params = { id: entry.row.id, answers: { answers } };
        expected = (result) => result?.status === "answered";
      }
    }
    let result;
    try { result = await this._request(method, params); }
    catch { return snapshot("unknown", "OPENCLAW_RESPONSE_UNCERTAIN"); }
    // Never return the question.resolve payload: it may contain secret answers.
    if (!expected(result)) return snapshot("unknown", "OPENCLAW_RESPONSE_UNCONFIRMED");
    const state = await this.inspect(target);
    if (state.attention?.request.requestId === input.requestId) {
      return { ...state, errorCode: "OPENCLAW_RESPONSE_UNCONFIRMED" };
    }
    return state;
  }

  async cancel(input) {
    const target = identity(input);
    let task;
    try { task = await this._task(target); }
    catch { return snapshot("unknown", "OPENCLAW_STOP_UNCONFIRMED"); }
    if (task && ["completed", "failed"].includes(taskSnapshot(task).status)) return this._terminalResult(taskSnapshot(task), target);
    let abort = null;
    try { abort = await this._request("chat.abort", { sessionKey: target.sessionKey, runId: target.runId }); }
    catch { /* Reconciliation below determines whether the run actually stopped. */ }
    if (task && task.status !== "cancelled") {
      try { await this._request("tasks.cancel", { taskId: task.taskId || task.id, reason: "Inspiration canceled by user" }); }
      catch { /* A terminal race is resolved through tasks.get, never RPC success. */ }
    }
    const state = await this.inspect(target);
    if (TERMINAL.has(state.status)) return state;
    if (!task && abort?.aborted === true && Array.isArray(abort.runIds) && abort.runIds.includes(target.runId)) {
      try { if (await this._inactive(target)) return snapshot("canceled"); } catch {}
    }
    return { ...state, errorCode: "OPENCLAW_STOP_UNCONFIRMED" };
  }
}

module.exports = { OpenClawInspirationAdapter };
