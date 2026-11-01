"use strict";
// Real pinned Codex native shell -> actual HTTP request -> local projection ->
// loopback provider. All homes, files, model responses and auth are synthetic.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const http = require("node:http"), crypto = require("node:crypto");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = require("../app/agent-service/codex-runtime-paths");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretGateway, TARGETS } = require("../app/agent-service/model-secret-gateway");
const { ModelSecretProvenance } = require("../app/agent-service/model-secret-provenance");
const { ModelSecretDisclosures } = require("../app/agent-service/model-secret-disclosures");
const repo = path.resolve(__dirname, ".."), root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-native-egress-"));
const home = path.join(root, "codex"), workspace = path.join(root, "workspace");
fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
  profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const scope = { profileId: "synthetic-agent", sessionId: "synthetic-product-session" };
const binding = { runtime: "codex", runtimeProfileId: "secret-egress-fixture", runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID };
const chatgpt = process.argv.includes("--chatgpt"), providerKind = chatgpt ? "chatgpt" : "openai-api-key";
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const auth = chatgpt ? encode({ alg: "RS256" }) + "." + encode({ exp: Math.floor(Date.now() / 1000) + 3600,
  email: "synthetic@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account", chatgpt_plan_type: "plus" } })
  + ".c3ludGhldGljLXNpZ25hdHVyZQ" : "synthetic-fixture-auth-not-a-real-credential";
