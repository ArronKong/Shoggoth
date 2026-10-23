#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const registration = require("../app/agent-service/plugin-slack-registration");
const slack = require("../app/agent-service/plugin-slack-oauth");

const INPUT = Object.freeze({ clientId: "1234567890123.9876543210987",
  redirectPort: 49152, scopes: ["search:read.public"] });
function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-slack-registration-"));
  const paths = resolveServicePaths({ userDataRoot: root, cacheRoot: path.join(root, "cache"),
    trustedRoot: root });
  try { return callback(paths); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("user-owned Slack public registration is private, pinned and one-time", () => fixture(paths => {
  const account = { hasStoredAccount: () => false };
  assert.equal(registration.loadSlackRegistration(paths), null);
  assert.deepEqual(registration.configureSlackRegistration(paths, INPUT, account),
    { configured: true, restartRequired: true });
  const file = path.join(paths.pluginsDir, registration.FILE_NAME);
  const stat = fs.lstatSync(file);
  assert.equal(stat.mode & 0o077, 0);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved, { version: 1, clientId: INPUT.clientId,
    redirectUrl: "http://localhost:49152/oauth/callback", scopes: INPUT.scopes });
  const reopened = registration.loadSlackRegistration(paths);
  assert.equal(reopened.clientId, INPUT.clientId);
  assert.equal(reopened.provider.serverUrl, slack.SERVER);
  assert.equal(reopened.provider.audience, slack.AUDIENCE);
  assert.equal(reopened.provider.redirectUrl, saved.redirectUrl);
  assert.deepEqual(reopened.provider.scopes, INPUT.scopes);
  assert.equal(slack.validSlackProtocolProvider(reopened.provider, reopened.clientId), true);
  assert.doesNotThrow(() => new PluginOAuthProviderRegistry({
    providers: [reopened.provider], registeredSlackClientId: reopened.clientId }),
  "only the registered Slack protocol may use its fixed localhost callback");
  assert.throws(() => new PluginOAuthProviderRegistry({
    providers: [{ ...reopened.provider, protocol: null }],
    registeredSlackClientId: reopened.clientId,
  }), { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });
  assert.throws(() => new PluginOAuthProviderRegistry({ providers: [reopened.provider],
    registeredSlackClientId: "111111111.222222222" }),
  { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });
  assert.throws(() => registration.configureSlackRegistration(paths, INPUT, account),
    { code: "SLACK_REGISTRATION_CONFLICT" });
}));

test("foreign frozen client, arbitrary scope injection and malformed callbacks remain rejected", () => fixture(paths => {
  const foreign = new BundledPluginCatalog(bundledRoot()).get("slack");
  assert.equal(foreign.importStatus, "needs-adapter");
  const frozenId = JSON.parse(fs.readFileSync(path.join(bundledRoot(),
    "packages", "slack", ".mcp.json"), "utf8")).mcpServers.slack.oauth.client_id;
  assert.equal(registration.FROZEN_SOURCE_CLIENT_ID, frozenId,
    "source ID rejection must be revised with the pinned bundled package");
  assert.throws(() => registration.configureSlackRegistration(paths,
    { ...INPUT, clientId: registration.FROZEN_SOURCE_CLIENT_ID },
    { hasStoredAccount: () => false }), { code: "SLACK_REGISTRATION_INVALID" });
  for (const input of [
    { ...INPUT, redirectPort: 0 }, { ...INPUT, redirectPort: 65536 },
    { ...INPUT, redirectPort: "49152" }, { ...INPUT, clientId: "bad" },
    { ...INPUT, scopes: [] }, { ...INPUT, scopes: ["admin"] },
    { ...INPUT, scopes: ["search:read.public", "search:read.public"] },
    { ...INPUT, scopes: ["search:read.public"], clientSecret: "leak" },
  ]) assert.throws(() => registration.configureSlackRegistration(paths, input,
    { hasStoredAccount: () => false }), { code: "SLACK_REGISTRATION_INVALID" });
  assert.equal(registration.loadSlackRegistration(paths), null);
  assert.throws(() => registration.configureSlackRegistration(paths, INPUT,
    { hasStoredAccount: () => true }), { code: "SLACK_REGISTRATION_CONFLICT" });
  assert.equal(registration.loadSlackRegistration(paths), null);
  const record = registration.recordFromInput(INPUT);
  for (const redirectUrl of ["http://127.0.0.1:49152/oauth/callback",
    "http://localhost:49152/other", "http://localhost:49152/oauth/callback?x=1",
    "http://localhost:80/oauth/callback"]) {
    assert.throws(() => registration.providerFromRegistration({ ...record, redirectUrl }),
      { code: "SLACK_REGISTRATION_INVALID" });
  }
}));

