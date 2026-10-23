"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { hasSecret } = require("../app/agent-service/memory-engine");

assert.equal(hasSecret('api_key = os.environ.get("NCBI_API_KEY")'), false);
assert.equal(hasSecret('token = process.env.GITHUB_TOKEN'), false);
assert.equal(hasSecret('api_key = os.environ.get("NCBI_API_KEY") or os.environ.get("NCBI_EUTILS_API_KEY")'), false);
assert.equal(hasSecret('const token = argv[index];'), false);
assert.equal(hasSecret('const re = /(?:[?&]token=|[?&]signature=)/i;'), false);
const frozenGwasHelper = fs.readFileSync(path.join(__dirname,
  "../resources/bundled-plugins/packages/life-science-research/skills/locus-to-gene-mapper-skill/scripts/map_locus_to_gene.py"), "utf8");
assert.equal(hasSecret(frozenGwasHelper), false);
assert.equal(hasSecret('token = str(effect[0])'), true);
assert.equal(hasSecret(`${frozenGwasHelper}\npassword = "syntheticfallback123"\n`), true);
assert.equal(hasSecret('token = str(effect[0]) or "syntheticfallback123"'), true);
assert.equal(hasSecret('token = str(effect[0]); password = "syntheticfallback123"'), true);
assert.equal(hasSecret('api_key = str(effect[0])'), true);
assert.equal(hasSecret('token = str(effect[1])'), true);
assert.equal(hasSecret('api_key = "synthetic-but-secret-shaped-value"'), true);
assert.equal(hasSecret('token = ghp_testsecretvalue123456'), true);
assert.equal(hasSecret('token = process.env.GITHUB_TOKEN || "syntheticfallback123"'), true);
assert.equal(hasSecret('api_key = os.getenv("MISSING") + "syntheticfallback123"'), true);
assert.equal(hasSecret('api_key = os.getenv("MISSING") or "syntheticfallback123"'), true);
assert.equal(hasSecret('token = argv[index] || "syntheticfallback123"'), true);
assert.equal(hasSecret('const re = /(?:[?&]token=syntheticfallback123|[?&]signature=)/i;'), true);
assert.equal(hasSecret('token=|syntheticfallback123'), true);
assert.equal(hasSecret('token = process.env.GITHUB_TOKEN; password = "syntheticfallback123"'), true);

const value = memoryFixture();
try {
  const explicit = value.engine.propose({
    profileId: "profile-1", scope: "user", type: "semantic",
    content: "用户偏好中文交流", sourceRefs: ["transcript-1"], classification: "explicit",
  });
  assert.equal(explicit.status, "active");
  assert.match(value.definitions.get("profile-1").documents.USER, /用户偏好中文交流/u);
  assert.match(value.definitions.readGeneratedView("profile-1", "MEMORY").content, /用户偏好中文交流/u);

  assert.throws(() => value.engine.propose({
    profileId: "profile-1", scope: "agent", type: "semantic",
    content: "用户可能喜欢深色主题", sourceRefs: ["transcript-2"], classification: "inferred",
  }), (error) => error.code === "MEMORY_INVALID");

  const replacement = value.engine.propose({
    profileId: "profile-1", scope: "user", type: "semantic",
    content: "用户现在偏好英文交流", sourceRefs: ["correction-1"], classification: "explicit",
    supersedes: explicit.id,
  });
  assert.equal(replacement.status, "active");
  assert.equal(value.store.get("profile-1", explicit.id).status, "superseded");
  assert.equal(value.store.get("profile-1", replacement.id).supersedes, explicit.id);

  assert.equal(typeof value.engine.extractTranscript, "undefined");

  const deleted = value.engine.delete({ profileId: "profile-1", id: replacement.id });
  assert.equal(deleted.status, "deleted");
  assert.equal(value.engine.search({ profileId: "profile-1", query: "英文交流" }).items.length, 0);

  const beforeRestart = value.store.exportProfile("profile-1");
  value.close();
  value.definitions.open();
  value.store.open();
  value.engine.open(["profile-1"]);
  assert.deepEqual(value.store.exportProfile("profile-1"), beforeRestart);
  console.log("ok - 直接 active、superseded/deleted、来源、视图与重启恢复");
  console.log("1 memory engine unit suite passed");
} finally { value.cleanup(); }
