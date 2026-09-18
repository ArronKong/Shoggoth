"use strict";

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { serviceError } = require("./security");

const EXTERNAL_BACKENDS = new Set(["openclaw", "hermes"]);
const ACTIVE_STATUSES = new Set(["starting", "running"]);
const WAITING_STATUSES = new Set(["waiting_approval", "waiting_input"]);
const TERMINAL_STATUSES = new Set([
  "completed", "failed", "canceled", "interrupted", "skipped",
]);
const TASK_STATUSES = new Set([
  "queued", ...ACTIVE_STATUSES, ...WAITING_STATUSES, ...TERMINAL_STATUSES,
]);
const TASK_GET_WAIT_STATUSES = new Set(["queued", ...ACTIVE_STATUSES]);
const HANDLE_VERSION = 1;
const MAX_TURNS = 32;
const DEFAULT_TASK_GET_WAIT_MS = 38_000;
const DEFAULT_TASK_GET_POLL_MS = 500;

function federationError(code, message = code) {
  return serviceError(code, message);
}

function requireMethods(value, methods, label) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`FederationCoordinator 需要 ${label}`);
  }
}

function bounded(value, maxBytes, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) return null;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); } catch {}
  }
  return "";
}

function ownObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function sameSignature(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  try { return a.length === b.length && crypto.timingSafeEqual(a, b); } finally {
    a.fill(0); b.fill(0);
  }
}

function publicNativeAgent(profile, status) {
  return {
    backendId: profile.backendId,
    agentId: profile.agentId,
    name: bounded(profile.name, 256) || profile.agentId,
    kind: "native",
    connected: profile.enabled === true && status?.connected === true && status.disabled === false,
    model: bounded(profile.defaultModel, 512, true),
    provider: bounded(profile.providerRef, 256, true),
  };
}

function publicExternalAgent(value, backendId) {
  const agentId = bounded(value?.id, 128);
  if (!agentId) throw federationError("FEDERATION_RESPONSE_INVALID");
  return {
    backendId,
    agentId,
    name: bounded(value?.name, 256) || agentId,
    kind: "external",
    connected: true,
    model: bounded(value?.model, 512, true),
    provider: bounded(value?.provider, 256, true),
  };
}

function publicTask(value) {
  const taskId = bounded(value?.taskId, 256);
  const sessionKey = bounded(value?.sessionKey, 512);
  if (!ownObject(value) || !TASK_STATUSES.has(value.status)
    || !taskId || taskId !== value.taskId
    || !sessionKey || sessionKey !== value.sessionKey
    || !Number.isSafeInteger(value.turn) || value.turn < 1 || value.turn > MAX_TURNS) {
    throw federationError("FEDERATION_RESPONSE_INVALID");
  }
  return {
    taskId,
    sessionKey,
    status: value.status,
    turn: value.turn,
    waitingFor: WAITING_STATUSES.has(value.status)
      ? value.status === "waiting_approval" ? "approval" : "input" : null,
    result: bounded(value.result ?? null, 32 * 1024, true),
    errorCode: bounded(value.errorCode ?? null, 128, true),
  };
}

