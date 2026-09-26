"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { BUILTIN_CLI_AGENT_PROFILES } = require("../app/agent-service/builtin-cli-profiles");
const { defaultAgentProfile } = require("../app/agent-service/product-store");
const { isRuntimeAvailable } = require("../app/runtime-availability");
const { DEFAULT_TEMPLATE_VERSION, DEFAULT_DOCUMENTS, LEGACY_DEFAULT_DOCUMENTS,
  VIEW_HEADERS, EMPTY_VIEW_MESSAGES, createDefaultDocuments } = require("../app/agent-service/agent-definition-defaults");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");
const NATIVE_PROFILES = [defaultAgentProfile(500), ...BUILTIN_CLI_AGENT_PROFILES];

function fixture(t) {
  const value = contextFixture();
  t.after(() => value.cleanup());
  return value;
}
function legacy(f, id) {
  // Seed exactly the old on-disk bootstrap contract, without running v2 ensureProfile.
  return f.definitions._commit({ profileId: id, expectedRevision: 0,
    documents: { ...LEGACY_DEFAULT_DOCUMENTS }, actor: "bootstrap", reason: "default-profile", createdAt: 500 });
}
function update(f, id, documents, actor = "user") {
  return f.definitions.update({ profileId: id, expectedRevision: f.definitions.get(id).manifest.revision,
    actor, documents });
}

