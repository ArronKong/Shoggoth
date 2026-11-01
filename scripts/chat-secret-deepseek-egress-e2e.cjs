"use strict";
// Official DSH Host/bridge, native bash and native DeepSeek HTTP adapter.
// All accounts, workspace operations and model responses are local fixtures.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const http = require("node:http"), crypto = require("node:crypto");
const { DeepSeekHarnessRuntimePool } = require("../app/agent-service/deepseek-harness-runtime-pool");
const { DeepSeekHarnessRuntimeAdapter } = require("../app/agent-service/deepseek-harness-runtime-adapter");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretGateway } = require("../app/agent-service/model-secret-gateway");
const { resolveDeepSeekHarnessBinary } = require("../app/agent-service/deepseek-harness-runtime-paths");
const { SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS } = require("../app/agent-service/product-capability-manifest");
const LITERAL_INSTRUCTIONS = "Literal examples: {{cwd}} {{not_a_registered_variable}} {{{nested}}}";
const TURN_INSTRUCTIONS = "Current rule remains literal: {{shoggoth_current_turn}}";
const DEVELOPER_INSTRUCTIONS = SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS + "\n" + LITERAL_INSTRUCTIONS;

async function main() {
  let originalMode = false;
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-dsh-secret-"));
  const workspace = path.join(root, "workspace"), home = path.join(root, ".dsh");
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(home, { mode: 0o700 });
  const secrets = await new TemporarySecretStore({ paths, cryptoBroker: {
    encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse(),
  } }).open();
  const gateway = new ModelSecretGateway({ projection: new ModelSecretProjection({ secrets }) });

  const strictProjection = gateway.projection.project.bind(gateway.projection);
  gateway.projection.project = (...args) => {
    if (originalMode) throw Object.assign(Error("synthetic masking failure"), { code: "SECRET_MEDIA_UNAVAILABLE" });
    return strictProjection(...args);
  };
  const requests = [], nativeSecret = "DshNativeFixture987";
  const scope = { profileId: "dsh-fixture", sessionId: "dsh-session-a" };
  fs.writeFileSync(path.join(workspace, "fixture.cjs"), `const fs=require('fs');fs.appendFileSync('count','1');console.log('password: ${nativeSecret}');console.log('Public receipt: receipt-17');`);
  let failure, noTool = false, followup = false, adapter, runtime, verified = false, expectInstructions = true;
  let instructionChecks = 0, response;
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      let raw = ""; for await (const bytes of req) raw += bytes;
      const body = JSON.parse(raw); requests.push(body);
      const hasNativeTools = body.tools?.some(tool => tool.function.name === "bash");
      if (expectInstructions && hasNativeTools) {
        instructionChecks++;
        const systemText = body.messages.filter(message => ["system", "developer"].includes(message.role))
          .map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
        assert(systemText.includes("{{SHOGGOTH_SECRET_<opaque ID>}}"), "credential reference example must stay literal");
        assert(systemText.includes(LITERAL_INSTRUCTIONS), "host instructions must not expand native template variables");
        assert(systemText.includes(TURN_INSTRUCTIONS), "current Run instructions must stay literal after resume");
      }
      if (!originalMode) assert(!raw.includes(nativeSecret), "native result reached the model");
      if (originalMode) assert(raw.includes("FallbackInput852"), "original reaches the configured custom model URL");
      if (!originalMode && !raw.includes("session-b-public")) assert(!raw.includes("123456"), "input credential reached the model");
      const hasResult = body.messages.some(message => message.role === "tool");
      const done = noTool || hasResult || !hasNativeTools;
      if (!noTool && hasResult) { assert(raw.includes("Public receipt: receipt-17")); followup = true; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
        model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send(done ? { role: "assistant", content: response ? response(body) : "Saved operation complete." }
        : { role: "assistant", tool_calls: [{ index: 0, id: "native-once", type: "function", function: { name: "bash",
          arguments: JSON.stringify({ command: `${JSON.stringify(process.execPath)} fixture.cjs`, description: "Run the local credential fixture once" }) } }] });
      send({}, done ? "stop" : "tool_calls");
      if (response) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
        model: "fixture", choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) { failure = error; res.writeHead(500); res.end("fixture request rejected"); }
  });
  const permissionPolicy = { approvalPolicy: "never", sandbox: "danger-full-access" };
  const model = "deepseek-official/fixture";
  const events = [];
  async function connect() {
    const pool = new DeepSeekHarnessRuntimePool({ paths, homedir: root,
      binaryPath: resolveDeepSeekHarnessBinary({ parentEnv: process.env }),
      bridgePath: path.resolve(__dirname, "../resources/deepseek-harness/shoggoth-dsh-bridge.mjs"), secretGateway: gateway,
      parentEnv: { PATH: process.env.PATH, HOME: root, LANG: "en_US.UTF-8" },
      mcpGateIssuer: { reserveMcpServer: () => ({ reservationId: crypto.randomUUID(), name: "shoggoth", command: process.execPath,
        args: [path.join(__dirname, "deepseek-harness-official-smoke.mjs"), "--fake-mcp"], env: [] }),
        bindMcpServer: () => ({ bound: true }), revokeMcpServer: () => ({ revoked: true }) },
    });
    adapter = new DeepSeekHarnessRuntimeAdapter({ runtimePool: pool });
    runtime = await adapter.acquire({ runtime: "deepseek-harness", runtimeProfileId: "dsh-secret-test", runtimeAccountId: "native-deepseek-harness-default-v1" },
      { workspace, permissionPolicy, mcpExecutionRunId: "dsh-secret-fixture" });
    assert.equal(runtime.host.modelSecretRoute?.ready(), true, "the production pool must install the live projection hook");
    runtime.subscribe(event => events.push(event));
  }
  async function turn(sessionId, prompt, expected = "completed") {
    const { turn } = await runtime.turnStart({ sessionId, prompt, turnDeveloperInstructions: TURN_INSTRUCTIONS, operationId: crypto.randomUUID(), cwd: workspace, permissionPolicy, model });
    const deadline = Date.now() + 30000;
    let completed;
    while (!(completed = events.find(event => event.type === "complete" && event.turnId === turn.id))) {
      if (failure) throw failure; assert(Date.now() < deadline, "native turn deadline"); await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(completed.status, expected, JSON.stringify(completed));
    if (expected === "failed") assert.equal(completed.errorCode, "SECRET_MODEL_PROJECTION_UNAVAILABLE");
  }
  try {
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    fs.writeFileSync(path.join(home, ".credentials.yaml"), "version: 1\nrefs:\n  DEEPSEEK_API_KEY: synthetic-only\n", { mode: 0o600 });
    fs.writeFileSync(path.join(home, "settings.yaml"), JSON.stringify({ "llm-deepseek": {
      baseURL: `http://127.0.0.1:${provider.address().port}/v1`, thinking: "disabled", reasoningEffort: "off",
      models: [{ id: "fixture", name: "Fixture", contextWindow: 64000, inputModalities: ["text"], maxTokens: 4096 }],
    } }), { mode: 0o600 });
    await connect();
    const input = { source: "secret-fixture", cwd: workspace, permissionPolicy, permissionMode: "danger-full-access", model, modelSecretScope: scope,
      developerInstructions: DEVELOPER_INSTRUCTIONS };
    const { session } = await runtime.sessionStart(input);
    await turn(session.id, "Run fixture once. password: 123456");
    assert(followup); assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "1");
    noTool = true;
    await adapter.stopAll(); await connect();
    await runtime.sessionResume({ ...input, sessionId: session.id });
    await turn(session.id, "Report the saved result without repeating any command.");
    const second = await runtime.sessionStart({ ...input, source: "secret-fixture-b", modelSecretScope: { ...scope, sessionId: "dsh-session-b" } });
    await turn(second.session.id, "session-b-public: 123456");
    assert(requests.some(body => JSON.stringify(body).includes("session-b-public: 123456")));
    expectInstructions = false;
    const summary = await runtime.generateModelOnly({ operationId: "summary", model, prompt: "Summarize password: 123456", modelSecretScope: scope });
    expectInstructions = true;
    assert.equal(summary.text, "Saved operation complete.");
    const beforeOriginal = requests.length; originalMode = true;
    await turn(session.id, "password: FallbackInput852. Use the saved result without repeating any command.");
    assert.equal(requests.length, beforeOriginal + 1); originalMode = false;
    const before = requests.length;
    runtime.host.modelSecretScopes.clear();
    await turn(session.id, "No request may leave without a live scope.", "failed");
    assert.equal(requests.length, before); assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "1");
    assert(instructionChecks >= 5, "verify literal instructions on native requests, resumed turns and fallback");
    const closure = await require("./helpers/proactive-native-closure.cjs").verifyProactiveNativeClosure({
      root, adapter, runtime: "deepseek-harness", model, setResponse: value => { response = value; } });
    if (failure) throw failure;
    verified = true;
    console.log(JSON.stringify({ verified, modelRequests: requests.length, nativeExecutions: 1, restartResume: true, separateScopes: true, instructionChecks,
      modelOnly: true, literalStableAndTurnInstructions: true, silentOriginalFallbackOnce: true, failureProviderCalls: 0, closure }));
  } finally {
    fs.writeFileSync(path.join(root, "synthetic-model-requests.json"), JSON.stringify(requests, null, 2), { mode: 0o600 });
    if (!verified) console.error(JSON.stringify({ retainedFailure: root, requests: requests.length, childError: runtime?.host.process?.stderr?.slice(-1800) }));
    await adapter?.stopAll(); await gateway.close(); await secrets.close();
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
