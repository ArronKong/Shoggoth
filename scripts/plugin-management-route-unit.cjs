"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startStaticServer } = require("../app/static-server");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-route-"));
  let server;
  let calls = 0;
  let previews = 0;
  let installs = 0;
  let stateWrites = 0;
  let bindingWrites = 0;
  let grantRevocations = 0;
  let bulkGrantRevocations = 0;
  try {
    const selectedPath = path.join(root, "selected-plugin");
    const preview = { sourceKind: "directory", previewDigest: "b".repeat(64),
      expectedRevision: 0, specVersion: "1.0.0", name: "fixture-package",
      declaredVersion: null, installable: true,
      components: { skills: [], mcpServers: [] }, diagnostics: [] };
    server = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      hostOps: { selectPluginPackage: async () => selectedPath },
      registry: {
        backends: new Map([["shoggoth", {
          async previewPluginInstall(source) {
            previews += 1;
            assert.deepEqual(source, { kind: "directory", path: selectedPath });
            return preview;
          },
          async installPlugin(input) {
            if (input.operationId === "fixture-update-active") {
              const failure = new Error("disable package before update");
              failure.code = "PLUGIN_UPDATE_REQUIRES_DISABLE";
              throw failure;
            }
            installs += 1;
            assert.deepEqual(input.source, { kind: "directory", path: selectedPath });
            assert.equal(input.operationId, "fixture-install-operation");
            return { installation: { installationId: "fixture-installation" },
              operation: { operationId: input.operationId, phase: "completed" } };
          },
          async getPluginOperation(operationId) {
            return { found: true, operation: { operationId, phase: "completed" } };
          },
          async setPluginInstallationState(input) {
            if (input.operationId === "fixture-drain-pending") {
              const failure = new Error("plugin connection still active");
              failure.code = "ACTIVATION_DEFERRED";
              throw failure;
            }
            stateWrites += 1;
            assert.equal(input.installationId, "fixture-installation");
            return { installation: { installationId: input.installationId,
              desiredState: input.desiredState }, operation: { phase: "completed" } };
          },
          async getPluginSkillBindings(agentId) {
            assert.equal(agentId, "fixture-agent");
            return { profileId: "fixture-profile", items: [] };
          },
          async getPluginMcpStatus(agentId, installationId) {
            assert.equal(agentId, "fixture-agent");
            assert.equal(installationId, "fixture-installation");
            return { profileId: "fixture-profile", installationId, items: [] };
          },
          async getPluginMcpTools(agentId, bindingId) {
            assert.equal(agentId, "fixture-agent");
            assert.equal(bindingId, "fixture-binding");
            return { profileId: "fixture-profile", bindingId,
              available: false, catalogRevision: null, items: [] };
          },
          async revokePluginMcpGrant(input) {
            grantRevocations += 1;
            assert.equal(input.agentId, "fixture-agent");
            assert.equal(input.bindingId, "fixture-binding");
            assert.equal(input.expectedRevision, 1);
            return { grant: { bindingId: input.bindingId,
              toolIdentity: input.toolIdentity, effect: "deny", revision: 2,
              epoch: 3 }, operation: { operationId: input.operationId,
              kind: "grant-revoke", phase: "completed" } };
          },
          async revokeAllPluginMcpGrants(input) {
            bulkGrantRevocations += 1;
            assert.equal(input.agentId, "fixture-agent");
            assert.equal(input.bindingId, "fixture-binding");
            assert.equal(input.expectedRevision, 1);
            return { revocation: { bindingId: input.bindingId,
              revokedCount: 2, bindingRevision: 1, epoch: 4 },
            operation: { operationId: input.operationId,
              kind: "grants-revoke-all", phase: "completed" } };
          },
          async setPluginSkillBinding(input) {
            if (input.operationId === "fixture-conflict") {
              const failure = new Error("plugin revision conflict");
              failure.code = "REVISION_CONFLICT";
              throw failure;
            }
            bindingWrites += 1;
            assert.equal(input.agentId, "fixture-agent");
            return { binding: { enabled: input.enabled },
              operation: { phase: "completed" } };
          },
        }]]),
        async getPluginCapabilitiesPage(backendId, query) {
          calls += 1;
          assert.equal(backendId, "shoggoth");
          assert.deepEqual(query, { cursor: 0, limit: 10, catalogRevision: null });
          return { supported: false, reasonCode: "PLUGIN_UNAVAILABLE",
            catalogRevision: null, items: [], nextCursor: null };
        },
      },
    });
    const valid = await fetch(`${server.url}/__api/plugins?backend=shoggoth&cursor=0&limit=10`);
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { page: { supported: false,
      reasonCode: "PLUGIN_UNAVAILABLE", catalogRevision: null,
      items: [], nextCursor: null } });
    const icon = await fetch(`${server.url}/__api/plugins/bundled-icon/github`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    assert.match(icon.headers.get("content-security-policy"), /\bsandbox\b/u);
    assert.equal(icon.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.deepEqual(Buffer.from(await icon.arrayBuffer()).subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal((await fetch(`${server.url}/__api/plugins/bundled-icon/../github`)).status, 404);
    for (const query of ["cursor=1", "cursor=0&catalogRevision=" + "a".repeat(64),
      "cursor=0&cursor=1", "cursor=0&limit=21", "source=/private/tmp/secret"]) {
      const response = await fetch(`${server.url}/__api/plugins?${query}`);
      assert.equal(response.status, 400, query);
    }
    const write = await fetch(`${server.url}/__api/plugins`, { method: "POST" });
    assert.equal(write.status, 405);
    assert.equal(calls, 1, "invalid or mutating requests must not reach the Backend");
    const noOrigin = await fetch(`${server.url}/__api/plugins/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(previews, 0);
    const selected = await fetch(`${server.url}/__api/plugins/preview`, {
      method: "POST", headers: { Origin: server.url,
        "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(selected.status, 200);
    const selectedBody = await selected.json();
    assert.equal(selectedBody.preview.previewDigest, preview.previewDigest);
    assert.equal(JSON.stringify(selectedBody).includes(selectedPath), false);
    assert.match(selectedBody.selectionHandle, /^[0-9a-f-]{36}$/u);
    const installInput = { selectionHandle: selectedBody.selectionHandle,
      previewDigest: preview.previewDigest, expectedRevision: 0,
      operationId: "fixture-install-operation" };
    const postInstall = (input) => fetch(`${server.url}/__api/plugins/install`, {
      method: "POST", headers: { Origin: server.url,
        "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    assert.equal((await postInstall({ ...installInput,
      previewDigest: "c".repeat(64) })).status, 409);
    assert.equal(installs, 0);
    const installed = await postInstall(installInput);
    assert.equal(installed.status, 200);
    assert.equal((await installed.json()).operation.phase, "completed");
    assert.equal((await postInstall(installInput)).status, 409);
    const updateSelection = await fetch(`${server.url}/__api/plugins/preview`, {
      method: "POST", headers: { Origin: server.url,
        "Content-Type": "application/json" }, body: "{}",
    });
    const updateHandle = (await updateSelection.json()).selectionHandle;
    const updateBlocked = await fetch(`${server.url}/__api/plugins/install`, {
      method: "POST", headers: { Origin: server.url,
        "Content-Type": "application/json" },
      body: JSON.stringify({ ...installInput, selectionHandle: updateHandle,
        operationId: "fixture-update-active" }),
    });
    assert.equal(updateBlocked.status, 409);
    assert.equal((await updateBlocked.json()).code, "PLUGIN_UPDATE_REQUIRES_DISABLE");
    assert.equal(installs, 1, "picker handle is one-shot");
    const receipt = await fetch(`${server.url}/__api/plugins/operations?operationId=fixture-install-operation`);
    assert.equal((await receipt.json()).operation.phase, "completed");
    const stateInput = { installationId: "fixture-installation",
      desiredState: "enabled", expectedRevision: 1,
      operationId: "fixture-state-operation" };
    const noStateOrigin = await fetch(`${server.url}/__api/plugins/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stateInput),
    });
    assert.equal(noStateOrigin.status, 403);
    const changedState = await fetch(`${server.url}/__api/plugins/state`, {
      method: "POST", headers: { Origin: server.url,
        "Content-Type": "application/json" }, body: JSON.stringify(stateInput),
    });
    assert.equal((await changedState.json()).installation.desiredState, "enabled");
    assert.equal(stateWrites, 1);
    const deferred = await fetch(`${server.url}/__api/plugins/state`, {
      method: "POST", headers: { Origin: server.url,
        "Content-Type": "application/json" },
      body: JSON.stringify({ ...stateInput, operationId: "fixture-drain-pending" }),
    });
    assert.equal(deferred.status, 409);
    assert.equal((await deferred.json()).code, "ACTIVATION_DEFERRED");
    assert.equal(stateWrites, 1);
    const bindings = await fetch(`${server.url}/__api/plugins/skill-bindings?agentId=fixture-agent`);
    assert.equal((await bindings.json()).profileId, "fixture-profile");
    const mcpStatus = await fetch(`${server.url}/__api/plugins/mcp-status?agentId=fixture-agent&installationId=fixture-installation`);
    assert.deepEqual(await mcpStatus.json(), { profileId: "fixture-profile",
      installationId: "fixture-installation", items: [] });
    for (const query of ["agentId=fixture-agent",
      "agentId=fixture-agent&installationId=fixture-installation&includeSecrets=1",
      "agentId=fixture-agent&agentId=fixture-agent&installationId=fixture-installation"]) {
      assert.equal((await fetch(`${server.url}/__api/plugins/mcp-status?${query}`)).status,
        400, query);
    }
    assert.equal((await fetch(`${server.url}/__api/plugins/mcp-status`, {
      method: "POST" })).status, 405);
    const mcpTools = await fetch(`${server.url}/__api/plugins/mcp-tools?agentId=fixture-agent&bindingId=fixture-binding`);
    assert.deepEqual(await mcpTools.json(), { profileId: "fixture-profile",
      bindingId: "fixture-binding", available: false,
      catalogRevision: null, items: [] });
    assert.equal((await fetch(`${server.url}/__api/plugins/mcp-tools?agentId=fixture-agent&bindingId=fixture-binding&includeSecrets=1`)).status, 400);
    assert.equal((await fetch(`${server.url}/__api/plugins/mcp-tools`, {
      method: "POST" })).status, 405);
    const revokeInput = { agentId: "fixture-agent", bindingId: "fixture-binding",
      toolIdentity: `plugin:fixture-installation:${"a".repeat(64)}:fixture-binding:${"b".repeat(64)}`,
      expectedRevision: 1, operationId: "fixture-revoke" };
    const revokeUrl = `${server.url}/__api/plugins/mcp-grants/revoke`;
    const postRevoke = (input, origin = server.url) => fetch(revokeUrl, { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(input) });
    assert.equal((await fetch(revokeUrl, { method: "GET" })).status, 405);
    assert.equal((await fetch(revokeUrl, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(revokeInput) })).status, 403);
    assert.equal((await postRevoke({ ...revokeInput, toolIdentity: "echo" })).status, 400);
    assert.equal((await postRevoke({ ...revokeInput, effect: "allow" })).status, 400);
    assert.equal(grantRevocations, 0);
    const revoked = await postRevoke(revokeInput);
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).grant.effect, "deny");
    assert.equal(grantRevocations, 1);
    const bulkUrl = `${server.url}/__api/plugins/mcp-grants/revoke-all`;
    const bulkInput = { agentId: "fixture-agent", bindingId: "fixture-binding",
      expectedRevision: 1, operationId: "fixture-bulk-revoke" };
    const postBulk = (input) => fetch(bulkUrl, { method: "POST",
      headers: { Origin: server.url, "Content-Type": "application/json" },
      body: JSON.stringify(input) });
    assert.equal((await fetch(bulkUrl, { method: "GET" })).status, 405);
    assert.equal((await fetch(bulkUrl, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bulkInput) })).status, 403);
    assert.equal((await postBulk({ ...bulkInput, effect: "allow" })).status, 400);
    assert.equal((await postBulk({ ...bulkInput, expectedRevision: 0 })).status, 400);
    assert.equal(bulkGrantRevocations, 0);
    const bulkResponse = await postBulk(bulkInput);
    assert.equal(bulkResponse.status, 200);
    assert.equal((await bulkResponse.json()).revocation.revokedCount, 2);
    assert.equal(bulkGrantRevocations, 1);
    assert.equal((await fetch(`${server.url}/__api/plugins/skill-bindings?agentId=fixture-agent&extra=1`)).status, 400);
    const bindInput = { agentId: "fixture-agent", installationId: "fixture-installation",
      componentId: "a".repeat(64), enabled: true, expectedRevision: 0,
      operationId: "fixture-binding-operation" };
    assert.equal((await fetch(`${server.url}/__api/plugins/skill-bindings`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bindInput),
    })).status, 403);
    const bound = await fetch(`${server.url}/__api/plugins/skill-bindings`, {
      method: "POST", headers: { Origin: server.url,
        "Content-Type": "application/json" }, body: JSON.stringify(bindInput),
    });
    assert.equal((await bound.json()).binding.enabled, true);
    assert.equal(bindingWrites, 1);
    const conflict = await fetch(`${server.url}/__api/plugins/skill-bindings`, {
      method: "POST", headers: { Origin: server.url,
        "Content-Type": "application/json" },
      body: JSON.stringify({ ...bindInput, operationId: "fixture-conflict" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "REVISION_CONFLICT");
    assert.equal(previews, 2);
    console.log("plugin management route fixture: PASS");
  } finally {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
