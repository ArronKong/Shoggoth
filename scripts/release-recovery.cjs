"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { releaseApi, sleep } = require("./release-http.cjs");

const repository = "ArronKong/Shoggoth";
const maximumAttempts = 3;
const macJobs = new Set(["source-ci / macos-hook-checks", "Sign and notarize arm64", "Sign and notarize x64",
  "native-verification / Native arm64 draft verification", "native-verification / Native x64 draft verification"]);

function assertTrustedRun(run) {
  assert.equal(run.repository?.full_name, repository, "Unexpected run repository");
  assert.equal(run.head_repository?.full_name, repository, "Fork runs cannot request recovery");
  assert.equal(run.event, "workflow_dispatch", "Only deliberate release dispatches may recover");
  assert.equal(run.path, ".github/workflows/release.yml");
  // REST run.name can contain run-name (and the version); use workflow_id below.
  assert.ok(Number.isSafeInteger(run.workflow_id) && run.workflow_id > 0);
  assert.match(run.head_branch, /^v\d+\.\d+\.\d+$/u);
  assert.match(run.head_sha, /^[a-f0-9]{40}$/u);
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
}

async function jobsFor(client, runId) {
  const result = await client.get(`/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  assert.equal(result.total_count, result.jobs.length, "Incomplete job inventory");
  return result.jobs;
}

async function capacityFailures(client, jobs) {
  const failures = jobs.filter(job => !["success", "skipped"].includes(job.conclusion));
  if (!failures.length) return [];
  for (const job of failures) {
    if (job.conclusion !== "cancelled" || !macJobs.has(job.name) || !Array.isArray(job.steps) || job.steps.length
      || !job.labels?.some(label => ["macos-latest", "macos-15-intel"].includes(label))) return [];
    const prefix = `https://api.github.com/repos/${repository}`;
    assert.ok(job.check_run_url?.startsWith(`${prefix}/check-runs/`));
    const check = await client.get(job.check_run_url.slice(prefix.length));
    assert.equal(check.id, Number(job.check_run_url.split("/").pop()));
    const annotations = await client.get(`/check-runs/${check.id}/annotations?per_page=100`);
    if (!annotations.some(item => item.message === "The job was not acquired by Runner of type hosted even after multiple attempts")) return [];
  }
  return failures;
}

async function recoverRelease(client, eventRun, runtime = {}) {
  const pause = runtime.sleep || sleep;
  const record = runtime.record || (() => {});
  assertTrustedRun(eventRun);
  let current = await client.get(`/actions/runs/${eventRun.id}`);
  assertTrustedRun(current);
  assert.equal(current.head_sha, eventRun.head_sha);
  const workflow = await client.get("/actions/workflows/release.yml");
  assert.deepEqual([current.workflow_id, eventRun.workflow_id, workflow.path, workflow.name],
    [workflow.id, workflow.id, ".github/workflows/release.yml", "Signed macOS draft"]);
  if (current.run_attempt !== eventRun.run_attempt || current.status !== "completed")
    return { decision: "already-advanced", runId: current.id, attempt: current.run_attempt };
  if (current.conclusion === "success") return { decision: "success", runId: current.id, attempt: current.run_attempt };
  const jobs = await jobsFor(client, current.id);
  const failed = jobs.filter(job => !["success", "skipped"].includes(job.conclusion));
  const base = { runId: current.id, source: current.head_sha, tag: current.head_branch,
    attempt: current.run_attempt, failedJobs: failed.map(job => ({ id: job.id, name: job.name, conclusion: job.conclusion })) };
  // Explicit cancellation, code failures, missing credentials and started jobs stay stopped.
  if (current.conclusion !== "failure") return { ...base, decision: "needs-attention", reason: "Run was cancelled or did not fail normally" };
  if (current.run_attempt >= maximumAttempts) return { ...base, decision: "needs-attention", reason: "Automatic retry limit reached (3 total attempts)" };
  const candidates = await capacityFailures(client, jobs);
  if (!candidates.length) return { ...base, decision: "needs-attention", reason: "Failure is not a proven hosted Mac allocation failure before execution" };
  await client.assertTag(current.head_branch, current.head_sha);
  const ancestry = await client.get(`/compare/${current.head_sha}...main`);
  assert.ok(["ahead", "identical"].includes(ancestry.status), "Release source must belong to reviewed main");
  const backoffMs = current.run_attempt === 1 ? 60_000 : 180_000;
  record({ ...base, decision: "waiting-to-retry", backoffMs });
  await pause(backoffMs);
  current = await client.get(`/actions/runs/${current.id}`);
  if (current.status !== "completed" || current.run_attempt !== eventRun.run_attempt)
    return { ...base, decision: "already-advanced" };
  assertTrustedRun(current);
  assert.equal(current.head_sha, eventRun.head_sha);
  assert.equal(current.conclusion, "failure");
  await client.assertTag(current.head_branch, current.head_sha);
  const confirmed = await capacityFailures(client, await jobsFor(client, current.id));
  assert.deepEqual(confirmed.map(job => job.id).sort(), candidates.map(job => job.id).sort(), "Failure inventory changed during backoff");
  const route = confirmed.length === 1 ? `/actions/jobs/${confirmed[0].id}/rerun`
    : `/actions/runs/${current.id}/rerun-failed-jobs`;
  record({ ...base, decision: "retry-requested", route });
  // Send once. An uncertain response is reconciled by reads, never a second POST.
  try { await client.request(route, { method: "POST" }); }
  catch (error) { record({ ...base, decision: "reconciling-retry", error: error.message }); }
  for (let check = 0; check < 10; check++) {
    const after = await client.get(`/actions/runs/${current.id}`);
    assertTrustedRun(after);
    assert.equal(after.head_sha, current.head_sha);
    if (after.run_attempt > current.run_attempt)
      return { ...base, decision: "retried", nextAttempt: after.run_attempt, reusedSuccessfulJobs: true };
    await pause(3000);
  }
  return { ...base, decision: "needs-attention", reason: "Retry response uncertain; inspect the existing run before sending another request" };
}

async function main() {
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_run");
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  assert.equal(event.action, "completed");
  const records = [];
  const save = result => {
    records.push({ at: new Date().toISOString(), ...result });
    fs.writeFileSync("release-recovery.json", JSON.stringify(records, null, 2) + "\n");
  };
  const result = await recoverRelease(releaseApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN),
    { ...event.workflow_run, repository: event.repository }, { record: save });
  save(result);
  const summary = `Release recovery: **${result.decision}**\n\n[Original release run](https://github.com/${repository}/actions/runs/${event.workflow_run.id})\n\n${result.reason || ""}\n`;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(JSON.stringify(result));
  if (result.decision === "needs-attention") process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  const records = fs.existsSync("release-recovery.json") ? JSON.parse(fs.readFileSync("release-recovery.json", "utf8")) : [];
  records.push({ at: new Date().toISOString(), decision: "needs-attention", reason: error.message });
  fs.writeFileSync("release-recovery.json", JSON.stringify(records, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Release recovery stopped; no further retry was sent. Inspect the recovery receipt and failed step.\n`);
  console.error(error.message); process.exitCode = 1;
});
module.exports = { assertTrustedRun, capacityFailures, recoverRelease, maximumAttempts };
