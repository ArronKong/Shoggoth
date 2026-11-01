"use strict";
// Real installed Pi + production Host/extension, synthetic workspace and
// loopback model only. Both success and failed projection are observed at HTTP.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const http = require("node:http"), crypto = require("node:crypto");
const { PiRuntimePool } = require("../app/agent-service/pi-runtime-pool");
const { PiRuntimeAdapter } = require("../app/agent-service/pi-runtime-adapter");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretGateway } = require("../app/agent-service/model-secret-gateway");
const { rejectingModelProxy } = require("./fixtures/rejecting-model-proxy.cjs");
async function main() {
  let originalMode = false;
  const binaryPath = process.env.SHOGGOTH_TEST_PI_BINARY;
  assert(binaryPath && path.isAbsolute(binaryPath), "SHOGGOTH_TEST_PI_BINARY must identify an installed CLI");
  const root = fs.mkdtempSync("/private/tmp/sg-secret-pi-"), workspace = path.join(root, "workspace");
  const home = path.join(root, ".pi", "agent"), paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const scope = { profileId: "pi-secret-agent", sessionId: "pi-secret-session" };
  const secrets = await new TemporarySecretStore({ paths, cryptoBroker: {
    encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse(),
  } }).open();
  const projection = new ModelSecretProjection({ secrets }), gateway = new ModelSecretGateway({ projection });

  const strictProjection = gateway.projection.project.bind(gateway.projection);
  gateway.projection.project = (...args) => {
    if (originalMode) throw Object.assign(Error("synthetic masking failure"), { code: "SECRET_MEDIA_UNAVAILABLE" });
    return strictProjection(...args);
  };
  const initial = "SyntheticInput456", output = "SyntheticOutput789", requests = [];
  fs.writeFileSync(path.join(workspace, "fixture.cjs"), `const fs=require('node:fs');fs.appendFileSync('count','1');console.log('password: ${output}');console.log('Public receipt: receipt-17');`);
  let followup = false, noTool = false, error;
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      let wire = ""; for await (const chunk of req) wire += chunk;
      if (!originalMode) assert(!wire.includes(initial), "initial credential must not reach the real provider request");
      if (!originalMode) assert(!wire.includes(output), "native tool output must not reach the real provider request");
      if (originalMode) assert(wire.includes("FallbackInput852"), "original message reaches the selected custom URL");
      const body = JSON.parse(wire); requests.push(body);
      const done = noTool || body.messages.some(message => message.role === "tool");
      if (done && !noTool) {
        assert(wire.includes("Public receipt: receipt-17")); assert(wire.includes("SHOGGOTH_SECRET_")); followup = true;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`,
        object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send(done ? { role: "assistant", content: "The operation completed. No repeated execution." }
        : { role: "assistant", tool_calls: [{ index: 0, id: "native-once", type: "function", function: { name: "bash",
          arguments: JSON.stringify({ command: `${JSON.stringify(process.execPath)} fixture.cjs` }) } }] });
      send({}, done ? "stop" : "tool_calls"); res.end("data: [DONE]\n\n");
    } catch (caught) { error = caught; res.writeHead(500); res.end("fixture rejected request"); }
  });
  let adapter, proxy;
  try {
    proxy = await rejectingModelProxy(process.argv.includes("--proxy"));
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    fs.writeFileSync(path.join(home, "models.json"), JSON.stringify({ providers: { "shoggoth-secret-test": {
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "synthetic-test-only",
      models: [{ id: "controlled", name: "Controlled", reasoning: false, input: ["text"], contextWindow: 128000,
        maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }), { mode: 0o600 });
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ defaultProvider: "shoggoth-secret-test", defaultModel: "controlled" }), { mode: 0o600 });
    const relay = path.join(root, "relay.cjs");
    fs.writeFileSync(relay, `let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`);
    const permissionPolicy = { approvalPolicy: "never", sandbox: "danger-full-access" };
    const pool = new PiRuntimePool({ paths, homedir: root, parentEnv: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", ...proxy.env }, binaryPath,
      extensionPath: path.resolve(__dirname, "../resources/pi/shoggoth-pi-extension.mjs"),
      requestTimeoutMs: 10000, acceptanceTimeoutMs: 15000, promptTimeoutMs: 30000, shutdownGraceMs: 1000, killGraceMs: 1000,
      mcpGateIssuer: { reserveMcpServer: () => ({ reservationId: crypto.randomBytes(32).toString("hex"), name: "shoggoth",
        command: process.execPath, args: [relay], env: [] }), bindMcpServer: () => ({ bound: true }), revokeMcpServer: () => ({ revoked: true }) },
    });
    adapter = new PiRuntimeAdapter({ runtimePool: pool, secretGateway: gateway });
    const runtime = await adapter.acquire({ runtime: "pi", runtimeProfileId: "pi-secret-test", runtimeAccountId: "native-pi-default-v1" },
      { workspace, permissionPolicy, mcpExecutionRunId: crypto.randomUUID() });
    const events = []; runtime.subscribe(event => events.push(event));
    const input = { cwd: workspace, model: "shoggoth-secret-test/controlled", permissionPolicy, modelSecretScope: scope };
    const { session } = await runtime.sessionStart({ ...input, source: "secret-test" });
    async function turn(prompt, expectFailure = false) {
      const started = await runtime.turnStart({ sessionId: session.id, operationId: crypto.randomUUID(),
        prompt, model: input.model, cwd: workspace, permissionPolicy });
      const deadline = Date.now() + 40000;
      while (!events.some(event => event.type === "complete" && event.turnId === started.turn.id)) {
        assert(Date.now() < deadline, "Pi turn must settle within the existing acceptance deadline");
        if (error) throw error; await new Promise(resolve => setTimeout(resolve, 25));
      }
      const complete = events.find(event => event.type === "complete" && event.turnId === started.turn.id);
      assert.equal(complete.status, expectFailure ? "interrupted" : "completed", JSON.stringify(complete));
      if (expectFailure) assert.equal(complete.errorCode, "SECRET_MODEL_PROJECTION_UNAVAILABLE");
    }
    await turn(`Run the fixture once. password: ${initial}`);
    assert(followup); assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "1");
    noTool = true;
    await runtime.sessionResume({ ...input, sessionId: session.id });
    await turn("Report the existing result. Do not repeat any operation.");
    const beforeOriginal = requests.length; originalMode = true;
    await turn("password: FallbackInput852. Use the saved result without repeating any command.");
    assert.equal(requests.length, beforeOriginal + 1); originalMode = false;
    const beforeFailure = requests.length;
    runtime.closeSecretRoutes();
    // Retain a now-revoked endpoint so the extension must stop this worker.
    runtime.host.modelSecretEndpoints.set(session.id, `http://127.0.0.1:${gateway.server.address().port}/${"a".repeat(64)}`);
    await turn("Projection failure must not send this turn.", true);
    assert.equal(requests.length, beforeFailure, "failed projection must never make a model request");
    assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "1");
    proxy.assertLoopbackBypassed();
    console.log(JSON.stringify({ verified: true, runtime: "Pi 1.3.0", modelRequests: requests.length,
      nativeExecutions: 1, nativeToolFollowup: true, resumed: true, failureDidNotDispatch: true,
      silentOriginalFallbackOnce: true, proxyConfigured: process.argv.includes("--proxy") }));
  } finally {
    await adapter?.stopAll(); await gateway.close(); provider.closeAllConnections();
    await proxy?.close();
    await new Promise(resolve => provider.close(resolve)); await secrets.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
