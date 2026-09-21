"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { createAgentLifecycleServiceController } = require("../app/agent-service/agent-lifecycle-service-controller");
const { AgentHarnessServiceController } = require("../app/agent-service/agent-harness-service-controller");
const { ConversationDefinitionService } = require("../app/agent-service/conversation-definition-service");
const { McpProductToolController, validateMcpProductToolArguments } = require("../app/agent-service/mcp-product-tool-controller");

async function fixture(t) {
  const f = contextFixture();
  const products = new JsonlProductStore({ paths: f.paths, now: () => 500 });
  products.open();
  products.putAgentProfile({ ...products.getAgentProfile(DEFAULT_AGENT_PROFILE_ID), id: "profile-1",
    agentId: "definition-fixture", runtimeProfileId: "definition-fixture", name: f.profile.name, isDefault: false });
  const noop = () => null;
  const lifecycle = createAgentLifecycleServiceController({ productStore: products,
    runtimeManager: { stop: noop }, initializeProfile: noop, activateProfile: noop, now: () => 500 });
  await lifecycle.open();
  const run = { ...f.run, status: "running" };
  const source = { source: run.source, sourceId: run.sourceId };
  const renames = [];
  const definitions = new ConversationDefinitionService({ definitionStore: f.definitions, productStore: products,
    agentLifecycleService: lifecycle, transcriptStore: f.transcripts,
    getRunSessionKey: () => run.sourceId, onProfileRenamed: (id) => renames.push(id),
    chatSessionStore: { getSession: (key) => key === run.sourceId ? {
      id: f.transcriptSessionId, sessionKey: key, profileId: run.profileId, workspace: run.workspace,
    } : null } });
  const createController = () => new McpProductToolController({ productStore: products,
    conversationDefinitionService: definitions, permissionEngine: f.permissions, domainController: { handle: noop },
    kanbanStore: Object.fromEntries(["getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId",
      "addComment", "addArtifact", "listArtifacts"].map((key) => [key, noop])),
    kanbanRunService: { requestCompletionFromAgent: noop }, cronStore: { getJob: noop },
    workDispatcher: { getRun: (id) => id === run.id ? run : null },
    getRuntimeContext: (id, selector) => id === run.profileId && selector.source === run.source
      && selector.sourceId === run.sourceId ? { ...source, profileId: id, runId: run.id } : null,
    notificationSender: noop, isSensitiveValue: () => false, artifactRoot: f.root, now: () => 500 });
  let controller = createController();
  const harness = new AgentHarnessServiceController({ productStore: products, definitionStore: f.definitions,
    memoryStore: f.memoryStore, memoryEngine: f.memoryEngine, chatSessionStore: { listSessions: () => [] },
    transcriptStore: f.transcripts, toolRegistry: f.permissions.toolRegistry, permissionEngine: f.permissions });
  f.append({ id: "user-request", kind: "user", content: { text:
    "以后你叫小墨，改得更温和一点，把先查证再回答加到长期工作规则中。把你的身份改成研究助理。也可以叫已占用。" } });
  const authority = () => ({ profileId: "profile-1", callId: crypto.randomUUID() });
  const call = (name, args, auth = authority()) => controller.handle(name, { ...source, ...args }, auth);
  const revision = () => f.definitions.get("profile-1").manifest.revision;
  const prepare = (kind, newText, extra = {}) => ({ kind, expectedRevision: revision(),
    oldText: f.definitions.get("profile-1").documents[kind], newText, sourceQuote: "改得更温和一点", ...extra });
  const compile = () => f.compiler.compile({ profile: products.getAgentProfile("profile-1"), run,
    transcriptSessionId: f.transcriptSessionId, query: "介绍一下自己" });
  t.after(async () => { await lifecycle.close(); products.close(); f.cleanup(); });
  return { ...f, products, run, source, definitionService: definitions, lifecycle, harness, renames, authority, call, revision, prepare,
    compile, resetController() { controller = createController(); } };
}
const rejects = (fn, code) => assert.rejects(fn, (error) => error.code === code);

