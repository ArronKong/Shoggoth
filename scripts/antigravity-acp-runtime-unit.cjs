"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const {
  AntigravityAcpRuntimeHost,
  acpToolArguments,
  acpToolName,
  classifyAntigravityFailure,
  modelCatalogFromConfig,
} = require("../app/agent-service/antigravity-acp-runtime-host");
const { AntigravityRuntimeAdapter } = require("../app/agent-service/antigravity-runtime-adapter");
const {
  antigravityUsedOnThisMac,
  prepareAntigravityKeychainContext,
  prepareAntigravityKeychainContextAsync,
  prepareAntigravityRuntimeAccountHome,
} = require("../app/agent-service/antigravity-runtime-paths");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");
const { DatabaseSync } = require("node:sqlite");
const { AntigravityNativeToolResults, nativeToolCall } = require("../app/agent-service/antigravity-native-tool-results");

test("approval retains a full long command and its execution directory; undisplayable commands never reach approval", async () => {
  const calls = [], active = { sessionId: "permission-session", turnId: "permission-turn", accepted: true,
    dispatchState: "write_attempted", readOnly: false, acpMode: "auto_edit" };
  const host = Object.assign(Object.create(AntigravityAcpRuntimeHost.prototype), {
    activeTurns: new Map([[active.sessionId, active]]), registeredSecrets: [], _acceptTurn() {}, _hostCwd: () => "/root",
    rpc: { pauseRequestTimeout: () => () => {} }, serverRequestHandlers: new Map([
      ["item/commandExecution/requestApproval", async params => { calls.push(params); return { decision: "decline" }; }],
    ]),
  });
  const command = "printf '" + "x".repeat(20 * 1024) + "'";
  const request = { sessionId: active.sessionId, options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
    toolCall: { toolCallId: "long-command", title: "Run run_command?", kind: "execute",
      rawInput: { CommandLine: command, Cwd: "/workspace/actual-subdir" } } };
  await host._handlePermissionRequest(request);
  assert.equal(calls[0].command, command);
  assert.equal(calls[0].cwd, "/workspace/actual-subdir");
  assert.equal(calls[0].toolInput.command, undefined, "do not duplicate the full command into a small input preview");
  const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");
  const interaction = normalizeInteractiveRequestV1({ runId: "run-one", eventType: "approval", payload: {
    ...calls[0], requestId: "request-one", method: "item/commandExecution/requestApproval", kind: "command",
  } });
  assert.equal(interaction.approvalDetails.command, command);
  request.toolCall.rawInput.CommandLine = "x".repeat(24 * 1024 + 1);
  await assert.rejects(host._handlePermissionRequest(request), { code: "ANTIGRAVITY_APPROVAL_COMMAND_TOO_LARGE" });
  assert.equal(calls.length, 1);
});

test("native command result exit codes are strict, scoped and preserve earlier failures", () => {
  const events = [], active = { sessionId: "session-fixture", turnId: "turn-fixture", toolCalls: new Map(), completedToolCalls: new Set() };
  const host = Object.assign(Object.create(AntigravityAcpRuntimeHost.prototype), { registeredSecrets: [], _publish: e => events.push(e) });
  const output = code => ({ commandLine: "python3 test_shipment.py", workingDir: "/fixture", exitCode: code, exit_code: code,
    combinedOutput: "native command output", formatted_output: "same output" });
  const publish = (rawOutput, extra = {}) => {
    const id = "command-" + events.length;
    host._publishToolUpdate(active, { toolCallId: id, kind: "execute", status: "completed", rawOutput, ...extra });
    return events.at(-1);
  };
  for (const code of [0, 1, 2, -1]) {
    const event = publish(output(code));
    assert.equal(event.tool.exitCode, code);
    assert.equal(event.tool.status, code === 0 ? "completed" : "failed");
    assert.equal(event.tool.success, code === 0);
    assert.deepEqual(event.contextTool.output, output(code));
  }
  for (const code of [false, true, "1", null, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const event = publish(output(code)); assert.equal(event.tool.exitCode, undefined); assert.equal(event.tool.status, "completed");
  }
  for (const raw of [{ exitCode: 1 }, { ...output(0), exit_code: 1 }, { ...output(0), exit_code: "0" },
    { ...output(1), workingDir: "relative" }, { ...output(1), commandLine: "" },
    { ...output(1), combinedOutput: 1, formatted_output: false }]) {
    const event = publish(raw); assert.equal(event.tool.exitCode, undefined); assert.equal(event.tool.status, "completed");
  }
  const spoof = publish(output(0), { nativeTiming: { source: "antigravity-native", startedAt: 1, completedAt: 2 },
    observedAt: 2, contextOutput: "untrusted override" });
  assert.equal(spoof.toolTiming, undefined, "ACP cannot claim trusted native clocks");
  assert.deepEqual(spoof.contextTool.output, output(0), "ACP cannot override private output metadata");
  const snake = output(2); delete snake.exitCode; assert.equal(publish(snake).tool.exitCode, 2);
  const camel = output(1); delete camel.exit_code; assert.equal(publish(camel).tool.exitCode, 1);
  assert.equal(publish(output(1), { kind: "read" }).tool.exitCode, undefined);
  assert.equal(publish(output(1), { _meta: { mcp: { server: "business", tool: "read" } } }).tool.exitCode, undefined);
  assert.equal(publish(output(0), { status: "failed" }).tool.success, false);
  const earlierError = publish(output(0), { status: "error" });
  assert.equal(earlierError.type, "tool_update"); assert.equal(earlierError.tool.status, "error"); assert.equal(earlierError.tool.exitCode, undefined);
});

const FAKE_SERVER = path.join(__dirname, "fixtures", "antigravity-acp-server.cjs");
const ACCOUNT = "native-antigravity-default-v1";
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await tick(10);
  }
  throw new Error(`Timed out: ${label}`);
}

