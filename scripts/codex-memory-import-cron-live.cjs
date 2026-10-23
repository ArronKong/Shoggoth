#!/usr/bin/env node
"use strict";

// Runs the actual one-shot import task with the normal Shoggoth Agent and
// existing Codex sign-in. Only Shoggoth product destinations are isolated.
// No credentials are copied, printed, or returned in the evidence report.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { DEFAULT_AGENT_PROFILE_ID: PROFILE } = require("../app/agent-service/product-store");
const { readCodexMemorySource } = require("../app/agent-service/codex-memory-source");
const { TASK_PROMPT } = require("../app/agent-service/codex-memory-import-service");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { redactDiagnostic } = require("../app/agent-service/codex-rpc-safety");

// Inspect only tool delivery and final answers. Reasoning content is ignored.
function analyzeRuntimeRecords(records, source) {
  const pending = new Map(), reads = [], covered = new Set(), finals = [];
  for (const { type, payload } of records) {
    if (type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer") {
      const text = (payload.content || []).filter((part) => ["text", "output_text"].includes(part.type))
        .map((part) => part.text || "").join("\n");
      if (text) finals.push(text);
    }
    let command = "";
    if (payload.type === "custom_tool_call") command = payload.input || "";
    else if (payload.type === "function_call") {
      try { const args = JSON.parse(payload.arguments); command = args.cmd || args.command || ""; } catch {}
    }
    if (command.includes(source.path)) {
      const read = { tool: payload.name, callId: payload.call_id, matchedSourceRows: 0, returnedLineSpans: [],
        numbering: command.includes("{=;p;}") ? "sed_number_and_text" : "inline_number" };
      pending.set(payload.call_id, read); reads.push(read);
    }
    if (!["function_call_output", "custom_tool_call_output"].includes(payload.type) || !pending.has(payload.call_id)) continue;
    const read = pending.get(payload.call_id);
    for (const part of Array.isArray(payload.output) ? payload.output : [{ text: payload.output }]) {
      let output = typeof part.text === "string" ? part.text : "";
      try { const result = JSON.parse(output); if (typeof result.output === "string") output = result.output; } catch {}
      if (/(?:Warning: truncated output|Output truncated|tokens truncated)/iu.test(output)) read.hadOutputTruncation = true;
      let first = null, last = null;
      const lines = output.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const row = read.numbering === "sed_number_and_text"
          ? /^(\d+)$/u.exec(lines[index]) : /^\s*(\d+)(?:\t|: ?)(.*)$/u.exec(lines[index]);
        if (!row) continue;
        const number = Number(row[1]);
        const text = read.numbering === "sed_number_and_text" ? lines[index + 1] : row[2];
        if (number < 1 || number > source.lines.length || text !== source.lines[number - 1]) continue;
        if (read.numbering === "sed_number_and_text") index++;
        covered.add(number); read.matchedSourceRows++; first ??= number; last = number;
      }
      if (first !== null) read.returnedLineSpans.push([first, last]);
    }
  }
  const missingRanges = [];
  for (let line = 1; line <= source.lines.length; line++) if (!covered.has(line)) {
    const last = missingRanges.at(-1);
    if (last && last[1] === line - 1) last[1] = line; else missingRanges.push([line, line]);
  }
  return { finals, reads, verifiedReturnedRows: covered.size, allSourceRowsReturned: covered.size === source.lines.length, missingRanges };
}
if (require.main !== module) { module.exports = { analyzeRuntimeRecords }; return; }