test("three conversational definition edits share settings storage, preserve history and load next turn", async (t) => {
  const f = await fixture(t);
  const ancestor = path.join(f.root, "AGENTS.md");
  fs.writeFileSync(ancestor, "Unrelated workspace rules");
  const initial = f.compile();
  for (const [kind, content] of [["IDENTITY", "# Identity\n\n研究助理。\n"],
    ["SOUL", "# Soul\n\n温和、简洁。\n"], ["AGENTS", "# Operating Rules\n\n先查证再回答。\n"]]) {
    const read = await f.call("agent_definition_read", { kind });
    assert.equal(read.revision, f.revision());
    const saved = await f.call("agent_definition_update", f.prepare(kind, content));
    assert.equal(saved.saved, true);
    assert.equal(saved.effective, "next-turn");
    assert.equal(saved.revision, read.revision + 1);
    const shown = f.harness.handle("harness.definition.read", { profileId: "profile-1", kind, revision: null });
    assert.equal(shown.content, content);
    assert.equal(shown.revision, saved.revision);
    assert.equal(fs.readFileSync(path.join(f.paths.agentsDir, "profile-1", saved.agentRelativePath), "utf8"), content);
    const old = await f.call("agent_definition_read", { kind, revision: read.revision });
    assert.equal(old.content, read.content);
    assert.equal(old.currentRevision, saved.revision);
  }
  assert.equal(fs.readFileSync(ancestor, "utf8"), "Unrelated workspace rules");
  const next = f.compile();
  for (const expected of ["研究助理", "温和、简洁", "先查证再回答"]) {
    assert.ok(next.developerInstructions.includes(expected));
  }
  assert.doesNotMatch(initial.developerInstructions, /温和、简洁|研究助理/u);
  assert.deepEqual(f.snapshots.get("profile-1", initial.id), initial);
  assert.throws(() => f.definitions.update({ profileId: "profile-1", expectedRevision: f.revision(),
    actor: "agent", documents: { SOUL: "unauthorized" } }), (error) => error.code === "DEFINITION_WRITE_FORBIDDEN");
});

test("rename synchronizes Profile, IDENTITY and next context without changing runtime bindings", async (t) => {
  const f = await fixture(t);
  const before = f.products.getAgentProfile("profile-1");
  const args = f.prepare("IDENTITY", "# Identity\n- Name: 小墨\n研究助理。\n", { newName: "小墨", sourceQuote: "以后你叫小墨" });
  const auth = f.authority();
  const results = await Promise.all([f.call("agent_definition_update", args, auth), f.call("agent_definition_update", args, auth)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].profileName, "小墨");
  assert.equal(results[0].profileRenamed, true);
  assert.equal(f.revision(), args.expectedRevision + 1);
  const after = f.products.getAgentProfile("profile-1");
  assert.deepEqual({ ...after, name: before.name, updatedAt: before.updatedAt }, before);
  assert.match(f.compile().developerInstructions, /小墨/u);
  assert.equal(f.renames.includes("profile-1"), true);
  const other = f.products.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  f.products.putAgentProfile({ ...other, name: "已占用" });
  const beforeConflict = f.revision();
  await rejects(() => f.call("agent_definition_update", f.prepare("IDENTITY", "- Name: 已占用\n", {
    newName: "已占用", sourceQuote: "也可以叫已占用" })), "AGENT_NAME_CONFLICT");
  assert.equal(f.revision(), beforeConflict);
  assert.equal(f.products.getAgentProfile("profile-1").name, "小墨");
});

