#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AppleDeviceController } = require("../app/agent-service/apple-device-controller");
const { TOOL_DEFINITIONS, TOOL_CAPABILITIES, validateAppleDeviceArguments } = require("../app/agent-service/apple-device-tools");
const { validateAppleDeviceParams, validateAppleDeviceResult, validateAppleDeviceInvokeParams, validateAppleDeviceInvokeResult,
  TOOL_OPERATIONS, isWriteOperation, validateAppleDeviceWriteReceipt, validateAppleDevicePolicyState } = require("../app/core/apple-device-contract");

const clone = value => JSON.parse(JSON.stringify(value));
const REV = "a".repeat(64);
const event = () => ({ id: "event/opaque:1", calendarId: "calendar/1", title: "Fixture event", start: "2026-10-27T09:00:00+08:00",
  end: "2026-10-27T10:00:00+08:00", allDay: false, timeZone: "Asia/Shanghai", notes: "", location: "", recurring: false, revision: REV });
const reminder = () => ({ id: "reminder/opaque:1", listId: "list/1", title: "Fixture reminder", notes: "", due: null, priority: 0, completed: false, revision: REV });
const createEvent = () => ({ title: "Fixture event", start: "2026-10-27T09:00:00+08:00", end: "2026-10-27T10:00:00+08:00" });
const calendar = { id: "calendar/1", title: "Fixture calendar", allowsModifications: true, isDefault: true };
const list = { id: "list/1", title: "Fixture reminders", allowsModifications: true, isDefault: true };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function context(callId = "call-1", changes = {}) {
  return { profileId: "profile-1", callId, signal: new AbortController().signal, assertCurrent: () => {},
    identity: { backendId: "shoggoth", agentId: "agent-1", sessionId: "session-1", profileId: "profile-1", runId: "run-1", callId }, ...changes };
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync("/private/tmp/shoggoth-apple-device-");
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  const native = { available: true, errorCode: null, resources: [{ id: "calendar", authorization: "fullAccess" }, { id: "reminders", authorization: "fullAccess" }] };
  const calls = [], approvals = [];
  const host = { async request(method, envelope, requestOptions) {
    assert.equal(method, "apple.device.invoke"); validateAppleDeviceInvokeParams(envelope); calls.push(clone(envelope));
    if (options.onInvoke) { const result = await options.onInvoke(envelope, requestOptions); if (result !== undefined) return result; }
    if (envelope.operation === "status" || envelope.operation === "requestAccess") return clone(native);
    if (envelope.operation === "settings.open") return { opened: true };
    if (envelope.operation === "calendar.list") return { calendars: [clone(calendar)] };
    if (envelope.operation === "calendar.events") return { events: [event()], truncated: false };
    if (["calendar.get", "calendar.create", "calendar.update"].includes(envelope.operation)) return { event: event() };
    if (envelope.operation === "calendar.delete") return { deleted: true, id: envelope.params.id };
    if (envelope.operation === "reminders.lists") return { lists: [clone(list)] };
    if (envelope.operation === "reminders.search") return { reminders: [reminder()], truncated: false };
    if (["reminders.get", "reminders.create", "reminders.update"].includes(envelope.operation)) return { reminder: reminder() };
    if (envelope.operation === "reminders.delete") return { deleted: true, id: envelope.params.id };
    assert.fail(envelope.operation);
  } };
  let subjects = { items: [{ profileId: "profile-1" }, { profileId: "profile-2" }], unavailableBackends: [] };
  const controllerOptions = { paths, host, getSubjects: async () => clone(subjects), requestApproval: async input => {
    input.assertCurrent(); approvals.push(input); return options.onApproval ? options.onApproval(input) : { approved: true };
  } };
  const controller = new AppleDeviceController(controllerOptions).open();
  t.after(async () => { await controller.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, controller, controllerOptions, native, calls, approvals, setSubjects: value => { subjects = value; },
    async policy(resource, patch) { return controller.setPolicy({ resource, ...controller.state.resources[resource], ...patch, expectedRevision: controller.state.revision }); },
    operations(operation) { return calls.filter(call => call.operation === operation); } };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test("writing policies reject missing or invalid wire fields and malformed persisted versions", () => {
  const input = { resource: "calendar", enabled: true, readPolicy: "allow", writePolicy: "ask", disabledProfileIds: [], expectedRevision: 1 };
  for (const writePolicy of ["allow", "ask", "deny"]) assert.equal(validateAppleDeviceParams("connector.apple.policy.set", { ...input, writePolicy }).writePolicy, writePolicy);
  for (const writePolicy of [undefined, null, false, 0, "", "always"]) assert.throws(() => validateAppleDeviceParams("connector.apple.policy.set", { ...input, writePolicy }), TypeError);
  const stored = { enabled: true, readPolicy: "allow", disabledProfileIds: [] };
  const legacy = { schemaVersion: 1, revision: 8, resources: { calendar: clone(stored), reminders: clone(stored) } };
  assert.throws(() => validateAppleDevicePolicyState({ ...legacy, schemaVersion: 2 }), TypeError, "version 2 must explicitly provide both writing choices");
  assert.throws(() => validateAppleDevicePolicyState({ ...legacy, resources: { ...legacy.resources, calendar: { ...stored, writePolicy: "allow" } } }), TypeError, "an unknown version 1 field cannot grant writing");
  const normalized = validateAppleDevicePolicyState(legacy);
  normalized.resources.calendar.writePolicy = "always";
  assert.throws(() => validateAppleDevicePolicyState(normalized), TypeError);
  assert.throws(() => validateAppleDevicePolicyState({ ...legacy, schemaVersion: 3 }), TypeError);
});

test("writing policies default to ask and legacy policies migrate without granting writes", async t => {
  const f = fixture(t);
  assert.deepEqual((await f.controller.status()).resources.map(r => r.writePolicy), ["ask", "ask"]);
  await f.controller.close();
  const legacy = { schemaVersion: 1, revision: 8, resources: {
    calendar: { enabled: true, readPolicy: "allow", disabledProfileIds: ["profile-2"] },
    reminders: { enabled: true, readPolicy: "deny", disabledProfileIds: [] },
  } };
  const raw = JSON.stringify(legacy); fs.writeFileSync(f.controller.policyPath, raw, { mode: 0o600 });
  const reopened = new AppleDeviceController(f.controllerOptions).open(); t.after(() => reopened.close());
  assert.equal(reopened.state.schemaVersion, 2);
  assert.equal(reopened.state.revision, legacy.revision);
  assert.equal(fs.readFileSync(f.controller.policyPath, "utf8"), raw, "migration is persisted by the next actual policy edit");
  assert.deepEqual((await reopened.status()).resources.map(r => [r.id, r.readPolicy, r.writePolicy]), [["calendar", "allow", "ask"], ["reminders", "deny", "ask"]]);
  await reopened.execute("apple_calendar_create", createEvent(), context("legacy-write"));
  assert.equal(f.approvals.length, 1, "legacy read allow does not grant writing permission");
  await reopened.setPolicy({ resource: "calendar", ...reopened.state.resources.calendar, writePolicy: "allow", expectedRevision: reopened.state.revision });
  const saved = JSON.parse(fs.readFileSync(reopened.policyPath)); assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.resources.calendar.writePolicy, "allow"); assert.equal(saved.resources.reminders.writePolicy, "ask");
  await reopened.close();
  const again = new AppleDeviceController(f.controllerOptions).open(); t.after(() => again.close());
  assert.equal(again.state.resources.calendar.writePolicy, "allow");
  assert.deepEqual(again.state.resources.calendar.disabledProfileIds, ["profile-2"]);
});

test("writing policies enforce allow, ask and deny for every mutation independently of reading", async t => {
  const f = fixture(t);
  for (const resource of ["calendar", "reminders"]) {
    const item = resource === "calendar" ? event() : reminder(), prefix = resource === "calendar" ? "apple_calendar" : "apple_reminders";
    const operations = [
      ["create", resource === "calendar" ? createEvent() : { title: "Writing policy fixture" }],
      ["update", { id: item.id, expectedRevision: REV, ...(resource === "calendar" ? { scope: "this" } : {}), patch: { title: "Changed fixture" } }],
      ["delete", { id: item.id, expectedRevision: REV, ...(resource === "calendar" ? { scope: "this" } : {}) }],
      ...(resource === "reminders" ? [["update", { id: item.id, expectedRevision: REV, patch: { completed: true } }]] : []),
    ];
    for (const writePolicy of ["allow", "ask", "deny"]) {
      await f.policy(resource, { enabled: true, readPolicy: "deny", writePolicy });
      const beforeApproval = f.approvals.length, beforeCalls = f.calls.length;
      for (const [index, [action, args]] of operations.entries()) {
        const call = f.controller.execute(`${prefix}_${action}`, args, context(`${resource}-${writePolicy}-${index}`));
        if (writePolicy === "deny") await rejectsCode(call, "APPLE_DEVICE_ACCESS_DENIED");
        else {
          const receipt = await call;
          assert.deepEqual(Object.keys(receipt).sort(), action === "delete" ? ["deleted", "id"] : [resource === "calendar" ? "event" : "reminder"]);
          if (action !== "delete") assert.deepEqual(Object.keys(Object.values(receipt)[0]).sort(), ["id", "revision"], "write allow cannot reveal record contents");
        }
      }
      assert.equal(f.approvals.length - beforeApproval, writePolicy === "ask" ? operations.length : 0);
      if (writePolicy === "deny") assert.equal(f.calls.length, beforeCalls, "off refuses before status, target preview or mutation");
      await rejectsCode(f.controller.execute(`${prefix}_get`, { id: item.id }, context(`${resource}-${writePolicy}-read`)), "APPLE_DEVICE_ACCESS_DENIED");
    }
  }
  await f.policy("calendar", { readPolicy: "allow", writePolicy: "allow" });
  await f.policy("reminders", { readPolicy: "allow", writePolicy: "deny" });
  const count = f.approvals.length;
  await f.controller.execute("apple_calendar_create", createEvent(), context("independent-calendar"));
  await rejectsCode(f.controller.execute("apple_reminders_create", { title: "Forbidden" }, context("independent-reminder")), "APPLE_DEVICE_ACCESS_DENIED");
  await f.controller.execute("apple_reminders_lists", {}, context("independent-read"));
  assert.equal(f.approvals.length, count);
});

test("writing policies allow still enforce caller, assistant, connection and system authorization", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, writePolicy: "allow" });
  f.native.resources[0].authorization = "denied";
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context("tcc")), "APPLE_DEVICE_AUTHORIZATION_DENIED");
  f.native.resources[0].authorization = "fullAccess";
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context("stale", { assertCurrent: () => false })), "APPLE_DEVICE_CANCELED");
  await f.policy("calendar", { disabledProfileIds: ["profile-1"] });
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context("assistant")), "APPLE_DEVICE_ACCESS_DENIED");
  await f.policy("calendar", { disabledProfileIds: [], enabled: false });
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context("disconnected")), "APPLE_DEVICE_ACCESS_DENIED");
  assert.equal(f.operations("calendar.create").length, 0); assert.equal(f.approvals.length, 0);
});

