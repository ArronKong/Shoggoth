"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const {
  normalizeInteractiveRequestV1,
  validateInteractiveResponseV1,
} = require("./shoggoth-interaction-contract");

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const MODES = new Set(["gateway", "acp"]);
// Only this audited release's lazy+omit_messages branch is known to return
// before agent construction and auto-continue. Unknown releases may ignore the
// flags, so reject them BEFORE resume; this is deliberately not a >= range.
const LAZY_RESUME_RELEASE = { version: "0.21.0", release_date: "2026.8.31" };
const HISTORY_PAGE_SIZE = 500;

function adapterError(code) {
  return Object.assign(new Error(code), { code });
}

function validText(value, max = 128) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= max;
}

function snapshot(status, errorCode = null) {
  return { status, resultSummary: null, errorCode, attention: null };
}

function copy(value) { return structuredClone(value); }

function cleanCompletedHistory(payload, row) {
  const messages = payload?.messages;
  if (payload?.session_id !== row.id || !Array.isArray(messages)
    || !Number.isSafeInteger(row.message_count) || row.message_count < 2
    || row.message_count > HISTORY_PAGE_SIZE || messages.length !== row.message_count
    || payload.pagination?.limit !== HISTORY_PAGE_SIZE || payload.pagination?.offset !== 0
    || payload.pagination?.order !== "oldest" || payload.pagination?.returned !== messages.length) return false;
  let priorId = 0;
  let expected = "user";
  const pendingTools = new Set();
  const seenTools = new Set();
  for (const message of messages) {
    if (message.session_id !== row.id || !Number.isSafeInteger(message.id) || message.id <= priorId
      || message.active !== 1 || message.compacted !== 0 || message.display_kind
      || !["user", "assistant", "tool"].includes(message.role)) return false;
    priorId = message.id;
    const calls = message.tool_calls == null ? [] : message.tool_calls;
    if (!Array.isArray(calls)) return false;
    if (message.role === "user") {
      if (expected !== "user" || pendingTools.size || calls.length) return false;
      expected = "assistant";
    } else if (message.role === "assistant") {
      if (expected !== "assistant" || pendingTools.size) return false;
      if (calls.length) {
        for (const call of calls) {
          if (!validText(call?.id, 512) || seenTools.has(call.id)) return false;
          seenTools.add(call.id);
          pendingTools.add(call.id);
        }
        expected = "tool";
      } else {
        if (!["stop", "end_turn"].includes(message.finish_reason)) return false;
        expected = "user";
      }
    } else {
      if (expected !== "tool" || calls.length || !pendingTools.delete(message.tool_call_id)) return false;
      if (!pendingTools.size) expected = "assistant";
    }
  }
  return expected === "user" && !pendingTools.size && messages.at(-1)?.role === "assistant";
}

function resultSummary(value) {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) return null;
  if (Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(value.slice(0, middle).toWellFormed())) <= 16 * 1024) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low).toWellFormed();
}

/**
 * Hermes transport adapter. The Service owns durable execution records. This
 * instance only observes turns it actually submitted; losing it never licenses
 * replaying a prompt or treating a historical assistant message as its result.
 */
class HermesInspirationAdapter {
  constructor({ backend, now = Date.now } = {}) {
    if (!backend || typeof backend.createSession !== "function"
      || typeof backend.sendMessage !== "function" || typeof now !== "function") {
      throw new TypeError("HermesInspirationAdapter 配置无效");
    }
    this.backend = backend;
    this.now = now;
    this.preparations = new Map();
    this.sessions = new Map();
    this.runs = new Map();
  }

