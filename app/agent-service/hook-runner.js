"use strict";
const { HOOK_LIMITS, safeJson, validateOutput, digest, fail, dataAccess, canonical } = require("./hook-contract");
const { hookMemoryRefs, projectHookMemoryOutput, projectHookMemoryEvent } = require("./hook-memory-projection");
function readPath(value, key) {
  let item = value;
  for (const part of key.split(".")) {
    if (!item || typeof item !== "object" || !Object.hasOwn(item, part)) return undefined;
    item = item[part];
  }
  return item;
}
function condition(config, payload) {
  let missing = false;
  const values = config.conditions.map(rule => {
    const actual = readPath(payload, rule.path), expected = rule.value;
    if (rule.op === "exists") return actual !== undefined;
    if (actual === undefined) { missing = true; return false; }
    if (["gt", "gte", "lt", "lte"].includes(rule.op) && (typeof actual !== "number" || typeof expected !== "number")) {
      missing = true; return false;
    }
    switch (rule.op) {
      case "eq": return canonical(actual) === canonical(expected);
      case "ne": return canonical(actual) !== canonical(expected);
      case "gt": return actual > expected; case "gte": return actual >= expected;
      case "lt": return actual < expected; case "lte": return actual <= expected;
      case "contains": return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
      case "in": return expected.some(value => canonical(value) === canonical(actual));
      default: fail("HOOK_INVALID");
    }
  });
  if (missing && config.missing !== "ignore") return { decision: "block", reason: "Hook 所需参数缺失或类型不符" };
  return { decision: (config.mode === "any" ? values.some(Boolean) : values.every(Boolean)) ? config.decision : "allow",
    reason: config.reason };
}
const REDACTION = Object.freeze({
  phone: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu,
  card: /(?<!\d)\d{13,19}(?!\d)/gu,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
});
const FACT_KEYS = new Set(["status", "success", "isError", "exitCode", "code", "id", "operationId", "artifactId", "callId"]);
function redact(value, config, key = "") {
  if (FACT_KEYS.has(key)) return structuredClone(value);
  if (typeof value === "string") return config.patterns.reduce((text, pattern) => text.replace(REDACTION[pattern], config.replacement || "[redacted]"), value);
  if (Array.isArray(value)) return value.map(item => redact(item, config));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, config, name)]));
  return value;
}
function builtin(definition, event) {
  const { name, config } = definition.handler;
  switch (name) {
    case "guard.block": return { decision: "block", reason: config.reason };
    case "guard.require_approval": return { decision: "require_approval", reason: config.reason };
    case "guard.condition": return condition(config, event.payload);
    case "arguments.patch": return { patch: structuredClone(config.patch) };
    case "result.redact": return { result: redact(event.payload.result, config) };
    case "context.literal": return { text: config.text };
    case "observe.record": return { tags: config.tags || [], event: event.event, eventId: event.eventId };
    default: fail("HOOK_HANDLER_UNAVAILABLE");
  }
}
class HookRunner {
  constructor({ store, processHost, now = Date.now }) {
    this.store = store; this.processHost = processHost; this.now = now;
    this.observerTail = Promise.resolve(); this.closed = false; this.observerCount = 0;
    this.active = new Set(); this.ephemeralOutputs = new Map();
  }
  open() { if (this.active.size || this.observerCount) fail("HOOK_CAPACITY"); this.closed = false; }
  async execute(snapshot, entry, event, context = {}) {
    const outerSignal = context.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) abort();
    let complete;
    const task = { runId: snapshot.runId, controller, done: new Promise(resolve => { complete = resolve; }) };
    this.active.add(task);
    context = { ...context, signal: controller.signal };
    try { return await this.executeOwned(snapshot, entry, event, context); }
    finally {
      outerSignal?.removeEventListener("abort", abort);
      this.active.delete(task); complete();
    }
  }
  async executeOwned(snapshot, entry, event, context) {
    const check = () => {
      if (this.closed) fail("HOOK_CANCELED");
      context.assertCurrent?.(); this.store.assertCurrent(snapshot, entry);
      if (context.signal?.aborted) fail("HOOK_CANCELED");
    };
    check();
    const refs = hookMemoryRefs(event), referenceOnly = refs.length > 0 || event.persistPolicy === "reference_only";
    const { execution, fresh } = this.store.beginExecution(snapshot, entry, event);
    if (!fresh) {
      if (execution.state === "settled") {
        if (execution.persistPolicy !== "reference_only") return structuredClone(execution.output);
        const cached = this.ephemeralOutputs.get(execution.id);
        if (!cached) fail("HOOK_EXECUTION_INTERRUPTED");
        return structuredClone(cached.output);
      }
      if (entry.definition.kind === "observe" && ["intent", "interrupted", "failed"].includes(execution.state)) {
        if ((execution.attempts || 1) >= 3) fail("HOOK_EXECUTION_INTERRUPTED");
      } else
      fail(execution.state === "needs_verification" ? "HOOK_NEEDS_VERIFICATION" : "HOOK_EXECUTION_INTERRUPTED");
    }
    let running = execution;
    try {
      const definition = entry.definition;
      if (definition.kind === "action") {
        if (!context.assertWritable) fail("HOOK_WRITE_FORBIDDEN");
        context.assertWritable();
      }
      running = this.store.settleExecution(execution, { state: "dispatched", attempts: (execution.attempts || 0) + 1,
        ...(referenceOnly ? { borrowedMemoryRefs: refs, persistPolicy: "reference_only" } : {}) });
      let output;
      if (definition.handler.type === "script" || ["workspace.copy", "context.file"].includes(definition.handler.name)) {
        const projection = dataAccess(definition).payload
          ? (definition.kind === "action" ? projectHookMemoryEvent(event) : event)
          : { ...event, payload: {} };
        output = await this.processHost.run(definition, projection, { ...context, sourceFile: entry.sourceFile, assertCurrent: check,
          onDispatch: worker => { running = this.store.settleExecution(running, worker); } });
      } else output = builtin(definition, event);
      output = validateOutput(definition, output); check();
      if (definition.kind === "action" && (output.sideEffect === "unknown" || output.status !== "completed")) fail("HOOK_NEEDS_VERIFICATION");
      if (referenceOnly) this.ephemeralOutputs.set(running.id, { runId: snapshot.runId, output: structuredClone(output) });
      this.store.settleExecution(running, { state: "settled", finishedAt: this.now(), output: projectHookMemoryOutput(output, refs, referenceOnly),
        outputDigest: digest(output), errorCode: null });
      return output;
    } catch (error) {
      this.store.settleExecution(running, { state: entry.definition.kind === "action" && running.state === "dispatched" ? "needs_verification" : "failed",
        finishedAt: this.now(), errorCode: /^HOOK_[A-Z_]+$/u.test(error.code || "") ? error.code : "HOOK_EXECUTION_FAILED" });
      throw error;
    }
  }
  async dispatch(snapshot, event, kind, context = {}) {
    if (!event || event.profileId !== snapshot.profileId || event.runId !== snapshot.runId
      || event.workspace !== snapshot.workspace || event.source !== snapshot.source
      || (event.causation?.depth ?? 0) > HOOK_LIMITS.depth) fail("HOOK_AUTHORITY_INVALID");
    const entries = this.store.select(snapshot, event, kind);
    if (entries.length > HOOK_LIMITS.perEvent) fail("HOOK_CAPACITY");
    if (!entries.length) return [];
    const input = safeJson(event);
    const results = [], started = context.startedAt || Date.now();
    for (const entry of entries) {
      if (Date.now() - started > HOOK_LIMITS.eventMs) fail("HOOK_TIMEOUT");
      let output;
      try { output = await this.execute(snapshot, entry, input, { ...context, remainingMs: HOOK_LIMITS.eventMs - (Date.now() - started) }); }
      catch (error) {
        if (kind !== "observe") throw error;
        this.lastObserverError = error.code || "HOOK_OBSERVER_FAILED";
        continue;
      }
      results.push({ hookId: entry.hookId, version: entry.version, output });
      if (kind === "guard" && output.decision === "block") break;
    }
    return results;
  }
  async before(snapshot, event, context) {
    const started = Date.now();
    let args = structuredClone(event.payload.arguments);
    const transformEntries = this.store.select(snapshot, event, "transform");
    if (transformEntries.length + this.store.select(snapshot, event, "guard").length > HOOK_LIMITS.perEvent) fail("HOOK_CAPACITY");
    for (const entry of transformEntries) {
      if (Date.now() - started >= HOOK_LIMITS.eventMs) fail("HOOK_TIMEOUT");
      const input = safeJson({ ...event, payload: { ...event.payload, arguments: args } });
      const output = await this.execute(snapshot, entry, input, { ...context, remainingMs: HOOK_LIMITS.eventMs - (Date.now() - started) });
      args = { ...args, ...output.patch };
    }
    const finalized = { ...event, payload: { ...event.payload, arguments: args } };
    const guards = await this.dispatch(snapshot, finalized, "guard", { ...context, startedAt: started });
    const blocked = guards.find(item => item.output.decision === "block");
    const approval = guards.find(item => item.output.decision === "require_approval");
    return { arguments: args, argumentDigest: digest(args), changed: digest(args) !== digest(event.payload.arguments),
      decision: blocked ? "block" : approval ? "require_approval" : "allow",
      reason: blocked?.output.reason ?? approval?.output.reason ?? null, guards };
  }
  async transformResult(snapshot, event, context) {
    const started = Date.now();
    let result = structuredClone(event.payload.result);
    const entries = this.store.select(snapshot, event, "transform");
    if (entries.length > HOOK_LIMITS.perEvent) fail("HOOK_CAPACITY");
    for (const entry of entries) {
      if (Date.now() - started >= HOOK_LIMITS.eventMs) fail("HOOK_TIMEOUT");
      const input = safeJson({ ...event, payload: { ...event.payload, result } });
      result = (await this.execute(snapshot, entry, input, { ...context, remainingMs: HOOK_LIMITS.eventMs - (Date.now() - started) })).result;
    }
    return result;
  }
  observe(snapshot, event, { recovering = false } = {}) {
    event = projectHookMemoryEvent(event);
    const entries = this.store.select(snapshot, event, "observe");
    if (!entries.length) return;
    if (!recovering && !entries.some(entry => dataAccess(entry.definition).payload)) event = { ...event, payload: {} };
    if (this.observerCount >= HOOK_LIMITS.queue) fail("HOOK_CAPACITY");
    const fresh = this.store.enqueueEvent(snapshot, safeJson(event));
    if (!fresh && !recovering) return;
    this.observerCount++;
    this.observerTail = this.observerTail.then(async () => {
      try { await this.dispatch(snapshot, event, "observe", {}); }
      catch (error) { this.lastObserverError = error.code || "HOOK_OBSERVER_FAILED"; }
      finally { try { this.store.finishEvent(event.eventId); } finally { this.observerCount--; } }
    }).catch(error => { this.lastObserverError = error.code || "HOOK_OBSERVER_FAILED"; });
  }
  recoverObservers() {
    for (const pending of this.store.pendingEvents()) {
      const snapshot = this.store.hydrate(pending.snapshot, { skipUnavailablePlugins: true,
        onSkipped: () => { this.lastObserverError = "HOOK_PLUGIN_OBSERVER_UNAVAILABLE"; } });
      if (!this.store.select(snapshot, pending.event, "observe").length) this.store.finishEvent(pending.event.eventId);
      else this.observe(snapshot, pending.event, { recovering: true });
    }
  }
  async drain() { await this.observerTail; }
  releaseRun(runId) {
    for (const [id, entry] of this.ephemeralOutputs) if (entry.runId === runId) this.ephemeralOutputs.delete(id);
  }
  async cancelRun(runId) {
    const tasks = [...this.active].filter(task => task.runId === runId);
    for (const task of tasks) task.controller.abort();
    await Promise.all(tasks.map(task => task.done)); this.releaseRun(runId);
  }
  async close() {
    this.closed = true;
    for (const task of this.active) task.controller.abort();
    await this.processHost?.close(); await Promise.all([...this.active].map(task => task.done)); await this.drain(); this.ephemeralOutputs.clear();
  }
}
module.exports = { HookRunner, evaluateHookCondition: condition, executeBuiltinHook: builtin };
