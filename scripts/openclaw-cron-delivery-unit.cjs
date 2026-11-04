"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

const jobId = "openclaw:daily-report";
const report = "# Daily report\n\n" + "完整报告内容。".repeat(400) + "\n\nReport ending";
const run = {
  runId: "execution-a", startedAt: 1793756400091, status: "ok",
  sessionKey: "agent:product:cron:daily-report:run:session-a",
  summary: report.slice(0, 2000) + "…",
};
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }] });

function fixture({ remote = false, entry = run } = {}) {
  const backend = new OpenClawBackend({
    getUpstreamUrl: () => remote ? "wss://gateway.example.test" : "ws://127.0.0.1:18792",
  });
  const calls = [];
  backend.getCronRuns = async () => ({ runs: [entry] });
  backend._readCronTranscriptText = () => "";
  backend.request = async (method, params) => {
    calls.push({ method, params });
    return { messages: [assistant(report)] };
  };
  return { backend, calls };
}

test("SQLite-backed cron delivery reads the exact run, beyond the capped summary", async () => {
  const { backend, calls } = fixture();
  const result = await backend.getCronLatestDelivery(jobId, run.startedAt);
  assert.equal(result.fullText, report);
  assert.equal(result.source, "transcript");
  assert.equal(result.startedAt, run.startedAt);
  assert.deepEqual(calls, [{ method: "cron.history", params: {
    id: "daily-report", runId: run.runId, limit: 100,
  } }]);
});

test("legacy run logs without runId use the exact run timestamp", async () => {
  const { backend, calls } = fixture({ entry: { ...run, runId: undefined } });
  assert.equal((await backend.getCronLatestDelivery(jobId)).fullText, report);
  assert.equal(calls[0].params.runAtMs, run.startedAt);
  assert.equal(Object.hasOwn(calls[0].params, "runId"), false);
});

test("history pages preserve the delivered report before a short completion note", async () => {
  const { backend, calls } = fixture();
  backend.request = async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { messages: [{ role: "assistant", content: [
      { type: "toolCall", name: "message", arguments: { action: "send", message: report } },
    ] }] } : { messages: [assistant("Delivered")], nextCursor: "older-page" };
  };
  assert.equal((await backend.getCronLatestDelivery(jobId)).fullText, report);
  assert.equal(calls[1].params.cursor, "older-page");
  assert.equal(calls[1].params.runId, run.runId);
});

test("older pages cannot overwrite the latest assistant report", async () => {
  const { backend } = fixture();
  backend.request = async (_method, params) => params.cursor
    ? { messages: [assistant("Earlier progress")] }
    : { messages: [assistant(report)], nextCursor: "older-page" };
  assert.equal((await backend.getCronLatestDelivery(jobId)).fullText, report);
});

test("remote gateway reads canonical run history without accessing local transcripts", async () => {
  const { backend } = fixture({ remote: true });
  backend._readCronTranscriptText = () => { assert.fail("remote gateway read local disk"); };
  assert.equal((await backend.getCronLatestDelivery(jobId)).fullText, report);
  backend.request = async () => { throw Error("unsupported method"); };
  assert.equal((await backend.getCronLatestDelivery(jobId)).source, "summary");
});

test("older gateways retain the local JSONL fallback", async () => {
  const { backend } = fixture();
  backend.request = async () => { throw Error("unknown method: cron.history"); };
  backend._readCronTranscriptText = (id, key) => {
    assert.equal(id, jobId); assert.equal(key, run.sessionKey);
    return report;
  };
  assert.equal((await backend.getCronLatestDelivery(jobId)).fullText, report);
});

test("missing exact run identity never reads the latest session", async () => {
  const { backend, calls } = fixture({ entry: { summary: "fallback" } });
  assert.equal((await backend.getCronLatestDelivery(jobId)).source, "summary");
  assert.equal(calls.length, 0);
});

test("incomplete or invalid history never masquerades as the full report", async () => {
  for (const mode of ["repeat", "failure", "invalid", "truncated", "limit"]) {
    const { backend } = fixture();
    let count = 0;
    backend.request = async () => {
      count++;
      if (mode === "failure" && count > 1) throw Error("unavailable");
      if (mode === "invalid") return { messages: "invalid" };
      if (mode === "truncated") return { messages: [{ ...assistant(report), __openclaw: { truncated: true } }] };
      return { messages: [assistant("partial")], nextCursor: mode === "limit" ? `page-${count}` : "same" };
    };
    const result = await backend.getCronLatestDelivery(jobId);
    assert.equal(result.source, "summary", mode);
    assert.equal(result.fullText, null, mode);
    assert.ok(count <= 10, "history reads must be bounded");
  }
});

test("changing the gateway discards pending history and prevents fallback to another host", async () => {
  const { backend } = fixture();
  backend.request = async () => {
    backend._getUpstreamUrl = () => "ws://127.0.0.1:23456";
    return { messages: [assistant(report)] };
  };
  backend._readCronTranscriptText = () => { assert.fail("stale delivery read local disk"); };
  assert.equal((await backend.getCronLatestDelivery(jobId)).source, "none");
});
