"use strict";

const assert = require("node:assert/strict");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");

const value = memoryFixture();
try {
  for (const content of [
    "API key: sk-proj-abcdefghijklmnopqrstuvwxyz",
    "token=abcdefghijklmnopqrstuvwxyz123456",
    "验证码是 123456",
  ]) {
    assert.throws(() => value.engine.propose({
      profileId: "profile-1", scope: "user", type: "semantic", content,
      sourceRefs: ["secret-source"], classification: "explicit",
    }), (error) => error.code === "MEMORY_SECRET_REJECTED");
  }
  const pii = value.engine.propose({
    profileId: "profile-1", scope: "user", type: "semantic",
    content: "联系邮箱 user@example.com", sourceRefs: ["pii-source"], classification: "explicit",
  });
  assert.equal(pii.sensitivity, "private");
  assert.equal(pii.status, "candidate");
  const restricted = value.engine.propose({
    profileId: "profile-1", scope: "user", type: "semantic",
    content: "受限的医疗背景", sourceRefs: ["restricted-source"],
    classification: "inferred", sensitivity: "restricted",
  });
  assert.throws(() => value.engine.confirm({ profileId: "profile-1", id: restricted.id }),
    (error) => error.code === "MEMORY_RESTRICTED");
  const disk = require("node:fs").readFileSync(
    require("node:path").join(value.paths.agentsDir, "profile-1", "memory", "events.jsonl"), "utf8",
  );
  assert.doesNotMatch(disk, /sk-proj|123456|token=/u);
  console.log("ok - secret/验证码拒绝、PII 降级 candidate、restricted 不可激活");
  console.log("1 memory secret regression passed");
} finally { value.cleanup(); }
