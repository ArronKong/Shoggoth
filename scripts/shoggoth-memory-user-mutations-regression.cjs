"use strict";

// Reproductions from the installed 0.8.293 user audit. Every write belongs to
// an isolated Service; the installed App and its memories are never touched.
const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { A, fixture } = require("./fixtures/memory-repair-fixture.cjs");
const { ConversationMemoryService } = require("../app/agent-service/conversation-memory-service");
const { validateMemoryMcpArguments } = require("../app/agent-service/memory-mcp-tools");
const { validateMemoryItem } = require("../app/agent-service/memory-store");
const { workspaceMemoryRefs } = require("../app/agent-service/memory-engine");
const { managedChatWorkspace } = require("../app/agent-service/chat-workspace");
const { ConversationDefinitionService } = require("../app/agent-service/conversation-definition-service");

function conversation(f, workspace = f.workspace) {
  const session = f.service.chatSessionStore.createSession({ profileId: A, workspace,
    operationId: crypto.randomUUID(), createdAt: f.now() });
  const binding = crypto.randomUUID();
  f.service.chatSessionStore.requestBinding(session.sessionKey, binding, f.now());
  f.service.chatSessionStore.completeBinding(session.sessionKey, binding, `runtime-${binding}`);
  return f.service.chatSessionStore.getSession(session.sessionKey);
}
function turn(f, session, text) {
  const id = crypto.randomUUID(), service = f.service;
  service.workDispatcher.enqueue({ id, profileId: A, source: "chat", sourceId: session.sessionKey,
    idempotencyKey: id, workspace: session.workspace });
  service.workDispatcher.admit(id); service.workDispatcher.transition(id, "running");
  const event = service.transcriptStore.appendEvent({ profileId: A, sessionId: session.id, id: `user-${id}`,
    runId: id, kind: "user", content: { text }, occurredAt: f.now() });
  const memory = new ConversationMemoryService({ memoryEngine: f.owner, memoryStore: f.owner.store,
    transcriptStore: service.transcriptStore, chatSessionStore: service.chatSessionStore,
    memoryProvenanceService: service.memoryProvenanceService, getRunSessionKey: run => run.sourceId });
  const run = () => service.workDispatcher.getRun(id);
  return { event, run, memory,
    async write(name, args, extra = {}) {
      const full = { source: "chat", sourceId: session.sessionKey, ...args };
      return memory.write(name, A, full, { binding: memory.bind(name, full, run()),
        operationId: crypto.randomUUID(), ...extra });
    },
    finish() { service.workDispatcher.transition(id, "completed"); },
  };
}
const save = (t, content, extra = {}) => t.write("memory_save", { content, sourceQuote: t.event.content.text,
  scope: "agent", classification: "explicit", ...extra });
const listParams = { profileId: A, status: "active", scope: "agent", cursor: 0, limit: 100 };

async function definition(f, t, content, { legacy = false } = {}) {
  const service = new ConversationDefinitionService({ definitionStore: f.service.agentDefinitionStore,
    productStore: f.service.productStore, transcriptStore: f.service.transcriptStore,
    chatSessionStore: f.service.chatSessionStore, getRunSessionKey: run => run.sourceId,
    memoryDefinitionLinks: legacy ? undefined : f.owner.definitionLinks });
  const old = f.service.agentDefinitionStore.get(A);
  const args = { kind: "AGENTS", oldText: old.documents.AGENTS, newText: content,
    expectedRevision: old.manifest.revision, sourceQuote: t.event.content.text };
  const call = f.service.productStore.beginMcpToolCall({ profileId: A, name: "agent_definition_update",
    callId: crypto.randomUUID(), fingerprint: crypto.createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    binding: service.bind("agent_definition_update", args, t.run()), createdAt: f.now() });
  const result = await service.update(A, args, call);
  f.service.productStore.completeMcpToolCall({ id: call.id, outcome: { ok: true, result } });
  // All linked-forget cases must still work after the source files age out of
  // the three-backup window, including legacy MCP receipts and reintroduced rules.
  const store = f.service.agentDefinitionStore;
  for (let index = 0; index < 4; index++) store.update({ profileId: A, actor: "user",
    expectedRevision: store.get(A).manifest.revision, documents: { SOUL: `Later unrelated edit ${index}` } });
  assert.equal(store.readRevision(A, result.revision), null);
  return result;
}
const agents = f => f.service.agentDefinitionStore.get(A).documents.AGENTS;
const homeSession = f => conversation(f, managedChatWorkspace(path.join(f.owner.paths.defaultWorkspaceDir, A), crypto.randomUUID()));

