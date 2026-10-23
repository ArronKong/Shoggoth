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

test("direct chat admission with Active Memory never blocks the Service loop for long", { timeout: 300_000 }, async () => {
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
    let measured;
    for (let s = 0; s < HISTORY_SESSIONS; s += 1) {
      const session = f.createSession();
      for (let turn = 0; turn < TURNS; turn += 1) {
        const run = await f.send(session.sessionKey, `history-${s}-${turn}`,
          `Session ${s} turn ${turn}: the amber telescope calibration log for cabinet ${s * TURNS + turn}.`);
        assert.equal(run.status, "running", run.errorCode);
        await f.complete(run, `Noted: telescope calibration for cabinet ${s * TURNS + turn} is recorded.`);
      }
      measured = session;
    }
    owner.activeMemory.run = recall;

    let modelCalls = 0;
    owner.complete = async () => {
      modelCalls += 1;
      return { text: modelCalls === 1
        ? JSON.stringify({ tool: "memory_search", arguments: { query: "amber telescope calibration" } })
        : JSON.stringify({ summary: "The amber telescope calibration log is kept per cabinet." }) };
    };
    const counts = { scans: 0, walks: 0 };
    const recallService = owner.conversationRecall, scan = recallService.scanEligibleSession.bind(recallService);
    recallService.scanEligibleSession = (...args) => { counts.scans += 1; return scan(...args); };
    const walk = owner.store._files.bind(owner.store);
    owner.store._files = (...args) => { counts.walks += 1; return walk(...args); };
    const monitor = loopBlockMonitor();
    const started = performance.now();
    const run = await f.send(measured.sessionKey, "measured-recall", "Do you remember the amber telescope calibration?");
    const elapsed = performance.now() - started, blocked = monitor.stop();
    console.log(`admission ${Math.round(elapsed)}ms, longest loop block ${Math.round(blocked)}ms, model calls ${modelCalls}, `
      + `transcript scans ${counts.scans}, memory-file walks ${counts.walks}`);
    assert.equal(run.status, "running", run.errorCode);
    assert.ok(modelCalls > 0, "the real pre-admission Active Memory path ran");
    assert.ok(counts.scans <= MAX_TRANSCRIPT_SCANS, `${counts.scans} transcript scans for one admission`);
    assert.ok(counts.walks <= MAX_MEMORY_FILE_WALKS, `${counts.walks} memory-file walks for one admission`);
    assert.ok(blocked < MAX_LOOP_BLOCK_MS, `Service loop blocked ${Math.round(blocked)}ms during admission`);
  } finally { await f.close(); }
});
