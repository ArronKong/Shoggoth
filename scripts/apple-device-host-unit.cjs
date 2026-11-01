"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { createAppleDeviceHost, SETTINGS } = require("../app/apple-device-host");
const { createFederationHostServer } = require("../app/federation-host-server");
const { FederationHostClient } = require("../app/agent-service/federation-host-client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { FEDERATION_PROTOCOL_VERSION } = require("../app/federation-host-protocol");

const status = { calendar: "notDetermined", reminders: "denied" };
const revision = "a".repeat(64);
const event = { id: "event:opaque-occurrence", calendarId: "calendar-1", title: "Fixture event", start: "2026-10-27T06:00:00.000Z",
  end: "2026-10-27T07:00:00.000Z", allDay: false, timeZone: "Asia/Shanghai", notes: "", location: "", recurring: false, revision };
const reminder = { id: "reminder:opaque", listId: "list-1", title: "Fixture reminder", notes: "", due: null, priority: 0, completed: false, revision };
const envelope = (operation, params = {}, operationId = null) => ({ operation, params, operationId });
const writeId = char => `apple-write-${char.repeat(64)}`;
const coded = code => error => error.code === code && !String(error.message).includes("private-fixture-canary");
const copy = value => structuredClone(value);

function resultFor(operation, params) {
  if (["status", "requestAccess"].includes(operation)) return copy(status);
  if (operation === "calendar.list") return { calendars: [{ id: "calendar-1", title: "Fixture", allowsModifications: true, isDefault: true }] };
  if (operation === "reminders.lists") return { lists: [{ id: "list-1", title: "Fixture", allowsModifications: true, isDefault: true }] };
  if (operation === "calendar.events") return { events: [copy(event)], truncated: false };
  if (operation === "reminders.search") return { reminders: [copy(reminder)], truncated: false };
  if (operation.endsWith(".delete")) return { id: params.id, deleted: true };
  return operation.startsWith("calendar.") ? { event: copy(event) } : { reminder: copy(reminder) };
}

test("desktop host normalizes authorization status without requesting access or reading records", async () => {
  const calls = [], opened = [];
  const host = createAppleDeviceHost({ native: { async invoke(operation, params) { calls.push({ operation, params }); return { ...status, unexpectedPrivateData: "private-fixture-canary" }; } },
    openExternal: async url => opened.push(url) });
  assert.deepEqual(await host.invoke(envelope("status")), { available: true, errorCode: null,
    resources: [{ id: "calendar", authorization: "notDetermined" }, { id: "reminders", authorization: "denied" }] });
  assert.deepEqual(calls, [{ operation: "status", params: {} }]);
  assert.deepEqual(opened, []);
});

test("desktop host strictly dispatches supported Calendar/Reminders operations and fixed settings URLs", async () => {
  const calls = [], opened = [];
  const host = createAppleDeviceHost({ native: { async invoke(operation, params) { calls.push({ operation, params }); return resultFor(operation, params); } },
    openExternal: async url => opened.push(url) });
  const inputs = [
    envelope("requestAccess", { resource: "calendar" }), envelope("requestAccess", { resource: "reminders" }),
    envelope("calendar.list"), envelope("calendar.events", { start: event.start, end: event.end, calendarIds: [event.calendarId], limit: 10 }),
    envelope("calendar.get", { id: event.id }), envelope("calendar.create", { title: event.title, start: event.start, end: event.end }, writeId("a")),
    envelope("calendar.update", { id: event.id, expectedRevision: revision, scope: "this", patch: { title: "Changed event" } }, writeId("b")),
    envelope("calendar.delete", { id: event.id, expectedRevision: revision, scope: "future" }, writeId("c")),
    envelope("reminders.lists"), envelope("reminders.search", { listIds: [reminder.listId], completed: false, limit: 10 }),
    envelope("reminders.get", { id: reminder.id }), envelope("reminders.create", { title: reminder.title }, writeId("d")),
    envelope("reminders.update", { id: reminder.id, expectedRevision: revision, patch: { completed: true } }, writeId("e")),
    envelope("reminders.delete", { id: reminder.id, expectedRevision: revision }, writeId("f")),
  ];
  for (const input of inputs) await host.invoke(input);
  assert.deepEqual(calls, inputs.map(({ operation, params }) => ({ operation, params })));
  for (const resource of ["calendar", "reminders"]) assert.deepEqual(await host.invoke(envelope("settings.open", { resource })), { opened: true });
  assert.deepEqual(opened, [SETTINGS.calendar, SETTINGS.reminders]);
  const count = calls.length;
  for (const input of [envelope("contacts.list"), envelope("requestAccess", { resource: "contacts" }), envelope("settings.open", { resource: "https://example.com" }),
    envelope("settings.open", { resource: "calendar", url: "file:///private-fixture-canary" }), envelope("status", { approved: true }),
    envelope("calendar.get", { id: event.id, approved: true }), envelope("reminders.create", { title: "No write identity" }),
    { ...envelope("status"), approved: true }])
    await assert.rejects(host.invoke(input), coded("APPLE_DEVICE_INVALID_ARGUMENT"));
  assert.equal(calls.length, count);
  assert.equal(opened.length, 2);
});

test("desktop host exposes safe unavailable status and rejects malformed native output", async () => {
  const host = createAppleDeviceHost({ native: { async invoke() { throw Object.assign(new Error("private-fixture-canary"), { code: "APPLE_DEVICE_UNAVAILABLE" }); } }, openExternal: async () => {} });
  assert.deepEqual(await host.invoke(envelope("status")), { available: false, errorCode: "APPLE_DEVICE_UNAVAILABLE",
    resources: [{ id: "calendar", authorization: "unavailable" }, { id: "reminders", authorization: "unavailable" }] });
  for (const operation of ["requestAccess", "calendar.list"]) await assert.rejects(host.invoke(envelope(operation, operation === "requestAccess" ? { resource: "calendar" } : {})), { code: "APPLE_DEVICE_UNAVAILABLE" });
  for (const result of [null, undefined, [], { calendar: "unknown", reminders: "fullAccess" }, { calendar: "fullAccess" }]) {
    const malformed = createAppleDeviceHost({ native: { invoke: async () => result }, openExternal: async () => {} });
    await assert.rejects(malformed.invoke(envelope("status")), coded("APPLE_DEVICE_UNAVAILABLE"));
  }
  const malformedRead = createAppleDeviceHost({ native: { invoke: async () => ({ calendars: [{ id: "x", title: "unsafe shape" }] }) }, openExternal: async () => {} });
  await assert.rejects(malformedRead.invoke(envelope("calendar.list")), coded("APPLE_DEVICE_UNAVAILABLE"));
});

async function fixture(nativeInvoke = async (operation, params) => resultFor(operation, params), { noNative = false } = {}) {
  // Keep sockaddr_un paths short and all state beneath a private disposable root.
  const root = fs.mkdtempSync("/private/tmp/apple-host-"); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "s"), profileRoot: path.join(root, "p"), cacheRoot: path.join(root, "c") });
  const calls = [], opened = [], registryCalls = [];
  const native = { async invoke(operation, params) { calls.push({ operation, params: copy(params) }); return nativeInvoke(operation, params); } };
  const appleDeviceHost = createAppleDeviceHost({ native, openExternal: async url => opened.push(url) });
  const registry = { async getStatus() { registryCalls.push("getStatus"); return []; }, getBackend() { registryCalls.push("getBackend"); return null; } };
  const host = createFederationHostServer({ paths, registry, ...(noNative ? {} : { appleDeviceHost }) });
  try { await host.start(); }
  catch (error) { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
  const client = new FederationHostClient({ paths });
  return { root, paths, calls, opened, registryCalls, host, client,
    async close() { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function rawRequest(paths, params, token = fs.readFileSync(paths.federationTokenPath, "utf8").trim()) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.federationSocketPath);
    let bytes = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("fixture socket timeout")); }, 2000);
    socket.once("connect", () => socket.write(JSON.stringify({ id: crypto.randomUUID(), version: FEDERATION_PROTOCOL_VERSION, token, method: "apple.device.invoke", params }) + "\n"));
    socket.on("data", chunk => { bytes += chunk; });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
    socket.once("end", () => { clearTimeout(timer); try { resolve(JSON.parse(bytes)); } catch (error) { reject(error); } });
  });
}

