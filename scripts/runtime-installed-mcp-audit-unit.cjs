"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseOptions, execute, inspectHandshake, resolveBinding } = require("./runtime-installed-mcp-audit.cjs");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

test("installed MCP audit defaults to plan and never reads installed Service or auth", async () => {
  const result = await execute(parseOptions([]));
  assert.equal(result.evidence, "not-run");
  assert.equal(result.serviceRequests, 0);
  for (const args of [["--mode", "live"], ["--app", "/tmp/Fake.app"], ["--profile-id", "bad\n"],
    ["--mode", "live", "--profile-id", "fixture", "--expected-version", "0.8.129", "--output", "relative.json"]]) {
    assert.throws(() => parseOptions(args));
  }
});

test("positive handshake only creates ephemeral thread and reads MCP catalog; no model or business calls", async () => {
  const calls = [];
  const rpc = { async request(method, params) {
    calls.push({ method, params });
    if (method === "initialize") return {};
    if (method === "thread/start") return { thread: { id: "fixture-thread" } };
    if (method === "mcpServerStatus/list") return { data: [{ name: "shoggoth", authStatus: "unsupported",
      serverInfo: { name: "shoggoth", version: "0.8.129" }, tools: { "profile.get": {} } }] };
    assert.fail("unexpected request");
  }, async notify(method) { calls.push({ method }); } };
  const result = await inspectHandshake(rpc, "/tmp/empty-workspace", "0.8.129", new AbortController().signal);
  assert.deepEqual(calls.map(call => call.method), ["initialize", "initialized", "thread/start", "mcpServerStatus/list"]);
  assert.equal(calls[2].params.ephemeral, true);
  assert.equal(calls[2].params.sandbox, "read-only");
  assert.equal(result.positiveAuthenticatedCatalog, true);
  assert.equal(result.modelTurnsSubmitted, 0);
  assert.equal(result.businessToolCalls, 0);
  assert.equal(JSON.stringify(result).includes("fixture-thread"), false);
  await assert.rejects(inspectHandshake(rpc, "/tmp/empty-workspace", "0.8.130", new AbortController().signal),
    { code: "AUDIT_MCP_CATALOG_INVALID" });
});

test("audit refuses native/disabled bindings and any busy Service without weakening authentication", async () => {
  const fixture = { enabled: true, runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID, active: 0, queued: 0 };
  const call = async method => {
    if (method === "profile.list") return { profiles: [{ id: "fixture-profile", enabled: true }], nextCursor: null };
    if (method === "agent.binding.list") return { bindings: [{ id: "fixture-binding", runtime: "codex",
      runtimeAccountId: fixture.runtimeAccountId, enabled: fixture.enabled }] };
    if (method === "service.stopImpact") return { availability: "available", totalCount: fixture.active };
    if (method === "run.list") return { runs: fixture.queued ? [{}] : [] };
    assert.fail("unexpected service method");
  };
  assert.equal((await resolveBinding(call, { profileId: "fixture-profile" })).id, "fixture-binding");
  fixture.active = 1;
  await assert.rejects(resolveBinding(call, { profileId: "fixture-profile" }), { code: "AUDIT_SERVICE_BUSY" });
  fixture.active = 0; fixture.queued = 1;
  await assert.rejects(resolveBinding(call, { profileId: "fixture-profile" }), { code: "AUDIT_SERVICE_BUSY" });
  fixture.queued = 0; fixture.runtimeAccountId = "native-codex-default-v1";
  await assert.rejects(resolveBinding(call, { profileId: "fixture-profile" }), { code: "AUDIT_INTERNAL_CODEX_BINDING_REQUIRED" });
  fixture.runtimeAccountId = SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID; fixture.enabled = false;
  await assert.rejects(resolveBinding(call, { profileId: "fixture-profile" }), { code: "AUDIT_INTERNAL_CODEX_BINDING_REQUIRED" });
});
