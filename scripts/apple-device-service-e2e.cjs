#!/usr/bin/env node
"use strict";

// Real Service -> IPC -> Backend -> REST, native MCP binding, and actual
// OpenClaw/Hermes adapters. Apple native data is an isolated in-memory fixture.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { startAppleDeviceServiceFixture } = require("./fixtures/apple-device-service-fixture.cjs");
const { ensureCredential, readCredential } = require("../app/agent-service/external-host-pairing");
const { requestService } = require("../app/agent-service/client");
const { authenticateMcpSession, createMcpStdioHandler } = require("../app/shoggoth-mcp-helper");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const { mcpConnectorSubjectId } = require("../app/core/mcp-connector-identity");
const { validateAppleDeviceResult } = require("../app/core/apple-device-contract");

const uuid = () => crypto.randomUUID();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function bounded(promise, label, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Apple device E2E timeout: " + label)), ms); })]).finally(() => clearTimeout(timer));
}
async function until(read, predicate, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await delay(15); }
  throw Error("Apple device E2E condition timeout: " + label);
}
const codeOf = value => value?.error?.code || value?.code || value?.result?.structuredContent?.code;
const success = value => { assert.equal(codeOf(value), undefined, JSON.stringify(value)); return value; };
const eventInput = title => ({ title, start: "2026-10-27T11:00:00+08:00", end: "2026-10-27T12:00:00+08:00" });

function startHermes(f) {
  const child = spawn("python3", ["-B", path.join(__dirname, "fixtures/apple-device-hermes-driver.py")], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root },
  });
  const pending = new Map(); let readyResolve, readyReject, stderr = "";
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const message = JSON.parse(line);
      if (message.ready) return readyResolve(message);
      const request = pending.get(message.id); if (request) { pending.delete(message.id); request.resolve(message.result); }
    } catch (error) { readyReject(error); }
  });
  child.on("error", readyReject);
  child.on("exit", code => { const error = Error("Hermes device fixture exited " + code + ": " + stderr); readyReject(error); for (const request of pending.values()) request.reject(error); pending.clear(); });
  child.stdin.write(JSON.stringify({ stateDir: f.paths.stateDir, runtimeDir: f.paths.runtimeDir }) + "\n");
  return { child, ready,
    async call(name, args, turn = "device-turn", callId = uuid()) {
      await ready; const id = uuid();
      const promise = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, callId, name, arguments: args, turn }) + "\n"); });
      return bounded(promise, "Hermes " + name);
    },
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.end(JSON.stringify({ close: true }) + "\n");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(1200).then(() => child.kill("SIGKILL"))]); lines.close();
    },
  };
}

