"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { releaseApi, sleep } = require("./release-http.cjs");

const repository = "ArronKong/Shoggoth";
const maximumAttempts = 3;
const macJobs = new Set(["source-ci / macos-hook-checks", "Sign and notarize arm64", "Sign and notarize x64",
  "native-verification / Native arm64 draft verification", "native-verification / Native x64 draft verification"]);
const interruptibleJobs = new Map([
  ["source-ci / isolated-checks", "ubuntu-latest"],
  ["source-ci / macos-hook-checks", "macos-latest"],
  ["native-verification / Native arm64 draft verification", "macos-latest"],
  ["native-verification / Native x64 draft verification", "macos-15-intel"],
  ["verify-public", "ubuntu-latest"],
]);
const shutdownError = "The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.";
const cancelledError = "The operation was canceled.";
const publicReadError = "Transient public verification read exhausted";

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
  assert.ok(result.jobs.every(job => job.run_id === runId && Number.isSafeInteger(job.id) && job.id > 0),
    "Unexpected job identity");
  return result.jobs;
}

async function checkAnnotations(client, job) {
  const prefix = `https://api.github.com/repos/${repository}/check-runs/`;
  const checkId = job.check_run_url?.startsWith(prefix) ? job.check_run_url.slice(prefix.length) : "";
  assert.match(checkId, /^[1-9]\d*$/u);
  assert.equal(checkId, String(job.id), "Check run does not belong to the failed job");
  const route = `/check-runs/${checkId}`;
  const check = await client.get(route);
  assert.equal(check.id, Number(checkId));
  return client.get(`${route}/annotations?per_page=100`);
}

async function jobErrors(client, job) {
  assert.ok(Number.isSafeInteger(job.id) && job.id > 0);
  const response = await client.request(`/actions/jobs/${job.id}/logs`);
  const limit = 4 * 1024 * 1024;
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) return [];
    chunks.push(Buffer.from(chunk));
  }
  return [...Buffer.concat(chunks).toString("utf8").matchAll(
    /^(?:\ufeff)?\d{4}-\d{2}-\d{2}T[\d:.]+Z ##\[error\]([^\r\n]+)\r?$/gmu,
  )].map(match => match[1].trim());
}

function publishedInThisRun(jobs) {
  const writes = jobs.filter(job => job.name === "publish");
  return writes.length === 1 && writes[0].status === "completed" && writes[0].conclusion === "success";
}

async function retryReason(client, job, jobs) {
  if (!Array.isArray(job.steps)) return null;
  if (job.conclusion === "cancelled" && job.steps.length === 0 && macJobs.has(job.name)
    && job.labels?.some(label => ["macos-latest", "macos-15-intel"].includes(label))) {
    const annotations = await checkAnnotations(client, job);
    if (annotations.some(item => item.message === "The job was not acquired by Runner of type hosted even after multiple attempts")) {
      return "hosted-mac-allocation";
    }
  }
  const label = interruptibleJobs.get(job.name);
  if (!label || job.status !== "completed" || job.conclusion !== "failure" || !job.labels?.includes(label)
    || job.runner_group_name !== "GitHub Actions" || !job.runner_id) return null;
  if (job.name === "verify-public" && !publishedInThisRun(jobs)) return null;

  const failed = job.steps.filter(step => step.conclusion === "failure");
  const cancelled = job.steps.filter(step => step.conclusion === "cancelled");
  if (failed.length === 0 && cancelled.length === 1) {
    const errors = await jobErrors(client, job);
    if (errors.length === 2 && errors.includes(shutdownError) && errors.includes(cancelledError)) return "hosted-runner-shutdown";
  }
  if (job.name === "verify-public" && cancelled.length === 0 && failed.length === 1
    && failed[0].name === "Verify anonymous downloads for the published release") {
    const annotations = await checkAnnotations(client, job);
    const errors = annotations.filter(item => item.annotation_level === "failure");
    if (errors.length === 2 && errors.some(item => item.message === publicReadError)
      && errors.some(item => item.message === "Process completed with exit code 1.")) return "public-download-read";
  }
  return null;
}

async function retryCandidates(client, jobs) {
  const candidates = [];
  for (const job of jobs.filter(item => !["success", "skipped"].includes(item.conclusion))) {
    const reason = await retryReason(client, job, jobs);
    if (!reason) return [];
    candidates.push({ id: job.id, reason });
  }
  return candidates.sort((a, b) => a.id - b.id);
}