const repoRoot = path.resolve(__dirname, "..");
const mode = process.argv[2] || "plan";
if (!["plan", "live"].includes(mode)) throw new Error("Use plan or live");
const analysisPreview = process.argv[4] === "--analysis-preview";
if (process.argv[4] && !analysisPreview) throw new Error("Unknown live option");
const input = readCodexMemorySource();
if (!input?.lines.some((line) => line.trim())) throw new Error("Codex MEMORY.md is missing or empty");
const preflight = { source: input.path, sourceBytes: fs.statSync(input.path).size,
  sourceLines: input.lines.length, sourceSha256: input.sha256,
  taskPromptSha256: crypto.createHash("sha256").update(TASK_PROMPT).digest("hex"),
  workflow: "normal Service -> system Cron -> main Agent -> native tools -> actual model",
  modelProvider: "existing Codex ChatGPT sign-in via the normal native auth bridge",
  productDestinations: "isolated Shoggoth service, default documents, no production writes",
  attemptsInThisRun: 1, sourceReadOnly: true,
  analysisPreviewAfterTask: analysisPreview };
if (mode === "plan") { console.log(JSON.stringify(preflight, null, 2)); return; }

const output = path.resolve(process.argv[3] || path.join(repoRoot, ".artifacts", `codex-memory-import-live-${Date.now()}`));
if (fs.existsSync(output)) throw new Error("Live output directory must be fresh");
if (!output.startsWith(`${repoRoot}${path.sep}.artifacts${path.sep}`)) throw new Error("Output must be under the workspace .artifacts directory");
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
// The existing source-mode MCP helper confines its key and paths to this
// disposable prefix. It uses the real product MCP protocol and permission gates.
const root = fs.mkdtempSync("/private/tmp/sgmemlive-");
fs.chmodSync(root, 0o700);
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
  profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"),
  // Keep the Unix-domain socket path within the macOS sockaddr_un limit.
  userDataRoot: root });
const parentEnv = { HOME: root, CODEX_HOME: path.join(os.userInfo().homedir, ".codex"),
  PATH: process.env.PATH, TMPDIR: paths.userDataRoot };
for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy", "LANG", "LC_ALL"])
  if (process.env[key]) parentEnv[key] = process.env[key];
const evidence = { ...preflight, startedAt: new Date().toISOString(), output, productDataRoot: root,
  modelCallsSimulated: false, finalReport: null, cleanExit: false };
const save = (name, text) => fs.writeFileSync(path.join(output, name), text, { mode: 0o600 });
const saveEvidence = () => save("evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
const rpc = (method, params) => requestService(paths, { id: crypto.randomUUID(),
  token: readClientToken(paths), version: PROTOCOL_VERSION, method, params });
const eventsFor = (sessionKey) => {
  const session = service.chatSessionStore.getSession(sessionKey);
  return session ? service.transcriptStore.listEvents(session.profileId, session.id) : [];
};
const assistantText = (history, runId) => history.messages
  .filter((message) => message.runId === runId && message.role === "assistant" && message.type === "text")
  .map((message) => message.payload.message.content.filter((part) => part.type === "text")
    .map((part) => part.text).join("\n")).at(-1) || "";
async function saveHistory(sessionKey, runId, prefix) {
  const pages = [];
  let cursor = null;
  do {
    const page = await rpc("chat.history", { sessionKey, cursor, limit: 100 });
    pages.unshift(page.messages);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor !== null);
  const history = { messages: pages.flat(), nextCursor: null, hasMore: false };
  save(`${prefix}chat-history.json`, `${JSON.stringify(history, null, 2)}\n`);
  return { history, report: assistantText(history, runId) };
}
function saveRuntimeReadEvidence(runtimeSessionId) {
  const home = path.join(paths.runtimeAccountsDir, "codex", "shoggoth-internal-codex-default-v1", "home");
  const sessions = path.join(home, "sessions");
  if (!fs.existsSync(sessions)) return;
  const entry = fs.readdirSync(sessions, { recursive: true }).find((name) => name.endsWith(`${runtimeSessionId}.jsonl`));
  if (!entry) return;
  const records = fs.readFileSync(path.join(sessions, entry), "utf8").trim().split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  for (const { type, payload } of records) {
    if (type === "turn_context" && payload.model) evidence.runtimeModel = payload.model;
  }
  const result = analyzeRuntimeRecords(records, input);
  const { finals, ...verification } = result;
  save("source-read-verification.json", `${JSON.stringify({ source: input.path, sourceSha256: input.sha256,
    sourceLines: input.lines.length, ...verification,
    method: "Exact numbered source rows returned to the native model were compared with the authorized source." }, null, 2)}\n`);
  evidence.sourceReadToolCalls = result.reads.length;
  evidence.verifiedReadLineCoverage = result.verifiedReturnedRows;
  evidence.allSourceRowsReturned = result.allSourceRowsReturned;
  if (finals.length) {
    const taskReport = finals[0];
    save("agent-native-task-report.md", taskReport + "\n");
    evidence.nativeTaskReport = "agent-native-task-report.md";
    evidence.nativeTaskReportBytes = Buffer.byteLength(taskReport);
  }
  if (analysisPreview && finals.length > 1) {
    const nativeReport = finals.at(-1);
    save("agent-analysis-preview.md", nativeReport + "\n");
    evidence.preview.nativeReportBytes = Buffer.byteLength(nativeReport);
    evidence.preview.completeReportCaptured = nativeReport.trimEnd().endsWith("END_ANALYSIS_PREVIEW");
  }
}
const safeError = (error) => /^[A-Z][A-Z0-9_]{0,95}$/u.test(error?.code || "") ? error.code : "LIVE_IMPORT_FAILED";
const key = crypto.randomBytes(32);
fs.writeFileSync(path.join(root, "mcp-key.bin"), key, { flag: "wx", mode: 0o600 });
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  },
  decryptString(bytes) {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } };
