"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");

function arg(name, fallback) {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!match) return fallback;
  const number = Number(match.slice(name.length + 3));
  assert.ok(Number.isSafeInteger(number) && number > 0);
  return number;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.ceil(ordered.length * fraction) - 1].toFixed(3));
}

async function main() {
  const messageCount = arg("messages", 100_000);
  const iterations = arg("iterations", 12);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-conversation-bench-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"),
  });
  const current = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    sessionKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    profileId: "profile-1", workspace: "/synthetic/project-a", status: "ready",
  };
  const history = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    sessionKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    profileId: "profile-1", workspace: "/synthetic/project-a", status: "ready",
  };
  const caller = { id: "run-current", profileId: "profile-1", source: "chat",
    sourceId: current.sessionKey, workspace: current.workspace, status: "running" };
  const priorRun = { id: "run-history", profileId: "profile-1", source: "chat",
    sourceId: history.sessionKey, workspace: history.workspace, status: "completed" };
  const currentEvents = [{ id: "ev-current", sessionId: current.id, runId: caller.id,
    seq: 1, kind: "user", content: { text: "请查找旧会话。" },
    runtimeRef: null, contextExcluded: false, occurredAt: 1 }];
  const historyEvents = Array.from({ length: messageCount }, (_, index) => ({
    id: `ev-${index}`, sessionId: history.id, runId: priorRun.id,
    seq: index + 1, kind: "user",
    content: { text: index === 4827
      ? "晨舟项目构建号 QK-4827，验收时间定在周四。"
      : `合成会话消息 ${index}，流程标签 FX-${index}，状态是待检查。` },
    runtimeRef: null, contextExcluded: false, occurredAt: index + 2,
  }));
  const bySession = new Map([[current.id, currentEvents], [history.id, historyEvents]]);
  const userRunIds = new Map([...bySession].map(([sessionId, events]) => [sessionId,
    new Set(events.filter((event) => event.kind === "user" && !event.contextExcluded
      && typeof event.content?.text === "string").map((event) => event.runId))]));
  const eventBySession = new Map([...bySession].map(([sessionId, events]) => [
    sessionId, new Map(events.map((event) => [event.id, event])),
  ]));
  const byKey = new Map([[current.sessionKey, current], [history.sessionKey, history]]);
  const byRun = new Map([[caller.id, caller], [priorRun.id, priorRun]]);
  let listEventsCalls = 0;
  let listEventsPageCalls = 0;
  let clonedEvents = 0;
  let getEventCalls = 0;
  let userProbeCalls = 0;
  const transcripts = {
    listEvents(profileId, sessionId, options = {}) {
      assert.equal(profileId, "profile-1");
      listEventsCalls++;
      const original = bySession.get(sessionId) || [];
      const filtered = original.filter((event) => (options.afterSeq === undefined || event.seq > options.afterSeq)
        && (options.throughSeq === undefined || event.seq <= options.throughSeq));
      clonedEvents += filtered.length;
      return filtered.map((event) => structuredClone(event));
    },
    listEventsPage(profileId, sessionId, afterSeq = 0, limit = 256) {
      assert.equal(profileId, "profile-1");
      listEventsPageCalls++;
      const original = bySession.get(sessionId) || [];
      const page = original.slice(afterSeq, afterSeq + limit);
      clonedEvents += page.length;
      return page.map((event) => structuredClone(event));
    },
    getLastEventSeq(profileId, sessionId) {
      assert.equal(profileId, "profile-1");
      return bySession.get(sessionId)?.at(-1)?.seq ?? 0;
    },
    getEvent(profileId, sessionId, eventId) {
      assert.equal(profileId, "profile-1");
      getEventCalls++;
      return structuredClone(eventBySession.get(sessionId)?.get(eventId) || null);
    },
    hasUserEventForRun(profileId, sessionId, runId) {
      assert.equal(profileId, "profile-1");
      userProbeCalls++;
      return userRunIds.get(sessionId)?.has(runId) === true;
    },
    listEventWindow(profileId, sessionId, eventId, radius = 0) {
      assert.equal(profileId, "profile-1");
      const event = eventBySession.get(sessionId)?.get(eventId);
      if (!event) return null;
      const events = bySession.get(sessionId);
      return events.slice(Math.max(0, event.seq - 1 - radius), event.seq + radius)
        .map((item) => structuredClone(item));
    },
    getRevision: () => 1,
    contextEvent: (_profileId, _sessionId, event) => event,
  };
  const sessions = {
    listSessions: () => [structuredClone(current), structuredClone(history)],
    getSession: (key) => structuredClone(byKey.get(key) || null),
    getCronSessionOrigin: () => null,
  };
  const policy = { assertReady() {}, isEventVisible: () => true, getRevision: () => 1 };
  const service = new ConversationRecallService({ paths, transcriptStore: transcripts,
    chatSessionStore: sessions, workDispatcher: { getRun: (id) => byRun.get(id) || null },
    getRunSessionKey: (run) => run.sourceId, recallPolicy: policy });
  const search = (query) => service.search({ profileId: "profile-1", args: {
    source: "chat", sourceId: current.sessionKey, query, limit: 5,
  }, run: caller });
  try {
    const coldStart = performance.now();
    const cold = search("晨舟");
    const coldReturnMs = Number((performance.now() - coldStart).toFixed(3));
    assert.equal(cold.status, "rebuilding");
    await service.whenIndexReady("profile-1");
    const coldBuildMs = Number((performance.now() - coldStart).toFixed(3));
    assert.equal(search("晨舟").results[0]?.eventId, "ev-4827");
    const indexPath = path.join(paths.agentsDir, "profile-1", "conversation-recall.sqlite");
    const indexMiB = Number((fs.statSync(indexPath).size / 1_048_576).toFixed(3));
    const queries = {};
    for (const query of ["晨舟", "QK-4827"]) {
      search(query);
      const times = [];
      for (let i = 0; i < iterations; i++) {
        const started = performance.now();
        const result = search(query);
        assert.equal(result.results[0]?.eventId, "ev-4827");
        times.push(performance.now() - started);
      }
      queries[query] = { p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95),
        maxMs: percentile(times, 1) };
    }
    process.stdout.write(`${JSON.stringify({
      kind: "conversation-recall-service-hot-path", node: process.version,
      platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model || "unknown",
      messages: messageCount, sessions: 2, iterations, coldReturnMs, coldBuildMs,
      indexMiB, queries, listEventsCalls, listEventsPageCalls, clonedEvents, getEventCalls, userProbeCalls,
      note: "Synthetic in-memory TranscriptStore mirrors targeted/page read APIs; SQLite index is real. Cold search returns rebuilding immediately. Excludes journal I/O and full App packaging.",
    }, null, 2)}\n`);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
