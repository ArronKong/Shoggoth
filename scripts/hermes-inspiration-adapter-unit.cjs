#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const { HermesInspirationAdapter } = require("../app/core/hermes-inspiration-adapter");
const { HermesBackend } = require("../app/core/hermes-backend");
const { validInspirationAttention } = require("../app/agent-service/inspiration-service-protocol");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const agentId = "hermes-fixture";

function fakeBackend(mode = "gateway") {
  const backend = {
    _lifecycleGeneration: 1,
    sessionWorkspaceByKey: new Map(), freshSessionTransports: new Map(),
    gwRuntimeByKey: new Map(), gwKeyByRuntime: new Map(), gwTurns: new Map(),
    gwSockets: new Map(), dash: { baseUrl: "http://fixture.invalid", token: "fake" },
    acpSessionByKey: new Map(), acpClients: new Map(),
    calls: [], activeRows: [], pending: new Map(),
    async createSession(id, options) {
      this.calls.push(["create", id, options]);
      const sessionKey = `agent:${id}:session-${this.sessionWorkspaceByKey.size + 1}`;
      this.sessionWorkspaceByKey.set(sessionKey, options.workspace || "/fixture/actual-workspace");
      this.freshSessionTransports.set(sessionKey, mode);
      return sessionKey;
    },
    sendMessage(sessionKey, prompt, runId, hooks) {
      this.calls.push(["send", sessionKey, prompt, runId]);
      const runtimeId = `runtime-${runId}`;
      if (mode === "gateway") {
        this.gwRuntimeByKey.set(sessionKey, { runtimeId, profile: "fixture" });
        this.gwTurns.set(runtimeId, { sessionKey, hooks });
      } else {
        this.acpSessionByKey.set(sessionKey, { profile: "fixture", acpSessionId: sessionKey });
        this.acpClients.set("fixture", { updateHandlers: new Map([[sessionKey, hooks]]) });
      }
      return new Promise((resolve, reject) => this.pending.set(sessionKey, { hooks, resolve, reject }));
    },
    async respondChatPrompt(sessionKey, data) {
      this.calls.push(["respond", sessionKey, data]);
      return { resolved: true };
    },
    async abortChat(sessionKey) {
      this.calls.push(["abort", sessionKey]);
      if (this.abortCompletion) this.finish(sessionKey, this.abortCompletion);
    },
    finish(sessionKey, completion = {}) {
      const pending = this.pending.get(sessionKey);
      pending.hooks.final(completion.text || "fixture-result", completion.errored || false,
        completion.meta || {});
      this.gwTurns.delete(this.gwRuntimeByKey.get(sessionKey)?.runtimeId);
      this.acpClients.get("fixture")?.updateHandlers.delete(sessionKey);
      pending.resolve();
    },
    _sessionTarget(sessionKey) {
      return { profile: "fixture", dash: this.dash, tail: sessionKey.split(":").slice(2).join(":") };
    },
    _gwSocket() {
      if (this.gwSockets.has("fixture")) return this.gwSockets.get("fixture");
      const socket = { generation: 1, request: async (method, params) => {
        this.calls.push([method, params]);
        if (method === "session.active_list") return { sessions: structuredClone(this.activeRows), ...this.listFlags };
        if (method === "session.interrupt") {
          if (this.interruptStops) this.activeRows = this.activeRows.map((row) => ({ ...row, status: "idle" }));
          return { status: "interrupted" };
        }
        throw new Error(`unexpected ${method}`);
      } };
      this.gwSockets.set("fixture", socket);
      return socket;
    },
  };
  return backend;
}

async function running(mode = "gateway") {
  const backend = fakeBackend(mode);
  const adapter = new HermesInspirationAdapter({ backend, now: () => 900 });
  const prepared = await adapter.prepare({ agentId, sessionId: "intent-1", workspace: null });
  const input = { ...prepared, agentId, runId: "run-1", prompt: "fixture prompt" };
  const snapshots = [];
  const started = adapter.start(input, (value) => snapshots.push(value));
  assert.equal(started.status, "starting");
  await tick();
  return { backend, adapter, input, snapshots, hooks: backend.pending.get(input.sessionKey).hooks };
}

test("prepare freezes the actual workspace and deduplicates the caller identity", async () => {
  const backend = fakeBackend();
  const adapter = new HermesInspirationAdapter({ backend });
  const input = { agentId, sessionId: "intent-1", workspace: null };
  const [first, second] = await Promise.all([adapter.prepare(input), adapter.prepare(input)]);
  assert.deepEqual(first, second);
  assert.equal(first.workspace, "/fixture/actual-workspace");
  assert.equal(backend.calls.length, 1);
  assert.deepEqual(backend.calls[0][2], { workspace: null, freezeWorkspace: true });
  await assert.rejects(adapter.prepare({ ...input, workspace: "/other" }), /CONFLICT/);
});

test("prepare refuses ignored workspace overrides without dispatching a model", async () => {
  const backend = fakeBackend();
  const original = backend.createSession.bind(backend);
  backend.createSession = (id) => original(id, {});
  const adapter = new HermesInspirationAdapter({ backend });
  await assert.rejects(adapter.prepare({ agentId, sessionId: "intent", workspace: "/wanted" }), /WORKSPACE_UNCONFIRMED/);
  await assert.rejects(adapter.prepare({ agentId, sessionId: "intent", workspace: "/wanted" }), /WORKSPACE_UNCONFIRMED/);
  assert.equal(backend.calls.length, 1);
});

