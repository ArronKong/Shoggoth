#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const test = require("node:test");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { HermesBackend } = require("../app/core/hermes-backend");
const {
  normalizeExternalPluginQuery, projectOpenClawExternalPlugins,
  projectHermesExternalPlugins, supportedExternalPluginVersion,
} = require("../app/core/external-plugin-catalog");

function ocRow(id, overrides = {}) {
  return { id, name: id, version: "1.0.0", installed: true, enabled: true,
    origin: "bundled", runtime: { state: "active", error: "secret-runtime-path" },
    path: "/secret/package", token: "secret-token", ...overrides };
}
function ocPayload() {
  return { generation: 7, mutationAllowed: true, diagnostics: [{ message: "secret-path" }],
    plugins: [ocRow("z"), ocRow("a"), ocRow("suggestion", { installed: false })] };
}
function context(overrides = {}) {
  return { query: {}, hostVersion: "2026.9.5", scope: "secret-host", connectionGeneration: 2, ...overrides };
}
function hermesCategoryPayload() {
  return { plugins: [
    { name: "xai", version: "1.0.0", source: "bundled", runtime_status: "inactive",
      path: "/secret/hermes/plugins/image_gen/xai" },
    { name: "xai", version: "1.0.0", source: "bundled", runtime_status: "inactive",
      path: "/secret/hermes/plugins/video_gen/xai" },
    { name: "security-guidance", version: "1.0.0", source: "bundled", runtime_status: "enabled",
      path: "/secret/hermes/plugins/security-guidance" },
  ] };
}
function makeOc() {
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:1" });
  backend._connect = async () => {};
  backend._gatewayHello = { server: { version: "2026.9.5" },
    features: { methods: ["plugins.list"] }, auth: { scopes: ["operator.read"] } };
  backend.calls = [];
  backend.request = async (method, args) => {
    backend.calls.push({ method, args });
    return ocPayload();
  };
  return backend;
}

test("external queries reject arbitrary paths, invalid bounds and unbound cursors", () => {
  for (const query of [{ path: "/secret" }, { limit: 0 }, { limit: 101 },
    { cursor: "1" }, { catalogRevision: "stale" }, { agentId: "../default" },
    { cursor: "10000", catalogRevision: "a".repeat(64) }]) {
    assert.throws(() => normalizeExternalPluginQuery(query), { code: "PLUGIN_EXTERNAL_QUERY_INVALID" });
  }
  assert.equal(supportedExternalPluginVersion("openclaw", "2026.9.4"), false);
  assert.equal(supportedExternalPluginVersion("hermes", "0.21.4"), true);
  assert.equal(supportedExternalPluginVersion("hermes", "arbitrary 99.1.1 secret"), false);
});

test("OpenClaw projection separates configured enablement from active runtime, and strips private fields", () => {
  const result = projectOpenClawExternalPlugins(ocPayload(), context());
  assert.deepEqual(result.items.map((item) => item.pluginId), ["a", "z"]);
  assert.equal(result.capabilities.list, true);
  assert.equal(result.capabilities.activationObserve, true);
  assert.equal(result.capabilities.install, false);
  assert.equal(result.capabilities.perAgentScope, false);
  assert.equal(result.items[0].effectiveAt, "now");
  assert.doesNotMatch(JSON.stringify(result), /secret|mutationAllowed|diagnostics|token|path/);
  const stale = projectOpenClawExternalPlugins({ generation: 8,
    plugins: [ocRow("a", { enabled: false, runtime: { state: "active" } })] }, context());
  assert.equal(stale.items[0].desiredState, "disabled");
  assert.equal(stale.items[0].observedState, "active");
  assert.equal(stale.items[0].effectiveAt, "unknown");
  const noGeneration = projectOpenClawExternalPlugins({ plugins: [ocRow("a")] }, context());
  assert.equal(noGeneration.capabilities.activationObserve, false);
  assert.equal(noGeneration.items[0].observedState, "unknown");
  const missingRuntime = projectOpenClawExternalPlugins({ generation: 2,
    plugins: [ocRow("a", { runtime: undefined })] }, context());
  assert.equal(missingRuntime.capabilities.activationObserve, false);
  assert.equal(missingRuntime.items[0].observedState, "unknown");
});

