#!/usr/bin/env node
"use strict";

// Synthetic P0 cost probe. The old compiler/engine are loaded from the plan's
// pre-P1 Git ref; both versions read the same temporary MemoryStore. This is
// not a provider token bill or a full App latency benchmark.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const path = require("node:path");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { ContextCompiler } = require("../app/agent-service/context-compiler");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");
const { estimateContextTokens } = require("../app/agent-service/conversation-context-budget");
const { MemoryCandidateStore } = require("../app/agent-service/memory-candidate-store");
const { MemoryCandidateService } = require("../app/agent-service/memory-candidate-service");
const { MemoryEngine, workspaceMemoryRef } = require("../app/agent-service/memory-engine");

const ROOT = path.resolve(__dirname, "..");
const PRE_P1_REF = "d622d117";
const PROFILE_ID = "profile-1";
const NOW = 200_000;
const USER_BUDGET = 8 * 1024;
const MEMORY_BUDGET = 12 * 1024;
const EMPTY_CANDIDATES = JSON.stringify({ candidates: [] });
const CONTEXT_FIXTURE_SHA256 = "c822aeb41f193dd1df919f7f764fb61258e9220c804fa0819e9334c63e9d805c";

function loadGitModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = execFileSync("git", ["show", `${PRE_P1_REF}:${relativePath}`], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source, filename);
  return loaded.exports;
}

function memoryItems(workspace) {
  const items = [];
  const add = (id, scope, type, content, updatedAt) => items.push({
    id, profileId: PROFILE_ID, scope, type, content,
    sourceRefs: scope === "project" ? [workspaceMemoryRef(workspace)] : [`event-${id}`],
    confidence: 1, sensitivity: "normal", status: "active",
    validFrom: 0, validUntil: null, supersedes: null,
    createdAt: updatedAt, updatedAt,
  });
  add("u-stable", "user", "semantic", "用户在晨舟项目中偏好简洁中文回复。", 1_000);
  add("p-relevant", "project", "project", "晨舟项目构建编号 QK-4827 必须写进发布说明。", 1_001);
  for (let index = 0; index < 80; index++) {
    add(`u-noise-${index}`, "user", "episodic",
      `用户历史便签 ${index}：普通事项已归档，后续无需特别处理。`, 10_000 + index);
    add(`p-noise-${index}`, "project", "episodic",
      `项目历史便签 ${index}：普通构建记录已归档，供人工核对。`, 11_000 + index);
  }
  return items;
}

