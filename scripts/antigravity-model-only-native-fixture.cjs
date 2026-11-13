"use strict";
// Real signed ACP + Google harness; private file auth points only to loopback.
// The OS sandbox denies external network and writes outside this fixture.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { spawn } = require("node:child_process");
const { AntigravityAcpRuntimeHost } = require("../app/agent-service/antigravity-acp-runtime-host");
const { verifyAntigravityAcpServer } = require("../app/agent-service/antigravity-acp-distribution");
const { generateAcpModelOnly } = require("../app/agent-service/acp-model-only");
const { RuntimeAdapterRegistry } = require("../app/agent-service/runtime-adapter-registry");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { normalizeDefinition } = require("../app/agent-service/condition-watch-protocol");
const root = fs.mkdtempSync("/private/tmp/sg-agy-heartbeat-"), home = path.join(root, "home");
const paths = { trustedRoot: root, stateDir: path.join(root, "state"), runtimeDir: path.join(root, "run") };
const sourcePaths = { stateDir: process.argv[2], trustedRoot: path.dirname(process.argv[2]) };
const sockets = new Set(), requests = [], urls = []; let host, pool, response, fixtureError, diagnostic = "";
const provider = http.createServer(async (req, res) => {
  try {
    urls.push(req.url);
    if (req.method === "GET") { res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "models/gemini-3.1-pro-preview", displayName: "Fixture", inputTokenLimit: 32000,
        outputTokenLimit: 512, supportedGenerationMethods: ["generateContent"] }] })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    assert.match(req.url, /gemini-3.1-pro-preview:(?:streamGenerateContent|generateContent)/u);
    assert.deepEqual(body.tools || [], []);
    assert.equal(req.headers.authorization, "Bearer synthetic-loopback-key");
    const output = { candidates: [{ content: { role: "model", parts: [{ text: response ? response(body)
      : JSON.stringify({ outcome: "silent", scratch: "Native Antigravity checked" }) }] },
      finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20,
        cachedContentTokenCount: 0, thoughtsTokenCount: 0 }, modelVersion: "gemini-3.1-pro-preview" };
    if (req.url.includes("streamGenerateContent")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(`data: ${JSON.stringify(output)}\n\n`); }
    else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(output)); }
  } catch (error) { fixtureError = error; res.writeHead(500); res.end("fixture rejected request"); }
});
provider.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });

