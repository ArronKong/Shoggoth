#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
let createRunEventStream;
let moduleLoadError = null;
try {
  ({ createRunEventStream } = require(path.join(
    ROOT, "app", "agent-service", "run-event-stream.js",
  )));
} catch (error) {
  moduleLoadError = error;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("run-event-stream 模块可用", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof createRunEventStream, "function");
});

test("每个 RunEventStream 有独立 streamId、单调 seq 与 canonical secret-safe payload", () => {
  const checked = [];
  const options = {
    runId: "run-1",
    getSnapshot: () => ({ status: "running" }),
    assertSecretSafe(value, context) {
      assert.equal(Object.isFrozen(value), true);
      assert.equal(Object.isFrozen(value.nested), true);
      checked.push({ value, context });
      return true;
    },
  };
  const first = createRunEventStream({
    ...options,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
  });
  const second = createRunEventStream({
    ...options,
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
  });
  assert.notEqual(first.streamId, second.streamId);

  const original = { text: "one", nested: { step: 1 } };
  const one = first.append("assistant.delta", original);
  original.text = "mutated";
  original.nested.step = 99;
  const two = first.append("assistant.done", { text: "two", nested: { step: 2 } });
  assert.deepEqual(one, {
    runId: "run-1",
    streamId: "11111111-1111-4111-8111-111111111111",
    seq: 1,
    type: "assistant.delta",
    payload: { text: "one", nested: { step: 1 } },
  });
  assert.equal(Object.isFrozen(one), true);
  assert.equal(two.seq, 2);
  assert.deepEqual(checked.map((entry) => entry.context), [
    { kind: "event", runId: "run-1", streamId: first.streamId, type: "assistant.delta" },
    { kind: "event", runId: "run-1", streamId: first.streamId, type: "assistant.done" },
  ]);
  assert.deepEqual(first.stats(), {
    runId: "run-1",
    streamId: first.streamId,
    count: 2,
    totalBytes: Buffer.byteLength(`${JSON.stringify(one)}\n${JSON.stringify(two)}\n`),
    baseSeq: 0,
    latestSeq: 2,
    nextSeq: 3,
    subscriberCount: 0,
    closed: false,
    maxEvents: 1024,
    maxTotalBytes: 4 * 1024 * 1024,
    maxEventBytes: 48 * 1024,
    maxSnapshotBytes: 64 * 1024,
  });
});

test("subscribe(afterSeq) 在 cursor gap 返回当前 snapshot/baseSeq/nextSeq，随后继续实时事件", () => {
  const contexts = [];
  const stream = createRunEventStream({
    runId: "run-gap",
    randomUUID: () => "33333333-3333-4333-8333-333333333333",
    maxEvents: 2,
    maxTotalBytes: 1024 * 1024,
    getSnapshot: () => ({ status: "running", progress: 3 }),
    assertSecretSafe(value, context) {
      contexts.push(context);
      return true;
    },
  });
  stream.append("run.one", { value: 1 });
  stream.append("run.two", { value: 2 });
  stream.append("run.three", { value: 3 });
  assert.equal(stream.stats().baseSeq, 1);

  const live = [];
  const subscription = stream.subscribe({ streamId: null, afterSeq: 0 }, (event) => live.push(event));
  assert.equal(subscription.runId, "run-gap");
  assert.equal(subscription.streamId, stream.streamId);
  assert.deepEqual(subscription.events, []);
  assert.deepEqual(subscription.gap, {
    code: "CURSOR_GAP",
    requestedAfterSeq: 0,
    baseSeq: 1,
  });
  assert.deepEqual(subscription.snapshot, { status: "running", progress: 3 });
  assert.equal(Object.isFrozen(subscription.snapshot), true);
  assert.equal(subscription.baseSeq, 1);
  assert.equal(subscription.nextSeq, 4);
  assert.equal(subscription.latestSeq, 3);
  assert.equal(typeof subscription.unsubscribe, "function");
  assert.deepEqual(contexts.at(-1), {
    kind: "snapshot",
    runId: "run-gap",
    streamId: stream.streamId,
    baseSeq: 1,
    latestSeq: 3,
  });

  const fourth = stream.append("run.four", { value: 4 });
  assert.deepEqual(live, [fourth]);
  assert.equal(stream.stats().subscriberCount, 1);

  const replay = stream.subscribe({ streamId: stream.streamId, afterSeq: 3 }, () => {});
  assert.deepEqual(replay.events, [fourth]);
  assert.equal(replay.gap, null);
  assert.equal(replay.snapshot, null);
  assert.equal(replay.baseSeq, 2);
  assert.equal(replay.nextSeq, 5);
  subscription.unsubscribe();
  subscription.unsubscribe();
  replay.unsubscribe();
  assert.equal(stream.stats().subscriberCount, 0);
});

