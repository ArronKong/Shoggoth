"use strict";
// 群聊单一机制的存储规则：真实 SQLite GroupChatStore，不启动驱动或模型。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");

function fixture(t, names = ["Chief", "写手", "程序员"]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grs-")));
  fs.chmodSync(root, 0o700);
  let clock = 1_000;
  const store = new GroupChatStore({ paths: { stateDir: path.join(root, "state"), trustedRoot: root }, now: () => clock }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const { groupId } = store.createGroup({ operationId: "create", name: "小团队", purpose: "",
    members: names.map((name, index) => ({ backendId: "shoggoth", agentId: `agent-${index}`, profileId: `profile-${index}`, displayName: name })) });
  const view = () => store.getGroup(groupId);
  const memberId = (name) => view().members.find(member => member.displayName === name).id;
  const fence = store.advanceDriverFence();
  let sends = 0;
  const send = (body, extra = {}) => store.appendUserMessage({ groupId, clientMessageId: `c${++sends}`, body, mentionMemberIds: [], ...extra });
  const claim = () => store.claimNext(groupId, fence);
  const run = (claimed) => {
    const sessionKey = `session-${claimed.member.id}`;
    if (!claimed.binding.sessionKey) store.bindSession({ groupId, memberId: claimed.member.id, sessionKey, fence });
    return store.recordRun({ opportunityId: claimed.opportunity.id, runId: `run-${claimed.opportunity.id}`, sessionKey, fence });
  };
  const finish = (claimed, text, status = "completed") => store.completeTurn({ opportunityId: claimed.opportunity.id, fence, status, text });
  const bodies = () => store.listMessages({ groupId, limit: 100 }).messages.map(message =>
    message.author.kind === "system" ? `[${message.system.eventType}]` : `${message.author.kind === "user" ? "用户"
      : view().members.find(member => member.id === message.author.memberId).displayName}: ${message.body}`);
  return { store, groupId, view, memberId, fence, send, claim, run, finish, bodies, tick: (ms) => { clock += ms; } };
}

test("a plain message goes to the owner alone; members speak one at a time", (t) => {
  const f = fixture(t);
  assert.equal(f.view().group.ownerMemberId, f.memberId("Chief"), "first member owns the group without built-in Shoggoth");
  f.send("帮我写一篇博客");
  const owner = f.claim();
  assert.equal(owner.member.displayName, "Chief");
  assert.equal(owner.note, "New user message");
  assert.equal(f.claim(), null, "nobody else speaks while the owner holds the floor");
  f.run(owner);
  f.finish(owner, "我先想想，(pass) 不是这个意思");
  assert.equal(f.claim(), null, "the owner's reply without @ ends the round");
  assert.deepEqual(f.bodies(), ["用户: 帮我写一篇博客", "Chief: 我先想想，(pass) 不是这个意思"]);
});

test("response facts persist with only the final message, including a passed released turn", t => {
  const metadata = { models: ["actual"], modelSource: "reported", usage: { inputTokens: 12, outputTokens: 3 } };
  const f = fixture(t); f.send("请回答"); const first = f.claim(); f.run(first);
  f.store.releaseTurn({ opportunityId: first.opportunity.id, fence: f.fence, reason: "working", text: "先给出这段。" });
  const prior = f.store.listMessages({ groupId: f.groupId, limit: 100 }).messages.at(-1);
  assert.equal(prior.responseMetadata, undefined);
  f.store.completeTurn({ opportunityId: first.opportunity.id, fence: f.fence, status: "completed", text: "先给出这段。", responseMetadata: metadata });
  const after = f.store.listMessages({ groupId: f.groupId, limit: 100 }).messages.at(-1);
  assert.deepEqual(after.responseMetadata, metadata);
  assert.equal(after.id, prior.id); assert.equal(after.seq, prior.seq); assert.equal(after.createdAt, prior.createdAt);
  f.store.close(); f.store.open();
  assert.deepEqual(f.store.listMessages({ groupId: f.groupId, limit: 100 }).messages.at(-1).responseMetadata, metadata);
  f.send("第二问"); const next = f.claim(); f.run(next);
  f.store.completeTurn({ opportunityId: next.opportunity.id, fence: f.fence, status: "completed", text: "第二答", responseMetadata: { ...metadata, privateAccount: "secret" } });
  assert.equal(f.store.listMessages({ groupId: f.groupId, limit: 100 }).messages.at(-1).responseMetadata, undefined);
});

test("@ in a reply inserts the callee next; it sees what was said before it and its place in the order", (t) => {
  const f = fixture(t);
  f.send("帮我写一篇博客");
  const owner = f.claim();
  f.run(owner);
  f.finish(owner, "@写手 先出骨架，@程序员 再说技术栈");
  const writer = f.claim();
  assert.equal(writer.member.displayName, "写手");
  assert.equal(writer.note, "Chief invited you");
  assert.deepEqual(writer.order.map(slot => slot.status), ["posted", "speaking", null]);
  assert.equal(writer.position, 1);
  assert.deepEqual(writer.current.map(message => message.body), ["帮我写一篇博客", "@写手 先出骨架，@程序员 再说技术栈"]);
  f.run(writer);
  f.finish(writer, "骨架三段。@程序员 顺手说下部署方式");
  const coder = f.claim();
  assert.equal(coder.member.displayName, "程序员");
  assert.equal(coder.opportunity.calledBy, f.memberId("写手"), "the waiting slot moved up and now answers the writer");
  assert.deepEqual(coder.order.map(slot => slot.status), ["posted", "posted", "speaking"]);
  f.run(coder);
  f.finish(coder, "(pass)");
  assert.equal(f.claim(), null);
  assert.equal(f.store.listMessages({ groupId: f.groupId }).messages.length, 3, "a pass posts nothing");
});

test("only the owner's @all calls everyone; a plain message allows ten total turns", (t) => {
  const f = fixture(t);
  f.send("开会");
  const owner = f.claim(); f.run(owner); f.finish(owner, "@all 各说一句");
  const a = f.claim(); assert.equal(a.member.displayName, "写手");
  f.run(a); f.finish(a, "@all 我也叫大家");
  const b = f.claim(); assert.equal(b.member.displayName, "程序员", "a member's @all is ignored");
  f.run(b); f.finish(b, "@写手 你再说");
  const again = f.claim(); assert.equal(again.member.displayName, "写手");
  f.run(again); f.finish(again, "@程序员 你也再说");
  const third = f.claim(); assert.equal(third.member.displayName, "程序员");
  f.run(third); f.finish(third, "@写手 再来");
  const names = ["Chief", "写手", "程序员", "写手", "程序员"];
  for (let index = names.length; index < 10; index++) {
    const turn = f.claim();
    assert.ok(turn, "a peer can call a member that has already spoken twice");
    const expected = index % 2 ? "写手" : "程序员";
    assert.equal(turn.member.displayName, expected);
    names.push(turn.member.displayName);
    f.run(turn); f.finish(turn, `@${expected === "写手" ? "程序员" : "写手"} 继续`);
  }
  assert.equal(f.claim(), null, "one opening speaker allows ten total turns");
  assert.equal(names.length, 10);
});

test("a three-member opening allows thirty turns, with ten turns per member including the opening", (t) => {
  const f = fixture(t);
  f.send("@all 开会");
  const names = [];
  const cycle = ["Chief", "写手", "程序员"];
  for (let index = 0; index < 30; index++) {
    const turn = f.claim();
    assert.ok(turn);
    assert.equal(turn.member.displayName, cycle[index % 3]);
    names.push(turn.member.displayName);
    f.run(turn);
    f.finish(turn, `@${cycle[(index + 1) % 3]} 继续`);
  }
  assert.equal(f.claim(), null, "the thirty-first turn is never started");
  for (const name of cycle) assert.equal(names.filter(member => member === name).length, 10);
});

test("new user openings add ten-turn budgets without resetting anyone's per-round count", (t) => {
  const f = fixture(t);
  f.send("开会");
  let turn = f.claim();
  f.run(turn);
  f.send("@Chief 再补充一次");
  f.send("@程序员 也请补充");
  const names = [];
  for (let index = 0; index < 20; index++) {
    if (index) { turn = f.claim(); assert.ok(turn); f.run(turn); }
    assert.equal(turn.member.displayName, index % 2 ? "写手" : "Chief");
    names.push(turn.member.displayName);
    f.finish(turn, `@${index % 2 ? "Chief" : "写手"} 继续`);
  }
  const coder = f.claim();
  assert.equal(coder.member.displayName, "程序员", "the two repeating members have each spoken ten times");
  f.run(coder); f.finish(coder, "@Chief 还要补充吗");
  assert.equal(f.claim(), null, "the extra budget cannot admit an eleventh turn for the owner");
  assert.equal(names.filter(name => name === "Chief").length, 10);
  assert.equal(names.filter(name => name === "写手").length, 10);
});

test("a member that starts working gives up the floor; its result comes back later and the caller answers", (t) => {
  const f = fixture(t);
  f.send("帮我把博客写好");
  const owner = f.claim(); f.run(owner); f.finish(owner, "@写手 写初稿，@程序员 给技术栈");
  const writer = f.claim(); f.run(writer);
  const released = f.store.releaseTurn({ opportunityId: writer.opportunity.id, reason: "working", fence: f.fence, text: "我来写初稿。" });
  assert.equal(released.changed, true);
  const coder = f.claim();
  assert.equal(coder.member.displayName, "程序员", "the next speaker starts while the writer keeps working");
  assert.deepEqual(coder.working.map(item => item.memberId), [f.memberId("写手")]);
  assert.deepEqual(coder.order.map(slot => slot.status), ["posted", "working", "speaking"]);
  f.run(coder); f.finish(coder, "Astro + Tailwind。");
  assert.equal(f.claim(), null, "round is over; the writer is still working in the background");
  f.tick(60_000);
  f.finish(writer, "我来写初稿。\n\n初稿写好了：……");
  const back = f.claim();
  assert.equal(back.member.displayName, "Chief", "the owner asked for the work and answers its result");
  assert.equal(back.note, "写手 finished the work you assigned");
  assert.deepEqual(f.bodies(), ["用户: 帮我把博客写好", "Chief: @写手 写初稿，@程序员 给技术栈", "写手: 我来写初稿。",
    "程序员: Astro + Tailwind。", "写手: 初稿写好了：……"], "the already-posted opening is not repeated");
});

test("work the user asked for directly is left for the user; approvals release the floor", (t) => {
  const f = fixture(t);
  f.send("@程序员 跑一下测试");
  const coder = f.claim(); f.run(coder);
  f.store.releaseTurn({ opportunityId: coder.opportunity.id, reason: "working", fence: f.fence, text: "" });
  f.finish(coder, "测试全过。");
  assert.equal(f.claim(), null, "nobody is asked to answer the user's own request");
  f.send("@写手 改一下标题");
  const writer = f.claim(); f.run(writer);
  const waiting = f.store.markWaiting({ opportunityId: writer.opportunity.id,
    interaction: { request: { requestId: "approve-1", kind: "runtime_approval" } } });
  assert.equal(waiting.changed, true);
  assert.equal(f.view().activeTurns[0].releasedReason, "approval");
  f.send("@Chief 你看看");
  assert.equal(f.claim().member.displayName, "Chief", "the floor is free while the writer waits for approval");
});

test("a member called while still busy answers after its current work, without holding the floor", (t) => {
  const f = fixture(t);
  f.send("@程序员 部署一下");
  const coder = f.claim(); f.run(coder);
  f.store.releaseTurn({ opportunityId: coder.opportunity.id, reason: "working", fence: f.fence, text: "开始部署。" });
  f.send("@Chief 安排一下发布");
  const owner = f.claim(); f.run(owner); f.finish(owner, "@程序员 部署完顺便发个公告");
  assert.equal(f.claim(), null, "the busy coder's new turn waits for its current work");
  assert.equal(f.view().queuedMemberIds[0], f.memberId("程序员"));
  f.finish(coder, "部署好了。");
  const later = f.claim();
  assert.equal(later.member.displayName, "程序员");
  assert.equal(later.opportunity.floor, false, "it does not take the floor back");
  f.run(later); f.finish(later, "公告发了。");
  const back = f.claim();
  assert.equal(back.member.displayName, "Chief", "the owner called it and answers its result");
});

test("a user message during a round joins the round before the next speaker", (t) => {
  const f = fixture(t);
  f.send("@all 各说一句");
  const owner = f.claim(); f.run(owner);
  f.send("@程序员 你先说");
  f.finish(owner, "我先说：好。");
  const next = f.claim();
  assert.equal(next.member.displayName, "程序员", "the user's call moved the coder up");
  assert.equal(next.note, "The user invited you");
  assert.deepEqual(next.current.map(message => message.body), ["@all 各说一句", "@程序员 你先说", "我先说：好。"]);
});

test("a failed owner hands a plain message to the next member; timeouts and stops leave a light line", (t) => {
  const f = fixture(t);
  f.send("在吗");
  const owner = f.claim(); f.run(owner);
  f.finish(owner, null, "failed");
  const next = f.claim();
  assert.equal(next.member.displayName, "写手");
  f.store.requestAbort({ opportunityId: next.opportunity.id, reason: "GROUP_TURN_TIMEOUT" });
  f.run(next); f.finish(next, null, "canceled");
  assert.equal(f.claim(), null, "the fallback happens once");
  assert.deepEqual(f.bodies(), ["用户: 在吗", "[turn_failed]", "[turn_failed]"]);
  f.send("@程序员 跑一下");
  const coder = f.claim(); f.run(coder);
  const { aborts } = f.store.stopMember({ groupId: f.groupId, memberId: coder.member.id });
  assert.equal(aborts.length, 1);
  f.finish(coder, null, "canceled");
  assert.equal(f.bodies().at(-1), "[turn_stopped]");
});

test("stopping the group clears the queue and aborts background work", (t) => {
  const f = fixture(t);
  f.send("@all 各说一句");
  const owner = f.claim(); f.run(owner);
  f.store.releaseTurn({ opportunityId: owner.opportunity.id, reason: "working", fence: f.fence });
  const writer = f.claim(); f.run(writer);
  const stopped = f.store.stopDiscussion({ groupId: f.groupId });
  assert.deepEqual(stopped.aborts.map(turn => turn.memberId).sort(), [owner.member.id, writer.member.id].sort());
  f.finish(owner, "迟到的话"); f.finish(writer, "也迟到了");
  assert.equal(f.claim(), null);
  assert.deepEqual(f.view().queuedMemberIds, []);
  assert.deepEqual(f.bodies(), ["用户: @all 各说一句"], "stopped turns post nothing");
});

test("a fresh session sees the latest messages including its own; later turns see only others' news", (t) => {
  const f = fixture(t);
  f.send("第一句");
  const owner = f.claim();
  assert.deepEqual(owner.current.map(message => message.body), ["第一句"]);
  f.run(owner); f.finish(owner, "@写手 你说");
  const writer = f.claim(); f.run(writer); f.finish(writer, "@Chief 好的");
  const ownerAgain = f.claim();
  assert.deepEqual(ownerAgain.current.map(message => message.body), ["好的".replace(/^/u, "@Chief ")],
    "the owner's session already has the first line and its own reply");
  assert.equal(ownerAgain.spokeThisRound, true);
});