test("all native identities use their Profile name and inject complete v2 defaults", (t) => {
  const f = fixture(t);
  assert.deepEqual(NATIVE_PROFILES.filter((profile) => isRuntimeAvailable(profile.runtime))
    .map(({ name }) => name), ["Shoggoth", "Codex", "Grok", "Antigravity", "Pi", "OpenCode", "DeepSeek"]);
  for (const profile of NATIVE_PROFILES) {
    const value = f.definitions.ensureProfile({ profileId: profile.id, profileName: profile.name });
    assert.equal(value.manifest.revision, 1);
    assert.equal(value.manifest.reason, `default-profile:v${DEFAULT_TEMPLATE_VERSION}`);
    assert.deepEqual([...value.documents.IDENTITY.matchAll(/^- Name: (.+)$/gmu)].map((m) => m[1]), [profile.name]);
    assert.doesNotMatch(value.documents.IDENTITY, /You are the Shoggoth agent/u);
    f.memoryStore.ensureProfile(profile.id);
    f.memoryEngine.rebuildViews(profile.id);
    assert.equal(f.memoryStore.getRevision(profile.id), 0, "template prose must not become user memory");
    assert.equal(f.definitions.get(profile.id).manifest.revision, 1, "empty USER projection equals bootstrap USER");
    const snapshot = f.compiler.compile({ profile: { ...f.profile, ...profile },
      run: { ...f.run, profileId: profile.id }, transcriptSessionId: f.transcriptSessionId, query: "你好" });
    assert.deepEqual(snapshot.report.truncatedBlocks, []);
    for (const kind of ["IDENTITY", "SOUL", "AGENTS"]) {
      assert.ok(snapshot.developerInstructions.includes(value.documents[kind]));
    }
    assert.equal(snapshot.blocks.some((block) => block.id === "user"), false);
    assert.equal(snapshot.blocks.some((block) => block.id === "memory"), false);
    const identity = JSON.parse(snapshot.developerInstructions.match(
      /^Active Agent Profile identity .*?: (.+)$/mu,
    )[1]);
    assert.deepEqual(identity, { name: profile.name, backendId: profile.backendId, runtime: profile.runtime });
    assert.equal(snapshot.developerInstructions.includes("unnamespaced Codex request_user_input"),
      profile.runtime === "codex", "Codex-only tool guidance must not leak into other runtimes");
    assert.doesNotMatch(snapshot.developerInstructions, /You are the Shoggoth App's native Agent/u);
  }
});

test("builtin DeepSeek identity follows the renamed default Profile without changing other documents", (t) => {
  const f = fixture(t);
  const spec = BUILTIN_CLI_AGENT_PROFILES.find((profile) => profile.runtime === "deepseek-harness");
  const original = f.definitions.ensureProfile({ profileId: spec.id, profileName: "DeepSeek Harness" });
  const edited = f.definitions.update({ profileId: spec.id, expectedRevision: original.manifest.revision,
    documents: { SOUL: "自定义相处方式" }, actor: "user" });
  const migrated = f.definitions.ensureProfile({ profileId: spec.id, profileName: spec.name });
  assert.equal(migrated.manifest.revision, edited.manifest.revision + 1);
  assert.equal(migrated.manifest.reason, "builtin-deepseek-name");
  assert.match(migrated.documents.IDENTITY, /^- Name: DeepSeek$/mu);
  assert.equal(migrated.documents.SOUL, "自定义相处方式");
  assert.equal(f.definitions.readRevision(spec.id, original.manifest.revision).documents.IDENTITY,
    original.documents.IDENTITY);
  assert.deepEqual(f.definitions.ensureProfile({ profileId: spec.id, profileName: spec.name }), migrated);
});

test("older untouched DeepSeek identity keeps its original body when renamed", (t) => {
  const f = fixture(t);
  const spec = BUILTIN_CLI_AGENT_PROFILES.find((profile) => profile.runtime === "deepseek-harness");
  const documents = createDefaultDocuments("DeepSeek Harness");
  documents.IDENTITY += "\n旧版默认说明。\n";
  const original = f.definitions._commit({ profileId: spec.id, expectedRevision: 0,
    documents, actor: "bootstrap", reason: "old-default", createdAt: 500 });
  const migrated = f.definitions.ensureProfile({ profileId: spec.id, profileName: spec.name });
  assert.equal(migrated.documents.IDENTITY,
    original.documents.IDENTITY.replace("- Name: DeepSeek Harness", "- Name: DeepSeek"));
  assert.equal(migrated.manifest.revision, original.manifest.revision + 1);
});

test("customized DeepSeek identity keeps the saved name on default Profile migration", (t) => {
  const f = fixture(t);
  const spec = BUILTIN_CLI_AGENT_PROFILES.find((profile) => profile.runtime === "deepseek-harness");
  const original = f.definitions.ensureProfile({ profileId: spec.id, profileName: "DeepSeek Harness" });
  const customized = f.definitions.update({ profileId: spec.id,
    expectedRevision: original.manifest.revision,
    documents: { IDENTITY: original.documents.IDENTITY.replace("- Name: DeepSeek Harness", "- Name: 我的助手") },
    actor: "user" });
  assert.deepEqual(f.definitions.ensureProfile({ profileId: spec.id, profileName: spec.name }), customized);
});

test("restored DeepSeek identity is not silently rewritten", (t) => {
  const f = fixture(t);
  const spec = BUILTIN_CLI_AGENT_PROFILES.find((profile) => profile.runtime === "deepseek-harness");
  const original = f.definitions.ensureProfile({ profileId: spec.id, profileName: "DeepSeek Harness" });
  const customized = f.definitions.update({ profileId: spec.id,
    expectedRevision: original.manifest.revision,
    documents: { IDENTITY: original.documents.IDENTITY.replace("- Name: DeepSeek Harness", "- Name: 我的助手") },
    actor: "user" });
  const restored = f.definitions.restore({ profileId: spec.id,
    expectedRevision: customized.manifest.revision, revision: original.manifest.revision });
  assert.deepEqual(f.definitions.ensureProfile({ profileId: spec.id, profileName: spec.name }), restored);
});

test("six backends keep customized names, definitions and user memories separate", (t) => {
  const f = fixture(t);
  const profiles = NATIVE_PROFILES.filter((profile) => isRuntimeAvailable(profile.runtime));
  for (const profile of profiles) {
    f.definitions.ensureProfile({ profileId: profile.id, profileName: profile.name });
    f.memoryStore.ensureProfile(profile.id);
    f.memoryEngine.propose({ profileId: profile.id, scope: "user", type: "semantic", classification: "explicit",
      content: `用户希望 ${profile.name} 的回答使用专属称呼。`, sourceRefs: ["user-message"] });
    f.memoryEngine.propose({ profileId: profile.id, scope: "agent", type: "semantic", classification: "explicit",
      content: `这是 ${profile.name} 的长期记忆标记。`, sourceRefs: ["user-message"] });
    update(f, profile.id, { SOUL: `${profile.name} 的专属相处方式。`, AGENTS: `${profile.name} 的专属工作规则。` });
  }
  for (const profile of profiles) {
    const definition = f.definitions.get(profile.id);
    const memory = f.definitions.readGeneratedView(profile.id, "MEMORY").content;
    const snapshot = f.compiler.compile({ profile: { ...f.profile, ...profile },
      run: { ...f.run, profileId: profile.id }, transcriptSessionId: f.transcriptSessionId, query: "长期记忆" });
    for (const other of profiles) {
      const belongs = other.id === profile.id;
      assert.equal(definition.documents.USER.includes(`用户希望 ${other.name} 的回答使用专属称呼。`), belongs);
      assert.equal(memory.includes(`这是 ${other.name} 的长期记忆标记。`), belongs);
      assert.equal(snapshot.dynamicContext.includes(`这是 ${other.name} 的长期记忆标记。`), belongs);
      assert.equal(snapshot.developerInstructions.includes(`${other.name} 的专属相处方式。`), belongs);
      assert.equal(snapshot.developerInstructions.includes(`${other.name} 的专属工作规则。`), belongs);
    }
    assert.deepEqual(f.definitions.ensureProfile({ profileId: profile.id, profileName: profile.name }), definition);
  }
  const named = { ...profiles[1], id: "custom-codex", name: "小码" };
  const definition = f.definitions.ensureProfile({ profileId: named.id, profileName: named.name });
  f.memoryStore.ensureProfile(named.id);
  assert.match(definition.documents.IDENTITY, /^- Name: 小码$/mu);
  const snapshot = f.compiler.compile({ profile: { ...f.profile, ...named },
    run: { ...f.run, profileId: named.id }, transcriptSessionId: f.transcriptSessionId, query: "你叫什么" });
  assert.match(snapshot.developerInstructions, /"name":"小码","backendId":"codex","runtime":"codex"/u);
});

test("untouched legacy defaults upgrade once, preserve history and keep frozen context", (t) => {
  const f = fixture(t);
  const id = "legacy-clean";
  legacy(f, id);
  assert.deepEqual(f.definitions.ensureProfile({ profileId: id }).documents, LEGACY_DEFAULT_DOCUMENTS,
    "an old caller without the authoritative Profile name must not invent a name during migration");
  const profile = { ...f.profile, id, name: "旧 Agent 的当前名字" };
  const snapshot = f.compiler.compile({ profile, run: { ...f.run, profileId: id },
    transcriptSessionId: f.transcriptSessionId, query: "你的设定" });
  const upgraded = f.definitions.ensureProfile({ profileId: id, profileName: profile.name });
  assert.equal(upgraded.manifest.revision, 2);
  assert.equal(upgraded.manifest.reason, `default-template:v${DEFAULT_TEMPLATE_VERSION}`);
  assert.deepEqual(upgraded.documents, createDefaultDocuments(profile.name));
  assert.deepEqual(f.definitions.readRevision(id, 1).documents, LEGACY_DEFAULT_DOCUMENTS);
  assert.deepEqual(f.snapshots.get(id, snapshot.id), snapshot);
  assert.ok(snapshot.developerInstructions.includes(LEGACY_DEFAULT_DOCUMENTS.SOUL));
  f.definitions.close(); f.definitions.open();
  assert.deepEqual(f.definitions.ensureProfile({ profileId: id, profileName: profile.name }), upgraded);
});

test("upgrade only untouched files and preserve customized definitions and recorded profile facts", (t) => {
  const f = fixture(t);
  const id = "legacy-custom";
  legacy(f, id);
  update(f, id, { SOUL: "用户定制的人设，请逐字保留。" });
  update(f, id, { USER: "# User\n\n- 现有用户资料。\n" }, "memory-engine");
  const upgraded = f.definitions.ensureProfile({ profileId: id, profileName: "Custom" });
  assert.equal(upgraded.manifest.revision, 4);
  assert.equal(upgraded.documents.SOUL, "用户定制的人设，请逐字保留。");
  assert.equal(upgraded.documents.USER, "# User\n\n- 现有用户资料。\n");
  assert.equal(upgraded.documents.AGENTS, DEFAULT_DOCUMENTS.AGENTS);
  assert.match(upgraded.documents.IDENTITY, /^- Name: Custom$/mu);
  assert.deepEqual(f.definitions.ensureProfile({ profileId: id, profileName: "Custom" }), upgraded);
});

test("edited-back, empty, imported and deliberately restored definitions keep user intent", (t) => {
  const f = fixture(t);
  const id = "legacy-edited-back";
  legacy(f, id);
  update(f, id, { SOUL: "temporary custom text", AGENTS: "" });
  update(f, id, { SOUL: LEGACY_DEFAULT_DOCUMENTS.SOUL });
  const upgraded = f.definitions.ensureProfile({ profileId: id, profileName: "Custom" });
  assert.equal(upgraded.documents.SOUL, LEGACY_DEFAULT_DOCUMENTS.SOUL);
  assert.equal(upgraded.documents.AGENTS, "");
  assert.match(upgraded.documents.IDENTITY, /^- Name: Custom$/mu);
  for (const actor of ["import", "restore"]) {
    const profileId = `legacy-${actor}`;
    legacy(f, profileId);
    const chosen = update(f, profileId, { ...LEGACY_DEFAULT_DOCUMENTS }, actor);
    assert.deepEqual(f.definitions.ensureProfile({ profileId, profileName: "Keep" }), chosen);
  }
  const restoreId = "legacy-upgrade-restore";
  legacy(f, restoreId);
  f.definitions.ensureProfile({ profileId: restoreId, profileName: "Keep" });
  const restored = f.definitions.restore({ profileId: restoreId, revision: 1, expectedRevision: 2 });
  assert.deepEqual(f.definitions.ensureProfile({ profileId: restoreId, profileName: "Keep" }), restored);
});

for (const checkpoint of ["revision-ready", "revision-installed", "manifest-committed"]) {
  test(`default upgrade recovers atomically after ${checkpoint}`, (t) => {
    const f = fixture(t);
    const id = "legacy-crash";
    legacy(f, id);
    f.definitions.faultInjector = (point) => { if (point === checkpoint) throw new Error("simulated crash"); };
    assert.throws(() => f.definitions.ensureProfile({ profileId: id, profileName: "恢复后的名字" }), /simulated crash/u);
    f.definitions.close(); f.definitions.faultInjector = null; f.definitions.open();
    const recovered = f.definitions.ensureProfile({ profileId: id, profileName: "恢复后的名字" });
    assert.equal(recovered.manifest.revision, 2);
    assert.deepEqual(recovered.documents, createDefaultDocuments("恢复后的名字"));
    assert.deepEqual(f.definitions.readRevision(id, 1).documents, LEGACY_DEFAULT_DOCUMENTS);
  });
}

test("generated USER/MEMORY distinguish empty state from real facts without rewriting memory records", (t) => {
  const f = fixture(t);
  assert.equal(f.definitions.get("profile-1").documents.USER, VIEW_HEADERS.USER + EMPTY_VIEW_MESSAGES.USER);
  assert.equal(f.definitions.readGeneratedView("profile-1", "MEMORY").content, VIEW_HEADERS.MEMORY + EMPTY_VIEW_MESSAGES.MEMORY);
  f.memoryEngine.propose({ profileId: "profile-1", scope: "user", type: "semantic", classification: "explicit",
    content: "用户要求使用繁体中文。", sourceRefs: ["actual-user-message"] });
  assert.throws(() => f.memoryEngine.propose({ profileId: "profile-1", scope: "agent", type: "semantic", classification: "inferred",
    content: "用户可能喜欢某种设计风格。", sourceRefs: ["unconfirmed-inference"] }), (error) => error.code === "MEMORY_INVALID");
  const records = f.memoryStore.exportProfile("profile-1");
  f.memoryEngine.rebuildViews("profile-1");
  assert.deepEqual(f.memoryStore.exportProfile("profile-1"), records);
  for (const content of [f.definitions.get("profile-1").documents.USER,
    f.definitions.readGeneratedView("profile-1", "MEMORY").content]) {
    assert.match(content, /用户要求使用繁体中文/u);
    assert.doesNotMatch(content, /尚未保存|用户可能喜欢/u);
  }
});

test("tool guide is generated from the live registry and template names cannot introduce extra fields", () => {
  const markdown = DEFAULT_TOOL_REGISTRY.toolsMarkdown();
  assert.ok(markdown.startsWith(VIEW_HEADERS.TOOLS));
  assert.ok(Buffer.byteLength(markdown) <= 32 * 1024);
  assert.deepEqual([...markdown.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1]),
    DEFAULT_TOOL_REGISTRY.mcpDefinitions().map((tool) => tool.name));
  const referenced = ["memory_search", "memory_save", "memory_forget", "agent_definition_read", "agent_definition_update"];
  for (const name of referenced) assert.ok(DEFAULT_TOOL_REGISTRY.get(name));
  const name = "用户名字\n- Name: injected\n# Injected header";
  const identity = createDefaultDocuments(name).IDENTITY;
  assert.equal([...identity.matchAll(/^- Name: /gmu)].length, 0);
  const encoded = identity.match(/^- Profile name \(JSON\): (.+)$/mu)[1];
  assert.equal(JSON.parse(encoded), name);
  assert.doesNotMatch(identity, /^# Injected header$/mu);
});