test("source, permission, revision, exact patch and input boundaries reject unsafe writes", async (t) => {
  const f = await fixture(t);
  const args = f.prepare("SOUL", "温和。");
  await rejects(() => f.call("agent_definition_update", { ...args, sourceQuote: "用户没有说过" }), "MCP_TOOL_INVALID_ARGUMENTS");
  f.append({ id: "assistant-only", kind: "assistant", content: { text: "由助手提出" } });
  f.append({ id: "excluded", kind: "user", contextExcluded: true, content: { text: "已排除的请求" } });
  for (const sourceQuote of ["由助手提出", "已排除的请求"]) {
    await rejects(() => f.call("agent_definition_update", { ...args, sourceQuote }), "MCP_TOOL_INVALID_ARGUMENTS");
  }
  await rejects(() => f.call("agent_definition_update", { ...args, newText: "password=fixture-password-value" }), "MCP_TOOL_SECRET_REJECTED");
  await rejects(() => f.call("agent_definition_update", { ...args, oldText: "" }), "MCP_TOOL_STATE_CONFLICT");
  await rejects(() => f.call("agent_definition_update", { ...args, expectedRevision: 99 }), "MCP_TOOL_STATE_CONFLICT");
  await rejects(() => f.call("agent_definition_read", { kind: "SOUL", sourceId: "other-session" }), "MCP_TOOL_NOT_FOUND");
  f.run.idempotencyKey = "shoggoth:chat-send:federation-send-other";
  await rejects(() => f.call("agent_definition_update", args), "MCP_TOOL_FORBIDDEN");
  delete f.run.idempotencyKey;
  f.permissions.setProfileOverride("profile-1", "agent_definition_update", "deny");
  await rejects(() => f.call("agent_definition_update", args), "MCP_TOOL_FORBIDDEN");
  f.permissions.setProfileOverride("profile-1", "agent_definition_update", "allow");
  for (const extra of [{ kind: "USER" }, { kind: "MEMORY" }, { path: "/tmp/AGENTS.md" }, { profileId: "other" },
    { newText: "\uD800" }, { newText: "\0" }, { newName: "only-identity" }]) {
    assert.equal(validateMcpProductToolArguments("agent_definition_update", { ...f.source, ...args, ...extra }), false);
  }
  const getter = { ...f.source, kind: "SOUL" };
  Object.defineProperty(getter, "offset", { get() { throw new Error("must not invoke getter"); } });
  assert.equal(validateMcpProductToolArguments("agent_definition_read", getter), false);
  await rejects(() => f.call("agent_definition_update", f.prepare("IDENTITY", "- Name: 小墨\n")), "MCP_TOOL_INVALID_ARGUMENTS");
  await rejects(() => f.call("agent_definition_update", f.prepare("IDENTITY", "- Name: 其他\n", { newName: "小墨" })), "MCP_TOOL_INVALID_ARGUMENTS");
  assert.equal(f.revision(), 1);
});

test("bounded Unicode reads and targeted patch preserve unseen content; empty files remain editable", async (t) => {
  const f = await fixture(t);
  const original = `# Soul\n${"🙂甲".repeat(2500)}\nkeep this tail\n`;
  await f.call("agent_definition_update", f.prepare("SOUL", original));
  let offset = 0; let combined = "";
  do {
    const part = await f.call("agent_definition_read", { kind: "SOUL", offset, limit: 999 });
    assert.ok(part.content.isWellFormed());
    combined += part.content;
    offset = part.nextOffset;
  } while (offset !== null);
  assert.equal(combined, original);
  await rejects(() => f.call("agent_definition_update", f.prepare("SOUL", "乙", { oldText: "甲" })), "MCP_TOOL_STATE_CONFLICT");
  await f.call("agent_definition_update", f.prepare("SOUL", "# Warm Soul", { oldText: "# Soul" }));
  assert.equal(f.definitions.get("profile-1").documents.SOUL, original.replace("# Soul", "# Warm Soul"));
  await f.call("agent_definition_update", f.prepare("SOUL", ""));
  assert.equal((await f.call("agent_definition_read", { kind: "SOUL" })).content, "");
  await f.call("agent_definition_update", f.prepare("SOUL", "Warm again."));
  assert.equal((await f.call("agent_definition_read", { kind: "SOUL" })).content, "Warm again.");
});

