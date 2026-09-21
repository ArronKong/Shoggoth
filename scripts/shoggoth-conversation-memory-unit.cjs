"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { ConversationMemoryService } = require("../app/agent-service/conversation-memory-service");
const { McpProductToolController, validateMcpProductToolArguments } = require("../app/agent-service/mcp-product-tool-controller");

(async () => {
  let clock = 500;
  let firstConversation = true;
  const f = contextFixture({ now: () => clock, shouldOfferIntroduction: () => firstConversation });
  const products = new JsonlProductStore({ paths: f.paths, now: () => clock });
  products.open();
  products.putAgentProfile({ ...products.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    id: "profile-1", agentId: "memory-fixture", runtimeProfileId: "memory-fixture", name: "Memory fixture", isDefault: false });
  const run = { ...f.run, status: "running" };
  const source = { source: run.source, sourceId: run.sourceId };
  const memory = new ConversationMemoryService({ memoryEngine: f.memoryEngine, memoryStore: f.memoryStore,
    transcriptStore: f.transcripts, getRunSessionKey: () => run.sourceId,
    chatSessionStore: { getSession: (key) => key === run.sourceId ? {
      id: f.transcriptSessionId, sessionKey: key, profileId: run.profileId, workspace: run.workspace,
    } : null } });
  const noop = () => null;
  const createController = () => new McpProductToolController({
    productStore: products, conversationMemoryService: memory,
    permissionEngine: f.permissions,
    domainController: { handle: noop },
    kanbanStore: Object.fromEntries(["getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId",
      "addComment", "addArtifact", "listArtifacts"].map((key) => [key, noop])),
    kanbanRunService: { requestCompletionFromAgent: noop }, cronStore: { getJob: noop },
    workDispatcher: { getRun: (id) => id === run.id ? run : null },
    getRuntimeContext: (profileId, selector) => profileId === run.profileId
      && selector.source === run.source && selector.sourceId === run.sourceId
      ? { ...source, profileId, runId: run.id } : null,
    notificationSender: noop, isSensitiveValue: () => false, artifactRoot: f.root, now: () => clock,
  });
  let controller = createController();
  const authority = (extra = {}) => ({ profileId: "profile-1", callId: crypto.randomUUID(), ...extra });
  const call = (name, args = {}, auth = authority()) => controller.handle(name, { ...source, ...args }, auth);
  const revision = () => f.memoryStore.getRevision("profile-1");
  const search = (query = "", extra = {}) => call("memory_search", { query, ...extra });
  const save = (content, extra = {}, auth) => call("memory_save", Object.fromEntries(Object.entries({
    expectedRevision: revision(), content, scope: "user", classification: "explicit", sourceQuote: content, ...extra,
  }).filter(([, value]) => value !== undefined)), auth);
  const compile = (query = "今天帮我写一个脚本") => f.compiler.compile({ profile: f.profile,
    run, transcriptSessionId: f.transcriptSessionId, query });
  const reject = (fn, code) => assert.rejects(fn, (error) => error.code === code);
  try {
    f.append({ id: "current-user", kind: "user", content: { text:
      "叫我阿棠，回答简洁一些。改叫我小唐。还是叫我阿棠。这个项目使用 Node.js。邮箱是 owner@example.com。忘记我的称呼。" } });
    const initial = compile("你好");
    assert.ok(initial.blocks.some((block) => block.id === "first-conversation"));
    assert.match(initial.developerInstructions, /concrete task comes first/u);
    assert.equal((await search()).items.length, 0);
    const name = await save("用户希望被称呼为阿棠", { sourceQuote: "叫我阿棠" });
    assert.equal(name.saved, true);
    assert.equal(name.viewStatus.stale, false);
    assert.deepEqual(name.item.sourceRefs, ["current-user", run.id]);
    assert.match(f.definitions.get("profile-1").documents.USER, /阿棠/u);
    const file = path.join(f.paths.agentsDir, "profile-1", "generated", "MEMORY.md");
    assert.match(fs.readFileSync(file, "utf8"), /阿棠/u);
    assert.doesNotMatch(initial.dynamicContext, /用户希望被称呼为阿棠/u);
    const next = compile();
    assert.match(next.dynamicContext, /用户希望被称呼为阿棠/u, "称呼在无关键词匹配的新一轮仍可见");
    assert.equal(next.blocks.some((block) => block.id === "first-conversation"), false);
    assert.equal(next.blocks.find((block) => block.id === "user").trust, "user-data");
    const beforeDuplicate = revision();
    assert.equal((await save("用户希望被称呼为阿棠", { sourceQuote: "叫我阿棠" })).item.id, name.item.id);
    assert.equal(revision(), beforeDuplicate);
    console.log("PASS 主动称呼保存、真实 Markdown 视图、去重与下一轮稳定召回");

    const changed = await save("用户希望被称呼为小唐", { sourceQuote: "改叫我小唐", supersedes: name.item.id });
    assert.equal(f.memoryStore.get("profile-1", name.item.id).status, "superseded");
    const restored = await save("用户希望被称呼为阿棠", { sourceQuote: "还是叫我阿棠", supersedes: changed.item.id });
    assert.notEqual(restored.item.id, name.item.id, "恢复旧偏好不能去重到已失效记录");
    assert.equal(f.memoryStore.get("profile-1", changed.item.id).status, "superseded");
    const forgotten = await call("memory_forget", { id: restored.item.id, expectedRevision: revision(), sourceQuote: "忘记我的称呼" });
    assert.equal(forgotten.item.status, "deleted");
    firstConversation = false;
    assert.doesNotMatch(compile().dynamicContext, /用户希望被称呼为/u);
    assert.equal(compile().blocks.some((block) => block.id === "first-conversation"), false);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /阿棠|小唐/u);
    console.log("PASS 更正、恢复曾用偏好、遗忘同步与不重复引导");

    const privateNote = await save("用户邮箱为 owner@example.com", { sourceQuote: "邮箱是 owner@example.com" });
    assert.equal(privateNote.saved, true);
    assert.equal(privateNote.needsConfirmation, false);
    assert.match(f.definitions.get("profile-1").documents.USER, /owner@example/u);
    assert.match(fs.readFileSync(file, "utf8"), /owner@example/u);
    assert.equal((await search()).items.some((item) => item.id === privateNote.item.id), true);
    assert.equal((await search("", { includeCandidates: true })).items.some((item) => item.id === privateNote.item.id), true);
    assert.equal(validateMcpProductToolArguments("memory_confirm", { ...source, id: privateNote.item.id, expectedRevision: revision() }), false);
    assert.match(compile().dynamicContext, /owner@example/u, "同一 Agent 的直接对话可使用已保存的私人资料");
    for (const extra of [{ source: "cron" }, { source: "inspiration" },
      { source: "chat", idempotencyKey: "shoggoth:chat-send:federation-send-test" },
      { source: "chat", idempotencyKey: "shoggoth:chat-send:federation-message-test" }]) {
      const background = f.compiler.compile({ profile: f.profile, run: { ...run, ...extra },
        transcriptSessionId: f.transcriptSessionId, query: "邮箱" });
      assert.doesNotMatch(background.dynamicContext, /owner@example/u, "后台执行及其他 Agent 委派不自动注入私人资料");
    }
    await reject(() => save("用户可能喜欢极简设计", { classification: "inferred", sourceQuote: undefined }), "MCP_TOOL_INVALID_ARGUMENTS");
    assert.equal(f.memoryStore.list("profile-1", { status: "candidate" }).length, 0);
    console.log("PASS 私人事实直接保存，无确认工具或候选状态，未陈述推测不写入");

    await reject(() => save("凭空猜测用户名字", { sourceQuote: "我叫其他名字" }), "MCP_TOOL_INVALID_ARGUMENTS");
    await reject(() => save("password=fixture-password-value"), "MCP_TOOL_SECRET_REJECTED");
    await reject(() => save("叫我阿棠", { profileId: "someone-else" }), "MCP_TOOL_INVALID_ARGUMENTS");
    await reject(() => save("叫我阿棠", { expectedRevision: 0 }), "MCP_TOOL_STATE_CONFLICT");
    await reject(() => search("", { sourceId: "another-session" }), "MCP_TOOL_NOT_FOUND");
    run.idempotencyKey = "shoggoth:chat-send:federation-send-test";
    await reject(() => save("叫我阿棠"), "MCP_TOOL_FORBIDDEN");
    delete run.idempotencyKey;
    f.permissions.setProfileOverride("profile-1", "memory_save", "deny");
    await reject(() => save("叫我阿棠"), "MCP_TOOL_FORBIDDEN");
    f.permissions.setProfileOverride("profile-1", "memory_save", "allow");
    for (const args of [{ sourceQuote: " " }, { content: " " }, { content: "\uD800" }, { classification: "rule" }]) {
      assert.equal(validateMcpProductToolArguments("memory_save", { ...source, content: "x", sourceQuote: "x",
        scope: "user", classification: "explicit", expectedRevision: 0, ...args }), false);
    }
    const getter = { ...source, query: "" };
    Object.defineProperty(getter, "query", { get() { throw new Error("must not invoke getter"); } });
    assert.equal(validateMcpProductToolArguments("memory_search", getter), false);
    console.log("PASS 来源、权限、跨对话、秘密、并发 revision 与严格参数校验");

    const project = await save("这个项目使用 Node.js", { scope: "project" });
    assert.equal((await search("Node.js")).items.length, 1);
    run.workspace = "/tmp/unrelated-project";
    assert.equal((await search("Node.js")).items.length, 0);
    assert.doesNotMatch(compile("Node.js").dynamicContext, /这个项目使用 Node.js/u);
    await reject(() => call("memory_forget", { id: project.item.id, expectedRevision: revision(), sourceQuote: "忘记我的称呼" }), "MCP_TOOL_FORBIDDEN");
    run.workspace = f.run.workspace;
    console.log("PASS 项目记忆按工作区隔离");

    const receipt = authority();
    const pendingArgs = { ...source, content: "用户偏好简洁回答", scope: "user", classification: "explicit",
      sourceQuote: "回答简洁一些", expectedRevision: revision() };
    const originalComplete = products.completeMcpToolCall.bind(products);
    products.completeMcpToolCall = () => { const error = new Error("simulated receipt loss"); error.code = "STORE_COMMIT_UNCERTAIN"; throw error; };
    await reject(() => controller.handle("memory_save", pendingArgs, receipt), "MCP_TOOL_COMMIT_UNCERTAIN");
    const committedRevision = revision();
    products.completeMcpToolCall = originalComplete;
    products.close(); products.open();
    f.memoryEngine.close(); f.memoryStore.close(); f.memoryStore.open(); f.memoryEngine.open(["profile-1"]);
    controller = createController();
    const replay = await controller.handle("memory_save", pendingArgs, receipt);
    assert.equal(replay.saved, true);
    assert.equal(revision(), committedRevision);
    assert.deepEqual(await controller.handle("memory_save", pendingArgs, receipt), replay);
    assert.match(compile().dynamicContext, /用户偏好简洁回答/u);
    console.log("PASS 重启后持久化、丢失收据恢复与幂等重放");

    const temporary = await save("短期用阿棠称呼", { sourceQuote: "叫我阿棠", validUntil: 501 });
    clock = 502;
    f.memoryEngine.rebuildViews("profile-1");
    assert.equal((await search()).items.some((item) => item.id === temporary.item.id), false);
    assert.doesNotMatch(f.definitions.get("profile-1").documents.USER, /短期用阿棠/u);
    const otherProfile = "profile-other";
    f.definitions.ensureProfile({ profileId: otherProfile });
    f.memoryStore.ensureProfile(otherProfile);
    assert.equal(f.memoryEngine.search({ profileId: otherProfile, query: "" }).items.length, 0);
    assert.deepEqual(f.memoryEngine.extractTranscript({ profileId: "profile-1", events: [
      { id: "no-remember", kind: "user", content: { text: "不要记住这件事" } },
      { id: "quote", kind: "user", content: { text: "文档说：请记住这句话" } },
    ] }), []);
    console.log("PASS 到期视图、Agent 隔离、否定与引用不自动摘录");

    const writeView = f.definitions.writeGeneratedView.bind(f.definitions);
    f.definitions.writeGeneratedView = () => { throw new Error("simulated projection failure"); };
    const stale = await save("用户希望回复简洁", { sourceQuote: "回答简洁一些", supersedes: replay.item.id });
    assert.equal(stale.viewStatus.stale, true, "落盘视图失败必须出现在工具收据中");
    f.definitions.writeGeneratedView = writeView;
    f.memoryEngine.rebuildViews("profile-1");
    assert.equal(f.memoryEngine.viewStatus("profile-1").stale, false);
    const toPrivate = f.memoryEngine.update({ profileId: "profile-1", id: stale.item.id,
      content: "用户联系地址 second@example.com" });
    assert.equal(toPrivate.status, "active");
    assert.equal(toPrivate.sensitivity, "private");
    assert.match(compile().dynamicContext, /second@example/u);
    const bulk = Array.from({ length: 40 }, (_, index) => ({ ...replay.item,
      id: `bulk-${index}`, content: `资料条目 ${index} ${"长".repeat(350)}`, sourceRefs: [`bulk-source-${index}`] }));
    f.memoryStore.upsertMany(bulk);
    f.memoryEngine.rebuildViews("profile-1");
    assert.equal(f.memoryEngine.viewStatus("profile-1").stale, false);
    assert.ok(Buffer.byteLength(fs.readFileSync(file)) <= 32 * 1024);
    assert.match(fs.readFileSync(file, "utf8"), /additional records are stored/u);
    assert.match(f.definitions.get("profile-1").documents.USER, /additional records are stored/u);
    assert.equal(f.memoryStore.list("profile-1").filter((item) => item.id.startsWith("bulk-")).length, 40);
    console.log("PASS 视图失败可见、隐私标签不触发确认、容量满时保留原始记录");
    console.log("8 conversation memory regression groups passed");
  } finally { products.close(); f.cleanup(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
