"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { workspaceMemoryRef } = require("../app/agent-service/memory-engine");

function compile(fixture, run = fixture.run, query = "晨舟项目构建编号") {
  return fixture.compiler.compile({ profile: fixture.profile, run,
    transcriptSessionId: fixture.transcriptSessionId, query });
}

test("hot context selects complete stable preferences and relevant workspace facts within existing budgets", () => {
  const f = contextFixture({ budgets: { user: 480, memory: 600, transcript: 512 } });
  try {
    for (const [id, scope, type, content, sourceRefs] of [
      ["u-noise", "user", "episodic", "用户去年买过一把蓝伞。".repeat(36), ["ev-noise"]],
      ["u-pref", "user", "semantic", "用户偏好简洁的中文回复。", ["ev-pref"]],
      ["u-agreement", "user", "procedural", "当前约定先说明测试结果再给代码修改。", ["ev-agreement"]],
      ["p-relevant", "project", "project", "晨舟项目构建编号 QK-4827 必须在发布说明中记录。",
        ["ev-project", workspaceMemoryRef(f.run.workspace)]],
      ["p-agreement", "project", "procedural", "当前约定发布前先跑回归测试。",
        ["ev-project-agreement", workspaceMemoryRef(f.run.workspace)]],
      ["p-other-workspace", "project", "project", "晨舟项目构建编号 CROSS-SECRET。",
        ["ev-cross", workspaceMemoryRef("/another/workspace")]],
    ]) f.memoryEngine.propose({ id, profileId: "profile-1", scope, type, content,
      sourceRefs, classification: "explicit" });
    const snapshot = compile(f);
    const user = snapshot.blocks.find((item) => item.id === "user");
    const memory = snapshot.blocks.find((item) => item.id === "memory");
    assert.ok(user.byteLength <= 480 && memory.byteLength <= 600);
    assert.match(user.content, /u-pref/u);
    assert.match(user.content, /u-agreement/u);
    assert.doesNotMatch(user.content, /u-noise/u);
    assert.match(memory.content, /QK-4827/u);
    assert.match(memory.content, /p-agreement/u, "无查询词重叠的当前 workspace 约定仍进入热区");
    assert.doesNotMatch(memory.content, /CROSS-SECRET/u);
    assert.equal(snapshot.report.hotMemory.user.priorityCandidates, 2);
    assert.equal(snapshot.report.hotMemory.user.prioritySelected, 2);
    assert.equal(snapshot.report.hotMemory.user.priorityCoverage, 1);
    assert.equal(snapshot.report.hotMemory.memory.priorityCandidates, 2);
    assert.equal(snapshot.report.hotMemory.memory.prioritySelected, 2);
    assert.equal(snapshot.report.hotMemory.user.actualBytes, user.byteLength);
    assert.ok(snapshot.report.hotMemory.user.estimatedTokens > 0);
    assert.equal(snapshot.report.hotMemory.user.tokenMeasurement, "estimated");
    assert.equal(snapshot.report.hotMemory.memory.tokenMeasurement, "estimated");
    assert.ok(snapshot.report.hotMemory.user.sorting.some((entry) => entry.id === "u-pref"
      && entry.reasons.includes("stable_preference")));
    assert.ok(snapshot.report.hotMemory.memory.sorting.some((entry) => entry.id === "p-relevant"
      && entry.reasons.includes("current_workspace") && entry.reasons.includes("query_match")));
    assert.ok(snapshot.report.memoryMatches.includes("u-pref"));
    assert.ok(snapshot.report.memoryMatches.includes("p-relevant"));
    assert.ok(!snapshot.report.memoryMatches.includes("p-other-workspace"));
    assert.doesNotMatch(JSON.stringify(snapshot.report.hotMemory), /CROSS-SECRET|偏好简洁/u,
      "sorting diagnostics contain IDs and reasons only");
  } finally { f.cleanup(); }
});

test("background runs retain normal sensitivity and never receive a private hot fact", () => {
  const f = contextFixture({ budgets: { user: 512, memory: 512, transcript: 512 } });
  try {
    f.memoryEngine.propose({ id: "u-private", profileId: "profile-1", scope: "user",
      type: "semantic", content: "用户邮箱是 owner@example.com。",
      sourceRefs: ["ev-private"], classification: "explicit" });
    f.memoryEngine.propose({ id: "u-private-pref", profileId: "profile-1", scope: "user",
      type: "semantic", content: "用户偏好发送结果至 owner@example.com。",
      sourceRefs: ["ev-private-pref"], classification: "explicit" });
    const direct = compile(f);
    assert.match(direct.blocks.find((item) => item.id === "user").content, /owner@example/u);
    assert.equal(direct.report.hotMemory.user.priorityCandidates, 1);
    const background = compile(f, { ...f.run, source: "cron", sourceId: "cron-job-1" });
    assert.doesNotMatch(background.blocks.find((item) => item.id === "user")?.content || "", /owner@example/u);
    assert.ok(!background.report.memoryMatches.includes("u-private"));
    assert.equal(background.report.hotMemory.user.priorityCandidates, 0);
    assert.equal(background.report.hotMemory.user.priorityCoverage, null);
  } finally { f.cleanup(); }
});

