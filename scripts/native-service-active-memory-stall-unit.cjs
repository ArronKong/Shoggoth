"use strict";

// 2026-10-20 原生 Service 卡顿回归：直聊发送时 Active Memory 在准入前运行，期间主线程不能长时间阻塞。
// 真实 Service / Coordinator / Product Store / 记忆内核；只有原生传输与记忆模型是 fixture。
// 规模接近现场：21 个 Agent、约 200 个会话（25 个已完成的历史会话进入会话记忆索引）、
// 目标 Agent 14 个记忆文件。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { installLiteralMemoryModelControl } = require("./fixtures/literal-memory-model-control.cjs");

const HISTORY_SESSIONS = 25, TURNS = 6, IDLE_SESSIONS = 180, EXTRA_PROFILES = 20, MEMORY_FILES = 12;
const PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef",
  "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
// The App treats a Service that cannot answer within 1s as busy; stay well under it.
// The counts are load-independent: before the fix one admission ran 874 transcript
// scans and 12074 memory-file walks, the loop blocked 3.7s (unloaded).
const MAX_LOOP_BLOCK_MS = 1_000, MAX_TRANSCRIPT_SCANS = 150, MAX_MEMORY_FILE_WALKS = 20;

// Samples every 5ms; a gap well above the interval is time the loop could not run.
function loopBlockMonitor() {
  let last = performance.now(), max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 5);
    last = now;
  }, 5);
  return { stop() { clearInterval(timer); return Math.max(max, performance.now() - last - 5); } };
}

test("direct chat admission keeps both Active Memory paths within the Service loop budget", { timeout: 300_000 }, async t => {
  const memoryCoreConfig = { memory: { search: { provider: "none", rememberAcrossConversations: true } },
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
    plugins: { entries: { "active-memory": { enabled: true, config: { enabled: true, mode: "escalate", model: "literal" } } } } };
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true, memoryCoreConfig } });
  try {
    const owner = f.service.memoryEngine;
    installLiteralMemoryModelControl(owner);
    for (let i = 0; i < EXTRA_PROFILES; i += 1) {
      const id = `roster-${i}`, source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
      f.service.productStore.putAgentProfile({ ...source, id, agentId: id, runtimeProfileId: id, name: id, isDefault: false });
      f.service.agentDefinitionStore.ensureProfile({ profileId: id });
    }
    const memoryDir = path.join(owner.store.workspace(f.profile.id), "memory");
    fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
    for (let i = 1; i <= MEMORY_FILES; i += 1) {
      fs.writeFileSync(path.join(memoryDir, `2026-10-${String(i).padStart(2, "0")}.md`),
        `# Day ${i}\n\n- Telescope maintenance note ${i}: lens cleaned, calibration log updated.\n`, { mode: 0o600 });
    }
    // Build history without recall so setup cost does not depend on the code under test.
    const recall = owner.activeMemory.run;
    owner.activeMemory.run = async () => null;
    for (let i = 0; i < IDLE_SESSIONS; i += 1) f.createSession();
    const measuredSessions = [];
    const historyFact = "The quartz prism registry is assigned to cabinet 42.";
    for (let s = 0; s < HISTORY_SESSIONS; s += 1) {
      const session = f.createSession();
      for (let turn = 0; turn < TURNS; turn += 1) {
        const run = await f.send(session.sessionKey, `history-${s}-${turn}`,
          `Session ${s} turn ${turn}: the amber telescope calibration log for cabinet ${s * TURNS + turn}.`);
        assert.equal(run.status, "running", run.errorCode);
        await f.complete(run, s === 7 && turn === 0 ? historyFact
          : `Noted: telescope calibration for cabinet ${s * TURNS + turn} is recorded.`);
      }
      if (s >= HISTORY_SESSIONS - 2) measuredSessions.push(session);
    }
    owner.activeMemory.run = recall;

    const counts = { scans: 0, walks: 0 };
    const recallService = owner.conversationRecall, scan = recallService.scanEligibleSession.bind(recallService);
    recallService.scanEligibleSession = (...args) => { counts.scans += 1; return scan(...args); };
    const walk = owner.store._files.bind(owner.store);
    owner.store._files = (...args) => { counts.walks += 1; return walk(...args); };

    async function measure(session, operationId, question, model) {
      counts.scans = 0;
      counts.walks = 0;
      const modelPrompts = [], debug = [];
      owner.complete = async ({ prompt }) => {
        modelPrompts.push(prompt);
        return model(modelPrompts.length);
      };
      const originalLogger = owner.logger;
      owner.logger = { ...originalLogger, debug: message => debug.push(message) };
      const monitor = loopBlockMonitor();
      const started = performance.now();
      let run, blocked;
      try { run = await f.send(session.sessionKey, operationId, question); }
      finally {
        blocked = monitor.stop();
        owner.logger = originalLogger;
      }
      console.log(`${operationId}: admission ${Math.round(performance.now() - started)}ms, longest loop block ${Math.round(blocked)}ms, `
        + `model calls ${modelPrompts.length}, transcript scans ${counts.scans}, memory-file walks ${counts.walks}`);
      assert.equal(run.status, "running", run.errorCode);
      const acquisitions = f.transport.acquisitions.filter(row => row.options.executionContract?.runId === run.id);
      assert.equal(acquisitions.length, 1, "the measured chat acquires its native Runtime once");
      assert.ok(counts.scans <= MAX_TRANSCRIPT_SCANS, `${counts.scans} transcript scans for one admission`);
      assert.ok(counts.walks <= MAX_MEMORY_FILE_WALKS, `${counts.walks} memory-file walks for one admission`);
      assert.ok(blocked < MAX_LOOP_BLOCK_MS, `Service loop blocked ${Math.round(blocked)}ms during admission`);
      const { dynamicContext } = acquisitions[0].options.executionContract;
      await f.complete(run);
      return { modelPrompts, debug, dynamicContext };
    }

    await t.test("a strong file-memory hit skips the auxiliary model and reaches the main turn", async () => {
      const result = await measure(measuredSessions[0], "measured-strong-hit",
        "Do you remember the amber telescope calibration?", () => ({ text: '{"summary":"NONE"}' }));
      assert.ok(result.debug.includes("active-memory: recall skipped reason=strong-lane-one-hit"),
        `Expected a strong daily-memory hit; Active Memory reported ${JSON.stringify(result.debug)}`);
      assert.equal(result.modelPrompts.length, 0, "the strong hit does not need the auxiliary model");
      const recalled = result.dynamicContext.match(/<active_memory_plugin>([\s\S]*?)<\/active_memory_plugin>/u)?.[1] || "";
      assert.match(recalled, /Telescope maintenance note \d+: lens cleaned, calibration log updated\. \(Source: memory\//u);
    });

    await t.test("an explicit recall without a strong file hit executes model and transcript retrieval", async () => {
      const result = await measure(measuredSessions[1], "measured-model-recall",
        "Which cabinet did we discuss last time?", step => ({ text: step === 1
          ? JSON.stringify({ tool: "memory_search", arguments: { query: "quartz prism registry" } })
          : JSON.stringify({ summary: historyFact }) }));
      assert.equal(result.modelPrompts.length, 2, "the auxiliary model requests a second search then receives its result");
      assert.ok(result.modelPrompts[1].includes(historyFact), "real cross-session transcript evidence reached the auxiliary model");
      assert.ok(result.dynamicContext.includes(`<active_memory_plugin>\n${historyFact}\n</active_memory_plugin>`),
        "the recall summary reached the main turn");
    });
  } finally { await f.close(); }
});
