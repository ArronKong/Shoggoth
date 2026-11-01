"use strict";
// Installed Pi, synthetic account and loopback model. No user account or tools.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { PiRuntimePool } = require("../app/agent-service/pi-runtime-pool");
const { PiRuntimeAdapter } = require("../app/agent-service/pi-runtime-adapter");
const root = fs.mkdtempSync("/private/tmp/sg-pi-heartbeat-"), home = path.join(root, ".pi", "agent");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const requests = [], sockets = new Set(); let pending, error, adapter, response;
const provider = http.createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    assert.equal(body.model, "controlled"); assert.deepEqual(body.tools || [], []);
    if (pending) { pending(); return; }
    const text = response ? response(body) : JSON.stringify({ outcome: "silent", scratch: "Native Pi checked" });
    const chunk = (delta, finish_reason = null) => ({ id: `fixture-${requests.length}`, object: "chat.completion.chunk",
      created: 1, model: "controlled", choices: [{ index: 0, delta, finish_reason }] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: text }))}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (caught) { error = caught; res.writeHead(500); res.end("fixture rejected request"); }
});
provider.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
(async () => {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const models = JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    api: "openai-completions", apiKey: "synthetic-loopback-key", models: [{ id: "controlled", name: "Controlled",
      reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const settings = JSON.stringify({ defaultProvider: "fixture", defaultModel: "controlled" });
  fs.writeFileSync(path.join(home, "models.json"), models, { mode: 0o600 });
  fs.writeFileSync(path.join(home, "settings.json"), settings, { mode: 0o600 });
  const pool = new PiRuntimePool({ paths: { trustedRoot: root, stateDir: path.join(root, "state") }, homedir: root,
    parentEnv: { HOME: root, PATH: process.env.PATH, LANG: "C.UTF-8" }, binaryPath: fs.realpathSync(process.argv[2]),
    extensionPath: path.resolve(__dirname, "../resources/pi/shoggoth-pi-extension.mjs"),
    requestTimeoutMs: 10000, acceptanceTimeoutMs: 15000, promptTimeoutMs: 30000, shutdownGraceMs: 1000, killGraceMs: 1000,
    mcpGateIssuer: { reserveMcpServer() { throw Error("Model-only must not reserve MCP"); },
      bindMcpServer() { throw Error("Model-only must not bind MCP"); }, revokeMcpServer() { return { revoked: true }; } } });
  adapter = new PiRuntimeAdapter({ runtimePool: pool });
  const handle = await adapter.acquire({ runtime: "pi", runtimeProfileId: "native-heartbeat-fixture", runtimeAccountId: "native-pi-default-v1" },
    { workspace: null, modelOnly: true, permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
  for (const model of [null, "fixture/controlled"]) {
    const result = await handle.generateModelOnly({ prompt: "Return the requested JSON check with short working notes.",
      model, operationId: `native-heartbeat-${requests.length}`, timeoutMs: 30000 });
    if (error) throw error;
    assert.equal(JSON.parse(result.text).scratch, "Native Pi checked");
    assert.equal(result.model, "controlled"); assert.equal(result.provider, "fixture"); assert.equal(result.usage?.totalTokens, 20);
  }
  const controller = new AbortController(); let received;
  const requested = new Promise(resolve => { received = resolve; }); pending = received;
  const canceled = handle.generateModelOnly({ prompt: "Wait for a result", model: null, operationId: "native-heartbeat-cancel",
    timeoutMs: 10000, signal: controller.signal });
  canceled.catch(() => {}); await Promise.race([requested, canceled]); controller.abort();
  await assert.rejects(canceled, { code: "MODEL_ONLY_CANCELED" });
  if (error) throw error;
  assert.equal(requests.length, 3);
  pending = null;
  const closure = await require("./helpers/proactive-native-closure.cjs").verifyProactiveNativeClosure({
    root, adapter, runtime: "pi", model: "fixture/controlled", setResponse: value => { response = value; } });
  if (error) throw error;
  assert.equal(fs.readFileSync(path.join(home, "models.json"), "utf8"), models);
  assert.equal(fs.readFileSync(path.join(home, "settings.json"), "utf8"), settings);
  console.log(JSON.stringify({ verified: true, runtime: "Pi", runtimeVersion: handle.host.cliVersion,
    provider: "synthetic-loopback", actualProviderCalls: 0, nativeTools: 0, modelRequests: requests.length,
    defaultModel: "fixture/controlled", explicitModel: true, totalTokens: 20, cancellation: true, accountUnchanged: true, closure }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await adapter?.stopAll(); for (const socket of sockets) socket.destroy();
  await new Promise(resolve => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
});
