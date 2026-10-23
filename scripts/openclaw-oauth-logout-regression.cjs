#!/usr/bin/env node
"use strict";

// In-memory Gateway only: no real credentials, CLI, config, or model requests.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

function fixture({ agents = ["main", "writer", "reviewer"], records = [], config } = {}) {
  const calls = [];
  const store = structuredClone(records);
  const backend = new OpenClawBackend();
  backend._connect = async () => {};
  backend._isLocalGateway = () => false; // Roster must come from this Gateway, never local disk.
  backend._configSnapshot = async () => ({ parsed: config ?? {
    agents: { entries: Object.fromEntries(agents.map(id => [id, {}])) },
  } });
  backend._modelAuthAgentIds = () => { throw new Error("must not read the local roster"); };
  backend._providerCatalogSnapshot = () => ({ providers: {
    openai: { label: "OpenAI", oauth: ["login"] },
    anthropic: { label: "Anthropic", oauth: ["login"] },
  } });
  backend.request = async (method, params, timeout) => {
    calls.push({ method, params: structuredClone(params), timeout });
    if (!params.agentId) throw new Error("Multiple agents are configured, but model auth has no explicit owner. Pass agentId to select a configured agent.");
    assert.ok(agents.includes(params.agentId), "only configured agents can own auth requests");
    if (method === "models.authStatus") {
      const visible = store.filter(row => row.agent === params.agentId || row.shared
        && !store.some(local => !local.shared && local.agent === params.agentId && local.id === row.id));
      return { providers: [...new Set(visible.map(row => row.provider))].map(provider => ({
        provider,
        profiles: visible.filter(row => row.provider === provider).map(row => ({
          profileId: row.id, type: row.type, status: row.status ?? "ok", email: row.email,
          source: row.external ? "external" : row.shared && params.agentId !== "main" ? "inherited" : "saved",
          logoutSupported: !row.external,
        })),
      })) };
    }
    assert.equal(method, "models.authLogout");
    assert.ok(params.profileIds?.length, "OAuth disconnect must select profiles, preserving API keys");
    for (const id of params.profileIds) {
      let index = store.findIndex(row => !row.shared && row.agent === params.agentId && row.id === id);
      if (index < 0) index = store.findIndex(row => row.shared && row.id === id);
      assert.ok(index >= 0, "shared profiles must be deleted only once");
      assert.equal(store[index].provider, params.provider, "use the stored provider, including aliases");
      assert.equal(store[index].type, "oauth", "never remove another credential type");
      store.splice(index, 1);
    }
    return { removedProfiles: params.profileIds };
  };
  return { backend, calls, store };
}
const oauth = (agent, id, extra = {}) => ({ agent, id, provider: "openai", type: "oauth", ...extra });

test("OAuth disconnect selects every configured agent and only stored OAuth profiles", async () => {
  const f = fixture({ records: [
    oauth("main", "openai:shared", { shared: true }),
    oauth("writer", "openai:local", { status: "expired" }),
    oauth("reviewer", "openai:local"),
    oauth("main", "openai:key", { shared: true, type: "api_key" }),
    oauth("writer", "openai:token", { type: "token" }),
    oauth("reviewer", "openai:external", { external: true }),
    oauth("main", "other:login", { shared: true, provider: "other" }),
  ] });
  const result = await f.backend.disconnectOAuthProvider("openai");
  assert.equal(result.ok, true);
  assert.deepEqual(f.store.map(row => row.id).sort(), ["openai:external", "openai:key", "openai:token", "other:login"]);
  const writes = f.calls.filter(call => call.method === "models.authLogout");
  assert.deepEqual(writes.map(call => [call.params.agentId, call.params.profileIds]), [
    ["main", ["openai:shared"]], ["writer", ["openai:local"]], ["reviewer", ["openai:local"]],
  ]);
  assert.ok(writes.every(call => call.timeout === 120000), "allow Gateway runtime refresh to finish");
  assert.deepEqual(f.calls.slice(0, 3).map(call => call.method), Array(3).fill("models.authStatus"), "read all scopes before the first mutation");
  assert.equal(f.calls.slice(3, 6).some(call => call.method === "models.authStatus"), false);
  assert.ok(result.warnings.some(warning => warning.includes("reviewer")), "externally managed login must not be reported as disconnected");
  assert.equal(f.backend._canonicalAuthProfiles, null, "invalidate credential caches after a write");
});

test("a roster without main can remove inherited OAuth once and preserve a same-id local API key", async () => {
  const f = fixture({ agents: ["writer", "reviewer"], records: [
    oauth("main", "openai:shared", { shared: true }),
    oauth("writer", "openai:shared", { type: "api_key" }),
    oauth("writer", "openai:local"),
  ] });
  assert.equal((await f.backend.disconnectOAuthProvider("openai")).ok, true);
  assert.deepEqual(f.store.map(row => [row.agent, row.id, row.type]), [["writer", "openai:shared", "api_key"]]);
});

test("OAuth aliases use the stored provider and do not include unrelated profiles on that row", async () => {
  const f = fixture({ records: [
    oauth("main", "anthropic:claude-cli", { shared: true, provider: "claude-cli" }),
    oauth("main", "other:cli", { shared: true, provider: "claude-cli" }),
  ] });
  await f.backend.disconnectOAuthProvider("anthropic");
  assert.deepEqual(f.store.map(row => row.id), ["other:cli"]);
  assert.equal(f.calls.find(call => call.method === "models.authLogout").params.provider, "claude-cli");
});

