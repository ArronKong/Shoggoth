"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { recordChatSendFailure, setChatSendDiagnosticPhase, withChatSendDiagnostics } = require("../app/agent-service/chat-send-diagnostics");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-send-diag-")));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, cleanups, target: path.join(paths.runtimeDir, "chat-send-diagnostics.json") };
}
const input = () => ({ operationId: `send-${randomUUID()}`, sessionKey: randomUUID(), prompt: "PRIVATE_PROMPT" });
const digest = text => createHash("sha256").update(text).digest("hex");

test("diagnostics keep source locations and causes without error text, paths or input", async t => {
  const f = fixture(t), params = input();
  const cause = new TypeError("PRIVATE_SECRET in PRIVATE_PROMPT");
  cause.stack = `TypeError: PRIVATE_SECRET\n    at PRIVATE_FUNCTION (${path.resolve("app/agent-service/server.js")}:2453:31)\n    at f (/Users/PRIVATE_PATH/secret.js:1:2)`;
  const error = Object.assign(new Error("PRIVATE_WRAPPER", { cause }), { code: "WORK_RUN_SEND_FAILED", admissionAccepted: false });
  await assert.rejects(withChatSendDiagnostics({ paths: f.paths, method: "chat.send", input: params }, async () => {
    setChatSendDiagnosticPhase("memory_preflight"); throw error;
  }), value => value === error);
  const body = fs.readFileSync(f.target, "utf8"), [record] = JSON.parse(body).records;
  assert.equal(record.phase, "memory_preflight");
  assert.equal(record.admissionAccepted, false);
  assert.equal(record.operationHash, digest(params.operationId));
  assert.equal(record.sessionHash, digest(params.sessionKey));
  assert.deepEqual(record.errors[1], { name: "TypeError", code: "UNKNOWN_LOCAL_ERROR",
    frames: [{ file: "agent-service/server.js", line: 2453, column: 31 }] });
  assert.doesNotMatch(body, /PRIVATE_|\/Users\/|\/private\//u);
  assert.ok(!body.includes(params.operationId) && !body.includes(params.sessionKey));
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
});

test("concurrent requests retain their own failing phase and successes write nothing", async t => {
  const f = fixture(t), first = input(), second = input();
  await withChatSendDiagnostics({ paths: f.paths, method: "chat.send", input: first }, async () => 1);
  assert.equal(fs.existsSync(f.target), false);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const one = withChatSendDiagnostics({ paths: f.paths, method: "chat.send", input: first }, async () => {
    setChatSendDiagnosticPhase("memory_preflight"); await gate; throw new Error("PRIVATE_FIRST");
  });
  const two = withChatSendDiagnostics({ paths: f.paths, method: "chat.send", input: second }, async () => {
    setChatSendDiagnosticPhase("command_enqueue"); release(); throw Object.assign(new Error("PRIVATE_SECOND"), { code: "ENOSPC" });
  });
  const results = await Promise.allSettled([one, two]);
  assert.ok(results.every(result => result.status === "rejected"));
  const records = JSON.parse(fs.readFileSync(f.target)).records;
  assert.equal(records.find(row => row.operationHash === digest(first.operationId)).phase, "memory_preflight");
  assert.equal(records.find(row => row.operationHash === digest(second.operationId)).phase, "command_enqueue");
  assert.equal(records.find(row => row.operationHash === digest(second.operationId)).errors[0].code, "ENOSPC");
});

test("bounded diagnostics reject arbitrary codes, getters, corrupt files and symlink targets", async t => {
  const f = fixture(t), params = input();
  let getters = 0;
  const error = Object.assign(new Error("PRIVATE_ERROR"), { code: "PRIVATE_CODE" });
  Object.defineProperty(error, "stack", { get() { getters++; return "PRIVATE_STACK"; } });
  Object.defineProperty(error, "cause", { get() { getters++; throw new Error("PRIVATE_GETTER"); } });
  for (let i = 0; i < 40; i++) assert.equal(recordChatSendFailure({ paths: f.paths, method: "chat.send",
    input: params, phase: "command_enqueue", error }), true);
  assert.equal(getters, 0);
  const body = fs.readFileSync(f.target, "utf8");
  assert.equal(JSON.parse(body).records.length, 32);
  assert.ok(Buffer.byteLength(body) <= 64 * 1024);
  assert.doesNotMatch(body, /PRIVATE_/u);
  const sentinel = path.join(f.root, "sentinel");
  fs.writeFileSync(sentinel, "retain", { mode: 0o600 });
  fs.unlinkSync(f.target); fs.symlinkSync(sentinel, f.target);
  await assert.rejects(withChatSendDiagnostics({ paths: f.paths, method: "chat.send", input: params }, async () => { throw error; }), value => value === error);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "retain");
  fs.unlinkSync(f.target); fs.writeFileSync(f.target, "corrupt", { mode: 0o600 });
  assert.equal(recordChatSendFailure({ paths: f.paths, method: "chat.send", phase: "controller", input: params, error }), false);
  assert.equal(fs.readFileSync(f.target, "utf8"), "corrupt");
});

