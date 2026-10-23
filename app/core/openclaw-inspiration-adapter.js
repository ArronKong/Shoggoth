"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");
const { gatewayResponseMetadata } = require("../chat-response-metadata");
const { GroupActivityProjection } = require("../agent-service/group-activity");
const { GroupPublicProgress } = require("../agent-service/group-public-progress");
const { groupCapabilities } = require("../agent-service/group-capabilities");
const {
  normalizeInteractiveRequestV1,
  validateInteractiveResponseV1,
} = require("./shoggoth-interaction-contract");

const TERMINAL = new Set(["completed", "failed", "canceled", "interrupted"]);
const FINAL_RESULT_GRACE_MS = 5000;
const FINAL_RESULT_RETENTION_MS = 5 * 60 * 1000;
const MAX_DRAFT_CHARS = 4000;
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
  "agent.wait": "operator.write",
};
// Gateway 2026.9.9 起不再提供任务账 RPC（tasks.*）。有任务账时沿用它读取运行的持久状态；没有时改用
// agent.wait 读一次运行的终态（Gateway 保留约 10 分钟），用 sessions.list 的 hasActiveRun 判断是否仍在
// 进行，取消只靠 chat.abort。两种方式二选一，按当前连接实际提供的方法决定。
const LEDGER_METHODS = Object.freeze(["tasks.list", "tasks.get", "tasks.cancel"]);
const WAIT_METHOD = "agent.wait";

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

