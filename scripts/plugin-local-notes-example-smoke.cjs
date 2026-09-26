#!/usr/bin/env node
"use strict";

// Source/local fixture only: production parser -> installer -> pinned interpreter
// -> real stdio client; the App script runs in a small DOM fixture, not Electron.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { previewPluginDirectory } = require("../app/agent-service/plugin-package-parser");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginDependencyRegistry } = require("../app/agent-service/plugin-dependency-registry");
const { PluginMcpLaunchPlanner } = require("../app/agent-service/plugin-mcp-launch-planner");
const { PluginMcpClient } = require("../app/agent-service/plugin-mcp-client");
const { PluginDataScopeLeaseManager } = require("../app/agent-service/plugin-data-scope-lease");
const { pluginToolContractDigest } = require("../app/agent-service/plugin-tool-contract");
const { PluginAppSessionManager, normalizeAppResource } = require("../app/agent-service/plugin-app-session");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const source = path.resolve(__dirname, "../examples/plugins/local-notes");
const URI = "ui://local-notes/editor";
const fixtureAuthority = { fixture: true };

async function appFixture({ html, manager, session }) {
  const transport = { sessionId: session.sessionId, nonce: session.nonce, sourceId: session.sourceId,
    origin: session.sandboxOrigin, conversationId: "fixture-conversation" };
  const nodes = new Map(["note", "status", "refresh", "save", "revision"].map(id => [id,
    { value: "", textContent: "", disabled: true, listeners: new Map(),
      addEventListener(type, fn) { this.listeners.set(type, fn); } }]));
  let listener, resolveInitialized;
  const initialized = new Promise(resolve => { resolveInitialized = resolve; });
  const sends = [], failures = [];
  const parent = { postMessage(raw) {
    const message = structuredClone(raw); sends.push(message);
    Promise.resolve().then(() => manager.handle(transport, message)).then(response => {
      if (response) listener({ source: parent, data: response });
      if (message.method === "ui/notifications/initialized") resolveInitialized();
    }).catch(error => { failures.push(error); resolveInitialized(); });
  } };
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
  assert.ok(script, "example has one inline App script");
  const context = vm.createContext({ parent, window: {},
    document: { getElementById(id) { assert.ok(nodes.has(id)); return nodes.get(id); } },
    addEventListener(type, fn) { assert.equal(type, "message"); listener = fn; }, setTimeout, clearTimeout });
  vm.runInContext(script, context, { timeout: 1000, filename: "local-notes-app-fixture.js" });
  await initialized; assert.deepEqual(failures, []);
  assert.equal(nodes.get("refresh").disabled, false); assert.equal(nodes.get("save").disabled, true);
  return { nodes, sends,
    seed(result) { listener({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result } }); },
    async click(id) { await nodes.get(id).listeners.get("click")(); assert.deepEqual(failures, []); },
    async close() {
      const result = manager.close(transport);
      listener({ source: parent, data: result.teardown });
      assert.equal(nodes.get("note").disabled, true);
    } };
}

