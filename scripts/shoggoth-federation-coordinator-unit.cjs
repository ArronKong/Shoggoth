#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { FederationCoordinator } = require("../app/agent-service/federation-coordinator");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function expectCode(action, code) {
  return assert.rejects(action, (error) => error?.code === code);
}

function fixture() {
  const profiles = [{
    id: "profile-one", backendId: "shoggoth", agentId: "native-one", name: "Native One",
    enabled: true, defaultModel: "model-one", providerRef: "provider-one",
  }, {
    id: "profile-two", backendId: "codex", agentId: "native-two", name: "Native Two",
    enabled: true, defaultModel: null, providerRef: null,
  }];
  const runs = new Map();
  const calls = [];
  const offlineExternal = new Set(["hermes"]);
  const backendStates = new Map(profiles.map((profile) => [profile.backendId, {
    id: profile.backendId, connected: true, disabled: false,
  }]));
  let runSequence = 0;
  let externalTask = null;
  const productStore = {
    listAgentProfiles: () => structuredClone(profiles),
    getAgentProfile: (id) => structuredClone(profiles.find((profile) => profile.id === id) || null),
  };
  const chat = {
    async handle(method, params) {
      calls.push([method, structuredClone(params)]);
      if (method === "chat.session.create") {
        return { session: { sessionKey: `native-session-${params.profileId}` } };
      }
      if (method === "chat.send") {
        const profileId = params.sessionKey.endsWith("profile-two") ? "profile-two" : "profile-one";
        const run = { id: `native-run-${++runSequence}`, profileId, source: "chat",
          sourceId: params.sessionKey, status: "running", resultSummary: null, errorCode: null };
        runs.set(run.id, run);
        return { run: structuredClone(run) };
      }
      if (method === "chat.steer") return { accepted: true };
      if (method === "chat.abort") {
        const run = { ...runs.get(params.runId), status: "canceled" };
        runs.set(run.id, run);
        return { run: structuredClone(run) };
      }
      throw new Error("unexpected chat method");
    },
  };
  const federationClient = {
    async request(method, params) {
      calls.push([method, structuredClone(params)]);
      if (method === "backend.status") return { backends: [...backendStates.values()] };
      if (method === "agent.list") {
        if (offlineExternal.has(params.backendId)) {
          const error = new Error("offline"); error.code = "BACKEND_UNAVAILABLE"; throw error;
        }
        return { backendId: "openclaw", agents: [{
          id: "open-agent", name: "Open Agent", model: "open-model", provider: "open-provider",
        }] };
      }
      if (method === "agent.get") return { agent: {
        id: params.agentId, name: "Open Agent", model: "open-model", provider: "open-provider",
      } };
      if (method === "federation.run") {
        externalTask = { taskId: "external-task", sessionKey: "external-session", status: "running",
          turn: 1, waitingFor: null, result: null, errorCode: null };
        return { task: structuredClone(externalTask) };
      }
      if (method === "federation.message") {
        if (params.expectedTurn !== externalTask.turn) {
          const error = new Error("stale"); error.code = "FEDERATION_TASK_STATE_CONFLICT"; throw error;
        }
        externalTask = { ...externalTask, turn: externalTask.turn + 1, status: "running" };
        return { task: structuredClone(externalTask) };
      }
      if (method === "federation.task.get") return { task: structuredClone(externalTask) };
      if (method === "federation.task.cancel") {
        externalTask = { ...externalTask, status: "canceled" };
        return { task: structuredClone(externalTask) };
      }
      throw new Error(`unexpected federation method ${method}`);
    },
  };
  const secret = Buffer.alloc(32, 7);
  const makeCoordinator = (options = {}) => new FederationCoordinator({
    productStore,
    federationClient,
    getChatServiceController: () => chat,
    getWorkRunCoordinator: () => ({ getRun: (id) => structuredClone(runs.get(id) || null) }),
    handleSecret: secret,
    now: () => 100,
    taskGetWaitMs: 0,
    ...options,
  });
  return { backendStates, calls, makeCoordinator, profiles, runs, offlineExternal };
}

const nativeAuthority = { profileId: "profile-one", callId: "call-one" };

