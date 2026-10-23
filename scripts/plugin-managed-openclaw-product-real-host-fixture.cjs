#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const { createManagedOpenClawProductHost } = require("../app/managed-openclaw-product-host");
const { createManagedOpenClawProductAuth } = require("../app/managed-openclaw-product-auth");
const { createManagedOpenClawHostClient } = require("../app/managed-openclaw-host-client");
const { installManagedPluginHostQuitGate } = require("../app/managed-plugin-host-quit");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { createConfigStore } = require("../app/core/config-store");
const { startStaticServer } = require("../app/static-server");
const { resolveManagedOpenClawProductInputs } = require("../app/managed-openclaw-product-inputs");
const { supportsOpenClawPluginSelection } = require("../app/core/openclaw-plugin-selection");
const repo = path.resolve(__dirname, "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, label, milliseconds = 100000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await callback()) return; await delay(100); }
  throw new Error(`${label} timed out`);
}
async function main() {
  const managerStateDir = fs.realpathSync(process.argv[2]);
  const privateStateDir = fs.realpathSync(process.argv[3]);
  assert(managerStateDir.startsWith("/private/tmp/sg-managed-openclaw-"));
  assert(privateStateDir.startsWith("/private/tmp/sg-managed-worker-product-"));
  assert.equal(fs.statSync(privateStateDir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(privateStateDir), []);
  const output = process.argv[4] || path.join(privateStateDir, "product-public-evidence.json");
  const sourceInput = resolveManagedOpenClawProductInputs({ openclawBin: "/opt/homebrew/bin/openclaw", architecture: "arm64" });
  const globalFile = require('node:path').join(require('node:os').homedir(), '.openclaw', 'openclaw.json');
  const hashFile = file => fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
  const globalBefore = hashFile(globalFile);
  let modelCalls = 0, legacyReads = 0, clients = 0, unavailable = 0, ready = 0;
  const cases = [], physical = [], latencies = [];
  const model = http.createServer((req, res) => { let text = ""; req.on("data", chunk => text += chunk); req.on("end", () => {
    JSON.parse(text); modelCalls += 1; res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "Product-owned private environment result." }, null], [{}, "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "product-local", object: "chat.completion.chunk", created: 1, model: "product-local",
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    } res.end("data: [DONE]\n\n");
  }); });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const store = createConfigStore(path.join(privateStateDir, "app-config.json")); store.ensure();
  const gatewayConfiguration = { models: { mode: "replace", providers: { local: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "fixture-only", api: "openai-completions",
    agentRuntime: { id: "openclaw" }, models: [{ id: "product-local", name: "Product Local", input: ["text"], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
  } } }, agents: { defaults: { model: { primary: "local/product-local" }, heartbeat: { every: "0m" } } }, tools: { profile: "minimal" } };
  let backend, worker, web, heartbeat;
  const host = createManagedOpenClawProductHost({ getMode: () => store.read().openclawPluginHostMode,
    getEnabled: () => !store.read().disabledBackends.includes("openclaw"),
    setManagedMode: () => store.write({ openclawPluginHostMode: "managed" }),
    createClient: () => { clients += 1; return worker = createManagedOpenClawHostClient({ ...sourceInput,
      stateDir: managerStateDir, supervisorStateDir: privateStateDir, serviceUserDataRoot: privateStateDir,
      resourcesRoot: path.join(repo, "resources/external-plugin-host-patches"),
      adapterResourcesRoot: path.join(repo, "resources/external-plugin-adapters"), gatewayConfiguration }); },
    onUnavailable: async () => { unavailable += 1; await backend?.stop(); },
    onReady: async () => { ready += 1; await backend.start(); },
  });
  const legacyResolver = { getGatewayUrl: () => "ws://127.0.0.1:1", resolveConnectAuth() { legacyReads += 1; throw Error("legacy auth forbidden"); },
    async resolveConnectAuthAsync() { legacyReads += 1; throw Error("legacy auth forbidden"); },
    storeDeviceToken() { legacyReads += 1; throw Error("legacy auth forbidden"); }, clearDeviceToken() { legacyReads += 1; throw Error("legacy auth forbidden"); } };
  const dataRoot = path.join(privateStateDir, "external-plugin-host-data/openclaw/v1");
  const auth = createManagedOpenClawProductAuth({ host, legacyResolver,
    credentialsDir: path.join(privateStateDir, "credentials/managed-openclaw"), dataRoot });
  backend = new OpenClawBackend({ getUpstreamUrl: () => host.getEndpoint()?.url || "", getOrigin: () => "http://127.0.0.1",
    authResolver: auth, getManagedExecution: () => host.getExecution() });
  try {
    web = await startStaticServer(0, { registry: { backends: new Map([["openclaw", backend]]) }, managedOpenClawHost: host,
      configStore: store, homeDir: path.join(dataRoot, "home"), userDataRoot: privateStateDir });
    const endpoint = `${web.url}/__api/plugins/host-runtime/openclaw`;
    async function request(url = endpoint, options = {}) {
      const response = await fetch(url, options); const text = await response.text();
      assert(!text.includes(dataRoot) && !text.includes("controlToken") && !text.includes("gatewayToken"));
      return { status: response.status, body: JSON.parse(text) };
    }
    const headers = { origin: web.url, "content-type": "application/json" };
    const action = (kind, operationId) => request(`${endpoint}/${kind}`, { method: "POST", headers, body: JSON.stringify({ operationId }) });
    const initial = await request(); assert.equal(initial.body.state, "idle"); assert.equal(clients, 0);
    cases.push("production status GET leaves existing mode lazy without a Worker, identity, Host or model");
    heartbeat = setInterval(() => { const start = Date.now(); request().then(() => latencies.push(Date.now() - start)).catch(() => {}); }, 100);
    const prepare = await action("prepare", "product-prepare-first"); assert.equal(prepare.status, 202); assert.equal(prepare.body.selectionSupported, false);
    await until(() => host.getStatus().state === "running" || host.getStatus().state === "needs_verification", "product prepare");
    assert.equal(host.getStatus().state, "running", JSON.stringify(host.getStatus()));
    const first = host.getEndpoint(); assert(first); physical.push(first.identity);
    const receipt = await request(`${endpoint}/operations/product-prepare-first`);
    assert.equal(receipt.body.state, "running"); assert.equal(receipt.body.selectionSupported, true); assert.equal(Object.keys(receipt.body).length, 7);
    assert.equal((await action("prepare", "product-prepare-first")).status, 202); assert.equal(clients, 1);
    assert.equal((await request(`${endpoint}/operations/missing`)).status, 404);
    assert.equal(modelCalls, 0); assert.equal(store.read().openclawPluginHostMode, "managed");
    cases.push("real ProductHost/HTTP prepare uses the trusted Worker and paused health/resume; duplicate original key observes only");
    const agents = await backend.listAgents(); assert(agents.some(agent => agent.id === "main"));
    const capabilities = await backend.request("chat.selection.capabilities", {});
    assert.equal(supportsOpenClawPluginSelection(capabilities), true); assert.equal(legacyReads, 0); assert.equal(modelCalls, 0);
    assert(auth.resolveConnectAuth(first.url).deviceId); assert.equal(auth.getGatewayUrl(), first.url);
    assert.equal(fs.statSync(path.join(privateStateDir, "credentials/managed-openclaw")).mode & 0o077, 0);
    assert.throws(() => auth.resolveConnectAuth("ws://127.0.0.1:1"), { code: "MANAGED_HOST_ENDPOINT_UNVERIFIED" });
    cases.push("production Backend authenticates to the actual private Gateway with the shared private operator identity; zero legacy credential access");
    const key = "agent:main:product-private-turn";
    await backend.request("chat.send", { sessionKey: key, message: "Verify product private composition.", idempotencyKey: crypto.randomUUID() });
    await until(() => modelCalls === 1, "actual private model");
    await until(async () => JSON.stringify(await backend.request("chat.history", { sessionKey: key, limit: 20 })).includes("Product-owned private environment result."), "actual persisted result");
    cases.push("published product endpoint and production Backend drive the real local model and persist its result in the private environment");
    await action("stop", "product-stop-first"); await until(() => host.getStatus().state === "stopped" || host.getStatus().state === "needs_verification", "owned product stop");
    assert.equal(host.getStatus().state, "stopped", JSON.stringify(host.getStatus())); assert.equal(host.getEndpoint(), null); assert.equal(host.getExecution(), null);
    assert.throws(() => process.kill(first.identity.pid, 0));
    await assert.rejects(auth.resolveConnectAuthAsync(first.url), { code: "MANAGED_HOST_ENDPOINT_UNVERIFIED" });
    const configFile = path.join(dataRoot, "openclaw.json"), saved = JSON.parse(fs.readFileSync(configFile));
    saved.models.providers.local.models[0].name = "Retained product model"; fs.writeFileSync(configFile, JSON.stringify(saved), { mode: 0o600 });
    await action("prepare", "product-start-second"); await until(() => host.getStatus().state === "running" || host.getStatus().state === "needs_verification", "second private generation");
    assert.equal(host.getStatus().state, "running", JSON.stringify(host.getStatus())); const second = host.getEndpoint(); physical.push(second.identity);
    assert.notEqual(first.identity.pid, second.identity.pid); assert.equal(clients, 1);
    assert.equal(JSON.parse(fs.readFileSync(configFile)).models.providers.local.models[0].name, "Retained product model");
    assert.equal((await request(`${endpoint}/operations/product-prepare-first`)).body.selectionSupported, false);
    await backend.listAgents(); assert.equal(legacyReads, 0);
    cases.push("verified owned stop revokes old endpoint/auth; new generation retains only private configuration and never starts a second Worker");
    const firstClient = worker;
    store.write({ disabledBackends: ["openclaw"] });
    assert.equal(host.getEndpoint(), null); assert.equal(host.getExecution(), null);
    const disabled = await action("restart", "product-disabled-restart");
    assert.equal(disabled.status, 409); assert.equal(disabled.body.code, "MANAGED_HOST_BACKEND_DISABLED");
    await host.suspend({ operationId: "product-owned-disable", timeoutMs: 60000 });
    assert.equal(host.getStatus().state, "stopped"); assert.equal(firstClient.getStatus().state, "closed");
    assert.throws(() => process.kill(second.identity.pid, 0)); assert.equal(clients, 1);
    store.write({ disabledBackends: [] });
    await action("prepare", "product-explicit-enable");
    await until(() => host.getStatus().state === "running" || host.getStatus().state === "needs_verification", "explicit re-enable");
    assert.equal(host.getStatus().state, "running", JSON.stringify(host.getStatus()));
    assert.equal(clients, 2); physical.push(host.getEndpoint().identity);
    assert.equal(JSON.parse(fs.readFileSync(configFile)).models.providers.local.models[0].name, "Retained product model");
    await backend.listAgents(); assert.equal(legacyReads, 0); assert.equal(modelCalls, 1);
    cases.push("disabled Backend loses readiness immediately and rejects restart; a fresh Worker is allowed only after actual owned exit and explicit re-enable");
    let listener, quitCalls = 0, failures = 0;
    const fakeApp = { on: (event, callback) => { assert.equal(event, "before-quit"); listener = callback; }, quit: () => { quitCalls += 1; } };
    const gate = installManagedPluginHostQuitGate({ app: fakeApp, getHost: () => host, onFailure: () => { failures += 1; } });
    let prevented = 0; listener({ preventDefault: () => { prevented += 1; } }); await gate.pending();
    assert.equal(prevented, 1); assert.equal(quitCalls, 1); assert.equal(failures, 0); assert.equal(gate.complete(), true);
    assert.equal(host.getStatus().state, "stopped"); assert.equal(worker.getStatus().state, "closed");
    for (const identity of physical) assert.throws(() => process.kill(identity.pid, 0));
    assert.equal(fs.existsSync(path.join(dataRoot, "writer.fence")), false);
    cases.push("the production quit gate defers quit until the real owned child exit and fence release, then confirms the Worker closed");
    clearInterval(heartbeat); heartbeat = null;
    assert(latencies.length > 10 && Math.max(...latencies) < 1500); assert.equal(hashFile(globalFile), globalBefore);
    assert.equal(modelCalls, 1); assert.equal(legacyReads, 0);
    const files = ["app/ui-entry.js", "app/managed-openclaw-product-host.js", "app/managed-openclaw-product-auth.js",
      "app/managed-openclaw-host-client.js", "app/managed-openclaw-host-worker.js", "app/managed-openclaw-host-supervisor.js",
      "app/static-server.js", "app/core/openclaw-backend.js", "app/core/openclaw-local-runtime-scope.js"];
    const report = { version: 1, status: "PASS", cases, physicalChildren: physical, modelRequests: modelCalls, globalWrites: 0, legacyAuthReads: legacyReads,
      clientCreations: clients, lifecycle: { unavailable, ready }, publicStatusLatency: { observations: latencies.length, maximumMs: Math.max(...latencies) },
      sourceSha256: Object.fromEntries(files.map(file => [file, hashFile(path.join(repo, file))])),
      boundary: "Actual product factories + HTTP + Worker + manager + captured Gateway + Backend/private Auth + local model; Electron app composition source hashed, full Electron launch and packaging unverified" };
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, groups: cases.length, modelRequests: modelCalls, publicStatusLatency: report.publicStatusLatency, evidence: output }));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try { await host.close({ operationId: "product-fixture-final-close", timeoutMs: 60000 }); } catch (error) { console.error("owned cleanup unverified: " + error.code); }
    await backend.stop(); await web?.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
