#!/usr/bin/env node
"use strict";

// Run the bundled Codex against a local Responses fixture. The provider config
// is prepared through the normal writer, with only its network URL redirected.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { CodexRuntimeConfigWriter, providerConfigAlias } = require("../app/agent-service/codex-runtime-config");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { RuntimeAccountResolver, defaultRuntimeAccountLookup } = require("../app/agent-service/runtime-account-resolver");

const repoRoot = path.resolve(__dirname, "..");
const binding = { runtime: "codex", runtimeProfileId: "mimo-regression",
  runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID };
const provider = { id: "mimo-fixture", kind: "custom-responses", name: "MiMo fixture",
  baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", model: "mimo-v2.6-flash",
  credentialEnv: null, headers: null, awsRegion: null, awsProfile: null };
const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };

function writeResponse(res, index, output, inputTokens) {
  const response = { id: `resp-fixture-${index}`, object: "response" };
  let sequence = 0;
  const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({
    type, sequence_number: sequence++, ...fields,
  })}\n\n`);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  event("response.created", { response: { ...response, status: "in_progress", output: [] } });
  event("response.output_item.added", { output_index: 0, item: { ...output, status: "in_progress" } });
  if (output.type === "message") {
    const part = output.content[0];
    event("response.content_part.added", { item_id: output.id, output_index: 0, content_index: 0, part: { ...part, text: "" } });
    event("response.output_text.delta", { item_id: output.id, output_index: 0, content_index: 0, delta: part.text });
    event("response.output_text.done", { item_id: output.id, output_index: 0, content_index: 0, text: part.text });
    event("response.content_part.done", { item_id: output.id, output_index: 0, content_index: 0, part });
  }
  event("response.output_item.done", { output_index: 0, item: output });
  event("response.completed", { response: { ...response, status: "completed", output: [output],
    usage: { input_tokens: inputTokens, output_tokens: 100, total_tokens: inputTokens + 100 } } });
  res.end();
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-mimo-")));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const paths = resolveServicePaths({ trustedRoot: root, userDataRoot: path.join(root, "data"),
    cacheRoot: path.join(root, "cache") });
  const proxy = "http://127.0.0.1:9";
  const parentEnv = { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin",
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: "127.0.0.1" };
  const resolver = new RuntimeAccountResolver({ paths, repoRoot, parentEnv, homedir: root });
  const runtimeEnvironment = resolver.resolve(binding, defaultRuntimeAccountLookup(binding.runtimeAccountId));
  const writer = new CodexRuntimeConfigWriter({ paths });
  const requests = [];
  const marker = path.join(workspace, "escalated-command-ran");
  let callNext = false;
  let escalated = false;
  let sampleTokens = 559_714;
  let host;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      if (body.text?.format?.type === "json_schema") {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: {
          code: "responses_feature_not_supported", message: "json_schema is not supported by this fixture",
        } }));
        return;
      }
      const index = requests.length;
      const command = body.tools?.flatMap(tool => tool.tools ?? [tool]).find(tool => tool.name === "exec_command");
      if (callNext && command) {
        callNext = false;
        writeResponse(res, index, { id: `fc-fixture-${index}`, type: "function_call", call_id: `call-fixture-${index}`,
          name: command.name, arguments: JSON.stringify({
            cmd: escalated ? `/usr/bin/touch ${JSON.stringify(marker)}` : "/usr/bin/true", workdir: workspace,
            ...(escalated ? { sandbox_permissions: "require_escalated", justification: "Fixture approval" } : {}) }),
          status: "completed" }, sampleTokens);
      } else {
        writeResponse(res, index, { id: `msg-fixture-${index}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Local fixture finished.", annotations: [] }] }, 22_563);
      }
    } catch {
      res.writeHead(500).end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const runtimeConfig = { provider };
    const startHost = async () => {
      host = new CodexRuntimeHost({ paths, repoRoot, runtimeBinding: binding, runtimeEnvironment, parentEnv,
        prepareRuntime: async () => {
          const configured = writer.overlay({ ...binding, runtimeConfig });
          return { ...configured, runtimeConfig, spawnEnv: {}, registeredSecrets: [],
            configArgs: [...configured.args.map(value => value.replace(provider.baseUrl, baseUrl)),
              "-c", "mcp_servers.shoggoth.enabled=false"] };
        } });
      await host.start();
      return new CodexRuntimeAdapter({ runtimePool: { get: async () => host } }).acquire(binding);
    };
    const params = { cwd: workspace, persistent: true, model: provider.model,
      modelProvider: { kind: provider.kind, configId: providerConfigAlias(provider) }, permissionPolicy,
      permissionMode: "auto-review" };
    let handle = await startHost();
    const { session } = await handle.sessionStart(params);
    const turn = async (sessionId, prompt, permissionMode = params.permissionMode) => {
      const events = [];
      const dispose = handle.subscribe(event => {
        if (event.sessionId === sessionId) events.push(event);
      });
      try {
        const receipt = await handle.turnStart({ sessionId, prompt, operationId: prompt,
          permissionMode, permissionPolicy });
        const until = Date.now() + 15_000;
        while (!events.some(event => event.type === "complete" && event.turnId === receipt.turn.id)) {
          if (Date.now() >= until) throw new Error("Fixture turn did not finish");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return events.filter(event => event.turnId === receipt.turn.id);
      } finally { dispose(); }
    };
    callNext = true;
    const first = await turn(session.id, "First fixture turn");
    assert(first.some(event => event.type === "tool_result"), "fixture must execute one tool before final output");
    assert.equal(first.find(event => event.type === "complete").status, "completed");
    assert.equal(first.filter(event => event.type === "context_compacted").length, 0,
      "a 559,714-token response must not compact a 1M-window MiMo turn");
    assert(first.some(event => event.type === "context_usage" && event.contextUsage.contextWindow === 996_147),
      "the real runtime must report MiMo's effective window");
    assert.equal(requests.length, 2, "the fixture should sample only for the tool and final answer");
    const fallbackPrompt = fs.readFileSync(path.join(repoRoot, "app", "agent-service", "prompts", "codex-0.167.1-model-fallback.md"), "utf8");
    assert(JSON.stringify(requests[0]).includes(JSON.stringify(fallbackPrompt.trim()).slice(1, -1)),
      "the model catalog retains Codex's native instructions");

    await host.stop();
    handle = await startHost();
    await handle.sessionResume({ ...params, permissionMode: null, sessionId: session.id });
    const approvals = [];
    const dispose = handle.registerServerRequestHandler("item/commandExecution/requestApproval", async approval => {
      approvals.push(approval);
      return { decision: "decline" };
    });
    try {
      callNext = escalated = true;
      const second = await turn(session.id, "Resume existing fixture turn", null);
      assert.equal(second.find(event => event.type === "complete").status, "completed");
      assert(second.some(event => event.type === "context_usage" && event.contextUsage.contextWindow === 996_147));
      assert.equal(approvals.length, 1, "the incompatible reviewer must request the user's decision");
      assert.equal(approvals[0].threadId, session.id);
      assert.equal(fs.existsSync(marker), false, "the rejected command did not run");
      assert(!requests.some(request => request.text?.format?.type === "json_schema"), "no request to the incompatible reviewer");
    } finally { dispose(); }

    callNext = true;
    escalated = false;
    sampleTokens = 970_000;
    const third = await turn(session.id, "Fixture turn over the compaction threshold");
    assert.equal(third.find(event => event.type === "complete").status, "completed");
    assert(third.some(event => event.type === "context_compacted"), "a genuinely large MiMo turn still compacts");
    console.log("PASS real Codex: MiMo 1M context on new and resumed threads, genuine compaction and user approval fallback");
  } finally {
    try { await host?.stop(); } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