  async prepare({ agentId, sessionId, sessionKey: existingSessionKey = null, workspace = null }) {
    if (!validText(agentId) || !validText(sessionId)
      || (workspace !== null && (!validText(workspace, 4096) || !path.isAbsolute(workspace)))) {
      throw adapterError("HERMES_INSPIRATION_INVALID_REQUEST");
    }
    // Hermes cannot accept a client-selected stored id. sessionId is only the
    // caller's preparation identity; persist the returned canonical sessionKey
    // before start, and never retry a lost preparation on a replacement host.
    const key = JSON.stringify([agentId, sessionId]);
    const prior = this.preparations.get(key);
    if (prior) {
      if (prior.workspace !== workspace || prior.sessionKey !== existingSessionKey) {
        throw adapterError("HERMES_INSPIRATION_CONFLICT");
      }
      return copy(await prior.promise);
    }
    const preparation = { workspace, sessionKey: existingSessionKey, promise: null };
    preparation.promise = (async () => {
      if (existingSessionKey !== null) return this.#prepareExisting({ agentId, sessionKey: existingSessionKey, workspace });
      const sessionKey = await this.backend.createSession(agentId, { workspace, freezeWorkspace: true });
      this.#target({ agentId, sessionKey });
      const actualWorkspace = this.backend.sessionWorkspaceByKey?.get(sessionKey);
      const mode = this.backend.freshSessionTransports?.get(sessionKey);
      if (!validText(actualWorkspace, 4096) || !path.isAbsolute(actualWorkspace)
        || (workspace !== null && actualWorkspace !== workspace) || !MODES.has(mode)) {
        throw adapterError("HERMES_INSPIRATION_WORKSPACE_UNCONFIRMED");
      }
      const prepared = { sessionKey, workspace: actualWorkspace, mode };
      this.sessions.set(sessionKey, { ...prepared, agentId, generation: this.backend._lifecycleGeneration });
      return prepared;
    })();
    // Retain rejected preparation promises: another call must not mint an
    // orphan session after an ambiguous create response.
    this.preparations.set(key, preparation);
    return copy(await preparation.promise);
  }

