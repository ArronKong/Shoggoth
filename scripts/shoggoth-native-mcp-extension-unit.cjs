#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const {
  NativeMcpClientManager,
  safeEnvironment,
} = require("../app/agent-service/native-mcp-client-manager");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-mcp-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  fs.mkdirSync(paths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  const workspace = path.join(paths.defaultWorkspaceDir, "fixture");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const command = path.join(workspace, "fixture-mcp.js");
  fs.writeFileSync(command, [
    "#!/usr/bin/env node",
    "'use strict';",
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
    "rl.on('line', line => {",
    "  const msg = JSON.parse(line);",
    "  if (!Object.hasOwn(msg, 'id')) return;",
    "  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });",
    "  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] } });",
    "  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: msg.params.arguments.value }] } });",
    "  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });",
    "});",
    "",
  ].join("\n"), { mode: 0o700 });
  fs.chmodSync(command, 0o700);
  const store = new NativeMcpStore({ paths, now: () => 1_800_000_000_000 });
  store.open();
  const manager = new NativeMcpClientManager({ store });
  return {
    root, paths, workspace, command, store, manager,
    async cleanup() {
      await manager.close();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

(async () => {
  const value = fixture();
  try {
    const prepared = value.store.prepare({
      id: "fixture", name: "Fixture MCP", command: value.command,
      args: [], cwd: value.workspace, enabled: true,
    });
    const probed = await value.manager.probe(prepared);
    assert.deepEqual(probed.map((tool) => tool.name), ["echo"]);
    const registered = value.store.register({ expectedRevision: 1, server: prepared });
    assert.equal(registered.revision, 2);
    assert.equal(registered.replaced, false);
    assert.equal(fs.statSync(value.paths.nativeMcpRegistryPath).mode & 0o077, 0);

    assert.deepEqual((await value.manager.listTools("fixture")).map((tool) => tool.name), ["echo"]);
    assert.deepEqual(await value.manager.callTool("fixture", "echo", { value: "shared" }), {
      content: [{ type: "text", text: "shared" }],
    });

    value.store.close();
    value.store.open();
    assert.equal(value.store.get("fixture").command, value.command);
    assert.equal(value.store.list().servers.length, 1);

    const shellLink = path.join(value.workspace, "not-an-mcp");
    fs.symlinkSync("/bin/sh", shellLink);
    assert.throws(() => value.store.prepare({
      id: "shell", name: "Shell", command: shellLink,
      args: ["-c", "echo unsafe"], cwd: value.workspace, enabled: true,
    }), (error) => error?.code === "MCP_SERVER_COMMAND_FORBIDDEN");

    assert.deepEqual(safeEnvironment({
      HOME: value.root, PATH: "/usr/bin", OPENAI_API_KEY: "secret", CUSTOM_TOKEN: "secret",
    }), { HOME: value.root, PATH: "/usr/bin" });

    const removed = value.store.remove({ id: "fixture", expectedRevision: 2 });
    await value.manager.closeServer("fixture");
    assert.equal(removed.revision, 3);
    assert.equal(value.store.get("fixture"), null);
    console.log("PASS shared native MCP registry, stdio proxy, restart, removal and environment isolation");
  } finally {
    await value.cleanup();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