test("writing policies revocation cancels an allowed queued mutation and preserves no-replay receipts", async t => {
  const entered = deferred(), release = deferred(); let mutations = 0, signal;
  const f = fixture(t, { async onInvoke(envelope, options) {
    if (envelope.operation !== "calendar.create") return;
    signal = options.signal; entered.resolve(); await release.promise;
    if (signal.aborted) throw Object.assign(Error("cancelled"), { code: "APPLE_DEVICE_CANCELED" });
    mutations += 1;
  } });
  await f.policy("calendar", { enabled: true, readPolicy: "allow", writePolicy: "allow" });
  const pending = f.controller.execute("apple_calendar_create", createEvent(), context("revoked-write"));
  const rejected = rejectsCode(pending, "APPLE_DEVICE_CANCELED");
  await entered.promise; await f.policy("calendar", { writePolicy: "deny" });
  assert.equal(signal.aborted, true); release.resolve(); await rejected;
  assert.equal(mutations, 0); assert.equal(f.approvals.length, 0);
  await f.controller.execute("apple_calendar_list", {}, context("read-after-write-off"));
  await f.policy("calendar", { writePolicy: "allow" });
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context("revoked-write")), "APPLE_DEVICE_WRITE_UNCERTAIN");
  assert.equal(f.operations("calendar.create").length, 1, "uncertain write is not automatically replayed after permission is restored");
});

