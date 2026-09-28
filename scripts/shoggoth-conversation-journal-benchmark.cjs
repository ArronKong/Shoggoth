"use strict";

// Isolated, synthetic fixture for the real TranscriptStore journal and FTS5
// index. The bulk writer uses TranscriptStore's v1 record format, then closes
// and reopens the Store so every record and the stale manifest are verified by
// production replay before any query can use the data.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { MemoryStore } = require("../app/agent-service/memory-store");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");

const PROFILE_ID = "profile-1";
const MAX_FIXTURE_BYTES = 300 * 1024 * 1024;
const MIN_FREE_BYTES = 700 * 1024 * 1024;
const MIN_REMAINING_BYTES = 300 * 1024 * 1024;

function integerArg(name, fallback, max) {
  const raw = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.slice(name.length + 3));
  assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= max,
    `--${name} must be an integer from 1 to ${max}`);
  return value;
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

function checksum(record) {
  return crypto.createHash("sha256").update(stableJson(record)).digest("hex");
}

function recordLine(payload, seq) {
  const record = { schemaVersion: 1, seq, type: "event.append", payload };
  return `${stableJson({ ...record, checksum: checksum(record) })}\n`;
}

function syntheticEvent(sessionId, runId, index, targetIndex, seq = index + 1) {
  return {
    id: `ev-${index}`, sessionId, runId, seq, kind: "user",
    content: { text: index === targetIndex
      ? "晨舟项目构建号 QK-4827，验收时间定在周四。"
      : `合成会话消息 ${index}，流程标签 FX-${index}，状态是待检查。` },
    runtimeRef: null, contextExcluded: false, occurredAt: index + 2,
  };
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    assert.ok(written > 0, "fixture journal write made no progress");
    offset += written;
  }
}

function ownedBytes(root) {
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) {
        try { bytes += fs.statSync(target).size; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      else throw new Error("fixture contains an unexpected file type");
    }
  }
  return bytes;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.ceil(ordered.length * fraction) - 1].toFixed(3));
}

function measured(value) { return Number(value.toFixed(3)); }
function mib(value) { return measured(value / 1_048_576); }

