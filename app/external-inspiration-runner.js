"use strict";

const crypto = require("node:crypto");
const { validResponseMetadata } = require("./chat-response-metadata");
const { resultPage, validText } = require("./group-result-content");
const { OpenClawInspirationAdapter } = require("./core/openclaw-inspiration-adapter");
const { HermesInspirationAdapter } = require("./core/hermes-inspiration-adapter");
const { validateInteractiveResponseV1 } = require("./core/shoggoth-interaction-contract");
const { canonicalJson } = require("./agent-service/inspiration-store");
const { EXTERNAL_TERMINAL, validExternalSnapshot, validateExternalInspirationParams,
  validateExternalInspirationResult, validateGroupExternalResultParams } = require("./external-inspiration-protocol");

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
const identity = input => Object.fromEntries(["executionId", "runId", "backendId", "agentId"]
  .map(key => [key, input[key]]));
const binding = input => Object.fromEntries(["sessionKey", "workspace", "mode"].map(key => [key, input[key]]));
const { GroupActivityProjection, safeValue } = require("./agent-service/group-activity");
const { groupCapabilities } = require("./agent-service/group-capabilities");

function boundedText(value) {
  if (typeof value !== "string") return null;
  let result = "", bytes = 2;
  for (const char of value.toWellFormed().replace(/\0/gu, "\ufffd")) {
    const size = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + size > 16 * 1024) break;
    result += char;
    bytes += size;
  }
  return result;
}

/** Live transport observations only. Durable identity and results belong to the Service. */
class ExternalInspirationRunner {
  constructor({ registry, origin, adapters = {}, adapterOptions = {}, now = Date.now, randomUUID = crypto.randomUUID, onSnapshot = () => {} } = {}) {
    if (!registry || typeof registry.getBackend !== "function") throw new TypeError("registry required");
    this.onSnapshot = onSnapshot;
    this.registry = registry;
    this.origin = origin;
    this.adapters = adapters;
    this.adapterOptions = adapterOptions;
    this.now = now;
    this.randomUUID = randomUUID;
    this.hostId = randomUUID();
    this.records = new Map();
    this.drivers = new Map();
  }