test("统一目录合并原生与外部 Agent，并隔离单个不可用后端", async () => {
  const value = fixture();
  const listed = await value.makeCoordinator().list({ backendId: null });
  assert.deepEqual(listed.agents.map((agent) => [agent.backendId, agent.agentId]), [
    ["codex", "native-two"], ["openclaw", "open-agent"], ["shoggoth", "native-one"],
  ]);
  assert.deepEqual(listed.unavailableBackends, ["hermes"]);
  assert.deepEqual(
    await value.makeCoordinator().list({ backendId: "openclaw" }),
    listed,
    "统一目录不能因为调用方误传当前后端而隐藏原生 Agent",
  );
  const native = await value.makeCoordinator().get({ backendId: "codex", agentId: "native-two" });
  assert.equal(native.agent.kind, "native");
});

test("已启用 Profile 不等于已连接：七个原生 Agent 只有两个实际连接", async () => {
  const value = fixture();
  value.offlineExternal.add("openclaw");
  const ids = ["shoggoth", "deepseek-harness", "codex", "grok-build", "pi", "claude-code", "antigravity"];
  value.profiles.splice(0, value.profiles.length, ...ids.map((id) => ({
    id, backendId: id, agentId: id, name: id, enabled: true,
    defaultModel: null, providerRef: null,
  })));
  for (const id of ids) value.backendStates.set(id, {
    id, connected: true, disabled: !["shoggoth", "deepseek-harness"].includes(id),
  });
  const coordinator = value.makeCoordinator();
  const listed = await coordinator.list();
  assert.deepEqual(listed.agents.filter((agent) => agent.connected)
    .map((agent) => agent.backendId), ["deepseek-harness", "shoggoth"]);
  assert.equal(listed.agents.filter((agent) => agent.kind === "native").length, 7);
  for (const id of ids.slice(2)) assert.ok(listed.unavailableBackends.includes(id));
  assert.equal((await coordinator.get({ backendId: "codex", agentId: "codex" })).agent.connected, false);
  await expectCode(() => coordinator.run({ backendId: "codex", agentId: "codex",
    prompt: "do not run", operationId: "offline", createdAt: 1,
  }, nativeAuthority), "BACKEND_UNAVAILABLE");
  assert.equal(value.calls.some(([method]) => method.startsWith("chat.")), false);
  value.backendStates.set("codex", { id: "codex", connected: true, disabled: false });
  assert.equal((await coordinator.get({ backendId: "codex", agentId: "codex" })).agent.connected, true);
});

test("连接状态丢失、损坏或 Host 不可用时不把持久 Profile 当成在线", async () => {
  const value = fixture();
  for (const status of [null, { backends: [{ id: "shoggoth", connected: true }] },
    { backends: [{ id: "shoggoth", connected: true, disabled: false },
      { id: "shoggoth", connected: true, disabled: false }] }]) {
    const coordinator = value.makeCoordinator({ federationClient: {
      async request(method) {
        if (method === "backend.status" && status !== null) return status;
        throw Object.assign(new Error("host unavailable"), { code: "APP_HOST_UNAVAILABLE" });
      },
    } });
    assert.ok((await coordinator.list()).agents.every(agent => agent.connected === false));
  }
});

test("App 状态未知时不虚报连接，既有任务仍可读取和取消", async () => {
  const value = fixture();
  const coordinator = value.makeCoordinator();
  const started = await coordinator.run({ backendId: "codex", agentId: "native-two",
    prompt: "work", operationId: "before-disconnect", createdAt: 1,
  }, nativeAuthority);
  value.backendStates.clear();
  assert.ok((await coordinator.list()).agents.filter((agent) => agent.kind === "native")
    .every((agent) => agent.connected === false));
  assert.equal((await coordinator.taskGet({ handle: started.handle }, nativeAuthority)).task.status, "running");
  await expectCode(() => coordinator.message({ handle: started.handle, message: "do not steer",
    operationId: "offline-message", createdAt: 2,
  }, nativeAuthority), "BACKEND_UNAVAILABLE");
  assert.equal((await coordinator.cancel({ handle: started.handle, operationId: "cancel", createdAt: 3 },
    nativeAuthority)).task.status, "canceled");
});

