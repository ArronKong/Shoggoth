#!/usr/bin/env node
"use strict";
// Real bundled Codex app-server -> production helper/Service -> loopback MCP.
// Only the model provider and target service are fixtures. Provider assertions
// inspect actual HTTP request bodies, including native tool-result follow-ups.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs");
const http = require("node:http"), path = require("node:path");
const { spawn } = require("node:child_process");
const repo = path.resolve(__dirname, ".."), app = path.join(repo, "app");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = require("../app/agent-service/codex-runtime-paths");
const { startFixture, CANARY } = require("./fixtures/mcp-connector-http-fixture.cjs");
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-secret-native-"));
const home = path.join(root, "codex"), workspace = path.join(root, "workspace");
fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
  profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text).reverse(),
  decryptString: bytes => Buffer.from(bytes).reverse().toString() };
const requests = [], failures = [], hosts = [], wire = [], uuid = () => crypto.randomUUID();
let stage, serial = 0, service, target;
const provider = http.createServer(async (req, res) => {
  try {
    let data = ""; for await (const chunk of req) data += chunk;
    assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/responses");
    const body = JSON.parse(data); requests.push(body);
    assert(!data.includes("123456"), "plaintext password reached the actual model request");
    assert(!data.includes(CANARY), "connector authorization reached the actual model request");
    const outputs = body.input.filter(item => ["function_call_output", "custom_tool_call_output"].includes(item.type));
    const received = stage.callId && outputs.find(item => item.call_id === stage.callId);
    if (received) stage.output = received.output;
    const flatten = (items, namespace) => items.flatMap(item => item.tools ? flatten(item.tools, item.name)
      : [{ ...item, ...(namespace ? { namespace } : {}) }]);
    const tools = flatten(body.tools || body.input.filter(item => item.type === "additional_tools").flatMap(item => item.tools));
    const codeMode = tools.some(item => item.type === "custom" && item.name === "exec");
    const direct = tools.find(item => item.name?.endsWith("mcp_server_call"));
    const n = ++serial, responseId = `secret-response-${n}`;
    let item;
    // Codex sends a separate reviewer request. This local deterministic model
    // approves only our scripted fixture call; production product confirmation
    // and authenticated per-call binding still execute normally.
    const review = /user_authorization/u.test(data) && /risk_level/u.test(data);
    if (review) {
      item = { id: `msg-${n}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: '{"outcome":"allow"}', annotations: [] }] };
    } else if (stage.noTool || received) {
      item = { id: `msg-${n}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "The fixture operation is complete.", annotations: [] }] };
    } else {
      assert(codeMode || direct, "production MCP tool must be exposed to the real Runtime");
      assert(data.includes(stage.reference), "the model must receive the actual scoped reference");
      stage.callId = `secret-call-${n}`;
      const args = { serverId: stage.serverId, toolName: "echo", arguments: { value: `endpoint ${stage.reference}` } };
      item = codeMode ? { id: `fc-${n}`, type: "custom_tool_call", call_id: stage.callId, name: "exec", namespace: "functions",
        input: `text(await tools.mcp__shoggoth__mcp_server_call(${JSON.stringify(args)}));` }
        : { id: `fc-${n}`, type: "function_call", call_id: stage.callId, name: direct.name,
          ...(direct.namespace ? { namespace: direct.namespace } : {}), arguments: JSON.stringify(args), status: "completed" };
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" }); let sequence = 0;
    const event = (type, extra) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...extra })}\n\n`);
    event("response.created", { response: { id: responseId, object: "response", status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response: { id: responseId, object: "response", status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); res.end();
  } catch (error) { failures.push(error.message); res.writeHead(500); res.end("fixture validation failed"); }
});
async function main() {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve)); target = await startFixture();
  // Reuse the verified dependency root when this managed worktree borrows
  // .vendor. Keep production path containment checks intact; only the fixture's
  // Runtime dependency root differs from the source-under-test root.
  const runtimeRepo = path.dirname(fs.realpathSync(path.join(repo, ".vendor")));
  assert.deepEqual(fs.readFileSync(path.join(runtimeRepo, "build/codex-runtime-manifest.json")),
    fs.readFileSync(path.join(repo, "build/codex-runtime-manifest.json")));
  const binary = resolveCodexRuntimeLayout({ repoRoot: runtimeRepo, packaged: false }).runtimePath;
  const pool = new CodexRuntimePool({ paths, repoRoot: repo, packaged: false,
    parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
    runtimeAccountResolver: { resolve: binding => Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId,
      kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared",
      home, nativeHome: null, integrationRoot: null, binaryPath: binary, launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]),
      spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: home }), configurationMode: "overlay" }) },
    hostFactory: options => { const host = new CodexRuntimeHost({ ...options, repoRoot: repo, cwd: root,
      parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
      prepareRuntime: async () => ({ spawnEnv: { OPENAI_API_KEY: "synthetic-fixture-key" }, registeredSecrets: ["synthetic-fixture-key"],
        configArgs: [], runtimeConfig: { provider: { kind: "openai-api-key" } } }),
      spawnProcess(command, args, options) {
        const child = spawn(command, args, options); let buffered = "";
        child.stdout.on("data", chunk => {
          buffered += chunk.toString();
          for (;;) {
            const end = buffered.indexOf("\n"); if (end < 0) break;
            const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
            try { const item = JSON.parse(line); wire.push({ method: item.method, id: item.id,
              status: item.params?.status, code: item.error?.code, requestId: item.params?.requestId,
              binding: !!item.params?._meta?.["shoggoth/runtime-call-binding"] }); } catch {}
          }
        });
        return child;
      } }); hosts.push(host); return host; } });
  service = createAgentService({ paths, safeStorage, prewarmMcpAuth: false, runtimePool: pool, parentEnv: {}, repoRoot: repo,
    modelSecretRequest: (url, options, callback) => {
      assert.equal(url.origin, "https://api.openai.com");
      return http.request(new URL(url.pathname, `http://127.0.0.1:${provider.address().port}`), options, callback);
    },
    version: "chat-secret-native-fixture", autoSparkNotes: false, setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {} });
  await service.start();
  const ipc = (method, params) => requestService(paths, { id: uuid(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params });
  const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
  const helper = path.join(root, "helper.cjs");
  fs.writeFileSync(helper, `const {startShoggothMcpHelper}=require(${JSON.stringify(path.join(app, "shoggoth-mcp-helper.js"))});
startShoggothMcpHelper({paths:${JSON.stringify(paths)},electronApp:{whenReady:async()=>{},quit(){}},runtimeProfileId:${JSON.stringify(profile.runtimeProfileId)},runtimeAccountId:${JSON.stringify(profile.runtimeAccountId)},safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).reverse(),decryptString:b=>Buffer.from(b).reverse().toString()},serviceVersion:"fixture"}).catch(e=>{console.error(e.code);process.exitCode=1});`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, "config.toml"), `model = "gpt-4.1"
model_provider = "fixture"
[model_providers.fixture]
name = "Local fixture"
base_url = "http://127.0.0.1:${provider.address().port}/v1"
wire_api = "responses"
supports_websockets = false
[mcp_servers.shoggoth]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(helper)}]
startup_timeout_sec = 15
tool_timeout_sec = 20
required = true
`, { mode: 0o600 });
  const added = await ipc("connector.mcp.add", { source: { kind: "custom" }, name: "Native secret fixture",
    option: { kind: "remote", protocol: "streamable-http", url: target.origin + "/mcp" },
    fields: { headers: { Authorization: `Bearer ${CANARY}` } }, expectedRevision: (await ipc("connector.mcp.list", {})).revision });
  assert.equal(added.server.status, "ready");
  const session = (await ipc("chat.session.create", { operationId: uuid(), profileId: profile.id, workspace, createdAt: Date.now() })).session;
  const owner = { backendId: "shoggoth", agentId: profile.id, sessionKey: session.sessionKey };
  const operationId = uuid();
  const prepared = await ipc("chat.secret.prepare", { ...owner, operationId, text: '密码是 "123456"。请将凭据交给本地测试工具。' });
  const reference = prepared.references[0].reference;
  const waitRun = async runId => {
    const deadline = Date.now() + 30000, answered = new Set();
    while (Date.now() < deadline) {
      assert.deepEqual(failures, []);
      const run = service.workDispatcher.getRun(runId);
      if (["completed", "failed", "canceled", "interrupted"].includes(run.status)) { assert.equal(run.status, "completed", JSON.stringify(run)); return; }
      if (run.status === "waiting_input" && !answered.has(run.waitingRequestId)) {
        answered.add(run.waitingRequestId);
        await service.workRunCoordinator.respondInput({ operationId: uuid(), runId, requestId: run.waitingRequestId,
          action: "submit", answers: { confirm_product_action: "确认执行" } });
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const run = service.workDispatcher.getRun(runId);
    throw Error("Native credential fixture deadline exceeded: " + JSON.stringify({ status: run.status,
      waitingRequestId: run.waitingRequestId, requests: requests.length, callId: stage.callId,
      hosts: hosts.map(host => host.state), wire: wire.slice(-20) }));
  };
  for (let turn = 0; turn < 2; turn++) {
    stage = { serverId: added.server.id, reference };
    const ack = await ipc("chat.send", { operationId: turn ? uuid() : operationId, sessionKey: session.sessionKey,
      prompt: turn ? `请再次使用 ${reference} 执行新的本地测试操作。` : prepared.text, createdAt: Date.now() });
    await waitRun(ack.run.id);
    assert.equal(target.state.calls, turn + 1);
    assert.equal(target.state.requests.filter(item => item.method === "tools/call").at(-1).params.arguments.value, "endpoint 123456");
    assert(stage.output?.includes(reference), "the actual native follow-up must contain the projected tool result");
    assert(!stage.output.includes("123456"));
  }
  const receipts = (await ipc("chat.secret.results", owner)).items;
  assert.equal(receipts.length, 2);
  for (const receipt of receipts) assert.equal((await ipc("chat.secret.result", { ...owner, receiptId: receipt.receiptId })).result.content[0].text, "endpoint 123456");
  assert.equal(target.state.calls, 2);
  await ipc("chat.secret.revoke", { ...owner, reference });
  stage = { noTool: true };
  const ordinary = await ipc("chat.send", { operationId: uuid(), sessionKey: session.sessionKey,
    prompt: "先前凭据已撤销，继续普通聊天，不调用工具。", createdAt: Date.now() });
  await waitRun(ordinary.run.id);
  assert.equal(target.state.calls, 2);
  assert.equal((await ipc("chat.secret.list", owner)).items.length, 0);
  const history = await ipc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 100 });
  assert(!JSON.stringify(history).includes("123456")); assert(history.messages.length >= 6);
  console.log(JSON.stringify({ pass: true, runtime: "real bundled Codex app-server", requests: requests.length,
    actualToolCalls: 2, nativeToolFollowups: 2, continuedAfterRevoke: true, historyPreserved: true,
    modelBodiesSha256: crypto.createHash("sha256").update(JSON.stringify(requests)).digest("hex") }));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  await service?.stop({ notify: false }); await Promise.allSettled(hosts.map(host => host.stop()));
  await target?.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});