  start(input, onSnapshot = () => {}) {
    this.#target(input);
    if (!validText(input.runId) || !validText(input.prompt, 64 * 1024)
      || typeof onSnapshot !== "function") throw adapterError("HERMES_INSPIRATION_INVALID_REQUEST");
    const fingerprint = JSON.stringify([input.agentId, input.sessionKey, input.workspace, input.prompt]);
    const prior = this.runs.get(input.runId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw adapterError("HERMES_INSPIRATION_CONFLICT");
      prior.listeners.add(onSnapshot);
      this.#notify(prior, onSnapshot);
      return copy(prior.snapshot);
    }
    const prepared = this.sessions.get(input.sessionKey);
    if (!prepared || prepared.agentId !== input.agentId || prepared.workspace !== input.workspace
      || prepared.generation !== this.backend._lifecycleGeneration) {
      throw adapterError("HERMES_INSPIRATION_SESSION_UNCONFIRMED");
    }
    // A follow-up may reuse the same inspiration session after its previous
    // turn is conclusively terminal. Never enqueue across an unresolved turn.
    if (prepared.runId && !TERMINAL.has(this.runs.get(prepared.runId)?.snapshot.status)) {
      throw adapterError("HERMES_INSPIRATION_CONFLICT");
    }
    prepared.runId = input.runId;
    const run = { ...input, mode: prepared.mode, generation: prepared.generation,
      fingerprint, listeners: new Set([onSnapshot]), snapshot: snapshot("starting"),
      requestSequence: 0, pending: null, settled: false, controlPending: false };
    this.runs.set(input.runId, run);
    this.#publish(run, run.snapshot);
    const progress = () => {
      if (run.snapshot.status === "starting") this.#publish(run, snapshot("running"));
    };
    const hooks = {
      delta: progress, interim: progress, thinking: progress, tool: progress, plan: progress, status: progress,
      final: (text, errored, meta) => {
        if (meta?.executionUncertain === true) {
          return this.#finish(run, snapshot("unknown", "HERMES_EXECUTION_UNCONFIRMED"));
        }
        if (errored) return this.#finish(run, snapshot("failed", "HERMES_EXECUTION_FAILED"));
        const value = snapshot(meta?.stopReason === "cancelled" ? "canceled" : "completed");
        value.resultSummary = resultSummary(text);
        this.#finish(run, value);
      },
      error: (_message, meta) => this.#finish(run, meta?.executionUncertain === true
        ? snapshot("unknown", "HERMES_EXECUTION_UNCONFIRMED")
        : snapshot("failed", "HERMES_EXECUTION_FAILED")),
      prompt: (prompt) => this.#prompt(run, prompt),
      promptExpire: ({ requestId } = {}) => {
        if (!run.pending || (requestId && requestId !== run.pending.upstreamRequestId)) return;
        run.pending = null;
        this.#publish(run, snapshot("running"));
      },
    };
    // Scheduling acknowledgement is deliberately separate from the eventual
    // turn result. Stable runId deduplicates within this backend incarnation.
    Promise.resolve().then(() => this.backend.sendMessage(
      run.sessionKey, run.prompt, run.runId, hooks, { requiredTransport: run.mode },
    )).then(() => {
      run.settled = true;
      if (!TERMINAL.has(run.snapshot.status)) {
        this.#publish(run, snapshot("unknown", "HERMES_EXECUTION_UNCONFIRMED"));
      }
    }, () => {
      run.settled = true;
      // Losing the transport Promise is not proof that the accepted model
      // turn stopped; retain the busy binding until a terminal is confirmed.
      this.#finish(run, snapshot("unknown", "HERMES_EXECUTION_UNCONFIRMED"));
    });
    return copy(run.snapshot);
  }

  async inspect(input) {
    this.#target(input);
    if (!validText(input.runId) || !MODES.has(input.mode)) {
      throw adapterError("HERMES_INSPIRATION_INVALID_REQUEST");
    }
    const run = this.#find(input);
    if (input.hostChanged || !run || !this.#generationMatches(run)) {
      return snapshot("unknown", "HERMES_EXECUTION_UNCONFIRMED");
    }
    return copy(run.snapshot);
  }

  async respond(input) {
    const run = this.#requireRun(input);
    const pending = run.pending;
    if (run.mode !== "gateway") throw adapterError("HERMES_ACP_INTERACTION_UNSUPPORTED");
    if (!pending || input.requestId !== pending.request.requestId || run.controlPending
      || !["waiting_input", "waiting_approval"].includes(run.snapshot.status)) {
      throw adapterError("HERMES_INTERACTION_STALE");
    }
    const response = validateInteractiveResponseV1(pending.request, input.response);
    if (response.choice === "cancel" || response.action === "cancel") return this.cancel(input);
    run.controlPending = true;
    try {
      const data = pending.kind === "approval"
        ? { kind: "approval", choice: response.choice, all: false }
        : { kind: pending.kind, requestId: pending.upstreamRequestId, value: response.answers.answer };
      const result = await this.backend.respondChatPrompt(run.sessionKey, data);
      if (result?.resolved === false || result?.ok === false) throw adapterError("HERMES_INTERACTION_STALE");
      if (run.pending === pending && !TERMINAL.has(run.snapshot.status)) {
        run.pending = null;
        this.#publish(run, snapshot("running"));
      }
      return copy(run.snapshot);
    } finally { run.controlPending = false; }
  }

  async cancel(input) {
    this.#target(input);
    const currentRunId = this.sessions.get(input.sessionKey)?.runId;
    if (currentRunId && currentRunId !== input.runId && !TERMINAL.has(this.runs.get(input.runId)?.snapshot.status)) {
      return snapshot("unknown", "HERMES_CANCELLATION_UNCONFIRMED");
    }
    const run = this.#find(input);
    if (!run || !this.#generationMatches(run)) {
      return input.mode === "gateway" ? this.#cancelGatewaySession(input)
        : snapshot("unknown", "HERMES_CANCELLATION_UNCONFIRMED");
    }
    if (TERMINAL.has(run.snapshot.status)) return copy(run.snapshot);
    if (run.controlPending) throw adapterError("HERMES_INSPIRATION_CONFLICT");
    if (run.settled || !this.#hasLiveTurn(run)) {
      run.controlPending = true;
      try {
        const verified = run.mode === "gateway" ? await this.#cancelGatewaySession(run)
          : snapshot("unknown", "HERMES_CANCELLATION_UNCONFIRMED");
        if (verified.status === "canceled") this.#finish(run, verified);
        return verified;
      } finally { run.controlPending = false; }
    }
    run.controlPending = true;
    try {
      await this.backend.abortChat(run.sessionKey);
      // abortChat is best effort; only the specific turn's cancelled terminal
      // hook confirms cancellation. Its RPC acknowledgement alone does not.
      if (TERMINAL.has(run.snapshot.status)) return copy(run.snapshot);
      const verified = run.mode === "gateway" ? await this.#cancelGatewaySession(run) : null;
      if (verified?.status === "canceled") this.#finish(run, verified);
      return TERMINAL.has(run.snapshot.status) ? copy(run.snapshot)
        : { ...copy(run.snapshot), errorCode: "HERMES_CANCELLATION_UNCONFIRMED" };
    } finally { run.controlPending = false; }
  }

  #target(input) {
    if (!validText(input?.agentId) || !validText(input?.sessionKey, 512)
      || !input.sessionKey.startsWith(`agent:${input.agentId}:`)
      || input.sessionKey === `agent:${input.agentId}:main`) {
      throw adapterError("HERMES_INSPIRATION_TARGET_MISMATCH");
    }
  }

  async #prepareExisting(input) {
    this.#target(input);
    const generation = this.backend._lifecycleGeneration;
    const known = this.sessions.get(input.sessionKey);
    if (known?.runId && !TERMINAL.has(this.runs.get(known.runId)?.snapshot.status)) {
      throw adapterError("HERMES_INSPIRATION_CONFLICT");
    }
    const { profile, dash, tail } = this.backend._sessionTarget(input.sessionKey);
    const token = dash.token;
    const assertIdentity = () => {
      const current = this.backend._sessionTarget(input.sessionKey);
      if (generation !== this.backend._lifecycleGeneration || current.profile !== profile
        || current.dash !== dash || dash.token !== token) {
        throw adapterError("HERMES_INSPIRATION_SESSION_UNCONFIRMED");
      }
    };
    const response = await this.backend._httpGetJson(
      `${dash.baseUrl}/api/sessions/${encodeURIComponent(tail)}?profile=${encodeURIComponent(profile)}`, dash.token,
    );
    if (response?.status !== 200 || !response.json || typeof response.json !== "object") {
      throw adapterError("HERMES_INSPIRATION_SESSION_UNCONFIRMED");
    }
    const row = response.json;
    if (row?.id !== tail || row.profile !== profile) throw adapterError("HERMES_INSPIRATION_TARGET_MISMATCH");
    let actualWorkspace = row.cwd;
    if (!actualWorkspace && row.source === "acp") {
      try { actualWorkspace = JSON.parse(row.system_prompt).cwd; } catch { /* missing ACP cwd */ }
    }
    if (!validText(actualWorkspace, 4096) || !path.isAbsolute(actualWorkspace)
      || (input.workspace !== null && input.workspace !== actualWorkspace)) {
      throw adapterError("HERMES_INSPIRATION_WORKSPACE_UNCONFIRMED");
    }
    const mode = known?.mode || this.backend.freshSessionTransports?.get(input.sessionKey)
      || (this.backend.acpSessionByKey?.has(input.sessionKey) ? "acp"
        : this.backend._gatewayChatEnabled(profile) ? "gateway" : "acp");
    if (mode === "gateway") {
      const socket = this.backend._gwSocket(profile, dash);
      let rows = this.#activeRows(await socket.request("session.active_list", {}));
      const socketGeneration = socket.generation;
      const assertCurrent = () => {
        assertIdentity();
        if (this.backend.gwSockets.get(profile) !== socket || socket.generation !== socketGeneration) {
          throw adapterError("HERMES_INSPIRATION_SESSION_UNCONFIRMED");
        }
      };
      assertCurrent();
      let matches = rows?.filter((value) => value.session_key === tail);
      if (matches?.length === 0) {
        rows = await this.#prepareLazySession({ input, row, profile, dash, socket, assertCurrent });
        matches = rows.filter((value) => value.session_key === tail);
      }
      if (matches?.length !== 1 || matches[0].status !== "idle"
        || rows.some((value) => value.id === matches[0].id && value.session_key !== tail)
        || this.backend.gwTurns?.has(matches[0].id)
        || [...this.backend.gwTurns.values()].some((turn) => turn.sessionKey === input.sessionKey)) {
        throw adapterError("HERMES_INSPIRATION_SESSION_UNCONFIRMED");
      }
      assertCurrent();
      const prior = this.backend.gwRuntimeByKey.get(input.sessionKey);
      const owner = this.backend.gwKeyByRuntime.get(matches[0].id);
      if ((owner && owner !== input.sessionKey) || (prior && (prior.profile !== profile
        || (prior.storedId && prior.storedId !== tail)))) {
        throw adapterError("HERMES_INSPIRATION_TARGET_MISMATCH");
      }
      // Only verified live evidence installs the mapping. A cold restore above
      // uses the audited lazy branch; ordinary resume can auto-run old work.
      if (prior?.runtimeId !== matches[0].id
        && this.backend.gwKeyByRuntime.get(prior?.runtimeId) === input.sessionKey) {
        this.backend.gwKeyByRuntime.delete(prior.runtimeId);
      }
      this.backend.gwRuntimeByKey.set(input.sessionKey, { ...prior, profile,
        runtimeId: matches[0].id, storedId: tail, generation: socket.generation });
      this.backend.gwKeyByRuntime.set(matches[0].id, input.sessionKey);
    } else if (!this.backend.acpSessionByKey?.has(input.sessionKey)
      || this.#hasLiveTurn({ ...input, mode })) {
      // ACP has no durable liveness query. A replacement host cannot prove an
      // orphaned subprocess has stopped just from its saved message history.
      throw adapterError("HERMES_INSPIRATION_SESSION_UNCONFIRMED");
    }
    assertIdentity();
    const prepared = { sessionKey: input.sessionKey, workspace: actualWorkspace, mode };
    this.backend.sessionWorkspaceByKey.set(input.sessionKey, actualWorkspace);
    this.sessions.set(input.sessionKey, { ...prepared, agentId: input.agentId,
      runId: known?.runId, generation });
    return prepared;
  }

  async #prepareLazySession({ input, row, profile, dash, socket, assertCurrent }) {
    const unconfirmed = () => adapterError("HERMES_INSPIRATION_SESSION_UNCONFIRMED");
    const hasLocalTurn = () => [...this.backend.gwTurns.values()]
      .some((turn) => turn.sessionKey === input.sessionKey);
    const prior = this.backend.gwRuntimeByKey.get(input.sessionKey);
    // Watch loading omits ancestors and stored runtime overrides. Admit only
    // a fully ended root conversation whose ordinary profile defaults still
    // match. It must never be used to repair an ambiguous previous execution.
    if (hasLocalTurn() || (prior && (prior.profile !== profile || (prior.storedId && prior.storedId !== row.id)))
      || row.parent_session_id !== null || row.end_reason !== "ws_orphan_reap"
      || !Number.isFinite(row.ended_at) || row.ended_at <= 0 || row.source !== "desktop") throw unconfirmed();
    let modelConfig = row.model_config;
    if (typeof modelConfig === "string") {
      try { modelConfig = JSON.parse(modelConfig); } catch { throw unconfirmed(); }
    }
    if (modelConfig != null && (typeof modelConfig !== "object" || Array.isArray(modelConfig)
      || Object.keys(modelConfig).length)) throw unconfirmed();
    const query = `profile=${encodeURIComponent(profile)}`;
    const read = async (endpoint) => {
      const result = await this.backend._httpGetJson(`${dash.baseUrl}${endpoint}`, dash.token);
      if (result?.status !== 200 || !result.json || typeof result.json !== "object") throw unconfirmed();
      return result.json;
    };
    const [server, capabilities, model, history] = await Promise.all([
      read(`/api/status?${query}`), socket.request("gateway.capabilities", {}),
      read(`/api/model/info?${query}`),
      read(`/api/sessions/${encodeURIComponent(row.id)}/messages?${query}&limit=${HISTORY_PAGE_SIZE}&offset=0&order=oldest`),
    ]);
    assertCurrent();
    if (server.version !== LAZY_RESUME_RELEASE.version || server.release_date !== LAZY_RESUME_RELEASE.release_date
      || capabilities?.per_session_exclusive_submit !== true
      || !validText(row.model, 512) || !validText(row.billing_provider, 512)
      || model.model !== row.model || model.provider !== row.billing_provider
      || !cleanCompletedHistory(history, row)) throw unconfirmed();
    const before = this.#activeRows(await socket.request("session.active_list", {}));
    assertCurrent();
    if (!before || before.some((value) => value.session_key === row.id) || hasLocalTurn()) throw unconfirmed();
    // This mutation only loads the exact stored conversation. The Service has
    // already persisted the explicit preparation intent; it persists dispatch
    // separately before start() is allowed to submit the new user prompt.
    const restored = await socket.request("session.resume", { session_id: row.id, profile,
      lazy: true, omit_messages: true, source: "desktop" });
    assertCurrent();
    if (!validText(restored?.session_id) || restored.resumed !== row.id || restored.session_key !== row.id
      || restored.info?.profile_name !== profile || restored.info?.cwd !== row.cwd
      || restored.info?.model !== row.model || restored.info?.lazy !== true
      || restored.status !== "idle" || restored.running !== false || restored.inflight !== null
      || restored.messages_omitted !== true || !Array.isArray(restored.messages) || restored.messages.length
      || restored.message_count !== row.message_count || Object.hasOwn(restored, "auto_continue")) throw unconfirmed();
    const after = this.#activeRows(await socket.request("session.active_list", {}));
    assertCurrent();
    const matches = after?.filter((value) => value.session_key === row.id);
    if (matches?.length !== 1 || matches[0].id !== restored.session_id || matches[0].status !== "idle"
      || hasLocalTurn()) throw unconfirmed();
    return after;
  }

  #find(input) {
    const run = this.runs.get(input.runId);
    return run && run.agentId === input.agentId && run.sessionKey === input.sessionKey
      && (input.mode === undefined || input.mode === run.mode) ? run : null;
  }

  #requireRun(input) {
    this.#target(input);
    const run = this.#find(input);
    if (!run || !this.#generationMatches(run)) throw adapterError("HERMES_EXECUTION_UNCONFIRMED");
    return run;
  }

  #generationMatches(run) { return run.generation === this.backend._lifecycleGeneration; }

  #hasLiveTurn(run) {
    const currentRunId = this.sessions.get(run.sessionKey)?.runId;
    if (currentRunId && run.runId && currentRunId !== run.runId) return false;
    if (run.mode === "gateway") {
      const mapping = this.backend.gwRuntimeByKey?.get(run.sessionKey);
      return !!mapping && this.backend.gwTurns?.has(mapping.runtimeId) === true;
    }
    const mapping = this.backend.acpSessionByKey?.get(run.sessionKey);
    const client = mapping && this.backend.acpClients?.get(mapping.profile);
    return !!client && client.updateHandlers?.has(mapping.acpSessionId) === true;
  }

  async #cancelGatewaySession(input) {
    const unknown = snapshot("unknown", "HERMES_CANCELLATION_UNCONFIRMED");
    try {
      const { profile, dash, tail } = this.backend._sessionTarget(input.sessionKey);
      const socket = this.backend._gwSocket(profile, dash);
      const list = async () => {
        const result = await socket.request("session.active_list", {});
        const rows = this.#activeRows(result);
        return rows?.filter((row) => row.session_key === tail) ?? null;
      };
      const before = await list();
      if (!before || before.length !== 1) return unknown;
      if (before[0].status === "idle") return unknown;
      const result = await socket.request("session.interrupt", { session_id: before[0].id });
      if (result?.status !== "interrupted" || result.interrupted === false) return unknown;
      const after = await list();
      if (after && (after.length === 0 || (after.length === 1 && after[0].status === "idle"))) {
        return snapshot("canceled");
      }
    } catch { /* Unsupported/partial discovery is not cancellation evidence. */ }
    return unknown;
  }

  #activeRows(result) {
    if (!Array.isArray(result?.sessions) || result.truncated === true || result.hasMore === true
      || result.sessions.some((row) => !validText(row?.id) || !validText(row?.session_key, 512)
        || !["idle", "starting", "working", "waiting"].includes(row.status))) return null;
    return result.sessions;
  }

  #prompt(run, payload) {
    if (TERMINAL.has(run.snapshot.status)) return;
    // Legacy Hermes approvals have no request id and resolve FIFO. A second
    // outstanding approval cannot replace the displayed card: doing so could
    // authorize an earlier command under the later command's explanation.
    if (run.interactionAmbiguous || (run.pending
      && (run.pending.kind === "approval" || payload?.kind === "approval"))) {
      run.interactionAmbiguous = true;
      run.pending = null;
      this.#publish(run, snapshot("unknown", "HERMES_INTERACTION_AMBIGUOUS"));
      return;
    }
    if (run.mode !== "gateway" || !["approval", "clarify", "sudo", "secret"].includes(payload?.kind)) {
      // Unsupported ACP permission payloads never enter the durable store.
      this.#publish(run, snapshot("unknown", run.mode === "acp"
        ? "HERMES_ACP_INTERACTION_UNSUPPORTED" : "HERMES_INTERACTION_UNSUPPORTED"));
      return;
    }
    try {
      const requestId = `hermes-${crypto.createHash("sha256")
        .update(`${run.runId}:${++run.requestSequence}`).digest("hex").slice(0, 40)}`;
      const kind = payload.kind;
      let request;
      if (kind === "approval") {
        const reason = payload.description || payload.command || "Hermes 请求运行工具";
        request = normalizeInteractiveRequestV1({ runId: run.runId, eventType: "approval",
          payload: { requestId, reason, redacted: payload.command !== undefined
            && !validText(payload.command, 8192) } });
        const offered = Array.isArray(payload.choices) ? payload.choices : ["once", "deny"];
        request = { ...request, approvalChoices: request.approvalChoices
          .filter((choice) => choice === "cancel" || offered.includes(choice)) };
      } else {
        const secret = kind === "sudo" || kind === "secret";
        if (!validText(payload.requestId) || (!secret && !validText(payload.question, 4096))) {
          throw adapterError("HERMES_INTERACTION_INVALID");
        }
        const choices = secret ? null : payload.choices;
        const field = { type: "string", title: secret ? "临时凭据" : "回答",
          ...(secret ? { writeOnly: true } : {}) };
        if (Array.isArray(choices) && choices.length) {
          if (choices.length < 2) throw adapterError("HERMES_INTERACTION_INVALID");
          field.enum = choices;
        }
        request = normalizeInteractiveRequestV1({ runId: run.runId, eventType: "prompt",
          payload: { requestId, message: secret
            ? kind === "sudo" ? "Hermes 需要管理员密码" : "Hermes 需要临时密钥"
            : payload.question,
            requestedSchema: { type: "object", properties: { answer: field }, required: ["answer"] } } });
      }
      run.pending = { kind, upstreamRequestId: payload.requestId || null, request };
      const value = snapshot(kind === "approval" ? "waiting_approval" : "waiting_input");
      value.attention = { request, active: true, occurredAt: this.now(),
        command: kind === "approval" && request.approvalChoices.includes("once")
          && validText(payload.command, 8192) ? payload.command : null,
        cwd: run.workspace, details: null };
      this.#publish(run, value);
    } catch {
      run.interactionAmbiguous = true;
      run.pending = null;
      this.#publish(run, snapshot("unknown", "HERMES_INTERACTION_INVALID"));
    }
  }

  #finish(run, value) {
    if (TERMINAL.has(run.snapshot.status)) return;
    run.pending = null;
    this.#publish(run, value);
  }

  #publish(run, value) {
    if (!this.#generationMatches(run)) value = snapshot("unknown", "HERMES_EXECUTION_UNCONFIRMED");
    run.snapshot = value;
    for (const listener of run.listeners) this.#notify(run, listener);
  }

  #notify(run, listener) {
    try { Promise.resolve(listener(copy(run.snapshot))).catch(() => {}); }
    catch { /* observer failure cannot replay a turn */ }
  }
}

module.exports = { HermesInspirationAdapter };
