"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AgentDefinitionStore,
  DOCUMENT_KINDS,
} = require("../app/agent-service/agent-definition-store");
const { resolveServicePaths } = require("../app/agent-service/paths");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-definition-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  let now = 1000;
  let uuid = 0;
  const store = new AgentDefinitionStore({
    paths,
    now: () => now++,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    ...options,
  });
  return { root, paths, store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("bootstrap 创建完整 revision，重启后 hash 与内容保持一致", () => {
  const value = fixture();
  try {
    value.store.open();
    const created = value.store.ensureProfile({ profileId: "profile-1" });
    assert.equal(created.manifest.revision, 1);
    assert.deepEqual(Object.keys(created.documents), DOCUMENT_KINDS);
    value.store.close();
    value.store.open();
    assert.deepEqual(value.store.get("profile-1"), created);
  } finally { value.cleanup(); }
});

test("创建身份在 bootstrap 后恢复，保留其他文件，拒绝覆盖已编辑身份", () => {
  const value = fixture();
  try {
    value.store.open();
    const input = { profileId: "profile-create", profileName: "测试", initialIdentity: "辅助助理，协助完成任务。" };
    const initial = value.store.ensureProfile({ profileId: input.profileId, profileName: input.profileName });
    value.store.update({ profileId: input.profileId, expectedRevision: initial.manifest.revision,
      documents: { SOUL: "Preserve this independent change." }, actor: "user" });
    value.store.close(); value.store.open();
    const recovered = value.store.ensureProfile(input);
    assert.ok(recovered.documents.IDENTITY.includes(input.initialIdentity));
    assert.equal(recovered.documents.SOUL, "Preserve this independent change.");
    assert.deepEqual(value.store.ensureProfile(input), recovered, "exact retry must not create a revision");
    value.store.update({ profileId: input.profileId, expectedRevision: recovered.manifest.revision,
      documents: { IDENTITY: "A newer user identity." }, actor: "user" });
    assert.throws(() => value.store.ensureProfile(input), { code: "DEFINITION_REVISION_CONFLICT" });
    assert.equal(value.store.get(input.profileId).documents.IDENTITY, "A newer user identity.");
  } finally { value.cleanup(); }
});

test("用户提交使用 expected revision，Agent 只能 proposal 不能 commit", () => {
  const value = fixture();
  try {
    value.store.open();
    value.store.ensureProfile({ profileId: "profile-1" });
    const updated = value.store.update({
      profileId: "profile-1",
      expectedRevision: 1,
      documents: { SOUL: "# Soul\n\nBe concise.\n" },
      actor: "user",
    });
    assert.equal(updated.manifest.revision, 2);
    assert.throws(() => value.store.update({
      profileId: "profile-1",
      expectedRevision: 1,
      documents: { SOUL: "stale" },
      actor: "user",
    }), (error) => error.code === "DEFINITION_REVISION_CONFLICT" && error.currentRevision === 2);
    assert.throws(() => value.store.update({
      profileId: "profile-1",
      expectedRevision: 2,
      documents: { SOUL: "agent write" },
      actor: "agent",
    }), (error) => error.code === "DEFINITION_WRITE_FORBIDDEN");
    const proposal = value.store.propose({
      profileId: "profile-1",
      actor: "agent",
      documents: { AGENTS: "# Proposed rule\n" },
    });
    assert.equal(proposal.status, "candidate");
    assert.equal(value.store.get("profile-1").manifest.revision, 2);
  } finally { value.cleanup(); }
});

test("Memory Engine 只可更新 USER，派生 TOOLS/MEMORY 不进入导出真源", () => {
  const value = fixture();
  try {
    value.store.open();
    value.store.ensureProfile({ profileId: "profile-1" });
    value.store.update({
      profileId: "profile-1",
      expectedRevision: 1,
      documents: { USER: "# User\n\nPrefers Chinese.\n" },
      actor: "memory-engine",
    });
    assert.throws(() => value.store.update({
      profileId: "profile-1",
      expectedRevision: 2,
      documents: { IDENTITY: "forbidden" },
      actor: "memory-engine",
    }), (error) => error.code === "DEFINITION_WRITE_FORBIDDEN");
    value.store.writeGeneratedView({
      profileId: "profile-1", kind: "TOOLS", revision: 7, content: "# Tools\n",
    });
    value.store.writeGeneratedView({
      profileId: "profile-1", kind: "MEMORY", revision: 8, content: "# Memory\n",
    });
    assert.equal(value.store.readGeneratedView("profile-1", "TOOLS").revision, 7);
    const exported = value.store.export("profile-1");
    assert.deepEqual(Object.keys(exported.documents), DOCUMENT_KINDS);
    assert.equal(Object.hasOwn(exported.documents, "TOOLS"), false);
  } finally { value.cleanup(); }
});

test("import 必须先 preview，拒绝 generated 字段并以新 revision 原子切换", () => {
  const source = fixture();
  const target = fixture();
  try {
    source.store.open();
    target.store.open();
    source.store.ensureProfile({ profileId: "source" });
    target.store.ensureProfile({ profileId: "target" });
    source.store.update({
      profileId: "source", expectedRevision: 1, actor: "user",
      documents: { IDENTITY: "# Imported identity\n" },
    });
    const bundle = source.store.export("source");
    const preview = target.store.previewImport({ profileId: "target", bundle });
    assert.equal(preview.baseRevision, 1);
    assert.equal(preview.changes.find((item) => item.kind === "IDENTITY").changed, true);
    const imported = target.store.import({ profileId: "target", expectedRevision: 1, bundle });
    assert.equal(imported.manifest.revision, 2);
    assert.equal(imported.documents.IDENTITY, "# Imported identity\n");
    assert.throws(() => target.store.previewImport({
      profileId: "target",
      bundle: { ...bundle, documents: { ...bundle.documents, TOOLS: "forbidden" } },
    }), (error) => error.code === "DEFINITION_DOCUMENT_INVALID");
  } finally { source.cleanup(); target.cleanup(); }
});

test("revision 安装后崩溃仍由旧 manifest 掌权，重启清除孤儿后可继续", () => {
  let crash = false;
  const value = fixture({
    faultInjector(checkpoint) {
      if (crash && checkpoint === "revision-installed") throw new Error("crash");
    },
  });
  try {
    value.store.open();
    value.store.ensureProfile({ profileId: "profile-1" });
    crash = true;
    assert.throws(() => value.store.update({
      profileId: "profile-1", expectedRevision: 1, actor: "user",
      documents: { SOUL: "# New but uncommitted\n" },
    }), /crash/);
    assert.equal(value.store.get("profile-1").manifest.revision, 1);
    value.store.close();
    crash = false;
    value.store.open();
    const committed = value.store.update({
      profileId: "profile-1", expectedRevision: 1, actor: "user",
      documents: { SOUL: "# Committed\n" },
    });
    assert.equal(committed.manifest.revision, 2);
  } finally { value.cleanup(); }
});

test("100 次重启和提交保持 revision 单调且最终内容不丢", () => {
  const value = fixture();
  try {
    value.store.open();
    value.store.ensureProfile({ profileId: "profile-1" });
    for (let index = 1; index <= 100; index += 1) {
      value.store.update({
        profileId: "profile-1",
        expectedRevision: index,
        actor: "user",
        documents: { SOUL: `# Soul\n\nRevision ${index + 1}\n` },
      });
      value.store.close();
      value.store.open();
      assert.equal(value.store.get("profile-1").manifest.revision, index + 1);
    }
    const final = value.store.get("profile-1");
    assert.equal(final.manifest.revision, 101);
    assert.match(final.documents.SOUL, /Revision 101/);
    assert.equal(value.store.history("profile-1").length, 101);
  } finally { value.cleanup(); }
});

(async () => {
  let passed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`ok - ${item.name}`);
    } catch (error) {
      console.error(`not ok - ${item.name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }
  if (passed === tests.length) console.log(`${passed} agent definition tests passed`);
})();
