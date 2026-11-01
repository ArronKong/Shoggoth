"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");
const { APPLE_DEVICE_METHODS, APPLE_DEVICE_RESOURCES, TOOL_OPERATIONS, isWriteOperation,
  validateAppleDeviceParams, validateAppleDeviceResult, validateAppleDeviceOperationParams,
  validateAppleDeviceInvokeParams, validateAppleDeviceInvokeResult, validateAppleDeviceWriteReceipt, validateAppleDevicePolicyState } = require("../core/apple-device-contract");

const copy = value => JSON.parse(JSON.stringify(value));
const fail = (code, message = code) => { throw serviceError(code, message); };
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const MAX_LEDGER_ENTRIES = 4096;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const LEDGER_STATES = ["pending", "unknown", "complete", "error"];
const SHA = /^[a-f0-9]{64}$/u;
const ERROR = /^APPLE_DEVICE_[A-Z0-9_]{1,80}$/u;
const plain = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const defaultPolicy = () => ({ enabled: false, readPolicy: "ask", writePolicy: "ask", disabledProfileIds: [] });
const defaultState = () => ({ schemaVersion: 2, revision: 1, resources: { calendar: defaultPolicy(), reminders: defaultPolicy() } });
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function identityFor(context) {
  const value = context?.identity;
  if (!plain(value)) fail("APPLE_DEVICE_IDENTITY_REQUIRED");
  const required = ["backendId", "agentId", "sessionId", "profileId", "callId"];
  for (const key of required) {
    if (typeof value[key] !== "string" || !value[key].trim() || Buffer.byteLength(value[key]) > (key === "sessionId" ? 4096 : 256)
      || /[\u0000-\u001f\u007f]/u.test(value[key])) fail("APPLE_DEVICE_IDENTITY_REQUIRED");
  }
  if (!["shoggoth", "openclaw", "hermes"].includes(value.backendId)
    || context.profileId !== value.profileId || context.callId !== undefined && context.callId !== value.callId
    || value.runId != null && (typeof value.runId !== "string" || !value.runId.trim() || value.runId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.runId))) fail("APPLE_DEVICE_IDENTITY_REQUIRED");
  return Object.fromEntries([...required, "runId"].map(key => [key, value[key] ?? null]));
}
function unavailableStatus(code = "APPLE_DEVICE_HOST_UNAVAILABLE") {
  return { available: false, errorCode: ERROR.test(code) ? code : "APPLE_DEVICE_HOST_UNAVAILABLE",
    resources: APPLE_DEVICE_RESOURCES.map(id => ({ id, authorization: "unavailable" })) };
}
function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(serviceError("APPLE_DEVICE_CANCELED", "设备操作已取消。")); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}
function approvalReason(operation, write) {
  const calendar = operation.startsWith("calendar.");
  const resource = calendar ? "日历" : "提醒事项";
  if (!write) return `${resource}读取设置为“每次询问”，请批准本次具体读取。`;
  const action = { create: "创建", update: "修改", delete: "删除" }[operation.split(".")[1]];
  return `本次操作将在此 Mac 的${resource}中${action}${calendar ? "日程" : "提醒事项"}，请核对具体内容后批准。`;
}
function reviewCurrent(resource, current, patch) {
  const fields = resource === "calendar" ? ["id", "calendarId", "title", "start", "end", "allDay", "timeZone", "recurring", "revision"]
    : ["id", "listId", "title", "due", "priority", "completed", "revision"];
  // A notes edit needs its actual before/after content. Unchanged long notes
  // should not obscure the event/time or inflate an unrelated approval card.
  return Object.fromEntries([...new Set([...fields, ...Object.keys(patch || {})])].map(key => [key, copy(current[key])]));
}