test("start uses the stable run ID once and publishes only its own terminal", async () => {
  const { adapter, backend, input, hooks } = await running();
  hooks.delta("partial");
  adapter.start(input);
  assert.equal(backend.calls.filter((call) => call[0] === "send").length, 1);
  assert.equal(backend.calls.find((call) => call[0] === "send")[3], input.runId);
  assert.throws(() => adapter.start({ ...input, prompt: "different" }), /CONFLICT/);
  assert.throws(() => adapter.start({ ...input, runId: "run-2" }), /CONFLICT/);
  backend.finish(input.sessionKey, { text: "done" });
  await tick();
  const result = await adapter.inspect(input);
  assert.equal(result.status, "completed");
  assert.equal(result.resultSummary, "done");
  result.resultSummary = "mutated";
  assert.equal((await adapter.inspect(input)).resultSummary, "done");
});

test("restart and unknown run IDs never infer success from history or resume", async () => {
  const { adapter, backend, input } = await running();
  backend.getHistory = () => { throw new Error("must not read unrelated history"); };
  assert.equal((await adapter.inspect({ ...input, hostChanged: true })).status, "unknown");
  assert.equal((await adapter.inspect({ ...input, runId: "unknown" })).status, "unknown");
  backend._lifecycleGeneration += 1;
  assert.equal((await adapter.inspect(input)).status, "unknown");
  assert.equal(backend.calls.some((call) => call[0] === "session.resume"), false);
});

test("prepare continues an existing session only after identity and workspace verification", async () => {
  const { adapter, backend, input } = await running();
  backend.finish(input.sessionKey);
  await tick();
  backend._httpGetJson = async () => ({ status: 200,
    json: { id: "session-1", profile: "fixture", cwd: input.workspace } });
  backend.activeRows = [{ id: "runtime-run-1", session_key: "session-1", status: "idle" }];
  const prepared = await adapter.prepare({ agentId, sessionId: "followup-intent",
    sessionKey: input.sessionKey, workspace: input.workspace });
  assert.equal(prepared.sessionKey, input.sessionKey);
  assert.equal(backend.calls.filter((call) => call[0] === "create").length, 1);
  assert.equal(backend.calls.some((call) => call[0] === "session.resume"), false);
  adapter.start({ ...input, runId: "followup-run", prompt: "continue" });
  await tick();
  assert.equal(backend.calls.filter((call) => call[0] === "send").length, 2);
  assert.equal((await adapter.cancel(input)).status, "completed");
  assert.equal(backend.calls.some((call) => call[0] === "abort"), false);
});

test("existing session prepare never creates a replacement for wrong or busy targets", async () => {
  for (const mismatch of ["workspace", "profile", "busy"]) {
    const backend = fakeBackend();
    backend._gatewayChatEnabled = () => true;
    backend._httpGetJson = async () => ({ status: 200,
      json: { id: "stored", profile: mismatch === "profile" ? "wrong" : "fixture",
        cwd: mismatch === "workspace" ? "/wrong" : "/expected" } });
    backend.activeRows = mismatch === "busy" ? [{ id: "runtime", session_key: "stored", status: "working" }] : [];
    const adapter = new HermesInspirationAdapter({ backend });
    await assert.rejects(adapter.prepare({ agentId, sessionId: "intent", sessionKey: `agent:${agentId}:stored`,
      workspace: "/expected" }), /MISMATCH|UNCONFIRMED/);
    assert.equal(backend.calls.some((call) => ["create", "session.resume"].includes(call[0])), false);
  }
});

test("cold host restores only a uniquely idle live runtime before explicit submission", async () => {
  const calls = [];
  let backend;
  backend = actualBackend("gateway", async (method, params) => {
    calls.push([method, params]);
    if (method === "session.active_list") return { sessions: [
      { id: "runtime", session_key: "stored", status: "idle" },
    ] };
    if (method === "prompt.submit") {
      const turn = backend.gwTurns.get("runtime");
      assert.equal(turn.requiredTransport, "gateway");
      backend._gwComplete(key, "runtime", turn, { status: "complete", text: "explicit new result" });
      return { status: "streaming" };
    }
    throw new Error(`MUST NOT CALL ${method}`);
  });
  backend._httpGetJson = async () => ({ status: 200,
    json: { id: "stored", profile: "fixture", cwd: "/expected" } });
  const adapter = new HermesInspirationAdapter({ backend });
  const key = `agent:${agentId}:stored`;
  const prepared = await adapter.prepare({ agentId, sessionId: "explicit-followup", sessionKey: key, workspace: "/expected" });
  assert.deepEqual(calls.map(([method]) => method), ["session.active_list"]);
  assert.deepEqual(backend.gwRuntimeByKey.get(key), { profile: "fixture", runtimeId: "runtime", storedId: "stored", generation: 1 });
  assert.equal(backend.gwKeyByRuntime.get("runtime"), key);
  assert.equal(backend.transcripts.has(key), false);
  const input = { ...prepared, agentId, runId: "explicit-run", prompt: "explicit new prompt" };
  adapter.start(input);
  await tick();
  assert.deepEqual(calls.map(([method]) => method), ["session.active_list", "prompt.submit"]);
  assert.equal(calls[1][1].session_id, "runtime");
  assert.equal(calls[1][1].text, input.prompt);
  assert.equal((await adapter.inspect(input)).status, "completed");
});

