#!/usr/bin/env node
"use strict";
// Real bundled app-server + production helper + Service, with synthetic
// Responses served only on loopback. No account credentials or model quota.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const crypto = require("node:crypto"), http = require("node:http"), { spawn } = require("node:child_process");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = require("../app/agent-service/codex-runtime-paths");
const { defaultConfig, DAY_MS } = require("../app/agent-service/proactive-service-protocol");
const repo = path.resolve(__dirname, ".."), root = fs.realpathSync(fs.mkdtempSync("/tmp/sg-spark-binding-"));
const home = path.join(root, "codex"); fs.mkdirSync(home, { mode: 0o700 });
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() };
const clock = { value: Date.now() }, bindings = [], starts = [], cases = [];
let service, pool, activeCase, nativeHost, providerRequests = 0, serial = 0;
const provider = http.createServer((req, res) => {
  const chunks = []; req.on("data", data => chunks.push(data)); req.on("end", () => {
    try {
      assert.equal(req.url, "/v1/responses"); assert.equal(req.method, "POST");
      assert.ok(++providerRequests <= 12, "Unexpected synthetic provider loop");
      const body = JSON.parse(Buffer.concat(chunks));
      const output = body.input.filter(item => ["function_call_output", "custom_tool_call_output"].includes(item.type));
      const flatten = (items, namespace) => items.flatMap(item => item.tools ? flatten(item.tools, item.name) : [{ ...item, ...(namespace ? { namespace } : {}) }]);
      const tools = flatten(body.tools || []);
      activeCase.providerRequests = (activeCase.providerRequests || 0) + 1;
      activeCase.modelTools = tools.map(tool => tool.name);
      if (activeCase.proactive) {
        assert.ok(tools.every(tool => ["request_user_input", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(tool.name)
          || tool.name?.endsWith("proactive_respond")), "Proactive model must have no shell, file, browser or other product tools: " + JSON.stringify(tools.map(tool => tool.name)));
      }
      const n = ++serial, responseId = `response-fixture-${n}`;
      let item;
      if (activeCase.toolSent) {
        assert.ok(output.length > 0, "Native tool output must return to the provider");
        activeCase.output = JSON.stringify(output);
        item = { id: `msg-${n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete", annotations: [] }] };
      } else {
        const name = activeCase.proactive ? "proactive_respond" : "app_status";
        const tool = tools.find(item => item.name?.endsWith(name)), codeMode = tools.some(item => item.name === "exec" && item.type === "custom");
        assert.ok(tool || codeMode, `Missing fixture tool ${name}: ${JSON.stringify(tools.map(item => item.name))}`);
        const run = activeCase.proactive ? service.workDispatcher.listRuns({ source: "proactive" }).find(item => item.status === "running") : null;
        const occurrence = run ? service.proactiveStore.occurrenceForRun(run.id) : null;
        const args = activeCase.proactive ? { runId: run.id, outcome: "notice", reason: "This idea has a useful next step", body: "这个灵感值得再看一次。",
          candidates: occurrence.candidates.slice(0, 1).map(({ id, evidenceVersion }) => ({ id, evidenceVersion })),
          ...(activeCase.mode === "HEARTBEAT" ? { scratch: "Verified native heartbeat." } : {}) } : {};
        activeCase.toolSent = true;
        item = codeMode ? { id: `fc-${n}`, type: "custom_tool_call", call_id: `call-fixture-${n}`, name: "exec", namespace: "functions", input: `text(await tools.mcp__shoggoth__${name}(${JSON.stringify(args)}));` }
          : { id: `fc-${n}`, type: "function_call", call_id: `call-fixture-${n}`, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args), status: "completed" };
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" }); let seq = 0;
      const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
      emit("response.created", { response: { id: responseId, object: "response", status: "in_progress", output: [] } });
      emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id: responseId, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
    } catch (error) { activeCase.error ??= error.message; res.writeHead(500); res.end("local fixture rejected request"); }
  });
});
const id = () => crypto.randomUUID();
async function until(predicate) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error(`Native fixture timed out: ${activeCase.error || activeCase.mode}`);
}
(async () => {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const binary = resolveCodexRuntimeLayout({ repoRoot: process.env.SHOGGOTH_FIXTURE_RUNTIME_ROOT || repo }).runtimePath;
  pool = new CodexRuntimePool({ paths, parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
    runtimeAccountResolver: { resolve: binding => Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId,
      kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared", home,
      nativeHome: null, integrationRoot: null, binaryPath: binary, launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]),
      spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: home }), configurationMode: "overlay" }) },
    hostFactory(options) {
      nativeHost = new CodexRuntimeHost({ ...options, repoRoot: repo, cwd: root,
        parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
        spawnProcess(command, args, opts) {
          assert.equal(opts.env.HOME, root); assert.equal(opts.env.CODEX_HOME, home);
          const child = spawn(command, args, opts); let buffered = "";
          child.stdout.on("data", chunk => { buffered += chunk.toString(); for (;;) {
            const end = buffered.indexOf("\n"); if (end < 0) break;
            const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
            try { const request = JSON.parse(line); if (request.params?._meta?.["shoggoth/runtime-call-binding"]) bindings.push({
              threadId: request.params.threadId, turnId: request.params.turnId }); } catch {}
          } }); return child;
        } });
      for (const method of ["threadStart", "threadResume", "turnStart"]) {
        const invoke = nativeHost[method].bind(nativeHost);
        nativeHost[method] = async params => { starts.push({ method, mode: activeCase?.mode, approvalPolicy: params.approvalPolicy, sandbox: params.sandbox }); return invoke(params); };
      }
      return nativeHost;
    } });
  service = createAgentService({ paths, safeStorage, runtimePool: pool, autoSparkNotes: false, now: () => clock.value,
    prewarmMcpAuth: false, parentEnv: {}, proactiveProfileAvailable: () => true,
    proactiveRuntimeCapability: () => ({ semanticVerified: true, reason: null }),
    setProactiveTimer: () => 1, clearProactiveTimer() {}, notificationSender: async () => ({ state: "submitted" }) });
  await service.start(); const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
  const helper = path.join(root, "helper.cjs");
  fs.writeFileSync(helper, `"use strict";require(${JSON.stringify(path.join(repo, "app/shoggoth-mcp-helper.js"))}).startShoggothMcpHelper({paths:${JSON.stringify(paths)},electronApp:{whenReady:async()=>{},quit(){}},runtimeProfileId:${JSON.stringify(profile.runtimeProfileId)},runtimeAccountId:${JSON.stringify(profile.runtimeAccountId)},safeStorage:{isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v).reverse(),decryptString:v=>Buffer.from(v).reverse().toString()},serviceVersion:"fixture"}).catch(e=>{console.error(e.code);process.exitCode=1});\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, "config.toml"), `model = "gpt-4.1"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Loopback fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nsupports_websockets = false\n[mcp_servers.shoggoth]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(helper)}]\nstartup_timeout_sec = 15\ntool_timeout_sec = 20\nrequired = true\n`, { mode: 0o600 });
  let fullSession;
  for (const mode of ["ask", "full", "workspace-auto", "full-resume"]) {
    activeCase = { mode, proactive: false, toolSent: false };
    const workspace = path.join(root, mode); fs.mkdirSync(workspace, { mode: 0o700 });
    const session = mode === "full-resume" ? fullSession : service.chatSessionStore.createSession({ operationId: id(), profileId: profile.id, workspace, createdAt: clock.value });
    if (mode !== "full-resume") service.chatSessionStore.setPermissionMode(session.sessionKey, mode);
    if (mode === "full") fullSession = session;
    const accepted = await service.workRunCoordinator.send({ operationId: id(), sessionKey: session.sessionKey, prompt: `Synthetic transport acceptance ${mode}` });
    await until(() => ["completed", "failed", "interrupted", "canceled"].includes(service.workDispatcher.getRun(accepted.run.id).status));
    assert.equal(service.workDispatcher.getRun(accepted.run.id).status, "completed", JSON.stringify({ run: service.workDispatcher.getRun(accepted.run.id), fixture: activeCase.error }));
    assert.ok(activeCase.output && !activeCase.output.includes("mcp_session_invalid"));
    const calls = starts.filter(item => item.mode === mode);
    assert.ok(calls.every(item => item.approvalPolicy === "on-request"));
    assert.ok(calls.some(item => item.method !== "turnStart" && item.sandbox === (mode.startsWith("full") ? "danger-full-access" : "workspace-write")));
    cases.push({ mode, bindingForwarded: bindings.length === cases.length + 1, toolSucceeded: true });
  }
  activeCase = { mode: "SparkNotes", proactive: true, toolSent: false };
  service.inspirationStore.create({ operationId: id(), body: "可回顾的灵感种子" });
  clock.value += 2 * DAY_MS;
  const config = { ...defaultConfig("inspiration", profile.id, clock.value, "UTC"), enabled: true };
  service.proactiveStore.setMonitor({ operationId: id(), expectedRevision: 0, config });
  const occurrence = service.proactiveStore.claimOccurrence(config.id, clock.value, clock.value);
  const result = await service.proactiveService.check(occurrence);
  assert.equal(result.state, "published", JSON.stringify(result));
  assert.ok(activeCase.output.includes('accepted')); assert.ok(!activeCase.output.includes("mcp_session_invalid"));
  assert.equal(bindings.length, 5); assert.ok(bindings.every(item => item.threadId && item.turnId));
  const notice = service.proactiveStore.noticeForOccurrence(occurrence.id);
  assert.equal(notice.title, "SparkNotes"); assert.equal(notice.items[0].group, "seed");
  const session = service.chatSessionStore.getSession(notice.sessionKey);
  const event = service.transcriptStore.listEvents(profile.id, session.id).find(item => item.content?.proactiveNotice?.id === notice.id);
  assert.ok(event.content.text.includes("#/inspirations?id="));
  assert.equal(service.proactiveStore.getNote(notice.items[0].ideaId).lastRemindedAt, clock.value);
  cases.push({ mode: "SparkNotes", bindingForwarded: true, toolSucceeded: true, noticePublished: true });
  activeCase = { mode: "HEARTBEAT", proactive: true, toolSent: false };
  const document = await service.proactiveService.handle("proactive.document.get", { profileId: profile.id });
  await service.proactiveService.handle("proactive.document.set", { profileId: profile.id, expectedRevision: document.document.revision,
    content: "# Check\nReview the supplied check and record working notes. Notify once for this acceptance." });
  const heartbeat = { ...defaultConfig("heartbeat", profile.id, clock.value, "UTC"), enabled: true, activeHours: null };
  service.proactiveStore.setMonitor({ operationId: id(), expectedRevision: 0, config: heartbeat });
  const heartbeatOccurrence = service.proactiveStore.claimOccurrence(heartbeat.id, clock.value, clock.value);
  const heartbeatResult = await service.proactiveService.check(heartbeatOccurrence);
  assert.equal(heartbeatResult.state, "published", JSON.stringify(heartbeatResult));
  assert.equal(service.proactiveStore.heartbeatScratch(profile.id).content, "Verified native heartbeat.");
  assert.equal(bindings.length, 6);
  cases.push({ mode: "HEARTBEAT", bindingForwarded: true, toolSucceeded: true, noticePublished: true, scratchPersisted: true });
  assert.ok(cases.every(item => item.bindingForwarded));
  console.log(JSON.stringify({ verified: true, runtimeVersion: nativeHost.runtimeVersion, actualProviderCalls: 0, provider: "synthetic-loopback", providerRequests, cases }));
})().catch(error => { console.error(error.stack || error); console.error(JSON.stringify({fixtureError:activeCase?.error,modelTools:activeCase?.modelTools,providerRequests,caseRequests:activeCase?.providerRequests})); process.exitCode = 1; }).finally(async () => {
  try { await service?.stop({ notify: false }); await pool?.stopAll(); }
  finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});
