"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");
const { releaseApi, releaseRequest, isTransientReadError } = require("./release-http.cjs");
const { packageNames, assertDraft, assertAssetInventory } = require("./release-draft.cjs");
const { selectMainSourceCi, sourceCiJobs } = require("./release-source-ci.cjs");

const repository = "ArronKong/Shoggoth";
const webBase = `https://github.com/${repository}`;
const transientPublicReadMessage = "Transient public verification read exhausted";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const identities = assets => assets.map(asset => ({ id: asset.id, name: asset.name, size: asset.size,
  digest: asset.digest ?? null })).sort((a, b) => a.id - b.id);
const gateNames = ["validate",
  "Sign and notarize arm64", "Sign and notarize x64", "draft",
  "native-verification / Native arm64 draft verification", "native-verification / Native x64 draft verification", "accepted-draft"];
const releaseCiJobNames = sourceCiJobs.map(name => `source-ci / ${name}`);

function createIntent({ version, tag, sha, runId, mode = "draft", notesFile = "", notes = "" }) {
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.equal(tag, `v${version}`);
  assert.match(sha, /^[a-f0-9]{40}$/u);
  assert.match(String(runId), /^\d+$/u);
  assert.ok(["draft", "publish"].includes(mode), "Unknown release mode");
  notes = notes.trim();
  if (mode === "publish" || notesFile || notes) {
    assert.equal(notesFile, `release-notes/${tag}.md`, "Notes must be part of the reviewed version tag");
    assert.ok(Buffer.byteLength(notes) < 60_000, "Release notes too large");
    const sections = [...notes.matchAll(/^## (.+)$/gmu)];
    assert.deepEqual(sections.map(match => match[1]), ["English", "简体中文"], "Require complete English first, then Simplified Chinese");
    assert.ok(notes.slice(sections[0].index + sections[0][0].length, sections[1].index).trim());
    assert.ok(notes.slice(sections[1].index + sections[1][0].length).trim());
    assert.ok(!notes.includes("{{") && !notes.includes("shoggoth-draft-pipeline:"), "Unresolved or conflicting notes");
  }
  return { schema: 1, version, tag, sha, runId: String(runId), mode, notesFile, notes, notesSha256: digest(notes) };
}

function assertAccepted(intent, receipt) {
  assert.deepEqual(intent, createIntent({ ...intent, runId: intent.runId }));
  assert.equal(intent.mode, "publish", "Formal publication was not selected at dispatch");
  assert.deepEqual([receipt.sha, receipt.tag, String(receipt.runId), receipt.draft],
    [intent.sha, intent.tag, intent.runId, true]);
  if (receipt.sourceCi !== "passed") {
    const { runId, runAttempt } = receipt.sourceCi ?? {};
    assert.ok([runId, runAttempt].every(id => Number.isSafeInteger(id) && id > 0), "Invalid main CI proof");
  }
  assert.deepEqual(receipt.nativeArchitectures, ["arm64", "x64"]);
  assert.ok(Number.isSafeInteger(receipt.releaseId) && receipt.releaseId > 0);
  assert.match(String(receipt.runAttempt), /^[1-9]\d*$/u);
  const names = [...packageNames(intent.version, "arm64"), ...packageNames(intent.version, "x64"), "latest-mac.yml", "SHA256SUMS.txt"];
  assertAssetInventory(receipt.remoteAssets, names, true);
  assertAssetInventory(receipt.assets, names, true);
  for (const asset of receipt.remoteAssets) {
    const bytes = receipt.assets.find(item => item.name === asset.name);
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0 && Number.isSafeInteger(asset.size) && asset.size > 0);
    assert.deepEqual([asset.id, asset.size, asset.digest], [bytes.id, bytes.size, `sha256:${bytes.sha256}`], "Accepted asset bytes differ");
  }
}

function assertAudits(directory, now = Date.now()) {
  for (const name of ["audit-root.json", "audit-ui.json"]) {
    const file = path.join(directory, name);
    const audit = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(audit.decision?.passed === true && [0, 1].includes(audit.npmExitCode) && audit.rawReport?.auditReportVersion === 2,
      "Publication dependency audit failed");
    const age = now - fs.statSync(file).mtimeMs;
    assert.ok(age >= -60_000 && age < 2 * 60 * 60_000, "Fresh publication dependency audits are required");
  }
}

async function assertLiveGates(client, intent, receipt) {
  const run = await client.get(`/actions/runs/${intent.runId}`);
  assert.deepEqual([String(run.id), run.head_sha, run.head_branch, run.event, run.path, run.repository?.full_name],
    [intent.runId, intent.sha, intent.tag, "workflow_dispatch", ".github/workflows/release.yml", repository]);
  assert.ok(Number(receipt.runAttempt) <= run.run_attempt);
  const inventory = await client.get(`/actions/runs/${intent.runId}/jobs?filter=latest&per_page=100`);
  assert.equal(inventory.total_count, inventory.jobs.length, "Incomplete publication gate inventory");
  const requiredJobs = receipt.sourceCi === "passed" ? [...gateNames, ...releaseCiJobNames] : gateNames;
  for (const name of requiredJobs) {
    const jobs = inventory.jobs.filter(job => job.name === name);
    assert.equal(jobs.length, 1, `Missing or duplicate release gate: ${name}`);
    assert.deepEqual([jobs[0].status, jobs[0].conclusion], ["completed", "success"], `Release gate failed: ${name}`);
  }
  await client.assertTag(intent.tag, intent.sha);
  const repo = await client.get("");
  assert.deepEqual([repo.full_name, repo.visibility, repo.default_branch], [repository, "public", "main"]);
  const ancestry = await client.get(`/compare/${intent.sha}...main`);
  assert.ok(["ahead", "identical"].includes(ancestry.status), "Release source is not on reviewed main");
  if (receipt.sourceCi !== "passed") {
    assert.ok(inventory.jobs.filter(job => releaseCiJobNames.includes(job.name) || job.name === "source-ci")
      .every(job => job.status === "completed" && job.conclusion === "skipped"), "Unexpected release CI result");
    const proof = await selectMainSourceCi(client, repository, intent.sha);
    assert.deepEqual(proof, receipt.sourceCi, "Exact main CI proof changed");
  }
  const prs = await client.get(`/commits/${intent.sha}/pulls?per_page=100`);
  assert.ok(prs.some(pr => pr.merged_at && pr.merge_commit_sha === intent.sha
    && pr.base.ref === "main" && pr.base.repo.full_name === repository), "Release source needs a merged public-source PR");
  const commit = await client.get(`/git/commits/${intent.sha}`);
  for (const person of [commit.author, commit.committer])
    assert.match(person.email, /^(?:[^\s@]+@users\.noreply\.github\.com|noreply@github\.com)$/u, "Public commit metadata must use a noreply email");
}

function assertPublicIdentity(release, intent, receipt, body) {
  assert.deepEqual([release.id, release.tag_name, release.target_commitish, release.draft, release.prerelease, release.name],
    [receipt.releaseId, intent.tag, intent.sha, false, false, `Shoggoth ${intent.version}`]);
  assert.equal(release.body, body, "Published notes differ from the reviewed intent");
  assert.ok(release.published_at);
  assert.deepEqual(identities(release.assets), identities(receipt.remoteAssets), "Published assets changed");
}

function newerVersion(candidate, current) {
  assert.match(current, /^v\d+\.\d+\.\d+$/u, "Cannot determine the current stable version");
  const a = candidate.slice(1).split(".").map(Number), b = current.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function publishAccepted(client, intent, receipt, runtime = {}) {
  assertAccepted(intent, receipt);
  await assertLiveGates(client, intent, receipt);
  let release = await client.get(`/releases/${receipt.releaseId}`);
  const body = `${intent.notes}\n\n<!-- shoggoth-draft-pipeline:${intent.sha} -->\n`;
  const latest = await client.get("/releases/latest");
  if (release.draft) {
    assertDraft(release, intent.tag, intent.sha);
    assert.deepEqual(identities(release.assets), identities(receipt.remoteAssets), "Draft assets changed after acceptance");
    assert.ok(newerVersion(intent.tag, latest.tag_name), "Refusing to replace a newer or equal Latest release");
    runtime.record?.({ phase: "publish-requested", releaseId: release.id, notesSha256: intent.notesSha256 });
    try {
      release = await (await client.request(`/releases/${release.id}`, { method: "PATCH", body: JSON.stringify({
        name: `Shoggoth ${intent.version}`, body, draft: false, prerelease: false, make_latest: "true",
      }) })).json();
    } catch {
      // The server may have committed a PATCH even when its response was lost.
      release = await client.get(`/releases/${receipt.releaseId}`);
      assert.equal(release.draft, false, "Publication response uncertain; no duplicate PATCH was sent");
    }
  }
  assertPublicIdentity(release, intent, receipt, body);
  const current = await client.get("/releases/latest");
  assert.equal(current.id, release.id, "Published release is not Latest");
  await client.assertTag(intent.tag, intent.sha);
  const result = { phase: "published", releaseId: release.id, tag: intent.tag, sha: intent.sha,
    runId: intent.runId, publishedAt: release.published_at, url: release.html_url, latest: true,
    assets: identities(release.assets), notesSha256: intent.notesSha256 };
  runtime.record?.(result);
  return result;
}

async function verifyPublicRelease(publication, runtime = {}) {
  const read = runtime.request || releaseRequest;
  // Only the public site and its asset URLs are probed anonymously.
  const request = (url, method = "GET") => read(url, { method,
    headers: { "Cache-Control": "no-cache", "User-Agent": "Shoggoth-release-verification" } });
  const pageUrl = `${webBase}/releases/tag/${publication.tag}`;
  assert.equal(publication.url, pageUrl);
  for (const url of [pageUrl, `${webBase}/releases/latest`]) {
    const page = await request(url);
    await page.body?.cancel();
    assert.equal(page.url, pageUrl, "Public release page or Latest redirect differs");
  }
  const downloads = [], small = {};
  for (const asset of publication.assets) {
    const url = `${webBase}/releases/download/${publication.tag}/${encodeURIComponent(asset.name)}`;
    const head = await request(url, "HEAD");
    assert.equal(Number(head.headers.get("content-length")), asset.size, `Public size mismatch: ${asset.name}`);
    downloads.push({ id: asset.id, name: asset.name, status: head.status, size: asset.size });
    if (!["latest-mac.yml", "SHA256SUMS.txt"].includes(asset.name)) continue;
    assert.ok(asset.size < 64 * 1024);
    const response = await request(url), parts = [];
    let size = 0;
    for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= asset.size); parts.push(chunk); }
    const bytes = Buffer.concat(parts);
    assert.equal(bytes.length, asset.size);
    assert.equal(`sha256:${digest(bytes)}`, asset.digest);
    small[asset.name] = bytes.toString("utf8");
  }
  const latest = await request(`${webBase}/releases/latest`);
  await latest.body?.cancel();
  assert.equal(latest.url, pageUrl, "Latest changed during public verification");
  const version = publication.tag.slice(1), metadata = yaml.load(small["latest-mac.yml"]);
  assert.equal(metadata.version, version);
  const zips = [packageNames(version, "arm64")[0], packageNames(version, "x64")[0]];
  assert.deepEqual(metadata.files.map(file => file.url).sort(), [...zips].sort());
  for (const file of metadata.files) {
    assert.equal(file.size, publication.assets.find(asset => asset.name === file.url).size);
    assert.equal(Buffer.from(file.sha512, "base64").length, 64);
  }
  assert.equal(metadata.path, zips[1]);
  assert.equal(metadata.sha512, metadata.files.find(file => file.url === zips[1]).sha512);
  const sums = small["SHA256SUMS.txt"].trim().split(/\r?\n/u).map(line => {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line); assert.ok(match); return { name: match[2], digest: `sha256:${match[1]}` };
  });
  assert.deepEqual(sums.map(item => item.name).sort(), publication.assets.filter(asset => asset.name !== "SHA256SUMS.txt").map(asset => asset.name).sort());
  for (const sum of sums) assert.equal(sum.digest, publication.assets.find(asset => asset.name === sum.name).digest);
  return { phase: "publicly-verified", checkedAt: new Date().toISOString(), releaseId: publication.releaseId,
    tag: publication.tag, authenticated: false, downloads, updaterArchitectures: ["arm64", "x64"], checksumEntries: sums.length };
}