test("writing policies changes invalidate pending ask approval even when switching to allow", async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { onApproval() { entered.resolve(); return release.promise; } });
  await f.policy("reminders", { enabled: true, writePolicy: "ask" });
  const pending = f.controller.execute("apple_reminders_create", { title: "Late approval fixture" }, context("old-ask"));
  const rejected = rejectsCode(pending, "APPLE_DEVICE_CANCELED");
  await entered.promise; await f.policy("reminders", { writePolicy: "allow" }); release.resolve({ approved: true });
  await rejected; assert.equal(f.operations("reminders.create").length, 0);
  await f.controller.execute("apple_reminders_create", { title: "New permitted fixture" }, context("new-allow"));
  assert.equal(f.operations("reminders.create").length, 1); assert.equal(f.approvals.length, 1);
});

test("default disconnected policy refuses data access before contacting native host", async t => {
  const f = fixture(t);
  await rejectsCode(f.controller.execute("apple_calendar_list", {}, context()), "APPLE_DEVICE_ACCESS_DENIED");
  assert.equal(f.calls.length, 0);
  const result = await f.controller.status();
  assert.equal(result.revision, 1);
  assert.deepEqual(result.resources.map(r => [r.id, r.enabled, r.readPolicy]), [["calendar", false, "ask"], ["reminders", false, "ask"]]);
});

test("explicit Connect alone requests TCC and enables only its resource", async t => {
  const f = fixture(t); f.native.resources[0].authorization = "notDetermined";
  f.native.resources[0].authorization = "fullAccess";
  const result = await f.controller.connect({ resource: "calendar", expectedRevision: 1 });
  assert.equal(f.operations("requestAccess").length, 1);
  assert.deepEqual(f.operations("requestAccess")[0].params, { resource: "calendar" });
  assert.equal(result.revision, 2);
  assert.equal(result.resources[0].enabled, true);
  assert.equal(result.resources[1].enabled, false);
  assert.equal(fs.statSync(f.controller.policyPath).mode & 0o777, 0o600);
  await rejectsCode(f.controller.connect({ resource: "calendar", expectedRevision: 1 }), "APPLE_DEVICE_REVISION_CONFLICT");
});

test("read allow executes without approval; ask asks on every invocation including repeated call IDs", async t => {
  const f = fixture(t);
  await f.policy("calendar", { enabled: true, readPolicy: "allow" });
  await f.controller.execute("apple_calendar_list", {}, context());
  assert.equal(f.approvals.length, 0);
  await f.policy("calendar", { readPolicy: "ask" });
  await f.controller.execute("apple_calendar_list", {}, context());
  await f.controller.execute("apple_calendar_list", {}, context());
  assert.equal(f.approvals.length, 2);
  assert.equal(f.operations("calendar.list").length, 3);
  assert.match(f.approvals[0].reason, /日历读取.*每次询问/u);
  assert.equal(fs.existsSync(f.controller.ledgerPath), false);
  assert.equal(fs.readFileSync(f.controller.policyPath, "utf8").includes("Fixture calendar"), false);
});

test("read deny and disabled assistants reject without any native access", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, readPolicy: "deny" });
  const before = f.calls.length;
  await rejectsCode(f.controller.execute("apple_calendar_list", {}, context()), "APPLE_DEVICE_ACCESS_DENIED");
  assert.equal(f.calls.length, before);
  await f.policy("calendar", { readPolicy: "allow", disabledProfileIds: ["profile-1"] });
  const disabledBefore = f.calls.length;
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context()), "APPLE_DEVICE_ACCESS_DENIED");
  assert.equal(f.calls.length, disabledBefore);
});

test("every write requires exact approval even when reads are denied and context claims confirmation", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, readPolicy: "deny" });
  const result = await f.controller.execute("apple_calendar_create", createEvent(), context("write-1", { confirmed: true, approved: true }));
  assert.equal(result.event.id, event().id);
  assert.equal(f.approvals.length, 1);
  assert.match(f.approvals[0].reason, /日历中创建日程/u);
  assert.deepEqual(f.approvals[0].arguments, createEvent());
  assert.match(f.operations("calendar.create")[0].operationId, /^apple-write-[a-f0-9]{64}$/u);
  assert.equal(f.operations("status").every(call => call.operationId === null), true);
  assert.equal(fs.statSync(f.controller.ledgerPath).mode & 0o777, 0o600);
});

test("denied approval dispatches no business operation", async t => {
  const f = fixture(t, { onApproval: async () => false }); await f.policy("reminders", { enabled: true });
  await rejectsCode(f.controller.execute("apple_reminders_create", { title: "Fixture" }, context()), "APPLE_DEVICE_APPROVAL_DENIED");
  assert.equal(f.operations("reminders.create").length, 0);
  assert.equal(fs.existsSync(f.controller.ledgerPath), false);
});

test("missing or malformed approval proof never authorizes native mutation", async t => {
  let proof;
  const f = fixture(t, { onApproval: async () => proof }); await f.policy("calendar", { enabled: true });
  for (const [index, value] of [undefined, null, {}, { approved: "true" }, { approved: false }].entries()) {
    proof = value;
    await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context("bad-proof-" + index)), "APPLE_DEVICE_APPROVAL_DENIED");
  }
  assert.equal(f.operations("calendar.create").length, 0);
  assert.equal(fs.existsSync(f.controller.ledgerPath), false);
});

test("notDetermined, denied and writeOnly read permissions never trigger authorization automatically", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, readPolicy: "allow" });
  for (const [authorization, code] of [["notDetermined", "APPLE_DEVICE_CONNECTION_REQUIRED"], ["denied", "APPLE_DEVICE_AUTHORIZATION_DENIED"], ["writeOnly", "APPLE_DEVICE_AUTHORIZATION_DENIED"]]) {
    f.native.resources[0].authorization = authorization;
    await rejectsCode(f.controller.execute("apple_calendar_list", {}, context()), code);
  }
  assert.equal(f.operations("requestAccess").length, 0);
  assert.equal(f.operations("calendar.list").length, 0);
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context("write-only")), "APPLE_DEVICE_AUTHORIZATION_DENIED");
  assert.equal(f.operations("calendar.create").length, 0);
  await f.policy("calendar", { enabled: false });
  assert.equal((await f.controller.connect({ resource: "calendar", expectedRevision: f.controller.state.revision })).resources[0].enabled, false);
});

