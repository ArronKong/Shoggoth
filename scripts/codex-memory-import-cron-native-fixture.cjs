#!/usr/bin/env node
"use strict";

// Real bundled Codex + Service/Cron/Coordinator, with a local scripted model.
// All data, account configuration and tools stay in disposable directories.
// Proves normal Agent execution and native tool use; shared-memory write-back
// is a separate dependency, so the model reports that part as unavailable.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { DEFAULT_AGENT_PROFILE_ID: PROFILE } = require("../app/agent-service/product-store");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { resolveCodexRuntimeLayout } = require("../app/agent-service/codex-runtime-paths");
const { readCodexMemorySource } = require("../app/agent-service/codex-memory-source");
const { RETRY_DELAY_MS, RESULT_FAILED } = require("../app/agent-service/codex-memory-import-service");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { startProxyGateway } = require("../app/core/proxy-gateway");

const repoRoot = path.resolve(__dirname, "..");
const reportPreview = process.env.CODEX_IMPORT_REPORT_PREVIEW === "1";
const output = path.join(repoRoot, ".artifacts", reportPreview
  ? "codex-memory-import-report-20261005/native" : "codex-memory-import-cron-20261003");
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync("/private/tmp/sg-cmi-cron-");
const nativeHome = path.join(root, ".codex");
fs.mkdirSync(path.join(nativeHome, "memories"), { recursive: true, mode: 0o700 });
const source = path.join(nativeHome, "memories/MEMORY.md");
const original = "# Fixture user\n- Reply in Chinese.\n# Project Atlas\n- Uses SQLite.\n";
fs.writeFileSync(source, original);
const requests = [], toolResults = [], reports = [];
const evidence = { scope: "real Service/Cron/ChatSession/bundled Codex, local scripted Responses, synthetic notes, temporary Home, no login", verified: false, memoryWriteBackVerified: false };
let responseNumber = 0, completedTurns = 0;
const provider = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/__fixture/stop") {
    res.writeHead(200); res.end("stopping"); setImmediate(() => finish().catch(fail)); return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const request = JSON.parse(Buffer.concat(chunks)); requests.push(request);
      const outputs = (request.input || []).filter((item) => item.type === "function_call_output");
      const hasCurrentOutput = outputs.some((item) => item.call_id === `native-read-${completedTurns + 1}`);
      const tools = (request.tools || []).map((tool) => tool.name || tool.type);
      let item;
      if (!hasCurrentOutput) {
        const tool = request.tools.find((tool) => ["exec_command", "shell_command", "shell"].includes(tool.name));
        assert.ok(tool, `ordinary Agent file/shell tool missing: ${JSON.stringify(tools)}`);
        const cmd = `cat '${source}'`;
        const args = tool.name === "exec_command" ? { cmd, max_output_tokens: 300 }
          : tool.name === "shell_command" ? { command: cmd, timeout_ms: 10000 }
          : { command: ["/bin/cat", source], timeout_ms: 10000 };
        item = { id: `tool-${responseNumber}`, type: "function_call", name: tool.name,
          call_id: `native-read-${completedTurns + 1}`, arguments: JSON.stringify(args) };
      } else {
        const result = outputs.find((entry) => entry.call_id === `native-read-${completedTurns + 1}`);
        assert.ok(JSON.stringify(result).includes("Project Atlas"), JSON.stringify(result));
        toolResults.push(result); completedTurns++;
        const answer = `${RESULT_FAILED}\n已通过原生工具读完整合成 MEMORY.md（4 行）。当前共享记忆写回改造尚未接入；未写 USER.md/MEMORY.md。实际长期记忆写入验收仍待完成。`
          + (reportPreview ? "\n\n## 未保存的合成验收样例\n\n"
            + Array.from({ length: 150 }, (_, index) => `第 ${index + 1} 组示例：本段仅验证长报告的展示与回读。具体行为、证据、解释和协作含义应连贯呈现；分析结果不代表记忆已提交。\n\n`).join("")
            + "END_LONG_NATIVE_REPORT" : "");
        reports.push(answer);
        item = { id: `message-${responseNumber}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: answer, annotations: [] }] };
      }
      const id = `response-${++responseNumber}`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let sequence = 0;
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
      event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
      event("response.output_item.added", { output_index: 0, item: item.type === "message" ? { ...item, content: [] } : { ...item, arguments: "" } });
      if (item.type === "function_call") {
        event("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments });
        event("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: item.arguments });
      } else {
        const part = { item_id: item.id, output_index: 0, content_index: 0 };
        event("response.content_part.added", { ...part, part: { type: "output_text", text: "", annotations: [] } });
        event("response.output_text.delta", { ...part, delta: item.content[0].text });
        event("response.output_text.done", { ...part, text: item.content[0].text });
        event("response.content_part.done", { ...part, part: item.content[0] });
      }
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: { id, object: "response", status: "completed", output: [item],
        usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 } } });
      res.end();
    } catch (error) { res.writeHead(500); res.end("fixture rejected request"); fail(error); }
  });
});
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
  profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
const parentEnv = { HOME: root, CODEX_HOME: nativeHome, PATH: process.env.PATH, TMPDIR: root };
let service, pool, ui, backend, proxy, closing = false, clockOffset = 0;
const rpc = (method, params) => requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params });
const save = () => fs.writeFileSync(path.join(output, "native-cron-evidence.json"), JSON.stringify(evidence, null, 2));
async function readReport() {
  let text = "", pages = 0, cursor = 0, runId = null, expectedHash = null;
  do {
    const page = await rpc("harness.memory.import.report", { profileId: PROFILE, cursor, runId, expectedHash, limit: 8000 });
    assert.equal(page.reportedOutcome, "failed"); assert.equal(page.attempt, 2);
    assert.equal(page.text.isWellFormed(), true);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32 * 1024);
    text += page.text; pages++; cursor = page.nextCursor; runId = page.runId; expectedHash = page.reportHash;
  } while (cursor !== null);
  assert.equal(text, reports.at(-1));
  return { text, pages, hash: expectedHash };
}
function create() {
  pool = new CodexRuntimePool({ paths, repoRoot, parentEnv, homedir: root,
    binaryPath: resolveCodexRuntimeLayout({ repoRoot }).runtimePath,
    hostOptions: { repoRoot, packageVersion: "codex-import-cron-fixture", cwd: root },
    hostFactory: (options) => {
      fs.writeFileSync(path.join(options.runtimeEnvironment.home, "config.toml"), `model = "gpt-4.1"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local Cron fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nsupports_websockets = false\n`, { mode: 0o600 });
      return new CodexRuntimeHost(options);
    },
  });
  return createAgentService({ paths, runtimePool: pool, parentEnv, runtimeStorageHomedir: root, repoRoot,
    now: () => Date.now() + clockOffset,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    readCodexMemorySource: (name) => readCodexMemorySource(name, { hostHome: root }),
    codexMemoryImport: true, codexMemoryImportDelayMs: 20 });
}
async function waitFor(check) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) { if (closing) throw new Error("native fixture stopped");
    if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("native Cron fixture timed out");
}
async function finish() {
  if (closing) return; closing = true;
  try {
    await ui?.close(); await proxy?.close(); await backend?.stop(); await service?.stop(); await pool?.stopAll();
    const before = requests.length; service = create(); await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await service.codexMemoryImportService.run()).state, "abandoned");
    assert.equal(requests.length, before);
    evidence.restartNoDuplicate = true;
    if (reportPreview) {
      const report = await readReport();
      evidence.reportAfterRestart = { byteIdentical: report.text === reports.at(-1), pages: report.pages, hash: report.hash };
    }
    await service.stop(); await pool.stopAll(); evidence.cleanExit = true; save();
    console.log("PASS real Cron → WorkRun → ChatSession → Codex native tool → one retry; shared-memory write-back remains unverified");
  } finally { provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
}
async function fail(error) {
  if (closing) return;
  closing = true; process.exitCode = 1; evidence.error = { code: error.code || null, message: error.message }; save(); console.error(error);
  try { await ui?.close(); await proxy?.close(); await backend?.stop(); await service?.stop(); await pool?.stopAll(); } catch {}
  provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
}
(async () => {
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  service = create(); await service.start();
  await waitFor(() => service.codexMemoryImportService.status(PROFILE).state === "deferred");
  let status = service.codexMemoryImportService.status(PROFILE);
  assert.equal(status.reason, "MEMORY_IMPORT_TASK_FAILED"); assert.equal(status.task.attempts, 1);
  const job = service.nativeCronStore.getJob(status.task.jobId);
  clockOffset += RETRY_DELAY_MS + 100;
  await service.codexMemoryImportService.run();
  await waitFor(() => service.workDispatcher.listRuns({ source: "cron", sourceId: job.id }).every((run) => run.status === "failed")
    && service.workDispatcher.listRuns({ source: "cron", sourceId: job.id }).length === 2);
  status = await service.codexMemoryImportService.run();
  assert.equal(status.state, "abandoned"); assert.equal(completedTurns, 2); assert.equal(toolResults.length, 2);
  assert.equal(fs.readFileSync(source, "utf8"), original);
  assert.equal(service.memoryStore.list(PROFILE).length, 0);
  const sessions = (await rpc("chat.session.list", { profileId: PROFILE, includeArchived: false, cursor: null, limit: 100 })).sessions;
  const session = sessions.find((item) => item.cronJobId === job.id);
  assert.ok(session); assert.equal(session.cronRunIds.length, 2);
  const history = await rpc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 100 });
  assert.ok(JSON.stringify(history).includes(RESULT_FAILED));
  evidence.verified = true; evidence.status = status; evidence.nativeTools = requests[0].tools.map((tool) => tool.name || tool.type);
  evidence.nativeToolResults = toolResults.length; evidence.modelRequests = requests.length; evidence.cronSession = session.sessionKey;
  evidence.historyMessages = history.messages.length;
  evidence.userMemoryUnchanged = true;
  if (reportPreview) {
    const report = await readReport();
    assert.ok(report.pages > 1, "long report must exercise pagination");
    const transcriptSession = service.chatSessionStore.getSession(session.sessionKey);
    const display = service.transcriptStore.listEvents(PROFILE, transcriptSession.id)
      .filter((event) => event.kind === "assistant" && event.runId === status.task.runId).at(-1);
    assert.ok(display.content.contextRef, "native original answer uses the existing context content object");
    assert.ok(Buffer.byteLength(display.content.text) < Buffer.byteLength(report.text));
    assert.ok(!display.content.text.includes("END_LONG_NATIVE_REPORT"));
    evidence.report = { fullBytes: Buffer.byteLength(report.text), displayBytes: Buffer.byteLength(display.content.text),
      pages: report.pages, byteIdentical: true, hash: report.hash, existingContextRefUsed: true };
    fs.writeFileSync(path.join(output, "agent-report.md"), report.text);
  }
  if (process.env.CODEX_IMPORT_UI_PREVIEW === "1") {
    backend = new ShoggothBackend({ paths });
    assert.equal(await backend.start(), true, "isolated UI backend must actually connect");
    const registry = new BackendRegistry(); registry.register(backend);
    proxy = await startProxyGateway({ port: 0, registry, getUpstreamUrl: () => "" });
    ui = await startStaticServer(0, { registry, chatUpstreamUrl: proxy.url,
      authResolver: { getGatewayUrl: () => "", getGatewayGeneration: () => 0,
        resolveConnectAuth: () => { throw new Error("native-only preview must not read a Gateway identity"); } },
      homeDir: root, userDataRoot: path.join(root, "ui") });
    evidence.url = `${ui.url}/#/agents`; evidence.closeUrl = `http://127.0.0.1:${provider.address().port}/__fixture/stop`;
    if (reportPreview) {
      const main = (await backend.listAgents()).find((item) => item.id.endsWith(PROFILE));
      const response = await fetch(`${ui.url}/__api/agents/${encodeURIComponent(main.id)}/memory-import-report?backend=shoggoth`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.memoryImportReport.runId, status.task.runId);
      assert.equal(body.memoryImportReport.hasMore, true);
      evidence.httpReportVerified = true;
    }
    save(); console.log(`READY ${evidence.url}`);
  } else { save(); await finish(); }
})().catch(fail);
