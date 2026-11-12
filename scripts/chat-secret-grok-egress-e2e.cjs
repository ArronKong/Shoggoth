"use strict";
// Real Grok ACP, isolated native home and synthetic auth. The production
// gateway's two fixed recipients are routed only to this loopback fixture.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const http = require("node:http"), crypto = require("node:crypto");
const { GrokBuildRuntimePool } = require("../app/agent-service/grok-build-runtime-pool");
const { GrokBuildRuntimeAdapter } = require("../app/agent-service/grok-build-runtime-adapter");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretGateway, TARGETS } = require("../app/agent-service/model-secret-gateway");
const { ModelSecretProvenance } = require("../app/agent-service/model-secret-provenance");
async function main() {
  let originalMode = false;
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-grok-secret-")), workspace = path.join(root, "workspace"), home = path.join(root, ".grok");
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(home, { mode: 0o700 });
  // The production Host checks presence/identity; the native CLI authenticates
  // against the inert environment key supplied solely to the fixture process.
  fs.writeFileSync(path.join(home, "auth.json"), "{}", { mode: 0o600 });
  const secrets = await new TemporarySecretStore({ paths, cryptoBroker: {
    encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse(),
  } }).open();
  const requests = [], outputSecret = "GrokNativeFixture987", scope = { profileId: "grok-fixture", sessionId: "grok-session-a" };
  fs.writeFileSync(path.join(workspace, "fixture.cjs"), `const fs=require('fs');fs.appendFileSync('count','1');console.log('password: ${outputSecret}');console.log('Public receipt: receipt-17');`);
  let failure, noTool = false, followup = false, adapter, runtime, title = false, verified = false, serial = 0;
  let nextFollowupFailure;
  const provider = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET") {
        assert(["/v1/models", "/v1/api-key"].includes(req.url)); res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(req.url.endsWith("models") ? { data: [{ id: "grok-4.6", object: "model" }] } : { name: "synthetic", api_key_id: "fixture" }));
      }
      assert.equal(req.url, "/v1/responses"); let raw = ""; for await (const bytes of req) raw += bytes;
      const body = JSON.parse(raw); requests.push(body);
      if (!originalMode) assert(!raw.includes(outputSecret), "native result reached the model");
      if (originalMode) assert(raw.includes("FallbackInput852"), "original reaches the selected Grok route");
      if (!originalMode && !raw.includes("session-b-public")) assert(!raw.includes("123456"), "input credential reached the model");
      const isTitle = body.tools?.length === 1 && body.tools[0].name === "session_title";
      if (isTitle) title = true;
      const result = body.input.some(item => item.type === "function_call_output");
      if (result) { assert(raw.includes("Public receipt: receipt-17")); followup = true; }
      const injected = result && Array.isArray(body.tools) && !isTitle ? nextFollowupFailure : undefined;
      if (injected) nextFollowupFailure = undefined;
      if (injected === "502") {
        res.writeHead(502, { "content-type": "application/json" }).end('{"error":"synthetic upstream failure"}');
        return;
      }
      const n = ++serial, responseId = `fixture-${n}`;
      let item;
      if (isTitle) item = { id: `fc-${n}`, type: "function_call", name: "session_title", call_id: `title-${n}`,
        arguments: '{"session_title":"Verified local credential fixture"}', status: "completed" };
      else if (!noTool && !result && body.tools?.some(tool => tool.name === "run_terminal_command")) {
        assert(body.tools.some(tool => tool.name === "run_terminal_command"));
        item = { id: `fc-${n}`, type: "function_call", name: "run_terminal_command", call_id: "native-once",
          arguments: JSON.stringify({ command: `${JSON.stringify(process.execPath)} fixture.cjs`, description: "Run the local synthetic fixture once", block_until_ms: 10000 }), status: "completed" };
      } else item = { id: `msg-${n}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Saved operation complete.", annotations: [], logprobs: [] }] };
      const response = { id: responseId, object: "response", created_at: 1, status: "completed", error: null,
        incomplete_details: null, model: body.model, output: [item], parallel_tool_calls: true, store: false,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      res.writeHead(200, { "content-type": "text/event-stream" }); let sequence = 0;
      const event = (type, extra) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...extra })}\n\n`);
      event("response.created", { response: { ...response, status: "in_progress", output: [] } });
      if (injected === "disconnect") {
        setTimeout(() => res.destroy(), 50);
        return;
      }
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response }); res.end();
    } catch (error) { failure = error; res.writeHead(400); res.end("synthetic provider rejected request"); }
  });
  const gateway = new ModelSecretGateway({ projection: new ModelSecretProjection({ secrets }),
    provenance: new ModelSecretProvenance({ paths, secrets }), request(url, options, cb) {
    assert([TARGETS["grok-cli"], TARGETS["grok-api-key"]].some(target => url.href.startsWith(target)));
    return http.request(new URL(url.pathname, `http://127.0.0.1:${provider.address().port}`), options, cb);
  } });

  const strictProjection = gateway.projection.project.bind(gateway.projection);
  gateway.projection.project = (...args) => {
    if (originalMode) throw Object.assign(Error("synthetic masking failure"), { code: "SECRET_MEDIA_UNAVAILABLE" });
    return strictProjection(...args);
  };
  const permissionPolicy = { approvalPolicy: "never", sandbox: "danger-full-access" }, events = [];
  const binding = { runtime: "grok-build", runtimeProfileId: "grok-secret-test", runtimeAccountId: "native-grok-build-default-v1" };
  const acquired = { workspace, permissionPolicy, executionContract: { runId: "grok-secret-fixture" } };
  async function connect() {
    const pool = new GrokBuildRuntimePool({ paths, homedir: root, binaryPath: process.env.SHOGGOTH_GROK_BINARY || path.join(require("node:os").homedir(), ".local", "bin", "grok"), secretGateway: gateway,
      parentEnv: { PATH: process.env.PATH, HOME: root, LANG: "en_US.UTF-8" }, spawnEnv: { XAI_API_KEY: "synthetic-only" },
    });
    adapter = new GrokBuildRuntimeAdapter({ runtimePool: pool }); runtime = await adapter.acquire(binding, acquired);
    assert.equal(runtime.host.modelSecretRoutes.length, 2); runtime.subscribe(event => events.push(event));
  }
  async function turn(sessionId, prompt, expectFailure = false) {
    const { turn } = await runtime.turnStart({ sessionId, prompt, operationId: crypto.randomUUID(), cwd: workspace, permissionPolicy });
    const deadline = Date.now() + 40000; let completed;
    while (!(completed = events.find(event => event.type === "complete" && event.turnId === turn.id))) {
      if (failure) throw failure; assert(Date.now() < deadline, "native Grok turn deadline"); await new Promise(r => setTimeout(r, 20));
    }
    if (expectFailure) assert.equal(completed.errorCode, "SECRET_MODEL_PROJECTION_UNAVAILABLE", JSON.stringify(completed));
    else assert.equal(completed.status, "completed", JSON.stringify(completed));
  }
  try {
    await new Promise(r => provider.listen(0, "127.0.0.1", r)); await connect();
    const input = { source: "secret-fixture", cwd: workspace, permissionPolicy, permissionMode: "always-approve", modelSecretScope: scope };
    const { session } = await runtime.sessionStart(input);
    await turn(session.id, "Run the fixture once. password: 123456");
    assert(followup); assert(title, "automatic native title must use protected model requests");
    assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "1"); noTool = true;
    await assert.rejects(runtime.sessionStart({ ...input, source: "other", modelSecretScope: { ...scope, sessionId: "other" } }), { code: "SECRET_MODEL_IDENTITY_UNAVAILABLE" });
    await adapter.stopAll(); await connect();
    await runtime.sessionResume({ ...input, sessionId: session.id });
    await turn(session.id, "Use the saved result; do not repeat the command.");
    assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "1");
    const beforeOriginal = requests.length; originalMode = true;
    await turn(session.id, "password: FallbackInput852. Use the saved result without repeating any command.");
    // The pinned CLI issues one main reply and one dashboard summary per turn.
    // Both are separate model operations; neither may be retried by fallback.
    const originalRequests = requests.slice(beforeOriginal);
    assert.equal(originalRequests.length, 2);
    assert.equal(originalRequests.filter(body => Array.isArray(body.tools)).length, 1);
    assert.equal(originalRequests.filter(body => !body.tools && body.input[0]?.content?.startsWith("Write an ultra-short dashboard line")).length, 1);
    originalMode = false;
    for (const mode of ["502", "disconnect"]) {
      const beforeRetry = requests.length;
      nextFollowupFailure = mode;
      await turn(session.id, "Use the saved receipt after a temporary model-service interruption.");
      assert.equal(nextFollowupFailure, undefined, "the fixture interrupted the main request");
      const attempts = requests.slice(beforeRetry).filter(body => Array.isArray(body.tools));
      assert.equal(attempts.length, 2, "Grok retried the same request once");
      assert.deepEqual(attempts[0].input, attempts[1].input);
      assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "1");
    }
    const before = requests.length; runtime.host.modelSecretScope = null;
    await turn(session.id, "No model call without a live owner.", true);
    assert.equal(requests.length, before); verified = true;
    console.log(JSON.stringify({ verified, silentOriginalFallbackOnce: true, version: runtime.host.initializedResponse._meta?.agentVersion,
      modelRequests: requests.length, nativeExecutions: 1, title: true,
      restartResume: true, immutableScope: true, recovered502: true, recoveredBeforeStreamOutput: true,
      failureProviderCalls: 0, evidence: root }));
  } finally {
    fs.writeFileSync(path.join(root, "synthetic-model-requests.json"), JSON.stringify(requests, null, 2), { mode: 0o600 });
    if (!verified) console.error(JSON.stringify({ retainedFailure: root, providerCalls: requests.length }));
    await adapter?.stopAll(); await gateway.close(); await secrets.close();
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