test("policy revocation during approval prevents the approved operation", async t => {
  const waiting = deferred(), release = deferred();
  const f = fixture(t, { onApproval: async () => { waiting.resolve(); await release.promise; return true; } });
  await f.policy("calendar", { enabled: true });
  const operation = f.controller.execute("apple_calendar_create", createEvent(), context());
  operation.catch(() => {});
  await waiting.promise; await f.policy("calendar", { enabled: false }); release.resolve();
  await rejectsCode(operation, "APPLE_DEVICE_CANCELED");
  assert.equal(f.operations("calendar.create").length, 0);
});

test("policy edit and restore cannot revive an older approval", async t => {
  const waiting = deferred(), release = deferred();
  const f = fixture(t, { onApproval: async () => { waiting.resolve(); await release.promise; return true; } });
  await f.policy("calendar", { enabled: true });
  const operation = f.controller.execute("apple_calendar_list", {}, context());
  operation.catch(() => {});
  await waiting.promise; await f.policy("calendar", { enabled: false }); await f.policy("calendar", { enabled: true }); release.resolve();
  await rejectsCode(operation, "APPLE_DEVICE_CANCELED");
  assert.equal(f.operations("calendar.list").length, 0);
});

test("caller expiry and cancellation during approval prevent native access", async t => {
  let active = true; const abort = new AbortController();
  const f = fixture(t, { onApproval: async input => { active = false; assert.throws(input.assertCurrent, /expired/u); return true; } });
  await f.policy("reminders", { enabled: true });
  await assert.rejects(f.controller.execute("apple_reminders_create", { title: "Fixture" }, context("expiry", { assertCurrent: () => { if (!active) throw Error("expired"); } })), /expired/u);
  abort.abort();
  await rejectsCode(f.controller.execute("apple_reminders_create", { title: "Fixture" }, context("cancel", { signal: abort.signal })), "APPLE_DEVICE_CANCELED");
  assert.equal(f.operations("reminders.create").length, 0);
});

test("revoke while reading discards the in-flight native data", async t => {
  const waiting = deferred(), release = deferred();
  const f = fixture(t, { onInvoke: async envelope => { if (envelope.operation === "calendar.list") { waiting.resolve(); await release.promise; } } });
  await f.policy("calendar", { enabled: true, readPolicy: "allow" });
  const operation = f.controller.execute("apple_calendar_list", {}, context());
  operation.catch(() => {});
  await waiting.promise; await f.policy("calendar", { readPolicy: "deny" }); release.resolve();
  await rejectsCode(operation, "APPLE_DEVICE_CANCELED");
});

test("system authorization is rechecked after an in-flight read", async t => {
  let f;
  f = fixture(t, { onInvoke: async envelope => { if (envelope.operation === "reminders.search") f.native.resources[1].authorization = "denied"; } });
  await f.policy("reminders", { enabled: true, readPolicy: "allow" });
  await rejectsCode(f.controller.execute("apple_reminders_search", {}, context()), "APPLE_DEVICE_AUTHORIZATION_DENIED");
  assert.equal(f.operations("reminders.search").length, 1);
});

test("successful writes replay durably once and reject argument/owner conflicts", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, readPolicy: "allow" });
  const first = await f.controller.execute("apple_calendar_create", createEvent(), context());
  assert.deepEqual(await f.controller.execute("apple_calendar_create", createEvent(), context()), first);
  assert.equal(f.operations("calendar.create").length, 1); assert.equal(f.approvals.length, 1);
  await rejectsCode(f.controller.execute("apple_calendar_create", { ...createEvent(), title: "Changed" }, context()), "APPLE_DEVICE_CALL_CONFLICT");
  const restarted = new AppleDeviceController(f.controllerOptions).open();
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.execute("apple_calendar_create", createEvent(), context()), first);
  assert.equal(f.operations("calendar.create").length, 1);
  await f.controller.execute("apple_calendar_create", createEvent(), context("call-1", { identity: { ...context().identity, sessionId: "session-2" } }));
  assert.equal(f.operations("calendar.create").length, 2);
});

test("concurrent duplicate write delivery shares one approval and native mutation", async t => {
  const waiting = deferred(), release = deferred();
  const f = fixture(t, { onInvoke: async envelope => { if (envelope.operation === "calendar.create") { waiting.resolve(); await release.promise; } } });
  await f.policy("calendar", { enabled: true });
  const first = f.controller.execute("apple_calendar_create", createEvent(), context());
  await waiting.promise;
  const duplicate = f.controller.execute("apple_calendar_create", createEvent(), context());
  release.resolve();
  assert.deepEqual(await first, await duplicate);
  assert.equal(f.approvals.length, 1); assert.equal(f.operations("calendar.create").length, 1);
});

test("uncertain native write is persisted before dispatch and never retried after restart", async t => {
  let f;
  f = fixture(t, { onInvoke: async envelope => {
    if (envelope.operation === "reminders.create") {
      const ledger = JSON.parse(fs.readFileSync(f.controller.ledgerPath, "utf8"));
      assert.equal(ledger.entries[0].state, "pending");
      assert.equal(ledger.entries[0].operationId, envelope.operationId);
      const error = Error("transport closed"); error.code = "CONNECTION_CLOSED"; throw error;
    }
  } });
  await f.policy("reminders", { enabled: true });
  await assert.rejects(f.controller.execute("apple_reminders_create", { title: "Fixture" }, context()), /transport closed/u);
  assert.equal(JSON.parse(fs.readFileSync(f.controller.ledgerPath, "utf8")).entries[0].state, "unknown");
  const restarted = new AppleDeviceController(f.controllerOptions).open(); t.after(() => restarted.close());
  await rejectsCode(restarted.execute("apple_reminders_create", { title: "Fixture" }, context()), "APPLE_DEVICE_WRITE_UNCERTAIN");
  assert.equal(f.operations("reminders.create").length, 1); assert.equal(f.approvals.length, 1);
});

test("pending write surviving a crash is never dispatched again", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true });
  await f.controller.execute("apple_calendar_create", createEvent(), context());
  const data = JSON.parse(fs.readFileSync(f.controller.ledgerPath, "utf8"));
  data.entries[0].state = "pending"; data.entries[0].result = null;
  fs.writeFileSync(f.controller.ledgerPath, JSON.stringify(data), { mode: 0o600 });
  const restarted = new AppleDeviceController(f.controllerOptions).open(); t.after(() => restarted.close());
  await rejectsCode(restarted.execute("apple_calendar_create", createEvent(), context()), "APPLE_DEVICE_WRITE_UNCERTAIN");
  assert.equal(f.operations("calendar.create").length, 1);
});

