"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { releaseApi, sleep } = require("./release-http.cjs");

const workflowPath = ".github/workflows/ci.yml";
const sourceCiJobs = ["isolated-checks", "macos-hook-checks"];
const mainCiBudgetMs = 25 * 60_000;
const pending = new Set(["queued", "requested", "pending", "waiting", "in_progress"]);

async function selectMainSourceCi(client, repository, sha, { wait = false, pause = sleep, now = Date.now } = {}) {
  assert.match(sha, /^[a-f0-9]{40}$/u);
  const route = "/actions/workflows/ci.yml";
  const workflow = await client.get(route);
  if (workflow.path !== workflowPath || workflow.state !== "active"
    || !Number.isSafeInteger(workflow.id) || workflow.id <= 0) return null;
  const { total_count, workflow_runs } = await client.get(
    `${route}/runs?branch=main&event=push&head_sha=${sha}&per_page=10`,
  );
  if (total_count !== 1 || workflow_runs?.length !== 1) return null;
  let [run] = workflow_runs;
  const runId = run.id;
  const matchesSource = candidate => Number.isSafeInteger(runId) && runId > 0 && candidate.id === runId
    && candidate.workflow_id === workflow.id && candidate.path === workflowPath
    && candidate.repository?.full_name === repository && candidate.head_repository?.full_name === repository
    && candidate.head_branch === "main" && candidate.event === "push" && candidate.head_sha === sha
    && Number.isSafeInteger(candidate.run_attempt) && candidate.run_attempt > 0;
  if (!matchesSource(run)) return null;

  const ancestry = await client.get(`/compare/${sha}...main`);
  if (!["identical", "ahead"].includes(ancestry.status)) return null;
  const start = now();
  const deadline = Math.min(Date.parse(run.created_at) + mainCiBudgetMs, start + mainCiBudgetMs);
  if (wait && pending.has(run.status) && deadline > start) {
    console.log(`Waiting for the existing main CI run ${runId}.`);
    while (pending.has(run.status) && now() < deadline) {
      await pause(Math.min(20_000, deadline - now()));
      run = await client.get(`/actions/runs/${runId}`);
      if (!matchesSource(run)) return null;
    }
  }
  if (run.status !== "completed" || run.conclusion !== "success") return null;
  const inventory = await client.get(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  if (inventory.total_count !== sourceCiJobs.length || inventory.jobs?.length !== sourceCiJobs.length) return null;
  const passed = sourceCiJobs.every(name => {
    const matches = inventory.jobs.filter(job => job.name === name);
    if (matches.length !== 1) return false;
    const [job] = matches;
    return job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === sha
      && job.status === "completed" && job.conclusion === "success";
  });
  return passed ? { runId: run.id, runAttempt: run.run_attempt } : null;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.RELEASE_SOURCE_SHA;
  const client = releaseApi(repository, process.env.GH_TOKEN, { singleAttempt: true });
  assert.equal(sha, process.env.GITHUB_SHA);
  let proof;
  try {
    proof = await selectMainSourceCi(client, repository, sha, { wait: true });
  } catch {
    // An unavailable or malformed GitHub response leaves the complete CI enabled.
    console.log("Exact main CI could not be verified.");
  }
  if (!proof) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "Source CI will run for this release.\n");
    return;
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${proof.runId}\nrun_attempt=${proof.runAttempt}\n`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Reusing [main CI](https://github.com/${repository}/actions/runs/${proof.runId}/attempts/${proof.runAttempt}) for \`${sha}\`.\n`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { selectMainSourceCi, sourceCiJobs };
