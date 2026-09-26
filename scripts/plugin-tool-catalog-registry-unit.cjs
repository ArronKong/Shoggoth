"use strict";

const assert = require("node:assert/strict");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");

const releaseDigest = "a".repeat(64);
const componentId = "b".repeat(64);
const installation = { installationId: "plugin-a", releaseDigest,
  activeReleaseDigest: releaseDigest };
const connection = { connectionId: "connection-a", installationId: "plugin-a",
  componentId, endpointIdentity: "https://fixture.invalid/mcp",
  principalIdentity: "account-a", authRevision: 1, state: "ready" };
const binding = { connectionId: "connection-a", componentId };
const tool = { name: "issues/read", inputSchema: { type: "object" } };

async function main() {
  const registry = new PluginToolCatalogRegistry();
  let releaseFirst;
  const firstList = new Promise((resolve) => { releaseFirst = resolve; });
  const first = registry.refresh({ installation, connection,
    client: { listTools: () => firstList } });
  assert.equal(registry.resolve({ installation, binding, connection,
    toolIdentity: "unknown" }), null);
  releaseFirst([tool]);
  const initial = await first;
  const toolIdentity = initial.entries[0].toolIdentity;
  assert.equal(registry.resolve({ installation, binding, connection,
    toolIdentity })?.catalogRevision, initial.catalogRevision);
  assert.deepEqual(registry.listForBinding({ installation, binding, connection }), {
    catalogRevision: initial.catalogRevision, entries: initial.entries });

  let releaseSlow;
  const slowList = new Promise((resolve) => { releaseSlow = resolve; });
  const slow = registry.refresh({ installation, connection,
    client: { listTools: () => slowList } });
  assert.equal(registry.resolve({ installation, binding, connection, toolIdentity }), null);
  assert.equal(registry.listForBinding({ installation, binding, connection }), null);
  const fast = await registry.refresh({ installation, connection,
    client: { listTools: async () => [tool] } });
  assert.notEqual(initial.catalogRevision, fast.catalogRevision);
  releaseSlow([{ ...tool, description: "stale" }]);
  await assert.rejects(slow, (error) => error.code === "TOOL_CONTRACT_CHANGED");
  assert.equal(registry.resolve({ installation, binding, connection,
    toolIdentity })?.catalogRevision, fast.catalogRevision);

  assert.equal(registry.resolve({ installation, binding,
    connection: { ...connection, authRevision: 2 }, toolIdentity }), null);
  assert.equal(registry.listForBinding({ installation, binding,
    connection: { ...connection, authRevision: 2 } }), null);
  assert.equal(registry.resolve({ installation, binding: { ...binding,
    componentId: "c".repeat(64) }, connection, toolIdentity }), null);
  assert.equal(registry.resolve({ installation: { ...installation,
    activeReleaseDigest: "c".repeat(64) }, binding, connection, toolIdentity }), null);

  await assert.rejects(registry.refresh({ installation, connection,
    client: { listTools: async () => { throw new Error("offline"); } } }), /offline/u);
  assert.equal(registry.resolve({ installation, binding, connection, toolIdentity }), null);
  await registry.refresh({ installation, connection,
    client: { listTools: async () => [tool] } });
  registry.invalidate(connection.connectionId);
  assert.equal(registry.resolve({ installation, binding, connection, toolIdentity }), null);
  console.log("plugin tool catalog refresh: PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
