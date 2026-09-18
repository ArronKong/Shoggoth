"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { AgentBackend } = require("../app/core/agent-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { advancedSessionMethodMap } = require("../app/core/session-advanced-projection");

const methods = advancedSessionMethodMap(Object.fromEntries([
  "environments.list",
  "sessions.describe",
  "sessions.branches.list",
  "sessions.fork",
].map((name) => [name, true])));

class AdvancedBackend extends AgentBackend {
  constructor(id) {
    super();
    this.backendId = id;
    this.calls = [];
  }

  get id() { return this.backendId; }
  get name() { return this.backendId; }
  getBackendDescriptor() {
    return {
      id: this.id,
      name: this.name,
      connectionMode: "gateway",
      disconnectable: true,
      surfaces: {
        chat: false, agents: false, models: false, skills: false, usage: false,
        oauth: false, dashboardRuns: false, agentHarness: false, cron: null, kanban: null,
      },
    };
  }

  ownsAgentId(agentId) { return agentId === `${this.id}-owned`; }

  async listEnvironments() {
    this.calls.push(["listEnvironments"]);
    return {
      supported: true,
      methods,
      environments: [{
        id: `${this.id}-environment`, type: "local", status: "available",
        invocableCommands: ["secret-command"],
      }],
      profiles: [],
    };
  }

  async describeSession(agentId, sessionKey) {
    this.calls.push(["describeSession", agentId, sessionKey]);
    return {
      supported: true,
      methods,
      session: {
        key: sessionKey,
        agentId,
        label: `${this.id} session`,
        sessionId: "secret-session-id",
      },
    };
  }

  async listSessionBranches(agentId, sessionKey) {
    this.calls.push(["listSessionBranches", agentId, sessionKey]);
    return {
      supported: true,
      methods,
      branches: [{ leafEntryId: "leaf-1", headline: "Latest", messageCount: 2, active: true }],
    };
  }

  async forkSessionAtEntry(agentId, sessionKey, entryId) {
    this.calls.push(["forkSessionAtEntry", agentId, sessionKey, entryId]);
    return {
      supported: true,
      methods,
      sessionKey: `${sessionKey}:fork`,
      editorText: "edit",
    };
  }
}

class BrokenBackend extends AdvancedBackend {
  async describeSession() { throw new Error("raw backend secret"); }
}

function request(base, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: payload ? {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
      } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function main() {
  const registry = new BackendRegistry();
  const explicit = new AdvancedBackend("explicit");
  const owner = new AdvancedBackend("owner");
  const broken = new BrokenBackend("broken");
  registry.register(explicit);
  registry.register(owner);
  registry.register(broken);

  const direct = await registry.describeSession("explicit", "owner-owned", "agent:owner-owned:main");
  assert.equal(direct.session.label, "explicit session", "registry must route by exact backend id");
  assert.equal(explicit.calls.at(-1)[0], "describeSession");
  assert.equal(owner.calls.length, 0, "agent ownership must not override the explicit backend route");
  assert.equal(JSON.stringify(direct).includes("secret-session-id"), false);

  const failed = await registry.describeSession("broken", "main", "agent:main:main");
  assert.equal(failed.supported, false);
  assert.equal(failed.reason, "error");
  assert.equal(JSON.stringify(failed).includes("raw backend secret"), false);

  const unknown = await registry.listEnvironments("missing");
  assert.equal(unknown.supported, false);
  assert.equal(unknown.reason, "unknown-backend");
  assert.deepEqual(unknown.environments, []);

  const server = await startStaticServer(0, { registry });
  try {
    const environments = await request(server.url, "GET", "/__api/environments?backend=explicit");
    assert.equal(environments.status, 200);
    assert.equal(environments.json.environments[0].id, "explicit-environment");
    assert.equal(environments.text.includes("secret-command"), false);

    const key = "agent:owner-owned:branch/with/slash";
    const describe = await request(
      server.url,
      "GET",
      `/__api/sessions/describe?${new URLSearchParams({ backend: "explicit", agentId: "owner-owned", key })}`,
    );
    assert.equal(describe.status, 200);
    assert.equal(describe.json.session.key, key);

    const branches = await request(
      server.url,
      "GET",
      `/__api/sessions/branches?${new URLSearchParams({ backend: "explicit", agentId: "owner-owned", key })}`,
    );
    assert.equal(branches.status, 200);
    assert.equal(branches.json.branches[0].leafEntryId, "leaf-1");

    const fork = await request(server.url, "POST", "/__api/sessions/fork", {
      backend: "explicit",
      agentId: "owner-owned",
      key,
      entryId: "entry/with/slash",
    });
    assert.equal(fork.status, 200);
    assert.equal(fork.json.sessionKey, `${key}:fork`);
    assert.deepEqual(explicit.calls.at(-1), [
      "forkSessionAtEntry", "owner-owned", key, "entry/with/slash",
    ]);

    const missingBackend = await request(server.url, "GET", "/__api/environments");
    assert.equal(missingBackend.status, 400);
    const badAgent = await request(
      server.url,
      "GET",
      "/__api/sessions/describe?backend=explicit&agentId=../bad&key=agent%3Amain%3Amain",
    );
    assert.equal(badAgent.status, 400);
    const wrongMethod = await request(server.url, "DELETE", "/__api/sessions/branches");
    assert.equal(wrongMethod.status, 405);
  } finally {
    await server.close();
  }

  console.log("session advanced api: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
