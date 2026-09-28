"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");

const FIXTURE = require("./fixtures/shoggoth-memory-evaluation-v1.json");
const RECALL_SERVICE_PATH = path.resolve(__dirname, "../app/agent-service/conversation-recall-service.js");

function validateFixture() {
  assert.equal(FIXTURE.version, 1);
  const memoryIds = new Set(FIXTURE.memoryItems.map((item) => item.id));
  assert.equal(memoryIds.size, FIXTURE.memoryItems.length);
  const eventIds = new Set(FIXTURE.conversation.sessions.flatMap((session) => (
    session.events.map((event) => event.id)
  )));
  assert.equal(eventIds.size, FIXTURE.conversation.sessions.reduce((sum, session) => sum + session.events.length, 0));
  const queryIds = new Set();
  for (const group of ["A", "B"]) {
    assert.ok(FIXTURE.memoryQueries[group].length > 0);
    for (const query of FIXTURE.memoryQueries[group]) {
      assert.equal(queryIds.has(query.id), false, `duplicate query ${query.id}`);
      queryIds.add(query.id);
      assert.ok(query.relevant.length > 0);
      for (const id of query.relevant) assert.ok(memoryIds.has(id), `${query.id}: unknown ${id}`);
    }
  }
  for (const query of FIXTURE.conversation.queries) {
    assert.equal(queryIds.has(query.id), false, `duplicate query ${query.id}`);
    queryIds.add(query.id);
    assert.ok(typeof query.query === "string" && query.query.length > 0);
    for (const id of [...query.relevant, ...(query.forbidden || [])]) {
      assert.ok(eventIds.has(id), `${query.id}: unknown ${id}`);
    }
  }
}

function round(value) { return Number(value.toFixed(4)); }

function scoreQueries(rows) {
  const positive = rows.filter((row) => row.relevant.length > 0);
  const hits = positive.reduce((sum, row) => sum + row.hits.length, 0);
  const possible = positive.reduce((sum, row) => sum + row.relevant.length, 0);
  const precisionSum = positive.reduce((sum, row) => sum + row.hits.length / 5, 0);
  const precisionReturnedSum = positive.reduce((sum, row) => sum
    + (row.found.length ? row.hits.length / row.found.length : 0), 0);
  return {
    queries: rows.length,
    positiveQueries: positive.length,
    recallAt5: possible === 0 ? null : round(hits / possible),
    precisionAt5: positive.length === 0 ? null : round(precisionSum / positive.length),
    precisionOfReturned: positive.length === 0 ? null : round(precisionReturnedSum / positive.length),
    forbiddenHits: rows.reduce((sum, row) => sum + row.forbiddenHits.length, 0),
    rows,
  };
}

function evaluateMemory() {
  const fixture = memoryFixture({ now: 1_000 });
  try {
    for (const item of FIXTURE.memoryItems) fixture.engine.propose({
      id: item.id,
      profileId: "profile-1",
      scope: "user",
      type: "semantic",
      content: item.content,
      sourceRefs: [`synthetic-${item.id}`],
      classification: "explicit",
    });
    const result = {};
    for (const group of ["A", "B"]) {
      const rows = FIXTURE.memoryQueries[group].map((sample) => {
        const ids = fixture.engine.search({
          profileId: "profile-1", query: sample.query, scopes: ["user"],
          maxSensitivity: "normal", limit: 5, maxBytes: 16 * 1024, now: 10_000,
        }).items.map((item) => item.id);
        return {
          id: sample.id, probe: sample.probe, relevant: sample.relevant, found: ids,
          hits: sample.relevant.filter((id) => ids.includes(id)), forbiddenHits: [],
        };
      });
      result[group] = scoreQueries(rows);
    }
    return result;
  } finally { fixture.cleanup(); }
}