// 会话 key 必须是本适配器按自己用途（inspiration / group）创建的那一种，两种用途互不通用。
function identity(input, purpose) {
  if (!input || typeof input.agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(input.agentId)
    || !string(input.sessionKey, 512)
    || !new RegExp(`^agent:${input.agentId}:dashboard:${purpose}-[a-f0-9]{64}$`, "u").test(input.sessionKey)
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

function finalResultText(payload, trim = false) {
  if (!Array.isArray(payload?.result?.payloads)) return null;
  const parts = payload.result.payloads.filter((item) => item && typeof item.text === "string"
    && item.isReasoning !== true && item.isCommentary !== true && item.isError !== true && item.text.trim())
    .map((item) => trim ? item.text.trim() : item.text);
  return parts.length ? parts.join("\n\n").toWellFormed().replace(/\0/gu, "\ufffd") : null;
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

// agent.wait 的结果：pending=仍在排队；ok / error / timeout 且带结束时间=终态；只有 runId 与
// status:"timeout" 表示这次查询没等到终态（仍在运行，或 Gateway 已没有这次运行的记录）。
function waitSnapshot(result) {
  const reply = result?.terminalReply?.disposition === "visible" && typeof result.terminalReply.text === "string"
    ? resultText(result.terminalReply.text) : "";
  if (result?.status === "pending") return snapshot("starting");
  if (result?.status === "ok") return snapshot("completed", null, reply);
  if (result?.status === "error") {
    return result.stopReason === "aborted" ? snapshot("canceled", null, reply)
      : snapshot("failed", "OPENCLAW_RUN_FAILED", reply);
  }
  if (result?.status === "timeout" && Number.isFinite(result.endedAt)) {
    return snapshot("failed", "OPENCLAW_RUN_TIMED_OUT", reply);
  }
  return null;
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
  constructor({ backend, now = Date.now, sessionPurpose = "inspiration" }) {
    if (!backend || typeof backend.request !== "function" || typeof now !== "function"
      || !["inspiration", "group"].includes(sessionPurpose)) {
      throw failure("OPENCLAW_ADAPTER_INVALID");
    }
    this.backend = backend;
    this.now = now;
    // 同一外部执行合同也服务群聊成员；会话 key / 标签按用途区分，便于在 OpenClaw 里辨认。
    this.sessionPurpose = sessionPurpose;
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
    // 没有任务账时，agent.wait 自带最终回复：原始 RPC 的终帧没观察到（例如 App 重启过）就用它。
    const resultSummary = (observation?.final ? observation.resultSummary : null)
      || (this._hasLedger() ? null : state.resultSummary || null);
    return { ...state, resultSummary,
      errorCode: state.status === "completed" && !resultSummary ? "OPENCLAW_RESULT_UNAVAILABLE" : state.errorCode };
  }

  async _ready() {
    if (typeof this.backend._connect === "function") await this.backend._connect();
  }

  _hasLedger() {
    return typeof this.backend.hasGatewayMethod !== "function"
      || LEDGER_METHODS.every((method) => this.backend.hasGatewayMethod(method));
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

  async prepare({ agentId, sessionId, sessionKey, workspace, modelSelection } = {}) {
    if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agentId)
      || (!sessionKey && !string(sessionId, 128))) throw failure("OPENCLAW_EXECUTION_IDENTITY_INVALID");
    await this._ready();
    // A run can ask a question or request execution approval at any time.
    const ledger = this._hasLedger();
    for (const method of Object.keys(METHOD_SCOPES)) {
      if (ledger ? method === WAIT_METHOD : LEDGER_METHODS.includes(method)) continue;
      this._require(method);
    }
    const resolved = await this._workspace(agentId, workspace);
    if (sessionKey) {
      identity({ agentId, sessionKey, runId: "prepare" }, this.sessionPurpose);
      if (modelSelection !== undefined) await this.backend.applyGroupSessionModel(agentId, sessionKey, modelSelection);
      return { sessionKey, workspace: resolved, mode: "openclaw" };
    }
    const suffix = createHash("sha256").update(sessionId).digest("hex");
    const purpose = this.sessionPurpose;
    sessionKey = `agent:${agentId}:dashboard:${purpose}-${suffix}`;
    const result = await this._request("sessions.create", {
      agentId, key: sessionKey, idempotencyKey: `${purpose}-session:${sessionId}`,
      label: `${purpose === "group" ? "Group" : "Inspiration"} ${suffix.slice(0, 12)}`,
    });
    if (result?.ok !== true || result.key !== sessionKey || result.runStarted === true) {
      throw failure("OPENCLAW_SESSION_IDENTITY_MISMATCH");
    }
    if (modelSelection !== undefined) await this.backend.applyGroupSessionModel(agentId, sessionKey, modelSelection);
    return { sessionKey, workspace: resolved, mode: "openclaw" };
  }

  async start(input, onUpdate = null) {
    const target = identity(input, this.sessionPurpose);
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
          invalid: false, resultSummary: null, completedAt: null, timer: null, draft: null, workspace: input.workspace };
        observation.activity = new GroupActivityProjection({ runId: target.runId,
          executionGeneration: String(this.backend._connectionGeneration ?? "bound") }, { now: this.now });
        observation.activity.setStream(`openclaw:${this.backend._connectionGeneration ?? "bound"}:${target.runId}`);
        observation.activitySeq = 0;
        observation.publicProgress = new GroupPublicProgress(); observation.publicParagraph = 0;
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
          onAssistant: data => {
            if (this.sessionPurpose !== "group" || this.observations.get(key) !== observation
              || observation.invalid || observation.final || observation.closed
              || data.isReasoning === true || ["analysis", "reasoning"].includes(data.phase) || data.delivery === "async") return;
            const previous = observation.publicProgress.items.get(String(observation.publicParagraph)) ?? "";
            const changedItem = data.itemId != null && observation.publicItemId != null && data.itemId !== observation.publicItemId;
            const incoming = typeof data.text === "string" ? data.text
              : typeof data.delta === "string" ? (data.replace === true || changedItem ? "" : previous) + data.delta
                : data.replace === true ? "" : null;
            if (incoming === null || !incoming.isWellFormed() || incoming.includes("\0")) return;
            if (data.replace === true || changedItem || previous && !incoming.startsWith(previous)) {
              observation.publicParagraph++; observation.publicCommentary = false;
            }
            observation.publicItemId = data.itemId ?? observation.publicItemId;
            observation.publicCommentary ||= data.isCommentary === true || data.phase === "commentary";
            observation.publicProgress.put(String(observation.publicParagraph), incoming);
            // data.text 已含 delta，不再追加；只保留显示尾部，完整最终正文仍由独立终态回执读取。
            const chars = Array.from(incoming);
            observation.draft = chars.length <= MAX_DRAFT_CHARS ? incoming
              : `…${chars.slice(-(MAX_DRAFT_CHARS - 1)).join("")}`;
            observation.activity.observeEvents([{ seq: ++observation.activitySeq, type: "text",
              payload: { itemId: "answer", text: incoming } }], observation.activity.streamGeneration);
          },
          onTool: data => {
            if (this.sessionPurpose !== "group" || this.observations.get(key) !== observation
              || observation.invalid || observation.final || observation.closed || !["start", "update", "result"].includes(data.phase)) return;
            observation.activity.observeEvents([{ seq: ++observation.activitySeq, type: `tool.${data.phase}`,
              payload: { toolCallId: data.toolCallId ?? data.id, tool: { name: data.name,
                input: data.args ?? data.input, output: data.result ?? data.output ?? data.partialResult, isError: data.isError,
                durationMs: data.durationMs ?? (Number.isFinite(data.durationS) && data.durationS >= 0 ? Math.round(data.durationS * 1000) : undefined) },
                progress: data.progress, message: data.message, changes: data.diff } }], observation.activity.streamGeneration);
          },
          onFinal: frame => {
            if (this.observations.get(key) !== observation || observation.final || observation.invalid) return;
            observation.closed = true;
            this._retainObservation(key, observation);
            const payload = frame?.payload;
            if (payload?.runId !== target.runId
              || (payload.sessionKey !== undefined && payload.sessionKey !== target.sessionKey)
              || (payload.agentId !== undefined && payload.agentId !== target.agentId)
              || !["ok", "error", "timeout"].includes(payload.status)) return;
            observation.final = true;
            observation.finalStatus = payload.status;
            observation.activity.observeStatus(payload.status === "ok" ? "completed" : "failed");
            observation.fullText = finalResultText(payload);
            const agentMeta = payload.result?.meta?.agentMeta;
            observation.responseMetadata = gatewayResponseMetadata({ role: "assistant", model: agentMeta?.model, usage: agentMeta?.usage });
            if (Number.isSafeInteger(agentMeta?.promptTokens) && agentMeta.promptTokens >= 0
              && Number.isSafeInteger(agentMeta?.contextTokens) && agentMeta.contextTokens > 0) {
              observation.responseMetadata ??= {};
              observation.responseMetadata.context = { usedTokens: agentMeta.promptTokens, windowTokens: agentMeta.contextTokens,
                quality: agentMeta.contextTokensSource === "runtime" ? "exact" : "estimated" };
            }
            observation.resultSummary = observation.fullText === null ? null : resultText(finalResultText(payload, true));
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
    observation?.activity.observeStatus("starting");
    return snapshot("starting");
  }

  async fullResult(input) {
    const target = identity(input, this.sessionPurpose);
    const observation = this.observations.get(this._observationKey(target));
    if (observation?.final && !observation.invalid && observation.finalStatus === "ok") return observation.fullText ?? null;
    await this._ready();
    if (this._hasLedger()) return null;
    const result = await this._request(WAIT_METHOD, { runId: target.runId, timeoutMs: 0 });
    if (result?.runId !== target.runId || (result.sessionKey !== undefined && result.sessionKey !== target.sessionKey)
      || result.status !== "ok" || result.terminalReply?.disposition !== "visible") return null;
    return typeof result.terminalReply.text === "string" ? result.terminalReply.text : null;
  }

  draft(input) {
    const target = identity(input, this.sessionPurpose);
    const observation = this.observations.get(this._observationKey(target));
    if (this.sessionPurpose !== "group" || !observation || observation.invalid || observation.closed || observation.final) return null;
    if (observation.draft === null && !observation.publicProgress.items.size) return null;
    const chars = Array.from(observation.publicProgress.text());
    return chars.length <= MAX_DRAFT_CHARS ? chars.join("") : `…${chars.slice(-(MAX_DRAFT_CHARS - 1)).join("")}`;
  }

  responseMetadata(input) {
    const target = identity(input, this.sessionPurpose);
    const observation = this.observations.get(this._observationKey(target));
    return observation?.final && !observation.invalid && observation.finalStatus === "ok"
      && observation.workspace === input.workspace ? structuredClone(observation.responseMetadata ?? null) : null;
  }

  activity(input) {
    const target = identity(input, this.sessionPurpose);
    const observation = this.observations.get(this._observationKey(target));
    return observation && !observation.invalid ? observation.activity?.snapshot() ?? null : null;
  }

  publicProgress(input) {
    const target = identity(input, this.sessionPurpose);
    const observation = this.observations.get(this._observationKey(target));
    if (this.sessionPurpose !== "group" || !observation || observation.invalid) return null;
    const current = String(observation.publicParagraph);
    const text = observation.publicProgress.items.get(current) ?? "";
    // Already visible paragraphs displaced by a new segment are process text.
    // The final streaming paragraph is omitted when the final answer contains it.
    const includeCurrent = observation.publicCommentary || observation.final && !(observation.fullText ?? "").startsWith(text);
    return observation.publicProgress.text(includeCurrent ? null : current);
  }

  async probe(input) {
    await this._ready();
    const ledger = this._hasLedger();
    const statusQuery = typeof this.backend.hasGatewayMethod === "function"
      && (ledger || this.backend.hasGatewayMethod(WAIT_METHOD)) && this.backend.hasGatewayMethod("sessions.list");
    const isolatedSession = typeof this.backend.hasGatewayMethod === "function" && this.backend.hasGatewayMethod("sessions.create");
    return groupCapabilities({ discussion: isolatedSession && this.backend.hasGatewayMethod("agent"), isolatedSession,
      collaborationSupport: this.sessionPurpose === "group" && isolatedSession && this.backend.hasGatewayMethod("agent"),
      formalTasks: statusQuery, workspaces: false, artifacts: true,
      textEvents: typeof this.backend.requestWithFinalObservation === "function",
      toolEvents: this.backend.groupActivityProtocolVersion === 2,
      interactive: typeof this.backend.hasGatewayMethod === "function"
        && this.backend.hasGatewayMethod("question.resolve") && this.backend.hasGatewayMethod("exec.approval.resolve"),
      preciseCancel: typeof this.backend.hasGatewayMethod === "function"
        && this.backend.hasGatewayMethod(ledger ? "tasks.cancel" : "chat.abort"),
      statusQuery, restartRecovery: statusQuery, steer: false, availability: "available",
      source: "external-binding", mode: "openclaw", checkedAt: this.now() });
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

  // 没有任务账时的运行状态：先问 agent.wait；没有终态就看原始 RPC 的终帧，再看会话是否还有运行。
  async _waitState(target) {
    const result = await this._request(WAIT_METHOD, { runId: target.runId, timeoutMs: 0 });
    if (result?.runId !== target.runId) throw failure("OPENCLAW_TASK_RESPONSE_INVALID");
    const settled = waitSnapshot(result);
    if (settled) return settled;
    const stored = this.observations.get(this._observationKey(target));
    if (stored?.final && !stored.invalid) {
      return stored.finalStatus === "ok" ? snapshot("completed")
        : snapshot("failed", stored.finalStatus === "timeout" ? "OPENCLAW_RUN_TIMED_OUT" : "OPENCLAW_RUN_FAILED");
    }
    if (await this._inactive(target)) return snapshot("unknown", "OPENCLAW_TASK_NOT_FOUND");
    // 原始请求的连接在终帧之前断过（或 App 重启后没有观察记录）时，会话「有运行」不代表是我们这次：
    // Gateway 重启后会用新的运行号自行恢复会话，原来那次运行的结果已经拿不到了。
    if ((!stored || (stored.closed && !stored.invalid)) && await this._superseded(target)) {
      return snapshot("unknown", "OPENCLAW_RUN_INTERRUPTED");
    }
    return snapshot("running");
  }

  // 会话里正在进行的运行不是我们发起的那一次。读不到就按「不是」处理，不误判。
  async _superseded(target) {
    try {
      if (this.backend.hasGatewayMethod?.("chat.history") === false
        || this.backend._hasGatewayScope?.("operator.read") === false) return false;
      const history = await this.backend.request("chat.history", { sessionKey: target.sessionKey, limit: 1 }, 15000);
      const active = history?.inFlightRun?.runId;
      return typeof active === "string" && active.length > 0 && active !== target.runId;
    } catch { return false; }
  }

  /** @returns {Promise<{task: object|null, state: object}>} 运行的当前状态；task 只在有任务账时存在。 */
  async _state(target) {
    if (!this._hasLedger()) return { task: null, state: await this._waitState(target) };
    const task = await this._task(target);
    return { task, state: task ? taskSnapshot(task) : snapshot("unknown", "OPENCLAW_TASK_NOT_FOUND") };
  }

  async _inactive(target, { allowAbsent = false } = {}) {
    const result = await this._request("sessions.list", { agentId: target.agentId, search: target.sessionKey, limit: 100 });
    if (!Array.isArray(result?.sessions) || result.truncated === true || result.hasMore === true || result.nextCursor) return false;
    const sessions = result.sessions.filter((session) => session?.key === target.sessionKey);
    return allowAbsent && sessions.length === 0 || sessions.length === 1 && sessions[0].hasActiveRun === false;
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
    const target = identity(input, this.sessionPurpose);
    try {
      const { state } = await this._state(target);
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
    const target = identity(input, this.sessionPurpose);
    if (TERMINAL.has((await this._state(target)).state.status)) throw failure("OPENCLAW_REQUEST_STALE");
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

  async cancel(input, { groupDeleted = false } = {}) {
    const target = identity(input, this.sessionPurpose);
    let task, before;
    try { ({ task, state: before } = await this._state(target)); }
    catch { return snapshot("unknown", "OPENCLAW_STOP_UNCONFIRMED"); }
    if (["completed", "failed"].includes(before.status)) return this._terminalResult(before, target);
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
    // A Host-sealed group cannot dispatch another turn. Its expired run receipt
    // may be discarded only after an exact no-op abort and an authoritative
    // inactive reading of the original dedicated group session.
    if (groupDeleted && this.sessionPurpose === "group" && !task && abort?.aborted === false
      && Array.isArray(abort.runIds) && abort.runIds.length === 0) {
      try { if (await this._inactive(target, { allowAbsent: true })) return snapshot("canceled"); } catch {}
    }
    return { ...state, errorCode: "OPENCLAW_STOP_UNCONFIRMED" };
  }
}

module.exports = { OpenClawInspirationAdapter };
