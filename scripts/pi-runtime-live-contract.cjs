"use strict";
// Opt-in real installed CLI, production adapter + extension, isolated HOME and
// a loopback-only provider stream. No user credentials or paid model requests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { PiRuntimePool } = require("../app/agent-service/pi-runtime-pool");
const { PiRuntimeAdapter } = require("../app/agent-service/pi-runtime-adapter");

async function main() {
  const binaryPath = process.env.SHOGGOTH_TEST_PI_BINARY;
  assert.ok(binaryPath && path.isAbsolute(binaryPath), "SHOGGOTH_TEST_PI_BINARY must identify an installed CLI");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-pi-contract-")));
  const workspace = path.join(root, "workspace"), home = path.join(root, ".pi", "agent");
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let scenario = "deny", requests = 0;
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/chat/completions");
      let raw = "";
      for await (const chunk of req) { raw += chunk; assert.ok(raw.length < 1024 * 1024); }
      const body = JSON.parse(raw); requests++;
      const done = body.messages.some(message => message.role === "tool");
      assert.ok(body.tools.some(tool => tool.function.name === "write"), "production Pi exposes write");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: `fixture-${requests}`, object: "chat.completion.chunk", created: 1, model: "controlled",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      send(done ? { role: "assistant", content: "done" } : { role: "assistant", tool_calls: [{ index: 0,
        id: `write-${scenario}`, type: "function", function: { name: "write",
          arguments: JSON.stringify({ path: path.join(workspace, `${scenario}.txt`), content: "approved-only" }) } }] });
      send({}, done ? "stop" : "tool_calls");
      res.end("data: [DONE]\n\n");
    } catch (error) { res.writeHead(500); res.end("fixture rejected request"); server.fixtureError = error; }
  });
  let adapter;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    fs.writeFileSync(path.join(home, "models.json"), JSON.stringify({ providers: { "shoggoth-contract": {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture-no-secret",
      models: [{ id: "controlled", name: "Controlled", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }), { mode: 0o600 });
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ defaultProvider: "shoggoth-contract", defaultModel: "controlled" }), { mode: 0o600 });
    const relay = path.join(root, "relay.cjs");
    fs.writeFileSync(relay, `let buffer="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{
      buffer+=chunk;let i;while((i=buffer.indexOf("\\n"))>=0){const message=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
      if(message.id===undefined)continue;const result=message.method==="initialize"?{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:{tools:[]};
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result})+"\\n");}});`, { mode: 0o600 });
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const pool = new PiRuntimePool({
      paths: { stateDir: path.join(root, "state"), trustedRoot: root }, homedir: root,
      parentEnv: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8" }, binaryPath,
      extensionPath: path.resolve(__dirname, "../resources/pi/shoggoth-pi-extension.mjs"),
      requestTimeoutMs: 10000, acceptanceTimeoutMs: 15000, promptTimeoutMs: 30000,
      shutdownGraceMs: 1000, killGraceMs: 1000,
      mcpGateIssuer: {
        reserveMcpServer: () => ({ reservationId: crypto.randomBytes(32).toString("hex"), name: "shoggoth",
          command: process.execPath, args: [relay], env: [] }),
        bindMcpServer: () => ({ bound: true }), revokeMcpServer: () => ({ revoked: true }),
      },
    });
    adapter = new PiRuntimeAdapter({ runtimePool: pool });
    const runtime = await adapter.acquire({ runtime: "pi", runtimeProfileId: "pi-contract",
      runtimeAccountId: "native-pi-default-v1" }, { workspace, permissionPolicy, mcpExecutionRunId: crypto.randomUUID() });
    assert.equal((await runtime.authenticationState()).authenticated, true);
    assert.equal((await runtime.modelsList({ limit: 100, cursor: null })).data[0].model, "shoggoth-contract/controlled");
    assert.equal(requests, 0, "readiness makes no provider request");
    let approvals = 0;
    runtime.registerServerRequestHandler("item/fileChange/requestApproval", async () => {
      approvals++;
      assert.equal(fs.existsSync(path.join(workspace, `${scenario}.txt`)), false, "approval precedes the write");
      return { decision: scenario === "allow" ? "accept" : "decline" };
    });
    const events = []; runtime.subscribe(event => events.push(event));
    for (scenario of ["deny", "allow"]) {
      const { session } = await runtime.sessionStart({ source: `contract:${scenario}`, cwd: workspace,
        model: "shoggoth-contract/controlled", permissionPolicy });
      const { turn } = await runtime.turnStart({ sessionId: session.id, operationId: crypto.randomUUID(),
        prompt: "Run the controlled write once, then stop.", model: "shoggoth-contract/controlled", cwd: workspace, permissionPolicy });
      const deadline = Date.now() + 40000;
      while (!events.some(event => event.type === "complete" && event.turnId === turn.id)) {
        assert.ok(Date.now() < deadline, "real Pi turn must settle");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const complete = events.find(event => event.type === "complete" && event.turnId === turn.id);
      assert.equal(complete.status, "completed", JSON.stringify(complete));
      assert.equal(fs.existsSync(path.join(workspace, `${scenario}.txt`)), scenario === "allow");
    }
    assert.equal(approvals, 2);
    assert.equal(fs.readFileSync(path.join(workspace, "allow.txt"), "utf8"), "approved-only");
    assert.equal(server.fixtureError, undefined);
    assert.equal(requests, 4);
    console.log(JSON.stringify({ cliVersion: runtime.host.cliVersion?.join(".") || "unknown", protocol: "passed", auth: "passed",
      modelCatalog: "passed", realTurns: 2, deniedWrite: "blocked", approvedWrite: "completed", provider: "isolated-loopback" }));
  } finally {
    await adapter?.stopAll();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
