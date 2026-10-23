"use strict";

// Recall scoping: project facts follow their git repository across worktrees
// and subdirectories; conditional facts are recalled only when the request
// matches; stated importance and the user's own facts lead the hot lane.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { workspaceMemoryRef, workspaceMemoryRefs, isConditionalMemory } = require("../app/agent-service/memory-engine");

const f = contextFixture({ now: () => 5_000 });
const engine = f.memoryEngine;
const save = (content, scope = "user", sourceRefs = [`user-edit:${content.length}-${Math.random()}`], extra = {}) =>
  engine.propose({ profileId: "profile-1", classification: "explicit", scope, type: "semantic",
    content, sourceRefs, ...extra });
const search = (query, workspace, extra = {}) => engine.search({ profileId: "profile-1", query, workspace,
  maxSensitivity: "private", ...extra }).items.map((item) => item.content);
try {
  // A clone at repo/, a linked worktree at wt/, and an unrelated directory.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(f.root, "git-")));
  const repo = path.join(root, "repo"), worktree = path.join(root, "wt"), other = path.join(root, "other");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
  fs.mkdirSync(worktree); fs.mkdirSync(other);
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");

  assert.equal(workspaceMemoryRefs(worktree, "project")[1], workspaceMemoryRefs(repo, "project")[1],
    "a worktree and its clone share one repository key");
  assert.equal(workspaceMemoryRefs(other, "project").length, 1, "outside git only the directory names it");
  assert.equal(workspaceMemoryRefs(repo, "workspace").length, 1, "a workspace fact keeps its exact directory");

  save("这个仓库用 pnpm 安装依赖", "project", ["user-edit:p1", ...workspaceMemoryRefs(repo, "project")]);
  save("这个目录的脚本只在本机跑", "workspace", ["user-edit:w1", ...workspaceMemoryRefs(repo, "workspace")]);
  save("旧的项目约定：发布前先打标签", "project", ["user-edit:legacy", workspaceMemoryRef(repo)]);
  assert.deepEqual(search("pnpm", worktree), ["这个仓库用 pnpm 安装依赖"], "project facts follow the repository");
  assert.deepEqual(search("pnpm", path.join(repo, "src", "deep")), ["这个仓库用 pnpm 安装依赖"]);
  assert.deepEqual(search("pnpm", other), []);
  assert.deepEqual(search("本机", worktree), [], "workspace facts stay in their directory");
  assert.deepEqual(search("发布", repo), ["旧的项目约定：发布前先打标签"], "older facts still match their directory");
  console.log("PASS 项目记忆按仓库身份跨 worktree 和子目录可见，目录记忆与旧记忆保持原范围");

  // Conditional facts wait for a matching request.
  assert.equal(isConditionalMemory({ content: "写提交信息时，用户希望用英文" }), true);
  assert.equal(isConditionalMemory({ content: "When reviewing code, the user wants line references" }), true);
  assert.equal(isConditionalMemory({ content: "用户住在上海" }), false);
  assert.equal(isConditionalMemory({ content: "当前约定先说明测试结果再给代码修改" }), false, "当前 is not a condition");
  assert.equal(isConditionalMemory({ content: "当用户写代码时希望加注释" }), true);
  save("写提交信息时，用户希望用英文");
  save("用户希望回答简洁");
  const hot = (query) => f.compiler.compile({ profile: f.profile, run: f.run,
    transcriptSessionId: f.transcriptSessionId, query }).dynamicContext;
  assert.doesNotMatch(hot("今天天气怎么样"), /提交信息/u);
  assert.match(hot("今天天气怎么样"), /回答简洁/u);
  assert.match(hot("帮我写一下提交信息"), /写提交信息时，用户希望用英文/u);
  console.log("PASS 条件型记忆只在请求涉及其条件时注入");

  // Stated importance first; the user's own facts before an Agent's saves.
  save("用户偏好在早上收到日报", "user", ["event-agent-1", "run-agent-1"]);
  save("用户偏好用表格对比方案", "user", ["user-edit:owner-table"]);
  save("务必用中文和用户交流", "user", ["event-agent-2", "run-agent-2"]);
  const order = engine.search({ profileId: "profile-1", query: "", workspace: f.run.workspace,
    hotPriority: true, maxSensitivity: "private", limit: 20 }).items.map((item) => item.content);
  assert.equal(order[0], "务必用中文和用户交流", "stated importance leads");
  assert.ok(order.indexOf("用户偏好用表格对比方案") < order.indexOf("用户偏好在早上收到日报"),
    "the user's own fact precedes an Agent's save of the same priority");
  assert.ok(!order.includes("写提交信息时，用户希望用英文"), "conditional facts are not in the hot lane");
  console.log("PASS 明确的重要度优先，同等优先级下用户本人的记忆先于 Agent 保存的");
  console.log("memory recall scope unit suite passed");
} finally { f.cleanup(); }
