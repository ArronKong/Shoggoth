"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
function hostFor(response) {
  const host = Object.create(CodexRuntimeHost.prototype);
  host._ensureNativeAuth = async () => {};
  host._request = async () => response;
  host._markFatal = async error => { host.fatal = error.code; };
  return host;
}
const account = { type: "chatgpt", email: "private@example.test", planType: "pro" };
const routing = { accountRoutingOverride: "NO_CONSTRAINT", backendOrigin: "https://chatgpt.com", chatgptAccountId: "private-account-id" };
test("native experimental account routing is validated then discarded", async () => {
  for (const workspaceRouting of [undefined, null, routing]) {
    const response = { account, requiresOpenaiAuth: true, ...(workspaceRouting === undefined ? {} : { workspaceRouting }) };
    const host = hostFor(response);
    assert.deepEqual(await host.accountRead(), { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true });
    assert.equal(host.fatal, undefined);
  }
});
test("unknown or malformed account routing still fails closed without leaking identity", async () => {
  for (const extra of [{ unexpected: true }, { workspaceRouting: { ...routing, accountRoutingOverride: 7 } },
    { workspaceRouting: { ...routing, chatgptAccountId: 7 } }, { workspaceRouting: { ...routing, injected: true } }]) {
    const host = hostFor({ account, requiresOpenaiAuth: true, ...extra });
    await assert.rejects(host.accountRead(), error => error.code === "CODEX_ACCOUNT_PROTOCOL_INVALID"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("private-account-id"));
    assert.equal(host.fatal, "CODEX_ACCOUNT_PROTOCOL_INVALID");
  }
});
