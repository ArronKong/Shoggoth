#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { TokenUsageStore } = require("../app/agent-service/token-usage-store");
const { MAX_USAGE_RESULT_BYTES } = require("../app/agent-service/token-usage-protocol");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixture(prefix = "shoggoth-token-usage-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  return { root, paths };
}

function usage(overrides = {}) {
  return {
    profileId: "profile-default",
    agentId: "shoggoth-agent",
    agentName: "Shoggoth",
    source: "chat",
    sourceId: "session-default",
    threadId: "thread-default",
    turnId: "turn-default",
    responseId: "response-default",
    runId: "run-default", runtime: "codex", runtimeAccountId: "native-codex-default-v1",
    model: "gpt-5.6-sol",
    provider: "chatgpt",
    usage: {
      totalTokens: 150,
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 10,
      outputTokens: 50,
      reasoningOutputTokens: 20,
    },
    createdAt: new Date(2026, 0, 10, 10, 0, 0).getTime(),
    ...overrides,
  };
}

test("exact response usage 持久化、幂等且冲突不追加", () => {
  const { root, paths } = fixture();
  try {
    const store = new TokenUsageStore({
      paths,
      now: () => new Date(2026, 0, 10, 12, 0, 0).getTime(),
    }).open();
    const first = store.record(usage());
    assert.match(first.id, /^usage-[a-f0-9]{64}$/u);
    const before = fs.readFileSync(paths.tokenUsagePath);
    assert.deepEqual(store.record(usage()), first);
    assert.deepEqual(fs.readFileSync(paths.tokenUsagePath), before);
    assert.throws(
      () => store.record(usage({ usage: { ...usage().usage, totalTokens: 151 } })),
      (error) => error.code === "TOKEN_USAGE_ID_CONFLICT",
    );
    assert.deepEqual(fs.readFileSync(paths.tokenUsagePath), before);
    store.close();

    const reopened = new TokenUsageStore({ paths }).open();
    assert.deepEqual(reopened.list({ threadId: "thread-default" }), [first]);
    reopened.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("按本地日、Agent、模型与会话汇总真实 token 分项", () => {
  const { root, paths } = fixture();
  const now = new Date(2026, 0, 10, 12, 0, 0).getTime();
  try {
    const store = new TokenUsageStore({ paths, now: () => now }).open();
    store.record(usage());
    store.record(usage({
      responseId: "response-second",
      turnId: "turn-second",
      model: "gpt-5.6-terra",
      usage: {
        totalTokens: 30,
        inputTokens: 20,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      },
      createdAt: new Date(2026, 0, 9, 23, 0, 0).getTime(),
    }));
    store.record(usage({
      responseId: "response-old",
      turnId: "turn-old",
      source: "cron",
      sourceId: "job-old",
      usage: {
        totalTokens: 5,
        inputTokens: 3,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 0,
      },
      createdAt: new Date(2025, 10, 1, 10, 0, 0).getTime(),
    }));

    const today = store.summarize("today");
    assert.equal(today.series.daily.length, 1);
    assert.equal(today.series.totals.totalTokens, 150);
    assert.equal(today.series.totals.inputTokens, 50);
    assert.equal(today.series.totals.outputTokens, 30);
    assert.equal(today.series.totals.cacheReadTokens, 40);
    assert.equal(today.series.totals.cacheWriteTokens, 10);
    assert.equal(today.series.totals.reasoningTokens, 20);
    assert.equal(today.series.totals.missingCostEntries, 0);
    assert.equal(today.series.totals.estimatedCostEntries, 1);
    assert.equal(today.series.totals.totalCost, (50 * 4 + 40 * 0.4 + 10 * 5 + 50 * 20) / 1e6);
    assert.equal(today.breakdown.topSessions[0].totalCost, today.series.totals.totalCost);

    const month = store.summarize("30d");
    assert.equal(month.series.totals.totalTokens, 180);
    assert.equal(month.breakdown.byModel.length, 2);
    assert.equal(month.breakdown.bySource[0].label, "Shoggoth");
    assert.equal(month.breakdown.bySource[0].totalTokens, 180);
    assert.equal(month.breakdown.topSessions.length, 1);
    assert.equal(month.breakdown.topSessions[0].models.length, 2);
    assert.deepEqual(month.series.daily.map((row) => row.date), ["2026-01-09", "2026-01-10"]);

    const all = store.summarize("all");
    assert.equal(all.series.totals.totalTokens, 185);
    assert.equal(all.breakdown.topSessions.length, 2);
    assert.deepEqual(all.series.daily.map((row) => row.date), ["2025-11-01", "2026-01-01"]);
    store.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("backend 归属范围只汇总 Service 解析的 profileIds，且投影稳定 backendId", () => {
  const { root, paths } = fixture("shoggoth-token-usage-scope-");
  const now = new Date(2026, 0, 10, 12, 0, 0).getTime();
  try {
    const store = new TokenUsageStore({ paths, now: () => now }).open();
    store.record(usage({ profileId: "profile-shoggoth" }));
    store.record(usage({
      profileId: "profile-codex",
      agentId: "codex-agent",
      agentName: "Codex",
      sourceId: "session-codex",
      threadId: "thread-codex",
      turnId: "turn-codex",
      responseId: "response-codex",
      usage: { ...usage().usage, totalTokens: 250 },
    }));
    store.record(usage({
      profileId: "profile-grok",
      agentId: "grok-agent",
      agentName: "Grok",
      sourceId: "session-grok",
      threadId: "thread-grok",
      turnId: "turn-grok",
      responseId: "response-grok",
      usage: { ...usage().usage, totalTokens: 350 },
    }));

    const scoped = store.summarize("today", {
      backendId: "codex",
      profileIds: new Set(["profile-codex"]),
    });
    assert.equal(scoped.series.totals.totalTokens, 250);
    assert.deepEqual(scoped.breakdown.bySource.map((row) => [row.backendId, row.profile]), [
      ["codex", "profile-codex"],
    ]);
    assert.equal(scoped.breakdown.topSessions[0].key, "codex:chat:session-codex");
    const empty = store.summarize("today", {
      backendId: "grok-build",
      profileIds: new Set(),
    });
    assert.equal(empty.series.totals.totalTokens, 0);
    assert.deepEqual(empty.breakdown.bySource, []);
    for (const invalid of [
      { backendId: "Codex", profileIds: new Set(["profile-codex"]) },
      { backendId: "codex", profileIds: ["profile-codex"] },
      { backendId: "codex", profileIds: new Set([""]) },
    ]) assert.throws(
      () => store.summarize("today", invalid),
      (error) => error.code === "TOKEN_USAGE_INVALID",
    );
    store.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("长区间按周/月收敛且排行始终落在单帧预算内", () => {
  const { root, paths } = fixture();
  const now = new Date(2026, 11, 31, 12, 0, 0).getTime();
  try {
    const store = new TokenUsageStore({ paths, now: () => now }).open();
    for (let index = 0; index < 400; index += 1) {
      store.record(usage({
        profileId: `profile-${index % 40}`,
        agentId: `agent-${index % 40}`,
        agentName: `Agent ${index % 40}`,
        sourceId: `session-${index}`,
        threadId: `thread-${index}`,
        turnId: `turn-${index}`,
        responseId: `response-${index}`,
        model: `model-${index % 40}`,
        createdAt: now - index * 24 * 60 * 60 * 1000,
      }));
    }

    const year = store.summarize("1y");
    assert.ok(year.series.daily.length <= 53);
    const all = store.summarize("all");
    assert.ok(all.series.daily.length <= 14);
    assert.equal(all.breakdown.byModel.length, 24);
    assert.equal(all.breakdown.byAgent.length, 32);
    assert.equal(all.breakdown.bySource.length, 32);
    assert.ok(all.breakdown.modelDaily.length <= 240);
    assert.ok(Buffer.byteLength(JSON.stringify(all.series), "utf8") <= MAX_USAGE_RESULT_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(all.breakdown), "utf8") <= MAX_USAGE_RESULT_BYTES);
    store.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("reported cost overrides estimates, zero is valid, unknown prices stay missing and old rows remain readable", () => {
  const { root, paths } = fixture();
  const now = new Date(2026, 0, 10, 12).getTime();
  try {
    const store = new TokenUsageStore({ paths, now: () => now }).open();
    store.record(usage({ responseId: "old-format" }));
    store.record(usage({ responseId: "paid", costUsd: 0.25 }));
    store.record(usage({ responseId: "free", costUsd: 0 }));
    store.record(usage({ responseId: "unknown", model: "unknown-model" }));
    assert.throws(() => store.record(usage({ costUsd: -1 })), { code: "TOKEN_USAGE_INVALID" });
    const totals = store.summarize("today").series.totals;
    assert.equal(totals.missingCostEntries, 1);
    assert.equal(totals.estimatedCostEntries, 1);
    assert.ok(totals.totalCost > 0.25 && totals.totalCost < 0.26);
    store.close();
    const reopened = new TokenUsageStore({ paths, now: () => now }).open();
    assert.deepEqual(reopened.summarize("today").series.totals, totals);
    reopened.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("崩溃尾行可截断，中间损坏、symlink 与敏感值 fail closed", () => {
  const first = fixture();
  try {
    const store = new TokenUsageStore({ paths: first.paths }).open();
    store.record(usage());
    store.close();
    fs.appendFileSync(first.paths.tokenUsagePath, "{\"version\":");
    const recovered = new TokenUsageStore({ paths: first.paths }).open();
    assert.equal(recovered.list().length, 1);
    assert.equal(fs.readFileSync(first.paths.tokenUsagePath, "utf8").endsWith("\n"), true);
    recovered.close();
    const rows = fs.readFileSync(first.paths.tokenUsagePath, "utf8").trim().split("\n");
    const envelope = JSON.parse(rows[0]);
    envelope.checksum = "0".repeat(64);
    fs.writeFileSync(first.paths.tokenUsagePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    assert.throws(
      () => new TokenUsageStore({ paths: first.paths }).open(),
      (error) => error.code === "TOKEN_USAGE_STORE_CORRUPT",
    );
  } finally { fs.rmSync(first.root, { recursive: true, force: true }); }

  const second = fixture();
  try {
    const store = new TokenUsageStore({ paths: second.paths }).open();
    store.close();
    const victim = path.join(second.root, "victim");
    fs.writeFileSync(victim, "survive", { mode: 0o600 });
    fs.unlinkSync(second.paths.tokenUsagePath);
    fs.symlinkSync(victim, second.paths.tokenUsagePath);
    assert.throws(
      () => new TokenUsageStore({ paths: second.paths }).open(),
      (error) => error.code === "UNSAFE_SYMLINK",
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "survive");
  } finally { fs.rmSync(second.root, { recursive: true, force: true }); }

  const third = fixture();
  try {
    const store = new TokenUsageStore({
      paths: third.paths,
      isSensitiveValue: (value) => value.includes("sensitive-canary"),
    }).open();
    assert.throws(
      () => store.record(usage({ agentName: "sensitive-canary" })),
      (error) => error.code === "TOKEN_USAGE_SENSITIVE_VALUE",
    );
    assert.equal(fs.readFileSync(third.paths.tokenUsagePath, "utf8"), "");
    store.close();
  } finally { fs.rmSync(third.root, { recursive: true, force: true }); }
});

(async () => {
  let passed = 0;
  for (const entry of tests) {
    await entry.fn();
    passed += 1;
    process.stdout.write(`PASS ${entry.name}\n`);
  }
  process.stdout.write(`[shoggoth-token-usage-store-unit] PASS ${passed}/${tests.length}\n`);
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
