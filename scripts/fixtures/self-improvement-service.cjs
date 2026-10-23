"use strict";
// Full local Service/Coordinator/Codex adapter/Backend/REST. Only the native
// wire peer is synthetic; its tool transcript and completion are persisted by
// the production path. No real Provider, account or task data is used.
const assert = require("node:assert/strict");
const path = require("node:path");
const { openHandoffFixture } = require("./runtime-handoff-service.cjs");
const { ShoggothBackend } = require("../../app/core/shoggoth-backend");
const { BackendRegistry } = require("../../app/core/backend-registry");
const { startStaticServer } = require("../../app/static-server");

async function openLearningFixture() {
  let clock = Date.now();
  const f = await openHandoffFixture({ validateHandles: true, serviceOptions: { now: () => clock } });
  const backend = new ShoggothBackend({ paths: f.paths }); backend._state = "started";
  await backend._refreshManagedProfiles();
  const registry = new BackendRegistry(); registry.register(backend);
  const server = await startStaticServer(0, { registry, homeDir: f.root, userDataRoot: path.join(f.root, "ui") });
  const models = [], isolatedSessions = new Set(), released = [], reviewPrompts = [];
  const request = async (action, input = {}, agentId = f.profile.agentId) => {
    const response = await fetch(`${server.url}/__api/skills/learning`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify({ backend: "shoggoth", agentId, action, input }) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (action, input = {}) => {
    const response = await request(action, input);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.result;
  };
  const session = f.createSession();
  const run = await f.send(session.sessionKey, "learning-source-task", "以后先核对实际构建配置，再验证最终产物。");
  assert.equal(run.status, "running", run.errorCode);
  const raw = f.transport.hosts.get("codex");
  raw.emit({ known: true, type: "tool_result", method: "item/completed", threadId: run.runtimeSessionRef.sessionId,
    turnId: run.runtimeTurnRef.turnId, itemId: "learning-build-check", toolCallId: "learning-build-check",
    tool: { kind: "commandExecution", status: "completed", exitCode: 0,
      output: [{ type: "content", content: { type: "text", text: "verified configuration and build artifact: passed" } }] } });
  await f.complete(run, "构建配置和最终产物均已验证，检查通过。");
  const events = f.service.transcriptStore.listEvents(f.profile.id, session.id).filter(event => event.runId === run.id);
  const evidence = [events.find(event => event.kind === "user"), events.find(event => event.kind === "tool_result")]
    .map(event => { assert.ok(event, "production transcript evidence exists"); return { runId: run.id, eventId: event.id }; });
  raw.configRead = async () => ({ config: { mcp_servers: { shoggoth: { command: "fixture" } } } });
  raw.experimentalFeatureList = async () => ({ data: [{ name: "shell_tool", enabled: false }], nextCursor: null });
  raw.mcpServerStatusList = async () => ({ data: [], nextCursor: null });
  raw.threadUnsubscribe = async ({ threadId }) => {
    released.push(threadId); raw.loadedThreads.delete(threadId); isolatedSessions.delete(threadId);
    return { status: "unsubscribed" };
  };
  const start = raw.threadStart.bind(raw);
  raw.threadStart = async input => {
    const result = await start(input);
    if (input.ephemeral && input.approvalPolicy === "never") {
      assert.equal(input.config["mcp_servers.shoggoth.enabled"], false);
      assert.equal(input.config.project_doc_max_bytes, 0);
      assert.equal(input.config["features.shell_tool"], false);
      assert.match(input.developerInstructions, /procedur|Skill/iu);
      models.push(input.model); isolatedSessions.add(result.thread.id);
      return { ...result, model: input.model, approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false } };
    }
    return result;
  };
  const turn = raw.turnStart.bind(raw);
  raw.turnStart = async input => {
    const result = await turn(input);
    if (isolatedSessions.has(input.threadId)) {
      const text = input.input?.find(item => item.type === "text")?.text ?? input.prompt ?? "";
      reviewPrompts.push(text);
      const reply = JSON.stringify({ action: "create", reason: "任务已通过构建与产物校验，可复用检查顺序。",
        title: "核对构建配置与产物", description: "构建结果与预期不一致时，先确认配置来源，再检查实际产物。",
        body: "## 适用条件\n构建产物与配置预期不一致。\n\n## 检查步骤\n1. 核对实际加载的配置来源。\n2. 运行目标构建。\n3. 检查产物内容和时间。\n\n## 验证\n构建成功且产物检查通过后再判定修复完成。保留失败记录与最终校验结果。",
        references: [{ path: "references/checks.md", content: "记录配置来源、构建结果及产物验证结果。" }], evidence });
      setImmediate(() => {
        raw.emit({ known: true, type: "usage", threadId: input.threadId, turnId: result.turn.id,
          responseId: "learning-usage", usage: { inputTokens: 500, outputTokens: 220 } });
        raw.emit({ known: true, type: "text", threadId: input.threadId, turnId: result.turn.id,
          itemId: "learning-answer", text: reply, phase: "final_answer" });
        raw.emit({ known: true, type: "complete", threadId: input.threadId, turnId: result.turn.id, status: "completed" });
      });
    }
    return result;
  };
  return { ...f, backend, registry, server, request, ok, session, sourceRun: run, models, released, reviewPrompts,
    advance(ms) { clock += ms; },
    async review(mode = "review") {
      const status = await ok("status");
      await ok("configure", { expectedRevision: status.settings.revision, patch: { mode }, consent: true });
      await ok("request", { runId: run.id }); clock += 31_000;
      await f.service.learningService.tick(); await f.service.learningService.active?.promise;
      return (await ok("history")).items[0];
    },
    async close() { await server.close(); await backend.stop(); await f.close(); },
  };
}
module.exports = { openLearningFixture };
