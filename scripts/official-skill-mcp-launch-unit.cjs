#!/usr/bin/env node
"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { NativeMcpClientManager } = require("../app/agent-service/native-mcp-client-manager");
const { McpConnectorController } = require("../app/agent-service/mcp-connector-controller");
const { McpConnectorSecrets, validateSecrets } = require("../app/agent-service/mcp-connector-secrets");
const { validateConnectorParams } = require("../app/core/connector-dto");
const { BRIDGE_ENTRY, OFFICIAL_SKILL_PROVIDERS, matchOfficialSkillBridgeLaunch, validateOfficialSkillBridgeLaunch, officialSkillBridgeEnvironment, validateOfficialSkillBridgeCredentials } = require("../app/agent-service/official-skill-mcp-launch");

function installation(t, provider = "weread") {
  const base = fs.mkdtempSync("/private/tmp/shoggoth-official-launch-");
  fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const paths = resolveServicePaths({ trustedRoot: base, stateRoot: path.join(base, "state"), profileRoot: path.join(base, "profile"), cacheRoot: path.join(base, "cache") });
  const root = path.join(paths.stateDir, "runtime-bin", "official-skills", provider, crypto.randomUUID()), home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  const args = [BRIDGE_ENTRY, "--provider", provider, "--root", root, "--home", home];
  return { base, paths, root, home, args, provider };
}

test("official bridge launch allows only the fixed executable, bridge, provider and installation argv", t => {
  const f = installation(t);
  assert.equal(matchOfficialSkillBridgeLaunch(process.execPath, f.args, f).provider, "weread");
  for (const provider of OFFICIAL_SKILL_PROVIDERS) {
    const item = installation(t, provider);
    assert.equal(matchOfficialSkillBridgeLaunch(process.execPath, item.args, item).provider, provider);
  }
  const altered = [
    [...f.args, "--eval", "not-allowed"],
    ["/tmp/untrusted-bridge.js", ...f.args.slice(1)],
    f.args.map((value, index) => index === 2 ? "arbitrary" : value),
    f.args.map((value, index) => index === 4 ? path.join(f.base, "external") : value),
    f.args.map((value, index) => index === 6 ? f.base : value),
    f.args.map((value, index) => index === 4 ? `${f.root}/../${path.basename(f.root)}` : value),
    f.args.map((value, index) => index === 4 ? f.root.replace(/-[89ab]([0-9a-f]{3}-[0-9a-f]{12})$/u, "-0$1") : value),
  ];
  for (const args of altered) {
    assert.equal(matchOfficialSkillBridgeLaunch(process.execPath, args, f), null);
    assert.deepEqual(officialSkillBridgeEnvironment(process.execPath, args, f), {});
  }
  assert.equal(matchOfficialSkillBridgeLaunch(`${process.execPath}-other`, f.args, f), null);
  assert.equal(matchOfficialSkillBridgeLaunch(process.execPath, f.args, {}), null);
});

test("official bridge installation directories remain private and symlink-free at each launch", t => {
  const f = installation(t);
  assert.equal(validateOfficialSkillBridgeLaunch(process.execPath, f.args, f).root, f.root);
  assert.deepEqual(officialSkillBridgeEnvironment(process.execPath, f.args, f), { ELECTRON_RUN_AS_NODE: "1", HOME: f.home });
  for (const directory of [f.paths.stateDir, path.dirname(path.dirname(f.root)), path.dirname(f.root), f.root, f.home]) {
    fs.chmodSync(directory, 0o755);
    assert.throws(() => validateOfficialSkillBridgeLaunch(process.execPath, f.args, f), { code: "MCP_SERVER_PATH_INVALID" });
    fs.chmodSync(directory, 0o700);
  }
  const realHome = `${f.home}-original`;
  fs.renameSync(f.home, realHome); fs.symlinkSync(realHome, f.home);
  assert.throws(() => validateOfficialSkillBridgeLaunch(process.execPath, f.args, f), { code: "MCP_SERVER_PATH_INVALID" });
  fs.unlinkSync(f.home); fs.renameSync(realHome, f.home);
  const fileSystem = { ...fs, lstatSync(file) { return file === BRIDGE_ENTRY ? { isSymbolicLink: () => true, isFile: () => true } : fs.lstatSync(file); } };
  assert.throws(() => validateOfficialSkillBridgeLaunch(process.execPath, f.args, { paths: f.paths, fsModule: fileSystem }), { code: "MCP_SERVER_PATH_INVALID" });
});

