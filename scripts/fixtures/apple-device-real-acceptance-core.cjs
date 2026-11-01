"use strict";

// Preparation only: this file never launches an App, opens a Service, requests
// TCC access, or accesses Apple data by itself. The acceptance App supplies all
// callbacks so UI, Service, approvals and EventKit belong to the same instance.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { TOOL_OPERATIONS, validateAppleDeviceOperationParams, validateAppleDeviceWriteReceipt } = require("../../app/core/apple-device-contract");
const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { const error = Error(code); error.code = code; throw error; };
const validId = value => typeof value === "string" && value.trim() && Buffer.byteLength(value) <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);

function createScopeGuard(input) {
  if (!input || !validId(input.calendarId) || !validId(input.listId) || !/^[a-f0-9]{32}$/u.test(input.token || "")) fail("ACCEPTANCE_EXPLICIT_SCOPE_REQUIRED");
  const scope = Object.freeze({ calendarId: input.calendarId, listId: input.listId, token: input.token });
  const marker = `[Shoggoth acceptance ${scope.token}]`;
  const owned = { calendar: new Map(), reminders: new Map() };
  const container = resource => resource === "calendar" ? scope.calendarId : scope.listId;
  const containerKey = resource => resource === "calendar" ? "calendarId" : "listId";
  const marked = value => typeof value === "string" && value.startsWith(marker + " ");
  function checkNative(operation, raw) {
    if (operation === "status") { if (!same(raw, {})) fail("ACCEPTANCE_INVALID_STATUS"); return; }
    if (![...Object.values(TOOL_OPERATIONS)].includes(operation) || operation === "calendar.list" || operation === "reminders.lists") fail("ACCEPTANCE_UNSCOPED_OPERATION_FORBIDDEN");
    const args = validateAppleDeviceOperationParams(operation, raw), resource = operation.split(".")[0];
    if (operation === "calendar.events") {
      if (!same(args.calendarIds, [scope.calendarId]) || args.limit === undefined || args.limit > 100) fail("ACCEPTANCE_FILTER_REQUIRED");
    } else if (operation === "reminders.search") {
      if (!same(args.listIds, [scope.listId]) || args.limit === undefined || args.limit > 100) fail("ACCEPTANCE_FILTER_REQUIRED");
    } else if (operation.endsWith(".create")) {
      if (args[containerKey(resource)] !== container(resource) || !marked(args.title) || !marked(args.notes)) fail("ACCEPTANCE_EXPLICIT_DESTINATION_REQUIRED");
    } else {
      if (!owned[resource].has(args.id)) fail("ACCEPTANCE_OWNED_ID_REQUIRED");
      if (operation.endsWith(".update") || operation.endsWith(".delete")) {
        if (args.expectedRevision !== owned[resource].get(args.id).revision) fail("ACCEPTANCE_CURRENT_REVISION_REQUIRED");
        if (resource === "calendar" && args.scope !== "this") fail("ACCEPTANCE_RECURRING_SCOPE_FORBIDDEN");
        if (args.patch) {
          const changedContainer = args.patch[containerKey(resource)];
          if (changedContainer !== undefined && changedContainer !== container(resource)) fail("ACCEPTANCE_CONTAINER_MOVE_FORBIDDEN");
          if (args.patch.title !== undefined && !marked(args.patch.title) || args.patch.notes !== undefined && !marked(args.patch.notes)) fail("ACCEPTANCE_TOKEN_REQUIRED");
        }
      }
    }
  }
  function checkTool(name, args) {
    if (!Object.hasOwn(TOOL_OPERATIONS, name)) fail("ACCEPTANCE_TOOL_FORBIDDEN");
    checkNative(TOOL_OPERATIONS[name], args);
  }
  function acceptWrite(name, result) {
    const operation = TOOL_OPERATIONS[name];
    validateAppleDeviceWriteReceipt(operation, result);
    const resource = operation.split(".")[0];
    if (operation.endsWith(".delete")) { const old = owned[resource].get(result.id); if (!old) fail("ACCEPTANCE_OWNED_ID_REQUIRED"); old.deleted = true; }
    else {
      const item = result[resource === "calendar" ? "event" : "reminder"];
      if (!operation.endsWith(".create") && !owned[resource].has(item.id)) fail("ACCEPTANCE_RESULT_ID_MISMATCH");
      owned[resource].set(item.id, { id: item.id, revision: item.revision, deleted: false });
    }
  }
  function checkRead(resource, result) {
    const rows = result[resource === "calendar" ? "events" : "reminders"];
    if (!Array.isArray(rows) || result.truncated !== false) fail("ACCEPTANCE_COMPLETE_FILTERED_RESULT_REQUIRED");
    for (const item of rows) {
      if (item[containerKey(resource)] !== container(resource) || !marked(item.title) || resource === "calendar" && item.recurring) fail("ACCEPTANCE_UNEXPECTED_RECORD_IN_DEDICATED_CONTAINER");
    }
    return rows;
  }
  function verifyApproval(record, { name, arguments: args, runId, profileId }) {
    const params = record?.params;
    if (record?.method !== "shoggoth/pluginTool/requestApproval" || !params || params.toolName !== name || params.sessionApprovalAvailable !== false) fail("ACCEPTANCE_REAL_APPROVAL_REQUIRED");
    if (runId && record.runId !== runId || profileId && record.profileId && record.profileId !== profileId) fail("ACCEPTANCE_APPROVAL_OWNER_MISMATCH");
    const options = params.approvalOptions;
    if (!Array.isArray(options) || !same(options.map(option => option.choice).sort(), ["deny", "once"])) fail("ACCEPTANCE_ONCE_ONLY_APPROVAL_REQUIRED");
    let displayed; try { displayed = JSON.parse(params.command); } catch { fail("ACCEPTANCE_COMPLETE_APPROVAL_ARGUMENTS_REQUIRED"); }
    assert.deepEqual(displayed, params.toolInput);
    const actual = params.toolInput?.arguments || params.toolInput;
    assert.deepEqual(actual, args);
    checkTool(name, actual);
    if (/_(?:update|delete)$/u.test(name)) {
      if (params.toolInput.target?.target !== args.id || !params.toolInput.target.current || !marked(params.toolInput.target.current.title)) fail("ACCEPTANCE_REAL_TARGET_PREVIEW_REQUIRED");
    }
    return { requestId: record.id || record.requestId || null, toolName: name };
  }
  return { scope, marker, checkNative, checkTool, acceptWrite, checkRead, verifyApproval,
    ownedIds: () => Object.fromEntries(Object.entries(owned).map(([resource, values]) => [resource, [...values.values()].map(copy)])) };
}