test("concurrent UI edit during rename is preserved and reports the partial rename for a fresh retry", async (t) => {
  const f = await fixture(t);
  const originalHandle = f.lifecycle.handle.bind(f.lifecycle);
  let inject = true;
  f.lifecycle.handle = async (...args) => {
    const result = await originalHandle(...args);
    if (inject) {
      inject = false;
      f.harness.handle("harness.definition.update", { profileId: "profile-1", kind: "SOUL",
        content: "Concurrent UI edit", expectedRevision: f.revision(), reason: "ui" });
    }
    return result;
  };
  const result = await f.call("agent_definition_update", f.prepare("IDENTITY", "- Name: 小墨\n", { newName: "小墨" }));
  assert.equal(result.saved, false);
  assert.equal(result.profileRenamed, true);
  assert.equal(result.status, "definition-conflict");
  assert.equal(f.products.getAgentProfile("profile-1").name, "小墨");
  assert.doesNotMatch((await f.call("agent_definition_read", { kind: "IDENTITY" })).content, /小墨/u);
  const retry = await f.call("agent_definition_update", f.prepare("IDENTITY", "- Name: 小墨\n", { newName: "小墨" }));
  assert.equal(retry.saved, true);
  assert.equal((await f.call("agent_definition_read", { kind: "SOUL" })).content, "Concurrent UI edit");
});

test("lost outer receipt recovers the committed revision without reverting a later edit", async (t) => {
  const f = await fixture(t);
  const args = f.prepare("SOUL", "Warm persona");
  const auth = f.authority();
  const complete = f.products.completeMcpToolCall.bind(f.products);
  f.products.completeMcpToolCall = () => { const error = new Error("receipt lost"); error.code = "STORE_COMMIT_UNCERTAIN"; throw error; };
  await rejects(() => f.call("agent_definition_update", args, auth), "MCP_TOOL_COMMIT_UNCERTAIN");
  f.products.completeMcpToolCall = complete;
  const appliedRevision = f.revision();
  f.harness.handle("harness.definition.update", { profileId: "profile-1", kind: "SOUL",
    content: "Later UI edit", expectedRevision: appliedRevision, reason: "ui" });
  f.products.close(); f.products.open();
  f.resetController();
  const recovered = await f.call("agent_definition_update", args, auth);
  assert.equal(recovered.saved, true);
  assert.equal(recovered.revision, appliedRevision);
  assert.equal(recovered.currentRevision, appliedRevision + 1);
  assert.equal((await f.call("agent_definition_read", { kind: "SOUL" })).content, "Later UI edit");
  assert.deepEqual(await f.call("agent_definition_update", args, auth), recovered);
});

for (const checkpoint of ["revision-installed", "manifest-committed"]) {
  test(`filesystem failure at ${checkpoint} reconciles on restart after a Profile rename`, async (t) => {
    const f = await fixture(t);
    const args = f.prepare("IDENTITY", "- Name: 小墨\n", { newName: "小墨" });
    const auth = f.authority();
    f.definitions.faultInjector = (point) => { if (point === checkpoint) throw new Error("simulated crash"); };
    await rejects(() => f.call("agent_definition_update", args, auth), "MCP_TOOL_COMMIT_UNCERTAIN");
    assert.equal(f.products.getAgentProfile("profile-1").name, "小墨");
    f.definitions.faultInjector = null;
    f.definitions.close(); f.definitions.open();
    f.products.close(); f.products.open();
    f.resetController();
    const recovered = await f.call("agent_definition_update", args, auth);
    assert.equal(recovered.saved, true);
    assert.equal(recovered.revision, args.expectedRevision + 1);
    assert.equal((await f.call("agent_definition_read", { kind: "IDENTITY" })).content, "- Name: 小墨\n");
  });
}