class AppleDeviceController {
  constructor({ paths, host, getSubjects = async () => ({ items: [], unavailableBackends: [] }), requestApproval } = {}) {
    if (!paths?.stateDir || !host || typeof host.request !== "function") throw new TypeError("Apple device paths and host are required");
    Object.assign(this, { paths, host, getSubjects, requestApproval });
    this.policyPath = path.join(paths.stateDir, "apple-device-policy.json");
    this.ledgerPath = path.join(paths.stateDir, "apple-device-write-ledger.json");
    this.closed = true; this.state = defaultState(); this.ledger = new Map(); this.generations = new Map(APPLE_DEVICE_RESOURCES.map(id => [id, 0]));
    this.resourceControllers = new Map();
    this.mutationQueue = Promise.resolve(); this.pendingWrites = new Map(); this.active = new Set();
  }
  open() {
    if (!this.closed) return this;
    let state = defaultState(); const ledger = new Map();
    try {
      if (recoverInterruptedPrivateFile(this.policyPath, { trustedRoot: this.paths.trustedRoot }) === "uncertain") throw new Error("uncertain policy commit");
      if (lstatIfExists(this.policyPath)) {
        // Version 1 had fixed per-write approval. Normalize it to ask in memory;
        // the next real policy edit persists version 2 without widening access.
        state = validateAppleDevicePolicyState(JSON.parse(readPrivateFile(this.policyPath, { maxBytes: 1024 * 1024 }).toString("utf8")));
      }
    } catch { fail("APPLE_DEVICE_POLICY_CORRUPT"); }
    try {
      if (recoverInterruptedPrivateFile(this.ledgerPath, { trustedRoot: this.paths.trustedRoot }) === "uncertain") throw new Error("uncertain ledger commit");
      if (lstatIfExists(this.ledgerPath)) {
        const stored = JSON.parse(readPrivateFile(this.ledgerPath, { maxBytes: MAX_LEDGER_BYTES }).toString("utf8"));
        if (!exact(stored, ["schemaVersion", "entries"]) || stored.schemaVersion !== 1 || !Array.isArray(stored.entries) || stored.entries.length > MAX_LEDGER_ENTRIES) throw new Error("ledger");
        for (const entry of stored.entries) {
          if (!exact(entry, ["key", "fingerprint", "operation", "operationId", "state", "result", "errorCode"])
            || !SHA.test(entry.key) || !SHA.test(entry.fingerprint) || !isWriteOperation(entry.operation)
            || entry.operationId !== `apple-write-${hash(`${entry.key}:${entry.fingerprint}`)}` || !LEDGER_STATES.includes(entry.state)
            || ledger.has(entry.key)) throw new Error("ledger");
          if (entry.state === "complete") {
            if (entry.errorCode !== null) throw new Error("ledger");
            validateAppleDeviceWriteReceipt(entry.operation, entry.result);
          } else if (entry.result !== null || entry.state === "error" && !ERROR.test(entry.errorCode || "")
            || entry.state !== "error" && entry.errorCode !== null) throw new Error("ledger");
          ledger.set(entry.key, { ...entry, state: entry.state === "pending" ? "unknown" : entry.state });
        }
      }
    } catch { fail("APPLE_DEVICE_LEDGER_CORRUPT"); }
    this.state = copy(state); this.ledger = ledger; this.lifecycle = new AbortController();
    this.resourceControllers = new Map(APPLE_DEVICE_RESOURCES.map(id => [id, new AbortController()])); this.closed = false;
    return this;
  }
  assertOpen() { if (this.closed) fail("APPLE_DEVICE_UNAVAILABLE"); }
  stopAdmission() { this.closed = true; this.lifecycle?.abort(); for (const controller of this.resourceControllers.values()) controller.abort(); }
  invalidateResource(resource) {
    this.generations.set(resource, this.generations.get(resource) + 1);
    this.resourceControllers.get(resource)?.abort();
    this.resourceControllers.set(resource, new AbortController());
  }
  async close() {
    this.stopAdmission();
    await Promise.allSettled([this.mutationQueue, ...this.active]);
  }
  mutate(action) {
    const pending = this.mutationQueue.catch(() => {}).then(() => { this.assertOpen(); return action(); });
    this.mutationQueue = pending; return pending;
  }
  expectRevision(value) { if (this.state.revision !== value) fail("APPLE_DEVICE_REVISION_CONFLICT"); }
  nextRevision() { if (this.state.revision >= Number.MAX_SAFE_INTEGER) fail("APPLE_DEVICE_POLICY_CORRUPT"); return this.state.revision + 1; }
  persistState(next) {
    try { atomicWritePrivateFile(this.policyPath, `${JSON.stringify(next)}\n`, { trustedRoot: this.paths.trustedRoot }); }
    catch (error) {
      // If commit durability is uncertain, no admission may use a stale allow.
      if (error.committed || error.committedUncertain) this.stopAdmission();
      fail("APPLE_DEVICE_POLICY_WRITE_FAILED");
    }
    this.state = next;
  }
  persistLedger(next) {
    if (next.size > MAX_LEDGER_ENTRIES) fail("APPLE_DEVICE_LEDGER_FULL");
    const raw = `${JSON.stringify({ schemaVersion: 1, entries: [...next.values()] })}\n`;
    if (Buffer.byteLength(raw) > MAX_LEDGER_BYTES) fail("APPLE_DEVICE_LEDGER_FULL");
    try { atomicWritePrivateFile(this.ledgerPath, raw, { trustedRoot: this.paths.trustedRoot }); }
    catch (error) {
      if (error.committed || error.committedUncertain) this.stopAdmission();
      fail("APPLE_DEVICE_LEDGER_WRITE_FAILED");
    }
    this.ledger = next;
  }
  saveEntry(entry) { const next = new Map(this.ledger); next.set(entry.key, copy(entry)); this.persistLedger(next); }
  async invoke(operation, params = {}, operationId = null, signal = this.lifecycle?.signal) {
    const envelope = validateAppleDeviceInvokeParams({ operation, params, operationId });
    if (signal?.aborted) fail("APPLE_DEVICE_CANCELED");
    const result = await abortable(this.host.request("apple.device.invoke", envelope, { signal }), signal);
    try { return validateAppleDeviceInvokeResult(operation, result); }
    catch { fail("APPLE_DEVICE_INVALID_HOST_RESULT"); }
  }
  async hostStatus() {
    try { return await this.invoke("status"); }
    catch (error) { return unavailableStatus(error?.code); }
  }
  publicStatus(native) {
    return validateAppleDeviceResult("connector.apple.status", { revision: this.state.revision, ...native,
      resources: APPLE_DEVICE_RESOURCES.map(id => ({ ...native.resources.find(r => r.id === id), ...copy(this.state.resources[id]) })) });
  }
  async status() { this.assertOpen(); return this.publicStatus(await this.hostStatus()); }
  async connect(input) {
    const params = validateAppleDeviceParams("connector.apple.connect", input);
    this.assertOpen(); this.expectRevision(params.expectedRevision);
    const signal = AbortSignal.any([this.lifecycle.signal, this.resourceControllers.get(params.resource).signal]);
    const native = await this.invoke("requestAccess", { resource: params.resource }, null, signal);
    await this.mutate(() => {
      this.expectRevision(params.expectedRevision);
      const authorization = native.resources.find(r => r.id === params.resource).authorization;
      if (native.available && authorization === "fullAccess" && !this.state.resources[params.resource].enabled) {
        const next = copy(this.state); next.revision = this.nextRevision(); next.resources[params.resource].enabled = true;
        this.persistState(next); this.invalidateResource(params.resource);
      }
    });
    return this.publicStatus(native);
  }
  async setPolicy(input) {
    const params = validateAppleDeviceParams("connector.apple.policy.set", input);
    await this.mutate(async () => {
      this.expectRevision(params.expectedRevision);
      const previous = this.state.resources[params.resource];
      let disabledProfileIds = [...params.disabledProfileIds].sort();
      // Ordinary off/read/write-policy edits need no directory discovery. Revocation
      // must not wait for a disconnected external backend's agent-list timeout.
      if (canonical(disabledProfileIds) !== canonical([...previous.disabledProfileIds].sort())) {
        let subjects;
        try { subjects = await abortable(this.getSubjects(), this.lifecycle.signal); }
        catch (error) {
          this.assertOpen();
          // Preserve every previous block when discovery fails; only newly
          // introduced IDs require proof of an actual assistant.
          if (params.disabledProfileIds.some(id => !previous.disabledProfileIds.includes(id))) fail("APPLE_DEVICE_SUBJECTS_UNAVAILABLE");
          subjects = { items: [] };
        }
        this.assertOpen(); this.expectRevision(params.expectedRevision);
        if (!subjects || !Array.isArray(subjects.items)) fail("APPLE_DEVICE_SUBJECTS_UNAVAILABLE");
        const known = new Set(subjects.items.map(s => s.profileId));
        if (params.disabledProfileIds.some(id => !known.has(id) && !previous.disabledProfileIds.includes(id))) fail("APPLE_DEVICE_PROFILE_INVALID");
        // A transiently unavailable adapter must not accidentally re-enable its
        // previously blocked assistants when the page saves visible checkboxes.
        disabledProfileIds = [...new Set([...params.disabledProfileIds, ...previous.disabledProfileIds.filter(id => !known.has(id))])].sort();
      }
      const nextPolicy = { enabled: params.enabled, readPolicy: params.readPolicy, writePolicy: params.writePolicy, disabledProfileIds };
      if (canonical(previous) === canonical(nextPolicy)) return;
      const next = copy(this.state); next.revision = this.nextRevision(); next.resources[params.resource] = nextPolicy;
      this.persistState(next); this.invalidateResource(params.resource);
    });
    return this.status();
  }
  async openSettings(input) {
    const params = validateAppleDeviceParams("connector.apple.settings.open", input); this.assertOpen();
    return this.invoke("settings.open", params);
  }
  handle(method, input) {
    const params = validateAppleDeviceParams(method, input);
    switch (method) {
      case "connector.apple.status": return this.status();
      case "connector.apple.connect": return this.connect(params);
      case "connector.apple.policy.set": return this.setPolicy(params);
      case "connector.apple.settings.open": return this.openSettings(params);
      default: fail("APPLE_DEVICE_METHOD_INVALID");
    }
  }
  async assertCaller(context) {
    this.assertOpen();
    if (context.signal?.aborted) fail("APPLE_DEVICE_CANCELED");
    if (typeof context.assertCurrent !== "function") fail("APPLE_DEVICE_IDENTITY_REQUIRED");
    const current = await context.assertCurrent();
    if (current === false || context.signal?.aborted) fail("APPLE_DEVICE_CANCELED");
    if (typeof context.revalidateCurrent === "function") {
      const valid = await abortable(context.revalidateCurrent(), context.signal);
      if (valid === false || context.signal?.aborted) fail("APPLE_DEVICE_CANCELED");
    }
    this.assertOpen();
  }
  assertApprovalCurrent(context, resource, profileId, write, generation) {
    this.assertOpen();
    if (context.signal?.aborted) fail("APPLE_DEVICE_CANCELED");
    const current = context.assertCurrent();
    // The approval broker checks synchronously while listing/resolving cards.
    // An asynchronous assertion cannot establish authority in that protocol.
    if (current && typeof current.then === "function") {
      current.catch(() => {});
      fail("APPLE_DEVICE_IDENTITY_REQUIRED");
    }
    if (current === false) fail("APPLE_DEVICE_CANCELED");
    this.assertPolicy(resource, profileId, write, generation);
  }
  assertPolicy(resource, profileId, write, generation) {
    this.assertOpen();
    const policy = this.state.resources[resource];
    if (!policy.enabled || policy.disabledProfileIds.includes(profileId) || (write ? policy.writePolicy : policy.readPolicy) === "deny") fail("APPLE_DEVICE_ACCESS_DENIED");
    if (generation !== undefined && this.generations.get(resource) !== generation) fail("APPLE_DEVICE_ACCESS_REVOKED");
    return policy;
  }
  async assertAuthorized(resource, write, context, generation) {
    await this.assertCaller(context); this.assertPolicy(resource, context.profileId, write, generation);
    const native = await this.invoke("status", {}, null, context.signal);
    await this.assertCaller(context); this.assertPolicy(resource, context.profileId, write, generation);
    if (!native.available) fail(native.errorCode || "APPLE_DEVICE_HOST_UNAVAILABLE");
    const authorization = native.resources.find(r => r.id === resource).authorization;
    if (authorization !== "fullAccess") {
      fail(authorization === "notDetermined" ? "APPLE_DEVICE_CONNECTION_REQUIRED" : "APPLE_DEVICE_AUTHORIZATION_DENIED");
    }
  }
  execute(name, args, context = {}) {
    const operation = TOOL_OPERATIONS[name], resource = operation?.split(".")[0];
    // Capture this resource generation before the first await. A later policy
    // change cancels queued native work, approvals and delayed caller checks.
    const signals = [this.lifecycle?.signal, context.signal, this.resourceControllers.get(resource)?.signal].filter(Boolean);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    const pending = this.executeInner(name, args, { ...context, signal }); this.active.add(pending);
    pending.then(() => this.active.delete(pending), () => this.active.delete(pending)); return pending;
  }
  async executeInner(name, rawArgs, context) {
    if (!Object.hasOwn(TOOL_OPERATIONS, name)) fail("APPLE_DEVICE_TOOL_INVALID");
    const operation = TOOL_OPERATIONS[name];
    const args = validateAppleDeviceOperationParams(operation, rawArgs);
    const identity = identityFor(context); const write = isWriteOperation(operation); const resource = operation.split(".")[0];
    await this.assertCaller(context); this.assertPolicy(resource, identity.profileId, write);
    const generation = this.generations.get(resource);
    await this.assertAuthorized(resource, write, context, generation);
    const key = hash(canonical(identity)); const fingerprint = hash(canonical({ name, arguments: args }));
    if (write) {
      const inflight = this.pendingWrites.get(key);
      if (inflight) {
        if (inflight.fingerprint !== fingerprint) fail("APPLE_DEVICE_CALL_CONFLICT");
        await inflight.promise;
        await this.assertAuthorized(resource, true, context, generation);
        return this.replay(this.ledger.get(key), fingerprint, resource, context, generation);
      }
      const existing = this.ledger.get(key);
      if (existing) return this.replay(existing, fingerprint, resource, context, generation);
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      this.pendingWrites.set(key, { fingerprint, promise });
      try { return await this.perform(operation, name, args, identity, context, resource, generation, { key, fingerprint }); }
      finally { this.pendingWrites.delete(key); release(); }
    }
    return this.perform(operation, name, args, identity, context, resource, generation, null);
  }
  async replay(entry, fingerprint, resource, context, generation) {
    await this.assertCaller(context); this.assertPolicy(resource, context.profileId, true, generation);
    if (!entry || entry.fingerprint !== fingerprint) fail("APPLE_DEVICE_CALL_CONFLICT");
    if (entry.state === "complete") return copy(entry.result);
    if (entry.state === "error") fail(entry.errorCode);
    fail("APPLE_DEVICE_WRITE_UNCERTAIN", "上次设备写入结果尚未确认，请先读取核对，不能自动重试。");
  }
  async perform(operation, name, args, identity, context, resource, generation, writeIdentity) {
    const write = Boolean(writeIdentity);
    const policy = this.assertPolicy(resource, identity.profileId, write, generation);
    let reviewOnly;
    if (write && !operation.endsWith(".create")) {
      // With full system access, fetch the actual target solely for the user's
      // approval preview. A read-deny policy never releases this data to the
      // model. The authoritative native write rechecks the same revision later.
      const target = await this.invoke(`${resource}.get`, { id: args.id }, null, context.signal);
      await this.assertAuthorized(resource, true, context, generation);
      const current = resource === "calendar" ? target.event : target.reminder;
      if (current.id !== args.id) fail("APPLE_DEVICE_INVALID_HOST_RESULT");
      if (current.revision !== args.expectedRevision) fail("APPLE_DEVICE_CONFLICT");
      reviewOnly = { target: args.id, current: reviewCurrent(resource, current, args.patch), changes: args.patch ? copy(args.patch) : null };
    }
    if ((write ? policy.writePolicy : policy.readPolicy) === "ask") {
      if (typeof this.requestApproval !== "function") fail("APPLE_DEVICE_APPROVAL_REQUIRED");
      const approved = await abortable(this.requestApproval({ identity: copy(identity), name, arguments: copy(args),
        ...(reviewOnly ? { reviewOnly } : {}), reason: approvalReason(operation, write), signal: context.signal,
        assertCurrent: () => this.assertApprovalCurrent(context, resource, identity.profileId, write, generation) }), context.signal);
      if (approved !== true && approved?.approved !== true) fail("APPLE_DEVICE_APPROVAL_DENIED");
    }
    // Approval cannot survive caller expiry, an assistant switch, a policy edit,
    // or a system permission change while its card was open.
    await this.assertAuthorized(resource, write, context, generation);
    let entry = null;
    if (write) {
      entry = { ...writeIdentity, operation, operationId: `apple-write-${hash(`${writeIdentity.key}:${writeIdentity.fingerprint}`)}`,
        state: "pending", result: null, errorCode: null };
      this.saveEntry(entry); // fsync BEFORE any native mutation.
    }
    let dispatched = false;
    try {
      await this.assertCaller(context); this.assertPolicy(resource, identity.profileId, write, generation);
      dispatched = true;
      const nativeResult = await this.invoke(operation, args, entry?.operationId || null, context.signal);
      const key = resource === "calendar" ? "event" : "reminder";
      const result = !write ? nativeResult : validateAppleDeviceWriteReceipt(operation, operation.endsWith(".delete")
        ? nativeResult : { [key]: { id: nativeResult[key].id, revision: nativeResult[key].revision } });
      if (write) this.saveEntry({ ...entry, state: "complete", result });
      await this.assertAuthorized(resource, write, context, generation);
      return result;
    } catch (error) {
      if (write && this.ledger.get(entry.key)?.state !== "complete") {
        // Once dispatched, transport failures and invalid host responses have an
        // unknown outcome. Persist that uncertainty; never blindly replay them.
        const definitive = !dispatched || ["APPLE_DEVICE_INVALID_ARGUMENT", "APPLE_DEVICE_NOT_FOUND", "APPLE_DEVICE_CONFLICT", "APPLE_DEVICE_READ_ONLY", "APPLE_DEVICE_PERMISSION_REQUIRED", "APPLE_DEVICE_BUSY"].includes(error?.code);
        try { this.saveEntry({ ...entry, state: definitive ? "error" : "unknown", errorCode: definitive && ERROR.test(error?.code || "") ? error.code : definitive ? "APPLE_DEVICE_FAILED" : null }); }
        catch { this.stopAdmission(); fail("APPLE_DEVICE_WRITE_UNCERTAIN"); }
      }
      throw error;
    }
  }
}
module.exports = { AppleDeviceController, APPLE_DEVICE_METHODS };