test("auth read failures, unavailable snapshots, and invalid rosters fail before any write", async t => {
  for (const failure of ["read", "unavailable", "malformed", "profile", "owner", "roster"]) await t.test(failure, async () => {
    const f = fixture({ records: [oauth("main", "openai:shared", { shared: true })] });
    const request = f.backend.request;
    if (failure === "roster") f.backend._configSnapshot = async () => ({ parsed: { agents: { entries: {} } } });
    else f.backend.request = async (...args) => {
      if (args[0] === "models.authStatus" && args[1].agentId === "reviewer") {
        if (failure === "read") throw new Error("auth status failed");
        if (failure === "unavailable") return { providers: [], unavailable: { code: "PREPARED_MODEL_AUTH_UNAVAILABLE" } };
        if (["profile", "owner"].includes(failure)) return { providers: [{ provider: "openai", profiles: [
          failure === "profile" ? {} : { profileId: "openai:unknown", type: "oauth", logoutSupported: true },
        ] }] };
        return {};
      }
      return request(...args);
    };
    await assert.rejects(f.backend.disconnectOAuthProvider("openai"));
    assert.equal(f.calls.some(call => call.method === "models.authLogout"), false);
    assert.equal(f.store.length, 1);
  });
});

test("empty OAuth stores do not report successful disconnection or remove API keys", async () => {
  const f = fixture({ records: [oauth("main", "openai:key", { shared: true, type: "api_key" })] });
  assert.equal((await f.backend.disconnectOAuthProvider("openai")).ok, false);
  assert.equal(f.calls.some(call => call.method === "models.authLogout"), false);
});

test("a newly revealed shared login is reported without replaying removal", async () => {
  const f = fixture({ agents: ["writer"], records: [
    oauth("writer", "openai:login"), oauth("main", "openai:login", { shared: true }),
  ] });
  const result = await f.backend.disconnectOAuthProvider("openai");
  assert.ok(result.warnings.some(warning => warning.includes("writer")));
  assert.equal(f.calls.filter(call => call.method === "models.authLogout").length, 1);
  assert.equal(f.store.length, 1);
});

test("partial failure stops without replaying writes; refresh warnings reach the caller", async t => {
  for (const failure of ["timeout", "warning", "receipt"]) await t.test(failure, async () => {
    const f = fixture({ records: [oauth("main", "openai:shared", { shared: true }), oauth("writer", "openai:local")] });
    const request = f.backend.request;
    f.backend.request = async (...args) => {
      const result = await request(...args);
      if (args[0] === "models.authLogout" && args[1].agentId === "writer") {
        if (failure === "timeout") throw new Error("receipt lost after write");
        if (failure === "receipt") return {};
        return { ...result, warning: "Saved; restart Gateway to refresh authentication." };
      }
      return result;
    };
    if (failure === "warning") assert.match((await f.backend.disconnectOAuthProvider("openai")).warnings.join(" "), /restart Gateway/);
    else await assert.rejects(f.backend.disconnectOAuthProvider("openai"));
    assert.equal(f.calls.filter(call => call.method === "models.authLogout").length, 2);
  });
});

test("OAuth list reads explicit remote scopes, includes non-default logins, and refreshes after disconnect", async () => {
  const f = fixture({ agents: ["writer", "reviewer"], records: [oauth("reviewer", "openai:login", { email: "fixture@example.invalid" })] });
  const before = await f.backend.listOAuthProviders();
  assert.equal(before.providers.find(row => row.id === "openai").status.loggedIn, true);
  assert.ok(f.calls.every(call => call.params.refresh === true));
  await f.backend.disconnectOAuthProvider("openai");
  assert.equal((await f.backend.listOAuthProviders()).providers.find(row => row.id === "openai").status.loggedIn, false);
});

test("the OAuth summary uses the selected profile's identity", async () => {
  const f = fixture({ agents: ["writer", "reviewer"], records: [oauth("reviewer", "openai:current")], config: {
    agents: { entries: { writer: {}, reviewer: {} } },
    auth: { profiles: {
      "openai:old": { provider: "openai", mode: "oauth", email: "old@example.invalid" },
      "openai:current": { provider: "openai", mode: "oauth", email: "current@example.invalid" },
    } },
  } });
  const result = await f.backend.listOAuthProviders();
  assert.equal(result.providers.find(row => row.id === "openai").status.tokenPreview, "current@example.invalid");
});

test("OAuth list does not turn unavailable auth state into logged out", async () => {
  const f = fixture();
  f.backend.request = async () => ({ providers: [], unavailable: { code: "PREPARED_MODEL_AUTH_UNAVAILABLE" } });
  await assert.rejects(f.backend.listOAuthProviders());
});

test("implicit single-agent config still supplies an explicit main owner", async () => {
  const f = fixture({ agents: ["main"], config: {}, records: [oauth("main", "openai:login")] });
  assert.equal((await f.backend.disconnectOAuthProvider("openai")).ok, true);
  assert.ok(f.calls.every(call => call.params.agentId === "main"));
});

test("a changed Gateway or connection stops the old OAuth operation", async t => {
  for (const stage of ["read", "write"]) await t.test(stage, async () => {
    const f = fixture({ records: [oauth("main", "openai:shared", { shared: true }), oauth("writer", "openai:local")] });
    const request = f.backend.request;
    f.backend.request = async (...args) => {
      const result = await request(...args);
      if (args[0] === (stage === "read" ? "models.authStatus" : "models.authLogout")) f.backend._connectionGeneration++;
      return result;
    };
    await assert.rejects(f.backend.disconnectOAuthProvider("openai"), { code: "auth_scope_changed" });
    assert.equal(f.calls.filter(call => call.method === "models.authLogout").length, stage === "read" ? 0 : 1);
    assert.ok(f.store.some(row => row.id === "openai:local"));
  });
});
