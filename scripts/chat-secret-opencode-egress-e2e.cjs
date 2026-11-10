"use strict";
// Real OpenCode + production Host/Adapter, synthetic values and loopback model.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { randomUUID } = require("node:crypto");
const { RuntimeAccountResolver } = require("../app/agent-service/runtime-account-resolver");
const { DEFAULT_RUNTIME_ACCOUNTS, NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { OpenCodeRuntimeHost } = require("../app/agent-service/opencode-runtime-host");
const { OpenCodeRuntimeAdapter } = require("../app/agent-service/opencode-runtime-adapter");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretGateway } = require("../app/agent-service/model-secret-gateway");
const { rejectingModelProxy } = require("./fixtures/rejecting-model-proxy.cjs");
async function main() {
  let originalMode = false;
  const autoDetect = !process.argv.includes("--manual-secrets");
  const root = fs.mkdtempSync("/private/tmp/sg-opencode-secret-"), paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  for (const name of ["home", "workspace", "state", "data", "config", "config/opencode"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const workspace = path.join(root, "workspace"), outputSecret = "SyntheticNativeOutput987", requests = [], approvals = [];
  const newsRow = "] / 解开谷物保存的低碳密码 / 11-10 11:08";
  const ordinaryExample = "Example syntax: password: ordinary-example.";
  const secrets = await new TemporarySecretStore({ paths, autoDetect, cryptoBroker: {
    encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse(),
  } }).open();
  const gateway = new ModelSecretGateway({ projection: new ModelSecretProjection({ secrets }) });

  const strictProjection = gateway.projection.project.bind(gateway.projection);
  gateway.projection.project = (...args) => {
    if (originalMode) throw Object.assign(Error("synthetic masking failure"), { code: "SECRET_MEDIA_UNAVAILABLE" });
    return strictProjection(...args);
  };
  fs.writeFileSync(path.join(workspace, "fixture.cjs"), `
const fs = require("node:fs");
fs.appendFileSync("count", "1");
console.log(${JSON.stringify(`password: ${outputSecret}`)});
console.log("Public receipt: receipt-17");
console.log(${JSON.stringify(newsRow)});
console.log(${JSON.stringify(ordinaryExample)});
`);
  let providerError, noTool = false, host, adapter, followup = false, verified = false, proxy;
  const modelServer = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions"); assert.equal(req.headers["x-shoggoth-local-model-session"], undefined);
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      if (!originalMode) assert(!raw.includes(outputSecret), "native tool output reached provider");
      if (originalMode) assert(raw.includes("FallbackInput852"), "original reaches the custom model URL");
      if (!originalMode && !raw.includes("session-b-public")) assert(!raw.includes("123456"), "session credential reached provider");
      const bash = body.tools?.find(tool => tool.function?.name === "bash");
      const hasResult = body.messages.some(message => message.role === "tool");
      if (hasResult) {
        assert(raw.includes("Public receipt: receipt-17"));
        assert(raw.includes(newsRow), "a public news row reached the model with rewritten separators");
        if (!autoDetect) assert(raw.includes(ordinaryExample), "unselected example text was rewritten");
        assert(!bash?.function.parameters?.$schema?.includes("SHOGGOTH_SECRET_"), "the Bash schema dialect was rewritten");
        followup = true;
      }
      const execute = bash && !hasResult && !noTool;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`,
        object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send(execute ? { role: "assistant", tool_calls: [{ index: 0, id: "native-once", type: "function", function: { name: "bash",
        arguments: JSON.stringify({ command: `${JSON.stringify(process.execPath)} fixture.cjs`, description: "Run the local synthetic fixture once" }) } }] }
        : { role: "assistant", content: "The saved operation is complete." });
      send({}, execute ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n");
    } catch (error) { providerError = error; res.writeHead(500); res.end("local fixture rejected request"); }
  });
  try {
    proxy = await rejectingModelProxy(process.argv.includes("--proxy"));
    await new Promise(resolve => modelServer.listen(0, "127.0.0.1", resolve));
    const model = "secret-fixture/fixture";
    fs.writeFileSync(path.join(root, "config/opencode/opencode.json"), JSON.stringify({ model, small_model: model,
      enabled_providers: ["secret-fixture"], provider: { "secret-fixture": { npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "synthetic-model-auth", baseURL: `http://127.0.0.1:${modelServer.address().port}/v1` },
        models: { fixture: { name: "Fixture", limit: { context: 32000, output: 2048 } } } } } }));
    const binding = { runtime: "opencode", runtimeProfileId: "secret-fixture", runtimeAccountId: NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID };
    const account = DEFAULT_RUNTIME_ACCOUNTS.find(item => item.id === NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID);
    const parentEnv = { PATH: process.env.PATH, XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root, ...proxy.env };
    const resolver = new RuntimeAccountResolver({ paths, parentEnv, homedir: path.join(root, "home") });
    const environment = resolver.resolve(binding, account, process.env.SHOGGOTH_OPENCODE_TEST_BINARY
      ? { binaryPath: process.env.SHOGGOTH_OPENCODE_TEST_BINARY } : {});
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "danger-full-access" };
    host = new OpenCodeRuntimeHost({ paths, runtimeBinding: binding, runtimeEnvironment: environment,
      workspace, permissionPolicy, parentEnv, secretGateway: gateway,
      spawnProcess: (...args) => { const child = require("node:child_process").spawn(...args);
        child.stderr?.on("data", bytes => fs.appendFileSync(path.join(root, "native-stderr.log"), bytes, { mode: 0o600 })); return child; },
    });
    host.registerServerRequestHandler("item/commandExecution/requestApproval", async input => {
      approvals.push(input.toolName); assert(["bash", "external_directory"].includes(input.toolName)); return { decision: "accept" };
    });
    await host.initialize();
    adapter = new OpenCodeRuntimeAdapter({ runtimePool: { get: async () => host, stop: () => host.stop(), stopAll: () => host.stop() } });
    const runtime = await adapter.acquire(binding);
    const scope = { profileId: "fixture-agent", sessionId: "product-session-a" };
    if (!autoDetect) for (const text of ["123456", outputSecret]) {
      await secrets.prepare({ scope, operationId: randomUUID(), text, selections: [{ start: 0, end: text.length }] });
    }
    const options = { model, cwd: workspace, permissionPolicy, modelSecretScope: scope };
    const { session } = await runtime.sessionStart({ ...options, source: "secret-session-a" });
    const run = async (sessionId, prompt, failure = false) => {
      const started = await runtime.turnStart({ sessionId, operationId: randomUUID(), prompt, model, cwd: workspace, permissionPolicy });
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        if (providerError) throw providerError;
        const { session: current } = await runtime.sessionRead({ sessionId, includeTurns: true });
        const turn = current.turns.find(item => item.id === started.turn.id);
        if (turn && turn.status !== "inProgress" && !host.activeTurns.has(sessionId)) {
          if (failure) assert.notEqual(turn.status, "completed", JSON.stringify(turn));
          else assert.equal(turn.status, "completed", JSON.stringify(turn));
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error("OpenCode turn did not settle within the original fixture deadline");
    };
    await run(session.id, "Run the local fixture once. password: 123456");
    assert(followup); assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "1");
    noTool = true;
    await runtime.sessionResume({ ...options, sessionId: session.id });
    await run(session.id, "Report the saved result without repeating the operation.");
    const b = await runtime.sessionStart({ ...options, source: "secret-session-b",
      modelSecretScope: { ...scope, sessionId: "product-session-b" } });
    await run(b.session.id, "session-b-public: 123456");
    assert(requests.some(body => JSON.stringify(body).includes("session-b-public: 123456")));
    const beforeOriginal = requests.length; originalMode = true;
    await run(session.id, "password: FallbackInput852. Use the saved result without repeating any command.");
    assert.equal(requests.length, beforeOriginal + 1); originalMode = false;
    const beforeFailure = requests.length; host.modelSecretScopes.delete(session.id);
    await run(session.id, "This request must stop before reaching the model.", true);
    assert.equal(requests.length, beforeFailure); assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "1");
    proxy.assertLoopbackBypassed();
    console.log(JSON.stringify({ verified: true, runtime: `OpenCode ${host.cliVersion.join(".")}`, modelRequests: requests.length,
      nativeExecutions: 1, toolFollowup: true, resumed: true, separateScopes: true, failureProviderCalls: 0,
      silentOriginalFallbackOnce: true, autoDetect, proxyConfigured: process.argv.includes("--proxy") }));
    verified = true;
  } finally {
    await adapter?.stopAll(); await host?.stop(); await gateway.close(); await secrets.close();
    await proxy?.close();
    modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve));
    if (verified) fs.rmSync(root, { recursive: true, force: true });
    else console.error(JSON.stringify({ retainedFailure: root, providerCalls: requests.length }));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