async function verifyWatch(adapter, setResponse) {
  const registry = new RuntimeAdapterRegistry();
  registry.register("antigravity", adapter);
  const servicePaths = resolveServicePaths({ homeDir: home, trustedRoot: root, stateRoot: path.join(root, "watch-state"),
    profileRoot: path.join(root, "watch-profiles"), cacheRoot: path.join(root, "watch-cache") });
  const profileId = DEFAULT_AGENT_PROFILE_ID;
  const url = "https://fixture.example.com/inventory";
  const criteria = "Only report a verified transition to in stock.";
  let clock = Date.UTC(2026, 10, 13, 4);
  let inStock = false;
  const service = createAgentService({ paths: servicePaths, runtimeManager: registry, prewarmMcpAuth: false,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    now: () => clock, setCronTimer: () => 1, clearCronTimer() {}, setConditionWatchTimer: () => 1, clearConditionWatchTimer() {},
    conditionWatchReadProbe: async () => ({ value: inStock, binding: { url }, validator: null }) });
  const call = (method, params) => service.conditionWatchService.handle(method, params);
  const until = async fn => {
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      const value = fn();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail("Timed out waiting for Antigravity Condition Watch");
  };
  try {
    await service.start();
    const products = service.productStore;
    const bindingState = products.getAgentRuntimeBindings(profileId);
    const binding = products.addAgentRuntimeBinding(profileId, { runtime: "antigravity",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID }, { operationId: "condition-watch-add-antigravity" });
    const latest = products.getAgentRuntimeBindings(profileId);
    const antigravity = latest.bindings.find(entry => entry.runtime === "antigravity");
    assert(antigravity && latest.revision > bindingState.revision && binding);
    products.setAgentDefaultBinding(profileId, antigravity.id, { revision: latest.revision });
    const session = service.chatSessionStore.createSession({ operationId: "condition-watch-native-session", profileId,
      workspace: null, createdAt: clock, defaultBindingId: antigravity.id });
    const definition = normalizeDefinition({ name: "Native watch review", source: { kind: "public_json", url, path: ["inStock"] },
      predicate: { op: "equals", value: true }, intervalMs: 60_000, action: "agent_review", reviewInstruction: criteria });
    const before = requests.length;
    const { watch } = call("watch.create", { operationId: "condition-watch-native-create", target: { sessionKey: session.sessionKey }, definition });
    const { watch: preview } = await call("watch.test", { watchId: watch.id, expectedRevision: watch.revision });
    assert.equal(preview.preview.ok, true, JSON.stringify(preview.preview));
    assert.equal(preview.reviewAvailable, true);
    call("watch.setEnabled", { operationId: "condition-watch-native-enable", watchId: watch.id,
      expectedRevision: preview.revision, enabled: true });
    const history = () => service.conditionWatchStore.history(watch.id).checks;
    const tick = () => service.conditionWatchService.tick();
    tick();
    await until(() => history().find(check => check.outcome === "seed"));
    clock += 60_000;
    tick();
    await until(() => history().find(check => check.outcome === "silent"));
    assert.equal(requests.length, before);
    inStock = true;
    clock += 60_000;
    tick();
    const hit = await until(() => history().find(check => check.event?.state === "review_queued"));
    assert.equal(requests.length, before);
    setResponse(body => {
      const input = JSON.stringify(body);
      assert(input.includes(criteria) && input.includes(hit.event.id));
      return JSON.stringify({ decision: "report", evidenceIds: [hit.event.id], note: "The inventory became available." });
    });
    tick();
    const checked = await until(() => history().find(check => ["published", "review_failed", "review_uncertain"].includes(check.event?.state)));
    assert.equal(checked.event.state, "published", JSON.stringify(checked.event));
    assert.deepEqual(checked.event.review.usage, { inputTokens: 12, outputTokens: 8 });
    assert.equal(requests.length, before + 1);
    const notices = () => service.transcriptStore.listEvents(profileId, session.id).filter(event => event.content?.proactiveNotice?.watchId === watch.id);
    assert.equal(notices().length, 1);
    await service.stop({ notify: false });
    await service.start();
    clock += 60_000;
    tick();
    await until(() => history().find(check => check.startedAt === clock && check.outcome === "silent"));
    assert.equal(requests.length, before + 1);
    assert.deepEqual(notices().map(event => event.id), [checked.event.receipt.messageId]);
    return { providerRequests: 1, usage: checked.event.review.usage, model: checked.event.review.model, restartNoReplay: true };
  } finally { setResponse(null); await service.stop({ notify: false }); }
}