test("native revision conflicts retain their definitive failure without reapproval or redispatch", async t => {
  const f = fixture(t, { onInvoke: async envelope => { if (envelope.operation === "calendar.update") { const error = Error("conflict"); error.code = "APPLE_DEVICE_CONFLICT"; throw error; } } });
  await f.policy("calendar", { enabled: true });
  const args = { id: event().id, expectedRevision: REV, scope: "this", patch: { title: "Changed" } };
  await rejectsCode(f.controller.execute("apple_calendar_update", args, context()), "APPLE_DEVICE_CONFLICT");
  await rejectsCode(f.controller.execute("apple_calendar_update", args, context()), "APPLE_DEVICE_CONFLICT");
  assert.equal(f.operations("calendar.update").length, 1); assert.equal(f.approvals.length, 1);
});

test("native BUSY is a definite nonexecution receipt rather than an uncertain write", async t => {
  const f = fixture(t, { onInvoke: async envelope => { if (envelope.operation === "calendar.create") { const error = Error("native busy"); error.code = "APPLE_DEVICE_BUSY"; throw error; } } });
  await f.policy("calendar", { enabled: true });
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context()), "APPLE_DEVICE_BUSY");
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context()), "APPLE_DEVICE_BUSY");
  assert.equal(f.operations("calendar.create").length, 1); assert.equal(f.approvals.length, 1);
  const entry = JSON.parse(fs.readFileSync(f.controller.ledgerPath, "utf8")).entries[0];
  assert.equal(entry.state, "error"); assert.equal(entry.errorCode, "APPLE_DEVICE_BUSY");
});

test("update/delete approval receives authoritative target details and stale revisions ask nothing", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, readPolicy: "deny" }); await f.policy("reminders", { enabled: true, readPolicy: "deny" });
  const args = { id: event().id, expectedRevision: REV, scope: "this", patch: { title: "Changed" } };
  await f.controller.execute("apple_calendar_update", args, context("update"));
  const { notes: eventNotes, location: eventLocation, ...eventPreview } = event();
  assert.deepEqual(f.approvals[0].reviewOnly, { target: args.id, current: eventPreview, changes: args.patch });
  assert.deepEqual(f.approvals[0].arguments, args);
  assert.equal(f.operations("calendar.get").length, 1);
  assert.equal(f.operations("calendar.update")[0].params.reviewOnly, undefined);
  await f.controller.execute("apple_reminders_delete", { id: reminder().id, expectedRevision: REV }, context("delete"));
  const { notes: reminderNotes, ...reminderPreview } = reminder();
  assert.deepEqual(f.approvals[1].reviewOnly, { target: reminder().id, current: reminderPreview, changes: null });
  const beforeApprovals = f.approvals.length;
  await rejectsCode(f.controller.execute("apple_calendar_delete", { id: event().id, expectedRevision: "b".repeat(64), scope: "future" }, context("stale")), "APPLE_DEVICE_CONFLICT");
  assert.equal(f.approvals.length, beforeApprovals); assert.equal(f.operations("calendar.delete").length, 0);
});

test("write receipts cannot disclose existing fields while reads are denied or require separate approval", async t => {
  const privateEvent = { ...event(), notes: "PRIVATE OLD CALENDAR NOTES", location: "PRIVATE OLD LOCATION" };
  const privateReminder = { ...reminder(), notes: "PRIVATE OLD REMINDER NOTES", due: "2026-10-31T08:00:00Z" };
  const f = fixture(t, { onInvoke: async envelope => {
    if (["calendar.get", "calendar.update", "calendar.create"].includes(envelope.operation)) return { event: privateEvent };
    if (["reminders.get", "reminders.update", "reminders.create"].includes(envelope.operation)) return { reminder: privateReminder };
  } });
  for (const readPolicy of ["deny", "ask"]) {
    await f.policy("calendar", { enabled: true, readPolicy }); await f.policy("reminders", { enabled: true, readPolicy });
    const before = f.approvals.length;
    const calendarResult = await f.controller.execute("apple_calendar_update", { id: privateEvent.id, expectedRevision: REV, scope: "this", patch: { title: "Changed only title" } }, context(readPolicy + "-calendar"));
    const reminderResult = await f.controller.execute("apple_reminders_update", { id: privateReminder.id, expectedRevision: REV, patch: { completed: true } }, context(readPolicy + "-reminder"));
    assert.deepEqual(calendarResult, { event: { id: privateEvent.id, revision: REV } });
    assert.deepEqual(reminderResult, { reminder: { id: privateReminder.id, revision: REV } });
    assert.equal(f.approvals.length, before + 2, "only each write is approved; its result performs no data read");
    assert.equal(f.approvals.slice(before).every(input => /本次操作.*修改/u.test(input.reason)), true);
  }
  const createdEvent = await f.controller.execute("apple_calendar_create", createEvent(), context("create-receipt-event"));
  const createdReminder = await f.controller.execute("apple_reminders_create", { title: "Created" }, context("create-receipt-reminder"));
  assert.deepEqual(createdEvent, { event: { id: privateEvent.id, revision: REV } });
  assert.deepEqual(createdReminder, { reminder: { id: privateReminder.id, revision: REV } });
  const ledger = fs.readFileSync(f.controller.ledgerPath, "utf8");
  assert.equal(ledger.includes("PRIVATE OLD"), false);
  assert.equal(ledger.includes("2026-10-31"), false);
  assert.throws(() => validateAppleDeviceWriteReceipt("calendar.update", { event: privateEvent }), TypeError);
  assert.throws(() => validateAppleDeviceWriteReceipt("calendar.get", { event: { id: privateEvent.id, revision: REV } }), TypeError);
});

test("closing aborts pending approval even if its callback ignores cancellation", async t => {
  const waiting = deferred();
  const f = fixture(t, { onApproval: () => { waiting.resolve(); return new Promise(() => {}); } });
  await f.policy("calendar", { enabled: true });
  const operation = f.controller.execute("apple_calendar_create", createEvent(), context());
  const rejected = rejectsCode(operation, "APPLE_DEVICE_CANCELED");
  await waiting.promise; await f.controller.close(); await rejected;
  assert.equal(f.operations("calendar.create").length, 0);
});

