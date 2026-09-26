#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { OpenCodeHttpClient } = require("../app/agent-service/opencode-http-client");
const { OpenCodeRuntimeLedger } = require("../app/agent-service/opencode-runtime-ledger");
const { OpenCodeRuntimeHost, commandEnvironment, modelRef, usageFromTokens } = require("../app/agent-service/opencode-runtime-host");
const { supportsOpenCodeVersion, normalizeOpenCodeWorkspace } = require("../app/agent-service/opencode-runtime-paths");

test("OpenCode version and workspace identity reject unsupported or missing targets", () => {
  assert.equal(supportsOpenCodeVersion("1.18.31"), false);
  assert.equal(supportsOpenCodeVersion("1.18.32"), true);
  assert.equal(supportsOpenCodeVersion("2.0.0"), false);
  assert.throws(() => normalizeOpenCodeWorkspace("/not-a-shoggoth-workspace"),
    { code: "OPENCODE_WORKSPACE_INVALID" });
  assert.equal(normalizeOpenCodeWorkspace(fs.realpathSync(os.tmpdir())), fs.realpathSync(os.tmpdir()));
});

test("private command environment keeps credentials out and enforces ask", () => {
  const runtimeEnvironment = { spawnEnv: { HOME: "/tmp/home", XDG_DATA_HOME: "/tmp/data" } };
  const env = commandEnvironment({ PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "private-key",
    OPENCODE_SERVER_PASSWORD: "untrusted-password" }, runtimeEnvironment, "/tmp/config",
  "a".repeat(64), { approvalPolicy: "on-request", sandbox: "danger-full-access" }, null);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENCODE_SERVER_PASSWORD, "a".repeat(64));
  assert.equal(env.XDG_DATA_HOME, "/tmp/data");
  assert.equal(env.XDG_CONFIG_HOME, "/tmp/config/config");
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission, { "*": "ask" });
  assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT).autoupdate, false);
});

test("model and usage preserve provider identity and native token totals", () => {
  assert.deepEqual(modelRef("opencode/mimo-v2.6-flash-free"),
    { providerID: "opencode", id: "mimo-v2.6-flash-free" });
  assert.throws(() => modelRef("mimo-v2.6-flash-free"), { code: "RUNTIME_MODEL_UNAVAILABLE" });
  assert.deepEqual(usageFromTokens({ input: 10, output: 5, reasoning: 2, total: 15,
    cache: { read: 3, write: 1 } }), { inputTokens: 10, outputTokens: 5,
    reasoningOutputTokens: 2, cachedInputTokens: 3, cacheWriteInputTokens: 1,
    totalTokens: 15 });
});