  #validate(method, input) {
    const plain = { ...input };
    if (this.adapterOptions.sessionPurpose === "group" && method === "prepare") delete plain.context;
    const family = this.adapterOptions.sessionPurpose === "group" ? "group" : "inspiration";
    if (!validateExternalInspirationParams(`${family}.external.${method}`, plain)) fail("INVALID_PARAMS");
  }

  #driver(backendId) {
    const backend = this.registry.getBackend(backendId);
    if (!backend) fail("BACKEND_UNAVAILABLE");
    const cached = this.drivers.get(backendId);
    if (cached?.backend === backend) return cached.driver;
    const driver = this.adapters[backendId] || (backendId === "openclaw"
      ? new OpenClawInspirationAdapter({ ...this.adapterOptions, backend, now: this.now })
      : new HermesInspirationAdapter({ ...this.adapterOptions, backend, now: this.now }));
    this.drivers.set(backendId, { backend, driver });
    return driver;
  }

  #reserve(input, recovered = false) {
    if (this.records.size >= 8192) {
      for (const [id, record] of this.records) {
        if (EXTERNAL_TERMINAL.has(record.snapshot?.status)) { this.records.delete(id); break; }
      }
      if (this.records.size >= 8192) fail("APP_HOST_CAPACITY");
    }
    const record = { identity: identity(input), binding: recovered ? binding(input) : null,
      recovered, hostId: this.hostId, driver: this.#driver(input.backendId), snapshot: null,
      operations: new Map(), startCalled: recovered, startPending: false, startPromise: null,
      cancelRequested: false, inspection: null, observationVersion: 0 };
    this.records.set(input.executionId, record);
    if (recovered) this.#publish(record, { status: "unknown", errorCode: "EXTERNAL_EXECUTION_UNCONFIRMED" });
    return record;
  }

  #record(input, recover = false) {
    let record = this.records.get(input.executionId);
    if (!record && recover) record = this.#reserve(input, true);
    if (!record || hash(record.identity) !== hash(identity(input))
      || hash(record.binding) !== hash(binding(input))) fail("INSPIRATION_BINDING_INVALID");
    return record;
  }

  #publish(record, value) {
    if (record.hostId !== this.hostId || this.records.get(record.identity.executionId) !== record
      || EXTERNAL_TERMINAL.has(record.snapshot?.status)) return;
    record.observationVersion++;
    if (!value || typeof value !== "object") value = {};
    const at = this.now();
    const next = { ...record.identity, ...record.binding, status: value.status,
      sequence: (record.snapshot?.sequence ?? 0) + 1,
      resultSummary: boundedText(value.resultSummary),
      errorCode: value.errorCode ?? null, finishedAt: EXTERNAL_TERMINAL.has(value.status) ? at : null,
      attention: value.attention ? structuredClone(value.attention) : null };
    if (!validExternalSnapshot(next)) {
      Object.assign(next, { status: "unknown", errorCode: "EXTERNAL_OBSERVATION_INVALID",
        resultSummary: null, attention: null, finishedAt: null });
    }
    if (next.attention && (EXTERNAL_TERMINAL.has(next.status) || next.status === "unknown"
      || (next.attention.request.expiresAt !== null && next.attention.request.expiresAt <= at))) {
      next.attention.active = false;
    }
    if (record.snapshot && ["status", "resultSummary", "errorCode", "attention"]
      .every(key => hash(record.snapshot[key]) === hash(next[key]))) return;
    record.snapshot = next;
    try { this.onSnapshot(structuredClone(record.identity), structuredClone(next)); } catch { /* Durable host observers report failures through their own health checks. */ }
  }

  #assertCurrent(record) {
    if (record.hostId !== this.hostId || this.records.get(record.identity.executionId) !== record) {
      fail("APP_HOST_UNAVAILABLE");
    }
  }

  #result(record) {
    this.#assertCurrent(record);
    return structuredClone({ hostId: this.hostId, snapshot: record.snapshot });
  }

  #operation(record, method, input, action) {
    const key = `${method}:${input.operationId}`, fingerprint = hash(input);
    const previous = record.operations.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail("INSPIRATION_OPERATION_CONFLICT");
      if (method !== "cancel" || !previous.settled || EXTERNAL_TERMINAL.has(record.snapshot.status)) {
        return previous.promise.then(() => this.#result(record));
      }
    }
    if (!previous && record.operations.size >= 1024) fail("APP_HOST_CAPACITY");
    const operation = { fingerprint, promise: null, settled: false };
    const promise = Promise.resolve().then(() => { this.#assertCurrent(record); return action(); })
      .finally(() => { operation.settled = true; });
    operation.promise = promise; record.operations.set(key, operation);
    return promise.then(() => this.#result(record));
  }

  async prepare(input) {
    this.#validate("prepare", input);
    let record = this.records.get(input.executionId);
    const fingerprint = hash(input);
    if (record) {
      if (record.prepareFingerprint !== fingerprint) fail("INSPIRATION_OPERATION_CONFLICT");
      return structuredClone(await record.preparation);
    }
    record = this.#reserve(input);
    record.prepareFingerprint = fingerprint;
    record.preparation = Promise.resolve().then(() => {
      this.#assertCurrent(record);
      return record.driver.prepare({
        agentId: input.agentId, sessionId: input.executionId, sessionKey: input.sessionKey, workspace: input.workspace,
        ...(Object.hasOwn(input, "modelSelection") ? { modelSelection: input.modelSelection } : {}),
      });
    }).then(prepared => {
      this.#assertCurrent(record);
      const result = { hostId: this.hostId, binding: prepared };
      if (!validateExternalInspirationResult("inspiration.external.prepare", result)
        || (input.backendId === "openclaw") !== (prepared.mode === "openclaw")
        || (input.sessionKey !== null && prepared.sessionKey !== input.sessionKey)
        || (input.workspace !== null && prepared.workspace !== input.workspace)) fail("INSPIRATION_BINDING_INVALID");
      record.binding = structuredClone(prepared);
      this.#publish(record, { status: "queued" });
      return result;
    });
    return structuredClone(await record.preparation);
  }

  async start(input) {
    this.#validate("start", input);
    if (input.hostId !== this.hostId) fail("APP_HOST_UNAVAILABLE");
    const record = this.#record(input);
    return this.#operation(record, "start", input, () => {
      if (EXTERNAL_TERMINAL.has(record.snapshot?.status)) return;
      if (record.startCalled) fail("EXTERNAL_EXECUTION_UNCONFIRMED");
      record.startCalled = true;
      record.startPending = true;
      this.#publish(record, { status: "starting" });
      const version = record.observationVersion;
      record.startPromise = Promise.resolve().then(() => {
        this.#assertCurrent(record);
        if (record.cancelRequested) { this.#publish(record, { status: "canceled" }); return null; }
        return record.driver.start(input, value => this.#publish(record, value));
      }).then(value => {
        if (value && (record.observationVersion === version || EXTERNAL_TERMINAL.has(value.status))) this.#publish(record, value);
      }, () => {
        if (record.observationVersion === version) this.#publish(record, { status: "unknown", errorCode: "EXTERNAL_START_UNCONFIRMED" });
      }).finally(() => { record.startPending = false; }).catch(() => {});
    });
  }

  async get(input) {
    this.#validate("get", input);
    const record = this.#record(input, true);
    if (!record.startCalled || record.startPending || EXTERNAL_TERMINAL.has(record.snapshot.status)) return this.#result(record);
    if (!record.inspection) {
      const version = record.observationVersion;
      record.inspection = Promise.resolve().then(() => {
        this.#assertCurrent(record);
        return record.driver.inspect({ ...input, hostChanged: record.recovered });
      })
        .then(value => { if (record.observationVersion === version) this.#publish(record, value); }, () => {
          if (record.observationVersion === version) this.#publish(record, { status: "unknown", errorCode: "EXTERNAL_INSPECT_UNAVAILABLE" });
        }).finally(() => { record.inspection = null; });
    }
    await record.inspection;
    return this.#result(record);
  }

  /** 群聊：已开始执行的当前草稿（只读、来自传输适配器的累积文本；不支持的后端为 null）。 */
  async draft(input) {
    if (!validateExternalInspirationParams("group.external.get", input)) fail("INVALID_PARAMS");
    const record = this.#record(input, false);
    this.#assertCurrent(record);
    let value = null;
    try {
      // OpenClaw observes one socket/run/session/Agent binding; its draft read requires that same identity.
      value = record.driver.draft?.(record.identity.backendId === "openclaw" ? input : input.runId) ?? null;
    } catch { value = null; }
    return { hostId: this.hostId, draft: typeof value === "string" ? boundedText(value) : null };
  }

  /** Only read activity from this exact transport incarnation; never resume/start. */
  async activity(input) {
    if (!validateExternalInspirationParams("group.external.get", input)) fail("INVALID_PARAMS");
    const record = this.#record(input, false); this.#assertCurrent(record);
    const raw = await record.driver.activity?.(input) ?? null;
    this.#assertCurrent(record);
    record.activity ??= new GroupActivityProjection({ runId: input.runId, executionGeneration: this.hostId }, { now: this.now });
    if (raw) record.activity.adopt(raw);
    record.activity.observeStatus(record.snapshot?.status ?? "unknown", { at: record.snapshot?.finishedAt ?? this.now(),
      cancelRequested: record.cancelRequested });
    return { hostId: this.hostId, activity: record.activity.snapshot() };
  }

  async capabilities(input) {
    const driver = this.#driver(input.backendId);
    const value = await driver.probe?.(input) ?? {};
    return groupCapabilities({ ...value, groupTools: false, collaborationActions: false,
      source: "external-binding", checkedAt: this.now() });
  }

  /** 群聊的完整最终正文；适配器必须按本次运行取结果，不能回退到历史消息或有界摘要。 */
  async result(input) {
    if (!validateGroupExternalResultParams(input)) fail("INVALID_PARAMS");
    const { offset, digest, part, ...bound } = input;
    // Historical content reads must not reserve a recovered live execution or
    // publish an unknown status over the durable Host's terminal receipt.
    const record = this.records.has(bound.executionId) ? this.#record(bound) : null;
    const hostId = this.hostId, driver = record?.driver ?? this.#driver(bound.backendId);
    const assertCurrent = () => {
      if (hostId !== this.hostId) fail("APP_HOST_UNAVAILABLE");
      if (record) this.#assertCurrent(record);
      else if (this.records.has(bound.executionId)) fail("APP_HOST_UNAVAILABLE");
    };
    if (part === "progress") {
      const value = await driver.publicProgress?.(bound);
      assertCurrent();
      return { hostId: this.hostId, page: validText(value) ? resultPage(value, { offset, digest }) : null };
    }
    let text = record?.finalText;
    if (text === undefined) {
      const value = await driver.fullResult?.(bound);
      assertCurrent();
      if (!validText(value) || !value.trim()) return { hostId: this.hostId, page: null };
      text = value;
      if (record) record.finalText = value;
    }
    return { hostId: this.hostId, page: resultPage(text, { offset, digest }) };
  }

  /** Optional facts from this execution's final callback; never latest-session usage. */
  async metadata(input) {
    if (!validateExternalInspirationParams("group.external.get", input)) fail("INVALID_PARAMS");
    if (input.hostId !== this.hostId) fail("APP_HOST_UNAVAILABLE");
    const record = this.#record(input, false); this.#assertCurrent(record);
    if (!EXTERNAL_TERMINAL.has(record.snapshot?.status)) return { hostId: this.hostId, responseMetadata: null };
    if (!Object.hasOwn(record, "responseMetadata")) {
      const value = await record.driver.responseMetadata?.(input);
      this.#assertCurrent(record);
      record.responseMetadata = validResponseMetadata(value) ? structuredClone(value) : null;
    }
    return { hostId: this.hostId, responseMetadata: record.responseMetadata };
  }

  async respond(input) {
    this.#validate("respond", input);
    if (input.hostId !== this.hostId) fail("APP_HOST_UNAVAILABLE");
    const record = this.#record(input);
    return this.#operation(record, "respond", input, async () => {
      await this.get(Object.fromEntries(Object.entries(input).filter(([key]) => !["requestId", "response", "operationId"].includes(key))));
      this.#assertCurrent(record);
      const attention = record.snapshot.attention;
      if (!attention?.active || attention.request.requestId !== input.requestId
        || (attention.request.expiresAt !== null && attention.request.expiresAt <= this.now())) fail("INSPIRATION_REQUEST_EXPIRED");
      validateInteractiveResponseV1(attention.request, input.response);
      const version = record.observationVersion;
      try {
        const value = await record.driver.respond(input);
        if (record.observationVersion === version || EXTERNAL_TERMINAL.has(value?.status)) this.#publish(record, value);
      } catch {
        if (record.observationVersion === version) this.#publish(record, { status: "unknown", errorCode: "EXTERNAL_RESPONSE_UNCONFIRMED" });
      }
    });
  }

  async cancel(input, { groupDeleted = false } = {}) {
    this.#validate("cancel", input);
    if (input.hostId !== this.hostId) fail("APP_HOST_UNAVAILABLE");
    const record = this.#record(input, true);
    return this.#operation(record, "cancel", input, async () => {
      if (EXTERNAL_TERMINAL.has(record.snapshot.status)) return;
      record.cancelRequested = true;
      if (!record.startCalled) { this.#publish(record, { status: "canceled" }); return; }
      if (record.startPromise) await record.startPromise;
      this.#assertCurrent(record);
      if (EXTERNAL_TERMINAL.has(record.snapshot.status)) return;
      const version = record.observationVersion;
      try {
        const value = await record.driver.cancel(input, { groupDeleted });
        if (record.observationVersion === version || EXTERNAL_TERMINAL.has(value?.status)) this.#publish(record, value);
      } catch {
        if (record.observationVersion === version) this.#publish(record, { status: "unknown", errorCode: "EXTERNAL_CANCEL_UNCONFIRMED" });
      }
    });
  }

  reset() {
    this.hostId = this.randomUUID();
    for (const { driver } of this.drivers.values()) {
      try { driver.reset?.(); } catch { /* Transport observation cleanup cannot restart a run. */ }
    }
    this.records.clear();
    this.drivers.clear();
  }
}

module.exports = { ExternalInspirationRunner, boundedText };