test("daily correction replaces one note in one commit and keeps the old note on a stale revision", async t => {
  const f = await fixture(t), session = conversation(f);
  const first = turn(f, session, "松桥联调定在今晚 20:40，标记银杏-296。只记今天的笔记。");
  const old = await save(first, "松桥联调定在今晚 20:40，标记银杏-296。", { placement: "daily" });
  first.finish();
  const current = turn(f, session, "更正：松桥联调改为今晚 21:10，标记银杏-296；替换旧时间。");
  const args = { content: "松桥联调改为今晚 21:10，标记银杏-296。", sourceQuote: current.event.content.text,
    scope: "agent", classification: "explicit", placement: "daily", supersedes: old.item.id,
    expectedRevision: f.owner.store.getRevision(A) };
  assert.equal(validateMemoryMcpArguments("memory_save", { source: "chat", sourceId: session.sessionKey, ...args }), true);
  await assert.rejects(current.write("memory_save", { ...args, expectedRevision: args.expectedRevision - 1 }), { code: "MEMORY_REVISION_CONFLICT" });
  assert.equal(f.owner.store.get(A, old.item.id).status, "active");
  await assert.rejects(current.write("memory_save", { ...args, content: "An unrelated unsupported invention about the release." }), { code: "MEMORY_CONFLICT_INVALID" });
  assert.equal(f.owner.store.get(A, old.item.id).status, "active");
  const updated = await current.write("memory_save", args);
  assert.equal(updated.saved, true);
  assert.equal(f.owner.store.get(A, old.item.id).status, "superseded");
  assert.equal(f.owner.store.get(A, updated.item.id).memoryPath, f.owner.store.get(A, old.item.id).memoryPath);
  const text = f.owner.store.readFile(A, f.owner.store.get(A, old.item.id).memoryPath);
  assert.match(text, /21:10/u); assert.doesNotMatch(text, /20:40/u);
  assert.doesNotMatch(f.owner.store.readFile(A, "MEMORY.md"), /松桥/u);
  assert.equal(f.owner.recallPolicy.isSourceVisible(A, [current.event.id, current.run().id]), true);
  assert.equal((await f.ipc("harness.memory.list", listParams)).items.filter(x => /松桥/u.test(x.content)).length, 1);
});

test("a correction that omits placement preserves the original daily file and cancellation preserves its old entry", async t => {
  const f = await fixture(t), session = conversation(f);
  const first = turn(f, session, "今天测试用北门入口。");
  const old = await save(first, "今天测试用北门入口。", { placement: "daily" }); first.finish();
  const current = turn(f, session, "更正：今天测试改用东门入口。");
  const args = { content: "今天测试改用东门入口。", sourceQuote: current.event.content.text,
    scope: "agent", classification: "explicit", supersedes: old.item.id, expectedRevision: f.owner.store.getRevision(A) };
  await assert.rejects(current.write("memory_save", args, { assertCurrent() { throw new Error("canceled before commit"); } }), /canceled before commit/u);
  assert.equal(f.owner.store.get(A, old.item.id).status, "active");
  const updated = await current.write("memory_save", args);
  assert.equal(f.owner.store.get(A, updated.item.id).memoryPath, f.owner.store.get(A, old.item.id).memoryPath);
  assert.doesNotMatch(f.owner.store.readFile(A, "MEMORY.md"), /东门/u);
});

test("new CJK conversation excerpts fit the memory item byte limit and the real list response", async t => {
  const f = await fixture(t), session = conversation(f);
  for (let i = 0; i < 15; i++) {
    const current = turn(f, session, `第${i}条：${"这是需要完整保留原始来源的中文交流内容。".repeat(36)}`);
    current.finish();
  }
  await f.owner.sessionCapture.captureProfile(A, { reason: "nightly", idleMs: 0 });
  const excerpts = f.owner.store.list(A, { status: "active" }).filter(x => x.id.startsWith("session-excerpt-"));
  assert.ok(excerpts.length > 0);
  assert.ok(excerpts.every(x => Buffer.byteLength(x.content) <= 8192));
  const page = await f.ipc("harness.memory.list", listParams);
  assert.equal(page.items.filter(x => x.id.startsWith("session-excerpt-")).length, excerpts.length);
  assert.match(excerpts.map(x => x.content).join("\n"), /第14条/u, "keep the most recent messages");
});

