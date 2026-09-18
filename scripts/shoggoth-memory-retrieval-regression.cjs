"use strict";

const assert = require("node:assert/strict");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");

const value = memoryFixture({ now: 1_000 });
try {
  const add = (content, scope, source, extra = {}) => value.engine.propose({
    profileId: "profile-1", scope, type: extra.type || "semantic", content,
    sourceRefs: [source], classification: "explicit", ...extra,
  });
  add("项目 Shoggoth 使用中文产品界面", "project", "p1");
  add("用户偏好中文交流", "user", "u1");
  add("workspace 使用 Node.js 20", "workspace", "w1");
  add("过期的中文偏好", "user", "old", { validFrom: 0, validUntil: 500 });
  const privateItem = value.engine.propose({
    profileId: "profile-1", scope: "user", type: "semantic",
    content: "私人邮箱 owner@example.com", sourceRefs: ["private"], classification: "explicit",
  });
  value.engine.confirm({ profileId: "profile-1", id: privateItem.id });

  const normal = value.engine.search({
    profileId: "profile-1", query: "中文交流", scopes: ["user", "project"],
    maxSensitivity: "normal", limit: 10, maxBytes: 4096, now: 2_000,
  });
  assert.equal(normal.items[0].content, "用户偏好中文交流");
  assert.equal(normal.items.some((item) => item.content.includes("过期")), false);
  assert.equal(normal.items.some((item) => item.content.includes("邮箱")), false);
  const privateSearch = value.engine.search({
    profileId: "profile-1", query: "私人邮箱", maxSensitivity: "private", now: 2_000,
  });
  assert.equal(privateSearch.items.some((item) => item.content.includes("owner@example.com")), true);
  const bounded = value.engine.search({
    profileId: "profile-1", query: "中文", limit: 1, maxBytes: 512, now: 2_000,
  });
  assert.ok(bounded.items.length <= 1);
  assert.equal(bounded.truncated, true);
  console.log("ok - scope/sensitivity/TTL/lexical+recency 排序与容量预算确定性生效");
  console.log("1 memory retrieval regression passed");
} finally { value.cleanup(); }
