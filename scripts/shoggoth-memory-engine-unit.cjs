"use strict";

const assert = require("node:assert/strict");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");

const value = memoryFixture();
try {
  const explicit = value.engine.propose({
    profileId: "profile-1", scope: "user", type: "semantic",
    content: "用户偏好中文交流", sourceRefs: ["transcript-1"], classification: "explicit",
  });
  assert.equal(explicit.status, "active");
  assert.match(value.definitions.get("profile-1").documents.USER, /用户偏好中文交流/u);
  assert.match(value.definitions.readGeneratedView("profile-1", "MEMORY").content, /用户偏好中文交流/u);

  const inferred = value.engine.propose({
    profileId: "profile-1", scope: "agent", type: "semantic",
    content: "用户可能喜欢深色主题", sourceRefs: ["transcript-2"], classification: "inferred",
  });
  assert.equal(inferred.status, "candidate");
  const confirmed = value.engine.confirm({ profileId: "profile-1", id: inferred.id });
  assert.equal(confirmed.status, "active");

  const replacement = value.engine.propose({
    profileId: "profile-1", scope: "user", type: "semantic",
    content: "用户现在偏好英文交流", sourceRefs: ["correction-1"], classification: "explicit",
    supersedes: explicit.id,
  });
  assert.equal(replacement.status, "active");
  assert.equal(value.store.get("profile-1", explicit.id).status, "superseded");
  assert.equal(value.store.get("profile-1", replacement.id).supersedes, explicit.id);

  const extracted = value.engine.extractTranscript({
    profileId: "profile-1",
    events: [{
      id: "event-remember", kind: "user", contextExcluded: false,
      content: { text: "请记住：我每周五做项目复盘" },
    }],
  });
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].status, "active");

  const deleted = value.engine.delete({ profileId: "profile-1", id: replacement.id });
  assert.equal(deleted.status, "deleted");
  assert.equal(value.engine.search({ profileId: "profile-1", query: "英文交流" }).items.length, 0);

  const beforeRestart = value.store.exportProfile("profile-1");
  value.close();
  value.definitions.open();
  value.store.open();
  value.engine.open(["profile-1"]);
  assert.deepEqual(value.store.exportProfile("profile-1"), beforeRestart);
  console.log("ok - candidate/active/superseded/deleted、来源、视图与重启恢复");
  console.log("1 memory engine unit suite passed");
} finally { value.cleanup(); }