test("HTTP client refuses route escape and sends credentials only to fixed loopback", async () => {
  const password = crypto.randomBytes(32).toString("hex");
  let calls = 0;
  const client = new OpenCodeHttpClient({ url: "http://127.0.0.1:41234", password,
    fetch: async (target, options) => {
      calls += 1;
      assert.equal(target.origin, "http://127.0.0.1:41234");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization,
        `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200,
        headers: { "Content-Type": "application/json" } });
    } });
  await assert.rejects(client.request("GET", "//example.com/steal"),
    { code: "OPENCODE_HTTP_ROUTE_INVALID" });
  assert.equal(calls, 0);
  assert.deepEqual((await client.request("GET", "/global/health")).data, { ok: true });
  assert.equal(calls, 1);
});

test("corrupt or foreign operation ledger fails closed instead of resetting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-opencode-ledger-"));
  try {
    const options = { runtimeProfileId: "profile-a", runtimeAccountId: "account-a",
      workspaceShardId: "a".repeat(64), stateRoot: path.join(root, "state", "runtime-ledgers", "opencode"),
      trustedRoot: root };
    const first = new OpenCodeRuntimeLedger(options).open();
    assert.equal(first.snapshot().sessions.length, 0);
    const file = first.file;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.runtimeAccountId = "account-b";
    fs.writeFileSync(file, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    assert.throws(() => new OpenCodeRuntimeLedger(options).open(), { code: "OPENCODE_LEDGER_INVALID" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const POLICY = Object.freeze({ approvalPolicy: "on-request", sandbox: "danger-full-access" });

function openCodeFixture(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const account = "native-opencode-default-v1", profile = `${prefix.replace(/[^a-z]/gu, "")}profile`;
  const ledgerOptions = { runtimeProfileId: profile, runtimeAccountId: account,
    workspaceShardId: "c".repeat(64), stateRoot: path.join(root, "state", "runtime-ledgers", "opencode"),
    trustedRoot: root };
  const host = (ledger, request, now) => {
    const instance = new OpenCodeRuntimeHost({ paths: { stateDir: path.join(root, "state"), trustedRoot: root },
      runtimeBinding: { runtime: "opencode", runtimeProfileId: profile, runtimeAccountId: account },
      runtimeEnvironment: Object.freeze({ runtime: "opencode", runtimeAccountId: account,
        home: root, binaryPath: "/bin/true", configurationMode: "native",
        configSourceHome: root, launchArgs: Object.freeze([]),
        spawnEnv: Object.freeze({ HOME: root, XDG_DATA_HOME: root }) }),
      workspace, permissionPolicy: POLICY, ...(now ? { now } : {}) });
    instance.ledger = ledger;
    instance.state = "ready";
    instance.client = { request };
    return instance;
  };
  return { root, workspace, ledgerOptions, host,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function completion(host, timeoutMs = 5000) {
  const events = [];
  let timer;
  const settled = new Promise((resolve, reject) => {
    host.subscribe(event => { events.push(event); if (event.type === "complete") resolve(event); });
    timer = setTimeout(() => reject(new Error("OpenCode turn did not settle")), timeoutMs);
  }).finally(() => clearTimeout(timer));
  return { events, settled };
}

test("a turn from a stopped server generation fences only its own operation", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-unknown-");
  const sessionId = "ses_12345678";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1,
    turns: [{ id: "opencode-turn-test", operationId: "original-operation",
      messageId: "msg_12345678", fingerprint: "a".repeat(64), acceptance: "accepted",
      status: "failed", errorCode: "RUNTIME_TURN_OUTCOME_UNKNOWN", assistantMessages: [],
      createdAt: 1, updatedAt: 1 }] }));
  const routes = [];
  let userMessageId = null;
  const host = fixture.host(ledger, async (method, route, body) => {
    routes.push(`${method} ${route}`);
    if (method === "POST" && route.endsWith("/prompt_async")) {
      userMessageId = body.messageID;
      return { status: 204, data: null };
    }
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) {
      return { data: userMessageId ? [
        { info: { id: userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
        { info: { id: "msg_answer12345", sessionID: sessionId, role: "assistant", parentID: userMessageId,
          time: { completed: Date.now() } }, parts: [{ type: "text", id: "prt_answer", text: "ok" }] },
      ] : [] };
    }
    if (method === "GET" && route === "/session/status") return { data: {} };
    return { data: [] };
  });
  const { settled } = completion(host);
  try {
    // The server that accepted the unknown turn is gone: reading and new
    // operations proceed, while the unresolved receipt stays in history.
    const read = await host.sessionRead({ sessionId, includeTurns: true });
    assert.equal(read.session.turns[0].errorCode, "RUNTIME_TURN_OUTCOME_UNKNOWN");
    await host.turnStart({ sessionId, operationId: "second-operation", prompt: "continue",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    assert.equal((await settled).status, "completed");
    assert.equal(routes.filter(route => route.endsWith("/prompt_async")).length, 1);
    assert.deepEqual(ledger.snapshot().sessions[0].turns.map(turn => [turn.operationId, turn.status]),
      [["original-operation", "failed"], ["second-operation", "completed"]]);
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

test("an unconfirmed native stop fences other operations until its server stops, and its own forever", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-fence-");
  const sessionId = "ses_fencetest12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  let prompts = 0, aborts = 0;
  const first = fixture.host(ledger, async (method, route) => {
    if (method === "POST" && route.endsWith("/prompt_async")) { prompts += 1; return { status: 204, data: null }; }
    if (method === "POST" && route.endsWith("/abort")) { aborts += 1; throw Object.assign(new Error("gone"), { code: "RUNTIME_CONNECTION_LOST" }); }
    if (method === "GET" && route === "/session/status") throw Object.assign(new Error("gone"), { code: "RUNTIME_CONNECTION_LOST" });
    return { data: [] };
  });
  const original = { sessionId, operationId: "unconfirmed", prompt: "work",
    cwd: fixture.workspace, permissionPolicy: POLICY };
  const { settled } = completion(first);
  try {
    await first.turnStart(original);
    const failed = await settled;
    assert.deepEqual([failed.status, failed.errorCode], ["failed", "RUNTIME_TURN_OUTCOME_UNKNOWN"]);
    assert.equal(aborts, 1);
    await assert.rejects(first.turnStart({ ...original, operationId: "other" }),
      { code: "RUNTIME_TURN_OUTCOME_UNKNOWN" });
    await assert.rejects(first.sessionRead({ sessionId, includeTurns: true }),
      { code: "RUNTIME_TURN_OUTCOME_UNKNOWN" });
    await first.stop();
    const second = fixture.host(ledger, async (method, route) => {
      if (method === "POST" && route.endsWith("/prompt_async")) { prompts += 1; return { status: 204, data: null }; }
      if (method === "GET" && route === "/session/status") return { data: {} };
      return { data: [] };
    });
    try {
      await assert.rejects(second.turnStart(original), { code: "RUNTIME_TURN_OUTCOME_UNKNOWN" });
      assert.equal(prompts, 1, "the unresolved operation itself is never sent again");
      await second.turnStart({ ...original, operationId: "other" });
      assert.equal(prompts, 2);
    } finally { second.state = "stopped"; }
  } finally {
    first.state = "stopped";
    fixture.cleanup();
  }
});

function stoppingClient(sessionId, statusFor, finalError) {
  const state = { userMessageId: null, aborted: false, routes: [] };
  state.request = async (method, route, body) => {
    state.routes.push(`${method} ${route}`);
    if (method === "POST" && route.endsWith("/prompt_async")) {
      state.userMessageId = body.messageID;
      return { status: 204, data: null };
    }
    if (method === "POST" && route === `/session/${sessionId}/abort`) {
      state.aborted = true;
      return { status: 200, data: true };
    }
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) {
      return { data: [
        { info: { id: state.userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
        { info: { id: "msg_partial12345", sessionID: sessionId, role: "assistant",
          parentID: state.userMessageId, ...(state.aborted ? { time: { completed: Date.now() },
            error: finalError } : {}) }, parts: [{ type: "text", id: "prt_partial", text: "partial" }] },
      ] };
    }
    if (method === "GET" && ["/permission", "/question"].includes(route)) return { data: [] };
    if (method === "GET" && route === "/session/status") {
      return { data: state.aborted ? {} : { [sessionId]: statusFor() } };
    }
    throw new Error(`unexpected ${method} ${route}`);
  };
  return state;
}

test("a free-tier limit retry is stopped natively and settled as a quota failure", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-quota-");
  const sessionId = "ses_quotatest12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  const client = stoppingClient(sessionId, () => ({ type: "retry", attempt: 1,
    message: "Free usage exceeded, subscribe to Go", action: { reason: "free_tier_limit" },
    next: Date.now() + 3 * 60 * 60_000 }), { name: "MessageAbortedError", data: { message: "Aborted" } });
  const host = fixture.host(ledger, client.request);
  const { events, settled } = completion(host);
  try {
    await host.turnStart({ sessionId, operationId: "quota", prompt: "work",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    const result = await settled;
    assert.deepEqual([result.status, result.errorCode], ["failed", "RUNTIME_QUOTA_EXHAUSTED"]);
    assert.equal(client.routes.filter(route => route.endsWith("/abort")).length, 1);
    const turn = ledger.snapshot().sessions[0].turns[0];
    assert.deepEqual([turn.status, turn.errorCode], ["failed", "RUNTIME_QUOTA_EXHAUSTED"]);
    assert.equal(events.some(event => event.type === "status" && event.status === "retrying"), false);
    assert.equal(JSON.stringify(events).includes("subscribe to Go"), false);
    const read = await host.sessionRead({ sessionId, includeTurns: true });
    assert.equal(read.session.turns[0].status, "failed");
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

test("a rate-limit retry scheduled beyond two minutes is stopped instead of held", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-farretry-");
  const sessionId = "ses_farretry12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  const client = stoppingClient(sessionId, () => ({ type: "retry", attempt: 2,
    message: "Rate limit exceeded. Please try again later.", next: Date.now() + 10 * 60_000 }),
  { name: "MessageAbortedError", data: { message: "Aborted" } });
  const host = fixture.host(ledger, client.request);
  const { settled } = completion(host);
  try {
    await host.turnStart({ sessionId, operationId: "far-retry", prompt: "work",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    const result = await settled;
    assert.deepEqual([result.status, result.errorCode], ["failed", "RUNTIME_RATE_LIMITED"]);
    assert.equal(client.aborted, true);
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

test("a turn past its deadline is aborted natively and settled as interrupted with partial output", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-deadline-");
  const sessionId = "ses_deadline12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  let clock = 1_000_000;
  const client = stoppingClient(sessionId, () => { clock += 31 * 60_000; return { type: "busy" }; },
    { name: "MessageAbortedError", data: { message: "Aborted" } });
  const host = fixture.host(ledger, client.request, () => clock);
  const { events, settled } = completion(host);
  try {
    await host.turnStart({ sessionId, operationId: "deadline", prompt: "work",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    const result = await settled;
    assert.deepEqual([result.status, result.errorCode], ["interrupted", "OPENCODE_TURN_TIMEOUT"]);
    const turn = ledger.snapshot().sessions[0].turns[0];
    assert.deepEqual(turn.assistantMessages, [{ id: "prt_partial", text: "partial" }]);
    assert.equal(events.filter(event => event.type === "text").length, 1);
    await host.turnStart({ sessionId, operationId: "after-timeout", prompt: "next",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    assert.equal(client.routes.filter(route => route.endsWith("/prompt_async")).length, 2);
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

test("provider rate limit is visible while OpenCode retries and remains safe on terminal failure", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-opencode-retry-")));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const account = "native-opencode-default-v1", profile = "retry-status-test";
  const policy = { approvalPolicy: "on-request", sandbox: "danger-full-access" };
  const host = new OpenCodeRuntimeHost({
    paths: { stateDir: path.join(root, "state"), trustedRoot: root },
    runtimeBinding: { runtime: "opencode", runtimeProfileId: profile, runtimeAccountId: account },
    runtimeEnvironment: Object.freeze({ runtime: "opencode", runtimeAccountId: account,
      home: root, binaryPath: "/bin/true", configurationMode: "native",
      configSourceHome: root, launchArgs: Object.freeze([]),
      spawnEnv: Object.freeze({ HOME: root, XDG_DATA_HOME: root }) }),
    workspace, permissionPolicy: policy,
  });
  const ledger = new OpenCodeRuntimeLedger({ runtimeProfileId: profile, runtimeAccountId: account,
    workspaceShardId: "b".repeat(64), stateRoot: path.join(root, "state", "runtime-ledgers", "opencode"),
    trustedRoot: root }).open();
  const sessionId = "ses_retrytest12345";
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  host.ledger = ledger;
  host.state = "ready";
  let userMessageId = null, statusReads = 0, prompts = 0;
  const privateError = "Rate limit exceeded. private provider trace must not leave the host";
  host.client = { request: async (method, route, body) => {
    if (method === "POST" && route === `/session/${sessionId}/prompt_async`) {
      prompts += 1;
      userMessageId = body.messageID;
      return { status: 204, data: null };
    }
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) {
      return { data: [
        { info: { id: userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
        { info: { id: "msg_assistant12345", sessionID: sessionId, role: "assistant",
          parentID: userMessageId,
          ...(statusReads >= 2 ? { time: { completed: Date.now() },
            error: { name: "APIError", data: { statusCode: 429, message: privateError } } } : {}) },
        parts: [] },
      ] };
    }
    if (method === "GET" && ["/permission", "/question"].includes(route)) return { data: [] };
    if (method === "GET" && route === "/session/status") {
      statusReads += 1;
      return { data: { [sessionId]: statusReads === 1
        ? { type: "retry", attempt: 1, message: privateError, next: Date.now() + 5000 }
        : { type: statusReads === 2 ? "busy" : "idle" } } };
    }
    throw new Error(`unexpected ${method} ${route}`);
  } };
  const events = [];
  const completed = new Promise(resolve => host.subscribe(event => {
    events.push(event);
    if (event.type === "complete") resolve(event);
  }));
  let completionTimer;
  try {
    const started = await host.turnStart({ sessionId, operationId: "retry-operation",
      prompt: "test", cwd: workspace, permissionPolicy: policy });
    assert.equal(started.turn.status, "inProgress");
    const result = await Promise.race([completed, new Promise((_, reject) =>
      { completionTimer = setTimeout(() => reject(new Error("OpenCode retry did not settle")), 3000); })]);
    assert.equal(result.status, "failed");
    assert.deepEqual(events.filter(event => event.type === "status")
      .map(event => ({ status: event.status, reason: event.reason })), [
        { status: "retrying", reason: "RUNTIME_RATE_LIMITED" },
        { status: "running", reason: undefined },
      ]);
    assert.equal(host.sessionList().data[0].id, sessionId);
    assert.equal(ledger.snapshot().sessions[0].turns[0].errorCode, "RUNTIME_RATE_LIMITED");
    assert.equal(JSON.stringify(events).includes(privateError), false);
    assert.equal(prompts, 1);
  } finally {
    clearTimeout(completionTimer);
    host.state = "stopped";
    fs.rmSync(root, { recursive: true, force: true });
  }
});
