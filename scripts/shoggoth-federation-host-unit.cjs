#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FederationHostClient } = require("../app/agent-service/federation-host-client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createFederationHostServer } = require("../app/federation-host-server");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function operation(char) {
  return `mcp-v1-${char.repeat(48)}`;
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => error?.code === code
    && !String(error?.message).includes("fixture-private-canary"));
}

function createFixture() {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-federation-"));
  fs.chmodSync(trustedRoot, 0o700);
  const paths = resolveServicePaths({
    trustedRoot,
    stateRoot: path.join(trustedRoot, "state"),
    profileRoot: path.join(trustedRoot, "profile"),
    cacheRoot: path.join(trustedRoot, "cache"),
  });
  const calls = [];
  const agents = new Map([
    ["agent-1", {
      id: "agent-1", name: "One", model: "fixture-model", provider: "fixture-provider",
      workspace: "/tmp/agent-1", profile: "default", emoji: "🧪", fallbacks: [], files: [],
    }],
  ]);
  const files = new Map([["agent-1\0AGENTS.md", "existing body"]]);
  let sequence = 1;
  const backend = {
    async listAgents() {
      calls.push(["listAgents"]);
      return [...agents.values()].map((item) => structuredClone(item));
    },
    async getAgent(id) {
      calls.push(["getAgent", id]);
      const value = agents.get(id);
      if (!value) throw new Error("fixture-private-canary missing agent");
      return structuredClone(value);
    },
    async createAgent(spec) {
      calls.push(["createAgent", structuredClone(spec)]);
      const id = `created-${sequence++}`;
      agents.set(id, { id, name: spec.name, workspace: spec.workspace ?? null,
        model: spec.model ?? null, provider: null, emoji: spec.emoji ?? null,
        profile: null, fallbacks: [], files: [] });
      return { id };
    },
    async updateAgent(id, patch) {
      calls.push(["updateAgent", id, structuredClone(patch)]);
      const current = agents.get(id);
      if (!current) throw new Error("fixture-private-canary missing agent");
      agents.set(id, { ...current, ...structuredClone(patch) });
      return { id };
    },
    async deleteAgent(id, options) {
      calls.push(["deleteAgent", id, structuredClone(options)]);
      if (!agents.delete(id)) throw new Error("fixture-private-canary missing agent");
    },
    async listAgentFiles(id) {
      calls.push(["listAgentFiles", id]);
      return [...files.entries()].filter(([key]) => key.startsWith(`${id}\0`))
        .map(([key, content]) => ({ name: key.split("\0")[1], size: Buffer.byteLength(content) }));
    },
    async getAgentFile(id, name) {
      calls.push(["getAgentFile", id, name]);
      const key = `${id}\0${name}`;
      return files.has(key)
        ? { name, content: files.get(key), missing: false }
        : { name, content: "", missing: true };
    },
    async setAgentFile(id, name, content) {
      calls.push(["setAgentFile", id, name, content]);
      files.set(`${id}\0${name}`, content);
    },
    async getAgentChannels(id) {
      calls.push(["getAgentChannels", id]);
      return [{ id: "web", type: "web", status: "connected", label: "Web" }];
    },
    async listAgentArtifacts(id, options) {
      calls.push(["listAgentArtifacts", id, structuredClone(options)]);
      return { supported: true, total: 1, items: [{
        path: "/tmp/result.txt", name: "result.txt", area: "workspace",
        size: 2, mtimeMs: 1, ext: ".txt", kind: "file",
      }] };
    },
    async getCronJobs() {
      calls.push(["getCronJobs"]);
      return [{
        id: "openclaw:cron-1", backendId: "openclaw", agentId: "agent-1",
        name: "Fixture cron", description: "Safe description", prompt: "fixture-private-canary prompt",
        schedule: { kind: "cron", expr: "0 9 * * *" }, scheduleDisplay: "0 9 * * *",
        enabled: true, state: "scheduled", stateLabel: "scheduled", createdAt: 10,
        lastRunAt: 20, lastStatus: "ok", lastError: "fixture-private-canary error",
        nextRunAt: 30, model: "fixture-model", provider: "fixture-provider",
        workdir: "/fixture-private-canary/workdir",
      }, {
        id: "openclaw:cron-2", backendId: "openclaw", name: "Disabled cron",
        schedule: { kind: "every", everyMs: 60_000 }, enabled: false,
      }];
    },
  };
  const registry = {
    async getStatus() {
      calls.push(["getStatus"]);
      return [
        { id: "openclaw", name: "OpenClaw", connected: true,
          info: { version: "1.2.3", agentCount: agents.size } },
        { id: "hermes", name: "Hermes", connected: false,
          info: { error: "fixture-private-canary backend failed" } },
      ];
    },
    getBackend(id) {
      calls.push(["getBackend", id]);
      return id === "openclaw" ? backend : null;
    },
  };
  let delegateCalls = 0;
  let task = null;
  let taskRuns = 0;
  const taskRunner = {
    async run(input) {
      taskRuns += 1;
      task = { taskId: "federation-task-1", sessionKey: "session-task-1", status: "running",
        turn: 1, waitingFor: null, result: null, errorCode: null };
      calls.push(["task.run", structuredClone(input)]);
      return structuredClone(task);
    },
    async message(input) {
      if (!task || input.expectedTurn !== task.turn) {
        const error = new Error("stale");
        error.code = "FEDERATION_TASK_STATE_CONFLICT";
        throw error;
      }
      task = { ...task, status: "running", turn: task.turn + 1, result: null };
      calls.push(["task.message", structuredClone(input)]);
      return structuredClone(task);
    },
    get(input) {
      calls.push(["task.get", structuredClone(input)]);
      return structuredClone(task);
    },
    async cancel(input) {
      task = { ...task, status: "canceled", result: null };
      calls.push(["task.cancel", structuredClone(input)]);
      return structuredClone(task);
    },
    reset() { task = null; },
  };
  const host = createFederationHostServer({
    paths,
    registry,
    taskRunner,
    async delegateRun(input) {
      delegateCalls += 1;
      calls.push(["delegateRun", structuredClone({
        backendId: input.backendId, agentId: input.agentId, prompt: input.prompt,
        timeoutMs: input.timeoutMs, operationId: input.operationId,
      })]);
      return { sessionKey: "session-federated", text: "delegated result" };
    },
  });
  return {
    paths, calls, agents, files, host, registry,
    client: new FederationHostClient({ paths, timeoutMs: 2_000 }),
    getDelegateCalls: () => delegateCalls,
    getTaskRuns: () => taskRuns,
};
}

