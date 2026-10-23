"use strict";
const assert = require("node:assert/strict");
const { startGroupAcceptanceFixture } = require("./fixtures/group-chat-acceptance-fixture.cjs");
async function wait(check, label) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timed out: ${label}`);
}
async function run() {
  const f = await startGroupAcceptanceFixture();
  const api = suffix => fetch(`${f.fixture.url}/__api/group-chats${suffix}`).then(response => response.json());
  try {
    const run = await wait(() => [...f.gatewayRuns.values()][0], "original OpenClaw run");
    const draft = async () => (await api(`/detail?id=${f.groups.draft}`)).activeTurns[0]?.draft;
    f.emit(run, 1, { text: "私有推理不可公开", phase: "analysis" });
    f.emit(run, 2, { text: "外来运行不可公开" }, { runId: "unrelated-run" });
    f.emit(run, 3, { text: "正在核对", delta: "核对" });
    await wait(async () => await draft() === "正在核对", "complete draft snapshot");
    f.emit(run, 3, { text: "重复事件不能覆盖" }); f.emit(run, 2, { text: "乱序事件不能覆盖" });
    f.emit(run, 4, { delta: "公开结果", phase: "commentary" });
    await wait(async () => await draft() === "正在核对公开结果", "ordered delta");
    f.emit(run, 5, { replace: true, text: "" });
    await wait(async () => await draft() === "正在核对公开结果", "empty replacement preserves the retired paragraph");
    f.emit(run, 6, { text: "这段仍是草稿" });
    await wait(async () => await draft() === "正在核对公开结果\n\n这段仍是草稿", "new draft appends to earlier public text");
    assert.ok(!(await api(`/messages?id=${f.groups.draft}&limit=200`)).messages.some(message => /私有推理|草稿$|正在核对/u.test(message.body)));
    f.finish();
    await wait(async () => !(await api(`/detail?id=${f.groups.draft}`)).activeTurns.length, "original final result");
    const timeline = (await api(`/messages?id=${f.groups.draft}&limit=200`)).messages;
    assert.equal(timeline.filter(message => message.body.startsWith("最终结论：")).length, 1);
    const answer = timeline.find(message => message.body.startsWith("最终结论："));
    assert.ok(!timeline.some(message => /私有推理|外来运行|重复事件|乱序事件|这段仍是草稿/u.test(message.body)));
    assert.equal(f.calls.filter(call => call.kind === "openclaw").length, 1);
    await wait(async () => { const detail = await api(`/detail?id=${f.groups.large}`); return !detail.round && !detail.activeTurns.length; }, "32 members answer one after another");
    assert.equal(f.calls.filter(call => call.groupId === f.groups.large).length, 32);
    console.log("PASS OpenClaw integration: actual WebSocket -> Backend -> Adapter -> private bridge -> Service/REST; bound ordered drafts, reasoning exclusion, empty replacement, original final publication once");
  } finally { await f.close(); }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