// P1b supplies ConversationRecallService. This explicit unavailable state makes
// the pre-P1 transcript baseline truthful instead of scoring an invented search.
async function evaluateConversation() {
  if (!fs.existsSync(RECALL_SERVICE_PATH)) return {
    status: "unavailable", reason: "conversation_search is absent in the baseline checkout",
    positiveQueries: FIXTURE.conversation.queries.filter((query) => query.relevant.length > 0).length,
    negativeQueries: FIXTURE.conversation.queries.filter((query) => query.relevant.length === 0).length,
  };
  const { ConversationRecallService } = require(RECALL_SERVICE_PATH);
  const fixture = contextFixture({ now: () => 20_000 });
  let service;
  try {
    const sessions = FIXTURE.conversation.sessions.map((sample) => ({
      id: sample.id, sessionKey: sample.sessionKey, profileId: sample.profileId,
      workspace: sample.workspace, status: sample.status,
    }));
    const byKey = new Map(sessions.map((session) => [session.sessionKey, session]));
    const runs = new Map();
    const sessionKeyByRun = new Map();
    const events = new Map();
    let occurredAt = 10_000;
    for (const sample of FIXTURE.conversation.sessions) {
      const run = {
        ...sample.run, profileId: sample.profileId, workspace: sample.workspace,
        sourceId: sample.run.sourceId || sample.sessionKey,
      };
      runs.set(run.id, run);
      sessionKeyByRun.set(run.id, sample.sessionKey);
      for (const event of sample.events) {
        fixture.transcripts.appendEvent({
          profileId: sample.profileId, sessionId: sample.id, runId: run.id,
          id: event.id, kind: event.kind, content: { text: event.text },
          runtimeRef: null, contextExcluded: event.contextExcluded === true,
          occurredAt: occurredAt++,
        });
        events.set(event.id, { ...event, sessionId: sample.id });
      }
    }
    const forgotten = fixture.memoryEngine.propose({
      id: "m-conversation-forgotten", profileId: "profile-1", scope: "user",
      type: "semantic", content: "葡萄船期是下周三。",
      sourceRefs: ["ev-forgotten", "run-forgotten"], classification: "explicit",
    });
    fixture.memoryEngine.delete({ profileId: "profile-1", id: forgotten.id, reason: "forgotten" });
    const sessionsStore = {
      listSessions: () => structuredClone(sessions),
      getSession: (key) => structuredClone(byKey.get(key) || null),
      getCronSessionOrigin: (key) => key === "22222222-2222-4222-8222-222222222222"
        ? { cronJobId: "synthetic-cron" } : null,
    };
    service = new ConversationRecallService({
      paths: fixture.paths, transcriptStore: fixture.transcripts,
      chatSessionStore: sessionsStore,
      workDispatcher: { getRun: (id) => structuredClone(runs.get(id) || null) },
      getRunSessionKey: (run) => sessionKeyByRun.get(run.id) || null,
      getInspirationOrigin: (run) => run.source === "inspiration" ? {
        runId: run.id, profileId: run.profileId, workspace: run.workspace,
        ideaId: run.sourceId, inputSource: run.inputSource,
      } : null,
      recallPolicy: fixture.memoryEngine.recallPolicy,
    });
    const caller = runs.get("run-current");
    const args = { source: "chat", sourceId: caller.sourceId };
    const warm = await service.search({ profileId: "profile-1",
      args: { ...args, query: FIXTURE.conversation.queries[0].query, limit: 5 }, run: caller });
    if (warm.status === "rebuilding") await service.whenIndexReady("profile-1");
    const rows = [];
    let identityErrors = 0;
    for (const sample of FIXTURE.conversation.queries) {
      const result = await service.search({
        profileId: "profile-1", args: { ...args, query: sample.query, limit: 5 }, run: caller,
      });
      const found = result.results.map((item) => item.eventId);
      for (const item of result.results) {
        const original = events.get(item.eventId);
        if (!original || original.sessionId !== item.sessionId
          || !original.text.includes(item.snippet.replace(/^…|…$/gu, ""))) identityErrors++;
      }
      rows.push({
        id: sample.id, probe: sample.probe, relevant: sample.relevant, found,
        hits: sample.relevant.filter((id) => found.includes(id)),
        forbiddenHits: found.filter((id) => (sample.forbidden || []).includes(id)
          || sample.relevant.length === 0),
      });
    }
    const scored = scoreQueries(rows);
    scored.status = "measured";
    scored.identityErrors = identityErrors;
    const get = await service.get({ profileId: "profile-1", args: {
      ...args, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      eventId: "ev-supplier", window: 3,
    }, run: caller });
    scored.getWindow = {
      visible: get.events.filter((event) => !event.hidden).map((event) => event.eventId),
      hidden: get.events.filter((event) => event.hidden).length,
      leakedForbiddenText: /工具秘密索引词|隐藏片段索引词/u.test(JSON.stringify(get.events)),
    };
    try {
      await service.get({ profileId: "profile-1", args: {
        ...args, sessionId: "66666666-6666-4666-8666-666666666661",
        eventId: "ev-forgotten", window: 0,
      }, run: caller });
      scored.forgottenGetDenied = false;
    } catch (error) {
      scored.forgottenGetDenied = error.code === "CONVERSATION_EVENT_NOT_FOUND";
    }
    assert.equal(scored.forbiddenHits, 0, "C corpus contains forbidden search result");
    assert.equal(scored.identityErrors, 0, "C corpus contains incorrect event identity/snippet");
    assert.equal(scored.getWindow.leakedForbiddenText, false, "conversation_get leaked hidden neighbor");
    assert.equal(scored.forgottenGetDenied, true, "conversation_get exposed forgotten source");
    return scored;
  } finally {
    try { service?.close(); } finally { fixture.cleanup(); }
  }
}

async function main() {
  validateFixture();
  const output = {
    fixtureVersion: FIXTURE.version,
    fixturePath: path.relative(process.cwd(), require.resolve("./fixtures/shoggoth-memory-evaluation-v1.json")),
    generatedAt: new Date().toISOString(),
    groupA: null,
    groupB: null,
    groupC: null,
  };
  const memory = evaluateMemory();
  output.groupA = memory.A;
  output.groupB = memory.B;
  output.groupC = await evaluateConversation();
  if (process.argv.includes("--check")) {
    assert.ok(output.groupA.recallAt5 >= 1, "A lexical recall regressed");
    assert.ok(output.groupA.precisionAt5 >= 0.2, "A lexical precision regressed");
    assert.equal(output.groupC.status, "measured", "C transcript search unavailable");
    assert.ok(output.groupC.recallAt5 >= 0.9, "C original-text Recall@5 below plan gate");
    assert.equal(output.groupC.forbiddenHits, 0);
    assert.equal(output.groupC.identityErrors, 0);
    assert.equal(output.groupC.forgottenGetDenied, true);
  }
  if (process.argv.includes("--summary")) {
    for (const group of ["groupA", "groupB", "groupC"]) {
      if (output[group]?.rows) delete output[group].rows;
    }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