test("durable coverage counts every eligible ID before search caps and only IDs in the final block", () => {
  const f = contextFixture({ budgets: { user: 512, memory: 512, transcript: 512 } });
  try {
    const items = Array.from({ length: 45 }, (_, index) => ({
      id: `durable-${index}`, profileId: "profile-1", scope: "user", type: "semantic",
      content: `用户偏好第 ${index} 项简洁说明。`, sourceRefs: [`ev-${index}`], confidence: 1,
      sensitivity: "normal", status: "active", validFrom: 0, validUntil: null,
      supersedes: null, createdAt: index + 1, updatedAt: index + 1,
    }));
    f.memoryStore.upsertMany(items);
    f.memoryEngine._afterCommit("profile-1");
    for (const [id, scope, type, content, refs, options] of [
      ["workspace-episode", "workspace", "episodic", "项目昨天运行了一次普通构建。",
        ["ev-episode", workspaceMemoryRef(f.run.workspace)], {}],
      ["workspace-agreement", "workspace", "procedural", "发布前先跑回归测试。",
        ["ev-agreement", workspaceMemoryRef(f.run.workspace)], {}],
      ["other-workspace-agreement", "workspace", "procedural", "发布前先核对另一工作区。",
        ["ev-other", workspaceMemoryRef("/another/workspace")], {}],
      ["expired-agreement", "workspace", "procedural", "旧约定先跑过期检查。",
        ["ev-expired", workspaceMemoryRef(f.run.workspace)], { validFrom: 0, validUntil: 499 }],
    ]) f.memoryEngine.propose({ id, profileId: "profile-1", scope, type, content,
      sourceRefs: refs, classification: "explicit", ...options });
    const forgotten = f.memoryEngine.propose({ id: "forgotten-agreement", profileId: "profile-1",
      scope: "workspace", type: "procedural", content: "旧约定先跑撤回检查。",
      sourceRefs: ["ev-forgotten", workspaceMemoryRef(f.run.workspace)], classification: "explicit" });
    f.memoryEngine.delete({ profileId: "profile-1", id: forgotten.id });

    const snapshot = compile(f);
    const user = snapshot.report.hotMemory.user;
    const memory = snapshot.report.hotMemory.memory;
    assert.equal(user.priorityCandidates, 45, "分母在 40 条检索上限之前统计");
    assert.ok(user.candidateCount <= 40);
    const userBlock = snapshot.blocks.find((item) => item.id === "user");
    const ids = new Set([...userBlock.content.matchAll(/\[(durable-\d+);/gu)].map((match) => match[1]));
    assert.equal(user.prioritySelected, ids.size, "分子按最终注入块内的 ID 去重");
    assert.equal(user.priorityCoverage, Number((ids.size / 45).toFixed(4)));
    assert.ok(user.priorityCoverage < 1);
    assert.equal(user.priorityMetric, "heuristic_preference_or_agreement");
    assert.equal(memory.priorityCandidates, 1,
      "普通 workspace 记录、其他工作区、到期和撤回项均不计入分母");
    assert.equal(memory.prioritySelected, 1);
    assert.ok(snapshot.report.memoryMatches.includes("workspace-agreement"));
    const uncappedCounts = f.memoryEngine.search({ profileId: "profile-1", query: "",
      hotPriority: true, workspace: f.run.workspace, maxSensitivity: "private",
      limit: 2, maxBytes: 512 }).hotDurableEligibleByScope;
    assert.equal(uncappedCounts.user, 45);
    assert.equal(uncappedCounts.workspace, 1);
    const originalSearch = f.memoryEngine.search.bind(f.memoryEngine);
    f.memoryEngine.search = (input) => {
      const result = originalSearch(input);
      if (!input.hotPriority) return result;
      const { hotDurableEligibleByScope: _unknown, ...withoutDenominator } = result;
      return withoutDenominator;
    };
    const unknown = compile(f).report.hotMemory.user;
    assert.equal(unknown.priorityCandidates, null);
    assert.equal(unknown.priorityCoverage, null,
      "没有未截断分母时不得用已截断候选报满覆盖");
  } finally { f.cleanup(); }
});

test("deep stable preference and procedural workspace agreement survive scope caps", () => {
  const f = contextFixture({ budgets: { user: 8 * 1024, memory: 12 * 1024, transcript: 512 } });
  try {
    const userItems = Array.from({ length: 130 }, (_, index) => ({
      id: `bulk-user-${index}`, profileId: "profile-1", scope: "user", type: "semantic",
      content: `用户记录 ${index}：这是一条与当前任务无关的历史备注。`,
      sourceRefs: [`ev-bulk-${index}`], confidence: 1, sensitivity: "normal",
      status: "active", validFrom: 0, validUntil: null, supersedes: null,
      createdAt: 1_000 + index, updatedAt: 1_000 + index,
    }));
    const projectItems = Array.from({ length: 80 }, (_, index) => ({
      id: `bulk-project-${index}`, profileId: "profile-1", scope: "project", type: "episodic",
      content: `项目历史记录 ${index}：普通构建已归档。`,
      sourceRefs: [`ev-project-${index}`, workspaceMemoryRef(f.run.workspace)],
      confidence: 1, sensitivity: "normal", status: "active", validFrom: 0, validUntil: null,
      supersedes: null, createdAt: 2_000 + index, updatedAt: 2_000 + index,
    }));
    const bulk = [...userItems, ...projectItems];
    for (let offset = 0; offset < bulk.length; offset += 128) {
      f.memoryStore.upsertMany(bulk.slice(offset, offset + 128));
    }
    f.memoryEngine._afterCommit("profile-1");
    f.memoryEngine.propose({ id: "user-evergreen", profileId: "profile-1",
      scope: "user", type: "semantic", content: "用户偏好简洁中文回复。",
      sourceRefs: ["ev-user-evergreen"], classification: "explicit" });
    f.memoryEngine.propose({ id: "project-evergreen", profileId: "profile-1",
      scope: "project", type: "procedural", content: "发布前先跑回归测试。",
      sourceRefs: ["ev-evergreen", workspaceMemoryRef(f.run.workspace)],
      classification: "explicit" });
    f.memoryEngine.propose({ id: "project-query-match", profileId: "profile-1",
      scope: "project", type: "project", content: "晨舟项目构建编号 QK-4827。",
      sourceRefs: ["ev-query-match", workspaceMemoryRef(f.run.workspace)],
      classification: "explicit" });
    const snapshot = compile(f, f.run, "无关任务");
    assert.match(snapshot.blocks.find((item) => item.id === "user").content, /user-evergreen/u);
    assert.match(snapshot.blocks.find((item) => item.id === "memory").content, /project-evergreen/u);
    assert.ok(snapshot.blocks.find((item) => item.id === "user").byteLength <= 8 * 1024);
    assert.ok(snapshot.blocks.find((item) => item.id === "memory").byteLength <= 12 * 1024);
    assert.ok(snapshot.report.memoryMatches.includes("user-evergreen"));
    assert.ok(snapshot.report.memoryMatches.includes("project-evergreen"));
    const relevant = compile(f, f.run, "晨舟项目构建编号 QK-4827");
    assert.match(relevant.blocks.find((item) => item.id === "memory").content, /project-query-match/u,
      "合并后的 scope cap 仍应保留与本轮查询高度相关的项目事实");
    assert.match(relevant.blocks.find((item) => item.id === "memory").content, /project-evergreen/u);
    const query = { profileId: "profile-1", query: "晨舟项目构建编号 QK-4827",
      scopes: ["user", "agent", "project", "workspace"], workspace: f.run.workspace,
      limit: 100, maxBytes: 128 * 1024 };
    assert.deepEqual(f.memoryEngine.search({ ...query, hotPriority: true }).items,
      f.memoryEngine.search(query).items,
      "hotPriority 只改变 active 空查询的候选顺序，不改变普通有词检索");
  } finally { f.cleanup(); }
});

test("a long durable agreement cannot crowd an exact query match out of the memory budget", () => {
  const f = contextFixture({ budgets: { user: 8 * 1024, memory: 12 * 1024, transcript: 512 } });
  try {
    for (const [id, type, content] of [
      ["long-agreement-a", "procedural", `发布约定必须 ${"x".repeat(7600)}`],
      ["long-agreement-b", "procedural", `部署规则必须 ${"y".repeat(3500)}`],
      ["exact-project-fact", "project", `晨舟项目构建编号 QK-4827 ${"z".repeat(1300)}`],
    ]) f.memoryEngine.propose({ id, profileId: "profile-1", scope: "project", type, content,
      sourceRefs: [id, workspaceMemoryRef(f.run.workspace)], classification: "explicit" });
    const snapshot = compile(f);
    const memory = snapshot.blocks.find((item) => item.id === "memory");
    assert.ok(memory.byteLength <= 12 * 1024);
    assert.match(memory.content, /exact-project-fact/u);
    assert.match(memory.content, /long-agreement-a/u, "仍为旧约定保留预算");
    assert.ok(snapshot.report.memoryMatches.includes("exact-project-fact"));
    assert.equal(snapshot.report.hotMemory.memory.sorting[0].id, "exact-project-fact",
      "明确命中应先于大段旧约定占用预算");
  } finally { f.cleanup(); }
});