test("closing aborts pending explicit Connect without waiting for the OS permission dialog", async t => {
  const waiting = deferred();
  const f = fixture(t, { onInvoke: envelope => { if (envelope.operation === "requestAccess") { waiting.resolve(); return new Promise(() => {}); } } });
  const operation = f.controller.connect({ resource: "calendar", expectedRevision: 1 });
  const rejected = rejectsCode(operation, "APPLE_DEVICE_CANCELED");
  await waiting.promise; await f.controller.close(); await rejected;
  assert.equal(f.controller.state.resources.calendar.enabled, false);
});

test("policy changes abort pending Connect authorization and a later Connect uses a fresh resource signal", async t => {
  const waiting = deferred(), release = deferred(), aborted = deferred();
  let holdFirst = true, firstSignal, secondSignalWasFresh = false;
  const f = fixture(t, { onInvoke: async (envelope, options) => {
    if (envelope.operation !== "requestAccess") return;
    assert.ok(options.signal instanceof AbortSignal);
    if (holdFirst) {
      holdFirst = false; firstSignal = options.signal;
      firstSignal.addEventListener("abort", () => aborted.resolve(), { once: true });
      waiting.resolve(); await release.promise;
      if (firstSignal.aborted) { const error = Error("authorization canceled"); error.code = "APPLE_DEVICE_CANCELED"; throw error; }
    } else secondSignalWasFresh = options.signal !== firstSignal && !options.signal.aborted;
  } });
  const connecting = f.controller.connect({ resource: "calendar", expectedRevision: f.controller.state.revision });
  connecting.catch(() => {});
  await waiting.promise;
  await f.policy("calendar", { readPolicy: "deny" });
  await aborted.promise;
  assert.equal(firstSignal.aborted, true);
  assert.equal(f.controller.state.resources.calendar.enabled, false);
  release.resolve();
  await rejectsCode(connecting, "APPLE_DEVICE_CANCELED");
  const reconnected = await f.controller.connect({ resource: "calendar", expectedRevision: f.controller.state.revision });
  assert.equal(secondSignalWasFresh, true);
  assert.equal(reconnected.resources[0].enabled, true);
  assert.equal(reconnected.resources[0].readPolicy, "deny");
  await f.controller.execute("apple_calendar_create", createEvent(), context("after-connect-cancel"));
  assert.equal(f.operations("calendar.create").length, 1);
});

test("async external owner revalidation runs after approval and blocks a removed assistant", async t => {
  let current = true, validations = 0;
  const f = fixture(t, { onApproval: () => { current = false; return true; } });
  await f.policy("calendar", { enabled: true });
  const caller = context("external", { revalidateCurrent: async () => { validations += 1; return current; } });
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), caller), "APPLE_DEVICE_CANCELED");
  assert.ok(validations >= 2); assert.equal(f.operations("calendar.create").length, 0);
});

test("closing aborts an already dispatched write and preserves unknown outcome", async t => {
  const waiting = deferred();
  const f = fixture(t, { onInvoke: envelope => { if (envelope.operation === "calendar.create") { waiting.resolve(); return new Promise(() => {}); } } });
  await f.policy("calendar", { enabled: true });
  const operation = f.controller.execute("apple_calendar_create", createEvent(), context());
  const rejected = rejectsCode(operation, "APPLE_DEVICE_CANCELED");
  await waiting.promise; await f.controller.close(); await rejected;
  assert.equal(JSON.parse(fs.readFileSync(f.controller.ledgerPath, "utf8")).entries[0].state, "unknown");
});

test("resource policy revocation cancels already forwarded native work before mutation and the next call has a fresh signal", async t => {
  const waiting = deferred(), release = deferred();
  let mutations = 0, queued = true, oldSignal, freshSignal;
  const f = fixture(t, { onInvoke: async (envelope, options) => {
    if (envelope.operation !== "calendar.create") return;
    assert.ok(options.signal instanceof AbortSignal, "native bridge receives the effective resource signal");
    if (queued) {
      oldSignal = options.signal; waiting.resolve(); await release.promise;
      if (options.signal.aborted) { const error = Error("canceled before native commit"); error.code = "APPLE_DEVICE_CANCELED"; throw error; }
    } else freshSignal = options.signal;
    mutations += 1;
  } });
  await f.policy("calendar", { enabled: true });
  const operation = f.controller.execute("apple_calendar_create", createEvent(), context("old-queued-write"));
  operation.catch(() => {});
  await waiting.promise;
  let discoveryCalls = 0;
  f.controller.getSubjects = () => { discoveryCalls += 1; return new Promise(() => {}); };
  let timeout;
  try {
    await Promise.race([f.policy("calendar", { enabled: false }), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("global off waited for directory discovery")), 1000); })]);
  } finally { clearTimeout(timeout); }
  assert.equal(discoveryCalls, 0, "unchanged assistant exclusions need no discovery before global off");
  assert.equal(oldSignal.aborted, true);
  release.resolve();
  await rejectsCode(operation, "APPLE_DEVICE_CANCELED");
  assert.equal(mutations, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.controller.ledgerPath, "utf8")).entries[0].state, "unknown");
  queued = false;
  await f.policy("calendar", { enabled: true });
  await f.controller.execute("apple_calendar_create", createEvent(), context("fresh-write"));
  assert.equal(mutations, 1); assert.notEqual(freshSignal, oldSignal); assert.equal(freshSignal.aborted, false);
});

test("revision overflow never persists an invalid policy or implicitly enables another device", async t => {
  const f = fixture(t); await f.controller.close();
  const stored = { schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER, resources: {
    calendar: { enabled: true, readPolicy: "allow", disabledProfileIds: [] },
    reminders: { enabled: false, readPolicy: "ask", disabledProfileIds: [] },
  } };
  const bytes = JSON.stringify(stored);
  fs.writeFileSync(f.controller.policyPath, bytes, { mode: 0o600 });
  const reopened = new AppleDeviceController(f.controllerOptions).open(); t.after(() => reopened.close());
  await rejectsCode(reopened.setPolicy({ resource: "calendar", enabled: false, readPolicy: "deny", writePolicy: "ask", disabledProfileIds: [], expectedRevision: stored.revision }), "APPLE_DEVICE_POLICY_CORRUPT");
  await rejectsCode(reopened.connect({ resource: "reminders", expectedRevision: stored.revision }), "APPLE_DEVICE_POLICY_CORRUPT");
  assert.equal(fs.readFileSync(f.controller.policyPath, "utf8"), bytes);
  assert.equal(reopened.state.resources.reminders.enabled, false);
});