test("official credentials accept only each provider's declared environment fields", t => {
  const providers = require("../app/agent-service/official-skill-providers").PROVIDERS;
  for (const provider of OFFICIAL_SKILL_PROVIDERS) {
    const f = installation(t, provider), transport = { kind: "stdio-command", command: process.execPath, args: f.args, cwd: f.root };
    const env = Object.fromEntries(providers[provider].fields.map(field => [field.name, "private-provider-key"]));
    assert.doesNotThrow(() => validateOfficialSkillBridgeCredentials(transport, { env }, f));
    for (const secrets of [{ env: { UNDECLARED_KEY: "private" } }, { env: { NODE_OPTIONS: "--require=/tmp/fixture.cjs" } },
      { headers: { Authorization: "private" } }, { query: { key: "private" } }, { oauthClient: { clientId: "private" } },
      { oauthToken: { access_token: "private" } }]) {
      assert.throws(() => validateOfficialSkillBridgeCredentials(transport, secrets, f), { code: "MCP_SECRET_INVALID" });
    }
  }
  // The general MCP secret layer already blocks executable environment injection;
  // the provider rule narrows the remaining, otherwise valid credential names.
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "PYTHONPATH", "HOME", "PATH"])
    assert.throws(() => validateSecrets({ env: { [name]: "private" } }), { code: "MCP_SECRET_INVALID" });
  assert.doesNotThrow(() => validateSecrets({ env: { UNDECLARED_KEY: "private" } }));
});

test("official API credential rejection leaves the registry and saved secret unchanged", async t => {
  const f = installation(t), store = new NativeMcpStore({ paths: f.paths }).open(), encrypted = new Map();
  const secrets = new McpConnectorSecrets({ secretStore: { async get(key) { return encrypted.get(key) ?? null; },
    async put(key, value) { encrypted.set(key, value); }, async delete(key) { encrypted.delete(key); } } });
  const manager = { async listTools() { return [{ name: "fixture" }]; }, async closeServer() {} };
  const controller = new McpConnectorController({ paths: f.paths, store, secrets, manager, oauth: { async close() {} } }).open();
  t.after(async () => { await controller.close(); store.close(); });
  const call = (method, input) => controller.handle(method, validateConnectorParams(method, input));
  const transport = { kind: "stdio-command", command: process.execPath, args: f.args, cwd: f.root };
  const result = await call("connector.mcp.add", { name: "WeRead", source: { kind: "custom" }, option: transport,
    fields: { env: { WEREAD_API_KEY: "private-provider-key" } }, expectedRevision: store.revision });
  const before = JSON.stringify(store.getPrivate(result.server.id)), revision = store.revision, saved = [...encrypted.entries()];
  for (const fields of [{ env: { UNDECLARED_KEY: "private" } }, { env: { NODE_OPTIONS: "--require=/tmp/fixture.cjs" } },
    { headers: { Authorization: "private" } }, { query: { key: "private" } }, { oauthClient: { clientId: "private" } }]) {
    await assert.rejects(call("connector.mcp.credentials.update", { id: result.server.id, fields, expectedRevision: revision }), { code: "MCP_SECRET_INVALID" });
    assert.equal(store.revision, revision);
    assert.equal(JSON.stringify(store.getPrivate(result.server.id)), before);
    assert.deepEqual([...encrypted.entries()], saved);
  }
  await assert.rejects(call("connector.mcp.add", { name: "WeRead", source: { kind: "custom" }, option: transport,
    fields: { env: { UNDECLARED_KEY: "private" } }, expectedRevision: revision }), { code: "MCP_SECRET_INVALID" });
  assert.equal(store.revision, revision); assert.deepEqual([...encrypted.entries()], saved);
});