test("App preflight preserves definite rejection and records the local failure without sending", async t => {
  const f = fixture(t), backend = new ShoggothBackend({ paths: f.paths });
  let calls = 0;
  backend._ensureCodexDesktopSession = async () => { throw new TypeError("PRIVATE_PREFLIGHT"); };
  backend._call = async () => { calls++; assert.fail("must not reach Service send"); };
  await assert.rejects(backend.sendMessage("PRIVATE_SESSION", "PRIVATE_PROMPT", "PRIVATE_OPERATION"),
    error => error.admissionAccepted === false);
  assert.equal(calls, 0);
  const body = fs.readFileSync(path.join(f.paths.runtimeDir, "chat-send-client-diagnostics.json"), "utf8");
  const record = JSON.parse(body).records[0];
  assert.equal(record.phase, "app_preflight");
  assert.equal(record.errors[0].name, "TypeError");
  assert.doesNotMatch(body, /PRIVATE_/u);
});

test("real Service captures the original preparation cause and does not admit or replay it", async t => {
  const f = fixture(t);
  const service = createAgentService({ paths: f.paths, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  }, runtimePool: { async get() { assert.fail("rejected send must not acquire Runtime"); }, async stopAll() {} },
  setCronTimer: () => 1, clearCronTimer() {} });
  f.cleanups.push(() => service.stop({ notify: false }));
  await service.start();
  const ipc = (method, params) => requestService(f.paths, { id: randomUUID(), method, params,
    version: PROTOCOL_VERSION, token: readClientToken(f.paths) }, { timeoutMs: 5000 });
  const { session } = await ipc("chat.session.create", { operationId: randomUUID(), profileId: DEFAULT_AGENT_PROFILE_ID,
    workspace: f.root, createdAt: Date.now() });
  const params = { ...input(), sessionKey: session.sessionKey, createdAt: Date.now() };
  let attempts = 0;
  service.workRunCoordinator.beforeSessionSend = async () => {
    attempts++; setChatSendDiagnosticPhase("memory_preflight");
    // Throw in a real source module so the original frame must survive the
    // coordinator's public rejection wrapper, without exposing its message.
    require("../app/agent-service/session-runtime-controller").createSessionRuntimeController(null);
  };
  await assert.rejects(ipc("chat.send", params), error => error.code === "INTERNAL_ERROR" && error.admissionAccepted === false);
  assert.equal(attempts, 1);
  assert.deepEqual(await ipc("chat.operation.get", { operationId: params.operationId, sessionKey: params.sessionKey }), { status: "unresolved", run: null });
  const body = fs.readFileSync(f.target, "utf8"), record = JSON.parse(body).records[0];
  assert.equal(record.phase, "memory_preflight");
  assert.equal(record.errors[0].code, "WORK_RUN_SEND_FAILED");
  assert.equal(record.errors[1].name, "TypeError");
  assert.ok(record.errors[1].frames.some(frame => frame.file === "agent-service/session-runtime-controller.js"));
  assert.doesNotMatch(body, /PRIVATE_|\/Users\/|\/private\//u);
  service.workRunCoordinator.beforeSessionSend = async () => {};
  service.pendingCommandInbox.enqueue = async () => { throw Object.assign(new Error("PRIVATE_STORAGE_PATH"), { code: "ENOSPC" }); };
  const next = { ...params, operationId: randomUUID() };
  await assert.rejects(ipc("chat.send", next), error => error.code === "INTERNAL_ERROR" && error.admissionAccepted === undefined);
  const storage = JSON.parse(fs.readFileSync(f.target)).records.at(-1);
  assert.equal(storage.phase, "command_enqueue");
  assert.equal(storage.errors[0].code, "ENOSPC");
  assert.equal(storage.admissionAccepted, undefined, "an enqueue failure must not invent proof of non-admission");
});