(async () => {
  const server = await verifyAntigravityAcpServer({ paths: sourcePaths });
  for (const dir of [home, paths.stateDir, paths.runtimeDir, path.join(root, "tmp"), path.join(home, ".gemini", "antigravity-acp")])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".gemini", "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: "gateway" } }), { mode: 0o600 });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const sandbox = path.join(root, "sandbox.sb");
  fs.writeFileSync(sandbox, `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(root)}))\n` +
    `(deny network*)\n(allow network-bind (local ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n` +
    `(allow network-outbound (remote ip "localhost:*"))\n(allow network* (subpath ${JSON.stringify(root)}))\n`);
  const runtimeEnvironment = Object.freeze({ runtime: "antigravity", runtimeAccountId: "native-antigravity-default-v1",
    kind: "native-user", installationKind: "system", homeKind: "integration", strategy: "account-integration", home,
    nativeHome: path.join(root, "native", ".gemini"), configSourceHome: null, integrationRoot: root,
    binaryPath: server.serverPath, launchArgs: Object.freeze([]), spawnEnv: Object.freeze({ HOME: home }), configurationMode: "integration" });
  const hostOptions = { paths, runtimeEnvironment, runtimeProfileId: "native-heartbeat-fixture",
    runtimeAccountId: "native-antigravity-default-v1", workspace: null, modelOnlyInstance: true,
    permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" }, credentialStorage: "file",
    parentEnv: { PATH: process.env.PATH, TMPDIR: path.join(root, "tmp"), NO_PROXY: "localhost,127.0.0.1" },
    verifyServer: async () => server, mcpGateIssuer: { createMcpServer() { throw Error("No MCP in model-only run"); } },
    requestTimeoutMs: 30000, initializeTimeoutMs: 30000, acceptanceTimeoutMs: 30000, promptTimeoutMs: 60000,
    spawnProcess: (binary, args, options) => {
      const child = spawn("/usr/bin/sandbox-exec", ["-f", sandbox, binary, ...args], { ...options, env: { ...options.env,
        AGY_ACP_ENABLE_GATEWAY_AUTH: "1", AGY_LLM_GATEWAY_URL: `http://127.0.0.1:${provider.address().port}`,
        AGY_LLM_GATEWAY_API_KEY: "synthetic-loopback-key", AGY_LLM_GATEWAY_MODELS: "gemini-3.1-pro-preview" } });
      child.stderr.on("data", data => { diagnostic = (diagnostic + data).slice(-5000); }); return child;
    } };
  host = new AntigravityAcpRuntimeHost(hostOptions);
  await host.initialize();
  assert.deepEqual(await host.authenticationState({ allowDeferred: true }), { verificationDeferred: true });
  const result = await generateAcpModelOnly(host, { model: "gemini-3.1-pro-high", operationId: "native-heartbeat-review",
    prompt: "Return the requested JSON check with short working notes.", timeoutMs: 60000 });
  if (fixtureError) throw fixtureError;
  assert.equal(JSON.parse(result.text).scratch, "Native Antigravity checked");
  assert.equal(result.usage?.totalTokens, 20); assert.equal(requests.length, 1); assert.equal(host.state, "stopped");
  assert.equal(host.processGroupExists(host.child.pid), false);
  pool = new (require("../app/agent-service/antigravity-runtime-pool").AntigravityRuntimePool)({ paths,
    runtimeAccountResolver: { resolve: () => runtimeEnvironment }, hostOptions });
  const adapter = new (require("../app/agent-service/antigravity-runtime-adapter").AntigravityRuntimeAdapter)({ runtimePool: pool });
  const setResponse = value => { response = value; };
  const closure = process.argv.includes("--watch-only") ? null : await require("./helpers/proactive-native-closure.cjs").verifyProactiveNativeClosure({
    root, adapter, runtime: "antigravity", model: "gemini-3.1-pro-high", setResponse });
  const watch = await verifyWatch(adapter, setResponse);
  if (fixtureError) throw fixtureError;
  console.log(JSON.stringify({ verified: true, runtime: "Antigravity", runtimeVersion: server.version, signedNativeHarness: true,
    provider: "synthetic-loopback", actualProviderCalls: 0, nativeTools: 0, modelRequests: requests.length,
    totalTokens: result.usage.totalTokens, processStopped: true, closure, watch }));
})().catch(error => { console.error(JSON.stringify({ verified: false, code: error.code || error.message, stack: error.stack,
  fixtureError: fixtureError?.message, urls, requests: requests.length, diagnostic })); process.exitCode = 1; }).finally(async () => {
  await pool?.stopAll(); await host?.stop(); for (const socket of sockets) socket.destroy();
  await new Promise(resolve => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
});