async function recoverRelease(client, eventRun, runtime = {}) {
  const pause = runtime.sleep || sleep;
  const record = runtime.record || (() => {});
  assertTrustedRun(eventRun);
  let current = await client.get(`/actions/runs/${eventRun.id}`);
  assertTrustedRun(current);
  assert.deepEqual([current.id, current.head_sha, current.head_branch], [eventRun.id, eventRun.head_sha, eventRun.head_branch]);
  const workflow = await client.get("/actions/workflows/release.yml");
  assert.deepEqual([current.workflow_id, eventRun.workflow_id, workflow.path, workflow.name],
    [workflow.id, workflow.id, ".github/workflows/release.yml", "Signed macOS draft"]);
  if (current.run_attempt !== eventRun.run_attempt || current.status !== "completed")
    return { decision: "already-advanced", runId: current.id, attempt: current.run_attempt };
  if (current.conclusion === "success") return { decision: "success", runId: current.id, attempt: current.run_attempt };
  const jobs = await jobsFor(client, current.id);
  const failed = jobs.filter(job => !["success", "skipped"].includes(job.conclusion));
  const base = { runId: current.id, source: current.head_sha, tag: current.head_branch,
    attempt: current.run_attempt, failedJobs: failed.map(job => ({ id: job.id, name: job.name, conclusion: job.conclusion,
      steps: (job.steps || []).filter(step => ["failure", "cancelled"].includes(step.conclusion)).map(step => step.name) })) };
  if (publishedInThisRun(jobs) && failed.some(job => job.name === "verify-public")) base.releaseState = "published-verification-pending";
  if (current.conclusion !== "failure") return { ...base, decision: "needs-attention", reason: "Run was cancelled or did not fail normally" };
  if (current.run_attempt >= maximumAttempts) return { ...base, decision: "needs-attention", reason: "Automatic retry limit reached (3 total attempts)" };
  const candidates = await retryCandidates(client, jobs);
  if (!candidates.length) return { ...base, decision: "needs-attention", reason: "Failed steps do not match a verified transient condition" };
  await client.assertTag(current.head_branch, current.head_sha);
  const ancestry = await client.get(`/compare/${current.head_sha}...main`);
  assert.ok(["ahead", "identical"].includes(ancestry.status), "Release source must belong to reviewed main");
  const backoffMs = current.run_attempt === 1 ? 60_000 : 180_000;
  record({ ...base, decision: "waiting-to-retry", backoffMs, candidates });
  await pause(backoffMs);
  current = await client.get(`/actions/runs/${current.id}`);
  if (current.status !== "completed" || current.run_attempt !== eventRun.run_attempt)
    return { ...base, decision: "already-advanced" };
  assertTrustedRun(current);
  assert.deepEqual([current.id, current.workflow_id, current.head_sha, current.head_branch],
    [eventRun.id, eventRun.workflow_id, eventRun.head_sha, eventRun.head_branch]);
  assert.equal(current.conclusion, "failure");
  await client.assertTag(current.head_branch, current.head_sha);
  const confirmed = await retryCandidates(client, await jobsFor(client, current.id));
  assert.deepEqual(confirmed, candidates, "Failure inventory changed during backoff");
  const route = confirmed.length === 1 ? `/actions/jobs/${confirmed[0].id}/rerun`
    : `/actions/runs/${current.id}/rerun-failed-jobs`;
  record({ ...base, decision: "retry-requested", route });
  // Send once. An uncertain response is reconciled by reads, never a second POST.
  try { await client.request(route, { method: "POST" }); }
  catch (error) { record({ ...base, decision: "reconciling-retry", error: error.message }); }
  for (let check = 0; check < 10; check++) {
    const after = await client.get(`/actions/runs/${current.id}`);
    assertTrustedRun(after);
    assert.deepEqual([after.id, after.workflow_id, after.head_sha, after.head_branch],
      [current.id, current.workflow_id, current.head_sha, current.head_branch]);
    if (after.run_attempt > current.run_attempt)
      return { ...base, decision: "retried", nextAttempt: after.run_attempt, reusedSuccessfulJobs: true, candidates };
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
  const state = result.releaseState ? "The release is public. Download verification is pending.\n\n" : "";
  const steps = (result.failedJobs || []).map(job => `- [${job.name}](https://github.com/${repository}/actions/runs/${result.runId}/job/${job.id}) ${job.steps.join(", ")}`).join("\n");
  const summary = `Release recovery: **${result.decision}**\n\n[Original release run](https://github.com/${repository}/actions/runs/${event.workflow_run.id})\n\n${state}${result.reason || ""}\n\n${steps}\n`;
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
module.exports = { assertTrustedRun, recoverRelease, maximumAttempts };