test("existing preparation rejects malformed HTTP or ambiguous live evidence without repairing maps", async () => {
  for (const invalid of ["http", "json", "naked", "id", "missing", "duplicate", "runtime-collision", "busy", "partial", "local-owner", "local-turn", "local-other-runtime", "generation"]) {
    const backend = actualBackend("gateway", async () => {
      if (invalid === "generation") backend._lifecycleGeneration += 1;
      const row = { id: "runtime", session_key: "stored", status: invalid === "busy" ? "working" : "idle" };
      return { sessions: invalid === "missing" ? [] : invalid === "duplicate" ? [row, { ...row, id: "other" }]
        : invalid === "runtime-collision" ? [row, { ...row, session_key: "other" }] : [row],
      truncated: invalid === "partial" };
    });
    const json = { id: invalid === "id" ? "other" : "stored", profile: "fixture", cwd: "/expected" };
    backend._httpGetJson = async () => invalid === "naked" ? json
      : { status: invalid === "http" ? 404 : 200, json: invalid === "json" ? null : json };
    if (invalid === "local-owner") backend.gwKeyByRuntime.set("runtime", "agent:hermes-other:stored");
    if (invalid === "local-turn") backend.gwTurns.set("runtime", {});
    if (invalid === "local-other-runtime") backend.gwTurns.set("old-runtime", { sessionKey: `agent:${agentId}:stored` });
    const before = [...backend.gwKeyByRuntime];
    const adapter = new HermesInspirationAdapter({ backend });
    await assert.rejects(adapter.prepare({ agentId, sessionId: "followup", sessionKey: `agent:${agentId}:stored`,
      workspace: "/expected" }), /MISMATCH|UNCONFIRMED/);
    assert.equal(backend.gwRuntimeByKey.size, 0, invalid);
    assert.deepEqual([...backend.gwKeyByRuntime], before, invalid);
    assert.equal(backend.sessionWorkspaceByKey.size, 0, invalid);
  }
});

function coldRestoreFixture() {
  const key = `agent:${agentId}:stored`;
  const f = { key, calls: [], rpc: {}, activeRows: [],
    row: { id: "stored", profile: "fixture", cwd: "/expected", parent_session_id: null,
      source: "desktop", ended_at: 100, end_reason: "ws_orphan_reap", model_config: null,
      model: "fixture-model", billing_provider: "fixture-provider", message_count: 2 },
    server: { version: "0.21.0", release_date: "2026.8.31" },
    model: { model: "fixture-model", provider: "fixture-provider" },
    capabilities: { per_session_exclusive_submit: true },
    history: { session_id: "stored", messages: [
      { id: 1, session_id: "stored", role: "user", active: 1, compacted: 0, tool_calls: null },
      { id: 2, session_id: "stored", role: "assistant", active: 1, compacted: 0,
        tool_calls: null, finish_reason: "stop" },
    ], pagination: { limit: 500, offset: 0, order: "oldest", returned: 2 } },
    restored: { session_id: "runtime", resumed: "stored", session_key: "stored",
      info: { profile_name: "fixture", cwd: "/expected", lazy: true, model: "fixture-model" },
      status: "idle", running: false, inflight: null, messages_omitted: true, messages: [], message_count: 2 },
  };
  const backend = actualBackend("gateway", async (method, params) => {
    f.calls.push([method, structuredClone(params)]);
    if (f.rpc[method]) return f.rpc[method](params);
    if (method === "session.active_list") return { sessions: structuredClone(f.activeRows) };
    if (method === "gateway.capabilities") return structuredClone(f.capabilities);
    if (method === "session.resume") {
      assert.deepEqual(params, { session_id: "stored", profile: "fixture", lazy: true,
        omit_messages: true, source: "desktop" });
      f.activeRows = [{ id: "runtime", session_key: "stored", status: "idle" }];
      return structuredClone(f.restored);
    }
    if (method === "prompt.submit") {
      assert.equal(params.session_id, "runtime");
      const turn = backend.gwTurns.get("runtime");
      backend._gwComplete(key, "runtime", turn, { status: "complete", text: "new explicit result" });
      return { status: "streaming" };
    }
    throw new Error(`unexpected RPC ${method}`);
  });
  backend._httpGetJson = async (url) => {
    const target = new URL(url);
    assert.equal(target.searchParams.get("profile"), "fixture");
    f.calls.push(["GET", target.pathname]);
    const value = { "/api/sessions/stored": f.row, "/api/status": f.server,
      "/api/model/info": f.model, "/api/sessions/stored/messages": f.history }[target.pathname];
    if (!value) throw new Error(`unexpected GET ${url}`);
    return { status: 200, json: structuredClone(value) };
  };
  f.backend = backend;
  f.adapter = new HermesInspirationAdapter({ backend });
  f.input = { agentId, sessionId: "explicit-intent", sessionKey: key, workspace: "/expected" };
  return f;
}

