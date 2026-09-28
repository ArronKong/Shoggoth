#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { inspect, render } = require("./plugin-bundled-mcp-auth-gaps.cjs");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");

const root = path.resolve(__dirname, "../resources/bundled-plugins/packages");

test("five frozen OAuth candidates and three remaining blockers omit source client values", () => {
  const audit = inspect();
  assert.deepEqual(audit.rows.map(item => item.id), ["slack", "zoom", "codex-security"]);
  const report = render(audit);
  assert.match(report, /28\/31/u);
  assert.match(report, /Google 三项.*Desktop public-client/u);
  assert.match(report, /43 项 Codex 宿主环境变量/u);
  for (const row of audit.rows.filter(item => item.endpoint.startsWith("https:"))) {
    const source = JSON.parse(fs.readFileSync(path.join(root, row.id, ".mcp.json"), "utf8"))
      .mcpServers[row.id];
    assert.equal(report.includes(source.oauth.client_id), false);
    if (source.oauth.client_secret) assert.equal(report.includes(source.oauth.client_secret), false);
  }
});

test("a local trusted-provider fixture pins exact endpoint, scopes, audience and redirect", () => {
  const audit = inspect();
  const unknown = new PluginOAuthProviderRegistry();
  for (const row of audit.rows.filter(item => item.endpoint.startsWith("https:"))) {
    assert.throws(() => unknown.forEndpoint(row.endpoint),
      { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });
    const source = JSON.parse(fs.readFileSync(path.join(root, row.id, ".mcp.json"), "utf8"))
      .mcpServers[row.id];
    const scopes = source.scopes || ["fixture.read"];
    const audience = source.oauth_resource || row.endpoint;
    const provider = new PluginOAuthProviderRegistry({ providers: [{
      id: `fixture-${row.id}`, name: "Local fixture", serverUrl: row.endpoint,
      issuer: "https://auth.example.invalid/", audience,
      authorizationEndpoint: "https://auth.example.invalid/authorize",
      tokenEndpoint: "https://auth.example.invalid/token", clientId: "shoggoth-local-fixture",
      scopes, metadataUrls: [], identityUrls: [], verifyPrincipal: async () => "fixture:subject",
    }] });
    const redirect = "http://127.0.0.1:49152/oauth/callback";
    const url = new URL("https://auth.example.invalid/authorize");
    for (const [key, value] of Object.entries({ client_id: "shoggoth-local-fixture",
      redirect_uri: redirect, scope: scopes.join(" "), resource: audience,
      response_type: "code", code_challenge_method: "S256", state: "fixture-state",
      code_challenge: "fixture-challenge" })) url.searchParams.set(key, value);
    assert.equal(provider.assertAuthorizationUrl(row.endpoint, url.href, redirect), url.href);
    for (const [field, replacement] of [["client_id", "source-client"],
      ["redirect_uri", "http://127.0.0.1:12798/oauth/callback"],
      ["scope", "fixture.extra"], ["resource", "https://other.example.invalid/mcp"]]) {
      const changed = new URL(url);
      changed.searchParams.set(field, replacement);
      assert.throws(() => provider.assertAuthorizationUrl(row.endpoint, changed.href, redirect),
        { code: "CONNECTION_AUTH_REQUIRED" }, `${row.id} ${field} must not widen`);
    }
    assert.throws(() => provider.forEndpoint(`${row.endpoint}/other`),
      { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });
  }
});
