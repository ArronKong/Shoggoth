"use strict";

// Pinned native Codex -> loopback Responses provider. Empty synthetic homes,
// synthetic credentials and one harmless command; no real account or model.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = require("../app/agent-service/codex-runtime-paths");
const { resolveServicePaths } = require("../app/agent-service/paths");
const repo = path.resolve(__dirname, "..");
const flatten = (items, namespace) => items.flatMap(item => item.tools
  ? flatten(item.tools, item.name) : [{ ...item, namespace }]);
const until = async (predicate, label) => {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

async function scenario(compaction) {
  const root = fs.mkdtempSync("/private/tmp/shoggoth-native-steering-");
  const home = path.join(root, "codex"), workspace = path.join(root, "workspace");
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  const requests = [], events = [], failures = [];
  const marker = "SYNTHETIC_STEER_LINKS_ONLY";
  let releaseFirst, host;
  const provider = http.createServer(async (request, response) => {
    try {
      if (request.url !== "/v1/responses") { request.resume(); response.writeHead(404).end(); return; }
      let text = ""; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text), number = requests.length + 1;
      requests.push(body);
      assert(number <= 8, "the synthetic turn must not loop indefinitely");
      const send = () => {
        const tools = flatten(body.tools || []), code = tools.find(tool => tool.name === "exec" && tool.type === "custom");
        const direct = tools.find(tool => tool.name === "exec_command");
        const command = { cmd: "printf synthetic-steer-receipt", workdir: workspace, max_output_tokens: 100 };
        const item = number === 1 ? code ? { id: "fc-1", type: "custom_tool_call", name: "exec",
          namespace: code.namespace, call_id: "call-1", input: `text(await tools.exec_command(${JSON.stringify(command)}));` }
          : { id: "fc-1", type: "function_call", name: direct.name,
            ...(direct.namespace ? { namespace: direct.namespace } : {}), call_id: "call-1",
            arguments: JSON.stringify(command), status: "completed" }
          : { id: `msg-${number}`, type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "Synthetic links only.", annotations: [] }] };
        response.writeHead(200, { "Content-Type": "text/event-stream" }); let sequence = 0;
        const emit = (type, extra) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...extra })}\n\n`);
        emit("response.created", { response: { id: `response-${number}`, object: "response", status: "in_progress", output: [] } });
        emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
        emit("response.output_item.done", { output_index: 0, item });
        const input = compaction && number === 1 ? 445_000 : 100;
        emit("response.completed", { response: { id: `response-${number}`, object: "response", status: "completed",
          output: [item], usage: { input_tokens: input, output_tokens: 20, total_tokens: input + 20 } } });
        response.end();
      };
      if (number === 1) releaseFirst = send; else send();
    } catch (error) { failures.push(error.message); response.writeHead(500).end(); }
  });
  try {
    await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
    fs.writeFileSync(path.join(home, "config.toml"), `model = "gpt-4.1"\nmodel_provider = "fixture"\n`
      + `check_for_update_on_startup = false\nweb_search = "disabled"\n[model_providers.fixture]\nname = "Synthetic provider"\n`
      + `base_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nsupports_websockets = false\n`, { mode: 0o600 });
    const binding = { runtime: "codex", runtimeProfileId: "steering-fixture", runtimeAccountId: "shoggoth-internal-codex-default-v1" };
    const paths = resolveServicePaths({ homeDir: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"),
      cacheRoot: path.join(root, "cache"), trustedRoot: root });
    const binary = resolveCodexRuntimeLayout({ repoRoot: repo, packaged: false }).runtimePath;
    host = new CodexRuntimeHost({ paths, repoRoot: repo, cwd: workspace, ...binding, runtimeBinding: binding,
      parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
      runtimeEnvironment: Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId,
        kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared",
        home, nativeHome: null, integrationRoot: null, binaryPath: binary, launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]),
        spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: home }), configurationMode: "overlay" }),
      prepareRuntime: async () => ({ spawnEnv: { OPENAI_API_KEY: "synthetic-steering-auth" }, registeredSecrets: ["synthetic-steering-auth"],
        configArgs: [], runtimeConfig: { provider: { kind: "custom-responses" } } }) });
    await host.initialize(); host.subscribe(event => events.push(event));
    const { thread } = await host.threadStart({ cwd: workspace, model: "gpt-4.1", approvalPolicy: "never", sandbox: "danger-full-access" });
    const { turn } = await host.turnStart({ threadId: thread.id, input: [{ type: "text", text: "Compare examples.", text_elements: [] }],
      clientUserMessageId: "initial", model: "gpt-4.1", approvalPolicy: "never" });
    await until(() => releaseFirst, "first provider request");
    const accepted = await host.turnSteer({ threadId: thread.id, expectedTurnId: turn.id,
      input: [{ type: "text", text: marker, text_elements: [] }], clientUserMessageId: "steering-operation" });
    assert.equal(accepted.turnId, turn.id);
    assert(!JSON.stringify(requests[0].input).includes(marker), "an ACK cannot rewrite an inference request already in flight");
    releaseFirst();
    await until(() => events.some(event => event.type === "complete" && event.turnId === turn.id), "native completion after steering");
    const deliveredAt = requests.findIndex(body => JSON.stringify(body.input).includes(marker));
    assert(deliveredAt > 0, "accepted steering must eventually enter a subsequent model request");
    assert.equal(events.filter(event => event.type === "tool_start").length, 1, "steering never replays the completed command");
    assert.deepEqual(failures, []);
    const result = { passed: true, runtime: host.runtimeVersion, customResponsesProvider: true, compaction,
      requests: requests.length, firstSteeredRequest: deliveredAt + 1,
      compactions: events.filter(event => event.type === "context_compacted").length,
      commandExecutions: 1, acceptedBeforeModelRead: true, realAccountUsed: false };
    if (compaction) assert(result.compactions > 0, "the compaction scenario must exercise the native compactor");
    return result;
  } finally {
    await host?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  for (const compaction of [false, true]) results.push(await scenario(compaction));
  console.log(JSON.stringify({ passed: true, results }, null, 2));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