test("store and manager revalidate the official launch and inject Electron mode only for the trusted bridge", async t => {
  const f = installation(t), store = new NativeMcpStore({ paths: f.paths }).open();
  t.after(() => store.close());
  const server = { id: "official-weread", name: "WeRead", enabled: true, source: { kind: "custom" },
    transport: { kind: "stdio-command", command: process.execPath, args: f.args, cwd: f.root },
    auth: { kind: "none" }, secretRef: "mcp-connector:official-weread", setup: { requiredFields: [], configuredFields: [] }, status: "checking", lastCheck: null, disabledProfileIds: [] };
  store.add({ server, expectedRevision: store.revision });
  assert.equal(store.prepareLaunch(store.getPrivate(server.id)).transport.command, process.execPath);
  for (const args of [[...f.args, "--evil"], f.args.map((value, index) => index === 0 ? __filename : value)]) {
    assert.throws(() => store.prepare({ ...server, transport: { ...server.transport, args } }), { code: "MCP_SERVER_PATH_INVALID" });
  }
  const spawned = [];
  const spawn = (command, args, options) => {
    spawned.push({ command, args, options });
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let buffer = "", exited = false;
    child.stdin.on("data", chunk => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"), message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (message.id === undefined) continue;
        const result = message.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { tools: [{ name: "fixture" }] };
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      }
    });
    child.kill = () => { if (!exited) { exited = true; child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); } return true; };
    child.stdin.on("finish", () => child.kill());
    return child;
  };
  let savedSecret = { env: { WEREAD_API_KEY: "private-provider-key" } };
  const manager = new NativeMcpClientManager({ store, spawn, secrets: { async get() { return savedSecret; } },
    env: { HOME: "/unrelated-user-home", ELECTRON_RUN_AS_NODE: "0", NODE_OPTIONS: "--eval=bad" } });
  t.after(() => manager.close());
  assert.equal((await manager.listTools(server.id))[0].name, "fixture");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, process.execPath);
  assert.deepEqual(spawned[0].args, f.args);
  assert.equal(spawned[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spawned[0].options.env.HOME, f.home);
  assert.equal(spawned[0].options.env.NODE_OPTIONS, undefined);
  assert.equal(spawned[0].options.env.WEREAD_API_KEY, "private-provider-key");
  assert.equal(spawned[0].options.shell, false);
  await manager.closeServer(server.id);
  fs.chmodSync(f.root, 0o755);
  await assert.rejects(manager.listTools(server.id), { code: "MCP_SERVER_PATH_INVALID" });
  assert.equal(spawned.length, 1, "invalidated installation must fail before spawning");
  fs.chmodSync(f.root, 0o700);
  savedSecret = { env: { UNDECLARED_KEY: "private" } };
  await assert.rejects(manager.listTools(server.id), { code: "MCP_SECRET_INVALID" });
  assert.equal(spawned.length, 1, "undeclared saved credentials must fail before spawning");
});

