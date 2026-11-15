"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CronReportIndex } = require("../app/agent-service/cron-report-index");
const { TranscriptStore, transcriptEventId } = require("../app/agent-service/transcript-store");

function fixture(t, { group = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-cron-report-")));
  const paths = { trustedRoot: root, agentsDir: path.join(root, "agents") };
  const transcripts = new TranscriptStore({ paths });
  transcripts.open();
  const job = { id: "job", profileId: "profile", createdAt: 0 };
  if (group) job.groupDelivery = { groupId: "group-a", ownerScope: "owner", memberId: "member" };
  const runs = new Map(), published = new Set();
  let enumerated = 0, pointReads = 0, expanded = 0;
  const products = {
    getWorkRun(id) { pointReads++; return runs.get(id); },
    *iterateWorkRuns() { for (const run of runs.values()) { enumerated++; yield run; } },
  };
  const index = new CronReportIndex({ paths, products, transcripts,
    jobs: { getJob: jobId => jobId === job.id ? job : null },
    sessionForRun: run => run.sessionId ?? null,
    hasPublished: ({ groupId, runId }) => groupId === "group-a" && published.has(runId),
  });
  const originalDisplay = transcripts.displayEvent.bind(transcripts);
  transcripts.displayEvent = (profileId, sessionId, event) => {
    if (event.kind === "assistant") expanded++;
    return originalDisplay(profileId, sessionId, event);
  };
  t.after(async () => { await index.close(); transcripts.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const run = (id, finishedAt, extra = {}) => ({
    id, source: "cron", sourceId: job.id, profileId: job.profileId, workspace: "/tmp/work",
    status: "completed", finishedAt, sessionId: "session", ...extra,
  });
  function append(runValue, text, disposition = "deliver") {
    runs.set(runValue.id, runValue);
    const add = input => transcripts.appendEvent({ profileId: runValue.profileId,
      sessionId: runValue.sessionId, runId: runValue.id, occurredAt: runValue.finishedAt, ...input });
    const answer = add({ id: transcriptEventId("test-answer", runValue.id), kind: "assistant",
      content: { text, phase: "final_answer", transcriptType: "text" } });
    const terminal = add({ id: transcriptEventId("chat-terminal", runValue.id, "completed"), kind: "status",
      content: { transcriptType: "terminal", cronOutput: { version: 1, disposition,
        reason: disposition === "silent" ? "duplicate" : null } } });
    return { answer: originalDisplay(runValue.profileId, runValue.sessionId, answer), terminal };
  }
  return { index, transcripts, job, run, append, runs, published, enumerated: () => enumerated,
    pointReads: () => pointReads, expanded: () => expanded };
}

for (const count of [100, 1000, 10000]) test(`warm comparison avoids enumerating ${count} older runs`, t => {
  const f = fixture(t);
  const initial = f.run("initial", 1);
  f.index.record(initial, f.append(initial, "First published report"));
  for (let i = 0; i < count; i++) {
    const silent = f.run(`silent-${i}`, i + 2);
    f.runs.set(silent.id, silent);
  }
  const next = f.run("next", count + 2);
  assert.equal(f.index.matches(next, "First published report"), true);
  assert.equal(f.index.matches(next, "first published report"), false);
  assert.equal(f.index.matches(next, "First published report\n"), false);
  assert.equal(f.enumerated(), 0);
  assert.equal(f.pointReads(), 1);
  assert.equal(f.expanded(), 1);
});

test("only committed group publications advance the exact-scope baseline", t => {
  const f = fixture(t, { group: true });
  const first = f.run("initial", 1);
  let commit = f.append(first, "published");
  f.index.record(first, commit);
  assert.equal(f.index.matches(f.run("next", 2), "published"), false);
  f.published.add(first.id);
  f.index.record(first, commit);
  const silent = f.run("silence", 3);
  f.published.add(silent.id);
  f.index.record(silent, f.append(silent, "published", "silent"));
  assert.equal(f.index.matches(f.run("next", 4), "published"), true);
  assert.equal(f.index.matches(f.run("next", 4, { workspace: "/tmp/other" }), "published"), false);
  f.published.delete(first.id);
  assert.equal(f.index.matches(f.run("next", 4), "published"), false);
});

test("equal-time reports use deterministic ordering and an older callback cannot replace a newer one", t => {
  const f = fixture(t);
  const newer = f.run("z-newer", 11), older = f.run("a-older", 11);
  f.index.record(newer, f.append(newer, "newer"));
  f.index.record(older, f.append(older, "older"));
  assert.equal(f.index.matches(f.run("z1-next", 11), "newer"), true);
  assert.equal(f.index.matches(f.run("b-middle", 11), "newer"), false);
  assert.equal(f.index.matches(f.run("next", 12), "older"), false);
});

test("an unreadable newer report cannot silently fall back to an older publication", t => {
  const f = fixture(t);
  const initial = f.run("first", 1);
  f.index.record(initial, f.append(initial, "published"));
  const partial = f.run("newer", 2);
  const pending = f.append(partial, "unreadable");
  const identity = f.transcripts.cachedJournalIdentity;
  f.transcripts.cachedJournalIdentity = () => null;
  f.index.record(partial, pending);
  f.transcripts.cachedJournalIdentity = identity;
  assert.equal(f.index.matches(f.run("next", 3), "published"), false);
  const replacement = f.run("replaced", 4);
  f.index.record(replacement, f.append(replacement, "verified"));
  assert.equal(f.index.matches(f.run("future", 5), "verified"), true);
});

test("worker rebuild proves cold output, preserves the latest concurrent delivery and refuses revoked text", async t => {
  const f = fixture(t);
  const oldest = f.run("historic", 1);
  const report = "原报告\n".repeat(21_000);
  f.append(oldest, report);
  for (let i = 0; i < 200; i++) {
    const run = f.run(`unrelated-${i}`, i + 2, { source: "chat" });
    f.runs.set(run.id, run);
  }
  f.transcripts.close();
  f.transcripts.open();
  let tick = false;
  setImmediate(() => { tick = true; });
  const rebuilding = f.index.rebuild();
  const next = f.run("next", 220);
  assert.equal(f.index.matches(next, report), false);
  await rebuilding;
  assert.equal(tick, true);
  assert.equal(f.transcripts.sessions.size, 0, "the Service never replays the cold journal");
  assert.equal(f.index.matches(next, report), true);
  assert.equal(f.index.matches(next, report.slice(0, -1) + " "), false);
  const visible = f.transcripts.runEventsView(oldest.profileId, oldest.sessionId, oldest.id).find(event => event.kind === "assistant");
  f.transcripts.setContextExcluded({ profileId: oldest.profileId, sessionId: oldest.sessionId, eventId: visible.id, contextExcluded: true });
  assert.equal(f.index.matches(next, report), false);

  const concurrent = f.run("concurrent", 221);
  const secondRebuild = f.index.rebuild();
  f.index.record(concurrent, f.append(concurrent, "concurrent report"));
  await secondRebuild;
  assert.equal(f.index.matches(f.run("future", 222), "concurrent report"), true);
});
