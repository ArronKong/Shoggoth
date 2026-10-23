"use strict";
// Installed Pi/OpenCode CLIs, private homes, controlled stdio MCP and loopback
// model responses. This proves native dispatch/catalog contracts; the complete
// Service/MCP/OS boundary is covered separately by workspace-execution-service-regression.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { resolvePiBinary, resolvePiLaunch, buildPiRpcArgs } = require("../app/agent-service/pi-runtime-paths");
const { RuntimeAccountResolver } = require("../app/agent-service/runtime-account-resolver");
const { DEFAULT_RUNTIME_ACCOUNTS, NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { OpenCodeRuntimeHost } = require("../app/agent-service/opencode-runtime-host");
const ROOT = path.resolve(__dirname, "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function peer() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "native-workspace-fixture", version: "1" } };
    else if (request.method === "tools/list") result = { tools: [{ name: "workspace_execute",
      description: "Controlled workspace transport proof.",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }] };
    else if (request.method === "tools/call") {
      fs.appendFileSync(process.argv[3], JSON.stringify(request.params) + "\n");
      result = { content: [{ type: "text", text: "controlled managed call completed" }] };
    } else if (request.method === "ping") result = {};
    else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      error: { code: -32601, message: "unknown method" } }) + "\n"); return; }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  });
}

async function piContract(root) {
  const home = path.join(root, "pi-home"), workspace = path.join(root, "pi-workspace");
  fs.mkdirSync(home); fs.mkdirSync(workspace);
  const report = path.join(root, "pi-tools.json"), peerLog = path.join(root, "pi-peer.jsonl");
  const wrapper = path.join(root, "pi-extension.mjs");
  fs.writeFileSync(wrapper, `import fs from "node:fs";
import extension from ${JSON.stringify(pathToFileURL(path.join(ROOT, "resources/pi/shoggoth-pi-extension.mjs")).href)};
export default async function(pi) {
  await extension(pi);
  pi.on("session_start", async () => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({active:pi.getActiveTools(),all:pi.getAllTools().map(tool=>tool.name)})));
}
`, { mode: 0o600 });
  const binary = resolvePiBinary();
  const launch = resolvePiLaunch(binary);
  const args = buildPiRpcArgs({ permissionPolicy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    sessionId: crypto.randomUUID(), sessionDir: path.join(root, "pi-sessions"), extensionPath: wrapper, workspaceExecutionVersion: 1 });
  const child = spawn(launch.command, [...launch.argsPrefix, ...args], { cwd: workspace,
    env: { HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), PATH: process.env.PATH, TMPDIR: root,
      SHOGGOTH_PI_WORKSPACE_EXECUTION_VERSION: "1", SHOGGOTH_PI_PERMISSION_POLICY: JSON.stringify({ sandbox: "workspace-write", approvalPolicy: "on-request" }),
      SHOGGOTH_PI_MCP_COMMAND: process.execPath, SHOGGOTH_PI_MCP_ARGS: JSON.stringify([__filename, "--peer", peerLog]) },
    stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; }); child.stdout.resume();
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    const end = Date.now() + 15000;
    while (!fs.existsSync(report) && child.exitCode === null && Date.now() < end) await delay(20);
    assert.ok(fs.existsSync(report), stderr);
    const tools = JSON.parse(fs.readFileSync(report));
    assert.deepEqual(tools.active, ["workspace_execute"], "builtin and built-in MCP tools must not remain active");
    assert.ok(tools.all.includes("workspace_execute"));
    child.stdin.end();
    const result = await Promise.race([closed, delay(5000).then(() => null)]);
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    console.log("PASS installed Pi: native builtins disabled, only authenticated extension tools active, no Provider calls");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  }
}