async function run({ scope, guard = createScopeGuard(scope), invoke, getStatus, setPolicy, review, report = async () => {}, signal, owner = {}, operationTimeoutMs = 300000 }) {
  for (const callback of [invoke, getStatus, setPolicy, review, report]) if (typeof callback !== "function") fail("ACCEPTANCE_CALLBACKS_REQUIRED");
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1000 || operationTimeoutMs > 30 * 60 * 1000) fail("ACCEPTANCE_TIMEOUT_INVALID");
  const lifetime = new AbortController(), combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const evidence = [], original = new Map(); let approvals = 0, complete = false, restored = false, lastScriptRevision = null;
  const emit = async value => { const entry = { at: new Date().toISOString(), ...value }; evidence.push(entry); await report(copy(entry), guard.ownedIds()); };
  const codeOf = error => error?.code || error?.error?.code || error?.structuredContent?.error?.code;
  async function call(name, args, needsApproval = false) {
    guard.checkTool(name, args); if (combined.aborted) fail("ACCEPTANCE_CANCELLED");
    const callId = crypto.randomUUID(), deadline = new AbortController();
    const callSignal = AbortSignal.any([combined, deadline.signal]);
    let timer, checked = false;
    const pending = Promise.resolve().then(() => invoke(name, copy(args), { callId, signal: callSignal }));
    pending.catch(() => {});
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { deadline.abort(); reject(Object.assign(Error("ACCEPTANCE_OPERATION_TIMEOUT"), { code: "ACCEPTANCE_OPERATION_TIMEOUT" })); }, operationTimeoutMs); });
      if (needsApproval) {
        const expected = { name, arguments: copy(args), callId, ...owner };
        await Promise.race([Promise.resolve().then(() => review({ expected, pending, signal: callSignal,
          verify(record) { const summary = guard.verifyApproval(record, expected); checked = true; return summary; } })), timeout]);
        if (!checked) fail("ACCEPTANCE_APPROVAL_NOT_VERIFIED");
        approvals++;
      }
      const result = await Promise.race([pending, timeout]);
      if (codeOf(result)) throw Object.assign(Error("ACCEPTANCE_TOOL_FAILED"), { code: codeOf(result) });
      if (/_(?:create|update|delete)$/u.test(name)) guard.acceptWrite(name, result);
      await emit({ step: "tool-complete", resource: name.startsWith("apple_calendar_") ? "calendar" : "reminders", tool: name, callId, approved: needsApproval });
      return result;
    } catch (error) { deadline.abort(); throw error; }
    finally { clearTimeout(timer); }
  }
  const start = new Date(Date.now() + 2 * 86400000); start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 3600000);
  const queries = {
    calendar: { name: "apple_calendar_events", args: { calendarIds: [guard.scope.calendarId], start: start.toISOString(), end: end.toISOString(), limit: 100 } },
    reminders: { name: "apple_reminders_search", args: { listIds: [guard.scope.listId], limit: 100 } },
  };
  const query = async (resource, approve = false) => guard.checkRead(resource, await call(queries[resource].name, queries[resource].args, approve));
  const rememberPolicyResponse = value => {
    if (!Number.isSafeInteger(value?.revision) || !Array.isArray(value?.resources)) fail("ACCEPTANCE_POLICY_STATUS_RESPONSE_REQUIRED");
    lastScriptRevision = value.revision; return value;
  };
  const policy = async (resource, readPolicy) => {
    const value = rememberPolicyResponse(await setPolicy(resource, { enabled: true, readPolicy, writePolicy: "ask" }));
    const current = value.resources.find(item => item.id === resource);
    if (!current?.enabled || current.readPolicy !== readPolicy || current.writePolicy !== "ask") fail("ACCEPTANCE_POLICY_SAVE_NOT_CONFIRMED");
    await emit({ step: "policy", resource, readPolicy });
  };
  const restorePolicies = async () => {
    for (const [resource, saved] of original) {
      const current = await getStatus();
      // A human's later revocation wins over test teardown. Never reopen access
      // by restoring an old snapshot over an intervening UI/other-task change.
      if (current.revision !== lastScriptRevision) {
        await emit({ step: "policy-restore-skipped-current-state-changed", resource });
        fail("ACCEPTANCE_POLICY_CHANGED_OUTSIDE_DRIVER");
      }
      rememberPolicyResponse(await setPolicy(resource, saved));
      await emit({ step: "policy-restored", resource });
    }
    restored = true;
  };
  try {
    const status = await getStatus();
    if (!status?.available || !["calendar", "reminders"].every(id => status.resources?.find(item => item.id === id)?.authorization === "fullAccess")) fail("ACCEPTANCE_CONNECT_IN_REAL_APP_FIRST");
    for (const resource of ["calendar", "reminders"]) {
      const item = status.resources.find(item => item.id === resource);
      original.set(resource, { enabled: item.enabled, readPolicy: item.readPolicy, writePolicy: item.writePolicy, disabledProfileIds: [...item.disabledProfileIds] });
    }
    lastScriptRevision = status.revision;
    await emit({ step: "started", scope: guard.scope, realAppService: true, controlledInvoke: true });
    for (const resource of ["calendar", "reminders"]) {
      await policy(resource, "allow");
      if ((await query(resource)).length) fail("ACCEPTANCE_DEDICATED_CONTAINER_NOT_EMPTY");
      await policy(resource, "ask"); await query(resource, true); await query(resource, true);
      await policy(resource, "deny");
      let denied = false;
      try { await query(resource); } catch (error) { if (codeOf(error) !== "APPLE_DEVICE_ACCESS_DENIED") throw error; denied = true; }
      if (!denied) fail("ACCEPTANCE_READ_OFF_NOT_ENFORCED");
      await emit({ step: "read-policies-verified", resource, askApprovals: 2 });
      const calendar = resource === "calendar", prefix = calendar ? "apple_calendar" : "apple_reminders", key = calendar ? "event" : "reminder";
      const createArgs = { title: `${guard.marker} ${resource} created`, notes: `${guard.marker} Dedicated acceptance record only.`,
        ...(calendar ? { calendarId: guard.scope.calendarId, start: start.toISOString(), end: end.toISOString(), allDay: false, timeZone: "UTC" } : { listId: guard.scope.listId, due: null, priority: 0 }) };
      const created = await call(`${prefix}_create`, createArgs, true);
      assert.deepEqual(Object.keys(created[key]).sort(), ["id", "revision"]);
      await policy(resource, "allow");
      const createdRows = await query(resource);
      assert.equal(createdRows.length, 1); assert.equal(createdRows[0].id, created[key].id); assert.equal(createdRows[0].title, createArgs.title);
      await policy(resource, "deny");
      const patch = calendar ? { title: `${guard.marker} calendar updated` } : { completed: true };
      const updated = await call(`${prefix}_update`, { id: created[key].id, expectedRevision: created[key].revision, ...(calendar ? { scope: "this" } : {}), patch }, true);
      assert.deepEqual(Object.keys(updated[key]).sort(), ["id", "revision"]);
      await policy(resource, "allow");
      const updatedRows = await query(resource);
      assert.equal(updatedRows.length, 1); assert.equal(updatedRows[0].id, updated[key].id);
      if (calendar) assert.equal(updatedRows[0].title, patch.title); else assert.equal(updatedRows[0].completed, true);
      await policy(resource, "deny");
      const removed = await call(`${prefix}_delete`, { id: updated[key].id, expectedRevision: updated[key].revision, ...(calendar ? { scope: "this" } : {}) }, true);
      assert.equal(removed.deleted, true); assert.equal(removed.id, updated[key].id);
      await policy(resource, "allow"); assert.equal((await query(resource)).length, 0);
      await emit({ step: "crud-cleaned", resource, owned: guard.ownedIds()[resource] });
    }
    assert.equal(approvals, 10); await restorePolicies(); complete = true;
    await emit({ step: "passed", approvals, created: 2, updated: 2, deleted: 2 });
    return { passed: true, approvals, evidence, ownedIds: guard.ownedIds() };
  } catch (error) {
    lifetime.abort();
    await emit({ step: "failed", code: codeOf(error) || "ACCEPTANCE_ASSERTION_FAILED", ownedIds: guard.ownedIds(), cleanupRequired: guard.ownedIds().calendar.concat(guard.ownedIds().reminders).some(item => !item.deleted) });
    error.acceptance = { passed: false, evidence, ownedIds: guard.ownedIds() }; throw error;
  } finally {
    lifetime.abort();
    if (!restored) { try { await restorePolicies(); } catch { await emit({ step: "policy-restore-failed" }); } }
    if (!complete) await emit({ step: "stopped-without-automatic-write-retry", ownedIds: guard.ownedIds() });
  }
}

module.exports = { createScopeGuard, run };