function memoryProjection(snapshot) {
  const userContent = snapshot.blocks.find((block) => block.id === "user")?.content || "";
  const memoryContent = snapshot.blocks.find((block) => block.id === "memory")?.content || "";
  const selected = Object.fromEntries(["user", "memory"].map((id) => {
    const content = id === "user" ? userContent : memoryContent;
    const bytes = Buffer.byteLength(content, "utf8");
    assert.ok(bytes <= (id === "user" ? USER_BUDGET : MEMORY_BUDGET),
      `${id} exceeds its original byte budget`);
    return [id, { bytes, estimatedTokens: estimateContextTokens(content),
      selectedItems: (content.match(/^\[[A-Za-z0-9._:-]+;/gmu) || []).length }];
  }));
  return { ...selected,
    totalBytes: selected.user.bytes + selected.memory.bytes,
    estimatedTokens: selected.user.estimatedTokens + selected.memory.estimatedTokens,
    stablePreferenceSelected: userContent.includes("[u-stable;"),
    relevantProjectSelected: memoryContent.includes("[p-relevant;"),
  };
}

function contextCost() {
  const f = contextFixture({ now: () => NOW,
    budgets: { user: USER_BUDGET, memory: MEMORY_BUDGET, transcript: 512 } });
  let previousEngine;
  try {
    const items = memoryItems(f.run.workspace);
    const fixtureSha256 = crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex");
    assert.equal(fixtureSha256, CONTEXT_FIXTURE_SHA256,
      "synthetic context fixture changed; update the P0 baseline before accepting new scores");
    for (let offset = 0; offset < items.length; offset += 128) {
      f.memoryStore.upsertMany(items.slice(offset, offset + 128));
    }
    f.memoryEngine.rebuildViews(PROFILE_ID);
    const PreviousMemoryEngine = loadGitModule("app/agent-service/memory-engine.js").MemoryEngine;
    const PreviousContextCompiler = loadGitModule("app/agent-service/context-compiler.js").ContextCompiler;
    previousEngine = new PreviousMemoryEngine({ store: f.memoryStore,
      definitionStore: f.definitions, now: () => NOW });
    previousEngine.open([PROFILE_ID]);
    const previousCompiler = new PreviousContextCompiler({
      definitionStore: f.definitions, memoryEngine: previousEngine,
      memoryStore: f.memoryStore, transcriptStore: f.transcripts,
      toolRegistry: f.compiler.toolRegistry, permissionEngine: f.permissions,
      snapshotStore: f.snapshots, now: () => NOW,
      budgets: { user: USER_BUDGET, memory: MEMORY_BUDGET, transcript: 512 },
    });
    assert.ok(f.compiler instanceof ContextCompiler);
    const cases = [
      { id: "relevant", query: "晨舟项目构建编号 QK-4827" },
      { id: "unrelated", query: "无关任务" },
    ].map(({ id, query }) => {
      const input = { profile: f.profile, run: f.run,
        transcriptSessionId: f.transcriptSessionId, query, preview: true };
      const previous = memoryProjection(previousCompiler.compile(input));
      const current = memoryProjection(f.compiler.compile(input));
      if (id === "relevant") {
        assert.equal(current.stablePreferenceSelected, true);
        assert.equal(current.relevantProjectSelected, true);
      }
      return { id, previous, current };
    });
    return { preP1Ref: PRE_P1_REF, syntheticItems: items.length,
      fixtureSha256,
      budgets: { userBytes: USER_BUDGET, memoryBytes: MEMORY_BUDGET }, cases };
  } finally {
    try { previousEngine?.close(); } catch {}
    f.cleanup();
  }
}

async function candidateCost() {
  let tick = NOW;
  const f = contextFixture({ now: () => tick++ });
  let recall;
  try {
    const session = { id: f.transcriptSessionId,
      sessionKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", profileId: PROFILE_ID,
      workspace: f.run.workspace, status: "ready" };
    const runs = new Map();
    for (let index = 1; index <= 17; index++) {
      const runId = `run-cost-${index}`;
      runs.set(runId, { id: runId, source: "chat", sourceId: session.sessionKey,
        profileId: PROFILE_ID, workspace: session.workspace, status: "completed" });
      f.transcripts.appendEvent({ profileId: PROFILE_ID, sessionId: session.id,
        runId, id: `event-cost-${index}`, kind: "user",
        content: { text: `我习惯在每月第 ${index} 天整理晨舟项目记录。` },
        runtimeRef: null, contextExcluded: false, occurredAt: tick++ });
    }
    const chatSessionStore = {
      listSessions: () => [structuredClone(session)],
      getSession: (key) => key === session.sessionKey ? structuredClone(session) : null,
      getCronSessionOrigin: () => null,
    };
    recall = new ConversationRecallService({ paths: f.paths,
      transcriptStore: f.transcripts, memoryStore: f.memoryStore, chatSessionStore,
      workDispatcher: { getRun: (id) => runs.get(id) || null },
      getRunSessionKey: (run) => run.sourceId,
      recallPolicy: f.memoryEngine.recallPolicy });
    const queue = new MemoryCandidateStore({ paths: f.paths, now: () => tick++ });
    const calls = [];
    const service = new MemoryCandidateService({ candidateStore: queue,
      memoryEngine: f.memoryEngine, memoryStore: f.memoryStore,
      conversationRecallService: recall, chatSessionStore,
      extractCandidates: async (input) => {
        assert.equal(input.toolFree, true);
        const call = { events: input.events.length,
          promptBytes: Buffer.byteLength(input.prompt, "utf8"),
          estimatedInputTokens: estimateContextTokens(input.prompt),
          estimatedOutputTokens: estimateContextTokens(EMPTY_CANDIDATES) };
        calls.push(call);
        return { text: EMPTY_CANDIDATES, model: "synthetic-no-provider",
          usage: { inputTokens: call.estimatedInputTokens,
            outputTokens: call.estimatedOutputTokens } };
      },
      isProfileEligible: () => true, now: () => tick++ });
    const first = await service.processSession({ profileId: PROFILE_ID, sessionId: session.id });
    const usage = queue.get(PROFILE_ID).usage;
    const repeat = await service.processSession({ profileId: PROFILE_ID, sessionId: session.id });
    assert.equal(first.modelCalls, 2, "17 events must use two bounded batches");
    assert.deepEqual(calls.map((call) => call.events), [16, 1]);
    assert.equal(usage.calls, calls.length);
    assert.equal(usage.inputTokens, calls.reduce((sum, call) => sum + call.estimatedInputTokens, 0));
    assert.equal(usage.outputTokens, calls.reduce((sum, call) => sum + call.estimatedOutputTokens, 0));
    assert.equal(repeat.modelCalls, 0, "no new evidence must not call the model");
    assert.equal(queue.get(PROFILE_ID).usage.calls, usage.calls);
    return { preP3: { modelCalls: 0, modelTokens: 0,
      reason: "pre-P1 extractTranscript was regex-only and had no background model candidate queue" },
      current: { syntheticUserEvents: 17, initialModelCalls: first.modelCalls,
        repeatWithoutNewEvidenceModelCalls: repeat.modelCalls,
        persistedUsage: { calls: usage.calls, inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens }, calls,
        dailyCallCap: service.maxModelCallsPerDay },
      accounting: "The fake extractor returns local estimateContextTokens counts as usage; these are not provider-billed tokens or a price estimate." };
  } finally {
    try { recall?.close(); } catch {}
    f.cleanup();
  }
}

async function main() {
  const context = contextCost();
  const candidate = await candidateCost();
  process.stdout.write(`${JSON.stringify({ kind: "synthetic-memory-context-and-candidate-cost",
    node: process.version, platform: process.platform, arch: process.arch,
    context, candidate }, null, 2)}\n`);
  if (process.argv.includes("--check")) {
    for (const sample of context.cases) {
      assert.equal(sample.current.stablePreferenceSelected, true,
        `${sample.id}: an active stable preference was omitted from the hot user context`);
      assert.ok(sample.current.memory.selectedItems <= 20,
        `${sample.id}: project notes exceeded the bounded project hot-candidate cap`);
    }
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
