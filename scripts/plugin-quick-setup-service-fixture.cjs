"use strict";

// End to end on a real isolated Service: an Agent-authored plugin with a
// remote HTTP MCP (bearer `${secret:DEMO_TOKEN}`) and a local Node MCP (env
// `${secret:LOCAL_TOKEN}`) goes from create → install → credential card →
// one confirmed activation → tools callable in the next Run, then survives a
// credential rotation, a clear and a Service restart. Values never surface.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createFixture } = require("./plugin-real-host-service-fixture.cjs");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { isNativeOnlyMcpTool } = require("../app/agent-service/mcp-product-tool-controller");

const TOOLS = [
  { name: "echo", description: "Echo a value", inputSchema: { type: "object",
    properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
  { name: "delete_item", description: "Delete an item", annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
];

function reply(message, extra) {
  if (!message || message.method === "notifications/initialized") return null;
  if (message.method === "initialize") {
    return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "quick-setup-fixture", version: "1" } } };
  }
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } };
  if (message.method === "tools/call") {
    return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }],
      structuredContent: { echoed: message.params?.arguments?.value ?? null, ...extra }, isError: false } };
  }
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
}

// Contained Node MCP server; reads its credential only from the injected env.
const LOCAL_SERVER = `"use strict";
const readline = require("node:readline");
const injected = process.env.LOCAL_TOKEN;
const tools = [{ name: "whoami", description: "Report credential presence", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "notifications/initialized") return;
  let result;
  if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local", version: "1" } };
  else if (message.method === "tools/list") result = { tools };
  else if (message.method === "tools/call") result = { content: [{ type: "text", text: "ok" }], structuredContent: { present: typeof injected === "string" && injected.length > 0, suffix: (injected || "").slice(-4), pid: process.pid }, isError: false };
  const response = result ? { jsonrpc: "2.0", id: message.id, result } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  process.stdout.write(JSON.stringify(response) + "\\n");
});
`;

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-quick-setup-")));
  const expected = { bearer: "demo-token-1234567890", seen: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      expected.seen.push(req.headers.authorization || null);
      if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
      if (req.headers.authorization !== `Bearer ${expected.bearer}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const response = reply(JSON.parse(body), { authorized: true });
      if (!response) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  const key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
    } };
  const fixture = createFixture(root, "openclaw", { safeStorage, pluginAllowLoopback: true,
    pluginInterpreterCandidates: kind => kind === "node" ? [path.join(root, "missing", "node"), process.execPath] : [] });
  let service;
  let runId = null;
  try {
    service = await fixture.start();
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    const authority = (extra = {}) => ({ profileId: profile.id, callId: crypto.randomUUID(), ...extra });
    const invoke = (name, args, actor = authority()) => service.mcpProductToolController.handle(name, args, actor);
    assert.equal(isNativeOnlyMcpTool("plugin_secret_request"), true, "only a native Run can raise the card");
    assert.equal(isNativeOnlyMcpTool("plugin_activate"), true, "Hermes/OpenClaw use Plugins to activate");

    const draft = await invoke("plugin_create", { name: "quick-demo", description: "Quick setup fixture", files: [
      { path: "skills/quick-demo/SKILL.md", content: "---\nname: quick-demo\ndescription: Use the quick demo MCP tools.\n---\n# Quick demo\nCall echo.\n" },
      { path: ".mcp.json", content: JSON.stringify({ mcpServers: {
        remote: { type: "http", url: endpoint, headers: { Authorization: "Bearer ${secret:DEMO_TOKEN}" } },
        local: { command: "node", args: ["./server/local.cjs"], env: { LOCAL_TOKEN: "${secret:LOCAL_TOKEN}" } },
      } }) },
      { path: "server/local.cjs", content: LOCAL_SERVER },
    ] });
    assert.equal(draft.installable, true, JSON.stringify(draft.diagnostics));
    const installed = await invoke("plugin_install", { draftId: draft.draftId, previewDigest: draft.previewDigest,
      expectedRevision: 0, enable: true }, authority({ confirmation: true }));
    const installationId = installed.installation.installationId;

    let setup = await invoke("plugin_setup_get", { installationId });
    const byName = state => Object.fromEntries(state.components.map(item => [item.name, item]));
    assert.deepEqual(Object.values(byName(setup)).map(item => item.state).sort(), ["secret_required", "secret_required"]);
    assert.equal(byName(setup).local.interpreter, "node");
    assert.equal(byName(setup).local.interpreterReady, false);
    assert.equal(byName(setup).remote.target, endpoint);
    assert.deepEqual(setup.nextSteps, ["provide_secret:DEMO_TOKEN", "provide_secret:LOCAL_TOKEN"]);
    const listed = service.pluginComponentCatalog.list().find(item => item.installationId === installationId);
    assert.deepEqual(listed.components.filter(item => item.kind === "mcp-server").map(item => item.state),
      ["secret_required", "secret_required"]);

    // The product tool needs the current native Run; with none it refuses.
    await assert.rejects(invoke("plugin_secret_request", { installationId, name: "DEMO_TOKEN", reason: "fixture" }),
      error => error.code === "PLUGIN_SECRET_INPUT_UNAVAILABLE");
    let card = null;
    const stored = await service.pluginQuickSetup.requestSecret({ profileId: profile.id, installationId,
      name: "DEMO_TOKEN", reason: "在 fixture 控制台复制令牌", ask: async value => { card = value; return expected.bearer; } });
    assert.equal(stored.status, "stored");
    assert.match(card.message, /DEMO_TOKEN/u);
    assert.match(card.message, /请求头 Authorization/u);
    assert.match(card.message, /不会发送给模型/u);
    assert.match(card.message, /它说：在 fixture 控制台复制令牌/u);
    assert.equal(JSON.stringify(stored).includes(expected.bearer), false);
    const canceled = await service.pluginQuickSetup.requestSecret({ profileId: profile.id, installationId,
      name: "LOCAL_TOKEN", reason: "fixture", ask: async () => null });
    assert.equal(canceled.status, "canceled");
    await assert.rejects(service.pluginQuickSetup.requestSecret({ profileId: profile.id, installationId,
      name: "OTHER_TOKEN", reason: "fixture", ask: async () => "never-used-1234" }), error => error.code === "PLUGIN_SECRET_NOT_DECLARED");
    const prepared = service.pluginQuickSetup.prepareSecret({ profileId: profile.id, installationId, name: "LOCAL_TOKEN", clear: false });
    assert.deepEqual(prepared.summary.destinations, [{ component: "local", kind: "env", key: "LOCAL_TOKEN" }]);
    const local = await service.pluginQuickSetup.commitSecret({ challenge: prepared.challenge, approved: true, value: "local-secret-0987654321" });
    assert.equal(local.result.configured, true);
    assert.equal(service.secretStore.matchesPlaintext(`x ${expected.bearer} y`), true, "stored values join the secret canary");

    setup = await invoke("plugin_setup_get", { installationId });
    assert.deepEqual(setup.nextSteps, ["activate"]);
    await assert.rejects(invoke("plugin_activate", { installationId, releaseDigest: setup.releaseDigest }),
      error => error.code === "MCP_TOOL_CONFIRMATION_REQUIRED");
    const activated = await invoke("plugin_activate", { installationId, releaseDigest: setup.releaseDigest },
      authority({ confirmation: true }));
    const done = byName(activated);
    assert.equal(done.remote.state, "ready", JSON.stringify(activated));
    assert.equal(done.local.state, "ready", JSON.stringify(activated));
    assert.deepEqual(done.remote.eachCallTools, ["delete_item"]);
    assert.equal(done.local.interpreterReady, true);
    assert.deepEqual(activated.nextSteps, ["ready_next_turn"]);
    const bindings = service.pluginStore.listGlobalBindings().filter(item => item.installationId === installationId);
    assert.equal(bindings.length, 2);
    const remoteBinding = bindings.find(item => item.componentId === done.remote.componentId);
    const records = service.pluginStore.getCapabilityRecords(remoteBinding.bindingId, "__projection__");
    const modes = Object.fromEntries(service.pluginToolCatalogRegistry.listForBinding(records).entries
      .map(entry => [entry.downstreamName, service.pluginStore.getGrant(remoteBinding.bindingId, entry.toolIdentity).approvalMode]));
    assert.deepEqual(modes, { delete_item: "each-call", echo: "always" });

    const callInNextRun = async (componentName, toolName, args, servers = 2) => {
      runId = crypto.randomUUID();
      service.workDispatcher.enqueue({ id: runId, source: "chat", sourceId: `quick-${runId}`,
        idempotencyKey: `quick-${runId}`, profileId: profile.id, workspace: root });
      const admitted = service.workDispatcher.admit(runId, { writable: false });
      assert.equal(service.pluginRuntimeToolService.captureRun(admitted.run).serverCount, servers);
      service.hookService.freezeRun(admitted.run, profile);
      service.workDispatcher.transition(runId, "running");
      const scope = { runId, assertCurrent() { assert.equal(service.workDispatcher.getRun(runId).status, "running"); } };
      const binding = bindings.find(item => item.componentId === byName(activated)[componentName].componentId);
      try {
        return (await service.pluginRuntimeToolService.callTool({ serverId: pluginServerId(binding.bindingId),
          toolName, arguments: args }, authority(), scope)).result.structuredContent;
      } finally {
        service.pluginRuntimeToolService.releaseRun(runId);
        service.workDispatcher.transition(runId, "completed");
        runId = null;
      }
    };
    assert.deepEqual(await callInNextRun("remote", "echo", { value: "hi" }), { echoed: "hi", authorized: true });
    const who = await callInNextRun("local", "whoami", {});
    assert.deepEqual([who.present, who.suffix], [true, "4321"]);

    // Rotation reconnects with the new value; the old one stops working. A
    // value the endpoint refuses is reported as rejected and sent only once.
    expected.bearer = "demo-token-rotated-24680";
    const wrong = service.pluginQuickSetup.prepareSecret({ profileId: profile.id, installationId, name: "DEMO_TOKEN", clear: false });
    const refused = await service.pluginQuickSetup.commitSecret({ challenge: wrong.challenge, approved: true, value: "demo-token-wrong-000000" });
    assert.deepEqual(refused.result.components, [{ name: "remote", state: "connection_failed", reason: "PLUGIN_SECRET_REJECTED" }]);
    assert.equal(expected.seen.filter(value => value === "Bearer demo-token-wrong-000000").length, 1, "no automatic retry");
    const rotate = service.pluginQuickSetup.prepareSecret({ profileId: profile.id, installationId, name: "DEMO_TOKEN", clear: false });
    const rotated = await service.pluginQuickSetup.commitSecret({ challenge: rotate.challenge, approved: true, value: expected.bearer });
    assert.deepEqual(rotated.result.components, [{ name: "remote", state: "ready" }]);
    assert.deepEqual(await callInNextRun("remote", "echo", { value: "again" }), { echoed: "again", authorized: true });
    assert.equal(expected.seen.includes(`Bearer ${expected.bearer}`), true);

    // A cleared value blocks the component again instead of starting it.
    const clear = service.pluginQuickSetup.prepareSecret({ profileId: profile.id, installationId, name: "DEMO_TOKEN", clear: true });
    const cleared = await service.pluginQuickSetup.commitSecret({ challenge: clear.challenge, approved: true, value: null });
    assert.deepEqual(cleared.result.components, [{ name: "remote", state: "secret_required" }]);
    assert.equal(byName(await invoke("plugin_setup_get", { installationId })).remote.state, "secret_required");
    // Clearing also stops the local process that received the old value.
    const { pid } = await callInNextRun("local", "whoami", {}, 1); // remote now lacks its secret
    const clearLocal = service.pluginQuickSetup.prepareSecret({ profileId: profile.id, installationId, name: "LOCAL_TOKEN", clear: true });
    const clearedLocal = await service.pluginQuickSetup.commitSecret({ challenge: clearLocal.challenge, approved: true, value: null });
    assert.deepEqual(clearedLocal.result.components, [{ name: "local", state: "secret_required" }]);
    assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH", "the old local process exited");
    const restore = service.pluginQuickSetup.prepareSecret({ profileId: profile.id, installationId, name: "LOCAL_TOKEN", clear: false });
    await service.pluginQuickSetup.commitSecret({ challenge: restore.challenge, approved: true, value: "local-secret-0987654321" });

    service = await fixture.restart();
    setup = await invoke("plugin_setup_get", { installationId });
    assert.deepEqual(byName(setup).remote.secrets, [{ name: "DEMO_TOKEN", configured: false }]);
    assert.deepEqual(byName(setup).local.secrets, [{ name: "LOCAL_TOKEN", configured: true }]);
    console.log("PASS plugin quick setup: ${secret:NAME} card/UI storage, one confirmed activation, next-turn HTTP+stdio calls, rotation, clear, restart");
  } finally {
    if (runId && service?.workDispatcher.getRun(runId)?.status === "running") {
      service.pluginRuntimeToolService.releaseRun(runId);
      service.workDispatcher.transition(runId, "completed");
    }
    await fixture.stop();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
