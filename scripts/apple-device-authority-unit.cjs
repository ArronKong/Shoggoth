#!/usr/bin/env node
"use strict";

// Actual authority backup/verify/staged restore. Every byte and device operation
// belongs to this temporary fixture; no installed App or personal Apple store.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAuthorityBackup, verifyAuthorityBackup, restoreAuthorityBackup } = require("../app/agent-service/authority-backup");
const { AppleDeviceController } = require("../app/agent-service/apple-device-controller");
const { quarantineAppleDevicePolicyForRestore } = require("../app/agent-service/apple-device-restore");
const { validateAppleDeviceInvokeParams } = require("../app/core/apple-device-contract");
const { DATA_AUTHORITY_MANIFEST } = require("../app/agent-service/data-authority-manifest");

const clone = value => JSON.parse(JSON.stringify(value));
const makeError = code => Object.assign(new Error(code), { code });
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/apple-authority-")); fs.chmodSync(root, 0o700);
  const pathsFor = stateDir => resolveServicePaths({ trustedRoot: root, stateRoot: stateDir, profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
  const paths = pathsFor(path.join(root, "source")); fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  const controllers = [];
  t.after(async () => { for (const controller of controllers) await controller.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, pathsFor, open(options) { const controller = new AppleDeviceController(options).open(); controllers.push(controller); return controller; } };
}
function nativeHost() {
  const calls = []; let sequence = 0;
  const status = { available: true, errorCode: null, resources: [{ id: "calendar", authorization: "fullAccess" }, { id: "reminders", authorization: "fullAccess" }] };
  const host = { calls, unknownNextWrite: false, async request(method, raw) {
    assert.equal(method, "apple.device.invoke"); const request = validateAppleDeviceInvokeParams(raw); calls.push(clone(request));
    const { operation, params } = request;
    if (["status", "requestAccess"].includes(operation)) return clone(status);
    sequence += 1;
    let result;
    const revision = crypto.createHash("sha256").update(String(sequence)).digest("hex");
    if (operation === "calendar.create") result = { event: { id: "event/authority-fixture/" + sequence, calendarId: "calendar/authority-fixture", title: params.title,
      start: params.start, end: params.end, allDay: false, timeZone: "Asia/Shanghai", notes: "", location: "", recurring: false, revision } };
    else if (operation === "reminders.create") result = { reminder: { id: "reminder/authority-fixture/" + sequence, listId: "list/authority-fixture", title: params.title,
      notes: "", due: null, priority: 0, completed: false, revision } };
    else assert.fail("Unexpected native authority fixture operation " + operation);
    if (host.unknownNextWrite) { host.unknownNextWrite = false; throw makeError("APPLE_DEVICE_FAILED"); }
    return result;
  } };
  return host;
}
function caller(callId) {
  return { profileId: "native-allowed", callId, signal: new AbortController().signal, assertCurrent() {}, identity: {
    backendId: "shoggoth", agentId: "authority-agent", sessionId: "authority-session", runId: "authority-run", profileId: "native-allowed", callId,
  } };
}
const subjects = async () => ({ items: ["native-allowed", "native-blocked", "mcp-hermes-blocked"].map(profileId => ({ profileId })), unavailableBackends: [] });
const validPolicy = () => ({ schemaVersion: 1, revision: 8, resources: {
  calendar: { enabled: true, readPolicy: "allow", disabledProfileIds: ["native-blocked"] },
  reminders: { enabled: true, readPolicy: "ask", disabledProfileIds: ["mcp-hermes-blocked"] },
} });

test("authority snapshot includes device policy and both receipt outcomes; restore disconnects devices and unknown writes never replay after reconnect", async t => {
  const f = fixture(t), host = nativeHost(); let approvals = 0;
  const source = f.open({ paths: f.paths, host, getSubjects: subjects, requestApproval: async () => { approvals += 1; return { approved: true }; } });
  await source.setPolicy({ resource: "calendar", enabled: true, readPolicy: "allow", writePolicy: "ask", disabledProfileIds: ["native-blocked"], expectedRevision: source.state.revision });
  await source.setPolicy({ resource: "reminders", enabled: true, readPolicy: "ask", writePolicy: "ask", disabledProfileIds: ["mcp-hermes-blocked"], expectedRevision: source.state.revision });
  const eventArgs = { title: "Completed authority fixture", start: "2026-10-27T09:00:00+08:00", end: "2026-10-27T10:00:00+08:00" };
  const completed = await source.execute("apple_calendar_create", eventArgs, caller("completed-call"));
  host.unknownNextWrite = true;
  const unknownArgs = { title: "Unresolved authority fixture" };
  await assert.rejects(source.execute("apple_reminders_create", unknownArgs, caller("unresolved-call")), { code: "APPLE_DEVICE_FAILED" });
  assert.equal(approvals, 2); await source.close();
  const sourcePolicy = fs.readFileSync(source.policyPath), sourceLedger = fs.readFileSync(source.ledgerPath);
  const originalPolicy = JSON.parse(sourcePolicy), originalLedger = JSON.parse(sourceLedger);
  assert.deepEqual(originalLedger.entries.map(entry => entry.state).sort(), ["complete", "unknown"]);
  const backup = createAuthorityBackup({ paths: f.paths, backupId: "apple-device-authority" });
  const verified = verifyAuthorityBackup({ paths: f.paths, backupId: "apple-device-authority" });
  assert.equal(backup.manifest.rootDigest, verified.manifest.rootDigest);
  for (const name of ["apple-device-policy.json", "apple-device-write-ledger.json"]) {
    const entry = verified.manifest.entries.find(entry => entry.path === name);
    assert.equal(entry.type, "file"); assert.equal(entry.mode & 0o077, 0);
    const bytes = fs.readFileSync(path.join(verified.backupPath, "payload", name));
    assert.equal(entry.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(bytes, name.includes("policy") ? sourcePolicy : sourceLedger);
  }
  const destination = path.join(f.root, "restored");
  const restoration = restoreAuthorityBackup({ paths: f.paths, backupId: "apple-device-authority", destinationStateDir: destination });
  assert.equal(restoration.rootDigest, verified.manifest.rootDigest);
  assert.deepEqual(fs.readFileSync(source.policyPath), sourcePolicy, "restoration never changes source grants");
  assert.deepEqual(fs.readFileSync(source.ledgerPath), sourceLedger, "restoration never changes source receipts");
  const restoredPaths = f.pathsFor(destination), restoredPolicy = JSON.parse(fs.readFileSync(path.join(destination, "apple-device-policy.json")));
  assert.equal(restoredPolicy.revision, originalPolicy.revision + 1);
  for (const resource of ["calendar", "reminders"]) {
    assert.deepEqual(restoredPolicy.resources[resource], { ...originalPolicy.resources[resource], enabled: false });
  }
  assert.deepEqual(fs.readFileSync(path.join(destination, "apple-device-write-ledger.json")), sourceLedger, "receipt bytes retained exactly");
  let restoredApprovals = 0;
  const restored = f.open({ paths: restoredPaths, host, getSubjects: subjects, requestApproval: async () => { restoredApprovals += 1; return { approved: true }; } });
  const beforeReconnect = host.calls.length;
  await assert.rejects(restored.execute("apple_calendar_create", eventArgs, caller("completed-call")), { code: "APPLE_DEVICE_ACCESS_DENIED" });
  await assert.rejects(restored.execute("apple_reminders_create", unknownArgs, caller("unresolved-call")), { code: "APPLE_DEVICE_ACCESS_DENIED" });
  assert.equal(host.calls.length, beforeReconnect, "a restored file never implies device connection");
  await restored.connect({ resource: "calendar", expectedRevision: restored.state.revision });
  await restored.connect({ resource: "reminders", expectedRevision: restored.state.revision });
  const nativeWrites = () => host.calls.filter(call => ["calendar.create", "reminders.create"].includes(call.operation)).length;
  const writesBeforeReplay = nativeWrites();
  assert.deepEqual(await restored.execute("apple_calendar_create", eventArgs, caller("completed-call")), completed);
  await assert.rejects(restored.execute("apple_reminders_create", unknownArgs, caller("unresolved-call")), { code: "APPLE_DEVICE_WRITE_UNCERTAIN" });
  assert.equal(nativeWrites(), writesBeforeReplay); assert.equal(restoredApprovals, 0, "receipts do not create a fresh approval/retry");
  assert.deepEqual(restored.state.resources.calendar.disabledProfileIds, ["native-blocked"]);
  assert.deepEqual(restored.state.resources.reminders.disabledProfileIds, ["mcp-hermes-blocked"]);
  assert.equal(DATA_AUTHORITY_MANIFEST.stores.appleDevices.backupRequired, true);
  assert.deepEqual(DATA_AUTHORITY_MANIFEST.stores.appleDevices.pathRules, ["stateDir/apple-device-policy.json", "stateDir/apple-device-write-ledger.json"]);
});

test("malformed Apple policy fails direct quarantine and actual staged restore without publishing a destination", t => {
  const f = fixture(t), file = path.join(f.paths.stateDir, "apple-device-policy.json");
  const malformed = [
    "{broken-json",
    JSON.stringify({ ...validPolicy(), schemaVersion: 2 }),
    JSON.stringify({ ...validPolicy(), resources: { ...validPolicy().resources, calendar: { ...validPolicy().resources.calendar, readPolicy: "always" } } }),
    JSON.stringify({ ...validPolicy(), resources: { ...validPolicy().resources, calendar: { ...validPolicy().resources.calendar, resource: "reminders" } } }),
    JSON.stringify({ ...validPolicy(), revision: Number.MAX_SAFE_INTEGER }),
  ];
  for (const [index, bytes] of malformed.entries()) {
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    assert.throws(() => quarantineAppleDevicePolicyForRestore({ paths: f.paths }), { code: "APPLE_DEVICE_POLICY_CORRUPT" });
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    const backupId = "invalid-device-policy-" + index;
    createAuthorityBackup({ paths: f.paths, backupId }); verifyAuthorityBackup({ paths: f.paths, backupId });
    const destination = path.join(f.root, "rejected-" + index);
    assert.throws(() => restoreAuthorityBackup({ paths: f.paths, backupId, destinationStateDir: destination }), { code: "APPLE_DEVICE_POLICY_CORRUPT" });
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith(".rejected-" + index + ".restore-")), false, "failed staging is cleaned");
    assert.equal(fs.readFileSync(file, "utf8"), bytes, "invalid source evidence retained");
  }
});

test("legacy authority backups without device policy remain unchanged and do not create device grants", async t => {
  const f = fixture(t), sentinel = Buffer.from("legacy authority fixture\n");
  fs.writeFileSync(path.join(f.paths.stateDir, "fixture-authority.txt"), sentinel, { mode: 0o600 });
  assert.deepEqual(quarantineAppleDevicePolicyForRestore({ paths: f.paths }), { disconnected: 0 });
  createAuthorityBackup({ paths: f.paths, backupId: "legacy-no-apple" });
  const verified = verifyAuthorityBackup({ paths: f.paths, backupId: "legacy-no-apple" });
  assert.equal(verified.manifest.entries.some(entry => entry.path.startsWith("apple-device-")), false);
  const destination = path.join(f.root, "legacy-restored");
  restoreAuthorityBackup({ paths: f.paths, backupId: "legacy-no-apple", destinationStateDir: destination });
  assert.deepEqual(fs.readFileSync(path.join(destination, "fixture-authority.txt")), sentinel);
  assert.equal(fs.existsSync(path.join(destination, "apple-device-policy.json")), false);
  assert.equal(fs.existsSync(path.join(destination, "apple-device-write-ledger.json")), false);
  const controller = f.open({ paths: f.pathsFor(destination), host: nativeHost(), getSubjects: subjects, requestApproval: async () => ({ approved: true }) });
  assert.deepEqual((await controller.status()).resources.map(resource => [resource.enabled, resource.readPolicy]), [[false, "ask"], [false, "ask"]]);
});

test("restore migrates legacy writing to ask and preserves explicit version 2 choices behind disconnected resources", async t => {
  const f = fixture(t), file = path.join(f.paths.stateDir, "apple-device-policy.json");
  fs.writeFileSync(file, JSON.stringify(validPolicy()), { mode: 0o600 });
  assert.deepEqual(quarantineAppleDevicePolicyForRestore({ paths: f.paths }), { disconnected: 2 });
  const migrated = JSON.parse(fs.readFileSync(file));
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(Object.values(migrated.resources).map(item => [item.enabled, item.writePolicy]), [[false, "ask"], [false, "ask"]]);
  migrated.resources.calendar.enabled = true; migrated.resources.calendar.writePolicy = "allow";
  migrated.resources.reminders.enabled = true; migrated.resources.reminders.writePolicy = "deny";
  fs.writeFileSync(file, JSON.stringify(migrated), { mode: 0o600 });
  createAuthorityBackup({ paths: f.paths, backupId: "writing-policy-choices" });
  const destination = path.join(f.root, "writing-restored");
  restoreAuthorityBackup({ paths: f.paths, backupId: "writing-policy-choices", destinationStateDir: destination });
  const restored = JSON.parse(fs.readFileSync(path.join(destination, "apple-device-policy.json")));
  assert.equal(restored.revision, migrated.revision + 1);
  for (const resource of ["calendar", "reminders"]) assert.deepEqual(restored.resources[resource], { ...migrated.resources[resource], enabled: false });
  assert.deepEqual(fs.readFileSync(file), Buffer.from(JSON.stringify(migrated)), "the backup source is unchanged");
});
