#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startStaticServer } = require("../app/static-server");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-gmail-recovery-route-"));
  const context = { agentId: "agent", installationId: "gmail-install",
    componentId: "a".repeat(64), expectedRevision: 1 };
  const backendInput = { profileId: context.agentId, installationId: context.installationId,
    componentId: context.componentId, expectedRevision: context.expectedRevision };
  let confirmed = false, statusReads = 0, reconciles = 0, dialogs = 0;
  const server = await startStaticServer(0, { homeDir: root, userDataRoot: root,
    hostOps: { async confirmPluginCapability(summary) {
      dialogs += 1;
      assert.deepEqual(summary, { action: "gmail-auth-reconcile", email: "test@example.com" });
      return confirmed;
    } },
    registry: { backends: new Map([["shoggoth", {
      async getPluginGmailAuthRecoveryStatus(input) {
        statusReads += 1;
        assert.deepEqual(input, backendInput);
        return { pending: { email: "test@example.com", client: "shoggoth" } };
      },
      async reconcilePluginGmailAuth(input) {
        reconciles += 1;
        assert.deepEqual(input, { ...backendInput, email: "test@example.com" });
        if (reconciles === 1) {
          throw Object.assign(new Error("Credential remains in local keyring"),
            { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
        }
        return { recovered: true };
      },
    }]]) },
  });
  try {
    const post = async (route, body, origin = server.url) => {
      const response = await fetch(`${server.url}/__api/plugins/${route}`, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const bodyText = await response.text();
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
      return { status: response.status, body: parsed };
    };
    assert.equal((await post("gmail-auth-recovery-status", context, "https://evil.invalid")).status, 403);
    assert.equal((await post("gmail-auth-recovery-status", { ...context,
      extra: true })).status, 400);
    assert.deepEqual(await post("gmail-auth-recovery-status", context), { status: 200,
      body: { pending: { email: "test@example.com", client: "shoggoth" } } });
    assert.equal(statusReads, 1);
    assert.deepEqual(await post("gmail-auth-reconcile", { ...context, email: "test@example.com" }),
      { status: 200, body: { canceled: true, recovered: false } });
    assert.equal(reconciles, 0, "native cancellation must not reach the Service");
    confirmed = true;
    const pending = await post("gmail-auth-reconcile", { ...context, email: "test@example.com" });
    assert.equal(pending.status, 409);
    assert.equal(pending.body.code, "GMAIL_AUTH_RECOVERY_REQUIRED");
    assert.deepEqual(await post("gmail-auth-reconcile", { ...context, email: "test@example.com" }),
      { status: 200, body: { canceled: false, recovered: true } });
    assert.equal(reconciles, 2);
    assert.equal(dialogs, 3);
    console.log("Gmail recovery HTTP route, origin, native confirmation and 409 fence: PASS");
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