async function main() {
  let f, hermes, nativeHelper, nativeSession, nativeRun, nativeContext;
  const evidence = [];
  try {
    f = await bounded(startAppleDeviceServiceFixture(), "fixture startup", 30000);
    const rest = async (endpoint, body, { status = 200, origin = f.url, method = body === undefined ? "GET" : "POST" } = {}) => {
      const response = await fetch(f.url + "/__api/connectors/" + endpoint, { method, signal: AbortSignal.timeout(10000),
        ...(method === "POST" ? { headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) } : {}) });
      const text = await response.text(); let data;
      try { data = JSON.parse(text); } catch { data = { error: text }; }
      assert.equal(response.status, status, endpoint + ": " + JSON.stringify(data)); return data;
    };
    const status = () => rest("apple/status");
    const policy = async (resource, patch) => {
      const current = await status(), previous = current.resources.find(item => item.id === resource);
      return rest("apple/policy", { resource, enabled: previous.enabled, readPolicy: previous.readPolicy, writePolicy: previous.writePolicy,
        disabledProfileIds: previous.disabledProfileIds, ...patch, expectedRevision: current.revision });
    };
    const inbox = () => rest("mcp/approvals");
    const resolveExternal = item => rest("mcp/approval-resolve", { requestId: item.requestId, argumentDigest: item.argumentDigest, approved: true });
    const waitExternal = (backend, name) => until(inbox, result => result.items.some(item => item.backendId === backend && item.toolName === name), "external approval " + backend + "/" + name)
      .then(result => result.items.find(item => item.backendId === backend && item.toolName === name));
    const approveExternal = async (promise, backend, name, inspect = () => {}) => {
      promise.catch(() => {}); const item = await waitExternal(backend, name);
      assert.match(item.requestId, /^apple-device-/u); assert.match(item.argumentDigest, /^[a-f0-9]{64}$/u);
      inspect(item); await resolveExternal(item); return bounded(promise, "external approved " + name);
    };

    const initial = await status(); validateAppleDeviceResult("connector.apple.status", initial);
    assert.equal(initial.available, true); assert.deepEqual(initial.resources.map(r => [r.id, r.enabled, r.readPolicy, r.writePolicy, r.authorization]),
      [["calendar", false, "ask", "ask", "notDetermined"], ["reminders", false, "ask", "ask", "notDetermined"]]);
    const unauthorizedBefore = f.synthetic.count("requestAccess");
    await rest("apple/connect", { resource: "calendar", expectedRevision: initial.revision }, { origin: "https://untrusted.example", status: 403 });
    assert.equal(f.synthetic.count("requestAccess"), unauthorizedBefore);
    await rest("apple/connect", { resource: "contacts", expectedRevision: initial.revision }, { status: 400 });
    await rest("apple/status?unexpected=1", undefined, { status: 400 });
    await rest("apple/policy", { resource: "calendar", enabled: true, readPolicy: "always", writePolicy: "ask", disabledProfileIds: [], expectedRevision: initial.revision }, { status: 400 });
    await rest("apple/policy", { resource: "calendar", enabled: true, readPolicy: "allow", writePolicy: "always", disabledProfileIds: [], expectedRevision: initial.revision }, { status: 400 });
    let connected = await rest("apple/connect", { resource: "calendar", expectedRevision: initial.revision });
    assert.equal(connected.resources[0].enabled, true); assert.equal(connected.resources[1].enabled, false);
    await rest("apple/connect", { resource: "reminders", expectedRevision: initial.revision }, { status: 409 });
    connected = await rest("apple/connect", { resource: "reminders", expectedRevision: connected.revision });
    assert.equal(connected.resources[1].authorization, "fullAccess");
    await rest("apple/settings", { resource: "reminders" });
    assert.deepEqual(f.synthetic.openedSettings, ["x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders"]);
    assert.equal(f.service.toolRegistry.list().filter(tool => tool.tool.startsWith("apple_")).length, 12);
    assert.equal(f.service.toolRegistry.list().some(tool => /^apple_.*contacts/u.test(tool.tool)), false);
    evidence.push("REST exact DTOs, independent Connect/TCC, mutation Origin, invalid parameters, CAS conflict, system settings route, twelve tools without contacts");

    // A real native profile/session/run supplies the execution lease. The fake
    // model only forwards runtime binding; it never supplies an approval result.
    const created = await f.ipc("agent.create", { operationId: uuid(), backendId: "shoggoth", name: "Apple device native fixture", defaultCwd: null, createdAt: Date.now() });
    const profile = f.service.productStore.getAgentProfile(created.profile.id);
    const session = (await f.ipc("chat.session.create", { operationId: uuid(), profileId: profile.id, workspace: f.paths.defaultWorkspaceDir, createdAt: Date.now() })).session;
    f.service.chatSessionStore.setPermissionMode(session.sessionKey, "auto-review");
    const send = async () => {
      const { run } = await f.ipc("chat.send", { operationId: uuid(), sessionKey: session.sessionKey, prompt: "Validate Apple device fixture behavior.", createdAt: Date.now() });
      nativeRun = run;
      nativeContext = await until(() => f.service.workRunCoordinator.runContexts.get(run.id), value => value?.threadId && value?.turnId
        && f.service.workDispatcher.getRun(run.id).status === "running", "native active runtime binding");
      return run;
    };
    const control = async (action, params) => {
      const id = uuid(), directory = path.join(f.root, "group-control"), responsePath = path.join(directory, id + ".response.json");
      fs.writeFileSync(path.join(directory, id + ".request.json"), JSON.stringify({ id, action, params, threadId: nativeContext.threadId, turnId: nativeContext.turnId }), { mode: 0o600 });
      const result = await until(() => { try { return JSON.parse(fs.readFileSync(responsePath, "utf8")); } catch { return null; } }, value => value !== null, "native control " + action);
      assert.equal(result.error, undefined, JSON.stringify(result)); return result.result;
    };
    await send();
    nativeSession = await authenticateMcpSession({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
    nativeHelper = createMcpStdioHandler({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
      sessionToken: nativeSession.token, bindRuntimeCalls: true, requestService });
    await nativeHelper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "apple-device-e2e", version: "1" } } });
    const nativeCall = async (name, args) => {
      const response = await nativeHelper({ jsonrpc: "2.0", id: uuid(), method: "tools/call", params: { name, arguments: args } }, {
        requestClient: async (method, params) => {
          assert.equal(method, "elicitation/create"); assert.ok(params._meta?.["shoggoth/runtime-call-binding"], "device calls must use their own domain approval card");
          return control("binding", params);
        },
      });
      assert.ok(response.result, JSON.stringify(response)); return response.result.structuredContent || response.result;
    };
    const approveNative = async (promise, toolName, inspect = () => {}, choice = "once") => {
      promise.catch(() => {});
      const coordinator = f.service.workRunCoordinator;
      const run = await until(() => coordinator.getRun(nativeRun.id), value => value.status === "waiting_approval", "native device approval");
      const record = coordinator.pendingRequests.get(run.waitingRequestId);
      assert.equal(record.method, "shoggoth/pluginTool/requestApproval"); assert.equal(record.params.toolName, toolName);
      assert.equal(record.params.sessionApprovalAvailable, false); assert.match(record.params.reason, /Apple/u);
      inspect(record);
      await f.ipc("run.approval.respond", { operationId: uuid(), createdAt: Date.now(), runId: run.id, requestId: run.waitingRequestId, choice });
      return bounded(promise, "native approved " + toolName);
    };

    await policy("calendar", { readPolicy: "allow" });
    const nativeRead = success(await nativeCall("apple_calendar_list", {})); assert.equal(nativeRead.calendars[0].title, "Fixture calendar");
    assert.equal(f.service.workRunCoordinator.getRun(nativeRun.id).status, "running");
    await policy("calendar", { readPolicy: "ask" });
    await approveNative(nativeCall("apple_calendar_list", {}), "apple_calendar_list");
    await approveNative(nativeCall("apple_calendar_list", {}), "apple_calendar_list");
    await policy("calendar", { readPolicy: "deny" });
    const deniedBefore = f.synthetic.count("calendar.list");
    assert.equal(codeOf(await nativeCall("apple_calendar_list", {})), "APPLE_DEVICE_ACCESS_DENIED");
    assert.equal(f.synthetic.count("calendar.list"), deniedBefore);
    const contract = f.service.workRunCoordinator.runExecutionContracts.get(nativeRun.id), confirmedCallId = uuid();
    const confirmedWrite = f.service.workRunCoordinator.invokeRuntimeCapability({ runtimeProfileId: contract.runtimeProfileId,
      runtimeAccountId: contract.runtimeAccountId, runId: nativeRun.id }, scope => f.service.mcpProductToolController.handle("apple_calendar_create",
      eventInput("Native exact approval fixture"), { profileId: profile.id, callId: confirmedCallId, confirmation: true }, scope));
    const nativeCreated = success(await approveNative(confirmedWrite, "apple_calendar_create", record => {
      assert.equal(record.params.toolInput.title, "Native exact approval fixture");
      assert.equal(f.synthetic.count("calendar.create"), 0, "caller confirmation cannot dispatch before device approval");
    }));
    assert.deepEqual(Object.keys(nativeCreated.event).sort(), ["id", "revision"]);
    assert.equal(f.synthetic.events.get(nativeCreated.event.id).title, "Native exact approval fixture");
    const nativeUpdate = nativeCall("apple_calendar_update", { id: nativeCreated.event.id, expectedRevision: nativeCreated.event.revision,
      scope: "this", patch: { title: "Native updated fixture" } });
    const nativeUpdated = success(await approveNative(nativeUpdate, "apple_calendar_update", record => {
      assert.equal(record.params.toolInput.target.current.title, "Native exact approval fixture");
      assert.equal(record.params.toolInput.arguments.patch.title, "Native updated fixture");
    }));
    await approveNative(nativeCall("apple_calendar_delete", { id: nativeUpdated.event.id, expectedRevision: nativeUpdated.event.revision, scope: "this" }), "apple_calendar_delete");
    await policy("calendar", { writePolicy: "allow" });
    assert.equal((await status()).resources.find(item => item.id === "reminders").writePolicy, "ask");
    const allowedNative = success(await bounded(nativeCall("apple_calendar_create", eventInput("Native allowed fixture")), "native allowed create"));
    assert.equal(f.service.workRunCoordinator.getRun(nativeRun.id).status, "running", "Allow does not create an approval wait");
    assert.deepEqual(Object.keys(allowedNative.event).sort(), ["id", "revision"]);
    const allowedNativeUpdate = success(await bounded(nativeCall("apple_calendar_update", { id: allowedNative.event.id, expectedRevision: allowedNative.event.revision,
      scope: "this", patch: { title: "Native allowed update" } }), "native allowed update"));
    success(await bounded(nativeCall("apple_calendar_delete", { id: allowedNativeUpdate.event.id, expectedRevision: allowedNativeUpdate.event.revision, scope: "this" }), "native allowed delete"));
    await policy("calendar", { writePolicy: "deny", readPolicy: "allow" });
    const beforeNativeOff = f.synthetic.count("calendar.create");
    assert.equal(codeOf(await nativeCall("apple_calendar_create", eventInput("Off must refuse"))), "APPLE_DEVICE_ACCESS_DENIED");
    assert.equal(f.synthetic.count("calendar.create"), beforeNativeOff);
    success(await nativeCall("apple_calendar_list", {}));
    await control("complete"); await bounded(f.service.workRunCoordinator.waitForTerminal(nativeRun.id), "native completion");
    nativeHelper.close(); nativeHelper = null; nativeSession.close?.(); nativeSession = null;
    evidence.push("native helper and trusted runtime binding: independent read/write allow/ask/deny, default Ask resists auto-review/caller-confirmation, Allow CRUD has no approval wait and exposes only receipts, Off refuses mutation while reading remains usable");

    // The actual external adapter registration/middleware and credential pairing
    // must supply backend/agent/session/call identity over the private Service socket.
    ensureCredential(f.paths, "openclaw"); ensureCredential(f.paths, "hermes");
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname, "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter = createAdapter({ instanceId: "oc-device-fixture-host", credential: () => readCredential(f.paths, "openclaw"),
      requestService: (method, params, options) => requestService(f.paths, { id: uuid(), version: PROTOCOL_VERSION, method, params }, options) });
    let before; const tools = new Map();
    adapter.register({ on(name, handler) { if (name === "before_tool_call") before = handler; }, registerTool(factory, { name }) { tools.set(name, factory); } });
    assert.equal([...tools.keys()].filter(name => name.startsWith("apple_")).length, 12);
    const ocCall = async (name, args, turn = "device-turn", callId = uuid()) => {
      const ctx = { agentId: "oc-device-fixture", sessionId: "oc-device-fixture-session", runId: turn };
      const blocked = before({ toolName: name, toolCallId: callId }, ctx); assert.equal(blocked?.block, undefined);
      try { return (await tools.get(name)(ctx).execute(callId, args)).details; } catch (error) { return { code: error.code }; }
    };
    hermes = startHermes(f); const hermesInfo = await bounded(hermes.ready, "Hermes registration"); assert.equal(hermesInfo.deviceTools.length, 12);
    const lanes = [{ backend: "openclaw", agent: "oc-device-fixture", call: ocCall }, { backend: "hermes", agent: "hermes-device-fixture", call: hermes.call }];
    for (const lane of lanes) {
      await policy("reminders", { enabled: true, readPolicy: "allow", writePolicy: "ask", disabledProfileIds: [] });
      success(await lane.call("apple_reminders_lists", {}, "allow"));
      assert.equal((await inbox()).items.filter(item => item.backendId === lane.backend).length, 0);
      await policy("reminders", { readPolicy: "ask" });
      for (let count = 0; count < 2; count++) success(await approveExternal(lane.call("apple_reminders_search", {}, "ask"), lane.backend, "apple_reminders_search"));
      await policy("reminders", { readPolicy: "deny" });
      const readCount = f.synthetic.count("reminders.search");
      assert.equal(codeOf(await lane.call("apple_reminders_search", {}, "deny")), "APPLE_DEVICE_ACCESS_DENIED");
      assert.equal(f.synthetic.count("reminders.search"), readCount);
      const createdReminder = success(await approveExternal(lane.call("apple_reminders_create", { title: lane.backend + " approved reminder" }, "write"), lane.backend, "apple_reminders_create",
        item => { assert.match(item.argumentsPreview, /approved reminder/u); assert.match(item.reason, /创建提醒事项/u); }));
      const completed = success(await approveExternal(lane.call("apple_reminders_update", { id: createdReminder.reminder.id, expectedRevision: createdReminder.reminder.revision,
        patch: { completed: true } }, "write"), lane.backend, "apple_reminders_update", item => {
        assert.match(item.argumentsPreview, /approved reminder/u, "approval preview includes authoritative target title");
      }));
      assert.deepEqual(Object.keys(completed.reminder).sort(), ["id", "revision"]);
      assert.equal(f.synthetic.reminders.get(completed.reminder.id).completed, true);
      success(await approveExternal(lane.call("apple_reminders_delete", { id: completed.reminder.id, expectedRevision: completed.reminder.revision }, "write"), lane.backend, "apple_reminders_delete"));
      await policy("reminders", { writePolicy: "allow" });
      const allowed = success(await bounded(lane.call("apple_reminders_create", { title: lane.backend + " allowed reminder" }, "allow-write"), "external allow create"));
      assert.deepEqual(Object.keys(allowed.reminder).sort(), ["id", "revision"]);
      const allowedCompleted = success(await bounded(lane.call("apple_reminders_update", { id: allowed.reminder.id, expectedRevision: allowed.reminder.revision,
        patch: { completed: true } }, "allow-write"), "external allow complete"));
      assert.equal(f.synthetic.reminders.get(allowedCompleted.reminder.id).completed, true);
      success(await bounded(lane.call("apple_reminders_delete", { id: allowedCompleted.reminder.id, expectedRevision: allowedCompleted.reminder.revision }, "allow-write"), "external allow delete"));
      assert.equal((await inbox()).items.length, 0, "Allow does not issue a device approval card");
      await policy("reminders", { writePolicy: "deny", readPolicy: "allow" });
      const beforeWriteOff = f.synthetic.count("reminders.create");
      assert.equal(codeOf(await lane.call("apple_reminders_create", { title: "Off must refuse" }, "off-write")), "APPLE_DEVICE_ACCESS_DENIED");
      assert.equal(f.synthetic.count("reminders.create"), beforeWriteOff);
      success(await lane.call("apple_reminders_lists", {}, "read-while-write-off"));
      assert.equal((await status()).resources.find(item => item.id === "calendar").writePolicy, "deny", "resource choices remain independent across adapters");
      await policy("reminders", { writePolicy: "ask" });
      await policy("reminders", { readPolicy: "ask" });
      const waiting = lane.call("apple_reminders_search", {}, "revoke-pending"); waiting.catch(() => {});
      await waitExternal(lane.backend, "apple_reminders_search"); const readsBeforeRevoke = f.synthetic.count("reminders.search");
      const subject = mcpConnectorSubjectId(lane.backend, lane.agent);
      await policy("reminders", { disabledProfileIds: [subject] });
      await inbox();
      assert.ok(["APPLE_DEVICE_ACCESS_DENIED", "APPLE_DEVICE_ACCESS_REVOKED", "APPLE_DEVICE_CANCELLED", "APPLE_DEVICE_CANCELED"].includes(codeOf(await bounded(waiting, "external revoked approval"))));
      assert.equal(f.synthetic.count("reminders.search"), readsBeforeRevoke);
      await policy("reminders", { readPolicy: "allow", disabledProfileIds: [] });
      success(await lane.call("apple_reminders_lists", {}, "after-revoke"));
      evidence.push(lane.backend + " real adapter and pairing: independent three-state read/write policies, separate Ask approvals with target snapshots, Allow create/complete/delete without cards, Off zero mutation, assistant revocation cancels pending read");
    }

    // Revocation must reach an already accepted App-host request, rather than
    // merely hiding a late result. The synthetic native provider honors exactly
    // the same forwarded signal as the real addon wrapper before its commit.
    const gate = { arrived: deferred(), release: deferred(), signal: null };
    await policy("reminders", { writePolicy: "allow" });
    f.synthetic.queueNextWrite = gate;
    const queuedArgs = { title: "Queued native write must not commit" }, queuedCallId = uuid();
    const queuedWrite = ocCall("apple_reminders_create", queuedArgs, "queued-native", queuedCallId); queuedWrite.catch(() => {});
    await bounded(gate.arrived.promise, "queued native request arrived");
    assert.equal((await inbox()).items.length, 0);
    await policy("reminders", { writePolicy: "deny" });
    await until(() => gate.signal?.aborted, value => value === true, "policy revocation crossed the actual App-host socket");
    gate.release.resolve();
    assert.ok(["APPLE_DEVICE_CANCELED", "APPLE_DEVICE_CANCELLED"].includes(codeOf(await bounded(queuedWrite, "queued native request canceled"))));
    assert.equal([...f.synthetic.reminders.values()].some(item => item.title === queuedArgs.title), false);
    await policy("reminders", { enabled: true, readPolicy: "allow", writePolicy: "ask" });
    assert.equal(codeOf(await ocCall("apple_reminders_create", queuedArgs, "queued-native", queuedCallId)), "APPLE_DEVICE_WRITE_UNCERTAIN");
    evidence.push("Allow-to-Off writing revocation crosses the real App-host socket into native AbortSignal before queued mutation; zero mutation, reading retained and conservative no-replay receipt");

    // Model-supplied confirmation fields are invalid. A trusted adapter cannot
    // request a policy mutation or claim another assistant in tool arguments.
    const mutationBeforeInvalid = f.synthetic.count("reminders.create");
    assert.equal(codeOf(await ocCall("apple_reminders_create", { title: "must not write", confirmed: true }, "bad-confirmation")), "MCP_EXTERNAL_REQUEST_INVALID");
    assert.equal(f.synthetic.count("reminders.create"), mutationBeforeInvalid);
    const unknownIdentity = "unknown-write-" + uuid(), unknownArgs = { title: "Committed but response lost fixture" };
    f.synthetic.unknownNextWrite = true;
    const failed = await approveExternal(ocCall("apple_reminders_create", unknownArgs, "unknown-write", unknownIdentity), "openclaw", "apple_reminders_create");
    assert.equal(codeOf(failed), "APPLE_DEVICE_FAILED");
    const writesAfterUnknown = f.synthetic.count("reminders.create");
    assert.equal([...f.synthetic.reminders.values()].filter(item => item.title === unknownArgs.title).length, 1);
    assert.equal(codeOf(await ocCall("apple_reminders_create", unknownArgs, "unknown-write", unknownIdentity)), "APPLE_DEVICE_WRITE_UNCERTAIN");
    assert.equal(f.synthetic.count("reminders.create"), writesAfterUnknown);
    assert.equal((await inbox()).items.length, 0);
    await policy("calendar", { enabled: false, readPolicy: "deny" });
    await policy("reminders", { enabled: true, readPolicy: "allow" });
    const beforeRestart = await status();
    await bounded(f.restart(), "Service/backend restart", 30000);
    const afterRestart = await status();
    assert.deepEqual(afterRestart, beforeRestart, "device policy and revision survive actual Service restart");
    assert.equal(codeOf(await ocCall("apple_reminders_create", unknownArgs, "unknown-write", unknownIdentity)), "APPLE_DEVICE_WRITE_UNCERTAIN");
    assert.equal(f.synthetic.count("reminders.create"), writesAfterUnknown);
    success(await hermes.call("apple_reminders_lists", {}, "after-service-restart"));
    assert.equal((await inbox()).items.length, 0);
    evidence.push("untrusted confirmation rejected; committed-but-lost write is never replayed, including after actual Service/backend restart; persisted policy/revision and Hermes pairing remain usable");
    for (const item of evidence) console.log("PASS Apple device L2: " + item);
  } finally {
    const errors = [];
    for (const close of [() => hermes?.close(), () => nativeHelper?.close(), () => nativeSession?.close?.(), () => f?.close()]) {
      try { await bounded(Promise.resolve().then(close), "fixture cleanup", 15000); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Apple device E2E cleanup failed");
  }
}
module.exports = { run: main };
if (require.main === module) {
  const watchdog = setTimeout(() => { console.error("Apple device E2E exceeded hard 120-second limit"); process.exit(1); }, 120000);
  main().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error.stack); process.exitCode = 1; });
}
