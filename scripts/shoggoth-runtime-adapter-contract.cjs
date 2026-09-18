#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  RUNTIME_CAPABILITY_KEYS,
  assertRuntimeAdapter,
  readRuntimeAuthenticationState,
  runtimeBinding,
  runtimeCapabilities,
  runtimeSessionRef,
  runtimeTurnRef,
} = require(path.join(ROOT, "app", "agent-service", "runtime-adapter.js"));
const {
  CodexRuntimeAdapter,
} = require(path.join(ROOT, "app", "agent-service", "codex-runtime-adapter.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

test("Runtime Binding 与 session/turn refs 是严格、Runtime-neutral 的 DTO", () => {
  const binding = runtimeBinding({
    runtime: "future",
    runtimeProfileId: "profile-a",
    runtimeAccountId: "account-a",
  });
  assert.deepEqual(binding, {
    runtime: "future", runtimeProfileId: "profile-a", runtimeAccountId: "account-a",
  });
  assert.equal(Object.isFrozen(binding), true);
  assert.deepEqual(runtimeSessionRef(binding, "session-a"), {
    runtime: "future", runtimeProfileId: "profile-a", runtimeAccountId: "account-a",
    sessionId: "session-a",
  });
  assert.deepEqual(runtimeTurnRef(binding, "session-a", "turn-a"), {
    runtime: "future", runtimeProfileId: "profile-a", runtimeAccountId: "account-a",
    sessionId: "session-a", turnId: "turn-a",
  });
  assert.throws(
    () => runtimeBinding({
      runtime: "future", runtimeProfileId: "../escape", runtimeAccountId: "account-a",
    }),
    (error) => error.code === "RUNTIME_BINDING_INVALID",
  );
  assert.throws(
    () => runtimeBinding({ runtime: "future", runtimeProfileId: "profile-a" }),
    (error) => error.code === "RUNTIME_BINDING_INVALID",
  );
  assert.throws(
    () => runtimeBinding({
      runtime: "future", runtimeProfileId: "profile-a", runtimeAccountId: "../escape",
    }),
    (error) => error.code === "RUNTIME_BINDING_INVALID",
  );
  assert.throws(
    () => runtimeSessionRef(binding, ""),
    (error) => error.code === "RUNTIME_REF_INVALID",
  );
});

test("Capability matrix 完整、严格且未知能力不能静默进入", () => {
  const capabilities = runtimeCapabilities({
    "session.start": true,
    "session.read": true,
    "turn.start": true,
  });
  assert.deepEqual(Object.keys(capabilities), RUNTIME_CAPABILITY_KEYS);
  assert.equal(capabilities["session.start"], true);
  assert.equal(capabilities["session.delete"], false);
  assert.throws(
    () => runtimeCapabilities({ "future.magic": true }),
    (error) => error.code === "RUNTIME_CAPABILITIES_INVALID",
  );
});

test("Runtime 认证状态统一归一化，且不泄漏 Runtime 原始响应", async () => {
  const codexRequired = await readRuntimeAuthenticationState({
    async accountRead(params) {
      assert.deepEqual(params, { refreshToken: false });
      return { account: null, requiresOpenaiAuth: true, login: null };
    },
  });
  assert.deepEqual(codexRequired, { status: "unauthenticated" });
  assert.equal(Object.isFrozen(codexRequired), true);

  assert.deepEqual(await readRuntimeAuthenticationState({
    async accountRead() {
      return {
        account: null,
        requiresOpenaiAuth: false,
        login: null,
        secretThatMustNotEscape: "opaque",
      };
    },
  }), { status: "authenticated" });
  assert.deepEqual(await readRuntimeAuthenticationState({
    async accountRead() {
      return {
        account: { type: "chatgpt", accessToken: "opaque" },
        requiresOpenaiAuth: true,
        login: null,
      };
    },
  }), { status: "authenticated" });

  assert.deepEqual(await readRuntimeAuthenticationState({
    authenticationState() {
      return { authenticated: false, credentialPresent: false, methods: [] };
    },
  }), { status: "unauthenticated" });
  assert.deepEqual(await readRuntimeAuthenticationState({
    authenticationState() {
      return { authenticated: false, credentialPresent: true, methods: ["grok.com"] };
    },
  }), { status: "unverified" });
  assert.deepEqual(await readRuntimeAuthenticationState({
    authenticationState() {
      return { authenticated: true, credentialPresent: true, methods: ["grok.com"] };
    },
  }), { status: "authenticated" });
  assert.deepEqual(await readRuntimeAuthenticationState({}), { status: "unsupported" });

  await assert.rejects(
    () => readRuntimeAuthenticationState({
      async accountRead() {
        throw new Error("secret runtime detail");
      },
    }),
    (error) => error.code === "RUNTIME_AUTH_STATUS_UNAVAILABLE"
      && error.message === "Runtime auth status is unavailable"
      && !error.message.includes("secret"),
  );
  await assert.rejects(
    () => readRuntimeAuthenticationState({
      authenticationState() {
        return { authenticated: false, credentialPresent: "yes" };
      },
    }),
    (error) => error.code === "RUNTIME_AUTH_STATUS_INVALID",
  );
  await assert.rejects(
    () => readRuntimeAuthenticationState({
      async accountRead() {
        return new Proxy({}, {
          getPrototypeOf() { throw new Error("secret response detail"); },
        });
      },
    }),
    (error) => error.code === "RUNTIME_AUTH_STATUS_INVALID"
      && !error.message.includes("secret"),
  );
});

test("fake Future Runtime 可只实现通用 Adapter 契约", async () => {
  const calls = [];
  const handle = Object.freeze({
    runtime: "future",
    runtimeProfileId: "profile-future",
    capabilities: runtimeCapabilities({ "session.start": true, "turn.start": true }),
    async sessionStart(input) {
      calls.push(["sessionStart", input]);
      return { session: { id: "future-session", source: input.source } };
    },
    async turnStart(input) {
      calls.push(["turnStart", input]);
      return { turn: { id: "future-turn" } };
    },
  });
  const future = {
    acquire(binding) {
      assert.deepEqual(binding, {
        runtime: "future",
        runtimeProfileId: "profile-future",
        runtimeAccountId: "account-future",
      });
      return Promise.resolve(handle);
    },
    stop(binding) { calls.push(["stop", binding]); },
    stopAll() { calls.push(["stopAll"]); },
  };
  assert.equal(assertRuntimeAdapter(future), true);
  const acquired = await future.acquire(runtimeBinding({
    runtime: "future", runtimeProfileId: "profile-future", runtimeAccountId: "account-future",
  }));
  const session = await acquired.sessionStart({ source: "chat:1" });
  const turn = await acquired.turnStart({
    sessionId: session.session.id,
    operationId: "operation-1",
    prompt: "hello",
  });
  assert.equal(turn.turn.id, "future-turn");
  assert.deepEqual(calls.map(([name]) => name), ["sessionStart", "turnStart"]);
});

test("Codex Adapter 把通用 session/turn 参数映射到现有 Host，且 refs 不泄漏 RPC 名", async () => {
  const calls = [];
  const termination = deferred();
  const listeners = new Set();
  let codexGoal = null;
  const host = {
    registeredSecrets: ["opaque-secret"],
    terminated: termination.promise,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeAccountAuth() { return () => {}; },
    registerServerRequestHandler(method, handler) {
      calls.push(["register", method, handler]);
      return () => {};
    },
    async threadStart(params) {
      calls.push(["threadStart", params]);
      return { thread: { id: "codex-thread", threadSource: params.threadSource, turns: [] } };
    },
    async threadResume(params) {
      calls.push(["threadResume", params]);
      return { thread: { id: params.threadId, threadSource: "chat:1", turns: [] } };
    },
    async threadRead(params) {
      calls.push(["threadRead", params]);
      return { thread: { id: params.threadId, threadSource: "chat:1", turns: [] } };
    },
    async threadList(params) {
      calls.push(["threadList", params]);
      return { data: [{ id: "codex-thread", threadSource: "chat:1", archived: false }], nextCursor: null };
    },
    async turnStart(params) {
      calls.push(["turnStart", params]);
      return { turn: { id: "codex-turn" } };
    },
    async turnSteer(params) { calls.push(["turnSteer", params]); return { turnId: params.expectedTurnId }; },
    async turnInterrupt(params) { calls.push(["turnInterrupt", params]); return {}; },
    async threadCompactStart(params) { calls.push(["threadCompactStart", params]); return {}; },
    async threadGoalSet(params) {
      calls.push(["threadGoalSet", params]);
      codexGoal = {
        objective: params.objective ?? codexGoal?.objective ?? "",
        status: params.status ?? codexGoal?.status ?? "active",
      };
      return { goal: codexGoal };
    },
    async threadGoalGet(params) { calls.push(["threadGoalGet", params]); return { goal: codexGoal }; },
    async threadGoalClear(params) {
      calls.push(["threadGoalClear", params]);
      const cleared = codexGoal !== null;
      codexGoal = null;
      return { cleared };
    },
    async mcpServerStatusList(params) {
      calls.push(["mcpServerStatusList", params]);
      return {
        data: [{
          name: "filesystem", authStatus: "unsupported",
          serverInfo: null, tools: { read_file: {}, write_file: {} },
        }],
        nextCursor: null,
      };
    },
    async skillsList(params) {
      calls.push(["skillsList", params]);
      return { data: [{
        cwd: "/tmp/workspace", errors: [],
        skills: [{ name: "review", enabled: true, description: "Review changes" }],
      }] };
    },
  };
  const pool = {
    async get(binding) { calls.push(["pool.get", binding]); return host; },
    async stop(runtimeProfileId) { calls.push(["pool.stop", runtimeProfileId]); },
    async stopAll() { calls.push(["pool.stopAll"]); },
  };
  const adapter = new CodexRuntimeAdapter({ runtimePool: pool });
  assert.equal(assertRuntimeAdapter(adapter), true);
  const binding = runtimeBinding({
    runtime: "codex",
    runtimeProfileId: "profile-codex",
    runtimeAccountId: "account-codex",
  });
  const runtime = await adapter.acquire(binding);
  assert.equal(runtime.runtime, "codex");
  assert.equal(runtime.runtimeProfileId, "profile-codex");
  assert.equal(runtime.runtimeAccountId, "account-codex");
  assert.equal(runtime.capabilities["commands.list"], true);
  assert.equal(runtime.capabilities["commands.execute"], true);
  assert.deepEqual(calls.find(([name]) => name === "pool.get")[1], binding);
  assert.deepEqual(runtime.registeredSecrets, ["opaque-secret"]);

  const started = await runtime.sessionStart({
    source: "chat:1",
    persistent: true,
    developerInstructions: "stable",
    model: "gpt-test",
    cwd: "/tmp/workspace",
    permissionPolicy: { approvalPolicy: "on-failure", sandbox: "workspace-write" },
  });
  assert.deepEqual(started.session, {
    id: "codex-thread", source: "chat:1", turns: [],
  });
  await runtime.sessionResume({
    sessionId: "codex-thread",
    developerInstructions: "stable",
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" },
  });
  await runtime.sessionRead({ sessionId: "codex-thread", includeTurns: true });
  const listed = await runtime.sessionList({ limit: 100, archived: false });
  assert.deepEqual(listed.data[0], { id: "codex-thread", source: "chat:1", archived: false });
  await runtime.turnStart({
    sessionId: "codex-thread",
    operationId: "operation-1",
    prompt: "hello",
    context: "BEGIN UNTRUSTED MEMORY DATA\nremembered preference\nEND UNTRUSTED MEMORY DATA",
    model: "gpt-test",
    cwd: "/tmp/workspace",
    permissionPolicy: { approvalPolicy: "on-failure", sandbox: "workspace-write" },
  });
  await runtime.turnSteer({
    sessionId: "codex-thread", turnId: "codex-turn", operationId: "operation-2", message: "more",
  });
  await runtime.turnInterrupt({ sessionId: "codex-thread", turnId: "codex-turn" });
  const commands = await runtime.commandsList();
  assert.equal(commands.reason, null);
  assert.deepEqual(commands.commands.filter((command) => command.execution === "runtime")
    .map((command) => command.name), ["compact", "goal", "mcp", "skills", "pwd"]);
  assert.equal(commands.commands.find((command) => command.name === "clear").execution, "client");
  assert.equal(commands.commands.find((command) => command.name === "theme").execution, "cli");
  assert.deepEqual(await runtime.commandExecute({ sessionId: null, cwd: "/tmp/workspace", text: "/cwd" }),
    { kind: "output", text: "/tmp/workspace", warning: null });
  await assert.rejects(runtime.commandExecute({ sessionId: null, cwd: "/tmp/workspace", text: "/theme" }),
    { code: "RUNTIME_COMMAND_CLI_ONLY" });
  assert.deepEqual(await runtime.commandExecute({
    sessionId: "codex-thread", cwd: "/tmp/workspace", text: "/compact",
  }), { kind: "output", text: "Codex conversation compaction started.", warning: null });
  assert.deepEqual(await runtime.commandExecute({
    sessionId: "codex-thread", cwd: "/tmp/workspace", text: "/goal Ship it",
  }), { kind: "output", text: "Codex goal set: Ship it", warning: null });
  assert.deepEqual(await runtime.commandExecute({
    sessionId: "codex-thread", cwd: "/tmp/workspace", text: "/goal pause",
  }), { kind: "output", text: "Codex goal paused: Ship it", warning: null });
  assert.deepEqual(await runtime.commandExecute({
    sessionId: "codex-thread", cwd: "/tmp/workspace", text: "/goal clear",
  }), { kind: "output", text: "Codex goal cleared.", warning: null });
  assert.deepEqual(await runtime.commandExecute({
    sessionId: "codex-thread", cwd: "/tmp/workspace", text: "/mcp",
  }), {
    kind: "output",
    text: "Codex MCP servers:\n- filesystem — unsupported; 2 tool(s)",
    warning: null,
  });
  assert.deepEqual(await runtime.commandExecute({
    sessionId: "codex-thread", cwd: "/tmp/workspace", text: "/skills review",
  }), { kind: "prefill", text: "$review ", warning: null });
  assert.deepEqual(calls.find(([name]) => name === "threadCompactStart")[1], {
    threadId: "codex-thread",
  });

  const threadStart = calls.find(([name]) => name === "threadStart")[1];
  assert.deepEqual(threadStart, {
    threadSource: "chat:1",
    ephemeral: false,
    developerInstructions: "stable",
    model: "gpt-test",
    cwd: "/tmp/workspace",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  const turnStart = calls.find(([name]) => name === "turnStart")[1];
  assert.deepEqual(turnStart.input, [{
    type: "text",
    text: [
      "BEGIN UNTRUSTED MEMORY DATA",
      "remembered preference",
      "END UNTRUSTED MEMORY DATA",
      "",
      "CURRENT USER REQUEST",
      "hello",
    ].join("\n"),
    text_elements: [],
  }]);
  assert.equal(turnStart.threadId, "codex-thread");
  assert.equal(turnStart.clientUserMessageId, "operation-1");
  assert.equal(turnStart.approvalPolicy, "on-request");
  assert.equal(Object.hasOwn(turnStart, "sessionId"), false);

  let mappedEvent;
  runtime.subscribe((event) => { mappedEvent = event; });
  for (const listener of listeners) listener({ type: "turn", threadId: "codex-thread", turnId: "codex-turn" });
  assert.equal(mappedEvent.sessionId, "codex-thread");
  assert.equal(mappedEvent.turnId, "codex-turn");
  await adapter.stop(binding);
  await adapter.stopAll();
  assert.equal(calls.some(([name]) => name === "pool.stop"), true);
  assert.equal(calls.some(([name]) => name === "pool.stopAll"), true);
  termination.resolve();
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS shoggoth runtime adapter contract (${tests.length})`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