function fixture(t, { env = {}, authType = "oauth-personal", permissionPolicy, serverVersion = "1.2.1" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agy-acp-host-")));
  fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), runtimeDir: path.join(root, "run"), trustedRoot: root };
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  for (const directory of [paths.stateDir, home, workspace, bin]) fs.mkdirSync(directory, { mode: 0o700 });
  const serverPath = path.join(bin, "agy_acp_server.par");
  const harnessPath = path.join(bin, "localharness_external");
  for (const file of [serverPath, harnessPath]) fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  if (authType) {
    fs.mkdirSync(path.join(home, ".gemini", "antigravity-acp"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, ".gemini", "antigravity-acp", "settings.json"),
      JSON.stringify({ auth: { type: authType } }), { mode: 0o600 });
  }
  fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: {
    shoggoth: { command: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth" },
    userServer: { command: "/usr/bin/true" },
  } }), { mode: 0o600 });
  const log = path.join(root, "server.jsonl");
  const gateCalls = [];
  const hosts = [];
  const runtimeEnvironment = Object.freeze({
    runtime: "antigravity", runtimeAccountId: ACCOUNT, kind: "native-user", installationKind: "system",
    homeKind: "integration", strategy: "account-integration", home, nativeHome: path.join(root, "native", ".gemini"),
    configSourceHome: null, integrationRoot: root, binaryPath: serverPath, launchArgs: Object.freeze([]),
    spawnEnv: Object.freeze({ HOME: home }), configurationMode: "integration",
  });
  const create = (overrides = {}) => {
    const host = new AntigravityAcpRuntimeHost({
      paths,
      runtimeProfileId: "shoggoth-antigravity-cli-v1",
      runtimeAccountId: ACCOUNT,
      runtimeEnvironment,
      permissionPolicy: permissionPolicy || { approvalPolicy: "on-request", sandbox: "workspace-write" },
      workspace,
      platform: "linux",
      parentEnv: { PATH: process.env.PATH, HTTPS_PROXY: "http://127.0.0.1:7897", SECRET_TOKEN: "leak" },
      verifyServer: async () => ({ version: serverVersion, serverPath, harnessPath }),
      spawnProcess: (command, args, options) => {
        assert.equal(command, serverPath);
        return spawn(process.execPath, [FAKE_SERVER, ...args], { ...options, env: { ...options.env, ...env, FAKE_ACP_LOG: log } });
      },
      mcpGateIssuer: {
        createMcpServer: (input) => {
          gateCalls.push(input);
          return { name: "shoggoth", command: "/bin/echo", args: ["mcp"], env: [{ name: "SHOGGOTH_RUNTIME_MCP_GATE_NONCE", value: "n".repeat(64) }] };
        },
      },
      requestTimeoutMs: 3_000,
      acceptanceTimeoutMs: 3_000,
      shutdownGraceMs: 500,
      killGraceMs: 200,
      profileState: {},
      ...overrides,
    });
    hosts.push(host);
    return host;
  };
  const records = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  t.after(async () => {
    for (const host of hosts) { try { await host.stop(); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, paths, home, workspace, serverPath, harnessPath, gateCalls, records, create };
}

async function startedSession(t, options = {}) {
  const f = fixture(t, options);
  const host = f.create();
  await host.initialize();
  const events = [];
  host.subscribe((event) => events.push(event));
  const { session } = await host.sessionStart({ source: "chat:one", cwd: f.workspace, permissionMode: options.permissionMode ?? "accept-edits" });
  return { ...f, host, events, session };
}

async function runTurn(ctx, prompt, extra = {}) {
  const accepted = await ctx.host.turnStart({ sessionId: ctx.session.id, operationId: `op-${prompt}-${Date.now()}`,
    prompt, cwd: ctx.workspace, ...extra });
  const complete = await until(() => ctx.events.find((event) => event.type === "complete" && event.turnId === accepted.turn.id), "complete");
  return { accepted, complete };
}

test("an explicit transient resume failure can recover the same session before sending exactly one prompt", async t => {
  const ctx = await startedSession(t, { env: { FAKE_ACP_RESUME_ERROR: "tls-once" } });
  const { isRetryablePreTurnStageError, runtimeStageError } = require("../app/agent-service/runtime-stage-error");
  ctx.host.sessionConfigs.delete(ctx.session.id);
  const issued = [], revoked = [];
  ctx.host.mcpGateIssuer = {
    createMcpServer() {
      const reservationId = `resume-ticket-${issued.length + 1}`;
      issued.push(reservationId);
      return { reservationId, name: "shoggoth", command: "/bin/echo", args: [], env: [] };
    },
    revokeMcpServer({ reservationId }) { revoked.push(reservationId); },
    renewMcpServer({ reservationId }) { assert.equal(reservationId, issued[1]); return { renewed: true }; },
  };
  const params = { sessionId: ctx.session.id, cwd: ctx.workspace, permissionMode: "full" };
  await assert.rejects(ctx.host.sessionResume(params), error => {
    assert.equal(error.code, "ANTIGRAVITY_NETWORK_UNAVAILABLE");
    assert.equal(isRetryablePreTurnStageError(runtimeStageError("session_start_or_resume", error)), true);
    assert.equal(isRetryablePreTurnStageError(runtimeStageError("turn_start", error)), false);
    return true;
  });
  assert.deepEqual(revoked, [issued[0]]);
  assert.equal(ctx.records().filter(r => r.method === "session/prompt").length, 0);
  const resumed = await ctx.host.sessionResume(params);
  assert.equal(resumed.session.id, ctx.session.id);
  const resumedRequests = ctx.records().filter(r => r.method === "session/resume");
  assert.equal(resumedRequests.length, 2);
  assert.ok(resumedRequests.every(r => r.params.sessionId === ctx.session.id));
  const diagnostic = fs.readFileSync(path.join(ctx.paths.runtimeDir, "antigravity-session-diagnostics.json"), "utf8");
  const saved = JSON.parse(diagnostic).records;
  assert.equal(saved.at(-2).remoteClassification, "TLS_EOF");
  assert.equal(saved.at(-2).retryEligible, true);
  assert.equal(saved.at(-1).outcome, "resumed");
  assert.equal(saved.at(-1).attempt, 2);
  assert.equal(diagnostic.includes("_ssl.c"), false);
  await runTurn(ctx, "resume recovery");
  assert.equal(ctx.records().filter(r => r.method === "session/prompt" && typeof r.text === "string").length, 1);
});

test("resume failures with permanent or unknown causes never authorize an automatic retry", async t => {
  const { isRetryablePreTurnStageError, runtimeStageError } = require("../app/agent-service/runtime-stage-error");
  for (const failure of ["auth", "quota", "mcp", "region", "storage", "history", "certificate", "unknown", "timeout"]) {
    await t.test(failure, async sub => {
      const ctx = await startedSession(sub, { env: { FAKE_ACP_RESUME_ERROR: failure } });
      ctx.host.sessionConfigs.delete(ctx.session.id);
      ctx.host.requestTimeoutMs = 50;
      await assert.rejects(ctx.host.sessionResume({ sessionId: ctx.session.id, cwd: ctx.workspace }), error => {
        assert.equal(isRetryablePreTurnStageError(runtimeStageError("session_start_or_resume", error)), false);
        return true;
      });
      assert.equal(ctx.records().filter(r => r.method === "session/prompt").length, 0);
    });
  }
});

test("resume recovery never grants a retry while preserving a possibly running turn", async t => {
  const ctx = await startedSession(t, { env: { FAKE_ACP_RESUME_ERROR: "tls" } });
  const { isRetryablePreTurnStageError, runtimeStageError } = require("../app/agent-service/runtime-stage-error");
  ctx.host.sessionConfigs.delete(ctx.session.id);
  await assert.rejects(ctx.host.sessionResume({ sessionId: ctx.session.id, cwd: ctx.workspace, preserveRunningContext: true }), error => {
    assert.equal(isRetryablePreTurnStageError(runtimeStageError("session_start_or_resume", error)), false);
    return true;
  });
});

test("managed workspace mode isolates ACP hooks and MCP config while retaining auth and history", async t => {
  const f = fixture(t);
  const accountStore = path.join(f.home, ".gemini", "antigravity-acp");
  const originalSettings = fs.readFileSync(path.join(accountStore, "settings.json"), "utf8");
  fs.writeFileSync(path.join(f.home, ".gemini", "config", "hooks.json"), '{"hook":"untrusted-global"}');
  fs.mkdirSync(path.join(f.workspace, ".agents"));
  fs.writeFileSync(path.join(f.workspace, ".agents", "hooks.json"), '{"hook":"untrusted-project"}');
  const host = f.create({ workspaceExecutionVersion: 1 });
  await host.initialize();
  const isolated = host.workspaceExecutionHome;
  assert.notEqual(isolated.cwd, f.workspace);
  assert.deepEqual(fs.readdirSync(isolated.cwd), []);
  assert.deepEqual(fs.readdirSync(path.join(isolated.geminiHome, "config")), []);
  assert.equal(fs.realpathSync(path.join(isolated.geminiHome, "antigravity-acp")), fs.realpathSync(accountStore));
  assert.equal(host._spawnEnvironment().GEMINI_HOME, isolated.geminiHome);
  const { session } = await host.sessionStart({ source: "managed-guard", cwd: f.workspace, permissionMode: "auto-review" });
  const create = f.records().filter(record => record.method === "session/new").at(-1).params;
  assert.equal(create.cwd, isolated.cwd);
  assert.deepEqual(create._meta, { agy: { enabledTools: ["ask_question", "finish"] } });
  assert.deepEqual(create.mcpServers.map(server => server.name), ["shoggoth"]);
  assert.equal(session.cwd, f.workspace, "public history continues to identify the real project");
  await host.stop();
  assert.equal(fs.existsSync(isolated.geminiHome), false);
  assert.equal(fs.readFileSync(path.join(accountStore, "settings.json"), "utf8"), originalSettings);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, ".gemini", "config", "mcp_config.json"))).mcpServers.userServer.command, "/usr/bin/true");
  const normal = f.create();
  await normal.initialize();
  await normal.sessionResume({ sessionId: session.id, cwd: f.workspace, permissionMode: "ask" });
  const resumed = f.records().filter(record => record.method === "session/resume").at(-1).params;
  assert.equal(resumed.cwd, f.workspace);
  assert.deepEqual(resumed._meta, { agy: { disabledTools: [] } }, "omitting meta would revive the persisted managed allowlist");
});

