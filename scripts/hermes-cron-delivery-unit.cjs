"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { HermesBackend } = require("../app/core/hermes-backend");

const firstAt = new Date(2026, 10, 1, 9).getTime();
const laterAt = firstAt + 3_600_000;
const jobId = "hermes-default:daily-report";
const fullReport = "完整日报内容。".repeat(400) + "【日报结束】";
const message = text => ({ role: "assistant", content: [{ type: "text", text }] });
function fixture() {
  const backend = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  const dash = { profile: "default", baseUrl: "http://127.0.0.1:1", token: "fixture" };
  backend.dashboards.set("default", dash);
  backend.profileById.set("hermes-default", "default");
  backend._readCronExecutionHistory = async () => { throw Error("no ledger"); };
  const reads = [];
  backend._fetchHistoricalMessages = async key => {
    reads.push(key);
    return [message(key.endsWith(":early") ? fullReport : "Later report")];
  };
  backend.getCronRuns = async () => ({ runs: [
    { startedAt: laterAt, finishedAt: laterAt + 60_000, sessionKey: "late", status: "ok" },
    { startedAt: firstAt, finishedAt: firstAt + 60_000, sessionKey: "early", status: "ok" },
  ] });
  return { backend, reads, dash };
}

test("Dashboard opens the clicked historical Hermes run, including the full ending", async () => {
  const { backend, reads } = fixture();
  const result = await backend.getCronLatestDelivery(jobId, firstAt);
  assert.equal(result.startedAt, firstAt);
  assert.ok(result.fullText === fullReport, "the complete earlier report is required");
  assert.equal(result.source, "transcript");
  assert.deepEqual(reads, ["agent:hermes-default:early"]);
});

test("calendar occurrence chooses the nearest same-day run; an empty day has no report", async () => {
  const { backend, reads } = fixture();
  assert.equal((await backend.getCronLatestDelivery(jobId, firstAt - 1_000)).startedAt, firstAt);
  assert.equal((await backend.getCronLatestDelivery(jobId, firstAt - 86_400_000)).source, "none");
  assert.equal(reads.length, 1);
  assert.equal((await backend.getCronLatestDelivery(jobId)).startedAt, laterAt);
});

test("failed historical run never returns a later successful report", async () => {
  const { backend, reads } = fixture();
  backend.getCronRuns = async () => ({ runs: [
    { startedAt: laterAt, sessionKey: "late", status: "ok" },
    { startedAt: firstAt, sessionKey: "early", status: "error", error: "model failed" },
  ] });
  const result = await backend.getCronLatestDelivery(jobId, firstAt);
  assert.equal(result.startedAt, firstAt);
  assert.equal(result.error, "model failed");
  assert.equal(result.fullText, null);
  assert.equal(reads.length, 0);
});

test("run details use the same execution clock and session binding as Dashboard", async () => {
  const { backend } = fixture();
  delete backend.getCronRuns;
  backend._readCronExecutionHistory = async profile => {
    assert.equal(profile, "default");
    return { items: [
      { id: "attempt-early", jobId: "daily-report", startedAt: firstAt, finishedAt: firstAt + 60_000, status: "ok" },
      { id: "attempt-late", jobId: "daily-report", startedAt: laterAt, finishedAt: laterAt + 60_000, status: "ok" },
      { id: "foreign", jobId: "another-job", startedAt: firstAt, finishedAt: firstAt + 60_000, status: "ok" },
    ] };
  };
  backend._httpGet = async url => ({ status: 200, body: JSON.stringify(url.includes("/runs") ? { runs: [
    { id: "late", started_at: (laterAt + 1_900) / 1000, ended_at: (laterAt + 59_000) / 1000 },
    { id: "early", started_at: (firstAt + 1_900) / 1000, ended_at: (firstAt + 59_000) / 1000 },
  ] } : { id: "daily-report", last_run_at: new Date(laterAt + 60_000).toISOString(),
    last_status: "ok", last_delivery_error: "delivery unavailable" }) });
  const { runs } = await backend.getCronRuns(jobId);
  assert.deepEqual(runs.map(r => [r.runId, r.startedAt, r.sessionKey]), [
    ["attempt-late", laterAt, "late"], ["attempt-early", firstAt, "early"],
  ]);
  assert.equal(runs[0].deliveryStatus, "error", "execution binding preserves delivery metadata");
  assert.equal(runs[0].deliveryError, "delivery unavailable");
  const result = await backend.getCronLatestDelivery(jobId, firstAt);
  assert.equal(result.startedAt, firstAt, "Dashboard requires exact execution timestamp equality");
  assert.ok(result.fullText === fullReport);
});

test("ambiguous execution-to-session binding never borrows a report", async () => {
  const { backend, reads } = fixture();
  delete backend.getCronRuns;
  backend._readCronExecutionHistory = async () => ({ items: [
    { id: "attempt", jobId: "daily-report", startedAt: firstAt, finishedAt: firstAt + 60_000, status: "ok" },
  ] });
  backend._httpGet = async url => ({ status: 200, body: JSON.stringify(url.includes("/runs") ? { runs: [
    { id: "early", started_at: (firstAt + 1_000) / 1000 },
    { id: "another", started_at: (firstAt + 2_000) / 1000 },
  ] } : { id: "daily-report" }) });
  assert.equal((await backend.getCronLatestDelivery(jobId, firstAt)).source, "none");
  assert.equal(reads.length, 0);
});

test("remote Hermes never consults a local execution ledger", async () => {
  const { backend } = fixture();
  delete backend.getCronRuns;
  backend._getConfig = () => ({ hermesMode: "remote" });
  backend._readCronExecutionHistory = async () => { assert.fail("remote read local ledger"); };
  backend._httpGet = async url => ({ status: 200, body: JSON.stringify(url.includes("/runs") ? { runs: [
    { id: "early", started_at: firstAt / 1000, ended_at: (firstAt + 60_000) / 1000 },
  ] } : { id: "daily-report" }) });
  assert.ok((await backend.getCronLatestDelivery(jobId, firstAt)).fullText === fullReport);
});

test("reconfigured Hermes discards the in-flight report", async () => {
  const { backend } = fixture();
  backend._fetchHistoricalMessages = async () => {
    backend._lifecycleGeneration++;
    return [message(fullReport)];
  };
  assert.equal((await backend.getCronLatestDelivery(jobId, firstAt)).source, "none");
});
