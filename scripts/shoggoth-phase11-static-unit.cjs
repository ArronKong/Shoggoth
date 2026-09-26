"use strict";

const assert = require("node:assert/strict");
const { startStaticServer } = require("../app/static-server");

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: response.status, body, text };
}

(async () => {
  const calls = [];
  const shoggoth = {
    async validateCustomEndpoint(input, options) {
      calls.push(["endpoint.validate", input, options]);
      return { ok: true, reachable: true, message: "", models: ["discovered-model"] };
    },
    async getDashboardRunDetail(id) {
      calls.push(["run.detail", id]);
      if (id === "explode") throw new Error("private runtime path /Users/private");
      return { backendId: "shoggoth", runId: id, status: "running", events: [], artifacts: [] };
    },
    async respondDashboardPrompt(input) {
      calls.push(["prompt.respond", input]);
      if (input.requestId === "explode") throw new Error("secret response detail");
      return { run: { id: input.runId, status: "running", internal: "never returned" } };
    },
  };
  const codex = {
    getBackendDescriptor() {
      return descriptors[0];
    },
    async previewSkill(name, options) {
      calls.push(["codex.skill.preview", name, options]);
      return { content: "Skill instructions" };
    },
    async uninstallSkill(name, options) {
      calls.push(["codex.skill.uninstall", name, options]);
      return { removed: true };
    },
    async listAgents(options) {
      calls.push(["codex.agent.list", options]);
      return [{ id: "codex-archived", name: "Archived", archived: true, backendId: "codex" }];
    },
    async getAgent(id) {
      calls.push(["codex.agent.get", id]);
      return { id, name: "Agent", backendId: "codex" };
    },
    async createAgent(spec) {
      calls.push(["codex.agent.create", spec]);
      return { id: "codex-created" };
    },
    async updateAgent(id, patch) {
      calls.push(["codex.agent.update", id, patch]);
      return { id };
    },
    async deleteAgent(id, options) {
      calls.push(["codex.agent.archive", id, options]);
    },
    async restoreAgent(id, options) {
      calls.push(["codex.agent.restore", id, options]);
      return { id };
    },
    async getDashboardRunDetail(id) {
      calls.push(["codex.run.detail", id]);
      return { backendId: "codex", runId: id, status: "running", events: [], artifacts: [] };
    },
    async respondDashboardPrompt(input) {
      calls.push(["codex.prompt.respond", input]);
      return { run: { id: input.runId, status: "waiting_input" } };
    },
  };
  const descriptors = [{
    id: "codex",
    name: "Codex",
    connectionMode: "native-runtime",
    disconnectable: false,
    agentLifecycle: {
      create: true, update: true, remove: false, archive: true, restore: true, readStates: true,
    },
    surfaces: {
      chat: true, agents: true, models: true, skills: true, usage: true,
      oauth: true, dashboardRuns: true, agentHarness: true,
      cron: { kind: "native" }, kanban: { kind: "native" },
    },
  }];
  const registry = {
    backends: new Map([["shoggoth", shoggoth], ["codex", codex]]),
    getBackend(id) { return this.backends.get(id) || null; },
    listBackendDescriptors() { return descriptors; },
    async getDashboardLiveWork() {
      calls.push(["dashboard.live"]);
      return { generatedAt: 42, running: [{ backend: "codex", supported: true, items: [{ id: "run:codex", kind: "inspiration" }] }], approvals: [] };
    },
    async listAgents(id, options) { return this.getBackend(id)?.listAgents(options) || []; },
    async resolveResourceOwner(kind) {
      return kind === "dashboard-run" ? shoggoth : null;
    },
  };
  const productHost = {
    async getStatus() {
      calls.push(["product.status"]);
      return { service: { healthy: true }, background: { supported: true, loaded: true } };
    },
    async listProviders(input) {
      calls.push(["product.providers", input]);
      return { profile: { name: "Shoggoth" }, providers: [] };
    },
    async listChatGptModels(input) {
      calls.push(["chatgpt.models", input]);
      return { models: [{ id: "gpt-5", displayName: "GPT-5", description: "Model", isDefault: true }] };
    },
    async runBackgroundAction(action) {
      calls.push(["background", action]);
      if (action === "stop") throw new Error("launchctl private stderr");
      return { service: { healthy: true }, background: { supported: true, loaded: true } };
    },
    async getBackgroundStopImpact() {
      return { availability: "available", revision: "a".repeat(64), totalCount: 0, runs: [] };
    },
    async stopBackground(input) {
      calls.push(["background.stop", input]);
      if (!input?.revision) throw Object.assign(new Error("missing confirmation"), { code: "SHOGGOTH_STOP_CONFIRMATION_REQUIRED" });
      if (input.revision === "b".repeat(64)) throw Object.assign(new Error("private state changed"), { code: "SHOGGOTH_STOP_IMPACT_CHANGED" });
      if (input.revision === "c".repeat(64)) return { service: { healthy: false }, background: { supported: true, loaded: false } };
      throw new Error("launchctl private stderr");
    },
    async configureProvider(input) {
      calls.push(["provider.configure", input]);
      return { profile: { ready: true }, provider: { id: input.provider.id } };
    },
    async bindChatGpt(input) {
      calls.push(["chatgpt.bind", input]);
      return { profile: { ready: true, configuredProviderId: null } };
    },
    async clearProfileProvider(input) {
      calls.push(["provider.clear", input]);
      return { profile: { ready: false, configuredProviderId: null } };
    },
    async startChatGptLogin(input) {
      calls.push(["chatgpt.login", input]);
      return { mode: "browser", status: "waiting", authUrl: "https://auth.openai.test/device" };
    },
  };
  const server = await startStaticServer(0, { registry, productHost });
  try {
    const headers = { Origin: server.url, "Content-Type": "application/json" };
    const discovered = await request(server.url, "/__api/models/endpoints/validate?backend=shoggoth", {
      method: "POST", headers,
      body: JSON.stringify({ profile: "profile-second", baseUrl: "https://gateway.example/v1", apiKey: "fixture-only-key", model: "" }),
    });
    assert.equal(discovered.status, 200);
    assert.deepEqual(discovered.body.models, ["discovered-model"]);
    assert.equal(calls.at(-1)[0], "endpoint.validate");
    assert.deepEqual(calls.at(-1)[2], { profile: "profile-second" });
    const discoveryCalls = calls.length;
    const rejectedDiscovery = await request(server.url, "/__api/models/endpoints/validate?backend=shoggoth", {
      method: "POST", headers: { ...headers, Origin: "https://untrusted.example" }, body: "{}",
    });
    assert.equal(rejectedDiscovery.status, 403);
    assert.equal(calls.length, discoveryCalls);
    let result = await request(server.url, "/__api/shoggoth/status", { headers });
    assert.equal(result.status, 200);
    assert.equal(result.body.service.healthy, true);

    result = await request(server.url, "/__api/shoggoth/providers", { headers });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.providers, []);
    assert.deepEqual(calls.at(-1), ["product.providers", { profileId: null }]);

    result = await request(server.url, "/__api/shoggoth/providers?profileId=profile-second", { headers });
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), ["product.providers", { profileId: "profile-second" }]);

    result = await request(server.url, "/__api/shoggoth/chatgpt/models", { headers });
    assert.equal(result.status, 200);
    assert.equal(result.body.models[0].id, "gpt-5");
    assert.deepEqual(calls.at(-1), ["chatgpt.models", { profileId: null }]);

    result = await request(
      server.url,
      "/__api/shoggoth/chatgpt/models?profileId=profile-second",
      { headers },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), ["chatgpt.models", { profileId: "profile-second" }]);

    result = await request(server.url, "/__api/shoggoth/background/repair", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(result.status, 200);
    assert.equal(calls.some(([kind, action]) => kind === "background" && action === "repair"), true);

    result = await request(server.url, "/__api/shoggoth/background/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(result.status, 403, "mutation without a loopback Origin is rejected by the CSRF guard");

    result = await request(server.url, "/__api/shoggoth/background/stop", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "SHOGGOTH_STOP_CONFIRMATION_REQUIRED");

    result = await request(server.url, "/__api/shoggoth/background/stop-impact", { headers });
    assert.equal(result.status, 200);
    assert.equal(result.body.totalCount, 0);
    result = await request(server.url, "/__api/shoggoth/background/stop", {
      method: "POST", headers, body: JSON.stringify({ revision: result.body.revision }),
    });
    assert.equal(result.status, 503);
    assert.ok(!result.text.includes("launchctl private stderr"));
    result = await request(server.url, "/__api/shoggoth/background/stop", {
      method: "POST", headers, body: JSON.stringify({ revision: "b".repeat(64) }),
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "SHOGGOTH_STOP_IMPACT_CHANGED");
    assert.ok(!result.text.includes("private state changed"));
    result = await request(server.url, "/__api/shoggoth/background/stop", {
      method: "POST", headers, body: JSON.stringify({ revision: "c".repeat(64) }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.background.loaded, false);
    assert.deepEqual(calls.at(-1), ["background.stop", { revision: "c".repeat(64) }]);

    const providerSecret = "static-provider-secret-canary-000001";
    result = await request(server.url, "/__api/shoggoth/providers/configure", {
      method: "POST", headers,
      body: JSON.stringify({
        operationId: "configure-static-1", createdAt: 1_800_000_000_000,
        profileId: "profile-second",
        secret: providerSecret,
        provider: {
          id: "provider-openai", kind: "openai-api-key", name: "OpenAI API Key",
          model: "gpt-5", baseUrl: null, awsRegion: null, awsProfile: null,
        },
      }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.text.includes(providerSecret), false);
    assert.equal(calls.some(([kind]) => kind === "provider.configure"), true);

    result = await request(server.url, "/__api/shoggoth/providers/clear", {
      method: "POST", headers,
      body: JSON.stringify({
        operationId: "clear-static-1",
        profileId: "profile-second",
        createdAt: 1_800_000_000_001,
      }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), ["provider.clear", {
      operationId: "clear-static-1",
      profileId: "profile-second",
      createdAt: 1_800_000_000_001,
    }]);

    result = await request(server.url, "/__api/shoggoth/chatgpt/bind", {
      method: "POST", headers,
      body: JSON.stringify({
        operationId: "bind-chatgpt-static-1", defaultModel: "gpt-5",
        createdAt: 1_800_000_000_001,
      }),
    });
    assert.equal(result.status, 200);
    assert.equal(calls.some(([kind]) => kind === "chatgpt.bind"), true);

    result = await request(server.url, "/__api/shoggoth/chatgpt/login", {
      method: "POST", headers, body: JSON.stringify({ mode: "browser" }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.authUrl, "https://auth.openai.test/device");

    result = await request(server.url, "/__api/dashboard/live", { headers });
    assert.equal(result.status, 200);
    assert.equal(result.body.running[0].items[0].kind, "inspiration");
    assert.equal(result.body.generatedAt, 42);
    result = await request(server.url, "/__api/dashboard/live", { method: "POST", headers });
    assert.equal(result.status, 405);

    result = await request(server.url, "/__api/dashboard/shoggoth/runs/run%3Asafe", { headers });
    assert.equal(result.status, 200);
    assert.equal(result.body.runId, "run:safe");

    result = await request(server.url, "/__api/dashboard/shoggoth/runs/explode", { headers });
    assert.equal(result.status, 409);
    assert.ok(!result.text.includes("/Users/private"));

    result = await request(server.url, "/__api/backends", { headers });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { backends: descriptors });

    result = await request(server.url, "/__api/agents?backend=codex&lifecycle=archived", { headers });
    assert.equal(result.status, 200);
    assert.equal(result.body.agents[0].archived, true);
    assert.deepEqual(calls.find(([kind]) => kind === "codex.agent.list")[1], {
      lifecycle: "archived",
    });

    const missingSkillAgentRequests = [
      ["/__api/skills?backend=codex", {}],
      ["/__api/skills/preview?backend=codex&name=careful", {}],
      ["/__api/skills/install", {
        method: "POST", headers, body: JSON.stringify({ backend: "codex" }),
      }],
      ["/__api/skills?backend=codex&name=careful", {
        method: "PUT", headers, body: JSON.stringify({ enabled: false }),
      }],
      ["/__api/skills?backend=codex&name=careful", { method: "DELETE", headers }],
    ];
    for (const [target, requestOptions] of missingSkillAgentRequests) {
      result = await request(server.url, target, { headers, ...requestOptions });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "SKILL_AGENT_ID_REQUIRED");
    }

    const skillQuery = "backend=codex&name=careful&id=careful-review&source=user&version=1.0.1&agentId=codex-created";
    result = await request(server.url, `/__api/skills/preview?${skillQuery}`, { headers });
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), ["codex.skill.preview", "careful", {
      agentId: "codex-created", id: "careful-review", source: "user", version: "1.0.1",
    }]);
    result = await request(server.url, `/__api/skills?${skillQuery}&expectedRevision=7`, { method: "DELETE", headers });
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), ["codex.skill.uninstall", "careful", {
      agentId: "codex-created", id: "careful-review", source: "user", version: "1.0.1", expectedRevision: 7,
    }]);

    result = await request(server.url, "/__api/agents?backend=codex", {
      method: "POST", headers,
      body: JSON.stringify({
        operationId: "agent-create-static", createdAt: 1_800_000_000_010, name: "Created",
      }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.result.id, "codex-created");

    result = await request(server.url, "/__api/agents/codex-created?backend=codex", {
      method: "PUT", headers,
      body: JSON.stringify({
        operationId: "agent-update-static", createdAt: 1_800_000_000_011,
        expectedUpdatedAt: 10, name: "Renamed",
      }),
    });
    assert.equal(result.status, 200);

    result = await request(server.url,
      "/__api/agents/codex-created?backend=codex&operationId=agent-archive-static&createdAt=1800000000012&expectedUpdatedAt=11",
      { method: "DELETE", headers });
    assert.equal(result.status, 200);
    assert.deepEqual(calls.find(([kind]) => kind === "codex.agent.archive").slice(1), [
      "codex-created", {
        operationId: "agent-archive-static", expectedUpdatedAt: 11, createdAt: 1_800_000_000_012,
      },
    ]);

    result = await request(server.url, "/__api/agents/codex-created/restore?backend=codex", {
      method: "POST", headers,
      body: JSON.stringify({
        operationId: "agent-restore-static", createdAt: 1_800_000_000_012,
        expectedUpdatedAt: 12,
      }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.result.id, "codex-created");

    result = await request(server.url, "/__api/dashboard/runs/run%3Acodex?backend=codex", { headers });
    assert.equal(result.status, 200);
    assert.equal(result.body.backendId, "codex");
    assert.equal(result.body.runId, "run:codex");

    result = await request(server.url, "/__api/dashboard/prompts/respond?backend=codex", {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "input", runId: "run-codex", requestId: "request-codex", text: "continue",
      }),
    });
    assert.deepEqual(result.body, { runId: "run-codex", status: "waiting_input" });

    result = await request(server.url, "/__api/dashboard/prompts/respond?backend=codex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "input", runId: "run-codex", requestId: "request-codex", text: "continue",
      }),
    });
    assert.equal(result.status, 403);

    result = await request(server.url, "/__api/dashboard/shoggoth/prompts/respond", {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "approval", runId: "run-safe", requestId: "request-safe", choice: "once",
      }),
    });
    assert.deepEqual(result.body, { runId: "run-safe", status: "running" });
    assert.ok(!result.text.includes("never returned"));

    process.stdout.write("PASS Phase11 static product routes + CSRF + redaction\n");
  } finally {
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