test("managed ACP rejects an unexpected native tool without another approval card", async () => {
  let prompts = 0;
  const active = { turnId: "guard-turn", dispatchState: "write_attempted" };
  const host = Object.assign(Object.create(AntigravityAcpRuntimeHost.prototype), {
    workspaceExecutionVersion: 1, activeTurns: new Map([["guard-session", active]]), _acceptTurn() {},
    serverRequestHandlers: new Map([["item/commandExecution/requestApproval", () => { prompts++; }]]),
  });
  const params = { sessionId: "guard-session", options: [
    { optionId: "once", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" },
  ], toolCall: { title: "Run run_command?", kind: "execute", rawInput: { CommandLine: "arbitrary", Cwd: "/outside" } } };
  assert.deepEqual(await host._handlePermissionRequest(params), { outcome: { outcome: "selected", optionId: "deny" } });
  assert.equal(prompts, 0);
  assert.deepEqual(await host._handlePermissionRequest({ ...params, toolCall: { _meta: { mcp: { server: "shoggoth" } } } }),
    { outcome: { outcome: "selected", optionId: "once" } }, "the Service retains product tool confirmation");
});

test("an unverified ACP version cannot silently start managed workspace execution", async t => {
  const f = fixture(t, { serverVersion: "1.2.2" });
  await assert.rejects(f.create({ workspaceExecutionVersion: 1 }).initialize(), { code: "WORKSPACE_RUNTIME_GUARD_UNAVAILABLE" });
  assert.equal(f.records().length, 0);
});

// Synthetic values in the pinned native protobuf/SQLite format. Do not copy
// user transcripts or infer results from the assistant's answer.
function protoVarint(value) {
  const bytes = [];
  do { bytes.push((value % 128) | (value >= 128 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
}
function proto(fields) {
  return Buffer.concat(fields.map(([field, value]) => typeof value === "number"
    ? Buffer.concat([protoVarint(field * 8), protoVarint(value)])
    : (() => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      return Buffer.concat([protoVarint(field * 8 + 2), protoVarint(bytes.length), bytes]); })()));
}
function nativeRead({ id = "call_read", args = { absolute_path: "/w/snapshot.txt" }, output = "snapshot text", status = 3 } = {}) {
  const call = proto([[1, id], [2, "view_file"], [3, JSON.stringify(args)]]);
  const response = proto([[1, "view_file"], [2, JSON.stringify({ result: output })]]);
  return { type: 103, status, payload: proto([[1, 103], [4, status], [116, proto([[2, "view_file"],
    [3, proto([[1, "type.googleapis.com/antigravity.localharness.ToolCall"], [2, call]])],
    [4, proto([[1, "type.googleapis.com/antigravity.localharness.ToolResponse"], [2, response]])]])]]) };
}
function nativeMcp({ tool, args, output, status = 3, server = "shoggoth", id = `native-${tool}` }) {
  return { type: 38, status, payload: proto([[1, 38], [4, status], [47, proto([[1, server],
    [2, proto([[1, id], [2, tool], [3, JSON.stringify(args)]])],
    [3, typeof output === "string" ? output : JSON.stringify(output)]])]]) };
}
function nativeStore(ctx, rows, { append = false } = {}) {
  const folder = path.join(ctx.home, ".gemini", "antigravity-acp", "conversations");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${ctx.session.id}.db`);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL;");
    if (!append) {
      db.exec("CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB);");
      db.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run(ctx.session.id, ctx.session.id);
    }
    const offset = db.prepare("SELECT coalesce(max(idx), -1) AS last FROM steps").get().last + 1;
    const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?)");
    rows.forEach((row, i) => insert.run(offset + i, row.type, row.status, row.payload, row.error || null));
  } finally { db.close(); }
  // The native runtime creates 0644 leaves inside the account's private home.
  fs.chmodSync(file, 0o644);
  return file;
}

test("pinned ACP generic failures recover exact native reads and MCP results while preserving takeover", async (t) => {
  const ctx = await startedSession(t);
  const output = "计算器快照\n".repeat(12_000);
  let wrote = false;
  ctx.host.subscribe((event) => {
    if (event.type !== "tool_start" || wrote) return;
    wrote = true;
    nativeStore(ctx, [nativeRead({ output }),
      nativeMcp({ tool: "computer_snapshot", args: { sessionId: "computer-one" }, output: { content: [{ type: "text", text: "snapshot captured" }] } }),
      nativeMcp({ tool: "computer_click", args: { ref: "c3", snapshotRevision: "revision-one", sessionId: "computer-one" },
        status: 7, output: "Session paused (COMPUTER_USER_TAKEOVER)" }),
    ]);
  });
  await runTurn(ctx, "DIRECTIVE:BROKEN_TOOL_RESULTS");
  const results = ctx.events.filter((event) => event.type === "tool_result");
  assert.equal(results.length, 3, "one terminal result per observed call");
  const read = results.find((event) => event.toolCallId === "call_read");
  const snapshot = results.find((event) => event.toolCallId === "public-snapshot");
  const click = results.find((event) => event.toolCallId === "public-click");
  assert.equal(read.tool.success, true, "a native successful read must not become failed");
  assert.ok(read.contextTool.output.result === output, "retain the complete original beyond UI snapshot limits");
  assert.equal(snapshot.tool.success, true);
  assert.deepEqual(snapshot.contextTool.output, { content: [{ type: "text", text: "snapshot captured" }] });
  assert.equal(click.tool.success, false, "native takeover remains a failed action");
  assert.match(click.tool.output, /COMPUTER_USER_TAKEOVER/u);
  const terminal = ctx.events.findIndex((event) => event.type === "complete");
  assert.ok(ctx.events.every((event, i) => event.type !== "tool_result" || i < terminal));
});

function nativeMetadata({ id, name, input, sessionId, idx, startedAt, completedAt }) {
  const stamp = ms => proto([[1, Math.floor(ms / 1000)], [2, (ms % 1000) * 1_000_000]]);
  return proto([[4, proto([[1, id], [2, name], [3, JSON.stringify(input)]])],
    [20, proto([[1, sessionId], [2, idx], [4, sessionId]])],
    [32, stamp(startedAt)], [8, stamp(completedAt)]]);
}
function nativeDenied({ sessionId, idx = 1, id = "call_grep", startedAt, completedAt }) {
  const error = proto([[1, "Access to /outside is denied by grep_search pre-tool hook"]]);
  return { type: 17, status: 7, error, payload: proto([[1, 17], [4, 7],
    [5, nativeMetadata({ id, name: "grep_search", input: { SearchPath: "/outside", Query: "needle" },
      sessionId, idx, startedAt, completedAt })], [24, proto([[3, error], [4, 1], [5, 1]])], [31, error]]) };
}

test("ACP error broadcast preserves the successful read and the separately denied tool before turn end", async (t) => {
  const ctx = await startedSession(t);
  let wrote = false;
  ctx.host.subscribe(event => {
    if (event.type !== "tool_start" || wrote) return;
    wrote = true;
    const startedAt = Date.now(), completedAt = startedAt + 5;
    const read = nativeRead({ output: "READ SUCCEEDED" });
    read.payload = Buffer.concat([read.payload, proto([[5, nativeMetadata({ id: "call_read", name: "view_file",
      input: { absolute_path: "/w/snapshot.txt" }, sessionId: ctx.session.id, idx: 0, startedAt, completedAt })]])]);
    nativeStore(ctx, [read, nativeDenied({ sessionId: ctx.session.id, startedAt, completedAt })]);
  });
  const accepted = await ctx.host.turnStart({ sessionId: ctx.session.id, operationId: "broadcast",
    prompt: "DIRECTIVE:ERROR_BROADCAST", cwd: ctx.workspace });
  await until(() => ctx.events.some(e => e.type === "tool_result"), "early native result");
  assert.ok(!ctx.events.some(e => e.type === "complete"), "do not hold results until the assistant finishes");
  const read = ctx.events.find(e => e.type === "tool_result" && e.toolCallId === "call_read");
  assert.equal(read.tool.success, true);
  assert.equal(read.contextTool.output.result, "READ SUCCEEDED");
  assert.equal(read.toolTiming.completedAt - read.toolTiming.startedAt, 5, "native duration excludes late ACP flush");
  await until(() => ctx.events.some(e => e.type === "complete" && e.turnId === accepted.turn.id), "complete");
  const grep = ctx.events.filter(e => e.type === "tool_result" && e.toolCallId === "call_grep");
  assert.equal(grep.length, 1);
  assert.equal(grep[0].tool.success, false);
  assert.match(grep[0].tool.output, /denied/);
  assert.equal(ctx.events.filter(e => e.type === "tool_result" && e.toolCallId === "call_read").length, 1);
});

test("native denied-tool discovery rejects another trajectory, stale rows and duplicate IDs", async (t) => {
  const ctx = await startedSession(t);
  const now = Date.now();
  nativeStore(ctx, [nativeDenied({ sessionId: ctx.session.id, idx: 0, startedAt: now, completedAt: now + 5 }),
    nativeDenied({ sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", idx: 1, id: "wrong-session", startedAt: now, completedAt: now + 5 })]);
  const reader = new AntigravityNativeToolResults({ home: ctx.home });
  assert.equal(reader.reconcile(ctx.session.id, -1, []).failures.length, 1);
  assert.equal(reader.reconcile(ctx.session.id, 0, []).failures.length, 0);
  nativeStore(ctx, [nativeDenied({ sessionId: ctx.session.id, idx: 2, startedAt: now, completedAt: now + 5 })], { append: true });
  assert.equal(reader.reconcile(ctx.session.id, -1, []).failures.length, 0, "ambiguous native IDs cannot manufacture a result");
});

test("native recovery excludes prior turns and stale or mismatched evidence", async (t) => {
  for (const scenario of ["prior turn", "arguments", "call ID", "duplicate ID", "session", "malformed", "oversized", "unknown version"]) {
    await t.test(scenario, async (t) => {
      const ctx = await startedSession(t, { serverVersion: scenario === "unknown version" ? "1.3.0" : "1.2.1" });
      if (scenario === "prior turn") nativeStore(ctx, [nativeRead({ output: "OLD TURN" })]);
      let wrote = false;
      ctx.host.subscribe((event) => {
        if (event.type !== "tool_start" || wrote) return;
        wrote = true;
        if (scenario === "prior turn") return;
        let rows = [nativeRead()];
        if (scenario === "arguments") rows = [nativeRead({ args: { absolute_path: "/w/different.txt" } })];
        if (scenario === "call ID") rows = [nativeRead({ id: "call_different" })];
        if (scenario === "duplicate ID") rows.push(nativeRead({ output: "SECOND EXECUTION" }));
        if (scenario === "malformed") rows[0].payload = Buffer.from([0xff]);
        if (scenario === "oversized") rows[0].payload = Buffer.alloc(8 * 1024 * 1024 + 1);
        const file = nativeStore(ctx, rows);
        if (scenario === "session") {
          const db = new DatabaseSync(file);
          db.exec("UPDATE trajectory_meta SET cascade_id = 'other-session'");
          db.close();
        }
      });
      await runTurn(ctx, "DIRECTIVE:BROKEN_TOOL_RESULTS");
      const read = ctx.events.find((event) => event.type === "tool_result" && event.toolCallId === "call_read");
      assert.equal(read.tool.success, false, "missing proof must never manufacture success");
      if (scenario === "unknown version") assert.equal(read.tool.output, "Tool execution failed");
      else {
        assert.match(read.tool.output, /ANTIGRAVITY_NATIVE_TOOL_RESULT_UNAVAILABLE/);
        assert.equal(read.contextTool.output.unverifiedUpstreamOutput, "Tool execution failed");
      }
    });
  }
});

test("native MCP recovery requires uniqueness on both sides and the exact server", async (t) => {
  const ctx = await startedSession(t);
  const file = nativeStore(ctx, [nativeRead(),
    nativeMcp({ tool: "computer_snapshot", args: { sessionId: "computer-one" }, output: "first" }),
    nativeMcp({ tool: "computer_snapshot", args: { sessionId: "computer-one" }, output: "second" }),
  ]);
  const reader = new AntigravityNativeToolResults({ home: ctx.home });
  const call = nativeToolCall({ id: "public-one", server: "shoggoth", name: "computer_snapshot", input: { sessionId: "computer-one" } });
  assert.equal(reader.recover(ctx.session.id, -1, [call]).size, 0, "two native executions cannot be guessed");
  const unique = nativeToolCall({ id: "native-one", name: "view_file", input: { absolute_path: "/w/snapshot.txt" } });
  assert.equal(reader.recover(ctx.session.id, -1, [unique]).size, 0, "external tools require their native call ID");
  const db = new DatabaseSync(file);
  db.exec("DELETE FROM steps WHERE idx = 2");
  db.close();
  assert.equal(reader.recover(ctx.session.id, -1, [call, { ...call, id: "public-two" }]).size, 0,
    "two ACP calls cannot borrow one native result");
  assert.equal(reader.recover(ctx.session.id, -1, [{ ...call, server: "another-server" }]).size, 0);
});

test("native recovery reads the live WAL without modifying native data", async (t) => {
  const ctx = await startedSession(t);
  const file = nativeStore(ctx, [{ type: 14, status: 3, payload: proto([[1, 14], [4, 3]]) }]);
  const reader = new AntigravityNativeToolResults({ home: ctx.home });
  const cursor = reader.cursor(ctx.session.id);
  assert.equal(cursor, 0);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    const row = nativeRead({ output: "CURRENT WAL RESULT" });
    db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?)").run(1, row.type, row.status, row.payload, null);
    const before = [fs.readFileSync(file), fs.readFileSync(file + "-wal")];
    const call = nativeToolCall({ id: "call_read", name: "view_file", input: { absolute_path: "/w/snapshot.txt" } });
    const result = reader.recover(ctx.session.id, cursor, [call]).get(call.id);
    assert.equal(result.status, "completed");
    assert.equal(result.output.result, "CURRENT WAL RESULT");
    assert.deepEqual([fs.readFileSync(file), fs.readFileSync(file + "-wal")], before);
  } finally { db.close(); }
});

test("native reader rejects unsafe paths, sidecars and escaping session identifiers", async (t) => {
  for (const scenario of ["directory symlink", "database symlink", "database hardlink", "wide write permissions", "WAL symlink"]) {
    await t.test(scenario, async (t) => {
      const ctx = await startedSession(t);
      const file = nativeStore(ctx, [nativeRead()]);
      const target = path.join(ctx.root, "native-copy");
      if (scenario === "directory symlink") {
        fs.renameSync(path.dirname(file), target);
        fs.symlinkSync(target, path.dirname(file));
      } else if (scenario === "database symlink") {
        fs.renameSync(file, target); fs.symlinkSync(target, file);
      } else if (scenario === "database hardlink") fs.linkSync(file, target);
      else if (scenario === "wide write permissions") fs.chmodSync(file, 0o666);
      else fs.symlinkSync(file, file + "-wal");
      const reader = new AntigravityNativeToolResults({ home: ctx.home });
      const call = nativeToolCall({ id: "call_read", name: "view_file", input: { absolute_path: "/w/snapshot.txt" } });
      assert.equal(reader.cursor(ctx.session.id), null);
      assert.equal(reader.recover(ctx.session.id, -1, [call]).size, 0);
      assert.equal(reader.cursor("../../outside", { fresh: true }), null);
    });
  }
});

test("native content still passes registered-secret filtering", async (t) => {
  const ctx = await startedSession(t);
  ctx.host.registeredSecrets.push("PRIVATE-SYNTHETIC-TOKEN");
  let wrote = false;
  ctx.host.subscribe((event) => {
    if (event.type !== "tool_start" || wrote) return;
    wrote = true;
    nativeStore(ctx, [nativeRead({ output: "PRIVATE-SYNTHETIC-TOKEN" })]);
  });
  await runTurn(ctx, "DIRECTIVE:BROKEN_TOOL_RESULTS");
  const read = ctx.events.find((event) => event.type === "tool_result" && event.toolCallId === "call_read");
  assert.equal(read.tool.success, true);
  assert.equal(read.contextTool, undefined);
  assert.ok(!JSON.stringify(read).includes("PRIVATE-SYNTHETIC-TOKEN"));
});

test("pending lossy results settle once on native cancellation and transport loss without replay", async (t) => {
  for (const scenario of ["cancel", "transport loss"]) {
    await t.test(scenario, async (t) => {
      const ctx = await startedSession(t);
      const accepted = await ctx.host.turnStart({ sessionId: ctx.session.id, cwd: ctx.workspace,
        operationId: "pending-results", prompt: "DIRECTIVE:BROKEN_TOOL_RESULTS_CANCEL" });
      await until(() => ctx.host.activeTurns.get(ctx.session.id)?.pendingToolResults.size === 3, "pending results");
      // Commit after the ACP frames to cover the real native-write race.
      nativeStore(ctx, [nativeRead()]);
      if (scenario === "cancel") await ctx.host.turnInterrupt({ sessionId: ctx.session.id, turnId: accepted.turn.id });
      else ctx.host.child.kill("SIGTERM");
      const complete = await until(() => ctx.events.find((event) => event.type === "complete" && event.turnId === accepted.turn.id), "terminal");
      const read = ctx.events.filter((event) => event.type === "tool_result" && event.toolCallId === "call_read");
      assert.equal(read.length, 1);
      assert.equal(read[0].tool.success, scenario === "cancel");
      assert.equal(complete.status, scenario === "cancel" ? "canceled" : "interrupted");
      assert.equal(ctx.records().filter((entry) => entry.method === "session/prompt" && entry.text !== undefined).length, 1,
        "the prompt is never replayed");
    });
  }
});

test("start sanitizes the retired global MCP entry and spawns without leaking environment", async (t) => {
  const f = fixture(t);
  const host = f.create();
  await host.initialize();
  const mcp = JSON.parse(fs.readFileSync(path.join(f.home, ".gemini", "config", "mcp_config.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["userServer"], "only the stale ungated shoggoth entry is removed");
  const env = host._spawnEnvironment();
  assert.equal(env.GEMINI_HOME, path.join(f.home, ".gemini"));
  assert.equal(env.BROWSER, "/usr/bin/true", "background hosts must never open a browser");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7897");
  assert.equal(env.SECRET_TOKEN, undefined);
});

test("authentication: missing selection, deferred verification and active verification", async (t) => {
  const none = fixture(t, { authType: null }).create();
  await none.initialize();
  assert.deepEqual(await none.authenticationState({ allowDeferred: true }), { authenticated: false, credentialPresent: false });
  const f = fixture(t);
  const host = f.create();
  await host.initialize();
  assert.deepEqual(await host.authenticationState({ allowDeferred: true }), { verificationDeferred: true });
  assert.deepEqual(await host.authenticationState(), { authenticated: true, credentialPresent: true });
  assert.ok(f.records().some((entry) => entry.method === "authenticate" && entry.params.methodId === "oauth-personal"));
});

test("an unexpected browser login flow fails verification without waiting for the user", async (t) => {
  const f = fixture(t, { env: { FAKE_ACP_LOGIN_FLOW: "1" } });
  const host = f.create();
  await host.initialize();
  assert.deepEqual(await host.authenticationState(), { authenticated: false, credentialPresent: false });
  assert.equal(host.state, "failed", "the host stops so the loopback login listener dies with it");
});

test("session start binds a harness-child MCP ticket and applies mode and model", async (t) => {
  const ctx = await startedSession(t);
  assert.equal(ctx.gateCalls.length, 1);
  assert.equal(ctx.gateCalls[0].parentExecutable, ctx.harnessPath);
  assert.equal(ctx.gateCalls[0].ancestorExecutable, ctx.serverPath);
  assert.equal(ctx.gateCalls[0].ancestorPid, ctx.host.child.pid);
  const created = ctx.records().find((entry) => entry.method === "session/new");
  assert.equal(created.params.cwd, ctx.workspace);
  assert.equal(created.params.mcpServers[0].name, "shoggoth");
  assert.deepEqual(ctx.records().filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params.value),
    ["auto_edit"], "accept-edits maps to auto_edit; the default model needs no change");
  const listed = await ctx.host.commandsList({ sessionId: ctx.session.id });
  const names = listed.commands.map((command) => command.name);
  assert.ok(names.includes("plan"));
  assert.ok(!names.includes("logout"), "account sign-out stays in Settings");
  assert.deepEqual(await ctx.host.commandExecute({ sessionId: ctx.session.id, text: "/plan ship it" }),
    { kind: "send", text: "/plan ship it", warning: null });
});

test("a plain turn streams, completes and records the answer", async (t) => {
  const ctx = await startedSession(t);
  const png = path.join(ctx.root, "pixel.png");
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), { mode: 0o600 });
  const { accepted, complete } = await runTurn(ctx, "hello", {
    model: "gemini-3.8-flash-low",
    attachments: [{ id: "a1", name: "pixel.png", mimeType: "image/png", path: png }],
  });
  assert.equal(complete.status, "completed");
  assert.ok(ctx.events.some((event) => event.type === "text" && event.text === "ANSWER(1 images)"));
  assert.ok(ctx.events.some((event) => event.type === "reasoning_delta"));
  const prompt = ctx.records().find((entry) => entry.method === "session/prompt" && entry.text !== undefined);
  assert.equal(prompt.model, "gemini-3.8-flash-low", "the requested model is applied before the prompt");
  const read = await ctx.host.sessionRead({ sessionId: ctx.session.id, includeTurns: true });
  const turn = read.session.turns.find((candidate) => candidate.id === accepted.turn.id);
  assert.equal(turn.status, "completed");
  assert.equal(turn.items[1].text, "ANSWER(1 images)");
});

test("native approval options pass the shared interaction contract and map back to the chosen option", async (t) => {
  const ctx = await startedSession(t);
  let request;
  ctx.host.registerServerRequestHandler("item/commandExecution/requestApproval", async (params, context) => {
    request = { params, context };
    return { decision: "accept", approvalChoice: "once" };
  });
  const { complete } = await runTurn(ctx, "DIRECTIVE:PERMISSION");
  assert.equal(complete.status, "completed");
  assert.deepEqual(request.params.approvalOptions.map((option) => [option.choice, option.kind]),
    [["runtime:0", "allow_always"], ["once", "allow_once"], ["deny", "reject_once"]]);
  assert.match(request.params.approvalOptions[0].label, /Allowing always can be risky/u);
  const normalized = normalizeInteractiveRequestV1({ runId: "run-1", eventType: "approval",
    payload: { requestId: "req-1", ...request.params } });
  assert.notEqual(normalized.title, "审批详情不可用", "Antigravity approvals must be renderable and approvable");
  assert.deepEqual(normalized.approvalChoices, ["runtime:0", "once", "deny", "cancel"]);
  const outcome = ctx.records().find((entry) => entry.method === "permission-outcome");
  assert.deepEqual(outcome.outcome, { outcome: { outcome: "selected", optionId: "allow" } });
  assert.ok(ctx.events.some((event) => event.type === "text" && event.text === "ALLOWED"));
  assert.equal(request.params.toolName, "read_url_content", "the tool, not the server's sentence title");
  assert.deepEqual(request.params.toolInput, { url: "https://example.com" });
  assert.equal(request.params.reason, undefined, "restating the tool is not a reason");
  assert.equal(request.params.command, undefined, "fetching a URL is not a command");
  const started = ctx.events.find((event) => event.type === "tool_start");
  assert.deepEqual([started.tool.name, started.tool.input], ["read_url_content", { url: "https://example.com" }]);
});

test("ACP tool calls are named by their tool and use the common argument keys", () => {
  // Shapes captured from the official 1.2.1 server.
  assert.equal(acpToolName({ title: "Run list_resources?" }), "list_resources");
  assert.equal(acpToolName({ title: "Running view_file" }), "view_file");
  assert.equal(acpToolName({ title: "shoggoth_ping", _meta: { mcp: { server: "shoggoth", tool: "ping" } } }),
    "mcp__shoggoth__ping");
  assert.equal(acpToolName({ title: "Something else entirely" }), "Something else entirely");
  assert.equal(acpToolName({}), "tool");
  assert.deepEqual(acpToolArguments({ rawInput: { ServerName: "shoggoth" } }), { server: "shoggoth" });
  assert.deepEqual(acpToolArguments({ rawInput: { CommandLine: "npm test", Cwd: "/w", Extra: 1 } }),
    { command: "npm test", cwd: "/w", Extra: 1 });
  assert.deepEqual(acpToolArguments({ kind: "read", locations: [{ path: "/w/a.txt" }] }), { path: "/w/a.txt" });
  assert.deepEqual(acpToolArguments({ kind: "fetch", content: [{ type: "content", content: { type: "text", text: "https://example.com" } }] }),
    { url: "https://example.com" });
  assert.deepEqual(acpToolArguments({ _meta: { mcp: { server: "shoggoth", tool: "board_list" } },
    rawInput: { arguments: { boardName: "Inbox" }, text: "x" } }), { boardName: "Inbox" });
  assert.equal(acpToolArguments({ kind: "search" }), undefined);
});

test("Shoggoth product tools are admitted without a duplicate runtime prompt", async (t) => {
  const ctx = await startedSession(t);
  let asked = false;
  ctx.host.registerServerRequestHandler("item/commandExecution/requestApproval", async () => { asked = true; return { decision: "decline" }; });
  await runTurn(ctx, "DIRECTIVE:MCP_PERMISSION");
  assert.equal(asked, false);
  assert.equal(ctx.records().find((entry) => entry.method === "permission-outcome").outcome.outcome.optionId, "allow");
});

test("plan mode is enforced read-only by rejecting write tool requests", async (t) => {
  const ctx = await startedSession(t, { permissionMode: "plan" });
  assert.deepEqual(ctx.records().filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params.value), [],
    "plan uses the server's default ask-first mode");
  await runTurn(ctx, "DIRECTIVE:EDIT_PERMISSION", { permissionMode: "plan" });
  assert.equal(ctx.records().find((entry) => entry.method === "permission-outcome").outcome.outcome.optionId, "deny");
});

test("an in-band server failure fails the turn instead of completing with an error message", async (t) => {
  const ctx = await startedSession(t);
  const { accepted, complete } = await runTurn(ctx, "DIRECTIVE:INBAND_ERROR");
  assert.equal(complete.status, "failed");
  assert.equal(complete.errorCode, "ANTIGRAVITY_MCP_UNAVAILABLE");
  assert.ok(!ctx.events.some((event) => event.type === "text" && event.turnId === accepted.turn.id),
    "the server's error explanation is not presented as an answer");
});

test("an explicit remote error on the prompt fails the turn with its cause, never as an unknown outcome", async (t) => {
  const ctx = await startedSession(t);
  const { complete } = await runTurn(ctx, "DIRECTIVE:REMOTE_ERROR");
  assert.deepEqual([complete.status, complete.errorCode], ["failed", "ANTIGRAVITY_NETWORK_UNAVAILABLE"]);
  const read = await ctx.host.sessionRead({ sessionId: ctx.session.id, includeTurns: true });
  assert.equal(read.session.turns[0].status, "failed");
  const ledger = ctx.host.ledger.snapshot().sessions[0].turns[0];
  assert.deepEqual([ledger.status, ledger.errorCode], ["failed", "ANTIGRAVITY_NETWORK_UNAVAILABLE"]);
});

test("a turn is accepted once the prompt reaches the server, so a silent model can still be stopped", async (t) => {
  const ctx = await startedSession(t);
  const accepted = await ctx.host.turnStart({ sessionId: ctx.session.id, operationId: "op-silent",
    prompt: "DIRECTIVE:SILENT", cwd: ctx.workspace });
  assert.equal(accepted.turn.status, "inProgress", "no session update is needed to control the turn");
  await ctx.host.turnInterrupt({ sessionId: ctx.session.id, turnId: accepted.turn.id });
  const complete = await until(() => ctx.events.find((event) => event.type === "complete" && event.turnId === accepted.turn.id), "cancel");
  assert.equal(complete.status, "canceled");
});

test("a model that stays silent past the acceptance window still finishes its turn", async (t) => {
  const f = fixture(t);
  const host = f.create({ acceptanceTimeoutMs: 100 });
  await host.initialize();
  const events = [];
  host.subscribe((event) => events.push(event));
  const { session } = await host.sessionStart({ source: "chat:late", cwd: f.workspace });
  const accepted = await host.turnStart({ sessionId: session.id, operationId: "op-late", prompt: "DIRECTIVE:SILENT_LATE", cwd: f.workspace });
  const complete = await until(() => events.find((event) => event.type === "complete" && event.turnId === accepted.turn.id), "late");
  assert.equal(complete.status, "completed");
  assert.ok(events.some((event) => event.type === "text" && event.text === "LATE ANSWER"));
  assert.equal(f.records().some((entry) => entry.method === "session/cancel"), false, "a healthy turn is never cancelled");
});

test("session creation failures before any conversation are classified and release the source", async (t) => {
  for (const [kind, code] of [["network", "ANTIGRAVITY_NETWORK_UNAVAILABLE"], ["auth", "AUTH_REQUIRED"]]) {
    const f = fixture(t, { env: { FAKE_ACP_NEW_ERROR: kind } });
    const host = f.create();
    await host.initialize();
    await assert.rejects(host.sessionStart({ source: "chat:x", cwd: f.workspace }), { code });
    assert.deepEqual(host.ledger.snapshot().pendingSessions, [], `${kind}: a rejected session/new can be retried`);
  }
});

test("interrupting a turn cancels natively and drops the synthetic cancellation notice", async (t) => {
  const ctx = await startedSession(t);
  const accepted = await ctx.host.turnStart({ sessionId: ctx.session.id, operationId: "op-slow", prompt: "DIRECTIVE:SLOW", cwd: ctx.workspace });
  await ctx.host.turnInterrupt({ sessionId: ctx.session.id, turnId: accepted.turn.id });
  const complete = await until(() => ctx.events.find((event) => event.type === "complete" && event.turnId === accepted.turn.id), "cancel");
  assert.equal(complete.status, "canceled");
  const turn = ctx.host.ledger.snapshot().sessions[0].turns[0];
  assert.deepEqual(turn.assistantMessages.map((message) => message.text), ["partial"]);
});

test("a login flow started by a background prompt fails it as authentication, not as unknown", async (t) => {
  const ctx = await startedSession(t);
  const { complete } = await runTurn(ctx, "DIRECTIVE:LOGIN");
  assert.deepEqual([complete.status, complete.errorCode], ["failed", "AUTH_REQUIRED"]);
  await until(() => ctx.host.state === "failed", "host failed");
});

test("resume after a restart reuses the native session and re-applies the model", async (t) => {
  const ctx = await startedSession(t);
  await runTurn(ctx, "hello", { model: "gemini-pro-agent" });
  await ctx.host.stop();
  const restarted = ctx.create({ ledgerSlot: { promise: null } });
  await restarted.initialize();
  await restarted.sessionResume({ sessionId: ctx.session.id, cwd: ctx.workspace, model: "gemini-pro-agent", permissionMode: "accept-edits" });
  const resumed = ctx.records().filter((entry) => entry.method === "session/resume");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].params.sessionId, ctx.session.id);
  assert.equal(ctx.gateCalls.length, 2, "each native session load gets a fresh one-shot MCP ticket");
  const all = ctx.records();
  const afterResume = all.slice(all.findIndex((entry) => entry.method === "session/resume"))
    .filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params);
  assert.deepEqual(afterResume, [
    { sessionId: ctx.session.id, configId: "model", value: "gemini-pro-agent" },
    { sessionId: ctx.session.id, configId: "mode", value: "auto_edit" },
  ], "the server restores neither the model nor (for a fresh process) the mode; both are re-applied");
});

test("model catalog comes from ACP config options and carries effort in the model id", async (t) => {
  const f = fixture(t);
  const host = f.create({ workspace: undefined, controlInstance: true });
  await host.initialize();
  const models = await host.modelsList();
  assert.deepEqual(models.data.map((model) => model.model), ["gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-pro-agent"]);
  assert.equal(models.data[0].isDefault, true);
  assert.deepEqual(models.data[0].capabilities.thinkingOptions, []);
  const catalogSession = host.ledger.snapshot().catalogSessionId;
  assert.ok(catalogSession, "the catalog session id is kept so later loads resume it");
  assert.deepEqual(host.ledger.snapshot().sessions, [], "the catalog session is not a user conversation");
});

test("unknown session update kinds are ignored instead of failing the connection", async (t) => {
  const ctx = await startedSession(t);
  const { complete } = await runTurn(ctx, "DIRECTIVE:UNKNOWN_UPDATE");
  assert.equal(complete.status, "completed");
  assert.equal(ctx.host.state, "ready");
});

test("failure text classification maps to safe public codes", () => {
  assert.equal(classifyAntigravityFailure("HTTPSConnectionPool(...) Caused by ProxyError('Unable to connect to proxy')"), "ANTIGRAVITY_NETWORK_UNAVAILABLE");
  assert.equal(classifyAntigravityFailure("System step error (HTTP 2): There was a network issue (MCP load failed for shoggoth)"), "ANTIGRAVITY_MCP_UNAVAILABLE");
  assert.equal(classifyAntigravityFailure("Authentication required"), "RUNTIME_AUTH_REQUIRED");
  assert.equal(classifyAntigravityFailure("FAILED_PRECONDITION: User location is not supported for the API use"), "ANTIGRAVITY_REGION_UNSUPPORTED");
  assert.equal(classifyAntigravityFailure("RESOURCE_EXHAUSTED (code 429): Resource has been exhausted"), "RUNTIME_RATE_LIMITED");
  assert.equal(classifyAntigravityFailure("You can upgrade to receive higher rate limits.\nMCP load failed for shoggoth: invalid character '\\x00' in string"), "ANTIGRAVITY_MCP_UNAVAILABLE");
  assert.equal(classifyAntigravityFailure("the model answered normally"), null);
  assert.equal(modelCatalogFromConfig([{ id: "mode", options: [] }]), null);
});

test("subscription notices cannot turn MCP, network or unknown failures into model rate limits", async (t) => {
  const ctx = await startedSession(t);
  for (const [directive, expected] of [
    ["INBAND_ERROR", "ANTIGRAVITY_MCP_UNAVAILABLE"],
    ["INBAND_NETWORK_ERROR", "ANTIGRAVITY_NETWORK_UNAVAILABLE"],
    ["INBAND_UNKNOWN_ERROR", "ANTIGRAVITY_TURN_FAILED"],
    ["INBAND_RATE_LIMIT", "RUNTIME_RATE_LIMITED"],
    ["INBAND_QUOTA_ERROR", "RUNTIME_QUOTA_EXHAUSTED"],
  ]) {
    const { complete } = await runTurn(ctx, `DIRECTIVE:${directive}`);
    assert.equal(complete.status, "failed", directive);
    assert.equal(complete.errorCode, expected, directive);
    assert.equal(ctx.host.ledger.snapshot().sessions[0].turns.at(-1).errorCode, expected);
  }
});

test("sessions created by the retired agy CLI transport are recognised as retired", () => {
  const adapter = new AntigravityRuntimeAdapter({ runtimePool: { get() {}, stop() {}, stopAll() {} } });
  assert.equal(adapter.isRetiredSessionId("antigravity-session-34c83804-3ac6-4fce-8d8e-2f82dae6d6f6"), true);
  assert.equal(adapter.isRetiredSessionId("49b0cbea-41f5-4bfa-be20-e9dbc9f387ed"), false);
});

test("cold keychain preparation leaves the shared Service event loop responsive", async (t) => {
  const f = fixture(t);
  let heartbeats = 0;
  const observed = [];
  const keychain = path.join(f.root, "login.keychain-db");
  fs.writeFileSync(keychain, "fixture", { mode: 0o600 });
  const preferences = path.join(f.home, "Library", "Preferences");
  fs.mkdirSync(preferences, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(preferences, "com.apple.security.plist"), "fixture", { mode: 0o600 });
  const output = (command, args, options) => {
    assert.equal(command, "/usr/bin/security");
    assert.equal(args.includes("-s"), false, "the existing matching context needs no mutation");
    assert.equal(options.timeout, 5000);
    observed.push(heartbeats);
    return `    "${keychain}"\n`;
  };
  const host = f.create({ platform: "darwin",
    securityExecFileSync(command, args, options) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      return output(command, args, options);
    },
    securityExecFile(command, args, options, callback) {
      setTimeout(() => callback(null, output(command, args, options), ""), 80);
    },
  });
  const timer = setInterval(() => { heartbeats += 1; }, 5);
  try {
    await host.initialize();
    assert.equal(observed.length, 3);
    assert.ok(observed[0] > 0, "other Service callbacks must run while the first keychain command waits");
    assert.ok(observed[2] > observed[0], "each keychain wait must yield to health/group requests");
  } finally { clearInterval(timer); }
});

test("stopping during a keychain command cancels preparation and cannot spawn a late Runtime", async (t) => {
  const f = fixture(t);
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let commands = 0, spawned = 0, cancelled = 0;
  const host = f.create({ platform: "darwin",
    spawnProcess() { spawned += 1; throw new Error("late spawn"); },
    securityExecFile(_command, _args, options, callback) {
      commands += 1;
      options.signal.addEventListener("abort", () => {
        cancelled += 1; callback(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }));
      }, { once: true });
      began();
    },
  });
  const initializing = host.initialize();
  const failed = assert.rejects(initializing, { code: "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE" });
  await started;
  await host.stop();
  await failed;
  assert.equal(commands, 1);
  assert.equal(cancelled, 1);
  assert.equal(spawned, 0);
  assert.equal(host.state, "stopped");
});

test("stopping a real pending keychain child waits for process close", async (t) => {
  const f = fixture(t);
  let began, child;
  const started = new Promise(resolve => { began = resolve; });
  const host = f.create({ platform: "darwin",
    securityExecFile(_command, _args, config, callback) {
      child = require("node:child_process").execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], config, callback);
      child.once("spawn", began);
      return child;
    },
  });
  const failed = assert.rejects(host.initialize(), { code: "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE" });
  await started;
  let closed = false;
  child.once("close", () => { closed = true; });
  await host.stop();
  await failed;
  assert.equal(closed, true, "stop must observe the metadata child closing");
  assert.equal(host.child, null, "the ACP server never started");
});

for (const [mode, prepare] of [["sync", prepareAntigravityKeychainContext], ["async", prepareAntigravityKeychainContextAsync]]) {
test(`macOS managed HOME mirrors only the user default keychain and stays idempotent (${mode})`, async (t) => {
  const trustedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agy-acp-keychain-")));
  t.after(() => fs.rmSync(trustedRoot, { recursive: true, force: true }));
  fs.chmodSync(trustedRoot, 0o700);
  const userHome = path.join(trustedRoot, "user");
  const keychainDir = path.join(userHome, "Library", "Keychains");
  fs.mkdirSync(keychainDir, { recursive: true, mode: 0o700 });
  const defaultKeychain = path.join(keychainDir, "login.keychain-db");
  fs.writeFileSync(defaultKeychain, "fixture", { mode: 0o600 });
  const home = prepareAntigravityRuntimeAccountHome({ stateDir: path.join(trustedRoot, "state"), trustedRoot }, ACCOUNT);
  const calls = [];
  let managedDefault = null;
  let managedSearchList = [];
  const execFileSync = (command, args, options) => {
    calls.push({ args: [...args], home: options.env.HOME });
    assert.equal(command, "/usr/bin/security");
    if (args[0] === "default-keychain" && !args.includes("-s")) {
      if (options.env.HOME === userHome) return `    "${defaultKeychain}"\n`;
      if (managedDefault === null) throw new Error("A default keychain could not be found");
      return `    "${managedDefault}"\n`;
    }
    if (args[0] === "list-keychains" && !args.includes("-s")) return managedSearchList.map((entry) => `    "${entry}"`).join("\n");
    if (args[0] === "list-keychains") {
      managedSearchList = args.slice(args.indexOf("-s") + 1);
      fs.mkdirSync(path.join(home, "Library", "Preferences"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(home, "Library", "Preferences", "com.apple.security.plist"), "fixture", { mode: 0o644 });
      return "";
    }
    if (args[0] === "default-keychain") { managedDefault = args[args.indexOf("-s") + 1]; return ""; }
    assert.fail(`unexpected security invocation: ${args.join(" ")}`);
  };
  const options = { home, userHome, trustedRoot, platform: "darwin", execFileSync,
    execFile(command, args, config, callback) {
      setImmediate(() => {
        try { callback(null, execFileSync(command, args, config), ""); }
        catch (error) { callback(error); }
      });
    },
  };
  await prepare(options);
  assert.equal(managedDefault, defaultKeychain);
  assert.deepEqual(managedSearchList, [defaultKeychain]);
  assert.equal(fs.statSync(path.join(home, "Library", "Preferences", "com.apple.security.plist")).mode & 0o077, 0);
  const writes = calls.filter((call) => call.args.includes("-s")).length;
  await prepare(options);
  assert.equal(calls.filter((call) => call.args.includes("-s")).length, writes, "a prepared context is not rewritten");
  assert.ok(calls.every((call) => call.home === home || call.home === userHome));
});
}

test("keychain preparation fails closed on macOS, is a no-op elsewhere, and blocks the server spawn", async (t) => {
  let calls = 0;
  const failing = () => { calls += 1; throw new Error("missing default keychain"); };
  const f = fixture(t);
  const options = { home: f.home, userHome: path.join(f.root, "native"), trustedRoot: f.root };
  assert.throws(() => prepareAntigravityKeychainContext({ ...options, platform: "darwin", execFileSync: failing }),
    { code: "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE" });
  prepareAntigravityKeychainContext({ ...options, platform: "linux", execFileSync: failing });
  assert.equal(calls, 1);
  let spawned = 0;
  const host = f.create({ platform: "darwin", securityExecFileSync: failing, spawnProcess: () => { spawned += 1; } });
  await assert.rejects(host.initialize(), { code: "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE" });
  assert.equal(spawned, 0);
});

test("the Antigravity Agent is offered when this Mac has the agy command or the app, never run", () => {
  // A fake fs keeps the answer independent of the Mac running the test.
  const fakeFs = (files, directories = []) => ({
    constants: fs.constants,
    realpathSync(target) { if (!files.includes(target)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return target; },
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    accessSync() {},
    statSync(target) {
      if (!directories.includes(target)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isDirectory: () => true };
    },
  });
  const options = { parentEnv: { PATH: "/usr/bin:relative/bin" }, homedir: "/Users/example" };
  assert.equal(antigravityUsedOnThisMac({ ...options, fs: fakeFs(["/Users/example/.local/bin/agy"]) }), true);
  assert.equal(antigravityUsedOnThisMac({ ...options, fs: fakeFs(["/usr/bin/agy"]) }), true);
  assert.equal(antigravityUsedOnThisMac({ ...options, fs: fakeFs([], ["/Applications/Antigravity.app"]) }), true);
  assert.equal(antigravityUsedOnThisMac({ ...options, fs: fakeFs([], ["/Users/example/Applications/Antigravity.app"]) }), true);
  assert.equal(antigravityUsedOnThisMac({ ...options, fs: fakeFs(["relative/bin/agy"]) }), false);
  assert.equal(antigravityUsedOnThisMac({ ...options, fs: fakeFs([]) }), false);
});
