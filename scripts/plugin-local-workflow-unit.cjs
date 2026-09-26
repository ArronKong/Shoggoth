"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { PluginConnectionAuth } = require("../app/agent-service/plugin-connection-auth");
const { PluginMcpClient } = require("../app/agent-service/plugin-mcp-client");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
const { handle } = require("./fixtures/plugins/mcp-sdk-fixture.cjs");

const tools = [{ name: "issues/read", inputSchema: { type: "object",
  properties: { issueId: { type: "string" } }, required: ["issueId"],
  additionalProperties: false } },
{ name: "issues/create", inputSchema: { type: "object",
  properties: { title: { type: "string" } }, required: ["title"],
  additionalProperties: false } }];
const ids = { "fixture-token-a": "account-a", "fixture-token-b": "account-b" };

async function fixtureServer() {
  const state = { issues: { "account-a": ["A-only"], "account-b": ["B-only"] },
    calls: [] };
  const server = http.createServer(async (request, response) => {
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(request.method === "GET" ? 405 : 404); response.end(); return;
    }
    const bearer = request.headers.authorization;
    const account = typeof bearer === "string" && bearer.startsWith("Bearer ")
      ? ids[bearer.slice(7)] : null;
    if (!account) { response.writeHead(401); response.end(); return; }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 262_144) { response.writeHead(413); response.end(); return; }
    }
    const message = JSON.parse(body);
    let result;
    if (message.method === "tools/list") result = { jsonrpc: "2.0", id: message.id,
      result: { tools } };
    else if (message.method === "tools/call") {
      state.calls.push({ account, name: message.params?.name,
        args: message.params?.arguments });
      if (message.params?.name === "issues/read") {
        result = { jsonrpc: "2.0", id: message.id, result: { content: [],
          structuredContent: { account,
            title: state.issues[account][Number(message.params.arguments.issueId) - 1] } } };
      } else if (message.params?.name === "issues/create") {
        state.issues[account].push(message.params.arguments.title);
        result = { jsonrpc: "2.0", id: message.id, result: { content: [],
          structuredContent: { account, issueId: String(state.issues[account].length) } } };
      }
    } else result = handle(message, "2025-11-25");
    if (!result) { response.writeHead(202); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, state,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-local-flow-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"),
    userDataRoot: temp, profileRoot: path.join(temp, "profile"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  let server;
  let store;
  const clients = [];
  try {
    store = new PluginStore({ paths }).open();
    server = await fixtureServer();
    const sourcePath = path.join(temp, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), sourcePath,
      { recursive: true });
    const installer = new PluginPackageInstaller({ store });
    const preview = installer.preview(sourcePath);
    const installed = installer.install({ sourcePath,
      previewDigest: preview.contentDigest, operationId: "flow-install",
      expectedRevision: 0 });
    const component = new PluginComponentCatalog({ store }).list()[0].components
      .find((entry) => entry.localName === "remote-issues");
    assert.ok(component);
    const enabled = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const registry = { revision: "fixture", get(name) {
      return name === "mcp_server_call" ? { tool: name, enabled: true, risk: "write" } : null;
    }, list() { return [this.get("mcp_server_call")]; } };
    const policy = new PermissionEngine({ toolRegistry: registry });
    const catalogRegistry = new PluginToolCatalogRegistry();
    const connections = [];
    const bindings = [];
    let catalogs = [];
    const dispatcher = new CapabilityDispatcher({ store, permissionEngine: policy,
      resolveToolContract: (records) => catalogRegistry.resolve(records) });
    const credentials = new Map();
    for (const suffix of ["a", "b"]) {
      const connectionId = `connection-${suffix}`;
      const profileId = `agent-${suffix}`;
      const pending = store.createConnection({ connectionId,
        installationId: installed.installationId, componentId: component.componentId,
        endpointIdentity: server.url, credentialRef: `fixture-secret-${suffix}` });
      const ready = store.setConnectionIdentity({ connectionId,
        principalIdentity: `account-${suffix}`, state: "ready",
        expectedRevision: pending.revision });
      connections.push(ready);
      assert.equal(Object.hasOwn(store.getConnection(connectionId), "credentialRef"), false);
      credentials.set(`fixture-secret-${suffix}`, { accessToken: `fixture-token-${suffix}`,
        principalIdentity: `account-${suffix}`, authRevision: ready.authRevision,
        endpointIdentity: server.url, scopes: ["issues:read", "issues:write"],
        expiresAt: Date.now() + 120_000 });
      const binding = store.createBinding({ bindingId: `binding-${suffix}`, profileId,
        installationId: installed.installationId, componentId: component.componentId,
        connectionId });
      bindings.push(store.setBindingEnabled({ bindingId: binding.bindingId,
        enabled: true, expectedRevision: binding.revision }));
    }
    const auth = new PluginConnectionAuth({ getConnection: (id) => store.getConnection(id),
      readCredential: async (id) => {
        const credentialRef = store.getConnectionAuth(id)?.credentialRef;
        return credentialRef ? credentials.get(credentialRef) : null;
      } });
    for (const suffix of ["a", "b"]) {
      const connectionId = `connection-${suffix}`;
      clients.push(await PluginMcpClient.connectHttp({ url: server.url,
        allowLoopback: true, connectionId, principalIdentity: `account-${suffix}`,
        authRevision: 1, credentialProvider: auth.credentialProvider({ connectionId,
          principalIdentity: `account-${suffix}`, authRevision: 1,
          endpointIdentity: server.url, requiredScopes: ["issues:read"] }),
        onToolsChanged: () => catalogRegistry.invalidate(connectionId),
        authorizeEgress: (request) => dispatcher.authorizeEgress(request),
        timeoutMs: 3000 }));
    }
    catalogs = await Promise.all(clients.map((client, index) =>
      catalogRegistry.refresh({ installation: enabled,
        connection: connections[index], client })));
    const entry = (index, name) => catalogs[index].entries.find((tool) =>
      tool.downstreamName === name);
    assert.deepEqual(catalogs[0].entries.map((tool) => tool.downstreamName),
      ["issues/create", "issues/read"]);
    assert.notEqual(entry(0, "issues/read").toolIdentity,
      entry(1, "issues/read").toolIdentity);
    for (const [index, suffix] of ["a", "b"].entries()) {
      const read = entry(index, "issues/read");
      store.setGrant({ grantId: `grant-read-${suffix}`,
        bindingId: bindings[index].bindingId,
        toolIdentity: read.toolIdentity, contractDigest: read.contractDigest,
        effect: "allow", approvalMode: "always", expectedRevision: 0 });
    }
    function input(index, downstreamToolName, args, callId) {
      const profileId = `agent-${index === 0 ? "a" : "b"}`;
      const binding = bindings[index];
      const connection = connections[index];
      const selected = entry(index, downstreamToolName);
      const { toolIdentity, contractDigest } = selected;
      const grant = store.getGrant(binding.bindingId, toolIdentity);
      const run = { id: `run-${profileId}`, profileId, workspace: "/tmp/fixture" };
      return { client: clients[index], callId,
        authority: { kind: "native-profile", profileId,
          profile: { id: profileId, enabled: true }, confirmed: false },
        execution: { kind: "native-run", profileId, workspace: run.workspace, run },
        bindingId: binding.bindingId, toolIdentity, downstreamToolName, contractDigest,
        arguments: args,
        envelope: { runId: run.id, authorityIncarnation: store.getAuthorityIncarnation(), bindingId: binding.bindingId,
          installationId: enabled.installationId, releaseDigest: enabled.releaseDigest,
          componentId: component.componentId, connectionId: connection.connectionId,
          principalIdentity: connection.principalIdentity,
          bindingRevision: binding.revision, grantEpoch: grant?.epoch,
          connectionAuthRevision: connection.authRevision,
          toolIdentity, contractDigest } };
    }
    const readA = await dispatcher.dispatch(input(0, "issues/read", { issueId: "1" }, "flow-read-a"));
    const readB = await dispatcher.dispatch(input(1, "issues/read", { issueId: "1" }, "flow-read-b"));
    assert.equal(readA.structuredContent.title, "A-only");
    assert.equal(readB.structuredContent.title, "B-only");
    const beforeRefresh = input(0, "issues/read", { issueId: "1" }, "flow-read-refreshed");
    const staleTicket = dispatcher.issueTicket(beforeRefresh);
    catalogs[0] = await catalogRegistry.refresh({ installation: enabled,
      connection: connections[0], client: clients[0] });
    await assert.rejects(clients[0].callTool("issues/read",
      beforeRefresh.arguments, { ticketId: staleTicket }),
    (error) => error.code === "TOOL_CONTRACT_CHANGED");
    assert.equal(store.getCapabilityCall("flow-read-refreshed").phase,
      "rejected_before_send");
    await assert.rejects(dispatcher.dispatch({
      ...input(0, "issues/read", { issueId: "1" }, "flow-mismatched-name"),
      downstreamToolName: "issues/create",
    }), (error) => error.code === "TOOL_CONTRACT_CHANGED");
    assert.equal(store.getCapabilityCall("flow-mismatched-name"), null);
    await assert.rejects(dispatcher.dispatch(input(0, "issues/create",
      { title: "not-approved" }, "flow-write-denied")),
    (error) => error.code === "CAPABILITY_FORBIDDEN");
    assert.equal(store.getCapabilityCall("flow-write-denied"), null);
    const createA = entry(0, "issues/create");
    const denied = store.setGrant({ grantId: "grant-write-a", bindingId: bindings[0].bindingId,
      toolIdentity: createA.toolIdentity, contractDigest: createA.contractDigest,
      effect: "deny", approvalMode: "always", expectedRevision: 0 });
    await assert.rejects(dispatcher.dispatch(input(0, "issues/create",
      { title: "still-denied" }, "flow-write-denied-explicit")),
    (error) => error.code === "GRANT_REVOKED");
    const allowed = store.setGrant({ grantId: "grant-write-a", bindingId: bindings[0].bindingId,
      toolIdentity: createA.toolIdentity, contractDigest: createA.contractDigest,
      effect: "allow", approvalMode: "always", expectedRevision: denied.revision });
    const approvedInput = input(0, "issues/create", { title: "A-created" }, "flow-write-a");
    const writeA = await dispatcher.dispatch(approvedInput);
    assert.equal(writeA.structuredContent.account, "account-a");
    assert.equal(writeA.structuredContent.issueId, "2");
    assert.equal(store.getCapabilityCall("flow-write-a").phase, "result_confirmed");
    await assert.rejects(dispatcher.dispatch(input(1, "issues/create",
      { title: "B-should-not-write" }, "flow-write-b")),
    (error) => error.code === "CAPABILITY_FORBIDDEN");
    const pendingAtRevoke = input(0, "issues/create", { title: "revoked-before-send" },
      "flow-write-revoked");
    const ticketId = dispatcher.issueTicket(pendingAtRevoke);
    store.setGrant({ grantId: "grant-write-a", bindingId: bindings[0].bindingId,
      toolIdentity: createA.toolIdentity, contractDigest: createA.contractDigest,
      effect: "deny", approvalMode: "always", expectedRevision: allowed.revision });
    await assert.rejects(clients[0].callTool("issues/create",
      pendingAtRevoke.arguments, { ticketId }),
    (error) => error.code === "GRANT_REVOKED");
    assert.equal(store.getCapabilityCall("flow-write-revoked").phase,
      "rejected_before_send");
    assert.deepEqual(server.state.issues, {
      "account-a": ["A-only", "A-created"], "account-b": ["B-only"],
    });
    assert.deepEqual(server.state.calls.map((call) => [call.account, call.name]), [
      ["account-a", "issues/read"], ["account-b", "issues/read"],
      ["account-a", "issues/create"],
    ]);
    console.log("plugin two-agent two-account local workflow: PASS");
  } finally {
    for (const client of clients) await client.close();
    if (server) await server.close();
    store?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
