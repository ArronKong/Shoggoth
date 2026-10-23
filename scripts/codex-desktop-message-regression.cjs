"use strict";
// Production Desktop history/Coordinator/IPC with disposable state. The model
// is simulated; legacy restoration must use authenticated product records.
const assert = require("node:assert/strict");
const { fixture, turn } = require("./codex-desktop-session-service-fixture.cjs");
const { OWNER, waitUntil } = { ...require("../app/agent-service/codex-automation-store"),
  ...require("./helpers/codex-automation-harness.cjs") };

(async () => {
  const f = await fixture({ enabledSkill: true });
  try {
    const replies = [{ questionItemId: '["request_user_input_async","fixture",0]',
      question: "页面希望聚焦哪个范围？", answer: "Shoggoth 记忆系统（沿用九章目录）" }];
    const reply = `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
    f.native.turns.push(turn(reply, "范围已确认"));
    const row = f.backend.getSessionRows().find(r => r.label === "桌面对话：保留原上下文");
    const history = await f.backend.getHistory(row.key);
    assert.equal(history.messages.at(-2).content[0].text, replies[0].question + "\n" + replies[0].answer);
    const start = f.host.turnStart.bind(f.host);
    f.host.turnStart = async params => {
      const response = await start(params);
      setTimeout(() => f.host.finish(response.turn.id, "原会话回答"), 20);
      return response;
    };
    await f.backend.sendMessage(row.key, "帮我打开这个文件夹", "desktop-message-clean", { error: e => { throw Error(e); } });
    assert.equal(f.host.turnParams.input[0].text, "帮我打开这个文件夹");
    const run = f.service.productStore.listWorkRuns({ source: "chat", sourceId: row.sessionId }).at(-1);
    await waitUntil(() => f.service.workDispatcher.getRun(run.id).status === "completed", "terminal run");
    const snapshot = f.service.contextSnapshotStore.get(OWNER.id, run.contextSnapshotId);
    const context = snapshot.dynamicContextWithoutTranscript || snapshot.dynamicContext;
    assert.ok(context, "fixture must compile a nonempty dynamic context");
    const userItem = f.native.turns.at(-1).items.find(i => i.type === "userMessage");
    const legacy = `${context}\n\nCURRENT USER REQUEST\n帮我打开这个文件夹`;
    userItem.content[0].text = legacy;
    assert.equal((await f.backend.getHistory(row.key)).messages.at(-2).content[0].text, "帮我打开这个文件夹",
      "restore only an exact persisted Shoggoth context + original input");
    assert.equal(userItem.content[0].text, legacy, "display restoration cannot rewrite native history");
    const unmatched = turn(legacy, "其他回合"); unmatched.items[0].clientId = userItem.clientId;
    f.native.turns.push(unmatched);
    assert.equal((await f.backend.getHistory(row.key)).messages.at(-2).content[0].text, legacy,
      "same clientId in a different turn cannot claim the original user event");
    f.native.turns.pop();
    userItem.content[0].text = legacy.replace(context, "BEGIN UNTRUSTED MEMORY DATA\n用户提供的代码\nEND UNTRUSTED MEMORY DATA");
    assert.equal((await f.backend.getHistory(row.key)).messages.at(-2).content[0].text, userItem.content[0].text,
      "never strip an unmatched prefix by a text heuristic");
    assert.equal(f.host.threadStarts, 0);
    console.log(JSON.stringify({ verified: true, structuredReply: true, pureNativeUserInput: true,
      legacyDisplayRestored: true, unmatchedTextPreserved: true, originalThread: true, nativeHistoryWrites: 0 }));
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
