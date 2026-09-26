"use strict";

// Unit test for usage-file-scan (R173) — the local session-file token
// aggregation that replaces gateway usage.cost/sessions.usage on a local
// gateway. Verifies the exact failure modes that motivated it: orphan
// transcripts (on disk but missing from sessions.json) and trajectory-only
// sessions both count; trajectory snapshot duplication does NOT double-count.
// Run: node scripts/usage-file-scan-unit.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanUsageCube, cubeToSeries, cubeToBreakdown, localDateStr } = require("../app/core/usage-file-scan");

// Fixed "now": today noon local. Message timestamps are built relative to it,
// and expectations use the same localDateStr — timezone-independent.
const NOW = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const TODAY = localDateStr(NOW);
const YESTERDAY = localDateStr(NOW - 86_400_000);

function usage(tokens, cost = 0) {
  return {
    input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}
function assistantMsg(ts, tokens, { model = "m1", provider = "p1", cost = 0, stopReason = "stop", errorMessage, content } = {}) {
  return { role: "assistant", content: content || [{ type: "text", text: "ok" }], provider, model, usage: usage(tokens, cost), stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: ts };
}
function plainLine(msg) { return JSON.stringify({ type: "message", message: msg }); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-scan-test-"));
const agentsDir = path.join(root, "agents");
function writeSession(agentId, fileName, lines) {
  const dir = path.join(agentsDir, agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), lines.join("\n") + "\n");
}

// --- agent "alpha": one indexed session + one ORPHAN session (not in index) ---
writeSession("alpha", "11111111-aaaa-4aaa-8aaa-111111111111.jsonl", [
  JSON.stringify({ type: "session", version: 3, id: "11111111-aaaa-4aaa-8aaa-111111111111" }),
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: NOW - 3_600_000 } }),
  plainLine(assistantMsg(NOW - 3_500_000, 1000, { cost: 0.5, content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "c1", name: "web_search", arguments: {} }] })),
  plainLine(assistantMsg(NOW - 3_400_000, 200, { stopReason: "error", errorMessage: "429 rate limited" })),
]);
// orphan: real transcript, deliberately NOT registered in sessions.json
writeSession("alpha", "22222222-bbbb-4bbb-8bbb-222222222222.jsonl", [
  plainLine(assistantMsg(NOW - 3_000_000, 5000, { model: "m2", provider: "p2" })),
  plainLine(assistantMsg(NOW - 86_400_000, 300, { model: "m2", provider: "p2" })), // yesterday
]);
fs.writeFileSync(path.join(agentsDir, "alpha", "sessions", "sessions.json"), JSON.stringify({
  "agent:alpha:telegram:group:1": { sessionId: "11111111-aaaa-4aaa-8aaa-111111111111", channel: "telegram", displayName: "tg:group", updatedAt: NOW },
  "agent:alpha:cron:phantom": { sessionId: "99999999-9999-4999-8999-999999999999", channel: "cron", updatedAt: NOW }, // phantom: no file
}));

// --- agent "beta": trajectory-ONLY session with duplicated snapshots ---
const snapMsg1 = assistantMsg(NOW - 2_000_000, 700, { model: "m3", provider: "p3" });
const snapMsg2 = assistantMsg(NOW - 1_900_000, 800, { model: "m3", provider: "p3" });
writeSession("beta", "33333333-cccc-4ccc-8ccc-333333333333.trajectory.jsonl", [
  JSON.stringify({ traceSchema: "openclaw-trajectory", type: "session.started", ts: new Date(NOW - 2_100_000).toISOString() }),
  // first completion: snapshot has msg1
  JSON.stringify({ type: "model.completed", ts: new Date(NOW - 2_000_000).toISOString(), data: { messagesSnapshot: [{ role: "user", content: [], timestamp: NOW - 2_050_000 }, snapMsg1] } }),
  // second completion: snapshot REPEATS msg1 and adds msg2 — msg1 must not double-count
  JSON.stringify({ type: "model.completed", ts: new Date(NOW - 1_900_000).toISOString(), data: { messagesSnapshot: [{ role: "user", content: [], timestamp: NOW - 2_050_000 }, snapMsg1, snapMsg2] } }),
]);

