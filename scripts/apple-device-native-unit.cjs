"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createAppleDeviceNative, APPLE_DEVICE_OPERATIONS } = require("../app/apple-device-native");

const status = { calendar: "notDetermined", reminders: "denied" };
const coded = code => error => error.code === code && !error.message.includes("private-marker");

test("native wrapper sends structured requests and keeps returned opaque ids", async () => {
  const requests = [];
  const native = createAppleDeviceNative({ platform: "darwin", loadAddon: () => ({ invoke: async input => {
    requests.push(JSON.parse(input));
    return JSON.stringify({ ok: true, result: requests.length === 1 ? status : { event: { id: "event:opaque", revision: "a".repeat(64) } } });
  } }) });
  assert.deepEqual(await native.invoke("status"), status);
  const result = await native.invoke("calendar.get", { id: "event:opaque" });
  assert.equal(result.event.id, "event:opaque");
  assert.ok(requests.every(request => /^[a-f0-9-]{36}$/u.test(request.requestId)));
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.deepEqual(requests.map(({ operation, params }) => ({ operation, params })), [{ operation: "status", params: {} }, { operation: "calendar.get", params: { id: "event:opaque" } }]);
});

test("unavailable platform and malformed requests never load native code", async () => {
  let loads = 0;
  const loadAddon = () => { loads++; throw new Error("private-marker"); };
  await assert.rejects(createAppleDeviceNative({ platform: "linux", loadAddon }).invoke("status"), coded("APPLE_DEVICE_UNAVAILABLE"));
  const native = createAppleDeviceNative({ platform: "darwin", loadAddon });
  for (const [operation, params] of [["contacts.get", {}], ["calendar.get", []], ["status", null], ["status", Object.create(null)], ["status", { text: "x".repeat(65536) }]])
    await assert.rejects(native.invoke(operation, params), coded("APPLE_DEVICE_INVALID_ARGUMENT"));
  assert.equal(loads, 0);
  assert.ok(APPLE_DEVICE_OPERATIONS.includes("reminders.delete"));
  assert.ok(!APPLE_DEVICE_OPERATIONS.some(operation => operation.startsWith("contacts")));
});

test("native error codes are retained while system messages stay private", async () => {
  for (const code of ["APPLE_DEVICE_CONFLICT", "APPLE_DEVICE_PERMISSION_REQUIRED", "APPLE_DEVICE_TIMEOUT", "APPLE_DEVICE_READ_ONLY", "UNKNOWN"] ) {
    const native = createAppleDeviceNative({ platform: "darwin", loadAddon: () => ({ invoke: async () => JSON.stringify({ ok: false, error: { code, message: "private-marker /private/user-record" } }) }) });
    await assert.rejects(native.invoke("status"), coded(code === "UNKNOWN" ? "APPLE_DEVICE_FAILED" : code));
  }
});

test("malformed native responses, oversize output, and loading failures fail closed", async () => {
  for (const raw of ["private-marker", "[]", "null", JSON.stringify({ ok: true, result: [] }), " ".repeat(49153)]) {
    const native = createAppleDeviceNative({ platform: "darwin", loadAddon: () => ({ invoke: async () => raw }) });
    await assert.rejects(native.invoke("status"), coded("APPLE_DEVICE_FAILED"));
  }
  await assert.rejects(createAppleDeviceNative({ platform: "darwin", loadAddon: () => { throw new Error("private-marker"); } }).invoke("status"), coded("APPLE_DEVICE_UNAVAILABLE"));
});

