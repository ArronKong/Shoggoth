#!/usr/bin/env node
"use strict";

// Real Codex app-server + production MCP helper + Service, one Service and one
// chat session per permission mode. All homes, credentials and Responses output
// belong to a disposable local fixture; no account or network is used.
//
// Regression for MCP_SESSION_INVALID: the per-call Runtime binding proof is an MCP
// elicitation, which Codex refuses under approvalPolicy "never". "workspace-auto"
// and "full" used to resolve to "never", so every Shoggoth tool failed in them; they now
// keep their sandbox and ask ("on-request"). It also drives the user-facing Computer Use /
// Browser Use session confirmation in every mode (fake controllers stand in for the desktop
// driver and Chrome).
//
//   node scripts/codex-mcp-binding-permission-modes-regression.cjs [--native] [--unified]
//
// --native runs the same matrix against the locally installed Codex CLI
// (SHOGGOTH_TEST_NATIVE_CODEX overrides its path) and is skipped when absent.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = require("../app/agent-service/codex-runtime-paths");

const repo = path.resolve(__dirname, "..");
const native = process.argv.includes("--native");
const unified = process.argv.includes("--unified");
const NATIVE_CODEX = process.env.SHOGGOTH_TEST_NATIVE_CODEX
  || "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
const TERMINAL = ["completed", "failed", "canceled", "interrupted"];
// null = the Profile default (on-request + danger-full-access).
const MODES = unified ? ["request-approval", "auto-review", "full-access"]
  : [null, "ask", "read-only", "workspace-auto", "full"];
// Modes with a sandbox: a request to leave it is escalated to the user. In "full" and the default
// there is no sandbox, so Codex sends no escalation request at all.
const SANDBOXED_MODES = unified ? ["request-approval"] : ["ask", "read-only", "workspace-auto"];
const label = mode => mode ?? "default";

if (native && !fs.existsSync(NATIVE_CODEX)) {
  console.log(`SKIP native Codex CLI not found at ${NATIVE_CODEX}`);
  process.exit(0);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgmodes-")));
const home = path.join(root, "codex");
fs.mkdirSync(home, { mode: 0o700 });
// Outside every workspace/TMPDIR writable root, so only an approved escalation could create it.
const outsideRoot = fs.mkdtempSync(path.join(os.homedir(), ".sgmodes-outside-"));
const markerFor = mode => path.join(root, `probe-marker-${label(mode)}`);
const outsideFor = mode => path.join(outsideRoot, `escalated-${label(mode)}`);
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
  profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(text).reverse(), decryptString: bytes => Buffer.from(bytes).reverse().toString() };
let service; let host; let serial = 0;
let nativeReviews = 0;
const bindings = [];
const productConfirmations = [];
const outputs = new Map();

function fixtureTool(items, matcher) {
  const flatten = (list, namespace) => list.flatMap(item => item.tools ? flatten(item.tools, item.name)
    : [{ ...item, ...(namespace ? { namespace } : {}) }]);
  return flatten(items || []).find(matcher);
}