test("legacy oversized excerpts remain readable through list/explain without relaxing write limits or changing their content", async t => {
  const f = await fixture(t), now = f.now();
  const content = "历史中文会话摘录。".repeat(400);
  const item = { id: "session-excerpt-legacy-size", profileId: A, scope: "agent", type: "episodic", content,
    sourceRefs: ["user-edit:legacy-size"], confidence: 0.5, sensitivity: "normal", status: "active",
    validFrom: now, validUntil: null, supersedes: null, createdAt: now, updatedAt: now };
  assert.ok(Buffer.byteLength(content) > 8192);
  assert.throws(() => validateMemoryItem(item), { code: "MEMORY_INVALID" });
  await f.owner.store.upsertMany([{ ...item, memoryPath: "memory/2026-11-07.md" }]);
  const before = fs.readFileSync(path.join(f.owner.store.workspace(A), "memory/2026-11-07.md"));
  const page = await f.ipc("harness.memory.list", listParams);
  assert.equal(page.items.find(x => x.id === item.id).content, content);
  const explained = await f.ipc("harness.memory.explain", { profileId: A, id: item.id });
  assert.equal(explained.item.content, content);
  assert.deepEqual(fs.readFileSync(path.join(f.owner.store.workspace(A), "memory/2026-11-07.md")), before);
});

test("a new home conversation finds and atomically corrects a legacy workspace fact without exposing real projects", async t => {
  const f = await fixture(t), firstSession = homeSession(f), first = turn(f, firstSession, "杉湾项目的识别短语是白鹭-583。");
  const old = await f.owner.propose({ profileId: A, scope: "workspace", content: first.event.content.text,
    classification: "explicit", sourceRefs: [first.event.id, first.run().id, ...workspaceMemoryRefs(firstSession.workspace, "workspace")] });
  first.finish();
  const second = turn(f, homeSession(f), "更正：杉湾项目的识别短语是白鹭-916。");
  const source = { source: "chat", sourceId: second.run().sourceId, query: "杉湾项目 白鹭", minScore: 0 };
  const found = await second.memory.searchWithSemantic(A, source, second.run());
  assert.ok(found.items.some(item => item.id === old.id));
  assert.equal(second.memory.get(A, old.id, second.run()).item.id, old.id);
  assert.equal(f.owner.visible(old, { workspace: f.workspace }), false);
  const corrected = await save(second, "杉湾项目的识别短语是白鹭-916。", { scope: "workspace", supersedes: old.id,
    expectedRevision: found.revision });
  assert.equal(corrected.item.scope, "agent");
  assert.equal(f.owner.store.get(A, old.id).status, "superseded");
  assert.equal(f.owner.store.list(A, { status: "active" }).filter(item => /杉湾项目/u.test(item.content)).length, 1);
  const project = await f.owner.propose({ profileId: A, scope: "workspace", content: "真实项目只在本目录有效。",
    classification: "explicit", sourceRefs: ["user-edit:real-project", ...workspaceMemoryRefs(f.workspace, "workspace")] });
  assert.equal(f.owner.visible(project, { workspace: second.run().workspace }), false);
  await assert.rejects(save(second, "杉湾项目的识别短语是白鹭-916。", { supersedes: project.id,
    expectedRevision: f.owner.store.getRevision(A) }), { code: "MCP_TOOL_FORBIDDEN" });
});

test("new workspace notes in generated chat homes belong to the Agent and survive a new conversation", async t => {
  const f = await fixture(t), first = turn(f, homeSession(f), "项目松桥的周报先列风险，再列进展。");
  const saved = await save(first, first.event.content.text, { scope: "workspace" }); first.finish();
  assert.equal(saved.item.scope, "agent");
  assert.ok(saved.item.sourceRefs.every(ref => !ref.startsWith("workspace:")));
  const second = turn(f, homeSession(f), "松桥周报怎么写？");
  assert.equal(second.memory.get(A, saved.item.id, second.run()).item.content, saved.item.content);
});

test("forget removes a same-source AGENTS copy, preserves other rules and stays idempotent", async t => {
  const f = await fixture(t), first = turn(f, conversation(f), "讨论杉湾项目周报时，先列进展，再列风险；该项目识别短语是白鹭-916。");
  const saved = await save(first, first.event.content.text);
  const base = agents(f), copied = "讨论杉湾项目周报时，先列进展，再列风险。该项目识别短语是白鹭-916。";
  await definition(f, first, `${base}\n${copied}\n独立规则：代码示例使用 TypeScript。\n`); first.finish();
  const current = turn(f, conversation(f), "忘记杉湾项目的识别短语和周报约定。");
  const args = { id: saved.item.id, expectedRevision: f.owner.store.getRevision(A), sourceQuote: current.event.content.text };
  await current.write("memory_forget", args);
  assert.equal(f.owner.store.get(A, saved.item.id).status, "deleted");
  assert.doesNotMatch(agents(f), /杉湾|白鹭/u);
  assert.ok(agents(f).startsWith(base));
  assert.match(agents(f), /TypeScript/u);
  const revision = f.service.agentDefinitionStore.get(A).manifest.revision;
  await current.write("memory_forget", args);
  assert.equal(f.service.agentDefinitionStore.get(A).manifest.revision, revision);
});