// --- agent "gamma": plain + trajectory for the SAME uuid → plain wins, no double-count ---
writeSession("gamma", "44444444-dddd-4ddd-8ddd-444444444444.jsonl", [
  plainLine(assistantMsg(NOW - 1_000_000, 400, { model: "m4", provider: "p4" })),
]);
writeSession("gamma", "44444444-dddd-4ddd-8ddd-444444444444.trajectory.jsonl", [
  JSON.stringify({ type: "model.completed", ts: new Date(NOW - 1_000_000).toISOString(), data: { messagesSnapshot: [assistantMsg(NOW - 1_000_000, 999_999, { model: "m4", provider: "p4" })] } }),
]);
// non-.jsonl companions must be ignored (reset archives, trajectory-path pointers)
writeSession("gamma", "44444444-dddd-4ddd-8ddd-444444444444.jsonl.reset.123", [plainLine(assistantMsg(NOW - 900_000, 777_777))]);
fs.writeFileSync(path.join(agentsDir, "gamma", "sessions", "44444444-dddd-4ddd-8ddd-444444444444.trajectory-path.json"), "{}");
// message with no timestamp → cannot be dated, skipped
writeSession("gamma", "55555555-eeee-4eee-8eee-555555555555.jsonl", [
  JSON.stringify({ type: "message", message: { role: "assistant", content: [], model: "m4", usage: usage(123_456) } }),
]);