test("external pages bind cursor to target, connection generation, complete inventory and runtime generation", () => {
  const payload = ocPayload();
  const first = projectOpenClawExternalPlugins(payload, context({ query: { limit: 1 } }));
  const query = { limit: 1, cursor: first.nextCursor, catalogRevision: first.catalogRevision };
  const second = projectOpenClawExternalPlugins(payload, context({ query }));
  assert.deepEqual(second.items.map((item) => item.pluginId), ["z"]);
  assert.equal(second.nextCursor, null);
  for (const change of [{ connectionGeneration: 3 }, { scope: "another-host" }]) {
    assert.throws(() => projectOpenClawExternalPlugins(payload, context({ query, ...change })),
      { code: "PLUGIN_EXTERNAL_CATALOG_CHANGED" });
  }
  assert.throws(() => projectOpenClawExternalPlugins({ ...payload, generation: 8 }, context({ query })),
    { code: "PLUGIN_EXTERNAL_CATALOG_CHANGED" });
  assert.throws(() => projectOpenClawExternalPlugins({ ...payload, plugins: [ocRow("a"), ocRow("a")] }, context()),
    { code: "PLUGIN_EXTERNAL_RESPONSE_INVALID" });
  assert.throws(() => projectOpenClawExternalPlugins({ plugins: Array(1025).fill(ocRow("a")) }, context()),
    { code: "PLUGIN_EXTERNAL_RESPONSE_INVALID" });
});

test("Hermes runtime_status is a configuration observation and never proves process activation", () => {
  const result = projectHermesExternalPlugins({ plugins: [
    { name: "fixture", version: "1", source: "git", runtime_status: "enabled",
      path: "/secret/package", auth_command: "secret-shell", can_remove: true },
    { name: "inactive", version: "", source: "user", runtime_status: "inactive" },
  ], providers: { apiKey: "secret-provider-key" } }, context({ hostVersion: "0.21.4" }));
  assert.equal(result.capabilities.activationObserve, false);
  assert.equal(result.capabilities.uninstall, false);
  assert.equal(result.items.find(item => item.name === "fixture").desiredState, "enabled");
  assert.equal(result.items.find(item => item.name === "inactive").desiredState, "unknown");
  assert.ok(result.items.every((item) => item.observedState === "unknown" && item.effectiveAt === "unknown"));
  assert.doesNotMatch(JSON.stringify(result), /secret|can_remove|auth_command|providers/);
});

test("Hermes namesakes in bundled categories retain distinct, private and stable identities across pages", () => {
  const payload = hermesCategoryPayload();
  const hermesContext = context({ hostVersion: "0.21.4" });
  const complete = projectHermesExternalPlugins(payload, hermesContext);
  assert.equal(complete.items.length, 3);
  assert.equal(new Set(complete.items.map(item => item.pluginId)).size, 3);
  assert.equal(complete.items.filter(item => item.name === "xai").length, 2);
  assert.ok(complete.items.every(item => item.sourceKind === "bundled"));
  assert.doesNotMatch(JSON.stringify(complete), /secret|image_gen|video_gen|path/);
  assert.deepEqual(projectHermesExternalPlugins({ plugins: [...payload.plugins].reverse() }, hermesContext).items,
    complete.items);

  const first = projectHermesExternalPlugins(payload, { ...hermesContext, query: { limit: 2 } });
  const second = projectHermesExternalPlugins(payload, { ...hermesContext,
    query: { limit: 2, cursor: first.nextCursor, catalogRevision: first.catalogRevision } });
  assert.deepEqual([...first.items, ...second.items], complete.items);
  assert.equal(second.nextCursor, null);

  const single = projectHermesExternalPlugins({ plugins: [payload.plugins[0]] }, hermesContext);
  assert.ok(complete.items.some(item => item.pluginId === single.items[0].pluginId));
  const updated = projectHermesExternalPlugins({ plugins: [{ ...payload.plugins[0], version: "2.0.0" }] }, hermesContext);
  assert.equal(updated.items[0].pluginId, single.items[0].pluginId);
  assert.notEqual(updated.catalogRevision, single.catalogRevision);
});

test("Hermes still rejects duplicate locations, ambiguous names without locations and malformed identity fields", () => {
  const row = hermesCategoryPayload().plugins[0];
  const hermesContext = context({ hostVersion: "0.21.4" });
  for (const plugins of [
    [row, { ...row }], [row, { ...row, name: "different-display-name" }],
    [{ ...row, path: undefined }, { ...row, path: undefined }],
    ...[42, {}, "\u0000", "x".repeat(4097)].map(path => [{ ...row, path }]),
    ...[42, {}, "\u0000", "x".repeat(65)].map(source => [{ ...row, source }]),
  ]) {
    assert.throws(() => projectHermesExternalPlugins({ plugins }, hermesContext),
      { code: "PLUGIN_EXTERNAL_RESPONSE_INVALID" });
  }
});