test("forget preserves a later edited linked rule and reports incomplete definition cleanup", async t => {
  const f = await fixture(t), first = turn(f, conversation(f), "杉湾项目的周报先列进展，再列风险。");
  const saved = await save(first, first.event.content.text);
  await definition(f, first, `${agents(f)}\n${first.event.content.text}\n`); first.finish();
  const store = f.service.agentDefinitionStore, latest = store.get(A);
  store.update({ profileId: A, expectedRevision: latest.manifest.revision, actor: "user",
    documents: { AGENTS: latest.documents.AGENTS.replace(first.event.content.text, `${first.event.content.text}独立追加：周五发布。`) } });
  await assert.rejects(f.owner.delete({ profileId: A, id: saved.item.id }), { code: "MEMORY_DEFINITION_REVIEW_REQUIRED" });
  assert.equal(f.owner.store.get(A, saved.item.id).status, "deleted");
  assert.match(agents(f), /周五发布/u);
});

test("definition cleanup can recover after a failed commit and does not delete an independently reintroduced rule", async t => {
  const f = await fixture(t), first = turn(f, conversation(f), "杉湾项目的周报先列进展，再列风险。");
  const saved = await save(first, first.event.content.text), base = agents(f);
  await definition(f, first, `${base}\n${first.event.content.text}\n`); first.finish();
  const store = f.service.agentDefinitionStore, original = store.update.bind(store);
  store.update = () => { throw new Error("simulated disk failure"); };
  await assert.rejects(f.owner.delete({ profileId: A, id: saved.item.id }), { code: "MEMORY_DEFINITION_COMMIT_UNCERTAIN" });
  assert.equal(f.owner.store.get(A, saved.item.id).status, "deleted");
  store.update = original;
  await f.owner.delete({ profileId: A, id: saved.item.id });
  assert.doesNotMatch(agents(f), /杉湾/u);
  const latest = store.get(A);
  store.update({ profileId: A, expectedRevision: latest.manifest.revision, actor: "user", documents: { AGENTS: `${agents(f)}\n${first.event.content.text}\n` } });
  await f.owner.delete({ profileId: A, id: saved.item.id });
  assert.match(agents(f), /杉湾/u);
});

test("legacy definition receipts retract the exact forgotten sentences without deleting other facts on the same line", async t => {
  const f = await fixture(t), first = turn(f, conversation(f), "杉湾项目的周报先列进展，再列风险。另一个项目周三开会。");
  const saved = await save(first, "杉湾项目的周报先列进展，再列风险。");
  await definition(f, first, `${agents(f)}\n${first.event.content.text}\n`, { legacy: true }); first.finish();
  assert.equal(await f.owner.definitionLinks.store(A).count(), 0);
  await f.owner.delete({ profileId: A, id: saved.item.id });
  assert.doesNotMatch(agents(f), /杉湾/u);
  assert.match(agents(f), /另一个项目周三开会/u);
  assert.equal(await f.owner.definitionLinks.store(A).count(), 1);
  await f.owner.delete({ profileId: A, id: saved.item.id });
  assert.match(agents(f), /另一个项目周三开会/u);
});

test("adding text to a pre-existing definition fact does not authorize automatic removal of that older fact", async t => {
  const f = await fixture(t), store = f.service.agentDefinitionStore, before = store.get(A);
  const fact = "杉湾项目的周报先列进展，再列风险。";
  store.update({ profileId: A, expectedRevision: before.manifest.revision, actor: "user",
    documents: { AGENTS: `${before.documents.AGENTS}\n${fact}\n` } });
  const first = turn(f, conversation(f), `${fact}另一个项目周三开会。`);
  const saved = await save(first, fact);
  await definition(f, first, agents(f).replace(fact, first.event.content.text)); first.finish();
  await assert.rejects(f.owner.delete({ profileId: A, id: saved.item.id }), { code: "MEMORY_DEFINITION_REVIEW_REQUIRED" });
  assert.match(agents(f), /杉湾/u);
  assert.match(agents(f), /另一个项目周三开会/u);
});

test("forgetting the audited correction wording removes the current code as well as the convention", async t => {
  const f = await fixture(t), first = turn(f, conversation(f),
    "讨论「杉湾」项目的周报时，先列进展，再列风险；该项目的内部识别短语是「白鹭-916」，旧短语「白鹭-583」已作废。");
  const saved = await save(first, first.event.content.text);
  await definition(f, first, `${agents(f)}\n讨论「杉湾」项目的周报时，先列进展，再列风险。该项目的内部识别短语是「白鹭-916」，出现该短语时按同一项目处理。\n`);
  first.finish();
  await f.owner.delete({ profileId: A, id: saved.item.id });
  assert.doesNotMatch(agents(f), /杉湾|白鹭/u);
});