test("All inspiration executors use a read-only readiness RPC without broadening federation mutations", async () => {
  const fixture = createFixture();
  let ready = false;
  fixture.registry.getInspirationExecutorReadiness = async params => {
    fixture.calls.push(['readiness', params]);
    return { ready };
  };
  await fixture.host.start();
  try {
    for (const backendId of ['shoggoth', 'grok-build', 'claude-code', 'deepseek-harness', 'antigravity', 'pi', 'openclaw', 'hermes']) {
      const params = { backendId, agentId: 'selected-agent' };
      assert.deepEqual(await fixture.client.request('inspiration.executor.ready', params), { ready });
      assert.deepEqual(fixture.calls.at(-1), ['readiness', params]);
    }
    ready = true;
    assert.deepEqual(await fixture.client.request('inspiration.executor.ready', { backendId: 'shoggoth', agentId: 'selected-agent' }), { ready: true });
    await expectCode(() => fixture.client.request('agent.delete', { backendId: 'shoggoth', agentId: 'selected-agent', operationId: operation('a') }), 'APP_HOST_INVALID_REQUEST');
  } finally { await fixture.host.stop(); }
});

test("Host 创建 0600 token/socket，状态按后端隔离且停止后不可用", async () => {
  const fixture = createFixture();
  await fixture.host.start();
  try {
    assert.equal(fs.statSync(fixture.paths.federationTokenPath).mode & 0o077, 0);
    assert.equal(fs.statSync(fixture.paths.federationSocketPath).mode & 0o077, 0);
    assert.equal(fs.statSync(fixture.paths.runtimeDir).mode & 0o077, 0);
    const status = await fixture.client.request("backend.status", {});
    assert.deepEqual(status.backends.map((row) => [row.id, row.health]), [
      ["openclaw", "connected"], ["hermes", "disconnected"],
    ]);
    assert.equal(JSON.stringify(status).includes("fixture-private-canary"), false);
    await expectCode(() => fixture.client.request("agent.list", { backendId: "hermes" }),
      "BACKEND_UNAVAILABLE");
  } finally {
    await fixture.host.stop();
  }
  assert.equal(fs.existsSync(fixture.paths.federationSocketPath), false);
  assert.equal(fs.existsSync(fixture.paths.federationTokenPath), false);
  await expectCode(() => fixture.client.request("backend.status", {}), "APP_HOST_UNAVAILABLE");
});

