"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Module = require("node:module");
const repo = path.resolve(__dirname, ".."), core = path.join(repo, "app/agent-service");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID, STORE_SCHEMA_VERSION } = require("../app/agent-service/product-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createWorkDispatcher } = require("../app/agent-service/work-run");
const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const { runtimeAttemptRef } = require("../app/agent-service/runtime-adapter");
const { RunExecutionStore } = require("../app/agent-service/run-execution-store");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const cleanups = new WeakMap();
function privateRoot(t, suffix = "") {
  const root = fs.realpathSync(fs.mkdtempSync(`/private/tmp/sg-prepared-${suffix}`)); fs.chmodSync(root, 0o700);
  const close = []; cleanups.set(t, close);
  t.after(() => { for (const cleanup of close.reverse()) cleanup(); fs.rmSync(root, { recursive: true, force: true }); }); return root;
}
function pathsAt(root) { return resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") }); }
function productFixture(t) {
  const root = privateRoot(t), paths = pathsAt(root), store = new JsonlProductStore({ paths }); store.open();
  cleanups.get(t).push(() => store.close());
  const base = store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const profile = store.putAgentProfile({ ...base, concurrency: { maxActive: 4, maxWorkspaceWrites: 4 } });
  const dispatcher = createWorkDispatcher({ store });
  const binding = { runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId };
  const enqueue = id => dispatcher.enqueue({ id, source: "chat", sourceId: `session-${id}`, idempotencyKey: `send-${id}`, profileId: profile.id, workspace: null });
  const start = id => { enqueue(id); return dispatcher.admit(id, { writable: false }).run; };
  return { root, paths, store, profile, binding, dispatcher, enqueue, start };
}
const details = suffix => ({ sessionId: "native-session", turnId: `local-turn-${suffix}`, attemptId: `attempt-${suffix}`,
  operationId: `operation-${suffix}`, fingerprint: sha(`encoded command ${suffix}`) });
const attempted = (binding, suffix, dispatchState = "prepared") => runtimeAttemptRef(binding, { ...details(suffix), dispatchState });
function oldModule(relative) {
  const filename = path.join(core, `prepared-test-old-${path.basename(relative)}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/runtime-prepared-legacy-readers.json")));
  assert.equal(manifest.version, 1); const entry = manifest.sources[relative];
  const source = fs.readFileSync(path.join(__dirname, "fixtures", entry.file), "utf8");
  assert.equal(sha(source), entry.sha256, "old reader fixture must retain its frozen source bytes");
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(core); loaded._compile(source, filename); return loaded.exports;
}
function rawHandle(body, prepare = true) {
  const binding = { runtime: "ext-prepared-unit", runtimeProfileId: "prepared-profile", runtimeAccountId: "prepared-account" };
  const raw = { ...binding, capabilities: { "turn.start": true, "turn.start.prepare": prepare }, host: { transport: "acp" },
    subscribe: () => () => {}, terminated: new Promise(() => {}), stop: async () => {}, turnStart: body };
  return { binding, handle: runtimeHandleV1(raw, binding) };
}
const turnInput = { sessionId: "native-session", operationId: "operation-one", input: [{ type: "text", text: "bounded prompt" }] };
const observer = patches => ({ version: 1, attemptId: "attempt-one", assertCurrent() {}, onPrepared() {}, onDispatchAttempt() {}, ...patches });
const receipt = () => details("one");

test("preparation and a write marker persist independently of accepted Runtime references", t => {
  const f = productFixture(t); f.start("run-one");
  let run = f.dispatcher.prepareAttempt("run-one", attempted(f.binding, "one"));
  assert.equal(run.status, "starting"); assert.equal(run.runtimeSessionRef, null); assert.equal(run.runtimeTurnRef, null);
  assert.equal(run.runtimeAttemptRef.dispatchState, "prepared");
  assert.throws(() => f.dispatcher.bindAcceptedAttempt(run.id, { sessionId: "native-session", turnId: "local-turn-one", attemptId: "attempt-one" }), { code: "WORK_RUN_BINDING_CONFLICT" });
  assert.throws(() => f.dispatcher.transition(run.id, "waiting_approval", { waitingRequestId: "early-request" }), { code: "WORK_RUN_REQUEST_UNROUTABLE" });
  run = f.dispatcher.markAttemptDispatch(run.id, details("one"));
  assert.equal(run.runtimeAttemptRef.dispatchState, "write_attempted"); assert.equal(run.runtimeTurnRef, null);
  const same = f.dispatcher.markAttemptDispatch(run.id, details("one")); assert.equal(same.eventSeq, run.eventSeq, "idempotent write receipt does not manufacture another transition");
  run = f.dispatcher.transition(run.id, "waiting_approval", { waitingRequestId: "first-request" });
  assert.equal(run.runtimeSessionRef, null); assert.equal(run.runtimeTurnRef, null);
  run = f.dispatcher.bindAcceptedAttempt(run.id, { sessionId: "native-session", turnId: "local-turn-one", attemptId: "attempt-one" });
  assert.equal(run.status, "waiting_approval", "acceptance cannot answer a pending approval");
  assert.equal(run.runtimeTurnRef.turnId, "local-turn-one");
});

test("attempt identity and write evidence move only forward, including direct Product writes", t => {
  const f = productFixture(t); f.start("run-monotonic");
  f.dispatcher.prepareAttempt("run-monotonic", attempted(f.binding, "one"));
  assert.throws(() => f.dispatcher.prepareAttempt("run-monotonic", attempted(f.binding, "two")), { code: "WORK_RUN_BINDING_CONFLICT" });
  assert.throws(() => f.dispatcher.markAttemptDispatch("run-monotonic", { ...details("one"), fingerprint: "f".repeat(64) }), { code: "WORK_RUN_BINDING_CONFLICT" });
  const run = f.dispatcher.markAttemptDispatch("run-monotonic", details("one"));
  for (const runtimeAttemptRef of [null, attempted(f.binding, "one"), attempted(f.binding, "two", "write_attempted")]) {
    assert.throws(() => f.store.putWorkRun({ ...run, runtimeAttemptRef, eventSeq: run.eventSeq + 1 }), { code: "WORK_RUN_BINDING_IMMUTABLE" });
  }
  assert.throws(() => f.dispatcher.requeueBeforeDispatch(run.id), { code: "WORK_RUN_REQUEUE_UNSAFE" });
  f.dispatcher.transition(run.id, "failed", { errorCode: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
  assert.throws(() => f.dispatcher.markAttemptDispatch(run.id, details("one")), { code: "WORK_RUN_BINDING_CONFLICT" });
  const final = f.store.getWorkRun(run.id); assert.equal(final.runtimeTurnRef, null); assert.equal(final.runtimeAttemptRef.dispatchState, "write_attempted");
});

test("only a proven-unsent preparation can release ownership and requeue", t => {
  const f = productFixture(t); f.start("run-unsent"); f.dispatcher.prepareAttempt("run-unsent", attempted(f.binding, "one"));
  const run = f.dispatcher.requeueBeforeDispatch("run-unsent");
  assert.equal(run.status, "queued"); assert.equal(run.runtimeAttemptRef, null); assert.equal(run.runtimeSessionRef, null);
  assert(fs.readFileSync(f.paths.eventLogPath, "utf8").includes('"dispatchState":"prepared"'), "append-only history retains the abandoned unsent attempt");
});

test("two active WorkRuns cannot claim one prepared native session", t => {
  const f = productFixture(t); f.start("run-owner"); f.start("run-other");
  f.dispatcher.prepareAttempt("run-owner", attempted(f.binding, "one"));
  assert.throws(() => f.dispatcher.prepareAttempt("run-other", attempted(f.binding, "two")), { code: "THREAD_ACTIVE_TURN_CONFLICT" });
  const other = f.store.getWorkRun("run-other");
  assert.throws(() => f.store.putWorkRun({ ...other, runtimeAttemptRef: attempted(f.binding, "two"), eventSeq: other.eventSeq + 1 }), { code: "THREAD_ACTIVE_TURN_CONFLICT" });
  assert.equal(f.store.getWorkRun("run-other").runtimeAttemptRef, null);
});

test("restart preserves a dispatched unknown attempt without inventing acceptance", t => {
  const f = productFixture(t); f.start("run-restart"); f.dispatcher.prepareAttempt("run-restart", attempted(f.binding, "one"));
  f.dispatcher.markAttemptDispatch("run-restart", details("one")); f.store.close();
  const reopened = new JsonlProductStore({ paths: f.paths }); reopened.open(); cleanups.get(t).push(() => reopened.close());
  const run = reopened.recoverActiveRunAfterServiceRestart("run-restart");
  assert.equal(run.status, "interrupted"); assert.equal(run.errorCode, "SERVICE_RESTARTED");
  assert.equal(run.runtimeAttemptRef.dispatchState, "write_attempted"); assert.equal(run.runtimeSessionRef, null); assert.equal(run.runtimeTurnRef, null);
});

test("the V1 observer is separate from JSON payload and awaits durable preparation before a write", async () => {
  let writes = 0, release, began, callbacks = 0; const held = new Promise(resolve => { release = resolve; });
  const beganPreparing = new Promise(resolve => { began = resolve; });
  const { handle } = rawHandle(async (payload, local) => {
    assert.deepEqual(payload, turnInput); assert.equal(Object.values(payload).some(value => typeof value === "function"), false);
    await local.onPrepared(receipt()); local.onDispatchAttempt(receipt()); writes++; return { turn: { id: "local-turn-one" } };
  });
  const run = handle.turnStart(turnInput, observer({ async onPrepared() { callbacks++; began(); await held; } }));
  await beganPreparing; assert.equal(writes, 0); release(); await run;
  assert.equal(callbacks, 1); assert.equal(writes, 1);
  await assert.rejects(handle.turnStart({ ...turnInput, onPrepared() {} }), { code: "RUNTIME_PROTOCOL_INVALID" });
});

test("a failed preparation, invalid receipt or async write receipt produces zero runtime writes", async () => {
  for (const mode of ["preparation-fails", "wrong-session", "async-dispatch"]) {
    let writes = 0;
    const { handle } = rawHandle(async (_payload, local) => {
      await local.onPrepared(mode === "wrong-session" ? { ...receipt(), sessionId: "foreign" } : receipt());
      local.onDispatchAttempt(receipt()); writes++; return { turn: { id: "local-turn-one" } };
    });
    const local = observer(mode === "preparation-fails" ? { onPrepared() { throw Error("durable preparation failed"); } }
      : mode === "async-dispatch" ? { onDispatchAttempt: async () => {} } : {});
    await assert.rejects(handle.turnStart(turnInput, local)); assert.equal(writes, 0, mode);
  }
});

test("observer accessors and unsupported prepare guarantees are rejected without invoking the Runtime", async () => {
  let calls = 0, getters = 0;
  const { handle } = rawHandle(async () => { calls++; return { turn: { id: "turn" } }; });
  const local = observer(); Object.defineProperty(local, "onPrepared", { enumerable: true, get() { getters++; throw Error("do not execute"); } });
  await assert.rejects(handle.turnStart(turnInput, local), { code: "RUNTIME_PROTOCOL_INVALID" });
  assert.equal(getters, 0); assert.equal(calls, 0);
  const unsupported = rawHandle(async () => { calls++; return { turn: { id: "turn" } }; }, false);
  await assert.rejects(unsupported.handle.turnStart(turnInput, observer()), { code: "RUNTIME_CAPABILITY_UNSUPPORTED" }); assert.equal(calls, 0);
});

test("late preparation and write callbacks lose authority after a turn invocation settles", async () => {
  for (const phase of ["success", "failure"]) {
    let captured, callbacks = 0, writes = 0;
    const { handle } = rawHandle(async (_payload, local) => { captured = local; if (phase === "failure") throw Error("transport failed"); return { turn: { id: "local-turn-one" } }; });
    const run = handle.turnStart(turnInput, observer({ onPrepared() { callbacks++; }, onDispatchAttempt() { writes++; } }));
    if (phase === "failure") await assert.rejects(run); else await run;
    await assert.rejects(captured.onPrepared(receipt()), "settled invocation must not prepare a later send");
    assert.throws(() => captured.onDispatchAttempt(receipt()), "settled invocation must not write later");
    assert.equal(callbacks, 0); assert.equal(writes, 0);
  }
});

function legacyRun(id, profileId, status = "queued") {
  const active = status !== "queued";
  return { id, source: "chat", sourceId: `legacy-session-${id}`, idempotencyKey: `legacy-send-${id}`, profileId,
    workspace: null, status, contextSnapshotId: null, runtimeSessionRef: null, runtimeTurnRef: null, eventSeq: 1,
    waitingRequestId: null, startedAt: active ? 100 : null, finishedAt: status === "completed" ? 101 : null,
    resultSummary: status === "completed" ? "retained legacy answer" : null, errorCode: null, retryOf: null };
}
test("v15 source bytes and receipts survive a mixed journal without synthesized attempts or acceptance", t => {
  const root = privateRoot(t, "migration-"), paths = pathsAt(root);
  const legacy = oldModule("product-store.js"); assert.equal(legacy.STORE_SCHEMA_VERSION, 15);
  const legacyPaths = { ...paths, productSchemaVersion: 15 };
  const old = new legacy.JsonlProductStore({ paths: legacyPaths }); old.open();
  for (const status of ["queued", "running", "completed"]) old.putWorkRun(legacyRun(`legacy-${status}`, DEFAULT_AGENT_PROFILE_ID, status));
  old.close(); old.open(); old.putWorkRun(legacyRun("legacy-journal", DEFAULT_AGENT_PROFILE_ID));
  const sourceSnapshot = fs.readFileSync(paths.stateSnapshotPath), sourceJournal = fs.readFileSync(paths.eventLogPath);
  const current = new JsonlProductStore({ paths }); current.open(); cleanups.get(t).push(() => current.close());
  for (const status of ["queued", "running", "completed"]) {
    const run = current.getWorkRun(`legacy-${status}`);
    assert.equal(run.runtimeAttemptRef, null); assert.equal(run.runtimeSessionRef, null); assert.equal(run.runtimeTurnRef, null); assert.equal(run.status, status);
  }
  assert.deepEqual(fs.readFileSync(paths.stateSnapshotPath), sourceSnapshot); assert.deepEqual(fs.readFileSync(paths.eventLogPath), sourceJournal);
  const migrationRoot = path.join(paths.stateDir, `product-schema-migrations/15-to-${STORE_SCHEMA_VERSION}`);
  const directories = fs.readdirSync(migrationRoot); assert.equal(directories.length, 1);
  const retained = path.join(migrationRoot, directories[0]), receipt = JSON.parse(fs.readFileSync(path.join(retained, "receipt.json")));
  assert.deepEqual(fs.readFileSync(path.join(retained, "snapshot.v15-source")), sourceSnapshot);
  assert.deepEqual(fs.readFileSync(path.join(retained, "journal.v15-source")), sourceJournal);
  assert.equal(receipt.synthesizedAcceptance, false); assert.equal(receipt.synthesizedAttempts, false);
  current.open(); assert.deepEqual(fs.readdirSync(migrationRoot), directories, "repeated open is idempotent");
  const dispatcher = createWorkDispatcher({ store: current });
  dispatcher.enqueue({ id: "current-queued", source: "chat", sourceId: "current-session", idempotencyKey: "current-send", profileId: DEFAULT_AGENT_PROFILE_ID, workspace: null });
  const mixedBytes = fs.readFileSync(paths.eventLogPath), mixed = mixedBytes.toString().trim().split("\n").map(line => JSON.parse(line));
  assert.equal(mixed[0].schemaVersion, 15); assert.equal(mixed.at(-1).schemaVersion, STORE_SCHEMA_VERSION); assert(mixedBytes.subarray(0, sourceJournal.length).equals(sourceJournal));
  const readonly = new JsonlProductStore({ paths, readOnly: true }); readonly.openReadOnly();
  assert.equal(readonly.getWorkRun("legacy-journal").runtimeAttemptRef, null); assert.equal(readonly.getWorkRun("current-queued").runtimeAttemptRef, null); readonly.close();
  current.close(); const finalSnapshot = fs.readFileSync(paths.stateSnapshotPath), finalJournal = fs.readFileSync(paths.eventLogPath);
  const oldBinary = new legacy.JsonlProductStore({ paths: legacyPaths }); assert.throws(() => oldBinary.open(), { code: "STORE_SCHEMA_UNSUPPORTED" });
  assert.deepEqual(fs.readFileSync(paths.stateSnapshotPath), finalSnapshot); assert.deepEqual(fs.readFileSync(paths.eventLogPath), finalJournal);
});

function encryptedFixture(t) {
  const root = privateRoot(t, "encrypted-"), paths = { stateDir: root, trustedRoot: root }, key = crypto.randomBytes(32);
  const cryptoBroker = { async encrypt(input) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(input), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
  async decrypt(input) { const cipher = crypto.createDecipheriv("aes-256-gcm", key, input.subarray(0, 12)); cipher.setAuthTag(input.subarray(12, 28)); return Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]); } };
  const run = { id: "encrypted-run", profileId: "encrypted-profile", source: "chat", sourceId: "encrypted-session", workspace: root, idempotencyKey: "encrypted-send" };
  const binding = { runtime: "ext-encrypted", runtimeProfileId: "encrypted-native-profile", runtimeAccountId: "encrypted-account" };
  const policy = { sandbox: "danger-full-access", approvalPolicy: "on-request" };
  const contract = { runId: run.id, profileId: run.profileId, source: run.source, sourceId: run.sourceId, workspace: run.workspace,
    ...binding, runtimeAccountGeneration: 31, permissionPolicy: policy, runtimeHostPermissionPolicy: policy, developerInstructions: "private frozen instructions", bindingId: null,
    provider: { providerRef: null, providerRevision: null, credentialRef: null, credentialRevision: null, modelRef: null },
    providerFence: { profileId: run.profileId, accountId: binding.runtimeAccountId, accountRevision: 0, accountFingerprint: "a".repeat(64), providerFingerprint: null, profileRouteFingerprint: "b".repeat(64) } };
  const command = { kind: "chat", runId: run.id, operationId: "operation-one", prompt: "private original command" };
  return { root, paths, cryptoBroker, run, binding, contract, command, store: new RunExecutionStore({ paths, cryptoBroker }) };
}
test("encrypted v3 preparation reopens with the exact original frozen command and no generation reuse", async t => {
  const f = encryptedFixture(t), attempt = attempted(f.binding, "one");
  await f.store.put(f.run, f.contract, f.command); await f.store.putAttempt(f.run, attempt);
  const file = path.join(f.root, "run-executions", fs.readdirSync(path.join(f.root, "run-executions"))[0]);
  const envelope = fs.readFileSync(file, "utf8"); assert(!envelope.includes(f.command.prompt)); assert(!envelope.includes(attempt.attemptId));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reopened = new RunExecutionStore({ paths: f.paths, cryptoBroker: f.cryptoBroker }), record = await reopened.get(f.run);
  assert.equal(record.version, 3); assert.deepEqual(record.attempt, attempt); assert.deepEqual(record.command, f.command);
  assert.equal(record.contract.runtimeAccountGeneration, undefined); assert.equal(record.contract.developerInstructions, f.contract.developerInstructions);
  const bytes = fs.readFileSync(file);
  await assert.rejects(reopened.putAttempt(f.run, attempted(f.binding, "two")), { code: "EXECUTION_BINDING_INVALID" });
  await assert.rejects(reopened.putAttempt(f.run, attempted(f.binding, "one", "write_attempted")), { code: "EXECUTION_BINDING_INVALID" });
  assert.deepEqual(fs.readFileSync(file), bytes);
  const legacy = oldModule("run-execution-store.js"), old = new legacy.RunExecutionStore({ paths: f.paths, cryptoBroker: f.cryptoBroker });
  await assert.rejects(old.get(f.run), { code: "EXECUTION_BINDING_INVALID" }); assert.deepEqual(fs.readFileSync(file), bytes);
});

test("failed encryption/fence cannot replace the recoverable original descriptor with an attempt", async t => {
  const f = encryptedFixture(t); await f.store.put(f.run, f.contract, f.command);
  const directory = path.join(f.root, "run-executions"), file = path.join(directory, fs.readdirSync(directory)[0]), bytes = fs.readFileSync(file);
  let fences = 0;
  await assert.rejects(f.store.putAttempt(f.run, attempted(f.binding, "one"), () => { if (++fences === 2) throw Error("attempt lease expired"); }), /lease expired/u);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal((await f.store.get(f.run)).version, 2);
  f.cryptoBroker.encrypt = async () => { throw Error("crypto unavailable"); };
  await assert.rejects(f.store.putAttempt(f.run, attempted(f.binding, "one")), /crypto unavailable/u);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.deepEqual((await f.store.get(f.run)).command, f.command);
});

function legacyPartialJournal(t, suffix) {
  const root = privateRoot(t, `legacy-tail-${suffix}-`), paths = pathsAt(root), legacy = oldModule("product-store.js");
  const old = new legacy.JsonlProductStore({ paths: { ...paths, productSchemaVersion: 15 } });
  old.open(); old.putWorkRun(legacyRun("tail-snapshot-run", DEFAULT_AGENT_PROFILE_ID)); old.close();
  // Keep a committed legacy journal newer than the saved snapshot. This bare
  // Store has no persistent file handle; taking another close snapshot would
  // compact away the journal prefix that the migration must actually replay.
  old.open(); old.putWorkRun(legacyRun("tail-journal-run", DEFAULT_AGENT_PROFILE_ID));
  const sourceSnapshot = fs.readFileSync(paths.stateSnapshotPath), prefix = fs.readFileSync(paths.eventLogPath);
  // Include non-UTF-8 bytes so only preserving the raw Buffer can retain the
  // original uncommitted tail. The validated complete prefix remains ordinary v15.
  const tail = Buffer.concat([Buffer.from('{"schemaVersion":15,"uncommitted":"'), Buffer.from([0xff, 0xfe, 0x00])]);
  fs.appendFileSync(paths.eventLogPath, tail);
  return { root, paths, sourceSnapshot, sourceJournal: Buffer.concat([prefix, tail]), prefix };
}
function migrationReceipt(f) {
  const root = path.join(f.paths.stateDir, `product-schema-migrations/15-to-${STORE_SCHEMA_VERSION}`), directories = fs.readdirSync(root);
  assert.equal(directories.length, 1);
  const directory = path.join(root, directories[0]), file = path.join(directory, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(fs.readFileSync(path.join(directory, "snapshot.v15-source")), f.sourceSnapshot);
  assert.deepEqual(fs.readFileSync(path.join(directory, "journal.v15-source")), f.sourceJournal);
  for (const entry of receipt.entries) {
    const bytes = entry.kind === "snapshot" ? f.sourceSnapshot : f.sourceJournal;
    assert.equal(entry.bytes, bytes.length); assert.equal(entry.sha256, sha(bytes));
  }
  assert.equal(receipt.synthesizedAcceptance, false); assert.equal(receipt.synthesizedAttempts, false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); return { directory, file, receipt };
}

test("legacy raw snapshot and partial journal remain byte-identical when migration backup cannot be written", t => {
  const f = legacyPartialJournal(t, "write-failure"), fileSystem = Object.create(fs); let truncations = 0, failedWrites = 0;
  fileSystem.openSync = (file, flags, ...args) => {
    if (typeof file === "string" && file.includes(path.sep + "product-schema-migrations" + path.sep)
      && typeof flags === "number" && (flags & fs.constants.O_WRONLY) !== 0) {
      failedWrites++; throw Object.assign(Error("controlled migration storage full"), { code: "ENOSPC" });
    }
    return fs.openSync(file, flags, ...args);
  };
  fileSystem.ftruncateSync = (...args) => { truncations++; return fs.ftruncateSync(...args); };
  const failed = new JsonlProductStore({ paths: f.paths, fs: fileSystem });
  assert.throws(() => failed.open(), { code: "ENOSPC" }); assert.equal(failed.opened, false);
  assert.equal(failedWrites, 1); assert.equal(truncations, 0);
  assert.deepEqual(fs.readFileSync(f.paths.stateSnapshotPath), f.sourceSnapshot);
  assert.deepEqual(fs.readFileSync(f.paths.eventLogPath), f.sourceJournal);
  const retried = new JsonlProductStore({ paths: f.paths }); retried.open(); cleanups.get(t).push(() => retried.close());
  migrationReceipt(f); assert.deepEqual(fs.readFileSync(f.paths.eventLogPath), f.prefix);
});

test("legacy migration commits complete raw receipts and directory ancestry before truncating a partial tail", t => {
  const f = legacyPartialJournal(t, "ordered-repair"), fileSystem = Object.create(fs), descriptors = new Map(), syncedDirectories = [];
  let truncations = 0;
  fileSystem.openSync = (file, ...args) => { const fd = fs.openSync(file, ...args); if (typeof file === "string") descriptors.set(fd, path.resolve(file)); return fd; };
  fileSystem.closeSync = fd => { descriptors.delete(fd); return fs.closeSync(fd); };
  fileSystem.fsyncSync = fd => { const file = descriptors.get(fd); if (file && fs.fstatSync(fd).isDirectory()) syncedDirectories.push(file); return fs.fsyncSync(fd); };
  fileSystem.ftruncateSync = (fd, length) => {
    truncations++; const retained = migrationReceipt(f);
    assert.deepEqual(fs.readFileSync(f.paths.stateSnapshotPath), f.sourceSnapshot);
    assert.deepEqual(fs.readFileSync(f.paths.eventLogPath), f.sourceJournal, "source has not been repaired before the durable backup");
    for (const directory of [retained.directory, path.dirname(retained.directory), path.dirname(path.dirname(retained.directory)), f.paths.stateDir])
      assert(syncedDirectories.includes(directory), `migration directory ancestry must be durable before repair: ${path.basename(directory)}`);
    assert.equal(length, f.prefix.length); return fs.ftruncateSync(fd, length);
  };
  const current = new JsonlProductStore({ paths: f.paths, fs: fileSystem }); current.open(); cleanups.get(t).push(() => current.close());
  assert.equal(truncations, 1); migrationReceipt(f);
  assert.deepEqual(fs.readFileSync(f.paths.eventLogPath), f.prefix);
  assert.deepEqual(fs.readFileSync(f.paths.stateSnapshotPath), f.sourceSnapshot);
});

test("an unconfirmed migration ancestor fsync leaves the raw tail intact and a retry rechecks durability", t => {
  const f = legacyPartialJournal(t, "directory-failure"), fileSystem = Object.create(fs), descriptors = new Map();
  const ancestor = path.join(f.paths.stateDir, "product-schema-migrations"); let truncations = 0, failedSyncs = 0;
  fileSystem.openSync = (file, ...args) => { const fd = fs.openSync(file, ...args); if (typeof file === "string") descriptors.set(fd, path.resolve(file)); return fd; };
  fileSystem.closeSync = fd => { descriptors.delete(fd); return fs.closeSync(fd); };
  fileSystem.fsyncSync = fd => {
    if (descriptors.get(fd) === ancestor) { failedSyncs++; throw Object.assign(Error("controlled migration directory sync failure"), { code: "EIO" }); }
    return fs.fsyncSync(fd);
  };
  fileSystem.ftruncateSync = (...args) => { truncations++; return fs.ftruncateSync(...args); };
  const failed = new JsonlProductStore({ paths: f.paths, fs: fileSystem });
  assert.throws(() => failed.open(), { code: "EIO" }); assert.equal(failedSyncs, 1); assert.equal(truncations, 0);
  migrationReceipt(f);
  assert.deepEqual(fs.readFileSync(f.paths.stateSnapshotPath), f.sourceSnapshot);
  assert.deepEqual(fs.readFileSync(f.paths.eventLogPath), f.sourceJournal);
  const retried = new JsonlProductStore({ paths: f.paths }); retried.open(); cleanups.get(t).push(() => retried.close());
  migrationReceipt(f); assert.deepEqual(fs.readFileSync(f.paths.eventLogPath), f.prefix);
});

test("prepared attempts cannot publish either accepted ref or combine a first write marker with acceptance", t => {
  const f = productFixture(t); f.start("run-accepted-monotonic");
  const run = f.dispatcher.prepareAttempt("run-accepted-monotonic", attempted(f.binding, "one"));
  const { runtimeSessionRef, runtimeTurnRef } = require("../app/agent-service/runtime-adapter");
  const { validateWorkRun } = require("../app/agent-service/product-store");
  const session = runtimeSessionRef(f.binding, "native-session"), turn = runtimeTurnRef(f.binding, "native-session", "local-turn-one");
  const before = fs.readFileSync(f.paths.eventLogPath);
  for (const accepted of [{ runtimeSessionRef: session }, { runtimeSessionRef: session, runtimeTurnRef: turn }]) {
    assert.throws(() => validateWorkRun({ ...run, ...accepted }), { code: "STORE_INVALID_RECORD" });
    assert.throws(() => f.store.putWorkRun({ ...run, ...accepted, eventSeq: run.eventSeq + 1 }), { code: "WORK_RUN_BINDING_IMMUTABLE" });
    assert.throws(() => f.store.putWorkRun({ ...run, ...accepted, runtimeAttemptRef: attempted(f.binding, "one", "write_attempted"),
      eventSeq: run.eventSeq + 1 }), { code: "WORK_RUN_BINDING_IMMUTABLE" });
  }
  assert.deepEqual(fs.readFileSync(f.paths.eventLogPath), before);
  f.dispatcher.markAttemptDispatch(run.id, details("one"));
  const accepted = f.dispatcher.bindAcceptedAttempt(run.id, { attemptId: "attempt-one", sessionId: "native-session", turnId: "local-turn-one" });
  const acceptedBytes = fs.readFileSync(f.paths.eventLogPath);
  for (const patch of [{ runtimeSessionRef: null }, { runtimeTurnRef: null },
    { runtimeSessionRef: runtimeSessionRef(f.binding, "other-session") },
    { runtimeTurnRef: runtimeTurnRef(f.binding, "native-session", "other-turn") },
    { runtimeAttemptRef: null }, { runtimeAttemptRef: attempted(f.binding, "one") }]) {
    assert.throws(() => f.store.putWorkRun({ ...accepted, ...patch, eventSeq: accepted.eventSeq + 1 }), { code: "WORK_RUN_BINDING_IMMUTABLE" });
  }
  assert.deepEqual(fs.readFileSync(f.paths.eventLogPath), acceptedBytes);
  f.store.close(); const reopened = new JsonlProductStore({ paths: f.paths }); reopened.open(); cleanups.get(t).push(() => reopened.close());
  const retained = reopened.getWorkRun(run.id);
  assert.deepEqual(retained.runtimeSessionRef, accepted.runtimeSessionRef); assert.deepEqual(retained.runtimeTurnRef, accepted.runtimeTurnRef);
  assert.deepEqual(retained.runtimeAttemptRef, accepted.runtimeAttemptRef);
});


test("a Runtime cannot dispatch while durable preparation is still pending", async () => {
  let release, pending, writes = 0;
  const durable = new Promise(resolve => { release = resolve; });
  const { handle } = rawHandle(async (_payload, local) => {
    pending = local.onPrepared(receipt());
    try { local.onDispatchAttempt(receipt()); writes++; }
    finally { release(); await pending; }
    return { turn: { id: "local-turn-one" } };
  });
  await assert.rejects(handle.turnStart(turnInput, observer({ onPrepared: () => durable })), { code: "RUNTIME_PROTOCOL_INVALID" });
  assert.equal(writes, 0);
});

function legacyStartupService(f) {
  const { createAgentService } = require("../app/agent-service/server"); let nativeAcquireAttempts = 0;
  const service = createAgentService({ paths: f.paths, prewarmMcpAuth: false, runtimeStorageHomedir: () => f.root,
    parentEnv: { HOME: f.root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: f.root },
    runtimePool: { get() { nativeAcquireAttempts++; throw Error("Native runtime forbidden in migration startup proof"); }, async stopAll() {}, async stop() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() } });
  return { service, nativeAcquireAttempts: () => nativeAcquireAttempts };
}

test("real Service startup accepts validated v15 snapshot plus journal, preserves raw receipt, then reopens the current schema", { timeout: 25000 }, async t => {
  const f = legacyPartialJournal(t, "service-startup"); assert(f.prefix.length > 0);
  const first = legacyStartupService(f); let second;
  try {
    await first.service.start();
    assert.equal(first.service.productStore.schemaVersion, STORE_SCHEMA_VERSION);
    const retained = migrationReceipt(f), receiptBytes = fs.readFileSync(retained.file);
    for (const id of ["tail-snapshot-run", "tail-journal-run"]) {
      const run = first.service.productStore.getWorkRun(id);
      assert(run, "snapshot and newer journal histories must both survive the real startup gate");
      assert.equal(run.runtimeAttemptRef, null); assert.equal(run.runtimeSessionRef, null); assert.equal(run.runtimeTurnRef, null);
    }
    assert.equal(first.nativeAcquireAttempts(), 0); assert.equal(first.service.runtimeManager.statistics().hosts, 0);
    await first.service.stop({ notify: false });
    assert.equal(JSON.parse(fs.readFileSync(f.paths.stateSnapshotPath)).schemaVersion, STORE_SCHEMA_VERSION);
    assert.deepEqual(fs.readFileSync(retained.file), receiptBytes);
    second = legacyStartupService(f); await second.service.start();
    for (const id of ["tail-snapshot-run", "tail-journal-run"]) assert(second.service.productStore.getWorkRun(id));
    assert.equal(second.nativeAcquireAttempts(), 0); assert.equal(second.service.runtimeManager.statistics().hosts, 0);
    assert.deepEqual(fs.readFileSync(retained.file), receiptBytes); migrationReceipt(f);
    await second.service.stop({ notify: false });
    assert.equal(fs.existsSync(f.paths.socketPath), false);
  } finally {
    await second?.service.stop({ notify: false }); await first.service.stop({ notify: false });
  }
});

for (const corrupt of ["snapshot", "journal"]) test(`real Service refuses corrupt v15 ${corrupt} after baseline admission without reset or source mutation`, { timeout: 15000 }, async t => {
  const f = legacyPartialJournal(t, `service-corrupt-${corrupt}`);
  if (corrupt === "snapshot") {
    const snapshot = JSON.parse(f.sourceSnapshot); snapshot.checksum = "0".repeat(64);
    fs.writeFileSync(f.paths.stateSnapshotPath, JSON.stringify(snapshot) + "\n", { mode: 0o600 });
  } else {
    const lines = f.prefix.toString("utf8").trimEnd().split("\n"), event = JSON.parse(lines.at(-1)); event.checksum = "0".repeat(64);
    lines[lines.length - 1] = JSON.stringify(event);
    fs.writeFileSync(f.paths.eventLogPath, Buffer.concat([Buffer.from(lines.join("\n") + "\n"), f.sourceJournal.subarray(f.prefix.length)]), { mode: 0o600 });
  }
  const snapshotBefore = fs.readFileSync(f.paths.stateSnapshotPath), journalBefore = fs.readFileSync(f.paths.eventLogPath);
  const current = legacyStartupService(f);
  try {
    await assert.rejects(current.service.start(), { code: corrupt === "snapshot" ? "STORE_CORRUPT_SNAPSHOT" : "STORE_CORRUPT_EVENT_LOG" });
    assert.deepEqual(fs.readFileSync(f.paths.stateSnapshotPath), snapshotBefore);
    assert.deepEqual(fs.readFileSync(f.paths.eventLogPath), journalBefore);
    assert.equal(fs.existsSync(path.join(f.paths.stateDir, "product-schema-migrations")), false);
    assert.equal(current.nativeAcquireAttempts(), 0); assert.equal(fs.existsSync(f.paths.socketPath), false);
  } finally { await current.service.stop({ notify: false }); }
});

test("current authority manifest classifies Product, encrypted RunExecution3 and ACP ledger2 without treating attempts as cache", () => {
  const { DATA_AUTHORITY_MANIFEST: manifest, flattenRecordFields, validateDataAuthorityManifest } = require("../app/agent-service/data-authority-manifest");
  const { WORK_RUN_FIELDS } = require("../app/agent-service/product-store");
  assert.equal(validateDataAuthorityManifest(manifest), true);
  assert.equal(manifest.stores.product.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(manifest.stores.runExecution.schemaVersion, 3); assert.equal(manifest.stores.runtimeAcpLedger.schemaVersion, 2);
  assert(manifest.stores.runExecution.records.RunExecutionBinding.authority.includes("attempt"));
  assert(!manifest.stores.runExecution.records.RunExecutionBinding.runtimeCache.includes("attempt"));
  const workRun = manifest.stores.product.records.WorkRun, fields = flattenRecordFields(workRun);
  assert.deepEqual([...fields].sort(), [...WORK_RUN_FIELDS].sort()); assert.equal(new Set(fields).size, fields.length);
  assert(workRun.authority.includes("runtimeAttemptRef")); assert(!workRun.runtimeCache.includes("runtimeAttemptRef"));
  assert(manifest.stores.product.pathRules.some(rule => rule.includes(`product-schema-migrations/15-to-${STORE_SCHEMA_VERSION}`)));
});
