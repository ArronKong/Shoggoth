"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { LEGACY_MEMORY_RULE, CURRENT_MEMORY_RULE, createDefaultDocuments } = require("../app/agent-service/agent-definition-defaults");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");
const { PermissionEngine } = require("../app/agent-service/permission-engine");

test("upgrade drains legacy queue atomically, preserves confidence and never revives forgotten facts", (t) => {
  const f = memoryFixture(); t.after(() => f.cleanup());
  const base = f.engine.propose({ profileId: "profile-1", scope: "user", type: "semantic",
    content: "用户原来的称呼", sourceRefs: ["old-user"], classification: "explicit" });
  const legacy = (id, content, extra = {}) => ({ ...base, id, content, status: "candidate", ...extra });
  f.store.upsertMany([
    legacy("private-fact", "用户邮箱 owner@example.com", { sensitivity: "private" }),
    legacy("imported-fact", "旧版本导入的项目背景", { confidence: 0.5 }),
    legacy("new-name", "用户更正后的称呼", { supersedes: base.id }),
    legacy("obsolete-name", "已经过时的另一称呼", { supersedes: base.id, createdAt: base.createdAt + 1, updatedAt: base.updatedAt + 1 }),
    legacy("expired", "过期资料", { validFrom: 0, validUntil: 1 }),
    legacy("restricted", "受限资料", { sensitivity: "restricted" }),
    { ...base, id: "forgotten", status: "deleted" },
    legacy("forgotten-replacement", "不得复活的资料", { supersedes: "forgotten" }),
  ]);
  f.engine.close(); f.store.close(); f.store.open(); f.engine.open(["profile-1"]);
  assert.equal(f.store.list("profile-1", { status: "candidate" }).length, 0);
  for (const id of ["private-fact", "imported-fact", "new-name"]) assert.equal(f.store.get("profile-1", id).status, "active");
  assert.equal(f.store.get("profile-1", "imported-fact").confidence, 0.5);
  assert.deepEqual(f.store.get("profile-1", "private-fact").sourceRefs, base.sourceRefs);
  for (const id of [base.id, "obsolete-name", "forgotten-replacement"]) assert.equal(f.store.get("profile-1", id).status, "superseded");
  for (const id of ["forgotten", "expired", "restricted"]) assert.equal(f.store.get("profile-1", id).status, "deleted");
  const content = f.definitions.readGeneratedView("profile-1", "MEMORY").content;
  assert.match(content, /owner@example.com|更正后的称呼/u);
  assert.doesNotMatch(content, /原来的称呼|过时的另一称呼|过期资料|受限资料|不得复活/u);
  const state = f.store.exportProfile("profile-1");
  f.engine.close(); f.engine.open(["profile-1"]);
  assert.deepEqual(f.store.exportProfile("profile-1"), state);
  assert.equal(f.engine.confirm({ profileId: "profile-1", id: "private-fact" }).status, "active", "old local confirm callers are harmless and idempotent");
  assert.deepEqual(f.store.exportProfile("profile-1"), state);
});

test("v2 product memory paragraph upgrades while custom names and rules survive", (t) => {
  const f = memoryFixture(); t.after(() => f.cleanup());
  for (const actor of ["bootstrap", "import", "restore"]) {
    const profileId = `v2-${actor}`;
    const documents = createDefaultDocuments("松桥");
    documents.AGENTS = documents.AGENTS.replace(CURRENT_MEMORY_RULE, LEGACY_MEMORY_RULE) + "\n先说建议，再列待办。\n";
    documents.SOUL = "用户自定语气，保持不变。";
    f.definitions._commit({ profileId, expectedRevision: 0, documents, actor: "bootstrap", reason: "default-profile:v2" });
    if (actor !== "bootstrap") f.definitions.update({ profileId, expectedRevision: 1, documents, actor });
    const before = f.definitions.get(profileId);
    const next = f.definitions.ensureProfile({ profileId, profileName: "松桥" });
    assert.equal(next.documents.IDENTITY, documents.IDENTITY);
    assert.equal(next.documents.SOUL, documents.SOUL);
    assert.match(next.documents.AGENTS, /先说建议，再列待办/u);
    if (actor === "bootstrap") {
      assert.ok(next.documents.AGENTS.includes(CURRENT_MEMORY_RULE));
      assert.ok(!next.documents.AGENTS.includes(LEGACY_MEMORY_RULE));
      assert.deepEqual(f.definitions.readRevision(profileId, 1).documents, documents);
    } else assert.deepEqual(next, before);
    assert.deepEqual(f.definitions.ensureProfile({ profileId, profileName: "松桥" }), next);
  }
});

test("tool catalog has no memory confirmation action and requires the user's quote", () => {
  const tools = DEFAULT_TOOL_REGISTRY.mcpDefinitions();
  assert.equal(tools.some((tool) => tool.name === "memory_confirm"), false);
  assert.doesNotMatch(DEFAULT_TOOL_REGISTRY.toolsMarkdown(), /memory_confirm|unconfirmed notes|inferred facts stay candidates/u);
  const schema = tools.find((tool) => tool.name === "memory_save").inputSchema;
  assert.deepEqual(schema.properties.classification.enum, ["explicit"]);
  assert.ok(schema.required.includes("sourceQuote"));
});

test("retiring memory confirmation preserves unrelated persisted permissions", (t) => {
  const f = memoryFixture(); t.after(() => f.cleanup());
  fs.mkdirSync(path.dirname(f.paths.toolPolicyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f.paths.toolPolicyPath, JSON.stringify({ schemaVersion: 1, revision: 7,
    profiles: { "profile-1": { memory_confirm: "deny", memory_save: "deny", computer_session_open: "deny" } } }), { mode: 0o600 });
  const permissions = new PermissionEngine({ paths: f.paths, toolRegistry: DEFAULT_TOOL_REGISTRY });
  permissions.open(["profile-1"]);
  const persisted = JSON.parse(fs.readFileSync(f.paths.toolPolicyPath));
  assert.deepEqual(persisted.profiles["profile-1"], { memory_save: "deny", computer_session_open: "deny" });
  assert.equal(persisted.revision, 8);
  permissions.close(); permissions.open(["profile-1"]);
  assert.equal(permissions.revision, 8);
});
