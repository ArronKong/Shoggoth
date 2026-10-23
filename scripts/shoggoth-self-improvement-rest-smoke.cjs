"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { openLearningFixture } = require("./fixtures/self-improvement-service.cjs");

async function run() {
  const f = await openLearningFixture();
  try {
    const skillPage = async (query = {}) => {
      const response = await fetch(`${f.server.url}/__api/skills?${new URLSearchParams({
        backend: "shoggoth", agentId: f.profile.agentId, paged: "1", page: "0", limit: "100", ...query,
      })}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body.page;
    };
    const originalPage = await skillPage();
    const status = await f.ok("status");
    assert.equal(status.settings.config.mode, "off"); assert.equal(f.models.length, 0);
    assert.equal(f.service.learningService.opened, false);
    assert.equal((await f.request("configure", { expectedRevision: 0, patch: { mode: "auto" } })).body.code, "LEARNING_PROTECTED");
    assert.equal((await f.request("history", { profileId: "other-profile" })).status, 400);
    assert.equal((await f.request("unknown")).status, 400);
    const job = await f.review();
    assert.equal(job.state, "pending_review", JSON.stringify(job));
    assert.deepEqual(f.models, ["fixture-model"]);
    assert.equal(f.released.length, 1, "isolated model session is explicitly unloaded");
    assert.equal(f.service.workRunCoordinator.memoryExtractionTasks.size, 0);
    assert.equal((await f.ok("skills")).items.length, 0);
    const proposal = await f.ok("proposal", { jobId: job.id });
    assert.equal(proposal.sourceCount, 3);
    assert.equal((await f.request("resolve", { jobId: job.id, expectedRevision: job.revision - 1, action: "accept" })).status, 409);
    const accepted = await f.ok("resolve", { jobId: job.id, expectedRevision: job.revision, action: "accept" });
    const skill = accepted.skill;
    assert.equal((await f.ok("skills")).items[0].id, skill.id);
    const publishedPage = await skillPage();
    assert.equal(publishedPage.total, originalPage.total + 1, "main catalog includes the learned skill");
    assert.equal(publishedPage.enabledCount, originalPage.enabledCount + 1);
    const published = publishedPage.skills.find(item => item.id === skill.id);
    assert.equal(published.source, "learned"); assert.equal(published.title, skill.title);
    assert.equal(published.learnedRevision, skill.revision);
    const firstPage = await skillPage({ limit: "1" });
    assert.equal(firstPage.skills.length, 1);
    assert.equal((await skillPage({ limit: "1", page: "1", revision: firstPage.queryRevision })).skills.length, 1);
    assert.equal((await skillPage({ query: skill.title })).matchCount, 1, "search matches the visible title");
    assert.ok((await skillPage({ status: "on" })).skills.some(item => item.id === skill.id));
    assert.ok(!(await skillPage({ status: "off" })).skills.some(item => item.id === skill.id));
    const detail = await f.ok("read", { skillId: skill.id });
    assert.ok(detail.files[0].content.includes("验证"));
    assert.equal(detail.version.sourceTaskCount, 1);
    const history = await f.ok("history");
    assert.equal(history.items[0].calls[0].usage.inputTokens, 500);
    assert.equal(/runtimeAccountId|bindingId|fingerprint|credentialRef/u.test(JSON.stringify(history)), false);
    const next = await f.send(f.session.sessionKey, "learning-next-task", `请使用 $${skill.name} 检查构建结果。`);
    assert.equal(next.status, "running", next.errorCode);
    const scope = { runId: next.id, assertCurrent() {} };
    const authority = { profileId: f.profile.id, callId: randomUUID() };
    const catalog = await f.service.mcpProductToolController.handle("skill_catalog", { cursor: 0, query: "构建" }, authority, scope);
    assert.ok(catalog.items.some(item => item.id === skill.id), JSON.stringify(catalog));
    await f.service.mcpProductToolController.handle("skill_read", { name: skill.name, contentHash: skill.head, cursor: 0, maxBytes: 8192 },
      { ...authority, callId: randomUUID() }, scope);
    await f.complete(next, "已读取并按方法检查，构建与产物均通过。");
    assert.equal((await f.ok("read", { skillId: skill.id })).usage.reads, 1);
    assert.equal((await f.ok("read", { skillId: skill.id })).usage.outcomes[0].outcome, "completed");
    const usedPage = await skillPage();
    assert.equal(usedPage.usedCount, originalPage.usedCount + 1);
    assert.equal(usedPage.skills[0].id, skill.id, "learned reads participate in usage sorting");
    assert.equal(usedPage.skills[0].usageCount, 1);
    assert.deepEqual(usedPage.skills[0].usageAgents, { [f.profile.agentId]: 1 });
    assert.notEqual(usedPage.queryRevision, publishedPage.queryRevision);
    const archived = (await f.ok("change", { skillId: skill.id, expectedRevision: skill.revision, action: "archive" })).skill;
    const stale = await fetch(`${f.server.url}/__api/skills?${new URLSearchParams({ backend: "shoggoth",
      agentId: f.profile.agentId, paged: "1", page: "1", limit: "1", revision: firstPage.queryRevision })}`);
    assert.equal(stale.status, 409, "learned changes invalidate subsequent pages");
    assert.equal((await skillPage()).total, publishedPage.total);
    assert.equal((await skillPage()).enabledCount, originalPage.enabledCount);
    assert.ok((await skillPage({ status: "off" })).skills.some(item => item.id === skill.id && !item.enabled));
    const restored = (await f.ok("change", { skillId: skill.id, expectedRevision: archived.revision, action: "restore" })).skill;
    assert.equal((await skillPage()).enabledCount, publishedPage.enabledCount);
    const pinned = (await f.ok("change", { skillId: skill.id, expectedRevision: restored.revision, action: "pin" })).skill;
    assert.equal((await f.request("change", { skillId: skill.id, expectedRevision: skill.revision, action: "archive" })).status, 409);
    const edited = (await f.ok("change", { skillId: skill.id, expectedRevision: pinned.revision, action: "edit", body: "人工整理的构建验证顺序。" })).skill;
    assert.equal(edited.owner, "user");
    const reverted = (await f.ok("change", { skillId: skill.id, expectedRevision: edited.revision, action: "revert", versionHash: skill.head })).skill;
    assert.equal(reverted.head, skill.head);
    const configured = await f.ok("status");
    await f.ok("configure", { expectedRevision: configured.settings.revision, patch: { mode: "off" } });
    assert.equal(f.service.learningService.opened, false);
    const notices = [], notify = f.service.learningService.notify;
    f.service.learningService.notify = notice => { notices.push(notice); notify(notice); };
    await f.service.memoryEngine.forgetSession(f.profile.id, f.session.id);
    assert.ok(notices.some(notice => notice.action === "withdraw"), "withdrawal metadata reaches UI while learning is off");
    assert.equal(f.models.length, 1, "withdrawal notification does not trigger a model call");
    assert.equal((await f.request("read", { skillId: skill.id })).body.code, "LEARNING_VERSION_UNAVAILABLE");
    assert.equal((await skillPage()).total, originalPage.total, "withdrawal removes learned catalog metadata and counts");
    console.log("PASS learning REST -> Backend -> Service -> production Codex adapter with synthetic peer; explicit opt-in, review, publish, next-Run MCP read, version CAS and source withdrawal");
  } finally { await f.close(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
