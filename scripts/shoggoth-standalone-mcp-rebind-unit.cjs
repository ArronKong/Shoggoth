#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store.js");
const { AgentHarnessServiceController } = require("../app/agent-service/agent-harness-service-controller.js");
const { ShoggothBackend } = require("../app/core/shoggoth-backend.js");
const { startStaticServer } = require("../app/static-server.js");
const { validateAgentHarnessParams, validateAgentHarnessResult } = require(
  "../app/agent-service/agent-harness-service-protocol.js");

async function main() {
  const context = contextFixture();
  const store = new NativeMcpStore({ paths: context.paths, now: () => 500 }).open();
  const oldCommand = path.join(context.root, "old-server");
  const newCommand = path.join(context.root, "new-server");
  const otherCommand = path.join(context.root, "other-server");
  for (const command of [oldCommand, newCommand, otherCommand]) {
    fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
  const oldArgs = ["--old-secret-argument"];
  let probes = 0;
  let closes = 0;
  let tools = [{ name: "read", inputSchema: { type: "object", properties: {} } }];
  const manager = {
    async probe(spec) {
      probes += 1;
      assert.equal(spec.command, newCommand);
      assert.deepEqual(spec.args, ["--new"]);
      return tools;
    },
    async closeServer() { closes += 1; },
  };
  const controller = () => new AgentHarnessServiceController({
    productStore: { getAgentProfile: (id) => id === "profile-1" ? { id } : null },
    definitionStore: context.definitions,
    memoryStore: context.memoryStore,
    memoryEngine: context.memoryEngine,
    chatSessionStore: { listSessions: () => [] },
    transcriptStore: context.transcripts,
    toolRegistry: context.permissions.toolRegistry,
    permissionEngine: context.permissions,
    nativeMcpStore: store,
    nativeMcpClientManager: manager,
  });
  const service = controller();
  const call = async (target, method, params) => {
    const valid = validateAgentHarnessParams(method, { profileId: "profile-1", ...params });
    return validateAgentHarnessResult(method, await target.handle(method, valid));
  };
  const errorCode = (code) => (error) => error?.code === code;
  try {
    let revision = store.revision;
    revision = store.register({ expectedRevision: revision,
      server: { id: "restore-me", name: "Restored", command: oldCommand, args: oldArgs,
        cwd: context.root, enabled: false } }).revision;
    revision = store.register({ expectedRevision: revision,
      server: { id: "already-live", name: "Live", command: otherCommand, args: [],
        cwd: context.root, enabled: true } }).revision;
    fs.unlinkSync(oldCommand); // a restored machine can no longer resolve it
    const listed = await call(service, "harness.mcp.list", { cursor: 0, limit: 20 });
    assert.equal(listed.revision, revision);
    assert.equal(listed.totalDisabled, 1);
    assert.deepEqual(listed.items.map((item) => item.id), ["restore-me"]);
    assert.equal(listed.items[0].commandLabel, "old-server");
    assert.equal(listed.items[0].argCount, 1);
    assert.equal(JSON.stringify(listed).includes(context.root), false, "old absolute paths must not reach the UI");
    assert.equal(JSON.stringify(listed).includes(oldArgs[0]), false, "old args must not reach the UI");
    const backend = new ShoggothBackend();
    backend._assertDomainReady = () => {};
    backend._profilesByAgent = new Map([["agent-a", { id: "profile-1", agentId: "agent-a" }]]);
    backend._call = (method, params) => call(service, method, params);
    const web = await startStaticServer(0, { registry: {
      getBackend: (id) => id === "shoggoth" ? backend : null,
    }, homeDir: context.root, userDataRoot: context.root });
    try {
      const base = `${web.url}/__api/mcp/standalone`;
      const response = await fetch(`${base}?agentId=agent-a&cursor=0&limit=20`);
      assert.equal(response.status, 200);
      const publicPage = (await response.json()).page;
      assert.equal(publicPage.totalDisabled, 1);
      assert.equal(JSON.stringify(publicPage).includes(context.root), false);
      assert.equal((await fetch(`${base}?agentId=unknown&cursor=0&limit=20`)).status, 404);
      assert.equal((await fetch(`${base}?agentId=agent-a&limit=21`)).status, 400);
      const invalid = await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "activate", agentId: "agent-a", id: "restore-me",
          expectedRevision: revision, activationToken: "00000000-0000-4000-8000-000000000000", extra: true }) });
      assert.equal(invalid.status, 400);
      assert.equal(probes, 0);
    } finally { await web.close(); }
    await assert.rejects(call(service, "harness.mcp.list", { profileId: "unknown", cursor: 0, limit: 20 }),
      errorCode("HARNESS_PROFILE_NOT_FOUND"));
    await assert.rejects(call(service, "harness.mcp.activate", { id: "restore-me",
      expectedRevision: revision, activationToken: "00000000-0000-4000-8000-000000000000" }),
    errorCode("MCP_REBIND_REQUIRED"));
    assert.equal(probes, 0, "a restored old command must never be probed");
    await assert.rejects(call(service, "harness.mcp.rebind", {
      id: "already-live", expectedRevision: revision, command: newCommand,
      cwd: context.root, args: [],
    }), errorCode("MCP_SERVER_ALREADY_ENABLED"));
    await assert.rejects(call(service, "harness.mcp.rebind", {
      id: "restore-me", expectedRevision: revision, command: "/bin/sh",
      cwd: context.root, args: [],
    }), errorCode("MCP_SERVER_PATH_INVALID"));
    assert.equal(closes, 0, "rejected paths must not disturb any running client");
    assert.equal(store.revision, revision);
    const rebound = await call(service, "harness.mcp.rebind", {
      id: "restore-me", expectedRevision: revision, command: newCommand,
      cwd: context.root, args: ["--new"],
    });
    assert.equal(rebound.enabled, false);
    assert.equal(store.get("restore-me").enabled, false);
    assert.equal(store.get("restore-me").command, newCommand);
    assert.deepEqual(store.get("restore-me").args, ["--new"]);
    assert.equal(probes, 0, "saving a path must not start the command");
    assert.equal(closes, 1);
    await assert.rejects(call(controller(), "harness.mcp.activate", {
      id: "restore-me", expectedRevision: rebound.revision, activationToken: rebound.activationToken,
    }), errorCode("MCP_REBIND_REQUIRED"));
    assert.equal(probes, 0, "a Service restart invalidates activation tokens");
    await assert.rejects(call(service, "harness.mcp.activate", {
      id: "restore-me", expectedRevision: rebound.revision,
      activationToken: "00000000-0000-4000-8000-000000000000",
    }), errorCode("MCP_REBIND_REQUIRED"));
    await assert.rejects(call(service, "harness.mcp.activate", {
      id: "restore-me", expectedRevision: revision, activationToken: rebound.activationToken,
    }), errorCode("MCP_REGISTRY_REVISION_CONFLICT"));
    assert.equal(probes, 0);
    for (const invalid of [
      Array.from({ length: 257 }, (_, index) => ({ name: `tool-${index}`, inputSchema: {} })),
      [{ name: "duplicate", inputSchema: {} }, { name: "duplicate", inputSchema: {} }],
      [{ name: "bad-schema", inputSchema: [] }],
      [{ name: "x".repeat(129), inputSchema: {} }],
      [{ name: "bad-description", description: 42, inputSchema: {} }],
      [{ name: "oversized-description", description: "x".repeat(16 * 1024 + 1), inputSchema: {} }],
    ]) {
      tools = invalid;
      await assert.rejects(call(service, "harness.mcp.activate", {
        id: "restore-me", expectedRevision: rebound.revision,
        activationToken: rebound.activationToken,
      }), errorCode("MCP_SERVER_PROBE_FAILED"));
      assert.equal(store.get("restore-me").enabled, false);
      assert.equal(store.revision, rebound.revision);
    }
    tools = [{ name: "read", inputSchema: { type: "object", properties: {} } }];
    const activated = await call(service, "harness.mcp.activate", {
      id: "restore-me", expectedRevision: rebound.revision,
      activationToken: rebound.activationToken,
    });
    assert.equal(activated.enabled, true);
    assert.equal(activated.toolCount, 1);
    assert.equal(store.get("restore-me").enabled, true);
    assert.equal((await call(service, "harness.mcp.list", { cursor: 0, limit: 20 })).totalDisabled, 0);
    assert.equal(probes, 7);
    console.log("PASS standalone MCP disabled projection, explicit rebind, restart/stale-token gates, bounded probe, activation");
  } finally {
    store.close();
    context.cleanup();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