test("only trusted official business calls preserve the approved runtime error codes", async t => {
  const uncertain = { code: -32000, message: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" };
  for (const scenario of [
    { name: "official business call", official: true, method: "tools/call", error: uncertain, expected: "MCP_SERVER_RESULT_UNKNOWN" },
    { name: "custom executable spoofing official argv", official: false, method: "tools/call", error: uncertain, expected: "MCP_SERVER_CALL_FAILED" },
    { name: "official initialization", official: true, method: "initialize", error: uncertain, expected: "MCP_SERVER_CALL_FAILED" },
    { name: "official listing", official: true, method: "tools/list", error: uncertain, expected: "MCP_SERVER_CALL_FAILED" },
    { name: "other error code", official: true, method: "tools/call", error: { ...uncertain, code: -32603 }, expected: "MCP_SERVER_CALL_FAILED" },
    { name: "other error message", official: true, method: "tools/call", error: { ...uncertain, message: `${uncertain.message}:private-detail` }, expected: "MCP_SERVER_CALL_FAILED" },
    { name: "official session required", official: true, method: "tools/call", error: { ...uncertain, message: "OFFICIAL_SKILL_SESSION_REQUIRED" }, expected: "OFFICIAL_SKILL_SESSION_REQUIRED" },
    { name: "custom session required", official: false, method: "tools/call", error: { ...uncertain, message: "OFFICIAL_SKILL_SESSION_REQUIRED" }, expected: "MCP_SERVER_CALL_FAILED" },
    { name: "official Shop sign-in required", official: true, method: "tools/call", error: { ...uncertain, message: "OFFICIAL_SKILL_AUTH_REQUIRED" }, expected: "MCP_AUTH_REQUIRED" },
    { name: "custom Shop sign-in required", official: false, method: "tools/call", error: { ...uncertain, message: "OFFICIAL_SKILL_AUTH_REQUIRED" }, expected: "MCP_SERVER_CALL_FAILED" },
    { name: "official DoorDash sign-in required", official: true, method: "tools/call", error: { ...uncertain, message: "OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED" }, expected: "MCP_AUTH_REQUIRED" },
    { name: "official DoorDash approval required", official: true, method: "tools/call", error: { ...uncertain, message: "OFFICIAL_SKILL_APPROVAL_REQUIRED" }, expected: "MCP_CONNECTOR_NOT_READY" },
    { name: "official DoorDash review required", official: true, method: "tools/call", error: { ...uncertain, message: "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED" }, expected: "MCP_SERVER_REQUEST_INVALID" },
    { name: "custom executable cannot spoof DoorDash approval", official: false, method: "tools/call", error: { ...uncertain, message: "OFFICIAL_SKILL_APPROVAL_REQUIRED" }, expected: "MCP_SERVER_CALL_FAILED" },
    { name: "session required during initialization", official: true, method: "initialize", error: { ...uncertain, message: "OFFICIAL_SKILL_SESSION_REQUIRED" }, expected: "MCP_SERVER_CALL_FAILED" },
  ]) {
    await t.test(scenario.name, async t => {
      const f = installation(t), store = new NativeMcpStore({ paths: f.paths }).open();
      let command = process.execPath;
      if (!scenario.official) {
        command = path.join(f.base, "custom-mcp");
        fs.writeFileSync(command, "fixture executable\n", { mode: 0o700 });
      }
      const server = { id: "error-mapping", name: "Error mapping fixture", enabled: true, source: { kind: "custom" },
        transport: { kind: "stdio-command", command, args: f.args, cwd: f.root },
        auth: { kind: "none" }, secretRef: null, setup: { requiredFields: [], configuredFields: [] },
        status: "checking", lastCheck: null, disabledProfileIds: [] };
      store.add({ server, expectedRevision: store.revision });
      const methods = [];
      let spawnCount = 0;
      const spawn = () => {
        spawnCount += 1;
        const child = new EventEmitter();
        child.exitCode = null;
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        let buffer = "";
        child.stdin.on("data", chunk => {
          buffer += chunk.toString();
          while (buffer.includes("\n")) {
            const index = buffer.indexOf("\n"), message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
            if (message.id === undefined) continue;
            methods.push(message.method);
            const response = { jsonrpc: "2.0", id: message.id };
            if (message.method === scenario.method) response.error = scenario.error;
            else response.result = message.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { tools: [{ name: "fixture" }] };
            child.stdout.write(`${JSON.stringify(response)}\n`);
          }
        });
        child.kill = () => { if (child.exitCode === null) { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); } return true; };
        return child;
      };
      const manager = new NativeMcpClientManager({ store, spawn, env: { ELECTRON_RUN_AS_NODE: "1" } });
      t.after(async () => { await manager.close(); store.close(); });
      const operation = scenario.method === "tools/list" ? manager.listTools(server.id) : manager.callTool(server.id, "fixture", {});
      await assert.rejects(operation, error => {
        assert.equal(error.code, scenario.expected);
        assert.equal(error.message.includes("OFFICIAL_SKILL_"), false);
        assert.equal(error.message.includes("private-detail"), false);
        return true;
      });
      assert.equal(spawnCount, 1);
      assert.equal(methods.filter(method => method === scenario.method).length, 1, "failed operations must not be replayed");
    });
  }
});

