"use strict";

// REST boundary of quick setup, `${secret:NAME}` credentials and first-party
// plugins: reads never carry a value, writes need the App origin and a native
// confirmation built from Service data, a value travels only on that POST,
// and a canceled confirmation never commits.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startStaticServer } = require("../app/static-server");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-setup-route-"));
  const calls = [];
  const confirmations = [];
  let answer = true;
  const firstParty = { items: [{ packageId: "notes-kit", name: "Notes Kit", version: "1.2.0", description: "",
    installationId: null, installationState: "uninstalled" }] };
  const backend = {
    async getPluginSetup(input) { calls.push(["setup.get", input]); return { nextSteps: ["activate"] }; },
    async getPluginSecrets(input) { calls.push(["secrets.get", input]); return { items: [] }; },
    async preparePluginSetup(input) { calls.push(["setup.prepare", input]); return { challenge: "c-setup", summary: { action: "plugin-quick-enable", package: "Fixture" } }; },
    async commitPluginSetup(input) { calls.push(["setup.commit", input]); return input.approved ? { canceled: false, result: { ok: true } } : { canceled: true, result: null }; },
    async preparePluginSecret(input) { calls.push(["secret.prepare", input]); return { challenge: "c-secret", summary: { action: "plugin-secret-set", package: "Fixture", name: "TOKEN" } }; },
    async commitPluginSecret(input) { calls.push(["secret.commit", input]); return input.approved ? { canceled: false, result: { ok: true } } : { canceled: true, result: null }; },
    async listFirstPartyPlugins() { calls.push(["firstParty.list"]); return firstParty; },
    async installFirstPartyPlugin(packageId) { calls.push(["firstParty.install", packageId]);
      return { installation: { installationId: "fp-installation", desiredState: "enabled" } }; },
  };
  let server;
  try {
    server = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      hostOps: { confirmPluginCapability: async summary => { confirmations.push(summary); return answer; } },
      registry: { backends: new Map([["shoggoth", backend]]), route: agentId => agentId === "agent-a" ? backend : null,
        getServiceBackend: id => id === "shoggoth" ? backend : null } });
    const post = (route, body, origin = server.url) => fetch(`${server.url}/__api/plugins/${route}`, { method: "POST",
      headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) });

    // Reads carry names and readiness only; unknown query keys are refused.
    assert.equal((await fetch(`${server.url}/__api/plugins/setup?agentId=agent-a&installationId=inst-1`)).status, 200);
    assert.equal((await fetch(`${server.url}/__api/plugins/secrets?agentId=agent-a&installationId=inst-1`)).status, 200);
    assert.equal((await fetch(`${server.url}/__api/plugins/secrets?agentId=agent-a&installationId=inst-1&value=x`)).status, 400);
    assert.equal((await fetch(`${server.url}/__api/plugins/setup?agentId=nobody&installationId=inst-1`)).status, 404);

    // Writes require the App origin; a canceled confirmation commits nothing.
    const secret = { agentId: "agent-a", installationId: "inst-1", name: "TOKEN", value: "fixture-secret-value-123" };
    assert.equal((await post("secrets", secret, null)).status, 403);
    answer = false;
    assert.deepEqual(await (await post("secrets", secret)).json(), { canceled: true, result: null });
    const canceledCommit = calls.find(([name]) => name === "secret.commit");
    assert.deepEqual(canceledCommit[1], { challenge: "c-secret", approved: false, value: null }, "a canceled value is dropped");
    answer = true;
    assert.deepEqual(await (await post("secrets", secret)).json(), { canceled: false, result: { ok: true } });
    assert.equal(calls.filter(([name, input]) => name === "secret.commit" && input.value === secret.value).length, 1);
    assert.equal(calls.filter(([name]) => name === "secret.prepare").every(([, input]) => !Object.hasOwn(input, "value")), true,
      "prepare never sees the value");
    assert.equal((await post("secrets", { ...secret, value: "x".repeat(16 * 1024 + 1) })).status, 400);
    assert.equal((await post("secrets", { ...secret, value: "x".repeat(16 * 1024) })).status, 200, "values up to 16 KiB pass");
    assert.equal((await post("setup", { agentId: "agent-a", installationId: "inst-1", expectedRevision: 2 })).status, 200);
    assert.equal(confirmations.filter(item => item.action === "plugin-quick-enable").length, 1);

    // First-party plugins: the list is a read; a reinstall confirms with the
    // Service's own package metadata and accepts only a known package ID.
    assert.deepEqual(await (await fetch(`${server.url}/__api/plugins/first-party`)).json(), firstParty);
    assert.equal((await fetch(`${server.url}/__api/plugins/first-party`, { method: "POST" })).status, 405);
    assert.equal((await post("first-party-install", { packageId: "notes-kit" }, null)).status, 403);
    assert.equal((await post("first-party-install", { packageId: "../notes-kit" })).status, 400);
    assert.equal((await post("first-party-install", { packageId: "notes-kit", extra: true })).status, 400);
    assert.equal((await post("first-party-install", { packageId: "unknown-kit" })).status, 404);
    answer = false;
    assert.deepEqual(await (await post("first-party-install", { packageId: "notes-kit" })).json(), { canceled: true, installation: null });
    assert.equal(calls.some(([name]) => name === "firstParty.install"), false);
    answer = true;
    assert.deepEqual(await (await post("first-party-install", { packageId: "notes-kit" })).json(),
      { canceled: false, installation: { installationId: "fp-installation", desiredState: "enabled" } });
    assert.deepEqual(confirmations.filter(item => item.action === "plugin-first-party-install").at(-1),
      { action: "plugin-first-party-install", package: "Notes Kit", version: "1.2.0" });
    console.log("plugin setup route unit: ok");
  } finally {
    await server?.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