async function main() {
  const messages = integerArg("messages", 100_000, 100_000);
  const memories = integerArg("memories", 10_000, 10_000);
  const iterations = integerArg("iterations", 30, 100);
  const sessions = integerArg("sessions", 2, 201);
  const runsPerSession = integerArg("runs-per-session", 1, 50);
  const check = process.argv.includes("--check");
  if (check) assert.equal(messages, 100_000, "--check requires 100000 messages");
  if (check) assert.equal(memories, 10_000, "--check requires 10000 memories");
  if (check) assert.ok(iterations >= 30, "--check requires at least 30 iterations");
  const historicalSessions = sessions - 1;
  assert.ok(messages >= historicalSessions * runsPerSession,
    "each historical Run needs at least one user event");
  const disk = fs.statfsSync(os.tmpdir());
  const availableBytes = disk.bavail * disk.bsize;
  assert.ok(availableBytes >= MIN_FREE_BYTES,
    `temporary volume needs at least ${mib(MIN_FREE_BYTES)} MiB free`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-journal-bench-"));
  fs.chmodSync(root, 0o700);
  let transcripts;
  let memoryStore;
  let service;
  let monitor;
  let diskFailure;
  let peakBytes = 0;
  try {
    const paths = resolveServicePaths({ trustedRoot: root,
      stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"),
      cacheRoot: path.join(root, "cache") });
    const current = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      sessionKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", profileId: PROFILE_ID,
      workspace: "/synthetic/project-a", status: "ready" };
    const histories = Array.from({ length: historicalSessions }, (_, index) => ({
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index * 2 + 1).padStart(12, "0")}`,
      sessionKey: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index * 2 + 2).padStart(12, "0")}`,
      profileId: PROFILE_ID, workspace: current.workspace, status: "ready",
      start: Math.floor(index * messages / historicalSessions),
      end: Math.floor((index + 1) * messages / historicalSessions),
    }));
    const caller = { id: "run-current", profileId: PROFILE_ID, source: "chat",
      sourceId: current.sessionKey, workspace: current.workspace, status: "running" };
    const historyRunId = (history, index) => `run-history-${histories.indexOf(history)}-`
      + Math.floor((index - history.start) * runsPerSession / (history.end - history.start));
    const historyForIndex = (index) => histories.find((history) => index >= history.start && index < history.end);
    const byRun = new Map([[caller.id, caller]]);
    for (const history of histories) {
      for (let runIndex = 0; runIndex < runsPerSession; runIndex++) {
        const runId = `run-history-${histories.indexOf(history)}-${runIndex}`;
        byRun.set(runId, { id: runId, profileId: PROFILE_ID, source: "chat",
          sourceId: history.sessionKey, workspace: history.workspace, status: "completed" });
      }
    }
    const targetIndex = Math.min(4827, messages - 1);
    transcripts = new TranscriptStore({ paths, assertSecretSafe: () => true });
    transcripts.open();
    transcripts.appendEvent({ profileId: PROFILE_ID, sessionId: current.id,
      id: "ev-current", runId: caller.id, kind: "user",
      content: { text: "请查找旧会话。" }, occurredAt: 1 });
    for (const history of histories) {
      const seed = syntheticEvent(history.id, historyRunId(history, history.start),
        history.start, targetIndex, 1);
      transcripts.appendEvent({ profileId: PROFILE_ID, sessionId: history.id,
        id: seed.id, runId: seed.runId, kind: seed.kind,
        content: seed.content, occurredAt: seed.occurredAt });
      const journal = path.join(paths.agentsDir, PROFILE_ID, "transcripts", history.id,
        "events.jsonl");
      const firstRecord = JSON.parse(fs.readFileSync(journal, "utf8").trim());
      const { checksum: seedChecksum, ...unsignedSeed } = firstRecord;
      assert.equal(checksum(unsignedSeed), seedChecksum,
        "fixture checksum must match the production seed record");
      assert.equal(firstRecord.payload.id, seed.id);
    }
    transcripts.close();

    // One fsync per bounded batch avoids 100000 manifest replacements while
    // preserving the exact checksum-protected journals consumed by the Store.
    let journalBytes = 0;
    for (const history of histories) {
      const journal = path.join(paths.agentsDir, PROFILE_ID, "transcripts", history.id,
        "events.jsonl");
      const fd = fs.openSync(journal, fs.constants.O_WRONLY | fs.constants.O_APPEND);
      try {
        for (let first = history.start + 1; first < history.end; first += 1024) {
          const lines = [];
          for (let index = first; index < Math.min(history.end, first + 1024); index++) {
            lines.push(recordLine(syntheticEvent(history.id, historyRunId(history, index),
              index, targetIndex, index - history.start + 1), index - history.start + 1));
          }
          writeAll(fd, Buffer.from(lines.join(""), "utf8"));
          fs.fsyncSync(fd);
          if (fs.fstatSync(fd).size > MAX_FIXTURE_BYTES / 2) {
            throw new Error("journal fixture exceeded its 150 MiB stop limit");
          }
          const remaining = fs.statfsSync(root);
          if (remaining.bavail * remaining.bsize < MIN_REMAINING_BYTES) {
            throw new Error("temporary volume dropped below 300 MiB free during fixture generation");
          }
        }
      } finally { fs.closeSync(fd); }
      journalBytes += fs.statSync(journal).size;
    }
    peakBytes = ownedBytes(root);
    assert.ok(peakBytes < MAX_FIXTURE_BYTES, "fixture exceeds 300 MiB before indexing");

    // The manifest still describes only the seed. Real replay validates all
    // 100000 records and atomically advances that manifest.
    const replayStarted = performance.now();
    transcripts.open();
    for (const history of histories) {
      const manifest = transcripts.ensureSession({ profileId: PROFILE_ID,
        sessionId: history.id });
      assert.equal(manifest.eventCount, history.end - history.start);
      assert.equal(transcripts.getLastEventSeq(PROFILE_ID, history.id), history.end - history.start);
    }
    const replayMs = measured(performance.now() - replayStarted);
    const targetHistory = historyForIndex(targetIndex);
    assert.equal(transcripts.getEvent(PROFILE_ID, targetHistory.id,
      `ev-${targetIndex}`).content.text, "晨舟项目构建号 QK-4827，验收时间定在周四。");

    const byKey = new Map([[current.sessionKey, current],
      ...histories.map((history) => [history.sessionKey, history])]);
    memoryStore = new MemoryStore({ paths });
    memoryStore.open();
    for (let first = 0; first < memories; first += 128) {
      const items = [];
      for (let index = first; index < Math.min(memories, first + 128); index++) {
        items.push({ id: `memory-${index}`, profileId: PROFILE_ID,
          scope: index % 2 ? "project" : "user", type: "semantic",
          content: `合成记忆条目 ${index}，仅用于检索性能基准。`,
          sourceRefs: [`ev-${index % messages}`,
            historyRunId(historyForIndex(index % messages), index % messages)], confidence: 1,
          sensitivity: "normal", status: index % 10 < 6 ? "active"
            : index % 10 < 8 ? "superseded" : "deleted",
          validFrom: index + 2, validUntil: null, supersedes: null,
          createdAt: index + 2, updatedAt: index + 2 });
      }
      memoryStore.upsertMany(items);
      peakBytes = Math.max(peakBytes, ownedBytes(root));
      assert.ok(peakBytes <= MAX_FIXTURE_BYTES,
        "fixture exceeded 300 MiB during memory-store generation");
      const free = fs.statfsSync(root);
      assert.ok(free.bavail * free.bsize >= MIN_REMAINING_BYTES,
        "temporary volume dropped below 300 MiB free during memory-store generation");
    }
    memoryStore.close();
    memoryStore.open();
    const recoveredMemories = memoryStore.list(PROFILE_ID);
    assert.equal(recoveredMemories.length, memories,
      "MemoryStore replay must recover every memory item");
    for (const item of recoveredMemories) {
      const index = Number(item.id.slice("memory-".length));
      assert.equal(item.status, index % 10 < 6 ? "active"
        : index % 10 < 8 ? "superseded" : "deleted",
      "MemoryStore replay must preserve active and historical statuses");
    }
    const memoryDir = path.join(paths.agentsDir, PROFILE_ID, "memory");
    const memoryJournalBytes = fs.statSync(path.join(memoryDir, "events.jsonl")).size;
    const memorySnapshotBytes = fs.statSync(path.join(memoryDir, "snapshot.json")).size;
    let memoryLists = 0;
    service = new ConversationRecallService({ paths, transcriptStore: transcripts,
      chatSessionStore: {
        listSessions: () => [structuredClone(current),
          ...histories.map((history) => structuredClone(history))],
        getSession: (key) => structuredClone(byKey.get(key) || null),
        getCronSessionOrigin: () => null,
      },
      workDispatcher: { getRun: (id) => byRun.get(id) || null },
      getRunSessionKey: (run) => run.sourceId,
      recallPolicy: { assertReady() {}, isEventVisible: () => true,
        getRevision: () => 1, getMemoryReason: () => "expired" },
      memoryStore: { getRevision: (profileId) => memoryStore.getRevision(profileId),
        list: (profileId) => { memoryLists++; return memoryStore.list(profileId); } },
    });
    const search = (query) => service.search({ profileId: PROFILE_ID,
      args: { source: "chat", sourceId: current.sessionKey, query, limit: 5 },
      run: caller });
    monitor = setInterval(() => {
      try {
        peakBytes = Math.max(peakBytes, ownedBytes(root));
        const free = fs.statfsSync(root);
        const lowSpace = free.bavail * free.bsize < MIN_REMAINING_BYTES;
        if ((peakBytes > MAX_FIXTURE_BYTES || lowSpace) && !diskFailure) {
          diskFailure = new Error(lowSpace
            ? "temporary volume dropped below 300 MiB free during indexing"
            : "fixture exceeded its 300 MiB stop limit");
          service.close();
        }
      } catch (error) {
        if (!diskFailure) { diskFailure = error; service.close(); }
      }
    }, 100);
    monitor.unref?.();
    const coldStarted = performance.now();
    assert.equal(search("晨舟").status, "rebuilding");
    const coldReturnMs = measured(performance.now() - coldStarted);
    await service.whenIndexReady(PROFILE_ID);
    const indexBuildMs = measured(performance.now() - coldStarted);
    if (diskFailure) throw diskFailure;
    clearInterval(monitor); monitor = null;
    peakBytes = Math.max(peakBytes, ownedBytes(root));
    assert.ok(peakBytes <= MAX_FIXTURE_BYTES, "fixture exceeded 300 MiB");
    const indexFile = path.join(paths.agentsDir, PROFILE_ID,
      "conversation-recall.sqlite");
    const indexBytes = fs.statSync(indexFile).size;

    const firstReadyStarted = performance.now();
    assert.equal(search("晨舟").results[0]?.eventId, `ev-${targetIndex}`);
    const firstReadyMs = measured(performance.now() - firstReadyStarted);
    const queries = {};
    for (const query of ["晨舟", "QK-4827"]) {
      search(query);
      const times = [];
      for (let index = 0; index < iterations; index++) {
        const started = performance.now();
        const result = search(query);
        assert.equal(result.status, "ready");
        assert.equal(result.results[0]?.eventId, `ev-${targetIndex}`);
        times.push(performance.now() - started);
      }
      queries[query] = { p50Ms: percentile(times, 0.5),
        p95Ms: percentile(times, 0.95), maxMs: percentile(times, 1) };
    }
    assert.equal(memoryLists, 1,
      "memory-status view should be reused across hot searches");
    if (check) for (const result of Object.values(queries)) {
      assert.ok(result.p95Ms < 200, `hot conversation_search p95 ${result.p95Ms} ms exceeds 200 ms`);
    }
    process.stdout.write(`${JSON.stringify({
      kind: "conversation-recall-real-journal-hot-path",
      node: process.version, platform: process.platform, arch: process.arch,
      cpu: os.cpus()[0]?.model || "unknown", messages, memories,
      sessions, historicalSessions, historicalRuns: historicalSessions * runsPerSession,
      eventsPerHistoricalSession: {
        min: Math.min(...histories.map((history) => history.end - history.start)),
        max: Math.max(...histories.map((history) => history.end - history.start)),
      }, iterations, availableAtStartMiB: mib(availableBytes),
      journalMiB: mib(journalBytes), memoryJournalMiB: mib(memoryJournalBytes),
      memorySnapshotMiB: mib(memorySnapshotBytes), indexMiB: mib(indexBytes),
      peakOwnedMiB: mib(peakBytes), replayMs, coldReturnMs,
      indexBuildMs, firstReadyMs, queries, memoryLists,
      note: `Synthetic v1 journals are checksum-verified by real TranscriptStore replay; ${memories} current and historical memory items are written and replayed by real MemoryStore (a test policy treats deleted items as expired). The real SQLite FTS5 index and ConversationRecallService search run in-process. Historical messages are distributed across the reported sessions and Runs; hot p95 includes cached authoritative event revalidation and excludes replay/build, full App, installed Runtime, and user data.`,
    }, null, 2)}\n`);
  } finally {
    if (monitor) clearInterval(monitor);
    service?.close();
    transcripts?.close();
    memoryStore?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