test("unsafe Slack registration file is not loaded or overwritten", () => fixture(paths => {
  const file = path.join(paths.pluginsDir, registration.FILE_NAME);
  const account = { hasStoredAccount: () => false };
  assert.deepEqual(registration.configureSlackRegistration(paths, INPUT, account),
    { configured: true, restartRequired: true });
  fs.chmodSync(file, 0o644);
  assert.throws(() => registration.loadSlackRegistration(paths),
    { code: "SLACK_REGISTRATION_INVALID" });
  assert.throws(() => registration.configureSlackRegistration(paths, INPUT, account),
    { code: "SLACK_REGISTRATION_INVALID" });
  fs.chmodSync(file, 0o600);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(paths.pluginsDir, "missing.json"), file);
  assert.throws(() => registration.loadSlackRegistration(paths),
    { code: "SLACK_REGISTRATION_INVALID" });
}));

console.log("plugin Slack registration unit: ok");


test("selected read and write profiles survive private storage without broadening", () => {
  const { READ_SCOPES, FULL_SCOPES } = require("../app/agent-service/plugin-slack-access-policy");
  for (const [accessProfile, scopes] of [["workspace-read", READ_SCOPES], ["workspace-write", FULL_SCOPES]]) {
    fixture(paths => {
      const store = { getBySource: () => null, listGlobalBindings: () => [] };
      const controller = new registration.SlackRegistrationController({ paths, store });
      assert.deepEqual(controller.status(), { configured: false, restartRequired: false, accessProfile: null });
      controller.configure({ ...INPUT, scopes: [...scopes].reverse() });
      assert.deepEqual(controller.status(), { configured: true, restartRequired: true, accessProfile });
      assert.deepEqual(registration.loadSlackRegistration(paths).provider.scopes, scopes);
      const reopened = new registration.SlackRegistrationController({ paths, store });
      assert.deepEqual(reopened.status(), { configured: true, restartRequired: false, accessProfile });
      assert.equal(reopened.assertCurrent(), true);
      assert.throws(() => reopened.configure({ ...INPUT, scopes: FULL_SCOPES }),
        { code: "SLACK_REGISTRATION_CONFLICT" });
    });
  }
});

test("changing the live private registration retires its account-bound authority", () => fixture(paths => {
  const { FULL_SCOPES } = require("../app/agent-service/plugin-slack-access-policy");
  registration.configureSlackRegistration(paths, INPUT, { hasStoredAccount: () => false });
  const controller = new registration.SlackRegistrationController({ paths,
    store: { getBySource: () => null, listGlobalBindings: () => [] } });
  assert.equal(controller.assertCurrent(), true);
  const file = path.join(paths.pluginsDir, registration.FILE_NAME);
  fs.writeFileSync(file, JSON.stringify(registration.recordFromInput({ ...INPUT, scopes: FULL_SCOPES })));
  assert.equal(controller.assertCurrent(), false);
  assert.deepEqual(controller.status(), { configured: true, restartRequired: true, accessProfile: "workspace-write" });
}));