test("原生 Agent 可派活给其他原生 Agent、查询、续聊与取消，句柄绑定调用方", async () => {
  const value = fixture();
  const coordinator = value.makeCoordinator();
  await expectCode(() => coordinator.run({
    backendId: "shoggoth", agentId: "native-one", prompt: "self", timeoutMs: 5_000,
    operationId: "operation-self", createdAt: 1,
  }, nativeAuthority), "FEDERATION_SELF_DISPATCH");

  const started = await coordinator.run({
    backendId: "codex", agentId: "native-two", prompt: "work", timeoutMs: 5_000,
    operationId: "operation-run", createdAt: 1,
  }, nativeAuthority);
  assert.equal(started.task.status, "running");
  assert.equal(started.agent.agentId, "native-two");
  await expectCode(() => coordinator.taskGet({ handle: started.handle }, {
    profileId: "profile-two", callId: "call-two",
  }), "FEDERATION_HANDLE_FORBIDDEN");

  const current = await coordinator.taskGet({ handle: started.handle }, nativeAuthority);
  assert.equal(current.task.taskId, started.task.taskId);
  value.runs.set(started.task.taskId, {
    ...value.runs.get(started.task.taskId), status: "completed", resultSummary: "first done",
  });
  const continued = await coordinator.message({
    handle: started.handle, message: "continue", timeoutMs: 5_000,
    operationId: "operation-message", createdAt: 2,
  }, nativeAuthority);
  assert.equal(continued.task.turn, 2);
  await expectCode(() => coordinator.taskGet({ handle: started.handle }, nativeAuthority),
    "FEDERATION_HANDLE_STALE");
  const canceled = await coordinator.cancel({
    handle: continued.handle, operationId: "operation-cancel", createdAt: 3,
  }, nativeAuthority);
  assert.equal(canceled.task.status, "canceled");
});

test("运行中的原生联邦任务会在单次查询内等待并返回稍后的完成消息", async () => {
  const value = fixture();
  const coordinator = value.makeCoordinator({ taskGetWaitMs: 100, taskGetPollMs: 5 });
  const openAuthority = {
    profileId: "profile-one", callId: "open-wait-call", federationClient: "openclaw",
  };
  const started = await coordinator.run({
    backendId: "codex", agentId: "native-two", prompt: "send a message", timeoutMs: 5_000,
    operationId: "operation-wait", createdAt: 1,
  }, openAuthority);
  setTimeout(() => {
    value.runs.set(started.task.taskId, {
      ...value.runs.get(started.task.taskId),
      status: "completed",
      resultSummary: "delayed peer message",
    });
  }, 20);

  const completed = await coordinator.taskGet({ handle: started.handle }, openAuthority);

  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.result, "delayed peer message");
});

test("OpenClaw/Hermes 句柄独立绑定，外部调用方可派活给默认原生 Agent", async () => {
  const value = fixture();
  const coordinator = value.makeCoordinator();
  const openAuthority = {
    profileId: "profile-one", callId: "open-call", federationClient: "openclaw",
  };
  const native = await coordinator.run({
    backendId: "shoggoth", agentId: "native-one", prompt: "from openclaw", timeoutMs: 5_000,
    operationId: "operation-native", createdAt: 1,
  }, openAuthority);
  assert.equal(native.agent.agentId, "native-one");

  const external = await coordinator.run({
    backendId: "openclaw", agentId: "open-agent", prompt: "external", timeoutMs: 5_000,
    operationId: "operation-external", createdAt: 1,
  }, nativeAuthority);
  const continued = await coordinator.message({
    handle: external.handle, message: "next", timeoutMs: 5_000,
    operationId: "operation-next", createdAt: 2,
  }, nativeAuthority);
  assert.equal(continued.task.turn, 2);
  const refreshed = await value.makeCoordinator().taskGet(
    { handle: continued.handle }, nativeAuthority,
  );
  assert.equal(refreshed.task.turn, 2, "同一持久 handle secret 可跨 Coordinator 重建验证");
  await expectCode(() => coordinator.taskGet({ handle: external.handle }, {
    profileId: "profile-one", callId: "hermes-call", federationClient: "hermes",
  }), "FEDERATION_HANDLE_FORBIDDEN");
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(error?.stack || error);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
})();
