"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { HermesBackend } = require("../app/core/hermes-backend");
const { transcriptHistoryItem } = require("../app/agent-service/chat-service-controller");

test("external Hermes reads refresh without replacing pending local transcripts", async () => {
  const backend = new HermesBackend({});
  const key = "agent:hermes-owl:cron_fixture";
  backend.profileById.set("hermes-owl", "owl");
  const prompt = { id: "prompt", role: "user", content: [{ type: "text", text: "cron prompt" }] };
  let rows = [prompt], reads = 0;
  backend._fetchHistoricalMessages = async () => { reads++; return rows.slice(); };
  backend.transcripts.set(key, [prompt]);
  assert.equal((await backend.getHistory(key)).messages.length, 1);
  rows = [prompt, { id: "final", role: "assistant", content: [{ type: "text", text: "completed report" }] }];
  assert.equal((await backend.getHistory(key)).messages.at(-1).id, "final", "cached prompt must not outlive the completed task");
  const local = [prompt, { role: "user", content: [{ type: "text", text: "new local send" }] }];
  backend.transcripts.set(key, local); backend.sendQueues.set(key, Promise.resolve());
  assert.equal((await backend.getHistory(key)).messages, local);
  assert.equal(reads, 2, "pending local sends retain their current transcript");
  backend.sendQueues.clear();
  backend._fetchHistoricalMessages = async () => { throw Error("fixture unavailable"); };
  await assert.rejects(backend.getHistory(key), /fixture unavailable/, "failure must not silently return a stale report");
});

test("Hermes history identifies producer continuations and preserves exact contents", () => {
  const backend = new HermesBackend({});
  const raw = [
    { id: 1, role: "user", content: "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: report] task", timestamp: 1000 },
    { id: 2, role: "assistant", content: "first half", timestamp: 1001 },
    { id: 3, role: "user", content: "[System: The previous response was cut off by a network error mid-stream — a transport interruption. Continue the task.]", timestamp: 1200 },
    { id: 4, role: "assistant", content: "second half", timestamp: 1500 },
    { id: 5, role: "user", content: "Explain this report", timestamp: 1501 },
  ];
  const before = JSON.stringify(raw), mapped = backend._mapHistoricalMessages(raw);
  assert(mapped.every(row => row.historySource === "hermes"));
  assert.equal(mapped[0].automation, "cron"); assert.equal(mapped[2].automation, "continuation");
  assert.equal(mapped[4].automation, undefined);
  assert.deepEqual(mapped.map(row => row.content[0].text), raw.map(row => row.content));
  assert.equal(JSON.stringify(raw), before, "projection cannot rewrite producer history");
});

test("native Cron inputs use WorkRun source, while human follow-ups remain chat", () => {
  const event = { id: "input", seq: 1, runId: "run", kind: "user", occurredAt: 1000, contextExcluded: false, content: { text: "same words" } };
  const cron = transcriptHistoryItem(event, "cron").payload.message;
  const chat = transcriptHistoryItem(event, "chat").payload.message;
  assert.equal(cron.shoggoth.source, "cron"); assert.equal(chat.shoggoth.source, "chat");
  assert.deepEqual(cron.content, chat.content, "same text is distinguished by its producer, never by task wording");
  assert.equal(event.content.cronOutputVersion, undefined, "legacy Cron events also retain source attribution");
});