test("production loader rejects an altered binary before require", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-apple-native-"));
  try {
    const addonPath = path.join(folder, "apple-device.node");
    fs.writeFileSync(addonPath, "changed native data");
    fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({ version: 1, napiVersion: 8,
      sha256: crypto.createHash("sha256").update("original native data").digest("hex") }));
    await assert.rejects(createAppleDeviceNative({ platform: "darwin", addonPath }).invoke("status"), coded("APPLE_DEVICE_UNAVAILABLE"));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("wrapper cancels the exact internal native invocation promptly without exposing caller approval flags", async () => {
  let finish;
  const execution = new Promise(resolve => { finish = resolve; });
  const invocations = [], cancellations = [];
  const native = createAppleDeviceNative({ platform: "darwin", loadAddon: () => ({
    invoke(input) { invocations.push(JSON.parse(input)); return execution; },
    cancel(id) { cancellations.push(id); return true; },
  }) });
  const controller = new AbortController();
  const pending = native.invoke("reminders.create", { title: "Fixture only" }, { signal: controller.signal });
  const cancelled = assert.rejects(pending, coded("APPLE_DEVICE_CANCELLED"));
  controller.abort(); await cancelled;
  assert.equal(invocations.length, 1); assert.deepEqual(cancellations, [invocations[0].requestId]);
  finish(JSON.stringify({ ok: true, result: { reminder: { id: "unused" } } }));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(native.invoke("status", {}, { signal: aborted.signal }), coded("APPLE_DEVICE_CANCELLED"));
  assert.equal(invocations.length, 1);
  const missingCancel = createAppleDeviceNative({ platform: "darwin", loadAddon: () => ({ invoke() { throw new Error("must not dispatch"); } }) });
  await assert.rejects(missingCancel.invoke("calendar.list", {}, { signal: new AbortController().signal }), coded("APPLE_DEVICE_UNAVAILABLE"));
});

// This test uses status and invalid envelopes. A record operation is exercised
// only after status proves it has no full system authorization, so the native
// guard must reject before creating a store or making a record query.
test("compiled addon supports N-API async status without touching user records", { skip: process.platform !== "darwin" || !fs.existsSync(path.join(__dirname, "../.vendor/apple-device/apple-device.node")) }, async () => {
  const addon = require("../.vendor/apple-device/apple-device.node");
  const promise = addon.invoke(JSON.stringify({ operation: "status", params: {} }));
  assert.ok(promise instanceof Promise);
  const response = JSON.parse(await promise);
  assert.equal(response.ok, true);
  const allowed = new Set(["notDetermined", "fullAccess", "writeOnly", "denied", "restricted", "unavailable"]);
  assert.ok(allowed.has(response.result.calendar));
  assert.ok(allowed.has(response.result.reminders));
  for (const input of ["null", "[]", "invalid json", JSON.stringify({ operation: "contacts.get", params: {} }), JSON.stringify({ operation: "status", params: { extra: true } }),
    JSON.stringify({ operation: "requestAccess", params: { resource: "contacts" } }),
    JSON.stringify({ operation: "requestAccess", params: { resource: "calendar\0" } })]) {
    const rejected = JSON.parse(await addon.invoke(input));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "APPLE_DEVICE_INVALID_ARGUMENT");
  }
  for (const [resource, operation] of [["calendar", "calendar.list"], ["reminders", "reminders.lists"]]) {
    if (response.result[resource] === "fullAccess") continue;
    const denied = JSON.parse(await addon.invoke(JSON.stringify({ operation, params: {} })));
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "APPLE_DEVICE_PERMISSION_REQUIRED");
  }
  assert.throws(() => addon.invoke("x".repeat(65537)), coded("APPLE_DEVICE_INVALID_ARGUMENT"));
});

test("status stays responsive while libuv's worker pool is occupied", { skip: process.platform !== "darwin" || !fs.existsSync(path.join(__dirname, "../.vendor/apple-device/apple-device.node")) }, () => {
  const addon = path.join(__dirname, "../.vendor/apple-device/apple-device.node");
  const script = `
    const crypto = require('node:crypto');
    const addon = require(${JSON.stringify(addon)});
    let workFinished = false;
    crypto.pbkdf2('isolated-fixture', 'salt', 200000, 32, 'sha512', () => { workFinished = true; });
    addon.invoke(JSON.stringify({operation:'status', params:{}})).then(raw => {
      if (workFinished || JSON.parse(raw).ok !== true) process.exitCode = 1;
      else process.stdout.write('responsive');
    }).catch(() => { process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ["-e", script], { env: { ...process.env, UV_THREADPOOL_SIZE: "1" }, encoding: "utf8", timeout: 10000 });
  assert.equal(output, "responsive");
});

test("queued native operations reject concurrent admission and honor cancellation before any access", { skip: process.platform !== "darwin" || !fs.existsSync(path.join(__dirname, "../.vendor/apple-device/apple-device.node")) }, () => {
  const addon = path.join(__dirname, "../.vendor/apple-device/apple-device.node");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "apple-native-cancel-"));
  const fifo = path.join(scratch, "worker.fifo");
  try {
  execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo], { timeout: 1000 });
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const addon = require(${JSON.stringify(addon)});
    const fifo = ${JSON.stringify(fifo)};
    // The first and only worker cannot complete open until this test releases
    // its writer. Cancellation therefore always precedes native execution,
    // independent of CPU speed or aggregate-test scheduling.
    fs.open(fifo, 'r', (error, fd) => { if (error) throw error; fs.closeSync(fd); });
    const invoke = (operation, params, requestId) => addon.invoke(JSON.stringify({operation, params, requestId})).then(JSON.parse);
    (async () => {
      // The invalid resource can never open a system authorization prompt,
      // including if a regression ignores the cancellation below.
      const pending = invoke('requestAccess', {resource:'contacts'}, 'fixture-authorization');
      assert.equal((await invoke('status', {}, 'fixture-status')).ok, true);
      assert.equal((await invoke('fixture.invalid', {}, 'fixture-rejected')).error.code, 'APPLE_DEVICE_BUSY');
      assert.equal(addon.cancel('unrelated-invocation'), false);
      assert.equal(addon.cancel('fixture-authorization'), true);
      assert.equal((await invoke('fixture.invalid', {}, 'fixture-still-rejected')).error.code, 'APPLE_DEVICE_BUSY');
      const writer = fs.openSync(fifo, 'w'); fs.closeSync(writer);
      assert.equal((await pending).error.code, 'APPLE_DEVICE_CANCELLED');
      assert.equal((await invoke('requestAccess', {resource:'contacts'}, 'fixture-after-complete')).error.code, 'APPLE_DEVICE_INVALID_ARGUMENT');
      assert.equal(addon.cancel('fixture-authorization'), false);
      process.stdout.write('cancelled-before-access');
    })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ["-e", script], { env: { ...process.env, UV_THREADPOOL_SIZE: "1" }, encoding: "utf8", timeout: 10000 });
  assert.equal(output, "cancelled-before-access");
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