test("ws_orphan_reap cold load uses audited lazy resume then one explicit new prompt", async () => {
  const f = coldRestoreFixture();
  const before = await f.adapter.inspect({ agentId, sessionKey: f.key, runId: "old-run", mode: "gateway", hostChanged: true });
  assert.equal(before.status, "unknown");
  assert.equal(f.calls.length, 0);
  const prepared = await f.adapter.prepare(f.input);
  assert.deepEqual(await f.adapter.prepare(f.input), prepared);
  assert.equal(f.calls.filter(([method]) => method === "session.resume").length, 1);
  assert.deepEqual(f.calls.filter(([method]) => method !== "GET").map(([method]) => method),
    ["session.active_list", "gateway.capabilities", "session.active_list", "session.resume", "session.active_list"]);
  assert.equal(f.calls.some(([method]) => method === "prompt.submit"), false);
  assert.equal(f.backend.transcripts.has(f.key), false);
  const input = { ...prepared, agentId, runId: "new-run", prompt: "new explicit prompt" };
  f.adapter.start(input);
  f.adapter.start(input);
  await tick();
  assert.equal(f.calls.filter(([method]) => method === "prompt.submit").length, 1);
  assert.equal(f.calls.at(-1)[1].text, "new explicit prompt");
  assert.equal((await f.adapter.inspect(input)).resultSummary, "new explicit result");
});

test("cold resume refuses unsupported releases, defaults and incomplete histories before any mutation", async () => {
  const changes = {
    oldVersion: f => { f.server.version = "0.20.0"; },
    newerUnknownVersion: f => { f.server.version = "0.21.1"; },
    wrongRelease: f => { f.server.release_date = "2026.8.30"; },
    noCapability: f => { f.capabilities = {}; },
    ancestor: f => { f.row.parent_session_id = "parent"; },
    unconfirmedEnd: f => { f.row.end_reason = "crashed"; },
    changedModel: f => { f.model.model = "other-model"; },
    changedProvider: f => { f.model.provider = "other-provider"; },
    storedOverride: f => { f.row.model_config = JSON.stringify({ reasoning_config: { effort: "high" } }); },
    redirectedHistory: f => { f.history.session_id = "descendant"; },
    wrongMessageOwner: f => { f.history.messages[0].session_id = "other"; },
    missingHistory: f => { f.row.message_count = 3; },
    oversizedHistory: f => { f.row.message_count = 501; },
    wrongPage: f => { f.history.pagination.order = "latest"; },
    duplicateId: f => { f.history.messages[1].id = 1; },
    compacted: f => { f.history.messages[0].compacted = 1; },
    inactive: f => { f.history.messages[0].active = 0; },
    synthesized: f => { f.history.messages[0].display_kind = "auto_continue"; },
    incompleteFinal: f => { f.history.messages[1].finish_reason = null; },
    danglingTool: f => { f.history.messages[1].tool_calls = [{ id: "missing-result" }]; },
    strayTool: f => { f.history.messages[1].role = "tool"; f.history.messages[1].tool_call_id = "orphan"; },
    localTurn: f => { f.backend.gwTurns.set("old-runtime", { sessionKey: f.key }); },
    wrongLocalBinding: f => { f.backend.gwRuntimeByKey.set(f.key, { profile: "other", storedId: "stored" }); },
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = coldRestoreFixture();
    change(f);
    await assert.rejects(f.adapter.prepare(f.input), /UNCONFIRMED/, name);
    assert.equal(f.calls.some(([method]) => ["session.resume", "prompt.submit"].includes(method)), false, name);
    assert.equal(f.backend.gwRuntimeByKey.size, name === "wrongLocalBinding" ? 1 : 0, name);
  }
});