test("backend.status 同时返回原生后端真实连接和断开状态，写操作边界仍限外部后端", async () => {
  const fixture = createFixture();
  const originalStatus = fixture.registry.getStatus;
  fixture.registry.getStatus = async () => [...await originalStatus(),
    { id: "shoggoth", name: "Shoggoth", connected: true },
    { id: "deepseek-harness", name: "DeepSeek Harness", connected: true },
    { id: "codex", name: "Codex", connected: true, disabled: true,
      info: { error: "fixture-private-canary" } },
  ];
  await fixture.host.start();
  try {
    const { backends } = await fixture.client.request("backend.status", {});
    assert.deepEqual(backends.filter((row) => !["openclaw", "hermes"].includes(row.id))
      .map(({ id, connected, health }) => [id, connected, health]), [
      ["shoggoth", true, "connected"], ["deepseek-harness", true, "connected"],
      ["codex", false, "disabled"],
    ]);
    assert.equal(JSON.stringify(backends).includes("fixture-private-canary"), false);
    await expectCode(() => fixture.client.request("agent.delete", { backendId: "codex",
      agentId: "selected-agent", operationId: operation("c") }), "APP_HOST_INVALID_REQUEST");
  } finally { await fixture.host.stop(); }
});

test("Agent 管理、文件、频道、产物与委派均做权威回读和 exact replay", async () => {
  const fixture = createFixture();
  await fixture.host.start();
  try {
    const listed = await fixture.client.request("agent.list", { backendId: "openclaw" });
    assert.equal(listed.agents[0].id, "agent-1");
    assert.equal(Object.hasOwn(listed.agents[0], "workspace"), false);
    const detail = await fixture.client.request("agent.get", {
      backendId: "openclaw", agentId: "agent-1",
    });
    assert.equal(detail.agent.workspace, "/tmp/agent-1");

    const createParams = {
      backendId: "openclaw",
      spec: { name: "Created", workspace: "/tmp/created", noSkills: true },
      operationId: operation("a"),
    };
    const created = await fixture.client.request("agent.create", createParams);
    assert.equal(created.agent.name, "Created");
    assert.deepEqual(await fixture.client.request("agent.create", createParams), created);
    assert.equal(fixture.calls.filter(([name]) => name === "createAgent").length, 1);
    await expectCode(() => fixture.client.request("agent.create", {
      ...createParams, spec: { name: "Conflict", workspace: "/tmp/conflict" },
    }), "FEDERATION_OPERATION_CONFLICT");

    const updated = await fixture.client.request("agent.update", {
      backendId: "openclaw", agentId: "agent-1", patch: { name: "Renamed" },
      operationId: operation("b"),
    });
    assert.equal(updated.agent.name, "Renamed");
    assert.equal(fixture.calls.filter(([name]) => name === "updateAgent").length, 1);

    assert.deepEqual(await fixture.client.request("agent.file.list", {
      backendId: "openclaw", agentId: "agent-1",
    }), { files: [{ name: "AGENTS.md", size: 13, modifiedAt: null }] });
    const read = await fixture.client.request("agent.file.read", {
      backendId: "openclaw", agentId: "agent-1", file: "AGENTS.md",
    });
    assert.equal(read.file.content, "existing body");
    const written = await fixture.client.request("agent.file.write", {
      backendId: "openclaw", agentId: "agent-1", file: "AGENTS.md", content: "new body",
      operationId: operation("c"),
    });
    assert.equal(written.file.content, "new body");
    assert.equal(fixture.calls.filter(([name]) => name === "setAgentFile").length, 1);

    const channels = await fixture.client.request("agent.channels", {
      backendId: "openclaw", agentId: "agent-1",
    });
    assert.equal(channels.channels[0].status, "connected");
    const artifacts = await fixture.client.request("agent.artifacts", {
      backendId: "openclaw", agentId: "agent-1", limit: 10,
    });
    assert.equal(artifacts.artifacts.items[0].name, "result.txt");

    const cron = await fixture.client.request("cron.list", {
      backendId: "openclaw", enabled: true, limit: 10,
    });
    assert.equal(cron.total, 1);
    assert.equal(cron.jobs[0].name, "Fixture cron");
    assert.equal(cron.jobs[0].hasError, true);
    assert.equal(JSON.stringify(cron).includes("fixture-private-canary"), false,
      "联邦 Cron DTO 不得暴露 prompt、错误详情或 workdir");

    const runParams = {
      backendId: "openclaw", agentId: "agent-1", prompt: "run task", timeoutMs: 5_000,
      operationId: operation("d"),
    };
    const delegated = await fixture.client.request("agent.run", runParams);
    assert.equal(delegated.text, "delegated result");
    assert.deepEqual(await fixture.client.request("agent.run", runParams), delegated);
    assert.equal(fixture.getDelegateCalls(), 1);

    const deleted = await fixture.client.request("agent.delete", {
      backendId: "openclaw", agentId: created.agent.id, operationId: operation("e"),
    });
    assert.equal(deleted.deleted, true);
    assert.equal(fixture.agents.has(created.agent.id), false);
  } finally {
    await fixture.host.stop();
  }
});