function scenarioCall(scenario, mode, tools, n, sessionKey) {
  const call = (tool, args) => ({ id: `fc-${n}`, type: "function_call", call_id: `call-${n}`, name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args), status: "completed" });
  const shoggothTool = (name, args) => {
    const tool = fixtureTool(tools, item => item.name?.endsWith(name));
    if (tool) return call(tool, args);
    const code = fixtureTool(tools, item => item.type === "custom" && item.name === "exec");
    assert(code, "fixture Codex exposes neither the Shoggoth tool nor code mode");
    return { id: `fc-${n}`, type: "custom_tool_call", call_id: `call-${n}`, name: "exec", namespace: "functions",
      input: `text(await tools.mcp__shoggoth__${name}(${JSON.stringify(args)}));` };
  };
  if (scenario === "binding") return shoggothTool("mcp_server_list", {});
  if (scenario === "computer-open") {
    return shoggothTool("computer_session_open", { source: "chat", sourceId: sessionKey,
      allowedApplications: ["com.apple.calculator"] });
  }
  if (scenario === "browser-open") {
    return shoggothTool("browser_session_open", { source: "chat", sourceId: sessionKey });
  }
  if (scenario === "escalate") {
    const tool = fixtureTool(tools, item => ["exec_command", "shell_command", "shell"].includes(item.name));
    assert(tool, "fixture Codex exposes no shell tool");
    const command = `touch ${outsideFor(mode)}`;
    return call(tool, tool.name === "exec_command"
      ? { cmd: command, sandbox_permissions: "require_escalated", justification: "regression escalation" }
      : { command, sandbox_permissions: "require_escalated", justification: "regression escalation" });
  }
  const server = `probe_${label(mode).replace(/-/gu, "_")}`;
  const tool = fixtureTool(tools, item => item.name === "probe_destructive"
    ? (item.namespace || "").endsWith(server) : item.name?.endsWith(`${server}__probe_destructive`));
  assert(tool, "fixture Codex exposes no external probe tool");
  return call(tool, {});
}

// Stand-ins for the desktop driver and Chrome: the product path (tool, permission,
// confirmation, Run scoping) is real, only the machine-touching controllers are fake.
const sessionsOpened = { computer: [], browser: [] };
const fakeController = kind => ({
  open() { return this; }, async close() {}, async closeForProfile() {}, async closeForWorkRun() {}, list() { return []; },
  async status() {
    return kind === "computer"
      ? { available: true, driverVersion: "fixture", contractVersion: "fixture",
        permissions: { accessibility: true, screenRecording: true }, sessions: [] }
      : { available: true, reason: null, engineVersion: "fixture", browser: "chrome", sessions: [] };
  },
  // The confirmation flows only open a session; the remaining tool surface must exist but stays unused.
  ...Object.fromEntries((kind === "computer"
    ? ["resume", "closeSession", "applicationList", "windowList", "snapshot", "focus", "action"]
    : ["closeSession", "listTools", "callTool"]).map(name => [name, async () => { throw new Error(`${kind}.${name} is not part of this fixture`); }])),
  async create(input) {
    sessionsOpened[kind].push(input);
    return { id: `${kind}-${sessionsOpened[kind].length}`, profileId: input.profileId, workRunId: input.workRunId,
      status: "ready", expiresAt: Date.now() + 60_000 };
  },
});