test("cold restore refuses lost ACK, redirected identities, busy races and changed transport", async () => {
  const changes = {
    lostAck: f => { f.rpc["session.resume"] = async () => { throw new Error("ACK lost"); }; },
    wrongId: f => { f.restored.resumed = "other"; },
    wrongKey: f => { f.restored.session_key = "other"; },
    wrongProfile: f => { f.restored.info.profile_name = "other"; },
    wrongWorkspace: f => { f.restored.info.cwd = "/other"; },
    wrongModel: f => { f.restored.info.model = "other"; },
    builtAgent: f => { f.restored.info.lazy = false; },
    autoContinue: f => { f.restored.auto_continue = { attempt: 1 }; },
    busyAck: f => { f.restored.running = true; f.restored.status = "streaming"; },
    inflight: f => { f.restored.inflight = {}; },
    wrongCount: f => { f.restored.message_count = 3; },
    duplicateRuntime: f => { f.rpc["session.active_list"] = async () => ({ sessions: f.calls.some(([method]) => method === "session.resume")
      ? [{ id: "runtime", session_key: "stored", status: "idle" }, { id: "duplicate", session_key: "stored", status: "idle" }] : [] }); },
    busyAfter: f => { f.rpc["session.active_list"] = async () => ({ sessions: f.calls.some(([method]) => method === "session.resume")
      ? [{ id: "runtime", session_key: "stored", status: "working" }] : [] }); },
    racedBefore: f => { let count = 0; f.rpc["session.active_list"] = async () => ({ sessions: ++count > 1
      ? [{ id: "competitor", session_key: "stored", status: "working" }] : [] }); },
    generationChanged: f => { f.rpc["session.resume"] = async () => { f.backend._lifecycleGeneration++; return f.restored; }; },
    socketChanged: f => { f.rpc["session.resume"] = async () => { f.backend.gwSockets.set("fixture", { generation: 1 }); return f.restored; }; },
    reconnected: f => { f.rpc["session.resume"] = async () => { f.backend.gwSockets.get("fixture").generation++; return f.restored; }; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = coldRestoreFixture();
    change(f);
    await assert.rejects(f.adapter.prepare(f.input), /UNCONFIRMED|ACK lost/, name);
    const calls = f.calls.length;
    await assert.rejects(f.adapter.prepare(f.input), /UNCONFIRMED|ACK lost/, name);
    assert.equal(f.calls.length, calls, `ambiguous preparation must not replay: ${name}`);
    assert.equal(f.calls.some(([method]) => method === "prompt.submit"), false, name);
    assert.equal(f.backend.gwRuntimeByKey.size, 0, name);
    assert.equal(f.backend.gwKeyByRuntime.size, 0, name);
  }
});

test("approval preserves choices, command and canonical run identity without wider grants", async () => {
  const { adapter, backend, input, hooks } = await running();
  hooks.prompt({ kind: "approval", command: "fixture command", description: "Permit this command?",
    choices: ["once", "deny"] });
  const current = await adapter.inspect(input);
  assert.equal(current.status, "waiting_approval");
  assert.equal(current.attention.request.runId, input.runId);
  assert.deepEqual(current.attention.request.approvalChoices, ["once", "deny", "cancel"]);
  assert.equal(current.attention.command, "fixture command");
  assert.equal(current.attention.occurredAt, 900);
  assert.equal(validInspirationAttention(current.attention, input.runId), true);
  const control = { ...input, requestId: current.attention.request.requestId };
  await assert.rejects(adapter.respond({ ...control, response: { choice: "session" } }), /INTERACTION_RESPONSE_INVALID/);
  await adapter.respond({ ...control, response: { choice: "once" } });
  assert.deepEqual(backend.calls.at(-1), ["respond", input.sessionKey,
    { kind: "approval", choice: "once", all: false }]);
  await assert.rejects(adapter.respond({ ...control, response: { choice: "once" } }), /STALE/);
});

test("incomplete approval detail cannot be approved", async () => {
  const { adapter, input, hooks } = await running();
  hooks.prompt({ kind: "approval", description: "hidden command", command: "x".repeat(8193), choices: ["once", "deny"] });
  const state = await adapter.inspect(input);
  assert.deepEqual(state.attention.request.approvalChoices, ["deny", "cancel"]);
  assert.equal(state.attention.command, null);
});

test("overlapping FIFO approvals cannot authorize a different displayed command", async () => {
  const { adapter, backend, input, hooks } = await running();
  hooks.prompt({ kind: "approval", command: "first command", choices: ["once", "deny"] });
  const requestId = (await adapter.inspect(input)).attention.request.requestId;
  hooks.prompt({ kind: "approval", command: "different command", choices: ["once", "deny"] });
  assert.equal((await adapter.inspect(input)).errorCode, "HERMES_INTERACTION_AMBIGUOUS");
  await assert.rejects(adapter.respond({ ...input, requestId, response: { choice: "once" } }), /STALE/);
  assert.equal(backend.calls.some((call) => call[0] === "respond"), false);
});

test("clarification responds to the exact upstream request and rejects expired cards", async () => {
  const { adapter, backend, input, hooks } = await running();
  hooks.prompt({ kind: "clarify", requestId: "upstream-1", question: "Choose", choices: ["A", "B"] });
  const first = (await adapter.inspect(input)).attention.request;
  await adapter.respond({ ...input, requestId: first.requestId, response: { action: "submit", answers: { answer: "B" } } });
  assert.deepEqual(backend.calls.at(-1), ["respond", input.sessionKey,
    { kind: "clarify", requestId: "upstream-1", value: "B" }]);
  hooks.prompt({ kind: "clarify", requestId: "upstream-2", question: "What next?" });
  const second = (await adapter.inspect(input)).attention.request;
  assert.notEqual(first.requestId, second.requestId);
  hooks.promptExpire({ requestId: "upstream-1" });
  assert.equal((await adapter.inspect(input)).status, "waiting_input");
  hooks.promptExpire({ requestId: "upstream-2" });
  await assert.rejects(adapter.respond({ ...input, requestId: second.requestId,
    response: { action: "submit", answers: { answer: "reply" } } }), /STALE/);
});

test("secret and sudo values are transient and absent from snapshot metadata", async () => {
  for (const kind of ["sudo", "secret"]) {
    const { adapter, backend, input, hooks, snapshots } = await running();
    hooks.prompt({ kind, requestId: "private-request", question: "private-prompt-marker" });
    const request = (await adapter.inspect(input)).attention.request;
    assert.equal(validInspirationAttention((await adapter.inspect(input)).attention, input.runId), true);
    assert.equal(request.fields[0].secret, true);
    assert.equal(JSON.stringify(snapshots).includes("private-prompt-marker"), false);
    await adapter.respond({ ...input, requestId: request.requestId,
      response: { action: "submit", answers: { answer: "transient-secret-marker" } } });
    assert.deepEqual(backend.calls.at(-1), ["respond", input.sessionKey,
      { kind, requestId: "private-request", value: "transient-secret-marker" }]);
    assert.equal(JSON.stringify(snapshots).includes("transient-secret-marker"), false);
    assert.equal(JSON.stringify(await adapter.inspect(input)).includes("transient-secret-marker"), false);
  }
});

test("a best-effort abort does not become canceled without terminal evidence", async () => {
  const { adapter, input } = await running();
  const result = await adapter.cancel(input);
  assert.notEqual(result.status, "canceled");
  assert.equal(result.errorCode, "HERMES_CANCELLATION_UNCONFIRMED");
});

test("cancel uses canceled metadata and preserves successful completion races", async () => {
  for (const [completion, expected] of [[{ meta: { stopReason: "cancelled" } }, "canceled"], [{ text: "finished first" }, "completed"]]) {
    const { adapter, backend, input } = await running();
    backend.abortCompletion = completion;
    assert.equal((await adapter.cancel(input)).status, expected);
  }
});

test("gateway compensation interrupts only exact bound sessions and confirms idle", async () => {
  const backend = fakeBackend();
  const adapter = new HermesInspirationAdapter({ backend });
  const input = { agentId, sessionKey: `agent:${agentId}:persisted-id`, runId: "persisted-run", mode: "gateway" };
  backend.activeRows = [{ id: "runtime-exact", session_key: "persisted-id", status: "working" },
    { id: "runtime-other", session_key: "other-session", status: "working" }];
  backend.interruptStops = true;
  const result = await adapter.cancel(input);
  assert.equal(result.status, "canceled");
  assert.deepEqual(backend.calls.find((call) => call[0] === "session.interrupt"),
    ["session.interrupt", { session_id: "runtime-exact" }]);
  assert.equal(backend.calls.some((call) => call[0] === "session.resume"), false);
});

test("partial or ambiguous active lists never prove cancellation", async () => {
  for (const ambiguous of [true, false]) {
    const backend = fakeBackend();
    const adapter = new HermesInspirationAdapter({ backend });
    const row = { id: "runtime", session_key: "stored", status: "working" };
    backend.activeRows = ambiguous ? [row, { ...row, id: "other-runtime" }] : [row];
    backend.listFlags = ambiguous ? {} : { truncated: true };
    backend.interruptStops = true;
    assert.equal((await adapter.cancel({ agentId, sessionKey: `agent:${agentId}:stored`, runId: "run", mode: "gateway" })).status, "unknown");
    assert.equal(backend.calls.some((call) => call[0] === "session.interrupt"), false);
  }
});

test("ACP reports unsupported reverse permissions and requires a real cancel terminal", async () => {
  const { adapter, backend, input, hooks } = await running("acp");
  hooks.prompt({ kind: "approval", command: "must-not-persist" });
  assert.equal((await adapter.inspect(input)).errorCode, "HERMES_ACP_INTERACTION_UNSUPPORTED");
  backend.abortCompletion = { meta: { stopReason: "cancelled" } };
  assert.equal((await adapter.cancel(input)).status, "canceled");
  assert.equal((await adapter.cancel({ ...input, runId: "lost-run" })).status, "unknown");
});

function actualBackend(mode, request) {
  const backend = new HermesBackend();
  backend.profileById.set(agentId, "fixture");
  backend.dashboards.set("fixture", { baseUrl: "http://fixture.invalid", token: "fake" });
  backend._gatewayChatEnabled = () => mode === "gateway";
  backend.gwSockets.set("fixture", { generation: 1, request });
  backend._gwSocket = () => backend.gwSockets.get("fixture");
  return backend;
}

test("real backend passes explicit workspace and freezes returned default with session-only RPC", async () => {
  for (const workspace of [null, "/fixture/selected"]) {
    const calls = [];
    const backend = actualBackend("gateway", async (method, params) => {
      calls.push([method, params]);
      if (method === "session.create") return { session_id: "runtime", stored_session_id: "stored",
        info: { cwd: workspace || "/fixture/default" } };
      if (method === "session.cwd.set") return { cwd: params.cwd };
      throw new Error("unexpected");
    });
    const key = await backend.createSession(agentId, { workspace, freezeWorkspace: true });
    assert.equal(backend.sessionWorkspaceByKey.get(key), workspace || "/fixture/default");
    assert.equal(calls[0][1].cwd, workspace || undefined);
    assert.equal(calls.some(([method]) => method === "session.cwd.set"), workspace === null);
    assert.equal(calls.some(([method]) => method === "config.set"), false);
  }
});

test("real backend rejects an ignored workspace before exposing its session", async () => {
  const calls = [];
  const backend = actualBackend("gateway", async (method) => {
    calls.push(method);
    return method === "session.create" ? { session_id: "runtime", stored_session_id: "stored",
      info: { cwd: "/different" } } : {};
  });
  await assert.rejects(backend.createSession(agentId, { workspace: "/wanted", freezeWorkspace: true }), /工作目录/);
  assert.equal(backend.freshSessionKeys.size, 0);
  assert.deepEqual(calls, ["session.create", "session.close"]);
});

test("real ACP creation uses the selected directory and exposes actual default cwd", async () => {
  for (const workspace of [null, os.tmpdir()]) {
    const backend = actualBackend("acp");
    const seen = [];
    backend._clientForProfile = () => ({ newSession: async (cwd) => { seen.push(cwd); return "fake-acp-id"; } });
    const key = await backend.createSession(agentId, { workspace, freezeWorkspace: true });
    assert.deepEqual(seen, [os.tmpdir()]);
    assert.equal(backend.sessionWorkspaceByKey.get(key), os.tmpdir());
    assert.equal(backend.freshSessionTransports.get(key), "acp");
  }
});

test("real backend cancellation terminals carry explicit stop reasons", async () => {
  const backend = actualBackend("gateway");
  const key = `agent:${agentId}:stored`;
  const finals = [];
  const turn = { hooks: { final: (...args) => finals.push(args) }, accumulated: "", resolve: () => {} };
  backend.transcripts.set(key, []);
  backend.gwTurns.set("runtime", turn);
  backend._gwComplete(key, "runtime", turn, { status: "interrupted", text: "stopped" });
  assert.equal(finals[0][2].stopReason, "cancelled");

  backend.acpSessionByKey.set(key, { profile: "fixture", acpSessionId: "fake-acp" });
  backend._clientForProfile = () => ({ prompt: async () => ({ stopReason: "cancelled" }) });
  await backend._sendViaAcp({ sessionKey: key, message: "fixture", profile: "fixture",
    generation: backend._lifecycleGeneration, assertCurrentGeneration: () => {}, transcript: [],
    atts: { pdfs: [], files: [], images: [] }, hooks: { final: (...args) => finals.push(args) } });
  assert.equal(finals[1][2].stopReason, "cancelled");
});

test("required gateway execution never falls back to ACP", async () => {
  const backend = actualBackend("gateway");
  backend._sendViaGateway = async () => { throw Object.assign(new Error("offline"), { code: "GW_UNAVAILABLE" }); };
  backend._sendViaAcp = async () => { throw new Error("ACP MUST NOT RUN"); };
  let error = null;
  await backend.sendMessage(`agent:${agentId}:stored`, "fixture", "required-mode-run",
    { error: (message) => { error = message; } }, { requiredTransport: "gateway" });
  assert.match(error, /网关/);
});

test("uncertain transport errors and rejected sends retain a busy unknown execution", async () => {
  for (const fail of [
    ({ hooks }) => hooks.error("observer timeout", { executionUncertain: true }),
    ({ hooks }) => hooks.final("connection dropped after submit", true, { executionUncertain: true }),
    ({ backend, input }) => backend.pending.get(input.sessionKey).reject(new Error("transport disconnected")),
  ]) {
    const f = await running();
    fail(f);
    await tick();
    assert.equal((await f.adapter.inspect(f.input)).status, "unknown");
    assert.throws(() => f.adapter.start({ ...f.input, runId: "next-run" }), /CONFLICT/);
    f.backend.activeRows = [{ id: "runtime-run-1", session_key: f.input.sessionKey.split(":").slice(2).join(":"), status: "working" }];
    f.backend.interruptStops = true;
    assert.equal((await f.adapter.cancel(f.input)).status, "canceled");
    assert.equal((await f.adapter.inspect(f.input)).status, "canceled");
  }
  const confirmed = await running();
  confirmed.hooks.error("confirmed model failure");
  assert.equal((await confirmed.adapter.inspect(confirmed.input)).status, "failed");
});

test("required gateway submission loss is uncertain and never silently resumes/retries", async () => {
  for (const jsonRpc of [false, true]) {
    const calls = [], finals = [];
    const backend = actualBackend("gateway", async (method) => {
      calls.push(method);
      throw Object.assign(new Error(jsonRpc ? "session not found" : "connection dropped"), { jsonRpc });
    });
    const key = `agent:${agentId}:stored`;
    backend.gwRuntimeByKey.set(key, { profile: "fixture", runtimeId: "runtime", storedId: "stored", generation: 1 });
    await backend._sendViaGateway({ sessionKey: key, message: "fixture", profile: "fixture", requiredTransport: "gateway",
      hooks: { final: (...args) => finals.push(args) }, atts: { images: [], pdfs: [], files: [] },
      transcript: [], assertCurrentGeneration: () => {} });
    assert.deepEqual(calls, ["prompt.submit"]);
    assert.equal(finals[0][2].executionUncertain, true);
    assert.equal(backend.gwTurns.size, 0);
  }
  const calls = [], errors = [];
  const backend = actualBackend("gateway", async method => { calls.push(method); throw new Error("MUST NOT RESUME"); });
  await backend._sendViaGateway({ sessionKey: `agent:${agentId}:stored`, message: "fixture", profile: "fixture",
    requiredTransport: "gateway", hooks: { error: (...args) => errors.push(args) },
    atts: { images: [], pdfs: [], files: [] }, transcript: [], assertCurrentGeneration: () => {} });
  assert.deepEqual(calls, []);
  assert.equal(errors[0][1].executionUncertain, true);
});

test("inspiration ignores pre-ack events unless submit confirms a new streaming turn", async () => {
  for (const acknowledgement of [{ status: "queued" }, { status: "steered" }, { status: "redirected" }, { voice_stopped: true }, {}]) {
    const calls = [], finals = [], errors = [], prompts = [];
    let backend;
    const key = `agent:${agentId}:stored`;
    backend = actualBackend("gateway", async (method) => {
      calls.push(method);
      const turn = backend.gwTurns.get("runtime");
      turn.hooks.prompt({ kind: "approval", command: "other-turn-command" });
      backend._gwComplete(key, "runtime", turn, { status: "complete", text: "other-turn-result" });
      assert.equal(finals.length, 0);
      assert.equal(prompts.length, 0);
      return acknowledgement;
    });
    backend.gwRuntimeByKey.set(key, { profile: "fixture", runtimeId: "runtime", storedId: "stored", generation: 1 });
    backend.transcripts.set(key, []);
    await backend._sendViaGateway({ sessionKey: key, message: "fixture", profile: "fixture", requiredTransport: "gateway",
      hooks: { final: (...args) => finals.push(args), error: (...args) => errors.push(args), prompt: (...args) => prompts.push(args) },
      atts: { images: [], pdfs: [], files: [] }, transcript: [], assertCurrentGeneration: () => {} });
    assert.deepEqual(calls, ["prompt.submit"]);
    assert.equal(finals.length, 0);
    assert.equal(prompts.length, 0);
    assert.equal(errors[0][1].executionUncertain, true);
    assert.equal(backend.gwTurns.size, 0);
  }
});

test("a lost submit acknowledgement cannot commit an early terminal as success", async () => {
  const finals = [];
  let backend;
  const key = `agent:${agentId}:stored`;
  backend = actualBackend("gateway", async () => {
    const turn = backend.gwTurns.get("runtime");
    backend._gwComplete(key, "runtime", turn, { status: "complete", text: "unconfirmed-result" });
    throw new Error("acknowledgement lost");
  });
  backend.gwRuntimeByKey.set(key, { profile: "fixture", runtimeId: "runtime", storedId: "stored", generation: 1 });
  backend.transcripts.set(key, []);
  await backend._sendViaGateway({ sessionKey: key, message: "fixture", profile: "fixture", requiredTransport: "gateway",
    hooks: { final: (...args) => finals.push(args) }, atts: { images: [], pdfs: [], files: [] }, transcript: [], assertCurrentGeneration: () => {} });
  assert.equal(finals.length, 1);
  assert.equal(finals[0][1], true);
  assert.equal(finals[0][2].executionUncertain, true);
});

test("inspiration reconnect ends observation as unknown without any session resume", async () => {
  const calls = [], errors = [];
  let backend;
  backend = actualBackend("gateway", async method => {
    calls.push(method);
    setImmediate(() => backend._onGwReconnect("fixture"));
    return { status: "streaming" };
  });
  const key = `agent:${agentId}:stored`;
  backend.gwRuntimeByKey.set(key, { profile: "fixture", runtimeId: "runtime", storedId: "stored", generation: 1 });
  await backend._sendViaGateway({ sessionKey: key, message: "fixture", profile: "fixture", requiredTransport: "gateway",
    hooks: { error: (...args) => errors.push(args) }, atts: { images: [], pdfs: [], files: [] }, transcript: [], assertCurrentGeneration: () => {} });
  assert.deepEqual(calls, ["prompt.submit"]);
  assert.equal(errors[0][1].executionUncertain, true);
  assert.equal(backend.gwTurns.size, 0);
});

test("ACP prompt rejection reports uncertainty rather than a confirmed execution failure", async () => {
  const backend = actualBackend("acp");
  const key = `agent:${agentId}:stored`, finals = [];
  backend.acpSessionByKey.set(key, { profile: "fixture", acpSessionId: "fake-acp" });
  backend._clientForProfile = () => ({ prompt: async () => { throw new Error("channel lost after submission"); } });
  await backend._sendViaAcp({ sessionKey: key, message: "fixture", profile: "fixture",
    generation: backend._lifecycleGeneration, assertCurrentGeneration: () => {}, transcript: [],
    atts: { images: [], pdfs: [], files: [] }, hooks: { final: (...args) => finals.push(args) } });
  assert.equal(finals[0][2].executionUncertain, true);
});

test("gateway observation timeout carries uncertainty even after successful submission", async () => {
  const calls = [], errors = [];
  const backend = actualBackend("gateway", async method => { calls.push(method); return { status: "streaming" }; });
  const key = `agent:${agentId}:stored`;
  backend.gwRuntimeByKey.set(key, { profile: "fixture", runtimeId: "runtime", storedId: "stored", generation: 1 });
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 30 * 60_000 ? 0 : delay, ...args);
  try {
    await backend._sendViaGateway({ sessionKey: key, message: "fixture", profile: "fixture", requiredTransport: "gateway",
      hooks: { error: (...args) => errors.push(args) }, atts: { images: [], pdfs: [], files: [] },
      transcript: [], assertCurrentGeneration: () => {} });
  } finally { globalThis.setTimeout = originalTimeout; }
  assert.deepEqual(calls, ["prompt.submit"]);
  assert.equal(errors[0][1].executionUncertain, true);
  assert.equal(backend.gwTurns.size, 0);
});

test("summary truncation respects the public JSON byte limit", async () => {
  const { adapter, backend, input } = await running();
  backend.finish(input.sessionKey, { text: "内容🙂\n".repeat(8000) });
  const state = await adapter.inspect(input);
  assert.ok(state.resultSummary.length > 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(state.resultSummary)) <= 16 * 1024);
  assert.equal(state.resultSummary.isWellFormed(), true);
});

(async () => {
  for (const [index, { name, fn }] of tests.entries()) {
    await fn();
    console.log(`ok ${index + 1} - ${name}`);
  }
  console.log(`${tests.length} Hermes inspiration adapter checks passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
