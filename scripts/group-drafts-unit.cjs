"use strict";
// 群回复草稿（里程碑③）：原生事件流累积 / 覆盖，外部成员经桥读取；只在内存，回合结束即丢弃。
const test = require("node:test");
const assert = require("node:assert/strict");
const { GroupDraftTracker } = require("../app/agent-service/group-drafts");

function harness({ opportunity, events = [], externalDraft = null }) {
  const timers = [];
  const changes = [];
  const reads = [];
  const store = { current: opportunity, getOpportunity: () => store.current };
  const tracker = new GroupDraftTracker({
    store,
    nativeExecutor: { async readEvents(input) {
      reads.push(input);
      const page = events.filter((event) => event.seq > input.afterSeq);
      const last = page.at(-1)?.seq ?? input.afterSeq;
      return { streamId: "s-1", events: page, nextCursor: last, hasMore: false, gap: null, latestSeq: last };
    } },
    externalExecutor: { async draft() { return externalDraft; } },
    onChanged: (groupId) => changes.push(groupId),
    setTimer: (fn) => { const timer = { fn, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  const tick = async () => {
    const due = timers.filter((timer) => !timer.cleared && !timer.fired);
    for (const timer of due) { timer.fired = true; timer.fn(); }
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return { tracker, store, events, changes, reads, tick, timers };
}

const delta = (seq, delta, itemId = "a") => ({ seq, type: "text.delta", payload: { itemId, delta } });

test("native deltas accumulate, snapshots replace their own paragraph, and public paragraphs stay visible", async () => {
  const h = harness({ opportunity: { id: "o", groupId: "g", state: "running", runId: "r" },
    events: [delta(1, "先看"), delta(2, "一下")] });
  h.tracker.watch("o");
  await h.tick();
  assert.equal(h.tracker.draftFor("o"), "先看一下");
  assert.deepEqual(h.changes, ["g"]);
  h.events.push({ seq: 3, type: "text", payload: { itemId: "a", text: "先看一下代码" } }, delta(4, "结论：", "b"));
  await h.tick();
  assert.equal(h.tracker.draftFor("o"), "先看一下代码\n\n结论：", "a newer paragraph preserves earlier public text");
  assert.equal(h.reads.at(-1).afterSeq, 2, "reads continue from the cursor");
  await h.tick();
  assert.equal(h.changes.length, 2, "an unchanged draft does not notify again");
});

test("external drafts come from the bridge; finished turns are dropped", async () => {
  const h = harness({ opportunity: { id: "o", groupId: "g", state: "running", runKind: "external", external: {} },
    externalDraft: "Hermes 正在整理" });
  h.tracker.watch("o");
  await h.tick();
  assert.equal(h.tracker.draftFor("o"), "Hermes 正在整理");
  h.store.current = { ...h.store.current, state: "replied" };
  await h.tick();
  assert.equal(h.tracker.draftFor("o"), null, "drafts end with the turn");
  assert.equal(h.timers.filter((timer) => !timer.cleared && !timer.fired).length, 0, "polling stops");
});

test("persisted queue status stays visible when live activity reads fail after restart", async () => {
  const h = harness({ opportunity: { id: "o", groupId: "g", state: "running", runId: "r", runKind: "external",
    external: {}, observation: { status: "queued", dispatchState: "queued" } } });
  h.tracker.externalExecutor.activity = async () => { throw new Error("Runner no longer observes this run"); };
  h.tracker.watch("o"); await h.tick();
  assert.equal(h.tracker.activityFor("o").phase, "queued");
  h.store.current.observation = { status: "running" }; await h.tick();
  assert.equal(h.tracker.activityFor("o").phase, "running");
});

test("very long drafts keep only the tail", async () => {
  const h = harness({ opportunity: { id: "o", groupId: "g", state: "running", runId: "r" },
    events: [delta(1, "x".repeat(5000) + "结尾")] });
  h.tracker.watch("o");
  await h.tick();
  const draft = h.tracker.draftFor("o");
  assert.ok([...draft].length <= 4000);
  assert.ok(draft.startsWith("…") && draft.endsWith("结尾"));
});

test("shutdown: a stopped tracker takes no new watches, and a poll against a closed store ends quietly", async () => {
  const h = harness({ opportunity: { id: "o", groupId: "g", state: "running", runId: "r" }, events: [delta(1, "写到一半")] });
  h.tracker.watch("o");
  // 定时器已经触发、群库随后关闭：轮询不能把异常抛出回调。
  h.store.getOpportunity = () => { throw Object.assign(new Error("closed"), { code: "GROUP_CHAT_UNAVAILABLE" }); };
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  await h.tick();
  process.off("unhandledRejection", onRejection);
  assert.deepEqual(rejections, []);
  assert.equal(h.tracker.draftFor("o"), null);
  assert.equal(h.timers.filter((timer) => !timer.cleared && !timer.fired).length, 0, "the watch is dropped, not rescheduled");
  // 驱动停止后，仍在收尾的回合启动流程调用 watch 也不再挂定时器；重新启动后恢复。
  h.tracker.stop();
  h.tracker.watch("late");
  assert.equal(h.timers.filter((timer) => !timer.cleared && !timer.fired).length, 0);
  h.tracker.start();
  h.tracker.watch("again");
  assert.equal(h.timers.filter((timer) => !timer.cleared && !timer.fired).length, 1);
});