class FederationCoordinator {
  constructor(options = {}) {
    requireMethods(options.productStore, ["listAgentProfiles", "getAgentProfile"], "ProductStore");
    requireMethods(options.federationClient, ["request"], "FederationHostClient");
    if (typeof options.getChatServiceController !== "function"
      || typeof options.getWorkRunCoordinator !== "function"
      || (options.now !== undefined && typeof options.now !== "function")
      || (options.randomUUID !== undefined && typeof options.randomUUID !== "function")
      || (options.taskGetWaitMs !== undefined
        && (!Number.isSafeInteger(options.taskGetWaitMs)
          || options.taskGetWaitMs < 0 || options.taskGetWaitMs > DEFAULT_TASK_GET_WAIT_MS))
      || (options.taskGetPollMs !== undefined
        && (!Number.isSafeInteger(options.taskGetPollMs)
          || options.taskGetPollMs < 1 || options.taskGetPollMs > 5_000))) {
      throw new TypeError("FederationCoordinator 配置无效");
    }
    let secret = options.handleSecret;
    if (secret === undefined && options.getHandleSecret === undefined) secret = crypto.randomBytes(32);
    if ((secret !== undefined && (!Buffer.isBuffer(secret) || secret.length !== 32))
      || (options.getHandleSecret !== undefined && typeof options.getHandleSecret !== "function")) {
      throw new TypeError("FederationCoordinator handle secret 无效");
    }
    this.productStore = options.productStore;
    this.federationClient = options.federationClient;
    this.getChatServiceController = options.getChatServiceController;
    this.getWorkRunCoordinator = options.getWorkRunCoordinator;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.taskGetWaitMs = options.taskGetWaitMs ?? DEFAULT_TASK_GET_WAIT_MS;
    this.taskGetPollMs = options.taskGetPollMs ?? DEFAULT_TASK_GET_POLL_MS;
    this.handleSecret = secret === undefined ? null : Buffer.from(secret);
    this.getHandleSecret = options.getHandleSecret || null;
    this.nativeLineages = new Map();
  }