test("session metadata comes only from a valid scope UUID and stays inside the trusted official bridge", async t => {
  const sessionId = "2a112bac-4755-49b3-989b-0123456789ab", forged = "3a112bac-4755-49b3-989b-0123456789ab";
  const key = "shoggoth/official-session-id";
  const f = installation(t, "alipay"), store = new NativeMcpStore({ paths: f.paths }).open(), messages = [];
  const customCommand = path.join(f.base, "custom-mcp");
  fs.writeFileSync(customCommand, "fixture executable\n", { mode: 0o700 });
  const add = (id, transport) => store.add({ server: { id, name: id, enabled: true, source: { kind: "custom" }, transport,
    auth: { kind: "none" }, secretRef: null, setup: { requiredFields: [], configuredFields: [] },
    status: "checking", lastCheck: null, disabledProfileIds: [] }, expectedRevision: store.revision });
  add("official", { kind: "stdio-command", command: process.execPath, args: f.args, cwd: f.root });
  add("custom", { kind: "stdio-command", command: customCommand, args: f.args, cwd: f.root });
  add("remote", { kind: "remote", protocol: "streamable-http", url: "https://fixture.example/mcp" });
  const resultFor = message => message.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : message.method === "tools/list" ? { tools: [{ name: "fixture", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "ok" }] };
  const spawn = (command) => {
    const child = new EventEmitter(), peer = command === process.execPath ? "official" : "custom";
    child.exitCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let buffer = "";
    child.stdin.on("data", chunk => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"), message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        messages.push({ peer, message });
        if (message.id !== undefined) child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: resultFor(message) })}\n`);
      }
    });
    child.kill = () => { if (child.exitCode === null) { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); } return true; };
    return child;
  };
  const fetch = async (_input, init) => {
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(init.body); messages.push({ peer: "remote", message });
    if (message.id === undefined) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: resultFor(message) }), { headers: { "content-type": "application/json" } });
  };
  const manager = new NativeMcpClientManager({ store, spawn, fetch });
  t.after(async () => { await manager.close(); store.close(); });
  const calls = peer => messages.filter(item => item.peer === peer && item.message.method === "tools/call").map(item => item.message);
  for (const value of [sessionId, sessionId.toUpperCase(), "2a112bac-4755-79b3-989b-0123456789ab"]) {
    await manager.callTool("official", "fixture", {}, { officialSessionId: value });
    assert.equal(calls("official").at(-1).params._meta[key], value);
  }
  for (const value of [undefined, null, "", 42, new String(sessionId), ` ${sessionId}`, `${sessionId}\n`,
    "00000000-0000-0000-0000-000000000000", "2a112bac-4755-09b3-989b-0123456789ab", "2a112bac-4755-49b3-189b-0123456789ab"]) {
    await manager.callTool("official", "account_status", {}, { officialSessionId: value });
    assert.equal(Object.hasOwn(calls("official").at(-1).params, "_meta"), false, "invalid/missing UUID must not add metadata or stop unrelated calls");
  }
  const modelArgs = { officialSessionId: forged, _meta: { [key]: forged } };
  await manager.callTool("official", "fixture", modelArgs, { officialSessionId: sessionId, _meta: { [key]: forged } });
  assert.deepEqual(calls("official").at(-1).params, { name: "fixture", arguments: modelArgs, _meta: { [key]: sessionId } });
  await manager.callTool("official", "fixture", modelArgs);
  assert.equal(Object.hasOwn(calls("official").at(-1).params, "_meta"), false, "model arguments never supply scope metadata");
  for (const peer of ["custom", "remote"]) {
    await manager.callTool(peer, "fixture", {}, { officialSessionId: sessionId, _meta: { [key]: forged } });
    assert.equal(calls(peer).at(-1).params._meta?.[key], undefined, "non-official peers never receive the scope UUID");
    assert.equal(JSON.stringify(calls(peer).at(-1)).includes(sessionId), false);
  }
  for (const { message } of messages.filter(item => item.message.method !== "tools/call")) {
    assert.equal(message.params?._meta?.[key], undefined, "negotiation and listing never receive session metadata");
  }
});