const provider = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(Buffer.concat(chunks));
    const key = /SCENARIO=([A-Za-z0-9_-]+) MODE=([A-Za-z0-9_-]+)(?: SESSION=([0-9a-f-]{36}))?/u.exec(JSON.stringify(body.input));
    const completed = body.input.some(item => ["function_call_output", "custom_tool_call_output"].includes(item.type));
    const n = ++serial, id = `fixture-response-${n}`;
    let item;
    try {
      // The native reviewer makes a separate model call. Its deterministic
      // assessment approves only this disposable fixture; product confirmation
      // must still reach the user after that native review.
      const review = unified && /user_authorization/u.test(JSON.stringify(body))
        && /risk_level/u.test(JSON.stringify(body));
      if (review) {
        nativeReviews++;
        item = { id: `msg-${n}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: '{"outcome":"allow"}', annotations: [] }] };
      } else if (!key) throw new Error("fixture prompt has no scenario marker");
      else if (completed) {
        outputs.set(`${key[1]}/${key[2]}`, JSON.stringify(body.input.filter(value =>
          /_output$/u.test(value.type))));
        item = { id: `msg-${n}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Fixture complete", annotations: [] }] };
      } else {
        const tools = body.tools || body.input.filter(value => value.type === "additional_tools")
          .flatMap(value => value.tools);
        item = scenarioCall(key[1], key[2] === "default" ? null : key[2], tools, n, key[3]);
      }
    } catch (error) { res.writeHead(500); res.end(String(error.message)); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let sequence = 0;
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response: { id, object: "response", status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
});

function startRun(profile, scenario, mode, workspaceRoot) {
  const workspace = path.join(workspaceRoot, `${scenario}-${label(mode)}`);
  fs.mkdirSync(workspace, { mode: 0o700 });
  const session = service.chatSessionStore.createSession({ operationId: `create-${scenario}-${label(mode)}`,
    profileId: profile.id, workspace, createdAt: Date.now() });
  if (mode !== null) service.chatSessionStore.setPermissionMode(session.sessionKey, mode);
  return service.workRunCoordinator.send({ operationId: `send-${scenario}-${label(mode)}`,
    sessionKey: session.sessionKey, prompt: `SCENARIO=${scenario} MODE=${label(mode)} SESSION=${session.sessionKey}` })
    .then(ack => {
      const record = { scenario, mode, runId: ack.run.id, types: new Set(), statuses: new Set() };
      service.workRunCoordinator.subscribeRun(ack.run.id, { streamId: null, afterSeq: 0 }, event => {
        record.types.add(event.type);
        if (event.type === "status" && event.payload?.status) record.statuses.add(event.payload.status);
      });
      return record;
    });
}

const statusOf = record => service.workDispatcher.getRun(record.runId).status;
async function waitFor(condition, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const fixtureFailure = record => JSON.stringify(service.workDispatcher.getRun(record.runId));

(async () => {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const binary = native ? NATIVE_CODEX : resolveCodexRuntimeLayout({ repoRoot: repo }).runtimePath;
  const environment = binding => Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId,
    kind: "shoggoth-managed", installationKind: native ? "system" : "bundled", homeKind: "managed-shared",
    strategy: "managed-shared", home, nativeHome: null, integrationRoot: null, binaryPath: binary,
    launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]),
    spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: home }), configurationMode: "overlay" });
  const pool = new CodexRuntimePool({ paths, parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
    runtimeAccountResolver: { resolve: binding => environment(binding) },
    hostFactory(options) {
      host = new CodexRuntimeHost({ ...options, repoRoot: repo, cwd: root,
        parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
        spawnProcess(command, args, spawnOptions) {
          assert.equal(spawnOptions.env.HOME, root);
          assert.equal(spawnOptions.env.CODEX_HOME, home);
          const child = spawn(command, args, spawnOptions);
          let buffered = "";
          child.stdout.on("data", chunk => { buffered += chunk.toString(); for (;;) {
            const end = buffered.indexOf("\n"); if (end < 0) break;
            const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
            try {
              const request = JSON.parse(line);
              if (request.params?._meta?.["shoggoth/runtime-call-binding"]) bindings.push(request);
              if (request.params?.requestedSchema?.properties?.confirm_product_action) productConfirmations.push(request);
            } catch { /* not a JSON-RPC line */ }
          } });
          return child;
        } });
      return host;
    } });
  service = createAgentService({ paths, safeStorage, prewarmMcpAuth: false, runtimePool: pool,
    computerUseController: fakeController("computer"), browserUseController: fakeController("browser"),
    parentEnv: {}, version: "codex-permission-modes-fixture" });
  await service.start();
  const profile = service.productStore.listAgentProfiles().find(item => item.enabled);

  const helper = path.join(root, "helper.cjs");
  fs.writeFileSync(helper, `"use strict";const {startShoggothMcpHelper}=require(${JSON.stringify(path.join(repo, "app/shoggoth-mcp-helper.js"))});
startShoggothMcpHelper({paths:${JSON.stringify(paths)},electronApp:{whenReady:async()=>{},quit(){}},runtimeProfileId:${JSON.stringify(profile.runtimeProfileId)},
runtimeAccountId:${JSON.stringify(profile.runtimeAccountId)},safeStorage:{isEncryptionAvailable:()=>true,
encryptString:s=>Buffer.from(s).reverse(),decryptString:b=>Buffer.from(b).reverse().toString()},serviceVersion:"fixture"})
.catch(e=>{console.error(e.code);process.exitCode=1});\n`, { mode: 0o600 });
  // A second, third-party MCP server whose tool is annotated destructive: Codex asks
  // for approval before calling it unless the policy is "never" (which then refuses).
  const probe = path.join(root, "probe-mcp.cjs");
  fs.writeFileSync(probe, `"use strict";const fs=require("fs");
require("readline").createInterface({input:process.stdin}).on("line",line=>{const q=JSON.parse(line);
const reply=result=>q.id!==undefined&&console.log(JSON.stringify({jsonrpc:"2.0",id:q.id,result}));
if(q.method==="initialize")reply({protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"probe",version:"1"}});
else if(q.method==="tools/list")reply({tools:[{name:"probe_destructive",description:"destructive probe",inputSchema:{type:"object",properties:{}},
annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}}]});
else if(q.method==="tools/call"){fs.writeFileSync(process.env.PROBE_MARKER_DIR+"/probe-marker-"+process.env.PROBE_LABEL,"called");reply({content:[{type:"text",text:"probe-ran"}]});}
else reply({});});\n`, { mode: 0o600 });
  // One probe server per mode so that each mode gets its own marker file.
  const probeServers = MODES.map(mode => `[mcp_servers.probe_${label(mode).replace(/-/gu, "_")}]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(probe)}]
env = { PROBE_MARKER_DIR = ${JSON.stringify(root)}, PROBE_LABEL = ${JSON.stringify(label(mode))} }
startup_timeout_sec = 15
tool_timeout_sec = 20
`).join("\n");
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
${probeServers}`, { mode: 0o600 });
  const workspaceRoot = path.join(root, "workspaces");
  fs.mkdirSync(workspaceRoot, { mode: 0o700 });

  // Wave 1: Shoggoth tools work in every mode, without asking the user.
  const wave1 = await Promise.all(MODES.map(mode => startRun(profile, "binding", mode, workspaceRoot)));
  await waitFor(() => wave1.every(record => TERMINAL.includes(statusOf(record))), 120_000,
    `wave 1 finish: ${wave1.map(record => `${record.scenario}/${label(record.mode)}=${statusOf(record)}`).join(", ")}`);
  for (const record of wave1) {
    const name = `${record.scenario}/${label(record.mode)}`;
    assert.equal(statusOf(record), "completed", `${name} must complete: ${fixtureFailure(record)}`);
    const output = outputs.get(`${record.scenario}/${label(record.mode)}`) || "";
    assert(output, `${name} produced no tool output`);
    assert(!/mcp_session_invalid/iu.test(output), `${name} must not report MCP_SESSION_INVALID: ${output.slice(0, 300)}`);
    assert(output.includes("servers"), `${name} must return the Shoggoth server list: ${output.slice(0, 300)}`);
  }
  assert(bindings.length >= MODES.length, `every mode must forward its binding proof to the host (${bindings.length})`);

  // Wave 2: requests that need an approval reach the user and nothing runs before the answer.
  // Real "never" would refuse them (a third-party MCP tool that needs approval, an escalation).
  // A run waiting for the user keeps its execution slot, so each case is answered (here: abandoned)
  // before the next starts.
  const expectedWait = { escalate: "waiting_approval", "mcp-probe": "waiting_input" };
  const prompted = [
    ...SANDBOXED_MODES.map(mode => ["escalate", mode]),
    // Native auto review owns third-party tool approval decisions. This
    // deterministic provider fixture checks its binding/confirmation plumbing.
    ...MODES.filter(mode => mode !== "auto-review").map(mode => ["mcp-probe", mode]),
  ];
  for (const [scenario, mode] of prompted) {
    const record = await startRun(profile, scenario, mode, workspaceRoot);
    await waitFor(() => statusOf(record) === expectedWait[scenario], 60_000,
      `${scenario}/${label(mode)} must ask the user (${statusOf(record)})`);
    assert.equal(fs.existsSync(markerFor(mode)), false, `${scenario}/${label(mode)}: the tool ran before approval`);
    assert.equal(fs.existsSync(outsideFor(mode)), false, `${scenario}/${label(mode)}: the command ran before approval`);
    await service.workRunCoordinator.abort({ operationId: `abort-${record.runId}`,
      sessionKey: service.workDispatcher.getRun(record.runId).sourceId, runId: record.runId });
    await waitFor(() => TERMINAL.includes(statusOf(record)), 30_000, `${scenario}/${label(mode)} must end after the abort`);
  }

  // Wave 3: the user-facing flow. Opening a Computer Use / Browser Use session needs the
  // user's confirmation, in every permission mode (it failed in "full" and "workspace-auto").
  const confirmations = [];
  for (const scenario of ["computer-open", "browser-open"]) {
    for (const mode of MODES) confirmations.push(await startRun(profile, scenario, mode, workspaceRoot));
  }
  const answered = new Set();
  const all = [...confirmations];
  const answerPrompts = async () => {
    for (const record of all) {
      const run = service.workDispatcher.getRun(record.runId);
      if (!["waiting_approval", "waiting_input"].includes(run.status) || answered.has(run.waitingRequestId)) continue;
      answered.add(run.waitingRequestId);
      await service.workRunCoordinator.respondInput({ operationId: `answer-${record.runId}-${answered.size}`,
        runId: record.runId, requestId: run.waitingRequestId, action: "submit",
        answers: { confirm_product_action: "确认执行" } });
    }
  };
  const confirmDeadline = Date.now() + 120_000;
  while (!confirmations.every(record => TERMINAL.includes(statusOf(record)))) {
    if (Date.now() > confirmDeadline) {
      throw new Error(`timeout: confirmation flows: ${confirmations.map(record =>
        `${record.scenario}/${label(record.mode)}=${statusOf(record)}`).join(", ")}`);
    }
    await answerPrompts();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const record of confirmations) {
    const name = `${record.scenario}/${label(record.mode)}`;
    assert.equal(statusOf(record), "completed", `${name} must complete: ${fixtureFailure(record)}`);
    const output = outputs.get(`${record.scenario}/${label(record.mode)}`) || "";
    assert(/(computer|browser)-\d/u.test(output), `${name} must return the opened session: ${output.slice(0, 300)}`);
    assert(!/MCP_SESSION_INVALID|用户确认失败|不支持确认|已取消/iu.test(output), `${name} must not fail its confirmation: ${output.slice(0, 300)}`);
  }
  if (unified) assert(nativeReviews > 0, "auto-review must invoke the native approval reviewer");
  assert.equal(sessionsOpened.computer.length, MODES.length, "one Computer Use session per confirmed run");
  assert.equal(sessionsOpened.browser.length, MODES.length, "one Browser Use session per confirmed run");
  assert.equal(productConfirmations.length, MODES.length * 2, "every product confirmation must reach the host");
  for (const request of productConfirmations) {
    assert.equal(request.method, "mcpServer/elicitation/request");
    assert.equal(request.params.requestedSchema.description, undefined, "Codex's typed form rejects root description");
    assert.match(request.params._meta?.["shoggoth/product-confirmation"] || "",
      /^shoggoth-product-confirmation-v1:[a-f0-9]{64}$/u, "Codex must preserve the exact Cron operation identity");
  }
  assert(sessionsOpened.computer.every(input => input.allowedApplications.join() === "com.apple.calculator"
    && !Object.hasOwn(input, "expiresInSeconds")), "the confirmed arguments reach the controller unchanged");

  console.log(`PASS ${native ? "native" : "bundled"} Codex ${host.runtimeVersion}: Shoggoth tools work in ${MODES.map(label).join("/")}; `
    + (unified ? `native auto reviews=${nativeReviews}; manual-mode escalations wait for the user; `
      : "escalations and third-party approvals reach the user before anything runs; ")
    + "Computer Use and Browser Use sessions open after the user confirms in every mode");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await service?.stop({ notify: false }); } catch { /* best effort */ }
  try { await host?.stop(); } catch { /* best effort */ }
  provider.closeAllConnections?.();
  await new Promise(resolve => provider.close(resolve));
  fs.rmSync(outsideRoot, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
