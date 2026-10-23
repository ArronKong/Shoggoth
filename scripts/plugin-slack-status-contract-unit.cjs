"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
function backend(value) {
  return new ShoggothBackend({ paths: {}, readToken: () => "isolated-fixture-token",
    requestService: async (_, request) => {
      assert.equal(request.method, "plugins.slack.registration.status");
      assert.deepEqual(request.params, {});
      return value;
    } });
}
test("strict Backend status forwards the selected profile without account or scope details", async () => {
  for (const accessProfile of ["public-search", "workspace-read", "workspace-write"]) {
    const value = { configured: true, restartRequired: false, accessProfile };
    assert.deepEqual(await backend(value).getPluginSlackRegistrationStatus(), value);
  }
  const value = { configured: false, restartRequired: false, accessProfile: null };
  assert.deepEqual(await backend(value).getPluginSlackRegistrationStatus(), value);
});
test("missing, contradictory, unknown or overbroad status DTOs fail closed", async () => {
  for (const value of [null, [], { configured: true, restartRequired: false },
    { configured: false, restartRequired: true, accessProfile: null },
    { configured: false, restartRequired: false, accessProfile: "workspace-write" },
    { configured: true, restartRequired: false, accessProfile: null },
    { configured: true, restartRequired: false, accessProfile: "everything" },
    { configured: true, restartRequired: false, accessProfile: "workspace-write", scopes: ["chat:write"] },
    { configured: true, restartRequired: false, accessProfile: "workspace-write", account: "do-not-publish" }]) {
    await assert.rejects(backend(value).getPluginSlackRegistrationStatus(), { code: "PLUGIN_RESPONSE_INVALID" });
  }
});

test("Backend accepts exactly the selected closed scope profiles and rejects injected fields", async () => {
  const { PROFILES } = require("../app/agent-service/plugin-slack-access-policy");
  const requests = [];
  const subject = new ShoggothBackend({ paths: {}, readToken: () => "isolated-fixture-token",
    requestService: async (_, request) => {
      assert.equal(request.method, "plugins.slack.registration.configure");
      requests.push(request.params); return { configured: true, restartRequired: true };
    } });
  const input = { clientId: "1234567890123.9876543210987", redirectPort: 49152 };
  for (const profile of PROFILES) {
    assert.deepEqual(await subject.configurePluginSlackRegistration({ ...input, scopes: profile.scopes }),
      { configured: true, restartRequired: true });
  }
  assert.equal(requests.length, 3);
  for (const malformed of [{ ...input, scopes: ["chat:write"] },
    { ...input, scopes: ["search:read.public", "chat:write"] },
    { ...input, scopes: PROFILES[2].scopes, clientSecret: "must-not-send" }]) {
    await assert.rejects(subject.configurePluginSlackRegistration(malformed), { code: "INVALID_PARAMS" });
  }
  assert.equal(requests.length, 3, "malformed authority never reaches Service");
});

test("Service permission rejection preserves its safe code without forwarding private messages", async () => {
  for (const code of ["CAPABILITY_FORBIDDEN", "GRANT_REVOKED"]) {
    const subject = new ShoggothBackend({ paths: {}, readToken: () => "isolated-fixture-token",
      requestService: async () => { throw Object.assign(new Error("private-account-sentinel"), { code }); } });
    await assert.rejects(subject.getPluginSlackRegistrationStatus(), error => {
      assert.equal(error.code, code); assert(!error.message.includes("private-account-sentinel")); return true;
    });
  }
});