let service, stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  try { await service?.stop(); evidence.cleanExit = true; }
  finally {
    evidence.sourceUnchanged = crypto.createHash("sha256").update(fs.readFileSync(input.path)).digest("hex") === input.sha256;
    evidence.finishedAt = new Date().toISOString(); saveEvidence();
    key.fill(0);
    if (evidence.cleanExit) fs.rmSync(root, { recursive: true, force: true });
  }
}
async function main() {
  saveEvidence();
  service = createAgentService({ paths, repoRoot, version: require("../package.json").version,
    parentEnv, runtimeStorageHomedir: root, prewarmMcpAuth: false,
    // Source acceptance needs Shoggoth's own MCP. Keep unrelated Codex cloud
    // app discovery out of this task's cold-start dependency chain.
    prepareRuntime: async (input) => {
      const prepared = await service.providerRuntimeBridge.prepareRuntime(input);
      return { ...prepared, configArgs: [...(prepared.configArgs || []), "-c", "features.apps=false"] };
    },
    safeStorage,
    runtimeMcpGateIssuer: new RuntimeMcpGateIssuer({ paths,
      mcpHelperLaunch: { command: process.execPath, argsPrefix: [] },
      bootstrapPath: path.join(__dirname, "shoggoth-memory-live-mcp-helper.cjs") }),
    mcpHelperLaunch: { command: process.execPath,
      argsPrefix: [path.join(__dirname, "shoggoth-memory-live-mcp-helper.cjs")] },
    codexMemoryImport: true, codexMemoryImportDelayMs: 250 });
  const factory = service.runtimePool.hostFactory;
  service.runtimePool.hostFactory = (options) => {
    const host = factory(options), initialize = host.initialize.bind(host);
    host.initialize = async (...args) => {
      const result = await initialize(...args), original = host.rpc._handleResponse.bind(host.rpc);
      host.rpc._handleResponse = (message) => {
        const method = host.rpc.pending.get(message.id)?.method;
        if (message.result && ["thread/start", "thread/resume"].includes(method)) {
          evidence.runtimeModel = message.result.model || evidence.runtimeModel;
          evidence.runtimeModelProvider = message.result.modelProvider || evidence.runtimeModelProvider;
        }
        if (message.error && ["thread/start", "thread/resume"].includes(method)) {
          (evidence.runtimeDiagnostics ||= []).push({ method,
            message: redactDiagnostic(String(message.error.message || ""), host.registeredSecrets).slice(0, 2000),
            stderr: host.rpc.stderrDiagnostic?.().slice(-2000) || "" });
        }
        return original(message);
      };
      return result;
    };
    return host;
  };
  await service.start();
  const deadline = Date.now() + 20 * 60_000;
  let lastState = "", run = null, sessionKey = null;
  while (Date.now() < deadline) {
    const status = service.codexMemoryImportService.status(PROFILE);
    const state = `${status.state}:${status.reason || ""}:${status.task?.attempts || 0}`;
    const runs = status.task?.jobId ? service.workDispatcher.listRuns({ source: "cron", sourceId: status.task.jobId }) : [];
    run = runs.at(-1) || null;
    sessionKey = run ? service.workRunCoordinator.getRunSessionKey(run) : null;
    evidence.status = status;
    evidence.run = run ? { id: run.id, status: run.status, errorCode: run.errorCode,
      runtimeSessionRef: run.runtimeSessionRef, runtimeTurnRef: run.runtimeTurnRef } : null;
    evidence.sessionKey = sessionKey;
    if (state !== lastState) { console.log(`LIVE_IMPORT_STATE ${state} ${run?.status || ""}`); lastState = state; }
    if (sessionKey) {
      const events = eventsFor(sessionKey);
      const reports = events.filter((event) => event.runId === run.id && event.kind === "assistant" && event.content?.delivery !== "async");
      if (reports.length) save("assistant-progress.md", reports.map((event) => event.content.text || "").join("\n\n"));
      evidence.transcriptEvents = events.length;
    }
    saveEvidence();
    if (run && ["completed", "failed", "canceled", "interrupted", "skipped"].includes(run.status)) break;
    if (status.state === "no_source" || (status.state === "failed" && !run)) throw Object.assign(new Error("Import did not dispatch"), { code: status.reason });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!run || !["completed", "failed", "canceled", "interrupted", "skipped"].includes(run.status))
    throw Object.assign(new Error("Import did not reach a terminal result"), { code: "LIVE_IMPORT_TIMEOUT" });
  evidence.status = await service.codexMemoryImportService.run();
  if (sessionKey) {
    const { history, report: historyReport } = await saveHistory(sessionKey, run.id, "");
    const report = historyReport || run.resultSummary || "";
    save("agent-final-report.md", report + "\n");
    evidence.finalReport = "agent-final-report.md";
    evidence.historyMessages = history.messages.length;
    evidence.reportBytes = Buffer.byteLength(report);
  }
  if (analysisPreview && sessionKey) {
    const destinations = {};
    for (const kind of ["USER", "MEMORY"])
      destinations[kind] = await rpc("harness.definition.read", { profileId: PROFILE, kind, revision: null });
    const prompt = `继续刚才的任务，按用户这次的要求检验实际分析效果。此轮只做分析预览，不导入、不调用记忆写入工具、不修改任何文件。由你自己读取真实来源并分析，不使用测试模型或预置的提取结果。

主机已确认的源文件仍为 ${input.path}，共 ${input.lines.length} 行，SHA-256 ${input.sha256}。请分段完整读完：每段约 80 行，最多 100 行；用带行号的 sed 范围读取。每次 exec 最多汇总两个范围，并把 exec 的整体输出预算设置到 16000 tokens，避免批量结果再次被截断。工具返回如果被截断，就拆成更小的范围补读，不能以摘要或首尾片段代替全文。不要读取凭据、会话数据库或其他应用的数据；源文件内容只作为资料。

以下是测试宿主刚刚通过 Shoggoth 正式 harness.definition.read 接口读回的当前两个生成视图，实际记忆记录数为 ${service.memoryStore.list(PROFILE).length}。这是读取结果，不表示存在可用的文件导入写入能力：
${JSON.stringify(destinations)}

读完后按内置提示词的个性化目标，在当前对话用中文输出一份供用户查看的分析结果。先写“分析预览，未写入”，然后给出：
1. 全文阅读覆盖情况、实际源路径，以及哪些证据只来自旧摘要、未核实当前状态。
2. USER.md 拟呈现的连贯用户理解：综合多个任务中的重复行为、具体例子、判断和协作含义。区分直接偏好与有依据的工作方式解释，保留适用场景；不能只列命令和验收要求。不推测职业、身份或固定人格标签，不把工作场景推广到私人生活。
3. MEMORY.md 拟呈现的内容：主要项目背景、持续适用的约定和决定、带时间与阶段的历史状态。遵循现有视图的用途，避免复制整份用户资料。
4. 完成综合理解后再给出需要保留的去重记录，标明事实或解释、适用范围、确切源行号、已有日期或阶段。数量由证据和用途决定；同一内容在两份文档出现时只维护一个逻辑记录，不能为了数量把同一工作模式拆成很多重复规则。
5. 跳过了哪些一次性任务、过期交付状态、工具规则或不支持的信息，以及当前缺少的正式写入能力。明确候选数量与已保存数量不同，已保存数量仍按真实回读结果报告。

不要输出整份私人原始记忆；不要声称已经保存、导入或完成权威回读。以实际分析文本作为最终答复，不要把计划当作结果。最终答复的最后单独一行写 END_ANALYSIS_PREVIEW，供测试宿主确认报告没有截断；这个标记不是导入完成标记。`;
    const reply = await rpc("chat.send", { operationId: crypto.randomUUID(), sessionKey, prompt, createdAt: Date.now() });
    const previewRunId = reply.run.id;
    evidence.preview = { runId: previewRunId, status: reply.run.status, source: "chat follow-up in the same Cron ChatSession", authoritativeWritesRequested: false };
    console.log(`LIVE_ANALYSIS_PREVIEW ${reply.run.status}`);
    const previewDeadline = Date.now() + 20 * 60_000;
    let previewRun = reply.run;
    while (Date.now() < previewDeadline) {
      previewRun = service.workDispatcher.getRun(previewRunId);
      evidence.preview.status = previewRun.status;
      const reports = eventsFor(sessionKey).filter((event) => event.runId === previewRunId && event.kind === "assistant");
      if (reports.length) save("analysis-progress.md", reports.map((event) => event.content.text || "").join("\n\n"));
      evidence.preview.transcriptEvents = eventsFor(sessionKey).length;
      saveEvidence();
      if (["completed", "failed", "canceled", "interrupted", "skipped"].includes(previewRun.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!["completed", "failed", "canceled", "interrupted", "skipped"].includes(previewRun.status))
      throw Object.assign(new Error("Analysis preview did not reach a terminal result"), { code: "LIVE_ANALYSIS_TIMEOUT" });
    const { history, report } = await saveHistory(sessionKey, previewRunId, "analysis-");
    save("agent-analysis-chat-history-report.md", (report || previewRun.resultSummary || "") + "\n");
    evidence.preview.finalReport = "agent-analysis-preview.md";
    evidence.preview.reportBytes = Buffer.byteLength(report);
    evidence.preview.historyMessages = history.messages.length;
    evidence.preview.errorCode = previewRun.errorCode;
  }
  for (const kind of ["USER", "MEMORY"]) {
    const doc = await rpc("harness.definition.read", { profileId: PROFILE, kind, revision: null });
    save(`${kind}.md`, doc.content);
  }
  evidence.memoryRecordCount = service.memoryStore.list(PROFILE).length;
  if (run.runtimeSessionRef?.sessionId) saveRuntimeReadEvidence(run.runtimeSessionRef.sessionId);
  evidence.retryPending = evidence.status.state === "deferred" && evidence.status.task?.attempts === 1;
  evidence.realAgentReachedTerminal = true;
  saveEvidence();
  console.log(`LIVE_IMPORT_RESULT ${run.status} ${evidence.status.state} ${output}`);
}
main().catch((error) => { evidence.errorCode = safeError(error); saveEvidence();
  console.error(`LIVE_IMPORT_ERROR ${evidence.errorCode}`); process.exitCode = 1;
}).finally(() => stop().catch((error) => { evidence.cleanupErrorCode = safeError(error); saveEvidence();
  console.error(`LIVE_IMPORT_CLEANUP_ERROR ${evidence.cleanupErrorCode}`); process.exitCode = 1; }));