test("subscriber 异常隔离，断开不取消 Run，close 清理全部订阅", () => {
  const errors = [];
  const received = [];
  const stream = createRunEventStream({
    runId: "run-subscribers",
    randomUUID: () => "44444444-4444-4444-8444-444444444444",
    getSnapshot: () => ({ status: "running" }),
    assertSecretSafe: () => true,
    onSubscriberError(error, context) {
      errors.push({ message: error.message, context });
    },
  });
  stream.subscribe({ streamId: null, afterSeq: 0 }, () => { throw new Error("subscriber boom"); });
  const healthy = stream.subscribe({ streamId: null, afterSeq: 0 }, (event) => received.push(event));
  const first = stream.append("run.progress", { step: 1 });
  assert.deepEqual(received, [first]);
  assert.deepEqual(errors, [{
    message: "subscriber boom",
    context: { runId: "run-subscribers", streamId: stream.streamId, seq: 1 },
  }]);

  healthy.unsubscribe();
  stream.append("run.progress", { step: 2 });
  assert.deepEqual(received, [first]);
  assert.equal(stream.stats().latestSeq, 2, "取消订阅不能取消或关闭 Run stream");
  assert.equal(stream.close(), true);
  assert.equal(stream.close(), false);
  assert.equal(stream.stats().subscriberCount, 0);
  assert.equal(stream.stats().closed, true);
  assert.throws(
    () => stream.append("run.progress", { step: 3 }),
    (error) => error.code === "RUN_EVENT_STREAM_CLOSED",
  );
  assert.throws(
    () => stream.subscribe({ streamId: stream.streamId, afterSeq: 2 }, () => {}),
    (error) => error.code === "RUN_EVENT_STREAM_CLOSED",
  );
});

test("非法 canonical payload 与 secret callback 拒绝均不消耗 seq 且不泄漏原值", () => {
  let checks = 0;
  const stream = createRunEventStream({
    runId: "run-secret-boundary",
    randomUUID: () => "55555555-5555-4555-8555-555555555555",
    getSnapshot: () => ({ status: "running" }),
    assertSecretSafe(value) {
      checks += 1;
      return value.allowed === true;
    },
  });
  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() { throw new Error("getter-secret-canary"); },
  });
  assert.throws(
    () => stream.append("run.bad", accessor),
    (error) => error.code === "RUN_EVENT_INVALID"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("getter-secret-canary"),
  );
  assert.equal(checks, 0, "canonical 化失败时不能进入 secret callback");
  assert.throws(
    () => stream.append("run.secret", { allowed: false, value: "secret-canary" }),
    (error) => error.code === "RUN_EVENT_SECRET_REJECTED"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("secret-canary"),
  );
  assert.equal(stream.stats().nextSeq, 1);
  assert.equal(stream.append("run.safe", { allowed: true }).seq, 1);
});

test("ring 同时受 count 与 encoded bytes 约束，超大事件拒绝且 seq 连续", () => {
  const stream = createRunEventStream({
    runId: "run-bytes",
    randomUUID: () => "66666666-6666-4666-8666-666666666666",
    maxEvents: 100,
    maxTotalBytes: 400,
    maxEventBytes: 400,
    getSnapshot: () => ({ status: "running" }),
    assertSecretSafe: () => true,
  });
  stream.append("run.chunk", { text: "a".repeat(120) });
  stream.append("run.chunk", { text: "b".repeat(120) });
  stream.append("run.chunk", { text: "c".repeat(120) });
  const bounded = stream.stats();
  assert.equal(bounded.totalBytes <= 400, true);
  assert.equal(bounded.count < 3, true);
  assert.equal(bounded.baseSeq > 0, true);
  assert.equal(bounded.latestSeq, 3);
  assert.throws(
    () => stream.append("run.huge", { text: "z".repeat(1000) }),
    (error) => error.code === "RUN_EVENT_TOO_LARGE",
  );
  assert.equal(stream.stats().latestSeq, 3);
  assert.equal(stream.append("run.chunk", { text: "d" }).seq, 4);
});

