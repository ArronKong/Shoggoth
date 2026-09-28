"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { bindConversationSource } = require("../app/agent-service/conversation-source");
const { MemoryProvenanceStore } = require("../app/agent-service/memory-provenance-store");
const { MemoryProvenanceService } = require("../app/agent-service/memory-provenance-service");
const { ConversationMemoryService } = require("../app/agent-service/conversation-memory-service");
const { AgentHarnessServiceController } = require("../app/agent-service/agent-harness-service-controller");
const { workspaceMemoryRef } = require("../app/agent-service/memory-engine");
const { validateMemoryMcpArguments } = require("../app/agent-service/memory-mcp-tools");
const { validateAgentHarnessResult } = require("../app/agent-service/agent-harness-service-protocol");

const f = contextFixture();
const session = { id: f.transcriptSessionId, sessionKey: f.run.sourceId, profileId: "profile-1",
  workspace: f.run.workspace, status: "ready" };
let cronOrigin = null;
const sessions = { getSession: () => session, listSessions: () => [session],
  getCronSessionOrigin: () => cronOrigin };
const policy = f.memoryEngine.recallPolicy;
const store = new MemoryProvenanceStore({ paths: f.paths });
store.open();
try {
  const text = "叫我阿棠，回答简洁一些。";
  f.append({ id: "source-1", kind: "user", content: { text } });
  const binding = bindConversationSource({ args: { sourceQuote: "叫我阿棠" }, run: f.run,
    transcriptStore: f.transcripts, chatSessionStore: sessions,
    getRunSessionKey: () => f.run.sourceId, requireQuote: true });
  assert.equal(binding.source.sessionId, f.transcriptSessionId);
  assert.equal(binding.source.eventId, "source-1");
  const item = f.memoryEngine.propose({ profileId: "profile-1", id: "memory-1", scope: "user",
    type: "semantic", classification: "explicit", content: "用户希望被称呼为阿棠",
    sourceRefs: binding.sourceRefs });
  let trustedRun = f.run;
  let trustedInspirationRun = null;
  let inspirationOrigin = null;
  let trustedSessionKey = f.run.sourceId;
  const service = new MemoryProvenanceService({ store, memoryStore: f.memoryStore,
    transcriptStore: f.transcripts, chatSessionStore: sessions, recallPolicy: policy,
    getRun: (id) => id === f.run.id ? trustedRun : id === "run-2" ? trustedInspirationRun : null,
    getRunSessionKey: () => trustedSessionKey,
    getInspirationOrigin: (run) => run.id === "run-2" ? inspirationOrigin : null });
  const reads = new ConversationMemoryService({ memoryEngine: f.memoryEngine,
    memoryStore: f.memoryStore, transcriptStore: f.transcripts,
    chatSessionStore: sessions, getRunSessionKey: () => f.run.sourceId,
    memoryProvenanceService: service });
  assert.equal(validateMemoryMcpArguments("memory_get", {
    source: "chat", sourceId: f.run.sourceId, id: item.id }), true);
  assert.equal(validateMemoryMcpArguments("memory_explain", {
    source: "chat", sourceId: f.run.sourceId, id: item.id, profileId: "other" }), false);
  const saved = service.recordConversationSave({ profileId: "profile-1", item,
    operationId: "save-1", source: binding.source });
  assert.equal(saved.memoryRevision, f.memoryStore.getContentRevision("profile-1", item.id));
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    workspace: f.run.workspace }).evidence.quote, "叫我阿棠");
  session.status = "draft";
  session.runtimeSessionId = null;
  session.retiredRuntimeSessions = [{ runtimeSessionId: "retired-native-thread" }];
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    workspace: f.run.workspace }).evidence.status, "verified_quote",
  "记忆写入导致 native session 续接时，历史用户原话仍应可核对");
  session.retiredRuntimeSessions = [];
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    workspace: f.run.workspace }).evidence.status, "unavailable",
  "从未绑定 Runtime 的空白 draft 不能成为历史来源");
  session.status = "ready";
  for (const [reason, changedRun] of [
    ["Run 已丢失", null],
    ["Run ID 已变", { ...f.run, id: "other-run" }],
    ["Run 归属 Profile 已变", { ...f.run, profileId: "other-profile" }],
    ["Run 工作区已变", { ...f.run, workspace: "/tmp/other" }],
    ["Run 变为 Cron", { ...f.run, source: "cron" }],
    ["Run 变为 federation", { ...f.run,
      idempotencyKey: "shoggoth:chat-send:federation-send-test" }],
    ["Run 绑定其他对话", { ...f.run, sourceId: "other-session" }],
  ]) {
    trustedRun = changedRun;
    assert.equal(service.explain({ profileId: "profile-1", id: item.id,
      workspace: f.run.workspace }).evidence.status, "unavailable", reason);
  }
  trustedRun = f.run;
  trustedSessionKey = "other-session";
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    workspace: f.run.workspace }).evidence.status, "unavailable",
  "Run 重新绑定到其他会话后不得沿用已核实引文");
  trustedSessionKey = f.run.sourceId;
  cronOrigin = { jobId: "cron-1" };
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    workspace: f.run.workspace }).evidence.status, "unavailable",
  "Cron 专用会话不能作为直接聊天来源");
  cronOrigin = null;
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    workspace: f.run.workspace }).evidence.status, "verified_quote");
  const controller = Object.assign(Object.create(AgentHarnessServiceController.prototype), {
    productStore: { getAgentProfile: (profileId) => profileId === "profile-1" ? f.profile : null },
    memoryStore: f.memoryStore, memoryEngine: f.memoryEngine, memoryProvenanceService: service,
  });
  const beforeDuplicate = f.memoryStore.getRevision("profile-1");
  const duplicateUiCreate = controller.handle("harness.memory.create", {
    profileId: "profile-1", content: item.content, scope: "user",
    expectedRevision: beforeDuplicate,
  });
  assert.equal(duplicateUiCreate.item.id, item.id);
  assert.equal(duplicateUiCreate.revision, beforeDuplicate);
  assert.equal(store.getByOperation("profile-1", `ui-create-${item.id}`), null);
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    workspace: f.run.workspace }).evidence.status, "verified_quote",
  "重复 UI 创建不能将原会话来源重标为 UI 创建");
  assert.equal(reads.get("profile-1", item.id, f.run).item.id, item.id);
  assert.equal(reads.explain("profile-1", item.id, f.run).evidence.status, "verified_quote");
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    workspace: "/tmp/other" }).evidence.status, "unavailable");
  f.memoryEngine.update({ profileId: "profile-1", id: item.id, content: "用户希望被称呼为小唐",
    sourceRef: "user-edit:legacy" });
  const legacyRelated = service.explain({ profileId: "profile-1", id: item.id,
    workspace: f.run.workspace });
  assert.equal(legacyRelated.evidence.status, "related_message",
  "内容改变后只能指向相关消息，不得沿用旧引文");
  assert.equal(validateAgentHarnessResult("harness.memory.explain", legacyRelated).evidence.status,
    "related_message", "旧记忆来源必须能够通过真实 UI 协议读取");
  f.memoryEngine.update({ profileId: "profile-1", id: item.id, content: "用户希望被称呼为阿棠" });
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    workspace: f.run.workspace }).evidence.status, "related_message",
  "内容改回后也不得复活旧引文");
  trustedRun = { ...f.run, idempotencyKey: "shoggoth:chat-send:federation-send-test" };
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    workspace: f.run.workspace }).evidence.status, "legacy_unverified",
  "无法证明为直接用户 Run 时不得显示相关消息");
  trustedRun = f.run;
  assert.equal(service.explain({ profileId: "profile-1", id: item.id,
    viewer: "agent", workspace: "/tmp/other" }).evidence.status, "legacy_unverified",
  "Agent 的来源回查不能跨工作区");
  const inspirationText = "在聊天里请记住我喜欢简洁回答。";
  trustedInspirationRun = { ...f.run, id: "run-2", source: "inspiration", sourceId: "idea-2" };
  inspirationOrigin = { runId: "run-2", profileId: "profile-1", workspace: f.run.workspace,
    ideaId: "idea-2", inputSource: "chat" };
  f.append({ id: "source-2", runId: "run-2", kind: "user", content: { text: inspirationText } });
  const inspirationBinding = bindConversationSource({ args: { sourceQuote: "喜欢简洁回答" },
    run: trustedInspirationRun, transcriptStore: f.transcripts, chatSessionStore: sessions,
    getRunSessionKey: () => f.run.sourceId, requireQuote: true });
  const inspirationItem = f.memoryEngine.propose({ profileId: "profile-1", id: "inspiration-memory-1",
    scope: "user", type: "semantic", classification: "explicit", content: "用户喜欢简洁回答",
    sourceRefs: inspirationBinding.sourceRefs });
  service.recordConversationSave({ profileId: "profile-1", item: inspirationItem,
    operationId: "save-inspiration-1", source: inspirationBinding.source });
  const explainInspiration = () => service.explain({ profileId: "profile-1",
    id: inspirationItem.id, workspace: f.run.workspace }).evidence;
  assert.equal(explainInspiration().status, "verified_quote", "聊天来源 Inspiration 的引文可核实");
  const verifiedEvidenceRevision = service.getEvidenceRevision("profile-1", inspirationItem.id);
  inspirationOrigin = { ...inspirationOrigin, inputSource: "card" };
  assert.equal(explainInspiration().status, "unavailable", "卡片来源 Inspiration 不得显示引文");
  assert.notEqual(service.getEvidenceRevision("profile-1", inspirationItem.id),
    verifiedEvidenceRevision, "来源 Run 失效时解释版本必须变化");
  inspirationOrigin = { ...inspirationOrigin, inputSource: "chat" };
  const longPrefix = "请记住我偏好蓝色界面";
  const longSuffix = "我每周二检查构建日志";
  const longText = `${longPrefix}。${"普通背景资料。".repeat(9000)}${longSuffix}。`;
  f.append({ id: "source-long", kind: "user", content: { text: longText } });
  const journalEvent = f.transcripts.getEvent("profile-1", f.transcriptSessionId, "source-long");
  assert.ok(journalEvent.content.contextRef, "长消息应在 Transcript 中使用 contextRef");
  assert.equal(journalEvent.content.text.includes(longSuffix), false,
    "后缀引文不在截断的 journal 展示文本中");
  const saveLong = (content, quote, operationId) => {
    const args = { expectedRevision: f.memoryStore.getRevision("profile-1"),
      content, scope: "user", classification: "explicit", sourceQuote: quote };
    const binding = reads.bind("memory_save", args, f.run);
    return reads.write("memory_save", "profile-1", args, { binding, operationId });
  };
  const longPrefixSaved = saveLong("用户偏好蓝色界面", longPrefix, "long-prefix-save");
  const longSuffixSaved = saveLong("用户每周二检查构建日志", longSuffix, "long-suffix-save");
  for (const [savedLong, quote] of [[longPrefixSaved, longPrefix], [longSuffixSaved, longSuffix]]) {
    assert.equal(savedLong.saved, true, "直接 memory_save 应保存长消息中的引文");
    const explained = service.explain({ profileId: "profile-1", id: savedLong.item.id,
      workspace: f.run.workspace });
    assert.equal(explained.evidence.status, "verified_quote");
    assert.equal(explained.evidence.quote, quote);
    assert.equal(validateAgentHarnessResult("harness.memory.explain", explained).evidence.quote, quote,
      "长正文不能进入 explain 响应，仅返回受预算约束的引文");
  }
  const legacyLongBinding = reads.bind("memory_save", { sourceQuote: longPrefix,
    classification: "explicit" }, f.run);
  const legacyLongItem = f.memoryEngine.propose({ profileId: "profile-1", id: "legacy-long-prefix",
    scope: "user", type: "semantic", classification: "explicit",
    content: "用户曾要求偏好蓝色界面", sourceRefs: legacyLongBinding.sourceRefs });
  service.recordConversationSave({ profileId: "profile-1", item: legacyLongItem,
    operationId: "legacy-long-prefix-save", source: { ...legacyLongBinding.source,
      eventTextHash: crypto.createHash("sha256").update(journalEvent.content.text).digest("hex") } });
  assert.equal(service.explain({ profileId: "profile-1", id: legacyLongItem.id,
    workspace: f.run.workspace }).evidence.status, "verified_quote",
  "旧版长消息前缀记录的 journal hash 仍应核对到受校验全文");
  const contextFile = path.join(f.transcripts._sessionDir("profile-1", f.transcriptSessionId),
    "context-content", `${journalEvent.content.contextRef.hash}.json`);
  const contextBytes = fs.readFileSync(contextFile);
  fs.unlinkSync(contextFile);
  assert.equal(service.explain({ profileId: "profile-1", id: longSuffixSaved.item.id,
    workspace: f.run.workspace }).evidence.status, "unavailable",
  "正文对象缺失后 explain 不能沿用截断 journal 引文");
  assert.throws(() => reads.bind("memory_save", { sourceQuote: longPrefix }, f.run),
    "正文对象缺失后 direct memory_save 不能沿用前缀展示文本");
  fs.writeFileSync(contextFile, contextBytes, { mode: 0o600 });
  const corruptContext = Buffer.from(contextBytes);
  corruptContext[corruptContext.length - 2] ^= 1;
  fs.writeFileSync(contextFile, corruptContext);
  assert.equal(service.explain({ profileId: "profile-1", id: longSuffixSaved.item.id,
    workspace: f.run.workspace }).evidence.status, "unavailable",
  "正文对象损坏后 explain 必须拒绝引文");
  assert.throws(() => reads.bind("memory_save", { sourceQuote: longSuffix }, f.run),
    "正文对象损坏后 direct memory_save 必须拒绝后缀引文");
  fs.writeFileSync(contextFile, contextBytes, { mode: 0o600 });
  assert.equal(service.explain({ profileId: "profile-1", id: longSuffixSaved.item.id,
    workspace: f.run.workspace }).evidence.status, "verified_quote",
  "恢复受哈希校验的正文后引文应重新可核实");
  const raceJournal = path.join(f.transcripts._sessionDir("profile-1", f.transcriptSessionId),
    "events.jsonl");
  const raceJournalBytes = fs.readFileSync(raceJournal);
  const originalContextEvent = f.transcripts.contextEvent.bind(f.transcripts);
  f.transcripts.contextEvent = (...args) => {
    const resolved = originalContextEvent(...args);
    if (args[2]?.id === "source-long") fs.unlinkSync(raceJournal);
    return resolved;
  };
  try {
    assert.equal(service.explain({ profileId: "profile-1", id: longSuffixSaved.item.id,
      workspace: f.run.workspace }).evidence.status, "unavailable",
    "长正文已读取但 journal 在返回前丢失时不能显示已核实引文");
  } finally {
    f.transcripts.contextEvent = originalContextEvent;
    fs.writeFileSync(raceJournal, raceJournalBytes, { mode: 0o600 });
    f.transcripts.forgetProfile("profile-1");
  }
  assert.equal(service.explain({ profileId: "profile-1", id: longSuffixSaved.item.id,
    workspace: f.run.workspace }).evidence.status, "verified_quote");
  const withdrawnTail = f.memoryEngine.propose({ profileId: "profile-1", id: "withdrawn-long-tail",
    scope: "user", type: "semantic", classification: "explicit", content: longSuffix,
    sourceRefs: ["user-edit:withdrawn-long-tail"] });
  f.memoryEngine.delete({ profileId: "profile-1", id: withdrawnTail.id, reason: "forgotten" });
  assert.equal(service.explain({ profileId: "profile-1", id: longPrefixSaved.item.id,
    workspace: f.run.workspace }).evidence.status, "unavailable",
  "撤回词只在长消息后缀时也必须屏蔽整个 Agent 可见来源事件");
  const provenancePath = path.join(f.paths.agentsDir, "profile-1", "memory", "provenance.jsonl");
  const provenanceBytes = fs.readFileSync(provenancePath);
  fs.unlinkSync(provenancePath);
  assert.equal(explainInspiration().status, "unavailable", "运行中丢失旁表不能返回缓存引文");
  assert.notEqual(service.getEvidenceRevision("profile-1", inspirationItem.id),
    verifiedEvidenceRevision, "旁表丢失时解释版本必须变化");
  fs.writeFileSync(provenancePath, provenanceBytes, { mode: 0o600 });
  assert.equal(explainInspiration().status, "verified_quote", "旁表恢复后需重新校验");
  fs.writeFileSync(provenancePath, "corrupt\n");
  assert.equal(explainInspiration().status, "unavailable", "运行中损坏旁表不能返回缓存引文");
  fs.writeFileSync(provenancePath, provenanceBytes, { mode: 0o600 });
  assert.equal(explainInspiration().status, "verified_quote", "修复后的旁表需重新校验");
  const sameSizeCorruption = Buffer.from(provenanceBytes);
  const tamperAt = sameSizeCorruption.indexOf(Buffer.from("save-inspiration-1"));
  assert.ok(tamperAt >= 0);
  sameSizeCorruption[tamperAt] = 0x78;
  fs.writeFileSync(provenancePath, sameSizeCorruption);
  assert.equal(explainInspiration().status, "unavailable",
    "运行中等长损坏旁表也不能返回缓存引文");
  fs.writeFileSync(provenancePath, provenanceBytes, { mode: 0o600 });
  assert.equal(explainInspiration().status, "verified_quote", "等长损坏修复后需重新校验");
  const ui = f.memoryEngine.propose({ profileId: "profile-1", id: "memory-2", scope: "agent",
    type: "semantic", classification: "explicit", content: "Agent 保持简洁",
    sourceRefs: ["user-edit:test"], supersedes: null });
  service.recordUiWrite({ profileId: "profile-1", item: ui,
    operationId: "ui-1", origin: "ui_create" });
  assert.equal(service.getEvidenceRevision("profile-1", inspirationItem.id),
    verifiedEvidenceRevision, "其他记忆的来源写入不能误判当前引文失效");
  assert.equal(service.explain({ profileId: "profile-1", id: ui.id,
    workspace: f.run.workspace }).evidence.status, "verified_origin");
  const project = f.memoryEngine.propose({ profileId: "profile-1", id: "project-1", scope: "project",
    type: "project", classification: "explicit", content: "项目采用 SQLite",
    sourceRefs: ["user-edit:project", workspaceMemoryRef(f.run.workspace)] });
  assert.equal(reads.get("profile-1", project.id, f.run).item.id, project.id);
  assert.throws(() => reads.get("profile-1", project.id,
    { ...f.run, workspace: "/tmp/unrelated" }), { code: "MEMORY_NOT_FOUND" });
  f.memoryEngine.delete({ profileId: "profile-1", id: project.id, reason: "user_deleted" });
  assert.throws(() => reads.get("profile-1", project.id, f.run), { code: "MEMORY_NOT_FOUND" });
  assert.equal(service.explain({ profileId: "profile-1", id: project.id,
    viewer: "user" }).withdrawalReason, "user_deleted");
  f.memoryEngine.delete({ profileId: "profile-1", id: project.id, reason: "forgotten" });
  assert.equal(service.explain({ profileId: "profile-1", id: project.id,
    viewer: "user" }).withdrawalReason, "forgotten",
  "已删除项再次明确遗忘应显示新的撤回原因");
  const expiring = f.memoryEngine.propose({ profileId: "profile-1", id: "expiring-1",
    scope: "agent", type: "temporary", classification: "explicit",
    content: "短期提醒已到期", sourceRefs: ["user-edit:expiry"], validUntil: f.memoryEngine.now() });
  f.memoryEngine.consolidate("profile-1");
  assert.equal(service.explain({ profileId: "profile-1", id: expiring.id,
    viewer: "user" }).withdrawalReason, "expired");
  const transcriptLog = path.join(f.transcripts._sessionDir("profile-1", f.transcriptSessionId),
    "events.jsonl");
  const transcriptBytes = fs.readFileSync(transcriptLog);
  const evidenceBeforeJournalLoss = service.getEvidenceRevision("profile-1", inspirationItem.id);
  fs.unlinkSync(transcriptLog);
  assert.equal(explainInspiration().status, "unavailable",
    "运行中原始事件 journal 丢失后不能继续显示缓存引文");
  assert.notEqual(service.getEvidenceRevision("profile-1", inspirationItem.id),
    evidenceBeforeJournalLoss, "journal 丢失应令同 callId 的解释证据版本变化");
  assert.throws(() => reads.bind("memory_save", { sourceQuote: "喜欢简洁回答" }, f.run),
    "原始 journal 丢失后不能从缓存再次绑定来源");
  fs.writeFileSync(transcriptLog, transcriptBytes, { mode: 0o600 });
  f.transcripts.forgetProfile("profile-1");
  assert.equal(explainInspiration().status, "verified_quote", "重启式重载后应重新核实已恢复的 journal");
  const corruptJournal = Buffer.from(transcriptBytes);
  const journalTamperAt = corruptJournal.indexOf(Buffer.from("event.append"));
  assert.ok(journalTamperAt >= 0);
  corruptJournal[journalTamperAt] = 0x78;
  fs.writeFileSync(transcriptLog, corruptJournal, { mode: 0o600 });
  assert.equal(explainInspiration().status, "unavailable",
    "运行中等长篡改原始 journal 不能继续显示缓存引文");
  console.log("shoggoth memory provenance service unit: passed");
} finally {
  store.close(); f.cleanup();
}
