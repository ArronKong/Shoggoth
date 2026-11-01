"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createAcpHandle } = require("../app/agent-service/runtime-acp-handle");
const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const { openAcpLedger, migrateAcpLedgerV1 } = require("../app/agent-service/runtime-acp-ledger");
const { atomicWritePrivateFile } = require("../app/agent-service/private-file");
const binding = { runtime: "ext-lifecycle", runtimeProfileId: "p", runtimeAccountId: "a" };
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const ledgerPath = (root, b = binding) => path.join(root, "runtime-acp-ledgers", crypto.createHash("sha256").update(JSON.stringify([b, root])).digest("hex") + ".json");
const read = f => JSON.parse(fs.readFileSync(ledgerPath(f.root), "utf8"));
const observer = (attemptId = "attempt-1", callbacks = {}) => ({ version: 1, attemptId,
  onPrepared: async () => {}, onDispatchAttempt() {}, assertCurrent() {}, ...callbacks });
async function fixture(options = {}) {
  const root = options.root || fs.realpathSync(fs.mkdtempSync("/tmp/acp-lifecycle-"));
  const ended = defer(), notifications = [], calls = [], handlers = new Map(), subscribers = new Set(), events = [];
  let sequence = 0, stopped = false;
  const rpc = { preflightRequest() {}, subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    registerServerRequestHandler(method, fn) { handlers.set(method, fn); return () => handlers.delete(method); },
    pauseRequestTimeout(method, predicate) { calls.push({ method: "pause", target: method, predicate }); return () => calls.push({ method: "release" }); },
    async notify(method, params) { notifications.push({ method, params }); await options.notify?.(method, params); },
    async request(method, params, hooks = {}) {
      calls.push({ method, params, hooks });
      if (method === "initialize") return options.hello || { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (method === "session/new") return { sessionId: `session-${++sequence}`, ...(options.catalog || {}) };
      if (method === "session/load" || method === "session/resume") { await options.load?.(params, emit); return options.catalog || {}; }
      if (method === "session/set_model") { await options.setModel?.(params); return {}; }
      if (method === "session/set_mode") return {};
      if (method === "session/set_config_option") {
        options.catalog.configOptions = options.catalog.configOptions.map(v => ({ ...v, currentValue: v.id === params.configId ? params.value : v.currentValue }));
        return { configOptions: options.catalog.configOptions };
      }
      if (method === "session/prompt") {
        if (options.beforeWrite) await options.beforeWrite(params);
        if (options.notSent) throw Object.assign(new Error("fixture not written"), { dispatchState: "not_sent", code: "FIXTURE_NOT_SENT" });
        hooks.onWriteAttempt?.();
        if (options.writeFailure) throw Object.assign(new Error("fixture write failed"), { dispatchState: "write_attempted" });
        hooks.onWritten?.();
        return options.prompt ? options.prompt(params, emit, handlers) : { stopReason: "end_turn" };
      }
      throw Error(`Unexpected ${method}`);
    } };
  const emit = (sessionId, update) => { for (const fn of subscribers) fn({ method: "session/update", params: { sessionId, update } }); };
  const host = { transport: "acp", runtimeIdentity: { digest: "fixture" }, permissionPolicy: { approvalPolicy: "never", sandbox: "danger-full-access" },
    assertRuntimeIdentityCurrent() {}, canRetireIdle() { return true; }, ...options.host };
  const stop = async () => { stopped = true; await options.stop?.(); if (!options.unconfirmedStop) ended.resolve(); };
  const raw = await createAcpHandle({ binding, rpc, home: root, workspace: root, stateDir: root, trustedRoot: root, host,
    stop, terminated: ended.promise, ledgerWriter: options.writer, onDiagnostic: options.onDiagnostic });
  const f = { root, raw, handle: runtimeHandleV1(raw, binding), rpc, calls, notifications, handlers, events, host, emit,
    stopped: () => stopped, async close() { ended.resolve(); await Promise.resolve(); if (!options.root) fs.rmSync(root, { recursive: true, force: true }); } };
  raw.subscribe(event => events.push(event));
  return f;
}
const session = async (f, source = "source", extra = {}) => (await f.handle.sessionStart({ cwd: f.root, source, ...extra })).session.id;
const turn = (f, sessionId, extra = {}, obs = observer()) => f.handle.turnStart({ cwd: f.root, sessionId, operationId: "operation", prompt: "USER", ...extra }, obs);
const chunk = text => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

test("durable prepared identity is routed before write and more than 256 early events retain attribution", async () => {
  let f, prepared, attempted;
  f = await fixture({ prompt(params, emit) {
    for (let n = 0; n < 320; n++) emit(params.sessionId, chunk("x"));
    return { stopReason: "end_turn" };
  } });
  try {
    const id = await session(f);
    const result = await turn(f, id, {}, observer("attempt-first", {
      async onPrepared(dto) { prepared = dto; const receipt = read(f).sessions[0].turns[0];
        assert.equal(receipt.facts.prepared, true); assert.equal(receipt.facts.writeAttempted, false);
        assert.equal(f.calls.some(v => v.method === "session/prompt"), false); },
      onDispatchAttempt(dto) { attempted = dto; assert.equal(read(f).sessions[0].turns[0].facts.writeAttempted, true); }
    }));
    assert.deepEqual(attempted, prepared); assert.equal(result.turn.id, prepared.turnId);
    assert.equal(f.events.filter(v => v.type === "text_delta").length, 320);
    assert.equal(new Set(f.events.map(v => v.turnId)).size, 1);
    assert.equal(f.events.at(-1).type, "complete");
    const t = read(f).sessions[0].turns[0]; assert.equal(t.items[0].text.length, 320);
    assert.equal(t.facts.remoteAccepted, true); assert.equal(t.facts.terminal, true);
    assert.equal(f.calls.find(v => v.method === "session/prompt").hooks.timeoutMs, null);
    assert.equal(JSON.stringify(f.calls.find(v => v.method === "session/prompt").params).includes("onPrepared"), false);
  } finally { await f.close(); }
});

test("observer rejection and guaranteed never-written transport failures are the only retryable receipts", async () => {
  const f = await fixture();
  try {
    const id = await session(f);
    await assert.rejects(turn(f, id, {}, observer("attempt-1", { onPrepared: async () => { throw Object.assign(Error("revoked"), { code: "FIXTURE_REVOKED" }); } })),
      { code: "FIXTURE_REVOKED", dispatchState: "not_sent" });
    assert.equal(f.calls.filter(v => v.method === "session/prompt").length, 0);
    assert.equal(read(f).sessions[0].turns[0].facts.notSent, true);
    const result = await turn(f, id, {}, observer("attempt-2"));
    assert.equal(result.execution.attemptId, "attempt-2"); assert.equal(read(f).sessions[0].turns.length, 1);
    assert.equal(f.calls.filter(v => v.method === "session/prompt").length, 1);
    await assert.rejects(turn(f, id, { prompt: "changed" }), { code: "RUNTIME_OPERATION_CONFLICT" });
  } finally { await f.close(); }
  const never = await fixture({ notSent: true });
  try { const id = await session(never);
    await assert.rejects(turn(never, id), { code: "FIXTURE_NOT_SENT", dispatchState: "not_sent" });
    assert.equal(read(never).sessions[0].turns[0].facts.notSent, true);
  } finally { await never.close(); }
});

test("a never-written retry binds the actual encoded stable context and records the sent delivery", async () => {
  const f = await fixture();
  try {
    const id = await session(f, "source", { developerInstructions: "STABLE_FIRST" });
    const input = { turnDeveloperInstructions: "TURN", context: "DYNAMIC", contextSnapshotId: "ctx-" + "b".repeat(64),
      contextRevisions: { definition: 2, memory: 7 }, nativeMemoryVersion: { revision: 7 } };
    await assert.rejects(turn(f, id, input, observer("attempt-1", { onPrepared() {
      throw Object.assign(Error("controlled preparation rejection"), { code: "FIXTURE_REVOKED" }); } })), { code: "FIXTURE_REVOKED", dispatchState: "not_sent" });
    const first = read(f).sessions[0].turns[0];
    assert.equal(first.facts.notSent, true); assert.equal(f.calls.filter(v => v.method === "session/prompt").length, 0);
    await f.handle.sessionResume({ sessionId: id, developerInstructions: "STABLE_CHANGED" });
    await assert.rejects(turn(f, id, input, observer("attempt-2")), { code: "RUNTIME_OPERATION_CONFLICT" });
    assert.equal(f.calls.filter(v => v.method === "session/prompt").length, 0, "changed configured input must never reuse this operation");
    assert.equal(read(f).sessions[0].turns[0].attemptId, "attempt-1");
    await f.handle.sessionResume({ sessionId: id, developerInstructions: "STABLE_FIRST" });
    const result = await turn(f, id, input, observer("attempt-3"));
    const sent = f.calls.filter(v => v.method === "session/prompt"); assert.equal(sent.length, 1);
    assert.equal(sent[0].params.prompt[0].text, "STABLE_FIRST\n\nTURN\n\nDYNAMIC\n\nUSER");
    const current = read(f).sessions[0].turns[0];
    assert.equal(current.fingerprint, first.fingerprint); assert.equal(result.execution.attemptId, "attempt-3");
    assert.equal(current.contextDelivery.stableVersion, crypto.createHash("sha256").update("STABLE_FIRST").digest("hex"));
    assert.equal(current.contextDelivery.encodedPromptFingerprint, crypto.createHash("sha256").update(JSON.stringify(sent[0].params)).digest("hex"));
    assert.deepEqual(current.contextDelivery.contextRevisions, input.contextRevisions);
    assert.deepEqual(current.contextDelivery.nativeMemoryVersion, input.nativeMemoryVersion);
    assert.equal(current.contextDelivery.confirmed, true); assert.equal(current.contextDelivery.reused, false);
  } finally { await f.close(); }
});

test("write attempt with no events remains unknown and neither read nor load nor local client ID clears it", async () => {
  const f = await fixture({ writeFailure: true }); let resumed;
  try {
    const id = await session(f);
    await assert.rejects(turn(f, id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN", dispatchState: "write_attempted" });
    assert.equal(read(f).sessions[0].turns[0].facts.frameWritten, false);
    assert.equal(f.host.canRetireIdle(), false);
    const before = (await f.handle.sessionRead({ sessionId: id })).session.turns[0];
    assert.equal(before.status, "unknown"); assert.deepEqual(before.items, []);
    resumed = await fixture({ root: f.root, load(params, emit) { emit(params.sessionId, { sessionUpdate: "user_message_chunk", clientId: "operation", content: { type: "text", text: "USER" } }); } });
    await resumed.handle.sessionResume({ sessionId: id });
    await assert.rejects(turn(resumed, id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    await assert.rejects(turn(resumed, id, { operationId: "new-operation" }), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    assert.equal(resumed.calls.filter(v => v.method === "session/prompt").length, 0);
    assert.equal(JSON.stringify((await resumed.handle.sessionRead({ sessionId: id })).session).includes('"clientId"'), false);
  } finally { await resumed?.close(); await f.close(); }
});

test("an onDispatchAttempt throw or asynchronous callback never reaches a prompt byte", async () => {
  for (const callback of [() => { throw Error("fence"); }, () => Promise.resolve()]) {
    const f = await fixture();
    try { const id = await session(f);
      await assert.rejects(turn(f, id, {}, observer("attempt", { onDispatchAttempt: callback })), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
      assert.equal(read(f).sessions[0].turns[0].facts.writeAttempted, true);
      assert.equal(read(f).sessions[0].turns[0].facts.frameWritten, false);
      assert.equal(f.events.some(v => v.type === "complete"), false);
    } finally { await f.close(); }
  }
});

test("terminal persistence failure cannot emit completion or publish terminal success", async () => {
  let failedOnce = false;
  const f = await fixture({ writer(file, bytes, options) {
    const state = file.endsWith(".json") ? JSON.parse(bytes) : null;
    if (!failedOnce && state?.sessions?.some(s => s.turns.some(t => t.facts.terminal))) { failedOnce = true; throw Error("terminal fsync failure"); }
    return atomicWritePrivateFile(file, bytes, options);
  } });
  try { const id = await session(f);
    await assert.rejects(turn(f, id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    const t = read(f).sessions[0].turns[0]; assert.equal(t.facts.terminal, false); assert.equal(t.facts.unknown, true);
    assert.equal(t.status, "unknown"); assert.equal(f.events.some(v => v.type === "complete"), false);
    await assert.rejects(turn(f, id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
  } finally { await f.close(); }
});

test("thinking, text boundaries, tools and plan share stable live and recovered history IDs", async () => {
  const f = await fixture({ prompt(params, emit) {
    emit(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "THOUGHT" } });
    emit(params.sessionId, chunk("same"));
    emit(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "native-tool", title: "Read", kind: "read", status: "in_progress", rawInput: { path: "fixture" } });
    emit(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "native-tool", status: "completed", rawOutput: { text: "result" } });
    emit(params.sessionId, chunk("same"));
    emit(params.sessionId, { sessionUpdate: "plan", entries: [{ content: "Step", priority: "high", status: "completed" }] });
    return { stopReason: "end_turn" };
  } }); let recovered;
  try {
    const id = await session(f); await turn(f, id);
    const first = (await f.handle.sessionRead({ sessionId: id })).session.turns[0];
    assert.deepEqual(first.items.map(v => v.type), ["reasoning", "agentMessage", "dynamicToolCall", "agentMessage", "plan"]);
    assert.deepEqual(first.items.filter(v => v.type === "agentMessage").map(v => v.text), ["same", "same"]);
    const liveIds = new Set(f.events.filter(v => v.itemId).map(v => v.itemId));
    for (const item of first.items) assert.equal(liveIds.has(item.id), true);
    assert.notEqual(first.items[1].id, first.items[3].id); assert.equal(first.items[2].id, "native-tool");
    recovered = await fixture({ root: f.root });
    assert.deepEqual((await recovered.handle.sessionRead({ sessionId: id })).session.turns[0], first);
  } finally { await recovered?.close(); await f.close(); }
});

test("replay is buffered until load validates, cannot trigger live tools, and repeated text is retained by segment IDs", async () => {
  const f = await fixture(); let recovered;
  try {
    const id = await session(f);
    recovered = await fixture({ root: f.root, load(session, emit) {
      emit(session.sessionId, chunk("same"));
      emit(session.sessionId, { sessionUpdate: "tool_call", toolCallId: "replay-tool", title: "History", status: "completed", rawOutput: "old" });
      emit(session.sessionId, chunk("same"));
      assert.equal(recovered.events.length, 0);
      assert.deepEqual(recovered.raw.sessionRead({ sessionId: id }).session.turns, []);
    } });
    const history = (await recovered.handle.sessionResume({ sessionId: id })).session.turns;
    assert.equal(recovered.events.length, 0); assert.equal(history.length, 1);
    assert.deepEqual(history[0].items.filter(v => v.type === "agentMessage").map(v => v.text), ["same", "same"]);
    assert.notEqual(history[0].items[0].id, history[0].items[2].id);
    assert.deepEqual((await recovered.handle.sessionResume({ sessionId: id })).session.turns, history);
    assert.equal(recovered.calls.filter(v => v.method === "session/load").length, 1);
  } finally { await recovered?.close(); await f.close(); }
});

test("different sessions interleave without sharing items or metadata; per-run hosts share one ledger", async () => {
  const waits = new Map(), f = await fixture({ prompt(params, emit) {
    const d = defer(); waits.set(params.sessionId, d); emit(params.sessionId, chunk(params.sessionId)); return d.promise;
  } }); let second;
  try {
    const one = await session(f, "one"), two = await session(f, "two");
    const a = turn(f, one, { operationId: "one" }), b = turn(f, two, { operationId: "two" });
    await new Promise(resolve => setImmediate(resolve));
    waits.get(two).resolve({ stopReason: "end_turn" }); waits.get(one).resolve({ stopReason: "end_turn" }); await Promise.all([a, b]);
    assert.deepEqual(read(f).sessions.map(s => s.turns[0].items[0].text), [one, two]);
    second = await fixture({ root: f.root });
    await second.handle.sessionRename({ sessionId: one, name: "Shared name" });
    await f.handle.sessionArchive({ sessionId: two });
    assert.equal(read(f).sessions[0].name, "Shared name"); assert.equal(read(f).sessions[1].archived, true);
    assert.equal(f.raw.sessionRead({ sessionId: one }).session.name, "Shared name");
  } finally { await second?.close(); await f.close(); }
});

test("stable, turn and dynamic instructions are delivered on every turn; catalog features require real session data", async () => {
  const catalog = {
    modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "plan", name: "Plan" }] },
    configOptions: [{ id: "model", category: "model", name: "Model", type: "select", currentValue: "one", options: [{ value: "one", name: "One" }, { value: "two", name: "Two" }] },
      { id: "verbosity", name: "Verbosity", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }] };
  const f = await fixture({ catalog });
  try {
    const id = await session(f, "source", { developerInstructions: "STABLE" });
    assert.equal((await f.handle.modelsList({ sessionId: id })).data.length, 2);
    assert.equal(f.raw.contextUsage({ sessionId: id }).usedTokens, null);
    await turn(f, id, { turnDeveloperInstructions: "TURN", context: "DYNAMIC", model: "two", modeId: "plan", configOptions: [{ configId: "verbosity", value: "high" }],
      contextSnapshotId: "ctx-" + "a".repeat(64), contextRevisions: { definition: 1, memory: 5 }, nativeMemoryVersion: { revision: 5 } });
    await turn(f, id, { operationId: "next", turnDeveloperInstructions: "TURN2", context: "DYNAMIC2" }, observer("next"));
    const prompts = f.calls.filter(v => v.method === "session/prompt").map(v => v.params.prompt[0].text);
    assert.deepEqual(prompts, ["STABLE\n\nTURN\n\nDYNAMIC\n\nUSER", "STABLE\n\nTURN2\n\nDYNAMIC2\n\nUSER"]);
    assert.equal(read(f).sessions[0].turns.every(t => t.contextDelivery.reused === false), true);
    assert.equal(f.calls.filter(v => v.method === "session/set_model").length, 0);
    assert.equal(f.calls.filter(v => v.method === "session/set_mode").length, 1);
    assert.equal(f.calls.filter(v => v.method === "session/set_config_option").length, 2);
    assert.deepEqual(read(f).sessions[0].turns[0].contextDelivery.contextRevisions, { definition: 1, memory: 5 });
    assert.deepEqual(read(f).sessions[0].turns[0].contextDelivery.nativeMemoryVersion, { revision: 5 });
    for (const unsupported of [{ thinkingLevel: "high" }, { serviceTier: "fast" }, { modeId: "unsafe" }, { configOptions: [{ configId: "verbosity", value: "unknown" }] }]) {
      await assert.rejects(turn(f, id, { operationId: "unsupported-" + JSON.stringify(unsupported), ...unsupported }), { code: "RUNTIME_CAPABILITY_UNSUPPORTED" });
    }
    await assert.rejects(turn(f, id, { operationId: "bad-model", model: "missing" }), { code: "RUNTIME_CAPABILITY_UNSUPPORTED" });
    f.emit(id, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "plan", description: "Plan" }, { name: "compact", description: "Maybe compact" }] });
    assert.equal((await f.handle.commandsList({ sessionId: id })).commands.length, 1);
    assert.deepEqual(await f.handle.commandExecute({ sessionId: id, text: "/plan details" }), { kind: "send", text: "/plan details", warning: null });
    await assert.rejects(f.handle.commandExecute({ sessionId: id, text: "/unknown" }), { code: "RUNTIME_CAPABILITY_UNSUPPORTED" });
    assert.equal(f.handle.capabilities["context.compact.native"], false, "advertisement is not a completed compaction boundary");
    f.emit(id, { sessionUpdate: "usage_update", used: 42, size: 100 });
    assert.equal(f.raw.contextUsage({ sessionId: id }).usedTokens, 42);
    f.emit(id, { sessionUpdate: "x-billing", totalTokens: 999999 });
    assert.equal(f.raw.contextUsage({ sessionId: id }).usedTokens, 42);
  } finally { await f.close(); }
});

test("permission waits pause this prompt only and cancellation revokes a late selected option", async () => {
  const permission = defer(), requested = defer(), terminal = defer(); let interrupted = 0;
  const f = await fixture({ host: { acpBridge: { async prepareSession() { return { mcpServers: [], bindSession() {} }; },
    prepareTurn() {}, dispatchAttempt() {}, finishTurn() {}, interruptTurn() { interrupted++; },
    requestPermission() { requested.resolve(); return permission.promise; } } },
    prompt: () => terminal.promise,
    notify() { terminal.resolve({ stopReason: "cancelled" }); } });
  try {
    const id = await session(f), running = turn(f, id); await new Promise(resolve => setImmediate(resolve));
    const native = f.handlers.get("session/request_permission")({ sessionId: id, options: [{ kind: "allow_once", optionId: "allow" }] });
    await requested.promise;
    const a = read(f).sessions[0].turns[0]; await f.handle.turnInterrupt({ sessionId: id, turnId: a.id });
    permission.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
    assert.deepEqual(await native, { outcome: { outcome: "cancelled" } });
    assert.equal((await running).turn.status, "canceled"); assert.equal(interrupted, 1);
    assert.deepEqual(f.calls.filter(v => ["pause", "release"].includes(v.method)).map(v => v.method), ["pause", "release"]);
  } finally { await f.close(); }
});

function legacyState(root, status = "completed") { return { version: 1, pending: [], sessions: [{ id: "old", source: "source", cwd: root,
  createdAt: 1, archived: false, turns: [{ id: "old-turn", operationId: "old-op", fingerprint: "a".repeat(64), status, text: "legacy" }] }] }; }
for (const failAt of [1, 2, 3, 4]) test(`V1 migration recovers interruption at durable write ${failAt} without restoring over V2`, () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-migrate-"));
  try {
    const file = ledgerPath(root), legacy = legacyState(root); atomicWritePrivateFile(file, JSON.stringify(legacy) + "\n", { trustedRoot: root });
    let writes = 0;
    assert.throws(() => openAcpLedger({ binding, workspace: root, stateDir: root, trustedRoot: root, writer(...args) {
      if (++writes === failAt) throw Error("crash point"); return atomicWritePrivateFile(...args);
    } }));
    const next = openAcpLedger({ binding, workspace: root, stateDir: root, trustedRoot: root });
    assert.equal(next.state.version, 2); const t = next.state.sessions[0].turns[0];
    assert.equal(t.facts.terminal, true); assert.equal(t.facts.remoteAccepted, false); assert.equal(t.items[0].text, "legacy");
    assert.equal(t.items.some(v => v.type === "userMessage"), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file + ".v1-original", "utf8")), legacy);
    assert.equal(JSON.parse(fs.readFileSync(file + ".migration-v2.json", "utf8")).status, "committed");
    next.state.sessions[0].name = "V2 edit"; next.save();
    // A fresh process verifies the committed receipt without applying the saved V1.
    const script = 'const {openAcpLedger}=require(process.argv[1]);const r=process.argv[2];const b=JSON.parse(process.argv[3]);const s=openAcpLedger({binding:b,workspace:r,stateDir:r,trustedRoot:r});process.stdout.write(s.state.sessions[0].name)';
    const result = spawnSync(process.execPath, ["-e", script, path.resolve(__dirname, "../app/agent-service/runtime-acp-ledger.js"), root, JSON.stringify(binding)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "V2 edit");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy inProgress migration remains unknown with no fabricated acceptance and old readers fail closed", () => {
  const root = "/legacy-workspace", next = migrateAcpLedgerV1(legacyState(root, "inProgress"), root), t = next.sessions[0].turns[0];
  assert.equal(t.status, "unknown"); assert.equal(t.facts.unknown, true); assert.equal(t.facts.remoteAccepted, false); assert.equal(t.facts.terminal, false);
  assert.notEqual(next.version, 1); assert.equal(t.items.some(v => v.clientId), false);
});