test("mutation callback 重入 append 固定拒绝且不消耗 seq", () => {
  let reenter = true;
  let stream;
  stream = createRunEventStream({
    runId: "run-reentrant",
    randomUUID: () => "77777777-7777-4777-8777-777777777777",
    getSnapshot: () => ({ status: "running" }),
    assertSecretSafe() {
      if (reenter) stream.append("run.inner", { value: 2 });
      return true;
    },
  });
  assert.throws(
    () => stream.append("run.outer", { value: 1 }),
    (error) => error.code === "RUN_EVENT_REENTRANT",
  );
  assert.equal(stream.stats().nextSeq, 1);
  reenter = false;
  assert.equal(stream.append("run.safe", { value: 3 }).seq, 1);
});

test("cursor gap snapshot 按最终 JSON UTF8 受 64KiB 硬上限保护", () => {
  let secretChecks = 0;
  const stream = createRunEventStream({
    runId: "run-snapshot-cap",
    randomUUID: () => "88888888-8888-4888-8888-888888888888",
    maxEvents: 1,
    getSnapshot: () => ({ state: "x".repeat(2 * 1024 * 1024) }),
    assertSecretSafe: () => { secretChecks += 1; return true; },
  });
  stream.append("run.one", { value: 1 });
  stream.append("run.two", { value: 2 });
  assert.throws(
    () => stream.subscribe({ streamId: stream.streamId, afterSeq: 0 }, () => {}),
    (error) => error.code === "RUN_EVENT_SNAPSHOT_TOO_LARGE",
  );
  assert.equal(stream.stats().subscriberCount, 0);
  assert.equal(secretChecks, 2, "超限 snapshot 不应进入下游 secret callback");
  assert.throws(
    () => createRunEventStream({
      runId: "run-bad-snapshot-cap",
      maxSnapshotBytes: 64 * 1024 + 1,
      randomUUID: () => "99999999-9999-4999-8999-999999999999",
      getSnapshot: () => ({}),
      assertSecretSafe: () => true,
    }),
    (error) => error.code === "RUN_EVENT_STREAM_INVALID",
  );
});