  async list() {
    const statuses = await this.#backendStatuses();
    const native = this.#nativeProfiles().map((profile) => (
      publicNativeAgent(profile, statuses.get(profile.backendId))
    ));
    const externalIds = [...EXTERNAL_BACKENDS];
    const external = [];
    const unavailableBackends = new Set(native.filter((agent) => !agent.connected)
      .map((agent) => agent.backendId));
    for (const id of externalIds) {
      try {
        const result = await this.federationClient.request("agent.list", { backendId: id });
        if (!ownObject(result) || result.backendId !== id || !Array.isArray(result.agents)) {
          throw federationError("FEDERATION_RESPONSE_INVALID");
        }
        external.push(...result.agents.map((agent) => publicExternalAgent(agent, id)));
      } catch (error) {
        unavailableBackends.add(id);
      }
    }
    return {
      agents: [...native, ...external].sort((left, right) => (
        left.backendId.localeCompare(right.backendId)
        || left.name.localeCompare(right.name)
        || left.agentId.localeCompare(right.agentId)
      )),
      unavailableBackends: [...unavailableBackends],
    };
  }

  async get(args) {
    const target = await this.#target(args.backendId, args.agentId);
    return { agent: target.agent };
  }

  async run(args, authority) {
    const target = await this.#target(args.backendId, args.agentId);
    this.#assertNotSelf(target, authority);
    if (!target.agent.connected) throw federationError("BACKEND_UNAVAILABLE");
    if (target.kind === "external") {
      const result = await this.federationClient.request("federation.run", {
        backendId: args.backendId,
        agentId: args.agentId,
        prompt: args.prompt,
        timeoutMs: args.timeoutMs,
        operationId: args.operationId,
      });
      return this.#externalResult(result, target, authority);
    }
    const chat = this.#chat();
    const sessionResult = await chat.handle("chat.session.create", {
      operationId: `federation-create-${args.operationId}`,
      profileId: target.profile.id,
      workspace: null,
      createdAt: args.createdAt,
    });
    const sent = await chat.handle("chat.send", {
      operationId: `federation-send-${args.operationId}`,
      sessionKey: sessionResult.session.sessionKey,
      prompt: args.prompt,
      createdAt: args.createdAt,
    });
    const result = this.#nativeResult(
      target, sent.run, sessionResult.session.sessionKey, 1, authority,
    );
    this.#recordNativeLineage(result.task, authority);
    return result;
  }

  async message(args, authority) {
    const payload = this.#decodeHandle(args.handle, authority);
    if (payload.turn >= MAX_TURNS) throw federationError("FEDERATION_TURN_LIMIT");
    const target = await this.#target(payload.backendId, payload.agentId);
    this.#assertHandleTarget(payload, target);
    if (!target.agent.connected) throw federationError("BACKEND_UNAVAILABLE");
    if (target.kind === "external") {
      const result = await this.federationClient.request("federation.message", {
        backendId: payload.backendId,
        agentId: payload.agentId,
        taskId: payload.taskId,
        expectedTurn: payload.turn,
        prompt: args.message,
        timeoutMs: args.timeoutMs,
        operationId: args.operationId,
      });
      return this.#externalResult(result, target, authority);
    }
    const coordinator = this.#workRuns();
    this.#assertNativeLineage(payload, authority);
    const current = coordinator.getRun(payload.taskId);
    this.#assertNativeRun(current, target, payload.sessionKey);
    if (WAITING_STATUSES.has(current.status) || current.status === "queued") {
      throw federationError("FEDERATION_TARGET_WAITING");
    }
    if (ACTIVE_STATUSES.has(current.status)) {
      await this.#chat().handle("chat.steer", {
        operationId: `federation-steer-${args.operationId}`,
        sessionKey: payload.sessionKey,
        runId: current.id,
        message: args.message,
        createdAt: args.createdAt,
      });
      const result = this.#nativeResult(target, coordinator.getRun(current.id), payload.sessionKey,
        payload.turn + 1, authority);
      this.#recordNativeLineage(result.task, authority);
      return result;
    }
    const sent = await this.#chat().handle("chat.send", {
      operationId: `federation-message-${args.operationId}`,
      sessionKey: payload.sessionKey,
      prompt: args.message,
      createdAt: args.createdAt,
    });
    const result = this.#nativeResult(
      target, sent.run, payload.sessionKey, payload.turn + 1, authority,
    );
    this.#recordNativeLineage(result.task, authority);
    return result;
  }

  async taskGet(args, authority) {
    const payload = this.#decodeHandle(args.handle, authority);
    const target = await this.#target(payload.backendId, payload.agentId);
    this.#assertHandleTarget(payload, target);
    if (target.kind === "external") {
      return this.#waitForTask(async () => {
        const result = await this.federationClient.request("federation.task.get", {
          backendId: payload.backendId,
          agentId: payload.agentId,
          taskId: payload.taskId,
        });
        return this.#externalResult(result, target, authority, args.handle);
      });
    }
    this.#assertNativeLineage(payload, authority);
    const coordinator = this.#workRuns();
    return this.#waitForTask(() => {
      const run = coordinator.getRun(payload.taskId);
      this.#assertNativeRun(run, target, payload.sessionKey);
      return this.#nativeResult(
        target, run, payload.sessionKey, payload.turn, authority, args.handle,
      );
    });
  }

  async cancel(args, authority) {
    const payload = this.#decodeHandle(args.handle, authority);
    const target = await this.#target(payload.backendId, payload.agentId);
    this.#assertHandleTarget(payload, target);
    if (target.kind === "external") {
      const result = await this.federationClient.request("federation.task.cancel", {
        backendId: payload.backendId,
        agentId: payload.agentId,
        taskId: payload.taskId,
        operationId: args.operationId,
      });
      return this.#externalResult(result, target, authority);
    }
    this.#assertNativeLineage(payload, authority);
    let run = this.#workRuns().getRun(payload.taskId);
    this.#assertNativeRun(run, target, payload.sessionKey);
    if (!TERMINAL_STATUSES.has(run.status)) {
      const result = await this.#chat().handle("chat.abort", {
        operationId: `federation-cancel-${args.operationId}`,
        sessionKey: payload.sessionKey,
        runId: run.id,
        createdAt: args.createdAt,
      });
      run = result.run || this.#workRuns().getRun(run.id);
    }
    return this.#nativeResult(target, run, payload.sessionKey, payload.turn, authority, args.handle);
  }

  #nativeProfiles() {
    const profiles = this.productStore.listAgentProfiles();
    if (!Array.isArray(profiles)) throw federationError("FEDERATION_RESPONSE_INVALID");
    return profiles.filter((profile) => ownObject(profile) && profile.enabled === true
      && !EXTERNAL_BACKENDS.has(profile.backendId));
  }

  async #backendStatuses() {
    try {
      const result = await this.federationClient.request("backend.status", {});
      if (!ownObject(result) || !Array.isArray(result.backends)) return new Map();
      const statuses = new Map();
      for (const row of result.backends) {
        if (!ownObject(row) || typeof row.id !== "string" || statuses.has(row.id)
          || typeof row.connected !== "boolean" || typeof row.disabled !== "boolean") {
          return new Map();
        }
        statuses.set(row.id, row);
      }
      return statuses;
    } catch {
      // An enabled Profile survives disconnects and App exits. It cannot prove
      // a live connection; task reads/cancellation still use the durable run.
      return new Map();
    }
  }

  async #target(backendId, agentId) {
    const matches = this.#nativeProfiles().filter((profile) => (
      profile.backendId === backendId && profile.agentId === agentId
    ));
    if (matches.length > 1) throw federationError("FEDERATION_RESPONSE_INVALID");
    if (matches.length === 1) {
      const statuses = await this.#backendStatuses();
      return { kind: "native", profile: matches[0],
        agent: publicNativeAgent(matches[0], statuses.get(backendId)) };
    }
    if (!EXTERNAL_BACKENDS.has(backendId)) throw federationError("AGENT_NOT_FOUND");
    const result = await this.federationClient.request("agent.get", { backendId, agentId });
    if (!ownObject(result) || !ownObject(result.agent) || result.agent.id !== agentId) {
      throw federationError("FEDERATION_RESPONSE_INVALID");
    }
    return { kind: "external", profile: null, agent: publicExternalAgent(result.agent, backendId) };
  }

  #chat() {
    const value = this.getChatServiceController();
    requireMethods(value, ["handle"], "ChatServiceController");
    return value;
  }

  #workRuns() {
    const value = this.getWorkRunCoordinator();
    requireMethods(value, ["getRun"], "WorkRunCoordinator");
    return value;
  }

  async #waitForTask(read) {
    let result = await read();
    if (this.taskGetWaitMs === 0 || !TASK_GET_WAIT_STATUSES.has(result.task.status)) {
      return result;
    }
    const deadline = performance.now() + this.taskGetWaitMs;
    while (TASK_GET_WAIT_STATUSES.has(result.task.status)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.taskGetPollMs, remaining)));
      result = await read();
    }
    return result;
  }

  #principal(authority) {
    return authority.federationClient
      ? `external:${authority.federationClient}` : `native:${authority.profileId}`;
  }

  #assertNotSelf(target, authority) {
    if (!authority.federationClient && target.kind === "native"
      && target.profile.id === authority.profileId) {
      throw federationError("FEDERATION_SELF_DISPATCH");
    }
  }

  #assertHandleTarget(payload, target) {
    if (payload.kind !== target.kind
      || (target.kind === "native" && payload.profileId !== target.profile.id)
      || (target.kind === "external" && payload.profileId !== null)) {
      throw federationError("FEDERATION_HANDLE_STALE");
    }
  }

  #assertNativeRun(run, target, sessionKey) {
    if (!ownObject(run) || run.id === undefined || run.profileId !== target.profile.id
      || run.source !== "chat" || run.sourceId !== sessionKey || !TASK_STATUSES.has(run.status)) {
      throw federationError("FEDERATION_HANDLE_STALE");
    }
  }

  #nativeLineageKey(principal, sessionKey) {
    return `${principal}\0${sessionKey}`;
  }

  #assertNativeLineage(payload, authority) {
    const key = this.#nativeLineageKey(this.#principal(authority), payload.sessionKey);
    const current = this.nativeLineages.get(key);
    if (current && (current.taskId !== payload.taskId || current.turn !== payload.turn)) {
      throw federationError("FEDERATION_HANDLE_STALE");
    }
    if (!current) this.#storeNativeLineage(key, payload.taskId, payload.turn);
  }

  #recordNativeLineage(task, authority) {
    const key = this.#nativeLineageKey(this.#principal(authority), task.sessionKey);
    this.#storeNativeLineage(key, task.taskId, task.turn);
  }

  #storeNativeLineage(key, taskId, turn) {
    if (!this.nativeLineages.has(key) && this.nativeLineages.size >= 4096) {
      this.nativeLineages.delete(this.nativeLineages.keys().next().value);
    }
    this.nativeLineages.set(key, { taskId, turn });
  }

  #nativeResult(target, run, sessionKey, turn, authority, existingHandle = null) {
    this.#assertNativeRun(run, target, sessionKey);
    const task = publicTask({
      taskId: run.id,
      sessionKey,
      status: run.status,
      turn,
      result: run.resultSummary ?? null,
      errorCode: run.errorCode ?? null,
    });
    const payload = this.#handlePayload(target, task, turn, authority);
    return { agent: target.agent, task, handle: existingHandle || this.#encodeHandle(payload) };
  }

  #externalResult(result, target, authority, existingHandle = null) {
    if (!ownObject(result) || !ownObject(result.task)) {
      throw federationError("FEDERATION_RESPONSE_INVALID");
    }
    const task = publicTask(result.task);
    const payload = this.#handlePayload(target, task, task.turn, authority);
    return { agent: target.agent, task, handle: existingHandle || this.#encodeHandle(payload) };
  }

  #handlePayload(target, task, turn, authority) {
    const issuedAt = this.now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw federationError("FEDERATION_RESPONSE_INVALID");
    }
    return {
      v: HANDLE_VERSION,
      principal: this.#principal(authority),
      kind: target.kind,
      backendId: target.agent.backendId,
      agentId: target.agent.agentId,
      profileId: target.kind === "native" ? target.profile.id : null,
      sessionKey: task.sessionKey,
      taskId: task.taskId,
      turn,
      issuedAt,
    };
  }

  #encodeHandle(payload) {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = crypto.createHmac("sha256", this.#secret())
      .update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  #decodeHandle(handle, authority) {
    if (typeof handle !== "string" || handle.length < 80 || handle.length > 2048) {
      throw federationError("FEDERATION_HANDLE_INVALID");
    }
    const parts = handle.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/u.test(parts[0])
      || !/^[A-Za-z0-9_-]{43}$/u.test(parts[1])) {
      throw federationError("FEDERATION_HANDLE_INVALID");
    }
    const expected = crypto.createHmac("sha256", this.#secret())
      .update(parts[0]).digest("base64url");
    if (!sameSignature(parts[1], expected)) throw federationError("FEDERATION_HANDLE_INVALID");
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch {
      throw federationError("FEDERATION_HANDLE_INVALID");
    }
    const fields = ["v", "principal", "kind", "backendId", "agentId", "profileId",
      "sessionKey", "taskId", "turn", "issuedAt"];
    if (!ownObject(payload) || Object.keys(payload).sort().join(",") !== fields.sort().join(",")
      || payload.v !== HANDLE_VERSION || !["native", "external"].includes(payload.kind)
      || typeof payload.backendId !== "string" || typeof payload.agentId !== "string"
      || (payload.profileId !== null && typeof payload.profileId !== "string")
      || typeof payload.sessionKey !== "string" || typeof payload.taskId !== "string"
      || !Number.isSafeInteger(payload.turn) || payload.turn < 1 || payload.turn > MAX_TURNS
      || !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt < 0) {
      throw federationError("FEDERATION_HANDLE_INVALID");
    }
    if (payload.principal !== this.#principal(authority)) {
      throw federationError("FEDERATION_HANDLE_FORBIDDEN");
    }
    return payload;
  }

  #secret() {
    if (this.handleSecret) return this.handleSecret;
    let value;
    try { value = this.getHandleSecret(); } catch {
      throw federationError("FEDERATION_HANDLE_UNAVAILABLE");
    }
    if (!Buffer.isBuffer(value) || value.length !== 32) {
      if (Buffer.isBuffer(value)) value.fill(0);
      throw federationError("FEDERATION_HANDLE_UNAVAILABLE");
    }
    this.handleSecret = Buffer.from(value);
    value.fill(0);
    return this.handleSecret;
  }
}

module.exports = { FederationCoordinator, MAX_TURNS, TASK_STATUSES };