test("V1 migration preserves exact source bytes and hashes whitespace rather than rewriting its original", () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-migrate-bytes-")); let lease;
  try {
    const file = ledgerPath(root), bytes = Buffer.from("  " + JSON.stringify(legacyState(root), null, 3) + "\n\n");
    atomicWritePrivateFile(file, bytes, { trustedRoot: root });
    lease = openAcpLedger({ binding, workspace: root, stateDir: root, trustedRoot: root });
    assert.deepEqual(fs.readFileSync(file + ".v1-original"), bytes);
    assert.equal(JSON.parse(fs.readFileSync(file + ".migration-v2.json")).beforeHash,
      crypto.createHash("sha256").update(bytes).digest("hex"));
  } finally { lease?.release(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("ledger leases release on confirmed termination and detect active-owner path replacement", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-owner-")); let f, replacement, lease;
  try {
    f = await fixture({ root }); await session(f);
    const file = ledgerPath(root);
    fs.unlinkSync(file);
    await assert.rejects(fixture({ root }), { code: "RUNTIME_LEDGER_CHANGED" });
    await f.close(); f = null;
    // The last actual terminated owner released the module map. A replacement
    // at this exact path must read disk instead of reviving its old sessions.
    replacement = await fixture({ root }); assert.deepEqual((await replacement.handle.sessionList({})).data, []);
    lease = openAcpLedger({ binding, workspace: root, stateDir: root, trustedRoot: root });
    await replacement.close(); replacement = null;
    lease.release(); assert.throws(() => lease.save(), { code: "RUNTIME_LEDGER_OWNER_CLOSED" });
  } finally { lease?.release(); await f?.close(); await replacement?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("preparation persistence failure sends zero prompt bytes and reports never-written evidence", async () => {
  let failPrepared = true;
  const f = await fixture({ writer(file, bytes, options) {
    const state = JSON.parse(bytes);
    if (failPrepared && state.sessions.some(s => s.turns.length)) throw Object.assign(Error("full disk"), { code: "FIXTURE_DISK_FULL" });
    return atomicWritePrivateFile(file, bytes, options);
  } });
  try { const id = await session(f);
    await assert.rejects(turn(f, id), { code: "FIXTURE_DISK_FULL", dispatchState: "not_sent" });
    assert.equal(f.calls.filter(v => v.method === "session/prompt").length, 0);
    failPrepared = false; await turn(f, id);
    assert.equal(f.calls.filter(v => v.method === "session/prompt").length, 1);
  } finally { await f.close(); }
});

test("execution timeout cancels and confirms stop; an unconfirmed process never releases authority", async () => {
  for (const unconfirmed of [false, true]) {
    let interrupted = 0;
    const f = await fixture({ host: { acpBridge: { prepareSession: async () => ({ mcpServers: [], bindSession() {} }),
      prepareTurn() {}, dispatchAttempt() {}, finishTurn() {}, interruptTurn() { interrupted++; } } },
      prompt() { throw Object.assign(Error("deadline"), { code: "ACP_REQUEST_TIMEOUT" }); },
      stop() { if (unconfirmed) throw Error("descendant still alive"); } });
    try { const id = await session(f);
      await assert.rejects(turn(f, id), { code: unconfirmed ? "RUNTIME_STOP_UNCONFIRMED" : "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
      assert.equal(f.stopped(), true); assert.equal(interrupted, 1);
      assert.equal(f.notifications.some(v => v.method === "session/cancel"), true);
      assert.equal(read(f).sessions[0].turns[0].facts.unknown, true);
      assert.equal(f.events.some(v => v.type === "complete"), false);
      if (unconfirmed) assert.equal(f.host.canRetireIdle(), false);
    } finally { await f.close(); }
  }
});

test("multi-tool interleaving and repeated native IDs keep one completion and never regress a terminal", async () => {
  const f = await fixture({ prompt(params, emit) {
    for (const id of ["tool-one", "tool-two"]) emit(params.sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: id, status: "in_progress" });
    for (const id of ["tool-two", "tool-one", "tool-two"]) emit(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { id } });
    emit(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "tool-two", title: "tool-two", status: "in_progress" });
    return { stopReason: "end_turn" };
  } });
  try { const id = await session(f); await turn(f, id);
    const items = read(f).sessions[0].turns[0].items; assert.equal(items.length, 2);
    assert.equal(items.every(v => v.status === "completed"), true);
    assert.equal(f.events.filter(v => v.type === "tool_start").length, 2);
    assert.equal(f.events.filter(v => v.type === "tool_result").length, 2);
  } finally { await f.close(); }
});

test("interrupted replay publishes no partial historical or current capability state", async () => {
  const f = await fixture({ catalog: { models: { currentModelId: "old", availableModels: [{ modelId: "old", name: "Old" }] } } }); let resumed;
  try { const id = await session(f);
    resumed = await fixture({ root: f.root, load(params, emit) { emit(params.sessionId, chunk("partial replay")); throw Error("load interrupted"); } });
    assert.deepEqual((await resumed.handle.modelsList({ sessionId: id })).data, []);
    await assert.rejects(resumed.handle.sessionResume({ sessionId: id }));
    assert.deepEqual((await resumed.handle.sessionRead({ sessionId: id })).session.turns, []);
    assert.deepEqual((await resumed.handle.modelsList({ sessionId: id })).data, []);
    assert.equal(resumed.events.length, 0);
  } finally { await resumed?.close(); await f.close(); }
});


test("standard compaction IDs patch one durable entity and only first completed invalidates occupancy", async () => {
  const f = await fixture({ prompt(params, emit) {
    emit(params.sessionId, chunk("before"));
    emit(params.sessionId, { sessionUpdate: "usage_update", used: 42, size: 100, cost: { amount: 1.25, currency: "USD" } });
    emit(params.sessionId, { sessionUpdate: "compaction_summary_chunk", compactionId: "native-compaction", content: { type: "text", text: "partial" }, _meta: { chunk: "only" } });
    emit(params.sessionId, { sessionUpdate: "compaction_update", compactionId: "native-compaction", status: "in_progress", error: "old", _meta: { entity: "only" } });
    emit(params.sessionId, chunk("after"));
    emit(params.sessionId, { sessionUpdate: "compaction_update", compactionId: "native-compaction", status: "_future" });
    assert.equal(f.events.some(v => v.type === "context_compacted"), false);
    emit(params.sessionId, { sessionUpdate: "compaction_update", compactionId: "native-compaction", status: "completed", error: null });
    emit(params.sessionId, { sessionUpdate: "compaction_update", compactionId: "native-compaction", status: "completed", summary: null, _meta: null });
    emit(params.sessionId, { sessionUpdate: "compaction_summary_chunk", compactionId: "native-compaction", content: { type: "text", text: "retained" } });
    return { stopReason: "end_turn" };
  } });
  try { const id = await session(f); await turn(f, id);
    const saved = read(f).sessions[0], compact = saved.metadata.compactions[0];
    assert.equal(saved.metadata.compactions.length, 1); assert.equal(compact.id, "native-compaction");
    assert.deepEqual(compact.summary, [{ type: "text", text: "retained" }]); assert.equal(compact.error, null); assert.equal(compact._meta, null);
    assert.equal(compact.summaryChunkMetadata, undefined);
    assert.deepEqual(saved.turns[0].items.map(v => v.type), ["agentMessage", "contextCompaction", "agentMessage"]);
    assert.deepEqual(saved.turns[0].items[1].summary, compact.summary);
    const completions = f.events.filter(v => v.type === "context_compacted"); assert.equal(completions.length, 1);
    assert.equal(completions[0].compactionId, compact.id); assert.equal(completions[0].compaction.id, compact.id);
    assert.equal(completions[0].contextUsage.usedTokens, null); assert.equal(completions[0].contextUsage.contextWindow, 100);
    assert.equal(saved.metadata.cost.amount, 1.25); assert.equal(f.events.some(v => v.type === "usage"), false);
    assert.equal(f.raw.contextUsage({ sessionId: id }).quality, "unknown");
    assert.equal(saved.turns[0].facts.remoteAccepted, true, "the actual prompt terminal remains independent");
  } finally { await f.close(); }
});

test("idle compaction, null/omitted patches and reacquisition preserve identity without a duplicate completion", async () => {
  const f = await fixture(); let restored;
  try { const id = await session(f); await turn(f, id);
    f.emit(id, { sessionUpdate: "compaction_update", compactionId: "idle-cycle", status: "completed", summary: [{ type: "text", text: "saved" }], _meta: { version: 1 } });
    f.emit(id, { sessionUpdate: "compaction_update", compactionId: "idle-cycle", status: "completed" });
    assert.deepEqual(read(f).sessions[0].metadata.compactions[0].summary, [{ type: "text", text: "saved" }]);
    f.emit(id, { sessionUpdate: "compaction_update", compactionId: "idle-cycle", status: "completed", summary: [] });
    assert.equal(read(f).sessions[0].metadata.compactions[0].summary, null);
    assert.equal(f.events.filter(v => v.type === "context_compacted").length, 1);
    restored = await fixture({ root: f.root }); await restored.handle.sessionResume({ sessionId: id });
    restored.emit(id, { sessionUpdate: "compaction_update", compactionId: "idle-cycle", status: "completed", error: null });
    assert.equal(restored.events.some(v => v.type === "context_compacted"), false);
    assert.equal(restored.raw.sessionRead({ sessionId: id }).session.compactions[0].id, "idle-cycle");
  } finally { await restored?.close(); await f.close(); }
});

test("standard session/resume without replay uses local history and never confirms an unresolved prompt", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-standard-resume-")); let original, resumed;
  const hello = { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } } };
  try {
    original = await fixture({ root, writeFailure: true }); const id = await session(original);
    await assert.rejects(turn(original, id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" }); await original.close(); original = null;
    resumed = await fixture({ root, hello }); assert.equal(resumed.handle.capabilities["session.resume"], true);
    const history = (await resumed.handle.sessionResume({ sessionId: id })).session;
    assert.equal(history.turns[0].status, "unknown"); assert.equal(history.turns[0].execution.remoteAccepted, false);
    assert.equal(resumed.calls.filter(v => v.method === "session/resume").length, 1); assert.equal(resumed.calls.some(v => v.method === "session/load"), false);
    await assert.rejects(turn(resumed, id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    assert.equal(resumed.calls.some(v => v.method === "session/prompt"), false);
  } finally { await original?.close(); await resumed?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("legal unimplemented config entries are preserved, unsupported selections fail before writing", async () => {
  const f = await fixture({ catalog: { configOptions: [
    { id: "boolean-toggle", name: "Toggle", type: "boolean", currentValue: false },
    { id: "future-range", name: "Future", type: "_range", currentValue: 3, minimum: 1, maximum: 5 },
    { id: "uncategorized", name: "Arbitrary selector", type: "select", currentValue: "one", options: [{ value: "one", name: "One" }] },
  ] } });
  try { const id = await session(f);
    assert.equal(read(f).sessions[0].metadata.configOptions.length, 3); assert.equal(f.stopped(), false);
    assert.deepEqual((await f.handle.modelsList({ sessionId: id })).data, []);
    for (const configOptions of [[{ configId: "boolean-toggle", value: true }], [{ configId: "future-range", value: "3" }]]) {
      await assert.rejects(turn(f, id, { configOptions }), { code: "RUNTIME_CAPABILITY_UNSUPPORTED" });
    }
    assert.equal(f.calls.some(v => v.method === "session/prompt"), false);
  } finally { await f.close(); }
});

test("opaque metadata cannot supply a message ID and a refusal never confirms retained context", async () => {
  const f = await fixture({ prompt(params, emit) {
    emit(params.sessionId, { ...chunk("one"), _meta: { messageId: "opaque-one" } });
    emit(params.sessionId, { ...chunk("two"), _meta: { messageId: "opaque-two" } });
    return { stopReason: "refusal" };
  } });
  try { const id = await session(f); const result = await turn(f, id);
    assert.equal(result.execution.stopReason, "refusal"); assert.equal(result.execution.remoteAccepted, true);
    const saved = read(f).sessions[0].turns[0]; assert.equal(saved.contextDelivery.confirmed, false);
    assert.equal(saved.items.length, 1); assert.equal(saved.items[0].text, "onetwo");
    assert.notEqual(saved.items[0].id, "opaque-one"); assert.notEqual(saved.items[0].id, "opaque-two");
  } finally { await f.close(); }
});


test("session listing paginates stable local identities and rejects cursors from another archive scope", async () => {
  const f = await fixture();
  try {
    const ids = [];
    for (let index = 0; index < 5; index++) ids.push(await session(f, `page-${index}`));
    await f.handle.sessionArchive({ sessionId: ids[1] }); await f.handle.sessionArchive({ sessionId: ids[3] });
    const all = [], pages = []; let cursor;
    do { const page = await f.handle.sessionList({ limit: 2, ...(cursor ? { cursor } : {}) }); pages.push(page); all.push(...page.data.map(value => value.id)); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(all, ids); assert.deepEqual(pages.map(page => page.data.length), [2, 2, 1]);
    assert.equal(new Set(all).size, ids.length); assert(pages[0].data.every(value => !Object.hasOwn(value, "turns")));
    const active = await f.handle.sessionList({ archived: false, limit: 1 });
    const archived = await f.handle.sessionList({ archived: true, limit: 1 });
    assert.equal(active.data[0].id, ids[0]); assert.equal(archived.data[0].id, ids[1]);
    assert.deepEqual((await f.handle.sessionList({ archived: false, limit: 2, cursor: active.nextCursor })).data.map(value => value.id), [ids[2], ids[4]]);
    assert.deepEqual((await f.handle.sessionList({ archived: true, limit: 2, cursor: archived.nextCursor })).data.map(value => value.id), [ids[3]]);
    for (const input of [{ archived: true, cursor: active.nextCursor }, { archived: false, cursor: archived.nextCursor },
      { cursor: active.nextCursor }, { cursor: "acp-list:all:" + "0".repeat(64) }, { cursor: "not-an-acp-cursor" }, { limit: 0 }, { limit: 101 }]) {
      await assert.rejects(Promise.resolve().then(() => f.handle.sessionList(input)), { code: "RUNTIME_SESSION_PARAMS_INVALID" });
    }
    assert.equal(f.calls.filter(value => value.method !== "initialize" && value.method !== "session/new").length, 0);
  } finally { await f.close(); }
});

for (const loadKind of ["partial-success", "interrupted-prefix"]) test(`${loadKind} load and truncated item projection cannot clear a written unknown operation`, async () => {
  const f = await fixture({ writeFailure: true }); let resumed;
  try {
    const id = await session(f);
    await assert.rejects(turn(f, id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    const original = read(f).sessions[0].turns[0];
    resumed = await fixture({ root: f.root, load(params, emit) {
      emit(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "last visible suffix only" } });
      if (loadKind === "interrupted-prefix") throw Object.assign(Error("controlled truncated replay"), { code: "FIXTURE_REPLAY_INTERRUPTED" });
    } });
    if (loadKind === "interrupted-prefix") await assert.rejects(resumed.handle.sessionResume({ sessionId: id }), { code: "FIXTURE_REPLAY_INTERRUPTED" });
    else await resumed.handle.sessionResume({ sessionId: id });
    const compact = (await resumed.handle.sessionRead({ sessionId: id, includeItems: false })).session.turns[0];
    assert.equal(compact.status, "unknown"); assert.deepEqual(compact.items, []);
    const recovered = read(f).sessions[0].turns[0]; assert.equal(recovered.id, original.id);
    assert.deepEqual(recovered.facts, original.facts); assert.equal(recovered.facts.remoteAccepted, false); assert.equal(recovered.facts.terminal, false);
    assert.equal(read(f).sessions[0].replay.length, 0, "Unattributable partial replay must not be appended to local execution history");
    await assert.rejects(turn(resumed, id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    await assert.rejects(turn(resumed, id, { operationId: "different-operation" }), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    assert.equal(resumed.events.length, 0); assert.equal(resumed.calls.filter(value => value.method === "session/prompt").length, 0);
  } finally { await resumed?.close(); await f.close(); }
});

test("the frozen original ACP V1 reader reads V1 and rejects V2 without changing either source ledger", async () => {
  const { openLegacyAcpReader } = require("./fixtures/runtime-prepared-legacy-acp-reader.cjs");
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-real-old-reader-")); let lease;
  try {
    const file = ledgerPath(root), v1 = Buffer.from("  " + JSON.stringify(legacyState(root), null, 2) + "\n");
    atomicWritePrivateFile(file, v1, { trustedRoot: root });
    const old = await openLegacyAcpReader({ binding, workspace: root, stateDir: root, trustedRoot: root });
    assert.equal(old.handle.sessionRead({ sessionId: "old" }).session.turns[0].items.at(-1).text, "legacy");
    assert.deepEqual(old.requests, ["initialize"]); assert.deepEqual(fs.readFileSync(file), v1);
    lease = openAcpLedger({ binding, workspace: root, stateDir: root, trustedRoot: root });
    const v2 = fs.readFileSync(file), saved = fs.readFileSync(file + ".v1-original"), receipt = fs.readFileSync(file + ".migration-v2.json");
    await assert.rejects(openLegacyAcpReader({ binding, workspace: root, stateDir: root, trustedRoot: root }), { code: "RUNTIME_LEDGER_INVALID" });
    assert.deepEqual(fs.readFileSync(file), v2); assert.deepEqual(fs.readFileSync(file + ".v1-original"), saved);
    assert.deepEqual(fs.readFileSync(file + ".migration-v2.json"), receipt); assert.deepEqual(saved, v1);
    assert.equal(JSON.parse(v2).version, 2); assert.match(old.sha256, /^[a-f0-9]{64}$/u);
  } finally { lease?.release(); fs.rmSync(root, { recursive: true, force: true }); }
});


test("ACP diagnostic callback counts ignored updates with fixed metadata and never exposes native kind or body", async () => {
  const diagnostics = [], canary = "PRIVATE_KIND_BODY_PATH_/sensitive/prompt";
  const f = await fixture({ onDiagnostic: value => diagnostics.push(value), prompt(params, emit) {
    emit(params.sessionId, { sessionUpdate: "x-" + canary, content: { type: "text", text: canary }, path: canary });
    emit(params.sessionId, chunk("visible"));
    return { stopReason: "end_turn" };
  } });
  try {
    const id = await session(f);
    // A known text kind without an owning turn is also deliberately ignored;
    // the diagnostic category does not claim every projector diagnostic is unknown.
    f.emit(id, chunk(canary));
    assert.deepEqual(f.host.getCachedAuthenticationState(), { status: "unverified" });
    const result = await turn(f, id);
    assert.equal(result.execution.terminal, true); assert.equal(result.execution.remoteAccepted, true);
    assert.deepEqual(diagnostics, Array.from({ length: 2 }, () => ({ stage: "acp_update_ignored", code: "ACP_UPDATE_IGNORED", outcome: "unknown", count: 1 })));
    assert.equal(JSON.stringify(diagnostics).includes(canary), false);
    assert.equal(JSON.stringify(f.calls).includes("onDiagnostic"), false);
    assert.equal(fs.readFileSync(ledgerPath(f.root), "utf8").includes("onDiagnostic"), false);
    assert.equal(f.stopped(), false); assert.equal(f.events.filter(v => v.type === "complete").length, 1);
    assert.deepEqual(read(f).sessions[0].turns[0].items.map(v => v.text), ["visible"]);
    assert.deepEqual(f.host.getCachedAuthenticationState(), { status: "authenticated" });
  } finally { await f.close(); }
});

test("ACP invalid update reports a fixed error before retiring and preserves unknown execution", async () => {
  const diagnostics = [], stoppedAtDiagnostic = [], canary = "PRIVATE_INVALID_UPDATE_/sensitive/prompt"; let f;
  f = await fixture({ onDiagnostic(value) { diagnostics.push(value); stoppedAtDiagnostic.push(f.stopped()); }, prompt(params, emit) {
    emit(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: { private: canary } } });
    return { stopReason: "end_turn" };
  } });
  try {
    const id = await session(f);
    await assert.rejects(turn(f, id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN", dispatchState: "write_attempted" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(diagnostics, [{ stage: "acp_invalid_update", code: "ACP_UPDATE_INVALID", outcome: "error", count: 1 }]);
    assert.deepEqual(stoppedAtDiagnostic, [false], "the invalid diagnostic is recorded before the original retirement");
    assert.equal(JSON.stringify(diagnostics).includes(canary), false); assert.equal(f.stopped(), true);
    const receipt = read(f).sessions[0].turns[0];
    assert.equal(receipt.facts.unknown, true); assert.equal(receipt.facts.terminal, false); assert.equal(receipt.facts.remoteAccepted, false);
    assert.equal(f.events.some(v => v.type === "complete"), false);
    assert.deepEqual(f.host.getCachedAuthenticationState(), { status: "unverified" });
  } finally { await f.close(); }
});

for (const failure of ["throw", "reject"]) test(`ACP diagnostic callback ${failure} cannot change ignored or invalid update execution`, async () => {
  for (const invalid of [false, true]) {
    const diagnostics = [], canary = "PRIVATE_CALLBACK_FAILURE";
    const f = await fixture({ onDiagnostic(value) {
      diagnostics.push(value);
      if (failure === "throw") throw Error(canary);
      return Promise.reject(Error(canary));
    }, prompt(params, emit) {
      emit(params.sessionId, invalid
        ? { sessionUpdate: "plan", entries: [{ content: canary, priority: "unsafe", status: "pending" }] }
        : { sessionUpdate: "x-" + canary, body: canary });
      return { stopReason: "end_turn" };
    } });
    try {
      const id = await session(f);
      if (invalid) await assert.rejects(turn(f, id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN", dispatchState: "write_attempted" });
      else assert.equal((await turn(f, id)).execution.terminal, true);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(diagnostics, [{ stage: invalid ? "acp_invalid_update" : "acp_update_ignored",
        code: invalid ? "ACP_UPDATE_INVALID" : "ACP_UPDATE_IGNORED", outcome: invalid ? "error" : "unknown", count: 1 }]);
      assert.equal(f.stopped(), invalid); assert.equal(JSON.stringify(diagnostics).includes(canary), false);
      const receipt = read(f).sessions[0].turns[0];
      assert.equal(receipt.facts.unknown, invalid); assert.equal(receipt.facts.terminal, !invalid);
      assert.equal(f.events.filter(v => v.type === "complete").length, invalid ? 0 : 1);
      assert.deepEqual(f.host.getCachedAuthenticationState(), { status: invalid ? "unverified" : "authenticated" });
    } finally { await f.close(); }
  }
});