test("非法参数和放宽后的 token 权限在触碰后端前 fail closed", async () => {
  const fixture = createFixture();
  await fixture.host.start();
  try {
    const baseline = fixture.calls.length;
    await expectCode(() => fixture.client.request("agent.update", {
      backendId: "openclaw", agentId: "agent-1", patch: { cloneFromDefault: true },
      operationId: operation("f"),
    }), "APP_HOST_INVALID_REQUEST");
    assert.equal(fixture.calls.length, baseline);

    fs.chmodSync(fixture.paths.federationTokenPath, 0o644);
    await expectCode(() => fixture.client.request("backend.status", {}), "APP_HOST_UNAVAILABLE");
    assert.equal(fixture.calls.length, baseline);
    fs.chmodSync(fixture.paths.federationTokenPath, 0o600);
    const recovered = await fixture.client.request("backend.status", {});
    assert.equal(recovered.backends[0].connected, true);
  } finally {
    await fixture.host.stop();
  }
});

test("统一联邦任务协议支持异步派活、查询、续聊、取消与 exact replay", async () => {
  const fixture = createFixture();
  await fixture.host.start();
  try {
    const runParams = {
      backendId: "openclaw", agentId: "agent-1", prompt: "background task",
      timeoutMs: 5_000, operationId: operation("7"),
    };
    const started = await fixture.client.request("federation.run", runParams);
    assert.equal(started.task.status, "running");
    assert.deepEqual(await fixture.client.request("federation.run", runParams), started);
    assert.equal(fixture.getTaskRuns(), 1);

    const current = await fixture.client.request("federation.task.get", {
      backendId: "openclaw", agentId: "agent-1", taskId: started.task.taskId,
    });
    assert.equal(current.task.turn, 1);
    const continued = await fixture.client.request("federation.message", {
      backendId: "openclaw", agentId: "agent-1", taskId: started.task.taskId,
      expectedTurn: 1, prompt: "continue", timeoutMs: 5_000, operationId: operation("8"),
    });
    assert.equal(continued.task.turn, 2);
    await expectCode(() => fixture.client.request("federation.message", {
      backendId: "openclaw", agentId: "agent-1", taskId: started.task.taskId,
      expectedTurn: 1, prompt: "stale", timeoutMs: 5_000, operationId: operation("9"),
    }), "FEDERATION_TASK_STATE_CONFLICT");
    const canceled = await fixture.client.request("federation.task.cancel", {
      backendId: "openclaw", agentId: "agent-1", taskId: started.task.taskId,
      operationId: operation("0"),
    });
    assert.equal(canceled.task.status, "canceled");
  } finally {
    await fixture.host.stop();
  }
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
