"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { releaseApi, sleep } = require("./release-http.cjs");

const route = "/actions/workflows/ci.yml";
const workflowPath = ".github/workflows/ci.yml";
const sourceCiJobs = ["isolated-checks", "macos-hook-checks"];
const mainCiBudgetMs = 40 * 60_000;
const pending = new Set(["queued", "requested", "pending", "waiting", "in_progress"]);
const gitId = /^[a-f0-9]{40}$/u;
const positiveId = id => Number.isSafeInteger(id) && id > 0;
const mainSource = sha => ({ event: "push", branch: "main", head: sha });

async function mergedPrSource(client, repository, sha) {
  const prs = await client.get(`/commits/${sha}/pulls?per_page=100`);
  const matches = prs.filter(pr => pr.merged_at && pr.merge_commit_sha === sha
    && pr.base?.ref === "main" && pr.base.repo?.full_name === repository
    && pr.head?.repo?.full_name === repository);
  if (matches.length !== 1) return null;
  const pr = matches[0];
  if (!positiveId(pr.number) || !gitId.test(pr.head.sha) || !pr.head.ref) return null;
  const commit = await client.get(`/git/commits/${sha}`);
  if (commit.sha !== sha || !gitId.test(commit.tree?.sha)) return null;
  // Actions reports the PR head SHA even when checkout tested refs/pull/N/merge.
  return { event: "pull_request", branch: pr.head.ref, head: pr.head.sha, marker: `Tested PR #${pr.number} tree ${commit.tree.sha}` };
}

async function sourceRun(client, repository, source, knownRun) {
  const workflow = await client.get(route);
  if (workflow.path !== workflowPath || workflow.state !== "active" || !positiveId(workflow.id)) return null;
  let run = knownRun;
  if (!run) {
    const { total_count, workflow_runs } = await client.get(
      `${route}/runs?branch=${encodeURIComponent(source.branch)}&event=${source.event}&head_sha=${source.head}&per_page=10`,
    );
    if (total_count !== 1 || workflow_runs?.length !== 1) return null;
    [run] = workflow_runs;
  }
  const matches = candidate => positiveId(run.id) && candidate.id === run.id
    && candidate.workflow_id === workflow.id && candidate.path === workflowPath
    && candidate.repository?.full_name === repository && candidate.head_repository?.full_name === repository
    && candidate.head_branch === source.branch && candidate.event === source.event && candidate.head_sha === source.head
    && positiveId(candidate.run_attempt);
  return matches(run) ? { run, matches } : null;
}

async function onMain(client, sha) {
  const ancestry = await client.get(`/compare/${sha}...main`);
  return ["identical", "ahead"].includes(ancestry.status);
}

async function completedProof(client, run, marker) {
  if (run.status !== "completed" || run.conclusion !== "success") return null;
  const { total_count, jobs } = await client.get(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  if (!Array.isArray(jobs) || total_count !== jobs.length || new Set(jobs.map(job => job.name)).size !== jobs.length) return null;
  if (jobs.some(job => job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha
    || job.status !== "completed" || (!sourceCiJobs.includes(job.name)
      && (job.name !== "reviewed-pr-ci" || !["success", "skipped"].includes(job.conclusion))))) return null;
  const passed = sourceCiJobs.every(name => {
    const job = jobs.find(item => item.name === name);
    if (job?.conclusion !== "success") return false;
    if (!marker) return true;
    const steps = job.steps?.filter(step => step.name === marker);
    return steps?.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "success";
  });
  return passed ? { runId: run.id, runAttempt: run.run_attempt } : null;
}

async function selectPullRequestSourceCi(client, repository, sha) {
  assert.match(sha, gitId);
  const source = await mergedPrSource(client, repository, sha);
  if (!source) return null;
  const match = await sourceRun(client, repository, source);
  if (!match || !await onMain(client, sha)) return null;
  return completedProof(client, match.run, source.marker);
}

async function selectMainSourceCi(client, repository, sha, { wait = false, pause = sleep, now = Date.now } = {}) {
  assert.match(sha, gitId);
  const match = await sourceRun(client, repository, mainSource(sha));
  if (!match || !await onMain(client, sha)) return null;
  let { run } = match;
  const runId = run.id;
  const start = now();
  const deadline = Math.min(Date.parse(run.created_at) + mainCiBudgetMs, start + mainCiBudgetMs);
  if (wait && pending.has(run.status) && deadline > start) {
    console.log(`Waiting for the existing main CI run ${runId}.`);
    while (pending.has(run.status) && now() < deadline) {
      await pause(Math.min(20_000, deadline - now()));
      run = await client.get(`/actions/runs/${runId}`);
      if (!match.matches(run)) return null;
    }
  }
  return completedProof(client, run);
}

async function verifySourceCiProof(client, repository, sha, proof) {
  assert.match(sha, gitId);
  assert.ok(positiveId(proof.runId) && positiveId(proof.runAttempt));
  const run = await client.get(`/actions/runs/${proof.runId}`);
  if (run.id !== proof.runId || run.run_attempt !== proof.runAttempt) return null;
  const source = run.event === "pull_request" ? await mergedPrSource(client, repository, sha) : mainSource(sha);
  if (!source || !await sourceRun(client, repository, source, run) || !await onMain(client, sha)) return null;
  return completedProof(client, run, source.marker);
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.RELEASE_SOURCE_SHA;
  const client = releaseApi(repository, process.env.GH_TOKEN, { singleAttempt: true });
  assert.equal(sha, process.env.GITHUB_SHA);
  const prOnly = process.argv[2] === "--pull-request-only";
  if (prOnly) assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  let kind = "merged PR";
  let proof = await selectPullRequestSourceCi(client, repository, sha).catch(() => null);
  if (!proof && !prOnly) {
    proof = await selectMainSourceCi(client, repository, sha, { wait: true }).catch(() => null);
    if (proof) kind = "main";
    else proof = await selectPullRequestSourceCi(client, repository, sha).catch(() => null);
  }
  if (!proof) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "No reusable source CI proof. Full source CI will run.\n");
    return;
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${proof.runId}\nrun_attempt=${proof.runAttempt}\n`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Reusing [${kind} CI](https://github.com/${repository}/actions/runs/${proof.runId}/attempts/${proof.runAttempt}) for \`${sha}\`.\n`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { selectMainSourceCi, selectPullRequestSourceCi, verifySourceCiProof, sourceCiJobs };
