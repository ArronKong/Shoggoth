"use strict";
// Real pinned Codex app-server against a scripted local Responses endpoint.
// No login, production Home, external provider or user thread is accessed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = require("../app/agent-service/codex-runtime-paths");
const { readCodexPaginatedThread } = require("../app/agent-service/codex-thread-history-reader");
const root = fs.realpathSync(fs.mkdtempSync("/tmp/shg-context-input-"));
const home = path.join(root, "codex"), workspace = path.join(root, "workspace");
fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
const requests = [], completed = new Set();
let host, failure;
const provider = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    try {
      assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/responses");
      requests.push(JSON.parse(Buffer.concat(chunks)));
      const id = `response-${requests.length}`, item = { id: `message-${requests.length}`,
        type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "ISOLATED_CONTEXT_REPLY", annotations: [] }] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let sequence = 0;
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type,
        sequence_number: sequence++, ...data })}\n\n`);
      event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: { id, object: "response", status: "completed", output: [item],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } });
      res.end();
    } catch (error) { failure = error; res.writeHead(500); res.end("fixture failure"); }
  });
});
async function waitForTurn(id) {
  const deadline = Date.now() + 30_000;
  while (!completed.has(id)) {
    if (failure) throw failure;
    assert.ok(Date.now() < deadline, "isolated native turn must complete");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
(async () => {
  try {
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    fs.writeFileSync(path.join(home, "config.toml"), `model = "gpt-4.1"
model_provider = "fixture"
[model_providers.fixture]
name = "Isolated fixture"
base_url = "http://127.0.0.1:${provider.address().port}/v1"
wire_api = "responses"
supports_websockets = false
`, { mode: 0o600 });
    const repoRoot = path.resolve(__dirname, ".."), binding = { runtime: "codex",
      runtimeAccountId: "context-fixture", runtimeProfileId: "context-fixture" };
    const runtimeEnvironment = Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId,
      kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared",
      home, nativeHome: null, integrationRoot: null,
      binaryPath: resolveCodexRuntimeLayout({ repoRoot }).runtimePath,
      launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]),
      spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: home }), configurationMode: "overlay" });
    host = new CodexRuntimeHost({ paths: resolveServicePaths({ trustedRoot: root, userDataRoot: root,
      cacheRoot: path.join(root, "cache") }), repoRoot, runtimeBinding: binding, runtimeEnvironment,
      packageVersion: "context-input-fixture", cwd: workspace, parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root } });
    host.subscribe(event => {
      if (event.type === "complete") {
        if (event.status !== "completed") failure = new Error("native turn failed");
        completed.add(event.turnId);
      }
      if (event.type === "error" && event.severity !== "warning" && !event.willRetry) failure = new Error(JSON.stringify(event));
    });
    await host.initialize();
    const handle = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host } }).acquire(binding);
    const { session } = await handle.sessionStart({ source: "context-fixture", cwd: workspace,
      model: "gpt-4.1", developerInstructions: "Trusted fixture policy", permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
    const prompts = ["帮我打开这个文件夹", "第二条原文 CURRENT USER REQUEST 也要保留"];
    for (let index = 0; index < prompts.length; index++) {
      if (index) await handle.sessionResume({ sessionId: session.id, cwd: workspace,
        developerInstructions: "Updated trusted fixture policy", permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
      const context = `BEGIN UNTRUSTED ENABLED SKILL CATALOG DATA\nISOLATED_CONTEXT_${index}\nEND UNTRUSTED ENABLED SKILL CATALOG DATA`;
      const started = await handle.turnStart({ sessionId: session.id, operationId: `context-input-${index}`,
        prompt: prompts[index], context, cwd: workspace, model: "gpt-4.1", thinkingLevel: "low",
        permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
      await waitForTurn(started.turn.id);
      const input = requests.at(-1).input;
      const contextItem = input.find(item => JSON.stringify(item.content).includes(`ISOLATED_CONTEXT_${index}`));
      assert.equal(contextItem?.role, "user", "dynamic context must keep user authority");
      assert.ok(contextItem.content.some(part => part.text === context), "provider must receive the exact frozen context");
      const promptItem = input.find(item => item.content?.some(part => part.text === prompts[index]));
      assert.equal(promptItem?.role, "user"); assert.notEqual(contextItem, promptItem);
    }
    await handle.sessionResume({ sessionId: session.id, cwd: workspace, developerInstructions: "Updated trusted fixture policy" });
    const metadata = await host.threadRead({ threadId: session.id, includeTurns: false });
    const history = await readCodexPaginatedThread(host, metadata);
    const users = history.thread.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage");
    assert.deepEqual(users.map(item => item.content.filter(part => part.type === "text").map(part => part.text).join("\n")), prompts);
    assert.deepEqual(users.map(item => item.clientId), ["context-input-0", "context-input-1"]);
    console.log(JSON.stringify({ verified: true, actualNativeCli: host.runtimeVersion, localProviderTurns: requests.length,
      pureNativeUserMessages: users.length, contextReceivedAtUserAuthority: true,
      resumeHistoryVerified: true, realProviderTurns: 0, productionHomeWrites: 0 }));
  } finally {
    if (host) await host.stop();
    await new Promise(resolve => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
