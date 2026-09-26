#!/usr/bin/env node
"use strict";

// Real pinned Codex + local Responses SSE fixture. No login or real model request.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { CODEX_APP_SERVER_ARGS, resolveCodexRuntimeLayout, buildCodexSpawnEnv } = require("../app/agent-service/codex-runtime-paths");
const { resolveServicePaths } = require("../app/agent-service/paths");

const root = path.resolve(__dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-context-regression-"));
const home = path.join(scratch, "codex-home");
fs.mkdirSync(home);
const binding = { runtime: "codex", runtimeProfileId: "context-regression", runtimeAccountId: "shoggoth-internal-codex-default-v1" };
const captures = [];
let host;
let serial = 0;
let parallel = false;
const pendingResponses = [];
let concurrentRequests = 0;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url.includes("responses")) { res.writeHead(404); res.end(); return; }
    captures.push(JSON.parse(Buffer.concat(chunks).toString()));
    const respond = () => {
    const id = `fixture-${++serial}`;
    const item = { id: `msg-${serial}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Local fixture reply", annotations: [] }] };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let seq = 0;
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
    event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } });
    event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "Local fixture reply" });
    event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "Local fixture reply" });
    event("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response: { id, object: "response", status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
    };
    if (parallel) {
      pendingResponses.push(respond);
      if (pendingResponses.length === 2) {
        concurrentRequests = pendingResponses.length;
        parallel = false;
        for (const send of pendingResponses.splice(0)) send();
      }
    } else respond();
  });
});
const policy = version => `SHOGGOTH_POLICY_${version}. This is a local fixture; do not call tools.`;
const developerTexts = body => body.input.filter(item => item.role === "developer")
  .map(item => JSON.stringify(item));

async function runtime() {
  const binary = resolveCodexRuntimeLayout({ repoRoot: root }).runtimePath;
  const paths = resolveServicePaths({ trustedRoot: scratch, stateRoot: path.join(scratch, "state"), cacheRoot: path.join(scratch, "cache") });
  let capturedSpawn = false;
  host = new CodexRuntimeHost({ repoRoot: root, paths, runtimeBinding: binding, cwd: scratch,
    parentEnv: { HOME: scratch, PATH: process.env.PATH, TMPDIR: scratch,
      HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "127.0.0.1,localhost",
      SECRET_CANARY: "must-not-inherit" },
    runtimeEnvironment: Object.freeze({
      runtime: "codex", runtimeAccountId: binding.runtimeAccountId, kind: "shoggoth-managed",
      installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared", home,
      nativeHome: null, integrationRoot: null, binaryPath: binary,
      launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]), spawnEnv: Object.freeze({ HOME: scratch, CODEX_HOME: home }), configurationMode: "overlay",
    }),
    spawnProcess(command, args, options) {
      assert.equal(options.env.https_proxy, "http://127.0.0.1:7897");
      assert.equal(options.env.NO_PROXY, "127.0.0.1,localhost");
      assert.equal(options.env.no_proxy, options.env.NO_PROXY);
      assert.equal(options.env.SECRET_CANARY, undefined);
      assert.equal(options.env.CODEX_HOME, home);
      capturedSpawn = true;
      const child = spawn(command, args, options);
      // Only this isolated CLI talks to a local fixture with synthetic data.
      // Keep native rejection details for transport diagnosis, never payloads.
      let nativeOutput = "";
      child.stdout.on("data", chunk => {
        nativeOutput += chunk.toString();
        for (;;) {
          const end = nativeOutput.indexOf("\n");
          if (end < 0) break;
          const line = nativeOutput.slice(0, end); nativeOutput = nativeOutput.slice(end + 1);
          try { const error = JSON.parse(line).error; if (error) console.error("Local fixture native rejection:", String(error.message).slice(0, 1000)); } catch {}
        }
      });
      return child;
    },
  });
  await host.start();
  assert.equal(capturedSpawn, true);
  return new CodexRuntimeAdapter({ runtimePool: { get: async () => host } }).acquire(binding);
}

async function turn(handle, id, prompt, context) {
  const events = [];
  const unsubscribe = host.subscribe(event => events.push(event));
  try {
    const receipt = await handle.turnStart({ sessionId: id, prompt, operationId: `op-${serial}-${Date.now()}`,
      ...(context ? { context } : {}),
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
    const until = Date.now() + 10000;
    while (!events.some(event => event.method === "turn/completed" && event.turnId === receipt.turn.id)) {
      if (Date.now() > until) throw new Error("Local fixture completion timeout");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(events.find(event => event.method === "turn/completed" && event.turnId === receipt.turn.id).status, "completed");
    return captures.at(-1);
  } finally { unsubscribe(); }
}

(async () => {
  // Invalid/conflicting proxy input must fail without inheriting extra secrets.
  for (const parentEnv of [{ HTTPS_PROXY: "http://user:secret@localhost:1234" },
    { HTTPS_PROXY: "http://localhost:1", https_proxy: "http://localhost:2" },
    { NO_PROXY: "localhost\nBAD=1" }]) {
    assert.throws(() => buildCodexSpawnEnv({ codexHome: home, parentEnv }), { code: "CODEX_SPAWN_ENV_INVALID" });
  }
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const largeContext = process.argv.includes("--large-context");
  fs.writeFileSync(path.join(home, "config.toml"), `model = "gpt-5.6-sol"\nmodel_provider = "fixture"\n${largeContext ? "model_context_window = 1050000\nmodel_auto_compact_token_limit = 900000\n" : ""}[model_providers.fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nsupports_websockets = false\n`);
  let handle = await runtime();
  const first = await handle.sessionStart({ cwd: scratch, developerInstructions: policy("OLD"),
    permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
  await turn(handle, first.session.id, "Remember this first user message.");
  await host.stop();
  handle = await runtime();
  await handle.sessionResume({ sessionId: first.session.id, cwd: scratch, developerInstructions: policy("NEW") });
  const resumed = await turn(handle, first.session.id, "Second user message.");
  const dev = developerTexts(resumed);
  assert.match(dev.at(-1), /SHOGGOTH_POLICY_NEW/u);
  assert.match(dev.at(-1), /supersede earlier Shoggoth developer instructions/u);
  assert.match(JSON.stringify(resumed.input), /Remember this first user message/u);
  await handle.sessionResume({ sessionId: first.session.id, developerInstructions: policy("NEW") });
  const next = await turn(handle, first.session.id, "Third user message.");
  assert.equal(developerTexts(next).filter(text => text.includes("SHOGGOTH_POLICY_NEW")).length, 1);
  const fresh = await handle.sessionStart({ cwd: scratch, developerInstructions: policy("FRESH") });
  const freshBody = await turn(handle, fresh.session.id, "Fresh user message.");
  assert.equal(JSON.stringify(freshBody).includes("SHOGGOTH_POLICY_NEW"), false);
  assert.equal(developerTexts(freshBody).filter(text => text.includes("SHOGGOTH_POLICY_FRESH")).length, 1);
  const concurrent = await Promise.all(["A", "B"].map(label => handle.sessionStart({ cwd: scratch,
    developerInstructions: policy(`CONCURRENT_${label}`) })));
  parallel = true;
  await Promise.all(concurrent.map(({ session }, index) => turn(handle, session.id, `Parallel request ${index}`)));
  assert.equal(concurrentRequests, 2, "the same Codex host must submit both sessions before either response completes");
  if (largeContext) {
    const original = "ORIGINAL_START\n" + "ordinary context words ".repeat(100000) + "\nORIGINAL_END";
    assert.ok(Buffer.byteLength(original) > 2 * 1024 * 1024);
    const large = await handle.sessionStart({ cwd: scratch, developerInstructions: policy("LARGE_CONTEXT") });
    const before = captures.length;
    await assert.rejects(turn(handle, large.session.id, "Confirm receipt of the supplied data.", original), { code: "RPC_REMOTE_ERROR", rpcCode: -32602 });
    assert.equal(captures.length, before, "the CLI rejects an oversized user input before model execution");
    const fitting = "ORIGINAL_START\n" + "ordinary context words ".repeat(40000) + "\nORIGINAL_END";
    const received = await turn(handle, large.session.id, "Confirm receipt of the supplied data.", fitting);
    assert.ok(JSON.stringify(received.input).includes(JSON.stringify(fitting).slice(1, -1)), "fitting input arrives without truncation");
    console.log(`PASS real Codex: verified 1048576-character input guard, no model call on rejection, ${Buffer.byteLength(fitting)} bytes arrived intact; remote capacity is not measured`);
  }
  console.log("PASS real Codex: proxy inheritance, resumed developer policy, retained history, no repeated injection, separate and concurrent sessions");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await host?.stop(); } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