test("failed assistant directory discovery permits disconnect and preserves previous blocks", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, disabledProfileIds: ["profile-2"] });
  f.controller.getSubjects = async () => { throw Error("offline"); };
  await f.policy("calendar", { enabled: false, readPolicy: "deny", disabledProfileIds: [] });
  assert.deepEqual(f.controller.state.resources.calendar.disabledProfileIds, ["profile-2"]);
  assert.equal(f.controller.state.resources.calendar.enabled, false);
  await rejectsCode(f.policy("calendar", { disabledProfileIds: ["new-profile"] }), "APPLE_DEVICE_SUBJECTS_UNAVAILABLE");
});

test("all calendar and reminders tool schemas route strict DTOs", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, readPolicy: "allow" }); await f.policy("reminders", { enabled: true, readPolicy: "allow" });
  const args = {
    apple_calendar_list: {}, apple_calendar_events: { start: "2026-10-27T00:00:00Z", end: "2026-10-28T00:00:00Z", limit: 10, calendarIds: [calendar.id] },
    apple_calendar_get: { id: event().id }, apple_calendar_create: createEvent(),
    apple_calendar_update: { id: event().id, expectedRevision: REV, scope: "future", patch: { notes: "Updated" } },
    apple_calendar_delete: { id: event().id, expectedRevision: REV, scope: "this" }, apple_reminders_lists: {},
    apple_reminders_search: { completed: false, listIds: [list.id], limit: 10 }, apple_reminders_get: { id: reminder().id },
    apple_reminders_create: { title: "Fixture", due: null, priority: 9 },
    apple_reminders_update: { id: reminder().id, expectedRevision: REV, patch: { completed: true, due: null } },
    apple_reminders_delete: { id: reminder().id, expectedRevision: REV },
  };
  assert.equal(TOOL_DEFINITIONS.length, 12); assert.equal(TOOL_CAPABILITIES.length, 12);
  for (const [name, value] of Object.entries(args)) {
    assert.equal(validateAppleDeviceArguments(name, value), true, name);
    const result = await f.controller.execute(name, value, context(name));
    (isWriteOperation(TOOL_OPERATIONS[name]) ? validateAppleDeviceWriteReceipt : validateAppleDeviceInvokeResult)(TOOL_OPERATIONS[name], result);
  }
  assert.equal(f.approvals.length, 6);
});

test("malformed arguments, getters, overbroad queries and confirmation flags fail before native access", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true }); const before = f.calls.length;
  const invalid = [
    ["apple_calendar_create", { ...createEvent(), confirmed: true }],
    ["apple_calendar_create", { ...createEvent(), start: "2026-10-27T09:00:00" }],
    ["apple_calendar_create", { ...createEvent(), start: "2026-02-30T09:00:00Z" }],
    ["apple_calendar_events", { start: "2026-01-01T00:00:00Z", end: "2028-01-01T00:00:00Z" }],
    ["apple_calendar_events", { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z", limit: 101 }],
    ["apple_calendar_update", { id: "x", expectedRevision: REV, scope: "this", patch: {} }],
    ["apple_calendar_update", { id: "x", expectedRevision: 1, scope: "all", patch: { title: "x" } }],
    ["apple_reminders_create", { title: "x", priority: 10 }],
    ["apple_reminders_update", { id: "x", expectedRevision: REV, patch: { completed: "yes" } }],
  ];
  for (const [name, args] of invalid) { assert.equal(validateAppleDeviceArguments(name, args), false); await assert.rejects(f.controller.execute(name, args, context()), TypeError); }
  const getter = {}; Object.defineProperty(getter, "id", { enumerable: true, get() { assert.fail("getter must not be invoked"); } });
  await assert.rejects(f.controller.execute("apple_calendar_get", getter, context()), TypeError);
  assert.equal(f.calls.length, before);
  await rejectsCode(f.controller.execute("apple_calendar_list", {}, context("x", { profileId: "spoof" })), "APPLE_DEVICE_IDENTITY_REQUIRED");
});

test("malformed native results are refused; a dispatched write becomes uncertain", async t => {
  const f = fixture(t, { onInvoke: async envelope => {
    if (envelope.operation === "calendar.list") return { calendars: [{ ...calendar, secret: "unexpected" }] };
    if (envelope.operation === "calendar.create") return { event: { ...event(), revision: "bad" } };
  } });
  await f.policy("calendar", { enabled: true, readPolicy: "allow" });
  await rejectsCode(f.controller.execute("apple_calendar_list", {}, context("read")), "APPLE_DEVICE_INVALID_HOST_RESULT");
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context()), "APPLE_DEVICE_INVALID_HOST_RESULT");
  await rejectsCode(f.controller.execute("apple_calendar_create", createEvent(), context()), "APPLE_DEVICE_WRITE_UNCERTAIN");
  assert.equal(f.operations("calendar.create").length, 1);
});

test("policy compare-and-swap prevents concurrent lost updates and retains unavailable assistant blocks", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, disabledProfileIds: ["profile-2"] });
  f.setSubjects({ items: [{ profileId: "profile-1" }], unavailableBackends: ["hermes"] });
  await f.policy("calendar", { readPolicy: "allow", disabledProfileIds: [] });
  assert.deepEqual(f.controller.state.resources.calendar.disabledProfileIds, ["profile-2"]);
  await rejectsCode(f.policy("calendar", { disabledProfileIds: ["unknown-profile"] }), "APPLE_DEVICE_PROFILE_INVALID");
  const expectedRevision = f.controller.state.revision;
  const results = await Promise.allSettled([
    f.controller.setPolicy({ resource: "calendar", enabled: true, readPolicy: "ask", writePolicy: "ask", disabledProfileIds: [], expectedRevision }),
    f.controller.setPolicy({ resource: "calendar", enabled: false, readPolicy: "deny", writePolicy: "ask", disabledProfileIds: [], expectedRevision }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "APPLE_DEVICE_REVISION_CONFLICT");
});

