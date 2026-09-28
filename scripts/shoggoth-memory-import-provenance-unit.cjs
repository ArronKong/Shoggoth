"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { MemoryStore, validateMemoryItem } = require("../app/agent-service/memory-store");
const { MemoryEngine } = require("../app/agent-service/memory-engine");
const { MemoryProvenanceStore } = require("../app/agent-service/memory-provenance-store");
const { MemoryProvenanceService } = require("../app/agent-service/memory-provenance-service");
const { validateAgentHarnessResult } = require("../app/agent-service/agent-harness-service-protocol");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const f = memoryFixture();
const root = path.join(f.paths.stateDir, "codex", "runtime-1", "memories");
const provenancePath = path.join(f.paths.agentsDir, "profile-1", "memory", "provenance.jsonl");
let memoryStore = f.store;
let engine = f.engine;
let provenanceStore = new MemoryProvenanceStore({ paths: f.paths });
const makeService = () => new MemoryProvenanceService({ store: provenanceStore, memoryStore,
  transcriptStore: {}, chatSessionStore: {}, recallPolicy: engine.recallPolicy });
let service;
const explain = (id) => service.explain({ profileId: "profile-1", id, viewer: "user" });
try {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const fileBytes = Buffer.from("User prefers deterministic tests.\n");
  fs.writeFileSync(path.join(root, "preference.md"), fileBytes, { mode: 0o600 });
  provenanceStore.open();
  service = makeService();
  engine.setProvenanceService(service);

  assert.equal(engine.importCodexNative({ profileId: "profile-1", root }).imported, 1);
  const [item] = memoryStore.list("profile-1", { status: "active" });
  assert.ok(item);
  assert.deepEqual(Object.keys(validateMemoryItem(item)).sort(), ["id", "profileId", "scope",
    "type", "content", "sourceRefs", "confidence", "sensitivity", "status", "validFrom",
    "validUntil", "supersedes", "createdAt", "updatedAt"].sort(),
  "导入不修改 MemoryStore v1 精确字段集");
  const evidence = explain(item.id);
  assert.equal(evidence.evidence.status, "verified_origin");
  assert.equal(evidence.evidence.origin, "import");
  assert.deepEqual(evidence.evidence.importFile,
    { name: "preference.md", sha256: sha256(fileBytes) });
  assert.equal(validateAgentHarnessResult("harness.memory.explain", evidence).evidence.status,
    "verified_origin", "导入文件来源应通过真实管理协议");
  const firstJournal = fs.readFileSync(provenancePath, "utf8");
  assert.equal(JSON.parse(firstJournal.trim()).schemaVersion, 2);
  assert.ok(!firstJournal.includes(root), "来源旁表不能复制绝对路径");
  assert.ok(!firstJournal.includes(fileBytes.toString("utf8")), "来源旁表不能复制文件正文");
  assert.equal(engine.importCodexNative({ profileId: "profile-1", root }).imported, 0);
  assert.equal(fs.readFileSync(provenancePath, "utf8"), firstJournal, "重复导入必须幂等");

  fs.writeFileSync(path.join(root, "same-content.md"), fileBytes, { mode: 0o600 });
  assert.equal(engine.importCodexNative({ profileId: "profile-1", root }).imported, 0);
  assert.equal(fs.readFileSync(provenancePath, "utf8"), firstJournal,
    "另一文件的相同内容不能覆写旧记忆的来源");
  assert.equal(explain(item.id).evidence.importFile.name, "preference.md");

  // A failed sidecar append leaves the committed MemoryItem readable but
  // unverified. Reimporting the same sourceRef repairs the explanation.
  fs.writeFileSync(path.join(root, "retry.md"), "Retryable imported fact.", { mode: 0o600 });
  const originalAppend = provenanceStore.append.bind(provenanceStore);
  provenanceStore.append = (record) => {
    if (record.origin === "import" && record.importFile.name === "retry.md") {
      throw new Error("synthetic sidecar failure");
    }
    return originalAppend(record);
  };
  assert.throws(() => engine.importCodexNative({ profileId: "profile-1", root }),
    /synthetic sidecar failure/u);
  provenanceStore.append = originalAppend;
  const retryItem = memoryStore.list("profile-1", { status: "active" })
    .find((value) => value.content === "Retryable imported fact.");
  assert.ok(retryItem);
  assert.equal(explain(retryItem.id).evidence.status, "legacy_unverified");
  assert.equal(engine.importCodexNative({ profileId: "profile-1", root }).imported, 0);
  assert.equal(explain(retryItem.id).evidence.importFile.name, "retry.md");
  fs.writeFileSync(path.join(root, "retry.md"), "Retryable imported fact.\n", { mode: 0o600 });
  assert.equal(engine.importCodexNative({ profileId: "profile-1", root }).imported, 0);
  const refreshedHash = sha256(Buffer.from("Retryable imported fact.\n"));
  assert.equal(explain(retryItem.id).evidence.importFile.sha256, refreshedHash,
    "文件字节变化但导入正文未变时应记录新的可核对文件摘要");
  fs.writeFileSync(path.join(root, "retry.md"), "Retryable  imported fact.\n", { mode: 0o600 });
  assert.equal(engine.importCodexNative({ profileId: "profile-1", root }).imported, 0);
  assert.equal(explain(retryItem.id).evidence.importFile.sha256, refreshedHash,
    "仅规范化后相同、原始导入正文不同的文件不能重标旧记忆来源");

  // An unsafe filename is represented only by its content digest, never by
  // its raw path/name in the sidecar or protocol result.
  const unsafeName = "private@example.com.md";
  fs.writeFileSync(path.join(root, unsafeName), "Opaque file source fact.", { mode: 0o600 });
  assert.equal(engine.importCodexNative({ profileId: "profile-1", root }).imported, 1);
  const unsafeItem = memoryStore.list("profile-1", { status: "active" })
    .find((value) => value.content === "Opaque file source fact.");
  assert.equal(explain(unsafeItem.id).evidence.importFile.name, null);
  assert.ok(!fs.readFileSync(provenancePath, "utf8").includes(unsafeName));

  const longBytes = Buffer.from("🙂".repeat(2050));
  fs.writeFileSync(path.join(root, "utf8-boundary.md"), longBytes, { mode: 0o600 });
  assert.equal(engine.importCodexNative({ profileId: "profile-1", root }).imported, 1);
  const longItem = memoryStore.list("profile-1", { status: "active" })
    .find((value) => value.content.startsWith("🙂"));
  assert.ok(longItem.content.isWellFormed());
  assert.equal(Buffer.byteLength(longItem.content, "utf8"), 8 * 1024,
    "长中文或 emoji 文件须在完整字符边界截断到 MemoryStore 的 8 KiB 上限");
  assert.equal(explain(longItem.id).evidence.importFile.sha256, sha256(longBytes));

  const completeJournal = fs.readFileSync(provenancePath);
  engine.close(); memoryStore.close(); provenanceStore.close();
  memoryStore = new MemoryStore({ paths: f.paths }); memoryStore.open();
  engine = new MemoryEngine({ store: memoryStore }); engine.open(["profile-1"]);
  provenanceStore = new MemoryProvenanceStore({ paths: f.paths }); provenanceStore.open();
  service = makeService(); engine.setProvenanceService(service);
  assert.deepEqual(explain(item.id).evidence.importFile,
    { name: "preference.md", sha256: sha256(fileBytes) }, "重启后来源仍可读");

  fs.unlinkSync(provenancePath);
  assert.equal(explain(item.id).evidence.status, "unavailable",
    "运行中旁表丢失应降级，不能复用缓存来源");
  provenanceStore.close(); provenanceStore.open();
  assert.equal(explain(item.id).evidence.status, "legacy_unverified",
    "重启后旁表缺失应承认来源未核实");
  fs.writeFileSync(provenancePath, completeJournal, { mode: 0o600 });
  assert.equal(explain(item.id).evidence.status, "verified_origin");
  fs.writeFileSync(provenancePath, Buffer.from("corrupt\n"), { mode: 0o600 });
  assert.equal(explain(item.id).evidence.status, "unavailable",
    "损坏的来源旁表必须降级");
  fs.writeFileSync(provenancePath, completeJournal, { mode: 0o600 });
  assert.equal(explain(item.id).evidence.status, "verified_origin");

  const mismatch = { ...memoryStore.get("profile-1", item.id),
    sourceRefs: ["codex-memory:ffffffffffffffffffffffffffffffff"] };
  memoryStore.upsert(mismatch);
  assert.equal(explain(item.id).evidence.status, "unavailable",
    "相同内容但 sourceRef 已改变时不能沿用旧文件来源");
  assert.equal(explain(item.id).evidence.reason, "import_source_mismatch");
  console.log("shoggoth memory import provenance unit: passed");
} finally {
  try { provenanceStore.close(); } catch {}
  try { engine.close(); memoryStore.close(); } catch {}
  f.cleanup();
}
