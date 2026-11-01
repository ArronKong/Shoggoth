"use strict";
// Real pinned CLI + its native read-only sandbox, synthetic loopback model
// and private GROK_HOME. No production auth, rules, history or settings.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const http = require("node:http"), { spawn } = require("node:child_process");
const { GrokBuildRuntimePool } = require("../app/agent-service/grok-build-runtime-pool");
const { GrokBuildRuntimeAdapter } = require("../app/agent-service/grok-build-runtime-adapter");
const { NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const root = fs.mkdtempSync("/private/tmp/sg-grok-heartbeat-"), home = path.join(root, "home");
const grokHome = path.join(home, ".grok"), requests = [], sockets = new Set(), events = [], urls = [];
let providerError = null, pendingRequest = null, response;
fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
const server = http.createServer(async (req, res) => {
  try {
    urls.push(req.url);
    if (req.method === "HEAD") { res.writeHead(204); res.end(); return; }
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model", owned_by: "fixture" }] })); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    assert.equal(req.url, "/v1/chat/completions"); assert.equal(body.model, "fixture-model");
    assert.equal((body.tools || []).length, 0, `tools exposed: ${(body.tools || []).map(tool => tool.function?.name || tool.type).join(",")}`);
    assert.ok(requests.length <= (response ? 6 : 3), "no title, summary or additional model turns");
    if (pendingRequest) { pendingRequest(); return; }
    const text = response ? response(body) : JSON.stringify({ outcome: "silent", scratch: "Native Grok checked" });
    const chunk = (delta, finish_reason = null) => ({ id: "fixture-response", object: "chat.completion.chunk",
      created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: text }))}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) { providerError = error.message; res.destroy(error); }
});
server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
let pool, diagnostic = "";
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const config = `[models]\ndefault="fixture"\nmax_retries=0\n[model.fixture]\nmodel="fixture-model"\napi_backend="chat_completions"\nbase_url="${url}"\napi_key="synthetic-loopback-key"\ncontext_window=32000\nmax_completion_tokens=512\n[endpoints]\nxai_api_base_url="${url}"\nmodels_base_url="${url}"\ncli_chat_proxy_base_url="${url}"\n`;
  fs.writeFileSync(path.join(grokHome, "config.toml"), config, { mode: 0o600 });
  // The Host's cached-account gate requires a private auth record; the CLI
  // authenticates this synthetic endpoint using its explicit model API key.
  fs.writeFileSync(path.join(grokHome, "auth.json"), "{}\n", { mode: 0o600 });
  pool = new GrokBuildRuntimePool({ paths: { trustedRoot: root, stateDir: path.join(root, "state") },
    binaryPath: fs.realpathSync(process.argv[2]), homedir: home,
    runtimeAccountResolver: { resolve: binding => Object.freeze({ runtime: "grok-build", runtimeAccountId: binding.runtimeAccountId,
      kind: "native-user", installationKind: "system", homeKind: "native-home", strategy: "native-home",
      home: grokHome, nativeHome: grokHome, configSourceHome: null, integrationRoot: null,
      binaryPath: fs.realpathSync(process.argv[2]), launchArgs: Object.freeze([]), configurationMode: "native",
      spawnEnv: Object.freeze({ HOME: require("node:os").homedir(), GROK_HOME: grokHome }) }) },
    parentEnv: { HOME: home, PATH: process.env.PATH, TMPDIR: root },
    spawnEnv: { XAI_API_KEY: "synthetic-loopback-key", DO_NOT_TRACK: "1" },
    requestTimeoutMs: 15_000, promptTimeoutMs: 30_000,
    spawnProcess: (binary, args, options) => {
      const child = spawn(binary, [...args.slice(0, -1), "--debug", "--debug-file", path.join(root, "native-debug.log"), args.at(-1)], options);
      child.stderr.on("data", data => { diagnostic = (diagnostic + data.toString()).slice(-4000); }); return child;
    } });
  const adapter = new GrokBuildRuntimeAdapter({ runtimePool: pool });
  const acquire = runId => adapter.acquire({ runtime: "grok-build", runtimeProfileId: "native-heartbeat-fixture",
    runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID }, { workspace: null, modelOnly: true,
    permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" }, executionContract: { runId } });
  for (const model of [null, "fixture"]) {
    const handle = await acquire(`native-heartbeat-${requests.length}`), privateHome = handle.host.modelOnlyHome;
    handle.subscribe(event => events.push({ type: event.type, status: event.status, method: event.method, errorCode: event.errorCode }));
    const result = await handle.generateModelOnly({ prompt: "Return the requested JSON check with short working notes.",
      model, operationId: `native-heartbeat-check-${requests.length}`, timeoutMs: 30_000 });
    assert.equal(JSON.parse(result.text).scratch, "Native Grok checked");
    assert.equal(result.usage?.totalTokens, 20);
    assert.equal(handle.host.state, "stopped"); assert.equal(fs.existsSync(privateHome.cwd), false);
  }
  const handle = await acquire("native-heartbeat-cancel"), privateHome = handle.host.modelOnlyHome, controller = new AbortController();
  const requested = new Promise(resolve => { pendingRequest = resolve; });
  const canceled = handle.generateModelOnly({ prompt: "Wait for a result", model: null, operationId: "native-heartbeat-cancel",
    timeoutMs: 15000, signal: controller.signal });
  canceled.catch(() => {}); await Promise.race([requested, canceled]); controller.abort();
  await assert.rejects(canceled, { code: "MODEL_ONLY_CANCELED" });
  assert.equal(handle.host.state, "stopped"); assert.equal(fs.existsSync(privateHome.cwd), false);
  assert.equal(providerError, null);
  assert.equal(requests.length, 3);
  pendingRequest = null;
  const closure = await require("./helpers/proactive-native-closure.cjs").verifyProactiveNativeClosure({
    root, adapter, runtime: "grok-build", model: "fixture", setResponse: value => { response = value; } });
  assert.equal(providerError, null);
  assert.equal(fs.readFileSync(path.join(grokHome, "config.toml"), "utf8"), config);
  console.log(JSON.stringify({ verified: true, runtimeVersion: "1.0.73", provider: "synthetic-loopback",
    actualProviderCalls: 0, modelRequests: requests.length, model: "fixture-model", nativeTools: 0,
    totalTokensPerCompletedTurn: 20, defaultAndExplicitModel: true, cancellation: true, processStopped: true, closure }));
})().catch(error => { console.error(JSON.stringify({ verified: false, code: error.code || error.message, message: error.message, stack: error.stack,
  providerError, urls, modelRequests: requests.map(body => ({ model: body.model, tools: body.tools?.length || 0,
    input: JSON.stringify(body.input || body.messages)?.slice(0, 400) })), events, diagnostic,
  debug: fs.existsSync(path.join(root, "native-debug.log")) ? fs.readFileSync(path.join(root, "native-debug.log"), "utf8").split("\n")
    .filter(line => /profile|definition|shoggoth-review|title|memory/i.test(line)).map(line => line.slice(0, 500)).slice(-20) : [] })); process.exitCode = 1; })
  .finally(async () => { await pool?.stopAll(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