test("异步拒绝 callback/订阅者均被消费且同步固定拒绝", async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const secret = createRunEventStream({
      runId: "run-async-secret",
      randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      getSnapshot: () => ({ status: "running" }),
      assertSecretSafe: () => Promise.reject(new Error("async-secret-canary")),
    });
    assert.throws(
      () => secret.append("run.secret", { value: 1 }),
      (error) => error.code === "RUN_EVENT_SECRET_REJECTED",
    );
    assert.equal(secret.stats().nextSeq, 1);

    const asyncSnapshot = createRunEventStream({
      runId: "run-async-snapshot",
      randomUUID: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      maxEvents: 1,
      getSnapshot: () => Promise.reject(new Error("async-snapshot-canary")),
      assertSecretSafe: () => true,
    });
    asyncSnapshot.append("run.one", { value: 1 });
    asyncSnapshot.append("run.two", { value: 2 });
    assert.throws(
      () => asyncSnapshot.subscribe({ streamId: asyncSnapshot.streamId, afterSeq: 0 }, () => {}),
      (error) => error.code === "RUN_EVENT_SNAPSHOT_ASYNC",
    );

    const reported = [];
    const subscriber = createRunEventStream({
      runId: "run-async-subscriber",
      randomUUID: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      getSnapshot: () => ({ status: "running" }),
      assertSecretSafe: () => true,
      onSubscriberError(error) {
        reported.push(error.message);
        return Promise.reject(new Error("reporter-reject-canary"));
      },
    });
    subscriber.subscribe(
      { streamId: subscriber.streamId, afterSeq: 0 },
      () => Promise.reject(new Error("subscriber-reject-canary")),
    );
    subscriber.append("run.event", { value: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reported, ["subscriber-reject-canary"]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("stream 重启即使 seq 相同也返回 reset snapshot，首次 null cursor 可订阅", () => {
  const old = createRunEventStream({
    runId: "run-restart",
    randomUUID: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    getSnapshot: () => ({ generation: "old" }),
    assertSecretSafe: () => true,
  });
  old.append("run.state", { value: 1 });

  const current = createRunEventStream({
    runId: "run-restart",
    randomUUID: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    getSnapshot: () => ({ generation: "current" }),
    assertSecretSafe: () => true,
  });
  current.append("run.state", { value: 2 });
  const reset = current.subscribe({ streamId: old.streamId, afterSeq: 1 }, () => {});
  assert.deepEqual(reset.events, []);
  assert.deepEqual(reset.gap, {
    code: "STREAM_RESET",
    requestedStreamId: old.streamId,
    currentStreamId: current.streamId,
    requestedAfterSeq: 1,
    baseSeq: 0,
    latestSeq: 1,
  });
  assert.deepEqual(reset.snapshot, { generation: "current" });
  assert.equal(reset.streamId, current.streamId);
  assert.equal(reset.baseSeq, 0);
  assert.equal(reset.latestSeq, 1);
  reset.unsubscribe();

  const first = current.subscribe({ streamId: null, afterSeq: 0 }, () => {});
  assert.equal(first.gap, null);
  assert.equal(first.snapshot, null);
  assert.equal(first.events.length, 1);
  first.unsubscribe();
});

test("ring 配置受生产硬上限及单事件/总字节关系约束", () => {
  const base = {
    runId: "run-config-limits",
    randomUUID: () => "ffffffff-ffff-4fff-8fff-ffffffffffff",
    getSnapshot: () => ({}),
    assertSecretSafe: () => true,
  };
  for (const override of [
    { maxEvents: 1025 },
    { maxTotalBytes: 4 * 1024 * 1024 + 1 },
    { maxEventBytes: 48 * 1024 + 1 },
    { maxTotalBytes: 100, maxEventBytes: 101 },
  ]) {
    assert.throws(
      () => createRunEventStream({ ...base, ...override }),
      (error) => error.code === "RUN_EVENT_STREAM_INVALID",
    );
  }
});

test("append 在 secret callback 前按最终 event JSONL 预算拒绝超大与深层 payload", () => {
  let checks = 0;
  const stream = createRunEventStream({
    runId: "run-preflight-budget",
    randomUUID: () => "12121212-1212-4212-8212-121212121212",
    getSnapshot: () => ({}),
    assertSecretSafe: () => { checks += 1; return true; },
  });
  assert.throws(
    () => stream.append("run.megabyte", { text: "x".repeat(1024 * 1024) }),
    (error) => error.code === "RUN_EVENT_TOO_LARGE",
  );
  assert.equal(checks, 0);
  assert.equal(stream.stats().nextSeq, 1);

  const deep = {};
  let cursor = deep;
  for (let depth = 0; depth < 10_000; depth += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.throws(
    () => stream.append("run.deep", deep),
    (error) => error.code === "RUN_EVENT_TOO_LARGE",
  );
  assert.equal(checks, 0);
  assert.equal(stream.stats().nextSeq, 1);

  const envelope = createRunEventStream({
    runId: "run-envelope-budget",
    randomUUID: () => "13131313-1313-4313-8313-131313131313",
    maxEventBytes: 220,
    maxTotalBytes: 220,
    getSnapshot: () => ({}),
    assertSecretSafe: () => { checks += 1; return true; },
  });
  assert.throws(
    () => envelope.append("run.envelope", { text: "y".repeat(180) }),
    (error) => error.code === "RUN_EVENT_TOO_LARGE",
  );
  assert.equal(checks, 0);
  assert.equal(envelope.stats().nextSeq, 1);
});

async function main() {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`);
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${passed}/${tests.length} tests passed\n`);
}

main();
