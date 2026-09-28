"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  TranscriptStore,
  transcriptEventId,
} = require("../app/agent-service/transcript-store");
const { resolveServicePaths } = require("../app/agent-service/paths");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-transcript-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  let now = 1000;
  const create = () => new TranscriptStore({ paths, now: () => now++, ...options });
  return { root, paths, create, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function append(store, overrides = {}) {
  return store.appendEvent({
    profileId: "profile-1",
    sessionId: "session-1",
    id: overrides.id || transcriptEventId("test", overrides.kind || "user", overrides.text || "hello"),
    runId: overrides.runId ?? "run-1",
    kind: overrides.kind || "user",
    content: overrides.content || { text: overrides.text || "hello" },
    runtimeRef: overrides.runtimeRef ?? null,
    contextExcluded: overrides.contextExcluded === true,
    occurredAt: overrides.occurredAt,
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function checksumRecord(record) {
  const copy = { ...record };
  delete copy.checksum;
  return crypto.createHash("sha256").update(stableJson(copy)).digest("hex");
}

test("append fsync 后跨重启保留单调 seq/revision", () => {
  const value = fixture();
  try {
    let store = value.create();
    store.open();
    const first = append(store, { text: "hello" });
    const second = append(store, { kind: "assistant", text: "world" });
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(store.getRevision("profile-1", "session-1"), 2);
    store.close();
    store = value.create();
    store.open();
    assert.deepEqual(store.listEvents("profile-1", "session-1").map((event) => event.seq), [1, 2]);
  } finally { value.cleanup(); }
});

test("journal fsync uncertain poisons writes until cold replay resolves the event", () => {
  let failAfterDurableFsync = false;
  const injectedFs = new Proxy(fs, { get(target, key) {
    if (key !== "fsyncSync") return Reflect.get(target, key);
    return (fd) => {
      target.fsyncSync(fd);
      if (failAfterDurableFsync) {
        failAfterDurableFsync = false;
        throw new Error("injected post-durable journal fsync failure");
      }
    };
  } });
  const value = fixture({ fs: injectedFs });
  try {
    let store = value.create();
    store.open();
    append(store, { id: "first", text: "first" });
    const firstDigest = store.getIndexSnapshot("profile-1", "session-1").sourceIdentity;
    failAfterDurableFsync = true;
    assert.throws(() => append(store, { id: "uncertain", text: "uncertain" }),
      (error) => error.code === "TRANSCRIPT_COMMIT_UNCERTAIN"
        && error.committedUncertain === true);
    assert.throws(() => append(store, { id: "no-retry", text: "must not duplicate seq" }),
      (error) => error.code === "TRANSCRIPT_COMMIT_UNCERTAIN");
    store.close();

    store = value.create();
    store.open();
    assert.deepEqual(store.listEvents("profile-1", "session-1").map((event) => event.id),
      ["first", "uncertain"], "cold replay recovers the complete durable record");
    const restored = store.getIndexSnapshot("profile-1", "session-1");
    assert.equal(restored.revision, 2);
    assert.equal(store.getIndexPrefixDigest("profile-1", "session-1", 1), firstDigest);
    assert.notEqual(restored.sourceIdentity, firstDigest);
    assert.equal(append(store, { id: "after-replay", text: "third" }).seq, 3);
  } finally { value.cleanup(); }
});

test("Transcript ref 必须携带账号，旧 journal ref 即使校验和有效也拒绝", () => {
  const value = fixture();
  try {
    let store = value.create();
    store.open();
    const runtimeRef = {
      runtime: "codex",
      runtimeProfileId: "runtime-profile-1",
      runtimeAccountId: "runtime-account-1",
      sessionId: "runtime-session-1",
      turnId: "runtime-turn-1",
    };
    const current = append(store, { id: "current-ref", runtimeRef });
    assert.deepEqual(current.runtimeRef, runtimeRef);
    assert.throws(
      () => append(store, {
        id: "missing-account-ref",
        runtimeRef: {
          runtime: "codex",
          runtimeProfileId: "runtime-profile-1",
          sessionId: "runtime-session-1",
        },
      }),
      (error) => error.code === "TRANSCRIPT_EVENT_INVALID",
    );
    store.close();

    const log = path.join(
      value.paths.agentsDir, "profile-1", "transcripts", "session-1", "events.jsonl",
    );
    const record = JSON.parse(fs.readFileSync(log, "utf8").trim());
    const currentRecord = structuredClone(record);
    delete record.payload.runtimeRef.runtimeAccountId;
    record.checksum = checksumRecord(record);
    fs.writeFileSync(log, `${stableJson(record)}\n`, { mode: 0o600 });

    store = value.create();
    store.open();
    assert.throws(() => store.listEvents("profile-1", "session-1"),
      (error) => error.code === "TRANSCRIPT_EVENT_INVALID");
    store.close();

    fs.writeFileSync(log, `${stableJson(currentRecord)}\n`, { mode: 0o600 });
    store = value.create();
    store.open();
    assert.deepEqual(store.listEvents("profile-1", "session-1")[0].runtimeRef, runtimeRef);
  } finally { value.cleanup(); }
});

test("首条用户消息派生 Session 标题并忽略 assistant 与后续消息", () => {
  const value = fixture();
  try {
    const store = value.create();
    store.open();
    append(store, { kind: "assistant", text: "不应成为标题" });
    append(store, { id: "first-user", text: "  第一行\n\t第二行  " });
    append(store, { id: "second-user", text: "后续问题" });
    assert.equal(store.getSessionDerivedTitle("profile-1", "session-1"), "第一行 第二行");
  } finally { value.cleanup(); }
});

test("历史导入的首条用户消息也能派生标题并按 Unicode 字符截断", () => {
  const value = fixture();
  try {
    const store = value.create();
    store.open();
    const text = `历史问题 ${"🌋".repeat(61)}`;
    store.importHistoryItems({
      profileId: "profile-1",
      sessionId: "session-1",
      items: [{
        id: "codex-user-1",
        runId: null,
        role: "user",
        type: "text",
        payload: { message: {
          id: "message-user-1", role: "user", content: [{ type: "text", text }],
        } },
        createdAt: 54,
        fragment: null,
      }],
      runtimeRef: null,
    });
    const title = store.getSessionDerivedTitle("profile-1", "session-1");
    assert.equal(Array.from(title).length, 60);
    assert.equal(title.isWellFormed(), true);
    assert.equal(title.startsWith("历史问题 "), true);
  } finally { value.cleanup(); }
});

test("event id 幂等重放返回原事件，输入变化 fail closed", () => {
  const value = fixture();
  try {
    const store = value.create();
    store.open();
    const input = { id: "stable-event", text: "same", occurredAt: 1234 };
    const first = append(store, input);
    const replay = append(store, input);
    assert.deepEqual(replay, first);
    assert.equal(store.listEvents("profile-1", "session-1").length, 1);
    assert.throws(() => append(store, { ...input, text: "changed" }),
      (error) => error.code === "TRANSCRIPT_EVENT_CONFLICT");
  } finally { value.cleanup(); }
});

test("运行中原始 journal 丢失或等长篡改时不再读取缓存事件", () => {
  const value = fixture();
  try {
    const store = value.create();
    store.open();
    const event = append(store, { id: "cached-source", text: "用户原话" });
    const log = path.join(value.paths.agentsDir, "profile-1", "transcripts", "session-1", "events.jsonl");
    const original = fs.readFileSync(log);
    let replays = 0;
    const repairTail = store._repairPartialTail.bind(store);
    store._repairPartialTail = (...args) => { replays += 1; return repairTail(...args); };
    assert.equal(store.getEvent("profile-1", "session-1", event.id).content.text, "用户原话");
    assert.equal(store.listEventsPage("profile-1", "session-1", 0, 1).length, 1);
    assert.equal(replays, 0, "正常缓存读取不应重新加载整份 journal");
    fs.unlinkSync(log);
    for (const read of [
      () => store.getEvent("profile-1", "session-1", event.id),
      () => store.listEvents("profile-1", "session-1"),
      () => store.listEventsPage("profile-1", "session-1", 0, 1),
      () => store.hasUserEventForRun("profile-1", "session-1", "run-1"),
      () => append(store, { id: "after-loss", text: "不应追加" }),
    ]) assert.throws(read, (error) => error.code === "TRANSCRIPT_SOURCE_CHANGED");
    assert.equal(fs.existsSync(log), false, "缓存失效时不能重新创建缺失的 journal");
    fs.writeFileSync(log, original, { mode: 0o600 });
    store.close(); store.open();
    assert.equal(store.getEvent("profile-1", "session-1", event.id).content.text, "用户原话");
    const corrupt = Buffer.from(original);
    const offset = corrupt.indexOf(Buffer.from("event.append"));
    assert.ok(offset >= 0);
    corrupt[offset] = 0x78;
    fs.writeFileSync(log, corrupt, { mode: 0o600 });
    assert.throws(() => store.getEvent("profile-1", "session-1", event.id),
      (error) => error.code === "TRANSCRIPT_SOURCE_CHANGED");
  } finally { value.cleanup(); }
});

test("contextExcluded 是 journal mutation，过滤后下一次读取不可见", () => {
  const value = fixture();
  try {
    const store = value.create();
    store.open();
    const event = append(store, { id: "exclude-me", text: "private context" });
    store.setContextExcluded({
      profileId: "profile-1", sessionId: "session-1", eventId: event.id, contextExcluded: true,
    });
    assert.equal(store.getRevision("profile-1", "session-1"), 2);
    assert.equal(store.listEvents("profile-1", "session-1").length, 1);
    assert.equal(store.listEvents("profile-1", "session-1", {
      includeContextExcluded: false,
    }).length, 0);
  } finally { value.cleanup(); }
});

test("Codex history 只读导入按 item id 幂等，不取得未来写权限", () => {
  const value = fixture();
  try {
    const store = value.create();
    store.open();
    const item = {
      id: "codex-message-1",
      runId: null,
      role: "assistant",
      type: "text",
      payload: { message: {
        id: "message-1", role: "assistant", content: [{ type: "text", text: "imported" }],
      } },
      createdAt: 55,
      fragment: null,
    };
    store.importHistoryItems({
      profileId: "profile-1", sessionId: "session-1", items: [item], runtimeRef: null,
    });
    store.importHistoryItems({
      profileId: "profile-1", sessionId: "session-1", items: [item], runtimeRef: null,
    });
    const events = store.listEvents("profile-1", "session-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].content.importedFrom, "codex");
    assert.deepEqual(events[0].content.historyItem, item);
  } finally { value.cleanup(); }
});

test("尾部半行在重启时安全截断，中间损坏 fail closed", () => {
  const value = fixture();
  try {
    let store = value.create();
    store.open();
    append(store, { id: "first", text: "one" });
    store.close();
    const log = path.join(
      value.paths.agentsDir, "profile-1", "transcripts", "session-1", "events.jsonl",
    );
    fs.appendFileSync(log, '{"partial":', { mode: 0o600 });
    store = value.create();
    store.open();
    assert.equal(store.listEvents("profile-1", "session-1").length, 1);
    store.close();
    const original = fs.readFileSync(log, "utf8");
    fs.writeFileSync(log, original.replace('"event.append"', '"event.broken"'), { mode: 0o600 });
    store = value.create();
    store.open();
    assert.throws(() => store.listEvents("profile-1", "session-1"),
      (error) => error.code === "TRANSCRIPT_LOG_CORRUPT");
  } finally { value.cleanup(); }
});

test("Runtime home 缺失不影响权威 transcript export", () => {
  const value = fixture();
  try {
    let store = value.create();
    store.open();
    append(store, { id: "user", text: "question" });
    append(store, { id: "answer", kind: "assistant", text: "answer" });
    store.close();
    const runtimeHome = path.join(value.paths.stateDir, "runtimes", "codex", "profile-1");
    fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runtimeHome, "thread.json"), "runtime cache", { mode: 0o600 });
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    store = value.create();
    store.open();
    const exported = store.exportSession("profile-1", "session-1");
    assert.equal(exported.events.length, 2);
    assert.deepEqual(exported.events.map((event) => event.content.text), ["question", "answer"]);
  } finally { value.cleanup(); }
});

test("用量活动按 Profile 与区间汇总 tool_call，且不重复计算 tool_result", () => {
  const current = new Date(2026, 8, 21, 12, 0, 0).getTime();
  const value = fixture({ now: () => current });
  try {
    const store = value.create();
    store.open();
    append(store, { id: "usage-user", occurredAt: current - 1000 });
    append(store, { id: "usage-assistant", kind: "assistant", occurredAt: current - 900 });
    append(store, {
      id: "usage-tool-command", kind: "tool_call", occurredAt: current - 800,
      content: { transcriptType: "tool.start", tool: { name: "command" } },
    });
    append(store, {
      id: "usage-tool-command-result", kind: "tool_result", occurredAt: current - 700,
      content: { transcriptType: "tool.result", tool: { name: "command" } },
    });
    append(store, {
      id: "usage-tool-search", kind: "tool_call", occurredAt: current - 600,
      content: { transcriptType: "tool.start", tool: { name: "webSearch" } },
      contextExcluded: true,
    });
    append(store, { id: "usage-error", kind: "error", occurredAt: current - 500 });
    append(store, {
      id: "usage-tool-old", kind: "tool_call", occurredAt: current - 40 * 86400_000,
      content: { transcriptType: "tool.start", tool: { name: "oldTool" } },
    });
    store.appendEvent({
      profileId: "profile-2", sessionId: "session-2", id: "other-profile-tool",
      runId: "run-2", kind: "tool_call", content: { tool: { name: "otherTool" } },
      runtimeRef: null, contextExcluded: false, occurredAt: current - 400,
    });

    const summary = store.summarizeUsageActivity("30d", new Set(["profile-1"]));
    assert.deepEqual(summary.tools, {
      totalCalls: 2,
      uniqueTools: 2,
      tools: [{ name: "command", count: 1 }, { name: "webSearch", count: 1 }],
    });
    assert.deepEqual(summary.messages, {
      total: 2, user: 1, assistant: 1, toolCalls: 2, errors: 1,
    });
    assert.deepEqual(summary.dailyActivity, [{
      date: "2026-09-21", messages: 2, toolCalls: 2, errors: 1,
    }]);
    assert.throws(
      () => store.summarizeUsageActivity("30d", new Set(["bad profile"])),
      (error) => error.code === "TRANSCRIPT_USAGE_SCOPE_INVALID",
    );
  } finally { value.cleanup(); }
});

(async () => {
  let passed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`ok - ${item.name}`);
    } catch (error) {
      console.error(`not ok - ${item.name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }
  if (passed === tests.length) console.log(`${passed} transcript store tests passed`);
})();
