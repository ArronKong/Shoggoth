"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture, turn } = require("./codex-desktop-session-service-fixture.cjs");

(async () => {
  const f = await fixture();
  try {
    const row = f.backend.getSessionRows().find(r => r.label === "桌面对话：保留原上下文");
    f.host.rejectResume = true;
    let failure;
    await f.backend.sendMessage(row.key, "开始改吧", crypto.randomUUID(), { error: e => { failure = e; } });
    assert.ok(failure, "resume failure must reach the observer");
    const run = f.service.productStore.listWorkRuns({ source: "chat", sourceId: row.sessionId }).at(-1);
    assert.equal(run.status, "failed");
    assert.equal(run.runtimeSessionRef, null);
    assert.equal(run.runtimeTurnRef, null);
    assert.equal(f.host.turnStarts, 0);
    const history = await f.backend.getHistory(row.key);
    assert.ok(history.messages.some(m => m.role === "user" && m.content[0]?.text === "开始改吧"),
      "canonical Desktop history must retain the rejected user message");
    assert.ok(history.messages.some(m => m.role === "system" && m.content[0]?.text === run.errorCode),
      "canonical Desktop history must retain the terminal failure");

    // Later native messages stay current and local failures retain their time
    // and exact operation identity across page boundaries and Service restarts.
    const later = turn("后续在 Desktop 输入", "后续的原生回复");
    later.startedAt = later.completedAt = Math.ceil(Date.now() / 1000) + 60;
    f.native.turns.push(later);
    let page = await f.backend.getHistory(row.key, { limit: 1 });
    const messages = [...page.messages];
    const cursors = new Set();
    while (page.hasMore) {
      assert.ok(!cursors.has(page.nextCursor)); cursors.add(page.nextCursor);
      page = await f.backend.getHistory(row.key, { limit: 1, cursor: page.nextCursor });
      messages.unshift(...page.messages);
    }
    const text = messages.map(m => m.content[0]?.text);
    assert.equal(text.filter(t => t === "开始改吧").length, 1);
    assert.equal(text.filter(t => t === run.errorCode).length, 1);
    assert.ok(text.indexOf("开始改吧") < text.indexOf("后续在 Desktop 输入"));
    assert.equal(text.at(-1), "后续的原生回复");
    await f.backend.stop(); await f.service.stop(); await f.service.start();
    assert.equal(await f.backend.start(), true);
    const reopened = await f.backend.getHistory(row.key);
    assert.ok(reopened.messages.some(m => m.content[0]?.text === "开始改吧"));
    assert.ok(reopened.messages.some(m => m.content[0]?.text === run.errorCode));
    assert.equal(f.host.turnStarts, 0, "history reads and restarts cannot replay failed sends");
    assert.equal(f.host.threadStarts, 0, "preserve the original Desktop thread");
    console.log("PASS Desktop resume failure retains user/error after refresh, pagination, newer native messages and restart without replay");
  } finally { await f.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