async function main() {
  const temp = fs.realpathSync(fs.mkdtempSync("/tmp/sg-local-notes-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), trustedRoot: temp });
  const store = new PluginStore({ paths }).open();
  let client, manager;
  try {
    const original = previewPluginDirectory(source);
    const installer = new PluginPackageInstaller({ store }), preview = installer.preview(source);
    const installation = installer.install({ sourcePath: source, previewDigest: preview.contentDigest,
      expectedRevision: 0, operationId: "install-local-notes" });
    assert.equal(store.getInstallation(installation.installationId).desiredState, "disabled");
    const components = new PluginComponentCatalog({ store }).list()[0].components;
    assert.ok(components.some(item => item.kind === "skill" && item.localName === "local-notes"));
    const component = components.find(item => item.kind === "mcp-server" && item.localName === "notes");
    assert.ok(component);
    const pin = { installationId: installation.installationId, releaseDigest: installation.releaseDigest,
      componentId: component.componentId, descriptorDigest: component.descriptorDigest };
    const dependencies = new PluginDependencyRegistry({ store });
    const dependencyPreview = dependencies.preview({ ...pin, executablePath: process.execPath });
    assert.equal(dependencyPreview.executable.version, null);
    const prepared = dependencies.prepare({ ...pin, executablePath: process.execPath,
      previewDigest: dependencyPreview.previewDigest, expectedRevision: 0,
      operationId: "prepare-local-node", confirmed: true });
    assert.equal(prepared.executable.version, process.version);
    store.setInstallationDesiredState({ installationId: installation.installationId,
      expectedRevision: store.getInstallation(installation.installationId).revision, desiredState: "enabled" });
    const plan = new PluginMcpLaunchPlanner({ store, dependencies }).planStdio(pin);
    assert.equal(plan.command, fs.realpathSync(process.execPath));
    assert.deepEqual(plan.args.slice(0, 3), ["--no-addons", "--no-global-search-paths", "--"]);
    const leaseManager = new PluginDataScopeLeaseManager({ paths }), scopeId = sha("local-notes-fixture");
    const dataDirectory = path.join(paths.pluginDataDir, installation.installationId, scopeId);
    const noteFile = path.join(dataDirectory, "note.json"), grants = new Set(["read_note"]);
    const egress = [];
    const connect = () => PluginMcpClient.connectStdio({ ...plan, connectionId: "fixture-connection",
      principalIdentity: "fixture-local", appSupport: true, timeoutMs: 3000,
      dataScope: { leaseManager, installationId: installation.installationId, scopeId },
      authorizeEgress(request) {
        const allowed = request.authority.fixture === true && grants.has(request.toolName);
        egress.push({ name: request.toolName, allowed }); return allowed;
      } });
    client = await connect();
    const tools = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ["read_note", "write_note"]);
    assert.equal(tools[0].annotations.readOnlyHint, true);
    assert.equal(tools[1].annotations.readOnlyHint, false);
    assert.equal(tools[1].annotations.destructiveHint, true);
    for (const tool of tools) assert.equal(tool._meta.ui.resourceUri, URI);
    const call = (name, args = {}) => client.callTool(name, args, fixtureAuthority);
    const initial = await call("read_note");
    assert.deepEqual(initial.structuredContent.note, { text: "", revision: 0 });
    assert.match(initial.content[0].text, /笔记为空/u);
    await assert.rejects(call("write_note", { text: "unauthorized", expectedRevision: 0 }), { code: "CAPABILITY_FORBIDDEN" });
    assert.equal(fs.existsSync(noteFile), false);

    const resource = await client.readAppResource({ toolName: "read_note",
      contractDigest: pluginToolContractDigest(tools[0]), resourceUri: URI, assertCurrent: () => true });
    const normalized = normalizeAppResource({ tool: tools[0], resource });
    assert.equal(resource.mimeType, "text/html;profile=mcp-app");
    assert.match(normalized.policy.contentSecurityPolicy, /connect-src 'none'/u);
    assert.match(normalized.policy.contentSecurityPolicy, /frame-src 'none'/u);
    await assert.rejects(client.readAppResource({ toolName: "read_note", contractDigest: pluginToolContractDigest(tools[0]),
      resourceUri: "ui://local-notes/other", assertCurrent: () => true }), { code: "MCP_APP_RESOURCE_FORBIDDEN" });
    const identity = name => `plugin:${pin.installationId}:${pin.componentId}:fixture-connection:${sha(name)}`;
    const authority = { profileId: "fixture-profile", conversationId: "fixture-conversation", runId: "fixture-run",
      ...pin, bindingId: "fixture-binding", bindingRevision: 1, connectionId: "fixture-connection",
      principalIdentity: "fixture-local", authRevision: 1, toolIdentity: identity("read_note"),
      contractDigest: pluginToolContractDigest(tools[0]), catalogRevision: "fixture-catalog" };
    // The local authority fixture grants tools explicitly; production Permission
    // Engine/Run enforcement is covered by the dedicated management fixtures.
    delete authority.descriptorDigest;
    manager = new PluginAppSessionManager({ assertAuthority: context => client.isAlive()
      && context.connectionId === authority.connectionId,
    dispatchCapability(input) { input.assertCurrent(); return call(input.tool.downstreamName, input.arguments); } });
    const createSession = allowed => manager.create({ authority, tool: tools[0], resource,
      tools: tools.filter(tool => allowed.includes(tool.name)).map(tool => ({ downstreamName: tool.name,
        toolIdentity: identity(tool.name), contractDigest: pluginToolContractDigest(tool), visibility: tool._meta.ui.visibility })),
      hostOrigin: "http://127.0.0.1:18799", sandboxOrigin: "http://127.0.0.1:18800", sourceId: "fixture-app" });
    const readOnlyApp = await appFixture({ html: resource.text, manager, session: createSession(["read_note"]) });
    readOnlyApp.seed(initial);
    assert.equal(readOnlyApp.nodes.get("save").disabled, false);
    readOnlyApp.nodes.get("note").value = "requires a fresh authorized run";
    const callsBefore = egress.length;
    await readOnlyApp.click("save");
    assert.match(readOnlyApp.nodes.get("status").textContent, /未获授权/u);
    assert.equal(egress.length, callsBefore, "App cannot reach MCP with a tool outside its frozen allowlist");
    assert.equal(fs.existsSync(noteFile), false);
    await readOnlyApp.close();

    grants.add("write_note");
    const app = await appFixture({ html: resource.text, manager, session: createSession(["read_note", "write_note"]) });
    app.seed(initial);
    const text = '<script>throw "do not execute note data"</script>\n你好，local notes。';
    app.nodes.get("note").value = text; await app.click("save");
    assert.equal(app.nodes.get("status").textContent, "已保存。");
    assert.equal(app.nodes.get("note").value, text);
    assert.equal(app.nodes.get("revision").textContent, "版本 1");
    assert.deepEqual((await call("read_note")).structuredContent.note, { text, revision: 1 });
    assert.equal(fs.statSync(noteFile).mode & 0o777, 0o600);
    assert.equal((await call("write_note", { text: "stale", expectedRevision: 0 })).isError, true);
    assert.equal((await call("read_note", { path: "../outside" })).isError, true);
    assert.equal((await call("write_note", { text: "x".repeat(16385), expectedRevision: 1 })).isError, true);
    // JSON escaping must not make valid 16 KiB control-character notes unreadable.
    const controlText = "\u0000".repeat(16384);
    assert.equal((await call("write_note", { text: controlText, expectedRevision: 1 })).isError, false);
    assert.deepEqual((await call("read_note")).structuredContent.note, { text: controlText, revision: 2 });
    assert.equal((await call("write_note", { text, expectedRevision: 2 })).isError, false);
    await app.click("refresh"); assert.equal(app.nodes.get("note").value, text);
    assert.equal(app.nodes.get("revision").textContent, "版本 3");
    assert.deepEqual([...new Set(app.sends.map(item => item.method))].sort(),
      ["tools/call", "ui/initialize", "ui/notifications/initialized"].sort());
    await app.close();
    await client.close(); client = null;
    client = await connect(); await client.listTools();
    assert.deepEqual((await call("read_note")).structuredContent.note, { text, revision: 3 });
    const stored = fs.readFileSync(noteFile), sentinel = path.join(temp, "outside-note.json");
    fs.writeFileSync(sentinel, "outside-data-must-stay", { mode: 0o600 });
    fs.unlinkSync(noteFile); fs.symlinkSync(sentinel, noteFile);
    assert.equal((await call("read_note")).isError, true);
    assert.equal((await call("write_note", { text: "must not escape", expectedRevision: 3 })).isError, true);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside-data-must-stay");
    fs.unlinkSync(noteFile); fs.writeFileSync(noteFile, stored, { mode: 0o600 });
    fs.linkSync(noteFile, path.join(dataDirectory, "hardlink"));
    assert.equal((await call("read_note")).isError, true);
    fs.unlinkSync(path.join(dataDirectory, "hardlink"));
    fs.chmodSync(noteFile, 0o644); assert.equal((await call("read_note")).isError, true); fs.chmodSync(noteFile, 0o600);
    assert.deepEqual((await call("read_note")).structuredContent.note, { text, revision: 3 });
    assert.deepEqual(fs.readdirSync(dataDirectory), ["note.json"]);
    await client.close(); client = null;
    assert.equal(previewPluginDirectory(source).contentDigest, original.contentDigest, "source example is unchanged");
    assert.equal(previewPluginDirectory(plan.pluginRoot).contentDigest, original.contentDigest, "installed package is unchanged");
    console.log("local-notes example: parser/install/pinned Node/real stdio, explicit write gate, conflicts, App script/bridge, persistence and path defenses PASS");
    console.log("Evidence scope: isolated source fixture; no real Runtime, account, installed App, or OS process sandbox claim.");
  } finally {
    manager?.clear(); await client?.close(); store.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