test("recovering a queued send over IPC lets two Codex Agents on the same account run concurrently", async t => {
  const f = fixture(t);
  const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
  const handoff = await openHandoffFixture({ root: f.root });
  f.cleanups.push(() => handoff.close());
  const { service, paths } = handoff;
  const coordinator = service.workRunCoordinator;
  const rpc = (method, params) => requestService(paths, { id: randomUUID(), token: readClientToken(paths),
    version: PROTOCOL_VERSION, method, params }, { timeoutMs: 5000 });
  const config = service.nativeRuntimeConfig.read();
  service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeAdmissionV1: true } });
  const { profile } = await rpc("agent.create", { operationId: randomUUID(), backendId: "shoggoth",
    name: "Concurrent Codex", defaultCwd: null, createdAt: Date.now() });
  service.productStore.putAgentProfile({ ...profile, defaultModel: "fixture-model",
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" } });
  const workspace = path.join(f.root, "second-workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const { session } = await rpc("chat.session.create", { operationId: randomUUID(), profileId: profile.id,
    workspace, createdAt: Date.now() });
  service.chatSessionStore.setPermissionMode(session.sessionKey, "request-approval");
  const first = await handoff.send(handoff.createSession().sessionKey, "other-codex-chat");
  assert.equal(first.status, "running", first.errorCode);
  const params = { ...input(), sessionKey: session.sessionKey, createdAt: Date.now() };
  const original = coordinator.hookService.prepareRun;
  coordinator.hookService.prepareRun = async () => {
    throw Object.assign(new Error("PRIVATE_PREPARATION_FAILURE"), { code: "RUNTIME_ISOLATION_UNVERIFIED" });
  };
  try {
    await assert.rejects(rpc("chat.send", params), error => error.code === "INTERNAL_ERROR"
      && error.receiptUncertain === true && error.admissionAccepted === undefined);
  } finally {
    coordinator.hookService.prepareRun = original;
  }
  const query = { operationId: params.operationId, sessionKey: params.sessionKey };
  const queued = await rpc("chat.operation.get", query);
  assert.equal(queued.status, "found");
  assert.equal(queued.run.status, "queued");
  assert.equal(service.pendingCommandInbox.get(params.operationId).state, "pending");
  const target = path.join(paths.runtimeDir, "chat-send-diagnostics.json");
  const record = JSON.parse(fs.readFileSync(target, "utf8")).records.at(-1);
  assert.equal(record.phase, "runtime_admission");
  assert.equal(record.errors.at(-1).code, "RUNTIME_ISOLATION_UNVERIFIED");

  await coordinator.capacityChanged();
  await coordinator.waitForIdle(queued.run.id);
  const running = (await rpc("chat.operation.get", query)).run;
  assert.equal(running.id, queued.run.id);
  assert.equal(running.status, "running", running.errorCode);
  assert.equal(coordinator.getRun(first.id).status, "running", "the first Agent has not finished");
  assert.equal(running.runtimeSessionRef.runtime, "codex");
  assert.equal(running.runtimeSessionRef.runtimeAccountId, first.runtimeSessionRef.runtimeAccountId);
  assert.notEqual(running.runtimeSessionRef.sessionId, first.runtimeSessionRef.sessionId);
  assert.deepEqual([...handoff.transport.handles.values()].map(handle => handle.host.turnStartCalls), [1, 1]);
  await handoff.complete(running, "Recovered once");
  assert.equal((await rpc("chat.operation.get", query)).run.status, "completed");
  assert.equal(service.transcriptStore.listEvents(session.profileId, session.id)
    .filter(event => event.kind === "user" && event.runId === running.id).length, 1);
  await handoff.complete(first);
});