async function openCodeContract(root) {
  const workspace = path.join(root, "oc-workspace"), home = path.join(root, "oc-home"), data = path.join(root, "oc-data"), config = path.join(root, "oc-config");
  for (const directory of [workspace, home, data, config, path.join(config, "opencode")]) fs.mkdirSync(directory);
  const escaped = path.join(root, "native-escape-canary"), peerLog = path.join(root, "oc-peer.jsonl");
  const projectMcp = path.join(root, "project-mcp-escape"), globalMcp = path.join(root, "global-mcp-escape");
  const rogue = target => ({ type: "local", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(target)},'unsafe')`], enabled: true });
  const requests = [];
  let toolStep = 0;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    const names = (value.tools || []).map(tool => tool.function.name);
    requests.push({ names, stream: value.stream === true });
    const toolRun = names.includes("shoggoth_workspace_execute") && toolStep++ === 0;
    const calls = toolRun ? [
      { index: 0, id: "call_native_escape", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `touch ${quote(escaped)}`, description: "synthetic escape probe" }) } },
      { index: 1, id: "call_managed", type: "function", function: { name: "shoggoth_workspace_execute", arguments: JSON.stringify({ command: "controlled transport" }) } },
    ] : null;
    if (value.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => res.write("data: " + JSON.stringify({ id: "chatcmpl-workspace-fixture",
        object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture-model",
        choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
      chunk(calls ? { role: "assistant", tool_calls: calls } : { role: "assistant", content: "Managed native dispatch verified." });
      chunk({}, calls ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "chatcmpl-title", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "fixture-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Workspace guard", ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  fs.writeFileSync(path.join(config, "opencode/opencode.json"), JSON.stringify({ model: "fixture/fixture-model", small_model: "fixture/fixture-model",
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { apiKey: "synthetic-key", baseURL: url },
      models: { "fixture-model": { name: "Fixture", limit: { context: 32768, output: 4096 } } } } },
    mcp: { rogueGlobal: rogue(globalMcp) }, permission: { "*": "allow", read: "allow", bash: "allow" } }));
  fs.writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({ mcp: { rogueProject: rogue(projectMcp) },
    permission: { "*": "allow", read: "allow", bash: "allow" } }));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  const binding = { runtime: "opencode", runtimeProfileId: "workspace-native", runtimeAccountId: NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID };
  const resolver = new RuntimeAccountResolver({ paths, parentEnv: { PATH: process.env.PATH, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }, homedir: home });
  const runtimeEnvironment = resolver.resolve(binding, DEFAULT_RUNTIME_ACCOUNTS.find(account => account.id === binding.runtimeAccountId));
  const host = new OpenCodeRuntimeHost({ paths, runtimeBinding: binding, runtimeEnvironment, workspace,
    workspaceExecutionVersion: 1, mcpExecutionRunId: "native-workspace-contract", permissionPolicy: { approvalPolicy: "on-request", sandbox: "danger-full-access" },
    parentEnv: { PATH: process.env.PATH, TMPDIR: root }, promptTimeoutMs: 15000,
    mcpGateIssuer: { reserveMcpServer() { return { reservationId: "native-contract", command: process.execPath,
      args: [__filename, "--peer", peerLog], env: [] }; }, bindMcpServer() {}, revokeMcpServer() {} },
    spawnProcess(command, args, options) { return spawn(command, args, { ...options, env: { ...options.env,
      OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" } }); } });
  let nativeCards = 0;
  host.registerServerRequestHandler("item/commandExecution/requestApproval", () => { nativeCards++; return { decision: "decline" }; });
  try {
    await host.initialize();
    const created = await host.sessionStart({ source: "managed-native", cwd: workspace, model: "fixture/fixture-model" });
    const events = []; host.subscribe(event => events.push(event));
    const turn = await host.turnStart({ sessionId: created.session.id, operationId: "native-guard-probe", cwd: workspace,
      model: "fixture/fixture-model", prompt: "Run the controlled native guard probe." });
    const end = Date.now() + 20000;
    while (!events.some(event => event.type === "complete" && event.turnId === turn.turn.id) && Date.now() < end) await delay(20);
    const complete = events.find(event => event.type === "complete" && event.turnId === turn.turn.id);
    assert.equal(complete?.status, "completed", JSON.stringify({ complete, requests, events }));
    assert.equal(fs.existsSync(escaped), false, "a model-generated disabled native command must not execute");
    assert.equal(fs.existsSync(projectMcp), false, "project MCP executables must not start in managed mode");
    assert.equal(fs.existsSync(globalMcp), false, "unmanaged global MCP executables must not start in managed mode");
    assert.ok(requests.some(request => request.names.includes("shoggoth_workspace_execute")), "real model wire must include managed execution");
    for (const request of requests) assert.ok(!request.names.some(name => ["bash", "read", "write", "edit", "task", "execute", "webfetch"].includes(name)), JSON.stringify(request));
    assert.equal(nativeCards, 0);
    assert.equal(fs.readFileSync(peerLog, "utf8").trim().split("\n").map(JSON.parse).filter(call => call.name === "workspace_execute").length, 1);
    console.log("PASS installed OpenCode: managed tool on real model wire, native tools absent, forced native call blocked, MCP executes without extra card");
  } finally { await host.stop(); await new Promise(resolve => server.close(resolve)); }
}

if (process.argv[2] === "--peer") peer();
else (async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-workspace-native-"))); fs.chmodSync(root, 0o700);
  try { await piContract(root); await openCodeContract(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