const requests = [], failures = [], hosts = [];
const useProxy = process.argv.includes("--proxy"), proxyRequests = [];
const missingResponseType = process.argv.includes("--missing-response-type");
// This proxy never forwards traffic. A protected loopback request must bypass it.
const proxy = http.createServer((req, res) => {
  proxyRequests.push({ method: req.method, loopback: /^http:\/\/127\.0\.0\.1:/u.test(req.url || "") });
  req.resume(); res.writeHead(502).end("synthetic proxy refusal");
});
proxy.on("connect", (req, socket) => {
  proxyRequests.push({ method: "CONNECT", loopback: /^(?:127\.0\.0\.1|localhost|\[::1\]):/u.test(req.url || "") });
  socket.destroy();
});
let secretStore, gateway, stage, serial = 0, failProjection = false, projectionCalls = 0;
const provider = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (chatgpt && req.method === "GET" && ["/wham/accounts/check", "/api/codex/accounts/check"].includes(pathname)) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ accounts: [{
        id: "synthetic-account", plan_type: "plus", workspace_backend_origin: `http://127.0.0.1:${provider.address().port}`,
        account_routing_override: "NO_CONSTRAINT" }] })); return;
    }
    // ChatGPT mode probes native metadata independently of model generation.
    // The synthetic account stays on loopback, and unavailable catalogs stay unavailable.
    if (chatgpt && ((req.method === "GET" && ["/plugins/featured", "/ps/plugins/installed", "/ps/plugins/list",
      "/ps/plugins/suggested/codex", "/v1/models", "/api/codex/settings/user"].includes(pathname))
      || (req.method === "POST" && ["/api/codex/ps/mcp", "/codex/analytics-events/events"].includes(pathname)))) {
      req.resume(); res.writeHead(404).end(); return;
    }
    let data = ""; for await (const chunk of req) data += chunk;
    assert.equal(req.url, "/v1/responses"); assert.equal(req.headers.authorization, `Bearer ${auth}`);
    const body = JSON.parse(data); requests.push(body);
    assert.equal(body.stream, true, "native Responses requests explicitly declare streaming");
    if (stage.invalidStream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: synthetic-invalid-json\n\n"); return;
    }
    if (stage.protected) assert(!data.includes("654321"), "native file output leaked to the actual model request");
    else assert(data.includes("654321"), "another session must not borrow this session's credential scope");
    const outputs = body.input.filter(item => ["function_call_output", "custom_tool_call_output"].includes(item.type));
    const received = stage.callId && outputs.find(item => item.call_id === stage.callId);
    if (received) { stage.output = received.output; assert(JSON.stringify(received).includes("Public completion marker")); }
    const flatten = (items, namespace) => items.flatMap(item => item.tools ? flatten(item.tools, item.name) : [{ ...item, namespace }]);
    const tools = flatten(body.tools || []);
    const codeMode = tools.some(item => item.type === "custom" && item.name === "exec");
    const direct = tools.find(item => item.name === "exec_command");
    const n = ++serial, responseId = `fixture-response-${n}`;
    let item;
    if (stage.noTool || received) item = { id: `msg-${n}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "The existing operation is complete. No repeated execution.", annotations: [] }] };
    else {
      assert(codeMode || direct, "native command tool must be available"); stage.callId = `native-call-${n}`;
      const args = { cmd: `${JSON.stringify(process.execPath)} fixture.cjs`, workdir: workspace, max_output_tokens: 300 };
      item = codeMode ? { id: `fc-${n}`, type: "custom_tool_call", call_id: stage.callId, name: "exec", namespace: "functions",
        input: `text(await tools.exec_command(${JSON.stringify(args)}));` }
        : { id: `fc-${n}`, type: "function_call", call_id: stage.callId, name: direct.name,
          ...(direct.namespace ? { namespace: direct.namespace } : {}), arguments: JSON.stringify(args), status: "completed" };
    }
    res.writeHead(200, missingResponseType ? {} : { "Content-Type": "text/event-stream" }); let sequence = 0;
    const event = (type, extra) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...extra })}\n\n`);
    event("response.created", { response: { id: responseId, object: "response", status: "in_progress", output: [] } });
    const reasoning = { id: `rs-${n}`, type: "reasoning", summary: [{ type: "summary_text", text: "Use the existing receipt." }],
      encrypted_content: `opaque-synthetic-reasoning-${n}` };
    event("response.output_item.added", { output_index: 0, item: reasoning });
    event("response.output_item.done", { output_index: 0, item: reasoning });
    event("response.output_item.added", { output_index: 1, item: { ...item, status: "in_progress" } });
    event("response.output_item.done", { output_index: 1, item });
    event("response.completed", { response: { id: responseId, object: "response", status: "completed", output: [reasoning, item],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); res.end();
  } catch (error) { failures.push(error.message); res.writeHead(500); res.end("fixture assertion failed"); }
});
async function makeHandle() {
  const runtimeRepo = path.dirname(fs.realpathSync(path.join(repo, ".vendor")));
  assert.deepEqual(fs.readFileSync(path.join(runtimeRepo, "build/codex-runtime-manifest.json")), fs.readFileSync(path.join(repo, "build/codex-runtime-manifest.json")));
  const binary = resolveCodexRuntimeLayout({ repoRoot: runtimeRepo, packaged: false }).runtimePath;
  const host = new CodexRuntimeHost({ paths, repoRoot: repo, cwd: root, ...binding,
    runtimeBinding: binding, parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root,
      ...(useProxy ? { HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "", no_proxy: "" } : {}) },
    runtimeEnvironment: Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId,
      kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared",
      home, nativeHome: null, integrationRoot: null, binaryPath: binary, launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]),
      spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: home }), configurationMode: "overlay" }),
    prepareRuntime: async () => ({ spawnEnv: chatgpt ? {} : { OPENAI_API_KEY: auth }, registeredSecrets: [auth], configArgs: [],
      runtimeConfig: { provider: { kind: providerKind } } }),
  });
  hosts.push(host); await host.initialize();
  const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => host }, secretGateway: gateway });
  return { host, handle: await adapter.acquire(binding) };
}
async function turn(handle, sessionId, prompt, expectedStatus = "completed") {
  let remove; const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove?.(); reject(new Error("Native fixture did not complete within 40 seconds")); }, 40_000);
    remove = handle.subscribe(event => {
      if (event.method === "turn/completed" && event.sessionId === sessionId) { clearTimeout(timer); remove(); resolve(event); }
    });
  });
  try {
    await handle.turnStart({ sessionId, operationId: crypto.randomUUID(), prompt, cwd: workspace });
    const event = await completed; assert.equal(event.status, expectedStatus, JSON.stringify({ status: event.status, errorCode: event.errorCode }));
    assert.deepEqual(failures, []);
  } finally { remove?.(); }
}
async function main() {
  if (useProxy) await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  secretStore = await new TemporarySecretStore({ paths, cryptoBroker: {
    encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse() } }).open();
  const provenance = new ModelSecretProvenance({ paths, secrets: secretStore });
  const projection = new ModelSecretProjection({ secrets: secretStore }), disclosures = new ModelSecretDisclosures();
  gateway = new ModelSecretGateway({ projection: { async project(...args) {
    projectionCalls++;
    if (failProjection) throw Object.assign(Error("synthetic local media failure"), { code: "SECRET_MEDIA_UNAVAILABLE" });
    return projection.project(...args);
  } }, disclosures, provenance, request(url, options, callback) {
    assert.equal(url.href, TARGETS[providerKind] + "responses");
    return http.request(new URL("/v1/responses", `http://127.0.0.1:${provider.address().port}`), options, callback);
  } });
  if (chatgpt) fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { id_token: auth, access_token: auth, refresh_token: "synthetic-refresh-unused", account_id: "synthetic-account" },
    last_refresh: new Date().toISOString() }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-4.1"\ncheck_for_update_on_startup = false\n'
    + (chatgpt ? `cli_auth_credentials_store="file"\nchatgpt_base_url="http://127.0.0.1:${provider.address().port}"\n` : "")
    + 'model_provider = "fixture_bootstrap"\n[model_providers.fixture_bootstrap]\nname = "Fixture bootstrap"\n'
    + 'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nsupports_websockets = false\n'
    + (chatgpt ? 'requires_openai_auth = true\n' : 'env_key = "OPENAI_API_KEY"\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, "fixture.cjs"), "const fs=require('fs');const n=fs.existsSync('count.txt')?Number(fs.readFileSync('count.txt')):0;fs.writeFileSync('count.txt',String(n+1));console.log('password: 654321\\nPublic completion marker');\n", { mode: 0o600 });
  // The built-in Harness always names a thread's source (codex-session-provider);
  // the secret projection then replaces that provider's route.
  const modelProvider = chatgpt ? { kind: "chatgpt", configId: "openai" }
    : { kind: "openai-api-key", configId: "shoggoth_0000000000000000" };
  const sessionOptions = { model: "gpt-4.1", modelProvider, cwd: workspace, permissionPolicy: { approvalPolicy: "never", sandbox: "danger-full-access" },
    developerInstructions: "Use the synthetic local fixture only. Do not repeat a completed command. Answer in the user's language." };
  let { handle, host } = await makeHandle();
  const first = await handle.sessionStart({ ...sessionOptions, modelSecretScope: scope });
  stage = { protected: true }; await turn(handle, first.session.id, "Run the local fixture once and report the completion marker.");
  assert(stage.output); assert.equal(fs.readFileSync(path.join(workspace, "count.txt"), "utf8"), "1");
  const second = await handle.sessionStart({ ...sessionOptions, modelSecretScope: { ...scope, sessionId: "other-session" } });
  stage = { noTool: true, protected: false }; await turn(handle, second.session.id, "The order number is 654321. Answer without tools.");
  stage = { noTool: true, protected: true };
  await handle.sessionResume({ ...sessionOptions, sessionId: first.session.id, modelSecretScope: scope });
  await turn(handle, first.session.id, "Continue from the saved result without calling any tool.");
  await host.stop();
  await gateway.close(); await secretStore.close(); await secretStore.open(); gateway.reset();
  ({ handle, host } = await makeHandle());
  await handle.sessionResume({ ...sessionOptions, sessionId: first.session.id, modelSecretScope: scope });
  await turn(handle, first.session.id, "Read the existing result after restart; do not repeat the operation.");
  assert.equal(fs.readFileSync(path.join(workspace, "count.txt"), "utf8"), "1");
  assert.equal(secretStore.list(scope).length, 1);
  assert(requests.slice(1).some(body => body.input.some(item => item.encrypted_content)), "real native follow-ups must carry the recorded opaque block");
  assert(!fs.readFileSync(provenance.file(scope), "utf8").includes("opaque-synthetic-reasoning"));
  const beforeInvalid = requests.length;
  stage = { noTool: true, protected: true, invalidStream: true };
  await turn(handle, first.session.id, "Reject an invalid response without retrying or repeating the command.", "failed");
  assert.equal(requests.length, beforeInvalid + 1, "a rejected response must not trigger native model retries");
  assert.equal(fs.readFileSync(path.join(workspace, "count.txt"), "utf8"), "1");
  const beforeFallback = requests.length, beforeProjection = projectionCalls;
  failProjection = true;
  stage = { noTool: true, protected: false };
  await turn(handle, first.session.id, "Continue from the existing receipt without repeating any command.");
  assert.equal(projectionCalls, beforeProjection + 1, "failed local processing must not repeat the model call");
  assert.equal(requests.length, beforeFallback + 1); assert.deepEqual(disclosures.list(scope), []);
  failProjection = false;
  // A response to original input has no protected-input provenance. Its opaque
  // history therefore uses the same original fallback on this subsequent call.
  stage = { noTool: true, protected: false };
  await turn(handle, first.session.id, "This is a new input. Continue from the saved result without repeating the command.");
  assert.equal(requests.length, beforeFallback + 2);
  assert.equal(fs.readFileSync(path.join(workspace, "count.txt"), "utf8"), "1");
  assert.deepEqual(failures, []);
  assert(!proxyRequests.some(request => request.loopback), "loopback projection and synthetic account metadata must bypass the proxy");
  console.log(JSON.stringify({ pass: true, runtime: "real pinned Codex", providerKind, requests: requests.length,
    nativeCommandExecutions: 1, protectedNativeFollowup: true, twoSessionsIsolated: true,
    resumedTwiceWithoutReplay: true, opaqueHistoryVerifiedAcrossRestart: true,
    invalidResponseNoRetry: true, silentOriginalFallbackOnce: true, newInputAfterFallback: true,
    missingResponseType, realAccountUsed: false, proxyConfigured: useProxy }));
}
main().catch(error => {
  const causes = [];
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) causes.push({
    code: typeof current.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/u.test(current.code) ? current.code : null,
    message: require("../app/agent-service/codex-rpc-safety").redactDiagnostic(current.message, [auth]).slice(0, 1024),
  });
  console.error(JSON.stringify({ fixtureFailure: causes })); process.exitCode = 1;
}).finally(async () => {
  await Promise.allSettled(hosts.map(host => host.stop())); await gateway?.close(); await secretStore?.close();
  if (useProxy) {
    console.log(JSON.stringify({ proxyRequests, projectionCalls, providerRequests: requests.length }));
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
});