test("a full disk during input protection reports the cause and leaves the message unqueued", async t => {
  const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
  const f = await startInspirationFixture({ isolatedHome: true, serviceOptions: { prewarmMcpAuth: false } });
  t.after(() => f.close());
  const { session } = await f.ipc("chat.session.create", { operationId: randomUUID(),
    profileId: DEFAULT_AGENT_PROFILE_ID, workspace: f.paths.defaultWorkspaceDir, createdAt: Date.now() });
  await f.backend._refreshManagedProfiles();
  const agent = f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const sessionKey = `agent:${agent.agentId}:${session.sessionKey}`;
  const post = input => fetch(`${f.url}/__api/chat/secrets/prepare`, {
    method: "POST", headers: { Origin: f.url, "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const params = { sessionKey, operationId: randomUUID(), text: "PRIVATE_FIXTURE_TEXT" };
  const seed = await post({ ...params, operationId: randomUUID() });
  assert.equal(seed.status, 200);
  await seed.json();
  const directory = path.join(f.paths.stateDir, "temporary-secrets");
  const diskFull = () => Object.assign(new Error("PRIVATE_DISK_PATH"), { code: "ENOSPC" });
  const assertFailure = async expectedCodes => {
    const response = await post(params);
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.equal(result.code, "SECRET_PROCESSING_UNAVAILABLE");
    assert.equal(result.systemIssue, "STORAGE_FULL");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
    assert.equal(f.service.productStore.listWorkRuns().length, 0);
    const diagnostics = fs.readFileSync(path.join(f.paths.runtimeDir, "chat-send-diagnostics.json"), "utf8");
    const record = JSON.parse(diagnostics).records.at(-1);
    assert.equal(record.method, "chat.secret.prepare");
    assert.equal(record.phase, "secret_preparation");
    assert.deepEqual(record.errors.map(error => error.code), ["SECRET_PROCESSING_UNAVAILABLE", ...expectedCodes]);
    assert.doesNotMatch(diagnostics, /PRIVATE_DISK_PATH|PRIVATE_FIXTURE_TEXT/u);
  };

  const open = fs.openSync;
  const fault = t.mock.method(fs, "openSync", (file, ...args) => {
    if (file === path.join(directory, "state-v1.json.tmp")) throw diskFull();
    return open(file, ...args);
  });
  try { await assertFailure(["ENOSPC"]); } finally { fault.mock.restore(); }

  const state = path.join(directory, "state-v1.json");
  const before = fs.readFileSync(state, "utf8");
  const directoryStat = fs.statSync(directory), fsync = fs.fsyncSync;
  let injected = false;
  const syncFault = t.mock.method(fs, "fsyncSync", fd => {
    const stat = fs.fstatSync(fd);
    if (!injected && stat.dev === directoryStat.dev && stat.ino === directoryStat.ino) {
      injected = true;
      throw diskFull();
    }
    return fsync(fd);
  });
  try { await assertFailure(["PRIVATE_FILE_COMMIT_FAILED", "ENOSPC"]); } finally { syncFault.mock.restore(); }
  assert.equal(fs.readFileSync(state, "utf8"), before, "failed directory commit rolls back to the previous state");
  const retry = await post(params);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).text, params.text);
  assert.equal(f.service.productStore.listWorkRuns().length, 0, "preparing input cannot start a turn");
});