test("offline host status still permits safe policy saves and disconnect", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, readPolicy: "allow" });
  f.native.available = false; f.native.errorCode = "APPLE_DEVICE_HOST_UNAVAILABLE"; f.native.resources.forEach(r => { r.authorization = "unavailable"; });
  const result = await f.policy("calendar", { enabled: false, readPolicy: "deny" });
  assert.equal(result.available, false); assert.equal(result.resources[0].enabled, false); assert.equal(result.resources[0].readPolicy, "deny");
  const reopened = new AppleDeviceController(f.controllerOptions).open(); t.after(() => reopened.close());
  assert.equal((await reopened.status()).resources[0].enabled, false);
});

test("invalid or unsafe persisted policy fails closed without rewriting evidence", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true });
  fs.writeFileSync(f.controller.policyPath, "{bad", { mode: 0o600 });
  assert.throws(() => new AppleDeviceController(f.controllerOptions).open(), { code: "APPLE_DEVICE_POLICY_CORRUPT" });
  assert.equal(fs.readFileSync(f.controller.policyPath, "utf8"), "{bad");
  fs.unlinkSync(f.controller.policyPath); const target = path.join(f.root, "outside-policy"); fs.writeFileSync(target, "{}", { mode: 0o600 }); fs.symlinkSync(target, f.controller.policyPath);
  assert.throws(() => new AppleDeviceController(f.controllerOptions).open(), { code: "APPLE_DEVICE_POLICY_CORRUPT" });
});

test("open refuses differing target/backup crash evidence for policy and ledger without destroying evidence", async t => {
  for (const scope of ["policy", "ledger"]) {
    const f = fixture(t); await f.policy("calendar", { enabled: true, readPolicy: "allow" });
    await f.controller.execute("apple_calendar_create", createEvent(), context()); await f.controller.close();
    const target = scope === "policy" ? f.controller.policyPath : f.controller.ledgerPath;
    const original = fs.readFileSync(target), backup = `${target}.backup-${process.pid}-0123456789abcdef`, temp = `${target}.tmp`;
    const older = JSON.parse(original);
    if (scope === "policy") older.resources.calendar.enabled = false;
    else { older.entries[0].state = "pending"; older.entries[0].result = null; }
    const backupBytes = Buffer.from(JSON.stringify(older));
    fs.writeFileSync(backup, backupBytes, { mode: 0o600 }); fs.writeFileSync(temp, "never-committed-fixture", { mode: 0o600 });
    assert.throws(() => new AppleDeviceController(f.controllerOptions).open(), { code: scope === "policy" ? "APPLE_DEVICE_POLICY_CORRUPT" : "APPLE_DEVICE_LEDGER_CORRUPT" });
    assert.deepEqual(fs.readFileSync(target), original);
    assert.deepEqual(fs.readFileSync(backup), backupBytes);
    assert.equal(fs.readFileSync(temp, "utf8"), "never-committed-fixture");
  }
});

test("open safely recovers same-inode backups and uncommitted temp files while pending writes remain nonreplayable", async t => {
  const f = fixture(t); await f.policy("calendar", { enabled: true, readPolicy: "allow" });
  await f.controller.execute("apple_calendar_create", createEvent(), context()); await f.controller.close();
  const policyBytes = fs.readFileSync(f.controller.policyPath), ledger = JSON.parse(fs.readFileSync(f.controller.ledgerPath));
  const completed = clone(ledger); ledger.entries[0].state = "pending"; ledger.entries[0].result = null;
  fs.writeFileSync(f.controller.ledgerPath, JSON.stringify(ledger), { mode: 0o600 });
  const pendingBytes = fs.readFileSync(f.controller.ledgerPath);
  for (const target of [f.controller.policyPath, f.controller.ledgerPath]) {
    const backup = `${target}.backup-${process.pid}-fedcba9876543210`;
    fs.linkSync(target, backup);
    fs.writeFileSync(`${target}.tmp`, target === f.controller.policyPath ? JSON.stringify({ ...JSON.parse(policyBytes), revision: 999 }) : JSON.stringify(completed), { mode: 0o600 });
    assert.equal(fs.statSync(target).nlink, 2);
  }
  const restored = new AppleDeviceController(f.controllerOptions).open(); t.after(() => restored.close());
  assert.equal(restored.state.resources.calendar.enabled, true, "a provably prior committed allow remains the prior policy");
  assert.deepEqual(fs.readFileSync(f.controller.policyPath), policyBytes); assert.deepEqual(fs.readFileSync(f.controller.ledgerPath), pendingBytes);
  for (const target of [f.controller.policyPath, f.controller.ledgerPath]) {
    assert.equal(fs.existsSync(`${target}.tmp`), false); assert.equal(fs.existsSync(`${target}.backup-${process.pid}-fedcba9876543210`), false);
    assert.equal(fs.statSync(target).nlink, 1);
  }
  const before = f.operations("calendar.create").length;
  await rejectsCode(restored.execute("apple_calendar_create", createEvent(), context()), "APPLE_DEVICE_WRITE_UNCERTAIN");
  assert.equal(f.operations("calendar.create").length, before);
});

test("invalid ledger fails closed and management/host result contracts remain strict", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.controller.ledgerPath, JSON.stringify({ schemaVersion: 1, entries: [{ state: "complete" }] }), { mode: 0o600 });
  assert.throws(() => new AppleDeviceController(f.controllerOptions).open(), { code: "APPLE_DEVICE_LEDGER_CORRUPT" });
  assert.throws(() => validateAppleDeviceParams("connector.apple.connect", { resource: "contacts", expectedRevision: 1 }), TypeError);
  assert.throws(() => validateAppleDeviceParams("connector.apple.policy.set", { resource: "calendar", enabled: true, readPolicy: "always", writePolicy: "ask", disabledProfileIds: [], expectedRevision: 1 }), TypeError);
  assert.throws(() => validateAppleDeviceInvokeParams({ operation: "calendar.create", params: createEvent(), operationId: null }), TypeError);
  assert.throws(() => validateAppleDeviceInvokeParams({ operation: "status", params: {}, operationId: "apple-write-" + REV }), TypeError);
  const status = await f.controller.status();
  assert.throws(() => validateAppleDeviceResult("connector.apple.status", { ...status, extra: true }), TypeError);
});