test("OpenClaw uses only negotiated read API and fails closed before unsupported or permission-changing operations", async () => {
  const backend = makeOc();
  assert.equal((await backend.getExternalPluginCatalog()).supported, true);
  assert.deepEqual(backend.calls, [{ method: "plugins.list", args: {} }]);
  const methods = ["previewPluginInstall", "installPlugin", "setPluginInstallationState"];
  for (const method of methods) await assert.rejects(backend[method]({ enabled: true }),
    { code: "PLUGIN_EXTERNAL_WRITE_UNSUPPORTED" });
  assert.equal(backend.calls.length, 1);
  backend._gatewayHello.auth.scopes = ["operator.admin"];
  assert.equal((await backend.getExternalPluginCatalog()).reasonCode, "PLUGIN_EXTERNAL_API_UNSUPPORTED");
  backend._gatewayHello.auth.scopes = ["operator.read"];
  backend._gatewayHello.features.methods = [];
  assert.equal((await backend.getExternalPluginCatalog()).reasonCode, "PLUGIN_EXTERNAL_API_UNSUPPORTED");
  backend._gatewayHello.server.version = "2026.8.1";
  assert.equal((await backend.getExternalPluginCatalog()).reasonCode, "PLUGIN_EXTERNAL_VERSION_UNSUPPORTED");
  assert.equal((await backend.getExternalPluginCatalog({ agentId: "main" })).reasonCode, "PLUGIN_EXTERNAL_SCOPE_UNSUPPORTED");
  assert.equal(backend.calls.length, 1);
});

test("OpenClaw discards late connection observations and sanitizes upstream failures", async () => {
  const backend = makeOc();
  backend.request = async () => { backend._connectionGeneration += 1; return ocPayload(); };
  assert.equal((await backend.getExternalPluginCatalog()).reasonCode, "PLUGIN_EXTERNAL_OBSERVATION_STALE");
  backend.request = async () => { throw new Error("secret-token secret-home"); };
  const failure = await backend.getExternalPluginCatalog();
  assert.equal(failure.reasonCode, "PLUGIN_EXTERNAL_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(failure), /secret/);
});

async function withHermesFixture(run) {
  const state = { version: "0.21.4", status: 200, requests: [], onHub: null,
    payload: { plugins: [{ name: "fixture", version: "1", source: "user", runtime_status: "enabled" }] } };
  const server = createServer((req, res) => {
    state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.url === "/api/status") return res.end(JSON.stringify({ version: state.version }));
    assert.equal(req.url, "/api/dashboard/plugins/hub");
    state.onHub?.();
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(JSON.stringify(state.payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const backend = new HermesBackend({ getConfig: () => ({ hermesMode: "remote", hermesRemotes: [] }) });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  backend.dashboards.set("default", { baseUrl, token: "fixture-token" });
  backend.profileById.set("hermes-fixture", "default");
  try { await run(backend, state); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("Hermes uses bounded authenticated HTTP reads and rejects unknown Agent scope without fallback", async () => {
  await withHermesFixture(async (backend, state) => {
    const page = await backend.getExternalPluginCatalog({ agentId: "hermes-fixture" });
    assert.equal(page.supported, true);
    assert.equal(page.hostVersion, "0.21.4");
    assert.equal(page.capabilities.activationObserve, false);
    assert.equal(state.requests.length, 2);
    assert.ok(state.requests.every((item) => item.method === "GET" && item.auth === "Bearer fixture-token"));
    assert.equal((await backend.getExternalPluginCatalog({ agentId: "unknown" })).reasonCode,
      "PLUGIN_EXTERNAL_SCOPE_UNAVAILABLE");
    assert.equal(state.requests.length, 2);
    for (const method of ["previewPluginInstall", "installPlugin", "setPluginInstallationState"]) {
      await assert.rejects(backend[method]({ enabled: true }), { code: "PLUGIN_EXTERNAL_WRITE_UNSUPPORTED" });
    }
    assert.equal(state.requests.length, 2);
  });
});

test("Hermes HTTP catalog accepts the shipped nested-category response without losing namesakes", async () => {
  await withHermesFixture(async (backend, state) => {
    state.payload = hermesCategoryPayload();
    const page = await backend.getExternalPluginCatalog();
    assert.equal(page.supported, true);
    assert.equal(page.reasonCode, null);
    assert.equal(page.items.length, 3);
    assert.equal(page.items.filter(item => item.name === "xai").length, 2);
    assert.equal(new Set(page.items.map(item => item.pluginId)).size, 3);
    assert.equal(page.capabilities.activationObserve, false);
    assert.doesNotMatch(JSON.stringify(page), /secret|path/);
  });
});

test("Hermes refuses stale host topology, unsupported API/version and invalid inventory", async () => {
  await withHermesFixture(async (backend, state) => {
    state.onHub = () => { backend._lifecycleGeneration += 1; };
    assert.equal((await backend.getExternalPluginCatalog()).reasonCode, "PLUGIN_EXTERNAL_OBSERVATION_STALE");
    state.onHub = null;
    state.status = 404;
    assert.equal((await backend.getExternalPluginCatalog()).reasonCode, "PLUGIN_EXTERNAL_API_UNSUPPORTED");
    state.status = 200;
    state.version = "0.21.3";
    assert.equal((await backend.getExternalPluginCatalog()).reasonCode, "PLUGIN_EXTERNAL_VERSION_UNSUPPORTED");
    state.version = "0.21.4";
    state.payload.plugins[0].runtime_status = "actively-running";
    assert.equal((await backend.getExternalPluginCatalog()).reasonCode, "PLUGIN_EXTERNAL_RESPONSE_INVALID");
  });
});