async function verifyPublishedReceipt(client, publication, settings, runtime = {}) {
  assert.deepEqual([publication.phase, publication.tag, publication.sha, String(publication.runId), publication.latest],
    ["published", settings.tag, settings.sha, String(settings.runId), true]);
  assert.ok(Number.isSafeInteger(publication.releaseId) && publication.releaseId > 0);
  const names = [...packageNames(settings.version, "arm64"), ...packageNames(settings.version, "x64"),
    "latest-mac.yml", "SHA256SUMS.txt"];
  assertAssetInventory(publication.assets, names, true);
  await client.assertTag(settings.tag, settings.sha);
  const release = await client.get(`/releases/${publication.releaseId}`);
  assert.deepEqual([release.id, release.tag_name, release.target_commitish, release.draft, release.prerelease,
    release.published_at, release.html_url], [publication.releaseId, settings.tag, settings.sha, false, false,
    publication.publishedAt, publication.url]);
  assert.deepEqual(identities(release.assets), publication.assets, "Published assets changed after publication");
  return verifyPublicRelease(publication, runtime);
}

async function main() {
  const command = process.argv[2], version = require("../package.json").version;
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.GITHUB_REF, `refs/tags/v${version}`);
  assert.equal(process.env.GITHUB_SHA, sha);
  assert.equal(process.env.RELEASE_SOURCE_SHA, sha);
  const settings = { version, tag: process.env.RELEASE_TAG, sha, runId: process.env.GITHUB_RUN_ID,
    mode: process.env.RELEASE_MODE || "draft", notesFile: process.env.RELEASE_NOTES_FILE || "" };
  assert.equal(settings.tag, `v${version}`);
  if (command === "intent") {
    if (settings.notesFile) {
      assert.equal(settings.notesFile, `release-notes/v${version}.md`);
      const file = fs.lstatSync(settings.notesFile);
      assert.ok(file.isFile() && !file.isSymbolicLink());
      settings.notes = fs.readFileSync(settings.notesFile, "utf8");
      assert.equal(settings.notes, execFileSync("git", ["show", `HEAD:${settings.notesFile}`], { encoding: "utf8" }), "Notes differ from the reviewed tag");
    }
    const intent = createIntent(settings);
    fs.writeFileSync("release-intent.json", JSON.stringify(intent, null, 2) + "\n");
    return;
  }
  const client = releaseApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  if (command === "verify-public") {
    assert.equal(settings.mode, "publish");
    const publication = JSON.parse(fs.readFileSync("publication/receipt.json", "utf8"));
    try {
      const verification = await verifyPublishedReceipt(client, publication, settings);
      fs.writeFileSync("publication/public-verification.json", JSON.stringify(verification, null, 2) + "\n");
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `[\`${settings.tag}\`](${publication.url}) is public and Latest. All eight downloads verified.\n`);
    } catch (error) {
      fs.writeFileSync("publication/public-verification-status.json", JSON.stringify({
        phase: "published-verification-pending", releaseId: publication.releaseId, tag: publication.tag,
        checkedAt: new Date().toISOString(), error: error.message, retryAfterMs: error.retryAfterMs,
      }, null, 2) + "\n");
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `Release \`${settings.tag}\` was published. Public download verification is pending. Retry the **verify-public** job for Release ID ${publication.releaseId}.\n`);
      // Recovery waits at least one minute before starting this read-only job again.
      if (error.retryable || isTransientReadError(error) || (error.rateLimited && error.retryAfterMs <= 60_000)) {
        console.log(`::error::${transientPublicReadMessage}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }
  assert.equal(command, "publish");
  const intent = JSON.parse(fs.readFileSync("release-intent.json", "utf8"));
  assert.deepEqual([intent.sha, intent.tag, intent.runId, intent.mode, intent.notesFile],
    [sha, settings.tag, String(settings.runId), settings.mode, settings.notesFile]);
  const accepted = JSON.parse(fs.readFileSync("accepted-draft.json", "utf8"));
  assertAudits("publication");
  const records = [];
  const record = data => {
    records.push({ at: new Date().toISOString(), ...data });
    fs.writeFileSync("publication/status.json", JSON.stringify(records, null, 2) + "\n");
  };
  const publication = await publishAccepted(client, intent, accepted, { record });
  fs.writeFileSync("publication/receipt.json", JSON.stringify(publication, null, 2) + "\n");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Published [${intent.tag}](${publication.url}) as Latest. Public download verification runs separately.\n`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createIntent, assertAccepted, assertAudits, assertLiveGates, publishAccepted, verifyPublicRelease,
  verifyPublishedReceipt, gateNames, releaseCiJobNames };