(async () => {
  const cube = await scanUsageCube({ agentsDir });

  // --- series: today ---
  const today = cubeToSeries(cube, "today", NOW);
  // today = 1000 + 200 (indexed) + 5000 (orphan) + 700 + 800 (traj-only) + 400 (plain-wins) = 8100
  assert.equal(today.totals.totalTokens, 8100, `today totals ${today.totals.totalTokens}`);
  assert.equal(today.daily.length, 1);
  assert.equal(today.daily[0].date, TODAY);
  assert.equal(today.totals.totalCost, 0.5, "cost flows from message usage.cost.total");

  // --- series: 7d includes yesterday's 300 and zero-fills gaps ---
  const week = cubeToSeries(cube, "7d", NOW);
  assert.equal(week.daily.length, 7, "7d daily is a continuous 7-day window");
  assert.equal(week.totals.totalTokens, 8400);
  const yRow = week.daily.find((d) => d.date === YESTERDAY);
  assert.equal(yRow.totalTokens, 300, "yesterday bucket");
  assert.equal(week.daily.filter((d) => d.totalTokens === 0).length, 5, "gap days zero-filled");

  // --- breakdown: today ---
  const bd = cubeToBreakdown(cube, "today", NOW);
  const byModel = Object.fromEntries(bd.byModel.map((m) => [`${m.provider}/${m.model}`, m.totalTokens]));
  assert.deepEqual(byModel, { "p2/m2": 5000, "p3/m3": 1500, "p1/m1": 1200, "p4/m4": 400 }, `byModel ${JSON.stringify(byModel)}`);
  assert.equal(bd.byModel[0].model, "m2", "byModel sorted tokens desc");
  const byAgent = Object.fromEntries(bd.byAgent.map((a) => [a.agentId, a.totalTokens]));
  assert.deepEqual(byAgent, { alpha: 6200, beta: 1500, gamma: 400 });
  const byChannel = Object.fromEntries(bd.byChannel.map((c) => [c.channel, c.totalTokens]));
  // indexed session → telegram; orphan + traj-only + gamma (no index) → unknown
  assert.equal(byChannel.telegram, 1200);
  assert.equal(byChannel.unknown, 6900);
  assert.equal(bd.tools.totalCalls, 1);
  assert.deepEqual(bd.tools.tools, [{ name: "web_search", count: 1 }]);
  assert.equal(bd.messages.errors, 1, "stopReason:error counted");
  // today: alpha indexed 2 + alpha orphan 1 (yesterday's excluded) + beta 2 (snapshot repeat deduped) + gamma 1 (plain wins)
  assert.equal(bd.messages.assistant, 6, "assistant msgs deduped (traj repeat + plain-wins)");
  // orphan session must appear in topSessions (the whole point of R173)
  const orphanTop = bd.topSessions.find((s) => s.key === "22222222-bbbb-4bbb-8bbb-222222222222");
  assert.ok(orphanTop, "orphan session present in topSessions");
  assert.equal(orphanTop.totalTokens, 5000, "orphan today slice excludes yesterday");
  // single-model session still gets a 1-entry per-model breakdown (uniform shape)
  assert.deepEqual(orphanTop.models, [{ model: "p2/m2", tokens: 5000 }], "single-model session models array");
  const indexedTop = bd.topSessions.find((s) => s.key === "agent:alpha:telegram:group:1");
  assert.equal(indexedTop.label, "tg:group", "indexed session uses sessions.json key/label");
  assert.equal(bd.missingCostEntries, 5, "token>0 cost=0 messages counted as missing-cost");
  assert.equal(bd.cacheStatus, "fresh");
  assert.equal(bd.scanLimit, undefined, "no scanLimit unless truncated");

  // --- range slicing: yesterday-only session token must not leak into today's topSessions ---
  const bd7 = cubeToBreakdown(cube, "7d", NOW);
  const orphan7 = bd7.topSessions.find((s) => s.key === "22222222-bbbb-4bbb-8bbb-222222222222");
  assert.equal(orphan7.totalTokens, 5300, "7d slice includes yesterday");

  // --- maxFiles truncation surfaces scanLimit ---
  const small = await scanUsageCube({ agentsDir, maxFiles: 2 });
  const bdSmall = cubeToBreakdown(small, "today", NOW);
  assert.equal(bdSmall.scanLimit, 2, "truncation reported via scanLimit");

  // --- multi-model session: topSessions carries per-model tokens, sorted desc, range-sliced ---
  // Separate fixture root so the aggregate assertions above stay untouched.
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "usage-scan-test2-"));
  const agentsDir2 = path.join(root2, "agents");
  const dir2 = path.join(agentsDir2, "delta", "sessions");
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, "66666666-ffff-4fff-8fff-666666666666.jsonl"), [
    plainLine(assistantMsg(NOW - 500_000, 3000, { model: "m5", provider: "p5" })),
    plainLine(assistantMsg(NOW - 400_000, 2000, { model: "m6", provider: "p6" })),
    plainLine(assistantMsg(NOW - 350_000, 0, { model: "m8", provider: "p8" })), // zero-token turn → excluded from models
    plainLine(assistantMsg(NOW - 300_000, 1000, { model: "m7", provider: null })), // no provider → bare label
    plainLine(assistantMsg(NOW - 86_400_000, 400, { model: "m6", provider: "p6" })), // yesterday
  ].join("\n") + "\n");
  try {
    const cube2 = await scanUsageCube({ agentsDir: agentsDir2 });
    const multi = cubeToBreakdown(cube2, "today", NOW).topSessions
      .find((s) => s.key === "66666666-ffff-4fff-8fff-666666666666");
    assert.ok(multi, "multi-model session present in topSessions");
    assert.deepEqual(multi.models, [
      { model: "p5/m5", tokens: 3000 },
      { model: "p6/m6", tokens: 2000 },
      { model: "m7", tokens: 1000 },
    ], "models sorted tokens desc; today slice excludes yesterday's m6 tokens");
    assert.equal(multi.model, "m7", "legacy single model field stays last-used");
    assert.equal(multi.totalTokens, 6000, "session total spans all models");
    const multi7 = cubeToBreakdown(cube2, "7d", NOW).topSessions
      .find((s) => s.key === "66666666-ffff-4fff-8fff-666666666666");
    assert.deepEqual(multi7.models, [
      { model: "p5/m5", tokens: 3000 },
      { model: "p6/m6", tokens: 2400 },
      { model: "m7", tokens: 1000 },
    ], "7d slice folds yesterday's m6 into the same model row");
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }

  // --- OpenClaw 成本兼容：旧/第三方 transcript 可能只写成本分项、不写 total ---
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), "usage-scan-cost-parts-"));
  const agentsDir3 = path.join(root3, "agents");
  const dir3 = path.join(agentsDir3, "epsilon", "sessions");
  fs.mkdirSync(dir3, { recursive: true });
  const componentOnly = assistantMsg(NOW - 200_000, 150, { model: "m9", provider: "p9" });
  componentOnly.usage = {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0 },
  };
  fs.writeFileSync(
    path.join(dir3, "77777777-aaaa-4aaa-8aaa-777777777777.jsonl"),
    `${plainLine(componentOnly)}\n`,
  );
  try {
    const costParts = cubeToSeries(await scanUsageCube({ agentsDir: agentsDir3 }), "today", NOW).totals;
    assert.equal(costParts.totalCost, 0.5, "cost.total 缺失时由成本分项求和");
    assert.equal(costParts.inputCost, 0.2);
    assert.equal(costParts.outputCost, 0.3);
    assert.equal(costParts.missingCostEntries, 0, "分项成本存在时不应标记缺价格");
  } finally {
    fs.rmSync(root3, { recursive: true, force: true });
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log("✓ usage-file-scan-unit: all cases passed");
})().catch((err) => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