test("private Host socket/client routes devices with identity-checked params and no backend access", async () => {
  const f = await fixture();
  try {
    assert.equal(fs.lstatSync(f.paths.runtimeDir).mode & 0o077, 0);
    assert.equal(fs.lstatSync(f.paths.federationSocketPath).mode & 0o077, 0);
    assert.equal(fs.lstatSync(f.paths.federationTokenPath).mode & 0o077, 0);
    const current = await f.client.request("apple.device.invoke", envelope("status"));
    assert.equal(current.available, true);
    assert.deepEqual(await f.client.request("apple.device.invoke", envelope("calendar.get", { id: event.id })), { event });
    assert.deepEqual(await f.client.request("apple.device.invoke", envelope("settings.open", { resource: "reminders" })), { opened: true });
    assert.deepEqual(f.opened, [SETTINGS.reminders]);
    assert.deepEqual(f.registryCalls, []);
    assert.deepEqual(f.calls.map(call => call.operation), ["status", "calendar.get"]);
    for (const invalid of [envelope("calendar.get", { id: event.id, approved: true }), envelope("status", { resource: "calendar" }),
      envelope("calendar.delete", { id: event.id, expectedRevision: revision, scope: "all" }, writeId("a")),
      envelope("calendar.create", { title: "bad timezone", start: "2026-10-27T06:00:00", end: event.end }, writeId("b"))]) {
      await assert.rejects(f.client.request("apple.device.invoke", invalid), coded("APP_HOST_INVALID_REQUEST"));
      assert.equal((await rawRequest(f.paths, invalid)).error.code, "APP_HOST_INVALID_REQUEST");
    }
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test("private Host deduplicates simultaneous and repeated writes and binds each operation id to arguments", async () => {
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const f = await fixture(async (operation, params) => { if (operation === "reminders.create") await ready; return resultFor(operation, params); });
  try {
    const input = envelope("reminders.create", { title: reminder.title }, writeId("a"));
    const first = f.client.request("apple.device.invoke", input), second = f.client.request("apple.device.invoke", input);
    finish();
    assert.deepEqual(await first, { reminder }); assert.deepEqual(await second, { reminder });
    assert.deepEqual(await f.client.request("apple.device.invoke", input), { reminder });
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.client.request("apple.device.invoke", { ...input, params: { title: "Changed parameters" } }), coded("APPLE_DEVICE_CONFLICT"));
    assert.equal(f.calls.length, 1);
  } finally { finish(); await f.close(); }
});

test("private Host keeps native conflicts safe and rejects stale/missing tokens before dispatch", async () => {
  const f = await fixture(async operation => {
    if (operation === "calendar.delete") throw Object.assign(new Error("private-fixture-canary record details"), { code: "APPLE_DEVICE_CONFLICT" });
    return copy(status);
  });
  try {
    const input = envelope("calendar.delete", { id: event.id, expectedRevision: revision, scope: "this" }, writeId("c"));
    await assert.rejects(f.client.request("apple.device.invoke", input), coded("APPLE_DEVICE_CONFLICT"));
    await assert.rejects(f.client.request("apple.device.invoke", input), coded("APPLE_DEVICE_CONFLICT"));
    assert.equal(f.calls.length, 1);
    const token = fs.readFileSync(f.paths.federationTokenPath, "utf8");
    assert.equal((await rawRequest(f.paths, envelope("status"), "stale-token")).error.code, "APP_HOST_INVALID_REQUEST");
    assert.equal((await rawRequest(f.paths, envelope("status"), null)).error.code, "APP_HOST_INVALID_REQUEST");
    fs.unlinkSync(f.paths.federationTokenPath);
    await assert.rejects(f.client.request("apple.device.invoke", envelope("status")), coded("APP_HOST_UNAVAILABLE"));
    fs.writeFileSync(f.paths.federationTokenPath, token, { mode: 0o600 });
    await f.host.stop(); await f.host.start();
    assert.equal((await rawRequest(f.paths, envelope("status"), token.trim())).error.code, "APP_HOST_INVALID_REQUEST");
    assert.equal((await f.client.request("apple.device.invoke", envelope("status"))).available, true);
  } finally { await f.close(); }
});

test("lost write reply is uncertain and the same live Host operation reservation prevents replay", async () => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const ready = new Promise(resolve => { finish = resolve; });
  const f = await fixture(async (operation, params) => { entered(); await ready; return resultFor(operation, params); });
  try {
    const input = envelope("reminders.create", { title: reminder.title }, writeId("d"));
    const pending = f.client.request("apple.device.invoke", input);
    const uncertain = assert.rejects(pending, coded("FEDERATION_COMMIT_UNCERTAIN"));
    await started; await f.host.stop(); await uncertain;
    finish(); await f.host.start();
    assert.deepEqual(await f.client.request("apple.device.invoke", input), { reminder });
    assert.equal(f.calls.length, 1, "socket interruption cannot replay a native mutation in this Host");
  } finally { finish(); await f.close(); }
});

test("Host without an injected desktop device implementation returns unavailable", async () => {
  const f = await fixture(undefined, { noNative: true });
  try { await assert.rejects(f.client.request("apple.device.invoke", envelope("status")), coded("APPLE_DEVICE_UNAVAILABLE")); }
  finally { await f.close(); }
});
